import http from 'node:http'
import type Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type SandboxConfig } from '../src/config.ts'
import { createPassthroughNetworkGuard } from '../src/places/driver.ts'
import { createDockerDriver } from '../src/places/drivers/docker.ts'
import { BOOTSTRAP_VERSION, cacheKey, cacheTag, pruneList } from '../src/places/template-cache.ts'

vi.mock('../src/backends/envd-binary.ts', () => ({ envdArchive: async () => Buffer.from('envd') }))

const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  ...loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) }),
  envdReach: 'loopback',
  ...over,
})

describe('cache key', () => {
  const input = { baseImage: 'sha256:aaa', packages: ['git', 'jq'], runtimeRef: 'dsh@amd64' }
  it('ignores package order and duplicates and changes with every input', () => {
    const k = cacheKey(input)
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(cacheKey({ ...input, packages: ['jq', 'git', 'jq'] })).toBe(k)
    expect(cacheKey({ ...input, packages: ['git'] })).not.toBe(k)
    expect(cacheKey({ ...input, packages: undefined })).toBe(cacheKey({ ...input, packages: [] }))
    expect(cacheKey({ ...input, baseImage: 'sha256:bbb' })).not.toBe(k)
    expect(cacheKey({ ...input, runtimeRef: 'dsh@arm64' })).not.toBe(k)
    expect(BOOTSTRAP_VERSION).toBeTruthy()
  })
  it('pruneList keeps the newest N', () => {
    const images = [1, 5, 3, 4, 2].map((usedAt) => ({ id: `i${String(usedAt)}`, usedAt }))
    expect(pruneList(images, 3).map((i) => i.id)).toEqual(['i2', 'i1'])
    expect(pruneList(images, 10)).toEqual([])
  })
})

/** A Docker stub that knows which images exist, what was created from which, and what was committed and removed. */
function stubDocker(opts: { port: number; cached?: string[]; commitFails?: boolean; extraCache?: { id: string; tag: string; created: number }[]; inUse?: string[] }) {
  const images = new Set<string>(['base:1', ...(opts.cached ?? [])])
  const created: string[] = []
  const committed: Record<string, unknown>[] = []
  const removed: string[] = []
  const extra = opts.extraCache ?? []
  const notFound = () => Object.assign(new Error('no such image'), { statusCode: 404 })
  const client = {
    version: async () => ({ Version: '1', Arch: 'amd64' }),
    createVolume: async () => ({}),
    getImage: (ref: string) => ({
      inspect: async () => {
        if (!images.has(ref)) throw notFound()
        return { Id: ref === 'base:1' ? 'sha256:base' : `sha256:${ref}` }
      },
      remove: async () => {
        if (opts.inUse?.includes(ref)) throw Object.assign(new Error('in use'), { statusCode: 409 })
        removed.push(ref)
      },
    }),
    listImages: async () => [
      ...[...images].filter((t) => t.startsWith('agentry-template-cache:')).map((t) => ({ Id: `sha256:${t}`, RepoTags: [t], Created: 1000 })),
      ...extra.map((e) => ({ Id: e.id, RepoTags: [e.tag], Created: e.created })),
    ],
    createContainer: async (c: { Image: string }) => {
      created.push(c.Image)
      return { id: `c${String(created.length)}`, putArchive: async () => {} }
    },
    getContainer: (id: string) => ({
      id,
      inspect: async () => ({ State: { Running: true }, NetworkSettings: { Ports: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: String(opts.port) }] } }, HostConfig: {} }),
      start: async () => {},
      stop: async () => {},
      remove: async () => {},
      commit: async (o: Record<string, unknown>) => {
        if (opts.commitFails) throw new Error('commit exploded')
        committed.push(o)
        images.add(`${String(o.repo)}:${String(o.tag)}`)
      },
    }),
    getVolume: () => ({ remove: async () => {} }),
  } as unknown as Docker
  return { client, images, created, committed, removed }
}

describe('docker driver template cache', () => {
  let envd: http.Server
  let port = 0
  beforeEach(async () => {
    envd = http.createServer((_q, r) => r.writeHead(204).end())
    await new Promise<void>((r) => envd.listen(0, '127.0.0.1', r))
    port = (envd.address() as { port: number }).port
  })
  afterEach(() => new Promise<void>((r) => envd.close(() => r())))

  const make = (docker: ReturnType<typeof stubDocker>, over: Partial<SandboxConfig> = {}) =>
    createDockerDriver(config({ defaultImage: 'base:1', ...over }), createPassthroughNetworkGuard(), docker.client, docker.client)
  const key = (packages?: string[]) => cacheKey({ baseImage: 'sha256:base', packages, runtimeRef: 'dsh@amd64' })
  const ctx = (extra: { progress?: (p: { stage: string }) => void } = {}) => ({ gpuIds: [], runtimeRef: 'dsh', ...extra }) as never

  it('a miss creates from the base image, remembers the key, and commit saves it under the tag', async () => {
    const docker = stubDocker({ port })
    const driver = make(docker)
    const h = await driver.create('sbx_1', 'alice', { packages: ['jq'] }, ctx())
    expect(docker.created).toEqual(['base:1'])
    expect(h).toMatchObject({ cache: 'miss', cacheKey: key(['jq']), cacheBase: 'sha256:base' })
    await driver.commitCache!(h)
    expect(docker.committed).toHaveLength(1)
    expect(docker.committed[0]).toMatchObject({ repo: 'agentry-template-cache', tag: cacheTag(key(['jq'])).split(':')[1], pause: true })
    const changes = docker.committed[0]!.changes as string[]
    expect(changes).toContain('LABEL agentry.sandbox.owner=""')
    expect(changes.join('\n')).not.toContain('alice')
  })

  it('a second create of the same template starts from the cached image; another package list misses', async () => {
    const docker = stubDocker({ port, cached: [cacheTag(key(['jq']))] })
    const driver = make(docker)
    const hit = await driver.create('sbx_1', 'alice', { packages: ['jq'] }, ctx())
    expect(docker.created).toEqual([cacheTag(key(['jq']))])
    expect(hit.cache).toBe('hit')
    const miss = await driver.create('sbx_2', 'alice', { packages: ['jq', 'git'] }, ctx())
    expect(docker.created[1]).toBe('base:1')
    expect(miss.cache).toBe('miss')
  })

  it('a commit failure does not fail anything and leaves no image', async () => {
    const docker = stubDocker({ port, commitFails: true })
    const driver = make(docker)
    const h = await driver.create('sbx_1', 'alice', {}, ctx())
    await expect(driver.commitCache!(h)).resolves.toBeUndefined()
    expect(docker.images.has(cacheTag(key()))).toBe(false)
  })

  it('keeps at most templateCacheMax images, newest first, and leaves an image Docker says is in use', async () => {
    const old = (n: number) => ({ id: `sha256:old${String(n)}`, tag: `agentry-template-cache:old${String(n)}`, created: n })
    const docker = stubDocker({ port, extraCache: [old(1), old(2), old(3)], inUse: ['agentry-template-cache:old1'] })
    const driver = make(docker, { templateCacheMax: 2 })
    const h = await driver.create('sbx_1', 'alice', {}, ctx())
    await driver.commitCache!(h)
    // Four cache images, keep two: the new one and old3 stay; old2 goes; old1 is refused by Docker (409) and stays.
    expect(docker.removed).toEqual(['agentry-template-cache:old2'])
  })

  it('AGENTRY_SANDBOX_TEMPLATE_CACHE=off creates from the base image and never commits', async () => {
    const docker = stubDocker({ port, cached: [cacheTag(key())] })
    const driver = make(docker, { templateCache: false })
    const h = await driver.create('sbx_1', 'alice', {}, ctx())
    expect(docker.created).toEqual(['base:1'])
    expect(h.cache).toBeUndefined()
    await driver.commitCache!(h)
    expect(docker.committed).toHaveLength(0)
  })

  it('no runtime ref, no cache (callers that do not know the bootstrap)', async () => {
    const docker = stubDocker({ port, cached: [cacheTag(key())] })
    const h = await make(docker).create('sbx_1', 'alice', {}, { gpuIds: [] })
    expect(docker.created).toEqual(['base:1'])
    expect(h.cacheKey).toBeUndefined()
  })

  it('reports starting while it creates', async () => {
    const docker = stubDocker({ port })
    const stages: string[] = []
    await make(docker).create('sbx_1', 'alice', {}, ctx({ progress: (p) => stages.push(p.stage) }))
    expect(stages).toEqual(['starting'])
  })
})
