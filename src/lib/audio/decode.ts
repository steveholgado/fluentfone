/** Decodes arbitrary audio input into mono Float32 samples at the given sample rate. */
export async function toMonoPcm(
  input: File | Blob | ArrayBuffer | Float32Array,
  sampleRate: number,
): Promise<Float32Array> {
  if (input instanceof Float32Array) return input;

  const arrayBuffer =
    input instanceof ArrayBuffer ? input : await input.arrayBuffer();

  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await decodeCtx.close();
  }

  if (decoded.sampleRate === sampleRate && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }

  // A single-channel OfflineAudioContext downmixes to mono, and rendering at
  // `sampleRate` handles the resample, in one pass.
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * sampleRate),
    sampleRate,
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();

  return rendered.getChannelData(0);
}
