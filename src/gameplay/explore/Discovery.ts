/**
 * DISCOVERY — the exploration loop around the summit LOOKOUTS (world/POI/pois.ts PoiType.Lookout):
 *  - every lookout shows on the compass from up to LOOKOUT_SEEN m away (a flag on a peak: always a goal in view);
 *  - other places only within PLACE_SEEN m, or anywhere a discovered lookout REVEALS (≤ REVEAL m from it) — so
 *    climbing a peak maps the land around it;
 *  - the discovered lookouts persist per world seed (localStorage: a per-player convenience; the world itself is the
 *    seed's, so a lookout's key is its position).
 * Plain TS, read by the HUD every 0.5 s; no per-frame cost.
 */
export const LOOKOUT_SEEN = 2500
export const PLACE_SEEN = 600
export const REVEAL = 1500

export class Discovery {
  private readonly found: [number, number][] = []
  private readonly key: string

  constructor(seed: number) {
    this.key = `dark.viewpoints.${seed}`
    try {
      const raw = localStorage.getItem(this.key)
      const list = raw ? (JSON.parse(raw) as [number, number][]) : []
      if (Array.isArray(list)) for (const p of list) if (Array.isArray(p) && p.length === 2) this.found.push([+p[0], +p[1]])
    } catch {
      // (private window / blocked storage: discoveries last for this session only)
    }
  }

  /** Lookouts discovered in this world. */
  get count(): number {
    return this.found.length
  }

  has(x: number, z: number): boolean {
    return this.found.some(([a, b]) => Math.abs(a - x) < 1 && Math.abs(b - z) < 1)
  }

  /** Mark the lookout at (x, z) discovered; false if it already was. */
  add(x: number, z: number): boolean {
    if (this.has(x, z)) return false
    this.found.push([Math.round(x), Math.round(z)])
    try {
      localStorage.setItem(this.key, JSON.stringify(this.found))
    } catch {
      // (storage full / blocked: kept in memory)
    }
    return true
  }

  /** Is (x, z) mapped by a discovered lookout? */
  revealed(x: number, z: number): boolean {
    return this.found.some(([a, b]) => Math.hypot(a - x, b - z) < REVEAL)
  }
}
