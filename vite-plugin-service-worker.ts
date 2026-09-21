// Compiles src/sw.ts to dist/client/sw.js and injects the app-shell precache
// list into it, so the app can boot with no network.
//
// The hook choreography here is not guessable, so it is spelled out:
//
// TanStack Start prerenders by starting an in-process `vite.preview()` server
// inside its own `buildApp: { order: 'post' }` handler, and only then writes
// dist/client/index.html and dist/client/app/index.html. Every per-environment
// hook — closeBundle and writeBundle included — has therefore already run by
// the time those documents exist. The only place that runs after them is
// another `buildApp` post handler, and it only sorts after TanStack's if this
// plugin is BOTH marked `enforce: 'post'` and listed after `tanstackStart()`
// in vite.config.ts.
//
// That same nested `vite.preview()` re-loads vite.config.ts in-process, which
// would otherwise instantiate this plugin a second time mid-build. Hence
// `apply: 'build'` on both halves — the nested instance runs as 'serve'. The
// same split is why vite-plugin-vendor-wasm-assets.ts is two plugins.
//
// So: plugin one captures the client bundle while it is in scope, plugin two
// waits for prerender and emits.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { build, type Plugin } from 'vite';

/** The documents the app is reachable at, as request URLs, not file paths. */
const NAVIGATION_URLS = ['/', '/app'];

/**
 * Only the shell goes in the install-time tier. dist/client/assets also holds
 * ~35 MB of ort-wasm-*.wasm, which belongs to the user-gated model tier and
 * must not be pulled down before anyone has agreed to a download.
 */
const SHELL_EXTENSIONS = ['.js', '.css'];

function isShellAsset(fileName: string): boolean {
  if (fileName.endsWith('.map')) return false;
  return SHELL_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

export function serviceWorker(): Plugin[] {
  let shellFiles: string[] = [];

  return [
    serviceWorkerDev(),
    {
      name: 'service-worker:collect',
      apply: 'build',
      enforce: 'post',
      applyToEnvironment: (environment) => environment.name === 'client',
      writeBundle(_options, bundle) {
        // Worker entry chunks are spawned by absolute URL and appear in no
        // HTML, so crawling the documents would miss them and the app would
        // boot offline but fail the moment it tried to transcribe or speak.
        // Vite emits them as `type: 'asset'` rather than `type: 'chunk'`, so
        // taking every .js in the bundle picks them and their lazy siblings up
        // without name globbing (which would break the moment a worker.ts was
        // renamed).
        shellFiles = Object.keys(bundle).filter(isShellAsset);
      },
    },
    {
      name: 'service-worker:emit',
      apply: 'build',
      enforce: 'post',
      buildApp: {
        order: 'post',
        async handler(builder) {
          const outDir = builder.environments.client.config.build.outDir;

          const urls = [
            ...NAVIGATION_URLS,
            ...shellFiles.map((file) => `/${file}`),
          ].sort();

          await build({
            // Must not re-enter vite.config.ts, or this plugin recurses.
            configFile: false,
            publicDir: false,
            logLevel: 'warn',
            plugins: [injectPrecache(urls)],
            build: {
              outDir,
              // dist/client is fully populated by now — this adds one file.
              emptyOutDir: false,
              target: 'es2022',
              rollupOptions: {
                input: join('src', 'sw.ts'),
                output: {
                  // A classic worker, so registration needs no
                  // `{ type: 'module' }` and no import graph at runtime. iife
                  // already disables code splitting, so everything lands in
                  // the one file.
                  format: 'iife',
                  entryFileNames: 'sw.js',
                },
              },
            },
          });

          console.log(
            `service-worker: ${urls.length} shell entries -> ${outDir}/sw.js`,
          );
        },
      },
    },
  ];
}

/**
 * Serves /sw.js in dev, compiled from the same source with the same bundler
 * and the same output format as the production one — so what you exercise on
 * :3000 is what ships.
 *
 * The difference is entirely in the data: `src/sw-precache.ts` is left at its
 * defaults rather than substituted, so `PRECACHE_URLS` is empty and the worker
 * switches its whole shell tier off (see `SHELL_ENABLED` in sw.ts). What
 * remains is the model tier — gigabytes of wasm and weights cached across
 * reloads, and the byte counts the progress bar reads — with the dev server
 * still serving every module itself.
 *
 * `configureServer` only runs for a real dev server, never for the nested
 * `vite.preview()` the prerender starts, so this cannot shadow the built file.
 */
interface DevBundle {
  code: string;
  modules: Set<string>;
}

function serviceWorkerDev(): Plugin {
  let cached: DevBundle | null = null;

  async function bundle(): Promise<DevBundle> {
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: {
        write: false,
        target: 'es2022',
        // Readable in DevTools, which is most of the point of having it here.
        minify: false,
        rollupOptions: {
          input: join('src', 'sw.ts'),
          output: { format: 'iife', entryFileNames: 'sw.js' },
        },
      },
    });

    // `write: false` rules out the watcher return, which has no output.
    if (!('output' in result)) throw new Error('sw.ts produced no output');

    const chunk = result.output.find((part) => part.type === 'chunk');
    if (!chunk) throw new Error('sw.ts produced no chunk');

    return { code: chunk.code, modules: new Set<string>(chunk.moduleIds) };
  }

  return {
    name: 'service-worker:dev',
    apply: 'serve',
    configureServer(server) {
      // Rebuild when anything that went into the last bundle is edited. The
      // browser refetches /sw.js on every navigation, so a reload is enough to
      // pick the change up.
      server.watcher.on('change', (file) => {
        if (cached?.modules.has(file)) cached = null;
      });

      server.middlewares.use('/sw.js', (_req, res, next) => {
        void (async () => {
          try {
            const built = (cached ??= await bundle());
            res.setHeader('Content-Type', 'text/javascript');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(built.code);
          } catch (err) {
            next(err);
          }
        })();
      });
    },
  };
}

/**
 * Replaces src/sw-precache.ts with the real list for this build. Done as a
 * module substitution rather than a `define` because sw.ts is also imported by
 * its test, where a bare injected identifier would be a ReferenceError.
 */
function injectPrecache(urls: string[]): Plugin {
  // Derived from the contents, so an unchanged build keeps its cache and a
  // changed one gets a fresh bucket that the activate purge can tell apart.
  const buildId = createHash('sha256')
    .update(urls.join('\n'))
    .digest('hex')
    .slice(0, 8);

  return {
    name: 'service-worker:inject-precache',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('sw-precache.ts')) return null;

      return [
        `export const BUILD_ID = ${JSON.stringify(buildId)};`,
        `export const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)};`,
      ].join('\n');
    },
  };
}
