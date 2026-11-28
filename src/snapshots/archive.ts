/**
 * Uploaded workspace snapshots: a tar (gzip or plain) is checked entry by entry before it is kept, because a
 * restore later extracts it as root-ish into a sandbox. Nothing is extracted here; the headers are read and refused
 * when an entry could land outside the workspace.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { extract } from 'tar-stream'
import type { Readable } from 'node:stream'

/** The upload is not acceptable (HTTP 400 `invalid_request`) or too large (HTTP 413). */
export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly tooLarge = false,
  ) {
    super(message)
    this.name = 'ArchiveError'
  }
}

/** Why an entry may not be in a snapshot, or undefined when it is fine. */
export function entryProblem(name: string, type: string | null | undefined, linkname: string | null | undefined): string | undefined {
  if (name.includes('\0')) return `entry name has a NUL byte`
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return `absolute path '${name}'`
  if (name.split(/[\\/]/).includes('..')) return `path with '..': '${name}'`
  if (type === 'file' || type === 'directory' || type === undefined || type === null) return undefined
  if (type === 'symlink' || type === 'link') {
    const target = linkname ?? ''
    if (target === '' || target.includes('\0')) return `empty link target for '${name}'`
    if (target.startsWith('/')) return `${type === 'symlink' ? 'symlink' : 'hard link'} '${name}' points to an absolute path`
    // A symlink target is relative to the link's folder; a hard link's is relative to the archive root.
    const resolved = posix.normalize(type === 'symlink' ? posix.join(posix.dirname(name), target) : target)
    if (resolved === '..' || resolved.startsWith('../')) return `${type === 'symlink' ? 'symlink' : 'hard link'} '${name}' points outside the workspace`
    return undefined
  }
  return `unsupported entry '${name}' (${type})`
}

/** Reads every header of a gzip tar; throws ArchiveError for the first unsafe or broken entry. Returns the entry count. */
export async function validateArchive(file: string, maxUnpackedBytes: number): Promise<number> {
  const ex = extract()
  let entries = 0
  let unpacked = 0
  ex.on('entry', (header, stream, next) => {
    const problem = entryProblem(header.name, header.type, header.linkname)
    if (problem) return next(new ArchiveError(problem))
    entries++
    unpacked += header.size ?? 0
    if (unpacked > maxUnpackedBytes) return next(new ArchiveError(`the archive unpacks to more than ${String(Math.floor(maxUnpackedBytes / 1024 / 1024))} MB`, true))
    stream.on('error', () => {})
    stream.resume()
    stream.on('end', next)
  })
  try {
    await pipeline(createReadStream(file), createGunzip(), ex)
  } catch (e) {
    if (e instanceof ArchiveError) throw e
    throw new ArchiveError(`not a valid tar.gz archive (${e instanceof Error ? e.message : String(e)})`)
  }
  if (entries === 0) throw new ArchiveError('the archive is empty')
  return entries
}

/** Writes `body` to `file`, refusing more than `maxBytes`. Returns the byte count. */
export async function receiveUpload(body: Readable, file: string, maxBytes: number): Promise<number> {
  const out = createWriteStream(file, { mode: 0o600 })
  let size = 0
  try {
    await pipeline(
      body,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          size += chunk.length
          if (size > maxBytes) throw new ArchiveError(`the upload is larger than ${String(Math.floor(maxBytes / 1024 / 1024))} MB`, true)
          yield chunk
        }
      },
      out,
    )
  } catch (e) {
    await rm(file, { force: true })
    throw e
  }
  return size
}

/** True when the file starts with the gzip magic bytes. */
export async function isGzip(file: string): Promise<boolean> {
  const fh = await open(file, 'r')
  try {
    const b = Buffer.alloc(2)
    const { bytesRead } = await fh.read(b, 0, 2, 0)
    return bytesRead === 2 && b[0] === 0x1f && b[1] === 0x8b
  } finally {
    await fh.close()
  }
}

/**
 * Turns an uploaded file at `part` into a checked gzip tar at the same path: a plain tar is compressed first.
 * On any failure the file is removed. Returns its final size.
 */
export async function acceptUpload(part: string, maxBytes: number): Promise<number> {
  try {
    if (!(await isGzip(part))) {
      const gz = `${part}.gz`
      try {
        await pipeline(createReadStream(part), createGzip(), createWriteStream(gz, { mode: 0o600 }))
        await rename(gz, part)
      } finally {
        await rm(gz, { force: true })
      }
    }
    await validateArchive(part, maxBytes * 4)
    return (await stat(part)).size
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }
}
