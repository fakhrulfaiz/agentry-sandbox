import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'
import { ensureSnapshotDir, removeSnapshotFile, removeStaleParts, snapshotFile } from '../src/snapshots/files.ts'
import { restoreWorkspace, saveWorkspace, SnapshotTooLargeError } from '../src/snapshots/workspace-tar.ts'
import { dockerAvailable } from './support/docker.ts'
import { startBareEnvd, type BareEnvd } from './support/bare-envd.ts'
import { localEnvd } from './support/local-envd.ts'

const ID = `snap_${'a'.repeat(32)}`

describe('snapshot files', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'snaps-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('only accepts snapshot ids as file names', () => {
    expect(snapshotFile(dir, ID)).toBe(join(dir, `${ID}.tar.gz`))
    for (const bad of ['../etc/passwd', 'snap_x', `${ID}/..`, `${ID}.tar.gz`, '']) expect(() => snapshotFile(dir, bad)).toThrow('invalid snapshot id')
  })

  it('creates the folder privately, removes a file and its .part, and clears stale parts', async () => {
    const sub = join(dir, 'a', 'b')
    await ensureSnapshotDir(sub)
    expect((await stat(sub)).mode & 0o777).toBe(0o700)
    await writeFile(snapshotFile(sub, ID), 'x')
    await writeFile(`${snapshotFile(sub, ID)}.part`, 'y')
    await removeSnapshotFile(sub, ID)
    expect(await readdir(sub)).toEqual([])
    await removeSnapshotFile(sub, ID)
    await writeFile(`${snapshotFile(sub, ID)}.part`, 'y')
    await writeFile(snapshotFile(sub, `snap_${'b'.repeat(32)}`), 'z')
    expect(await removeStaleParts(sub)).toBe(1)
    expect(await readdir(sub)).toEqual([`snap_${'b'.repeat(32)}.tar.gz`])
  })
})

describe('workspace snapshots (local process stand-in for envd)', () => {
  let dir: string
  let ws: string
  const me = userInfo().username
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snaps-'))
    ws = join(dir, 'workspace')
    await mkdir(ws)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('saves and restores a workspace byte for byte', async () => {
    await mkdir(join(ws, 'sub', 'empty'), { recursive: true })
    await writeFile(join(ws, 'a.txt'), 'hello')
    await writeFile(join(ws, '.hidden'), 'dot')
    await writeFile(join(ws, 'sub', 'run.sh'), '#!/bin/sh\n')
    await chmod(join(ws, 'sub', 'run.sh'), 0o750)
    await symlink('a.txt', join(ws, 'link'))
    const bin = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256))
    await writeFile(join(ws, 'big.bin'), bin)
    const file = join(dir, 'snap.tar.gz')
    const envd = localEnvd()
    const size = await saveWorkspace(envd, { user: 'root', workspace: ws, file, maxBytes: 10_000_000 })
    expect(size).toBe((await stat(file)).size)
    expect(existsSync(`${file}.part`)).toBe(false)

    await rm(ws, { recursive: true })
    await mkdir(ws)
    await writeFile(join(ws, 'other'), 'x')
    await restoreWorkspace(envd, { user: 'root', workspace: ws, file, owner: me })
    expect((await readFile(join(ws, 'a.txt'))).toString()).toBe('hello')
    expect((await readFile(join(ws, '.hidden'))).toString()).toBe('dot')
    expect(Buffer.compare(await readFile(join(ws, 'big.bin')), bin)).toBe(0)
    expect((await stat(join(ws, 'sub', 'empty'))).isDirectory()).toBe(true)
    expect((await stat(join(ws, 'sub', 'run.sh'))).mode & 0o777).toBe(0o750)
    expect(await readlink(join(ws, 'link'))).toBe('a.txt')
  })

  it('restore empties the workspace first', async () => {
    await writeFile(join(ws, 'keep.txt'), 'k')
    const file = join(dir, 'snap.tar.gz')
    const envd = localEnvd()
    await saveWorkspace(envd, { user: 'root', workspace: ws, file, maxBytes: 10_000_000 })
    await writeFile(join(ws, 'later.txt'), 'l')
    await mkdir(join(ws, '.cache', 'x'), { recursive: true })
    await restoreWorkspace(envd, { user: 'root', workspace: ws, file, owner: me })
    expect((await readdir(ws)).sort()).toEqual(['keep.txt'])
  })

  it('aborts past the size limit and leaves no file', async () => {
    await writeFile(join(ws, 'noise.bin'), Buffer.from(Array.from({ length: 200_000 }, () => Math.floor(Math.random() * 256))))
    const file = join(dir, 'snap.tar.gz')
    await expect(saveWorkspace(localEnvd(), { user: 'root', workspace: ws, file, maxBytes: 1_000 })).rejects.toBeInstanceOf(SnapshotTooLargeError)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.part`)).toBe(false)
  })

  it('a failing tar leaves no file and reports its stderr', async () => {
    const file = join(dir, 'snap.tar.gz')
    await expect(saveWorkspace(localEnvd(), { user: 'root', workspace: join(dir, 'missing'), file, maxBytes: 1_000_000 })).rejects.toThrow(/tar failed/)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.part`)).toBe(false)
  })

  it('a restore of a file that is not a tar fails and says so', async () => {
    const file = join(dir, 'bad.tar.gz')
    await writeFile(file, 'not a tar')
    await expect(restoreWorkspace(localEnvd(), { user: 'root', workspace: ws, file, owner: me })).rejects.toThrow(/restoring the workspace failed/)
  })
})

describe.skipIf(!dockerAvailable)('workspace snapshots through a real envd', () => {
  let envd: BareEnvd
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snaps-'))
    envd = await startBareEnvd()
  }, 120_000)
  afterEach(async () => {
    await envd?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips files and ends owned by the agent user', async () => {
    // The bare container has no per-sandbox token derivation: envd accepts the token it was started with (none).
    const c = createEnvdClient({ baseUrl: envd.baseUrl, accessToken: '' })
    await runInEnvd(c, 'root', 'useradd -m -u 1000 agent; mkdir -p /workspace/d; echo hi > /workspace/d/a.txt; ln -s d/a.txt /workspace/l; chmod 750 /workspace/d', { cwd: '/' })
    const file = join(dir, 'snap.tar.gz')
    await saveWorkspace(c, { user: 'root', workspace: '/workspace', file, maxBytes: 50_000_000 })
    await runInEnvd(c, 'root', 'rm -rf /workspace/* /workspace/.[!.]*; echo junk > /workspace/junk', { cwd: '/' })
    await restoreWorkspace(c, { user: 'root', workspace: '/workspace', file, owner: 'agent' })
    const r = await runInEnvd(c, 'root', 'ls /workspace; cat /workspace/d/a.txt; stat -c "%U %a" /workspace/d /workspace/d/a.txt; readlink /workspace/l', { cwd: '/' })
    expect(r.stdout).toBe('d\nl\nhi\nagent 750\nagent 644\nd/a.txt\n')
  }, 120_000)
})
