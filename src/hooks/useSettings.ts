import { useCallback, useState } from 'react';

import {
  DEFAULT_LANGUAGE,
  DEFAULT_LEVEL,
  DEFAULT_SPEED,
  LANGUAGES,
  SPEEDS,
  type LanguageId,
  type Speed,
} from '#/config';
import { LEVELS, type CefrLevel } from '#/prompts';

const STORAGE_KEY = 'settings';

interface Settings {
  language: LanguageId;
  level: CefrLevel;
  speed: Speed;
}

function isLanguage(value: unknown): value is LanguageId {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value);
}

function isLevel(value: unknown): value is CefrLevel {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

function isSpeed(value: unknown): value is Speed {
  return SPEEDS.some((speed) => speed.value === value);
}

/**
 * What was saved last time, with anything missing or no longer on offer — a
 * language, level or speed since removed, say — falling back to its default.
 * Storage can be unavailable altogether (blocked, or a private window in some
 * browsers), which just means the defaults.
 */
function load(): Settings {
  let saved: Partial<Record<keyof Settings, unknown>> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw) ?? {};
  } catch {
    // Unreadable or unparseable: start from the defaults.
  }

  const language = isLanguage(saved.language)
    ? saved.language
    : DEFAULT_LANGUAGE;
  const level = isLevel(saved.level) ? saved.level : DEFAULT_LEVEL;
  const speed = isSpeed(saved.speed) ? saved.speed : DEFAULT_SPEED[level];
  return { language, level, speed };
}

/**
 * Only written when the user changes something, so a later change to the
 * defaults still reaches anyone who never did.
 */
function save(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The choice still holds for this visit; it just won't be remembered.
  }
}

/** The user's language, level and speed, remembered between visits. */
export function useSettings() {
  const [settings, setSettings] = useState(load);

  const update = useCallback((next: Settings) => {
    setSettings(next);
    save(next);
  }, []);

  /**
   * Also resets the speed, to where the new level starts. The current level
   * is left alone, speed included. The language is kept either way.
   */
  const setLevel = useCallback(
    (level: CefrLevel) => {
      if (level === settings.level) return;
      update({ ...settings, level, speed: DEFAULT_SPEED[level] });
    },
    [settings, update],
  );

  /** Level and speed are kept: they don't depend on the language. */
  const setLanguage = useCallback(
    (language: LanguageId) => {
      if (language === settings.language) return;
      update({ ...settings, language });
    },
    [settings, update],
  );

  const setSpeed = useCallback(
    (speed: Speed) => update({ ...settings, speed }),
    [settings, update],
  );

  return { ...settings, setLanguage, setLevel, setSpeed };
}
