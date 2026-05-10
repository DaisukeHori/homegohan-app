// src/app/api/meals/paste-group/[id]/route.ts
// (設計書 membership/03-ui-spec.md §6.3)
// PATCH /api/meals/paste-group/{paste_group_id} — paste_group のメタ更新
// TODO(Phase P5): 本実装。bulk update で全メンバの同 group 食事を一括更新。
//   - caller が paste 元の owner であることを検証する
//   - 更新対象: notes, meal_type 等

import { NextResponse } from 'next/server';

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // TODO: 実装
  return NextResponse.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'paste-group 一括更新は未実装です', paste_group_id: id } },
    { status: 501 },
  );
}
