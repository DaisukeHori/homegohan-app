// i18n キー完全定義 (ja v1)
// Canonical: docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §2.3
// キー総数: 81 (step0:8 / step1:14 / step2:14 / step3:13 / step4:12 / step5:2 / cooking_experience:3 / a11y:9 / common:6)
//
// placeholder 一覧 (§2.5):
//   {nickname}               - 例: "太郎"       - Step 0/1/2/3/4/5 各所
//   {target_kcal}            - 例: "1900"       - Step 1
//   {percent}                - 例: "41"         - Step 1
//   {exclude_list}           - 例: "卵・乳"      - Step 2
//   {cooking_experience_text} - 例: "初心者でも作れる" - Step 2
//   {current}                - 例: "2"          - a11y progress
//   {total}                  - 例: "5"          - a11y progress

export const HANDSON_TOUR_I18N_JA = {
  tour: {
    // ====== Step 0 ウェルカム (8 キー) ======
    step0: {
      title: '{nickname} さん、ようこそ!',
      subtitle: '3 つの便利機能を一緒に試してみましょう (約 90 秒)',
      start_button: 'はじめる',
      later_button: 'あとで',
      a11y_title: 'ステップ 1 / 5、{nickname} さんへのウェルカム画面',
      a11y_start_hint: 'タップするとハンズオンが始まります',
      a11y_later_hint: 'タップするとチュートリアルを終了します',
    },

    // ====== Step 1 写真追加 (14 キー) ======
    step1: {
      // intro
      intro_title: '写真 1 枚で食事が記録できます',
      intro_hint: 'タップで進む',

      // sub-steps
      camera_bubble: '写真を撮るかギャラリーから選びます',
      result_title: 'AI が自動判定',
      result_bubble_with_target: '{nickname} さんの目標 {target_kcal} kcal/日 の約 {percent}%',
      result_bubble_no_target: 'AI が自動で料理名と栄養を判定しました',
      save_bubble: '保存するだけで毎日の記録が完成',

      // buttons
      next_button: '次へ',
      save_button: '保存',

      // error
      error_title: '保存できませんでした',
      error_subtitle: '電波の状態を確認してもう一度お試しください',
      error_retry_button: 'もう一度',
      error_skip_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 2 / 5、写真から食事を追加します',
      a11y_result_announce: '鶏の唐揚げ定食、780 キロカロリー。{nickname} さんの目標 {target_kcal} キロカロリー の {percent} パーセントです。',
    },

    // ====== Step 2 AI 献立 (14 キー) ======
    step2: {
      intro_title: 'ボタン 1 つで明日の献立が決まります',
      intro_hint: 'タップで進む',

      flags_bubble: '気分や条件を選びます (今は「調理しなくていい」がチェック済み)',
      note_bubble: '自由メモも書けます (任意)',
      generate_bubble: 'タップで AI が献立を作ります',

      result_title: '{nickname} さんに合わせた献立',
      result_bubble_full: '{exclude_list} は除外、{cooking_experience_text} の手順',
      result_bubble_no_exclude: '{cooking_experience_text} の手順',

      add_bubble: '献立に追加',

      next_button: '次へ',
      generate_button: '生成する',
      add_button: '献立に追加',

      // error
      error_title: '献立を追加できませんでした',
      error_subtitle: '電波の状態を確認してもう一度お試しください',
      error_retry_button: 'もう一度',
      error_skip_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 3 / 5、AI で献立を作ります',
      a11y_result_announce: '豚肉と野菜の生姜焼き、620 キロカロリー、調理時間 20 分。',
    },

    // ====== Step 3 バッジ確認 (13 キー) ======
    step3: {
      // loading
      loading_text: 'バッジを確認中...',

      // intro
      intro_title: '{nickname} さん、もう 2 つ獲得しています!',
      intro_hint: 'タップで進む',

      // バッジ別吹き出し
      first_bite_title: 'はじめての一歩',
      first_bite_bubble: '写真から記録を 1 度しました',
      planner_title: 'プランナー',
      planner_bubble: '献立を 1 度作りました',
      tutorial_complete_title: '使い方マスター',
      tutorial_complete_bubble: '次の画面で受け取れます',

      next_button: '次へ',

      // error
      error_title: 'バッジ情報を取得できませんでした',
      error_retry_button: 'もう一度',
      error_skip_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 4 / 5、{nickname} さん、もう 2 つバッジを獲得しています',
    },

    // ====== Step 4 卒業 (14 キー) ======
    step4: {
      // saving
      saving_text: '完了処理中...',

      // graduate
      title: '卒業おめでとう! 🎉',
      subtitle: '{nickname} さん、これで homegohan を使いこなせます',
      badge_label: '獲得バッジ: 使い方マスター',
      home_button: 'ホームへ',

      // badge disclaimer (app store 審査対策 / Q16 リスク低減策 #3)
      badge_disclaimer_title: '',
      badge_disclaimer_body: 'このバッジは「使い方を学んだ記念」として表示されます。\n課金や特典、商品購入には一切連動しません。',

      // error
      error_title: '電波が悪いみたい',
      error_subtitle: '少し待ってからもう一度',
      retry_button: 'もう一度',
      error_later_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 5 / 5、卒業画面',
      a11y_announce: '卒業おめでとう。使い方マスターのバッジを獲得しました。',
    },

    // ====== Step 5 通常ホーム + welcome toast (2 キー) ======
    step5: {
      welcome_toast: 'これからは自分のペースで使ってね、{nickname} さん',
      a11y_toast_announce: 'これからは自分のペースで使ってね、{nickname} さん。',
    },

    // ====== cooking_experience テキスト (3 キー) ======
    cooking_experience: {
      beginner: '初心者でも作れる',
      intermediate: 'いつもの手順で作れる',
      advanced: 'シェフの腕前を活かせる',
    },

    // ====== 共通 a11y (9 キー) ======
    a11y: {
      overlay_label: '使い方ガイド',
      progress_label: 'ステップ {current} / {total}',
      next_label: '次のステップへ進む',
      skip_label: 'チュートリアルを終了する',
      save_label: '食事を保存する',
      add_to_menu_label: '献立に追加する',
      home_label: 'ホーム画面へ進む',
      retry_label: 'もう一度実行する',
      spotlight_target_hint: 'ハイライトされた要素の説明',
    },

    // ====== 共通文言 (6 キー) ======
    common: {
      next: '次へ',
      back: '戻る',
      cancel: 'キャンセル',
      ok: 'OK',
      retry: 'もう一度',
      skip: 'あとで',
    },
  },
} as const;

export type HandsonTourI18nJa = typeof HANDSON_TOUR_I18N_JA;
