import { useEffect, useRef, type CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { POI_ICONS, poiName, type Poi } from '../world/POI/pois'
import { BIOME_NAMES } from '../world/Biomes'

const MAP_RANGE = 600 // m shown inside the compass ring; farther places sit on the rim
const MAX_PLACES = 6

/**
 * In-game HUD in the reference's style (refer/ui): party list with colour-coded health bars (top-left)
 * and a compass ring (top-right). The compass rotates via a ref in its own rAF — no React renders per frame.
 * Party = local player until multiplayer lands (skills/multiplayer).
 */
export function GameHud({ game }: { game: Game }) {
  const letters = useRef<(HTMLSpanElement | null)[]>([])
  const hpBar = useRef<HTMLDivElement>(null)
  const prompt = useRef<HTMLDivElement>(null)
  const marks = useRef<(HTMLSpanElement | null)[]>([])
  const nearest = useRef<HTMLDivElement>(null)
  const banner = useRef<HTMLDivElement>(null)
  const dead = useStore(game.store, (st) => st.dead)
  useEffect(() => {
    let id = 0
    let places: Poi[] = []
    let lastQuery = -1e9
    let bannerUntil = 0
    const seen = new Set<Poi>()
    // Heading-up ring position of a world point (yaw 0 faces −Z = north; +X = east).
    const place = (el: HTMLSpanElement | null, dx: number, dz: number, icon?: string) => {
      if (!el) return
      const d = Math.hypot(dx, dz)
      const a = game.player.yaw + Math.atan2(dx, -dz)
      const r = 12 + 44 * Math.min(1, d / MAP_RANGE)
      el.style.display = 'block'
      el.style.opacity = d > MAP_RANGE ? '0.55' : '1'
      el.style.transform = `translate(${Math.sin(a) * r}px, ${-Math.cos(a) * r}px)`
      if (icon !== undefined && el.textContent !== icon) el.textContent = icon
    }
    const tick = () => {
      const now = performance.now()
      const pp = game.player.curr
      if (now - lastQuery > 500) {
        lastQuery = now
        places = game.world.fields.pois
          .inBox(pp.x - 1500, pp.z - 1500, pp.x + 1500, pp.z + 1500)
          .sort((a, b) => Math.hypot(a.x - pp.x, a.z - pp.z) - Math.hypot(b.x - pp.x, b.z - pp.z))
          .slice(0, MAX_PLACES)
        const n = places[0]
        if (nearest.current) {
          const biome = BIOME_NAMES[game.world.fields.biomes.dominant(pp.x, pp.z, pp.y)]
          nearest.current.textContent = `${biome}${n ? ` · ${POI_ICONS[n.type]} ${poiName(n)} · ${Math.round(Math.hypot(n.x - pp.x, n.z - pp.z))} m` : ''}`
        }
        // Arrival banner (Genshin-style area name) the first time you walk into a place.
        const inside = places.find((p) => Math.hypot(p.x - pp.x, p.z - pp.z) < p.radius + 10)
        if (inside && !seen.has(inside) && banner.current) {
          seen.add(inside)
          banner.current.textContent = poiName(inside)
          bannerUntil = now + 3500
        }
      }
      if (banner.current) banner.current.style.opacity = now < bannerUntil ? '1' : '0'
      for (let i = 0; i < MAX_PLACES; i++) {
        const p = places[i], el = marks.current[i]
        if (!p) { if (el) el.style.display = 'none'; continue }
        place(el, p.x - pp.x, p.z - pp.z, POI_ICONS[p.type])
      }
      const car = game.car.pos, bike = game.bike.root.position
      const ci = MAX_PLACES, bi = MAX_PLACES + 1
      if (game.car.driving) marks.current[ci]!.style.display = 'none'
      else place(marks.current[ci], car.x - pp.x, car.z - pp.z)
      if (game.bike.riding) marks.current[bi]!.style.display = 'none'
      else place(marks.current[bi], bike.x - pp.x, bike.z - pp.z)
      // yaw 0 faces -Z (north). Letters move around the ring; they stay upright.
      letters.current.forEach((el, i) => {
        if (!el) return
        // Heading-up: the letter you face is at the top; east is to the right when facing north.
        const a = game.player.yaw + (i * Math.PI) / 2
        el.style.transform = `translate(${Math.sin(a) * 52}px, ${-Math.cos(a) * 52}px)`
      })
      if (prompt.current) {
        // Only when standing next to a vehicle — never while inside / riding (E or the RIDE button gets you out).
        const car = game.car.near && !game.car.driving && !game.bike.riding
        const bike = game.bike.near && !game.bike.riding && !game.car.driving
        prompt.current.style.display = car || bike ? 'flex' : 'none'
        const label = prompt.current.lastChild as HTMLElement
        if (label) label.textContent = car ? 'Drive truck' : 'Mount bike'
      }
      if (hpBar.current) {
        const k = game.health.hp / game.health.max
        hpBar.current.style.width = `${k * 100}%`
        hpBar.current.style.background = k > 0.5 ? '#3aa6e8' : k > 0.25 ? '#e8a23a' : '#e83a3a'
      }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [game])
  const party = [{ name: 'You', color: '#3aa6e8', hp: 1 }]
  return (
    <>
      <div style={partyBox}>
        {party.map((p) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ ...avatar, background: p.color }}>{p.name[0]}</div>
            <div>
              <div style={nameStyle}>{p.name}</div>
              <div style={barBg}>
                <div ref={hpBar} style={{ ...barFill, width: `${p.hp * 100}%`, background: p.color, transition: 'width 120ms' }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {dead && (
        <div style={deathStyle}>
          <div style={{ fontSize: 42, letterSpacing: 8, fontWeight: 800 }}>YOU DIED</div>
          <div style={{ opacity: 0.7, marginTop: 8 }}>Waking up on the road…</div>
        </div>
      )}
      <div ref={prompt} style={promptStyle}>
        <span style={keyCap}>E</span>
        <span>Mount bike</span>
      </div>
      <div style={compass}>
        <div style={ringStyle}>
          {(['N', 'E', 'S', 'W'] as const).map((d, i) => (
            <span key={d} ref={(el) => void (letters.current[i] = el)} style={cardinal}>{d}</span>
          ))}
          {Array.from({ length: MAX_PLACES + 2 }, (_, i) => (
            <span key={`m${i}`} ref={(el) => void (marks.current[i] = el)} style={i === MAX_PLACES ? carMark : i === MAX_PLACES + 1 ? bikeMark : placeMark}>
              {i === MAX_PLACES ? '🚗' : i === MAX_PLACES + 1 ? '🚲' : ''}
            </span>
          ))}
        </div>
        <div style={arrow}>▲</div>
        <div ref={nearest} style={nearestStyle} />
      </div>
      <div ref={banner} style={bannerStyle} />
    </>
  )
}

const deathStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeContent: 'center', textAlign: 'center', color: '#f2d0d0', font: '600 14px system-ui, sans-serif', background: 'radial-gradient(rgba(60,0,0,0.35), rgba(10,0,0,0.85))', pointerEvents: 'none' }
const promptStyle: CSSProperties = { position: 'fixed', left: '50%', bottom: '22%', transform: 'translateX(-50%)', display: 'none', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 18, background: 'rgba(10,12,16,0.6)', color: '#fff', font: '600 13px system-ui, sans-serif', zIndex: 9, pointerEvents: 'none' }
const keyCap: CSSProperties = { display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 5, background: '#f1f1f1', color: '#111', fontWeight: 800 }
const partyBox: CSSProperties = { position: 'fixed', top: 14, left: 16, zIndex: 9, pointerEvents: 'none', font: '600 13px system-ui, sans-serif', color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }
const avatar: CSSProperties = { width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, border: '2px solid rgba(255,255,255,0.7)' }
const nameStyle: CSSProperties = { lineHeight: 1.1, marginBottom: 3 }
const barBg: CSSProperties = { width: 82, height: 5, borderRadius: 3, background: 'rgba(0,0,0,0.45)' }
const barFill: CSSProperties = { height: '100%', borderRadius: 3 }
const compass: CSSProperties = { position: 'fixed', top: 12, right: 16, width: 130, height: 130, zIndex: 9, pointerEvents: 'none' }
const ringStyle: CSSProperties = { position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.55)', background: 'radial-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.15))' }
const cardinal: CSSProperties = { position: 'absolute', left: '50%', top: '50%', marginLeft: -6, marginTop: -8, width: 12, textAlign: 'center', font: '700 13px system-ui, sans-serif', color: '#fff', textShadow: '0 1px 2px #000' }
const placeMark: CSSProperties = { position: 'absolute', left: '50%', top: '50%', marginLeft: -9, marginTop: -9, width: 18, height: 18, lineHeight: '18px', textAlign: 'center', fontSize: 13, display: 'none', filter: 'drop-shadow(0 1px 1px #000)' }
const carMark: CSSProperties = { ...placeMark, fontSize: 14 }
const bikeMark: CSSProperties = { ...placeMark, fontSize: 12 }
const nearestStyle: CSSProperties = { position: 'absolute', top: '100%', right: 0, marginTop: 6, whiteSpace: 'nowrap', font: '600 12px system-ui, sans-serif', color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.9)' }
const bannerStyle: CSSProperties = { position: 'fixed', top: '16%', left: 0, right: 0, textAlign: 'center', font: '700 30px Georgia, serif', letterSpacing: 3, color: '#fff8e6', textShadow: '0 2px 10px rgba(0,0,0,0.6)', opacity: 0, transition: 'opacity 600ms', pointerEvents: 'none', zIndex: 9 }
const arrow: CSSProperties = { position: 'absolute', left: 0, right: 0, top: '42%', textAlign: 'center', color: '#fff', fontSize: 14 }
