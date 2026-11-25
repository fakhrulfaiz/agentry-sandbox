/**
 * Making sure a Docker daemon has an image before it is used: every helper
 * image (envd, the egress guard, the DSH runtime) and the sandbox image is
 * pulled on the daemon that will run it, so a fresh remote host works with
 * no setup and upgraded installs find what they need.
 */
import type Docker from 'dockerode'

export type EnsureImage = (image: string) => Promise<void>

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

/**
 * Returns a function that inspects an image on `client` and pulls it through `puller`
 * (a client without a timeout) when missing. A pull that fails falls back to tagging the
 * earlier `agentry/<name>` image when this daemon has it.
 */
export function createEnsureImage(client: Docker, puller: Docker = client): EnsureImage {
  return async (image) => {
    try {
      await client.getImage(image).inspect()
      return
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
    try {
      // Without any credential helper (public images; a configured registry login would go in authconfig).
      const stream = await puller.pull(image, {})
      await new Promise<void>((resolve, reject) => puller.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())))
      return
    } catch (pullError) {
      const legacy = legacyName(image)
      if (legacy) {
        try {
          await client.getImage(legacy).inspect()
          const at = image.lastIndexOf(':')
          const slash = image.lastIndexOf('/')
          const [repo, tag] = at > slash ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest']
          await client.getImage(legacy).tag({ repo, tag })
          return
        } catch {
          // fall through to the pull error
        }
      }
      throw pullError
    }
  }
}
