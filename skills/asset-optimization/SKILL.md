---
name: asset-optimization
description: Read before adding any GLB/GLTF (especially AI-generated) to the game — validation, optimization, LOD generation, budgets, naming.
---

# Asset validation & optimization (AI-generated GLB)

## 1. Purpose

AI-generated 3D assets are *never* production-ready by default. Typical defects we must assume:

- 50k–500k triangles for a prop that deserves 1–3k
- 4096² textures (often 3–5 of them: base, normal, roughness, metallic, AO — unpacked)
- Multiple materials per object, duplicated materials across meshes
- Unwelded vertices (every triangle has its own 3 verts), unused attributes (`COLOR_0`, `TEXCOORD_1`, tangents)
- Wrong scale (object is 100 m tall or 1 cm), pivot not at the base, rotated up axis
- Textures embedded as huge PNGs, non-power-of-two sizes
- Holes, internal faces, inverted normals

This skill defines the pipeline that turns a raw asset into something that fits the budget.

## 2. Architecture

```
raw/ (NOT in src; keep outside the build, e.g. art/raw/<category>/<name>.glb)
  │ 1. inspect (scripts/validate-assets.mjs + manual look in https://gltf.report or three editor)
  │ 2. fix in Blender if needed: scale, pivot at base, +Y up, -Z forward, remove hidden geometry
  │ 3. gltf-transform: dedup → prune → weld → simplify → resize textures → KTX2 → meshopt
  │ 4. LODs: lod0 / lod1 / lod2 (+ optional impostor)
  ▼
src/assets/models/<category>/<name>.lod0.glb
                               <name>.lod1.glb
                               <name>.lod2.glb
  │ 5. validate again (npm run validate:assets -- --strict)
  ▼
runtime: useGLTF / GLTFLoader (+ KTX2Loader, MeshoptDecoder) → material remap → InstancedMesh or pooled mesh
```

Naming: `assets/models/<category>/<name>.lod<N>.glb`, lowercase-kebab names, categories:
`trees`, `rocks`, `props`, `monsters`, `characters`, `bmx`, `caves`, `road`.

## 3. When to use

Every asset, every time it changes. The validator is cheap; run it in CI later.

## 4. When NOT to use

- Procedural geometry (terrain, simple trees built in code) — it is built to budget already.
- Don't simplify hero assets (monster close-ups, player hands) aggressively; give them a larger budget instead.
- Don't KTX2-compress tiny (≤ 64²) UI-style textures; overhead isn't worth it.

## 5. Performance implications

### Budgets (per asset, LOD0 unless noted)

| Category | LOD0 tris | LOD1 | LOD2 / impostor | Materials | Textures (max) | Instanced? |
|---|---|---|---|---|---|---|
| tree | 1 500 | 500 | 80 / billboard | 2 (bark, foliage) | 1024² atlas | yes |
| rock | 800 | 250 | 60 | 1 | 512² | yes |
| plant / mushroom / grass clump | 300 | 80 | — (culled) | 1 | 256² shared atlas | yes |
| prop (car wreck, sign, barrel) | 3 000 | 1 000 | 250 | ≤ 2 | 1024² | if repeated |
| monster | 12 000 | 4 000 | 1 200 | ≤ 2 | 2048² | no (pooled) |
| character (player) | 15 000 | 5 000 | 1 500 | ≤ 3 | 2048² | no |
| bmx | 8 000 | 2 500 | 600 | ≤ 2 | 1024² | no |
| vehicle (drivable pickup) | 8 000 | — | — | ≤ 2 | 1024² (LOW: 512² runtime copy) | no |
| cave piece (modular) | 2 000 | 600 | 150 | 1 | 1024² atlas | yes |

Why these numbers: a visible LOD0 ring of ~9 chunks × ~150 trees × 1 500 tris ≈ 2 M tris only if *all* are
LOD0; LOD rings keep the scene at 1–2.5 M tris, which a mid-range GPU draws at 60 fps with our cheap shaders.

### Memory

- Texture memory (GPU): `w × h × bytesPerPixel × 1.33` (mips). 4096² RGBA8 = **85 MB**. 1024² KTX2 ETC1S
  (→ BC7/ETC2 on GPU, ~1 byte/px) ≈ 1.4 MB. See `skills/texture-optimization`.
- Geometry: ~32–48 bytes/vertex (pos+normal+uv+index). 100k verts ≈ 4 MB; meshopt shrinks *download* by 3–5× (not
  GPU memory — geometry is decoded before upload).

### CPU

- Decoding meshopt is fast (~100–300 MB/s in WASM); Draco is slower (~10× slower) — **prefer meshopt**.
- KTX2 transcoding runs in a worker pool (KTX2Loader); ETC1S transcodes faster than UASTC.

## 6. WebGL limitations

- Compressed texture formats available depend on the GPU: desktop → BC1–BC7 (`WEBGL_compressed_texture_s3tc`,
  `EXT_texture_compression_bptc`). KTX2/Basis transcodes to whatever is supported — this is why we ship KTX2
  instead of picking one format.
- Uint32 indices are supported in WebGL2 but Uint16 halves index memory; weld and keep meshes < 65 536 verts.
- No geometry shaders / mesh shaders: LOD is swapped geometry, not GPU tessellation.
- Skinned meshes: bone count limited by uniforms (three uses a bone texture when `maxVertexTextures > 0`, fine
  on desktop). Keep monsters ≤ 64 bones.

## 7. R3F implementation

```tsx
import { useGLTF } from '@react-three/drei'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'

// one per renderer — created in configureRenderer / asset system
export function makeKtx2(gl: THREE.WebGLRenderer) {
  return new KTX2Loader().setTranscoderPath('/basis/').detectSupport(gl)
}

function useAsset(url: string, ktx2: KTX2Loader) {
  // (path, useDraco=false, useMeshopt=true, extendLoader)
  return useGLTF(url, false, true, loader => loader.setKTX2Loader(ktx2))
}
```

Copy transcoder files once: `node_modules/three/examples/jsm/libs/basis/*` → `public/basis/`.

For instanced vegetation, don't render the GLB scene graph; extract geometry + material:

```ts
function extractSingleMesh(gltf: { scene: THREE.Object3D }) {
  let found: THREE.Mesh | undefined
  gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh && !found) found = o as THREE.Mesh })
  if (!found) throw new Error('asset has no mesh')
  const geo = found.geometry.clone()
  found.updateWorldMatrix(true, false)
  geo.applyMatrix4(found.matrixWorld)   // bake node transform so instance matrices are the only transform
  return { geometry: geo, material: found.material as THREE.Material }
}
```

## 8. Direct Three.js implementation

### Loader setup

```ts
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const loader = new GLTFLoader()
loader.setMeshoptDecoder(MeshoptDecoder)
loader.setKTX2Loader(ktx2)
const gltf = await loader.loadAsync('/models/rocks/boulder-a.lod0.glb')
```

### Material remap on load (shared materials)

AI assets each bring their own `MeshStandardMaterial`. Remap to library materials so all trees share a program
and state:

```ts
function remapMaterials(root: THREE.Object3D, lib: MaterialLibrary) {
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const src = m.material as THREE.MeshStandardMaterial
    const key = src.name.toLowerCase()               // name materials in Blender: bark, foliage, stone, metal…
    const shared = lib.byName(key)
    if (shared) { src.dispose(); m.material = shared } // keep map via atlas UVs, not per-asset textures
  })
}
```

Materials keyed by name means the artist (or the prompt to the AI tool) must name materials consistently.

### Atlases

- Group small props of a category into one atlas (e.g. `props-atlas.ktx2`, 2048²) and one material → the whole
  category can be batched/instanced with one program.
- Re-UV in Blender (Texture Atlas addon / "Pack Islands" across objects) before export.

## Pipeline commands (npx, not a project dependency)

```bash
# Inspect
npx @gltf-transform/cli inspect art/raw/trees/pine.glb

# Base cleanup (order matters)
npx @gltf-transform/cli dedup      in.glb   t1.glb          # merge identical accessors/materials/textures
npx @gltf-transform/cli prune      t1.glb   t2.glb          # drop unused nodes/materials/attributes
npx @gltf-transform/cli weld       t2.glb   t3.glb          # merge vertices (tolerance default 0.0001)
npx @gltf-transform/cli flatten    t3.glb   t4.glb          # collapse node hierarchy (static assets)
npx @gltf-transform/cli join       t4.glb   t5.glb          # merge meshes sharing a material → fewer draws

# LODs via simplify (meshoptimizer). ratio = target fraction of triangles, error = max deviation (fraction of size)
npx @gltf-transform/cli simplify t5.glb lod0.glb --ratio 0.25 --error 0.001
npx @gltf-transform/cli simplify t5.glb lod1.glb --ratio 0.08 --error 0.01
npx @gltf-transform/cli simplify t5.glb lod2.glb --ratio 0.02 --error 0.05

# Textures: resize then KTX2 (needs KTX-Software `toktx` on PATH for ktx2 commands)
npx @gltf-transform/cli resize lod0.glb lod0.glb --width 1024 --height 1024
npx @gltf-transform/cli etc1s  lod0.glb lod0.glb --quality 128          # base colour / roughness etc.
npx @gltf-transform/cli uastc  lod0.glb lod0.glb --slots "normalTexture" --level 2 --zstd 18  # normals

# Geometry compression last
npx @gltf-transform/cli meshopt lod0.glb src/assets/models/trees/pine.lod0.glb

# Or the all-in-one (good starting point, then check result)
npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress ktx2 --texture-size 1024 --simplify-ratio 0.25
```

Always compare against budget with `npm run validate:assets` after.

### Manual fixes checklist (Blender)

1. Apply scale; real-world size (tree 8–18 m, rock 0.5–3 m, BMX 1.7 m long, player 1.75 m).
2. Pivot at base centre (trees/rocks/props) — instancing places the origin on the terrain.
3. +Y up, facing −Z.
4. Delete interior faces, floaters, hidden geometry.
5. Name materials by library key (`bark`, `foliage`, `stone`, `metal`, `cloth`, `skin`, `monster`).
6. Pack ORM (occlusion/roughness/metalness) into one texture if PBR is kept.
7. Foliage: alpha-tested (`alphaTest 0.5`), **not** alpha-blended.

## 9. Common mistakes

1. Shipping the raw 30 MB GLB "temporarily".
2. Simplifying with a single ratio for every asset: a 400k-tri rock and a 5k-tri rock need different ratios —
   target tri counts from the budget table, compute ratio = target / current.
3. Simplifying before welding — unwelded meshes can't collapse edges; results look shredded.
4. Using Draco and meshopt both (pick meshopt).
5. KTX2-encoding normal maps with ETC1S (blocky artifacts) — use UASTC for normals.
6. Forgetting to bake node transforms before extracting geometry for instancing → trees float or are 100× size.
7. Alpha-blended foliage → sorting cost + overdraw. Use alphaTest (or alpha-to-coverage with MSAA RT).
8. Each asset keeps its own material → program count explodes (`renderer.info.programs.length` > 50).

## 10. Profiling / debugging

- `npm run validate:assets` (and `-- --strict` to fail on budget violations). Reports tris, materials, textures,
  image sizes, compression extensions, scale anomalies.
- `npx @gltf-transform/cli inspect file.glb` → per-mesh/texture sizes and VRAM estimate.
- In game: HUD `F3` shows `geometries`, `textures`, `programs`; loading a new asset type should add ≤ 1 program.
- Chrome Memory → "GPU" process in Task Manager (`Shift+Esc`) to see actual VRAM trends when streaming assets.
