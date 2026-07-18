import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // SGDS vendor CSS contains invalid selectors (e.g. `.stepper-item:before .x`)
  // that Vite 8's default lightningcss minifier rejects. esbuild is lenient.
  build: { cssMinify: "esbuild" },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
    },
  },
})
