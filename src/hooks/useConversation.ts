import { useCallback, useRef, useState } from 'react';

import { AudioRecorder } from '#/lib/audio/recorder';
import { play } from '#/lib/audio/player';
import { transcribe } from '#/lib/speech-to-text';
import {
  generateMessage,
  type ChatMessage,
  type GenerateStage,
} from '#/lib/chat';
import { speak } from '#/lib/text-to-speech';
import { formatProgress } from '#/lib/progress';
import { LANGUAGE, SYSTEM_INSTRUCTION, VOICE_ID } from '#/config';

// Preload normally leaves only 'compiling' and 'generating' to happen here.
// 'downloading' shows up when the browser has evicted the model or the wasm
// runtime since — rare, but it re-fetches gigabytes, so it says so rather
// than looking stuck.
const STAGE_STATUS: Record<GenerateStage, string> = {
  downloading: 'Downloading…',
  compiling: 'Warming up…',
  generating: 'Generating…',
};

export function useConversation() {
  const [isRecording, setIsRecording] = useState(false);
  const [hasGreeted, setHasGreeted] = useState(false);
  const [isGreetingReady, setIsGreetingReady] = useState(false);
  const [status, setStatus] = useState('');

  const busyRef = useRef(false);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const preparingGreetingRef = useRef(false);
  const greetingRef = useRef<{ text: string; audio: Blob } | null>(null);

  const speakReply = useCallback(async (text: string) => {
    setStatus('Speaking…');
    const audio = await speak(VOICE_ID, text, (p) =>
      setStatus(`Downloading voice model... ${formatProgress(p)}`),
    );
    await play(audio);
    setStatus('');
  }, []);

  const prepareGreeting = useCallback(async () => {
    if (preparingGreetingRef.current || greetingRef.current) return;
    preparingGreetingRef.current = true;
    try {
      setStatus(STAGE_STATUS.compiling);
      const opening = await generateMessage({
        systemInstruction: SYSTEM_INSTRUCTION,
        onStage: (stage) => setStatus(STAGE_STATUS[stage]),
      });
      const audio = await speak(VOICE_ID, opening, (p) =>
        setStatus(`Downloading voice model… ${formatProgress(p)}`),
      );
      greetingRef.current = { text: opening, audio };
      setStatus('');
      setIsGreetingReady(true);
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong');
    } finally {
      preparingGreetingRef.current = false;
    }
  }, []);

  const greet = useCallback(async () => {
    if (busyRef.current) return;
    const greeting = greetingRef.current;
    if (!greeting) return;
    busyRef.current = true;
    try {
      historyRef.current.push({ role: 'model', content: greeting.text });
      setHasGreeted(true);
      setStatus('Speaking…');
      await play(greeting.audio);
      setStatus('');
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong');
    } finally {
      busyRef.current = false;
    }
  }, []);

  const startRecording = useCallback(async () => {
    busyRef.current = true;
    try {
      const recorder = new AudioRecorder();
      await recorder.start();
      recorderRef.current = recorder;
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
    busyRef.current = true;
    try {
      const audioBlob = await recorder.stop();

      setStatus('Transcribing…');
      const text = await transcribe(audioBlob, { language: LANGUAGE });
      historyRef.current.push({ role: 'user', content: text });

      setStatus(STAGE_STATUS.generating);
      const reply = await generateMessage({
        prompt: text,
        systemInstruction: SYSTEM_INSTRUCTION,
        history: historyRef.current.slice(0, -1),
        onStage: (stage) => setStatus(STAGE_STATUS[stage]),
      });
      historyRef.current.push({ role: 'model', content: reply });

      await speakReply(reply);
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong');
    } finally {
      busyRef.current = false;
    }
  }, [speakReply]);

  const toggleRecording = useCallback(() => {
    if (busyRef.current) return;
    if (!isRecording) {
      void startRecording();
    } else {
      void stopRecordingAndRespond();
    }
  }, [isRecording, startRecording, stopRecordingAndRespond]);

  return {
    isRecording,
    hasGreeted,
    isGreetingReady,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
  };
}
