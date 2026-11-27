import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type SandboxConfig } from '../src/config.ts'
import { createFakeDriver, type FakeDriver } from '../src/places/drivers/fake.ts'
import { createPlaceRegistry } from '../src/places/registry.ts'
import { createSandboxService, LimitError, NotFoundError, QuotaExceededError, SnapshotNotReadyError, SnapshotsOffError } from '../src/sandboxes.ts'
import { snapshotFile } from '../src/snapshots/files.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import type { SnapshotRecord } from '../src/store/types.ts'
import { localEnvd } from './support/local-envd.ts'

const baseEnv = { AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32), AGENTRY_SANDBOX_MAX_CREATES_PER_HOUR: '1000', AGENTRY_SANDBOX_MAX_RUNNING_PER_OWNER: '10' }
const remoteRecord = { id: 'remote', name: 'Remote', kind: 'fake', config: {}, secrets: null, enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: 1, updatedAt: 1 }
const noBootstrap = async (_d: unknown, _i: string, h: Record<string, string>) => h

/** Fake places whose commands run on this machine: a sandbox's workspace is a folder under `root`. */
async function setup(env: Record<string, string> = {}, opts: { snapshotDir?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'snapsvc-'))
  const snapDir = join(root, 'snaps')
  const config: SandboxConfig = loadConfig({ ...baseEnv, ...(opts.snapshotDir === false ? {} : { AGENTRY_SANDBOX_SNAPSHOT_DIR: snapDir }), ...env })
  const store = createMemoryStore()
  const me = userInfo().username
  const local: FakeDriver = Object.assign(createFakeDriver(), { agentUser: me })
  const remote: FakeDriver = Object.assign(createFakeDriver(), { agentUser: me })
  await store.places.insert(remoteRecord)
  const places = await createPlaceRegistry({ store, config, local, drivers: { fake: () => remote } })
  let t = 1_000_000
  const service = createSandboxService({ store, places, config, provision: noBootstrap, envdClient: () => localEnvd(), now: () => t })
  let n = 0
  const make = async (owner: string, place = 'local') => {
    const ws = join(root, `ws${String(++n)}`)
    await mkdir(ws, { recursive: true })
    const box = await service.create(owner, { name: `box${String(n)}`, place, template: { workspacePath: ws } })
    return { box, ws }
  }
  const ready = async (owner: string, snap: SnapshotRecord): Promise<SnapshotRecord> => {
    for (let i = 0; i < 200; i++) {
      const s = await service.getSnapshot(owner, snap.id)
      if (s.state !== 'saving') return s
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('snapshot stayed saving')
  }
  return { root, snapDir, config, store, local, remote, service, make, ready, advance: (ms: number) => { t += ms } }
}

describe('snapshots', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  afterEach(async () => { await rm(ctx.root, { recursive: true, force: true }) })

  it('snapshot then restore in place', async () => {
    ctx = await setup()
    const { service, make, ready } = ctx
    const { box, ws } = await make('alice')
    await writeFile(join(ws, 'a.txt'), 'one')
    const saving = await service.snapshot('alice', box.id, { name: 'first' })
    expect(saving).toMatchObject({ state: 'saving', level: 'workspace', place: 'service', name: 'first', sandboxId: box.id })
    const snap = await ready('alice', saving)
    expect(snap).toMatchObject({ state: 'ready', error: null })
    expect(snap.sizeBytes).toBeGreaterThan(0)
    expect(existsSync(snapshotFile(ctx.snapDir, snap.id))).toBe(true)

    await writeFile(join(ws, 'a.txt'), 'two')
    await writeFile(join(ws, 'extra.txt'), 'x')
    const after = await service.restore('alice', box.id, snap.id)
    expect(after.state).toBe('running')
    expect(await readFile(join(ws, 'a.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(ws, 'extra.txt'))).toBe(false)
  })

  it('a stopped sandbox is started for the snapshot and stopped again; restore works on a stopped one', async () => {
    ctx = await setup()
    const { service, make, ready } = ctx
    const { box, ws } = await make('alice')
    await writeFile(join(ws, 'a.txt'), 'one')
    await service.stop('alice', box.id)
    const snap = await ready('alice', await service.snapshot('alice', box.id))
    expect(snap.state).toBe('ready')
    expect((await service.get('alice', box.id)).state).toBe('stopped')
    await writeFile(join(ws, 'a.txt'), 'two')
    await service.restore('alice', box.id, snap.id)
    expect((await service.get('alice', box.id)).state).toBe('stopped')
    expect(await readFile(join(ws, 'a.txt'), 'utf8')).toBe('one')
  })

  it('new sandbox from a workspace snapshot on another place keeps the template files', async () => {
    ctx = await setup()
    const { service, make, ready, root } = ctx
    const { box, ws } = await make('alice')
    await writeFile(join(ws, 'data.txt'), 'from the snapshot')
    const snap = await ready('alice', await service.snapshot('alice', box.id))
    const ws2 = join(root, 'ws-new')
    await mkdir(ws2)
    await writeFile(join(ws2, 'template.txt'), 'from the template')
    const made = await service.create('alice', { name: 'copy', place: 'remote', snapshot: snap.id, template: { workspacePath: ws2 } })
    expect(made).toMatchObject({ state: 'running', backend: 'remote' })
    expect(await readFile(join(ws2, 'data.txt'), 'utf8')).toBe('from the snapshot')
    expect(await readFile(join(ws2, 'template.txt'), 'utf8')).toBe('from the template')
  })

  it('a level the place lacks is 400 naming it; workspace without a folder is snapshots_off', async () => {
    ctx = await setup()
    const { service, make } = ctx
    const { box } = await make('alice')
    await expect(service.snapshot('alice', box.id, { level: 'memory' })).rejects.toThrow(/cannot take memory snapshots.*workspace/)
    await expect(service.snapshot('alice', box.id, { level: 'memory' })).rejects.toBeInstanceOf(LimitError)
    await expect(service.snapshot('alice', box.id, { level: 'bogus' as never })).rejects.toBeInstanceOf(LimitError)
    await rm(ctx.root, { recursive: true, force: true })
    ctx = await setup({}, { snapshotDir: false })
    const off = await ctx.make('alice')
    await expect(ctx.service.snapshot('alice', off.box.id)).rejects.toBeInstanceOf(SnapshotsOffError)
    await expect(ctx.service.snapshot('alice', off.box.id)).rejects.toThrow('AGENTRY_SANDBOX_SNAPSHOT_DIR')
  })

  it('restore with another owner\'s snapshot is 404, and so is snapshotting another owner\'s sandbox', async () => {
    ctx = await setup()
    const { service, make, ready } = ctx
    const a = await make('alice')
    const b = await make('bob')
    const snap = await ready('alice', await service.snapshot('alice', a.box.id))
    await expect(service.restore('bob', b.box.id, snap.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.restore('alice', b.box.id, snap.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.snapshot('bob', a.box.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.getSnapshot('bob', snap.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.deleteSnapshot('bob', snap.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.create('bob', { name: 'x', snapshot: snap.id })).rejects.toBeInstanceOf(NotFoundError)
    expect(await service.listSnapshots('bob')).toEqual([])
    expect(await existsSync(snapshotFile(ctx.snapDir, snap.id))).toBe(true)
  })

  it('the per-owner limit is 429; failed snapshots do not count', async () => {
    ctx = await setup({ AGENTRY_SANDBOX_MAX_SNAPSHOTS_PER_OWNER: '2' })
    const { service, make, ready } = ctx
    const { box } = await make('alice')
    await ready('alice', await service.snapshot('alice', box.id))
    await ready('alice', await service.snapshot('alice', box.id))
    await expect(service.snapshot('alice', box.id)).rejects.toBeInstanceOf(QuotaExceededError)
    await expect(service.snapshot('alice', box.id)).rejects.toThrow(/limit 2/)
    const other = await make('bob')
    expect((await ready('bob', await service.snapshot('bob', other.box.id))).state).toBe('ready')
  })

  it('deleting the sandbox keeps its snapshots, which still restore into a new sandbox', async () => {
    ctx = await setup()
    const { service, make, ready } = ctx
    const { box, ws } = await make('alice')
    await writeFile(join(ws, 'a.txt'), 'kept')
    const snap = await ready('alice', await service.snapshot('alice', box.id))
    await service.destroy('alice', box.id)
    expect((await service.listSnapshots('alice', { sandboxId: box.id })).map((s) => s.id)).toEqual([snap.id])
    const ws2 = join(ctx.root, 'ws-again')
    await mkdir(ws2)
    await service.create('alice', { name: 'again', snapshot: snap.id, template: { workspacePath: ws2 } })
    expect(await readFile(join(ws2, 'a.txt'), 'utf8')).toBe('kept')
  })

  it('expired snapshots are swept, their files removed', async () => {
    ctx = await setup({ AGENTRY_SANDBOX_SNAPSHOT_DAYS: '1' })
    const { service, make, ready, advance } = ctx
    const { box } = await make('alice')
    const old = await ready('alice', await service.snapshot('alice', box.id))
    expect(old.expiresAt).toBe(1_000_000 + 86_400_000)
    advance(86_400_000 / 2)
    const fresh = await ready('alice', await service.snapshot('alice', box.id))
    advance(86_400_000 / 2 + 1)
    expect(await service.sweepSnapshots()).toEqual([old.id])
    expect(existsSync(snapshotFile(ctx.snapDir, old.id))).toBe(false)
    expect(existsSync(snapshotFile(ctx.snapDir, fresh.id))).toBe(true)
    expect((await service.listSnapshots('alice')).map((s) => s.id)).toEqual([fresh.id])
  })

  it('days = 0 keeps snapshots until they are deleted', async () => {
    ctx = await setup({ AGENTRY_SANDBOX_SNAPSHOT_DAYS: '0' })
    const { box } = await ctx.make('alice')
    expect((await ctx.ready('alice', await ctx.service.snapshot('alice', box.id))).expiresAt).toBeNull()
  })

  it('a failed snapshot is marked failed with its reason and its file removed', async () => {
    ctx = await setup({ AGENTRY_SANDBOX_SNAPSHOT_MAX_MB: '1' })
    const { service, make, ready } = ctx
    const { box, ws } = await make('alice')
    // Incompressible data past the 1 MB limit.
    const { randomBytes } = await import('node:crypto')
    await writeFile(join(ws, 'noise.bin'), randomBytes(3 * 1024 * 1024))
    const snap = await ready('alice', await service.snapshot('alice', box.id))
    expect(snap.state).toBe('failed')
    expect(snap.error).toMatch(/larger than the snapshot limit \(1 MB\)/)
    expect(await readdir(ctx.snapDir)).toEqual([])
  })

  it('deleting a snapshot removes its file; a restore of one that is still saving is refused', async () => {
    ctx = await setup()
    const { service, make, ready, store } = ctx
    const { box } = await make('alice')
    const snap = await ready('alice', await service.snapshot('alice', box.id))
    await service.deleteSnapshot('alice', snap.id)
    expect(existsSync(snapshotFile(ctx.snapDir, snap.id))).toBe(false)
    expect(await store.snapshots.get(snap.id, 'alice')).toBeUndefined()
    await store.snapshots.insert({ ...snap, id: `snap_${'c'.repeat(32)}`, state: 'saving' })
    await expect(service.restore('alice', box.id, `snap_${'c'.repeat(32)}`)).rejects.toBeInstanceOf(SnapshotNotReadyError)
  })

  it('recoverSnapshots marks saves interrupted by a restart as failed and clears partial files', async () => {
    ctx = await setup()
    const { service, store, snapDir } = ctx
    const id = `snap_${'d'.repeat(32)}`
    await mkdir(snapDir, { recursive: true })
    await writeFile(`${snapshotFile(snapDir, id)}.part`, 'half')
    await store.snapshots.insert({ id, owner: 'alice', sandboxId: 'sbx_x', place: 'service', level: 'workspace', name: 'n', state: 'saving', handle: {}, handleSecrets: null, sizeBytes: null, error: null, createdAt: 1, expiresAt: null })
    await service.recoverSnapshots()
    expect(await store.snapshots.get(id, 'alice')).toMatchObject({ state: 'failed', error: expect.stringContaining('restarted') })
    expect(await readdir(snapDir)).toEqual([])
  })
})

describe('native snapshots (driver-made)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  afterEach(async () => { await rm(ctx.root, { recursive: true, force: true }) })

  it('takes a disk snapshot on the driver, seals its secret and restores it on the same place', async () => {
    ctx = await setup({}, { snapshotDir: false })
    ctx.local.setSnapshotLevels(['disk', 'memory'])
    const { service, make, ready, store, local } = ctx
    const { box } = await make('alice')
    expect(service.snapshotLevels('local')).toEqual(['disk', 'memory'])
    const snap = await ready('alice', await service.snapshot('alice', box.id, { level: 'disk', name: 'with packages' }))
    expect(snap).toMatchObject({ state: 'ready', level: 'disk', place: 'local', sizeBytes: 1234 })
    const raw = await store.snapshots.get(snap.id, 'alice')
    expect(raw?.handle).toEqual({ fakeSnapshot: snap.id })
    expect(raw?.handleSecrets).toEqual(expect.any(String))
    expect(JSON.stringify(raw)).not.toContain('"tok"')
    const restored = await service.restore('alice', box.id, snap.id)
    expect(restored.state).toBe('running')
    // The driver got its secret back, opened.
    expect(local.calls).toContain(`restoreSnapshot ${box.id} ${snap.id} tok`)
    await service.deleteSnapshot('alice', snap.id)
    expect(local.calls).toContain(`deleteSnapshot ${snap.id}`)
    expect(local.snapshots.size).toBe(0)
  })

  it('a disk snapshot restores only on its own place, and a new sandbox from it runs there', async () => {
    ctx = await setup()
    ctx.local.setSnapshotLevels(['disk'])
    ctx.remote.setSnapshotLevels(['disk'])
    const { service, make, ready, local, remote } = ctx
    const { box } = await make('alice')
    const snap = await ready('alice', await service.snapshot('alice', box.id, { level: 'disk' }))
    const other = await make('alice', 'remote')
    await expect(service.restore('alice', other.box.id, snap.id)).rejects.toThrow(/kept on place 'local'/)
    await expect(service.create('alice', { name: 'x', snapshot: snap.id, place: 'remote' })).rejects.toThrow(/must run there/)
    const made = await service.create('alice', { name: 'from disk', snapshot: snap.id })
    expect(made).toMatchObject({ backend: 'local', state: 'running' })
    expect(local.calls).toContain(`createFromSnapshot ${made.id} ${snap.id}`)
    expect(remote.calls.some((c) => c.startsWith('createFromSnapshot'))).toBe(false)
  })

  it('stop_first stops the sandbox, snapshots and starts it again', async () => {
    ctx = await setup({}, { snapshotDir: false })
    ctx.local.setSnapshotLevels(['disk'])
    const { service, make, ready, local } = ctx
    const { box } = await make('alice')
    local.calls.length = 0
    const snap = await ready('alice', await service.snapshot('alice', box.id, { level: 'disk', stopFirst: true }))
    expect(snap.state).toBe('ready')
    expect(local.calls.filter((c) => /^(stop|snapshot|start) /.test(c)).map((c) => c.split(' ')[0])).toEqual(['stop', 'snapshot', 'start'])
    expect((await service.get('alice', box.id)).state).toBe('running')
  })

  it('a driver failure marks the snapshot failed with the reason', async () => {
    ctx = await setup({}, { snapshotDir: false })
    ctx.local.setSnapshotLevels(['disk'])
    const { service, make, ready, local } = ctx
    const { box } = await make('alice')
    local.failNextSnapshot('docker commit failed: no space left')
    const snap = await ready('alice', await service.snapshot('alice', box.id, { level: 'disk' }))
    expect(snap).toMatchObject({ state: 'failed', error: 'docker commit failed: no space left' })
  })
})
