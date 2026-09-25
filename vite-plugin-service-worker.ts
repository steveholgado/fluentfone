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
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { build, type Plugin } from 'vite';

/**
 * The one page precached for offline use, as a request URL. Every other page
 * — the home page included — is left to the network, and so is its code.
 */
const APP_URL = '/app';

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

/** A .js or .css file in the client bundle, keyed by its bundle file name. */
interface ShellFile {
  /** The shell files it loads. */
  loads: string[];
  /**
   * The route file it was split from, for TanStack's per-route chunks
   * (`src/routes/app.tsx?tsr-split=component`). Undefined for everything else.
   */
  route?: string;
}

export function serviceWorker(): Plugin[] {
  let shellFiles = new Map<string, ShellFile>();

  return [
    serviceWorkerDev(),
    {
      name: 'service-worker:collect',
      apply: 'build',
      enforce: 'post',
      applyToEnvironment: (environment) => environment.name === 'client',
      writeBundle(_options, bundle) {
        const outputs = Object.values(bundle).filter((output) =>
          isShellAsset(output.fileName),
        );

        // Worker entry chunks are spawned by URL and appear in no HTML. Vite
        // builds them separately and emits them as `type: 'asset'`, so the
        // chunk graph has no edge to them, nor from them to their own imports.
        // The only link is the file name in the referencing code — so that's
        // what is matched, for .js assets only. Matching CSS the same way
        // would drag in every route's stylesheet through the entry's preload
        // map.
        const scripts = outputs
          .filter((output) => output.type === 'asset')
          .map((output) => output.fileName)
          .filter((fileName) => fileName.endsWith('.js'));

        const mentioned = (code: string, candidates: string[]) =>
          candidates.filter((fileName) => code.includes(basename(fileName)));

        shellFiles = new Map(
          outputs.map((output): [string, ShellFile] => {
            if (output.type === 'asset') {
              const code = Buffer.from(output.source).toString('utf8');
              const others = outputs
                .map((other) => other.fileName)
                .filter((fileName) => fileName !== output.fileName);

              return [output.fileName, { loads: mentioned(code, others) }];
            }

            const [module, query] = (output.facadeModuleId ?? '').split('?');

            return [
              output.fileName,
              {
                loads: [
                  ...output.imports,
                  ...output.dynamicImports,
                  ...(output.viteMetadata?.importedCss ?? []),
                  ...(output.viteMetadata?.importedAssets ?? []),
                  ...mentioned(output.code, scripts),
                ].filter(isShellAsset),
                route: query?.startsWith('tsr-split=') ? module : undefined,
              },
            ];
          }),
        );
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

          const document = await readFile(
            join(outDir, APP_URL, 'index.html'),
            'utf8',
          ).catch((err: unknown) => {
            throw new Error(
              `service-worker: ${APP_URL} was not prerendered, so there is no document to precache`,
              { cause: err },
            );
          });

          const urls = [
            APP_URL,
            ...appFiles(shellFiles, document).map((file) => `/${file}`),
          ].sort();

          await build({
            // Must not re-enter vite.config.ts, or this plugin recurses.
            configFile: false,
            publicDir: false,
            logLevel: 'warn',
            plugins: [injectPrecache(urls, shellBuildId(urls, [document]))],
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
 * Everything the /app document needs to boot and run, and nothing only another
 * page does.
 *
 * Starts from the files the prerendered document references and follows what
 * each of those loads. Route chunks are where pages part ways: the entry chunk
 * lazily imports every route's, so the walk takes only the chunks split from
 * the app's own route files and never another page's. That includes the app
 * route's splits the document doesn't reference — a pending or error
 * component, say, loaded only when needed.
 */
function appFiles(
  shellFiles: Map<string, ShellFile>,
  document: string,
): string[] {
  const referenced = [...shellFiles.keys()].filter((fileName) =>
    document.includes(`/${fileName}`),
  );

  if (referenced.length === 0) {
    throw new Error(
      `service-worker: the ${APP_URL} document references nothing in the client bundle`,
    );
  }

  const appRoutes = new Set(
    referenced.map((fileName) => shellFiles.get(fileName)?.route),
  );
  appRoutes.delete(undefined);

  const queue = [...referenced];
  for (const [fileName, file] of shellFiles) {
    if (appRoutes.has(file.route)) queue.push(fileName);
  }

  const found = new Set<string>();

  while (queue.length > 0) {
    const fileName = queue.pop()!;
    const file = shellFiles.get(fileName);

    if (!file || found.has(fileName)) continue;
    if (file.route !== undefined && !appRoutes.has(file.route)) continue;

    found.add(fileName);
    queue.push(...file.loads);
  }

  return [...found];
}

/**
 * TanStack Router stamps each dehydrated match with the time it rendered
 * (`u:1790341394543`), so two builds of the same source never produce the
 * same HTML byte for byte. If the format ever changes and this stops
 * matching, every build gets a fresh id — a wasted re-download, never a stale
 * shell.
 */
const RENDER_TIMESTAMP = /\bu:\d{13}\b/g;

/**
 * Derived from the contents, so an unchanged build keeps its cache and a
 * changed one gets a fresh bucket that the activate purge can tell apart.
 *
 * The URL list covers the hashed assets, whose names change with their bytes.
 * The documents are served from fixed URLs, so their bytes go in too —
 * otherwise a deploy that changed only the prerendered HTML would leave sw.js
 * byte-identical, no update would install, and returning visitors would be
 * served the old documents from the cache indefinitely.
 */
function shellBuildId(urls: string[], documents: string[]): string {
  const hash = createHash('sha256').update(urls.join('\n'));

  for (const document of documents) {
    hash.update('\0').update(document.replace(RENDER_TIMESTAMP, ''));
  }

  return hash.digest('hex').slice(0, 8);
}

/**
 * Replaces src/sw-precache.ts with the real list for this build. Done as a
 * module substitution rather than a `define` because sw.ts is also imported by
 * its test, where a bare injected identifier would be a ReferenceError.
 */
function injectPrecache(urls: string[], buildId: string): Plugin {
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
