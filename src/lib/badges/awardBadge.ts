import type { SupabaseClient } from '@supabase/supabase-js';

export interface AwardBadgeResult {
  awarded: boolean;
  badge_id: string | null;
  obtained_at: string | null;
  name: string | null;
  icon_url: string | null;
}

/**
 * 指定バッジをユーザーに付与する汎用ヘルパー。
 *
 * - badges テーブルから code でバッジを検索する
 * - user_badges に INSERT (ON CONFLICT DO NOTHING 相当の動作)
 * - 失敗しても呼び出し元の主処理は影響を受けない想定
 *   (呼び出し元が try-catch で囲んで console.error のみにすること)
 */
export async function awardBadge(
  supabase: SupabaseClient,
  userId: string,
  badgeCode: string,
): Promise<AwardBadgeResult> {
  // 1. バッジマスター取得
  // badges テーブルの列は icon (icon_url という列は無い)。存在しない列を select すると
  // PostgREST が 42703 を返し、下の badgeError 分岐に入って「バッジが無い」扱いになるため、
  // バッジの付与が常にスキップされていた。戻り値のキー名 icon_url は API レスポンスの互換のため
  // 維持し、値は icon 列から詰める (complete_handson_tour RPC と同じ扱い)。
  const { data: badge, error: badgeError } = await supabase
    .from('badges')
    .select('id, name, icon')
    .eq('code', badgeCode)
    .single();

  if (badgeError || !badge) {
    return { awarded: false, badge_id: null, obtained_at: null, name: null, icon_url: null };
  }

  // 2. 既に獲得済みか確認
  const { data: existing } = await supabase
    .from('user_badges')
    .select('obtained_at')
    .eq('user_id', userId)
    .eq('badge_id', badge.id)
    .single();

  if (existing) {
    // 既獲得 — 重複付与しない
    return {
      awarded: false,
      badge_id: badge.id,
      obtained_at: existing.obtained_at,
      name: badge.name,
      icon_url: badge.icon ?? null,
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
        icon_url: badge.icon ?? null,
      };
    }
    throw insertError;
  }

  return {
    awarded: true,
    badge_id: badge.id,
    obtained_at: now,
    name: badge.name,
    icon_url: badge.icon ?? null,
  };
}
