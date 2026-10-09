import { describe, expect, it, vi } from 'vitest';

import register from '../src/index';
import { MiioLocalPlatform } from '../src/platform';

describe('plugin entry', () => {
  it('registers the platform with Homebridge', () => {
    const api = { registerPlatform: vi.fn() };
    register(api as never);
    expect(api.registerPlatform).toHaveBeenCalledWith('MiioLocal', MiioLocalPlatform);
  });
});
