import { releaseTap, tapElement } from './analyser';

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** Stops any audio previously started via `play()`. */
export function stopPlayback(): void {
  currentAudio?.pause();
  currentAudio = null;
  releaseTap();

  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
}

/** Plays a single audio clip, replacing whatever this module last played. */
export function play(audio: Blob): Promise<void> {
  stopPlayback();

  const url = URL.createObjectURL(audio);
  const element = new Audio(url);
  currentAudio = element;
  currentUrl = url;

  // Stays synchronous: awaiting anything here would push element.play() out of
  // the task that the user's click started.
  tapElement(element);

  return new Promise((resolve, reject) => {
    const settle = () => {
      if (currentUrl === url) currentUrl = null;
      URL.revokeObjectURL(url);
    };

    element.onended = () => {
      settle();
      resolve();
    };
    element.onerror = () => {
      settle();
      reject(new Error('Audio playback failed.'));
    };
    element.play().catch((err) => {
      settle();
      reject(err);
    });
  });
}
