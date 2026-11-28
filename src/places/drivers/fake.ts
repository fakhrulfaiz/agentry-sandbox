/**
 * An in-memory Driver for tests (here and in Agentry's API): records every
 * call, can fail the next start, go unavailable, lose or invent sandboxes,
 * and point `envdEndpoint` at any URL (a fake envd).
 */
import type { GpuInfo, SnapshotLevel, TemplateSpec } from '../../store/types.ts'
import type { Availability, Driver, Handle } from '../driver.ts'

export interface FakeKnobs {
  calls: string[]
  /** The GPU uuids last given to each sandbox's create or start. */
  gpuIds: Map<string, string[]>
  failNextStart(reason: string): void
  setAvailable(ok: boolean, reason?: string): void
  /** Drops a sandbox as if its container vanished. */
  forget(id: string): void
  /** Adds a managed sandbox the service has no record of. */
  adoptForeign(id: string, owner: string): void
  /** The GPUs `probe` reports. */
  setGpus(gpus: GpuInfo[]): void
  /** Where `envdEndpoint` points (default `http://127.0.0.1:1`). */
  setEndpoint(baseUrl: string): void
  /** Delays every create by `ms` (to test calls racing a provisioning sandbox). */
  setCreateDelay(ms: number): void
  failNextCreate(reason: string): void
  /** Makes every Docker-facing call fail like an unreachable daemon (undefined restores). */
  failConnections(message: string | undefined): void
  /** The native snapshot levels the fake reports (default none); the snapshot methods exist either way. */
  setSnapshotLevels(levels: SnapshotLevel[]): void
  /** The native snapshots the fake holds, by snapshot id. */
  snapshots: Map<string, { sandboxId: string; level: SnapshotLevel; secret?: string }>
  failNextSnapshot(reason: string): void
}

export type FakeDriver = Driver & FakeKnobs

export function createFakeDriver(): FakeDriver {
  let gpus: GpuInfo[] = []
  const boxes = new Map<string, { owner: string; running: boolean }>()
  let failure: string | undefined
  let createFailure: string | undefined
  let createDelay = 0
  let connection: string | undefined
  const down = () => {
    if (connection !== undefined) throw Object.assign(new Error(connection), { code: 'ECONNREFUSED' })
  }
  let availability: Availability = { ok: true, version: 'fake' }
  let baseUrl = 'http://127.0.0.1:1'
  const calls: string[] = []
  const snapshots = new Map<string, { sandboxId: string; level: SnapshotLevel; secret?: string }>()
  let snapshotFailure: string | undefined
  const capabilities: Driver['capabilities'] = { persistent: true, reset: true, keepFilesOnReset: true, isolated: true, network: true, resources: false, gpu: false, envdBuiltIn: false, runsAsRoot: true, templateFields: ['image', 'packages', 'setupCommands', 'env', 'network', 'files', 'resources'] }
  const gpuIds = new Map<string, string[]>()
  const idOf = (h: Handle) => h.id ?? ''

  return {
    kind: 'fake',
    capabilities,
    snapshots,
    setSnapshotLevels(levels) {
      capabilities.snapshots = levels
    },
    failNextSnapshot(reason) {
      snapshotFailure = reason
    },
    async snapshot(id, _handle, _spec, opts) {
      down()
      calls.push(`snapshot ${id} ${opts.level}`)
      if (snapshotFailure !== undefined) {
        const reason = snapshotFailure
        snapshotFailure = undefined
        throw new Error(reason)
      }
      snapshots.set(opts.snapId, { sandboxId: id, level: opts.level, secret: 'tok' })
      return { handle: { fakeSnapshot: opts.snapId, 'secret.token': 'tok' }, sizeBytes: 1234 }
    },
    async restoreSnapshot(id, _handle, _spec, snap) {
      down()
      calls.push(`restoreSnapshot ${id} ${snap.id} ${snap.handle['secret.token'] ?? 'no-secret'}`)
      boxes.set(id, { owner: boxes.get(id)?.owner ?? '', running: true })
      return { id }
    },
    async createFromSnapshot(id, owner, _spec, _ctx, snap) {
      down()
      calls.push(`createFromSnapshot ${id} ${snap.id}`)
      boxes.set(id, { owner, running: true })
      return { id }
    },
    async deleteSnapshot(snap) {
      calls.push(`deleteSnapshot ${snap.id}`)
      snapshots.delete(snap.id)
    },
    calls,
    gpuIds,
    failNextStart(reason) {
      failure = reason
    },
    setAvailable(ok, reason = 'unavailable') {
      availability = ok ? { ok: true, version: 'fake' } : { ok: false, reason }
    },
    forget(id) {
      boxes.delete(id)
    },
    adoptForeign(id, owner) {
      boxes.set(id, { owner, running: false })
    },
    setGpus(g) {
      gpus = g
    },
    setEndpoint(url) {
      baseUrl = url
    },
    setCreateDelay(ms) {
      createDelay = ms
    },
    failNextCreate(reason) {
      createFailure = reason
    },
    failConnections(message) {
      connection = message
    },
    async probe() {
      if (connection !== undefined) return { ok: false, reason: connection }
      return { ...availability, gpus }
    },
    async describeImage() {
      return { runtimes: { python: '3.11', node: '24' }, python_packages: ['pandas'], tools: ['git'] }
    },
    async create(id: string, owner: string, _spec: TemplateSpec, ctx) {
      down()
      calls.push(`create ${id}`)
      gpuIds.set(id, ctx.gpuIds)
      if (createDelay > 0) await new Promise((r) => setTimeout(r, createDelay))
      if (createFailure !== undefined) {
        const reason = createFailure
        createFailure = undefined
        throw new Error(reason)
      }
      boxes.set(id, { owner, running: true })
      return { id }
    },
    async start(id, _handle, _spec, ctx) {
      down()
      calls.push(`start ${id}`)
      gpuIds.set(id, ctx.gpuIds)
      await new Promise((r) => setTimeout(r, 5))
      if (failure !== undefined) {
        const reason = failure
        failure = undefined
        throw new Error(reason)
      }
      const box = boxes.get(id)
      if (!box) throw new Error(`no sandbox ${id}`)
      box.running = true
      return { id }
    },
    async stop(handle) {
      down()
      calls.push(`stop ${idOf(handle)}`)
      const box = boxes.get(idOf(handle))
      if (box) box.running = false
    },
    async destroy(id, _handle, { keepWorkspace }) {
      down()
      calls.push(`destroy ${id} keep=${String(keepWorkspace)}`)
      boxes.delete(id)
    },
    async status(handle) {
      down()
      const box = boxes.get(idOf(handle))
      return box ? (box.running ? 'running' : 'stopped') : 'missing'
    },
    async envdEndpoint() {
      down()
      return { baseUrl }
    },
    async maintain(id) {
      calls.push(`maintain ${id}`)
    },
    async releaseOwner(owner) {
      calls.push(`releaseOwner ${owner}`)
    },
    async listManaged() {
      return [...boxes].map(([id, b]) => ({ id, owner: b.owner, handle: { id } }))
    },
  }
}
