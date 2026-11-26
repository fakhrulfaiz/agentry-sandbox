/**
 * An in-process SSH server standing in for a Linux machine, for the
 * ssh-machine driver: its `exec` handler understands only the few commands
 * the driver sends (no general shell), files live in a temp directory (the
 * fake home), SFTP writes land there, and "envd" is a tiny HTTP server on the
 * port the driver asked for, listed in a fake process table.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { fingerprint } from '../../src/places/ssh.ts'

const { Server, utils } = ssh2
const STATUS = utils.sftp.STATUS_CODE

export const hostKey = utils.generateKeyPairSync('ed25519')
export const otherHostKey = utils.generateKeyPairSync('ed25519')
export const userKey = utils.generateKeyPairSync('ed25519')
export const fpOf = (publicKey: string) => fingerprint(Buffer.from(publicKey.split(/\s+/u)[1]!, 'base64'))

interface Proc {
  cmdline: string[]
  port: number
  /** The session id: the pid of the session leader (envd). */
  sid: number
  server?: http.Server
}

export interface Machine {
  port: number
  home: string
  /** Knobs. */
  sudo: boolean
  iptables: boolean
  ip6tables: boolean
  ipv6: boolean
  uname: string
  gpus: string
  /** Every exec command received, in order. */
  log: string[]
  /** Paths written over SFTP. */
  uploads: string[]
  /** rm targets refused because they were outside the fake home. */
  rmOutside: string[]
  /** The rm targets executed. */
  removed: string[]
  procs: Map<number, Proc>
  /** Starts a process in an existing session, like something an agent launched under envd; returns its pid. */
  spawnChild(sid: number, name?: string): number
  /** pkill leaves processes alive (a process that cannot be killed). */
  unkillable: boolean
  /** What sudo says on stderr when `sudo` is false. */
  sudoErr: string
  rules: Set<string>
  /** Ports something else listens on. */
  busy: Set<number>
  /** Power cycle: processes and firewall rules are gone, files stay. */
  reboot(): Promise<void>
  close(): Promise<void>
}

/** Splits a command like a POSIX shell would for the quoting `sq` produces; `$HOME` expands inside double quotes. */
function words(cmd: string, home: string): string[] {
  const out: string[] = []
  let cur: string | undefined
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]!
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      cur = (cur ?? '') + cmd.slice(i + 1, j)
      i = j + 1
    } else if (c === '"') {
      const j = cmd.indexOf('"', i + 1)
      cur = (cur ?? '') + cmd.slice(i + 1, j).replaceAll('$HOME', home)
      i = j + 1
    } else if (c === '\\') {
      cur = (cur ?? '') + cmd[i + 1]
      i += 2
    } else if (/\s/u.test(c)) {
      if (cur !== undefined) out.push(cur)
      cur = undefined
      i++
    } else {
      cur = (cur ?? '') + c
      i++
    }
  }
  if (cur !== undefined) out.push(cur)
  return out
}

export async function startMachine(opts: { host?: string } = {}): Promise<Machine> {
  const home = fs.mkdtempSync(join(tmpdir(), 'fake-machine-'))
  const m: Machine = {
    port: 0,
    home,
    sudo: true,
    iptables: true,
    ip6tables: true,
    ipv6: true,
    uname: 'x86_64',
    gpus: '',
    log: [],
    uploads: [],
    rmOutside: [],
    removed: [],
    procs: new Map(),
    spawnChild(sid, name = 'train.py') {
      const pid = nextPid++
      m.procs.set(pid, { cmdline: [name], port: 0, sid })
      return pid
    },
    unkillable: false,
    sudoErr: 'sudo: a password is required',
    rules: new Set(),
    busy: new Set(),
    async reboot() {
      for (const p of m.procs.values()) if (p.server) await new Promise<void>((r) => { p.server!.closeAllConnections(); p.server!.close(() => r()) })
      m.procs.clear()
      m.rules.clear()
    },
    close: async () => {},
  }
  let nextPid = 1000
  const inHome = (p: string) => p === home || p.startsWith(`${home}/`)

  type R = { code: number; out?: string; err?: string }
  const ok = (out = ''): R => ({ code: 0, out })
  const fail = (err = '', code = 1): R => ({ code, err })

  async function startEnvd(argv: string[], logFile: string, pidFile: string): Promise<R> {
    const port = Number(argv[argv.indexOf('--port') + 1])
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 204 : 404).end()
    })
    const pid = nextPid++
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
    } catch (e) {
      fs.writeFileSync(logFile, `listen failed: ${(e as Error).message}\n`)
      fs.writeFileSync(pidFile, `${String(pid)}\n`)
      return ok()
    }
    m.procs.set(pid, { cmdline: argv, port, sid: pid, server })
    fs.writeFileSync(logFile, '')
    fs.writeFileSync(pidFile, `${String(pid)}\n`)
    return ok()
  }

  async function run(cmd: string): Promise<R> {
    const w = words(cmd, home)
    if (w[0] === 'sh' && w[1] === '-c') return runScript(w[2]!)
    return simple(w, false)
  }

  async function runScript(script: string): Promise<R> {
    const w = words(script, home)
    if (w[0] === 'nohup') {
      // nohup sudo -n setsid sh -c '<echo $$ > PID && exec ENVD args>' > LOG 2>&1 < /dev/null &
      const gt = w.indexOf('>')
      if (!m.sudo) return fail(m.sudoErr)
      const inner = words(w[w.indexOf('-c') + 1]!, home)
      const pidFile = inner[inner.indexOf('>') + 1]!
      const argv = inner.slice(inner.indexOf('exec') + 1)
      return startEnvd(argv, w[gt + 1]!, pidFile).then((r) => (w.at(-1) === '&' ? r : fail('not backgrounded')))
    }
    return fail(`fake: unsupported script ${script}`, 127)
  }

  async function simple(w: string[], sudo: boolean): Promise<R> {
    const [cmd, ...a] = w
    switch (cmd) {
      case 'sudo': {
        if (!m.sudo) return fail(m.sudoErr)
        if (a[0] !== '-n') return fail('fake: sudo without -n', 127)
        if (a[1] === 'true') return ok()
        return simple(a.slice(1), true)
      }
      case 'uname':
        return ok(a[0] === '-m' ? `${m.uname}\n` : 'Linux 6.8.0\n')
      case 'nvidia-smi':
        return m.gpus ? ok(m.gpus) : fail('nvidia-smi: command not found', 127)
      case 'printf':
        return ok(`${home}\n`)
      case 'id':
        return ok('1000\n')
      case 'rmdir': {
        const t = a[a.indexOf('--') + 1]!
        try {
          fs.rmdirSync(t)
          return ok()
        } catch {
          return fail('rmdir: failed to remove: Directory not empty')
        }
      }
      case 'pgrep': {
        const sid = Number(a[a.indexOf('-s') + 1])
        return [...m.procs.values()].some((p) => p.sid === sid) ? ok() : fail()
      }
      case 'pkill': {
        const sid = Number(a[a.indexOf('-s') + 1])
        if (m.unkillable) return ok()
        for (const [pid, p] of m.procs) {
          if (p.sid !== sid) continue
          m.procs.delete(pid)
          p.server?.closeAllConnections()
          p.server?.close()
        }
        return ok()
      }
      case 'sha256sum': {
        const f = a[1]!
        return fs.existsSync(f) ? ok(`${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${f}\n`) : fail(`sha256sum: ${f}: No such file or directory`)
      }
      case 'mkdir':
        for (const d of a.slice(a.indexOf('--') + 1)) fs.mkdirSync(d, { recursive: true })
        return ok()
      case 'chmod':
        return ok()
      case 'chown':
        return ok()
      case 'mv':
        fs.renameSync(a[2]!, a[3]!)
        return ok()
      case 'rm': {
        const targets = a.slice(a.indexOf('--') + 1)
        for (const t of targets) {
          if (!inHome(t) || t === home) {
            m.rmOutside.push(t)
            return fail(`fake: refusing rm ${t}`)
          }
          if (a.includes('-rf')) m.removed.push(t)
          fs.rmSync(t, { recursive: true, force: true })
        }
        return ok()
      }
      case 'ls': {
        try {
          return ok(fs.readdirSync(a[a.indexOf('--') + 1]!).join('\n') + '\n')
        } catch {
          return fail('ls: cannot access: No such file or directory')
        }
      }
      case 'cat': {
        const files = a.slice(a.indexOf('--') + 1)
        let out = ''
        let code = 0
        for (const f of files) {
          const proc = /^\/proc\/(\d+)\/cmdline$/u.exec(f)
          if (proc) {
            const p = m.procs.get(Number(proc[1]))
            if (p) out += `${p.cmdline.join('\0')}\0`
            else code = 1
          } else if (f === '/proc/net/if_inet6') {
            if (m.ipv6) out += '00000000000000000000000000000001 01 80 10 80       lo\n'
          } else if (fs.existsSync(f)) out += fs.readFileSync(f, 'utf8')
          else code = 1
        }
        return { code, out }
      }
      case 'test':
        if (a[0] === '-L') return fs.lstatSync(a[1]!, { throwIfNoEntry: false })?.isSymbolicLink() ? ok() : fail()
        return (a[0] === '-d' ? fs.existsSync(a[1]!) && fs.statSync(a[1]!).isDirectory() : fs.existsSync(a[1]!)) ? ok() : fail()
      case 'tail':
        return fs.existsSync(a[a.length - 1]!) ? ok(fs.readFileSync(a[a.length - 1]!, 'utf8')) : fail()
      case 'ss': {
        const ports = new Set([...m.busy, ...[...m.procs.values()].filter((p) => p.port).map((p) => p.port)])
        return ok(`State Recv-Q Send-Q Local Address:Port Peer Address:Port\n${[...ports].map((p) => `LISTEN 0 128 0.0.0.0:${String(p)} 0.0.0.0:*`).join('\n')}\n`)
      }
      case 'kill': {
        const pid = Number(a[a.length - 1])
        const p = m.procs.get(pid)
        if (!p) return fail('kill: no such process')
        m.procs.delete(pid)
        p.server?.closeAllConnections()
        p.server?.close()
        return ok()
      }
      case 'iptables':
      case 'ip6tables': {
        if (!(cmd === 'iptables' ? m.iptables : m.ip6tables)) return fail(sudo ? `sudo: ${cmd}: command not found` : `${cmd}: command not found`, 127)
        const key = `${cmd} ${a.slice(1).join(' ')}`
        if (a[0] === '-C') return m.rules.has(key) ? ok() : fail('iptables: Bad rule (does a matching rule exist in that chain?).')
        if (a[0] === '-I') {
          m.rules.add(key)
          return ok()
        }
        if (a[0] === '-D') return m.rules.delete(key) ? ok() : fail('iptables: Bad rule')
        return fail('fake: iptables', 2)
      }
      default:
        return fail(`fake: unsupported command ${cmd ?? ''}`, 127)
    }
  }

  const clients = new Set<ssh2.Connection>()
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])))
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const upstream = net.connect(info.destPort, info.destIP, () => {
          const ch = accept()
          ch.pipe(upstream).pipe(ch)
          ch.on('close', () => upstream.destroy())
        })
        upstream.on('error', () => reject())
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _rej, info) => {
          const stream = acceptExec()
          m.log.push(info.command)
          void run(info.command).then(
            (r) => {
              if (r.out) stream.write(r.out)
              if (r.err) stream.stderr.write(r.err)
              stream.exit(r.code)
              stream.end()
            },
            (e: unknown) => {
              stream.stderr.write(String(e))
              stream.exit(1)
              stream.end()
            },
          )
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const fds = new Map<number, number>()
          let n = 0
          sftp.on('OPEN', (id, filename, flags, attrs) => {
            fs.open(filename, utils.sftp.flagsToString(flags) ?? 'w', attrs.mode ?? 0o644, (err, fd) => {
              if (err) return sftp.status(id, STATUS.FAILURE)
              m.uploads.push(filename)
              const h = Buffer.alloc(4)
              h.writeUInt32BE(n, 0)
              fds.set(n++, fd)
              sftp.handle(id, h)
            })
          })
          sftp.on('WRITE', (id, handle, offset, data) => {
            const fd = fds.get(handle.readUInt32BE(0))
            if (fd === undefined) return sftp.status(id, STATUS.FAILURE)
            fs.write(fd, data, 0, data.length, offset, (err) => sftp.status(id, err ? STATUS.FAILURE : STATUS.OK))
          })
          sftp.on('CLOSE', (id, handle) => {
            const fd = fds.get(handle.readUInt32BE(0))
            if (fd !== undefined) fs.close(fd, () => sftp.status(id, STATUS.OK))
            else sftp.status(id, STATUS.FAILURE)
            fds.delete(handle.readUInt32BE(0))
          })
        })
      })
    })
  })
  // Without this, delayed ACKs add ~170 ms to every round trip.
  ;(server as unknown as net.Server).on('connection', (sock: net.Socket) => sock.setNoDelay(true))
  await new Promise<void>((r) => server.listen(0, opts.host ?? '127.0.0.1', r))
  m.port = (server.address() as net.AddressInfo).port
  m.close = async () => {
    await m.reboot()
    for (const c of clients) c.end()
    await new Promise<void>((r) => server.close(() => r()))
    fs.rmSync(home, { recursive: true, force: true })
  }
  return m
}
