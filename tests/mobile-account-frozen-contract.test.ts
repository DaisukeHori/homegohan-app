/**
 * アカウントの凍結 (#1861): アプリ (apps/mobile) と Web・サーバーの契約を固定する
 *
 *   1. アプリの凍結の画面のパス FROZEN_SCREEN_PATH は、Web の凍結の画面 (src/app/frozen/page.tsx) の route で、
 *      middleware が凍結中の画面の取得を差し戻す先 (lib/supabase/middleware.ts の url.pathname = '/frozen') と同じ値
 *      (アプリは WebView でこのパスを開く。食い違うと、アプリが開く画面が Web の凍結の画面でなくなる)
 *   2. アプリが凍結の判定に使う API FROZEN_PROBE_API_PATH は、凍結中も通す API (FROZEN_ALLOWED_API_PATHS・
 *      通知のトークンの claim・ネイティブ認証ブリッジのコード・お問い合わせの送信 (POST /api/contact。
 *      isFrozenContactSubmitRequest。#1871)) のどれにも入っていない
 *      (入ると、凍結中でも判定が 2xx になって clear と読み、凍結の画面へ移らなくなる)。
 *      この列挙は middleware の凍結の分岐が止めない判定と同じ (判定が増えたらここと下の見張りに足す。食い違いはテストが赤くする)。
 *      実在する route で、規約の同意ゲートの対象外 (未同意でも 403 LEGAL_CONSENT_REQUIRED で判定を誤らない)
 *   3. 固定の文 ACCOUNT_FROZEN_MESSAGE は、Web の凍結の画面の見出しと同じ (文言は Web と同じものを使う)
 *   4. middleware が返す 403 の本文は、アプリが見分ける packages/shared の accountFrozenBody / ACCOUNT_FROZEN_STATUS を使う
 *
 * apps/mobile/src を直接 import する (tests/legal-consent-mobile-contract.test.ts と同じ)。
 * apps/mobile/src/lib/account-frozen.ts は @homegohan/shared だけを import する純粋なモジュールなので、ルートの vitest で読める。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_FROZEN_MESSAGE as SHARED_ACCOUNT_FROZEN_MESSAGE,
  isLegalConsentExemptApiPath,
} from '@homegohan/shared';
import { AccountFrozenError, FROZEN_PROBE_API_PATH, FROZEN_SCREEN_PATH } from '../apps/mobile/src/lib/account-frozen';
import {
  CONTACT_API_PATH,
  CONTACT_SUBMIT_METHOD,
  FROZEN_ALLOWED_API_PATHS,
  NATIVE_BRIDGE_CODE_API_PATH,
  isFrozenAllowedApiPath,
  isFrozenContactSubmitRequest,
  isNativeBridgeCodeApiPath,
} from '../src/lib/auth/frozen';
import { PUSH_TOKEN_CLAIM_API_PATH, isPushTokenClaimApiPath } from '../src/lib/push-tokens';

const ROOT = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** パス (/a/b) から Next.js の App Router の page / route のファイルを指す */
function appRouterFile(pathname: string, file: 'page.tsx' | 'route.ts'): string {
  return path.join('src', 'app', ...pathname.split('/').filter(Boolean), file);
}

describe('アプリの凍結の画面と Web の凍結の画面の契約 (#1861)', () => {
  it('FROZEN_SCREEN_PATH は Web の凍結の画面の route (src/app/frozen/page.tsx) で、middleware が差し戻す先と同じ値', () => {
    expect(FROZEN_SCREEN_PATH).toBe('/frozen');
    expect(fs.existsSync(path.join(ROOT, appRouterFile(FROZEN_SCREEN_PATH, 'page.tsx')))).toBe(true);
    // middleware の凍結の差し戻し (画面の取得) の行き先
    expect(read('lib/supabase/middleware.ts')).toContain(`url.pathname = '${FROZEN_SCREEN_PATH}'`);
  });

  it('凍結の画面から進む退会・書き出しの画面 (/frozen/account) と有料プランの解約の画面 (/frozen/billing) も Web にある', () => {
    for (const child of ['account', 'billing']) {
      expect(fs.existsSync(path.join(ROOT, appRouterFile(`${FROZEN_SCREEN_PATH}/${child}`, 'page.tsx'))), child).toBe(true);
    }
  });

  it('ACCOUNT_FROZEN_MESSAGE (アプリの AccountFrozenError の文) は Web の凍結の画面の見出しと同じ', () => {
    expect(new AccountFrozenError().message).toBe(SHARED_ACCOUNT_FROZEN_MESSAGE);
    const page = read(appRouterFile(FROZEN_SCREEN_PATH, 'page.tsx'));
    const heading = /<h1[^>]*>\s*([^<]+?)\s*<\/h1>/.exec(page);
    expect(heading?.[1]).toBe(SHARED_ACCOUNT_FROZEN_MESSAGE);
  });
});

/** 判定の API を呼びうるメソッド (アプリは GET で呼ぶ。どのメソッドでも凍結中に通らないことを見る) */
const PROBE_METHODS_TO_CHECK = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * middleware の凍結の分岐が止めない判定 (関数名) と、冒頭の 2. の列挙での呼び名。
 * 判定を足したら、ここと冒頭の 2. と、下の「どれにも入っていない」の見張りの 3 か所に足す
 */
const FROZEN_PASS_THROUGH_LABELS: Readonly<Record<string, string>> = {
  isFrozenAllowedApiPath: 'FROZEN_ALLOWED_API_PATHS',
  isPushTokenClaimApiPath: '通知のトークンの claim',
  isNativeBridgeCodeApiPath: 'ネイティブ認証ブリッジのコード',
  isFrozenContactSubmitRequest: 'お問い合わせの送信',
};

describe('凍結の判定の API の契約 (#1861)', () => {
  it('FROZEN_PROBE_API_PATH は、凍結中も通す API (FROZEN_ALLOWED_API_PATHS・claim・ブリッジのコード・お問い合わせの送信) のどれにも入っていない', () => {
    expect(isFrozenAllowedApiPath(FROZEN_PROBE_API_PATH)).toBe(false);
    expect(FROZEN_ALLOWED_API_PATHS).not.toContain(FROZEN_PROBE_API_PATH);
    expect(isPushTokenClaimApiPath(FROZEN_PROBE_API_PATH)).toBe(false);
    expect(FROZEN_PROBE_API_PATH).not.toBe(PUSH_TOKEN_CLAIM_API_PATH);
    expect(isNativeBridgeCodeApiPath(FROZEN_PROBE_API_PATH)).toBe(false);
    expect(FROZEN_PROBE_API_PATH).not.toBe(NATIVE_BRIDGE_CODE_API_PATH);
    // #1871: お問い合わせの送信 (POST /api/contact) はメソッドまで見て通す。判定の API はどのメソッドでも当たらない
    expect(isFrozenContactSubmitRequest(CONTACT_SUBMIT_METHOD, CONTACT_API_PATH)).toBe(true);
    for (const method of PROBE_METHODS_TO_CHECK) {
      expect(isFrozenContactSubmitRequest(method, FROZEN_PROBE_API_PATH), method).toBe(false);
    }
    expect(FROZEN_PROBE_API_PATH).not.toBe(CONTACT_API_PATH);
  });

  it('凍結中も通す判定の列挙 (このファイルの冒頭の 2.) は、middleware の凍結の分岐が止めない判定と同じ', () => {
    // middleware の凍結の分岐の条件 (apiFrozen && !isXxx(...) && ...) から、止めない判定の関数名を拾う
    const condition = /apiFrozen &&([\s\S]*?)\)\s*\{/.exec(read('lib/supabase/middleware.ts'))?.[1] ?? '';
    const exemptions = [...condition.matchAll(/!\s*(is\w+)\(/g)].map((match) => match[1]).sort();
    expect(exemptions).toEqual(Object.keys(FROZEN_PASS_THROUGH_LABELS).sort());
    // 冒頭の 2. の列挙が、どの判定も名前で挙げている (行頭の「 * 」を外してつなげて見る)
    const joinedSource = read('tests/mobile-account-frozen-contract.test.ts')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .join('');
    const item2 = /2\. アプリが凍結の判定に使う API([\s\S]*?)3\. 固定の文/.exec(joinedSource)?.[1] ?? '';
    expect(item2).not.toBe('');
    for (const [predicate, label] of Object.entries(FROZEN_PASS_THROUGH_LABELS)) {
      expect(item2, predicate).toContain(label);
    }
  });

  it('FROZEN_PROBE_API_PATH は実在する route で、規約の同意ゲートの対象外 (未同意でも凍結していなければ 2xx)', () => {
    expect(fs.existsSync(path.join(ROOT, appRouterFile(FROZEN_PROBE_API_PATH, 'route.ts')))).toBe(true);
    expect(isLegalConsentExemptApiPath(FROZEN_PROBE_API_PATH)).toBe(true);
  });

  it('middleware の凍結の 403 は packages/shared の accountFrozenBody と ACCOUNT_FROZEN_STATUS で作る (アプリが見分ける値と同じ)', () => {
    const middleware = read('lib/supabase/middleware.ts');
    expect(middleware).toMatch(/NextResponse\.json\(accountFrozenBody\(\),\s*\{\s*status: ACCOUNT_FROZEN_STATUS/);
    // 本文を手で書いた古い形が残っていない
    expect(middleware).not.toContain("code: 'AUTH_ACCOUNT_FROZEN'");
  });
});
