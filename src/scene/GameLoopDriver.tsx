import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'
import type * as THREE from 'three'
import { useGame } from '../game/GameContext'

/**
 * The only per-frame hook for simulation. Negative priority → runs before Effects (priority 1),
 * which owns rendering. All systems run inside game.tick(); nothing here touches React state.
 */
export function GameLoopDriver() {
  const game = useGame()
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const setDpr = useThree((s) => s.setDpr)

  useLayoutEffect(() => game.attach(gl, scene, camera, setDpr), [game, gl, scene, camera, setDpr])
  useFrame((_, dt) => game.tick(dt), -100)
  return null
}
