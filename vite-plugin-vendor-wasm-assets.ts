// Self-hosts the wasm/data files that `@mintplex-labs/piper-tts-web` would
// otherwise fetch from third-party CDNs (jsDelivr/cdnjs) at runtime, so TTS
// doesn't depend on those CDNs being reachable; see
// src/lib/text-to-speech/worker.ts for where they're pointed to.
//
// This can't be a plain `?url` import (Vite's normal way of self-hosting a
// node_modules file, with automatic content-hash cache-busting) for
// onnxruntime-web: its package.json declares a strict `exports` map with no
// `./dist/*` wildcard, so `onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`
// is refused by Node/Vite's package resolution outright.
//
// In production this is a plain build-time file copy into public/, which
// Vite then ships as static files in dist/client.
//
// In dev it's more involved: onnxruntime-web dynamically `import()`s its .mjs
// loader at runtime (to bootstrap a pthread worker for multithreading), and
// Vite's dev server refuses to serve a runtime `import()` of any file that
// physically lives under the configured `publicDir`, even though a plain
// network request for the same URL works fine — so during `vite dev` these
// files are served from node_modules directly via a middleware instead of
// ever being copied into public/.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { Plugin } from 'vite';

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.data': 'application/octet-stream',
};

const PACKAGES = [
  {
    pkgName: 'onnxruntime-web',
    files: [
      'dist/ort-wasm-simd-threaded.wasm',
      'dist/ort-wasm-simd-threaded.mjs',
    ],
    subdir: 'onnx',
  },
  {
    pkgName: '@diffusionstudio/piper-wasm',
    files: ['build/piper_phonemize.wasm', 'build/piper_phonemize.data'],
    subdir: 'piper-wasm',
  },
];

async function readPkgVersion(pkgRoot: string) {
  const { version } = JSON.parse(
    await readFile(join(pkgRoot, 'package.json'), 'utf8'),
  );
  return version as string;
}

export function vendorWasmAssets(): Plugin[] {
  return [
    {
      name: 'vendor-wasm-assets:build',
      apply: 'build',
      buildStart: async () => {
        for (const { pkgName, files, subdir } of PACKAGES) {
          const pkgRoot = join('node_modules', pkgName);
          const version = await readPkgVersion(pkgRoot);
          const destDir = join('public', 'vendor', subdir, version);
          await mkdir(destDir, { recursive: true });

          for (const file of files) {
            await copyFile(join(pkgRoot, file), join(destDir, basename(file)));
          }

          console.log(
            `vendor-wasm-assets: ${pkgName}@${version} -> ${destDir}`,
          );
        }
      },
    },
    {
      name: 'vendor-wasm-assets:serve',
      apply: 'serve',
      configureServer: (server) => {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url?.split('?')[0] ?? '';

          for (const { pkgName, files, subdir } of PACKAGES) {
            const pkgRoot = join('node_modules', pkgName);
            const version = await readPkgVersion(pkgRoot);

            for (const file of files) {
              const name = basename(file);
              if (url !== `/vendor/${subdir}/${version}/${name}`) continue;

              const ext = name.slice(name.lastIndexOf('.'));
              const bytes = await readFile(join(pkgRoot, file));

              res.setHeader(
                'Content-Type',
                CONTENT_TYPES[ext] ?? 'application/octet-stream',
              );
              res.end(bytes);

              return;
            }
          }

          next();
        });
      },
    },
  ];
}
