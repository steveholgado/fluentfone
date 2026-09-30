import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettings } from '#/hooks/useSettings';
import { DEFAULT_LEVEL, DEFAULT_SPEED } from '#/config';

const STORAGE_KEY = 'settings';

function stored() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSettings', () => {
  it('starts from the default level, at its default speed', () => {
    const { result } = renderHook(() => useSettings());

    expect(result.current.level).toBe(DEFAULT_LEVEL);
    expect(result.current.speed).toBe(DEFAULT_SPEED[DEFAULT_LEVEL]);
  });

  it('saves nothing until something is changed', () => {
    renderHook(() => useSettings());

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('remembers a change for next time', () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setLevel('A2'));
    act(() => result.current.setSpeed(1));

    const { result: next } = renderHook(() => useSettings());

    expect(next.current.level).toBe('A2');
    expect(next.current.speed).toBe(1);
    expect(stored()).toEqual({ level: 'A2', speed: 1 });
  });

  it('resets the speed to the new level’s own when the level changes', () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setSpeed(0.85));
    act(() => result.current.setLevel('A1'));

    expect(result.current.level).toBe('A1');
    expect(result.current.speed).toBe(DEFAULT_SPEED.A1);
  });

  it('keeps the level when only the speed changes', () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.setLevel('B2'));
    act(() => result.current.setSpeed(0.7));

    expect(result.current.level).toBe('B2');
    expect(result.current.speed).toBe(0.7);
  });

  it('falls back to the defaults for anything saved that is no longer on offer', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ level: 'C2', speed: 0.5 }),
    );

    const { result } = renderHook(() => useSettings());

    expect(result.current.level).toBe(DEFAULT_LEVEL);
    expect(result.current.speed).toBe(DEFAULT_SPEED[DEFAULT_LEVEL]);
  });

  it('keeps a saved level whose speed is no longer on offer, at its default speed', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ level: 'A1', speed: 0.5 }),
    );

    const { result } = renderHook(() => useSettings());

    expect(result.current.level).toBe('A1');
    expect(result.current.speed).toBe(DEFAULT_SPEED.A1);
  });

  it.each(['not json', 'null', '42', '"A1"', '[]'])(
    'falls back to the defaults for a saved value of %s',
    (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);

      const { result } = renderHook(() => useSettings());

      expect(result.current.level).toBe(DEFAULT_LEVEL);
      expect(result.current.speed).toBe(DEFAULT_SPEED[DEFAULT_LEVEL]);
    },
  );

  it('ignores a saved key that only exists on the prototype', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ level: 'toString', speed: 1 }),
    );

    const { result } = renderHook(() => useSettings());

    expect(result.current.level).toBe(DEFAULT_LEVEL);
  });

  it('uses the defaults when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const { result } = renderHook(() => useSettings());

    expect(result.current.level).toBe(DEFAULT_LEVEL);
  });

  it('still applies a change when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const { result } = renderHook(() => useSettings());
    act(() => result.current.setLevel('A1'));

    expect(result.current.level).toBe('A1');
  });
});
