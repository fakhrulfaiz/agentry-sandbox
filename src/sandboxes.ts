/**
 * Sandbox lifecycle over a Store and a Backend: create from a template
 * snapshot, start, stop, reset, destroy, the envd endpoint and token, the idle
 * sweep, and startup reconciliation of records against the backend's own
 * labelled sandboxes.
 *
 * Every lifecycle change of one sandbox runs under that sandbox's lock and
 * re-reads its record first, so concurrent calls (a start racing a reset, a
 * delete during provisioning, the idle sweep) never act on stale state.
 * Quotas from `config.limits` cap how many sandboxes an owner (and the whole
 * service) may have and run, how fast they may be created, and how large a
 * template may make one.
 */
import { randomBytes } from 'node:crypto'
import type { Backend } from './backends/types.ts'
import type { Limits, SandboxConfig } from './config.ts'
import { envdToken } from './envd/token.ts'
import type { SandboxRecord, Store, TemplateSpec } from './store/types.ts'

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`)
    this.name = 'NotFoundError'
  }
}

export class BackendUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BackendUnavailableError'
  }
}

/** A quota is used up (HTTP 429). */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/** A request asks for more than one sandbox may have (HTTP 400). */
export class LimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LimitError'
  }
}

export interface CreateSandbox {
  name: string
  templateId?: string
  template?: TemplateSpec
}

export interface SandboxService {
  create(owner: string, input: CreateSandbox): Promise<SandboxRecord>
  list(owner: string): Promise<SandboxRecord[]>
  get(owner: string, id: string): Promise<SandboxRecord>
  start(owner: string, id: string): Promise<SandboxRecord>
  stop(owner: string, id: string): Promise<SandboxRecord>
  reset(owner: string, id: string, opts: { keepWorkspace: boolean }): Promise<SandboxRecord>
  destroy(owner: string, id: string): Promise<void>
  touch(owner: string, id: string): Promise<void>
  /** Where to reach the sandbox's envd, and its access token; starts a stopped sandbox. */
  endpoint(owner: string, id: string): Promise<{ baseUrl: string; token: string }>
  /** Marks a connection to the sandbox as open; the idle sweep skips it until the returned function is called. */
  beginUse(id: string): () => void
  sweepIdle(): Promise<string[]>
  reconcile(): Promise<{ adopted: string[]; missing: string[]; unknown: string[] }>
  /** The limits in force: the environment's defaults with any saved overrides applied. */
  limits(): Limits
  /** The saved overrides (what the admin changed), or an empty object. */
  limitOverrides(): Partial<Limits>
  /** Saves overrides (validated, merged over the environment's defaults) and applies them at once; `null` clears them. */
  setLimits(overrides: Partial<Limits> | null): Promise<Limits>
  /** Reads saved overrides from the store; call once at startup. */
  loadSettings(): Promise<void>
  /** Every owner's sandboxes, newest first (admin). */
  listEverything(): Promise<SandboxRecord[]>
  /** The owner of a sandbox (admin), or undefined when there is none. */
  ownerOf(id: string): Promise<string | undefined>
  /** Test hook: replaces the limits in place. */
  setLimitsForTest?(limits: Partial<Limits>): void
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Errors that mean the backend (Docker) could not be reached, as opposed to a sandbox failing. */
const CONNECTION = /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up|timeout|connect EACCES/i
function unavailable(e: unknown): BackendUnavailableError | undefined {
  if (e instanceof BackendUnavailableError) return e
  const code = (e as { code?: unknown }).code
  const text = `${typeof code === 'string' ? code : ''} ${message(e)}`
  return CONNECTION.test(text) ? new BackendUnavailableError(`The sandbox backend is not reachable: ${message(e)}`) : undefined
}

export function createSandboxService(deps: { store: Store; backend: Backend; config: SandboxConfig; now?: () => number }): SandboxService {
  const { store, backend, config } = deps
  const now = deps.now ?? Date.now
  let limits: Limits = { ...config.limits }
  let overrides: Partial<Limits> = {}
  const LIMITS_KEY = 'limits'
  const locks = new Map<string, Promise<unknown>>()
  const inUse = new Map<string, number>()
  const creations = new Map<string, number[]>()

  /** Runs `fn` after every earlier operation on the same sandbox has settled. */
  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    locks.set(id, tail)
    void tail.then(() => {
      if (locks.get(id) === tail) locks.delete(id)
    })
    return run
  }

  /** Calls the backend, turning connection failures into BackendUnavailableError. */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      throw unavailable(e) ?? e
    }
  }

  async function mustAvailable(): Promise<void> {
    const a = await backend.available()
    if (!a.ok) throw new BackendUnavailableError(a.reason)
  }

  async function load(owner: string, id: string): Promise<SandboxRecord> {
    const r = await store.sandboxes.get(id, owner)
    if (!r) throw new NotFoundError('sandbox')
    return r
  }

  async function save(r: SandboxRecord, patch: Parameters<Store['sandboxes']['update']>[2]): Promise<SandboxRecord> {
    const u = await store.sandboxes.update(r.id, r.owner, patch)
    if (!u) throw new NotFoundError('sandbox')
    return u
  }

  // ---- limits ----

  const ownerLimit = (owner: string, key: 'maxPerOwner' | 'maxRunningPerOwner' | 'maxCreatesPerHour') => limits.owners[owner]?.[key] ?? limits[key]
  const isRunning = (r: SandboxRecord) => r.state === 'running' || r.state === 'provisioning'

  function checkResources(t: TemplateSpec): void {
    if (t.resources?.cpus !== undefined && t.resources.cpus > limits.maxCpus) throw new LimitError(`A sandbox may use at most ${String(limits.maxCpus)} CPUs.`)
    if (t.resources?.memoryMb !== undefined && t.resources.memoryMb > limits.maxMemoryMb) throw new LimitError(`A sandbox may use at most ${String(limits.maxMemoryMb)} MB of memory.`)
  }

  /** One more running sandbox for `owner`, besides `except`. */
  async function checkRunning(owner: string, except?: string): Promise<void> {
    const all = await store.sandboxes.listAll()
    const running = all.filter((r) => isRunning(r) && r.id !== except)
    const mine = running.filter((r) => r.owner === owner).length
    const maxMine = ownerLimit(owner, 'maxRunningPerOwner')
    if (mine >= maxMine) throw new QuotaExceededError(`You already have ${String(mine)} running sandboxes (limit ${String(maxMine)}). Stop one first.`)
    if (running.length >= limits.maxRunningTotal) throw new QuotaExceededError(`The sandbox service is running its maximum of ${String(limits.maxRunningTotal)} sandboxes. Try again later.`)
  }

  function checkRate(owner: string): void {
    const t = now()
    const recent = (creations.get(owner) ?? []).filter((x) => x > t - 3_600_000)
    const max = ownerLimit(owner, 'maxCreatesPerHour')
    if (recent.length >= max) throw new QuotaExceededError(`You may create or reset at most ${String(max)} sandboxes per hour. Try again later.`)
    recent.push(t)
    creations.set(owner, recent)
  }

  async function checkCreate(owner: string): Promise<void> {
    const all = await store.sandboxes.listAll()
    const mine = all.filter((r) => r.owner === owner).length
    const maxMine = ownerLimit(owner, 'maxPerOwner')
    if (mine >= maxMine) throw new QuotaExceededError(`You already have ${String(mine)} sandboxes (limit ${String(maxMine)}). Delete one first.`)
    if (all.length >= limits.maxTotal) throw new QuotaExceededError(`The sandbox service is at its maximum of ${String(limits.maxTotal)} sandboxes.`)
    await checkRunning(owner)
    checkRate(owner)
  }

  // ---- lifecycle (callers hold the sandbox lock) ----

  async function build(r: SandboxRecord): Promise<SandboxRecord> {
    try {
      const handle = await call(() => backend.create(r.id, r.owner, r.template))
      const t = now()
      return await save(r, { state: 'running', handle, error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      await store.sandboxes.update(r.id, r.owner, { state: 'failed', error: message(e) })
      throw e
    }
  }

  async function doStart(owner: string, id: string): Promise<SandboxRecord> {
    const r = await load(owner, id)
    if (r.state === 'deleting') throw new NotFoundError('sandbox')
    if (r.state === 'running' && (await call(() => backend.status(r.handle))) === 'running') return r
    await mustAvailable()
    await checkRunning(owner, id)
    if (Object.keys(r.handle).length === 0) return build(await save(r, { state: 'provisioning', error: null }))
    try {
      const handle = await call(() => backend.start(r.id, r.handle, r.template))
      const t = now()
      return await save(r, { state: 'running', handle, error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      if (!(e instanceof BackendUnavailableError)) await save(r, { state: 'failed', error: message(e) })
      throw e
    }
  }

  let sweeping: Promise<string[]> | undefined
  const sweepOnce = async (): Promise<string[]> => {
    const stopped: string[] = []
    for (const snapshot of await store.sandboxes.listAll()) {
      if (snapshot.state !== 'running') continue
      await locked(snapshot.id, async () => {
        const r = await store.sandboxes.getAny(snapshot.id)
        if (!r || r.state !== 'running') return
        const last = r.lastUsedAt ?? r.startedAt ?? r.createdAt
        if (!inUse.has(r.id) && last <= now() - config.idleStopMinutes * 60_000) {
          try {
            await call(() => backend.stop(r.handle))
            await save(r, { state: 'stopped' })
            stopped.push(r.id)
          } catch {
            // Leave it running; the next sweep tries again.
          }
          return
        }
        // Still running: keep its network rules in place (a host firewall reload drops them).
        if (backend.maintain) await backend.maintain(r.id, r.handle, r.template).catch(() => {})
      })
    }
    return stopped
  }

  return {
    async create(owner, input) {
      let template = input.template ?? {}
      let templateId: string | null = null
      if (input.templateId) {
        const t = await store.templates.get(input.templateId, owner)
        if (!t) throw new NotFoundError('template')
        template = { ...t.spec, ...input.template }
        templateId = t.id
      }
      checkResources(template)
      await mustAvailable()
      await checkCreate(owner)
      const record: SandboxRecord = {
        id: `sbx_${randomBytes(16).toString('hex')}`,
        owner,
        name: input.name,
        backend: backend.kind,
        template: structuredClone(template),
        templateId,
        state: 'provisioning',
        handle: {},
        handleSecrets: null,
        error: null,
        createdAt: now(),
        startedAt: null,
        lastUsedAt: null,
      }
      await store.sandboxes.insert(record)
      // A create that fails leaves nothing behind: the caller gets the reason and never learned the id,
      // so a kept failed record would only count against the owner's limits.
      return locked(record.id, async () => {
        try {
          return await build(record)
        } catch (e) {
          // The backend cleans up a create it could not finish; this also covers one that died half-way.
          await backend.destroy(record.id, {}, { keepWorkspace: false }).catch(() => {})
          await store.sandboxes.delete(record.id, owner).catch(() => {})
          throw e
        }
      })
    },

    list: (owner) => store.sandboxes.list(owner),
    get: load,

    start(owner, id) {
      return locked(id, () => doStart(owner, id))
    },

    stop(owner, id) {
      return locked(id, async () => {
        const r = await load(owner, id)
        if (Object.keys(r.handle).length > 0) await call(() => backend.stop(r.handle))
        return save(r, { state: 'stopped' })
      })
    },

    reset(owner, id, { keepWorkspace }) {
      return locked(id, async () => {
        const r = await load(owner, id)
        checkResources(r.template)
        await mustAvailable()
        await checkRunning(owner, id)
        checkRate(owner)
        await call(() => backend.destroy(r.id, r.handle, { keepWorkspace }))
        return build(await save(r, { state: 'provisioning', handle: {}, error: null }))
      })
    },

    async destroy(owner, id) {
      await locked(id, async () => {
        const r = await load(owner, id)
        await call(() => backend.destroy(r.id, r.handle, { keepWorkspace: false }))
        await store.sandboxes.delete(id, owner)
      })
      if ((await store.sandboxes.list(owner)).length === 0 && backend.releaseOwner) await call(() => backend.releaseOwner!(owner)).catch(() => {})
    },

    async touch(owner, id) {
      const r = await load(owner, id)
      await save(r, { lastUsedAt: now() })
    },

    async endpoint(owner, id) {
      const r = await locked(id, () => doStart(owner, id))
      const { baseUrl } = await call(() => backend.endpoint(r.handle))
      return { baseUrl, token: envdToken(config.secret, r.id) }
    },

    beginUse(id) {
      inUse.set(id, (inUse.get(id) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const n = (inUse.get(id) ?? 1) - 1
        if (n <= 0) inUse.delete(id)
        else inUse.set(id, n)
        void store.sandboxes.getAny(id).then((r) => r && store.sandboxes.update(id, r.owner, { lastUsedAt: now() })).catch(() => {})
      }
    },

    sweepIdle() {
      // One sweep at a time: a slow sweep and the next timer tick never stop the same sandbox twice.
      sweeping ??= sweepOnce().finally(() => { sweeping = undefined })
      return sweeping
    },


    async reconcile() {
      const managed = await call(() => backend.listManaged())
      const byId = new Map(managed.map((m) => [m.id, m]))
      const records = await store.sandboxes.listAll()
      const known = new Set(records.map((r) => r.id))
      const adopted: string[] = []
      const missing: string[] = []
      for (const r of records) {
        const m = byId.get(r.id)
        if (!m) {
          if (r.state === 'provisioning' || r.state === 'running' || r.state === 'stopped') {
            await save(r, { state: 'failed', error: 'sandbox container is missing' })
            missing.push(r.id)
          }
          continue
        }
        const status = await call(() => backend.status(m.handle))
        const handle = { ...r.handle, ...m.handle, provisioned: r.handle.provisioned ?? m.handle.provisioned ?? 'true' }
        await save(r, { handle, state: status === 'running' ? 'running' : r.state === 'deleting' ? 'deleting' : 'stopped' })
        adopted.push(r.id)
      }
      const unknown = managed.filter((m) => !known.has(m.id)).map((m) => m.id)
      return { adopted, missing, unknown }
    },

    limits() {
      return structuredClone(limits)
    },

    limitOverrides() {
      return structuredClone(overrides)
    },

    async setLimits(next) {
      const clean = next === null ? {} : validateLimits(next)
      await store.settings.set(LIMITS_KEY, Object.keys(clean).length > 0 ? clean : undefined)
      overrides = clean
      limits = { ...config.limits, ...clean, owners: { ...config.limits.owners, ...(clean.owners ?? {}) } }
      return structuredClone(limits)
    },

    async loadSettings() {
      const saved = await store.settings.get(LIMITS_KEY)
      if (saved === undefined) return
      try {
        overrides = validateLimits(saved)
        limits = { ...config.limits, ...overrides, owners: { ...config.limits.owners, ...(overrides.owners ?? {}) } }
      } catch {
        // A saved value that no longer validates is ignored; the environment's limits stay in force.
      }
    },

    async listEverything() {
      return (await store.sandboxes.listAll()).sort((a, b) => b.createdAt - a.createdAt)
    },

    async ownerOf(id) {
      return (await store.sandboxes.getAny(id))?.owner
    },

    setLimitsForTest(next) {
      limits = { ...limits, ...next }
    },
  }
}

const COUNT_KEYS = ['maxPerOwner', 'maxRunningPerOwner', 'maxTotal', 'maxRunningTotal', 'maxCreatesPerHour'] as const
const OWNER_KEYS = ['maxPerOwner', 'maxRunningPerOwner', 'maxCreatesPerHour'] as const

/** Checks limit overrides from the admin page; throws LimitError naming the bad field. Unknown keys are refused. */
export function validateLimits(raw: unknown): Partial<Limits> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LimitError('limits must be an object')
  const r = raw as Record<string, unknown>
  const out: Partial<Limits> = {}
  const count = (key: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000) throw new LimitError(`${key} must be a whole number from 0 to 100000`)
    return v
  }
  for (const key of Object.keys(r)) {
    const v = r[key]
    if ((COUNT_KEYS as readonly string[]).includes(key)) out[key as (typeof COUNT_KEYS)[number]] = count(key, v)
    else if (key === 'maxCpus') {
      if (typeof v !== 'number' || !(v >= 0.1 && v <= 256)) throw new LimitError('maxCpus must be a number from 0.1 to 256')
      out.maxCpus = v
    } else if (key === 'maxMemoryMb') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 128 || v > 1_048_576) throw new LimitError('maxMemoryMb must be a whole number from 128 to 1048576')
      out.maxMemoryMb = v
    } else if (key === 'owners') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LimitError('owners must be an object of owner to limits')
      const owners: Limits['owners'] = {}
      for (const [owner, o] of Object.entries(v as Record<string, unknown>)) {
        if (!owner.trim() || owner.length > 200) throw new LimitError('owner names must be 1-200 characters')
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new LimitError(`owners.${owner} must be an object`)
        const entry: Limits['owners'][string] = {}
        for (const [k, n] of Object.entries(o as Record<string, unknown>)) {
          if (!(OWNER_KEYS as readonly string[]).includes(k)) throw new LimitError(`owners.${owner}.${k} is not a per-owner limit`)
          entry[k as (typeof OWNER_KEYS)[number]] = count(`owners.${owner}.${k}`, n)
        }
        owners[owner] = entry
      }
      out.owners = owners
    } else throw new LimitError(`${key} is not a limit`)
  }
  return out
}
