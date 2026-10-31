/**
 * GET / PUT /api/org/settings (組織の設定) の、受け取る本文と返す列 (#1735)
 *
 * 組織の設定の画面 (Web: src/app/(org)/org/settings/page.tsx) が送るキーは @homegohan/shared の ORG_SETTINGS_FORM_KEYS。
 * ここのスキーマはその全部を受け取り、organizations の同じ名前の列に保存する。
 * 画面が送るキーとこのスキーマのキーの一致は tests/org-settings-keys.test.tsx が検査する
 * (以前はスキーマが name / plan しか知らず、画面が送った業種・従業員数・連絡先を捨てたまま 200 を返していた)。
 *
 * プラン (organizations.plan) は組織の管理者の経路では変えない (#1912。オーナーの選択 (2026-10-22・選択式)「運営だけが変える (推奨)」:
 * 「組織の管理者の設定画面では段階を表示だけにし、変更は運営の画面からだけにする (組織の契約は運営が決める)」)。
 * 本文に plan があれば 400 VALIDATION_ERROR で断る (黙って捨てて 200 を返さない)。変えるのは運営の
 * PATCH /api/admin/organizations/{id} (service_role) だけ。DB でもトリガー trg_guard_organizations_plan_value (関数 guard_organizations_plan_value) が、
 * ログインした利用者 (authenticated) と anon が plan を変えること自体を拒む (20261022170000_org_plan_operator_only.sql)。
 */

import { z } from 'zod';
import {
  ORG_CONTACT_EMAIL_MAX_LENGTH,
  ORG_CONTACT_NAME_MAX_LENGTH,
  ORG_EMPLOYEE_COUNT_MAX,
  ORG_EMPLOYEE_COUNT_MIN,
  ORG_INDUSTRY_MAX_LENGTH,
  ORG_SETTINGS_NAME_MAX_LENGTH,
} from '@homegohan/shared';

/** 本文に plan があったときの理由の文 (VALIDATION_ERROR の details.fieldErrors.plan に入る) */
export const ORG_SETTINGS_PLAN_OPERATOR_ONLY_MESSAGE = 'プランは運営だけが変更できます';

/** 自由記述の項目: 前後の空白を除き、空なら null (保存されている値を消す) にする */
function nullableText(maxLength: number) {
  return z.string().trim().max(maxLength).nullable().optional();
}

/** PUT /api/org/settings の本文のキーごとの決まり (キーの一覧は tests/org-settings-keys.test.tsx が画面と突き合わせる) */
export const OrgSettingsUpdateFieldsSchema = z.object({
  name: z.string().min(1).max(ORG_SETTINGS_NAME_MAX_LENGTH).optional(),
  industry: nullableText(ORG_INDUSTRY_MAX_LENGTH),
  employee_count: z.number().int().min(ORG_EMPLOYEE_COUNT_MIN).max(ORG_EMPLOYEE_COUNT_MAX).nullable().optional(),
  // 空文字は「消す」(null) として受ける。空でなければメールアドレスの形であること
  contact_email: z
    .union([z.literal(''), z.string().trim().max(ORG_CONTACT_EMAIL_MAX_LENGTH).email()])
    .nullable()
    .optional(),
  contact_name: nullableText(ORG_CONTACT_NAME_MAX_LENGTH),
});

export type OrgSettingsUpdateFields = z.infer<typeof OrgSettingsUpdateFieldsSchema>;

/**
 * PUT /api/org/settings の本文。保存するキーは OrgSettingsUpdateFieldsSchema のキーだけ。
 * 運営だけが変える列 (plan) は、値が何であっても (今と同じ値・null でも) 拒む
 * (z.never: キーが無いときだけ通る。JSON では undefined を送れないので、キーがあれば必ず 400)
 */
export const OrgSettingsUpdateSchema = OrgSettingsUpdateFieldsSchema.extend({
  plan: z.never({ message: ORG_SETTINGS_PLAN_OPERATOR_ONLY_MESSAGE }).optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: '更新するフィールドを少なくとも1つ指定してください' },
);

/** organizations に書く行 (送られたキーだけ。空文字は null) */
export type OrgSettingsUpdateRow = {
  [K in keyof OrgSettingsUpdateFields]?: Exclude<OrgSettingsUpdateFields[K], undefined>;
};

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value;
}

/**
 * 検査を通った本文から、organizations に書く行を作る。送られなかったキーは含めない (変えない)。
 * 自由記述の項目の空文字は null にする (空文字と未入力を DB で区別しない)
 */
export function toOrgSettingsUpdateRow(fields: OrgSettingsUpdateFields): OrgSettingsUpdateRow {
  const row: OrgSettingsUpdateRow = {};
  if (fields.name !== undefined) row.name = fields.name;
  if (fields.industry !== undefined) row.industry = emptyToNull(fields.industry);
  if (fields.employee_count !== undefined) row.employee_count = fields.employee_count;
  if (fields.contact_email !== undefined) row.contact_email = emptyToNull(fields.contact_email);
  if (fields.contact_name !== undefined) row.contact_name = emptyToNull(fields.contact_name);
  return row;
}

/** GET / PUT が返す organizations の列 (@homegohan/shared の OrgSettingsData と同じ並び) */
export const ORG_SETTINGS_SELECT_COLUMNS =
  'id, name, plan, industry, employee_count, contact_email, contact_name, subscription_status, subscription_expires_at, created_at, updated_at';
