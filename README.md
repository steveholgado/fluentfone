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

- Page assets only — React + router and the route chunk
- No model libraries, no workers

### Check

- Read OPFS — is the voice model there?
- Read Cache Storage — are the Whisper weights there?
- Read Cache Storage — is the chat model file there?
- Read three receipts — have the piper, ONNX and LiteRT wasm runtimes been
  downloaded before?
- No network, no workers, no libraries loaded
- All six present → straight to the conversation; anything missing → preload

### Preload

Only the missing steps run, smallest first, each with its own progress bar:

1. Piper + ONNX wasm — self-hosted from `public/vendor/`
2. Voice model → OPFS
3. ONNX wasm for Whisper — jsDelivr
4. Whisper weights → Cache Storage
5. LiteRT wasm — jsDelivr
6. Chat model → Cache Storage

### Conversation

- **Connecting** — briefly, before the first stage reports
- **Warming up…** — the engine compiles the chat model
- **Generating…** — the greeting is written
- **Downloading voice model… 45%** — the greeting is turned into speech
- **Incoming call** — ready to answer

No downloads belong in this stage. If one happens anyway — a cache evicted
since — it shows as **Downloading…** rather than sitting silent.

When the check passes fully, the six preload steps still run quietly in the
background here. They're all cache reads at that point, and they're what gets
the engine warm before the call is answered.

### A caveat on the receipts

The two jsDelivr runtimes live in the browser's HTTP cache, which can't be
queried from JavaScript. The check reads a receipt instead — a note saying
"we downloaded this once", written to Cache Storage on success. If the HTTP
cache is evicted while Cache Storage survives, the check will wrongly report
the runtime as present; the stage reporting above is what keeps that visible
instead of looking like a hang.

In dev the vendored files are served without cache headers, so they re-download
on each load. Production serves them `immutable` (see `public/_headers`).
