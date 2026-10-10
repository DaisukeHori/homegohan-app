/**
 * /api/super-admin/exports — データエクスポート (準備中・未対応)
 *
 * 全メソッドが 501 (OP_NOT_SUPPORTED) を返す (#1126。オーナー判断 2026-10-08: 準備中と明示する)。
 * 認可 (super_admin) は従来どおり先に行い、通った人にだけ 501 を返す。DB には一切触れない。
 *
 * 以前は、ファイルを作る処理 (cron / worker) も専用テーブルも無いまま、依頼を受け付けていた。
 *   - 専用テーブルが無いため、利用者本人の GDPR 削除要求の表 (gdpr_deletion_requests) を代用していた。
 *     その表には、書き込もうとした列 (status / deletion_type / request_details) が無く、依頼は必ず失敗し、
 *     失敗すると偽の ID を作って 201 (処理中) を返していた。依頼は保存されず、完了することもなかった。
 *   - 代用先は本人の削除要求なので、一覧に混ざったり、「キャンセル」で本人の削除要求を取り消したりする危険もあった。
 * 専用の exports テーブルとファイルを作る処理が入るまで、この API は何も保存せず、何も読まない。
 * 設計: operator/02-api-spec.md §16
 */
import { respondNotSupported } from '@/lib/admin/not-supported';
import { EXPORTS_NOT_SUPPORTED_MESSAGE } from '@/lib/super-admin/exports-schemas';

export const dynamic = 'force-dynamic';

const respond = (method: string) =>
  respondNotSupported({
    routeName: `${method} /api/super-admin/exports`,
    roles: ['super_admin'],
    message: EXPORTS_NOT_SUPPORTED_MESSAGE,
  });

export async function GET() {
  return respond('GET');
}

export async function POST() {
  return respond('POST');
}

export async function PUT() {
  return respond('PUT');
}

export async function PATCH() {
  return respond('PATCH');
}

export async function DELETE() {
  return respond('DELETE');
}
