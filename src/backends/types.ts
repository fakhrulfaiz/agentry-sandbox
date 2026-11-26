/**
 * The single-backend contract the sandbox service still calls (Task 3 replaces
 * it with the place registry), and re-exports of the driver contract.
 */
import type { Availability, Capabilities, Handle, ImageInfo } from '../places/driver.ts'
import type { TemplateSpec } from '../store/types.ts'

export type { Availability, Capabilities, Driver, Handle, ImageInfo, NetworkGuard, StartContext } from '../places/driver.ts'
export { createPassthroughNetworkGuard } from '../places/driver.ts'

export type BackendHandle = Handle
export type BackendCapabilities = Capabilities

export interface Backend {
  kind: string
  capabilities: Capabilities
  available(): Promise<Availability>
  describeImage?(image: string): Promise<ImageInfo | undefined>
  /** Makes the sandbox and provisions it; returns its handle. */
  create(id: string, owner: string, spec: TemplateSpec): Promise<Handle>
  /** Starts a stopped sandbox (provisions it if it never was); resolves when envd answers. */
  start(id: string, handle: Handle, spec: TemplateSpec): Promise<Handle>
  stop(handle: Handle): Promise<void>
  destroy(id: string, handle: Handle, opts: { keepWorkspace: boolean }): Promise<void>
  status(handle: Handle): Promise<'running' | 'stopped' | 'missing'>
  endpoint(handle: Handle): Promise<{ baseUrl: string }>
  maintain?(id: string, handle: Handle, spec: TemplateSpec): Promise<void>
  releaseOwner?(owner: string): Promise<void>
  listManaged(): Promise<{ id: string; owner: string; handle: Handle }[]>
}
