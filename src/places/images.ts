/**
 * Making sure a Docker daemon has an image before it is used: every helper
 * image (envd, the egress guard, the DSH runtime) and the sandbox image is
 * pulled on the daemon that will run it, so a fresh remote host works with
 * no setup and upgraded installs find what they need.
 */
import type Docker from 'dockerode'

export type Platform = 'linux/amd64' | 'linux/arm64'

export type EnsureImage = (image: string, platform?: Platform) => Promise<void>

const isNotFound = (e: unknown) => (e as { statusCode?: number }).statusCode === 404

const PUBLISHED = 'ghcr.io/fakhrulfaiz/'

/**
 * The earlier local tag of a published image (`ghcr.io/fakhrulfaiz/agentry-netguard:1` was
 * `agentry/netguard:1`), for installs that built the images themselves and cannot pull yet.
 */
export function legacyName(image: string): string | undefined {
  if (!image.startsWith(PUBLISHED)) return undefined
  const rest = image.slice(PUBLISHED.length)
  if (!rest.startsWith('agentry-')) return undefined
  return `agentry/${rest.slice('agentry-'.length)}`
}

/** `repo`, `tag` of an image reference (`latest` without a tag). */
function splitRef(image: string): [string, string] {
  const at = image.lastIndexOf(':')
  const slash = image.lastIndexOf('/')
  return at > slash ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest']
}

/**
 * The local name an image for a foreign platform is kept under, so that the shared tag
 * (which the local Docker driver uses without a platform) is never re-pointed:
 * `repo:tag-arm64` for `linux/arm64`.
 */
export function platformRef(image: string, platform: Platform): string {
  const [repo, tag] = splitRef(image)
  return `${repo}:${tag}-${platform.slice('linux/'.length)}`
}

/**
 * Returns a function that inspects an image on `client` and pulls it through `puller`
 * (a client without a timeout) when missing. A pull that fails falls back to tagging the
 * earlier `agentry/<name>` image when this daemon has it.
 *
 * With a `platform`, the image is guaranteed under `platformRef(image, platform)` and the shared
 * `image` tag keeps pointing at what it did (or stays absent): a pull for another architecture is
 * tagged under the platform name and the shared tag is put back.
 */
export function createEnsureImage(client: Docker, puller: Docker = client): EnsureImage {
  const inspect = async (name: string) => {
    try {
      return await client.getImage(name).inspect()
    } catch (e) {
      if (!isNotFound(e)) throw e
      return undefined
    }
  }
  const archOf = (info: { Os: string; Architecture: string }) => `${info.Os}/${info.Architecture}`
  const pullImage = async (image: string, platform?: Platform) => {
    // Without any credential helper (public images; a configured registry login would go in authconfig).
    const stream = await puller.pull(image, platform ? { platform } : {})
    await new Promise<void>((resolve, reject) => puller.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())))
  }
  const withLegacy = async (image: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (pullError) {
      const legacy = legacyName(image)
      if (legacy) {
        try {
          await client.getImage(legacy).inspect()
          const [repo, tag] = splitRef(image)
          await client.getImage(legacy).tag({ repo, tag })
          return
        } catch {
          // fall through to the pull error
        }
      }
      throw pullError
    }
  }

  return async (image, platform) => {
    if (!platform) {
      if (await inspect(image)) return
      return withLegacy(image, () => pullImage(image))
    }
    const qualified = platformRef(image, platform)
    const [qRepo, qTag] = splitRef(qualified)
    const have = await inspect(qualified)
    if (have && archOf(have) === platform) return
    const shared = await inspect(image)
    if (shared && archOf(shared) === platform) {
      await client.getImage(image).tag({ repo: qRepo, tag: qTag })
      return
    }
    // Another architecture: the pull re-points the shared tag, so put it back afterwards.
    await withLegacy(image, async () => {
      await pullImage(image, platform)
      await client.getImage(image).tag({ repo: qRepo, tag: qTag })
      const [repo, tag] = splitRef(image)
      if (shared?.Id) await client.getImage(shared.Id).tag({ repo, tag })
      else await client.getImage(image).remove({ noprune: true })
    })
  }
}
