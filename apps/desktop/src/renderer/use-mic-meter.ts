import { useEffect, useRef, useState } from 'react';
import { measure, MicMeter, type MeterReading } from './mic-meter';

export type ReadingSource = (push: (r: MeterReading) => void) => () => void;

/**
 * Readings from a live microphone stream. A timer rather than animation frames, so silence is
 * still noticed while the window is covered.
 */
export function streamReadings(stream: MediaStream): ReadingSource {
  return (push) => {
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const timer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      push(measure(buf));
    }, 50);
    return () => {
      window.clearInterval(timer);
      void ctx.close();
    };
  };
}

/**
 * Drives a level meter straight through the DOM, so a reading never re-renders the screen;
 * only the clip and silence flags go through React, and only when they change.
 */
export function useMicMeter(source: ReadingSource | null) {
  const fill = useRef<HTMLSpanElement>(null);
  const hold = useRef<HTMLSpanElement>(null);
  const [flags, setFlags] = useState({ clipping: false, silent: false });
  useEffect(() => {
    if (!source) return;
    const meter = new MicMeter();
    const off = source((r) => {
      const v = meter.push(r, performance.now());
      if (fill.current) fill.current.style.clipPath = `inset(0 ${(1 - v.level) * 100}% 0 0)`;
      if (hold.current) hold.current.style.left = `${v.hold * 100}%`;
      setFlags((f) => (f.clipping === v.clipping && f.silent === v.silent ? f : { clipping: v.clipping, silent: v.silent }));
    });
    return () => {
      off();
      setFlags({ clipping: false, silent: false });
    };
  }, [source]);
  return { fill, hold, ...flags };
}
