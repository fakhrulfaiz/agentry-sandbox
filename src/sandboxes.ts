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
import { openSecrets, sealSecrets } from './crypto/secrets.ts'
import { createEnvdClient, type EnvdClient, type EnvdClientOptions } from './envd/client.ts'
import { envdToken } from './envd/token.ts'
import { ensureSnapshotDir, removeSnapshotFile, removeStaleParts, snapshotFile } from './snapshots/files.ts'
import { restoreWorkspace, saveWorkspace } from './snapshots/workspace-tar.ts'
import { bootstrap } from './places/bootstrap.ts'
import { assignGpus } from './places/gpus.ts'
import { HostKeyChangedError, TransientPlaceError, type Driver, type Handle, type SnapshotRef } from './places/driver.ts'
import type { Place, PlaceRegistry } from './places/registry.ts'
import type { GpuInfo, ProgressUpdate, SandboxRecord, SnapshotLevel, SnapshotRecord, Store, TemplateSpec } from './store/types.ts'

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

/** Generic snapshots are off: no folder to keep them in (HTTP 400 `snapshots_off`). */
export class SnapshotsOffError extends Error {
  constructor() {
    super('Snapshots are off: set AGENTRY_SANDBOX_SNAPSHOT_DIR to a folder on the service host.')
    this.name = 'SnapshotsOffError'
  }
}

/** The snapshot is still saving or failed, so it cannot be used (HTTP 409 `snapshot_not_ready`). */
export class SnapshotNotReadyError extends Error {
  constructor(state: string) {
    super(`The snapshot is ${state}; only a ready snapshot can be restored.`)
    this.name = 'SnapshotNotReadyError'
  }
}

export interface CreateSandbox {
  name: string
  templateId?: string
  template?: TemplateSpec
  /** Id of the place to run on; else the template's, else the default place. */
  place?: string
  gpus?: number | 'all'
  /** Id of one of the owner's snapshots to start from. */
  snapshot?: string
}

export interface SnapshotInput {
  name?: string
  /** Default `workspace`. */
  level?: SnapshotLevel
  /** Stop the sandbox for the snapshot and start it again (native snapshots; a generic workspace snapshot reads a running sandbox, so it is taken live). */
  stopFirst?: boolean
}

export interface SandboxService {
  create(owner: string, input: CreateSandbox): Promise<SandboxRecord>
  list(owner: string): Promise<SandboxRecord[]>
  get(owner: string, id: string): Promise<SandboxRecord>
  start(owner: string, id: string): Promise<SandboxRecord>
  stop(owner: string, id: string): Promise<SandboxRecord>
  reset(owner: string, id: string, opts: { keepWorkspace: boolean }): Promise<SandboxRecord>
  /** `force` (admin) forgets the record even when its place cannot be reached; whatever the machine left behind is logged. */
  destroy(owner: string, id: string, opts?: { force?: boolean }): Promise<void>
  touch(owner: string, id: string): Promise<void>
  /** Where to reach the sandbox's envd, and its access token; starts a stopped sandbox. */
  endpoint(owner: string, id: string): Promise<{ baseUrl: string; token: string; headers?: Record<string, string>; release?: () => void; /** Maps the requested envd user (SSH machine: `agent` is the login user). */ envdUser?: (requested: string) => string }>
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
  /** Starts saving a snapshot of a sandbox (returns the `saving` record; the work runs in the background). */
  snapshot(owner: string, id: string, input?: SnapshotInput): Promise<SnapshotRecord>
  listSnapshots(owner: string, opts?: { sandboxId?: string }): Promise<SnapshotRecord[]>
  getSnapshot(owner: string, snapId: string): Promise<SnapshotRecord>
  /** Removes the snapshot's bytes (or cancels a save in progress) and its record. */
  deleteSnapshot(owner: string, snapId: string): Promise<void>
  /** Puts a snapshot back into a sandbox of the same owner. */
  restore(owner: string, id: string, snapId: string): Promise<SandboxRecord>
  /** The levels a snapshot of a sandbox on this place can have. */
  snapshotLevels(placeId: string): SnapshotLevel[]
  /** Deletes expired snapshots; returns their ids. */
  sweepSnapshots(): Promise<string[]>
  /** Startup: saves that were interrupted become failed, leftover partial files are removed. */
  recoverSnapshots(): Promise<void>
  /** Every owner's snapshots, newest first (admin). */
  listEverySnapshot(): Promise<SnapshotRecord[]>
  /** The owner of a snapshot (admin). */
  snapshotOwnerOf(snapId: string): Promise<string | undefined>
  /** Test hook: replaces the limits in place. */
  setLimitsForTest?(limits: Partial<Limits>): void
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Errors that mean a place (Docker, ...) could not be reached, as opposed to a sandbox failing. */
const CONNECTION = /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up|timeout|connect EACCES/i
function unavailable(place: string, e: unknown): PlaceUnavailableError | undefined {
  if (e instanceof PlaceUnavailableError) return e
  if (e instanceof TransientPlaceError) return new PlaceUnavailableError(place, message(e))
  const code = (e as { code?: unknown }).code
  const text = `${typeof code === 'string' ? code : ''} ${message(e)}`
  return CONNECTION.test(text) ? new PlaceUnavailableError(place, `not reachable: ${message(e)}`) : undefined
}

type Provision = (driver: Driver, id: string, handle: Handle, spec: TemplateSpec, progress?: (p: ProgressUpdate) => void) => Promise<Handle>

export function createSandboxService(deps: {
  store: Store
  places: PlaceRegistry
  config: SandboxConfig
  now?: () => number
  /** Where the DSH runtime tar comes from (Docker: the runtime image); none when absent. */
  dshRuntime?: (() => Promise<Buffer>) | null
  /** Replaces the shared bootstrap (tests with no real envd behind the driver). */
  provision?: Provision
  /** Replaces the envd client (tests with a stand-in that runs commands locally). */
  envdClient?: (opts: EnvdClientOptions) => EnvdClient
}): SandboxService {
  const { store, places, config } = deps
  const RUNTIME_REF = config.dshRuntimeImage || 'dsh'
  const provision: Provision =
    deps.provision ?? ((driver, id, handle, spec, progress) => bootstrap(driver, id, handle, spec, { secret: config.secret, dshRuntime: deps.dshRuntime ?? null, startTimeoutMs: config.startTimeoutMs, dshRef: RUNTIME_REF, ...(progress ? { progress } : {}) }))
  const now = deps.now ?? Date.now
  const makeEnvd = deps.envdClient ?? createEnvdClient
  const snaps = config.snapshots
  /** Saves in progress, so a delete can cancel one. */
  const saving = new Map<string, AbortController>()
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
    const a = await place.probe()
    if (!a.ok) {
      if (a.hostKeyChanged) throw new HostKeyChangedError()
      throw new PlaceUnavailableError(place.name, a.reason)
    }
  }

  /** The GPUs a place has now: what its driver reports, else what was stored when it was added. */
  async function gpusOf(place: Place): Promise<GpuInfo[]> {
    const p = await place.probe()
    return p.ok && p.gpus && p.gpus.length > 0 ? p.gpus : place.gpus
  }

  const heldBy = (r: SandboxRecord): string[] => (r.handle.gpuIds ? r.handle.gpuIds.split(',').filter(Boolean) : [])
  /** A handle with the GPU assignment released; the GPUs it had are remembered so the next start prefers them. */
  const withoutGpus = (h: Handle): Handle => {
    const { gpuIds, lastGpuIds, ...rest } = h
    const last = gpuIds ?? lastGpuIds
    return last ? { ...rest, lastGpuIds: last } : rest
  }
  /** A handle holding exactly these GPUs. */
  const withGpus = (h: Handle, ids: string[]): Handle => {
    const { lastGpuIds: _l, gpuIds: _g, ...rest } = h
    return ids.length > 0 ? { ...rest, gpuIds: ids.join(',') } : rest
  }
  /** No machine exists yet (the assignment alone does not make one). */
  const noMachine = (h: Handle) => Object.keys(h).filter((k) => k !== 'gpuIds' && k !== 'lastGpuIds').length === 0

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
      // The GPUs it had before are preferred when still free: the same devices mean the container need not be recreated.
      const last = (r.handle.lastGpuIds ?? '').split(',').filter(Boolean)
      const same = want !== 'all' && last.length === want ? free.filter((g) => last.includes(g.uuid)) : []
      const chosen = same.length === want ? same : assignGpus(free, want, gpus.length)
      if (!chosen) throw new GpuUnavailableError(place.name, free.length, gpus.length)
      const gpuIds = chosen.map((g) => g.uuid)
      return { record: await save(r, { handle: withGpus(r.handle, gpuIds) }), gpuIds }
    })
  }

  /** Runs the driver's create then the shared bootstrap; a failed bootstrap leaves nothing behind. */
  async function makeMachine(place: Place, r: SandboxRecord, gpuIds: string[], progress: (p: ProgressUpdate) => void, from?: SnapshotRef): Promise<Handle> {
    progress({ stage: 'starting' })
    const handle = await call(place, () =>
      from ? place.driver.createFromSnapshot!(r.id, r.owner, r.template, { gpuIds, progress, runtimeRef: RUNTIME_REF }, from) : place.driver.create(r.id, r.owner, r.template, { gpuIds, progress, runtimeRef: RUNTIME_REF }),
    )
    try {
      const done = await call(place, () => provision(place.driver, r.id, handle, r.template, progress))
      return withGpus(done, gpuIds)
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

  /**
   * A driver keeps a per-sandbox secret (E2B's envd access token) in its handle under a `secret.` key.
   * Saving moves those keys, sealed, into `handleSecrets`; `dh(r)` puts them back for the driver. A save
   * whose handle carries none leaves the stored secrets alone.
   */
  const SECRET_PREFIX = 'secret.'
  const dh = (r: SandboxRecord): Handle => {
    if (!r.handleSecrets) return r.handle
    const opened = openSecrets(config.secret, r.handleSecrets)
    return { ...r.handle, ...Object.fromEntries(Object.entries(opened).map(([k, v]) => [SECRET_PREFIX + k, v])) }
  }

  async function save(r: SandboxRecord, patch: Parameters<Store['sandboxes']['update']>[2]): Promise<SandboxRecord> {
    if (patch.handle && Object.keys(patch.handle).some((k) => k.startsWith(SECRET_PREFIX))) {
      const secrets: Record<string, string> = {}
      const rest: Handle = {}
      for (const [k, v] of Object.entries(patch.handle)) {
        if (k.startsWith(SECRET_PREFIX)) secrets[k.slice(SECRET_PREFIX.length)] = v
        else rest[k] = v
      }
      patch = { ...patch, handle: rest, handleSecrets: sealSecrets(config.secret, { ...(r.handleSecrets ? openSecrets(config.secret, r.handleSecrets) : {}), ...secrets }) }
    }
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

  /** Writes progress updates to the record in order; `close` waits for the last one so none lands after the final save. */
  function progressWriter(r: SandboxRecord) {
    let chain: Promise<unknown> = Promise.resolve()
    let closed = false
    let last = ''
    return {
      report(p: ProgressUpdate) {
        const same = JSON.stringify(p)
        if (closed || same === last) return
        last = same
        chain = chain.then(() => store.sandboxes.update(r.id, r.owner, { progress: { ...p, updatedAt: now() } })).catch(() => {})
      },
      async close() {
        closed = true
        await chain
      },
    }
  }

  async function build(r: SandboxRecord, from?: SnapshotRef): Promise<SandboxRecord> {
    const writer = progressWriter(r)
    try {
      const place = placeOf(r)
      const reserved = await reserveGpus(place, r)
      const handle = await makeMachine(place, reserved.record, reserved.gpuIds, writer.report, from)
      await writer.close()
      const t = now()
      return await save(r, { state: 'running', handle, error: null, progress: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      // A failed start releases its GPUs.
      await writer.close()
      await store.sandboxes.update(r.id, r.owner, { state: 'failed', error: message(e), handle: {}, progress: null })
      throw e
    }
  }

  async function doStart(owner: string, id: string): Promise<SandboxRecord> {
    const r = await load(owner, id)
    if (r.state === 'deleting') throw new NotFoundError('sandbox')
    const place = placeOf(r)
    if (r.state === 'running' && (await call(place, () => place.driver.status(dh(r)))) === 'running') return r
    await mustAvailable(place)
    await checkRunning(owner, place, id)
    if (noMachine(r.handle)) return build(await save(r, { state: 'provisioning', error: null }))
    let reserved: { record: SandboxRecord; gpuIds: string[] } | undefined
    try {
      reserved = await reserveGpus(place, r)
      const started = await call(place, () => place.driver.start(r.id, dh(r), r.template, { gpuIds: reserved!.gpuIds }))
      let handle: Handle
      try {
        handle = await call(place, () => provision(place.driver, r.id, started, r.template))
      } catch (e) {
        await place.driver.stop(started).catch(() => {})
        throw e
      }
      handle = withGpus(handle, reserved.gpuIds)
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


  // ---- snapshots ----

  const SNAPSHOT_LEVELS: SnapshotLevel[] = ['workspace', 'disk', 'memory']
  const nativeLevels = (place: Place): SnapshotLevel[] => place.driver.capabilities.snapshots ?? []
  const levelsOf = (place: Place): SnapshotLevel[] => SNAPSHOT_LEVELS.filter((l) => nativeLevels(place).includes(l) || (l === 'workspace' && snaps.dir !== null))

  /** Moves a driver's `secret.` keys out of a snapshot handle and seals them. */
  function sealSnapHandle(h: Handle): { handle: Handle; handleSecrets: string | null } {
    const secrets: Record<string, string> = {}
    const rest: Handle = {}
    for (const [k, v] of Object.entries(h)) {
      if (k.startsWith(SECRET_PREFIX)) secrets[k.slice(SECRET_PREFIX.length)] = v
      else rest[k] = v
    }
    return { handle: rest, handleSecrets: Object.keys(secrets).length > 0 ? sealSecrets(config.secret, secrets) : null }
  }
  const refOf = (s: SnapshotRecord): SnapshotRef => ({
    id: s.id,
    level: s.level,
    handle: s.handleSecrets ? { ...s.handle, ...Object.fromEntries(Object.entries(openSecrets(config.secret, s.handleSecrets)).map(([k, v]) => [SECRET_PREFIX + k, v])) } : s.handle,
  })

  /** What a call that reads or writes a running sandbox's files through envd needs. */
  interface EnvdUse {
    envd: EnvdClient
    /** The envd user that may read and write the whole workspace. */
    user: string
    /** Who owns the workspace files. */
    agent: string
    workspace: string
  }
  async function envdOf(r: SandboxRecord): Promise<{ use: EnvdUse; release: () => void }> {
    const place = placeOf(r)
    const ep = await call(place, () => place.driver.envdEndpoint(dh(r)))
    const accessToken = ep.token ?? envdToken(config.secret, r.id)
    const agent = place.driver.agentUser ?? 'agent'
    return {
      use: { envd: makeEnvd({ baseUrl: ep.baseUrl, accessToken, ...(ep.headers ? { headers: ep.headers } : {}) }), user: place.driver.capabilities.runsAsRoot ? 'root' : agent, agent, workspace: r.template.workspacePath ?? '/workspace' },
      release: () => ep.release?.(),
    }
  }

  async function stopNow(owner: string, id: string): Promise<SandboxRecord> {
    const r = await load(owner, id)
    if (!noMachine(r.handle)) {
      const place = placeOf(r)
      await call(place, () => place.driver.stop(dh(r)))
    }
    return save(r, { state: 'stopped', handle: withoutGpus(r.handle) })
  }

  /**
   * Runs `fn` with the sandbox running and its envd reachable. The sandbox lock is held only to get it running
   * (so a long copy does not freeze the sandbox's other calls); a sandbox that was stopped is stopped again after.
   */
  async function withEnvd<T>(owner: string, id: string, fn: (u: EnvdUse) => Promise<T>): Promise<T> {
    let end = () => {}
    const prep = await locked(id, async () => {
      const wasStopped = (await load(owner, id)).state !== 'running'
      const r = await doStart(owner, id)
      const e = await envdOf(r)
      end = service.beginUse(id)
      return { ...e, wasStopped }
    })
    try {
      return await fn(prep.use)
    } finally {
      prep.release()
      end()
      if (prep.wasStopped) await locked(id, () => stopNow(owner, id)).catch(() => {})
    }
  }

  /** Removes whatever holds a snapshot's bytes. A place that is gone has nothing we can reach; one that does not answer throws. */
  async function dropBytes(snap: SnapshotRecord): Promise<void> {
    if (snap.place === 'service') {
      if (snaps.dir !== null) await removeSnapshotFile(snaps.dir, snap.id)
      return
    }
    const place = places.get(snap.place)
    if (!place) {
      console.warn(`[agentry-sandbox] snapshot ${snap.id} was kept on place ${snap.place}, which is no longer configured; its data was not removed`)
      return
    }
    if (place.driver.deleteSnapshot) await call(place, () => place.driver.deleteSnapshot!(refOf(snap)))
  }

  async function usableSnapshot(owner: string, snapId: string): Promise<SnapshotRecord> {
    const snap = await store.snapshots.get(snapId, owner)
    if (!snap) throw new NotFoundError('snapshot')
    if (snap.state !== 'ready') throw new SnapshotNotReadyError(snap.state)
    return snap
  }

  /** Extracts a generic snapshot into a running sandbox. */
  async function extractInto(r: SandboxRecord, snap: SnapshotRecord, clear: boolean): Promise<void> {
    if (snaps.dir === null) throw new SnapshotsOffError()
    const { use, release } = await envdOf(r)
    try {
      await restoreWorkspace(use.envd, { user: use.user, workspace: use.workspace, file: snapshotFile(snaps.dir, snap.id), owner: use.agent, clear })
    } finally {
      release()
    }
  }

  async function takeNative(owner: string, sandboxId: string, rec: SnapshotRecord, stopFirst: boolean): Promise<{ handle: Handle; sizeBytes?: number }> {
    const run = async () => {
      const r = await load(owner, sandboxId)
      const place = placeOf(r)
      return call(place, () => place.driver.snapshot!(r.id, dh(r), r.template, { snapId: rec.id, level: rec.level, name: rec.name }))
    }
    if (stopFirst) {
      return locked(sandboxId, async () => {
        const wasRunning = (await load(owner, sandboxId)).state === 'running'
        if (wasRunning) await stopNow(owner, sandboxId)
        try {
          return await run()
        } finally {
          if (wasRunning) await doStart(owner, sandboxId).catch(() => {})
        }
      })
    }
    const end = service.beginUse(sandboxId)
    try {
      return await run()
    } finally {
      end()
    }
  }

  /** The background half of `snapshot`: takes it, then marks the record ready or failed. */
  async function runSnapshot(rec: SnapshotRecord, generic: boolean, stopFirst: boolean, signal: AbortSignal): Promise<void> {
    const { owner, sandboxId } = rec
    try {
      let out: { handle: Handle; sizeBytes?: number }
      if (generic) {
        const dir = snaps.dir!
        const bytes = await withEnvd(owner, sandboxId, (u) => saveWorkspace(u.envd, { user: u.user, workspace: u.workspace, file: snapshotFile(dir, rec.id), maxBytes: snaps.maxBytes, signal }))
        out = { handle: { file: `${rec.id}.tar.gz` }, sizeBytes: bytes }
      } else {
        out = await takeNative(owner, sandboxId, rec, stopFirst)
      }
      const sealed = sealSnapHandle(out.handle)
      const done = await store.snapshots.update(rec.id, owner, { state: 'ready', handle: sealed.handle, handleSecrets: sealed.handleSecrets, sizeBytes: out.sizeBytes ?? null, error: null })
      // Deleted while it was being taken: nothing refers to the bytes any more.
      if (!done) await dropBytes({ ...rec, handle: sealed.handle, handleSecrets: sealed.handleSecrets }).catch(() => {})
    } catch (e) {
      if (generic) await removeSnapshotFile(snaps.dir!, rec.id).catch(() => {})
      await store.snapshots.update(rec.id, owner, { state: 'failed', error: message(e).slice(0, 500) }).catch(() => {})
    }
  }

  async function restoreGeneric(r: SandboxRecord, snap: SnapshotRecord): Promise<SandboxRecord> {
    if (snaps.dir === null) throw new SnapshotsOffError()
    const wasStopped = r.state !== 'running'
    const running = await doStart(r.owner, r.id)
    try {
      await extractInto(running, snap, true)
    } finally {
      if (wasStopped) await stopNow(r.owner, r.id).catch(() => {})
    }
    return save(await load(r.owner, r.id), { lastUsedAt: now() })
  }

  async function restoreNative(r: SandboxRecord, snap: SnapshotRecord): Promise<SandboxRecord> {
    const place = placeOf(r)
    if (snap.place !== r.backend) throw new LimitError(`this ${snap.level} snapshot is kept on place '${snap.place}'; it can only be restored into a sandbox there`)
    if (!place.driver.restoreSnapshot) throw new LimitError(`place '${place.name}' cannot restore ${snap.level} snapshots`)
    await mustAvailable(place)
    await checkRunning(r.owner, place, r.id)
    let current = r
    try {
      const reserved = await reserveGpus(place, r)
      current = reserved.record
      const restored = await call(place, () => place.driver.restoreSnapshot!(r.id, dh(r), r.template, refOf(snap), { gpuIds: reserved.gpuIds }))
      const handle = await call(place, () => provision(place.driver, r.id, restored, r.template))
      const t = now()
      return await save(current, { state: 'running', handle: withGpus(handle, reserved.gpuIds), error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      await store.sandboxes.update(r.id, r.owner, { state: 'failed', error: message(e), handle: {} })
      throw e
    }
  }

  /** Logs what a forgotten sandbox may have left on its place (ids only, never credentials). */
  function forgotten(r: SandboxRecord, why: string): void {
    const left = Object.entries(r.handle).filter(([k]) => k === 'containerId' || k === 'volume').map(([k, v]) => `${k}=${v}`).join(' ')
    console.warn(`[agentry-sandbox] forgot sandbox ${r.id} on place ${r.backend} without cleaning it up (${why}); it may have left behind: ${left || 'nothing recorded'}`)
  }

  let sweeping: Promise<string[]> | undefined
  const sweepOnce = async (): Promise<string[]> => {
    const stopped: string[] = []
    // A place that does not answer is skipped: waiting out its timeouts would stall every other place's upkeep.
    const up = new Set<string>()
    await Promise.all(places.list().map(async (p) => { if ((await p.probe()).ok) up.add(p.id) }))
    for (const snapshot of await store.sandboxes.listAll()) {
      if (snapshot.state !== 'running' || !up.has(snapshot.backend)) continue
      await locked(snapshot.id, async () => {
        const r = await store.sandboxes.getAny(snapshot.id)
        if (!r || r.state !== 'running') return
        const last = r.lastUsedAt ?? r.startedAt ?? r.createdAt
        if (!inUse.has(r.id) && last <= now() - config.idleStopMinutes * 60_000) {
          try {
            const place = placeOf(r)
            await call(place, () => place.driver.stop(dh(r)))
            await save(r, { state: 'stopped', handle: withoutGpus(r.handle) })
            stopped.push(r.id)
          } catch {
            // Leave it running; the next sweep tries again.
          }
          return
        }
        // Still running: keep its network rules in place (a host firewall reload drops them).
        const place = places.get(r.backend)
        if (place?.driver.maintain) await place.driver.maintain(r.id, dh(r), r.template).catch(() => {})
      })
    }
    return stopped
  }

  const service: SandboxService = {
    async create(owner, input) {
      let template: TemplateSpec = input.template ?? {}
      let templateId: string | null = null
      if (input.templateId) {
        const t = await store.templates.get(input.templateId, owner)
        if (!t) throw new NotFoundError('template')
        template = { ...t.spec, ...input.template }
        templateId = t.id
      }
      // Starting from a snapshot: a generic one (files only) goes on any place; a native one only where it was taken.
      let from: SnapshotRecord | undefined
      if (input.snapshot !== undefined) {
        from = await usableSnapshot(owner, input.snapshot)
        if (from.place === 'service') {
          if (snaps.dir === null) throw new SnapshotsOffError()
        } else {
          const asked = input.place ?? template.place
          if (asked !== undefined && asked !== from.place) throw new LimitError(`this ${from.level} snapshot is kept on place '${from.place}'; a sandbox made from it must run there`)
          const source = await store.sandboxes.get(from.sandboxId, owner)
          template = { ...(source?.template ?? {}), ...template }
        }
      }
      const placeId = input.place ?? template.place ?? (from && from.place !== 'service' ? from.place : places.default().id)
      const place = places.get(placeId)
      if (!place) throw new LimitError(`no place '${placeId}'`)
      if (from && from.place !== 'service' && !place.driver.createFromSnapshot) throw new LimitError(`place '${place.name}' cannot start a sandbox from a ${from.level} snapshot`)
      const gpus = input.gpus ?? template.gpus
      template = { ...template, place: placeId, ...(gpus !== undefined ? { gpus } : {}) }
      const allowed = place.driver.capabilities.templateFields
      for (const field of Object.keys(template) as (keyof TemplateSpec)[]) {
        if (template[field] === undefined || field === 'place' || field === 'workspacePath') continue
        if (field === 'gpus') continue
        if (!allowed.includes(field)) throw new LimitError(`place '${place.name}' does not support '${field}'${place.driver.fieldHints?.[field] ? `: ${place.driver.fieldHints[field]}` : ''}`)
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
        progress: null,
        createdAt: now(),
        startedAt: null,
        lastUsedAt: null,
      }
      await store.sandboxes.insert(record)
      // A create that fails leaves nothing behind: the caller gets the reason and never learned the id,
      // so a kept failed record would only count against the owner's limits.
      return locked(record.id, async () => {
        try {
          const built = await build(record, from && from.place !== 'service' ? refOf(from) : undefined)
          // A generic snapshot's files go over the template's (it set the sandbox up first).
          if (from && from.place === 'service') await extractInto(built, from, false)
          return built
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
      return locked(id, () => stopNow(owner, id))
    },

    reset(owner, id, { keepWorkspace }) {
      return locked(id, async () => {
        const r = await load(owner, id)
        checkResources(r.template)
        const place = placeOf(r)
        if (keepWorkspace && !place.driver.capabilities.keepFilesOnReset) throw new LimitError('this place cannot keep files on reset; reset without keeping files')
        await mustAvailable(place)
        await checkRunning(owner, place, id)
        checkRate(owner)
        await call(place, () => place.driver.destroy(r.id, dh(r), { keepWorkspace }))
        return build(await save(r, { state: 'provisioning', handle: {}, error: null }))
      })
    },

    async destroy(owner, id, opts = {}) {
      await locked(id, async () => {
        const r = await load(owner, id)
        const place = places.get(r.backend)
        // Nothing to clean up through: the place was removed or can no longer be built. The record is forgotten.
        if (!place) {
          forgotten(r, 'the place is no longer configured')
          await store.sandboxes.delete(id, owner)
          return undefined
        }
        try {
          await call(place, () => place.driver.destroy(r.id, dh(r), { keepWorkspace: false }))
        } catch (e) {
          if (!opts.force) throw e
          forgotten(r, message(e))
        }
        await store.sandboxes.delete(id, owner)
        return place
      }).then(async (place) => {
        if (place && (await store.sandboxes.list(owner)).length === 0 && place.driver.releaseOwner) await place.driver.releaseOwner(owner).catch(() => {})
      })
    },

    async touch(owner, id) {
      const r = await load(owner, id)
      await save(r, { lastUsedAt: now() })
    },

    async endpoint(owner, id) {
      const r = await locked(id, () => doStart(owner, id))
      const place = placeOf(r)
      const { baseUrl, token, headers, release } = await call(place, () => place.driver.envdEndpoint(dh(r)))
      return { baseUrl, token: token ?? envdToken(config.secret, r.id), ...(headers ? { headers } : {}), ...(release ? { release } : {}), ...(place.driver.envdUser ? { envdUser: place.driver.envdUser.bind(place.driver) } : {}) }
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
        const probe = await place.probe()
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

    async snapshot(owner, id, input = {}) {
      const r = await load(owner, id)
      const level = input.level ?? 'workspace'
      if (!SNAPSHOT_LEVELS.includes(level)) throw new LimitError(`level must be one of ${SNAPSHOT_LEVELS.join(', ')}`)
      const place = placeOf(r)
      const generic = level === 'workspace' && snaps.dir !== null
      if (!generic && !nativeLevels(place).includes(level)) {
        if (level === 'workspace') throw new SnapshotsOffError()
        const can = levelsOf(place)
        throw new LimitError(`place '${place.name}' cannot take ${level} snapshots${can.length > 0 ? ` (it can take: ${can.join(', ')})` : ''}`)
      }
      const mine = (await store.snapshots.list(owner)).filter((x) => x.state !== 'failed').length
      if (mine >= snaps.maxPerOwner) throw new QuotaExceededError(`You already have ${String(mine)} snapshots (limit ${String(snaps.maxPerOwner)}). Delete one first.`)
      const t = now()
      const rec: SnapshotRecord = {
        id: `snap_${randomBytes(16).toString('hex')}`,
        owner,
        sandboxId: id,
        place: generic ? 'service' : place.id,
        level,
        name: input.name?.trim() || `${r.name} ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}`,
        state: 'saving',
        handle: {},
        handleSecrets: null,
        sizeBytes: null,
        error: null,
        createdAt: t,
        expiresAt: snaps.days > 0 ? t + snaps.days * 86_400_000 : null,
      }
      if (generic) await ensureSnapshotDir(snaps.dir!)
      await store.snapshots.insert(rec)
      const abort = new AbortController()
      saving.set(rec.id, abort)
      void runSnapshot(rec, generic, input.stopFirst === true, abort.signal).finally(() => saving.delete(rec.id))
      return rec
    },

    listSnapshots: (owner, opts) => store.snapshots.list(owner, opts),

    async getSnapshot(owner, snapId) {
      const snap = await store.snapshots.get(snapId, owner)
      if (!snap) throw new NotFoundError('snapshot')
      return snap
    },

    async deleteSnapshot(owner, snapId) {
      const snap = await store.snapshots.get(snapId, owner)
      if (!snap) throw new NotFoundError('snapshot')
      saving.get(snapId)?.abort()
      await dropBytes(snap)
      await store.snapshots.delete(snapId, owner)
    },

    restore(owner, id, snapId) {
      return locked(id, async () => {
        const r = await load(owner, id)
        const snap = await usableSnapshot(owner, snapId)
        return snap.place === 'service' ? restoreGeneric(r, snap) : restoreNative(r, snap)
      })
    },

    snapshotLevels(placeId) {
      const place = places.get(placeId)
      return place ? levelsOf(place) : []
    },

    async sweepSnapshots() {
      const gone: string[] = []
      for (const snap of await store.snapshots.listExpired(now())) {
        if (snap.state === 'saving') continue
        try {
          await dropBytes(snap)
          await store.snapshots.delete(snap.id, snap.owner)
          gone.push(snap.id)
        } catch (e) {
          console.warn(`[agentry-sandbox] could not remove expired snapshot ${snap.id}: ${message(e)}`)
        }
      }
      return gone
    },

    async recoverSnapshots() {
      if (snaps.dir !== null) {
        await ensureSnapshotDir(snaps.dir)
        await removeStaleParts(snaps.dir)
      }
      for (const snap of await store.snapshots.listAll()) {
        if (snap.state !== 'saving' || saving.has(snap.id)) continue
        await store.snapshots.update(snap.id, snap.owner, { state: 'failed', error: 'the service restarted while the snapshot was being taken' })
      }
    },

    async listEverySnapshot() {
      return (await store.snapshots.listAll()).sort((a, b) => b.createdAt - a.createdAt)
    },

    async snapshotOwnerOf(snapId) {
      return (await store.snapshots.getAny(snapId))?.owner
    },

    setLimitsForTest(next) {
      limits = { ...limits, ...next }
    },
  }
  return service
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
