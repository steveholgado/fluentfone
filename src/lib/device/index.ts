/**
 * What this device can actually run, asked before anything is downloaded.
 *
 * The check stage uses this to refuse a multi-gigabyte download on a device
 * that could never run the model it belongs to — the failure mode this exists
 * to prevent is Safari fetching 2 GB of Gemma and only then throwing on
 * `navigator.gpu.requestAdapter`. The same answer is meant to serve the home
 * screen, so nothing here touches preload state or the service worker.
 *
 * Adding a requirement means adding an entry to REQUIREMENTS and widening
 * RequirementId. Nothing else changes: callers read `supported` and `unmet`,
 * neither of which names a specific capability.
 */

export type RequirementId = 'webgpu';

export interface Requirement {
  id: RequirementId;
  /** Names the missing capability to the user. */
  label: string;
  /** Whether `supported` is false without it, as opposed to merely degraded. */
  required: boolean;
  /**
   * Async so a later requirement can do real work — request an adapter, call
   * `navigator.storage.estimate()` — without changing every caller. A check
   * that throws counts as unmet.
   */
  check: () => boolean | Promise<boolean>;
}

export type RequirementResult = Omit<Requirement, 'check'> & { met: boolean };

export interface DeviceSupport {
  /** True when every `required` requirement is met. */
  supported: boolean;
  results: RequirementResult[];
  /** The subset that failed, required or not — what the UI lists. */
  unmet: RequirementResult[];
}

/**
 * Whether the browser exposes WebGPU at all.
 *
 * Presence only. Requesting an adapter would be the stronger test, but it costs
 * a GPU handshake and every caller here runs before the user has agreed to
 * anything. Absence is the case worth catching and it is unambiguous.
 *
 * Safari is where this bites, and not because Safari lacks WebGPU — it shipped
 * in Safari 26. It's gated on the OS: on by default only on macOS Tahoe 26+ and
 * iOS 26+, so Safari on Sequoia or Sonoma has no `navigator.gpu` whatever its
 * version (WebKit #299237).
 */
export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

const REQUIREMENTS: Requirement[] = [
  // Chat runs Gemma 4 through LiteRT-LM, which is WebGPU-only — the
  // GPU-compiled model has no CPU path to fall back to.
  {
    id: 'webgpu',
    label: 'WebGPU',
    required: true,
    check: hasWebGpu,
  },
];

/** Runs every requirement. Never throws: a check that does counts as unmet. */
export async function checkDeviceSupport(): Promise<DeviceSupport> {
  const results = await Promise.all(
    REQUIREMENTS.map(async ({ check, ...requirement }) => {
      let met = false;
      try {
        met = await check();
      } catch (err) {
        console.warn(
          `Device check "${requirement.id}" failed (treating as unmet):`,
          err,
        );
      }
      return { ...requirement, met };
    }),
  );

  return {
    supported: results.every((r) => r.met || !r.required),
    results,
    unmet: results.filter((r) => !r.met),
  };
}
