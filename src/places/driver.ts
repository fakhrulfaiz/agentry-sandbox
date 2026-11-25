/**
 * What runs a sandbox: one Driver per kind of place (Docker, ...). A driver
 * makes the machine and gets envd reachable; the shared bootstrap
 * (`bootstrap.ts`) then provisions it the same way for every kind.
 */
import type { GpuInfo, TemplateSpec } from '../store/types.ts'

export type Handle = Record<string, string>

export interface Capabilities {
  persistent: boolean
  reset: boolean
  isolated: boolean
  network: boolean
  resources: boolean
  gpu: boolean
  envdBuiltIn: boolean
  runsAsRoot: boolean
  templateFields: (keyof TemplateSpec)[]
}

export type Availability = { ok: true; version: string } | { ok: false; reason: string }

/** What an image ships, from its `org.agentry.*` labels. */
export interface ImageInfo {
  runtimes: Record<string, string>
  python_packages: string[]
  tools: string[]
}

export interface StartContext {
  /** Assigned GPU uuids, [] when none. */
  gpuIds: string[]
}

export interface Driver {
  kind: string
  capabilities: Capabilities
  probe(): Promise<Availability & { gpus?: GpuInfo[] }>
  /** What an image ships, when the driver can tell (`undefined` for an unknown or unlabelled image). Never throws. */
  describeImage?(image: string): Promise<ImageInfo | undefined>
  /** Machine made AND envd reachable; not provisioned. Cleans up after itself when it fails. */
  create(id: string, owner: string, spec: TemplateSpec, ctx: StartContext): Promise<Handle>
  /** Starts a stopped machine; envd reachable when it resolves. Returns the updated handle. */
  start(id: string, handle: Handle, spec: TemplateSpec, ctx: StartContext): Promise<Handle>
  stop(handle: Handle): Promise<void>
  /** Removes the machine; works from the id alone when the handle is empty (a create that failed half-way). */
  destroy(id: string, handle: Handle, opts: { keepWorkspace: boolean }): Promise<void>
  status(handle: Handle): Promise<'running' | 'stopped' | 'missing'>
  /** Where envd answers for a running sandbox. */
  envdEndpoint(handle: Handle): Promise<{ baseUrl: string; token?: string; release?: () => void }>
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
