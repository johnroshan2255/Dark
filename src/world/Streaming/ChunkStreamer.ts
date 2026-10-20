import { activeMap } from '../map/FixedMap'
import type { ChunkData } from '../types'
import { chunkKey } from '../types'
import type { ChunkRequest } from './chunk.worker'
import type { RoadExport } from '../Road/RoadNetwork'
import { groundPalette } from '../../rendering/artStyle'

interface Job {
  key: string
  cx: number
  cz: number
  priority: number
}

/**
 * Worker pool for chunk generation. Main thread never runs noise for streaming.
 * Queue is re-prioritised by distance on each pump; far jobs can be cancelled
 * before they start. Results arrive as transferred typed arrays (zero-copy).
 */
export class ChunkStreamer {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private queue: Job[] = []
  private readonly inFlight = new Map<number, Job>()
  private readonly keys = new Set<string>()
  private nextId = 1
  private dirty = false
  genMsAvg = 0
  /** Road lists a worker built with its chunk (RoadNetwork.exportNew) — the main thread's fields import them. */
  onRoads: ((roads: RoadExport) => void) | null = null

  constructor(
    private readonly seed: number,
    private readonly onChunk: (data: ChunkData) => void,
    workerCount = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)),
  ) {
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<{ id: number; data: ChunkData; roads: RoadExport | null }>) => {
        if (e.data.roads) {
          this.onRoads?.(e.data.roads)
          // …and to the OTHER workers: each built the same deterministic roads on its own (a fresh world's first
          // chunks ran the whole network's A* round the spawn three times over, side by side — 3× the CPU, ~3× slower).
          for (const o of this.workers) if (o !== w) o.postMessage({ type: 'roads', roads: e.data.roads })
        }
        this.warm = true
        this.receive(w, e.data.id, e.data.data)
      }
      w.onerror = (e) => console.error('[ChunkStreamer] worker error', e.message)
      this.workers.push(w)
      this.idle.push(w)
    }
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size
  }

  has(key: string): boolean {
    return this.keys.has(key)
  }

  request(cx: number, cz: number, priority: number): void {
    const key = chunkKey(cx, cz)
    if (this.keys.has(key)) {
      const q = this.queue.find((j) => j.key === key)
      if (q && q.priority !== priority) (q.priority = priority), (this.dirty = true)
      return
    }
    this.keys.add(key)
    this.queue.push({ key, cx, cz, priority })
    this.dirty = true
  }

  /** Drop queued (not yet started) jobs rejected by `keep`. */
  cancelWhere(keep: (cx: number, cz: number) => boolean): void {
    const before = this.queue.length
    this.queue = this.queue.filter((j) => keep(j.cx, j.cz) || (this.keys.delete(j.key), false))
    if (this.queue.length !== before) this.dirty = true
  }

  /** A first chunk has arrived (its roads went to every worker). Until then ONE job runs at a time: the others would
   *  only build the same road network again in parallel. */
  private warm = false

  pump(): void {
    if (this.dirty) {
      this.queue.sort((a, b) => b.priority - a.priority) // pop() takes highest priority = nearest
      this.dirty = false
    }
    while (this.idle.length && this.queue.length && (this.warm || this.inFlight.size === 0)) {
      const job = this.queue.pop()!
      const w = this.idle.pop()!
      const id = this.nextId++
      this.inFlight.set(id, job)
      w.postMessage({ id, seed: this.seed, palette: groundPalette(), cx: job.cx, cz: job.cz, map: activeMap() } satisfies ChunkRequest)
    }
  }

  private receive(w: Worker, id: number, data: ChunkData): void {
    const job = this.inFlight.get(id)
    this.inFlight.delete(id)
    this.idle.push(w)
    if (job) this.keys.delete(job.key)
    this.genMsAvg = this.genMsAvg * 0.9 + data.genMs * 0.1
    this.onChunk(data)
    this.pump()
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = this.idle.length = 0
    this.queue = []
    this.inFlight.clear()
    this.keys.clear()
  }
}
