/**
 * Deletes downloads this version of the app no longer uses.
 *
 * The models bucket is never purged (see lib/cache/names.ts), and its entries
 * are keyed by URLs that carry their own version, so a model or dependency
 * change leaves the old files behind rather than replacing them: the other
 * Gemma build if the default changes, every previous runtime. They count
 * against the origin's quota for good, and nothing will ever read them again.
 *
 * Deletes only what it can positively identify as another version of
 * something the app downloads. Getting that wrong is expensive in one
 * direction only: a current file deleted by mistake would be deleted again on
 * every visit, and downloaded again every time.
 *
 * Page-side rather than in the service worker, because it needs to know the
 * current version of each thing, and some of those (the LiteRT version) must
 * not be reachable from the service worker bundle.
 */

import { version as LITERT_VERSION } from '@litert-lm/core/package.json';
import { MODELS_CACHE } from '#/lib/cache/names';
import { ruleFor } from '#/lib/cache/rules';
import { DEFAULT_CHAT_MODEL } from '#/lib/chat/constants';
import { ORT_VERSION } from '#/lib/ort';
import {
  MODEL as WHISPER_MODEL,
  MODEL_REVISION as WHISPER_REVISION,
} from '#/lib/speech-to-text/constants';
import {
  ONNX_WASM_BASE,
  PIPER_WASM_BASE,
  VOICE_REPO,
  VOICE_REVISION,
} from '#/lib/text-to-speech/constants';
import type { PreloadStepId } from './steps';

/** The version in a `/<pkg>@<version>/` path segment, if there is one. */
function versionIn(url: URL, pkg: string): string | undefined {
  const prefix = `/${pkg}@`;
  const start = url.pathname.indexOf(prefix);
  if (start === -1) return undefined;

  const rest = url.pathname.slice(start + prefix.length);
  const end = rest.indexOf('/');
  return (end === -1 ? rest : rest.slice(0, end)) || undefined;
}

/** True only for a version that can be read and isn't `current`. */
function otherVersion(url: URL, pkg: string, current: string): boolean {
  const version = versionIn(url, pkg);
  return version !== undefined && version !== current;
}

/** True for a path under `dir` that isn't under `current`. */
function otherDir(url: URL, dir: string, current: string): boolean {
  return url.pathname.startsWith(dir) && !url.pathname.startsWith(current);
}

const CURRENT_CHAT_MODEL = new URL(DEFAULT_CHAT_MODEL).href;

/**
 * Whether a file the step's rule matched belongs to a version the app no
 * longer uses. A total record, so a new step has to decide what stale means
 * for it.
 *
 * Deliberately not caught: leftover files of the *current* Whisper model at
 * another precision. Telling those apart means reproducing Transformers.js'
 * file naming, and a mistake there would delete the current weights on every
 * visit.
 */
const IS_STALE: Record<PreloadStepId, (url: URL) => boolean> = {
  'text-to-speech-runtime': (url) =>
    otherDir(url, '/vendor/onnx/', ONNX_WASM_BASE) ||
    otherDir(url, '/vendor/piper-wasm/', PIPER_WASM_BASE),
  // Any other commit, `main` included, or any other repo of piper voices.
  'text-to-speech': (url) =>
    !url.pathname.startsWith(`/${VOICE_REPO}/resolve/${VOICE_REVISION}/`),
  'speech-to-text': (url) =>
    url.hostname === 'huggingface.co'
      ? // Another commit of the same model is stale too, `main` included. The
        // slashes keep e.g. whisper-small.en from passing as whisper-small.
        !url.pathname.startsWith(
          `/${WHISPER_MODEL}/resolve/${WHISPER_REVISION}/`,
        )
      : otherVersion(url, 'onnxruntime-web', ORT_VERSION),
  'chat-runtime': (url) => otherVersion(url, '@litert-lm/core', LITERT_VERSION),
  // One file, fetched by its exact URL (see fetchModel in lib/chat/engine.ts).
  chat: (url) => url.href !== CURRENT_CHAT_MODEL,
};

/**
 * Deletes stale files from the models bucket, and any entry no rule matches
 * any more, which the service worker would never serve again. Markers are
 * left alone: a few bytes each, and keyed by version so they never match.
 *
 * Resolves to how many entries it deleted. Never rejects: a sweep that fails
 * only leaves the space used, as it was.
 */
export async function sweepStaleAssets(): Promise<number> {
  if (typeof caches === 'undefined') return 0;

  try {
    const cache = await caches.open(MODELS_CACHE);
    const stale = (await cache.keys()).filter((request) => {
      const url = new URL(request.url);
      if (url.hostname.endsWith('.invalid')) return false;

      const rule = ruleFor(url);
      return !rule || IS_STALE[rule.step](url);
    });

    await Promise.all(stale.map((request) => cache.delete(request)));

    if (stale.length > 0) {
      console.info(
        'Deleted stale downloads:',
        stale.map((request) => request.url),
      );
    }

    return stale.length;
  } catch (err) {
    console.warn('Stale download sweep failed (continuing):', err);
    return 0;
  }
}
