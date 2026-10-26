import { Link } from 'react-router';

export function NotFound({
  title = 'Nothing here',
  message = 'That page does not exist.',
}: {
  title?: string;
  message?: string;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <h1 className="font-display text-4xl font-bold">{title}</h1>
      <p className="text-lg text-haze">{message}</p>
      <Link to="/" className="btn-primary">
        Back to start
      </Link>
    </main>
  );
}
