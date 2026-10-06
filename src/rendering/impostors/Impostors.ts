import * as THREE from 'three'
import { globalUniforms, GUST_GLSL, SWAY_GLSL } from '../shaders/uniforms'
import { stylize } from '../shaders/stylize'
import { isGenshin, isOverland } from '../artStyle'

/**
 * OCTAHEDRAL IMPOSTORS for distant trees (the technique of Fortnite / Genshin-class open worlds):
 *
 * BAKE (once at load, ~30–80 ms GPU): each tree species' full-detail geometry is rendered with an orthographic
 * camera from FRAMES² directions spread over the upper hemisphere by the HEMI-OCTAHEDRAL map (the square
 * [-1,1]² folded onto the hemisphere: centre = straight down from above, the square's rim = the horizon), into
 * one cell each of a shared atlas (≤ 16 species in a 4×4 grid of FRAMES×FRAMES cells). Unlit albedo only (the
 * world lighting is applied at runtime), alpha = 1 leaves / 0.5 bark / 0 empty (so the per-tree autumn / stand
 * hues tint leaves but not trunks); empty texels are dilated with their neighbours' colour so mipmaps and
 * bilinear filtering never bleed black.
 *
 * DRAW: one camera-facing card per tree (2 triangles, instanced, one draw per chunk / far-forest block for all
 * species). The vertex shader turns the view direction into the tree's own frame (its random yaw), finds it on
 * the hemi-octahedral grid and blends the 3 nearest baked views (barycentric; 1 view on LOW) — the tree turns
 * smoothly as you walk around it, its silhouette and lit side stay right. Lighting: Lambert + the shared
 * painterly `stylize` patch (rim light, cel ramp, sky-coloured fog, height mist, snow cover, wet) on a crown-
 * volume normal (the same trick the real trees use for their canopies) — so day/night, fog and snow match the
 * meshes they replace. Per-tree dither crossfade with the low-poly mesh (uTreeLod), far-edge dissolve (uImpFar).
 *
 * Cost: atlas 1024² (LOW, 5.6 MB with mips) / 2048² (22 MB); per tree 4 vertices; per fragment 1–3 texture reads
 * + Lambert. A tree at 150 m covers ~200 px on a 720p screen.
 */
export const FRAMES = 8
const GRID = 4 // species slots per atlas side

export interface ImpostorAtlas {
  texture: THREE.Texture
  /** The render target holding it (debug read-back). */
  target: THREE.WebGLRenderTarget
  /** Slot uniforms (per species id): atlas origin u, v, cell size (uv) — and the card box: crown-centre height,
   *  half height (sphere radius), half width (horizontal radius), all at instance scale 1. */
  slots: THREE.Vector4[]
  boxes: THREE.Vector4[]
  /** Species id → slot index (−1 = not baked). */
  slotOf: Int8Array
  dispose(): void
}

/** Hemi-octahedral square point (u, v ∈ [-1, 1]) → unit direction with y ≥ 0. */
export function hemiOctDir(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const x = (u + v) / 2, z = (u - v) / 2
  return out.set(x, 1 - Math.abs(x) - Math.abs(z), z).normalize()
}

/** GLSL: direction (y ≥ 0) → hemi-octahedral square point. Inverse of `hemiOctDir`. */
const HEMI_OCT_GLSL = /* glsl */ `
vec2 hemiOct(vec3 d) { d /= (abs(d.x) + abs(d.y) + abs(d.z)); return vec2(d.x + d.z, d.x - d.z); }`

/** Bounds of a tree geometry incl. its camera-facing tufts (bbCenter ± |bbOff|): crown centre y, sphere radius
 *  about (0, cy, 0) and horizontal radius about the trunk axis. */
function treeBox(g: THREE.BufferGeometry): THREE.Vector4 {
  const p = g.getAttribute('position'), c = g.getAttribute('bbCenter'), o = g.getAttribute('bbOff')
  const pts: [number, number, number, number][] = [] // x, y, z, extra radius
  for (let i = 0; i < p.count; i++) {
    const off = o ? Math.hypot(o.getX(i), o.getY(i)) : 0
    if (off > 0 && c) pts.push([c.getX(i), c.getY(i), c.getZ(i), off])
    else pts.push([p.getX(i), p.getY(i), p.getZ(i), 0])
  }
  let y0 = Infinity, y1 = -Infinity
  for (const [, y, , r] of pts) (y0 = Math.min(y0, y - r)), (y1 = Math.max(y1, y + r))
  const cy = (y0 + y1) / 2
  let R = 0, Rxz = 0
  for (const [x, y, z, r] of pts) {
    R = Math.max(R, Math.hypot(x, y - cy, z) + r)
    Rxz = Math.max(Rxz, Math.hypot(x, z) + r)
  }
  return new THREE.Vector4(cy, R * 1.02, Math.min(R, Rxz * 1.04), 0)
}

/**
 * Bake every species (full-detail level) into one atlas. `size` = atlas px. Runs on the GPU through `renderer`;
 * restores the renderer's state afterwards.
 */
export function bakeImpostors(renderer: THREE.WebGLRenderer, species: { id: number; geometry: THREE.BufferGeometry }[], foliageAtlas: THREE.Texture, size: number): ImpostorAtlas {
  const cellPx = size / GRID / FRAMES
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, type: THREE.UnsignedByteType })
  rt.texture.colorSpace = THREE.SRGBColorSpace
  const mat = bakeMaterial(foliageAtlas)
  const scene = new THREE.Scene()
  const cam = new THREE.OrthographicCamera()
  const slots: THREE.Vector4[] = [], boxes: THREE.Vector4[] = []
  const slotOf = new Int8Array(32).fill(-1)
  // Renderer state.
  const prevRT = renderer.getRenderTarget()
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha()
  const prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.enabled
  renderer.autoClear = false
  renderer.shadowMap.enabled = false
  renderer.setRenderTarget(rt)
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, true, true)
  const dir = new THREE.Vector3(), centre = new THREE.Vector3()
  species.slice(0, GRID * GRID).forEach((sp, s) => {
    const mesh = new THREE.InstancedMesh(sp.geometry, mat, 1)
    mesh.setMatrixAt(0, new THREE.Matrix4())
    mesh.frustumCulled = false
    scene.add(mesh)
    const box = treeBox(sp.geometry)
    const [cy, R, Rxz] = [box.x, box.y, box.z]
    centre.set(0, cy, 0)
    const sx = (s % GRID) * FRAMES * cellPx, sy = Math.floor(s / GRID) * FRAMES * cellPx
    cam.left = -Rxz; cam.right = Rxz; cam.top = R; cam.bottom = -R
    cam.near = 0.01; cam.far = R * 4
    cam.updateProjectionMatrix()
    for (let j = 0; j < FRAMES; j++) {
      for (let i = 0; i < FRAMES; i++) {
        hemiOctDir((i / (FRAMES - 1)) * 2 - 1, (j / (FRAMES - 1)) * 2 - 1, dir)
        cam.up.set(0, 1, 0)
        cam.position.copy(centre).addScaledVector(dir, R * 2)
        cam.lookAt(centre)
        cam.updateMatrixWorld()
        // One texel of padding inside each cell (no bleed between neighbouring views).
        rt.viewport.set(sx + i * cellPx + 1, sy + j * cellPx + 1, cellPx - 2, cellPx - 2)
        rt.scissor.copy(rt.viewport)
        rt.scissorTest = true
        renderer.setRenderTarget(rt)
        renderer.render(scene, cam)
      }
    }
    scene.remove(mesh)
    mesh.dispose()
    slotOf[sp.id] = s
    slots[s] = new THREE.Vector4(sx / size, sy / size, cellPx / size, 1 / cellPx)
    boxes[s] = box
  })
  rt.scissorTest = false
  rt.viewport.set(0, 0, size, size)
  rt.scissor.set(0, 0, size, size)
  // Dilate: empty texels take the mean colour of their filled neighbours (alpha stays 0), 3 passes → final
  // mipmapped atlas.
  const out = dilate(renderer, rt, size, 3)
  rt.dispose()
  mat.dispose()
  renderer.setRenderTarget(prevRT)
  renderer.setClearColor(prevClear, prevAlpha)
  renderer.autoClear = prevAuto
  renderer.shadowMap.enabled = prevShadow
  while (slots.length < GRID * GRID) (slots.push(new THREE.Vector4()), boxes.push(new THREE.Vector4(5, 6, 3, 0)))
  return { texture: out.texture, target: out, slots, boxes, slotOf, dispose: () => out.dispose() }
}

/** Unlit bake material: vertex colours × the foliage atlas, alpha-tested cards, tufts facing the bake camera;
 *  writes alpha 1 on leaves, 0.5 on bark (the atlas's bark texel). */
function bakeMaterial(atlas: THREE.Texture): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide })
  m.blending = THREE.NoBlending
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTimeS = { value: 0 }
    shader.uniforms.uWindS = { value: new THREE.Vector2() }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 bbCenter; attribute vec2 bbOff; varying float vBark;\nuniform float uTimeS; uniform vec2 uWindS;\n${GUST_GLSL}\n${SWAY_GLSL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vBark = (uv.x > 0.9775 && uv.x < 0.985 && uv.y < 0.038) ? 1.0 : 0.0;
        if (dot(bbOff, bbOff) > 0.0) {
          mvPosition = modelViewMatrix * vec4(bbCenter, 1.0);
          mvPosition.xy += bbOff;
          gl_Position = projectionMatrix * mvPosition;
        }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBark;')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = vBark > 0.5 ? 0.5 : 1.0;')
  }
  m.customProgramCacheKey = () => 'impostor-bake'
  return m
}

/** Fill empty texels with their filled neighbours' mean colour (`passes` × 3×3), output with mipmaps. */
function dilate(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, size: number, passes: number): THREE.WebGLRenderTarget {
  const mk = (mips: boolean) => {
    const t = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, generateMipmaps: mips, minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter, magFilter: mips ? THREE.LinearFilter : THREE.NearestFilter })
    t.texture.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uSrc: { value: null as THREE.Texture | null }, uTexel: { value: 1 / size } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D uSrc; uniform float uTexel; varying vec2 vUv;
      void main() {
        vec4 c = texture2D(uSrc, vUv);
        if (c.a < 0.01) {
          vec3 sum = vec3(0.0); float n = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec4 s = texture2D(uSrc, vUv + vec2(float(x), float(y)) * uTexel);
            if (s.r + s.g + s.b > 0.0 || s.a > 0.01) { sum += s.rgb; n += 1.0; }
          }
          c = vec4(n > 0.0 ? sum / n : vec3(0.0), 0.0);
        }
        gl_FragColor = c;
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  }))
  const scene = new THREE.Scene().add(quad)
  const cam = new THREE.Camera()
  const mat = quad.material as THREE.ShaderMaterial
  // src → ping → pong → … → final (mipmapped). Intermediates are freed.
  const temps = [mk(false), mk(false)]
  let read = src.texture
  for (let p = 0; p < passes - 1; p++) {
    mat.uniforms.uSrc.value = read
    renderer.setRenderTarget(temps[p & 1])
    renderer.render(scene, cam)
    read = temps[p & 1].texture
  }
  const out = mk(true)
  mat.uniforms.uSrc.value = read
  renderer.setRenderTarget(out)
  renderer.render(scene, cam)
  temps.forEach((t) => t.dispose())
  quad.geometry.dispose()
  mat.dispose()
  return out
}

/**
 * The impostor material: Lambert + the octahedral card patch + the shared `stylize` patch (so it lights, fogs,
 * snows and darkens with the rain like the trees). `userData.blend` = 3 views (else the nearest one): set it,
 * then `needsUpdate = true` (tier change).
 */
export function createImpostorMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ alphaTest: 0.3, side: THREE.FrontSide })
  const u = {
    uImpAtlas: { value: null as THREE.Texture | null },
    uImpSlot: { value: Array.from({ length: GRID * GRID }, () => new THREE.Vector4()) },
    uImpBox: { value: Array.from({ length: GRID * GRID }, () => new THREE.Vector4(5, 6, 3, 0)) },
  }
  m.userData.impostor = u
  m.userData.blend = true
  m.onBeforeCompile = (shader) => {
    const blend = !!m.userData.blend
    Object.assign(shader.uniforms, u, { uTreeLod: globalUniforms.uTreeLod, uImpFar: globalUniforms.uImpFar })
    shader.defines = { ...(shader.defines ?? {}), IMP_FRAMES: FRAMES.toFixed(1), IMP_SLOTS: GRID * GRID, ...(blend ? { IMP_BLEND: 1 } : {}) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSlot;
        uniform vec4 uImpSlot[IMP_SLOTS]; uniform vec4 uImpBox[IMP_SLOTS]; uniform vec4 uTreeLod; uniform vec2 uImpFar;
        varying vec2 vImpUv0; varying vec2 vImpUv1; varying vec2 vImpUv2; varying vec3 vImpW; varying float vImpD;
        ${HEMI_OCT_GLSL}
        vec3 impPos; vec3 impN;`)
      // All the card maths happens first (object = chunk-local space), then the normal / position are handed to
      // the standard instanced pipeline in INSTANCE space so fog, mist, biome cover and shadows work unchanged.
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        {
          int si = int(aSlot + 0.5);
          vec4 sl = uImpSlot[si]; vec4 bx = uImpBox[si];
          mat3 im = mat3(instanceMatrix);
          float sxz = length(im[0]), sy = length(im[1]);
          vec3 org = instanceMatrix[3].xyz;
          vec3 ctr = org + vec3(0.0, bx.x * sy, 0.0);
          vec3 camO = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
          vImpD = length(camO - org);
          // Not an impostor yet (still a mesh) or past the far edge: dropped before any other work.
          // Far edge: the forest THINS — each tree vanishes whole at its own (hashed) distance inside the band; a per-pixel
          // dither there read as a speckled cloud over distant ridges at phone resolutions.
          float thin = fract(sin(dot(org.xz, vec2(12.9898, 78.233))) * 43758.5453);
          if (smoothstep(uTreeLod.z, uTreeLod.w, vImpD) <= 0.0 || smoothstep(uImpFar.x, uImpFar.y, vImpD) > thin * 0.98) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
          }
          vec3 V = normalize(camO - ctr);
          vec3 up = vec3(0.0, 1.0, 0.0);
          vec3 right = abs(V.y) > 0.995 ? normalize(im[0]) : normalize(cross(up, V));
          vec3 upv = cross(V, right);
          float hw = bx.z * sxz, hh = bx.y * max(sxz, sy);
          impPos = ctr + right * (position.x * 2.0 * hw) + upv * (position.y * 2.0 * hh);
          // Crown-volume normal: out of the card toward the viewer, bent to the card's edges and up.
          impN = normalize(right * position.x * 1.6 + upv * position.y * 1.0 + V * 0.85 + vec3(0.0, 0.3, 0.0));
          objectNormal = transpose(im) * impN; // = impN after the instanced normal transform
          // The view in the tree's own frame (undo its yaw / lean) → hemi-octahedral grid → 3 nearest views.
          mat3 rot = mat3(im[0] / sxz, im[1] / sy, im[2] / length(im[2]));
          vec3 Vl = transpose(rot) * V;
          Vl.y = max(Vl.y, 0.0);
          vec2 g = (hemiOct(normalize(Vl + vec3(0.0, 1e-4, 0.0))) * 0.5 + 0.5) * (IMP_FRAMES - 1.0);
          vec2 f = min(floor(g), vec2(IMP_FRAMES - 2.0));
          vec2 t = clamp(g - f, 0.0, 1.0);
          vec2 fa, fb, fc;
          if (t.x + t.y < 1.0) { fa = f; fb = f + vec2(1.0, 0.0); fc = f + vec2(0.0, 1.0); vImpW = vec3(1.0 - t.x - t.y, t.x, t.y); }
          else { fa = f + vec2(1.0, 1.0); fb = f + vec2(1.0, 0.0); fc = f + vec2(0.0, 1.0); vImpW = vec3(t.x + t.y - 1.0, 1.0 - t.y, 1.0 - t.x); }
          #ifndef IMP_BLEND
            fa = vImpW.x >= max(vImpW.y, vImpW.z) ? fa : vImpW.y >= vImpW.z ? fb : fc;
          #endif
          vec2 q = (position.xy + 0.5) * (1.0 - 2.0 * sl.w) + sl.w; // inside the cell's 1-texel padding
          vImpUv0 = sl.xy + (fa + q) * sl.z;
          vImpUv1 = sl.xy + (fb + q) * sl.z;
          vImpUv2 = sl.xy + (fc + q) * sl.z;
        }`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = (inverse(instanceMatrix) * vec4(impPos, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uImpAtlas; uniform vec4 uTreeLod; uniform vec2 uImpFar;
        varying vec2 vImpUv0; varying vec2 vImpUv1; varying vec2 vImpUv2; varying vec3 vImpW; varying float vImpD;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec4 tc = texture2D(uImpAtlas, vImpUv0);
          #ifdef IMP_BLEND
            tc = tc * vImpW.x + texture2D(uImpAtlas, vImpUv1) * vImpW.y + texture2D(uImpAtlas, vImpUv2) * vImpW.z;
          #endif
          // Leaves (alpha 1) take the tree's hue, bark (0.5) only its brightness.
          float leaf = smoothstep(0.62, 0.9, tc.a);
          vec3 tint = vec3(1.0);
          #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            tint = mix(vec3(dot(vColor.rgb, vec3(0.3, 0.5, 0.2))), vColor.rgb, leaf);
          #endif
          diffuseColor = vec4(tc.rgb * tint, tc.a);
          // Crossfade with the low-poly mesh (complement of its dither) and dissolve at the far-forest edge.
          float gd = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (gd >= smoothstep(uTreeLod.z, uTreeLod.w, vImpD)) discard;
        }`)
  }
  m.customProgramCacheKey = () => `impostor-${m.userData.blend ? 3 : 1}`
  return stylize(m, { key: 'impostor', rim: isOverland() ? 0.5 : isGenshin() ? 0.45 : 1.1, noFlip: true, wet: true, biomeCover: 'foliage' })
}

/** Point a material at a baked atlas. */
export function useImpostorAtlas(m: THREE.Material, a: ImpostorAtlas): void {
  const u = m.userData.impostor
  u.uImpAtlas.value = a.texture
  a.slots.forEach((s, i) => u.uImpSlot.value[i].copy(s))
  a.boxes.forEach((b, i) => u.uImpBox.value[i].copy(b))
}

/** The card: a unit quad (x, y ∈ [-0.5, 0.5]) — positions only; the shader builds everything else. */
export function impostorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}
