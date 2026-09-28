import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import type { Game } from '../game/Game'
import { GameProvider } from '../game/GameContext'
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
  return (
    <Canvas
      gl={rendererOptions}
      dpr={1} // real DPR is set per quality tier by Game.applyQuality (QualitySettings.maxDpr)
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
