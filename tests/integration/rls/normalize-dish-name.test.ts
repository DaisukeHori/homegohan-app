/**
 * 関数本文のドリフト (#1243): normalize_dish_name (料理名の正規化) が本番の定義どおりに動くことの回帰テスト
 *
 * 本番の定義は空白を '[\s　]+' で消す (正しい)。リポジトリの 20251230074555_fix_normalize_dish_name_regex.sql は
 * '[\\s　]+' と書いており、standard_conforming_strings=on では「\ と s と全角空白」を消す正規表現になる
 * (空白は残り、英字の s が消える。例: 'sushi' → 'uhi')。
 * 2026-10-07 のオーナー判断「A: 本番の定義を明文化」で、本番の定義を migration にする (本番の動作は変わらない)。
 *
 * 半角括弧 '(…)' は、本番の定義でも消えない (正規表現が '\\([^)]*\\)' のため)。直すと正規化結果
 * (dataset_* の name_norm など) が変わるため、今回は本番どおりのままにしている (#1243)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/normalize-dish-name.test.ts
 */

import { createClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const srAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

async function normalize(name: string | null): Promise<string> {
  const { data, error } = await srAdmin.rpc('normalize_dish_name', { name });
  if (error) throw new Error(`normalize_dish_name: ${error.message}`);
  return data as string;
}

describe('normalize_dish_name は本番の定義どおりに正規化する', () => {
  it('N-1: 半角・全角の空白を消す', async () => {
    expect(await normalize('Caesar salad')).toBe('caesarsalad');
    expect(await normalize('鶏の　唐揚げ')).toBe('鶏の唐揚げ');
  });

  it('N-2: 英字の s やバックスラッシュは消さない', async () => {
    expect(await normalize('sushi')).toBe('sushi');
    expect(await normalize('a\\b')).toBe('a\\b');
  });

  it('N-3: 全角括弧は中身ごと消す', async () => {
    expect(await normalize('唐揚げ（大盛り）')).toBe('唐揚げ');
  });

  it('N-4: 中点 (・ と ･) を消し、小文字にする', async () => {
    expect(await normalize('ハム・エッグ')).toBe('ハムエッグ');
    expect(await normalize('ﾊﾑ･ｴｯｸﾞ')).toBe('ﾊﾑｴｯｸﾞ');
    expect(await normalize('BLT Sandwich')).toBe('bltsandwich');
  });

  it('N-5: NULL は空文字にする', async () => {
    expect(await normalize(null)).toBe('');
  });

  it('N-6: 半角括弧は消えない (本番どおり。直す場合は正規化結果の再計算が必要 #1243)', async () => {
    expect(await normalize('Caesar salad (L)')).toBe('caesarsalad(l)');
  });
});
