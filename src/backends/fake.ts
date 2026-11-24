/**
 * An in-memory Backend for tests (here and in Agentry's API): records every
 * call, can fail the next start, go unavailable, lose or invent sandboxes,
 * and point `endpoint` at any URL (a fake envd).
 */
import type { TemplateSpec } from '../store/types.ts'
import type { Availability, Backend, BackendHandle } from './types.ts'

export interface FakeBackend extends Backend {
  calls: string[]
  failNextStart(reason: string): void
  setAvailable(ok: boolean, reason?: string): void
  /** Drops a sandbox as if its container vanished. */
  forget(id: string): void
  /** Adds a managed sandbox the service has no record of. */
  adoptForeign(id: string, owner: string): void
  /** Where `endpoint` points (default `http://127.0.0.1:1`). */
  setEndpoint(baseUrl: string): void
  /** Delays every create by `ms` (to test calls racing a provisioning sandbox). */
  setCreateDelay(ms: number): void
  failNextCreate(reason: string): void
  /** Makes every Docker-facing call fail like an unreachable daemon (undefined restores). */
  failConnections(message: string | undefined): void
}

export function createFakeBackend(): FakeBackend {
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
  const idOf = (h: BackendHandle) => h.id ?? ''

  return {
    kind: 'fake',
    capabilities: { persistent: true, network: true, resources: false, templateFields: ['image', 'packages', 'setupCommands', 'env', 'network', 'files'] },
    calls,
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
    async available() {
      if (connection !== undefined) return { ok: false, reason: connection }
      return availability
    },
    async describeImage() {
      return { runtimes: { python: '3.11', node: '24' }, python_packages: ['pandas'], tools: ['git'] }
    },
    async create(id: string, owner: string, _spec: TemplateSpec) {
      down()
      calls.push(`create ${id}`)
      if (createDelay > 0) await new Promise((r) => setTimeout(r, createDelay))
      if (createFailure !== undefined) {
        const reason = createFailure
        createFailure = undefined
        throw new Error(reason)
      }
      boxes.set(id, { owner, running: true })
      return { id }
    },
    async start(id) {
      down()
      calls.push(`start ${id}`)
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
    async endpoint() {
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
