import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { play, stopPlayback } from '#/lib/audio/player';

class FakeAudio {
  static instances: FakeAudio[] = [];

  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  play = vi.fn().mockResolvedValue(undefined);

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }

  pause() {
    this.paused = true;
  }
}

beforeEach(() => {
  FakeAudio.instances = [];

  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn().mockReturnValue('blob:fake-url'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('play', () => {
  it('creates an audio element from the blob and starts playback', () => {
    const blob = new Blob(['audio'], { type: 'audio/webm' });
    void play(blob);

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(FakeAudio.instances[0].src).toBe('blob:fake-url');
    expect(FakeAudio.instances[0].play).toHaveBeenCalled();
  });

  it('resolves when playback ends', async () => {
    const promise = play(new Blob());
    FakeAudio.instances[0].onended?.();

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects when playback errors', async () => {
    const promise = play(new Blob());
    FakeAudio.instances[0].onerror?.();

    await expect(promise).rejects.toThrow('Audio playback failed.');
  });

  it('rejects when play() itself rejects', async () => {
    class FailingAudio extends FakeAudio {
      play = vi.fn().mockRejectedValue(new Error('nope'));
    }

    vi.stubGlobal('Audio', FailingAudio);

    await expect(play(new Blob())).rejects.toThrow('nope');
  });

  it('stops any previously playing audio before starting a new one', () => {
    void play(new Blob());
    const first = FakeAudio.instances[0];

    void play(new Blob());

    expect(first.paused).toBe(true);
  });
});

describe('stopPlayback', () => {
  it('pauses the currently playing audio', () => {
    void play(new Blob());
    const current = FakeAudio.instances[0];

    stopPlayback();

    expect(current.paused).toBe(true);
  });

  it('is a no-op when nothing is playing', () => {
    stopPlayback();
    expect(() => stopPlayback()).not.toThrow();
  });
});
