/**
 * Service configuration, read once from the environment. A missing or invalid
 * value fails startup with a `ConfigError` that names the variable.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Quotas that stop a caller (or an agent) from creating or running too many sandboxes. */
export interface Limits {
  maxPerOwner: number
  maxRunningPerOwner: number
  maxTotal: number
  maxRunningTotal: number
  /** Creates plus resets per owner in any rolling hour. */
  maxCreatesPerHour: number
  /** Largest per-sandbox resources a template may ask for. */
  maxCpus: number
  maxMemoryMb: number
  /** Per-owner overrides of the per-owner limits. */
  owners: Record<string, Partial<Pick<Limits, 'maxPerOwner' | 'maxRunningPerOwner' | 'maxCreatesPerHour'>>>
}

export interface SandboxConfig {
  port: number
  databaseUrl: string
  /** Accepted API keys as `sha256:<64 hex>`; the plaintext key is never stored. */
  apiKeyHashes: string[]
  /** Derives each sandbox's envd access token (HMAC); at least 32 bytes. */
  secret: string
  docker: { socketPath?: string; host?: string }
  envdImage: string
  defaultImage: string
  idleStopMinutes: number
  startTimeoutMs: number
  resources: { cpus: number; memoryBytes: number; pids: number }
  /** `loopback`: envd published on 127.0.0.1 only (Docker Desktop); `ip`: the container IP (native Docker). */
  envdReach: 'loopback' | 'ip'
  runtime: 'runc' | 'runsc'
  egress: boolean
  limits: Limits
}

const KEY_HASH = /^sha256:[0-9a-f]{64}$/

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`${name} is required`)
  return value
}

function integer(env: Env, name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer ≥ ${String(min)}`)
  return n
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!(allowed as readonly string[]).includes(raw)) throw new ConfigError(`${name} must be one of ${allowed.join(', ')}`)
  return raw as T
}

const OWNER_LIMIT_KEYS = ['maxPerOwner', 'maxRunningPerOwner', 'maxCreatesPerHour'] as const

function ownerLimits(env: Env): Limits['owners'] {
  const raw = env.AGENTRY_SANDBOX_OWNER_LIMITS?.trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigError('AGENTRY_SANDBOX_OWNER_LIMITS must be JSON: {"<owner>": {"maxPerOwner": n, "maxRunningPerOwner": n, "maxCreatesPerHour": n}}')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConfigError('AGENTRY_SANDBOX_OWNER_LIMITS must be a JSON object keyed by owner')
  const out: Limits['owners'] = {}
  for (const [owner, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) throw new ConfigError(`AGENTRY_SANDBOX_OWNER_LIMITS.${owner} must be an object`)
    const entry: Limits['owners'][string] = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!(OWNER_LIMIT_KEYS as readonly string[]).includes(k)) throw new ConfigError(`AGENTRY_SANDBOX_OWNER_LIMITS.${owner}.${k} is not a known limit`)
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ConfigError(`AGENTRY_SANDBOX_OWNER_LIMITS.${owner}.${k} must be an integer ≥ 0`)
      entry[k as (typeof OWNER_LIMIT_KEYS)[number]] = v
    }
    out[owner] = entry
  }
  return out
}

export function loadConfig(env: Env): SandboxConfig {
  const databaseUrl = required(env, 'AGENTRY_SANDBOX_DATABASE_URL')
  const apiKeyHashes = required(env, 'AGENTRY_SANDBOX_API_KEYS').split(',').map((k) => k.trim()).filter(Boolean)
  if (apiKeyHashes.length === 0 || apiKeyHashes.some((k) => !KEY_HASH.test(k))) {
    throw new ConfigError('AGENTRY_SANDBOX_API_KEYS must be a comma-separated list of sha256:<64 hex>')
  }
  const secret = required(env, 'AGENTRY_SANDBOX_SECRET')
  if (Buffer.byteLength(secret) < 32) throw new ConfigError('AGENTRY_SANDBOX_SECRET must be at least 32 bytes')
  const host = env.DOCKER_HOST?.trim()
  return {
    port: integer(env, 'AGENTRY_SANDBOX_PORT', 3090),
    databaseUrl,
    apiKeyHashes,
    secret,
    docker: host ? { host } : {},
    envdImage: env.AGENTRY_SANDBOX_ENVD_IMAGE?.trim() || 'agentry/envd:envd-v0.6.13',
    defaultImage: env.AGENTRY_SANDBOX_DEFAULT_IMAGE?.trim() || 'agentry/sandbox:1',
    idleStopMinutes: integer(env, 'AGENTRY_SANDBOX_IDLE_MINUTES', 30),
    startTimeoutMs: integer(env, 'AGENTRY_SANDBOX_START_TIMEOUT_MS', 60_000),
    resources: {
      cpus: integer(env, 'AGENTRY_SANDBOX_CPUS', 2),
      memoryBytes: integer(env, 'AGENTRY_SANDBOX_MEMORY_MB', 4096) * 1024 * 1024,
      pids: integer(env, 'AGENTRY_SANDBOX_PIDS', 4096),
    },
    envdReach: oneOf(env, 'AGENTRY_SANDBOX_ENVD_REACH', ['loopback', 'ip'] as const, 'loopback'),
    runtime: oneOf(env, 'AGENTRY_SANDBOX_RUNTIME', ['runc', 'runsc'] as const, 'runc'),
    egress: oneOf(env, 'AGENTRY_SANDBOX_EGRESS', ['on', 'off'] as const, 'on') === 'on',
    limits: {
      maxPerOwner: integer(env, 'AGENTRY_SANDBOX_MAX_PER_OWNER', 5, 0),
      maxRunningPerOwner: integer(env, 'AGENTRY_SANDBOX_MAX_RUNNING_PER_OWNER', 2, 0),
      maxTotal: integer(env, 'AGENTRY_SANDBOX_MAX_TOTAL', 50, 0),
      maxRunningTotal: integer(env, 'AGENTRY_SANDBOX_MAX_RUNNING_TOTAL', 10, 0),
      maxCreatesPerHour: integer(env, 'AGENTRY_SANDBOX_MAX_CREATES_PER_HOUR', 20, 0),
      maxCpus: integer(env, 'AGENTRY_SANDBOX_MAX_CPUS', 4),
      maxMemoryMb: integer(env, 'AGENTRY_SANDBOX_MAX_MEMORY_MB', 8192, 128),
      owners: ownerLimits(env),
    },
  }
}
