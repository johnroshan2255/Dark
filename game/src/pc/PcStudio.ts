import * as pc from 'playcanvas'
import * as THREE from 'three'

/**
 * GARAGE PHOTO on PlayCanvas (the three build's Game.carPhoto): the current car alone in a STUDIO — its own layer, a
 * warm key + a cool fill directional light that light only that layer, transparent background, 3/4 front view framed to
 * the car's bounds — rendered ONCE into a small multisampled target by its own camera and read back as a PNG. The car's
 * engine mesh instances (the render bridge's) join the studio layer for that one frame. Only on a change of car /
 * paint / tyres (the garage asks); the first shot compiles the studio light variant of the car's materials.
 */
export class PcStudio {
  private readonly layer: pc.Layer
  private readonly camera: pc.Entity
  private readonly key: pc.Entity
  private readonly fill: pc.Entity
  private rt: pc.RenderTarget | null = null
  private pending: { w: number; h: number; resolve: (url: string | null) => void } | null = null
  private busy = false
  /** the studio's key light direction (to the light) and colour while a shot renders: the world look's rim / terminator */
  readonly keyDir = new THREE.Vector3()
  active = false

  constructor(private readonly app: pc.AppBase) {
    this.layer = new pc.Layer({ name: 'Studio' })
    app.scene.layers.push(this.layer)
    this.camera = new pc.Entity('studioCamera')
    this.camera.addComponent('camera', {
      layers: [this.layer.id],
      clearColor: new pc.Color(0, 0, 0, 0),
      fov: 26,
      nearClip: 0.1,
      farClip: 100,
      priority: 10,
      toneMapping: pc.TONEMAP_NEUTRAL,
      gammaCorrection: pc.GAMMA_SRGB,
    })
    this.camera.enabled = false
    app.root.addChild(this.camera)
    const dl = (name: string, c: pc.Color, i: number) => {
      const e = new pc.Entity(name)
      e.addComponent('light', { type: 'directional', color: c, intensity: i, castShadows: false, layers: [this.layer.id] })
      e.enabled = false
      app.root.addChild(e)
      return e
    }
    this.key = dl('studioKey', new pc.Color(1, 0.94, 0.86), 2.6 / Math.PI)
    this.fill = dl('studioFill', new pc.Color(0.78, 0.83, 1), 0.9 / Math.PI)
  }

  request(w: number, h: number): Promise<string | null> {
    this.pending?.resolve(null)
    return new Promise((resolve) => (this.pending = { w, h, resolve }))
  }

  get wanted(): boolean {
    return !!this.pending && !this.busy
  }

  /**
   * Sets the shot up for THIS frame (the engine renders it with the rest): `instances` = the car's mesh instances,
   * `root` = its three root (bounds, facing). Returns false when the car has nothing to show yet.
   */
  prepare(instances: pc.MeshInstance[], root: THREE.Object3D): boolean {
    const req = this.pending
    if (!req || !instances.length) return false
    root.updateMatrixWorld(true)
    const box = new THREE.Box3(), tmp = new THREE.Box3()
    root.traverseVisible((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || (m.material as THREE.Material).transparent) return
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      box.union(tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld))
    })
    if (box.isEmpty()) return false
    const { w, h } = req
    // (2× supersampled, no MSAA: a multisampled target reads back empty — the downscale is the anti-aliasing)
    const W = w * 2, H = h * 2
    if (!this.rt || this.rt.width !== W || this.rt.height !== H) {
      this.rt?.destroyTextureBuffers()
      this.rt?.destroy()
      const tex = new pc.Texture(this.app.graphicsDevice, { name: 'studio', width: W, height: H, format: pc.PIXELFORMAT_RGBA8, mipmaps: false, minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR })
      this.rt = new pc.RenderTarget({ colorBuffer: tex, depth: true, samples: 1 })
      this.camera.camera!.renderTarget = this.rt
    }
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
    const q = root.getWorldQuaternion(new THREE.Quaternion())
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q), right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const dir = fwd.clone().multiplyScalar(0.82).addScaledVector(right, -0.62).add(new THREE.Vector3(0, 0.3, 0)).normalize()
    const aspect = w / h
    const rad = size.length() * 0.5, fit = (rad / Math.sin(THREE.MathUtils.degToRad(13))) * Math.max(1, 1.15 / aspect)
    const p = c.clone().addScaledVector(dir, fit * 0.7)
    this.camera.camera!.aspectRatio = aspect
    this.camera.camera!.aspectRatioMode = pc.ASPECT_MANUAL
    this.camera.setPosition(p.x, p.y, p.z)
    this.camera.lookAt(c.x, c.y - size.y * 0.06, c.z)
    // key from the front-left above, fill from the right
    const kp = c.clone().addScaledVector(fwd, 4).addScaledVector(right, -3).add(new THREE.Vector3(0, 6, 0))
    const fp = c.clone().addScaledVector(fwd, 2).addScaledVector(right, 5).add(new THREE.Vector3(0, 2, 0))
    this.aimLight(this.key, kp, c)
    this.aimLight(this.fill, fp, c)
    this.keyDir.copy(kp).sub(c).normalize()
    this.layer.addMeshInstances(instances)
    this.camera.enabled = this.key.enabled = this.fill.enabled = true
    this.active = true
    this.busy = true
    const rt = this.rt
    this.app.once('frameend', () => {
      this.camera.enabled = this.key.enabled = this.fill.enabled = false
      this.layer.removeMeshInstances(instances)
      this.active = false
      const done = this.pending
      this.pending = null
      void (rt.colorBuffer.read(0, 0, W, H, { renderTarget: rt, immediate: true }) as Promise<Uint8Array>)
        .then((px) => done?.resolve(toPng(px, W, H, w, h)))
        .catch(() => done?.resolve(null))
        .finally(() => (this.busy = false))
    })
    return true
  }

  private aimLight(e: pc.Entity, from: THREE.Vector3, at: THREE.Vector3): void {
    e.setPosition(from.x, from.y, from.z)
    e.lookAt(at.x, at.y, at.z)
    e.rotateLocal(90, 0, 0) // (a directional light shines down its −Y: +90° about X turns it onto lookAt's −Z — −90 lit the car from behind)
  }
}

/** RGBA rows (bottom-up, GL) at w × h → a PNG data URL at ow × oh (downscaled). */
function toPng(px: Uint8Array, w: number, h: number, ow: number, oh: number): string {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(w, h), row = w * 4
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row)
  ctx.putImageData(img, 0, 0)
  const out = document.createElement('canvas')
  out.width = ow
  out.height = oh
  const o = out.getContext('2d')!
  o.imageSmoothingQuality = 'high'
  o.drawImage(cv, 0, 0, ow, oh)
  return out.toDataURL('image/png')
}
