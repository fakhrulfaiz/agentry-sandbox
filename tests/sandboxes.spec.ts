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
