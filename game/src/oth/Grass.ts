import * as THREE from 'three'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import { PAINT_GLSL } from './paint'
import type { Tier } from './quality'
import { HEIGHT_GLSL, type Terrain } from './Terrain'
import { SHADOW_GLSL } from './TerrainShadow'

/**
 * GRASS — the Over-the-Hill carpet: low-poly TUFTS of thick pointed blades (a quad + a tip, 5 vertices; the far ring a
 * single triangle) fanning out of one root, dense enough to hide the ground, round the camera in three rings of
 * world-locked tiles (one instanced draw per ring).
 *
 * THE GRASS IS THE GROUND GROWN UP: every blade takes the colour of the ground it stands on — the terrain's own
 * `groundPaint` at its root (green ground → green grass, golden → golden, thinning out toward rock / water / forest) —
 * and is lit with the ground's (soft) normal, so a grassy hill shades as one surface, like the terrain beyond the
 * grass. Only a gentle root-to-tip ramp and a per-blade nudge (blades facing the sun a touch lighter) separate them.
 *
 * Every tuft has a RANK in [0, 1): it shows only while rank < density(distance) / the ring's build density, and its
 * blades widen by the inverse square root of that share — the field thins with distance at the SAME coverage (no
 * ring edge), and LOW (fewer tufts) keeps the look: fewer, wider tufts, never a thinner field.
 */
interface Ring { rin: number; rout: number; tile: number; density: number; blades: number; mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; tiles: THREE.InstancedBufferAttribute; max: number }

/** HIGH's near tuft density: the reference the lower tiers widen their blades against. */
const REF_DENSITY = 22
const REF_FAN = 11

export class Grass {
  readonly group = new THREE.Group()
  private readonly rings: Ring[] = []
  private readonly frustum = new THREE.Frustum()
  private readonly box = new THREE.Box3()
  private readonly pv = new THREE.Matrix4()
  /** Blades drawn last frame (after the tile cull, before the per-tuft density cull). */
  blades = 0

  constructor(private readonly map: MapData, atmos: Atmosphere, terrain: Terrain, tier: Tier, rockFootprint: THREE.Texture) {
    const R = tier.grassRadius, D0 = tier.grassDensity
    const mg = map.meta.mask
    const t = terrain.uniforms
    const uniforms: Record<string, THREE.IUniform> = {
      ...atmos.uniforms,
      uHIn: t.uHIn, uHFar: t.uHFar, uInGrid: t.uInGrid, uFarGrid: t.uFarGrid, uInScale: t.uInScale, uFarScale: t.uFarScale,
      uBoxHalf: t.uBoxHalf, uNIn: t.uNIn,
      uShBox: t.uShBox, uShWorld: t.uShWorld, uShBoxGrid: t.uShBoxGrid, uShOn: t.uShOn,
      uTreeSh: t.uTreeSh, uTreeShGrid: t.uTreeShGrid, uTreeShOn: t.uTreeShOn,
      uMask: { value: map.maskTex },
      uRocks: { value: rockFootprint },
      uTrail: { value: map.trailTex },
      uTrailHW: { value: map.meta.trails.hw },
      uMaskGrid: { value: new THREE.Vector4(mg.n, mg.step, mg.origin, 0) },
      uD0: { value: D0 },
      uRadius: { value: R },
      // fewer tufts on the lower tiers → each blade wider by the square root: the coverage stays HIGH's
      uWidthK: { value: Math.max(1, Math.sqrt((REF_DENSITY * REF_FAN) / (D0 * tier.grassFan))) },
    }
    const bounds = [0, 0.25 * R, 0.55 * R, R]
    const tiles = [4, 8, 16]
    const blades = [tier.grassFan, Math.max(4, Math.round(tier.grassFan * 0.7)), Math.max(3, Math.round(tier.grassFan * 0.45))]
    const segs = [tier.grassSegments, 1, 1]
    for (let r = 0; r < 3; r++) {
      const density = densityAt(D0, bounds[r])
      const geo = tuftTile(tiles[r], density, blades[r], segs[r], 0x9e37 + r * 101)
      const max = Math.ceil(((2 * bounds[r + 1]) / tiles[r] + 2) ** 2)
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aTile', attr)
      geo.instanceCount = 0
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { ...uniforms, uBuild: { value: density }, uRin: { value: bounds[r] }, uRout: { value: bounds[r + 1] }, uFan: { value: blades[r] } },
        defines: tier.spec ? { OTH_SPEC: '' } : {},
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.renderOrder = 1 - r // nearest ring first: it hides the most
      this.group.add(mesh)
      this.rings.push({ rin: bounds[r], rout: bounds[r + 1], tile: tiles[r], density, blades: blades[r], mesh, geo, tiles: attr, max })
    }
  }

  update(camera: THREE.PerspectiveCamera): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.pv)
    const cx = camera.position.x, cz = camera.position.z
    this.blades = 0
    for (const ring of this.rings) {
      const T = ring.tile, a = ring.tiles.array as Float32Array
      const i0 = Math.floor((cx - ring.rout) / T), i1 = Math.floor((cx + ring.rout) / T)
      const j0 = Math.floor((cz - ring.rout) / T), j1 = Math.floor((cz + ring.rout) / T)
      let n = 0
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = i * T, z = j * T
          // nearest / farthest point of the tile from the camera (horizontal)
          const nx = Math.max(x - cx, 0, cx - x - T), nz = Math.max(z - cz, 0, cz - z - T)
          if (nx * nx + nz * nz > ring.rout * ring.rout) continue
          const fx = Math.max(Math.abs(x - cx), Math.abs(x + T - cx)), fz = Math.max(Math.abs(z - cz), Math.abs(z + T - cz))
          if (fx * fx + fz * fz < ring.rin * ring.rin) continue
          const h0 = this.map.height(x, z), h1 = this.map.height(x + T, z + T), h2 = this.map.height(x + T, z), h3 = this.map.height(x, z + T)
          this.box.min.set(x, Math.min(h0, h1, h2, h3) - 1.5, z)
          this.box.max.set(x + T, Math.max(h0, h1, h2, h3) + 2.5, z + T)
          if (!this.frustum.intersectsBox(this.box)) continue
          if (n >= ring.max) break
          a[n * 2] = x; a[n * 2 + 1] = z
          n++
        }
      }
      ring.geo.instanceCount = n
      ring.tiles.addUpdateRange(0, n * 2)
      ring.tiles.needsUpdate = true
      this.blades += n * Math.round(ring.density * T * T) * ring.blades
    }
  }
}

/** Tufts per m² wanted at distance d (m): full near the camera, falling ~d^-1.5 (the eye can't count them far). */
function densityAt(d0: number, d: number): number {
  return d0 / (1 + Math.pow(d / 9, 1.5))
}

/**
 * One ring's tile: K tufts in a T × T square (stratified jitter: no clumps, no holes), each `fan` blades of `segs`
 * segments (2: a quad + the tip, 5 vertices; 1: one triangle). Per vertex: aTuft (local x, local z, rank, seed),
 * aBlade (fan angle, lean, height ×, width ×) and aV (t along the blade 0..1, side −1 / 0 / +1).
 */
function tuftTile(T: number, density: number, fan: number, segs: number, seed: number): THREE.InstancedBufferGeometry {
  const K = Math.max(1, Math.round(density * T * T))
  const g = Math.ceil(Math.sqrt(K))
  const vpb = segs * 2 + 1
  const nv = K * fan * vpb
  const tuft = new Float32Array(nv * 4), blade = new Float32Array(nv * 4), v = new Float32Array(nv * 2), pos = new Float32Array(nv * 3)
  const idx: number[] = []
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
  const order = Array.from({ length: g * g }, (_, i) => i)
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  let o = 0
  for (let k = 0; k < K; k++) {
    const cell = order[k]
    const lx = ((cell % g) + rnd()) * (T / g), lz = (Math.floor(cell / g) + rnd()) * (T / g)
    const rank = (k + rnd()) / K, ts = rnd()
    for (let b = 0; b < fan; b++) {
      const ang = (b / fan) * Math.PI * 2 + (rnd() - 0.5) * 1.1
      // (a carpet: even heights, wide blades)
      const lean = rnd(), hk = 0.8 + 0.3 * rnd(), wk = 0.8 + 0.4 * rnd()
      const base = o
      for (let q = 0; q < vpb; q++, o++) {
        tuft.set([lx, lz, rank, ts], o * 4)
        blade.set([ang, lean, hk, wk], o * 4)
        const tip = q === vpb - 1
        v.set([tip ? 1 : Math.floor(q / 2) / segs, tip ? 0 : q % 2 ? 1 : -1], o * 2)
      }
      for (let sg = 0; sg < segs; sg++) {
        const l = base + sg * 2, r = l + 1
        if (sg < segs - 1) idx.push(l, r, l + 2, r, l + 3, l + 2)
        else idx.push(l, r, base + vpb - 1)
      }
    }
  }
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)) // (unused: the shader builds the blade)
  geo.setAttribute('aTuft', new THREE.BufferAttribute(tuft, 4))
  geo.setAttribute('aBlade', new THREE.BufferAttribute(blade, 4))
  geo.setAttribute('aV', new THREE.BufferAttribute(v, 2))
  geo.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
  return geo
}

const VERT = /* glsl */ `
${ATMOS_GLSL}
${HEIGHT_GLSL}
${PAINT_GLSL}
${SHADOW_GLSL}
uniform sampler2D uMask;
uniform sampler2D uNIn;
uniform sampler2D uRocks;
uniform sampler2D uTrail;
uniform float uTrailHW;
uniform vec4 uMaskGrid;
uniform float uD0;
uniform float uBuild;
uniform float uRin;
uniform float uRout;
uniform float uRadius;
uniform float uWidthK;
in vec4 aTuft;  // local x, local z, rank, seed
in vec4 aBlade; // fan angle, lean, height ×, width ×
in vec2 aV;     // t (0 root … 1 tip), side
in vec2 aTile;  // the tile's world corner
out vec3 vWorld;
out vec3 vColor;
out float vT;
out vec3 vN;
out float vSun;

vec3 unpackN(vec2 e) { vec2 n = e * 2.0 - 1.0; return vec3(n.x, sqrt(max(1.0 - dot(n, n), 0.0)), n.y); }

void main() {
  vec2 root = aTile + aTuft.xy;
  float d = length(root - uCamPos.xz);
  // density share at this distance → keep this tuft? (and how much wider, to hold the coverage)
  float share = (uD0 / (1.0 + pow(d / 9.0, 1.5))) / uBuild;
  float keep = step(aTuft.z, share) * step(uRin - 0.5, d) * step(d, uRout + 0.5);
  float widen = inversesqrt(clamp(share, 0.05, 1.0));
  // THE GROUND HERE: height, mask, soft normal, and its colour — the blade's colour
  float h = terrainHeight(root);
  vec4 m = textureLod(uMask, ((root - uMaskGrid.z) / uMaskGrid.y + 0.5) / uMaskGrid.x, 0.0);
  vec3 N = unpackN(textureLod(uNIn, ((root - uInGrid.z) / uInGrid.y + 0.5) / uInGrid.x, 2.5).rg);
  float trail = textureLod(uTrail, ((root - uInGrid.z) / uInGrid.y + 0.5) / uInGrid.x, 0.0).r * 8.0;
  // (the blade's colour is the FIELD's: painted without the track, so the blades at its edge don't take the earth)
  Ground g = groundPaint(root, m, h, 1.0 - N.y, paintNoise(root), 0.0, 99.0, uTrailHW, 0.0); // (no painted shrub dots under the grass: the bushes are real there)
  float onTrack = trackMask(root, trail, uTrailHW);
  // (none on rock, snow, the water's gravel and the earth band along it; thinner under the forest)
  float grow = (1.0 - smoothstep(0.3, 0.55, g.rock)) * (1.0 - smoothstep(0.855, 0.875, m.b)) * (1.0 - 0.6 * g.forest) * (1.0 - g.snow) * (1.0 - g.scree);
  grow *= (1.0 - smoothstep(0.3, 0.6, onTrack)); // (off the track; its clumps overhang the edge at full height)
  grow *= 1.0 - textureLod(uRocks, ((root - uInGrid.z) / uInGrid.y + 0.5) / uInGrid.x, 0.0).r; // (not through the rocks)
  float tall = mix(0.95, 1.45, smoothstep(0.2, 0.8, m.g)) * aBlade.z;
  float edge = 1.0 - smoothstep(uRadius * 0.8, uRadius, d);
  float height = tall * grow * edge * keep;
  // the blade: out of the tuft along its fan angle, leaning out, bending with the wind
  float ang = aBlade.x + aTuft.w * 6.2832;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 side = vec2(-dir.y, dir.x);
  float t = aV.x;
  float width = 0.1 * aBlade.w * uWidthK * widen * (1.0 - t * t) * step(0.001, height);
  vec2 gn = textureLod(uNoise, root * (1.0 / 37.0) - uTime * vec2(0.035, 0.02), 0.0).rg - 0.5;
  float gust = smoothstep(0.45, 0.75, textureLod(uNoise, root * (1.0 / 140.0) - uTime * vec2(0.022, 0.009), 0.0).r);
  vec2 wind = vec2(0.8, 0.35) * ((0.35 + 0.65 * sin(uTime * 1.5 + dot(root, vec2(0.21, 0.13)))) * 0.12 + gust * 0.32) + gn * 0.3;
  vec2 lean = dir * (0.05 + 0.22 * aBlade.y) + wind;
  vec2 base = root + dir * (0.03 + 0.12 * aBlade.y); // (roots spread: the tufts merge into one carpet)
  vec3 p = vec3(base.x, h - 0.04, base.y);
  p.xz += side * aV.y * width * 0.5 + lean * t * t * height;
  p.y += height * t * (1.0 - 0.3 * t * dot(lean, lean));
  vWorld = p;
  vT = t;
  // the ground's colour; each blade a touch lighter facing the sun, darker away (low-poly tone), gusts lift it
  float face = dot(dir, normalize(uSunDir.xz + vec2(1e-4)));
  // (one blade in eight stands in its neighbours' shade: the field's darker strokes)
  float br = fract(aTuft.w * 31.7 + aBlade.x * 3.1);
  vColor = g.col * (1.0 + face * 0.04 + (br - 0.5) * 0.1) * (br < 0.12 ? 0.8 : 1.0) * (1.0 + gust * 0.08);
  // the ground's light: its soft normal, leaning a little with the blade
  vN = normalize(N + vec3(dir.x, 0.0, dir.y) * 0.18);
  vSun = sunVisibility(root);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
in vec3 vWorld;
in vec3 vColor;
in float vT;
in vec3 vN;
in float vSun;

void main() {
  vec3 V = normalize(uCamPos - vWorld);
  // the ground's colour, a little deeper at the root (the carpet's depth), a little brighter at the tip
  float ao = mix(0.8, 1.0, smoothstep(0.0, 0.85, vT));
  vec3 albedo = vColor * mix(0.9, 1.08, vT);
  vec3 c = shade(albedo, normalize(vN), V, 0.85, 0.03, ao, vSun, 0.62);
  c += headlight(albedo, normalize(vN), vWorld);
  // back-lit by a low sun, the tips glow
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  c += albedo * uSunColor * back * vT * 0.3 * vSun;
  gl_FragColor = vec4(applyAtmos(c, vWorld), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
