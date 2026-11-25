/** Starts the HTTP API on an ephemeral port over an in-memory store and the fake backend. */
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createFakeDriver, type FakeDriver } from '../../src/places/drivers/fake.ts'
import { createPlaceRegistry } from '../../src/places/registry.ts'
import { loadConfig, type SandboxConfig } from '../../src/config.ts'
import { createServer } from '../../src/http/server.ts'
import { createSandboxService, type SandboxService } from '../../src/sandboxes.ts'
import { createMemoryStore } from '../../src/store/memory.ts'
import type { Store } from '../../src/store/types.ts'

export const KEY = 'test-key-123'
export const config: SandboxConfig = loadConfig({
  AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x',
  AGENTRY_SANDBOX_API_KEYS: `sha256:${createHash('sha256').update(KEY).digest('hex')}`,
  AGENTRY_SANDBOX_SECRET: 's'.repeat(32),
})

export interface TestServer {
  url: string
  backend: FakeDriver
  service: SandboxService
  store: Store
  close(): Promise<void>
  /** fetch with the key and an owner (default alice). */
  call(path: string, init?: RequestInit & { owner?: string | null; key?: string | null }): Promise<Response>
}

export async function startServer(): Promise<TestServer> {
  const store = createMemoryStore()
  const backend = createFakeDriver()
  const places = await createPlaceRegistry({ store, config, local: backend, drivers: {} })
  const service = createSandboxService({ store, places, config, provision: async (_d, _i, h) => h })
  const server = createServer({ config, service, store, places })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return {
    url,
    backend,
    service,
    store,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
    call(path, init = {}) {
      const { owner = 'alice', key = KEY, headers, ...rest } = init
      const h = new Headers(headers)
      if (key !== null) h.set('Authorization', `Bearer ${key}`)
      if (owner !== null) h.set('X-Agentry-Owner', owner)
      if (rest.body && !h.has('content-type')) h.set('content-type', 'application/json')
      return fetch(`${url}${path}`, { ...rest, headers: h })
    },
  }
}
