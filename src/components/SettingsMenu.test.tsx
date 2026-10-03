import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsMenu } from '#/components/SettingsMenu';
import { SPEEDS, type Speed } from '#/config';

// See ConversationScreen.test.tsx: no globals, so no automatic cleanup.
afterEach(cleanup);

// jsdom has no hidePopover(), so it's stood in for here, which also shows
// which element it was called on.
const hidePopover = vi.fn();

beforeEach(() => {
  hidePopover.mockClear();
  HTMLElement.prototype.hidePopover = hidePopover;
});

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
});

function panel() {
  return screen
    .getByRole('group', { name: 'Level', hidden: true })
    .closest('[popover]');
}

// Speeds are looked up by the label on their button, so retuning them in
// config doesn't break these tests.
function speedOf(label: (typeof SPEEDS)[number]['label']): Speed {
  return SPEEDS.find((speed) => speed.label === label)!.value;
}

const BASE = {
  language: 'es-ES',
  level: 'B1',
  speed: speedOf('Natural'),
  onLanguageChange: () => {},
  onLevelChange: () => {},
  onSpeedChange: () => {},
} as const;

// jsdom hides a closed popover but can't open one — it has no showPopover(),
// and a popovertarget button does nothing — so what's inside the panel is
// queried with `hidden: true`. That the button opens the panel is left to the
// browser; the test here is only that the two are wired together.
function button(name: string | RegExp) {
  return screen.getByRole('button', { name, hidden: true });
}

describe('SettingsMenu', () => {
  it('opens its panel from the Settings button', () => {
    render(<SettingsMenu {...BASE} />);

    expect(panel()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'popovertarget',
      panel()!.id,
    );
  });

  it('marks the current level and speed as pressed', () => {
    render(<SettingsMenu {...BASE} level="A2" speed={speedOf('Relaxed')} />);

    expect(button(/^A2/)).toHaveAttribute('aria-pressed', 'true');
    expect(button(/^B1/)).toHaveAttribute('aria-pressed', 'false');
    expect(button('Relaxed')).toHaveAttribute('aria-pressed', 'true');
    expect(button('Natural')).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers every level, with what it means', () => {
    render(<SettingsMenu {...BASE} />);

    const group = screen.getByRole('group', { name: 'Level', hidden: true });
    const levels = within(group)
      .getAllByRole('button', { hidden: true })
      .map((level) => level.textContent);

    expect(levels).toEqual([
      'A1beginner',
      'A2elementary',
      'B1intermediate',
      'B2upper intermediate',
    ]);
  });

  it('offers every speed', () => {
    render(<SettingsMenu {...BASE} />);

    const group = screen.getByRole('group', { name: 'Speed', hidden: true });
    const speeds = within(group)
      .getAllByRole('button', { hidden: true })
      .map((speed) => speed.textContent);

    expect(speeds).toEqual(['Slow', 'Relaxed', 'Natural']);
  });

  it('reports the level chosen, and closes', () => {
    const onLevelChange = vi.fn();
    render(<SettingsMenu {...BASE} onLevelChange={onLevelChange} />);

    fireEvent.click(button(/^A1/));

    expect(onLevelChange).toHaveBeenCalledWith('A1');
    expect(hidePopover.mock.contexts).toEqual([panel()]);
  });

  it('reports the speed chosen, and closes', () => {
    const onSpeedChange = vi.fn();
    render(<SettingsMenu {...BASE} onSpeedChange={onSpeedChange} />);

    fireEvent.click(button('Slow'));

    expect(onSpeedChange).toHaveBeenCalledWith(speedOf('Slow'));
    expect(hidePopover.mock.contexts).toEqual([panel()]);
  });

  it('ignores the level and speed already chosen, and stays open', () => {
    const onLevelChange = vi.fn();
    const onSpeedChange = vi.fn();
    render(
      <SettingsMenu
        {...BASE}
        onLevelChange={onLevelChange}
        onSpeedChange={onSpeedChange}
      />,
    );

    fireEvent.click(button(/^B1/));
    fireEvent.click(button('Natural'));

    expect(onLevelChange).not.toHaveBeenCalled();
    expect(onSpeedChange).not.toHaveBeenCalled();
    expect(hidePopover).not.toHaveBeenCalled();
  });

  describe('language', () => {
    it('offers every language', () => {
      render(<SettingsMenu {...BASE} />);

      const group = screen.getByRole('group', {
        name: 'Language',
        hidden: true,
      });
      const languages = within(group)
        .getAllByRole('button', { hidden: true })
        .map((language) => language.textContent);

      expect(languages).toEqual(['Spanish (Spain)', 'Spanish (Mexico)']);
    });

    it('marks the current language as pressed', () => {
      render(<SettingsMenu {...BASE} language="es-MX" />);

      expect(button('Spanish (Mexico)')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(button('Spanish (Spain)')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('reports the language chosen, and closes', () => {
      const onLanguageChange = vi.fn();
      render(<SettingsMenu {...BASE} onLanguageChange={onLanguageChange} />);

      fireEvent.click(button('Spanish (Mexico)'));

      expect(onLanguageChange).toHaveBeenCalledWith('es-MX');
      expect(hidePopover.mock.contexts).toEqual([panel()]);
    });

    it('ignores the language already chosen, and stays open', () => {
      const onLanguageChange = vi.fn();
      render(<SettingsMenu {...BASE} onLanguageChange={onLanguageChange} />);

      fireEvent.click(button('Spanish (Spain)'));

      expect(onLanguageChange).not.toHaveBeenCalled();
      expect(hidePopover).not.toHaveBeenCalled();
    });

    it('warns that a new language means a new call', () => {
      render(<SettingsMenu {...BASE} />);

      expect(
        screen.getByText('Changing language starts a new call'),
      ).toBeInTheDocument();
    });
  });

  it('warns that a new level means a new call', () => {
    render(<SettingsMenu {...BASE} />);

    expect(
      screen.getByText('Changing level starts a new call'),
    ).toBeInTheDocument();
  });
});
