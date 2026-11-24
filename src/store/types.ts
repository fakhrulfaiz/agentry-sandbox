/** Records the service keeps, and the store contract both backends implement. */

export type SandboxState = 'provisioning' | 'running' | 'stopped' | 'failed' | 'deleting'

export interface TemplateSpec {
  image?: string
  packages?: string[]
  setupCommands?: string[]
  env?: Record<string, string>
  /** false: no egress at all. Default true. */
  network?: boolean
  files?: { path: string; content: string }[]
  resources?: Partial<{ cpus: number; memoryMb: number }>
}

export interface SandboxRecord {
  id: string
  owner: string
  name: string
  backend: string
  /** Snapshot of the template the sandbox was made from. */
  template: TemplateSpec
  templateId: string | null
  state: SandboxState
  /** Backend handle (container id, volume, network…). */
  handle: Record<string, string>
  error: string | null
  /** Epoch milliseconds. */
  createdAt: number
  startedAt: number | null
  lastUsedAt: number | null
}

export interface TemplateRecord {
  id: string
  owner: string
  name: string
  spec: TemplateSpec
  createdAt: number
  updatedAt: number
}

export type SandboxPatch = Partial<Pick<SandboxRecord, 'name' | 'template' | 'state' | 'handle' | 'error' | 'startedAt' | 'lastUsedAt'>>
export type TemplatePatch = Partial<Pick<TemplateRecord, 'name' | 'spec' | 'updatedAt'>>

export interface Store {
  sandboxes: {
    insert(r: SandboxRecord): Promise<void>
    get(id: string, owner: string): Promise<SandboxRecord | undefined>
    /** Any owner's sandbox; only for internal bookkeeping (reconciliation, the idle sweep). */
    getAny(id: string): Promise<SandboxRecord | undefined>
    list(owner: string): Promise<SandboxRecord[]>
    update(id: string, owner: string, patch: SandboxPatch): Promise<SandboxRecord | undefined>
    delete(id: string, owner: string): Promise<boolean>
    listAll(): Promise<SandboxRecord[]>
  }
  templates: {
    insert(r: TemplateRecord): Promise<void>
    get(id: string, owner: string): Promise<TemplateRecord | undefined>
    list(owner: string): Promise<TemplateRecord[]>
    update(id: string, owner: string, patch: TemplatePatch): Promise<TemplateRecord | undefined>
    delete(id: string, owner: string): Promise<boolean>
  }
  close(): Promise<void>
}
