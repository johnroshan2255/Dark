import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import type * as THREE from 'three'
import { useGame } from '../game/GameContext'

/**
 * VSYNC CLOCK: the frame time from requestAnimationFrame's timestamp (every callback of a frame gets the same
 * vsync-aligned time), not the delta R3F measures with performance.now() inside its callback. That one jitters
 * ±0.5 ms; at 60 fps with 60 Hz physics it made the fixed step run 0 or 2 times on some frames (interpolation alpha
 * sd 0.41) — the car and the chase camera micro-stuttered (11 mm/frame² vs 0.6 for the physics itself).
 * The loop is registered at module load, before R3F's, so it runs first in each frame. Measured: tick dt sd 0.47 →
 * ~0.06 ms. Falls back to R3F's delta if no timestamp has arrived (or one is stale: a background tab).
 */
let vsyncNow = -1
if (typeof requestAnimationFrame !== 'undefined') {
  const stamp = (t: number) => {
    vsyncNow = t
    requestAnimationFrame(stamp)
  }
  requestAnimationFrame(stamp)
}

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
  const last = useRef(-1)
  useFrame((_, dt) => {
    const t = vsyncNow
    const d = last.current >= 0 && t > last.current ? (t - last.current) / 1000 : dt
    last.current = t
    game.tick(Math.abs(d - dt) < 0.05 ? d : dt)
  }, -100)
  return null
}
