/**
 * The envd binary, read once from the `agentry/envd` image and re-packed as a
 * tar that puts it at `/opt/agentry/envd` (mode 0755), ready for `putArchive`
 * into any container.
 */
import type Docker from 'dockerode'
import { extract, pack } from 'tar-stream'

import type { EnsureImage, Platform } from '../places/images.ts'

/** Per Docker client (each host has its own architecture), then per image. */
const cache = new WeakMap<Docker, Map<string, Promise<Buffer>>>()

function cacheOf<T>(store: WeakMap<Docker, Map<string, Promise<T>>>, docker: Docker): Map<string, Promise<T>> {
  let m = store.get(docker)
  if (!m) store.set(docker, (m = new Map()))
  return m
}

async function readEnvd(docker: Docker, image: string, ensure?: EnsureImage, platform?: Platform): Promise<Buffer> {
  await ensure?.(image, platform)
  const container = await docker.createContainer({ Image: image, Cmd: ['/envd'], ...(platform ? { platform } : {}) } as Docker.ContainerCreateOptions)
  try {
    const stream = (await container.getArchive({ path: '/envd' })) as NodeJS.ReadableStream
    const ex = extract()
    let binary: Buffer | undefined
    ex.on('entry', (header, entry, next) => {
      const parts: Buffer[] = []
      entry.on('data', (c: unknown) => parts.push(c as Buffer))
      entry.on('end', () => {
        if (header.name.replace(/^\.?\//, '') === 'envd') binary = Buffer.concat(parts)
        next()
      })
    })
    await new Promise<void>((resolve, reject) => {
      ex.on('finish', resolve)
      ex.on('error', reject)
      stream.pipe(ex)
    })
    if (!binary || binary.length === 0) throw new Error(`envd binary not found in ${image}`)
    return binary
  } finally {
    await container.remove({ force: true })
  }
}

/** The raw envd binary from `image` on this Docker client's host (cached per client and image; pulled when missing). */
export function loadEnvdBinary(docker: Docker, image: string, ensure?: EnsureImage, platform?: Platform): Promise<Buffer> {
  const m = cacheOf(cache, docker)
  const key = `${image}\0${platform ?? ''}`
  let p = m.get(key)
  if (!p) {
    p = readEnvd(docker, image, ensure, platform)
    p.catch(() => m.delete(key))
    m.set(key, p)
  }
  return p
}

/** A tar placing envd at `/opt/agentry/envd`, for `container.putArchive(tar, { path: '/' })`. */
export async function envdArchive(docker: Docker, image: string, ensure?: EnsureImage, platform?: Platform): Promise<Buffer> {
  const binary = await loadEnvdBinary(docker, image, ensure, platform)
  const p = pack()
  p.entry({ name: 'opt/agentry', type: 'directory', mode: 0o755 })
  p.entry({ name: 'opt/agentry/envd', mode: 0o755, size: binary.length }, binary)
  p.finalize()
  const parts: Buffer[] = []
  for await (const c of p as AsyncIterable<Buffer>) parts.push(c)
  return Buffer.concat(parts)
}

const trees = new WeakMap<Docker, Map<string, Promise<Buffer>>>()

async function readTree(docker: Docker, image: string, path: string, ensure?: EnsureImage, platform?: Platform): Promise<Buffer> {
  await ensure?.(image, platform)
  const container = await docker.createContainer({ Image: image, Cmd: ['/none'], ...(platform ? { platform } : {}) } as Docker.ContainerCreateOptions)
  try {
    const stream = (await container.getArchive({ path })) as NodeJS.ReadableStream
    const parts: Buffer[] = []
    for await (const c of stream as AsyncIterable<Buffer>) parts.push(c)
    const tar = Buffer.concat(parts)
    if (tar.length === 0) throw new Error(`${path} not found in ${image}`)
    return tar
  } finally {
    await container.remove({ force: true })
  }
}

/**
 * The directory `path` of `image` as Docker's tar (entries rooted at its basename),
 * cached per Docker client and image, for `putArchive(tar, { path: dirname(path) })`.
 */
export function treeArchive(docker: Docker, image: string, path: string, ensure?: EnsureImage, platform?: Platform): Promise<Buffer> {
  const key = `${image}\0${path}\0${platform ?? ''}`
  const m = cacheOf(trees, docker)
  let p = m.get(key)
  if (!p) {
    p = readTree(docker, image, path, ensure, platform)
    p.catch(() => m.delete(key))
    m.set(key, p)
  }
  return p
}
