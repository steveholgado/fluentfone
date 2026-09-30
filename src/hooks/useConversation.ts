import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AudioRecorder,
  play,
  releaseTap,
  stopPlayback,
  tapStream,
  unlock,
} from '#/lib/audio';
import { transcribe, type TranscribeTimings } from '#/lib/speech-to-text';
import {
  generateMessage,
  type ChatMessage,
  type GenerateStage,
} from '#/lib/chat';
import {
  openVoice,
  slowRepeatSpeed,
  type SpeakTimings,
  type Voice,
} from '#/lib/text-to-speech';
import { formatProgress } from '#/utils/formatProgress';
import { formatTurnTimings } from '#/lib/utils/formatTurnTimings';
import { createSentenceSplitter } from '#/lib/utils/sentenceSplitter';
import {
  buildSystemInstruction,
  GREETING_TRIGGER,
  type CefrLevel,
} from '#/prompts';
import { LANGUAGE, VOICE_ID } from '#/config';

// 'loading' is the everyday one: preload put the model on disk, and this is
// the wait while several gigabytes are read back off it. 'downloading' is
// reserved for bytes actually crossing the network — a first run that skipped
// preload, or a browser that has evicted the model since. Worth separating,
// because one of them is a reason to check your connection and the other
// isn't.
const STAGE_STATUS: Record<GenerateStage, string> = {
  downloading: 'Downloading…',
  loading: 'Loading…',
  compiling: 'Warming up…',
  generating: 'Generating…',
};

interface ConversationOptions {
  /**
   * Fixed for the conversation's life: a new level means a new call, so the
   * caller remounts rather than passing a different one.
   */
  level: CefrLevel;
}

export function useConversation({ level }: ConversationOptions) {
  const systemInstruction = useMemo(
    () => buildSystemInstruction(level),
    [level],
  );

  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [hasGreeted, setHasGreeted] = useState(false);
  const [isGreetingReady, setIsGreetingReady] = useState(false);
  const [status, setStatus] = useState('');
  const [canRepeat, setCanRepeat] = useState(false);

  const busyRef = useRef(false);
  // Set once the conversation has unmounted, i.e. the call has ended.
  const disposedRef = useRef(false);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const preparingGreetingRef = useRef(false);
  const greetingRef = useRef<{ text: string; audio: Blob } | null>(null);
  const voiceRef = useRef<Voice | null>(null);
  // The line the agent has just finished speaking, kept so it can be said
  // again. The normal-speed clips are the ones already played; the slow ones
  // are only synthesised if asked for, then kept for any further repeats.
  const lastLineRef = useRef<{
    sentences: string[];
    clips: Blob[];
    slowClips?: Promise<Blob>[];
  } | null>(null);

  // One voice for the whole conversation, so its session loads once rather
  // than on every line. Opened on first use and closed with the conversation;
  // refused after that, so work still in flight can't open another.
  const getVoice = useCallback(() => {
    if (disposedRef.current) throw new Error('This conversation has ended.');
    return (voiceRef.current ??= openVoice(VOICE_ID, (p) =>
      setStatus(`Downloading voice model… ${formatProgress(p.progress)}`),
    ));
  }, []);

  // Ending the call cuts off whatever is in flight, rather than leaving it to
  // play into the next one. A generate can't be aborted, so it runs on in the
  // chat worker, but nothing it produces is spoken: the voice is closed, and
  // playVoice won't play.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopPlayback();
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      voiceRef.current?.close();
      voiceRef.current = null;
    };
  }, []);

  // Once the call has ended, work still in flight fails as the voice closes
  // under it. That's expected, and there's no one left to tell.
  const report = useCallback(
    (err: unknown, message = 'Something went wrong') => {
      if (disposedRef.current) return;
      console.error(err);
      setStatus(message);
    },
    [],
  );

  // Both playback sites go through here so the flag clears even when playback
  // rejects — the callers turn that into a status message and carry on.
  const playVoice = useCallback(async (audio: Blob) => {
    if (disposedRef.current) return;
    setIsSpeaking(true);
    try {
      await play(audio);
    } finally {
      setIsSpeaking(false);
    }
  }, []);

  const prepareGreeting = useCallback(async () => {
    if (preparingGreetingRef.current || greetingRef.current) return;
    preparingGreetingRef.current = true;
    try {
      // Opened now so the voice's session is built — wasm compiled, voice read
      // back from OPFS — while the greeting is generated.
      getVoice();
      setStatus(STAGE_STATUS.compiling);
      const opening = await generateMessage({
        systemInstruction,
        trigger: GREETING_TRIGGER,
        onStage: (stage) => setStatus(STAGE_STATUS[stage]),
      });
      const audio = await getVoice().speak(opening, { speed: 1 });
      greetingRef.current = { text: opening, audio };
      setStatus('');
      setIsGreetingReady(true);
    } catch (err) {
      report(err);
    } finally {
      preparingGreetingRef.current = false;
    }
  }, [getVoice, report, systemInstruction]);

  const greet = useCallback(async () => {
    // Synchronously, before any await: the audio context can only start from
    // inside the gesture that triggered this.
    unlock();
    if (busyRef.current) return;
    const greeting = greetingRef.current;
    if (!greeting) return;
    busyRef.current = true;
    try {
      historyRef.current.push({ role: 'model', content: greeting.text });
      setHasGreeted(true);
      setStatus('Speaking…');
      await playVoice(greeting.audio);
      lastLineRef.current = {
        sentences: [greeting.text],
        clips: [greeting.audio],
      };
      setCanRepeat(true);
      setStatus('');
    } catch (err) {
      report(err);
    } finally {
      busyRef.current = false;
    }
  }, [playVoice, report]);

  const startRecording = useCallback(async () => {
    busyRef.current = true;
    // Only the line just spoken can be repeated; once the user starts their
    // turn, it's gone until the next reply has been heard in full.
    lastLineRef.current = null;
    setCanRepeat(false);
    try {
      const recorder = new AudioRecorder();
      await recorder.start();
      // The permission prompt can sit open while the call is ended.
      if (disposedRef.current) {
        void recorder.stop();
        return;
      }
      recorderRef.current = recorder;
      tapStream(recorder.stream);
      setIsRecording(true);
    } catch (err) {
      report(err, 'Could not access microphone');
    } finally {
      busyRef.current = false;
    }
  }, [report]);

  const stopRecordingAndRespond = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    // Cleared so that only a live recorder is left for the unmount to stop.
    recorderRef.current = null;

    setIsRecording(false);
    // Before stop(), which ends the tracks the tap is reading from.
    releaseTap();
    busyRef.current = true;
    try {
      const start = performance.now();
      const audioBlob = await recorder.stop();
      const stopped = performance.now();

      setStatus('Transcribing…');
      let sttTimings: TranscribeTimings | undefined;
      const text = await transcribe(audioBlob, {
        language: LANGUAGE,
        onTimings: (t) => (sttTimings = t),
      });
      const transcribed = performance.now();
      historyRef.current.push({ role: 'user', content: text });

      // The reply is spoken a sentence at a time as it's generated: each
      // sentence goes to the voice the moment it's complete, and plays once
      // its audio is back and the one before has finished. So the first
      // sentence plays while the rest is still being generated and
      // synthesised, rather than after all of it.
      setStatus(STAGE_STATUS.generating);
      const voice = getVoice();
      let generating: number | undefined;
      let firstSentence: number | undefined;
      let synthesised: number | undefined;
      let ttsTimings: SpeakTimings | undefined;
      const spoken: string[] = [];
      const clips: Blob[] = [];
      let playback = Promise.resolve();

      const sentences = createSentenceSplitter((sentence) => {
        const isFirst = spoken.push(sentence) === 1;
        if (isFirst) firstSentence = performance.now();

        let timings: SpeakTimings | undefined;
        const audio = voice.speak(sentence, {
          speed: 1,
          onTimings: (t) => (timings = t),
        });
        // Its failure surfaces through `playback`, which awaits it in turn.
        audio.catch(() => {});

        playback = playback.then(async () => {
          const clip = await audio;
          if (isFirst) {
            synthesised = performance.now();
            ttsTimings = timings;
            setStatus('Speaking…');
          }
          clips.push(clip);
          await playVoice(clip);
        });
        // Awaited below, once generation is over; until then a failure would
        // otherwise be reported as unhandled.
        playback.catch(() => {});
      });

      let reply: string;
      try {
        reply = await generateMessage({
          prompt: text,
          systemInstruction,
          history: historyRef.current.slice(0, -1),
          onStage: (stage) => {
            if (stage === 'generating') generating = performance.now();
            setStatus(STAGE_STATUS[stage]);
          },
          onChunk: (chunk) => sentences.push(chunk),
        });
      } catch (err) {
        // Whatever has started speaking finishes before the failure shows.
        await playback.catch(() => {});
        throw err;
      }
      const generated = performance.now();
      sentences.end();
      historyRef.current.push({ role: 'model', content: reply });
      console.log(historyRef.current);

      await playback;
      lastLineRef.current = { sentences: spoken, clips };
      setCanRepeat(true);
      setStatus('');

      if (
        import.meta.env.DEV &&
        firstSentence !== undefined &&
        synthesised !== undefined
      ) {
        const timings = formatTurnTimings(
          {
            start,
            stopped,
            transcribed,
            generating,
            firstSentence,
            generated,
            synthesised,
            stt: sttTimings,
            tts: ttsTimings,
          },
          reply.length,
          spoken.length,
        );
        console.info(`[turn] ${timings}`);
      }
    } catch (err) {
      report(err);
    } finally {
      busyRef.current = false;
    }
  }, [getVoice, playVoice, report, systemInstruction]);

  const toggleRecording = useCallback(() => {
    unlock();
    if (busyRef.current) return;
    if (!isRecording) {
      void startRecording();
    } else {
      void stopRecordingAndRespond();
    }
  }, [isRecording, startRecording, stopRecordingAndRespond]);

  const repeatLastLine = useCallback(
    async (slow: boolean) => {
      unlock();
      if (busyRef.current) return;
      const line = lastLineRef.current;
      if (!line) return;
      busyRef.current = true;
      try {
        setStatus('Speaking…');
        if (slow) {
          // Every sentence goes to the voice at once, so later ones are
          // synthesised while the first plays.
          line.slowClips ??= line.sentences.map((sentence) => {
            const audio = getVoice().speak(sentence, {
              speed: slowRepeatSpeed(1),
            });
            // Its failure surfaces below, when it's awaited in turn.
            audio.catch(() => {});
            return audio;
          });
          for (const clip of line.slowClips) await playVoice(await clip);
        } else {
          for (const clip of line.clips) await playVoice(clip);
        }
        setStatus('');
      } catch (err) {
        report(err);
        // So the next slow repeat tries the synthesis again.
        line.slowClips = undefined;
      } finally {
        busyRef.current = false;
      }
    },
    [getVoice, playVoice, report],
  );

  return {
    isRecording,
    isAudioLive: isRecording || isSpeaking,
    hasGreeted,
    isGreetingReady,
    canRepeat,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
    repeatLastLine,
  };
}
