import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { sealSecrets } from '../src/crypto/secrets.ts'
import { createE2bDriver, e2bFactory } from '../src/places/drivers/e2b.ts'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { createPlaceRegistry } from '../src/places/registry.ts'
import { createSandboxService, LimitError } from '../src/sandboxes.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { startTestService, type TestService } from '../src/testing.ts'
import { startFakeE2b } from './support/fake-e2b.ts'
import { createHash, randomBytes } from 'node:crypto'

const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(cfg: Record<string, unknown> = {}) {
  const e2b = await startFakeE2b()
  cleanups.push(() => e2b.close())
  const store = createMemoryStore()
  const t = Date.now()
  await store.places.insert({ id: 'place_e2b', name: 'E2B', kind: 'e2b', config: { template: 'tpl-1', api_url: e2b.url, sandbox_host: e2b.url, timeout_s: 600, ...cfg }, secrets: sealSecrets(config.secret, { api_key: e2b.apiKey }), enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: t, updatedAt: t })
  const places = await createPlaceRegistry({ store, config, local: createFakeDriver(), drivers: { e2b: e2bFactory({ retryDelayMs: 0 }) } })
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
    expect(posted!.body).toEqual({ templateID: 'tpl-1', timeout: 600, autoPause: true, metadata: { 'agentry.sandbox.id': s.id, 'agentry.sandbox.owner': 'alice' }, envVars: { A: '1' }, allow_internet_access: false })
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
    const driver = createE2bDriver({ apiKey: e2b.apiKey, template: 't', apiUrl: e2b.url, sandboxHost: e2b.url, timeoutS: 600 }, { retryDelayMs: 0 })
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
    e2b.sandboxes.set('foreign', { sandboxID: 'foreign', state: 'running', envdAccessToken: 'x', metadata: {}, body: {}, timeout: 0 })
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
})

