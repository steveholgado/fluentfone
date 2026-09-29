import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationScreen } from '#/components/ConversationScreen';

// Testing Library only registers its own afterEach cleanup when Vitest runs
// with `globals: true`, which this project doesn't — without this, each
// render stacks on the last and queries match the previous test's DOM.
afterEach(cleanup);

const BASE = {
  isRecording: false,
  isAudioLive: false,
  hasGreeted: false,
  isGreetingReady: false,
  canRepeat: false,
  status: '',
  onAnswer: () => {},
  onToggleRecording: () => {},
  onRepeat: () => {},
  onRepeatSlowly: () => {},
};

describe('ConversationScreen', () => {
  it('says Connecting before any stage has been reported', () => {
    render(<ConversationScreen {...BASE} />);

    expect(screen.getByText('Connecting')).toBeInTheDocument();
  });

  it('shows what the engine is doing while the call connects', () => {
    // The status used to be rendered only after the greeting, so the whole
    // compile-and-generate wait showed as an unchanging 'Connecting' with no
    // sign of what was happening.
    render(<ConversationScreen {...BASE} status="Warming up…" />);

    expect(screen.getByText('Warming up…')).toBeInTheDocument();
    expect(screen.queryByText('Connecting')).not.toBeInTheDocument();
  });

  it('surfaces a failure instead of waiting on Connecting forever', () => {
    render(<ConversationScreen {...BASE} status="Something went wrong" />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('announces the call once the greeting is ready, whatever the status', () => {
    render(
      <ConversationScreen {...BASE} isGreetingReady status="Warming up…" />,
    );

    expect(screen.getByText('Incoming call')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled();
  });

  it('keeps the Answer button disabled until the greeting is ready', () => {
    render(<ConversationScreen {...BASE} status="Generating…" />);

    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled();
  });

  it('shows the status and the record button once greeting is done', () => {
    render(<ConversationScreen {...BASE} hasGreeted status="Speaking…" />);

    expect(screen.getByText('Speaking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('gives the status line over to the waveform while audio is live', () => {
    const { container } = render(
      <ConversationScreen
        {...BASE}
        hasGreeted
        isAudioLive
        status="Speaking…"
      />,
    );

    expect(container.querySelector('canvas')).toBeInTheDocument();
    // Still announced, just no longer the visible element.
    expect(screen.getByText('Speaking…')).toHaveClass('sr-only');
  });

  describe('repeat buttons', () => {
    it('take the status line once the agent has finished speaking', () => {
      render(<ConversationScreen {...BASE} hasGreeted canRepeat />);

      expect(
        screen.getByRole('button', { name: 'Repeat' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Repeat slowly' }),
      ).toBeInTheDocument();
    });

    it('are hidden when there is nothing to repeat', () => {
      render(<ConversationScreen {...BASE} hasGreeted status="Generating…" />);

      expect(screen.getByText('Generating…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Repeat/ })).toBeNull();
    });

    it('are hidden while audio is live', () => {
      render(<ConversationScreen {...BASE} hasGreeted canRepeat isAudioLive />);

      expect(screen.queryByRole('button', { name: /Repeat/ })).toBeNull();
    });

    it('give way to a status, such as a failed repeat', () => {
      render(
        <ConversationScreen
          {...BASE}
          hasGreeted
          canRepeat
          status="Something went wrong"
        />,
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Repeat/ })).toBeNull();
    });

    it('call their own handlers', () => {
      const onRepeat = vi.fn();
      const onRepeatSlowly = vi.fn();
      render(
        <ConversationScreen
          {...BASE}
          hasGreeted
          canRepeat
          onRepeat={onRepeat}
          onRepeatSlowly={onRepeatSlowly}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
      expect(onRepeat).toHaveBeenCalledTimes(1);
      expect(onRepeatSlowly).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Repeat slowly' }));
      expect(onRepeatSlowly).toHaveBeenCalledTimes(1);
    });
  });
});
