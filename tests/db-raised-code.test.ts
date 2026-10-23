// @vitest-environment node
/**
 * src/lib/errors/db-raised-code.ts (#1917)
 *
 * route がエラーの `.message` を自分で読まずに、DB の RAISE EXCEPTION のコードを判定するための関数。
 * 運営の強制の譲渡の 2 route・運営の組織の作成・ロールの変更の route が使う。
 */
import { describe, expect, it } from 'vitest';
import { PG_RAISE_EXCEPTION_SQLSTATE, dbErrorMentionsCode, isRaisedExceptionWithCode } from '@/lib/errors/db-raised-code';

const CODE = 'REPRESENTATIVE_ACCOUNT_DELETING';
/** P0001 以外の SQLSTATE (deadlock_detected・unique_violation) */
const OTHER_SQLSTATES = ['40P01', '23505'];

describe('PG_RAISE_EXCEPTION_SQLSTATE', () => {
  it("RAISE EXCEPTION の既定の SQLSTATE 'P0001'", () => {
    expect(PG_RAISE_EXCEPTION_SQLSTATE).toBe('P0001');
  });
});

describe('isRaisedExceptionWithCode', () => {
  it('P0001 で文面がちょうどそのコードなら true', () => {
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: CODE }, CODE)).toBe(true);
  });

  it.each(OTHER_SQLSTATES)('文面がそのコードでも、SQLSTATE が %s なら false', (sqlstate) => {
    expect(isRaisedExceptionWithCode({ code: sqlstate, message: CODE }, CODE)).toBe(false);
  });

  it('SQLSTATE が無ければ false', () => {
    expect(isRaisedExceptionWithCode({ message: CODE }, CODE)).toBe(false);
    expect(isRaisedExceptionWithCode({ code: null, message: CODE }, CODE)).toBe(false);
  });

  it('P0001 でも、文面がほかのコード・コードを含むだけの文面なら false (完全一致だけ)', () => {
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: 'CONFLICT_RETRY' }, CODE)).toBe(false);
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: `ERROR: ${CODE}` }, CODE)).toBe(false);
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: `${CODE} ` }, CODE)).toBe(false);
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: null }, CODE)).toBe(false);
    expect(isRaisedExceptionWithCode({ code: 'P0001' }, CODE)).toBe(false);
  });

  it('エラーが無い (null / undefined) なら false', () => {
    expect(isRaisedExceptionWithCode(null, CODE)).toBe(false);
    expect(isRaisedExceptionWithCode(undefined, CODE)).toBe(false);
  });
});

describe('dbErrorMentionsCode', () => {
  it('文面がちょうどそのコードなら true (SQLSTATE は見ない)', () => {
    expect(dbErrorMentionsCode({ message: 'NOT_OPERATOR' }, 'NOT_OPERATOR')).toBe(true);
    expect(dbErrorMentionsCode({ code: 'P0001', message: 'NOT_OPERATOR' }, 'NOT_OPERATOR')).toBe(true);
    expect(dbErrorMentionsCode({ code: '42501', message: 'NOT_OPERATOR' }, 'NOT_OPERATOR')).toBe(true);
  });

  it('文面の前後に何かが付いていても、そのコードを語として含めば true', () => {
    expect(dbErrorMentionsCode({ message: 'ERROR: TARGET_NOT_IN_FAMILY' }, 'TARGET_NOT_IN_FAMILY')).toBe(true);
    expect(dbErrorMentionsCode({ message: 'TARGET_NOT_IN_ORG - the user is not a member' }, 'TARGET_NOT_IN_ORG')).toBe(true);
    expect(dbErrorMentionsCode({ message: 'P0001: FORBIDDEN.' }, 'FORBIDDEN')).toBe(true);
  });

  it('部分文字列としてだけ含む (前後が語の文字) なら false (#1045 と同じ: 短いコードが長いコードの中で当たらない)', () => {
    expect(dbErrorMentionsCode({ message: 'USER_NOT_FOUND' }, 'NOT_FOUND')).toBe(false);
    expect(dbErrorMentionsCode({ message: 'TARGET_NOT_IN_ORG' }, 'NOT_IN_ORG')).toBe(false);
    expect(dbErrorMentionsCode({ message: 'NOT_OPERATOR_X' }, 'NOT_OPERATOR')).toBe(false);
  });

  it('ほかのコード・文面が無い・エラーが無いなら false', () => {
    expect(dbErrorMentionsCode({ message: 'OPERATOR_MFA_REQUIRED' }, 'NOT_OPERATOR')).toBe(false);
    expect(dbErrorMentionsCode({ message: '' }, 'NOT_OPERATOR')).toBe(false);
    expect(dbErrorMentionsCode({ message: null }, 'NOT_OPERATOR')).toBe(false);
    expect(dbErrorMentionsCode({ code: 'P0001' }, 'NOT_OPERATOR')).toBe(false);
    expect(dbErrorMentionsCode(null, 'NOT_OPERATOR')).toBe(false);
    expect(dbErrorMentionsCode(undefined, 'NOT_OPERATOR')).toBe(false);
  });
});
