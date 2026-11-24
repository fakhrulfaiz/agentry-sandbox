import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../src/backends/fake.ts'
import { loadConfig } from '../src/config.ts'
import { envdToken } from '../src/envd/token.ts'
import { BackendUnavailableError, createSandboxService, NotFoundError } from '../src/sandboxes.ts'
import { createMemoryStore } from '../src/store/memory.ts'

const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })

function setup() {
  let t = 1_000_000
  const store = createMemoryStore()
  const backend = createFakeBackend()
  const service = createSandboxService({ store, backend, config, now: () => t })
  return { store, backend, service, advance: (ms: number) => { t += ms } }
}

describe('sandbox service', () => {
  it('create snapshots the template and records running', async () => {
    const { store, service } = setup()
    const tpl = { id: `tpl_${'1'.repeat(32)}`, owner: 'alice', name: 'py', spec: { image: 'python:3.13', packages: ['jq'] }, createdAt: 1, updatedAt: 1 }
    await store.templates.insert(tpl)
    const s = await service.create('alice', { name: 'box', templateId: tpl.id })
    expect(s.id).toMatch(/^sbx_[0-9a-f]{32}$/)
    expect(s).toMatchObject({ state: 'running', templateId: tpl.id, template: { image: 'python:3.13', packages: ['jq'] }, backend: 'fake' })
    // A later template edit does not change the sandbox's snapshot.
    await store.templates.update(tpl.id, 'alice', { spec: { image: 'node:24' } })
    expect((await service.get('alice', s.id)).template.image).toBe('python:3.13')
  })

  it('two concurrent starts start once', async () => {
    const { backend, service } = setup()
    const s = await service.create('alice', { name: 'box' })
    await service.stop('alice', s.id)
    backend.calls.length = 0
    const [a, b] = await Promise.all([service.start('alice', s.id), service.endpoint('alice', s.id)])
    expect(backend.calls.filter((c) => c.startsWith('start')).length).toBe(1)
    expect(a.state).toBe('running')
    expect(b.token).toBe(envdToken(config.secret, s.id))
  })

  it('sweepIdle stops sandboxes idle past idleStopMinutes and leaves recently touched ones', async () => {
    const { service, advance } = setup()
    const idle = await service.create('alice', { name: 'idle' })
    const busy = await service.create('alice', { name: 'busy' })
    advance(29 * 60_000)
    await service.touch('alice', busy.id)
    advance(2 * 60_000)
    expect(await service.sweepIdle()).toEqual([idle.id])
    expect((await service.get('alice', idle.id)).state).toBe('stopped')
    expect((await service.get('alice', busy.id)).state).toBe('running')
  })

  it('reset keeps or wipes the workspace and re-provisions', async () => {
    const { backend, service } = setup()
    const s = await service.create('alice', { name: 'box', template: { setupCommands: ['echo hi'] } })
    backend.calls.length = 0
    await service.reset('alice', s.id, { keepWorkspace: true })
    expect(backend.calls).toEqual([`destroy ${s.id} keep=true`, `create ${s.id}`])
    await service.reset('alice', s.id, { keepWorkspace: false })
    expect(backend.calls).toContain(`destroy ${s.id} keep=false`)
    expect((await service.get('alice', s.id)).state).toBe('running')
  })

  it('reconcile adopts labelled containers with records, marks records without containers missing, reports unknown ones', async () => {
    const { backend, service } = setup()
    const kept = await service.create('alice', { name: 'kept' })
    const lost = await service.create('alice', { name: 'lost' })
    backend.forget(lost.id)
    backend.adoptForeign('sbx_unknown', 'bob')
    const r = await service.reconcile()
    expect(r).toEqual({ adopted: [kept.id], missing: [lost.id], unknown: ['sbx_unknown'] })
    expect(await service.get('alice', lost.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('missing') })
  })

  it('another owner gets NotFoundError', async () => {
    const { service } = setup()
    const s = await service.create('alice', { name: 'box' })
    await expect(service.get('bob', s.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.endpoint('bob', s.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.destroy('bob', s.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.create('bob', { name: 'x', templateId: `tpl_${'9'.repeat(32)}` })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('a failed start records state failed with the reason', async () => {
    const { backend, service } = setup()
    const s = await service.create('alice', { name: 'box' })
    await service.stop('alice', s.id)
    backend.failNextStart('envd did not become healthy')
    await expect(service.start('alice', s.id)).rejects.toThrow('envd did not become healthy')
    expect(await service.get('alice', s.id)).toMatchObject({ state: 'failed', error: 'envd did not become healthy' })
  })

  it('an unavailable backend refuses with BackendUnavailableError', async () => {
    const { backend, service } = setup()
    backend.setAvailable(false, 'Docker is not reachable')
    await expect(service.create('alice', { name: 'box' })).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it('destroy removes the record and the sandbox', async () => {
    const { backend, service } = setup()
    const s = await service.create('alice', { name: 'box' })
    await service.destroy('alice', s.id)
    expect(backend.calls).toContain(`destroy ${s.id} keep=false`)
    await expect(service.get('alice', s.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('review fixes', () => {
  it('destroy during provisioning waits for the build and leaves nothing behind (I3)', async () => {
    const { backend, service } = setup()
    backend.setCreateDelay(50)
    const creating = service.create('alice', { name: 'slow' }).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 10))
    const [s] = await service.list('alice')
    await service.destroy('alice', s!.id)
    await creating
    expect(await backend.listManaged()).toEqual([])
    await expect(service.get('alice', s!.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('a failed create leaves nothing behind: no record and no backend leftovers (C1)', async () => {
    const { backend, service } = setup()
    backend.failNextCreate('setup command "exit 3" failed')
    await expect(service.create('alice', { name: 'bad' })).rejects.toThrow('exit 3')
    expect(await service.list('alice')).toEqual([])
    expect(backend.calls.some((c) => /^destroy sbx_\w+ keep=false$/.test(c))).toBe(true)
    // It does not count against the owner's limits.
    await expect(service.create('alice', { name: 'good' })).resolves.toMatchObject({ state: 'running' })
  })

  it('stop, destroy and endpoint answer BackendUnavailableError when Docker is unreachable (I2)', async () => {
    const { backend, service } = setup()
    const s = await service.create('alice', { name: 'box' })
    backend.failConnections('connect ECONNREFUSED /var/run/docker.sock')
    await expect(service.stop('alice', s.id)).rejects.toBeInstanceOf(BackendUnavailableError)
    await expect(service.endpoint('alice', s.id)).rejects.toBeInstanceOf(BackendUnavailableError)
    await expect(service.destroy('alice', s.id)).rejects.toBeInstanceOf(BackendUnavailableError)
    backend.failConnections(undefined)
    expect((await service.get('alice', s.id)).state).not.toBe('deleting')
  })

  it('the idle sweep skips a sandbox with an open connection and counts its close as use (I4)', async () => {
    const { service, advance } = setup()
    const s = await service.create('alice', { name: 'busy' })
    const done = service.beginUse(s.id)
    advance(31 * 60_000)
    expect(await service.sweepIdle()).toEqual([])
    done()
    expect(await service.sweepIdle()).toEqual([])
    advance(31 * 60_000)
    expect(await service.sweepIdle()).toEqual([s.id])
  })

  it('the sweep re-applies guard rules to running sandboxes (I8)', async () => {
    const { backend, service } = setup()
    const s = await service.create('alice', { name: 'box' })
    backend.calls.length = 0
    await service.sweepIdle()
    expect(backend.calls).toContain(`maintain ${s.id}`)
  })

  it("an owner's last sandbox removed releases the owner's network (I6)", async () => {
    const { backend, service } = setup()
    const a = await service.create('alice', { name: 'a' })
    const b = await service.create('alice', { name: 'b' })
    await service.destroy('alice', a.id)
    expect(backend.calls).not.toContain('releaseOwner alice')
    await service.destroy('alice', b.id)
    expect(backend.calls).toContain('releaseOwner alice')
  })
})

describe('limits', () => {
  const limited = (over: Partial<typeof config.limits>, owners: typeof config.limits.owners = {}) => {
    let t = 1_000_000
    const store = createMemoryStore()
    const backend = createFakeBackend()
    const service = createSandboxService({ store, backend, config: { ...config, limits: { ...config.limits, ...over, owners } }, now: () => t })
    return { backend, service, advance: (ms: number) => { t += ms } }
  }

  it('caps sandboxes per owner, per owner running, and lets per-owner overrides raise it', async () => {
    const { service } = limited({ maxPerOwner: 2, maxRunningPerOwner: 1 }, { bob: { maxPerOwner: 3, maxRunningPerOwner: 3 } })
    const a = await service.create('alice', { name: 'a' })
    await expect(service.create('alice', { name: 'b' })).rejects.toMatchObject({ name: 'QuotaExceededError', message: expect.stringContaining('running') })
    await service.stop('alice', a.id)
    const b = await service.create('alice', { name: 'b' })
    await expect(service.create('alice', { name: 'c' })).rejects.toMatchObject({ name: 'QuotaExceededError', message: expect.stringContaining('limit 2') })
    await expect(service.start('alice', a.id)).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await service.stop('alice', b.id)
    expect((await service.start('alice', a.id)).state).toBe('running')
    for (const n of ['1', '2', '3']) await service.create('bob', { name: n })
  })

  it('caps the whole service, running and total', async () => {
    const { service } = limited({ maxTotal: 2, maxRunningTotal: 1 })
    const a = await service.create('alice', { name: 'a' })
    await expect(service.create('bob', { name: 'b' })).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await service.stop('alice', a.id)
    await service.create('bob', { name: 'b' })
    await expect(service.create('carol', { name: 'c' })).rejects.toMatchObject({ name: 'QuotaExceededError', message: expect.stringContaining('service') })
  })

  it('rate-limits creates and resets per owner per hour', async () => {
    const { service, advance } = limited({ maxCreatesPerHour: 2, maxPerOwner: 10, maxRunningPerOwner: 10 })
    const a = await service.create('alice', { name: 'a' })
    await service.reset('alice', a.id, { keepWorkspace: true })
    await expect(service.create('alice', { name: 'b' })).rejects.toMatchObject({ name: 'QuotaExceededError', message: expect.stringContaining('per hour') })
    advance(61 * 60_000)
    await service.create('alice', { name: 'b' })
  })

  it('refuses templates asking for more than the per-sandbox maximum', async () => {
    const { service } = limited({ maxCpus: 2, maxMemoryMb: 1024 })
    await expect(service.create('alice', { name: 'a', template: { resources: { cpus: 4 } } })).rejects.toMatchObject({ name: 'LimitError' })
    await expect(service.create('alice', { name: 'a', template: { resources: { memoryMb: 4096 } } })).rejects.toMatchObject({ name: 'LimitError' })
  })
})
