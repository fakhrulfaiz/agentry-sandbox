/**
 * The envd relay: `ANY /v1/sandboxes/{id}/envd/<path>` → that sandbox's envd
 * `<path>`, streamed both ways without buffering (Connect server streams
 * work). The caller's credentials never reach envd: the relay sets the
 * sandbox's access token and turns `X-Envd-User` into the Basic auth envd
 * reads the Unix user from. Closing the client aborts the upstream request.
 */
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream'
import type { SandboxService } from '../sandboxes.ts'

/** Request headers forwarded to envd; everything else is dropped. */
const FORWARD = ['content-type', 'content-length', 'content-encoding', 'accept', 'accept-encoding', 'connect-protocol-version', 'connect-timeout-ms', 'connect-content-encoding', 'connect-accept-encoding', 'user-agent']
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'])
/** Test-only: extra TLS options (a trusted CA) for https upstreams. Product code never sets it, and verification is never disabled. */
let tlsForTests: https.RequestOptions = {}
export function setRelayTlsForTests(opts: https.RequestOptions): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) throw new Error('setRelayTlsForTests is for tests only')
  tlsForTests = opts
}

const ENVD_USER = /^[a-z_][a-z0-9_-]{0,31}$/

export async function relay(service: SandboxService, owner: string, id: string, rest: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { baseUrl, token, headers: extraHeaders, release, envdUser } = await service.endpoint(owner, id)
  try {
    await service.touch(owner, id)
  } catch (e) {
    // A tunnel opened for this request must not outlive it (the sandbox may have just been deleted).
    release?.()
    throw e
  }
  // The client may have left while the sandbox was starting.
  if (req.destroyed || res.destroyed) {
    release?.()
    return
  }
  const endUse = service.beginUse(id)
  // Frees what the endpoint holds (an SSH tunnel) once the response ends.
  const done = () => {
    endUse()
    release?.()
  }
  const raw = req.url ?? ''
  const search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
  const target = new URL(`/${rest}${search}`, baseUrl)

  const headers: http.OutgoingHttpHeaders = {}
  for (const name of FORWARD) {
    const v = req.headers[name]
    if (v !== undefined) headers[name] = v
  }
  headers['x-access-token'] = token
  // Driver headers win over anything the client sent (only the allow-listed names above get this far).
  for (const [k, v] of Object.entries(extraHeaders ?? {})) headers[k.toLowerCase()] = v
  const user = req.headers['x-envd-user']
  if (user !== undefined && (typeof user !== 'string' || !ENVD_USER.test(user))) {
    // Never fall back to envd's default user silently.
    done()
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_request', message: 'X-Envd-User is not a valid user name' } }))
    return
  }
  if (typeof user === 'string') headers.authorization = `Basic ${Buffer.from(`${envdUser ? envdUser(user) : user}:`).toString('base64')}`

  await new Promise<void>((resolve) => {
    const secure = target.protocol === 'https:'
    const upstream = (secure ? https : http).request(target, { method: req.method, headers, ...(secure ? tlsForTests : {}) }, (up) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v
      res.writeHead(up.statusCode ?? 502, out)
      res.flushHeaders()
      // pipeline honours backpressure: a slow client slows envd instead of filling memory.
      pipeline(up, res, () => resolve())
    })
    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'envd_unreachable', message: e.message } }))
      } else res.destroy()
      resolve()
    })
    // The client went away: stop the upstream call too.
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
      resolve()
    })
    req.pipe(upstream)
  }).finally(done)
}
