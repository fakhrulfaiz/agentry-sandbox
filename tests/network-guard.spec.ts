import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDockerBackend } from '../src/backends/docker.ts'
import { createNetworkGuard } from '../src/backends/network-guard.ts'
import type { BackendHandle } from '../src/backends/types.ts'
import { loadConfig } from '../src/config.ts'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { envdToken } from '../src/envd/token.ts'
import { docker, dockerAvailable } from './support/docker.ts'

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
    for (const s of [a, b, off]) if (s) await backend.destroy(s.handle, { keepWorkspace: false })
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

  it('a sandbox cannot reach the host', async () => {
    expect((await sh(a, curlCode('http://host.docker.internal:55432'))).stdout).toContain('blocked')
    const gateway = (await docker().getNetwork(a.handle.network!).inspect()).IPAM?.Config?.[0]?.Gateway ?? ''
    expect((await sh(a, curlCode(`http://${gateway}:80`))).stdout).toContain('blocked')
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
