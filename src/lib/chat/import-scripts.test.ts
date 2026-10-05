import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installClassicScriptLoader } from '#/lib/chat/import-scripts';

const opened: Array<[string, string, boolean]> = [];

let status = 200;
let responseText = '';

class FakeXhr {
  status = 0;
  responseText = '';

  open(method: string, url: string, async: boolean) {
    opened.push([method, url, async]);
  }

  send() {
    this.status = status;
    this.responseText = responseText;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __shimProbe: number | undefined;
}

let scope: {
  importScripts?: (...urls: Array<string | URL>) => void;
  Module?: {
    locateFile?: (path: string) => string;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  };
};

beforeEach(() => {
  opened.length = 0;
  status = 200;
  responseText = '';
  scope = {};
  vi.stubGlobal('self', scope);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete globalThis.__shimProbe;
});

describe('installClassicScriptLoader', () => {
  it('replaces importScripts, which a module worker has but cannot call', () => {
    expect(scope.importScripts).toBeUndefined();

    installClassicScriptLoader();

    expect(typeof scope.importScripts).toBe('function');
  });

  it('fetches synchronously, since wasm-utils reads the result on the next line', () => {
    installClassicScriptLoader();

    scope.importScripts?.('https://cdn.example/litertlm_wasm_internal.js');

    expect(opened).toEqual([
      ['GET', 'https://cdn.example/litertlm_wasm_internal.js', false],
    ]);
  });

  it('evaluates the script in global scope, where wasm-utils looks for it', () => {
    // The whole reason this shim exists rather than an import(): the glue ends
    // in a bare `var ModuleFactory = ...`, and the library reads it off the
    // global object immediately afterwards.
    responseText = 'var __shimProbe = 42;';
    installClassicScriptLoader();

    scope.importScripts?.('https://cdn.example/glue.js');

    expect(globalThis.__shimProbe).toBe(42);
  });

  it('accepts a URL object as well as a string', () => {
    installClassicScriptLoader();

    scope.importScripts?.(new URL('https://cdn.example/glue.js'));

    expect(opened[0][1]).toBe('https://cdn.example/glue.js');
  });

  it('loads every url it is given, in order', () => {
    installClassicScriptLoader();

    scope.importScripts?.(
      'https://cdn.example/a.js',
      'https://cdn.example/b.js',
    );

    expect(opened.map(([, url]) => url)).toEqual([
      'https://cdn.example/a.js',
      'https://cdn.example/b.js',
    ]);
  });

  it('points the glue at the wasm next to the script it loaded', () => {
    // Emscripten resolves its .wasm against `self.location.href` in any
    // worker, which is this bundled worker rather than the CDN the glue came
    // from — so without this it would 404 on our own origin.
    installClassicScriptLoader();

    scope.importScripts?.(
      'https://cdn.example/npm/@litert-lm/core@0.17.1/wasm/litertlm_wasm_internal.js',
    );

    expect(scope.Module?.locateFile?.('litertlm_wasm_internal.wasm')).toBe(
      'https://cdn.example/npm/@litert-lm/core@0.17.1/wasm/litertlm_wasm_internal.wasm',
    );
  });

  it('resolves the wasm against whichever build variant was selected', () => {
    // The library picks one of four builds by feature detection; the locator
    // has to follow whichever it actually asked for.
    installClassicScriptLoader();

    scope.importScripts?.(
      'https://cdn.example/wasm/litertlm_wasm_compat_asyncify_internal.js',
    );

    expect(
      scope.Module?.locateFile?.('litertlm_wasm_compat_asyncify_internal.wasm'),
    ).toBe(
      'https://cdn.example/wasm/litertlm_wasm_compat_asyncify_internal.wasm',
    );
  });

  it('throws on an HTTP error rather than evaluating the error page', () => {
    status = 404;
    responseText = 'var __shimProbe = 1;';
    installClassicScriptLoader();

    expect(() =>
      scope.importScripts?.('https://cdn.example/missing.js'),
    ).toThrow('Failed to load script (404)');
    expect(globalThis.__shimProbe).toBeUndefined();
  });

  it('treats status 0 as a failure', () => {
    status = 0;
    installClassicScriptLoader();

    expect(() => scope.importScripts?.('https://cdn.example/glue.js')).toThrow(
      'Failed to load script (0)',
    );
  });

  it('leaves the engine’s native trace wired to the console in dev', () => {
    expect(import.meta.env.DEV).toBe(true);
    installClassicScriptLoader();

    scope.importScripts?.('https://cdn.example/glue.js');

    expect(scope.Module?.print).toBeUndefined();
    expect(scope.Module?.printErr).toBeUndefined();
  });

  it('silences the engine’s native trace via Module.print and Module.printErr in production', () => {
    vi.stubEnv('DEV', false);
    installClassicScriptLoader();

    scope.importScripts?.('https://cdn.example/glue.js');

    expect(scope.Module?.print).toBeTypeOf('function');
    expect(scope.Module?.printErr).toBeTypeOf('function');
    expect(() => scope.Module?.print?.('some native trace line')).not.toThrow();
    expect(() =>
      scope.Module?.printErr?.('WARNING: some native trace line'),
    ).not.toThrow();
  });
});
