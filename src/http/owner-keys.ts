/**
 * Owner-bound access keys: a person or tool (Claude Code, another MCP client) gets a key tied to one owner,
 * unlike the service-wide API keys, which let the Agentry API name any owner. Created on the admin page,
 * shown once, stored only as a SHA-256 hash (in the `owner_keys` setting), and revocable.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Store } from '../store/types.ts'

export interface OwnerKeyRecord {
  id: string
  name: string
  owner: string
  /** Hex SHA-256 of the full key. */
  hash: string
  createdAt: number
}

/** The wire form of a key (never its hash). */
export const keyToWire = (r: OwnerKeyRecord) => ({ id: r.id, object: 'owner_key', name: r.name, owner: r.owner, created_at: r.createdAt })

const SETTING = 'owner_keys'
export const KEY_PREFIX = 'ask_'
const sha = (key: string) => createHash('sha256').update(key).digest('hex')

export function createOwnerKeys(store: Store) {
  let cache: OwnerKeyRecord[] | undefined
  const load = async (): Promise<OwnerKeyRecord[]> => (cache ??= ((await store.settings.get(SETTING)) as OwnerKeyRecord[] | undefined) ?? [])
  const save = async (next: OwnerKeyRecord[]): Promise<void> => {
    await store.settings.set(SETTING, next.length > 0 ? next : undefined)
    cache = next
  }
  return {
    list: load,
    /** Makes a key; the plaintext is returned here and nowhere else. */
    async create(name: string, owner: string): Promise<{ record: OwnerKeyRecord; key: string }> {
      const key = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`
      const record: OwnerKeyRecord = { id: `okey_${randomUUID().replaceAll('-', '').slice(0, 16)}`, name, owner, hash: sha(key), createdAt: Math.floor(Date.now() / 1000) }
      await save([...(await load()), record])
      return { record, key }
    },
    async revoke(id: string): Promise<boolean> {
      const all = await load()
      if (!all.some((r) => r.id === id)) return false
      await save(all.filter((r) => r.id !== id))
      return true
    },
    /** The owner a presented key belongs to, or undefined. */
    async ownerOf(key: string): Promise<string | undefined> {
      if (!key.startsWith(KEY_PREFIX)) return undefined
      const hash = sha(key)
      return (await load()).find((r) => r.hash === hash)?.owner
    },
  }
}

export type OwnerKeys = ReturnType<typeof createOwnerKeys>
