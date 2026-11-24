import { createHmac } from 'node:crypto'

/**
 * A sandbox's envd access token: HMAC-SHA256 of its id under the service
 * secret. Derived on demand, never stored, so a database leak reveals none.
 */
export function envdToken(secret: string, sandboxId: string): string {
  return createHmac('sha256', secret).update(sandboxId).digest('hex')
}
