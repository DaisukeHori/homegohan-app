/**
 * 組織の設定 (/org/settings) の、Web とモバイルで共通の決まり (#1735)
 *
 * 組織の設定の画面 (Web: src/app/(org)/org/settings/page.tsx、モバイル: apps/mobile/app/(org)/org/settings.tsx) が
 * PUT /api/org/settings に送る本文は、このファイルの buildOrgSettingsUpdateBody だけで作る。
 * route の受け取るスキーマ (src/lib/org-settings-api.ts) は ORG_SETTINGS_FORM_KEYS の全部を受け取る。
 * 画面が送るキーと route が受け取るキーの一致は tests/org-settings-keys.test.tsx が検査する
 * (以前は画面が camelCase のキーを送り、route がそれを知らずに捨てたまま「保存しました」と出していた)。
 *
 * 保存する項目の根拠: 画面の構成 (docs/design/org/03-ui-spec.md §20.1 の BasicInfoForm = 組織名/業種/従業員数/ロゴ/連絡先)。
 * 列は organizations の industry / employee_count / contact_email / contact_name (DB に既にある)。
 * API のキーは snake_case (docs/design/cross/04-api-conventions.md §12)。
 */

/** 組織の設定の画面が保存する項目 (= PUT /api/org/settings に送るキー)。ロゴは画面に入力欄が無いので含めない */
export const ORG_SETTINGS_FORM_KEYS = [
  'name',
  'industry',
  'employee_count',
  'contact_email',
  'contact_name',
] as const;

export type OrgSettingsFormKey = (typeof ORG_SETTINGS_FORM_KEYS)[number];

/** 組織名の最大文字数 (PUT /api/org/settings の従来の上限。運営の組織作成 src/app/api/admin/organizations/route.ts と同じ) */
export const ORG_SETTINGS_NAME_MAX_LENGTH = 200;
/** 従業員数の下限 (docs/requirements/02-organization-management.md §10.1「従業員数 1-1,000,000」) */
export const ORG_EMPLOYEE_COUNT_MIN = 1;
/** 従業員数の上限 (同上) */
export const ORG_EMPLOYEE_COUNT_MAX = 1_000_000;
/**
 * 業種の最大文字数。要件 (§10.1) は enum (IT / 製造 / 小売 / etc.) だが一覧が決まっていないため、
 * 自由記述として受け、営業の見込み客 (sales_leads.industry varchar(100)) と同じ長さで切る
 */
export const ORG_INDUSTRY_MAX_LENGTH = 100;
/** 担当者名の最大文字数 (sales_leads.contact_name varchar(100) と同じ長さ) */
export const ORG_CONTACT_NAME_MAX_LENGTH = 100;
/** 連絡先メールの最大文字数 (sales_leads.contact_email varchar(255) と同じ長さ) */
export const ORG_CONTACT_EMAIL_MAX_LENGTH = 255;

/** 画面の入力欄の値 (どれも入力されたままの文字列) */
export interface OrgSettingsFormValues {
  name: string;
  industry: string;
  employeeCount: string;
  contactEmail: string;
  contactName: string;
}

/** PUT /api/org/settings に送る本文。空欄は null (保存されている値を消す) */
export interface OrgSettingsUpdateBody {
  name: string;
  industry: string | null;
  employee_count: number | null;
  contact_email: string | null;
  contact_name: string | null;
}

/** GET / PUT /api/org/settings が data として返す組織の設定 */
export interface OrgSettingsData {
  id: string;
  name: string;
  plan: string | null;
  industry: string | null;
  employee_count: number | null;
  contact_email: string | null;
  contact_name: string | null;
  subscription_status: string | null;
  subscription_expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export type OrgSettingsBodyResult =
  | { ok: true; body: OrgSettingsUpdateBody }
  | { ok: false; message: string };

export const ORG_SETTINGS_NAME_REQUIRED_MESSAGE = '組織名を入力してください';
/** 3 桁ごとにカンマを入れる (モバイルの JS エンジンの Intl に頼らない) */
function withThousandsSeparator(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE = `従業員数は ${withThousandsSeparator(ORG_EMPLOYEE_COUNT_MIN)} から ${withThousandsSeparator(ORG_EMPLOYEE_COUNT_MAX)} までの整数で入力してください`;

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 入力欄の値から PUT /api/org/settings の本文を作る。
 * 従業員数が整数でない・範囲の外のときは送らずに理由を返す
 * (Number('abc') は NaN で、JSON にすると null になり、保存されている値を黙って消してしまうため)。
 */
export function buildOrgSettingsUpdateBody(form: OrgSettingsFormValues): OrgSettingsBodyResult {
  const name = form.name.trim();
  if (name === '') return { ok: false, message: ORG_SETTINGS_NAME_REQUIRED_MESSAGE };

  const employeeCountText = form.employeeCount.trim();
  let employeeCount: number | null = null;
  if (employeeCountText !== '') {
    const parsed = Number(employeeCountText);
    if (!Number.isInteger(parsed) || parsed < ORG_EMPLOYEE_COUNT_MIN || parsed > ORG_EMPLOYEE_COUNT_MAX) {
      return { ok: false, message: ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE };
    }
    employeeCount = parsed;
  }

  return {
    ok: true,
    body: {
      name,
      industry: textOrNull(form.industry),
      employee_count: employeeCount,
      contact_email: textOrNull(form.contactEmail),
      contact_name: textOrNull(form.contactName),
    },
  };
}

/** GET /api/org/settings の data から、入力欄の初期値を作る */
export function orgSettingsFormValuesOf(org: OrgSettingsData): OrgSettingsFormValues {
  return {
    name: org.name ?? '',
    industry: org.industry ?? '',
    employeeCount: org.employee_count === null || org.employee_count === undefined ? '' : String(org.employee_count),
    contactEmail: org.contact_email ?? '',
    contactName: org.contact_name ?? '',
  };
}
