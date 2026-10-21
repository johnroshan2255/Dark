import * as THREE from 'three'

/**
 * Keeps a directional light's tight ortho shadow frustum centred on the player,
 * snapped to whole shadow-map texels so shadows don't shimmer as the player moves.
 * See skills/shadows.
 */
/** Distance from the focus point to the virtual light position along the light direction (m). */
export const SHADOW_LIGHT_DISTANCE = 90

const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)

export function configureSunShadow(light: THREE.DirectionalLight, halfExtent: number, mapSize: number): void {
  light.castShadow = true
  light.shadow.mapSize.set(mapSize, mapSize)
  const cam = light.shadow.camera
  cam.left = -halfExtent
  cam.right = halfExtent
  cam.top = halfExtent
  cam.bottom = -halfExtent
  // Depth range: light sits SHADOW_LIGHT_DISTANCE up-sun of the focus; casters farther than one box beyond
  // the focus can't shadow anything visible. A 260 m range at low sun dragged whole chunk rows of terrain
  // into the shadow pass (measured +30 draws on LOW).
  cam.near = 1
  cam.far = SHADOW_LIGHT_DISTANCE + halfExtent * 1.5
  cam.updateProjectionMatrix()
  light.shadow.bias = -0.0005
  light.shadow.normalBias = 0.04
}

export function followShadow(light: THREE.DirectionalLight, focus: THREE.Vector3, dir: THREE.Vector3, distance: number): void {
  const cam = light.shadow.camera
  const texel = (cam.right - cam.left) / light.shadow.mapSize.x
  _fwd.copy(dir).negate().normalize()
  _right.crossVectors(_fwd, Math.abs(_fwd.y) > 0.99 ? _right.set(1, 0, 0) : _worldUp).normalize()
  _up.crossVectors(_right, _fwd)
  // Snap the focus point in light space (right/up axes) to the texel grid.
  const r = Math.round(focus.dot(_right) / texel) * texel
  const u = Math.round(focus.dot(_up) / texel) * texel
  const f = focus.dot(_fwd)
  light.target.position.copy(_right).multiplyScalar(r).addScaledVector(_up, u).addScaledVector(_fwd, f)
  light.position.copy(light.target.position).addScaledVector(dir, distance)
  light.target.updateMatrixWorld()
  light.updateMatrixWorld()
}
