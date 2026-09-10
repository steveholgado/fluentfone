import { useCallback, useRef, useState } from 'react';

import { AudioRecorder } from '#/lib/audio/recorder';
import { play } from '#/lib/audio/player';
import { transcribe } from '#/lib/speech-to-text';
import { generateMessage, type ChatMessage } from '#/lib/chat';
import { speak } from '#/lib/text-to-speech';
import { formatProgress } from '#/lib/progress';
import { LANGUAGE, SYSTEM_INSTRUCTION, VOICE_ID } from '#/config';

export function useConversation() {
  const [isRecording, setIsRecording] = useState(false);
  const [hasGreeted, setHasGreeted] = useState(false);
  const [status, setStatus] = useState('');

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
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setStatus('Generating…');
      const opening = await generateMessage({
        systemInstruction: SYSTEM_INSTRUCTION,
      });
      historyRef.current.push({ role: 'model', content: opening });
      setHasGreeted(true);
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

  const toggleRecording = useCallback(() => {
    if (busyRef.current) return;
    if (!isRecording) {
      void startRecording();
    } else {
      void stopRecordingAndRespond();
    }
  }, [isRecording, startRecording, stopRecordingAndRespond]);

  return { isRecording, hasGreeted, status, greet, toggleRecording };
}
