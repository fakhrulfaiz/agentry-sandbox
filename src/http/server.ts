/**
 * The Agentry Sandbox HTTP API (`/v1`). Every route but `/v1/health` needs
 * `Authorization: Bearer <key>` (checked against SHA-256 hashes) and
 * `X-Agentry-Owner`; records are owner-scoped, and another owner's id is a
 * 404 like a missing one. Errors are `{ error: { code, message } }`. The wire
 * format is snake_case with times in epoch seconds.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { Backend } from '../backends/types.ts'
import type { SandboxConfig } from '../config.ts'
import { BackendUnavailableError, NotFoundError, type SandboxService } from '../sandboxes.ts'
import type { SandboxRecord, Store, TemplateRecord, TemplateSpec } from '../store/types.ts'
import { relay } from './relay.ts'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}
const invalid = (message: string) => new HttpError(400, 'invalid_request', message)

// ---- wire format ---------------------------------------------------------

const sec = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000))

function templateToWire(t: TemplateSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (t.image !== undefined) out.image = t.image
  if (t.packages !== undefined) out.packages = t.packages
  if (t.setupCommands !== undefined) out.setup_commands = t.setupCommands
  if (t.env !== undefined) out.env = t.env
  if (t.network !== undefined) out.network = t.network
  if (t.files !== undefined) out.files = t.files
  if (t.resources !== undefined) out.resources = { ...(t.resources.cpus !== undefined ? { cpus: t.resources.cpus } : {}), ...(t.resources.memoryMb !== undefined ? { memory_mb: t.resources.memoryMb } : {}) }
  return out
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validates a wire template; throws 400 on anything malformed. */
export function templateFromWire(v: unknown): TemplateSpec {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('template must be an object')
  const w = v as Record<string, unknown>
  const t: TemplateSpec = {}
  if (w.image !== undefined) {
    if (typeof w.image !== 'string' || !w.image.trim() || /\s/.test(w.image)) throw invalid('template.image must be an image reference')
    t.image = w.image
  }
  if (w.packages !== undefined) {
    if (!isStringArray(w.packages) || w.packages.some((p) => !/^[A-Za-z0-9][A-Za-z0-9.+:_=~-]*$/.test(p))) throw invalid('template.packages must be a list of package names')
    t.packages = w.packages
  }
  if (w.setup_commands !== undefined) {
    if (!isStringArray(w.setup_commands)) throw invalid('template.setup_commands must be a list of strings')
    t.setupCommands = w.setup_commands
  }
  if (w.env !== undefined) {
    if (typeof w.env !== 'object' || w.env === null || Array.isArray(w.env)) throw invalid('template.env must be an object')
    const env = w.env as Record<string, unknown>
    for (const [k, val] of Object.entries(env)) if (!ENV_KEY.test(k) || typeof val !== 'string') throw invalid(`template.env.${k} is not a valid variable`)
    t.env = env as Record<string, string>
  }
  if (w.network !== undefined) {
    if (typeof w.network !== 'boolean') throw invalid('template.network must be true or false')
    t.network = w.network
  }
  if (w.files !== undefined) {
    if (!Array.isArray(w.files) || !w.files.every((f) => f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string' && typeof (f as { content?: unknown }).content === 'string')) {
      throw invalid('template.files must be a list of { path, content }')
    }
    const files = w.files as { path: string; content: string }[]
    if (files.some((f) => !f.path || f.path.includes('\0'))) throw invalid('template.files paths must be non-empty')
    t.files = files.map((f) => ({ path: f.path, content: f.content }))
  }
  if (w.resources !== undefined) {
    const r = w.resources as Record<string, unknown> | null
    if (!r || typeof r !== 'object') throw invalid('template.resources must be an object')
    const res: NonNullable<TemplateSpec['resources']> = {}
    if (r.cpus !== undefined) {
      if (typeof r.cpus !== 'number' || r.cpus < 0.1 || r.cpus > 64) throw invalid('template.resources.cpus must be between 0.1 and 64')
      res.cpus = r.cpus
    }
    if (r.memory_mb !== undefined) {
      if (typeof r.memory_mb !== 'number' || !Number.isInteger(r.memory_mb) || r.memory_mb < 128 || r.memory_mb > 262_144) throw invalid('template.resources.memory_mb must be an integer between 128 and 262144')
      res.memoryMb = r.memory_mb
    }
    t.resources = res
  }
  return t
}

const sandboxToWire = (r: SandboxRecord, defaultImage: string) => ({
  id: r.id,
  object: 'sandbox',
  name: r.name,
  backend: r.backend,
  state: r.state,
  template_id: r.templateId,
  image: r.template.image ?? defaultImage,
  template: templateToWire(r.template),
  error: r.error,
  created_at: sec(r.createdAt),
  started_at: sec(r.startedAt),
  last_used_at: sec(r.lastUsedAt),
})

const templateRecordToWire = (t: TemplateRecord) => ({ id: t.id, object: 'template', name: t.name, spec: templateToWire(t.spec), created_at: sec(t.createdAt), updated_at: sec(t.updatedAt) })

const list = <T>(data: T[]) => ({ object: 'list', data })

// ---- routing -------------------------------------------------------------

interface Ctx {
  owner: string
  body: () => Promise<Record<string, unknown>>
  req: http.IncomingMessage
  res: http.ServerResponse
}
type Result = { status: number; body?: unknown } | 'handled'
interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path as OpenAPI writes it, e.g. `/v1/sandboxes/{id}`. */
  openapi: string
}

/** Every route; the OpenAPI drift test compares this list with `openapi/agentry-sandbox.yaml`. */
export const ROUTES: Route[] = [
  { method: 'GET', openapi: '/v1/health' },
  { method: 'GET', openapi: '/v1/backends' },
  { method: 'POST', openapi: '/v1/sandboxes' },
  { method: 'GET', openapi: '/v1/sandboxes' },
  { method: 'GET', openapi: '/v1/sandboxes/{id}' },
  { method: 'DELETE', openapi: '/v1/sandboxes/{id}' },
  { method: 'POST', openapi: '/v1/sandboxes/{id}/start' },
  { method: 'POST', openapi: '/v1/sandboxes/{id}/stop' },
  { method: 'POST', openapi: '/v1/sandboxes/{id}/reset' },
  { method: 'GET', openapi: '/v1/sandboxes/{id}/envd/{path}' },
  { method: 'POST', openapi: '/v1/sandboxes/{id}/envd/{path}' },
  { method: 'POST', openapi: '/v1/templates' },
  { method: 'GET', openapi: '/v1/templates' },
  { method: 'GET', openapi: '/v1/templates/{id}' },
  { method: 'PUT', openapi: '/v1/templates/{id}' },
  { method: 'DELETE', openapi: '/v1/templates/{id}' },
]

const MAX_BODY = 1024 * 1024

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'invalid_request', 'body is larger than 1 MiB')
    parts.push(chunk)
  }
  if (size === 0) return {}
  try {
    const v = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object')
    return v as Record<string, unknown>
  } catch {
    throw invalid('body must be a JSON object')
  }
}

export function createServer(deps: { config: SandboxConfig; service: SandboxService; store: Store; backend: Backend }): http.Server {
  const { config, service, store, backend } = deps
  const keyHashes = config.apiKeyHashes.map((k) => Buffer.from(k.slice('sha256:'.length), 'hex'))

  function authorized(req: http.IncomingMessage): boolean {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (!m) return false
    const digest = createHash('sha256').update(m[1]!).digest()
    return keyHashes.some((h) => h.length === digest.length && timingSafeEqual(h, digest))
  }

  const name = (body: Record<string, unknown>): string => {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) throw invalid('name is required (1-200 characters)')
    return body.name.trim()
  }

  async function dispatch(method: string, path: string, ctx: Ctx): Promise<Result> {
    const seg = path.split('/').filter(Boolean)
    if (seg[0] !== 'v1') throw new HttpError(404, 'not_found', 'route not found')
    const [, a, id, action, ...rest] = seg
    if (a === 'backends' && !id && method === 'GET') {
      const av = await backend.available()
      return { status: 200, body: list([{ kind: backend.kind, available: av.ok, ...(av.ok ? { version: av.version } : { reason: av.reason }), capabilities: backend.capabilities }]) }
    }
    if (a === 'sandboxes') {
      if (!id) {
        if (method === 'GET') return { status: 200, body: list((await service.list(ctx.owner)).map((r) => sandboxToWire(r, config.defaultImage))) }
        if (method === 'POST') {
          const body = await ctx.body()
          const templateId = body.template_id
          if (templateId !== undefined && typeof templateId !== 'string') throw invalid('template_id must be a string')
          const r = await service.create(ctx.owner, { name: name(body), ...(templateId ? { templateId } : {}), template: templateFromWire(body.template) })
          return { status: 201, body: sandboxToWire(r, config.defaultImage) }
        }
      } else if (!action) {
        if (method === 'GET') return { status: 200, body: sandboxToWire(await service.get(ctx.owner, id), config.defaultImage) }
        if (method === 'DELETE') {
          await service.destroy(ctx.owner, id)
          return { status: 204 }
        }
      } else if (action === 'envd') {
        await relay(service, ctx.owner, id, rest.join('/'), ctx.req, ctx.res)
        return 'handled'
      } else if (method === 'POST' && (action === 'start' || action === 'stop' || action === 'reset') && rest.length === 0) {
        if (action === 'start') return { status: 200, body: sandboxToWire(await service.start(ctx.owner, id), config.defaultImage) }
        if (action === 'stop') return { status: 200, body: sandboxToWire(await service.stop(ctx.owner, id), config.defaultImage) }
        const body = await ctx.body()
        if (body.keep_workspace !== undefined && typeof body.keep_workspace !== 'boolean') throw invalid('keep_workspace must be true or false')
        return { status: 200, body: sandboxToWire(await service.reset(ctx.owner, id, { keepWorkspace: body.keep_workspace !== false }), config.defaultImage) }
      }
    }
    if (a === 'templates' && !action) {
      if (!id) {
        if (method === 'GET') return { status: 200, body: list((await store.templates.list(ctx.owner)).map(templateRecordToWire)) }
        if (method === 'POST') {
          const body = await ctx.body()
          const t = Date.now()
          const record: TemplateRecord = { id: `tpl_${randomBytes(16).toString('hex')}`, owner: ctx.owner, name: name(body), spec: templateFromWire(body.spec), createdAt: t, updatedAt: t }
          await store.templates.insert(record)
          return { status: 201, body: templateRecordToWire(record) }
        }
      } else {
        if (method === 'GET') {
          const t = await store.templates.get(id, ctx.owner)
          if (!t) throw new NotFoundError('template')
          return { status: 200, body: templateRecordToWire(t) }
        }
        if (method === 'PUT') {
          const body = await ctx.body()
          const patch = { ...(body.name !== undefined ? { name: name(body) } : {}), ...(body.spec !== undefined ? { spec: templateFromWire(body.spec) } : {}), updatedAt: Date.now() }
          const t = await store.templates.update(id, ctx.owner, patch)
          if (!t) throw new NotFoundError('template')
          return { status: 200, body: templateRecordToWire(t) }
        }
        if (method === 'DELETE') {
          if (!(await store.templates.delete(id, ctx.owner))) throw new NotFoundError('template')
          return { status: 204 }
        }
      }
    }
    throw new HttpError(404, 'not_found', 'route not found')
  }

  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    if (res.headersSent) return
    if (body === undefined) {
      res.writeHead(status)
      res.end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: http.ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } })

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      try {
        if (url.pathname === '/v1/health' && method === 'GET') return send(res, 200, { ok: true })
        if (!authorized(req)) return fail(res, 401, 'unauthorized', 'a valid API key is required')
        const owner = req.headers['x-agentry-owner']
        if (typeof owner !== 'string' || !owner.trim()) return fail(res, 400, 'owner_required', 'X-Agentry-Owner is required')
        let parsed: Promise<Record<string, unknown>> | undefined
        const result = await dispatch(method, url.pathname, { owner: owner.trim(), body: () => (parsed ??= readJson(req)), req, res })
        if (result !== 'handled') send(res, result.status, result.body)
      } catch (e) {
        if (e instanceof HttpError) return fail(res, e.status, e.code, e.message)
        if (e instanceof NotFoundError) return fail(res, 404, 'not_found', e.message)
        if (e instanceof BackendUnavailableError) return fail(res, 503, 'backend_unavailable', e.message)
        const msg = e instanceof Error ? e.message : String(e)
        if (/sandbox/.test(url.pathname)) return fail(res, 409, 'sandbox_failed', msg)
        fail(res, 500, 'internal', msg)
      }
    })()
  })
}
