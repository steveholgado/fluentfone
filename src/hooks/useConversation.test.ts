import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversation } from '#/hooks/useConversation';
import { AudioRecorder } from '#/lib/audio/recorder';
import { play } from '#/lib/audio/player';
import { transcribe } from '#/lib/speech-to-text';
import { generateMessage } from '#/lib/chat';
import { openVoice, type Voice } from '#/lib/text-to-speech';
import { SYSTEM_INSTRUCTION, VOICE_ID } from '#/config';

vi.mock('#/lib/audio/recorder', () => ({
  AudioRecorder: vi.fn(),
}));
vi.mock('#/lib/audio/player', () => ({
  play: vi.fn(),
}));
vi.mock('#/lib/speech-to-text', () => ({
  transcribe: vi.fn(),
}));
vi.mock('#/lib/chat', () => ({
  generateMessage: vi.fn(),
}));
vi.mock('#/lib/text-to-speech', () => ({
  openVoice: vi.fn(),
  VOICES: { en: 'en_US-hfc_female-medium', es: 'es_ES-davefx-medium' },
}));

// The conversation's one voice, as `openVoice` hands it back.
const speak = vi.fn<Voice['speak']>();
const close = vi.fn();

const AUDIO_BLOB = new Blob(['audio']);
const GREETING_AUDIO = new Blob(['greeting']);

function mockRecorderImpl(overrides?: {
  start?: () => Promise<void>;
  stop?: () => Promise<Blob>;
}) {
  const start = vi.fn(overrides?.start ?? (() => Promise.resolve()));
  const stop = vi.fn(overrides?.stop ?? (() => Promise.resolve(AUDIO_BLOB)));

  vi.mocked(AudioRecorder).mockImplementation(function () {
    return { start, stop } as unknown as AudioRecorder;
  });

  return { start, stop };
}

/**
 * A `generateMessage` that behaves like the real one: `chunks` go to
 * `onChunk` one at a time (after the 'generating' stage), then the whole
 * reply resolves.
 */
function streamed(...chunks: string[]): typeof generateMessage {
  return async (options) => {
    options?.onStage?.('generating');
    for (const chunk of chunks) options?.onChunk?.(chunk);
    return chunks.join('');
  };
}

/** Records, then stops, which starts a turn; resolves when the turn is over. */
async function takeTurn(result: {
  current: ReturnType<typeof useConversation>;
}) {
  await act(async () => {
    result.current.toggleRecording();
  });
  await waitFor(() => expect(result.current.isRecording).toBe(true));
  await act(async () => {
    result.current.toggleRecording();
  });
}

/** A promise with its settle functions pulled out, to control ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openVoice).mockReturnValue({
    ready: Promise.resolve(),
    speak,
    close,
  });
  speak.mockResolvedValue(new Blob(['voice']));
  vi.mocked(play).mockResolvedValue(undefined);
  // Every turn logs its stage timings in dev, which tests run as.
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useConversation', () => {
  it('starts with no recording, no greeting, and empty status', () => {
    const { result } = renderHook(() => useConversation());

    expect(result.current.isRecording).toBe(false);
    expect(result.current.hasGreeted).toBe(false);
    expect(result.current.isGreetingReady).toBe(false);
    expect(result.current.status).toBe('');
  });

  describe('voice', () => {
    it('opens one voice for the conversation and speaks every line with it', async () => {
      mockRecorderImpl();
      vi.mocked(generateMessage).mockImplementation(streamed('¡Hola!'));
      vi.mocked(transcribe).mockResolvedValue('Hola');

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        await result.current.prepareGreeting();
      });
      for (let turn = 0; turn < 2; turn++) {
        await act(async () => {
          result.current.toggleRecording();
        });
        await waitFor(() => expect(result.current.isRecording).toBe(true));
        await act(async () => {
          result.current.toggleRecording();
        });
      }

      expect(openVoice).toHaveBeenCalledTimes(1);
      expect(speak).toHaveBeenCalledTimes(3);
    });

    it('opens the voice before generating the greeting, so it loads meanwhile', async () => {
      let openedFirst = false;
      vi.mocked(generateMessage).mockImplementation(async () => {
        openedFirst = vi.mocked(openVoice).mock.calls.length === 1;
        return '¡Hola!';
      });

      const { result } = renderHook(() => useConversation());
      await act(async () => {
        await result.current.prepareGreeting();
      });

      expect(openedFirst).toBe(true);
    });

    it('closes the voice when the conversation unmounts', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');

      const { result, unmount } = renderHook(() => useConversation());
      await act(async () => {
        await result.current.prepareGreeting();
      });
      unmount();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('opens nothing until a line needs speaking', () => {
      const { unmount } = renderHook(() => useConversation());
      unmount();

      expect(openVoice).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('prepareGreeting', () => {
    it('generates and speaks an opening line, then marks the greeting ready', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      speak.mockResolvedValue(GREETING_AUDIO);

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        await result.current.prepareGreeting();
      });

      expect(generateMessage).toHaveBeenCalledWith({
        systemInstruction: SYSTEM_INSTRUCTION,
        onStage: expect.any(Function),
      });
      expect(openVoice).toHaveBeenCalledWith(VOICE_ID, expect.any(Function));
      expect(speak).toHaveBeenCalledWith('¡Hola!', { slow: true });
      expect(result.current.isGreetingReady).toBe(true);
      expect(result.current.status).toBe('');
    });

    it('does nothing if a greeting is already prepared', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        await result.current.prepareGreeting();
      });
      await act(async () => {
        await result.current.prepareGreeting();
      });

      expect(generateMessage).toHaveBeenCalledTimes(1);
    });

    it('sets an error status and logs when generation fails', async () => {
      vi.mocked(generateMessage).mockRejectedValue(new Error('offline'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        await result.current.prepareGreeting();
      });

      expect(result.current.isGreetingReady).toBe(false);
      expect(result.current.status).toBe('Something went wrong');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('greet', () => {
    it('does nothing when no greeting has been prepared', async () => {
      const { result } = renderHook(() => useConversation());

      await act(async () => {
        await result.current.greet();
      });

      expect(result.current.hasGreeted).toBe(false);
      expect(play).not.toHaveBeenCalled();
    });

    it('plays the prepared greeting and marks the conversation as greeted', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      speak.mockResolvedValue(GREETING_AUDIO);

      const { result } = renderHook(() => useConversation());
      await act(async () => {
        await result.current.prepareGreeting();
      });

      await act(async () => {
        await result.current.greet();
      });

      expect(result.current.hasGreeted).toBe(true);
      expect(play).toHaveBeenCalledWith(GREETING_AUDIO);
      expect(result.current.status).toBe('');
    });

    it('sets an error status and logs when playback fails', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      speak.mockResolvedValue(GREETING_AUDIO);
      vi.mocked(play).mockRejectedValue(new Error('playback failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useConversation());
      await act(async () => {
        await result.current.prepareGreeting();
      });

      await act(async () => {
        await result.current.greet();
      });

      expect(result.current.status).toBe('Something went wrong');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('toggleRecording', () => {
    it('starts recording when not already recording', async () => {
      const { start } = mockRecorderImpl();
      const { result } = renderHook(() => useConversation());

      act(() => {
        result.current.toggleRecording();
      });

      await waitFor(() => expect(result.current.isRecording).toBe(true));
      expect(start).toHaveBeenCalled();
    });

    it('sets an error status and logs when the microphone cannot be accessed', async () => {
      mockRecorderImpl({
        start: () => Promise.reject(new Error('permission denied')),
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        result.current.toggleRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(result.current.status).toBe('Could not access microphone');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('stops recording, transcribes, generates a reply, and speaks it', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola, ¿cómo estás?');
      vi.mocked(generateMessage).mockImplementation(
        streamed('¡Muy bien, gracias!'),
      );
      speak.mockResolvedValue(GREETING_AUDIO);

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });

      expect(result.current.isRecording).toBe(false);
      expect(transcribe).toHaveBeenCalledWith(AUDIO_BLOB, {
        language: 'spanish',
        onTimings: expect.any(Function),
      });
      expect(generateMessage).toHaveBeenCalledWith({
        prompt: 'Hola, ¿cómo estás?',
        systemInstruction: SYSTEM_INSTRUCTION,
        history: [],
        onStage: expect.any(Function),
        onChunk: expect.any(Function),
      });
      expect(speak).toHaveBeenCalledWith('¡Muy bien, gracias!', {
        slow: true,
        onTimings: expect.any(Function),
      });
      expect(play).toHaveBeenCalledWith(GREETING_AUDIO);
      expect(result.current.status).toBe('');
    });

    it('logs stage timings once the reply has been spoken, in dev', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockImplementation(async (_audio, options) => {
        options?.onTimings?.({ decode: 40, inference: 3300, device: 'webgpu' });
        return 'Hola';
      });
      vi.mocked(generateMessage).mockImplementation(streamed('¡Hola!'));
      speak.mockImplementation(async (_text, opts) => {
        opts?.onTimings?.({ startup: 900, synthesis: 1500 });
        return GREETING_AUDIO;
      });

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      await act(async () => {
        result.current.toggleRecording();
      });

      expect(play).toHaveBeenCalled();
      expect(console.info).toHaveBeenCalledTimes(1);
      expect(console.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[turn\] stop \d+ · stt \d+ \(decode 40, whisper 3300 on webgpu\) · gen \d+ \(setup \d+, whole reply \d+\) · tts \d+ \(startup 900, synthesis 1500\) · first audio \d+ms · reply 6 chars in 1 sentence$/,
        ),
      );
    });

    it('does not log stage timings in production', async () => {
      vi.stubEnv('DEV', false);
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('¡Hola!'));

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      await act(async () => {
        result.current.toggleRecording();
      });

      expect(play).toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
    });

    it('includes prior turns as history on the next exchange', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe)
        .mockResolvedValueOnce('Hola')
        .mockResolvedValueOnce('Adiós');
      vi.mocked(generateMessage)
        .mockImplementationOnce(streamed('¡Hola!'))
        .mockImplementationOnce(streamed('¡Hasta luego!'));
      speak.mockResolvedValue(GREETING_AUDIO);

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      await act(async () => {
        result.current.toggleRecording();
      });

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      await act(async () => {
        result.current.toggleRecording();
      });

      expect(generateMessage).toHaveBeenLastCalledWith({
        prompt: 'Adiós',
        systemInstruction: SYSTEM_INSTRUCTION,
        history: [
          { role: 'user', content: 'Hola' },
          { role: 'model', content: '¡Hola!' },
        ],
        onStage: expect.any(Function),
        onChunk: expect.any(Function),
      });
    });

    it('speaks each sentence as soon as it is generated', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      let spokenBeforeEnd: string[] = [];
      vi.mocked(generateMessage).mockImplementation(async (options) => {
        options?.onChunk?.('Me gusta ');
        options?.onChunk?.('el café. ¿Y a');
        spokenBeforeEnd = speak.mock.calls.map(([text]) => text);
        options?.onChunk?.(' ti?');
        return 'Me gusta el café. ¿Y a ti?';
      });

      const { result } = renderHook(() => useConversation());
      await takeTurn(result);

      // The first sentence went to be spoken while the reply was unfinished.
      expect(spokenBeforeEnd).toEqual(['Me gusta el café.']);
      expect(speak.mock.calls.map(([text]) => text)).toEqual([
        'Me gusta el café.',
        '¿Y a ti?',
      ]);
      expect(result.current.status).toBe('');
    });

    it('stores the whole reply in history, not its sentences', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe)
        .mockResolvedValueOnce('Hola')
        .mockResolvedValueOnce('Bien');
      vi.mocked(generateMessage)
        .mockImplementationOnce(streamed('Me gusta. ', '¿Y a ti?'))
        .mockImplementationOnce(streamed('Vale.'));

      const { result } = renderHook(() => useConversation());
      await takeTurn(result);
      await takeTurn(result);

      expect(generateMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          history: [
            { role: 'user', content: 'Hola' },
            { role: 'model', content: 'Me gusta. ¿Y a ti?' },
          ],
        }),
      );
    });

    it('plays sentences in order, even when a later one is synthesised first', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('Uno. ', 'Dos.'));
      const first = deferred<Blob>();
      const second = deferred<Blob>();
      const firstClip = new Blob(['uno']);
      const secondClip = new Blob(['dos']);
      speak
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const { result } = renderHook(() => useConversation());
      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));

      await act(async () => {
        second.resolve(secondClip);
      });
      expect(play).not.toHaveBeenCalled();

      await act(async () => {
        first.resolve(firstClip);
      });
      await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
      expect(vi.mocked(play).mock.calls).toEqual([[firstClip], [secondClip]]);
    });

    it('stops speaking the reply once a sentence fails', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(
        streamed('Uno. ', 'Dos. ', 'Tres.'),
      );
      speak
        .mockResolvedValueOnce(new Blob(['uno']))
        .mockRejectedValueOnce(new Error('synth failed'))
        .mockResolvedValueOnce(new Blob(['tres']));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useConversation());
      await takeTurn(result);

      expect(play).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe('Something went wrong');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('lets a sentence already speaking finish when generation then fails', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(async (options) => {
        options?.onChunk?.('Me gusta. ¿Y');
        throw new Error('generation failed');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useConversation());
      await takeTurn(result);

      expect(speak).toHaveBeenCalledWith('Me gusta.', expect.anything());
      expect(play).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe('Something went wrong');

      errorSpy.mockRestore();
    });

    it('sets an error status and logs when transcription fails', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockRejectedValue(new Error('model load failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useConversation());

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });

      expect(result.current.status).toBe('Something went wrong');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('ignores toggles while a request is already in flight', async () => {
      const { start } = mockRecorderImpl({
        start: () => new Promise(() => {}),
      });

      const { result } = renderHook(() => useConversation());

      act(() => {
        result.current.toggleRecording();
        result.current.toggleRecording();
      });

      expect(start).toHaveBeenCalledTimes(1);
    });
  });
});
