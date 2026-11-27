import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { markerPath } from '../src/places/template-cache.ts'
import type { ProgressUpdate } from '../src/store/types.ts'

/** What ran, in order: `root: <script>` and `agent: <script>`, plus 'commit' and 'copy runtime'. */
const events: string[] = []
let markerPresent = true

vi.mock('../src/envd/client.ts', () => ({
  createEnvdClient: () => ({
    health: async () => true,
    init: async () => {},
    writeFile: async (path: string) => {
      events.push(`write ${path}`)
    },
  }),
}))
vi.mock('../src/envd/run.ts', async (orig) => ({
  ...(await orig<typeof import('../src/envd/run.ts')>()),
  runInEnvd: async (_c: unknown, user: string, script: string) => {
    events.push(`${user}: ${script}`)
    if (script.startsWith('test -f')) return { code: markerPresent ? 0 : 1, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  },
}))

const { bootstrap } = await import('../src/places/bootstrap.ts')

const KEY = 'k'.repeat(64)
const opts = (progress: (p: ProgressUpdate) => void) => ({ secret: 's'.repeat(32), startTimeoutMs: 1000, dshRef: 'rt', dshRuntime: async () => Buffer.from('x'), progress })
const spec = { packages: ['jq'], files: [{ path: 'a.txt', content: 'hi' }], setupCommands: ['npm install', `echo ${'x'.repeat(200)}`] }

function driver(commit: () => Promise<void> = async () => { events.push('commit') }) {
  const d = createFakeDriver()
  d.commitCache = commit
  return d
}
const ran = (what: string) => events.some((e) => e.includes(what))
const index = (what: string) => events.findIndex((e) => e.includes(what))

describe('bootstrap with the template cache', () => {
  beforeEach(() => {
    events.length = 0
    markerPresent = true
  })

  it('a miss installs the base, marks it, commits it before template files and setup, and forgets the cache keys', async () => {
    const stages: ProgressUpdate[] = []
    const h = await bootstrap(driver(), 'sbx_1', { cache: 'miss', cacheKey: KEY, cacheBase: 'sha256:b' }, spec, opts((p) => stages.push(p)))
    expect(ran('useradd')).toBe(true)
    expect(ran('install -y')).toBe(true)
    expect(index(markerPath(KEY))).toBeGreaterThan(index('install -y'))
    expect(index('commit')).toBeGreaterThan(index(markerPath(KEY)))
    expect(index('commit')).toBeLessThan(index('write /workspace/a.txt'))
    expect(index('commit')).toBeLessThan(index('npm install'))
    expect(h).not.toHaveProperty('cache')
    expect(h).not.toHaveProperty('cacheKey')
    expect(h).not.toHaveProperty('cacheBase')
    expect(stages.map((s) => s.stage)).toEqual(['preparing', 'installing_packages', 'copying_runtime', 'writing_files', 'running_setup', 'running_setup', 'finishing'])
    expect(stages[4]).toEqual({ stage: 'running_setup', step: 1, steps: 2, detail: 'npm install' })
    expect(stages[5]!.detail).toHaveLength(120)
  })

  it('a hit skips the agent user, packages and commit but still prepares the workspace, files and setup', async () => {
    const stages: ProgressUpdate[] = []
    await bootstrap(driver(), 'sbx_1', { cache: 'hit', cacheKey: KEY }, spec, opts((p) => stages.push(p)))
    expect(ran(`test -f '${markerPath(KEY)}'`)).toBe(true)
    expect(ran('useradd')).toBe(false)
    expect(ran('install -y')).toBe(false)
    expect(ran('commit')).toBe(false)
    expect(ran('chown')).toBe(true)
    expect(ran('npm install')).toBe(true)
    expect(stages.map((s) => s.stage)).toEqual(['copying_runtime', 'writing_files', 'running_setup', 'running_setup', 'finishing'])
  })

  it('a hit whose image lacks the marker falls back to the full bootstrap', async () => {
    markerPresent = false
    await bootstrap(driver(), 'sbx_1', { cache: 'hit', cacheKey: KEY }, spec, opts(() => {}))
    expect(ran('useradd')).toBe(true)
    expect(ran('install -y')).toBe(true)
    expect(ran('commit')).toBe(false)
  })

  it('without cache keys nothing is committed', async () => {
    await bootstrap(driver(), 'sbx_1', {}, spec, opts(() => {}))
    expect(ran('commit')).toBe(false)
    expect(ran('useradd')).toBe(true)
  })

  it('a machine with its own user is never cached', async () => {
    const d = driver()
    d.agentUser = 'nobody'
    await bootstrap(d, 'sbx_1', { cache: 'miss', cacheKey: KEY }, spec, opts(() => {}))
    expect(ran('commit')).toBe(false)
  })

  it('a later start (already provisioned) does none of it', async () => {
    const stages: ProgressUpdate[] = []
    await bootstrap(driver(), 'sbx_1', { provisioned: 'true', dsh: 'rt' }, spec, opts((p) => stages.push(p)))
    expect(events).toEqual([])
    expect(stages.map((s) => s.stage)).toEqual(['finishing'])
  })
})
