# 06. Implementation Phases

P0-P7 のタスク分解。各 phase で **並列起動可否** を明示。

---

## P0: 基盤 migration + 型生成 + Zod スキーマ
**期間目安**: 1-2 日 / **並列**: 不可 (全 phase の前提)

### deliverables
1. `supabase/migrations/20260511000000〜30_membership_*.sql` 計 13 ファイル
2. `npm run types:supabase` 実行 → `src/types/database.types.ts` 更新
3. `src/schemas/membership/*.ts` Zod スキーマ全件
4. `src/lib/errors/membership-errors.ts` ErrorCode enum

### ステップ
1. local supabase で migration apply 検証 (`npx supabase db reset` → migration 全件 apply)
2. RLS policy が壊していない既存機能の sanity test (既存 E2E spec を 1 件走らせる)
3. `npm run types:supabase` でリンクされたプロジェクトから型生成
4. PR: `feat(membership): P0 — DDL + RLS + RPC + Zod schemas`

### 検証
- 型生成後、新 schema の型が `Database['public']['Tables']` 配下に出現
- 既存 RLS が壊れていない (regression check)
- `_typecheck.test.ts` (01-data-model §6) が pass

---

## P1: organization 招待 — accept page + accept/reject API + Resend 送信
**期間目安**: 2-3 日 / **並列**: P3 と並列可

### deliverables
- `src/app/invite/[token]/page.tsx` (org/family 共通の 5 パターン分岐 page)
- `src/app/api/org/invites/route.ts` 修正 (Resend 送信追加, 既存ユーザ判定)
- `src/app/api/org/invites/[token]/accept/route.ts` 新規
- `src/app/api/org/invites/[token]/reject/route.ts` 新規
- `src/app/api/org/invites/[id]/revoke/route.ts` 新規
- `src/lib/emails/membership/org-invite-existing.ts` / `org-invite-new.ts`
- `src/lib/emails/send.ts` Resend ラッパ

### 並列実行 (implementer 委譲)
- Implementer A: API + RPC 接続 (`/api/org/invites/*`)
- Implementer B: invite page UI + InviteLayout component
- 両者完了後 → integration smoke test → PR 統合

### 検証
- E2E `tests/e2e/membership/01-org-invite-existing-user.spec.ts` PASS
- 招待発行 → mail 受信 (Resend Sandbox or local relay) → リンク click → accept 一連がワンショットで動く

---

## P2: organization メンバ管理 (除名/脱退/Owner 譲渡)
**期間目安**: 2-3 日 / **並列**: P1 完了後、P4 と並列可

### deliverables
- `src/app/(org)/org/members/page.tsx` (メンバ一覧 + 操作)
- `src/app/(org)/org/settings/owner-transfer/page.tsx`
- `src/app/(org)/org/transfer-accept/[proposal_id]/page.tsx`
- API: `/api/org/members/{user_id}/remove`, `/api/org/leave`, `/api/org/owner-transfer/propose`, `/api/org/owner-transfer/{id}/accept`
- transfer-proposed メールテンプレート + 送信

### 並列実行
- Implementer A: メンバ一覧 + 除名/脱退
- Implementer B: Owner 譲渡 (2-step)

### 検証
- E2E `04-org-member-management.spec.ts` PASS
- 譲渡 propose → メール → accept flow が動く

---

## P3: family グループ作成 + 招待発行 + 受諾 (parallel with P1)
**期間目安**: 3-4 日

### deliverables
- `src/app/(main)/family/setup/page.tsx`
- `src/app/(main)/family/dashboard/page.tsx`
- `src/app/(main)/family/members/invite/page.tsx`
- API: `/api/family/groups`, `/api/family/invites`, `/api/family/invites/[token]/accept`, `/api/family/invites/[token]/reject`
- `src/lib/emails/membership/family-invite.ts`
- 招待受諾モーダル (share_meals/share_health/share_menu 選択)

### 並列実行
- Implementer A: API + RPC 接続
- Implementer B: setup/dashboard UI
- Implementer C: 招待発行 + 受諾 UI

### 検証
- E2E `05-family-create-and-invite.spec.ts` PASS
- 共有設定が DB に反映される

---

## P4: family メンバ管理 (子供, 除名, 脱退, 代表者譲渡)
**期間目安**: 3 日 / **並列**: P3 完了後

### deliverables
- `src/app/(main)/family/members/page.tsx`
- `src/app/(main)/family/members/[id]/page.tsx`
- `src/app/(main)/family/members/child/new/page.tsx`
- `src/app/(main)/family/members/[id]/promote/page.tsx`
- `src/app/(main)/family/representative-transfer/page.tsx`
- `src/app/(main)/family/transfer-accept/[proposal_id]/page.tsx`
- API: `/api/family/members/child`, `/api/family/members/{id}/promote`, `/api/family/members/{user_id}/remove`, `/api/family/leave`, `/api/family/representative-transfer/*`

### 検証
- E2E `06-family-edge-cases.spec.ts`, `07-family-child-management.spec.ts`, `08-family-representative-transfer.spec.ts` PASS

---

## P5: ペースト機能 + ビュー切替 + 共有設定 (献立画面の本丸)
**期間目安**: 3-4 日 / **並列**: P3 完了後 (P4 と並列)

### deliverables
- `src/components/membership/FamilyViewSwitcher.tsx`
- `src/components/membership/MealRow.tsx`, `PasteGroupedMealRows.tsx`
- `src/components/membership/MealActionSheet.tsx`, `PasteTargetModal.tsx`
- `src/app/(main)/menus/weekly/page.tsx` 修正 (view switcher 配置, mix 表示)
- `src/app/(main)/settings/membership/page.tsx`
- API: `/api/meals/paste`, `/api/meals/paste-group/{id}` (bulk update), `PATCH /api/family/members/me/share`
- `useFamilyView` hook (localStorage 永続化)

### 検証
- E2E `09-meal-paste.spec.ts` PASS
- E2E `10-share-settings.spec.ts` PASS
- ビュー切替で mix 表示が正しく filter される (手動 QA)

---

## P6: 運営管理者 緊急介入 UI
**期間目安**: 2-3 日 / **並列**: P1-P5 と独立 (テスト用 super_admin 必要)

### deliverables
- `src/app/(operator)/operator/membership/layout.tsx`
- `src/app/(operator)/operator/membership/orgs/inactive/page.tsx`
- `src/app/(operator)/operator/membership/families/inactive/page.tsx`
- `src/app/(operator)/operator/membership/orgs/[id]/transfer/page.tsx`
- `src/app/(operator)/operator/membership/families/[id]/transfer/page.tsx`
- `src/app/(operator)/operator/membership/audit/page.tsx`
- API: `/api/operator/membership/...` 5 endpoint
- RPC: `force_transfer_org_owner`, `force_transfer_family_representative`, `force_dissolve_*`, `is_inactive_user`, `list_*_with_inactive_*`
- 運営強制操作 通知メールテンプレート + 一括送信ロジック

### 検証
- E2E `11-operator-emergency.spec.ts` PASS (super_admin fixture が必要)
- 全メンバ通知メールが送信される

---

## P7: E2E テスト全件 + ドキュメント微調整
**期間目安**: 2-3 日 / **並列**: 各 phase 完了時に部分実行、最終整理を P7 で

### deliverables
- `tests/e2e/membership/` 配下 11 spec ファイル (02-flow-spec §16 参照)
- 各 spec で fresh-user fixture 利用 (新 E2E アーキテクチャ)
- 新 fixture が必要なら `tests/e2e/fixtures/fresh-user.ts` に追加:
  - `freshOrgWithMembers` (org + N member)
  - `freshFamilyWithMembers` (family + N member, child 含む)
  - `superAdminUser` (super_admin role)

### 並列実行
- Implementer A: 01-04 (org 系)
- Implementer B: 05-08 (family 系)
- Implementer C: 09-10 (paste + share)
- Implementer D: 11 (operator)

---

## 全体タイムライン (推奨並列実行)

```
Day 1-2:  P0 (migration + 型 + Zod) ← 単独
Day 3-5:  P1 (org 招待) ‖ P3 (family 招待)
Day 6-8:  P2 (org メンバ) ‖ P4 (family メンバ) ‖ P5 (paste + view)
Day 9-11: P6 (operator)
Day 12-14: P7 (E2E 全件 + 残検証)
```

合計 ~2 週間 (実装者複数並列前提)。

---

## ブロッカー

### B1: ドメイン取得待ち
- `homegohan.com` を取得後、`NEXT_PUBLIC_INVITE_BASE_URL` を本番設定
- それまで invite URL は `homegohan-app.vercel.app` で動作確認

### B2: 既存 organizations.owner_id backfill
- 既存 organizations で owner 不明な行があれば手動 backfill 必要
- migration P0 で「最古の org_admin user を owner とする」自動 backfill 入れる

### B3: 「ほめゴハン」一斉表記変更 (別 PR)
- 既存 `homegohan` UI/メール文字列を「ほめゴハン」に書き換える (Task #159 で完了)
- P0-P7 と並列だが、conflict 注意 (touch する file 多数)
- Task #159 (新規) で扱う

---

## DoD (Definition of Done)

各 phase 完了の判定基準:
1. 該当 E2E spec が CI で PASS
2. typecheck + lint + 既存 spec regression なし
3. PR review 1 件以上の approve
4. migration が本番に apply 可能 (rollback plan あり)
5. 監査ログが正しく記録される (manual smoke test)
6. 通知メールが正しく届く (Resend dashboard で確認)

---

## 完成時に提供される機能 一覧

### 既存ユーザ視点
- 組織から招待を受けて参加できる (alpha 1-10)
- 家族から招待を受けて参加できる (beta 1-10)
- 自分の食事を家族にペーストできる
- 家族の食事を mix view で確認できる
- 共有設定で何を見せるか個別 control
- 自発脱退できる
- Owner / 代表 譲渡できる

### 招待者視点 (admin/owner/representative/adult)
- 既存ユーザ/新規ユーザ双方に招待可能
- 招待履歴と状態確認
- メンバ除名 / role 変更
- Owner / 代表 譲渡

### 運営視点
- inactive owner/representative の検出
- 強制譲渡 / 強制解散
- 全 membership 監査ログ閲覧

---

## 参考資料

- `docs/design/family/` (旧 family 設計書、本設計で superseded)
- `docs/design/org/` (org 設計書、本設計で一部 supersede)
- `docs/design/operator/` (operator UI 全体、本設計の §5 と整合)
- `supabase/migrations/20260508120000_operator_phase_4_5_foundation.sql` (plan seed)
