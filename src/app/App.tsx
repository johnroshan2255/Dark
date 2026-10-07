import { useEffect, useState } from 'react'
import { DebugHud } from '../debug/DebugHud'
import { Game, type GameOptions } from '../game/Game'
import { useStore } from '../game/GameState'
import { TouchControls } from '../input/TouchControls'
import { TIERS, type TierName } from '../rendering/quality/QualityTiers'
import { seedFromString } from '../world/noise/rng'
import { GameHud } from '../ui/GameHud'
import { SettingsPanel } from '../ui/SettingsPanel'
import { MainMenu } from '../ui/MainMenu'
import { Garage } from '../ui/Garage'
import { Toolbar } from '../ui/Toolbar'
import { GameCanvas } from './Canvas'
import { bootError, bootFinish, bootProgress } from './boot'
import { ART_STYLES } from '../rendering/artStyle'

/**
 * Every new game gets a fresh random world unless ?seed= is given (co-op joiners receive the host's
 * seed the same way). URL options: ?seed=<n|text> &tier=low|medium|high &adaptive=0 &hour=<0-24> &look=<style> &car=<id> &play=1 &at=cave
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
    look: ART_STYLES.find((a) => a === p.get('look')),
    car: p.get('car') ?? undefined,
    play: p.get('play') === '1',
    at: p.get('at') ?? undefined,
  }
}

export function App() {
  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let created: Game | null = null
    bootProgress(0.1, 'Starting…')
    Game.create(readOptions(), bootProgress)
      .then((g) => {
        if (cancelled) g.dispose()
        else {
          setGame((created = g))
          // Dev-only handle for console debugging / automated checks. Stripped from production builds.
          if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = g
        }
      })
      .catch((e: unknown) => {
        setError(String(e))
        bootError(String(e))
      })
    return () => {
      cancelled = true
      created?.dispose()
    }
  }, [])

  // World streaming behind the loading screen: fade it out once the ring around the player is built, the
  // ground has colliders, and a few frames have rendered (first-frame shader compiles happen under cover).
  useEffect(() => {
    if (!game) return
    const t0 = performance.now()
    let readyAt = 0
    const id = window.setInterval(() => {
      const r = game.worldReadiness()
      bootProgress(0.45 + 0.52 * r, r < 0.8 ? 'Growing a new world…' : r < 1 ? 'Raising the hills…' : 'Almost there…')
      if (r >= 1 && !readyAt) readyAt = performance.now()
      if ((readyAt && performance.now() - readyAt > 400) || performance.now() - t0 > 25_000) {
        window.clearInterval(id)
        bootFinish()
      }
    }, 100)
    return () => window.clearInterval(id)
  }, [game])

  if (error) return <Overlay>Failed to start: {error}</Overlay>
  if (!game) return null // the loading screen (index.html #boot) is showing
  return (
    <>
      <GameCanvas game={game} />
      <MainMenu game={game} />
      <Garage game={game} />
      <InGame game={game} />
      <SettingsPanel game={game} />
    </>
  )
}

/** HUD, debug overlay and controls: only once the player has pressed PLAY (the landing page owns the screen before). */
function InGame({ game }: { game: Game }) {
  const landing = useStore(game.store, (s) => s.landing)
  if (landing) return null
  return (
    <>
      <GameHud game={game} />
      <DebugHud game={game} />
      <Controls game={game} />
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
      Click to play · WASD / Shift / Space · E bike / car · L fly · ↑↓ lift · F flashlight · T day⇄night · G next time · N nightmare · V camera · O settings · F3 FPS · F4 chunks · F5 freeze culling · F6 physics
    </div>
  )
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100%', letterSpacing: 2 }}>{children}</div>
}
