/**
 * The port proxy: `ANY /v1/sandboxes/{id}/ports/{port}/<path>` → that port on
 * the sandbox, streamed both ways. The caller's credentials never reach the
 * app: only headers that describe the request itself are forwarded.
 */
import http from 'node:http'
import { pipeline } from 'node:stream'
import type { SandboxService } from '../sandboxes.ts'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'])
/** Never sent to the app: credentials and routing headers of the caller. */
const DROP = new Set([...HOP_BY_HOP, 'host', 'authorization', 'cookie', 'x-agentry-owner', 'x-envd-user', 'x-access-token', 'expect'])

export async function proxyPort(service: SandboxService, owner: string, id: string, port: number, rest: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { baseUrl, release } = await service.portEndpoint(owner, id, port)
  try {
    await service.touch(owner, id)
  } catch (e) {
    release?.()
    throw e
  }
  if (req.destroyed || res.destroyed) {
    release?.()
    return
  }
  const endUse = service.beginUse(id)
  const done = () => {
    endUse()
    release?.()
  }
  const raw = req.url ?? ''
  const search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
  const target = new URL(`/${rest}${search}`, baseUrl)
  const headers: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP.has(k)) headers[k] = v

  await new Promise<void>((resolve) => {
    const upstream = http.request(target, { method: req.method, headers }, (up) => {
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
