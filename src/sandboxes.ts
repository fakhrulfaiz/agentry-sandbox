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
        error: null,
        createdAt: now(),
        startedAt: null,
        lastUsedAt: null,
      }
      await store.sandboxes.insert(record)
      return locked(record.id, () => build(record))
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

    async sweepIdle() {
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

    setLimitsForTest(next) {
      limits = { ...limits, ...next }
    },
  }
}
