import { useEffect, useRef, useState } from 'react';
import { measure, meterSink, MicMeter, windowCovering, type MeterFlags, type MeterReading } from './mic-meter';

export type ReadingSource = (push: (r: MeterReading) => void) => () => void;

const READ_EVERY_MS = 50;

/**
 * Readings from a live microphone stream. A timer rather than animation frames, so silence is
 * still noticed while the window is covered.
 */
export function streamReadings(stream: MediaStream): ReadingSource {
  return (push) => {
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = windowCovering(ctx.sampleRate, READ_EVERY_MS);
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const timer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      push(measure(buf));
    }, READ_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      void ctx.close();
    };
  };
}

export function useMicMeter(source: ReadingSource | null) {
  const fill = useRef<HTMLSpanElement>(null);
  const hold = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const [flags, setFlags] = useState<MeterFlags>({ clipping: false, silent: false });
  useEffect(() => {
    if (!source) return;
    const push = meterSink(new MicMeter(), () => ({ fill: fill.current, hold: hold.current, bar: bar.current }), setFlags);
    const off = source((r) => push(r, performance.now()));
    return () => {
      off();
      setFlags({ clipping: false, silent: false });
    };
  }, [source]);
  return { fill, hold, bar, ...flags };
}
