# DARK — agent notes

Browser co-op survival horror: React + R3F + Three.js r186 + Rapier (compat) + TypeScript, Vite.

- **Read `ARCHITECTURE.md` first**, then the relevant `skills/<system>/SKILL.md` before implementing or
  changing any rendering/world-system feature (`skills/README.md` has a task → skill map).
- Before visual work, look at the matching `refer/<subject>/` images and read `skills/art-direction`; verify with a
  headless side-by-side against `refer/roads/forest-road-evening-hero.png`.
- Performance rule: every feature states and measures its CPU / GPU / memory cost **per quality tier**
  (F3 HUD). Floor: ≥ 60 fps on ~₹15k phones and Intel UHD laptops, uncapped above. Read `skills/mobile`.
- Budgets come from `game.quality` (`src/rendering/quality/QualityTiers.ts`), never hard-coded constants.
- Every game is a new random world; `?seed=` reproduces one. Touch controls must keep working.
- Never put per-frame state in React. Systems are plain TS classes run by `GameLoop`; React mounts roots.
- World generation must stay deterministic (no `Math.random`, hash-based RNG keyed by seed/cell/layer).
- Don't add dependencies without a concrete, stated reason (see ARCHITECTURE.md §1).

Commands: `npm run dev` · `npm run typecheck` · `npm test` (determinism, seams, collider/mesh agreement) ·
`npm run build` · `npm run validate:assets [dir] [--strict]` · `npm run dev:lan` (test on a phone over Wi-Fi).
