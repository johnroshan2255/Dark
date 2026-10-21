/**
 * The TypeScript codec (src/net/protocol.ts) against the Rust server's golden vectors
 * (server/crates/protocol/golden.json): every packet decodes, re-encodes to the same bytes, and a few fields are
 * spot-checked. Skipped (with a note) when the server folder isn't next to the game.
 */
import { existsSync, readFileSync } from 'node:fs'
import { decodeClient, decodeServer, encodeClient, encodeServer, Flags, NO_PLAYER, Phase, ProtocolError, RoomFlags, yawToU16, u16ToYaw } from '../src/net/protocol'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))

const path = '../server/crates/protocol/golden.json'
if (!existsSync(path)) {
  console.log(`SKIP  protocol golden vectors (${path} not found)`)
} else {
  const golden = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  for (const [name, h] of Object.entries(golden)) {
    const b = bytes(h)
    try {
      const again = name.startsWith('c.') ? hex(encodeClient(decodeClient(b))) : hex(encodeServer(decodeServer(b)))
      check(`protocol: ${name} round-trips byte-exact`, again === h, again === h ? `${b.length} B` : `${again} != ${h}`)
    } catch (e) {
      check(`protocol: ${name} decodes`, false, String(e))
    }
  }
  const w = decodeServer(bytes(golden['s.welcome']))
  check('protocol: welcome fields', w.t === 'welcome' && w.map === 'island' && w.matchId === 0x0123456789abcdefn && w.playerId === 17)
  const st = decodeClient(bytes(golden['c.state']))
  check('protocol: state fields', st.t === 'state' && st.state.seq === 4000000001 && st.state.pos[0] === -120034 && st.state.epoch === 3 && st.state.flags === (Flags.DRIVING | Flags.LIGHTS))
  const el = decodeServer(bytes(golden['s.eliminated']))
  check('protocol: eliminated by the zone', el.t === 'eliminated' && el.killer === NO_PLAYER)
  const rm = decodeServer(bytes(golden['s.room']))
  check('protocol: room settings', rm.t === 'room' && rm.room.code === 'K7QX2M' && rm.room.name === "Asha's world" && rm.room.maxPlayers === 64 && rm.room.owner === 1 && rm.room.flags === (RoomFlags.PRIVATE | RoomFlags.ROADKILL))
  const ph = decodeServer(bytes(golden['s.phase']))
  check('protocol: phase', ph.t === 'phase' && ph.phase === Phase.Countdown)
  // every prefix of every packet is an error, never a wrong message
  let prefixOk = true
  for (const [name, h] of Object.entries(golden)) {
    const b = bytes(h)
    for (let cut = 0; cut < b.length; cut++) {
      try {
        if (name.startsWith('c.')) decodeClient(b.subarray(0, cut))
        else decodeServer(b.subarray(0, cut))
        prefixOk = false
      } catch (e) {
        if (!(e instanceof ProtocolError) && !(e instanceof RangeError)) prefixOk = false
      }
    }
  }
  check('protocol: truncated packets are rejected', prefixOk)
}
check('protocol: yaw quantisation', Math.abs(u16ToYaw(yawToU16(1.234)) - 1.234) < 1e-3 && yawToU16(-0.0001) > 65000)

if (failures) {
  console.log(`\n${failures} protocol check(s) failed`)
  process.exit(1)
}
