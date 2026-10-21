import { useGame } from '../game/GameContext'

/** Mounts the fixed light rig. Lights are updated imperatively by LightingSystem. */
export function Lighting() {
  const game = useGame()
  return <primitive object={game.lighting.root} dispose={null} />
}
