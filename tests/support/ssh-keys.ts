/**
 * ssh2 1.17's `generateKeyPairSync('ed25519')` occasionally returns a private
 * key its own `Server` refuses to parse (seen in roughly 1 of 200 generations).
 * Throwaway test keys must never decide a suite's result, so generate until
 * ssh2 accepts both halves.
 */
import type { utils } from 'ssh2'

type KeyPair = ReturnType<typeof utils.generateKeyPairSync>

export function generateSshKeyPair(sshUtils: typeof utils): KeyPair {
  for (;;) {
    const pair = sshUtils.generateKeyPairSync('ed25519')
    try {
      sshUtils.parseKey(pair.private)
      sshUtils.parseKey(pair.public)
      return pair
    } catch {
      // Try again with a fresh key.
    }
  }
}
