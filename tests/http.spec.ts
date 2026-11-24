import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type TestServer } from './support/server.ts'

let s: TestServer
beforeEach(async () => {
  s = await startServer()
})
afterEach(async () => s.close())

const json = async (r: Response) => (await r.json()) as Record<string, unknown>

describe('HTTP API', () => {
  it('health needs no key', async () => {
    const r = await fetch(`${s.url}/v1/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('rejects a missing or wrong key with 401', async () => {
    for (const key of [null, 'wrong']) {
      const r = await s.call('/v1/sandboxes', { key })
      expect(r.status).toBe(401)
      expect(await json(r)).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } })
    }
  })

  it('requires X-Agentry-Owner', async () => {
    const r = await s.call('/v1/sandboxes', { owner: null })
    expect(r.status).toBe(400)
    expect((await json(r)).error).toMatchObject({ code: 'owner_required' })
  })

  it('create, list, get, start, stop, reset, delete round-trip', async () => {
    const created = await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'box', template: { image: 'python:3.13', setup_commands: ['echo hi'], resources: { memory_mb: 1024 } } }) })
    expect(created.status).toBe(201)
    const sbx = await json(created)
    expect(sbx).toMatchObject({ object: 'sandbox', name: 'box', state: 'running', backend: 'fake', image: 'python:3.13', template: { image: 'python:3.13', setup_commands: ['echo hi'], resources: { memory_mb: 1024 } } })
    expect(typeof sbx.created_at).toBe('number')
    const id = sbx.id as string
    expect(((await json(await s.call('/v1/sandboxes'))).data as unknown[]).length).toBe(1)
    expect((await json(await s.call(`/v1/sandboxes/${id}`))).id).toBe(id)
    expect((await json(await s.call(`/v1/sandboxes/${id}/stop`, { method: 'POST' }))).state).toBe('stopped')
    expect((await json(await s.call(`/v1/sandboxes/${id}/start`, { method: 'POST' }))).state).toBe('running')
    expect((await json(await s.call(`/v1/sandboxes/${id}/reset`, { method: 'POST', body: JSON.stringify({ keep_workspace: false }) }))).state).toBe('running')
    expect(s.backend.calls).toContain(`destroy ${id} keep=false`)
    expect((await s.call(`/v1/sandboxes/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await s.call(`/v1/sandboxes/${id}`)).status).toBe(404)
  })

  it('templates CRUD, and sandboxes made from a template', async () => {
    const t = await json(await s.call('/v1/templates', { method: 'POST', body: JSON.stringify({ name: 'py', spec: { image: 'python:3.13', network: false, env: { A: '1' } } }) }))
    expect(t).toMatchObject({ object: 'template', name: 'py', spec: { image: 'python:3.13', network: false, env: { A: '1' } } })
    const u = await json(await s.call(`/v1/templates/${t.id as string}`, { method: 'PUT', body: JSON.stringify({ name: 'py2', spec: { image: 'python:3.12' } }) }))
    expect(u).toMatchObject({ name: 'py2', spec: { image: 'python:3.12' } })
    const sbx = await json(await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'b', template_id: t.id }) }))
    expect(sbx).toMatchObject({ template_id: t.id, image: 'python:3.12' })
    expect(((await json(await s.call('/v1/templates'))).data as unknown[]).length).toBe(1)
    expect((await s.call(`/v1/templates/${t.id as string}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('rejects invalid input with 400 invalid_request', async () => {
    for (const body of [{}, { name: '' }, { name: 'x', template: { packages: 'jq' } }, { name: 'x', template: { env: { 'BAD KEY': '1' } } }, { name: 'x', template: { resources: { cpus: 0 } } }]) {
      const r = await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify(body) })
      expect(r.status).toBe(400)
      expect((await json(r)).error).toMatchObject({ code: 'invalid_request' })
    }
    expect((await s.call('/v1/sandboxes', { method: 'POST', body: '{not json' })).status).toBe(400)
  })

  it("another owner's sandbox, template and relay path are 404", async () => {
    const sbx = await json(await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'box' }) }))
    const t = await json(await s.call('/v1/templates', { method: 'POST', body: JSON.stringify({ name: 'py', spec: {} }) }))
    for (const [path, method] of [[`/v1/sandboxes/${sbx.id as string}`, 'GET'], [`/v1/sandboxes/${sbx.id as string}/stop`, 'POST'], [`/v1/sandboxes/${sbx.id as string}`, 'DELETE'], [`/v1/templates/${t.id as string}`, 'GET'], [`/v1/sandboxes/${sbx.id as string}/envd/health`, 'GET']] as const) {
      const r = await s.call(path, { method, owner: 'bob' })
      expect(r.status, `${method} ${path}`).toBe(404)
      expect((await json(r)).error).toMatchObject({ code: 'not_found' })
    }
  })

  it('backend down answers 503 backend_unavailable, and /backends says why', async () => {
    s.backend.setAvailable(false, 'Docker is not reachable')
    const r = await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'box' }) })
    expect(r.status).toBe(503)
    expect((await json(r)).error).toMatchObject({ code: 'backend_unavailable', message: 'Docker is not reachable' })
    expect((await json(await s.call('/v1/backends'))).data).toEqual([{ kind: 'fake', available: false, reason: 'Docker is not reachable', capabilities: expect.any(Object) }])
  })

  it('unknown routes answer 404', async () => {
    expect((await s.call('/v1/nope')).status).toBe(404)
  })
})

describe('limits over HTTP', () => {
  it('answers 429 quota_exceeded with the reason, and 400 for an oversized template', async () => {
    s.service.setLimitsForTest?.({ maxPerOwner: 1 })
    expect((await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'a' }) })).status).toBe(201)
    const r = await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'b' }) })
    expect(r.status).toBe(429)
    expect((await json(r)).error).toMatchObject({ code: 'quota_exceeded', message: expect.stringContaining('limit 1') })
    const big = await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'c', template: { resources: { cpus: 64 } } }) })
    expect(big.status).toBe(400)
  })
})
