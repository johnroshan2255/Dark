---
name: art-direction
description: Read before changing any material, shader look, vegetation, sky, fog, palette or grading — the painterly toolkit that makes DARK read like refer/ (roads hero, forest) instead of a faceted low-poly toy, and its cost per tier.
---

# Art direction (matching refer/)

## 1. Purpose
The references are painterly stylized concept art: soft gradient shading, feathery foliage, rim-lit
silhouettes, layered aerial perspective (ridges fading into haze), a low sun in a gap, warm/cool split colour,
roadside props. This skill lists the real-time techniques that get us there within the phone budgets.

## 2. Architecture (what produces the look)

| Reference trait | Technique | Where |
|---|---|---|
| **GENSHIN DAY (default start 10:30)** | Saturated blue zenith, white cumulus (`uSkyCloudWhite`), bright sky-blue hemi fill (light cool shadows), low haze, sat 1.2, no vignette/grain; vivid green ground palette; warm-grey mossy rocks. Night/dusk/nightmare keep the horror mood | `TimeOfDay.ts` DAY, `skyShader.ts`, `groundColor.ts` |
| Cel shading | N·L through a narrow smoothstep ramp in `RE_Direct_Lambert` (× `uToon` per phase, terrain ×0.45 so hills keep shape). ~3 ALU per light per fragment, all tiers, no extra draws | `stylize.ts` |
| Places you can find | Home farm guaranteed 110–230 m down the road from spawn; compass markers (car, bike, 6 nearest places, 600 m range), nearest-place line, arrival banner. HUD query every 0.5 s (~121 cached region lookups) | `POI/pois.ts` (`home`, `poiName`), `ui/GameHud.tsx` |
| Soft, painted volumes | Smooth shading everywhere (rocks excepted); canopy normals pointing out of the crown | `MaterialLibrary`, `Forest/treeFactory.ts` |
| Genshin grass (current) | INDIVIDUAL blades: 1 m² patches of 18–34 separately placed blades (1-tri LOW, 3-tri curved MED/HIGH), indexed, opaque; per-blade wind + rolling gusts, parting around the player, distance thinning; ground painted as meadow beyond. Grass GPU: LOW ≈0, MED ≈0.1 ms, HIGH ≈1 ms (M4) | `Forest/grass.ts`, `GrassField.ts` |
| Leaf-cluster canopies | Billboarded tufts use a Genshin leaf-cluster texture (individual pointed leaves, serrated outline) | `FoliageAtlas.ts` (`drawTuft`) |
| FLUFFY grass (old, cards) | Crossed alpha-cut cards (2 on LOW, 3 elsewhere) of a procedurally painted mound-shaped tuft texture; all normals UP (lights as one soft mass); base→tip gradient + two world-noise tip hues. 4–6 tris/clump (was 15–24 blade geometry). Technique from Codrops "fluffiest grass" (concepts only) | `Forest/grass.ts` |
| FLUFFY tree canopies | Camera-facing TUFTS (vertex-shader billboards: `bbCenter`/`bbOff` attributes on the shared foliage material) at conifer branch tips, around pine pads, as the whole birch crown and on bushes; normals from the crown centre | `treeFactory.ts` (`tuft`), `MaterialLibrary` (`billboardable`) |
| Ragged painted spruce | 42 irregular drooping branch clumps (golden-angle spiral, ±35 % length, 8 % skipped) of 2 crossed branch-spray cards on a thin core; far level = solid skirts | `treeFactory.ts` (`conifer`, `cardUv`) |
| Layered depth | `skyHaze(d)` = haze·(1−e^(−(d−12)/110)) added to the fog in every material + water; per-phase `haze` | `skyShader.ts`, `stylize.ts` |
| Forest floor & undergrowth | needle litter/moss colour under canopy; ferns + leafy bushes (2 draws / near chunk), dense on verges | `generateTerrain.ts`, `WorldChunk.ts` |
| Painted spruce/fir silhouettes (old) | Stacked drooping star-cone SKIRTS (long/short points, tips below the base) + hanging serrated needle-FRINGE cards on each rim; narrow spire | `Forest/treeFactory.ts` (`skirt`, `conifer`) |
| Tall pines | Long bare trunk + flat drooping pads in the top third | `treeFactory.ts` (`pine`) |
| Roadside birch/aspen | Cumulus of lumps shaded as ONE volume (normals from crown centre) → bumpy outline, smooth light | `treeFactory.ts` (`crownLump`) |
| Tufted verges with flowers | Grass clumped by a 5 m mask (soil shows between tussocks), taller blades, olive tips, ~10% clumps with yellow/white flower heads (shader-toggled, no extra draws) | `Forest/grass.ts`, `GrassField.ts` |
| Leaf clusters / needle texture | Greyscale procedural atlas tinted by vertex colour (fringe, leaves, tuft, fern cells) | `materials/FoliageAtlas.ts` |
| Orange-rimmed silhouettes | Rim term toward the key light in every world material | `shaders/stylize.ts` |
| Big hills, valleys, massifs | `WorldFields.naturalHeight`: fbm ±40 m + squared low-freq mountains up to ~110 m + ridged crests; road valley floor 150 m wide (`VALLEY`) | `world/WorldFields.ts` |
| Rivers and lakes | River carved beside the road (`riverShape`, bed below `WATER = -6`), lakes wherever terrain < WATER; ONE camera-following water plane reflecting `skyColor` + Fresnel + ripples + glint | `WorldFields`, `rendering/water/Water.ts` |
| Views from hills to the horizon | HORIZON terrain: one worker-generated WARPED mesh (LOW 2.4 km/40², MED 3.2 km/52², HIGH 4.4 km/72²; fine near the player, coarse at the rim, sunk by 3 m + 4 % of cell size so chords never poke through), forest-tinted, discarded inside the loaded chunks. Land haze is PARTIAL (`fogMax` day 0.62) and tinted blue-green (`landHaze` × sky colour) so far hills stay hills; only the mesh rim fades to sky. Trees/props dither out at the ring edge (`cullFade`). Sky-shader ranges: hazy blue-green land colour, whole-face lighting (no crag stripes), sun share capped (never white) | `world/Terrain/HorizonTerrain.ts`, `horizonGen.ts` |
| Cliff massif beside the sunset, low hill under the sun, forested foothills | `ridgeFar`/`ridgeNear` in the sky function: Gaussian massif at az≈2.4 with sawtooth crags, dip at az≈2.0, serrated near treeline; face lighting from a WIDE slope stencil (narrow → vertical stripes) | Mountains drawn in the SKY function (2 layers, haze at base, sun-lit ridge lines, low pass at sunset azimuth) | `sky/skyShader.ts` |
| Distance melting into sky | SKY-COLOURED FOG: fogged fragments take `skyColor(dir)` → hills dissolve, ridges/sun show through | `stylize.ts` fog replacement |
| Road with character | Painted in the terrain shader from per-vertex `roadLat`: asphalt grain, hairline cracks, worn yellow dashes, broken edge lines, gravel shoulders | `stylize.ts` (terrain) |
| Valley road, long view (straight runs, trees ≥ 12 m back, higher TPP camera 4.4 m / 2.3 m pivot) | Terrain pulled toward road level in a 48 m corridor; trees set back ≥ 8 m, thickening with distance | `WorldFields.height`, `Forest/scatter.ts` |
| Warm horizon toward the sun, cool elsewhere | Directional horizon in `skyColor` (sun's own orange toward it — never blend orange with the cool horizon, that goes pink); crisp small sun disc | `sky/skyShader.ts` |
| Long tree shadows across the road | Strong key (evening 3.4) vs LOW cool fill (hemi 1.05, blue) — high fill kills shadow contrast | `TimeOfDay.ts` EVENING |
| Back-road asphalt | Narrow (2.7 m half-width), grey-blue with worn lighter patches, faded centre dashes, NO edge lines | `stylize.ts`, `WorldFields.ROAD_HALF_WIDTH` |
| Headlamp/flashlight beams | Additive open cone, bright at the lamp, fading along its length; strongest at dusk | `gameplay/flashlight/LightBeam.ts` |
| Party list + compass | DOM HUD, compass letters moved per rAF via refs (heading-up) | `ui/GameHud.tsx` |
| STORYBOOK art style (Settings → Art style, reloads; `?look=storybook`; default stays Bright) | The forest-house study, fixed per session (`artStyle.ts`, set before materials/geometry are built → no runtime branches). UNLIT painting: `storyPalette` (hue kept, sat ½, luminance lifted/compressed → pastel sage; NaN-guarded) then albedo × `paintLight` × sky-side factor replaces lighting by `painted` (1 day, 0.45 night so moon + flashlight still work); no rim/cel. Sun shadow map KEPT (feeds the volumetric god rays; painted shading hides cast shadows by day); rays/shafts/bloom as in Bright. Stacked-tier brush-fan conifers on orange-red trunks, rust-banded birch snags, orange-red poles; pale slate-blue sky, close pale haze (fog 45→420 m). Monsters stay lit. Measured M4 2.4 MP vs Bright: GPU and CPU equal within noise on HIGH and LOW (spawn HIGH 8.76–8.81 vs 8.79–8.84 ms); draws −5, tris −2 % HIGH / +4 % LOW | `artStyle.ts`, `stylize.ts` (`STORY_GLSL`, `lit`), `TimeOfDay.ts` (`STORY_*`, `painted`, `paintLight`), `treeFactory.ts` (`storyConifer`, `storyBirch`), `FoliageAtlas.ts` (`drawBrushSpray`), `LightingSystem` |
| A-frame forest cabin | Steep shingled roof slabs over a slate-blue plank gable, porch + step, stone chimney; ~150 tris (was ~110), same single draw per POI prop type | `POI/poiGeometry.ts` (Cabin) |
| HAND-PAINTED SURFACES (forest-house study: painted props without per-asset textures) | Solids paint themselves from vertex colour + object-space pos/normal + ONE fetch of a shared 256² tiling brush texture (R strokes, G blotches, B grain, A moss mask; 0.35 MB): STONE (strokes, pale tops, ragged moss caps), WOOD boards (seams, per-board tint, base grime/moss), BARK fibres, ROOF shingles + moss patches, PLAIN strokes. Surface picked by the U inside the atlas's opaque block (`SURFACE_UV`) → no attribute/draw/program added. Ground gets 1 brush fetch (≈1.5 m strokes + blotches). Rocks now soft (normals bent to centre). Measured M4 @2.4 MP: HIGH +0–0.5 ms, LOW within noise (±0.3); painterly filter for comparison +0.7–1.0 ms. Works on LOW where the filter is off | `materials/BrushTexture.ts`, `shaders/paint.ts`, `stylize` (`surface`), `FoliageAtlas.SURFACE_UV` |
| PAINTED look (brush-like colour patches) | Generalized Kuwahara post filter (4 quadrants, 25 fetches/px) on the HDR scene before grading; brush stride per tier (MEDIUM 1.4, HIGH 1.8 px; LOW off by default — Settings can force it) | `postprocessing/PaintShader.ts` |
| Glow around sun, sky, lit edges | Bloom: bright-pass + separable blur at 1/4 res (all tiers) | `PaintShader.ts`, `PostPipeline.ts` |
| Painted canvas | Static diagonal brush-streak texture in the midtones (grading) | `GradingShader.ts` |
| Layered depth haze | Evening fog starts at 30 m (clear near field), sky-coloured | `TimeOfDay.ts` |
| Warm highlights / cool shadows | Split toning per phase (`split`), Neutral tone mapping, lavender evening fill | `GradingShader.ts`, `TimeOfDay.ts` |
| Power lines, fences | Deterministic props along the analytic road; wires as LineSegments | `Road/roadProps.ts`, `Road/propMeshes.ts` |
| Shafts in the haze | Volumetric (shadow-map) shafts, reduced over open sky; screen-space glare kept subtle | `postprocessing/GodRaysShader.ts` |

## 3. When to use
Any new material, prop or effect: patch it with `stylize()` (same rim + sky fog), use the atlas material for
anything vegetation/wood-like (no new program), take colours from the reference palettes below.

## 4. When NOT to use
- Don't add new material types for props — solid parts sample the atlas's opaque texel (`SOLID_UV`).
- Don't brighten with fog; fix albedo/fill (a clear near field exposes dark albedos).
- Don't use alpha BLENDING for foliage (sorting, overdraw, no shadows) — alpha TEST.

## 5. Performance implications
- Foliage cards: overdraw + discard (disables early-z on some mobile GPUs). Measured uncapped on M4: MEDIUM
  455 → 296 fps, HIGH 118 → 96 fps when cards replaced solid cones. LOW uses the mid level (fewer, bigger cards).
- Sky function in fog: evaluated only where fogFactor > 0 (branch); ~60 ALU.
- Road paint: ~40 ALU on terrain fragments; zero geometry.
- Props: +2–3 draws per road chunk (poles, fence, wires).
- Atlas: 1024² RGBA8 + mips ≈ 5.6 MB.

## 6. WebGL limitations
- alphaToCoverage only with MSAA (HIGH) — elsewhere cards have hard alpha-tested edges (FXAA softens).
- Mipmapped alpha shrinks at distance (cards thin out) — the solid core keeps far trees dense.
- LineSegments are 1 px wide regardless of DPR.

## 7. R3F implementation
Nothing React-side: materials and chunk meshes are imperative; the look is materials + sky + grading.

## 8. Direct Three.js implementation
```ts
const m = stylize(new THREE.MeshLambertMaterial({ vertexColors: true, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide }),
                  { key: 'foliage', rim: 0.7, noFlip: true })
// fog in every stylized material:  gl_FragColor.rgb = mix(col, skyColor(worldDir, false), fogFactor)
```

## 9. Common mistakes
- Zero-length vertex normals (a card starting exactly at its canopy centre) → NaN → glowing blobs after paint/bloom. `Soup.vert` guards this.
- Animated full-screen film grain reads as the whole game SHAKING — grain is static per pixel now.
- Faceted shading (`flatShading: true`) on vegetation/terrain — reads as a toy.
- Fog colour ≠ sky → distant geometry becomes a flat wall hiding ridges and the sun.
- Mountains as low as the tree line (invisible); ridges must clear ~9° at 60 m.
- Forest walls at the kerb — the reference's road corridor is open, trees set back.
- Glare/volumetric over open sky → uniform wash that hides the sun disc.
- Duplicate uniform declarations when stacking patches (stylize declares only missing ones).

## 10. Profiling / debugging
Headless side-by-side: `compare.mjs`-style script at 16:45 facing the sun, TPP, 1214×470 (same aspect as
`refer/roads/forest-road-evening-hero.png`). Hide the world (`game.world.root.visible = false`) to inspect the
sky alone. Budgets: `skills/mobile` tier table.
