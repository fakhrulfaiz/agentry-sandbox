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
import type { Limits, SandboxConfig } from './config.ts'
import { envdToken } from './envd/token.ts'
import { bootstrap } from './places/bootstrap.ts'
import { assignGpus } from './places/gpus.ts'
import type { Driver, Handle } from './places/driver.ts'
import type { Place, PlaceRegistry } from './places/registry.ts'
import type { GpuInfo, SandboxRecord, Store, TemplateSpec } from './store/types.ts'

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`)
    this.name = 'NotFoundError'
  }
}

/** A place could not be reached (HTTP 503 `place_unavailable`). */
export class PlaceUnavailableError extends Error {
  constructor(
    readonly placeName: string,
    readonly reason: string,
  ) {
    super(`Place '${placeName}' is unavailable: ${reason}`)
    this.name = 'PlaceUnavailableError'
  }
}

/** The earlier name, kept for the API client. */
export { PlaceUnavailableError as BackendUnavailableError }

/** A place is switched off; it keeps what it runs but takes no new work (HTTP 409 `place_disabled`). */
export class PlaceDisabledError extends Error {
  constructor(readonly placeName: string) {
    super(`Place '${placeName}' is disabled.`)
    this.name = 'PlaceDisabledError'
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

/** Not enough free GPUs on a place (HTTP 409 `gpu_unavailable`). */
export class GpuUnavailableError extends Error {
  constructor(placeName: string, free: number, total: number) {
    super(`place '${placeName}' has ${String(free)} of ${String(total)} GPUs free`)
    this.name = 'GpuUnavailableError'
  }
}

export interface CreateSandbox {
  name: string
  templateId?: string
  template?: TemplateSpec
  /** Id of the place to run on; else the template's, else the default place. */
  place?: string
  gpus?: number | 'all'
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
  endpoint(owner: string, id: string): Promise<{ baseUrl: string; token: string; release?: () => void }>
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

/** Errors that mean a place (Docker, ...) could not be reached, as opposed to a sandbox failing. */
const CONNECTION = /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up|timeout|connect EACCES/i
function unavailable(place: string, e: unknown): PlaceUnavailableError | undefined {
  if (e instanceof PlaceUnavailableError) return e
  const code = (e as { code?: unknown }).code
  const text = `${typeof code === 'string' ? code : ''} ${message(e)}`
  return CONNECTION.test(text) ? new PlaceUnavailableError(place, `not reachable: ${message(e)}`) : undefined
}

type Provision = (driver: Driver, id: string, handle: Handle, spec: TemplateSpec) => Promise<Handle>

export function createSandboxService(deps: {
  store: Store
  places: PlaceRegistry
  config: SandboxConfig
  now?: () => number
  /** Where the DSH runtime tar comes from (Docker: the runtime image); none when absent. */
  dshRuntime?: (() => Promise<Buffer>) | null
  /** Replaces the shared bootstrap (tests with no real envd behind the driver). */
  provision?: Provision
}): SandboxService {
  const { store, places, config } = deps
  const provision: Provision =
    deps.provision ?? ((driver, id, handle, spec) => bootstrap(driver, id, handle, spec, { secret: config.secret, dshRuntime: deps.dshRuntime ?? null, startTimeoutMs: config.startTimeoutMs, dshRef: config.dshRuntimeImage || 'dsh' }))
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

  /** The place a sandbox runs on; one that is no longer configured counts as unavailable. */
  function placeOf(r: SandboxRecord): Place {
    const p = places.get(r.backend)
    if (!p) throw new PlaceUnavailableError(r.backend, 'the place is no longer configured')
    return p
  }

  /** Calls a place's driver, turning connection failures into PlaceUnavailableError. */
  async function call<T>(place: Place, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      throw unavailable(place.name, e) ?? e
    }
  }

  /** For calls that put work on the place (create, start, reset): it must be enabled and answer. */
  async function mustAvailable(place: Place): Promise<void> {
    if (!place.enabled) throw new PlaceDisabledError(place.name)
    const a = await place.driver.probe().catch((e: unknown) => ({ ok: false as const, reason: message(e) }))
    if (!a.ok) throw new PlaceUnavailableError(place.name, a.reason)
  }

  /** The GPUs a place has now: what its driver reports, else what was stored when it was added. */
  async function gpusOf(place: Place): Promise<GpuInfo[]> {
    const p = await place.driver.probe().catch(() => undefined)
    return p?.ok && p.gpus && p.gpus.length > 0 ? p.gpus : place.gpus
  }

  const heldBy = (r: SandboxRecord): string[] => (r.handle.gpuIds ? r.handle.gpuIds.split(',').filter(Boolean) : [])
  /** A handle with the GPU assignment released. */
  const withoutGpus = (h: Handle): Handle => {
    const { gpuIds: _g, ...rest } = h
    return rest
  }
  /** No machine exists yet (the assignment alone does not make one). */
  const noMachine = (h: Handle) => Object.keys(withoutGpus(h)).length === 0

  /**
   * Gives the sandbox its GPUs, exclusively: under the place's GPU lock, the free ones are the place's
   * minus those held by other sandboxes' handles; the assignment is saved on this sandbox's handle
   * before the lock is released, so concurrent starts never see the same GPU as free.
   */
  function reserveGpus(place: Place, r: SandboxRecord): Promise<{ record: SandboxRecord; gpuIds: string[] }> {
    const want = r.template.gpus ?? 0
    if (want === 0) return Promise.resolve({ record: r, gpuIds: [] })
    return locked(`gpus:${place.id}`, async () => {
      const gpus = await gpusOf(place)
      const held = new Set((await store.sandboxes.listAll()).filter((o) => o.id !== r.id && o.backend === place.id).flatMap(heldBy))
      const free = gpus.filter((g) => !held.has(g.uuid))
      const chosen = assignGpus(free, want, gpus.length)
      if (!chosen) throw new GpuUnavailableError(place.name, free.length, gpus.length)
      const gpuIds = chosen.map((g) => g.uuid)
      return { record: await save(r, { handle: { ...r.handle, gpuIds: gpuIds.join(',') } }), gpuIds }
    })
  }

  /** Runs the driver's create then the shared bootstrap; a failed bootstrap leaves nothing behind. */
  async function makeMachine(place: Place, r: SandboxRecord, gpuIds: string[]): Promise<Handle> {
    const handle = await call(place, () => place.driver.create(r.id, r.owner, r.template, { gpuIds }))
    try {
      const done = await call(place, () => provision(place.driver, r.id, handle, r.template))
      return gpuIds.length > 0 ? { ...done, gpuIds: gpuIds.join(',') } : done
    } catch (e) {
      await place.driver.destroy(r.id, handle, { keepWorkspace: false }).catch(() => {})
      throw e
    }
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
  async function checkRunning(owner: string, place: Place, except?: string): Promise<void> {
    const all = await store.sandboxes.listAll()
    const running = all.filter((r) => isRunning(r) && r.id !== except)
    const onPlace = running.filter((r) => r.backend === place.id).length
    if (place.maxRunning !== null && onPlace >= place.maxRunning) throw new QuotaExceededError(`Place '${place.name}' is running its maximum of ${String(place.maxRunning)} sandboxes. Try again later.`)
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

  async function checkCreate(owner: string, place: Place): Promise<void> {
    const all = await store.sandboxes.listAll()
    const mine = all.filter((r) => r.owner === owner).length
    const maxMine = ownerLimit(owner, 'maxPerOwner')
    if (mine >= maxMine) throw new QuotaExceededError(`You already have ${String(mine)} sandboxes (limit ${String(maxMine)}). Delete one first.`)
    if (all.length >= limits.maxTotal) throw new QuotaExceededError(`The sandbox service is at its maximum of ${String(limits.maxTotal)} sandboxes.`)
    await checkRunning(owner, place)
    checkRate(owner)
  }

  // ---- lifecycle (callers hold the sandbox lock) ----

  async function build(r: SandboxRecord): Promise<SandboxRecord> {
    try {
      const place = placeOf(r)
      const reserved = await reserveGpus(place, r)
      const handle = await makeMachine(place, reserved.record, reserved.gpuIds)
      const t = now()
      return await save(r, { state: 'running', handle, error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      // A failed start releases its GPUs.
      await store.sandboxes.update(r.id, r.owner, { state: 'failed', error: message(e), handle: {} })
      throw e
    }
  }

  async function doStart(owner: string, id: string): Promise<SandboxRecord> {
    const r = await load(owner, id)
    if (r.state === 'deleting') throw new NotFoundError('sandbox')
    const place = placeOf(r)
    if (r.state === 'running' && (await call(place, () => place.driver.status(r.handle))) === 'running') return r
    await mustAvailable(place)
    await checkRunning(owner, place, id)
    if (noMachine(r.handle)) return build(await save(r, { state: 'provisioning', error: null }))
    let reserved: { record: SandboxRecord; gpuIds: string[] } | undefined
    try {
      reserved = await reserveGpus(place, r)
      const started = await call(place, () => place.driver.start(r.id, r.handle, r.template, { gpuIds: reserved!.gpuIds }))
      let handle: Handle
      try {
        handle = await call(place, () => provision(place.driver, r.id, started, r.template))
      } catch (e) {
        await place.driver.stop(started).catch(() => {})
        throw e
      }
      if (reserved.gpuIds.length > 0) handle = { ...handle, gpuIds: reserved.gpuIds.join(',') }
      const t = now()
      return await save(r, { state: 'running', handle, error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      if (e instanceof GpuUnavailableError) throw e
      // A failed start releases its GPUs.
      if (!(e instanceof PlaceUnavailableError)) await save(r, { state: 'failed', error: message(e), handle: withoutGpus(r.handle) })
      else if (reserved) await save(r, { handle: withoutGpus(r.handle) }).catch(() => {})
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
            const place = placeOf(r)
            await call(place, () => place.driver.stop(r.handle))
            await save(r, { state: 'stopped', handle: withoutGpus(r.handle) })
            stopped.push(r.id)
          } catch {
            // Leave it running; the next sweep tries again.
          }
          return
        }
        // Still running: keep its network rules in place (a host firewall reload drops them).
        const place = places.get(r.backend)
        if (place?.driver.maintain) await place.driver.maintain(r.id, r.handle, r.template).catch(() => {})
      })
    }
    return stopped
  }

  return {
    async create(owner, input) {
      let template: TemplateSpec = input.template ?? {}
      let templateId: string | null = null
      if (input.templateId) {
        const t = await store.templates.get(input.templateId, owner)
        if (!t) throw new NotFoundError('template')
        template = { ...t.spec, ...input.template }
        templateId = t.id
      }
      const placeId = input.place ?? template.place ?? places.default().id
      const place = places.get(placeId)
      if (!place) throw new LimitError(`no place '${placeId}'`)
      const gpus = input.gpus ?? template.gpus
      template = { ...template, place: placeId, ...(gpus !== undefined ? { gpus } : {}) }
      const allowed = place.driver.capabilities.templateFields
      for (const field of Object.keys(template) as (keyof TemplateSpec)[]) {
        if (template[field] === undefined || field === 'place' || field === 'workspacePath') continue
        if (field === 'gpus') continue
        if (!allowed.includes(field)) throw new LimitError(`place '${place.name}' does not support '${field}'`)
      }
      checkResources(template)
      await mustAvailable(place)
      if (gpus !== undefined && gpus !== 0 && (await gpusOf(place)).length === 0) throw new LimitError(`place '${place.name}' has no GPUs`)
      await checkCreate(owner, place)
      const record: SandboxRecord = {
        id: `sbx_${randomBytes(16).toString('hex')}`,
        owner,
        name: input.name,
        backend: place.id,
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
          await place.driver.destroy(record.id, {}, { keepWorkspace: false }).catch(() => {})
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
        if (!noMachine(r.handle)) {
          const place = placeOf(r)
          await call(place, () => place.driver.stop(r.handle))
        }
        return save(r, { state: 'stopped', handle: withoutGpus(r.handle) })
      })
    },

    reset(owner, id, { keepWorkspace }) {
      return locked(id, async () => {
        const r = await load(owner, id)
        checkResources(r.template)
        const place = placeOf(r)
        await mustAvailable(place)
        await checkRunning(owner, place, id)
        checkRate(owner)
        await call(place, () => place.driver.destroy(r.id, r.handle, { keepWorkspace }))
        return build(await save(r, { state: 'provisioning', handle: {}, error: null }))
      })
    },

    async destroy(owner, id) {
      await locked(id, async () => {
        const r = await load(owner, id)
        const place = placeOf(r)
        await call(place, () => place.driver.destroy(r.id, r.handle, { keepWorkspace: false }))
        await store.sandboxes.delete(id, owner)
        return place
      }).then(async (place) => {
        if ((await store.sandboxes.list(owner)).length === 0 && place.driver.releaseOwner) await place.driver.releaseOwner(owner).catch(() => {})
      })
    },

    async touch(owner, id) {
      const r = await load(owner, id)
      await save(r, { lastUsedAt: now() })
    },

    async endpoint(owner, id) {
      const r = await locked(id, () => doStart(owner, id))
      const place = placeOf(r)
      const { baseUrl, token, release } = await call(place, () => place.driver.envdEndpoint(r.handle))
      return { baseUrl, token: token ?? envdToken(config.secret, r.id), ...(release ? { release } : {}) }
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
      const records = await store.sandboxes.listAll()
      const adopted: string[] = []
      const missing: string[] = []
      const unknown: string[] = []
      for (const place of places.list()) {
        // A place that does not answer is left alone: its sandboxes keep their recorded state.
        const probe = await place.driver.probe().catch(() => ({ ok: false as const }))
        if (!probe.ok) continue
        let managed: Awaited<ReturnType<Driver['listManaged']>>
        try {
          managed = await place.driver.listManaged()
        } catch {
          continue
        }
        const byId = new Map(managed.map((m) => [m.id, m]))
        const mine = records.filter((r) => r.backend === place.id)
        for (const r of mine) {
          const m = byId.get(r.id)
          if (!m) {
            if (r.state === 'provisioning' || r.state === 'running' || r.state === 'stopped') {
              await save(r, { state: 'failed', error: 'sandbox container is missing', handle: withoutGpus(r.handle) })
              missing.push(r.id)
            }
            continue
          }
          const status = await call(place, () => place.driver.status(m.handle))
          const merged = { ...r.handle, ...m.handle, provisioned: r.handle.provisioned ?? m.handle.provisioned ?? 'true' }
          // A machine that is not running holds no GPUs.
          const handle = status === 'running' ? merged : withoutGpus(merged)
          await save(r, { handle, state: status === 'running' ? 'running' : r.state === 'deleting' ? 'deleting' : 'stopped' })
          adopted.push(r.id)
        }
        const known = new Set(records.map((r) => r.id))
        unknown.push(...managed.filter((m) => !known.has(m.id)).map((m) => m.id))
      }
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
