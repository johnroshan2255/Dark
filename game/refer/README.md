# Visual references

Place generated/collected reference images here, grouped by subject. They guide **art direction**:
style, composition, lighting, atmosphere, palette, silhouettes, density. They are *not* rendering specs —
we hit the mood with fog, lighting, grading and silhouettes on low-poly geometry, not by matching pixels.

| Folder | What to put there | Informs |
|---|---|---|
| `environment/` | wide landscape shots, skies, horizon fog | TimeOfDay keyframes, fog density/colour, terrain palette |
| `forest/` | forest roads, tree lines, undergrowth, night forest, fog in trees | tree species/density, scatter rules, vegetation palette |
| `roads/` | road surfaces, shoulders, signage, debris | road width/shoulder, road colours, debris props |
| `caves/` | entrances, interiors, formations | cave generation, portal/room visibility, cave lighting |
| `characters/` | player characters, outfits, flashlight pose | character assets, flashlight placement |
| `monsters/` | silhouettes, scale, movement references | monster assets, LOD silhouettes, AI presentation |
| `bmx/` | BMX bikes, riding poses, trick references | BMX asset, physics tuning, camera |
| `nightmare/` | nightmare-realm palette, distortion, sky | NIGHTMARE phase keyframe, grading, distortion |
| `ui/` | HUD, menus, typography | UI |

Suggested naming: `<subject>-<variant>.png`, e.g. `forest/forest-road.png`, `forest/forest-night.png`,
`forest/forest-fog.png`. A one-line `notes.md` per folder ("what matters in these images") is useful.

**Workflow:** before implementing or re-tuning a visual system, look at the matching folder, write down the
2–3 properties that matter (e.g. "fog swallows trees by ~60 m", "road is lighter than verges", "moonlight
is blue-green, no hard shadows"), then tune `src/rendering/lighting/TimeOfDay.ts`,
`src/world/Terrain/terrainPalette.ts` and `src/world/Forest/propGeometries.ts` against that list.

## Current references

All images so far are crops of one concept sheet: `ChatGPT Image Sep 28, 2026, 11_14_09 AM.png` (keep it —
it's the source). Each folder has a `notes.md` listing what matters in its images and what it implies for the
code. **Master mood shot:** `roads/forest-road-evening-hero.png`.

```
environment/  day-evening, night-road, procedural-world-vista, water-tower-landmark
forest/       forest-road-canopy-sunset, forest-edge-fence-left
roads/        forest-road-evening-hero, road-sign-hawkins, road-power-lines-truck
caves/        hidden-cave, cave-glow-portal
nightmare/    nightmare-realm, nightmare-ash-sky
monsters/     shadow-monsters, nightmare-giant-silhouette
bmx/          mount-and-ride, pedal-dynamically, bmx-rider-rear
characters/   four-players-coop, riders-group-headlamps, flashlight-flicker
ui/           hud-party-status, hud-compass, prompt-mount-bike, feature-sidebar, footer-tech-bar
```

Crops are low-resolution (the sheet is 1536×1024) — good for mood/palette/composition, not for texture detail.
