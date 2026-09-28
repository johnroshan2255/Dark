import * as THREE from 'three'

/** Options for the WebGLRenderer R3F creates (passed as Canvas `gl`). */
export const rendererOptions: THREE.WebGLRendererParameters = {
  antialias: false, // MSAA happens on the scene render target
  powerPreference: 'high-performance',
  stencil: false,
  depth: true,
  alpha: false,
  preserveDrawingBuffer: false,
}

/**
 * Direct renderer configuration after R3F creates it. We keep full control of
 * tone mapping, colour space, shadow type and stats. See skills/webgl.
 */
export function configureRenderer(gl: THREE.WebGLRenderer): void {
  gl.outputColorSpace = THREE.SRGBColorSpace
  // Khronos PBR Neutral: keeps hue + saturation (the stylized, clear look of refer/*), unlike AgX (flat/grey)
  // or ACES (crushes darks). Applied only in the final grading pass (render target → screen).
  gl.toneMapping = THREE.NeutralToneMapping
  gl.toneMappingExposure = 1
  gl.shadowMap.enabled = true
  gl.shadowMap.type = THREE.PCFShadowMap
  // Several render() calls per frame (shadow, scene RT, grading) — reset stats once per frame ourselves.
  gl.info.autoReset = false
}

export interface GpuCapabilities {
  renderer: string
  vendor: string
  maxTextureSize: number
  maxSamples: number
  timerQuery: boolean
  anisotropy: number
}

export function readCapabilities(gl: THREE.WebGLRenderer): GpuCapabilities {
  const ctx = gl.getContext() as WebGL2RenderingContext
  const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: dbg ? String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    vendor: dbg ? String(ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : 'unknown',
    maxTextureSize: gl.capabilities.maxTextureSize,
    maxSamples: gl.capabilities.maxSamples,
    timerQuery: !!ctx.getExtension('EXT_disjoint_timer_query_webgl2'),
    anisotropy: gl.capabilities.getMaxAnisotropy(),
  }
}
