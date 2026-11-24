import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { envdToken } from '../src/envd/token.ts'
import { config, startServer, type TestServer } from './support/server.ts'

let s: TestServer
let upstream: http.Server
let seen: { url: string; headers: http.IncomingHttpHeaders }[]
let closed: boolean
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void

beforeEach(async () => {
  s = await startServer()
  seen = []
  closed = false
  handler = (_req, res) => res.end('ok')
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    res.on('close', () => { if (!res.writableEnded) closed = true })
    handler(req, res)
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  s.backend.setEndpoint(`http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`)
})
afterEach(async () => {
  await s.close()
  upstream.closeAllConnections()
  await new Promise<void>((r) => upstream.close(() => r()))
})

const create = async () => ((await (await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'box' }) })).json()) as { id: string }).id

describe('envd relay', () => {
  it('injects the sandbox token and strips caller credentials', async () => {
    const id = await create()
    const r = await s.call(`/v1/sandboxes/${id}/envd/process.Process/List?x=1`, { method: 'POST', body: '{}', headers: { 'X-Access-Token': 'forged', 'X-Envd-User': 'agent', 'connect-protocol-version': '1' } })
    expect(r.status).toBe(200)
    const h = seen[0]!.headers
    expect(seen[0]!.url).toBe('/process.Process/List?x=1')
    expect(h['x-access-token']).toBe(envdToken(config.secret, id))
    expect(h.authorization).toBe(`Basic ${Buffer.from('agent:').toString('base64')}`)
    expect(h['x-agentry-owner']).toBeUndefined()
    expect(h['x-envd-user']).toBeUndefined()
    expect(h['connect-protocol-version']).toBe('1')
  })

  it('streams chunks as they arrive', async () => {
    const id = await create()
    let finished = false
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/connect+json' })
      res.write('one')
      setTimeout(() => res.write('two'), 150)
      setTimeout(() => { finished = true; res.end('three') }, 300)
    }
    const r = await s.call(`/v1/sandboxes/${id}/envd/stream`)
    const reader = r.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('one')
    expect(finished).toBe(false)
    let rest = ''
    for (;;) {
      const c = await reader.read()
      if (c.done) break
      rest += new TextDecoder().decode(c.value)
    }
    expect(rest).toBe('twothree')
  })

  it('aborts upstream when the client disconnects', async () => {
    const id = await create()
    handler = (_req, res) => {
      res.writeHead(200)
      res.write('start')
    }
    const ctl = new AbortController()
    const r = await s.call(`/v1/sandboxes/${id}/envd/stream`, { signal: ctl.signal })
    await r.body!.getReader().read()
    ctl.abort()
    const deadline = Date.now() + 1_000
    while (!closed && Date.now() < deadline) await new Promise((x) => setTimeout(x, 20))
    expect(closed).toBe(true)
  })

  it('starts a stopped sandbox before relaying', async () => {
    const id = await create()
    await s.call(`/v1/sandboxes/${id}/stop`, { method: 'POST' })
    s.backend.calls.length = 0
    expect((await s.call(`/v1/sandboxes/${id}/envd/health`)).status).toBe(200)
    expect(s.backend.calls).toEqual([`start ${id}`])
  })
})

describe('relay backpressure (I5)', () => {
  it('a slow client slows envd instead of the relay buffering everything', async () => {
    const id = await create()
    let blocked = 0
    let written = 0
    const chunk = Buffer.alloc(64 * 1024, 120)
    handler = (_req, res) => {
      res.writeHead(200)
      const pump = () => {
        while (written < 64 * 1024 * 1024) {
          written += chunk.length
          if (!res.write(chunk)) {
            blocked++
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      pump()
    }
    const r = await s.call(`/v1/sandboxes/${id}/envd/big`)
    const reader = r.body!.getReader()
    await reader.read()
    await new Promise((x) => setTimeout(x, 400))
    // Without backpressure the relay would have pulled all 64 MiB into memory by now.
    expect(blocked).toBeGreaterThan(0)
    expect(written).toBeLessThan(32 * 1024 * 1024)
    await reader.cancel()
  })
})
