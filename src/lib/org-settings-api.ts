/**
 * GET / PUT /api/org/settings (組織の設定) の、受け取る本文と返す列 (#1735)
 *
 * 組織の設定の画面 (Web: src/app/(org)/org/settings/page.tsx) が送るキーは @homegohan/shared の ORG_SETTINGS_FORM_KEYS。
 * ここのスキーマはその全部を受け取り、organizations の同じ名前の列に保存する。
 * 画面が送るキーとこのスキーマのキーの一致は tests/org-settings-keys.test.tsx が検査する
 * (以前はスキーマが name / plan しか知らず、画面が送った業種・従業員数・連絡先を捨てたまま 200 を返していた)。
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
import { ORG_PLAN_VALUES } from '@/lib/org-plans';

/** 組織の設定で選べるプラン (organizations.plan に書ける値。運営の組織作成と同じ一覧 ORG_PLAN_VALUES) */
export const ORG_SETTINGS_PLANS = ORG_PLAN_VALUES;

/** 自由記述の項目: 前後の空白を除き、空なら null (保存されている値を消す) にする */
function nullableText(maxLength: number) {
  return z.string().trim().max(maxLength).nullable().optional();
}

/** PUT /api/org/settings の本文のキーごとの決まり (キーの一覧は tests/org-settings-keys.test.tsx が画面と突き合わせる) */
export const OrgSettingsUpdateFieldsSchema = z.object({
  name: z.string().min(1).max(ORG_SETTINGS_NAME_MAX_LENGTH).optional(),
  plan: z.enum(ORG_SETTINGS_PLANS).optional(),
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

export const OrgSettingsUpdateSchema = OrgSettingsUpdateFieldsSchema.refine(
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
  if (fields.plan !== undefined) row.plan = fields.plan;
  if (fields.industry !== undefined) row.industry = emptyToNull(fields.industry);
  if (fields.employee_count !== undefined) row.employee_count = fields.employee_count;
  if (fields.contact_email !== undefined) row.contact_email = emptyToNull(fields.contact_email);
  if (fields.contact_name !== undefined) row.contact_name = emptyToNull(fields.contact_name);
  return row;
}

/** GET / PUT が返す organizations の列 (@homegohan/shared の OrgSettingsData と同じ並び) */
export const ORG_SETTINGS_SELECT_COLUMNS =
  'id, name, plan, industry, employee_count, contact_email, contact_name, subscription_status, subscription_expires_at, created_at, updated_at';
