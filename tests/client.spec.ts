import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSandboxApi, SandboxApiError } from '../src/client/index.ts'
import { startTestService, type TestService } from '../src/testing.ts'

let svc: TestService
beforeEach(async () => {
  svc = await startTestService()
})
afterEach(async () => svc.close())

describe('sandbox API client', () => {
  it('round-trips create, list, get, stop, start, reset and remove', async () => {
    const api = createSandboxApi({ url: svc.url, key: svc.key, owner: 'alice' })
    const s = await api.create({ name: 'box', workspace_path: '/home/agent/work/sandbox-1', template: { image: 'python:3.13' } })
    expect(s).toMatchObject({ object: 'sandbox', name: 'box', state: 'running', workspace_path: '/home/agent/work/sandbox-1', image: 'python:3.13' })
    expect((await api.list()).map((x) => x.id)).toEqual([s.id])
    expect((await api.get(s.id)).id).toBe(s.id)
    expect((await api.stop(s.id)).state).toBe('stopped')
    expect((await api.start(s.id)).state).toBe('running')
    expect((await api.reset(s.id, { keepWorkspace: true })).state).toBe('running')
    await api.remove(s.id)
    await expect(api.get(s.id)).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('reports the default image and what it ships', async () => {
    const [b] = await createSandboxApi({ url: svc.url, key: svc.key, owner: 'alice' }).backends()
    expect(b).toMatchObject({ available: true, default_image: { name: expect.any(String), runtimes: { python: '3.11' }, python_packages: ['pandas'] } })
  })

  it('maps errors to SandboxApiError and reports backends', async () => {
    const api = createSandboxApi({ url: svc.url, key: 'wrong', owner: 'alice' })
    const e = await api.list().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SandboxApiError)
    expect(e).toMatchObject({ status: 401, code: 'unauthorized' })
    svc.backend.setAvailable(false, 'Docker is not reachable')
    const ok = createSandboxApi({ url: svc.url, key: svc.key, owner: 'alice' })
    expect(await ok.backends()).toEqual([expect.objectContaining({ kind: 'fake', available: false, reason: 'Docker is not reachable' })])
  })

  it('rejects a workspace path that is not a clean absolute path', async () => {
    const api = createSandboxApi({ url: svc.url, key: svc.key, owner: 'alice' })
    for (const p of ['relative/dir', '/a/../b', '/a b', '/', '/opt/agentry', '/opt/agentry/dsh', '/proc/x', '/etc']) await expect(api.create({ name: 'x', workspace_path: p })).rejects.toMatchObject({ status: 400 })
  })

  it('an unreachable service is a SandboxApiError with code unreachable', async () => {
    const api = createSandboxApi({ url: 'http://127.0.0.1:1', key: 'k', owner: 'alice' })
    await expect(api.list()).rejects.toMatchObject({ code: 'unreachable' })
  })
})
