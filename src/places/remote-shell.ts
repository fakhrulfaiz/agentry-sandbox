/**
 * Commands and file uploads over one pinned SSH connection per place,
 * re-made on demand. Key auth only; a connection whose host key is not the
 * pinned one is dropped during the handshake (HostKeyChangedError), before
 * anything is sent. The private key never appears in an error.
 */
import { Client } from 'ssh2'
import { HostKeyChangedError } from './driver.ts'
import { sshConnectOptions, type SshTarget, type VerifierHooks } from './ssh.ts'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface RemoteShell {
  /** Runs `command` through the login shell; resolves with its exit code even when it is not 0. */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>
  /** Writes `data` to `path` over SFTP (mode applied at create, subject to the remote umask). */
  writeFile(path: string, data: Buffer, mode?: number): Promise<void>
  close(): Promise<void>
}

const EXEC_TIMEOUT_MS = 120_000

export function createRemoteShell(opts: { target: SshTarget; privateKey: string; /** Pinned fingerprint; absent only for the admin's connection test. */ hostKey: string | undefined; hooks?: VerifierHooks }): RemoteShell {
  let client: Client | undefined
  let connecting: Promise<Client> | undefined

  function connect(): Promise<Client> {
    if (client) return Promise.resolve(client)
    connecting ??= new Promise<Client>((resolve, reject) => {
      const c = new Client()
      let changed = false
      let settled = false
      c.once('ready', () => {
        c.setNoDelay(true) // many small commands: no waiting on delayed ACKs
        settled = true
        client = c
        resolve(c)
      })
      c.on('error', (e: Error) => {
        if (client === c) client = undefined
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
        ...sshConnectOptions({
          privateKey: opts.privateKey,
          pinned: opts.hostKey,
          hooks: {
            ...opts.hooks,
            mismatch: (fp) => {
              changed = true
              opts.hooks?.mismatch?.(fp)
            },
          },
        }),
      })
    }).finally(() => {
      connecting = undefined
    })
    return connecting
  }

  function execOnce(c: Client, command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          stream.destroy()
          reject(new Error(`the command timed out after ${String(timeoutMs)} ms`))
        }, timeoutMs)
        stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
        stream.on('close', (code: number | null) => {
          clearTimeout(timer)
          resolve({ code: code ?? 255, stdout, stderr })
        })
      })
    })
  }

  /** A stale connection (the machine rebooted, the network dropped) is replaced once. */
  async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await connect()
    try {
      return await fn(c)
    } catch (e) {
      if (client !== c || /not connected|no response from server/iu.test((e as Error).message)) {
        if (client === c) client = undefined
        c.end()
        return fn(await connect())
      }
      throw e
    }
  }

  return {
    exec: (command, o) => withClient((c) => execOnce(c, command, o?.timeoutMs ?? EXEC_TIMEOUT_MS)),
    writeFile: (path, data, mode = 0o644) =>
      withClient(
        (c) =>
          new Promise<void>((resolve, reject) => {
            c.sftp((err, sftp) => {
              if (err) return reject(err)
              const out = sftp.createWriteStream(path, { mode })
              out.on('error', (e: Error) => {
                sftp.end()
                reject(e)
              })
              out.on('close', () => {
                sftp.end()
                resolve()
              })
              out.end(data)
            })
          }),
      ),
    async close() {
      const c = client
      client = undefined
      c?.end()
    },
  }
}
