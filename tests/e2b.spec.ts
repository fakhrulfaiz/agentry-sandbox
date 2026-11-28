import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { sealSecrets } from '../src/crypto/secrets.ts'
import { createE2bDriver, e2bFactory } from '../src/places/drivers/e2b.ts'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { createPlaceRegistry } from '../src/places/registry.ts'
import { createSandboxService, LimitError, PlaceUnavailableError } from '../src/sandboxes.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { startTestService, type TestService } from '../src/testing.ts'
import { startFakeE2b } from './support/fake-e2b.ts'
import { createHash, randomBytes } from 'node:crypto'
import { bootstrap } from '../src/places/bootstrap.ts'
import { setRelayTlsForTests } from '../src/http/relay.ts'
import { dockerAvailable } from './support/docker.ts'
import { startBareEnvd } from './support/bare-envd.ts'

const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(cfg: Record<string, unknown> = {}, ttl = 0, probeTtlMs = 0) {
  const e2b = await startFakeE2b()
  cleanups.push(() => e2b.close())
  const store = createMemoryStore()
  const t = Date.now()
  await store.places.insert({ id: 'place_e2b', name: 'E2B', kind: 'e2b', config: { template: 'tpl-1', api_url: e2b.url, sandbox_host: e2b.url, timeout_s: 600, ...cfg }, secrets: sealSecrets(config.secret, { api_key: e2b.apiKey }), enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: t, updatedAt: t })
  const places = await createPlaceRegistry({ store, config, local: createFakeDriver(), probeTtlMs, drivers: { e2b: e2bFactory({ retryDelayMs: 0, statusTtlMs: ttl }) } })
  // The shared bootstrap is not under test here; E2B's envd is the fake's health route.
  const service = createSandboxService({ store, places, config, provision: async (_d, _i, h) => h })
  return { e2b, store, places, service }
}

describe('e2b driver', () => {
  it('create sends the template, auto-pause and metadata and keeps the token secret', async () => {
    const { e2b, store, service } = await setup()
    const s = await service.create('alice', { name: 'box', place: 'place_e2b', template: { env: { A: '1' }, network: false } })
    const [posted] = e2b.bodies.filter((b) => b.key === 'POST /v2/sandboxes')
    expect(posted!.headers['x-api-key']).toBe(e2b.apiKey)
    expect(posted!.body).toEqual({ templateID: 'tpl-1', timeout: 600, autoPause: true, secure: true, metadata: { 'agentry.sandbox.id': s.id, 'agentry.sandbox.owner': 'alice' }, envVars: { A: '1' }, allow_internet_access: false })
    const [e2bId] = [...e2b.sandboxes.keys()]
    const token = e2b.sandboxes.get(e2bId!)!.envdAccessToken
    // The token is in the sealed secrets only: not in the handle, the record's public fields or the API's view.
    const rec = (await store.sandboxes.getAny(s.id))!
    expect(rec.handle).toEqual({ e2bId })
    expect(rec.handleSecrets).toBeTruthy()
    expect(rec.handleSecrets).not.toContain(token)
    expect(JSON.stringify(rec.handle) + JSON.stringify(await service.get('alice', s.id))).not.toContain(token)
    expect(JSON.stringify(rec.handle)).not.toContain(e2b.apiKey)
    // The relay still gets it, with the shared-host headers.
    const ep = await service.endpoint('alice', s.id)
    expect(ep).toMatchObject({ baseUrl: e2b.url, token, headers: { 'E2b-Sandbox-Id': e2bId, 'E2b-Sandbox-Port': '49983' } })
  })

  it('a paused sandbox resumes on the next request', async () => {
    const { e2b, service } = await setup()
    const s = await service.create('alice', { name: 'box', place: 'place_e2b' })
    const [e2bId] = [...e2b.sandboxes.keys()]
    e2b.expire(e2bId!)
    expect(e2b.sandboxes.get(e2bId!)!.state).toBe('paused')
    await service.endpoint('alice', s.id)
    expect(e2b.sandboxes.get(e2bId!)!.state).toBe('running')
    expect(e2b.log).toContain(`POST /v2/sandboxes/${e2bId!}/connect`)
    expect(e2b.bodies.find((b) => b.key.endsWith('/connect'))!.body).toEqual({ timeout: 600 })
    // Stop pauses (it does not kill) and start resumes.
    await service.stop('alice', s.id)
    expect(e2b.sandboxes.get(e2bId!)!.state).toBe('paused')
    expect((await service.start('alice', s.id)).state).toBe('running')
  })

  it('maintain extends the timeout of a running sandbox', async () => {
    const { e2b, service } = await setup()
    await service.create('alice', { name: 'box', place: 'place_e2b' })
    const [e2bId] = [...e2b.sandboxes.keys()]
    await service.sweepIdle()
    const ext = e2b.bodies.filter((b) => b.key === `POST /sandboxes/${e2bId!}/timeout`)
    expect(ext.map((b) => b.body)).toEqual([{ timeout: 600 }])
    // A paused sandbox is left alone.
    e2b.expire(e2bId!)
    await service.sweepIdle()
    expect(e2b.bodies.filter((b) => b.key.endsWith('/timeout'))).toHaveLength(1)
  })

  it('rate limit surfaces Retry-After', async () => {
    const e2b = await startFakeE2b()
    cleanups.push(() => e2b.close())
    const driver = createE2bDriver({ apiKey: e2b.apiKey, template: 't', apiUrl: e2b.url, sandboxHost: e2b.url, timeoutS: 600 }, { retryDelayMs: 0, statusTtlMs: 0 })
    const h = await driver.create('sbx_1', 'o', {}, { gpuIds: [] })
    e2b.failNext(429, { 'retry-after': '7' })
    await expect(driver.stop(h)).rejects.toThrow('E2B rate limit; retry after 7 s')
    // No retry loop: one pause request.
    expect(e2b.log.filter((l) => l.includes('/pause'))).toHaveLength(1)
    // A 503 on pause is retried once, then fails with a clear message.
    e2b.failNext(503)
    await driver.stop(h)
    expect(e2b.log.filter((l) => l.includes('/pause'))).toHaveLength(3)
    e2b.failNext(503)
    await driver.start('sbx_1', h, {}, { gpuIds: [] }).then(() => { throw new Error('no') }, (e: Error) => expect(e.message).toMatch(/E2B is unavailable/u))
    // Neither the key nor the token is in an error.
    e2b.failNext(500)
    const err = await driver.status(h).catch((e: Error) => e.message)
    expect(String(err)).not.toContain(e2b.apiKey)
    expect(String(err)).not.toContain(h['secret.envdAccessToken']!)
  })

  it('a sandbox gone on E2B is missing and deletes cleanly', async () => {
    const { e2b, service, store } = await setup()
    const s = await service.create('alice', { name: 'box', place: 'place_e2b' })
    const [e2bId] = [...e2b.sandboxes.keys()]
    e2b.remove(e2bId!)
    expect(await service.reconcile()).toMatchObject({ missing: [s.id] })
    expect((await service.get('alice', s.id)).state).toBe('failed')
    await service.destroy('alice', s.id)
    expect(await store.sandboxes.getAny(s.id)).toBeUndefined()
    // The driver alone: status missing, destroy of a missing sandbox is fine.
    const driver = createE2bDriver({ apiKey: e2b.apiKey, template: 't', apiUrl: e2b.url, sandboxHost: e2b.url, timeoutS: 600 })
    expect(await driver.status({ e2bId: 'isb404' })).toBe('missing')
    await driver.destroy('sbx_x', { e2bId: 'isb404' }, { keepWorkspace: false })
    // With no handle the sandbox is found by its metadata (a create that died half-way).
    const made = await driver.create('sbx_half', 'o', {}, { gpuIds: [] })
    await driver.destroy('sbx_half', {}, { keepWorkspace: false })
    expect(await driver.status(made)).toBe('missing')
  })

  it('lists only Agentry sandboxes, across pages', async () => {
    const { e2b, places } = await setup()
    const driver = places.get('place_e2b')!.driver
    for (const id of ['sbx_a', 'sbx_b', 'sbx_c']) await driver.create(id, 'o', {}, { gpuIds: [] })
    e2b.sandboxes.set('foreign', { sandboxID: 'foreign', state: 'running', envdAccessToken: 'x', secure: true, metadata: {}, body: {}, timeout: 0 })
    expect((await driver.listManaged()).map((m) => m.id).sort()).toEqual(['sbx_a', 'sbx_b', 'sbx_c'])
  })

  it('a template image is rejected naming the field', async () => {
    const { service, e2b } = await setup()
    await expect(service.create('alice', { name: 'box', place: 'place_e2b', template: { image: 'python:3.13' } })).rejects.toThrow(/does not support 'image': E2B uses templates; set the place's template/u)
    await expect(service.create('alice', { name: 'box', place: 'place_e2b', template: { image: 'x' } })).rejects.toBeInstanceOf(LimitError)
    expect(e2b.sandboxes.size).toBe(0)
  })

  it('admin test reports a refused key', async () => {
    const e2b = await startFakeE2b()
    cleanups.push(() => e2b.close())
    const adminKey = randomBytes(16).toString('hex')
    const svc: TestService = await startTestService({ AGENTRY_SANDBOX_ADMIN_KEYS: `sha256:${createHash('sha256').update(adminKey).digest('hex')}` }, undefined, { e2b: e2bFactory() })
    cleanups.push(() => svc.close())
    const test = (key: string) => fetch(`${svc.url}/v1/admin/places/test`, { method: 'POST', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'e2b', config: { template: 'base', api_url: e2b.url, sandbox_host: e2b.url }, secrets: { api_key: key } }) })
    const refused = await (await test('wrong-key-xyz')).text()
    expect(JSON.parse(refused)).toEqual({ ok: false, reason: 'E2B refused the API key' })
    expect(refused).not.toContain('wrong-key-xyz')
    expect(await (await test(e2b.apiKey)).json()).toEqual({ ok: true })
    // Saving an E2B place needs no host key, and never echoes the key.
    const saved = await fetch(`${svc.url}/v1/admin/places`, { method: 'POST', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2B', kind: 'e2b', config: { template: 'base', api_url: e2b.url, sandbox_host: e2b.url }, secrets: { api_key: e2b.apiKey } }) })
    expect(saved.status).toBe(201)
    const text = await saved.text()
    expect(text).not.toContain(e2b.apiKey)
    expect(JSON.parse(text)).toMatchObject({ kind: 'e2b', has_secrets: true, available: true })
  })

  it('reset keeping files is refused on E2B; resetting without keeping them works', async () => {
    const { e2b, service } = await setup()
    const s = await service.create('alice', { name: 'box', place: 'place_e2b' })
    const [first] = [...e2b.sandboxes.keys()]
    await expect(service.reset('alice', s.id, { keepWorkspace: true })).rejects.toThrow('this place cannot keep files on reset; reset without keeping files')
    await expect(service.reset('alice', s.id, { keepWorkspace: true })).rejects.toBeInstanceOf(LimitError)
    expect(e2b.sandboxes.has(first!)).toBe(true)
    expect((await service.reset('alice', s.id, { keepWorkspace: false })).state).toBe('running')
    expect(e2b.sandboxes.has(first!)).toBe(false)
  })

  it('relayed requests do not each ask E2B for the sandbox status', async () => {
    const { e2b, service } = await setup({}, 15_000)
    const s = await service.create('alice', { name: 'box', place: 'place_e2b' })
    const [e2bId] = [...e2b.sandboxes.keys()]
    e2b.log.length = 0
    for (let i = 0; i < 10; i++) await service.endpoint('alice', s.id)
    expect(e2b.log.filter((l) => l === `GET /sandboxes/${e2bId!}`).length).toBeLessThanOrEqual(1)
  })

  it('a 429 on resume leaves the sandbox stopped and answers place unavailable', async () => {
    // The place's probe is cached, so the injected failure lands on the connect call.
    const { e2b, service } = await setup({}, 0, 60_000)
    const s = await service.create('alice', { name: 'box', place: 'place_e2b' })
    await service.stop('alice', s.id)
    e2b.failNext(429, { 'retry-after': '7' })
    const failing = service.start('alice', s.id)
    await expect(failing).rejects.toBeInstanceOf(PlaceUnavailableError)
    expect(e2b.log.some((l) => l.endsWith('/connect'))).toBe(true)
    const rec = await service.get('alice', s.id)
    expect(rec.state).toBe('stopped')
    expect(rec.error).toBeNull()
    expect((await service.start('alice', s.id)).state).toBe('running')
  })

  it('changing the E2B address needs the API key typed again', async () => {
    const e2b = await startFakeE2b()
    cleanups.push(() => e2b.close())
    const adminKey = randomBytes(16).toString('hex')
    const svc: TestService = await startTestService({ AGENTRY_SANDBOX_ADMIN_KEYS: `sha256:${createHash('sha256').update(adminKey).digest('hex')}` }, undefined, { e2b: e2bFactory() })
    cleanups.push(() => svc.close())
    const call = (path: string, method: string, body: unknown) => fetch(`${svc.url}${path}`, { method, headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const created = (await (await call('/v1/admin/places', 'POST', { name: 'E2B', kind: 'e2b', config: { template: 'base', api_url: e2b.url, sandbox_host: e2b.url }, secrets: { api_key: e2b.apiKey } })).json()) as { id: string }
    const moved = await call(`/v1/admin/places/${created.id}`, 'PUT', { config: { template: 'base', api_url: 'https://collector.example', sandbox_host: e2b.url } })
    expect(moved.status).toBe(400)
    expect(await moved.text()).toContain('re-enter the API key when changing the address')
    // Unchanged address without the key is fine; a changed one with the key is fine.
    expect((await call(`/v1/admin/places/${created.id}`, 'PUT', { config: { template: 'other', api_url: e2b.url, sandbox_host: e2b.url } })).status).toBe(200)
    expect((await call(`/v1/admin/places/${created.id}`, 'PUT', { config: { template: 'other', api_url: e2b.url + '/', sandbox_host: e2b.url }, secrets: { api_key: e2b.apiKey } })).status).toBe(200)
  })
})

describe('e2b snapshots', () => {
  const waitSnap = async (service: Awaited<ReturnType<typeof setup>>['service'], id: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await service.getSnapshot('alice', id)
      if (r.state !== 'saving') return r
      await new Promise((r2) => setTimeout(r2, 10))
    }
    throw new Error('still saving')
  }

  it('offers disk and memory natively; the snapshot is an E2B template kept under an idempotency key', async () => {
    const { e2b, service } = await setup()
    expect(service.snapshotLevels('place_e2b')).toEqual(['disk', 'memory'])
    const box = await service.create('alice', { name: 'box', place: 'place_e2b' })
    const snap = await waitSnap(service, (await service.snapshot('alice', box.id, { level: 'memory', name: 'm' })).id)
    expect(snap).toMatchObject({ state: 'ready', level: 'memory', place: 'place_e2b', handle: { e2bSnapshotId: expect.stringMatching(/^snap-e2b-/) } })
    const [post] = e2b.bodies.filter((b) => b.key.endsWith('/snapshots'))
    expect(post!.body).toEqual({ memory: true })
    expect(post!.headers['idempotency-key']).toBe(snap.id)
    expect(e2b.snapshots.size).toBe(1)
  })

  it('a new sandbox from it uses the snapshot as its template; restore swaps the E2B sandbox; delete removes the template', async () => {
    const { e2b, store, service } = await setup()
    const box = await service.create('alice', { name: 'box', place: 'place_e2b' })
    const snap = await waitSnap(service, (await service.snapshot('alice', box.id, { level: 'disk' })).id)
    const snapId = snap.handle.e2bSnapshotId!
    const copy = await service.create('alice', { name: 'copy', place: 'place_e2b', snapshot: snap.id })
    const creates = e2b.bodies.filter((b) => b.key === 'POST /v2/sandboxes').map((b) => (b.body as { templateID: string }).templateID)
    expect(creates).toEqual(['tpl-1', snapId])
    const before = (await store.sandboxes.getAny(box.id))!.handle.e2bId
    await service.restore('alice', box.id, snap.id)
    const after = (await store.sandboxes.getAny(box.id))!.handle.e2bId
    expect(after).not.toBe(before)
    expect(e2b.sandboxes.has(before!)).toBe(false)
    expect(e2b.sandboxes.get(after!)!.metadata).toMatchObject({ 'agentry.sandbox.id': box.id, 'agentry.sandbox.owner': 'alice' })
    expect(copy.state).toBe('running')
    await service.deleteSnapshot('alice', snap.id)
    expect(e2b.snapshots.size).toBe(0)
  })

  it('a 409 while pausing is retried once; 503 fails the snapshot as unavailable', async () => {
    const { e2b, service } = await setup()
    const box = await service.create('alice', { name: 'box', place: 'place_e2b' })
    e2b.failNext(409)
    expect((await waitSnap(service, (await service.snapshot('alice', box.id, { level: 'disk' })).id)).state).toBe('ready')
    e2b.failNext(503)
    const failed = await waitSnap(service, (await service.snapshot('alice', box.id, { level: 'disk' })).id)
    expect(failed.state).toBe('failed')
    expect(failed.error).toMatch(/unavailable/i)
  })
})

describe('e2b final review 2', () => {
  const place = (e2b: { url: string; apiKey: string }, deps = {}) =>
    createE2bDriver({ apiKey: e2b.apiKey, template: 'tpl-1', apiUrl: e2b.url, sandboxHost: e2b.url, timeoutS: 600 }, deps)

  it('I-A: a create answered without an envd access token kills the sandbox and fails', async () => {
    const e2b = await startFakeE2b()
    cleanups.push(() => e2b.close())
    // E2B treats a create without `secure` as unsecured: no token comes back.
    const unsecured: typeof fetch = (input, init) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      if (body && 'secure' in body) delete body.secure
      return fetch(input, body ? { ...init, body: JSON.stringify(body) } : init)
    }
    await expect(place(e2b, { fetch: unsecured }).create('sbx_1', 'alice', {}, { gpuIds: [] })).rejects.toThrow('E2B did not return an envd access token')
    expect(e2b.sandboxes.size).toBe(0)
  })

  it('I-B: a call E2B never answers fails as unavailable within the timeout', async () => {
    const e2b = await startFakeE2b()
    cleanups.push(() => e2b.close())
    const driver = place(e2b, { apiTimeoutMs: 200 })
    e2b.hangNext()
    const t = Date.now()
    await expect(driver.status({ e2bId: 'isb1' })).rejects.toThrow(/did not answer within/)
    expect(Date.now() - t).toBeLessThan(3_000)
    await expect(driver.status({ e2bId: 'isb1' })).resolves.toBe('missing')
  })

  it('Minor: api_url and sandbox_host must be https, except loopback', () => {
    const rec = (config: Record<string, unknown>) => ({ id: 'p', name: 'p', kind: 'e2b', config, secrets: '', enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: 0, updatedAt: 0 })
    const make = (config: Record<string, unknown>) => e2bFactory()(rec(config) as never, { api_key: 'k' })
    expect(() => make({ api_url: 'http://api.example.com' })).toThrow(/https/)
    expect(() => make({ sandbox_host: 'http://sandbox.example.com' })).toThrow(/https/)
    expect(() => make({ api_url: 'http://127.0.0.1:1234', sandbox_host: 'http://localhost:1' })).not.toThrow()
  })

  it('Minor: setRelayTlsForTests refuses to run outside tests', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VITEST', '')
    try {
      expect(() => setRelayTlsForTests({ rejectUnauthorized: false })).toThrow(/tests only/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.skipIf(!dockerAvailable)('I-C: the full create path (driver + shared bootstrap) completes through the sandbox host', async () => {
    const envd = await startBareEnvd()
    cleanups.push(() => envd.stop())
    const e2b = await startFakeE2b('e2b_test_key_123', { envdUpstream: envd.baseUrl })
    cleanups.push(() => e2b.close())
    const driver = createE2bDriver({ apiKey: e2b.apiKey, template: 'tpl-1', apiUrl: e2b.url, sandboxHost: e2b.url, timeoutS: 600 })
    const handle = await driver.create('sbx_c', 'alice', {}, { gpuIds: [] })
    const done = await bootstrap(driver, 'sbx_c', handle, { setupCommands: ['echo hi > /workspace/ok'] }, { secret: 's'.repeat(32), dshRuntime: null, startTimeoutMs: 30_000 })
    expect(done.provisioned).toBe('true')
    // Health went through the sandbox host with the sandbox's token, and the Connect calls after it too.
    expect(e2b.log.some((l) => l.startsWith('GET /health'))).toBe(true)
    expect(e2b.log.some((l) => l.includes('/process.Process/'))).toBe(true)
  }, 180_000)
})
