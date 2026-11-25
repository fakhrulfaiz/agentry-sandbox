/**
 * A local stand-in for E2B: the REST API the e2b driver uses plus the shared
 * sandbox host's `/health` (one server answers both). Sandboxes live in memory;
 * knobs fail the next call, expire a sandbox to `paused` (auto-pause) or delete one.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeSandbox {
  sandboxID: string
  state: 'running' | 'paused'
  envdAccessToken: string
  secure: boolean
  metadata: Record<string, string>
  body: Record<string, unknown>
  timeout: number
}

export interface FakeE2b {
  url: string
  apiKey: string
  sandboxes: Map<string, FakeSandbox>
  /** Every request as `METHOD path`. */
  log: string[]
  /** Request bodies by `METHOD path`. */
  bodies: { key: string; headers: http.IncomingHttpHeaders; body: unknown }[]
  /** Answers the next API call (any path) with this status. */
  failNext(status: number, headers?: Record<string, string>): void
  /** The next API call (any path) is accepted and never answered. */
  hangNext(): void
  /** Auto-pause: the sandbox's timeout ran out. */
  expire(id: string): void
  /** The sandbox is gone on E2B's side. */
  remove(id: string): void
  close(): Promise<void>
}

/** `envdUpstream`: a real envd's base URL; sandbox-host requests (those with `E2b-Sandbox-Id`) are checked and proxied there. */
export async function startFakeE2b(apiKey = 'e2b_test_key_123', opts: { envdUpstream?: string } = {}): Promise<FakeE2b> {
  const sandboxes = new Map<string, FakeSandbox>()
  const log: string[] = []
  const bodies: FakeE2b['bodies'] = []
  let failing: { status: number; headers: Record<string, string> } | undefined
  let hanging = false
  let counter = 0

  const server = http.createServer((req, res) => {
    const sid = req.headers['e2b-sandbox-id']
    if (sid !== undefined && opts.envdUpstream) {
      // The shared sandbox host: check the sandbox and its token, then hand the request to envd.
      const s = sandboxes.get(String(sid))
      if (!s || s.state !== 'running' || req.headers['x-access-token'] !== s.envdAccessToken || req.headers['e2b-sandbox-port'] !== '49983') {
        res.writeHead(502, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ message: 'no such sandbox' }))
      }
      log.push(`${req.method ?? 'GET'} ${req.url ?? ''} (sandbox host)`)
      const up = new URL(opts.envdUpstream)
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: up.host }
      delete headers['e2b-sandbox-id']
      delete headers['e2b-sandbox-port']
      const out = http.request({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      })
      out.on('error', () => { res.destroy() })
      req.pipe(out)
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname
      const key = `${req.method ?? 'GET'} ${path}`
      let body: unknown
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      } catch {
        body = undefined
      }
      const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers })
        res.end(json === undefined ? undefined : JSON.stringify(json))
      }
      // The shared sandbox host: envd's health, addressed by headers.
      if (path === '/health') {
        const s = sandboxes.get(String(req.headers['e2b-sandbox-id']))
        if (!s || s.state !== 'running' || req.headers['x-access-token'] !== s.envdAccessToken || req.headers['e2b-sandbox-port'] !== '49983') return send(502, { message: 'no such sandbox' })
        log.push(key)
        return send(204)
      }
      log.push(`${key}${url.search}`)
      bodies.push({ key, headers: req.headers, body })
      if (req.headers['x-api-key'] !== apiKey) return send(401, { message: 'invalid api key' })
      if (hanging) { hanging = false; return }
      if (failing) {
        const f = failing
        failing = undefined
        return send(f.status, { message: 'forced failure' }, f.headers)
      }
      if (req.method === 'POST' && path === '/v2/sandboxes') {
        const b = (body ?? {}) as { metadata?: Record<string, string>; timeout?: number; secure?: boolean }
        const id = `isb${String((counter += 1))}`
        const s: FakeSandbox = { sandboxID: id, state: 'running', envdAccessToken: `tok-${id}-secret`, secure: b.secure === true, metadata: b.metadata ?? {}, body: b as Record<string, unknown>, timeout: b.timeout ?? 0 }
        sandboxes.set(id, s)
        return send(201, { sandboxID: id, ...(s.secure ? { envdAccessToken: s.envdAccessToken } : {}), envdVersion: '0.2.4', domain: null })
      }
      if (req.method === 'GET' && path === '/v2/sandboxes') {
        const next = Number(url.searchParams.get('nextToken') ?? 0)
        const all = [...sandboxes.values()]
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 2)
        const page = all.slice(next, next + limit)
        const more = next + limit < all.length
        return send(200, page.map((s) => ({ sandboxID: s.sandboxID, state: s.state, metadata: s.metadata })), more ? { 'x-next-token': String(next + limit) } : {})
      }
      const m = /^\/(?:v2\/)?sandboxes\/([^/]+)(?:\/(pause|connect|timeout))?$/u.exec(path)
      if (!m) return send(404, { message: 'not found' })
      const s = sandboxes.get(m[1]!)
      if (!s) return send(404, { message: 'sandbox not found' })
      const action = m[2]
      if (req.method === 'GET' && !action) return send(200, { sandboxID: s.sandboxID, state: s.state, metadata: s.metadata })
      if (req.method === 'DELETE' && !action) {
        sandboxes.delete(s.sandboxID)
        return send(204)
      }
      if (req.method === 'POST' && action === 'pause') {
        if (s.state === 'paused') return send(409, { message: 'already paused' })
        s.state = 'paused'
        return send(204)
      }
      if (req.method === 'POST' && action === 'connect') {
        s.state = 'running'
        s.timeout = ((body ?? {}) as { timeout?: number }).timeout ?? s.timeout
        return send(201, { sandboxID: s.sandboxID, envdAccessToken: s.envdAccessToken })
      }
      if (req.method === 'POST' && action === 'timeout') {
        if (s.state !== 'running') return send(404, { message: 'not running' })
        s.timeout = ((body ?? {}) as { timeout?: number }).timeout ?? s.timeout
        return send(204)
      }
      return send(404, { message: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    apiKey,
    sandboxes,
    log,
    bodies,
    hangNext: () => { hanging = true },
    failNext: (status, headers = {}) => { failing = { status, headers } },
    expire: (id) => { const s = sandboxes.get(id); if (s) s.state = 'paused' },
    remove: (id) => { sandboxes.delete(id) },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}
