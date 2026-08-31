import { createFileRoute, Link } from '@tanstack/react-router';

import { useConversation } from '#/hooks/useConversation';

export const Route = createFileRoute('/app')({ ssr: false, component: App });

function App() {
  const { isRecording, status, toggle, preload, isPreloading } =
    useConversation();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <button onClick={preload} disabled={isPreloading}>
        Preload models
      </button>
      <button onClick={toggle}>{isRecording ? 'Stop' : 'Start'}</button>
      <div className="status">{status}</div>
      <Link to="/">Go to Home</Link>
    </main>
  );
}
