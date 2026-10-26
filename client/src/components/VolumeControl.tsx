import { useState } from 'react';
import { audioEngine } from '../audio/engine';

export function VolumeControl() {
  const [volume, setVolume] = useState(() => audioEngine.getVolume());
  return (
    <div className="flex items-center gap-3">
      <label htmlFor="volume" className="text-sm text-haze">
        Volume
      </label>
      <input
        id="volume"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVolume(v);
          audioEngine.setVolume(v);
        }}
        className="h-11 flex-1 accent-neon-pink"
        aria-valuetext={`${Math.round(volume * 100)} percent`}
      />
      <span className="w-10 text-right text-sm tabular-nums text-haze">
        {Math.round(volume * 100)}%
      </span>
    </div>
  );
}
