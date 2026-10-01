import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversation } from '#/hooks/useConversation';
import { AudioRecorder } from '#/lib/audio/recorder';
import { play, stopPlayback } from '#/lib/audio/player';
import { transcribe } from '#/lib/speech-to-text';
import { generateMessage } from '#/lib/chat';
import { openVoice, slowRepeatSpeed, type Voice } from '#/lib/text-to-speech';
import {
  buildSystemInstruction,
  GREETING_TRIGGER,
  type CefrLevel,
} from '#/prompts';
import { DEFAULT_LANGUAGE, voiceFor } from '#/config';

vi.mock('#/lib/audio/recorder', () => ({
  AudioRecorder: vi.fn(),
}));
vi.mock('#/lib/audio/player', () => ({
  play: vi.fn(),
  stopPlayback: vi.fn(),
}));
vi.mock('#/lib/speech-to-text', () => ({
  transcribe: vi.fn(),
}));
vi.mock('#/lib/chat', () => ({
  generateMessage: vi.fn(),
}));
vi.mock('#/lib/text-to-speech', async () => ({
  openVoice: vi.fn(),
  slowRepeatSpeed: (
    await vi.importActual<typeof import('#/lib/text-to-speech/constants')>(
      '#/lib/text-to-speech/constants',
    )
  ).slowRepeatSpeed,
  VOICES: {
    en_US: ['en_US-hfc_female-medium'],
    es_ES: ['es_ES-davefx-medium'],
    es_MX: ['es_MX-ald-medium'],
  },
}));

const LEVEL: CefrLevel = 'B1';

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
    const { result } = renderHook(() =>
      useConversation({ level: LEVEL, speed: 1 }),
    );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await act(async () => {
        await result.current.prepareGreeting();
      });

      expect(openedFirst).toBe(true);
    });

    it('closes the voice when the conversation unmounts', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');

      const { result, unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await act(async () => {
        await result.current.prepareGreeting();
      });
      unmount();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('opens nothing until a line needs speaking', () => {
      const { unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      unmount();

      expect(openVoice).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('unmounting', () => {
    it('stops playback and the mic', async () => {
      const { stop } = mockRecorderImpl();

      const { result, unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      unmount();

      expect(stopPlayback).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('leaves a recorder that has already stopped alone', async () => {
      const { stop } = mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('¡Hola!'));

      const { result, unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));
      unmount();

      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('stops a mic that only goes live after the conversation has ended', async () => {
      const started = deferred<void>();
      const { stop } = mockRecorderImpl({ start: () => started.promise });

      const { result, unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await act(async () => {
        result.current.toggleRecording();
      });
      unmount();
      await act(async () => {
        started.resolve();
      });

      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('speaks nothing more of a reply that is still coming', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      const rest = deferred<void>();
      vi.mocked(generateMessage).mockImplementation(async (options) => {
        options?.onStage?.('generating');
        options?.onChunk?.('Uno. ');
        await rest.promise;
        options?.onChunk?.('Dos.');
        return 'Uno. Dos.';
      });
      const first = new Blob(['uno']);
      speak.mockResolvedValueOnce(first);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result, unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await takeTurn(result);
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => {
        rest.resolve();
      });

      expect(vi.mocked(play).mock.calls).toEqual([[first]]);
      expect(error).not.toHaveBeenCalled();
    });

    it('opens no voice for a greeting that arrives after the conversation has ended', async () => {
      const opening = deferred<string>();
      vi.mocked(generateMessage).mockReturnValue(opening.promise);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result, unmount } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      let preparing!: Promise<void>;
      act(() => {
        preparing = result.current.prepareGreeting();
      });
      unmount();
      await act(async () => {
        opening.resolve('¡Hola!');
        await preparing;
      });

      // The one opened up front, while the greeting was generating.
      expect(openVoice).toHaveBeenCalledTimes(1);
      expect(speak).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('speed', () => {
    function renderAtSpeed(speed: number) {
      return renderHook(
        (props: { speed: number }) =>
          useConversation({ level: LEVEL, speed: props.speed }),
        { initialProps: { speed } },
      );
    }

    /** The speed each line so far was synthesised at, in order. */
    function spokenSpeeds() {
      return speak.mock.calls.map(([, options]) => options?.speed);
    }

    it('speaks the greeting and every reply at the speed given', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('Uno. ', 'Dos.'));

      const { result } = renderAtSpeed(0.85);
      await act(async () => {
        await result.current.prepareGreeting();
      });
      await act(async () => {
        await result.current.greet();
      });
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));

      expect(spokenSpeeds()).toEqual([0.85, 0.85, 0.85]);
    });

    it('keeps a reply at the speed it started at, and changes from the next', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      const rest = deferred<void>();
      vi.mocked(generateMessage).mockImplementation(async (options) => {
        options?.onStage?.('generating');
        options?.onChunk?.('Uno. ');
        await rest.promise;
        options?.onChunk?.('Dos.');
        return 'Uno. Dos.';
      });

      const { result, rerender } = renderAtSpeed(1);
      await takeTurn(result);
      await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
      rerender({ speed: 0.7 });
      await act(async () => {
        rest.resolve();
      });
      await waitFor(() => expect(result.current.canRepeat).toBe(true));

      expect(spokenSpeeds()).toEqual([1, 1]);

      vi.mocked(generateMessage).mockImplementation(streamed('Tres.'));
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));

      expect(spokenSpeeds()).toEqual([1, 1, 0.7]);
    });

    it('repeats slowly relative to the speed the line was spoken at', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('Uno.'));

      const { result } = renderAtSpeed(0.85);
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));
      await act(async () => {
        await result.current.repeatLastLine(true);
      });

      expect(spokenSpeeds()).toEqual([0.85, slowRepeatSpeed(0.85)]);
    });

    it('synthesises the greeting again if the speed changes before the call is answered', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      const slower = new Blob(['¡Hooola!']);
      speak.mockResolvedValueOnce(GREETING_AUDIO).mockResolvedValueOnce(slower);

      const { result, rerender } = renderAtSpeed(1);
      await act(async () => {
        await result.current.prepareGreeting();
      });
      rerender({ speed: 0.7 });
      await act(async () => {
        await result.current.greet();
      });

      expect(spokenSpeeds()).toEqual([1, 0.7]);
      expect(vi.mocked(play).mock.calls).toEqual([[slower]]);
    });

    it('catches a speed change made while the greeting is being synthesised', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      const greeting = deferred<Blob>();
      speak.mockReturnValueOnce(greeting.promise);

      const { result, rerender } = renderAtSpeed(1);
      let preparing!: Promise<void>;
      act(() => {
        preparing = result.current.prepareGreeting();
      });
      await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
      rerender({ speed: 0.7 });
      await act(async () => {
        greeting.resolve(GREETING_AUDIO);
        await preparing;
      });

      expect(spokenSpeeds()).toEqual([1, 0.7]);
    });

    it('leaves the greeting alone once the call has been answered', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');

      const { result, rerender } = renderAtSpeed(1);
      await act(async () => {
        await result.current.prepareGreeting();
      });
      await act(async () => {
        await result.current.greet();
      });
      rerender({ speed: 0.7 });

      expect(spokenSpeeds()).toEqual([1]);
    });
  });

  describe('prepareGreeting', () => {
    it('generates and speaks an opening line, then marks the greeting ready', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      speak.mockResolvedValue(GREETING_AUDIO);

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

      await act(async () => {
        await result.current.prepareGreeting();
      });

      expect(generateMessage).toHaveBeenCalledWith({
        systemInstruction: buildSystemInstruction(LEVEL),
        trigger: GREETING_TRIGGER,
        onStage: expect.any(Function),
      });
      expect(openVoice).toHaveBeenCalledWith(
        voiceFor(DEFAULT_LANGUAGE),
        expect.any(Function),
      );
      expect(speak).toHaveBeenCalledWith('¡Hola!', { speed: 1 });
      expect(result.current.isGreetingReady).toBe(true);
      expect(result.current.status).toBe('');
    });

    it('instructs the model at the level it was given, for every line', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('¡Hola!'));

      const { result } = renderHook(() =>
        useConversation({ level: 'A1', speed: 1 }),
      );
      await act(async () => {
        await result.current.prepareGreeting();
      });
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));

      const instructions = vi
        .mocked(generateMessage)
        .mock.calls.map(([options]) => options?.systemInstruction);
      expect(instructions).toEqual([
        buildSystemInstruction('A1'),
        buildSystemInstruction('A1'),
      ]);
    });

    it('does nothing if a greeting is already prepared', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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
      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

      await act(async () => {
        await result.current.greet();
      });

      expect(result.current.hasGreeted).toBe(false);
      expect(play).not.toHaveBeenCalled();
    });

    it('plays the prepared greeting and marks the conversation as greeted', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      speak.mockResolvedValue(GREETING_AUDIO);

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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
      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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
        systemInstruction: buildSystemInstruction(LEVEL),
        history: [],
        onStage: expect.any(Function),
        onChunk: expect.any(Function),
      });
      expect(speak).toHaveBeenCalledWith('¡Muy bien, gracias!', {
        speed: 1,
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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
        systemInstruction: buildSystemInstruction(LEVEL),
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

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

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );

      act(() => {
        result.current.toggleRecording();
        result.current.toggleRecording();
      });

      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  describe('repeatLastLine', () => {
    /** Prepares the greeting and plays it, leaving the hook ready to repeat. */
    async function greeted() {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      speak.mockResolvedValue(GREETING_AUDIO);
      const hook = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await act(async () => {
        await hook.result.current.prepareGreeting();
      });
      await act(async () => {
        await hook.result.current.greet();
      });
      speak.mockClear();
      vi.mocked(play).mockClear();
      return hook;
    }

    it('cannot repeat until the greeting has been played', async () => {
      vi.mocked(generateMessage).mockResolvedValue('¡Hola!');
      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      expect(result.current.canRepeat).toBe(false);

      await act(async () => {
        await result.current.prepareGreeting();
      });
      expect(result.current.canRepeat).toBe(false);

      await act(async () => {
        await result.current.greet();
      });
      expect(result.current.canRepeat).toBe(true);
    });

    it('replays the greeting without synthesising it again', async () => {
      const { result } = await greeted();

      await act(async () => {
        await result.current.repeatLastLine(false);
      });

      expect(speak).not.toHaveBeenCalled();
      expect(play).toHaveBeenCalledWith(GREETING_AUDIO);
      expect(result.current.status).toBe('');
      expect(result.current.canRepeat).toBe(true);
    });

    it('is withdrawn once the user starts speaking, until the reply has played', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      const { result } = await greeted();
      const reply = deferred<string>();
      vi.mocked(generateMessage).mockImplementation(() => reply.promise);

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.isRecording).toBe(true));
      expect(result.current.canRepeat).toBe(false);

      await act(async () => {
        result.current.toggleRecording();
      });
      expect(result.current.canRepeat).toBe(false);

      await act(async () => {
        reply.resolve('Vale.');
      });
      await waitFor(() => expect(result.current.canRepeat).toBe(true));
    });

    it('replays every sentence of the last reply, in order', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('Uno. ', 'Dos.'));
      const firstClip = new Blob(['uno']);
      const secondClip = new Blob(['dos']);
      speak.mockResolvedValueOnce(firstClip).mockResolvedValueOnce(secondClip);

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));
      speak.mockClear();
      vi.mocked(play).mockClear();

      await act(async () => {
        await result.current.repeatLastLine(false);
      });

      expect(speak).not.toHaveBeenCalled();
      expect(vi.mocked(play).mock.calls).toEqual([[firstClip], [secondClip]]);
    });

    it('synthesises each sentence slowly, and only the first time', async () => {
      mockRecorderImpl();
      vi.mocked(transcribe).mockResolvedValue('Hola');
      vi.mocked(generateMessage).mockImplementation(streamed('Uno. ', 'Dos.'));

      const { result } = renderHook(() =>
        useConversation({ level: LEVEL, speed: 1 }),
      );
      await takeTurn(result);
      await waitFor(() => expect(result.current.canRepeat).toBe(true));
      speak.mockClear();
      vi.mocked(play).mockClear();
      const slowFirst = new Blob(['uuuno']);
      const slowSecond = new Blob(['dooos']);
      speak.mockResolvedValueOnce(slowFirst).mockResolvedValueOnce(slowSecond);

      await act(async () => {
        await result.current.repeatLastLine(true);
      });
      await act(async () => {
        await result.current.repeatLastLine(true);
      });

      expect(speak.mock.calls).toEqual([
        ['Uno.', { speed: slowRepeatSpeed(1) }],
        ['Dos.', { speed: slowRepeatSpeed(1) }],
      ]);
      expect(vi.mocked(play).mock.calls).toEqual([
        [slowFirst],
        [slowSecond],
        [slowFirst],
        [slowSecond],
      ]);
      expect(result.current.status).toBe('');
    });

    it('ignores a repeat while one is already playing', async () => {
      const { result } = await greeted();
      const playing = deferred<void>();
      vi.mocked(play).mockReturnValueOnce(playing.promise);

      await act(async () => {
        void result.current.repeatLastLine(false);
        void result.current.repeatLastLine(true);
      });
      await act(async () => {
        playing.resolve();
      });

      expect(play).toHaveBeenCalledTimes(1);
      expect(speak).not.toHaveBeenCalled();
    });

    it('sets an error status, and tries the slow synthesis again next time', async () => {
      const { result } = await greeted();
      speak.mockRejectedValueOnce(new Error('synth failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await act(async () => {
        await result.current.repeatLastLine(true);
      });

      expect(result.current.status).toBe('Something went wrong');
      expect(errorSpy).toHaveBeenCalled();

      await act(async () => {
        await result.current.repeatLastLine(true);
      });

      expect(speak).toHaveBeenCalledTimes(2);
      expect(play).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe('');

      errorSpy.mockRestore();
    });
  });
});
