---
name: mobile
description: Read before adding ANY feature — quality tiers (low/medium/high), the ≥60 fps floor on ₹15k phones and low-end PCs, adaptive resolution, touch controls, thermal limits and how to verify in headless Chrome and on a real phone.
---

# Mobile, low-end PCs and quality tiers

## 1. Purpose

DARK must hold **≥ 60 fps minimum on every supported device** — a ~₹15k Android phone (Mali-G57 / Adreno 610
class), an Intel UHD laptop, and desktops — while running **uncapped above 60** (the browser's
`requestAnimationFrame` runs at the display refresh: 60/90/120/144 Hz; we add no cap of our own).
Every world is procedural and unique per game, so nothing can be pre-baked per world: all cost is paid at runtime
and must scale with the device.

## 2. Architecture

```
DeviceProfile (GPU string, mobile UA, cores, RAM) ──► initial tier (never above HIGH)
                                                         │
resolveQuality(preset, Settings.gfx overrides)           │
   = PRESETS[tier].base + FEATURE_TABLE[f][level] ──► Game.applyQuality ──►│ world ring, LOD rings, plants, build budget
                                                         │ sun shadow size/extent/cadence, flashlight shadow
                                                         │ MSAA, DPR cap, render-scale range, fog floor, camera far
AdaptiveQuality (per frame: raw frame ms, GPU ms, CPU ms)
   over budget  → render scale −0.1 … tier min → tier −1
   headroom     → render scale +0.1 → tier +1 (desktop only past medium, never past HIGH)
```

**Presets × features** (Settings → Graphics; 'auto' = the preset's level). LOW/MEDIUM/HIGH feature levels are the
old tier values, so those presets render as before. Off levels are real savings (no pass at all).

| Feature | LOW | MEDIUM | HIGH | ULTRA |
|---|---|---|---|---|
| Shadows | 1024², every 3rd frame, blob shadows for vehicles | 1024², every 2nd | 2048², every frame, torch shadow | 4096² over 140 m |
| Reflections (planar, only while water is visible) | off — sky colour only | ¼ res, every 2nd frame | ½ res | ¾ res |
| Ambient occlusion (SSAO) | off | off | ½ res, 10 taps | full res, 16 taps |
| Volumetric light & fog | 8 steps, no banks | 14 steps + banks | 16 + banks | 24 steps, ⅓-res |
| View distance | ring 2, 230 m | ring 3, 330 m | ring 3, 420 m | ring 4, 540 m, 5.6 km horizon |
| Grass (own setting, Off–Ultra) | 12 m radius | 15.5 m | 22 m | 30 m, denser |
| Ground & weather detail (Off–High) | off (+ no bloom) | tracks, relief, ½ drift | + heat shimmer, full drift | = High |
| Sky resolution (`skyScale`) | ¼ | ⅓ | ½ | full |
| Trees & bushes (Low–High) | no undergrowth, mid-detail trees, no far rocks | undergrowth, full trees | + far rocks | = High |

Measured (M4, 1280×720, headless, seed 7): frozen river LOW 66 draws / 132 k tris → MEDIUM 74 / 175 k →
HIGH 172 / 447 k → ULTRA 242 / 843 k; forest LOW 84 / 148 k, HIGH 160 / 451 k, ULTRA 228 / 867 k — all 60 fps.
SSAO (HIGH level) ≈ +0.3 ms GPU, +2 draws. All features off on HIGH: 159 → 106 draws.

**Phone pass (2026-10-05)** — measured with the §10 phone emulation + a FILL proxy (LOW/MEDIUM settings rendered at
2–8 MP on the M4, where per-pixel cost dominates GPU ms the way it does on a fill-bound phone GPU):
- The SKY was the most expensive pixels (2.4 of 16 ms at 8 MP on LOW: gradient + 3-octave clouds + mist, twice).
  `SkyDome.prepare` now draws it into a small target (`QualitySettings.skyScale`: LOW ¼, MEDIUM ⅓, HIGH ½, ULTRA 1)
  that the dome samples by screen position; stars are added at full resolution so they stay crisp.
- LOW now has ONE post pass (bloom off via `fx.bloom`); the new "Ground & weather detail" feature (`fx`) gates the
  snow/sand micro-relief + glints, the track map (an extra RT), the blowing-grain particles and the heat shimmer —
  all off on LOW, half on MEDIUM. MEDIUM has no planar reflections. Biome-cover lookups are skipped when no snow /
  sand is near (`uBiomeActive`). Hold-60 no longer re-resolves the preset every frame.
- SMALL PHONES: in AUTO, once at LOW at minimum render scale, the Hold-60 steps continue (effects + bloom,
  volumetrics, grass, view, trees… and sun shadows last) down to `HOLD_FLOOR` instead of stopping at "minimum".
- Result (GPU ms, 1920×1080, seed 7, old build → now): LOW forest 3.95 → 2.52, snow 3.77 → 2.26, desert 2.50 → 2.26;
  MEDIUM forest 5.02 → 4.83, snow 4.38 → 5.12, desert 4.17 → 4.59 (snow/desert detail; Hold-60 / auto drop to LOW on
  weak devices). LOW draws 51–87, tris 74–122 k (budget 100 / 200 k). CPU (×4 throttle profile): main thread ~70 %
  idle, no hot spot — phones are fill-bound here. Programs 23 on LOW (budget 10; was 20 before) — a load-time cost,
  still to do. Real-device numbers are still required (below).

**Snapdragon 6xx pass (2026-10-06)** — target: Adreno 610/612 (SD 662/665/680), Adreno 618/619 (SD 720G/695).
Method (headless, M4): split the LOW frame at FULL GPU clocks (4K canvas keeps the post pass busy) into fixed scene
work (scene RT shrunk to 0.05 MP), per-pixel scene work and per-pixel post, 3 runs, medians; project
phone ≈ R × [fixed + scenePerMP × 0.21 MP + postPerMP × 0.38 MP] with R ≈ 25 (Adreno 610) / 15 (618/619).
Single runs of the fixed term swing ±0.3 ms (±7 ms projected) — always repeat. Findings and fixes:
- Terrain shader = most expensive pixels (≈ 0.9 ms/MP on the M4): ~30 `fract(sin)` hashes per pixel. `st_hash` is now
  sin-free (Hoskins hash12, also correct on mediump); LOW (`uSurfaceDetail` = 0, a uniform branch → no recompiles)
  skips the fine noise layers, meadow streaks/gusts, sand ripples, snow sparkle and uses staggered cliff columns
  (2 hashes) instead of the 3×3 Voronoi (18); shore foam is evaluated on the shoreline only (all tiers).
- Grading pass: shaft composite (5 fetches + 4 exp), bloom fetch and painterly grain are skipped when off (`uRaysOn`,
  `uBloom`, `uPaintFx`).
- Trees: species geometry is INDEXED (`mergeVertices` in createTreeLibrary): 40–70 % fewer vertex-shader runs
  (sway + billboard + per-vertex sky fog), identical image. Forest fixed GPU 1.09 → 0.34 ms (M4, full clocks).
- 8.3 MP LOW frame (M4) before → after: spawn 14.2 → 13.0, cliffs 13.1 → 11.5, vista 14.2 → 12.2, lake 14.0 → 12.0,
  desert 16.3 → 12.9, snow 17.4 → 13.9, forest 13.1 → 12.6 (+ the fixed-cost cut above).
- Projection now: Adreno 618/619 ≈ 6–10 ms (60 fps with headroom at LOW defaults); Adreno 610 ≈ 11–17 ms (R 25;
  up to ~24 ms if R is 35) — 60 at LOW defaults in most places, AUTO lowers render scale (0.75 → 0.6) in dense forest.
- CPU (915×412 @2.625, CPU ×6, streaming at 30 m/s for 20 s): mean 2.0 ms, p99 4.9 ms, 2 frames > 16.7 ms.
- Tried and REVERTED: LOW canvas at 0.75 DPR + scene 100 % (grading pass on 45 % fewer pixels, ≈ −2 ms projected) —
  the browser's upscale made tree/grass edges visibly blocky on a phone.
- Still required: a real Snapdragon 6xx device (§10) — the M4 projection is a ratio estimate.

**MSAA × depth readers (2026-10-05)** — the biggest single cost found: with MSAA 4× (the old HIGH/ULTRA default)
every pass that SAMPLES scene depth (SSAO, volumetric light, grading) forces a multisampled depth resolve. Measured
HIGH 1080p (M4): vista 14.4 → 8.0 ms, forest 9.4 → 6.5 ms, 720p 12.5 → 6.6 ms with FXAA; SSAO alone 4.6 → 0.9 ms;
no visible difference (FXAA + sharpen). Tile-based phone GPUs pay resolves worse. Defaults are FXAA on every tier;
ULTRA SSAO renders at ¾ res (full res was +3.1 ms). Never re-enable MSAA by default while a pass reads depth.
Probes: scratchpad-style `ablate` (feature off one at a time, warm-up first — the first sample is high) and a
streaming probe (player moved at 35 m/s, CPU ×4: mean 2.4 ms, 1 hitch in 20 s → streaming is not the problem).

**Stutter pass (2026-10-05)** — "fps drops" on phones are FREEZES, not low averages:
- SHADER WARM-UP (`Game.warmShaders`): once the world is ready, `renderer.compileAsync` over the whole scene with
  hidden objects forced visible + stand-ins (non-instanced rock / vegetation / landmark / terrain), compiled against
  `post.target` (LINEAR output — against the canvas it built the unused sRGB variants: 58 programs, the real rain /
  drift ones still compiled later). Now 45 programs in ~0.8 s at load (M4), 1 tiny pass compiles later (trail copy).
- HOLD 60 restores of SHADOWS (define change → every lit program recompiles), GRASS, TREES, VIEW (rebuilds) wait
  90 s after the last step down; a restore that got reverted stays down for the session (`Game.holdRestoreOk`).
- Landmarks: 3 bands (near = full + shadows, ≤ 350 m full, far LOD ≈ ½ tris, no small parts / rotors), range per
  tier `landmarkRange` 700 / 1000 / 1500 / 2200 m. Horizon tree dots softened (read as dark objects on far hills).
- GPU after the MSAA fix (1080p, M4): LOW forest/vista 2.3/2.6 ms, MEDIUM 4.8/5.1, HIGH 6.5/7.7, ULTRA 10.7/12.2.

**Grass** (`world/Forest/GrassField.ts`): NEAR layer (dense, curved blades, 4 m tiles) to ~45 % of the radius +
FAR layer (32 % of the blades, single wide triangles) to the edge, crossfaded blade by blade; per-patch density
interpolated from an 8 m meadow grid (`iDensity`), per-patch terrain gradient (`iSlope`, blades stand on the slope —
flat patches made terraced rows on hillsides), per-blade random thresholds for thinning and the ragged edge.
Measured HIGH: grass 240 k → 126 k triangles (scene 483 k → 371 k); LOW scene 154 k → 99–126 k.

**Hold 60 fps** (Settings → Graphics, default on; `Game.held`, `QualityTiers.nextHoldStep`): on a preset the player
CHOSE, adaptive quality keeps running — render scale first (down to 0.65), then features one level at a time, the
four GPU effects lowered evenly (reflections, AO, shadows, volumetrics — whichever is highest), then vegetation and
view distance, floors in `HOLD_FLOOR`; restored in reverse with headroom (blind probes, reverted if they cost frames).
Runtime only, shown in Settings ("lowered for now: …"). The chosen preset is the ceiling.
**30 fps cap probe** (`Game.updateCapProbe`): ~33 ms frames for 3 s → 16 frames draw nothing while timed; still
~33 ms with < 12 ms of our own CPU → the browser/OS caps the page (iOS Low Power Mode, Android battery saver):
`store.fpsCap` notice, quality untouched. Verified headless by halving requestAnimationFrame (cap → notice) and with
`?stress=31` (our CPU → not a cap → Hold 60 steps). Measured: ULTRA ≈ 12 ms GPU on an M4 at 1280×720 — a phone GPU
is several times slower, so ULTRA on a phone settles near HIGH with Hold 60; no phone holds desktop ULTRA at 60.

| File | Role |
|---|---|
| `src/rendering/quality/QualityTiers.ts` | presets + feature level tables (`resolveQuality`) — the single source of every budget |
| `src/rendering/quality/DeviceProfile.ts` | initial guess (it is only a guess) |
| `src/rendering/quality/AdaptiveQuality.ts` | pure controller, unit-tested in `tests/adaptive.test.ts` |
| `src/game/Game.ts` → `applyQuality`, `onAdaptive` | applies settings to systems |
| `src/input/TouchControls.tsx`, `src/input/Input.ts` | joystick, look-drag, buttons |

### Tier table (current values)

| | LOW | MEDIUM | HIGH |
|---|---|---|---|
| Devices | ₹15k phones, Intel HD/UHD, software GL | Adreno 7xx, recent iPhone, Iris Xe, Radeon iGPU | discrete, Apple M |
| Render ring | 2 (~128 m) | 3 | 4 |
| LOD rings | 1.5 / 2.2 | 1.5 / 2.6 | 1.5 / 3.5 |
| DPR cap | 1 | 1.25 | 1.5 |
| Render scale | 0.5–0.85 (start 0.75) | 0.6–1 (0.85) | 0.7–1 (1) |
| MSAA | 0 | 0 | 4 |
| Sun shadow | 1024², every 3rd frame, ±26 m | 1024², every 2nd, ±32 m | 2048², every frame, ±36 m |
| Flashlight shadow | off | off | 512² |
| Small plants | off | on | on |
| Chunk builds/frame | 1 | 2 | 2 |
| Anti-aliasing (default) | FXAA + sharpen 0.35 | FXAA + sharpen 0.25 | FXAA + sharpen 0.25 (MSAA optional) |
| God rays | 1/6 res, 12 samples | 1/4 res, 20 | 1/4 res, 32 |
| View distance (fog complete, nothing drawn beyond) · horizon | 280 m · 640 m/32² | 440 m · 1 km/44² | 1 km · 2.2 km/80² |
| Pixel budget (scene RT) | 0.6 MP | 1.4 MP | 2.4 MP |
| Painterly filter · bloom | off (Settings can force) · 0.45 | 1.4 px · 0.55 | 1.8 px · 0.6 |
| Grass field (radius / clumps·m⁻² / blades) | 16 m / 1.6 / 5 | 24 m / 1.3 / 6 | 36 m / 2.6 / 8 |
| Trees near (level) · LOD0 ring | mid (≈50–100 tris) · 0.9 | full (≈150–250) · 1.0 | full · 1.5 |
| Rocks on far chunks · lean shadow casting | off · on | on · off | on · off |
| Fog complete by (`fogLimit`) | 124 m | 188 m | 252 m (clear near field on all tiers) |

Measured in headless Chrome (Apple M4, 1920×1080 CSS, vsync off, seed 1337, after walking):

| | LOW | MEDIUM | HIGH |
|---|---|---|---|
| Draw calls mean / peak | 76 / 99 | 126 / 147 | 261 / 261 |
| Triangles mean / peak | 152 k / 199 k | 343 k / 414 k | 1.25 M |
| Uncapped fps | ~640 | ~318 | ~99 |

(Measured 1920×1080 CSS, DPR 1.5, 15:00, 90 consecutive frames incl. shadow-update frames; 5 tree species,
grass field, ferns, sky, volumetric shafts, TPP character. MEDIUM triangle budget raised to 420 k — its GPUs
handle it; draw calls, the real limiter there, stay under 160.)

A ₹15k phone GPU is roughly 1/15–1/25 of an M4. LOW at ~770 fps here ⇒ expect ~40–70 fps on such a phone before
adaptive scaling; render scale 0.5 roughly halves fill cost. **Real-device numbers are required** (§10).

## 3. When to use

Always. Every new feature must add a row to the tier table (or state "same on all tiers") and give its
LOW-tier cost. Examples: a new prop type → per-tier density/LOD; a new light → which tiers get it; a new post
effect → LOW must be able to skip it.

## 4. When NOT to use

- Don't branch on user agent in feature code. Read `game.quality` (the tier). Device detection happens once.
- Don't fight the adaptive controller with per-feature frame-time checks — one controller only.
- Don't lower art identity first. Order of sacrifice: resolution → MSAA → shadow cadence/size → small props →
  view ring (with denser fog) → shadow casters. Fog, grading, silhouettes, flashlight stay on every tier.

## 5. Performance implications

- **Phone GPUs are bandwidth/fill bound** (tile-based). Cost ∝ pixels × passes × overdraw. Hence DPR 1,
  render scale ≤ 0.85, no MSAA, one post pass, no transparency-heavy effects on LOW.
- **Phone CPUs are ~4–6× slower** than desktop for JS. Draw calls cost more; keep LOW ≤ 100 calls incl. shadow.
  Chunk generation runs in workers (~0.7 ms desktop → ~3–5 ms phone, off the main thread).
- **Memory:** mobile browsers kill tabs around 1–1.5 GB. Keep GPU memory ≤ 150 MB on LOW (no MSAA buffers,
  1024² shadow = 4 MB).
- **Thermal throttling:** phones drop clocks 30–50% after minutes of sustained load. That is why the adaptive
  controller keeps running during play, and why phones never auto-upgrade past MEDIUM.
- **Battery:** uncapped fps on a 120 Hz phone doubles work. That is the user's requested behaviour; a
  "battery saver: cap 60" setting can be added later without touching systems.

## 6. WebGL limitations on mobile

- Render-to-half-float needs `EXT_color_buffer_half_float` / `EXT_color_buffer_float`. `PostPipeline.configure`
  falls back to 8-bit (expect some banding in night fog; grain masks it).
- `maxSamples` may be < 4 — `setSamples` clamps.
- `EXT_disjoint_timer_query_webgl2` is usually missing on phones → GPU ms = n/a → the controller uses the blind
  probe (one step, revert on regression, back-off 60 s → 10 min).
- `highp` in fragment shaders is slower on Mali; three defaults to highp — acceptable for now, revisit with
  profiling.
- Shader compile is slow on phones (100–500 ms per program): keep program count ≤ 10; tier switches that toggle
  flashlight shadows recompile lit programs (rare, accepted).
- **Every `castShadow` light must have a shadow map before the first draw.** Programs compiled with shadow
  samplers read it; a null map binds a non-depth texture and WebGL rejects every lit draw call
  (`GL_INVALID_OPERATION: Mismatch between texture format and sampler type`) → a fog-only frame.
  `LightingSystem.update` forces `shadow.needsUpdate` when a map is missing. (Found by the headless tests.)
  Same rule for our own passes: the shafts shader's `sampler2DShadow` is bound to a 1×1 dummy comparison depth
  texture whenever the key light has no map yet (`PostPipeline.dummyShadow`).

## 7. R3F implementation

- `<Canvas dpr={1}>`; the tier sets the real DPR through `useThree(s => s.setDpr)` (passed to `game.attach`).
- Touch UI is a DOM overlay (`TouchControls`) above the canvas, pointer events with `touch-action: none`, one
  `pointerId` per zone (multi-touch: move + look at once). Knob and values are written through refs — **no
  React state per touch move**.
- `store.touch` switches between `LockHint` (desktop) and `TouchControls` (touch). It becomes true on a coarse
  pointer or the first `touchstart` (touch laptops).

## 8. Direct Three.js implementation

```ts
// Tier application (Game.applyQuality) — each line is the cheapest way to change that cost.
world.setQuality(q)                          // ring/LOD/plants: next update re-rings, no rebuild of kept chunks
lighting.setQuality(q)                       // shadow map realloc only if size changed; cadence via shadow.needsUpdate
post.setSamples(q.msaa, caps.maxSamples)     // realloc renderbuffers once
post.setRenderScale(q.renderScale.start)     // resize RT only
setDpr(Math.min(devicePixelRatio, q.maxDpr))
camera.far = cameraFar(q.renderRadius); camera.updateProjectionMatrix()
fog.far = min(phase.fogEnd, fogLimit(q.renderRadius)); fog.near = min(phase.fogStart, 0.55 * fog.far)
```

Shadow cadence (static world casters): `sun.shadow.autoUpdate = false` and
`sun.shadow.needsUpdate = true` every N frames. The shadow matrix only updates when the map re-renders, so map
and sampling stay consistent; the frustum just lags N frames (≈0.3 m at sprint speed with N = 3).

## 9. Common mistakes

- Hill-top views: everything is in the frustum at once. Cap it with the tier's `viewDistance` (fog + `ChunkVisibility.maxDistance` + horizon size), not with post effects.
- DETAIL-BOUNDED RENDERING (both art styles): streamed detail (trees, rocks, props, buildings) dithers out at
  the ring edge (`uCullFade`, ≤ `viewDistance`: LOW ~152 m, MED ~216, HIGH ~216) and chunks past it are not drawn.
  Beyond, ONE warped horizon-terrain mesh (LOW 2.4 km/40², MED 3.2 km/52², HIGH 4.4 km/72²; dense near the player,
  coarse at the rim) shows real hills to the skyline under a PARTIAL blue-green haze (TimeOfDay `fogMax`/`landHaze`)
  — no white fog wall; only its outer rim fades into the sky. Hilltop view HIGH: GPU 7.5–8.3 ms (M4 2560×1440). HIGH ring 3 (was 4), tight LOD rings, low-poly rocks at
  LOD1 (20 tris vs 80), HIGH grass radius 22 m (was 28). Measured M4 2560×1440, 5 spots: HIGH draws 225–281 →
  176–188, tris 815–1087k → 540–817k, GPU −0.1…1.1 ms, CPU −0.2…0.4 ms; LOW tris −1…24 %, GPU −0.1…0.5 ms.

- Reading `RADIUS.render`/`LOD_RINGS` constants — they no longer exist; use `game.quality`.
- Letting `fog.far` exceed `fogLimit(radius)` → the ring edge pops on LOW.
- Measuring "fps" in headless Chrome without `--disable-gpu-vsync --disable-frame-rate-limit` (capped at 60).
- Judging phone performance from desktop emulation — emulation fakes screen/touch/UA and can slow the CPU, but
  the GPU is still the desktop's.
- Tier-up on phones — works for 2 minutes, then thermals throttle and the game stutters.
- Toggling `castShadow` on the flashlight when the flashlight is turned on/off (recompiles every lit shader).
  Use intensity + `shadow.autoUpdate`; `castShadow` is a tier decision.

## 10. Profiling / verification

Automated (headless Chrome, `playwright-core` in the scratchpad, not a project dependency):

| Check | How |
|---|---|
| Uncapped fps per tier | `?seed=1337&tier=low\|medium\|high&adaptive=0`, flags `--disable-gpu-vsync --disable-frame-rate-limit` |
| Auto detection | default URL; HUD line `tier … last: <tier> (<reason>)` |
| Degradation chain | `?stress=22` (dev-only busy-wait) → scale ↓ → tier ↓ → `at minimum quality`, no oscillation |
| Phone emulation | viewport 915×412, DPR 2.625, `isMobile`, `hasTouch`, Android UA, CDP `Emulation.setCPUThrottlingRate {rate: 4}` |
| Touch | CDP `Input.dispatchTouchEvent`: joystick drag moves player, second finger turns, buttons fire |
| GL errors | fail on any console `GL_INVALID_*` |
| Controller logic | `npm test` (`tests/adaptive.test.ts`) |

Real device (required before claiming a phone target is met):
1. `npm run dev:lan`, open the printed `Network:` URL on the phone (same Wi-Fi).
2. Landscape, tap ⛶ for fullscreen, FPS button toggles the compact HUD.
3. Record after 5 minutes of play (thermal): fps, worst frame, tier, scale. Report GPU name from the HUD
   (desktop HUD shows it; on the phone read `game.device.gpu` via remote debugging `chrome://inspect`).
