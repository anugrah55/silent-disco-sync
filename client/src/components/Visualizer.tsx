import { useEffect, useRef } from 'react';
import { audioEngine } from '../audio/engine';

const BARS = 40;

/**
 * Spectrum bars from the output AnalyserNode (so it shows what this phone is
 * actually playing, after volume). Log-spaced bins so bass and treble both
 * get room. Drawn on a canvas in requestAnimationFrame; pauses with the tab.
 */
export function Visualizer({ height = 96 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let lastDraw = 0;
    let bins: Uint8Array<ArrayBuffer> | null = null;
    const levels = new Float32Array(BARS);

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // Reduced motion: a calm 8 fps instead of 60.
      if (reduced && now - lastDraw < 125) return;
      lastDraw = now;
      const w = canvas.clientWidth;
      const analyser = audioEngine.analyser;
      if (analyser && (!bins || bins.length !== analyser.frequencyBinCount)) {
        bins = new Uint8Array(analyser.frequencyBinCount);
      }
      if (analyser && bins) analyser.getByteFrequencyData(bins);

      g.clearRect(0, 0, w, height);
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#ff2bd6');
      grad.addColorStop(0.5, '#8b5cf6');
      grad.addColorStop(1, '#22e6ff');
      g.fillStyle = grad;

      const gap = 3;
      const barW = Math.max(1, (w - gap * (BARS - 1)) / BARS);
      const n = bins?.length ?? 0;
      for (let i = 0; i < BARS; i++) {
        let v = 0;
        if (bins && n) {
          // Log-spaced bands from ~50 Hz to ~14 kHz (at 48 kHz); above that, tracks are empty.
          const lo = Math.floor(n * 0.002 * Math.pow(300, i / BARS));
          const hi = Math.max(lo + 1, Math.floor(n * 0.002 * Math.pow(300, (i + 1) / BARS)));
          for (let k = lo; k < Math.min(hi, n); k++) v = Math.max(v, bins[k]!);
          v /= 255;
        }
        // Quick attack, slow release: reads as motion, not flicker.
        levels[i] = v > levels[i]! ? v : levels[i]! * 0.9 + v * 0.1;
        const barH = Math.max(3, levels[i]! * (height - 4));
        const x = i * (barW + gap);
        g.beginPath();
        const r = Math.min(4, barW / 2);
        // roundRect is Safari 16+; older engines get square bars.
        const rounded = g as CanvasRenderingContext2D & {
          roundRect?: CanvasRenderingContext2D['roundRect'];
        };
        if (rounded.roundRect) rounded.roundRect(x, height - barH, barW, barH, [r, r, 0, 0]);
        else g.rect(x, height - barH, barW, barH);
        g.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [height]);

  return <canvas ref={canvasRef} aria-hidden className="block w-full" style={{ height }} />;
}
