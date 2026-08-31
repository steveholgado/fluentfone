let currentAudio: HTMLAudioElement | null = null;

/** Stops any audio previously started via `play()`. */
export function stopPlayback(): void {
  currentAudio?.pause();
  currentAudio = null;
}

/** Plays a single audio clip, replacing whatever this module last played. */
export function play(audio: Blob): Promise<void> {
  stopPlayback();

  const element = new Audio(URL.createObjectURL(audio));
  currentAudio = element;

  return new Promise((resolve, reject) => {
    element.onended = () => resolve();
    element.onerror = () => reject(new Error('Audio playback failed.'));
    element.play().catch(reject);
  });
}
