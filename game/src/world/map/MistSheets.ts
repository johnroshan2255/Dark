import * as THREE from 'three'
import type { FixedMap } from './FixedMap'
import { globalUniforms } from '../../rendering/shaders/uniforms'

/**
 * MIST SHEETS (Zhangjiajie, map.json `mistSheets`): the cloud that lies IN the gorges and cuts the towers at
 * mid-height in the photos — not a fog pass but a few horizontal, see-through sheets of drifting cloud (refs: the
 * cheap stylised / mobile trick — gradient and cloud cards instead of volumetrics).
 *
 * Each sheet is ONE quad over the whole map at a fixed height. Its fragment shader reads a small height texture of
 * the map (256², R8) and fades the cloud out where the ground rises toward the sheet — so the cloud wraps the towers
 * and thins at their walls instead of cutting them with a hard line — breaks it into drifting banks (two octaves of
 * the shared value-noise lattice, scrolled by the wind), fades it near the camera's own height (no flat wall of white
 * when you stand in it) and far away (no edge at the map border). Unlit-ish: the sky's haze colour, brighter on top.
 * Cost: 1 draw per sheet, 3 noise fetches + 1 height fetch per pixel, no depth write — the cost is OVERDRAW, so LOW
 * draws one sheet and HIGH / ULTRA three. No textures to load, ~70 KB of height data.
 */
const RES = 256

export class MistSheets {
  readonly root = new THREE.Group()
  private readonly material: THREE.ShaderMaterial
  private readonly meshes: THREE.Mesh[] = []
  private readonly heightTex: THREE.DataTexture

  constructor(map: FixedMap, sheets: { y: number; density: number }[], colour: THREE.Color) {
    this.root.name = 'mist-sheets'
    const half = map.half
    // the ground under the mist, as 0..1 of [lo, hi] (R8: ~2 m steps over ~550 m)
    const lo = -10, hi = 600
    const data = new Uint8Array(RES * RES)
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const x = -half + ((i + 0.5) / RES) * 2 * half, z = -half + ((j + 0.5) / RES) * 2 * half
        data[j * RES + i] = Math.round(Math.min(1, Math.max(0, (map.height(x, z) - lo) / (hi - lo))) * 255)
      }
    }
    this.heightTex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.UnsignedByteType)
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.LinearFilter
    this.heightTex.needsUpdate = true
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uHeight: { value: this.heightTex },
        uRange: { value: new THREE.Vector4(-half, 2 * half, lo, hi - lo) },
        uNoiseTex: globalUniforms.uNoiseTex,
        uTime: { value: 0 },
        uColour: { value: colour.clone() },
        uSheet: { value: new THREE.Vector2(0, 0) }, // y, density
        uCamY: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uHeight; uniform vec4 uRange; uniform sampler2D uNoiseTex; uniform float uTime;
        uniform vec3 uColour; uniform vec2 uSheet; uniform float uCamY;
        varying vec3 vW;
        float vn(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = texture2D(uNoiseTex, (mod(i, 256.0) + 0.5) / 256.0).r, b = texture2D(uNoiseTex, (mod(i + vec2(1.0, 0.0), 256.0) + 0.5) / 256.0).r;
          float c = texture2D(uNoiseTex, (mod(i + vec2(0.0, 1.0), 256.0) + 0.5) / 256.0).r, d = texture2D(uNoiseTex, (mod(i + vec2(1.0), 256.0) + 0.5) / 256.0).r;
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        void main() {
          vec2 uv = (vW.xz - uRange.x) / uRange.y;
          float ground = texture2D(uHeight, uv).r * uRange.w + uRange.z;
          float clear = smoothstep(uSheet.x - 4.0, uSheet.x - 45.0, ground);          // thins as the ground rises to it
          vec2 p = vW.xz * 0.006 + vec2(uTime * 0.004, uTime * 0.0025);
          float cloud = vn(p) * 0.65 + vn(p * 3.1 + 17.0 + vec2(-uTime * 0.006, 0.0)) * 0.35;
          cloud = smoothstep(0.35, 0.8, cloud);
          float near = smoothstep(4.0, 40.0, abs(uCamY - uSheet.x)) * smoothstep(20.0, 160.0, length(vW.xz - cameraPosition.xz));
          float far = 1.0 - smoothstep(1800.0, 2900.0, length(vW.xz - cameraPosition.xz));
          float a = uSheet.y * cloud * clear * near * far * step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColour * (0.92 + 0.12 * cloud), a);
          #include <colorspace_fragment>
        }`,
    })
    for (const s of sheets) {
      const g = new THREE.PlaneGeometry(2 * half, 2 * half).rotateX(-Math.PI / 2)
      const m = new THREE.Mesh(g, this.material.clone())
      ;(m.material as THREE.ShaderMaterial).uniforms.uHeight = this.material.uniforms.uHeight
      ;(m.material as THREE.ShaderMaterial).uniforms.uNoiseTex = globalUniforms.uNoiseTex
      ;(m.material as THREE.ShaderMaterial).uniforms.uSheet.value.set(s.y, s.density)
      m.position.y = s.y
      m.renderOrder = 5
      m.frustumCulled = false
      m.name = `mist-sheet.${s.y}`
      this.meshes.push(m)
      this.root.add(m)
    }
  }

  /** Per frame: drift, the camera height, how many sheets the tier draws (LOW 1). */
  update(time: number, camY: number, count: number, colour?: THREE.Color): void {
    this.meshes.forEach((m, k) => {
      const u = (m.material as THREE.ShaderMaterial).uniforms
      u.uTime.value = time
      u.uCamY.value = camY
      if (colour) u.uColour.value.copy(colour)
      m.visible = k < count
    })
  }

  dispose(): void {
    for (const m of this.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose() }
    this.material.dispose()
    this.heightTex.dispose()
  }
}
