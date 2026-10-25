import * as pc from 'playcanvas'
import { WorldFields } from '../world/WorldFields'
import { MIST_GLSL, SKY_GLSL } from '../rendering/sky/skyShader'
import { pcGlsl } from './materials/glsl'

/**
 * WATER on PlayCanvas — the three build's Water (bright): ONE flat plane at WorldFields.WATER following the camera
 * (snapped to 50 m), the terrain deciding where it shows; calm turquoise body, a half-strength mirror of the SKY
 * (skyColor, the same as the dome and every material's fog) taking over at grazing angles, slow ripple normals,
 * a soft broad sheen toward the key light, see-through looking down, the sky fog and ground mist. Frozen where the
 * region is snow (uIce — the player's region for now): pale clear ice with a broken crack network and snow drifts.
 * Drawn in the TRANSPARENT world pass after the opaque terrain: the depth test rejects every pixel under land first.
 * (The planar scene reflection of the three build comes back as a tier option.)
 */
const VS = /* glsl */ `
attribute vec3 aPosition;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vWorld;
void main(void) {
  vec4 w = matrix_model * vec4(aPosition, 1.0);
  vWorld = w.xyz;
  gl_Position = matrix_viewProjection * w;
}`
const FS = /* glsl */ `
${pcGlsl(SKY_GLSL)}
${pcGlsl(MIST_GLSL)}
uniform vec3 uCamPos;
uniform float uTime;
uniform float uRainW;
uniform float uIce;
uniform float uReflMax;
uniform vec2 uFogW;
uniform vec3 uDeep;
uniform vec3 uKeyColor;
uniform vec3 uKeyDirW;
varying vec3 vWorld;
vec2 wave(vec2 p, float t) {
  float n1 = sky_noise(p * 0.18 + vec2(t * 0.05, t * 0.03));
  float n2 = sky_noise(p * 0.45 - vec2(t * 0.08, -t * 0.06));
  float n3 = sky_noise(p * 1.3 + vec2(t * 0.2, t * 0.1));
  return vec2(n1 - 0.5, n2 - 0.5) * 0.9 + (n3 - 0.5) * 0.35;
}
void main(void) {
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 w = wave(vWorld.xz, uTime) * mix(0.35, 0.08, smoothstep(20.0, 400.0, dist)) * 0.45;
  if (uRainW > 0.01) {
    float rr = sky_noise(vWorld.xz * 3.5 + vec2(uTime * 1.7, -uTime * 2.3)) - 0.5;
    float r2 = sky_noise(vWorld.xz * 7.0 - vec2(uTime * 2.9, uTime * 1.1)) - 0.5;
    w += vec2(rr, r2) * uRainW * 0.5 * (1.0 - smoothstep(10.0, 60.0, dist));
  }
  float ice = uIce;
  w *= 1.0 - ice * 0.92;
  vec3 N = normalize(vec3(w.x, 1.0, w.y));
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = skyColor(normalize(R), false);
  float fres = 0.04 + 0.96 * pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 5.0);
  refl = mix(refl, vec3(dot(refl, vec3(0.3, 0.55, 0.15))), 0.25);
  vec3 col = mix(uDeep, refl, clamp(0.25 + fres * 0.85, 0.0, uReflMax));
  col = mix(col, vec3(0.16, 0.19, 0.21) * 0.6 + refl * 0.35, uRainW * 0.5);
  float alpha = mix(0.45, 0.97, clamp(fres * 1.6, 0.0, 1.0));
  if (ice > 0.001) {
    vec2 ip = vWorld.xz;
    float n1 = sky_noise(ip * 0.09), n2 = sky_noise(ip * 0.5 + 17.0), n3 = sky_noise(ip * 2.3 - 5.0);
    vec3 iceCol = mix(vec3(0.06, 0.14, 0.2), vec3(0.42, 0.56, 0.66), smoothstep(0.45, 0.8, n1) * 0.8) * (0.92 + 0.12 * n3);
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
    crack *= smoothstep(0.38, 0.6, sky_noise(ip * 0.06 + 4.0)) * (1.0 - smoothstep(15.0, 90.0, dist));
    iceCol = mix(iceCol, vec3(0.7, 0.8, 0.9), crack * 0.45);
    vec3 iced = mix(iceCol, refl, clamp(0.25 + fres * 1.2, 0.0, 0.94));
    float drift = smoothstep(0.68, 0.86, n2 * 0.65 + n1 * 0.35 + 0.08);
    iced = mix(iced, vec3(0.84, 0.88, 0.96), drift * 0.75);
    col = mix(col, iced, ice);
    alpha = mix(alpha, 1.0, ice);
  }
  col += uKeyColor * pow(max(dot(R, uKeyDirW), 0.0), 40.0) * 0.25;
  float fogF = max(smoothstep(uFogW.x, uFogW.y, dist), skyHaze(dist));
  fogF = 1.0 - (1.0 - fogF) * (1.0 - mistAmount(-V, dist));
  col = mix(col, skyColor(-V, false), fogF);
  gl_FragColor = vec4(col, max(alpha, max(fogF, smoothstep(60.0, 250.0, dist))));
}`

export class PcWater {
  private readonly entity: pc.Entity
  private readonly material: pc.ShaderMaterial
  private readonly fog = new Float32Array(2)
  private readonly deep = new Float32Array([0.17, 0.42, 0.7])

  constructor(app: pc.AppBase) {
    const m = new pc.ShaderMaterial({ uniqueName: 'darkWater', attributes: { aPosition: pc.SEMANTIC_POSITION }, vertexGLSL: VS, fragmentGLSL: FS })
    m.blendType = pc.BLEND_NORMAL
    m.depthWrite = false
    m.cull = pc.CULLFACE_NONE
    m.depthBias = -2
    m.slopeDepthBias = -8
    m.setParameter('uDeep', this.deep)
    m.setParameter('uReflMax', 0.75)
    m.setParameter('uIce', 0)
    m.setParameter('uRainW', 0)
    m.update()
    this.material = m
    const mesh = pc.Mesh.fromGeometry(app.graphicsDevice, new pc.PlaneGeometry({ halfExtents: new pc.Vec2(2000, 2000) }))
    const mi = new pc.MeshInstance(mesh, m)
    mi.castShadow = false
    this.entity = new pc.Entity('water')
    this.entity.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false })
    app.root.addChild(this.entity)
  }

  /** A map's own water (linear rgb) and its mirror cap (map.json palette.water / waterDeep). */
  setDeep(rgb: readonly [number, number, number], reflMax = 0.75): void {
    this.deep.set(rgb)
    this.material.setParameter('uDeep', this.deep)
    this.material.setParameter('uReflMax', reflMax)
  }

  update(time: number, cam: pc.Vec3, fogNear: number, fogFar: number, rain: number, ice: number): void {
    this.entity.setPosition(Math.round(cam.x / 50) * 50, WorldFields.WATER, Math.round(cam.z / 50) * 50)
    this.fog[0] = fogNear
    this.fog[1] = fogFar
    const m = this.material
    m.setParameter('uFogW', this.fog)
    m.setParameter('uTime', time)
    m.setParameter('uRainW', rain)
    m.setParameter('uIce', ice)
  }
}
