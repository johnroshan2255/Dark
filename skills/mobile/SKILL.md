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
DeviceProfile (GPU string, mobile UA, cores, RAM) ──► initial tier
                                                         │
QualitySettings (QUALITY[tier]) ──► Game.applyQuality ──►│ world ring, LOD rings, plants, build budget
                                                         │ sun shadow size/extent/cadence, flashlight shadow
                                                         │ MSAA, DPR cap, render-scale range, fog floor, camera far
AdaptiveQuality (per frame: raw frame ms, GPU ms, CPU ms)
   over budget  → render scale −0.1 … tier min → tier −1
   headroom     → render scale +0.1 → tier +1 (desktop only past medium)
```

| File | Role |
|---|---|
| `src/rendering/quality/QualityTiers.ts` | the three tiers — the single source of every budget |
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
| Anti-aliasing (default) | FXAA + sharpen 0.35 | FXAA + sharpen 0.25 | MSAA 4× + sharpen 0.15 |
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
