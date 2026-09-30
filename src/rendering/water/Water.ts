import * as THREE from 'three'
import { WorldFields } from '../../world/WorldFields'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from '../sky/skyShader'

/**
 * Lakes and rivers: ONE flat water plane at WorldFields.WATER that follows the camera; the terrain decides
 * where water shows (carved river channels, low basins). Stylized: sky REFLECTION (the same skyColor as the
 * sky dome, so sunsets and mountains reflect), Fresnel toward a deep teal body colour, scrolling ripple
 * normals, a sharp sun/moon glint, sky-coloured fog. 1 draw call, fragment-only cost.
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
        uDeep: { value: new THREE.Color(0.03, 0.07, 0.085) },
        uKeyColor: { value: new THREE.Color() },
        uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
        /** Rain 0..1: dense fine ripples + a duller, greyer surface. */
        uRain: { value: 0 },
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
          vec3 N = normalize(vec3(w.x, 1.0, w.y));
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = skyColor(normalize(R), false); // no clouds/stars in the reflection: half the cost on phones
          float fres = 0.04 + 0.96 * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 5.0);
          // Calm stylized lake: mostly mirror of the sky (refer vista), darker body looking straight down.
          vec3 col = mix(uDeep, refl * 0.92, clamp(0.3 + fres * 1.2, 0.0, 1.0));
          col = mix(col, vec3(0.16, 0.19, 0.21) * 0.6 + refl * 0.35, uRain * 0.5); // grey, less mirror in the rain
          // See-through when looking down (the tinted bed shows), mirror at grazing angles, opaque far away.
          float alpha = mix(0.45, 0.97, clamp(fres * 1.6, 0.0, 1.0));
          float spec = pow(max(dot(R, uKeyDir), 0.0), 400.0);
          col += uKeyColor * spec * 6.0;
          float fogF = max(smoothstep(uFog.x, uFog.y, dist), skyHaze(dist));
          fogF = 1.0 - (1.0 - fogF) * (1.0 - mistAmount(-V, dist)); // + the volumetric ground mist
          col = mix(col, skyColor(-V, false), fogF);
          gl_FragColor = vec4(col, max(alpha, max(fogF, smoothstep(60.0, 250.0, dist))));
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

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
