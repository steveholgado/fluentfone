/**
 * Which language the model speaks, and whose version of it. Like the level
 * lines, extra rules are phrased as what to use: small models follow "do" far
 * more reliably than "don't".
 */

import type { LanguageId } from '#/config';

interface LanguageSpec {
  /** The language, in English, as the prompts name it. */
  name: string;
  /** Where the partner is from, and whose version of the language they speak. */
  country: string;
  /** Rules beyond speaking that country's version of the language. */
  rules?: string[];
}

export const LANGUAGE_SPECS = {
  'es-ES': {
    name: 'Spanish',
    country: 'Spain',
  },

  'es-MX': {
    name: 'Spanish',
    country: 'Mexico',
    rules: ['Use ustedes for more than one person, never vosotros.'],
  },
} satisfies Record<LanguageId, LanguageSpec>;

/** The language section of a system instruction. */
export function renderLanguageBlock(language: LanguageId): string {
  const spec: LanguageSpec = LANGUAGE_SPECS[language];

  const lines = [
    'Language:',
    `- Always reply in ${spec.name} as spoken in ${spec.country}, even if your friend speaks English.`,
    '- Address your friend without a name or nickname.',
    ...(spec.rules ?? []).map((rule) => `- ${rule}`),
  ];

  return lines.join('\n');
}
