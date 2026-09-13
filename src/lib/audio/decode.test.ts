import { afterEach, describe, expect, it, vi } from 'vitest';

import { toMonoPcm } from '#/lib/audio/decode';

function makeAudioBuffer(
  channelData: Float32Array,
  sampleRate: number,
  numberOfChannels: number,
  duration: number,
) {
  return {
    sampleRate,
    numberOfChannels,
    duration,
    getChannelData: vi.fn().mockReturnValue(channelData),
  };
}

describe('toMonoPcm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns Float32Array input unchanged, without touching AudioContext', async () => {
    const audioCtxSpy = vi.fn();
    vi.stubGlobal('AudioContext', audioCtxSpy);

    const input = new Float32Array([0.1, 0.2, 0.3]);
    const result = await toMonoPcm(input, 16000);

    expect(result).toBe(input);
    expect(audioCtxSpy).not.toHaveBeenCalled();
  });

  it('returns decoded data directly when already mono at the target sample rate', async () => {
    const channelData = new Float32Array([1, 2, 3]);
    const decoded = makeAudioBuffer(channelData, 16000, 1, 1);
    const close = vi.fn().mockResolvedValue(undefined);
    const decodeAudioData = vi.fn().mockResolvedValue(decoded);

    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return { decodeAudioData, close };
      }),
    );

    const result = await toMonoPcm(new ArrayBuffer(8), 16000);

    expect(result).toBe(channelData);
    expect(close).toHaveBeenCalled();
  });

  it('closes the decode context even if decoding fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const decodeAudioData = vi.fn().mockRejectedValue(new Error('bad data'));

    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return { decodeAudioData, close };
      }),
    );

    await expect(toMonoPcm(new ArrayBuffer(8), 16000)).rejects.toThrow(
      'bad data',
    );
    expect(close).toHaveBeenCalled();
  });

  it('reads a File/Blob via arrayBuffer() before decoding', async () => {
    const channelData = new Float32Array([5]);
    const decoded = makeAudioBuffer(channelData, 16000, 1, 1);

    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return {
          decodeAudioData: vi.fn().mockResolvedValue(decoded),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    );

    const blob = new Blob(['fake audio bytes']);
    const arrayBufferSpy = vi.spyOn(blob, 'arrayBuffer');

    const result = await toMonoPcm(blob, 16000);

    expect(arrayBufferSpy).toHaveBeenCalled();
    expect(result).toBe(channelData);
  });

  it('resamples/downmixes via an OfflineAudioContext when channels or rate differ', async () => {
    const decoded = makeAudioBuffer(new Float32Array([9, 9]), 44100, 2, 2);

    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return {
          decodeAudioData: vi.fn().mockResolvedValue(decoded),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    );

    const renderedData = new Float32Array([0.5, 0.6]);
    const rendered = makeAudioBuffer(renderedData, 16000, 1, 2);
    const source = {
      buffer: null as unknown,
      connect: vi.fn(),
      start: vi.fn(),
    };

    const offlineCtor = vi.fn(function (
      _channels: number,
      _length: number,
      _rate: number,
    ) {
      return {
        createBufferSource: vi.fn().mockReturnValue(source),
        destination: {},
        startRendering: vi.fn().mockResolvedValue(rendered),
      };
    });

    vi.stubGlobal('OfflineAudioContext', offlineCtor);

    const result = await toMonoPcm(new ArrayBuffer(8), 16000);

    expect(offlineCtor).toHaveBeenCalledWith(1, Math.ceil(2 * 16000), 16000);
    expect(source.buffer).toBe(decoded);
    expect(source.connect).toHaveBeenCalled();
    expect(source.start).toHaveBeenCalled();
    expect(result).toBe(renderedData);
  });
});
