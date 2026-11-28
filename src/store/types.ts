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
  /** Where the workspace is mounted inside the sandbox (set per sandbox at create; default /workspace). */
  workspacePath?: string
  /** Id of the place to run in (default place when absent). */
  place?: string
  /** GPUs to give the sandbox: a count, or every GPU of the place. */
  gpus?: number | 'all'
}

/** Where a provisioning sandbox is in its setup. `step`, `steps` and `detail` are set for `running_setup` only. */
export type ProgressStage = 'pulling_image' | 'starting' | 'preparing' | 'installing_packages' | 'copying_runtime' | 'writing_files' | 'running_setup' | 'finishing'

export interface ProgressUpdate {
  stage: ProgressStage
  step?: number
  steps?: number
  /** The setup command, cut to 120 characters (never env values). */
  detail?: string
}

export interface Progress extends ProgressUpdate {
  /** Epoch milliseconds. */
  updatedAt: number
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
  /** Sealed (encrypted) backend secrets for this sandbox. */
  handleSecrets: string | null
  error: string | null
  /** Set while `state` is `provisioning`; null otherwise. */
  progress: Progress | null
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

export interface GpuInfo {
  index: number
  uuid: string
  name: string
}

export interface PlaceRecord {
  id: string
  name: string
  kind: string
  config: Record<string, unknown>
  /** Sealed (encrypted) credentials. */
  secrets: string | null
  enabled: boolean
  isDefault: boolean
  maxRunning: number | null
  gpus: GpuInfo[] | null
  createdAt: number
  updatedAt: number
}

export type PlacePatch = Partial<Omit<PlaceRecord, 'id' | 'createdAt'>>

export type SnapshotLevel = 'workspace' | 'disk' | 'memory'
export type SnapshotState = 'saving' | 'ready' | 'failed'

/** A saved copy of a sandbox at one moment; kept after the sandbox is deleted. */
export interface SnapshotRecord {
  id: string
  owner: string
  /** The sandbox it was taken from (kept after that sandbox is deleted). */
  sandboxId: string
  /** Id of the place the bytes live on, or `service` for the generic store (a file on the service host). */
  place: string
  level: SnapshotLevel
  name: string
  state: SnapshotState
  /** The driver's (or the generic store's) record of where it is: volume, image, provider snapshot id, file name. */
  handle: Record<string, string>
  /** Sealed (encrypted) provider secrets for this snapshot. */
  handleSecrets: string | null
  sizeBytes: number | null
  error: string | null
  /** Epoch milliseconds. */
  createdAt: number
  expiresAt: number | null
}

export type SnapshotPatch = Partial<Pick<SnapshotRecord, 'name' | 'state' | 'handle' | 'handleSecrets' | 'sizeBytes' | 'error' | 'expiresAt'>>

export type SandboxPatch = Partial<Pick<SandboxRecord, 'name' | 'template' | 'state' | 'handle' | 'handleSecrets' | 'error' | 'progress' | 'startedAt' | 'lastUsedAt'>>
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
  snapshots: {
    insert(r: SnapshotRecord): Promise<void>
    get(id: string, owner: string): Promise<SnapshotRecord | undefined>
    /** Any owner's snapshot; only for internal bookkeeping (the expiry sweep, deleting a place's leftovers). */
    getAny(id: string): Promise<SnapshotRecord | undefined>
    /** One owner's snapshots, oldest first; `sandboxId` narrows to those taken from one sandbox. */
    list(owner: string, opts?: { sandboxId?: string }): Promise<SnapshotRecord[]>
    update(id: string, owner: string, patch: SnapshotPatch): Promise<SnapshotRecord | undefined>
    delete(id: string, owner: string): Promise<boolean>
    /** Every owner's snapshots (admin). */
    listAll(): Promise<SnapshotRecord[]>
    /** Snapshots whose `expiresAt` is at or before `at`, any owner. */
    listExpired(at: number): Promise<SnapshotRecord[]>
  }
  places: {
    list(): Promise<PlaceRecord[]>
    get(id: string): Promise<PlaceRecord | undefined>
    /** Inserting with isDefault clears any other default in the same call. */
    insert(r: PlaceRecord): Promise<void>
    /** Setting isDefault true clears any other default in the same call. */
    update(id: string, patch: PlacePatch): Promise<PlaceRecord | undefined>
    delete(id: string): Promise<boolean>
  }
  /** Service-wide settings (JSON per key), for runtime changes such as the admin page's limits. */
  settings: {
    get(key: string): Promise<unknown>
    /** `undefined` removes the key. */
    set(key: string, value: unknown): Promise<void>
  }
  close(): Promise<void>
}
