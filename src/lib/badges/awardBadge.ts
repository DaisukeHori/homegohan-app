import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/db-logger';

export interface AwardBadgeResult {
  awarded: boolean;
  badge_id: string | null;
  obtained_at: string | null;
  name: string | null;
  /**
   * badges.icon の値 (絵文字などの文字列。未設定なら null)。
   * DB の列名は icon だが、API レスポンスのキーは complete_handson_tour RPC と同じ icon_url のままにしている
   * (web / モバイルのクライアントを変えずに済ませるため。#1306)。
   */
  icon_url: string | null;
}

/** badges から読む列。badges に icon_url という列は無く、実列は icon (#1306) */
interface BadgeMasterRow {
  id: string;
  name: string;
  icon: string | null;
}

/**
 * 指定バッジをユーザーに付与する汎用ヘルパー。
 *
 * - badges テーブルから code でバッジを検索する
 * - user_badges に INSERT (ON CONFLICT DO NOTHING 相当の動作)
 * - 付与済み・マスターに無い code は例外にせず awarded: false で返す
 * - 想定外の DB エラーは構造化ログ (createLogger) に残したうえで例外を投げる。
 *   失敗しても呼び出し元の主処理は影響を受けない想定なので、呼び出し元は try-catch で囲むこと
 */
export async function awardBadge(
  supabase: SupabaseClient,
  userId: string,
  badgeCode: string,
): Promise<AwardBadgeResult> {
  const logger = createLogger('award-badge').withUser(userId);

  // 1. バッジマスター取得
  // 存在しない列 (旧: icon_url) を select すると PostgREST は 42703 を返し、supabase-js は
  // { data: null, error } を返す。以前は error を見ずに「バッジが無い」と同じ扱いで返していたため、
  // 付与が常に失敗しているのに気付けなかった (#1306)。
  // 0 件は正常な結果 (error なし・data null) として扱いたいので single ではなく maybeSingle を使う。
  const { data: badgeRow, error: badgeError } = await supabase
    .from('badges')
    .select('id, name, icon')
    .eq('code', badgeCode)
    .maybeSingle();

  if (badgeError) {
    logger.error('バッジマスターの取得に失敗しました', badgeError, {
      badge_code: badgeCode,
      error_code: badgeError.code,
    });
    throw badgeError;
  }

  const badge = badgeRow as BadgeMasterRow | null;
  if (!badge) {
    // マスターに無い code (seed 漏れ・code の綴り違いなど)。付与はできないが、気付けるよう警告を残す
    logger.warn('該当するバッジがマスターにありません', { badge_code: badgeCode });
    return { awarded: false, badge_id: null, obtained_at: null, name: null, icon_url: null };
  }

  // API レスポンスのキーは icon_url のまま、値は badges.icon
  const iconUrl = badge.icon ?? null;

  // 2. 既に獲得済みか確認
  const { data: existing, error: existingError } = await supabase
    .from('user_badges')
    .select('obtained_at')
    .eq('user_id', userId)
    .eq('badge_id', badge.id)
    .maybeSingle();

  if (existingError) {
    logger.error('獲得済みバッジの確認に失敗しました', existingError, {
      badge_code: badgeCode,
      badge_id: badge.id,
      error_code: existingError.code,
    });
    throw existingError;
  }

  if (existing) {
    // 既獲得 — 重複付与しない
    return {
      awarded: false,
      badge_id: badge.id,
      obtained_at: existing.obtained_at,
      name: badge.name,
      icon_url: iconUrl,
    };
  }

  // 3. INSERT (PK 制約で冪等)
  const now = new Date().toISOString();
  const { error: insertError } = await supabase.from('user_badges').insert({
    user_id: userId,
    badge_id: badge.id,
    obtained_at: now,
  });

  if (insertError) {
    // ON CONFLICT 相当: PK 重複(code 23505)は付与済みとみなす
    if (insertError.code === '23505') {
      return {
        awarded: false,
        badge_id: badge.id,
        obtained_at: null,
        name: badge.name,
        icon_url: iconUrl,
      };
    }
    logger.error('バッジの付与 (user_badges への保存) に失敗しました', insertError, {
      badge_code: badgeCode,
      badge_id: badge.id,
      error_code: insertError.code,
    });
    throw insertError;
  }

  return {
    awarded: true,
    badge_id: badge.id,
    obtained_at: now,
    name: badge.name,
    icon_url: iconUrl,
  };
}
