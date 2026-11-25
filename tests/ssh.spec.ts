import { createHash } from 'node:crypto'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ssh2, { type Connection } from 'ssh2'
import { createDockerSshDriver } from '../src/places/drivers/docker-ssh.ts'
import { loadConfig } from '../src/config.ts'
import { HostKeyChangedError, createTunnels, fingerprint, parseSshTarget } from '../src/places/ssh.ts'

const { Server, utils } = ssh2

const hostKeyA = utils.generateKeyPairSync('ed25519')
const hostKeyB = utils.generateKeyPairSync('ed25519')
const user = utils.generateKeyPairSync('ed25519')
const blobOf = (publicKey: string) => Buffer.from(publicKey.split(/\s+/u)[1]!, 'base64')

interface TestServer {
  port: number
  channels: number
  connections: Connection[]
  close(): Promise<void>
}

/** An SSH server on a random port that forwards direct-tcpip requests for real. */
async function startServer(hostKey: string): Promise<TestServer> {
  const state: TestServer = { port: 0, channels: 0, connections: [], close: async () => {} }
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    state.connections.push(client)
    client.on('error', () => {})
    // Any public key is accepted: these tests are about the host key, not user auth.
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])))
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        state.channels++
        const upstream = net.connect(info.destPort, info.destIP, () => {
          const ch = accept()
          ch.pipe(upstream).pipe(ch)
          ch.on('close', () => upstream.destroy())
        })
        upstream.on('error', () => reject())
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  state.port = (server.address() as net.AddressInfo).port
  state.close = () => new Promise((r) => { for (const c of state.connections) c.end(); server.close(() => r()) })
  return state
}

async function startEcho(): Promise<{ port: number; close(): void }> {
  const s = net.createServer((c) => c.pipe(c))
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { port: (s.address() as net.AddressInfo).port, close: () => s.close() }
}

async function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text))
    s.once('data', (d) => { s.destroy(); resolve(d.toString()) })
    s.once('error', reject)
    s.once('close', () => reject(new Error('closed')))
  })
}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe('ssh', () => {
  it('parseSshTarget accepts ssh://u@h and ssh://u@h:2222, rejects http://', () => {
    expect(parseSshTarget('ssh://u@h')).toEqual({ host: 'h', port: 22, username: 'u' })
    expect(parseSshTarget('ssh://u@h:2222')).toEqual({ host: 'h', port: 2222, username: 'u' })
    expect(() => parseSshTarget('http://u@h')).toThrow()
    expect(() => parseSshTarget('ssh://h')).toThrow()
    expect(() => parseSshTarget('ssh://u@h/path')).toThrow()
  })

  it('fingerprint matches ssh-keygen format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'))
    try {
      const file = join(dir, 'key.pub')
      writeFileSync(file, hostKeyA.public)
      let expected: string
      try {
        expected = /(SHA256:\S+)/u.exec(execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' }))![1]!
      } catch {
        expected = `SHA256:${createHash('sha256').update(blobOf(hostKeyA.public)).digest('base64').replace(/=+$/u, '')}`
      }
      const fp = fingerprint(blobOf(hostKeyA.public))
      expect(fp).toBe(expected)
      expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a changed host key', async () => {
    const server = await startServer(hostKeyA.private)
    cleanups.push(() => server.close())
    const tunnels = createTunnels({ target: { host: '127.0.0.1', port: server.port, username: 'u' }, privateKey: user.private, hostKey: fingerprint(blobOf(hostKeyB.public)) })
    cleanups.push(() => tunnels.closeAll())
    await expect(tunnels.open(1)).rejects.toBeInstanceOf(HostKeyChangedError)
    expect(server.channels).toBe(0)
  })

  it('forwards a local port to the remote port', async () => {
    const echo = await startEcho()
    const server = await startServer(hostKeyA.private)
    cleanups.push(() => server.close(), () => echo.close())
    const tunnels = createTunnels({ target: { host: '127.0.0.1', port: server.port, username: 'u' }, privateKey: user.private, hostKey: fingerprint(blobOf(hostKeyA.public)) })
    cleanups.push(() => tunnels.closeAll())
    const t = await tunnels.open(echo.port)
    expect(await roundTrip(t.localPort, 'hello')).toBe('hello')
    expect(server.channels).toBe(1)
    t.close()
  })

  it('a dropped tunnel is reopened', async () => {
    const echo = await startEcho()
    const server = await startServer(hostKeyA.private)
    cleanups.push(() => server.close(), () => echo.close())
    const tunnels = createTunnels({ target: { host: '127.0.0.1', port: server.port, username: 'u' }, privateKey: user.private, hostKey: fingerprint(blobOf(hostKeyA.public)) })
    cleanups.push(() => tunnels.closeAll())
    const first = await tunnels.open(echo.port)
    expect(await roundTrip(first.localPort, 'one')).toBe('one')
    for (const c of server.connections) c.end()
    await new Promise((r) => setTimeout(r, 200))
    const second = await tunnels.open(echo.port)
    expect(await roundTrip(second.localPort, 'two')).toBe('two')
    // The first tunnel's listener also reconnects on demand.
    expect(await roundTrip(first.localPort, 'three')).toBe('three')
    expect(server.connections.length).toBe(2)
  })

  it('the docker-ssh driver reports a changed key and never trusts an unpinned one', async () => {
    const server = await startServer(hostKeyA.private)
    cleanups.push(() => server.close())
    const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
    const target = `ssh://u@127.0.0.1:${String(server.port)}`
    const pinnedWrong = createDockerSshDriver(config, { target, privateKey: user.private, hostKey: fingerprint(blobOf(hostKeyB.public)) })
    cleanups.push(() => pinnedWrong.close?.())
    expect(await pinnedWrong.probe()).toEqual({ ok: false, reason: 'host key changed' })
    await expect(pinnedWrong.status({ containerId: 'c' })).rejects.toBeInstanceOf(HostKeyChangedError)
    expect(server.channels).toBe(0)

    const unpinned = createDockerSshDriver(config, { target, privateKey: user.private })
    cleanups.push(() => unpinned.close?.())
    await unpinned.probe() // the server cannot run docker; only the key it presented matters
    expect(unpinned.observedHostKey?.()).toBe(fingerprint(blobOf(hostKeyA.public)))
    await expect(unpinned.create('i', 'o', {}, { gpuIds: [] })).rejects.toThrow(/not pinned/u)
  })
})
