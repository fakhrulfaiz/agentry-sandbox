import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrap } from '../src/places/bootstrap.ts'
import { createPassthroughNetworkGuard, type Handle } from '../src/places/driver.ts'
import { createDockerDriver, dockerDshRuntime } from '../src/places/drivers/docker.ts'
import { cacheTag } from '../src/places/template-cache.ts'
import type { ProgressUpdate, TemplateSpec } from '../src/store/types.ts'
import { loadConfig } from '../src/config.ts'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { envdToken } from '../src/envd/token.ts'
import { docker, dockerAvailable } from './support/docker.ts'

const cfg = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
const newId = () => `sbx_test${randomBytes(14).toString('hex')}`
const cacheKeys = new Set<string>()

async function cleanup() {
  const d = docker()
  for (const c of await d.listContainers({ all: true, filters: { label: ['agentry.managed=true'] } })) {
    if (c.Labels['agentry.sandbox.id']?.startsWith('sbx_test')) await d.getContainer(c.Id).remove({ force: true }).catch(() => {})
  }
  for (const v of (await d.listVolumes()).Volumes ?? []) {
    if (v.Name.startsWith('agentry-sbx-sbx_test')) await d.getVolume(v.Name).remove().catch(() => {})
  }
  for (const k of cacheKeys) await d.getImage(cacheTag(k)).remove().catch(() => {})
  cacheKeys.clear()
}

describe.skipIf(!dockerAvailable)('template cache on Docker', () => {
  afterEach(cleanup)

  async function create(id: string, spec: TemplateSpec, stages: ProgressUpdate[] = []): Promise<{ handle: Handle; ms: number }> {
    const driver = createDockerDriver(cfg, createPassthroughNetworkGuard())
    const t0 = Date.now()
    const progress = (p: ProgressUpdate) => stages.push(p)
    const created = await driver.create(id, 'alice', spec, { gpuIds: [], progress, runtimeRef: cfg.dshRuntimeImage })
    if (created.cacheKey) cacheKeys.add(created.cacheKey)
    const handle = await bootstrap(driver, id, created, spec, { secret: cfg.secret, dshRuntime: dockerDshRuntime(cfg), startTimeoutMs: cfg.startTimeoutMs, dshRef: cfg.dshRuntimeImage, progress })
    return { handle: { ...handle, hit: created.cache ?? '' }, ms: Date.now() - t0 }
  }

  it('the second create of a template starts from the committed base and is faster; no secret or owner lands in the image', async () => {
    const spec: TemplateSpec = { image: 'debian:bookworm-slim', packages: ['jq'], env: { MY_SECRET: 'hunter2-s3cr3t' }, files: [{ path: 'a.txt', content: 'hi' }], setupCommands: ['echo ran > /workspace/log'] }
    const stages1: ProgressUpdate[] = []
    const first = await create(newId(), spec, stages1)
    expect(first.handle.hit).toBe('miss')
    expect(stages1.map((s) => s.stage)).toEqual(['starting', 'preparing', 'installing_packages', 'copying_runtime', 'writing_files', 'running_setup', 'finishing'])
    const d = docker()
    const image = cacheTag([...cacheKeys][0]!)
    const info = await d.getImage(image).inspect()
    expect(info.Config.Labels).toMatchObject({ 'org.agentry.cache.key': [...cacheKeys][0], 'agentry.sandbox.owner': '', 'agentry.sandbox.id': '' })
    expect(JSON.stringify(info)).not.toContain('hunter2')

    const id2 = newId()
    const stages2: ProgressUpdate[] = []
    const second = await create(id2, spec, stages2)
    expect(second.handle.hit).toBe('hit')
    expect(stages2.map((s) => s.stage)).toEqual(['starting', 'writing_files', 'running_setup', 'finishing'])
    expect((await d.getContainer(second.handle.containerId!).inspect()).Config.Image).toBe(image)
    console.log(`template cache: miss ${String(first.ms)} ms, hit ${String(second.ms)} ms`)
    expect(second.ms).toBeLessThan(first.ms)

    const driver = createDockerDriver(cfg, createPassthroughNetworkGuard())
    const ep = await driver.envdEndpoint(second.handle)
    const envd = createEnvdClient({ baseUrl: ep.baseUrl, accessToken: envdToken(cfg.secret, id2) })
    const r = await runInEnvd(envd, 'agent', 'whoami; sudo -n true && echo sudo-ok; jq --version; cat /workspace/a.txt /workspace/log; test -d /opt/agentry/dsh && echo dsh-ok; grep -rIl hunter2-s3cr3t /etc /opt /home /root /var /usr/local 2>/dev/null | head -3; echo end', { cwd: '/workspace' })
    expect(r.stdout).toContain('agent')
    expect(r.stdout).toContain('sudo-ok')
    expect(r.stdout).toContain('jq-')
    expect(r.stdout).toContain('hi')
    expect(r.stdout).toContain('ran')
    expect(r.stdout).toContain('dsh-ok')
    expect(r.stdout.trim().endsWith('end')).toBe(true)
    expect(r.stdout).not.toContain('hunter2')
  }, 400_000)
})
