import { describe, expect, it } from 'vitest';
import { requireSender } from './ipc-guard';

describe('requireSender', () => {
  const main = { id: 1 };

  it('lets the main window through', () => {
    expect(() => requireSender(main, main)).not.toThrow();
  });

  it('refuses any other window, and every window while there is no main window', () => {
    expect(() => requireSender({ id: 2 }, main)).toThrow('Not allowed');
    expect(() => requireSender(main, undefined)).toThrow('Not allowed');
    expect(() => requireSender(undefined, undefined)).toThrow('Not allowed');
  });
});
