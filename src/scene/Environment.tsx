import { useGame } from '../game/GameContext'

/**
 * Sky dome, player character (+ blob shadow) and world-space debug helpers. All are updated
 * imperatively by the game loop (TimeOfDay → SkyDome, CameraController → character).
 */
export function Environment() {
  const game = useGame()
  return <primitive object={game.envRoot} dispose={null} />
}
