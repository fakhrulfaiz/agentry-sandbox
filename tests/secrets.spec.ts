import { describe, expect, it } from 'vitest'
import { openSecrets, SecretsError, sealSecrets } from '../src/crypto/secrets.ts'

const value = { token: 'abc', other: 'd e f' }

describe('secrets', () => {
  it('seal/open round-trips', () => {
    expect(openSecrets('k1', sealSecrets('k1', value))).toEqual(value)
  })
  it('a flipped byte throws SecretsError', () => {
    const buf = Buffer.from(sealSecrets('k1', value), 'base64')
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 1
    expect(() => openSecrets('k1', buf.toString('base64'))).toThrow(SecretsError)
  })
  it('another secret cannot open it', () => {
    expect(() => openSecrets('k2', sealSecrets('k1', value))).toThrow(SecretsError)
  })
  it('two seals of the same value differ (random iv)', () => {
    expect(sealSecrets('k1', value)).not.toBe(sealSecrets('k1', value))
  })
})
