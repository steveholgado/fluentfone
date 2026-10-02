import { describe, expect, it } from 'vitest';

import type { LanguageId } from '#/config';
import {
  buildSystemInstruction,
  greetingTrigger,
  LANGUAGE_SPECS,
  LEVELS,
  renderLanguageBlock,
  renderLevelBlock,
  SCENARIOS,
  type CefrLevel,
} from '#/prompts';

const ALL_LEVELS = Object.keys(LEVELS) as CefrLevel[];
const ALL_LANGUAGES = Object.keys(LANGUAGE_SPECS) as LanguageId[];

describe('renderLevelBlock', () => {
  it.each(ALL_LEVELS)('renders every line for %s', (level) => {
    const block = renderLevelBlock(level);

    expect(block).toContain(`Spanish level: ${level} (${LEVELS[level].label})`);
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
    expect(block).toContain(
      'Address your friend as tú, without a name or nickname.',
    );
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

describe('greetingTrigger', () => {
  it('gives the reason for the call, bracketed as a direction', () => {
    const trigger = greetingTrigger({
      id: 'test',
      reason: 'I have a new cat.',
    });

    expect(trigger).toMatch(/^\[.*\]$/);
    expect(trigger).toContain('"I\'m calling because I have a new cat."');
  });
});

describe('SCENARIOS', () => {
  it.each(ALL_LEVELS)('has some for %s', (level) => {
    expect(Object.keys(SCENARIOS[level]).length).toBeGreaterThan(0);
  });

  // Ids are what usage tracking stores. Within a level, the compiler already
  // rejects a repeated key.
  it('never uses an id twice, across all levels', () => {
    const ids = ALL_LEVELS.flatMap((level) => Object.keys(SCENARIOS[level]));

    expect(new Set(ids).size).toBe(ids.length);
  });

  // Each one finishes "I'm calling because …" in the trigger, which carries
  // on after it.
  it.each(ALL_LEVELS)('has reasons that end a sentence, for %s', (level) => {
    for (const reason of Object.values(SCENARIOS[level])) {
      expect(reason).toMatch(/^(I\b|[a-z]).*\.$/);
    }
  });
});
