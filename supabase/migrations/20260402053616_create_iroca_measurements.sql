
-- IROCA測色データ管理テーブル
-- 1行 = 1回のCxF3ファイルアップロード（M0/M1/M2の3条件を含む）

CREATE TABLE iroca_measurements (
  id bigserial PRIMARY KEY,
  sample_name text NOT NULL,           -- ファイル名から取得（例: A-01_N3_white100）
  meas_index int NOT NULL DEFAULT 1,   -- 5回測定の何回目か（1-5）
  
  -- M0スペクトル（380-730nm, 10nm刻み, 36値）
  m0_spectrum float8[] NOT NULL,
  -- M1スペクトル
  m1_spectrum float8[],
  -- M2スペクトル
  m2_spectrum float8[],
  
  -- M0から計算したLab (D50/2°)
  lab_l float8,
  lab_a float8,
  lab_b float8,
  
  -- sRGB変換値
  srgb_r int,
  srgb_g int,
  srgb_b int,
  hex_color text,
  
  -- M0-M1のΔE（蛍光QC用）
  delta_e_m0m1 float8,
  
  -- メタデータ
  device_serial text,
  notes text,
  raw_xml text,                         -- 元のCxF3 XML（監査用）
  
  created_at timestamptz NOT NULL DEFAULT now(),
  
  -- sample_name + meas_index でユニーク
  UNIQUE(sample_name, meas_index)
);

-- 中央値スペクトル（5回測定から自動計算）のビュー用
CREATE TABLE iroca_sample_summary (
  id bigserial PRIMARY KEY,
  sample_name text NOT NULL UNIQUE,
  
  -- 中央値スペクトル
  median_spectrum float8[],
  
  -- 中央値Lab
  median_lab_l float8,
  median_lab_a float8,
  median_lab_b float8,
  
  -- sRGB
  srgb_r int,
  srgb_g int,
  srgb_b int,
  hex_color text,
  
  -- 測定回数
  measurement_count int DEFAULT 0,
  
  -- メタ
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 実験計画テーブル（170サンプルの計画を事前登録）
CREATE TABLE iroca_experiment_plan (
  id text PRIMARY KEY,                  -- A-01, B-33, E-28 等
  seq_no int NOT NULL,                  -- 通し番号 1-170
  phase text NOT NULL,                  -- A/B/C/D/E
  drug text NOT NULL,                   -- N7, N7+B, Racc+Y7等
  ratio text,                           -- 単品, 8:2, 1:1:1等
  hair_type text NOT NULL,              -- 白髪100%, 黒髪0%, 白髪50%等
  purpose text,                         -- K/S基礎, 混色曲線等
  recipe_name text,                     -- Phase Eのレシピ名
  status text DEFAULT 'pending',        -- pending/measured/analyzed
  notes text
);

-- RLSを有効化（匿名アクセス許可：実験用なので）
ALTER TABLE iroca_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE iroca_sample_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE iroca_experiment_plan ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on iroca_measurements" ON iroca_measurements FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on iroca_sample_summary" ON iroca_sample_summary FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on iroca_experiment_plan" ON iroca_experiment_plan FOR ALL USING (true) WITH CHECK (true);

-- インデックス
CREATE INDEX idx_iroca_meas_sample ON iroca_measurements(sample_name);
CREATE INDEX idx_iroca_plan_phase ON iroca_experiment_plan(phase);
;
