import { describe, expect, it, vi } from 'vitest';

import type { Voice } from '#/lib/text-to-speech';
import { createSpokenReply } from '#/lib/utils/spokenReply';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A voice whose clip for each sentence is a blob of that sentence. */
function mockVoice() {
  return {
    speak: vi.fn<Voice['speak']>(async (text) => new Blob([text])),
  };
}

async function textOf(clip: Blob) {
  return clip.text();
}

describe('createSpokenReply', () => {
  it('speaks each sentence as soon as it is complete', () => {
    const voice = mockVoice();
    const reply = createSpokenReply({ voice, speed: 1, play: async () => {} });

    reply.push('Me gusta ');
    expect(voice.speak).not.toHaveBeenCalled();
    reply.push('el café. ¿Y a');
    expect(voice.speak.mock.calls.map(([text]) => text)).toEqual([
      'Me gusta el café.',
    ]);
  });

  it('speaks every sentence at the speed given', async () => {
    const voice = mockVoice();
    const reply = createSpokenReply({
      voice,
      speed: 0.8,
      play: async () => {},
    });

    reply.push('Uno. Dos.');
    await reply.end();

    expect(voice.speak.mock.calls.map(([, opts]) => opts?.speed)).toEqual([
      0.8, 0.8,
    ]);
  });

  it('resolves with what was spoken once everything has played', async () => {
    const played: string[] = [];
    const reply = createSpokenReply({
      voice: mockVoice(),
      speed: 1,
      play: async (clip) => void played.push(await textOf(clip)),
    });

    reply.push('Uno. ');
    reply.push('Dos.');
    const { sentences, clips } = await reply.end();

    expect(sentences).toEqual(['Uno.', 'Dos.']);
    expect(await Promise.all(clips.map(textOf))).toEqual(['Uno.', 'Dos.']);
    expect(played).toEqual(['Uno.', 'Dos.']);
  });

  it('plays sentences in order, even when a later one is synthesised first', async () => {
    const first = deferred<Blob>();
    const second = deferred<Blob>();
    const voice = mockVoice();
    voice.speak
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const play = vi.fn(async (_clip: Blob) => {});
    const reply = createSpokenReply({ voice, speed: 1, play });

    reply.push('Uno. Dos.');
    const ended = reply.end();
    second.resolve(new Blob(['dos']));
    await Promise.resolve();
    expect(play).not.toHaveBeenCalled();

    first.resolve(new Blob(['uno']));
    await ended;
    expect(await Promise.all(play.mock.calls.map(([c]) => textOf(c)))).toEqual([
      'uno',
      'dos',
    ]);
  });

  it('plays nothing after a sentence fails, and rejects with the failure', async () => {
    const voice = mockVoice();
    voice.speak.mockRejectedValueOnce(new Error('synth failed'));
    const play = vi.fn(async (_clip: Blob) => {});
    const reply = createSpokenReply({ voice, speed: 1, play });

    reply.push('Uno. Dos.');
    await expect(reply.end()).rejects.toThrow('synth failed');
    expect(play).not.toHaveBeenCalled();
  });

  it('settles without rejecting once what has started has finished', async () => {
    const playing = deferred<void>();
    const voice = mockVoice();
    const play = vi.fn(() => playing.promise);
    const reply = createSpokenReply({ voice, speed: 1, play });

    reply.push('Me gusta. ¿Y');
    let settled = false;
    const settling = reply.settle().then(() => (settled = true));
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    playing.reject(new Error('playback failed'));
    await settling;
    // The unfinished sentence was never spoken.
    expect(voice.speak).toHaveBeenCalledTimes(1);
  });

  it('reports the first sentence and its first clip, once each', async () => {
    const voice = mockVoice();
    voice.speak.mockImplementation(async (text, opts) => {
      opts?.onTimings?.({ startup: 1, synthesis: 2 });
      return new Blob([text]);
    });
    const onFirstSentence = vi.fn();
    const onFirstClip = vi.fn();
    const reply = createSpokenReply({
      voice,
      speed: 1,
      play: async () => {},
      onFirstSentence,
      onFirstClip,
    });

    reply.push('Uno. Dos. Tres.');
    expect(onFirstSentence).toHaveBeenCalledTimes(1);
    await reply.end();

    expect(onFirstSentence).toHaveBeenCalledTimes(1);
    expect(onFirstClip).toHaveBeenCalledTimes(1);
    expect(onFirstClip).toHaveBeenCalledWith({ startup: 1, synthesis: 2 });
  });
});
