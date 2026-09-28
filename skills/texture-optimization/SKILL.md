---
name: texture-optimization
description: Read before adding or changing textures, render targets, or texture settings — memory math, KTX2, mips, anisotropy, atlases, color spaces.
---

# Texture optimization

## 1. Purpose

Textures are usually the largest GPU memory consumer and a major bandwidth cost. Our stylized look relies on
vertex colors, fog and grading — textures should be **few, small, compressed, and shared**.

## 2. Architecture

```
src/assets/textures/
  atlases/     vegetation-atlas.ktx2 (2048²), props-atlas.ktx2 (2048²)
  detail/      detail-noise.ktx2 (512², tiling, used by terrain for close-up breakup)
  fx/          flashlight-cookie.png (256², optional), grain handled procedurally
TextureLibrary (planned: src/rendering/materials/) — loads once, sets colorSpace/anisotropy/wrap, refcounts
```

Terrain uses **vertex colors + a single tiling detail texture**, not splat maps with 4 × 2k layers.

## 3. When to use

- Detail/breakup where vertex color is too coarse (bark, rock surfaces, road asphalt).
- Alpha-tested foliage cards.
- Monsters/characters (hero assets with larger budget).

## 4. When NOT to use

- Solid-coloured low-poly objects → vertex colors or material color, zero texture memory.
- Per-chunk unique textures (baked terrain color maps) — memory scales with streamed chunk count.
- Normal maps on distant/small objects — invisible under fog, costs a sample + TBN.

## 5. Performance implications

### Memory math

`bytes = width × height × bytesPerTexel × (mips ? 1.333 : 1)`

| Texture | Format | Memory |
|---|---|---|
| 4096² RGBA8 | uncompressed | 85.3 MB |
| 2048² RGBA8 | uncompressed | 21.3 MB |
| 2048² BC7 / ASTC 4×4 (from UASTC) | 1 B/texel | 5.6 MB |
| 2048² BC1 / ETC1 (from ETC1S, opaque) | 0.5 B/texel | 2.8 MB |
| 1024² BC1 | 0.5 B/texel | 0.7 MB |
| 1920×1080 RGBA16F render target | 8 B/px | 16.6 MB (+ MSAA 4×: ×4 renderbuffer) |

**Budget:** total texture memory ≤ 256 MB (desktop). Streamed/chunk textures: 0.

Note that a PNG/JPEG's file size says nothing about GPU memory — a 300 KB JPEG at 4096² is still 85 MB on the GPU.

### Bandwidth / GPU time

Sampling a mipmapped compressed texture is cache-friendly. Missing mips on minified textures thrash the cache
(and shimmer). Anisotropic 16× costs a few % on distant ground; 4–8× is the sweet spot.

### CPU

- PNG/JPEG decode on main thread (`ImageBitmapLoader` can move it off-thread).
- KTX2 transcoding in KTX2Loader worker pool; upload is then a direct compressed upload (fast, no mip generation).

## 6. WebGL limitations

- `MAX_TEXTURE_SIZE` typically 16384 on desktop; don't rely on > 4096.
- Compressed formats are extension-dependent; KTX2/Basis solves this by transcoding at load.
- Non-power-of-two textures are fine in WebGL2 (mips + repeat allowed), but POT still packs better in atlases and
  block compression needs dimensions multiple of 4.
- `generateMipmap` on large uncompressed textures stalls (GPU + sometimes CPU).
- Max texture units per fragment shader: 16 guaranteed. Shadows, envmap, map, normal, roughness… add up.

## 7. R3F implementation

```tsx
import { useTexture } from '@react-three/drei'
const detail = useTexture('/textures/detail/detail-noise.png', t => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.NoColorSpace         // data texture
  t.anisotropy = 8
})
```

Shared textures in library materials must be mounted with `dispose={null}` owners; R3F will otherwise dispose
materials (and textures used by JSX-created materials) on unmount.

## 8. Direct Three.js implementation

```ts
const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer)
const tex = await ktx2.loadAsync('/textures/atlases/vegetation-atlas.ktx2')
tex.colorSpace = THREE.SRGBColorSpace          // base colour / albedo / emissive
tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping   // atlases: clamp; pad islands by ≥ 8 px for mips
```

### Color space rules

| Texture | colorSpace |
|---|---|
| base color / albedo / emissive / UI | `THREE.SRGBColorSpace` |
| normal, roughness, metalness, AO, ORM, masks, noise, height | `THREE.NoColorSpace` (linear) |
| render targets | linear; final pass converts with `colorspace_fragment` |

GLTFLoader sets these correctly for glTF slots; set them manually for anything else.

### ETC1S vs UASTC

| | ETC1S | UASTC |
|---|---|---|
| Quality | lower, blocky on gradients | near-BC7 |
| File size | very small | 4–8× larger (use `--zstd`) |
| GPU memory | 0.5–1 B/texel | 1 B/texel |
| Use for | albedo, roughness, AO, foliage | normal maps, hero textures, UI with gradients |

### Sizes by category

| Category | Max size |
|---|---|
| vegetation atlas (all species) | 2048² |
| rock / cave atlas | 1024²–2048² |
| props atlas | 2048² |
| monster (each) | 2048² (base) + 1024² (normal) |
| player character | 2048² |
| BMX | 1024² |
| terrain detail (tiling) | 512² |

### Disposal

```ts
texture.dispose()          // frees GPU memory; the JS object can be re-uploaded if used again
renderTarget.dispose()     // also frees its depth/MSAA buffers
material.dispose()         // does NOT dispose its textures
```

Refcount shared textures in a TextureLibrary; dispose when the last user releases it.

### Mipmaps

- KTX2 files should contain mips (`toktx --genmipmap`, gltf-transform does this).
- Data textures: `tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter` if never minified.
- Render targets: no mips unless sampled minified.

## 9. Common mistakes

1. Treating file size as memory size.
2. sRGB normal maps (lighting looks wrong) or linear albedo (washed out).
3. Atlas bleeding at mip levels — pad islands, or use `texture.generateMipmaps` with gutter.
4. `anisotropy = 16` on everything.
5. Uploading textures during gameplay (a 2k PNG upload can hitch 10–30 ms). Preload + `renderer.initTexture(tex)`.
6. Material dispose assumed to free textures.
7. Per-chunk CanvasTexture / DataTexture never disposed on unload.

## 10. Profiling / debugging

- HUD (`F3`): `textures` count from `renderer.info.memory.textures` — should plateau while walking.
- Estimate VRAM: sum `w*h*bpp*1.33` over loaded textures in a debug dump (`TextureLibrary.report()`).
- Spector.js: inspect texture formats (look for `COMPRESSED_RGBA_BPTC_UNORM` etc. — uncompressed RGBA8 is a flag).
- Chrome Task Manager (`Shift+Esc`) → GPU memory column.
- Visual mip debug: temporarily replace a texture with a coloured-mip texture to see which mip levels are used.
