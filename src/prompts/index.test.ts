import { describe, expect, it } from 'vitest';

import type { LanguageId } from '#/config';
import {
  buildSystemInstruction,
  LANGUAGE_SPECS,
  LEVELS,
  renderLanguageBlock,
  renderLevelBlock,
  type CefrLevel,
} from '#/prompts';

const ALL_LEVELS = Object.keys(LEVELS) as CefrLevel[];
const ALL_LANGUAGES = Object.keys(LANGUAGE_SPECS) as LanguageId[];

describe('renderLevelBlock', () => {
  it.each(ALL_LEVELS)('renders every line for %s', (level) => {
    const block = renderLevelBlock(level);

    expect(block).toContain(`Student level: ${level} (${LEVELS[level].label})`);
    expect(block).toContain(`- Grammar: ${LEVELS[level].grammar}`);
    expect(block).toContain(`- Vocabulary: ${LEVELS[level].vocab}`);
    expect(block).toContain(`- Length: ${LEVELS[level].length}`);
    expect(block).toContain(`- Questions: ${LEVELS[level].questionStyle}`);
  });

  it('includes the avoid line only for levels that have one', () => {
    expect(renderLevelBlock('A1')).toContain('- Avoid:');
    expect(renderLevelBlock('B2')).not.toContain('- Avoid:');
  });
});

describe('renderLanguageBlock', () => {
  it.each(ALL_LANGUAGES)("speaks %s's Spanish, using tú", (language) => {
    const block = renderLanguageBlock(language);

    expect(block).toContain(
      `Spanish as spoken in ${LANGUAGE_SPECS[language].country}`,
    );
    expect(block).toContain('Address the student as tú.');
  });

  it('includes extra rules only for languages that have them', () => {
    expect(renderLanguageBlock('es-MX')).toContain('never vosotros');
    expect(renderLanguageBlock('es-ES')).not.toContain('vosotros');
  });
});

describe('buildSystemInstruction', () => {
  it('includes the level block', () => {
    expect(buildSystemInstruction('B1', 'es-ES')).toContain(
      renderLevelBlock('B1'),
    );
  });

  it.each(ALL_LANGUAGES)(
    'includes the language block, and a partner from there, for %s',
    (language) => {
      const instruction = buildSystemInstruction('B1', language);

      expect(instruction).toContain(renderLanguageBlock(language));
      expect(instruction).toContain(
        `native speaker from ${LANGUAGE_SPECS[language].country}`,
      );
    },
  );

  // The chat worker reuses a conversation only when the instruction matches
  // exactly, so anything random in it would rebuild the conversation per turn.
  it('is identical every time it is built', () => {
    expect(buildSystemInstruction('A2', 'es-MX')).toBe(
      buildSystemInstruction('A2', 'es-MX'),
    );
  });
});
