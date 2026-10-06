import { useEffect, useRef, type CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { POI_ICONS, poiName } from '../world/POI/pois'
import { LANDMARK_ICONS, landmarkName } from '../world/Landmarks/landmarks'
import { BIOME_NAMES } from '../world/Biomes'

const MAP_RANGE = 600 // m shown inside the compass ring; farther places sit on the rim
const MAX_PLACES = 8
/** A compass entry: a place (farm, camp…) or a landmark (giant tree, ruins, tower…). */
interface Mark { x: number; z: number; radius: number; icon: string; name: string }

/**
 * In-game HUD in the reference's style (refer/ui): party list with colour-coded health bars (top-left)
 * and a compass ring (top-right). The compass rotates via a ref in its own rAF — no React renders per frame.
 * Party = local player until multiplayer lands (skills/multiplayer).
 */
export function GameHud({ game }: { game: Game }) {
  const letters = useRef<(HTMLSpanElement | null)[]>([])
  const hpBar = useRef<HTMLDivElement>(null)
  const prompt = useRef<HTMLDivElement>(null)
  const toast = useRef<HTMLDivElement>(null)
  const lastTreasures = useRef(0)
  const toastUntil = useRef(0)
  const marks = useRef<(HTMLSpanElement | null)[]>([])
  const nearest = useRef<HTMLDivElement>(null)
  const banner = useRef<HTMLDivElement>(null)
  const speedo = useRef<HTMLDivElement>(null)
  const speedNum = useRef<HTMLSpanElement>(null)
  const nitroBar = useRef<HTMLDivElement>(null)
  const dead = useStore(game.store, (st) => st.dead)
  const fpsCap = useStore(game.store, (st) => st.fpsCap)
  useEffect(() => {
    let id = 0
    let places: Mark[] = []
    let lastQuery = -1e9
    let bannerUntil = 0
    const seen = new Set<string>()
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
        const f = game.world.fields
        const box = [pp.x - 1500, pp.z - 1500, pp.x + 1500, pp.z + 1500] as const
        places = [
          ...f.pois.inBox(...box).map((p) => ({ x: p.x, z: p.z, radius: p.radius, icon: POI_ICONS[p.type], name: poiName(p) })),
          ...f.landmarks.inBox(...box).map((l) => ({ x: l.x, z: l.z, radius: l.radius + 12, icon: LANDMARK_ICONS[l.kind], name: landmarkName(l) })),
        ]
          .sort((a, b) => Math.hypot(a.x - pp.x, a.z - pp.z) - Math.hypot(b.x - pp.x, b.z - pp.z))
          .slice(0, MAX_PLACES)
        const n = places[0]
        if (nearest.current) {
          const biome = BIOME_NAMES[f.biomes.dominant(pp.x, pp.z, pp.y)]
          nearest.current.textContent = `${biome}${n ? ` · ${n.icon} ${n.name} · ${Math.round(Math.hypot(n.x - pp.x, n.z - pp.z))} m` : ''}`
        }
        // Arrival banner (Genshin-style area name) the first time you reach a place or a landmark.
        const inside = places.find((p) => Math.hypot(p.x - pp.x, p.z - pp.z) < p.radius + 10)
        const id = inside && `${inside.x | 0},${inside.z | 0}`
        if (inside && id && !seen.has(id) && banner.current) {
          seen.add(id)
          banner.current.textContent = inside.name
          bannerUntil = now + 3500
        }
      }
      if (banner.current) banner.current.style.opacity = now < bannerUntil ? '1' : '0'
      // Speedometer + nitro (Asphalt-style, bottom centre) while driving.
      const sim = game.car.sim
      if (speedo.current) {
        const on = game.car.driving
        if (speedo.current.style.display !== (on ? 'flex' : 'none')) speedo.current.style.display = on ? 'flex' : 'none'
        if (on) {
          const kmh = `${Math.round(Math.abs(sim.speed) * 3.6)}`
          if (speedNum.current && speedNum.current.textContent !== kmh) speedNum.current.textContent = kmh
          if (nitroBar.current) {
            nitroBar.current.style.transform = `scaleX(${sim.arcade ? sim.nitro.toFixed(3) : '0'})`
            nitroBar.current.style.background = sim.nitroOn ? '#ffd24a' : sim.drifting ? '#7fe8ff' : '#3fb8ff'
          }
        }
      }
      for (let i = 0; i < MAX_PLACES; i++) {
        const p = places[i], el = marks.current[i]
        if (!p) { if (el) el.style.display = 'none'; continue }
        place(el, p.x - pp.x, p.z - pp.z, p.icon)
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
        const chest = game.caves.nearChest && !game.car.driving && !game.bike.riding
        prompt.current.style.display = car || bike || chest ? 'flex' : 'none'
        const label = prompt.current.lastChild as HTMLElement
        if (label) label.textContent = chest ? 'Open chest' : car ? 'Drive truck' : 'Mount bike'
      }
      // Treasure toast: a chest was just opened (CaveSystem.treasures went up).
      if (toast.current) {
        const n = game.caves.treasures
        if (n !== lastTreasures.current) {
          lastTreasures.current = n
          if (n > 0) (toast.current.textContent = `✦ Treasure found  ·  ${n}`), (toastUntil.current = performance.now() + 3200)
        }
        toast.current.style.opacity = performance.now() < toastUntil.current ? '1' : '0'
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
      <div ref={toast} style={toastStyle} />
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
      <div ref={speedo} style={speedoStyle}>
        <div><span ref={speedNum} style={speedNumStyle}>0</span><span style={speedUnit}>km/h</span></div>
        <div style={nitroTrack}><div ref={nitroBar} style={nitroFill} /></div>
      </div>
      {fpsCap && <div style={capStyle} data-testid="fps-cap">⚠ Your browser is limiting the game to 30 fps — turn off Low Power Mode / battery saver for 60 fps.</div>}
    </>
  )
}

const speedoStyle: CSSProperties = { position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)', display: 'none', flexDirection: 'column', alignItems: 'center', gap: 4, zIndex: 9, pointerEvents: 'none', color: '#fff', textShadow: '0 2px 6px rgba(0,0,0,0.7)', font: '800 13px system-ui, sans-serif' }
const speedNumStyle: CSSProperties = { fontSize: 34, fontStyle: 'italic', letterSpacing: -1, fontVariantNumeric: 'tabular-nums' }
const speedUnit: CSSProperties = { marginLeft: 4, opacity: 0.8 }
const nitroTrack: CSSProperties = { width: 180, height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.45)', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.35)' }
const nitroFill: CSSProperties = { width: '100%', height: '100%', transformOrigin: 'left center', background: '#3fb8ff', transform: 'scaleX(1)' }
const deathStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 20, display: 'grid', placeContent: 'center', textAlign: 'center', color: '#f2d0d0', font: '600 14px system-ui, sans-serif', background: 'radial-gradient(rgba(60,0,0,0.35), rgba(10,0,0,0.85))', pointerEvents: 'none' }
const toastStyle: CSSProperties = { position: 'fixed', left: '50%', top: '18%', transform: 'translateX(-50%)', padding: '8px 18px', borderRadius: 20, background: 'rgba(20,16,6,0.6)', color: '#ffd76a', font: '700 16px system-ui, sans-serif', letterSpacing: 2, zIndex: 9, pointerEvents: 'none', opacity: 0, transition: 'opacity 400ms' }
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
const capStyle: CSSProperties = { position: 'fixed', bottom: 64, left: '50%', transform: 'translateX(-50%)', maxWidth: '90vw', padding: '8px 14px', borderRadius: 8, background: 'rgba(20,12,4,0.78)', border: '1px solid rgba(255,190,110,0.5)', color: '#ffe2b8', font: '600 13px system-ui, sans-serif', textAlign: 'center', pointerEvents: 'none', zIndex: 9 }
const bannerStyle: CSSProperties = { position: 'fixed', top: '16%', left: 0, right: 0, textAlign: 'center', font: '700 30px Georgia, serif', letterSpacing: 3, color: '#fff8e6', textShadow: '0 2px 10px rgba(0,0,0,0.6)', opacity: 0, transition: 'opacity 600ms', pointerEvents: 'none', zIndex: 9 }
const arrow: CSSProperties = { position: 'absolute', left: 0, right: 0, top: '42%', textAlign: 'center', color: '#fff', fontSize: 14 }
