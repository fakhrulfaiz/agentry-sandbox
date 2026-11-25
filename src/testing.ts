/**
 * A real Agentry Sandbox HTTP service on an ephemeral port, over an in-memory
 * store and the fake backend, for tests here and in the Agentry API
 * (`@agentry/sandbox/testing`). Point `backend.setEndpoint` (the fake driver) at a fake envd to
 * exercise the relay.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createPassthroughNetworkGuard, type Driver } from './places/driver.ts'
import { createDockerDriver, dockerClient, dockerDshRuntime } from './places/drivers/docker.ts'
import { createFakeDriver, type FakeDriver } from './places/drivers/fake.ts'
import { createPlaceRegistry, type DriverFactory, type PlaceRegistry } from './places/registry.ts'
import { loadConfig, type SandboxConfig } from './config.ts'
import { createServer } from './http/server.ts'
import { createSandboxService, type SandboxService } from './sandboxes.ts'
import { createMemoryStore } from './store/memory.ts'
import type { Store } from './store/types.ts'

export interface TestService {
  url: string
  key: string
  config: SandboxConfig
  backend: FakeDriver
  service: SandboxService
  places: PlaceRegistry
  /** The in-memory store behind the service. */
  store: Store
  close(): Promise<void>
}

export interface DockerTestService extends Omit<TestService, 'backend'> {
  backend: Driver
  /** Removes every sandbox this service created (containers and volumes). */
  cleanup(): Promise<void>
}

/**
 * The same service over the real Docker backend (no egress firewall), for
 * integration suites that need real envd processes; callers skip without Docker.
 */
export async function startDockerTestService(env: Record<string, string> = {}): Promise<DockerTestService> {
  const base = await startTestService(env, {
    makeDriver: (config) => createDockerDriver(config, createPassthroughNetworkGuard()),
    dshRuntime: (config) => dockerDshRuntime(config, dockerClient(config)),
  })
  return {
    ...base,
    backend: base.backend as unknown as Driver,
    async cleanup() {
      for (const owner of base.ownersSeen) for (const s of await base.service.list(owner)) await base.service.destroy(owner, s.id).catch(() => {})
    },
  }
}

export async function startTestService(env: Record<string, string> = {}, real?: { makeDriver: (config: SandboxConfig) => Driver; dshRuntime: (config: SandboxConfig) => (() => Promise<Buffer>) | null }, drivers: Record<string, DriverFactory> = {}): Promise<TestService & { ownersSeen: Set<string> }> {
  const key = randomBytes(16).toString('hex')
  const config = loadConfig({
    AGENTRY_SANDBOX_DATABASE_URL: 'postgres://unused@localhost/unused',
    AGENTRY_SANDBOX_API_KEYS: `sha256:${createHash('sha256').update(key).digest('hex')}`,
    AGENTRY_SANDBOX_SECRET: randomBytes(32).toString('hex'),
    AGENTRY_SANDBOX_MAX_PER_OWNER: '100',
    AGENTRY_SANDBOX_MAX_RUNNING_PER_OWNER: '100',
    AGENTRY_SANDBOX_MAX_RUNNING_TOTAL: '100',
    AGENTRY_SANDBOX_MAX_TOTAL: '100',
    AGENTRY_SANDBOX_MAX_CREATES_PER_HOUR: '1000',
    ...env,
  })
  const store = createMemoryStore()
  const backend = (real ? real.makeDriver(config) : createFakeDriver()) as FakeDriver
  const places = await createPlaceRegistry({ store, config, local: backend, drivers })
  // The fake has no envd behind it, so nothing is provisioned there.
  const service = createSandboxService({ store, places, config, ...(real ? { dshRuntime: real.dshRuntime(config) } : { provision: async (_d: Driver, _i: string, h: Record<string, string>) => h }) })
  const ownersSeen = new Set<string>()
  const create = service.create.bind(service)
  service.create = ((owner: string, ...rest: unknown[]) => { ownersSeen.add(owner); return (create as (...a: unknown[]) => unknown)(owner, ...rest) }) as typeof service.create
  const server = createServer({ config, service, store, places })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    key,
    config,
    backend,
    service,
    places,
    store,
    ownersSeen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
