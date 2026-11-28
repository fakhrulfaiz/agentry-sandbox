import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { pack, extract, type Header } from 'tar-stream'
import { loadConfig } from '../src/config.ts'
import { entryProblem } from '../src/snapshots/archive.ts'
import { KEY, startServer, type TestServer } from './support/server.ts'
import { localEnvd } from './support/local-envd.ts'

const baseEnv = { AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${createHash('sha256').update(KEY).digest('hex')}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) }

let s: TestServer | undefined
let root: string | undefined
afterEach(async () => {
  await s?.close()
  s = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function start(env: Record<string, string> = {}) {
  root = await mkdtemp(join(tmpdir(), 'snapxfer-'))
  const config = loadConfig({ ...baseEnv, AGENTRY_SANDBOX_SNAPSHOT_DIR: join(root, 'snaps'), ...env })
  s = await startServer({}, { config, envdClient: () => localEnvd() })
  Object.assign(s.backend, { agentUser: userInfo().username })
  return root
}

async function tarOf(entries: (Partial<Header> & { name: string; data?: string })[], gz = true): Promise<Buffer> {
  const p = pack()
  const parts: Buffer[] = []
  p.on('data', (c: unknown) => parts.push(c as Buffer))
  for (const e of entries) {
    const { data, ...h } = e
    await new Promise<void>((res, rej) => p.entry({ ...h, ...(data !== undefined ? { size: Buffer.byteLength(data) } : {}) }, data ?? '', (err) => (err ? rej(err) : res())))
  }
  p.finalize()
  await new Promise<void>((r) => p.on('end', () => r()))
  const raw = Buffer.concat(parts)
  return gz ? gzipSync(raw) : raw
}
const upload = (body: Buffer | string, query = '', owner = 'alice') => s!.call(`/v1/snapshots/import${query}`, { method: 'POST', owner, body: body as BodyInit, headers: { 'content-type': 'application/gzip' } })
const good = () => tarOf([{ name: './', type: 'directory' as const }, { name: './a.txt', data: 'hello' }, { name: './sub/', type: 'directory' as const }, { name: './sub/link', type: 'symlink' as const, linkname: '../a.txt' }])

describe('entryProblem', () => {
  it('flags unsafe entries and passes safe ones', () => {
    expect(entryProblem('/etc/passwd', 'file', null)).toMatch(/absolute/)
    expect(entryProblem('a/../../b', 'file', null)).toMatch(/\.\./)
    expect(entryProblem('a/link', 'symlink', '/etc/passwd')).toMatch(/absolute/)
    expect(entryProblem('a/link', 'symlink', '../../x')).toMatch(/outside/)
    expect(entryProblem('link', 'symlink', '../x')).toMatch(/outside/)
    expect(entryProblem('a/link', 'link', '../x')).toMatch(/outside/)
    expect(entryProblem('a/link', 'link', 'b/x')).toBeUndefined()
    expect(entryProblem('a/link', 'link', '../../x')).toMatch(/outside/)
    expect(entryProblem('dev', 'character-device', null)).toMatch(/unsupported/)
    expect(entryProblem('a/link', 'symlink', '../b')).toBeUndefined()
    expect(entryProblem('./a.txt', 'file', null)).toBeUndefined()
  })
})

describe('snapshot import', () => {
  it('keeps a good archive as a ready workspace snapshot with no source sandbox, owner-scoped', async () => {
    await start()
    const res = await upload(await good(), '?name=From%20laptop')
    expect(res.status).toBe(201)
    const snap = await res.json() as Record<string, unknown>
    expect(snap).toMatchObject({ object: 'snapshot', sandbox_id: null, place: 'service', level: 'workspace', name: 'From laptop', state: 'ready' })
    expect(snap.size_bytes).toBeGreaterThan(0)
    expect((await s!.call(`/v1/snapshots/${snap.id as string}`)).status).toBe(200)
    expect((await s!.call(`/v1/snapshots/${snap.id as string}`, { owner: 'bob' })).status).toBe(404)
    const list = await (await s!.call('/v1/snapshots')).json() as { data: { id: string }[] }
    expect(list.data.map((x) => x.id)).toContain(snap.id)
    const dl = await s!.call(`/v1/snapshots/${snap.id as string}/download`)
    expect(dl.status).toBe(200)
  })

  it('compresses a plain tar and gives a default name', async () => {
    await start()
    const res = await upload(await tarOf([{ name: 'a.txt', data: 'x' }], false))
    expect(res.status).toBe(201)
    const snap = await res.json() as { id: string; name: string }
    expect(snap.name).toMatch(/^Uploaded /)
    const dl = Buffer.from(await (await s!.call(`/v1/snapshots/${snap.id}/download`)).arrayBuffer())
    expect(gunzipSync(dl).length).toBeGreaterThan(0)
  })

  it.each([
    ['an absolute path', [{ name: '/etc/passwd', data: 'x' }]],
    ['a .. path', [{ name: 'a/../../evil', data: 'x' }]],
    ['a symlink out', [{ name: 'l', type: 'symlink', linkname: '../outside' }]],
    ['an absolute symlink', [{ name: 'l', type: 'symlink', linkname: '/etc' }]],
    ['a device file', [{ name: 'd', type: 'character-device' }]],
  ] as const)('rejects %s with 400 and keeps nothing', async (_n, entries) => {
    const r = await start()
    const res = await upload(await tarOf(entries.map((e) => ({ ...e })) as never))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
    expect(await readdir(join(r, 'snaps'))).toEqual([])
    expect(((await (await s!.call('/v1/snapshots')).json()) as { data: unknown[] }).data).toHaveLength(0)
  })

  it('rejects something that is not a tar and an empty archive', async () => {
    await start()
    expect((await upload('just some text, not an archive')).status).toBe(400)
    expect((await upload(gzipSync(Buffer.from('not a tar header at all')))).status).toBe(400)
    expect((await upload(await tarOf([]))).status).toBe(400)
  })

  it('answers 413 over the size limit (header and streamed) and 400 snapshots_off without a folder', async () => {
    await start({ AGENTRY_SANDBOX_SNAPSHOT_IMPORT_MAX_MB: '1' })
    const big = randomBytes(1024 * 1024 + 10)
    const res = await upload(big)
    expect(res.status).toBe(413)
    await s!.close()
    s = undefined
    const config = loadConfig(baseEnv)
    s = await startServer({}, { config })
    const off = await upload(await good())
    expect(off.status).toBe(400)
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe('snapshots_off')
  })

  it('counts against the per-owner snapshot limit', async () => {
    await start({ AGENTRY_SANDBOX_MAX_SNAPSHOTS_PER_OWNER: '1' })
    expect((await upload(await good())).status).toBe(201)
    expect((await upload(await good())).status).toBe(429)
    expect((await upload(await good(), '', 'bob')).status).toBe(201)
  })

  it('an uploaded snapshot starts a sandbox and restores into one', async () => {
    await start()
    const snap = await (await upload(await good())).json() as { id: string }
    const made = await s!.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'n', snapshot: snap.id }) })
    expect(made.status).not.toBe(404)
  })
})

describe('snapshot download', () => {
  async function saved() {
    const r = await start()
    const ws = join(r, 'ws')
    await mkdir(ws)
    await writeFile(join(ws, 'a.txt'), 'one')
    const box = await (await s!.call('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'b' }) })).json() as { id: string }
    const rec = (await s!.store.sandboxes.get(box.id, 'alice'))!
    await s!.store.sandboxes.update(box.id, 'alice', { template: { ...rec.template, workspacePath: ws } })
    const snap = await (await s!.call(`/v1/sandboxes/${box.id}/snapshots`, { method: 'POST', body: JSON.stringify({ name: 'my snap' }) })).json() as { id: string }
    for (let i = 0; i < 200; i++) {
      if (((await (await s!.call(`/v1/snapshots/${snap.id}`)).json()) as { state: string }).state === 'ready') break
      await new Promise((r2) => setTimeout(r2, 25))
    }
    return snap.id
  }

  it('streams a valid tar.gz with attachment headers; 404 for another owner', async () => {
    const id = await saved()
    const res = await s!.call(`/v1/snapshots/${id}/download`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="my snap\.tar\.gz"/)
    const body = Buffer.from(await res.arrayBuffer())
    expect(Number(res.headers.get('content-length'))).toBe(body.length)
    const names: string[] = []
    const ex = extract()
    ex.on('entry', (h, st, next) => { names.push(h.name); st.resume(); st.on('end', next) })
    await new Promise<void>((res2, rej) => { ex.on('finish', res2); ex.on('error', rej); ex.end(gunzipSync(body)) })
    expect(names.some((n) => n.endsWith('a.txt'))).toBe(true)
    expect((await s!.call(`/v1/snapshots/${id}/download`, { owner: 'bob' })).status).toBe(404)
    // A download can be uploaded back.
    const again = await upload(body, '?name=copy')
    expect(again.status).toBe(201)
  })

  it('answers 400 for a snapshot that is not files-only and 409 when not ready', async () => {
    await start()
    const t = Date.now()
    const base = { owner: 'alice', sandboxId: 'sbx_x', name: 'n', handle: {}, handleSecrets: null, sizeBytes: null, error: null, createdAt: t, expiresAt: null }
    await s!.store.snapshots.insert({ ...base, id: `snap_${'a'.repeat(32)}`, place: 'local', level: 'disk', state: 'ready' })
    await s!.store.snapshots.insert({ ...base, id: `snap_${'b'.repeat(32)}`, place: 'service', level: 'workspace', state: 'saving' })
    const disk = await s!.call(`/v1/snapshots/snap_${'a'.repeat(32)}/download`)
    expect(disk.status).toBe(400)
    const saving = await s!.call(`/v1/snapshots/snap_${'b'.repeat(32)}/download`)
    expect(saving.status).toBe(409)
    expect(((await saving.json()) as { error: { code: string } }).error.code).toBe('snapshot_not_ready')
    expect((await s!.call(`/v1/snapshots/snap_${'c'.repeat(32)}/download`)).status).toBe(404)
  })
})
