// packages/shared/src/membership-settings.ts
// #1917 メンバーシップ設定の画面のパス。Web (退会の 409 の案内の行き先) とモバイル (409 の Alert から開く WebView の画面) で共用する
// (docs/design/family/11-self-dissolve.md §12・§15.5。DSR_SETTINGS_PATH と同じ考え方で 2 か所に持たない)

/** Web のメンバーシップ設定の画面 (家族・組織の所属、代表者・オーナーの譲渡へのリンク、解散) */
export const MEMBERSHIP_SETTINGS_PATH = '/settings/membership';
