import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AudioRecorder,
  play,
  releaseTap,
  stopPlayback,
  tapStream,
  unlock,
} from '#/lib/audio';
import {
  preload as preloadSpeechToText,
  transcribe,
  type TranscribeTimings,
} from '#/lib/speech-to-text';
import {
  generateMessage,
  type ChatMessage,
  type GenerateStage,
} from '#/lib/chat';
import { openVoice, type SpeakTimings, type Voice } from '#/lib/text-to-speech';
import { formatProgress } from '#/utils/formatProgress';
import { formatTurnTimings } from '#/lib/utils/formatTurnTimings';
import { createSentenceSplitter } from '#/lib/utils/sentenceSplitter';
import { markScenarioUsed, pickScenario } from '#/lib/scenarios';
import {
  buildSystemInstruction,
  finalTurnPrompt,
  greetingTrigger,
  type CefrLevel,
} from '#/prompts';
import { LANGUAGES, MAX_USER_TURNS, voiceFor, type LanguageId } from '#/config';

// 'loading' is the everyday one: preload put the model on disk, and this is
// the wait while several gigabytes are read back off it and compiled. It is
// labelled like the Whisper and voice loads before it, so the whole wait reads
// as one. 'downloading' is reserved for bytes actually crossing the network —
// a first run that skipped preload, or a browser that has evicted the model
// since. Worth separating, because one of them is a reason to check your
// connection and the other isn't.
const STAGE_STATUS: Record<GenerateStage, string> = {
  downloading: 'Downloading…',
  loading: 'Warming up…',
  generating: 'Generating…',
};

/**
 * How long a line's text stays up once its repeat has finished, so a reader
 * still partway through isn't cut off mid-sentence.
 */
export const TRANSCRIPT_LINGER_MS = 2000;

interface ConversationOptions {
  /**
   * Fixed for the conversation's life: a new level means a new call, so the
   * caller remounts rather than passing a different one.
   */
  level: CefrLevel;
  /** Fixed for the conversation's life, like `level`. */
  language: LanguageId;
  /**
   * Can change mid-call. Each reply is spoken at the speed it started at, so
   * a change applies from the next one.
   */
  speed: number;
}

export function useConversation({
  level,
  language,
  speed,
}: ConversationOptions) {
  const systemInstruction = useMemo(
    () => buildSystemInstruction(level, language),
    [level, language],
  );
  // Read when a line is synthesised, which is after the render that set it.
  const speedRef = useRef(speed);

  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [hasGreeted, setHasGreeted] = useState(false);
  const [isGreetingReady, setIsGreetingReady] = useState(false);
  const [status, setStatus] = useState('');
  const [canRepeat, setCanRepeat] = useState(false);
  // Once the goodbye has been spoken. Nothing more can be said, but the
  // goodbye can still be repeated. Mirrored in a ref for the callbacks.
  const [hasEnded, setHasEnded] = useState(false);
  const endedRef = useRef(false);
  // The line being repeated, while it's repeated with its text showing and
  // for a moment after.
  const [transcript, setTranscript] = useState<string | null>(null);
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const busyRef = useRef(false);
  // Set once the conversation has unmounted, i.e. the call has ended.
  const disposedRef = useRef(false);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const preparingGreetingRef = useRef(false);
  const greetingRef = useRef<{
    text: string;
    audio: Promise<Blob>;
    speed: number;
    /** Only counted as heard once the call is answered. */
    scenarioId: string;
  } | null>(null);
  const voiceRef = useRef<Voice | null>(null);
  // The line the agent has just finished speaking, kept so it can be said
  // again: the clips already played, and the text they were spoken from.
  const lastLineRef = useRef<{
    sentences: string[];
    clips: Blob[];
  } | null>(null);

  // One voice for the whole conversation, so its session loads once rather
  // than on every line. Opened on first use and closed with the conversation;
  // refused after that, so work still in flight can't open another.
  const getVoice = useCallback(() => {
    if (disposedRef.current) throw new Error('This conversation has ended.');
    return (voiceRef.current ??= openVoice(voiceFor(language), (p) =>
      setStatus(`Downloading voice model… ${formatProgress(p.progress)}`),
    ));
  }, [language]);

  const hideTranscript = useCallback(() => {
    clearTimeout(transcriptTimerRef.current);
    setTranscript(null);
  }, []);

  // Ending the call cuts off whatever is in flight, rather than leaving it to
  // play into the next one. A generate can't be aborted, so it runs on in the
  // chat worker, but nothing it produces is spoken: the voice is closed, and
  // playVoice won't play.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      clearTimeout(transcriptTimerRef.current);
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

  // The greeting is synthesised before the call is answered, so a speed change
  // in between has it synthesised again, straight away, to be ready in time.
  const matchGreetingSpeed = useCallback(() => {
    const greeting = greetingRef.current;
    const speed = speedRef.current;
    if (!greeting || greeting.speed === speed) return;
    const audio = getVoice().speak(greeting.text, { speed });
    // Its failure surfaces in greet(), which awaits it.
    audio.catch(() => {});
    greetingRef.current = { ...greeting, audio, speed };
  }, [getVoice]);

  const prepareGreeting = useCallback(async () => {
    if (preparingGreetingRef.current || greetingRef.current) return;
    preparingGreetingRef.current = true;

    try {
      // Whisper and the voice are built first, together, and the chat engine
      // only once both have finished. Each load holds far more while it runs
      // than it keeps, and what it held lingers as garbage in a worker that
      // then sits idle, so whatever loads last does so on top of everything
      // before it. Last, then, is the chat engine, which keeps ~2 GB: built
      // after it, Whisper's load added ~1.3 GB to the tab's peak.
      //
      // Settled rather than all succeeded: a failure surfaces where the model
      // is next used, in transcribe() or speak(), each of which tries again.
      setStatus(STAGE_STATUS.loading);
      await Promise.allSettled([preloadSpeechToText(), getVoice().ready]);
      // The call can end during that, and the engine shouldn't then be built
      // for it.
      if (disposedRef.current) return;

      const scenario = pickScenario(level);
      const opening = await generateMessage({
        systemInstruction,
        trigger: greetingTrigger(scenario),
        onStage: (stage) => setStatus(STAGE_STATUS[stage]),
      });
      const speed = speedRef.current;
      const audio = await getVoice().speak(opening, { speed });
      greetingRef.current = {
        text: opening,
        audio: Promise.resolve(audio),
        speed,
        scenarioId: scenario.id,
      };
      // In case the speed changed while that was being synthesised.
      matchGreetingSpeed();
      setStatus('');
      setIsGreetingReady(true);
    } catch (err) {
      report(err);
    } finally {
      preparingGreetingRef.current = false;
    }
  }, [getVoice, level, matchGreetingSpeed, report, systemInstruction]);

  useEffect(() => {
    speedRef.current = speed;
    if (!hasGreeted) matchGreetingSpeed();
  }, [speed, hasGreeted, matchGreetingSpeed]);

  const greet = useCallback(async () => {
    // Synchronously, before any await: the audio context can only start from
    // inside the gesture that triggered this.
    unlock();
    if (busyRef.current) return;
    const greeting = greetingRef.current;
    if (!greeting) return;
    busyRef.current = true;
    markScenarioUsed(level, greeting.scenarioId);
    try {
      historyRef.current.push({ role: 'model', content: greeting.text });
      setHasGreeted(true);
      setStatus('Speaking…');
      // Only still synthesising if the speed was changed just before answering.
      const audio = await greeting.audio;
      await playVoice(audio);
      lastLineRef.current = { sentences: [greeting.text], clips: [audio] };
      setCanRepeat(true);
      setStatus('');
    } catch (err) {
      report(err);
    } finally {
      busyRef.current = false;
    }
  }, [level, playVoice, report]);

  const startRecording = useCallback(async () => {
    busyRef.current = true;
    // Only the line just spoken can be repeated; once the user starts their
    // turn, it's gone until the next reply has been heard in full. So is its
    // text, even if it was still lingering.
    lastLineRef.current = null;
    setCanRepeat(false);
    hideTranscript();
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
  }, [hideTranscript, report]);

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
        language: LANGUAGES[language].transcription,
        onTimings: (t) => (sttTimings = t),
      });
      const transcribed = performance.now();
      historyRef.current.push({ role: 'user', content: text });
      // At or past the limit rather than exactly on it: a final turn that
      // failed leaves its words in the history, and the retry is the final
      // turn again.
      const isLastTurn =
        historyRef.current.filter((turn) => turn.role === 'user').length >=
        MAX_USER_TURNS;

      // The reply is spoken a sentence at a time as it's generated: each
      // sentence goes to the voice the moment it's complete, and plays once
      // its audio is back and the one before has finished. So the first
      // sentence plays while the rest is still being generated and
      // synthesised, rather than after all of it.
      //
      // The whole reply is at one speed: a change that lands partway through
      // applies from the next one.
      setStatus(STAGE_STATUS.generating);
      const voice = getVoice();
      const replySpeed = speedRef.current;
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
          speed: replySpeed,
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
          // The goodbye's direction goes to the model only. The history keeps
          // what the user said, and nothing follows to be compared with it.
          prompt: isLastTurn ? finalTurnPrompt(text) : text,
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

      await playback;
      lastLineRef.current = { sentences: spoken, clips };
      setCanRepeat(true);
      setStatus('');
      // Only once the goodbye has been heard in full.
      if (isLastTurn) {
        endedRef.current = true;
        setHasEnded(true);
      }

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
  }, [getVoice, language, playVoice, report, systemInstruction]);

  const toggleRecording = useCallback(() => {
    unlock();
    if (busyRef.current || endedRef.current) return;
    if (!isRecording) {
      void startRecording();
    } else {
      void stopRecordingAndRespond();
    }
  }, [isRecording, startRecording, stopRecordingAndRespond]);

  // `withText` shows the line's text while the repeat plays and for
  // TRANSCRIPT_LINGER_MS after. The linger is a timer rather than part of the
  // repeat, so the user can start their turn without waiting it out.
  const repeatLastLine = useCallback(
    async (withText: boolean) => {
      unlock();
      if (busyRef.current) return;
      const line = lastLineRef.current;
      if (!line) return;
      busyRef.current = true;
      if (withText) setTranscript(line.sentences.join(' '));
      try {
        setStatus('Speaking…');
        for (const clip of line.clips) await playVoice(clip);
        setStatus('');
        if (withText) {
          transcriptTimerRef.current = setTimeout(
            hideTranscript,
            TRANSCRIPT_LINGER_MS,
          );
        }
      } catch (err) {
        report(err);
        // Straight away, so the error shows in its place.
        hideTranscript();
      } finally {
        busyRef.current = false;
      }
    },
    [hideTranscript, playVoice, report],
  );

  return {
    isRecording,
    isAudioLive: isRecording || isSpeaking,
    hasGreeted,
    isGreetingReady,
    canRepeat,
    hasEnded,
    transcript,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
    repeatLastLine,
  };
}
