---
name: monsters
description: Read before changing monsters, lightning/storms, player damage, knockdown, death/respawn or monster-time rules — how threats work, what they cost per tier, and how to test them headlessly.
---

# Monsters, storms and damage

## 1. Purpose
Monster time = NIGHT or the NIGHTMARE realm (refer/monsters, refer/nightmare). Threats must be real: damage,
knockdown, death, respawn — and readable: silhouettes with glowing red eyes, lightning that reveals them.

## 2. Architecture
| Part | File |
|---|---|
| Health (hp, regen after 6 s, hurt flash, death) | `gameplay/survival/Health.ts` |
| Stalkers + striders (AI, spawn, attack) | `gameplay/monsters/MonsterSystem.ts` |
| Rendering: ALL monsters in 3 instanced draws (segments, blobs, HDR eyes) | `gameplay/monsters/MonsterRig.ts` |
| Lightning (timer, bolt, flash, strike damage) | `gameplay/weather/Lightning.ts` |
| Nightmare ash/embers (1 draw, GPU-wrapped points) | `rendering/particles/AshParticles.ts` |
| Synth audio (thunder by distance, growl, screech, hurt) | `audio/AudioSystem.ts` |
| Knockback / stun / knockdown / dead | `PlayerController.applyImpulse`, `knock`, `stunned` |
| Camera fall + roll + shake, character lying down | `CameraController` |
| Flash + damage vignette | `GradingShader` (`uFlash`, `uDamage`) |

Rules:
- **Stalker** (2.5 m): wander → notices ≤ 38 m or when lit → stalk → chase ≤ 18 m → hit at 1.7 m: 18 dmg,
  knockback, 0.35 s stun, 1.3 s cooldown. **Flashlight on it ~1.2 s → flees 4 s** (player's defence).
- **Strider** (20 m): walks slowly on planted feet 55–85 m out; a foot landing < 5 m: 15 dmg (< 2.5 m: 35) + knockdown.
- **Lightning**: night 15–45 s, nightmare 5–15 s; 15% land 2–9 m away: ≤ 3.5 m → 45 dmg + knockdown, ≤ 9 m → 12 dmg.
- Death → "YOU DIED", respawn after 4 s on the road nearby, full hp, stalkers retreat.
- Per tier (night): LOW 1 stalker, MEDIUM 2 + 1 strider, HIGH 3 + 2; nightmare adds 2 stalkers and ≥ 1 strider.
- Settings → "Monsters & storms: Off (explore)".

## 3. When to use / 4. When NOT to use
Add new creatures as parts drawn through `MonsterRig` (no new meshes/materials). Don't give monsters Rapier
bodies — they follow the analytic height field; add colliders only if they must block the player.

## 5. Performance
Monsters: 3 draws total (+2 shadow on MEDIUM/HIGH), O(monsters) CPU (≤ ~10). Bolt 1 draw for 0.45 s.
Ash 1 draw. Audio: nodes per event only. Measured nightmare + 5 monsters, uncapped M4: LOW 550 fps / 102 draws
peak, MEDIUM 207 / 152, HIGH 70 / 265.

## 6. WebGL limitations
Eyes are HDR (6× red) MeshBasic without fog so they bloom through haze. Monster bodies use `fogAmount: 0.45`
so silhouettes read at distance.

## 7–8. Implementation notes
Rig: `begin()` → `segment(a, b, r)` / `blob(...)` / `eye(...)` in world space → `end()` each frame.
Beam/ash shaders: clamp anything fed to `pow()` — a NaN pixel gets spread by the painterly filter into
visible artifacts (found in testing).

## 9. Common mistakes
- Shadowing the knockdown amount `k` inside the TPP camera block (the collision-smoothing factor was also `k`) rolled the camera ~0.5° and made it wobble with frame time — "shaking when moving the camera". Check: headless turn test must report rotJitter 0 and roll 0 when not knocked down.
- Thin limbs at distance (≤ 3 px) vanish in fog — scale silhouettes for 60–100 m viewing.
- Point sprites sized without the projection factor (`height / (2·tan(fov/2))`) → giant discs.
- Spawning in the camera's forward cone (pop-in) — stalkers spawn out of view, striders may be seen.

## 10. Testing (headless)
`game.monsters.spawnStalker(pos)`, `spawnStrider(pos)`, `game.lightning.strike(near, camera)`,
`game.health.damage(n, source)`; read `health.hp`, `player.knock`, `monsters.stalkers[i].state`.
