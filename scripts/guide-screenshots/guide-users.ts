/**
 * 使い方ガイドの撮影 (#1852) に使うテスト用の利用者。seed.ts が作り、shoot.pw.ts がその利用者でログインして撮る。
 * 名前・メールアドレスはどれも架空のもの (ドメインは e2e と同じ homegohan.test。実在の人の情報は使わない)。
 */
export const GUIDE_USERS = {
  /** 食事・献立 (1 週間分)・健康の記録・バッジを持つ、使い込んだ利用者 */
  demo: { email: 'guide-demo@homegohan.test', nickname: 'ほめ子' },
  /** 献立表に空欄がある利用者 (「AIに埋めてもらう」の画面を撮る) */
  planner: { email: 'guide-planner@homegohan.test', nickname: 'ほめ太' },
  /** 初期設定 (オンボーディング) をまだ始めていない利用者 (プロフィールの入力の画面を撮る) */
  onboarding: { email: 'guide-onboarding@homegohan.test', nickname: null },
} as const;

export type GuideUserKey = keyof typeof GUIDE_USERS;

/** 撮影の画面の大きさ (CSS px)。スマートフォンの縦長の画面。保存のときに guide-content.ts の GUIDE_IMAGE_SIZE に縮める */
export const SHOOT_VIEWPORT = { width: 390, height: 780 } as const;
/** 撮影の画素の倍率 (縮めたときに文字がつぶれないよう、保存の大きさより大きく撮る) */
export const SHOOT_DEVICE_SCALE_FACTOR = 2;

/** 体重の記録の画面で入れる・体重計の読み取りの結果に出す体重 (kg。テスト用の値) */
export const DEMO_TODAY_WEIGHT_KG = 62.4;
