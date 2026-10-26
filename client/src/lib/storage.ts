/** Storage access can throw (Safari private mode, blocked site data), so never let it crash the app. */
function safe(store: () => Storage) {
  return {
    get(key: string): string | null {
      try {
        return store().getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        store().setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    remove(key: string): void {
      try {
        store().removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export const local = safe(() => window.localStorage);
export const session = safe(() => window.sessionStorage);

export const keys = {
  name: 'sds.name',
  clientId: 'sds.clientId',
  hostToken: (code: string) => `sds.host.${code}`,
  nudge: 'sds.nudgeMs',
  flash: 'sds.flash',
  volume: 'sds.volume',
} as const;
