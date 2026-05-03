# testdata/ — E2E テスト用フィクスチャ画像

このディレクトリには Maestro E2E フローで使用するフィクスチャ画像を配置します。
**画像本体はリポジトリに含めず、手動で配置してください。**

---

## 必要な画像ファイル一覧

| ファイル名 | 用途フロー | 内容・要件 |
|---|---|---|
| `meal-photo.jpg` | `meals/28-photo-meal-analysis.yaml` | 食事写真。料理が明確に写っており、AIが料理名・カロリーを推定できるもの。推奨解像度: 1080x1080px 以上。単一または複数料理可。 |
| `fridge-photo.jpg` | 将来の冷蔵庫フロー | 冷蔵庫内部の写真。食材が識別できる程度の明るさと解像度。推奨解像度: 1080x1440px 以上。 |
| `checkup-sheet.jpg` | `health/26-ocr-auto-fill.yaml` | 健康診断結果票。血圧・HbA1c・体重・BMI が記載されているもの。文字が鮮明であること。推奨解像度: 1240x1754px (A4相当) 以上。 |
| `weight-scale.jpg` | 将来の体重計フロー | 体重計ディスプレイ。数値が鮮明に読み取れるもの。推奨解像度: 1080x1080px 以上。 |
| `ai-attach-photo.jpg` | `ai/25-image-attach-respond.yaml` | AIチャットに添付する食事写真。料理が明確に写っていること。推奨解像度: 1080x1080px 以上。 |

---

## シミュレーターへの配置方法

Maestro フローでシミュレーターの Photos.app から画像を選択する場合、
事前に画像をシミュレーターのカメラロールに追加しておく必要があります。

```bash
# シミュレーター UDID を確認
xcrun simctl list devices booted

# 画像を Photos.app に追加 (UDID を置き換えてください)
xcrun simctl addmedia <UDID> apps/mobile/maestro/testdata/meal-photo.jpg
xcrun simctl addmedia <UDID> apps/mobile/maestro/testdata/checkup-sheet.jpg
xcrun simctl addmedia <UDID> apps/mobile/maestro/testdata/ai-attach-photo.jpg
```

**注意: このコマンドは iPhone-E2E-01 のリグレッションテストが完了してから実行してください。**

---

## 注意事項

- 個人情報を含む実際の健診結果票は使用しないこと
- テスト用のサンプル画像 (ダミーデータ) を用意すること
- 画像ファイルは `.gitignore` または Git LFS で管理することを推奨
