/**
 * Sandbox lifecycle over a Store and a Backend: create from a template
 * snapshot, start (one start in flight per sandbox), stop, reset, destroy,
 * the envd endpoint and token, the idle sweep, and startup reconciliation of
 * records against the backend's own labelled sandboxes.
 */
import { randomBytes } from 'node:crypto'
import type { Backend } from './backends/types.ts'
import type { SandboxConfig } from './config.ts'
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
  sweepIdle(): Promise<string[]>
  reconcile(): Promise<{ adopted: string[]; missing: string[]; unknown: string[] }>
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createSandboxService(deps: { store: Store; backend: Backend; config: SandboxConfig; now?: () => number }): SandboxService {
  const { store, backend, config } = deps
  const now = deps.now ?? Date.now
  const starting = new Map<string, Promise<SandboxRecord>>()

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

  async function doStart(r: SandboxRecord): Promise<SandboxRecord> {
    if (r.state === 'running' && (await backend.status(r.handle)) === 'running') return r
    await mustAvailable()
    try {
      const handle = await backend.start(r.id, r.handle, r.template)
      const t = now()
      return await save(r, { state: 'running', handle, error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      await save(r, { state: 'failed', error: message(e) })
      throw e
    }
  }

  async function start(owner: string, id: string): Promise<SandboxRecord> {
    const r = await load(owner, id)
    let p = starting.get(id)
    if (!p) {
      p = doStart(r).finally(() => starting.delete(id))
      starting.set(id, p)
    }
    return p
  }

  async function build(r: SandboxRecord): Promise<SandboxRecord> {
    try {
      const handle = await backend.create(r.id, r.owner, r.template)
      const t = now()
      return await save(r, { state: 'running', handle, error: null, startedAt: t, lastUsedAt: t })
    } catch (e) {
      await save(r, { state: 'failed', error: message(e) })
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
      await mustAvailable()
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
      return build(record)
    },

    list: (owner) => store.sandboxes.list(owner),
    get: load,
    start,

    async stop(owner, id) {
      const r = await load(owner, id)
      await backend.stop(r.handle)
      return save(r, { state: 'stopped' })
    },

    async reset(owner, id, { keepWorkspace }) {
      const r = await load(owner, id)
      await mustAvailable()
      await backend.destroy(r.handle, { keepWorkspace })
      const cleared = await save(r, { state: 'provisioning', handle: {}, error: null })
      return build(cleared)
    },

    async destroy(owner, id) {
      const r = await load(owner, id)
      await save(r, { state: 'deleting' })
      await backend.destroy(r.handle, { keepWorkspace: false })
      await store.sandboxes.delete(id, owner)
    },

    async touch(owner, id) {
      const r = await load(owner, id)
      await save(r, { lastUsedAt: now() })
    },

    async endpoint(owner, id) {
      const r = await start(owner, id)
      const { baseUrl } = await backend.endpoint(r.handle)
      return { baseUrl, token: envdToken(config.secret, r.id) }
    },

    async sweepIdle() {
      const limit = now() - config.idleStopMinutes * 60_000
      const stopped: string[] = []
      for (const r of await store.sandboxes.listAll()) {
        if (r.state !== 'running' || starting.has(r.id)) continue
        const last = r.lastUsedAt ?? r.startedAt ?? r.createdAt
        if (last > limit) continue
        try {
          await backend.stop(r.handle)
          await save(r, { state: 'stopped' })
          stopped.push(r.id)
        } catch {
          // Leave it running; the next sweep tries again.
        }
      }
      return stopped
    },

    async reconcile() {
      const managed = await backend.listManaged()
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
        const status = await backend.status(m.handle)
        const handle = { ...r.handle, ...m.handle, provisioned: r.handle.provisioned ?? m.handle.provisioned ?? 'true' }
        await save(r, { handle, state: status === 'running' ? 'running' : r.state === 'deleting' ? 'deleting' : 'stopped' })
        adopted.push(r.id)
      }
      const unknown = managed.filter((m) => !known.has(m.id)).map((m) => m.id)
      return { adopted, missing, unknown }
    },
  }
}
