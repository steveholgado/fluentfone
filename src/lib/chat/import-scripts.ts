/**
 * Lets LiteRT-LM load its wasm glue, and find the wasm itself, from inside a
 * *module* worker.
 *
 * `@litertjs/wasm-utils` knows two ways to load that glue and no others:
 * `importScripts()` where it exists, and appending a `<script>` tag otherwise.
 * A module worker has neither — no DOM, and `importScripts` is present on
 * WorkerGlobalScope but throws "Module scripts don't support importScripts()"
 * the moment it is called — so the library cannot start at all without this.
 *
 * The obvious alternative is to make the worker a classic one, which is what
 * the library expects. Two things argue against it:
 *
 * 1. Vite reads a worker's type per call site but `config.worker.format`
 *    globally, so a classic worker here forces the speech-to-text and
 *    text-to-speech bundles to IIFE as well — in production only, since dev
 *    serves module workers natively. That puts the two capabilities that work
 *    at risk to fix the one that doesn't.
 * 2. Real `importScripts()` fetches in no-cors mode. The service worker would
 *    get an opaque response back from `serveAsset`, bail before caching or
 *    counting it, and still let `preloadRuntime()` write its marker — so the
 *    20 MB runtime would re-download every session while `isRuntimeCached()`
 *    claimed it was on disk. The XHR below is CORS-mode, exactly like the
 *    `<script crossorigin="anonymous">` the main thread used to append, so
 *    `sw.ts` keeps caching and counting it with no changes.
 *
 * Note that only the first of those two jobs is about being a module worker.
 * The wasm path below is wrong in a classic worker too — emscripten derives it
 * from `self.location.href` whenever it is in one — so that half would still
 * be needed had we gone the other way.
 *
 * If a later version of the library loads its glue as a real module, delete
 * this: the failure would be loud (`ModuleFactory not set.`), not silent.
 */

export function installClassicScriptLoader(): void {
  const scope = self as unknown as {
    importScripts: (...urls: Array<string | URL>) => void;
    Module?: {
      locateFile?: (path: string) => string;
      print?: (text: string) => void;
      printErr?: (text: string) => void;
    };
  };

  scope.importScripts = (...urls) => {
    for (const url of urls) {
      const scriptUrl = new URL(String(url), location.href).href;
      const request = new XMLHttpRequest();

      // Synchronous, because `importScripts()` is: wasm-utils calls it and
      // reads `self.ModuleFactory` on the next line. Nothing but this worker
      // is blocked, which is the point of being in one.
      request.open('GET', scriptUrl, false);
      request.send();

      // A cross-origin XHR that CORS refuses throws from send() rather than
      // arriving here, so this is the ordinary HTTP-error path. Status 0 is
      // not success either, whatever produced it.
      if (request.status < 200 || request.status >= 300) {
        throw new Error(
          `Failed to load script (${request.status}): ${scriptUrl}`,
        );
      }

      // Where the glue should look for its .wasm. Emscripten works that out
      // from the URL of the script it was loaded as, and in *any* worker —
      // this one or a classic one — that is `self.location.href`, which is
      // this bundled worker rather than the CDN the glue came from. Left
      // alone it would resolve `litertlm_wasm_internal.wasm` against our own
      // origin and 404.
      //
      // `Module.locateFile` takes precedence over that guess, and wasm-utils
      // passes `self.Module` straight into the factory (`var Module =
      // moduleArg`), so this is the supported way in rather than a second
      // patch. Resolved against the script actually fetched above, so it
      // stays correct whichever of the four wasm builds was selected.
      scope.Module = {
        ...scope.Module,
        locateFile: (path: string) => new URL(path, scriptUrl).href,
        // The engine's native side logs its own trace unconditionally —
        // engine settings, the full jinja prompt template, per-step timings
        // on stdout, and INFO/WARNING lines from its own logger (accelerator
        // registration, NPU availability, etc.) on stderr — and there is no
        // verbosity flag for either. `print`/`printErr` are the documented
        // emscripten hooks for the two streams; left unset they fall back to
        // `console.log`/`console.error`, which is how that trace reaches
        // devtools. Actual failures don't travel this way: they reject the
        // SDK call itself, which worker.ts's try/catch already reports — so
        // silencing both here in production loses nothing but the noise.
        // Left wired to the console in dev, where that trace is more often
        // useful than not.
        ...(import.meta.env.DEV ? {} : { print: () => {}, printErr: () => {} }),
      };

      // Indirect eval, so the glue is evaluated in global scope. That is the
      // whole reason it can't simply be imported: the file ends in a bare
      // `var ModuleFactory = ...` with no `self.` or `globalThis.` assignment,
      // and wasm-utils reads `self.ModuleFactory` immediately afterwards. A
      // direct eval would scope that `var` to this function and a dynamic
      // import() would scope it to a module, either of which leaves the
      // library throwing "ModuleFactory not set.". None of the four wasm
      // builds is strict-mode, so `var` does reach the global object.
      // eslint-disable-next-line no-eval
      (0, eval)(request.responseText);
    }
  };
}
