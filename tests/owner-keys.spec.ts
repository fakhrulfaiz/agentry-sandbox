import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestService, type TestService } from '../src/testing.ts'

const adminKey = randomBytes(16).toString('hex')
const ADMIN = { AGENTRY_SANDBOX_ADMIN_KEYS: `sha256:${createHash('sha256').update(adminKey).digest('hex')}` }
let svc: TestService | undefined
afterEach(async () => { await svc?.close(); svc = undefined })

const admin = (s: TestService, path: string, init: RequestInit = {}) =>
  fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' } })
const withKey = (s: TestService, key: string, path: string, init: RequestInit & { owner?: string } = {}) =>
  fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.owner ? { 'x-agentry-owner': init.owner } : {}) } })
const mint = async (s: TestService, name: string, owner: string) =>
  (await (await admin(s, '/v1/admin/keys', { method: 'POST', body: JSON.stringify({ name, owner }) })).json()) as { id: string; key: string; owner: string }
const rpc = async (s: TestService, key: string, method: string, params: unknown = {}, id: number | null = 1) => {
  const res = await withKey(s, key, '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) })
  return { status: res.status, body: res.status === 202 ? undefined : await res.json() as { result?: any; error?: { message: string } } }
}
const tool = async (s: TestService, key: string, name: string, args: unknown = {}) => {
  const { body } = await rpc(s, key, 'tools/call', { name, arguments: args })
  return { isError: body?.result?.isError === true, data: JSON.parse(body!.result.content[0].text) as Record<string, any> }
}

describe('owner-bound access keys', () => {
  it('are made on the admin page, shown once, never listed, and revocable', async () => {
    svc = await startTestService(ADMIN)
    const made = await mint(svc, 'claude', 'alice')
    expect(made.key).toMatch(/^ask_[0-9a-f]{48}$/)
    const listed = JSON.stringify(await (await admin(svc, '/v1/admin/keys')).json())
    expect(listed).toContain('claude')
    expect(listed).not.toContain(made.key)
    expect(listed).not.toContain('hash')
    expect((await admin(svc, '/v1/admin/keys', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status).toBe(400)
    expect((await admin(svc, `/v1/admin/keys/${made.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await withKey(svc, made.key, '/v1/sandboxes')).status).toBe(401)
  })

  it('act as their owner on /v1, ignoring X-Agentry-Owner, and keep owners apart', async () => {
    svc = await startTestService(ADMIN)
    const alice = await mint(svc, 'a', 'alice')
    const bob = await mint(svc, 'b', 'bob')
    const created = await (await withKey(svc, alice.key, '/v1/sandboxes', { method: 'POST', body: JSON.stringify({ name: 'mine' }), owner: 'bob' })).json() as { id: string }
    expect((await withKey(svc, alice.key, `/v1/sandboxes/${created.id}`)).status).toBe(200)
    expect((await withKey(svc, bob.key, `/v1/sandboxes/${created.id}`)).status).toBe(404)
    // The service-wide key still names its owner.
    expect((await withKey(svc, svc.key, `/v1/sandboxes/${created.id}`, { owner: 'alice' })).status).toBe(200)
    expect((await withKey(svc, svc.key, '/v1/sandboxes')).status).toBe(400)
  })
})

describe('MCP endpoint', () => {
  it('needs an owner-bound key (a service key and a missing key are refused)', async () => {
    svc = await startTestService(ADMIN)
    expect((await rpc(svc, svc.key, 'tools/list')).status).toBe(401)
    expect((await fetch(`${svc.url}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('initializes, lists its tools, and runs the lifecycle for the key\'s owner', async () => {
    svc = await startTestService(ADMIN)
    const { key } = await mint(svc, 'claude', 'alice')
    expect((await rpc(svc, key, 'initialize', { protocolVersion: '2025-03-26' })).body!.result).toMatchObject({ serverInfo: { name: 'agentry-sandbox' }, capabilities: { tools: {} } })
    expect((await rpc(svc, key, 'notifications/initialized', {}, null)).status).toBe(202)
    const names = ((await rpc(svc, key, 'tools/list')).body!.result.tools as { name: string }[]).map((t) => t.name)
    expect(names).toEqual(['sandbox_list', 'sandbox_create', 'sandbox_start', 'sandbox_stop', 'sandbox_delete', 'sandbox_exec', 'sandbox_read_file', 'sandbox_write_file'])
    const created = await tool(svc, key, 'sandbox_create', { name: 'From Claude', packages: ['jq'], internet: false })
    expect(created.data).toMatchObject({ name: 'From Claude', state: 'running' })
    expect((await tool(svc, key, 'sandbox_list')).data.sandboxes).toHaveLength(1)
    expect((await tool(svc, key, 'sandbox_stop', { id: created.data.id })).data.state).toBe('stopped')
    expect((await tool(svc, key, 'sandbox_start', { id: created.data.id })).data.state).toBe('running')
    // Another owner's key cannot see it.
    const other = await mint(svc, 'other', 'bob')
    const missing = await tool(svc, other.key, 'sandbox_stop', { id: created.data.id })
    expect(missing.isError).toBe(true)
    expect(missing.data['error']).toMatch(/not found|sandbox/i)
    expect((await tool(svc, key, 'sandbox_delete', { id: created.data.id })).data).toMatchObject({ deleted: true })
    expect((await rpc(svc, key, 'tools/call', { name: 'nope' })).body!.error!.message).toContain('unknown tool')
  })
})
