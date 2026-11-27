/**
 * The template image cache (Docker places): the provisioned base of a sandbox (agent user, template packages, DSH
 * runtime) is saved once as an image and later creates from the same template start from it.
 *
 * Nothing secret goes into the image: it is committed before template files and setup commands run, template `env` is
 * given to envd's `/init` and to each command's process (never written to a file), the workspace is a volume (not part
 * of a commit), and envd's access token is derived from the service secret and the sandbox id and is never stored.
 */
import { createHash } from 'node:crypto'

/** Bump whenever `ensureAgent`, `installScript` or the order of the bootstrap steps change: it is part of every cache key. */
export const BOOTSTRAP_VERSION = '1'

export const CACHE_REPO = 'agentry-template-cache'
export const LABEL_KEY = 'org.agentry.cache.key'
export const LABEL_BASE = 'org.agentry.cache.base'

/** sha256 over the resolved base image, the sorted packages, the runtime ref and the bootstrap version. */
export function cacheKey(input: { baseImage: string; packages: string[] | undefined; runtimeRef: string }): string {
  const packages = [...new Set(input.packages ?? [])].sort()
  return createHash('sha256').update(JSON.stringify([input.baseImage, packages, input.runtimeRef, BOOTSTRAP_VERSION])).digest('hex')
}

export const cacheTag = (key: string) => `${CACHE_REPO}:${key.slice(0, 24)}`

/** The file in the image that proves the provisioned base is there (checked by the bootstrap on a hit). */
export const markerPath = (key: string) => `/opt/agentry/.bootstrap-${key.slice(0, 24)}`

export interface CacheImage {
  id: string
  /** Epoch milliseconds the image was last used (or made). */
  usedAt: number
}

/** The images to remove so that at most `max` remain, newest first kept. */
export function pruneList(images: CacheImage[], max: number): CacheImage[] {
  return [...images].sort((a, b) => b.usedAt - a.usedAt).slice(Math.max(0, max))
}
