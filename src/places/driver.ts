/**
 * What runs a sandbox: one Driver per kind of place (Docker, ...). A driver
 * makes the machine and gets envd reachable; the shared bootstrap
 * (`bootstrap.ts`) then provisions it the same way for every kind.
 */
import type { GpuInfo, ProgressUpdate, TemplateSpec } from '../store/types.ts'

/**
 * A driver's record of one machine. Keys starting with `secret.` hold credentials (E2B's envd token): the
 * service keeps them sealed apart from the handle and gives them back to the driver on every call.
 */
export type Handle = Record<string, string>

export interface Capabilities {
  persistent: boolean
  reset: boolean
  /** Reset can keep the workspace files (Docker keeps its volume; E2B kills the sandbox, so false). */
  keepFilesOnReset: boolean
  isolated: boolean
  network: boolean
  resources: boolean
  gpu: boolean
  envdBuiltIn: boolean
  runsAsRoot: boolean
  templateFields: (keyof TemplateSpec)[]
}

/** `hostKeyChanged` marks a remote host whose key no longer matches the pinned one (HTTP 409 `place_host_key_changed`). */
export type Availability = { ok: true; version: string } | { ok: false; reason: string; hostKeyChanged?: true }

/** What an image ships, from its `org.agentry.*` labels. */
export interface ImageInfo {
  runtimes: Record<string, string>
  python_packages: string[]
  tools: string[]
}

export interface StartContext {
  /** Assigned GPU uuids, [] when none. */
  gpuIds: string[]
  /** Reports setup progress (create only; a driver ignores it when it has nothing to say). */
  progress?: (p: ProgressUpdate) => void
  /** The DSH runtime ref the bootstrap will install; a driver with a template cache needs it for the cache key (no ref, no cache). */
  runtimeRef?: string
}

export interface Driver {
  kind: string
  capabilities: Capabilities
  /**
   * The Unix user the agent runs as, when it is an existing one (SSH machine: the login user).
   * The bootstrap then runs as this user instead of `agent`, creates no user or sudoers entry
   * and ignores `spec.packages`.
   */
  agentUser?: string
  /** Maps the `X-Envd-User` a caller asked for to the envd user (SSH machine: `agent` becomes the login user). */
  envdUser?(requested: string): string
  /** Extra environment for envd's `/init` (SSH machine: `CUDA_VISIBLE_DEVICES` from `handle.gpuIds`). */
  envdEnv?(handle: Handle): Record<string, string>
  /** Why a template field is not supported here (appended to the 400 naming it). */
  fieldHints?: Partial<Record<keyof TemplateSpec, string>>
  /** Cheap reachability check (no image pulls, no containers). `gpus` are those already discovered. */
  probe(): Promise<Availability & { gpus?: GpuInfo[] }>
  /** Looks for GPUs (may run a container and pull an image), remembers and returns them. Run when a place is added, not per request. */
  discoverGpus?(): Promise<GpuInfo[]>
  /** The DSH runtime for this place's own machine architecture; null when disabled. Read through the place's own daemon. */
  dshRuntime?(): Promise<{ arch: string; tar: () => Promise<Buffer> } | null>
  /** What an image ships, when the driver can tell (`undefined` for an unknown or unlabelled image). Never throws. */
  describeImage?(image: string): Promise<ImageInfo | undefined>
  /** Machine made AND envd reachable; not provisioned. Cleans up after itself when it fails. */
  create(id: string, owner: string, spec: TemplateSpec, ctx: StartContext): Promise<Handle>
  /**
   * Saves the machine's provisioned base (agent user, packages, runtime) as a reusable image, when `create` found no
   * cached one for this template (`handle.cacheKey` set, `handle.cache === 'miss'`). Never throws; the bootstrap
   * waits for it so later steps cannot leak into the image.
   */
  commitCache?(handle: Handle): Promise<void>
  /** Starts a stopped machine; envd reachable when it resolves. Returns the updated handle. */
  start(id: string, handle: Handle, spec: TemplateSpec, ctx: StartContext): Promise<Handle>
  stop(handle: Handle): Promise<void>
  /** Removes the machine; works from the id alone when the handle is empty (a create that failed half-way). */
  destroy(id: string, handle: Handle, opts: { keepWorkspace: boolean }): Promise<void>
  status(handle: Handle): Promise<'running' | 'stopped' | 'missing'>
  /** Where envd answers for a running sandbox. */
  envdEndpoint(handle: Handle): Promise<{ baseUrl: string; token?: string; /** Extra headers sent upstream on every envd request (never returned to clients). */ headers?: Record<string, string>; release?: () => void }>
  /** Every sandbox this driver manages, from its own labels (for reconciliation). */
  listManaged(): Promise<{ id: string; owner: string; handle: Handle }[]>
  /** Periodic upkeep of a running sandbox (Docker: re-apply its network rules). */
  maintain?(id: string, handle: Handle, spec: TemplateSpec): Promise<void>
  /** Frees what an owner held once their last sandbox is gone (Docker: their network). */
  releaseOwner?(owner: string): Promise<void>
  /** SSH-style drivers: the host key fingerprint (`SHA256:...`) seen when connecting without a pinned key (admin "test connection"). */
  observedHostKey?(): string | undefined
  close?(): Promise<void>
}

/** A place answered with a condition that passes (rate limit, outage, no answer): the sandbox itself is fine (HTTP 503 `place_unavailable`). */
export class TransientPlaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientPlaceError'
  }
}

/** A driver reached a host whose key differs from the pinned one (HTTP 409 `place_host_key_changed`). */
export class HostKeyChangedError extends Error {
  constructor(message = 'the host key changed') {
    super(message)
    this.name = 'HostKeyChangedError'
  }
}

/** Network placement and egress rules for sandboxes (Docker). */
export interface NetworkGuard {
  /** The network an owner's sandboxes join (created when missing). */
  networkFor(owner: string): Promise<string>
  /** (Re)applies egress rules for a running container; `network: false` blocks all egress. */
  applyFor(containerId: string, opts: { network: boolean }): Promise<void>
  /** Removes a container's own rules (on stop and destroy). */
  releaseFor(containerId: string): Promise<void>
  /** Removes an owner's network once they have no sandboxes. */
  removeOwnerNetwork?(owner: string): Promise<void>
}

/** A guard that places sandboxes on Docker's default bridge and applies no rules (tests, egress off). */
export function createPassthroughNetworkGuard(): NetworkGuard {
  return {
    async networkFor() {
      return 'bridge'
    },
    async applyFor() {},
    async releaseFor() {},
  }
}
