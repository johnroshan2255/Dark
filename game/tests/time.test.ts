/** Day/night cycle invariants (run: npm test). */
import { sunDirection, TimeOfDay } from '../src/rendering/lighting/TimeOfDay'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const s6 = sunDirection(6), s12 = sunDirection(12), s18 = sunDirection(18), s0 = sunDirection(0)
check('sunrise at 06:00 behind the spawn view (−Z, on horizon)', Math.abs(s6.y) < 1e-9 && s6.z < -0.99)
const noonElev = Math.asin(s12.y) * 57.3
check('noon sun low-ish (≈32°) to the west (−X) → visible, long shadows', Math.abs(noonElev - 32) < 1 && s12.x < -0.5, `elev ${noonElev.toFixed(1)}°`)
check('sunset at 18:00 down the road (+Z)', Math.abs(s18.y) < 1e-9 && s18.z > 0.99)
check('midnight: sun below horizon, moon ~32° up', s0.y < -0.5)

const t = new TimeOfDay(17)
t.dayLengthMinutes = 0
t.goTo(22, 7)
const ys: number[] = []
for (let i = 0; i < 70; i++) (t.update(0.1), ys.push(t.sunDir.y))
const monotonic = ys.every((y, i) => i === 0 || y <= ys[i - 1] + 1e-9)
check('day→night animates the sun continuously downward', monotonic && Math.abs(t.hours - 22) < 0.01, `end ${t.hours.toFixed(2)} h`)
check('label is NIGHT at 22:00', t.label === 'NIGHT')
t.goTo(9.5, 5)
for (let i = 0; i < 60; i++) t.update(0.1)
check('night→day wraps forward through midnight', Math.abs(t.hours - 9.5) < 0.01 && t.label === 'DAY', `${t.hours.toFixed(2)} h`)
t.setNightmare(true)
for (let i = 0; i < 40; i++) t.update(0.1)
check('nightmare blends in (distortion → 1)', t.current.distortion > 0.99)
process.exit(failures ? 1 : 0)
