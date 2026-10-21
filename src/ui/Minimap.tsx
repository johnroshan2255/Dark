import { useEffect, useRef, type CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { MAPS } from '../world/map/FixedMap'

/** Metres across the minimap's circle (desktop / touch). */
const RANGE = 440
const RANGE_TOUCH = 360

/**
 * MINIMAP (fixed maps only, top-left under the party badge — 2026-10-21): the map's top-down image (MapInfo.minimap,
 * rendered by scripts/blender/island/map_preview.py) in a circle round you, turned with the camera like GTA's — up on
 * the minimap is where you look; the arrow in the middle is you, N rides the rim, a dot marks your car when you're on
 * foot. One CSS transform per frame from its own rAF (no React renders); the image is GPU-composited.
 * Cost: ~0.25 MB JPEG once, a transform per frame.
 */
export function Minimap({ game }: { game: Game }) {
  const map = game.map
  const info = map ? MAPS.find((m) => m.id === map.id) : undefined
  const touch = useStore(game.store, (st) => st.touch)
  const img = useRef<HTMLImageElement>(null)
  const north = useRef<HTMLDivElement>(null)
  const car = useRef<HTMLDivElement>(null)
  const size = touch ? 116 : 168
  useEffect(() => {
    if (!map || !info) return
    let id = 0
    const ppm = size / (touch ? RANGE_TOUCH : RANGE) // px per metre
    const side = 2 * map.half * ppm, R = size / 2
    if (img.current) (img.current.style.width = `${side}px`), (img.current.style.height = `${side}px`)
    const tick = () => {
      const p = game.car.driving ? game.car.pos : game.player.curr
      const yaw = game.player.yaw // camera yaw (the compass strip uses it too): up on the map = the view direction
      if (img.current) img.current.style.transform = `translate(${R}px, ${R}px) rotate(${yaw}rad) translate(${-(p.x + map.half) * ppm}px, ${-(p.z + map.half) * ppm}px)`
      const s = Math.sin(yaw), c = Math.cos(yaw), rim = R - 9
      if (north.current) north.current.style.transform = `translate(${s * rim}px, ${-c * rim}px)`
      if (car.current) {
        const on = !game.car.driving
        car.current.style.display = on ? 'block' : 'none'
        if (on) {
          // rotate the car's offset like the map (image x → x, z → y), clamp it to the rim
          const dx = (game.car.pos.x - p.x) * ppm, dy = (game.car.pos.z - p.z) * ppm
          let rx = c * dx - s * dy, ry = s * dx + c * dy
          const d = Math.hypot(rx, ry)
          if (d > R - 8) (rx *= (R - 8) / d), (ry *= (R - 8) / d)
          car.current.style.transform = `translate(${rx}px, ${ry}px)`
        }
      }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [game, map, info, size, touch])
  if (!map || !info) return null
  return (
    <div style={{ ...box, width: size, height: size }} data-testid="minimap">
      <img ref={img} src={info.minimap} alt="" style={mapImg} draggable={false} />
      <div style={{ ...centre }}>
        <svg width="16" height="18" viewBox="0 0 16 18" style={{ position: 'absolute', left: -8, top: -9, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }}>
          <path d="M8 1 L15 16 L8 12.5 L1 16 Z" fill="#fff" stroke="#1d2433" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <div ref={car} style={carDot} />
        <div ref={north} style={northStyle}>N</div>
      </div>
      <div style={ring} />
    </div>
  )
}

const box: CSSProperties = { position: 'fixed', top: 62, left: 16, borderRadius: '50%', overflow: 'hidden', zIndex: 9, pointerEvents: 'none', background: '#2a86b3', boxShadow: '0 4px 14px rgba(0,0,0,0.45)' }
const mapImg: CSSProperties = { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', willChange: 'transform', userSelect: 'none' }
const centre: CSSProperties = { position: 'absolute', left: '50%', top: '50%', width: 0, height: 0 }
const ring: CSSProperties = { position: 'absolute', inset: 0, borderRadius: '50%', border: '3px solid rgba(255,248,232,0.9)', boxShadow: 'inset 0 0 12px rgba(0,0,0,0.35)' }
const northStyle: CSSProperties = { position: 'absolute', left: -8, top: -8, width: 16, height: 16, borderRadius: 8, background: '#1d2433', color: '#fff', font: '800 10px/16px system-ui, sans-serif', textAlign: 'center' }
const carDot: CSSProperties = { position: 'absolute', left: -5, top: -5, width: 10, height: 10, borderRadius: 5, background: '#ffb03a', border: '2px solid #1d2433', display: 'none' }
