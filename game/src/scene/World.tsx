import { useGame } from '../game/GameContext'

/**
 * The streamed world. Chunks are added/removed under this root by WorldManager
 * (imperatively, under a per-frame build budget) — not as React children. See ARCHITECTURE.md §3.
 */
export function World() {
  const game = useGame()
  return <primitive object={game.world.root} dispose={null} />
}
