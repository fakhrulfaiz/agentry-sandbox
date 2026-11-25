/**
 * E2B's hosted sandboxes, driven through E2B's REST API. Every E2B sandbox
 * already runs envd, so this driver only creates, pauses, resumes and kills
 * sandboxes and says where envd answers: E2B's shared sandbox host, with the
 * sandbox id, port and the sandbox's own access token as request headers.
 *
 * Creates use auto-pause: when E2B's timeout runs out the sandbox is paused
 * (files and memory kept), never killed, and the next request resumes it
 * (`status` says `stopped`, the service calls `start`, which connects).
 * `maintain` pushes the timeout out while a sandbox is in use. The access
 * token is kept in the handle under `secret.envdAccessToken`, which the
 * service stores sealed apart from the handle. The API key and the token
 * never appear in an error.
 *
 * Config `{ template, api_url, sandbox_host, timeout_s }`, secrets `{ api_key }`.
 */
import type { TemplateSpec } from '../../store/types.ts'
import { TransientPlaceError, type Driver, type Handle } from '../driver.ts'
import type { DriverFactory } from '../registry.ts'

export interface E2bPlace {
  apiKey: string
  template: string
  apiUrl: string
  sandboxHost: string
  timeoutS: number
}

export interface E2bDeps {
  fetch?: typeof fetch
  /** Wait before the one retry of a pause that answered 503 (default 2000). */
  retryDelayMs?: number
  /** How long a new or resumed sandbox may take to answer on its envd (default 30000). */
  readyTimeoutMs?: number
  /** How long a `running` answer of `status` is trusted (default 15000; 0 asks E2B every time). */
  statusTtlMs?: number
}

const TOKEN = 'secret.envdAccessToken'
const ENVD_PORT = '49983'
const ID_KEY = 'agentry.sandbox.id'
const OWNER_KEY = 'agentry.sandbox.owner'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createE2bDriver(place: E2bPlace, deps: E2bDeps = {}): Driver {
  const doFetch = deps.fetch ?? fetch
  const api = place.apiUrl.replace(/\/+$/u, '')
  const host = place.sandboxHost.replace(/\/+$/u, '')
  const retryDelay = deps.retryDelayMs ?? 2_000
  const readyTimeout = deps.readyTimeoutMs ?? 30_000
  const statusTtl = deps.statusTtlMs ?? 15_000
  /** Sandboxes last seen running, by E2B id, until when. */
  const runningUntil = new Map<string, number>()

  /** Text that is safe to show: neither the API key nor a token. */
  const scrub = (text: string, extra: string[] = []): string => {
    let out = text
    for (const secret of [place.apiKey, ...extra]) if (secret) out = out.split(secret).join('***')
    return out
  }

  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response
    try {
      res = await doFetch(`${api}${path}`, {
        method,
        headers: { 'X-API-Key': place.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (e) {
      throw new TransientPlaceError(scrub(`E2B could not be reached: ${e instanceof Error ? e.message : String(e)}`))
    }
    return res
  }

  async function fail(res: Response, what: string): Promise<never> {
    if (res.status === 429) {
      const after = res.headers.get('retry-after')
      throw new TransientPlaceError(`E2B rate limit; retry after ${after ?? 'a few'} s`)
    }
    if (res.status === 401 || res.status === 403) throw new Error('E2B refused the API key')
    let detail = ''
    try {
      const j = (await res.json()) as { message?: unknown }
      if (typeof j.message === 'string') detail = `: ${scrub(j.message).slice(0, 300)}`
    } catch {
      // No readable body.
    }
    if (res.status >= 500) throw new TransientPlaceError(`E2B is unavailable right now (HTTP ${String(res.status)}) while ${what}; try again shortly`)
    throw new Error(`E2B ${what} failed (HTTP ${String(res.status)})${detail}`)
  }

  const idOf = (handle: Handle): string => {
    const id = handle.e2bId
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error('this sandbox has no E2B sandbox recorded')
    return id
  }

  const envdHeaders = (e2bId: string, token: string): Record<string, string> => ({ 'E2b-Sandbox-Id': e2bId, 'E2b-Sandbox-Port': ENVD_PORT, 'X-Access-Token': token })

  /** Waits until envd answers through the shared host. */
  async function ready(e2bId: string, token: string): Promise<void> {
    const until = Date.now() + readyTimeout
    let last = 'no answer'
    for (;;) {
      try {
        const res = await doFetch(`${host}/health`, { headers: envdHeaders(e2bId, token) })
        if (res.ok) return
        last = `HTTP ${String(res.status)}`
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
      }
      if (Date.now() >= until) throw new Error(scrub(`the E2B sandbox's envd did not answer (${last})`, [token]))
      await sleep(250)
    }
  }

  async function kill(e2bId: string): Promise<void> {
    runningUntil.delete(e2bId)
    const res = await request('DELETE', `/sandboxes/${e2bId}`)
    if (res.ok || res.status === 404) return
    await fail(res, 'deleting the sandbox')
  }

  async function listAll(): Promise<{ sandboxID: string; metadata?: Record<string, string> }[]> {
    const out: { sandboxID: string; metadata?: Record<string, string> }[] = []
    let token: string | null = null
    do {
      const q = new URLSearchParams({ state: 'running,paused', limit: '100' })
      if (token) q.set('nextToken', token)
      const res = await request('GET', `/v2/sandboxes?${q.toString()}`)
      if (!res.ok) await fail(res, 'listing sandboxes')
      out.push(...((await res.json()) as { sandboxID: string; metadata?: Record<string, string> }[]))
      token = res.headers.get('x-next-token')
    } while (token)
    return out
  }

  async function readStatus(e2bId: string): Promise<'running' | 'stopped' | 'missing'> {
    const res = await request('GET', `/sandboxes/${e2bId}`)
    if (res.status === 404) return 'missing'
    if (!res.ok) await fail(res, 'reading the sandbox')
    const body = (await res.json()) as { state?: unknown }
    return body.state === 'running' ? 'running' : 'stopped'
  }

  const driver: Driver = {
    kind: 'e2b',
    capabilities: {
      persistent: true,
      reset: true,
      keepFilesOnReset: false,
      isolated: true,
      network: true,
      resources: false,
      gpu: false,
      envdBuiltIn: true,
      runsAsRoot: true,
      templateFields: ['packages', 'setupCommands', 'env', 'network', 'files'],
    },
    fieldHints: { image: "E2B uses templates; set the place's template" },

    async probe() {
      try {
        const res = await request('GET', '/v2/sandboxes?limit=1')
        if (res.ok) return { ok: true, version: 'E2B' }
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'E2B refused the API key' }
        if (res.status === 429) return { ok: false, reason: 'E2B rate limit; try again shortly' }
        return { ok: false, reason: `E2B answered HTTP ${String(res.status)}` }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },

    async create(id, owner, spec: TemplateSpec) {
      if (spec.image !== undefined) throw new Error("E2B uses templates; set the place's template ('image' is not supported)")
      const res = await request('POST', '/v2/sandboxes', {
        templateID: place.template,
        timeout: place.timeoutS,
        autoPause: true,
        metadata: { [ID_KEY]: id, [OWNER_KEY]: owner },
        ...(spec.env && Object.keys(spec.env).length > 0 ? { envVars: spec.env } : {}),
        allow_internet_access: spec.network !== false,
      })
      if (!res.ok) await fail(res, 'creating the sandbox')
      const made = (await res.json()) as { sandboxID?: unknown; envdAccessToken?: unknown }
      if (typeof made.sandboxID !== 'string' || typeof made.envdAccessToken !== 'string' || !made.envdAccessToken) throw new Error('E2B answered a create without a sandbox id and access token')
      try {
        await ready(made.sandboxID, made.envdAccessToken)
      } catch (e) {
        await kill(made.sandboxID).catch(() => {})
        throw e
      }
      return { e2bId: made.sandboxID, [TOKEN]: made.envdAccessToken }
    },

    async start(_id, handle) {
      const e2bId = idOf(handle)
      const res = await request('POST', `/v2/sandboxes/${e2bId}/connect`, { timeout: place.timeoutS })
      if (res.status === 404) throw new Error('the sandbox no longer exists on E2B')
      if (!res.ok) await fail(res, 'resuming the sandbox')
      const body = (await res.json().catch(() => ({}))) as { envdAccessToken?: unknown }
      const token = typeof body.envdAccessToken === 'string' && body.envdAccessToken ? body.envdAccessToken : handle[TOKEN]
      if (!token) throw new Error('this sandbox has no access token recorded')
      await ready(e2bId, token)
      return { ...handle, [TOKEN]: token }
    },

    async stop(handle) {
      const e2bId = idOf(handle)
      runningUntil.delete(e2bId)
      for (let attempt = 0; ; attempt++) {
        const res = await request('POST', `/sandboxes/${e2bId}/pause`)
        // 409: already paused or pausing. 404: gone, nothing left to pause.
        if (res.ok || res.status === 409 || res.status === 404) return
        if (res.status === 503 && attempt === 0) {
          await sleep(retryDelay)
          continue
        }
        await fail(res, 'pausing the sandbox')
      }
    },

    async destroy(id, handle) {
      if (handle.e2bId) return kill(idOf(handle))
      // A create that failed half-way left no handle: find the sandbox by the id in its metadata.
      for (const s of await listAll()) if (s.metadata?.[ID_KEY] === id) await kill(s.sandboxID)
    },

    async status(handle) {
      if (!handle.e2bId) return 'missing'
      const e2bId = idOf(handle)
      // Every relayed request asks for the status: trust a recent `running` instead of calling E2B each time.
      if ((runningUntil.get(e2bId) ?? 0) > Date.now()) return 'running'
      const s = await readStatus(e2bId)
      if (s === 'running' && statusTtl > 0) runningUntil.set(e2bId, Date.now() + statusTtl)
      else runningUntil.delete(e2bId)
      return s
    },

    async envdEndpoint(handle) {
      const e2bId = idOf(handle)
      const token = handle[TOKEN]
      if (!token) throw new Error('this sandbox has no access token recorded')
      return { baseUrl: host, token, headers: { 'E2b-Sandbox-Id': e2bId, 'E2b-Sandbox-Port': ENVD_PORT } }
    },

    async listManaged() {
      const out: { id: string; owner: string; handle: Handle }[] = []
      for (const s of await listAll()) {
        const id = s.metadata?.[ID_KEY]
        if (id) out.push({ id, owner: s.metadata?.[OWNER_KEY] ?? '', handle: { e2bId: s.sandboxID } })
      }
      return out
    },

    async maintain(_id, handle) {
      // The sweep asks E2B itself: a sandbox E2B paused on its own must not be kept alive from the cache.
      if (!handle.e2bId || (await readStatus(idOf(handle))) !== 'running') return
      const res = await request('POST', `/sandboxes/${idOf(handle)}/timeout`, { timeout: place.timeoutS })
      if (!res.ok && res.status !== 404) await fail(res, 'extending the sandbox timeout')
    },
  }
  return driver
}

const URL_FIELD = (v: unknown, field: string, fallback: string): string => {
  const raw = v === undefined || v === '' ? fallback : v
  if (typeof raw !== 'string') throw new Error(`${field} must be a URL`)
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`${field} must be a URL`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${field} must be an http(s) URL`)
  return raw
}

/** Registry factory for kind `e2b`. */
export function e2bFactory(deps: E2bDeps = {}): DriverFactory {
  return (record, secrets) => {
    const c = record.config
    if (!secrets.api_key) throw new Error('api_key is required')
    const template = c.template === undefined || c.template === '' ? 'base' : c.template
    if (typeof template !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(template)) throw new Error('template must be an E2B template id or name')
    const timeoutS = c.timeout_s === undefined ? 3_600 : c.timeout_s
    if (typeof timeoutS !== 'number' || !Number.isInteger(timeoutS) || timeoutS < 60 || timeoutS > 86_400) throw new Error('timeout_s must be a whole number of seconds between 60 and 86400')
    return createE2bDriver(
      { apiKey: secrets.api_key, template, apiUrl: URL_FIELD(c.api_url, 'api_url', 'https://api.e2b.app'), sandboxHost: URL_FIELD(c.sandbox_host, 'sandbox_host', 'https://sandbox.e2b.app'), timeoutS },
      deps,
    )
  }
}
