/**
 * Single-backend adapter: a Driver plus the shared bootstrap, presented as
 * the `Backend` the sandbox service still calls. Task 3 replaces this with
 * the place registry.
 */
import type Docker from 'dockerode'
import type { SandboxConfig } from '../config.ts'
import type { Backend, NetworkGuard } from '../backends/types.ts'
import { bootstrap } from './bootstrap.ts'
import type { Driver } from './driver.ts'
import { createDockerDriver, dockerClient, dockerDshRuntime } from './drivers/docker.ts'
import { createFakeDriver, type FakeKnobs } from './drivers/fake.ts'

export function backendFromDriver(driver: Driver, config: SandboxConfig, dshRuntime: (() => Promise<Buffer>) | null, opts: { bootstrap?: boolean } = {}): Backend {
  const boot = (id: string, handle: Parameters<Driver['start']>[1], spec: Parameters<Driver['start']>[2]) =>
    opts.bootstrap === false
      ? Promise.resolve(handle)
      : bootstrap(driver, id, handle, spec, { secret: config.secret, dshRuntime, startTimeoutMs: config.startTimeoutMs, dshRef: config.dshRuntimeImage || 'dsh' })
  const ctx = { gpuIds: [] }
  return {
    kind: driver.kind,
    capabilities: driver.capabilities,
    async available() {
      const { gpus: _gpus, ...a } = await driver.probe()
      return a
    },
    ...(driver.describeImage ? { describeImage: (image: string) => driver.describeImage!(image) } : {}),
    async create(id, owner, spec) {
      const handle = await driver.create(id, owner, spec, ctx)
      try {
        return await boot(id, handle, spec)
      } catch (e) {
        // Fail closed: nothing half-made stays behind, running or not.
        await driver.destroy(id, handle, { keepWorkspace: false }).catch(() => {})
        throw e
      }
    },
    async start(id, handle, spec) {
      const started = await driver.start(id, handle, spec, ctx)
      try {
        return await boot(id, started, spec)
      } catch (e) {
        await driver.stop(started).catch(() => {})
        throw e
      }
    },
    stop: (handle) => driver.stop(handle),
    destroy: (id, handle, o) => driver.destroy(id, handle, o),
    status: (handle) => driver.status(handle),
    async endpoint(handle) {
      const { baseUrl } = await driver.envdEndpoint(handle)
      return { baseUrl }
    },
    ...(driver.maintain ? { maintain: (id: string, handle: Parameters<Driver['stop']>[0], spec: Parameters<Driver['start']>[2]) => driver.maintain!(id, handle, spec) } : {}),
    ...(driver.releaseOwner ? { releaseOwner: (owner: string) => driver.releaseOwner!(owner) } : {}),
    listManaged: () => driver.listManaged(),
  }
}

export function createDockerBackend(config: SandboxConfig, network: NetworkGuard, client: Docker = dockerClient(config), puller?: Docker): Backend {
  return backendFromDriver(createDockerDriver(config, network, client, puller), config, dockerDshRuntime(config, client))
}

export type FakeBackend = Backend & FakeKnobs & { calls: string[] }

/** The fake driver as a `Backend` with its knobs; provisioning is skipped (no real envd behind it). */
export function createFakeBackend(): FakeBackend {
  const driver = createFakeDriver()
  const backend = backendFromDriver(driver, { secret: 's', startTimeoutMs: 1_000, dshRuntimeImage: '' } as SandboxConfig, null, { bootstrap: false })
  const { probe: _p, create: _c, start: _s, stop: _st, destroy: _d, status: _status, envdEndpoint: _e, maintain: _m, releaseOwner: _r, listManaged: _l, describeImage: _di, capabilities: _cap, kind: _k, ...knobs } = driver
  return Object.assign(backend, knobs)
}
