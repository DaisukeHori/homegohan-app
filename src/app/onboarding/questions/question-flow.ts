// 質問データの定義（運動・目標・健康情報を詳細に収集）
//
// #1045 (F6-13): JSX を含まない純粋なモジュールとして切り出すことで、
// pruneStaleAnswers() を UI をレンダリングせずに単体テストできるようにする。
export const QUESTIONS = [
  {
    id: 'nickname',
    text: 'はじめまして！🍳\n私はあなたの食生活をサポートするAI栄養士です。\n\nお名前（ニックネーム）を教えてください',
    type: 'text',
    placeholder: '例: たろう',
    required: true,
  },
  {
    id: 'gender',
    text: '{nickname}さん、よろしくお願いします！\n\n正確な栄養計算のために、性別を教えてください',
    type: 'choice',
    options: [
      { label: '👨 男性', value: 'male' },
      { label: '👩 女性', value: 'female' },
      { label: '🙂 回答しない', value: 'unspecified' },
    ]
  },
  {
    id: 'body_stats',
    text: '基礎代謝を計算するために、\n身体情報を教えてください',
    type: 'custom_stats',
  },
  {
    id: 'nutrition_goal',
    text: '一番の目標は何ですか？',
    type: 'choice',
    options: [
      { label: '🏃 減量・ダイエット', value: 'lose_weight', description: '体重を落としたい' },
      { label: '💪 筋肉増量・バルクアップ', value: 'gain_muscle', description: '筋肉をつけたい' },
      { label: '⚖️ 現状維持・健康管理', value: 'maintain', description: '今の体型を維持したい' },
      { label: '🏆 競技パフォーマンス', value: 'athlete_performance', description: '大会・試合に向けて' },
    ]
  },
  {
    id: 'target_weight',
    text: '目標体重を教えてください',
    type: 'number',
    placeholder: '例: 55',
    min: 30,
    max: 200,
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'lose_weight' || answers.nutrition_goal === 'gain_muscle',
  },
  // Performance OS v3: アスリート向け追加質問
  {
    id: 'sport_type',
    text: '主に取り組んでいる競技は？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.nutrition_goal === 'athlete_performance',
    options: [
      { label: '⚽ サッカー', value: 'soccer' },
      { label: '🏀 バスケットボール', value: 'basketball' },
      { label: '🏐 バレーボール', value: 'volleyball' },
      { label: '⚾ 野球', value: 'baseball' },
      { label: '🎾 テニス', value: 'tennis' },
      { label: '🏊 水泳', value: 'swimming' },
      { label: '🏃 陸上競技', value: 'track_and_field' },
      { label: '🚴 自転車', value: 'road_cycling' },
      { label: '🥊 格闘技', value: 'martial_arts_general' },
      { label: '🏋️ ウェイトリフティング', value: 'weightlifting' },
      { label: '🎯 その他', value: 'custom' },
    ]
  },
  {
    id: 'sport_custom_name',
    text: '競技名を入力してください',
    type: 'text',
    placeholder: '例: トライアスロン',
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'athlete_performance' && answers.sport_type === 'custom',
  },
  {
    id: 'training_phase',
    text: '現在のトレーニング期は？',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.nutrition_goal === 'athlete_performance',
    options: [
      { label: '🏋️ トレーニング期', value: 'training', description: '体力・技術向上中' },
      { label: '🏆 試合期', value: 'competition', description: '大会・試合シーズン' },
      { label: '⚖️ 減量期', value: 'cut', description: '体重調整中（階級制など）' },
      { label: '🛌 回復期', value: 'recovery', description: 'オフシーズン・ケガからの復帰' },
    ]
  },
  {
    id: 'competition_date',
    text: '次の大会・試合はいつですか？',
    type: 'date',
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'athlete_performance' &&
      (answers.training_phase === 'competition' || answers.training_phase === 'cut'),
    allowSkip: true,
  },
  {
    id: 'target_date',
    text: 'いつまでに達成したいですか？',
    type: 'date',
    showIf: (answers: Record<string, any>) =>
      answers.nutrition_goal === 'lose_weight' || answers.nutrition_goal === 'gain_muscle',
    allowSkip: true,
  },
  {
    id: 'exercise_types',
    text: '普段どんな運動をしていますか？\n（複数選択可）',
    type: 'multi_choice',
    options: [
      { label: '🏋️ 筋トレ・ウェイト', value: 'weight_training' },
      { label: '🏃 ランニング・ジョギング', value: 'running' },
      { label: '🚴 サイクリング', value: 'cycling' },
      { label: '🏊 水泳', value: 'swimming' },
      { label: '🧘 ヨガ・ピラティス', value: 'yoga' },
      { label: '⚽ 球技・チームスポーツ', value: 'team_sports' },
      { label: '🥊 格闘技・ボクシング', value: 'martial_arts' },
      { label: '🚶 ウォーキング', value: 'walking' },
      { label: '❌ 運動していない', value: 'none' },
    ],
  },
  {
    id: 'exercise_frequency',
    text: '週に何日運動していますか？',
    type: 'choice',
    showIf: (answers: Record<string, any>) =>
      !answers.exercise_types?.includes('none'),
    options: [
      { label: '1日', value: '1' },
      { label: '2日', value: '2' },
      { label: '3日', value: '3' },
      { label: '4日', value: '4' },
      { label: '5日', value: '5' },
      { label: '6日以上', value: '6' },
    ]
  },
  {
    id: 'exercise_intensity',
    text: '運動の強度はどのくらいですか？',
    type: 'choice',
    showIf: (answers: Record<string, any>) =>
      !answers.exercise_types?.includes('none'),
    options: [
      { label: '🚶 軽い（息が上がらない程度）', value: 'light', description: 'ウォーキング、軽いヨガなど' },
      { label: '🏃 普通（少し息が上がる）', value: 'moderate', description: 'ジョギング、一般的な筋トレなど' },
      { label: '🔥 激しい（かなり息が上がる）', value: 'intense', description: 'HIIT、高重量トレーニングなど' },
      { label: '💪 アスリートレベル', value: 'athlete', description: '毎日ハードなトレーニング' },
    ]
  },
  {
    id: 'work_style',
    text: '普段の仕事・活動スタイルは？',
    type: 'choice',
    options: [
      { label: '💻 デスクワーク（座り仕事）', value: 'sedentary' },
      { label: '🏢 オフィス（立ち座り半々）', value: 'light_active' },
      { label: '🚶 立ち仕事・移動多め', value: 'moderately_active' },
      { label: '🔨 肉体労働', value: 'very_active' },
      { label: '📚 学生', value: 'student' },
      { label: '🏠 主婦/主夫', value: 'homemaker' },
    ]
  },
  {
    id: 'health_conditions',
    text: '気になる健康状態はありますか？\n（複数選択可、なければスキップ）',
    type: 'multi_choice',
    options: [
      { label: '📈 高血圧', value: '高血圧' },
      { label: '🍬 糖尿病・血糖値', value: '糖尿病' },
      { label: '🩸 脂質異常症', value: '脂質異常症' },
      { label: '🫀 心臓病', value: '心臓病' },
      { label: '🫁 腎臓病', value: '腎臓病' },
      { label: '🦴 骨粗しょう症', value: '骨粗しょう症' },
      { label: '🩺 貧血', value: '貧血' },
      { label: '🦶 痛風', value: '痛風' },
      { label: '🌿 便秘・下痢', value: '消化器系' },
      { label: '🌡️ 甲状腺疾患', value: '甲状腺疾患' },
      { label: '🧠 自律神経失調', value: '自律神経' },
      { label: '😰 うつ・不安障害', value: 'メンタル' },
    ],
    allowSkip: true,
  },
  {
    id: 'body_concerns',
    text: '体の悩みはありますか？\n（複数選択可、なければスキップ）',
    type: 'multi_choice',
    allowSkip: true,
    options: [
      { label: '🥶 冷え性', value: 'cold_sensitivity' },
      { label: '🦵 むくみやすい', value: 'swelling_prone' },
      { label: '💤 疲れやすい', value: 'fatigue' },
      { label: '🤕 肩こり・腰痛', value: 'stiff_shoulders' },
      { label: '😵 頭痛持ち', value: 'headache' },
      { label: '🌡️ 汗をかきにくい', value: 'low_sweating' },
      { label: '🍂 肌荒れ', value: 'skin_trouble' },
      { label: '💇 髪のパサつき', value: 'dry_hair' },
    ],
  },
  {
    id: 'sleep_quality',
    text: '睡眠の質はいかがですか？',
    type: 'choice',
    options: [
      { label: '😴 良好', value: 'good', description: 'よく眠れている' },
      { label: '😐 普通', value: 'average', description: '特に問題なし' },
      { label: '😫 悪い', value: 'poor', description: '睡眠に問題がある' },
    ]
  },
  {
    id: 'stress_level',
    text: '日々のストレスレベルは？',
    type: 'choice',
    options: [
      { label: '😌 低い', value: 'low', description: 'リラックスできている' },
      { label: '😐 普通', value: 'medium', description: '日常的なストレス' },
      { label: '😰 高い', value: 'high', description: 'ストレスを感じている' },
    ]
  },
  {
    id: 'pregnancy_status',
    text: '妊娠・授乳の状況を教えてください',
    type: 'choice',
    showIf: (answers: Record<string, any>) => answers.gender === 'female',
    options: [
      { label: '🙅‍♀️ 該当なし', value: 'none', description: '妊娠・授乳中ではない' },
      { label: '🤰 妊娠中', value: 'pregnant', description: '現在妊娠中' },
      { label: '🤱 授乳中', value: 'nursing', description: '現在授乳中' },
    ]
  },
  {
    id: 'medications',
    text: '服用中の薬はありますか？\n（食事に影響するものを選択、なければスキップ）',
    type: 'multi_choice',
    options: [
      { label: '💊 ワーファリン（血液サラサラ）', value: 'warfarin' },
      { label: '💊 降圧剤', value: 'antihypertensive' },
      { label: '💊 糖尿病薬', value: 'diabetes_medication' },
      { label: '💊 利尿剤', value: 'diuretic' },
      { label: '💊 抗生物質', value: 'antibiotics' },
      { label: '💊 ステロイド', value: 'steroid' },
    ],
    allowSkip: true,
  },
  {
    id: 'allergies',
    text: '食物アレルギーはありますか？\n（なければスキップ）',
    type: 'tags',
    placeholder: '例: 卵、エビ、小麦',
    suggestions: ['卵', 'エビ', 'カニ', '小麦', '乳製品', 'そば', '落花生', 'ナッツ類', '貝類', '魚卵', '大豆'],
    allowSkip: true,
  },
  {
    id: 'dislikes',
    text: '苦手な食材はありますか？\n（アレルギー以外で避けたいもの）',
    type: 'tags',
    placeholder: '例: ピーマン、セロリ、レバー',
    suggestions: ['ピーマン', 'セロリ', 'パクチー', 'レバー', 'ホルモン', 'なす', 'ゴーヤ', 'しいたけ', '納豆', 'グリンピース', 'にんじん', 'トマト'],
    allowSkip: true,
  },
  {
    id: 'favorite_ingredients',
    text: '好きな食材を教えてください\n（献立に積極的に入れます）',
    type: 'tags',
    placeholder: '例: 鶏肉、ブロッコリー、アボカド',
    suggestions: ['鶏肉', '豚肉', '牛肉', '魚', 'エビ', '豆腐', '卵', 'ブロッコリー', 'ほうれん草', 'トマト', 'アボカド', 'きのこ', 'さつまいも', 'キャベツ'],
    allowSkip: true,
  },
  {
    id: 'diet_style',
    text: '食事スタイルを教えてください',
    type: 'choice',
    allowSkip: true,
    options: [
      { label: '🍽️ 通常', value: 'normal', description: '特に制限なし' },
      { label: '🥬 ベジタリアン', value: 'vegetarian', description: '肉を食べない' },
      { label: '🌱 ヴィーガン', value: 'vegan', description: '動物性食品を食べない' },
      { label: '🐟 ペスカタリアン', value: 'pescatarian', description: '魚は食べる' },
      { label: '🌾 グルテンフリー', value: 'gluten_free', description: '小麦を避ける' },
      { label: '🥑 ケトジェニック', value: 'keto', description: '低糖質・高脂質' },
    ]
  },
  {
    id: 'cooking_experience',
    text: '料理の経験は？',
    type: 'choice',
    options: [
      { label: '🔰 初心者（1年未満）', value: 'beginner' },
      { label: '👨‍🍳 中級者（1-3年）', value: 'intermediate' },
      { label: '👨‍🍳 上級者（3年以上）', value: 'advanced' },
    ]
  },
  {
    id: 'cooking_time',
    text: '平日の夕食にかけられる調理時間は？',
    type: 'choice',
    options: [
      { label: '⚡ 15分以内', value: '15' },
      { label: '🕐 30分以内', value: '30' },
      { label: '🕑 45分以内', value: '45' },
      { label: '🕒 1時間以上OK', value: '60' },
    ]
  },
  {
    id: 'cuisine_preference',
    text: '好きな料理ジャンルは？\n（複数選択可）',
    type: 'multi_choice',
    options: [
      { label: '🍱 和食', value: 'japanese' },
      { label: '🍝 洋食', value: 'western' },
      { label: '🥡 中華', value: 'chinese' },
      { label: '🍕 イタリアン', value: 'italian' },
      { label: '🌶️ エスニック', value: 'ethnic' },
      { label: '🥘 韓国料理', value: 'korean' },
    ]
  },
  {
    id: 'servings_config',
    text: '曜日ごとの食事人数を設定してください\n（0人＝作らない/外食）',
    type: 'servings_grid',
  },
  {
    id: 'shopping_frequency',
    text: '普段の買い物の頻度は？',
    type: 'choice',
    options: [
      { label: '🛒 毎日買い物に行く', value: 'daily' },
      { label: '🛒 週2〜3回', value: '2-3_weekly' },
      { label: '🛒 週1回まとめ買い', value: 'weekly' },
      { label: '🛒 2週間に1回程度', value: 'biweekly' },
    ],
  },
  {
    id: 'weekly_food_budget',
    text: '週の食費予算は？\n（任意）',
    type: 'choice',
    allowSkip: true,
    options: [
      { label: '💰 〜5,000円', value: '5000' },
      { label: '💰 5,000〜10,000円', value: '10000' },
      { label: '💰 10,000〜15,000円', value: '15000' },
      { label: '💰 15,000〜20,000円', value: '20000' },
      { label: '💰 20,000円以上', value: '25000' },
      { label: '🤷 特に決めていない', value: 'none' },
    ],
  },
  {
    id: 'kitchen_appliances',
    text: 'お持ちの調理器具は？\n（複数選択可、スキップ可）',
    type: 'multi_choice',
    allowSkip: true,
    options: [
      { label: '🔥 オーブン/オーブンレンジ', value: 'oven' },
      { label: '🐟 魚焼きグリル', value: 'grill' },
      { label: '⏱️ 圧力鍋', value: 'pressure_cooker' },
      { label: '🤖 ホットクック/電気圧力鍋', value: 'slow_cooker' },
      { label: '🍟 エアフライヤー', value: 'air_fryer' },
      { label: '🥤 フードプロセッサー/ミキサー', value: 'food_processor' },
    ],
  },
  {
    id: 'stove_type',
    text: 'お使いのコンロは？',
    type: 'choice',
    options: [
      { label: '🔥 ガスコンロ', value: 'stove:gas' },
      { label: '⚡ IHコンロ', value: 'stove:ih' },
    ],
  },
  {
    id: 'hobbies',
    text: '趣味を教えてください\n（献立提案の参考にします）',
    type: 'tags',
    placeholder: '例: 読書、ヨガ、ランニング',
    suggestions: ['読書', '料理', 'ヨガ', 'ランニング', '筋トレ', 'サイクリング', '登山', '映画', 'ゲーム', '旅行', '音楽', 'カフェ巡り', '釣り', 'キャンプ'],
    allowSkip: true,
  },
];

export type OnboardingAnswerMap = Record<string, any>;

/**
 * #1045 (F6-13): showIf が false になった質問の回答を answers から取り除く。
 *
 * 例: nutrition_goal='athlete_performance' → sport_type / training_phase / competition_date
 * などに回答した後、「戻る」で nutrition_goal を 'lose_weight' に変更すると、
 * これらの下流回答が showIf=false のまま answers に残り続け、矛盾したプロフィール
 * (nutrition_goal='lose_weight' なのに performance_profile が残る等) が確定してしまう。
 *
 * QUESTIONS は依存関係の順 (参照する質問が必ず前方に来る) で定義されているため、
 * 配列を先頭から 1 回走査するだけで連鎖的な prune が正しく行える。
 */
export function pruneStaleAnswers(answers: OnboardingAnswerMap): OnboardingAnswerMap {
  const pruned: OnboardingAnswerMap = { ...answers };
  for (const q of QUESTIONS) {
    if (q.showIf && q.id in pruned && !q.showIf(pruned)) {
      delete pruned[q.id];
    }
  }
  return pruned;
}
