import { describe, expect, it } from 'vitest';

import { resolveDisplayName } from '../src/lib/user-display';

describe('resolveDisplayName', () => {
  it('returns a real nickname as-is', () => {
    expect(resolveDisplayName({
      nickname: 'ほりりん',
      email: 'user@example.com',
    })).toBe('ほりりん');
  });

  it('falls back to email local-part when nickname is a placeholder', () => {
    expect(resolveDisplayName({
      nickname: 'Guest',
      email: 'nvidia.homeftp.net@gmail.com',
    })).toBe('nvidia.homeftp.net');
  });

  it('uses user metadata when nickname is missing', () => {
    expect(resolveDisplayName({
      nickname: null,
      email: 'user@example.com',
      userMetadata: { full_name: '山田太郎' },
    })).toBe('山田太郎');
  });
});
