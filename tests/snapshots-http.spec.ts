import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSandboxApi } from '../src/client/index.ts'
import { loadConfig } from '../src/config.ts'
import { startTestService, type TestService } from '../src/testing.ts'
import { KEY, startServer, type TestServer } from './support/server.ts'
import { localEnvd } from './support/local-envd.ts'

const adminKey = randomBytes(16).toString('hex')
const baseEnv = { AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${createHash('sha256').update(KEY).digest('hex')}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32), AGENTRY_SANDBOX_ADMIN_KEYS: `sha256:${createHash('sha256').update(adminKey).digest('hex')}` }

let s: TestServer | undefined
let root: string | undefined
afterEach(async () => {
  await s?.close()
  s = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function withSnapshots(env: Record<string, string> = {}, folder = true) {
  root = await mkdtemp(join(tmpdir(), 'snaphttp-'))
  const config = loadConfig({ ...baseEnv, ...(folder ? { AGENTRY_SANDBOX_SNAPSHOT_DIR: join(root, 'snaps') } : {}), ...env })
  s = await startServer({}, { config, envdClient: () => localEnvd() })
  Object.assign(s.backend, { agentUser: userInfo().username })
  const ws = join(root, 'ws')
  await mkdir(ws)
  const box = await (await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'b' }) })).json() as { id: string }
  // The sandbox's workspace is a local folder so the stand-in envd can tar it.
  const rec = (await s.store.sandboxes.get(box.id, 'alice'))!
  await s.store.sandboxes.update(box.id, 'alice', { template: { ...rec.template, workspacePath: ws } })
  return { box, ws }
}
const waitReady = async (id: string, owner = 'alice') => {
  for (let i = 0; i < 200; i++) {
    const r = await (await s!.call(`/v1/snapshots/${id}`, { owner })).json() as { state: string }
    if (r.state !== 'saving') return r
    await new Promise((r2) => setTimeout(r2, 25))
  }
  throw new Error('still saving')
}

describe('snapshot routes', () => {
  it('202 saving, then ready; list, get, restore, delete; no secrets or handles in the wire shape', async () => {
    const { box, ws } = await withSnapshots()
    await writeFile(join(ws, 'a.txt'), 'one')
    const res = await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { method: 'POST', body: JSON.stringify({ name: 'first' }) })
    expect(res.status).toBe(202)
    const snap = await res.json() as Record<string, unknown>
    expect(snap).toMatchObject({ object: 'snapshot', sandbox_id: box.id, level: 'workspace', name: 'first', state: 'saving', place: 'service', size_bytes: null })
    expect(snap).not.toHaveProperty('handle')
    expect(snap).not.toHaveProperty('owner')
    const ready = await waitReady(snap.id as string)
    expect(ready).toMatchObject({ state: 'ready' })
    expect((ready as unknown as { size_bytes: number }).size_bytes).toBeGreaterThan(0)

    const list = await (await s!.call('/v1/snapshots')).json() as { data: { id: string }[] }
    expect(list.data.map((x) => x.id)).toEqual([snap.id])
    expect((await (await s!.call(`/v1/snapshots?sandbox=${box.id}`)).json() as { data: unknown[] }).data).toHaveLength(1)
    expect((await (await s!.call('/v1/snapshots?sandbox=sbx_other')).json() as { data: unknown[] }).data).toHaveLength(0)

    await writeFile(join(ws, 'a.txt'), 'two')
    const restored = await s!.call(`/v1/sandboxes/${box.id}/restore`, { method: 'POST', body: JSON.stringify({ snapshot: snap.id }) })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ id: box.id, state: 'running' })

    expect((await s!.call(`/v1/snapshots/${snap.id as string}`, { method: 'DELETE' })).status).toBe(204)
    expect((await s!.call(`/v1/snapshots/${snap.id as string}`)).status).toBe(404)
  })

  it('answers 404 for another owner, 400 for bad input and levels, 400 snapshots_off without a folder', async () => {
    const { box } = await withSnapshots()
    const snap = await (await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { method: 'POST', body: '{}' })).json() as { id: string }
    await waitReady(snap.id)
    expect((await s!.call(`/v1/snapshots/${snap.id}`, { owner: 'bob' })).status).toBe(404)
    expect((await s!.call(`/v1/snapshots/${snap.id}`, { owner: 'bob', method: 'DELETE' })).status).toBe(404)
    expect((await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { owner: 'bob', method: 'POST', body: '{}' })).status).toBe(404)
    const bad = await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { method: 'POST', body: JSON.stringify({ level: 'tape' }) })
    expect(bad.status).toBe(400)
    const memory = await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { method: 'POST', body: JSON.stringify({ level: 'memory' }) })
    expect(memory.status).toBe(400)
    expect((await memory.json() as { error: { message: string } }).error.message).toMatch(/cannot take memory snapshots/)
    expect((await s!.call(`/v1/sandboxes/${box.id}/restore`, { method: 'POST', body: JSON.stringify({ snapshot: 'nope' }) })).status).toBe(400)
    expect((await s!.call(`/v1/sandboxes/${box.id}/restore`, { owner: 'bob', method: 'POST', body: JSON.stringify({ snapshot: snap.id }) })).status).toBe(404)
    await s!.close()
    await rm(root!, { recursive: true, force: true })

    const off = await withSnapshots({}, false)
    const res = await s!.call(`/v1/sandboxes/${off.box.id}/snapshots`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'snapshots_off', message: expect.stringContaining('AGENTRY_SANDBOX_SNAPSHOT_DIR') } })
  })

  it('a snapshot still saving cannot be restored (409); /v1/backends lists the levels; creating from a snapshot works', async () => {
    const { box, ws } = await withSnapshots()
    const levels = await (await s!.call('/v1/backends')).json() as { data: { snapshots: string[] }[] }
    expect(levels.data[0]!.snapshots).toEqual(['workspace'])
    await writeFile(join(ws, 'a.txt'), 'one')
    const snap = await (await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { method: 'POST', body: '{}' })).json() as { id: string }
    await waitReady(snap.id)
    await s!.store.snapshots.update(snap.id, 'alice', { state: 'saving' })
    const early = await s!.call(`/v1/sandboxes/${box.id}/restore`, { method: 'POST', body: JSON.stringify({ snapshot: snap.id }) })
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ error: { code: 'snapshot_not_ready' } })
    await s!.store.snapshots.update(snap.id, 'alice', { state: 'ready' })
    const ws2 = join(root!, 'ws2')
    await mkdir(ws2)
    const made = await s!.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'copy', snapshot: snap.id, workspace_path: ws2 }) })
    expect(made.status).toBe(201)
    expect(await (await import('node:fs/promises')).readFile(join(ws2, 'a.txt'), 'utf8')).toBe('one')
    // A snapshot id that is not one is a 400 before anything is made.
    expect((await s!.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'x', snapshot: 'abc' }) })).status).toBe(400)
  })
})

describe('admin snapshots', () => {
  let svc: TestService | undefined
  afterEach(async () => { await svc?.close(); svc = undefined })

  it('lists every owner\'s snapshots and deletes any; an API key is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snapadmin-'))
    try {
      svc = await startTestService({ AGENTRY_SANDBOX_ADMIN_KEYS: baseEnv.AGENTRY_SANDBOX_ADMIN_KEYS, AGENTRY_SANDBOX_SNAPSHOT_DIR: dir })
      const base = { id: `snap_${'1'.repeat(32)}`, sandboxId: 'sbx_1', place: 'service', level: 'workspace' as const, name: 'a', state: 'ready' as const, handle: { file: 'x' }, handleSecrets: null, sizeBytes: 5, error: null, createdAt: 5000, expiresAt: null }
      await svc.store.snapshots.insert({ ...base, owner: 'alice' })
      await svc.store.snapshots.insert({ ...base, id: `snap_${'2'.repeat(32)}`, owner: 'bob', createdAt: 9000 })
      const admin = (path: string, init: RequestInit = {}) => fetch(`${svc!.url}${path}`, { ...init, headers: { authorization: `Bearer ${adminKey}` } })
      const all = await (await admin('/v1/admin/snapshots')).json() as { data: { owner: string; id: string }[] }
      expect(all.data.map((x) => x.owner)).toEqual(['bob', 'alice'])
      expect((await fetch(`${svc.url}/v1/admin/snapshots`, { headers: { authorization: `Bearer ${svc.key}` } })).status).toBe(401)
      expect((await admin(`/v1/admin/snapshots/${base.id}`, { method: 'DELETE' })).status).toBe(200)
      expect((await admin(`/v1/admin/snapshots/${base.id}`, { method: 'DELETE' })).status).toBe(404)
      expect(await svc.store.snapshots.get(base.id, 'alice')).toBeUndefined()
      expect(await (await fetch(`${svc.url}/admin`)).text()).toContain('Snapshots')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('client', () => {
  it('maps the snapshot calls to the routes', async () => {
    const seen: string[] = []
    const api = createSandboxApi({ url: 'http://x', key: 'k', owner: 'alice', fetch: (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${new URL(url).pathname}${new URL(url).search}`)
      return new Response(init?.method === 'DELETE' ? null : JSON.stringify({ data: [] }), { status: init?.method === 'DELETE' ? 204 : 200 })
    }) as unknown as typeof fetch })
    await api.snapshot('sbx_1', { level: 'disk' })
    await api.listSnapshots({ sandbox: 'sbx_1' })
    await api.getSnapshot('snap_1')
    await api.restore('sbx_1', 'snap_1')
    await api.deleteSnapshot('snap_1')
    expect(seen).toEqual(['POST /v1/sandboxes/sbx_1/snapshots', 'GET /v1/snapshots?sandbox=sbx_1', 'GET /v1/snapshots/snap_1', 'POST /v1/sandboxes/sbx_1/restore', 'DELETE /v1/snapshots/snap_1'])
  })
})
