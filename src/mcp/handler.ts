/**
 * A Model Context Protocol endpoint (`POST /mcp`, stateless streamable HTTP with JSON responses) that gives any
 * MCP client (Claude Code, Cursor, other harnesses) the same sandboxes as the Agentry API, as tools. It is a client of
 * this service's own public API: the caller's owner-bound key is forwarded, so ownership, limits and the egress
 * guard apply exactly as they do for any other caller.
 */
import type http from 'node:http'
import { posix } from 'node:path'
import { createSandboxApi, runInEnvd, SandboxApiError, type SandboxApi, type WireSandbox, type WireTemplate } from '../client/index.ts'

const PROTOCOL = '2025-03-26'
const OUT_MAX = 20_000
const FILE_MAX = 256 * 1024

type Args = Record<string, unknown>
interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(api: SandboxApi, args: Args): Promise<unknown>
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false })
const ID = { id: { type: 'string', description: 'The sandbox id (sbx_...), from sandbox_list or sandbox_create.' } }
const tail = (text: string, max: number) => (text.length > max ? `[output cut: last ${String(max)} characters]\n${text.slice(-max)}` : text)
const summary = (s: WireSandbox) => ({ id: s.id, name: s.name, state: s.state, image: s.image, place: s.place, workspace: s.workspace_path, ...(s.error ? { error: s.error } : {}) })
const inWorkspace = (s: WireSandbox, path: string) => (path.startsWith('/') ? path : posix.join(s.workspace_path, path))

export const TOOLS: Tool[] = [
  { name: 'sandbox_list', description: 'List your isolated sandboxes (Linux containers) with their state.', inputSchema: schema({}), run: async (api) => ({ sandboxes: (await api.list()).map(summary) }) },
  {
    name: 'sandbox_create',
    description: 'Create an isolated Linux sandbox (you are `agent` with sudo; internet access, no private networks). Put software in the package lists, not in setup_commands; keep setup_commands trivial. Counts against your limits; delete it when done.',
    inputSchema: schema({
      name: { type: 'string', description: 'Short name, such as "Scraper test".' },
      image: { type: 'string', description: 'Container image. Omit for the standard image (Debian, Python 3, Node 24, git).' },
      packages: { type: 'array', items: { type: 'string' }, description: 'System (apt) packages.' },
      setup_commands: { type: 'array', items: { type: 'string' } },
      internet: { type: 'boolean', description: 'false blocks all outbound traffic. Default true.' },
    }, ['name']),
    run: async (api, a) => {
      const template: WireTemplate = {}
      if (str(a.image)) template.image = str(a.image)!
      if (strs(a.packages).length > 0) template.packages = strs(a.packages)
      if (strs(a.setup_commands).length > 0) template.setup_commands = strs(a.setup_commands)
      if (a.internet === false) template.network = false
      return summary(await api.create({ name: str(a.name) ?? 'Sandbox', ...(Object.keys(template).length > 0 ? { template } : {}) }))
    },
  },
  { name: 'sandbox_start', description: 'Start a stopped sandbox. Files and installed software are kept.', inputSchema: schema(ID, ['id']), run: async (api, a) => summary(await api.start(String(a.id))) },
  { name: 'sandbox_stop', description: 'Stop a running sandbox to free resources. Files and installed software are kept.', inputSchema: schema(ID, ['id']), run: async (api, a) => summary(await api.stop(String(a.id))) },
  { name: 'sandbox_delete', description: 'Delete a sandbox and every file in it. This cannot be undone.', inputSchema: schema(ID, ['id']), run: async (api, a) => { await api.remove(String(a.id)); return { id: String(a.id), deleted: true } } },
  {
    name: 'sandbox_exec',
    description: 'Run a shell command in a sandbox as `agent`, starting in its workspace (a stopped sandbox starts first). Returns the exit code and the end of stdout and stderr.',
    inputSchema: schema({ ...ID, command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 120.' } }, ['id', 'command']),
    run: async (api, a) => {
      const s = await api.get(String(a.id))
      const command = str(a.command)
      if (!command) throw new Error('command is empty')
      const seconds = typeof a.timeout_seconds === 'number' ? Math.min(600, Math.max(1, Math.floor(a.timeout_seconds))) : 120
      const r = await runInEnvd(api.envd(s.id), 'agent', command, { cwd: s.workspace_path, timeoutMs: seconds * 1000 })
      return { exit_code: r.code, stdout: tail(r.stdout, OUT_MAX), stderr: tail(r.stderr, 8_000) }
    },
  },
  {
    name: 'sandbox_read_file',
    description: 'Read a text file (up to 256 KB) from a sandbox. A relative path is inside its workspace.',
    inputSchema: schema({ ...ID, path: { type: 'string' } }, ['id', 'path']),
    run: async (api, a) => {
      const s = await api.get(String(a.id))
      const bytes = await api.envd(s.id).readFile(inWorkspace(s, String(a.path)), 'agent')
      if (bytes.byteLength > FILE_MAX) throw new Error(`the file is ${String(bytes.byteLength)} bytes; the limit is ${String(FILE_MAX)}`)
      return { path: inWorkspace(s, String(a.path)), content: new TextDecoder().decode(bytes) }
    },
  },
  {
    name: 'sandbox_write_file',
    description: 'Write a text file (up to 256 KB) into a sandbox. A relative path is inside its workspace.',
    inputSchema: schema({ ...ID, path: { type: 'string' }, content: { type: 'string' } }, ['id', 'path', 'content']),
    run: async (api, a) => {
      const s = await api.get(String(a.id))
      const bytes = new TextEncoder().encode(String(a.content ?? ''))
      if (bytes.byteLength > FILE_MAX) throw new Error(`the content is ${String(bytes.byteLength)} bytes; the limit is ${String(FILE_MAX)}`)
      await api.envd(s.id).writeFile(inWorkspace(s, String(a.path)), bytes, 'agent')
      return { path: inWorkspace(s, String(a.path)), bytes: bytes.byteLength }
    },
  },
]

const reply = (res: http.ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const text = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) })

/** The loopback base URL this request arrived on (never taken from the Host header). */
function selfUrl(req: http.IncomingMessage): string {
  const address = (req.socket.localAddress ?? '127.0.0.1').replace(/^::ffff:/, '')
  return `http://${address.includes(':') ? `[${address}]` : address}:${String(req.socket.localPort ?? 80)}`
}

/** Handles one `/mcp` request; `key` is the caller's owner-bound key (already verified by the caller of this function). */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, key: string, readBody: () => Promise<Record<string, unknown>>): Promise<void> {
  if (req.method !== 'POST') return reply(res, 405, rpcError(null, -32000, 'use POST'))
  const message = (await readBody()) as { jsonrpc?: string; id?: unknown; method?: string; params?: Args }
  const { id, method, params = {} } = message
  if (id === undefined) return reply(res, 202) // a notification (notifications/initialized, ...)
  if (method === 'initialize') {
    return reply(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'agentry-sandbox', version: '1' }, instructions: 'Isolated Linux sandboxes. Create one, run commands in it with sandbox_exec, and delete it when done.' } })
  }
  if (method === 'ping') return reply(res, 200, { jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') return reply(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params.name)
    if (!tool) return reply(res, 200, rpcError(id, -32602, `unknown tool "${String(params.name)}"`))
    const api = createSandboxApi({ url: selfUrl(req), key, owner: 'mcp', timeoutMs: 660_000 })
    try {
      return reply(res, 200, { jsonrpc: '2.0', id, result: text(await tool.run(api, (params.arguments ?? {}) as Args)) })
    } catch (error) {
      const message = error instanceof SandboxApiError || error instanceof Error ? error.message : String(error)
      return reply(res, 200, { jsonrpc: '2.0', id, result: text({ error: message }, true) })
    }
  }
  return reply(res, 200, rpcError(id, -32601, `method not found: ${String(method)}`))
}
