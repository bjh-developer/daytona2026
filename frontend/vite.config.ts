import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // SGDS vendor CSS contains invalid selectors (e.g. `.stepper-item:before .x`)
  // that Vite 8's default lightningcss minifier rejects, breaking the build.
  // Disable CSS minify: no lightningcss crash, and — unlike cssMinify:'esbuild' —
  // no esbuild dependency (Vercel's clean install doesn't have it; Vite 8's
  // rolldown handles JS minify without it). CSS ships unminified; gzip covers it.
  build: { cssMinify: false },
  server: {
    port: 5174,
  },
})
