/** Map-backed LRU (Map preserves insertion order; re-insert on access). */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K)
  }

  get size(): number {
    return this.map.size
  }
}
