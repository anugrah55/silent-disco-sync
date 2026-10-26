import type { SocketStatus } from '../net/socket';

const styles: Record<SocketStatus, [string, string]> = {
  connecting: ['bg-ok', 'Connecting'],
  open: ['bg-good', 'Live'],
  reconnecting: ['bg-ok animate-pulse', 'Reconnecting'],
  closed: ['bg-bad', 'Offline'],
};

export function ConnectionPill({ status }: { status: SocketStatus }) {
  const [color, label] = styles[status];
  return (
    <span
      role="status"
      className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-sm"
    >
      <span aria-hidden className={`size-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
