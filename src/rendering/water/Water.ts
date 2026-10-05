import * as THREE from 'three'
import { WorldFields } from '../../world/WorldFields'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from '../sky/skyShader'
import { BIOME_GLSL } from '../biome/BiomeMap'
import { globalUniforms } from '../shaders/uniforms'
import { ART } from '../artStyle'

/**
 * Lakes and rivers: ONE flat water plane at WorldFields.WATER that follows the camera; the terrain decides
 * where water shows (carved river channels, low basins). Stylized: sky REFLECTION (the same skyColor as the
 * sky dome, so sunsets and mountains reflect), Fresnel toward a deep teal body colour, scrolling ripple
 * normals, a sharp sun/moon glint, sky-coloured fog. 1 draw call, fragment-only cost.
 * NONE in the desert (dry basins / river bed). FROZEN in the snow (biome map, 1 fetch): a still, near-perfect mirror of the sky over pale blue-white ice with
 * dark clear-ice windows, white hairline cracks and drifts of snow; opaque (no bed showing through), no ripples.
 */
export class Water {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'Water',
      transparent: true,
      // Shallows: the bed's 2 m heightfield sits at the water's height along every shore and in flat lake
      // bottoms, so the two surfaces z-fought — a flicker of bed patches through the water as the camera moved
      // ("stutter where there is less water"). A polygon offset gives the water a fixed depth advantage.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
      uniforms: {
        ...skyUniforms,
        uTime: { value: 0 },
        uFog: { value: new THREE.Vector2(60, 900) },
        // Genshin lakes are clear TURQUOISE (Cider Lake, Bishui); the other styles keep a deep teal.
        uDeep: { value: ART.style === 'bright' ? new THREE.Color(0.012, 0.15, 0.17) : new THREE.Color(0.03, 0.07, 0.085) },
        uKeyColor: { value: new THREE.Color() },
        uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
        /** Rain 0..1: dense fine ripples + a duller, greyer surface. */
        uRain: { value: 0 },
        /** Planar reflection (PlanarReflection.ts): texture, projective matrix, on/off for this frame. */
        uReflect: { value: null as THREE.Texture | null },
        uReflectMat: { value: new THREE.Matrix4() },
        uReflectOn: { value: 0 },
        uBiomeMap: globalUniforms.uBiomeMap,
        uBiomeRect: globalUniforms.uBiomeRect,
        uBiomeActive: globalUniforms.uBiomeActive,
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        ${MIST_GLSL}
        ${BIOME_GLSL}
        uniform sampler2D uReflect; uniform mat4 uReflectMat; uniform float uReflectOn;
        uniform float uTime, uRain; uniform vec2 uFog; uniform vec3 uDeep, uKeyColor, uKeyDir;
        varying vec3 vWorld;
        vec2 wave(vec2 p, float t) {
          float n1 = sky_noise(p * 0.18 + vec2(t * 0.05, t * 0.03));
          float n2 = sky_noise(p * 0.45 - vec2(t * 0.08, -t * 0.06));
          float n3 = sky_noise(p * 1.3 + vec2(t * 0.2, t * 0.1));
          return vec2(n1 - 0.5, n2 - 0.5) * 0.9 + (n3 - 0.5) * 0.35;
        }
        void main() {
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          vec2 w = wave(vWorld.xz, uTime) * mix(0.35, 0.08, smoothstep(20.0, 400.0, dist));
          // Rain: fast fine ripples pepper the surface (only near — they alias far away) and dull the mirror.
          if (uRain > 0.01) {
            float rr = sky_noise(vWorld.xz * 3.5 + vec2(uTime * 1.7, -uTime * 2.3)) - 0.5;
            float r2 = sky_noise(vWorld.xz * 7.0 - vec2(uTime * 2.9, uTime * 1.1)) - 0.5;
            w += vec2(rr, r2) * uRain * 0.5 * (1.0 - smoothstep(10.0, 60.0, dist));
          }
          // Ice: where the region is snow, the surface is frozen — almost no waves, no rain rings.
          vec2 bio = biomeAt(vWorld.xz);
          // DESERT: no water at all — basins and the river bed are dry (the terrain shows its clay pan).
          float dry = smoothstep(0.3, 0.5, bio.x);
          if (dry > 0.99) discard;
          // SNOW: frozen across the whole snow region (and its fringe), not only deep inside it.
          float ice = smoothstep(0.22, 0.42, bio.y);
          w *= 1.0 - ice * 0.92;
          vec3 N = normalize(vec3(w.x, 1.0, w.y));
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = skyColor(normalize(R), false); // no clouds/stars in the reflection: half the cost on phones
          if (uReflectOn > 0.5) {
            // The mirrored scene (trees, hills, clouds, sun), displaced by the ripples — barely on ice.
            vec4 rc = uReflectMat * vec4(vWorld, 1.0);
            vec2 ruv = rc.xy / rc.w + w * mix(0.07, 0.008, ice);
            refl = texture2D(uReflect, clamp(ruv, vec2(0.002), vec2(0.998))).rgb;
          }
          float fres = 0.04 + 0.96 * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 5.0);
          // Calm stylized lake: mostly mirror of the sky (refer vista), darker body looking straight down.
          vec3 col = mix(uDeep, refl * 0.92, clamp(0.3 + fres * 1.2, 0.0, 1.0));
          col = mix(col, vec3(0.16, 0.19, 0.21) * 0.6 + refl * 0.35, uRain * 0.5); // grey, less mirror in the rain
          // See-through when looking down (the tinted bed shows), mirror at grazing angles, opaque far away.
          float alpha = mix(0.45, 0.97, clamp(fres * 1.6, 0.0, 1.0));
          if (ice > 0.001) {
            vec2 ip = vWorld.xz;
            float n1 = sky_noise(ip * 0.09), n2 = sky_noise(ip * 0.5 + 17.0), n3 = sky_noise(ip * 2.3 - 5.0);
            // Dark, glassy clear ice (the depth shows through) with paler frosted patches.
            vec3 iceCol = mix(vec3(0.06, 0.14, 0.2), vec3(0.42, 0.56, 0.66), smoothstep(0.45, 0.8, n1) * 0.8) * (0.92 + 0.12 * n3);
            // Crack network: edges of a jittered cell pattern (F2 − F1), ~1 px wide at any distance, faded far away.
            vec2 cp = ip * 0.075 + vec2(sky_noise(ip * 0.04), sky_noise(ip * 0.04 + 9.0)) * 0.6, ci = floor(cp), cf = fract(cp);
            float f1 = 9.0, f2 = 9.0;
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
              vec2 g = vec2(float(i), float(j));
              vec2 o = vec2(sky_noise((ci + g) * 7.31), sky_noise((ci + g) * 3.17 + 11.0));
              float d = length(g + o - cf);
              if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
            }
            float e = f2 - f1;
            float crack = 1.0 - smoothstep(0.0, fwidth(e) * 1.1 + 0.004, e);
            // Only some edges break (a broken network, not tiles); finer and fainter far away.
            crack *= smoothstep(0.38, 0.6, sky_noise(ip * 0.06 + 4.0)) * (1.0 - smoothstep(15.0, 90.0, dist));
            iceCol = mix(iceCol, vec3(0.7, 0.8, 0.9), crack * 0.45);
            // Polished mirror: reflection dominant at grazing angles, the dark ice body looking down.
            vec3 iced = mix(iceCol, refl, clamp(0.25 + fres * 1.2, 0.0, 0.94));
            // Wind-blown snow in patches over the ice.
            float drift = smoothstep(0.68, 0.86, n2 * 0.65 + n1 * 0.35 + 0.08);
            iced = mix(iced, vec3(0.84, 0.88, 0.96), drift * 0.75);
            col = mix(col, iced, ice);
            alpha = mix(alpha, 1.0, ice);
          }
          float spec = pow(max(dot(R, uKeyDir), 0.0), 400.0);
          col += uKeyColor * spec * 6.0;
          float fogF = max(smoothstep(uFog.x, uFog.y, dist), skyHaze(dist));
          fogF = 1.0 - (1.0 - fogF) * (1.0 - mistAmount(-V, dist)); // + the volumetric ground mist
          col = mix(col, skyColor(-V, false), fogF);
          gl_FragColor = vec4(col, max(alpha, max(fogF, smoothstep(60.0, 250.0, dist))) * (1.0 - dry));
        }`,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 1, 1).rotateX(-Math.PI / 2), this.material)
    this.mesh.name = 'water'
    this.mesh.frustumCulled = false
    this.mesh.position.y = WorldFields.WATER
  }

  update(time: number, cam: THREE.Vector3, fogNear: number, fogFar: number, keyDir: THREE.Vector3, keyColor: THREE.Color, rain = 0): void {
    this.material.uniforms.uRain.value = rain
    this.mesh.position.set(Math.round(cam.x / 50) * 50, WorldFields.WATER, Math.round(cam.z / 50) * 50)
    this.mesh.updateMatrixWorld()
    const u = this.material.uniforms
    u.uTime.value = time
    ;(u.uFog.value as THREE.Vector2).set(fogNear, fogFar)
    ;(u.uKeyDir.value as THREE.Vector3).copy(keyDir)
    ;(u.uKeyColor.value as THREE.Color).copy(keyColor)
  }

  /** This frame's planar reflection (or none: the water mirrors the sky colour only). */
  setReflection(tex: THREE.Texture, mat: THREE.Matrix4, on: boolean): void {
    const u = this.material.uniforms
    u.uReflect.value = tex
    ;(u.uReflectMat.value as THREE.Matrix4).copy(mat)
    u.uReflectOn.value = on ? 1 : 0
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
