/**
 * End-to-end smoke test against a running service: create a sandbox from the
 * default image, run a command and use files through the relay, stop and
 * start it, check the file survived, delete it. Exits non-zero on any
 * mismatch. Usage: AGENTRY_SANDBOX_URL=… AGENTRY_SANDBOX_KEY=… tsx scripts/smoke.ts
 */
import { createEnvdClient } from '../src/envd/client.ts'
import { runInEnvd } from '../src/envd/run.ts'

const base = (process.env.AGENTRY_SANDBOX_URL ?? 'http://127.0.0.1:3090').replace(/\/+$/, '')
const key = process.env.AGENTRY_SANDBOX_KEY
if (!key) throw new Error('AGENTRY_SANDBOX_KEY is required')
const auth = { Authorization: `Bearer ${key}`, 'X-Agentry-Owner': 'smoke' }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { ...auth, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!res.ok && res.status !== 204) throw new Error(`${method} ${path} → ${String(res.status)} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

function check(cond: boolean, what: string): void {
  if (!cond) throw new Error(`smoke check failed: ${what}`)
  console.log(`ok  ${what}`)
}

const t0 = Date.now()
const sbx = await api<{ id: string; state: string }>('POST', '/v1/sandboxes', { name: 'smoke' })
console.log(`created ${sbx.id} (${String(Date.now() - t0)} ms)`)
try {
  check(sbx.state === 'running', 'sandbox is running')
  const envd = createEnvdClient({ baseUrl: `${base}/v1/sandboxes/${sbx.id}/envd`, accessToken: '', headers: auth, userVia: 'header' })
  const r = await runInEnvd(envd, 'agent', 'uname -s; whoami; sudo -n true && echo sudo-ok; pwd', { cwd: '/workspace' })
  console.log(r.stdout.trim())
  check(r.stdout.includes('agent') && r.stdout.includes('sudo-ok') && r.stdout.includes('/workspace'), 'runs as agent with sudo in /workspace')
  await envd.writeFile('/workspace/hello.txt', new TextEncoder().encode('hello'), 'agent')
  check(new TextDecoder().decode(await envd.readFile('/workspace/hello.txt', 'agent')) === 'hello', 'writes and reads a file')
  await api('POST', `/v1/sandboxes/${sbx.id}/stop`)
  const started = await api<{ state: string }>('POST', `/v1/sandboxes/${sbx.id}/start`)
  check(started.state === 'running', 'starts again after stop')
  check(new TextDecoder().decode(await envd.readFile('/workspace/hello.txt', 'agent')) === 'hello', 'the file survived stop and start')
} finally {
  await api('DELETE', `/v1/sandboxes/${sbx.id}`)
  console.log(`deleted ${sbx.id}`)
}
console.log('smoke: all checks passed')
