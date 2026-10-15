/**
 * #1176 運営ロールの MFA の方針 (純関数) のテスト。docs/design/cross/12-operator-mfa.md §12.1・§21.1 (mfa-policy.test.ts)
 */
import { describe, expect, it } from 'vitest';
import {
  MFA_REQUIRED_ROLES,
  decideOperatorAssurance,
  resolveMfaEnforceFrom,
  type DecideOperatorAssuranceInput,
} from '@/lib/auth/mfa/policy';

const NOW = new Date('2026-10-16T00:00:00Z');
const FUTURE = new Date('2026-10-17T00:00:00Z');
const PAST = new Date('2026-10-15T00:00:00Z');

function decide(overrides: Partial<DecideOperatorAssuranceInput>) {
  return decideOperatorAssurance({
    roles: ['admin'],
    aal: 'aal1',
    hasVerifiedTotp: false,
    enforceFrom: null,
    now: NOW,
    ...overrides,
  });
}

describe('MFA_REQUIRED_ROLES', () => {
  it('MFA_REQUIRED_ROLES は super_admin / admin / finance / org_industrial_doctor の 4 つ', () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(['admin', 'finance', 'org_industrial_doctor', 'super_admin']);
  });
});

describe('resolveMfaEnforceFrom', () => {
  it('resolveMfaEnforceFrom: 未設定・空白は null (ignored=false)', () => {
    expect(resolveMfaEnforceFrom(undefined)).toEqual({ enforceFrom: null, ignored: false });
    expect(resolveMfaEnforceFrom('')).toEqual({ enforceFrom: null, ignored: false });
    expect(resolveMfaEnforceFrom('   ')).toEqual({ enforceFrom: null, ignored: false });
  });

  it('resolveMfaEnforceFrom: TZ 付きの ISO 8601 を Date にする (Z / +09:00 / 秒とミリ秒の有無)', () => {
    expect(resolveMfaEnforceFrom('2026-10-31T15:00:00Z')).toEqual({
      enforceFrom: new Date('2026-10-31T15:00:00Z'),
      ignored: false,
    });
    expect(resolveMfaEnforceFrom('2026-11-01T00:00:00+09:00').enforceFrom?.toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(resolveMfaEnforceFrom('2026-11-01T00:00+09:00').enforceFrom?.toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(resolveMfaEnforceFrom('2026-10-31T15:00:00.123Z').enforceFrom?.toISOString()).toBe('2026-10-31T15:00:00.123Z');
    expect(resolveMfaEnforceFrom('  2026-10-31T15:00:00-03:30  ').enforceFrom?.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('resolveMfaEnforceFrom: 日付だけ・TZ 無し・文字列・月 13 は null (ignored=true)', () => {
    for (const raw of ['2026-11-01', '2026-11-01T00:00:00', 'next week', '2026-13-01T00:00:00Z']) {
      expect(resolveMfaEnforceFrom(raw), raw).toEqual({ enforceFrom: null, ignored: true });
    }
  });

  it('resolveMfaEnforceFrom: 存在しない日時 (2026-02-30T00:00:00Z・2026-04-31T00:00:00+09:00・2026-01-01T24:00:00Z) は Date.parse が数を返しても null (ignored=true)。うるう年の 2028-02-29T00:00:00Z は受け付ける', () => {
    for (const raw of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00+09:00', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z']) {
      expect(resolveMfaEnforceFrom(raw), raw).toEqual({ enforceFrom: null, ignored: true });
    }
    expect(resolveMfaEnforceFrom('2028-02-29T00:00:00Z')).toEqual({
      enforceFrom: new Date('2028-02-29T00:00:00Z'),
      ignored: false,
    });
    expect(resolveMfaEnforceFrom('2027-02-29T00:00:00Z')).toEqual({ enforceFrom: null, ignored: true });
  });

  it('resolveMfaEnforceFrom: 時差が範囲外 (+24:00・+09:60) は null (ignored=true)', () => {
    expect(resolveMfaEnforceFrom('2026-11-01T00:00:00+24:00')).toEqual({ enforceFrom: null, ignored: true });
    expect(resolveMfaEnforceFrom('2026-11-01T00:00:00+09:60')).toEqual({ enforceFrom: null, ignored: true });
    expect(resolveMfaEnforceFrom('2026-11-01T00:00:00+23:59').ignored).toBe(false);
  });
});

describe('decideOperatorAssurance', () => {
  it('decideOperatorAssurance: 必須ロールでなければ not_required (aal は見ない)', () => {
    for (const roles of [['support'], ['user'], ['sales', 'content_moderator'], ['org_admin'], []]) {
      for (const aal of ['aal1', 'aal2', null] as const) {
        expect(decide({ roles, aal, hasVerifiedTotp: true }), `${roles.join(',')} ${aal}`).toEqual({
          required: false,
          decision: 'not_required',
        });
      }
    }
  });

  it('decideOperatorAssurance: aal2 は factor の有無によらず pass', () => {
    for (const role of MFA_REQUIRED_ROLES) {
      expect(decide({ roles: [role], aal: 'aal2', hasVerifiedTotp: true })).toEqual({ required: true, decision: 'pass' });
      expect(decide({ roles: [role], aal: 'aal2', hasVerifiedTotp: false })).toEqual({ required: true, decision: 'pass' });
    }
  });

  it('decideOperatorAssurance: aal1 で verified あり は challenge_required (猶予中でも)', () => {
    expect(decide({ hasVerifiedTotp: true })).toEqual({ required: true, decision: 'challenge_required' });
    expect(decide({ hasVerifiedTotp: true, enforceFrom: FUTURE })).toEqual({ required: true, decision: 'challenge_required' });
    expect(decide({ hasVerifiedTotp: true, aal: null })).toEqual({ required: true, decision: 'challenge_required' });
  });

  it('decideOperatorAssurance: aal1 で無し、now < enforceFrom は pass_grace', () => {
    expect(decide({ enforceFrom: FUTURE })).toEqual({ required: true, decision: 'pass_grace' });
    expect(decide({ enforceFrom: new Date(NOW.getTime() + 1) })).toEqual({ required: true, decision: 'pass_grace' });
  });

  it('decideOperatorAssurance: aal1 で無し、enforceFrom が null / 過去 / ちょうど now は enrollment_required', () => {
    for (const enforceFrom of [null, PAST, new Date(NOW.getTime())]) {
      expect(decide({ enforceFrom })).toEqual({ required: true, decision: 'enrollment_required' });
    }
  });

  it('decideOperatorAssurance: 複数ロール (admin + finance / support + admin) は必須側に倒れる', () => {
    expect(decide({ roles: ['admin', 'finance'], hasVerifiedTotp: true })).toEqual({
      required: true,
      decision: 'challenge_required',
    });
    expect(decide({ roles: ['support', 'admin'] })).toEqual({ required: true, decision: 'enrollment_required' });
    expect(decide({ roles: ['support', 'org_industrial_doctor'], aal: 'aal2' })).toEqual({ required: true, decision: 'pass' });
  });
});
