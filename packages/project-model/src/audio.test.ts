import { describe, expect, it } from 'vitest';
import { AUDIO_LIMITS, MAX_AUDIO_GAIN, ProjectFormatError, createProject, defaultAudio, parseProject, serializeProject, setAudio } from './index';
import { validateAudio } from './validate';

const saved = () => JSON.parse(serializeProject(createProject('a'))) as Record<string, any>;

describe('audio mix', () => {
  it('fills the enhancement fields of a file written before they existed, with everything off', () => {
    const j = saved();
    j.audio = { mic: { gain: 0.7, muted: false }, system: { gain: 0.8, muted: true } };
    const a = parseProject(j).audio;
    expect(a.mic).toEqual({ ...defaultAudio().mic, gain: 0.7 });
    expect(a.system).toEqual({ ...defaultAudio().system, muted: true });
    expect(a.mic.highpassHz).toBe(0);
    expect(a.mic.compressor.enabled).toBe(false);
    expect(a.mic.gate.enabled).toBe(false);
    expect(a.mic.normalize).toEqual({ enabled: false, targetLufs: -16 });
  });

  it('keeps a partial enhancement block and fills the rest', () => {
    const j = saved();
    j.audio = { mic: { gain: 1, muted: false, compressor: { enabled: true } } };
    const a = parseProject(j).audio;
    expect(a.mic.compressor).toEqual({ ...defaultAudio().mic.compressor, enabled: true });
  });

  it('accepts a gain up to 300% and still opens an older file with more', () => {
    const j = saved();
    j.audio.mic.gain = 3;
    expect(parseProject(j).audio.mic.gain).toBe(3);
    j.audio.mic.gain = 5;
    expect(parseProject(j).audio.mic.gain).toBe(3);
    j.audio.mic.gain = -0.1;
    expect(() => parseProject(j)).toThrow(ProjectFormatError);
  });

  it('names the field, the rule and the limit of an out-of-range value', () => {
    let error: unknown;
    try {
      validateAudio(setAudio(createProject('a'), { mic: { compressor: { ratio: 50 } } }).audio);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProjectFormatError);
    expect(error).toMatchObject({ field: 'audio.mic.compressor.ratio', rule: { kind: 'max', limit: 20 }, message: 'Campo no válido: audio.mic.compressor.ratio (mayor que 20)' });
  });

  it('validates audio against the shared limits', () => {
    const tooLoud = AUDIO_LIMITS.normalize.targetLufs.max + 1;
    expect(() => validateAudio(setAudio(createProject('a'), { mic: { normalize: { targetLufs: tooLoud } } }).audio)).toThrow('audio.mic.normalize.targetLufs');
    expect(AUDIO_LIMITS.gain.max).toBe(MAX_AUDIO_GAIN);
  });

  it('reports a broken channel as a format error', () => {
    const j = saved();
    j.audio.mic = null;
    expect(() => parseProject(j)).toThrow(ProjectFormatError);
  });

  it('rejects a gain above 300% in a patch', () => {
    expect(() => validateAudio(setAudio(createProject('a'), { mic: { gain: 3.01 } }).audio)).toThrow('audio.mic.gain');
  });

  it('rejects out-of-range enhancement values naming the field', () => {
    const bad: [string, (a: any) => void][] = [
      ['audio.mic.highpassHz', (a) => { a.mic.highpassHz = -1; }],
      ['audio.mic.compressor.ratio', (a) => { a.mic.compressor.ratio = 0.5; }],
      ['audio.mic.compressor.thresholdDb', (a) => { a.mic.compressor.thresholdDb = 3; }],
      ['audio.mic.gate.thresholdDb', (a) => { a.mic.gate.thresholdDb = 'x'; }],
      ['audio.mic.normalize.targetLufs', (a) => { a.mic.normalize.targetLufs = 0; }],
      ['audio.system.normalize.enabled', (a) => { a.system.normalize.enabled = 'yes'; }],
      ['audio.mic.gate.enabled', (a) => { a.mic.gate.enabled = 1; }],
    ];
    for (const [field, mutate] of bad) {
      const j = saved();
      mutate(j.audio);
      expect(() => parseProject(j), field).toThrow(field);
    }
  });
});
