# DARK — asset list (environment first)

Goal: replace the code-built placeholder shapes with painted, stylized models that match `refer/`
(roads hero, forest, vista). Placement stays procedural — every model below is scattered/instanced by the
world generator, so each world is still unique.

## Style prompt (use for every asset)

> Stylized hand-painted low-poly game asset, painterly concept-art look like a cozy-horror adventure game
> (Firewatch / Alba style), soft gradients painted into the texture, no photoreal detail, no text, no base
> plate, centered, neutral lighting (no baked shadows or highlights), dusk forest palette: deep blue-greens,
> warm ochre highlights.

Add the per-asset description after it.

## Technical rules (all assets)

| Rule | Value |
|---|---|
| Format | `.glb`, Y-up, 1 unit = 1 m, pivot at the base centre on the ground |
| Materials | 1 material per asset, base-colour texture only (no normal/roughness maps needed) |
| Texture | power of two; sizes below; will be converted to KTX2 by the pipeline |
| Foliage | leaves/needles as alpha-cut cards (PNG alpha), no alpha blending |
| Levels | `lod0` near, `lod1` ≈ 40 % tris, `lod2` ≈ 10 % (or a billboard) — AI tools: generate lod0, we simplify the rest |
| Check | `npm run validate:assets` (budgets per category) |
| Naming | `src/assets/models/<category>/<name>.lod0.glb` |

## Priority 1 — forest (biggest visual change)

| # | Asset | Description to add to the prompt | Tris lod0 | Texture |
|---|---|---|---|---|
| 1 | `trees/spruce_a` | tall narrow spruce, 12 m, ragged drooping branch clumps, gaps showing through, narrow spiky top, reddish-brown trunk | 1.5–3 k | 1024² atlas |
| 2 | `trees/spruce_b` | older, wider spruce, 14 m, heavier lower branches | 1.5–3 k | shares 1 |
| 3 | `trees/pine_tall` | tall pine, long bare orange-brown trunk, flat clumped crowns in the top third, 15 m | 1–2 k | 1024² |
| 4 | `trees/fir_young` | young fir, 5 m, dense, soft rounded tiers | 800–1.5 k | shares 1 |
| 5 | `trees/aspen` | white-barked aspen/birch, 8 m, yellow-green round leaf clusters | 1–2 k | 1024² |
| 6 | `trees/dead_snag` | dead grey tree, broken top, bare crooked branches | 300–600 | 512² |

## Priority 2 — ground & roadside

| # | Asset | Description | Tris | Texture |
|---|---|---|---|---|
| 7 | `rocks/boulder_a…c` (3 shapes) | rounded boulders, slate blue-indigo with warm mauve top faces, a little moss | 200–500 each | 512² shared |
| 8 | `rocks/cliff_chunk` | layered blue-grey rock face chunk, 6 m, for slopes | 800–1.5 k | 1024² |
| 9 | `plants/fern_cluster` | lush fern clump, arched fronds | 150–300 | 512² atlas |
| 10 | `plants/bush_leafy` | low broad-leaf forest bush | 200–400 | shares 9 |
| 11 | `plants/wildflowers` | clump of small yellow wildflowers + grass | 100–200 | shares 9 |
| 12 | `plants/grass_tuft` | tall grass tuft, olive to ochre tips | 30–60 | shares 9 |
| 13 | `props/fence_segment` | weathered wooden rail fence, 4 m, 2 rails | 100–200 | 512² |
| 14 | `props/power_pole` | wooden utility pole with crossarm and insulators, 10 m | 150–300 | 512² |
| 15 | `props/log_fallen` | mossy fallen log, 5 m | 200–400 | 512² |

## Priority 3 — landmarks (hero shot)

| # | Asset | Description | Tris | Texture |
|---|---|---|---|---|
| 16 | `props/sign_hawkins` | green town sign "HAWKINS 2 MILES" on two wooden posts (text in texture) | 100–200 | 512² |
| 17 | `props/pickup_rusty` | abandoned 80s pickup truck, faded paint, rust | 3–6 k | 1024² |
| 18 | `props/water_tower` | old metal water tower on four legs, 25 m | 1.5–3 k | 1024² |

## Later — characters (you said later)

kid with cap + backpack (rigged, 5–8 k tris, 1024²) · BMX (2–4 k) · stalker monster · strider monster.

## Hand-off

Drop the `.glb` files into `src/assets/models/<category>/` and tell me. I will validate, simplify LODs, compress
textures, remap them onto the shared painterly material (rim light, sky fog, haze), and swap them into the
procedural scatter in place of the code-built shapes — no gameplay changes needed.

## Credits (CC-BY-4.0 — attribution required, keep this section)

| Asset | File | Author | Source | Licence | Notes |
|---|---|---|---|---|---|
| Player character "Stickman" | `src/assets/models/characters/human.lod0.glb` | ogulcantopsakal | https://sketchfab.com/3d-models/stickman-76d732e35c23477fae863dfe280b30bb | CC-BY-4.0 | static mesh; rigged + animated in code (`CharacterModel`) |
| "Pickup Truck" | `src/assets/models/vehicles/pickup_truck.lod0.glb` | 00amza | https://sketchfab.com/3d-models/pickup-truck-047615f53e2d45b9a1a2a4dd203d459c | CC-BY-4.0 | wheels split out at load (`assets/loadModels`) |
| "2015 Mercedes-Benz G500 4x4² concept" | `src/assets/models/vehicles/mercedes_g500_4x4.lod0.glb` | **TODO: author from the Sketchfab download page** | (Sketchfab) | CC-BY-4.0 (verify) | textures stripped to flat material colours (`scripts/strip-glb-textures.mjs`, 8.7 → 2.3 MB); wheels found by node name |
| "Free Zuk 3D model" (FSC Żuk A06) | `src/assets/models/vehicles/zuk_a06.lod0.glb` | **TODO: author from the Sketchfab download page** | (Sketchfab) | CC-BY-4.0 (verify) | one textured mesh; wheels split out by shape |

The in-game credits screen (when there is one) must list these too.

### Audio (all CC0 — public domain; attribution not required, given anyway)
| Sound | File(s) | Source | Author | Licence | Processing |
|---|---|---|---|---|---|
| Theme "Gone Fishin'" (banjo) | `src/assets/audio/music/gone_fishin.mp3` | https://opengameart.org/content/gone-fishin | Memoraphile (You're Perfect Studio) | CC0 (also CC-BY 4.0 / OGA-BY 3.0) | loudness −20 LUFS, 112 kbps |
| Engine drive loop | `car/engine_drive.wav` | https://opengameart.org/content/racing-car-engine-sound-loops | domasx2 | CC0 | loop crossfaded, −16 LUFS |
| Engine idle, start, stop, door | `car/engine_idle.wav`, `engine_start.mp3`, `engine_stop.mp3`, `door.mp3` | https://opengameart.org/content/car-sound-effects-pack-low-quality | GGBotNet | CC0 | idle loop crossfaded, levelled |
| Tyre squeal (drift) | `car/skid.mp3` | https://bigsoundbank.com/tire-squeal-s0500.html | Joseph Sardin (BigSoundBank) | CC0 | 12 s loop crossfaded |
| Boost rush (wind) | `car/boost_wind.mp3` | https://opengameart.org/content/wind-whoosh-loop | SketchMan3 | CC0 | loop crossfaded |
| Bicycle freewheel | `bike/freewheel.mp3` | https://bigsoundbank.com/detail-0140-bicycle-rear-wheel.html | Joseph Sardin (BigSoundBank) | CC0 | 14 s loop |
| Bicycle rolling | `bike/roll.mp3` | https://bigsoundbank.com/bike-on-a-road-mtb-s1282.html | Joseph Sardin (BigSoundBank) | CC0 | 14 s loop |
| Rain | `ambience/rain.mp3` | https://opengameart.org/content/rain-loopable | Ylmir | CC0 | 24 s loop crossfaded |
| Footsteps (10) | `steps/step0–9.mp3` | https://kenney.nl/assets/rpg-audio | Kenney | CC0 | levelled |
