/**
 * Generic workspace snapshots through envd: the same on every place. Save runs `tar -czf -` in the sandbox and
 * streams its output into a file; restore empties the workspace and streams a tar back in through stdin.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { EnvdClient } from '../envd/client.ts'
import { sq } from '../envd/run.ts'

const CHUNK = 256 * 1024
const decoder = new TextDecoder()

/** The snapshot grew past the size limit (the snapshot fails; HTTP never shows this, it is the snapshot's `error`). */
export class SnapshotTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`the workspace is larger than the snapshot limit (${String(Math.floor(maxBytes / 1024 / 1024))} MB)`)
    this.name = 'SnapshotTooLargeError'
  }
}

/**
 * GNU tar exits 1 when a file changes while it is read, which is expected for a snapshot of a running sandbox;
 * every other nonzero exit is a failure.
 */
const BENIGN = /file changed as we read it|file removed before we read it/

/**
 * Saves the workspace as a gzip tar at `file` (written to `<file>.part` and renamed when complete). Returns its size.
 * Aborts and leaves no file once the output passes `maxBytes`.
 */
export async function saveWorkspace(envd: EnvdClient, opts: { user: string; workspace: string; file: string; maxBytes: number; signal?: AbortSignal }): Promise<number> {
  const part = `${opts.file}.part`
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  opts.signal?.addEventListener('abort', onAbort)
  const out = createWriteStream(part, { mode: 0o600 })
  const failed = new Promise<never>((_, reject) => out.once('error', reject))
  failed.catch(() => {})
  let size = 0
  let code = -1
  let stderr = ''
  try {
    const stream = envd.process.start(
      { process: { cmd: '/bin/sh', args: ['-c', `tar -czf - -C ${sq(opts.workspace)} .`], envs: {} }, stdin: false },
      { headers: envd.userHeaders(opts.user), signal: abort.signal },
    )
    for await (const res of stream) {
      const ev = res.event?.event
      if (ev?.case === 'data') {
        if (ev.value.output.case === 'stdout') {
          const bytes = ev.value.output.value
          size += bytes.length
          if (size > opts.maxBytes) {
            abort.abort()
            throw new SnapshotTooLargeError(opts.maxBytes)
          }
          if (!out.write(bytes)) await Promise.race([once(out, 'drain'), failed])
        } else if (ev.value.output.case === 'stderr' && stderr.length < 4000) {
          stderr += decoder.decode(ev.value.output.value)
        }
      } else if (ev?.case === 'end') {
        code = ev.value.exitCode
      }
    }
    if (code !== 0 && !(code === 1 && BENIGN.test(stderr))) throw new Error(`tar failed (exit ${String(code)}): ${stderr.trim().slice(-500)}`)
    out.end()
    await Promise.race([once(out, 'finish'), failed])
    await rename(part, opts.file)
    return size
  } catch (e) {
    out.destroy()
    await rm(part, { force: true })
    if (e instanceof SnapshotTooLargeError) throw e
    if (opts.signal?.aborted) throw new Error('the snapshot was cancelled')
    throw e
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Replaces the workspace's contents with a saved tar: empties the folder (the folder itself stays, it may be a
 * mount), extracts, then gives the files to `owner` (the sandbox's agent user).
 */
export async function restoreWorkspace(envd: EnvdClient, opts: { user: string; workspace: string; file: string; owner: string; /** Empty the workspace first (default); false extracts over what is there. */ clear?: boolean }): Promise<void> {
  try {
    await stat(opts.file)
  } catch {
    throw new Error('the snapshot file is missing on the service host')
  }
  const tag = `restore-${randomBytes(8).toString('hex')}`
  const ws = sq(opts.workspace)
  const script = `set -e\n${opts.clear === false ? '' : `find ${ws} -mindepth 1 -delete\n`}tar -xzf - -C ${ws}\nchown -hR ${sq(`${opts.owner}:`)} ${ws}`
  const stream = envd.process.start(
    { process: { cmd: '/bin/sh', args: ['-c', script], envs: {} }, tag, stdin: true },
    { headers: envd.userHeaders(opts.user) },
  )
  const selector = { selector: { case: 'tag' as const, value: tag } }
  let code = -1
  let stderr = ''
  let started: () => void = () => {}
  const startedP = new Promise<void>((r) => { started = r })
  const reader = (async () => {
    for await (const res of stream) {
      const ev = res.event?.event
      if (ev?.case === 'start') started()
      else if (ev?.case === 'data' && ev.value.output.case === 'stderr' && stderr.length < 4000) stderr += decoder.decode(ev.value.output.value)
      else if (ev?.case === 'end') code = ev.value.exitCode
    }
    started()
  })()
  reader.catch(() => {})
  try {
    await startedP
    for await (const chunk of createReadStream(opts.file, { highWaterMark: CHUNK }) as AsyncIterable<Buffer>) {
      await envd.process.sendInput({ process: selector, input: { input: { case: 'stdin', value: new Uint8Array(chunk) } } })
    }
    await envd.process.closeStdin({ process: selector })
  } catch (e) {
    // The process may have ended already (tar failed early): its exit code below says why. Otherwise free it
    // (a tar waiting on stdin would hang) and report this error.
    await envd.process.closeStdin({ process: selector }).catch(() => {})
    await reader.catch(() => {})
    if (code === -1) throw e
  }
  await reader
  if (code !== 0) throw new Error(`restoring the workspace failed (exit ${String(code)}): ${stderr.trim().slice(-500)}`)
}
