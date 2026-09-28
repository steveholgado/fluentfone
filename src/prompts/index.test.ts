import { describe, expect, it } from 'vitest';

import {
  buildSystemInstruction,
  LEVELS,
  renderLevelBlock,
  type CefrLevel,
} from '#/prompts';

const ALL_LEVELS = Object.keys(LEVELS) as CefrLevel[];

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

describe('buildSystemInstruction', () => {
  it('includes the level block', () => {
    expect(buildSystemInstruction('B1')).toContain(renderLevelBlock('B1'));
  });

  // The chat worker reuses a conversation only when the instruction matches
  // exactly, so anything random in it would rebuild the conversation per turn.
  it('is identical every time it is built', () => {
    expect(buildSystemInstruction('A2')).toBe(buildSystemInstruction('A2'));
  });
});
