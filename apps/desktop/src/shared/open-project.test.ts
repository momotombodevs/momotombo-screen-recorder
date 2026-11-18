import { describe, expect, it } from 'vitest';
import { projectIdFromArgv } from './open-project';

describe('projectIdFromArgv', () => {
  it('finds the project wherever Chromium left the argument', () => {
    expect(projectIdFromArgv(['Momotombo', '--allow-file-access', '--open-project=prj_12345678', '/app'])).toBe('prj_12345678');
  });

  it('is null in normal use and for an empty value', () => {
    expect(projectIdFromArgv(['Momotombo', '/app'])).toBeNull();
    expect(projectIdFromArgv(['Momotombo', '--open-project='])).toBeNull();
  });
});
