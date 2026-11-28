import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type TestServer } from './support/server.ts'

let s: TestServer
let upstream: http.Server
let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[]

beforeEach(async () => {
  s = await startServer()
  seen = []
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += String(c) })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'a=b' }).end('<h1>hi</h1>')
    })
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

describe('port proxy', () => {
  it('relays method, path, query and body, and keeps the caller credentials from the app', async () => {
    const id = await create()
    const r = await s.call(`/v1/sandboxes/${id}/ports/8765/a/b.html?x=1`, { method: 'POST', body: '{"k":1}', headers: { cookie: 'sid=1' } })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('<h1>hi</h1>')
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/a/b.html?x=1', body: '{"k":1}' })
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.headers.cookie).toBeUndefined()
    expect(seen[0]!.headers['x-agentry-owner']).toBeUndefined()
  })

  it('answers 404 for another owner and 400 for a bad port', async () => {
    const id = await create()
    expect((await s.call(`/v1/sandboxes/${id}/ports/8765/`, { owner: 'bob' })).status).toBe(404)
    expect((await s.call(`/v1/sandboxes/${id}/ports/99999/`)).status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('answers 502 port_unreachable when nothing listens', async () => {
    const id = await create()
    s.backend.setEndpoint('http://127.0.0.1:1')
    const r = await s.call(`/v1/sandboxes/${id}/ports/8765/`)
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('port_unreachable')
  })
})
