import { defineConfig } from 'vite'

export default defineConfig({
  // The DSP worklet is imported with `?worker&url` so Vite bundles it as a
  // standalone module file that AudioWorklet.addModule() can load. AudioWorklet
  // global scope supports ES module imports, so the worker bundle must stay ESM.
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  // Dev-only. The legacy webmcp.dev widget dials the bridge at
  // ws://localhost:4797 directly, which fails in browsers that refuse
  // cross-origin loopback requests - and the bridge binds IPv6 only, so IPv4
  // clients cannot reach it either. Proxying its two endpoints keeps them
  // same-origin with the page and lets Node do the IPv6 hop. Point the widget
  // at ws://localhost:5173 instead of ws://localhost:4797 to use this.
  server: {
    port: 5173,
    proxy: {
      '/register': { target: 'ws://[::1]:4797', ws: true },
      '/localhost_5173': { target: 'ws://[::1]:4797', ws: true }
    }
  }
})
