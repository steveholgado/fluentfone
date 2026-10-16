# Architecture

How the `/app` route downloads, caches and runs its three models, and how the
service worker keeps it all on disk across visits and deploys.

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

- Check the device can run the models (`src/lib/device/`): today that means
  WebGPU, which the chat engine can't run without. If it's missing, the screen
  says so and the app stops here, before even the service worker is registered,
  so nothing is downloaded
- Ask the browser to keep this origin's storage (`src/lib/cache/persist.ts`).
  Asked on every load and not waited on: Chrome and Safari decide by their own
  engagement heuristics, often saying no on a first visit and yes later
- Register the service worker and wait until it controls the page — it has to
  be in charge before anything is fetched, or it would see none of it
- Delete files an older build downloaded and this one no longer uses (see
  [Changing a model or dependency](#changing-a-model-or-dependency))
- Read four step markers from the `models-v1` cache, and look up the voice's
  two files there directly
- No network, no workers, no libraries loaded
- All five present → straight to the conversation; anything missing → preload

### Preload

All five steps start at once, under one progress bar:

- Piper + ONNX wasm — self-hosted from `public/vendor/`
- Voice model — Hugging Face, pinned to a commit
- ONNX wasm for Whisper + Whisper weights — jsDelivr and Hugging Face
- LiteRT wasm — jsDelivr
- Chat model — Hugging Face, pinned to a commit

Nothing here builds a model — that waits for the conversation (see below) — so
the steps share only bandwidth. Running them together overlaps the gaps a
sequence leaves between them (worker start-up, redirects, the wait for first
bytes) and any per-connection limit a CDN puts on a single stream. The one
exception to "nothing is built" is the LiteRT runtime, which is loaded as well
as fetched; at tens of megabytes it can share the moment.

Every step runs, even ones the check found on disk. A cached step costs next to
nothing, since its files come straight out of `models-v1`, and one whose marker
outlived its bytes downloads anyway. The bar's total is only what the check
found missing — the same figure the screen quoted — and bytes from a step
thought cached join it as they're seen. The checklist ticks each step off as it
finishes, in whatever order that turns out to be.

If a step fails, the others are left to finish before the error shows, so what
they fetched is kept for a retry and nothing is still downloading behind a
screen that says the download failed.

Speech-to-text is one step rather than two because one request to its worker
fetches both its ONNX Runtime and its weights. Text-to-speech and chat split
their runtime from their weights, and each runtime has its own marker, since
it can be missing while the weights are on disk.

The screen gives the size of what's left to download and asks for a normal
window, since private windows can't keep downloads this size. It says so to
everyone rather than checking: browsers deliberately hide private mode, and
`navigator.storage.estimate()` can't be trusted to reveal it — it can't see a
full disk, and Brave reports a fixed 2 GiB whatever the real limit. In a normal
window, every browser with WebGPU allows far more than the app needs. When a
save does fail, the write-failure record (see [Caching](#caching)) keeps the
step showing as not downloaded, so the app never claims files it doesn't have.

### Conversation

- **Connecting** — briefly, before the first stage reports
- **Warming up…** — Whisper and the voice load, then the chat engine reads
  and compiles the chat model
- **Generating…** — the greeting is written, then turned into speech
- **Incoming call** — ready to answer

A call lasts a fixed number of turns (`MAX_USER_TURNS` in `src/config.ts`).
The reply to the last one says goodbye, and the screen then shows **Call
ended**. The goodbye can still be repeated, and **Call again** starts a new
call with a new greeting. The chat engine and Whisper stay loaded between
calls.

Each call opens with a scenario picked for its level (`src/prompts/scenarios/`).
None comes round again until every one for the level has been heard; what's
been heard is kept in `localStorage`, and only counts once the call is answered.

No downloads belong in this stage. If one happens anyway — a cache evicted
since — it shows rather than sitting silent: **Downloading…** for the chat
model, or **Downloading voice model… 45%** while the voice loads.

When the check passes fully, nothing runs the preload steps. The greeting
builds Whisper and the voice together, then the chat engine once both are done,
all under **Warming up…**. Each load holds far more while it runs than it
keeps afterwards, so whatever loads last does so on top of everything before
it. The chat engine keeps ~2 GB, so it goes last: built after it, Whisper's
load added ~1.3 GB to the tab's peak. A failed Whisper or voice load doesn't
hold up the greeting. Each is tried again where it is next used.

Changing the language or level starts a new call: the conversation is keyed by
both, so its history and greeting go. Changing the speed doesn't — it applies
from the next line spoken.

### Switching language

Each language has a voice pack (`VOICES` in `text-to-speech/constants.ts`),
downloaded on its own rather than with the rest. The app never lands on a
language whose voices aren't on disk (`useLanguageSwitch`):

- **Before the app is set up**, the switch is immediate: the preload fetches
  whichever voice is chosen when it starts, and its checklist and total follow
  the change
- **Once it's set up**, a language whose pack is already on disk is switched to
  straight away. Otherwise an overlay offers the download (`preloadVoicePack`,
  one bar for the pack), and the current language and its call carry on until
  it succeeds. It can be cancelled beforehand but not partway: the download
  can't be stopped, and would still switch the language when it finished

The settings menu is hidden while a switch waits, since the switch saves the
settings as they were when it was asked for. The Piper runtime isn't part of
the pack: every voice shares the one the first download fetched.

## Caching

One service worker (`src/sw.ts`) owns it all, and `src/lib/cache/` is the only
place cache policy is written:

- **`names.ts`** — the two bucket names
- **`rules.ts`** — which URLs belong to which preload step, and roughly how
  big they are
- **`markers.ts`** — reading and writing the markers that record a step as
  done, and the records of cache writes that failed
- **`channel.ts`** — the byte-count message the worker broadcasts, the page's
  request that a waiting update take over, and its request to be claimed
- **`persist.ts`** — asking the browser not to evict the origin's storage
- **`pull-through.ts`** — fetching files in full, without keeping them, so the
  worker stores them

The one piece of cache policy outside it is `src/lib/preload/sweep.ts`, which
deletes old versions from `models-v1`. It needs the current version of every
library, and some of those must not be reachable from the worker bundle.

`src/lib/cache/` is the bottom of the import graph: both `sw.ts` and the page
import from it, so every file in it imports only dependency-free leaves
(`preload/steps.ts` as a type, `chat/constants.ts`). Nothing that touches a
library, a worker, or the DOM.

Two buckets, because they have opposite lifecycles:

- **`shell-<build id>`** — the app shell: the `/app` document and the files it
  loads, precached on install so the app boots offline. No other page is
  cached. Replaced wholesale on each deploy; the old one is purged on activate.
- **`models-v1`** — runtimes, weights, and the step markers that vouch for them.
  Cached on first fetch during the preload the user agreed to, and never purged
  wholesale — only files a newer build has replaced are deleted, one by one.

A marker lives in the same bucket as the bytes it stands for, which is what
makes it trustworthy: browsers evict storage per origin, not per entry, so it
cannot outlive them. Each marker is keyed by whatever makes the download
distinct — a voice id, a model URL, a version-stamped path — so switching model
or bumping a dependency misses rather than matching something stale.

A marker is written by the page when a step finishes, but the worker's copy
into the cache finishes in the background and can still fail after that —
over quota, usually, on files this size. When it does, the worker records it
at `https://write-failed.invalid/<step>`, and the check believes that record
over the marker, so the step shows as not downloaded. The record is cleared
when the step next runs.

The voice has no marker. It is two files whose URLs are known up front, so the
check asks the cache for both directly — and a cache entry can't exist unless
its whole body was written.

### How a request is served

Requests come from the page, the web workers (chat, speech-to-text, and one
per open voice), and the libraries themselves (LiteRT-LM, Transformers.js, our
Piper engine). All of them are controlled, so all of them land here.

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
 │
 ├─ cross-origin, no rule ────────────────────────────────▶ network
 │
 ├─ SHELL_ENABLED == false  (dev: empty precache list) ───▶ network / dev server
 │
 ├─ path in PRECACHE_URLS  ('/app' + what it loads) ──────▶ shell-<build id>
 │                                                            else network
 └─ anything else  (every other page, and its code) ──────▶ network
```

### First ever visit

```
GET /app                     ← network (nothing controls this one yet)
JS / CSS                     ← network
  │
  ▼  page boots
checkDeviceSupport()         ← no WebGPU: stop here, nothing registered
requestPersistentStorage()   ← not waited on
  │
  ▼  ensureController()
register /sw.js
  │
  ├─ install   → cache.addAll(PRECACHE_URLS) → shell-<build id>  ['/app' + what it loads]
  │             → skipWaiting()                   (first install only)
  └─ activate  → purge other shell-* buckets
                → clients.claim()     ← now controls the page; the web workers
  │                                      start later, under its control
  ▼  sweepStaleAssets()      ← nothing to delete yet
  │
  ▼  checkPreloaded()
4 marker probes + 2 voice file probes in models-v1  →  all miss
  │
  ▼  user clicks Download
preloadAll() — all five steps at once:

    tts-runtime  /vendor/*            → models-v1
    voice        HF piper-voices      → models-v1
    whisper      jsDelivr + HF        → models-v1
    chat-runtime jsDelivr             → models-v1
    chat         HF litert-community  → models-v1     (~3 GB)

  each file:  library fetch ─▶ worker ─▶ network ─┬─▶ cache
                                                  └─▶ bytes, tagged by step ─▶ progress bar
  each step ends: the page writes a marker into models-v1 (all but the voice)
  a store that fails: the worker writes write-failed.invalid/<step>
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
  ▼  checkDeviceSupport()    ← and requestPersistentStorage(), as above
  ▼  ensureController()      ← already controlling; applies a new deploy if
  │                            one is waiting (see Updates), else returns
  ▼  sweepStaleAssets()      ← deletes what an older build left in models-v1;
  │                            usually nothing
  ▼  checkPreloaded()        ← 4 markers hit + both voice files found
  │
  ▼
preload screen skipped entirely → straight to the conversation
  │
  ▼  during the conversation
model, voice + runtime fetches ← models-v1, no network
```

### After a hard reload

A hard reload loads the page past the worker, so the page isn't controlled. An
already-active worker never activates again, so it won't claim the page on its
own. `ensureController()` notices, posts `CLAIM`, and the worker calls
`clients.claim()`. Nothing is swapped under the page: it came from the network,
and any of its chunks that aren't in this build's precache still go to the
network. Without the ask, the page would wait out a 10-second timeout and then
run with no caching at all.

### Where progress comes from

The libraries fetch their own wasm and report nothing while doing it. Rather
than predict their URLs and fetch them first ourselves — which meant
reproducing LiteRT-LM's four-way build selection and keeping it in step with
upstream — the service worker counts bytes as they stream past and broadcasts
them, each report tagged with the step whose rule matched its URL. The tag is
what lets every step run at once and still be counted in the right place.
`trackDownload` (`src/lib/preload/track.ts`) sums the reports into the one
figure the bar shows, keyed by URL so a file reporting again replaces its
earlier figure rather than being counted twice.

The bar never moves backwards, so a total that grew mid-download would strand
it. Each step's share therefore starts from an estimate in `EXPECTED_BYTES` and
takes `max(estimate, observed)`, so a stale estimate is corrected by
observation rather than believed. Refresh them on a dependency bump; being
wrong is cheap in both directions. When a step finishes, its share is filled
whatever its files reported, which covers one served from cache (the worker
counts only network bytes) and one that came in under its estimate.

### Changing a model or dependency

Most of what a change needs happens on its own. Markers are keyed by model and
version, so the check misses and the preload screen offers the new download.
And on every load, `sweepStaleAssets()` (`src/lib/preload/sweep.ts`) deletes
from `models-v1` any file that is another version of something the app
downloads, or that no rule in `rules.ts` matches any more.

The sweep has no list of the files the app needs — the libraries choose those
URLs themselves. Instead, each step has a check in `IS_STALE` that compares a
URL against the current model or version. The runtime checks delete only what
they can identify as another version: a CDN URL with no readable version, or a
path elsewhere under `/vendor/`, is kept. The weights each come from one
pinned path or URL, so anything else their rule matches is deleted. Erring
towards deletion is the expensive mistake: a current file deleted by mistake
would be deleted, and downloaded again, on every visit.

What to do by hand:

| Change                        | Handled for you                                                                                  | By hand                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whisper `MODEL`               | Marker misses; old model's files deleted                                                         | Check the `speech-to-text` rule still matches the new URL (it looks for `onnx-community/whisper`); refresh `EXPECTED_BYTES`                                                                                                           |
| Whisper `MODEL_REVISION`      | Marker misses; files off another commit are deleted                                              | Refresh `EXPECTED_BYTES`                                                                                                                                                                                                              |
| Whisper `modelDtype()`        | Marker misses                                                                                    | Nothing — but the old precision's files are **not** deleted. Devices that moved to the fp16 encoder still hold the fp32 one (353 MB)                                                                                                  |
| `DEFAULT_CHAT_MODEL`          | Marker misses; old model file deleted                                                            | A model outside `CHAT_MODELS` needs its own `EXPECTED_BYTES` figure, and one outside `litert-community` needs the `chat` rule widened                                                                                                 |
| `@litert-lm/core`             | Version read from its package.json; marker and sweep follow it, and the rule matches any version | Refresh `EXPECTED_BYTES`                                                                                                                                                                                                              |
| `@huggingface/transformers`   | —                                                                                                | Set `ORT_VERSION` in `src/lib/ort.ts` and the app's own `onnxruntime-web` to the version it pins (a test fails until both match), then re-check the `packageExtensions` entry in `pnpm-workspace.yaml`, which is keyed to its version |
| `onnxruntime-web`             | —                                                                                                | Not on its own: it must match what Transformers.js pins (see above). The vendor plugin follows the installed version and `ONNX_WASM_BASE` follows `ORT_VERSION`, which the test keeps equal                                           |
| `@diffusionstudio/piper-wasm` | The vendor plugin copies the files into a new version folder                                     | Update `PIPER_WASM_BASE` in `text-to-speech/constants.ts` to match                                                                                                                                                                    |
| `VOICES` or `VOICE_REVISION`  | A new voice misses and downloads; files off another commit are deleted                           | Nothing — but a voice dropped from `VOICES` is **not** deleted                                                                                                                                                                        |
| A new preload step            | The type checker asks for its `EXPECTED_BYTES`, `IS_STALE` and `PreloadStatus` entries           | Add its rule to `rules.ts`, its job to `preloadAll`, and the step to `DOWNLOAD_ORDER` and `STEPS_BY_LABEL` — the type checker catches none of these. Left out of `DOWNLOAD_ORDER`, its bytes are neither quoted nor counted           |

Old markers are never deleted either. They're a few bytes each, and keyed by
version, so nothing matches them again.

### In dev

The worker runs in dev too, but with its shell tier switched off. The two tiers
have very different risk profiles: caching the shell on the dev origin would
serve stale modules and break HMR, while caching the models is the only thing
that makes the dev loop bearable — the chat model alone is 3 GB, and without it
that comes down on every reload.

`vite-plugin-service-worker.ts` serves `/sw.js` in dev by compiling `src/sw.ts`
with the same bundler and output format as the production one. The only
difference is the data: `src/sw-precache.ts` is left at its defaults, so
`PRECACHE_URLS` is empty, and `SHELL_ENABLED` in `sw.ts` turns off precaching
and shell serving, the `/app` document included, in one go. Every same-origin
request goes straight to the dev server; `ASSET_RULES` still apply, so the
models, the CDN runtimes and `public/vendor/` are cached and counted as usual.

The bundle is rebuilt whenever a file that went into it is edited, and the
browser refetches `/sw.js` on every navigation, so a reload picks up a change to
`sw.ts`. The dev worker also calls `skipWaiting()` on every install rather than
only the first — there is no shell to swap out from under a running page, and
waiting a navigation would just make an edit look like it hadn't taken.

One consequence worth knowing: the vendored wasm under `/vendor/` is cached in
dev like everything else the rules match. Those paths are version-stamped,
so a dependency bump misses rather than serving stale bytes — but hand-editing a
vendored file in place would not.

The offline path only exists in a real build. Test that with `pnpm preview`
(port 4173).

### Updates

A new deploy's worker installs as soon as the browser sees the new `sw.js` (it
checks on every navigation), and precaches its shell alongside the old one. On
its own it would then wait until every tab running the old worker has closed. A
refresh doesn't count, because the old worker serves the refreshed page before
the old page has gone, so someone who keeps the app in a pinned tab would never
get the update.

So `/app` applies an update that is already waiting when it starts
(`applyUpdate` in `src/lib/sw-client.ts`). A deploy therefore takes two loads:

```
load after the deploy
  /app from the old shell ─▶ app starts as normal, nothing waits on it
  meanwhile, the browser's own navigation check:
    new sw.js ─▶ install ─▶ precache the new shell ─▶ waiting

next load
  /app from the old shell
    │
    ▼  ensureController()  ─  registration.waiting?
    │
    ├─ no ───────────────────────────────────────────▶ start the app
    │
    └─ yes ─▶ post TAKE_OVER
               │
               ├─ another tab is running /app ───────▶ declined: start the
               │                                        app; the update waits
               │
               └─ accepted ─▶ skipWaiting() ─▶ activate: purge the old shell
                                                │
                                                ▼
                              controllerchange ─▶ location.reload()
                                                │
                                                ▼
                              /app from the new shell
```

The page never checks for an update itself or waits on one installing.
Checking is the browser's job, done in the background on navigation, so
startup never waits on the network. That holds on a slow or hanging connection
too, and offline there's simply nothing waiting. Applying an update that's
already installed only takes messages between the page and the worker, so
the reload follows within a moment. If either round trip — the worker's
answer, then the switch — takes more than 3 seconds, the app starts anyway and
the update waits for a later load.

It runs on the check screen, before the app has done anything, so the reload
never interrupts a conversation. It shows as a brief flicker of that screen,
once per deploy. A deploy that lands while a tab is open waits until that tab
is next loaded. The reload matters as much as the switch: the page came from
the previous build, and the new shell no longer has that build's chunks.

The worker declines while another tab is running `/app`, because switching
would move that tab onto the new shell mid-session, and the old chunks it
requests next may already be gone from the server. Tabs on other pages don't
count, since nothing they load comes from the shell. `models-v1` survives all
of this untouched.

Production serves the vendored files and the hashed `/assets/*` `immutable`,
and `/sw.js` as `no-cache` so an update is never masked by the HTTP cache (see
`public/_headers`).

#### How the shell is versioned

`src/sw.ts` imports its precache list and build id from `src/sw-precache.ts`.
The checked-in values there are dev/test defaults; in a build,
`vite-plugin-service-worker.ts` substitutes the module with the real list —
`/app` and the files it loads — once prerender has written the document. It's a
module rather than a `define` so that `src/sw.test.ts` can import `sw.ts` and
`vi.mock` the list.

Only `/app` is precached (`APP_URL` in the plugin). Every other page, the home
page included, goes to the network whether the worker is installed or not, so
it doesn't work offline and is never served stale.

The files are found by walking the bundle from what the prerendered `/app`
document references:

- **Chunk imports**, static and dynamic, and the CSS Vite records against each
  chunk. Only `.js` and `.css` files are taken, so an image or font a chunk
  imported would be left out (there are none today).
- **Web worker scripts.** Vite builds these separately and emits them as plain
  assets, so the chunk graph has no edge to them. The walk looks for their file
  names in the code that spawns them, and in each other's code for their own
  imports.
- **Never another route's chunks.** The entry chunk lazily imports every
  route's, so the walk only takes chunks split from `/app`'s own route file
  (TanStack's `?tsr-split=` chunks), including splits the document doesn't
  reference, like an error component.

So a new route's code stays out of the shell automatically. The exception is
CSS a route imports: TanStack Start attaches it to the root route, so every
page, `/app` included, links it, and it is precached along with the rest. The
build fails if `/app` wasn't prerendered or references nothing in the bundle.

The build id is a hash of that URL list plus the `/app` document.
Hashed assets change name when they change bytes, so the URLs cover them; the
document lives at a fixed URL, so its contents go in too, minus the render
timestamp TanStack Router embeds (without that, no two builds would ever match).
The id is baked into `sw.js`, so:

- **Nothing in the shell changed** — same id, and usually a byte-identical
  `sw.js`, so browsers don't install anything.
- **Anything changed** — new `shell-<build id>` bucket. Install re-fetches the
  whole list into it, including files that didn't change; those are served
  `immutable` at the same URL, so they come out of the HTTP cache rather than
  the network. Activate then drops the old bucket. The shell is never a mix of
  two deploys.

Anything other than the document that affects the shell without changing a
filename would slip past the id. Nothing does today; if you add one (say, a
same-origin file served from a fixed path), put it in the hash too.
