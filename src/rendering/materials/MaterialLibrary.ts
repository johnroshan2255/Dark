import * as THREE from 'three'
import { createGrassMaterial } from '../../world/Forest/grass'
import { stylize } from '../shaders/stylize'
import { createFoliageAtlas } from './FoliageAtlas'

/**
 * Camera-facing foliage TUFTS (fluffy trees): vertices with a non-zero `bbOff` are expanded around `bbCenter`
 * in view space (scaled by the instance scale), so tufts always face the camera — no CPU cost. Other
 * geometry has bbOff = 0 and is untouched. (Shadow pass: tufts render as their authored flat quads.)
 */
function billboardable(m: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 bbCenter; attribute vec2 bbOff;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        if (dot(bbOff, bbOff) > 0.0) {
          vec4 bc = vec4(bbCenter, 1.0);
          float bs = 1.0;
          #ifdef USE_INSTANCING
            bc = instanceMatrix * bc;
            bs = length(instanceMatrix[0].xyz);
          #endif
          mvPosition = modelViewMatrix * bc;
          mvPosition.xy += bbOff * bs;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      )
  }
  m.customProgramCacheKey = () => 'billboard-tufts'
  return m
}

/**
 * Shared materials — created once, never disposed by chunks.
 *
 * Lambert (cheapest lit material with fog + shadows) + the shared painterly patch (rim light, directional
 * fog; terrain detail/road; see shaders/stylize.ts). SMOOTH shading everywhere except rocks: faceted
 * shading was the main reason the world read as "low-poly toy" instead of the painted reference.
 * Vegetation = one foliage-atlas material (alpha-tested cards + opaque solids) → one program for all trees.
 * Keep the number of distinct programs small: see skills/webgl.
 */
export class MaterialLibrary {
  readonly atlas = createFoliageAtlas()
  readonly terrain = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'terrain', rim: 0.25, terrain: true, toon: 0.45 })
  readonly vegetation = stylize(billboardable(
    new THREE.MeshLambertMaterial({ vertexColors: true, map: this.atlas, alphaTest: 0.42, side: THREE.DoubleSide }),
  ), { key: 'foliage', rim: 1.1, noFlip: true })
  readonly rock = stylize(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { key: 'rock', rim: 0.35 })
  /** Smooth Lambert + wind/fade/translucency patch. */
  readonly grass = stylize(createGrassMaterial(), { key: 'grass', rim: 0.2, cheapFog: true })
  /** Player character parts. */
  readonly character = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'character', rim: 0.6 })

  constructor() {
    for (const m of this.all()) m.name ||= `lib/${m.type}`
  }

  /** MSAA lets alpha-tested foliage use alpha-to-coverage (soft card edges instead of hard jaggies). */
  setAlphaToCoverage(on: boolean): void {
    if (this.vegetation.alphaToCoverage === on) return
    this.vegetation.alphaToCoverage = on
    this.vegetation.needsUpdate = true
  }

  all(): THREE.Material[] {
    return [this.terrain, this.vegetation, this.rock, this.grass, this.character]
  }

  dispose(): void {
    for (const m of this.all()) m.dispose()
    this.atlas.dispose()
  }
}
