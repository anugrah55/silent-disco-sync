/** Render's free tier sleeps after 15 idle minutes; the first request wakes it. */
export function ColdStartHint() {
  return (
    <p role="status" className="rounded-2xl bg-white/5 px-4 py-3 text-center text-sm text-haze">
      Waking up the server. Free hosting naps when idle, so the first visit can take up to a minute.
    </p>
  );
}
