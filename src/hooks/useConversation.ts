import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AudioRecorder,
  play,
  releaseTap,
  tapStream,
  unlock,
} from '#/lib/audio';
import { transcribe, type TranscribeTimings } from '#/lib/speech-to-text';
import {
  generateMessage,
  type ChatMessage,
  type GenerateStage,
} from '#/lib/chat';
import { openVoice, type SpeakTimings, type Voice } from '#/lib/text-to-speech';
import { formatProgress } from '#/utils/formatProgress';
import { formatTurnTimings } from '#/lib/utils/formatTurnTimings';
import { createSentenceSplitter } from '#/lib/utils/sentenceSplitter';
import {
  CONVERSATION_INSTRUCTION,
  GREETING_INSTRUCTION,
  LANGUAGE,
  VOICE_ID,
} from '#/config';

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

export function useConversation() {
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [hasGreeted, setHasGreeted] = useState(false);
  const [isGreetingReady, setIsGreetingReady] = useState(false);
  const [status, setStatus] = useState('');

  const busyRef = useRef(false);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const preparingGreetingRef = useRef(false);
  const greetingRef = useRef<{ text: string; audio: Blob } | null>(null);
  const voiceRef = useRef<Voice | null>(null);

  // One voice for the whole conversation, so its session loads once rather
  // than on every line. Opened on first use and closed with the conversation.
  const getVoice = useCallback(
    () =>
      (voiceRef.current ??= openVoice(VOICE_ID, (p) =>
        setStatus(`Downloading voice model… ${formatProgress(p.progress)}`),
      )),
    [],
  );

  useEffect(
    () => () => {
      voiceRef.current?.close();
      voiceRef.current = null;
    },
    [],
  );

  // Both playback sites go through here so the flag clears even when playback
  // rejects — the callers turn that into a status message and carry on.
  const playVoice = useCallback(async (audio: Blob) => {
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
        systemInstruction: GREETING_INSTRUCTION,
        onStage: (stage) => setStatus(STAGE_STATUS[stage]),
      });
      const audio = await getVoice().speak(opening, { slow: true });
      greetingRef.current = { text: opening, audio };
      setStatus('');
      setIsGreetingReady(true);
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong');
    } finally {
      preparingGreetingRef.current = false;
    }
  }, [getVoice]);

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
      setStatus('');
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong');
    } finally {
      busyRef.current = false;
    }
  }, [playVoice]);

  const startRecording = useCallback(async () => {
    busyRef.current = true;
    try {
      const recorder = new AudioRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      tapStream(recorder.stream);
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      setStatus('Could not access microphone');
    } finally {
      busyRef.current = false;
    }
  }, []);

  const stopRecordingAndRespond = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;

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
      let sentenceCount = 0;
      let playback = Promise.resolve();

      const sentences = createSentenceSplitter((sentence) => {
        const isFirst = sentenceCount++ === 0;
        if (isFirst) firstSentence = performance.now();

        let timings: SpeakTimings | undefined;
        const audio = voice.speak(sentence, {
          slow: true,
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
          systemInstruction: CONVERSATION_INSTRUCTION,
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
          sentenceCount,
        );
        console.info(`[turn] ${timings}`);
      }
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong');
    } finally {
      busyRef.current = false;
    }
  }, [getVoice, playVoice]);

  const toggleRecording = useCallback(() => {
    unlock();
    if (busyRef.current) return;
    if (!isRecording) {
      void startRecording();
    } else {
      void stopRecordingAndRespond();
    }
  }, [isRecording, startRecording, stopRecordingAndRespond]);

  return {
    isRecording,
    isAudioLive: isRecording || isSpeaking,
    hasGreeted,
    isGreetingReady,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
  };
}
