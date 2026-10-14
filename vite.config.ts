import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { dropBundledOnnxWasm } from './vite-plugin-drop-bundled-onnx-wasm.ts';
import { serviceWorker } from './vite-plugin-service-worker.ts';
import { vendorWasmAssets } from './vite-plugin-vendor-wasm-assets.ts';

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  worker: { format: 'es' },
  plugins: [
    vendorWasmAssets(),
    // The counterpart to vendorWasmAssets(): that one puts the ORT wasm we do
    // serve under /vendor/, this one removes the copies we don't.
    dropBundledOnnxWasm(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
    }),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // Must come after tanstackStart(): it emits in a post-order buildApp hook
    // that has to sort after the one TanStack prerenders in. See the header
    // comment in vite-plugin-service-worker.ts.
    serviceWorker(),
  ],
});

export default config;
