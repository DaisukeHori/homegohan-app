/**
 * 本文を読む API route の、本文の NULL 文字 (U+0000) の 400 (#1657)
 *
 * Postgres の text / jsonb は U+0000 を受け付けないので、本文の文字列 (メモ・名前・自由記述・AI への入力・組織の部署名や
 * チャレンジの説明・招待の文など) に NULL 文字があると、insert / update / upsert / rpc で DB が拒んで 500 になっていた
 * (#1622 で POST /api/ai/menu/weekly/request だけ直した)。本文 (JSON / テキスト) を読む handler は、だれが呼ぶ route でも
 * (利用者・家族の代表・組織の管理者・運営の管理画面)、handler の最初 (認証・DB に触れる前) に rejectNullCharacterBody で
 * 400 INVALID_CHARACTER を返す。入口で確かめない handler は EXCLUDED に理由とともに載せる。
 *
 * - 表の各 route: NULL 文字があれば 400 INVALID_CHARACTER を返し、Supabase のクライアントを作らない (DB に触れない)
 * - 表の各 route: NULL 文字が無ければ断らない (入口を通って、その先の処理に進む)
 * - 表と実コードの一致: rejectNullCharacterBody を呼ぶ handler が、表とちょうど同じ
 *   (表に無い route で呼んでいる・表にある route で呼ばなくなった、のどちらも見つける)
 * - 洗い漏れの検出: 本文を読む handler (同じファイルの関数に読ませるものを含む) は、表か EXCLUDED のどちらかにちょうど 1 回載る
 *   (新しく本文を読む handler を足して、確かめを付け忘れると赤になる)
 * - 本文の形 (#1917 の続き): NESTED_BODY_FILES の route は nested ({ error: { code, message } })、ほかは flat ({ error, code }) で返す。
 *   route がほかの失敗で返す本文が nested だけ / flat だけなら、NULL 文字の 400 も同じ形であること (構文木で数える) を確かめる
 *   (以前は全 route が flat で、error.message を読む運営の画面などでは理由の文が出なかった)
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from '@/lib/api/null-character';
import { applyHeavyUnitTestTimeout } from '../../../tests/helpers/heavy-unit-test-timeout';

// テストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる。このファイルだけ延ばす
// (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts。#1605)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const mockCreateClient = vi.fn(async () => {
  throw new Error('Supabase のクライアントは、NULL 文字の確かめのあとでしか作られないはず');
});
vi.mock('@/lib/supabase/server', () => ({ createClient: mockCreateClient }));

const NUL = '\u0000';
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000001';
const SAMPLE_DATE = '2026-01-05';
const SAMPLE_TOKEN = 'null-character-test-token';
const SAMPLE_SEGMENT = 'null-character-test';

/** 動的な区間 ([id] など) を持つ route に渡す params (どの route の区間の名前も満たす) */
type RouteParams = {
  id: string;
  sessionId: string;
  messageId: string;
  date: string;
  member_id: string;
  token: string;
  type: string;
  key: string;
};
type RouteHandler = (request: NextRequest, context: { params: Promise<RouteParams> }) => Promise<Response>;

/**
 * NULL 文字の 400 を nested ({ error: { code, message } }) で返す route (src/app/api からのファイル)。
 * route がほかの 400 で返す本文と同じ形にする (docs/design/cross/04-api-conventions.md §5.2。src/lib/api/reject-null-character.ts の shape)。
 * 運営 (admin・super-admin・operator)・家族・課金の配下と、自分の 400 を nested で返すそのほかの route
 */
const NESTED_BODY_FILES: ReadonlySet<string> = new Set([
  'admin/catalog/import/route.ts',
  'admin/data-requests/[id]/route.ts',
  'admin/finance/exports/route.ts',
  'admin/inquiries/[id]/route.ts',
  'admin/moderation/[type]/[id]/restore/route.ts',
  'admin/moderation/[type]/[id]/route.ts',
  'admin/organizations/[id]/route.ts',
  'admin/organizations/route.ts',
  'admin/sales/leads/[id]/activities/route.ts',
  'admin/sales/leads/[id]/route.ts',
  'admin/sales/leads/route.ts',
  'admin/support/tickets/[id]/assign/route.ts',
  'admin/support/tickets/[id]/messages/route.ts',
  'admin/support/tickets/[id]/route.ts',
  'admin/support/tickets/route.ts',
  'admin/users/[id]/freeze/route.ts',
  'admin/users/[id]/role/route.ts',
  'admin/users/[id]/route.ts',
  'billing/checkout/route.ts',
  'billing/checkout/sync/route.ts',
  'comparison/trigger/route.ts',
  'family/dissolve/route.ts',
  'family/groups/route.ts',
  'family/invites/[id]/accept/route.ts',
  'family/invites/route.ts',
  'family/members/[member_id]/promote/route.ts',
  'family/members/[member_id]/remove/route.ts',
  'family/members/child/route.ts',
  'family/members/me/share/route.ts',
  'family/promotions/[token]/accept/route.ts',
  'family/representative-transfer/propose/route.ts',
  'handson-tour/skip/route.ts',
  'meals/paste/route.ts',
  'menu-plans/add/route.ts',
  'operator/membership/family/[id]/dissolve/route.ts',
  'operator/membership/family/[id]/transfer/route.ts',
  'operator/membership/org/[id]/dissolve/route.ts',
  'operator/membership/org/[id]/transfer/route.ts',
  'org/departments/route.ts',
  'org/dissolve/route.ts',
  'org/invites/route.ts',
  'org/members/route.ts',
  'org/owner-transfer/propose/route.ts',
  'org/settings/route.ts',
  'push-tokens/claim/route.ts',
  'push-tokens/release/route.ts',
  'super-admin/backups/dr-tests/route.ts',
  'super-admin/coupons/[id]/apply/route.ts',
  'super-admin/coupons/[id]/route.ts',
  'super-admin/coupons/route.ts',
  'super-admin/embeddings/regenerate/route.ts',
  'super-admin/experiments/[id]/route.ts',
  'super-admin/experiments/route.ts',
  'super-admin/feature-packages/[id]/route.ts',
  'super-admin/feature-packages/route.ts',
  'super-admin/flags/[key]/route.ts',
  'super-admin/flags/route.ts',
  'super-admin/llm/quotas/route.ts',
  'super-admin/plans/[id]/price-change/route.ts',
  'super-admin/plans/[id]/route.ts',
  'super-admin/plans/route.ts',
  'super-admin/settings/route.ts',
  'super-admin/users/[id]/manual-plan/route.ts',
]);

type Entry = {
  /** src/app/api からの route のファイル */
  file: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  load: () => Promise<RouteHandler>;
};

const ENTRIES: Entry[] = [
  { file: 'account/data-requests/[id]/verify/route.ts', method: 'POST', load: async () => (await import('@/app/api/account/data-requests/[id]/verify/route')).POST },
  { file: 'account/data-requests/route.ts', method: 'POST', load: async () => (await import('@/app/api/account/data-requests/route')).POST },
  { file: 'account/delete/route.ts', method: 'POST', load: async () => (await import('@/app/api/account/delete/route')).POST },
  { file: 'admin/catalog/import/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/catalog/import/route')).POST },
  { file: 'admin/data-requests/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/data-requests/[id]/route')).PATCH },
  { file: 'admin/finance/exports/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/finance/exports/route')).POST },
  { file: 'admin/inquiries/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/inquiries/[id]/route')).PATCH },
  { file: 'admin/inquiries/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/admin/inquiries/[id]/route')).PUT },
  { file: 'admin/moderation/[type]/[id]/restore/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/moderation/[type]/[id]/restore/route')).POST },
  { file: 'admin/moderation/[type]/[id]/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/moderation/[type]/[id]/route')).POST },
  { file: 'admin/moderation/[type]/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/admin/moderation/[type]/[id]/route')).PUT },
  { file: 'admin/organizations/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/organizations/[id]/route')).PATCH },
  { file: 'admin/organizations/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/organizations/route')).POST },
  { file: 'admin/sales/leads/[id]/activities/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/sales/leads/[id]/activities/route')).POST },
  { file: 'admin/sales/leads/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/sales/leads/[id]/route')).PATCH },
  { file: 'admin/sales/leads/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/sales/leads/route')).POST },
  { file: 'admin/support/tickets/[id]/assign/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/support/tickets/[id]/assign/route')).POST },
  { file: 'admin/support/tickets/[id]/messages/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/support/tickets/[id]/messages/route')).POST },
  { file: 'admin/support/tickets/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/support/tickets/[id]/route')).PATCH },
  { file: 'admin/support/tickets/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/support/tickets/route')).POST },
  { file: 'admin/users/[id]/freeze/route.ts', method: 'DELETE', load: async () => (await import('@/app/api/admin/users/[id]/freeze/route')).DELETE },
  { file: 'admin/users/[id]/freeze/route.ts', method: 'POST', load: async () => (await import('@/app/api/admin/users/[id]/freeze/route')).POST },
  { file: 'admin/users/[id]/role/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/users/[id]/role/route')).PATCH },
  { file: 'admin/users/[id]/role/route.ts', method: 'PUT', load: async () => (await import('@/app/api/admin/users/[id]/role/route')).PUT },
  { file: 'admin/users/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/admin/users/[id]/route')).PATCH },
  { file: 'ai/analyze-fridge/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/analyze-fridge/route')).POST },
  { file: 'ai/analyze-health-checkup/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/analyze-health-checkup/route')).POST },
  { file: 'ai/analyze-meal-photo/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/analyze-meal-photo/route')).POST },
  { file: 'ai/analyze-weight-scale/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/analyze-weight-scale/route')).POST },
  { file: 'ai/classify-photo/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/classify-photo/route')).POST },
  { file: 'ai/consent/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/consent/route')).POST },
  { file: 'ai/consultation/sessions/[sessionId]/messages/[messageId]/important/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important/route')).POST },
  { file: 'ai/consultation/sessions/[sessionId]/messages/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).POST },
  { file: 'ai/consultation/sessions/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/consultation/sessions/route')).POST },
  { file: 'ai/hint/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/hint/route')).POST },
  { file: 'ai/image/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/image/generate/route')).POST },
  { file: 'ai/menu/day/regenerate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/day/regenerate/route')).POST },
  { file: 'ai/menu/meal/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/meal/generate/route')).POST },
  { file: 'ai/menu/meal/regenerate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/meal/regenerate/route')).POST },
  { file: 'ai/menu/v4/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/v4/generate/route')).POST },
  { file: 'ai/menu/v5/generate/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/v5/generate/route')).POST },
  { file: 'ai/menu/weekly/status/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/menu/weekly/status/route')).POST },
  { file: 'ai/nutrition-analysis/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/nutrition-analysis/route')).POST },
  { file: 'ai/nutrition/feedback/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/nutrition/feedback/route')).POST },
  { file: 'ai/nutrition/route.ts', method: 'POST', load: async () => (await import('@/app/api/ai/nutrition/route')).POST },
  { file: 'announcements/route.ts', method: 'POST', load: async () => (await import('@/app/api/announcements/route')).POST },
  { file: 'auth/apple/authorization/route.ts', method: 'POST', load: async () => (await import('@/app/api/auth/apple/authorization/route')).POST },
  { file: 'auth/password/change/route.ts', method: 'POST', load: async () => (await import('@/app/api/auth/password/change/route')).POST },
  { file: 'auth/password/reset/route.ts', method: 'POST', load: async () => (await import('@/app/api/auth/password/reset/route')).POST },
  { file: 'auth/sessions/current/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/auth/sessions/current/route')).PATCH },
  { file: 'billing/checkout/route.ts', method: 'POST', load: async () => (await import('@/app/api/billing/checkout/route')).POST },
  { file: 'billing/checkout/sync/route.ts', method: 'POST', load: async () => (await import('@/app/api/billing/checkout/sync/route')).POST },
  { file: 'comparison/trigger/route.ts', method: 'POST', load: async () => (await import('@/app/api/comparison/trigger/route')).POST },
  { file: 'contact/route.ts', method: 'POST', load: async () => (await import('@/app/api/contact/route')).POST },
  { file: 'csp-report/route.ts', method: 'POST', load: async () => (await import('@/app/api/csp-report/route')).POST },
  { file: 'family/dissolve/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/dissolve/route')).POST },
  { file: 'family/groups/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/groups/route')).POST },
  { file: 'family/invites/[id]/accept/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/invites/[id]/accept/route')).POST },
  { file: 'family/invites/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/invites/route')).POST },
  { file: 'family/members/[member_id]/promote/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/members/[member_id]/promote/route')).POST },
  { file: 'family/members/[member_id]/remove/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/members/[member_id]/remove/route')).POST },
  { file: 'family/members/child/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/members/child/route')).POST },
  { file: 'family/members/me/share/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/family/members/me/share/route')).PATCH },
  { file: 'family/promotions/[token]/accept/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/promotions/[token]/accept/route')).POST },
  { file: 'family/representative-transfer/propose/route.ts', method: 'POST', load: async () => (await import('@/app/api/family/representative-transfer/propose/route')).POST },
  { file: 'handson-tour/skip/route.ts', method: 'POST', load: async () => (await import('@/app/api/handson-tour/skip/route')).POST },
  { file: 'health/blood-tests/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/blood-tests/route')).POST },
  { file: 'health/challenges/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/challenges/route')).POST },
  { file: 'health/checkups/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/checkups/[id]/route')).PUT },
  { file: 'health/checkups/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/checkups/route')).POST },
  { file: 'health/goals/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/goals/[id]/route')).PUT },
  { file: 'health/goals/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/goals/route')).POST },
  { file: 'health/notifications/preferences/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/notifications/preferences/route')).PUT },
  { file: 'health/records/[date]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/health/records/[date]/route')).PUT },
  { file: 'health/records/quick/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/records/quick/route')).POST },
  { file: 'health/records/route.ts', method: 'POST', load: async () => (await import('@/app/api/health/records/route')).POST },
  { file: 'log/route.ts', method: 'POST', load: async () => (await import('@/app/api/log/route')).POST },
  { file: 'meal-plans/add-from-photo/route.ts', method: 'POST', load: async () => (await import('@/app/api/meal-plans/add-from-photo/route')).POST },
  { file: 'meal-plans/meals/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/meal-plans/meals/[id]/route')).PATCH },
  { file: 'meal-plans/meals/reorder/route.ts', method: 'POST', load: async () => (await import('@/app/api/meal-plans/meals/reorder/route')).POST },
  { file: 'meal-plans/meals/route.ts', method: 'POST', load: async () => (await import('@/app/api/meal-plans/meals/route')).POST },
  { file: 'meals/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/meals/[id]/route')).PATCH },
  { file: 'meals/paste/route.ts', method: 'POST', load: async () => (await import('@/app/api/meals/paste/route')).POST },
  { file: 'meals/route.ts', method: 'POST', load: async () => (await import('@/app/api/meals/route')).POST },
  { file: 'menu-plans/add/route.ts', method: 'POST', load: async () => (await import('@/app/api/menu-plans/add/route')).POST },
  { file: 'notification-preferences/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/notification-preferences/route')).PATCH },
  { file: 'nutrition/targets/route.ts', method: 'PUT', load: async () => (await import('@/app/api/nutrition/targets/route')).PUT },
  { file: 'onboarding/progress/route.ts', method: 'POST', load: async () => (await import('@/app/api/onboarding/progress/route')).POST },
  { file: 'operator/membership/family/[id]/dissolve/route.ts', method: 'POST', load: async () => (await import('@/app/api/operator/membership/family/[id]/dissolve/route')).POST },
  { file: 'operator/membership/family/[id]/transfer/route.ts', method: 'POST', load: async () => (await import('@/app/api/operator/membership/family/[id]/transfer/route')).POST },
  { file: 'operator/membership/org/[id]/dissolve/route.ts', method: 'POST', load: async () => (await import('@/app/api/operator/membership/org/[id]/dissolve/route')).POST },
  { file: 'operator/membership/org/[id]/transfer/route.ts', method: 'POST', load: async () => (await import('@/app/api/operator/membership/org/[id]/transfer/route')).POST },
  { file: 'org/challenges/route.ts', method: 'POST', load: async () => (await import('@/app/api/org/challenges/route')).POST },
  { file: 'org/challenges/route.ts', method: 'PUT', load: async () => (await import('@/app/api/org/challenges/route')).PUT },
  { file: 'org/departments/route.ts', method: 'POST', load: async () => (await import('@/app/api/org/departments/route')).POST },
  { file: 'org/departments/route.ts', method: 'PUT', load: async () => (await import('@/app/api/org/departments/route')).PUT },
  { file: 'org/dissolve/route.ts', method: 'POST', load: async () => (await import('@/app/api/org/dissolve/route')).POST },
  { file: 'org/invites/route.ts', method: 'POST', load: async () => (await import('@/app/api/org/invites/route')).POST },
  { file: 'org/members/route.ts', method: 'POST', load: async () => (await import('@/app/api/org/members/route')).POST },
  { file: 'org/owner-transfer/propose/route.ts', method: 'POST', load: async () => (await import('@/app/api/org/owner-transfer/propose/route')).POST },
  { file: 'org/settings/route.ts', method: 'PUT', load: async () => (await import('@/app/api/org/settings/route')).PUT },
  { file: 'pantry/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/pantry/[id]/route')).PATCH },
  { file: 'pantry/from-photo/route.ts', method: 'POST', load: async () => (await import('@/app/api/pantry/from-photo/route')).POST },
  { file: 'pantry/route.ts', method: 'POST', load: async () => (await import('@/app/api/pantry/route')).POST },
  { file: 'performance/analyze/route.ts', method: 'POST', load: async () => (await import('@/app/api/performance/analyze/route')).POST },
  { file: 'performance/checkins/route.ts', method: 'POST', load: async () => (await import('@/app/api/performance/checkins/route')).POST },
  { file: 'performance/plans/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/performance/plans/route')).PATCH },
  { file: 'performance/plans/route.ts', method: 'POST', load: async () => (await import('@/app/api/performance/plans/route')).POST },
  { file: 'profile/route.ts', method: 'POST', load: async () => (await import('@/app/api/profile/route')).POST },
  { file: 'profile/route.ts', method: 'PUT', load: async () => (await import('@/app/api/profile/route')).PUT },
  { file: 'push-tokens/claim/route.ts', method: 'POST', load: async () => (await import('@/app/api/push-tokens/claim/route')).POST },
  { file: 'push-tokens/release/route.ts', method: 'POST', load: async () => (await import('@/app/api/push-tokens/release/route')).POST },
  { file: 'recipes/[id]/comments/route.ts', method: 'POST', load: async () => (await import('@/app/api/recipes/[id]/comments/route')).POST },
  { file: 'recipes/[id]/route.ts', method: 'PUT', load: async () => (await import('@/app/api/recipes/[id]/route')).PUT },
  { file: 'recipes/route.ts', method: 'POST', load: async () => (await import('@/app/api/recipes/route')).POST },
  { file: 'shopping-list/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/shopping-list/[id]/route')).PATCH },
  { file: 'shopping-list/add-recipe/route.ts', method: 'POST', load: async () => (await import('@/app/api/shopping-list/add-recipe/route')).POST },
  { file: 'shopping-list/regenerate/route.ts', method: 'POST', load: async () => (await import('@/app/api/shopping-list/regenerate/route')).POST },
  { file: 'shopping-list/route.ts', method: 'DELETE', load: async () => (await import('@/app/api/shopping-list/route')).DELETE },
  { file: 'shopping-list/route.ts', method: 'POST', load: async () => (await import('@/app/api/shopping-list/route')).POST },
  { file: 'storage/signed-urls/route.ts', method: 'POST', load: async () => (await import('@/app/api/storage/signed-urls/route')).POST },
  { file: 'super-admin/backups/dr-tests/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/backups/dr-tests/route')).POST },
  { file: 'super-admin/coupons/[id]/apply/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/coupons/[id]/apply/route')).POST },
  { file: 'super-admin/coupons/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/super-admin/coupons/[id]/route')).PATCH },
  { file: 'super-admin/coupons/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/coupons/route')).POST },
  { file: 'super-admin/embeddings/regenerate/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/embeddings/regenerate/route')).POST },
  { file: 'super-admin/experiments/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/super-admin/experiments/[id]/route')).PATCH },
  { file: 'super-admin/experiments/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/experiments/route')).POST },
  { file: 'super-admin/feature-packages/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/super-admin/feature-packages/[id]/route')).PATCH },
  { file: 'super-admin/feature-packages/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/feature-packages/route')).POST },
  { file: 'super-admin/flags/[key]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/super-admin/flags/[key]/route')).PATCH },
  { file: 'super-admin/flags/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/flags/route')).POST },
  { file: 'super-admin/llm/quotas/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/super-admin/llm/quotas/route')).PATCH },
  { file: 'super-admin/plans/[id]/price-change/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/plans/[id]/price-change/route')).POST },
  { file: 'super-admin/plans/[id]/route.ts', method: 'PATCH', load: async () => (await import('@/app/api/super-admin/plans/[id]/route')).PATCH },
  { file: 'super-admin/plans/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/plans/route')).POST },
  { file: 'super-admin/settings/route.ts', method: 'PUT', load: async () => (await import('@/app/api/super-admin/settings/route')).PUT },
  { file: 'super-admin/users/[id]/manual-plan/route.ts', method: 'DELETE', load: async () => (await import('@/app/api/super-admin/users/[id]/manual-plan/route')).DELETE },
  { file: 'super-admin/users/[id]/manual-plan/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/users/[id]/manual-plan/route')).POST },
  { file: 'support/users/[id]/notes/route.ts', method: 'POST', load: async () => (await import('@/app/api/support/users/[id]/notes/route')).POST },
];

/**
 * 本文を読むが、入口で NULL 文字を確かめない handler と、その理由 ("METHOD src/app/api からのファイル")。
 * どれも、本文の NULL 文字で 500 にならない (または、入口より前に確かめることがある作り) ことを理由に書く
 */
const EXCLUDED: Readonly<Record<string, string>> = {
  'POST ai/menu/weekly/request/route.ts':
    '#1622 で、本文を読んだ直後 (DB に渡す前) に containsNullCharacter で同じ 400 INVALID_CHARACTER を返している (src/__tests__/api/ai/menu/weekly-request.test.ts が確かめる)',
  'POST admin/finance/refunds/route.ts':
    '理由 (reason) の NULL 文字は RefundRequestSchema (src/lib/admin/finance-schemas.ts) の refine で 400 VALIDATION_ERROR にしている (tests/admin-finance-refunds-route.test.ts がこの code を確かめる)。ほかの文字列は uuid・決済 ID の形式・英字 3 文字の検査を通ったものだけが DB に届く',
  'POST auth/login/route.ts':
    '別のサイトからの要求の拒否と IP ごとの回数制限 (docs/design/cross/01-auth-session.md §3.2) を、本文を読むより前に行う作り。email は z.email() の形式の検査を通ったものだけが DB (rpc) に届き、password と captchaToken は Auth API と Turnstile にだけ渡す',
  'POST auth/mfa/verify/route.ts':
    'factor_id は z.uuid()、code は 6 桁の数字 (TOTP_CODE_PATTERN) の検査を通ったものだけが Supabase に届く。NULL 文字を含む値は 400 VALIDATION_ERROR で、DB に書かない',
  'POST auth/mfa/recover/route.ts':
    'code は normalizeBackupCode で英数字以外 (NULL 文字を含む) を取り除き、DB には user_id と SHA-256 の hex だけが届く。監査の details も数だけ',
  'POST super-admin/admins/[id]/mfa/reset/route.ts':
    'reason の NULL 文字は MfaResetBodySchema (src/lib/auth/mfa/schemas.ts) の refine で 400 OP_INVALID_INPUT にする (tests/super-admin-mfa-reset-route.test.ts が確かめる)。identity_check は列挙、identity_confirmed は true だけ',
  'POST auth/native-bridge/code/route.ts':
    'Bearer の確認と本文の長さの上限 (MAX_BODY_CHARS) を、本文を JSON として読むより前に行う作り。refresh_token を渡す rpc (issue_native_bridge_code) の失敗は 503 で返す (500 にならない)',
  'POST legal/accept/route.ts':
    'Content-Type と本文の長さの上限を、本文を JSON として読むより前に確かめる作り。本文の文字列 (terms_version・privacy_version) は今の版と一致しなければ 409 で、DB には今の版の定数だけが届く',
  'POST upload/route.ts':
    '本文は multipart/form-data で JSON ではない (rejectNullCharacterBody は JSON として読めない本文を確かめない)。ファイルは Storage に置き、DB の text / jsonb には書かない',
  'POST webhooks/stripe/route.ts':
    '本文は Stripe が署名して送るもので、利用者は書けない。大きさの上限と署名の確認より前に本文を JSON として読まない作り (billing/01 §9.6)',
  'POST webhooks/revenuecat/route.ts':
    '本文は RevenueCat が署名して送るもので、利用者は書けない。大きさの上限と署名の確認より前に本文を JSON として読まない作り (billing/03 §9.1)',
  'POST webhooks/resend/route.ts':
    '本文は Resend が署名して送るもので、利用者は書けない。大きさの上限と署名の確認より前に本文を JSON として読まない作り (route の冒頭のコメント)',
};

const API_ROOT = path.resolve(__dirname, '../../app/api');

function makeRequest(method: Entry['method'], body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/null-character-test', {
    method,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  });
}

function makeContext(): { params: Promise<RouteParams> } {
  return {
    params: Promise.resolve({
      id: SAMPLE_UUID,
      sessionId: SAMPLE_UUID,
      messageId: SAMPLE_UUID,
      date: SAMPLE_DATE,
      member_id: SAMPLE_UUID,
      token: SAMPLE_TOKEN,
      type: SAMPLE_SEGMENT,
      key: SAMPLE_SEGMENT,
    }),
  };
}

/** 欄の名前をいくつか並べた本文 (route ごとの欄の名前を追わなくても、どれかの欄に NULL 文字が入る。入口は本文のどの文字列も見る) */
function freeTextBody(text: string): Record<string, unknown> {
  return {
    note: text,
    name: text,
    title: text,
    content: text,
    message: text,
    memo: text,
    dishes: [{ name: text }],
    ingredients: [{ name: text, amount: '1' }],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

/** NULL 文字の 400 の本文 (手で書いた期待値。形ごと) */
const FLAT_BODY = { error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE };
const NESTED_BODY = { error: { code: NULL_CHARACTER_ERROR_CODE, message: NULL_CHARACTER_ERROR_MESSAGE } };

describe.each(ENTRIES)('$method /api/$file (#1657)', (entry) => {
  const nested = NESTED_BODY_FILES.has(entry.file);

  it(`本文に NULL 文字があれば、DB に触れる前に 400 INVALID_CHARACTER を返す (本文は ${nested ? 'nested' : 'flat'})`, async () => {
    const handler = await entry.load();
    const res = await handler(makeRequest(entry.method, freeTextBody(`メモ${NUL}`)), makeContext());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(nested ? NESTED_BODY : FLAT_BODY);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('本文に NULL 文字が無ければ入口では断らない (その先の処理に進む)', async () => {
    const handler = await entry.load();
    // この先の処理は Supabase のクライアントを作れずに失敗する (例外か 4xx / 5xx)。ここでは NULL 文字の 400 でないことだけを見る
    const res = await handler(makeRequest(entry.method, freeTextBody('ふつうのメモ')), makeContext()).catch(() => null);
    if (res !== null) {
      const json: unknown = await res.json().catch(() => null);
      expect(json).not.toEqual(expect.objectContaining({ code: NULL_CHARACTER_ERROR_CODE }));
      expect(json).not.toEqual(expect.objectContaining({ error: expect.objectContaining({ code: NULL_CHARACTER_ERROR_CODE }) }));
    }
  });
});

/** 本文を読む式 (handler の引数の request / req の json() / text() / formData()、または readJsonBody(...)) */
const BODY_READ_PATTERN = /\b(?:request|req|_request|_req)\.(?:json|text|formData)\(\)|\breadJsonBody\(/;
const HANDLER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

type TopLevelFunction = { name: string; exported: boolean; source: string };

/**
 * ファイルの最上位の関数 (function 宣言と const の矢印関数) を、宣言の行から最上位の閉じ括弧 (行頭の "}") までで切り出す。
 * route のファイルは 2 文字の字下げなので、行頭の "}" は最上位の関数の終わりだけ
 */
function topLevelFunctions(source: string): TopLevelFunction[] {
  const lines = source.split('\n');
  const result: TopLevelFunction[] = [];
  for (let start = 0; start < lines.length; start++) {
    const match =
      /^(export )?(?:async )?function (\w+)\s*\(/.exec(lines[start]) ??
      /^(export )?const (\w+)\s*=\s*(?:async\s*)?\(/.exec(lines[start]);
    if (!match) continue;
    let end = start;
    while (end < lines.length && !/^\};?\s*$/.test(lines[end])) end++;
    result.push({ name: match[2], exported: match[1] !== undefined, source: lines.slice(start, end + 1).join('\n') });
  }
  return result;
}

/** handler (export された GET / POST / PUT / PATCH / DELETE) の名前 → ソース */
function handlerSources(source: string): Map<string, string> {
  return new Map(
    topLevelFunctions(source)
      .filter((fn) => fn.exported && HANDLER_METHODS.has(fn.name))
      .map((fn) => [fn.name, fn.source]),
  );
}

/** 本文を読む handler の名前 (同じファイルの関数に本文を読ませる handler を含む。呼び出しの連鎖をたどる) */
function bodyReadingHandlers(source: string): string[] {
  const functions = topLevelFunctions(source);
  const readers = new Set(functions.filter((fn) => BODY_READ_PATTERN.test(fn.source)).map((fn) => fn.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const fn of functions) {
      if (readers.has(fn.name)) continue;
      const body = fn.source.split('\n').slice(1).join('\n');
      if ([...readers].some((name) => new RegExp(`\\b${name}\\(`).test(body))) {
        readers.add(fn.name);
        grew = true;
      }
    }
  }
  return functions.filter((fn) => fn.exported && HANDLER_METHODS.has(fn.name) && readers.has(fn.name)).map((fn) => fn.name);
}

function listRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) return listRouteFiles(full);
    return dirent.name === 'route.ts' ? [full] : [];
  });
}

function routeKey(method: string, file: string): string {
  return `${method} ${path.relative(API_ROOT, file).split(path.sep).join('/')}`;
}

const entryKeys = ENTRIES.map((entry) => `${entry.method} ${entry.file}`);

describe('NULL 文字の入口の確かめを持つ route の一覧 (#1657)', () => {
  it('rejectNullCharacterBody を呼ぶ handler は、上の表の route とちょうど同じ', () => {
    const actual = listRouteFiles(API_ROOT).flatMap((file) =>
      [...handlerSources(fs.readFileSync(file, 'utf-8'))]
        .filter(([, body]) => /await rejectNullCharacterBody\(\w+(?:, \{ shape: 'nested' \})?\)/.test(body))
        .map(([method]) => routeKey(method, file)),
    );

    expect([...actual].sort()).toEqual([...entryKeys].sort());
  });

  it('本文を読む handler は、表か EXCLUDED のどちらかにちょうど 1 回載っている (洗い漏れ・古い除外が無い)', () => {
    const bodyReaders = listRouteFiles(API_ROOT).flatMap((file) =>
      bodyReadingHandlers(fs.readFileSync(file, 'utf-8')).map((method) => routeKey(method, file)),
    );
    const listed = [...entryKeys, ...Object.keys(EXCLUDED)];

    expect(new Set(listed).size, '表と EXCLUDED の重なり・表の重複').toBe(listed.length);
    expect([...bodyReaders].sort()).toEqual([...listed].sort());
  });

  it('同じファイルの関数に本文を読ませる handler も、本文を読む handler として数える (洗い漏れの検出の前提)', () => {
    const source = [
      'async function update(request: Request) {',
      '  const body = await request.json();',
      '  return body;',
      '}',
      'export async function GET() {',
      '  return null;',
      '}',
      'export async function PATCH(request: Request) {',
      '  return update(request);',
      '}',
    ].join('\n');

    expect(bodyReadingHandlers(source)).toEqual(['PATCH']);
  });

  it('表の各 handler は、最初の文で本文を確かめる (認証・DB・ほかの処理より前。渡すのは handler の第 1 引数)', () => {
    for (const entry of ENTRIES) {
      const source = fs.readFileSync(path.join(API_ROOT, entry.file), 'utf-8');
      const body = handlerSources(source).get(entry.method) ?? '';
      const requestParam = /^export (?:async )?function \w+\s*\(\s*(\w+)/.exec(body)?.[1];
      const codeLines = body
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('//') && !/^[{)]/.test(line) && !/^\w+: /.test(line));
      expect(requestParam, `${entry.method} ${entry.file}`).toBeDefined();
      const shapeArgument = NESTED_BODY_FILES.has(entry.file) ? ", { shape: 'nested' }" : '';
      expect(codeLines[0], `${entry.method} ${entry.file}`).toBe(
        `const nullCharacterRejection = await rejectNullCharacterBody(${requestParam}${shapeArgument})${codeLines[0]?.endsWith(';') ? ';' : ''}`,
      );
      expect(codeLines[1], `${entry.method} ${entry.file}`).toMatch(/^if \(nullCharacterRejection\) return nullCharacterRejection;?$/);
    }
  });
});

/** route のファイルの失敗の本文の形を数える: `NextResponse.json` / `Response.json` の本文の error がオブジェクト (nested) か文 (flat) か */
function errorBodyShapeCounts(source: string): { nested: number; flat: number } {
  const sf = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  let nested = 0;
  let flat = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'json' &&
      ts.isIdentifier(node.expression.expression) &&
      ['NextResponse', 'Response'].includes(node.expression.expression.text)
    ) {
      const body = node.arguments[0];
      if (body && ts.isObjectLiteralExpression(body)) {
        for (const property of body.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'error') continue;
          const value = property.initializer;
          if (ts.isObjectLiteralExpression(value)) nested += 1;
          else if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) flat += 1;
          else if (ts.isIdentifier(value) && /MESSAGE$/.test(value.text)) flat += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { nested, flat };
}

describe('NULL 文字の 400 の本文の形は、route のほかの失敗の本文の形と同じ (#1917 の続き)', () => {
  it('数え方: error がオブジェクトなら nested、文 (文字列・テンプレート・〜MESSAGE の定数) なら flat', () => {
    const source = [
      "const a = NextResponse.json({ error: { code: 'X', message: '文' } }, { status: 400 });",
      "const b = NextResponse.json({ error: '文', code: 'X' }, { status: 400 });",
      'const c = Response.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 });',
      'const d = NextResponse.json({ data: 1 });',
    ].join('\n');
    expect(errorBodyShapeCounts(source)).toEqual({ nested: 1, flat: 2 });
  });

  it('NESTED_BODY_FILES は表の route だけ', () => {
    const files = new Set(ENTRIES.map((entry) => entry.file));
    expect([...NESTED_BODY_FILES].filter((file) => !files.has(file))).toEqual([]);
  });

  it('ほかの本文が nested だけの route は NESTED_BODY_FILES に入り、flat だけの route は入らない', () => {
    const mismatches: string[] = [];
    for (const file of new Set(ENTRIES.map((entry) => entry.file))) {
      const { nested, flat } = errorBodyShapeCounts(fs.readFileSync(path.join(API_ROOT, file), 'utf-8'));
      if (nested > 0 && flat === 0 && !NESTED_BODY_FILES.has(file)) mismatches.push(`${file}: nested ${nested} 件なのに flat`);
      if (flat > 0 && nested === 0 && NESTED_BODY_FILES.has(file)) mismatches.push(`${file}: flat ${flat} 件なのに nested`);
    }
    expect(mismatches).toEqual([]);
  });
});
