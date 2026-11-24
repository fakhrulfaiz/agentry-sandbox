/** Prints the `sha256:<hex>` form of an API key for AGENTRY_SANDBOX_API_KEYS. Usage: tsx scripts/hash-key.ts <key> */
import { createHash } from 'node:crypto'

const key = process.argv[2]
if (!key) {
  console.error('usage: tsx scripts/hash-key.ts <key>')
  process.exit(2)
}
console.log(`sha256:${createHash('sha256').update(key).digest('hex')}`)
