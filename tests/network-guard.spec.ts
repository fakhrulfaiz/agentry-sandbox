import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { GUARD_IMAGE } from '../src/backends/network-guard.ts'
import { runOnce } from './support/docker.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDockerBackend } from './support/docker-backend.ts'
import { createNetworkGuard } from '../src/backends/network-guard.ts'
import type { Handle as BackendHandle } from '../src/places/driver.ts'
import { loadConfig } from '../src/config.ts'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { envdToken } from '../src/envd/token.ts'
import { docker, dockerAvailable, dockerDesktop } from './support/docker.ts'

const cfg = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
const OWNER = `test-net-${randomBytes(4).toString('hex')}`
const newId = () => `sbx_test${randomBytes(14).toString('hex')}`

describe.skipIf(!dockerAvailable)('network guard', () => {
  const guard = createNetworkGuard(docker(), cfg)
  const backend = createDockerBackend(cfg, guard)
  let a: { id: string; handle: BackendHandle }
  let b: { id: string; handle: BackendHandle }
  let off: { id: string; handle: BackendHandle }

  const sh = async (s: { id: string; handle: BackendHandle }, script: string) => {
    const { baseUrl } = await backend.endpoint(s.handle)
    return runInEnvd(createEnvdClient({ baseUrl, accessToken: envdToken(cfg.secret, s.id) }), 'agent', script, { timeoutMs: 60_000 })
  }
  const curlCode = (url: string) => `curl -s -o /dev/null --max-time 6 -w '%{http_code}' ${url} || echo blocked`

  beforeAll(async () => {
    const ids = [newId(), newId(), newId()]
    a = { id: ids[0]!, handle: await backend.create(ids[0]!, OWNER, {}) }
    b = { id: ids[1]!, handle: await backend.create(ids[1]!, OWNER, {}) }
    off = { id: ids[2]!, handle: await backend.create(ids[2]!, OWNER, { network: false }) }
  })

  afterAll(async () => {
    for (const s of [a, b, off]) if (s) await backend.destroy(s.id, s.handle, { keepWorkspace: false })
    await guard.removeOwnerNetwork(OWNER)
  })

  it('places an owner on its own bridge with inter-container traffic off', async () => {
    const net = await docker().getNetwork(a.handle.network!).inspect()
    expect(net.Name).toMatch(/^agentry-sbx-[0-9a-f]{12}$/)
    expect(net.Options?.['com.docker.network.bridge.enable_icc']).toBe('false')
  })

  it('a sandbox reaches the internet', async () => {
    expect((await sh(a, curlCode('https://example.com'))).stdout).toContain('200')
  })

  // Docker Desktop only: relies on host.docker.internal resolving (not on native Linux).
  it.runIf(dockerDesktop)('a sandbox cannot reach a real listener on the host, while an unguarded container can (I7)', async () => {
    const listener = http.createServer((_q, r) => r.end('reached'))
    await new Promise<void>((r) => listener.listen(0, '0.0.0.0', r))
    const port = (listener.address() as AddressInfo).port
    try {
      const probe = `curl -s -o /dev/null --max-time 5 -w '%{http_code}' http://host.docker.internal:${String(port)}/; echo " exit=$?"`
      const guarded = (await sh(a, probe)).stdout
      expect(guarded).toContain('exit=28')
      const control = await runOnce('ghcr.io/fakhrulfaiz/agentry-sandbox:1', ['sh', '-c', probe])
      expect(control.output).toContain('200')
    } finally {
      listener.close()
    }
  })

  // Docker Desktop only: relies on host.docker.internal resolving (not on native Linux).
  it.runIf(dockerDesktop)("a sandbox cannot reach a sibling's published envd port through the host (I7)", async () => {
    const port = (await docker().getContainer(b.handle.containerId!).inspect()).NetworkSettings.Ports['49983/tcp']?.[0]?.HostPort
    const probe = `curl -s -o /dev/null --max-time 5 -w '%{http_code}' http://host.docker.internal:${String(port)}/health; echo " exit=$?"`
    expect((await sh(a, probe)).stdout).toContain('exit=28')
  })

  it('owner networks are small /24 subnets', async () => {
    const net = await docker().getNetwork(a.handle.network!).inspect()
    expect(net.IPAM?.Config?.[0]?.Subnet).toMatch(/\/24$/)
  })

  it("stopping or deleting a sandbox removes its own rules, and the owner's network goes with the last sandbox (I6)", async () => {
    const rules = async (tag: string) => (await runOnce(GUARD_IMAGE, [`iptables -S DOCKER-USER; iptables -S INPUT`], undefined, { privileged: true, hostNet: true })).output.split('\n').filter((l) => l.includes(tag)).length
    const offId = newId()
    const offHandle = await backend.create(offId, OWNER, { network: false })
    const tag = `agentry-c-${offHandle.containerId!.slice(0, 12)}`
    expect(await rules(tag)).toBeGreaterThan(0)
    await backend.stop(offHandle)
    expect(await rules(tag)).toBe(0)
    await backend.destroy(offId, offHandle, { keepWorkspace: false })
    const owner = `test-net-${randomBytes(4).toString('hex')}`
    const id = newId()
    const h = await backend.create(id, owner, {})
    await backend.destroy(id, h, { keepWorkspace: false })
    await backend.releaseOwner!(owner)
    await expect(docker().getNetwork(h.network!).inspect()).rejects.toThrow()
  })

  it('a sandbox cannot reach a sibling sandbox', async () => {
    const siblingIp = (await docker().getContainer(b.handle.containerId!).inspect()).NetworkSettings.Networks[b.handle.network!]!.IPAddress
    expect((await sh(a, curlCode(`http://${siblingIp}:49983/health`))).stdout).toContain('blocked')
  })

  it('network-off blocks the internet but the service still reaches envd', async () => {
    expect((await sh(off, curlCode('https://example.com'))).stdout).toContain('blocked')
    expect((await sh(off, 'echo alive')).stdout).toContain('alive')
  })
})
