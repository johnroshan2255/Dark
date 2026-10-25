import * as pc from 'playcanvas'
import * as THREE from 'three'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from '../../rendering/sky/skyShader'
import { globalUniforms } from '../../rendering/shaders/uniforms'
import { applyCommon, attrSemantic, type MaterialBank, type PcMat } from '../ThreeMirror'
import { pcGlsl } from './glsl'

/**
 * THREE ShaderMaterial → PLAYCANVAS ShaderMaterial, automatically: the game's custom shaders (mist sheets, lightning,
 * lamps, jets, name tags, particles…) keep their own GLSL; a prelude maps three's built-ins onto the engine's —
 *   position / normal / uv / color / instanceMatrix  → the engine's vertex streams (instancing: instance_line1..4),
 *   modelMatrix / viewMatrix / projectionMatrix / modelViewMatrix / normalMatrix / cameraPosition,
 *   #include <common> (PI, saturate…), <colorspace_fragment> (none: the engine's frame target is linear HDR),
 *   <fog_*> (the sky-coloured distance fog, as the world materials) and the fog / time uniforms.
 * Uniforms are synced from the three material's `uniforms` every frame it draws (numbers, vectors, colours, matrices,
 * textures, arrays of them).
 */

const VS_PRE = /* glsl */ `
uniform mat4 matrix_model;
uniform mat4 matrix_view;
uniform mat4 matrix_projection;
uniform mat4 matrix_viewProjection;
uniform vec3 uCamPos;
#define modelMatrix matrix_model
#define viewMatrix matrix_view
#define projectionMatrix matrix_projection
#define modelViewMatrix (matrix_view * matrix_model)
#define normalMatrix mat3(transpose(inverse(matrix_view * matrix_model)))
#define cameraPosition uCamPos
`
const FS_PRE = /* glsl */ `
uniform mat4 matrix_view;
uniform vec3 uCamPos;
uniform float fog_start;
uniform float fog_end;
#define viewMatrix matrix_view
#define cameraPosition uCamPos
`
const COMMON = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif
#define saturate(a) clamp(a, 0.0, 1.0)
float pow2(const in float x) { return x * x; }
`

const STREAMS: Record<string, string> = {
  position: pc.SEMANTIC_POSITION,
  normal: pc.SEMANTIC_NORMAL,
  uv: pc.SEMANTIC_TEXCOORD0,
  uv1: pc.SEMANTIC_TEXCOORD1,
  color: pc.SEMANTIC_COLOR,
  instance_line1: pc.SEMANTIC_ATTR11,
  instance_line2: pc.SEMANTIC_ATTR12,
  instance_line3: pc.SEMANTIC_ATTR14,
  instance_line4: pc.SEMANTIC_ATTR15,
}

const warned = new Set<string>()
const SHARED = new Set<string>([...Object.keys(globalUniforms), ...Object.keys(skyUniforms), 'uNoiseTex', 'uBrush'])
const SHARED_VALUES = new Set<unknown>([...Object.values(globalUniforms), ...Object.values(skyUniforms)])

function stripIncludes(src: string, frag: boolean, name: string, fog: boolean): string {
  return src.replace(/#include\s*<(\w+)>/g, (_m, inc: string) => {
    if (inc === 'common') return COMMON
    if (inc === 'colorspace_fragment' || inc === 'tonemapping_fragment' || inc === 'premultiplied_alpha_fragment') return ''
    if (inc === 'fog_pars_vertex' || inc === 'fog_vertex') return ''
    if (inc === 'fog_pars_fragment') return ''
    if (inc === 'fog_fragment') return frag && fog ? 'gl_FragColor.rgb = darkFog(gl_FragColor.rgb);' : ''
    if (inc === 'logdepthbuf_pars_vertex' || inc === 'logdepthbuf_vertex' || inc === 'logdepthbuf_pars_fragment' || inc === 'logdepthbuf_fragment') return ''
    if (!warned.has(name + inc)) {
      warned.add(name + inc)
      console.warn(`[pc] shader ${name}: #include <${inc}> not mapped`)
    }
    return ''
  })
}

let uid = 0

/** The engine version of a three ShaderMaterial. `vsOverride` / `fsOverride` replace its GLSL text. */
export function portShaderMaterial(src: THREE.ShaderMaterial, bank: MaterialBank, o: { vsOverride?: string; fsOverride?: string } = {}): PcMat {
  const name = src.name || src.type
  let vs = o.vsOverride ?? src.vertexShader
  let fs = o.fsOverride ?? src.fragmentShader
  const instanced = /\binstanceMatrix\b/.test(vs)
  const fog = (src as { fog?: boolean }).fog === true || /#include\s*<fog_fragment>/.test(fs)
  // streams the vertex shader reads (three declares the built-in ones itself)
  const attributes: Record<string, string> = {}
  let decl = ''
  for (const [a, sem] of Object.entries(STREAMS)) {
    if (a.startsWith('instance_')) continue
    if (new RegExp(`\\b${a}\\b`).test(vs) && !new RegExp(`attribute\\s+\\w+\\s+${a}\\b`).test(vs)) {
      const type = a === 'uv' || a === 'uv1' ? 'vec2' : a === 'color' ? 'vec3' : 'vec3'
      decl += `attribute ${type} ${a};\n`
      attributes[a] = sem
    }
  }
  if (instanced) {
    decl += 'attribute vec4 instance_line1; attribute vec4 instance_line2; attribute vec4 instance_line3; attribute vec4 instance_line4;\n#define instanceMatrix mat4(instance_line1, instance_line2, instance_line3, instance_line4)\n'
    for (const k of ['instance_line1', 'instance_line2', 'instance_line3', 'instance_line4']) attributes[k] = STREAMS[k]
  }
  // the shader's own attributes: the mirror's name → semantic registry (the geometry uploads them by the same)
  const taken = new Set<string>([pc.SEMANTIC_ATTR11, pc.SEMANTIC_ATTR12, pc.SEMANTIC_ATTR14, pc.SEMANTIC_ATTR15])
  if (attributes.uv1) taken.add(pc.SEMANTIC_ATTR6)
  for (const m of vs.matchAll(/attribute\s+\w+\s+(\w+)\s*;/g)) {
    const a = m[1]
    if (attributes[a]) continue
    const sem = STREAMS[a] ?? attrSemantic(a, taken)
    if (sem) (attributes[a] = sem), taken.add(sem)
    else if (!warned.has(name + a)) {
      warned.add(name + a)
      console.warn(`[pc] shader ${name}: attribute ${a} has no free semantic`)
    }
  }
  const defines = (instanced ? '#define USE_INSTANCING\n' : '') + Object.entries((src.defines ?? {}) as Record<string, string | number | boolean>).map(([k, v]) => `#define ${k} ${v === true ? '' : v}`).join('\n')
  vs = stripIncludes(vs, false, name, fog)
  fs = stripIncludes(fs, true, name, fog)
  // (the engine's vertex preamble already declares gl_Position etc.; precision lines are harmless)
  const fogFn = fog
    ? pcGlsl(`${SKY_GLSL}\n${MIST_GLSL}\nvarying vec3 vPortW;\nvec3 darkFog(vec3 c) { vec3 wd = vPortW - uCamPos; float d = length(wd); float f = max(smoothstep(fog_start, fog_end, d), skyHaze(d)); return mix(c, skyColor(wd / max(d, 1e-3), false), f); }\n`)
    : ''
  if (fog) {
    // world position for the fog: after the shader's own main
    vs = vs.replace(/void\s+main\s*\(\s*(void)?\s*\)\s*\{/, 'varying vec3 vPortW;\nvoid main() {\n  vPortW = (matrix_model * vec4(' + (attributes.position ? 'position' : 'vec3(0.0)') + ', 1.0)).xyz;')
  }
  const vertexGLSL = pcGlsl(`${defines}\n${VS_PRE}\n${decl}\n${vs}`)
  const fragmentGLSL = pcGlsl(`${defines}\n${FS_PRE}\n${fogFn}\n${fs}`)
  const m = new pc.ShaderMaterial({ uniqueName: `port-${name}-${uid++}`, attributes, vertexGLSL, fragmentGLSL })
  applyCommon(m, src)
  m.update()
  const scratch = new Map<string, Float32Array>()
  // (the game's SHARED uniforms — globalUniforms, skyUniforms, the noise / brush textures — are in the device scope
  //  already, pushed once a frame: a material parameter would overwrite the scope for every later draw)
  const own = Object.entries(src.uniforms).filter(([k, u]) => !SHARED.has(k) && !SHARED_VALUES.has(u))
  const sync = () => {
    for (const [k, u] of own) setUniform(m, k, u.value, scratch, bank)
  }
  sync()
  return { material: m, sync }
}

function setUniform(m: pc.Material, k: string, v: unknown, scratch: Map<string, Float32Array>, bank: MaterialBank): void {
  if (v === null || v === undefined) return
  if (typeof v === 'number') return m.setParameter(k, v)
  if (typeof v === 'boolean') return m.setParameter(k, v ? 1 : 0)
  if ((v as THREE.Texture).isTexture) {
    const t = bank.textures.get(v as THREE.Texture)
    if (t) m.setParameter(k, t)
    return
  }
  if (Array.isArray(v)) {
    if (!v.length) return
    const first = v[0]
    const n = typeof first === 'number' ? 1 : sizeOf(first)
    if (!n) return
    const a = buf(scratch, k, v.length * n)
    v.forEach((e, i) => (typeof e === 'number' ? (a[i] = e) : write(e, a, i * n)))
    return m.setParameter(`${k}[0]`, a)
  }
  const n = sizeOf(v)
  if (!n) return
  const a = buf(scratch, k, n)
  write(v, a, 0)
  m.setParameter(k, a)
}

function sizeOf(v: unknown): number {
  const o = v as Record<string, unknown>
  if (o.isColor) return 3
  if (o.isVector2) return 2
  if (o.isVector3) return 3
  if (o.isVector4 || o.isQuaternion) return 4
  if (o.isMatrix3) return 9
  if (o.isMatrix4) return 16
  return 0
}

function write(v: unknown, a: Float32Array, at: number): void {
  const o = v as { isColor?: boolean; r: number; g: number; b: number; x: number; y: number; z: number; w: number; elements?: ArrayLike<number>; isVector2?: boolean; isVector3?: boolean }
  if (o.isColor) (a[at] = o.r), (a[at + 1] = o.g), (a[at + 2] = o.b)
  else if (o.elements) a.set(o.elements as ArrayLike<number>, at)
  else {
    a[at] = o.x
    a[at + 1] = o.y
    if (!o.isVector2) a[at + 2] = o.z
    if (!o.isVector2 && !o.isVector3) a[at + 3] = o.w
  }
}

function buf(s: Map<string, Float32Array>, k: string, n: number): Float32Array {
  let a = s.get(k)
  if (!a || a.length !== n) s.set(k, (a = new Float32Array(n)))
  return a
}

void THREE
