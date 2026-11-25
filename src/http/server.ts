/**
 * The Agentry Sandbox HTTP API (`/v1`). Every route but `/v1/health` needs
 * `Authorization: Bearer <key>` (checked against SHA-256 hashes) and
 * `X-Agentry-Owner`; records are owner-scoped, and another owner's id is a
 * 404 like a missing one. Errors are `{ error: { code, message } }`. The wire
 * format is snake_case with times in epoch seconds.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openSecrets, sealSecrets } from '../crypto/secrets.ts'
import { HostKeyChangedError, type Driver } from '../places/driver.ts'
import { LOCAL_PLACE_ID, type PlaceRegistry, type ProbeResult } from '../places/registry.ts'
import type { SandboxConfig } from '../config.ts'
import { GpuUnavailableError, LimitError, NotFoundError, PlaceDisabledError, PlaceUnavailableError, QuotaExceededError, type SandboxService } from '../sandboxes.ts'
import type { GpuInfo, PlaceRecord, SandboxRecord, Store, TemplateRecord, TemplateSpec } from '../store/types.ts'
import { relay } from './relay.ts'

class PlaceInUseError extends Error {
  constructor(placeName: string, count: number) {
    super(`Place '${placeName}' still has ${String(count)} sandbox${count === 1 ? '' : 'es'}; delete them first`)
  }
}

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
  if (t.place !== undefined) out.place = t.place
  if (t.gpus !== undefined) out.gpus = t.gpus
  if (t.resources !== undefined) out.resources = { ...(t.resources.cpus !== undefined ? { cpus: t.resources.cpus } : {}), ...(t.resources.memoryMb !== undefined ? { memory_mb: t.resources.memoryMb } : {}) }
  return out
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function placeIdFromWire(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 100) throw invalid(`${field} must be a place id`)
  return v
}
function gpusFromWire(v: unknown, field: string): number | 'all' {
  if (v === 'all' || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 64)) return v
  throw invalid(`${field} must be a whole number of GPUs or "all"`)
}

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
  if (w.place !== undefined) t.place = placeIdFromWire(w.place, 'template.place')
  if (w.gpus !== undefined) t.gpus = gpusFromWire(w.gpus, 'template.gpus')
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

/** System and Agentry directories a workspace volume must not shadow. */
const RESERVED_PATHS = ['/opt/agentry', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/run', '/var/run', '/var/lib']
const WORKSPACE_PATH = /^(\/[A-Za-z0-9._-]+)+$/
function workspacePathFromWire(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !WORKSPACE_PATH.test(v) || v.split('/').some((seg) => seg === '.' || seg === '..') || v.length > 200) {
    throw invalid('workspace_path must be a clean absolute path such as /workspace')
  }
  if (RESERVED_PATHS.some((r) => v === r || v.startsWith(`${r}/`))) throw invalid(`workspace_path must not be inside ${v.split('/').slice(0, 3).join('/')}, which the sandbox image needs`)
  return v
}

const sandboxToWire = (r: SandboxRecord, defaultImage: string) => ({
  id: r.id,
  object: 'sandbox',
  name: r.name,
  backend: r.backend,
  place: r.backend,
  gpus: r.template.gpus ?? 0,
  state: r.state,
  template_id: r.templateId,
  image: r.template.image ?? defaultImage,
  workspace_path: r.template.workspacePath ?? '/workspace',
  template: templateToWire(r.template),
  error: r.error,
  created_at: sec(r.createdAt),
  started_at: sec(r.startedAt),
  last_used_at: sec(r.lastUsedAt),
})

const templateRecordToWire = (t: TemplateRecord) => ({ id: t.id, object: 'template', name: t.name, spec: templateToWire(t.spec), created_at: sec(t.createdAt), updated_at: sec(t.updatedAt) })

const gpusWire = (gpus: GpuInfo[] | undefined) => ({ count: gpus?.length ?? 0, models: [...new Set((gpus ?? []).map((g) => g.name))] })
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/

const list = <T>(data: T[]) => ({ object: 'list', data })

/** The admin page (one HTML file, no build), read once at startup. */
function loadAdminPage(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../admin/index.html', import.meta.url)), 'utf8')
  } catch {
    return ADMIN_OFF_PAGE
  }
}
const ADMIN_OFF_PAGE = '<!doctype html><meta charset="utf-8"><title>Agentry Sandbox</title><p style="font:16px system-ui;margin:3rem">The admin page is off. Set <code>AGENTRY_SANDBOX_ADMIN_KEYS</code> and restart the service.</p>'

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
  { method: 'GET', openapi: '/v1/admin/places' },
  { method: 'POST', openapi: '/v1/admin/places' },
  { method: 'POST', openapi: '/v1/admin/places/test' },
  { method: 'PUT', openapi: '/v1/admin/places/{id}' },
  { method: 'DELETE', openapi: '/v1/admin/places/{id}' },
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

export function createServer(deps: { config: SandboxConfig; service: SandboxService; store: Store; places: PlaceRegistry }): http.Server {
  const { config, service, store, places } = deps
  /** The default place's driver, as the "backend" the admin overview describes. */
  const backendOf = async () => {
    const place = places.default()
    const { driver } = place
    const { gpus: _g, ...av } = await place.probe()
    return { kind: driver.kind, capabilities: driver.capabilities, available: av, describeImage: driver.describeImage?.bind(driver) }
  }
  const keyHashes = config.apiKeyHashes.map((k) => Buffer.from(k.slice('sha256:'.length), 'hex'))
  const adminHashes = config.adminKeyHashes.map((k) => Buffer.from(k.slice('sha256:'.length), 'hex'))
  const adminPage = loadAdminPage()

  /** The admin surface takes only admin keys; an API key is refused there (and an admin key is refused on /v1). */
  function adminAuthorized(req: http.IncomingMessage): boolean {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (!m) return false
    const digest = createHash('sha256').update(m[1]!).digest()
    return adminHashes.some((h) => h.length === digest.length && timingSafeEqual(h, digest))
  }

  const probeOf = async (driver: Driver) => {
    try {
      return await driver.probe()
    } catch (e) {
      return { ok: false as const, reason: e instanceof Error ? e.message : String(e), gpus: undefined }
    }
  }

  /** Builds a driver from request fields; a bad kind or config answers 400. */
  function buildDriver(kind: string, cfg: Record<string, unknown>, secrets: Record<string, string>, forTest = false): Driver {
    const record: PlaceRecord = { id: 'candidate', name: 'candidate', kind, config: cfg, secrets: null, enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: 0, updatedAt: 0 }
    try {
      return places.makeDriver(record, secrets, forTest ? { forTest: true } : undefined)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw invalid(/unknown place kind/.test(msg) ? 'unknown place kind' : msg)
    }
  }
  const objectField = (v: unknown, field: string): Record<string, unknown> => {
    if (v === undefined) return {}
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid(`${field} must be an object`)
    return v as Record<string, unknown>
  }
  const secretsField = (v: unknown): Record<string, string> => {
    const o = objectField(v, 'secrets')
    if (Object.values(o).some((x) => typeof x !== 'string')) throw invalid('secrets must map names to strings')
    return o as Record<string, string>
  }
  const hostKeyField = (v: unknown): string => {
    if (typeof v !== 'string' || !HOST_KEY.test(v)) throw invalid('host_key must look like SHA256:<base64>')
    return v
  }
  const maxRunningField = (v: unknown): number | null => {
    if (v === null) return null
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw invalid('max_running must be a whole number or null')
    return v
  }

  async function adminPlaces() {
    const records = new Map((await store.places.list()).map((r) => [r.id, r]))
    const all = await service.listEverything()
    const live = places.list()
    const view = async (p: { id: string; name: string; kind: string; enabled: boolean; isDefault: boolean; maxRunning: number | null; probe?: () => Promise<ProbeResult>; gpus: GpuInfo[] }) => {
      const rec = records.get(p.id)
      const probed = p.probe ? await p.probe() : { ok: false as const, reason: 'This place could not be set up (unknown kind or unreadable credentials).', gpus: undefined }
      return {
        id: p.id, name: p.name, kind: p.kind, enabled: p.enabled, default: p.isDefault, max_running: p.maxRunning,
        config: p.id === LOCAL_PLACE_ID ? {} : rec?.config ?? {}, has_secrets: rec?.secrets != null,
        available: probed.ok, ...(probed.ok ? {} : { reason: probed.reason }),
        gpus: gpusWire(probed.ok && probed.gpus && probed.gpus.length > 0 ? probed.gpus : p.gpus), sandboxes: all.filter((r) => r.backend === p.id).length,
      }
    }
    const out = await Promise.all(live.map((p) => view(p)))
    const missing = [...records.values()].filter((r) => !live.some((p) => p.id === r.id))
    for (const r of missing) out.push(await view({ id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, isDefault: false, maxRunning: r.maxRunning, gpus: r.gpus ?? [] }))
    return out
  }

  async function dispatchPlaces(method: string, id: string | undefined, body: () => Promise<Record<string, unknown>>): Promise<{ status: number; body?: unknown }> {
    if (!id && method === 'GET') return { status: 200, body: { data: await adminPlaces() } }
    const viewOne = async (pid: string) => (await adminPlaces()).find((p) => p.id === pid)
    if (id === 'test' && method === 'POST') {
      const b = await body()
      if (typeof b.kind !== 'string') throw invalid('kind is required')
      const cfg = { ...objectField(b.config, 'config') }
      delete cfg.host_key // connect without trusting a key; the fingerprint seen is returned
      const driver = buildDriver(b.kind, cfg, secretsField(b.secrets), true)
      try {
        // Reachability only: nothing runs on a machine whose key is not yet confirmed (no GPU discovery, no pulls).
        const probed = await probeOf(driver)
        const hostKey = driver.observedHostKey?.()
        return { status: 200, body: { ok: probed.ok, ...(probed.ok ? {} : { reason: probed.reason }), ...(hostKey ? { host_key: hostKey } : {}), ...(probed.ok && probed.gpus && probed.gpus.length > 0 ? { gpus: gpusWire(probed.gpus) } : {}) } }
      } finally {
        await driver.close?.().catch(() => {})
      }
    }
    if (!id && method === 'POST') {
      const b = await body()
      const pname = name(b)
      if (typeof b.kind !== 'string' || !b.kind) throw invalid('kind is required')
      if (b.kind === 'docker') throw invalid('the local Docker place is built in')
      const cfg = { ...objectField(b.config, 'config') }
      if (b.host_key !== undefined) cfg.host_key = hostKeyField(b.host_key)
      if ((b.kind === 'docker-ssh' || b.kind === 'ssh-machine') && !cfg.host_key) throw invalid('host_key is required: test the connection and confirm the host key first')
      const secrets = secretsField(b.secrets)
      const driver = buildDriver(b.kind, cfg, secrets)
      let gpus: GpuInfo[] | null = null
      try {
        // GPUs are looked for once, now that the host key is pinned, and stored.
        const found = (await driver.discoverGpus?.().catch(() => undefined)) ?? []
        if (found.length > 0) gpus = found
      } finally {
        await driver.close?.().catch(() => {})
      }
      const t = Date.now()
      const rec: PlaceRecord = {
        id: `place_${randomBytes(8).toString('hex')}`, name: pname, kind: b.kind, config: cfg,
        secrets: Object.keys(secrets).length > 0 ? sealSecrets(config.secret, secrets) : null,
        enabled: b.enabled === undefined ? true : b.enabled === true, isDefault: false,
        maxRunning: b.max_running === undefined ? null : maxRunningField(b.max_running), gpus, createdAt: t, updatedAt: t,
      }
      await store.places.insert(rec)
      await places.reload()
      return { status: 201, body: await viewOne(rec.id) }
    }
    if (id && id !== 'test' && method === 'PUT') {
      const b = await body()
      let rec = await store.places.get(id)
      if (!rec && id === LOCAL_PLACE_ID) {
        const t = Date.now()
        rec = { id, name: places.get(id)?.name ?? 'Local Docker', kind: 'docker', config: {}, secrets: null, enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: t, updatedAt: t }
        await store.places.insert(rec)
      }
      if (!rec) throw new NotFoundError(`place ${id} not found`)
      const isLocal = id === LOCAL_PLACE_ID
      const patch: Record<string, unknown> = { updatedAt: Date.now() }
      if (b.name !== undefined) patch.name = name(b)
      if (b.max_running !== undefined) patch.maxRunning = maxRunningField(b.max_running)
      if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') throw invalid('enabled must be true or false')
        if (!b.enabled && places.get(id)?.isDefault) throw invalid('make another place the default before disabling this one')
        patch.enabled = b.enabled
      }
      if (b.default !== undefined) {
        if (b.default !== true) throw invalid('default can only be set to true (make another place the default instead)')
        if (!(b.enabled ?? rec.enabled)) throw new PlaceDisabledError(rec.name)
        patch.isDefault = true
      }
      if (b.config !== undefined || b.secrets !== undefined || b.host_key !== undefined) {
        if (isLocal) throw invalid('the local Docker place has no connection settings')
        const cfg = b.config !== undefined ? { ...objectField(b.config, 'config') } : { ...rec.config }
        if (b.host_key !== undefined) cfg.host_key = hostKeyField(b.host_key)
        // A save that leaves the key out keeps the pinned one; a remote place never ends up unpinned.
        if (cfg.host_key === undefined && rec.config.host_key !== undefined) cfg.host_key = rec.config.host_key
        if ((rec.kind === 'docker-ssh' || rec.kind === 'ssh-machine') && !cfg.host_key) throw invalid('host_key is required: test the connection and confirm the host key first')
        const secrets = b.secrets !== undefined ? secretsField(b.secrets) : undefined
        const effective = secrets ?? (rec.secrets ? openSecrets(config.secret, rec.secrets) : {})
        const candidate = buildDriver(rec.kind, cfg, effective)
        try {
          const found = (await candidate.discoverGpus?.().catch(() => undefined)) ?? []
          if (found.length > 0) patch.gpus = found
        } finally {
          await candidate.close?.().catch(() => {})
        }
        patch.config = cfg
        if (secrets) patch.secrets = Object.keys(secrets).length > 0 ? sealSecrets(config.secret, secrets) : null
      }
      await store.places.update(id, patch)
      await places.reload()
      return { status: 200, body: await viewOne(id) }
    }
    if (id && id !== 'test' && method === 'DELETE') {
      if (id === LOCAL_PLACE_ID) throw invalid('the local Docker place cannot be deleted')
      const rec = await store.places.get(id)
      if (!rec) throw new NotFoundError(`place ${id} not found`)
      const n = (await service.listEverything()).filter((r) => r.backend === id).length
      if (n > 0) throw new PlaceInUseError(rec.name, n)
      await store.places.delete(id)
      await places.reload()
      return { status: 200, body: { id, object: 'place.deleted', deleted: true } }
    }
    throw new HttpError(404, 'not_found', 'route not found')
  }

  /** `/v1/admin/...`: every owner's sandboxes, the service overview and the live limits. */
  async function dispatchAdmin(method: string, path: string, body: () => Promise<Record<string, unknown>>, query: URLSearchParams): Promise<{ status: number; body?: unknown }> {
    const [, , , a, id, action] = path.split('/')
    if (a === 'overview' && !id && method === 'GET') {
      const backend = await backendOf()
      const av = backend.available
      const info = av.ok && backend.describeImage ? await backend.describeImage(config.defaultImage) : undefined
      const all = await service.listEverything()
      const count = (state: string) => all.filter((r) => r.state === state).length
      return { status: 200, body: {
        backend: { kind: backend.kind, available: av.ok, ...(av.ok ? { version: av.version } : { reason: av.reason }), default_image: { name: config.defaultImage, ...(info ?? {}) } },
        config: {
          envd_reach: config.envdReach, runtime: config.runtime, egress: config.egress, idle_stop_minutes: config.idleStopMinutes,
          default_resources: { cpus: config.resources.cpus, memory_mb: Math.round(config.resources.memoryBytes / 1024 / 1024), pids: config.resources.pids },
        },
        counts: { total: all.length, running: count('running'), stopped: count('stopped'), provisioning: count('provisioning'), failed: count('failed'), owners: new Set(all.map((r) => r.owner)).size },
      } }
    }
    if (a === 'sandboxes') {
      if (!id && method === 'GET') return { status: 200, body: list((await service.listEverything()).map((r) => ({ ...sandboxToWire(r, config.defaultImage), owner: r.owner }))) }
      const owner = id ? await service.ownerOf(id) : undefined
      if (!id || owner === undefined) throw new NotFoundError(`sandbox ${id ?? ''} not found`)
      if (!action && method === 'DELETE') {
        await service.destroy(owner, id, { force: query.get('force') === 'true' })
        return { status: 200, body: { id, object: 'sandbox.deleted', deleted: true } }
      }
      if (action === 'start' && method === 'POST') return { status: 200, body: { ...sandboxToWire(await service.start(owner, id), config.defaultImage), owner } }
      if (action === 'stop' && method === 'POST') return { status: 200, body: { ...sandboxToWire(await service.stop(owner, id), config.defaultImage), owner } }
    }
    if (a === 'places') return dispatchPlaces(method, id, body)
    if (a === 'limits' && !id) {
      const view = () => ({ limits: service.limits(), defaults: config.limits, overrides: service.limitOverrides() })
      if (method === 'GET') return { status: 200, body: view() }
      if (method === 'PUT') {
        const b = await body()
        await service.setLimits((b.overrides ?? {}) as Record<string, never>)
        return { status: 200, body: view() }
      }
      if (method === 'DELETE') {
        await service.setLimits(null)
        return { status: 200, body: view() }
      }
    }
    throw new HttpError(404, 'not_found', 'route not found')
  }

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
      const out = await Promise.all(places.list().filter((p) => p.enabled).map(async (p) => {
        const probed = await p.probe()
        const info = probed.ok && p.driver.describeImage ? await p.driver.describeImage(config.defaultImage).catch(() => undefined) : undefined
        const gpus = probed.ok && probed.gpus && probed.gpus.length > 0 ? probed.gpus : p.gpus
        return {
          id: p.id, name: p.name, default: p.isDefault, kind: p.kind, available: probed.ok, ...(probed.ok ? { version: probed.version } : { reason: probed.reason }),
          ...(gpus.length > 0 ? { gpus: gpusWire(gpus) } : {}), capabilities: p.driver.capabilities,
          default_image: { name: config.defaultImage, ...(info ?? {}) },
        }
      }))
      return { status: 200, body: list(out) }
    }
    if (a === 'sandboxes') {
      if (!id) {
        if (method === 'GET') return { status: 200, body: list((await service.list(ctx.owner)).map((r) => sandboxToWire(r, config.defaultImage))) }
        if (method === 'POST') {
          const body = await ctx.body()
          const templateId = body.template_id
          if (templateId !== undefined && typeof templateId !== 'string') throw invalid('template_id must be a string')
          const workspacePath = workspacePathFromWire(body.workspace_path)
          const template = { ...templateFromWire(body.template), ...(workspacePath ? { workspacePath } : {}) }
          const place = body.place === undefined ? undefined : placeIdFromWire(body.place, 'place')
          const r = await service.create(ctx.owner, { name: name(body), ...(templateId ? { templateId } : {}), ...(place ? { place } : {}), template })
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
        if ((url.pathname === '/admin' || url.pathname === '/admin/') && method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" })
          res.end(adminHashes.length > 0 ? adminPage : ADMIN_OFF_PAGE)
          return
        }
        if (url.pathname.startsWith('/v1/admin/')) {
          if (adminHashes.length === 0) return fail(res, 404, 'not_found', 'the admin surface is off (set AGENTRY_SANDBOX_ADMIN_KEYS)')
          if (!adminAuthorized(req)) return fail(res, 401, 'unauthorized', 'a valid admin key is required')
          let adminBody: Promise<Record<string, unknown>> | undefined
          const result = await dispatchAdmin(method, url.pathname, () => (adminBody ??= readJson(req)), url.searchParams)
          return send(res, result.status, result.body)
        }
        if (!authorized(req)) return fail(res, 401, 'unauthorized', 'a valid API key is required')
        const owner = req.headers['x-agentry-owner']
        if (typeof owner !== 'string' || !owner.trim()) return fail(res, 400, 'owner_required', 'X-Agentry-Owner is required')
        let parsed: Promise<Record<string, unknown>> | undefined
        const result = await dispatch(method, url.pathname, { owner: owner.trim(), body: () => (parsed ??= readJson(req)), req, res })
        if (result !== 'handled') send(res, result.status, result.body)
      } catch (e) {
        if (e instanceof HttpError) return fail(res, e.status, e.code, e.message)
        if (e instanceof NotFoundError) return fail(res, 404, 'not_found', e.message)
        if (e instanceof PlaceUnavailableError) return fail(res, 503, 'place_unavailable', e.message)
        if (e instanceof HostKeyChangedError) return fail(res, 409, 'place_host_key_changed', e.message)
        if (e instanceof PlaceInUseError) return fail(res, 409, 'place_in_use', e.message)
        if (e instanceof PlaceDisabledError) return fail(res, 409, 'place_disabled', e.message)
        if (e instanceof GpuUnavailableError) return fail(res, 409, 'gpu_unavailable', e.message)
        if (e instanceof QuotaExceededError) return fail(res, 429, 'quota_exceeded', e.message)
        if (e instanceof LimitError) return fail(res, 400, 'invalid_request', e.message)
        const msg = e instanceof Error ? e.message : String(e)
        if (/sandbox/.test(url.pathname)) return fail(res, 409, 'sandbox_failed', msg)
        fail(res, 500, 'internal', msg)
      }
    })()
  })
}
