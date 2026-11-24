/**
 * The envd binary, read once from the `agentry/envd` image and re-packed as a
 * tar that puts it at `/opt/agentry/envd` (mode 0755), ready for `putArchive`
 * into any container.
 */
import type Docker from 'dockerode'
import { extract, pack } from 'tar-stream'

const cache = new Map<string, Promise<Buffer>>()

async function readEnvd(docker: Docker, image: string): Promise<Buffer> {
  const container = await docker.createContainer({ Image: image, Cmd: ['/envd'] })
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

/** The raw envd binary from `image` (cached per image). */
export function loadEnvdBinary(docker: Docker, image: string): Promise<Buffer> {
  let p = cache.get(image)
  if (!p) {
    p = readEnvd(docker, image)
    p.catch(() => cache.delete(image))
    cache.set(image, p)
  }
  return p
}

/** A tar placing envd at `/opt/agentry/envd`, for `container.putArchive(tar, { path: '/' })`. */
export async function envdArchive(docker: Docker, image: string): Promise<Buffer> {
  const binary = await loadEnvdBinary(docker, image)
  const p = pack()
  p.entry({ name: 'opt/agentry', type: 'directory', mode: 0o755 })
  p.entry({ name: 'opt/agentry/envd', mode: 0o755, size: binary.length }, binary)
  p.finalize()
  const parts: Buffer[] = []
  for await (const c of p as AsyncIterable<Buffer>) parts.push(c)
  return Buffer.concat(parts)
}

const trees = new Map<string, Promise<Buffer>>()

async function readTree(docker: Docker, image: string, path: string): Promise<Buffer> {
  const container = await docker.createContainer({ Image: image, Cmd: ['/none'] })
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
 * cached per image, for `putArchive(tar, { path: dirname(path) })`.
 */
export function treeArchive(docker: Docker, image: string, path: string): Promise<Buffer> {
  const key = `${image}\0${path}`
  let p = trees.get(key)
  if (!p) {
    p = readTree(docker, image, path)
    p.catch(() => trees.delete(key))
    trees.set(key, p)
  }
  return p
}
