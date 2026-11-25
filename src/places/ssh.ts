/**
 * SSH plumbing for remote places: target parsing, host key pinning, and the
 * tunnels from this service to each sandbox's envd port on the remote host.
 * Key auth only, no agent forwarding; a connection whose host key is not the
 * pinned one is dropped during the handshake, before anything is sent.
 */
import { createHash } from 'node:crypto'
import net from 'node:net'
import { Client } from 'ssh2'
import { HostKeyChangedError } from './driver.ts'

export { HostKeyChangedError }

export interface SshTarget {
  host: string
  port: number
  username: string
}

/** `ssh://user@host[:port]` (port defaults to 22); anything else is rejected. */
export function parseSshTarget(url: string): SshTarget {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('the address must look like ssh://user@host[:port]')
  }
  const port = u.port === '' ? 22 : Number(u.port)
  if (u.protocol !== 'ssh:' || !u.hostname || !u.username || u.password || (u.pathname !== '' && u.pathname !== '/') || u.search || u.hash || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('the address must look like ssh://user@host[:port]')
  }
  return { host: u.hostname.replace(/^\[|\]$/gu, ''), port, username: decodeURIComponent(u.username) }
}

/** OpenSSH's fingerprint of a host key blob: `SHA256:` plus unpadded base64. */
export function fingerprint(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/u, '')}`
}

export interface VerifierHooks {
  /** Called with the fingerprint of every key the server presents. */
  seen?(fp: string): void
  /** Called when a pinned key does not match. */
  mismatch?(fp: string): void
}

/**
 * ssh2 `hostVerifier`: accepts only the pinned key. With no pinned key it
 * accepts (so a connection can be tested) and reports what it saw; callers
 * must not use such a connection for real work.
 */
export function hostVerifier(pinned: string | undefined, hooks: VerifierHooks = {}): (key: Buffer) => boolean {
  return (key) => {
    const fp = fingerprint(key)
    hooks.seen?.(fp)
    if (pinned === undefined) return true
    if (fp === pinned) return true
    hooks.mismatch?.(fp)
    return false
  }
}

const READY_TIMEOUT_MS = 15_000
const KEEPALIVE_MS = 15_000

/** Options for ssh2 (and docker-modem's `sshOptions`): key auth, no agent, pinned host key. */
export function sshConnectOptions(opts: { privateKey: string; pinned: string | undefined; hooks?: VerifierHooks }) {
  return {
    privateKey: opts.privateKey,
    agentForward: false,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_MS,
    hostVerifier: hostVerifier(opts.pinned, opts.hooks),
  }
}

export interface Tunnel {
  localPort: number
  close(): void
}

export interface Tunnels {
  open(remotePort: number): Promise<Tunnel>
  closeAll(): Promise<void>
}

/** One SSH connection per place, re-made on demand; each tunnel is a loopback listener forwarded to `127.0.0.1:<remotePort>` on the host. */
export function createTunnels(opts: { target: SshTarget; privateKey: string; hostKey: string }): Tunnels {
  let client: Client | undefined
  let connecting: Promise<Client> | undefined
  const servers = new Set<net.Server>()

  function connect(): Promise<Client> {
    if (client) return Promise.resolve(client)
    connecting ??= new Promise<Client>((resolve, reject) => {
      const c = new Client()
      let changed = false
      let settled = false
      c.once('ready', () => {
        settled = true
        client = c
        resolve(c)
      })
      c.on('error', (e: Error) => {
        if (!settled) {
          settled = true
          reject(changed ? new HostKeyChangedError() : e)
        }
      })
      c.on('close', () => {
        if (client === c) client = undefined
        if (!settled) {
          settled = true
          reject(changed ? new HostKeyChangedError() : new Error('the SSH connection closed before it was ready'))
        }
      })
      c.connect({
        host: opts.target.host,
        port: opts.target.port,
        username: opts.target.username,
        ...sshConnectOptions({ privateKey: opts.privateKey, pinned: opts.hostKey, hooks: { mismatch: () => { changed = true } } }),
      })
    }).finally(() => {
      connecting = undefined
    })
    return connecting
  }

  return {
    async open(remotePort) {
      await connect() // fail early (host key, auth, network) rather than on the first request
      const server = net.createServer((socket) => {
        socket.on('error', () => socket.destroy())
        connect().then(
          (c) => {
            c.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, channel) => {
              if (err) return void socket.destroy()
              socket.on('close', () => channel.destroy())
              channel.on('error', () => socket.destroy())
              channel.on('close', () => socket.destroy())
              socket.pipe(channel).pipe(socket)
            })
          },
          () => socket.destroy(),
        )
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      servers.add(server)
      const localPort = (server.address() as net.AddressInfo).port
      return {
        localPort,
        close() {
          servers.delete(server)
          server.close()
        },
      }
    },
    async closeAll() {
      for (const s of servers) s.close()
      servers.clear()
      const c = client
      client = undefined
      c?.end()
    },
  }
}
