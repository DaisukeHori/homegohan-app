/**
 * src/lib/auth/password/policy.ts の単体テスト (#1198。設計 docs/design/cross/16-auth-history-sessions.md §12.2・§20.1)
 */
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_HISTORY_GENERATIONS,
  PASSWORD_HISTORY_MAX_GENERATIONS,
  passwordHistoryGenerationsFor,
} from '../password/policy';

describe('passwordHistoryGenerationsFor', () => {
  it('運営のロールを 1 つでも持てば 10', () => {
    for (const role of ['support', 'sales', 'finance', 'content_moderator', 'admin', 'super_admin']) {
      expect(passwordHistoryGenerationsFor(['user', role])).toBe(10);
    }
    // 組織のロールと一緒でも運営が優先
    expect(passwordHistoryGenerationsFor(['org_admin', 'admin'])).toBe(PASSWORD_HISTORY_GENERATIONS.operator);
    expect(PASSWORD_HISTORY_MAX_GENERATIONS).toBe(PASSWORD_HISTORY_GENERATIONS.operator);
  });

  it('org_ のロールは 5', () => {
    expect(passwordHistoryGenerationsFor(['org_admin'])).toBe(5);
    expect(passwordHistoryGenerationsFor(['user', 'org_member'])).toBe(5);
  });

  it('それ以外は 3', () => {
    expect(passwordHistoryGenerationsFor(['user'])).toBe(3);
    expect(passwordHistoryGenerationsFor(['family_admin'])).toBe(3);
  });

  it('空の配列は 3', () => {
    expect(passwordHistoryGenerationsFor([])).toBe(3);
  });
});
