# environment — what matters

Source: `../ChatGPT Image Sep 28, 2026, 11_14_09 AM.png` (concept sheet).

| File | Key properties |
|---|---|
| `day-evening.png` | Warm low sun, blue sky with soft cloud, long shadows across the road; dry yellow-green grass verges; distant hills fade to blue-grey haze (aerial perspective, not grey fog). |
| `night-road.png` | **Blue moonlit night, not black**: sky deep navy, trees read as dark blue-green silhouettes, road still legible. Flashlight is the only warm light. |
| `procedural-world-vista.png` | Layered depth: foreground pines → lake → forest band → mountains; each layer lighter and bluer with distance. Target for fog colour ramp and far-LOD silhouettes. |
| `water-tower-landmark.png` | Tall silhouette landmark visible above the tree line — POI readability at distance via silhouette against a bright sky. |

Tuning implications (TimeOfDay.ts):
- NIGHT: current fog `0x0b1017` / hemi 0.3 is darker than the reference; raise the moonlit blue (sky ~`#1c2a4a`, fog ~`#16223a`) so silhouettes read.
- DAY/EVENING: fog should tint toward sky blue/violet with distance rather than neutral grey.
