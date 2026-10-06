import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VoiceDownloadOverlay } from '#/components/VoiceDownloadOverlay';
import { LANGUAGES } from '#/config';
import { voicePackBytes } from '#/lib/preload';
import { formatBytes } from '#/utils/formatBytes';

// See ConversationScreen.test.tsx: no globals, so no automatic cleanup.
afterEach(cleanup);

const BASE = {
  language: 'es-MX',
  isDownloading: false,
  progress: null,
  failed: false,
  onDownload: () => {},
  onCancel: () => {},
} as const;

describe('VoiceDownloadOverlay', () => {
  it('renders nothing until a language is waiting', () => {
    const { container } = render(
      <VoiceDownloadOverlay {...BASE} language={null} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('names the language and the size of its voices', () => {
    render(<VoiceDownloadOverlay {...BASE} />);

    expect(screen.getByText(/needs its own voice/)).toHaveTextContent(
      `Spanish (Mexico) needs its own voice. It downloads about ${formatBytes(
        voicePackBytes(LANGUAGES['es-MX'].voiceIds),
      )}, kept on this device for next time.`,
    );
  });

  it('offers to download or cancel', () => {
    const onDownload = vi.fn();
    const onCancel = vi.fn();
    render(
      <VoiceDownloadOverlay
        {...BASE}
        onDownload={onDownload}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDownload).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows progress in place of the buttons while downloading', () => {
    render(
      <VoiceDownloadOverlay
        {...BASE}
        isDownloading
        progress={{
          loaded: 40_000_000,
          total: 100_000_000,
          percent: 40,
          isFinishing: false,
        }}
      />,
    );

    expect(screen.getByText('Downloading')).toBeInTheDocument();
    expect(screen.getByText('40 MB of 100 MB')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Download progress' }),
    ).toHaveAttribute('aria-valuenow', '40');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables both buttons before the first progress arrives', () => {
    render(<VoiceDownloadOverlay {...BASE} isDownloading />);

    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('offers a retry after a failure', () => {
    render(<VoiceDownloadOverlay {...BASE} failed />);

    expect(screen.getByText('Download failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('keeps naming the language while it animates out', () => {
    const { rerender } = render(<VoiceDownloadOverlay {...BASE} />);

    rerender(<VoiceDownloadOverlay {...BASE} language={null} />);

    expect(screen.getByText(/Spanish \(Mexico\)/)).toBeInTheDocument();
  });
});
