import * as pc from 'playcanvas'

/**
 * A set of mesh instances shown in the WORLD layer, changed by diff (add the new, remove the gone). Not a render
 * component: assigning a render component's meshInstances DESTROYS the previous ones (and with them shared meshes),
 * which LOD switching and the batcher do every few frames. The engine still culls each mesh instance by its AABB and
 * collects the shadow casters (castShadow) from the layer.
 */
export class LayerSet {
  private readonly shown = new Set<pc.MeshInstance>()
  private readonly layer: pc.Layer

  /** @param layer another layer than the world (the leaves' depth pre-pass) */
  constructor(app: pc.AppBase, layer?: pc.Layer) {
    this.layer = layer ?? app.scene.layers.getLayerById(pc.LAYERID_WORLD)!
  }

  set(list: readonly pc.MeshInstance[]): void {
    const next = new Set(list)
    const gone: pc.MeshInstance[] = []
    for (const mi of this.shown) if (!next.has(mi)) gone.push(mi)
    const added: pc.MeshInstance[] = []
    for (const mi of next) if (!this.shown.has(mi)) added.push(mi)
    if (gone.length) this.layer.removeMeshInstances(gone)
    if (added.length) this.layer.addMeshInstances(added)
    for (const mi of gone) this.shown.delete(mi)
    for (const mi of added) this.shown.add(mi)
  }

  clear(): void {
    this.set([])
  }
}
