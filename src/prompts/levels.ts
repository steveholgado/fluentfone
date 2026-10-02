/**
 * What the model may use at each CEFR level, following the Instituto
 * Cervantes curriculum (Plan Curricular). Phrased as what to use rather than
 * what to avoid wherever possible — small models follow "do" far more reliably
 * than "don't", so `avoid` is kept for what the other lines don't already rule
 * out.
 */

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2';

interface LevelSpec {
  label: string;
  grammar: string;
  vocab: string;
  length: string;
  questionStyle: string;
  avoid?: string;
}

export const LEVELS = {
  A1: {
    label: 'beginner',
    grammar:
      'Use the present tense only. Stick to ser, estar, tener, hay, gustar, llamarse, ir, querer, poder, and regular -ar/-er/-ir verbs. Ask questions with qué, dónde, cómo, cuántos, quién, and cuándo.',
    vocab:
      'Only the most common everyday words: names, age, family, house, food and drink, colours, numbers, days of the week, weather, places in town.',
    length: 'Maximum 8 words per sentence.',
    questionStyle:
      'Ask simple questions that can be answered with one or two words, with sí or no, or by choosing between two options.',
    avoid:
      'Do not use the subjunctive. Do not use direct object pronouns (lo, la, los, las).',
  },

  A2: {
    label: 'elementary',
    grammar:
      "Use the present tense, 'ir a + infinitive' for plans, the present perfect (he comido) for today and recent events, and the preterite (fui, comí) for finished past events. Use the imperfect only for simple descriptions and habits (era, había, tenía). Reflexive verbs, comparatives with más/menos que, and me gustaría are fine.",
    vocab:
      'Everyday topics: daily routine, shopping, food, travel and holidays, the weekend, work and studies, health, directions, describing people and places.',
    length: 'Maximum 12 words per sentence.',
    questionStyle:
      'Ask about habits, plans, or something your friend did recently.',
    avoid:
      'Do not use the subjunctive. Do not use idioms. Do not use the imperfect to tell stories.',
  },

  B1: {
    label: 'intermediate',
    grammar:
      'Contrast the imperfect and the preterite when telling a story, and use the pluperfect for events before them. Use the present perfect, the simple future, the conditional, and the present subjunctive after expressions like espero que, quiero que, es importante que, and cuando. Use por and para correctly.',
    vocab:
      'Opinions, feelings, past experiences, future plans, city life, media and technology, problems and complaints, work.',
    length: 'Maximum 20 words per sentence.',
    questionStyle:
      "Ask for an opinion, a comparison, or a short story from your friend's own experience.",
    avoid:
      'Do not use the imperfect subjunctive. Do not use regional slang. Only use very common idioms.',
  },

  B2: {
    label: 'upper intermediate',
    grammar:
      'Speak naturally. Use the imperfect subjunctive and conditional clauses (si tuviera, habría hecho), the pluperfect, impersonal se, the passive, and connectors like sin embargo, aunque, a pesar de que, and por lo tanto.',
    vocab:
      'Abstract and current topics: work culture, the environment, education, politics in general terms, cultural differences, hypotheticals. Common idioms are welcome.',
    length: 'Maximum 25 words per sentence.',
    questionStyle:
      'Ask an open question that invites your friend to argue a point, speculate, or weigh two options.',
  },
} satisfies Record<CefrLevel, LevelSpec>;

/** The level section of a system instruction. */
export function renderLevelBlock(level: CefrLevel): string {
  const spec: LevelSpec = LEVELS[level];

  const lines = [
    `Spanish level: ${level} (${spec.label})`,
    `- Grammar: ${spec.grammar}`,
    `- Vocabulary: ${spec.vocab}`,
    `- Length: ${spec.length}`,
    `- Questions: ${spec.questionStyle}`,
  ];
  if (spec.avoid) lines.push(`- Avoid: ${spec.avoid}`);

  return lines.join('\n');
}
