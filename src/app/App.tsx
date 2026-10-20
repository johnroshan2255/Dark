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
import { MapSelect } from '../ui/MapSelect'
import { Toolbar } from '../ui/Toolbar'
import { KeyArt } from '../ui/KeyArt'
import { GameCanvas } from './Canvas'
import { bootError, bootFinish, bootProgress } from './boot'

/**
 * Every new game gets a fresh random world unless ?seed= is given (co-op joiners receive the host's
 * seed the same way). URL options: ?seed=<n|text> &tier=low|medium|high &adaptive=0 &hour=<0-24> &look=<style> &car=<id> &play=1 &at=cave
 * &stress=<ms, dev> &map=<id> (a fixed map: world/map/FixedMap.ts MAPS).
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
    car: p.get('car') ?? undefined,
    play: p.get('play') === '1',
    at: p.get('at') ?? undefined,
    map: p.get('map') ?? undefined,
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
          // Dev-only remote HUD (phones on the LAN report their frame stats to the dev server: debug/DevTelemetry).
          if (import.meta.env.DEV) void import('../debug/DevTelemetry').then((m) => m.startDevTelemetry(g))
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

  // The loading screen goes as soon as the game exists (code, physics, the truck and the stranger: ~1–2 s): the
  // MAIN MENU opens over the same key art while the world streams in behind it (not drawn — Game.render). PLAY
  // before the ground is built shows "Entering the world" (EnteringWorld) for the rest. (The menu used to wait for
  // the whole ULTRA ring + horizon: 20–30 s on a fast laptop.)
  useEffect(() => {
    if (!game) return
    bootProgress(1, 'Ready')
    const id = requestAnimationFrame(() => bootFinish())
    return () => cancelAnimationFrame(id)
  }, [game])

  if (error) return <Overlay>Failed to start: {error}</Overlay>
  if (!game) return null // the loading screen (index.html #boot) is showing
  return (
    <>
      <GameCanvas game={game} />
      <MainMenu game={game} />
      <Garage game={game} />
      <MapSelect game={game} />
      <InGame game={game} />
      <SettingsPanel game={game} />
    </>
  )
}

/** HUD, debug overlay and controls: only once the player has pressed PLAY (the landing page owns the screen before). */
function InGame({ game }: { game: Game }) {
  const landing = useStore(game.store, (s) => s.landing)
  const worldReady = useStore(game.store, (s) => s.worldReady)
  if (landing) return null
  if (!worldReady) return <EnteringWorld game={game} />
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

/** PLAY pressed before the ground round the player is built: the key art with a progress bar (polled at 10 Hz). */
function EnteringWorld({ game }: { game: Game }) {
  const [r, setR] = useState(() => game.playReadiness())
  useEffect(() => {
    const id = window.setInterval(() => setR(game.playReadiness()), 100)
    return () => window.clearInterval(id)
  }, [game])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, color: '#fff', fontFamily: 'system-ui, sans-serif' }} data-testid="entering">
      <KeyArt />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(7,8,10,.5) 0%, rgba(7,8,10,0) 30%, rgba(7,8,10,0) 55%, rgba(7,8,10,.85) 100%)' }} />
      <div style={{ position: 'absolute', left: 'max(24px, 6vw)', right: 'max(24px, 6vw)', bottom: 'max(22px, 6vh)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, letterSpacing: '.08em', marginBottom: 10 }}>
          <span>Entering the world…</span>
          <span style={{ opacity: 0.75 }}>{Math.round(r * 100)}%</span>
        </div>
        <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,.18)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(4, r * 100)}%`, borderRadius: 4, background: 'linear-gradient(90deg, #ffb86b, #ffe2a8)', transition: 'width .3s ease' }} />
        </div>
      </div>
    </div>
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
      Click to play · WASD / Shift / Space · E bike / car · O boat (driving) · L fly · ↑↓ lift · F flashlight · T day⇄night · G next time · N nightmare · V camera · O settings · F3 FPS · F4 chunks · F5 freeze culling · F6 physics
    </div>
  )
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100%', letterSpacing: 2 }}>{children}</div>
}
