/**
 * The envd relay: `ANY /v1/sandboxes/{id}/envd/<path>` → that sandbox's envd
 * `<path>`, streamed both ways without buffering (Connect server streams
 * work). The caller's credentials never reach envd: the relay sets the
 * sandbox's access token and turns `X-Envd-User` into the Basic auth envd
 * reads the Unix user from. Closing the client aborts the upstream request.
 */
import http from 'node:http'
import { pipeline } from 'node:stream'
import type { SandboxService } from '../sandboxes.ts'

/** Request headers forwarded to envd; everything else is dropped. */
const FORWARD = ['content-type', 'content-length', 'content-encoding', 'accept', 'accept-encoding', 'connect-protocol-version', 'connect-timeout-ms', 'connect-content-encoding', 'connect-accept-encoding', 'user-agent']
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'])
const ENVD_USER = /^[a-z_][a-z0-9_-]{0,31}$/

export async function relay(service: SandboxService, owner: string, id: string, rest: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { baseUrl, token } = await service.endpoint(owner, id)
  await service.touch(owner, id)
  // The client may have left while the sandbox was starting.
  if (req.destroyed || res.destroyed) return
  const done = service.beginUse(id)
  const raw = req.url ?? ''
  const search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
  const target = new URL(`/${rest}${search}`, baseUrl)

  const headers: http.OutgoingHttpHeaders = {}
  for (const name of FORWARD) {
    const v = req.headers[name]
    if (v !== undefined) headers[name] = v
  }
  headers['x-access-token'] = token
  const user = req.headers['x-envd-user']
  if (user !== undefined && (typeof user !== 'string' || !ENVD_USER.test(user))) {
    // Never fall back to envd's default user silently.
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_request', message: 'X-Envd-User is not a valid user name' } }))
    return
  }
  if (typeof user === 'string') headers.authorization = `Basic ${Buffer.from(`${user}:`).toString('base64')}`

  await new Promise<void>((resolve) => {
    const upstream = http.request(target, { method: req.method, headers }, (up) => {
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
