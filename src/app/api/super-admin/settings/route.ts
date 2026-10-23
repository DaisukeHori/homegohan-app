/**
 * GET  /api/super-admin/settings — システム設定一覧
 * PUT  /api/super-admin/settings — システム設定更新
 * super_admin ロール必須
 *
 * 使われていない key (src/lib/super-admin/retired-settings.ts の RETIRED_SETTING_KEYS) は読み取り専用 (#1457):
 *   - GET は、各行に read_only (使われていない key なら true) と note (画面に出す説明。ほかは null) を付けて返す
 *   - PUT は、その key を書き換えず 409 SETTING_READ_ONLY を返す
 * 行そのものは消さない (本番のデータを消すことになるため)。
 *
 * 列の名前は DB のまま (snake_case) で返す: key / value / description / updated_at (#1486。モバイルの運営の画面もこの名前で読んでいたが、#1598 で消した)。
 * PUT の description は省略可。送られたら保存する (文字列は前後の空白を除き、空なら null。null は説明を消す)。
 *
 * #1571: PUT で保存できたら super_admin.setting.change を監査ログに 1 行残す (対象の key・保存した value・説明を変えたか)。
 * 記録に失敗しても保存は成功のまま (失敗は db-logger に残る)。409 / 400 / 保存の失敗のときは記録しない。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import {
  SETTING_READ_ONLY_CODE,
  SETTING_READ_ONLY_MESSAGE,
  SETTING_READ_ONLY_STATUS,
  retiredSettingNoteOf,
} from '@/lib/super-admin/retired-settings';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { recordAdminAudit } from '@/lib/admin/audit';

function handleError(method: 'GET' | 'PUT', err: unknown) {
  const authFailure = authFailureNested(err);
  if (authFailure) return authFailure;
  return internalError(`${method} /api/super-admin/settings`, err, {}, { shape: 'nested' });
}

export async function GET() {
  try {
    await requireRole(['super_admin']);
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value, description, updated_at')
      .order('key', { ascending: true });

    if (error) {
      // テーブルが存在しない場合は空配列を返す
      return NextResponse.json({ settings: [] });
    }

    const settings = (data ?? []).map((row) => {
      const note = retiredSettingNoteOf(row.key);
      return { ...row, read_only: note !== null, note };
    });
    return NextResponse.json({ settings });
  } catch (err) {
    return handleError('GET', err);
  }
}

export async function PUT(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const actor = await requireRole(['super_admin']);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'リクエストボディが不正です' } }, { status: 400 });
    }

    const { key, value, description } = (body as Record<string, unknown>) ?? {};
    if (!key || typeof key !== 'string' || key.trim() === '') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: '設定のキー (key) は必須です' } }, { status: 400 });
    }
    if (value === undefined) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: '設定の値 (value) は必須です' } }, { status: 400 });
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '説明 (description) は文字列か null にしてください' } },
        { status: 400 },
      );
    }
    if (retiredSettingNoteOf(key.trim()) !== null) {
      return NextResponse.json(
        { error: { code: SETTING_READ_ONLY_CODE, message: SETTING_READ_ONLY_MESSAGE } },
        { status: SETTING_READ_ONLY_STATUS },
      );
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from('system_settings')
      .upsert({
        key: key.trim(),
        value,
        // description は送られたときだけ書く (省略なら、いまの説明を残す)
        ...(description === undefined ? {} : { description: typeof description === 'string' ? description.trim() || null : null }),
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      return internalError('PUT /api/super-admin/settings', error, { userId: actor.id }, { shape: 'nested' });
    }

    // 監査ログ (#1571)。system_settings の key は uuid ではないので target_id は使わず、details.key に入れる
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'super_admin.setting.change',
      targetType: 'system_setting',
      details: { key: key.trim(), value, description_changed: description !== undefined },
      severity: 'warn',
      request,
      routeName: 'api/super-admin/settings PUT',
    });

    return NextResponse.json({ success: true, key: key.trim() });
  } catch (err) {
    return handleError('PUT', err);
  }
}
