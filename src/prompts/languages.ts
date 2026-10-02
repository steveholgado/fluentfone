/**
 * Which Spanish the model speaks. Like the level lines, extra rules are
 * phrased as what to use: small models follow "do" far more reliably than
 * "don't".
 */

import type { LanguageId } from '#/config';

interface LanguageSpec {
  /** Where the partner is from, and whose Spanish they speak. */
  country: string;
  /** Rules beyond speaking that country's Spanish. */
  rules?: string[];
}

export const LANGUAGE_SPECS = {
  'es-ES': {
    country: 'Spain',
  },

  'es-MX': {
    country: 'Mexico',
    rules: ['Use ustedes for more than one person, never vosotros.'],
  },
} satisfies Record<LanguageId, LanguageSpec>;

/** The language section of a system instruction. */
export function renderLanguageBlock(language: LanguageId): string {
  const spec: LanguageSpec = LANGUAGE_SPECS[language];

  const lines = [
    'Language:',
    `- Always reply in Spanish as spoken in ${spec.country}, even if your friend speaks English.`,
    '- Address your friend as tú, without a name or nickname.',
    ...(spec.rules ?? []).map((rule) => `- ${rule}`),
  ];

  return lines.join('\n');
}
