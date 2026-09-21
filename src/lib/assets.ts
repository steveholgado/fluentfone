/**
 * Everything the app downloads, in one table: where it comes from, whether the
 * service worker stores it, and roughly how big it is.
 *
 * This is the bottom of the import graph on purpose. Both `sw.ts` and the page
 * import it, so it must pull in nothing heavier than itself — no library code,
 * no worker glue.
 */

/** The three capabilities, as the preload screen lists them. */
export type PreloadLabel = 'speech-to-text' | 'chat' | 'text-to-speech';

/**
 * A step is one contiguous 0→100% run of the progress bar.
 *
 * Two capabilities split their wasm runtime from their weights, because the
 * runtime is fetched by a separate call we control and a single bar spanning
 * both would have to restart its total partway through. Speech-to-text does
 * not: nothing in the Transformers.js API downloads its ONNX Runtime without
 * also building the pipeline, so the two arrive together and share one bar.
 */
export type PreloadStepId =
  | 'text-to-speech-runtime'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'chat-runtime'
  | 'chat';

/** Which downloads are already done, keyed by step. */
export type PreloadStatus = Record<PreloadStepId, boolean>;

/** The order preloadAll downloads in — smallest first. */
export const DOWNLOAD_ORDER: PreloadStepId[] = [
  'text-to-speech-runtime',
  'text-to-speech',
  'speech-to-text',
  'chat-runtime',
  'chat',
];

/** The steps behind each label, for rolling them up in the UI. */
export const STEPS_BY_LABEL: Record<PreloadLabel, PreloadStepId[]> = {
  'text-to-speech': ['text-to-speech-runtime', 'text-to-speech'],
  'speech-to-text': ['speech-to-text'],
  chat: ['chat-runtime', 'chat'],
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * There are two buckets rather than one because they have opposite lifecycles:
 * the shell is replaced wholesale on every deploy, while the models are
 * gigabytes the user agreed to download and must survive every deploy.
 * Conflating them would mean the activate-time purge had to tell them apart by
 * URL shape, and get it right every time or drop 3 GB.
 */
export function shellCacheName(buildId: string): string {
  return `shell-${buildId}`;
}

/** Matches any build's shell bucket, for the activate-time purge. */
export const SHELL_CACHE_PREFIX = 'shell-';

/**
 * Runtimes, model weights, and the markers that vouch for them. Never purged,
 * and never versioned — entries are keyed by URLs that already carry their own
 * version, so a dependency bump misses rather than matching stale bytes.
 */
export const MODELS_CACHE = 'models-v1';

// ---------------------------------------------------------------------------
// The assets themselves
// ---------------------------------------------------------------------------

/** Self-hosted by vite-plugin-vendor-wasm-assets.ts; versioned by path. */
export const ONNX_WASM_BASE = '/vendor/onnx/1.23.2/';
export const PIPER_WASM_BASE = '/vendor/piper-wasm/1.0.0/';

/**
 * The chat weights. Here rather than in `lib/chat` because EXPECTED_BYTES
 * below has to know which one is configured to size its floor, and this file
 * is the bottom of the import graph — it cannot reach up into the chat module
 * to ask, and the chat module already imports from here.
 */
export const CHAT_MODELS = {
  /** Lower-end devices — smaller/faster, less capable. */
  e2b: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  /** Default — better output quality, for devices that can handle it. */
  e4b: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
};

export const DEFAULT_CHAT_MODEL = CHAT_MODELS.e2b;

export interface AssetRule {
  step: PreloadStepId;
  /** Recognises the step's downloads wherever they are issued from. */
  matches: (url: URL) => boolean;
  /**
   * Whether the service worker stores the bytes. False where another store
   * already owns them and a second copy would just double the disk cost.
   */
  cache: boolean;
}

/**
 * Deliberately coarse patterns rather than exact URLs. The whole point of
 * letting the libraries fetch their own wasm is that we stop reproducing their
 * build-variant selection logic, so these must match every variant a browser
 * might pick.
 */
export const ASSET_RULES: AssetRule[] = [
  {
    step: 'text-to-speech-runtime',
    matches: (url) => url.pathname.startsWith('/vendor/'),
    cache: true,
  },
  {
    step: 'text-to-speech',
    matches: (url) =>
      url.hostname === 'huggingface.co' &&
      url.pathname.includes('piper-voices'),
    // piper-tts-web writes voices to OPFS itself, and there is no way to point
    // it elsewhere. Counting them without storing them keeps the progress bar
    // honest without paying for the voice twice.
    cache: false,
  },
  {
    step: 'speech-to-text',
    matches: (url) =>
      (url.hostname === 'cdn.jsdelivr.net' &&
        url.pathname.includes('onnxruntime-web@')) ||
      (url.hostname === 'huggingface.co' &&
        url.pathname.includes('onnx-community/whisper')),
    cache: true,
  },
  {
    step: 'chat-runtime',
    matches: (url) =>
      url.hostname === 'cdn.jsdelivr.net' &&
      url.pathname.includes('@litert-lm/core@'),
    cache: true,
  },
  {
    step: 'chat',
    matches: (url) =>
      url.hostname === 'huggingface.co' &&
      url.pathname.includes('litert-community'),
    cache: true,
  },
];

export function ruleFor(url: URL): AssetRule | undefined {
  return ASSET_RULES.find((rule) => rule.matches(url));
}

/**
 * Roughly what each step downloads, used only as a floor for the progress
 * bar's denominator.
 *
 * The service worker learns a file's real size when its headers arrive, which
 * for a multi-file step is *after* the bar has already started moving — and
 * the bar never moves backwards, so a denominator that grew mid-step would
 * strand it. Starting from an estimate avoids that.
 *
 * Being wrong is cheap in both directions: too low and the observed total wins
 * (see `trackStep`), too high and the bar finishes a little short before the
 * step's terminal 100% snaps it up. Refresh on a dependency bump by taking the
 * Content-Length of each file; measured 2026-09-19.
 *
 * The text-to-speech figure is per voice. Every piper "medium" voice happens
 * to be the same size, so it holds for either entry in VOICES — but a voice at
 * another quality would need a new figure.
 */
export const EXPECTED_BYTES: Partial<Record<PreloadStepId, number>> = {
  'text-to-speech-runtime': 30_638_000,
  'text-to-speech': 63_206_000,
  'speech-to-text': 101_000_000,
  'chat-runtime': 20_140_000,
  // Unlike the others this is a single file, so its Content-Length is normally
  // known before the first byte and this estimate goes unused. It is here for
  // the case where it isn't: a response that declares no length would
  // otherwise leave the longest download in the app with no denominator at all
  // and a bar that cannot move. Keyed off which model is actually configured,
  // since the two differ by a third.
  chat: DEFAULT_CHAT_MODEL === CHAT_MODELS.e2b ? 2_008_432_000 : 2_969_059_000,
};

// ---------------------------------------------------------------------------
// What is already on disk
// ---------------------------------------------------------------------------

/**
 * Whether the bytes for `url` are in the models cache.
 *
 * Stronger evidence than the step marker below, and not interchangeable with
 * it: a Cache Storage write either lands whole or rejects, so an entry's
 * presence means the complete response is there — whereas a marker is written
 * by a separate call that runs happily after the write it vouches for has
 * failed. Ask this where the bytes themselves are what matters; ask `hasStep`
 * where the question is whether a step's work was done (its bytes may live
 * somewhere else entirely, as the voice's do).
 *
 * Cheap: a match reads headers, not the body, so this does not touch the
 * gigabytes it reports on.
 */
export async function hasAsset(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  try {
    const cache = await caches.open(MODELS_CACHE);
    // ignoreVary because the response was stored against the library's own
    // fetch, whose headers are not necessarily the ones asked about here.
    return (await cache.match(url, { ignoreVary: true })) !== undefined;
  } catch (err) {
    // Assume not cached: the caller re-fetches, which is slow but correct.
    console.warn('Asset cache probe failed (assuming not cached):', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step markers
// ---------------------------------------------------------------------------

/**
 * A marker records that a step finished. It lives in the same bucket as the
 * bytes it vouches for, which is what makes it trustworthy: browsers evict
 * storage per origin, not per entry, so a marker cannot outlive its bytes.
 *
 * `key` carries whatever makes the download distinct — a voice id, a model
 * URL, a version-stamped path — so switching model or bumping a dependency
 * misses rather than matching a stale marker.
 *
 * Cache Storage keys have to be requests, so this maps onto a URL that is
 * never fetched.
 */
function markerUrl(step: PreloadStepId, key: string): string {
  return `https://step.invalid/${step}/${encodeURIComponent(key)}`;
}

export async function markStep(
  step: PreloadStepId,
  key: string,
): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(markerUrl(step, key), new Response('1'));
  } catch (err) {
    // A missing marker only costs a redundant download next time.
    console.warn('Step marker write failed (continuing):', err);
  }
}

export async function hasStep(
  step: PreloadStepId,
  key: string,
): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  const cache = await caches.open(MODELS_CACHE);
  return (await cache.match(markerUrl(step, key))) !== undefined;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Carries byte counts from the service worker to whoever is listening. */
export const PROGRESS_CHANNEL = 'asset-progress';

export interface AssetProgressMessage {
  step: PreloadStepId;
  url: string;
  loaded: number;
  /** Null where the response declared no Content-Length. */
  total: number | null;
}
