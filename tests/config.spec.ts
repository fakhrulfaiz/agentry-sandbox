import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.ts'

const KEY = `sha256:${'a'.repeat(64)}`
const base = { AGENTRY_SANDBOX_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/agentry_sandbox', AGENTRY_SANDBOX_API_KEYS: KEY, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) }

describe('loadConfig', () => {
  it('loads defaults with the three required values', () => {
    const c = loadConfig(base)
    expect(c.port).toBe(3090)
    expect(c.idleStopMinutes).toBe(30)
    expect(c.envdReach).toBe('loopback')
    expect(c.runtime).toBe('runc')
    expect(c.resources.memoryBytes).toBe(4294967296)
    expect(c.resources).toMatchObject({ cpus: 2, pids: 4096 })
    expect(c.startTimeoutMs).toBe(60000)
    expect(c.envdImage).toBe('ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13')
    expect(c.dshRuntimeImage).toBe('ghcr.io/fakhrulfaiz/agentry-dsh-runtime:0.2.2-rc.1')
    expect(c.defaultImage).toBe('ghcr.io/fakhrulfaiz/agentry-sandbox:1')
    expect(c.egress).toBe(true)
    expect(c.apiKeyHashes).toEqual([KEY])
  })

  it('snapshots are off without a folder and carry their limits', () => {
    expect(loadConfig(base).snapshots).toEqual({ dir: null, maxBytes: 2048 * 1024 * 1024, importMaxBytes: 2048 * 1024 * 1024, days: 30, maxPerOwner: 10 })
    const c = loadConfig({ ...base, AGENTRY_SANDBOX_SNAPSHOT_DIR: ' /var/lib/agentry-snaps ', AGENTRY_SANDBOX_SNAPSHOT_MAX_MB: '10', AGENTRY_SANDBOX_SNAPSHOT_DAYS: '0', AGENTRY_SANDBOX_MAX_SNAPSHOTS_PER_OWNER: '3' })
    expect(c.snapshots).toEqual({ dir: '/var/lib/agentry-snaps', maxBytes: 10 * 1024 * 1024, importMaxBytes: 2048 * 1024 * 1024, days: 0, maxPerOwner: 3 })
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_SNAPSHOT_MAX_MB: '0' })).toThrow('AGENTRY_SANDBOX_SNAPSHOT_MAX_MB')
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_SNAPSHOT_DAYS: 'x' })).toThrow('AGENTRY_SANDBOX_SNAPSHOT_DAYS')
  })

  it.each([
    ['AGENTRY_SANDBOX_DATABASE_URL'],
    ['AGENTRY_SANDBOX_API_KEYS'],
    ['AGENTRY_SANDBOX_SECRET'],
  ])('rejects a missing %s', (name) => {
    const env = { ...base, [name]: undefined }
    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(name)
  })

  it('rejects a short secret', () => {
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_SECRET: 'short' })).toThrow('AGENTRY_SANDBOX_SECRET')
  })

  it('rejects a key that is not sha256:<64 hex>', () => {
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_API_KEYS: 'plaintext-key' })).toThrow('AGENTRY_SANDBOX_API_KEYS')
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_API_KEYS: `${KEY},sha256:xyz` })).toThrow(ConfigError)
  })

  it('rejects envdReach other than loopback|ip and runtime other than runc|runsc', () => {
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_ENVD_REACH: 'public' })).toThrow('AGENTRY_SANDBOX_ENVD_REACH')
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_RUNTIME: 'kata' })).toThrow('AGENTRY_SANDBOX_RUNTIME')
    expect(loadConfig({ ...base, AGENTRY_SANDBOX_ENVD_REACH: 'ip', AGENTRY_SANDBOX_RUNTIME: 'runsc' })).toMatchObject({ envdReach: 'ip', runtime: 'runsc' })
  })

  it('reads numbers, the docker host and egress off', () => {
    const c = loadConfig({ ...base, AGENTRY_SANDBOX_PORT: '4000', AGENTRY_SANDBOX_MEMORY_MB: '1024', DOCKER_HOST: 'tcp://10.0.0.5:2375', AGENTRY_SANDBOX_EGRESS: 'off' })
    expect(c).toMatchObject({ port: 4000, docker: { host: 'tcp://10.0.0.5:2375' }, egress: false })
    expect(c.resources.memoryBytes).toBe(1024 * 1024 * 1024)
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_PORT: 'abc' })).toThrow('AGENTRY_SANDBOX_PORT')
  })
})

describe('limits config', () => {
  it('has defaults and reads every limit and per-owner overrides', () => {
    const d = loadConfig(base).limits
    expect(d).toEqual({ maxPerOwner: 5, maxRunningPerOwner: 2, maxTotal: 50, maxRunningTotal: 10, maxCreatesPerHour: 20, maxCpus: 4, maxMemoryMb: 8192, owners: {} })
    const c = loadConfig({ ...base, AGENTRY_SANDBOX_MAX_PER_OWNER: '9', AGENTRY_SANDBOX_MAX_RUNNING_TOTAL: '3', AGENTRY_SANDBOX_OWNER_LIMITS: '{"alice":{"maxPerOwner":20,"maxRunningPerOwner":4}}' }).limits
    expect(c).toMatchObject({ maxPerOwner: 9, maxRunningTotal: 3, owners: { alice: { maxPerOwner: 20, maxRunningPerOwner: 4 } } })
  })
  it('rejects malformed owner limits', () => {
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_OWNER_LIMITS: '{bad' })).toThrow('AGENTRY_SANDBOX_OWNER_LIMITS')
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_OWNER_LIMITS: '{"alice":{"maxPerOwner":-1}}' })).toThrow('AGENTRY_SANDBOX_OWNER_LIMITS')
  })
})

describe('admin keys', () => {
  it('are optional, must be hashes, and must differ from the API keys', async () => {
    const { loadConfig } = await import('../src/config.ts')
    const h = (c: string) => `sha256:${c.repeat(64)}`
    const base = { AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@y/z', AGENTRY_SANDBOX_API_KEYS: h('a'), AGENTRY_SANDBOX_SECRET: 's'.repeat(32) }
    expect(loadConfig(base).adminKeyHashes).toEqual([])
    expect(loadConfig({ ...base, AGENTRY_SANDBOX_ADMIN_KEYS: h('b') }).adminKeyHashes).toEqual([h('b')])
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_ADMIN_KEYS: 'plain' })).toThrow(/ADMIN_KEYS/)
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_ADMIN_KEYS: h('a') })).toThrow(/differ/)
  })
})

describe('template cache', () => {
  it('is on with 10 images by default and can be switched off or resized', () => {
    expect(loadConfig(base)).toMatchObject({ templateCache: true, templateCacheMax: 10 })
    expect(loadConfig({ ...base, AGENTRY_SANDBOX_TEMPLATE_CACHE: 'off', AGENTRY_SANDBOX_TEMPLATE_CACHE_MAX: '3' })).toMatchObject({ templateCache: false, templateCacheMax: 3 })
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_TEMPLATE_CACHE: 'maybe' })).toThrow('AGENTRY_SANDBOX_TEMPLATE_CACHE')
    expect(() => loadConfig({ ...base, AGENTRY_SANDBOX_TEMPLATE_CACHE_MAX: '0' })).toThrow('AGENTRY_SANDBOX_TEMPLATE_CACHE_MAX')
  })
})
