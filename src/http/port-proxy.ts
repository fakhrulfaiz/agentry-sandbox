/**
 * The port proxy: `ANY /v1/sandboxes/{id}/ports/{port}/<path>` → that port on
 * the sandbox, streamed both ways. The caller's credentials never reach the
 * app: only headers that describe the request itself are forwarded.
 */
import http from 'node:http'
import type { Socket } from 'node:net'
import { pipeline } from 'node:stream'
import type { SandboxService } from '../sandboxes.ts'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'])
/** Never sent to the app: credentials and routing headers of the caller. */
const DROP = new Set([...HOP_BY_HOP, 'host', 'authorization', 'cookie', 'x-agentry-owner', 'x-envd-user', 'x-access-token', 'expect'])

export async function proxyPort(service: SandboxService, owner: string, id: string, port: number, rest: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  await service.touch(owner, id)
  // Resolves the sandbox (and starts it) before anything is read from the client.
  const socket = await service.portConnect(owner, id, port)
  // Errors surface through the request below; this keeps one that arrives first from being unhandled.
  socket.on('error', () => {})
  if (req.destroyed || res.destroyed) {
    socket.destroy()
    return
  }
  const endUse = service.beginUse(id)
  const done = () => {
    endUse()
    socket.destroy()
  }
  const raw = req.url ?? ''
  const search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
  // The raw path after the port, trailing slash included (`/dir` and `/dir/` are different URLs to the app); the caller's `rest` drops it.
  const path = /\/ports\/\d+\/([^?]*)/.exec(raw)?.[1] ?? rest
  const headers: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP.has(k)) headers[k] = v
  headers.host = `localhost:${String(port)}`

  await new Promise<void>((resolve) => {
    // One request per connection (no keep-alive: `Connection: close`), carried over the stream the driver gave.
    const agent = new (class extends http.Agent { override createConnection() { return socket as unknown as Socket } })({ keepAlive: false })
    const upstream = http.request({ method: req.method, path: `/${path}${search}`, headers, agent }, (up) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v
      res.writeHead(up.statusCode ?? 502, out)
      res.flushHeaders()
      pipeline(up, res, () => resolve())
    })
    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'port_unreachable', message: `Nothing answered on port ${String(port)}: ${e.message}` } }))
      } else res.destroy()
      resolve()
    })
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
      resolve()
    })
    req.pipe(upstream)
  }).finally(done)
}
