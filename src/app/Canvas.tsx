import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import type { Game } from '../game/Game'
import { GameProvider } from '../game/GameContext'
import { useStore } from '../game/GameState'
import { configureRenderer, rendererOptions } from '../rendering/renderer/configureRenderer'
import { CameraRig } from '../scene/Camera'
import { Effects } from '../scene/Effects'
import { Environment } from '../scene/Environment'
import { GameLoopDriver } from '../scene/GameLoopDriver'
import { Lighting } from '../scene/Lighting'
import { World } from '../scene/World'

/**
 * R3F canvas. `flat` + `linear` stop R3F from setting tone mapping / colour management;
 * configureRenderer() owns those. `shadows="percentage"` = PCFShadowMap (PCFSoft was removed in r18x).
 */
export function GameCanvas({ game }: { game: Game }) {
  // The DPR the game chose per quality tier (Game.applyOverrides). It must be the prop: R3F re-applies `dpr` on
  // every reconfigure (each canvas resize — rotating the phone, the URL bar hiding), so a fixed dpr={1} silently
  // reset phones to 1× (2026-10-20: a 3.25× phone played ULTRA at 1× scale 0.8 — "so blurry").
  const dpr = useStore(game.store, (s) => s.dpr)
  return (
    <Canvas
      gl={rendererOptions}
      dpr={dpr}
      flat
      shadows="percentage"
      camera={{ fov: 70, near: 0.1, far: 300 }}
      onCreated={({ gl }) => configureRenderer(gl as THREE.WebGLRenderer)}
    >
      <GameProvider game={game}>
        <GameLoopDriver />
        <CameraRig />
        <Lighting />
        <Environment />
        <World />
        <Effects />
      </GameProvider>
    </Canvas>
  )
}
