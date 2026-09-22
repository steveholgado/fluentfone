import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Waveform } from '#/components/Waveform';

afterEach(cleanup);

describe('Waveform', () => {
  // jsdom has no 2d context and no AudioContext, so these cover the guards
  // that keep the component inert rather than the drawing itself.
  it('renders a canvas that is hidden from assistive tech', () => {
    const { container } = render(<Waveform />);

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
  });

  it('survives a mount and unmount without a drawing context', () => {
    const { unmount } = render(<Waveform />);

    expect(() => unmount()).not.toThrow();
  });
});
