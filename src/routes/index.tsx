import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link to="/app">Go to App</Link>
    </main>
  );
}
