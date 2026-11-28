import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrap } from '../src/places/bootstrap.ts'
import { createPassthroughNetworkGuard, type Handle } from '../src/places/driver.ts'
import { createDockerDriver, dockerDshRuntime } from '../src/places/drivers/docker.ts'
import type { TemplateSpec } from '../src/store/types.ts'
import { loadConfig, type SandboxConfig } from '../src/config.ts'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { envdToken } from '../src/envd/token.ts'
import { docker, dockerAvailable, dockerDesktop } from './support/docker.ts'

const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  ...loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) }),
  ...over,
})
const newId = () => `sbx_test${randomBytes(14).toString('hex')}`

async function cleanup() {
  const d = docker()
  for (const c of await d.listContainers({ all: true, filters: { label: ['agentry.managed=true'] } })) {
    if (c.Labels['agentry.sandbox.id']?.startsWith('sbx_test')) await d.getContainer(c.Id).remove({ force: true }).catch(() => {})
  }
  for (const v of (await d.listVolumes()).Volumes ?? []) {
    if (v.Name.startsWith('agentry-sbx-sbx_test')) await d.getVolume(v.Name).remove().catch(() => {})
  }
  for (const v of (await d.listVolumes({ filters: { label: ['agentry.snapshot.id'] } })).Volumes ?? []) {
    if (v.Labels?.['agentry.snapshot.id']?.startsWith('snap_test')) await d.getVolume(v.Name).remove().catch(() => {})
  }
  for (const i of await d.listImages({ filters: { reference: ['agentry-snap:snap_test*'] } })) await d.getImage(i.Id).remove({ force: true }).catch(() => {})
}

/** The driver plus the shared bootstrap, as one create/start (a failed bootstrap removes or stops the machine). */
function createDockerBackend(cfg: SandboxConfig, guard = createPassthroughNetworkGuard()) {
  const driver = createDockerDriver(cfg, guard)
  const opts = { secret: cfg.secret, dshRuntime: dockerDshRuntime(cfg), startTimeoutMs: cfg.startTimeoutMs, dshRef: cfg.dshRuntimeImage }
  const ctx = { gpuIds: [] }
  return {
    available: () => driver.probe(),
    endpoint: (h: Handle) => driver.envdEndpoint(h),
    portConnect: (h: Handle, port: number) => driver.portConnect!(h, port),
    stop: (h: Handle) => driver.stop(h),
    status: (h: Handle) => driver.status(h),
    destroy: (id: string, h: Handle, o: { keepWorkspace: boolean }) => driver.destroy(id, h, o),
    async create(id: string, owner: string, spec: TemplateSpec): Promise<Handle> {
      const h = await driver.create(id, owner, spec, ctx)
      try {
        return await bootstrap(driver, id, h, spec, opts)
      } catch (e) {
        await driver.destroy(id, h, { keepWorkspace: false }).catch(() => {})
        throw e
      }
    },
    async start(id: string, h: Handle, spec: TemplateSpec): Promise<Handle> {
      const started = await driver.start(id, h, spec, ctx)
      try {
        return await bootstrap(driver, id, started, spec, opts)
      } catch (e) {
        await driver.stop(started).catch(() => {})
        throw e
      }
    },
  }
}

async function shell(cfg: SandboxConfig, backend: ReturnType<typeof createDockerBackend>, id: string, handle: Handle, user: string, script: string) {
  const { baseUrl } = await backend.endpoint(handle)
  return runInEnvd(createEnvdClient({ baseUrl, accessToken: envdToken(cfg.secret, id) }), user, script, { cwd: '/workspace' })
}

describe.skipIf(!dockerAvailable)('docker driver', () => {
  afterEach(cleanup)

  it('creates a hardened sandbox that runs as agent with sudo', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const handle = await backend.create(id, 'alice', {})
    const who = await shell(cfg, backend, id, handle, 'agent', 'whoami; sudo -n true && echo sudo-ok; pwd')
    expect(who.stdout).toContain('agent')
    expect(who.stdout).toContain('sudo-ok')
    expect(who.stdout).toContain('/workspace')
    const info = await docker().getContainer(handle.containerId!).inspect()
    expect(info.HostConfig.Privileged).toBe(false)
    expect(info.HostConfig.CapDrop).toEqual(['ALL'])
    expect((info.Mounts ?? []).filter((m) => m.Type === 'bind')).toEqual([])
    const bindings = Object.values(info.HostConfig.PortBindings ?? {}).flat() as { HostIp: string }[]
    expect(bindings.length).toBeGreaterThan(0)
    expect(bindings.every((b) => b.HostIp === '127.0.0.1')).toBe(true)
    expect(info.Config.Labels).toMatchObject({ 'agentry.sandbox.id': id, 'agentry.sandbox.owner': 'alice', 'agentry.managed': 'true' })
  })

  it('portConnect carries a request to a server inside the container, also one bound to loopback only', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const handle = await backend.create(id, 'alice', {})
    await shell(cfg, backend, id, handle, 'agent', 'mkdir -p /tmp/site && echo preview-ok > /tmp/site/index.html && (nohup python3 -m http.server 8801 --bind 127.0.0.1 --directory /tmp/site >/dev/null 2>&1 &) ; sleep 1')
    const socket = await backend.portConnect(handle, 8801)
    let got = ''
    socket.on('data', (c: Buffer) => { got += c.toString() })
    const closed = new Promise<void>((r) => socket.on('close', () => r()))
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    await closed
    expect(got).toContain('200 OK')
    expect(got).toContain('preview-ok')
  }, 120_000)

  it('native snapshots: a volume copy restores files, a disk snapshot keeps installs, delete removes volume and image', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const driver = createDockerDriver(cfg, createPassthroughNetworkGuard())
    const id = newId()
    const handle = await backend.create(id, 'alice', {})
    expect(driver.capabilities.snapshots).toEqual(['workspace', 'disk'])
    await shell(cfg, backend, id, handle, 'agent', 'echo v1 > /workspace/f && sudo touch /usr/local/bin/marker')
    const snapId = `snap_test${randomBytes(14).toString('hex')}`
    const taken = await driver.snapshot!(id, handle, {}, { snapId, level: 'disk', name: 'one' })
    expect(taken.handle.volume).toBe(`agentry-snap-${snapId}`)
    expect(taken.handle.image).toBe(`agentry-snap:${snapId}`)
    // Change things, then bring the snapshot back in place.
    await shell(cfg, backend, id, handle, 'agent', 'echo v2 > /workspace/f && sudo rm /usr/local/bin/marker && touch /workspace/extra')
    const restored = await driver.restoreSnapshot!(id, handle, {}, { id: snapId, level: 'disk', handle: taken.handle }, { gpuIds: [] })
    const handle2 = await bootstrap(driver, id, restored, {}, { secret: cfg.secret, dshRuntime: dockerDshRuntime(cfg), startTimeoutMs: cfg.startTimeoutMs, dshRef: cfg.dshRuntimeImage })
    const back = await shell(cfg, backend, id, handle2, 'agent', 'cat /workspace/f; ls /usr/local/bin/marker; ls /workspace/extra 2>&1 || true')
    expect(back.stdout).toContain('v1')
    expect(back.stdout).toContain('/usr/local/bin/marker')
    expect(back.stdout).not.toMatch(/^\/workspace\/extra$/m)
    // A new sandbox from the snapshot gets the files.
    const id2 = newId()
    const created = await driver.createFromSnapshot!(id2, 'alice', {}, { gpuIds: [] }, { id: snapId, level: 'disk', handle: taken.handle })
    const handle3 = await bootstrap(driver, id2, created, {}, { secret: cfg.secret, dshRuntime: dockerDshRuntime(cfg), startTimeoutMs: cfg.startTimeoutMs, dshRef: cfg.dshRuntimeImage })
    expect((await shell(cfg, backend, id2, handle3, 'agent', 'cat /workspace/f')).stdout).toContain('v1')
    await driver.deleteSnapshot!({ id: snapId, level: 'disk', handle: taken.handle })
    await expect(docker().getVolume(taken.handle.volume!).inspect()).rejects.toThrow()
    await expect(docker().getImage(taken.handle.image!).inspect()).rejects.toThrow()
    await backend.destroy(id2, handle3, { keepWorkspace: false })
  }, 240_000)

  it('installs persist across stop and start', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    let handle = await backend.create(id, 'alice', {})
    await shell(cfg, backend, id, handle, 'agent', 'sudo touch /usr/local/bin/marker && echo hi > /workspace/f')
    await backend.stop(handle)
    expect(await backend.status(handle)).toBe('stopped')
    handle = await backend.start(id, handle, {})
    const r = await shell(cfg, backend, id, handle, 'agent', 'ls /usr/local/bin/marker && cat /workspace/f')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('hi')
  })

  it('destroy removes the container and the volume, or keeps the volume when asked', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const a = newId()
    const ha = await backend.create(a, 'alice', {})
    await backend.destroy(a, ha, { keepWorkspace: false })
    expect(await backend.status(ha)).toBe('missing')
    await expect(docker().getVolume(ha.volume!).inspect()).rejects.toThrow()
    const b = newId()
    const hb = await backend.create(b, 'alice', {})
    await backend.destroy(b, hb, { keepWorkspace: true })
    expect((await docker().getVolume(hb.volume!).inspect()).Name).toBe(hb.volume)
  })

  it('runs template packages, files and setup commands as agent in /workspace on first start only', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const spec = { packages: ['jq'], files: [{ path: 'notes/a.txt', content: 'from template' }], setupCommands: ['echo ran >> /workspace/log', 'whoami > /workspace/who'] }
    let handle = await backend.create(id, 'alice', spec)
    await backend.stop(handle)
    handle = await backend.start(id, handle, spec)
    const r = await shell(cfg, backend, id, handle, 'agent', 'wc -l < log; cat who; cat notes/a.txt; jq --version')
    expect(r.stdout.split('\n')[0]?.trim()).toBe('1')
    expect(r.stdout).toContain('agent')
    expect(r.stdout).toContain('from template')
    expect(r.stdout).toContain('jq-')
  })

  it('injects the DSH runtime into any glibc image, runnable by agent', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const handle = await backend.create(id, 'alice', { image: 'debian:bookworm-slim' })
    const r = await shell(cfg, backend, id, handle, 'agent', 'M=/opt/agentry/dsh/manifest.json; /opt/agentry/dsh/node -e "const m=require(process.argv[1]); require(\'fs\').accessSync(m.helper); console.log(m.version, require(\'crypto\').createHash(\'sha256\').update(require(\'fs\').readFileSync(m.helper)).digest(\'hex\')===m.helperHash)" $M; touch /opt/agentry/dsh/x 2>/dev/null || echo read-only')
    expect(r.stdout).toContain('0.2.2-rc.1 true')
    expect(r.stdout).toContain('read-only')
  })

  it('works with an image that lacks the agent user (alpine, apk)', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const handle = await backend.create(id, 'alice', { image: 'alpine:3', packages: ['jq'] })
    const r = await shell(cfg, backend, id, handle, 'agent', 'whoami; sudo -n true && echo sudo-ok; jq --version')
    expect(r.stdout).toContain('agent')
    expect(r.stdout).toContain('sudo-ok')
    expect(r.stdout).toContain('jq-')
  })

  // Docker Desktop only: relies on the container IP being unreachable from the host.
  it.runIf(dockerDesktop)('fails within startTimeoutMs when envd never becomes healthy', async () => {
    // Under Docker Desktop the container IP is not reachable from WSL, so envd never answers on it.
    const cfg = config({ startTimeoutMs: 3_000, envdReach: 'ip' })
    const backend = createDockerBackend(cfg)
    await expect(backend.create(newId(), 'alice', {})).rejects.toThrow(/envd/)
  })

  it('reports itself available with the docker version', async () => {
    const backend = createDockerBackend(config())
    const a = await backend.available()
    expect(a.ok).toBe(true)
    expect(a.ok && a.version).toMatch(/^\d+\./)
  })

  it('a create that fails during setup leaves no container and no volume behind (C1, I1)', async () => {
    const backend = createDockerBackend(config())
    const id = newId()
    await expect(backend.create(id, 'alice', { setupCommands: ['exit 3'] })).rejects.toThrow(/exit 3/)
    const left = await docker().listContainers({ all: true, filters: { label: [`agentry.sandbox.id=${id}`] } })
    expect(left).toEqual([])
    await expect(docker().getVolume(`agentry-sbx-${id}-workspace`).inspect()).rejects.toThrow()
  })

  it('destroy works from the id alone when the handle is empty', async () => {
    const backend = createDockerBackend(config())
    const id = newId()
    await backend.create(id, 'alice', {})
    await backend.destroy(id, {}, { keepWorkspace: false })
    expect(await docker().listContainers({ all: true, filters: { label: [`agentry.sandbox.id=${id}`] } })).toEqual([])
  })

  // Docker Desktop only: relies on the container IP being unreachable from the host.
  it.runIf(dockerDesktop)('a start that fails stops the container again (fails closed)', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const handle = await backend.create(id, 'alice', {})
    await backend.stop(handle)
    const bad = createDockerBackend({ ...cfg, startTimeoutMs: 2_000, envdReach: 'ip' })
    await expect(bad.start(id, handle, {})).rejects.toThrow(/envd/)
    expect(await backend.status(handle)).toBe('stopped')
  })

  it('mounts the workspace at a custom workspace path, owned by agent', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg)
    const id = newId()
    const handle = await backend.create(id, 'alice', { workspacePath: '/home/mffaiz/agentry-workspaces/dev/sandbox-x' })
    const { baseUrl } = await backend.endpoint(handle)
    const r = await runInEnvd(createEnvdClient({ baseUrl, accessToken: envdToken(cfg.secret, id) }), 'agent', 'pwd; stat -c %U .; touch ok && echo writable')
    expect(r.stdout).toContain('/home/mffaiz/agentry-workspaces/dev/sandbox-x')
    expect(r.stdout).toContain('agent')
    expect(r.stdout).toContain('writable')
  })
})
