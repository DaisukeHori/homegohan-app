/**
 * 使い方ガイドの撮影 (#1852) と、紹介ページ (/) の新しい画面の撮影 (#1867 段 0) に使うテスト用の利用者。
 * seed.ts が作り、shoot.pw.ts がその利用者でログインして撮る。
 * 名前・メールアドレスはどれも架空のもの (ドメインは e2e と同じ homegohan.test。実在の人の情報は使わない)。
 *
 * 紹介ページの画面 (public/marketing/screens/。docs/design/marketing/01-landing-site.md §7.1 の表 2) は、ガイドの 3 人とは別の利用者で撮る。
 * ガイドの 3 人に家族や食材を足すと、献立表に家族の切り替えや冷蔵庫の件数の印が出て、ガイドの画面 (献立表ほか) まで変わるため (同 §7.1 の G-2)。
 */
export const GUIDE_USERS = {
  /** 食事・献立 (1 週間分)・健康の記録・バッジを持つ、使い込んだ利用者 */
  demo: { email: 'guide-demo@homegohan.test', nickname: 'ほめ子' },
  /** 献立表に空欄がある利用者 (「AIに埋めてもらう」の画面を撮る) */
  planner: { email: 'guide-planner@homegohan.test', nickname: 'ほめ太' },
  /** 初期設定 (オンボーディング) をまだ始めていない利用者 (プロフィールの入力の画面を撮る) */
  onboarding: { email: 'guide-onboarding@homegohan.test', nickname: null },
  /** 今日と今週の献立を持つ利用者 (ホームの画面と AI 相談のシートを撮る)。体重の記録・食材・家族は持たない */
  home: { email: 'guide-home@homegohan.test', nickname: 'ほめ花' },
  /** 期限の違う食材を持つ利用者 (食材管理の画面を撮る) */
  pantry: { email: 'guide-pantry@homegohan.test', nickname: 'ほめ実' },
  /** 今週の献立と、献立から作った買い物リストを持つ利用者 (買い物リストのシートを撮る)。家族・食材は持たない */
  shopper: { email: 'guide-shopper@homegohan.test', nickname: 'ほめ吉' },
  /** 家族の代表者 (家族の画面を撮る) */
  familyRep: { email: 'guide-family@homegohan.test', nickname: 'ほめ母' },
  /** 家族の大人のメンバー (家族の画面に並ぶだけ。この利用者では撮らない) */
  familyAdult: { email: 'guide-family-adult@homegohan.test', nickname: 'ほめ父' },
  /** AI 機能の同意をまだしていない利用者 (同意の画面を撮る) */
  consent: { email: 'guide-consent@homegohan.test', nickname: 'ほめ空' },
} as const;

export type GuideUserKey = keyof typeof GUIDE_USERS;

/**
 * 家族の画面 (public/marketing/screens/family.png) の家族。seed.ts が作り、shoot.pw.ts が画面に出たことを確かめる。
 * 名前はどれも架空のもの。子どもはアカウントの無いメンバー (代表者が登録する)
 */
export const GUIDE_FAMILY = {
  groupName: 'ほめ家',
  displayNames: { representative: 'ほめ母', adult: 'ほめ父', child: 'ほめ助' },
} as const;

/** 撮影の画面の大きさ (CSS px)。スマートフォンの縦長の画面。保存のときに guide-content.ts の GUIDE_IMAGE_SIZE に縮める */
export const SHOOT_VIEWPORT = { width: 390, height: 780 } as const;
/** 撮影の画素の倍率 (縮めたときに文字がつぶれないよう、保存の大きさより大きく撮る) */
export const SHOOT_DEVICE_SCALE_FACTOR = 2;

/** 体重の記録の画面で入れる・体重計の読み取りの結果に出す体重 (kg。テスト用の値) */
export const DEMO_TODAY_WEIGHT_KG = 62.4;
