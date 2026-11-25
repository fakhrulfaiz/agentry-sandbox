/** Fixes from the final review of sandbox places, plan 1 (no Docker, no hardware: mocked clients and fake drivers). */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { pack } from 'tar-stream'
import { envdArchive } from '../src/backends/envd-binary.ts'
import { createNetworkGuard, GUARD_IMAGE } from '../src/backends/network-guard.ts'
import { createPassthroughNetworkGuard } from '../src/places/driver.ts'
import { createDockerDriver } from '../src/places/drivers/docker.ts'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { createEnsureImage } from '../src/places/images.ts'
import { createPlaceRegistry } from '../src/places/registry.ts'
import { loadConfig } from '../src/config.ts'
import { createSandboxService, PlaceUnavailableError, NotFoundError } from '../src/sandboxes.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { startTestService, type TestService } from '../src/testing.ts'
import { startServer } from './support/server.ts'

const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
const noBootstrap = async (_d: unknown, _i: string, h: Record<string, string>) => h
const missing = () => Object.assign(new Error('no such image'), { statusCode: 404 })

async function tarOf(entries: Record<string, string>): Promise<Buffer> {
  const p = pack()
  for (const [name, content] of Object.entries(entries)) p.entry({ name, mode: 0o755 }, content)
  p.finalize()
  const parts: Buffer[] = []
  for await (const c of p as AsyncIterable<Buffer>) parts.push(c)
  return Buffer.concat(parts)
}

/** A Docker client that has only `images`, records what is asked of it and serves archives. */
function mockDocker(opts: { images?: string[]; arch?: string; nvidia?: boolean; pullFails?: boolean } = {}) {
  const images = new Set(opts.images ?? [])
  const calls: string[] = []
  const docker = {
    calls,
    version: async () => ({ Version: '27', Arch: opts.arch ?? 'amd64' }),
    info: async () => ({ Runtimes: opts.nvidia ? { runc: {}, nvidia: {} } : { runc: {} } }),
    getImage: (n: string) => ({
      inspect: async () => {
        if (!images.has(n)) throw missing()
        return {}
      },
      tag: async ({ repo, tag }: { repo: string; tag: string }) => {
        calls.push(`tag ${n} ${repo}:${tag}`)
        images.add(`${repo}:${tag}`)
      },
    }),
    pull: async (n: string) => {
      calls.push(`pull ${n}`)
      if (opts.pullFails) throw new Error('pull access denied')
      images.add(n)
      return {}
    },
    modem: { followProgress: (_s: unknown, cb: (e: Error | null) => void) => cb(null) },
    createContainer: async (o: { Image: string; Cmd?: string[] }) => {
      calls.push(`create ${o.Image}`)
      if (!images.has(o.Image)) throw missing()
      return {
        id: 'c1',
        getArchive: async () => Readable.from([await tarOf({ envd: `bin-${opts.arch ?? 'amd64'}`, 'dsh/marker': 'x' })]),
        start: async () => {},
        wait: async () => ({ StatusCode: 0 }),
        logs: async () => Buffer.from('0, GPU-aaa, Test GPU\n'),
        remove: async () => {},
      }
    },
  }
  return docker
}
type Mock = ReturnType<typeof mockDocker>
const asDocker = (m: Mock) => m as unknown as import('dockerode')

describe('C2: helper images are pulled on the place that uses them', () => {
  it('ensure pulls a missing image, and tags the earlier local image when the pull fails', async () => {
    const pulled = mockDocker()
    await createEnsureImage(asDocker(pulled))('ghcr.io/fakhrulfaiz/agentry-netguard:1')
    expect(pulled.calls).toEqual(['pull ghcr.io/fakhrulfaiz/agentry-netguard:1'])

    const old = mockDocker({ images: ['agentry/netguard:1'], pullFails: true })
    await createEnsureImage(asDocker(old))('ghcr.io/fakhrulfaiz/agentry-netguard:1')
    expect(old.calls).toContain('tag agentry/netguard:1 ghcr.io/fakhrulfaiz/agentry-netguard:1')
    await expect(createEnsureImage(asDocker(mockDocker({ pullFails: true })))('ghcr.io/fakhrulfaiz/agentry-netguard:1')).rejects.toThrow(/pull access denied/)
  })

  it("envd is read from each host after pulling its image (never one host's binary for another)", async () => {
    const amd = mockDocker({ arch: 'amd64' })
    const arm = mockDocker({ arch: 'arm64' })
    const img = 'ghcr.io/fakhrulfaiz/agentry-envd:test-c2'
    const a = await envdArchive(asDocker(amd), img, createEnsureImage(asDocker(amd)))
    const b = await envdArchive(asDocker(arm), img, createEnsureImage(asDocker(arm)))
    expect(amd.calls).toEqual([`pull ${img}`, `create ${img}`])
    expect(arm.calls).toEqual([`pull ${img}`, `create ${img}`])
    expect(a.includes('bin-amd64')).toBe(true)
    expect(b.includes('bin-arm64')).toBe(true)
    await envdArchive(asDocker(amd), img, createEnsureImage(asDocker(amd)))
    expect(amd.calls.filter((c) => c.startsWith('create')).length).toBe(1)
  })

  it('the egress guard pulls its image before its first helper container', async () => {
    const m = mockDocker()
    await createNetworkGuard(asDocker(m), { ...config, egress: true }, createEnsureImage(asDocker(m))).releaseFor('abcdef1234567890')
    expect(m.calls).toEqual([`pull ${GUARD_IMAGE}`, `create ${GUARD_IMAGE}`])
  })
})

describe("I6: the DSH runtime comes from the place's own daemon and architecture", () => {
  it("reads the tree through the place's client and reports its architecture", async () => {
    const cfg = { ...config, dshRuntimeImage: 'ghcr.io/fakhrulfaiz/agentry-dsh-runtime:test-i6' }
    const amd = mockDocker({ arch: 'amd64' })
    const arm = mockDocker({ arch: 'arm64' })
    const dArm = createDockerDriver(cfg, createPassthroughNetworkGuard(), asDocker(arm), asDocker(arm))
    const dAmd = createDockerDriver(cfg, createPassthroughNetworkGuard(), asDocker(amd), asDocker(amd))
    const r = await dArm.dshRuntime!()
    expect(r!.arch).toBe('arm64')
    await r!.tar()
    expect(arm.calls).toEqual([`pull ${cfg.dshRuntimeImage}`, `create ${cfg.dshRuntimeImage}`])
    expect(amd.calls).toEqual([])
    expect((await dAmd.dshRuntime!())!.arch).toBe('amd64')
    expect(await createDockerDriver({ ...config, dshRuntimeImage: '' }, createPassthroughNetworkGuard(), asDocker(amd), asDocker(amd)).dshRuntime!()).toBeNull()
  })
})

describe('I2: probing is cheap', () => {
  it('probe never pulls or runs a container; GPU discovery does, once, on request', async () => {
    const m = mockDocker({ nvidia: true })
    const driver = createDockerDriver(config, createPassthroughNetworkGuard(), asDocker(m), asDocker(m))
    expect(await driver.probe()).toMatchObject({ ok: true, gpus: [] })
    expect(m.calls).toEqual([])
    const found = await driver.discoverGpus!()
    expect(found).toEqual([{ index: 0, uuid: 'GPU-aaa', name: 'Test GPU' }])
    expect(m.calls.some((c) => c.startsWith('create'))).toBe(true)
    expect(await driver.probe()).toMatchObject({ ok: true, gpus: found })
  })

  it('a place probe is cached, cut off after the timeout, and shared by one create', async () => {
    const store = createMemoryStore()
    const local = createFakeDriver()
    local.setGpus([{ index: 0, uuid: 'g0', name: 'X' }])
    let probes = 0
    const probe = local.probe.bind(local)
    local.probe = async () => { probes++; return probe() }
    const places = await createPlaceRegistry({ store, config, local, drivers: {}, probeTtlMs: 30_000 })
    const service = createSandboxService({ store, places, config, provision: noBootstrap })
    await service.create('alice', { name: 'g', gpus: 1 })
    expect(probes).toBe(1)

    const hang = createFakeDriver()
    hang.probe = () => new Promise(() => {})
    const reg2 = await createPlaceRegistry({ store: createMemoryStore(), config, local: hang, drivers: {}, probeTimeoutMs: 20 })
    expect(await reg2.default().probe()).toMatchObject({ ok: false, reason: expect.stringContaining('no answer') })
  })
})

describe('places with the fake driver', () => {
  const rec = { id: 'remote', name: 'Remote', kind: 'fake', config: {}, secrets: null, enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: 1, updatedAt: 1 }
  async function two() {
    const store = createMemoryStore()
    const local = createFakeDriver()
    const remote = createFakeDriver()
    await store.places.insert(rec)
    const places = await createPlaceRegistry({ store, config, local, drivers: { fake: () => remote } })
    const service = createSandboxService({ store, places, config, provision: noBootstrap })
    return { store, local, remote, places, service }
  }

  it('I1: a restarted GPU sandbox gets its previous GPUs back when they are free', async () => {
    const store = createMemoryStore()
    const local = createFakeDriver()
    local.setGpus([{ index: 0, uuid: 'g0', name: 'X' }, { index: 1, uuid: 'g1', name: 'X' }])
    const places = await createPlaceRegistry({ store, config, local, drivers: {} })
    const service = createSandboxService({ store, places, config, provision: noBootstrap })
    const a = await service.create('alice', { name: 'a', gpus: 1 })
    const b = await service.create('alice', { name: 'b', gpus: 1 })
    expect([local.gpuIds.get(a.id), local.gpuIds.get(b.id)]).toEqual([['g0'], ['g1']])
    await service.stop('alice', a.id)
    await service.stop('alice', b.id)
    await service.start('alice', b.id)
    expect(local.gpuIds.get(b.id)).toEqual(['g1'])
    await service.start('alice', a.id)
    expect(local.gpuIds.get(a.id)).toEqual(['g0'])
    expect((await service.get('alice', a.id)).handle).toMatchObject({ gpuIds: 'g0' })
    expect((await service.get('alice', a.id)).handle.lastGpuIds).toBeUndefined()
  })

  it('I3: a sandbox on a removed place is forgotten on delete; force forgets one on a dead place', async () => {
    const { store, remote, places, service } = await two()
    const gone = await service.create('alice', { name: 'gone', place: 'remote' })
    const dead = await service.create('alice', { name: 'dead', place: 'remote' })
    remote.failConnections('connect ECONNREFUSED')
    await expect(service.destroy('alice', dead.id)).rejects.toBeInstanceOf(PlaceUnavailableError)
    await service.destroy('alice', dead.id, { force: true })
    await expect(service.get('alice', dead.id)).rejects.toBeInstanceOf(NotFoundError)
    await store.places.delete('remote')
    await places.reload()
    await service.destroy('alice', gone.id)
    await expect(service.get('alice', gone.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('I4: the idle sweep leaves a place that does not answer alone', async () => {
    const { local, remote, service } = await two()
    const l = await service.create('alice', { name: 'l', place: 'local' })
    const r = await service.create('alice', { name: 'r', place: 'remote' })
    remote.failConnections('connect ETIMEDOUT')
    local.calls.length = 0
    remote.calls.length = 0
    await service.sweepIdle()
    expect(local.calls).toContain(`maintain ${l.id}`)
    expect(remote.calls).not.toContain(`maintain ${r.id}`)
  })
})

describe('admin and HTTP', () => {
  const adminKey = randomBytes(16).toString('hex')
  const ADMIN = { AGENTRY_SANDBOX_ADMIN_KEYS: `sha256:${createHash('sha256').update(adminKey).digest('hex')}` }
  let svc: TestService | undefined
  afterEach(async () => { await svc?.close(); svc = undefined })
  const admin = (s: TestService, path: string, init: RequestInit = {}) => fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' } })
  const asAlice = (s: TestService, path: string, init: RequestInit = {}) => fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${s.key}`, 'x-agentry-owner': 'alice', 'content-type': 'application/json' } })

  it('I3: admin force delete forgets a sandbox whose place is dead, then the place can go', async () => {
    const drivers: ReturnType<typeof createFakeDriver>[] = []
    svc = await startTestService(ADMIN, undefined, { 'fake-ssh': () => { const d = Object.assign(createFakeDriver(), { kind: 'fake-ssh' }); drivers.push(d); return d } })
    const place = (await (await admin(svc, '/v1/admin/places', { method: 'POST', body: JSON.stringify({ name: 'Box', kind: 'fake-ssh', config: {} }) })).json()) as { id: string }
    const sbx = (await (await asAlice(svc, '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 's', place: place.id }) })).json()) as { id: string }
    drivers[drivers.length - 1]!.failConnections('connect ECONNREFUSED')
    expect((await admin(svc, `/v1/admin/sandboxes/${sbx.id}`, { method: 'DELETE' })).status).toBe(503)
    expect((await admin(svc, `/v1/admin/sandboxes/${sbx.id}?force=true`, { method: 'DELETE' })).status).toBe(200)
    expect((await asAlice(svc, `/v1/sandboxes/${sbx.id}`)).status).toBe(404)
    expect((await admin(svc, `/v1/admin/places/${place.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('Minor 2: a docker-ssh place cannot be saved without a pinned host key', async () => {
    svc = await startTestService(ADMIN, undefined, { 'docker-ssh': () => createFakeDriver() })
    const r = await admin(svc, '/v1/admin/places', { method: 'POST', body: JSON.stringify({ name: 'Box', kind: 'docker-ssh', config: { url: 'ssh://u@h' }, secrets: { private_key: 'k' } }) })
    expect(r.status).toBe(400)
  })

  it('I5: a changed host key answers 409 place_host_key_changed on create, not 503', async () => {
    const remote = createFakeDriver()
    remote.probe = async () => ({ ok: false, reason: 'host key changed', hostKeyChanged: true })
    const s = await startServer({ fake: () => remote })
    try {
      await s.store.places.insert({ id: 'remote', name: 'Remote', kind: 'fake', config: {}, secrets: null, enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: 1, updatedAt: 1 })
      await s.places.reload()
      const r = await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'x', place: 'remote' }) })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('place_host_key_changed')
    } finally {
      await s.close()
    }
  })

  it('Minor 4: the relay closes the tunnel when touching the sandbox fails', async () => {
    const s = await startServer()
    const upstream = http.createServer((_q, res) => res.end('ok'))
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    try {
      s.backend.setEndpoint(`http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`)
      const id = ((await (await s.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'box' }) })).json()) as { id: string }).id
      let released = 0
      const base = s.backend.envdEndpoint.bind(s.backend)
      s.backend.envdEndpoint = async (h) => ({ ...(await base(h)), release: () => { released++ } })
      s.service.touch = async () => { throw new NotFoundError('sandbox') }
      expect((await s.call(`/v1/sandboxes/${id}/envd/health`)).status).toBe(404)
      expect(released).toBe(1)
    } finally {
      await s.close()
      await new Promise<void>((r) => upstream.close(() => r()))
    }
  })
})
