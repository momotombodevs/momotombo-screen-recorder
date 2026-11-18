import type { PermissionStatus } from '@momotombo/protocol';

export type InputProblem = 'permission' | 'no-device' | 'unavailable';

export function resolveDeviceId(devices: readonly { deviceId: string }[], preferred: string | null): string | null {
  return devices.find((d) => d.deviceId === preferred)?.deviceId ?? devices[0]?.deviceId ?? null;
}

export function inputProblem(i: { on: boolean; permission: PermissionStatus; deviceId: string | null; openFailed: boolean }): InputProblem | null {
  if (!i.on) return null;
  if (i.permission === 'denied' || i.permission === 'restricted') return 'permission';
  if (!i.deviceId) return 'no-device';
  if (i.openFailed) return 'unavailable';
  return null;
}

/** The preview and the recording open the microphone the same way, so the meter shows what gets recorded. */
export function micConstraints(deviceId: string | null): MediaStreamConstraints {
  return { audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };
}
