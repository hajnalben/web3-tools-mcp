/**
 * WalletConnect session storage backed by Upstash Redis.
 *
 * The default store is a file, which is fine on a laptop and useless on a free-tier host:
 * the filesystem is ephemeral, so every sleep/wake would lose the pairing and ask for the
 * QR again. Everything lives in one Redis hash, which is exactly the shape WalletConnect's
 * key-value interface expects.
 *
 * Uses the REST API over plain fetch — no Redis client, no TCP, works anywhere.
 */

const HASH_KEY = 'web3-tools-mcp:walletconnect'

export interface KeyValueStorage {
  getKeys(): Promise<string[]>
  getEntries<T = unknown>(): Promise<[string, T][]>
  getItem<T = unknown>(key: string): Promise<T | undefined>
  setItem<T = unknown>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
}

class RedisKeyValueStorage implements KeyValueStorage {
  constructor(
    private url: string,
    private token: string
  ) {}

  /** Upstash takes a command as a JSON array and answers `{ result }`. */
  private async command<T>(...parts: (string | number)[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(parts)
    })

    if (!response.ok) {
      throw new Error(`Upstash request failed (${response.status}): ${await response.text()}`)
    }

    return ((await response.json()) as { result: T }).result
  }

  async getKeys(): Promise<string[]> {
    return (await this.command<string[]>('HKEYS', HASH_KEY)) ?? []
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    // HGETALL comes back as a flat [field, value, field, value, …] array.
    const flat = (await this.command<string[]>('HGETALL', HASH_KEY)) ?? []
    const entries: [string, T][] = []
    for (let i = 0; i < flat.length; i += 2) {
      const key = flat[i]
      const value = flat[i + 1]
      if (key === undefined || value === undefined) continue
      entries.push([key, JSON.parse(value) as T])
    }
    return entries
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const value = await this.command<string | null>('HGET', HASH_KEY, key)
    return value == null ? undefined : (JSON.parse(value) as T)
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.command('HSET', HASH_KEY, key, JSON.stringify(value))
  }

  async removeItem(key: string): Promise<void> {
    await this.command('HDEL', HASH_KEY, key)
  }
}

/**
 * Redis-backed storage when Upstash is configured, otherwise nothing — the caller falls
 * back to WalletConnect's own file store.
 */
export function getKeyValueStorage(): KeyValueStorage | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return undefined
  return new RedisKeyValueStorage(url, token)
}
