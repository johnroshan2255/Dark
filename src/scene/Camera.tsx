import { useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'
import * as THREE from 'three'

/**
 * Configures the default R3F camera. Its pose is written every frame by Game.updateCamera
 * (from the interpolated player), not by React. `far` is set per quality tier by Game.applyQuality
 * (ring edge: nothing beyond it is loaded; fog hides the boundary).
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera)
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return
    camera.fov = 70
    camera.near = 0.1
    camera.updateProjectionMatrix()
  }, [camera])
  return null
}
