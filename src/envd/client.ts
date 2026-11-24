/**
 * A client for E2B's envd: Connect-RPC `process` and `filesystem` services plus
 * the REST `/health`, `/init` and `/files` endpoints. Every call carries
 * `X-Access-Token`; the Unix user of a call is chosen with `userHeaders(user)`
 * (envd reads it from HTTP Basic auth, as the E2B SDK sends it).
 */
import { createClient, type Client, type Interceptor } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { Filesystem } from './gen/filesystem/filesystem_pb.js'
import { Process } from './gen/process/process_pb.js'

export interface EnvdInit {
  accessToken: string
  defaultUser: string
  defaultWorkdir: string
  envVars?: Record<string, string>
}

export interface EnvdClient {
  health(signal?: AbortSignal): Promise<boolean>
  init(body: EnvdInit): Promise<void>
  process: Client<typeof Process>
  filesystem: Client<typeof Filesystem>
  readFile(path: string, user?: string): Promise<Uint8Array>
  writeFile(path: string, bytes: Uint8Array, user?: string): Promise<void>
  /** Headers that run a Connect call as `user`. */
  userHeaders(user: string): Record<string, string>
}

const basic = (user: string) => `Basic ${Buffer.from(`${user}:`).toString('base64')}`

export interface EnvdClientOptions {
  baseUrl: string
  accessToken: string
  fetch?: typeof fetch
  /** Extra headers on every request (e.g. the service key and owner when calling through the relay). */
  headers?: Record<string, string>
  /** How a call's user reaches envd: Basic auth (direct) or `X-Envd-User` (through the Agentry Sandbox relay). */
  userVia?: 'basic' | 'header'
}

export function createEnvdClient(opts: EnvdClientOptions): EnvdClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? fetch
  const extra = opts.headers ?? {}
  const userHeader = (user: string): Record<string, string> => (opts.userVia === 'header' ? { 'X-Envd-User': user } : { Authorization: basic(user) })
  const token: Interceptor = (next) => (req) => {
    for (const [k, v] of Object.entries(extra)) req.header.set(k, v)
    req.header.set('X-Access-Token', opts.accessToken)
    return next(req)
  }
  const transport = createConnectTransport({ httpVersion: '1.1', baseUrl, interceptors: [token] })
  const headers = (user?: string): Record<string, string> => ({ ...extra, 'X-Access-Token': opts.accessToken, ...(user ? userHeader(user) : {}) })
  const fail = async (what: string, res: Response): Promise<never> => {
    throw new Error(`envd ${what} failed: ${String(res.status)} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  const filesUrl = (path: string, user?: string) => `${baseUrl}/files?${new URLSearchParams({ path, ...(user ? { username: user } : {}) }).toString()}`
  return {
    async health(signal) {
      try {
        const res = await doFetch(`${baseUrl}/health`, signal ? { signal } : {})
        return res.status === 204 || res.ok
      } catch {
        return false
      }
    },
    async init(body) {
      const res = await doFetch(`${baseUrl}/init`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) await fail('init', res)
    },
    process: createClient(Process, transport),
    filesystem: createClient(Filesystem, transport),
    async readFile(path, user) {
      const res = await doFetch(filesUrl(path, user), { headers: headers(user) })
      if (!res.ok) await fail(`read ${path}`, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async writeFile(path, bytes, user) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(bytes)]), path.split('/').pop() || 'file')
      const res = await doFetch(filesUrl(path, user), { method: 'POST', headers: headers(user), body: form })
      if (!res.ok) await fail(`write ${path}`, res)
    },
    userHeaders: userHeader,
  }
}
