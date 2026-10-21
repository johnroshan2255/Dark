import { createRoot } from 'react-dom/client'
import { App } from './app/App'

// No StrictMode around the game: its double-invoked effects would build the renderer/game twice
// in dev. Game lifecycle is still cleanup-safe (see App).
createRoot(document.getElementById('root')!).render(<App />)
