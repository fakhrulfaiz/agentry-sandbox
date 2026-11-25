/**
 * The Docker driver: one hardened container per sandbox, running E2B's envd
 * (injected, so any image works), with the workspace on a named volume.
 * It places envd and gets it reachable; provisioning is the shared bootstrap.
 */
import Docker from 'dockerode'
import type { SandboxConfig } from '../../config.ts'
import { createEnvdClient } from '../../envd/client.ts'
import { envdArchive, treeArchive } from '../../backends/envd-binary.ts'
import type { GpuInfo, TemplateSpec } from '../../store/types.ts'
import { parseNvidiaSmi } from '../gpus.ts'
import type { Driver, Handle, ImageInfo, NetworkGuard } from '../driver.ts'

const ENVD_PORT = '49983/tcp'
const DEFAULT_WORKSPACE = '/workspace'
const workspaceOf = (spec: TemplateSpec) => spec.workspacePath ?? DEFAULT_WORKSPACE
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

/** The DSH runtime tree from `config.dshRuntimeImage` as a tar, for the bootstrap to copy through envd (null when disabled). */
export function dockerDshRuntime(config: SandboxConfig, client: Docker = dockerClient(config)): (() => Promise<Buffer>) | null {
  const image = config.dshRuntimeImage
  return image ? () => treeArchive(client, image, '/opt/agentry/dsh') : null
}

/** Variations on the Docker driver: another kind name, another way to reach the published envd port (SSH tunnel). */
export interface DockerDriverOptions {
  kind?: string
  /** Where envd answers given the container's published `127.0.0.1` port; default is that port directly. */
  reach?: (hostPort: number) => Promise<{ baseUrl: string; release?: () => void }>
}

export function createDockerDriver(config: SandboxConfig, network: NetworkGuard, client: Docker = dockerClient(config), puller: Docker = dockerClient(config, undefined), options: DockerDriverOptions = {}): Driver {

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

  /** The GPUs of this host (cached once found: they rarely change, and a probe runs a container). */
  let gpuCache: GpuInfo[] = []
  async function listGpus(): Promise<GpuInfo[]> {
    if (gpuCache.length > 0) return gpuCache
    const info = await client.info()
    if (!Object.keys((info as { Runtimes?: Record<string, unknown> }).Runtimes ?? {}).includes('nvidia')) return []
    const image = config.defaultImage
    await ensureImage(image)
    const container = await client.createContainer({
      Image: image,
      Entrypoint: [],
      Cmd: ['nvidia-smi', '--query-gpu=index,uuid,name', '--format=csv,noheader'],
      Labels: { 'agentry.probe': 'true' },
      HostConfig: { AutoRemove: false, DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu', 'utility']] }] },
    })
    try {
      await container.start()
      await container.wait()
      const logs = await container.logs({ stdout: true, stderr: false })
      // Docker multiplexes stdout in 8-byte framed chunks; strip the frames.
      gpuCache = parseNvidiaSmi(demux(Buffer.isBuffer(logs) ? logs : Buffer.from(logs as unknown as string)))
    } finally {
      await container.remove({ force: true }).catch(() => {})
    }
    return gpuCache
  }

  async function envdEndpoint(handle: Handle): Promise<{ baseUrl: string; release?: () => void }> {
    const info = await client.getContainer(handle.containerId!).inspect()
    if (config.envdReach === 'loopback') {
      const port = info.NetworkSettings.Ports?.[ENVD_PORT]?.find((b) => b.HostIp === '127.0.0.1')?.HostPort
      if (!port) throw new Error('envd port is not published on 127.0.0.1')
      return options.reach ? options.reach(Number(port)) : { baseUrl: `http://127.0.0.1:${port}` }
    }
    const ip = info.NetworkSettings.Networks?.[handle.network ?? '']?.IPAddress
    if (!ip) throw new Error('sandbox has no container IP')
    return { baseUrl: `http://${ip}:49983` }
  }

  async function waitHealthy(handle: Handle): Promise<void> {
    const deadline = Date.now() + config.startTimeoutMs
    let last = 'not started'
    for (;;) {
      try {
        const { baseUrl, release } = await envdEndpoint(handle)
        try {
          if (await createEnvdClient({ baseUrl, accessToken: '' }).health(AbortSignal.timeout(2_000))) return
        } finally {
          release?.()
        }
        last = 'health check failed'
      } catch (e) {
        last = (e as Error).message
      }
      if (Date.now() >= deadline) throw new Error(`envd did not become healthy within ${String(config.startTimeoutMs)} ms (${last})`)
      await sleep(250)
    }
  }

  /**
   * Starts the container, applies its network rules and waits for envd. Until
   * `/init` envd accepts any caller, so a boot that fails must not leave the
   * container running: `start` stops it and `create` removes it.
   */
  async function boot(handle: Handle, spec: TemplateSpec): Promise<Handle> {
    const container = client.getContainer(handle.containerId!)
    if (!(await container.inspect()).State.Running) await container.start()
    await network.applyFor(handle.containerId!, { network: spec.network !== false })
    await waitHealthy(handle)
    return handle
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

  const labels = (id: string, owner: string) => ({ 'agentry.managed': 'true', 'agentry.sandbox.id': id, 'agentry.sandbox.owner': owner })

  /** Creates and boots the container on `volume`. A failure removes the container (and the volume when `ownsVolume`). */
  async function makeContainer(id: string, owner: string, spec: TemplateSpec, gpuIds: string[], volume: string, ownsVolume: boolean, provisioned = 'false'): Promise<Handle> {
    const image = spec.image ?? config.defaultImage
    await ensureImage(image)
    const net = await network.networkFor(owner)
    const cpus = spec.resources?.cpus ?? config.resources.cpus
    const memory = spec.resources?.memoryMb ? spec.resources.memoryMb * 1024 * 1024 : config.resources.memoryBytes
    const container = await client.createContainer({
      name: containerName(id),
      Image: image,
      Entrypoint: ['/opt/agentry/envd', '--isnotfc', '--no-cgroups', '--port', '49983'],
      Cmd: [],
      User: 'root',
      WorkingDir: workspaceOf(spec),
      Labels: labels(id, owner),
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
        ...(gpuIds.length > 0 ? { DeviceRequests: [{ Driver: 'nvidia', DeviceIDs: gpuIds, Capabilities: [['gpu', 'utility', 'compute']] }] } : {}),
        ...(config.envdReach === 'loopback' ? { PortBindings: { [ENVD_PORT]: [{ HostIp: '127.0.0.1', HostPort: '' }] } } : {}),
      },
    })
    try {
      await container.putArchive(await envdArchive(client, config.envdImage), { path: '/' })
      return await boot({ containerId: container.id, volume, network: net, provisioned }, spec)
    } catch (e) {
      // Fail closed: nothing half-made stays behind, running or not.
      await removeAll(container.id, ownsVolume ? volume : undefined).catch(() => {})
      throw e
    }
  }

  return {
    kind: options.kind ?? 'docker',
    capabilities: { persistent: true, reset: true, isolated: true, network: true, resources: true, gpu: true, envdBuiltIn: false, runsAsRoot: true, templateFields: ['image', 'packages', 'setupCommands', 'env', 'network', 'files', 'resources'] },

    async probe() {
      try {
        const v = await client.version()
        const gpus = await listGpus().catch(() => [] as GpuInfo[])
        return { ok: true as const, version: v.Version, gpus }
      } catch (e) {
        return { ok: false as const, reason: `Docker is not reachable: ${(e as Error).message}` }
      }
    },

    async describeImage(image) {
      try {
        const labels = (await client.getImage(image).inspect()).Config?.Labels ?? {}
        return imageInfoFromLabels(labels)
      } catch {
        return undefined
      }
    },

    async create(id, owner, spec, ctx) {
      const volume = volumeName(id)
      await client.createVolume({ Name: volume, Labels: labels(id, owner) })
      return makeContainer(id, owner, spec, ctx.gpuIds, volume, true)
    },

    async start(id, handle, spec, ctx) {
      try {
        const info = await client.getContainer(handle.containerId!).inspect()
        const current = (info.HostConfig.DeviceRequests ?? []).flatMap((d) => d.DeviceIDs ?? []).sort()
        const wanted = [...ctx.gpuIds].sort()
        if (current.join(',') !== wanted.join(',')) {
          // Devices are fixed at container create: recreate on the same volume (the workspace survives).
          const owner = info.Config.Labels['agentry.sandbox.owner'] ?? ''
          await removeAll(handle.containerId!, undefined)
          return await makeContainer(id, owner, spec, ctx.gpuIds, handle.volume ?? volumeName(id), false)
        }
        return await boot(handle, spec)
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

    envdEndpoint,

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

/** `org.agentry.*` image labels as `ImageInfo`; `undefined` when the image has none. */
export function imageInfoFromLabels(labels: Record<string, string>): ImageInfo | undefined {
  const words = (v: string | undefined) => (v ?? '').split(/\s+/u).filter(Boolean)
  let runtimes: Record<string, string> = {}
  try {
    const parsed = JSON.parse(labels['org.agentry.runtimes'] ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') runtimes = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  } catch {
    runtimes = {}
  }
  const info = { runtimes, python_packages: words(labels['org.agentry.python-packages']), tools: words(labels['org.agentry.tools']) }
  return Object.keys(info.runtimes).length + info.python_packages.length + info.tools.length > 0 ? info : undefined
}

/** Strips Docker's 8-byte stream frames from container logs (a TTY-less container's output). */
function demux(buf: Buffer): string {
  const parts: Buffer[] = []
  let i = 0
  while (i + 8 <= buf.length && buf[i]! <= 2 && buf[i + 1] === 0) {
    const len = buf.readUInt32BE(i + 4)
    parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 8 + len
  }
  return i === 0 ? buf.toString('utf8') : Buffer.concat(parts).toString('utf8')
}
