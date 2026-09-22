import { useEffect, useRef } from 'react';

import { readLevel } from '#/lib/audio';
import { cn } from '#/utils/cn';

const MAX_DPR = 2;
const STEP_PX = 4;
const STROKE = 2;
const CYCLES = 2.4;
const DRIFT = 1.7;
const IDLE = 0.05;
const ATTACK_TAU = 0.045;
const RELEASE_TAU = 0.25;

// Coming back from a background tab hands you one enormous delta, which would
// jump the phase and snap the amplitude. Cap it at roughly three frames.
const MAX_DT = 0.05;

const TWO_PI = Math.PI * 2;

interface WaveformProps {
  className?: string;
}

/**
 * A standing wave whose amplitude follows whatever the audio module currently
 * has tapped — the microphone while recording, the voice while speaking.
 *
 * Mounting and unmounting is the whole start/stop mechanism: there's no idle
 * loop to leave running, because the component only exists while audio does.
 */
export function Waveform({ className }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const reduced =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // Everything mutable lives in this closure rather than in refs. The React
    // Compiler is free to reorder render-phase work, and a remount then starts
    // from a clean set instead of inheriting the last loop's.
    let width = 0;
    let height = 0;
    let frame = 0;
    let phase = 0;
    let amplitude = 0;
    let last = performance.now();

    const render = (now: number) => {
      const dt = Math.min((now - last) / 1000, MAX_DT);
      last = now;

      // Asymmetric easing: snap up to catch a plosive, ease back down so the
      // gaps between syllables don't read as flicker.
      const level = reduced ? 0 : readLevel();
      const tau = level > amplitude ? ATTACK_TAU : RELEASE_TAU;
      amplitude += (level - amplitude) * (1 - Math.exp(-dt / tau));
      if (!reduced) phase += dt * DRIFT;

      const mid = height / 2;
      const peak = (IDLE + amplitude * (1 - IDLE)) * (mid - STROKE);

      context.clearRect(0, 0, width, height);
      context.beginPath();

      for (let x = 0; x <= width; x += STEP_PX) {
        const t = x / width;
        // A half-sine window pins the line to the centre at both ends, so it
        // reads as a standing wave rather than a slice cut out of a longer one.
        const envelope = Math.sin(Math.PI * t);
        const wave =
          Math.sin(t * TWO_PI * CYCLES + phase) * 0.65 +
          Math.sin(t * TWO_PI * CYCLES * 1.7 - phase * 0.6) * 0.35;
        const y = mid - wave * envelope * peak;

        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }

      context.lineTo(width, mid);
      context.stroke();

      if (!reduced) frame = requestAnimationFrame(render);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();

      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      // Resizing the backing store resets the transform, so reapplying the
      // scale and the stroke settings here keeps this idempotent.
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.lineWidth = STROKE;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      // Read once per resize, never per frame, so the colour stays a class.
      context.strokeStyle = getComputedStyle(canvas).color;

      if (reduced) render(performance.now());
    };

    resize();
    if (!reduced) frame = requestAnimationFrame(render);

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    if (observer) observer.observe(canvas);
    else window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('h-16 w-3/4 text-white', className)}
    />
  );
}
