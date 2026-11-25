import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootstrap } from '../src/places/bootstrap.ts'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { envdToken } from '../src/envd/token.ts'
import { pack } from 'tar-stream'
import { dockerAvailable } from './support/docker.ts'
import { startBareEnvd, type BareEnvd } from './support/bare-envd.ts'

const secret = 's'.repeat(32)

async function fakeTar(): Promise<Buffer> {
  const p = pack()
  p.entry({ name: 'dsh', type: 'directory', mode: 0o755 })
  p.entry({ name: 'dsh/marker' }, 'x')
  p.finalize()
  const parts: Buffer[] = []
  for await (const c of p as AsyncIterable<Buffer>) parts.push(c)
  return Buffer.concat(parts)
}

describe.skipIf(!dockerAvailable)('bootstrap', () => {
  let envd: BareEnvd
  beforeEach(async () => { envd = await startBareEnvd() }, 120_000)
  afterEach(async () => { await envd?.stop() })

  const run = async (id: string, user: string, script: string) =>
    runInEnvd(createEnvdClient({ baseUrl: envd.baseUrl, accessToken: envdToken(secret, id) }), user, script, { cwd: '/' })
  const setup = (id: string) => {
    const driver = createFakeDriver()
    driver.setEndpoint(envd.baseUrl)
    let copies = 0
    const opts = { secret, startTimeoutMs: 10_000, dshRef: 'rt-1', dshRuntime: async () => { copies++; return fakeTar() } }
    return { driver, opts, copies: () => copies, id }
  }

  it('first start creates agent, installs packages, writes files, runs setup in order', async () => {
    const { driver, opts } = setup('sbx_b')
    const h = await bootstrap(driver, 'sbx_b', {}, { packages: ['jq'], files: [{ path: 'a.txt', content: 'hi' }], setupCommands: ['echo one >> /workspace/log', 'echo two >> /workspace/log'] }, opts)
    expect(h.provisioned).toBe('true')
    const r = await run('sbx_b', 'agent', 'id -un; jq --version; cat /workspace/a.txt; cat /workspace/log')
    expect(r.stdout.split('\n').slice(0, 1)).toEqual(['agent'])
    expect(r.stdout).toMatch(/jq-[\s\S]*hi\s*one\s+two/)
  }, 180_000)

  it('second start only inits as agent', async () => {
    const { driver, opts } = setup('sbx_b')
    const spec = { setupCommands: ['echo again >> /workspace/log'] }
    const first = await bootstrap(driver, 'sbx_b', {}, {}, opts)
    const h = await bootstrap(driver, 'sbx_b', first, spec, opts)
    expect(h).toEqual(first)
    expect((await run('sbx_b', 'agent', 'cat /workspace/log 2>&1; echo end')).stdout).not.toContain('again')
  }, 60_000)

  it('a failing setup command rejects with its exit code and stderr tail', async () => {
    const { driver, opts } = setup('sbx_b')
    await expect(bootstrap(driver, 'sbx_b', {}, { setupCommands: ['echo boom >&2; exit 7'] }, opts)).rejects.toThrow(/exit 7.*boom/s)
  }, 60_000)

  it('copies the DSH runtime once per runtime ref', async () => {
    const { driver, opts, copies } = setup('sbx_b')
    const h = await bootstrap(driver, 'sbx_b', {}, {}, opts)
    expect(h.dsh).toBe('rt-1')
    await bootstrap(driver, 'sbx_b', h, {}, opts)
    expect(copies()).toBe(1)
    expect((await run('sbx_b', 'agent', 'cat /opt/agentry/dsh/marker')).stdout).toBe('x')
  }, 60_000)

  it('I1: a recreated container (new GPUs) redoes the agent user and packages but not template files or setup commands', async () => {
    const { driver, opts } = setup('sbx_b')
    const spec = { files: [{ path: 'a.txt', content: 'template' }], setupCommands: ['echo ran >> /workspace/log'] }
    const h = await bootstrap(driver, 'sbx_b', { provisioned: 'false', recreated: 'true' }, spec, opts)
    expect(h.recreated).toBeUndefined()
    expect(h.provisioned).toBe('true')
    const r = await run('sbx_b', 'agent', 'id -un; ls /workspace/a.txt /workspace/log 2>&1; echo end')
    expect(r.stdout.split('\n')[0]).toBe('agent')
    expect(r.stdout).toMatch(/workspace\/a\.txt.*No such file/)
    expect(r.stdout).toMatch(/workspace\/log.*No such file/)
  }, 120_000)

  it("I6: the runtime's ref carries the place's architecture, so another architecture is copied again", async () => {
    const { driver, opts, copies } = setup('sbx_b')
    driver.dshRuntime = async () => ({ arch: 'arm64', tar: async () => { return fakeTar() } })
    const h = await bootstrap(driver, 'sbx_b', {}, {}, opts)
    expect(h.dsh).toBe('rt-1@arm64')
    expect(copies()).toBe(0)
    driver.dshRuntime = async () => ({ arch: 'amd64', tar: async () => fakeTar() })
    expect((await bootstrap(driver, 'sbx_b', h, {}, opts)).dsh).toBe('rt-1@amd64')
  }, 120_000)
})
