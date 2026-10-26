import * as THREE from 'three'

/**
 * TONE MAPPING: Khronos PBR Neutral with a HUE-KEEPING TOE (installed as three's CustomToneMapping — `?tm=neutral`
 * for the original). Neutral subtracts its small black offset from every channel alike, so in a dark colour the
 * weakest channel is crushed to black: in shade, at dusk and at night the golden straw, the earth and the bark went
 * a saturated orange-brown (the user: "when the game changes its time to evening, night, morning, the terrain colour
 * and grass and trees all change"). Here the same offset comes off in proportion to each channel (the brightest
 * loses exactly Neutral's amount), so a dark colour keeps its hue; the highlight roll-off is Neutral's own.
 */
export function installToneMap(): void {
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }'
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment
  if (!chunk.includes(stub)) return
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub, /* glsl */ `vec3 CustomToneMapping( vec3 color ) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  color *= toneMappingExposure;
  float x = min( color.r, min( color.g, color.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  float m = max( color.r, max( color.g, color.b ) );
  color *= m > 1e-5 ? max( 1.0 - offset / m, 0.0 ) : 0.0;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < StartCompression ) return color;
  float d = 1. - StartCompression;
  float newPeak = 1. - d * d / ( peak + d - StartCompression );
  color *= newPeak / peak;
  float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
  return mix( color, vec3( newPeak ), g );
}`)
}
