import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioRecorder } from '#/lib/audio/recorder';

class FakeTrack {
  stop = vi.fn();
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks = vi.fn(() => this.tracks);
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set<string>();
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supportedTypes.has(type);
  }

  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType: string;
  start = vi.fn();
  stop = vi.fn();

  constructor(
    public stream: FakeStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supportedTypes = new Set();

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(new FakeStream()),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AudioRecorder', () => {
  it('requests the microphone and starts recording', async () => {
    const recorder = new AudioRecorder();
    await recorder.start();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true,
    });
    expect(FakeMediaRecorder.instances[0].start).toHaveBeenCalled();
  });

  it('picks the first supported preferred mime type', async () => {
    FakeMediaRecorder.supportedTypes.add('audio/mp4');
    const recorder = new AudioRecorder();
    await recorder.start();

    expect(FakeMediaRecorder.instances[0].mimeType).toBe('audio/mp4');
  });

  it('omits mimeType options when nothing is supported', async () => {
    const recorder = new AudioRecorder();
    await recorder.start();

    expect(FakeMediaRecorder.instances[0].mimeType).toBe('');
  });

  it('rejects stop() when recording was never started', async () => {
    const recorder = new AudioRecorder();

    await expect(recorder.stop()).rejects.toThrow('Recording was not started.');
  });

  it('collects data chunks and resolves with a blob on stop, stopping all tracks', async () => {
    const recorder = new AudioRecorder();
    await recorder.start();

    const mediaRecorder = FakeMediaRecorder.instances[0];
    const chunk = new Blob(['abc']);
    mediaRecorder.ondataavailable?.({ data: chunk });
    // Zero-size chunks should be dropped.
    mediaRecorder.ondataavailable?.({ data: new Blob([]) });

    const stopPromise = recorder.stop();
    mediaRecorder.onstop?.();
    const result = await stopPromise;

    expect(result).toBeInstanceOf(Blob);
    for (const track of mediaRecorder.stream.tracks) {
      expect(track.stop).toHaveBeenCalled();
    }
  });
});
