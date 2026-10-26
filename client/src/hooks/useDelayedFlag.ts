import { useEffect, useState } from 'react';

/** True once `active` has stayed true for `ms` (for "this is taking a while" hints). */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setFlag(true), ms);
    return () => {
      clearTimeout(t);
      setFlag(false);
    };
  }, [active, ms]);
  return active && flag;
}
