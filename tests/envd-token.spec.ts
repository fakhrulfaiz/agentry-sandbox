import { describe, expect, it } from 'vitest'
import { envdToken } from '../src/envd/token.ts'

const SECRET = 's'.repeat(32)

describe('envdToken', () => {
  it('is a stable 64-hex HMAC per sandbox', () => {
    const a = envdToken(SECRET, 'sbx_1')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(envdToken(SECRET, 'sbx_1')).toBe(a)
    expect(envdToken(SECRET, 'sbx_2')).not.toBe(a)
    expect(envdToken('t'.repeat(32), 'sbx_1')).not.toBe(a)
  })
  it('never equals the id or the secret', () => {
    const t = envdToken(SECRET, 'sbx_1')
    expect(t).not.toBe('sbx_1')
    expect(t).not.toBe(SECRET)
  })
})
