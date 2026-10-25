import type { MaterialLibrary } from '../../rendering/materials/MaterialLibrary'
import type { MaterialBank } from '../ThreeMirror'
import type { PcMaterials } from '../PcChunk'
import { registerCarMaterials } from './carMaterials'
import { portShaderMaterial } from './shaderPort'
import { grassMaterial } from './grassMaterial'
import type * as THREE from 'three'

/**
 * The GAMEPLAY objects' materials on PlayCanvas (the render bridge's converters, by the three material's
 * userData.pcKind): the car paint / glass / lamps / jets, the hero, debris, landmarks, set pieces. A material without a
 * converter gets the generic world look from its plain properties (ThreeMirror.genericMaterial).
 */
export function registerGameMaterials(bank: MaterialBank, lib: MaterialLibrary, world: PcMaterials): void {
  registerCarMaterials(bank)
  bank.register('grass', (m) => grassMaterial(m, bank))
  bank.shaderFallback = (m) => portShaderMaterial(m as THREE.ShaderMaterial, bank)
  void lib
  void world
}
