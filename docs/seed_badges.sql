-- バッジマスターデータ投入
-- 重複エラーを防ぐため、ON CONFLICT DO NOTHING を使用

INSERT INTO badges (code, name, description, condition_json) VALUES
-- 🔰 Starter
('first_bite', 'First Bite', 'はじめて食事を「完了」にしました。新しい習慣の第一歩です！', '{"type": "count", "min": 1}'),
('streak_3', 'Three Day Streak', '3日連続で食事を「完了」にしました。三日坊主は卒業です。', '{"type": "streak", "days": 3}'),
('streak_7', 'Weekly Winner', '1週間連続で食事を「完了」にしました。素晴らしい継続力です！', '{"type": "streak", "days": 7}'),
('streak_30', 'Monthly Master', '1ヶ月連続で記録しました。食生活が変わってきているはずです。', '{"type": "streak", "days": 30}'),
('photo_10', 'Shutterbug', '食事を10食「完了」にしました。毎日の食卓が積み重なってきました。', '{"type": "count_photo", "min": 10}'),

-- ⏰ Rhythm
('early_bird', 'Early Bird', '朝食を7回記録しました。1日のスタートダッシュは完璧です。', '{"type": "count_type", "meal_type": "breakfast", "min": 7}'),
('night_guard', 'Night Guard', '夜21時以降の食事を控えています。体への思いやりを感じます。', '{"type": "time_limit", "hour": 21, "days": 5}'),

-- 🥗 Nutrition
('veggie_5', 'Veggie Lover', '野菜たっぷりの食事を5回記録しました。体が喜んでいます。', '{"type": "nutrient_score", "target": "veg", "min": 5}'),
('protein_5', 'Protein Pro', '高タンパクな食事を5回記録しました。強い体を作っています。', '{"type": "nutrient_val", "target": "protein", "min": 5}'),
('balance_king', 'Perfect Balance', 'AIスコア90点以上の食事を記録しました。完璧なバランスです！', '{"type": "ai_score", "min": 90}'),

-- 🍳 Variety
('chef_soul', 'Chef''s Soul', '手作り料理を記録しました。愛情たっぷりの食事です。', '{"type": "tag", "value": "homemade"}'),
('rainbow', 'Rainbow Plate', '彩り豊かな食事を記録しました。見た目も栄養も満点です。', '{"type": "tag", "value": "colorful"}'),

-- 🤖 AI & Misc
('hello_ai', 'Hello AI', 'AIからのアドバイスを受け取りました。', '{"type": "feedback_view", "min": 1}'),
('planner', 'Planner', 'AIで複数の日の献立をはじめてまとめて作りました。使い方ガイドのお試しでも付きます。', '{"type": "menu_create", "min": 1}'),

-- 🏆 Master
('legend_100', 'Streak Legend', '100日連続記録。あなたは真のレジェンドです。', '{"type": "streak", "days": 100}')

ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  condition_json = EXCLUDED.condition_json;



