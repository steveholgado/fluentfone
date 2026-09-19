import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationScreen } from '#/components/ConversationScreen';

// Testing Library only registers its own afterEach cleanup when Vitest runs
// with `globals: true`, which this project doesn't — without this, each
// render stacks on the last and queries match the previous test's DOM.
afterEach(cleanup);

const BASE = {
  isRecording: false,
  hasGreeted: false,
  isGreetingReady: false,
  status: '',
  onAnswer: () => {},
  onToggleRecording: () => {},
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
});
