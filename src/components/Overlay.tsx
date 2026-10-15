import { useState } from 'react';

import { cn } from '#/utils/cn';

interface OverlayProps {
  visible: boolean;
  children: React.ReactNode;
}

export function Overlay({ visible, children }: OverlayProps) {
  const [shouldRender, setShouldRender] = useState(visible);

  // Set during render rather than in an effect, so it shows on the same render
  // that `visible` turns true instead of one after.
  if (visible && !shouldRender) setShouldRender(true);

  if (!shouldRender) return null;

  return (
    <div className="absolute inset-0 h-full w-full">
      <div
        className={cn(
          'absolute inset-0 bg-neutral-800/90',
          !visible && 'animate-fade-out [animation-delay:300ms]',
        )}
        onAnimationEnd={() => {
          if (!visible) setShouldRender(false);
        }}
      />

      <div
        className={cn(
          'absolute right-4 bottom-4 left-4 mx-auto flex max-w-md flex-col gap-4 rounded-4xl bg-white p-8 text-black',
          visible ? 'animate-scale-in' : 'animate-scale-out',
        )}
      >
        {children}
      </div>
    </div>
  );
}
