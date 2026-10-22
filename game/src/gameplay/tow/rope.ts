/**
 * TOW ROPE — the physics both sides run (the server's copy: server/crates/sim/src/tow.rs, same numbers, same order).
 *
 * A winch line from a car's FAIRLEAD (vehicle_hooks.py) to its far end: a hand (no pull — the line just pays out),
 * a fixed point (a tree, a rock, a post) or another car's hook. It never pushes: slack, it only hangs; taut past its
 * length it pulls both ends together with a stiff damped spring (a steel winch line stretches a little), at most
 * MAX_TENSION — a 2 t car pulls a stuck one out, it doesn't fling it. The WINCH reels the line in at WINCH_SPEED while
 * the tension stays under WINCH_PULL (a real 4.5 t winch stalls on a car buried to the axles).
 * Cost: a handful of flops per rope per fixed step.
 */
export const ROPE_MAX = 25
/** Line stiffness (N/m past its length) and damping (N per m/s of stretching). */
export const ROPE_K = 60_000
export const ROPE_C = 9_000
export const MAX_TENSION = 70_000
export const WINCH_SPEED = 0.6
export const WINCH_PULL = 45_000
/** Reach (m) to take / hang a hook: from the player to the hook or the anchor point. */
export const HOOK_REACH = 1.8
/** Shortest the winch reels in to (m): the hook stops at the fairlead. */
export const ROPE_MIN = 0.6

export type End = 'F' | 'R'

/**
 * Tension (N) in a line of length `len` whose ends are `d` m apart, separating at `dd` m/s (+ = apart). 0 when slack.
 */
export function ropeTension(d: number, dd: number, len: number): number {
  const stretch = d - len
  if (stretch <= 0) return 0
  return Math.min(MAX_TENSION, Math.max(0, ROPE_K * stretch + ROPE_C * dd))
}

/** The winch: the new line length after `dt` s reeling in under `tension` N (it stalls past WINCH_PULL). */
export function winchIn(len: number, tension: number, dt: number): number {
  if (tension > WINCH_PULL) return len
  return Math.max(ROPE_MIN, len - WINCH_SPEED * dt)
}
