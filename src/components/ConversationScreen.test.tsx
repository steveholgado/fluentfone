import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationScreen } from '#/components/ConversationScreen';

// Testing Library only registers its own afterEach cleanup when Vitest runs
// with `globals: true`, which this project doesn't — without this, each
// render stacks on the last and queries match the previous test's DOM.
afterEach(cleanup);

const BASE = {
  isRecording: false,
  isBusy: false,
  isAudioLive: false,
  hasGreeted: false,
  isGreetingReady: false,
  canRepeat: false,
  hasEnded: false,
  status: '',
  onAnswer: () => {},
  onToggleRecording: () => {},
  onRepeat: () => {},
  onShowText: () => {},
  onCallAgain: () => {},
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

  it('disables the record button while a turn is in flight', () => {
    const { rerender } = render(
      <ConversationScreen {...BASE} hasGreeted isBusy status="Generating…" />,
    );

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

    rerender(<ConversationScreen {...BASE} hasGreeted />);

    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
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

  it("gives the waveform's place to the text while a line is repeated with it", () => {
    const { container } = render(
      <ConversationScreen
        {...BASE}
        hasGreeted
        isAudioLive
        transcript="¡Hola! ¿Qué tal?"
        status="Speaking…"
      />,
    );

    expect(screen.getByText('¡Hola! ¿Qué tal?')).toBeInTheDocument();
    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.getByText('Speaking…')).toHaveClass('sr-only');
  });

  it('keeps the text up in place of the repeat buttons once the audio has stopped', () => {
    render(
      <ConversationScreen
        {...BASE}
        hasGreeted
        canRepeat
        transcript="¡Hola! ¿Qué tal?"
      />,
    );

    expect(screen.getByText('¡Hola! ¿Qué tal?')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Repeat|Read along/ }),
    ).toBeNull();
  });

  describe('repeat buttons', () => {
    it('take the status line once the agent has finished speaking', () => {
      render(<ConversationScreen {...BASE} hasGreeted canRepeat />);

      expect(
        screen.getByRole('button', { name: 'Repeat' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Read along' }),
      ).toBeInTheDocument();
    });

    it('are hidden when there is nothing to repeat', () => {
      render(<ConversationScreen {...BASE} hasGreeted status="Generating…" />);

      expect(screen.getByText('Generating…')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Repeat|Read along/ }),
      ).toBeNull();
    });

    it('are hidden while audio is live', () => {
      render(<ConversationScreen {...BASE} hasGreeted canRepeat isAudioLive />);

      expect(
        screen.queryByRole('button', { name: /Repeat|Read along/ }),
      ).toBeNull();
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
      expect(
        screen.queryByRole('button', { name: /Repeat|Read along/ }),
      ).toBeNull();
    });

    it('call their own handlers', () => {
      const onRepeat = vi.fn();
      const onShowText = vi.fn();
      render(
        <ConversationScreen
          {...BASE}
          hasGreeted
          canRepeat
          onRepeat={onRepeat}
          onShowText={onShowText}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
      expect(onRepeat).toHaveBeenCalledTimes(1);
      expect(onShowText).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Read along' }));
      expect(onShowText).toHaveBeenCalledTimes(1);
    });
  });

  describe('once the call has ended', () => {
    it('says so, and offers Call again in place of the record button', () => {
      render(<ConversationScreen {...BASE} hasGreeted canRepeat hasEnded />);

      expect(screen.getByText('Call ended')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Call again' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    });

    it('still lets the goodbye be repeated', () => {
      render(<ConversationScreen {...BASE} hasGreeted canRepeat hasEnded />);

      expect(
        screen.getByRole('button', { name: 'Repeat' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Read along' }),
      ).toBeInTheDocument();
    });

    it('calls onCallAgain', () => {
      const onCallAgain = vi.fn();
      render(
        <ConversationScreen
          {...BASE}
          hasGreeted
          canRepeat
          hasEnded
          onCallAgain={onCallAgain}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Call again' }));

      expect(onCallAgain).toHaveBeenCalledOnce();
    });

    it('gives way to the waveform while the goodbye is repeated', () => {
      render(
        <ConversationScreen
          {...BASE}
          hasGreeted
          canRepeat
          hasEnded
          isAudioLive
        />,
      );

      expect(screen.queryByText('Call ended')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Call again' }),
      ).toBeInTheDocument();
    });
  });
});
