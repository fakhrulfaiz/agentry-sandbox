import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSandboxService, validateLimits } from '../src/sandboxes.ts'
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
    const again = createSandboxService({ store: svc.store, backend: svc.backend, config: svc.config })
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
