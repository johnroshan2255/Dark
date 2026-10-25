import * as pc from 'playcanvas'
import { globalUniforms } from '../rendering/shaders/uniforms'
import { createBrushTexture } from '../rendering/materials/BrushTexture'
import { bakeRelief, RELIEF_SIZE } from './detailRelief'

/**
 * The SHARED SHADER TEXTURES on PlayCanvas, set once into the device's uniform scope (every shader that declares the
 * sampler reads it): the value-noise LATTICE (uNoiseTex — the same 256² R16F hash the three build used: st_noise =
 * one bilinear fetch) and the painted-ground BRUSH (uBrush, 256² RGBA, repeat). Built from the game's own data. And the SURFACE
 * RELIEF (uRelief, 512² RGBA, repeat: detailRelief.ts — the soft look's crumpled ground / rock relief).
 */
export function createSharedTextures(device: pc.GraphicsDevice): { noise: pc.Texture; brush: pc.Texture } {
  const src = globalUniforms.uNoiseTex.value
  const img = src.image as { data: Uint16Array; width: number; height: number }
  const noise = new pc.Texture(device, {
    name: 'noiseLattice',
    width: img.width,
    height: img.height,
    format: pc.PIXELFORMAT_R16F,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    levels: [img.data],
  })
  const b = createBrushTexture()
  const bi = b.image as { data: Uint8Array; width: number; height: number }
  const brush = new pc.Texture(device, {
    name: 'brush',
    width: bi.width,
    height: bi.height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    levels: [bi.data],
  })
  b.dispose()
  device.scope.resolve('uNoiseTex').setValue(noise)
  device.scope.resolve('uBrush').setValue(brush)
  const relief = new pc.Texture(device, {
    name: 'relief',
    width: RELIEF_SIZE,
    height: RELIEF_SIZE,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    anisotropy: 4,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    levels: [bakeRelief()],
  })
  device.scope.resolve('uRelief').setValue(relief)
  // the snow / sand TRAIL map (footprints, tyre tracks): none until PcTrails draws one (uTrailOn 0 skips it)
  const trail = new pc.Texture(device, { name: 'noTrails', width: 1, height: 1, format: pc.PIXELFORMAT_RGBA8, mipmaps: false, levels: [new Uint8Array(4)] })
  device.scope.resolve('uTrailMap').setValue(trail)
  return { noise, brush }
}
