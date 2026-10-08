/**
 * #1181 /api/health (死活監視用ヘルスチェック) の結合テスト
 *
 * 実際の Next dev サーバ + ローカル Supabase に、ログインなしで HTTP リクエストを送って確かめる。
 * ミドルウェアの matcher は route 単体の単体テストでは通らないため、実サーバでの確認が要る。
 *
 * 期待する挙動:
 *   - GET /api/health         : 未ログインで 200。{ status: 'ok', version, time } だけを返す
 *   - GET /api/health?deep=1  : 未ログインで 200。DB 疎通 (anon で subscription_plans を 1 行読む) も確認し、
 *                               checks.database = 'ok'
 *   - HEAD も同じステータスで本文なし
 *   - どの応答も Cache-Control: no-store。鍵・URL・環境変数名を含まない
 *   - /api/health/* (健康記録 API: goals など) は従来どおり、未ログインなら 401
 *     (matcher の除外が広すぎて、認証が要る API まで巻き込んでいないこと)
 *   - deep=1 が頼る前提「anon キーで subscription_plans を SELECT できる」が崩れていない
 *     (このテーブルの anon SELECT を閉じる変更を入れると、本番の死活監視が 503 を出し続けるため)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/health-endpoint.test.ts
 *   (dev サーバが 3000 以外のとき: INTEGRATION_BASE_URL=http://localhost:3140 を付ける)
 */

import { createClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import ws from 'ws';
import { apiCallNoAuth } from '../helpers/api';

const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です。');
}

interface HealthBody {
  status: string;
  version: string;
  time: string;
  checks?: { database: string };
}

/** 鍵や URL そのものがテスト失敗時のログに出ないよう、比較は boolean にして expect する */
function leaks(text: string): string[] {
  const secrets: Array<[string, string | undefined]> = [
    ['NEXT_PUBLIC_SUPABASE_URL の値', url],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY の値', anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY の値', serviceKey],
  ];
  const found = secrets.filter(([, value]) => value && text.includes(value)).map(([label]) => label);
  if (/SUPABASE|SERVICE_ROLE|process\.env/.test(text)) found.push('環境変数名らしき文字列');
  return found;
}

describe('GET /api/health (未ログイン)', () => {
  it('200 と { status: ok, version, time } だけを返し、Cache-Control は no-store', async () => {
    const res = await apiCallNoAuth<HealthBody>('GET', '/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(Object.keys(res.body).sort()).toEqual(['status', 'time', 'version']);
    expect(res.body.status).toBe('ok');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(new Date(res.body.time).toISOString()).toBe(res.body.time);
    expect(leaks(JSON.stringify(res.body))).toEqual([]);
  });

  it('?deep=1 は DB 疎通も確認して 200 / checks.database = ok', async () => {
    const res = await apiCallNoAuth<HealthBody>('GET', '/api/health?deep=1');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toEqual({ database: 'ok' });
    expect(Object.keys(res.body).sort()).toEqual(['checks', 'status', 'time', 'version']);
    expect(leaks(JSON.stringify(res.body))).toEqual([]);
  });
});

describe('HEAD /api/health (未ログイン)', () => {
  it('浅い確認も deep=1 も 200 で本文なし / no-store', async () => {
    for (const path of ['/api/health', '/api/health?deep=1']) {
      const res = await fetch(`${BASE_URL}${path}`, { method: 'HEAD' });

      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toContain('no-store');
      expect(await res.text(), path).toBe('');
    }
  });
});

describe('/api/health/* (健康記録 API) は従来どおり認証が必要', () => {
  it.each(['/api/health/goals', '/api/health/streaks', '/api/health/blood-tests'])(
    '未ログインの GET %s は 401',
    async (path) => {
      const res = await apiCallNoAuth('GET', path);

      expect(res.status).toBe(401);
    },
  );
});

describe('deep=1 が頼る前提', () => {
  it('anon キーで subscription_plans を SELECT してもエラーにならない', async () => {
    const anon = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: ws as unknown as typeof WebSocket },
    });

    const { error } = await anon.from('subscription_plans').select('id').limit(1);

    // 失敗したら: subscription_plans の anon SELECT を閉じていないか確認し、
    // 閉じるなら src/app/api/health/route.ts の DB 疎通の確認先を別の公開テーブルへ変えること
    expect(error).toBeNull();
  });
});
