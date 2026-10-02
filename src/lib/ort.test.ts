import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ORT_VERSION } from '#/lib/ort';

/** Read off disk because the packages' exports don't include their manifests. */
function dependenciesOf(manifestPath: string): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), manifestPath), 'utf8'),
  ) as { dependencies: Record<string, string> };
  return manifest.dependencies;
}

describe('ORT_VERSION', () => {
  it('matches the onnxruntime-web Transformers.js depends on', () => {
    // Out of date, the models-cache sweep would take the runtime
    // Transformers.js actually loads for an old one, and delete it on every
    // visit.
    expect(
      dependenciesOf('node_modules/@huggingface/transformers/package.json')[
        'onnxruntime-web'
      ],
    ).toBe(ORT_VERSION);
  });

  it('matches the app’s own onnxruntime-web, so only one is installed', () => {
    expect(dependenciesOf('package.json')['onnxruntime-web']).toBe(ORT_VERSION);
  });
});
