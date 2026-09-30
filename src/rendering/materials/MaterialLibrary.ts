import * as THREE from 'three'
import { createGrassMaterial } from '../../world/Forest/grass'
import { SURFACE } from '../shaders/paint'
import { stylize } from '../shaders/stylize'
import { globalUniforms, GUST_GLSL, SWAY_GLSL } from '../shaders/uniforms'
import { createBrushTexture } from './BrushTexture'
import { isOverland, isStorybook } from '../artStyle'
import { createFoliageAtlas } from './FoliageAtlas'

/**
 * Camera-facing foliage TUFTS (fluffy trees): vertices with a non-zero `bbOff` are expanded around `bbCenter`
 * in view space (scaled by the instance scale), so tufts always face the camera — no CPU cost. Other
 * geometry has bbOff = 0 and is untouched. (Shadow pass: tufts render as their authored flat quads.)
 */
function billboardable(m: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 bbCenter; attribute vec2 bbOff;\nuniform float uTimeS; uniform vec2 uWindS; uniform vec2 uNearFade;\n${GUST_GLSL}\n${SWAY_GLSL}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        if (dot(bbOff, bbOff) > 0.0) {
          vec4 bc = vec4(bbCenter, 1.0);
          float bs = 1.0;
          #ifdef USE_INSTANCING
            bc.xyz = foliageSway(bc.xyz, (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz, uTimeS, uWindS); // tufts sway with their tree
            float bbNear = smoothstep(uNearFade.x, uNearFade.y, -(modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z);
            bc.xz *= bbNear; // tufts collapse to the trunk near the eye like the cards (stylize nearFade)
            bs = length(instanceMatrix[0].xyz) * bbNear;
            bc = instanceMatrix * bc;
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
 * OVERLAND boulders: about half the rocks carry a warm GOLDEN cap (sun-baked lichen tops, as in over the hill's
 * shots) — the up-facing faces of instances whose hashed id lands in the cap set blend toward ochre. Per-instance
 * hash from the instance translation → no attribute; ~8 ALU on rock fragments only.
 */
function goldCaps(m: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCap;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float up = clamp(normal.y, 0.0, 1.0);
          float id = 0.5;
          #ifdef USE_INSTANCING
            id = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
          #endif
          vCap = smoothstep(0.3, 0.85, up) * step(0.45, id) * (0.55 + 0.45 * fract(id * 7.0));
        }`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCap;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.56, 0.22), vCap * 0.85);')
  }
  m.customProgramCacheKey = () => 'rock-goldcaps'
  return m
}

/**
 * Shared materials — created once, never disposed by chunks.
 *
 * Lambert (cheapest lit material with fog + shadows) + the shared painterly patch (rim light, directional
 * fog; terrain detail/road; see shaders/stylize.ts). SMOOTH shading everywhere, rocks included (painted STONE
 * surface, shaders/paint.ts): faceted shading was the main reason the world read as "low-poly toy" instead of the painted reference.
 * Vegetation = one foliage-atlas material (alpha-tested cards + opaque solids) → one program for all trees.
 * Keep the number of distinct programs small: see skills/webgl.
 */
export class MaterialLibrary {
  readonly atlas = createFoliageAtlas(isStorybook())
  /** Hand-painted surface detail for solids and ground (shaders/paint.ts) — 0.35 MB, shared. */
  readonly brush = (globalUniforms.uBrush.value = createBrushTexture())
  readonly terrain = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'terrain', rim: 0.25, terrain: true, toon: 0.45 })
  readonly vegetation = stylize(billboardable(
    new THREE.MeshLambertMaterial({ vertexColors: true, map: this.atlas, alphaTest: 0.42, side: THREE.DoubleSide }),
  ), { key: 'foliage', rim: isOverland() ? 0.5 : 1.1, noFlip: true, surface: 'atlas', cullFade: true, nearFade: true, sway: true, wet: true })
  /** OVERLAND: soft plain-colour boulders (no stone paint strokes); otherwise smooth painted STONE. */
  readonly rock = isOverland()
    ? stylize(goldCaps(new THREE.MeshLambertMaterial({ vertexColors: true })), { key: 'rock', rim: 0.3, cullFade: true, wet: true })
    : stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'rock', rim: 0.35, surface: SURFACE.stone, cullFade: true })
  /** Smooth Lambert + wind/fade/translucency patch. */
  readonly grass = stylize(createGrassMaterial(), { key: 'grass', rim: 0.2, cheapFog: true, wet: true })
  /** Player character parts. */
  readonly character = stylize(new THREE.MeshLambertMaterial({ vertexColors: true }), { key: 'character', rim: 0.6 })
  /**
   * Street-lamp glow (propMeshes `createLampGlowGeometry`, instanced with the poles): additive, fades in with the
   * darkness; when the lamps switch on (`uLampT` = seconds since, −1 = off) each post FLICKERS to life in its own
   * time — a hashed delay of up to 2 s, then ~1.5 s of stuttering pulses, then a steady warm sodium glow with a
   * faint hum. No real lights: a halo sprite + a light pool on the road, one draw per road chunk.
   */
  readonly lampGlow = new THREE.ShaderMaterial({
    name: 'LampGlow', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uDark: { value: 0 }, uLampT: { value: -1 }, uTime: { value: 0 }, uScale: { value: 400 } },
    vertexShader: /* glsl */ `
      attribute float lampKind; attribute vec2 corner;
      uniform float uDark, uLampT, uTime;
      varying float vI; varying vec2 vC; varying float vKind;
      float lhash(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vC = corner; vKind = lampKind;
        float id = 0.5;
        #ifdef USE_INSTANCING
          id = lhash(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233)));
        #endif
        // Ignition: delay 0–2 s, then 1.5 s of stutter (on/off bursts at the post's own rhythm), then steady.
        float on = 0.0;
        if (uLampT >= 0.0) {
          float t = uLampT - id * 2.0;
          float stutter = step(0.55, lhash(floor(t * (9.0 + id * 8.0)) + id * 31.0)) * step(0.0, t);
          float steady = smoothstep(1.3, 1.6, t);
          on = mix(stutter * (0.5 + 0.5 * lhash(floor(t * 20.0) + id)), 1.0 - 0.04 * sin(uTime * 40.0 + id * 90.0), steady);
        }
        vI = on * smoothstep(0.5, 0.75, uDark);
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        vec4 mv = modelViewMatrix * wp;
        if (lampKind < 0.5) mv.xy += corner * 1.1; // camera-facing halo, 2.2 m
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vI; varying vec2 vC; varying float vKind;
      void main() {
        if (vI <= 0.001) discard;
        float d = length(vC);
        vec3 sodium = vec3(1.0, 0.72, 0.36);
        // Halo: hot core + soft skirt (HDR core → bloom). Pool: wide soft disc on the road, brighter near the post.
        float halo = smoothstep(1.0, 0.0, d); halo = halo * halo * 0.9 + smoothstep(0.35, 0.0, d) * 2.2;
        float pool = pow(smoothstep(1.0, 0.0, d), 1.6) * 0.34;
        float a = vKind < 0.5 ? halo : pool;
        gl_FragColor = vec4(sodium * a * vI, 1.0);
      }`,
  })

  /** Street lamps: darkness 0..1, seconds since switch-on (−1 = off), time. */
  setLamps(darkness: number, lampT: number, time: number): void {
    const u = this.lampGlow.uniforms
    u.uDark.value = darkness
    u.uLampT.value = lampT
    u.uTime.value = time
  }

  constructor() {
    for (const m of this.all()) m.name ||= `lib/${m.type}`
  }

  /** MSAA lets alpha-tested foliage use alpha-to-coverage (soft card edges instead of hard jaggies). */
  setAlphaToCoverage(on: boolean): void {
    if (this.vegetation.alphaToCoverage === on) return
    for (const m of [this.vegetation, ...(this.grass.alphaTest > 0 ? [this.grass] : [])]) {
      m.alphaToCoverage = on
      // A2C define: the near-camera foliage fade becomes a smooth coverage ramp instead of a dither (stylize.ts).
      m.defines = { ...m.defines, ...(on ? { A2C: 1 } : {}) }
      if (!on && m.defines) delete (m.defines as Record<string, unknown>).A2C
      m.needsUpdate = true
    }
  }

  all(): THREE.Material[] {
    return [this.terrain, this.vegetation, this.rock, this.grass, this.character, this.lampGlow]
  }

  dispose(): void {
    for (const m of this.all()) m.dispose()
    this.atlas.dispose()
    this.brush.dispose()
    this.grass.map?.dispose()
  }
}
