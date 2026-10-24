import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { NO_FIELDS_TO_UPDATE_MESSAGE } from '@/lib/api/user-api-error-messages';

// data_share_enabled (旧「トレーナーと共有」) について (#1144):
//   Web とアプリの設定画面からは、この項目を外した。トレーナーなどに共有する機能は無く、この値を読んで何かをするコードも無い。
//   旧ビルドのアプリがまだこの項目を読み書きするので、DB の列とこの API の項目は残してある
//   (消すと、旧ビルドのアプリで値が読めなくなり、保存も 400 エラーになる。新しい画面はこの項目を読み書きしない)。
//   なお、この項目は AI の事業者へデータを送る処理 (自動解析など) とは関係が無く、それらはこの変更で止めていない。
//
//   ここに保存されている値は、利用者の「共有への同意」ではない。
//   画面の説明は「栄養士やジムと連携」だけで、共有先・共有する範囲・使いみちを示しておらず、同意の日時や文言の記録も無い。
//   トレーナーなどへの共有を始めるときは、先に既存の値を全員 false に戻し、改めて同意を取り直してから使うこと。
//   保存済みの値を、同意の根拠として読んではいけない。
//   (tests/data-share-not-consent.test.ts が、この API と DB の型以外でこの値を使うコードが増えていないことを確かめる)
const DEFAULT_SETTINGS = {
  notifications_enabled: true,
  auto_analyze_enabled: true,
  data_share_enabled: false,
};

/** 部分更新で受け付ける項目 (data_share_enabled は旧ビルドのアプリ向けに受け付けるだけ。上のコメント参照) */
const PREFERENCE_KEYS = ['notifications_enabled', 'auto_analyze_enabled', 'data_share_enabled'] as const;
type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/**
 * 項目の日本語の名前 (設定の画面の見出しと同じ。data_share_enabled は旧ビルドの画面の「トレーナーと共有」)。
 * 失敗の文は「日本語の名前 (項目のキー)」の形にして、英字のキーを括弧の外に出さない (#1917 の続き)
 */
const PREFERENCE_LABELS: Readonly<Record<PreferenceKey, string>> = {
  notifications_enabled: '通知',
  auto_analyze_enabled: '自動解析',
  data_share_enabled: 'トレーナーと共有',
};

/** 項目の値が真偽値でないときの 400 の文 */
function preferenceNotBooleanMessage(key: PreferenceKey): string {
  return `${PREFERENCE_LABELS[key]} (${key}) はオン (true) かオフ (false) で指定してください`;
}

// 設定 toggle の取得
export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('notifications_enabled, auto_analyze_enabled, data_share_enabled')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    return internalError('GET /api/notification-preferences', error, { userId: user.id });
  }

  const settings = data
    ? {
        notifications_enabled: data.notifications_enabled ?? DEFAULT_SETTINGS.notifications_enabled,
        auto_analyze_enabled: data.auto_analyze_enabled ?? DEFAULT_SETTINGS.auto_analyze_enabled,
        data_share_enabled: data.data_share_enabled ?? DEFAULT_SETTINGS.data_share_enabled,
      }
    : DEFAULT_SETTINGS;

  return NextResponse.json({ settings });
}

// 設定 toggle の部分更新
export async function PATCH(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
  }

  // data_share_enabled は旧ビルドのアプリ向けに受け付けるだけ (上のコメント参照。値は同意ではない)
  const patch: Partial<Record<PreferenceKey, boolean>> = {};

  for (const key of PREFERENCE_KEYS) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') {
        return NextResponse.json({ error: preferenceNotBooleanMessage(key) }, { status: 400 });
      }
      patch[key] = body[key] as boolean;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: NO_FIELDS_TO_UPDATE_MESSAGE }, { status: 400 });
  }

  // upsertでselect→分岐を1クエリに集約し、並列アクセス時の競合とレイテンシを解消
  const result = await supabase
    .from('notification_preferences')
    .upsert(
      { user_id: user.id, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select('notifications_enabled, auto_analyze_enabled, data_share_enabled')
    .single();

  if (result.error) {
    return internalError('PATCH /api/notification-preferences', result.error, { userId: user.id });
  }

  const settings = {
    notifications_enabled: result.data.notifications_enabled ?? DEFAULT_SETTINGS.notifications_enabled,
    auto_analyze_enabled: result.data.auto_analyze_enabled ?? DEFAULT_SETTINGS.auto_analyze_enabled,
    data_share_enabled: result.data.data_share_enabled ?? DEFAULT_SETTINGS.data_share_enabled,
  };

  return NextResponse.json({ settings });
}
