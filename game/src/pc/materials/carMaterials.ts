import * as pc from 'playcanvas'
import type * as THREE from 'three'
import { GLASS_WEATHER_BODY, GLASS_WEATHER_DECL, TRUCK_COAT_DECL, TYRE_VS, glassWeather, truckCoatBody, type TyreUniforms } from '../../gameplay/vehicle/Car'
import type { WipeGlass } from '../../gameplay/vehicle/Cockpit'
import { MIST_GLSL, SKY_GLSL } from '../../rendering/sky/skyShader'
import { applyCommon, type MaterialBank, type PcMat } from '../ThreeMirror'
import { activeLook } from '../look'
import { applyWorldLook } from './common'
import { pcGlsl } from './glsl'

/**
 * The CARS on PlayCanvas (the render bridge's converters for Car.ts's materials — their GLSL is the same text, shared
 * with the three build: TYRE_VS, TRUCK_COAT_DECL / truckCoatBody, GLASS_WEATHER_*):
 *  - PAINT ('truck'): the engine's StandardMaterial (its lights, cascaded shadows, fog chunk) with the garage paint,
 *    the TYRE SQUASH / bulge / cornering shear in the vertex stage (every pass: the shadow squashes too), the dirt,
 *    mud, sand, snow and burn coats in the albedo, the soft paint sheen; two-sided (the cab's inner walls);
 *  - GLASS ('carGlass'): unlit tinted glass with the rain beads, running drops, icy crust and the WIPERS (its own
 *    shader: no lighting, transparent, no depth write);
 * (the lamps and the jets: their own GLSL through the automatic port, materials/shaderPort).
 * The per-car uniforms are the three material's own objects (Car fills them each frame): synced per frame by `sync`.
 */

const TRUCK_TRANSFORM_CORE_VS = /* glsl */ `
attribute vec4 vertex_position;
uniform mat4 matrix_viewProjection;
uniform mat4 matrix_model;
#if defined(BATCH)
  #include "skinBatchVS"
  mat4 getModelMatrix() { return getBoneMatrix(vertex_boneIndices); }
#elif defined(INSTANCING)
  #include "transformInstancingVS"
#else
  mat4 getModelMatrix() { return matrix_model; }
#endif
attribute float tyreW;
uniform vec4 uTyre[4];
uniform float uTyreShear[4];
uniform float uTyreR;
vec3 gLocalP = vec3(0.0);
vec3 getLocalPosition(vec3 vertexPosition) {
  vec3 transformed = vertexPosition;
  ${TYRE_VS}
  gLocalP = transformed;
  return transformed;
}
`
const TRUCK_DECL_VS = /* glsl */ `
attribute float paintMask; attribute vec4 aCar;
varying float vPaint; varying float vTyre; varying vec4 vCar; varying vec3 vLocalP;
`
const TRUCK_END_VS = /* glsl */ `
  vPaint = paintMask; vTyre = tyreW; vCar = aCar; vLocalP = gLocalP;
`
function truckDeclPS(wheels: [number, number, number][], radius: number, mask: boolean): string {
  const w = wheels.map((p) => `vec3(${p[0].toFixed(3)}, ${p[1].toFixed(3)}, ${p[2].toFixed(3)})`).join(', ')
  return pcGlsl(/* glsl */ `
const vec3 CAR_WHEELS[4] = vec3[4](${w}); const float CAR_WHEEL_R = ${radius.toFixed(3)};
uniform vec3 uPaint; uniform float uCarSat; varying float vPaint; varying float vTyre; varying vec4 vCar; varying vec3 vLocalP;
${TRUCK_COAT_DECL}
${mask ? 'uniform sampler2D uPaintMask;' : ''}
#define vDirtP vPositionW
#define vDirtN dVertexNormalW
#define cameraPosition uCamPos
#define vMapUv vUv0
`)
}
const truckAlbedoPS = (mask: boolean) => /* glsl */ `
uniform vec3 material_diffuse;
void getAlbedo() {
  vec4 diffuseColor = vec4(material_diffuse, 1.0);
  #ifdef STD_DIFFUSE_TEXTURE
    diffuseColor.rgb *= {STD_DIFFUSE_TEXTURE_DECODE}(texture2DBias({STD_DIFFUSE_TEXTURE_NAME}, {STD_DIFFUSE_TEXTURE_UV}, {STD_TEXTURE_BIAS})).{STD_DIFFUSE_TEXTURE_CHANNEL};
  #endif
  #ifdef STD_DIFFUSE_VERTEX
    diffuseColor.rgb *= saturate(vVertexColor.{STD_DIFFUSE_VERTEX_CHANNEL});
  #endif
  ${truckCoatBody(mask)}
  dAlbedo = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, uCarSat);
}
`
/** the paint's soft sheen toward the key light + a little sky at grazing angles (Car.ts truckMaterial's GLOSS) */
const TRUCK_GLOSS = /* glsl */ `
  {
    vec3 Ng = litArgs_worldNormal;
    float fres = pow(1.0 - max(dot(Ng, V), 0.0), 4.0);
    float shine = uGloss * (0.1 + 0.9 * carPaint) * (1.0 - vTyre) * (1.0 - carCoat);
    vec3 g = (uKeyColor / 0.35) * pow(max(dot(Ng, normalize(uKeyDirW + V)), 0.0), 14.0) * 0.1 * smoothstep(0.0, 0.3, dot(Ng, uKeyDirW));
    g += vFogSky * fres * 0.08;
    gl_FragColor.rgb += g * shine;
  }
`

interface TruckData {
  paint: { value: THREE.Color }
  paintMask: { value: THREE.Texture | null }
  tyre: TyreUniforms
  wheelPos: [number, number, number][]
  wheelRadius: number
}

function truckMaterial(src: THREE.Material, bank: MaterialBank): PcMat {
  const d = src.userData.pc as TruckData
  const s = src as THREE.MeshLambertMaterial
  const mask = !!d.paintMask.value
  const m = new pc.StandardMaterial()
  m.name = 'carPaint'
  m.diffuse = new pc.Color(1, 1, 1)
  const map = s.map ? bank.textures.get(s.map) : null
  if (map) m.diffuseMap = map
  m.diffuseVertexColor = true
  ;(m as unknown as { vertexColorGamma: boolean }).vertexColorGamma = true
  m.twoSidedLighting = true
  applyWorldLook(m, { rim: 0.14, toon: 0.3, declVS: TRUCK_DECL_VS, mainEndVS: TRUCK_END_VS, declPS: truckDeclPS(d.wheelPos, d.wheelRadius, mask), endExtra: TRUCK_GLOSS })
  const ch = m.getShaderChunks(pc.SHADERLANGUAGE_GLSL)
  ch.set('transformCoreVS', pcGlsl(TRUCK_TRANSFORM_CORE_VS))
  ch.set('diffusePS', truckAlbedoPS(mask))
  m.setAttribute('tyreW', pc.SEMANTIC_ATTR9)
  m.setAttribute('paintMask', pc.SEMANTIC_ATTR8)
  m.setAttribute('aCar', pc.SEMANTIC_ATTR10)
  applyCommon(m, src)
  m.cull = pc.CULLFACE_NONE
  m.update()
  const tyre = new Float32Array(16), shear = new Float32Array(4), paint = new Float32Array(3), dirt = new Float32Array(3)
  const sync = () => {
    const t = d.tyre
    for (let k = 0; k < 4; k++) {
      const v = t.uTyre.value[k]
      tyre[k * 4] = v.x; tyre[k * 4 + 1] = v.y; tyre[k * 4 + 2] = v.z; tyre[k * 4 + 3] = v.w
      shear[k] = t.uTyreShear.value[k]
    }
    m.setParameter('uTyre[0]', tyre)
    m.setParameter('uTyreShear[0]', shear)
    m.setParameter('uTyreR', t.uTyreR.value)
    // (the map's look: the soft look's paint is calmer — less saturated — and always carries some road dust, its
    //  sheen dulled)
    const lk = activeLook()
    const p = d.paint.value
    paint[0] = p.r; paint[1] = p.g; paint[2] = p.b
    m.setParameter('uCarSat', lk.carSat)
    m.setParameter('uWrap', lk.carWrap) // (overrides the world's wrapped light for the paint)
    m.setParameter('uPaint', paint)
    const dc = t.uDirtCol.value
    dirt[0] = dc.r; dirt[1] = dc.g; dirt[2] = dc.b
    m.setParameter('uDirtCol', dirt)
    m.setParameter('uDirt', Math.max(lk.carDust, t.uDirt.value))
    m.setParameter('uGroundY', t.uGroundY.value)
    m.setParameter('uGloss', t.uGloss.value * lk.carGloss)
    m.setParameter('uSnowCoat', t.uSnowCoat.value)
    m.setParameter('uSandCoat', t.uSandCoat.value)
    m.setParameter('uMudCoat', t.uMudCoat.value)
    m.setParameter('uBurn', t.uBurn.value)
    if (mask) {
      const tex = bank.textures.get(d.paintMask.value!)
      if (tex) m.setParameter('uPaintMask', tex)
    }
    // (the map can change: LOW's half-size texture, a new car)
    const mp = s.map ? bank.textures.get(s.map) : null
    if (mp !== m.diffuseMap && mp) {
      m.diffuseMap = mp
      m.update()
    }
  }
  sync()
  return { material: m, sync, attrs: [{ name: 'paintMask', size: 1 }, { name: 'tyreW', size: 1 }, { name: 'aCar', size: 4 }] }
}

// ------------------------------------------------------------------------------------------------ glass

const GLASS_VS = /* glsl */ `
attribute vec3 aPosition; attribute vec3 aNormal; attribute vec3 aGlassP;
uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; uniform vec3 uCamPos;
varying vec3 vGlassN; varying vec3 vGlassV; varying vec3 vGP; varying vec3 vGNo; varying vec3 vW;
void main(void) {
  vec4 w = matrix_model * vec4(aPosition, 1.0);
  vW = w.xyz;
  vGlassN = normalize(mat3(matrix_model) * aNormal);
  vGlassV = uCamPos - w.xyz;
  vGP = aGlassP; vGNo = aNormal;
  gl_Position = matrix_viewProjection * w;
}`
const GLASS_FS = pcGlsl(/* glsl */ `
${SKY_GLSL}
${MIST_GLSL}
uniform vec3 uCamPos; uniform float fog_start; uniform float fog_end;
varying vec3 vW;
${GLASS_WEATHER_DECL}
void main(void) {
  vec4 diffuseColor = vec4(0.035, 0.05, 0.06, 0.3);
  vec3 outgoingLight = diffuseColor.rgb;
  ${GLASS_WEATHER_BODY}
  vec3 wd = vW - uCamPos; float dist = length(wd);
  float f = max(smoothstep(fog_start, fog_end, dist), skyHaze(dist));
  outgoingLight = mix(outgoingLight, skyColor(wd / max(dist, 1e-3), false), f);
  gl_FragColor = vec4(outgoingLight, diffuseColor.a);
}`)

function glassMaterial(src: THREE.Material): PcMat {
  const wipe = (src.userData.pc as { wipe: WipeGlass }).wipe
  const m = new pc.ShaderMaterial({
    uniqueName: 'darkCarGlass',
    attributes: { aPosition: pc.SEMANTIC_POSITION, aNormal: pc.SEMANTIC_NORMAL, aGlassP: pc.SEMANTIC_ATTR8 },
    vertexGLSL: GLASS_VS,
    fragmentGLSL: GLASS_FS,
  })
  m.blendType = pc.BLEND_NORMAL
  m.depthWrite = false
  m.cull = pc.CULLFACE_NONE
  m.update()
  const piv = new Float32Array(6), park = new Float32Array(6), ax = new Float32Array(3), reach = new Float32Array(4), sg = new Float32Array(2), light = new Float32Array(3)
  const sync = () => {
    const g = glassWeather
    m.setParameter('uRainG', g.uRainG.value)
    m.setParameter('uSnowG', g.uSnowG.value)
    m.setParameter('uTimeG', g.uTimeG.value)
    m.setParameter('uSpeedG', g.uSpeedG.value)
    const L = g.uLightG.value
    light[0] = L.r; light[1] = L.g; light[2] = L.b
    m.setParameter('uLightG', light)
    for (let k = 0; k < 2; k++) {
      const a = wipe.uWPiv.value[k], b = wipe.uWPark.value[k]
      piv[k * 3] = a.x; piv[k * 3 + 1] = a.y; piv[k * 3 + 2] = a.z
      park[k * 3] = b.x; park[k * 3 + 1] = b.y; park[k * 3 + 2] = b.z
    }
    m.setParameter('uWPiv[0]', piv)
    m.setParameter('uWPark[0]', park)
    const w = wipe.uWAxis.value
    ax[0] = w.x; ax[1] = w.y; ax[2] = w.z
    m.setParameter('uWAxis', ax)
    const r = wipe.uWReach.value
    reach[0] = r.x; reach[1] = r.y; reach[2] = r.z; reach[3] = r.w
    m.setParameter('uWReach', reach)
    sg[0] = wipe.uWSign.value.x; sg[1] = wipe.uWSign.value.y
    m.setParameter('uWSign', sg)
    m.setParameter('uWFrac', wipe.uWFrac.value)
    m.setParameter('uWRate', wipe.uWRate.value)
    m.setParameter('uWOff', wipe.uWOff.value)
    m.setParameter('uWOn', wipe.uWOn.value)
    m.setParameter('uWPrev', wipe.uWPrev.value)
  }
  sync()
  return { material: m, sync }
}

export function registerCarMaterials(bank: MaterialBank): void {
  bank.register('truck', (m) => truckMaterial(m, bank))
  bank.register('carGlass', (m) => glassMaterial(m))
  // (lamps, jets: their own GLSL through the automatic port — materials/shaderPort)
}
