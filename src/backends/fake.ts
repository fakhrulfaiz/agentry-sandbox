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
}

export function createFakeBackend(): FakeBackend {
  const boxes = new Map<string, { owner: string; running: boolean }>()
  let failure: string | undefined
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
    async available() {
      return availability
    },
    async create(id: string, owner: string, _spec: TemplateSpec) {
      calls.push(`create ${id}`)
      boxes.set(id, { owner, running: true })
      return { id }
    },
    async start(id) {
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
      calls.push(`stop ${idOf(handle)}`)
      const box = boxes.get(idOf(handle))
      if (box) box.running = false
    },
    async destroy(handle, { keepWorkspace }) {
      calls.push(`destroy ${idOf(handle)} keep=${String(keepWorkspace)}`)
      boxes.delete(idOf(handle))
    },
    async status(handle) {
      const box = boxes.get(idOf(handle))
      return box ? (box.running ? 'running' : 'stopped') : 'missing'
    },
    async endpoint() {
      return { baseUrl }
    },
    async listManaged() {
      return [...boxes].map(([id, b]) => ({ id, owner: b.owner, handle: { id } }))
    },
  }
}
