/**
 * The Agentry Sandbox client: REST calls for `/v1` and an envd client that
 * goes through the service's relay (the service adds each sandbox's token).
 * Imported by the Agentry API as `@agentry/sandbox/client`.
 */
import { createEnvdClient, type EnvdClient } from '../envd/client.ts'

export { createEnvdClient, type EnvdClient } from '../envd/client.ts'
export { runInEnvd, sq, type RunResult } from '../envd/run.ts'

export interface WireTemplate {
  image?: string
  packages?: string[]
  setup_commands?: string[]
  env?: Record<string, string>
  network?: boolean
  files?: { path: string; content: string }[]
  resources?: { cpus?: number; memory_mb?: number }
  place?: string
  gpus?: number | 'all'
}

/** Where a provisioning sandbox is in its setup; `step`, `steps` and `detail` come with `running_setup` only. */
export interface WireProgress {
  stage: 'pulling_image' | 'starting' | 'preparing' | 'installing_packages' | 'copying_runtime' | 'writing_files' | 'running_setup' | 'finishing'
  step?: number
  steps?: number
  detail?: string
  updated_at: number
}

export interface WireSandbox {
  id: string
  object: 'sandbox'
  name: string
  backend: string
  /** Id of the place the sandbox runs on (same as `backend`). */
  place: string
  gpus: number | 'all'
  state: 'provisioning' | 'running' | 'stopped' | 'failed' | 'deleting'
  template_id: string | null
  image: string
  workspace_path: string
  template: WireTemplate
  error: string | null
  /** Only while `state` is `provisioning`. */
  progress?: WireProgress
  created_at: number
  started_at: number | null
  last_used_at: number | null
}

export interface WireCapabilities {
  persistent: boolean
  reset: boolean
  keepFilesOnReset: boolean
  isolated: boolean
  network: boolean
  resources: boolean
  gpu: boolean
  envdBuiltIn: boolean
  runsAsRoot: boolean
  templateFields: string[]
}

/** One enabled place, default first. */
export interface WireBackend {
  id: string
  name: string
  default: boolean
  gpus?: { count: number; models: string[] }
  kind: string
  available: boolean
  version?: string
  reason?: string
  /** The image sandboxes use when a template names none, and what it ships (when labelled). */
  default_image?: { name: string; runtimes?: Record<string, string>; python_packages?: string[]; tools?: string[] }
  capabilities: WireCapabilities
}

/** Error codes the service answers with (others are possible). */
export type SandboxApiErrorCode = 'unauthorized' | 'owner_required' | 'invalid_request' | 'not_found' | 'sandbox_failed' | 'quota_exceeded' | 'place_unavailable' | 'place_disabled' | 'gpu_unavailable' | 'place_in_use' | 'place_host_key_changed' | 'unreachable' | (string & {})

/** A failed call: the service's `{ error: { code, message } }`, or `unreachable` when it did not answer. */
export class SandboxApiError extends Error {
  constructor(readonly status: number, readonly code: SandboxApiErrorCode, message: string) {
    super(message)
    this.name = 'SandboxApiError'
  }
}

export interface SandboxApi {
  backends(): Promise<WireBackend[]>
  list(): Promise<WireSandbox[]>
  get(id: string): Promise<WireSandbox>
  create(body: { name: string; template_id?: string; template?: WireTemplate; workspace_path?: string; place?: string }): Promise<WireSandbox>
  start(id: string): Promise<WireSandbox>
  stop(id: string): Promise<WireSandbox>
  reset(id: string, opts: { keepWorkspace: boolean }): Promise<WireSandbox>
  remove(id: string): Promise<void>
  /** envd for one sandbox, through the relay; calls choose their user with `userHeaders(user)`. */
  envd(id: string): EnvdClient
}

export function createSandboxApi(opts: { url: string; key: string; owner: string; fetch?: typeof fetch; timeoutMs?: number }): SandboxApi {
  const base = opts.url.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? fetch
  const auth = { Authorization: `Bearer ${opts.key}`, 'X-Agentry-Owner': opts.owner }
  const seg = encodeURIComponent

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      })
    } catch (e) {
      throw new SandboxApiError(0, 'unreachable', `Agentry Sandbox is not reachable: ${(e as Error).message}`)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error
      throw new SandboxApiError(res.status, err?.code ?? 'error', err?.message ?? `Agentry Sandbox answered ${String(res.status)}`)
    }
    return json as T
  }

  return {
    backends: async () => (await call<{ data: WireBackend[] }>('GET', '/v1/backends')).data,
    list: async () => (await call<{ data: WireSandbox[] }>('GET', '/v1/sandboxes')).data,
    get: (id) => call('GET', `/v1/sandboxes/${seg(id)}`),
    create: (body) => call('POST', '/v1/sandboxes', body),
    start: (id) => call('POST', `/v1/sandboxes/${seg(id)}/start`),
    stop: (id) => call('POST', `/v1/sandboxes/${seg(id)}/stop`),
    reset: (id, { keepWorkspace }) => call('POST', `/v1/sandboxes/${seg(id)}/reset`, { keep_workspace: keepWorkspace }),
    remove: (id) => call('DELETE', `/v1/sandboxes/${seg(id)}`),
    envd: (id) => createEnvdClient({ baseUrl: `${base}/v1/sandboxes/${seg(id)}/envd`, accessToken: '', headers: auth, userVia: 'header', fetch: doFetch }),
  }
}
