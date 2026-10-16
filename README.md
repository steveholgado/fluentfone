# Language Practice Calls with Local AI

Practise speaking Spanish on a phone call with an AI partner, running
entirely in your browser. Speech recognition, the conversation and the voice
are all local models, so nothing you say leaves your device.

Pick a level (A1–B2), Spain or Mexico, and a speaking speed, then answer the
call. Your partner opens with something suited to your level, you reply out
loud.

**Under the hood:** Whisper small for speech-to-text (Transformers.js) and
Gemma 4 E4B for the conversation (LiteRT-LM), both on WebGPU, and Piper for
the voice (ONNX Runtime Web) on the CPU. The models are a one-time download, cached by a
service worker, so on subsequent loads the app starts with no network at all.

## Requirements

- **A browser with WebGPU.** Chrome or Edge on desktop, or Safari 26 on
  macOS Tahoe 26+ / iOS 26+ (Safari on older systems has no WebGPU, whatever
  its version). The app checks before downloading anything and tells you if
  yours doesn't qualify.
- **About 3.5 GB of free storage**, in a normal window: private windows can't
  keep downloads this size.
- **At least 8 GB of RAM.** The chat model alone holds about 2 GB once
  loaded, and more while it loads.
- **A microphone.**

## Privacy

Your voice is recorded, transcribed and answered on your device. The only
network requests are for the app itself and the one-time model downloads from
Hugging Face and jsDelivr. Your settings, and which scenarios you've already
heard, are kept in your browser's storage.

## Limitations

- Spanish only, as spoken in Spain or Mexico.
- The partner is a small model running on your machine. It follows its level
  well but not perfectly, and can get things wrong.
- Calls are capped at a fixed number of turns (`MAX_USER_TURNS` in
  `src/config.ts`): a small model follows its instructions less closely the
  longer a conversation runs.

## Models and inference

### Models

- [Gemma 4 E4B](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm)
  by Google, via LiteRT Community — Apache 2.0
- [Whisper small](https://huggingface.co/openai/whisper-small) by OpenAI —
  Apache 2.0; the ONNX build is
  [onnx-community/whisper-small](https://huggingface.co/onnx-community/whisper-small)
- [Piper](https://github.com/OHF-Voice/piper1-gpl) voices from
  [diffusionstudio/piper-voices](https://huggingface.co/diffusionstudio/piper-voices),
  each under its own licence, given in its model card

### Libraries

- [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
- [Transformers.js](https://github.com/huggingface/transformers.js)
- [ONNX Runtime Web](https://onnxruntime.ai/)
- [piper-wasm](https://github.com/diffusionstudio/piper-wasm)

## Development

To run locally, install dependencies and start the dev server:

```bash
pnpm install
pnpm dev        # http://localhost:3000, the app is at /app
```

| Script                              | Does                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                          | Dev server on port 3000                              |
| `pnpm build`                        | Production build, with `/` and `/app` prerendered    |
| `pnpm preview`                      | Serves the build on port 4173 — test offline here    |
| `pnpm test` / `pnpm test:watch`     | Vitest                                               |
| `pnpm typecheck`                    | `tsc --noEmit`                                       |
| `pnpm lint` / `pnpm lint:fix`       | oxlint                                               |
| `pnpm format` / `pnpm format:check` | oxfmt                                                |
| `pnpm generate-routes`              | Regenerates `src/routeTree.gen.ts` (dev does it too) |

The service worker runs in dev too, with its app-shell caching switched off,
so the models are cached and the first download only happens once. The
offline path only exists in a real build: use `pnpm preview` for that.

Where things live:

- `src/routes/app.tsx` — the app
- `src/lib/` — speech-to-text, chat and text-to-speech (each in its own web
  worker), audio, caching and the preload
- `src/prompts/` — the CEFR level specs and opening scenarios the chat model
  is prompted with
- `src/sw.ts` — the service worker
- `vite-plugin-*.ts` — the service worker build, and ONNX Runtime's wasm:
  vendoring the copies the app serves, and dropping the ones it doesn't

[docs/architecture.md](docs/architecture.md) covers how it all works: each
stage of the app, the caching, and what to do when you change a model or bump
a dependency.

## Deploying

`pnpm build` prerenders both pages into `dist/client`. Wherever it's hosted:

- **Serve the headers in [`public/_headers`](public/_headers).** The file is in
  the format Netlify and Cloudflare Pages read; elsewhere, set them by hand.
  The one that matters most is `/sw.js` as `no-cache`, so a deploy is never
  hidden behind the HTTP cache.
- **Serve it over HTTPS.** Service workers and the microphone both need a
  secure context.
- **Mind per-file size limits.** Cloudflare rejects any file over 25 MiB.
  The build stays under that by dropping the ONNX Runtime binaries the bundler
  emits but nothing loads (`vite-plugin-drop-bundled-onnx-wasm.ts`); the
  models themselves come from Hugging Face, not your host.
