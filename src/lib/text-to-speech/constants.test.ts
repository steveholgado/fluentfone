import { describe, expect, it } from 'vitest';

import {
  VOICE_REVISION,
  VOICES,
  voiceUrls,
} from '#/lib/text-to-speech/constants';

const BASE = `https://huggingface.co/diffusionstudio/piper-voices/resolve/${VOICE_REVISION}/`;

describe('voiceUrls', () => {
  it('files a voice under its language, locale, name and quality', () => {
    expect(voiceUrls('es_ES-davefx-medium')).toEqual({
      model: `${BASE}es/es_ES/davefx/medium/es_ES-davefx-medium.onnx`,
      config: `${BASE}es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json`,
    });
  });

  it('keeps an underscore in the name', () => {
    expect(voiceUrls('en_US-hfc_female-medium').model).toBe(
      `${BASE}en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx`,
    );
  });

  it('downloads every voice on offer from the pinned commit', () => {
    // Off `main`, the sweep would delete the voice on every visit.
    for (const voiceId of Object.values(VOICES).flat()) {
      const { model, config } = voiceUrls(voiceId);
      expect(model.startsWith(BASE)).toBe(true);
      expect(config.startsWith(BASE)).toBe(true);
    }
  });

  it.each(['es_ES-davefx', 'es_ES-davefx-medium-extra', ''])(
    'refuses %j, which is not a Piper voice ID',
    (voiceId) => {
      expect(() => voiceUrls(voiceId)).toThrow('Not a Piper voice ID');
    },
  );
});
