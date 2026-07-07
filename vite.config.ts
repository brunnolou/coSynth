import { defineConfig } from 'vite'

export default defineConfig({
  // The DSP worklet is imported with `?worker&url` so Vite bundles it as a
  // standalone module file that AudioWorklet.addModule() can load. AudioWorklet
  // global scope supports ES module imports, so the worker bundle must stay ESM.
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 }
})
