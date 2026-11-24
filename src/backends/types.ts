/** What runs a sandbox. Docker now; any other backend implements the same contract. */
import type { TemplateSpec } from '../store/types.ts'

export type BackendHandle = Record<string, string>

export interface BackendCapabilities {
  persistent: boolean
  network: boolean
  resources: boolean
  templateFields: (keyof TemplateSpec)[]
}

export type Availability = { ok: true; version: string } | { ok: false; reason: string }

/** What an image ships, from its `org.agentry.*` labels. */
export interface ImageInfo {
  runtimes: Record<string, string>
  python_packages: string[]
  tools: string[]
}

export interface Backend {
  kind: string
  capabilities: BackendCapabilities
  available(): Promise<Availability>
  /** What an image ships, when the backend can tell (`undefined` for an unknown or unlabelled image). Never throws. */
  describeImage?(image: string): Promise<ImageInfo | undefined>
  /** Makes the sandbox and starts it once (first-start provisioning included); returns its handle. */
  create(id: string, owner: string, spec: TemplateSpec): Promise<BackendHandle>
  /** Starts a stopped sandbox (provisions it if it never was); resolves when envd answers. Returns the updated handle. */
  start(id: string, handle: BackendHandle, spec: TemplateSpec): Promise<BackendHandle>
  stop(handle: BackendHandle): Promise<void>
  /** Removes the sandbox; works from the id alone when the handle is empty (a create that failed half-way). */
  destroy(id: string, handle: BackendHandle, opts: { keepWorkspace: boolean }): Promise<void>
  status(handle: BackendHandle): Promise<'running' | 'stopped' | 'missing'>
  /** Where envd answers for a running sandbox. */
  endpoint(handle: BackendHandle): Promise<{ baseUrl: string }>
  /** Periodic upkeep of a running sandbox (Docker: re-apply its network rules). */
  maintain?(id: string, handle: BackendHandle, spec: TemplateSpec): Promise<void>
  /** Frees what an owner held once their last sandbox is gone (Docker: their network). */
  releaseOwner?(owner: string): Promise<void>
  /** Every sandbox this backend manages, from its own labels (for reconciliation). */
  listManaged(): Promise<{ id: string; owner: string; handle: BackendHandle }[]>
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
