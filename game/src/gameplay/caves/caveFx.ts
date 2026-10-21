import * as THREE from 'three'

/**
 * The cave's OTHER-WORLD look (refer: Genshin's Crystal Chunk / Magical Crystal / Amethyst ores, the Chasm, Enkanomiya):
 *   - CRYSTALS: hexagonal quartz prisms with slanted pyramid tips, fanned in clusters out of a socket of dark rock
 *     shards; a cut-gem shader (every facet its own tone, a deep base → bright pale tip, inner refraction veins, pale
 *     glowing edges), unlit HDR so the bloom haloes them.
 *   - GLOW: one Points draw for the soft halo around each cluster, the twinkling star on its tip, motes of light
 *     drifting up through the chamber and a few CRYSTALFLIES (glowing butterflies on lazy loops).
 *   - LUMINOUS FLOWERS on the chamber floor (stems + glowing bulbs, pulsing).
 *   - a low glowing MIST over the chamber floor.
 * All shared geometry / materials; per cave: crystals 1 draw, glow 1, flowers 1, mist 1.
 */

/** Crystal colours (CrystalHue order): cyan Crystal Chunk, deep-blue Magical Crystal, violet Amethyst. */
export const CRYSTAL_RGB: [number, number, number][] = [[0.28, 1.0, 1.05], [0.16, 0.48, 1.25], [0.9, 0.32, 1.25]]
const SHARD_RGB: [number, number, number] = [0.05, 0.055, 0.07]

const FOG_VERT_PARS = '#include <fog_pars_vertex>'
const FOG_FRAG_PARS = '#include <fog_pars_fragment>'

/** One quartz crystal, base buried at y ∈ [−0.35, 0], body to y 0.72, slanted pyramid tip to ~1.08 (flat facets). */
export function createCrystalGeometry(): THREE.BufferGeometry {
  const N = 6, r0 = 0.2, r1 = 0.17, y0 = -0.35, y1 = 0.72
  const apex = [0.05, 1.08, 0.02]
  const ring = (r: number, y: number) => Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2 + 0.3
    return [Math.cos(a) * r, y, Math.sin(a) * r]
  })
  const b = ring(r0, y0), t = ring(r1, y1)
  const pos: number[] = []
  const tri = (p: number[], q: number[], r: number[]) => pos.push(...p, ...q, ...r)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    tri(b[i], t[j], b[j]); tri(b[i], t[i], t[j]) // side face
    // The tip: each face its own pitch (the apex is off-centre) → a cut, slanted point like real quartz.
    tri(t[i], apex, t[j])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals() // non-indexed → flat facets
  const h = new Float32Array(pos.length / 3)
  for (let i = 0; i < h.length; i++) h[i] = (pos[i * 3 + 1] - y0) / (apex[1] - y0)
  g.setAttribute('aH', new THREE.BufferAttribute(h, 1))
  g.computeBoundingSphere()
  return g
}

/** The crystal cut-gem material (instanced: instanceColor = hue, aGlow = 1 crystal / 0 rock shard). */
export function createCrystalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uIntensity: { value: 1.35 } }]),
    vertexShader: /* glsl */ `
      attribute float aH;
      attribute float aGlow;
      varying vec3 vN; varying vec3 vW; varying vec3 vObj; varying float vH; varying float vGlow; varying vec3 vCol; varying float vPhase;
      ${FOG_VERT_PARS}
      void main() {
        mat4 im = instanceMatrix;
        vec4 w = modelMatrix * im * vec4(position, 1.0);
        vW = w.xyz; vObj = position; vH = aH; vGlow = aGlow; vCol = instanceColor;
        vN = normalize(mat3(modelMatrix) * mat3(im) * normal);
        vPhase = im[3].x * 3.1 + im[3].z * 1.7;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uIntensity;
      varying vec3 vN; varying vec3 vW; varying vec3 vObj; varying float vH; varying float vGlow; varying vec3 vCol; varying float vPhase;
      ${FOG_FRAG_PARS}
      float h1(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        float ndv = abs(dot(N, V));
        // Cut gem: every flat facet its own tone, lighter on the up-facing ones.
        float facet = 0.45 + 0.5 * h1(dot(floor(N * 6.0 + 0.5), vec3(1.7, 9.3, 4.1))) + 0.25 * max(N.y, 0.0);
        // Deep and dark at the root, the hue through the body, a pale glowing tip.
        vec3 col = mix(vCol * 0.2, vCol, smoothstep(0.08, 0.55, vH));
        col = mix(col, mix(vCol, vec3(1.0), 0.45), smoothstep(0.75, 1.0, vH));
        col *= facet;
        // Inner refraction veins (the darker cracks seen through Genshin's crystals).
        float v = abs(sin(dot(vObj, vec3(6.3, 2.1, 4.7)) + 1.7 * sin(vObj.y * 7.0 + vObj.x * 5.0)));
        col *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.16, v));
        // Light caught in the edges: the grazing facets glow pale.
        col += mix(vCol, vec3(1.0), 0.5) * pow(1.0 - ndv, 2.5) * 0.8;
        col *= uIntensity * (0.86 + 0.14 * sin(uTime * 1.3 + vPhase));
        // Rock shards of the socket: dark slate, a faint coloured bounce on their up faces.
        vec3 rock = vCol * (0.55 + 0.6 * facet) + vec3(0.02, 0.07, 0.08) * max(N.y, 0.0);
        gl_FragColor = vec4(mix(rock, col, vGlow), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  })
}

/** Glow sprites: 0 halo, 1 sparkle, 2 rising mote, 3 crystalfly. Size in metres (projected by uScale). */
export const GlowKind = { Halo: 0, Sparkle: 1, Mote: 2, Fly: 3 } as const

export function createGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 500 } },
    vertexShader: /* glsl */ `
      attribute float aKind; attribute float aSeed; attribute float aSize; attribute vec3 aColor;
      uniform float uTime; uniform float uScale;
      varying float vKind; varying vec3 vColor; varying float vA; varying float vFlap;
      void main() {
        vec3 p = position;
        float a = 1.0, s = aSize;
        vFlap = 0.0;
        if (aKind > 1.5 && aKind < 2.5) {
          // Mote: drifts up ~5 m and fades, swaying, then starts again at the floor.
          float t = fract(uTime * (0.03 + 0.04 * aSeed) + aSeed * 7.0);
          p.y += t * 5.0;
          p.x += sin(uTime * 0.4 + aSeed * 20.0) * 0.6;
          p.z += cos(uTime * 0.33 + aSeed * 13.0) * 0.6;
          a = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.7, 1.0, t)) * (0.6 + 0.4 * sin(uTime * 2.0 + aSeed * 30.0));
        } else if (aKind > 2.5) {
          // Crystalfly: lazy loops around its home, bobbing, wings beating.
          float an = uTime * (0.3 + 0.2 * aSeed) + aSeed * 30.0;
          p += vec3(cos(an) * 2.4, sin(an * 1.7) * 0.6 + 0.25 * sin(uTime * 3.0 + aSeed * 9.0), sin(an) * 1.7);
          vFlap = abs(sin(uTime * 13.0 + aSeed * 40.0));
        } else if (aKind > 0.5) {
          // Sparkle: a sharp twinkle now and then.
          float tw = pow(max(0.0, sin(uTime * 1.9 + aSeed * 50.0)), 10.0);
          s *= 0.35 + 0.65 * tw;
          a = 0.25 + 0.75 * tw;
        } else {
          a = 0.85 + 0.15 * sin(uTime * 1.3 + aSeed * 20.0); // halo breathes with its crystals
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(s * uScale / max(0.1, -mv.z), 0.0, 384.0);
        vKind = aKind; vColor = aColor; vA = a;
      }`,
    fragmentShader: /* glsl */ `
      varying float vKind; varying vec3 vColor; varying float vA; varying float vFlap;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(uv, uv);
        float a;
        if (vKind < 0.5) a = exp(-r2 * 3.2) * 0.32 * (1.0 - smoothstep(0.8, 1.0, r2));
        else if (vKind < 1.5) {
          float star = max(0.0, 1.0 - abs(uv.x) * 10.0) * max(0.0, 1.0 - abs(uv.y)) + max(0.0, 1.0 - abs(uv.y) * 10.0) * max(0.0, 1.0 - abs(uv.x));
          a = star * 0.9 + exp(-r2 * 30.0);
        } else if (vKind < 2.5) a = exp(-r2 * 9.0);
        else {
          // Two glowing wings (their width beats) around a bright body, in a soft glow.
          float w = 0.12 + 0.3 * vFlap;
          vec2 q = vec2((abs(uv.x) - 0.1 - w * 0.9) / w, (uv.y + 0.05 * abs(uv.x)) / 0.42);
          float wing = 1.0 - smoothstep(0.6, 1.0, dot(q, q));
          a = wing * 0.75 + exp(-dot(uv * vec2(6.0, 2.2), uv * vec2(6.0, 2.2))) + exp(-r2 * 4.0) * 0.25;
        }
        gl_FragColor = vec4(vColor * a * vA, 1.0);
      }`,
  })
}

/** Luminous cave flowers: 3 thin curved stems, each with a glowing bulb (aBulb = 1) — one instance = one tuft. */
export function createFlowerGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], bulb: number[] = [], h: number[] = []
  const stems = [[0, 0, 0.42, 0.0], [0.09, 0.05, 0.3, 2.1], [-0.07, 0.06, 0.24, 4.2]] as const
  for (const [ox, oz, len, yaw] of stems) {
    const c = Math.cos(yaw), s = Math.sin(yaw), lean = 0.12
    const top = [ox + c * lean, len, oz + s * lean]
    // Stem: a thin tapered blade facing two ways (crossed), dark teal.
    for (const [px, pz] of [[-s * 0.012, c * 0.012], [c * 0.012, s * 0.012]]) {
      pos.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, top[0], top[1], top[2])
      bulb.push(0, 0, 0); h.push(0, 0, 1)
    }
    // Bulb: a small octahedron at the tip (rounded by its smooth normals in the shader: it just glows).
    const r = 0.05 + len * 0.08
    const v = [[r, 0, 0], [-r, 0, 0], [0, r * 1.4, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]]
    const faces = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]
    for (const f of faces) for (const k of f) {
      pos.push(top[0] + v[k][0], top[1] + v[k][1], top[2] + v[k][2])
      bulb.push(1); h.push(1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aBulb', new THREE.Float32BufferAttribute(bulb, 1))
  g.setAttribute('aH', new THREE.Float32BufferAttribute(h, 1))
  g.computeBoundingSphere()
  return g
}

export function createFlowerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      attribute float aBulb; attribute float aH;
      uniform float uTime;
      varying float vBulb; varying float vH; varying vec3 vCol; varying float vPulse;
      ${FOG_VERT_PARS}
      void main() {
        vec3 p = position;
        float ph = instanceMatrix[3].x * 2.3 + instanceMatrix[3].z * 1.9;
        p.x += sin(uTime * 0.9 + ph) * 0.03 * aH; // a slow sway
        vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vBulb = aBulb; vH = aH; vCol = instanceColor;
        vPulse = 0.7 + 0.3 * sin(uTime * 1.6 + ph);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying float vBulb; varying float vH; varying vec3 vCol; varying float vPulse;
      ${FOG_FRAG_PARS}
      void main() {
        vec3 stem = mix(vec3(0.02, 0.06, 0.05), vCol * 0.35, vH * vH); // lit by its own bulb near the top
        gl_FragColor = vec4(mix(stem, vCol * 2.2 * vPulse, vBulb), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  })
}

/** Low glowing mist over the chamber floor (a disc: soft drifting bands, edges fade). */
export function createMistMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv; varying vec3 vW;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        float n = sin(vW.x * 0.45 + uTime * 0.21) * sin(vW.z * 0.38 - uTime * 0.17) + 0.6 * sin((vW.x - vW.z) * 0.8 + uTime * 0.3);
        float a = (0.55 + 0.45 * n) * (1.0 - smoothstep(0.45, 1.0, r));
        // Grazing views see more mist (a layer), looking down through it less.
        // Seen from in or under the layer (down in the pool basin) it would be a hard-edged sheet: fade it out.
        float graze = 1.0 - abs(normalize(cameraPosition - vW).y);
        a *= smoothstep(0.35, 1.1, cameraPosition.y - vW.y);
        gl_FragColor = vec4(mix(vec3(0.05, 0.22, 0.26), vec3(0.16, 0.08, 0.26), 0.5 + 0.5 * sin(vW.x * 0.11 + vW.z * 0.07)) * a * (0.25 + 0.75 * graze) * 0.55, 1.0);
      }`,
  })
}

export { SHARD_RGB }
