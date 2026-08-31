import { useCallback, useRef, useState } from 'react';

import { AudioRecorder } from '#/lib/audio/recorder';
import { play } from '#/lib/audio/player';
import { transcribe } from '#/lib/speech-to-text';
import { generateMessage, type ChatMessage } from '#/lib/chat';
import { speak } from '#/lib/text-to-speech';
import { preloadAll } from '#/lib/preload';
import { formatProgress } from '#/lib/progress';
import { LANGUAGE, SYSTEM_INSTRUCTION, VOICE_ID } from '#/config';

export function useConversation() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('');
  const [isPreloading, setIsPreloading] = useState(false);

  const hasGreetedRef = useRef(false);
  const busyRef = useRef(false);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);

  const speakReply = useCallback(async (text: string) => {
    setStatus('Speaking…');
    const audio = await speak(VOICE_ID, text, (p) =>
      setStatus(`Downloading voice model… ${formatProgress(p)}`),
    );
    await play(audio);
    setStatus('');
  }, []);

  const greet = useCallback(async () => {
    busyRef.current = true;
    try {
      setStatus('Generating…');
      const opening = await generateMessage({
        systemInstruction: SYSTEM_INSTRUCTION,
      });
      historyRef.current.push({ role: 'model', content: opening });
      hasGreetedRef.current = true;
      await speakReply(opening);
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong — see console.');
    } finally {
      busyRef.current = false;
    }
  }, [speakReply]);

  const startRecording = useCallback(async () => {
    busyRef.current = true;
    try {
      const recorder = new AudioRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      setStatus('Could not access microphone — see console.');
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

      setStatus('Generating…');
      const reply = await generateMessage({
        prompt: text,
        systemInstruction: SYSTEM_INSTRUCTION,
        history: historyRef.current.slice(0, -1),
      });
      historyRef.current.push({ role: 'model', content: reply });

      await speakReply(reply);
    } catch (err) {
      console.error(err);
      setStatus('Something went wrong — see console.');
    } finally {
      busyRef.current = false;
    }
  }, [speakReply]);

  const toggle = useCallback(() => {
    if (busyRef.current) return;
    if (!hasGreetedRef.current) {
      void greet();
    } else if (!isRecording) {
      void startRecording();
    } else {
      void stopRecordingAndRespond();
    }
  }, [isRecording, greet, startRecording, stopRecordingAndRespond]);

  const preload = useCallback(async () => {
    setIsPreloading(true);
    try {
      await preloadAll(VOICE_ID, (label, p) =>
        setStatus(`Preloading ${label}… ${formatProgress(p)}`),
      );
      setStatus('Models ready.');
    } catch (err) {
      console.error(err);
      setStatus('Preload failed — see console.');
    } finally {
      setIsPreloading(false);
    }
  }, []);

  return { isRecording, status, toggle, preload, isPreloading };
}
