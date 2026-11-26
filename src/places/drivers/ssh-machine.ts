/**
 * An existing Linux machine over SSH: Agentry works on it directly, as the
 * login user, with no isolation. envd is uploaded once per architecture to
 * `~/.agentry/bin` and started (one per sandbox) with passwordless sudo on a
 * free port, reached through an SSH tunnel. envd has no listen-address flag,
 * so before it starts the driver adds iptables/ip6tables rules dropping that
 * port on every interface but loopback and rejecting loopback connections
 * from any user but the login user; no rules, no envd (fail closed). envd runs
 * in its own session (setsid) whose id is its pid, so stop ends the whole
 * session, agent processes included.
 *
 * Config `{ url: 'ssh://user@host[:port]', host_key }`, secrets
 * `{ private_key }`, like `docker-ssh`. Without `host_key` the driver answers
 * `probe` only when built for a connection test; nothing else runs over an
 * unpinned connection.
 *
 * Remote layout: `~/.agentry/bin/envd-<version>-<arch>`, and per sandbox
 * `~/.agentry/sandboxes/<id>/{meta.json,envd.pid,envd.log}`. Destroy removes
 * the recorded workspace (only one this driver created: it carries a marker
 * holding the sandbox id, and is named `sandbox-...`) and that directory,
 * nothing else.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import Docker from 'dockerode'
import type { SandboxConfig } from '../../config.ts'
import { loadEnvdBinary, treeArchive } from '../../backends/envd-binary.ts'
import { createEnvdClient } from '../../envd/client.ts'
import { sq } from '../../envd/run.ts'
import type { GpuInfo } from '../../store/types.ts'
import { HostKeyChangedError, type Driver, type Handle } from '../driver.ts'
import { parseNvidiaSmi } from '../gpus.ts'
import { createEnsureImage, type Platform } from '../images.ts'
import type { DriverFactory } from '../registry.ts'
import { createRemoteShell, type RemoteShell } from '../remote-shell.ts'
import { createTunnels, parseSshTarget } from '../ssh.ts'
import { dockerClient } from './docker.ts'

type Arch = 'amd64' | 'arm64'

const ID = /^[A-Za-z0-9_-]{1,64}$/u
const PORT_FROM = 49_300
const PORT_SPAN = 600
const DEFAULT_WORKSPACE = '/workspace'
/** The file in a workspace this driver created; it holds the sandbox id. */
const MARKER = '.agentry-sandbox'
const OWNED_NAME = /^sandbox-[A-Za-z0-9_-]+$/u
/** System directories that are never a workspace to delete. */
const PROTECTED = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The first port tried for a sandbox: 49300 + hash(id) % 600. */
export function portBase(id: string): number {
  return PORT_FROM + (createHash('sha256').update(id).digest().readUInt32BE(0) % PORT_SPAN)
}

/** The workspace path, normalised; throws when it is empty, relative, `/`, the home directory or a system directory. */
export function safeWorkspace(path: unknown, home?: string): string {
  if (typeof path !== 'string' || path === '' || !path.startsWith('/') || /[\0\n\r]/u.test(path) || path.split('/').includes('..')) throw new Error(`refusing to use the workspace path ${JSON.stringify(path)}: it must be an absolute path`)
  const norm = posix.normalize(path).replace(/\/+$/u, '') || '/'
  if (PROTECTED.has(norm) || (home !== undefined && norm === posix.normalize(home).replace(/\/+$/u, ''))) throw new Error(`refusing to use ${norm} as a workspace`)
  return norm
}

interface Meta {
  id: string
  owner: string
  workspace: string
  port: number
}

interface Dirs {
  uid: number
  home: string
  bin: string
  sandboxes: string
}

export interface SshMachineDeps {
  /** Docker on the service host, where envd and DSH's runtime are read from (default: the configured daemon). */
  local?: Docker
  /** Test hook: the envd binary for a platform. */
  envdBinary?: (platform: Platform) => Promise<Buffer>
}

export function createSshMachineDriver(
  config: SandboxConfig,
  place: { target: string; hostKey?: string; privateKey: string; /** Connect without a pinned key to learn it (the admin's connection test). */ allowUnpinnedProbe?: boolean },
  deps: SshMachineDeps = {},
): Driver {
  const target = parseSshTarget(place.target)
  const login = target.username
  const pinned = place.hostKey
  let changed = false
  let observed: string | undefined
  const shell: RemoteShell = createRemoteShell({
    target,
    privateKey: place.privateKey,
    hostKey: pinned,
    hooks: {
      seen: (fp) => {
        observed = fp
        if (fp === pinned) changed = false
      },
      mismatch: () => {
        changed = true
      },
    },
  })
  const tunnels = pinned ? createTunnels({ target, privateKey: place.privateKey, hostKey: pinned }) : undefined
  let localDocker = deps.local
  const local = () => (localDocker ??= dockerClient(config))
  let ensureLocal: ReturnType<typeof createEnsureImage> | undefined
  const ensure = (image: string, platform?: Platform) => (ensureLocal ??= createEnsureImage(local()))(image, platform)
  const envdVersion = (() => {
    const tag = config.envdImage.slice(config.envdImage.lastIndexOf('/') + 1).split(':')[1]
    return tag && /^[\w.-]+$/u.test(tag) ? tag : 'envd-v0.6.13'
  })()
  const loadEnvd = deps.envdBinary ?? ((platform: Platform) => loadEnvdBinary(local(), config.envdImage, ensure, platform))

  let homeCache: Dirs | undefined
  let archCache: Arch | undefined
  let discovered: GpuInfo[] = []

  const keyError = (e: unknown): unknown => (changed || e instanceof HostKeyChangedError ? new HostKeyChangedError('the host key changed') : e)
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (!pinned) throw new Error('the host key is not pinned')
    try {
      return await fn()
    } catch (e) {
      throw keyError(e)
    }
  }

  const first = (s: string) => s.trim().split('\n')[0]?.trim() ?? ''
  const why = (r: { code: number; stderr: string; stdout: string }) => first(r.stderr) || first(r.stdout) || `exit ${String(r.code)}`
  /** Runs a command that must succeed. */
  async function must(command: string, what: string): Promise<string> {
    const r = await shell.exec(command)
    if (r.code !== 0) throw new Error(`${what} failed on ${target.host}: ${why(r)}`)
    return r.stdout
  }

  /** Why `sudo -n` does not work for the login user, or undefined when it does. */
  async function sudoProblem(): Promise<string | undefined> {
    const r = await shell.exec('sudo -n true')
    if (r.code === 0) return undefined
    if (/\btty\b|requiretty/iu.test(r.stderr)) return `sudo needs a terminal for ${login} (turn off requiretty for this user in sudoers)`
    return `passwordless sudo is required for ${login}`
  }

  async function dirs(): Promise<Dirs> {
    if (homeCache) return homeCache
    const home = (await must(`printf '%s\\n' "$HOME"`, 'reading the home directory')).trim()
    if (!home.startsWith('/') || home === '/') throw new Error(`the home directory of ${login} on ${target.host} is not usable`)
    const uid = Number((await must('id -u', 'reading the user id')).trim())
    if (!Number.isInteger(uid) || uid < 0) throw new Error(`the user id of ${login} on ${target.host} is not usable`)
    return (homeCache = { uid, home, bin: `${home}/.agentry/bin`, sandboxes: `${home}/.agentry/sandboxes` })
  }

  async function arch(): Promise<Arch> {
    if (archCache) return archCache
    const m = (await must('uname -m', 'reading the architecture')).trim()
    if (m === 'x86_64') return (archCache = 'amd64')
    if (m === 'aarch64' || m === 'arm64') return (archCache = 'arm64')
    throw new Error(`unsupported architecture ${m}`)
  }

  const sbDir = (d: Dirs, id: string) => {
    if (!ID.test(id)) throw new Error('invalid sandbox id')
    return `${d.sandboxes}/${id}`
  }
  const binPath = (d: Dirs, a: Arch) => `${d.bin}/envd-${envdVersion}-${a}`

  /** Uploads envd for `a` when the machine's copy is missing or differs (checked by sha256). */
  async function ensureEnvd(d: Dirs, a: Arch, opts: { onlyIfMissing?: boolean } = {}): Promise<string> {
    const bin = binPath(d, a)
    if (opts.onlyIfMissing && (await shell.exec(`test -x ${sq(bin)}`)).code === 0) return bin
    const data = await loadEnvd(`linux/${a}`)
    const sha = createHash('sha256').update(data).digest('hex')
    const have = await shell.exec(`sha256sum -- ${sq(bin)}`)
    if (have.code === 0 && have.stdout.trim().startsWith(sha)) return bin
    await must(`mkdir -p -- ${sq(d.bin)}`, 'creating ~/.agentry/bin')
    const tmp = `${bin}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}.tmp`
    await shell.writeFile(tmp, data, 0o755)
    await must(`chmod 0755 -- ${sq(tmp)}`, 'making envd executable')
    await must(`mv -f -- ${sq(tmp)} ${sq(bin)}`, 'installing envd')
    return bin
  }

  async function readMetas(d: Dirs): Promise<Meta[]> {
    const ls = await shell.exec(`ls -1 -- ${sq(d.sandboxes)}`)
    const ids = ls.code === 0 ? ls.stdout.split('\n').map((s) => s.trim()).filter((s) => ID.test(s)) : []
    if (ids.length === 0) return []
    const cat = await shell.exec(`cat -- ${ids.map((i) => sq(`${d.sandboxes}/${i}/meta.json`)).join(' ')}`)
    const metas: Meta[] = []
    for (const line of cat.stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line) as Partial<Meta>
        if (typeof m.id === 'string' && ID.test(m.id) && typeof m.owner === 'string' && typeof m.workspace === 'string' && Number.isInteger(m.port)) metas.push({ id: m.id, owner: m.owner, workspace: m.workspace, port: m.port! })
      } catch {
        // an unreadable meta.json is not ours to interpret
      }
    }
    return metas
  }

  const writeMeta = (d: Dirs, m: Meta) => shell.writeFile(`${sbDir(d, m.id)}/meta.json`, Buffer.from(`${JSON.stringify({ id: m.id, owner: m.owner, workspace: m.workspace, port: m.port })}\n`))

  async function listening(): Promise<Set<number>> {
    let r = await shell.exec('ss -ltn')
    if (r.code !== 0) r = await shell.exec('netstat -ltn')
    const ports = new Set<number>()
    for (const line of r.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/u)
      if (cols[0] !== 'LISTEN' && cols[0] !== 'tcp' && cols[0] !== 'tcp6') continue
      const m = /:(\d+)$/u.exec(cols[3] ?? '')
      if (m) ports.add(Number(m[1]))
    }
    return ports
  }

  /** Serialises choosing a port and recording it, so two sandboxes never pick the same one. */
  let portChain: Promise<unknown> = Promise.resolve()
  const portLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = portChain.then(fn, fn)
    portChain = run.catch(() => {})
    return run
  }

  async function freePort(d: Dirs, id: string, prefer?: number): Promise<number> {
    const taken = new Set([...(await listening()), ...(await readMetas(d)).filter((m) => m.id !== id).map((m) => m.port)])
    if (prefer !== undefined && !taken.has(prefer)) return prefer
    for (let p = portBase(id); p <= 65_535; p++) if (!taken.has(p)) return p
    throw new Error(`no free port for envd on ${target.host}`)
  }

  // ---- firewall: envd answers on loopback, to the login user only ----
  const rules = (d: Dirs, id: string, port: number) => {
    const tag = `-m comment --comment ${sq(`agentry-${id}`)}`
    return [
      `INPUT -p tcp --dport ${String(port)} ${sq('!')} -i lo ${tag} -j DROP`,
      `OUTPUT -o lo -p tcp --dport ${String(port)} -m owner ${sq('!')} --uid-owner ${String(d.uid)} ${tag} -j REJECT`,
    ]
  }
  async function noIpv6(): Promise<boolean> {
    const r = await shell.exec('cat /proc/net/if_inet6')
    return r.code !== 0 || r.stdout.trim() === ''
  }
  async function ensureRules(d: Dirs, id: string, port: number): Promise<void> {
    for (const tool of ['iptables', 'ip6tables'] as const) {
      for (const rule of rules(d, id, port)) {
        if ((await shell.exec(`sudo -n ${tool} -C ${rule}`)).code === 0) continue
        const ins = await shell.exec(`sudo -n ${tool} -I ${rule}`)
        if (ins.code === 0) continue
        if (tool === 'ip6tables' && (await noIpv6())) continue
        throw new Error(`cannot restrict envd to loopback on ${target.host}: ${why(ins)}`)
      }
    }
  }
  async function removeRules(d: Dirs, id: string, port: number): Promise<void> {
    for (const tool of ['iptables', 'ip6tables'] as const) {
      for (const rule of rules(d, id, port)) {
        for (let i = 0; i < 5; i++) if ((await shell.exec(`sudo -n ${tool} -D ${rule}`)).code !== 0) break
      }
    }
  }

  // ---- the envd process ----
  async function pidOf(d: Dirs, id: string): Promise<number | undefined> {
    const r = await shell.exec(`cat -- ${sq(`${sbDir(d, id)}/envd.pid`)}`)
    const pid = Number(r.stdout.trim())
    return r.code === 0 && Number.isInteger(pid) && pid > 1 ? pid : undefined
  }
  /**
   * envd is alive when the recorded pid (envd's own, it is the session leader) still runs an envd binary of ours:
   * any version, so an upgrade does not hide a running envd; a reused pid after a reboot does not match.
   */
  async function alive(d: Dirs, id: string): Promise<number | undefined> {
    const pid = await pidOf(d, id)
    if (pid === undefined) return undefined
    const r = await shell.exec(`cat -- /proc/${String(pid)}/cmdline`)
    return r.code === 0 && r.stdout.includes(`${d.bin}/envd-`) ? pid : undefined
  }
  /** Stops envd and everything in its session (agent processes included); throws when something survives SIGKILL. */
  async function killEnvd(d: Dirs, id: string): Promise<void> {
    const pid = await pidOf(d, id)
    if (pid !== undefined) {
      const members = async () => (await shell.exec(`pgrep -s ${String(pid)}`)).code === 0
      const running = async () => (await alive(d, id)) !== undefined || (await members())
      // A pid that runs something else was reused after a reboot: not ours. A session whose leader is gone is still ours.
      const leaderGone = (await shell.exec(`cat -- /proc/${String(pid)}/cmdline`)).code !== 0
      if ((await alive(d, id)) !== undefined || (leaderGone && (await members()))) {
        for (const [signal, tries] of [['TERM', 20], ['KILL', 12]] as const) {
          await shell.exec(`sudo -n pkill -${signal} -s ${String(pid)}`)
          for (let i = 0; i < tries && (await running()); i++) await sleep(250)
          if (!(await running())) break
        }
        if (await running()) throw new Error(`envd (pid ${String(pid)}) did not stop on ${target.host}; its firewall rules are kept`)
      }
    }
    await shell.exec(`rm -f -- ${sq(`${sbDir(d, id)}/envd.pid`)}`)
  }

  async function healthy(port: number): Promise<boolean> {
    if (!tunnels) return false
    try {
      const t = await tunnels.open(port)
      try {
        return await createEnvdClient({ baseUrl: `http://127.0.0.1:${String(t.localPort)}`, accessToken: '' }).health(AbortSignal.timeout(2_000))
      } finally {
        t.close()
      }
    } catch (e) {
      if (changed || e instanceof HostKeyChangedError) throw e
      return false
    }
  }

  /** Adds the firewall rules, then starts envd detached in its own session and waits until it answers. */
  async function launch(d: Dirs, id: string, a: Arch, port: number): Promise<void> {
    await ensureRules(d, id, port)
    const dir = sbDir(d, id)
    await shell.exec(`rm -f -- ${sq(`${dir}/envd.pid`)}`)
    // setsid: envd leads a session whose id is its pid, so stop can end everything started under it. The shell
    // records its own pid and execs envd, so the recorded pid is envd's, not sudo's.
    const inner = `echo $$ > ${sq(`${dir}/envd.pid`)} && exec ${sq(binPath(d, a))} --isnotfc --no-cgroups --port ${String(port)}`
    const script = `nohup sudo -n setsid sh -c ${sq(inner)} > ${sq(`${dir}/envd.log`)} 2>&1 < /dev/null &`
    await must(`sh -c ${sq(script)}`, 'starting envd')
    const began = Date.now()
    const deadline = began + config.startTimeoutMs
    for (;;) {
      if ((await alive(d, id)) === undefined) {
        // The pid file is written a moment after the launch returns.
        if ((await pidOf(d, id)) !== undefined || Date.now() - began > 3_000) {
          const log = (await shell.exec(`tail -n 10 -- ${sq(`${dir}/envd.log`)}`)).stdout.trim()
          throw new Error(`envd exited on ${target.host}${log ? `: ${log.slice(-400)}` : ''}`)
        }
      } else if (await healthy(port)) return
      if (Date.now() >= deadline) throw new Error(`envd did not answer on ${target.host} within ${String(config.startTimeoutMs)} ms`)
      await sleep(250)
    }
  }

  const gpuHandle = (h: Handle, gpuIds: string[]): Handle => {
    const { gpuIds: _g, ...rest } = h
    return gpuIds.length > 0 ? { ...rest, gpuIds: gpuIds.join(',') } : rest
  }

  /** Whether `workspace` is one this driver created for `id`: a `sandbox-...` directory whose marker holds the id. */
  async function ownsWorkspace(id: string, workspace: string): Promise<string | undefined> {
    if (!OWNED_NAME.test(posix.basename(workspace))) return `its name does not start with "sandbox-"`
    const marker = await shell.exec(`cat -- ${sq(`${workspace}/${MARKER}`)}`)
    if (marker.code !== 0 || marker.stdout.trim() !== id) return `it was not created by sandbox ${id}`
    return undefined
  }

  async function destroyBy(id: string, recorded: { workspace?: string; port?: number }, removeWorkspace: boolean): Promise<void> {
    const d = await dirs()
    const dir = sbDir(d, id)
    // Validated before anything is stopped or deleted.
    const workspace = removeWorkspace && recorded.workspace !== undefined ? safeWorkspace(recorded.workspace, d.home) : undefined
    await killEnvd(d, id)
    if (recorded.port !== undefined) await removeRules(d, id, recorded.port)
    if (workspace !== undefined) {
      const refusal = await ownsWorkspace(id, workspace)
      if (refusal) console.warn(`[agentry-sandbox] left the workspace ${workspace} on ${target.host} in place: ${refusal}`)
      else await must(`sudo -n rm -rf -- ${sq(workspace)}`, 'removing the workspace')
    }
    await must(`sudo -n rm -rf -- ${sq(dir)}`, 'removing the sandbox directory')
  }

  const driver: Driver = {
    kind: 'ssh-machine',
    capabilities: { persistent: true, reset: false, keepFilesOnReset: false, isolated: false, network: false, resources: false, gpu: true, envdBuiltIn: false, runsAsRoot: true, templateFields: ['setupCommands', 'env', 'files', 'gpus'] },
    agentUser: login,
    envdUser: (requested) => (requested === 'agent' ? login : requested),
    envdEnv: (handle): Record<string, string> => (handle.gpuIds ? { CUDA_VISIBLE_DEVICES: handle.gpuIds } : {}),

    async probe() {
      if (!pinned && !place.allowUnpinnedProbe) return { ok: false, reason: 'host key not confirmed' }
      try {
        const sudo = await sudoProblem()
        if (sudo) return { ok: false, reason: sudo }
        const m = (await must('uname -m', 'reading the architecture')).trim()
        if (m !== 'x86_64' && m !== 'aarch64' && m !== 'arm64') return { ok: false, reason: `unsupported architecture ${m}` }
        const kernel = first(await must('uname -sr', 'reading the kernel version'))
        if (pinned) {
          const smi = await shell.exec('nvidia-smi --query-gpu=index,uuid,name --format=csv,noheader')
          discovered = smi.code === 0 ? parseNvidiaSmi(smi.stdout) : []
        }
        return { ok: true, version: `${kernel} ${m}`, gpus: discovered }
      } catch (e) {
        if (changed || e instanceof HostKeyChangedError) return { ok: false, reason: 'host key changed', hostKeyChanged: true }
        return { ok: false, reason: `${target.host} is not reachable: ${(e as Error).message}` }
      }
    },

    async discoverGpus() {
      if (!pinned) return []
      return guarded(async () => {
        const smi = await shell.exec('nvidia-smi --query-gpu=index,uuid,name --format=csv,noheader')
        return (discovered = smi.code === 0 ? parseNvidiaSmi(smi.stdout) : [])
      }).catch(() => [] as GpuInfo[])
    },

    async dshRuntime() {
      return guarded(async () => {
        const image = config.dshRuntimeImage
        if (!image) return null
        const a = await arch()
        return { arch: a, tar: () => treeArchive(local(), image, '/opt/agentry/dsh', ensure, `linux/${a}`) }
      })
    },

    async create(id, owner, spec, ctx) {
      return guarded(async () => {
        if (!ID.test(id)) throw new Error('invalid sandbox id')
        const sudo = await sudoProblem()
        if (sudo) throw new Error(sudo)
        const a = await arch()
        const d = await dirs()
        const workspace = safeWorkspace(spec.workspacePath ?? DEFAULT_WORKSPACE, d.home)
        let port: number | undefined
        let createdWorkspace = false
        try {
          await ensureEnvd(d, a)
          port = await portLock(async () => {
            const metas = await readMetas(d)
            const clash = metas.find((m) => m.id !== id && posix.normalize(m.workspace) === workspace)
            if (clash) throw new Error(`the workspace ${workspace} is already used by sandbox ${clash.id} on ${target.host}; give this sandbox its own workspace_path`)
            // Only a directory this driver makes is ever chowned or deleted.
            // The exception: an empty real directory (the API makes one before calling) is adopted.
            if ((await shell.exec(`test -e ${sq(workspace)}`)).code === 0 || (await shell.exec(`test -L ${sq(workspace)}`)).code === 0) {
              const isLink = (await shell.exec(`test -L ${sq(workspace)}`)).code === 0
              const isDir = (await shell.exec(`test -d ${sq(workspace)}`)).code === 0
              const entries = isDir && !isLink ? await shell.exec(`sudo -n ls -A -- ${sq(workspace)}`) : undefined
              if (!entries || entries.code !== 0 || entries.stdout.trim() !== '') throw new Error(`the workspace ${workspace} already exists on ${target.host}; give this sandbox a workspace_path that does not exist yet`)
            }
            const p = await freePort(d, id)
            await must(`mkdir -p -- ${sq(sbDir(d, id))}`, 'creating the sandbox directory')
            await writeMeta(d, { id, owner, workspace, port: p })
            createdWorkspace = true
            await must(`sudo -n mkdir -p -- ${sq(workspace)}`, 'creating the workspace')
            await must(`sudo -n chown -- ${sq(login)} ${sq(workspace)}`, 'giving the workspace to the login user')
            await shell.writeFile(`${workspace}/${MARKER}`, Buffer.from(`${id}\n`))
            return p
          })
          await launch(d, id, a, port)
          return gpuHandle({ id, port: String(port), workspace }, ctx.gpuIds)
        } catch (e) {
          // A failed create removes what it made: a workspace that holds only its marker goes with it.
          await destroyBy(id, { workspace, ...(port !== undefined ? { port } : {}) }, false).catch(() => {})
          if (createdWorkspace) await shell.exec(`sudo -n rm -f -- ${sq(`${workspace}/${MARKER}`)}`).then(() => shell.exec(`sudo -n rmdir -- ${sq(workspace)}`)).catch(() => {})
          throw e
        }
      })
    },

    async start(id, handle, spec, ctx) {
      return guarded(async () => {
        const a = await arch()
        const d = await dirs()
        const dir = sbDir(d, id)
        const meta = (await readMetas(d)).find((m) => m.id === id)
        if (!meta && (await shell.exec(`test -d ${sq(dir)}`)).code !== 0) throw new Error(`sandbox ${id} is gone from ${target.host}`)
        const workspace = safeWorkspace(handle.workspace ?? meta?.workspace ?? spec.workspacePath ?? DEFAULT_WORKSPACE, d.home)
        const recordedPort = Number(handle.port ?? meta?.port)
        let port = Number.isInteger(recordedPort) && recordedPort > 0 ? recordedPort : undefined
        await ensureEnvd(d, a, { onlyIfMissing: true })
        await must(`sudo -n mkdir -p -- ${sq(workspace)}`, 'creating the workspace')
        // Rules are re-checked on every start, before anything can listen.
        if (port !== undefined) {
          await ensureRules(d, id, port)
          if ((await alive(d, id)) !== undefined && (await healthy(port))) return gpuHandle({ ...handle, id, port: String(port), workspace }, ctx.gpuIds)
        }
        try {
          await killEnvd(d, id) // a stale or half-dead envd
          const next = await portLock(async () => {
            const p = await freePort(d, id, port)
            if (p !== meta?.port) await writeMeta(d, { id, owner: meta?.owner ?? '', workspace, port: p })
            return p
          })
          if (port !== undefined && port !== next) await removeRules(d, id, port)
          port = next
          await launch(d, id, a, port)
          return gpuHandle({ ...handle, id, port: String(port), workspace }, ctx.gpuIds)
        } catch (e) {
          // Rules go only once envd is confirmed gone.
          await killEnvd(d, id).then(() => (port !== undefined ? removeRules(d, id, port) : undefined)).catch(() => {})
          throw e
        }
      })
    },

    async stop(handle) {
      return guarded(async () => {
        const id = handle.id
        if (!id) return
        const d = await dirs()
        await killEnvd(d, id) // throws when envd survives: the rules stay
        const port = Number(handle.port)
        if (Number.isInteger(port) && port > 0) await removeRules(d, id, port)
      })
    },

    async destroy(id, handle, { keepWorkspace }) {
      return guarded(async () => {
        if (!ID.test(id)) throw new Error('invalid sandbox id')
        const d = await dirs()
        let recorded: { workspace?: string; port?: number }
        if (handle.workspace !== undefined) {
          const port = Number(handle.port)
          recorded = { workspace: handle.workspace, ...(Number.isInteger(port) && port > 0 ? { port } : {}) }
        } else {
          const m = (await readMetas(d)).find((x) => x.id === id)
          recorded = m ? { workspace: m.workspace, port: m.port } : {}
        }
        await destroyBy(id, recorded, !keepWorkspace)
      })
    },

    async status(handle) {
      return guarded(async () => {
        const id = handle.id
        if (!id) return 'missing'
        const d = await dirs()
        if ((await shell.exec(`test -d ${sq(sbDir(d, id))}`)).code !== 0) return 'missing'
        const port = Number(handle.port)
        if ((await alive(d, id)) !== undefined && Number.isInteger(port) && (await healthy(port))) return 'running'
        return 'stopped'
      })
    },

    async envdEndpoint(handle) {
      return guarded(async () => {
        const port = Number(handle.port)
        if (!Number.isInteger(port) || port <= 0) throw new Error('the sandbox has no envd port')
        const t = await tunnels!.open(port)
        return { baseUrl: `http://127.0.0.1:${String(t.localPort)}`, release: () => t.close() }
      })
    },

    async listManaged() {
      return guarded(async () => {
        const d = await dirs()
        return (await readMetas(d)).map((m) => ({ id: m.id, owner: m.owner, handle: { id: m.id, port: String(m.port), workspace: m.workspace, provisioned: 'true' } }))
      })
    },

    observedHostKey: () => observed,

    async close() {
      await tunnels?.closeAll()
      await shell.close()
    },
  }
  return driver
}

/** Registry factory for kind `ssh-machine`. */
export function sshMachineFactory(config: SandboxConfig, deps: SshMachineDeps = {}): DriverFactory {
  return (record, secrets, opts) => {
    const target = record.config.url
    if (typeof target !== 'string') throw new Error('url is required')
    parseSshTarget(target)
    if (!secrets.private_key) throw new Error('private_key is required')
    const hostKey = record.config.host_key
    return createSshMachineDriver(config, { target, privateKey: secrets.private_key, ...(typeof hostKey === 'string' && hostKey ? { hostKey } : {}), ...(opts?.forTest ? { allowUnpinnedProbe: true } : {}) }, deps)
  }
}
