# Skills

How-to guides for each engine system in DARK. **Read the relevant skill before implementing or changing
a rendering or world-system feature.** `ARCHITECTURE.md` (repo root) says how the systems fit together;
each skill says how to build one of them correctly in Three.js/WebGL in the browser.

Every skill has the same sections: 1 Purpose · 2 Architecture · 3 When to use · 4 When NOT to use ·
5 Performance implications (CPU / GPU / memory) · 6 WebGL limitations · 7 R3F implementation ·
8 Direct Three.js implementation · 9 Common mistakes · 10 Profiling/debugging.

## The performance rule

Every major feature must answer **"How much does this cost on the CPU, GPU and memory — on LOW, MEDIUM and
HIGH?"**, and the answer must be measured (F3 HUD, `skills/profiling`, `skills/mobile` §10), not guessed.
The floor is ≥ 60 fps on a ~₹15k phone and an Intel UHD laptop.

## Index

| Skill | Read when |
|---|---|
| [`art-direction`](art-direction/SKILL.md) | Read before changing any material, shader look, vegetation, sky, fog, palette or grading — how DARK matches refer/ and what it costs. |
| [`asset-optimization`](asset-optimization/SKILL.md) | Read before adding any GLB/GLTF (especially AI-generated) to the game — validation, optimization, LOD generation, budgets, naming. |
| [`batching`](batching/SKILL.md) | Read when draw calls are high or when combining static meshes, many different props, or materials/textures (merging, BatchedMesh, atlases). |
| [`culling`](culling/SKILL.md) | Read before adding anything that decides what is drawn, simulated, or updated — chunk visibility, frustum/distance culling, cave/room visibility, monster/physics activation. |
| [`fog`](fog/SKILL.md) | Read before changing fog, view distance, sky colour or streaming radius, or adding volumetric-looking effects — fog is both the mood and the view-distance budget. |
| [`instancing`](instancing/SKILL.md) | Read before placing any repeated object (trees, rocks, grass, plants, mushrooms, debris, cave formations, props) in the world. |
| [`lighting`](lighting/SKILL.md) | Read before adding or changing any light, time-of-day phase, the flashlight, or emissive "light" props — covers DAY→EVENING→NIGHT→NIGHTMARE blending and the fixed light-slot pool. |
| [`lod`](lod/SKILL.md) | Read before adding detail levels for terrain, vegetation, props, or monsters, or tuning LOD distances/hysteresis. |
| [`memory`](memory/SKILL.md) | Read when creating/destroying GPU resources, Rapier objects, caches or per-frame allocations — disposal, pools, LRU, GC pauses. |
| [`mobile`](mobile/SKILL.md) | Read before adding ANY feature — quality tiers, ≥60 fps floor on ₹15k phones / low-end PCs, adaptive resolution, touch controls, device verification. |
| [`monsters`](monsters/SKILL.md) | Read before changing monsters, storms/lightning, damage, knockdown, death or monster-time rules. |
| [`multiplayer`](multiplayer/SKILL.md) | Read before any networking, replication, or authority decision — 4-player host-authoritative co-op, snapshots, interpolation, prediction, world sync. |
| [`physics`](physics/SKILL.md) | Read before touching Rapier — world stepping, terrain heightfields, colliders, character controller, BMX, activation radius, WASM memory. |
| [`postprocessing`](postprocessing/SKILL.md) | Read before adding any fullscreen effect, render target, bloom/SSAO, or changing how the frame reaches the screen — DARK uses one combined grading pass. |
| [`procedural-world`](procedural-world/SKILL.md) | Read before adding or changing any generated content (terrain, road, forest, props, caves, POIs, monster spawns) or anything that must be identical across co-op clients. |
| [`profiling`](profiling/SKILL.md) | Read before optimizing anything or when fps drops — how to measure CPU vs GPU cost, read the F3 HUD, use DevTools/Spector.js, and detect memory leaks. |
| [`react-three-fiber`](react-three-fiber/SKILL.md) | Read before writing any R3F component, useFrame callback, or deciding whether something belongs in React or in the imperative hot path. |
| [`shaders`](shaders/SKILL.md) | Read before writing or patching any GLSL — choosing onBeforeCompile vs ShaderMaterial vs RawShaderMaterial, sharing uniforms, vegetation wind, and keeping the program count low. |
| [`shadows`](shadows/SKILL.md) | Read before enabling castShadow/receiveShadow on anything, changing shadow map settings, or adding fake/baked shadows — defines the one-directional-shadow strategy. |
| [`terrain`](terrain/SKILL.md) | Read before changing terrain height generation, terrain meshes/LOD/skirts/colours, road flattening, height queries, or terrain physics colliders. |
| [`texture-optimization`](texture-optimization/SKILL.md) | Read before adding or changing textures, render targets, or texture settings — memory math, KTX2, mips, anisotropy, atlases, color spaces. |
| [`threejs`](threejs/SKILL.md) | Read when you need direct Three.js control — scene graph cost, matrices, geometry attributes, instancing, raycasting, layers, render order. |
| [`webgl`](webgl/SKILL.md) | Read before adding anything that renders — explains draw calls, GPU/texture memory, overdraw, programs, render targets, MSAA, DPR and the frame budgets every feature must fit into. |
| [`world-streaming`](world-streaming/SKILL.md) | Read before changing how chunks are generated, loaded, built, activated, cached, or disposed, or adding a system with its own activation radius. |

## Which skill for which task

| Task | Read |
|---|---|
| New repeated world object | instancing → culling → lod → asset-optimization |
| New chunk content / generation layer | procedural-world → world-streaming → terrain |
| New light, phase, flashlight change | lighting → shadows → fog |
| New post effect / shader | postprocessing → shaders → webgl |
| New GLB asset from an AI tool | asset-optimization → texture-optimization → `npm run validate:assets` |
| Anything with colliders | physics → culling (activation radii) |
| Any new feature (budget per tier) | mobile → webgl |
| Frame rate dropped | profiling → mobile → webgl → memory |
| React component for a game system | react-three-fiber → threejs |
| Co-op / networking | multiplayer → procedural-world (seed determinism) |

Skills describe planned files marked *(planned)*; everything else they cite exists in `src/`.
