/** Sealing of small secret maps (place credentials, per-sandbox handle secrets) with AES-256-GCM. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export class SecretsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretsError'
  }
}

const key = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'agentry-sandbox', 'agentry-sandbox places', 32))

/** base64 of iv(12) | tag(16) | ciphertext. */
export function sealSecrets(secret: string, value: Record<string, string>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function openSecrets(secret: string, sealed: string): Record<string, string> {
  const buf = Buffer.from(sealed, 'base64')
  if (buf.length < 28) throw new SecretsError('sealed secrets are malformed')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secret), buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
    return JSON.parse(text) as Record<string, string>
  } catch {
    throw new SecretsError('sealed secrets could not be opened (tampered, or a different key)')
  }
}
