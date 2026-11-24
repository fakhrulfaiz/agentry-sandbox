/** The store contract, run against every Store implementation. */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SandboxRecord, Store, TemplateRecord } from '../src/store/types.ts'

let n = 0
export const sandbox = (over: Partial<SandboxRecord> = {}): SandboxRecord => ({
  id: `sbx_${(++n).toString(16).padStart(32, '0')}`,
  owner: 'alice',
  name: 'box',
  backend: 'docker',
  template: { image: 'debian:bookworm-slim', packages: ['jq'], env: { A: '1' } },
  templateId: null,
  state: 'provisioning',
  handle: {},
  error: null,
  createdAt: 1_000 + n,
  startedAt: null,
  lastUsedAt: null,
  ...over,
})
const template = (over: Partial<TemplateRecord> = {}): TemplateRecord => ({
  id: `tpl_${(++n).toString(16).padStart(32, '0')}`,
  owner: 'alice',
  name: 'python',
  spec: { image: 'python:3.13', setupCommands: ['pip install rich'], files: [{ path: 'a.txt', content: 'x' }], network: false },
  createdAt: 5,
  updatedAt: 5,
  ...over,
})

export function storeContract(name: string, make: () => Promise<Store>) {
  describe(name, () => {
    let store: Store
    beforeEach(async () => {
      store = await make()
    })

    it('get by another owner returns undefined', async () => {
      const r = sandbox()
      await store.sandboxes.insert(r)
      expect(await store.sandboxes.get(r.id, 'alice')).toEqual(r)
      expect(await store.sandboxes.get(r.id, 'bob')).toBeUndefined()
      expect(await store.sandboxes.getAny(r.id)).toEqual(r)
    })

    it('update patches state, handle and error and returns the row', async () => {
      const r = sandbox()
      await store.sandboxes.insert(r)
      const u = await store.sandboxes.update(r.id, 'alice', { state: 'running', handle: { containerId: 'c1' }, error: null, startedAt: 9 })
      expect(u).toMatchObject({ state: 'running', handle: { containerId: 'c1' }, startedAt: 9 })
      expect(await store.sandboxes.update(r.id, 'bob', { state: 'failed' })).toBeUndefined()
      expect((await store.sandboxes.get(r.id, 'alice'))?.state).toBe('running')
    })

    it('list is owner-scoped and ordered by createdAt', async () => {
      const a = sandbox({ createdAt: 20 })
      const b = sandbox({ createdAt: 10 })
      const c = sandbox({ owner: 'bob' })
      for (const r of [a, b, c]) await store.sandboxes.insert(r)
      expect((await store.sandboxes.list('alice')).map((r) => r.id)).toEqual([b.id, a.id])
    })

    it('listAll returns every owner', async () => {
      const a = sandbox()
      const b = sandbox({ owner: 'bob' })
      await store.sandboxes.insert(a)
      await store.sandboxes.insert(b)
      const ids = (await store.sandboxes.listAll()).map((r) => r.id)
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))
    })

    it('removal is owner-scoped', async () => {
      const r = sandbox()
      await store.sandboxes.insert(r)
      expect(await store.sandboxes.delete(r.id, 'bob')).toBe(false)
      expect(await store.sandboxes.delete(r.id, 'alice')).toBe(true)
      expect(await store.sandboxes.get(r.id, 'alice')).toBeUndefined()
    })

    it('template CRUD round-trips spec JSON exactly', async () => {
      const t = template()
      await store.templates.insert(t)
      expect(await store.templates.get(t.id, 'alice')).toEqual(t)
      expect(await store.templates.get(t.id, 'bob')).toBeUndefined()
      expect((await store.templates.list('alice')).map((x) => x.id)).toContain(t.id)
      const u = await store.templates.update(t.id, 'alice', { name: 'py', spec: { image: 'python:3.12' }, updatedAt: 6 })
      expect(u).toMatchObject({ name: 'py', spec: { image: 'python:3.12' }, updatedAt: 6 })
      expect(await store.templates.delete(t.id, 'alice')).toBe(true)
      expect(await store.templates.get(t.id, 'alice')).toBeUndefined()
    })
  })
}
