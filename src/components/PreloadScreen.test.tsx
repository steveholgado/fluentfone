import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PreloadScreen } from '#/components/PreloadScreen';
import { EXPECTED_BYTES } from '#/lib/cache/rules';
import type { PreloadStatus } from '#/lib/preload';
import { formatBytes } from '#/utils/formatBytes';

// See ConversationScreen.test.tsx: no globals, so no automatic cleanup.
afterEach(cleanup);

function status(
  value: boolean,
  overrides: Partial<PreloadStatus> = {},
): PreloadStatus {
  return {
    'text-to-speech-runtime': value,
    'text-to-speech': value,
    'speech-to-text': value,
    'chat-runtime': value,
    chat: value,
    ...overrides,
  };
}

const BASE = {
  cached: status(false),
  isPreloading: false,
  status: '',
  progress: null,
  visible: true,
  onPreload: () => {},
  onStart: () => {},
};

describe('PreloadScreen', () => {
  it('asks for a normal window before the download', () => {
    // Shown to everyone: browsers hide private mode, and the quota they
    // report can't be trusted to reveal it.
    render(<PreloadScreen {...BASE} />);

    expect(screen.getByText(/Private windows/)).toHaveTextContent(
      'Private windows have a size limit, so please use a normal window. Otherwise the files will download again each time.',
    );
  });

  it('gives the size of what is left to download', () => {
    render(<PreloadScreen {...BASE} cached={status(true, { chat: false })} />);

    expect(screen.getByText(/downloads about/)).toHaveTextContent(
      `This app downloads about ${formatBytes(EXPECTED_BYTES.chat)}, kept on this device for next time.`,
    );
  });

  it('still offers the download', () => {
    render(<PreloadScreen {...BASE} />);

    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('drops the note once everything is downloaded', () => {
    render(<PreloadScreen {...BASE} cached={status(true)} />);

    expect(screen.queryByText(/Private windows/)).not.toBeInTheDocument();
  });
});
