import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Rapier (compat) inlines its wasm as base64 (~2 MB); keep it in its own chunk.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@dimforge/rapier3d')) return 'rapier'
          if (id.includes('/three/')) return 'three'
        },
      },
    },
  },
})
