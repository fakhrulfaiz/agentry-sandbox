import { describe, expect, it } from 'vitest'
import { createEnsureImage, platformRef } from '../src/places/images.ts'

/** A daemon's classic image store: tags name image ids; a pull moves the tag to the pulled platform's image. */
function fakeDaemon(hostArch: 'amd64' | 'arm64', local: Record<string, 'amd64' | 'arm64'> = {}) {
  const images = new Map<string, { Id: string; arch: string }>(Object.entries(local).map(([name, arch]) => [name, { Id: `sha256:${name}-${arch}`, arch }]))
  const byId = new Map([...images.values()].map((i) => [i.Id, i]))
  const resolve = (name: string) => images.get(name) ?? byId.get(name)
  const notFound = () => Object.assign(new Error('No such image'), { statusCode: 404 })
  const daemon = {
    images,
    getImage: (name: string) => ({
      inspect: async () => {
        const i = resolve(name)
        if (!i) throw notFound()
        return { Id: i.Id, Os: 'linux', Architecture: i.arch }
      },
      tag: async ({ repo, tag }: { repo: string; tag: string }) => {
        const i = resolve(name)
        if (!i) throw notFound()
        images.set(`${repo}:${tag}`, i)
      },
      remove: async () => {
        images.delete(name)
      },
    }),
    pull: async (name: string, opts: { platform?: string }) => {
      const arch = opts.platform ? opts.platform.slice('linux/'.length) : hostArch
      const img = { Id: `sha256:${name}-${arch}`, arch }
      byId.set(img.Id, img)
      images.set(name, img)
      return {}
    },
    modem: { followProgress: (_s: unknown, done: (e: Error | null) => void) => done(null) },
  }
  return daemon
}

const IMG = 'ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13'

describe('createEnsureImage with a platform', () => {
  it('never re-points the shared tag when another architecture is pulled', async () => {
    const d = fakeDaemon('amd64', { [IMG]: 'amd64' })
    const before = d.images.get(IMG)!.Id
    const ensure = createEnsureImage(d as never)
    await ensure(IMG, 'linux/arm64')
    expect(d.images.get(IMG)).toMatchObject({ Id: before, arch: 'amd64' }) // what the local driver (no platform) resolves
    expect(d.images.get(platformRef(IMG, 'linux/arm64'))).toMatchObject({ arch: 'arm64' })
    await ensure(IMG)
    expect(d.images.get(IMG)!.Id).toBe(before)
    // A second request does not pull again.
    const pulled = d.images.get(platformRef(IMG, 'linux/arm64'))
    await ensure(IMG, 'linux/arm64')
    expect(d.images.get(platformRef(IMG, 'linux/arm64'))).toBe(pulled)
  })

  it('leaves the shared tag absent when the host never had it', async () => {
    const d = fakeDaemon('amd64')
    await createEnsureImage(d as never)(IMG, 'linux/arm64')
    expect(d.images.has(IMG)).toBe(false)
    expect(d.images.get(platformRef(IMG, 'linux/arm64'))).toMatchObject({ arch: 'arm64' })
  })

  it('a matching shared image is only tagged under the platform name', async () => {
    const d = fakeDaemon('amd64', { [IMG]: 'amd64' })
    let pulls = 0
    const pull = d.pull
    d.pull = async (...a) => { pulls++; return pull(...a) }
    await createEnsureImage(d as never)(IMG, 'linux/amd64')
    expect(pulls).toBe(0)
    expect(d.images.get(platformRef(IMG, 'linux/amd64'))).toMatchObject({ arch: 'amd64' })
  })
})
