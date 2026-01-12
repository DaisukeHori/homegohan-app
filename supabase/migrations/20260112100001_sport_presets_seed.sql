-- ============================================
-- Performance OS v3 - スポーツプリセット100種目
--
-- カテゴリ:
--   ball: 球技
--   racket: ラケットスポーツ
--   combat: 格闘技
--   running: 陸上競技
--   swimming: 水泳
--   cycling: 自転車
--   winter: ウィンタースポーツ
--   gym: ジム・フィットネス
--   outdoor: アウトドア
--   dance: ダンス
--   esports: eスポーツ
--   other: その他
-- ============================================

INSERT INTO sport_presets (id, name_ja, name_en, category, roles, demand_vector, phase_descriptions, is_weight_class, is_team_sport, typical_competition_duration)
VALUES

-- ============================================
-- 球技 (Ball Sports) - 25種目
-- ============================================

('soccer', 'サッカー', 'Soccer', 'ball',
  '[{"id": "forward", "name_ja": "フォワード", "name_en": "Forward"},
    {"id": "midfielder", "name_ja": "ミッドフィルダー", "name_en": "Midfielder"},
    {"id": "defender", "name_ja": "ディフェンダー", "name_en": "Defender"},
    {"id": "goalkeeper", "name_ja": "ゴールキーパー", "name_en": "Goalkeeper"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.6, "strength": 0.5, "technique": 0.7, "weightClass": 0, "heat": 0.6, "altitude": 0.3}'::jsonb,
  '{"training": "オフシーズン・基礎体力強化", "competition": "リーグ戦シーズン", "recovery": "シーズンオフ回復期"}'::jsonb,
  false, true, '90 minutes'),

('basketball', 'バスケットボール', 'Basketball', 'ball',
  '[{"id": "point_guard", "name_ja": "ポイントガード", "name_en": "Point Guard"},
    {"id": "shooting_guard", "name_ja": "シューティングガード", "name_en": "Shooting Guard"},
    {"id": "small_forward", "name_ja": "スモールフォワード", "name_en": "Small Forward"},
    {"id": "power_forward", "name_ja": "パワーフォワード", "name_en": "Power Forward"},
    {"id": "center", "name_ja": "センター", "name_en": "Center"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.8, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, true, '48 minutes'),

('volleyball', 'バレーボール', 'Volleyball', 'ball',
  '[{"id": "setter", "name_ja": "セッター", "name_en": "Setter"},
    {"id": "outside_hitter", "name_ja": "アウトサイドヒッター", "name_en": "Outside Hitter"},
    {"id": "middle_blocker", "name_ja": "ミドルブロッカー", "name_en": "Middle Blocker"},
    {"id": "opposite", "name_ja": "オポジット", "name_en": "Opposite"},
    {"id": "libero", "name_ja": "リベロ", "name_en": "Libero"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.9, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, true, '60-90 minutes'),

('baseball', '野球', 'Baseball', 'ball',
  '[{"id": "pitcher", "name_ja": "投手", "name_en": "Pitcher"},
    {"id": "catcher", "name_ja": "捕手", "name_en": "Catcher"},
    {"id": "infielder", "name_ja": "内野手", "name_en": "Infielder"},
    {"id": "outfielder", "name_ja": "外野手", "name_en": "Outfielder"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.8, "strength": 0.6, "technique": 0.9, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '3 hours'),

('softball', 'ソフトボール', 'Softball', 'ball',
  '[{"id": "pitcher", "name_ja": "投手", "name_en": "Pitcher"},
    {"id": "catcher", "name_ja": "捕手", "name_en": "Catcher"},
    {"id": "infielder", "name_ja": "内野手", "name_en": "Infielder"},
    {"id": "outfielder", "name_ja": "外野手", "name_en": "Outfielder"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.7, "strength": 0.5, "technique": 0.8, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '2 hours'),

('rugby', 'ラグビー', 'Rugby', 'ball',
  '[{"id": "forward", "name_ja": "フォワード", "name_en": "Forward"},
    {"id": "back", "name_ja": "バックス", "name_en": "Back"},
    {"id": "scrum_half", "name_ja": "スクラムハーフ", "name_en": "Scrum Half"},
    {"id": "fly_half", "name_ja": "フライハーフ", "name_en": "Fly Half"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.9, "strength": 0.9, "technique": 0.6, "weightClass": 0.3, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '80 minutes'),

('american_football', 'アメリカンフットボール', 'American Football', 'ball',
  '[{"id": "quarterback", "name_ja": "クォーターバック", "name_en": "Quarterback"},
    {"id": "running_back", "name_ja": "ランニングバック", "name_en": "Running Back"},
    {"id": "wide_receiver", "name_ja": "ワイドレシーバー", "name_en": "Wide Receiver"},
    {"id": "lineman", "name_ja": "ラインマン", "name_en": "Lineman"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.95, "strength": 0.9, "technique": 0.7, "weightClass": 0.4, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '60 minutes'),

('handball', 'ハンドボール', 'Handball', 'ball',
  '[{"id": "goalkeeper", "name_ja": "ゴールキーパー", "name_en": "Goalkeeper"},
    {"id": "pivot", "name_ja": "ピボット", "name_en": "Pivot"},
    {"id": "wing", "name_ja": "ウイング", "name_en": "Wing"},
    {"id": "back", "name_ja": "バック", "name_en": "Back"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.8, "strength": 0.7, "technique": 0.7, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, true, '60 minutes'),

('hockey', 'ホッケー', 'Field Hockey', 'ball',
  '[{"id": "forward", "name_ja": "フォワード", "name_en": "Forward"},
    {"id": "midfielder", "name_ja": "ミッドフィルダー", "name_en": "Midfielder"},
    {"id": "defender", "name_ja": "ディフェンダー", "name_en": "Defender"},
    {"id": "goalkeeper", "name_ja": "ゴールキーパー", "name_en": "Goalkeeper"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.6, "strength": 0.5, "technique": 0.8, "weightClass": 0, "heat": 0.6, "altitude": 0}'::jsonb,
  NULL, false, true, '70 minutes'),

('ice_hockey', 'アイスホッケー', 'Ice Hockey', 'ball',
  '[{"id": "forward", "name_ja": "フォワード", "name_en": "Forward"},
    {"id": "defenseman", "name_ja": "ディフェンスマン", "name_en": "Defenseman"},
    {"id": "goaltender", "name_ja": "ゴールテンダー", "name_en": "Goaltender"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.85, "strength": 0.7, "technique": 0.8, "weightClass": 0, "heat": 0, "altitude": 0}'::jsonb,
  NULL, false, true, '60 minutes'),

('lacrosse', 'ラクロス', 'Lacrosse', 'ball',
  '[{"id": "attack", "name_ja": "アタック", "name_en": "Attack"},
    {"id": "midfield", "name_ja": "ミッドフィールド", "name_en": "Midfield"},
    {"id": "defense", "name_ja": "ディフェンス", "name_en": "Defense"},
    {"id": "goalie", "name_ja": "ゴーリー", "name_en": "Goalie"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.7, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '60 minutes'),

('water_polo', '水球', 'Water Polo', 'ball',
  '[{"id": "center", "name_ja": "センター", "name_en": "Center"},
    {"id": "driver", "name_ja": "ドライバー", "name_en": "Driver"},
    {"id": "goalkeeper", "name_ja": "ゴールキーパー", "name_en": "Goalkeeper"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.7, "strength": 0.7, "technique": 0.7, "weightClass": 0, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, true, '32 minutes'),

('futsal', 'フットサル', 'Futsal', 'ball',
  '[{"id": "fixo", "name_ja": "フィクソ", "name_en": "Fixo"},
    {"id": "ala", "name_ja": "アラ", "name_en": "Ala"},
    {"id": "pivo", "name_ja": "ピヴォ", "name_en": "Pivo"},
    {"id": "goleiro", "name_ja": "ゴレイロ", "name_en": "Goleiro"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.7, "strength": 0.5, "technique": 0.9, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, true, '40 minutes'),

('beach_volleyball', 'ビーチバレー', 'Beach Volleyball', 'ball',
  '[{"id": "blocker", "name_ja": "ブロッカー", "name_en": "Blocker"},
    {"id": "defender", "name_ja": "ディフェンダー", "name_en": "Defender"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.85, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.8, "altitude": 0}'::jsonb,
  NULL, false, true, '45 minutes'),

('cricket', 'クリケット', 'Cricket', 'ball',
  '[{"id": "batsman", "name_ja": "バッツマン", "name_en": "Batsman"},
    {"id": "bowler", "name_ja": "ボウラー", "name_en": "Bowler"},
    {"id": "wicketkeeper", "name_ja": "ウィケットキーパー", "name_en": "Wicketkeeper"},
    {"id": "all_rounder", "name_ja": "オールラウンダー", "name_en": "All-rounder"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.7, "strength": 0.5, "technique": 0.9, "weightClass": 0, "heat": 0.7, "altitude": 0}'::jsonb,
  NULL, false, true, 'varies'),

('golf', 'ゴルフ', 'Golf', 'ball',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.6, "strength": 0.4, "technique": 0.95, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '4-5 hours'),

('bowling', 'ボウリング', 'Bowling', 'ball',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.5, "strength": 0.4, "technique": 0.9, "weightClass": 0, "heat": 0, "altitude": 0}'::jsonb,
  NULL, false, false, '2-3 hours'),

('billiards', 'ビリヤード', 'Billiards', 'ball',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.2, "power": 0.2, "strength": 0.2, "technique": 0.95, "weightClass": 0, "heat": 0, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

('sepak_takraw', 'セパタクロー', 'Sepak Takraw', 'ball',
  '[{"id": "tekong", "name_ja": "テコン", "name_en": "Tekong"},
    {"id": "feeder", "name_ja": "フィーダー", "name_en": "Feeder"},
    {"id": "striker", "name_ja": "ストライカー", "name_en": "Striker"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.8, "strength": 0.5, "technique": 0.9, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '45 minutes'),

('kabaddi', 'カバディ', 'Kabaddi', 'ball',
  '[{"id": "raider", "name_ja": "レイダー", "name_en": "Raider"},
    {"id": "defender", "name_ja": "ディフェンダー", "name_en": "Defender"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.8, "strength": 0.8, "technique": 0.7, "weightClass": 0.3, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '40 minutes'),

-- ============================================
-- ラケットスポーツ (Racket Sports) - 10種目
-- ============================================

('tennis', 'テニス', 'Tennis', 'racket',
  '[{"id": "baseline", "name_ja": "ベースライナー", "name_en": "Baseliner"},
    {"id": "serve_volley", "name_ja": "サーブ&ボレー", "name_en": "Serve & Volley"},
    {"id": "all_court", "name_ja": "オールラウンダー", "name_en": "All-Court"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.7, "strength": 0.5, "technique": 0.9, "weightClass": 0, "heat": 0.7, "altitude": 0.2}'::jsonb,
  '{"training": "オフシーズン・技術向上期", "competition": "トーナメントシーズン", "recovery": "休養期"}'::jsonb,
  false, false, '2-5 hours'),

('badminton', 'バドミントン', 'Badminton', 'racket',
  '[{"id": "singles", "name_ja": "シングルス", "name_en": "Singles"},
    {"id": "doubles", "name_ja": "ダブルス", "name_en": "Doubles"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.75, "strength": 0.5, "technique": 0.9, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, '45-90 minutes'),

('table_tennis', '卓球', 'Table Tennis', 'racket',
  '[{"id": "attacker", "name_ja": "攻撃型", "name_en": "Attacker"},
    {"id": "defender", "name_ja": "守備型", "name_en": "Defender"},
    {"id": "all_round", "name_ja": "オールラウンド", "name_en": "All-round"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.6, "strength": 0.4, "technique": 0.95, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '30-60 minutes'),

('squash', 'スカッシュ', 'Squash', 'racket',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.7, "strength": 0.5, "technique": 0.85, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, '45-90 minutes'),

('racquetball', 'ラケットボール', 'Racquetball', 'racket',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.7, "strength": 0.5, "technique": 0.8, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '30-60 minutes'),

('padel', 'パデル', 'Padel', 'racket',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.75, "power": 0.6, "strength": 0.4, "technique": 0.85, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '60-90 minutes'),

('pickleball', 'ピックルボール', 'Pickleball', 'racket',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.5, "strength": 0.3, "technique": 0.8, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '30-60 minutes'),

('soft_tennis', 'ソフトテニス', 'Soft Tennis', 'racket',
  '[{"id": "front", "name_ja": "前衛", "name_en": "Front"},
    {"id": "back", "name_ja": "後衛", "name_en": "Back"}]'::jsonb,
  '{"endurance": 0.75, "power": 0.6, "strength": 0.4, "technique": 0.85, "weightClass": 0, "heat": 0.6, "altitude": 0}'::jsonb,
  NULL, false, false, '60-90 minutes'),

-- ============================================
-- 格闘技 (Combat Sports) - 15種目
-- ============================================

('judo', '柔道', 'Judo', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.85, "strength": 0.9, "technique": 0.9, "weightClass": 1.0, "heat": 0.4, "altitude": 0}'::jsonb,
  '{"training": "基礎鍛錬期", "competition": "大会シーズン", "cut": "減量期", "recovery": "回復期"}'::jsonb,
  true, false, '5-10 minutes'),

('karate', '空手', 'Karate', 'combat',
  '[{"id": "kata", "name_ja": "形", "name_en": "Kata"},
    {"id": "kumite", "name_ja": "組手", "name_en": "Kumite"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.85, "strength": 0.7, "technique": 0.95, "weightClass": 0.8, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, true, false, '3-8 minutes'),

('taekwondo', 'テコンドー', 'Taekwondo', 'combat',
  '[{"id": "kyorugi", "name_ja": "キョルギ", "name_en": "Kyorugi"},
    {"id": "poomsae", "name_ja": "プムセ", "name_en": "Poomsae"}]'::jsonb,
  '{"endurance": 0.75, "power": 0.85, "strength": 0.6, "technique": 0.9, "weightClass": 0.9, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, true, false, '6 minutes'),

('boxing', 'ボクシング', 'Boxing', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.9, "strength": 0.8, "technique": 0.85, "weightClass": 1.0, "heat": 0.4, "altitude": 0.3}'::jsonb,
  '{"training": "基礎体力期", "competition": "試合準備期", "cut": "減量期", "recovery": "回復期"}'::jsonb,
  true, false, '36 minutes'),

('kickboxing', 'キックボクシング', 'Kickboxing', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.9, "strength": 0.75, "technique": 0.85, "weightClass": 0.9, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, true, false, '15-25 minutes'),

('muay_thai', 'ムエタイ', 'Muay Thai', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.9, "strength": 0.8, "technique": 0.85, "weightClass": 0.95, "heat": 0.7, "altitude": 0}'::jsonb,
  NULL, true, false, '15-25 minutes'),

('mma', '総合格闘技', 'Mixed Martial Arts', 'combat',
  '[{"id": "striker", "name_ja": "ストライカー", "name_en": "Striker"},
    {"id": "grappler", "name_ja": "グラップラー", "name_en": "Grappler"},
    {"id": "wrestler", "name_ja": "レスラー", "name_en": "Wrestler"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.9, "strength": 0.9, "technique": 0.85, "weightClass": 1.0, "heat": 0.4, "altitude": 0.3}'::jsonb,
  NULL, true, false, '15-25 minutes'),

('wrestling', 'レスリング', 'Wrestling', 'combat',
  '[{"id": "freestyle", "name_ja": "フリースタイル", "name_en": "Freestyle"},
    {"id": "greco_roman", "name_ja": "グレコローマン", "name_en": "Greco-Roman"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.9, "strength": 0.95, "technique": 0.9, "weightClass": 1.0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, true, false, '6-9 minutes'),

('brazilian_jiu_jitsu', 'ブラジリアン柔術', 'Brazilian Jiu-Jitsu', 'combat',
  '[{"id": "gi", "name_ja": "道着あり", "name_en": "Gi"},
    {"id": "no_gi", "name_ja": "道着なし", "name_en": "No-Gi"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.7, "strength": 0.85, "technique": 0.95, "weightClass": 0.9, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, true, false, '5-10 minutes'),

('kendo', '剣道', 'Kendo', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.75, "strength": 0.6, "technique": 0.95, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '5-10 minutes'),

('fencing', 'フェンシング', 'Fencing', 'combat',
  '[{"id": "foil", "name_ja": "フルーレ", "name_en": "Foil"},
    {"id": "epee", "name_ja": "エペ", "name_en": "Épée"},
    {"id": "sabre", "name_ja": "サーブル", "name_en": "Sabre"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.75, "strength": 0.5, "technique": 0.95, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '9 minutes'),

('sumo', '相撲', 'Sumo', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.95, "strength": 0.95, "technique": 0.85, "weightClass": 0.8, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, true, false, '30 seconds'),

('aikido', '合気道', 'Aikido', 'combat',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.5, "strength": 0.5, "technique": 0.95, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

-- ============================================
-- 陸上競技 (Track & Field) - 12種目
-- ============================================

('sprinting', '短距離走', 'Sprinting', 'running',
  '[{"id": "100m", "name_ja": "100m", "name_en": "100m"},
    {"id": "200m", "name_ja": "200m", "name_en": "200m"},
    {"id": "400m", "name_ja": "400m", "name_en": "400m"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.95, "strength": 0.8, "technique": 0.85, "weightClass": 0, "heat": 0.6, "altitude": 0.5}'::jsonb,
  NULL, false, false, '10-50 seconds'),

('middle_distance', '中距離走', 'Middle Distance', 'running',
  '[{"id": "800m", "name_ja": "800m", "name_en": "800m"},
    {"id": "1500m", "name_ja": "1500m", "name_en": "1500m"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.7, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.6, "altitude": 0.7}'::jsonb,
  NULL, false, false, '2-4 minutes'),

('long_distance', '長距離走', 'Long Distance', 'running',
  '[{"id": "5000m", "name_ja": "5000m", "name_en": "5000m"},
    {"id": "10000m", "name_ja": "10000m", "name_en": "10000m"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.5, "strength": 0.4, "technique": 0.7, "weightClass": 0, "heat": 0.7, "altitude": 0.8}'::jsonb,
  NULL, false, false, '13-30 minutes'),

('marathon', 'マラソン', 'Marathon', 'running',
  '[{"id": "full", "name_ja": "フルマラソン", "name_en": "Full Marathon"},
    {"id": "half", "name_ja": "ハーフマラソン", "name_en": "Half Marathon"}]'::jsonb,
  '{"endurance": 0.98, "power": 0.3, "strength": 0.3, "technique": 0.6, "weightClass": 0, "heat": 0.8, "altitude": 0.6}'::jsonb,
  '{"training": "基礎走込み期", "competition": "レースシーズン", "recovery": "回復期"}'::jsonb,
  false, false, '2-6 hours'),

('ultra_marathon', 'ウルトラマラソン', 'Ultra Marathon', 'running',
  '[{"id": "50k", "name_ja": "50km", "name_en": "50km"},
    {"id": "100k", "name_ja": "100km", "name_en": "100km"},
    {"id": "100_mile", "name_ja": "100マイル", "name_en": "100 Mile"}]'::jsonb,
  '{"endurance": 1.0, "power": 0.2, "strength": 0.4, "technique": 0.5, "weightClass": 0, "heat": 0.7, "altitude": 0.6}'::jsonb,
  NULL, false, false, '5-30 hours'),

('trail_running', 'トレイルランニング', 'Trail Running', 'running',
  '[{"id": "short", "name_ja": "ショート", "name_en": "Short"},
    {"id": "middle", "name_ja": "ミドル", "name_en": "Middle"},
    {"id": "ultra", "name_ja": "ウルトラ", "name_en": "Ultra"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.5, "strength": 0.6, "technique": 0.7, "weightClass": 0, "heat": 0.6, "altitude": 0.8}'::jsonb,
  NULL, false, false, '1-30 hours'),

('hurdles', 'ハードル', 'Hurdles', 'running',
  '[{"id": "110m", "name_ja": "110mH", "name_en": "110m Hurdles"},
    {"id": "400m", "name_ja": "400mH", "name_en": "400m Hurdles"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.9, "strength": 0.7, "technique": 0.9, "weightClass": 0, "heat": 0.5, "altitude": 0.3}'::jsonb,
  NULL, false, false, '13-50 seconds'),

('high_jump', '走高跳', 'High Jump', 'running',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.95, "strength": 0.7, "technique": 0.95, "weightClass": 0, "heat": 0.4, "altitude": 0.3}'::jsonb,
  NULL, false, false, 'varies'),

('long_jump', '走幅跳', 'Long Jump', 'running',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.95, "strength": 0.8, "technique": 0.9, "weightClass": 0, "heat": 0.4, "altitude": 0.3}'::jsonb,
  NULL, false, false, 'varies'),

('pole_vault', '棒高跳', 'Pole Vault', 'running',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.9, "strength": 0.8, "technique": 0.95, "weightClass": 0, "heat": 0.4, "altitude": 0.3}'::jsonb,
  NULL, false, false, 'varies'),

('shot_put', '砲丸投', 'Shot Put', 'running',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.2, "power": 0.95, "strength": 0.95, "technique": 0.85, "weightClass": 0.4, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

('javelin', 'やり投', 'Javelin', 'running',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.9, "strength": 0.85, "technique": 0.9, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

-- ============================================
-- 水泳 (Swimming) - 6種目
-- ============================================

('competitive_swimming', '競泳', 'Competitive Swimming', 'swimming',
  '[{"id": "freestyle", "name_ja": "自由形", "name_en": "Freestyle"},
    {"id": "backstroke", "name_ja": "背泳ぎ", "name_en": "Backstroke"},
    {"id": "breaststroke", "name_ja": "平泳ぎ", "name_en": "Breaststroke"},
    {"id": "butterfly", "name_ja": "バタフライ", "name_en": "Butterfly"},
    {"id": "individual_medley", "name_ja": "個人メドレー", "name_en": "Individual Medley"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.8, "strength": 0.7, "technique": 0.9, "weightClass": 0, "heat": 0.3, "altitude": 0.4}'::jsonb,
  NULL, false, false, '20 seconds - 15 minutes'),

('open_water_swimming', 'オープンウォータースイミング', 'Open Water Swimming', 'swimming',
  '[{"id": "5k", "name_ja": "5km", "name_en": "5km"},
    {"id": "10k", "name_ja": "10km", "name_en": "10km"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.6, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '1-2 hours'),

('synchronized_swimming', 'アーティスティックスイミング', 'Artistic Swimming', 'swimming',
  '[{"id": "solo", "name_ja": "ソロ", "name_en": "Solo"},
    {"id": "duet", "name_ja": "デュエット", "name_en": "Duet"},
    {"id": "team", "name_ja": "チーム", "name_en": "Team"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.7, "strength": 0.7, "technique": 0.95, "weightClass": 0, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, true, '3-5 minutes'),

('diving', '飛込', 'Diving', 'swimming',
  '[{"id": "springboard", "name_ja": "飛板飛込", "name_en": "Springboard"},
    {"id": "platform", "name_ja": "高飛込", "name_en": "Platform"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.85, "strength": 0.7, "technique": 0.95, "weightClass": 0, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

-- ============================================
-- 自転車 (Cycling) - 8種目
-- ============================================

('road_cycling', 'ロードサイクリング', 'Road Cycling', 'cycling',
  '[{"id": "climber", "name_ja": "クライマー", "name_en": "Climber"},
    {"id": "sprinter", "name_ja": "スプリンター", "name_en": "Sprinter"},
    {"id": "rouleur", "name_ja": "ルーラー", "name_en": "Rouleur"},
    {"id": "all_rounder", "name_ja": "オールラウンダー", "name_en": "All-Rounder"},
    {"id": "time_trialist", "name_ja": "タイムトライアリスト", "name_en": "Time Trialist"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.8, "strength": 0.6, "technique": 0.7, "weightClass": 0, "heat": 0.7, "altitude": 0.8}'::jsonb,
  '{"training": "ベース期", "competition": "レースシーズン", "recovery": "オフシーズン"}'::jsonb,
  false, false, '2-7 hours'),

('track_cycling', 'トラック競技', 'Track Cycling', 'cycling',
  '[{"id": "sprint", "name_ja": "スプリント", "name_en": "Sprint"},
    {"id": "endurance", "name_ja": "エンデュランス", "name_en": "Endurance"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.95, "strength": 0.7, "technique": 0.85, "weightClass": 0, "heat": 0.3, "altitude": 0.4}'::jsonb,
  NULL, false, false, '10 seconds - 1 hour'),

('mountain_biking', 'マウンテンバイク', 'Mountain Biking', 'cycling',
  '[{"id": "xc", "name_ja": "クロスカントリー", "name_en": "Cross-Country"},
    {"id": "downhill", "name_ja": "ダウンヒル", "name_en": "Downhill"},
    {"id": "enduro", "name_ja": "エンデューロ", "name_en": "Enduro"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.8, "strength": 0.7, "technique": 0.85, "weightClass": 0, "heat": 0.6, "altitude": 0.7}'::jsonb,
  NULL, false, false, '1.5-3 hours'),

('bmx', 'BMX', 'BMX', 'cycling',
  '[{"id": "racing", "name_ja": "レーシング", "name_en": "Racing"},
    {"id": "freestyle", "name_ja": "フリースタイル", "name_en": "Freestyle"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.9, "strength": 0.7, "technique": 0.9, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '30 seconds - 5 minutes'),

('cyclocross', 'シクロクロス', 'Cyclocross', 'cycling',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.85, "strength": 0.7, "technique": 0.8, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '45-60 minutes'),

('triathlon', 'トライアスロン', 'Triathlon', 'cycling',
  '[{"id": "sprint", "name_ja": "スプリント", "name_en": "Sprint"},
    {"id": "olympic", "name_ja": "オリンピック", "name_en": "Olympic"},
    {"id": "half_ironman", "name_ja": "ハーフアイアンマン", "name_en": "Half Ironman"},
    {"id": "ironman", "name_ja": "アイアンマン", "name_en": "Ironman"}]'::jsonb,
  '{"endurance": 0.98, "power": 0.6, "strength": 0.5, "technique": 0.7, "weightClass": 0, "heat": 0.8, "altitude": 0.4}'::jsonb,
  '{"training": "ベース構築期", "competition": "レースシーズン", "recovery": "回復期"}'::jsonb,
  false, false, '1-17 hours'),

-- ============================================
-- ウィンタースポーツ (Winter Sports) - 8種目
-- ============================================

('alpine_skiing', 'アルペンスキー', 'Alpine Skiing', 'winter',
  '[{"id": "slalom", "name_ja": "スラローム", "name_en": "Slalom"},
    {"id": "giant_slalom", "name_ja": "大回転", "name_en": "Giant Slalom"},
    {"id": "super_g", "name_ja": "スーパーG", "name_en": "Super-G"},
    {"id": "downhill", "name_ja": "滑降", "name_en": "Downhill"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.85, "strength": 0.8, "technique": 0.9, "weightClass": 0, "heat": 0, "altitude": 0.7}'::jsonb,
  NULL, false, false, '1-3 minutes'),

('cross_country_skiing', 'クロスカントリースキー', 'Cross-Country Skiing', 'winter',
  '[{"id": "classic", "name_ja": "クラシカル", "name_en": "Classic"},
    {"id": "freestyle", "name_ja": "フリースタイル", "name_en": "Freestyle"}]'::jsonb,
  '{"endurance": 0.98, "power": 0.7, "strength": 0.7, "technique": 0.8, "weightClass": 0, "heat": 0, "altitude": 0.8}'::jsonb,
  NULL, false, false, '20 minutes - 2 hours'),

('ski_jumping', 'スキージャンプ', 'Ski Jumping', 'winter',
  '[{"id": "normal_hill", "name_ja": "ノーマルヒル", "name_en": "Normal Hill"},
    {"id": "large_hill", "name_ja": "ラージヒル", "name_en": "Large Hill"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.85, "strength": 0.6, "technique": 0.95, "weightClass": 0.6, "heat": 0, "altitude": 0.5}'::jsonb,
  NULL, true, false, 'varies'),

('snowboarding', 'スノーボード', 'Snowboarding', 'winter',
  '[{"id": "halfpipe", "name_ja": "ハーフパイプ", "name_en": "Halfpipe"},
    {"id": "slopestyle", "name_ja": "スロープスタイル", "name_en": "Slopestyle"},
    {"id": "alpine", "name_ja": "アルパイン", "name_en": "Alpine"},
    {"id": "boardercross", "name_ja": "ボーダークロス", "name_en": "Boardercross"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.8, "strength": 0.7, "technique": 0.9, "weightClass": 0, "heat": 0, "altitude": 0.5}'::jsonb,
  NULL, false, false, '1-5 minutes'),

('figure_skating', 'フィギュアスケート', 'Figure Skating', 'winter',
  '[{"id": "singles", "name_ja": "シングル", "name_en": "Singles"},
    {"id": "pairs", "name_ja": "ペア", "name_en": "Pairs"},
    {"id": "ice_dance", "name_ja": "アイスダンス", "name_en": "Ice Dance"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.8, "strength": 0.7, "technique": 0.95, "weightClass": 0.3, "heat": 0, "altitude": 0}'::jsonb,
  NULL, false, false, '2-4 minutes'),

('speed_skating', 'スピードスケート', 'Speed Skating', 'winter',
  '[{"id": "short_track", "name_ja": "ショートトラック", "name_en": "Short Track"},
    {"id": "long_track", "name_ja": "ロングトラック", "name_en": "Long Track"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.9, "strength": 0.75, "technique": 0.85, "weightClass": 0, "heat": 0, "altitude": 0.4}'::jsonb,
  NULL, false, false, '30 seconds - 15 minutes'),

('curling', 'カーリング', 'Curling', 'winter',
  '[{"id": "skip", "name_ja": "スキップ", "name_en": "Skip"},
    {"id": "third", "name_ja": "サード", "name_en": "Third"},
    {"id": "second", "name_ja": "セカンド", "name_en": "Second"},
    {"id": "lead", "name_ja": "リード", "name_en": "Lead"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.4, "strength": 0.4, "technique": 0.95, "weightClass": 0, "heat": 0, "altitude": 0}'::jsonb,
  NULL, false, true, '2-3 hours'),

-- ============================================
-- ジム・フィットネス (Gym & Fitness) - 8種目
-- ============================================

('weightlifting', 'ウェイトリフティング', 'Weightlifting', 'gym',
  '[{"id": "snatch", "name_ja": "スナッチ", "name_en": "Snatch"},
    {"id": "clean_jerk", "name_ja": "クリーン&ジャーク", "name_en": "Clean & Jerk"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.95, "strength": 0.95, "technique": 0.9, "weightClass": 1.0, "heat": 0.3, "altitude": 0}'::jsonb,
  '{"training": "筋力強化期", "competition": "大会準備期", "cut": "減量期", "recovery": "回復期"}'::jsonb,
  true, false, 'varies'),

('powerlifting', 'パワーリフティング', 'Powerlifting', 'gym',
  '[{"id": "squat", "name_ja": "スクワット", "name_en": "Squat"},
    {"id": "bench", "name_ja": "ベンチプレス", "name_en": "Bench Press"},
    {"id": "deadlift", "name_ja": "デッドリフト", "name_en": "Deadlift"}]'::jsonb,
  '{"endurance": 0.2, "power": 0.9, "strength": 1.0, "technique": 0.85, "weightClass": 0.95, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, true, false, 'varies'),

('bodybuilding', 'ボディビルディング', 'Bodybuilding', 'gym',
  '[{"id": "mens_physique", "name_ja": "メンズフィジーク", "name_en": "Men''s Physique"},
    {"id": "classic_physique", "name_ja": "クラシックフィジーク", "name_en": "Classic Physique"},
    {"id": "bodybuilding", "name_ja": "ボディビル", "name_en": "Bodybuilding"},
    {"id": "bikini", "name_ja": "ビキニ", "name_en": "Bikini"},
    {"id": "figure", "name_ja": "フィギュア", "name_en": "Figure"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.7, "strength": 0.85, "technique": 0.6, "weightClass": 0.8, "heat": 0.2, "altitude": 0}'::jsonb,
  '{"training": "バルク期", "competition": "減量期・コンテスト準備", "recovery": "回復期"}'::jsonb,
  true, false, 'varies'),

('crossfit', 'クロスフィット', 'CrossFit', 'gym',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.85, "strength": 0.85, "technique": 0.75, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, '15-60 minutes'),

('gymnastics', '体操競技', 'Gymnastics', 'gym',
  '[{"id": "artistic", "name_ja": "体操", "name_en": "Artistic"},
    {"id": "rhythmic", "name_ja": "新体操", "name_en": "Rhythmic"},
    {"id": "trampoline", "name_ja": "トランポリン", "name_en": "Trampoline"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.9, "strength": 0.9, "technique": 0.98, "weightClass": 0.5, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, false, '1-5 minutes'),

('calisthenics', 'カリステニクス', 'Calisthenics', 'gym',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.75, "strength": 0.8, "technique": 0.85, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

('yoga', 'ヨガ', 'Yoga', 'gym',
  '[{"id": "hatha", "name_ja": "ハタヨガ", "name_en": "Hatha"},
    {"id": "vinyasa", "name_ja": "ヴィンヤサ", "name_en": "Vinyasa"},
    {"id": "ashtanga", "name_ja": "アシュタンガ", "name_en": "Ashtanga"},
    {"id": "hot", "name_ja": "ホットヨガ", "name_en": "Hot Yoga"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.4, "strength": 0.5, "technique": 0.85, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '60-90 minutes'),

('pilates', 'ピラティス', 'Pilates', 'gym',
  '[{"id": "mat", "name_ja": "マット", "name_en": "Mat"},
    {"id": "reformer", "name_ja": "リフォーマー", "name_en": "Reformer"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.4, "strength": 0.6, "technique": 0.8, "weightClass": 0, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, false, '45-60 minutes'),

-- ============================================
-- アウトドア (Outdoor) - 6種目
-- ============================================

('rock_climbing', 'ロッククライミング', 'Rock Climbing', 'outdoor',
  '[{"id": "sport", "name_ja": "スポートクライミング", "name_en": "Sport Climbing"},
    {"id": "bouldering", "name_ja": "ボルダリング", "name_en": "Bouldering"},
    {"id": "lead", "name_ja": "リード", "name_en": "Lead"},
    {"id": "speed", "name_ja": "スピード", "name_en": "Speed"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.8, "strength": 0.85, "technique": 0.9, "weightClass": 0.4, "heat": 0.4, "altitude": 0.3}'::jsonb,
  NULL, false, false, 'varies'),

('mountaineering', '登山', 'Mountaineering', 'outdoor',
  '[{"id": "alpine", "name_ja": "アルパイン", "name_en": "Alpine"},
    {"id": "expedition", "name_ja": "遠征", "name_en": "Expedition"},
    {"id": "hiking", "name_ja": "ハイキング", "name_en": "Hiking"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.5, "strength": 0.7, "technique": 0.7, "weightClass": 0, "heat": 0.4, "altitude": 1.0}'::jsonb,
  NULL, false, false, '1-30 days'),

('surfing', 'サーフィン', 'Surfing', 'outdoor',
  '[{"id": "shortboard", "name_ja": "ショートボード", "name_en": "Shortboard"},
    {"id": "longboard", "name_ja": "ロングボード", "name_en": "Longboard"}]'::jsonb,
  '{"endurance": 0.8, "power": 0.7, "strength": 0.6, "technique": 0.9, "weightClass": 0, "heat": 0.6, "altitude": 0}'::jsonb,
  NULL, false, false, '2-4 hours'),

('kayaking', 'カヤック', 'Kayaking', 'outdoor',
  '[{"id": "sprint", "name_ja": "スプリント", "name_en": "Sprint"},
    {"id": "slalom", "name_ja": "スラローム", "name_en": "Slalom"},
    {"id": "whitewater", "name_ja": "ホワイトウォーター", "name_en": "Whitewater"}]'::jsonb,
  '{"endurance": 0.85, "power": 0.8, "strength": 0.75, "technique": 0.85, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, '1 minute - 3 hours'),

('rowing', 'ボート競技', 'Rowing', 'outdoor',
  '[{"id": "single", "name_ja": "シングルスカル", "name_en": "Single Scull"},
    {"id": "double", "name_ja": "ダブルスカル", "name_en": "Double Scull"},
    {"id": "coxless_pair", "name_ja": "ペア", "name_en": "Coxless Pair"},
    {"id": "eight", "name_ja": "エイト", "name_en": "Eight"}]'::jsonb,
  '{"endurance": 0.95, "power": 0.85, "strength": 0.8, "technique": 0.85, "weightClass": 0.3, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, true, '5-8 minutes'),

('sailing', 'セーリング', 'Sailing', 'outdoor',
  '[{"id": "dinghy", "name_ja": "ディンギー", "name_en": "Dinghy"},
    {"id": "keelboat", "name_ja": "キールボート", "name_en": "Keelboat"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.6, "strength": 0.6, "technique": 0.9, "weightClass": 0.3, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, true, '1-3 hours'),

-- ============================================
-- ダンス (Dance) - 4種目
-- ============================================

('ballroom_dance', '社交ダンス', 'Ballroom Dance', 'dance',
  '[{"id": "standard", "name_ja": "スタンダード", "name_en": "Standard"},
    {"id": "latin", "name_ja": "ラテン", "name_en": "Latin"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.6, "strength": 0.5, "technique": 0.95, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '2-3 minutes'),

('hip_hop_dance', 'ヒップホップダンス', 'Hip Hop Dance', 'dance',
  '[{"id": "breaking", "name_ja": "ブレイキン", "name_en": "Breaking"},
    {"id": "popping", "name_ja": "ポッピン", "name_en": "Popping"},
    {"id": "locking", "name_ja": "ロッキン", "name_en": "Locking"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.8, "strength": 0.7, "technique": 0.9, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, '1-5 minutes'),

('ballet', 'バレエ', 'Ballet', 'dance',
  '[{"id": "classical", "name_ja": "クラシック", "name_en": "Classical"},
    {"id": "contemporary", "name_ja": "コンテンポラリー", "name_en": "Contemporary"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.7, "strength": 0.7, "technique": 0.98, "weightClass": 0.5, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, false, '2-30 minutes'),

('cheerleading', 'チアリーディング', 'Cheerleading', 'dance',
  '[{"id": "base", "name_ja": "ベース", "name_en": "Base"},
    {"id": "flyer", "name_ja": "フライヤー", "name_en": "Flyer"},
    {"id": "spotter", "name_ja": "スポッター", "name_en": "Spotter"}]'::jsonb,
  '{"endurance": 0.7, "power": 0.8, "strength": 0.75, "technique": 0.9, "weightClass": 0.4, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, true, '2-3 minutes'),

-- ============================================
-- eスポーツ (E-Sports) - 2種目
-- ============================================

('esports', 'eスポーツ', 'E-Sports', 'esports',
  '[{"id": "fps", "name_ja": "FPS", "name_en": "FPS"},
    {"id": "moba", "name_ja": "MOBA", "name_en": "MOBA"},
    {"id": "fighting", "name_ja": "格闘ゲーム", "name_en": "Fighting Games"},
    {"id": "sports", "name_ja": "スポーツ", "name_en": "Sports"},
    {"id": "card", "name_ja": "カードゲーム", "name_en": "Card Games"}]'::jsonb,
  '{"endurance": 0.5, "power": 0.1, "strength": 0.1, "technique": 0.95, "weightClass": 0, "heat": 0.2, "altitude": 0}'::jsonb,
  NULL, false, true, '30 minutes - 8 hours'),

-- ============================================
-- その他 (Other) - 4種目
-- ============================================

('equestrian', '馬術', 'Equestrian', 'other',
  '[{"id": "dressage", "name_ja": "馬場馬術", "name_en": "Dressage"},
    {"id": "jumping", "name_ja": "障害飛越", "name_en": "Show Jumping"},
    {"id": "eventing", "name_ja": "総合馬術", "name_en": "Eventing"}]'::jsonb,
  '{"endurance": 0.6, "power": 0.5, "strength": 0.6, "technique": 0.95, "weightClass": 0.5, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, '5-15 minutes'),

('archery', 'アーチェリー', 'Archery', 'other',
  '[{"id": "recurve", "name_ja": "リカーブ", "name_en": "Recurve"},
    {"id": "compound", "name_ja": "コンパウンド", "name_en": "Compound"}]'::jsonb,
  '{"endurance": 0.4, "power": 0.4, "strength": 0.5, "technique": 0.98, "weightClass": 0, "heat": 0.4, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

('shooting', '射撃', 'Shooting', 'other',
  '[{"id": "rifle", "name_ja": "ライフル", "name_en": "Rifle"},
    {"id": "pistol", "name_ja": "ピストル", "name_en": "Pistol"},
    {"id": "shotgun", "name_ja": "クレー射撃", "name_en": "Shotgun"}]'::jsonb,
  '{"endurance": 0.3, "power": 0.3, "strength": 0.4, "technique": 0.98, "weightClass": 0, "heat": 0.3, "altitude": 0}'::jsonb,
  NULL, false, false, 'varies'),

('modern_pentathlon', '近代五種', 'Modern Pentathlon', 'other',
  '[{"id": "general", "name_ja": "一般", "name_en": "General"}]'::jsonb,
  '{"endurance": 0.9, "power": 0.7, "strength": 0.6, "technique": 0.85, "weightClass": 0, "heat": 0.5, "altitude": 0}'::jsonb,
  NULL, false, false, '5-6 hours')

ON CONFLICT (id) DO UPDATE SET
  name_ja = EXCLUDED.name_ja,
  name_en = EXCLUDED.name_en,
  category = EXCLUDED.category,
  roles = EXCLUDED.roles,
  demand_vector = EXCLUDED.demand_vector,
  phase_descriptions = EXCLUDED.phase_descriptions,
  is_weight_class = EXCLUDED.is_weight_class,
  is_team_sport = EXCLUDED.is_team_sport,
  typical_competition_duration = EXCLUDED.typical_competition_duration,
  updated_at = NOW();
