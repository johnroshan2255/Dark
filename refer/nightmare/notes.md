# nightmare — what matters

| File | Key properties |
|---|---|
| `nightmare-realm.png` | Entire frame saturated red: red sky, red fog, black tree silhouettes; floating ash/spore particles; giant spindly monster silhouettes in the fog. |
| `nightmare-ash-sky.png` | Detail of the sky/particle layer: glowing red embers against dark red. |

Implications (NIGHTMARE phase):
- Much more saturated/brighter red than current keyframe (`fogColor 0x1e0707`); target fog ~`#5a0c0c`, sky ~`#8a1414`, trees stay near-black for silhouette contrast.
- Add a GPU particle layer (one Points draw call) for ash — see skills/shaders.
