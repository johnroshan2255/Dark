import { useEffect, useState } from 'react'
import { DebugHud } from '../debug/DebugHud'
import { Game, type GameOptions } from '../game/Game'
import { useStore } from '../game/GameState'
import { TouchControls } from '../input/TouchControls'
import { TIERS, type TierName } from '../rendering/quality/QualityTiers'
import { seedFromString } from '../world/noise/rng'
import { GameHud } from '../ui/GameHud'
import { SettingsPanel } from '../ui/SettingsPanel'
import { Toolbar } from '../ui/Toolbar'
import { GameCanvas } from './Canvas'

/**
 * Every new game gets a fresh random world unless ?seed= is given (co-op joiners receive the host's
 * seed the same way). URL options: ?seed=<n|text> &tier=low|medium|high &adaptive=0 &hour=<0-24> &look=bright|storybook
 * &stress=<ms, dev>.
 */
function readOptions(): GameOptions {
  const p = new URLSearchParams(location.search)
  const s = p.get('seed')
  const seed = s ? (/^\d+$/.test(s) ? Number(s) >>> 0 : seedFromString(s)) : crypto.getRandomValues(new Uint32Array(1))[0]
  const t = p.get('tier')
  return {
    seed,
    tier: t && (TIERS as readonly string[]).includes(t) ? (t as TierName) : 'auto',
    adaptive: p.get('adaptive') !== '0',
    stressMs: Number(p.get('stress')) || 0,
    hour: p.get('hour') !== null ? Number(p.get('hour')) : undefined,
    look: p.get('look') === 'storybook' ? 'storybook' : p.get('look') === 'bright' ? 'bright' : undefined,
  }
}

export function App() {
  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let created: Game | null = null
    Game.create(readOptions())
      .then((g) => {
        if (cancelled) g.dispose()
        else {
          setGame((created = g))
          // Dev-only handle for console debugging / automated checks. Stripped from production builds.
          if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = g
        }
      })
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
      created?.dispose()
    }
  }, [])

  if (error) return <Overlay>Failed to start: {error}</Overlay>
  if (!game) return <Overlay>Loading…</Overlay>
  return (
    <>
      <GameCanvas game={game} />
      <GameHud game={game} />
      <DebugHud game={game} />
      <Controls game={game} />
      <SettingsPanel game={game} />
    </>
  )
}

function Controls({ game }: { game: Game }) {
  const touch = useStore(game.store, (s) => s.touch)
  return touch ? (
    <>
      <TouchControls game={game} />
      <RotateHint />
    </>
  ) : (
    <>
      <Toolbar game={game} />
      <LockHint game={game} />
    </>
  )
}

/** Portrait on a phone works, but landscape is the intended view. Non-blocking hint. */
function RotateHint() {
  const [portrait, setPortrait] = useState(() => matchMedia('(orientation: portrait)').matches)
  useEffect(() => {
    const mq = matchMedia('(orientation: portrait)')
    const on = () => setPortrait(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  if (!portrait) return null
  return (
    <div style={{ position: 'fixed', top: '40%', width: '100%', textAlign: 'center', pointerEvents: 'none', fontSize: 14, opacity: 0.85, zIndex: 6 }}>
      ⟳ Rotate to landscape for the best view
    </div>
  )
}

function LockHint({ game }: { game: Game }) {
  const locked = useStore(game.store, (s) => s.pointerLocked)
  if (locked) return null
  return (
    <div style={{ position: 'fixed', bottom: 24, width: '100%', textAlign: 'center', pointerEvents: 'none', fontSize: 13, opacity: 0.8 }}>
      Click to play · WASD / Shift / Space · E bike / car · F flashlight · T day⇄night · G next time · N nightmare · V camera · O settings · F3 FPS · F4 chunks · F5 freeze culling · F6 physics
    </div>
  )
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100%', letterSpacing: 2 }}>{children}</div>
}
