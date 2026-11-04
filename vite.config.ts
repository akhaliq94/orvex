import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built app also loads from file:// inside Electron.
  base: './',
  server: { port: 5183, strictPort: true },
})
