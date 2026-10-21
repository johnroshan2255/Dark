# DARK

Stylized procedural open-world co-op survival horror for desktop browsers.

```
npm install
npm run dev        # http://localhost:5173  (new random world each load; ?seed=<number|string> to reproduce one)
npm run dev:lan    # same, reachable from your phone on the same Wi-Fi
npm test           # world invariants
```

Controls: click to lock pointer · WASD / Shift / Space · F flashlight · T day⇄night · G next time · N nightmare ·
V first/third person · O settings (anti-aliasing, sharpness, resolution, quality…) ·
F3 perf HUD · F4 chunk bounds & LOD · F5 freeze culling camera · F6 Rapier colliders · F7 quality tier ·
F8 auto quality · `[` `]` render scale. Phone: left thumb joystick (full push = sprint), right thumb look,
LIGHT / JUMP buttons, ⛶ fullscreen. URL: `?tier=low|medium|high`, `?adaptive=0`.

Docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`skills/`](skills/README.md) · [`refer/`](refer/README.md)
