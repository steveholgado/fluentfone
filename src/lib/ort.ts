/**
 * The one onnxruntime-web build the app runs: Transformers.js uses it for
 * speech-to-text, and our Piper wrapper for text-to-speech.
 *
 * Transformers.js hard-pins its onnxruntime-web, so this has to be that
 * version, and the app's own dependency has to match it, or pnpm installs a
 * second copy. ort.test.ts checks both against what is installed, so a
 * Transformers.js bump that moves the pin fails there until all three agree.
 *
 * Both runtimes are versioned by it: the copy vendored for text-to-speech under
 * `/vendor/onnx/<version>/`, and the one Transformers.js fetches from jsDelivr
 * for itself, which the models-cache sweep has to tell apart from one an older
 * version left behind.
 *
 * Written out because the package doesn't export its package.json.
 */
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
