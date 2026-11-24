/**
 * The Docker backend: one hardened container per sandbox, running E2B's envd
 * (injected, so any image works), with the workspace on a named volume.
 *
 * First start provisions through envd as root: the `agent` user with
 * passwordless sudo, template packages (apt or apk), template files, then the
 * template's setup commands as `agent` in `/workspace`. Later starts only
 * start the container, so whatever the agent installed is still there.
 */
import Docker from 'dockerode'
import type { SandboxConfig } from '../config.ts'
import { createEnvdClient, type EnvdClient } from '../envd/client.ts'
import { runInEnvd, sq } from '../envd/run.ts'
import { envdToken } from '../envd/token.ts'
import type { TemplateSpec } from '../store/types.ts'
import { envdArchive, treeArchive } from './envd-binary.ts'
import type { Availability, Backend, BackendHandle, NetworkGuard } from './types.ts'

const ENVD_PORT = '49983/tcp'
const DEFAULT_WORKSPACE = '/workspace'
const workspaceOf = (spec: TemplateSpec) => spec.workspacePath ?? DEFAULT_WORKSPACE
const AGENT = 'agent'
/** Docker's default capability set minus NET_RAW: enough for sudo, package managers and chown. */
const CAP_ADD = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'AUDIT_WRITE', 'MKNOD']

export const containerName = (id: string) => `agentry-sbx-${id}`
export const volumeName = (id: string) => `agentry-sbx-${id}-workspace`

/** Docker API calls give up after this; image pulls use a client without a timeout. */
const DOCKER_TIMEOUT_MS = 60_000

export function dockerClient(config: SandboxConfig, timeout: number | undefined = DOCKER_TIMEOUT_MS): Docker {
  const t = timeout === undefined ? {} : { timeout }
  const host = config.docker.host
  if (!host) return new Docker({ ...(config.docker.socketPath ? { socketPath: config.docker.socketPath } : {}), ...t })
  const url = new URL(host)
  if (url.protocol === 'unix:') return new Docker({ socketPath: url.pathname, ...t })
  return new Docker({ host: url.hostname, port: Number(url.port || 2375), protocol: url.protocol === 'https:' ? 'https' : 'http', ...t })
}

const isNotFound = (e: unknown) => (e as { statusCode?: number }).statusCode === 404
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The script that makes `agent` (uid 1000) with passwordless sudo, on Debian-like or Alpine images, and owns the workspace. */
const ensureAgent = (WORKSPACE: string) => `
set -e
if command -v apt-get >/dev/null 2>&1; then PM=apt; elif command -v apk >/dev/null 2>&1; then PM=apk; else PM=none; fi
if ! command -v sudo >/dev/null 2>&1; then
  if [ "$PM" = apt ]; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null
  elif [ "$PM" = apk ]; then apk add --no-cache -q sudo
  fi
fi
if ! id -u ${AGENT} >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then useradd -m -u 1000 -s /bin/sh ${AGENT} 2>/dev/null || useradd -m -s /bin/sh ${AGENT}
  else adduser -D -u 1000 -s /bin/sh ${AGENT} 2>/dev/null || adduser -D -s /bin/sh ${AGENT}
  fi
fi
mkdir -p /etc/sudoers.d
printf '${AGENT} ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/${AGENT}
chmod 0440 /etc/sudoers.d/${AGENT}
mkdir -p ${sq(WORKSPACE)}
chown ${AGENT}: ${sq(WORKSPACE)}
`

function installScript(packages: string[]): string {
  const list = packages.map(sq).join(' ')
  return `set -e
if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${list} >/dev/null
elif command -v apk >/dev/null 2>&1; then apk add --no-cache -q ${list}
else echo "no supported package manager (apt-get or apk) in this image" >&2; exit 1; fi`
}

export function createDockerBackend(config: SandboxConfig, network: NetworkGuard, client: Docker = dockerClient(config), puller: Docker = dockerClient(config, undefined)): Backend {
  const token = (id: string) => envdToken(config.secret, id)

  async function ensureImage(image: string): Promise<void> {
    try {
      await client.getImage(image).inspect()
      return
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
    // Pull without any credential helper (public images; a configured registry login would go in authconfig).
    const stream = await puller.pull(image, {})
    await new Promise<void>((resolve, reject) => puller.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())))
  }

  async function endpoint(handle: BackendHandle): Promise<{ baseUrl: string }> {
    const info = await client.getContainer(handle.containerId!).inspect()
    if (config.envdReach === 'loopback') {
      const port = info.NetworkSettings.Ports?.[ENVD_PORT]?.find((b) => b.HostIp === '127.0.0.1')?.HostPort
      if (!port) throw new Error('envd port is not published on 127.0.0.1')
      return { baseUrl: `http://127.0.0.1:${port}` }
    }
    const ip = info.NetworkSettings.Networks?.[handle.network ?? '']?.IPAddress
    if (!ip) throw new Error('sandbox has no container IP')
    return { baseUrl: `http://${ip}:49983` }
  }

  async function waitHealthy(handle: BackendHandle): Promise<void> {
    const deadline = Date.now() + config.startTimeoutMs
    let last = 'not started'
    for (;;) {
      try {
        const { baseUrl } = await endpoint(handle)
        if (await createEnvdClient({ baseUrl, accessToken: '' }).health(AbortSignal.timeout(2_000))) return
        last = 'health check failed'
      } catch (e) {
        last = (e as Error).message
      }
      if (Date.now() >= deadline) throw new Error(`envd did not become healthy within ${String(config.startTimeoutMs)} ms (${last})`)
      await sleep(250)
    }
  }

  async function provision(envd: EnvdClient, spec: TemplateSpec): Promise<void> {
    const must = async (user: string, script: string, what: string, cwd?: string) => {
      const r = await runInEnvd(envd, user, script, { ...(cwd ? { cwd } : {}), ...(spec.env ? { env: spec.env } : {}) })
      if (r.code !== 0) throw new Error(`${what} failed (exit ${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(-500)}`)
    }
    const WORKSPACE = workspaceOf(spec)
    await must('root', ensureAgent(WORKSPACE), 'creating the agent user')
    if (spec.packages && spec.packages.length > 0) await must('root', installScript(spec.packages), 'installing packages')
    for (const file of spec.files ?? []) {
      const path = file.path.startsWith('/') ? file.path : `${WORKSPACE}/${file.path}`
      await must(AGENT, `mkdir -p "$(dirname ${sq(path)})"`, `preparing ${file.path}`)
      await envd.writeFile(path, new TextEncoder().encode(file.content), AGENT)
    }
    for (const command of spec.setupCommands ?? []) await must(AGENT, command, `setup command "${command}"`, WORKSPACE)
  }

  /**
   * Starts the container, waits for envd, initialises it, and provisions on
   * first start. Until `/init` envd accepts any caller, so a boot that fails
   * must not leave the container running: `safeBoot` stops it (start) and
   * `create` removes it.
   */
  async function boot(id: string, handle: BackendHandle, spec: TemplateSpec): Promise<BackendHandle> {
    const container = client.getContainer(handle.containerId!)
    if (!(await container.inspect()).State.Running) await container.start()
    await network.applyFor(handle.containerId!, { network: spec.network !== false })
    await waitHealthy(handle)
    const { baseUrl } = await endpoint(handle)
    const envd = createEnvdClient({ baseUrl, accessToken: token(id) })
    const base = { accessToken: token(id), defaultWorkdir: workspaceOf(spec), ...(spec.env ? { envVars: spec.env } : {}) }
    if (handle.provisioned !== 'true') {
      await envd.init({ ...base, defaultUser: 'root' })
      await provision(envd, spec)
    }
    await envd.init({ ...base, defaultUser: AGENT })
    return { ...handle, provisioned: 'true' }
  }

  async function stopContainer(containerId: string): Promise<void> {
    try {
      await client.getContainer(containerId).stop({ t: 10 })
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode
      if (code !== 304 && code !== 404) throw e
    }
    await network.releaseFor(containerId).catch(() => {})
  }

  /** Removes a container (by id or name) with its rules, and the volume when given. */
  async function removeAll(container: string, volume: string | undefined): Promise<void> {
    let fullId: string | undefined
    try {
      fullId = (await client.getContainer(container).inspect()).Id
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
    if (fullId) {
      await network.releaseFor(fullId).catch(() => {})
      await client.getContainer(fullId).remove({ force: true, v: true }).catch((e: unknown) => { if (!isNotFound(e)) throw e })
    }
    if (volume) await client.getVolume(volume).remove().catch((e: unknown) => { if (!isNotFound(e)) throw e })
  }

  return {
    kind: 'docker',
    capabilities: { persistent: true, network: true, resources: true, templateFields: ['image', 'packages', 'setupCommands', 'env', 'network', 'files', 'resources'] },

    async available(): Promise<Availability> {
      try {
        const v = await client.version()
        return { ok: true, version: v.Version }
      } catch (e) {
        return { ok: false, reason: `Docker is not reachable: ${(e as Error).message}` }
      }
    },

    async create(id, owner, spec) {
      const image = spec.image ?? config.defaultImage
      await ensureImage(image)
      const net = await network.networkFor(owner)
      const labels = { 'agentry.managed': 'true', 'agentry.sandbox.id': id, 'agentry.sandbox.owner': owner }
      const volume = volumeName(id)
      await client.createVolume({ Name: volume, Labels: labels })
      const cpus = spec.resources?.cpus ?? config.resources.cpus
      const memory = spec.resources?.memoryMb ? spec.resources.memoryMb * 1024 * 1024 : config.resources.memoryBytes
      const container = await client.createContainer({
        name: containerName(id),
        Image: image,
        Entrypoint: ['/opt/agentry/envd', '--isnotfc', '--no-cgroups', '--port', '49983'],
        Cmd: [],
        User: 'root',
        WorkingDir: workspaceOf(spec),
        Labels: labels,
        ExposedPorts: { [ENVD_PORT]: {} },
        HostConfig: {
          Init: true,
          Privileged: false,
          CapDrop: ['ALL'],
          CapAdd: CAP_ADD,
          PidsLimit: config.resources.pids,
          NanoCpus: Math.round(cpus * 1e9),
          Memory: memory,
          Runtime: config.runtime,
          NetworkMode: net,
          Mounts: [{ Type: 'volume', Source: volume, Target: workspaceOf(spec) }],
          ...(config.envdReach === 'loopback' ? { PortBindings: { [ENVD_PORT]: [{ HostIp: '127.0.0.1', HostPort: '' }] } } : {}),
        },
      })
      try {
        await container.putArchive(await envdArchive(client, config.envdImage), { path: '/' })
        if (config.dshRuntimeImage) await container.putArchive(await treeArchive(client, config.dshRuntimeImage, '/opt/agentry/dsh'), { path: '/opt/agentry' })
        return await boot(id, { containerId: container.id, volume, network: net, provisioned: 'false' }, spec)
      } catch (e) {
        // Fail closed: nothing half-made stays behind, running or not.
        await removeAll(container.id, volume).catch(() => {})
        throw e
      }
    },

    async start(id, handle, spec) {
      try {
        return await boot(id, handle, spec)
      } catch (e) {
        await stopContainer(handle.containerId!).catch(() => {})
        throw e
      }
    },

    async stop(handle) {
      await stopContainer(handle.containerId!)
    },

    async destroy(id, handle, { keepWorkspace }) {
      await removeAll(handle.containerId ?? containerName(id), keepWorkspace ? undefined : (handle.volume ?? volumeName(id)))
    },

    async maintain(_id, handle, spec) {
      if (handle.containerId) await network.applyFor(handle.containerId, { network: spec.network !== false })
    },

    async releaseOwner(owner) {
      await network.removeOwnerNetwork?.(owner)
    },

    async status(handle) {
      try {
        return (await client.getContainer(handle.containerId!).inspect()).State.Running ? 'running' : 'stopped'
      } catch (e) {
        if (isNotFound(e)) return 'missing'
        throw e
      }
    },

    endpoint,

    async listManaged() {
      const list = await client.listContainers({ all: true, filters: { label: ['agentry.managed=true'] } })
      return list.map((c) => ({
        id: c.Labels['agentry.sandbox.id'] ?? '',
        owner: c.Labels['agentry.sandbox.owner'] ?? '',
        handle: { containerId: c.Id, volume: volumeName(c.Labels['agentry.sandbox.id'] ?? ''), network: c.HostConfig?.NetworkMode ?? '', provisioned: 'true' },
      }))
    },
  }
}
