import type { TierName } from './QualityTiers'

/**
 * Initial tier guess from the GPU string and device hints. It is only a starting point —
 * AdaptiveQuality corrects it from measured frame times within seconds.
 */
export interface DeviceProfile {
  gpu: string
  mobile: boolean
  touch: boolean
  cores: number
  memoryGB: number | null
  tier: TierName
  reason: string
}

interface NavigatorExt extends Navigator {
  deviceMemory?: number
  userAgentData?: { mobile?: boolean }
}

export function isTouchDevice(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0 && matchMedia('(pointer: coarse)').matches
}

export function isMobileDevice(): boolean {
  const nav = navigator as NavigatorExt
  if (nav.userAgentData?.mobile) return true
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true
  // iPadOS reports as Mac; touch points give it away.
  return /Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1
}

export function classifyGpu(gpu: string, mobile: boolean): { tier: TierName; reason: string } {
  const g = gpu.toLowerCase()
  if (/swiftshader|llvmpipe|softpipe|microsoft basic|software/.test(g)) return { tier: 'low', reason: 'software renderer' }
  if (mobile) {
    if (/adreno[^\d]*(7[3-9]\d|8\d\d)|mali-g(7[1-9]|[89]\d|\d{3})|immortalis|apple/.test(g))
      return { tier: 'medium', reason: 'upper mid-range mobile GPU' }
    return { tier: 'low', reason: 'mobile GPU' }
  }
  if (/intel.*(hd|uhd) graphics|intel\(r\) (hd|uhd)|mesa.*intel(?!.*(arc|xe))/.test(g)) return { tier: 'low', reason: 'Intel HD/UHD iGPU' }
  if (/iris|radeon\(tm\) graphics|amd radeon graphics|vega \d+ graphics|radeon vega|intel.*xe/.test(g))
    return { tier: 'medium', reason: 'integrated GPU' }
  if (/apple m\d|apple gpu|nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|arc\b/.test(g)) return { tier: 'high', reason: 'discrete/Apple GPU' }
  return { tier: 'medium', reason: 'unknown GPU' }
}

export function detectDevice(gl: WebGL2RenderingContext): DeviceProfile {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
  const mobile = isMobileDevice()
  const nav = navigator as NavigatorExt
  const cores = navigator.hardwareConcurrency || 4
  const memoryGB = nav.deviceMemory ?? null
  let { tier, reason } = classifyGpu(gpu, mobile)
  // Weak CPU/RAM caps the tier regardless of GPU (streaming + physics + GC headroom).
  if (tier === 'high' && (cores <= 4 || (memoryGB !== null && memoryGB <= 4))) {
    tier = 'medium'
    reason += ', capped by CPU/RAM'
  }
  if (mobile && memoryGB !== null && memoryGB <= 3) {
    tier = 'low'
    reason += ', ≤3 GB RAM'
  }
  return { gpu, mobile, touch: isTouchDevice(), cores, memoryGB, tier, reason }
}
