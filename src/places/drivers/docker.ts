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
import { createEnsureImage, type EnsureImage } from '../images.ts'
import type { Driver, Handle, ImageInfo, NetworkGuard, StartContext } from '../driver.ts'
import { cacheKey, cacheTag, CACHE_REPO, LABEL_BASE, LABEL_KEY, pruneList, type CacheImage } from '../template-cache.ts'

const ENVD_PORT = '49983/tcp'
const DEFAULT_WORKSPACE = '/workspace'
const workspaceOf = (spec: TemplateSpec) => spec.workspacePath ?? DEFAULT_WORKSPACE
/** Docker's default capability set minus NET_RAW: enough for sudo, package managers and chown. */
const CAP_ADD = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'AUDIT_WRITE', 'MKNOD']

export const containerName = (id: string) => `agentry-sbx-${id}`
export const volumeName = (id: string) => `agentry-sbx-${id}-workspace`

/** Docker API calls give up after this; image pulls use a client without a timeout. */
const DOCKER_TIMEOUT_MS = 60_000
/** Every relayed request asks for the status; trust a recent `running` instead of inspecting over SSH each time. */
const STATUS_TTL_MS = 15_000

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
export function dockerDshRuntime(config: SandboxConfig, client: Docker = dockerClient(config), ensure?: EnsureImage): (() => Promise<Buffer>) | null {
  const image = config.dshRuntimeImage
  return image ? () => treeArchive(client, image, '/opt/agentry/dsh', ensure) : null
}

/** Variations on the Docker driver: another kind name, another way to reach the published envd port (SSH tunnel). */
export interface DockerDriverOptions {
  kind?: string
  /** Where envd answers given the container's published `127.0.0.1` port; default is that port directly. */
  reach?: (hostPort: number) => Promise<{ baseUrl: string; release?: () => void }>
  /** Makes an image present on this driver's daemon; default pulls through `puller`. Share it with the egress guard. */
  ensure?: EnsureImage
  /** Whether `discoverGpus` may run a container (false over a connection whose host key is not confirmed). */
  discovery?: boolean
}

export function createDockerDriver(config: SandboxConfig, network: NetworkGuard, client: Docker = dockerClient(config), puller: Docker = dockerClient(config, undefined), options: DockerDriverOptions = {}): Driver {

  const ensureImage = options.ensure ?? createEnsureImage(client, puller)

  /** The GPUs found by `discoverGpus` (remembered, even when there are none: a probe runs a container). */
  let gpuCache: GpuInfo[] = []
  async function discoverGpus(): Promise<GpuInfo[]> {
    const info = await client.info()
    if (!Object.keys((info as { Runtimes?: Record<string, unknown> }).Runtimes ?? {}).includes('nvidia')) return (gpuCache = [])
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

  /** One resolved endpoint per container: callers of `envdEndpoint` share it (and its SSH tunnel) until the machine goes away. */
  type ResolvedEndpoint = { baseUrl: string; close?: () => void }
  const endpoints = new Map<string, Promise<ResolvedEndpoint>>()
  const runningUntil = new Map<string, number>()

  async function resolveEndpoint(handle: Handle): Promise<ResolvedEndpoint> {
    const info = await client.getContainer(handle.containerId!).inspect()
    if (config.envdReach === 'loopback') {
      const port = info.NetworkSettings.Ports?.[ENVD_PORT]?.find((b) => b.HostIp === '127.0.0.1')?.HostPort
      if (!port) throw new Error('envd port is not published on 127.0.0.1')
      if (!options.reach) return { baseUrl: `http://127.0.0.1:${port}` }
      const reached = await options.reach(Number(port))
      return { baseUrl: reached.baseUrl, close: reached.release }
    }
    const ip = info.NetworkSettings.Networks?.[handle.network ?? '']?.IPAddress
    if (!ip) throw new Error('sandbox has no container IP')
    return { baseUrl: `http://${ip}:49983` }
  }

  async function envdEndpoint(handle: Handle): Promise<{ baseUrl: string; release?: () => void }> {
    const id = handle.containerId!
    let pending = endpoints.get(id)
    if (!pending) {
      pending = resolveEndpoint(handle)
      endpoints.set(id, pending)
      // A failed resolution must not stay cached: the next call may find a restarted container.
      void pending.catch(() => { if (endpoints.get(id) === pending) endpoints.delete(id) })
    }
    const { baseUrl } = await pending
    // No per-request `release`: the endpoint (and a tunneled reach) belongs to the container, not the caller.
    return { baseUrl }
  }

  /** Ends a container's shared reach when the machine is stopped, removed or replaced. */
  function forgetEndpoint(containerId: string | undefined): void {
    if (!containerId) return
    runningUntil.delete(containerId)
    const pending = endpoints.get(containerId)
    if (!pending) return
    endpoints.delete(containerId)
    void pending.then((ep) => ep.close?.(), () => {})
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


  // ---- template image cache ----

  const cacheLog = (msg: string, e?: unknown) => console.log(`[agentry-sandbox] template cache: ${msg}${e === undefined ? '' : ` (${(e as Error).message ?? String(e)})`}`)
  /** When each cache image was last used by this process; images not seen yet count from their creation time. */
  const cacheUsed = new Map<string, number>()
  const committing = new Set<string>()
  const imageExists = async (ref: string): Promise<boolean> => {
    try {
      await client.getImage(ref).inspect()
      return true
    } catch (e) {
      if (isNotFound(e)) return false
      throw e
    }
  }

  /** The cache key for a create and whether its image exists; undefined when the cache is off or cannot be consulted (never fails a create). */
  async function cacheLookup(spec: TemplateSpec, ctx: StartContext | undefined): Promise<{ key: string; base: string; hit: boolean } | undefined> {
    if (!config.templateCache || !ctx?.runtimeRef) return undefined
    try {
      const base = (await client.getImage(spec.image ?? config.defaultImage).inspect()).Id
      const arch = ((await client.version()) as { Arch?: string }).Arch ?? ''
      const key = cacheKey({ baseImage: base, packages: spec.packages, runtimeRef: `${ctx.runtimeRef}@${arch}` })
      return { key, base, hit: await imageExists(cacheTag(key)) }
    } catch (e) {
      cacheLog('lookup failed, creating without it', e)
      return undefined
    }
  }

  /** Removes cache images beyond the newest `templateCacheMax`; an image a container still uses is refused by Docker and stays. */
  async function pruneCache(): Promise<void> {
    const listed = await client.listImages({ filters: { label: [LABEL_KEY] } })
    const images: (CacheImage & { tag: string })[] = listed.flatMap((i) => {
      const tag = (i.RepoTags ?? []).find((t) => t.startsWith(`${CACHE_REPO}:`))
      return tag ? [{ id: i.Id, tag, usedAt: cacheUsed.get(i.Id) ?? i.Created * 1000 }] : []
    })
    for (const old of pruneList(images, config.templateCacheMax) as (CacheImage & { tag: string })[]) {
      await client.getImage(old.tag).remove().then(
        () => cacheUsed.delete(old.id),
        (e: unknown) => {
          if (isNotFound(e) || (e as { statusCode?: number }).statusCode === 409) return
          throw e
        },
      )
    }
  }

  async function commitCache(handle: Handle): Promise<void> {
    const key = handle.cacheKey
    if (!key || handle.cache !== 'miss' || !handle.containerId || committing.has(key)) return
    committing.add(key)
    try {
      const tag = cacheTag(key)
      if (await imageExists(tag)) return
      // Container labels are copied into a commit: blank the sandbox and owner ones so the image names nobody.
      await puller.getContainer(handle.containerId).commit({
        repo: CACHE_REPO,
        tag: tag.slice(CACHE_REPO.length + 1),
        comment: 'agentry template cache',
        pause: true,
        changes: [`LABEL ${LABEL_KEY}=${key}`, `LABEL ${LABEL_BASE}=${handle.cacheBase ?? ''}`, 'LABEL agentry.managed=""', 'LABEL agentry.sandbox.id=""', 'LABEL agentry.sandbox.owner=""'],
      })
      await pruneCache().catch((e: unknown) => cacheLog('prune failed', e))
    } catch (e) {
      cacheLog('commit failed, the sandbox is unaffected', e)
    } finally {
      committing.delete(key)
    }
  }

  const labels = (id: string, owner: string) => ({ 'agentry.managed': 'true', 'agentry.sandbox.id': id, 'agentry.sandbox.owner': owner })

  /** Creates and boots the container on `volume`. A failure removes the container (and the volume when `ownsVolume`). */
  async function makeContainer(id: string, owner: string, spec: TemplateSpec, gpuIds: string[], volume: string, ownsVolume: boolean, provisioned = 'false', recreated = false, ctx?: StartContext): Promise<Handle> {
    const image = spec.image ?? config.defaultImage
    const progress = ctx?.progress
    if (progress && !(await imageExists(image).catch(() => true))) progress({ stage: 'pulling_image' })
    await ensureImage(image)
    progress?.({ stage: 'starting' })
    const cache = await cacheLookup(spec, ctx)
    const net = await network.networkFor(owner)
    const cpus = spec.resources?.cpus ?? config.resources.cpus
    const memory = spec.resources?.memoryMb ? spec.resources.memoryMb * 1024 * 1024 : config.resources.memoryBytes
    const createFrom = (from: string) => client.createContainer({
      name: containerName(id),
      Image: from,
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
    let hit = cache?.hit === true
    let container
    if (hit) {
      try {
        container = await createFrom(cacheTag(cache!.key))
        cacheUsed.set((await client.getImage(cacheTag(cache!.key)).inspect()).Id, Date.now())
      } catch (e) {
        // Pruned between the lookup and now: build the base the long way.
        cacheLog('cached image vanished, creating from the base image', e)
        hit = false
      }
    }
    container ??= await createFrom(image)
    const cacheHandle: Handle = cache ? { cacheKey: cache.key, cacheBase: cache.base, cache: hit ? 'hit' : 'miss' } : {}
    try {
      await container.putArchive(await envdArchive(client, config.envdImage, ensureImage), { path: '/' })
      return await boot({ containerId: container.id, volume, network: net, provisioned, ...cacheHandle, ...(recreated ? { recreated: 'true' } : {}) }, spec)
    } catch (e) {
      // Fail closed: nothing half-made stays behind, running or not.
      await removeAll(container.id, ownsVolume ? volume : undefined).catch(() => {})
      throw e
    }
  }

  return {
    kind: options.kind ?? 'docker',
    capabilities: { persistent: true, reset: true, keepFilesOnReset: true, isolated: true, network: true, resources: true, gpu: true, envdBuiltIn: false, runsAsRoot: true, templateFields: ['image', 'packages', 'setupCommands', 'env', 'network', 'files', 'resources'] },

    async probe() {
      try {
        const v = await client.version()
        return { ok: true as const, version: v.Version, gpus: gpuCache }
      } catch (e) {
        return { ok: false as const, reason: `Docker is not reachable: ${(e as Error).message}` }
      }
    },

    async discoverGpus() {
      if (options.discovery === false) return []
      return discoverGpus().catch(() => [] as GpuInfo[])
    },

    async dshRuntime() {
      const image = config.dshRuntimeImage
      if (!image) return null
      const arch = ((await client.version()) as { Arch?: string }).Arch ?? ''
      return { arch, tar: () => treeArchive(client, image, '/opt/agentry/dsh', ensureImage) }
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
      return makeContainer(id, owner, spec, ctx.gpuIds, volume, true, 'false', false, ctx)
    },

    commitCache,

    async start(id, handle, spec, ctx) {
      try {
        const info = await client.getContainer(handle.containerId!).inspect()
        const current = (info.HostConfig.DeviceRequests ?? []).flatMap((d) => d.DeviceIDs ?? []).sort()
        const wanted = [...ctx.gpuIds].sort()
        if (current.join(',') !== wanted.join(',')) {
          // Devices are fixed at container create: recreate on the same volume (the workspace survives).
          const owner = info.Config.Labels['agentry.sandbox.owner'] ?? ''
          await removeAll(handle.containerId!, undefined)
          return await makeContainer(id, owner, spec, ctx.gpuIds, handle.volume ?? volumeName(id), false, 'false', true)
        }
        return await boot(handle, spec)
      } catch (e) {
        await stopContainer(handle.containerId!).catch(() => {})
        throw e
      }
    },

    async stop(handle) {
      try {
        await stopContainer(handle.containerId!)
      } finally {
        forgetEndpoint(handle.containerId)
      }
    },

    async destroy(id, handle, { keepWorkspace }) {
      const container = handle.containerId ?? containerName(id)
      try {
        await removeAll(container, keepWorkspace ? undefined : (handle.volume ?? volumeName(id)))
      } finally {
        forgetEndpoint(container)
      }
    },

    async maintain(_id, handle, spec) {
      if (handle.containerId) await network.applyFor(handle.containerId, { network: spec.network !== false })
    },

    async releaseOwner(owner) {
      await network.removeOwnerNetwork?.(owner)
    },

    async close() {
      for (const id of [...endpoints.keys()]) forgetEndpoint(id)
    },

    async status(handle) {
      const id = handle.containerId ?? ''
      if ((runningUntil.get(id) ?? 0) > Date.now()) return 'running'
      try {
        const running: boolean = (await client.getContainer(id).inspect()).State.Running
        if (running) runningUntil.set(id, Date.now() + STATUS_TTL_MS)
        else runningUntil.delete(id)
        return running ? 'running' : 'stopped'
      } catch (e) {
        if (isNotFound(e)) {
          runningUntil.delete(id)
          return 'missing'
        }
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
