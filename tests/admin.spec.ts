import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSandboxService, validateLimits } from '../src/sandboxes.ts'
import { readFileSync } from 'node:fs'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { startTestService, type TestService } from '../src/testing.ts'

const adminKey = randomBytes(16).toString('hex')
const ADMIN = { AGENTRY_SANDBOX_ADMIN_KEYS: `sha256:${createHash('sha256').update(adminKey).digest('hex')}`, AGENTRY_SANDBOX_MAX_PER_OWNER: '3' }
let svc: TestService | undefined
afterEach(async () => { await svc?.close(); svc = undefined })

const admin = (s: TestService, path: string, init: RequestInit = {}) =>
  fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
const asOwner = (s: TestService, owner: string, path: string, init: RequestInit = {}) =>
  fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${s.key}`, 'x-agentry-owner': owner, 'content-type': 'application/json' } })

describe('admin surface', () => {
  it('is off without admin keys: the page says how to turn it on and the API answers 404', async () => {
    svc = await startTestService()
    const page = await fetch(`${svc.url}/admin`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('AGENTRY_SANDBOX_ADMIN_KEYS')
    expect((await fetch(`${svc.url}/v1/admin/overview`, { headers: { authorization: `Bearer ${svc.key}` } })).status).toBe(404)
  })

  it('serves the page with a strict content policy, and keeps admin and API keys apart', async () => {
    svc = await startTestService(ADMIN)
    const page = await fetch(`${svc.url}/admin`)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await page.text()).toContain('Sandbox admin')
    expect((await fetch(`${svc.url}/v1/admin/overview`, { headers: { authorization: `Bearer ${svc.key}` } })).status).toBe(401)
    expect((await fetch(`${svc.url}/v1/sandboxes`, { headers: { authorization: `Bearer ${adminKey}`, 'x-agentry-owner': 'a' } })).status).toBe(401)
    expect((await admin(svc, '/v1/admin/overview')).status).toBe(200)
  })

  it('offers the SSH machine place kind with its no-isolation warning', async () => {
    svc = await startTestService(ADMIN)
    const html = await (await fetch(`${svc.url}/admin`)).text()
    expect(html).toContain('value="ssh-machine">Machine over SSH')
    expect(html).toContain('No isolation between sandboxes. Requires passwordless sudo and iptables.')
  })

  it('lists every owner and starts, stops and deletes any sandbox', async () => {
    svc = await startTestService(ADMIN)
    const a = await (await asOwner(svc, 'alice', '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'a1' }) })).json() as { id: string }
    await asOwner(svc, 'bob', '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'b1' }) })
    const all = await (await admin(svc, '/v1/admin/sandboxes')).json() as { data: { owner: string; name: string }[] }
    expect(all.data.map((s) => [s.owner, s.name]).sort()).toEqual([['alice', 'a1'], ['bob', 'b1']])
    const overview = await (await admin(svc, '/v1/admin/overview')).json() as { counts: { total: number; owners: number; running: number } }
    expect(overview.counts).toMatchObject({ total: 2, owners: 2, running: 2 })
    expect(await (await admin(svc, `/v1/admin/sandboxes/${a.id}/stop`, { method: 'POST' })).json()).toMatchObject({ state: 'stopped', owner: 'alice' })
    expect(await (await admin(svc, `/v1/admin/sandboxes/${a.id}/start`, { method: 'POST' })).json()).toMatchObject({ state: 'running' })
    expect((await admin(svc, `/v1/admin/sandboxes/${a.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await asOwner(svc, 'alice', `/v1/sandboxes/${a.id}`)).status).toBe(404)
    expect((await admin(svc, '/v1/admin/sandboxes/sbx_nope/stop', { method: 'POST' })).status).toBe(404)
  })

  it('changes limits live, keeps them across a restart, and resets to the environment', async () => {
    svc = await startTestService(ADMIN)
    const before = await (await admin(svc, '/v1/admin/limits')).json() as { limits: { maxPerOwner: number }; defaults: { maxPerOwner: number }; overrides: object }
    expect(before).toMatchObject({ limits: { maxPerOwner: 3 }, defaults: { maxPerOwner: 3 }, overrides: {} })
    const saved = await (await admin(svc, '/v1/admin/limits', { method: 'PUT', body: JSON.stringify({ overrides: { maxPerOwner: 1, owners: { vip: { maxPerOwner: 4 } } } }) })).json()
    expect(saved).toMatchObject({ limits: { maxPerOwner: 1, owners: { vip: { maxPerOwner: 4 } } }, overrides: { maxPerOwner: 1 } })
    // Applies at once: a second sandbox for an ordinary owner is refused, the VIP gets more.
    expect((await asOwner(svc, 'carol', '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'c1' }) })).status).toBe(201)
    const refused = await asOwner(svc, 'carol', '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'c2' }) })
    expect(refused.status).toBe(429)
    expect(JSON.stringify(await refused.json())).toContain('limit 1')
    for (const n of [1, 2]) expect((await asOwner(svc, 'vip', '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: `v${n}` }) })).status).toBe(201)

    // A restart (a new service over the same store) reads the saved overrides back.
    const again = createSandboxService({ store: svc.store, places: svc.places, config: svc.config, provision: async (_d, _i, h) => h })
    await again.loadSettings()
    expect(again.limits().maxPerOwner).toBe(1)

    const reset = await (await admin(svc, '/v1/admin/limits', { method: 'DELETE' })).json()
    expect(reset).toMatchObject({ limits: { maxPerOwner: 3 }, overrides: {} })
    expect(await svc.store.settings.get('limits')).toBeUndefined()
  })

  it('refuses bad limits with the field named', async () => {
    svc = await startTestService(ADMIN)
    const bad = await admin(svc, '/v1/admin/limits', { method: 'PUT', body: JSON.stringify({ overrides: { maxPerOwner: -1 } }) })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toContain('maxPerOwner')
    expect(() => validateLimits({ maxCpus: 0 })).toThrow(/maxCpus/)
    expect(() => validateLimits({ nope: 1 })).toThrow(/not a limit/)
    expect(() => validateLimits({ owners: { bob: { maxTotal: 3 } } })).toThrow(/not a per-owner limit/)
    expect(validateLimits({ maxCpus: 1.5, owners: { bob: { maxRunningPerOwner: 0 } } })).toEqual({ maxCpus: 1.5, owners: { bob: { maxRunningPerOwner: 0 } } })
  })
})

const KEY = 'SHA256:' + 'A'.repeat(43)
const fakeKind = () => ({ 'fake-ssh': () => Object.assign(createFakeDriver(), { kind: 'fake-ssh', observedHostKey: () => KEY }) })
const post = (s: TestService, path: string, body: unknown, method = 'POST') => admin(s, path, { method, body: JSON.stringify(body) })

describe('admin places', () => {
  it('admin create never echoes secrets', async () => {
    svc = await startTestService(ADMIN, undefined, fakeKind())
    const tested = await (await post(svc, '/v1/admin/places/test', { kind: 'fake-ssh', config: { url: 'ssh://u@h' }, secrets: { private_key: 'TOPSECRET' } })).json()
    expect(tested).toMatchObject({ ok: true, host_key: KEY })
    const r = await post(svc, '/v1/admin/places', { name: 'Box', kind: 'fake-ssh', config: { url: 'ssh://u@h' }, secrets: { private_key: 'TOPSECRET' }, host_key: KEY })
    expect(r.status).toBe(201)
    const text = JSON.stringify(await r.json())
    expect(text).not.toContain('TOPSECRET')
    expect(JSON.parse(text)).toMatchObject({ name: 'Box', kind: 'fake-ssh', has_secrets: true, config: { host_key: KEY }, available: true, sandboxes: 0 })
    const listed = await (await admin(svc, '/v1/admin/places')).text()
    expect(listed).not.toContain('TOPSECRET')
    expect(JSON.parse(listed).data.map((p: { id: string }) => p.id)).toContain('local')
    const stored = await svc.store.places.list()
    expect(JSON.stringify(stored)).not.toContain('TOPSECRET')
    expect((await post(svc, '/v1/admin/places', { name: 'X', kind: 'nope', config: {} })).status).toBe(400)
  })

  it('a plain Save refreshes place GPUs with the stored key', async () => {
    const RTX = { index: 0, uuid: 'GPU-rtx', name: 'NVIDIA GeForce RTX 3070' }
    let probes = 0
    svc = await startTestService(ADMIN, undefined, {
      'fake-ssh': () => Object.assign(createFakeDriver(), {
        kind: 'fake-ssh',
        observedHostKey: () => KEY,
        discoverGpus: async () => { probes += 1; return [RTX] },
      }),
    })
    const created = await (await post(svc, '/v1/admin/places', { name: 'Box', kind: 'fake-ssh', config: { url: 'ssh://u@h' }, secrets: { private_key: 'TOPSECRET' }, host_key: KEY })).json() as { id: string }
    expect(created).toMatchObject({ gpus: { count: 1, models: ['NVIDIA GeForce RTX 3070'] } })
    probes = 0
    const saved = await post(svc, `/v1/admin/places/${created.id}`, { name: 'Renamed' }, 'PUT')
    expect(saved.status).toBe(200)
    expect(probes).toBe(1)
    expect(await saved.json()).toMatchObject({ gpus: { count: 1, models: ['NVIDIA GeForce RTX 3070'] } })
  })

  it('admin delete of a place with sandboxes answers 409 place_in_use', async () => {
    svc = await startTestService(ADMIN, undefined, fakeKind())
    const created = await (await post(svc, '/v1/admin/places', { name: 'Box', kind: 'fake-ssh', config: {} })).json() as { id: string }
    const sbx = await asOwner(svc, 'alice', '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 's', place: created.id }) })
    expect(sbx.status).toBe(201)
    const id = ((await sbx.json()) as { id: string }).id
    const refused = await admin(svc, `/v1/admin/places/${created.id}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('place_in_use')
    await asOwner(svc, 'alice', `/v1/sandboxes/${id}`, { method: 'DELETE' })
    expect((await admin(svc, `/v1/admin/places/${created.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('admin cannot delete local', async () => {
    svc = await startTestService(ADMIN)
    const r = await admin(svc, '/v1/admin/places/local', { method: 'DELETE' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
  })

  it('admin page has a Places section and an add-place form with a host key confirmation step', async () => {
    svc = await startTestService(ADMIN)
    const html = await (await fetch(`${svc.url}/admin`)).text()
    for (const id of ['id="places"', 'id="place-form"', 'id="place-hostkey-confirm"']) expect(html).toContain(id)
    expect(readFileSync(new URL('../src/admin/index.html', import.meta.url), 'utf8')).toContain('Docker over SSH')
  })
})
