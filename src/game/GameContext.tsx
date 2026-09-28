import { createContext, useContext, type ReactNode } from 'react'
import type { Game } from './Game'

const Ctx = createContext<Game | null>(null)

export function GameProvider({ game, children }: { game: Game; children: ReactNode }) {
  return <Ctx.Provider value={game}>{children}</Ctx.Provider>
}

export function useGame(): Game {
  const g = useContext(Ctx)
  if (!g) throw new Error('useGame() outside <GameProvider>')
  return g
}
