/**
 * Небольшой Map с TTL и потолком размера. Нужен для негативных кэшей
 * («не получилось — не долбим API минуту/десять»), которые раньше жили вечно
 * и переставали пробовать до рестарта процесса.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>()

  constructor(private readonly maxEntries = 5_000) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  set(key: K, value: V, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const now = Date.now()
      for (const [k, e] of this.entries) {
        if (now >= e.expiresAt) {
          this.entries.delete(k)
        }
      }
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) {
          this.entries.delete(oldest)
        }
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  delete(key: K): void {
    this.entries.delete(key)
  }
}
