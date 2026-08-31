import { defineConfig } from 'vite';

import { tanstackStart } from '@tanstack/react-start/plugin/vite';

import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web'] },
  worker: { format: 'es' },
  plugins: [
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
    }),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
});

export default config;
