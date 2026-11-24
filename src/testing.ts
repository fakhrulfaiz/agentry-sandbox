/**
 * A real Agentry Sandbox HTTP service on an ephemeral port, over an in-memory
 * store and the fake backend, for tests here and in the Agentry API
 * (`@agentry/sandbox/testing`). Point `backend.setEndpoint` at a fake envd to
 * exercise the relay.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createFakeBackend, type FakeBackend } from './backends/fake.ts'
import { loadConfig, type SandboxConfig } from './config.ts'
import { createServer } from './http/server.ts'
import { createSandboxService, type SandboxService } from './sandboxes.ts'
import { createMemoryStore } from './store/memory.ts'

export interface TestService {
  url: string
  key: string
  config: SandboxConfig
  backend: FakeBackend
  service: SandboxService
  close(): Promise<void>
}

export async function startTestService(env: Record<string, string> = {}): Promise<TestService> {
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
  const backend = createFakeBackend()
  const service = createSandboxService({ store, backend, config })
  const server = createServer({ config, service, store, backend })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    key,
    config,
    backend,
    service,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
