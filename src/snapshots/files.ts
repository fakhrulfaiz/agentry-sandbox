/** The generic snapshot store: one `<snapshot id>.tar.gz` per snapshot in `AGENTRY_SANDBOX_SNAPSHOT_DIR`. */
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Snapshot ids are `snap_` plus 32 hex; anything else never reaches the file system. */
const SNAPSHOT_ID = /^snap_[0-9a-f]{32}$/

/** The final path of a snapshot's file; throws on an id that is not ours (no path tricks). */
export function snapshotFile(dir: string, id: string): string {
  if (!SNAPSHOT_ID.test(id)) throw new Error('invalid snapshot id')
  return join(dir, `${id}.tar.gz`)
}

export async function ensureSnapshotDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** Deletes a snapshot's file and any half-written `.part`; a file that is already gone is fine. */
export async function removeSnapshotFile(dir: string, id: string): Promise<void> {
  const file = snapshotFile(dir, id)
  await rm(file, { force: true })
  await rm(`${file}.part`, { force: true })
}

export async function snapshotFileSize(dir: string, id: string): Promise<number | undefined> {
  try {
    return (await stat(snapshotFile(dir, id))).size
  } catch {
    return undefined
  }
}

/** Removes `.part` files left by a crash (called at startup) and returns how many. */
export async function removeStaleParts(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const parts = names.filter((n) => /^snap_[0-9a-f]{32}\.tar\.gz\.part$/.test(n))
  await Promise.all(parts.map((n) => rm(join(dir, n), { force: true })))
  return parts.length
}
