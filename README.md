# App

A minimal TanStack Start app with one route and plain CSS.

```bash
pnpm install
pnpm dev
```

Edit `src/routes/index.tsx` to get started. Add route files under
`src/routes`; TanStack Router updates `src/routeTree.gen.ts` for you.

Build the production app with:

```bash
pnpm build
```

## The `/app` route, stage by stage

Everything runs in the browser — speech-to-text, chat and text-to-speech are
three local models with three wasm runtimes behind them. The route is built so
that every multi-megabyte download happens in one place, after the user has
agreed to it.

### Initial load

- Page assets only — React + router and the route chunk, served by the service
  worker once it has been installed
- No model libraries, no workers

### Check

- Register the service worker and wait until it controls the page — it has to
  be in charge before anything is fetched, or it would see none of it
- Read five step markers from the `models-v1` cache
- Read OPFS for the voice, which piper-tts-web owns and we can only observe
- No network, no workers, no libraries loaded
- All five present → straight to the conversation; anything missing → preload

### Preload

Only the missing steps run, smallest first, each with its own progress bar:

1. Piper + ONNX wasm — self-hosted from `public/vendor/`
2. Voice model → OPFS
3. ONNX wasm for Whisper + Whisper weights — jsDelivr and Hugging Face
4. LiteRT wasm — jsDelivr
5. Chat model → Hugging Face

Speech-to-text is one step rather than two because nothing in the
Transformers.js API downloads its wasm runtime without also building the
pipeline. The others split, so the runtime and the weights each get a full
0→100% sweep instead of sharing a bar whose total jumps partway through.

### Conversation

- **Connecting** — briefly, before the first stage reports
- **Warming up…** — the engine compiles the chat model
- **Generating…** — the greeting is written
- **Downloading voice model… 45%** — the greeting is turned into speech
- **Incoming call** — ready to answer

No downloads belong in this stage. If one happens anyway — a cache evicted
since — it shows as **Downloading…** rather than sitting silent.

When the check passes fully, the five preload steps still run quietly in the
background here. They're all cache reads at that point, and they're what gets
the engine warm before the call is answered.

## Caching

One service worker (`src/sw.ts`) owns it all, and `src/lib/assets.ts` is the
only place URLs, cache policy and expected sizes are written.

Two buckets, because they have opposite lifecycles:

- **`shell-<build id>`** — the app shell, precached on install so the app boots
  offline. Replaced wholesale on each deploy; the old one is purged on activate.
- **`models-v1`** — runtimes, weights, and the step markers that vouch for them.
  Cached on first fetch during the preload the user agreed to, and never purged.

A marker lives in the same bucket as the bytes it stands for, which is what
makes it trustworthy: browsers evict storage per origin, not per entry, so it
cannot outlive them. Each marker is keyed by whatever makes the download
distinct — a voice id, a model URL, a version-stamped path — so switching model
or bumping a dependency misses rather than matching something stale.

The voice is the one exception. piper-tts-web writes it to OPFS and offers no
way to point it elsewhere, so the worker counts those bytes without storing
them, and the check reads OPFS directly.

### How a request is served

Requests come from the page, the two web workers, and the libraries themselves
(LiteRT-LM, Transformers.js, piper). All of them are controlled, so all of them
land here.

```
fetch
 │
 ├─ not GET ───────────────────────────────────────────────▶ network
 │
 ├─ matches an ASSET_RULE?   (runtimes + weights, mostly cross-origin)
 │    │
 │    ├─ hit in models-v1 ────────────────────────────────▶ serve from cache
 │    │                                                      (no bytes, no progress)
 │    └─ miss ─▶ network ─┬─ count bytes ─▶ BroadcastChannel ─▶ progress bar
 │                        └─ store in models-v1
 │                           …except the voice (cache:false) — counted only,
 │                             because piper writes it to OPFS itself
 │
 ├─ cross-origin, no rule ────────────────────────────────▶ network
 │
 ├─ SHELL_ENABLED == false  (dev: empty precache list) ───▶ network / dev server
 │
 ├─ navigation  ('/', '/app') ────────────────────────────▶ shell-<build id>
 │                                                            else network
 └─ path in PRECACHE_URLS ────────────────────────────────▶ shell-<build id>
                                                              else network
```

### First ever visit

```
GET /app                     ← network (nothing controls this one yet)
JS / CSS                     ← network
  │
  ▼  page boots, ensureController()
register /sw.js
  │
  ├─ install   → cache.addAll(PRECACHE_URLS) → shell-<build id>  [14 files, ~1 MB]
  │             → skipWaiting()                   (first install only)
  └─ activate  → purge other shell-* buckets
                → clients.claim()     ← now controls the page AND both web workers
  │
  ▼  checkPreloaded()
4 marker probes in models-v1 + 1 OPFS listing  →  all miss
  │
  ▼  user clicks Download
preloadAll() — five steps, strictly one at a time:

    tts-runtime  /vendor/*            → models-v1
    voice        HF piper-voices      → OPFS          (counted, not stored)
    whisper      jsDelivr + HF        → models-v1
    chat-runtime jsDelivr             → models-v1
    chat         HF litert-community  → models-v1     (~3 GB)

  each step:  library fetch ─▶ worker ─▶ network ─┬─▶ cache
                                                  └─▶ bytes ─▶ progress bar
  each step ends: the page writes a marker into models-v1
  │
  ▼
Start
```

### Every visit after

```
GET /app                     ← shell-<build id>  ┐
JS / CSS / worker chunks     ← shell-<build id>  ┘ worker controls from byte one
                                                   → boots with no network at all
  │
  ▼  ensureController()      ← already controlling, returns immediately
  ▼  checkPreloaded()        ← 4 markers hit + voice found in OPFS
  │
  ▼
preload screen skipped entirely → straight to the conversation
  │
  ▼  during the conversation
model + runtime fetches      ← models-v1, no network
voice                        ← OPFS, no fetch at all
```

### Where progress comes from

The libraries fetch their own wasm and report nothing while doing it. Rather
than predict their URLs and fetch them first ourselves — which meant
reproducing LiteRT-LM's four-way build selection and keeping it in step with
upstream — the service worker counts bytes as they stream past and broadcasts
them. `preloadAll` runs strictly one step at a time, which is what makes those
bytes attributable to a step.

The bar never moves backwards, so a total that grew mid-step would strand it.
Each step therefore starts from an estimate in `EXPECTED_BYTES` and takes
`max(estimate, observed)`, so a stale estimate is corrected by observation
rather than believed. Refresh them on a dependency bump; being wrong is cheap
in both directions.

### In dev

The worker runs in dev too, but with its shell tier switched off. The two tiers
have very different risk profiles: caching the shell on the dev origin would
serve stale modules and break HMR, while caching the models is the only thing
that makes the dev loop bearable — the chat model alone is 3 GB, and without it
that comes down on every reload.

`vite-plugin-service-worker.ts` serves `/sw.js` in dev by compiling `src/sw.ts`
with the same bundler and output format as the production one. The only
difference is the data: `src/sw-precache.ts` is left at its defaults, so
`PRECACHE_URLS` is empty, and `SHELL_ENABLED` in `sw.ts` turns off precaching,
navigation handling and shell asset serving in one go. Every same-origin
request goes straight to the dev server; `ASSET_RULES` still apply, so the
models, the CDN runtimes and `public/vendor/` are cached and counted as usual.

The bundle is rebuilt whenever a file that went into it is edited, and the
browser refetches `/sw.js` on every navigation, so a reload picks up a change to
`sw.ts`. The dev worker also calls `skipWaiting()` on every install rather than
only the first — there is no shell to swap out from under a running page, and
waiting a navigation would just make an edit look like it hadn't taken.

One consequence worth knowing: the vendored wasm under `/vendor/` is now cached
in dev, where it used to re-download each load. Those paths are version-stamped,
so a dependency bump misses rather than serving stale bytes — but hand-editing a
vendored file in place would not.

The offline path only exists in a real build. Test that with `pnpm preview`
(port 4173).

### Updates

A new deploy installs alongside the old worker and activates on the next
navigation, so a reload picks it up. `models-v1` survives that untouched.

Production serves the vendored files `immutable`, and `/sw.js` as `no-cache` so
an update is never masked by the HTTP cache (see `public/_headers`).
