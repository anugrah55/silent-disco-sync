import { useSyncExternalStore } from 'react';
import { audioEngine } from '../audio/engine';

const subscribe = (cb: () => void) => audioEngine.onStateChange(cb);
const getState = () => audioEngine.state;

/** Shown when the AudioContext is suspended (iOS after a call, autoplay policy, etc.). */
export function SoundOverlay() {
  const state = useSyncExternalStore(subscribe, getState);
  if (state === 'running' || state === 'closed') return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-night/85 p-6 backdrop-blur-md">
      <button
        type="button"
        className="btn-primary min-h-20 w-full max-w-sm text-xl"
        onClick={() => audioEngine.unlock()}
        autoFocus
      >
        Tap to enable sound
      </button>
    </div>
  );
}
