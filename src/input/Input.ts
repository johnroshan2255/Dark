/**
 * Raw keyboard/mouse/touch state. Polled by systems each frame; one-shot actions via onPress.
 * Pointer lock on canvas click (mouse only); mouse and touch-look deltas accumulate between frames.
 * Touch controls (TouchControls.tsx) write `touchMove` and call addLook()/trigger().
 */
export class Input {
  readonly keys = new Set<string>()
  private dx = 0
  private dy = 0
  locked = false
  private readonly press = new Map<string, () => void>()
  private target: HTMLElement | null = null
  onLockChange: (locked: boolean) => void = () => {}
  /** Analog move from the virtual joystick: x = strafe (right +), y = forward (+). Magnitude ≤ 1. */
  readonly touchMove = { x: 0, y: 0 }
  /** Touch look speed relative to mouse pixels. */
  touchLookScale = 2.4
  /** The touch controls are in use (set by TouchControls) — arcade driving auto-accelerates then. */
  touch = false
  /** performance.now() of the last look input (mouse / touch drag): the chase camera waits before re-centring. */
  lastLook = -1e9

  onPress(code: string, fn: () => void): void {
    this.press.set(code, fn)
  }

  /** Fire a bound one-shot action (touch buttons reuse the keyboard bindings). */
  trigger(code: string): void {
    this.press.get(code)?.()
  }

  /** Hold / release a key from a touch button (boost, handbrake): same state the keyboard writes. */
  hold(code: string, down: boolean): void {
    if (down) this.keys.add(code)
    else this.keys.delete(code)
  }

  addLook(dx: number, dy: number): void {
    this.dx += dx * this.touchLookScale
    this.dy += dy * this.touchLookScale
  }

  down(code: string): boolean {
    return this.keys.has(code)
  }

  /** Returns and clears accumulated mouse movement. */
  consumeMouse(out: { x: number; y: number }): void {
    if (Math.abs(this.dx) + Math.abs(this.dy) > 0.5) this.lastLook = performance.now()
    out.x = this.dx
    out.y = this.dy
    this.dx = this.dy = 0
  }

  attach(el: HTMLElement): void {
    this.target = el
    el.addEventListener('pointerdown', this.onClick)
    document.addEventListener('pointerlockchange', this.onLock)
    document.addEventListener('mousemove', this.onMove)
    window.addEventListener('keydown', this.onDown)
    window.addEventListener('keyup', this.onUp)
    window.addEventListener('blur', this.onBlur)
  }

  detach(): void {
    this.target?.removeEventListener('pointerdown', this.onClick)
    document.removeEventListener('pointerlockchange', this.onLock)
    document.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('keydown', this.onDown)
    window.removeEventListener('keyup', this.onUp)
    window.removeEventListener('blur', this.onBlur)
    this.target = null
  }

  private onClick = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && !this.locked) this.target?.requestPointerLock?.()
  }
  private onLock = () => {
    this.locked = document.pointerLockElement === this.target
    this.onLockChange(this.locked)
  }
  private onMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.dx += e.movementX
    this.dy += e.movementY
  }
  private onDown = (e: KeyboardEvent) => {
    if (e.code.startsWith('F') && e.code.length <= 3) e.preventDefault() // F1–F12 debug keys
    if (!e.repeat) this.press.get(e.code)?.()
    this.keys.add(e.code)
  }
  private onUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }
  private onBlur = () => {
    this.keys.clear()
    this.touchMove.x = this.touchMove.y = 0
  }
}
