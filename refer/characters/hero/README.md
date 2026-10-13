# Hero — AI-generated player character (work in progress)

- `concept_sheet.png` — ChatGPT turnaround sheet (2026-10-13), the source.
- `views/` — front / left / back / right cropped from the sheet at one scale, background removed (the model's inputs).
- `hero_v1_full_shape.glb` — Hunyuan3D-2mv turbo output (332k faces). Its fists are FUSED to the thighs (the sheet's
  fists rest on the cargo pockets; 3 other generator settings fused them too).
- `hero_v3_full_shape_hands_free.glb` — v1 with the hands cut free (`carve.py`: per-side min-cut on the surface graph,
  cheap along the concave fist/pocket crease, holes capped). `hands_separated.png` shows the hips before → after.
- **Game file `src/assets/models/characters/hero.lod0.glb`** — 15k faces (head 3k), 10.5k verts after UV seams,
  1024² albedo (`hero_albedo_1024.png`) baked from `views/` by `bake.py`: each view registered to the mesh silhouette
  (IoU fit, the head refined separately); best-facing view per texel; the front view takes over the face SMOOTHLY;
  the sculpted face softened so the painted features lead; head skin DE-LIT to one tone (each view was painted with
  its own light → a light/dark split = the "mask"); 12 px atlas gutters (mip bleed); greens nudged for the bright grade.
- `face_closeup.png` — the texture on the head, unlit. `ingame_*.png` — swapped into the running game (bright, ultra).
- Rejected: v2 flat palette colours ("no details, don't make it like our old char"); v3a front-only face (a hard mask).

NOT wired in yet: (1) the character material is vertex-colour only — it needs the texture as `map`;
(2) the arms hang down, the rig in code is built for a T-pose.

Tooling (outside the repo, `~/Hunyuan3D`): `run_mv.py` → `carve.py` → `bake.py shape.glb out --views views`.
