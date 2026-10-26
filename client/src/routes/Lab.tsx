import { Link } from 'react-router';

export function Lab() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
      <Link to="/" className="text-haze hover:text-white">
        ← Home
      </Link>
      <h1 className="font-display text-4xl font-bold">
        Sync <span className="text-gradient">Lab</span>
      </h1>
      <p className="text-haze">Live clock-sync graphs arrive in Phase 2.</p>
    </main>
  );
}
