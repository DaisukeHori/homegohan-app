/**
 * 凍結で /api を止めたときの 403 の取り決め (accountFrozenBody / isAccountFrozenBody) のテスト (#1861)
 *
 * middleware は accountFrozenBody() の入れ子の本文を返し、モバイルは isAccountFrozenBody で見分ける。
 * route が投げる平たい形 ({ error, code }) も同じ凍結として見分ける。ほかの code・形の違う値は見分けない。
 */
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_FROZEN_CODE,
  ACCOUNT_FROZEN_MESSAGE,
  ACCOUNT_FROZEN_STATUS,
  accountFrozenBody,
  isAccountFrozenBody,
} from './account-frozen';

describe('accountFrozenBody', () => {
  it('middleware の既存の本文と同じ入れ子の形・値 (403 / AUTH_ACCOUNT_FROZEN / Web の凍結の画面の見出し)', () => {
    expect(accountFrozenBody()).toEqual({
      error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' },
    });
    expect(ACCOUNT_FROZEN_STATUS).toBe(403);
    expect(ACCOUNT_FROZEN_CODE).toBe('AUTH_ACCOUNT_FROZEN');
    expect(ACCOUNT_FROZEN_MESSAGE).toBe('アカウントが凍結されています');
  });

  it('呼ぶたびに新しい object を返す (呼び出し側が書き換えても次の本文に響かない)', () => {
    expect(accountFrozenBody()).not.toBe(accountFrozenBody());
  });
});

describe('isAccountFrozenBody', () => {
  it('middleware の入れ子の本文を見分ける (JSON を通した後も)', () => {
    expect(isAccountFrozenBody(accountFrozenBody())).toBe(true);
    expect(isAccountFrozenBody(JSON.parse(JSON.stringify(accountFrozenBody())))).toBe(true);
  });

  it('route の平たい本文 ({ error, code }) も見分ける', () => {
    expect(isAccountFrozenBody({ error: ACCOUNT_FROZEN_MESSAGE, code: ACCOUNT_FROZEN_CODE })).toBe(true);
  });

  it.each([
    ['規約の同意の 403', { error: '同意が必要です', code: 'LEGAL_CONSENT_REQUIRED' }],
    ['入れ子のほかの code', { error: { code: 'PERM_DENIED', message: 'x' } }],
    ['code が文字列でない', { error: { code: 403 } }],
    ['文だけ同じで code が無い', { error: ACCOUNT_FROZEN_MESSAGE }],
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'AUTH_ACCOUNT_FROZEN'],
    ['配列', ['AUTH_ACCOUNT_FROZEN']],
  ])('%s は見分けない', (_label, body) => {
    expect(isAccountFrozenBody(body)).toBe(false);
  });
});
