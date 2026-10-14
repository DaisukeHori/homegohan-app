/**
 * /api/super-admin/exports/[id] — データエクスポートの状態確認・キャンセル (準備中・未対応)
 *
 * 全メソッドが 501 (OP_NOT_SUPPORTED) を返す (#1126。オーナー判断 2026-10-08: 準備中と明示する)。
 * 認可 (super_admin) は従来どおり先に行い、通った人にだけ 501 を返す。DB には一切触れない。
 *
 * 以前は、エクスポートの代わりに利用者本人の GDPR 削除要求の表 (gdpr_deletion_requests) を読み書きしていた。
 * 特に DELETE (キャンセル) は、実在する本人の削除要求に cancelled_at を入れて取り消してしまうため、
 * 「エクスポートのキャンセル」のつもりで本人の削除要求を止める事故につながった。
 * 専用の exports テーブルとファイルを作る処理が入るまで、この API は何も読まず、何も更新しない。
 * 一覧・依頼 (POST) は ./route.ts。設計: operator/02-api-spec.md §16
 */
import { respondNotSupported } from '@/lib/admin/not-supported';
import { EXPORTS_NOT_SUPPORTED_MESSAGE } from '@/lib/super-admin/exports-schemas';

export const dynamic = 'force-dynamic';

const respond = (method: string) =>
  respondNotSupported({
    routeName: `${method} /api/super-admin/exports/[id]`,
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
