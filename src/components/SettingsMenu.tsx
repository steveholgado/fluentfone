import { useId, useRef } from 'react';

import { SPEEDS, type Speed } from '#/config';
import { LEVELS, type CefrLevel } from '#/prompts';
import { cn } from '#/utils/cn';

interface SettingsMenuProps {
  level: CefrLevel;
  speed: Speed;
  onLevelChange: (level: CefrLevel) => void;
  onSpeedChange: (speed: Speed) => void;
}

const LEVEL_ORDER = Object.keys(LEVELS) as CefrLevel[];

const OPTION_CLASS =
  'cursor-pointer rounded-lg bg-gray-200 px-4 py-1.5 text-base text-black hover:bg-gray-300 aria-pressed:bg-gray-300';

/**
 * The learner's settings, behind a button. A native popover, so it closes on
 * Escape or a click elsewhere without any code here to do it; making a choice
 * closes it too.
 */
export function SettingsMenu({
  level,
  speed,
  onLevelChange,
  onSpeedChange,
}: SettingsMenuProps) {
  const panelId = useId();
  const levelHeadingId = useId();
  const speedHeadingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Choosing what's already chosen does nothing, and leaves the menu open.
  function select<T>(option: T, current: T, onChange: (option: T) => void) {
    if (option === current) return;
    onChange(option);
    panelRef.current?.hidePopover();
  }

  return (
    <>
      <button
        popoverTarget={panelId}
        className="cursor-pointer rounded-lg bg-gray-200 px-4 py-1.5 text-base text-black hover:bg-gray-300"
      >
        Settings
      </button>

      {/* The UA stylesheet centres a popover in the viewport; this puts it
          under the button instead. */}
      <div
        ref={panelRef}
        id={panelId}
        popover="auto"
        className="inset-auto top-16 right-4 m-0 w-72 rounded-lg bg-gray-100 p-8 text-black"
      >
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-2">
            <h2 id={levelHeadingId} className="text-sm">
              Level
            </h2>
            <div
              role="group"
              aria-labelledby={levelHeadingId}
              className="flex flex-col gap-2"
            >
              {LEVEL_ORDER.map((option) => (
                <button
                  key={option}
                  aria-pressed={option === level}
                  onClick={() => select(option, level, onLevelChange)}
                  className={OPTION_CLASS}
                >
                  <span className="block">{option}</span>
                  <span className="block text-xs capitalize opacity-70">
                    {LEVELS[option].label}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs">Changing level starts a new call</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 id={speedHeadingId} className="text-sm">
              Speed
            </h2>
            <div
              role="group"
              aria-labelledby={speedHeadingId}
              className="flex flex-col gap-2"
            >
              {SPEEDS.map((option) => (
                <button
                  key={option.value}
                  aria-pressed={option.value === speed}
                  onClick={() => select(option.value, speed, onSpeedChange)}
                  className={cn(OPTION_CLASS, 'text-center')}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
