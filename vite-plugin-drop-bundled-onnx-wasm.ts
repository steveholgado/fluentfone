// Drops the onnxruntime-web .wasm binaries that the bundler emits into
// dist/client/assets and that nothing ever fetches — ~34 MiB across two files,
// one of which is the largest single file in the build.
//
// This app carries two ORT versions, and both emit an orphan. piper-tts-web
// pulls in onnxruntime-web 1.23.2 (peer dep, pinned by our own dependency
// entry); @huggingface/transformers hard-pins 1.26.0-dev internally. Each
// contains a
//
//   new URL('ort-wasm-simd-threaded[.asyncify].wasm', import.meta.url)
//
// fallback, which Vite resolves at build time by emitting the binary as a
// bundle asset — whether or not the branch can ever run.
//
// It cannot. ORT only reaches that fallback when `env.wasm.wasmPaths` is unset
// by the time a session is created:
//
//   } else if (wasmPathOverride || wasmPrefixOverride) {
//     config.locateFile = (fileName) => wasmPathOverride ?? wasmPrefixOverride + fileName;
//
// Neither library leaves it unset. piper-tts-web assigns the `onnxWasm` prefix
// it is handed, which src/lib/text-to-speech/worker.ts always passes and its
// test pins. transformers.js assigns a jsDelivr `{ mjs, wasm }` pair at module
// scope, before any session exists, and sets `wasm.proxy = false` — which also
// rules out the second, proxy-worker occurrence of the same fallback.
//
// So every byte of ORT wasm this app actually loads comes from /vendor/ (see
// vite-plugin-vendor-wasm-assets.ts) or from jsDelivr, and none of it from
// assets/. That is the invariant enforced here: no ORT wasm ships from the
// bundle. The .mjs loaders are unaffected — those are inlined into their
// chunks rather than emitted as assets.
//
// Worth a plugin rather than living with the dead weight because the deploy
// target is Cloudflare, which rejects any single file over 25 MiB. The larger
// orphan is 22.48 MiB: both the heaviest thing uploaded and the one closest to
// failing the deploy outright.
import type { Plugin } from 'vite';

/**
 * Bundle-emitted ORT binaries, as distinct from the vendored copies. Public-dir
 * files (dist/client/vendor/**) are copied outside the bundle graph and never
 * appear here, so there is no risk of this matching the ones we serve.
 */
const ORPHAN = /(^|\/)ort-wasm-.*\.wasm$/;

function byteLength(source: string | Uint8Array): number {
  return typeof source === 'string'
    ? Buffer.byteLength(source)
    : source.byteLength;
}

export function dropBundledOnnxWasm(): Plugin {
  return {
    name: 'drop-bundled-onnx-wasm',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle(_options, bundle) {
      let dropped = 0;
      let bytes = 0;

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !ORPHAN.test(fileName)) continue;

        bytes += byteLength(output.source);
        dropped++;
        delete bundle[fileName];
      }

      if (dropped === 0) {
        // Not fatal on its own, but it means the fallback stopped being
        // emitted — so this plugin is now dead code and the comment above has
        // drifted from what the libraries do. Worth a look on the next bump.
        this.warn(
          'no bundled ort-wasm-*.wasm found; onnxruntime-web or ' +
            'transformers.js may no longer emit one',
        );
        return;
      }

      console.log(
        `drop-bundled-onnx-wasm: removed ${dropped} unused ORT binaries ` +
          `(${(bytes / 1024 / 1024).toFixed(2)} MiB)`,
      );
    },
  };
}
