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
