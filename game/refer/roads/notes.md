# roads — what matters

| File | Key properties |
|---|---|
| `forest-road-evening-hero.png` | **Master mood shot.** Two-lane cracked asphalt with faded yellow centre dashes, light gravel shoulders, road narrowing into haze; power-line poles on one side; abandoned truck on the verge; purple-orange sunset sky. |
| `road-sign-hawkins.png` | Green town sign on two wooden posts — reusable prop, readable silhouette. |
| `road-power-lines-truck.png` | Repeating utility poles with sagging wires lead the eye down the road; parked rusted pickup. |

Implications:
- Road needs its own strip mesh (asphalt + centre dashes + lighter shoulder), not just terrain vertex colour.
- Poles placed along `roadCenterX(z)` at a fixed interval — deterministic, instanced; wires as a few line/tube segments per chunk.
- Road props: signs, abandoned vehicles, debris (instanced; colliders only for vehicles).
