// src/__tests__/lib/auth/logout-guidance.test.ts
// #1552: アカウント画面の「ログアウトして…」の案内 (src/lib/auth/logout-guidance.ts) の出し分け。
//
// アプリの中の Web の設定には「ログアウト」が出ない (#1037) ので、アプリの中 ('native') では
// ネイティブの設定 (マイページの右上の歯車) と、ネイティブのログイン画面の「パスワードを忘れた？」を指す。
// 判定前 ('undecided') は場所を言わない。案内が指す言葉が実在する画面の言葉と一致していることも、ここで確かめる。

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  describeForgotCurrentPasswordNote,
  describeOthersNotSignedOutNote,
  NATIVE_FORGOT_PASSWORD_LINK_LABEL,
  NATIVE_SETTINGS_ENTRY_LABEL,
  WEB_FORGOT_PASSWORD_LINK_LABEL,
} from '@/lib/auth/logout-guidance';
import type { AccountActionsPlacement } from '@/hooks/useAccountActionsPlacement';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PLACEMENTS: AccountActionsPlacement[] = ['undecided', 'native', 'web'];

describe('#1552 他の端末のログアウトを確認できなかったときの注意書き', () => {
  it('ブラウザでは、Web の設定の「ログアウト」を指す (以前と同じ文)', () => {
    expect(describeOthersNotSignedOutNote('web')).toBe(
      'ただし、他の端末のログアウトを確認できませんでした。心配な場合は、設定の「ログアウト」でこの端末もログアウトして、新しいパスワードでログインし直してください。',
    );
  });

  it('アプリの中では、Web の設定の「ログアウト」を指さず、マイページの右上の歯車 (設定) の「ログアウト」を指す', () => {
    const note = describeOthersNotSignedOutNote('native');
    expect(note).toContain(`${NATIVE_SETTINGS_ENTRY_LABEL} の「ログアウト」`);
    expect(note).not.toContain('設定の「ログアウト」');
  });

  it('判定前は、場所を言わない (Web の設定も歯車も指さない)', () => {
    const note = describeOthersNotSignedOutNote('undecided');
    expect(note).not.toContain('「ログアウト」');
    expect(note).not.toContain('歯車');
    expect(note).toContain('この端末もいったんログアウトして');
  });

  it.each(PLACEMENTS)('%s: どの場合も、他の端末を確認できなかったことと、ログインし直すことを伝える', (placement) => {
    const note = describeOthersNotSignedOutNote(placement);
    expect(note.startsWith('ただし、他の端末のログアウトを確認できませんでした。')).toBe(true);
    expect(note.endsWith('新しいパスワードでログインし直してください。')).toBe(true);
  });
});

describe('#1552 現在のパスワードを思い出せない人への案内', () => {
  it('ブラウザでは、Web のログイン画面の「忘れた場合」を指す (以前と同じ文)', () => {
    expect(describeForgotCurrentPasswordNote('web')).toBe(
      '現在のパスワードを思い出せないときは、いったんログアウトして、ログイン画面の「忘れた場合」からパスワードを再設定してください。',
    );
  });

  it('アプリの中では、歯車からのログアウトと、アプリのログイン画面の「パスワードを忘れた？」を指す', () => {
    const note = describeForgotCurrentPasswordNote('native');
    expect(note).toContain(`${NATIVE_SETTINGS_ENTRY_LABEL} からいったんログアウトして`);
    expect(note).toContain(`「${NATIVE_FORGOT_PASSWORD_LINK_LABEL}」`);
    expect(note).not.toContain(`「${WEB_FORGOT_PASSWORD_LINK_LABEL}」`);
  });

  it('判定前は、リンクの名前も歯車も言わない', () => {
    const note = describeForgotCurrentPasswordNote('undecided');
    expect(note).not.toContain('「');
    expect(note).not.toContain('歯車');
    expect(note).toBe('現在のパスワードを思い出せないときは、いったんログアウトして、ログイン画面からパスワードを再設定してください。');
  });
});

describe('#1552 案内が指す言葉が、実在する画面の言葉と一致する', () => {
  it('Web のログイン画面に「忘れた場合」、アプリのログイン画面に「パスワードを忘れた？」がある', () => {
    expect(read('src/app/(auth)/login/page.tsx')).toContain(WEB_FORGOT_PASSWORD_LINK_LABEL);
    expect(read('apps/mobile/app/(auth)/login.tsx')).toContain(NATIVE_FORGOT_PASSWORD_LINK_LABEL);
  });

  it('アプリの中の Web の設定画面も、ログアウトの場所を同じ言い方 (マイページの右上の歯車 (設定)) で案内している', () => {
    expect(read('src/app/(main)/settings/page.tsx')).toContain(NATIVE_SETTINGS_ENTRY_LABEL);
  });

  it('アプリの中の Web の設定画面には「ログアウト」のボタンが出ない (ブラウザのときだけ出す)。だから案内はネイティブの歯車を指す', () => {
    const settings = read('src/app/(main)/settings/page.tsx');
    // ログアウトのボタン (data-testid="logout-button") は、ブラウザと判定されたとき ('web') の枝の中にだけある
    const webBranch = settings.indexOf("accountActionsPlacement === 'web'");
    const logoutButton = settings.indexOf('data-testid="logout-button"');
    expect(webBranch).toBeGreaterThan(-1);
    expect(logoutButton).toBeGreaterThan(webBranch);
  });

  it('アカウント画面は、案内の文を直書きせず、この出し分けを使う', () => {
    const account = read('src/app/(main)/settings/account/page.tsx');
    expect(account).toContain('describeOthersNotSignedOutNote(accountActionsPlacement)');
    expect(account).toContain('describeForgotCurrentPasswordNote(accountActionsPlacement)');
    expect(account).toContain('useAccountActionsPlacement(isNativeApp)');
    expect(account).not.toContain('設定の「ログアウト」');
    expect(account).not.toContain('「忘れた場合」');
  });
});
