# Fish Overuse Bug Fix — 2026-04-29

## 背景

Playwright UI E2E テストで「和食多め+減塩+子ども向け」リクエストで12食生成したところ、
鮭3回+さわら3回=魚が50%を占める偏重を観察。

## 根本原因

3つのバグが連鎖:

1. **Validator の family 分割すぎ問題**: `diversity-validator.ts` の `weekly_family_overuse` は
   `mainDishFamily` (16種類) で計算するため、`grilled_salmon` (2回) / `foil_salmon` (1回) /
   `simmered_fish` (2回) / `miso_fish` (1回) はそれぞれ7日窓3回未満で違反トリガーされず。

2. **`ProteinFamily` も分割**: salmon / mackerel / other_fish が別カテゴリで、
   「魚一括」を測定する手段がなかった。

3. **`same_day_main_family_duplicate` の対象不足**:
   既存ロジックは lunch↔dinner のみ。4/30 朝鮭+昼鮭(=foil_salmon) を捕えられなかった。

## 修正

- `diversity-taxonomy.ts` に `PROTEIN_SUPER_CATEGORIES` (`fish`/`meat`/`egg`/`tofu`/`mixed`/`other`) を追加
- `MealDiversityFingerprint` に `proteinSuperCategory` フィールド追加
- 新 violation コード:
  - `weekly_super_protein_overuse` (7日窓: fish 4回 soft, 6回 hard / meat 5回 soft, 7回 hard)
  - `same_day_super_protein_duplicate` (朝・昼・夕の任意ペアで fish/meat 重複)
- Scheduler 側の `selectBestTemplate` で super-category ペナルティ (60点/件) を加算

## 検証

- `tests/diversity-validator-protein-super.test.ts` の 3 ケース pass を確認
- ステージング環境で「和食多め+減塩+子ども向け」を 12食生成し、魚 < 4回 / 7日 を確認
- 本番反映後、`weekly_menu_requests` テーブルの violations 集計で
  `weekly_super_protein_overuse` の発生率を観察(実態把握用)

## 既知の制約

- 魚種は all `other_fish` → `fish` に集約される(さば/さけは family レベルでは区別される)
- `mixed` super-cat (魚と肉の混在料理)は厳密判定不能 → `mixed` のままで数えない

## 設計判断 (defaults)

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| fish super-cat | salmon + mackerel + other_fish | 「魚一括」を最小単位で実現 |
| meat super-cat | chicken + pork (+将来 beef/lamb) | 「肉一括」 |
| 7日窓閾値 (fish) | 4回 soft / 6回 hard | 観察事例(50%偏重)より低めに張る |
| 7日窓閾値 (meat) | 5回 soft / 7回 hard | 肉は許容多めに |
| 同日重複 (fish/meat) | 朝・昼・夕の任意ペアで soft | 4/30 の鮭朝昼を捕まえる |
| Scheduler ペナルティ | 60点/件 (super-cat) | family の 120, protein の 80 より弱、合算で効かせる |
