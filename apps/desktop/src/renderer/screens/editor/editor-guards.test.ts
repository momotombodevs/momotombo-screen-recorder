import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '@momotombo/timing';
import {
  addPrivacy, addRecording, addZoom, createProject, presetTransition, removePrivacy, removeTimelineRange, splitAt, updatePrivacy,
  type NewPrivacy, type NewZoom, type Project, type Recording,
} from '@momotombo/project-model';
import { privacyConfirmed, privacySignature, shortcutsBlocked } from './editor-guards';

function rec(): Recording {
  return {
    id: 'r1', createdAt: '2026-10-16T00:00:00Z', duration: sec(60),
    sources: { screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60, startOffset: 0, duration: sec(60) } },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'Pantalla', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: true },
    syncOffsets: {}, markers: [],
  };
}

const privacy = (start: number, end: number): NewPrivacy => ({
  recordingId: 'r1', start: sec(start), end: sec(end), origin: 'manual', region: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 },
  keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
});

const zoom = (start: number, end: number): NewZoom => ({
  recordingId: 'r1', start: sec(start), end: sec(end), origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.5 }, scale: 2,
  enter: presetTransition('smooth'), exit: presetTransition('smooth'),
});

function withTwoAreas(): Project {
  const first = addPrivacy(addRecording(createProject('Test'), rec()), privacy(2, 4)).project;
  return addPrivacy(first, privacy(10, 12)).project;
}

describe('shortcutsBlocked', () => {
  it('blocks editor shortcuts while the export dialog is open', () => {
    expect(shortcutsBlocked({ exportOpen: true, leaveBlocked: false })).toBe(true);
  });

  it('blocks them while the unsaved-changes warning is shown', () => {
    expect(shortcutsBlocked({ exportOpen: false, leaveBlocked: true })).toBe(true);
  });

  it('allows them otherwise', () => {
    expect(shortcutsBlocked({ exportOpen: false, leaveBlocked: false })).toBe(false);
  });
});

describe('privacy confirmation', () => {
  it('needs no confirmation without privacy areas', () => {
    expect(privacyConfirmed(addRecording(createProject('Test'), rec()), null)).toBe(true);
  });

  it('holds for the privacy areas it was given for', () => {
    const p = withTwoAreas();
    expect(privacyConfirmed(p, null)).toBe(false);
    expect(privacyConfirmed(p, privacySignature(p))).toBe(true);
  });

  it('is cleared when a privacy area is deleted', () => {
    const p = withTwoAreas();
    const confirmedFor = privacySignature(p);
    const [first] = p.privacy;
    if (!first) throw new Error('fixture has no privacy area');
    const after = removePrivacy(p, first.id);
    expect(privacyConfirmed(after, confirmedFor)).toBe(false);
  });

  it('is cleared when a privacy area is moved', () => {
    const p = withTwoAreas();
    const confirmedFor = privacySignature(p);
    const item = p.privacy[1];
    if (!item) throw new Error('fixture has one privacy area');
    const after = updatePrivacy(p, item.id, { start: item.start + sec(1), end: item.end + sec(1) });
    expect(privacyConfirmed(after, confirmedFor)).toBe(false);
  });

  it('is cleared when removing part of the timeline moves a privacy area', () => {
    const p = withTwoAreas();
    const confirmedFor = privacySignature(p);
    expect(privacyConfirmed(removeTimelineRange(p, sec(6), sec(8)), confirmedFor)).toBe(false);
  });

  it('survives a split that leaves every privacy area in place', () => {
    const p = withTwoAreas();
    const confirmedFor = privacySignature(p);
    const cut = splitAt(p, sec(6));
    expect(cut).not.toBe(p);
    expect(privacyConfirmed(cut, confirmedFor)).toBe(true);
  });

  it('survives edits that do not touch privacy areas', () => {
    const p = withTwoAreas();
    const confirmedFor = privacySignature(p);
    expect(privacyConfirmed(addZoom(p, zoom(20, 23)).project, confirmedFor)).toBe(true);
  });
});
