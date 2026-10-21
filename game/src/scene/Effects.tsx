import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'
import * as THREE from 'three'
import { useGame } from '../game/GameContext'

/**
 * Takes over rendering (useFrame priority 1 disables R3F's automatic render) and runs
 * PostPipeline: scene → MSAA HalfFloat RT → grading pass → canvas.
 */
export function Effects() {
  const game = useGame()
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)

  useLayoutEffect(() => {
    const v = gl.getDrawingBufferSize(new THREE.Vector2())
    game.post.setSize(v.x, v.y)
  }, [game, gl, size, dpr])

  useFrame(() => game.render(), 1)
  return null
}
