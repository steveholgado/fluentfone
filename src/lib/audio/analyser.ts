const FFT_SIZE = 1024;

// Speech RMS sits somewhere around 0.05–0.25, so the raw value would only ever
// use the bottom of the 0–1 range. This opens it out: conversational level
// lands near half, and only a raised voice reaches the top. Pushing it much
// further makes ordinary speech clip at 1 and the wave stops responding.
const NORMALISE = 4.5;

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let samples: Uint8Array<ArrayBuffer> | null = null;
let tap: AudioNode | null = null;

/**
 * Builds the graph on first use. Returns null where Web Audio doesn't exist,
 * which covers both prerendering and jsdom — the callers all no-op from there.
 */
function ensure(): AnalyserNode | null {
  if (typeof AudioContext === 'undefined') return null;

  if (!ctx) {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;

    // The analyser dead-ends in a muted gain rather than the destination.
    // Some engines won't render a node with no path to output at all, but a
    // live path would put the tapped microphone on the speakers. This gets
    // both: the graph stays pulled, and nothing tapped is ever audible through
    // it. Playback reaches the speakers by its own separate connection.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    analyser.connect(sink).connect(ctx.destination);

    samples = new Uint8Array(FFT_SIZE);
  }

  return analyser;
}

/**
 * Starts the audio context. Must be called synchronously from a click handler:
 * autoplay policy only lets a context start off a user gesture, and by the
 * time playback actually begins several awaits have passed and that window has
 * closed.
 */
export function unlock(): void {
  ensure();

  if (ctx && ctx.state !== 'running') {
    void ctx.resume().catch(() => {});
  }
}

/** Routes a microphone stream into the analyser, replacing any previous tap. */
export function tapStream(stream: MediaStream | null | undefined): void {
  const node = ensure();
  if (!node || !ctx || !stream) return;

  releaseTap();

  tap = ctx.createMediaStreamSource(stream);
  tap.connect(node);
}

/**
 * Routes a playing element into the analyser, replacing any previous tap.
 * Synchronous by design, because `play()` must reach `element.play()` without
 * awaiting.
 *
 * Declines when the context isn't running. Creating a MediaElementSource moves
 * *all* of the element's output into the graph, so tapping a suspended context
 * would leave the user hearing nothing while `ended` still fires — the
 * conversation would carry on as if it had spoken. Audio beats visuals.
 */
export function tapElement(element: HTMLMediaElement): boolean {
  const node = ensure();
  if (!node || !ctx) return false;

  if (ctx.state !== 'running') {
    void ctx.resume().catch(() => {});
    return false;
  }

  releaseTap();

  try {
    const source = ctx.createMediaElementSource(element);
    source.connect(node);
    source.connect(ctx.destination);
    tap = source;
    return true;
  } catch {
    // An element can only ever have one source node. Failing here must not
    // take playback down with it.
    return false;
  }
}

export function releaseTap(): void {
  tap?.disconnect();
  tap = null;
}

/** Current loudness, 0–1. Zero when nothing is tapped, or off the main path. */
export function readLevel(): number {
  if (!analyser || !samples) return 0;

  analyser.getByteTimeDomainData(samples);

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }

  return Math.min(1, Math.sqrt(sum / samples.length) * NORMALISE);
}
