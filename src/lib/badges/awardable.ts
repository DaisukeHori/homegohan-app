// #1314: バッジ一覧 (GET /api/badges) に出してよい「付与処理のあるバッジ」の許可リスト。
//
// badges マスターには、付与処理がまだ無く、いまは獲得のしようがないバッジ
// (health_streak_* / early_bird / hello_ai など) も入っている。一覧に出すと「取れないバッジ」が
// 並ぶだけなので、未獲得のうちは隠す。
//
// - 隠すのは「未獲得 かつ このリストに無い」バッジだけ。獲得済みのバッジは、このリストに無くても必ず返す。
// - マスター (badges テーブル) の行は変えない (migration なし)。
// - 付与処理を足したら、そのバッジのコードをここに足すと一覧に出る。足すときは、付与処理の種類ごとの
//   グループ (下の見出し) に入れる。tests/badges-awardable-contract.test.ts が、リストの各コードに
//   実際に付与の経路があること、付与処理が増えたのにここへ足し忘れていないことを確かめる。
//
// 次の 3 つは、判定のコードは /api/badges にあるが、いまは一覧に出さない。出すかどうかはオーナーの判断待ち
// (#1314)。マスターに行が無いので、一覧への影響は今のところ無い。
//   home_chef (自炊 10 回) / master_chef (自炊 50 回) / century (100 食)

export const AWARDABLE_BADGE_CODES = [
  // GET /api/badges が、完了した食事の数・連続日数から判定して付与する (src/app/api/badges/route.ts)。
  // ハンズオンツアーのお試しの記録 (is_sandbox = true) は数えない。
  'first_bite',
  'photo_10',
  'streak_3',
  'streak_7',

  // POST /api/menu-plans/add が、献立を追加したときに awardBadge で付与する
  'planner',

  // RPC complete_handson_tour() が、ハンズオンツアーの卒業時に付与する
  'tutorial_complete',

  // Edge Function calculate-segment-stats が、集計のあとにランキング・改善率から付与する
  // (badges.condition_json の type が segment_rank / segment_percentile / segment_vs_avg / improvement のもの)。
  // 注意 (2026-10-08 確認): この関数がバッジを取る条件 `condition_json->type.eq.<値>` は PostgREST に 22P02 で拒否され、
  // 結果の error も見ていないため、いまは実際には付与されない。直すか、この 14 件をリストから外すかはオーナー判断 (#1314)。
  'segment_rank_1',
  'segment_rank_top3',
  'segment_top_5',
  'segment_top_10',
  'segment_top_25',
  'segment_above_avg',
  'segment_above_avg_20',
  'segment_above_avg_50',
  'improved_10',
  'improved_20',
  'improved_50',
  'breakfast_champion',
  'veggie_champion',
  'streak_champion',
] as const;

const AWARDABLE_BADGE_CODE_SET: ReadonlySet<string> = new Set(AWARDABLE_BADGE_CODES);

/** 付与処理のあるバッジか。false のバッジは、未獲得のうちは一覧に出さない */
export function isAwardableBadgeCode(code: string): boolean {
  return AWARDABLE_BADGE_CODE_SET.has(code);
}
