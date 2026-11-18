import { describe, expect, it } from 'vitest';
import { inputProblem, micConstraints, resolveDeviceId } from './recorder-inputs';

const devices = [{ deviceId: 'a' }, { deviceId: 'b' }];

describe('resolveDeviceId', () => {
  it('keeps the remembered device while it is plugged in', () => {
    expect(resolveDeviceId(devices, 'b')).toBe('b');
  });

  it('falls back to the first device when the remembered one is gone', () => {
    expect(resolveDeviceId(devices, 'gone')).toBe('a');
    expect(resolveDeviceId(devices, null)).toBe('a');
  });

  it('has nothing to pick without devices', () => {
    expect(resolveDeviceId([], 'a')).toBeNull();
  });
});

describe('inputProblem', () => {
  const ok = { on: true, permission: 'granted' as const, deviceId: 'a', openFailed: false };

  it('is fine when the input is off, whatever its state', () => {
    expect(inputProblem({ on: false, permission: 'denied', deviceId: null, openFailed: true })).toBeNull();
  });

  it('is fine with permission and a resolved device', () => {
    expect(inputProblem(ok)).toBeNull();
  });

  it('reports denied permission first', () => {
    expect(inputProblem({ ...ok, permission: 'denied', deviceId: null })).toBe('permission');
    expect(inputProblem({ ...ok, permission: 'restricted' })).toBe('permission');
  });

  it('reports a missing device', () => {
    expect(inputProblem({ ...ok, deviceId: null })).toBe('no-device');
  });

  it('reports a device that could not be opened', () => {
    expect(inputProblem({ ...ok, openFailed: true })).toBe('unavailable');
  });
});

describe('micConstraints', () => {
  it('turns off the browser processing the recording also turns off', () => {
    expect(micConstraints('x')).toEqual({
      audio: { deviceId: { exact: 'x' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  });

  it('opens the default microphone the same way before a device is known', () => {
    expect(micConstraints(null)).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  });
});
