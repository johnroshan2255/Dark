/**
 * Player health. Plain state updated by gameplay systems; UI reads it via refs (no per-frame React).
 * Regenerates slowly after a few seconds without damage. Death → onDeath (Game handles respawn).
 */
export interface DamageEvent {
  amount: number
  source: 'monster' | 'lightning' | 'fall'
}

export class Health {
  readonly max = 100
  hp = 100
  dead = false
  /** 0..1 flash for the red damage vignette (decays). */
  hurt = 0
  private sinceHit = 99
  onDamage: (e: DamageEvent) => void = () => {}
  onDeath: (e: DamageEvent) => void = () => {}

  damage(amount: number, source: DamageEvent['source']): void {
    if (this.dead || amount <= 0) return
    this.hp = Math.max(0, this.hp - amount)
    this.sinceHit = 0
    this.hurt = Math.min(1, this.hurt + 0.35 + amount / 60)
    const e = { amount, source }
    this.onDamage(e)
    if (this.hp <= 0) {
      this.dead = true
      this.onDeath(e)
    }
  }

  update(dt: number): void {
    this.hurt = Math.max(0, this.hurt - dt * 1.4)
    this.sinceHit += dt
    if (!this.dead && this.sinceHit > 6 && this.hp < this.max) this.hp = Math.min(this.max, this.hp + dt * 3)
  }

  revive(): void {
    this.hp = this.max
    this.dead = false
    this.hurt = 0
    this.sinceHit = 99
  }
}
