import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TRANSFORMERS_ORT_VERSION } from '#/lib/speech-to-text/constants';

describe('TRANSFORMERS_ORT_VERSION', () => {
  it('matches the onnxruntime-web Transformers.js depends on', () => {
    // Read off disk because the package's exports don't include its manifest.
    // Out of date, the models-cache sweep would take the runtime Transformers.js
    // actually loads for an old one, and delete it on every visit.
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'node_modules/@huggingface/transformers/package.json',
        ),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };

    expect(TRANSFORMERS_ORT_VERSION).toBe(
      manifest.dependencies['onnxruntime-web'],
    );
  });
});
