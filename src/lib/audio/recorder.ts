const PREFERRED_MIME_TYPES = ['audio/webm', 'audio/mp4'];

function pickMimeType(): string | undefined {
  return PREFERRED_MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/**
 * Wraps getUserMedia + MediaRecorder so recording is fully awaitable —
 * `start()` doesn't resolve until the mic is actually live, which avoids a
 * race where UI state flips to "recording" before permission is granted.
 */
export class AudioRecorder {
  private recorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private chunks: Blob[] = [];

  /** The live capture stream, for callers that want to analyse it as it runs. */
  get stream(): MediaStream | null {
    return this.mediaStream;
  }

  async start(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    this.chunks = [];

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(
      this.mediaStream,
      mimeType ? { mimeType } : undefined,
    );
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  stop(): Promise<Blob> {
    const recorder = this.recorder;
    const stream = this.mediaStream;
    if (!recorder || !stream) {
      return Promise.reject(new Error('Recording was not started.'));
    }

    return new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      };
      recorder.stop();
    });
  }
}
