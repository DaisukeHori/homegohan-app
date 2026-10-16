/**
 * mfa-gate.test.ts
 * apps/mobile/src/lib/mfa-gate.ts のテスト (#1707 段 D。docs/design/cross/12-operator-mfa.md §16.1・§21.6)
 *
 * WebView から頼まれた二段階認証の確認を、ネイティブのセッションの AAL だけで判定する (ロールと猶予は読まない)。
 */
import {
  MOBILE_MFA_ENROLL_ON_WEB_MESSAGE,
  MOBILE_TOTP_CODE_PATTERN,
  decideMobileOperatorGate,
  toMobileAal,
} from '../../src/lib/mfa-gate';

describe('decideMobileOperatorGate', () => {
  it('currentLevel が aal2 なら allow (ネイティブのセッションは既に aal2)', () => {
    expect(decideMobileOperatorGate({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe('allow');
    expect(decideMobileOperatorGate({ currentLevel: 'aal2', nextLevel: null })).toBe('allow');
  });

  it('currentLevel が aal2 でなく nextLevel が aal2 なら verify (verified な factor がある)', () => {
    expect(decideMobileOperatorGate({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe('verify');
    expect(decideMobileOperatorGate({ currentLevel: null, nextLevel: 'aal2' })).toBe('verify');
  });

  it('それ以外は enroll_on_web (verified な factor が無い)', () => {
    expect(decideMobileOperatorGate({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe('enroll_on_web');
    expect(decideMobileOperatorGate({ currentLevel: 'aal1', nextLevel: null })).toBe('enroll_on_web');
    expect(decideMobileOperatorGate({ currentLevel: null, nextLevel: null })).toBe('enroll_on_web');
    expect(decideMobileOperatorGate({ currentLevel: null, nextLevel: 'aal1' })).toBe('enroll_on_web');
  });
});

describe('toMobileAal', () => {
  it('aal1 / aal2 はそのまま', () => {
    expect(toMobileAal('aal1')).toBe('aal1');
    expect(toMobileAal('aal2')).toBe('aal2');
  });

  it.each([['aal3'], [null], [undefined], [''], ['AAL2']])('%j は null', (value) => {
    expect(toMobileAal(value)).toBeNull();
  });
});

describe('MOBILE_TOTP_CODE_PATTERN', () => {
  it('6 桁の数字に合う', () => {
    expect(MOBILE_TOTP_CODE_PATTERN.test('123456')).toBe(true);
    expect(MOBILE_TOTP_CODE_PATTERN.test('000000')).toBe(true);
  });

  it.each([['12345'], ['1234567'], ['12345a'], [' 123456'], ['123456 '], ['１２３４５６'], ['']])(
    '%j には合わない',
    (value) => {
      expect(MOBILE_TOTP_CODE_PATTERN.test(value)).toBe(false);
    },
  );
});

describe('MOBILE_MFA_ENROLL_ON_WEB_MESSAGE', () => {
  it('アプリの外のブラウザでの登録を案内する', () => {
    expect(MOBILE_MFA_ENROLL_ON_WEB_MESSAGE).toContain('ブラウザ');
    expect(MOBILE_MFA_ENROLL_ON_WEB_MESSAGE).toContain('アプリの中では登録できません');
  });
});
