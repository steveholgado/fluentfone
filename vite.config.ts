import { defineConfig } from 'vite';

import { tanstackStart } from '@tanstack/react-start/plugin/vite';

import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

import { vendorWasmAssets } from './vite-plugin-vendor-wasm-assets.ts';
import { serviceWorker } from './vite-plugin-service-worker.ts';

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  worker: { format: 'es' },
  plugins: [
    vendorWasmAssets(),
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
