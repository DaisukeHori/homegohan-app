# App Store / Google Play 提出用メタデータ — family/09 ハンズオンチュートリアル対応

> 作成: 2026-05-08 (family/09 Phase 4 Q16 リスク低減策 #1, #4)
> 更新者は本ファイルとストア側を必ず同期すること。

---

## 1. 背景: なぜ専用文案が必要か

family/09 ハンズオンチュートリアル (90 秒オンボーディング) は以下の特徴を持つ:

- ユーザーは **sandbox モード** で食事写真追加 / 献立 AI 生成を擬似体験する
- チュートリアル完走時に **実バッジ** (`first_bite` / `planner` / `tutorial_complete`) が
  user_badges テーブルに INSERT される (= 実際のゲーミフィケーション要素を獲得)

これは Apple App Store / Google Play の審査ガイドラインと衝突する可能性がある:

| 懸念 | 該当ガイドライン |
|---|---|
| sandbox 操作で実バッジ付与 = 「実質的な購入促進」と解釈 | App Store Review Guideline 1.4.1 (Misleading Apps) / 3.1.1 (In-App Purchase) |
| バッジ獲得が課金/特典/実商品に連動して見える | Google Play Policy: "Misleading Behavior" |

→ Notes for Review (審査担当者向け補足説明) と Store description で **明示的に** 「教育目的のゲーミフィケーション、課金には連動しない」と説明し、誤解を防ぐ。

---

## 2. App Store Connect — Notes for Review 文案 (英語)

App Store Connect → My Apps → homegohan → App Store → 該当 Version → "App Review Information" → "Notes" 欄に貼り付け。

```
=== ほめゴハン v<VERSION> Review Notes ===

== Onboarding Tutorial (90 seconds) — IMPORTANT FOR REVIEWERS ==

After signup, new users see a 90-second hands-on tutorial that walks
through three core features:
  1. Photo-based meal logging
  2. AI-assisted weekly menu generation
  3. In-app badges (gamification)

The tutorial uses a SANDBOX mode:
  - All AI responses are pre-set mock data (no LLM calls)
  - All meal/menu records inserted are flagged `is_sandbox = true`
    and excluded from normal app views
  - Sandbox rows are auto-deleted after 90 days via pg_cron

Three "real" badges (first_bite, planner, tutorial_complete) are
awarded upon tutorial completion. THESE BADGES ARE PURELY EDUCATIONAL
GAMIFICATION:
  - They are NOT linked to any in-app purchase
  - They do NOT unlock paid features
  - They do NOT have monetary value
  - They cannot be redeemed for goods, services, or discounts

Their sole purpose is to mark the user's learning progress (similar to
a "tutorial complete" achievement in a video game). The disclaimer
"このバッジは『使い方を学んだ記念』として表示されます。課金や特典、商品購入には一切連動しません。"
is shown directly under the badge on the graduation screen
(see screenshot: tour-step-4-badge-disclaimer).

The tutorial can be dismissed at any time via the "あとで" (Later)
button or by closing the modal. Users who skip can replay it later
from the Settings screen.

Existing users (= users with non-sandbox meal/menu records) and admin-
role users automatically bypass the tutorial.

== Test account ==
  Email:    <REVIEWER_TEST_EMAIL>
  Password: <REVIEWER_TEST_PASSWORD>

This account has the tutorial enabled and admin features disabled.
After login you will be auto-redirected to /handson-tour to see the
flow end-to-end.

== Privacy ==
The tutorial does not collect any additional personal data beyond
what is described in our Privacy Policy. No PII is sent to third
parties during the tutorial.

== Contact ==
If you have any questions please contact: <SUPPORT_EMAIL>
```

### TODO 埋め込み箇所
| プレースホルダ | 値 | 出所 |
|---|---|---|
| `<VERSION>` | `1.x.y` | `apps/mobile/app.json` の `expo.version` |
| `<REVIEWER_TEST_EMAIL>` | reviewer 専用 test user | App Store 提出のたびに発行 |
| `<REVIEWER_TEST_PASSWORD>` | 同上 | 同上 |
| `<SUPPORT_EMAIL>` | `support@homegohan.app` 等 | 公式サポート連絡先 |

---

## 3. Google Play Console — Notes for Review 文案 (英語)

Google Play Console → アプリ → リリース → 製品版リリース → 「Google Play への通知」または「アプリ情報」の「アプリへのアクセス」に貼り付け。

App Store の本文と概ね同一だが、Google Play 向けに以下調整:

```
=== ほめゴハン v<VERSION> Reviewer Notes (Google Play) ===

[App Store と同じ本文 §2 を貼り付け、ただし以下を冒頭に追記]

This app is the Android port of ほめゴハン (homegohan) (iOS), built with React
Native + Expo. The native module list is identical to iOS.

[残り §2 と同じ]

== Test account credentials ==
[同上]
```

---

## 4. App Store Connect — App Description 追記文案 (日本語)

App Store Connect → My Apps → homegohan → App Information → "Description" 欄。既存の説明文の末尾に **新段落** として追加。

```
【はじめての方への 90 秒ガイド】
登録後すぐに、写真からの食事記録、AI による週間献立提案、ゲーミフィケーション
バッジの 3 つを実際に体験できる 90 秒のハンズオンガイドが表示されます。
※このガイド内で獲得できるバッジは「学習の進捗を示す記念」であり、課金や
特典、商品購入には一切連動しません。
```

英語版 description にも追記する場合:

```
[Hands-on tour — get started in 90 seconds]
Right after signup, take a 90-second walk-through that lets you actually
try photo-based meal logging, AI-assisted weekly menu generation, and the
in-app badge system.
* Badges earned in the tour are purely educational milestones and are
not connected to in-app purchases, rewards, or any goods/services.
```

---

## 5. Google Play Console — App Description 追記文案

Google Play Console → アプリ → ストアの掲載情報 → 「製品の詳細」内 "詳細な説明" 欄。§4 の日本語/英語をそのまま貼り付け。

---

## 6. スクリーンショット差し替え (任意、推奨)

Step 4 卒業画面のスクリーンショットに disclaimer 文言が映る形で更新すると、審査担当者が気付きやすい。

**推奨スクリーンショット 1 枚追加 (ストア画面 #5 or #6 に挿入)**:
- 端末: iPhone 16 Pro (App Store) / Pixel 9 (Play)
- 画面: `/handson-tour/graduate` の卒業バッジ + disclaimer 文言が読める状態
- 撮影: 実機 / シミュレータ問わず、disclaimer 文字が判読可能な解像度
- ファイル名: `tour-step-4-graduation-with-disclaimer.png`

---

## 7. リジェクト対応フロー

万一審査で sandbox/badge について照会された場合の応答テンプレ (Apple Resolution Center / Google Play 通知):

```
Thank you for your feedback. Please refer to our Notes for Review §
"Onboarding Tutorial". To summarize:

1. The tutorial is purely educational. Badges awarded are gamification
   milestones with no monetary or commercial value.
2. The disclaimer "このバッジは『使い方を学んだ記念』として表示されます。
   課金や特典、商品購入には一切連動しません。" is shown on the graduation
   screen (testID: tour-step-4-badge-disclaimer).
3. The tutorial can be skipped at any time and existing users bypass
   it automatically.

If further clarification is needed, please let us know which specific
guideline section is in question and we will provide additional detail.
```

---

## 8. 更新履歴

| 日付 | 担当 | 内容 |
|---|---|---|
| 2026-05-08 | Opus | 初版作成 (family/09 Phase 4 Q16 リスク低減策 #1, #4) |

---

## 9. 関連設計書

- `docs/design/family/09-onboarding-handson-tour/17-security.md` (リジェクト対策の脅威モデル)
- `docs/design/family/09-onboarding-handson-tour/22-analytics.md` (バッジ付与イベントの計測)
- `docs/design/family/09-onboarding-handson-tour/99-open-questions.md` §1.2 Q16 (本対応の根拠)
