import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

/** Dev-only: phones on the LAN POST their frame stats here (src/debug/DevTelemetry.ts) → one JSON line each. */
function devTelemetry(): Plugin {
  const file = 'node_modules/.cache/telemetry.jsonl'
  return {
    name: 'dev-telemetry',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__telemetry', (req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          fs.mkdirSync('node_modules/.cache', { recursive: true })
          fs.appendFileSync(file, body.replace(/\n/g, ' ') + '\n')
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), devTelemetry()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Rapier (compat) inlines its wasm as base64 (~2 MB); keep it in its own chunk.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      // two pages: the game, and Over the Hill (its own world + renderer, src/oth/)
      input: { main: 'index.html', oth: 'oth.html' },
      output: {
        manualChunks(id) {
          if (id.includes('@dimforge/rapier3d')) return 'rapier'
          if (id.includes('/three/')) return 'three'
        },
      },
    },
  },
})
