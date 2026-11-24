import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createDockerBackend } from '../src/backends/docker.ts'
import { createPassthroughNetworkGuard, type BackendHandle } from '../src/backends/types.ts'
import { loadConfig, type SandboxConfig } from '../src/config.ts'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { envdToken } from '../src/envd/token.ts'
import { docker, dockerAvailable } from './support/docker.ts'

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
}

async function shell(cfg: SandboxConfig, backend: ReturnType<typeof createDockerBackend>, id: string, handle: BackendHandle, user: string, script: string) {
  const { baseUrl } = await backend.endpoint(handle)
  return runInEnvd(createEnvdClient({ baseUrl, accessToken: envdToken(cfg.secret, id) }), user, script, { cwd: '/workspace' })
}

describe.skipIf(!dockerAvailable)('docker backend', () => {
  afterEach(cleanup)

  it('creates a hardened sandbox that runs as agent with sudo', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
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

  it('installs persist across stop and start', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
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
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
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
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
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

  it('works with an image that lacks the agent user (alpine, apk)', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
    const id = newId()
    const handle = await backend.create(id, 'alice', { image: 'alpine:3', packages: ['jq'] })
    const r = await shell(cfg, backend, id, handle, 'agent', 'whoami; sudo -n true && echo sudo-ok; jq --version')
    expect(r.stdout).toContain('agent')
    expect(r.stdout).toContain('sudo-ok')
    expect(r.stdout).toContain('jq-')
  })

  it('fails within startTimeoutMs when envd never becomes healthy', async () => {
    // Under Docker Desktop the container IP is not reachable from WSL, so envd never answers on it.
    const cfg = config({ startTimeoutMs: 3_000, envdReach: 'ip' })
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
    await expect(backend.create(newId(), 'alice', {})).rejects.toThrow(/envd/)
  })

  it('reports itself available with the docker version', async () => {
    const backend = createDockerBackend(config(), createPassthroughNetworkGuard())
    const a = await backend.available()
    expect(a.ok).toBe(true)
    expect(a.ok && a.version).toMatch(/^\d+\./)
  })

  it('a create that fails during setup leaves no container and no volume behind (C1, I1)', async () => {
    const backend = createDockerBackend(config(), createPassthroughNetworkGuard())
    const id = newId()
    await expect(backend.create(id, 'alice', { setupCommands: ['exit 3'] })).rejects.toThrow(/exit 3/)
    const left = await docker().listContainers({ all: true, filters: { label: [`agentry.sandbox.id=${id}`] } })
    expect(left).toEqual([])
    await expect(docker().getVolume(`agentry-sbx-${id}-workspace`).inspect()).rejects.toThrow()
  })

  it('destroy works from the id alone when the handle is empty', async () => {
    const backend = createDockerBackend(config(), createPassthroughNetworkGuard())
    const id = newId()
    await backend.create(id, 'alice', {})
    await backend.destroy(id, {}, { keepWorkspace: false })
    expect(await docker().listContainers({ all: true, filters: { label: [`agentry.sandbox.id=${id}`] } })).toEqual([])
  })

  it('a start that fails stops the container again (fails closed)', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
    const id = newId()
    const handle = await backend.create(id, 'alice', {})
    await backend.stop(handle)
    const bad = createDockerBackend({ ...cfg, startTimeoutMs: 2_000, envdReach: 'ip' }, createPassthroughNetworkGuard())
    await expect(bad.start(id, handle, {})).rejects.toThrow(/envd/)
    expect(await backend.status(handle)).toBe('stopped')
  })

  it('mounts the workspace at a custom workspace path, owned by agent', async () => {
    const cfg = config()
    const backend = createDockerBackend(cfg, createPassthroughNetworkGuard())
    const id = newId()
    const handle = await backend.create(id, 'alice', { workspacePath: '/home/mffaiz/agentry-workspaces/dev/sandbox-x' })
    const { baseUrl } = await backend.endpoint(handle)
    const r = await runInEnvd(createEnvdClient({ baseUrl, accessToken: envdToken(cfg.secret, id) }), 'agent', 'pwd; stat -c %U .; touch ok && echo writable')
    expect(r.stdout).toContain('/home/mffaiz/agentry-workspaces/dev/sandbox-x')
    expect(r.stdout).toContain('agent')
    expect(r.stdout).toContain('writable')
  })
})
