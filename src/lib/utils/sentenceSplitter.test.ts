import { describe, expect, it } from 'vitest';

import { createSentenceSplitter } from '#/lib/utils/sentenceSplitter';

/** Pushes `chunks` in order, then ends, and returns every sentence emitted. */
function split(...chunks: string[]): string[] {
  const sentences: string[] = [];
  const splitter = createSentenceSplitter((s) => sentences.push(s));
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return sentences;
}

describe('createSentenceSplitter', () => {
  it('splits a statement and a question', () => {
    expect(split('Me gusta el café. ¿Y a ti qué te gusta?')).toEqual([
      'Me gusta el café.',
      '¿Y a ti qué te gusta?',
    ]);
  });

  it('emits a sentence as soon as whitespace confirms its end', () => {
    const sentences: string[] = [];
    const splitter = createSentenceSplitter((s) => sentences.push(s));

    splitter.push('¡Qué bien');
    splitter.push('!');
    expect(sentences).toEqual([]);

    splitter.push(' ¿Dónde');
    expect(sentences).toEqual(['¡Qué bien!']);
  });

  it('joins sentences that arrive in pieces across chunks', () => {
    expect(split('Vivo en ', 'Madr', 'id. ¿Y ', 'tú?')).toEqual([
      'Vivo en Madrid.',
      '¿Y tú?',
    ]);
  });

  it('leaves the last sentence for end(), since nothing follows it', () => {
    const sentences: string[] = [];
    const splitter = createSentenceSplitter((s) => sentences.push(s));

    splitter.push('Hola. ¿Qué tal?');
    expect(sentences).toEqual(['Hola.']);

    splitter.end();
    expect(sentences).toEqual(['Hola.', '¿Qué tal?']);
  });

  it('keeps a decimal whole', () => {
    expect(split('Cuesta 3.5 euros. ¿Es caro?')).toEqual([
      'Cuesta 3.5 euros.',
      '¿Es caro?',
    ]);
  });

  it('keeps closing quotes and runs of punctuation with their sentence', () => {
    expect(split('Dijo «hola». ¿¡En serio?! Sí… Vale.')).toEqual([
      'Dijo «hola».',
      '¿¡En serio?!',
      'Sí…',
      'Vale.',
    ]);
  });

  it('flushes a reply with no final punctuation as one sentence', () => {
    expect(split('Hola amigo')).toEqual(['Hola amigo']);
  });

  it('emits nothing for whitespace alone', () => {
    expect(split('  ', '\n')).toEqual([]);
  });
});
