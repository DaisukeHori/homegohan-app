/**
 * システム設定 (system_settings) のうち、もう使われていない key (#1457)
 *
 * 運営のシステム設定の画面 (GET / PUT /api/super-admin/settings、モバイルの super-admin/settings) は、
 * ここに載せた key を読み取り専用として扱う。行そのものは消さない (本番のデータを消すことになるため)。
 */

/**
 * 使われていない key と、画面に出す説明。
 *   feature_flags: 機能フラグの置き場は feature_flags テーブルに移った (#1148)。この行はもう何も読まないので、
 *                  書き換えても何も変わらない。運営が「効いている」と思って編集しないよう、読み取り専用にする
 */
export const RETIRED_SETTING_KEYS: Readonly<Record<string, string>> = {
  feature_flags:
    'この設定は使われていません (読み取り専用)。機能フラグは運営画面の「機能フラグ」で切り替えます。',
};

export const SETTING_READ_ONLY_CODE = 'SETTING_READ_ONLY';
export const SETTING_READ_ONLY_MESSAGE =
  'この設定は使われていないため、変更できません。機能フラグは運営画面の「機能フラグ」で切り替えます。';
/** 使われていない key への PUT の状態コード (リクエストの形は正しいが、この key は変更できない) */
export const SETTING_READ_ONLY_STATUS = 409;

/** 使われていない key なら画面に出す説明、使われている key なら null */
export function retiredSettingNoteOf(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(RETIRED_SETTING_KEYS, key) ? RETIRED_SETTING_KEYS[key] : null;
}
