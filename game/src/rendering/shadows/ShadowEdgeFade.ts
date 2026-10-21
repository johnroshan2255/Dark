import * as THREE from 'three'

/**
 * Fade directional (sun/moon) shadows to "unshadowed" over the outer 20% of the shadow map.
 * Without it the tight follow-frustum (±26–36 m) shows as a hard rectangle on the ground once the near
 * field is fog-free. Uses the existing shadow coord (no new varyings); applies to every lit material.
 * Must run BEFORE any program compiles (imported by Game). See skills/shadows.
 */
const ORIGINAL =
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;'

const PATCHED = /* glsl */ `{
  vec4 sc = vDirectionalShadowCoord[ i ];
  vec2 e = abs( sc.xy / sc.w - 0.5 ) * 2.0;
  float edgeFade = 1.0 - smoothstep( 0.8, 1.0, max( e.x, e.y ) );
  float sh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, sc ) : 1.0;
  directLight.color *= mix( 1.0, sh, edgeFade );
}`

let applied = false

export function applyShadowEdgeFade(): void {
  if (applied) return
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  if (!chunk.includes(ORIGINAL)) {
    console.warn('[ShadowEdgeFade] three.js chunk changed — shadow edge fade not applied (update the patch)')
    return
  }
  THREE.ShaderChunk.lights_fragment_begin = chunk.replace(ORIGINAL, PATCHED)
  applied = true
}
