import { describe, expect, it } from 'vitest';

import {
  buildConversationInstruction,
  buildGreetingInstruction,
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

describe('system instructions', () => {
  it('asks for a greeting only in the greeting instruction', () => {
    const greeting = buildGreetingInstruction('A2');
    const conversation = buildConversationInstruction('A2');

    expect(greeting).toContain('This is the start of the conversation.');
    expect(greeting).not.toContain('Do not greet the student again.');
    expect(conversation).toContain('Do not greet the student again.');
    expect(conversation).not.toContain(
      'This is the start of the conversation.',
    );
  });

  it('includes the level block in both', () => {
    const block = renderLevelBlock('B1');

    expect(buildGreetingInstruction('B1')).toContain(block);
    expect(buildConversationInstruction('B1')).toContain(block);
  });

  // The chat worker reuses a conversation only when the instruction matches
  // exactly, so anything random in it would rebuild the conversation per turn.
  it('is identical every time it is built', () => {
    expect(buildGreetingInstruction('A2')).toBe(buildGreetingInstruction('A2'));
    expect(buildConversationInstruction('A2')).toBe(
      buildConversationInstruction('A2'),
    );
  });
});
