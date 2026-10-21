# billing/03 有料プランの販売 — 価格・有料と無料の線引き・アプリ内課金 (RevenueCat)

| | |
|---|---|
| 版 | v1.11 (2026-10-21) |
| Status | 設計ゲート通過 (v1.7 は wf_865452dc-990 の R2 で Opus・Sonnet PASS。発注者の選択 (Q-2・Q-3・Q-4・Q-16) を反映した改定の版 v1.10 は wf_cd8e522d-fa9 の R3 で 4 枠 PASS)。実装は §15.1 の段 A から |
| Issue | #1912 (有料プランの販売を始める: 価格・有料と無料の線引き・アプリ内課金)。関連: #1911 (「準備中」の撤去。main にマージ済み)・#1901 (規約とポリシーの作り込み。正典 `docs/design/cross/20-terms-privacy-text.md` が main にマージ済み)・#1567 (特定商取引法の表記の残り)・#1113 (本番の Stripe の鍵) |
| 範囲の正本 | Issue #1912 の本文とコメント。本冊の §0.4 に、発注者の決定を逐語で写す |
| 土台 | origin/main `4b1e1abe` (#1911 のマージ。`66d02c5d` で cross/20 が入った後)。本冊の「現行」はこの版の事実 (§2.2)。その後の `2ba5b3b3` (#1918。cross/20 (#1901) の実装のマージ) で変わった面 (退会の入口 (§10.4)・規約とポリシーの文面モジュールと主張の表 (§11)) は `2ba5b3b3` の事実に合わせた (F14)。2026-10-21 に origin/main `359a16f9` と突き合わせた: `2ba5b3b3` の後に入ったのは設計書の追随 (billing/01 v1.12・cross/20 v1.15・marketing/01 ほか)・family/11 の設計 (§16.3)・`CLAUDE.md` と `legal-versions.ts`・`parental-consent.ts` の注・番兵 `tests/landing-pricing-doc-1911.test.ts` (§16.1) だけで、本冊が変える製品のコードの中身は変わっていない。その後の `465727de` (#1917。family/11 の実装) で、規約とポリシーの版が `v2026.2` (施行日 2026-10-21) になり、旧版の控え `docs/legal/archive/v2026.1/` ができ、利用規約第11条 4 項・第12条 4 項・第17条 2 項とプライバシーポリシー第13条 9 項の文と主張の表の 6 行が変わった。段 E (§11) の版・旧版の控え・主張の表の区分の数は `465727de` の事実に合わせた (F14)。同じ `465727de` で凍結中も通す API (`FROZEN_ALLOWED_API_PATHS`) と同意の許可リスト (`LEGAL_CONSENT_EXEMPT_API_PATHS`) に家族グループ・組織の解散の 2 本が入り、退会の部品 `AccountSelfServicePanel.tsx`・アプリのアカウント `apps/mobile/app/settings/account.tsx` とそのテストの行がずれたので、F17・F24・S22・§7.1・§9.1・§10.4・§11.1・§16.1 の本数と行 (cross/20 §6 の置き場所の段落の行を含む) も `465727de` の事実に合わせた (段 B〜E の設計は変えない) |
| 前提の冊 | `docs/design/billing/01-billing-core.md` (核。段 A〜C は main 実装済み)・`02-manual-plan-grant.md` (手動付与。段 A〜D 実装済み)・`docs/design/cross/20-terms-privacy-text.md` (規約とポリシーの本文の正典。§17 の「Issue #1912」の行が、本冊が有料の条文を足す場所を決めている)。本冊は 3 冊の契約の上に積み、核の契約 (写像の入口・`personal_subscriptions` の列・`plan_key_cached` の同期) を壊さない |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |

本冊は、課金の核 (billing/01) が作った「Stripe で買う」経路に、(1) 決めた価格、(2) 有料と無料の線引き (AI の回数・重い AI・家族の機能・無料の範囲)、(3) App Store / Google Play のアプリ内課金 (RevenueCat 経由) を足し、Web・iOS・Android のどこで買っても同じ権利の表 (`personal_subscriptions` → `get_effective_plan` → `plan_key_cached`) に写るようにする。あわせて、販売の開始と同時に出す公開の面 (料金ページ・特定商取引法の表記の販売の項目・FAQ・紹介ページ・規約とポリシーの有料の条文) に販売の内容を、未完成や予定を示す文を使わずに足す (「準備中」の撤去と会社情報は #1911 で main に入っている)。

---

## 0. 分冊判定・範囲・読み方・発注者の決定・確認事項

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (正典コード・SQL・表 3 点・トレースを 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | DB (価格・ストアの商品の対応表・ストアの契約の写像・AI の機能の上限・家族の門)・サーバ (RevenueCat の Webhook と同期の API・カタログ)・Web の画面 (料金・契約の管理・究極モードの錠)・公開の面 (料金・特商法・FAQ・紹介ページ)・モバイル (購入の画面)・規約とポリシー = 6 | 該当 |
| 共有面 2 つ以上 | `personal_subscriptions` (核・手動付与・権利判定)・`subscription_plans` の行 (価格)・`ai_daily_limits` / AI の判定の DB 関数 (全 AI の入口が通る)・料理画像のジョブの処理 (`process-meal-image-jobs`。6 つの入口が積む) と種を作る `reconcileDishImages` (Q-16 の主菜の絞り込み)・家族の DB 関数 (`create_family_group`・メンバーの INSERT)・`src/lib/env.ts` の一覧・`cross/04` のエラー表・公開ページの見張り (`tests/public-claims-guard.test.ts`・`tests/no-pending-wording-1911.test.ts`)・規約とポリシーの文面モジュール (`src/lib/legal/`。cross/20) と `packages/shared` の規約の版 | 該当 |

判定: **設計は 1 冊 (本書) のまま、実装を 5 段 (A: DB 層 / B: サーバ層 / C: Web の画面と公開の面 / D: モバイル / E: 規約とポリシーの条文。§15) に分け、段ごとに 2 枚レビューを挟む**。理由: ストアの契約の写像 (SQL 関数) と、それを呼ぶ Webhook・同期の API (TS) は 1 つの契約 (§8.1 のスナップショット) を挟んで表裏で、分けると「未マージの核を参照する配線」の指摘を自分で作る (billing/01 §0.1 と同じ理由)。段 A は単独でマージできる (価格の更新・表と列と関数の新設・既存の関数への門の追加。本番の利用者はゼロなので挙動の変化で困る人はいない)。段 B〜D はそれぞれ前の段のマージ済みの実コードを参照する。段 E は cross/20 (#1901) の実装 (`src/lib/legal/` の文面モジュールと `tests/legal-claims-1901.ts`) の上に足す差分なので、その実装のマージ後に単独で行う。

分けない案との比較 (採らない): 「核 = プランと権利と線引き / 配線 = RevenueCat とモバイルの購入画面」の 2 冊に分ける案は、配線の冊が核の冊の DB 関数 (`billing_apply_store_subscription`) と `plan_store_products` の列を未マージのまま参照することになり、設計ゲートで「未マージの前提」の指摘を生む。価格と線引き (段 A・C) と RevenueCat (段 B・D) は同じ `personal_subscriptions` の行と同じ `BillingSummary` を読むので、冊を分けても行数はほとんど減らない。

### 0.2 本冊の範囲と、対象外

| 本冊 | 対象外 (別の冊・別の Issue) |
|---|---|
| `subscription_plans` の 3 プランの価格と無料体験の更新 (§6.2) と、公開ページの価格の表示 (Stripe の鍵が無い間も DB の値から出す。§10.1) | Stripe・App Store Connect・Google Play Console・RevenueCat の設定の変更そのもの (発注者の作業。§17 に手順と順番) |
| 有料と無料の線引き: AI の 1 日の回数の上限のプランごとの値、機能ごとの上限 (究極モード・料理画像の作成・献立の作成) を持つ `ai_plan_feature_caps`、家族の機能 (グループの作成・メンバーの追加) の門 (§6.5・§6.6・§7)。自動の料理画像を献立の主菜の 1 品だけに作る規則 (Q-16。料理画像のジョブの種を作る `reconcileDishImages`・積み直しの道具・料理の画面のカバーの出し方。§8.8・§10.3) | 運営画面での `ai_plan_feature_caps` の編集 (運営は SQL で変える。画面は配線の残りの冊)・組織 (`org_*`) の課金・`family_addon` |
| App Store / Google Play の購入を RevenueCat の Webhook と同期の API で `personal_subscriptions` に写す仕組み (§6.3・§6.4・§8・§9) | RevenueCat の Stripe 連携 (Web の購入を RevenueCat に写すこと。§5.1 で採らない)・RevenueCat の Paywall UI (`react-native-purchases-ui`。自前の画面で作る) |
| モバイルの購入の画面 (ストアの審査の要件を満たす形。§10.6)・購入の復元・ストアでの購読の管理への案内・退会の確認で、ストアの購読は退会で解約されないことの案内 (退会の 4 つの入口。§10.4)・ストアのメタデータの手順 (§17.5) | ネイティブの画面での契約の状態の細かい表示 (本冊は購入の画面に最小の状態を出す)・Web の `/account/billing` の WebView の表示の変更 (読み取り専用のまま) |
| 公開の面に販売の内容を足す (料金ページの有料のカード・特商法の販売の項目・FAQ の料金・紹介ページの料金の節。#1911 が「準備中」を取り除いたあとの main の上に足す。未完成や予定を示す文を書かない。§10.1〜§10.5) | #1911 (main にマージ済み。`4b1e1abe`) が書き直した面のうち、販売と関係しないもの (運営会社のページ・バッジ・組織の画面・運営の画面・読み込み中の文)。本冊は運営会社のページ (`src/app/company/page.tsx`) と `src/lib/business-info.ts` を変えない (#1911 が追記 2 の会社情報を入れ済み。F13)。§16.1 の母集合の作り方 4 の grep は #1911 の面にも当たるが、本冊では変えない (§16.1 の「#1911 の面」の行) |
| 利用規約・プライバシーポリシーの有料の条文の差分と版の繰り上げ (cross/20 の文面モジュール `src/lib/legal/` の上に、cross/20 §17 の「Issue #1912」の行の場所へ足す。§11) | cross/20 の本文のうち、有料の条文の項目と版の繰り上げに関わらない部分 (本冊はそこを変えない) |
| 「準備中」「販売開始前」「近日」「今後〜予定」などの文を、画面と規約の本文に書かない (§10・§11・§13 の文もその規則で選ぶ) | — |

### 0.3 読み方

- §3 要件行列・§3.2 シナリオ → §4 構想とトレース → §5 構造裁定 → §6 以降が仕上げ (実装者は §6〜§16 だけ読めば手を止めない)。
- 正典の TS は §8 の ```ts ブロック。`import` が zod だけか無いブロック (§8.1 `iap-core.ts`・§8.8 `ai-daily-limit.ts`・§8.9 `billing-plans.ts`・§8.10 `iap-catalog.ts`) は単独で型検査できる。1 行目に `// tsc:skip place=<パス>` / `insert=<パス>` / `append=<パス>` の印があるブロックは、既存のモジュール (`@/lib/...`・`react-native-purchases`) を import するので単独の検査から外し、billing/01 §8.0 の手順で置き場所に置いてリポジトリ全体と一緒に検査する。印の無い `// tsc:skip` のブロックは説明用の断片だけ。SQL は §6。
- 既存の設計書との食い違いは本冊が正 (billing/01 §10.4 の「アプリ内課金をしない」は本冊が改定する。§16.2)。ただし規約とポリシーの本文は cross/20 が正典で、本冊が持つのは §11 の差分 (足す項目・変える 3 つの文・主張の表の行・テストの改め方) だけ。cross/20 の実装が §6・§7 の文から変わっていたら main の文面モジュールが正で、本冊の差分はその上に当てる (§11.0)。
- main にマージ済みの事実 (#1911 の文・定数・テスト、cross/20 の契約) が本冊の記述と食い違ったら、main が正で本冊が従う (§16.3)。

### 0.4 発注者の決定 (Issue #1912 の本文と、その後の指示。逐語)

指示:「あと、全体として「まだできてません」みたいなのは書かないで取り除いて？価格も決めてしまいましょうかね。あとアプリ版はAppStoreやPlayStore経由で決済できないといけないよ」

選択式の回答:
- 価格 = 「個人を競合並みに下げる」: 個人 Pro 580円/月・5,800円/年 / 家族 Basic 980円/月・9,800円/年 (4人) / 家族 Pro 1,480円/月・14,800円/年 (8人) / 無料体験 7日
- 有料で増えるもの (複数選択・4 つ全部): 「AI の回数の上限を上げる」「究極モードなど重い AI を有料に」「家族で使う機能を有料に」「いまの無料の範囲を絞る」
- 「準備中」の撤去 = 「利用者と公開ページすべて」(別 Issue #1911 で行う。この設計でも、未完成や予定を示す文を画面と本文に書かない)
- アプリ内課金 = 「RevenueCat を使う」(両ストアの購入・更新・解約を 1 つの仕組みでまとめ、Web の Stripe と同じ権利の表に寄せる)

追記 1 (発注者の指摘):「StripeはAppができないと申請できません。他もそうでしょう？」— 外部の手続きは、作り終わった後でないと出せない。順番を「作る → 発注者が申請する → 鍵と商品を入れて販売開始」にする (§17)。

追記 2 (会社情報の値。選択式の回答):「全部そのまま使う」— 株式会社MHD医健の公開の会社情報 (所在地 〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F / 設立 2025年1月31日 / 資本金 2,000,000円 / 代表者 (既存の `BUSINESS_REPRESENTATIVE`) / メール info@mhd-iken.com / 営業時間 平日 9:00-17:00 (年末年始を除く))。電話番号 = 「請求があれば遅滞なく開示と書く」(電話番号は載せず「請求があれば遅滞なく開示します」と書く)。特商法の表記の有料の項目 (価格・支払方法と時期・提供時期・解約と返金・動作環境・定期購入の表示) は、この値と並べて足す (#1567 の残り)。

追記 3 (§0.5 の確認事項への選択。2026-10-19 の 16〜23 時台・選択式の回答。選んだ選択肢のラベルと、その選択肢の説明):
- Q-2 (AI の 1 日の回数の上限):「無料 3 にもっと絞る」— プレビュー「無料 3 回/日 / 個人 Pro 30 回/日 / 家族 Basic 30 回/日 (1 人ごと) / 家族 Pro 50 回/日 (1 人ごと)」
- Q-16 (献立の料理画像):「主菜の 1 品だけ作る (推奨)」— 説明「献立の料理画像は主菜だけ (1 週間 ≈ 210 円)。見た目は残し、原価を 1/3 にする」
- Q-3 (究極モードと料理画像の作成):「無料は使えない・有料は 1 日 2〜3 回 (推奨)」
- Q-4 (家族の機能):「家族グループの作成とメンバーの追加 (推奨)」

これで Q-2・Q-3・Q-4・Q-16 は確定した (§0.5)。Q-2 は v1.7 の推奨 (無料 5 回) から 3 回に変わり、Q-16 は v1.7 の案 (いまのまま作った料理ごとに 1 枚・販売開始の後に実測) から「自動の料理画像は献立の主菜の 1 品だけ」に変わる。Q-16 は献立の作成 (1 週間・1 日・1 食) だけでなく、料理画像のジョブを積むすべての入口 (料理の保存・更新の 4 本の route・AI 相談の料理の更新・献立の作成 (Edge の `save-meal`)・積み直しの道具) に同じ規則で当て、プランで分けない (無料の利用者は Q-3 で自動の料理画像を作らないので、そちらが先に効く。R26・§8.8)。

### 0.5 発注者への確認事項 (Q-n。推奨つき。Q-2・Q-3・Q-4・Q-16 は §0.4 の追記 3 の選択で確定した。ほかは「推奨」の値を実装し、選択で変わる値は §6.2・§6.5 の migration の値と §8.9 の `billing-plans.ts` の定数だけが変わる)

| # | 項目 | 推奨 (確定したものは確定の値) | 根拠・代替案 |
|---|---|---|---|
| Q-1 | App Store の日本の価格帯で 580 / 980 / 1,480 / 5,800 / 9,800 / 14,800 円が選べるか | **App Store Connect の「サブスクリプションの価格」で発注者が確かめる** (一次情報は App Store Connect の画面だけ。Apple の公開ヘルプは「800 の価格帯から選ぶ」と書き、日本円の一覧は載せていない (§2.3)) | 選べない値があれば、近い上の価格帯 (例: 580 → 600・5,800 → 6,000) をストアの価格にし、Web (Stripe) は決めた値のまま (ストアの手数料の分だけストアの価格が高いのは、両ストアの規約が許す形 (§2.3 Apple 3.1.3(b))。Web とストアの価格が違うときは、料金ページの「アプリ内課金の価格はストアの表示が正」の 1 文で説明する (§10.1)) |
| Q-2 | AI の 1 日の回数の上限 (`ai_daily_limits`) のプランごとの値 | **確定 (発注者の選択 2026-10-19。§0.4 の追記 3「無料 3 にもっと絞る」): free 3 / 個人 Pro 30 / 家族 Basic 30 (メンバー 1 人ごと) / 家族 Pro 50 (同)** | いまは free = 10 (本番の行)。「いまの無料の範囲を絞る」の選択を回数で受ける。v1.7 の推奨は free 5 で、選択で 3 になった。無料の 3 回は、写真で 3 食を記録する日、または献立の作成 1 回 + 写真 2 食の日が収まる回数。AI の原価は §2.4 (献立の作成 1 週間 ≈ 26 円・1 日 ≈ 4 円・1 食 ≈ 1〜2 円 (どれも推計。料理画像を除く)・写真 1 枚 ≈ 0.2 円・料理画像 1 枚 ≈ 10 円)。上限は上限で、回数だけでは原価の上限にならないので、重い機能は Q-3 の機能ごとの上限と組にする。無料の献立の作成の上限 (Q-3 の 3 回) は 1 日の合計と同じ値なので、無料の利用者で献立の作成の上限が 1 日の合計より先に効くことは無い (献立の作成を 3 回使った日の 4 回目の献立の作成は、先に見る機能ごとの上限で止まり、止めたときの文は献立の作成の上限の文になる。ほかの AI の機能の 4 回目は 1 日の合計の文。§6.5・S17)。競合 (あすけん) は無料で写真の記録なし・プレミアム 580 円 (§2.4)。組織の利用者 (`get_effective_plan` が組織の `organizations.plan` を返す人。組織の課金は本冊の対象外。§0.2) の上限は変えない: migration が free を書き換える前に、組織の plan の値に、いまの free の値の行を写す (§6.5) |
| Q-3 | 機能ごとの 1 日の上限 (`ai_plan_feature_caps`) の値 | **確定 (発注者の選択 2026-10-19。§0.4 の追記 3「無料は使えない・有料は 1 日 2〜3 回 (推奨)」。v1.7 の推奨のまま): 究極モード: free 0 (使えない) / Pro 2 / 家族 Basic 2 / 家族 Pro 3。料理画像の作成 (`image_generation`。`POST /api/ai/image/generate`): free 0 / 有料は行なし (1 日の上限の中で)。自動の料理画像 (`meal_image_auto`。料理の保存・更新の 4 本の route と AI 相談の料理の更新が数える。献立の作成 (Edge の `save-meal`) が積むジョブも、料理画像のジョブを処理する `process-meal-image-jobs` が同じ行で止める。§8.8): free 0 / 有料は行なし (保存の route は安全弁 1 日 20 回のまま。自動で作るのは、どの入口でも献立の主菜の 1 品だけ (Q-16))。献立の作成と作り直し (`menu_generation`。F23 の route 7 本・AI 相談の 3 つのアクション・Edge の直接の呼び出しが、操作 1 回で 1 回数える): free 3 / Pro 10 / 家族 Basic 10 / 家族 Pro 15** | 「究極モードなど重い AI を有料に」を機能ごとの上限で受ける (0 = そのプランでは使えない。§6.5)。`menu_generation` は 1 週間・1 日・1 食の作成と作り直し (栄養の分析の献立の提案と AI 相談からの作成を含む) を同じ 1 回で数える (F23)。1 回の原価が最も重いのは 1 週間 (≈ 26 円) なので、無料は 1 日 3 回 = 1 週間の作成 1 回と作り直し 2 回が収まる回数にし、最悪でも 3 × 26 ≈ 78 円に収める (§2.4)。料理画像は 1 枚 ≈ 10 円で、自動の料理画像は料理の保存 1 回と献立の作成の 1 食ごとに主菜の 1 枚を作る (Q-16。1 週間の作成なら 21 枚 ≈ 210 円) ので、無料に残すと献立の作成 1 回で原価が 1 桁上がる (§2.4)。無料では料理は画像なしで保存され、主菜の料理の画面は「料理画像の作成は有料プランでお使いいただけます」を出す (§8.8)。止めたときの文の機能名は「献立の作成」(`AI_PLAN_CAPPED_FEATURE_LABELS`。§8.8)。選ばれなかった案 (確定の前に代替として挙げたもの): (1) 1 週間の作成だけを別の機能名 (例 `menu_generation_week`) で数えて上限を分ける (作り直しが 1 週間の作成を止めない。`AI_FEATURES`・F23 の入口の `consumeAiUsage`・契約テスト `tests/ai-usage-contract.test.ts` を変える別の冊)。(2) 自動の料理画像を無料に残す (行を入れない。原価の上限は §2.4 の下の行。有料の箇条書きの「料理画像の作成」は `image_generation` だけを指す文に変える)。いまの究極モードは全員 1 日 1 回 (環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT` の既定)。本冊のあとは、行のあるプランは行の値が勝ち、行の無いプランだけ環境変数の既定 (§6.5) |
| Q-4 | 家族の機能の門の範囲 | **確定 (発注者の選択 2026-10-19。§0.4 の追記 3「家族グループの作成とメンバーの追加 (推奨)」。v1.7 の推奨のまま): 家族グループの作成と、メンバーの追加 (招待の承諾・子供の追加) を家族プラン (`family_basic` / `family_pro`) の契約がある代表者のグループだけに限る。契約が終わったグループは、いるメンバーはそのまま (読める・外れられる・解散できる) で、新しいメンバーを足せない。子供の昇格 (`accept_child_promotion`。いる子供の行を、本人のアカウントの大人の行に書き換える UPDATE) はメンバーを足さない (人数は変わらない) ので門に当てない (契約が終わったグループでも昇格できる。「いるメンバーはそのまま」と同じ扱い)** | 「家族で使う機能を有料に」を「グループに入ること」で受ける (家族の献立の表示・貼り付け・共有の設定はグループのメンバーであることが前提なので、入口を閉じれば全部が有料になる)。契約が終わったグループのメンバーをすぐ外す案は、家族の冊の判断 (billing/01 §18 の 15 と同じく外さない) に合わせない |
| Q-5 | Stripe の鍵と Price が無い間の、料金ページの有料プランのカードの CTA | **CTA を置かない (価格と内容だけを出す)。Price が入った間隔から「月額で始める」「年額で始める」が出る (いまの `isPurchasable` の規則)** | 「準備中」と書かない (§0.4)。CTA を「無料で始める」(新規登録) にする案は、有料プランのカードの押しどころが新規登録なのは紛らわしい。CTA を出して確認画面で止める案は、押せるのに申し込めないので採らない |
| Q-6 | `subscription_plans.display_name` を日本語にする | **`個人 Pro` / `家族 Basic` / `家族 Pro`** (いまは `Pro` / `Family Basic` / `Family Pro`) | §0.4 の呼び名に合わせる。画面・特商法・規約・ストアの商品の表示名 (§17) に同じ名前を使う |
| Q-7 | 本番の `subscription_plans` にある試験の行 2 件 (`test_integration_plan_*`・`test_patch_plan_*`。status `draft`) | **消す (発注者が SQL で `DELETE`)** | 本冊の migration は本番の行を消さない (段 A は追加と価格の UPDATE だけ)。`draft` は公開ページにも購入にも出ないので、残っていても利用者には見えない |
| Q-8 | 特定商取引法の表記の「メールアドレス」と、運営会社ページの連絡先 | **確認済み (#1911 が main に入れた)**: どちらも `BUSINESS_EMAIL` (`info@mhd-iken.com`。`src/lib/business-info.ts:32`)。本冊は変えない | #1911 の実装 (`src/app/legal/page.tsx:36`・`src/app/company/page.tsx:53`)。プライバシーポリシーの窓口も cross/20 で事業者のメールアドレスになる (cross/20 R-31) |
| Q-9 | 電話番号の欄の文 | **確認済み (#1911 が main に入れた)**: `PHONE_DISCLOSED_ON_REQUEST` (「請求があれば遅滞なく開示します」。`src/lib/business-info.ts:41`) と請求の窓口を、部品 `src/components/legal/PhoneOnRequest.tsx` が描く。本冊は変えない | 追記 2 の「請求があれば遅滞なく開示します」と一字一句同じ。見張りは `tests/business-info-legal-pages.test.ts:145`・`tests/public-claims-guard.test.ts:251` (origin/main `2ba5b3b3`) |
| Q-10 | 無料体験 (7 日) の「1 人 1 回」の範囲 | **Web (Stripe) は同じプランで 1 回 (いまの `hasUsedTrial`)。ストアは各ストアの判定 (Apple ID / Google アカウントごとに 1 回) に任せ、ストアで試用した行は `trial_started_at` に写して、同じ利用者が後で Web で同じプランを買うときは試用を付けない** | ストアの試用の可否はストアが決め、当社は止められない (§2.3)。逆向き (Web で試用済みの人がストアで試用) は止められないので、Q として残す |
| Q-11 | ストアの契約の更新が Webhook で届かなかったときの網 | **(a) アプリは購入・復元・起動・前面復帰で同期の API を呼ぶ (§9.3)、(b) サーバは期限を過ぎたストアの行を読むときに RevenueCat から取り直す (遅延の再同期。§8.4)。日次の reconcile は配線の残りの冊** | RevenueCat の再送は 5 回・約 80 分で止まる (§2.3) ので、Stripe の 3 日の再送より網が要る |
| Q-12 | 動作環境の表記 (いまは iOS 14.0 以上 / Android 8.0 以上) | **Expo SDK 58 の最低要件に合わせる (発注者が EAS のビルドの設定で確かめる)。本冊の推奨は未確定のまま `§18` に残す** | #1567 の 5 と同じ |
| Q-13 | テストの購入 (sandbox。App Store の審査・TestFlight・Google Play のライセンステスター) を本番で権利にするか | **本番でも本物の購入と同じに写す (`personal_subscriptions.iap_is_sandbox = true` の印を付ける。§6.4)** | App Store の審査は本番のビルドの購入を sandbox の環境で確かめる (P12) ので、本番が sandbox を捨てると審査の購入に権利が付かず、「アプリ版は AppStore / PlayStore 経由で決済できる」を満たせない。利用者 ID で絞る案 (許可の一覧) は、審査官が審査用に渡したアカウントのほかで買ったときに権利が付かず、審査の結果に響く危険がある。RevenueCat の既定 (「Anybody」) も sandbox の購入に権利を与える (P12)。sandbox で買えるのは、開発者が App Store Connect で作ったテストのアカウント・TestFlight に招いた人・Play Console のライセンステスターだけ。代替案: 販売開始の後に `iap_is_sandbox` の行を運営が確かめ、想定外の利用者の行があれば許可の一覧の仕組みを足す (§18 の 17) |
| Q-14 | 利用規約第21条に、料金に結ぶ責任の上限 (例: 直近の支払いの額まで) を置くか (cross/20 §18 の Q-6 が #1912 に渡した点) | **置かない** (第21条は cross/20 の文のまま。故意・重過失を除き直接かつ通常の損害に限り、強行法規に反する限度で適用しない) | 消費者契約法 8 条・10 条に照らした妥当性は弁護士の確認を要する (cross/20 Q-6)。置くときは第21条に項を足し、主張の表に行を足し、両文書の版を上げる (§11.1 の手順と同じ) |
| Q-15 | 規約とポリシーの改定の後、同意する前の利用者が有料プランを解約する手段 (cross/20 §18 の Q-21 が #1912 に渡した点) | **App Store・Google Play の契約は各ストアの定期購読の管理から (当社の画面に依らない)。Web の契約はお問い合わせから依頼を受け、運営が Stripe の Dashboard で解約する** (利用規約第24条に項を足す。§11.1) | 同意する前の利用者は Web の画面 (`/account/billing`) を開けない (同意の前に開ける画面は `lib/legal-consent.ts:121-133` (origin/main `2ba5b3b3`) の除外だけ)。解約の API (`/api/billing/subscription/cancel`) は未同意でも通る (`packages/shared/src/legal-consent-api.ts:111`) が、それを押す画面が無い。お問い合わせ (`/contact`) は同意の前でも開ける (cross/20 F-28)。代替案: `/account/billing` を同意の画面への回し先から外す (`lib/legal-consent.ts` の除外に足す。同意の前に購入の確認画面へ進めないよう `/account/billing/checkout` は外さない。cross/13a の許可の範囲を変える別の冊) |
| Q-16 | 有料プランで、献立の作成 (1 週間・1 日・1 食) が作る料理画像の量 | **確定 (発注者の選択 2026-10-19。§0.4 の追記 3「主菜の 1 品だけ作る (推奨)」): 自動の料理画像は献立の主菜の 1 品だけに作る。主菜 = 料理の役割 (`dishes[].role`) が `main` か `主菜` の最初の料理、主菜の無い献立は先頭の料理 (`autoImageDishIndexOf`。§8.8)。献立の作成だけでなく、料理画像のジョブを積むすべての入口 (料理の保存・更新の 4 本の route・AI 相談の料理の更新・積み直しの道具) に同じ規則を当て、プランで分けない (無料は Q-3 で自動の料理画像を作らないので、そちらが先に効く)。ほかの料理は画像を持たず、料理の画面は画像の枠を出さない (献立のカバー = 主菜の画像を代わりに出さない。§10.3)。利用者が押して作る「AIで料理画像を生成」(`image_generation`) は Q-3 の上限の中で使える (料理が 2 品以上の献立では献立のカバーになる。料理を選んで作る入口は Q-18)** | 推計 (§2.4) では、料理ごとに作る v1.7 のままだと 1 週間の作成 1 回の料理画像が 63〜84 枚 ≈ 630〜840 円で、週 1 回作る個人 Pro の利用者の原価は月 ≈ 2,600〜3,400 円になる。主菜の 1 品だけにすると 1 週間 21 枚 ≈ 210 円 (月 ≈ 900 円) で、料理画像の原価は 1/3〜1/4 になる。それでも週 1 回の 1 週間の作成で月額 580 円を超えうる (推計。1 枚の単価は §18 の 3) ので、販売開始の後 1 週間の実測 (AI 事業者を呼び出した記録 `llm_usage_logs`) で確かめる (§18 の 3)。選ばれなかった案: (b) 献立の作成では作らず、料理を保存し直したときと「料理画像の作成」で作る (原価は Q-3 の上限の中) |
| Q-17 | App Store と Google Play (ストアの事業者) をプライバシーポリシー第7条 (委託先) の表に載せるか (cross/20 §17 の「Issue #1912」の行は「ストアの事業者」も `PRIVACY_PROCESSORS` に足すと書く) | **載せない**。第7条には当社が取扱いを委ねる決済の事業者 (Stripe) と RevenueCat を足し、ストアの事業者は第3条の有料プランの行に「Apple または Google が各ストアの規約に従って決済を行い、当社は RevenueCat を通じて購入の情報を受け取る」と書く (§11.2) | 第7条の表の前の文は「次の事業者に個人データの取扱いを委託しています」で、ストアの事業者は利用者と直接に売買し、自らの規約で情報を扱う (当社が委ねていない)。委託先として書くと事実と違う。分類の最終の判断は弁護士の確認 (cross/20 の公開の手順 §9.4 の 1 と同じ)。載せるとしたら `PRIVACY_PROCESSORS` に 2 行足し、`T-24` の行の数と主張の表を直す |
| Q-18 | 主菜でない料理 (副菜・汁物など) の画像を、利用者が料理を選んで作る入口を足すか (Q-16 で主菜でない料理は自動の画像を持たなくなるため) | **本冊では足さない。利用者が押して作る画像は、いまの献立の編集の「AIで画像生成」(`ManualEditModal` → `ImageGenerateModal` の「AIで料理画像を生成」→ `POST /api/ai/image/generate`。`image_generation` を数える。無料は 403 `AI_FEATURE_NOT_IN_PLAN`、有料は 1 日の上限の中) のまま** | いまの入口は献立に 1 枚の画像を作り、料理が 1 品の献立ではその料理の画像 (`manual_override`)、2 品以上の献立では献立のカバーになる (F26)。料理を選んで作る入口は、料理の位置を受ける API と画面・AI の入口の棚卸し (`tests/ai-consent-enforcement.test.ts` ほか) を足す別の冊になる (§18 の 25) |

### 0.6 機能 × プランの表 (線引きの一覧。Q-2・Q-3・Q-4・Q-16 の行は §0.4 の追記 3 で確定した値)

値の正本は右から 2 列目の場所で、本表はその写し (表と正本の一致は契約テスト 37・38 が migration と `packages/shared/src/billing-plans.ts` の間で見る)。「1 日の合計の中」= 機能ごとの上限を持たず、`ai_daily_limits` の 1 日の合計だけで止まる。

| 機能 | 無料 (`free`) | 個人 Pro (`pro`) | 家族 Basic (`family_basic`) | 家族 Pro (`family_pro`) | 値の正本 | 確認事項 |
|---|---|---|---|---|---|---|
| 月額 / 年額 (税込) | 0 円 | 580 円 / 5,800 円 | 980 円 / 9,800 円 | 1,480 円 / 14,800 円 | `subscription_plans` (§6.2)・`PLAN_CATALOG` (§8.9) | 決定済み (§0.4)・Q-1 (ストアの価格帯) |
| 無料体験 | — | 7 日 | 7 日 | 7 日 | `subscription_plans.trial_days` (Web)・ストアの Introductory Offer / offer (アプリ。§17.2) | 決定済み (§0.4)・Q-10 |
| AI を使う機能の 1 日の合計 | 3 回 | 30 回 | 30 回 (メンバー 1 人ごと) | 50 回 (メンバー 1 人ごと) | `ai_daily_limits` (§6.5)・`PLAN_AI_DAILY_LIMITS` | Q-2 (確定) |
| 献立の作成と作り直し (`menu_generation`。1 週間・1 日・1 食・栄養の分析の献立の提案・AI 相談からの作成。キューに積んで後で作るものは積んだときの 1 回だけ (F23)) | 1 日 3 回 (1 日の合計と同じ値。§0.5 の Q-2) | 1 日 10 回 | 1 日 10 回 | 1 日 15 回 | `ai_plan_feature_caps`・`PLAN_MENU_GENERATION_DAILY_CAPS` | Q-3 (確定) |
| 究極モード (`menu_generation_ultimate`) | 使えない (0) | 1 日 2 回 | 1 日 2 回 | 1 日 3 回 | `ai_plan_feature_caps`・`PLAN_ULTIMATE_DAILY_CAPS` | Q-3 (確定) |
| 料理画像の作成 (`image_generation`。利用者が押して作る献立の画像。料理が 2 品以上の献立では献立のカバー。Q-18) | 使えない (0) | 1 日の合計の中 | 1 日の合計の中 | 1 日の合計の中 | `ai_plan_feature_caps` | Q-3 (確定) |
| 自動の料理画像 (`meal_image_auto`。料理の保存・更新と、献立の作成が作る料理の画像) | 作らない (0) | 献立の主菜の 1 品だけ作る (主菜の無い献立は先頭の料理。どの入口も同じ。保存は安全弁 1 日 20 回) | 同左 | 同左 | `ai_plan_feature_caps` + `ai_unmetered_daily_caps` (安全弁)・作る料理は `autoImageDishIndexOf` (§8.8) | Q-3・Q-16 (確定) |
| 写真の記録 (`photo_analysis`)・AI 相談 (`consultation`)・栄養士のコメント (`nutrition_advice`)・健康のレビュー (`health_review`)・買い物リストの作り直し (`shopping_list`) | 1 日の合計の中 | 1 日の合計の中 | 1 日の合計の中 | 1 日の合計の中 | (機能ごとの上限なし。いまと同じ) | Q-2 |
| 栄養士のコメントの自動の取得 (`nutrition_advice_auto`) | 合計に数えない・安全弁 1 日 30 回 | 同左 | 同左 | 同左 | `ai_unmetered_daily_caps` (いまと同じ) | — |
| 家族グループの作成 | できない (`FAMILY_PLAN_REQUIRED`) | できない | できる (代表者になる) | できる (代表者になる) | `create_family_group` の門 (§6.6) | Q-4 (確定) |
| 家族グループのメンバーの追加 (招待の承諾・子供の追加) | 代表者の契約で決まる (代表者が家族プランでなければ足せない) | 同左 | 4 人まで | 8 人まで | `family_members` のトリガー (§6.6)・`subscription_plans.max_members` | Q-4 (確定) |
| 家族プランの代表者のグループのメンバー (個人の契約が無い人) | 家族プランの AI の上限と機能を受ける (`get_effective_plan` が家族のプランを返す) | (個人の契約が先) | — | — | `get_effective_plan` (変えない) | — |

無料から外すもの (いまとの差): 究極モード (いまは全員 1 日 1 回)・料理画像の作成・自動の料理画像 (料理の保存と献立の作成の両方)・家族グループの作成とメンバーの追加。無料の AI の 1 日の合計は 10 回から 3 回に、献立の作成と作り直しは合計の中から 1 日 3 回に絞る (1 日の合計と同じ値)。有料プランの自動の料理画像は、作った料理ごとから献立の主菜の 1 品だけに減らす (Q-16)。組織の利用者 (個人の契約も家族も無い) の上限は変えない (組織の plan の値に、いまの free の値 10 回を写す。§6.5 (5a)・S26)。

---

## 1. 目的・スコープ

- 利用者が有料プラン (`pro` = 個人 Pro / `family_basic` = 家族 Basic / `family_pro` = 家族 Pro) を、Web では Stripe Checkout (billing/01)、iOS では App Store、Android では Google Play で買え、どこで買っても `personal_subscriptions` に 1 行の live な契約として写り、`get_effective_plan` / `plan_key_cached` / 家族グループのプランが同じ規則で決まる。
- 有料と無料の線引き (AI の回数・重い AI・家族の機能・無料の範囲) が DB の値 (`ai_daily_limits`・`ai_plan_feature_caps`・家族の門) で決まり、画面はその結果を説明する。 自動の料理画像は、どのプランでも献立の主菜の 1 品だけに作る (Q-16)。
- 公開の面 (料金・特商法・FAQ・紹介ページ・規約・ポリシー) が、販売の内容を、未完成や予定を示す文を使わずに載せる (会社情報は #1911 で入っている)。
- 退会の確認が、ストアの購読は退会で解約されないことを知らせる (アプリで買った人の退会の画面を含む。§10.4)。
- 対象外: §0.2 右列。

---

## 2. 関連要件と現行の事実

### 2.1 関連要件・既存設計

| 文書 | 使う箇所 |
|---|---|
| `docs/design/billing/01-billing-core.md` | §6.4 (9) 写像・(10) 家族のトリガー・(11) 特権列ガード・§7 表 3 点・§8.1 `core.ts`・§9 API・§10 画面 (§10.4 は本冊で改定)・§12 配線の契約・§13 エラー表・§16 追随・§17 本番の準備・§18 の 1・2・14 |
| `docs/design/billing/02-manual-plan-grant.md` | §6.2〜§6.4 M 行の述語 (`stripe_subscription_id IS NULL`。本冊で `iap_store IS NULL` を足す)・§7.3 |
| `docs/design/cross/04-api-conventions.md` | §4 エラーコード・§5 応答の形・§10 Webhook 規約 |
| `docs/design/cross/08-legal-compliance.md` | §3 特商法の最終確認画面・§7 再同意 |
| `docs/design/cross/13a-legal-consent-api-server.md` | §6.2 未同意でも止めない API の許可リスト |
| `docs/design/mobile/01-architecture.md`・`07-toolchain-upgrade.md` | WebView ハイブリッド・Expo SDK 58 / RN 0.88 / Jest 30 |
| `docs/design/operator/04-plan-management.md` | §3.3 価格変更 (新規契約だけに適用)・§5.2 試用 |
| `docs/design/operator/06-ai-llm.md`・`cross/06-perf-cache.md` | AI の上限の運営画面 (`/super-admin/llm/quotas`) |
| `docs/design/family/01-data-model.md`・`08-rls-policies.md`・`membership/02-flow-spec.md` | `family_groups.plan_key` / `member_limit`・`create_family_group`・メンバーの追加の DB 関数 |
| `docs/design/CLAUDE.md` | RLS 必須・service_role は限定・監査ログ必須・snake_case・横断ルール A (plan_key は FK) |

### 2.2 現行の事実 (origin/main `4b1e1abe` (#1911 のマージ。`66d02c5d` で cross/20 が入った後) と本番の読み取り (`subscription_plans`・`ai_daily_limits`・`ai_unmetered_daily_caps`・`feature_packages`・`feature_flags`・`pg_proc`・`information_schema.columns`)。2026-10-19)

| # | 事実 | 出どころ |
|---|---|---|
| F1 | 本番の `subscription_plans`: `pro` 980 / 9,800・試用 7 日・`display_order` 20 / `family_basic` 1,480 / 14,800・`max_members` 4・30 / `family_pro` 2,480 / 24,800・`max_members` 8・40 / `free` 0 / `family_addon` 280 (private) / `org_*` 4 行。全行の `stripe_product_id` / `stripe_price_id` / `stripe_yearly_price_id` が NULL。`feature_packages` は全行 `[]`。`draft` の試験の行が 2 件 (`test_integration_plan_1778236006448`・`test_patch_plan_1778236006448`)。シードは `supabase/migrations/20251126124224_create_meal_planner_tables.sql:14165-14169` | 本番 SELECT |
| F2 | 公開の面は #1911 (`4b1e1abe`) で「準備中」を取り除き、有料プランを出していない: `src/app/pricing/PricingPageView.tsx` は買えるプラン (`isPurchasable` が真の間隔を持つプラン) が 0 件のとき (`onSale` が偽。`:97`。本番は Price が無いので常に 0 件)、見出しの下に「現在は無料でご利用いただけます。」(`:123-127`)・フリーのカードの金額の横に「現在は無料」(`:147`)・FAQ「現在、料金はかかりますか？」(`faqs` `:67-69`・描画 `:221-239`) を出し、有料のカードを出さない (`showPaidCards = onSale && !isNativeApp`。`:99`)。フリーのカードの一覧 `freeFeatures` (`:50-57`) と注記 `AI_DAILY_LIMIT_NOTE` (`:64-65`。「1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。」を含む) はこのファイルの定数。`src/app/legal/page.tsx` の `rows` (`:31-50`) は 販売事業者・代表者・所在地・電話番号 (`<PhoneOnRequest/>`)・メールアドレス・営業時間・お問い合わせ・動作環境 の 8 行で、販売の項目 (販売価格・商品代金以外の必要料金・支払方法・支払時期・サービス提供時期・返品・キャンセル・解約について) は「有料プランの販売 (#1912) が足す」(`:29-30` の注) として出していない。「最終更新日：2026年10月19日」(`:92`)。`src/app/company/page.tsx` は会社名・設立・資本金・代表者・所在地・事業内容・メールアドレス・電話番号・営業時間を `business-info.ts` から出す (`:46-56`。本冊で変えない)。`src/app/faq/page.tsx` の料金は「現在、料金はかかりますか？」(`:78`。答えは「現在ご提供している機能は無料でご利用いただけます。…」) と「返金はできますか？」(`:79`) の 2 項目 (1 項目 1 行の `{ category, q, a }` で、`a` は一重引用符の文字列)。紹介ページは F20。見張りは F21 | 各ファイル |
| F3 | 買える判定: `src/lib/billing/public-plans.ts:14-27` `listPurchasablePlans` は `status='public' AND plan_type IN (personal, family) AND plan_key <> 'free' AND stripe_price_id IS NOT NULL` だけを返す (本番は 0 件)。`src/lib/billing/core.ts:434-444` `isPurchasable(plan, interval)` は Price と金額 > 0。`/pricing` (`src/app/pricing/page.tsx`) は `listPurchasablePlans` + Cookie `is_native_app` で `PricingPageView` を描く | 各ファイル |
| F4 | 核の契約: `personal_subscriptions` の列は本番で `id, user_id, plan_key, status, trial_started_at, trial_ends_at, trial_source, paused_at, paused_until, pause_reason, starts_at, current_period_start, current_period_end, cancel_at, cancelled_at, past_due_since, grace_started_at, stripe_customer_id, stripe_subscription_id, stripe_price_id, active_coupon_redemption_id, notes, created_at, updated_at, stripe_synced_at, stripe_status, cancel_at_period_end, billing_interval`。status の CHECK は 8 値 (`incomplete / trialing / active / paused / cancelled / expired / past_due / grace`)。部分 UNIQUE `idx_personal_subscriptions_active_per_user (user_id) WHERE status IN (trialing, active, paused, past_due, grace)`。写像 `billing_apply_stripe_subscription(jsonb, timestamptz, text)` (`supabase/migrations/20261016210000_billing_core.sql:190-425`) が `plan_key_cached`・`family_groups.plan_key / member_limit`・監査 (`system.billing.subscription_created` / `subscription_status_changed`) を書く。ロックの順: advisory `billing-user:<uuid>` → `stripe-subscription:<id>` → 契約の行 → `family_groups` → `user_profiles` | 本番 `information_schema.columns`・migration |
| F5 | 手動付与 (billing/02) の M 行の述語は `stripe_subscription_id IS NULL` (`supabase/migrations/20261017230000_billing_manual_plan_grant.sql:8,147,171,226,273`)。`src/lib/billing/manual-grant-repository.ts:101` も `stripe_subscription_id === null ? 'manual' : 'stripe'`。`src/lib/billing/core.ts:724-744` `summarizeSubscription` の `source` も同じ 2 値 (`stripe` / `manual`)。本冊がストアの行を足すと、この述語ではストアの行が M 行に見える | 各ファイル |
| F6 | 権利判定: `get_effective_plan(p_user_id)` (`supabase/migrations/20261010140000_ai_usage_foundation.sql:94-`) = 個人契約 (`trialing / active / grace / past_due`) → 家族 (`family_members.status='active'` かつ `family_groups.status='active'` の `plan_key`) → 組織 → `free`。TS の入口 `getEffectivePlan` (`src/lib/plan/entitlements.ts:366-372`)。機能フラグは `plan_key_cached` (空 = free。`src/lib/feature-flags.ts:217-229`) | 各ファイル |
| F7 | AI の上限: `ai_daily_limits(plan_key PK, daily_limit NULL = 無制限)` は本番で `free = 10` の 1 行 (`20261011020000_ai_daily_limits.sql`)。判定は `consume_ai_usage_at` (最新の定義は `20261011030000_ai_usage_unmetered_caps_and_grants.sql`。`c_unmetered` に 2 機能・`ai_unmetered_daily_caps` の安全弁 (本番: `nutrition_advice_auto` 30・`meal_image_auto` 20)) が `get_effective_plan` のプランの行 (無ければ `free` の行) の値と、その日の上限に数える機能の合計を比べる。究極モードは `consume_ai_usage_capped_at(p_user_id, p_feature, p_feature_daily_cap, p_at)` (`20261014100000_ai_usage_feature_daily_cap.sql`) が機能ごとの回数を先に比べ、cap は呼び出し側 (`src/lib/plan/entitlements.ts` の `consumeAiUsage` → `aiFeatureDailyCap` → 環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT`・既定 `AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT = 1`) が渡す。機能名は `AI_FEATURES` (`supabase/functions/_shared/ai-usage-core.ts:53-87`。`menu_generation` / `menu_generation_ultimate` / `consultation` / `photo_analysis` / `nutrition_advice` / `health_review` / `shopping_list` / `image_generation` / `nutrition_advice_auto` / `meal_image_auto`)。止めたときの応答は `aiDailyLimitPayload` (`supabase/functions/_shared/ai-daily-limit.ts`。429 `AI_DAILY_LIMIT`・`capped_feature` のときは究極モードの文)。Web の画面は `src/lib/ai/daily-limit-client.ts`、モバイルは `apps/mobile/src/lib/ai-daily-limit.ts` (429 だけを `AiDailyLimitError` にする) | 各ファイル・本番 SELECT |
| F8 | 究極モードの UI: Web `src/components/ai-assistant/V4GenerateModal.tsx:884-929` (全員に開放。トグル `data-testid="ultimate-mode-toggle"`)・モバイル `apps/mobile/src/components/menu/UltimateModeToggle.tsx` (同)。どちらもプランを見ない。数えるのは `src/app/api/ai/menu/v4/generate/route.ts:336-343`・`src/lib/ai/consultation-action-executor.ts:354-359` (`menu_generation_ultimate`) | 各ファイル |
| F9 | 家族: `create_family_group(p_name, p_plan_key DEFAULT 'free')` の最新の定義は `20261017030000_parental_consent_and_birth_date.sql:798-831` (`NOT_AUTHENTICATED` → `MINOR_ACCOUNT_NOT_ALLOWED` → `ALREADY_IN_FAMILY` → `family_groups` INSERT (billing/01 のトリガー `family_groups_billing_plan_follow_representative` が `plan_key` を代表者の契約から決める。契約が無ければ `free`) → `family_members` INSERT (`role='representative'`) → `user_profiles.family_id` → `membership_audit`)。route `src/app/api/family/groups/route.ts:53-55` は `p_name` だけで呼ぶ。`family_members` に INSERT する DB 関数は 7 本の migration にまたがる (`accept_family_invite`・`add_family_child`・昇格 ほか。`git grep -n 'INSERT INTO (public\.)?family_members' origin/main -- supabase/migrations`)。`family_members` にトリガーは無い。`family_members.role` は enum `family_role_enum` (`representative` / `adult` / `child`)、`status` は `active / removed / left`。`member_limit` は `family_groups` (CHECK 1〜20、既定 4)。エラーコードの正本は `src/lib/errors/membership-errors.ts` (`MembershipErrorCode`・`MEMBERSHIP_ERROR_MESSAGES`・HTTP の表) | 各ファイル |
| F10 | モバイル: `apps/mobile` は Expo SDK 58 (`expo ~58.0.14`・`react-native 0.88.0`・`expo-router ~58.0.23`・`jest-expo ~58.0.11`)。`expo-dev-client`・`react-native-purchases` は無い。`app.json` の plugins は `expo-router` / `expo-image-picker` / `expo-notifications` / `expo-splash-screen`、`ios.bundleIdentifier` = `android.package` = `com.homegohan.app`。`eas.json` は `development` (`developmentClient: true`・iOS simulator) / `preview` (apk) / `production` (app-bundle・`autoIncrement`)、`submit.production.ios.ascAppId` あり。設定タブ `apps/mobile/app/(tabs)/settings.tsx` は `SettingRow` の節 (一般 / 個人情報 / データとプライバシー / ガイド / サポートと法的情報 / アカウント)。認証は `apps/mobile/src/providers/AuthProvider.tsx` (`useAuth()` の `user`・`session`)、サインアウトは `apps/mobile/src/lib/signOut.ts`。API は `apps/mobile/src/lib/api.ts` の `getApi()` (Bearer。`withFriendlyErrors` が 429 / 403 / 503 を固定の文の例外にする)。見張り `apps/mobile/__tests__/app/no-web-purchase-links.test.ts` は `app/` と `src/` に `/pricing`・`/account/billing` の文字列が無いことと `app/(public)/pricing.tsx` が無いことを見る。`apps/mobile/__tests__/app/route-targets-exist.test.ts` は遷移先の画面の実在。`apps/mobile/__tests__/lib/env-example.test.ts` は `process.env.EXPO_PUBLIC_*` が `env.example` にあること。jest の mock は `apps/mobile/__mocks__/` (`expo-secure-store.js`・`react-native-webview.js`) と `jest.config.js` の `moduleNameMapper` | 各ファイル |
| F11 | Web の契約の画面: `src/app/(main)/account/billing/page.tsx` は `BillingSummary` の `has_customer` / `can_cancel` / `can_resume` / `can_purchase` でボタンを出し、`isNativeApp` では表示だけ。`src/app/(main)/account/billing/checkout/page.tsx` は `isNativeApp` で「この操作はアプリでは行えません」。`src/app/frozen/billing/page.tsx` は凍結中の解約。`src/app/(main)/settings/page.tsx:445-463` は Web だけに「プランとお支払い」の行 | 各ファイル |
| F12 | 環境変数の一覧 `src/lib/env.ts` の `SERVER_ENV_VARS` に `STRIPE_SECRET_KEY`・`STRIPE_WEBHOOK_SECRET`・`AI_ULTIMATE_MODE_DAILY_LIMIT` (`readOnlyBy: src/lib/plan/entitlements.ts`)。`.env.example:93-98`・`ENV_SETUP.md:59-61` に Stripe の節 (`4.`)。見張り `tests/env-source-scan.test.ts` (一覧と `.env.example` の突き合わせ・`ENV_SETUP.md` の節の番号) | 各ファイル |
| F13 | 事業者情報は #1911 で入った `src/lib/business-info.ts` の定数: `BUSINESS_NAME` (`:17`)・`BUSINESS_REPRESENTATIVE` (`:20`)・`BUSINESS_ADDRESS` (`:23`。「〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F」)・`BUSINESS_ESTABLISHED` (`:26`)・`BUSINESS_CAPITAL` (`:29`)・`BUSINESS_EMAIL` (`:32`。`info@mhd-iken.com`)・`BUSINESS_HOURS` (`:35`。「平日 9:00-17:00 (年末年始を除く)」)・`PHONE_DISCLOSED_ON_REQUEST` (`:41`。「請求があれば遅滞なく開示します」)。電話番号の欄は部品 `src/components/legal/PhoneOnRequest.tsx` (文 + `BUSINESS_EMAIL` + お問い合わせのフォームへのリンク) が `/legal` と `/company` の両方で描く。追記 2 の会社情報はすべて入っている (本冊は `business-info.ts` を変えない) | 各ファイル |
| F14 | 規約の版: `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` (`terms_of_service` / `privacy_policy` とも `version: 'v2025.1'`)。形式 `^[0-9A-Za-z._-]{1,20}$`。版を変えると再同意が走る (middleware の同意ゲート)。#1901 の本文の正典 `docs/design/cross/20-terms-privacy-text.md` (v1.13・設計ゲート通過) は main にマージ済み (`66d02c5d`)。その実装 (文面モジュール `src/lib/legal/legal-text.ts`・`terms-text.ts`・`privacy-text.ts`・`index.ts`、描画部品 `src/components/legal/LegalDocumentBody.tsx`、主張の表 `tests/legal-claims-1901.ts`、テスト `tests/legal-text-1901.test.ts`、版 `v2026.1`) は origin/main `4b1e1abe` には無い (`src/lib/legal/terms-text.ts` が無い)。cross/20 の利用規約は第1〜28条 + 附則、プライバシーポリシーは第1〜18条 (cross/20 §6・§7)。その実装は origin/main `2ba5b3b3` (#1918・cross/20 v1.14) でマージされた: 版は `v2026.1` (`packages/shared/src/legal-versions.ts`)、旧版の控えは `docs/legal/archive/v2025.1/`、主張の表は `LEGAL_CLAIM_COUNT = 382` (`tests/legal-claims-1901.ts:25`。cross/20 v1.14 の §18 Q-23 で第24条 2 項の文が変わり、`terms-24` の行は `#1`〜`#9`)。あわせて、同意の前に本人が退会と書き出しを行う画面 `/legal-consent/account` (`src/app/legal-consent/account/page.tsx`・`AccountWithoutConsent.tsx`) と、凍結中の退会 (`src/app/frozen/account/page.tsx`) と共通の退会と書き出しの部品 `src/components/account/AccountSelfServicePanel.tsx` が入った (退会の API を呼ぶのは部品の側。§10.4)。その後の origin/main `465727de` (#1917・family/11 の実装・cross/20 v1.16) で、版は両文書とも `v2026.2`・施行日 `2026-10-21` (`packages/shared/src/legal-versions.ts:53-54`) に上がり、旧版の控え `docs/legal/archive/v2026.1/terms.md`・`privacy.md` ができた。利用規約第11条 4 項・第12条 4 項・第17条 2 項とプライバシーポリシー第13条 9 項は「譲渡するか、…解散するまで、退会できません」の文に変わった。主張の表は行の数 382 と `id` のままで、6 行 (`terms-11#7`・`terms-11#8`・`terms-12#5`・`terms-12#6`・`terms-17#5`・`privacy-13#9`) の `chars` と根拠が変わり、`terms-11#8`・`terms-12#6` の区分が `process` から `product` になった (区分の数は cross/20 v1.16 §10.2: 利用規約 product 72・contract 90・law 2・process 3・計 167 / プライバシーポリシー product 150・contract 21・law 31・process 13・計 215)。保護者の同意書の版 (`PARENTAL_CONSENT_DOCUMENT.version`。`packages/shared/src/parental-consent.ts:43`) も `v2026.2` だが、`LEGAL_DOCUMENTS` とは別の値 | 各ファイル・cross/20 |
| F15 | Webhook の受け口の規約: `src/app/api/webhooks/stripe/route.ts` (`runtime nodejs`・`maxDuration 30`・大きさの上限 → 署名 → 外形 → 鍵 → モード → claim → 処理 → finish)・`src/lib/webhook/verify.ts` (Svix と Stripe の署名の確認。`WebhookSecretMissingError`)・`stripe_webhook_events` + `billing_claim_stripe_event` / `billing_finish_stripe_event` (冪等キー = event.id。`claimed / completed / in_progress`)。メンテナンス中は 503 で Stripe が再送する (`src/lib/maintenance-mode.ts`) | 各ファイル |
| F16 | AI の入口の棚卸し `tests/ai-consent-enforcement.test.ts` は、`@/lib/env` (AI の印に届く) を import する route をすべて `EXEMPT_ROUTES` (`tests/helpers/ai-consent-enforced-paths.ts`) に載せることを求める。課金の route 5 本と Webhook と退会が載っている (billing/01 §16.1) | 各ファイル |
| F17 | 未同意でも止めない API の許可リスト `packages/shared/src/legal-consent-api.ts:103-137` (`LEGAL_CONSENT_EXEMPT_API_PATHS`。退会・書き出し・課金の 3 本と、#1917 (origin/main `465727de`) が足した家族グループ・組織の解散の 2 本 (`/api/family/dissolve`・`/api/org/dissolve`) の 7 本が `leave_service`)。凍結中も通す API `src/lib/auth/frozen.ts:70-78` の `FROZEN_ALLOWED_API_PATHS` (7 本。退会・書き出し・課金の 3 本・家族グループの解散・組織の解散。最後の 2 本は #1917 が足した。`toEqual` で固定: `lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts`) | 各ファイル |
| F18 | 本番の DB 関数 (`pg_proc`): `billing_apply_stripe_subscription`・`billing_claim_stripe_event`・`billing_finish_stripe_event`・`billing_family_plan_follow_representative`・`billing_grant_manual_subscription`・`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・`billing_expire_manual_subscriptions`・`billing_manual_subscription_sync_after_end`・`consume_ai_usage`・`consume_ai_usage_capped`・`refund_ai_usage`・`claim_ai_usage_grant`・`get_effective_plan`・`create_family_group(p_name, p_plan_key)`・`guard_user_profiles_privileged(_on_insert)` が実在する (本冊の土台) | 本番 `pg_proc` |
| F19 | `tests/billing-audit-action-lists-doc.test.ts` は、課金の監査の名前の一覧が `BILLING_AUDIT_ACTIONS` (core.ts の 9 つ) と `MANUAL_GRANT_AUDIT_ACTION_VALUES` の 2 つで、`operator/07` §4 の網羅リストの `*.billing.*` の名前がどちらかの一覧にあること・`BILLING_AUDIT_ACTIONS` の数の記述 (「N つ」) がコードと同じことを見る | 同ファイル |
| F20 | 紹介ページの文言の正本 `src/components/marketing/landing-copy.ts` (#1911 の後): `PlanCardSchema` の `id: z.enum(['free'])` (`:272`) と `pricing.plans: z.array(PlanCardSchema).length(1)` (`:357`)・料金の章 (`:765-783`。`title: 'いまは、無料で使えます。'` `:767`・`lead` `:768`・カードは `free` の 1 枚だけ `:770-777`。`items` の最後が `'AI に相談', '家族で使う'`)・`ASSURANCES` の `'いまは無料で使えます'` (`:451`)・features の家族のカード (`:578`)・場面の「子育て家庭」(`:714`)・家族の章の `lead` (`:722`)・要点 `trust` の「いまは無料で使えます」(`:755`)・FAQ「本当に無料で使えますか？」(`:812`) と「家族で使えますか？」(`:820`)・主張の表 `claims` の `family` (`:858`)・`free-now` (`:859`。`text: '登録して使える機能は、いまは無料'`)・`ai-daily-limit` (`:860`)。紹介ページの描き方 `src/components/marketing/sections/PricingSection.tsx` はカードの数を数えずに `plans` を描き、冒頭の注 (`:1-3`) は「カード 1 枚」と書く。見た目 `src/components/marketing/marketing.css` は #1911 でカード 2 列の指定と `.lp-plan--paid`・`.lp-pill--paid` を消し、`.lp .lp-plans` の幅を 28rem にした (`:1881-1887`)。`tests/public-claims-guard.test.ts` はこのファイルのソースを `FORBIDDEN` で走査する (描画はしない)。`tests/landing-page-1867.test.ts` は U-24 (`すべて無料` を含む文字列がちょうど 3 つ。`:799-`)・U-15 (`SITE_DESCRIPTION` の逐語「…いまは無料で使えます。」。`:593-604`)・U-3 (主張の id の数 46。`:195-196`) を見る | 同ファイル |
| F21 | #1911 の見張り: `tests/no-pending-wording-1911.test.ts` は `src/app`・`src/components`・`src/lib`・`src/hooks`・`apps/mobile/app`・`apps/mobile/src`・`supabase/functions` の `.ts`/`.tsx` (テストを除く) と `landing-copy.ts`・`core.ts`・`public-plans.ts` ほかのソースから、コメントを除いた部分に未完成・予定の語 (`FORBIDDEN_PATTERNS`: 準備中・販売開始前・近日・公開予定・確定次第・決まり次第・決まりましたら・順次整備・coming soon・まだ作られて・（未対応）・予定です・できてから選べる) が無いことを見る (`:29-63`)。`tests/public-claims-guard.test.ts` は `FORBIDDEN` (`¥980`・`980円`・`9,800円` を「未確定の価格」として持つ。`:173-177`)・`PENDING_WORDS` (`:221`)・`LEGAL_SALE_ROW_LABELS` (販売の 7 項目を `/legal` に出さないこと。`:226-234`・`:333-341`)・`LEGAL_NOT_SELLING_TEXTS` (`:236-241`)・`#1151 料金ページ` (`/pricing` を 0 件で描き「現在は無料でご利用いただけます。」を含み「有料プラン」を含まない。`:424-448`)・`billing/01 §10.1` のデータ駆動 (`:470-561`)・`/faq` の「プランごとの上限・料金」の語 (`無料プランでは`・`月額`・`年払い` ほか) を書かない it (`:567-571`)・`#1867 (Q-12)` (`/faq`「現在、料金はかかりますか？」の答えと `/pricing` に `AI_DAILY_LIMIT_PHRASE` があり、`/pricing` は 0 件で 2 回。`:631-655`)。`vi.mock('@/lib/billing/public-plans')` は `listPurchasablePlans` を差し替える (`:58-60`)。`tests/business-info-legal-pages.test.ts` は `/legal` の行の値が空・仮置きでないこと (`:125-172`) を見る (販売の行が増えても、値があれば緑)。`tests/e2e/b10-unexplored-areas.spec.ts` の 4-1 は「現在は無料でご利用いただけます。」が見え `¥980` が無いこと (`:240-255`)、4-3 は `販売価格`・`支払方法` が無いこと (`:282-283`) を見る | 各ファイル |
| F22 | 料理画像のジョブを積む入口は 6 つ: 料理の保存・更新の route 4 本 (`src/app/api/meals/route.ts:269`・`src/app/api/meals/[id]/route.ts:267`・`src/app/api/meal-plans/meals/route.ts:209`・`src/app/api/meal-plans/meals/[id]/route.ts:225`) と AI 相談の料理の更新 (`src/lib/ai/consultation-action-executor.ts:871`) は、積む前に `consumeAiUsage(user.id, 'meal_image_auto')` を呼ぶ。献立の作成 (Edge の `generate-menu-v4` / `v5` が `supabase/functions/_shared/save-meal.ts` の `saveMealToDb` で保存) は、作った料理のすべてに `reconcileDishImages` (`save-meal.ts:611-631`。`regeneration: true`) でジョブを作り、`enqueueMealImageJobs` → `triggerMealImageJobProcessing` (`:757-776`) で積む。`consume_ai_usage` は呼ばない (`save-meal.ts`・`_shared/meal-image-jobs.ts` に `consume`・`meal_image_auto` が無い。献立の作成の画像は `menu_generation` の 1 回に含めて数える。`tests/helpers/ai-consent-enforced-paths.ts:389-396` の `process-meal-image-jobs` の注)。(本冊の後は、どの入口も献立の主菜の 1 品だけに積む。Q-16・F26・§8.8)。ジョブを処理して Google へ送るのは Edge の `process-meal-image-jobs` だけ: ジョブごとに献立の持ち主の同意を判定し、同意が無ければジョブを `cancelled` にして料理を `failed` + 理由にする (`index.ts:234-251`。料理の書き込みは `utils.ts:190` の `writeDishImageFailure` が `image_status: 'failed'`・`image_error: <理由>` にする) | 各ファイル |
| F23 | `menu_generation` を数える入口 (`consumeAiUsage(user.id, 'menu_generation')`): 1 週間の献立の作成の依頼 `src/app/api/ai/menu/weekly/request/route.ts:173`・枠を選んだ作成 `src/app/api/ai/menu/v4/generate/route.ts:347`・`v5/generate/route.ts:296` (究極モードでなければ)・1 日の作り直し `src/app/api/ai/menu/day/regenerate/route.ts:123`・1 食の作成 `src/app/api/ai/menu/meal/generate/route.ts:100`・1 食の作り直し `src/app/api/ai/menu/meal/regenerate/route.ts:86`・栄養の分析の献立の提案 (1 食の作り直し。`src/app/api/ai/nutrition-analysis/route.ts:414`)・AI 相談のアクション (1 日 `src/lib/ai/consultation-action-executor.ts:360`・複数日 `:482`・1 食 `:620`)。Edge の `generate-menu-v4/index.ts:2897-2902`・`generate-menu-v5/index.ts:3626-3631` は利用者の JWT で直接呼ばれたとき (`directJwtUserId` が非 NULL) だけ `consumeEdgeAiUsage` で数える (究極モードなら `menu_generation_ultimate`・それ以外は `menu_generation`。止めたときは行を `failed` + `aiDailyLimitMessageOfDenied` の文にして `aiDailyLimitEdgeResponse`。§8.8 の表)。どれも操作 1 回で 1 回 (作る食の数に依らない)。**キューの処理は数えない**: 献立の作成のリクエストの行 (`weekly_menu_requests`) は入口が数えたあとに service role で書き (`src/lib/ai/ai-queue-writer.ts` の `getAiQueueWriter`)、その行を処理するのは Vercel Cron の `src/app/api/cron/process-menu-queue/route.ts` (`claim_menu_request` で 1 行取り、`:98-110` で行の `generated_data` (究極モードの印 `ultimateMode` を含む) を載せて `generate-menu-v5` を service role の鍵で呼ぶ) と、入口の route が呼ぶ `src/lib/generate-menu-v4-retry.ts:171-177`・`src/lib/generate-menu-v5-retry.ts:103-109` (service role の鍵)。Edge は service role の呼び出しでは `directJwtUserId` が NULL なので数えず、プランも見ない (積んだ時点で 1 回数える。`src/lib/weekly-menu-request-stale.ts:17`・`src/lib/ai/ai-queue-tables.ts:3`)。`src/app/api/menu-plans/add/route.ts:78-94` も行を作るが、AI を使わない単発の追加 (`status: 'pending'`。cron は拾わない) で数えない | 各ファイル |
| F24 | cross/20 の契約 (#1912 が有料の条文を足す場所): 利用規約第10条 (料金。`id: 'terms-10'`) の `ol` は 1 項 (「本サービスは、無料で利用できます。」) だけで、#1912 が 2 項以降に足す置き場所 (cross/20 §6 の「第10条 (料金) の 1 項だけの `ol` は、#1912 が有料プランの条文を 2 項以降に足すための置き場所」の段落 (origin/main `465727de` の 955 行目。`2ba5b3b3` では 954 行目。#1917 が cross/20 を v1.16 にして 1 行ずれた))。§17 の「Issue #1912」の行は、第10条の 2 項以降・第16条 2 項 (凍結中の解約)・第17条 (退会のときの契約の扱い)・第21条 (責任の上限を置くか。Q-6)・第24条 2 項 (同意の前の解約の手段。Q-21)・ポリシー第3条 (有料プランの区分。T-34 の `PRIVACY_DATA_EXCLUDED` の `'paid_plan'` の 2 表 (`billing_customers`・`coupon_redemptions`) を `PRIVACY_DATA_TABLES` へ)・第4条 (目的)・第7条 (`PRIVACY_PROCESSORS`)・第10条 (外部送信)・第12条 (保存期間) と、T-33 (有料の語が本文に無いこと。`LEGAL_TEXT_PAID_TERMS` の 11 語と `PRIVACY_PROCESSORS` に `Stripe`・`RevenueCat`・`Apple` が無いこと) の改め・主張の表 (§10。`LEGAL_CLAIMS`・`LEGAL_CLAIM_COUNT = 383` (実装 (`2ba5b3b3`) は 382。F14)。1 文 = 1 行・`chars` = 文字数) の作り直し・§9.3 の規律での版の繰り上げ・`billing/01` §0 の「アプリ内課金なし」の直しを #1912 に渡す。本文の規則: 画面の名前の引用と道順を書かない (R-28・T-40。`SCREEN_NAMES_WITHOUT_CONSTANT` に「プランとお支払い」)、未完成と予定の語を書かない (T-6。`LEGAL_TEXT_PENDING_WORDS` の 14 語: 準備中・販売開始前・近日・公開予定・確定次第・決まり次第・決まりましたら・順次整備・予定・まだ・今後・「現在、」・機能はありません・未対応)、`株式会社`・`Inc` を書かない (T-13)、`links` の `href` は 7 つの公開のページか請求の画面だけ (T-14) | `docs/design/cross/20-terms-privacy-text.md` §6・§7・§9.3・§10・§13・§17 |
| F25 | 送信先の棚卸し `tests/ai-consent-provider-inventory.test.ts` は、`src`・`supabase/functions`・`shared`・`lib`・`packages`・`apps/mobile/app`・`apps/mobile/src` のコード (テストを除く) に書かれた `https://` のホストを集め、すべてが AI 事業者 (`AI_HOSTS`) か、理由つきの `NON_AI_HOSTS` (`api.stripe.com` などを持つ。`:34-63`) にあることを見る | 同ファイル |
| F26 | 料理の役割と料理画像 (Q-16 の土台): 料理 (`planned_meals.dishes[]`) の役割は `role`。AI の献立の出力は `supabase/functions/_shared/meal-generator.ts:20` の `z.enum(["main", "side", "soup", "rice", "other"])`、型は `DishRole` (`packages/shared/src/dish-roles.ts:8`)。利用者が日本語で保存した料理は `'主菜'`・`'主食'`・`'副菜'` などで、`getDishConfig` は `'main'` と `'主菜'` を同じ「主菜」として読む (`dish-roles.ts:21-22`。`'主食'` も同じ枝 (`:23`) だが、ご飯の役割)。本番の読み取り (2026-10-19。`planned_meals.dishes` の `role`): AI の献立 (`mode = 'ai_creative'`) の料理は `side` 507・`main` 477・`rice` 379・`soup` 372・`other` 67・なし 15、AI の献立 508 件のうち主菜がちょうど 1 品が 477・主菜が無い献立 (朝食のご飯と汁物だけ・役割なし) が 31。手で作った献立 (`mode = 'cook'`。役割 `main` と `主菜` を主菜として数える) は主菜 1 品が 96 (うち 10 品は日本語の `主菜`)・主菜なし 121 (`rice` だけの朝食・`主食` と `副菜` だけなど)・主菜 2 品が 2・料理なし 13。料理画像のジョブの種を作るのは `reconcileDishImages` (`supabase/functions/_shared/meal-image.ts:823-1009`) の 1 か所で、料理の保存・更新の 4 本の route と AI 相談の料理の更新は `lib/meal-image-jobs.ts:89-148` の `buildDishImagePayload` (`:96` で呼ぶ) から、献立の作成は `save-meal.ts:611` から呼ぶ。どの入口も、種の数 (`jobs.length`) が 0 なら `consumeAiUsage(user, 'meal_image_auto')` を呼ばずジョブも積まない (`src/app/api/meals/route.ts:155` の `if (imageJobs.length > 0)` ほか)。積み直しの道具 `scripts/lib/meal-image-backfill.ts` の `planDishImageJobs` (`:123-182`) は、待ちの料理から種を作る (`reconcileDishImages` を通さない)。料理の画面: Web の献立の画面は料理を押したとき `imageUrl: dish.image_url ?? meal.imageUrl ?? null` (`src/app/(main)/menus/weekly/page.tsx:5464`) で、自分の画像の無い料理に献立のカバーを代わりに出す。`RecipeModal` (`RecipeModal.tsx:193`) は `imageUrl` も `image_status` も無い料理には画像の枠を出さない。モバイルは料理ごとの画像を出さない (献立のカバーだけ。`apps/mobile/src/hooks/useHomeData.ts:133`)。利用者が押して作る画像は、献立の手動の編集の「AIで画像生成」(`ManualEditModal.tsx:333`) → `ImageGenerateModal` (「AIで料理画像を生成」) → `POST /api/ai/image/generate` (`page.tsx:4496`) → `PATCH /api/meal-plans/meals/[id]` の `imageUrl` で、料理が 1 品の献立ではその料理の画像 (`manual_override`)、2 品以上の献立では献立のカバーになる (`lib/meal-image-jobs.ts:106-138` の `imageUrlOverride`)。料理を選んで画像を作る入口は無い。料理画像の流れの文書は `docs/meal-image-spec.md` (FR-2「各 dish について … 1 dish 1 job で enqueue」) と `docs/operations/meal-image-pipeline.md` (§2 の B「料理ごとにジョブを積む」・§4 の積み直しの道具) | 各ファイル・本番 SELECT |

### 2.3 一次情報 (ストア・RevenueCat・Stripe。2026-10-19 取得)

| # | 事実 | 出どころ |
|---|---|---|
| P1 | RevenueCat の Expo の導入: `npx expo install expo-dev-client` と `npx expo install react-native-purchases react-native-purchases-ui`。「To use and test RevenueCat with Expo, you'll need to create an Expo development build」。導入後は「must run the full build process」(hot reload だけでは動かない)。Expo Go は「Preview API Mode」(ネイティブの呼び出しをモックに置き換える。「real purchases will not function in this mode」)。`app.json` の plugins の追記は不要 (必要なのは Xcode 27 × Expo SDK 56 以前の `post_install` だけ)。Expo SDK の最低の版は書かれていない。React Native は 0.73 以上 | https://www.revenuecat.com/docs/getting-started/installation/expo ・ https://www.revenuecat.com/docs/getting-started/installation/reactnative |
| P2 | `react-native-purchases` の最新は 10.14.0 (2026-10-15)。`Purchases` の静的メソッド (型定義 `dist/purchases.d.ts`): `configure(configuration: PurchasesConfiguration): void` (`apiKey`・`appUserID` (任意)) / `setLogLevel(level: LOG_LEVEL): Promise<void>` / `logIn(appUserID: string): Promise<LogInResult>` / `logOut(): Promise<CustomerInfo>` / `isAnonymous(): Promise<boolean>` / `getAppUserID(): Promise<string>` / `getCustomerInfo(): Promise<CustomerInfo>` / `getOfferings(): Promise<PurchasesOfferings>` / `purchasePackage(aPackage: PurchasesPackage, …): Promise<MakePurchaseResult>` / `restorePurchases(): Promise<CustomerInfo>` / `addCustomerInfoUpdateListener(listener): void` / `removeCustomerInfoUpdateListener(listener): boolean` / `isConfigured(): Promise<boolean>` / `syncPurchases(): Promise<void>`。iOS と Android で別の公開 SDK キー (`Platform.OS` で分ける) | https://github.com/RevenueCat/react-native-purchases/releases ・ https://unpkg.com/react-native-purchases@10.14.0/dist/purchases.d.ts ・ https://www.revenuecat.com/docs/getting-started/configuring-sdk |
| P3 | App User ID: 「Every app user ID must be unique per user」・「A non-guessable pseudo-random ID, like a UUID (RFC 4122 version 4), is recommended」・100 文字以内・`/` を含む値と `'anonymous'` / `'null'` 等は使えない。`logIn()` は「If the logged in identity does not already exist in RevenueCat, it will be created automatically」。匿名 ID から識別 ID への `logIn` は、識別 ID が未登録か匿名の別名を持たないときに merge される。`logOut()` は新しい匿名 ID を作る。復元: `restorePurchases` は利用者の操作 (ボタン) からだけ呼ぶ (「may cause OS level sign-in prompts」)。Restore behavior (プロジェクトの設定) の既定は「Transfer to new App User ID」(識別 ID 間で購入を移す。移した先にだけ権利が残る)。「Keep with original App User ID」は別の ID からの復元をエラーにする。TRANSFER の Webhook は移動先に送られ、`transferred_from` / `transferred_to` (配列) を持つ | https://www.revenuecat.com/docs/customers/identifying-customers ・ https://www.revenuecat.com/docs/getting-started/restoring-purchases ・ https://www.revenuecat.com/docs/projects/restore-behavior ・ https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields |
| P4 | Webhook: 本文は `{"api_version": "1.0", "event": {...}}`。署名 (HMAC。任意で有効にする): ヘッダー `X-RevenueCat-Webhook-Signature` = `t=<unix_timestamp>,v1=<hmac_sha256_hex>`、署名の対象は `<timestamp>.<raw_json_body>` (生のバイト列)、鍵は integration の signing secret (1 回しか表示されない)。再送でも `t` と `v1` は計算し直される。推奨: 定数時間の比較・`abs(now - t)` の許容 (例 5 分)。応答は 200 以外を失敗と数え、60 秒で切る。失敗は約 2.5 / 5 / 10 / 20 / 40 分で最大 5 回まで再送し (約 80 分)、それで止まる (Dashboard の Retry で手動の再送)。再送は `id` と `event_timestamp_ms` を再利用する。配送は at-least-once (重複あり) で、`id` で冪等にする。順序の保証は書かれていない。「call `GET /subscribers` after any webhook to get a consistent customer record」を勧める。未知の項目と新しいイベントの種類を受け入れる。イベントの種類: `TEST` / `INITIAL_PURCHASE` / `RENEWAL` / `CANCELLATION` / `UNCANCELLATION` / `NON_RENEWING_PURCHASE` / `SUBSCRIPTION_PAUSED` / `EXPIRATION` / `BILLING_ISSUE` / `PRODUCT_CHANGE` / `SUBSCRIPTION_EXTENDED` / `REFUND_REVERSED` / `INVOICE_ISSUANCE` / `TRANSFER` / `TEMPORARY_ENTITLEMENT_GRANT` / `VIRTUAL_CURRENCY_TRANSACTION` / `EXPERIMENT_ENROLLMENT` / `PURCHASE_REDEEMED` / `SUBSCRIBER_ALIAS` (廃止) / `PRICE_INCREASE_CONSENT_REQUIRED` / `PRICE_INCREASE_CONSENT_APPROVED`。本体の項目: `id`・`event_timestamp_ms`・`app_user_id` (最後に見た ID)・`original_app_user_id`・`aliases`・`product_id`・`entitlement_ids` (null あり)・`period_type` (`TRIAL` / `INTRO` / `NORMAL` / `PROMOTIONAL` / `PREPAID`)・`purchased_at_ms`・`expiration_at_ms`・`store` (`APP_STORE` / `PLAY_STORE` / `AMAZON` / `STRIPE` / `RC_BILLING` …)・`environment` (`SANDBOX` / `PRODUCTION`)・`transaction_id`・`original_transaction_id`・`cancel_reason`。`EXPIRATION` は「The associated user's access should be removed」、`BILLING_ISSUE` は「This doesn't mean the subscription has expired」 | https://www.revenuecat.com/docs/integrations/webhooks ・ https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields ・ https://www.revenuecat.com/docs/integrations/webhooks/sample-events |
| P5 | REST API v1: `GET https://api.revenuecat.com/v1/subscribers/{app_user_id}` (「Get or Create Customer」。無ければ作る。`Authorization: Bearer <API key>`。情報の取得のためなら `X-Platform` を付けない)。応答 `{ request_date, request_date_ms, subscriber: { original_app_user_id, first_seen, last_seen, management_url (null あり。secret key のときだけ), subscriptions: { <product_id>: { expires_date, purchase_date, original_purchase_date, period_type, store ('app_store' / 'play_store' / 'promotional' …), is_sandbox, unsubscribe_detected_at, billing_issues_detected_at, grace_period_expires_date, auto_resume_date, refunded_at, store_transaction_id, ownership_type } }, entitlements: { <id>: { expires_date, grace_period_expires_date, product_identifier, purchase_date } }, non_subscriptions, subscriber_attributes (secret key のときだけ) } }`。`management_url` と `subscriber_attributes` は secret API key のときだけ入る | https://www.revenuecat.com/docs/api-v1/customers ・ https://www.revenuecat.com/docs/api-v1/customer-info-model |
| P6 | RevenueCat の商品と権利: 商品の識別子はストアの値を「exactly as it appears in the store」で登録し、Google は subscription ID と base plan ID を入れる (識別子は `<subscription_id>:<base-plan-id>` の形)。1 つの entitlement に複数の商品 (App Store と Google Play) を付けられ、同じ entitlement を複数の商品が開ける。`getOfferings()` の `offerings.current.availablePackages` の各 `package` に `identifier`・`packageType` (`MONTHLY` / `ANNUAL` …)・`product` (React Native では `product`)。購入は `purchasePackage(package)`、取り消しは `PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR` (または `e.userCancelled`)。`CustomerInfo`: `originalAppUserId`・`managementURL` (有効な購読が無ければ null)・`activeSubscriptions`・`entitlements.active[<id>]` (`isActive`・`willRenew`・`periodType`・`expirationDate`・`store`・`productIdentifier`・`isSandbox`・`unsubscribeDetectedAt`・`billingIssueDetectedAt`)。SDK はキャッシュを 5 分で更新し、`CustomerInfo` の更新はサーバから push されない | https://www.revenuecat.com/docs/offerings/products-overview ・ https://www.revenuecat.com/docs/getting-started/entitlements ・ https://www.revenuecat.com/docs/getting-started/displaying-products ・ https://www.revenuecat.com/docs/getting-started/making-purchases ・ https://www.revenuecat.com/docs/customers/customer-info |
| P7 | RevenueCat と App Store: In-App Purchase Key (`.p8`。App Store Connect の Users and Access → Integrations → In-App Purchase で作る。1 回しかダウンロードできない) と Issuer ID を RevenueCat に登録する (「When using Purchases v5.x+ (i.e., StoreKit 2), transactions will fail to be recorded without this key being set」。React Native 8.0.0+ で必須)。App Store Server Notifications は RevenueCat の Dashboard の URL を App Store Connect の Production と Sandbox の両方に入れる (ほとんどの購読の更新には不要・推奨)。購読の作成の前提: Paid Applications Agreement の署名・Tax と Banking の登録 (「You will not be able to test in-app purchases until the latest version of this agreement is signed」)。Subscription Group を作り、商品 ID・期間・価格・ローカライズ (表示名・説明)・審査用のスクリーンショットを登録する (審査に出すには localization とスクリーンショットが要る)。商品 ID は「can’t be used again across any of your apps, even if the product is deleted」 | https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration ・ https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications ・ https://www.revenuecat.com/docs/getting-started/entitlements/ios-products |
| P8 | RevenueCat と Google Play: Google Cloud のサービスアカウントの JSON を登録し、Play Console でそのアカウントに「View app information and download bulk reports」「View financial data, orders, and cancellation survey responses」「Manage orders and subscriptions」「Manage store presence」を付け、Google Play Android Developer API と Google Play Developer Reporting API を有効にする。「It can take up to 36 hours for new Play service credentials to work」。Real-time developer notifications は Pub/Sub の topic を RevenueCat の Dashboard の「Connect to Google」で作り、Play Console の Monetization Setup に入れる (任意・強く推奨)。Google の購読の作成: 「You'll need to have an APK uploaded before you can create in-app products」。Google の案内: 「you must publish a version of your app that includes the Google Play Billing Library … publish to any track, including the internal test track」・Google Payments の merchant profile・「By Aug 31, 2026, all new apps and updates to existing apps must use Billing Library version 8 or later」(2026-11-01 まで延長を申請できる)。購読は base plan を 1 つ以上作って有効にする (名前の形は `<duration>-<renewaltype>`。例 `annual-autorenewing`)。無料体験は offer で作る (3 日〜3 年)。価格は国ごとに設定できる (一括の換算では「charmed」の調整が入る) | https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials ・ https://www.revenuecat.com/docs/platform-resources/server-notifications/google-server-notifications ・ https://www.revenuecat.com/docs/getting-started/entitlements/android-products ・ https://developer.android.com/google/play/billing/getting-ready ・ https://support.google.com/googleplay/android-developer/answer/140504 |
| P9 | Apple の審査の規約: 3.1.1 「If you want to unlock features or functionality within your app, (by way of example: subscriptions, …), you must use in-app purchase」・「you should make sure you have a restore mechanism for any restorable in-app purchases」。3.1.2(a) 「the subscription period must last at least seven days and be available across all of the user's devices」・無料体験は App Store Connect の情報で提供できる。3.1.2(b) 「Users should have a seamless upgrade/downgrade experience and should not be able to inadvertently subscribe to multiple variations of the same thing」。3.1.2(c) 「Before asking a customer to subscribe, you should clearly describe what the user will get for the price」。3.1.3 「Apps in this section cannot, within the app, encourage users to use a purchasing method other than in-app purchase, except for apps on the United States storefront」。3.1.3(b) 「Apps that operate across multiple platforms may allow users to access content, subscriptions, or features they have acquired in your app on other platforms or your web site … provided those items are also available as in-app purchases within the app」。購入の画面に要る表示 (Apple の「Auto-renewable subscriptions」のページ): 「Subscription name and duration, and the content or services provided during the subscription period」「Full renewal price, shown clearly and prominently」「A way for current subscribers to sign in or restore purchases」、アプリと App Store のメタデータに「links to your Terms of Use and Privacy Policy」、請求額を最も目立つ要素に、無料体験は「clearly indicate how long the free trial lasts and the price billed once the free trial is over」。価格帯: 「Auto-renewable subscriptions can be priced by App Store country or region … You can choose from 800 price points in each currency」(日本円の一覧は公開ヘルプに無い。Q-1) | https://developer.apple.com/app-store/review/guidelines/ ・ https://developer.apple.com/app-store/subscriptions/ ・ https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-pricing-for-auto-renewable-subscriptions |
| P10 | Google Play の決済の規約: 「Google Play's billing system is required for developers offering in-app purchases of digital goods and services」(購読を含む)。「We do not require parity across platforms」。購読の規約: 「You must be transparent about your offer」「clearly and explicitly disclosing your offer terms, the cost of your subscription, the frequency of your billing cycle」「let your users know how and when a free trial will convert to a paid subscription」「You must also include in your app access to an easy-to-use, online method to cancel the subscription」(Google Play の Subscription Center へのリンクでよい) | https://support.google.com/googleplay/android-developer/answer/10281818 ・ https://support.google.com/googleplay/android-developer/answer/9900533 |
| P11 | Stripe の有効化: 「Stripe requires all merchants who sell or promote products or services online to provide the URL of their business website, social media profile, or mobile application when completing account activation」。日本では、Stripe で決済する事業者は特定商取引法の表記に相当する項目をサイトに載せる必要がある (Stripe の案内。法令の遵守は保証しない) | https://support.stripe.com/questions/do-i-have-to-have-a-business-website-to-sign-up-for-stripe ・ https://support.stripe.com/questions/en-specified-commercial-transactions-act |
| P12 | テストの購入 (sandbox) と審査: Apple の verifyReceipt の案内は、本番の URL で確かめて 21007 (sandbox の receipt) なら sandbox の URL で確かめ直す手順を、「This approach ensures you don't have to switch between URLs while your application is tested, reviewed by App Review, or live in the App Store」と説明する (= 審査の購入は本番のアプリから sandbox の取引として届く)。RevenueCat はプロジェクトの設定「Allow testing entitlements and in-app currency for」(既定 `Anybody`・ほかに `Allowed App User IDs only` / `Nobody`) で sandbox の購入が entitlement を与えるかを決め、「All Test Store and platform sandbox purchases continue to be processed and appear in RevenueCat, regardless of this setting」。本冊は RevenueCat の entitlement を読まず `subscriptions` を写すので、この設定は本冊の判定に効かない。Webhook の `environment`・`GET /v1/subscribers` の `is_sandbox` で sandbox を見分けられる (P4・P5)。sandbox の購読は期間が短く縮められる (Apple の sandbox のテストの案内) | https://developer.apple.com/documentation/appstorereceipts/verifyreceipt (Apple Developer Forums https://developer.apple.com/forums/thread/717602 で引用) ・ https://www.revenuecat.com/docs/projects/sandbox-access ・ https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox |
| P13 | ストアの猶予期間 (grace period): 「Users will retain access to their subscriptions」・猶予の間の購読は active とみなし、「will not be considered expired until the end of their grace period」。`grace_period_expires_date` は猶予の間は値を持ち、「will be `null` if the subscription is not in a grace period」(Stripe は常に null)。猶予の間の `expires_date` の値は案内に書かれていない (過ぎていることがある前提で扱う)。猶予の終わりに `EXPIRATION` の Webhook が届くかは書かれていない (本冊は遅延の再同期で受ける。§8.4) | https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work |
| P14 | ストアの返金: App Store の購入の返金は利用者が reportaproblem.apple.com から Apple に申し込む (「Some purchases from the App Store … might be eligible for a refund」。Apple の案内に開発者が返金する手順は無い)。Google Play は開発者が Play Console の注文の管理から返金できる (「If you refund the most recent order in a subscription, the order is refunded」かつ購読はすぐ終わり、更新が止まる。「Canceling a subscription doesn't issue a refund」) | https://support.apple.com/en-us/118223 ・ https://support.google.com/googleplay/android-developer/answer/2741495 |
| P15 | 無料体験の表示 (RevenueCat の SDK と Google Play): `PurchasesStoreProduct.introPrice: PurchasesIntroPrice \| null` (`price`・`priceString`・`cycles`・`period`・`periodUnit` (DAY / WEEK / MONTH / YEAR)・`periodNumberOfUnits`)。`Purchases.checkTrialOrIntroductoryPriceEligibility(productIdentifiers: string[]): Promise<{ [productId: string]: IntroEligibility }>` (`IntroEligibility.status: INTRO_ELIGIBILITY_STATUS`。`UNKNOWN = 0`・`INELIGIBLE = 1`・`ELIGIBLE = 2`・`NO_INTRO_OFFER_EXISTS = 3`) は「iOS only」で、「The best course of action on unknown status is to display the non-intro pricing, to not create a misleading situation」「Android always returns INTRO_ELIGIBILITY_STATUS_UNKNOWN」。`INTRO_ELIGIBILITY_STATUS` は `react-native-purchases` から名前で export される (`dist/index.d.ts` の `export * from './offerings'` が `@revenuecat/purchases-typescript-internal` の offerings を再 export。10.14.0 は 19.12.0 に依存)。Google Play の新規の利用者向けの offer は、利用者が対象でなければ「it will not show up in the `subscriptionOptions` of the `StoreProduct` in the SDK at all」 | https://unpkg.com/react-native-purchases@10.14.0/dist/purchases.d.ts ・ https://unpkg.com/react-native-purchases@10.14.0/dist/index.d.ts ・ https://unpkg.com/@revenuecat/purchases-typescript-internal@19.12.0/dist/offerings.d.ts ・ https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/google-play-offers |
| P16 | ストアのメタデータとプライバシーの申告: Apple は自動更新の購読について「Please note that your app and App Store metadata must include links to your Terms of Use and Privacy Policy」と書く (アプリの購入の画面 (§10.6 の 6) とは別に、App Store の製品ページの側にも要る)。App Store Connect の App のプライバシーは「Privacy Policy (Required): The URL to your publicly accessible privacy policy」。使用許諾は「If you don't provide a custom EULA, the standard EULA is applied to your app」(custom EULA は App 情報の License Agreement の欄に平文で入れる)。App のプライバシーの申告には Purchases の「Purchase History」(「An account's or individual's purchases or purchase tendencies」) があり、アプリに入れた第三者の SDK (「third-party partners」) が集めるものも申告する。RevenueCat の案内: App Store では「RevenueCat collects purchase history from users」なので Purchase History を目的 Analytics と App Functionality で申告し、app user ID がメールアドレスなどに結び付くなら linked to identity は Yes、独自の app user ID を使うなら Identifiers の User ID も申告する。Google Play のデータ セーフティでは Financial info の「Purchase history」を collected・目的 App functionality と Analytics・送信の暗号化 Yes・任意 No で申告する。Google の定義では、当社の指示で処理する service provider への移転は「共有」に当たらない。どちらのストアもプライバシーポリシーの URL が必須 | https://developer.apple.com/app-store/subscriptions/ ・ https://developer.apple.com/app-store/app-privacy-details/ ・ https://developer.apple.com/help/app-store-connect/manage-app-information/provide-a-custom-license-agreement ・ https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy ・ https://www.revenuecat.com/docs/platform-resources/google-platform-resources/google-plays-data-safety ・ https://support.google.com/googleplay/android-developer/answer/10787469 |
| P17 | アプリの中の退会と自動更新の購読: Apple は「If a person has an auto-renewable subscription, notify them that billing will continue through Apple and ask them to cancel their subscription before continuing」と書き、購読の管理の行き先に `showManageSubscriptions` か「https://apps.apple.com/account/subscriptions/」を挙げる。あわせて「If your app supports in-app purchases, help people understand how billing and cancellations will be handled」 | https://developer.apple.com/support/offering-account-deletion-in-your-app/ |
| P18 | 購読の変更 (同じ Subscription Group の中): App Store は Apple の定義で、上位への変更 (upgrade) は「They are immediately upgraded and receive a refund of the prorated amount of their original subscription」、下位への変更 (downgrade) は「The subscription continues until the next renewal date, then is renewed at the lower level and price」、crossgrade は「If the subscriptions are the same duration, the new subscription begins immediately」「If the durations are different, the new subscription goes into effect at the next renewal date」。どれが上位かはグループの中の順位 (level) で決まる (「If you'd like users to immediately access more content or features, rank the subscription higher to make it an upgrade」)。体験 (introductory offer) の間の上位への変更は「Apple does not cancel the introductory offer but instead keeps the introductory offer active in addition to the upgraded product」で、同じグループの 2 つの商品が同時に live に見える。`PRODUCT_CHANGE` の Webhook は「should be considered informative」で、変更が効いたことを意味しない (Apple では `RENEWAL`、Google Play では `INITIAL_PURCHASE` で効く)。Google Play の購読の置き換え (replacement) は、アプリが Play Billing Library の購入の流れで置き換えのモード (`WITHOUT_PRORATION` など) を指定して始める | https://www.revenuecat.com/docs/subscription-guidance/managing-subscriptions ・ https://codelabs.developers.google.com/codelabs/play-billing-subs-replacement |
| P19 | モバイルに足す 2 つの依存の中身 (段 D の `package-lock.json` の差分の見込み。§8.10): `expo` 58.0.14 の `bundledNativeModules.json` は `"expo-dev-client": "~58.0.14"` を持ち、`react-native-purchases` は持たない (第三者のパッケージ。`npx expo install` は表に無いパッケージを npm の最新で入れる)。`react-native-purchases@10.14.0` の `dependencies` は `@revenuecat/purchases-js-hybrid-mappings` 19.12.0 と `@revenuecat/purchases-typescript-internal` 19.12.0 (前者は `@revenuecat/purchases-js` 1.70.0 に依存し、その先の依存は無い)、`peerDependencies` は `react >= 16.6.3`・`react-native >= 0.73.0`・`react-native-web *` (optional)。パッケージの `files` に `app.plugin.js` は無い (config plugin を持たない)。`expo-dev-client@58.0.14` の `dependencies` は `expo-dev-menu ~58.0.11`・`expo-manifests ~58.0.1`・`expo-dev-launcher ~58.0.14`・`expo-updates-interface ~58.0.1`・`expo-dev-menu-interface ~58.0.1` (`expo-dev-launcher@58.0.14` はさらに `@expo/schema-utils ^58.0.2`、`expo-manifests@58.0.1` は `expo-json-utils ~58.0.1`)、peer は `expo *`。`expo-dev-client` は `app.plugin.js` を持つが、Expo の prebuild が自動で当てる plugin の一覧 (`@expo/prebuild-config` の `legacyExpoPlugins`) に入っていて、`npx expo install` の config plugin の自動の追記 (`@expo/cli` の `autoAddConfigPluginsAsync`) はこの一覧のパッケージを飛ばす (`app.json` の `plugins` は変わらない)。origin/main の `package-lock.json` には `expo-manifests` 58.0.1・`expo-updates-interface` 58.0.1・`expo-json-utils` 58.0.1・`@expo/schema-utils` 58.0.2 がルート (`node_modules/`) に既にあり (`expo-updates` の依存。`expo-updates` は `expo-dev-client` を optional の peer に持つ。`package-lock.json:11035-11071`)、`expo-dev-client`・`expo-dev-launcher`・`expo-dev-menu`・`expo-dev-menu-interface`・`react-native-purchases`・`@revenuecat/*` は無い。`apps/mobile/node_modules/` の下のキーは `@types/react` と `react` の 2 つ (`package-lock.json:114`・`:124`)。ルートの `react` は 19.2.8・`react-native` は 0.88.0 で、上の peer の範囲を満たす | npm のレジストリ (`npm view <名前>@<版> dependencies peerDependencies peerDependenciesMeta`。2026-10-19) ・ https://unpkg.com/react-native-purchases@10.14.0/package.json (`files`。`/app.plugin.js` は 404) ・ https://unpkg.com/expo-dev-client@58.0.14/app.plugin.js ・ https://unpkg.com/expo@58.0.14/bundledNativeModules.json ・ https://github.com/expo/expo/blob/main/packages/@expo/cli/src/install/utils/autoAddConfigPlugins.ts ・ https://github.com/expo/expo/blob/main/packages/@expo/prebuild-config/src/plugins/withDefaultPlugins.ts |

### 2.4 AI の原価の推計と、競合の線引き (Q-2・Q-3・Q-16 の根拠。推計は 1 ドル = 150 円・入出力の token 数は本冊の見積もり)

| 機能 (AI_FEATURES) | モデル (コードの既定) | 単価 (1M token。一次情報は Google。OpenAI は公式ページを取得できず二次情報) | 1 回の入出力の見積もり | 1 回の原価 (推計) |
|---|---|---|---|---|
| `menu_generation` の 1 週間 (最大 21 食。`weekly/request`・`v4` / `v5` の generate で 1 週間を選んだとき・AI 相談の複数日) | OpenAI `gpt-5.2` (`supabase/functions/_shared/v4-fast-llm.ts:36`。`XAI_API_KEY` があると xAI `grok-4-1-fast-non-reasoning` に切り替わる (`:43`)。本番の設定は読めない) | gpt-5.2: 入力 $1.75 / 出力 $14 (二次情報: pricepertoken.com・benchlm.ai) | 入力 20k・出力 10k (6 段階の合計) | ≈ $0.175 ≈ **26 円** (xAI なら 1 桁下。未確認) + 料理画像 (下の行) |
| `menu_generation` の 1 日 (3 食。`day/regenerate`・AI 相談の 1 日) | 同上 | 同上 | 1 週間の 3/21 (食の数に比例すると仮定) | ≈ **4 円** + 料理画像 |
| `menu_generation` の 1 食 (`meal/generate`・`meal/regenerate`・`nutrition-analysis` の献立の提案・AI 相談の 1 食) | 同上 | 同上 | 1 週間の 1/21 (同上) | ≈ **1〜2 円** + 料理画像 |
| `menu_generation_ultimate` | 同上を倍の 6 段階 (`ai-usage-core.ts:57`) | 同上 | 2 倍 | 1 週間 ≈ **52 円** + 料理画像 |
| 献立の作成が作る料理画像 (Edge の `save-meal`。F22。`menu_generation` の 1 回に含めて数え、別に数えない) | Google `gemini-3.1-flash-image-preview` (`DEFAULT_MEAL_IMAGE_MODEL`。`supabase/functions/_shared/meal-image.ts:73`) | 画像 1 枚 (1K) $0.067 (一次情報: ai.google.dev の料金表 2026-10-19) | 1 食に主菜の 1 枚 (Q-16。1 週間 21 枚・1 日 3 枚・1 食 1 枚)。v1.7 のまま作った料理ごとに作ると 1 食 3〜4 品と仮定して 1 週間 63〜84 枚 | 1 週間 ≈ **210 円**・1 日 ≈ **30 円**・1 食 ≈ **10 円** (料理画像を作るプランだけ。無料は 0。Q-3・Q-16。料理ごとに作ると 1 週間 ≈ 630〜840 円) |
| `photo_analysis` | Google `gemini-3.1-flash-lite-preview` (`src/lib/ai/image-recognition.ts:1`) | 入力 $0.25 / 出力 $1.50 (一次情報: ai.google.dev の料金表 2026-10-19) | 画像 1.5k + 文 1k・出力 0.5k | ≈ $0.0014 ≈ **0.2 円** |
| `image_generation` / `meal_image_auto` | Google `gemini-3.1-flash-image-preview` (`src/app/api/ai/image/generate/route.ts:16`) | 画像 1 枚 (1K) $0.067 (一次情報: 同上) | 1 枚 (`meal_image_auto` は保存 1 回で主菜の 1 枚。Q-16) | ≈ **10 円 / 枚** |
| `nutrition_advice` (栄養士のコメント) / `nutrition_advice_auto` (同じ API の自動の取得。上限に数えない) | OpenAI `gpt-5.2` (`src/app/api/ai/nutrition/feedback/route.ts:112`) | 同上 | 入力 3k・出力 0.6k | ≈ **2 円** |
| `consultation` | xAI (二次情報の単価は gpt-5.2 より低い) | 未確認 | 入力 4k・出力 0.8k | ≈ **1〜3 円** (未確認) |

- 上限に数えない機能 (`c_unmetered`) は 1 日の上限 (`ai_daily_limits`) に入らず、機能ごとの安全弁 (`ai_unmetered_daily_caps`。本番: `nutrition_advice_auto` 30・`meal_image_auto` 20) だけで止まる (F7)。`nutrition_advice_auto` (画面を開くと自動で取る栄養士のコメント。`gpt-5.2`・1 回 ≈ 2 円) と `meal_image_auto` (料理を保存・更新したときの自動の料理画像。保存 1 回を 1 回と数え、保存した献立の主菜の 1 枚だけ画像を作る (Q-16)。1 枚 ≈ 10 円。`src/app/api/meals/route.ts:170-174`) も原価に入れる。献立の作成が作る料理画像は安全弁にも数えない (F22)。
- 献立の作成 1 回の原価は、料理画像を作るプランでは料理画像が大半を占める (1 週間: 文 26 円 + 主菜の画像 21 枚 ≈ 210 円。Q-16)。無料は料理画像を作らない (Q-3。料理の保存は route の門、献立の作成は `process-meal-image-jobs` の門で止める。§8.8) ので、無料の献立の作成の原価は文だけになる。
- 無料の最悪の 1 日 (Q-2・Q-3 の確定の値): 1 日の上限 3 回をすべて献立の作成 (1 週間 × 3 で 78 円) に使う ≈ 78 円 + `nutrition_advice_auto` の安全弁 30 回 (≈ 60 円) ≈ 138 円、月 ≈ 4,140 円 (v1.7 の推奨の 5 回では 1 日 ≈ 144 円)。料理画像は作らない。自動の料理画像を無料に残す案 (Q-3 の選ばれなかった案 (2)) では、保存の安全弁 20 回 × 主菜の 1 枚 × 10 円 (200 円) と、献立の作成 3 回の料理画像 (1 週間 × 3 で最大 630 円) が 1 日に加わり、最悪は 6 倍を超える。ふつうの使い方 (毎食の写真・献立の作成を週 1〜2 回) なら無料は 1 日 ≈ 5〜10 円。
- 個人 Pro (580 円) の最悪の 1 日 = 献立の作成 10 回 (1 週間なら文 260 円 + 主菜の料理画像 2,100 円) + 究極 2 回 (文 104 円 + 主菜の料理画像 420 円) + 残り 18 回 (料理画像の作成 18 枚 ≈ 180 円) + `nutrition_advice_auto` 60 円 + 保存の自動の料理画像 (安全弁 20 回 × 主菜の 1 枚 × 10 円 = 200 円) ≈ 3,300 円で、上限は濫用の歯止め。ふつうの使い方 (1 週間の献立の作成を週 1 回・毎食の写真と保存の画像) では、献立の作成の料理画像が月 ≈ 900 円 (主菜の 21 枚 × 10 円 × 4.3 週。料理ごとに作る v1.7 のままなら月 ≈ 2,600〜3,400 円) で、月額を超えうる (推計。販売開始の後に実測で確かめる。§18 の 3)。料理画像を除くと月 ≈ 300〜600 円。
- 競合: あすけん (公式 asken.jp/premium。2026-10-19 取得) はプレミアム月額 580 円・7 日間無料トライアルで、プレミアムの機能に「画像解析機能」「1 食ごとのアドバイス」を挙げる。§0.4 の「個人を競合並みに下げる」の 580 円はこれに並ぶ。本冊は写真の記録を無料に残し (紹介ページの主張 `photo-analyze` と FAQ の事実を保つ)、重い AI (献立の作成の回数・究極モード・料理画像の作成と自動の料理画像) と家族を有料にする線引きにする。

---

## 3. 相 1 外形固定

### 3.1 要件行列

| ID | 要件 | 出どころ | 本冊の答え |
|---|---|---|---|
| R1 | 価格は個人 Pro 580 / 5,800・家族 Basic 980 / 9,800 (4 人)・家族 Pro 1,480 / 14,800 (8 人)・無料体験 7 日 | #1912 (§0.4) | `subscription_plans` の 3 行を migration で UPDATE (§6.2)。価格の正本は DB、公開の文の正本は `PLAN_CATALOG` (§8.9) で、両者の一致を契約テスト (テスト 60) が見る |
| R2 | Stripe の鍵と Price が無い間も、料金ページと特商法に価格と有料の中身を公開する (Stripe の有効化の審査が見る)。購入できるかどうかは別に判定する | 追記 1 (§0.4)・P11 | `listPublicPlans()` (表示用。`stripe_price_id` で絞らない) と `isPurchasable` (購入用。変えない) に分ける (§8.6・§10.1)。CTA は買える間隔だけ (Q-5) |
| R3 | 「準備中」「販売開始前」「近日」「今後〜予定」「まだ〜」などの未完成や予定を示す文を画面と規約の本文に書かない | #1912 (§0.4)・#1911 | §10・§11 の文と §13 のエラーの文はその規則で選び、禁止語の一覧 (`UNFINISHED_WORDS`。§14.1) を見張りのテストが持つ。#1911 の見張り `tests/no-pending-wording-1911.test.ts` (F21) と cross/20 の T-6 (`LEGAL_TEXT_PENDING_WORDS`。F24) も本冊の新しい文に当たる。`EXT_STRIPE_NOT_CONFIGURED` の文は #1911 が「お支払いを受け付けていません」に直し済み (`src/lib/billing/core.ts:241`) で、本冊は変えない |
| R4 | AI の 1 日の回数の上限をプランごとに上げる・無料の範囲を絞る | #1912 (§0.4) | `ai_daily_limits` に 4 プランの行 (Q-2。§6.5)。判定の関数は変えない (プランごとの行は既に効く。F7) |
| R5 | 究極モードなど重い AI を有料に | #1912 (§0.4) | `ai_plan_feature_caps (plan_key, feature, daily_cap)` を新設し、`consume_ai_usage_at` が機能ごとの上限を判定する (0 = そのプランでは使えない。§6.5)。上限に数えない自動の料理画像 (`meal_image_auto`) も同じ表で無料を 0 にする (料理は保存し、画像だけ作らない。料理の保存の 4 本の route と AI 相談は `consume_ai_usage_at` の門、献立の作成 (Edge の `save-meal`) が積むジョブは `process-meal-image-jobs` が新設の `ai_plan_feature_daily_cap` で止める。§6.5・§8.8)。止めたときの応答は 403 `AI_FEATURE_NOT_IN_PLAN` (使えない) か 429 `AI_DAILY_LIMIT` (回数) (§8.8・§13)。画面はプランの機能の表 (`BillingSummary.features`) で錠を出す (§10.3・§10.6) |
| R6 | 家族で使う機能を有料に | #1912 (§0.4) | 家族グループの作成 (`create_family_group`) とメンバーの追加 (`family_members` の BEFORE INSERT のトリガー) を、代表者の live な家族プランの契約があるグループだけに限る (`FAMILY_PLAN_REQUIRED`。§6.6)。範囲は Q-4 |
| R7 | iOS / Android の購入はストア経由 (App Store / Google Play) で、RevenueCat で両ストアをまとめる | #1912 (§0.4)・P9・P10 | `react-native-purchases` の `purchasePackage` → RevenueCat の Webhook と同期の API → `billing_apply_store_subscription` (§6.4・§8・§9・§10.6)。テストの購入 (sandbox。App Store の審査を含む) も Webhook・同期の API・遅延の再同期のすべてで本物の購入と同じに写し、行に `iap_is_sandbox` の印を付ける (Q-13・P12・S24) |
| R8 | どこで買っても同じ `plan_key_cached` になる | #1912 | ストアの契約も `personal_subscriptions` の行 (1 利用者 1 live 行) に写し、`plan_key_cached` と家族グループの同期は写像の中で核と同じ式で行う (§6.4)。権利判定 (`get_effective_plan`) は変えない |
| R9 | RevenueCat の Webhook: 署名の検証・冪等・順序の入れ替わり | #1912・P4 | HMAC の署名 (§8.2)・`revenuecat_webhook_events` + claim (§6.3)・イベントは合図として扱い `GET /v1/subscribers/{app_user_id}` で取り直して `p_fetched_at` で単調に写す (§4.1) |
| R10 | app_user_id と Supabase の user id の結び付け | #1912・P3 | app_user_id = Supabase の `auth.users.id` (UUID v4。P3 の条件を満たす)。アプリはログイン中の利用者の id で `configure` / `logIn` し、サインアウトで `logOut` する (§10.6)。Webhook の `app_user_id` / `transferred_*` を UUID として検証し、UUID でない (匿名 ID) は無視する (§8.1) |
| R11 | 購入の復元 | #1912・P3・P9 | 「購入を復元」のボタン → `restorePurchases()` → 同期の API (§9.3・§10.6)。Restore behavior は既定 (Transfer to new App User ID) のまま (§17)。TRANSFER のイベントは移動元と移動先の両方を取り直す (§4.1) |
| R12 | Web で買った人がアプリで使える・アプリで買った人の解約はストアで・二重購読の防止と案内 | #1912・P9 (3.1.3(b)) | 権利は DB の行なのでどこで買っても使える。アプリの画面は `GET /api/billing/subscription` で live な契約があれば購入のボタンを出さず、契約の出どころ (`source`) に応じて「Web でご契約中」/ ストアの購読の管理へのリンクを出す (§10.6)。ストアの契約は `can_cancel` / `can_resume` を偽にし、`manage_in_store` を返す (§8.1)。2 本目の live な契約は写像が `BILL_LIVE_ROW_CONFLICT` で止め、監査に残す (§7.3・§13.3)。運営は当社が止められる側 (Stripe の契約・手動付与・Google Play の購入) を解約・返金して写し直す (P14・§13.3 の手順。S13・S25)。同じ App Store のグループの中の 2 つの live (上位への変更・体験中の変更。P18) は二重購読ではないので衝突にせず、新しい購入を権利にして古い行を終わらせる (§7.3・S36)。App Store 同士の二重購読 (別の Apple ID) はこれと見分けられないので同じ扱いになり、問い合わせを受けた運営は、一方の解約と Apple への返金の申し込みを案内する (§13.3) |
| R13 | 家族のプランの席の数え方 | #1912 | いまのまま: `family_groups.member_limit` = プランの `max_members` (4 / 8) を写像とトリガーが同期し、人数は `family_members` の active な行 (子供を含む) で数える (F9・billing/01 §6.4 (10))。本冊は席を変えない |
| R14 | 無料体験の 1 人 1 回 | #1912・operator/04 §5.2 | Q-10 のとおり (Web は `hasUsedTrial`、ストアはストア任せ + 行の `trial_started_at` で片向きに共有。S23) |
| R15 | モバイルの購入の画面はストアの審査の要件を満たす | #1912・P9・P10 | プラン名と期間・提供する内容・更新の価格 (ストアの `priceString`)・無料体験の長さと終了後の価格・自動更新の説明・解約の方法 (ストアの管理へのリンク)・「購入を復元」・利用規約とプライバシーポリシーへのリンクを 1 画面に (§10.6)。無料体験の文は、ストアが返す商品の導入価格 (`product.introPrice`) が 0 円の体験を示し、かつその利用者が体験の対象のとき (iOS は `checkTrialOrIntroductoryPriceEligibility` が対象と返したとき。Android は Google Play が対象の利用者にだけ offer を返す) だけ出す (DB の `trial_days` からは作らない。§8.10 `storeTrialOf`。S29) |
| R16 | アプリの中に、Web での購入への誘導を出さない | billing/01 R11 の改定・P9 (3.1.3) | アプリの中にアプリ内課金の購入の画面を持つ (R7)。Web の購入のページ (`/pricing`・`/account/billing`) へのリンクは引き続き出さない (見張り `no-web-purchase-links.test.ts` は保つ。§10.6・§16.1) |
| R17 | 販売の開始と同時に出す文: 規約・ポリシー (Stripe と RevenueCat への送信・外部送信の公表)・特商法 | #1912 (決めること 5)・追記 2・cross/20 §17 | §11 (cross/20 の文面モジュールの、cross/20 §17 の「Issue #1912」の行が決めた場所に足す差分。版は、#1917 (family/11) が使ったいまの版 v2026.2 の次の v2026.3。F14)。特商法の表記の会社情報は #1911 が入れた追記 2 の値で、本冊は販売の項目を足す (§10.2) |
| R18 | 作る → 発注者が申請する → 鍵と商品を入れて販売開始、の順。鍵や価格が無ければ買えるプランを出さない | 追記 1 | §15 (段) と §17 (申請の順と、それぞれの段で何が開くか)。Web は `stripe_price_id`、ストアは `plan_store_products` の行と offerings の一致で買える判定 (§8.4・§10.6) |
| R19 | 本番の書き込み・外部の設定の変更はしない (設計) | #1912 の守ること | 本冊は読み取りだけ。設定の手順は §17 |
| R20 | migration の番号はマージ時に確定・`.down.sql` を対で | 設計の規約 | §6.1 |
| R21 | as any 禁止・マジックナンバー禁止 | 設計の規約 | §8 の定数に根拠。RevenueCat の型は Zod で自前に定義 (SDK を入れない) |
| R22 | 監査ログ必須 | `docs/design/CLAUDE.md` | 状態の変化は写像が `admin_audit_logs` に書く (核と同じ名前)。Webhook の失敗は `system.revenuecat.event_failed` (§8.1) |
| R23 | 既存の番兵の追随と、2 PR 以上が触る共有面の台帳 | 設計の規約 | §16 |
| R24 | アプリで買った人が退会するとき、ストアの購読は退会で解約されないことを知らせ、先に解約するよう求める | P17・§11.1 (d) (利用規約第17条に足す項) | 退会の API を呼ぶ 4 つの入口 (Web の設定・凍結中と同意の前の退会の共通の部品 (`/frozen/account`・`/legal-consent/account`)・規約の同意の画面の「登録をやめる」・アプリの設定のアカウント) のすべてに、固定の文 `STORE_SUBSCRIPTION_DELETION_NOTICE` (§8.9) を出す。アプリの退会の確認には「定期購読の管理を開く」のボタンも置く (§10.4・S35)。入口の一覧が閉じていることはテスト 127 が見る |
| R25 | ストアの審査に出す前に、ストアのメタデータ (利用規約とプライバシーポリシーの URL・プライバシーの申告の購入履歴) を入れる | P16・P9 | 発注者の作業 (§12 の順 4・§17.5)。当社のコードは変えない |
| R26 | 献立の料理画像は主菜の 1 品だけ作る (見た目は残し、原価を下げる) | §0.4 の追記 3 (Q-16) | 自動の料理画像のジョブの種を作る `reconcileDishImages` の 1 か所で、種を献立の主菜の 1 品 (`autoImageDishIndexOf`。役割が `main` か `主菜` の最初の料理、主菜の無い献立は先頭の料理) だけに絞り、ほかの料理を画像の無い状態 (状態・source・subject_hash なし) にする (§8.8)。料理の保存・更新の 4 本の route・AI 相談の料理の更新・献立の作成 (Edge の `save-meal`) はどれもこの関数を通るので同じ規則になり、積み直しの道具 (`planDishImageJobs`) も同じ関数で主菜でない料理を積まない (`not_auto_image_dish`)。プランで分けない (無料は Q-3 の門が先に止める)。献立のカバーは主菜の画像になる (`deriveMealCoverImage` の既存の規則。先頭のできあがった画像)。料理の画面は、主菜でない料理に献立のカバー (= 主菜の画像) を代わりに出さず、画像の枠を出さない (`mealCoverRepresentsDish`。§10.3)。本冊の前に作られた主菜でない料理の画像は、同じ料理のままなら消さない (S41)。前の主菜を消した・前の主菜の役割を外した保存で、主菜の位置が変わらない画像の無い料理へ移ったら、その料理に種を 1 本足す (主菜の引き継ぎ `autoImageDishHandoverIndexOf`。献立に画像もジョブも無い状態を作らない。S42) |

### 3.2 ユーザーシナリオ (42 本)

| ID | シナリオ |
|---|---|
| S1 | iOS の新規購入: 無料の利用者がアプリの設定の「プランとお支払い」で個人 Pro の月額を選び、App Store の購入シートで 7 日間の無料体験つきで購入する。数秒後に `personal_subscriptions` に `trialing` の行ができ、`plan_key_cached` が `pro` になり、AI の上限が 30 回になる |
| S2 | Android の新規購入 (年額): 家族 Basic の年額を Google Play で買う。代表者の家族グループが作れるようになり、グループの `member_limit` が 4 になる |
| S3 | Web で買った人がアプリを開く: Stripe で個人 Pro を契約中の利用者がアプリの「プランとお支払い」を開く。「個人 Pro をご利用中 (Web でご契約)」と表示され、購入のボタンは出ない。解約の案内は Web の「プランとお支払い」から、とだけ書く (リンクは出さない) |
| S4 | アプリで買った人が Web を開く: App Store で契約中の利用者が Web の `/account/billing` を開く。「ご利用中」と「App Store でご契約中。解約・お支払い方法の変更は App Store の購読の管理から」が出て、解約・取り消し・Portal のボタンは出ない。`/pricing` の CTA を押すと確認画面が「すでに有効な契約があります」で止まる (billing/01 S12) |
| S5 | ストアでの解約の予約 (自動更新 OFF): iOS の設定で購読の自動更新を切る。RevenueCat の `CANCELLATION` (`UNSUBSCRIBE`) の Webhook → 取り直し → 行は `active` のまま `cancel_at_period_end = true`・`cancel_at = expires_date`。期間の終わりに `EXPIRATION` → `expired`・`plan_key_cached` が NULL・家族グループが `free` / 4 に戻る |
| S6 | 更新: 月の終わりに自動更新され `RENEWAL` が届く。行の `current_period_end` が進む。状態は `active` のまま (監査は書かない) |
| S7 | 支払いの問題: Google Play の請求が失敗し `BILLING_ISSUE` が届く。`billing_issues_detected_at` が入り、行は `past_due` (権利は続く)。ストアの猶予期間 (grace period) の間は、`expires_date` が過ぎていても `grace_period_expires_date` が先なら `past_due` のまま (P13)。猶予が尽きる (`grace_period_expires_date` も過ぎる) と、次の取り直し (`EXPIRATION` の Webhook・同期の API・遅延の再同期) で `expired` |
| S8 | 返金: Apple が返金すると `CANCELLATION` (`CUSTOMER_SUPPORT`) と `refunded_at` が入る。行は `cancelled`、権利はその時点で終わる |
| S9 | 購入の復元: 機種変更した利用者が新しい端末で同じ Apple ID でログインし、「購入を復元」を押す。`restorePurchases()` → 同期の API → 行はそのまま (同じ利用者) で、画面が「ご利用中」になる |
| S10 | 別の利用者が復元 (移動): 家族で端末を共有し、利用者 B が自分のアカウントで「購入を復元」を押す。Restore behavior (既定) で購読が A から B に移り、`TRANSFER` (transferred_from A・to B) が届く。A の行は取り直しで `expired` (A の購読は空)、B に新しい live 行ができる。A の家族グループは `free` に戻り、B は家族プランなら自分のグループを作れる |
| S11 | Webhook の順序の入れ替わり・重複・失敗の再送: `RENEWAL` が `INITIAL_PURCHASE` より先に届く / 同じ `id` が 2 回届く / 処理に失敗して RevenueCat が再送する。どれも取り直した最新の姿を `p_fetched_at` で単調に写すので結果は同じ。処理済み (`completed`) は 200 で duplicate、処理中は 409 で再送させる |
| S12 | Webhook が届かない (再送が尽きた): 5 回の再送のあとも届かなかった更新は、(a) アプリが次に起動・前面復帰・購入画面を開いたときの同期の API、(b) Web / アプリが `GET /api/billing/subscription` を読んだときの遅延の再同期 (行の `current_period_end` を過ぎていて `iap_synced_at` が 5 分より古い) のどちらかで写る (Q-11) |
| S13 | 二重購読の防止と案内 (Web とストア): Stripe で契約中の利用者が、同期の遅れで購入のボタンが出ていたアプリから App Store で買ってしまう。Webhook の写像が `BILL_LIVE_ROW_CONFLICT` で失敗し、イベントは `failed`、監査 `system.revenuecat.event_failed` (warn)。同期の API は 409 `BILL_IAP_SYNC_CONFLICT` で「すでに別のご契約があるため、この購入をご利用のプランに反映できませんでした。お問い合わせフォームからご連絡ください。二重のお支払いにならないよう対応します。」。運営は当社が持つ Stripe の契約をすぐに解約し、その期間の料金を Stripe で返金してから、RevenueCat の Dashboard の Retry (または利用者の同期) でストアの契約を写す (§13.3 の手順。利用者はストアの契約で使い続ける) |
| S14 | 鍵が無い: `REVENUECAT_SECRET_API_KEY` が無いと、Webhook は 503 (RevenueCat が再送)、同期の API は 503 `EXT_REVENUECAT_NOT_CONFIGURED`。`REVENUECAT_WEBHOOK_SECRET` が無いと Webhook は 503。カタログの API は鍵を見ない |
| S15 | ストアの商品が未登録: `plan_store_products` に行が無い間 (または `offered = true` の行が無い間)、カタログの API は空を返し、アプリの購入の画面は現在のプランの状態だけを出す (プランの一覧も購入のボタンも出さない)。Webhook で、対応の行が無く、利用者の行も無い live な商品が届いたら `BILL_IAP_UNKNOWN_PRODUCT` で `failed` (運営が `offered = false` で行を足し、次の同期か Retry で写る) |
| S16 | Stripe の Price が無い間の料金ページ: 本番に Price が無い間、`/pricing` は 3 プランのカード (価格・無料体験・内容) を出し、CTA は出さない (Q-5)。`/legal` は販売価格・支払方法・支払時期・提供時期・解約の行を販売の内容で出す。Stripe の有効化の審査はこの公開の面を見る (P11) |
| S17 | 無料の利用者の線引き: 無料の利用者が献立の作成と作り直し (1 週間・1 日・1 食・栄養の分析の献立の提案・AI 相談からの作成のどれでも) を 1 日 4 回目に頼むと 429 `AI_DAILY_LIMIT` (機能の上限 3 回。文は「今日の献立の作成の利用回数の上限 (3 回) に達しました。…」)。究極モードのトグルは錠つきで押せず、押すと「究極モードは有料プランでお使いいただけます」の案内。料理画像の作成を押すと 403 `AI_FEATURE_NOT_IN_PLAN`。家族グループを作ろうとすると 402 `FAMILY_PLAN_REQUIRED`。料理を保存すると、料理は画像なしで保存され (主菜は `skipped_plan`、ほかの料理は画像の無い状態。`aiSkipped` は付かない)、主菜の料理の画面は「料理画像の作成は有料プランでお使いいただけます。」を出す。写真の記録・AI 相談などと合わせて 1 日 3 回を使い切ると、献立の作成でない 4 回目は 429 `AI_DAILY_LIMIT` (「今日の AI の利用回数の上限 (3 回) に達しました。明日 0 時から使えます。」) |
| S18 | 有料の利用者の線引き: 個人 Pro の利用者は 1 日 30 回・献立 10 回・究極 2 回・料理画像の作成は上限の中で何度でも・自動の料理画像は献立の主菜の 1 品だけ (S37)。家族 Basic のメンバー (代表者でない大人) も家族プランの上限 (30 回) と機能 (究極 2 回) を受ける (`get_effective_plan` が家族のプランを返す) |
| S19 | 家族プランが終わったグループ: 代表者の家族 Basic が `expired` になる。グループは `free` / 4 に戻り、いるメンバーはそのまま。新しい招待の承諾・子供の追加は 402 `FAMILY_PLAN_REQUIRED`。いる子供の昇格 (子供が自分のアカウントで昇格の依頼を承諾) は成功する (いる行の書き換えで、人数は増えない)。メンバーの AI の上限は free の値に戻る |
| S20 | 運営の手動付与との共存: 運営が利用者に `family_pro` を手動で付与 (M 行)。その利用者がアプリで買おうとしても購入のボタンは出ない (live)。手動付与の取り消し・期限切れは、ストアの行 (`iap_store IS NOT NULL`) を M 行と見ない (§6.7) |
| S21 | 規約の改定の再同意: 段 E で規約とポリシーの版が上がる。サインイン中の全員に再同意が求められる (既存の仕組み)。再同意していない人の購入の API は 403 `LEGAL_CONSENT_REQUIRED` で、同意してから買う (購入の API は未同意の許可リストに入れない)。再同意の前に解約したい人は、ストアの契約なら各ストアの定期購読の管理から、Web の契約ならお問い合わせから依頼して運営が解約する (利用規約第24条に足す項。Q-15) |
| S22 | 凍結 (BAN) 中のストアの契約: 凍結中の利用者のストアの購読は更新され続ける (核の Stripe と同じく凍結は課金を止めない)。`/frozen/billing` はストアの行には「App Store / Google Play の購読の管理から解約できます」の文を出し、解約のボタンを出さない。Webhook と写像は凍結を見ない。凍結中の利用者のアプリは凍結の画面 1 つに畳まれ (#1861 の `AccountFrozenGate`)、購入の画面は開けない。カタログと同期の API は凍結中も通す API (`FROZEN_ALLOWED_API_PATHS`) に入れないので、呼ばれても 403 `AUTH_ACCOUNT_FROZEN` を返し、RevenueCat も DB の書き込みも呼ばない。凍結中のストアの更新・解約・返金は、Webhook と `GET /api/billing/subscription` (凍結中も通す。`/frozen/billing` が読む) の遅延の再同期が写し続ける |
| S23 | 無料体験の 1 人 1 回: 利用者が iOS で個人 Pro の月額を 7 日間の無料体験つきで買い (行は `trialing`)、体験中に App Store で自動更新を切る。体験の終わりに行は `expired` になる。同じ Apple ID で後日アプリの購入の画面を開くと、App Store がこの利用者を体験の対象外と判定するので、個人 Pro の月額の行は「7 日間の無料体験のあと」を出さず「1 か月ごとに ¥580 が自動で更新されます」とだけ出す (S29)。後日 Web の `/pricing` から個人 Pro を申し込むと、確認画面の無料体験は 0 日で、Checkout も試用なしで作られる。家族 Basic を Web で申し込むときは 7 日の無料体験が付く (試用は同じプランで 1 回)。同じ Apple ID でストアからもう一度買うときの試用の可否は App Store が決める (Q-10) |
| S24 | App Store の審査 (sandbox の購入): 審査官が本番のビルドに審査用のアカウントでログインし、sandbox の Apple ID で個人 Pro の月額を買う。Webhook (`environment` = `SANDBOX`) と同期の API が本物の購入と同じに写し、行は `trialing`・`iap_is_sandbox = true`・`plan_key_cached = 'pro'`。究極モードの錠が外れ、「プランとお支払い」は「個人 Pro をご利用中です」を出す。TestFlight・Google Play の内部テストの購入も同じ |
| S25 | 二重購読の防止と案内 (ストア同士): App Store で個人 Pro を契約中の利用者が、別の端末 (Android) の購入の画面から Google Play でも買ってしまう。写像が `BILL_LIVE_ROW_CONFLICT` で止め、同期の API は 409 (S13 と同じ文)。運営は Google Play の購入を Play Console で返金する (購読はすぐ終わる。P14)。2 本とも App Store の購入のとき (別の Apple ID) は、同じグループの中の変更 (S36) と見分けられないので、写像は衝突にせず新しい方を権利にして古い方の行を `expired` にする。二重の請求の問い合わせを受けた運営は、利用者にどちらか一方を App Store の定期購読の管理で解約し、その購入の返金を reportaproblem.apple.com から Apple に申し込むよう案内する (Apple の購入は開発者が返金できない。P14。残った方が次の取り直しで権利になる) |
| S26 | 組織のメンバーの上限 (組織の課金は本冊の対象外。§0.2): 運営が作った組織に管理者から招待されて入った利用者で、個人の契約も家族も無い。本冊の migration の適用のあとも、AI の 1 日の上限は適用の前の free の値 (本番 10 回) のままで、無料の利用者 (3 回) と同じにはならない。究極モードは環境変数の既定 (1 日 1 回)・献立の作成と料理画像の作成は機能ごとの上限を持たない (これまでどおり) |
| S27 | 無料の利用者が 1 週間の献立を作る: 無料の利用者が献立の画面から 1 週間の献立を頼む (`POST /api/ai/menu/weekly/request`)。献立は作られて保存されるが、料理画像は作られない (料理画像のジョブは各食の主菜の 1 本だけ積まれ (Q-16)、`process-meal-image-jobs` が AI へ送らずに取り消し、主菜を `image_status = 'failed'`・`image_error = 'skipped_plan'` にする。ほかの料理は画像の無い状態で保存される)。主菜の料理の画面は「料理画像の作成は有料プランでお使いいただけます。」を出し、ほかの料理の画面は画像の枠を出さない。同じ利用者が個人 Pro を買ったあとに同じ献立を保存し直すと、主菜の料理画像が作られる |
| S28 | 対応の無い古い商品の購入の履歴: 運営がセットアップの途中で誤った商品 ID で作った sandbox の商品を、テストの利用者が買って期限が切れた。運営はその商品の行を `plan_store_products` から消した (または初めから行が無い)。その利用者が正しい商品で個人 Pro を買うと、取り直しの `subscriptions` には古い商品 (期限切れ) と新しい商品 (live) の両方が入る。同期は古い商品を飛ばし (利用者の行も無いので何も作らない)、新しい商品の行を INSERT して `plan_key_cached='pro'` になる。古い商品の利用者の行がすでにある (運営が行を消す前に写っていた) ときは、その行の `plan_key` のまま状態だけを写す。運営が後から商品を差し替えるときは、古い行を `offered = false` にして新しい行を足す (同じプランと間隔の古い商品 ID も行として残せる) |
| S29 | 無料体験の表示がストアの判定に従う: iOS の利用者 A は App Store で個人 Pro の体験を使ったことがあり、利用者 B は無い。購入の画面は、A には個人 Pro の月額の行に体験の文を出さず (`checkTrialOrIntroductoryPriceEligibility` が対象外)、B には「7 日間無料」と「体験の終了後は ¥580 が請求されます」を出す。Android では Google Play が対象の利用者にだけ体験の offer を返すので、offer の無い利用者には体験の文を出さない。DB の `trial_days` (Web の体験の日数) は購入の画面の文には使わない |
| S30 | RevenueCat の API の失敗: RevenueCat の REST が 2xx 以外を返す・応答の形が違う・時間切れ (`REVENUECAT_REQUEST_TIMEOUT_MS`)・接続できない。利用者がアプリで買ったあとの同期の API は 502 `EXT_REVENUECAT_API_FAILED` で、購入の画面は「購入の確認サービスとの通信に失敗しました。しばらくしてからお試しください」を出す (RevenueCat の生の文は出さない)。DB は何も書かない。Webhook は 500 で、イベントを `failed` (`error_message` = `EXT_REVENUECAT_API_FAILED`) に記録し、RevenueCat が再送する。`GET /api/billing/subscription` の遅延の再同期は失敗を飲み込み、いまの行で要約を返す。RevenueCat が戻れば、アプリの前面復帰・画面を開いたときの同期・Webhook の再送・遅延の再同期のどれかで購入が写る |
| S31 | カタログの不正な問い合わせ: `store` の無い問い合わせや、`app_store` / `play_store` 以外 (`store=stripe`・大文字の `APP_STORE` など) の `GET /api/billing/iap/catalog` は 400 `BILL_IAP_INVALID_INPUT` (「入力値が不正です」) で、`plan_store_products` もプランも読まない。アプリは `Platform.OS` から `app_store` / `play_store` だけを送り (iOS・Android 以外では呼ばない)、カタログの読み込みが失敗したときは購入のカードを出さない (§10.6) |
| S32 | 月額から年額への切り替え (`PRODUCT_CHANGE`): App Store で個人 Pro の月額を契約中 (`active`) の利用者が、iOS の設定の購読の管理で同じグループの個人 Pro の年額に切り替える (当社の購入の画面は契約中は購入のカードを出さないので、切り替えはストアの管理から)。切り替えは月額の期間の終わりに効く。期間の終わりの取り直しで、月額の行が先に `expired` になり、続けて年額の行が `active` で INSERT され、`plan_key_cached` は `pro`、`billing_interval` は `year` になる。体験中 (`trialing`) の月額からの切り替えも同じ順で、月額の行の `trial_started_at` は残る |
| S33 | 解約の予約の取り消し (`UNCANCELLATION`): S5 の利用者が期間の終わりの前に iOS の設定で自動更新を入れ直す。`UNCANCELLATION` → 取り直し → 行は `active` のまま `cancel_at_period_end = false`・`cancel_at = NULL` (状態は変わらないので監査なし)。Web の `/account/billing` とアプリの購入の画面から解約の予約の文が消え、更新の文に戻る。体験中 (`trialing`) と支払いの問題の中 (`past_due`) の取り消しも、状態を変えずに同じ 2 列だけが戻る |
| S34 | 家族プランをストアで買う (月額): (a) iOS の利用者が家族 Pro の月額 (`homegohan_family_pro_month`) を買う。行は `trialing` (ストアの体験の対象でなければ `active`)、`plan_key_cached = 'family_pro'`、代表者の家族グループは `family_pro` / 8 (グループが無ければ作れるようになり、作ると `family_pro` / 8)。メンバーは家族 Pro の上限 (1 日 50 回・献立の作成 15 回・究極 3 回) を受ける。(b) Android の利用者が家族 Basic の月額 (`homegohan_family_basic:monthly-autorenewing`) を買うと `family_basic` / 4。§17.2 の 12 行 (6 商品 × 2 ストア) はどれも同じ流れで、商品 ID から `plan_key` と間隔が決まる (個人 Pro の年額・家族 Pro の年額も同じ) |
| S35 | アプリで買った人がアプリから退会する: App Store で個人 Pro を契約中の利用者が、アプリの設定 → アカウント →「アカウント削除」を押す。確認のダイアログに「アカウントとデータを削除します。取り消しできません。」に続けて「App Store / Google Play でお申し込みの有料プランは、退会しても自動では解約されません。各ストアの定期購読の管理から解約してください。」が出て、ボタンは「キャンセル」「定期購読の管理を開く」「削除」。「定期購読の管理を開く」を押すと App Store (Android では Google Play) の購読の管理のページが開き、退会はしない (画面はアカウントのまま)。解約してから「アカウント削除」→「削除」と進むと退会し、`personal_subscriptions` の行は CASCADE で消え、以後の Webhook は `user_deleted` で 200。解約せずに「削除」を押しても退会はでき、ストアの購読は続く (当社はストアの購読を止められない。確認の文がそれを知らせる)。Web の設定・凍結中と同意の前の退会 (`/frozen/account`・`/legal-consent/account` の共通の部品)・規約の同意の画面の「登録をやめる」にも同じ文が出る |
| S36 | App Store で上位のプランに変える (体験中を含む): App Store で個人 Pro の月額を 7 日間の無料体験中 (`trialing`) の利用者が、iOS の設定の購読の管理で同じグループの家族 Pro の月額に変える。家族 Pro はグループの中で上位 (§17.2 のレベル) なので変更はすぐに効き、体験中の変更では Apple が個人 Pro の体験を取り消さずに残す (P18) ので、取り直しの `subscriptions` には 2 つの商品が live で並ぶ。同期の API (200) か Webhook (`completed`) の取り直しで、個人 Pro の行は `expired` になり (`trial_started_at` は残る)、家族 Pro の行が INSERT され、`plan_key_cached` は `family_pro`、家族グループを作れるようになる (`BILL_LIVE_ROW_CONFLICT` にならない)。以後の取り直しで個人 Pro の体験がまだ live に見えても、個人 Pro の行は `expired` のまま。体験の外で `active` の個人 Pro から変えるときも同じ (Apple は個人 Pro の残りを日割りで返す。取り直しで個人 Pro が期限切れか返金済みなら先にその姿で写り、まだ live に見えても同じ規則で `expired`)。家族 Pro から個人 Pro への変更 (下位) は期間の終わりに効き、S32 と同じ順で写る |
| S37 | 有料の利用者が 1 週間の献立を作る (主菜だけの料理画像。Q-16): 個人 Pro の利用者が 1 週間の献立 (21 食。1 食は主菜・副菜・汁物・ご飯) を頼む。料理画像のジョブは 1 食に主菜の 1 本だけ (合わせて 21 本) 積まれ、主菜の画像ができると献立のカバーにもなる (献立の一覧の見た目は主菜の画像)。副菜・汁物・ご飯は画像を持たず (状態なし)、料理を押すと画像の枠の無い料理の画面になる (献立のカバー = 主菜の画像を代わりに出さない)。主菜を押すと主菜の画像。料理画像の原価は 1 週間 ≈ 210 円 (§2.4) |
| S38 | 主菜の無い献立 (Q-16): 朝食がご飯と汁物だけ (役割 `rice`・`soup`) の献立、役割が `other` だけの献立、役割の無い料理だけの献立は、先頭の料理の 1 品だけ画像を作る (献立のカバーを 1 枚残す)。先頭の料理の画面はその画像、2 品目からは画像の枠を出さない。主菜が 2 品目にある献立 (副菜・主菜の順) は、2 品目の主菜の画像を作る |
| S39 | 有料の利用者が料理を手で保存・編集する (Q-16): 主菜・副菜・汁物の 3 品の献立を手で保存すると (`POST /api/meals` ほか 4 本の route と AI 相談の料理の更新のどれでも)、主菜の 1 本だけ積み、`meal_image_auto` を 1 回数える。副菜だけを変えて保存し直すと、ジョブを積まず数えない (副菜は画像の無い状態)。主菜の中身を変えると主菜の 1 本を積み直し、1 回数える。役割が日本語の `主菜` の料理も主菜として扱う |
| S40 | 主菜でない料理の画像が欲しい (Q-18): 個人 Pro の利用者が、献立の編集の「AIで画像生成」(「AIで料理画像を生成」) で画像を作る (`image_generation`。1 日の上限の中で 1 回数える)。料理が 2 品以上の献立では、作った画像は献立のカバーになる (どれかの料理の画像にはならない。料理を選んで作る入口は無い)。料理が 1 品の献立では、その料理の画像になる。無料の利用者は 403 `AI_FEATURE_NOT_IN_PLAN` (「料理画像の作成は、有料プランでお使いいただけます。」) |
| S41 | 本冊の前に作られた料理画像 (Q-16): 段 B のデプロイの前に作られた献立で、副菜が AI の画像を持っている (`ready`)。同じ料理のまま保存し直しても、副菜の画像は残る (消さない)。副菜の中身を変えると画像は外れ、画像の無い状態になる (ジョブは積まない)。副菜が画像を待ったまま (`pending` / `failed`) の献立を保存し直すと、副菜は画像の無い状態になる (「生成中」のまま残らない)。積み直しの道具 (`scripts/requeue-pending-meal-images.ts`) も、主菜でない待ちの料理を積まず `not_auto_image_dish` として数える |
| S42 | 主菜を消す・主菜の役割を外す (主菜の引き継ぎ。Q-16): 個人 Pro の利用者の、ご飯と主菜の献立 (主菜は AI の画像あり (`ready`)・ご飯は画像の無い状態)。利用者が献立の編集で主菜を消して保存すると、ご飯が献立の主菜の位置 (主菜の無い献立の先頭) になり、ご飯の画像のジョブを 1 本積んで `meal_image_auto` を 1 回数える (ご飯は「生成中」の枠になり、できるとご飯の画像が献立のカバーになる)。主菜が 2 品の献立 (副菜・主菜 1 (`ready`)・主菜 2 (画像の無い状態)) で主菜 1 の役割を副菜に変えると、主菜 1 の画像は外れ、主菜 2 の 1 本を積んで 1 回数える。どちらも、献立を変えずに保存し直す (完了の切り替えなど) だけなら積まず数えない。無料の利用者は同じ保存で積まず、新しい主菜の位置の料理が有料プランの案内 (`skipped_plan`) になる |

---

## 4. 相 2 構想

### 4.1 構造 (発明相の結論)

1. **権利の正本は DB の行のまま、ストアの契約も同じ表の行にする。** `personal_subscriptions` に `iap_store` / `iap_product_id` / `iap_synced_at` を足し、ストアの契約は `(user_id, iap_store, iap_product_id)` で 1 行 (部分 UNIQUE)。Stripe の行 (`stripe_subscription_id`)・手動付与の行 (どちらも NULL) と同じ表・同じ status の語彙・同じ部分 UNIQUE (1 利用者 1 live 行) に乗せる。権利判定 (`get_effective_plan`)・`plan_key_cached`・家族グループの同期・運営の手動付与・退会は、行の出どころを問わない (手動付与の述語だけ `iap_store IS NULL` を足す)。RevenueCat の entitlement は当社の権利判定には使わない (アプリは `GET /api/billing/subscription` を読む)。
2. **RevenueCat のイベントは「何かが変わった合図」。契約は必ず `GET /v1/subscribers/{app_user_id}` で取り直してから写す** (核の Stripe と同じ考え。R9)。写す入口は DB 関数 `billing_apply_store_subscription(p_snapshot, p_fetched_at, p_source)` の 1 本で、Webhook・同期の API・遅延の再同期がすべてこれを呼ぶ。取り直した時刻で単調に写す (古い取り直しは stale)。取り直しに同じ App Store のグループの 2 つ以上の商品が live で並ぶ (上位への変更・体験中の変更。P18) ときは、新しい購入の 1 つを権利にし、ほかを先に終わり (`expired`) として写す (§8.1 `selectStoreSubscriptions` の `supersededAt`。S36)。
3. **同期の API (`POST /api/billing/iap/sync`) を、Webhook と同じ写像を本人の操作から呼ぶ入口にする。** アプリは購入・復元・画面を開いたとき・前面復帰で呼ぶ。Webhook の再送が尽きても (P4)、本人が使う限り写る。さらに `GET /api/billing/subscription` が、期限を過ぎたストアの行を読むときに取り直す (遅延の再同期)。
4. **商品の対応は表 `plan_store_products (store, product_id) → (plan_key, billing_interval, offered)`。** 主キーは `(store, product_id)` で、同じプランと間隔に古い商品 ID の行 (`offered = false`) を残せる (購入の履歴の商品を認識し続けるため。S28)。売る商品は `offered = true` の行で、`(plan_key, store, billing_interval)` ごとに 1 つ (部分 UNIQUE)。RevenueCat の entitlement の id は `plan_key` と同じ文字列 (`pro` / `family_basic` / `family_pro`) に決める (表は要らない)。カタログの API は、ストアごとに `offered = true` の行を返し、アプリは offerings の `product.identifier` と突き合わせた package だけを買える商品として出す。行が無い商品は出ない (R18)。取り直した契約に対応の行が無い商品は、利用者の行があればその `plan_key` のまま写し、無ければ live のときだけ `BILL_IAP_UNKNOWN_PRODUCT` で止め、live でなければ飛ばす (§8.1 `unmappedStoreSubscriptionDecision`)。
5. **線引きは DB の値。** `ai_daily_limits` の 4 行 + 新設 `ai_plan_feature_caps` の行 (0 = 使えない) を `consume_ai_usage_at` が読む (上限に数えない機能の枝より前に読むので、自動の料理画像も同じ表で止まる)。止めたときの文と応答は `_shared/ai-daily-limit.ts` の 1 か所で決まり、Web の route・Edge の生成・AI 相談の自動実行が同じ関数を通る。献立の作成 (Edge の `save-meal`) が積む料理画像のジョブは数えない (F22) ので、AI へ送る唯一の場所 `process-meal-image-jobs` が、同意の判定のすぐ後に同じ表の `meal_image_auto` の値 (`ai_plan_feature_daily_cap`) を見て、0 なら送らずに取り消す (料理画像のジョブを積む 6 つの入口の、どこから来たジョブも 1 か所で止まる)。自動で作る料理画像の量は、ジョブの種を作る `reconcileDishImages` の 1 か所で、献立の主菜の 1 品 (`autoImageDishIndexOf`) だけに絞る (Q-16。6 つの入口はどれもこの関数を通る。積み直しの道具も同じ関数で絞る)。家族の門は `create_family_group` の 1 行の判定と `family_members` の BEFORE INSERT のトリガー。画面は `BillingSummary.features` (プランの上限の表) で錠と案内を出すだけで、判定は持たない。
6. **公開の面は「表示」と「購入の可否」を分ける。** `listPublicPlans()` (public・個人/家族・free でない・金額 > 0) で価格と内容を出し、CTA は `isPurchasable` (Price あり) の間隔だけ。文の正本 `PLAN_CATALOG` (プランの説明の箇条書き・特商法の文) は DB の価格と契約テストで一致させる。
7. **モバイルは自前の購入の画面 1 つ** (`apps/mobile/app/settings/plan.tsx`) + RevenueCat の薄い包み (`apps/mobile/src/lib/purchases.ts`。`configure` / `logIn` / `logOut` / `getOfferings` / `purchasePackage` / `restorePurchases`)。WebView の `/pricing`・`/account/billing` は読み取り専用のまま。

### 4.2 シナリオのトレース (上の構造で手で走らせたもの)

| ID | トレース (番号は §4.1 の構造) |
|---|---|
| S1 | 7: 画面が `GET /api/billing/subscription` (live なし) と `GET /api/billing/iap/catalog?store=app_store` (4: `pro` 月額 = `homegohan_pro_month`) を読み、`getOfferings()` の package と突き合わせて個人 Pro の月額 (`priceString` = ¥580・無料体験 7 日) を出す → `purchasePackage` → Apple の購入 → 3: アプリが `POST /api/billing/iap/sync` → サーバが `GET /v1/subscribers/<user id>` → `subscriptions['homegohan_pro_month']` (store app_store・period_type trial・expires_date = 7 日後) → 2: `projectStoreSubscription` → `billing_apply_store_subscription` → 1: 行 INSERT (`trialing`・`iap_store='app_store'`・`trial_started_at`)・`plan_key_cached='pro'`・監査 `system.billing.subscription_created` → 応答の `BillingSummary` (status trialing・source app_store)。並行して `INITIAL_PURCHASE` の Webhook も届くが、同じ姿を取り直して stale か同値 (監査は状態が変わったときだけ) |
| S2 | S1 と同じ流れで store play_store・`homegohan_family_basic:annual-autorenewing`。1: 写像の 10. が `family_groups` を同期 (代表者のグループがあれば `family_basic` / 4)。5: グループが無ければ、作成のときに `create_family_group` の門が通り (`billing_has_live_family_plan` = true)、billing/01 のトリガーが `family_basic` / 4 を入れる |
| S3 | 7: 画面の `GET /api/billing/subscription` が `status='active'`・`source='stripe'` → 購入のボタンを描かず、「Web でご契約中」の文だけ (R16。リンク無し) |
| S4 | 1: `summarizeSubscription` が `source='app_store'`・`manage_in_store='app_store'`・`can_cancel=false`・`can_resume=false`・`has_customer=false` を返す → `/account/billing` は状態の文と「App Store の購読の管理から」の文 (リンクはストアの管理ページ)。`/pricing` の CTA → 確認画面 `can_purchase=false` → 「すでに有効な契約があります」(billing/01 の既存の判定が live な行を見る) |
| S5 | 2: `CANCELLATION` → 取り直し → `unsubscribe_detected_at` あり・`expires_date` 先 → `active`・`cancel_at_period_end=true`・`cancel_at=expires_date` (状態は変わらないので監査なし)。期間末 `EXPIRATION` → 取り直し → `expires_date` ≤ now → `expired` → 写像の 10. が `plan_key_cached` を NULL、家族グループを `free` / 4 に → 監査 `subscription_status_changed` |
| S6 | 2: `RENEWAL` → 取り直し → `expires_date` が進む → UPDATE (`current_period_end`)。status 同じ → 監査なし |
| S7 | 2: `BILLING_ISSUE` → 取り直し → `billing_issues_detected_at` あり・`expires_date` 先 → `past_due` (監査 warn)。`expires_date` が過ぎても `grace_period_expires_date` > now の間は `deriveStoreStatus` が `past_due` を返す (猶予。§7.3)。猶予の間は `current_period_end` (= `expires_date`) を過ぎているので、`GET /api/billing/subscription` を読むたびに 5 分おきに取り直す (遅延の再同期)。猶予が尽きる → `EXPIRATION` か次の取り直し → `expired` |
| S8 | 2: `CANCELLATION` → 取り直し → `refunded_at` あり → `cancelled`・`cancelled_at = refunded_at` → 権利が消える |
| S9 | 7: 「購入を復元」→ `restorePurchases()` (同じ Apple ID・同じ app_user_id) → 3: 同期 → 取り直し → 同じ行 (stale か同値) → 画面に「ご利用中」 |
| S10 | 7: B が復元 → RevenueCat が A → B に移す (P3 の既定) → `TRANSFER` (transferred_from [A]・transferred_to [B]) → 2: 両方を取り直す。A: `subscriptions` に無い (または expires 済み) → A の行を `expired` に (行が無ければ何もしない) → A の `plan_key_cached` NULL・グループ `free`。B: live → B の行を INSERT。両方とも同じ advisory の順 (利用者ごと) なので 2 つの写像は直列 |
| S11 | 2・3: イベントは種類を見ず取り直しの合図 (§8.1 `classifyRevenueCatEvent`)。`revenuecat_webhook_events` の claim が `completed` → duplicate 200、`in_progress` → 409、`failed` / 古い `processing` → 再処理。`p_fetched_at` が既存の `iap_synced_at` 以下なら stale |
| S12 | 3: アプリの `plan.tsx` が開くたびと `AppState` の active で `POST /api/billing/iap/sync`。サーバ: `getBillingSummary` が live 行で `iap_store IS NOT NULL` かつ `current_period_end < now` かつ `iap_synced_at < now - 5 分` のとき取り直して写してから要約を作る (§8.4) |
| S13 | 2: 写像の 5. が別の live 行 (Stripe) を見つけ `BILL_LIVE_ROW_CONFLICT` → Webhook は `failed` + 監査 `system.revenuecat.event_failed` (warn) + 500 (RevenueCat が再送、5 回で止まる) / 同期の API は 409 `BILL_IAP_SYNC_CONFLICT`。運営: 利用者のお問い合わせ (または監査 `system.revenuecat.event_failed` の `event_id` → `revenuecat_webhook_events.payload.app_user_id`) で利用者を特定 → Stripe の Dashboard で契約をすぐに解約し、その期間の料金を返金 → Stripe の Webhook が S 行を `cancelled` に → RevenueCat の Dashboard でイベントを Retry (または利用者がアプリの画面を開いて同期) → I 行が INSERT (§13.3) |
| S14 | 8.2・8.3: `createRevenueCatGateway()` が `REVENUECAT_SECRET_API_KEY` 無しで `RevenueCatNotConfiguredError` → Webhook 503・同期 503。署名の秘密なし → `WebhookSecretMissingError` → 503。カタログは DB だけ (鍵を見ない) |
| S15 | 4: `GET /api/billing/iap/catalog?store=app_store` → `plan_store_products` の `offered = true` の行が 0 → `plans: []` → 画面は状態だけ。Webhook の未登録の商品 → `syncStoreSubscriber` が `unmappedStoreSubscriptionDecision` (§8.1) で、利用者の行が無く live なら `reject` → `BILL_IAP_UNKNOWN_PRODUCT` を投げる → route が `failed` に記録 (§8.4・§8.5)。運営が行を足したあとの Retry / 同期で `apply` になって写る |
| S16 | 6: `listPublicPlans()` → 3 行 (Price なし) → `PricingPageView` が価格・体験・内容を描き、`isPurchasable` が偽なので CTA 無し。`/legal` は `PLAN_CATALOG` の文を描く |
| S17 | 5: どの入口も `consumeAiUsage(user, 'menu_generation')` (F23) → `consume_ai_usage_at` が `ai_plan_feature_caps(free, menu_generation) = 3` → 4 回目は `{allowed:false, capped_feature:'menu_generation', limit:3}` → 429 (`aiFeatureDailyLimitMessage('menu_generation', 3)`)。`image_generation` = 0 → `{allowed:false, limit:0, capped_feature}` → `aiDailyLimitPayload` が 403 `AI_FEATURE_NOT_IN_PLAN`。究極モードのトグルは `features.ai_feature_caps.menu_generation_ultimate === 0` で錠。`POST /api/family/groups` → `create_family_group` が `FAMILY_PLAN_REQUIRED` → 402。料理の保存 (`POST /api/meals`) → `consumeAiUsage(user, 'meal_image_auto')` → `ai_plan_feature_caps(free, meal_image_auto) = 0` → `{allowed:false, capped_feature:'meal_image_auto', plan_locked:true}` → `mealImageSkipReasonOf` = `'plan'` → 主菜 (種は主菜の 1 本だけ。S39) の `image_status = 'failed'`・`image_error = 'skipped_plan'` で保存 (ほかの料理は画像の無い状態)・`aiDailyLimitSkippedField` は `planLocked` なので空 (`aiSkipped` なし) → 料理の画面は `isMealImagePlanSkippedError` で「料理画像の作成は有料プランでお使いいただけます。」 |
| S18 | 5: `get_effective_plan` = `pro` → `ai_daily_limits(pro)=30`・`ai_plan_feature_caps(pro, menu_generation)=10`・`(pro, menu_generation_ultimate)=2`・`image_generation` 行なし → 上限の中で可。家族のメンバーは `get_effective_plan` = `family_basic` (家族の行) で同じ表を引く |
| S19 | 1: 写像の 10. (ELSE 枝) が `family_groups` を `free` / 4 に。5: `family_members` の INSERT のトリガーが `plan_key='free'` で `FAMILY_PLAN_REQUIRED`。昇格は `accept_child_promotion` の UPDATE (origin/main `20261017030000_parental_consent_and_birth_date.sql:736`) で、トリガーは `BEFORE INSERT` だけなので当たらず成功する。メンバーの `get_effective_plan` は家族の `free` → free の上限 |
| S20 | 1: M 行は live なので `BillingSummary.can_purchase=false` → アプリは購入のボタンを出さない。6.7: 取り消し・期限切れの述語 `stripe_subscription_id IS NULL AND iap_store IS NULL` でストアの行を触らない |
| S21 | 既存の同意ゲート: `/api/billing/iap/*` は `LEGAL_CONSENT_EXEMPT_API_PATHS` に入れない → 未同意は 403 `LEGAL_CONSENT_REQUIRED` (アプリは既存の `LegalConsentGate` が同意画面に畳む)。解約: ストアの契約は当社の画面に依らない。Web の契約は `/contact` (同意の前でも開ける) → 運営が Stripe の Dashboard で解約 → Stripe の Webhook (`/api/webhooks` は同意の許可リストの `no_user_session`) が S 行を写す |
| S22 | 既存: Webhook と写像は `frozen_at` を見ない。`/frozen/billing` は `summary.source` がストアなら文だけ (§10.4)。アプリ: `AccountFrozenProvider` が凍結を知ると `AccountFrozenGate` が Stack を凍結の画面に畳む (origin/main `apps/mobile/app/_layout.tsx:111-128`)。カタログ・同期の API: middleware の凍結の分岐が `FROZEN_ALLOWED_API_PATHS` (変えない。`src/lib/auth/frozen.ts:70`) に無い `/api/billing/iap/catalog`・`/api/billing/iap/sync` を 403 `AUTH_ACCOUNT_FROZEN` で止める (route に届かない)。middleware の読み取りが失敗して素通りしたときは route の `requireUser` が `ForbiddenError('AUTH_ACCOUNT_FROZEN')` を投げ、`billingErrorResponse` が 403 (`src/lib/billing/http.ts` の既存の枝) を返す。どちらも `createRevenueCatGateway` より前で止まる。写し続けるのは Webhook (署名の受け口。凍結を見ない) と `GET /api/billing/subscription` (`requireUserAllowingFrozen`) の遅延の再同期 |
| S23 | 1・2: 購入の取り直し (`period_type` trial) → 写像の 6. の INSERT が `trialing` の行に `trial_started_at = purchase_date`・`trial_ends_at = expires_date`・`trial_source = 'app_store'` を入れる (§6.4)。自動更新 OFF → `cancel_at_period_end=true` (S5 と同じ)。体験の終わりの取り直し → `expired`。UPDATE は `trial_started_at` / `trial_source` を `COALESCE` で保つ。Web: `previewCheckout` / `startCheckout` (`src/lib/billing/service.ts:73,97`) → `repository.hasUsedTrial(user, 'pro')` (`src/lib/billing/repository.ts:72-80`。同じ利用者・同じ `plan_key` で `trial_started_at` のある行を数える。行の出どころを見ないので I 行も入る。コードは変えない) = true → `trialDaysFor(7, true)` = 0 (`src/lib/billing/core.ts:446-448`)。`family_basic` は `hasUsedTrial(user, 'family_basic')` = false → 7 日。ストアでの買い直しは同じ (user, store, product) の行を再利用し、`trial_started_at` は最初の値を保つ (§7.3) |
| S24 | 7・3: 審査官の購入 → 同期の API → 取り直し → `subscriptions['homegohan_pro_month']` (`is_sandbox: true`・`period_type` trial) → 2: `projectStoreSubscription` が `is_sandbox: true` の snapshot → 1: 行 INSERT (`trialing`・`iap_is_sandbox = true`)・`plan_key_cached='pro'`・監査の details に `is_sandbox: true`。Webhook (`environment: SANDBOX`) も環境を見ずに同じ取り直し (stale か同値)。route・同期・遅延の再同期のどれも環境で絞らない (§9.1) |
| S25 | 2: Android の購入の取り直し → 写像の 5. が App Store の live 行を見つけ `BILL_LIVE_ROW_CONFLICT` → S13 と同じ記録と 409。運営: Play Console で Google Play の購入 (最新の注文) を返金 → 購読が終わる → RevenueCat の `EXPIRATION` (または `CANCELLATION`) → 取り直し → Google の商品は `refunded_at` あり (`cancelled` の履歴の行が INSERT。live でないので衝突しない)。App Store 同士 (別の Apple ID): 取り直しに 2 つの App Store の商品が live で並ぶので、S36 と同じく `selectStoreSubscriptions` が新しい方を権利にし、古い方を `expired` (`p_source` に `:superseded`) で先に写す (衝突しない)。問い合わせを受けた運営は監査の `:superseded` の行で確かめ、利用者が一方を解約して Apple に返金を申し込む → Apple が返金すると `CANCELLATION` → 取り直し → `refunded_at` → その商品は `cancelled` で写り、残った方だけが live |
| S26 | 5: `get_effective_plan` = 個人の契約も家族も無いので `organizations.plan` (`standard`) → `consume_ai_usage_at` が `ai_daily_limits(standard)` を読む = migration (5a) が free を 3 に書き換える前に写した値 (10)。`ai_plan_feature_caps` に `standard` の行は無い → 究極モードは呼び出し側の環境変数の既定・ほかの機能は 1 日の上限の合計だけ (§6.5 の「行の無い (plan, feature) は従来どおり」) |
| S27 | 5: `weekly/request` → `consumeAiUsage(user, 'menu_generation')` (free の 1 回目・許可) → Edge `generate-menu-v5` → `saveMealToDb` → `reconcileDishImages` が各食の主菜の 1 本だけを種にし (S37 のトレース)、ほかの料理を画像の無い状態にする → 主菜のジョブを積む (`save-meal.ts:757-776`。コードは変えない) → `process-meal-image-jobs` の `processJob` が同意の判定のあとに `ai_plan_feature_daily_cap(owner, 'meal_image_auto')` = 0 → `mealImageJobPlanDecision(0)` = `'locked'` → ジョブを `cancelled` (`last_error = 'skipped_plan'`)・料理を `writeDishImageFailure(reason 'skipped_plan')` で `failed` + `skipped_plan` (§8.8) → `RecipeModal` が主菜に `isMealImagePlanSkippedError` で有料プランの案内 (ほかの料理は `imageUrl` も `image_status` も無いので枠なし。S37)。Pro を買ったあとの保存し直し (主菜は `failed` + 画像なしなので `needsImageRetry` で主菜の 1 本を積み直す) → route の `consumeAiUsage(user, 'meal_image_auto')` は `pro` の行が無いので安全弁で許可 → ジョブ → `ai_plan_feature_daily_cap(owner, ...)` = NULL → `'allowed'` → 画像を作る |
| S28 | 2・4: 取り直し → `selectStoreSubscriptions` (古い商品: `expired`・mapping null / 新しい商品: `trialing`・mapping あり) → `listStoreSubscriptions(user)` に古い商品の行なし → `unmappedStoreSubscriptionDecision` = `'skip'` (`skipped_unknown` + 1) → 新しい商品を写像 → INSERT。古い商品の行がある場合は `'apply'` → snapshot の `plan_key = null` → 写像の 4. が既存の行の `plan_key` を使う (§6.4)。`plan_store_products` の主キーは `(store, product_id)` なので、同じプランと間隔に古い商品の行 (`offered = false`) と新しい行 (`offered = true`) を並べられ、カタログは `offered` の行だけを返す (§6.3・§8.1 `buildIapCatalog`) |
| S29 | 7: 画面が `fetchOfferings()` → `matchCatalogWithPackages` の前に、iOS なら `fetchTrialEligibility(商品 ID の一覧)` (`Purchases.checkTrialOrIntroductoryPriceEligibility`) → A: `'ineligible'` / B: `'eligible'` → `storeTrialOf('app_store', pkg, eligibility)` は B にだけ `{ lengthText: '7 日間' }` を返す (App Store の 1 週間の体験は `introPrice` の `price` 0・`periodUnit` `WEEK`・`periodNumberOfUnits` 1・`cycles` 1 で届き、`storeTrialOf` が週を 7 日にして書く。Google Play の `P7D` は `DAY`・7) → `renewalText` が体験の文を付けるのは B だけ。Android は `fetchTrialEligibility` が `{}` を返し、`storeTrialOf('play_store', …)` は `introPrice` の有無だけで決める (§8.10) |
| S30 | 3: アプリの購入の成功 → `syncIapPurchases()` → sync の route → `createRevenueCatGateway().getSubscriber(user.id)` (§8.3): 2xx 以外 → `RevenueCatApiError({ status })`・形の違い → `RevenueCatApiError`・`fetch` が投げる (時間切れの `AbortSignal.timeout`・接続の失敗) → `RevenueCatApiError({ status: null })` → `syncStoreSubscriber` は写像の前で投げる (DB を書かない) → `iapErrorResponse` が 502 `EXT_REVENUECAT_API_FAILED` (固定の文) → アプリの `billingErrorMessageOf` が `IAP_FIXED_MESSAGE_CODES` の固定の文を `notice` に。2: Webhook は `handleRevenueCatEvent` が投げる → `recordRevenueCatEventFailure(deps, event, errorCodeOf(error))` = `EXT_REVENUECAT_API_FAILED` → 500 → RevenueCat が再送。`GET /api/billing/subscription`: `lazyResyncStoreSubscription` が catch してログ (`code: 'unknown'`) → いまの行で `getBillingSummary` |
| S31 | 4: catalog の route → `requireUser` → `IapCatalogQuerySchema.safeParse({ store: url.searchParams.get('store') })` (`z.enum(IAP_STORES)`。null・`stripe`・`APP_STORE` は不一致) → 400 `{ error: { code: 'BILL_IAP_INVALID_INPUT', message: IAP_ERROR_MESSAGES.BILL_IAP_INVALID_INPUT, details } }` → `createClient` も `listPublicPlans` も呼ばない。7: アプリは `Platform.OS` の `ios` / `android` だけで `fetchIapCatalog` を呼び、投げたら `cards = []` (§10.6) |
| S32 | 2: 切り替えの前の取り直し (`PRODUCT_CHANGE` の合図) で `subscriptions` に年額が無ければ、月額の行は取り直しの姿のまま (変わらない)。期間の終わりの取り直し → `subscriptions` = { `homegohan_pro_month` (`expires_date` ≤ now), `homegohan_pro_year` (live) } → `selectStoreSubscriptions` が live でない月額を先に並べる → 写像 1 回目: 月額の行を `expired` (`plan_key_cached` NULL・監査 `subscription_status_changed`) → 写像 2 回目: 年額の行を INSERT (`active`・`billing_interval = 'year'`・`plan_key_cached = 'pro'`・監査 `subscription_created`)。2 回の写像は同じ取り直しの中で順に呼ぶので、年額の INSERT のときに月額の行は live でなく `BILL_LIVE_ROW_CONFLICT` にならない (§7.3 の `active` (月額) / `trialing` (月額) の行) |
| S33 | 2: `UNCANCELLATION` → 取り直し → `unsubscribe_detected_at` が null → `projectStoreSubscription` の `cancel_at_period_end = false` → 写像の UPDATE が `cancel_at = NULL`・`cancel_at_period_end = false` (§6.4。状態は同じなので監査なし) → `summarizeSubscription` の状態の文 (`billingStatusLines` / `subscriptionStatusLines`) は解約の予約の行を出さない |
| S34 | 2・4: 取り直し → `subscriptions['homegohan_family_pro_month']` → `plan_store_products` (`app_store`・`homegohan_family_pro_month`) = `family_pro`・`month` → 写像の INSERT → `plan_key_cached = 'family_pro'` → 写像の 10. が代表者のグループを `family_pro` / 8 に (グループが無ければ、作るときに `create_family_group` の門が通り、作成のトリガーが入れる)。5: メンバーの `get_effective_plan` = `family_pro` → `ai_daily_limits(family_pro) = 50`・`ai_plan_feature_caps(family_pro, menu_generation) = 15`・`(family_pro, menu_generation_ultimate) = 3`。(b) `homegohan_family_basic:monthly-autorenewing` (`play_store`) → `family_basic`・`month` → `family_basic` / 4 |
| S35 | 1 (退会は行の出どころを問わない): `apps/mobile/app/settings/account.tsx` の `deleteAccount` → `Alert.alert("アカウント削除", ACCOUNT_DELETE_CONFIRM_MESSAGE, [キャンセル, 定期購読の管理を開く, 削除])` (`ACCOUNT_DELETE_CONFIRM_MESSAGE` = 取り消しの文 + `STORE_SUBSCRIPTION_DELETION_NOTICE`。§10.4)。「定期購読の管理を開く」→ `Linking.openURL(STORE_SUBSCRIPTION_MANAGEMENT_URL[DEVICE_PURCHASE_STORE])` → `resolve(false)` (削除の API を呼ばず、`deletingRef` と `deleting` を戻す)。「削除」→ 既存の `POST /api/account/delete` → `src/lib/account-deletion.ts` の段階 `billing` は Stripe の id の無いストアの行を解約しない → 利用者の削除で行が CASCADE → 次の取り直しの写像は `user_deleted` (§6.4 の 1.) で何も書かない。Web の 3 つの入口は同じ定数を `<p>` で出すだけ (§10.4 の表) |
| S36 | 2: 変更の合図 (`PRODUCT_CHANGE` / `INITIAL_PURCHASE`) か同期の API → 取り直し → `subscriptions` = { `homegohan_pro_month` (`period_type` trial・`expires_date` = 体験の終わり・live), `homegohan_family_pro_month` (`purchase_date` = 変更の時刻・live) } → `selectStoreSubscriptions` が `app_store` の live を 2 つ見つけ (`SUPERSEDE_WITHIN_GROUP_STORES`)、`compareStoreSubscriptionRecency` で `purchase_date` の新しい家族 Pro を権利にし、個人 Pro に `supersededAt` = 家族 Pro の `purchase_date` を付けて先に並べる → `syncStoreSubscriber` の写像 1 回目 (`p_source` = `iap_sync:superseded`): `projectStoreSubscription` が `expired`・`expires_date` = `supersededAt`・`cancel_at_period_end = false` の snapshot → 個人 Pro の行を UPDATE (`expired`・`current_period_end` = 変更の時刻・`trial_started_at` は保つ・`plan_key_cached` NULL・監査 `subscription_status_changed` の `details.source` = `iap_sync:superseded`) → 写像 2 回目: 家族 Pro の行を INSERT (`active`。ストアが体験を付けたなら `trialing`)。写像の 5. は個人 Pro の行が live でないので衝突しない → `plan_key_cached = 'family_pro'` → 5: `create_family_group` の門が通る。以後の取り直しでも同じ snapshot (状態は同じなので監査なし)。個人 Pro の体験の期限が過ぎれば `deriveStoreStatus` も `expired`。Google Play の 2 つの live は `SUPERSEDE_WITHIN_GROUP_STORES` に入らないので写像の 5. の `BILL_LIVE_ROW_CONFLICT` のまま (S25) |
| S37 | 5: `weekly/request` (pro) → Edge `generate-menu-v5` → 食ごとに `saveMealToDb` → `reconcileDishImages({ regeneration: true })` が 4 品の種を作る (どれも新しい料理) → 最後の絞り込み: `autoImageDishIndexOf(dishes)` = 役割 `main` の位置 (0) → 位置 0 以外の 3 本の種を落とし、その料理を `withoutAutoDishImage` (状態・source・subject_hash を null) に → `jobs` = 主菜の 1 本 → `enqueueMealImageJobs` → `process-meal-image-jobs` の門 (`ai_plan_feature_daily_cap` = NULL → `allowed`) → 画像を作る → `applyGeneratedDishImage` → `deriveMealCoverImage` が先頭のできあがった画像 = 主菜の画像をカバーに。Web の料理の画面: 副菜を押す → `imageUrl: dish.image_url ?? (mealCoverRepresentsDish(dishesArray, idx) ? meal.imageUrl : null) ?? null` (§10.3) → 副菜は主菜でなく、source も写真・商品・手の画像でないので null → `RecipeModal` は `imageUrl` も `image_status` も無いので枠を出さない。主菜を押す → 自分の `image_url` (できる前は `mealCoverRepresentsDish` が真なのでカバー) |
| S38 | 5: `autoImageDishIndexOf([{ role: 'rice' }, { role: 'soup' }])` → `AUTO_IMAGE_DISH_ROLES` に当たる料理が無い → `AUTO_IMAGE_FALLBACK_DISH_INDEX` (0) → ご飯の 1 本。`other` だけ・役割なし (`normalizeText(undefined)` = 空) も同じ。`[{ role: 'side' }, { role: 'main' }]` → `findIndex` = 1 → 主菜の 1 本 (位置 1)。料理の画面: `mealCoverRepresentsDish` は自動の料理画像の位置 (0 か 1) だけ真 |
| S39 | 5: `POST /api/meals` → `buildDishImagePayload` → `reconcileDishImages` → 種 3 本 → 絞り込みで主菜の 1 本 → `imageJobs.length` = 1 > 0 → `consumeAiUsage(user, 'meal_image_auto')` (pro は行なし → 安全弁で 1 回) → 積む。副菜だけを変えた `PATCH` → 主菜は同じ料理で `ready` (`needsImageRetry` が偽) → 種なし。副菜は中身が変わり種 → 絞り込みで落ち、画像の無い状態 → `jobs` = [] → `imageJobs.length` = 0 なので `consumeAiUsage` を呼ばない (数えない)・積まない。主菜を変えた `PATCH` → 主菜の種 (`stale`) → 1 回数えて積む。役割 `主菜`: `normalizeText('主菜')` が `AUTO_IMAGE_DISH_ROLES` にある |
| S40 | 5: `ManualEditModal` の「AIで画像生成」→ `ImageGenerateModal` → `POST /api/ai/image/generate` → `consumeAiUsage(user, 'image_generation')` → pro: `ai_plan_feature_caps(pro, image_generation)` の行なし → 1 日の合計 (30) の中で許可 → 画像 → `PATCH /api/meal-plans/meals/[id]` の `imageUrl` → `buildDishImagePayload` の `imageUrlOverride`: 料理が 2 品以上 → カバーだけに付く (料理の画像は変えない。`reconcileDishImages` の種は主菜の 1 本まで)、1 品 → その料理を `manual_override`。free: `(free, image_generation) = 0` → `plan_locked` → 403 `AI_FEATURE_NOT_IN_PLAN` (`aiFeatureNotInPlanMessage('image_generation')`) |
| S41 | 5: 副菜 (`generated_ai`・`ready`・画像あり) の同じ料理の保存し直し → `reconcileDishImages` の「同じ料理で `needsImageRetry` が偽」の枝が前回の画像と状態を写し、種を作らない → 絞り込みは種だけを見るので副菜に触れない (画像は残る)。副菜の中身を変えた → 種 (`stale`) → 絞り込みで落ちて画像の無い状態 (`image_url` も null)。副菜が `pending` / `failed` で画像なし → `needsImageRetry` が真で種 → 絞り込みで落ちて画像の無い状態 → 次の同じ料理の保存し直しは `isAiImagePipelineDish` が偽 (subject_hash も source も無い) で写すだけ。積み直しの道具: `planDishImageJobs` → 待ち・画像なし・AI の画像・subject_hash ありの副菜 → `dishIndex !== autoImageDishIndex` → `skipped.not_auto_image_dish` + 1 |
| S42 | 5: [ご飯 (位置 0・画像の無い状態: `image_subject_hash`・`image_source` なし)・主菜 (位置 1・`ready`)] から主菜を消す `PATCH` → `reconcileDishImages` の for: ご飯は `buildDishImageSubjectHash` (名前・役割・材料・`displayOrder`・位置) が前回と同じ → `sameSubject` かつ `isAiImagePipelineDish(前回のご飯)` が偽 → 前回のまま写し、種なし → for の直後の (b0): `autoImageDishHandoverIndexOf` → 今回の `autoImageDishIndexOf` = 0 (主菜が無いので先頭)・前回 = 1 → 違う・位置 0 に種なし・ご飯は画像の無い状態 → 0 を返す → ご飯を `generated_ai`・`pending`・subject_hash 付きにして種 1 本 → カバーの判定 (`isMealCoverHeldByImagelessPreservedDish`) は写真の料理が無いので偽 → 最後の絞り込み: 種は位置 0 だけ (= `autoImageDishIndexOf`) なので落ちない → `deriveMealCoverImage`: カバーは前の主菜の AI の画像 (前回の料理で `generated_ai` と一致) なので付け替えてよく、今回の料理にできあがった画像が無いので空 → route は `imageJobs.length` = 1 > 0 → `consumeAiUsage(user, 'meal_image_auto')` を 1 回 → 積む → 画像の処理 → `applyGeneratedDishImage` がご飯の画像をカバーに。[副菜・主菜 1 (`ready`)・主菜 2 (画像の無い状態)] で主菜 1 の役割を `side` に: 主菜 1 は役割が変わり subject_hash が違う → 種 (`stale`)、主菜 2 は同じ料理で写すだけ → (b0): 今回 2・前回 1 → 位置 2 に種 1 本 → 絞り込みで位置 1 の種を落として `withoutAutoDishImage` (主菜 1 の画像は外れる) → 種は主菜 2 の 1 本 → 1 回数える。変えずに保存し直す (完了の切り替え): 役割と並びが同じなので今回と前回の `autoImageDishIndexOf` が同じ → (b0) は null → 種なし・数えない (#1487 のまま)。free: 種 1 本 → route の門 (`mealImageSkipReasonOf` = `'plan'`) で積まず `markDishImagesSkipped` が新しい主菜の位置の料理を `skipped_plan` に |

---

## 5. 相 3 構造裁定 (1 回だけ)

### 5.1 代替案の比較

| 案 | 内容 | 採否 | 理由 |
|---|---|---|---|
| A (採用) | ストアの契約も `personal_subscriptions` の行にし、RevenueCat は「ストアとの同期の機械」としてだけ使う。権利は DB | **採用** | 権利判定・家族・手動付与・退会・運営の画面が行の出どころを問わずに動く (R8)。核の契約を壊さない |
| B | RevenueCat を権利の正本にし、Web の Stripe の購入も RevenueCat の Stripe 連携で RevenueCat に写し、アプリと Web は RevenueCat の entitlement を読む | 採らない | 核 (billing/01) の写像・`plan_key_cached`・家族の同期・手動付与を作り直すことになる。RevenueCat の `CustomerInfo` の更新はサーバから push されない (P6) ので、Web のサーバ側の判定に別の取り直しが要る。Stripe 連携は RevenueCat の Web 購入の流れ (Web Billing) が前提で、当社の Checkout と二重になる |
| C | ストアの契約を別の表 `iap_subscriptions` に置き、`get_effective_plan` に 2 つ目の SELECT を足す | 採らない | 1 利用者 1 live 行の部分 UNIQUE が表をまたいで効かず、二重購読の防止 (S13) を別に作ることになる。`plan_key_cached`・家族の同期・退会・運営の画面もすべて 2 表を見ることになる |
| D | Webhook のイベントの中身 (`expiration_at_ms` など) をそのまま写す (取り直さない) | 採らない | 順序の入れ替わり (S11) に弱い。核が Stripe で「取り直して単調に写す」を採った理由と同じ |
| E | アプリで RevenueCat の `CustomerInfo` を見て権利を判定する (サーバを呼ばない) | 採らない | Web で買った人 (S3) と手動付与 (S20) が RevenueCat に無い。権利の判定が 2 系統になる |

### 5.2 「縁の発生源を消すより単純な構造は無いか」

- 縁の発生源 (1): ストアの契約と Stripe の契約が同じ表にあること。→ 消すには表を分ける (案 C) が、分けると部分 UNIQUE と同期の式が 2 倍になる。同じ表のほうが縁が少ない。
- 縁の発生源 (2): Webhook が届かない (再送が 80 分で止まる)。→ 消せない (RevenueCat の仕様)。本人の操作からの同期 (3) と遅延の再同期 (§8.4) で受ける。日次の reconcile は配線の残りの冊 (Q-11)。
- 縁の発生源 (3): 機能ごとの上限が「環境変数 (究極モード)」と「DB の行」の 2 か所にあること。→ 本冊は DB の行を正とし、行の無いプランだけ環境変数の既定に倒す (§6.5)。環境変数を消す案は、既存のテスト (`src/__tests__/lib/plan/entitlements.test.ts`・`tests/ai-usage-contract.test.ts`) と Edge Function の読み方を広く変えるので採らない。
- 縁の発生源 (4): 公開の文 (価格・特商法) と DB の価格の二重。→ 価格は DB を正にし、公開の文の正本 `PLAN_CATALOG` との一致を契約テストで見る (§8.9・テスト 60)。文を DB に持たせる案 (`subscription_plans.description`) は、公開ページの見張り (`public-claims-guard`) が静的に描けなくなるので採らない。
- 縁の発生源 (5): 料理画像のジョブを積む入口が 6 つあり (F22)、献立の作成は数えずに積む。→ 入口ごとに門を足す案は、入口が増えるたびに漏れる。AI へ送るのは `process-meal-image-jobs` の 1 か所なので、そこで `meal_image_auto` のプランの値を見て止める (同意の門と同じ場所。§8.8)。入口の route 4 本と AI 相談は、ジョブを積む前に `consume_ai_usage_at` の門でも止まる (積まずに `skipped_plan` にするので、処理の門まで来ない)。
- 縁の発生源 (6): ストアの商品 ID が変わると、購入の履歴の商品が対応の表から消える。→ 主キーを `(store, product_id)` にして古い商品の行を `offered = false` で残せるようにし、対応の行が無い商品も live でなければ飛ばす (S28)。
- 縁の発生源 (7): 自動の料理画像を主菜の 1 品だけにする (Q-16) とき、料理画像のジョブの種を作る場所が 2 つ (`reconcileDishImages` と積み直しの道具の `planDishImageJobs`) あり、入口は 6 つある (F22・F26)。→ 主菜の判定を入口ごと (4 本の route・AI 相談・`save-meal`) に置く案は、入口が増えるたびに漏れる。処理の門 (`process-meal-image-jobs`) で主菜でない料理のジョブを取り消す案は、ジョブと安全弁の 1 回を無駄にし、料理を「生成中」から「失敗」に変える見た目を作る。だから種を作る `reconcileDishImages` の最後で 1 回だけ絞り (6 つの入口が通る)、主菜の判定を同じファイルの 1 つの関数 (`autoImageDishIndexOf`) にして、積み直しの道具と料理の画面 (`mealCoverRepresentsDish`) も同じ関数を読む (§8.8)。

### 5.3 確定した構造

§4.1 の 1〜7 を確定する。以後の仕上げ (§6〜§16) はこの構造の機械的な展開で、構造の疑義は「裁定への差し戻し事由」として別に扱う。

---

## 6. データモデル (migration)

### 6.1 ファイル

- `supabase/migrations/<番号はマージ時に確定>_billing_paid_plans_iap.sql` (1 本。下の (1)〜(9) をこの順で。先頭に `SET LOCAL lock_timeout = '10s';`)
- `supabase/rollbacks/<同じ番号>_billing_paid_plans_iap.down.sql` (§6.8)
- 番号は、マージの直前に `origin/main` の `supabase/migrations` の最大より大きい値で確定する (設計で確定しない)。土台にする既存の関数の定義は、マージの直前に `git grep -l` で最新を確かめる (§16.3)。
- 冪等: `ADD COLUMN IF NOT EXISTS`・`CREATE TABLE IF NOT EXISTS`・`CREATE OR REPLACE FUNCTION`・`DROP … IF EXISTS` + `CREATE`・`INSERT … ON CONFLICT`。2 回流しても同じ結果。
- 本番の既存の行の書き換えは (1) の価格の UPDATE (3 行) と (5) の `ai_daily_limits` の `free` の UPDATE (1 行) だけ。利用者の行 (`personal_subscriptions`・`family_*`) は書き換えない (本番の利用者はゼロ)。

### 6.2 (1) `subscription_plans` の価格・無料体験・表示名 (R1・Q-6)

```sql
-- (1) 価格 (billing/03 §0.4 の決定)。価格の正本は DB のこの行。公開の文の正本 PLAN_CATALOG (packages/shared/src/billing-plans.ts) と
--     tests/billing-plan-catalog.test.ts が突き合わせる。stripe_* の列は触らない (Price の登録は販売開始の合図。§17)
UPDATE public.subscription_plans
   SET monthly_price_jpy = 580,  yearly_price_jpy = 5800,  trial_days = 7, display_name = '個人 Pro',   updated_at = now()
 WHERE plan_key = 'pro';
UPDATE public.subscription_plans
   SET monthly_price_jpy = 980,  yearly_price_jpy = 9800,  trial_days = 7, display_name = '家族 Basic', max_members = 4, updated_at = now()
 WHERE plan_key = 'family_basic';
UPDATE public.subscription_plans
   SET monthly_price_jpy = 1480, yearly_price_jpy = 14800, trial_days = 7, display_name = '家族 Pro',   max_members = 8, updated_at = now()
 WHERE plan_key = 'family_pro';
```

- `family_addon`・`org_*`・`free`・`draft` の試験の行は触らない (Q-7)。
- `plan_price_history` には書かない (価格変更の API を通さない初期値の設定。運営の価格変更 (operator/04 §3.3) は販売開始のあと従来どおり)。

### 6.3 (2) `plan_store_products` (新設) と (3) `revenuecat_webhook_events` (新設) + claim / finish

```sql
-- (2) ストアの商品と plan_key・間隔の対応 (billing/03 §4.1 の 4)。
--     product_id は RevenueCat に登録する識別子と同じ文字列 (App Store = 商品 ID、Google Play = '<subscription_id>:<base_plan_id>'。P6)。
--     主キーは (store, product_id): 同じストアの同じ商品 ID は 1 つのプランと間隔にだけ結び付く (取り直した契約の product_id → plan_key が一意)。
--     同じプランと間隔に、古い商品 ID の行 (offered = false) を残せる (購入の履歴の商品を認識し続ける。S28)。
--     offered = true の行が「そのストアで買えるか」の合図 (Web の stripe_price_id と同じ考え。R18)。売る行は (plan_key, store, billing_interval) ごとに 1 つ。
--     書くのは運営 (service_role / super_admin)。
CREATE TABLE IF NOT EXISTS public.plan_store_products (
  store             varchar(20)  NOT NULL,
  product_id        varchar(255) NOT NULL,
  plan_key          varchar(100) NOT NULL REFERENCES public.subscription_plans(plan_key) ON UPDATE CASCADE ON DELETE RESTRICT,
  billing_interval  varchar(10)  NOT NULL,
  offered           boolean      NOT NULL DEFAULT true,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT plan_store_products_pkey PRIMARY KEY (store, product_id),
  CONSTRAINT plan_store_products_store_check CHECK (store IN ('app_store', 'play_store')),
  CONSTRAINT plan_store_products_interval_check CHECK (billing_interval IN ('month', 'year')),
  CONSTRAINT plan_store_products_product_id_not_blank CHECK (btrim(product_id) <> '')
);
-- 売る商品 (offered = true) は、プラン・ストア・間隔ごとに 1 つ (アプリの購入の画面に同じプランと間隔の商品を 2 つ出さない)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_store_products_offered
  ON public.plan_store_products (plan_key, store, billing_interval) WHERE offered;
COMMENT ON TABLE public.plan_store_products IS
  'billing/03 §6.3: App Store / Google Play の商品 ID と plan_key・間隔の対応。offered = true の行のストア・間隔だけアプリの購入の画面に出る (Web の stripe_price_id と同じ合図)。offered = false の行は購入の履歴の商品を認識するために残す';
COMMENT ON COLUMN public.plan_store_products.offered IS
  'true = いま売る商品 (カタログの API が返す)。false = 売らないが、購入の履歴の商品として plan_key・間隔を引くために残す行';
DROP TRIGGER IF EXISTS plan_store_products_set_updated_at ON public.plan_store_products;
CREATE TRIGGER plan_store_products_set_updated_at
  BEFORE UPDATE ON public.plan_store_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.plan_store_products ENABLE ROW LEVEL SECURITY;
-- 読むのは公開 (未ログインのカタログの API も、公開のプランの商品 ID だけを返す。商品 ID は秘密ではない。subscription_plans_select_public と同じ条件)
DROP POLICY IF EXISTS plan_store_products_select_public ON public.plan_store_products;
CREATE POLICY plan_store_products_select_public ON public.plan_store_products
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.subscription_plans AS p
     WHERE p.plan_key = plan_store_products.plan_key AND p.status IN ('public', 'private')));
-- 書くのは super_admin だけ。subscription_plans_mutate_super_admin の最新の定義 (20261017130000_operator_mfa_db_gate.sql:420) と同じ形:
-- TO authenticated・運営ロールの条件の項に (SELECT public.operator_mfa_satisfied()) を AND で付ける (cross/12 §11.4。
-- tests/integration/security/operator-mfa-db-gate.test.ts の DB-1 が、運営ロールの条件を持つ全ポリシーにこの 2 点を求める)
DROP POLICY IF EXISTS plan_store_products_mutate_super_admin ON public.plan_store_products;
CREATE POLICY plan_store_products_mutate_super_admin ON public.plan_store_products
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE user_profiles.id = auth.uid() AND ('super_admin' = ANY (user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE user_profiles.id = auth.uid() AND ('super_admin' = ANY (user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))));
REVOKE ALL ON public.plan_store_products FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.plan_store_products TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_store_products TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.plan_store_products TO authenticated;  -- RLS の mutate ポリシー (super_admin) が絞る

-- (3) RevenueCat の Webhook のイベント (冪等キー = event.id。stripe_webhook_events と同じ形・同じ状態機械)。
--     payload は最小化した写し (TS の minimizeRevenueCatEventPayload。§8.1)。subscriber_attributes・aliases などは残さない
CREATE TABLE IF NOT EXISTS public.revenuecat_webhook_events (
  id                     varchar(255) PRIMARY KEY,
  event_type             varchar(64)  NOT NULL,
  payload                jsonb        NOT NULL,
  processing_status      varchar(20)  NOT NULL DEFAULT 'processing',
  processing_started_at  timestamptz,
  attempt_count          integer      NOT NULL DEFAULT 0,
  processed_at           timestamptz,
  error_message          text,
  received_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT revenuecat_webhook_events_status_check CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed'))
);
COMMENT ON TABLE public.revenuecat_webhook_events IS
  'billing/03 §6.3: RevenueCat の Webhook のイベント (id で冪等)。payload は最小化した写し (app_user_id / product_id / store / type / event_timestamp_ms / transferred_from / transferred_to)。service_role だけが読み書きする';
ALTER TABLE public.revenuecat_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS revenuecat_webhook_events_no_access ON public.revenuecat_webhook_events;
CREATE POLICY revenuecat_webhook_events_no_access ON public.revenuecat_webhook_events USING (false) WITH CHECK (false);
REVOKE ALL ON public.revenuecat_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.revenuecat_webhook_events TO service_role;

-- (3') claim / finish (billing_claim_stripe_event / billing_finish_stripe_event と同じ本体で、表だけ違う。戻り値 'claimed' / 'completed' / 'in_progress')
CREATE OR REPLACE FUNCTION public.billing_claim_revenuecat_event(
  p_event_id    text,
  p_event_type  text,
  p_payload     jsonb,
  p_stuck_after interval DEFAULT interval '15 minutes'
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id     text;
  v_status text;
BEGIN
  IF p_event_id IS NULL OR p_event_id = '' OR p_event_type IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'billing_claim_revenuecat_event: p_event_id / p_event_type / p_payload are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.revenuecat_webhook_events (id, event_type, payload, processing_status, processing_started_at, attempt_count)
  VALUES (p_event_id, p_event_type, p_payload, 'processing', now(), 1)
  ON CONFLICT (id) DO UPDATE
     SET processing_status      = 'processing',
         processing_started_at  = now(),
         error_message          = NULL,
         attempt_count          = public.revenuecat_webhook_events.attempt_count + 1
   WHERE public.revenuecat_webhook_events.processing_status IN ('pending', 'failed')
      OR (public.revenuecat_webhook_events.processing_status = 'processing'
          AND COALESCE(public.revenuecat_webhook_events.processing_started_at, public.revenuecat_webhook_events.received_at)
              < now() - p_stuck_after)
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN 'claimed';
  END IF;
  SELECT e.processing_status INTO v_status FROM public.revenuecat_webhook_events AS e WHERE e.id = p_event_id;
  RETURN CASE WHEN v_status = 'completed' THEN 'completed' ELSE 'in_progress' END;
END
$$;
REVOKE ALL ON FUNCTION public.billing_claim_revenuecat_event(text, text, jsonb, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_revenuecat_event(text, text, jsonb, interval) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_finish_revenuecat_event(
  p_event_id text,
  p_ok       boolean,
  p_error    text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.revenuecat_webhook_events
     SET processing_status = CASE WHEN p_ok THEN 'completed' ELSE 'failed' END,
         processed_at      = CASE WHEN p_ok THEN now() ELSE processed_at END,
         error_message     = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_event_id;
END
$$;
REVOKE ALL ON FUNCTION public.billing_finish_revenuecat_event(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_finish_revenuecat_event(text, boolean, text) TO service_role;
```

### 6.4 (4) `personal_subscriptions` のストアの列と、写像 `billing_apply_store_subscription`

```sql
-- (4) ストアの契約の列 (NULL 可。既存の行は書き換えない)
ALTER TABLE public.personal_subscriptions
  ADD COLUMN IF NOT EXISTS iap_store       varchar(20),
  ADD COLUMN IF NOT EXISTS iap_product_id  varchar(255),
  ADD COLUMN IF NOT EXISTS iap_synced_at   timestamptz,
  ADD COLUMN IF NOT EXISTS iap_is_sandbox  boolean NOT NULL DEFAULT false;
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_store_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_iap_store_check
  CHECK (iap_store IS NULL OR iap_store IN ('app_store', 'play_store'));
-- ストアの行は store と product_id の両方を持つ。Stripe の行とは排他
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_iap_pair_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_iap_pair_check
  CHECK ((iap_store IS NULL AND iap_product_id IS NULL) OR (iap_store IS NOT NULL AND iap_product_id IS NOT NULL AND stripe_subscription_id IS NULL));
-- 同じ利用者・同じストア・同じ商品は 1 行 (RevenueCat の subscriptions は product_id が鍵。写像の UPDATE の鍵)
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_subscriptions_iap_product
  ON public.personal_subscriptions (user_id, iap_store, iap_product_id) WHERE iap_store IS NOT NULL;
COMMENT ON COLUMN public.personal_subscriptions.iap_store IS
  'アプリ内課金のストア (app_store / play_store)。NULL = Stripe か手動付与の行。billing/03';
COMMENT ON COLUMN public.personal_subscriptions.iap_product_id IS
  'ストアの商品 ID (RevenueCat の subscriptions の鍵。plan_store_products.product_id)。billing/03';
COMMENT ON COLUMN public.personal_subscriptions.iap_synced_at IS
  'RevenueCat から取り直した時刻 (billing_apply_store_subscription の p_fetched_at)。これより古い取り直しは適用しない (単調)。billing/03';
COMMENT ON COLUMN public.personal_subscriptions.iap_is_sandbox IS
  'ストアのテストの購入 (sandbox。App Store の審査・TestFlight・ライセンステスター) の行なら true。権利は本物の購入と同じに扱う (billing/03 Q-13)。Stripe と手動付与の行は false';
-- trial_source の値にストアを足す (CHECK があればここで置き換える。本番の DDL に trial_source の CHECK は無い (F4) ので、COMMENT だけ)
COMMENT ON COLUMN public.personal_subscriptions.trial_source IS
  '試用の出どころ: checkout (Stripe Checkout) / app_store / play_store (ストアの無料体験。billing/03) / NULL';

-- (4') ストアの契約の写像 (本冊の中心。billing_apply_stripe_subscription と同じ骨格)。
--      p_snapshot は billing/03 §8.1 の StoreSubscriptionSnapshot (TS が RevenueCat の customer info から作る)。
--      p_fetched_at は RevenueCat から取り直した時刻。既存の行の iap_synced_at がこれ以上なら何もしない (stale)。
--      p_source は 'revenuecat:<event.id>' / 'iap_sync' / 'iap_lazy_resync'。
--      戻り値 (jsonb): { applied: true, subscription_id, user_id, status_from, status_to, plan_key } /
--                      { applied: false, skipped: 'stale', subscription_id, user_id } /
--                      { applied: false, skipped: 'user_deleted' }
--      業務エラー (P0001): BILL_UNKNOWN_PLAN / BILL_UNKNOWN_IAP_STATUS / BILL_LIVE_ROW_CONFLICT。
--      (auth.users に無い利用者は BILL_UNKNOWN_USER にせず skipped: 'user_deleted' を返す。§13.3)
--      ロックの順は核と同じ: advisory billing-user:<uuid> → iap-subscription:<store>:<product> → 契約の行 → family_groups → user_profiles
CREATE OR REPLACE FUNCTION public.billing_apply_store_subscription(
  p_snapshot   jsonb,
  p_fetched_at timestamptz,
  p_source     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id        uuid := NULLIF(p_snapshot->>'user_id', '')::uuid;
  v_store          text := p_snapshot->>'iap_store';
  v_product_id     text := p_snapshot->>'iap_product_id';
  v_plan_key       text := NULLIF(p_snapshot->>'plan_key', '');
  v_status         text := p_snapshot->>'iap_status';
  v_cancel_at_end  boolean := COALESCE((p_snapshot->>'cancel_at_period_end')::boolean, false);
  v_expires_at     timestamptz := (p_snapshot->>'expires_date')::timestamptz;
  v_purchased_at   timestamptz := (p_snapshot->>'purchase_date')::timestamptz;
  v_original_at    timestamptz := (p_snapshot->>'original_purchase_date')::timestamptz;
  v_refunded_at    timestamptz := (p_snapshot->>'refunded_at')::timestamptz;
  v_is_sandbox     boolean := COALESCE((p_snapshot->>'is_sandbox')::boolean, false);
  v_existing       public.personal_subscriptions%ROWTYPE;
  v_plan           public.subscription_plans%ROWTYPE;
  v_live           boolean;
  v_row_id         uuid;
  v_status_from    text;
  v_other_live     uuid;
  v_member_limit   integer;
  -- family_groups.member_limit の DDL の既定値と CHECK の上限 (billing/01 §6.4 (9) の 10. と同じ値)
  c_default_member_limit CONSTANT integer := 4;
  c_max_member_limit     CONSTANT integer := 20;
BEGIN
  IF v_user_id IS NULL OR v_store IS NULL OR v_product_id IS NULL OR v_status IS NULL OR v_purchased_at IS NULL
     OR p_fetched_at IS NULL OR p_source IS NULL THEN
    RAISE EXCEPTION 'billing_apply_store_subscription: snapshot / p_fetched_at / p_source are required' USING ERRCODE = '22023';
  END IF;
  IF v_store NOT IN ('app_store', 'play_store') THEN
    RAISE EXCEPTION 'billing_apply_store_subscription: iap_store must be app_store or play_store' USING ERRCODE = '22023';
  END IF;
  IF v_status NOT IN ('trialing', 'active', 'past_due', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_IAP_STATUS' USING ERRCODE = 'P0001', DETAIL = v_status;
  END IF;

  -- 1. 利用者 (app_user_id = auth.users.id)。退会済みなら何も書かない (行は CASCADE で消えている)
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_user_id) THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'user_deleted');
  END IF;

  -- 2. ロック (利用者 → ストアの契約。核と同じ鍵 billing-user:<uuid> で Stripe の写像・家族のトリガーと直列)
  PERFORM pg_advisory_xact_lock(hashtext('billing-user:' || v_user_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('iap-subscription:' || v_store || ':' || v_product_id));

  -- 3. 既存の行と鮮度 (FOR NO KEY UPDATE で読む。核の 3. と同じ理由)
  SELECT s.* INTO v_existing FROM public.personal_subscriptions AS s
   WHERE s.user_id = v_user_id AND s.iap_store = v_store AND s.iap_product_id = v_product_id
     FOR NO KEY UPDATE;
  IF v_existing.id IS NOT NULL AND v_existing.iap_synced_at IS NOT NULL AND v_existing.iap_synced_at >= p_fetched_at THEN
    RETURN jsonb_build_object('applied', false, 'skipped', 'stale', 'subscription_id', v_existing.id, 'user_id', v_user_id);
  END IF;

  -- 4. プラン (既存の行の plan_key → snapshot の plan_key)。行の plan_key は作ったときに決まり、以後変わらない (核の 4. と同じ)
  IF v_existing.id IS NOT NULL THEN
    v_plan_key := v_existing.plan_key;
  END IF;
  IF v_plan_key IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_store || ':' || v_product_id;
  END IF;
  SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.plan_key = v_plan_key;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'BILL_UNKNOWN_PLAN' USING ERRCODE = 'P0001', DETAIL = v_plan_key;
  END IF;

  v_live := v_status IN ('trialing', 'active', 'past_due');

  -- 5. 同じ利用者の別の live 行 (Stripe の契約・手動付与・別のストアの契約) があれば失敗させる (二重購読の防止。S13)。
  --    同じ App Store のグループの 2 つの live (上位への変更・体験中の変更) は、TS (billing/03 §8.1 selectStoreSubscriptions の
  --    supersededAt) が古い方を先に expired の snapshot で写してから新しい方を写すので、ここでは衝突しない (§7.3・S36)
  IF v_live THEN
    SELECT s.id INTO v_other_live
      FROM public.personal_subscriptions AS s
     WHERE s.user_id = v_user_id
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
       AND (s.iap_store IS DISTINCT FROM v_store OR s.iap_product_id IS DISTINCT FROM v_product_id)
     LIMIT 1;
    IF v_other_live IS NOT NULL THEN
      RAISE EXCEPTION 'BILL_LIVE_ROW_CONFLICT' USING ERRCODE = 'P0001', DETAIL = v_other_live::text;
    END IF;
  END IF;

  -- 6. upsert ((user_id, iap_store, iap_product_id) で 1 行。無ければ status に関わらず INSERT = 履歴の行も作る)
  IF v_existing.id IS NULL THEN
    INSERT INTO public.personal_subscriptions (
      user_id, plan_key, status, iap_store, iap_product_id, billing_interval,
      starts_at, current_period_start, current_period_end,
      trial_started_at, trial_ends_at, trial_source,
      cancel_at, cancel_at_period_end, cancelled_at, past_due_since, iap_synced_at, iap_is_sandbox
    ) VALUES (
      v_user_id, v_plan_key, v_status, v_store, v_product_id, NULLIF(p_snapshot->>'billing_interval', ''),
      COALESCE(v_original_at, v_purchased_at), v_purchased_at, v_expires_at,
      CASE WHEN v_status = 'trialing' THEN v_purchased_at ELSE NULL END,
      CASE WHEN v_status = 'trialing' THEN v_expires_at ELSE NULL END,
      CASE WHEN v_status = 'trialing' THEN v_store ELSE NULL END,
      CASE WHEN v_cancel_at_end THEN v_expires_at ELSE NULL END, v_cancel_at_end,
      CASE WHEN v_status = 'cancelled' THEN COALESCE(v_refunded_at, now()) ELSE NULL END,
      CASE WHEN v_status = 'past_due' THEN now() ELSE NULL END,
      p_fetched_at, v_is_sandbox
    ) RETURNING id INTO v_row_id;
    v_status_from := NULL;
  ELSE
    -- billing_interval: snapshot に値が無い (対応の行が無い商品・取り直しに無くなった行を終わらせる snapshot) ときは既存の値を保つ。
    -- iap_is_sandbox: snapshot の値 (TS が、取り直しに無くなった行には既存の行の値を渡す。§8.1 projectMissingSubscription)
    UPDATE public.personal_subscriptions
       SET status               = v_status,
           billing_interval     = COALESCE(NULLIF(p_snapshot->>'billing_interval', ''), billing_interval),
           current_period_start = v_purchased_at,
           current_period_end   = v_expires_at,
           trial_started_at     = COALESCE(trial_started_at, CASE WHEN v_status = 'trialing' THEN v_purchased_at ELSE NULL END),
           trial_ends_at        = COALESCE(CASE WHEN v_status = 'trialing' THEN v_expires_at ELSE NULL END, trial_ends_at),
           trial_source         = COALESCE(trial_source, CASE WHEN v_status = 'trialing' THEN v_store ELSE NULL END),
           cancel_at            = CASE WHEN v_cancel_at_end THEN v_expires_at ELSE NULL END,
           cancel_at_period_end = v_cancel_at_end,
           cancelled_at         = CASE WHEN v_status = 'cancelled' THEN COALESCE(v_refunded_at, cancelled_at, now()) ELSE NULL END,
           past_due_since       = CASE WHEN v_status = 'past_due' THEN COALESCE(past_due_since, now()) ELSE NULL END,
           iap_synced_at        = p_fetched_at,
           iap_is_sandbox       = v_is_sandbox
     WHERE id = v_existing.id;
    v_row_id := v_existing.id;
    v_status_from := v_existing.status;
  END IF;

  -- 7. 家族プランのグループへの反映と plan_key_cached (核の 10. と同じ式・同じ順: family_groups → user_profiles)
  IF v_plan.plan_type = 'family' THEN
    v_member_limit := LEAST(COALESCE(v_plan.max_members, c_default_member_limit), c_max_member_limit);
    IF v_live THEN
      UPDATE public.family_groups AS g
         SET plan_key = v_plan_key, member_limit = v_member_limit
       WHERE g.representative_id = v_user_id AND g.status = 'active'
         AND (g.plan_key IS DISTINCT FROM v_plan_key OR g.member_limit IS DISTINCT FROM v_member_limit);
    ELSE
      UPDATE public.family_groups AS g
         SET plan_key = 'free', member_limit = c_default_member_limit
       WHERE g.representative_id = v_user_id AND g.status = 'active' AND g.plan_key = v_plan_key
         AND NOT EXISTS (
           SELECT 1 FROM public.personal_subscriptions AS s
            WHERE s.user_id = v_user_id AND s.plan_key = v_plan_key
              AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'));
    END IF;
  END IF;
  UPDATE public.user_profiles AS p
     SET plan_key_cached = (
       SELECT s.plan_key FROM public.personal_subscriptions AS s
        WHERE s.user_id = v_user_id AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace')
        ORDER BY s.created_at DESC, s.id LIMIT 1)
   WHERE p.id = v_user_id;

  -- 8. 監査 (状態が変わったときだけ。核と同じ action_type。details に store と product_id)
  IF v_status_from IS DISTINCT FROM v_status THEN
    INSERT INTO public.admin_audit_logs (actor_id, action_type, target_id, target_type, severity, details)
    VALUES (
      NULL,
      CASE WHEN v_status_from IS NULL THEN 'system.billing.subscription_created' ELSE 'system.billing.subscription_status_changed' END,
      v_user_id, 'user',
      CASE WHEN v_status = 'past_due' THEN 'warn' ELSE 'info' END,
      jsonb_build_object('iap_store', v_store, 'iap_product_id', v_product_id, 'plan_key', v_plan_key,
                         'from', v_status_from, 'to', v_status, 'source', p_source, 'is_sandbox', v_is_sandbox)
    );
  END IF;

  RETURN jsonb_build_object('applied', true, 'subscription_id', v_row_id, 'user_id', v_user_id,
                            'status_from', v_status_from, 'status_to', v_status, 'plan_key', v_plan_key);
END
$$;
REVOKE ALL ON FUNCTION public.billing_apply_store_subscription(jsonb, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_store_subscription(jsonb, timestamptz, text) TO service_role;
COMMENT ON FUNCTION public.billing_apply_store_subscription(jsonb, timestamptz, text) IS
  'billing/03 §6.4: RevenueCat から取り直したストアの契約の姿 (snapshot) を personal_subscriptions に写す唯一の入口。p_fetched_at で単調。plan_key_cached と family_groups.plan_key も同期する';
```

- Stripe の写像 (`billing_apply_stripe_subscription`) は変えない。その 6. (別の live 行の検査) は `stripe_subscription_id IS DISTINCT FROM v_sub_id` なので、ストアの live 行 (Stripe の id が NULL) も「別の live 行」として `BILL_LIVE_ROW_CONFLICT` になる (Stripe の購入がストアの契約を上書きしない。二重購読の防止の両向き)。
- `status` の語彙は核の 8 値のまま (CHECK は変えない)。ストアの行が取る値は `trialing / active / past_due / cancelled / expired` の 5 つ (`incomplete`・`paused`・`grace` は取らない。ストアの猶予期間は `past_due` で表す。§7.3)。
- テストの購入 (sandbox) は本物の購入と同じに写し、`iap_is_sandbox` に印を付けるだけ (権利・家族・`plan_key_cached` の扱いは同じ。Q-13)。写像は環境で分岐しない。

### 6.5 (5) AI の線引き: `ai_daily_limits` の行と `ai_plan_feature_caps` (新設) と判定の関数

```sql
-- (5) 1 日の上限 (Q-2 の確定値。§0.4 の追記 3)。free は本番の行 (10) を書き換える (§0.4 の「いまの無料の範囲を絞る」)。ほかは行が無ければ足す
-- (5a) 組織の利用者の 1 日の上限は本冊では変えない (組織の課金は対象外。§0.2)。get_effective_plan は、個人の契約も家族も無い
--      組織の利用者に organizations.plan (自由な文字列。列の既定は 'standard'。本番の 2 組織も 'standard') を返し、
--      consume_ai_usage_at は行の無いプランを free の行で判定する。free を書き換える前に、組織の plan の値
--      (organizations.plan の値・列の既定・subscription_plans の plan_type = 'org' の行) に、いまの free の値を行として写す。
--      個人と家族の plan_key (free と下の 3 つ) は除く (組織が同じ値を持っていても、その行は (5b) と (5c) が決める)。既に行があれば上書きしない
INSERT INTO public.ai_daily_limits (plan_key, daily_limit)
SELECT k.plan_key, f.daily_limit
  FROM (
    SELECT o.plan AS plan_key FROM public.organizations AS o WHERE o.plan IS NOT NULL AND btrim(o.plan) <> ''
    UNION
    SELECT 'standard' AS plan_key  -- organizations.plan の列の既定 (これから作る組織も同じ上限)
    UNION
    SELECT p.plan_key FROM public.subscription_plans AS p WHERE p.plan_type = 'org'
  ) AS k
  CROSS JOIN (SELECT l.daily_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = 'free') AS f
 WHERE k.plan_key NOT IN ('free', 'pro', 'family_basic', 'family_pro')
ON CONFLICT (plan_key) DO NOTHING;
-- (5b) free
UPDATE public.ai_daily_limits SET daily_limit = 3, updated_at = now() WHERE plan_key = 'free';
-- (5c) 有料の 3 プラン
INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ('pro', 30), ('family_basic', 30), ('family_pro', 50)
ON CONFLICT (plan_key) DO NOTHING;
-- (5a') 段 A の後の migration 20261021110000_org_plan_ai_daily_limits.sql (#1912 段 A の整合ゲートの指摘): アプリが organizations.plan に
--      書ける値 (src/lib/org-plans.ts の ORG_PLAN_VALUES = 'standard'・'premium'・'enterprise'。運営の組織の作成と組織の設定が使う) のうち、
--      本番に組織が無いため (5a) の写す先に入らなかった 'premium'・'enterprise' に、組織の上限 10 の行を足す (追加だけ・既に行があれば上書きしない)
INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ('premium', 10), ('enterprise', 10)
ON CONFLICT (plan_key) DO NOTHING;
--      同じ migration は、owner / admin の JWT が PostgREST から organizations.plan を直接 UPDATE する経路 (RLS organizations_update_admin。
--      アプリの Zod を通らない) も ORG_PLAN_VALUES に限る: トリガー関数 guard_organizations_plan_value (BEFORE UPDATE OF plan) が、
--      authenticated / anon が plan を ORG_PLAN_VALUES の外 (有料の plan_key・行の無い値・NULL) へ変えるのを ORG_PLAN_NOT_ALLOWED (42501) で拒む。
--      限らないと、get_effective_plan が組織の plan をそのまま返すので、'pro' / 'family_pro' を書いた組織のメンバーが支払い無しで有料の上限と
--      機能の枠を得る。service_role の書き込み (運営の組織の作成) は止めない

-- (5') 機能ごとの 1 日の上限 (プラン × 機能。daily_cap 0 = そのプランでは使えない・NULL = 機能ごとの上限なし)。
--      行の無い (plan, feature) は従来どおり (究極モードは呼び出し側の環境変数の既定、ほかは 1 日の上限の合計だけ)
CREATE TABLE IF NOT EXISTS public.ai_plan_feature_caps (
  plan_key   text        NOT NULL REFERENCES public.subscription_plans(plan_key) ON UPDATE CASCADE ON DELETE CASCADE,
  feature    text        NOT NULL,
  daily_cap  integer     NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ai_plan_feature_caps_pkey PRIMARY KEY (plan_key, feature),
  -- 行を持てる機能は 4 つだけ (TS の AI_PLAN_CAPPED_FEATURES と同じ。tests/billing-paid-plans-migration-contract.test.ts が突き合わせる)。
  -- 止めたときの文 (AI_PLAN_CAPPED_FEATURE_LABELS) が無い機能に行を足させない
  CONSTRAINT ai_plan_feature_caps_feature_check CHECK (feature IN ('menu_generation_ultimate', 'menu_generation', 'image_generation', 'meal_image_auto')),
  CONSTRAINT ai_plan_feature_caps_daily_cap_nonneg CHECK (daily_cap IS NULL OR daily_cap >= 0)
);
COMMENT ON TABLE public.ai_plan_feature_caps IS
  'billing/03 §6.5: プラン × AI の機能 (ai_usage_counters.feature) の 1 日の上限。0 = そのプランでは使えない (AI の API は 403 AI_FEATURE_NOT_IN_PLAN、料理の保存の自動の料理画像は作らない)、NULL = 機能ごとの上限なし。行の無い組は従来の判定。service_role だけが読み書きする';
ALTER TABLE public.ai_plan_feature_caps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_plan_feature_caps FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_plan_feature_caps TO service_role;
-- 既定 (Q-3 の確定値。§0.4 の追記 3)。運営が変えた値は上書きしない
INSERT INTO public.ai_plan_feature_caps (plan_key, feature, daily_cap) VALUES
  ('free',         'menu_generation_ultimate', 0),
  ('free',         'image_generation',         0),
  ('free',         'meal_image_auto',          0),
  ('free',         'menu_generation',          3),
  ('pro',          'menu_generation_ultimate', 2),
  ('pro',          'menu_generation',          10),
  ('family_basic', 'menu_generation_ultimate', 2),
  ('family_basic', 'menu_generation',          10),
  ('family_pro',   'menu_generation_ultimate', 3),
  ('family_pro',   'menu_generation',          15)
ON CONFLICT (plan_key, feature) DO NOTHING;

-- (5'') 利用者のいまのプランの、機能ごとの上限の値 (数えない読み取り)。料理画像のジョブを処理する Edge Function
--       process-meal-image-jobs が、献立の作成が積んだジョブ (数えていない。F22) を AI へ送る前に、meal_image_auto の値が 0 か (そのプランでは
--       自動の料理画像を作らない) を見る (§8.8)。戻り値: 行の daily_cap (0 / 正の数 / NULL)。行が無ければ NULL (= 機能ごとの上限なし)
CREATE OR REPLACE FUNCTION public.ai_plan_feature_daily_cap(p_user_id uuid, p_feature text) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.daily_cap
    FROM public.ai_plan_feature_caps AS c
   WHERE c.plan_key = public.get_effective_plan(p_user_id) AND c.feature = p_feature
$$;
REVOKE ALL ON FUNCTION public.ai_plan_feature_daily_cap(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_plan_feature_daily_cap(uuid, text) TO service_role;
COMMENT ON FUNCTION public.ai_plan_feature_daily_cap(uuid, text) IS
  'billing/03 §6.5: 利用者のいまのプラン (get_effective_plan) の ai_plan_feature_caps の値 (行が無ければ NULL)。数えない。process-meal-image-jobs が自動の料理画像の門に使う。service_role だけ';
```

判定の関数 2 本の置き換え (土台は origin/main の最新の定義。マージの直前に `git grep -l -E 'FUNCTION (public\.)?consume_ai_usage_at' origin/main -- supabase/migrations | sort | tail -1` と同 `consume_ai_usage_capped_at` で確かめ、本文を丸ごと写してから下の差分を入れる):

- `consume_ai_usage_at(p_user_id, p_feature, p_at)`: `DECLARE` に `v_feature_cap INTEGER; v_feature_used INTEGER;` を足す。advisory のロック (`PERFORM pg_catalog.pg_advisory_xact_lock(...)`) の直後、上限に数えない機能の枝 (`IF p_feature = ANY (c_unmetered) THEN`) の**前**に次を入れ、後ろにある既存の `v_plan := public.get_effective_plan(p_user_id);` の 1 行は消す (前で読んだ値をそのまま使う。ほかは逐語)。
  ```sql
  -- billing/03 §6.5: プラン × 機能の上限 (行があれば先に見る。0 = そのプランでは使えない)。
  -- 上限に数えない機能 (meal_image_auto) もここで止めるので、上限に数えない機能の枝より前に置く
  v_plan := public.get_effective_plan(p_user_id);
  SELECT c.daily_cap INTO v_feature_cap FROM public.ai_plan_feature_caps AS c WHERE c.plan_key = v_plan AND c.feature = p_feature;
  IF FOUND AND v_feature_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(c.count), 0)::INTEGER INTO v_feature_used
      FROM public.ai_usage_counters AS c
     WHERE c.user_id = p_user_id AND c.usage_date = v_date AND c.feature = p_feature;
    IF v_feature_used >= v_feature_cap THEN
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false, 'metered', true, 'plan', v_plan, 'limit', v_feature_cap, 'used', v_feature_used,
        'usage_date', v_date, 'capped_feature', p_feature, 'plan_locked', (v_feature_cap = 0)
      );
    END IF;
  END IF;
  ```
  止めたときの `metered` は `true` (TS の `parseConsumeAiUsageResult` は `metered: false` を安全弁と読むため。安全弁の文にしない)。行の無い組 (有料プランの `meal_image_auto` など) はこの枝を素通りし、上限に数えない機能の枝 (安全弁) と 1 日の上限は従来どおり。上限に数えない機能の枝の戻り値の `'plan'` は従来どおり NULL のまま (変えない)。`plan_locked` は新しい項目 (TS の `parseConsumeAiUsageResult` が読む。§8.8)。
- `consume_ai_usage_capped_at(p_user_id, p_feature, p_feature_daily_cap, p_at)` (究極モード): `DECLARE` に `v_plan text;` を足し、ロックを取った直後 (その機能の回数を数える前) に次を入れる。
  ```sql
  -- billing/03 §6.5: プラン × 機能の行があるプランでは、呼び出し側の環境変数の上限 (p_feature_daily_cap) を使わず、行の値で判定する (consume_ai_usage_at に任せる)
  v_plan := public.get_effective_plan(p_user_id);
  IF EXISTS (SELECT 1 FROM public.ai_plan_feature_caps AS c WHERE c.plan_key = v_plan AND c.feature = p_feature) THEN
    RETURN public.consume_ai_usage_at(p_user_id, p_feature, p_at);
  END IF;
  ```
  それ以外 (行の無いプラン) は従来どおり `p_feature_daily_cap` で判定する。委譲 (`public.consume_ai_usage_at(p_user_id, p_feature, p_at)`) は、この早期の 1 か所と、土台の本文の最後の 1 か所の 2 か所になる。土台の本文の順 (ロック → その機能の回数を数える `FROM public.ai_usage_counters` → 最後の委譲) は変えない。`tests/ai-usage-contract.test.ts:707-720` の it (委譲の最初の出現が数える位置より後であることを求める) はこの早期の委譲で赤になるので、同じ段 A の PR で、2 か所の委譲の位置をそれぞれ固定する形に改める (§16.1 の `tests/ai-usage-contract.test.ts` の行)。
- 両関数の `REVOKE` / `GRANT` / `COMMENT` は既存のまま (置き換えで権限は変わらない。`tests/integration/security/anon-definer-execute.test.ts` の許可リストは触らない)。

### 6.6 (6) 家族の門 (R6・Q-4)

```sql
-- (6) 代表者に live な家族プランの契約があるか (create_family_group と family_members のトリガーが使う。所有者 (postgres) と service_role だけ)
CREATE OR REPLACE FUNCTION public.billing_has_live_family_plan(p_user_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.personal_subscriptions AS s
      JOIN public.subscription_plans AS p ON p.plan_key = s.plan_key
     WHERE s.user_id = p_user_id
       AND p.plan_type = 'family'
       AND s.status IN ('trialing', 'active', 'paused', 'past_due', 'grace'))
$$;
REVOKE ALL ON FUNCTION public.billing_has_live_family_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_has_live_family_plan(uuid) TO service_role;
COMMENT ON FUNCTION public.billing_has_live_family_plan(uuid) IS
  'billing/03 §6.6: 利用者に live な家族プラン (plan_type = family) の契約 (Stripe / ストア / 手動付与) があるか。家族の門が使う';

-- (6') メンバーの追加の門: 代表者以外の行を、plan_key = free の active なグループに足せない (FAMILY_PLAN_REQUIRED)。
--      family_members に INSERT する経路 (accept_family_invite / add_family_child / service_role の直接の INSERT) をすべて受ける。
--      子供の昇格 (accept_child_promotion) は、いる子供の行の UPDATE (人数は変わらない) なので受けない (BEFORE INSERT だけ。Q-4)。
--      SECURITY DEFINER の関数の中からでも同じ (current_user を見ない)。結合テストで free のグループにメンバーを足すときは、
--      先に代表者へ手動付与 (billing_grant_manual_subscription) で家族プランを入れる (§16.1)
CREATE OR REPLACE FUNCTION public.family_members_billing_plan_gate() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan_key text;
  v_status   text;
BEGIN
  IF NEW.role = 'representative' THEN
    RETURN NEW;
  END IF;
  SELECT g.plan_key, g.status INTO v_plan_key, v_status FROM public.family_groups AS g WHERE g.id = NEW.family_id;
  IF v_status = 'active' AND v_plan_key = 'free' THEN
    RAISE EXCEPTION 'FAMILY_PLAN_REQUIRED' USING ERRCODE = 'P0001', DETAIL = NEW.family_id::text;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.family_members_billing_plan_gate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS family_members_billing_plan_gate ON public.family_members;
CREATE TRIGGER family_members_billing_plan_gate
  BEFORE INSERT ON public.family_members
  FOR EACH ROW EXECUTE FUNCTION public.family_members_billing_plan_gate();
```

- `create_family_group(p_name, p_plan_key)` の置き換え: 土台は origin/main の最新の定義 (いまは `20261017030000_parental_consent_and_birth_date.sql:798-831`。マージの直前に `git grep -l -E 'FUNCTION "?public"?\."?create_family_group' origin/main -- supabase/migrations | sort | tail -1` で確かめる)。本文を丸ごと写し、`ALREADY_IN_FAMILY` の `END IF;` の直後に次の 4 行を入れる (ほかは逐語)。
  ```sql
  -- billing/03 §6.6: 家族グループは家族プラン (family_basic / family_pro) の契約者だけが作れる
  IF NOT public.billing_has_live_family_plan(auth.uid()) THEN
    RAISE EXCEPTION 'FAMILY_PLAN_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  ```
  `GRANT` / `REVOKE` は既存のまま (`authenticated`・`service_role` に EXECUTE)。この置き換えで `create_family_group` を最後に定義する migration が本冊の migration になる。それを `_parental_consent_and_birth_date` と固定している 2 本のテスト (`tests/parental-consent-migration-contract.test.ts:132-136`・`tests/rpc-profile-name-placeholder-migration-contract.test.ts:149-157`) を同じ段 A で直す (直し方は §16.1 の 2 行)。
- グループの `plan_key` は billing/01 のトリガー (作成・代表者の交代) と写像 (購入・終了) が同期するので、門はそれを読むだけ。契約が終わった (`free` に戻った) グループのいるメンバーは触らない (S19・Q-4)。
- 子供の昇格 (`accept_child_promotion`) は門に当てない (Q-4)。origin/main の定義 (`20261017030000_parental_consent_and_birth_date.sql:628-`) は、承諾した本人を、いる子供の行 (`v_member.id`) に `UPDATE family_members SET user_id = auth.uid(), child_profile = NULL, role = 'adult' …` (`:736`) で書き込むだけで `family_members` に INSERT しない。門のトリガーは `BEFORE INSERT` だけにし、`UPDATE` には付けない (ほかの `family_members` の UPDATE = 代表者の交代の役割の入れ替え・解散と脱退の `status = 'left'` もメンバーを足さない。UPDATE で `status` を `'active'` に戻す経路は origin/main の migration に無い (`git grep -n -i -A3 'update family_members' origin/main -- supabase/migrations` で確かめた))。本冊は `accept_child_promotion` も `POST /api/family/promotions/[token]/accept` の route も変えない (テスト 105 が、`free` のグループでの昇格の成功を固定する)。

### 6.7 (7) 手動付与 (billing/02) の述語に `iap_store IS NULL` を足す (F5)

M 行を選ぶ述語 `s.stripe_subscription_id IS NULL` を持つ 3 本を、origin/main の最新の定義 (`20261017230000_billing_manual_plan_grant.sql`。3 本ともこのファイルだけが定義する。`git grep -l` で確かめた) を土台に丸ごと写し、その述語に `AND s.iap_store IS NULL` を足す (ほかは逐語):

| 名前 | 種類 | 定義の行 | 述語の行 (逐語) | 置き換え後 |
|---|---|---|---|---|
| `billing_revoke_manual_subscription(p_user_id uuid)` | FUNCTION | `:150-191` | `:171` `     AND s.stripe_subscription_id IS NULL` | `     AND s.stripe_subscription_id IS NULL AND s.iap_store IS NULL` |
| `billing_expire_manual_subscription_for_user(p_user_id uuid)` | FUNCTION | `:205-251` | `:226` `     AND s.stripe_subscription_id IS NULL` | `     AND s.stripe_subscription_id IS NULL AND s.iap_store IS NULL` |
| `billing_expire_manual_subscriptions()` | **PROCEDURE** (pg_cron のジョブ `expire-manual-plan-grants` が毎日 CALL する) | `:264-283` | `:273` `     WHERE s.stripe_subscription_id IS NULL` | `     WHERE s.stripe_subscription_id IS NULL AND s.iap_store IS NULL` |

- PROCEDURE は `CREATE OR REPLACE PROCEDURE` で置き換える (関数ではない)。`REVOKE` (`:284`) と `COMMENT` (`:285-286`) も逐語で写す。直さないと、期限 (`current_period_end`) を過ぎた猶予中の I 行 (`past_due`) を持つ利用者を、毎日 M 行の候補として拾い続ける (`billing_expire_manual_subscription_for_user` は述語を足すので I 行を終わらせないが、無駄な呼び出しが毎日起きる)。
- `billing_manual_subscription_sync_after_end(p_user_id, p_plan_key)` (`:114-141`) は M 行を選ぶ述語を持たない (live な行の全体から `plan_key_cached` と家族グループを合わせ直す) ので変えない。
- `billing_grant_manual_subscription` は変えない (別の live 行の検査は出どころを問わない)。`tests/billing-manual-plan-grant-migration-contract.test.ts` が見る文面は、本冊の migration の中の定義も同じ検査に当てる (§16.1)。

### 6.8 ロールバック (`<番号>_billing_paid_plans_iap.down.sql`)

順に: (a) トリガー `family_members_billing_plan_gate` と関数を落とす。(b) `create_family_group` を土台にした migration の定義に戻す (逐語)。(c) 手動付与の 2 関数 (`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`) と PROCEDURE `billing_expire_manual_subscriptions` を `20261017230000` の定義に戻す (逐語)。(d) `consume_ai_usage_at`・`consume_ai_usage_capped_at` を土台の定義に戻す (逐語)。(e) `ai_plan_feature_daily_cap` を落とし、`ai_plan_feature_caps` を落とす。`ai_daily_limits` は `free` を 10 に戻し、`pro` / `family_basic` / `family_pro` の行を消し、(5a) が足した組織の plan の行 (同じ選び方の plan_key のうち `updated_by IS NULL` = 運営が画面で変えていない行) を消す (行が消えると free の 10 で判定されるので、組織の利用者の上限は適用の前と同じ)。(f) `billing_apply_store_subscription`・`billing_claim_revenuecat_event`・`billing_finish_revenuecat_event` を落とす。(g) `idx_personal_subscriptions_iap_product`・制約 2 本・列 4 本 (`iap_store`・`iap_product_id`・`iap_synced_at`・`iap_is_sandbox`) を落とす (ストアの行があれば列ごと消えるので、本番に行が無いことを確かめてから流す)。(h) `revenuecat_webhook_events`・`plan_store_products` を落とす。(i) `subscription_plans` の 3 行を旧い値 (`Pro` 980 / 9800、`Family Basic` 1480 / 14800、`Family Pro` 2480 / 24800) に戻す。`trial_source` の COMMENT を `20261016210000` の前の文に戻す必要は無い (COMMENT だけ)。

### 6.9 migration が触らないもの

- `supabase/baseline/**` (凍結)・`personal_subscriptions` の RLS と `status` の CHECK・部分 UNIQUE `idx_personal_subscriptions_active_per_user`・`billing_apply_stripe_subscription`・`billing_family_plan_follow_representative`・`guard_user_profiles_privileged(_on_insert)`・`get_effective_plan`・`ai_unmetered_daily_caps`・`feature_packages`・`feature_flags`・`family_groups` の DDL とトリガー・`family_members` の既存の制約・`stripe_webhook_events`・`billing_customers`。
- `subscription_plans.feature_packages` (全行 `[]` のまま。線引きは `ai_plan_feature_caps` と家族の門で決め、feature_packages の仕組みは使わない)。

---

## 7. 表 3 点

### 7.1 全パターン表 (行の由来 × 状態 × 消費経路)

行の由来 (`personal_subscriptions` の 1 行の出どころ): **S** = Stripe (`stripe_subscription_id IS NOT NULL`)、**M** = 手動付与 (両方 NULL)、**I** = ストア (`iap_store IS NOT NULL`。本冊で新設)。I 行はテストの購入 (`iap_is_sandbox = true`) も本物の購入も同じ列の値を取る (どの経路も環境で分けない。Q-13・S24)。

| 消費経路 (読む側・書く側) | S 行 | M 行 | I 行 (本冊) | 行なし (free) |
|---|---|---|---|---|
| `get_effective_plan` (権利判定。`trialing / active / grace / past_due`) | 読む | 読む | 読む (変更なし。出どころを見ない) | `free` (家族・組織が無ければ) |
| `user_profiles.plan_key_cached` (機能フラグ。読み手は `src/lib/feature-flags.ts`・Edge の `supabase/functions/_shared/ai-chat-flag.ts` (`PROFILE_COLUMNS`)・運営の `src/lib/super-admin/flag-active-users.ts`・`src/app/api/admin/users/route.ts`・`src/app/api/admin/users/[id]/route.ts`・本人の機能フラグの API `src/app/api/feature-flags/route.ts` (`loadOwnContext`。`:43-56` で本人の行の `plan_key_cached ?? 'free'` を段階公開の判定の `planKey` に渡す)。どれも値だけを読み、空を `free` として扱い、行の出どころを見ない。値を読まずに名指しするのは、運営の一覧の応答の型 `src/lib/admin/users-schemas.ts:45` のコメント (「plan_key_cached が空のユーザーは 'free'」。型は `plan_key: z.string()`) と、本人の書き出し `src/lib/account-export-tables.ts:142` (`user_profiles` の `omit`。書き出さない)。2026-10-19 の origin/main で `git grep -l plan_key_cached -- src lib apps packages supabase/functions scripts tests` が当てるのは、型の生成物 2 本を除いて 25 本 = テスト 17 本 (`src/__tests__` の 3 本と `tests/` の 14 本。どれも §16.1 の行にあり、母集合の作り方 16 が同じ一覧を流し直す) + 上の 8 本で全部。運営の画面 `src/app/admin/users/page.tsx:130`・`src/app/admin/users/[id]/page.tsx:237` は上の 2 本の route の応答の `plan_key` を描くだけ。どれも変更なし) | 写像 (9) が書く | 02 の関数が書く | 本冊の写像 (§6.4 の 7.) が同じ式で書く。読み手はどれも変更なし (I 行の利用者も同じ値 `pro` / `family_basic` / `family_pro` を読む) | NULL |
| `family_groups.plan_key / member_limit` | 写像 (10) + トリガー | 02 の関数 + トリガー | 本冊の写像 (§6.4 の 7.) + 既存のトリガー (作成・交代は `billing_has_live_family_plan` と同じ live の集合を読む) | `free` / 4 |
| 家族の門 (`create_family_group`・`family_members` の INSERT。§6.6) | family なら通る | family なら通る | family なら通る | 通らない (`FAMILY_PLAN_REQUIRED`) |
| 子供の昇格 (`accept_child_promotion` の `family_members` の UPDATE。§6.6・§9.5・S19) | 通る (門は `BEFORE INSERT` だけ) | 通る | 通る | 通る (グループが `free` でも。いる行の書き換えで人数は増えない。テスト 105) |
| AI の 1 日の上限 (`ai_daily_limits`) | プランの行 | プランの行 | プランの行 | `free` の行 (3) |
| AI の 1 日の上限 — 組織の利用者 (個人の契約も家族も無く、active な組織に所属。`get_effective_plan` が `organizations.plan` を返す) | (個人の契約が先。上の行と同じ) | 同左 | 同左 | 組織の plan の行 (本冊の migration (5a) が free を書き換える前の free の値 (本番 10) を写す。§6.5)。機能ごとの上限 (`ai_plan_feature_caps`) は組織の plan に行が無いので従来どおり (究極モードは環境変数の既定)。`GET /api/billing/subscription` の `features` は `ai_daily_limit` = 組織の plan の行の値・`ai_feature_caps` = `{}` (`findPlanFeatures` は機能ごとの上限を free の行に倒さない。§8.6) で、究極モードの錠は出ない (§10.3・S26) |
| AI の機能ごとの上限 (`ai_plan_feature_caps`) | プランの行 | プランの行 | プランの行 | `free` の行 (究極 0・画像の作成 0・自動の料理画像 0・献立の作成 3) |
| 献立の作成と作り直し (`menu_generation`。F23 の route 7 本・AI 相談の 3 つのアクション・Edge の `generate-menu-v4` / `v5` が利用者の JWT で直接呼ばれたとき (`directJwtUserId`)。操作 1 回で 1 回。キューの処理は数えない (次の行)) | プランの行 (pro 10・family_basic 10・family_pro 15) | 同左 | 同左 | 3 回で 4 回目は 429 (文の機能名は「献立の作成」。§8.8) |
| 献立の作成のキューの処理 (`weekly_menu_requests` の行を `process-menu-queue` の cron と `generate-menu-v4-retry.ts`・`generate-menu-v5-retry.ts` が service role で `generate-menu-v4` / `v5` に渡す。F23) | 数えない・プランを見ない (入口が積む前に `menu_generation` / `menu_generation_ultimate` を 1 回数え、プランの上限もそこで判定済み) | 同左 | 同左 | 同左 (無料の 4 回目・究極モードは入口で止まり、行は積まれない)。積んだあとに契約が終わっても、積んだ行はその時点の判定のまま作る (1 回は数え済み。取り消すと数えた 1 回が成果なしで消える。`src/lib/weekly-menu-request-stale.ts:17-21` と同じ考え方)。キューの処理と、行の読み手 (`src/lib/ai/weekly-menu-request-origin.ts`・`weekly-menu-request-ultimate.ts`・`src/lib/weekly-menu-request-stale.ts`・`src/lib/planned-meals-snapshot.ts`・`src/lib/request-progress-display.ts`・`src/lib/ai/consent-required.ts`・`supabase/functions/_shared/request-ownership.ts`) はプランも回数も読まないので変更なし (§15.2 の凍結) |
| 料理の保存の自動の料理画像 (`meal_image_auto`。4 本の route と AI 相談の自動実行) | 有料プランは行なし → 安全弁 (1 日 20 回) で、献立の主菜の 1 品だけ作る (Q-16。主菜の種が無い保存は数えない。下の「自動の料理画像を作る料理」の表) | 同左 | 同左 | 作らない (`plan_locked` → 主菜は `image_error = 'skipped_plan'` で保存・ほかの料理は画像の無い状態・`aiSkipped` なし。§8.8) |
| 献立の作成が作る料理画像 (Edge の `save-meal` が積むジョブ。数えない。F22。積むのは各食の主菜の 1 本だけ (Q-16)) → `process-meal-image-jobs` | `ai_plan_feature_daily_cap` = NULL (有料プランは行なし) → 主菜の画像を作る | 同左 | 同左 | `ai_plan_feature_daily_cap` = 0 → AI へ送らずに主菜のジョブを `cancelled`・主菜を `failed` + `skipped_plan` (§8.8。ほかの料理は積んだときから画像の無い状態) |
| `GET /api/billing/subscription` (`BillingSummary`) | `source='stripe'`・Portal / 解約 / 取り消し | `source='manual'`・ボタン無し | `source='app_store' / 'play_store'`・`manage_in_store`・ボタン無し (§8.1) | `status=null`・`can_purchase=true` |
| `GET /api/billing/subscription` の遅延の再同期 (I 行を書く 3 つ目の経路。§8.4 `lazyResyncStoreSubscription`・§8.5・S7・S12。凍結中も通す route) | 取り直さない (`needsLazyResync` は `iap_store` が NULL で偽) | 同左 | live な行の `current_period_end` ≤ now かつ `iap_synced_at` が 5 分 (`IAP_LAZY_RESYNC_MIN_INTERVAL_MS`) より古いか NULL のときだけ、RevenueCat から取り直して同期の API と同じ写像で写す (`p_source` = `iap_lazy_resync`)。鍵が無い・取り直しの失敗 (`EXT_REVENUECAT_API_FAILED` 相当・`BILL_LIVE_ROW_CONFLICT` など) は要約を止めず、いまの行で答える (S30)。live でない I 行は `findLiveSubscription` が返さないので取り直さない | 取り直さない (`findLiveSubscription` が null) |
| `/account/billing` (Web) | いまのまま | いまのまま | 状態 + 「<ストア> でご契約中…」の文とストアの管理へのリンク (§10.3) | 「プランを見る」 |
| `/frozen/billing` | いまのまま | 文だけ | 文だけ + ストアの管理の案内 (§10.4) | 「契約はありません」 |
| アプリの購入の画面 (§10.6) | 「Web でご契約中」(ボタン無し) | 「ご利用中」(ボタン無し) | 状態 + 「購読の管理」(ストア) + 「購入を復元」 | プランの一覧 + 購入 + 「購入を復元」 |
| `POST /api/billing/checkout` (Web の購入) | 409 `OP_SUBSCRIPTION_ALREADY_ACTIVE` | 同左 | 同左 (`findLiveSubscription` が I 行も返す) | 可 |
| `POST /api/billing/subscription/cancel` / `resume` | 可 | 409 `BILL_NO_LIVE_SUBSCRIPTION` (Stripe の id なし。`src/lib/billing/service.ts:169`・`:185`) | 同左 (`stripe_subscription_id IS NULL`。ストアの解約はストアで) | 同左 (live な行なし) |
| `POST /api/billing/portal` (`createPortalSession`。`billing_customers` の行だけを見る。`src/lib/billing/service.ts:160-164`) | 可 | `billing_customers` の行が無ければ 404 `BILL_CUSTOMER_NOT_FOUND` (行があれば Stripe の Portal) | 同左 (I 行の利用者が以前 Web で買っていて顧客の行があれば Stripe の Portal が開き、過去の Stripe の請求だけが見える。ストアの契約は出ない)。`/account/billing` は I 行のときこのボタンを出さない (§10.3) ので、画面からは呼ばれない | 同左 |
| `POST /api/billing/iap/sync` (本冊) | 取り直して写す (I 行が無ければ `BILL_LIVE_ROW_CONFLICT` になりうる) | 同左 | 取り直して写す (取り直しに同じ App Store のグループの 2 つ以上の商品が live で並ぶときは、新しい 1 つを権利にし、ほかの I 行を先に `expired` にする。別のストアの I 行・同じ Google Play の別の商品の I 行が live なら `BILL_LIVE_ROW_CONFLICT`。§7.3・S36) | 取り直して写す (ストアに契約が無ければ何も作らない) |
| RevenueCat の Webhook (本冊) | 同上 | 同上 | 同上 | 同上 |
| 凍結 (BAN) 中の `GET /api/billing/iap/catalog`・`POST /api/billing/iap/sync` (S22) | 403 `AUTH_ACCOUNT_FROZEN` (middleware。`FROZEN_ALLOWED_API_PATHS` に入れない。素通りしたときは route の `requireUser`)。RevenueCat を呼ばず DB を書かない | 同左 | 同左。ストアの契約の変化は Webhook と上の遅延の再同期が写し続ける (写像は凍結を見ない) | 同左 |
| 規約の版の未同意の `GET /api/billing/iap/catalog`・`POST /api/billing/iap/sync` (段 E の版の繰り上げのあと。S21) | 403 `LEGAL_CONSENT_REQUIRED` (middleware の同意ゲート。`LEGAL_CONSENT_EXEMPT_API_PATHS` に入れない)。アプリは既存の `LegalConsentGate` が同意の画面に畳む | 同左 | 同左 (Webhook と遅延の再同期は同意で止まらない。`/api/webhooks/revenuecat` は許可リストの `/api/webhooks` (prefix・`no_user_session`。`packages/shared/src/legal-consent-api.ts:135`)、`/api/billing/subscription` は許可リストの `leave_service`) | 同左 |
| 手動付与の取り消し・期限切れ (02) | 触らない | 触る | 触らない (§6.7) | — |
| 退会 (`deleteAccount` の段階 `billing`) | Stripe を解約 | — | ストアの購読は解約できない (ストアが契約の主体)。行は CASCADE で消え、以後の Webhook は `user_deleted` で何もしない (§6.4 の 1.)。退会の API を呼ぶ 4 つの入口 (Web の設定・凍結中と同意の前の退会の共通の部品 (`/frozen/account`・`/legal-consent/account`)・規約の同意の画面の「登録をやめる」・アプリの設定のアカウント) に固定の文 `STORE_SUBSCRIPTION_DELETION_NOTICE` (「…各ストアの定期購読の管理から解約してください。」) を出し、アプリの確認には「定期購読の管理を開く」のボタンを置く (§10.4・S35) | — |
| 本人のデータの書き出し (`account-export-tables.ts`) | `omit` 済み | — | 新しい列 `iap_store`・`iap_product_id`・`iap_is_sandbox` は書き出す (本人の契約の内容)。`iap_synced_at` は `omit` (内部の時刻。`stripe_synced_at` と同じ扱い) | — |
| `countPlanSubscribers` (運営のプランの廃止の判定) | 数える | 数える | 数える (live 5 値で数える。変更なし) | — |
| 運営の利用者詳細 `GET /api/admin/users/[id]` (`src/app/api/admin/users/[id]/route.ts:95-109`。`trialing / active / paused / past_due / grace` の最新の 1 行の `plan_key`・`status`・`current_period_end` を `active_subscription` として返す) | 読む | 読む | 読む (変更なし。`plan_key`・`status` (`trialing` / `active` / `past_due`)・`next_billing_at` = `current_period_end` (ストアの `expires_date`) がそのまま出る。出どころ (ストア) は出さない。出どころは運営の手動付与の欄 (`ManualPlanGrantSection` の「ストアの契約があります」。§8.6) が見る) | `active_subscription` = null |
| 運営の財務の概要 `GET /api/admin/finance/dashboard` (`src/app/api/admin/finance/dashboard/route.ts:54-66`。その月のスナップショットが無いときだけ `trialing / active` の行を `subscription_plans.monthly_price_jpy` で足し上げる) | 数える | 数える | 数える (変更なし。I 行も月額の価格で数える。年額の行・M 行を月額で数えるのも、ストアの手数料を引かないのも、いまの S 行・M 行と同じ扱い) | — |
| 運営の財務の書き出し `POST /api/admin/finance/exports` の契約の CSV (`export_type` = `subscriptions`。`src/app/api/admin/finance/exports/route.ts:137-143`。`id, user_id, plan_key, status, starts_at, current_period_start, current_period_end, cancelled_at, created_at`)。呼ぶのは運営の画面 `src/app/admin/finance/exports/page.tsx` (`:28-32` の「サブスクリプション」の種類・`:62-66` の POST。応答の CSV をそのままダウンロードする) | 出す | 出す | 出す (変更なし。出どころの列は無い。新しい列 `iap_*` は選ばれないので出ない。画面の説明「personal_subscriptions の契約一覧 (PII: user_id のみ)」も I 行を含めて正しいまま) | — |
| 運営のクーポンの適用 `POST /api/super-admin/coupons/[id]/apply` (`src/app/api/super-admin/coupons/[id]/apply/route.ts` → `src/lib/plan/coupon.ts:129` の `applyCoupon` → DB 関数 `apply_coupon` (`supabase/migrations/20261007160700_apply_coupon_rpc.sql`。この 1 本だけが定義する)。個人の契約は `p_subscription_id` = `personal_subscriptions.id` の行を出どころも `status` も見ずにロックし (`:147-152`)、`plan_key` の `monthly_price_jpy` から割引額を計算して `coupon_redemptions` に 1 行足し、`:262-264` で `personal_subscriptions.active_coupon_redemption_id` を書く。運営の画面からは呼ばれない (API だけ)) | 記録する | 記録する | 記録する (変更なし。凍結)。`coupon_redemptions` と `active_coupon_redemption_id` は記録だけで、請求の額を変える経路は無い: `apply_coupon` も `applyCoupon` も Stripe・RevenueCat・ストアに何も送らず、Web の Checkout の割引は Stripe のプロモーションコード (`src/lib/billing/core.ts:660` の `allow_promotion_codes: true`) で別の仕組み。だから I 行に記録しても、ストアの請求の額は変わらない (S 行・M 行でいま請求の額が変わらないのと同じ)。本冊の写像 (§6.4) は `active_coupon_redemption_id` を書かないので、取り直し・置き換え (`:superseded`)・期限切れで記録の参照は消えない。運営の手順書の注記は §16.2 の operator/04 の行 | — (契約の行が無いので `OP_SUBSCRIPTION_NOT_FOUND`) |
| 運営の請求書の詳細 `GET /api/admin/finance/invoices/[id]` (`src/app/api/admin/finance/invoices/[id]/route.ts:44-53`。Stripe のイベントの `subscription` で `stripe_subscription_id` を突き合わせて `user_id` を引く) | 当たる | 当たらない (Stripe の id なし) | 当たらない (変更なし。ストアの請求は Stripe のイベントに無い) | — |
| 運営の照合 `GET /api/admin/finance/reconciliation` (`src/app/api/admin/finance/reconciliation/route.ts:66-78`。DB の `trialing / active / past_due / grace` の行を status ごとに数え、Stripe の件数と並べる) | 数える | 数える | 数える (変更なし。DB の件数に I 行が入り、Stripe の件数には入らない。M 行がいま DB の件数だけに入るのと同じ扱いで、照合の不一致の記録 (`system.stripe.reconcile_discrepancy`) は Stripe の契約ごとの突き合わせで、I 行 (`stripe_subscription_id` が NULL) は対象にならない) | — |
| 無料体験の 1 人 1 回 (R14・Q-10・S23。Web の `hasUsedTrial` = 同じ利用者・同じ `plan_key` で `trial_started_at` のある行が 1 行でもあれば Checkout に試用を付けない。出どころを見ない。コードは変えない) | 写像 (9) が Checkout の試用の `trial_start` を `trial_started_at` に書く → 数える | `trial_started_at` を入れない (billing/02 §4.1) → 数えない | 写像 (§6.4 の 6.) が `trialing` のときだけ `trial_started_at` / `trial_ends_at` / `trial_source` (`app_store` / `play_store`) を書き、期限切れ・買い直しでも保つ → 数える (Web の同じプランの試用は付かない)。ストアの試用の可否はストアが決める (当社は止めない。§18 の 5) | 数えない (Web の最初の申し込みは `trial_days` = 7) |

公開の面 (プランの表示):

| 面 | Stripe の Price なし (いま) | Price あり | ストアの商品の行なし | ストアの商品の行あり |
|---|---|---|---|---|
| `/pricing` | 3 プランのカード (価格・体験・内容)。CTA 無し (Q-5) | 買える間隔の CTA | (ストアは関係しない) | (同左) |
| `/legal` (特商法) | #1911 の 8 行に、販売の 9 行 (販売価格・商品代金以外の必要料金・支払方法・支払時期・サービス提供時期・返品・キャンセル・解約について・定期購入について・無料体験について) を足す (§10.2) | 同左 | 同左 | 同左 |
| `GET /api/billing/iap/catalog?store=…` | (Stripe は関係しない) | (同左) | `plans: []` (`offered = true` の行が無いときも) | `offered = true` の行のある plan × 間隔 |
| アプリの購入の画面 | (同左) | (同左) | 現在の状態だけ | offerings と一致した商品のカード。無料体験の文はストアの導入価格と体験の対象の判定から (§10.6) |

`subscription_plans` と `ai_daily_limits` の書き手 (本冊の migration と干渉しないか):

| 書き手 | 書く列 | 本冊での扱い | 本冊の migration (§6.2・§6.5) との関係 |
|---|---|---|---|
| 本冊の migration (§6.2) | `pro`・`family_basic`・`family_pro` の `monthly_price_jpy`・`yearly_price_jpy`・`trial_days`・`display_name`・`max_members` | 新設 | `stripe_product_id`・`stripe_price_id`・`stripe_yearly_price_id` は書かない (F1 の本番の値はどれも NULL のまま) |
| `POST /api/super-admin/plans/[id]/price-change` (`src/app/api/super-admin/plans/[id]/price-change/route.ts:320-331`) | 変えた間隔の `monthly_price_jpy` / `yearly_price_jpy` と、Stripe の新しい Price の ID (`stripe_price_id` = 月額・`stripe_yearly_price_id` = 年額)。`plan_price_history` に 1 行 | 変更なし | migration の適用は §12 の順 1 (Stripe の Price の登録は順 3 の後)。順 3 で運営がこの API で Price の ID を入れるとき、価格は migration が入れた値のまま (`new_*_price_jpy` に同じ値を渡す)。migration は `stripe_*` を書かないので、この API が入れた ID を消さない |
| Edge Function `stripe-price-sync` (`supabase/functions/stripe-price-sync/index.ts`・`sync.ts`・`deactivation.ts`) | DB に書かない (旧 Price の ID を `subscription_plans` から読むだけ。Stripe に新しい Price を作り、旧 Price を無効にする。`index.ts` の冒頭の契約の注) | 変更なし | 呼ばれるのは上の `price-change` からだけ。本冊は Stripe の Price を作らない |
| `PATCH` / `DELETE /api/super-admin/plans/[id]`・`POST /api/super-admin/plans` (`src/app/api/super-admin/plans/[id]/route.ts`・`src/app/api/super-admin/plans/route.ts`) | プランの行 (表示名・状態・`stripe_product_id` など。operator/04) | 変更なし | 本冊の migration の後に運営が変えた値は、運営の値が正 (migration を流し直さない)。`plan_key` は変えない。`DELETE` は `draft` の行だけ (`:296-301`) で、`draft` の行には `plan_store_products` の行を入れない (§17.2 の行は 3 つの有料プランだけ) ので `ON DELETE RESTRICT` に当たらない |
| `PATCH /api/super-admin/llm/quotas` (`src/app/api/super-admin/llm/quotas/route.ts:129-139`) | `ai_daily_limits` の upsert | 変更なし | migration は組織の plan の行 (5a) と有料の 3 行を `ON CONFLICT DO NOTHING` で足し (運営が先に入れた行は上書きしない)、`free` を 3 に UPDATE する。運営の画面の一覧 (`GET`) には組織の plan の行も出る (`configured: true`。値は適用の前の free の値)。`ai_plan_feature_caps` は運営の画面に出さない (§0.2) |

`subscription_plans` と `ai_daily_limits`・`ai_plan_feature_caps` の読み手 (運営の画面の組み立てと検証・公開の面と課金のサーバの読み取り・死活監視・AI の判定。route の本体以外。母集合 = `git grep -n -E "subscription_plans|ai_daily_limits" origin/main -- src lib supabase/functions scripts packages apps` からテスト・型の生成物・コメントだけの行を除いたもの。上の消費経路の表と書き手の表に行があるもの (運営の財務の概要 `src/app/api/admin/finance/dashboard/route.ts`・運営のプランと AI の上限の route・`stripe-price-sync`) と、紹介ページの主張の根拠の文字列 (`src/components/marketing/landing-copy.ts:860` の `claims` の `ai-daily-limit`。§10.5 と §16.2 の marketing/01 の行) と `supabase/functions/README.md:292` (§16.1 の「free = 10 の文」の行) は除く):

| 読み手 | 読むもの | 本冊での扱い | 本冊の migration の後に見えるもの |
|---|---|---|---|
| `src/lib/super-admin/ai-daily-limits.ts` (`buildAiDailyLimitRows`。`GET /api/super-admin/llm/quotas` の一覧) | `subscription_plans` の `plan_key`・`display_name`・`plan_type` と `ai_daily_limits` の全行。自分の行が無いプランは `free` の行の値 (`effective_daily_limit`) | 変更なし (凍結) | 一覧に `free` 3・`pro` 30・`family_basic` 30・`family_pro` 50 (表示名は §6.2 の `個人 Pro`・`家族 Basic`・`家族 Pro`) と組織の plan の行 (適用の前の free の値。§6.5 (5a)) が `configured: true` で出る。行の無いプランは `free` の値という規則は `consume_ai_usage_at` の `c_default_plan` (= `'free'`) と同じまま (§6.5 は土台の本文を写すので定数は変わらない。`tests/ai-usage-contract.test.ts` が固定)。`ai_plan_feature_caps` は読まないので、機能ごとの上限は一覧に出ない (§0.2) |
| `src/lib/super-admin/llm-schemas.ts` (`UpdateAiDailyLimitSchema`・`AI_DAILY_LIMIT_MAX`・`AI_DAILY_LIMIT_DEFAULT_PLAN_KEY`・`LLM_QUOTAS_ENFORCED_NOTE`) | 運営の入力の検証と画面の注記 | 変更なし (凍結) | `AI_DAILY_LIMIT_MAX` (10,000) は本冊の最大の値 50 より大きいので、本冊の 4 行は運営の画面からそのまま保存し直せる。`plan_key` の検証は文字の長さだけで、プランの一覧を持たない。注記 `LLM_QUOTAS_ENFORCED_NOTE` (料理画像は合計に数えず、機能ごとの安全弁で止まる) は有料プランについてそのまま正しく、無料プランの料理画像を作らないこと (`ai_plan_feature_caps` の `meal_image_auto` = 0) は運営の画面に出さない (`ai_plan_feature_caps` を出さないのと同じ。§0.2) |
| 運営の AI の上限の画面 `src/app/super-admin/llm/quotas/page.tsx` (`:61` で `GET /api/super-admin/llm/quotas`、`:103` で行ごとに `PATCH`。`:131-133` で応答の `note` を、`default_plan_key` を「free の値」の表示に使う) | 上の 2 本の route の応答 (`ai_daily_limits` の行と `subscription_plans` の表示名) | 変更なし (凍結) | 上の `ai-daily-limits.ts` の行のとおりの一覧 (4 行と組織の plan の行・新しい表示名) を描く。上限の値を画面に持たない (入力の検証は `AI_DAILY_LIMIT_MAX` と `parseLimitInput` を import するだけ)。`ai_plan_feature_caps` は出ない (§0.2・§16.2 の operator/06 の行) |
| 運営のプランの画面 `src/app/super-admin/plans/page.tsx` (一覧。`:53` で `GET /api/super-admin/plans`。`:120`・`:123` で月額・年額)・`src/app/super-admin/plans/[id]/page.tsx` (詳細。`:70` で `GET /api/super-admin/plans/[id]`、状態・表示名の変更は同じ route の `PATCH`。「価格設定」のタブの `:381`・`:387` で月額・年額、`:398-410` で `stripe_product_id`・`stripe_price_id`・`stripe_yearly_price_id` (NULL は「未設定」))・`src/app/super-admin/plans/[id]/price-change/page.tsx` (`:60` で今の価格を読み、`:96` で `price-impact`、`:131` で `price-change`) | 上の書き手の表の route の応答 (`subscription_plans` の行と `plan_price_history`) | 変更なし (凍結) | 3 プランの価格は §6.2 の値 (580 / 5,800・980 / 9,800・1,480 / 14,800)、表示名は `個人 Pro`・`家族 Basic`・`家族 Pro` で出る。Stripe の 3 つの ID は §12 の順 3 で運営が `price-change` (この画面) で入れるまで「未設定」(運営だけが見る管理の画面の値の欄。利用者と公開ページの文ではなく、「準備中」を取り除く範囲 (利用者と公開ページ) に入らない)。`plan_store_products` は読まないので、ストアの商品は出ない (ストアの商品の行は §17.2 の SQL で入れる) |
| 運営のプランの作成の画面 `src/app/super-admin/plans/new/page.tsx` (`:14-24` の `OFFICIAL_PLANS` = 9 つの公式の `plan_key` のひな形。選ぶと `:41-48` の `handleSelectTemplate` が表示名・種別・月額を入力欄に入れ、`:60` で `POST /api/super-admin/plans`) | (DB を読まない。ひな形はファイルの中の定数) | `pro`・`family_basic`・`family_pro` のひな形の表示名と月額を `PLAN_CATALOG` から読む (§16.1 の行。いまの値は旧案の `Pro` 980・`Family Basic` 1,480・`Family Pro` 2,480) | 3 プランのひな形は §6.2 の値と同じ表示名・月額になる。ほかの 6 つ (`free`・`family_addon`・組織の 4 つ) は変えない |
| `src/lib/billing/public-plans.ts` (`listPurchasablePlans` (`:14-30`)。`status = 'public'`・個人 / 家族・free でない・`.not('stripe_price_id', 'is', null)` (`:22`) で絞る。呼ぶのは `src/app/pricing/page.tsx:10,22` だけ) | `subscription_plans` の `PLAN_COLUMNS` (`:8`) | 変更 (§8.6 の全文の置き換え。`listPublicPlans` に替え、Price で絞らず `monthly_price_jpy > 0` で絞り、列に `max_members` を足す) | 3 プラン (§6.2 の価格・体験・表示名・人数) が Stripe の Price の有無に関わらず出る (S16)。CTA は `isPurchasable` の間隔だけ (§10.1)。カタログの route (§9.2) も同じ関数を読む |
| `src/lib/billing/repository.ts` の `findPlan` (`:45-49`。Checkout の作成 `src/lib/billing/service.ts:70`・`:92` が価格・試用・Price の ID を読む) と `findPlanKeyByPriceId` (`:50-59`。Stripe の Webhook が Price の ID から `plan_key` を引く) | `subscription_plans` の `PLAN_COLUMNS` (`:38`) | 変更なし (§8.6 の `repository.ts` の差分は `SUBSCRIPTION_VIEW_COLUMNS` と `findPlanFeatures` だけ) | `findPlan` は §6.2 の価格と `trial_days` を返す。Price の ID は §12 の順 3 まで NULL なので、Checkout は `priceIdFor` が null で既存の `BILL_PLAN_NOT_PURCHASABLE` (`service.ts:94-95`) のまま。`findPlanKeyByPriceId` は Price の ID が入った後だけ当たる |
| `src/lib/billing/repository.ts` の `findPlanFeatures` (本冊で新設。§8.6。`GET /api/billing/subscription` の `features` を作る) | `ai_daily_limits` (そのプランと `free` の 2 行)・`ai_plan_feature_caps` (そのプランの行だけ) | 新設 | free: `ai_daily_limit` = 3・`ai_feature_caps` = free の 4 行 (究極 0・画像の作成 0・自動の料理画像 0・献立の作成 3) / 有料: そのプランの行 / 組織の plan: 写した 1 日の上限と `{}` (S26・テスト 138・139) |
| `src/lib/billing/manual-grant-repository.ts` の `listGrantablePlans` (`:67-80`。運営の手動付与の選択肢) | `subscription_plans` の付与できる個人 / 家族の行 | 変更なし (この読み取りは変えない。同じファイルで変えるのは `source` の判定だけ。§8.6) | 選択肢の表示名が §6.2 の `個人 Pro`・`家族 Basic`・`家族 Pro` になる |
| `src/app/api/health/route.ts:104-110` (死活監視。anon の client で `id` を 1 行読む) | `subscription_plans` の `id` | 変更なし (凍結。§15.2) | 行を消さないので疎通の判定は変わらない (§16.1 の health の行) |
| `src/lib/plan/entitlements.ts` の `consumeAiUsage` (`:197-`。表を直接は読まず、`:208-209` で DB 関数 `consume_ai_usage` / `consume_ai_usage_capped` を呼ぶ) | DB 関数の中で `ai_daily_limits`・`ai_plan_feature_caps` (§6.5) | 冒頭の注だけ変える (§16.1 の「free = 10 の文」の行)。結果の読み取り (`parseConsumeAiUsageResult` の `plan_locked`) は `supabase/functions/_shared/ai-daily-limit.ts` の全文の置き換え (§8.8) | free は 1 日 3 回で 4 回目が 429、機能ごとの上限が 0 の機能は 403 `AI_FEATURE_NOT_IN_PLAN` (§8.8) |

自動の料理画像を作る料理 (Q-16。行 = 献立の料理の並びと料理の状態、列 = 消費経路。どの入口 (料理の保存・更新の 4 本の route・AI 相談の料理の更新・献立の作成 (Edge の `save-meal`)) も `reconcileDishImages` の最後の絞り込みを通るので同じ答え。献立の作成の作り直しで違うのは写真・商品・手の画像の料理の扱いだけ (下の「AI の作り直し」の行と §7.3 の「作り直し」の行)。プランで分けない (無料は上の行のとおり、積んだ主菜の 1 本も門が止める)):

| 献立の形 (保存のとき) | 種 (`reconcileDishImages` の `jobs`) | 自動の料理画像を作る料理 (`autoImageDishIndexOf`) | ほかの料理の画像の状態 | 料理の保存の `meal_image_auto` の 1 回 (route と AI 相談) | 料理の画面 (Web の `RecipeModal`。`mealCoverRepresentsDish`。§10.3) | 積み直しの道具 (`planDishImageJobs`) |
|---|---|---|---|---|---|---|
| 主菜 1 品とほかの料理 (AI の献立の形。主菜・副菜・汁物・ご飯)。どれも新しい料理 | 主菜の 1 本 | 役割が `main` / `主菜` の料理 (位置は問わない) | 画像の無い状態 (状態・source・subject_hash なし) | 1 回 (種が 1 本) | 主菜: 自分の画像 (できるまではカバー。カバーも無ければ「生成中」の枠) / ほか: 枠なし (カバー = 主菜の画像を出さない) | 待ちの主菜だけ積む |
| 主菜の無い献立 (ご飯と汁物・`other` だけ・役割の無い料理だけ) | 先頭の料理の 1 本 | 先頭の料理 (`AUTO_IMAGE_FALLBACK_DISH_INDEX`) | 画像の無い状態 | 1 回 | 先頭: 自分の画像かカバー / ほか: 枠なし | 待ちの先頭の料理だけ |
| 主菜が 2 品以上 (手で作った献立) | 最初の主菜の 1 本 | 最初の主菜 | 2 品目以降の主菜も画像の無い状態 | 1 回 | 最初の主菜: 自分の画像かカバー / ほか: 枠なし | 最初の主菜だけ |
| 料理が 1 品 | その料理の 1 本 | その料理 | — | 1 回 | 自分の画像かカバー (1 品の献立はいつもカバーを出す) | その料理 |
| 主菜は同じ料理で画像あり (`ready`)、ほかの料理だけを足した・変えた | 0 本 | (主菜は積み直さない) | 足した・変えた料理は画像の無い状態。変えていない料理は前のまま | 数えない (種が 0 なので `consumeAiUsage` を呼ばない。F26) | 主菜: 自分の画像 / ほか: 前の画像があればそれ、無ければ枠なし | — |
| 主菜の中身を変えた (主菜の前の画像は外れる) | 主菜の 1 本 (`stale`) | 主菜 | 前のまま | 1 回 | 主菜: できるまではカバー (前の主菜の AI の画像だったカバーは、ほかの料理にできあがった画像が無ければ `deriveMealCoverImage` が空にする) | — |
| 主菜を消した・主菜の役割を外した (主菜の位置が、もとからその位置にある変わらない料理へ移る。例: ご飯・主菜の献立から主菜を消す、主菜が 2 品の献立で最初の主菜を副菜にする。S42) | 移った先の料理が画像の無い状態なら、その料理の 1 本 (`pending`。主菜の引き継ぎ `autoImageDishHandoverIndexOf`)。移った先が画像を持つ・写真・商品・手の画像なら 0 本、待ち・止まった料理なら積み直しの 1 本 | 移った先の料理 (主菜の無い献立になったなら先頭) | 前のまま (役割を外した前の主菜は画像の無い状態・前の画像は外れる) | 1 回 (種が 1 本のとき。0 本なら数えない) | 新しい主菜: できるまでは「生成中」の枠 (前の主菜の AI の画像だったカバーは、ほかにできあがった画像が無ければ `deriveMealCoverImage` が空にする) / ほか: 枠なし | — |
| 写真の献立 (料理ごとの画像なし・カバーは写真。`meal_photo` の `stale`) に料理を足した・変えた | 0 本 (いまの規則: カバーに頼る写真の料理があれば積まない。`isMealCoverHeldByImagelessPreservedDish`) | — | 足した料理は状態なし (いまのまま) | 数えない | 写真の料理: カバー (写真。source が `meal_photo`) / 足した料理: 主菜 (自動の料理画像の位置) ならカバー、ほかは枠なし | 積まない (`meal_cover_preserved`) |
| 写真の料理 1 品 (自分の写真あり) か商品の料理 (`catalog`・役割 `main`) に料理を足した | 0 本 (主菜は写真・商品の料理で画像を持つ。足した料理は主菜でないので絞り込みで落ちる。v1.7 までは足した料理に積んだ) | 写真・商品の料理 (積まない) | 足した料理は画像の無い状態 | 数えない | 写真・商品の料理: 自分の画像 / 足した料理: 枠なし | — |
| AI の作り直し (`save-meal` の `regeneration`) で料理が変わった写真の献立 | 主菜 (主菜が無ければ先頭) の 1 本 (写真の料理を AI の画像に回すのも主菜だけ) | 主菜 | 画像の無い状態 (写真の印も外れる) | (献立の作成は数えない。F22) | 主菜: できるまでは空のカバー (写真のカバーは外す。#1553) / ほか: 枠なし | — |
| 段 B の前に作られた献立で、主菜でない料理が AI の画像を持つ (`ready`) まま同じ料理で保存し直す | 0 本 (その料理は積み直さない) | — | その料理は画像を保つ (消さない) | 数えない (ほかに種が無ければ) | その料理: 自分の画像 | — |
| 段 B の前に作られた献立で、主菜でない料理が画像を待つ (`pending` / `stale` / `failed`・画像なし) | 0 本 (積み直そうとした種が絞り込みで落ちる) | — | 保存し直しで画像の無い状態になる (以後は積み直さない) | 数えない (ほかに種が無ければ) | 保存し直すまでは「生成中」などの枠 (いまの文)、保存し直したあとは枠なし | 積まない (`not_auto_image_dish`) |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main `4b1e1abe`) | 設計後 |
|---|---|---|
| `subscription_plans` の 3 行 | `Pro` 980 / 9,800、`Family Basic` 1,480 / 14,800、`Family Pro` 2,480 / 24,800 (試用 7) | `個人 Pro` 580 / 5,800、`家族 Basic` 980 / 9,800 (4 人)、`家族 Pro` 1,480 / 14,800 (8 人) (試用 7) |
| `/pricing` | 買えるプランが 0 件 (本番は常に 0 件) → フリーのカードだけ。見出しの下に「現在は無料でご利用いただけます。」、金額の横に「現在は無料」、FAQ「現在、料金はかかりますか？」(F2) | 公開の 3 プランのカード (価格・体験・内容) とフリーのカード。CTA は買える間隔だけ。見出しの下の段落・「現在は無料」・FAQ の節は置かない (§10.1)。フリーのカードの一覧と注記は `@homegohan/shared` の `FREE_PLAN_FEATURES`・`FREE_PLAN_AI_LIMIT_NOTE` |
| `/legal` | 販売事業者・代表者・所在地・電話番号・メールアドレス・営業時間・お問い合わせ・動作環境の 8 行。販売の項目は出さない (F2) | 8 行のうちお問い合わせの後に販売の 9 行 (販売価格・商品代金以外の必要料金・支払方法・支払時期・サービス提供時期・返品・キャンセル・解約について・定期購入について・無料体験について) を足し、販売の内容を書く。会社情報の 6 行と電話番号は #1911 のまま (§10.2) |
| `/company` | 会社情報 (#1911 で入った。F2) | 変えない |
| `/faq` 料金 | 「現在、料金はかかりますか？」(「現在ご提供している機能は無料でご利用いただけます。…」) と「返金はできますか？」 | 「料金はかかりますか？」(無料プランの範囲と回数の上限・有料で増えるもの)・「有料プランはありますか？」(3 プランの価格)・「返金はできますか？」(ストアの返金を足す)・「有料プランを解約するには？」(§10.5) |
| 紹介ページ (`landing-copy.ts`) | 料金の章「いまは、無料で使えます。」+ 無料のカード 1 枚 (`items` に「家族で使う」。`PlanCardSchema` は `free` の 1 枚)、要点と FAQ「いまはすべて無料です。」、家族の章と FAQ に契約の条件なし、`ASSURANCES`「いまは無料で使えます」 (F20) | 料金の章は無料のカード (家族なし) と有料のカード (3 プランの価格の行)。`PlanCardSchema` を `free` と `paid` の 2 枚に戻し、`marketing.css` にカード 2 列と `.lp-pill--paid` を戻す。要点と FAQ は無料プランの範囲と `PAID_PLAN_SUMMARY`、家族の 4 か所に「家族プラン」、`ASSURANCES`「無料で始められます」(§10.5 の表) |
| サイトの説明 (`SITE_DESCRIPTION`) | 「…いまは無料で使えます。」 | 「…無料で始められます。」(§10.5) |
| `EXT_STRIPE_NOT_CONFIGURED` の文 | 「お支払いを受け付けていません」(#1911。`src/lib/billing/core.ts:241`) | 変えない |
| AI の 1 日の上限 | 全員 10 (free の行だけ。組織の利用者も、組織の plan に行が無いので free の 10) | free 3 / pro 30 / family_basic 30 / family_pro 50 (Q-2 の確定値)。組織の利用者は 10 のまま (組織の plan の値に、適用の前の free の値の行を写す。§6.5 (5a)) |
| 究極モード | 全員 1 日 1 回 (環境変数) | free 0 (錠)・pro 2・family_basic 2・family_pro 3 (`ai_plan_feature_caps`)。行の無いプラン (組織の plan (`standard`・`org_*`) など) は環境変数の既定 (いまと同じ) |
| 料理画像の作成 (`POST /api/ai/image/generate`) | 全員 (上限の中) | free は 403 `AI_FEATURE_NOT_IN_PLAN`、有料は上限の中 |
| 料理の保存の自動の料理画像 (`meal_image_auto`) | 全員 (安全弁 1 日 20 回。達したら画像だけ見送り `skipped_ai_limit` + `aiSkipped`)。保存した料理ごとに 1 枚 | free は作らない (主菜は `skipped_plan`・`aiSkipped` なし・主菜の料理の画面は有料プランの案内)。有料は献立の主菜の 1 品だけ (Q-16。安全弁は従来どおり。ほかの料理だけを変えた保存は数えない) |
| 献立の作成が作る料理画像 | 全員 (作った料理ごと。数えない) | 各食の主菜の 1 品だけ積む (Q-16。主菜の無い献立は先頭の料理)。free は作らない (`process-meal-image-jobs` が主菜のジョブを取り消し、主菜を `skipped_plan` に)。有料は主菜の画像を作る |
| 主菜でない料理の画像 | 作った料理ごとに AI の画像 (できるまでは「生成中」の枠) | 画像を持たない (状態なし)。段 B の前に作られた画像は、同じ料理のままなら残す (S41) |
| 主菜を消した・主菜の役割を外した保存 (残った料理は変えない) | 残った料理はそれぞれの画像を持つので、献立の見た目は残る (種は作らない) | 主菜の位置が移った先の料理が画像の無い状態なら、その料理の 1 本を積む (主菜の引き継ぎ `autoImageDishHandoverIndexOf`。route と AI 相談は 1 回数える。S42)。画像を持つ・写真・商品・手の画像の料理なら積まない |
| AI の作り直し (`save-meal` の `regeneration`) で料理が変わった写真・商品・手の画像の献立 (前回の献立が商品の献立でない) | 中身の変わった写真・商品・手の画像の料理と、中身が同じで自分の画像の無い写真・商品・手の画像の料理を、どれも AI の画像の料理にして積む (#1553) | 主菜 (主菜が無ければ先頭) の 1 本だけ積み、ほかの写真・商品・手の画像の料理は画像の無い状態 (写真の印も外れる)。中身が同じで自分の画像を持つ料理は残す (§7.3 の「作り直し」の行) |
| 料理の画面 (Web の献立の画面の `RecipeModal`) で、自分の画像の無い料理 | 献立のカバーを代わりに出す (`dish.image_url ?? meal.imageUrl`。F26) | 1 品の献立・自動の料理画像の料理 (主菜)・写真・商品・手の画像の料理だけカバーを出し、ほかの料理は出さない (枠なし。`mealCoverRepresentsDish`。§10.3) |
| 積み直しの道具 (`scripts/requeue-pending-meal-images.ts`) | 待ちの料理をすべて積み直す | 主菜 (自動の料理画像の料理) の待ちだけ積み直し、ほかは `not_auto_image_dish` で数える |
| テストの購入 (sandbox) | (ストアの購入が無い) | 本番でも本物の購入と同じに写し、`iap_is_sandbox = true` (Q-13) |
| ストアの猶予期間 (grace period) | (ストアの購入が無い) | `grace_period_expires_date` > now の間は `past_due` (権利は続く。P13) |
| 献立の作成と作り直し (`menu_generation`。F23 の入口すべて) | 全員 (1 日の合計の中) | free 3 / pro 10 / family_basic 10 / family_pro 15 (1 日) |
| 家族グループの作成・メンバーの追加 | 誰でも (グループは `free` / 4) | 家族プランの契約者だけ (`FAMILY_PLAN_REQUIRED`) |
| ストアの購入 | 無い (アプリは料金の画面も無い) | アプリの「プランとお支払い」で App Store / Google Play の購入・復元・管理 |
| 退会の確認の文 | 取り消しができないことだけ (Web の設定・凍結中と同意の前の退会の共通の部品・アプリの設定のアカウント)。規約の同意の画面の「登録をやめる」は案内の文だけ | 4 つの入口すべてに `STORE_SUBSCRIPTION_DELETION_NOTICE` (ストアの購読は退会で解約されない)。アプリの確認のボタンは「キャンセル」「定期購読の管理を開く」「削除」(§10.4) |
| ストアの契約の写し | 無い | `personal_subscriptions` の I 行 (`iap_store` / `iap_product_id` / `iap_synced_at`) |
| App Store の同じグループの中のプランの変更 (上位への変更・体験中の変更) | (ストアの購入が無い) | 取り直しに 2 つの商品が live で並べば、`purchase_date` の新しい方を権利にし、古い方の I 行を `expired` (監査の `details.source` に `:superseded`) にする。`BILL_LIVE_ROW_CONFLICT` にしない (§7.3・S36)。グループの中のレベルは家族 Pro > 家族 Basic > 個人 Pro (§17.2) |
| RevenueCat の Webhook | 無い | `POST /api/webhooks/revenuecat` (署名・claim・取り直し・写像) |
| `BillingSummary.source` | `'stripe' / 'manual' / null` | `'stripe' / 'manual' / 'app_store' / 'play_store' / null` + `manage_in_store` + `features` |
| 手動付与の M 行の述語 | `stripe_subscription_id IS NULL` | `stripe_subscription_id IS NULL AND iap_store IS NULL` |
| 無料体験の 1 人 1 回 (R14・Q-10) | Web だけ: 同じ `plan_key` で `trial_started_at` のある行 (S 行) があれば Checkout に試用を付けない (`hasUsedTrial`。`src/lib/billing/repository.ts:72-80`) | Web の規則は同じ (コードは変えない)。I 行の `trial_started_at` も同じ問い合わせに入るので、ストアで試用した利用者は Web で同じプランの試用を受けない (S23)。ストアの試用はストアの判定 (Apple ID / Google アカウントごと)。Web で試用した利用者のストアの試用は止めない (§18 の 5) |
| 規約・ポリシーの版と本文 | `v2026.2` (cross/20 の実装で作り込んだ本文に、#1917 が退会の条件 (利用規約第11条 4 項・第12条 4 項・第17条 2 項・プライバシーポリシー第13条 9 項) を改めた版。有料の条文なし。origin/main `465727de`。`2ba5b3b3` では `v2026.1`、`4b1e1abe` では `v2025.1` の旧い本文。F14) | `v2026.3`。cross/20 の本文に有料の条文の項目を足し、2 つの文 (第11条 1 項・第16条 2 項) を直す (§11) |
| billing/01 §10.4 の規則 (アプリ内課金をしない) | アプリに購入の画面を置かない | アプリ内課金の購入の画面を置く。Web の購入のページへのリンクは引き続き出さない (§16.2) |

### 7.3 状態遷移表 (I 行: 状態 × 出来事 → 遷移先・ガード・副作用)

取り直した `subscriptions[<product_id>]` から状態を決める規則 (`deriveStoreStatus`。§8.1): `refunded_at` あり → `cancelled` / `expires_date` が無い → `active` / `expires_date` > now → (`billing_issues_detected_at` あり → `past_due`、`period_type` が `trial` → `trialing`、それ以外 → `active`) / `expires_date` ≤ now かつ `grace_period_expires_date` > now → `past_due` (ストアの猶予期間。P13) / それ以外 (`expires_date` ≤ now で猶予が無いか尽きた) → `expired`。`cancel_at_period_end` = `unsubscribe_detected_at` あり。イベントの種類は遷移を決めない (すべて取り直しの合図)。同じ取り直しに App Store の商品が 2 つ以上 live で並ぶとき (本冊の 6 商品は 1 つの Subscription Group。§17.2) は、`compareStoreSubscriptionRecency` で最も新しい 1 つだけを上の規則で写し、ほかは置き換えられた購読として `expired` (`expires_date` = 新しい購読の `purchase_date`・`cancel_at_period_end = false`) で先に写す (`selectStoreSubscriptions` の `supersededAt`。下の「同じグループの 2 つの live」の行)。Google Play はこの規則を当てない (`SUPERSEDE_WITHIN_GROUP_STORES`)。

| 現在 | 出来事 (RevenueCat の合図・本人の操作) | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| – (行なし) | `INITIAL_PURCHASE` / 同期 (期間内・trial) | `trialing` | 別の live 行なし・商品の対応の行あり | INSERT・`plan_key_cached`・家族グループ・監査 `subscription_created` (info)・`trial_started_at` / `trial_ends_at` / `trial_source`。最初の取り直しで `unsubscribe_detected_at` があれば `cancel_at_period_end = true`・`cancel_at = expires_date` も INSERT に入れる (§6.4 の 6.) |
| – | 同上 (期間内・normal / intro) | `active` | 同上 | INSERT・`plan_key_cached`・家族グループ・監査 `subscription_created` (info)。`unsubscribe_detected_at` があれば `cancel_at_period_end = true`・`cancel_at = expires_date` |
| – | 同上 (最初の取り直しで `billing_issues_detected_at` があり期間内、または `expires_date` ≤ now で `grace_period_expires_date` > now。`INITIAL_PURCHASE` の Webhook が届かず、最初の同期が `BILLING_ISSUE` の後になったとき) | `past_due` | 同上 | INSERT・`past_due_since = now()`・`plan_key_cached`・家族グループ (権利は続く)・監査 `subscription_created` (severity **warn**)。`unsubscribe_detected_at` があれば `cancel_at_period_end = true`・`cancel_at = expires_date` |
| – | 同上だが別の live 行あり (S / M / 別のストアの I / 同じ Google Play の別の商品の I) | – | — | `BILL_LIVE_ROW_CONFLICT` → Webhook `failed` + 監査 `system.revenuecat.event_failed` (warn) / 同期 409 (S13・S25)。同じ App Store の別の商品の I 行は、取り直しにその商品も live で並んでいれば下の「同じグループの 2 つの live」の行で先に `expired` になるので、ここには来ない |
| – | 取り直したが `subscriptions` に当社の商品が無い (購入していない・別の app_user_id) | – | — | 何もしない (`no_subscription: true` を TS が返す。§8.4) |
| – | 取り直した live な商品 (trialing / active / past_due) が `plan_store_products` に無い | – | 利用者の行が無い (`unmappedStoreSubscriptionDecision` = `reject`) | `BILL_IAP_UNKNOWN_PRODUCT` → Webhook `failed` / 同期 422 (S15)。運営が行を足すと次の同期で上の行のとおり INSERT |
| – | 取り直した live でない商品 (expired / cancelled) が `plan_store_products` に無い | – | 利用者の行が無い (`skip`) | 何もしない (`skipped_unknown` + 1。履歴の行を作らない。S28) |
| – | 取り直した姿が期限切れ・返金済み (履歴) で、商品の対応の行がある | `expired` / `cancelled` | — | INSERT (履歴の行。live でないので `plan_key_cached` は変わらない。監査 `subscription_created` (info)) |
| 任意 (行あり) | 取り直した商品が `plan_store_products` に無い (運営が行を消した・古い商品 ID) | 取り直しの姿のとおり (下の各行) | 利用者の行がある (`apply`) | snapshot の `plan_key` と `billing_interval` は null → 写像の 4. が行の `plan_key` を使い、UPDATE は `billing_interval` を保つ (§6.4)。S28 |
| `trialing` | `RENEWAL` (試用 → 課金) | `active` | 取り直しが新しい | UPDATE・監査 `status_changed` |
| `trialing` / `active` | `CANCELLATION` (`UNSUBSCRIBE`。自動更新 OFF) | 同じ | 同上 | `cancel_at_period_end=true`・`cancel_at=expires_date` (監査なし) |
| `trialing` / `active` | `UNCANCELLATION` | 同じ | 同上 | `cancel_at_period_end=false`・`cancel_at=NULL` |
| `past_due` | `CANCELLATION` (`UNSUBSCRIBE`。猶予の間に自動更新 OFF) | `past_due` | 取り直しが新しい・`expires_date` > now (`billing_issues_detected_at` が先に効く。`deriveStoreStatus`) | `cancel_at_period_end=true`・`cancel_at=expires_date`・`past_due_since` は保つ (状態は変わらないので監査なし)。猶予が尽きたら下の `EXPIRATION` の行 |
| `past_due` | `UNCANCELLATION` | `past_due` | 同上 | `cancel_at_period_end=false`・`cancel_at=NULL` (監査なし) |
| `trialing` / `active` | `RENEWAL` (更新) | `active` | 同上 | `current_period_end` が進む |
| `trialing` / `active` | `BILLING_ISSUE` (猶予の間) | `past_due` | `expires_date` > now、または `expires_date` ≤ now かつ `grace_period_expires_date` > now | `past_due_since`・監査 (warn) |
| `past_due` | 猶予の間に `expires_date` を過ぎた (取り直し・遅延の再同期) | `past_due` | `grace_period_expires_date` > now | `current_period_end` = `expires_date` (過ぎている) なので、`GET /api/billing/subscription` が読むたびに 5 分おきに取り直す (`needsLazyResync`)。状態は変わらないので監査なし。権利は続く |
| `past_due` | `RENEWAL` (回復) | `active` | 同上 | `past_due_since=NULL`・監査 |
| `trialing` / `active` / `past_due` | `EXPIRATION` (期間末・猶予の終わり・Google の一時停止) か、猶予の尽きたあとの取り直し | `expired` | `expires_date` ≤ now かつ (`grace_period_expires_date` が無いか ≤ now) | `plan_key_cached` を再計算 (NULL)・家族グループ `free` / 4・監査 |
| `trialing` / `active` / `past_due` | `CANCELLATION` (`CUSTOMER_SUPPORT` = 返金) | `cancelled` | `refunded_at` あり | `cancelled_at=refunded_at`・同上 |
| `expired` / `cancelled` | どの合図でも (`INITIAL_PURCHASE`・`RENEWAL`・`CANCELLATION`・`UNCANCELLATION`・`BILLING_ISSUE`・`EXPIRATION`・`PRODUCT_CHANGE`・`TRANSFER` と同期の API。順の入れ替わりで遅れて届いた合図を含む) — **規則の行**: 遷移先は合図の種類でなく取り直しの姿 (`deriveStoreStatus`) で決まり、下の 5 行のどれかに当たる。遅延の再同期は live でない行を取り直さない (`findLiveSubscription` が返さない。§7.1) | 取り直しの姿 (下の 5 行) | 取り直しが新しい (`iap_synced_at` < `p_fetched_at`。古ければ下の「取り直しが古い」の行) | 下の 5 行 |
| `expired` | 取り直しも期限切れのまま (`expires_date` ≤ now・猶予が無いか尽きた・`refunded_at` なし)。遅れて届いた `CANCELLATION` (`UNSUBSCRIBE`)・`UNCANCELLATION`・`BILLING_ISSUE`・`EXPIRATION`、この商品から別の商品への `PRODUCT_CHANGE` など | `expired` (同じ) | 取り直しが新しい | UPDATE (`current_period_end` と `cancel_at_period_end` / `cancel_at` を取り直しの姿に・`iap_synced_at` が進む)。状態は変わらないので監査なし。live でないので `plan_key_cached` は変わらず、家族グループも変わらない (§6.4 の 7. の live でない枝は、同じ `plan_key` の live 行が無くグループがまだその `plan_key` のときだけ `free` / 4 に書く) |
| `cancelled` | 取り直しも返金済み (`refunded_at` あり)。遅れて届いたどの合図も | `cancelled` (同じ) | 同上 | UPDATE (`cancelled_at` = `refunded_at`・ほかは上の行と同じ)。監査なし・`plan_key_cached` と家族グループは変わらない |
| `expired` | 取り直しが返金済み (期限の後に `CANCELLATION` (`CUSTOMER_SUPPORT` = 返金) が届いた) | `cancelled` | `refunded_at` あり | `cancelled_at` = `refunded_at`・監査 `subscription_status_changed` (info)。どちらの状態も live でないので `plan_key_cached` と家族グループは変わらない |
| `expired` / `cancelled` | 取り直しの姿が live (同じ商品を買い直した (`INITIAL_PURCHASE` / `RENEWAL`)・ストアの請求の再試行が回復した (`RENEWAL`)・`BILLING_ISSUE` の後の取り直しに猶予 (`grace_period_expires_date` > now) が見えた)。`cancelled` からは取り直しに `refunded_at` が無いときだけ (`deriveStoreStatus` は `refunded_at` を最初に見る) | `trialing` / `active` / `past_due` (`deriveStoreStatus`) | 別の live 行なし (写像の 5.。あれば `BILL_LIVE_ROW_CONFLICT` → Webhook `failed` + 監査 `system.revenuecat.event_failed` (warn) / 同期 409。上の「– (行なし)」の衝突の行と同じ) | UPDATE (同じ (user, store, product) の行を再利用。`trial_started_at` は最初の値を保つ)・`plan_key_cached` = この行の `plan_key`・家族グループ (live の枝)・監査 `subscription_status_changed` (`past_due` なら warn で `past_due_since = now()`) |
| `expired` / `cancelled` (商品 A) | `PRODUCT_CHANGE` (A から別の商品 B へ。A はもう live でない) | A: 取り直しの A の姿のとおり (live でなければ上の「同じ」の 2 行、live なら上の行) / B: 上の「– (行なし)」の規則 (B の行があれば B の今の状態の行) | B が live なら別の live 行なし (A は live でないので衝突しない。A と B が両方 live に見える App Store の取り直しは下の「同じグループの 2 つの live」の行) | TS の写す順 (live でないものが先、次に `expires_date` の早い順。§8.1 `selectStoreSubscriptions`) で A を写してから B を写す |
| `active` (月額) | `PRODUCT_CHANGE` (年額へ。App Store の同じレベルで期間の違う crossgrade なので期間の終わりに効く。P18) | 月額の行は期限で `expired`、年額の商品は新しい行 | 取り直しで月額がまだ live に見えれば、下の「同じグループの 2 つの live」の行 (`purchase_date` の新しい年額が権利・月額は置き換えられて `expired`) | 取り直しの `subscriptions` には両方の商品が入る。TS は live でないものを先に、次に `expires_date` の早い順に写し (§8.1 `selectStoreSubscriptions`・§8.4)、月額の行が先に `expired` になってから年額を INSERT する (同じ取り直しの中で順に適用) |
| `trialing` (月額) | `PRODUCT_CHANGE` (年額へ) | 上の `active` (月額) の行と同じ (月額の行は取り直しで期限を過ぎた時点で `expired`、年額の商品は新しい行) | 同上 | 順は上の行と同じ。年額の行の status は年額の取り直しの `period_type` で決まる (`trial` なら `trialing`、それ以外は `active`。§8.1 `deriveStoreStatus`)。月額の行の `trial_started_at` は保つので、Web の同じ `plan_key` の試用は付かない (S23) |
| `past_due` (月額) | `PRODUCT_CHANGE` (年額へ) | 月額の行は、年額が取り直しに live で現れるまでは取り直しの姿のまま (`past_due`。回復しなければ `EXPIRATION` で `expired`)。年額が live で現れたら年額は新しい行、月額は置き換えられて `expired` | 同上 (年額と月額が両方 live なら下の「同じグループの 2 つの live」の行) | 順は上の行と同じ (live でないもの・置き換えられたものが先、次に `expires_date` の早い順) |
| `trialing` / `active` / `past_due` (App Store の商品 A) | 同じグループの別の商品 B への変更が効いた (上位への変更・期間が同じ crossgrade はすぐ、体験中の上位への変更は A の体験を残したまま。P18)。取り直しの `subscriptions` に A と B が両方 live で並ぶ (S36) | A: `expired` / B: 上の「– (行なし)」の規則 (B の行があれば取り直しの姿のとおり) | ストアが `app_store` (`SUPERSEDE_WITHIN_GROUP_STORES`)・A と B が両方 live (`deriveStoreStatus`)・B が `compareStoreSubscriptionRecency` で新しい (`purchase_date` の新しい方。同じなら `expires_date` の遅い方、それも同じなら `product_id` の辞書順で後ろ) | `selectStoreSubscriptions` が A に `supersededAt` = B の `purchase_date` を付けて先に並べる → A を `expired` で UPDATE (`current_period_end` = B の `purchase_date`・`cancel_at_period_end = false`・`cancel_at = NULL`・`trial_started_at` は保つ。`p_source` は `<source>:superseded` なので監査 `subscription_status_changed` の `details.source` で見分けられる) → B を写す (A が live でないので写像の 5. は衝突しない)。`plan_key_cached` は B の `plan_key`。A と B の家族プランの違いは写像の 7. のとおり (A が家族プランならグループは一度 `free` / 4、B が家族プランなら B の値)。以後の取り直しで A がまだ live に見えても同じ snapshot (状態は同じなので監査なし)。A の行がまだ無い (A を写す前に変えた) ときは A を `expired` の履歴の行として INSERT し、`trial_started_at` は入らない (Web の試用の 1 回の数えに入らない。§18 の 24)。対応の行も利用者の行も無い A は `unmappedStoreSubscriptionDecision` が `skip` (権利にしないので履歴の行を作らない) |
| `trialing` / `active` / `past_due` (Google Play の商品 A) | 同じ Google Play の別の商品 B も live (二重購読。Google Play の置き換えは当社のアプリの購入の流れからしか始まらず (P18)、当社のアプリは契約中は購入のカードを出さない。§10.6) | A: 同じ / B: 作らない | — | 写像の 5. が `BILL_LIVE_ROW_CONFLICT` (S25。§13.3 の Google Play の行で運営が返金) |
| 任意 | `TRANSFER` (別の利用者へ移った) | 移動元: `expired` (取り直しの `subscriptions` から消える・または期限切れ) / 移動先: 上の「– (行なし)」の規則 | 移動先に別の live 行があれば `BILL_LIVE_ROW_CONFLICT` | 両方の利用者を取り直す (§8.4)。移動元が `subscriptions` に商品を持たなくなったときは、移動元の live な I 行を `expired` にする (TS が `expires_date=now` の snapshot を作る。§8.1 `projectMissingSubscription`。行の `iap_is_sandbox` と `billing_interval` は snapshot に引き継いで保つ) |
| 任意 | 取り直しが古い (`iap_synced_at` ≥ `p_fetched_at`) | 同じ | — | `skipped: 'stale'` |
| 任意 | 退会 (`user_deleted`) | 行は CASCADE で消える | — | 以後の Webhook は `skipped: 'user_deleted'`・200 |
| 任意 | 凍結 (BAN) | 同じ | — | 写像は凍結を見ない。Webhook と遅延の再同期は写し続け、カタログと同期の API は 403 `AUTH_ACCOUNT_FROZEN` で写像の前に止まる (S22) |
| `trialing` / `active` / `past_due` | 取り直しが RevenueCat の失敗 (2xx 以外・形の違い・時間切れ・接続の失敗) | 同じ | — | 写像を呼ばない。同期の API は 502 `EXT_REVENUECAT_API_FAILED`・Webhook は 500 + `failed` (RevenueCat が再送)・遅延の再同期は飲み込む (S30) |

同じ利用者の S 行・M 行の遷移は billing/01 §7.3・billing/02 §7.3 のまま (I 行があるときの「別の live 行あり」の枝が増えるだけ)。

料理の画像の状態の遷移 (自動の料理画像。Q-16。状態の記号: **無** = その位置に料理が無い (新しい料理)・**N** = 画像の無い状態 (`image_source`・`image_status`・`image_subject_hash`・`image_url` が null)・**P** = AI の画像を待つ (`generated_ai`・`pending` / `stale`・画像なし・subject_hash あり)・**R** = AI の画像あり (`generated_ai`・`ready`)・**F** = 待ちで止まった (`generated_ai`・`failed`・画像なし。`skipped_*`・`enqueue_failed`・同意の理由)・**K** = 写真・商品・手の画像 (`meal_photo` / `catalog` / `manual_override`)。出来事の「保存」は料理の保存・更新の 4 本の route・AI 相談の料理の更新・献立の作成 (Edge の `save-meal`) のどれでも同じ (`reconcileDishImages`)。ただし K の料理だけは、献立の作成が既存の献立の行に作り直す保存 (`save-meal` はいつも `regeneration: true` を渡し (`save-meal.ts:624-627`)、前回の料理があるときに効く) で、前回の献立が商品の献立でなく (`previousMealIsCatalog` が偽)、料理が変わった (前回と料理の数が違う・中身が変わった料理がある。`mealDishesChanged`) ときを出来事「作り直し」として別の行にする (#1553 の `releasePreviousDishImage` が中身の変わった K の料理を、`releaseOnRegeneration` の for が中身の同じ自分の画像の無い K の料理 (`isImagelessCoverReadyDish`) を種にし、最後の絞り込み (§8.8 の (b)) が主菜の 1 本だけを残す)。K の行の出来事「保存」は作り直しを除く。N・P・F・R の料理は作り直しでも「保存」の行のとおり (作り直しが変えるのは K の料理と献立のカバーだけ)。「主菜」= 保存する献立の `autoImageDishIndexOf` の位置の料理 (主菜の無い献立は先頭)。「主菜でない → 主菜」は、前回の献立では主菜の位置でなかった料理が、この保存で主菜の位置になる行。「主菜 → 主菜でない」はその逆):

| 位置 | 現在 | 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|---|
| 主菜 | 無 | 保存 (新しい料理) | P (`pending`) | 写真・商品・手の画像として送られていない (`preserveSubmittedDishImages`)・献立のカバーが写真・商品の料理のものでない (`isMealCoverHeldByImagelessPreservedDish` が偽) | 種 1 本。有料: 積む (route と AI 相談は `meal_image_auto` を 1 回)。無料: route と AI 相談は積まずに F (`skipped_plan`)、献立の作成は積んで処理の門で F (`skipped_plan`) |
| 主菜 | R | 中身を変えた保存 | P (`stale`) | 同上 | 種 1 本 (同上)。前の画像は外れる |
| 主菜 | R | 同じ料理の保存 | R | — | なし |
| 主菜 | P / F | 同じ料理の保存 | P (`pending`) | `needsImageRetry` が真・`isAiImagePipelineDish` が真 | 種 1 本 (積み直し。同上) |
| 主菜 | P | 画像の処理 (有料・同意あり) | R | ジョブの subject_hash = 料理の subject_hash | カバーが空か AI の料理の画像なら、カバーも主菜の画像に (`applyGeneratedDishImage`) |
| 主菜 | P | 画像の処理 (`ai_plan_feature_daily_cap` = 0) | F (`skipped_plan`) | 同意の判定の後 | ジョブ `cancelled` (§8.8) |
| 主菜 | P | 画像の処理 (同意なし) | F (同意の理由) | — | ジョブ `cancelled` (いまのまま) |
| 主菜 | K | 保存 (作り直しを除く) | K (手の画像は中身を変えると `stale`。いまの規則) | — | 種なし |
| 主菜 | N | 同じ料理の保存 (役割と並びも同じ。完了の切り替えなど) | N | `isAiImagePipelineDish` が偽・前回と今回の `autoImageDishIndexOf` が同じ (主菜の位置が移っていない) | なし (前回のまま写す。#1487 の「AI の画像の料理だと分からない料理を変えずに保存し直しても積まない」。本冊の前からある画像の無い料理・写真や商品の献立で積まなかった料理) |
| 主菜でない | 無 | 保存 (新しい料理) | N | — | 種を落とす (積まない。種がほかに無ければ数えない) |
| 主菜でない | R | 同じ料理の保存 | R | — | なし (段 B の前に作られた画像を残す。S41) |
| 主菜でない | R | 中身を変えた保存 | N | — | 種を落とす。前の画像は外れる |
| 主菜でない | P / F | 同じ料理の保存 | N | `needsImageRetry` が真 (積み直そうとした種を落とす) | なし (「生成中」のまま残さない。S41) |
| 主菜でない | P / F / N | 中身を変えた保存 | N | — | 種を落とす |
| 主菜でない | N | 同じ料理の保存 | N | `isAiImagePipelineDish` が偽 (subject_hash も source も無い)・この保存で料理が主菜にならない (なるときは下の「主菜でない → 主菜 (位置が移った先の、変わらない料理)」の行) | なし (前回のまま写す) |
| 主菜でない | P | 画像の処理 (段 B の前に積まれたジョブ) | R | ジョブの subject_hash = 料理の subject_hash | いまの規則のまま画像を書く (処理の門は主菜かを見ない。段 B の前の待ちのジョブだけ) |
| 主菜でない | K | 保存 (作り直しを除く) | K (いまの規則) | — | 種なし |
| 主菜でない → 主菜 | N / R / P | その料理の役割か位置が変わって主菜になる保存 (主菜の役割を付けた・前にある料理を消して位置が詰まり、新しい `autoImageDishIndexOf` の位置になった。役割と位置は subject_hash に入るので、中身が変わった扱い) | P (前の料理があれば `stale`、無ければ `pending`) | 新しい `autoImageDishIndexOf` の位置 | 種 1 本 (for の中の「中身を変えた」の種) |
| 主菜でない → 主菜 (位置が移った先の、変わらない料理) | N | 前の主菜を消した・前の主菜の役割を外した保存で、`autoImageDishIndexOf` の位置が、もとからその位置にある中身・役割・位置の変わらない料理へ移った (例: [ご飯 (位置 0・N)・主菜 (位置 1・R)] から主菜を消す / [副菜・主菜 1 (R)・主菜 2 (N)] で主菜 1 の役割を副菜にする。S42) | P (`pending`) | `autoImageDishHandoverIndexOf` が位置を返す (前回と今回の `autoImageDishIndexOf` が違う・その位置に種が無い・料理が N)・献立のカバーが写真・商品の料理のものでない (当たれば N に戻して積まない) | 種 1 本 (主菜の引き継ぎ。§8.8 の (b0))。route と AI 相談は `meal_image_auto` を 1 回 (無料は積まずに F (`skipped_plan`))。カバーは前の主菜の AI の画像だったので、ほかにできあがった画像が無ければ `deriveMealCoverImage` が空にし、新しい主菜の画像ができるとカバーになる |
| 主菜でない → 主菜 (位置が移った先の、変わらない料理) | R / K | 同上 | R / K (同じ) | 画像を持つ料理・写真・商品・手の画像の料理 (`autoImageDishHandoverIndexOf` が null)。作り直しの K の料理は下の「作り直し」の行 (自分の画像の無い K は P) | 種なし (カバーは `deriveMealCoverImage` の既存の規則) |
| 主菜でない → 主菜 (位置が移った先の、変わらない料理) | P / F | 同上 | P (`pending`) | `needsImageRetry` が真・`isAiImagePipelineDish` が真 (段 B の前の待ちの料理・無料で止めた料理) | 種 1 本 (for の中の積み直しの種。新しい位置なので最後の絞り込みで残る) |
| 主菜 → 主菜でない | R / P / F | 役割を変えた・前に別の主菜を足した保存 | N | — | 種を落とす。前の画像は外れる。主菜の位置が移った先の料理は、上の「主菜でない → 主菜」の行のどれか (変わらない N の料理なら主菜の引き継ぎで種 1 本) |
| 主菜 (この保存の `autoImageDishIndexOf` の位置。位置が移った先の料理を含む) | K (中身を変えた写真・商品・手の画像の料理) | 作り直し (`save-meal`・前回の献立が商品の献立でない・料理が変わった) | P (`stale`) | `releasePreviousDishImage` が真 (前回の料理があり、中身が変わった) | 種 1 本 (前の写真・手の画像は外れる。#1553)。献立の作成は数えない (F22)。有料は画像を作り、無料は処理の門で F (`skipped_plan`)。§16.1 の `tests/save-meal-photo-preserve.test.ts` の行の (1) と、変えない `:141`・`:221` の it |
| 主菜 (同上) | K (中身が同じで自分の画像の無い写真・商品・手の画像の料理。写真の複数の料理など) | 作り直し (同上) | P (`pending`) | `isImagelessCoverReadyDish` が真 (`releaseOnRegeneration` の for が種にする) | 種 1 本 (写真の印は外れる。数えないのと無料の扱いは上の行と同じ)。§16.1 の同じ行の (3) と、変えない `:196` の it |
| 主菜 (同上) | K (中身が同じで自分の画像を持つ) | 作り直し (同上) | K (同じ) | — | 種なし (いまの規則。変えない `:165` の it) |
| 主菜でない | K (中身を変えた写真・商品・手の画像の料理) | 作り直し (同上) | N | `releasePreviousDishImage` が真 | 種を落とす (`releasePreviousDishImage` で作った種を最後の絞り込みが落とし、`withoutAutoDishImage` で画像の無い状態にする)。写真の印と画像が外れる。§16.1 の同じ行の (1)・(3) の汁物 |
| 主菜でない | K (中身が同じで自分の画像の無い写真・商品・手の画像の料理) | 作り直し (同上) | N | `isImagelessCoverReadyDish` が真 | 種を落とす (`releaseOnRegeneration` の for で作った種を最後の絞り込みが落とす)。写真の印が外れる。テスト 159 |
| 主菜でない | K (中身が同じで自分の画像を持つ) | 作り直し (同上) | K (同じ) | — | 種なし (いまの規則。最後の絞り込みは種の無い料理を触らない) |
| 待ちの料理 (積み直しの道具) | P (subject_hash あり) | `--apply` | 主菜: 積む / 主菜でない: 積まない | 待ち・画像なし・AI の画像・商品と写真のカバーの献立でない (いまの規則) | 主菜でないものは `skipped.not_auto_image_dish` + 1 |

---

## 8. 正典コード

### 8.0 置き場所と型検査

| ブロック | 置き場所 | 検査 |
|---|---|---|
| §8.1 `iap-core.ts` | `src/lib/billing/iap-core.ts` (新設) | 単独 (import は zod だけ) |
| §8.2 署名の確認 | `src/lib/webhook/verify.ts` に足す (import は足さない。同じファイルの `verifyStripeSignature`・`getOptionalEnv`・`WebhookSecretMissingError`・`WebhookVerification` を使う) | `insert=` (リポジトリ全体) |
| §8.3 `revenuecat-gateway.ts` / `iap-repository.ts` | `src/lib/billing/` (新設) | `place=` |
| §8.4 `iap-service.ts` | `src/lib/billing/iap-service.ts` (新設) | `place=` |
| §8.5 route 3 本 | `src/app/api/webhooks/revenuecat/route.ts`・`src/app/api/billing/iap/catalog/route.ts`・`src/app/api/billing/iap/sync/route.ts` (新設)、`src/app/api/billing/subscription/route.ts` (差分) | `place=` / `insert=` |
| §8.6 `public-plans.ts` (全文の置き換え)・`core.ts` の差分・`repository.ts` の差分 (`findPlanFeatures`) | 既存 | `place=` / `insert=` |
| §8.7 `env.ts` の差分 | 既存 | `insert=` |
| §8.8 `ai-daily-limit.ts` (全文の置き換え) | `supabase/functions/_shared/ai-daily-limit.ts` (Web・Edge・モバイル共用。import なし) | 単独 (import なし) |
| §8.8 `meal-image.ts` の差分 | `supabase/functions/_shared/meal-image.ts`・`lib/meal-image.ts` (再 export) | `insert=` |
| §8.8 料理画像のジョブの処理の門 | `supabase/functions/process-meal-image-jobs/index.ts` (Deno の Edge Function。差分 4 か所) | `insert=` (Edge Function の型検査の手順で) |
| §8.9 `billing-plans.ts` | `packages/shared/src/billing-plans.ts` (新設。`packages/shared/src/index.ts` に `export * from './billing-plans';`。Web とモバイルが `@homegohan/shared` から読む) | 単独 (import なし) |
| §8.10 モバイル | `apps/mobile/src/lib/purchases.ts`・`iap-catalog.ts`・`billing-api.ts`・`app/settings/plan.tsx` (新設) | `iap-catalog.ts` は単独 (import なし)。ほかは `place=` (apps/mobile の tsconfig で検査) |

手順は billing/01 §8.0 (印の付いたブロックを置き場所に置き、`npx tsc --noEmit` をリポジトリ全体に当てる。モバイルは `apps/mobile` で `npx tsc --noEmit`)。

### 8.1 `src/lib/billing/iap-core.ts` (正典。純)

```ts
/**
 * アプリ内課金 (billing/03) の定数・Zod・型・純関数・ポート。I/O を持たない (fetch / DB / env を読まない)。
 * import してよいのは zod だけ (tests/billing-iap-core.test.ts が見張る)。
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本冊が扱うストア (personal_subscriptions.iap_store / plan_store_products.store の CHECK と同じ 2 値)。
 * 画面が使う表示名と管理のページ (IAP_STORE_LABELS・STORE_SUBSCRIPTION_MANAGEMENT_URL) は packages/shared/src/billing-plans.ts
 * (Web とモバイルが読む)。その PURCHASE_STORES とこの一覧が同じことを tests/billing-iap-core.test.ts (テスト 95) が見る
 */
export const IAP_STORES = ['app_store', 'play_store'] as const;
export type IapStore = (typeof IAP_STORES)[number];
export function isIapStore(value: string): value is IapStore {
  return (IAP_STORES as readonly string[]).includes(value);
}
/** RevenueCat の customer info の subscriptions[].store の値 → 本冊のストア (それ以外 (promotional / stripe / amazon …) は扱わない) */
export const REVENUECAT_STORE_TO_IAP_STORE: Readonly<Record<string, IapStore>> = {
  app_store: 'app_store',
  play_store: 'play_store',
};

/** RevenueCat REST API v1 (GET /subscribers/{app_user_id}。認証は Authorization: Bearer <secret API key>) */
export const REVENUECAT_API_BASE_URL = 'https://api.revenuecat.com/v1';
/** Webhook の本文の api_version (RevenueCat は項目の追加を版を変えずに行うので、違う値は warn して処理を続ける) */
export const REVENUECAT_WEBHOOK_API_VERSION = '1.0';
/** 署名のヘッダー (小文字で読む)。形は `t=<unix 秒>,v1=<HMAC-SHA256 hex>`、署名の対象は `<t>.<生の本文>` */
export const REVENUECAT_SIGNATURE_HEADER = 'x-revenuecat-webhook-signature';
/** Webhook の本文の上限 (バイト)。イベントは数 KB (subscriber_attributes を含めても数十 KB)。Resend の受け口と同じ 256 KiB */
export const REVENUECAT_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** processing のままこの時間を過ぎたイベントは、再送で再び処理の権利を取れる (billing_claim_revenuecat_event の p_stuck_after。核と同じ値) */
export const REVENUECAT_EVENT_STUCK_MINUTES = 15;
/** Webhook の route の最長実行時間 (秒)。RevenueCat の取り直し (利用者 1〜2 人) + RPC が収まる値。route には同じ値をリテラルで書く (核と同じ理由) */
export const REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS = 30;
/** 1 回の RevenueCat API 呼び出しの上限 (ms)。maxDuration の中に取り直し 2 回 + RPC が収まる値 */
export const REVENUECAT_REQUEST_TIMEOUT_MS = 10_000;
/** revenuecat_webhook_events.error_message に残す長さ (固定のコードだけ) */
export const REVENUECAT_EVENT_ERROR_MAX_CHARS = 500;
/** 期限を過ぎたストアの行を読むときの再同期の間隔 (ms)。読むたびに RevenueCat を呼ばない下限 (5 分 = SDK のキャッシュの更新と同じ値) */
export const IAP_LAZY_RESYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** RevenueCat の Offering の識別子 (Dashboard で作る 1 つだけ。§17) */
export const REVENUECAT_OFFERING_ID = 'default';
/** 写像の p_source */
export const IAP_SYNC_SOURCE = 'iap_sync';
export const IAP_LAZY_RESYNC_SOURCE = 'iap_lazy_resync';
export function revenueCatWebhookSource(eventId: string): string {
  return `revenuecat:${eventId}`;
}
/**
 * 同じグループの新しい購読に置き換えられた購読を終わらせる写像の p_source の後ろに付ける印 (§7.3 の「同じグループの 2 つの live」の行)。
 * 監査 (system.billing.subscription_status_changed) の details.source で、置き換えによる終わりを見分ける (§13.3 の運営の処置)
 */
export const IAP_SUPERSEDED_SOURCE_SUFFIX = ':superseded';
export function supersededStoreSource(source: string): string {
  return `${source}${IAP_SUPERSEDED_SOURCE_SUFFIX}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// イベントの振り分け (すべて「取り直しの合図」。遷移は取り直した姿で決まる。§7.3)
// ─────────────────────────────────────────────────────────────────────────────

export type RevenueCatEventAction = 'sync' | 'sync_transfer' | 'ignore';
/** 一次情報 (RevenueCat の event types) の全 21 種。知らない種類は sync (app_user_id があれば取り直す。無ければ ignored) */
export const REVENUECAT_EVENT_ACTIONS = {
  TEST: 'ignore',
  INITIAL_PURCHASE: 'sync',
  RENEWAL: 'sync',
  CANCELLATION: 'sync',
  UNCANCELLATION: 'sync',
  NON_RENEWING_PURCHASE: 'sync',
  SUBSCRIPTION_PAUSED: 'sync',
  EXPIRATION: 'sync',
  BILLING_ISSUE: 'sync',
  PRODUCT_CHANGE: 'sync',
  SUBSCRIPTION_EXTENDED: 'sync',
  REFUND_REVERSED: 'sync',
  INVOICE_ISSUANCE: 'ignore',
  TRANSFER: 'sync_transfer',
  TEMPORARY_ENTITLEMENT_GRANT: 'sync',
  VIRTUAL_CURRENCY_TRANSACTION: 'ignore',
  EXPERIMENT_ENROLLMENT: 'ignore',
  PURCHASE_REDEEMED: 'sync',
  SUBSCRIBER_ALIAS: 'ignore',
  PRICE_INCREASE_CONSENT_REQUIRED: 'ignore',
  PRICE_INCREASE_CONSENT_APPROVED: 'ignore',
} as const satisfies Record<string, RevenueCatEventAction>;
export const REVENUECAT_EVENT_TYPES = Object.keys(REVENUECAT_EVENT_ACTIONS) as ReadonlyArray<keyof typeof REVENUECAT_EVENT_ACTIONS>;

export function classifyRevenueCatEvent(eventType: string): RevenueCatEventAction {
  const table: Readonly<Record<string, RevenueCatEventAction>> = REVENUECAT_EVENT_ACTIONS;
  return Object.hasOwn(table, eventType) ? table[eventType] : 'sync';
}

// ─────────────────────────────────────────────────────────────────────────────
// 監査 (admin_audit_logs.action_type)。状態の変化は写像が核と同じ名前で書く。ここは Webhook の失敗だけ
// ─────────────────────────────────────────────────────────────────────────────

export const IAP_AUDIT_ACTIONS = ['system.revenuecat.event_failed'] as const;
export type IapAuditAction = (typeof IAP_AUDIT_ACTIONS)[number];
export interface IapAuditEntry {
  actor_id: null;
  action_type: IapAuditAction;
  target_type: 'revenuecat_event';
  target_id: null;
  severity: 'warn';
  /** { event_id, event_type, error_code } だけ (個人情報を入れない) */
  details: { event_id: string; event_type: string; error_code: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// エラー (応答の本文は固定の文。未完成や予定を示す語 (準備中・まだ・近日・予定 など) を使わない。R3)
// ─────────────────────────────────────────────────────────────────────────────

export const IAP_ERROR_HTTP_STATUS = {
  BILL_IAP_INVALID_INPUT: 400,
  BILL_IAP_UNKNOWN_PRODUCT: 422,
  BILL_IAP_SYNC_CONFLICT: 409,
  EXT_REVENUECAT_NOT_CONFIGURED: 503,
  EXT_REVENUECAT_API_FAILED: 502,
} as const;
export type IapErrorCode = keyof typeof IAP_ERROR_HTTP_STATUS;

export const IAP_ERROR_MESSAGES: Readonly<Record<IapErrorCode, string>> = {
  BILL_IAP_INVALID_INPUT: '入力値が不正です',
  BILL_IAP_UNKNOWN_PRODUCT: 'この購入をご利用のプランに結び付けられませんでした。お問い合わせフォームからご連絡ください',
  BILL_IAP_SYNC_CONFLICT:
    'すでに別のご契約があるため、この購入をご利用のプランに反映できませんでした。お問い合わせフォームからご連絡ください。二重のお支払いにならないよう対応します',
  EXT_REVENUECAT_NOT_CONFIGURED: '購入の確認を完了できませんでした。時間をおいてお試しください',
  EXT_REVENUECAT_API_FAILED: '購入の確認サービスとの通信に失敗しました。しばらくしてからお試しください',
};

export class IapError extends Error {
  readonly code: IapErrorCode;
  constructor(code: IapErrorCode) {
    super(IAP_ERROR_MESSAGES[code]);
    this.name = 'IapError';
    this.code = code;
  }
}

/** REVENUECAT_SECRET_API_KEY が無い (503)。message に変数名を入れない */
export class RevenueCatNotConfiguredError extends Error {
  constructor() {
    super('購入の確認サービスの設定がありません');
    this.name = 'RevenueCatNotConfiguredError';
  }
}

/**
 * RevenueCat の REST が 2xx 以外を返した・応答の形が違った・届かなかった (時間切れ・接続の失敗。status = null) (502)。
 * 生の文面は rawMessage に持ち、ログにだけ残す
 */
export class RevenueCatApiError extends Error {
  readonly status: number | null;
  readonly rawMessage: string | null;
  constructor(input: { status: number | null; rawMessage?: string | null }) {
    super('RevenueCat API の呼び出しに失敗しました');
    this.name = 'RevenueCatApiError';
    this.status = input.status;
    this.rawMessage = input.rawMessage ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat のオブジェクト (本冊が読む項目だけ。looseObject = 知らない項目は捨てずに通す)
// ─────────────────────────────────────────────────────────────────────────────

const IsoDateTime = z.string().min(1);

/** Webhook の event (一次情報の項目のうち本冊が読むもの) */
export const RevenueCatEventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  app_id: z.string().optional(),
  event_timestamp_ms: z.number().int(),
  app_user_id: z.string().optional(),
  original_app_user_id: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  product_id: z.string().optional(),
  store: z.string().optional(),
  environment: z.string().optional(),
  transferred_from: z.array(z.string()).optional(),
  transferred_to: z.array(z.string()).optional(),
});
export type RevenueCatEvent = z.infer<typeof RevenueCatEventSchema>;

export const RevenueCatWebhookEnvelopeSchema = z.looseObject({
  api_version: z.string(),
  event: RevenueCatEventSchema,
});
export type RevenueCatWebhookEnvelope = z.infer<typeof RevenueCatWebhookEnvelopeSchema>;

/** GET /v1/subscribers の subscriptions[<product_id>] */
export const RevenueCatSubscriptionSchema = z.looseObject({
  expires_date: IsoDateTime.nullable().optional(),
  purchase_date: IsoDateTime,
  original_purchase_date: IsoDateTime.nullable().optional(),
  period_type: z.string(),
  store: z.string(),
  is_sandbox: z.boolean().optional(),
  unsubscribe_detected_at: IsoDateTime.nullable().optional(),
  billing_issues_detected_at: IsoDateTime.nullable().optional(),
  grace_period_expires_date: IsoDateTime.nullable().optional(),
  auto_resume_date: IsoDateTime.nullable().optional(),
  refunded_at: IsoDateTime.nullable().optional(),
  store_transaction_id: z.union([z.string(), z.number()]).nullable().optional(),
  ownership_type: z.string().optional(),
});
export type RevenueCatSubscription = z.infer<typeof RevenueCatSubscriptionSchema>;

export const RevenueCatSubscriberSchema = z.looseObject({
  original_app_user_id: z.string(),
  first_seen: IsoDateTime.optional(),
  management_url: z.string().nullable().optional(),
  subscriptions: z.record(z.string(), RevenueCatSubscriptionSchema),
});
export const RevenueCatCustomerInfoSchema = z.looseObject({
  request_date: IsoDateTime,
  request_date_ms: z.number().int().optional(),
  subscriber: RevenueCatSubscriberSchema,
});
export type RevenueCatCustomerInfo = z.infer<typeof RevenueCatCustomerInfoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// app_user_id = Supabase の auth.users.id (UUID)。匿名 ID ($RCAnonymousID:…) は当社の利用者ではないので無視する (R10)
// ─────────────────────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUserAppUserId(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** イベントから、取り直す利用者 (app_user_id) の一覧。sync は 1 人、TRANSFER は移動元と移動先の全員、ignore は空 */
export function appUserIdsToSync(event: RevenueCatEvent): string[] {
  const action = classifyRevenueCatEvent(event.type);
  if (action === 'ignore') return [];
  const candidates =
    action === 'sync_transfer' ? [...(event.transferred_from ?? []), ...(event.transferred_to ?? [])] : [event.app_user_id];
  const unique = new Set<string>();
  for (const id of candidates) if (isUserAppUserId(id)) unique.add(id.toLowerCase());
  return [...unique];
}

// ─────────────────────────────────────────────────────────────────────────────
// 商品の対応 (plan_store_products の行) と、取り直した契約 → snapshot (billing_apply_store_subscription の p_snapshot)
// ─────────────────────────────────────────────────────────────────────────────

export const IAP_BILLING_INTERVALS = ['month', 'year'] as const;
export type IapBillingInterval = (typeof IAP_BILLING_INTERVALS)[number];

export interface PlanStoreProductRow {
  plan_key: string;
  store: IapStore;
  billing_interval: IapBillingInterval;
  product_id: string;
  /** true = いま売る商品 (カタログに出す)。false = 購入の履歴の商品として plan_key・間隔を引くためだけに残す行 (§6.3) */
  offered: boolean;
}

/** ストアの行が取る status (核の 8 値のうち 5 つ。§6.4) */
export const STORE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type StoreSubscriptionStatus = (typeof STORE_SUBSCRIPTION_STATUSES)[number];
export const LIVE_STORE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due'] as const satisfies readonly StoreSubscriptionStatus[];
export function isLiveStoreStatus(status: StoreSubscriptionStatus): boolean {
  return (LIVE_STORE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * interface ではなく type にする: 生成された型 Json (RPC の p_snapshot) にそのまま代入できるように (核の SubscriptionSnapshot と同じ理由)
 */
export type StoreSubscriptionSnapshot = {
  user_id: string;
  iap_store: IapStore;
  iap_product_id: string;
  /** plan_store_products から引いた plan_key。無ければ null (SQL は既存の行があればその plan_key、無ければ BILL_UNKNOWN_PLAN) */
  plan_key: string | null;
  billing_interval: IapBillingInterval | null;
  iap_status: StoreSubscriptionStatus;
  is_sandbox: boolean;
  purchase_date: string;
  original_purchase_date: string | null;
  expires_date: string | null;
  cancel_at_period_end: boolean;
  refunded_at: string | null;
  store_transaction_id: string | null;
};

const RC_PERIOD_TYPE_TRIAL = 'trial';

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 取り直した契約の姿 → status (§7.3 の規則)。
 * ストアの猶予期間 (grace period) の間は expires_date を過ぎていても権利が続く (P13)。そのときは grace_period_expires_date が
 * いまより先なので past_due にする (権利あり・お支払いの問題の文)。猶予が無いか尽きたら expired
 */
export function deriveStoreStatus(sub: RevenueCatSubscription, nowMs: number): StoreSubscriptionStatus {
  if (parseMs(sub.refunded_at) !== null) return 'cancelled';
  const expiresMs = parseMs(sub.expires_date);
  if (expiresMs === null) return 'active';
  if (expiresMs > nowMs) {
    if (parseMs(sub.billing_issues_detected_at) !== null) return 'past_due';
    return sub.period_type.toLowerCase() === RC_PERIOD_TYPE_TRIAL ? 'trialing' : 'active';
  }
  const graceMs = parseMs(sub.grace_period_expires_date);
  if (graceMs !== null && graceMs > nowMs) return 'past_due';
  return 'expired';
}

export interface ProjectStoreSubscriptionInput {
  userId: string;
  store: IapStore;
  productId: string;
  sub: RevenueCatSubscription;
  /** plan_store_products の行 (無ければ null) */
  mapping: PlanStoreProductRow | null;
  /**
   * selectStoreSubscriptions の supersededAt。null でなければ、同じグループの新しい購読に置き換えられた購読として、
   * この時刻を expires_date にした expired の snapshot を作る (§7.3 の「同じグループの 2 つの live」の行)
   */
  supersededAt: string | null;
  nowMs: number;
}

export function projectStoreSubscription(input: ProjectStoreSubscriptionInput): StoreSubscriptionSnapshot {
  const { sub } = input;
  const transactionId = sub.store_transaction_id;
  const status: StoreSubscriptionStatus = input.supersededAt === null ? deriveStoreStatus(sub, input.nowMs) : 'expired';
  return {
    user_id: input.userId,
    iap_store: input.store,
    iap_product_id: input.productId,
    plan_key: input.mapping?.plan_key ?? null,
    billing_interval: input.mapping?.billing_interval ?? null,
    iap_status: status,
    is_sandbox: sub.is_sandbox ?? false,
    purchase_date: sub.purchase_date,
    original_purchase_date: sub.original_purchase_date ?? null,
    expires_date: input.supersededAt ?? sub.expires_date ?? null,
    cancel_at_period_end: parseMs(sub.unsubscribe_detected_at) !== null && status !== 'expired',
    refunded_at: sub.refunded_at ?? null,
    store_transaction_id: transactionId === null || transactionId === undefined ? null : String(transactionId),
  };
}

/**
 * 取り直した subscriptions に無くなった live なストアの行 (TRANSFER で別の利用者へ移った・RevenueCat 側で消えた) を終わらせる snapshot。
 * purchase_date は既存の行の値 (current_period_start か starts_at) を渡す (SQL は purchase_date を必須にしている)。
 * is_sandbox と billing_interval は既存の行の値をそのまま渡す (終わらせても、テストの購入の印と間隔を書き換えない。SQL の UPDATE は
 * snapshot の値で上書きするため)
 */
export function projectMissingSubscription(input: {
  userId: string;
  store: IapStore;
  productId: string;
  planKey: string;
  purchaseDate: string;
  isSandbox: boolean;
  billingInterval: IapBillingInterval | null;
  nowMs: number;
}): StoreSubscriptionSnapshot {
  return {
    user_id: input.userId,
    iap_store: input.store,
    iap_product_id: input.productId,
    plan_key: input.planKey,
    billing_interval: input.billingInterval,
    iap_status: 'expired',
    is_sandbox: input.isSandbox,
    purchase_date: input.purchaseDate,
    original_purchase_date: null,
    expires_date: new Date(input.nowMs).toISOString(),
    cancel_at_period_end: false,
    refunded_at: null,
    store_transaction_id: null,
  };
}

export interface SelectedStoreSubscription {
  productId: string;
  store: IapStore;
  sub: RevenueCatSubscription;
  mapping: PlanStoreProductRow | null;
  /**
   * 同じグループの新しい購読に置き換えられた (権利にしない) なら、置き換えた購読の purchase_date (この購読を終わらせる時刻)。
   * それ以外は null (§7.3 の「同じグループの 2 つの live」の行。S36)
   */
  supersededAt: string | null;
}

/**
 * 同じストアの取り直しに 2 つ以上の商品が live で並ぶとき、新しい 1 つだけを権利にし、ほかを置き換えられた購読として終わらせるストア
 * (§7.3 の「同じグループの 2 つの live」の行・S36)。
 *   - App Store: 本冊の 6 商品は 1 つの Subscription Group (§17.2 の homegohan_plans) にあり、上位への変更と期間が同じ crossgrade は
 *     すぐに効き、体験 (introductory offer) の間の上位への変更では Apple が体験を取り消さずに残す (P18)。2 つの live は二重購読ではない
 *   - Google Play は入れない: 購読の置き換えはアプリの購入の流れからしか始まらず (P18)、当社のアプリは契約中に購入のカードを出さない
 *     (§10.6)。2 つの live は二重購読なので、写像の 5. の BILL_LIVE_ROW_CONFLICT のまま (S25)
 */
export const SUPERSEDE_WITHIN_GROUP_STORES = ['app_store'] as const satisfies readonly IapStore[];

/**
 * 同じグループの live な 2 つの購読のどちらを権利にするかの順 (正の数 = a のほうが新しい = a を権利にする)。
 *   1. purchase_date の新しい方 (上位への変更・crossgrade で新しく始まった購読。更新でも進む)
 *   2. expires_date の遅い方 (無い = 期限なしを最も遅いとする)
 *   3. product_id の辞書順で後ろの方 (同じ取り直しで必ず同じ答えにする)
 */
export function compareStoreSubscriptionRecency(
  a: Pick<SelectedStoreSubscription, 'productId' | 'sub'>,
  b: Pick<SelectedStoreSubscription, 'productId' | 'sub'>,
): number {
  const purchaseA = parseMs(a.sub.purchase_date) ?? 0;
  const purchaseB = parseMs(b.sub.purchase_date) ?? 0;
  if (purchaseA !== purchaseB) return purchaseA - purchaseB;
  const expiresA = parseMs(a.sub.expires_date) ?? Number.POSITIVE_INFINITY;
  const expiresB = parseMs(b.sub.expires_date) ?? Number.POSITIVE_INFINITY;
  if (expiresA !== expiresB) return expiresA < expiresB ? -1 : 1;
  if (a.productId === b.productId) return 0;
  return a.productId < b.productId ? -1 : 1;
}

/**
 * 取り直した subscriptions のうち本冊のストア (app_store / play_store) のものを、適用する順 (live でないもの・置き換えられたものが先、
 * 次に expires_date の早い順) に並べる。SUPERSEDE_WITHIN_GROUP_STORES のストアで live が 2 つ以上なら、compareStoreSubscriptionRecency で
 * 最も新しい 1 つを除いた購読に supersededAt (= 最も新しい購読の purchase_date) を付ける。
 * 順が要る理由: 月額 → 年額の変更 (§7.3 PRODUCT_CHANGE) と同じグループの中の変更 (S36) で、古い行を先に expired にしてから新しい行を
 * 写さないと、写像の 5. が BILL_LIVE_ROW_CONFLICT にする
 */
export function selectStoreSubscriptions(
  info: RevenueCatCustomerInfo,
  products: readonly PlanStoreProductRow[],
  nowMs: number,
): SelectedStoreSubscription[] {
  const byStoreAndProduct = new Map<string, PlanStoreProductRow>();
  for (const row of products) byStoreAndProduct.set(`${row.store}:${row.product_id}`, row);
  const selected: SelectedStoreSubscription[] = [];
  for (const [productId, sub] of Object.entries(info.subscriber.subscriptions)) {
    const store = REVENUECAT_STORE_TO_IAP_STORE[sub.store.toLowerCase()];
    if (store === undefined) continue;
    selected.push({ productId, store, sub, mapping: byStoreAndProduct.get(`${store}:${productId}`) ?? null, supersededAt: null });
  }
  const isLive = (entry: SelectedStoreSubscription): boolean => isLiveStoreStatus(deriveStoreStatus(entry.sub, nowMs));
  for (const store of SUPERSEDE_WITHIN_GROUP_STORES) {
    const live = selected.filter((entry) => entry.store === store && isLive(entry));
    if (live.length < 2) continue;
    const winner = live.reduce((best, entry) => (compareStoreSubscriptionRecency(entry, best) > 0 ? entry : best));
    for (const entry of live) if (entry !== winner) entry.supersededAt = winner.sub.purchase_date;
  }
  const rank = (entry: SelectedStoreSubscription): number => (entry.supersededAt === null && isLive(entry) ? 1 : 0);
  return selected.sort((a, b) => rank(a) - rank(b) || (parseMs(a.sub.expires_date) ?? 0) - (parseMs(b.sub.expires_date) ?? 0));
}

/**
 * plan_store_products に対応の行が無い商品の扱い (S15・S28)。
 *   - 対応の行がある、または利用者の行がすでにある → apply (行があれば SQL がその行の plan_key を使う。§6.4 の 4.)
 *   - 対応の行も利用者の行も無く、置き換えられた購読 (supersededAt あり) → skip (権利にしないので履歴の行を作らない。S36)
 *   - 対応の行も利用者の行も無く、live (trialing / active / past_due) → reject (BILL_IAP_UNKNOWN_PRODUCT。運営が行を足すまで写せない)
 *   - 対応の行も利用者の行も無く、live でない (期限切れ・返金済みの履歴) → skip (履歴の行を作らない。ほかの商品の同期を止めない)
 */
export type UnmappedStoreSubscriptionDecision = 'apply' | 'skip' | 'reject';
export function unmappedStoreSubscriptionDecision(
  entry: Pick<SelectedStoreSubscription, 'sub' | 'mapping' | 'supersededAt'>,
  hasExistingRow: boolean,
  nowMs: number,
): UnmappedStoreSubscriptionDecision {
  if (entry.mapping !== null || hasExistingRow) return 'apply';
  if (entry.supersededAt !== null) return 'skip';
  return isLiveStoreStatus(deriveStoreStatus(entry.sub, nowMs)) ? 'reject' : 'skip';
}

/** 期限を過ぎたストアの行を読むときに、RevenueCat から取り直すか (遅延の再同期。Q-11・S12) */
export function needsLazyResync(
  row: { iap_store: string | null; current_period_end: string | null; iap_synced_at: string | null } | null,
  nowMs: number,
): boolean {
  if (row === null || row.iap_store === null) return false;
  const periodEnd = parseMs(row.current_period_end);
  if (periodEnd === null || periodEnd > nowMs) return false;
  const synced = parseMs(row.iap_synced_at);
  return synced === null || nowMs - synced >= IAP_LAZY_RESYNC_MIN_INTERVAL_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// revenuecat_webhook_events.payload に残すイベントの写し (最小化。subscriber_attributes・aliases・価格・国は残さない)
// ─────────────────────────────────────────────────────────────────────────────

export type StoredRevenueCatEventPayload = {
  id: string;
  type: string;
  api_version: string;
  event_timestamp_ms: number;
  app_user_id: string | null;
  original_app_user_id: string | null;
  product_id: string | null;
  store: string | null;
  environment: string | null;
  transferred_from: string[] | null;
  transferred_to: string[] | null;
};

export function minimizeRevenueCatEventPayload(envelope: RevenueCatWebhookEnvelope): StoredRevenueCatEventPayload {
  const { event } = envelope;
  return {
    id: event.id,
    type: event.type,
    api_version: envelope.api_version,
    event_timestamp_ms: event.event_timestamp_ms,
    app_user_id: event.app_user_id ?? null,
    original_app_user_id: event.original_app_user_id ?? null,
    product_id: event.product_id ?? null,
    store: event.store ?? null,
    environment: event.environment ?? null,
    transferred_from: event.transferred_from ?? null,
    transferred_to: event.transferred_to ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API の入出力
// ─────────────────────────────────────────────────────────────────────────────

export const IapCatalogQuerySchema = z.object({ store: z.enum(IAP_STORES) });
export type IapCatalogQuery = z.infer<typeof IapCatalogQuerySchema>;

/**
 * GET /api/billing/iap/catalog の data。アプリは product_id を offerings の package.product.identifier と突き合わせる。
 * 無料体験の日数は返さない (アプリの購入の画面の体験の文は、ストアの商品の導入価格と体験の対象の判定から作る。§8.10 storeTrialOf)
 */
export interface IapCatalogPlan {
  plan_key: string;
  display_name: string;
  max_members: number | null;
  products: Array<{ billing_interval: IapBillingInterval; product_id: string }>;
}
export interface IapCatalog {
  store: IapStore;
  plans: IapCatalogPlan[];
}

/** 公開のプランの最小の形 (listPublicPlans の行のうちカタログが使う列) */
export interface CatalogPlanRow {
  plan_key: string;
  display_name: string;
  max_members: number | null;
}

/** 公開のプランとストアの商品の行から、そのストアのカタログを組む (売る行 (offered) が無いプランは出さない。R18) */
export function buildIapCatalog(store: IapStore, plans: readonly CatalogPlanRow[], products: readonly PlanStoreProductRow[]): IapCatalog {
  const result: IapCatalogPlan[] = [];
  for (const plan of plans) {
    const rows = products
      .filter((row) => row.offered && row.store === store && row.plan_key === plan.plan_key)
      .sort((a, b) => IAP_BILLING_INTERVALS.indexOf(a.billing_interval) - IAP_BILLING_INTERVALS.indexOf(b.billing_interval));
    if (rows.length === 0) continue;
    result.push({
      plan_key: plan.plan_key,
      display_name: plan.display_name,
      max_members: plan.max_members,
      products: rows.map((row) => ({ billing_interval: row.billing_interval, product_id: row.product_id })),
    });
  }
  return { store, plans: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 写像の戻り値・ポート (実装は revenuecat-gateway.ts / iap-repository.ts。テストは偽物を渡す)
// ─────────────────────────────────────────────────────────────────────────────

export type ApplyStoreSubscriptionResult =
  | { applied: true; subscription_id: string; user_id: string; status_from: string | null; status_to: StoreSubscriptionStatus; plan_key: string }
  | { applied: false; skipped: 'stale'; subscription_id: string; user_id: string }
  | { applied: false; skipped: 'user_deleted' };

export type RevenueCatEventClaim = 'claimed' | 'completed' | 'in_progress';
export const REVENUECAT_EVENT_CLAIMS = ['claimed', 'completed', 'in_progress'] as const satisfies readonly RevenueCatEventClaim[];
export function isRevenueCatEventClaim(value: unknown): value is RevenueCatEventClaim {
  return typeof value === 'string' && (REVENUECAT_EVENT_CLAIMS as readonly string[]).includes(value);
}

export interface RevenueCatGateway {
  /** GET /v1/subscribers/{app_user_id} (無ければ作られる。情報の取得なので X-Platform は付けない) */
  getSubscriber(appUserId: string): Promise<RevenueCatCustomerInfo>;
}

/**
 * 利用者のストアの行 (状態を問わず全部)。取り直した subscriptions に無くなった live な行を終わらせるためと、
 * 対応の行が無い商品に利用者の行があるか (unmappedStoreSubscriptionDecision) を見るために読む
 */
export interface StoreSubscriptionRow {
  iap_store: IapStore;
  iap_product_id: string;
  plan_key: string;
  status: string;
  billing_interval: IapBillingInterval | null;
  iap_is_sandbox: boolean;
  current_period_start: string | null;
  starts_at: string;
}

/** 行の status が live (trialing / active / past_due。ストアの行が取る 5 値のうち。§6.4) か */
export function isLiveStoreRowStatus(status: string): boolean {
  return (LIVE_STORE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** ストアの行の (store, product_id) の鍵 (selectStoreSubscriptions と行を突き合わせる) */
export function storeSubscriptionKey(store: IapStore, productId: string): string {
  return `${store}:${productId}`;
}

export interface IapRepository {
  listStoreProducts(): Promise<PlanStoreProductRow[]>;
  listStoreSubscriptions(userId: string): Promise<StoreSubscriptionRow[]>;
  applyStoreSubscription(input: { snapshot: StoreSubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplyStoreSubscriptionResult>;
  claimRevenueCatEvent(payload: StoredRevenueCatEventPayload): Promise<RevenueCatEventClaim>;
  finishRevenueCatEvent(eventId: string, outcome: { ok: true } | { ok: false; errorCode: string }): Promise<void>;
  recordIapAudit(entry: IapAuditEntry): Promise<void>;
}

/** 同期 1 回の結果 (利用者 1 人分) */
export interface StoreSyncOutcome {
  user_id: string;
  applied: number;
  stale: number;
  /** 取り直した subscriptions に当社のストアの契約が無かった (何も作らない) */
  no_subscription: boolean;
  /** 取り直した subscriptions に無くなった live な行を expired にした数 */
  ended: number;
  /** 対応の行も利用者の行も無い、live でない商品を飛ばした数 (S28) */
  skipped_unknown: number;
}
```

### 8.2 署名の確認 (`src/lib/webhook/verify.ts` に足す)

RevenueCat の署名 (P4) は Stripe の署名と同じ形: ヘッダーは `t=<unix 秒>,v1=<HMAC-SHA256 の hex>`、署名の対象は `<t>.<生の本文>`、鍵は署名の秘密の文字列そのまま、時刻の許容は 5 分 (RevenueCat の案内の例。既存の `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` = 5 分と同じ)。そのため、既存の `verifyStripeSignature` (`src/lib/webhook/verify.ts`。ヘッダーの分解・時刻の許容・`crypto.createHmac`・長さをそろえた `crypto.timingSafeEqual`) をそのまま使い、RevenueCat の名前で包むだけにする。既存の `WebhookVerification` の `reason` の語彙 (`missing_headers` / `invalid_timestamp` / `timestamp_out_of_tolerance` / `signature_mismatch`) と `WebhookSecretMissingError` (引数なしの constructor) は変えない。import も足さない。

```ts
// tsc:skip insert=src/lib/webhook/verify.ts — ファイルの末尾 (verifyStripeWebhook の下) に足す。同じファイルの verifyStripeSignature・getOptionalEnv・WebhookSecretMissingError・WebhookVerification を使う (import は足さない)

/**
 * RevenueCat の Webhook の署名を確かめる (秘密は引数で渡す。純粋な関数。billing/03 §8.2)。
 * RevenueCat の X-RevenueCat-Webhook-Signature は Stripe-Signature と同じ形 (t=<unix 秒>,v1=<HMAC-SHA256 hex>・対象は "<t>.<本文>"・
 * 鍵は秘密の文字列そのまま) なので、Stripe の確認をそのまま使う。時刻の許容も同じ (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 分)
 * @param payload 受け取った本文そのまま
 * @param header  X-RevenueCat-Webhook-Signature の値 (無ければ null。無い・形が違うときは missing_headers)
 * @param secret  署名の秘密 (RevenueCat の Integrations → Webhooks で 1 回だけ表示される値)
 * @param nowMs   いまの時刻 (テストで差し替える)
 */
export function verifyRevenueCatSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
): WebhookVerification {
  return verifyStripeSignature(payload, header, secret, nowMs);
}

/**
 * RevenueCat の Webhook の署名を、環境変数 REVENUECAT_WEBHOOK_SECRET の秘密で確かめる。
 * 秘密が無ければ受け付けずに WebhookSecretMissingError を投げる (fail-closed。route は 503)
 */
export function verifyRevenueCatWebhook(payload: string, header: string | null, nowMs: number = Date.now()): WebhookVerification {
  const secret = getOptionalEnv('REVENUECAT_WEBHOOK_SECRET');
  if (!secret || secret.trim().length === 0) throw new WebhookSecretMissingError();
  return verifyRevenueCatSignature(payload, header, secret.trim(), nowMs);
}
```

- ファイル冒頭の注 (「いまあるのは Resend (Svix の形) と Stripe (t/v1 の形。billing/01 §8.3)」) に「RevenueCat (Stripe と同じ t/v1 の形。billing/03 §8.2)」を足す。

### 8.3 `src/lib/billing/revenuecat-gateway.ts` と `src/lib/billing/iap-repository.ts`

```ts
// tsc:skip place=src/lib/billing/revenuecat-gateway.ts
/**
 * RevenueCatGateway の実装 (billing/03 §8.3)。REST v1 を fetch で呼ぶ (SDK を入れない)。
 * 秘密の鍵 (REVENUECAT_SECRET_API_KEY) が無ければ createRevenueCatGateway が RevenueCatNotConfiguredError を投げる (route は 503)。
 */
import { getOptionalEnv } from '@/lib/env';
import { createLogger } from '@/lib/db-logger';
import {
  REVENUECAT_API_BASE_URL,
  REVENUECAT_REQUEST_TIMEOUT_MS,
  RevenueCatApiError,
  RevenueCatCustomerInfoSchema,
  RevenueCatNotConfiguredError,
  type RevenueCatGateway,
} from '@/lib/billing/iap-core';

const logger = createLogger('billing/revenuecat-gateway');

export function createRevenueCatGateway(fetchImpl: typeof fetch = fetch): RevenueCatGateway {
  const secretKey = getOptionalEnv('REVENUECAT_SECRET_API_KEY');
  if (!secretKey || secretKey.trim().length === 0) throw new RevenueCatNotConfiguredError();
  const key = secretKey.trim();
  return {
    async getSubscriber(appUserId) {
      const url = `${REVENUECAT_API_BASE_URL}/subscribers/${encodeURIComponent(appUserId)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REVENUECAT_REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        // 時間切れ (AbortSignal.timeout の TimeoutError)・接続の失敗も 502 にまとめる (§13.1 の文「通信に失敗しました」。S30)。生の文は残さず名前だけ
        const error = new RevenueCatApiError({ status: null, rawMessage: cause instanceof Error ? cause.name : null });
        logger.error('RevenueCat API に届きませんでした', error, { reason: 'fetch_failed' });
        throw error;
      }
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new RevenueCatApiError({ status: response.status, rawMessage: typeof json === 'object' && json !== null ? JSON.stringify(json) : null });
        // 生の文面は app_logs にだけ残す (鍵・本文は残さない)
        logger.error('RevenueCat API が 2xx 以外を返しました', error, { status: response.status });
        throw error;
      }
      const parsed = RevenueCatCustomerInfoSchema.safeParse(json);
      if (!parsed.success) {
        const error = new RevenueCatApiError({ status: response.status, rawMessage: 'unexpected response shape' });
        logger.error('RevenueCat API の応答の形が想定と違いました', error, { issues: parsed.error.issues.map((i) => i.path.join('.')) });
        throw error;
      }
      return parsed.data;
    },
  };
}
```

```ts
// tsc:skip place=src/lib/billing/iap-repository.ts
/** IapRepository の実装 (billing/03 §8.3)。service_role の client で RPC と SELECT を行う。呼ぶ側は必ず認証のあとか署名のあと */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { BillingRpcError } from '@/lib/billing/repository';
import {
  REVENUECAT_EVENT_STUCK_MINUTES,
  isIapStore,
  isRevenueCatEventClaim,
  type ApplyStoreSubscriptionResult,
  type IapAuditEntry,
  type IapRepository,
  type PlanStoreProductRow,
  type RevenueCatEventClaim,
  type StoreSubscriptionRow,
  type StoredRevenueCatEventPayload,
} from '@/lib/billing/iap-core';

/** DB の RPC が P0001 で返す業務エラーのうち本冊の写像が足すもの (核の BillingRpcError の code の集合に足す。§13.3) */
const STORE_RPC_ERROR_CODES = new Set(['BILL_UNKNOWN_PLAN', 'BILL_UNKNOWN_IAP_STATUS', 'BILL_LIVE_ROW_CONFLICT']);

const isBillingInterval = (value: string | null): value is 'month' | 'year' => value === 'month' || value === 'year';

type Admin = ReturnType<typeof getSupabaseAdmin>;

export function createIapRepository(admin: Admin = getSupabaseAdmin()): IapRepository {
  return {
    async listStoreProducts() {
      // offered = false の行も読む (購入の履歴の商品の plan_key・間隔を引くため。カタログに出すかは buildIapCatalog が offered で決める)
      const { data, error } = await admin.from('plan_store_products').select('plan_key, store, billing_interval, product_id, offered');
      if (error) throw error;
      return (data ?? []).filter((row): row is PlanStoreProductRow => isIapStore(row.store) && isBillingInterval(row.billing_interval));
    },
    async listStoreSubscriptions(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select('iap_store, iap_product_id, plan_key, status, billing_interval, iap_is_sandbox, current_period_start, starts_at')
        .eq('user_id', userId)
        .not('iap_store', 'is', null);
      if (error) throw error;
      const rows: StoreSubscriptionRow[] = [];
      for (const row of data ?? []) {
        if (row.iap_store === null || !isIapStore(row.iap_store) || row.iap_product_id === null) continue;
        rows.push({
          iap_store: row.iap_store,
          iap_product_id: row.iap_product_id,
          plan_key: row.plan_key,
          status: row.status,
          billing_interval: row.billing_interval !== null && isBillingInterval(row.billing_interval) ? row.billing_interval : null,
          iap_is_sandbox: row.iap_is_sandbox,
          current_period_start: row.current_period_start,
          starts_at: row.starts_at,
        });
      }
      return rows;
    },
    async applyStoreSubscription({ snapshot, fetchedAt, source }) {
      const { data, error } = await admin.rpc('billing_apply_store_subscription', {
        p_snapshot: snapshot,
        p_fetched_at: fetchedAt.toISOString(),
        p_source: source,
      });
      if (error) {
        if (error.code === 'P0001' && typeof error.message === 'string' && STORE_RPC_ERROR_CODES.has(error.message)) {
          throw new BillingRpcError(error.message as BillingRpcError['code'], typeof error.details === 'string' ? error.details : null);
        }
        throw error;
      }
      return data as ApplyStoreSubscriptionResult;
    },
    async claimRevenueCatEvent(payload: StoredRevenueCatEventPayload) {
      const { data, error } = await admin.rpc('billing_claim_revenuecat_event', {
        p_event_id: payload.id,
        p_event_type: payload.type,
        p_payload: payload,
        p_stuck_after: `${REVENUECAT_EVENT_STUCK_MINUTES} minutes`,
      });
      if (error) throw error;
      if (!isRevenueCatEventClaim(data)) throw new Error('billing_claim_revenuecat_event が想定外の結果を返しました');
      return data satisfies RevenueCatEventClaim;
    },
    async finishRevenueCatEvent(eventId, outcome) {
      const args = outcome.ok ? { p_event_id: eventId, p_ok: true } : { p_event_id: eventId, p_ok: false, p_error: outcome.errorCode };
      const { error } = await admin.rpc('billing_finish_revenuecat_event', args);
      if (error) throw error;
    },
    async recordIapAudit(entry: IapAuditEntry) {
      const { error } = await admin.from('admin_audit_logs').insert({
        actor_id: entry.actor_id,
        action_type: entry.action_type,
        target_id: entry.target_id,
        target_type: entry.target_type,
        severity: entry.severity,
        details: entry.details,
      });
      if (error) throw error;
    },
  };
}
```

- `BillingRpcError` (核 `src/lib/billing/repository.ts`) の `code` の union に `'BILL_UNKNOWN_IAP_STATUS'` を足す (核のファイルの 1 行の差分。`BILLING_RPC_ERROR_CODES` の Set にも足す。§16.1)。
- `admin_audit_logs.target_type` に新しい値 `revenuecat_event` (varchar(30))。
- `recordIapAudit` は、`src` の中で `admin_audit_logs` に直接 INSERT する 3 つ目のファイル (`src/lib/admin/audit.ts`・核の `src/lib/billing/repository.ts` に続く) になる。`system.*` の action_type は本人の JWT では書けない (`recordAdminAudit` は使えない) ので、核の `recordAudit` と同じく service_role で書く。書き手の一覧を固定するテスト (`tests/admin-audit-logs-insert-policy-migration-contract.test.ts`) の追随は §16.1。

### 8.4 `src/lib/billing/iap-service.ts` (facade。route はこれだけを呼ぶ)

```ts
// tsc:skip place=src/lib/billing/iap-service.ts
/**
 * アプリ内課金のユースケース (billing/03 §8.4)。revenuecat-gateway・iap-repository・@/lib/env を import しない (実装は route が作って deps で渡す)。
 */
import { createLogger } from '@/lib/db-logger';
import { BillingRpcError } from '@/lib/billing/repository';
import {
  IAP_LAZY_RESYNC_SOURCE,
  IapError,
  appUserIdsToSync,
  isLiveStoreRowStatus,
  needsLazyResync,
  projectMissingSubscription,
  projectStoreSubscription,
  revenueCatWebhookSource,
  selectStoreSubscriptions,
  storeSubscriptionKey,
  supersededStoreSource,
  unmappedStoreSubscriptionDecision,
  type IapRepository,
  type RevenueCatEvent,
  type RevenueCatGateway,
  type StoreSyncOutcome,
} from '@/lib/billing/iap-core';

const logger = createLogger('billing/iap-service');

export interface IapDeps {
  gateway: RevenueCatGateway;
  repository: IapRepository;
  /** テストで差し替える (いま)。既定は () => new Date() */
  now?: () => Date;
}

/** 監査は fail-open (核と同じ)。失敗はログに残し、本体の操作は止めない */
async function audit(repository: IapRepository, entry: Parameters<IapRepository['recordIapAudit']>[0]): Promise<void> {
  try {
    await repository.recordIapAudit(entry);
  } catch (error) {
    logger.error('アプリ内課金の監査ログの記録に失敗しました', error, { action_type: entry.action_type });
  }
}

/**
 * 利用者 1 人のストアの契約を RevenueCat から取り直して写す (すべての写しの入口。Webhook・同期の API・遅延の再同期)。
 *   1. GET /v1/subscribers/{user id} → 本冊のストアの契約を適用する順に並べる (live でないもの・同じ App Store のグループの新しい購読に
 *      置き換えられたもの (supersededAt。§7.3・S36) が先)
 *   2. 利用者のストアの行を全部読む。plan_store_products に対応の行が無い商品は unmappedStoreSubscriptionDecision で振り分ける:
 *      利用者の行があれば写す (SQL がその行の plan_key を使う)・無くて live なら BILL_IAP_UNKNOWN_PRODUCT (何も書かずに止める。
 *      運営が行を足したあとの同期で写る。S15)・無くて live でなければ飛ばす (S28)
 *   3. 取り直した subscriptions に無い live なストアの行 (TRANSFER で移った・消えた) は expired の snapshot で終わらせる
 *      (行の iap_is_sandbox と billing_interval を引き継ぐ)
 *   4. 1 件ずつ billing_apply_store_subscription。置き換えられた購読は expired の snapshot と p_source = <source>:superseded で写す。
 *      BILL_LIVE_ROW_CONFLICT はそのまま投げる (route が 409 / failed にする。S13)
 */
export async function syncStoreSubscriber(deps: IapDeps, userId: string, source: string): Promise<StoreSyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const info = await deps.gateway.getSubscriber(userId);
  const products = await deps.repository.listStoreProducts();
  const selected = selectStoreSubscriptions(info, products, nowMs);
  const rows = await deps.repository.listStoreSubscriptions(userId);
  const existing = new Set(rows.map((row) => storeSubscriptionKey(row.iap_store, row.iap_product_id)));
  const toApply: typeof selected = [];
  let skippedUnknown = 0;
  for (const entry of selected) {
    const decision = unmappedStoreSubscriptionDecision(entry, existing.has(storeSubscriptionKey(entry.store, entry.productId)), nowMs);
    // 書き込みの前に判定する (1 つでも reject なら、どの行も書かずに止める。運営が行を足したあとの同期で全部を写す)
    if (decision === 'reject') throw new IapError('BILL_IAP_UNKNOWN_PRODUCT');
    if (decision === 'skip') skippedUnknown += 1;
    else toApply.push(entry);
  }
  const outcome: StoreSyncOutcome = {
    user_id: userId, applied: 0, stale: 0, no_subscription: selected.length === 0, ended: 0, skipped_unknown: skippedUnknown,
  };

  const present = new Set(selected.map((entry) => storeSubscriptionKey(entry.store, entry.productId)));
  for (const row of rows) {
    if (!isLiveStoreRowStatus(row.status) || present.has(storeSubscriptionKey(row.iap_store, row.iap_product_id))) continue;
    const snapshot = projectMissingSubscription({
      userId, store: row.iap_store, productId: row.iap_product_id, planKey: row.plan_key,
      purchaseDate: row.current_period_start ?? row.starts_at,
      isSandbox: row.iap_is_sandbox, billingInterval: row.billing_interval, nowMs,
    });
    const result = await deps.repository.applyStoreSubscription({ snapshot, fetchedAt: now, source });
    if (result.applied) outcome.ended += 1;
  }
  for (const entry of toApply) {
    const snapshot = projectStoreSubscription({
      userId, store: entry.store, productId: entry.productId, sub: entry.sub, mapping: entry.mapping, supersededAt: entry.supersededAt, nowMs,
    });
    // 置き換えによる終わりは、監査の details.source で見分けられるように印を付ける (§13.3 の運営の処置)
    const entrySource = entry.supersededAt === null ? source : supersededStoreSource(source);
    const result = await deps.repository.applyStoreSubscription({ snapshot, fetchedAt: now, source: entrySource });
    if (result.applied) outcome.applied += 1;
    else if (result.skipped === 'stale') outcome.stale += 1;
  }
  return outcome;
}

export type RevenueCatEventOutcome = { action: 'synced' | 'ignored'; detail: string };

/** 署名と claim を通ったイベントを処理する (POST /api/webhooks/revenuecat)。例外は route が finish(ok=false) + 500 にする */
export async function handleRevenueCatEvent(deps: IapDeps, event: RevenueCatEvent): Promise<RevenueCatEventOutcome> {
  const userIds = appUserIdsToSync(event);
  if (userIds.length === 0) return { action: 'ignored', detail: event.type };
  const source = revenueCatWebhookSource(event.id);
  const details: string[] = [];
  for (const userId of userIds) {
    const outcome = await syncStoreSubscriber(deps, userId, source);
    details.push(`${outcome.applied}/${outcome.stale}/${outcome.ended}/${outcome.skipped_unknown}${outcome.no_subscription ? '/none' : ''}`);
  }
  return { action: 'synced', detail: details.join(',') };
}

/** 処理に失敗したイベントを記録する (route の catch)。finish(ok=false) の失敗は投げる (route が 500) */
export async function recordRevenueCatEventFailure(deps: IapDeps, event: RevenueCatEvent, errorCode: string): Promise<void> {
  await deps.repository.finishRevenueCatEvent(event.id, { ok: false, errorCode });
  await audit(deps.repository, {
    actor_id: null, action_type: 'system.revenuecat.event_failed', target_type: 'revenuecat_event', target_id: null, severity: 'warn',
    details: { event_id: event.id, event_type: event.type, error_code: errorCode },
  });
}

/**
 * 遅延の再同期 (GET /api/billing/subscription の前。Q-11・S12)。期限を過ぎたストアの行で、5 分より古い取り直しなら取り直す。
 * 失敗しても要約の読み取りは止めない (ログに残す)。鍵が無い (RevenueCatNotConfiguredError) ときは呼び出し側が deps を作れないので、ここには来ない
 */
export async function lazyResyncStoreSubscription(
  deps: IapDeps,
  userId: string,
  row: { iap_store: string | null; current_period_end: string | null; iap_synced_at: string | null } | null,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  if (!needsLazyResync(row, now.getTime())) return;
  try {
    await syncStoreSubscriber(deps, userId, IAP_LAZY_RESYNC_SOURCE);
  } catch (error) {
    // 取り直せなくても、いまの行で要約を返す (次の読み取りでまた試す)
    logger.warn('ストアの契約の遅延の再同期に失敗しました', { user_id: userId, code: error instanceof BillingRpcError ? error.code : error instanceof IapError ? error.code : 'unknown' });
  }
}
```

### 8.5 route 3 本と、既存の route の差分

```ts
// tsc:skip place=src/app/api/webhooks/revenuecat/route.ts
/**
 * POST /api/webhooks/revenuecat — RevenueCat の Webhook の受け口 (billing/03 §9.1)。核の Stripe の受け口 (billing/01 §9.6) と同じ骨格。
 * イベントは合図として扱い、契約は必ず RevenueCat から取り直してから写す。冪等キーは event.id (billing_claim_revenuecat_event)。
 * 応答 (§13.2): 200 処理した / 処理済み / 対象外、409 ほかが処理中、400 外形、401 署名、413 大きさ、500 処理の失敗 (RevenueCat が再送)、
 * 503 署名の秘密か鍵が無い。認証はログインではなく署名 (cross/04 §10)。本文に RevenueCat の生のエラー文・イベントの中身を入れない。
 */
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  REVENUECAT_SIGNATURE_HEADER,
  REVENUECAT_WEBHOOK_API_VERSION,
  REVENUECAT_WEBHOOK_MAX_BODY_BYTES,
  IapError,
  RevenueCatApiError,
  RevenueCatNotConfiguredError,
  RevenueCatWebhookEnvelopeSchema,
  minimizeRevenueCatEventPayload,
  type RevenueCatGateway,
} from '@/lib/billing/iap-core';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { BillingRpcError } from '@/lib/billing/repository';
import { handleRevenueCatEvent, recordRevenueCatEventFailure } from '@/lib/billing/iap-service';
import { verifyRevenueCatWebhook, WebhookSecretMissingError } from '@/lib/webhook/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 根拠は REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS (src/lib/billing/iap-core.ts)。route segment config はリテラルだけ (一致はテスト 30)
export const maxDuration = 30;

const ROUTE_NAME = 'POST /api/webhooks/revenuecat';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const UNEXPECTED_ERROR_CODE = 'SYS_INTERNAL_ERROR';
const REVENUECAT_API_FAILED_CODE = 'EXT_REVENUECAT_API_FAILED';

function errorCodeOf(error: unknown): string {
  if (error instanceof BillingRpcError) return error.code;
  if (error instanceof IapError) return error.code;
  if (error instanceof RevenueCatApiError) return REVENUECAT_API_FAILED_CODE;
  return UNEXPECTED_ERROR_CODE;
}

export async function POST(request: Request): Promise<NextResponse> {
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > REVENUECAT_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  const payload = await request.text();
  if (Buffer.byteLength(payload, 'utf8') > REVENUECAT_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  let verification: ReturnType<typeof verifyRevenueCatWebhook>;
  try {
    verification = verifyRevenueCatWebhook(payload, request.headers.get(REVENUECAT_SIGNATURE_HEADER));
  } catch (error) {
    if (error instanceof WebhookSecretMissingError) {
      logger.error('RevenueCat の Webhook の署名の秘密が未設定のため、受け付けませんでした', error);
      return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error);
  }
  if (!verification.ok) {
    logger.warn('RevenueCat の Webhook の署名を確かめられなかったため、受け付けませんでした', { reason: verification.reason });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const parsed = RevenueCatWebhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn('RevenueCat の Webhook の本文の形が想定と違いました', { issues: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') });
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const envelope = parsed.data;
  const event = envelope.event;
  const eventLog = { event_id: event.id, event_type: event.type };
  if (envelope.api_version !== REVENUECAT_WEBHOOK_API_VERSION) {
    logger.warn('RevenueCat の Webhook の api_version が想定と違います (処理は続けます)', { ...eventLog, api_version: envelope.api_version });
  }
  let gateway: RevenueCatGateway;
  try {
    gateway = createRevenueCatGateway();
  } catch (error) {
    if (error instanceof RevenueCatNotConfiguredError) {
      logger.error('RevenueCat の鍵が未設定のため、Webhook を処理できませんでした', error, eventLog);
      return NextResponse.json({ error: 'revenuecat_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error, eventLog);
  }
  const deps = { gateway, repository: createIapRepository() };
  let claim: Awaited<ReturnType<typeof deps.repository.claimRevenueCatEvent>>;
  try {
    claim = await deps.repository.claimRevenueCatEvent(minimizeRevenueCatEventPayload(envelope));
  } catch (error) {
    return internalError(ROUTE_NAME, error, eventLog);
  }
  if (claim === 'completed') return NextResponse.json({ received: true, duplicate: true }, { status: 200, headers: NO_STORE });
  if (claim === 'in_progress') {
    logger.info('同じ RevenueCat のイベントをほかが処理中のため、再送を待ちます', eventLog);
    return NextResponse.json({ error: 'event_in_progress' }, { status: 409, headers: NO_STORE });
  }
  let outcome: Awaited<ReturnType<typeof handleRevenueCatEvent>>;
  try {
    outcome = await handleRevenueCatEvent(deps, event);
  } catch (error) {
    try {
      await recordRevenueCatEventFailure(deps, event, errorCodeOf(error));
    } catch (finishError) {
      logger.error('RevenueCat のイベントの失敗の記録に失敗しました', finishError, eventLog);
    }
    return internalError(ROUTE_NAME, error, eventLog);
  }
  try {
    await deps.repository.finishRevenueCatEvent(event.id, { ok: true });
  } catch (error) {
    return internalError(ROUTE_NAME, error, eventLog);
  }
  logger.info('RevenueCat のイベントを処理しました', { ...eventLog, action: outcome.action, detail: outcome.detail });
  return NextResponse.json({ received: true, action: outcome.action, detail: outcome.detail }, { status: 200, headers: NO_STORE });
}
```

```ts
// tsc:skip place=src/app/api/billing/iap/catalog/route.ts
/**
 * GET /api/billing/iap/catalog?store=app_store|play_store — アプリの購入の画面が読む、そのストアで買えるプランと商品 ID (billing/03 §9.2)。
 * 公開のプラン (listPublicPlans) と plan_store_products の売る行 (offered = true。RLS の公開の SELECT) だけを読む。鍵も Stripe も RevenueCat も見ない
 * (@/lib/env に届かない)。ログインは要る (アプリの画面からだけ呼ぶ。requireUser)。売る行が無いプランは返さない (R18)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { billingErrorResponse } from '@/lib/billing/http';
import { listPublicPlans } from '@/lib/billing/public-plans';
import { IAP_ERROR_HTTP_STATUS, IAP_ERROR_MESSAGES, IapCatalogQuerySchema, buildIapCatalog, isIapStore, type PlanStoreProductRow } from '@/lib/billing/iap-core';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'GET /api/billing/iap/catalog';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireUser();
    const url = new URL(request.url);
    const parsed = IapCatalogQuerySchema.safeParse({ store: url.searchParams.get('store') });
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'BILL_IAP_INVALID_INPUT', message: IAP_ERROR_MESSAGES.BILL_IAP_INVALID_INPUT, details: parsed.error.issues } },
        { status: IAP_ERROR_HTTP_STATUS.BILL_IAP_INVALID_INPUT, headers: NO_STORE },
      );
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('plan_store_products')
      .select('plan_key, store, billing_interval, product_id, offered')
      .eq('store', parsed.data.store)
      .eq('offered', true);
    if (error) throw error;
    const products = (data ?? []).filter((row): row is PlanStoreProductRow => isIapStore(row.store) && (row.billing_interval === 'month' || row.billing_interval === 'year'));
    const plans = await listPublicPlans();
    return NextResponse.json({ data: buildIapCatalog(parsed.data.store, plans, products) }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error);
  }
}
```

```ts
// tsc:skip place=src/app/api/billing/iap/sync/route.ts
/**
 * POST /api/billing/iap/sync — 本人のストアの契約を RevenueCat から取り直して写す (billing/03 §9.3)。
 * 本文は読まない (本人 = ログインの利用者。app_user_id は user.id)。購入・復元・画面を開いたとき・前面復帰にアプリが呼ぶ。
 * 応答は同期後の BillingSummary (GET /api/billing/subscription と同じ形)。
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { createBillingRepository, BillingRpcError } from '@/lib/billing/repository';
import { getBillingSummary } from '@/lib/billing/service';
import { syncStoreSubscriber } from '@/lib/billing/iap-service';
import { IAP_SYNC_SOURCE, IapError } from '@/lib/billing/iap-core';
import { billingErrorResponse, iapErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/iap/sync';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const deps = { gateway: createRevenueCatGateway(), repository: createIapRepository() };
    try {
      await syncStoreSubscriber(deps, user.id, IAP_SYNC_SOURCE);
    } catch (error) {
      // 別の live 行 (Stripe / 手動付与 / 別のストア) と衝突 → 409 (S13)。それ以外は下の catch
      if (error instanceof BillingRpcError && error.code === 'BILL_LIVE_ROW_CONFLICT') throw new IapError('BILL_IAP_SYNC_CONFLICT');
      throw error;
    }
    const summary = await getBillingSummary({ repository: createBillingRepository() }, user.id);
    return NextResponse.json({ data: summary }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return iapErrorResponse(ROUTE_NAME, error, { userId }) ?? billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
```

- `src/lib/billing/http.ts` に `iapErrorResponse(routeName, error, ctx): NextResponse | null` を足す: `IapError` → `IAP_ERROR_HTTP_STATUS` / `IAP_ERROR_MESSAGES` の固定の文、`RevenueCatNotConfiguredError` → 503 `EXT_REVENUECAT_NOT_CONFIGURED`、`RevenueCatApiError` → 502 `EXT_REVENUECAT_API_FAILED`。それ以外は `null` (呼び出し側が `billingErrorResponse` に渡す)。本文の形は `{ error: { code, message } }` (核と同じ)。
- `GET /api/billing/subscription` (`src/app/api/billing/subscription/route.ts`) の差分: 要約を作る前に `const row = await repository.findLiveSubscription(user.id)` を読み、`needsLazyResync(row, Date.now())` が真のときだけ `createRevenueCatGateway()` を試み (鍵が無ければ `RevenueCatNotConfiguredError` を捕まえて何もしない)、`lazyResyncStoreSubscription({ gateway, repository: createIapRepository() }, user.id, row)` を待ってから `getBillingSummary` を呼ぶ。`findLiveSubscription` は既存の repository の関数 (本冊で `SUBSCRIPTION_VIEW_COLUMNS` に `iap_store, iap_synced_at` を足す。§8.6)。この route は `createRevenueCatGateway` を import するので `@/lib/env` に届き、`EXEMPT_ROUTES` に載せる (§16.1)。凍結中も通す route のまま (認証は `requireUserAllowingFrozen` のまま)。冒頭のコメントの「Stripe を呼ばない (gateway を作らない・@/lib/billing/stripe-gateway を import しない) ので、鍵が無くても 200 (S11)。」の後に「RevenueCat は、期限を過ぎたストアの行のときだけ取り直す (鍵が無い・失敗のときは取り直さずに要約を返す。billing/03 §9.4)。」を足す。この route は `@/lib/env` を直接は import しない (`tests/api/billing-routes.test.ts:236-241` の直接の import の検査は緑のまま) が、`revenuecat-gateway.ts` を経て AI の印 (`src/lib/env.ts`) に届くので、同じファイルの `:244-263` の棚卸しでは「env.ts を経てだけ届く」側に移す (§16.1)。

### 8.6 `src/lib/billing/public-plans.ts` と `src/lib/billing/core.ts` の差分

```ts
// tsc:skip place=src/lib/billing/public-plans.ts — origin/main 4b1e1abe のファイル (#1911 が注とログの文を直した版) を土台にした全文。listPurchasablePlans (呼び出し元は src/app/pricing/page.tsx:10,22 だけ。git grep で確かめた) を listPublicPlans に置き換える。main との差分は (1) 関数の名前、(2) 絞り込み .not('stripe_price_id', 'is', null) を .gt('monthly_price_jpy', 0) に、(3) 列に max_members、(4) 戻り値の型 PublicPlan、(5) 先頭の注・関数の注・ログの文 (#1911 の「準備中と書かない」はそのまま守る) の 5 つ
/** 公開の面に出すプランの読み取り (billing/01 §10.1・billing/03 §8.6) */
import { createLogger } from '@/lib/db-logger';
import { createClient } from '@/lib/supabase/server';
import { FREE_PLAN_KEY, PURCHASABLE_PLAN_TYPES, type PublicPlan } from '@/lib/billing/core';

const logger = createLogger('billing/public-plans');

/** 読む列 (PublicPlan の列。max_members は家族の人数の表示に使う) */
const PLAN_COLUMNS =
  'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id, max_members';

/**
 * 公開の面に出すプラン (表示用。R2)。public・個人/家族・free でない・月額の金額が正。Stripe の Price の有無では絞らない
 * (鍵と Price が無い間も価格と内容を公開する。買えるかどうかは isPurchasable で間隔ごとに見る)。
 * 読み取りに失敗したら例外を投げずに空を返す (公開ページをエラーにしない)。失敗は error ログに残す
 */
export async function listPublicPlans(): Promise<PublicPlan[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('subscription_plans')
    .select(PLAN_COLUMNS)
    .eq('status', 'public')
    .in('plan_type', [...PURCHASABLE_PLAN_TYPES])
    .neq('plan_key', FREE_PLAN_KEY)
    .gt('monthly_price_jpy', 0)
    .order('display_order', { ascending: true });
  if (error) {
    logger.error('公開のプランの一覧を読めませんでした (/pricing はフリーのカードだけを描く)', error);
    return [];
  }
  return (data ?? []) as PublicPlan[];
}
```

```ts
// tsc:skip insert=src/lib/billing/core.ts — 差分 (位置は各行の注)。核の設計の約束 (§8.2 の import は zod だけ) は変えない
// (a) PurchasablePlan の下: 公開の面が読む列 (max_members を足した形)
export interface PublicPlan extends PurchasablePlan {
  max_members: number | null;
}
// (b) SubscriptionRowView に 2 列を足す (SUBSCRIPTION_VIEW_COLUMNS にも 'iap_store, iap_synced_at' を足す。repository.ts)
//   iap_store: string | null;
//   iap_synced_at: string | null;
// (c) BillingSummary の source の union を広げ、項目を 2 つ足す
//   source: 'stripe' | 'manual' | 'app_store' | 'play_store' | null;
//   /** ストアの契約なら、解約・支払い方法の変更をするストア (画面は管理のページへ案内する)。それ以外は null */
//   manage_in_store: 'app_store' | 'play_store' | null;
//   /** いま効いているプラン (effective_plan_key) の AI の上限 (画面の錠と案内。§10.3・§10.6) */
//   features: PlanFeatures;
// (d) 新しい型 (BillingSummary の上)
export interface PlanFeatures {
  /** ai_daily_limits の値 (プランの行、無ければ free の行。NULL = 無制限。consume_ai_usage_at の c_default_plan と同じ倒し方) */
  ai_daily_limit: number | null;
  /**
   * ai_plan_feature_caps のそのプランの行だけ (feature → daily_cap。0 = 使えない・NULL = 機能ごとの上限なし。行の無い機能は入らない)。
   * free の行には倒さない (DB の consume_ai_usage_at・ai_plan_feature_daily_cap も c.plan_key = いまのプラン だけを見る)。
   * 行の無いプラン (組織の plan の standard・org_* など) は {} で、画面の錠は出ない (S26)
   */
  ai_feature_caps: Record<string, number | null>;
}
export const EMPTY_PLAN_FEATURES: PlanFeatures = { ai_daily_limit: null, ai_feature_caps: {} };
// (e) summarizeSubscription の引数に features を足し、source / manage_in_store / can_cancel / can_resume をストアの行に合わせる
export function summarizeSubscription(row: SubscriptionRowView | null, hasCustomer: boolean, effectivePlanKey: string, features: PlanFeatures): BillingSummary {
  const status = row !== null && isSubscriptionStatus(row.status) ? row.status : null;
  const live = status !== null && isLiveStatus(status);
  const stripeBacked = row !== null && row.stripe_subscription_id !== null;
  const storeBacked = row !== null && (row.iap_store === 'app_store' || row.iap_store === 'play_store') ? row.iap_store : null;
  const interval = row !== null && row.billing_interval !== null && isBillingInterval(row.billing_interval) ? row.billing_interval : null;
  return {
    plan_key: live && row !== null ? row.plan_key : FREE_PLAN_KEY,
    effective_plan_key: effectivePlanKey,
    status,
    source: row === null ? null : stripeBacked ? 'stripe' : storeBacked ?? 'manual',
    manage_in_store: live ? storeBacked : null,
    billing_interval: interval,
    current_period_end: row?.current_period_end ?? null,
    trial_ends_at: row?.trial_ends_at ?? null,
    cancel_at_period_end: row?.cancel_at_period_end ?? false,
    cancel_at: row?.cancel_at ?? null,
    has_customer: hasCustomer,
    can_purchase: !live,
    can_cancel: live && stripeBacked && row !== null && !row.cancel_at_period_end,
    can_resume: live && stripeBacked && row !== null && row.cancel_at_period_end,
    features,
  };
}
// (f) BILLING_ERROR_MESSAGES は変えない (EXT_STRIPE_NOT_CONFIGURED は #1911 が「お支払いを受け付けていません」に直し済み。core.ts:241)
// (g) BillingRepository に 1 本足す (実装は repository.ts。下のブロック。1 日の上限はプランの行、無ければ free の行。
//     機能ごとの上限はそのプランの行だけで、free の行には倒さない)
//   findPlanFeatures(planKey: string): Promise<PlanFeatures>;
// (h) BILLING_STATUS_TEXT は変えない。ストアの行の 1 行目も同じ文 (「ご利用中」ほか)
```

```ts
// tsc:skip insert=src/lib/billing/repository.ts — 差分 3 つ: (1) @/lib/billing/core の import に FREE_PLAN_KEY と type PlanFeatures を足す。(2) SUBSCRIPTION_VIEW_COLUMNS の末尾に ', iap_store, iap_synced_at' を足す。(3) createBillingRepository が返すオブジェクトの hasUsedTrial の下に次を足す
    async findPlanFeatures(planKey: string): Promise<PlanFeatures> {
      // 1 日の上限: プランの行、無ければ free の行 (consume_ai_usage_at の「そのプランの行。無ければ 'free' の行 (それも無ければ NULL =
      // 無制限)」と同じ。行があって daily_limit が NULL なら無制限のまま)
      const { data: limitRows, error: limitError } = await admin
        .from('ai_daily_limits')
        .select('plan_key, daily_limit')
        .in('plan_key', [planKey, FREE_PLAN_KEY]);
      if (limitError) throw limitError;
      const ownLimit = (limitRows ?? []).find((row) => row.plan_key === planKey);
      const freeLimit = (limitRows ?? []).find((row) => row.plan_key === FREE_PLAN_KEY);
      // 機能ごとの上限: そのプランの行だけ。free の行には倒さない (consume_ai_usage_at と ai_plan_feature_daily_cap は c.plan_key = いまのプランだけを
      // 見るので、行の無いプランは機能ごとの上限なし。組織の plan (standard など) の究極モードは環境変数の既定で使える。S26)
      const { data: capRows, error: capError } = await admin
        .from('ai_plan_feature_caps')
        .select('feature, daily_cap')
        .eq('plan_key', planKey);
      if (capError) throw capError;
      const aiFeatureCaps: Record<string, number | null> = {};
      for (const row of capRows ?? []) aiFeatureCaps[row.feature] = row.daily_cap;
      return { ai_daily_limit: (ownLimit ?? freeLimit)?.daily_limit ?? null, ai_feature_caps: aiFeatureCaps };
    },
```

- `BillingSummary` の形は `packages/shared/src/billing-plans.ts` の `BillingSummaryWire` (モバイルが読む JSON の形。§8.9) と同じに保つ。`tests/billing-summary-wire.test.ts` (テスト 94) が、`summarizeSubscription` の戻り値を `BillingSummaryWire` の変数に代入できること (型) と `parseBillingSummaryWire` が null を返さないこと (値) を見る。
- `getBillingSummary` (`service.ts`) は `features = await deps.repository.findPlanFeatures(effectivePlanKey)` を読んで `summarizeSubscription(row, customer !== null, effectivePlanKey, features)` を呼ぶ (1 行の差分)。`summarizeSubscription` の呼び出し元 (`service.ts` の 4 か所・テスト) に 4 つ目の引数を足す。
- `manual-grant-repository.ts:101` の `source` の判定を `data.stripe_subscription_id === null ? (data.iap_store === null ? 'manual' : 'store') : 'stripe'` にし、`SUBSCRIPTION_COLUMNS` に `iap_store` を足す。`manual-grant.ts` の `source` の型に `'store'` を足し、運営の画面 (`ManualPlanGrantSection`) は `store` のときに「ストアの契約があります」と表示して付与のボタンを出さない (既存の「live な契約がある」の分岐と同じ扱い)。

### 8.7 `src/lib/env.ts` の差分 (`SERVER_ENV_VARS`)

```ts
// tsc:skip insert=src/lib/env.ts — SERVER_ENV_VARS の STRIPE_WEBHOOK_SECRET の行の下に足す
  REVENUECAT_SECRET_API_KEY: {
    required: false,
    description:
      'RevenueCat の秘密の API キー (sk_ で始まる値。Project Settings → API keys の secret key)。ストアの契約を取り直す GET /v1/subscribers に Authorization: Bearer で付ける (billing/03 §8.3)',
    whenMissing: 'RevenueCat の Webhook とアプリ内課金の同期の API が 503 を返す (購入・更新・解約が personal_subscriptions に写らない)。アプリの購入の画面は開ける',
  },
  REVENUECAT_WEBHOOK_SECRET: {
    required: false,
    description:
      'RevenueCat の Webhook の署名の秘密 (Integrations → Webhooks で署名を有効にすると 1 回だけ表示される値)。POST /api/webhooks/revenuecat が、届いたイベントの署名をこれで確かめる (billing/03 §8.2)',
    whenMissing: 'RevenueCat の Webhook を受け付けない (503)',
  },
```

- `.env.example` の課金の節に 2 行 (`REVENUECAT_SECRET_API_KEY=`・`REVENUECAT_WEBHOOK_SECRET=`) とコメント、`ENV_SETUP.md` の `4.` の Stripe の節に RevenueCat の 2 つを足す (§16.2)。
- モバイル (`apps/mobile/env.example`): `EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY=`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY=` (公開 SDK キー。秘密ではない。無いビルドは購入の画面がストアの購入を出さない。§8.10)。

### 8.8 `supabase/functions/_shared/ai-daily-limit.ts` (全文の置き換え) と、止めたときの文が届く先

`plan_locked` と、究極モード以外の機能ごとの上限 (`menu_generation`・`image_generation`・`meal_image_auto`) を、止めたときの文と応答を決める 1 つの関数 (`aiDailyLimitMessageOfDenied` / `aiDailyLimitPayload`) に入れる。既存の呼び出し元は止めた結果 (`AiUsageDenied`) をそのまま渡しているので、文はこの関数の中で正しくなる:

| 呼び出し元 (origin/main) | 使う関数 | 本冊の後の文 | ファイルの変更 |
|---|---|---|---|
| Next の AI の route (`src/lib/plan/entitlements.ts:255` `aiDailyLimitResponse`) | `aiDailyLimitPayload(denied)` | 403 `AI_FEATURE_NOT_IN_PLAN` (使えない機能) / 429 (回数) | コードはなし。冒頭のコメント (`:4`) だけ (§16.1 の「free = 10 の文」の行) |
| Edge の AI の関数 (`supabase/functions/_shared/ai-usage.ts:185` `aiDailyLimitEdgeResponse`) | `aiDailyLimitPayload(denied)` | 同上 | なし |
| Edge の献立の作成の行の失敗の欄 (`generate-menu-v4/index.ts:2908`・`generate-menu-v5/index.ts:3637`) | `aiDailyLimitMessageOfDenied(aiUsage)` | 「究極モードは、有料プランでお使いいただけます。」/「今日の献立の作成の利用回数の上限 (3 回) に達しました。…」 | なし (読む側の `isAiDailyLimitMessage` がこの文を通す) |
| AI 相談の自動実行の結果 (`src/lib/ai/consultation-action-executor.ts:299-301` `dailyLimitResult`) | `aiDailyLimitMessageOfDenied(denied)` | 同上 | **あり**: `code` を `denied.planLocked === true ? AI_FEATURE_NOT_IN_PLAN_CODE : AI_DAILY_LIMIT_CODE` にし、戻り値の型を `{ error: string; code: typeof AI_DAILY_LIMIT_CODE \| typeof AI_FEATURE_NOT_IN_PLAN_CODE }` にする (import に `AI_FEATURE_NOT_IN_PLAN_CODE` を足す) |
| 行の失敗の文の読み手 (`src/lib/weekly-menu-request-error.ts`・`src/lib/shopping-list-request-error.ts`・`apps/mobile/src/lib/menu-request-error.ts`・`supabase/functions/_shared/stored-failure-messages.ts`) | `isAiDailyLimitMessage(value)` | 使えない機能の文と機能ごとの上限の文も「こちらで書いた文」として出す (テスト 108) | 判定のコードはなし。コメントだけ 3 本: `weekly-menu-request-error.ts` の冒頭 (`:12-13`) と `:53`・`:60`、`stored-failure-messages.ts` の `:13-14` と `:61`、`menu-request-error.ts` の `:16` の「上限 (1 日・究極モード) の文」を「上限 (1 日・機能ごと) とそのプランでは使えない機能 (billing/03) の文」にする。`shopping-list-request-error.ts` は変えない (`:15-16` は「など」で閉じておらず、買い物リストの作り直しが数える `shopping_list` は `AI_PLAN_CAPPED_FEATURES` に無いので、使えない機能の文を書かない) |
| Web の画面 (`src/lib/ai/daily-limit-client.ts` `aiDailyLimitMessageOfResponse`) | `aiDailyLimitMessageOfStatusAndBody` (状態と本文の code の組を見てから `aiDailyLimitMessageOfBody`) | 429 + `AI_DAILY_LIMIT` の本文 (従来どおり) と 403 + `AI_FEATURE_NOT_IN_PLAN` の本文から文を作る。組が合わないもの (403 + `AI_DAILY_LIMIT`・429 + `AI_FEATURE_NOT_IN_PLAN`・同意の 403・レート制限の 429) は null | **あり** (下の箇条) |
| モバイル (`apps/mobile/src/lib/ai-daily-limit.ts` `aiDailyLimitErrorOf`) | `aiDailyLimitMessageOfStatusAndBody` | 同上 | **あり** (下の箇条) |
| 料理の保存の自動の料理画像 (4 本の route と AI 相談の自動実行。`aiDailyLimitSkippedField`) | `aiDailyLimitSkippedField(imageUsage)` | `planLocked` のときは `aiSkipped` を付けない | なし (関数の中で変わる)。見送りの理由だけ下の meal-image の差分で変える |

全文 (import なし。単独で型検査できる。既存の export はすべて同じ名前・同じ意味で残し、`AiDailyCappedFeature`・`AI_DAILY_CAPPED_FEATURES` も残す (`tests/ai-usage-contract.test.ts` が `AI_CAPPED_FEATURES` と突き合わせる)):

```ts
/**
 * AI の 1 日の利用回数の上限 (#1149 / T40) と、プランごとの機能の上限 (billing/03 §6.5) - Next.js API Routes / Supabase Edge Functions /
 * Web の画面 / モバイルのアプリ 共用
 *
 * ここにあるのは次のもの。
 *  - DB の consume_ai_usage の戻り値の読み取り (parseConsumeAiUsageResult) と、判定の結果の型 (AiUsageResult)
 *  - 止めたときの応答の形 (aiDailyLimitPayload。429 AI_DAILY_LIMIT = 回数の上限 / 403 AI_FEATURE_NOT_IN_PLAN = そのプランでは使えない機能) と、
 *    画面に出す文 (aiDailyLimitMessage / aiDailyLimitMessageOfBody / aiDailyLimitMessageOfStatusAndBody / aiDailyLimitMessageOfDenied。上限に数えない機能の安全弁で止めたときは
 *    AI_AUTO_SAFETY_CAP_MESSAGE、機能ごとの 1 日の上限で止めたときは aiFeatureDailyLimitMessage (究極モードは aiUltimateModeDailyLimitMessage)、
 *    そのプランでは使えない機能で止めたときは aiFeatureNotInPlanMessage)
 *  - 行に書かれた文が、上のどれかの文か (isAiDailyLimitMessage。画面が行の失敗の文をそのまま出してよいかの判定)
 *  - 次の JST の 0 時 (上限が戻る時刻) までの秒数 (secondsUntilNextJstMidnight)
 *  - AI の部分を省いた応答の欄 (aiDailyLimitSkippedField)
 *
 * 機能の一覧・上限に数えない機能 (AI_UNMETERED_FEATURES)・記録済みの印は _shared/ai-usage-core.ts。
 *
 * このファイルが守る制約 (崩すと Edge Functions・Next.js・モバイルのどれかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node / ブラウザ / React Native 固有の API なし (crypto も TextEncoder も使わない)。
 *    モバイル (apps/mobile/src/lib/ai-daily-limit.ts) が相対パスで import し、EAS のビルドに入る (.easignore で残している)。
 */

/** 上限に達して止めたときの応答のコード (本文の code・aiSkipped) */
export const AI_DAILY_LIMIT_CODE = "AI_DAILY_LIMIT";
/** 上限に達して止めたときの HTTP の状態 (Too Many Requests) */
export const AI_DAILY_LIMIT_STATUS = 429;
/** そのプランでは使えない機能 (ai_plan_feature_caps の daily_cap = 0) で止めたときの応答のコード (billing/03 §6.5) */
export const AI_FEATURE_NOT_IN_PLAN_CODE = "AI_FEATURE_NOT_IN_PLAN";
/** そのプランでは使えない機能で止めたときの HTTP の状態 (Forbidden。明日になっても使えないので 429 にしない) */
export const AI_FEATURE_NOT_IN_PLAN_STATUS = 403;

/**
 * JST の UTC からのオフセット (ミリ秒)。日本は夏時間が無いので常に +9 時間。
 * _shared/jst-date.ts の JST_OFFSET_MS と同じ値 (このファイルは import を持たないので、ここにも置く。
 * tests/ai-daily-limit-core.test.ts が一致を確かめる)
 */
export const AI_USAGE_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 1 日のミリ秒 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MS_PER_SEC = 1000;

/** 次の JST の 0 時 (上限が戻る時刻) までの秒数。切り上げで、少なくとも 1 秒 */
export function secondsUntilNextJstMidnight(nowMs: number = Date.now()): number {
  const jstMs = nowMs + AI_USAGE_JST_OFFSET_MS;
  const nextMidnightJstMs = (Math.floor(jstMs / DAY_MS) + 1) * DAY_MS;
  return Math.max(1, Math.ceil((nextMidnightJstMs - jstMs) / MS_PER_SEC));
}

/** 上限に達したときに画面に出す文 (Web・モバイル・Edge Function の応答の error) */
export function aiDailyLimitMessage(limit: number): string {
  return `今日の AI の利用回数の上限 (${limit} 回) に達しました。明日 0 時から使えます。`;
}

/** 回数が分からないときの文 (応答の本文が壊れていたときなど) */
export const AI_DAILY_LIMIT_FALLBACK_MESSAGE = "今日の AI の利用回数の上限に達しました。明日 0 時から使えます。";

/**
 * 上限に数えない機能の安全弁 (DB の ai_unmetered_daily_caps) で止めたときに画面に出す文 (#1487。Web・モバイル共用)。
 * 回数は出さない (安全弁の回数 (例: 30) は明示の 1 日の上限と別のもので、数字を出すと食い違って見えるため)。
 * 安全弁で 429 を返す入口は、栄養士のコメントの自動の取得 (POST /api/ai/nutrition/feedback の forceRefresh なし =
 * nutrition_advice_auto) だけ (ホームの栄養のアドバイスは AI の部分を省き、料理画像は画像だけ見送るので 429 にしない)
 */
export const AI_AUTO_SAFETY_CAP_MESSAGE = "今日はこれ以上、自動のコメントを作れません。明日また表示されます。";

/**
 * プランごとの機能の上限 (DB の ai_plan_feature_caps。billing/03 §6.5) を持てる機能。DB の CHECK
 * (ai_plan_feature_caps_feature_check) と同じ 4 つ (tests/billing-paid-plans-migration-contract.test.ts が突き合わせる)。
 * DB の consume_ai_usage / consume_ai_usage_capped は、止めたときこのどれかを capped_feature で返す
 */
export const AI_PLAN_CAPPED_FEATURES = ["menu_generation_ultimate", "menu_generation", "image_generation", "meal_image_auto"] as const;

/** プランごとの機能の上限を持てる機能の名前 */
export type AiPlanCappedFeature = (typeof AI_PLAN_CAPPED_FEATURES)[number];

const isPlanCappedFeature = (value: unknown): value is AiPlanCappedFeature =>
  typeof value === "string" && (AI_PLAN_CAPPED_FEATURES as readonly string[]).includes(value);

/**
 * 機能ごとの 1 日の上限が呼び出し側の環境変数でも決まる機能 (#1142。究極モード。ai_plan_feature_caps に行の無いプランは
 * 環境変数 AI_ULTIMATE_MODE_DAILY_LIMIT の上限)。_shared/ai-usage-core.ts の AI_CAPPED_FEATURES と同じ
 * (このファイルは import を持たないので、ここにも置く。tests/ai-usage-contract.test.ts が突き合わせる)
 */
export const AI_DAILY_CAPPED_FEATURES = ["menu_generation_ultimate"] as const satisfies readonly AiPlanCappedFeature[];

/** 機能ごとの 1 日の上限が環境変数でも決まる機能の名前 */
export type AiDailyCappedFeature = (typeof AI_DAILY_CAPPED_FEATURES)[number];

/** 機能の表示名 (機能ごとの上限の文と、使えない機能の文に入れる) */
export const AI_PLAN_CAPPED_FEATURE_LABELS: Readonly<Record<AiPlanCappedFeature, string>> = {
  menu_generation_ultimate: "究極モード",
  menu_generation: "献立の作成",
  image_generation: "料理画像の作成",
  meal_image_auto: "料理画像の作成",
};

/**
 * 機能ごとの 1 日の上限 (daily_cap > 0) に達したときに画面に出す文 (Web・モバイル・Edge Function の応答の error)。
 * 1 日の AI の上限 (aiDailyLimitMessage) と同じ形で、何の上限かだけを変える
 */
export function aiFeatureDailyLimitMessage(feature: AiPlanCappedFeature, limit: number): string {
  return `今日の${AI_PLAN_CAPPED_FEATURE_LABELS[feature]}の利用回数の上限 (${limit} 回) に達しました。明日 0 時から使えます。`;
}

/** 究極モードの 1 日の上限 (#1142) に達したときの文 (aiFeatureDailyLimitMessage の究極モードの文と同じ。既存の呼び出しのために残す) */
export function aiUltimateModeDailyLimitMessage(limit: number): string {
  return aiFeatureDailyLimitMessage("menu_generation_ultimate", limit);
}

/** そのプランでは使えない機能 (daily_cap = 0) で止めたときに画面に出す文 */
export function aiFeatureNotInPlanMessage(feature: AiPlanCappedFeature): string {
  return `${AI_PLAN_CAPPED_FEATURE_LABELS[feature]}は、有料プランでお使いいただけます。`;
}

/** そのプランでは使えない機能で止めたが、機能名が分からないとき (本文が壊れていたときなど) の文 */
export const AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE = "この機能は、有料プランでお使いいただけます。";

/**
 * 回数の入った上限の文 (aiDailyLimitMessage(n) と、機能ごとの上限の文 aiFeatureDailyLimitMessage(feature, n)) から
 * 回数を取り出す形。取り出した回数で文を作り直し、一字一句同じかを確かめる (形が合うだけでは通さない)
 */
const AI_LIMIT_MESSAGE_COUNT_PATTERN = /^今日の.+?の利用回数の上限 \((\d+) 回\)/;

/** 回数 limit で止めたときに書きうる、回数の入った上限の文 (1 日の上限の文と、AI_PLAN_CAPPED_FEATURES の各機能の文) */
function aiLimitMessagesWithCount(limit: number): readonly string[] {
  return [aiDailyLimitMessage(limit), ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiFeatureDailyLimitMessage(feature, limit))];
}

/** そのプランでは使えない機能で止めたときに書きうる文 (回数を含まない) */
const AI_FEATURE_NOT_IN_PLAN_MESSAGES: readonly string[] = [
  ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiFeatureNotInPlanMessage(feature)),
  AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE,
];

/**
 * 止めたときの文のどれかか (#1478・#1142・billing/03)。aiDailyLimitMessageOfDenied / aiDailyLimitMessageOfBody が作りうる文を、すべて通す:
 *   aiDailyLimitMessage(n)・機能ごとの上限の文 (aiFeatureDailyLimitMessage(feature, n))・そのプランでは使えない機能の文
 *   (aiFeatureNotInPlanMessage(feature)・AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE)・AI_DAILY_LIMIT_FALLBACK_MESSAGE・AI_AUTO_SAFETY_CAP_MESSAGE
 * 生成のリクエストの行の失敗の欄 (Edge Function の generate-menu-v4 / v5 が aiDailyLimitMessageOfDenied で書く) を、
 * 画面 (Web・モバイル) が「こちらで書いた文」としてそのまま出してよいかの判定に使う (それ以外の文は汎用の文に寄せる)
 */
export function isAiDailyLimitMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === AI_DAILY_LIMIT_FALLBACK_MESSAGE || value === AI_AUTO_SAFETY_CAP_MESSAGE) return true;
  if (AI_FEATURE_NOT_IN_PLAN_MESSAGES.includes(value)) return true;
  const match = AI_LIMIT_MESSAGE_COUNT_PATTERN.exec(value);
  return match !== null && aiLimitMessagesWithCount(Number(match[1])).includes(value);
}

/**
 * AI の部分を省いた応答の aiSkipped に入れる値は AI_DAILY_LIMIT_CODE (aiDailyLimitSkippedField)。
 * 画面の出し分け (aiSkippedReasonOf の 'daily_limit') と省いたときの一文は _shared/ai-consent.ts (同意で省いたときと同じ場所)。
 * そのプランでは使えない機能で止めたとき (planLocked。無料の自動の料理画像) は付けない (回数の上限ではないので、上限の一文を出させない。
 * 料理の画面は料理の image_error = 'skipped_plan' で有料プランの案内を出す。billing/03 §8.8)
 */
export function aiDailyLimitSkippedField(result: AiUsageResult | null): { aiSkipped?: typeof AI_DAILY_LIMIT_CODE } {
  return result && !result.allowed && result.planLocked !== true ? { aiSkipped: AI_DAILY_LIMIT_CODE } : {};
}

/** 上限の判定で、許可したとき */
export interface AiUsageAllowed {
  allowed: true;
  /** 上限に数えたか (上限に数えない機能・Next.js が数え済み・判定に失敗したときは false) */
  metered: boolean;
  /** 数えた日 (JST の暦日 YYYY-MM-DD)。数え戻し (refund_ai_usage) に渡す。数えていなければ null */
  usageDate: string | null;
  /** 1 日の上限 (null は無制限か、判定していない) */
  limit: number | null;
  /** 数えたあとの、その日の回数 (判定していなければ null) */
  used: number | null;
}

/** 上限の判定で、止めたとき (記録していない) */
export interface AiUsageDenied {
  allowed: false;
  limit: number;
  used: number;
  usageDate: string;
  /**
   * 上限に数えない機能の安全弁 (ai_unmetered_daily_caps) で止めたとき true (DB の戻り値の metered が false。#1487)。
   * 明示の 1 日の上限で止めたときは付けない。limit はそのときの安全弁の回数で、画面には出さない
   */
  safetyCap?: true;
  /**
   * 機能ごとの上限 (#1142 の究極モード・billing/03 の ai_plan_feature_caps) で止めたときの機能名 (DB の戻り値の capped_feature)。
   * limit・used はその機能の上限と回数。1 日の上限 (合計) で止めたときは付けない
   */
  cappedFeature?: AiPlanCappedFeature;
  /**
   * そのプランでは使えない機能 (ai_plan_feature_caps の daily_cap = 0) で止めたとき true (DB の戻り値の plan_locked。billing/03 §6.5)。
   * cappedFeature があるときだけ付く。limit は 0。応答は 403 AI_FEATURE_NOT_IN_PLAN
   */
  planLocked?: true;
}

export type AiUsageResult = AiUsageAllowed | AiUsageDenied;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isDateString = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * DB の consume_ai_usage の戻り値 (jsonb) を読む。形が違えば null (呼び出し側は判定の失敗として扱い、許可する)。
 *   許可: { allowed: true,  metered, plan, limit (null 可), used (null 可), usage_date }
 *   止め: { allowed: false, metered: true, plan, limit, used, usage_date }
 *         (機能ごとの上限で止めたときは capped_feature、そのプランでは使えない機能のときは plan_locked: true も付く)
 */
export function parseConsumeAiUsageResult(data: unknown): AiUsageResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (!isDateString(row.usage_date)) return null;
  if (row.allowed === false) {
    if (!isInt(row.limit) || !isInt(row.used)) return null;
    const denied: AiUsageDenied = { allowed: false, limit: row.limit, used: row.used, usageDate: row.usage_date };
    // 上限に数えない機能の安全弁で止めた (DB は metered: false を返す)。明示の上限で止めたときは metered: true
    if (row.metered === false) denied.safetyCap = true;
    // 機能ごとの上限で止めた。知らない機能名は付けない (1 日の上限の文になる)
    if (isPlanCappedFeature(row.capped_feature)) {
      denied.cappedFeature = row.capped_feature;
      // そのプランでは使えない機能 (cap 0)。機能名が分かるときだけ (文に機能名が要るため)
      if (row.plan_locked === true) denied.planLocked = true;
    }
    return denied;
  }
  if (row.allowed !== true) return null;
  return {
    allowed: true,
    metered: row.metered !== false,
    usageDate: row.usage_date,
    limit: isInt(row.limit) ? row.limit : null,
    used: isInt(row.used) ? row.used : null,
  };
}

/** 判定をせずに許可したとき (判定に失敗した・Next.js が数え済み) の結果 */
export const AI_USAGE_NOT_COUNTED: AiUsageAllowed = Object.freeze({
  allowed: true,
  metered: false,
  usageDate: null,
  limit: null,
  used: null,
});

/** 回数の上限に達したときの応答の本文 (429) */
export interface AiDailyLimitBody {
  error: string;
  code: typeof AI_DAILY_LIMIT_CODE;
  /** 1 日の上限の回数 (安全弁で止めたときは出さない。safetyCap を見る) */
  limit?: number;
  /** 上限に数えない機能の安全弁で止めたとき true (#1487。画面は AI_AUTO_SAFETY_CAP_MESSAGE を出す) */
  safetyCap?: true;
  /** 機能ごとの 1 日の上限で止めたときの機能名 (画面は aiFeatureDailyLimitMessage を出す)。limit はその機能の上限 */
  cappedFeature?: AiPlanCappedFeature;
  /** 使えるようになるまでの秒数 (次の JST の 0 時まで) */
  retryAfter: number;
}

/** そのプランでは使えない機能で止めたときの応答の本文 (403。明日になっても使えないので retryAfter・limit を持たない) */
export interface AiFeatureNotInPlanBody {
  error: string;
  code: typeof AI_FEATURE_NOT_IN_PLAN_CODE;
  feature: AiPlanCappedFeature;
}

/** 止めたときの応答の本文 (aiDailyLimitPayload が返す 2 つの形) */
export type AiUsageDeniedBody = AiDailyLimitBody | AiFeatureNotInPlanBody;

/** 止めた理由のうち、文と応答を決める項目 */
export type AiUsageDenialReason = Pick<AiUsageDenied, "limit" | "safetyCap" | "cappedFeature" | "planLocked">;

/**
 * 止めたときに画面に出す文 (止めた理由で選ぶ)。応答の本文の error・生成のリクエストの行の error_message・AI 相談のアクションの結果が使う。
 *   安全弁 (safetyCap) → AI_AUTO_SAFETY_CAP_MESSAGE / そのプランでは使えない機能 (planLocked) → aiFeatureNotInPlanMessage /
 *   機能ごとの上限 (cappedFeature) → aiFeatureDailyLimitMessage / それ以外 → 1 日の上限の文
 */
export function aiDailyLimitMessageOfDenied(denied: AiUsageDenialReason): string {
  if (denied.safetyCap) return AI_AUTO_SAFETY_CAP_MESSAGE;
  if (denied.cappedFeature && denied.planLocked) return aiFeatureNotInPlanMessage(denied.cappedFeature);
  if (denied.cappedFeature) return aiFeatureDailyLimitMessage(denied.cappedFeature, denied.limit);
  return aiDailyLimitMessage(denied.limit);
}

/**
 * 止めたときの応答 (状態・ヘッダー・本文)。Next.js と Edge Function が同じ形で返す。
 *   - そのプランでは使えない機能 (denied.planLocked): 403 AI_FEATURE_NOT_IN_PLAN。本文 { error, code, feature }。Retry-After を付けない
 *   - 安全弁 (denied.safetyCap): 429。回数を出さない固定の文 (AI_AUTO_SAFETY_CAP_MESSAGE)、本文に limit を入れない
 *   - 機能ごとの上限 (denied.cappedFeature): 429。その機能の文、本文に cappedFeature を入れる
 *   - それ以外: 429。1 日の上限の文
 */
export function aiDailyLimitPayload(
  denied: AiUsageDenialReason,
  nowMs: number = Date.now(),
): { status: number; headers: Record<string, string>; body: AiUsageDeniedBody } {
  if (denied.cappedFeature && denied.planLocked && !denied.safetyCap) {
    const feature = denied.cappedFeature;
    return {
      status: AI_FEATURE_NOT_IN_PLAN_STATUS,
      headers: {},
      body: { error: aiFeatureNotInPlanMessage(feature), code: AI_FEATURE_NOT_IN_PLAN_CODE, feature },
    };
  }
  const retryAfter = secondsUntilNextJstMidnight(nowMs);
  const error = aiDailyLimitMessageOfDenied(denied);
  const body: AiDailyLimitBody = denied.safetyCap
    ? { error, code: AI_DAILY_LIMIT_CODE, safetyCap: true, retryAfter }
    : denied.cappedFeature
      ? { error, code: AI_DAILY_LIMIT_CODE, limit: denied.limit, cappedFeature: denied.cappedFeature, retryAfter }
      : { error, code: AI_DAILY_LIMIT_CODE, limit: denied.limit, retryAfter };
  return {
    status: AI_DAILY_LIMIT_STATUS,
    headers: { "Retry-After": String(retryAfter) },
    body,
  };
}

/**
 * 応答の本文が「止めた」ことを表すなら、画面に出す文を返す (そうでなければ null)。
 * { code: 'AI_DAILY_LIMIT' | 'AI_FEATURE_NOT_IN_PLAN' } のほか、{ error: { code } } の入れ子の形も受け付ける。
 * 文は本文の error をそのまま使わず、limit・機能名からこちらで作る (本文の文を画面にそのまま出さない)。
 */
export function aiDailyLimitMessageOfBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { code, error, limit, safetyCap, cappedFeature, feature } = body as {
    code?: unknown;
    error?: unknown;
    limit?: unknown;
    safetyCap?: unknown;
    cappedFeature?: unknown;
    feature?: unknown;
  };
  const nested =
    error && typeof error === "object"
      ? (error as { code?: unknown; limit?: unknown; safetyCap?: unknown; cappedFeature?: unknown; feature?: unknown })
      : null;
  // そのプランでは使えない機能 (billing/03)
  if (code === AI_FEATURE_NOT_IN_PLAN_CODE || nested?.code === AI_FEATURE_NOT_IN_PLAN_CODE) {
    const lockedFeature = isPlanCappedFeature(feature) ? feature : isPlanCappedFeature(nested?.feature) ? nested.feature : null;
    return lockedFeature ? aiFeatureNotInPlanMessage(lockedFeature) : AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE;
  }
  if (code !== AI_DAILY_LIMIT_CODE && nested?.code !== AI_DAILY_LIMIT_CODE) return null;
  // 安全弁で止めたときは回数を出さない固定の文 (#1487)
  if (safetyCap === true || nested?.safetyCap === true) return AI_AUTO_SAFETY_CAP_MESSAGE;
  const value = isInt(limit) ? limit : isInt(nested?.limit) ? nested.limit : null;
  if (value === null || value < 0) return AI_DAILY_LIMIT_FALLBACK_MESSAGE;
  // 機能ごとの上限で止めたときは、その機能の文
  const capped = isPlanCappedFeature(cappedFeature) ? cappedFeature : isPlanCappedFeature(nested?.cappedFeature) ? nested.cappedFeature : null;
  return capped ? aiFeatureDailyLimitMessage(capped, value) : aiDailyLimitMessage(value);
}

/** 本文の code (平らな { code } と入れ子の { error: { code } })。止めたときの 2 つのコードのどちらでもなければ null。順は aiDailyLimitMessageOfBody と同じ (使えない機能が先) */
function deniedCodeOfBody(body: unknown): typeof AI_DAILY_LIMIT_CODE | typeof AI_FEATURE_NOT_IN_PLAN_CODE | null {
  if (!body || typeof body !== "object") return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  const nestedCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === AI_FEATURE_NOT_IN_PLAN_CODE || nestedCode === AI_FEATURE_NOT_IN_PLAN_CODE) return AI_FEATURE_NOT_IN_PLAN_CODE;
  if (code === AI_DAILY_LIMIT_CODE || nestedCode === AI_DAILY_LIMIT_CODE) return AI_DAILY_LIMIT_CODE;
  return null;
}

/**
 * HTTP の状態と本文の組から、画面に出す文を返す (組が合わなければ null)。状態と code の組の正本はここだけで、
 * Web の aiDailyLimitMessageOfResponse (src/lib/ai/daily-limit-client.ts) とモバイルの aiDailyLimitErrorOf
 * (apps/mobile/src/lib/ai-daily-limit.ts) が使う。aiDailyLimitMessageOfBody は状態を見ないので、画面の側から直接呼ばない。
 *   - 429 (AI_DAILY_LIMIT_STATUS): 本文の code が AI_DAILY_LIMIT のときだけ。レート制限の 429 (RATE_LIMITED) は null
 *   - 403 (AI_FEATURE_NOT_IN_PLAN_STATUS): 本文の code が AI_FEATURE_NOT_IN_PLAN のときだけ。同意の 403
 *     (AI_CONSENT_REQUIRED・LEGAL_CONSENT_REQUIRED) と、403 に AI_DAILY_LIMIT の本文が付いたもの (aiDailyLimitPayload はこの組を作らない) は null
 *   - 429 に AI_FEATURE_NOT_IN_PLAN の本文が付いたもの・ほかの状態: null
 */
export function aiDailyLimitMessageOfStatusAndBody(status: number, body: unknown): string | null {
  const code = deniedCodeOfBody(body);
  if (code === null) return null;
  const pairedStatus = code === AI_FEATURE_NOT_IN_PLAN_CODE ? AI_FEATURE_NOT_IN_PLAN_STATUS : AI_DAILY_LIMIT_STATUS;
  return status === pairedStatus ? aiDailyLimitMessageOfBody(body) : null;
}
```

- `src/lib/ai/daily-limit-client.ts` の `aiDailyLimitMessageOfResponse` を次にする (import は `AI_DAILY_LIMIT_STATUS`・`AI_FEATURE_NOT_IN_PLAN_STATUS`・`aiDailyLimitMessageOfStatusAndBody` の 3 つにし、`aiDailyLimitMessageOfBody` の import は消す)。状態と本文の code の組は `aiDailyLimitMessageOfStatusAndBody` が見るので、403 + `AI_DAILY_LIMIT` の本文は従来どおり null (`tests/ai-daily-limit-client.test.tsx:40-45` の it `'レート制限の 429・ほかの状態・JSON でない本文は null'` の `:42` は変えずに緑)、同意の 403 (`AI_CONSENT_REQUIRED`。`aiFetch` が先に `isAiConsentRequiredResponse` で見る) とも取り違えない。最初の状態の判定は、本文を読む前の近道 (200 などで clone しない)。`aiFetch` は文があれば `notifyAiDailyLimit(message)` で全画面共通の案内を出す (既存の経路)。

```ts
// tsc:skip place=src/lib/ai/daily-limit-client.ts (import の 1 行と aiDailyLimitMessageOfResponse を置き換える。ほかは変えない)
import {
  AI_DAILY_LIMIT_STATUS,
  AI_FEATURE_NOT_IN_PLAN_STATUS,
  aiDailyLimitMessageOfStatusAndBody,
} from '../../../supabase/functions/_shared/ai-daily-limit';

/**
 * 応答が「止めた」(429 + AI_DAILY_LIMIT の本文、または 403 + AI_FEATURE_NOT_IN_PLAN の本文) なら、画面に出す文を返す。
 * 状態と本文の code の組が合わないものは null。本文は clone して読むので、呼び出し側はあとで本文を読める
 */
export async function aiDailyLimitMessageOfResponse(res: Response): Promise<string | null> {
  if (res.status !== AI_DAILY_LIMIT_STATUS && res.status !== AI_FEATURE_NOT_IN_PLAN_STATUS) return null;
  try {
    return aiDailyLimitMessageOfStatusAndBody(res.status, await res.clone().json());
  } catch {
    return null;
  }
}
```
- `apps/mobile/src/lib/ai-daily-limit.ts` の `aiDailyLimitErrorOf` を次にする (1 つ目の import を下の 3 つにし、`aiDailyLimitMessageOfBody` の import は消す。再 export の 3 つ (`AI_AUTO_SAFETY_CAP_MESSAGE`・`AI_DAILY_LIMIT_FALLBACK_MESSAGE`・`aiDailyLimitMessage`) と `AiDailyLimitError`・`isAiDailyLimitError`・`HTTP_ERROR_PATTERN` は変えない)。組は Web と同じ関数が見るので、HTTP 403 + `AI_DAILY_LIMIT` の本文は null のまま。`withFriendlyErrors` (`apps/mobile/src/lib/api.ts:83`) と `errorOfFailedResponse` (`apps/mobile/src/lib/failed-response.ts:71`) は `aiDailyLimitErrorOf` を最初に見るので `legalConsentRequiredErrorOf` (403) より前に判定されるが、置き換えるのは本文の `code` が `AI_FEATURE_NOT_IN_PLAN` の 403 だけなので取り違えない (`apps/mobile/__tests__/lib/ai-daily-limit.test.ts:59-65` の it と、同じファイルの `errorOfFailedResponse` の同意の 403 の期待は変えずに緑)。

```ts
// tsc:skip place=apps/mobile/src/lib/ai-daily-limit.ts (1 つ目の import と aiDailyLimitErrorOf を置き換える。ほかは変えない)
import {
  AI_DAILY_LIMIT_STATUS,
  AI_FEATURE_NOT_IN_PLAN_STATUS,
  aiDailyLimitMessageOfStatusAndBody,
} from "../../../../supabase/functions/_shared/ai-daily-limit";

/**
 * API クライアントが投げた Error が「止めた」(HTTP 429 + AI_DAILY_LIMIT の本文、または HTTP 403 + AI_FEATURE_NOT_IN_PLAN の本文) なら、
 * 画面に出す文の AiDailyLimitError を返す。組が合わないもの (レート制限の 429・同意の 403・403 + AI_DAILY_LIMIT)・ほかの状態・
 * JSON でない本文は null。
 */
export function aiDailyLimitErrorOf(error: unknown): AiDailyLimitError | null {
  if (isAiDailyLimitError(error)) return error;
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (!match) return null;
  const status = Number(match[1]);
  if (status !== AI_DAILY_LIMIT_STATUS && status !== AI_FEATURE_NOT_IN_PLAN_STATUS) return null;
  try {
    const message = aiDailyLimitMessageOfStatusAndBody(status, JSON.parse(match[2]));
    return message ? new AiDailyLimitError(message) : null;
  } catch {
    return null;
  }
}
```
- 料理の保存の自動の料理画像 (`meal_image_auto`) の見送りの理由を分け、料理画像のジョブの処理にプランの門を足す (`supabase/functions/_shared/meal-image.ts`。再 export の `lib/meal-image.ts` の名前の一覧に `mealImageSkipReasonOf`・`isMealImagePlanSkippedError`・`mealImageJobPlanDecision`・`MealImageJobPlanDecision` を足す。主菜の 1 品だけに絞る名前 (`AUTO_IMAGE_DISH_ROLES`・`AUTO_IMAGE_FALLBACK_DISH_INDEX`・`autoImageDishIndexOf`・`mealCoverRepresentsDish`) は下の「自動の料理画像は献立の主菜の 1 品だけ」の箇条で足す):

```ts
// tsc:skip insert=supabase/functions/_shared/meal-image.ts — MealImageSkipReason・MEAL_IMAGE_SKIPPED_ERRORS を置き換え、isMealImageSkippedError の下に 3 つの関数と 1 つの型を足す
/**
 * 料理画像のジョブを積まずに見送ったときの理由 (#1487・billing/03)。
 *   - ai_limit:   料理画像の安全弁 (DB の ai_unmetered_daily_caps の meal_image_auto) に達した (consumeAiUsage が不許可)
 *   - rate_limit: 画像のレート制限 (checkRateLimit の 'image') に達した、または判定が例外で終わった
 *   - plan:       ご利用中のプランでは自動の料理画像を作らない (ai_plan_feature_caps の meal_image_auto = 0。DB の plan_locked)
 */
export type MealImageSkipReason = 'ai_limit' | 'rate_limit' | 'plan';

export const MEAL_IMAGE_SKIPPED_ERRORS: Readonly<Record<MealImageSkipReason, string>> = Object.freeze({
  ai_limit: 'skipped_ai_limit',
  rate_limit: 'skipped_rate_limit',
  plan: 'skipped_plan',
});

/**
 * consumeAiUsage(user, 'meal_image_auto') の結果から見送りの理由を決める (4 本の route と AI 相談の自動実行が同じ式で使う)。
 * 判定していない (null) か許可されたのに見送るのはレート制限のときだけ
 */
export function mealImageSkipReasonOf(usage: { allowed: boolean; planLocked?: true } | null): MealImageSkipReason {
  if (usage === null || usage.allowed) return 'rate_limit';
  return usage.planLocked === true ? 'plan' : 'ai_limit';
}

/** image_error が、プランで見送った (skipped_plan) ことを表すか (料理の画面が有料プランの案内を出す) */
export function isMealImagePlanSkippedError(value: unknown): boolean {
  return value === MEAL_IMAGE_SKIPPED_ERRORS.plan;
}

/**
 * 料理画像のジョブを AI へ送る前の、プランの門の答え (billing/03 §8.8)。process-meal-image-jobs が、同意の判定のすぐ後に使う。
 * cap は DB の ai_plan_feature_daily_cap(ジョブの持ち主, 'meal_image_auto') の戻り値。
 *   0 → locked (そのプランでは自動の料理画像を作らない。ジョブを取り消し、料理を failed + skipped_plan にする)
 *   null (行なし)・正の数・読めなかった値 → allowed (読めなかったときは止めない。consume_ai_usage の「判定に失敗したときは止めない」と同じ)
 */
export type MealImageJobPlanDecision = 'locked' | 'allowed';
export function mealImageJobPlanDecision(cap: unknown): MealImageJobPlanDecision {
  return cap === 0 ? 'locked' : 'allowed';
}
```

- 料理画像のジョブの処理 `supabase/functions/process-meal-image-jobs/index.ts` にプランの門を足す (F22。献立の作成 (`save-meal`) が積んだジョブは数えていないので、無料の利用者の献立の作成の画像を止めるのはここだけ。料理の保存の route 4 本と AI 相談は積む前に `consume_ai_usage_at` の門で止まるので、ここに来るのは門を通ったジョブか、献立の作成のジョブ)。`meal-image-jobs.ts` (Next と Edge の積み方) は変えない。`save-meal.ts` は作り直しの注のコメントだけ (下の「自動の料理画像は献立の主菜の 1 品だけ」の (e)):

```ts
// tsc:skip insert=supabase/functions/process-meal-image-jobs/index.ts — 4 か所の差分 (位置は各行の注)
// (a) import (../_shared/meal-image.ts の import に 3 つ足す)
//   import { DEFAULT_MEAL_IMAGE_MODEL, MEAL_IMAGE_SKIPPED_ERRORS, mealImageJobPlanDecision, type MealImageDish, type MealImageJobPlanDecision } from "../_shared/meal-image.ts";
// (b) processJobs: 同意の判定と同じく、1 回の実行の中で利用者ごとにプランの門の答えを使い回す
//   const planByUser = new Map<string, Promise<MealImageJobPlanDecision>>();
//   const outcome = await processJob(job, consentByUser, planByUser);
// (c) 次の関数を fetchPendingJobs の定義の直後に置く (Deno.serve( より後ろ)
async function readMealImageJobPlanDecision(ownerId: string): Promise<MealImageJobPlanDecision> {
  try {
    const { data, error } = await supabase.rpc("ai_plan_feature_daily_cap", { p_user_id: ownerId, p_feature: "meal_image_auto" });
    if (error) {
      // 読めなかったときは止めない (mealImageJobPlanDecision の注)。生のエラーは app_logs にだけ残す
      logger.warn("料理画像のプランの門を読めなかったため、止めずに処理します", { ownerId, code: error.code ?? null });
      return "allowed";
    }
    return mealImageJobPlanDecision(data);
  } catch (cause: unknown) {
    // RPC が投げた (接続の失敗など) ときも止めない。processJob の try より前で呼ぶので、ここで投げるとジョブが貸し出し中のまま残り、
    // 同じ実行の残りのジョブも処理されない (processJobs に try が無い)。生のエラーは残さず名前だけ
    logger.warn("料理画像のプランの門を読めなかったため、止めずに処理します", { ownerId, code: cause instanceof Error ? cause.name : null });
    return "allowed";
  }
}
// (d) processJob の引数に planByUser: Map<string, Promise<MealImageJobPlanDecision>> を足し、同意の判定の if ブロック (`if (!decision.allowed) { … }`) の直後 (try より前) に次を置く
//   let plan = planByUser.get(ownerId);
//   if (!plan) {
//     plan = readMealImageJobPlanDecision(ownerId);
//     planByUser.set(ownerId, plan);
//   }
//   if ((await plan) === "locked") {
//     const reason = MEAL_IMAGE_SKIPPED_ERRORS.plan;
//     const finalized = await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, reason);
//     if (finalized) {
//       await markDishFailure(jobRow, { status: "cancelled", attemptCount: nextAttempt, reason });
//     }
//     return { jobId: jobRow.id, status: "cancelled", message: reason };
//   }
```

  - 料理は `writeDishImageFailure` (`utils.ts:190`) で `image_status: 'failed'`・`image_error: 'skipped_plan'` になる (同意の門と同じ書き方)。料理の画面は `isMealImagePlanSkippedError` で有料プランの案内を出す (下の `RecipeModal` の箇条)。料理を保存し直すと `needsImageRetry` (`failed`) でジョブを積み直し、有料プランになっていれば作る。
  - `readMealImageJobPlanDecision` は `processJob` の外 (ファイルの関数) に置き、場所は `fetchPendingJobs` の定義の直後 (`Deno.serve(` より後ろ。`tests/edge-function-verify-jwt.test.ts` は `Deno.serve(` 以降で認証の呼び出しより前の `.rpc(` を探すが、認証 (`requireServiceRole`) は `Deno.serve` の本体の先頭にあるので当たらない)。`ai_plan_feature_daily_cap` の EXECUTE は service_role だけで、この関数の `supabase` は service role の client (`index.ts` の既存の `createClient`)。RPC がエラーを返したときも、投げたときも `"allowed"` を返し、例外を `processJob` の外へ出さない (§18 の 21)。
  - ハンドラを本物で動かす既存のテスト `tests/process-meal-image-jobs-worker-edges.test.ts` は Supabase の client を `{ from, storage }` だけの偽物にしているので、偽物に `rpc` を足す (§16.1 の行。足さないと `supabase.rpc` が無く、上の `catch` が warn を 1 つ足し、warn の数を 1 と数える既存の it が赤になる)。
  - `tests/helpers/ai-consent-enforced-paths.ts` の `ENFORCED_EDGE['process-meal-image-jobs'].consent` の文 (`:390`) に「同意のあとに、ジョブの持ち主のプランの門 (ai_plan_feature_caps の meal_image_auto = 0 なら取り消す。billing/03 §8.8) も見る」を足す (文だけ。`recordedBy` は変えない。`tests/ai-usage-contract.test.ts:543-545` が `recordedBy` に `AI_QUEUE_TABLES` を求める)。

- 4 本の route (`src/app/api/meals/route.ts:187`・`src/app/api/meals/[id]/route.ts:236`・`src/app/api/meal-plans/meals/route.ts:122`・`src/app/api/meal-plans/meals/[id]/route.ts:194`) と `src/lib/ai/consultation-action-executor.ts:838` の `const skipReason = imageUsage?.allowed === false ? 'ai_limit' : 'rate_limit';` を `const skipReason = mealImageSkipReasonOf(imageUsage);` にする (import を足す。`skipReason === 'rate_limit'` の分岐はそのまま)。`'plan'` のとき応答に `aiSkipped` は付かない (`aiDailyLimitSkippedField` が `planLocked` を見る)。
- 料理の画面 `src/app/(main)/menus/weekly/_components/modals/RecipeModal.tsx:213-229`: `isMealImageSkippedError` の 2 か所の前に `isMealImagePlanSkippedError(...)` の枝を置き、画像の枠の文は「料理画像の作成は有料プランでお使いいただけます」、下の注は「料理画像の作成は有料プランでお使いいただけます。有料プランにすると、料理を保存し直したときに画像を作ります。」にする (`skipped_ai_limit` / `skipped_rate_limit` の文は変えない)。`needsImageRetry` は変えない (保存し直すたびに判定し、有料プランになっていれば作る)。

- 自動の料理画像は献立の主菜の 1 品だけ (Q-16・R26・§7.1 の「自動の料理画像を作る料理」の表・§7.3 の料理の画像の状態の遷移)。ジョブの種を作る `reconcileDishImages` の最後で、種を主菜の 1 品に絞る (6 つの入口はどれもこの関数を通る。F26)。主菜の判定 `autoImageDishIndexOf` は同じファイルに置き、積み直しの道具 (`planDishImageJobs`) と料理の画面 (`mealCoverRepresentsDish`) も同じ関数を読む。プランで分けない (無料は上の処理の門と route の門が先に止める)。`lib/meal-image-jobs.ts` (`buildDishImagePayload`・`enqueueMealImageJobs`) と `supabase/functions/_shared/meal-image-jobs.ts` は変えない (渡ってくる種が 1 本までになるだけ)。4 本の route と AI 相談は、種が 0 本なら `consumeAiUsage(user, 'meal_image_auto')` を呼ばない今のコード (F26) のまま、主菜でない料理だけを変えた保存では数えない。献立の作成の作り直し (`regeneration: true`) で料理が変わったときは、#1553 の `releasePreviousDishImage` (中身の変わった写真・商品・手の画像の料理) と `releaseOnRegeneration` の for (中身の同じ自分の画像の無い写真・商品・手の画像の料理) が写真・手の画像の料理も種にするが、絞り込みはその後ろにあるので主菜の 1 本だけが残り、ほかの料理は画像の無い状態になる (写真の印も外れる。§7.3 の「作り直し」の行・テスト 159)。
- 主菜の引き継ぎ (§7.3 の「主菜でない → 主菜 (位置が移った先の、変わらない料理)」の行・S42)。前の主菜を消した・前の主菜の役割を外した保存では、自動の料理画像の位置 (`autoImageDishIndexOf`) が、もとからその位置にある中身・役割・位置の変わらない料理へ移ることがある (例: [ご飯 (位置 0・画像の無い状態)・主菜 (位置 1・`ready`)] から主菜を消す → 位置 0 のご飯。[副菜・主菜 1 (`ready`)・主菜 2 (画像の無い状態)] で主菜 1 の役割を副菜にする → 位置 2 の主菜 2)。その料理は subject_hash が変わらず、`isAiImagePipelineDish` も偽 (`withoutAutoDishImage` が外した) なので、for の中の「前回のまま写し、積まない」(#1487) に当たり種ができない。絞り込みだけでは献立に画像もジョブも無くなる (カバーは前の主菜の AI の画像だったので `deriveMealCoverImage` が空にする) ため、for の直後の (b0) で `autoImageDishHandoverIndexOf` が返す位置に種を 1 本足す (`pending`)。足す条件は「前回と今回の `autoImageDishIndexOf` が違う」「その位置にまだ種が無い」「その料理が画像の無い状態 (画像・写真・商品・手の画像・AI の画像の印のどれも無い)」の 3 つで、料理を変えずに保存し直した (完了の切り替えなど) ときは役割と並びが同じなので位置が移らず、#1487 の「変えずに保存し直しても積まない」は変わらない。足した種はほかの種と同じに扱う: route と AI 相談は種が 1 本あるので `meal_image_auto` を 1 回数え (無料は `skipped_plan` で積まない)、献立の作成 (`save-meal`) は積んで処理の門が見る。献立のカバーが写真・商品の料理のもの (`isMealCoverHeldByImagelessPreservedDish`) なら、ほかの種と同じく (足した料理は `jobDishes` に入っている) 前の状態 (画像の無い状態) に戻して積まない。移った先の料理が画像を持つ (段 B の前の `ready`)・写真・商品・手の画像・待ち (`pending` / `stale` / `failed`。for の中で積み直しの種になる) なら足さない。既存のテスト (§16.1 の母集合の作り方 17 の母集合) の保存はどれも、主菜の位置が前回と同じ (料理を足す・1 品を変える・変えずに保存し直す) で、前の主菜を消す・主菜の役割を外す it は無い (origin/main `2ba5b3b3` で読んだ) ので、引き継ぎで期待が変わる既存の it は無い。守るのはテスト 156〜158。

```ts
// tsc:skip insert=supabase/functions/_shared/meal-image.ts — 4 か所 ((a)・(b0)・(b)・(c)。位置は各行の注)。lib/meal-image.ts の再 export の名前の一覧に AUTO_IMAGE_DISH_ROLES・AUTO_IMAGE_FALLBACK_DISH_INDEX・autoImageDishIndexOf・mealCoverRepresentsDish を足す (autoImageDishHandoverIndexOf は reconcileDishImages の中とテスト (`_shared/meal-image` を直に読む) だけが使うので、再 export に足さない)
// (a) isAiImagePipelineDish の定義の直後に置く (normalizeText・isCoverReadySource はこのファイルの関数宣言なので、後ろで定義されていても呼べる)

/**
 * 自動の料理画像 (料理の保存・更新の 4 本の route・AI 相談の料理の更新・献立の作成 (Edge の save-meal) が積むジョブ) を作る
 * 料理の役割 (billing/03 §8.8・Q-16)。自動で作るのは献立の主菜の 1 品だけ。
 * 料理の役割 (dishes[].role) は、AI が作る献立では 'main' / 'side' / 'soup' / 'rice' / 'other' (_shared/meal-generator.ts)、
 * 利用者が日本語で保存した料理では '主菜' など (packages/shared/src/dish-roles.ts の getDishConfig が 'main' と同じ「主菜」として読む)。
 * 比べるときは前後の空白を除き、英字を小文字にする (normalizeText)
 */
export const AUTO_IMAGE_DISH_ROLES: ReadonlyArray<string> = Object.freeze(['main', '主菜']);

/**
 * 主菜の無い献立 (朝食のご飯と汁物だけ・役割が other だけ・役割の無い料理だけ) で、自動の料理画像を作る料理の位置 (先頭の料理)。
 * 献立のカバーを 1 枚残すため (Q-16 の「見た目は残し」)
 */
export const AUTO_IMAGE_FALLBACK_DISH_INDEX = 0;

/** 料理が 1 品の献立の料理の数 (献立のカバーがその料理の画像と同じになる献立) */
const SINGLE_DISH_MEAL_DISH_COUNT = 1;

/**
 * 献立の料理のうち、自動の料理画像を作る 1 品の位置 (billing/03 §8.8・Q-16)。
 * 役割が主菜 (AUTO_IMAGE_DISH_ROLES) の最初の料理。主菜の無い献立は AUTO_IMAGE_FALLBACK_DISH_INDEX。料理が無ければ null
 */
export function autoImageDishIndexOf(dishes: ReadonlyArray<Pick<MealImageDish, 'role'>>): number | null {
  if (dishes.length === 0) return null;
  const mainIndex = dishes.findIndex((dish) => AUTO_IMAGE_DISH_ROLES.includes(normalizeText(dish.role)));
  return mainIndex >= 0 ? mainIndex : AUTO_IMAGE_FALLBACK_DISH_INDEX;
}

/**
 * 料理の画面で、自分の画像の無い料理に献立のカバー (planned_meals.image_url) を代わりに出してよいか (billing/03 §10.3・Q-16)。
 * 出すのは、料理が 1 品の献立の料理・自動の料理画像を作る料理 (autoImageDishIndexOf の位置。カバーはその料理の画像になる)・
 * カバーに頼る写真・商品・手の画像の料理 (写真の複数の料理など。image_source が meal_photo / catalog / manual_override) だけ。
 * ほかの料理 (主菜でない料理) には出さない (カバーは主菜の画像なので、別の料理の画像を出すことになる)。位置に料理が無ければ false
 */
export function mealCoverRepresentsDish(
  dishes: ReadonlyArray<Pick<MealImageDish, 'role' | 'image_source'>>,
  dishIndex: number,
): boolean {
  const dish = dishes[dishIndex];
  if (!dish) return false;
  if (dishes.length <= SINGLE_DISH_MEAL_DISH_COUNT) return true;
  return dishIndex === autoImageDishIndexOf(dishes) || isCoverReadySource(dish.image_source ?? null);
}

/**
 * 主菜の引き継ぎ (billing/03 §8.8・§7.3・Q-16)。この保存で自動の料理画像を作る位置 (autoImageDishIndexOf) が別の料理へ移り
 * (前の主菜を消した・前の主菜の役割を外した。移った先の料理はもとからその位置にあり、中身・役割・位置を変えていない)、
 * 移った先の料理が画像の無い状態 (N: 画像・source・subject_hash なし。主菜でなかった間に withoutAutoDishImage が外した料理など) なら、その位置を返す。
 * reconcileDishImages はその料理に種を 1 本足す (献立のカバーを 1 枚残す。R26・S38・S42)。それ以外は null。
 *   - 前回の料理が無い (新しい献立): null (新しい料理は reconcileDishImages の for の中で種になる)
 *   - 位置が移っていない (前回と今回の autoImageDishIndexOf が同じ): null。料理を変えずに保存し直した (完了の切り替えなど) ときは
 *     役割と並びが同じなので必ずここに当たり、AI の画像の料理だと分からない料理を変えずに保存し直しても積まない今の決まり
 *     (reconcileDishImages の「前回のまま写し、積まない」。#1487) は変わらない
 *   - 移った先の料理にもう種がある (中身・役割・位置が変わった料理・待ちの料理の積み直し): null (種は 1 本のまま)
 *   - 移った先の料理が画像を持つ・写真・商品・手の画像の料理 (isPreservedDishImage)・AI の画像の料理 (isAiImagePipelineDish): null
 * previousDishes は保存する前の料理 (料理でない値は役割の無い料理として位置を数える)、dishes は reconcileDishImages の for で作った料理、
 * seededDishIndexes はその時点の種の位置
 */
export function autoImageDishHandoverIndexOf(params: {
  previousDishes: ReadonlyArray<MealImageDish | null | undefined>;
  dishes: ReadonlyArray<MealImageDish>;
  seededDishIndexes: ReadonlyArray<number>;
}): number | null {
  if (params.previousDishes.length === 0) return null;
  const autoImageDishIndex = autoImageDishIndexOf(params.dishes);
  if (autoImageDishIndex === null) return null;
  const previousAutoImageDishIndex = autoImageDishIndexOf(
    params.previousDishes.map((dish): MealImageDish => (dish && typeof dish === 'object' ? dish : {})),
  );
  if (previousAutoImageDishIndex === autoImageDishIndex) return null;
  if (params.seededDishIndexes.includes(autoImageDishIndex)) return null;
  const dish = params.dishes[autoImageDishIndex];
  if (!dish || dish.image_url || isPreservedDishImage(dish) || isAiImagePipelineDish(dish)) return null;
  return autoImageDishIndex;
}

/**
 * 自動の料理画像を作らない料理を、画像の無い状態にする (billing/03 §8.8・Q-16)。状態・source・subject_hash・画像を持たない
 * (画面は「生成中」「再生成待ち」を出さず、料理の画面は画像の枠を出さない。subject_hash も source も無いので、次に変えずに
 * 保存し直しても AI の画像の料理とみなさず積み直さない (isAiImagePipelineDish が偽))。プロンプトとモデルは残す。
 * 渡した料理は変えず、新しい料理を返す
 */
function withoutAutoDishImage<TDish extends MealImageDish>(dish: TDish): TDish {
  const cleared: TDish = {
    ...dish,
    image_subject_hash: null,
    image_url: null,
    image_source: null,
    image_status: null,
    image_generated_at: null,
    image_error: null,
  };
  return cleared;
}

// (b0) reconcileDishImages の for の閉じ括弧の直後 (「// AI の作り直しで料理が変わったら、利用者のカバー (AI の料理の画像でないカバー) を外す (#1553)。」の前) に置く
  // billing/03 §8.8・Q-16: 主菜の引き継ぎ。前の主菜を消した・前の主菜の役割を外したことで、自動の料理画像の位置が、中身・役割・位置の
  // 変わらない画像の無い料理へ移ったら、その料理に種を 1 本足す (for の中では「前回のまま写し、積まない」に当たるため。献立のカバーを 1 枚残す)。
  // 位置が移らない保存し直し (完了の切り替えなど) では足さない (autoImageDishHandoverIndexOf)。足した料理は jobDishes にも入れるので、
  // 下の「献立のカバーが写真・商品の料理のもの」の判定に当たれば前の状態 (画像の無い状態) に戻る
  const handoverDishIndex = autoImageDishHandoverIndexOf({
    previousDishes,
    dishes,
    seededDishIndexes: jobs.map((job) => job.dishIndex),
  });
  if (handoverDishIndex !== null) {
    const unchangedDish = dishes[handoverDishIndex];
    const { subjectHash, prompt } = dishSubjects[handoverDishIndex];
    const handedOver: TDish = {
      ...unchangedDish,
      image_subject_hash: subjectHash,
      image_url: null,
      image_source: 'generated_ai',
      // 前回の画像の無い料理の画像を作るので 'pending' (同じ料理の積み直しと同じ決まり)
      image_status: 'pending',
      image_generated_at: null,
      image_error: null,
    };
    dishes[handoverDishIndex] = handedOver;
    jobDishes.push({ index: handoverDishIndex, sameSubject: true, previousDish: unchangedDish });
    jobs.push(buildDishJobSeed(handedOver, handoverDishIndex, subjectHash, prompt));
    jobs.sort((a, b) => a.dishIndex - b.dishIndex);
  }

// (b) reconcileDishImages の最後の return の直前 (「献立のカバーが、料理ごとの画像を持たない写真・商品の料理のもの…」の if ブロックの後) に置く
  // billing/03 §8.8・Q-16: 自動の料理画像は献立の主菜の 1 品だけに作る (autoImageDishIndexOf)。ほかの料理に積もうとした種は積まず、
  // その料理を画像の無い状態にする ('pending' / 'stale' のまま残すと、処理するジョブが無いので「生成中」に見える)。
  // 前回の画像や状態を写した料理 (種を作らなかった料理) はここで触らないので、段 B の前に作られた画像は消えない
  const autoImageDishIndex = autoImageDishIndexOf(dishes);
  if (jobs.some((job) => job.dishIndex !== autoImageDishIndex)) {
    for (const job of jobs) {
      if (job.dishIndex !== autoImageDishIndex) dishes[job.dishIndex] = withoutAutoDishImage(dishes[job.dishIndex]);
    }
    jobs = jobs.filter((job) => job.dishIndex === autoImageDishIndex);
  }

// (c) 注だけ (コードは変えない): ReconcileDishImagesParams の regeneration の注の最後の行
//   「 * 商品の献立は、作り直しても商品の料理・商品の画像のまま (商品とのつながりは、この保存では外さないため)」の後に
//   「 * どの保存でも、AI の画像のジョブを積むのは献立の主菜の 1 品だけ (最後に autoImageDishIndexOf で絞る。billing/03 Q-16)。
//    * 上の「ジョブを積む」「AI の画像の料理にして」は、その 1 品のときだけ。ほかの料理は画像の無い状態になる」の 2 行を足す。
//   reconcileDishImages の中の「// AI の作り直しで料理が変わったら、料理ごとの画像を持たずカバーに頼っていた写真・商品・手の画像の料理」で始まる注の
//   最後の行「// 回したあとはカバーに頼る料理が残らないので、下の「ジョブを積まない」判定には当たらない」の後に
//   「// 主菜でない料理に回した種は、最後の絞り込み (billing/03 Q-16) で落ちて画像の無い状態になる」の 1 行を足す
```

```ts
// tsc:skip insert=scripts/lib/meal-image-backfill.ts — 4 か所 (位置は各行の注)
// (a) ../../supabase/functions/_shared/meal-image の import の一覧に autoImageDishIndexOf を足す (名前の並びは今の順のまま、asCatalogMealDish の直後)
// (b) MealImageBackfillSkipReason の union の最後に | 'not_auto_image_dish' を足し、その上の注の一覧の最後に
//     「 *   - not_auto_image_dish: 献立の主菜 (自動の料理画像を作る 1 品。autoImageDishIndexOf) でない料理 (billing/03 Q-16。保存し直しも積まない)」を、
//     ファイルの冒頭の注の「積み直す料理 (planDishImageJobs):」の箇条の最後に
//     「 *   - 献立の主菜 (自動の料理画像を作る 1 品。autoImageDishIndexOf) である (billing/03 Q-16。保存し直し (reconcileDishImages) と同じ判定)」を足す。
//     emptySkipCounts の戻り値の最後に not_auto_image_dish: 0, を足す
// (c) planDishImageJobs の `const mealCoverPreserved = …` の行の直後
  // 保存し直し (reconcileDishImages) と同じく、自動の料理画像は献立の主菜の 1 品だけ (billing/03 Q-16)。
  // 料理でない値 (not_object) は役割の無い料理として位置を数える (主菜の位置は dishes の添字のまま)
  const autoImageDishIndex = autoImageDishIndexOf(viewed.map((value): MealImageDish => (isDishObject(value) ? value : {})));
// (d) planDishImageJobs の forEach の中、`if (mealCoverPreserved) { … }` の直後 (plan.seeds.push の前)。ほかの理由に当たる料理はその理由で数え、
//     ここに来るのは「主菜であれば積む」料理だけ
    if (dishIndex !== autoImageDishIndex) {
      plan.skipped.not_auto_image_dish += 1;
      return;
    }
```

```ts
// tsc:skip insert=src/app/(main)/menus/weekly/page.tsx — 2 か所
// (a) import の並び (`import { aiDailyLimitMessageOfResponse } from "@/lib/ai/daily-limit-client";` (:70) の直後) に 1 行
import { mealCoverRepresentsDish } from "@/lib/meal-image";
// (b) 料理を押したときの setSelectedRecipeData の imageUrl の 1 行 (:5464 の `imageUrl: dish.image_url ?? meal.imageUrl ?? null,`) を次の 2 行に替える
                      // 自分の画像の無い料理に献立のカバーを出すのは、カバーがその料理を表すときだけ (1 品の献立・主菜・写真や商品の料理。billing/03 §10.3・Q-16)
                      imageUrl: dish.image_url ?? (mealCoverRepresentsDish(dishesArray, idx) ? meal.imageUrl : null) ?? null,
```

  - (e) `supabase/functions/_shared/save-meal.ts` は注だけ (コードは変えない): `:624-625` の 2 行「// AI の作り直し: 料理が変わったら、前回の写真・手で付けた画像と利用者のカバーを外し、新しい料理の AI の画像を作る (#1553)。」「// カバーに頼っていた画像の無い写真の料理 (写真の複数の料理の、同じまま残った料理) も AI の画像に回す。」を、「// AI の作り直し: 料理が変わったら、前回の写真・手で付けた画像と利用者のカバーを外し、新しい主菜の AI の画像を作る (#1553)。」「// カバーに頼っていた画像の無い写真の料理 (写真の複数の料理の、同じまま残った料理) も、献立の主菜なら AI の画像に回す。」「// 自動の料理画像は、作り直しでも献立の主菜の 1 品だけ (reconcileDishImages の最後の絞り込み。billing/03 Q-16)。ほかの料理は画像の無い状態になる」の 3 行に替える。
  - 主菜でない料理を画像の無い状態にするので、`RecipeModal` は `imageUrl` も `image_status` も無い料理に画像の枠を出さない (`RecipeModal.tsx:193` の今の条件。コードは変えない)。ほかの料理に献立のカバー (主菜の画像) を出さないのは page.tsx の (b) (§10.3)。モバイルは料理ごとの画像を出さないので変えない (F26)。
  - 処理の門 (`process-meal-image-jobs`) は主菜かを見ない (段 B の前に積まれた主菜でない料理の待ちのジョブは、いまの規則のまま画像を書く。§7.3)。本番の待ちのジョブは 0 件 (2026-10-19 の読み取り。§18 の 26)。

### 8.9 `packages/shared/src/billing-plans.ts` (公開の文とモバイルが読む型の正本。純。import なし)

Web (公開の面・`/account/billing`・`/frozen/billing`・究極モードの錠) とモバイル (購入の画面・究極モードの錠) の両方が読むものを、モバイルが既に読んでいる共有のパッケージ `@homegohan/shared` (`packages/shared`。モバイルは `apps/mobile/app/(auth)/signup.tsx` などで import 済み) に置く。モバイルは Web の `src/` を import しない (origin/main の規則のまま)。`packages/shared/src/index.ts` に `export * from './billing-plans';` を 1 行足す (このファイルが export する名前が origin/main の `packages/shared` に無いことを、名前の一覧の `git grep -n -E "export (const|function|type|interface) (<名前の一覧>)\\b" origin/main -- packages/shared` が 0 件であることで確かめた。実装の段の最初にもう一度流す)。

```ts
/**
 * 有料プランの表示の正本 (billing/03 §8.9)。Web (公開の面・契約の画面) とモバイル (購入の画面・究極モードの錠) が
 * `@homegohan/shared` から読む。純粋な TypeScript (import なし・Intl を使わない。React Native の Hermes でも同じ結果になる)。
 *  - プランの説明の箇条書き・価格の写し・AI の回数の表示 (PLAN_CATALOG ほか)。価格の正本は DB (subscription_plans)。ここの価格は
 *    特定商取引法の表記 (静的なページ) に書くための写しで、tests/billing-plan-catalog.test.ts が migration の値と一致することを見る
 *  - ストアの表示名と購読の管理のページ (IAP_STORE_LABELS・STORE_SUBSCRIPTION_MANAGEMENT_URL)・退会の確認の文 (STORE_SUBSCRIPTION_DELETION_NOTICE)
 *  - GET /api/billing/subscription の data の形 (BillingSummaryWire) と、その読み取り (parseBillingSummaryWire)・状態の文 (subscriptionStatusLines)
 * 文に未完成や予定を示す語 (準備中・販売開始前・近日・予定・まだ・確定次第・これから) を書かない。
 */

// ─────────────────────────────────────────────────────────────────────────────
// ストア (src/lib/billing/iap-core.ts の IAP_STORES と同じ 2 値。tests/billing-iap-core.test.ts のテスト 95 が突き合わせる)
// ─────────────────────────────────────────────────────────────────────────────

export const PURCHASE_STORES = ["app_store", "play_store"] as const;
export type PurchaseStore = (typeof PURCHASE_STORES)[number];
export function isPurchaseStore(value: unknown): value is PurchaseStore {
  return typeof value === "string" && (PURCHASE_STORES as readonly string[]).includes(value);
}
/** ストアの表示名 (画面の文) */
export const IAP_STORE_LABELS: Readonly<Record<PurchaseStore, string>> = {
  app_store: "App Store",
  play_store: "Google Play",
};
/** ストアの購読の管理のページ (RevenueCat の CustomerInfo.managementURL が null のときと、Web の契約の画面の行き先) */
export const STORE_SUBSCRIPTION_MANAGEMENT_URL: Readonly<Record<PurchaseStore, string>> = {
  app_store: "https://apps.apple.com/account/subscriptions",
  play_store: "https://play.google.com/store/account/subscriptions",
};
/**
 * 退会の確認に出す固定の文 (billing/03 §10.4)。ストアの購読はストアが契約の主体で、当社の退会では解約されない。
 * 退会の API を呼ぶ 4 つの入口 (Web の設定・凍結中と同意の前の退会の共通の部品 (`/frozen/account`・`/legal-consent/account`)・規約の同意の画面の「登録をやめる」・アプリの設定のアカウント) が出す。
 * ストアの契約が無い人にも出す (退会の時に契約の有無を読みに行かない)
 */
export const STORE_SUBSCRIPTION_DELETION_NOTICE =
  "App Store / Google Play でお申し込みの有料プランは、退会しても自動では解約されません。各ストアの定期購読の管理から解約してください。";

// ─────────────────────────────────────────────────────────────────────────────
// プランの説明 (Q-2・Q-3・Q-4・Q-16 の確定値 (発注者の選択 2026-10-19。§0.4 の追記 3)。値を変えるときは、この節の数と migration の値を一緒に変える)
// ─────────────────────────────────────────────────────────────────────────────

export const PAID_PLAN_KEYS = ["pro", "family_basic", "family_pro"] as const;
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number];

export interface PlanCatalogEntry {
  plan_key: PaidPlanKey;
  display_name: string;
  monthly_price_jpy: number;
  yearly_price_jpy: number;
  trial_days: number;
  /** 家族の人数の上限 (個人は null) */
  max_members: number | null;
  /** 画面に出す内容の箇条書き (無料との違い) */
  features: readonly string[];
}

/** AI の 1 日の回数 (Q-2 の確定値。ai_daily_limits の既定の行と同じ値。tests/billing-plan-catalog.test.ts が突き合わせる) */
export const PLAN_AI_DAILY_LIMITS = { free: 3, pro: 30, family_basic: 30, family_pro: 50 } as const;
/** 究極モードの 1 日の回数 (Q-3 の確定値。ai_plan_feature_caps の既定の行と同じ値) */
export const PLAN_ULTIMATE_DAILY_CAPS = { free: 0, pro: 2, family_basic: 2, family_pro: 3 } as const;
/** 献立の作成と作り直し (menu_generation) の 1 日の回数 (Q-3 の確定値。ai_plan_feature_caps の既定の行と同じ値。無料は 1 日の合計 (PLAN_AI_DAILY_LIMITS.free) と同じ値) */
export const PLAN_MENU_GENERATION_DAILY_CAPS = { free: 3, pro: 10, family_basic: 10, family_pro: 15 } as const;
/** 有料プランの無料体験の日数 (§0.4 の決定。subscription_plans.trial_days の既定の値と同じ。Web の Checkout の体験の日数) */
export const PLAN_TRIAL_DAYS = 7;
/** 家族の人数の上限 (subscription_plans.max_members の値と同じ) */
export const FAMILY_PLAN_MAX_MEMBERS = { family_basic: 4, family_pro: 8 } as const;

/**
 * 有料プランの料理画像の説明 (meal_image_auto と image_generation。無料では作らない。Q-3)。自動で作るのは、記録した献立と AI が作った献立の
 * 主菜の 1 品だけ (Q-16。主菜の無い献立は先頭の料理)。献立の画像は、献立の編集の「AIで画像生成」からも作れる (image_generation。Q-18)
 */
const PAID_MEAL_IMAGE_FEATURE = "料理画像の作成 (記録した献立と AI が作った献立の主菜の画像を AI が作ります)";

export const PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  {
    plan_key: "pro",
    display_name: "個人 Pro",
    monthly_price_jpy: 580,
    yearly_price_jpy: 5800,
    trial_days: PLAN_TRIAL_DAYS,
    max_members: null,
    features: [
      `AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.pro} 回まで (無料プランは ${PLAN_AI_DAILY_LIMITS.free} 回)`,
      `献立の作成と作り直しを 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.pro} 回まで (無料プランは ${PLAN_MENU_GENERATION_DAILY_CAPS.free} 回)`,
      `究極モード (AI が献立を見直して栄養バランスを改善) を 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.pro} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
  {
    plan_key: "family_basic",
    display_name: "家族 Basic",
    monthly_price_jpy: 980,
    yearly_price_jpy: 9800,
    trial_days: PLAN_TRIAL_DAYS,
    max_members: FAMILY_PLAN_MAX_MEMBERS.family_basic,
    features: [
      `家族グループ (${FAMILY_PLAN_MAX_MEMBERS.family_basic} 人まで)。家族の献立の表示・共有の設定・子供の記録`,
      `メンバー 1 人ごとに AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.family_basic} 回まで`,
      `献立の作成と作り直しを 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.family_basic} 回まで・究極モードを 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.family_basic} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
  {
    plan_key: "family_pro",
    display_name: "家族 Pro",
    monthly_price_jpy: 1480,
    yearly_price_jpy: 14800,
    trial_days: PLAN_TRIAL_DAYS,
    max_members: FAMILY_PLAN_MAX_MEMBERS.family_pro,
    features: [
      `家族グループ (${FAMILY_PLAN_MAX_MEMBERS.family_pro} 人まで)。家族の献立の表示・共有の設定・子供の記録`,
      `メンバー 1 人ごとに AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.family_pro} 回まで`,
      `献立の作成と作り直しを 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.family_pro} 回まで・究極モードを 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.family_pro} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
];

/** 無料プランでできること (料金ページのフリーのカード・FAQ。実際にある機能だけ) */
export const FREE_PLAN_FEATURES: readonly string[] = [
  "写真で食事の記録 (AI が料理を認識して栄養を推定)",
  "記録をほめるひと言 (記録コメント) と栄養メモ",
  `献立の作成と作り直し (1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.free} 回まで)`,
  "健康の記録",
  "バッジ",
  "過去の記録の閲覧",
];
/**
 * 無料プランの AI の 1 日の回数の文 (料金ページのフリーのカード・FAQ)。前半は #1867 の Q-12 の共通の文
 * (「1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。」。tests/public-claims-guard.test.ts の
 * AI_DAILY_LIMIT_PHRASE) を逐語で含め、後半に無料プランの回数 (PLAN_AI_DAILY_LIMITS.free) を書く
 */
export const FREE_PLAN_AI_LIMIT_NOTE = `AIを使う機能（写真の解析や献立の作成など）は、1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。無料プランの上限は1日${PLAN_AI_DAILY_LIMITS.free}回です。`;
/** 有料プランで増えるものの 1 文 (FAQ・紹介ページの要点と料金の章と FAQ。PLAN_CATALOG の features と同じ範囲。§10.5) */
export const PAID_PLAN_SUMMARY = "有料プランでは、AI を使う回数の上限が上がり、究極モード・料理画像の作成・家族グループが使えます。";

/** 金額の 3 桁区切り (Intl を使わない。"5,800円") */
const THOUSANDS_GROUP = 3;
export function formatJpy(amount: number): string {
  const digits = String(Math.trunc(Math.abs(amount)));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= THOUSANDS_GROUP) groups.unshift(digits.slice(Math.max(0, end - THOUSANDS_GROUP), end));
  return `${amount < 0 ? "-" : ""}${groups.join(",")}円`;
}

/** 特定商取引法の表記の「販売価格」の文 (税込。§10.2) */
export function planCatalogPriceText(): string {
  return PLAN_CATALOG.map(
    (plan) =>
      `${plan.display_name}: 月額 ${formatJpy(plan.monthly_price_jpy)} / 年額 ${formatJpy(plan.yearly_price_jpy)} (税込)${plan.max_members === null ? "" : `・${plan.max_members} 人まで`}`,
  ).join("\n");
}

/** /faq と料金の案内の「料金はかかりますか？」の答え (§10.5)。無料プランの範囲・回数の上限・有料で増えるもの */
export const FREE_PLAN_FAQ_ANSWER = `無料プランでは、写真での食事の記録、記録をほめるひと言、献立の作成、健康の記録などをお使いいただけます。${FREE_PLAN_AI_LIMIT_NOTE}${PAID_PLAN_SUMMARY}`;

/** /faq の「有料プランはありますか？」の答え (§10.5)。価格は PLAN_CATALOG から組む (価格を変えたら一緒に変わる) */
export const PAID_PLANS_FAQ_ANSWER = `${PLAN_CATALOG.map(
  (plan) =>
    `${plan.display_name} (月額 ${formatJpy(plan.monthly_price_jpy)} / 年額 ${formatJpy(plan.yearly_price_jpy)}${plan.max_members === null ? "" : `・${plan.max_members} 人まで`})`,
).join("、")}があります。Web でお申し込みの場合、どのプランも ${PLAN_TRIAL_DAYS} 日間の無料体験つきです (同じプランにつき 1 回)。App Store・Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。`;

/** plan_key の表示名 (PLAN_CATALOG に無い plan_key はそのまま返す。free は「無料プラン」) */
export const FREE_PLAN_DISPLAY_NAME = "無料プラン";
export function planDisplayName(planKey: string): string {
  if (planKey === "free") return FREE_PLAN_DISPLAY_NAME;
  return PLAN_CATALOG.find((plan) => plan.plan_key === planKey)?.display_name ?? planKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/subscription・POST /api/billing/iap/sync の data の形 (src/lib/billing/core.ts の BillingSummary と同じ形。
// tests/billing-summary-wire.test.ts のテスト 94 が型と値で突き合わせる)
// ─────────────────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_STATUSES_WIRE = ["incomplete", "trialing", "active", "paused", "cancelled", "expired", "past_due", "grace"] as const;
export type SubscriptionStatusWire = (typeof SUBSCRIPTION_STATUSES_WIRE)[number];
export const BILLING_SOURCES_WIRE = ["stripe", "manual", "app_store", "play_store"] as const;
export type BillingSourceWire = (typeof BILLING_SOURCES_WIRE)[number];
export const BILLING_INTERVALS_WIRE = ["month", "year"] as const;
export type BillingIntervalWire = (typeof BILLING_INTERVALS_WIRE)[number];

export interface PlanFeaturesWire {
  ai_daily_limit: number | null;
  ai_feature_caps: Record<string, number | null>;
}

export interface BillingSummaryWire {
  plan_key: string;
  effective_plan_key: string;
  status: SubscriptionStatusWire | null;
  source: BillingSourceWire | null;
  manage_in_store: PurchaseStore | null;
  billing_interval: BillingIntervalWire | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  has_customer: boolean;
  can_purchase: boolean;
  can_cancel: boolean;
  can_resume: boolean;
  features: PlanFeaturesWire;
}

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isIntOrNull = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value));
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parsePlanFeaturesWire(value: unknown): PlanFeaturesWire | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isIntOrNull(record.ai_daily_limit)) return null;
  const caps = record.ai_feature_caps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  const featureCaps: Record<string, number | null> = {};
  for (const [feature, cap] of Object.entries(caps as Record<string, unknown>)) {
    if (!isIntOrNull(cap)) return null;
    featureCaps[feature] = cap;
  }
  return { ai_daily_limit: record.ai_daily_limit, ai_feature_caps: featureCaps };
}

/** API の data を BillingSummaryWire として読む。形が違えば null (画面は「契約の状態を読み込めませんでした」) */
export function parseBillingSummaryWire(data: unknown): BillingSummaryWire | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const features = parsePlanFeaturesWire(r.features);
  if (
    typeof r.plan_key !== "string" ||
    typeof r.effective_plan_key !== "string" ||
    !(r.status === null || isOneOf(SUBSCRIPTION_STATUSES_WIRE, r.status)) ||
    !(r.source === null || isOneOf(BILLING_SOURCES_WIRE, r.source)) ||
    !(r.manage_in_store === null || isPurchaseStore(r.manage_in_store)) ||
    !(r.billing_interval === null || isOneOf(BILLING_INTERVALS_WIRE, r.billing_interval)) ||
    !isStringOrNull(r.current_period_end) ||
    !isStringOrNull(r.trial_ends_at) ||
    typeof r.cancel_at_period_end !== "boolean" ||
    !isStringOrNull(r.cancel_at) ||
    typeof r.has_customer !== "boolean" ||
    typeof r.can_purchase !== "boolean" ||
    typeof r.can_cancel !== "boolean" ||
    typeof r.can_resume !== "boolean" ||
    features === null
  ) {
    return null;
  }
  return {
    plan_key: r.plan_key,
    effective_plan_key: r.effective_plan_key,
    status: r.status,
    source: r.source,
    manage_in_store: r.manage_in_store,
    billing_interval: r.billing_interval,
    current_period_end: r.current_period_end,
    trial_ends_at: r.trial_ends_at,
    cancel_at_period_end: r.cancel_at_period_end,
    cancel_at: r.cancel_at,
    has_customer: r.has_customer,
    can_purchase: r.can_purchase,
    can_cancel: r.can_cancel,
    can_resume: r.can_resume,
    features,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 契約の状態の文 (src/lib/billing/core.ts の billingStatusLines と同じ文。モバイルの購入の画面が使う。
// tests/billing-status-lines-parity.test.ts のテスト 93 が、live の 5 値 × 解約の予約の有無 × 日付の有無で両者の一致を見る)
// ─────────────────────────────────────────────────────────────────────────────

/** live な 5 値の 1 行目の文 (core.ts の BILLING_STATUS_TEXT と同じ) */
export const SUBSCRIPTION_STATUS_TEXT_WIRE = {
  trialing: "無料期間中",
  active: "ご利用中",
  past_due: "お支払いに問題があります。お支払い方法をご確認ください",
  grace: "お支払いが確認できないため一部の機能を制限しています",
  paused: "一時停止中",
} as const;
type LiveStatusWire = keyof typeof SUBSCRIPTION_STATUS_TEXT_WIRE;
const LIVE_STATUSES_WIRE: readonly LiveStatusWire[] = ["trialing", "active", "past_due", "grace", "paused"];
/** 解約の予約で日付が無いときの文 (core.ts の BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT と同じ) */
export const CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE = "期間の終わりに解約されます";

/** 日本時間の UTC からのずれ (ミリ秒)。日本は夏時間が無い */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** Date の月 (0 始まり) を暦の月にする */
const MONTH_INDEX_OFFSET = 1;

/** ISO の日時を日本時間の日付「2026年10月21日」にする (Intl を使わない)。null・日時として読めない値は null */
export function formatBillingDateWire(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const jst = new Date(time + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + MONTH_INDEX_OFFSET}月${jst.getUTCDate()}日`;
}

/**
 * 契約の状態の文 (core.ts の billingStatusLines と同じ規則)。1 行目 = status の文 (trialing は「無料期間中（X まで）」)、
 * 2 行目 = 解約の予約中なら「X に解約されます」(日付 = cancel_at、無ければ current_period_end)。live でなければ空
 */
export function subscriptionStatusLines(
  summary: Pick<BillingSummaryWire, "status" | "trial_ends_at" | "current_period_end" | "cancel_at_period_end" | "cancel_at">,
): string[] {
  const status = LIVE_STATUSES_WIRE.find((value) => value === summary.status);
  if (status === undefined) return [];
  const trialEnd = status === "trialing" ? formatBillingDateWire(summary.trial_ends_at) : null;
  const lines = [trialEnd === null ? SUBSCRIPTION_STATUS_TEXT_WIRE[status] : `${SUBSCRIPTION_STATUS_TEXT_WIRE[status]}（${trialEnd}まで）`];
  if (summary.cancel_at_period_end) {
    const cancelDate = formatBillingDateWire(summary.cancel_at ?? summary.current_period_end);
    lines.push(cancelDate === null ? CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE : `${cancelDate}に解約されます`);
  }
  return lines;
}
```

- 料金ページ・特商法・FAQ・紹介ページ・Web の契約の画面は `@homegohan/shared` から `PLAN_CATALOG`・`FREE_PLAN_FEATURES`・`FREE_PLAN_AI_LIMIT_NOTE`・`planCatalogPriceText`・`planDisplayName`・`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL` を import する。退会の 4 つの入口 (§10.4) は `STORE_SUBSCRIPTION_DELETION_NOTICE` を import する。
- 価格が DB と違う運用 (運営の価格変更 API) をしたときは、このファイルも同じ PR で直す (契約テスト 37 が赤になる)。
- `PURCHASE_STORES` は `iap-core.ts` の `IAP_STORES` と同じ (テスト 95)。`BillingSummaryWire` は `core.ts` の `BillingSummary` と同じ形 (テスト 94)。`subscriptionStatusLines` は `core.ts` の `billingStatusLines` と同じ文 (テスト 93)。

### 8.10 モバイル (`apps/mobile`)

```ts
// tsc:skip place=apps/mobile/src/lib/purchases.ts
/**
 * RevenueCat (react-native-purchases) の薄い包み (billing/03 §8.10)。画面はこれだけを呼ぶ。
 *  - app_user_id = Supabase の利用者 id (useAuth().user.id)。ログインのたびに identify、サインアウトで logOut (別の利用者に購入を引き継がない)
 *  - 公開 SDK キー (EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY / EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY) はビルド時に埋め込む。名前は直接書く (src/lib/env.ts の規則)
 *  - キーが無いビルドでは configure せず、isAvailable() が false (購入の画面はストアの購入を出さない)
 *  - Expo Go では動かない (開発ビルドが要る。P1)
 */
import { Platform } from "react-native";
import Purchases, {
  INTRO_ELIGIBILITY_STATUS,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOfferings,
  type PurchasesPackage,
} from "react-native-purchases";
import type { TrialEligibility } from "./iap-catalog";

function apiKeyForPlatform(): string | null {
  // 名前を直接書く (Metro の置き換えは process.env.EXPO_PUBLIC_X の形だけ)
  const apple = process.env.EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY;
  const google = process.env.EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY;
  const key = Platform.OS === "ios" ? apple : Platform.OS === "android" ? google : undefined;
  return key !== undefined && key.trim() !== "" ? key.trim() : null;
}

let configuredAppUserId: string | null = null;

/** このビルドでストアの購入を扱えるか (キーがある・iOS か Android) */
export function isPurchasesAvailable(): boolean {
  return apiKeyForPlatform() !== null;
}

/** ログイン中の利用者で RevenueCat を使えるようにする。2 回目以降は logIn で切り替える (同じ id なら何もしない) */
export async function identifyPurchases(userId: string): Promise<void> {
  const apiKey = apiKeyForPlatform();
  if (apiKey === null) return;
  if (configuredAppUserId === null) {
    if (__DEV__) await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey, appUserID: userId });
    configuredAppUserId = userId;
    return;
  }
  if (configuredAppUserId !== userId) {
    await Purchases.logIn(userId);
    configuredAppUserId = userId;
  }
}

/** サインアウトのとき。匿名でなければ logOut (次の利用者に購入を引き継がない)。失敗しても投げない */
export async function resetPurchasesOnSignOut(): Promise<void> {
  if (configuredAppUserId === null) return;
  try {
    if (!(await Purchases.isAnonymous())) await Purchases.logOut();
  } catch {
    // 通信の失敗など。次の identify が logIn で切り替える
  } finally {
    configuredAppUserId = null;
  }
}

export async function fetchOfferings(): Promise<PurchasesOfferings> {
  return Purchases.getOfferings();
}

export type PurchaseOutcome = { ok: true; customerInfo: CustomerInfo } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: unknown };

/** 購入 (ストアのシートを出す)。利用者の取り消しは cancelled */
export async function purchase(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { ok: true, customerInfo };
  } catch (error) {
    const cancelled = typeof error === "object" && error !== null && "userCancelled" in error && (error as { userCancelled?: unknown }).userCancelled === true;
    return cancelled ? { ok: false, cancelled: true } : { ok: false, cancelled: false, error };
  }
}

/** 購入の復元 (利用者がボタンを押したときだけ呼ぶ。P3) */
export async function restore(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

export async function currentCustomerInfo(): Promise<CustomerInfo | null> {
  if (configuredAppUserId === null) return null;
  return Purchases.getCustomerInfo();
}

/** SDK の体験の判定 (INTRO_ELIGIBILITY_STATUS) → 画面の判定 (iap-catalog.ts の TrialEligibility) */
const TRIAL_ELIGIBILITY_OF_STATUS: Readonly<Record<INTRO_ELIGIBILITY_STATUS, TrialEligibility>> = {
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_UNKNOWN]: "unknown",
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE]: "ineligible",
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE]: "eligible",
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS]: "no_offer",
};

/**
 * 商品ごとの無料体験の対象の判定 (iOS だけ。SDK の checkTrialOrIntroductoryPriceEligibility。Android は常に UNKNOWN を返す SDK の仕様なので
 * 呼ばずに空を返す。Google Play は対象の利用者にだけ offer を返す)。失敗・未設定は空 (= 体験の文を出さない。iap-catalog.ts の storeTrialOf)
 */
export async function fetchTrialEligibility(productIds: readonly string[]): Promise<Record<string, TrialEligibility>> {
  if (Platform.OS !== "ios" || productIds.length === 0 || configuredAppUserId === null) return {};
  try {
    const result = await Purchases.checkTrialOrIntroductoryPriceEligibility([...productIds]);
    const eligibility: Record<string, TrialEligibility> = {};
    for (const [productId, value] of Object.entries(result)) eligibility[productId] = TRIAL_ELIGIBILITY_OF_STATUS[value.status] ?? "unknown";
    return eligibility;
  } catch {
    return {};
  }
}
```

```ts
/**
 * apps/mobile/src/lib/iap-catalog.ts (新設。import なしで単独で型検査できる)
 * カタログ (GET /api/billing/iap/catalog) の読み取りと offerings の突き合わせ (純粋。RN の API は使わない。__tests__/lib/iap-catalog.test.ts)。
 * 画面に出すのは、カタログにあり、かつ offerings にある商品だけ (どちらか一方に無い商品は出さない。R18)。
 * 無料体験の文は、ストアが返す商品の導入価格 (introPrice) と体験の対象の判定から作る (DB の trial_days からは作らない。R15・S29)
 */
export interface CatalogPlanLike {
  plan_key: string;
  display_name: string;
  max_members: number | null;
  products: Array<{ billing_interval: "month" | "year"; product_id: string }>;
}
/** react-native-purchases の PurchasesIntroPrice のうち読む項目 (price は現地の通貨の金額。0 = 無料体験) */
export interface IntroPriceLike {
  price: number;
  periodUnit: string;
  periodNumberOfUnits: number;
  cycles: number;
}
export interface PackageLike {
  identifier: string;
  product: { identifier: string; priceString: string; introPrice: IntroPriceLike | null };
}
/** 体験の対象かの判定 (iOS の checkTrialOrIntroductoryPriceEligibility の 4 値を写したもの。purchases.ts の fetchTrialEligibility が作る) */
export type TrialEligibility = "eligible" | "ineligible" | "unknown" | "no_offer";
/** 画面に出す無料体験 (lengthText は「7 日間」「1 か月」の形) */
export interface StoreTrial {
  lengthText: string;
}
export interface PurchasablePlanCard {
  plan_key: string;
  display_name: string;
  max_members: number | null;
  options: Array<{
    billing_interval: "month" | "year";
    product_id: string;
    priceString: string;
    packageIdentifier: string;
    /** この利用者が受けられる無料体験 (無ければ null) */
    trial: StoreTrial | null;
  }>;
}

/** 1 週間の日数 (ストアの体験の期間の単位 WEEK を日に直す。Web の体験の日数と同じ書き方にするため) */
const DAYS_PER_WEEK = 7;
/** 導入価格の期間の単位 → 日数への掛け算と文の単位。知らない単位は体験の文を出さない */
const TRIAL_PERIOD_UNITS: Readonly<Record<string, { multiplier: number; suffix: string }>> = {
  DAY: { multiplier: 1, suffix: "日間" },
  WEEK: { multiplier: DAYS_PER_WEEK, suffix: "日間" },
  MONTH: { multiplier: 1, suffix: "か月" },
  YEAR: { multiplier: 1, suffix: "年" },
};

/**
 * この利用者に出してよい無料体験 (R15・S29)。
 *   - 導入価格が無い、または 0 円でない (割引の導入価格) → null (無料体験ではない)
 *   - App Store: 体験の対象かを SDK に尋ねた答えが eligible のときだけ。unknown・ineligible・no_offer・答えが無いときは出さない
 *     (SDK の案内:「The best course of action on unknown status is to display the non-intro pricing」)
 *   - Google Play: Google が対象の利用者にだけ offer を返すので、導入価格があれば出す (判定の答えは使わない)
 */
export function storeTrialOf(
  store: "app_store" | "play_store",
  pkg: PackageLike,
  eligibility: Readonly<Record<string, TrialEligibility>>,
): StoreTrial | null {
  const intro = pkg.product.introPrice;
  if (intro === null || intro.price !== 0) return null;
  if (store === "app_store" && eligibility[pkg.product.identifier] !== "eligible") return null;
  const unit = TRIAL_PERIOD_UNITS[intro.periodUnit];
  if (unit === undefined) return null;
  const length = intro.periodNumberOfUnits * Math.max(1, intro.cycles) * unit.multiplier;
  if (!Number.isInteger(length) || length <= 0) return null;
  return { lengthText: `${length} ${unit.suffix}` };
}

export function matchCatalogWithPackages(
  store: "app_store" | "play_store",
  plans: readonly CatalogPlanLike[],
  packages: readonly PackageLike[],
  eligibility: Readonly<Record<string, TrialEligibility>>,
): PurchasablePlanCard[] {
  const byProduct = new Map<string, PackageLike>();
  for (const pkg of packages) byProduct.set(pkg.product.identifier, pkg);
  const cards: PurchasablePlanCard[] = [];
  for (const plan of plans) {
    const options: PurchasablePlanCard["options"] = [];
    for (const product of plan.products) {
      const pkg = byProduct.get(product.product_id);
      if (pkg === undefined) continue;
      options.push({
        billing_interval: product.billing_interval,
        product_id: product.product_id,
        priceString: pkg.product.priceString,
        packageIdentifier: pkg.identifier,
        trial: storeTrialOf(store, pkg, eligibility),
      });
    }
    if (options.length > 0) cards.push({ plan_key: plan.plan_key, display_name: plan.display_name, max_members: plan.max_members, options });
  }
  return cards;
}

/** 月額 / 年額の行の文 (自動更新の説明を含む。ストアの審査の要件 P9・P10)。体験の文は storeTrialOf が返したときだけ */
export function renewalText(interval: "month" | "year", priceString: string, trial: StoreTrial | null): string {
  const period = interval === "month" ? "1 か月" : "1 年";
  const trialText = trial === null ? "" : `${trial.lengthText}の無料体験のあと、`;
  return `${trialText}${period}ごとに ${priceString} が自動で更新されます。解約しない限り更新が続きます。`;
}

const CATALOG_INTERVALS: ReadonlyArray<"month" | "year"> = ["month", "year"];
const isCatalogInterval = (value: unknown): value is "month" | "year" =>
  typeof value === "string" && (CATALOG_INTERVALS as readonly string[]).includes(value);

/**
 * GET /api/billing/iap/catalog の data を読む。store が違う・形が違う項目は捨てる (全体の形が違えば空。画面はプランの一覧を出さない)
 */
export function parseIapCatalogPlans(data: unknown, store: string): CatalogPlanLike[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as { store?: unknown; plans?: unknown };
  if (record.store !== store || !Array.isArray(record.plans)) return [];
  const plans: CatalogPlanLike[] = [];
  for (const item of record.plans) {
    if (!item || typeof item !== "object") continue;
    const plan = item as { plan_key?: unknown; display_name?: unknown; max_members?: unknown; products?: unknown };
    if (typeof plan.plan_key !== "string" || typeof plan.display_name !== "string") continue;
    if (!(plan.max_members === null || (typeof plan.max_members === "number" && Number.isInteger(plan.max_members)))) continue;
    if (!Array.isArray(plan.products)) continue;
    const products: CatalogPlanLike["products"] = [];
    for (const entry of plan.products) {
      if (!entry || typeof entry !== "object") continue;
      const product = entry as { billing_interval?: unknown; product_id?: unknown };
      if (isCatalogInterval(product.billing_interval) && typeof product.product_id === "string" && product.product_id !== "") {
        products.push({ billing_interval: product.billing_interval, product_id: product.product_id });
      }
    }
    if (products.length > 0) {
      plans.push({ plan_key: plan.plan_key, display_name: plan.display_name, max_members: plan.max_members, products });
    }
  }
  return plans;
}
```

```ts
// tsc:skip place=apps/mobile/src/lib/billing-api.ts
/**
 * 課金の API の読み書き (billing/03 §8.10)。購入の画面 (app/settings/plan.tsx) と究極モードの錠 (V4GenerateModal) が使う。
 * 応答の data は @homegohan/shared の parseBillingSummaryWire と ./iap-catalog の parseIapCatalogPlans で読む。
 * Web の購入のページ (料金・契約の管理) のパスは書かない (__tests__/app/no-web-purchase-links.test.ts)
 */
import { parseBillingSummaryWire, type BillingSummaryWire, type PurchaseStore } from "@homegohan/shared";
import { getApi } from "./api";
import { parseIapCatalogPlans, type CatalogPlanLike } from "./iap-catalog";

export const BILLING_SUBSCRIPTION_API_PATH = "/api/billing/subscription";
export const IAP_CATALOG_API_PATH = "/api/billing/iap/catalog";
export const IAP_SYNC_API_PATH = "/api/billing/iap/sync";

/** 契約の状態を読めなかったときの文 (要約の形が違う・通信の失敗) */
export const BILLING_SUMMARY_LOAD_FAILED_MESSAGE = "契約の状態を読み込めませんでした。時間をおいてお試しください。";
/** 購入・同期を完了できなかったときの汎用の文 (ストアやサーバの生の文は出さない) */
export const BILLING_PURCHASE_FAILED_MESSAGE = "購入を完了できませんでした。時間をおいてお試しください。";

/** 要約の形が想定と違った */
export class BillingSummaryShapeError extends Error {
  constructor() {
    super(BILLING_SUMMARY_LOAD_FAILED_MESSAGE);
    this.name = "BillingSummaryShapeError";
  }
}

function summaryOrThrow(body: { data?: unknown } | null | undefined): BillingSummaryWire {
  const summary = parseBillingSummaryWire(body?.data);
  if (summary === null) throw new BillingSummaryShapeError();
  return summary;
}

/** GET /api/billing/subscription */
export async function fetchBillingSummary(): Promise<BillingSummaryWire> {
  return summaryOrThrow(await getApi().get<{ data?: unknown }>(BILLING_SUBSCRIPTION_API_PATH));
}

/** GET /api/billing/iap/catalog?store=… (形が違えば空) */
export async function fetchIapCatalog(store: PurchaseStore): Promise<CatalogPlanLike[]> {
  const body = await getApi().get<{ data?: unknown }>(`${IAP_CATALOG_API_PATH}?store=${store}`);
  return parseIapCatalogPlans(body?.data, store);
}

/** POST /api/billing/iap/sync (本文なし)。同期後の要約を返す */
export async function syncIapPurchases(): Promise<BillingSummaryWire> {
  return summaryOrThrow(await getApi().post<{ data?: unknown }>(IAP_SYNC_API_PATH));
}

/** サーバが固定の文を返す同期のエラーのコード (src/lib/billing/iap-core.ts の IAP_ERROR_MESSAGES の 4 つ。文はサーバの固定の文をそのまま出す) */
const IAP_FIXED_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "BILL_IAP_SYNC_CONFLICT",
  "BILL_IAP_UNKNOWN_PRODUCT",
  "EXT_REVENUECAT_NOT_CONFIGURED",
  "EXT_REVENUECAT_API_FAILED",
]);
// "HTTP 409 Conflict: {...}" (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/**
 * 同期・購入の失敗を画面の文にする。HTTP のエラーで本文が { error: { code, message } } かつ code が IAP_FIXED_MESSAGE_CODES のときは
 * サーバの固定の文、それ以外の HTTP のエラーは BILLING_PURCHASE_FAILED_MESSAGE。HTTP の形でない例外 (getApi の通信の失敗の固定の文・
 * withFriendlyErrors が置き換えた例外) は、その message をそのまま返す
 */
export function billingErrorMessageOf(error: unknown): string {
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string" || raw === "") return BILLING_PURCHASE_FAILED_MESSAGE;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (match === null) return raw;
  try {
    const body: unknown = JSON.parse(match[2]);
    const nested = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
    if (nested && typeof nested === "object") {
      const { code, message } = nested as { code?: unknown; message?: unknown };
      if (typeof code === "string" && IAP_FIXED_MESSAGE_CODES.has(code) && typeof message === "string") return message;
    }
  } catch {
    // 本文が JSON でない
  }
  return BILLING_PURCHASE_FAILED_MESSAGE;
}
```

- 購入の画面 `apps/mobile/app/settings/plan.tsx` の仕様は §10.6 (画面の文・要素・振る舞いをそこに書く。コードはその仕様の展開)。画面が使う識別子の取り込み元は次の表のとおり (モバイルは Web の `src/` を import しない):

| 識別子 | 取り込み元 |
|---|---|
| `BillingSummaryWire`・`PurchaseStore`・`PLAN_CATALOG`・`planDisplayName`・`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL`・`subscriptionStatusLines` | `@homegohan/shared` (`packages/shared/src/billing-plans.ts`。§8.9) |
| `fetchBillingSummary`・`fetchIapCatalog`・`syncIapPurchases`・`billingErrorMessageOf`・`BILLING_SUMMARY_LOAD_FAILED_MESSAGE`・`BILLING_PURCHASE_FAILED_MESSAGE` | `apps/mobile/src/lib/billing-api.ts` |
| `matchCatalogWithPackages`・`storeTrialOf`・`renewalText`・`CatalogPlanLike`・`PackageLike`・`PurchasablePlanCard`・`TrialEligibility`・`StoreTrial` | `apps/mobile/src/lib/iap-catalog.ts` |
| `isPurchasesAvailable`・`identifyPurchases`・`fetchOfferings`・`fetchTrialEligibility`・`purchase`・`restore`・`currentCustomerInfo` | `apps/mobile/src/lib/purchases.ts` |
| `getTermsUrl`・`getPrivacyUrl`・`webPageUrl` | `apps/mobile/src/lib/siteConfig.ts` (設定タブ `app/(tabs)/settings.tsx:13` と同じ) |
| `PageHeader`・`LoadingState`・`Button`・`Card` | `apps/mobile/src/components/ui` (`app/settings/account.tsx:8` と同じ) |
| `useAuth` | `apps/mobile/src/providers/AuthProvider` |
- `apps/mobile/src/providers/AuthProvider.tsx` の差分: セッションが決まったとき (`applySession` で `userId` が入ったとき) に `identifyPurchases(userId)` を待たずに呼ぶ (`.catch` でログだけ)。`apps/mobile/src/lib/signOut.ts` の `signOutOnDevice` / `signOutWithCleanup` / `signOutAfterAccountDeletion` の掃除の前に `await resetPurchasesOnSignOut()` を足す (失敗しても投げない)。
- 設定タブ `apps/mobile/app/(tabs)/settings.tsx`: 「個人情報」の節の最後 (栄養目標の行の下) に `SettingRow` (icon `💳`・iconBg `#FFF7ED`・title `プランとお支払い`・subtitle `有料プランの購入・復元・購読の管理`・testID `settings-plan-row`・`onPress={() => router.push(PLAN_SCREEN_PATH)}`) を足す。`PLAN_SCREEN_PATH = "/settings/plan"` は `apps/mobile/src/lib/plan-screen.ts` (純) に置く。栄養目標の行から `last` を外し、新しい行に `last` を付ける。
- 依存の追加と `package-lock.json` の作り直し (段 D の最初の 2 コミット。P19):
  1. `apps/mobile/package.json` の `dependencies` に `"expo-dev-client": "~58.0.14"` (`expo` 58.0.14 の `bundledNativeModules.json` の値の逐語。`npx expo install expo-dev-client` が書く値と同じ) と `"react-native-purchases": "10.14.0"` (P2 の版の固定。`bundledNativeModules.json` に無いので `npx expo install` は `^` 付きで npm の最新を書くが、本冊は版を固定する) を名前の順 (npm が並べる順。`expo-dev-client` は `expo-constants` と `expo-device` の間、`react-native-purchases` は `react-native` と `react-native-reanimated` の間) で手で書き、commit する。`react-native-purchases-ui` は入れない。ルートの `package.json` (依存・`overrides`)・`apps/mobile/app.json` (`plugins`)・`apps/mobile/eas.json` は変えない (`react-native-purchases` は config plugin を持たず、`expo-dev-client` の plugin は prebuild が自動で当てる。開発ビルドの `development` の profile は既にある。F10・P1・P19)。
  2. worktree で `npm install` / `npx expo install` を打たない (M2 に依存を入れない)。`package-lock.json` は npm が作った差分だけを使い、手で書かない。offload (dev-infra の offload コマンド) の行き先で lock だけを作り直して持ち帰る: `offload --host auto --no-install --fetch package-lock.json -e TZ=UTC -- sh -c 'npm install --package-lock-only --ignore-scripts || { npm install --package-lock-only --legacy-peer-deps --ignore-scripts && npm install --package-lock-only --ignore-scripts; }'` (`--no-install` は、1 の commit の時点では lock と `package.json` が食い違っていて行き先の `npm ci` が通らないため。ERESOLVE のときの 2 回の作り直しは、リポジトリの CLAUDE.md の「ルートと `apps/mobile` の React の版の違いで ERESOLVE になる」ときの手順と同じ)。持ち帰った lock を commit する。
  3. lock の差分の期待 (`git diff HEAD~1 -- package-lock.json` で確かめる。①〜④ と違えば (既存のキーの `version` か置き場が変わった・入れ子が増えた)、lock を手で直さず、4 の番兵を流した結果と変わったキーの一覧を添えて報告する (段 D を止める)。npm が既存の行の `dev` / `peer` などの印だけを書き換えるのは期待どおり): ① `packages["apps/mobile"].dependencies` に 1 の 2 行 ② ルートの `node_modules/` に新しいキー 8 つ = `react-native-purchases` (10.14.0)・`@revenuecat/purchases-js-hybrid-mappings` (19.12.0)・`@revenuecat/purchases-typescript-internal` (19.12.0)・`@revenuecat/purchases-js` (1.70.0)・`expo-dev-client`・`expo-dev-launcher`・`expo-dev-menu`・`expo-dev-menu-interface` (expo の 4 つは 58.0.x。版は `~` の範囲の中で npm が選ぶ) ③ 既存のキーの `version` と置き場 (キーの名前) は変わらない (`expo-manifests`・`expo-updates-interface`・`expo-json-utils`・`@expo/schema-utils` は既にルートにあり、そのまま共有する) ④ `apps/mobile/node_modules/` の下のキーは `@types/react` と `react` の 2 つのまま。
  4. offload の行き先で `npm ci --dry-run` と、依存の宣言か lock を読む番兵 (§16.1 の母集合の作り方 13 の 6 本) を流す: `offload --host auto -e TZ=UTC -- sh -c 'npm ci --dry-run && npx vitest run tests/mobile-toolchain-contract.test.ts tests/react-types-version-contract.test.ts tests/zod-single-copy-1444.test.ts tests/openai-sdk-v7-contract.test.ts tests/posthog-not-adopted-contract.test.ts tests/mobile-test-workflow-paths.test.ts'`。赤のとき (とくに ④ が崩れて `react-native` ほかが `apps/mobile/node_modules` に入れ子になったとき) は、番兵の期待 (`MOBILE_NESTED_ALLOWED`・`HOISTED_TOOLCHAIN`・`BUNDLED_PINNED`・`REMOVED_UNUSED`) を変えず、lock を手で直さず、lock の入れ子のキーの一覧を添えて報告する (段 D を止める)。
  5. 段 D の PR は依存 (`package.json` / `package-lock.json`) を変えるので、リポジトリの CLAUDE.md の「マージ前の検査」のとおり、`security.yml` の dependency review と npm audit の緑を待ってからマージする (ローカルの検査では再現できない。`tests/local-ci-workflow-sync.test.ts` の `EXCLUDED_JOBS` の理由と同じ)。
- jest: `apps/mobile/__mocks__/react-native-purchases.js` (`configure` / `setLogLevel` / `logIn` / `logOut` / `isAnonymous` / `getOfferings` / `purchasePackage` / `restorePurchases` / `getCustomerInfo` / `checkTrialOrIntroductoryPriceEligibility` を `jest.fn()` で持つ default export と、名前の export `LOG_LEVEL`・`PURCHASES_ERROR_CODE`・`INTRO_ELIGIBILITY_STATUS` (`{ INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0, INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 1, INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 2, INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS: 3 }`。P15 の値)) と `jest.config.js` の `moduleNameMapper` に `'^react-native-purchases$': '<rootDir>/__mocks__/react-native-purchases.js'`。

---

## 9. API 仕様

共通: 本文は `{ data }` / `{ error: { code, message } }` (cross/04 §5)。固定の文だけ (生のエラー文を入れない)。`Cache-Control: no-store`。レート制限は既存のカテゴリ `billing`。

### 9.1 `POST /api/webhooks/revenuecat` — RevenueCat の Webhook の受け口

| 項目 | 内容 |
|---|---|
| 認証 | 署名 (`X-RevenueCat-Webhook-Signature`。§8.2)。ログインのセッションは見ない。middleware (`lib/supabase/middleware.ts`) は変えない: `/api` の分岐 (`:179-`) は認証を要求せず、凍結・メンテナンス・同意だけを見る。セッションを持たない Webhook は凍結の判定に当たらず (利用者が無い)、同意のゲートは許可リストの `/api/webhooks` (prefix・`no_user_session`。`packages/shared/src/legal-consent-api.ts:135`) が通す。Stripe の受け口 (`/api/webhooks/stripe`) も同じで、どちらも middleware に専用の除外の一覧は無い |
| 本文 | `{ api_version: '1.0', event: {...} }` (P4)。256 KiB 以下 |
| 流れ | 大きさ → 署名 → 外形 (`RevenueCatWebhookEnvelopeSchema`) → 鍵 → claim (`billing_claim_revenuecat_event`。`payload` は最小化した写し) → `handleRevenueCatEvent` (取り直し → 写像) → finish |
| 応答 | §13.2 |
| メンテナンス中 | 503 (Stripe の受け口と同じ。`src/lib/maintenance-mode.ts` の `isMaintenanceExemptPath` (`:87-110`) は止めないパスを列挙するだけで、列挙に無い `/api` は既定で止まる (`:76-80` の注のとおり Stripe の Webhook もこれで止まる)。`maintenance-mode.ts` は変えない。`/api/webhooks/revenuecat` と `/api/billing/iap/*` が止まることはテスト 132・133 が固定する)。RevenueCat は 5 回まで再送する (P4)。それで止まった分は本人の操作からの同期と遅延の再同期が受ける (Q-11) |
| 環境 | `event.environment` が `SANDBOX` のイベントも本番の受け口に届く (RevenueCat は環境を分けない。P4)。本冊は環境で分けない: `SANDBOX` も `PRODUCTION` も同じ流れで取り直して写す (App Store の審査・TestFlight・Google Play の内部テストの購入を権利にするため。Q-13・P12・S24)。どの行がテストの購入かは、取り直した `subscriptions[].is_sandbox` を写像が `personal_subscriptions.iap_is_sandbox` と監査の details の `is_sandbox` に残す (§6.4)。同期の API・遅延の再同期も同じ (route・`handleRevenueCatEvent`・`syncStoreSubscriber` のどこにも環境の分岐を置かない)。環境変数での切り替えは持たない |

### 9.2 `GET /api/billing/iap/catalog?store=app_store|play_store` — ストアで買えるプランと商品 ID

| 項目 | 内容 |
|---|---|
| 認証 | `requireUser` (凍結中は 403。未同意は 403 `LEGAL_CONSENT_REQUIRED`) |
| 入力 | クエリ `store` (`IapCatalogQuerySchema`)。それ以外は 400 `BILL_IAP_INVALID_INPUT` |
| 出力 | `{ data: IapCatalog }` = `{ store, plans: [{ plan_key, display_name, max_members, products: [{ billing_interval, product_id }] }] }`。売る行 (`offered = true`) が無いプランは入らない。価格と無料体験は返さない (ストアの表示が正。アプリは `package.product.priceString` と `introPrice`・体験の対象の判定から出す。§8.10) |
| 読むもの | `listPublicPlans()` (§8.6) と `plan_store_products` の `offered = true` の行 (公開の SELECT)。鍵は見ない |

### 9.3 `POST /api/billing/iap/sync` — 本人のストアの契約の同期

| 項目 | 内容 |
|---|---|
| 認証 | `requireUser` (凍結中は 403・未同意は 403)。本文なし |
| 流れ | `createRevenueCatGateway()` (鍵が無ければ 503) → `syncStoreSubscriber(deps, user.id, 'iap_sync')` → `getBillingSummary` |
| 応答 | 200 `{ data: BillingSummary }` / 409 `BILL_IAP_SYNC_CONFLICT` (別の live 行) / 422 `BILL_IAP_UNKNOWN_PRODUCT` / 502 `EXT_REVENUECAT_API_FAILED` / 503 `EXT_REVENUECAT_NOT_CONFIGURED` / 429 `RATE_LIMITED` |
| 呼ぶとき (アプリ) | 購入の成功のあと・復元のあと・購入の画面を開いたとき・アプリが前面に戻ったとき (購入の画面が開いている間) |

### 9.4 `GET /api/billing/subscription` の差分 (遅延の再同期と `features`)

- 要約の前に `lazyResyncStoreSubscription` (§8.4・§8.5)。鍵が無い・失敗は要約を止めない。
- `BillingSummary` に `manage_in_store` と `features` が増える (§8.6)。既存の項目は変えない。

### 9.5 家族の API のエラーの写し (`FAMILY_PLAN_REQUIRED`)

- `POST /api/family/groups` (`create_family_group`)・`POST /api/family/invites/[id]/accept` (`accept_family_invite`)・`POST /api/family/members/child` (`add_family_child`) の 3 本の route は、RPC のエラー文に `FAMILY_PLAN_REQUIRED` が含まれるとき 402 `{ error: { code: 'FAMILY_PLAN_REQUIRED', message: MEMBERSHIP_ERROR_MESSAGES.FAMILY_PLAN_REQUIRED } }` を返す (既存の `MEMBER_LIMIT_EXCEEDED` の写しと同じ形。route は DB の生の文を出さない)。
- `POST /api/family/promotions/[token]/accept` (`accept_child_promotion`) は変えない。昇格はいる行の UPDATE で門に当たらない (§6.6・Q-4) ので、`FAMILY_PLAN_REQUIRED` を返すことが無い。
- `src/lib/errors/membership-errors.ts`: `MembershipErrorCode.FAMILY_PLAN_REQUIRED = 'FAMILY_PLAN_REQUIRED'`、HTTP 402、文「家族プランのご契約が必要です。」を足す (§13.1)。
- `POST /api/family/invites` (招待の作成) は DB の門に当たらない (INSERT は `family_invites`) が、作っても承諾できないので、route の最初で `billing_has_live_family_plan` 相当の判定はしない (招待を作れる・承諾で 402 になる、より先に止めるかは §18 の 6)。

---

## 10. 画面 (Web と公開の面・モバイル)

### 10.1 `/pricing` (公開ページ) — 価格と内容は DB の値、CTA は買える間隔だけ (R2・Q-5)

土台は origin/main `4b1e1abe` の `src/app/pricing/PricingPageView.tsx` (#1911 の後。F2)。

- `src/app/pricing/page.tsx`: `listPurchasablePlans()` (`:10` の import・`:22` の呼び出し) を `listPublicPlans()` (§8.6) に替える (ほかは同じ。Cookie `is_native_app` で `isNativeApp`)。
- `src/app/pricing/PricingPageView.tsx` (`props: { plans: PublicPlan[]; isNativeApp: boolean }`。`PricingPageViewProps` の `plans` の型と注 (`:86`) を「公開のプラン (listPublicPlans。並びは display_order。Price の有無で絞らない)」に):
  - 冒頭の注 (`:3-11`) を書き直す: 「公開のプラン (listPublicPlans) ごとに有料のカードを 1 枚。カードの中は金額のある間隔 (月額・年額) の金額を常に出し、CTA は買える間隔 (isPurchasable が真) だけ。買える間隔が 1 つも無いカード (Stripe の Price を入れる前) は CTA を置かない。読み取りに失敗して 0 件のときはフリーのカードだけ。アプリの WebView (isNativeApp) では有料のカードと注記を描かない」。
  - 消すもの: `onSale` (`:97`) と、それを見る 2 か所 (見出しの下の「現在は無料でご利用いただけます。」の段落 `:123-127`、FAQ の節 `:221-239`)、`faqs` (`:67-69`)、`HelpCircle` の import (FAQ の節だけが使う)、フリーのカードの金額の横の「現在は無料」(`:147` の `<span>`)。見出しの下の段落の代わりの文は置かない。
  - 置き換えるもの: `freeFeatures` (`:44-57` の注と配列) と `AI_DAILY_LIMIT_NOTE` (`:59-65` の注と定数) を、`@homegohan/shared` の `FREE_PLAN_FEATURES` と `FREE_PLAN_AI_LIMIT_NOTE` (§8.9) の import に替える (使う場所 `:152` と `:161` は名前だけ替える)。`FREE_PLAN_AI_LIMIT_NOTE` は #1867 の Q-12 の共通の文 (「1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。」) を逐語で含む。
  - `showPaidCards` (`:99`) を `!isNativeApp && cards.length > 0` にし、`purchasable` (`:94-96`) を次の `cards` に替える: `const cards = plans.map((plan) => ({ plan, amounts: BILLING_INTERVALS.filter((interval) => (amountJpyFor(plan, interval) ?? 0) > 0), purchasable: BILLING_INTERVALS.filter((interval) => isPurchasable(plan, interval)) })).filter(({ amounts }) => amounts.length > 0);` (金額が 1 つも無いプランはカードにしない)。
  - 有料のカード (`cards` の順。`isNativeApp` では描かない。いまと同じ規則): 見出し `display_name`・`trial_days > 0` なら「X日間無料」(`:192-194` のまま)・`PLAN_CATALOG` の同じ `plan_key` の `features` の箇条書き (`PLAN_CATALOG` に無い `plan_key` は箇条書きなし。フリーのカードの箇条書きと同じ見た目 `:151-158`)・金額の行は `amounts` の間隔ごとに `¥{amount.toLocaleString(PRICE_LOCALE)}` と `INTERVAL_DISPLAY[interval].unit` (`:200-205` のまま)・CTA は `purchasable` に入っている間隔だけ (`INTERVAL_DISPLAY[interval].cta`。行き先は既存の `checkoutHref`)。`purchasable` が空のカードは CTA の代わりに何も置かない (文も置かない。Q-5)。
  - 注記 (有料のカードの下に 1 段落。`showPaidCards` のときだけ): 「お支払いはクレジットカード (Stripe) のほか、iOS / Android アプリでは App Store / Google Play のアプリ内課金でもお申し込みいただけます。アプリ内課金の価格は各ストアの表示が正となります。」(Q-1 で価格が違うときの説明を兼ねる)。
  - ページの末尾の「まずは無料で始めてみませんか？」+「無料で始める」(`:241-254`) は残す。グリッドの指定 (`:131`。`showPaidCards` なら `md:grid-cols-2 max-w-3xl`、無ければ `max-w-md`) はそのまま (有料 3 枚 + フリー 1 枚 = 2 列 × 2 行)。
- `tests/public-claims-guard.test.ts` の直し方は §16.1 の行 (F21 の各 it)。
- `src/lib/seo/public-pages.ts` の `/pricing` の description (`:99-102`「…の料金プランのご案内です。」) は変えない (「準備中」を含まない)。

### 10.2 `/legal` (特定商取引法に基づく表記) — 販売の項目を足す

土台は origin/main `4b1e1abe` の `src/app/legal/page.tsx` (#1911 の後。会社情報は入っている。F2・F13)。`src/lib/business-info.ts`・`src/components/legal/PhoneOnRequest.tsx`・`src/app/company/page.tsx` は変えない (Q-8・Q-9)。

- `rows` の `:29-30` の注 (「有料の販売で要る項目 … は、有料プランの販売 (#1912) が足す。それまでは「準備中」とも書かず、項目ごと出さない (#1911)。」) を「有料の販売の項目 (販売価格・支払方法など) は、価格を `@homegohan/shared` の `planCatalogPriceText()` (DB の価格の写し `PLAN_CATALOG`。tests/billing-plan-catalog.test.ts が DB と突き合わせる) から出し、文はこのファイルに書く (billing/03 §10.2)。」に書き換える。import に `import { PLAN_TRIAL_DAYS, planCatalogPriceText } from "@homegohan/shared";` を足す。
- `rows` (上から。既存の 8 行の値は変えない。`お問い合わせ` と `動作環境` の間に 9 行を足す。文は固定。`\n` は既存の `whitespace-pre-wrap` で改行になる):

  | label | value |
  |---|---|
  | 販売事業者 | `BUSINESS_NAME` (いまのまま) |
  | 代表者 | `BUSINESS_REPRESENTATIVE` (いまのまま) |
  | 所在地 | `BUSINESS_ADDRESS` (いまのまま) |
  | 電話番号 | `<PhoneOnRequest linkColor={colors.primary} />` (いまのまま) |
  | メールアドレス | `BUSINESS_EMAIL` (いまのまま) |
  | 営業時間 | `BUSINESS_HOURS` (いまのまま) |
  | お問い合わせ | (いまのまま。`/contact` のリンク) |
  | 販売価格 | `` `${planCatalogPriceText()}\n無料プランは 0 円です。` `` (3 行 + 1 行。税込) |
  | 商品代金以外の必要料金 | `'インターネット接続料金、通信料金等はお客様のご負担となります。'` (#1911 の前の行の文。`ad44c2c5` の `src/app/legal/page.tsx:45`) |
  | 支払方法 | `'Web: クレジットカード (決済の事業者 Stripe の決済画面で受け付けるカード)。\niOS / Android アプリ: App Store / Google Play のアプリ内課金。'` |
  | 支払時期 | `'Web: お申し込みの時に初回のお支払いをいただきます (無料体験のあるプランは、無料体験の終了時)。以後は毎月または毎年の更新日に自動でお支払いいただきます。\nアプリ内課金: 各ストアの定める時期にお支払いいただきます。'` |
  | サービス提供時期 | `'お支払いの手続き (無料体験のあるプランは、お申し込みの手続き) が完了した時点から、すぐにご利用いただけます。'` |
  | 返品・キャンセル | `'デジタルコンテンツの性質上、購入後の返品・返金は原則としてお受けしておりません。ただし、サービスに重大な瑕疵があった場合は、個別に対応いたします。\n\nApp Store / Google Play でお申し込みの場合の返金は、各ストアの規定によります。'` |
  | 解約について | `'いつでも解約できます。Web でお申し込みの方は本サービスの画面から、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。期間の途中の解約による日割りの返金はありません。'` |
  | 定期購入について | `'有料プランは自動更新の定期購入です。解約しない限り、月額または年額の期間ごとに同じ金額が自動で請求されます。'` |
  | 無料体験について | `` `Web でお申し込みの場合、どの有料プランも ${PLAN_TRIAL_DAYS} 日間の無料体験つきです (同じプランにつき 1 回)。無料体験の終了時に自動で有料の期間に移り、販売価格が請求されます。無料体験の間に解約すると、料金は請求されません。App Store / Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。` `` |
  | 動作環境 | (いまのまま。Q-12) |
  - 「最終更新日：2026年10月19日」(`:92`) は実装の日付に更新する。
  - 文に「準備中」「販売開始前」「近日」「予定」などの語と、販売していないことの説明の文 (`LEGAL_NOT_SELLING_TEXTS`) を書かない (F21)。
- 見張りの直し方: `tests/public-claims-guard.test.ts` の `/legal` の it (`:333-341`) を、販売の 9 行が出て値が文のとおりで、`LEGAL_NOT_SELLING_TEXTS` と `PENDING_WORDS` は出ない、に書き換える (§16.1)。`tests/business-info-legal-pages.test.ts` は変えない (行の値が空・仮置きでないことと会社情報の行を見る。販売の行も値を持つので緑)。`tests/e2e/b10-unexplored-areas.spec.ts` の 4-3 (`:282-283` の「販売価格」「支払方法」が無いこと) を、「販売価格」と `580円` が見えること、に書き換える (§16.1)。

### 10.3 `/account/billing`・究極モードの錠・料理画像の作成 (Web)

- `src/app/(main)/account/billing/page.tsx` (`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL`・`planDisplayName` は `@homegohan/shared` から import): `const store = summary.manage_in_store;` が null でないとき、ボタン (Portal・解約・取り消し) を描かず、状態の文の下に「`{IAP_STORE_LABELS[store]}` でご契約中です。解約・お支払い方法の変更は `{IAP_STORE_LABELS[store]}` の定期購読の管理から行えます。」と、`STORE_SUBSCRIPTION_MANAGEMENT_URL[store]` への外部リンク「定期購読の管理を開く」(`target="_blank" rel="noopener"`)。`isNativeApp` では文だけ (リンクも出さない。アプリの購入の画面が受け持つ)。`planLabel` は `planDisplayName(summary.plan_key)` を出す。
- 究極モードの錠 (`src/components/ai-assistant/V4GenerateModal.tsx`): `GET /api/billing/subscription` の `features.ai_feature_caps.menu_generation_ultimate` が `0` のとき、トグルを `aria-disabled` + 錠のアイコンにし、説明に「究極モードは有料プランでお使いいただけます」を出す (押しても ON にならない)。`features` が読めない (401・失敗) ときは錠を出さない (サーバの判定が最後の砦)。`ai_plan_feature_caps` に行の無いプラン (組織の plan の `standard`・`org_*` など) は `ai_feature_caps` に `menu_generation_ultimate` のキーが無い (`findPlanFeatures` は free の行に倒さない。§8.6) ので錠を出さない (サーバも環境変数の既定で使える。S26)。読むのは `src/hooks/useBillingSummary.ts` (新設。`export const BILLING_SUBSCRIPTION_API_PATH = '/api/billing/subscription';`・`export function useBillingSummary(enabled: boolean): BillingSummaryWire | null` = `enabled` が偽から真になるたびに `fetch(BILLING_SUBSCRIPTION_API_PATH)` を 1 回読み、`res.ok` なら本文の `data` を `@homegohan/shared` の `parseBillingSummaryWire` で読む。失敗・形が違うときは null。`SWR` は使わない) で、モーダルが開くたびに読む (`useBillingSummary(open)`)。
- 料理画像の作成 (`POST /api/ai/image/generate` を押す画面): 403 `AI_FEATURE_NOT_IN_PLAN` の本文の `error` (固定の文) をそのまま出す (既存の `daily-limit-client.ts` の経路。§8.8)。ボタンの錠は付けない (押して案内が出る)。
- 料理の画面 (Web の献立の画面で料理を押したときの `RecipeModal`。§8.8 の page.tsx の (b)・Q-16): 自分の画像の無い料理に献立のカバーを代わりに出すのは、`mealCoverRepresentsDish(dishesArray, idx)` が真のときだけ (料理が 1 品の献立・自動の料理画像の料理 (主菜。主菜の無い献立は先頭)・写真・商品・手の画像の料理)。主菜でない料理 (画像の無い状態) は `imageUrl` も `image_status` も無いので、`RecipeModal` は画像の枠を出さない (「画像なし」の表示。主菜の画像を別の料理の画像として出さない)。段 B の前に作られた主菜でない料理の AI の画像は、その料理の `image_url` なので今までどおり出る。主菜でない料理の画像を利用者が作りたいときは、献立の編集の「AIで画像生成」(`image_generation`。Q-3 の上限の中。無料は 403 の固定の文) で献立の画像 (料理が 2 品以上の献立では献立のカバー) を作る (料理を選んで作る入口は Q-18)。`RecipeModal.tsx` は上の文 (§8.8 の `skipped_plan`) のほかは変えない。

### 10.4 `/frozen/billing` と退会の画面

- `src/app/frozen/billing/page.tsx` (`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL` は `@homegohan/shared` から): `const store = summary.manage_in_store;` が null でないとき、解約のボタンを描かず「`{IAP_STORE_LABELS[store]}` の定期購読の管理から解約できます。」の文を出す (`STORE_SUBSCRIPTION_MANAGEMENT_URL[store]` へのリンクは `isNativeApp` でなければ出す)。
- 退会の確認 (R24・S35): 退会の API を呼ぶファイルは 4 つ (`git grep -l "deleteOwnAccount(" origin/main -- src/app src/components` の 3 ファイルと、`git grep -l '"/api/account/delete"' origin/main -- apps/mobile/app` の 1 ファイル。§16.1 の母集合の作り方 10)。画面は 5 つで、凍結中の退会 (`/frozen/account`) と同意の前の退会 (`/legal-consent/account`。cross/20 v1.14 の Q-23) は共通の部品 `src/components/account/AccountSelfServicePanel.tsx` が退会の API を呼ぶので、部品に 1 か所足せば両方に出る。4 つとも `@homegohan/shared` の `STORE_SUBSCRIPTION_DELETION_NOTICE` (§8.9。「App Store / Google Play でお申し込みの有料プランは、退会しても自動では解約されません。各ストアの定期購読の管理から解約してください。」) を import して出し、文をファイルに直接書かない。ストアの契約が無い人にも出す (退会の時に契約の有無を読みに行かない。固定の文。§7.1 の退会の行)。入口の一覧が閉じていることと、4 つが定数を使うことはテスト 127 が見る。

| 入口 | 置き場所 (origin/main `465727de` の行。設定の画面 (`settings/page.tsx`) は `4b1e1abe` から、同意の画面 (`LegalConsentForm.tsx`) は `2ba5b3b3` から行がずれていない。`AccountSelfServicePanel.tsx` とアプリのアカウント (`account.tsx`) は #1917 (`465727de`) で変わったので、行を数え直した) | 足すもの (逐語) |
|---|---|---|
| Web の設定の退会の確認 (`src/app/(main)/settings/page.tsx`。ブラウザだけに出る。アプリの中ではログアウトと退会をネイティブの設定に一本化している (#1037。`:65-67`)) | 確認のモーダルの `<p className="text-gray-500 mb-6 text-sm">…この操作は取り消せません。</p>` (`:727-730`) の直後 | `<p className="text-gray-500 mb-6 text-xs text-left">{STORE_SUBSCRIPTION_DELETION_NOTICE}</p>` |
| 凍結中の退会と同意の前の退会の共通の部品 (`src/components/account/AccountSelfServicePanel.tsx`。`src/app/frozen/account/page.tsx` (#1445。アプリでは凍結の画面の WebView (`apps/mobile/app/frozen.tsx`) で開く) と `src/app/legal-consent/account/AccountWithoutConsent.tsx` (#1901・cross/20 v1.14 の Q-23。アプリでは同意の画面の WebView (`apps/mobile/app/legal-consent.tsx`) で開く) が使う。2 つの画面のファイルは変えない) | 退会の節 (`<section aria-labelledby={deleteTitleId}>`) の `<p className="text-sm text-gray-500">…必要なデータは、先に書き出してください。</p>` (`:160-163`) の直後 | `<p className="text-sm text-gray-500">{STORE_SUBSCRIPTION_DELETION_NOTICE}</p>` |
| 規約の同意の画面の「登録をやめる」(`src/app/legal-consent/LegalConsentForm.tsx`。18 歳未満の本人の登録を断った案内と、保護者の同意とのつながりが無い案内。どちらも「登録をやめる」(`:205-221` の `handleWithdraw`) で退会する。アプリでは同意の画面の WebView (`apps/mobile/app/legal-consent.tsx`) で開く) | 案内の画面 (`noticeOrigin !== null` の枝) の見出しの下の `<p className="text-sm leading-relaxed text-gray-600">…Body…</p>` (`:249-251`) の直後 (同じ `<div className="space-y-2">` の中) | `<p className="text-sm leading-relaxed text-gray-600">{STORE_SUBSCRIPTION_DELETION_NOTICE}</p>` |
| アプリの設定のアカウント (`apps/mobile/app/settings/account.tsx`。ネイティブの `Alert.alert` (`:54-59`) で確かめてから `POST /api/account/delete` (`:75`) を呼び、WebView を通らない。ストアの契約はアプリでしか結べないので、ストアで買った人の退会はこの画面になる) | `deleteAccount` の確認の `Alert.alert` (`:55-58`) | 下のコード (本文に文を足し、「定期購読の管理を開く」のボタンを置く。P17) |

```ts
// tsc:skip place=apps/mobile/app/settings/account.tsx (react-native の import に Linking・Platform を足し、@homegohan/shared の import と 3 つの定数を足し、deleteAccount の確認の Alert.alert を置き換える)
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { STORE_SUBSCRIPTION_DELETION_NOTICE, STORE_SUBSCRIPTION_MANAGEMENT_URL, type PurchaseStore } from "@homegohan/shared";

/** 退会の確認の本文 (取り消せないことと、ストアの購読は退会で解約されないこと。billing/03 §10.4) */
const ACCOUNT_DELETE_CONFIRM_MESSAGE = `アカウントとデータを削除します。取り消しできません。\n\n${STORE_SUBSCRIPTION_DELETION_NOTICE}`;
/** 退会の確認から購読の管理を開くボタン (購入の画面 (billing/03 §10.6 の 2) のボタンと同じ文) */
const STORE_SUBSCRIPTION_MANAGE_BUTTON_LABEL = "定期購読の管理を開く";
/** この端末のストア (Android は Google Play、それ以外 (iOS) は App Store)。購読の管理のページの行き先を選ぶ */
const DEVICE_PURCHASE_STORE: PurchaseStore = Platform.OS === "android" ? "play_store" : "app_store";

// deleteAccount の中: いまの Alert.alert("アカウント削除", "アカウントとデータを削除します。取り消しできません。", [...]) を置き換える
    const ok = await new Promise<boolean>((resolve) => {
      Alert.alert("アカウント削除", ACCOUNT_DELETE_CONFIRM_MESSAGE, [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(false) },
        {
          text: STORE_SUBSCRIPTION_MANAGE_BUTTON_LABEL,
          // 購読の管理を開き、退会はしない (解約してから、もう一度「アカウント削除」を押す)。開けなかったときも退会しない
          onPress: () => {
            Linking.openURL(STORE_SUBSCRIPTION_MANAGEMENT_URL[DEVICE_PURCHASE_STORE]).catch(() => undefined);
            resolve(false);
          },
        },
        { text: "削除", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
```

- 見出し「アカウント削除」とボタンの文「キャンセル」「削除」は変えない (`apps/mobile/__tests__/settings/account-delete.test.tsx:132-138` の偽物が、この見出しのダイアログで文が「削除」のボタンを押す)。`resolve(false)` のあとは既存の枝 (`deletingRef` と `deleting` を戻して終わる。`account.tsx:60-64`) をそのまま通る。
- ボタンを 3 つにするのはアプリの確認だけ (Android の `Alert` のボタンは 3 つまで)。Web の 3 つの入口は文だけで、購読の管理へのリンクは置かない (ブラウザから開く購読の管理は、契約したストアの端末と限らない。アプリの中で開く 2 つ (凍結中・同意の画面) も Web の画面なので同じ)。

### 10.5 FAQ (`/faq`)・紹介ページ (`landing-copy.ts`)

土台は origin/main `4b1e1abe` (#1911 の後。F2・F20)。

- `src/app/faq/page.tsx` の `payment` の項目 (いまは `:78` と `:79` の 2 つ) を、次の 4 つにする。1 項目 1 行の `{ category, q, a }` で、`a` は一重引用符の文字列のまま (`tests/faq-guide-wording-1859.test.ts:136-146` が `a:\s*'([^']*)'` の形で全項目を読み、読めた数と `category:` の数の一致を見る (`:265`) ので、定数の名前を `a:` に書かない)。1・2 の文は `@homegohan/shared` の `FREE_PLAN_FAQ_ANSWER`・`PAID_PLANS_FAQ_ANSWER` (§8.9) の値の逐語の写しで、一致はテスト 37 が見る (価格や回数を変えたら、定数とこの写しを同じ PR で直す)。上の注 (`:76-77`「回数の数字は運営画面で変えられるので書かない」) は「1・2 の答えは @homegohan/shared の FREE_PLAN_FAQ_ANSWER・PAID_PLANS_FAQ_ANSWER の写し (billing/03 §10.5。一致は tests/billing-plan-catalog.test.ts が見る)」に書き換える:
  1. `{ category: 'payment', q: '料金はかかりますか？', a: '無料プランでは、写真での食事の記録、記録をほめるひと言、献立の作成、健康の記録などをお使いいただけます。AIを使う機能（写真の解析や献立の作成など）は、1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。無料プランの上限は1日3回です。有料プランでは、AI を使う回数の上限が上がり、究極モード・料理画像の作成・家族グループが使えます。' },` (いまの「現在、料金はかかりますか？」を置き換える。「現在、」は時を限る言い方なので質問からも外す)
  2. `{ category: 'payment', q: '有料プランはありますか？', a: '個人 Pro (月額 580円 / 年額 5,800円)、家族 Basic (月額 980円 / 年額 9,800円・4 人まで)、家族 Pro (月額 1,480円 / 年額 14,800円・8 人まで)があります。Web でお申し込みの場合、どのプランも 7 日間の無料体験つきです (同じプランにつき 1 回)。App Store・Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。' },`
  3. `{ category: 'payment', q: '返金はできますか？', a: 'Web でお申し込みの場合、原則として返金には対応しておりません。ただし、サービスに重大な問題があった場合は個別に対応いたします。App Store / Google Play でお申し込みの場合の返金は、各ストアの規定によります。' },`
  4. `{ category: 'payment', q: '有料プランを解約するには？', a: 'Web でお申し込みの方は、設定の「プランとお支払い」から解約できます。App Store / Google Play でお申し込みの方は、各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。' },`
  - 「プランとお支払い」は Web の設定の画面の行の名前 (`src/app/(main)/settings/page.tsx:445-463`) で、`tests/faq-guide-wording-1859.test.ts` が FAQ の「」の名前の実在を見る (§16.1)。FAQ は利用規約ではないので cross/20 の R-28 (画面の名前を書かない) の対象外。
- `src/components/marketing/landing-copy.ts` (紹介ページ。設計書 `marketing/01-landing-site.md` の文言の正本。§16.2)。無料と有料の線引き (§0.6) と食い違う文を残さない: 「すべて無料」「いまは無料」(時を限る言い方。§0.4) を書かず、無料の一覧に家族・究極モード・料理画像の作成を入れず、家族の文には家族プランの契約が要ることを書き、有料のカードを足す。変える箇所は下の表で全部 (行は origin/main `4b1e1abe` の `landing-copy.ts`。ほかの文は変えない)。文の中の `${…}` は `import { PAID_PLAN_SUMMARY, PLAN_CATALOG, formatJpy } from '@homegohan/shared';` の定数で組む:

  | 箇所 (origin/main の行) | いま | 設計後 (逐語) |
  |---|---|---|
  | `PlanCardSchema` の `id` (`:272`) | `z.enum(['free'])` | `z.enum(['free', 'paid'])` |
  | `LandingCopySchema` の `pricing.plans` (`:357`) | `z.array(PlanCardSchema).length(1)` | `z.array(PlanCardSchema).length(2)` |
  | `ASSURANCES` (`:451`) | `'いまは無料で使えます'` | `'無料で始められます'` |
  | `features` の家族のカード (`:578`) の `body` | 「家族を招待して献立を一緒に見る。職場では、…」 | 「家族プランで、家族を招待して献立を一緒に見る。職場では、運営が作った組織で、管理者がメンバーを招待できます。」 |
  | 場面の「子育て家庭」(`:714`) の `body` | 「家族を招待して、献立表で…」 | 「家族プランで家族を招待して、献立表で家族の献立を一緒に見られます。アカウントの無い子どもも登録でき、共有する範囲は自分で選べます。」 |
  | 家族の章の `lead` (`:722`) | 「代表者が家族を作り、…」 | 「家族プラン（家族 Basic・家族 Pro）をご契約の代表者が家族を作り、大人を招待し、子どもを登録します。見せる範囲は、ひとりずつ自分で決めます。」 |
  | `trust` の 1 項目 (`:755`) の `title` | `'いまは無料で使えます'` | `'無料プランと有料プラン'` |
  | 同 `body` | 「登録してお使いいただける機能は、いまはすべて無料です。AI を使う機能には、1 日にご利用いただける回数の上限があります。」 | `` `無料プランでは、写真での食事の記録、記録をほめるひと言、献立の作成、健康の記録などをお使いいただけます。AI を使う機能には、1 日にご利用いただける回数の上限があります。${PAID_PLAN_SUMMARY}` `` |
  | `pricing.title` (`:767`) | `'いまは、無料で使えます。'` | `'無料ではじめて、必要になったら有料プランへ。'` |
  | `pricing.lead` (`:768`) | 「登録してお使いいただける機能は、いまはすべて無料です。…組織でのご利用は、運営が組織を作ってからになります（お問い合わせください）。」 | `` `無料プランで、写真での食事の記録・献立の作成・健康の記録などをお使いいただけます。AI を使う機能には、1 日にご利用いただける回数の上限があります。${PAID_PLAN_SUMMARY}組織でのご利用は、運営が組織を作ってからになります（お問い合わせください）。` `` |
  | `pricing.plans` の `free` (`:770-777`) | `title: 'いま使える機能'`・`items` の最後が `'AI に相談', '家族で使う'` | `title: '無料プラン'`・`badge: '無料'` (いまのまま)・`items: ['写真で記録とほめるひと言', '1週間の献立と買い物リスト', '食材の管理', '栄養の見える化', '体重と健康の記録', 'バッジ', 'AI に相談']` (`'家族で使う'` を消す)・`body: null`・`cta: PRIMARY_CTA` (いまのまま) |
  | `pricing.plans` に `paid` を足す (`free` の後。いまは無い) | (無い。#1911 が消した) | `` { id: 'paid', title: '有料プラン', badge: '無料体験つき', items: PLAN_CATALOG.map((plan) => `${plan.display_name}${plan.max_members === null ? '' : `（${plan.max_members} 人まで）`}　月額 ${formatJpy(plan.monthly_price_jpy)} / 年額 ${formatJpy(plan.yearly_price_jpy)}（税込）`), body: null, cta: { label: '料金プランを見る', href: '/pricing' } } `` (`body` は `null`: `PricingSection.tsx` は `body` に予定の印のアイコン `CalendarClock` を付けるため、有料で増えるものは `lead` の `PAID_PLAN_SUMMARY` で書く) |
  | `faq` の「本当に無料で使えますか？」(`:812`) の `a` | 「はい。登録してお使いいただける機能は、写真の記録、ほめるひと言、献立の提案、健康の記録など、いまはすべて無料です。AI を使う機能…」 | `` `はい。無料プランで、写真の記録、ほめるひと言、献立の作成、健康の記録などをお使いいただけます。AI を使う機能（写真の解析や献立の作成など）は、1 日にご利用いただける回数に上限があり、上限に達した日は翌日 0 時からまたお使いいただけます。${PAID_PLAN_SUMMARY}` `` |
  | `faq` の「家族で使えますか？」(`:820`) の `a` | 「はい。家族を招待して、…」 | 「はい。家族プラン（家族 Basic・家族 Pro）をご契約の代表者が家族グループを作り、家族を招待して、献立表で家族の献立を見たり、記録を共有したりできます。見られるのは、相手が共有をオンにしている献立と記録だけです。」 |
  | `claims` の `family` (`:858`) の `condition` | `'共有は本人の設定の範囲で (family-share)'` | `'共有は本人の設定の範囲で (family-share)。家族グループの作成とメンバーの追加は、代表者の家族プランの契約が要る (billing/03 §6.6)'` |
  | `claims` の `free-now` (`:859`) | `text: '登録して使える機能は、いまは無料'`・`evidence: ['src/app/pricing/PricingPageView.tsx']` | `text: '無料プランで使える機能があり、有料プランは 3 つ (個人 Pro / 家族 Basic / 家族 Pro)。家族グループ・究極モード・料理画像の作成は有料プラン'`・`evidence: ['src/app/pricing/PricingPageView.tsx', 'packages/shared/src/billing-plans.ts']`・`condition` は「AI を使う機能には 1 日の利用回数の上限がある。無料と書く段落には上限の文も入れる。無料の機能の一覧に、家族・究極モード・料理画像の作成と組織を入れない (組織は運営が作るもので、登録しただけでは使えない (org-admin))」 |
  | `claims` の `ai-daily-limit` (`:860`) の `condition` | 「回数の数字は書かない (運営画面で変えられる。既定は free の 10 回)。…」 | 「既定は free の 10 回」を「free は 3 回 (billing/03 §6.5)」に (回数は文に書かないまま) |

  - 紹介ページの描き方 `src/components/marketing/sections/PricingSection.tsx` のコードは変えない (`plans` を数えずに描くので 2 枚をそのまま描く)。冒頭の注 (`:1-3`) を「eyebrow・h2・lead・カード 2 枚 (無料プランと有料プラン。ul。見出し・札・項目の ul・CTA)・AI の上限 3 点 (ul)。768 px 以上はカード 2 列・上限 3 列、未満は 1 列。価格の数字はカードの `items` (landing-copy.ts が `PLAN_CATALOG` から組む) だけに出し、このファイルに書かない。無料の一覧に組織・家族・究極モード・料理画像の作成を入れない (文言は landing-copy.ts)。」に書き換える。
  - 見た目 `src/components/marketing/marketing.css` (`:1880-1887` の料金の節): 注 (`:1881`「カードは「いま使える機能」の 1 枚だけ …」) を「カードは無料プランと有料プランの 2 枚 (billing/03 §10.5)」に、`.lp .lp-plans` の `max-width: 28rem;` を `max-width: 56rem;` に戻し、その下に `@media (min-width: 768px) { .lp .lp-plans { grid-template-columns: repeat(2, minmax(0, 1fr)); } }` を足す (#1911 が消した指定と同じ)。`.lp .lp-pill--free` (`:1925-1928`) の下に `.lp .lp-pill--paid { color: var(--lp-accent-ink); background: var(--lp-bg-tint); }` を足す (#1911 が消した指定と同じ)。#1911 が消した `.lp .lp-plan--paid` の点線の枠 (準備中の見た目) は戻さない。
- `src/lib/seo/public-pages.ts` の `SITE_DESCRIPTION` (`:37`) の最後の文「いまは無料で使えます。」を「無料で始められます。」に (時を限る言い方をやめる。50〜160 文字のまま)。
- `src/app/(main)/badges/page.tsx`・組織の画面・運営の画面は #1911 で済んでいる (本冊の面ではない)。

### 10.6 モバイルの購入の画面 `apps/mobile/app/settings/plan.tsx` (R15・R16)

識別子の取り込み元は §8.10 の表 (Web の `src/` を import しない)。画面の状態: `summary: BillingSummaryWire | null`・`loadError: boolean`・`cards: PurchasablePlanCard[]`・`busy: boolean` (購入・復元の最中はボタンを押せない)・`notice: string | null` (完了・失敗の文)。

画面の要素 (上から):

| # | 要素 | 文・振る舞い |
|---|---|---|
| 1 | 見出し | 「プランとお支払い」(`PageHeader`。戻るで設定タブへ) |
| 2 | 現在の状態 | `fetchBillingSummary()` の `summary`: `status === null` かつ `effective_plan_key === 'free'` → 「無料プランをご利用中です」/ `status === null` かつ `effective_plan_key !== 'free'` (家族・組織のプラン) → 「`planDisplayName(summary.effective_plan_key)` をご利用中です (ご家族または組織のプラン)」/ live → 「`planDisplayName(summary.plan_key)` をご利用中です」+ `subscriptionStatusLines(summary)` の各行 (無料期間中（X まで）・解約の予約) + 出どころ: `source === 'stripe'` → 「Web でお申し込みのプランです。解約・お支払い方法の変更は Web の「プランとお支払い」から行えます。」(リンク無し。R16) / `'manual'` → 文なし / `'app_store'`・`'play_store'` → 「`IAP_STORE_LABELS[source]` でお申し込みのプランです。」+ ボタン「定期購読の管理を開く」(押すと `const info = await currentCustomerInfo(); Linking.openURL(info?.managementURL ?? STORE_SUBSCRIPTION_MANAGEMENT_URL[source])`) |
| 3 | プランの一覧 (`summary.can_purchase` かつ `isPurchasesAvailable()` かつ `cards.length > 0` のときだけ) | カード = `display_name`・`PLAN_CATALOG` の同じ `plan_key` の `features` (無ければ箇条書きなし)・`max_members` があれば「X 人まで」・間隔ごとの行 (`options`) = `priceString` + `renewalText(interval, priceString, option.trial)` (自動更新の説明と、体験があるときだけ体験の長さ。P9・P10) + ボタン「`<display_name>` を月額で始める」/「`<display_name>` を年額で始める」。請求額 (`priceString`) をカードで最も大きい文字にする (P9 の「most prominent」)。`option.trial` が null でない行だけ、価格の上に「`option.trial.lengthText`無料」と、その下に「体験の終了後は `priceString` が請求されます」を出す。`option.trial` は `storeTrialOf` (§8.10) がストアの導入価格と体験の対象の判定から作る (DB の `trial_days` は使わない。対象外の利用者に体験の文を出さない。R15・S29) |
| 4 | 購入 | ボタン → `busy = true` → `purchase(pkg)` (`pkg` は `fetchOfferings()` の `current.availablePackages` のうち `identifier === option.packageIdentifier` のもの) → `ok` なら `syncIapPurchases()` → `summary` を置き換え、`notice` =「お申し込みが完了しました」。`cancelled` なら何もしない。`ok: false, cancelled: false` → `notice` = `BILLING_PURCHASE_FAILED_MESSAGE` (ストアの生の文は出さない)。同期が投げた例外 → `notice` = `billingErrorMessageOf(e)` (409 `BILL_IAP_SYNC_CONFLICT` などはサーバの固定の文)。最後に `busy = false` |
| 5 | 購入を復元 | ボタン「購入を復元」(常に出す。P9 3.1.1。`isPurchasesAvailable()` が偽なら押せない形で出す) → `restore()` → `syncIapPurchases()` → `summary` を置き換え。置き換えた `summary.status` が null なら `notice` =「復元できる購入がありませんでした」。例外 → `notice` = `billingErrorMessageOf(e)` |
| 6 | 規約へのリンク | 「利用規約」「プライバシーポリシー」(`getTermsUrl()` / `getPrivacyUrl()`。`Linking.openURL`。設定タブと同じ) と「特定商取引法に基づく表記」(`webPageUrl('/legal')`)。P9 (Terms of Use と Privacy Policy へのリンク) |
| 7 | 読み込み・失敗 | 要約の読み込み中は `LoadingState`。`fetchBillingSummary()` が投げたら `loadError = true` で `BILLING_SUMMARY_LOAD_FAILED_MESSAGE` と「再読み込み」のボタン (2・3 は出さない。5・6 は出す) |

- 画面を開いたとき: `identifyPurchases(user.id)` (`useAuth().user`) → `fetchBillingSummary()` → `Platform.OS` が `ios` なら `'app_store'`、`android` なら `'play_store'` を `store` にし (それ以外は 3 を出さない) → `fetchIapCatalog(store)` → `fetchOfferings()` (`current?.availablePackages ?? []`) → `eligibility = await fetchTrialEligibility(packages.map((pkg) => pkg.product.identifier))` (iOS だけ尋ね、Android と失敗は `{}`) → `cards = matchCatalogWithPackages(store, plans, packages, eligibility)`。カタログか offerings の読み込みが失敗したら `cards = []` (3 を出さない。2 はそのまま)。並行して `syncIapPurchases()` を 1 回 (成功したら `summary` を置き換え。失敗しても画面は読んだ要約で描く)。`AppState` が `active` に戻ったとき `syncIapPurchases()` をもう一度。
- 錠 (究極モード): `apps/mobile/src/components/menu/UltimateModeToggle.tsx` に `locked?: boolean` を足し、`V4GenerateModal` (`apps/mobile/src/components/menu/V4GenerateModal.tsx`) がモーダルを開くたびに `fetchBillingSummary()` を 1 回読み、`summary.features.ai_feature_caps.menu_generation_ultimate === 0` のとき `locked` を渡す (読めなければ錠を出さない。サーバの 403 が最後の砦)。`locked` のトグルを押すと `Alert.alert("プランとお支払い", "究極モードは有料プランでお使いいただけます。設定の「プランとお支払い」からお申し込みいただけます。")` (Web の文と同じ意味)。
- Web の購入のページ (料金・契約の管理) のパスの文字列は書かない (見張り `no-web-purchase-links.test.ts` はそのまま。冒頭のコメントを本冊の規則 (アプリ内課金はアプリの画面で、Web の購入のページへは誘導しない) に書き換える)。
- 遷移先の実在 (`route-targets-exist.test.ts`): `/settings/plan` は `app/settings/plan.tsx` で満たす。

---

## 11. 利用規約・プライバシーポリシー・特定商取引法の有料の条文 (段 E。cross/20 の文面モジュールの上に足す差分)

### 11.0 土台・順番・書き方の規則

- 土台: cross/20 (#1901) の実装 (文面モジュール `src/lib/legal/legal-text.ts`・`terms-text.ts`・`privacy-text.ts`・`index.ts`、描画部品 `src/components/legal/LegalDocumentBody.tsx`、主張の表 `tests/legal-claims-1901.ts`、テスト `tests/legal-text-1901.test.ts`) が main にマージされた後の main。cross/20 の実装は origin/main `2ba5b3b3` (#1918。版 `v2026.1`) でマージ済みで、その後 `465727de` (#1917・family/11 の実装) が版を `v2026.2` に上げた (F14)。段 E は **本冊の段 B のマージ** (委託先の表の根拠のファイル `src/lib/billing/revenuecat-gateway.ts` を T-7 が確かめる) の後に行う (§15.1)。本節以下の行の数・`id`・`chars` は `2ba5b3b3` の文面モジュールと主張の表で数えた。`465727de` で変わったのは、本冊が足す・直す項と行の外にある 4 つの項 (利用規約第11条 4 項・第12条 4 項・第17条 2 項・プライバシーポリシー第13条 9 項) と、その主張の表の 6 行 (`terms-11#7`・`terms-11#8`・`terms-12#5`・`terms-12#6`・`terms-17#5`・`privacy-13#9`) の `chars`・根拠・区分 (`terms-11#8`・`terms-12#6` が `process` → `product`) だけで、行の数 (382)・`id`・各節の項の数 (第17条の `ol` は 4 項のまま) は変わらない。段 E はこの 4 つの項と 6 行を変えない (main の文のまま)。区分の数は §11.4 で `465727de` の値から数え直した。
- 足す場所は cross/20 §17 の「Issue #1912」の行 (F24) のとおり: 利用規約第10条 (`terms-10`) の `ol` の 2 項以降・第16条 2 項・第17条・第21条 (Q-14)・第24条 (Q-15)、プライバシーポリシー第3条・第4条・第7条・第10条・第12条。cross/20 §17 の行と違うのは 1 点だけ: ストアの事業者 (Apple・Google) を第7条の委託先の表に載せない (Q-17。第3条の有料プランの行に書く)。cross/20 §17 の行の直しは §16.2。
- cross/20 の実装の文が cross/20 §6・§7 の文から変わっていたら、main の文面モジュールが正。本冊の「足す項目」はそのまま足し、「直す 2 つの文」(第11条 1 項・第16条 2 項) は、main の文に同じ趣旨 (家族プランの条件・有料プランの解約) を足す形で直し、主張の表の行 (`chars`) を数え直す。
- 書き方の規則は cross/20 §6・§7 の規則のまま: 法令の事項と権利義務の約束だけを書く・画面の名前の引用と道順を書かない (T-40。Web の画面は「本サービスの画面」と書き、「プランとお支払い」を書かない)・未完成と予定の語を書かない (T-6 の 14 語)・`株式会社`・`Inc` を書かない (T-13)・効果を書かない (T-19)・`tests/public-claims-guard.test.ts` の禁止語 (`FORBIDDEN`) を書かない。価格と回数の数字は本文に書かず、料金のページと特定商取引法に基づく表記に掲げると書く (価格の正本は DB。§8.9)。
- 文言の最終の確認 (弁護士) は cross/20 と同じ扱い (発注者の作業。cross/20 §9.4 の 1)。本冊の条文は、その確認に出す草案。

### 11.1 利用規約 (`src/lib/legal/terms-text.ts`)

(a) 第10条 (料金。`id: 'terms-10'`): 最初の `ol` の `items` を次の 11 項にし (1 項は cross/20 のまま)、`ol` の後に `links` を 1 つ足す (`LEGAL_NOTICE_PATH` はこのファイルが cross/20 で import 済み。T-14 の許す行き先):

```ts
// tsc:skip place=src/lib/legal/terms-text.ts の termsText の中 (id: 'terms-10' の section を丸ごと置き換える)
          {
            id: 'terms-10',
            heading: TERMS_ARTICLE_HEADINGS[9],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '本サービスは、無料で利用できます。',
                  '当社は、無料で利用できる範囲のほかに、料金を支払って利用する有料プランを提供します。有料プランの種類、各有料プランで利用できる機能と AI 機能の利用回数の上限、料金（税込）、無料体験の有無と期間は、料金のページと特定商取引法に基づく表記に掲げます。',
                  '有料プランは、Web では当社が利用する決済の事業者（Stripe）を通じたクレジットカードで、iOS・Android のアプリでは App Store または Google Play のアプリ内課金で申し込むことができます。アプリ内課金の料金、請求、領収、返金は、各ストアの表示と規約に従います。',
                  '有料プランは自動更新の定期購入です。ユーザーが解約しない限り、月額または年額の期間ごとに、同じ料金が自動で請求されます。',
                  '無料体験のある有料プランでは、無料体験の期間が終わると有料の期間に移り、請求が始まります。無料体験の期間中に解約すると、料金は請求されません。Web で申し込む無料体験は、同じ有料プランにつき 1 回限りです（App Store と Google Play で受けた同じ有料プランの無料体験も数えます）。App Store と Google Play で申し込む無料体験を受けられるかどうかは、各ストアが判定します。',
                  '有料プランは、いつでも解約できます。Web で申し込んだ有料プランは本サービスの画面から、App Store または Google Play で申し込んだ有料プランは各ストアの定期購読の管理から解約します。解約しても、支払い済みの期間の終わりまで有料プランを利用できます。',
                  '期間の途中の解約による日割りの返金は行いません。法令に定める場合と、本サービスに重大な不具合があった場合を除き、支払い済みの料金は返金しません。',
                  '同時に契約できる有料プランは 1 つです。Web とアプリ内課金、または App Store と Google Play の両方で重ねて申し込んだ場合、後から申し込んだ契約は、そのままでは本サービスに反映されません。その場合はお問い合わせからご連絡ください。当社は、二重のお支払いにならないよう、いずれか一方の契約を解約して返金するか、ストアへの返金の申し込みの方法をご案内します。',
                  'Web または Google Play で申し込んだ有料プランを別の有料プランに変えるときは、いまの有料プランを解約し、その期間の終わりのあとに新しい有料プランを申し込みます。App Store で申し込んだ有料プランは、App Store の定期購読の管理から有料プランと期間を変えることができ、変更の時期と精算は App Store の規約に従います。',
                  '家族プラン（家族 Basic・家族 Pro）を契約した代表者は、プランの人数の上限まで、家族グループにメンバーを迎えることができます。家族プランの契約が終わると、家族グループのメンバーはそのまま残りますが、新しいメンバーを迎えることはできません。',
                  '当社は、有料プランの料金を改定することがあります。改定した料金は、改定の後に申し込む契約から適用します。契約中のユーザーの料金を改定するときは、法令と各ストアの規約に従い、事前にお知らせします。',
                ],
              },
              { kind: 'links', items: [{ label: '特定商取引法に基づく表記', href: LEGAL_NOTICE_PATH }] },
            ],
          },
```

(b) 第11条 (家族グループ。`id: 'terms-11'`) の 1 項の 1 文目を、家族プランの条件を足した文にする (家族の門。§6.6。cross/20 の文のままだと「18 歳以上なら作れる」と読め、製品と食い違う):

```ts
// tsc:skip place=src/lib/legal/terms-text.ts の terms-11 の最初の ol の 1 項 (2 文目「家族グループを作成したユーザーが代表者になります。」は変えない)
                  `${f.adultAgeYears} 歳以上のユーザーは、家族プランを契約して家族グループを作成し、または家族プランを契約した代表者の家族グループに招待を受けて参加できます。家族グループを作成したユーザーが代表者になります。`,
```

(c) 第16条 (利用の制限とアカウントの凍結。`id: 'terms-16'`) の 2 項を次にする (凍結中も解約できる。Web は `/frozen/billing`・`FROZEN_ALLOWED_API_PATHS`、ストアは各ストア。F17・S22):

```ts
// tsc:skip place=src/lib/legal/terms-text.ts の terms-16 の ol の 2 項
                  '凍結中は、本サービスの機能を利用できません。ただし、凍結中でも、データの書き出し、退会、有料プランの解約、お問い合わせの送信は行うことができます。',
```

(d) 第17条 (退会。`id: 'terms-17'`) の `ol` の最後に 1 項を足す (ストアの契約は退会で解約されない。Web の契約は退会の段階 `billing` で即時に解約される。§7.1 の退会の行・`src/lib/billing/account-deletion.ts`):

```ts
// tsc:skip place=src/lib/legal/terms-text.ts の terms-17 の ol の items の最後 (4 項の後)
                  'App Store または Google Play で申し込んだ有料プランは、退会しても解約されません。退会の前に、各ストアの定期購読の管理から解約してください。Web で申し込んだ有料プランは、退会の手続のときに解約されます。',
```

(e) 第21条 (損害賠償と責任の制限): 変えない (Q-14 の推奨。料金に結ぶ上限は置かない)。

(f) 第24条 (本規約の変更と再同意。`id: 'terms-24'`) の `ol` の最後に 1 項を足す (同意の前の解約の手段。Q-15。links の「お問い合わせフォーム」は cross/20 のまま):

```ts
// tsc:skip place=src/lib/legal/terms-text.ts の terms-24 の ol の items の最後 (4 項の後)
                  '改定の後、改めて同意するまでの間も、有料プランは解約できます。App Store または Google Play で申し込んだ有料プランは、各ストアの定期購読の管理から解約できます。Web で申し込んだ有料プランは、お問い合わせからのご依頼を受けて、当社が解約の手続を行います。',
```

- 条の数・見出し (`TERMS_ARTICLE_HEADINGS`・`TERMS_ARTICLE_COUNT = 28`) は変えない (第10条の項を足すだけ。cross/20 §6 の「第10条 (料金) の 1 項だけの `ol` は、#1912 が有料プランの条文を 2 項以降に足すための置き場所」の段落 (origin/main `465727de` の 955 行目。`2ba5b3b3` では 954 行目。#1917 が cross/20 を v1.16 にして 1 行ずれた) のとおり)。
- ファイル先頭の注の「有料の条文を書かない (cross/20 §6 の規則)」を「有料の条文は billing/03 §11 が第10条・第16条・第17条・第24条に足した項だけ」に書き換える。

### 11.2 プライバシーポリシー (`src/lib/legal/privacy-text.ts`)

(a) 第3条 (取得する情報。`id: 'privacy-3'`) の最初の `table` の `rows` の、`アカウント` の行の次に 1 行を足す (ストアの事業者の決済と、RevenueCat を通じた受け取りもここに書く。Q-17):

```ts
// tsc:skip place=src/lib/legal/privacy-text.ts の privacy-3 の最初の table の rows (['アカウント', …] の行の次)
                  ['有料プラン', '申し込んだ有料プランとその契約の状態・期間・無料体験の利用の有無、申し込んだ場所（Web・App Store・Google Play）、決済の事業者（Stripe）と RevenueCat が付ける顧客と契約の識別子、クーポンの利用の記録。App Store または Google Play で申し込んだ場合は、Apple または Google が各ストアの規約に従って決済を行い、当社は RevenueCat を通じて購入の情報（商品、購入と期限の日時、契約の状態）を受け取ります。クレジットカードの番号は、当社は受け取りません'],
```

(b) 第4条 (利用目的。`id: 'privacy-4'`) の `ul` の 1 項 (「本サービスの提供（…）のため。」) の次に 1 項を足す:

```ts
// tsc:skip place=src/lib/legal/privacy-text.ts の privacy-4 の ul の 1 項の次
                  '有料プランの提供（申込みの受付、契約と料金の請求の管理、解約と返金の対応、二重のお支払いの防止）のため。',
```

(c) 第7条 (委託先。`PRIVACY_PROCESSORS`) の最後 (`GitHub` の行の後) に 2 行を足す。ファイルの `PRIVACY_PROCESSORS` の注の「有料プランの決済の事業者は、有料プランの販売の案件 (#1912) が版を上げるときに足す (cross/20 §17)」を「有料プランの決済の事業者 (Stripe) とアプリ内課金の購入の確認 (RevenueCat) は billing/03 §11.2 が足した。ストアの事業者 (Apple・Google) は委託先ではないので載せない (第3条に書く。billing/03 Q-17)」に書き換える:

```ts
// tsc:skip place=src/lib/legal/privacy-text.ts の PRIVACY_PROCESSORS の配列の最後 (GitHub の行の後)
  {
    name: 'Stripe',
    country: 'アメリカ合衆国',
    purpose: 'Web での有料プランの決済',
    data: '利用者の ID、メールアドレス、契約と請求の情報（クレジットカードの番号は Stripe の決済画面で Stripe が直接受け取り、当社は受け取りません）',
    evidence: { file: 'src/lib/billing/stripe-gateway.ts', needle: 'createStripeGateway' },
  },
  {
    name: 'RevenueCat',
    country: 'アメリカ合衆国',
    purpose: 'アプリ内課金の購入の確認と、契約の状態の同期',
    data: '利用者の ID、購入した商品、購入と期限の日時、契約の状態、ストアの取引の識別子',
    evidence: { file: 'src/lib/billing/revenuecat-gateway.ts', needle: 'createRevenueCatGateway' },
  },
```

- `needle` はどちらも根拠のファイルの中の識別子 (6 文字以上・ホスト名でも URL でもない。T-7)。
- 第7条の表の前の文 (「いずれも日本国外に本拠を置く事業者です。」) と、第11条の「外的環境の把握」の所在国 (アメリカ合衆国、エストニア) は変えない (足す 2 社もアメリカ合衆国)。

(d) 第10条 (外部送信。`id: 'privacy-10'`) の `table` の `rows` の最後 (`Expo` の行の後) に 2 行を足す:

```ts
// tsc:skip place=src/lib/legal/privacy-text.ts の privacy-10 の table の rows の最後
                  ['Stripe（Web のお支払いの画面）', 'お支払いの画面で入力するカードの情報、メールアドレス、IP アドレス、ブラウザの種類', 'Web での有料プランのお支払い'],
                  ['RevenueCat（iOS・Android のアプリから）', '当社の利用者 ID、SDK が作る識別子、アプリの版、OS の種類、購入の情報', 'アプリ内課金の購入の確認と、契約の状態の同期'],
```

(e) 第12条 (保存期間。`id: 'privacy-12'`) の `table` の `rows` の最後 (`AI 事業者に送った内容` の行の後) に 4 行を足す:

```ts
// tsc:skip place=src/lib/legal/privacy-text.ts の privacy-12 の table の rows の最後
                  ['有料プランの契約の記録（プラン、契約の状態、期間、申し込んだ場所）', '退会するまで。退会すると直ちに削除します'],
                  ['決済の事業者の顧客の記録と、クーポンの利用の記録', '期限を定めずに保存します。退会すると、ユーザーとの紐づけを外して残します（決済の事業者の顧客の情報は匿名にします）'],
                  ['決済の事業者と RevenueCat から届いた通知の記録（通知の種類・日時、契約の識別子、アカウントの識別子）', '期限を定めずに保存します。退会した後も、アカウントの識別子（氏名やメールアドレスは含みません）とともに残ります'],
                  ['決済の事業者とストアが保存する記録', '各事業者の規約によります'],
```

- 保存期間の根拠: 契約の行は `personal_subscriptions_user_id_fkey` の `ON DELETE CASCADE` (`supabase/baseline/prod_schema.sql:9207`) で退会と一緒に消える。決済の事業者の顧客の行 (`billing_customers.user_id` の `ON DELETE SET NULL`。`supabase/migrations/20261016210000_billing_core.sql:72`) は紐づけを外して残り、Stripe の顧客は退会の段階 `billing` で匿名にする (`src/lib/billing/account-deletion.ts:79-83`)。クーポンの利用の記録は退会で匿名にする (`20261010000100_auth_users_fk_on_delete.sql` の B)。通知の記録 (`stripe_webhook_events`・`revenuecat_webhook_events`) は利用者の列を持たず、`payload` の最小化した写しに利用者の ID が残る (§6.3・billing/01 §6.3)。

### 11.3 特定商取引法に基づく表記

§10.2 の表のとおり (文面モジュールではなく `src/app/legal/page.tsx` の行の追加)。

### 11.4 主張の表 (`tests/legal-claims-1901.ts`) の差分

cross/20 §10 の規則のまま (1 文と表の 1 行が 1 行・`fragment` は同じ節のほかの単位に無い部分・`chars` は §10.1 のテストの文脈で描いた単位の文字数)。足す単位は 42 (利用規約 32・プライバシーポリシー 10)。直す行は 3 (文が変わる単位が 2・根拠だけを直す行が 1)。`id` の番号は、その節の既存の最大の番号の次から足した順に振る (T-35 は `id` の一意と形 `<section>#<数>` を見る。表の行の順と番号の順はそろえなくてよい)。

- 直す 3 行 (`fragment` はそのまま): `terms-11#1` の `chars` を 46 → **70**・`evidence` を `'F-38・docs/design/billing/03-paid-plans-and-iap.md (§6.6)'` に。`terms-16#3` の `chars` を 41 → **50** に (`evidence` の `F-12・F-20` は解約を含むので変えない)。`terms-10#1` の `evidence` を `'F-57'` から `'docs/design/billing/03-paid-plans-and-iap.md (§0.6 の無料プラン)'` に (無料プランが残ることの根拠。`chars` は 16 のまま)。
- 足す 42 行 (`LEGAL_CLAIMS` の配列の、各節の既存の行の後に置く):

```ts
// tsc:skip place=tests/legal-claims-1901.ts の LEGAL_CLAIMS の配列 (各節の既存の行の後)
  { id: 'terms-10#2', section: 'terms-10', fragment: '当社は、無料で利用できる範囲', chars: 41, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/app/pricing/PricingPageView.tsx' },
  { id: 'terms-10#3', section: 'terms-10', fragment: '有料プランの種類、各有料プラ', chars: 82, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/app/legal/page.tsx' },
  { id: 'terms-10#4', section: 'terms-10', fragment: '有料プランは、Web では当', chars: 112, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/stripe-gateway.ts' },
  { id: 'terms-10#5', section: 'terms-10', fragment: 'アプリ内課金の料金、請求、領', chars: 35, basis: 'contract', evidence: '契約の定め (アプリ内課金はストアの規約に従う。billing/03 §11.1)' },
  { id: 'terms-10#6', section: 'terms-10', fragment: '有料プランは自動更新の定期購', chars: 17, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/core.ts' },
  { id: 'terms-10#7', section: 'terms-10', fragment: 'ユーザーが解約しない限り、月', chars: 41, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/core.ts' },
  { id: 'terms-10#8', section: 'terms-10', fragment: '無料体験のある有料プランでは', chars: 44, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/core.ts' },
  { id: 'terms-10#9', section: 'terms-10', fragment: '無料体験の期間中に解約すると', chars: 25, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/core.ts' },
  { id: 'terms-10#10', section: 'terms-10', fragment: 'Web で申し込む無料体験は', chars: 80, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/repository.ts' },
  { id: 'terms-10#11', section: 'terms-10', fragment: 'App Store と Google Play で申', chars: 55, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§8.10 storeTrialOf)' },
  { id: 'terms-10#12', section: 'terms-10', fragment: '有料プランは、いつでも解約で', chars: 17, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/app/(main)/account/billing/page.tsx' },
  { id: 'terms-10#13', section: 'terms-10', fragment: 'Web で申し込んだ有料プラ', chars: 84, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/app/(main)/account/billing/page.tsx' },
  { id: 'terms-10#14', section: 'terms-10', fragment: '解約しても、支払い済みの期間', chars: 32, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md・src/lib/billing/core.ts' },
  { id: 'terms-10#15', section: 'terms-10', fragment: '期間の途中の解約による日割り', chars: 23, basis: 'contract', evidence: '契約の定め (返金。特定商取引法に基づく表記の返品・キャンセルと同じ。billing/03 §10.2)' },
  { id: 'terms-10#16', section: 'terms-10', fragment: '法令に定める場合と、本サービ', chars: 47, basis: 'contract', evidence: '契約の定め (返金。特定商取引法に基づく表記の返品・キャンセルと同じ。billing/03 §10.2)' },
  { id: 'terms-10#17', section: 'terms-10', fragment: '同時に契約できる有料プランは', chars: 20, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§6.4 の 5.)' },
  { id: 'terms-10#18', section: 'terms-10', fragment: 'Web とアプリ内課金、また', chars: 86, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§6.4 の 5.・§13.3)' },
  { id: 'terms-10#19', section: 'terms-10', fragment: 'その場合はお問い合わせからご', chars: 20, basis: 'process', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§13.3)' },
  { id: 'terms-10#20', section: 'terms-10', fragment: '当社は、二重のお支払いになら', chars: 61, basis: 'process', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§13.3)' },
  { id: 'terms-10#21', section: 'terms-10', fragment: 'Web または Google', chars: 87, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§10.6)' },
  { id: 'terms-10#22', section: 'terms-10', fragment: 'App Store で申し込', chars: 89, basis: 'contract', evidence: '契約の定め (App Store の定期購読の管理。ストアの規約に従う。billing/03 §7.3)' },
  { id: 'terms-10#23', section: 'terms-10', fragment: '家族プラン（家族 Basic', chars: 66, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§6.6)' },
  { id: 'terms-10#24', section: 'terms-10', fragment: '家族プランの契約が終わると、', chars: 55, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§6.6)' },
  { id: 'terms-10#25', section: 'terms-10', fragment: '当社は、有料プランの料金を改', chars: 24, basis: 'contract', evidence: '契約の定め (料金の改定。billing/03 §11.1)' },
  { id: 'terms-10#26', section: 'terms-10', fragment: '改定した料金は、改定の後に申', chars: 26, basis: 'process', evidence: 'docs/design/operator/04-plan-management.md' },
  { id: 'terms-10#27', section: 'terms-10', fragment: '契約中のユーザーの料金を改定', chars: 44, basis: 'law', evidence: '特定商取引法・消費者契約法とストアの規約の定め (billing/03 §11.1)' },
  { id: 'terms-17#9', section: 'terms-17', fragment: 'App Store または ', chars: 51, basis: 'product', evidence: 'src/lib/billing/account-deletion.ts・docs/design/billing/03-paid-plans-and-iap.md (§7.1 の退会の行)' },
  { id: 'terms-17#10', section: 'terms-17', fragment: '退会の前に、各ストアの定期購', chars: 28, basis: 'contract', evidence: '契約の定め (ストアでの解約のお願い)' },
  { id: 'terms-17#11', section: 'terms-17', fragment: 'Web で申し込んだ有料プラ', chars: 32, basis: 'product', evidence: 'src/lib/billing/account-deletion.ts・F-11' },
  { id: 'terms-24#10', section: 'terms-24', fragment: '改定の後、改めて同意するまで', chars: 30, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.5 Q-15)・packages/shared/src/legal-consent-api.ts' },
  { id: 'terms-24#11', section: 'terms-24', fragment: 'App Store または ', chars: 59, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.5 Q-15)' },
  { id: 'terms-24#12', section: 'terms-24', fragment: 'Web で申し込んだ有料プラ', chars: 47, basis: 'process', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.5 Q-15)・F-28' },
  { id: 'privacy-3#21', section: 'privacy-3', fragment: '有料プラン | 申し込んだ有', chars: 273, basis: 'product', evidence: 'supabase/migrations/20261016210000_billing_core.sql・docs/design/billing/03-paid-plans-and-iap.md (§6.3・§6.4)' },
  { id: 'privacy-4#19', section: 'privacy-4', fragment: '有料プランの提供（申込みの受', chars: 51, basis: 'product', evidence: 'src/lib/billing/service.ts・docs/design/billing/03-paid-plans-and-iap.md' },
  { id: 'privacy-7#15', section: 'privacy-7', fragment: 'Stripe | アメリカ合', chars: 114, basis: 'product', evidence: 'src/lib/billing/stripe-gateway.ts' },
  { id: 'privacy-7#16', section: 'privacy-7', fragment: 'RevenueCat | ア', chars: 88, basis: 'product', evidence: 'src/lib/billing/revenuecat-gateway.ts・docs/design/billing/03-paid-plans-and-iap.md (§8.3)' },
  { id: 'privacy-10#13', section: 'privacy-10', fragment: 'Stripe（Web のお支', chars: 84, basis: 'product', evidence: 'src/lib/billing/stripe-gateway.ts' },
  { id: 'privacy-10#14', section: 'privacy-10', fragment: 'RevenueCat（iOS', chars: 97, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§8.10)' },
  { id: 'privacy-12#20', section: 'privacy-12', fragment: '有料プランの契約の記録（プラ', chars: 56, basis: 'product', evidence: 'supabase/baseline/prod_schema.sql (personal_subscriptions_user_id_fkey の ON DELETE CASCADE)' },
  { id: 'privacy-12#21', section: 'privacy-12', fragment: '決済の事業者の顧客の記録と、', chars: 84, basis: 'product', evidence: 'src/lib/billing/account-deletion.ts・supabase/migrations/20261010000100_auth_users_fk_on_delete.sql' },
  { id: 'privacy-12#22', section: 'privacy-12', fragment: '決済の事業者と Revenu', chars: 114, basis: 'product', evidence: 'supabase/migrations/20261016210000_billing_core.sql・docs/design/billing/03-paid-plans-and-iap.md (§6.3)' },
  { id: 'privacy-12#23', section: 'privacy-12', fragment: '決済の事業者とストアが保存す', chars: 32, basis: 'contract', evidence: '各事業者の規約の参照' },
```

- `LEGAL_CLAIM_COUNT` を 382 → **424** に (`tests/legal-claims-1901.ts:25`。cross/20 v1.16 の実装 (origin/main `465727de`) の値に 42 を足す)。区分の数 (cross/20 v1.16 §10.2 の表。`465727de` の実装の 382 行は 利用規約 product 72・contract 90・law 2・process 3・計 167 / プライバシーポリシー product 150・contract 21・law 31・process 13・計 215。足す 42 行は 利用規約 product 21・contract 6・law 1・process 4 / プライバシーポリシー product 9・contract 1。直す 3 行は区分を変えない): 利用規約 product 93・contract 96・law 3・process 7・計 199 / プライバシーポリシー product 159・contract 22・law 31・process 13・計 225 / 計 424。
- `chars` は本冊の文から数えた値。実装で文を cross/20 の実装の文に合わせて直したときは、T-35 の失敗の文 (対応しない単位の文) を見て数え直す。

### 11.5 テストの改め (`tests/legal-text-1901.test.ts`。cross/20 §13 の it を改める)

- **T-33 を書き換える**: it 名 `利用規約・プライバシーポリシーの有料プランの条文は billing/03 §11 のとおりで、有料の語は有料の条文の節にだけ出て、委託先の表に決済の事業者と RevenueCat がある`。中身: (1) `termsText(ctx)` の `terms-10` の最初の `ol` の `items` が、テストのローカル定数 `PAID_TERMS_10_ITEMS` (§11.1 (a) の 11 項を逐語で持つ。根拠コメント: billing/03 §11.1) と等しい。(2) `legalTextUnits` の単位のうち `LEGAL_TEXT_PAID_TERMS` (11 語。cross/20 §13.1 のまま) のどれかを含む単位の `section` が、テストのローカル定数 `PAID_TERMS_SECTIONS = ['terms-10', 'terms-16', 'terms-17', 'terms-24', 'privacy-3', 'privacy-4', 'privacy-7', 'privacy-10', 'privacy-12']` のどれか (有料の語をほかの条に足したら赤になる)。(3) `PRIVACY_PROCESSORS` の `name` に `Stripe` と `RevenueCat` があり、`Apple` が無い (Q-17)。(4) `TERMS_ARTICLE_HEADINGS[9]` が `'第10条（料金）'`。
- **T-34 を改める**: `PRIVACY_DATA_TABLES` の `personal_subscriptions` の値を `'アカウント'` から `'有料プラン'` に、`billing_customers: '有料プラン'`・`coupon_redemptions: '有料プラン'` を足す (`PRIVACY_DATA_EXCLUDED` から 2 表を外す)。`PRIVACY_DATA_EXCLUDED` の理由の型から `'paid_plan'` を外し、`PAID_PLAN_WRITER_MIGRATIONS`・`PAID_PLAN_WRITER_DIR` と (5) の検査を消す (理由が `paid_plan` の表が無くなるため)。数: `PRIVACY_DATA_TABLES` 72 → 74 表、`PRIVACY_DATA_EXCLUDED` 18 → 16 表 (和は 90 のまま。本冊の新しい表 `plan_store_products`・`revenuecat_webhook_events`・`ai_plan_feature_caps` は利用者の列を持たず、`tests/account-export-tables.test.ts` の分類の対象に入らないので、和に足さない)。
- T-24 (第7条の行の数 = `PRIVACY_PROCESSORS.length`)・T-7 (根拠の実在)・T-35 (主張の表) はコードを変えずに、上の差分で緑になる。T-28 の `本サービスは、無料で利用できます` は第10条 1 項のまま残るので緑。
- T-6 (未完成・予定の語)・T-13・T-19・T-40 は、§11.1・§11.2 の文が規則を守るので変えない (本冊の設計の検証で、足す文と直す文に T-6 の 14 語・T-40 の 3 つの形と 4 つの画面の名前・`株式会社`・`Inc` の形・T-19 の 6 語・`FORBIDDEN` の価格の語が無いことを確かめた)。

### 11.6 版の繰り上げと公開の手順

- `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` の 2 文書の `version` を、いまの `v2026.2` (#1917 が上げた版。F14) → **`v2026.3`** に上げる (両文書の内容が変わる。cross/20 §9.3 の「有料プランの条文を足す (#1912)」の行)。`effectiveDate` は cross/20 §9.1・§9.4 の 3 と同じ扱い: 実装では仮の施行日 (実在する日付の YYYY-MM-DD。cross/20 §9.1) を置き行末に目印 `// 仮置き: マージ直前に公開日へ置き換える` を付け、オーケストレーターがマージの直前に公開日に置き換えて目印を消す。ファイル先頭の注の版の説明に「v2026.3 は billing/03 (#1912) で有料プランの条文を足した版。改定前の版 (v2026.2) の文面は docs/legal/archive/v2026.2/ に控えてある」を、`LEGAL_DOCUMENTS` の JSDoc に billing/03 (#1912) で有料プランの条文を足すので両文書を v2026.3 に上げる段落を足す (事実の更新。#1917 の段落と同じ形)。
- 旧版の控え: `docs/legal/archive/v2026.2/terms.md`・`privacy.md` を新設する。形は #1917 が作った `docs/legal/archive/v2026.1/terms.md`・`privacy.md` と同じ: 見出し (`# 利用規約 (旧版の控え)` / `# プライバシーポリシー (旧版の控え)`) の下に版 `v2026.2`・施行日 `2026-10-21`・控えの元 (段 E で書き換える直前の `termsText` / `privacyText`) の 3 項目を書き、その直後 (本文の前) に「この版は billing/03 (#1912) の版 v2026.3 に置き換わった。改定前の版はここに保管し、お問い合わせによりご提供する (利用規約第24条 4 項)」(プライバシーポリシーの控えは末尾の括弧を「(プライバシーポリシー第18条 3 項)」) の文を置き、`---` の行の後に改定の前の版の本文を続ける (`docs/legal/archive/v2026.1/terms.md:1-9` と同じ並び。cross/20 P-7)。`docs/legal/archive/v2026.1/`・`docs/legal/archive/v2025.1/` は変えない。
- 公開の手順は cross/20 §9.4 の 2〜6 のとおり (2 を行うかは、次のとおり公開の前に確かめる)。cross/20 §9.3 の「版を上げる改定すべて」の行は、版を上げる改定すべてで §9.4 の 2 (施行日の前に運営のお知らせに改定の予告を載せる) を必ず行うと定め、除外は v2026.1 と v2026.2 の公開だけ。公開済みの利用規約第24条 1 項 (`src/lib/legal/terms-text.ts` の `terms-24` の 1 項) とプライバシーポリシー第18条 1 項 (`src/lib/legal/privacy-text.ts` の `privacy-18` の 1 項) は、変更の概要と施行日を施行日の前にお知らせに掲載すると利用者に約束している (cross/20 §9.4 の 2: 省くと公開した約束を破る)。v2026.3 の公開で 2 を行うかは、段 E の公開の前にオーナーに確かめる。確かめるときは、この原則 (必ず行う) と公開済みの約束を添える。予告を省くなら、その除外を cross/20 §9.3 の同じ行に書き足す (§16.2)。予告を載せるときの概要は「有料プランの料金・お支払い・自動更新・解約・返金・無料体験・家族プラン、決済の事業者と RevenueCat への提供と外部送信、保存期間」。版を上げると既存の再同意の仕組みが全員に再同意を求める (S21)。
- `tests/legal-consent-*`・`src/__tests__/api/cron/push-outbox.test.ts` などの版の直書きは、cross/20 の実装で `LEGAL_DOCUMENTS` の値を読む形になっている (cross/20 §16)。残っていれば `git grep -n "v2026.2" -- tests src packages apps lib` で探して `LEGAL_DOCUMENTS` の値に替える (2026-10-21 の origin/main `83d90a88` で当たるのは `legal-versions.ts` の定義と注と、保護者の同意書の版 (`PARENTAL_CONSENT_DOCUMENT.version` も `v2026.2`。`packages/shared/src/parental-consent.ts:36,38,43,174`・`packages/shared/src/parental-consent.test.ts:230-231`) だけで、同意書の版は `LEGAL_DOCUMENTS` と別の値なので替えない。§16.1 の行)。

---

## 12. 発注者の作業と申請の順 (追記 1。どの段が終わったら何を出せるか)

| 順 | 前提 (すべて終わってから) | 当社の作業 (段) | 終わると出せる申請 (発注者) | 申請のあとに当社がすること |
|---|---|---|---|---|
| 1 | — | 段 A (DB: 価格・線引き・ストアの表)・段 B (サーバ。段 C の前提)・段 C (公開の面: 料金・特商法の販売の項目・FAQ・紹介ページ) のマージと本番の反映 (運営会社と特商法の会社情報は #1911 で公開済み) | なし (Stripe の申請には順 2 の規約とポリシーの有料の条文の公開も要る) | — |
| 2 | cross/20 (#1901。規約とポリシーの作り込み) の実装のマージと、本冊の段 B のマージ (§11.0) | 段 E (規約とポリシーの有料の条文・版 `v2026.3`。§11) | 弁護士の確認 (cross/20 と同じ) | 確認のあと、改定の予告 (cross/20 §9.4 の 2) を行うかを公開の前にオーナーに確かめ (§11.6。cross/20 §9.3 の原則は「必ず行う」で、利用規約第24条 1 項とプライバシーポリシー第18条 1 項が施行日の前の掲載を約束していることを添える)、行うなら施行日の前に運営のお知らせに予告を載せ、版を上げてデプロイ (再同意が走る) = 規約とポリシーの有料の条文の公開 (cross/20 §9.4) |
| 3 | 順 1 と順 2 の本番の反映 (サイトに価格・有料の中身・特商法・規約とポリシーの有料の条文・解約と返金の条件・連絡先がそろっている状態。追記 1・P11) | — | **Stripe の本番の有効化** (事業の情報・銀行口座・サイトの URL。P11) | 承認後: Vercel に `STRIPE_SECRET_KEY` (`sk_live_`) と `STRIPE_WEBHOOK_SECRET` (#1113)。Stripe の Dashboard の設定 (billing/01 §17.1)。Product と Price を作り `PATCH /api/super-admin/plans/[id]` + `price-change` で `stripe_price_id` / `stripe_yearly_price_id` を入れる = **Web の販売開始** (`/pricing` に CTA が出る) |
| 4 | — (順 1〜3 と並行してよい。ストアの契約・商品の作成は審査の提出ではない) | 段 B (サーバ: Webhook・同期・カタログ) と段 D (モバイル: 購入の画面) のマージ + EAS の開発ビルド (sandbox で購入の流れを確かめられる状態) | **App Store**: Paid Applications Agreement の署名・税と銀行の登録 → In-App Purchase Key (`.p8`) と Issuer ID の発行 (P7) → Subscription Group と 6 つの商品 (個人 Pro 月 / 年・家族 Basic 月 / 年・家族 Pro 月 / 年。商品 ID とグループの中のレベル (家族 Pro が上位) は §17.2 の表) の作成・価格 (Q-1)・ローカライズ・無料体験 (7 日。Introductory Offer)・審査用のスクリーンショット → ストアのメタデータ (§17.5: Privacy Policy URL・説明文の利用規約とプライバシーポリシーの URL・App のプライバシーの購入履歴。P16) **/ Google Play**: Google Payments の merchant profile → `eas build --profile production --platform android` で AAB を作り (`apps/mobile/eas.json` の `production` は `android.buildType: "app-bundle"`。`preview` は `"apk"` なので使わない)、`eas submit --profile production --platform android` で内部テストのトラックに下書きで上げる (同じファイルの `submit.production.android` は `track: "internal"`・`releaseStatus: "draft"`。`eas.json` は変えない。Billing Library 入り。P8) → 3 つの購読と base plan 6 つ (`monthly-autorenewing` / `annual-autorenewing`) + 無料体験の offer → アプリのコンテンツ (§17.5: プライバシー ポリシーの URL・データ セーフティの購入履歴。P16) → Google Cloud のサービスアカウントと権限 (P8。36 時間) **/ RevenueCat**: プロジェクト・iOS と Android のアプリ (bundle id `com.homegohan.app`)・`.p8` と Issuer ID・サービスアカウントの JSON・商品 6 つ (Google は `<subscription_id>:<base_plan_id>`)・Entitlement 3 つ (`pro` / `family_basic` / `family_pro`。それぞれに月額と年額の商品)・Offering `default` に 6 つの package・Webhook (URL `https://<サイト>/api/webhooks/revenuecat`・署名 ON・秘密を控える)・App Store Server Notifications と Google RTDN の接続 (推奨)・Restore behavior は既定のまま | 承認後: Vercel に `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET`、EAS に `EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY` を登録 → `plan_store_products` に 6 行 (運営が SQL で INSERT。§17.2) → 本番のビルド (`eas build --profile production`) |
| 5 | 順 2 と順 4 (アプリの購入の画面の「利用規約」「プライバシーポリシー」のリンク先 (§10.6 の 6) に有料の条文が載っている状態と、順 4 のストアのメタデータ (§17.5。P16・R25) が入っている状態) | 本番のビルドの提出 | **App Store の審査** (最初の購読は購入の流れが入ったアプリの版と一緒に提出。審査用のメモに「購入の画面は 設定 → プランとお支払い」「購入の復元のボタン」「テスト用のサンドボックスのアカウント」を書く) **/ Google Play の審査** (製品版のトラックへ昇格) | 公開後: 整合ゲートで §17.4 の受け入れを確かめる = **アプリの販売開始** |

- 順 1 と順 4 は並行してよい。順 2 は cross/20 の実装と本冊の段 B のマージのあと。順 3 (Stripe の有効化) は順 1 と順 2 の本番の反映のあと。順 5 (ストアの審査) は順 2 と順 4 のあと。
- 発注者の作業の一覧 (Issue #1912 の「オーナー作業」+ 本冊で増えたもの): Stripe の鍵と商品 (#1113)・App Store Connect (契約・税・銀行・商品・メタデータ (Privacy Policy URL・説明文の利用規約とプライバシーポリシーの URL・App のプライバシーの購入履歴。§17.5)・審査)・Google Play Console (merchant・AAB・購読・サービスアカウント・プライバシー ポリシーの URL とデータ セーフティの購入履歴 (§17.5))・RevenueCat (アカウント・接続・商品・entitlement・offering・Webhook・鍵)・特商法の会社情報 (追記 2 で確定済み)・規約の弁護士の確認・確認事項 (§0.5) のうち発注者が確かめるか作業するもの: Q-1 (App Store Connect でストアの価格帯を確かめる)・Q-7 (本番の試験の行 2 件を SQL で消す)・Q-12 (EAS のビルドの設定で動作環境を確かめる)。ほかの Q (Q-5・Q-6・Q-10・Q-11・Q-13〜Q-15・Q-17・Q-18) は推奨のまま実装し、異論があれば選び直す。Q-2・Q-3・Q-4・Q-16 は 2026-10-19 の選択で確定 (§0.4 の追記 3)。Q-8・Q-9 は #1911 で確認済み。

---

## 13. エラー表

### 13.1 API (利用者向け。本文は固定の文。本冊が足す文 ([NEW]) は未完成や予定を示す語 (準備中・販売開始前・近日・予定・まだ・確定次第・これから) を使わない。既存のコードの文は main のまま)

| コード | HTTP | 出どころ | 文 |
|---|---|---|---|
| `BILL_IAP_INVALID_INPUT` [NEW] | 400 | catalog のクエリ (`store` が無い・`app_store` / `play_store` 以外。S31) | 入力値が不正です |
| `AUTH_UNAUTHENTICATED` | 401 | `requireUser` | 認証が必要です |
| `AUTH_ACCOUNT_FROZEN` | 403 | middleware・`requireUser` (catalog・sync は凍結中は通さない。`FROZEN_ALLOWED_API_PATHS` に入れない。S22) | middleware はアカウントが凍結されています (既存。#1030)。middleware の読み取りが失敗して素通りしたときの route の `requireUser` → `billingErrorResponse` は権限がありません (既存の枝) |
| `LEGAL_CONSENT_REQUIRED` | 403 | middleware の同意ゲート (catalog・sync は許可リストに入れない。S21) | 既存の文 |
| `AI_FEATURE_NOT_IN_PLAN` [NEW] | 403 | `consume_ai_usage_at` (`plan_locked`) → `aiDailyLimitPayload` | `{機能}は、有料プランでお使いいただけます。` (`aiFeatureNotInPlanMessage`。`feature` も返す) |
| `FAMILY_PLAN_REQUIRED` [NEW] | 402 | `create_family_group`・`family_members` のトリガー → family の route | 家族プランのご契約が必要です。 |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` (変えない) | 409 | 核の `POST /api/billing/checkout` (live な行があるとき。I 行も `findLiveSubscription` が返す。§7.1) | すでに有効な契約があります (既存。`src/lib/billing/core.ts:240`) |
| `BILL_NO_LIVE_SUBSCRIPTION` (変えない) | 409 | 核の `POST /api/billing/subscription/cancel`・`resume` (live な行が無いか、行の `stripe_subscription_id` が NULL。M 行・I 行。§7.1) | 有効な契約がありません (既存。`src/lib/billing/core.ts:237`) |
| `BILL_CUSTOMER_NOT_FOUND` (変えない) | 404 | 核の `POST /api/billing/portal` (`billing_customers` の行が無い。Web で一度も買っていない I 行・M 行の利用者。画面は I 行のときこのボタンを出さない。§7.1・§10.3) | 既存の文のまま (`src/lib/billing/core.ts:236`。#1911 の文の検査 `tests/no-pending-wording-1911.test.ts` が `core.ts` を対象に入れて通している文で、本冊は変えない) |
| `BILL_IAP_SYNC_CONFLICT` [NEW] | 409 | sync (`BILL_LIVE_ROW_CONFLICT` の写し) | すでに別のご契約があるため、この購入をご利用のプランに反映できませんでした。お問い合わせフォームからご連絡ください。二重のお支払いにならないよう対応します |
| `BILL_IAP_UNKNOWN_PRODUCT` [NEW] | 422 | sync (`plan_store_products` に対応の行が無く、利用者の行も無い live な商品。§8.1 `unmappedStoreSubscriptionDecision`) | この購入をご利用のプランに結び付けられませんでした。お問い合わせフォームからご連絡ください |
| `AI_DAILY_LIMIT` | 429 | `consume_ai_usage_at` (1 日の上限・機能ごとの上限 (cap > 0)) | 既存の文 (機能ごとの上限は `aiFeatureDailyLimitMessage`。献立の作成は「今日の献立の作成の利用回数の上限 (3 回) に達しました。明日 0 時から使えます。」。究極モードの文はいまと同じ) |
| `RATE_LIMITED` | 429 | `rateLimitExceededResponse` | 既存の文 |
| `INTERNAL_ERROR` | 500 | `internalError` | 処理中にエラーが発生しました |
| `EXT_REVENUECAT_API_FAILED` [NEW] | 502 | gateway (`RevenueCatApiError`: 2xx 以外・応答の形の違い・時間切れ・接続の失敗。sync の応答。Webhook は 500 + `failed` の記録のコード。S30) | 購入の確認サービスとの通信に失敗しました。しばらくしてからお試しください |
| `EXT_REVENUECAT_NOT_CONFIGURED` [NEW] | 503 | gateway (鍵なし) | 購入の確認を完了できませんでした。時間をおいてお試しください |
| `EXT_STRIPE_NOT_CONFIGURED` (変えない) | 503 | 核 | お支払いを受け付けていません (#1911 が直した main の文のまま。`src/lib/billing/core.ts:241`。CTA は Price のある間隔だけに出るので、販売の開始の後は鍵の設定の誤りのときだけ出る) |

[NEW] は `cross/04` §4.2 に追記する (§16.2)。

### 13.2 Webhook (RevenueCat 向け。本文は固定の語)

| HTTP | 本文 | 意味 |
|---|---|---|
| 200 | `{ received: true, action: 'synced' \| 'ignored', detail }` / `{ received: true, duplicate: true }` | 処理した・対象外 / 処理済み |
| 409 | `{ error: 'event_in_progress' }` | 同じ `id` をほかが処理中 (15 分以内)。RevenueCat が後で再送する |
| 400 | `{ error: 'invalid_payload' }` | JSON でない・外形が違う |
| 401 | `{ error: 'unauthorized' }` | 署名が無い・合わない・時刻が許容の外 |
| 413 | `{ error: 'payload_too_large' }` | 256 KiB 超 |
| 500 | `internalError` の本文 | 処理の失敗 (RevenueCat が再送する。5 回で止まる) |
| 503 | `{ error: 'webhook_not_configured' }` / `{ error: 'revenuecat_not_configured' }` | 署名の秘密が無い / 鍵が無い |

### 13.3 DB 関数の業務エラー (`P0001`。TS では `BillingRpcError`)

| コード | DETAIL | 意味 | 扱い |
|---|---|---|---|
| `BILL_UNKNOWN_PLAN` | `<store>:<product_id>` / plan_key | 商品の対応が無い (TS は先に `BILL_IAP_UNKNOWN_PRODUCT` で止めるので、ここに来るのは行の `plan_key` が `subscription_plans` から消えたときだけ) | Webhook `failed`・監査 |
| `BILL_UNKNOWN_IAP_STATUS` [NEW] | status | snapshot の status が 5 値の外 (TS の不具合) | 同上 (テスト 123) |
| `BILL_LIVE_ROW_CONFLICT` | 既存の live 行の id | 同じ利用者に別の live 行 (S13 = Stripe・手動付与とストア、S25 = 別のストア・同じ Google Play の 2 つ、TRANSFER の先に別の契約)。同じ App Store のグループの 2 つの live は TS が古い方を先に `expired` で写すので衝突しない (§7.3・S36) | Webhook `failed` + 監査 `system.revenuecat.event_failed` (warn)。sync は 409。運営の処置は下の表 (利用者は後の購入のストアの契約で使い続けられるようにする) |
| `FAMILY_PLAN_REQUIRED` [NEW] | family_id (トリガー) / なし (`create_family_group`) | 家族プランの契約の無い代表者のグループを作る・メンバーを足す | route が 402 |

二重購読のときの運営の処置 (S13・S25・S36。operator/09 の手順に足す。§16.2)。「I 行 (App Store) × App Store」の行だけは写像が止まらず (衝突にしない。S36)、ほかの行は写像が `BILL_LIVE_ROW_CONFLICT` で止まったときの処置:

| 先にある live 行 (DETAIL の行) | 後から来た購入 | 運営の処置 | 根拠 |
|---|---|---|---|
| S 行 (Stripe) | ストア | Stripe の Dashboard で契約をすぐに解約し、その期間の料金を返金する → Stripe の Webhook で S 行が `cancelled` → RevenueCat の Dashboard でイベントを Retry (または利用者がアプリの「プランとお支払い」を開いて同期) → I 行が INSERT | 当社が持つ契約なので当社が解約・返金できる |
| M 行 (手動付与) | ストア | `DELETE /api/super-admin/users/[id]/manual-plan` (付与の取り消し。billing/02) → Retry / 同期 | 手動付与は当社の操作で外せる |
| I 行 (App Store か Google Play) | Google Play | Play Console で後から来た Google Play の注文を返金する (購読はすぐ終わる。P14)。利用者は先の契約で使い続ける | Google Play は開発者が返金できる (P14) |
| I 行 (Google Play) | App Store | Play Console で先の Google Play の最新の注文を返金する → 取り直しで先の行が `cancelled` → Retry / 同期で App Store の行が INSERT | 同上 |
| I 行 (App Store) | App Store (同じ利用者の別の商品) | 写像は衝突にしない: 同じグループの中の変更 (上位への変更・体験中の変更。S36) として、新しい方 (`compareStoreSubscriptionRecency`) を権利にし、古い方の行を `expired` で写す (監査 `system.billing.subscription_status_changed` の `details.source` が `…:superseded`)。運営の処置は、利用者から二重の請求の問い合わせがあったときだけ: 監査の `:superseded` の行で 2 つの商品を確かめ、利用者に、どちらか一方を App Store の定期購読の管理で解約し、その購入の返金を reportaproblem.apple.com から Apple に申し込むよう案内する (固定の案内の文は operator/09)。別の Apple ID の二重購読 (S25) はグループの中の変更と見分けられないので同じ扱い。解約した方が期限切れか返金で live でなくなれば、残った方だけが次の取り直しで権利になる | 同じ Apple ID のグループの購読は Apple が 1 つだけ更新する (P18)。App Store の購入は開発者が返金できない (P14) |
| I 行 (App Store) | Stripe (Web) | Stripe の写像が `BILL_LIVE_ROW_CONFLICT` で止める (billing/01 の既存の扱い)。運営は Stripe の Dashboard で後から来た Stripe の契約を解約・返金する | 当社が持つ契約 |

核の `BILL_UNKNOWN_USER` (billing/01 §13.3) は本冊の写像 `billing_apply_store_subscription` では使わない。`app_user_id` が `auth.users` に無いとき (退会済み) は業務エラーにせず `{ applied: false, skipped: 'user_deleted' }` を返し、Webhook は 200 (§6.4 の 1.・§7.3・テスト 72)。そのため `STORE_RPC_ERROR_CODES` (§8.3) にも入れない。

---

## 14. テスト一覧 (it 名)

### 14.1 単体 (`npm test`。DB も RevenueCat も使わない)

未完成や予定を示す語の見張り (テスト 13・36・40・48・56・96・127) は、どれも同じ禁止語の一覧をテストの中にリテラルで持つ: `const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;` (発注者の指示「「まだできてません」みたいなのは書かないで」。§0.4)。対象の文に 1 つでも含まれたら赤。

`tests/billing-iap-core.test.ts` (`src/lib/billing/iap-core.ts`):
1. `it('iap-core imports only zod (no I/O, no @/lib)')` (ソースの import を走査。`tests/billing-core.test.ts` と同じ形)
2. `it('classifyRevenueCatEvent maps the 21 documented types and treats unknown types as sync')`
3. `it('appUserIdsToSync returns the single uuid for sync events, both sides for TRANSFER, nothing for ignore, and drops anonymous ids')`
4. `it('deriveStoreStatus follows §7.3: refunded → cancelled, no expiry → active, future expiry → past_due / trialing / active, past expiry with a future grace_period_expires_date → past_due, past expiry without grace (null or past) → expired')`
5. `it('projectStoreSubscription builds the snapshot with plan_key and interval from the mapping and cancel_at_period_end from unsubscribe_detected_at')`
6. `it('projectMissingSubscription builds an expired snapshot with expires_date = now and keeps the given is_sandbox and billing_interval')`
7. `it('selectStoreSubscriptions keeps only app_store / play_store entries and orders non-live before live, then by expires_date')`
8. `it('needsLazyResync is true only for store rows past current_period_end whose iap_synced_at is older than 5 minutes')`
9. `it('minimizeRevenueCatEventPayload keeps only the allow-listed fields and drops subscriber_attributes / aliases / price')`
10. `it('buildIapCatalog returns only plans that have offered products for the store, month before year, ignores offered = false rows and returns no trial days')`
113. `it('unmappedStoreSubscriptionDecision applies mapped entries and unmapped entries with an existing row, rejects unmapped live entries without a row and skips unmapped non-live entries without a row')` (S15・S28)
11. `it('RevenueCatWebhookEnvelopeSchema accepts the documented INITIAL_PURCHASE / RENEWAL / TRANSFER samples and rejects a body without event.id')`
12. `it('RevenueCatCustomerInfoSchema accepts the documented subscriber shape (subscriptions keyed by product id)')`
13. `it('IAP_ERROR_MESSAGES do not contain any UNFINISHED_WORDS (準備中 / 販売開始前 / 近日 / 予定 / まだ / 確定次第 / これから)')` (禁止語の一覧はテストの中にリテラルで書く。§14.1 冒頭)
85. `it('deriveStoreStatus / projectStoreSubscription keep past_due with cancel_at_period_end = true for an unsubscribed billing-issue subscription, and false after uncancellation')` (§7.3 の `past_due` の行。83 以降は網羅性の反映で足した通し番号で、置き場所はファイルごとの組に合わせる)
95. `it('IAP_STORES equals PURCHASE_STORES of @homegohan/shared (billing-plans.ts)')`
125. `it('projectStoreSubscription maps each of the 12 product rows of §17.2 (6 products × app_store / play_store) to its plan_key and billing_interval')` (S34。12 行はテストの中にリテラルで持つ)
134. `it('selectStoreSubscriptions marks every live app_store entry except the most recent by compareStoreSubscriptionRecency (purchase_date, then expires_date, then product_id) as superseded with supersededAt = the winner purchase_date and orders them before the winner, leaves a single live app_store entry and non-live entries with supersededAt null, and never supersedes two live play_store entries')` (S36・S25。体験中の個人 Pro の月額と、`purchase_date` の新しい家族 Pro の月額の 2 つを含む customer info をテストの中にリテラルで持つ)
135. `it('projectStoreSubscription turns an entry with supersededAt into an expired snapshot whose expires_date is supersededAt and cancel_at_period_end is false even with unsubscribe_detected_at, and unmappedStoreSubscriptionDecision skips a superseded live entry that has neither a mapping nor a user row')` (S36)

`src/__tests__/lib/webhook/verify.test.ts` (追加):
14. `it('verifyRevenueCatSignature returns missing_headers for a null or malformed header and invalid_timestamp for a non-numeric t')`
15. `it('verifyRevenueCatSignature accepts HMAC-SHA256 hex of "<t>.<body>" keyed by the raw secret within WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS and rejects mismatch / stale timestamp')` (期待の署名はテストの中で `crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')` で作る)
16. `it('verifyRevenueCatWebhook throws WebhookSecretMissingError when REVENUECAT_WEBHOOK_SECRET is missing')`

`tests/billing-iap-service.test.ts` (`iap-service.ts`。gateway と repository は偽物):
17. `it('syncStoreSubscriber fetches the subscriber, applies non-live entries before live ones and returns counts')`
18. `it('syncStoreSubscriber throws BILL_IAP_UNKNOWN_PRODUCT before any write when a live store subscription has neither a plan_store_products row nor a user row, skips an unmapped expired entry without a row (skipped_unknown) while applying the mapped live entry, and applies an unmapped entry that already has a user row with plan_key null')` (S15・S28)
19. `it('syncStoreSubscriber ends live store rows that are missing from the subscriber (TRANSFER away) with an expired snapshot carrying the row is_sandbox and billing_interval, and leaves non-live rows alone')`
20. `it('syncStoreSubscriber reports no_subscription when the subscriber has no app_store / play_store entries and writes nothing')`
21. `it('handleRevenueCatEvent syncs both transferred_from and transferred_to for TRANSFER and ignores TEST')`
22. `it('handleRevenueCatEvent lets BILL_LIVE_ROW_CONFLICT propagate (route records the failure)')`
23. `it('recordRevenueCatEventFailure marks the event failed and audits system.revenuecat.event_failed (audit is fail-open)')`
24. `it('lazyResyncStoreSubscription syncs only when needsLazyResync and swallows failures')`
136. `it('syncStoreSubscriber applies a superseded App Store entry first as an expired snapshot with the source suffixed :superseded and then the winner with the plain source, so an upgrade during a trial neither throws BILL_LIVE_ROW_CONFLICT nor keeps the old plan')` (S36。偽の repository が受けた `applyStoreSubscription` の引数の順と `source` を見る)

`tests/webhooks-revenuecat-route.test.ts` (route。署名は本物、ほかは偽物):
25. `it('returns 413 { error: payload_too_large } for a content-length header or a body over REVENUECAT_WEBHOOK_MAX_BODY_BYTES (256 KiB) before verifying the signature, 401 for a bad signature, 400 for malformed JSON or envelope')` (§13.2 の 413 の行)
26. `it('returns 503 { error: webhook_not_configured } when REVENUECAT_WEBHOOK_SECRET is missing and 503 { error: revenuecat_not_configured } when REVENUECAT_SECRET_API_KEY is missing, without claiming the event')` (§13.2 の 503 の行・S14)
27. `it('returns 200 duplicate for completed claims, 409 for in_progress, and 200 synced after handling')`
28. `it('returns 500 and records failure with the BillingRpcError / IapError code when handling throws')`
29. `it('handles SANDBOX events exactly like PRODUCTION events (no environment branch): the sync is called and the response is 200 synced')`
30. `it('maxDuration literal equals REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS')`
122. `it('returns 500 and records the event failed with EXT_REVENUECAT_API_FAILED when the RevenueCat fetch throws RevenueCatApiError, without the raw RevenueCat text in the body')` (S30)

`tests/api/billing-iap-routes.test.ts` (catalog・sync・subscription の差分):
31. `it('GET catalog requires a valid store query, returns plans with products for that store and never reads env')` (`reachesAi` で届かないことも見る)
32. `it('POST sync returns the summary after syncing, 409 BILL_IAP_SYNC_CONFLICT on BILL_LIVE_ROW_CONFLICT, 503 when the key is missing')`
33. `it('GET subscription lazily resyncs expired store rows and still returns the summary when RevenueCat is not configured')`
117. `it('GET catalog and POST sync return 403 { code: AUTH_ACCOUNT_FROZEN, message: 権限がありません } when requireUser throws the frozen ForbiddenError, without reading plan_store_products or creating the RevenueCat gateway')` (S22。middleware を素通りしたときの route の枝)
118. `it('/api/billing/iap/catalog and /api/billing/iap/sync are in neither FROZEN_ALLOWED_API_PATHS (src/lib/auth/frozen.ts) nor the legal consent exemption (isLegalConsentExemptApiPath of @homegohan/shared is false for both)')` (S21・S22。middleware の 403 `AUTH_ACCOUNT_FROZEN` / `LEGAL_CONSENT_REQUIRED` そのものは、src/app/api の全 route を走査する既存の it (`lib/supabase/__tests__/middleware-legal-consent-api.test.ts` の「全 route を 未同意 × ENFORCE=on で通すと…」と「…凍結中 で通すと…」) が新しい 2 本も含めて見る)
119. `it('GET catalog returns 400 BILL_IAP_INVALID_INPUT with 入力値が不正です for a missing store, store=stripe and store=APP_STORE, and reads neither plan_store_products nor listPublicPlans')` (S31)
120. `it('POST sync returns 502 EXT_REVENUECAT_API_FAILED with the fixed text (no raw RevenueCat text) and writes nothing when the gateway throws RevenueCatApiError, and GET subscription still returns the summary of the current row when the lazy resync gets the same error')` (S30)

`tests/api/billing-routes.test.ts` (追加。§16.1 の行):
131. `it('GET /api/billing/subscription reads findLiveSubscription and neither creates the RevenueCat gateway nor calls lazyResyncStoreSubscription for a null row, a Stripe row (iap_store null) or a store row whose current_period_end is in the future')` (S12 の逆: 期限の中の行は取り直さない)

メンテナンス中の止め方 (コードは変えない。§9.1):
132. `src/__tests__/lib/maintenance-mode.test.ts` (既存の `it.each([...])('%s は止める')` (`:89-140`) の配列に 3 行): `'/api/webhooks/revenuecat'`・`'/api/billing/iap/catalog'`・`'/api/billing/iap/sync'` で `isMaintenanceExemptPath` が `false`
133. `lib/supabase/__tests__/middleware-maintenance.test.ts` (既存の `it.each(['/api/webhooks/stripe', '/api/webhooks'])` (`:207-217`) の配列に 1 行): `'/api/webhooks/revenuecat'` の POST がメンテナンス中は 503 `MAINTENANCE_MODE`

`tests/billing-revenuecat-gateway.test.ts` (新設。`createRevenueCatGateway(fetchImpl)` に偽の fetch を渡す。`getOptionalEnv` は `vi.mock`):
121. `it('getSubscriber throws RevenueCatApiError with the status for a non-2xx response, with the status for an unexpected response shape, and with status null for a TimeoutError and a network TypeError, and returns the parsed subscriber for a 2xx response')` (S30)

`tests/billing-repository-plan-features.test.ts` (新設。`vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => fakeAdmin }))` で、`from('ai_daily_limits').select(…).in('plan_key', […])` と `from('ai_plan_feature_caps').select(…).eq('plan_key', …)` に表の行を返す偽の client を渡し、`createBillingRepository()` を引数なしで呼ぶ (型の変換を書かない)):
138. `it('findPlanFeatures falls back to the free ai_daily_limits row only for the daily limit and never for ai_feature_caps: an organization plan (standard) with its own daily limit row and no ai_plan_feature_caps rows returns that limit and {}, a plan without an ai_daily_limits row returns the free limit and {}, a row whose daily_limit is NULL stays NULL, and free returns its 4 caps')` (S26・§8.6)

`tests/billing-core.test.ts` (追加):
34. `it('summarizeSubscription marks store rows with source and manage_in_store and never can_cancel / can_resume them')`
35. `it('summarizeSubscription includes features and keeps the stripe / manual behaviour unchanged')`
36. `it('BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED stays お支払いを受け付けていません (#1911) and contains none of UNFINISHED_WORDS')`

`tests/billing-plan-catalog.test.ts` (`packages/shared/src/billing-plans.ts` と migration の突き合わせ):
37. `it('PLAN_CATALOG prices and trial days equal the UPDATE statements in the billing_paid_plans_iap migration (the /faq half lands with stage C)')` (段 B)。後半の `it('src/app/faq/page.tsx holds FREE_PLAN_FAQ_ANSWER and PAID_PLANS_FAQ_ANSWER verbatim as the a of 料金はかかりますか？ and 有料プランはありますか？')` は `/faq` を変える段 C で同じファイルに足す (段 B の時点の `/faq` は #1911 の文のままなので、1 つの it にすると段 B で赤になる)
38. `it('PLAN_AI_DAILY_LIMITS / PLAN_ULTIMATE_DAILY_CAPS / PLAN_MENU_GENERATION_DAILY_CAPS equal the migration seed rows')`
39. `it('planCatalogPriceText renders 3 lines with tax-included prices and the member limits')`
93. `tests/billing-status-lines-parity.test.ts`: `it('subscriptionStatusLines (@homegohan/shared) equals billingStatusLines (core.ts) for the 5 live statuses × cancel_at_period_end × trial_ends_at / cancel_at present or null, including dates near JST midnight')`
94. `tests/billing-summary-wire.test.ts`: `it('summarizeSubscription results are assignable to BillingSummaryWire (type) and parseBillingSummaryWire returns them unchanged for S / M / I / no-row cases, and returns null for a missing features field')`
40. `it('no billing-plans.ts text (PLAN_CATALOG features, FREE_PLAN_FEATURES, FREE_PLAN_AI_LIMIT_NOTE, FREE_PLAN_FAQ_ANSWER, PAID_PLANS_FAQ_ANSWER, planCatalogPriceText, status lines) contains any of UNFINISHED_WORDS, and FREE_PLAN_AI_LIMIT_NOTE contains the #1867 Q-12 phrase 1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。')`
127. `tests/billing-plan-catalog.test.ts` (追加。§10.4): `it('the account deletion entry points are exactly the 3 files under src/app and src/components that call deleteOwnAccount( and the 1 file under apps/mobile/app that posts "/api/account/delete", each imports STORE_SUBSCRIPTION_DELETION_NOTICE from @homegohan/shared and uses it, and the notice contains none of UNFINISHED_WORDS')` (4 つのファイル (`src/app/(main)/settings/page.tsx`・`src/components/account/AccountSelfServicePanel.tsx`・`src/app/legal-consent/LegalConsentForm.tsx`・`apps/mobile/app/settings/account.tsx`) をテストの中にリテラルで持ち、`src/app`・`src/components` と `apps/mobile/app` の `.ts` / `.tsx` を走査して見つけた一覧と `toEqual` で比べる。「使う」= `@homegohan/shared` からの import の行の外にも名前がもう 1 回以上ある。S35)

`tests/ai-daily-limit-core.test.ts` (追加):
41. `it('parseConsumeAiUsageResult reads capped_feature for the 4 plan-capped features, sets planLocked only with plan_locked true and a known feature, and ignores unknown feature names')`
42. `it('aiDailyLimitPayload returns 403 AI_FEATURE_NOT_IN_PLAN { error, code, feature } without Retry-After when planLocked, 429 with aiFeatureDailyLimitMessage when a cap > 0 is reached, and the unchanged ultimate-mode text')`
43. `it('isAiDailyLimitMessage accepts the feature-not-in-plan messages (all 4 features and the fallback) and the feature-limit messages, and aiDailyLimitMessageOfBody reads both 403 and 429 bodies (flat and nested)')`
142. 同: `it('aiDailyLimitMessageOfStatusAndBody returns a message only for 429 with an AI_DAILY_LIMIT body and 403 with an AI_FEATURE_NOT_IN_PLAN body (flat and nested), and null for 403 with an AI_DAILY_LIMIT body, 429 with an AI_FEATURE_NOT_IN_PLAN body, 429 RATE_LIMITED, 403 AI_CONSENT_REQUIRED, 200 and non-object bodies')` (状態と code の組の正本。§8.8)
89. `it('aiDailyLimitMessageOfDenied returns the not-in-plan message for planLocked denials, so the Edge row error_message and the consultation action result carry it, and aiDailyLimitSkippedField returns {} for planLocked')`
97. `tests/consultation-action-usage.test.ts` (追加): `it('dailyLimitResult returns code AI_FEATURE_NOT_IN_PLAN with the not-in-plan message for planLocked denials and AI_DAILY_LIMIT otherwise')`
101. `tests/ai-daily-limit-client.test.tsx` (追加): `it('aiDailyLimitMessageOfResponse returns the not-in-plan message for 403 AI_FEATURE_NOT_IN_PLAN (flat and nested) and null for 403 AI_CONSENT_REQUIRED and 429 with an AI_FEATURE_NOT_IN_PLAN body')` (403 + `AI_DAILY_LIMIT` の本文 → null は既存の `:40-45` の it が見る)
92. `tests/meal-image-skip.test.ts` (追加): `it('mealImageSkipReasonOf returns plan for planLocked denials, ai_limit for other denials and rate_limit for null / allowed; MEAL_IMAGE_SKIPPED_ERRORS.plan is skipped_plan and isMealImagePlanSkippedError matches only it')`
111. `tests/meal-image-skip.test.ts` (追加): `it('mealImageJobPlanDecision returns locked only for a cap of 0 and allowed for null, a positive cap or an unreadable value')`。`tests/meal-image-plan-gate-source.test.ts` (新設。ソースの走査): `it('process-meal-image-jobs reads ai_plan_feature_daily_cap with meal_image_auto after the consent check and before generateImage, cancels the job with MEAL_IMAGE_SKIPPED_ERRORS.plan when locked, and save-meal.ts still does not call consume_ai_usage')` (S27。`index.ts` のソースで `checkAiConsent` → `ai_plan_feature_daily_cap` → `generateImage(` の出現の順を見る)
98. `tests/meal-image-skip-routes.test.ts` (追加。既存の `describe.each(ENTRIES)` の中に 1 つ。5 つの入口 = POST /api/meals・POST /api/meal-plans/meals・PATCH /api/meals/[id]・PATCH /api/meal-plans/meals/[id]・AI 相談の update_meal): `it('A-plan. meal_image_auto が plan-locked: 料理を failed + skipped_plan で保存し (pending を残さない)、ジョブを積まず、数え戻さず、aiSkipped を付けない')` (`h.consumeAiUsage` の偽物が `{ ...AI_USAGE_DENIED, cappedFeature: 'meal_image_auto', planLocked: true }` を返す。既存の A の it と同じ形で、期待は `image_error: 'skipped_plan'` と `out.aiSkipped` が undefined)
108. `tests/stored-failure-messages.test.ts` (追加。`describe('画面に出すときの絞り込み (Web とアプリが同じ答え)')` の中): `it('使えない機能の文 (AI_PLAN_CAPPED_FEATURES の 4 つの aiFeatureNotInPlanMessage と AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE)・機能ごとの上限の文 (aiFeatureDailyLimitMessage)・aiDailyLimitMessageOfDenied が planLocked と AI_PLAN_CAPPED_FEATURES の cappedFeature から作る文は、Web (weeklyMenuRequestErrorMessageForDisplay / ForResponse) とアプリ (menuRequestErrorMessageForDisplay) がどちらもそのまま出す')` (行に書く側が作りうる文を読む側がすべて通す契約を、本冊の新しい文まで広げる)
99. `src/__tests__/app/menus/weekly/recipe-modal-plan-skipped.test.tsx` (新設): `it('RecipeModal shows the paid-plan wording for skipped_plan and keeps the existing wording for skipped_ai_limit / skipped_rate_limit')`
140. `tests/process-meal-image-jobs-worker-edges.test.ts` (追加。§16.1 の行。ハンドラは本物): `it('billing/03: ai_plan_feature_daily_cap が 0 (無料の利用者) なら、画像を作らずにジョブを cancelled (last_error = skipped_plan) にし、料理を failed + skipped_plan にする')` (S27)
141. 同: `it.each(['error', 'throws'] as const)('billing/03: ai_plan_feature_daily_cap の RPC が %s のときも止めずに画像を作り (completed)、warn を 1 つ残す')` (§18 の 21)

自動の料理画像は献立の主菜の 1 品だけ (Q-16。§8.8・§7.1 の「自動の料理画像を作る料理」の表・§7.3 の料理の画像の状態の遷移):
143. `tests/meal-image-skip.test.ts` (追加): `it('autoImageDishIndexOf returns the first dish whose role is main or 主菜 (ignoring surrounding spaces and letter case), AUTO_IMAGE_FALLBACK_DISH_INDEX when no dish is a main dish (rice + soup, other only, no role), and null for no dishes')` (S37・S38・S39)
144. 同: `it('reconcileDishImages enqueues only the main dish of a new main + side + soup + rice meal and leaves the other dishes with no image state (image_source, image_status, image_subject_hash, image_url, image_generated_at and image_error null), keeping image_prompt and image_model')` (S37・S39)
145. 同: `it('reconcileDishImages enqueues the first dish when no dish is a main dish and the main dish at a later position (side, main), and only the first of two main dishes')` (S38)
146. 同: `it('reconcileDishImages keeps the ready AI image of an unchanged non-main dish without a job, and turns a changed non-main dish into no image state without a job')` (S41)
147. 同: `it('reconcileDishImages turns a waiting (pending / stale / failed) non-main dish saved unchanged into no image state without a job, and a second unchanged save keeps it without a job; a non-main-only change of a meal whose main dish is ready yields no job')` (S39・S41)
148. 同: `it('mealCoverRepresentsDish is true for a single-dish meal, the auto image dish and meal_photo / catalog / manual_override dishes, and false for other dishes of a multi-dish meal and for an index without a dish')` (S37・S38)
149. `tests/save-meal-photo-preserve.test.ts` (追加。`saveMealToDb` を本物で通す): `it('billing/03 Q-16: 主菜・副菜・汁物の新しい献立を作ると、主菜の 1 品だけにジョブを積み、副菜と汁物は画像の無い状態で保存する')` (S37)
150. `tests/meal-image-skip-routes.test.ts` (追加。既存の `describe.each(ENTRIES)` の中に 1 つ): `it('Q-16. 汁物と主菜 (主菜が 2 品目) を保存すると、主菜の 1 行 (dish_index 1) だけを積んで 1 回数え、汁物は画像の無い状態で保存する')` (S38・S39)
151. 同 (追加。既存の `describe.each(UPDATE_ENTRIES)` の中に 1 つ。更新の 3 つの入口): `it('Q-16. 主菜の画像ができた献立で汁物だけを変えて保存し直すと、積まず・数えず (consumeAiUsage を呼ばない)、汁物は画像の無い状態になる')` (S39)
152. `tests/meal-image-backfill.test.ts` (追加): `it('planDishImageJobs skips waiting dishes other than the auto image dish as not_auto_image_dish and still plans the waiting main dish (billing/03 Q-16)')` (S41)
153. `tests/meal-image-plan-gate-source.test.ts` (追加。ソースの走査): `it('the weekly page falls back to the meal cover only through mealCoverRepresentsDish (no dish.image_url ?? meal.imageUrl), and reconcileDishImages narrows the jobs with autoImageDishIndexOf before it returns')` (S37。`src/app/(main)/menus/weekly/page.tsx` と `supabase/functions/_shared/meal-image.ts` をコメントを除いて読む)
154. `src/__tests__/app/menus/weekly/recipe-modal-plan-skipped.test.tsx` (追加): `it('RecipeModal shows no image frame for a dish without imageUrl and image_status (a non-main dish under billing/03 Q-16)')` (S37)
155. `tests/billing-plan-catalog.test.ts` (追加): `it('every PLAN_CATALOG plan has exactly one 料理画像の作成 feature line, which says the image is made for the main dish (主菜) and contains none of UNFINISHED_WORDS')` (S37・R26。`PAID_MEAL_IMAGE_FEATURE` は export しないので、`features` の中の「料理画像の作成」で始まる行を見る)
156. `tests/meal-image-skip.test.ts` (追加): `it('autoImageDishHandoverIndexOf returns the new auto image dish index only when it differs from the previous one, the dish there has no job and no image state (no image_url, image_source or image_subject_hash), and returns null for no previous dishes, an unchanged role order, a seeded index, a ready / pending / meal_photo / catalog / manual_override dish, and treats a non-object previous dish as a dish without a role')` (S42)
157. 同: `it('reconcileDishImages hands the auto image over to an unchanged no-image dish: deleting the ready main of [rice, main] enqueues one pending job for the rice (dish 0), changing the first of two main dishes to side enqueues only the second main (dish 2) and clears the first, and an unchanged re-save of a meal with no-image dishes enqueues nothing')` (S42。カバーの献立 (写真の料理があり `isMealCoverHeldByImagelessPreservedDish` が真) では引き継ぎの料理を画像の無い状態に戻して積まないことも同じ it で見る)
158. `tests/meal-image-skip-routes.test.ts` (追加。既存の `describe.each(UPDATE_ENTRIES)` の中に 1 つ。更新の 3 つの入口): `it('Q-16. ご飯と主菜 (主菜は画像あり・ご飯は画像の無い状態) の献立で主菜を消して保存し直すと、ご飯の 1 行 (dish_index 0) を積んで 1 回数える')` (S42)
159. `tests/save-meal-photo-preserve.test.ts` (追加。`saveMealToDb` を本物で通す。既存の `regenerate` と `aiDish` を使う): `it('billing/03 Q-16: 写真の料理 (複数) の枠を主菜だけ変えて作り直すと、主菜にだけ AI の画像のジョブを積み (stale)、同じまま残った写真の汁物は画像の無い状態にし (写真の印も外れる)、写真のカバーを外す')` (§7.3 の「作り直し」の行。前の献立は `buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL)`、作り直しは `[aiDish("鮭の塩焼き"), { name: "味噌汁", role: "soup", ingredients: [], instructions: [] } as never]`。期待は `enqueueMock` の `jobs` が `[expect.objectContaining({ dishIndex: 0 })]`・料理の `[image_source, image_status, image_url]` が `[["generated_ai", "stale", null], [null, null, null]]`・汁物の `image_subject_hash` が null・`row.image_url` が null)

`tests/public-claims-guard.test.ts` (書き換え。§10.1・§10.2):
44. `it('pricing page shows one card per public plan with both interval amounts, trial and PLAN_CATALOG features and no CTA when no Price is registered, and only the free card when the read fails (no 現在は無料 and no FAQ section)')`
45. `it('pricing page shows CTA only for purchasable intervals and hides paid cards and the payment note in native app mode')`
46. `it('legal page keeps the #1911 business rows and adds the 9 sale rows (販売価格 from planCatalogPriceText, 支払方法, 支払時期, サービス提供時期, 返品・キャンセル, 解約について, 定期購入について, 無料体験について, 商品代金以外の必要料金) without LEGAL_NOT_SELLING_TEXTS and PENDING_WORDS')`
47. (欠番。運営会社のページは #1911 の it (`tests/public-claims-guard.test.ts:374-427` (origin/main `2ba5b3b3`)) が見張り、本冊は変えない)
48. `it('no public page source or render (pricing / legal / faq / landing-copy) contains any of UNFINISHED_WORDS')`
116. `it('/faq の料金は「料金はかかりますか？」(FREE_PLAN_FAQ_ANSWER。AI_DAILY_LIMIT_PHRASE を含む)・「有料プランはありますか？」(PAID_PLANS_FAQ_ANSWER)・「返金はできますか？」・「有料プランを解約するには？」の 4 項目で、ページにプレミアム限定・Visa・解約後も次回更新日まで・年払いを書かない')` (§10.5。いまの `:567-571` の it と `:640-642` の it を置き換える)

`tests/legal-text-1901.test.ts` (段 E。cross/20 の T-33・T-34 を改める。§11.5):
115. T-33 の書き換え (it 名は §11.5)。T-34 の `PRIVACY_DATA_TABLES` / `PRIVACY_DATA_EXCLUDED` の移し替え (it 名は cross/20 のまま)。T-35 は主張の表の 42 行の追加と 3 行の直し (§11.4) で緑

`tests/landing-page-1867.test.ts` (追加。§10.5):
104. `it('U-37 pricing.plans の free の items に家族・究極モード・料理画像を含まず、paid の items は PLAN_CATALOG の 3 プランの価格の行で、家族を説明する文 (features の家族のカード・場面の子育て家庭・家族の章の lead・faq の「家族で使えますか？」の答え) はどれも「家族プラン」を含む')`

`tests/business-info-legal-pages.test.ts` (書き換え): 所在地 = `BUSINESS_ADDRESS`・メールアドレス = `BUSINESS_EMAIL`・営業時間の行。

Web の契約の画面 (追加。§10.3・§10.4):
87. `src/__tests__/app/account/billing-pages.test.ts`: `it('account billing page shows the store contract wording with the store management link and no cancel / resume / portal buttons for app_store and play_store rows')` (S4)
88. `src/__tests__/app/frozen-billing-page.test.tsx`: `it('frozen billing page shows the store management wording and no cancel button for a store row')` (S22)
128. `src/__tests__/app/frozen-account-page.test.tsx` (追加。§10.4): `it('退会: 削除の節に STORE_SUBSCRIPTION_DELETION_NOTICE (ストアの購読は退会で解約されない) の文を出す')` (S35)
130. `tests/legal-consent-page.test.tsx` (追加。§10.4): `it('billing/03: minor_refused と guardianMissing の案内に、STORE_SUBSCRIPTION_DELETION_NOTICE の文を「登録をやめる」と一緒に出す')` (S35)
103. `src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts` (追加。§10.3): `it('locks the ultimate-mode toggle with aria-disabled and the paid-plan wording when features.ai_feature_caps.menu_generation_ultimate is 0, and leaves it operable when the summary is null or the cap is above 0')` (`useBillingSummary` を `vi.mock` で差し替える) (S17)

家族・AI の route:
49. `tests/api/family-plan-required.test.ts`: `it('the 3 family routes (groups, invite accept, child add) map FAMILY_PLAN_REQUIRED from the RPC to 402 with the fixed message')`
50. `src/__tests__/lib/plan/entitlements.test.ts` (追加): `it('consumeAiUsage passes through plan_locked denials unchanged (403 is decided by aiDailyLimitPayload)')`

モバイル (`apps/mobile`、jest):
51. `__tests__/lib/iap-catalog.test.ts`: `it('matchCatalogWithPackages keeps only products present in both the catalog and the offerings and attaches storeTrialOf to each option, and renewalText states the trial only when given and always states the renewal')`
110. 同: `it('storeTrialOf returns 7 日間 for an eligible App Store free trial of 1 WEEK and a Google Play free trial of 7 DAY, and null for ineligible / unknown / missing App Store eligibility, a paid intro price, no intro price, or an unknown period unit')` (S29)
52. `__tests__/lib/purchases.test.ts`: `it('identifyPurchases configures once with the user id, logs in on user change, and resetPurchasesOnSignOut logs out only when not anonymous; without keys it does nothing')`
53. `__tests__/settings/plan-entry.test.tsx`: `it('settings tab has the プランとお支払い row that opens /settings/plan')`
54. `__tests__/settings/plan-screen.test.tsx`: `it('plan screen shows the current plan from the summary, hides purchase cards when a live contract exists, shows Web / store wording by source, and always shows 購入を復元 and the legal links')`
55. 同: `it('plan screen purchases a package, then syncs and shows the updated summary; cancelled purchases show nothing; the trial wording appears only for options whose storeTrialOf is not null (an ineligible iOS user sees no trial wording)')`
56. 同: `it('plan screen shows no plan cards when the catalog is empty or purchases are unavailable, and no rendered text contains any of UNFINISHED_WORDS')`
57. `__tests__/menus-weekly/ultimate-mode-toggle.test.tsx` (追加): `it('locked toggle does not switch on and announces the plan requirement')`
58. `__tests__/app/no-web-purchase-links.test.ts`: 変更なし (緑のまま)
59. `__tests__/lib/sign-out.test.ts` (追加): `it('sign-out paths call resetPurchasesOnSignOut before clearing user-scoped data')`
129. `__tests__/settings/account-delete.test.tsx` (追加。§10.4): `it('the アカウント削除 confirmation shows the irreversible text followed by STORE_SUBSCRIPTION_DELETION_NOTICE with キャンセル / 定期購読の管理を開く / 削除, and 定期購読の管理を開く opens STORE_SUBSCRIPTION_MANAGEMENT_URL for the platform (play_store on android, app_store otherwise) without calling the delete API')` (この it の中だけ `alertSpy` を「定期購読の管理を開く」のボタンを押す実装に替え、`jest.spyOn(Linking, 'openURL').mockResolvedValue(true)` を置く。期待の URL は `Platform.OS` から選ぶ。S35)
96. `__tests__/lib/billing-api.test.ts` (新設): `it('fetchBillingSummary / syncIapPurchases parse the data with parseBillingSummaryWire and throw BillingSummaryShapeError on a bad shape; fetchIapCatalog drops malformed plans; billingErrorMessageOf returns the server fixed text for the 4 IAP codes, the generic text for other HTTP errors, and none of UNFINISHED_WORDS appears')`
102. `__tests__/lib/ai-daily-limit.test.ts` (追加): `it('aiDailyLimitErrorOf turns HTTP 403 AI_FEATURE_NOT_IN_PLAN into AiDailyLimitError with the not-in-plan message and leaves 403 LEGAL_CONSENT_REQUIRED and 403 with an AI_DAILY_LIMIT body alone')`

### 14.2 契約・結合 (ローカル Supabase。`tests/integration/rls` と `security` に置く)

`tests/billing-paid-plans-migration-contract.test.ts` (SQL の文面):
60. `it('migration updates exactly the 3 plan rows with the decided prices, trial days and display names, and touches no stripe_* column')`
61. `it('migration creates plan_store_products (primary key (store, product_id), offered with the partial unique index idx_plan_store_products_offered) / revenuecat_webhook_events / ai_plan_feature_caps with RLS and the documented grants')`
62. `it('billing_apply_store_subscription, claim / finish, billing_has_live_family_plan, ai_plan_feature_daily_cap and the family gate trigger are SECURITY DEFINER with empty search_path and EXECUTE only for service_role')`
63. `it('billing_revoke_manual_subscription, billing_expire_manual_subscription_for_user and the PROCEDURE billing_expire_manual_subscriptions select M rows with stripe_subscription_id IS NULL AND iap_store IS NULL, and billing_manual_subscription_sync_after_end is not redefined')`
64. `it('rollback restores create_family_group, the 2 manual-grant functions, the PROCEDURE billing_expire_manual_subscriptions and the AI functions verbatim from their source migrations and drops everything the migration added (including ai_plan_feature_daily_cap)')`
65. `it('no UPDATE / DELETE outside function bodies except the 3 plan rows and the free ai_daily_limits row')`
100. `it('the ai_plan_feature_caps feature CHECK lists exactly AI_PLAN_CAPPED_FEATURES and consume_ai_usage_at checks ai_plan_feature_caps before the c_unmetered branch')`
106. `it('migration copies the free daily_limit to the organization plan keys (organizations.plan, standard, plan_type org) excluding free and the 3 paid keys before it updates free, and the rollback deletes only those rows with updated_by IS NULL')` (S26)

`tests/integration/rls/billing-apply-store-subscription-rpc.test.ts`:
66. `it('inserts a trialing store row, syncs plan_key_cached and the family group, and audits subscription_created')`
67. `it('is monotonic by p_fetched_at (older fetch is stale) and idempotent for the same snapshot')`
68. `it('raises BILL_LIVE_ROW_CONFLICT when a Stripe or manual live row exists, and the Stripe mapping raises the same when a store row is live')`
69. `it('transitions active → expired on a past expires_date and clears plan_key_cached and the family plan')`
70. `it('reuses the same (user, store, product) row on repurchase and keeps trial_started_at')`
71. `it('applies PRODUCT_CHANGE in order: month row expired first, then the yearly row inserted')`
72. `it('returns user_deleted without writing for a missing auth user')`
123. `it('raises BILL_UNKNOWN_IAP_STATUS (P0001, DETAIL = the status) for a snapshot status outside the 5 values and writes no row, no plan_key_cached and no audit')` (§13.3)
124. `it('UNCANCELLATION: a newer snapshot without unsubscribe_detected_at sets cancel_at_period_end = false and cancel_at = NULL on a trialing or active row that had them set, keeps the status and writes no audit')` (S33)
126. `it('a family_pro month store row sets the representative group to family_pro / 8 and a family_basic month store row sets it to family_basic / 4')` (S34)
109. `it('inserts a past_due row with past_due_since and a warn subscription_created audit when the first fetch already has a billing issue, inserts cancel_at_period_end = true and cancel_at = expires_date when the first fetch already has unsubscribe_detected_at, and keeps billing_interval and iap_is_sandbox when a later snapshot has billing_interval null')` (§7.3 の「– (行なし)」の行・指摘の past_due の INSERT)
90. `it('writes iap_is_sandbox from the snapshot (true for sandbox, false otherwise) and records is_sandbox in the audit details, with the same status and plan_key_cached as a production purchase')` (S24)
83. `it('writes trial_started_at / trial_ends_at / trial_source = store on a trialing store row and keeps them after the row expires')` (S23)
84. `it('Web repository hasUsedTrial counts a store trial row for the same plan_key and not for another plan_key')` (S23。`createBillingRepository` の既存の `hasUsedTrial` をローカル Supabase で呼ぶ)
86. `it('applies PRODUCT_CHANGE from a trialing month row: month row expired with trial_started_at kept, then the yearly row inserted with the status from its own period_type')` (§7.3 の `trialing` (月額) の行)
137. `it('an App Store upgrade during a trial: a superseded expired snapshot ends the trialing pro row (trial_started_at kept, audit details.source ends with :superseded), then the family_pro row inserts without BILL_LIVE_ROW_CONFLICT and sets plan_key_cached to family_pro, after which create_family_group succeeds with family_pro / 8')` (S36。§7.3 の「同じグループの 2 つの live」の行)

`tests/integration/rls/billing-revenuecat-events-claim-rpc.test.ts`:
73. `it('claim returns claimed / completed / in_progress and lets failed and stale processing rows be reclaimed')`

`tests/integration/rls/ai-plan-feature-caps-rpc.test.ts`:
74. `it('consume_ai_usage denies with plan_locked for a 0 cap, with capped_feature for a reached cap, and counts normally otherwise')`
75. `it('consume_ai_usage_capped uses the plan row when present and the env cap otherwise')`
76. `it('family plan members inherit the family plan limits via get_effective_plan')`
91. `it('meal_image_auto is denied with plan_locked for free before the unmetered branch (no counter row), while a paid plan without a row still uses the ai_unmetered_daily_caps safety cap')`
107. `it('an organization member without a personal or family plan keeps the pre-migration daily limit (the standard and org_* rows hold the old free value) while a free user is limited to 3')` (S26)
112. `it('ai_plan_feature_daily_cap returns 0 for meal_image_auto of a free user, NULL for a pro user (no row) and the family plan value for a member of a family plan group, and does not write ai_usage_counters')` (S27)
139. `it('findPlanFeatures (createBillingRepository on the local Supabase) agrees with the DB gate: for an organization member (standard) it returns the copied pre-migration daily limit and no menu_generation_ultimate key while consume_ai_usage_capped still allows the env default, and for a free user menu_generation_ultimate is 0')` (S26。段 B で同じファイルに足す)

`tests/integration/security/family-plan-gate.test.ts`:
77. `it('create_family_group raises FAMILY_PLAN_REQUIRED without a live family plan and succeeds with a manual family grant')`
78. `it('family_members insert (invite accept, child add) raises FAMILY_PLAN_REQUIRED when the group is free and succeeds when the representative has a family plan')`
79. `it('existing members stay when the plan expires; new members are refused')`
105. `it('accept_child_promotion succeeds in a free group (an UPDATE of the existing child row, not gated) and leaves the number of members unchanged')` (S19・Q-4)

`tests/integration/security/plan-store-products-rls.test.ts`:
80. `it('anon and authenticated can read public plan products, only super_admin can write, service_role can write')`
114. `it('plan_store_products accepts an offered = false row for the same plan, store and interval as the offered row, rejects a second offered row (idx_plan_store_products_offered) and rejects the same (store, product_id) for two plans')` (S28)

`tests/integration/security/account-export-scope.test.ts` (延長): `iap_synced_at` を出力しない列に。

### 14.3 E2E (手動。`tests/e2e/.manual/`。CI では流さない)

81. `tests/e2e/.manual/iap-webhook.spec.ts`: 本番の受け口 (RevenueCat に登録した 1 つの Webhook) へ RevenueCat の Dashboard の Test event (`TEST` → 200 `ignored`) と、TestFlight の sandbox の購入のイベントを送り、`personal_subscriptions` (`iap_is_sandbox = true`) と `revenuecat_webhook_events` を読み取りで確かめる (§17.4)。
82. 実機 (整合ゲート): §17.4。

### 14.4 シナリオ ⇄ テスト (§3.2 の 42 本がどのテストで守られるか)

| シナリオ | テスト (番号は §14.1〜§14.3) |
|---|---|
| S1 iOS の新規購入 (無料体験) | 17・32・51・54・55・66・83・82 (実機) |
| S2 Android の年額 (家族 Basic) | 17・66・77・82 (実機) |
| S3 Web で買った人がアプリを開く | 35・54・93・94 |
| S4 アプリで買った人が Web を開く | 34・68・87 |
| S5 ストアでの解約の予約 → 期限切れ | 5・69 |
| S6 更新 | 4・67 |
| S7 支払いの問題 (猶予 → 期限切れ) | 4・69・85・109 |
| S8 返金 | 4 |
| S9 購入の復元 | 32・54 |
| S10 別の利用者が復元 (TRANSFER) | 3・6・19・21 |
| S11 順序の入れ替わり・重複・再送 | 27・67・73 |
| S12 Webhook が届かない | 8・24・33・131 |
| S13 二重購読の防止と案内 (Web とストア) | 22・28・32・68・96 |
| S14 鍵が無い | 16・26・31・32 |
| S15 ストアの商品が未登録 | 10・18・56・113 |
| S16 Stripe の Price が無い間の料金ページ | 44・46・116 |
| S17 無料の利用者の線引き | 41・42・49・57・74・77・89・91・92・97・98・99・101・102・103・107・108・142 |
| S18 有料の利用者の線引き | 74・75・76 |
| S19 家族プランが終わったグループ | 69・78・79・105 |
| S20 手動付与との共存 | 63・68・77 |
| S21 規約の改定の再同意 | 118・§16.1 の `middleware-legal-consent-api` の行 (許可リストは変えない。全 route を走査する既存の it が新しい 2 本の 403 も見る)・115 (版を上げた本文) |
| S22 凍結中のストアの契約 | 88・117・118・§16.1 の `middleware-frozen-allowed-api` の行 (`FROZEN_ALLOWED_API_PATHS` の `toEqual` が変わらない)・`middleware-legal-consent-api` の凍結中の全 route の it |
| S23 無料体験の 1 人 1 回 | 70・83・84・86・110 |
| S24 App Store の審査 (sandbox の購入) | 29・90・81 (手動)・82 (実機) |
| S25 二重購読の防止と案内 (ストア同士) | 68・32・96・134 (Google Play の 2 つは置き換えない) |
| S26 組織のメンバーの上限 | 106・107・75・138・139 |
| S27 無料の利用者が 1 週間の献立を作る (料理画像を作らない) | 111・112・99・140・144 (積むのは主菜の 1 本だけ) |
| S28 対応の無い古い商品の購入の履歴 | 18・113・114・109 |
| S29 無料体験の表示がストアの判定に従う | 110・51・55 |
| S30 RevenueCat の API の失敗 | 121・120・122・24・96 |
| S31 カタログの不正な問い合わせ | 119・31 |
| S32 月額から年額への切り替え | 7・17・71・86 |
| S33 解約の予約の取り消し | 5・85・124 |
| S34 家族プランをストアで買う (月額) | 125・126・66・76 |
| S35 アプリで買った人がアプリから退会する | 129・127・128・130・72・82 (実機) |
| S36 App Store で上位のプランに変える (体験中を含む) | 134・135・136・137・82 (実機。sandbox の購読の管理で変える) |
| S37 有料の利用者が 1 週間の献立を作る (主菜だけの料理画像) | 143・144・148・149・153・154・155・82 (実機。料理の画面で副菜に枠が出ない) |
| S38 主菜の無い献立 | 143・145・148・150 |
| S39 有料の利用者が料理を手で保存・編集する | 143・144・147・150・151 |
| S40 主菜でない料理の画像が欲しい (献立の編集の「AIで画像生成」) | 42・74・101・`tests/meal-cover-ownership.test.ts` の既存の it (料理が 2 品以上の献立に付けた画像はカバーだけ。§16.1 の行) |
| S41 本冊の前に作られた料理画像 | 146・147・152 |
| S42 主菜を消す・主菜の役割を外す (主菜の引き継ぎ) | 156・157・158 |

§12 の発注者の作業 (App Store の Paid Applications Agreement・税と銀行の登録、Google Play の内部テストのトラックへの課金のライブラリ入りのビルドの提出、ストアの商品の作成、ストアのメタデータ (§17.5)) は運用の手順で、本冊のコードの振る舞いではない。シナリオとテストは持たず、§17.4 の受け入れの確認 (iOS の TestFlight・Android の内部テストの購入・ストアのメタデータ) で確かめる。

---

## 15. 段分け・触るファイルの母集合・新設一覧

### 15.1 段分け (1 つの B 型 WF の中で段ごとに 2 枚レビュー。段 A・段 C・段 E はそれぞれ単独でマージしてよい)

| 段 | 内容 | ファイル | テスト |
|---|---|---|---|
| A: DB 層 | migration + rollback (§6。`ai_plan_feature_daily_cap` と `plan_store_products` の主キー `(store, product_id)`・`offered` を含む)、`database.types.ts` の再生成 (2 本)、SQL の契約テスト、結合テスト、家族の結合テストの前提 (家族プランの手動付与) | §6・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`src/lib/account-export-tables.ts` (`iap_synced_at` の `omit`)・§16.1 の結合テストの追随・`create_family_group` の最後の定義を固定する 2 本 (`tests/parental-consent-migration-contract.test.ts`・`tests/rpc-profile-name-placeholder-migration-contract.test.ts`。§16.1)・`consume_ai_usage_capped_at` の最後の定義の委譲の位置を固定する `tests/ai-usage-contract.test.ts` の `:707-720` の it (§16.1)・使い方ページの撮影の種まき (`scripts/guide-screenshots/seed.ts` の家族の代表者に家族プランの手動付与。§16.1) | 60〜80・83・84・86・90・91・100・105〜107・109・112・114・123・124・126・137 |
| B: サーバ層 | `iap-core.ts`・`revenuecat-gateway.ts`・`iap-repository.ts`・`iap-service.ts`・`http.ts` の差分・`core.ts` の差分・`repository.ts` の差分 (`SUBSCRIPTION_VIEW_COLUMNS`・`findPlanFeatures`・`BillingRpcError` の code)・`service.ts` の差分・`public-plans.ts` (`listPublicPlans`)・`packages/shared/src/billing-plans.ts` と `index.ts` の 1 行・`verify.ts`・`env.ts`・`.env.example`・`ENV_SETUP.md`・route 3 本・`subscription/route.ts` の差分・family の route 3 本の 402・`membership-errors.ts`・`_shared/ai-daily-limit.ts` (全文) と Web の `daily-limit-client.ts`・モバイルの `aiDailyLimitErrorOf`・`consultation-action-executor.ts` (`dailyLimitResult` の code と見送りの理由と、update_meal の結果の `aiSkipped` を `aiDailyLimitSkippedField(imageUsage)` にする 1 行 (planLocked で `aiSkipped` を付けない。テスト 98 の AI 相談の入口))・`src/app/pricing/page.tsx` の `listPurchasablePlans` → `listPublicPlans` の import と呼び出しの 1 行と冒頭の注・`PricingPageView.tsx` の props の注 (段 C の書き直しの前に型検査を通すため)・行の失敗の文の読み手のコメント 3 本 (§8.8)・`_shared/meal-image.ts` (見送りの理由・処理の門の答え・自動の料理画像を主菜の 1 品に絞る `autoImageDishIndexOf` と `reconcileDishImages` の最後の絞り込み (§8.8 の (b))・主菜の引き継ぎ `autoImageDishHandoverIndexOf` と `reconcileDishImages` の for の直後の (b0)・`mealCoverRepresentsDish`。§8.8) と `lib/meal-image.ts` の再 export・積み直しの道具 `scripts/lib/meal-image-backfill.ts` (`not_auto_image_dish`)・`save-meal.ts` の作り直しの注 (コメントだけ)・Web の献立の画面 `src/app/(main)/menus/weekly/page.tsx` (料理の画面のカバーの出し方の 1 行と import。§10.3)・料理画像の種と画面のテストの追随 (`tests/meal-cover-ownership.test.ts`・`tests/save-meal-photo-preserve.test.ts`・`tests/process-meal-image-jobs-write-race.test.ts`・`tests/meal-image-backfill.test.ts`・`tests/meal-image-backfill-trigger.test.ts`・`tests/integration/rls/meal-image-backfill.test.ts`・`tests/meal-image-skip.test.ts`・`tests/meal-image-skip-routes.test.ts`。§16.1 の母集合の作り方 17)・`process-meal-image-jobs/index.ts` (プランの門。§8.8) とハンドラを本物で動かすテスト (`tests/process-meal-image-jobs-worker-edges.test.ts` の偽の client の `rpc`。§16.1)・`admin_audit_logs` の書き手の一覧のテスト (`tests/admin-audit-logs-insert-policy-migration-contract.test.ts`。§16.1)・料理の保存の 4 本の route の見送りの理由・`RecipeModal.tsx` の文・メンテナンスの見張りのテスト 2 本 (`maintenance-mode.test.ts`・`middleware-maintenance.test.ts`。`maintenance-mode.ts` と `middleware.ts` は変えない。§9.1)・`tests/api/billing-routes.test.ts` (偽物と AI の印の棚卸し。§16.1)・`EXEMPT_ROUTES` と `ENFORCED_EDGE` の注 (`tests/helpers/ai-consent-enforced-paths.ts`)・`null-character-routes` の表・送信先の棚卸しの `NON_AI_HOSTS` (`tests/ai-consent-provider-inventory.test.ts`) | §8・§9 | 1〜43, 49, 50, 85, 89, 92〜95, 97〜99, 101, 102, 108, 111, 113, 117〜122, 125, 131〜136, 138〜159。81 (手動の E2E。段 B のマージ後、§17.4 の整合ゲートで流す) |
| C: Web の画面と公開の面 | `/pricing` (`page.tsx`・`PricingPageView.tsx`)・`/legal` の販売の行・`/faq`・`landing-copy.ts`・`PricingSection.tsx` (冒頭の注)・`marketing.css` (料金の節)・`public-pages.ts` (`SITE_DESCRIPTION`)・`/account/billing`・`/frozen/billing`・退会の文・究極モードの錠 (`V4GenerateModal`・`useBillingSummary`)・`public-claims-guard`・`b10` の E2E・`landing-page-1867`・クーポンの画面の基準の価格・プランの作成の画面の有料 3 プランのひな形・退会の 4 つの入口の文 (`settings/page.tsx`・`src/components/account/AccountSelfServicePanel.tsx`・`LegalConsentForm.tsx`・アプリの `app/settings/account.tsx`。§10.4) | §10.1〜§10.5 | 44〜46, 48, 87, 88, 103, 104, 116, 127〜130 |
| D: モバイル | 最初に依存の追加 (`apps/mobile/package.json` の 2 行) と `package-lock.json` の作り直し (offload の行き先で npm が作る差分だけ。手で書かない。差分の期待と、依存の宣言か lock を読む番兵 6 本の確認は §8.10 の「依存の追加と `package-lock.json` の作り直し」の 1〜4)、続けて `purchases.ts`・`iap-catalog.ts`・`billing-api.ts`・`plan-screen.ts`・`app/settings/plan.tsx`・設定タブの行・`AuthProvider`・`signOut.ts`・`UltimateModeToggle` と `V4GenerateModal` の錠・`env.example`・jest の mock と `moduleNameMapper`・`no-web-purchase-links.test.ts` のコメント | §8.10・§10.6 | 51〜59, 96, 110 (と §16.1 の母集合の作り方 13 の番兵 6 本が緑) |
| E: 規約とポリシーの条文 | `src/lib/legal/terms-text.ts`・`privacy-text.ts` の差分・`tests/legal-claims-1901.ts` (主張の表)・`tests/legal-text-1901.test.ts` (T-33・T-34)・`packages/shared/src/legal-versions.ts` の版・`docs/legal/archive/v2026.2/` | §11 | 115 (と cross/20 のテストの全部が緑) |

§14 の番号のうち、47 は欠番 (§14.1)、82 (実機) はどの段にも入れない (段の外。本番の準備 (§17.1〜§17.3) の後に、§17.4 の受け入れの確認 (整合ゲート) で行う。81 は段 B の行のとおり)。段 B は段 A のマージ後 (型の再生成済み)。段 C と段 D は段 B のマージ後 (段 C と段 D は並行できる。段 C が触るアプリのファイルは退会の確認 (`apps/mobile/app/settings/account.tsx` とそのテスト) だけで、`@homegohan/shared` の定数しか使わず、段 D のファイルと重ならない)。段 E は本冊の段 B のマージの後 (cross/20 (#1901) の実装は origin/main `2ba5b3b3` でマージ済み。§11.0。段 C・D とは独立)。30 ファイルを超えるので段ごとにレビューを挟む。

- 段 A の本番の適用から段 B のマージまでの間は、DB が新しい `capped_feature` (`menu_generation`・`image_generation`・`meal_image_auto`) と `plan_locked` を返すが、古い `parseConsumeAiUsageResult` はそれを読まない。この間も門 (止めること) は効き、止めたときの文が 1 日の上限の文 (回数は機能の上限の値) になり、無料の料理の保存では `skipped_ai_limit` と `aiSkipped` が付く。利用者はゼロなので受け入れ、段 B は段 A の直後にマージする。段 B の `supabase/functions/_shared/**` の変更は、main へのマージで Edge Function のデプロイ (`.github/workflows/deploy-supabase-functions.yml` の `paths: supabase/functions/**`) が走って Edge の文も新しくなる。
- 依存を変える段は段 D だけ (変えるのは `apps/mobile/package.json` と `package-lock.json`。ルートの `package.json` は変えず、段 A・B・C・E は依存を変えない。RevenueCat の SDK をサーバに入れない)。段 D の `package-lock.json` は、段 D の作業の間に main の lock が変わったら (Dependabot の PR ほか。§16.3)、衝突を手で解かず、マージの直前の main の lock を土台に §8.10 の「依存の追加と `package-lock.json` の作り直し」の 2〜4 をやり直す。段 D の PR は dependency review と npm audit の緑を待ってからマージする (同じ 5)。

### 15.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking。例外は §16.1 冒頭の「母集合の作り方」で新たに出た、同じ型の行がそのまま当てはまるファイルだけ)

新設:
- `supabase/migrations/<番号>_billing_paid_plans_iap.sql`・`supabase/rollbacks/<番号>_billing_paid_plans_iap.down.sql`
- `src/lib/billing/iap-core.ts`・`revenuecat-gateway.ts`・`iap-repository.ts`・`iap-service.ts`
- `packages/shared/src/billing-plans.ts`
- `src/app/api/webhooks/revenuecat/route.ts`・`src/app/api/billing/iap/catalog/route.ts`・`src/app/api/billing/iap/sync/route.ts`
- `src/hooks/useBillingSummary.ts`
- テストの道具: `tests/integration/helpers/family-plan.ts` (`grantFamilyPlan`。§16.1 の家族の結合テストの行)・`tests/e2e/helpers/billing-plan.ts` (`grantManualPlanForE2e`。§16.1 の E2E の行)
- `apps/mobile/src/lib/purchases.ts`・`iap-catalog.ts`・`billing-api.ts`・`plan-screen.ts`・`apps/mobile/app/settings/plan.tsx`・`apps/mobile/__mocks__/react-native-purchases.js`
- テスト: `tests/billing-iap-core.test.ts`・`tests/billing-iap-service.test.ts`・`tests/billing-revenuecat-gateway.test.ts`・`tests/webhooks-revenuecat-route.test.ts`・`tests/api/billing-iap-routes.test.ts`・`tests/billing-plan-catalog.test.ts`・`tests/api/family-plan-required.test.ts`・`tests/billing-paid-plans-migration-contract.test.ts`・`tests/integration/rls/billing-apply-store-subscription-rpc.test.ts`・`tests/integration/rls/billing-revenuecat-events-claim-rpc.test.ts`・`tests/integration/rls/ai-plan-feature-caps-rpc.test.ts`・`tests/integration/security/family-plan-gate.test.ts`・`tests/integration/security/plan-store-products-rls.test.ts`・`tests/e2e/.manual/iap-webhook.spec.ts`・`apps/mobile/__tests__/lib/iap-catalog.test.ts`・`purchases.test.ts`・`billing-api.test.ts`・`apps/mobile/__tests__/settings/plan-entry.test.tsx`・`plan-screen.test.tsx`・`tests/billing-status-lines-parity.test.ts`・`tests/billing-summary-wire.test.ts`・`src/__tests__/app/menus/weekly/recipe-modal-plan-skipped.test.tsx`・`tests/meal-image-plan-gate-source.test.ts`・`tests/billing-repository-plan-features.test.ts`

変更:
- `src/lib/billing/core.ts`・`repository.ts`・`service.ts`・`http.ts`・`public-plans.ts`・`manual-grant.ts`・`manual-grant-repository.ts`・`src/components/admin/ManualPlanGrantSection.tsx`
- `src/lib/webhook/verify.ts`・`src/__tests__/lib/webhook/verify.test.ts`
- `src/lib/env.ts`・`.env.example`・`ENV_SETUP.md`・`apps/mobile/env.example`
- `src/app/api/billing/subscription/route.ts`
- `src/app/api/family/groups/route.ts`・`invites/[id]/accept/route.ts`・`members/child/route.ts`・`src/lib/errors/membership-errors.ts`
- `supabase/functions/_shared/ai-daily-limit.ts`・`src/lib/ai/daily-limit-client.ts`・`apps/mobile/src/lib/ai-daily-limit.ts`・`src/lib/ai/consultation-action-executor.ts` (`dailyLimitResult` の code と、料理画像の見送りの理由の 1 行と、update_meal の結果の `aiSkipped` を `aiDailyLimitSkippedField(imageUsage)` にする 1 行)
- コメントと it 名だけ (§16.1 の「free = 10 の文」の行): `supabase/functions/README.md` (「AI 利用回数の上限と記録」の節の最初の段落だけ)・`src/lib/plan/entitlements.ts`・`supabase/functions/_shared/ai-usage-core.ts`・`tests/helpers/ai-usage-mock.ts`・`tests/meal-image-route-contracts.test.ts` (ほかの該当のファイルは別の行で変更の一覧に入っている)
- AI の上限の結合テスト (§16.1 の `ai-usage-rpc` の行と「free = 10 の文」の行): `tests/integration/rls/ai-usage-rpc.test.ts`・`tests/integration/rls/ai-daily-limit-rpc.test.ts`・`tests/integration/rls/ai-usage-feature-cap-rpc.test.ts`
- 行の失敗の文の読み手のコメントだけ (§8.8 の表): `src/lib/weekly-menu-request-error.ts`・`supabase/functions/_shared/stored-failure-messages.ts`・`apps/mobile/src/lib/menu-request-error.ts`
- `supabase/functions/process-meal-image-jobs/index.ts` (プランの門。§8.8)・`tests/process-meal-image-jobs-worker-edges.test.ts` (偽の client に `rpc` とテスト 140・141。§16.1)
- `tests/admin-audit-logs-insert-policy-migration-contract.test.ts` (`DIRECT_INSERT_ALLOWED` に `iap-repository.ts`。§16.1)
- `scripts/guide-screenshots/seed.ts` (家族の代表者に家族プランの手動付与。§16.1)
- `supabase/functions/_shared/meal-image.ts`・`lib/meal-image.ts` (再 export の名前)・`src/app/api/meals/route.ts`・`src/app/api/meals/[id]/route.ts`・`src/app/api/meal-plans/meals/route.ts`・`src/app/api/meal-plans/meals/[id]/route.ts` (見送りの理由の 1 行と import)・`src/app/(main)/menus/weekly/_components/modals/RecipeModal.tsx` (文)・`scripts/lib/meal-image-backfill.ts` (`not_auto_image_dish`。§8.8)・`scripts/requeue-pending-meal-images.ts` (積み直しの道具のコマンド。冒頭の注の 1 行目「料理画像を待ったまま (pending / stale) で処理するジョブが無い料理に、ジョブを積み直す (#1505)」を「料理画像を待ったまま (pending / stale) で処理するジョブが無い料理に、ジョブを積み直す (#1505)。積むのは献立の主菜 (自動の料理画像を作る 1 品) だけで、ほかの待ちの料理は積まずに対象外の理由 not_auto_image_dish で数える (billing/03 Q-16)」にする注だけ。コードは変えない: 判定は `scripts/lib/meal-image-backfill.ts` の `planDishImageJobs` で、対象外の理由ごとの数は `runMealImageBackfill` の報告をそのまま JSON で出す (`:75`) ので `not_auto_image_dish` も出る。この道具を読むテストは無い (`git grep -l requeue-pending-meal-images origin/main -- tests src` が 0 件))・`supabase/functions/_shared/save-meal.ts` (作り直しの注のコメントだけ。§8.8 の (e))・`src/app/(main)/menus/weekly/page.tsx` (料理の画面のカバーの出し方の 1 行と import。§8.8 の page.tsx の (b)・§10.3)
- 料理画像の種と画面のテスト (§16.1 の母集合の作り方 17 の行): `tests/meal-cover-ownership.test.ts`・`tests/save-meal-photo-preserve.test.ts` (テスト 149・159)・`tests/process-meal-image-jobs-write-race.test.ts`・`tests/meal-image-backfill.test.ts` (テスト 152)・`tests/meal-image-backfill-trigger.test.ts`・`tests/integration/rls/meal-image-backfill.test.ts` (`tests/meal-image-skip.test.ts`・`tests/meal-image-skip-routes.test.ts`・`tests/process-meal-image-jobs-worker-edges.test.ts` は下と上の行)
- `packages/shared/src/index.ts` (`export * from './billing-plans';` の 1 行)
- `src/__tests__/lib/maintenance-mode.test.ts` (テスト 132)・`lib/supabase/__tests__/middleware-maintenance.test.ts` (テスト 133)。`src/lib/maintenance-mode.ts` と `lib/supabase/middleware.ts` は変えない (§9.1)
- `tests/helpers/ai-consent-enforced-paths.ts` (`EXEMPT_ROUTES` に 3 行・`ENFORCED_EDGE['process-meal-image-jobs'].consent` の文)・`src/__tests__/api/null-character-routes.test.ts` (`EXCLUDED` に 1 行)・`tests/ai-consent-provider-inventory.test.ts` (`NON_AI_HOSTS` に 3 行)
- `src/app/pricing/page.tsx`・`PricingPageView.tsx`・`src/app/legal/page.tsx` (販売の行と注・最終更新日)・`src/app/faq/page.tsx`・`src/components/marketing/landing-copy.ts`・`src/components/marketing/sections/PricingSection.tsx` (冒頭のコメントだけ)・`src/components/marketing/marketing.css` (料金の節)・`src/lib/seo/public-pages.ts` (`SITE_DESCRIPTION` の最後の文だけ)
- `src/app/(main)/account/billing/page.tsx`・`src/app/frozen/billing/page.tsx`・`src/app/(main)/settings/page.tsx` (退会の文)・`src/components/account/AccountSelfServicePanel.tsx` (退会の文。凍結中と同意の前の退会の共通の部品。`src/app/frozen/account/page.tsx` と `src/app/legal-consent/account/**` は変えない)・`src/app/legal-consent/LegalConsentForm.tsx` (退会の文)・`apps/mobile/app/settings/account.tsx` (退会の確認。§10.4)・`src/components/ai-assistant/V4GenerateModal.tsx`
- `tests/public-claims-guard.test.ts`・`tests/landing-page-1867.test.ts` (U-24・U-15・U-10 とテスト 104)・`tests/landing-pricing-doc-1911.test.ts` (it 名の 1 か所だけ。§16.1)・`tests/e2e/b10-unexplored-areas.spec.ts`・`tests/faq-guide-wording-1859.test.ts` (期待の名前が増えるときだけ)・`src/__tests__/app/account/billing-pages.test.ts`・`src/__tests__/app/frozen-billing-page.test.tsx`・`tests/billing-core.test.ts`・`tests/billing-service.test.ts`・`tests/api/billing-routes.test.ts`・`tests/billing-manual-grant*.test.ts`・`tests/ai-daily-limit-core.test.ts`・`tests/ai-daily-limit-client.test.tsx`・`tests/consultation-action-usage.test.ts`・`tests/meal-image-skip.test.ts`・`tests/meal-image-skip-routes.test.ts` (テスト 98)・`tests/stored-failure-messages.test.ts` (テスト 108)・`tests/billing-public-plans.test.ts` (`listPurchasablePlans` → `listPublicPlans`)・`src/__tests__/lib/plan/entitlements.test.ts`・`apps/mobile/__tests__/lib/ai-daily-limit.test.ts`
- `src/lib/account-export-tables.ts`・`tests/account-export-tables.test.ts`・`tests/integration/security/account-export-scope.test.ts`
- 退会の入口のテスト (§10.4): `src/__tests__/app/frozen-account-page.test.tsx` (テスト 128)・`tests/legal-consent-page.test.tsx` (テスト 130)・`apps/mobile/__tests__/settings/account-delete.test.tsx` (テスト 129)
- 最後の定義を固定する migration の契約テスト (§16.1): `tests/parental-consent-migration-contract.test.ts`・`tests/rpc-profile-name-placeholder-migration-contract.test.ts`・`tests/ai-usage-contract.test.ts` (`consume_ai_usage_capped_at` の `:707-720` の it)
- `src/types/database.types.ts`・`packages/shared/src/database.types.ts` (再生成)
- 家族の結合テスト (§16.1 の行。家族プランの手動付与を前提に足す)
- `apps/mobile/package.json` (`dependencies` に 2 行)・`package-lock.json` (ルート。npm workspaces の 1 つの lock。offload の行き先で npm が作る差分だけで、手で書かない。§8.10 の「依存の追加と `package-lock.json` の作り直し」)。ルートの `package.json`・`apps/mobile/app.json`・`apps/mobile/eas.json` は変えない (P19)
- `apps/mobile/jest.config.js`・`apps/mobile/app/(tabs)/settings.tsx`・`apps/mobile/src/providers/AuthProvider.tsx`・`apps/mobile/src/lib/signOut.ts`・`apps/mobile/src/components/menu/UltimateModeToggle.tsx`・`V4GenerateModal.tsx`・`apps/mobile/__tests__/app/no-web-purchase-links.test.ts` (コメントだけ)・`apps/mobile/__tests__/menus-weekly/ultimate-mode-toggle.test.tsx`・`apps/mobile/__tests__/lib/sign-out.test.ts`
- 段 E: `src/lib/legal/terms-text.ts`・`src/lib/legal/privacy-text.ts`・`tests/legal-claims-1901.ts`・`tests/legal-text-1901.test.ts`・`packages/shared/src/legal-versions.ts`・`docs/legal/archive/v2026.2/terms.md`・`docs/legal/archive/v2026.2/privacy.md` (新設。#1917 が作った `docs/legal/archive/v2026.1/` の控えと同じ形。§11.6)
- `src/app/super-admin/coupons/new/page.tsx` (粗利のプレビューの基準の価格。§16.1 の行)・`src/app/super-admin/plans/new/page.tsx` (有料 3 プランのひな形の表示名と月額。§16.1 の行)
- `src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts` (テスト 103 と冒頭の経緯のコメント)・`tests/integration/operator/super-admin-llm.test.ts`・`tests/integration/rls/coupon-apply-rpc.test.ts` (it 名とコメントだけ)
- E2E: `tests/e2e/fixtures/fresh-family.ts`・`tests/e2e/helpers/membership-family.ts`・`tests/e2e/bug-27-ultimate-mode-locked.spec.ts`・`tests/e2e/w5-3-menu-gen-adversarial.spec.ts` と、§16.1 の E2E の行の母集合 (母集合の作り方 7) で同じ直し方が当てはまる spec
- docs: `docs/design/billing/03-paid-plans-and-iap.md` (本書)。他の文書は §16.2 の行だけ (専権 PATCH)

触らない (凍結): `supabase/functions/stripe-price-sync/**`・`src/app/api/super-admin/plans/**` (`price-change`・`price-impact`・`[id]`・一覧。§7.1 の書き手の表)・`src/app/api/super-admin/llm/quotas/route.ts`・`src/app/api/health/route.ts`・`src/lib/maintenance-mode.ts`・`lib/supabase/middleware.ts` (メンテナンス中の止め方と Webhook の扱いは既定のまま。§9.1)・`src/lib/super-admin/plan-subscribers.ts`・`src/lib/super-admin/ai-daily-limits.ts`・`src/lib/super-admin/llm-schemas.ts` (運営の AI の上限の一覧と検証。§7.1 の読み手の表)・`src/lib/super-admin/flag-active-users.ts`・`supabase/functions/_shared/ai-chat-flag.ts` (`plan_key_cached` の読み手。§7.1)・`src/app/api/admin/finance/**`・`src/app/api/admin/users/**` (運営の財務と利用者詳細。§7.1 の行)・運営の画面 `src/app/admin/finance/**`・`src/app/admin/users/**`・`src/app/super-admin/plans/page.tsx`・`src/app/super-admin/plans/[id]/**` (`page.tsx`・`price-change/page.tsx`)・`src/app/super-admin/llm/quotas/page.tsx` (route の応答を描くだけ。§7.1 の読み手の表と財務の書き出しの行)・`src/app/api/feature-flags/route.ts`・`src/lib/admin/users-schemas.ts` (`plan_key_cached` の読み手と、それを名指しするコメント。§7.1)・クーポンの適用 `src/app/api/super-admin/coupons/[id]/apply/route.ts`・`src/lib/plan/coupon.ts`・DB 関数 `apply_coupon` (I 行にも記録だけ。§7.1 のクーポンの行)・`tests/account-export.test.ts` (§16.1 の行)・`src/lib/membership/exit-notification.ts`・既存の `supabase/migrations/**` と `supabase/rollbacks/**` (§16.1 の母集合の作り方 2 が当てても書き換えない)・#1911 の面 (§0.2 の対象外の欄。`src/app/company/page.tsx`・`src/lib/business-info.ts`・`src/components/legal/PhoneOnRequest.tsx`・`tests/business-info-legal-pages.test.ts`・`tests/no-pending-wording-1911.test.ts` を含む)・`save-meal.ts` のコード (注だけ変える)・`supabase/functions/_shared/meal-image-jobs.ts`・`lib/meal-image-jobs.ts` (積み方。献立の作成の料理画像は処理の門で止め、主菜の 1 品への絞り込みは `reconcileDishImages` の中で行う。§8.8)・`src/app/(main)/menus/weekly/_components/modals/ManualEditModal.tsx`・`ImageGenerateModal.tsx`・`src/app/api/ai/image/generate/route.ts` (利用者が押して作る画像。Q-18)・`supabase/functions/process-meal-image-jobs/utils.ts` (画像の書き込み)・`menu_generation` を数える入口 (F23 の route 7 本・`supabase/functions/generate-menu-v4/index.ts`・`supabase/functions/generate-menu-v5/index.ts`。判定は DB 関数と `_shared/ai-daily-limit.ts` の文で変わり、入口のコードは変えない。§8.8 の表)・献立の作成のキューとその読み手 (`src/app/api/cron/process-menu-queue/route.ts`・`src/lib/generate-menu-v4-retry.ts`・`src/lib/generate-menu-v5-retry.ts`・`src/lib/ai/ai-queue-writer.ts`・`src/lib/ai/ai-queue-tables.ts`・`src/lib/ai/weekly-menu-request-origin.ts`・`src/lib/ai/weekly-menu-request-ultimate.ts`・`src/lib/weekly-menu-request-stale.ts`・`src/lib/planned-meals-snapshot.ts`・`src/lib/request-progress-display.ts`・`src/lib/ai/consent-required.ts`・`supabase/functions/_shared/request-ownership.ts`・`src/app/api/menu-plans/add/route.ts`。数えない・プランを見ない。§7.1 のキューの処理の行)・cross/20 の文面モジュールのうち §11 の差分の外 (`legal-text.ts`・`index.ts`・`LegalDocumentBody.tsx`・`src/app/terms/page.tsx`・`src/app/privacy/page.tsx`)・`supabase/baseline/**`・`billing_apply_stripe_subscription`・`get_effective_plan`・`guard_user_profiles_privileged(_on_insert)`・`family_groups` の DDL とトリガー・`stripe_webhook_events`・`billing_customers`・Stripe の route 7 本と Webhook・`src/lib/billing/stripe-gateway.ts`・`account-deletion.ts`・`src/app/api/family/promotions/[token]/accept/route.ts` と `accept_child_promotion` (昇格は門に当たらない。§6.6・§9.5)。

### 15.3 新設一覧 (識別子)

| 種別 | 名前 |
|---|---|
| テーブル | `public.plan_store_products`・`public.revenuecat_webhook_events`・`public.ai_plan_feature_caps` |
| 列 | `personal_subscriptions.iap_store` / `.iap_product_id` / `.iap_synced_at` / `.iap_is_sandbox`・`plan_store_products.offered` |
| 制約・索引 | `plan_store_products_pkey`・`plan_store_products_store_check`・`plan_store_products_interval_check`・`plan_store_products_product_id_not_blank`・`idx_plan_store_products_offered` (部分 UNIQUE `(plan_key, store, billing_interval) WHERE offered`)・`personal_subscriptions_iap_store_check`・`personal_subscriptions_iap_pair_check`・`idx_personal_subscriptions_iap_product`・`revenuecat_webhook_events_status_check`・`ai_plan_feature_caps_pkey`・`ai_plan_feature_caps_feature_check`・`ai_plan_feature_caps_daily_cap_nonneg` |
| RLS ポリシー | `plan_store_products_select_public`・`plan_store_products_mutate_super_admin`・`revenuecat_webhook_events_no_access` |
| トリガー | `plan_store_products_set_updated_at`・`family_members_billing_plan_gate` |
| DB 関数 | `billing_claim_revenuecat_event(text, text, jsonb, interval)`・`billing_finish_revenuecat_event(text, boolean, text)`・`billing_apply_store_subscription(jsonb, timestamptz, text)`・`billing_has_live_family_plan(uuid)`・`ai_plan_feature_daily_cap(uuid, text)`・トリガー関数 `family_members_billing_plan_gate()` |
| 既存の関数の置き換え | `consume_ai_usage_at`・`consume_ai_usage_capped_at` (§6.5)・`create_family_group` (§6.6)・`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・PROCEDURE `billing_expire_manual_subscriptions` (§6.7) |
| DB の戻り値の項目 | `consume_ai_usage*` の `plan_locked` |
| DB の業務エラー | `BILL_UNKNOWN_IAP_STATUS`・`FAMILY_PLAN_REQUIRED` |
| 監査 action_type | `system.revenuecat.event_failed` (`target_type` の値 `revenuecat_event`)。写像は核の `system.billing.subscription_created` / `subscription_status_changed` を使う |
| route | `POST /api/webhooks/revenuecat`・`GET /api/billing/iap/catalog`・`POST /api/billing/iap/sync` |
| ページ (Web) | 無し (既存の変更だけ) |
| ページ (モバイル) | `/settings/plan` (`apps/mobile/app/settings/plan.tsx`) |
| 料理画像の見送りの値 | `MealImageSkipReason` の `'plan'`・`image_error` の値 `'skipped_plan'`・積み直しの道具の `MealImageBackfillSkipReason` の `'not_auto_image_dish'` (`scripts/lib/meal-image-backfill.ts`。§8.8) |
| TS モジュール | `src/lib/billing/{iap-core,revenuecat-gateway,iap-repository,iap-service}.ts`・`packages/shared/src/billing-plans.ts`・`src/hooks/useBillingSummary.ts`・`apps/mobile/src/lib/{purchases,iap-catalog,billing-api,plan-screen}.ts` |
| TS の export (iap-core) | §8.1 の `export` のとおり (数は §8.1 が正。ストアの表示名と管理のページは `billing-plans.ts`) |
| TS の export (ほか) | `verify.ts`: `verifyRevenueCatSignature`・`verifyRevenueCatWebhook` / `core.ts`: `PublicPlan`・`PlanFeatures`・`EMPTY_PLAN_FEATURES` / `public-plans.ts`: `listPublicPlans` (`listPurchasablePlans` を置き換え) / `http.ts`: `iapErrorResponse` / `iap-service.ts`: `IapDeps`・`syncStoreSubscriber`・`handleRevenueCatEvent`・`recordRevenueCatEventFailure`・`lazyResyncStoreSubscription`・`RevenueCatEventOutcome` / `revenuecat-gateway.ts`: `createRevenueCatGateway` / `iap-repository.ts`: `createIapRepository` / `packages/shared/src/billing-plans.ts`: `PURCHASE_STORES`・`PurchaseStore`・`isPurchaseStore`・`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL`・`PAID_PLAN_KEYS`・`PaidPlanKey`・`PlanCatalogEntry`・`PLAN_AI_DAILY_LIMITS`・`PLAN_ULTIMATE_DAILY_CAPS`・`PLAN_MENU_GENERATION_DAILY_CAPS`・`PLAN_TRIAL_DAYS`・`FAMILY_PLAN_MAX_MEMBERS`・`PLAN_CATALOG`・`FREE_PLAN_FEATURES`・`FREE_PLAN_AI_LIMIT_NOTE`・`PAID_PLAN_SUMMARY`・`formatJpy`・`planCatalogPriceText`・`FREE_PLAN_FAQ_ANSWER`・`PAID_PLANS_FAQ_ANSWER`・`FREE_PLAN_DISPLAY_NAME`・`planDisplayName`・`SUBSCRIPTION_STATUSES_WIRE`・`SubscriptionStatusWire`・`BILLING_SOURCES_WIRE`・`BillingSourceWire`・`BILLING_INTERVALS_WIRE`・`BillingIntervalWire`・`PlanFeaturesWire`・`BillingSummaryWire`・`parseBillingSummaryWire`・`SUBSCRIPTION_STATUS_TEXT_WIRE`・`CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE`・`formatBillingDateWire`・`subscriptionStatusLines`・`STORE_SUBSCRIPTION_DELETION_NOTICE` / `ai-daily-limit.ts` (新しい名前): `AI_FEATURE_NOT_IN_PLAN_CODE`・`AI_FEATURE_NOT_IN_PLAN_STATUS`・`AI_PLAN_CAPPED_FEATURES`・`AiPlanCappedFeature`・`AI_PLAN_CAPPED_FEATURE_LABELS`・`aiFeatureDailyLimitMessage`・`aiFeatureNotInPlanMessage`・`AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE`・`AiFeatureNotInPlanBody`・`AiUsageDeniedBody`・`AiUsageDenialReason`・`aiDailyLimitMessageOfStatusAndBody` / `_shared/meal-image.ts`: `mealImageSkipReasonOf`・`isMealImagePlanSkippedError`・`mealImageJobPlanDecision`・`MealImageJobPlanDecision`・`AUTO_IMAGE_DISH_ROLES`・`AUTO_IMAGE_FALLBACK_DISH_INDEX`・`autoImageDishIndexOf`・`mealCoverRepresentsDish`・`autoImageDishHandoverIndexOf` (export しない: `SINGLE_DISH_MEAL_DISH_COUNT`・`withoutAutoDishImage`。§8.8) / `membership-errors.ts`: `MembershipErrorCode.FAMILY_PLAN_REQUIRED` / `src/hooks/useBillingSummary.ts`: `BILLING_SUBSCRIPTION_API_PATH`・`useBillingSummary` / モバイル `purchases.ts`: `isPurchasesAvailable`・`identifyPurchases`・`resetPurchasesOnSignOut`・`fetchOfferings`・`fetchTrialEligibility`・`purchase`・`restore`・`currentCustomerInfo`・`PurchaseOutcome` / `iap-catalog.ts`: `CatalogPlanLike`・`IntroPriceLike`・`PackageLike`・`TrialEligibility`・`StoreTrial`・`PurchasablePlanCard`・`storeTrialOf`・`matchCatalogWithPackages`・`renewalText`・`parseIapCatalogPlans` / `billing-api.ts`: `BILLING_SUBSCRIPTION_API_PATH`・`IAP_CATALOG_API_PATH`・`IAP_SYNC_API_PATH`・`BILLING_SUMMARY_LOAD_FAILED_MESSAGE`・`BILLING_PURCHASE_FAILED_MESSAGE`・`BillingSummaryShapeError`・`fetchBillingSummary`・`fetchIapCatalog`・`syncIapPurchases`・`billingErrorMessageOf` / `plan-screen.ts`: `PLAN_SCREEN_PATH` |
| 環境変数 | `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET` (Web。一覧に追加)・`EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY` (モバイル) |
| エラーコード | §13.1 の [NEW] 7 つ |
| 依存 (モバイル) | `react-native-purchases` `10.14.0`・`expo-dev-client` `~58.0.14` (`apps/mobile/package.json` の `dependencies`。`package-lock.json` のルートの `node_modules/` に増えるキーは §8.10 の「依存の追加と `package-lock.json` の作り直し」の 3 の 8 つ。P19) |
| 画面の定数 | `PLAN_SCREEN_PATH = "/settings/plan"`・`apps/mobile/app/settings/account.tsx` の `ACCOUNT_DELETE_CONFIRM_MESSAGE`・`STORE_SUBSCRIPTION_MANAGE_BUTTON_LABEL`・`DEVICE_PURCHASE_STORE` (export しない。§10.4) |
| テストの道具 | `tests/integration/helpers/family-plan.ts` の `grantFamilyPlan`・`tests/e2e/helpers/billing-plan.ts` の `grantManualPlanForE2e` |
| テストの定数 | `tests/parental-consent-migration-contract.test.ts` の `LATER_REDEFINER_SUFFIXES` (§16.1) |
| 運営の画面の定数 | `src/app/super-admin/coupons/new/page.tsx` の `COUPON_PREVIEW_PLAN_KEY` (粗利のプレビューの基準のプラン)・`src/app/super-admin/plans/new/page.tsx` の `paidPlanTemplate` (export しない。有料 3 プランのひな形) |

---

## 16. 追随表

### 16.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語 = 本冊が足す・変える名前。段 = §15.1。

**母集合の作り方** (実装の各段の最初に origin/main で流し直す。表に無いファイルが出たら、同じ型の行の「直し方」がそのまま当てはまるときに限り直してよい。当てはまらなければ報告する):
1. 本冊の新しい route・ページと、本冊が import を足す既存の route が AI の印に届くか: `tests/helpers/ai-reach.ts` の `reachesAi` を当てる (`@/lib/env` を import するもの = `revenuecat-gateway.ts`・`verify.ts` を import する route。既存の route では `src/app/api/billing/subscription/route.ts` が届くようになる)。既存の route が届くようになるときは、その route を「届かない」と固定するテストも対象: `git grep -n "reachesAi(" origin/main -- tests src/__tests__` で当たる it のうち、その route のパスを書くもの (2026-10-19 の origin/main では `tests/api/billing-routes.test.ts:260-262` の 1 か所。下の行)。
2. 本冊が変える表への書き込み: `git grep -n -E "from\(['\"](personal_subscriptions|family_members|ai_daily_limits|subscription_plans)['\"]\)" origin/main -- tests src scripts` と `git grep -n -i -E "insert into (public\.)?(family_members|personal_subscriptions)" origin/main -- tests supabase scripts` (`scripts` は開発の道具の種まき。2026-10-19 の origin/main では `scripts/guide-screenshots/seed.ts` の `family_members` の 3 つの INSERT だけ。下の行)。
3. 本冊が変える既存の関数・型・定数を名指しするテスト: `git grep -n -E "summarizeSubscription|SUBSCRIPTION_VIEW_COLUMNS|BillingSummary|BILLING_ERROR_MESSAGES|EXT_STRIPE_NOT_CONFIGURED|create_family_group|consume_ai_usage_capped|AI_DAILY_CAPPED_FEATURES|AI_CAPPED_FEATURES|parseConsumeAiUsageResult|aiDailyLimitPayload|aiDailyLimitMessageOfDenied|aiDailyLimitSkippedField|AiDailyLimitBody|MEAL_IMAGE_SKIPPED_ERRORS|MealImageSkipReason|LEGAL_DOCUMENTS|listPurchasablePlans|AI_DAILY_LIMIT_NOTE|LEGAL_SALE_ROW_LABELS|PlanCardSchema|AI_PLAN_CAPPED|ai_plan_feature|plan_store_products|PRIVACY_PROCESSORS|LEGAL_CLAIMS|LEGAL_TEXT_PAID_TERMS|PRIVACY_DATA_EXCLUDED" origin/main -- tests src/__tests__ lib/supabase/__tests__ apps/mobile/__tests__ packages/shared/src` (cross/20 の実装のテストは、段 E の前に main で流し直す)。
4. 公開の面の文を名指しするもの: `git grep -n -E "¥980|980円|9,800円|現在は無料|いまは無料|すべて無料|現在、料金|有料プラン" origin/main -- src apps packages tests ':!**/node_modules/**'` (#1911 の後の main。「準備中」「販売開始前」は #1911 が取り除き、`tests/no-pending-wording-1911.test.ts` (F21) が見張る)。旧案の価格の数字そのもの: `git grep -n -w -E "980|1480|2480|9800|14800|24800" origin/main -- src apps packages lib supabase/functions scripts` (テスト・型の生成物を除く。2026-10-19 の origin/main では `src/app/super-admin/coupons/new/page.tsx` と `src/app/super-admin/plans/new/page.tsx` の 2 本 (下の 2 行)。同じ grep が当てる `org_standard` の 980 と Issue 番号の `#1480` は本冊の価格ではないので変えない)。
5. 表の列の一覧を持つ偽の client: `git grep -n -E "SCHEMA_COLUMNS|KNOWN_COLUMNS|ALLOWED_COLUMNS" origin/main -- tests src`。
6. docs の番兵: `git grep -n -E "docs/design/billing|BILLING_AUDIT_ACTIONS|REMOVED_MOBILE_SCREENS" origin/main -- tests`。あわせて、本冊が §16.2 で同じ PR に直す設計書 (`docs/design/marketing/01-landing-site.md`) を読む番兵: `git grep -l -E "01-landing-site|docs/design/marketing" origin/main -- tests src/__tests__ apps/mobile/__tests__`。2026-10-21 の origin/main `359a16f9` では 7 本が出て、当たるのは `tests/landing-pricing-doc-1911.test.ts` (料金のカードの数と主張 `free-now` の根拠の行)・`tests/landing-page-1867.test.ts`・`tests/public-claims-guard.test.ts` の 3 本 (どれも下の行)。当たらないもの: `tests/landing-axe-states-doc-1867.test.ts` (§16.3 の E-20 の行の状態の数)・`tests/guide-screenshots-zoom-clip-1867.test.ts` (撮影の切り抜き)・`tests/e2e-landing-suite.test.ts` と `tests/e2e/landing-page.spec.ts` (e2e の門と画面。料金の章の文は `LANDING_COPY` から読む) で、本冊が変える marketing/01 の行を読まない。
7. E2E (本物のサーバに届く通信。上の 2 の `from(...)` は REST の直接の通信に当たらない): `git grep -l -E "rest/v1/family_(groups|members)|api/family/groups|api/ai/menu/(weekly/request|v4/generate|v5/generate|day/regenerate|meal/generate|meal/regenerate)|api/ai/nutrition-analysis|api/ai/consultation|api/ai/image/generate|ultimate-mode-toggle" origin/main -- tests/e2e` (`menu_generation` を数える入口の全部 (F23) と、料理画像の作成・究極モード・家族)。当たった spec のうち、その API を `page.route` で差し替えていないものが対象 (差し替えていれば本冊の判定に届かない)。対象の spec は、1 人の利用者が 1 日に数える AI の回数 (共有の利用者 (`fixtures/auth` の `login`) は同じ日に流す spec の合計) が、無料の 1 日の合計 3 回 (Q-2) か献立の作成の 3 回 (Q-3) を超えうるかを数え、超えうる test はテストごとの利用者 (`fixtures/fresh-user` か `apiUserTest`) にして最初に有料プランを手動付与する (下の `w5-3` の行と同じ直し方。共有の利用者には付与しない (ほかの spec の無料の前提を変えないため))。
8. free の 1 日の上限 (10 回) と「全員が無料」をコメント・it 名・describe 名に書いたもの: `git grep -n -E "上限 ?10 ?回|1 日 ?10 ?回|free ?(は|=) ?(1 日 )?10|全員が free" origin/main -- src lib supabase/functions tests apps packages` (下の「free = 10 の文」の行)。
9. 本冊が作り直す既存の関数の「最後の定義」を固定する migration の契約テスト: `git grep -l -E "(definers|definitions)\[(definers|definitions)\.length - [0-9]+\]|最後に定義|最後の定義" origin/main -- tests` で出たファイルのうち、本冊が作り直す 6 本 (`create_family_group`・`consume_ai_usage_at`・`consume_ai_usage_capped_at`・`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・`billing_expire_manual_subscriptions`) のどれかを名指しするもの。2026-10-19 の origin/main では 3 本: `tests/parental-consent-migration-contract.test.ts`・`tests/rpc-profile-name-placeholder-migration-contract.test.ts` (どちらも `create_family_group`。下の 2 行)・`tests/ai-usage-contract.test.ts` (`consume_ai_usage_at` の `:615-647` と `consume_ai_usage_capped_at` の `:707-720`。下の行)。当たったファイルでは、6 本のどれかの最後の定義の本文を読む it を関数ごとにすべて対象にする (1 つのファイルが複数の関数を見ることがある。本文の中の出現の順や数を固定する it は、本冊の差分 (§6.5〜§6.7) で順と数が変わるかを確かめる)。`tests/billing-manual-plan-grant-migration-contract.test.ts` は自分の migration のファイルだけを読み、`tests/accept-copies-profile-name-migration-contract.test.ts` は本冊が作り直さない `accept_family_invite`・`accept_child_promotion` だけを見るので当たらない。
10. 本冊が文を足す画面の入口の全部 (退会): `git grep -l "deleteOwnAccount(" origin/main -- src/app src/components` と `git grep -l '"/api/account/delete"' origin/main -- apps/mobile/app` (2026-10-19 の origin/main `2ba5b3b3` では 3 + 1 ファイル。`src/components/account/AccountSelfServicePanel.tsx` は凍結中と同意の前の 2 つの画面が使う。`src/lib/account-self-service.ts` は定義なので数えない。§10.4 の表。一覧が閉じていることはテスト 127 が見る)。
11. 本冊が新しく直接書く表の書き手の一覧を固定するテスト (`iap-repository.ts` の `recordIapAudit` が `admin_audit_logs` に service_role で直接 INSERT する。§8.3): `git grep -n -E "admin_audit_logs.{1,20}\.insert" origin/main -- tests` で出たもののうち、`src` を走査して書き手を固定するもの。2026-10-19 の origin/main では `tests/admin-audit-logs-insert-policy-migration-contract.test.ts` (`src` 全体。下の行) の 1 本 (`tests/admin-view-audit-1326.test.ts` は `src/app/api/admin` と `super-admin` だけを走査するので当たらない。ほかは結合テストの直接の INSERT)。
12. 本冊が中を変える Edge Function のハンドラを本物で動かすテスト (`process-meal-image-jobs` の `processJob` に門を足す。§8.8): `git grep -l "process-meal-image-jobs/index" origin/main -- tests` の 6 本のうち、ハンドラを読み込んで要求を流し、`processJob` まで届くもの。2026-10-19 の origin/main では `tests/process-meal-image-jobs-worker-edges.test.ts` の 1 本 (下の行。`tests/edge-missing-env-response.test.ts` は DB を罠にしてジョブの取得の前で止まり、`tests/edge-function-cors.test.ts` はこの関数のハンドラを読み込まず、`tests/ai-usage-contract.test.ts`・`tests/meal-cover-ownership.test.ts`・`tests/meal-image-jobs-pickup-cron-contract.test.ts` はソースを読むだけ)。
13. 段 D の依存の追加が必ず書き換える生成物 (`package-lock.json`) と、依存の宣言か lock を読む番兵 (§8.10 の「依存の追加と `package-lock.json` の作り直し」): `git grep -l -E "package-lock\.json|package\.json" origin/main -- tests apps/mobile/__tests__ src/__tests__ lib/supabase/__tests__` で出たファイルのうち、`package-lock.json` か、`apps/mobile/package.json` の依存 (`dependencies` / `devDependencies`) を読むもの。2026-10-19 の origin/main では 21 ファイルが出て、当たるのは 6 本 (下の 6 行: `tests/mobile-toolchain-contract.test.ts`・`tests/react-types-version-contract.test.ts`・`tests/zod-single-copy-1444.test.ts`・`tests/openai-sdk-v7-contract.test.ts`・`tests/posthog-not-adopted-contract.test.ts`・`tests/mobile-test-workflow-paths.test.ts`)。ほかの 15 は当たらない (`tests/types-supabase-local-1631.test.ts` は `apps/mobile/package.json` の `scripts` だけを読み、段 D は `scripts` を変えない。`tests/env-source-scan.test.ts`・`tests/next16-bundler-contract.test.ts`・`src/__tests__/config/next-config-build-info.test.ts` はルートの `package.json` の `scripts` / `version` だけ。`tests/mobile-easignore-bundle-inputs.test.ts` はワークスペースのパッケージ (`packages/*`) の `package.json` の入口だけ。`apps/mobile/__tests__/app/lucide-icons-exist.test.ts`・`apps/mobile/__tests__/home/tabs-hidden-route.test.ts`・`tests/og-image-1845.test.tsx` は入っているパッケージの中の `package.json` (`lucide-react-native`・`expo-router`・`next`) だけ。`tests/eslint-next16-config.test.ts`・`tests/e2e/fixtures/google-fonts-mock.cjs` はコメントで `package.json` を名指すだけ。`tests/metadata-public-paths-1845.test.ts` は `/../package.json` を経路の例に使うだけ。`tests/no-committed-credentials.test.ts` は git の管理の確かめに `package.json` を名指すだけ (lock の新しい行は既存の行と同じ形 (`resolved`・`integrity`) で、資格情報の形を持たない)。`tests/mobile-removed-files-references.test.ts` は lock を `EXCLUDED_BASENAMES` で外し、`apps/mobile/package.json` の 2 行は消したファイルを名指さない。`tests/security-workflow.test.ts`・`tests/local-ci-workflow-sync.test.ts` は Dependabot と CI の設定を読むだけ (後者の `EXCLUDED_JOBS` の理由は、段 D の PR が dependency review と npm audit の緑を待つことの根拠。§8.10 の 5))。
14. 本冊が足す route の本数を固定する走査 (本冊の新しい route は `src/app/api/billing/iap/catalog`・`src/app/api/billing/iap/sync`・`src/app/api/webhooks/revenuecat` の 3 本): `git grep -l -E "src/app(/api(/billing|/webhooks)?)?/?['\"]|'src', 'app'" origin/main -- tests src/__tests__ apps/mobile/__tests__` で `src/app` か `src/app/api` を走査するファイルを出し、そのうち `route.ts` の本数を等号で固定するもの (`toHaveLength(n)`・`.length).toBe(n)`) を対象にする (`toBeGreaterThanOrEqual` の下限は本数が増えても緑)。2026-10-19 の origin/main では 30 ファイルが出て、等号の数を持つのは 5 本、当たるのは `tests/api/billing-routes.test.ts:301` の 1 本 (下の行)。ほかの 4 本は route の本数を数えない (`tests/cron-failure-monitoring-contract.test.ts` は SQL の中の出現の数と cron の route の下限、`tests/e2e-api-paths.test.ts:165` (origin/main `465727de` の行。`2ba5b3b3` では `:163`) は抜き出しの関数の自己検査の 4 件、`tests/legal-text-1901.test.ts:588` は `src/lib/legal` のファイルの数 (本冊は `src/lib/legal` にファイルを足さない。§11)、`tests/seo-public-pages-1867.test.tsx:100` は middleware の `publicPaths` の宣言の数)。
15. import の許可先 (または禁止先) の一覧を持つ走査: `git grep -l "moduleSpecifier" origin/main -- tests src/__tests__ apps/mobile/__tests__` で import を構文木で読むファイルを出し、本冊が import を足すファイル (§15.2) を走査の対象に含み、許す先か禁じる先を一覧で持つものを対象にする。2026-10-19 の origin/main では 25 ファイルが出て、新しく当たるのは `tests/landing-page-1867.test.ts` の U-10 の 1 本 (`landing-copy.ts` の `@homegohan/shared`。上の landing-page-1867 の行)。すでに下の行があるもの: `tests/env-source-scan.test.ts`・`tests/supabase-service-role-client-scan.test.ts`・`tests/next15-async-request-api-scan.test.ts`・`tests/metadata-public-paths-1845.test.ts`・`tests/edge-function-cors.test.ts`・`tests/mobile-easignore-bundle-inputs.test.ts`・`tests/mobile-test-workflow-paths.test.ts`・`tests/posthog-not-adopted-contract.test.ts`。当たらないもの (見る import が本冊の足す import と重ならないか、本冊が触らないファイルだけを見る): `src/__tests__/config/status-color-tokens.test.ts` (home・pantry・health の画面の `lucide-react` と `STATUS_COLOR_TOKENS`)・`tests/admin-user-manual-plan-section-wiring.test.ts` (運営の利用者の画面。凍結)・`tests/ai-consent-entry-points.test.ts` (AI の入口の画面の `@/hooks/useAiConsent`。本冊は同意の呼び出しを変えない)・`tests/analyze-meal-photo-sugar.test.ts`・`tests/cron-secret-contract.test.ts`・`tests/cron-secret-drift-monitor-contract.test.ts`・`tests/csp-no-inline-script.test.ts` (`next/script`。本冊はインラインのスクリプトを足さない)・`tests/data-subject-requests-mobile-contract.test.ts` (`apps/mobile/app/settings/account.tsx` の名前を `arrayContaining` で見るので、§10.4 の import を足しても緑)・`tests/e2e-google-fonts-mock.test.ts`・`tests/email-resend-boundary-scan.test.ts`・`tests/email-send-throttle-contract.test.ts`・`tests/health-streaks-sandbox-1802.test.ts`・`tests/inner-html-contract.test.ts`・`tests/operator-mfa-entry-points-scan.test.ts` (`@/lib/auth/mfa/assurance` の import だけ)・`tests/rate-limit-single-implementation.test.ts` (`@upstash/ratelimit` の import だけ)・`tests/speed-insights-scrub-1179.test.ts`。
16. `plan_key_cached` を読むか、偽の `user_profiles` の行に持つテスト (§7.1 の `plan_key_cached` の行の読み手の確認と同じ語): `git grep -l plan_key_cached origin/main -- tests src/__tests__ apps/mobile/__tests__ lib/supabase/__tests__`。2026-10-19 の origin/main では 17 本 (`src/__tests__` の 3 本と `tests/` の 14 本) が出て、どれも下の行にある (`plan_key_cached` の読み手の行・運営の利用者の route と機能フラグの route の偽の行の行・核と 02 の migration の契約テストと結合テストの行・本人の書き出しの行)。本冊は `plan_key_cached` の値の種類も、空を `free` として読む規則も変えないので、新しく出たファイルも「変更なし」の行の型がそのまま当てはまる。
17. 自動の料理画像を主菜の 1 品に絞る (Q-16) ことで期待が変わるテスト (料理画像のジョブの種の数・位置・料理の画像の状態・料理の画面のカバー): `git grep -l -E "reconcileDishImages|buildDishImagePayload|saveMealToDb|planDishImageJobs|runMealImageBackfill" origin/main -- tests src/__tests__ apps/mobile/__tests__ lib/supabase/__tests__` で出たファイルから、`reconcileDishImages`・`buildDishImagePayload` を `vi.mock` / `vi.fn` で差し替えているもの (種を本物で作らない) を除き、残りのうち料理が 2 品以上の献立で種の数・位置・料理の画像の状態を期待する it を対象にする。2026-10-19 の origin/main では 24 ファイルが出て、当たるのは 8 本 (下の行: `tests/meal-cover-ownership.test.ts`・`tests/save-meal-photo-preserve.test.ts`・`tests/process-meal-image-jobs-write-race.test.ts`・`tests/meal-image-skip.test.ts`・`tests/meal-image-skip-routes.test.ts`・`tests/meal-image-backfill.test.ts`・`tests/meal-image-backfill-trigger.test.ts`・`tests/integration/rls/meal-image-backfill.test.ts`。`tests/process-meal-image-jobs-worker-edges.test.ts` は主菜 (位置 0) のジョブだけを流すので期待は変わらず、注だけ (その行))。当たらないもの: 種を差し替えるもの (`tests/ai-rate-limit-contracts.test.ts`・`tests/consultation-action-*.test.ts` の 4 本・`tests/consultation-health-goal-actions.test.ts`・`tests/consultation-meal-type-actions.test.ts`・`tests/consultation-week-menu-planner-origin-1867.test.ts`・`tests/planned-meal-nutrient-validation-routes.test.ts`・`tests/meal-image-route-contracts.test.ts`・`tests/save-meal-image-jobs.test.ts`・`tests/save-meal-sugar.test.ts`)、種を手で渡して積み方だけを見るもの (`tests/meal-image-generation-contracts.test.ts`・`tests/integration/rls/meal-image-enqueue.test.ts`)、料理が 1 品の献立だけのもの (`tests/meal-image-utils.test.ts`)。料理の画面のカバーの出し方 (`page.tsx` の 1 行) を見るテストは origin/main に無い (`git grep -n "meal.imageUrl" origin/main -- tests src/__tests__` が 0 件。テスト 153 が新しく見る)
18. AI の回数の判定の DB 関数 `consume_ai_usage` を名指しするテスト (§6.5 が戻り値に `capped_feature` の値 (`menu_generation`・`image_generation`・`meal_image_auto`) と `plan_locked` を足し、§8.8 の `parseConsumeAiUsageResult` がそれを読む): `git grep -l consume_ai_usage origin/main -- tests src/__tests__ apps/mobile/__tests__ lib/supabase/__tests__`。2026-10-21 の origin/main `48fc47bf` では 14 本が出て、10 本は下の別の行にある (`src/__tests__/lib/plan/entitlements.test.ts`・`tests/ai-daily-limit-core.test.ts`・`tests/ai-usage-edge.test.ts` (`_shared/ai-daily-limit.ts` の行)・`tests/ai-usage-contract.test.ts`・`tests/database-types-migrations-contract.test.ts`・`tests/ai-usage-photo-auto-grant.test.ts`・`tests/super-admin-llm-quotas-route.test.ts`・`tests/integration/operator/super-admin-llm.test.ts`・`tests/integration/rls/ai-daily-limit-rpc.test.ts`・`tests/integration/rls/ai-usage-feature-cap-rpc.test.ts`)。残る 4 本 (`tests/ai-consent-enforcement-routes.test.ts`・`tests/consultation-action-raw-error-text.test.ts`・`tests/consultation-pantry-expiry-jst.test.ts`・`tests/consultation-prompt-meal-type-order-1631.test.ts`) は、route を本物で呼び、偽の client の `rpc` で `consume_ai_usage` (と `consume_ai_usage_capped`) の戻り値を差し替える呼び出し側のテストで、下の「呼び出し側の偽の `consume_ai_usage`」の行 (変更なし)

| 番兵 | 反応する理由 (grep の語) | 直し方 | 段 |
|---|---|---|---|
| `tests/env-source-scan.test.ts` | `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET` を `getOptionalEnv` で読む・`.env.example` との突き合わせ・`ENV_SETUP.md` の節の番号 | `SERVER_ENV_VARS` に 2 つ (§8.7)、`.env.example` に 2 行、`ENV_SETUP.md` の `4.` の Stripe の節に RevenueCat の 2 つを足す (番号は増やさない) | B |
| `tests/check-env-script.test.ts` | 一覧の読み込み | 変更なし | B |
| `tests/database-types-migrations-contract.test.ts` | `plan_store_products`・`revenuecat_webhook_events`・`ai_plan_feature_caps`・`billing_apply_store_subscription`・`billing_claim_revenuecat_event`・`billing_finish_revenuecat_event`・`billing_has_live_family_plan` | 両方の `database.types.ts` を再生成する (270k / 256 で) | A |
| `supabase/baseline/**`・`tests/helpers/schema-snapshot.ts`・`scripts/supabase-local.sh` | 本冊の表・列・関数 | 変更なし (凍結。migration が上に積まれる) | A |
| `tests/schema-checked-supabase.test.ts` / `tests/schema-checked-db.test.ts` | `.from('plan_store_products')`・`.from('revenuecat_webhook_events')`・`.from('ai_plan_feature_caps')` | 型の再生成で緑 | A → B |
| `tests/billing-migration-contract.test.ts` (核の migration の文面) | 本冊の migration は別ファイル | 変更なし (`*_billing_core.sql` だけを見る) | — |
| `tests/billing-manual-plan-grant-migration-contract.test.ts` (02 の migration の文面。M 行の述語 `stripe_subscription_id IS NULL` を見るなら) | §6.7 の置き換え | 02 の migration は触らない (緑のまま)。本冊の migration の中の 3 関数の定義は、本冊の契約テスト 63 が `stripe_subscription_id IS NULL AND s.iap_store IS NULL` を見る | A |
| `tests/parental-consent-migration-contract.test.ts` (#1173 の T-MIG1。`REDEFINED_FUNCTIONS` (`:86-98`) に `create_family_group` があり、`:132-136` の `it.each` が「その関数を最後に定義する migration が `_parental_consent_and_birth_date`」を `toBe` で固定する) | 本冊の migration が `create_family_group` を作り直す (§6.6。番号は最大より大きいので、ファイル名の並びで最後の定義になる。母集合の作り方 9) | 本冊の後の定義だけを名前の後半で許す形に改める (ほかの 10 関数の期待は変えない)。`REDEFINED_FUNCTIONS` の下に `/** 本 migration の後にその関数を作り直した migration の名前の後半 (version の 14 桁を除く)。billing/03 §6.6 が家族プランの門を足して create_family_group を作り直す */ const LATER_REDEFINER_SUFFIXES: Readonly<Partial<Record<(typeof REDEFINED_FUNCTIONS)[number], readonly string[]>>> = { create_family_group: ['_billing_paid_plans_iap.sql'] };` を足す。`:132` の it 名を `'%s を本 migration が作り直し、その後に作り直した migration は LATER_REDEFINER_SUFFIXES のものだけで、ロールバックが同じ関数を定義し直す'` にし、本文は `definers` (いまの `:133` のまま) に対して `expect(definers).toContain(ours[0]);`・`expect(definers.filter((name) => name > ours[0]).map((name) => name.slice(ourVersion.length))).toEqual(LATER_REDEFINER_SUFFIXES[fn] ?? []);`・`expect(rollback).toMatch(definesPattern(fn));` の 3 つにする (いまの `:134` の `toBe(ours[0])` を前の 2 つに替える)。T-MIG5 (`:320-336`) は `baseDefinerOf` (本 migration より前だけを見る) なので変えない | A |
| `tests/rpc-profile-name-placeholder-migration-contract.test.ts` (#1678。`:149-157` の it が「`create_family_group` を最後に定義するのは `_parental_consent_and_birth_date`、1 つ前が本 migration、2 つ前がベースライン」を固定し、冒頭の注 `:8-10` も同じことを書く) | 同上 | `:149` の it 名を `'create_family_group を最後に定義するのは billing/03 の _billing_paid_plans_iap (家族プランの門)、1 つ前が #1173 の _parental_consent_and_birth_date、2 つ前が本 migration、3 つ前がベースライン'` にし、本文は `definers` (いまの `:150-152` のまま) に対して `expect(definers.length).toBeGreaterThanOrEqual(4);`・`expect(definers[definers.length - 1]).toMatch(/_billing_paid_plans_iap\.sql$/);`・`expect(definers[definers.length - 2]).toMatch(/_parental_consent_and_birth_date\.sql$/);`・`expect(definers[definers.length - 3]).toBe(ours[0]);`・`expect(definers[definers.length - 4]).toBe(PREVIOUS_FILE);` の 5 つにする。冒頭の注 (`:8-10`) の「create_family_group は、本 migration の定義を土台に #1173 の migration が 18 歳未満の IF を足して作り直す (差分の契約は tests/parental-consent-migration-contract.test.ts の T-MIG5)。本 migration はその 1 つ前、ベースラインは 2 つ前」を「create_family_group は、本 migration の定義を土台に #1173 の migration が 18 歳未満の IF を足して作り直し (差分の契約は tests/parental-consent-migration-contract.test.ts の T-MIG5)、さらに billing/03 の migration が家族プランの門を足して作り直す。本 migration は最後から 3 つ目、ベースラインは 4 つ目」にする | A |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` | `cron.schedule` | 変更なし (本冊に cron は無い) | — |
| `tests/integration/security/anon-definer-execute.test.ts` (A1: 許可リストに無い SECURITY DEFINER 関数に anon の EXECUTE が無い) | 新しい SECURITY DEFINER 関数 5 本 | 変更なし (どれも `REVOKE … FROM PUBLIC, anon, authenticated`) | — |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` | `ai_plan_feature_caps.updated_by` (SET NULL) | D の `EXPECTED_ACTIONS` に 1 行 | A |
| `tests/account-export-tables.test.ts` / `src/lib/account-export-tables.ts` | `personal_subscriptions` の新しい列 (`iap_synced_at` は `SENSITIVE_NAME` に当たらないが内部の時刻)。新設の 3 表 | `omit` に `iap_synced_at` を足す (`iap_store`・`iap_product_id`・`iap_is_sandbox` は書き出す)。新設の 3 表は分類しない: 分類の要否は `tests/account-export-tables.test.ts:163-184` の `requiredTables` (`DATA_SUBJECT_COLUMNS` の列を持つ・`auth.users` を指す `ACTOR_COLUMNS` 以外の列を持つ・出力する表の子表) で決まり、`revenuecat_webhook_events` (利用者の列なし)・`plan_store_products` (`subscription_plans` だけを指す)・`ai_plan_feature_caps` (`updated_by` は `ACTOR_COLUMNS`) はどれにも当たらない。そのため cross/20 の T-34 の和 (90 表) にも入らない | A |
| `tests/integration/security/account-export-scope.test.ts` | 「出力しない列」の一覧 | `iap_synced_at` を足す | A |
| `tests/account-export.test.ts` (`personal_subscriptions` の固定の行 2 つ (`stripe_*`・`notes` を持つ)。`:350` が書き出しの JSON に `stripe_` などの語が無いことを見る) | `personal_subscriptions` の `omit` が増える | 変更なし (固定の行は `iap_*` の列を持たないので、`omit` に `iap_synced_at` を足しても結果は同じ。新しい列 `iap_store`・`iap_product_id`・`iap_is_sandbox` の名前は `stripe_` を含まない。`iap_synced_at` を書き出さないことは上の 2 行 (`account-export-tables.test.ts`・`account-export-scope.test.ts`) が見る) | A |
| `src/__tests__/lib/super-admin/flag-active-users.test.ts`・`src/__tests__/lib/feature-flags.test.ts`・`src/__tests__/api/feature-flags.test.ts` ・`tests/ai-chat-flag-edge.test.ts` (Edge の `supabase/functions/_shared/ai-chat-flag.ts`。`plan_key_cached` の読み手。§7.1) | `plan_key_cached` の値 | 変更なし (読み手は値だけを読み、本冊の写像は同じ式で同じ値を書く。新しい値の種類は無い) | — |
| `tests/admin-users-email.test.ts`・`tests/admin-pii-view-audit.test.ts`・`tests/admin-view-audit-1326.test.ts`・`tests/support-users-list-1717.test.tsx` (運営の利用者の一覧と詳細の route `src/app/api/admin/users/route.ts`・`src/app/api/admin/users/[id]/route.ts` の片方か両方を本物で呼び、偽の `user_profiles` の行に `plan_key_cached` (`'pro'`・`'free'`・`null`) を持つ。`admin-pii-view-audit` はサポートの route `src/app/api/support/users/[id]/route.ts`・`[id]/notes/route.ts` も呼び、`support-users-list-1717` は一覧の応答をサポートの画面 `src/app/(support)/support/users/page.tsx` に渡して描く)・`tests/super-admin-flags-route.test.ts` (#1148。`/api/super-admin/flags` の `active_user_count` を `src/lib/super-admin/flag-active-users.ts` の判定で数え、`:223-228` が空の `plan_key_cached` を `free` として数えることを、`:316` が読む列 `id, roles, organization_id, plan_key_cached, created_at` を見る) | `plan_key_cached` (偽の行の列・読む列の一覧) | 変更なし (運営の利用者の 2 本の route と `flag-active-users.ts` は凍結 (§15.2)。サポートの route と画面・`src/app/api/super-admin/flags/**` も §15.2 の触る一覧に無い。本冊は `user_profiles` の列を足さず・消さず、`plan_key_cached` の値の種類 (`pro`・`family_basic`・`family_pro`・空) と空を `free` とする読み方も変えないので、偽の行と読む列の一覧はそのまま正しい) | — |
| `tests/super-admin-llm-quotas-route.test.ts`・`tests/super-admin-llm-quotas-page.test.tsx` (`AI_DAILY_LIMIT_MAX`・`LLM_QUOTAS_ENFORCED_NOTE`) と `src/lib/super-admin/ai-daily-limits.ts`・`llm-schemas.ts` (§7.1 の読み手の表) | `ai_daily_limits` の行が増える | 変更なし (偽物のデータで一覧を組み立てるテストで、本番の行の数を見ない。`AI_DAILY_LIMIT_MAX` は本冊の最大の値より大きい) | — |
| `tests/integration/rls/ai-usage-rpc.test.ts`・`ai-daily-limit-rpc.test.ts`・`ai-usage-feature-cap-rpc.test.ts` (free = 10 を前提に回数を回す・究極モードの env cap を前提にする) | `ai_daily_limits.free` が 3 に・`ai_plan_feature_caps` の free の行 (究極 0・献立の作成 3・画像 0・自動の料理画像 0) | 回数の期待を 3 に合わせる (ハードコードの実数は更新。緩めない)。free の利用者で 1 日の合計を 4 回以上数える it は、3 回目までの許可と 4 回目の止め (`limit: 3`) に直すか、回数そのものを見る it なら利用者を `pro` の手動付与にする (it ごとに、その it が確かめたいことに合わせて選ぶ)。究極モードの既存の it は、利用者を `pro` の手動付与にして行の値 (2) で見るか、`ai_plan_feature_caps` の行を消して env の既定 (1) で見るかを it ごとに選ぶ。`menu_generation` を 4 回以上数える it は、free では 3 回で止まるので `pro` にする。`meal_image_auto` の安全弁 (`ai_unmetered_daily_caps`) を回す it は、free では `plan_locked` で 1 回目から止まるので利用者を `pro` の手動付与にする (安全弁の期待値は変えない)。`image_generation` を数える it も同じ | A |
| `tests/ai-usage-contract.test.ts` (9: 上限に数えない機能・既定のプランは migration と同じ・`AI_DAILY_CAPPED_FEATURES` = `AI_CAPPED_FEATURES`。`:615-647` は `consume_ai_usage_at` の最後の定義の本文から `c_unmetered`・`c_default_plan`・`c_unmetered_fallback_cap` の 3 つの定数を読む。`:707-720` の it `'(#1142) migration の consume_ai_usage_capped_at は、consume_ai_usage_at と同じ鍵のロックを取ってから、consume_ai_usage_at に渡す'` は、`consume_ai_usage_capped_at` の最後の定義の本文 (`--` のコメントを除く) で、ロック (`lockAt`) < 回数を数える `FROM public.ai_usage_counters` (`countAt`) < 委譲 `public.consume_ai_usage_at(p_user_id, p_feature, p_at)` の最初の出現 (`delegateAt`。`:716` の `body.search`) を求める) | `consume_ai_usage_at`・`consume_ai_usage_capped_at` の置き換え (本冊の migration が両方の最後の定義になる。母集合の作り方 9)。§6.5 は `consume_ai_usage_capped_at` のロックの直後 (数える前) に、行のあるプランの委譲 `RETURN public.consume_ai_usage_at(p_user_id, p_feature, p_at);` を入れるので、委譲の最初の出現が数える位置より前になり、`:719` の `expect(delegateAt).toBeGreaterThan(countAt)` が赤になる | `:615-647` は変更なし (本冊の定義は土台の本文を丸ごと写して差分を入れる (§6.5) ので、3 つの定数は同じ値のまま。本冊は `c_unmetered` と `AI_CAPPED_FEATURES` を変えない。`AI_PLAN_CAPPED_FEATURE_LABELS` は別の名前)。`:707-720` の it は、委譲の 2 か所の位置をそれぞれ固定する形に改める (いまの順の検査は残し、早期の委譲の検査を足す。緩めない): it 名を `'(#1142・billing/03 §6.5) migration の consume_ai_usage_capped_at は、consume_ai_usage_at と同じ鍵のロックを取ってから、プラン × 機能の行 (ai_plan_feature_caps) のあるプランは回数を数える前に consume_ai_usage_at に任せ、行の無いプランはその機能の回数を数えてから consume_ai_usage_at に渡す'` にする。本文は `definitions`・`body`・`lockKey`・`lockAt`・`countAt` (いまの `:708-715`) をそのまま残し、`:716` の `delegateAt` の 1 行を `const planRowAt = body.search(/FROM\s+public\.ai_plan_feature_caps/);`・`const delegateAts = [...body.matchAll(/public\.consume_ai_usage_at\(p_user_id, p_feature, p_at\)/g)].map((match) => match.index ?? -1);` の 2 行に、`:717-719` の 3 つの expect を `expect(lockAt, 'consume_ai_usage_at と同じ鍵のロックが無い').toBeGreaterThanOrEqual(0);`・`expect(countAt).toBeGreaterThan(lockAt);`・`expect(planRowAt, 'プラン × 機能の行をロックの後に見ていない').toBeGreaterThan(lockAt);`・`expect(countAt, '行の無いプランの回数は、行を見た後に数える').toBeGreaterThan(planRowAt);`・`expect(delegateAts, '委譲は 2 か所 (行のあるプランの早期の委譲と、行の無いプランの最後の委譲)').toHaveLength(2);`・`expect(delegateAts[0]).toBeGreaterThan(planRowAt);`・`expect(delegateAts[0]).toBeLessThan(countAt);`・`expect(delegateAts[1]).toBeGreaterThan(countAt);` の 8 つにする。土台 (origin/main `2ba5b3b3` の `20261014100000_ai_usage_feature_daily_cap.sql`) の本文には `ai_plan_feature_caps` が無く委譲が 1 か所なので、改めた it は本冊の migration と同じ PR (段 A) で入れる | A (`:707-720`)・B |
| `tests/ai-daily-limit-core.test.ts`・`tests/ai-usage-edge.test.ts`・`tests/ai-daily-limit-client.test.tsx`・`tests/consultation-action-usage.test.ts`・`apps/mobile/__tests__/lib/ai-daily-limit.test.ts`・`src/__tests__/lib/plan/entitlements.test.ts` | `_shared/ai-daily-limit.ts` の全文の置き換え (`cappedFeature` の型が `AiPlanCappedFeature` に・`aiDailyLimitPayload` の本文が `AiUsageDeniedBody` に・`planLocked`) | 既存の期待は変えない (429 の本文の形・究極モードの文・1 日の上限の文は同じ)。「知らない機能名は付けない」の it が `menu_generation`・`image_generation`・`meal_image_auto` を知らない名前の例に使っていれば、AI_PLAN_CAPPED_FEATURES に無い名前 (例 `consultation`) に替える (実数に合わせる。緩めない)。Web の `tests/ai-daily-limit-client.test.tsx:40-45` (`:42` は 403 + `AI_DAILY_LIMIT` の本文 → null) とモバイルの `apps/mobile/__tests__/lib/ai-daily-limit.test.ts:59-65` は、状態と code の組を `aiDailyLimitMessageOfStatusAndBody` が見る (§8.8) ので変えずに緑。テスト 41〜43・89・97・101・102・142 を足す | B |
| `tests/stored-failure-messages.test.ts` (行に書く側の文を読む側がすべて通す契約・Web とアプリが同じ答え。`AI_DAILY_CAPPED_FEATURES`・`aiDailyLimitMessageOfDenied`・`isAiDailyLimitMessage` を名指し) | `_shared/ai-daily-limit.ts` の全文の置き換え (使えない機能の文 `aiFeatureNotInPlanMessage`・機能ごとの上限の文 `aiFeatureDailyLimitMessage` が増える) | 既存の期待は変えない (`AI_DAILY_CAPPED_FEATURES` は究極モードだけのまま・既存の文は同じ・`{ limit, cappedFeature }` は `AiUsageDenialReason` に代入できる)。テスト 108 を足す (読む側 3 つの関数が本冊の新しい文をそのまま出す)。読む側のファイルはコメントだけ (§8.8) | B |
| `apps/mobile/__tests__/lib/failed-response.test.ts` (生の fetch の口 `errorOfFailedResponse` と `getApi()` の `withFriendlyErrors`。`:100` の「同意の 403 は `HTTP 403: …` のまま」・`:185-213` の 403 `LEGAL_CONSENT_REQUIRED` / `AI_CONSENT_REQUIRED` / JSON でない本文) | `aiDailyLimitErrorOf` が 403 も見るようになる (§8.8 の下の箇条) | 変更なし (403 の本文の `code` が `AI_FEATURE_NOT_IN_PLAN` でなければ `aiDailyLimitMessageOfStatusAndBody` が null を返し (403 + `AI_DAILY_LIMIT` の本文も null。§8.8)、`aiDailyLimitErrorOf` は null のまま。既存の 403 の例はどれも別の `code` か JSON でない本文なので同じ答え。403 `AI_FEATURE_NOT_IN_PLAN` を `AiDailyLimitError` にすることはテスト 102 が見る) | — |
| `apps/mobile/src/lib/menu-request-error.ts` (`isKnownMenuRequestErrorMessage` が `isAiDailyLimitMessage` を呼ぶ) | `isAiDailyLimitMessage` が使えない機能の文も通す | 判定のコードは変えない。`:16` のコメントだけ (§8.8 の表)。振る舞いはテスト 108 が Web と同じ答えであることを見る | B |
| `tests/meal-image-skip.test.ts`・料理の保存の route のテスト (`git grep -l -E "skipped_ai_limit\|markDishImagesSkipped\|meal_image_auto" origin/main -- tests src/__tests__` で母集合を作る。少なくとも下の 2 本) | `MEAL_IMAGE_SKIPPED_ERRORS` に `plan` が増える・見送りの理由を `mealImageSkipReasonOf` で決める・`reconcileDishImages` が種を献立の主菜の 1 品に絞る (Q-16。母集合の作り方 17) | 見送りの既存の期待 (安全弁の `skipped_ai_limit` と `aiSkipped`・レート制限の `skipped_rate_limit`) は変えない (偽の `consumeAiUsage` は `planLocked` を返さないので同じ枝)。`Object.values(MEAL_IMAGE_SKIPPED_ERRORS)` の数を数える it があれば 3 に。主菜の絞り込みで赤になる 2 つの it を改める (実数に合わせる。緩めない): (1) `:637` の it「写真の料理 (1 つ・料理に写真あり) に料理を足したときは、今までどおり足した料理に積む (画像の処理のあともカバーは写真の料理の写真)」は、足した味噌汁 (`soup`) が主菜でない (主菜は写真の親子丼) ので、it 名を「写真の料理 (1 つ・料理に写真あり・主菜) に料理を足したときは、足した料理は主菜でないので積まず、画像の無い状態にする (billing/03 Q-16。画像の処理のあともカバーは写真の料理の写真)」にし、`:640` の `expect(result.jobs.map((job) => job.dishIndex)).toEqual([1]);` を `expect(result.jobs).toEqual([]);` と `expect(result.dishes[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });` の 2 つにする (`:641` のカバーの期待は変えない)。(2) `:644` の it「商品の料理 (catalog・商品の画像あり) に料理を足したときは、今までどおり足した料理に積む (カバーは商品の料理の画像)」も同じ (商品の料理の役割は `main`。`lib/catalog-products.ts:299`): it 名を「商品の料理 (catalog・商品の画像あり・主菜) に料理を足したときは、足した料理は主菜でないので積まず、画像の無い状態にする (billing/03 Q-16。カバーは商品の料理の画像)」にし、`:655` を `expect(result.jobs).toEqual([]);` と `expect(result.dishes[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });` の 2 つにする (`:656` は変えない)。ほかの it は変えない: `:302` の「2 つ目の料理だけに積むとき」は 2 つ目が主菜 (`CURRY`) なので `[1]` のまま緑、`:98` の積み直しと `:433`・`:440`・`:659` は料理が 1 品、`:318`〜`:634` の写真・商品の献立は種が 0 本のまま。テスト 92・111・143〜148 を足す | B |
| `tests/meal-image-skip-routes.test.ts` (5 つの入口の見送り。`:330` の A = 安全弁で `skipped_ai_limit` と `aiSkipped`、`:347` の B = レート制限) | 4 本の route と AI 相談の update_meal の見送りの理由の 1 行 (`mealImageSkipReasonOf`)・`image_error` の値 `'skipped_plan'`・`reconcileDishImages` が種を献立の主菜の 1 品に絞る (Q-16。母集合の作り方 17) | 見送りの A〜K の既存の期待は変えない (偽物は `{ ...AI_USAGE_DENIED, safetyCap: true }` と `AI_USAGE_DENIED` で、どちらも `planLocked` を持たないので `ai_limit` の枝のまま。既定の `submittedDishes` は `[CURRY]` の 1 品)。主菜の絞り込みで赤になる・意味を失う it を改める (実数に合わせる。緩めない): (1) `:615` の it「料理を足したときは、足した料理だけに AI の画像のジョブを積む (写真の料理は置き換えない)」(`describe.each(UPDATE_ENTRIES)`): 足した味噌汁は主菜でないので、it 名を「料理を足しても、主菜でない料理には AI の画像のジョブを積まず・数えない (写真の料理は置き換えない。billing/03 Q-16)」にし、`:621-623` の 3 つの期待を `expect(h.consumeAiUsage).not.toHaveBeenCalled();`・`expect(h.state.queueInserts).toEqual([]);` の 2 つに、`:626` の `saved[1]` の期待を `toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null })` にする (`:625` の `saved[0]` の写真の期待は変えない)。(2) `:776` の J の it「3 品の AI の献立 (画像がまだ無い) にカバーを付ける → …」: `existingDishes` は `reconcileDishImages` を通した 3 品で、主菜だけが画像を待ち、副菜と汁物は画像の無い状態になる。it 名の「3 品の AI の献立 (画像がまだ無い)」を「3 品の AI の献立 (画像を待つのは主菜だけ。billing/03 Q-16)」に、`:785` の `[0, 1, 2]` を `[0]` に、`:789` の `every((dish) => dish.image_source === 'generated_ai' && !dish.image_url)` の 1 行を `expect((savedRow().dishes as MealImageDish[])[0]).toMatchObject({ image_source: 'generated_ai', image_url: null });` と `expect((savedRow().dishes as MealImageDish[]).slice(1).every((dish) => dish.image_source === null && !dish.image_url)).toBe(true);` の 2 行に、`:793` の `[0, 1, 2].map(aiImageUrl)` を `[aiImageUrl(0), null, null]` にする (カバーと切り替えの期待は変えない)。(3) `:808` の J の it と `:951` の K の it は、画像の処理を手で流す `h.state.queueInserts = [0, 1, 2].map((dish_index) => ({ dish_index }));` (`:810`・`:953`) を `[0].map(…)` にし (積まれるのは主菜の 1 本だけ。主菜でない料理に画像を書く形は段 B の後に起こらない)、`:964` の `[0, 1, 2].map(aiImageUrl)` を `[aiImageUrl(0), null, null]` にする (カバーの期待は変えない)。(4) `:863` と `:874` の #1532 の 2 つの it は、1 回の保存で積むのが主菜の 1 行までになり「2 品のうち 1 品の書き込みが失敗」「2 品とも積めたら limit は 2」が起こらないので改める: `:863` は it 名を「料理が 2 品でも積むのは主菜の 1 行だけで、主菜でない料理の位置の書き込みは起こらない (billing/03 Q-16)」にし、`:864` を `submittedDishes = [SOUP, CURRY];`、`:865` を `h.state.queueErrorFor = (row) => (row.dish_index === 0 ? PERMISSION_DENIED : null);` (汁物の位置の書き込みが起きれば失敗にする) に、`:869` の期待を `[1]` に、`:871` の `limit` を 1 のままにする。`:874` は it 名を「主菜の 1 行を積めたら limit は 1」にし、`:878` を `expect(h.state.queueInserts.map((row) => row.dish_index)).toEqual([0]);` に、`:879` の `limit: 2` を `limit: 1` にする (書き込みの失敗と重複を数える規則は `:882`・`:891` の it と `tests/meal-image-enqueue-core.test.ts` が見る)。`describe.each(ENTRIES)` の中にテスト 98・150 を、`describe.each(UPDATE_ENTRIES)` の中にテスト 151 を足す。5 つの入口を同じ it で見るので、AI 相談の update_meal の見送りの理由 (`consultation-action-executor.ts` の 1 行) と主菜の絞り込みもここで守る | B |
| `tests/meal-cover-ownership.test.ts` (#1487 のカバーの持ち主・#1553 の clearCover と作り直し。`reconcileDishImages` と `buildDishImagePayload` を本物で動かす。母集合の作り方 17) | `reconcileDishImages` が種を献立の主菜の 1 品に絞り、ほかの料理を画像の無い状態にする (Q-16)。`:44-48` の `pendingAiMeal()` の `expect(result.jobs).toHaveLength(THREE_DISHES.length)` (3 品の鮭の塩焼き (`main`)・おひたし (`side`)・味噌汁 (`soup`)) が 1 本になり赤。続く it が `runWorker(…, [0, 1, 2])` で 3 品に画像を書く形は、段 B の後に起こらない | (1) `pendingAiMeal()`: 注を「3 品の AI の献立 (reconcileDishImages を通した。画像を待つのは主菜の鮭の塩焼きだけで、副菜と汁物は画像の無い状態。billing/03 Q-16)」に、`:46` を `expect(result.jobs.map((job) => job.dishIndex)).toEqual([0]);` にする。(2) 新しい道具 `legacyPendingAiMeal()` を `pendingAiMeal` の下に足す (逐語): `/** 3 品とも画像を待つ AI の献立 (段 B の前に積んだ献立の形。billing/03 Q-16 の後は主菜だけを積むが、段 B の前の待ちのジョブは主菜でない料理にも画像を書く。§7.3) */ async function legacyPendingAiMeal(): Promise<MealImageDish[]> { return Promise.all(THREE_DISHES.map(async (dish, index) => ({ ...dish, image_url: null, image_source: 'generated_ai' as const, image_status: 'pending' as const, image_subject_hash: await buildDishImageSubjectHash(dish, index) }))); }` (`buildDishImageSubjectHash` は import 済み)。(3) `:133` の it: `:145` の `[0, 1, 2]` を `[0]` に、`:147` の `every(…)` の 1 行を `expect(patched.dishes[0]).toMatchObject({ image_source: 'generated_ai', image_url: null });` と `expect(patched.dishes.slice(1).every((dish) => dish.image_source === null && !dish.image_url)).toBe(true);` の 2 行に、`:150` の `[0, 1, 2]` を `[0]` に、`:153` の `toEqual(AI_URLS)` を `toEqual([AI_0, null, null])` にする (カバー・カバーを書いた数・切り替えの期待は変えない)。(4) `:166` の it: `:168` の `[0, 1, 2]` を `[0]` に (ほかは変えない)。(5) `:236` の it「カバーが空か AI の料理の画像のときは、今までどおり付け替わる」: 料理の画像を 2 つの位置に書いてカバーの付け替えを見るので、`:237` の `await pendingAiMeal()` を `await legacyPendingAiMeal()` にする (期待は変えない)。(6) `:279` の it: 料理に役割が無く先頭の商品の料理が主菜の位置になり、`:294` の `[2, 3]` が `[]` になる。`:285` の `{ name: 'ふつうの料理' }` を `{ name: 'ふつうの料理', role: 'main' }` にし、it 名を「商品・手で付けた画像の料理も保持する。source の無い料理と generated_ai の料理は今までどおり AI の画像の料理として扱い、主菜 (ふつうの料理) にだけ積む (billing/03 Q-16)」に、`:294` を `expect(payload.jobs.map((job) => job.dishIndex)).toEqual([2]);` と `expect(payload.dishes[3]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });` の 2 行にする。(7) `:309` の it: `:310` の `[0, 1, 2]` を `[0]` に、`:322` の `toEqual(AI_URLS)` を `toEqual([AI_0, null, null])` に。(8) `:325` の it: `:334` の `[0, 1, 2]` を `[0]` に、`:336` の `[0, 1, 2]` を `[0]` に (カバーの期待は変えない)。(9) `:424` の it: `:425` の `[0, 1, 2]` を `[0]` に。(10) `:442` の it: `:443` の `[0, 1, 2]` を `[0]` に、`:452` の `[0, 1]` を `[0]` に、`:453` の `[0, 1]` を `[0]` に (作り直しの副菜のきんぴらは主菜でない)。(11) `:512` の it: it 名を「一部の料理だけ変わった作り直し: 同じまま残った写真の主菜は AI の画像の生成に回し、変わった副菜 (きんぴら) は主菜でないので画像の無い状態にする (billing/03 Q-16)」に、`:521` の期待を `toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null })` に、`:522` の `[0, 1]` を `[0]` に、`:524` の `[0, 1]` を `[0]` にする。(12) `:527` の it: it 名を「料理を足した作り直し (前の料理は同じ): 同じまま残った写真の主菜は AI の画像の生成に回し、写真の味噌汁と足した料理は主菜でないので画像の無い状態にする (billing/03 Q-16)」に、`:537` の `await expectReleasedToAi(regenerated.dishes[1], MISOSHIRU, 1);` と `:538` を、`regenerated.dishes[1]` と `regenerated.dishes[2]` がそれぞれ `{ image_url: null, image_source: null, image_status: null, image_subject_hash: null }` に一致する 2 行に、`:539` の `[0, 1, 2]` を `[0]` にする。(13) `:584` の it: it 名を「自分の写真を持つ料理 (1 品の写真・主菜) は、料理を足した作り直しでも写真のまま残し、足した料理は主菜でないので積まず、カバーはその料理の写真から選び直す (billing/03 Q-16)」に、`:594` の `[1]` を `[]` にし、`expect(regenerated.dishes[1]).toMatchObject({ image_source: null, image_status: null, image_subject_hash: null });` を足す。ほかの it (`:191`・`:215`・`:225`・`:249`〜`:304` の (6) 以外・`:341`・`:358`〜`:421`・`:456`〜`:509`・`:543`〜`:580`・`:598`〜`:623`・書き込みの describe) は種が 0 本か 1 品なので変えない | B |
| `tests/save-meal-photo-preserve.test.ts` (`saveMealToDb` を本物で通し、`enqueueMealImageJobs` を差し替えて積む種を見る。母集合の作り方 17) | 作り直しの種が献立の主菜の 1 品に絞られる (Q-16) | (1) `:151` の it: it 名の「どの料理にも AI の画像のジョブを積み」を「主菜にだけ AI の画像のジョブを積み (汁物は画像の無い状態。billing/03 Q-16)」に、`:155-157` の `jobs` を `[expect.objectContaining({ dishIndex: 0 })]` に、`:158-161` の期待を `[["generated_ai", "stale", null], [null, null, null]]` にする。(2) `:185` の it: it 名の「増えた料理にも AI の画像のジョブを積み」を「主菜にだけ AI の画像のジョブを積み (増えた料理と汁物は画像の無い状態。billing/03 Q-16)」に、`:190` の `[0, 1, 2].map(…)` を `[expect.objectContaining({ dishIndex: 0 })]` に、`:192` の `row.dishes[2]` の期待を `toMatchObject({ name: "お浸し", image_url: null, image_source: null, image_status: null })` にする。(3) `:207` の it: it 名の「同じまま残った写真の料理も AI の画像の生成に回す」を「同じまま残った写真の主菜は AI の画像の生成に回し、変わった汁物は画像の無い状態にする (billing/03 Q-16)」に、`:212` の `jobs` を `[expect.objectContaining({ dishIndex: 0 })]` に、`:214-217` の期待を `[["generated_ai", "pending", null], [null, null, null]]` にする。(4) `:241` の it: `:249` の `jobs` を `[expect.objectContaining({ dishIndex: 0 })]` にする (カバーの期待は変えない)。ほかの it は料理が 1 品か種が 0 本なので変えない。テスト 149・159 を足す | B |
| `tests/process-meal-image-jobs-write-race.test.ts` (#1527 の料理の書き込みの競合。`:35-40` の `pendingAiDishes` が `reconcileDishImages` で 2 品 (`main`・`soup`) の待ちの料理を作り、`:38` で種の数 = 料理の数を求める。母集合の作り方 17) | 種が主菜の 1 品に絞られ、`:38` が赤。汁物 (位置 1) は subject_hash を持たなくなり、位置 1 に書く競合の it (`:124` の `it.each`・`:164`・`:279`) の書き込みが `dish_changed` で書かれなくなる | 競合は同じ献立の 2 つのジョブ (段 B の前に積んだジョブ・主菜を入れ替えた前後のジョブ) で起こりうるので、2 品とも待ちの料理のまま確かめる: `pendingAiDishes` を手で作る形にする (逐語): `/** 画像を待つ AI の料理 (generated_ai・pending・subject_hash つき) を手で作る。billing/03 Q-16 の後 reconcileDishImages は主菜の 1 品にしか積まないが、同じ献立の 2 つの料理のジョブ (段 B の前に積んだジョブ・主菜を入れ替えた前後のジョブ) は残りうるので、#1527 の競合は 2 品で確かめる */ async function pendingAiDishes(nextDishes: MealImageDish[]): Promise<MealImageDish[]> { return Promise.all(nextDishes.map(async (dish, index) => ({ ...dish, image_url: null, image_source: 'generated_ai' as const, image_status: 'pending' as const, image_subject_hash: await buildDishImageSubjectHash(dish, index), image_prompt: buildDishImagePrompt(dish), image_model: DEFAULT_MEAL_IMAGE_MODEL }))); }`。`:15` の import を `import { DEFAULT_MEAL_IMAGE_MODEL, buildDishImagePrompt, buildDishImageSubjectHash, type MealImageDish } from '../supabase/functions/_shared/meal-image';` にする (`reconcileDishImages` は使わなくなる)。it の期待は変えない | B |
| `tests/meal-image-backfill.test.ts` (#1505 の積み直しの道具の判定。母集合の作り方 17) | `planDishImageJobs` が主菜でない待ちの料理を `not_auto_image_dish` で数え、積まない (Q-16) | (1) `:26` の it: 料理に役割が無いので主菜の位置は先頭のカレー。it 名に「(積むのは献立の主菜の 1 品だけ。主菜の無い献立は先頭の料理。billing/03 Q-16)」を足し、`:39-50` の `seeds` の期待をカレーの 1 つ (`dishIndex: 0` の要素) だけに、`:51-59` の `skipped` の期待に `not_auto_image_dish: 1,` を足す (サラダ)。更新待ち・source なしの料理も積む対象であることは、サラダだけの献立で確かめる 1 行を足す: `expect(planDishImageJobs([dishes[1]]).seeds).toEqual([{ dishIndex: 0, dishName: 'サラダ', subjectHash: 'h1', prompt: buildDishImagePrompt(dishes[1] as { name: string }), model: DEFAULT_MEAL_IMAGE_MODEL, triggerSource: MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE, referenceImageUrls: [] }]);`。(2) `:73` の it: `photoMealDishes` の `'足した料理'` に `role: 'main'` を足す (カバーの無い献立 (`:92`) で積む料理を主菜にする。カバーのある献立は `meal_cover_preserved` が先に当たるので期待は変わらない)。期待は変えない。テスト 152 を足す | B |
| `tests/meal-image-backfill-trigger.test.ts` (#1532 の処理を起こす条件。`enqueueMealImageJobs` を差し替え、`:79` で積む種の数 = 待ちの料理の数 (3) を求める。母集合の作り方 17) | 役割の無い 3 品の献立は、先頭の料理だけを積む (Q-16) | `:25` の注「(3 品。どれも積み直しの対象)」を「(3 品。役割が無いので、積み直すのは先頭の 1 品だけ。billing/03 Q-16)」に、`:79` を `expect(h.enqueue.mock.calls[0][0].jobs.map((job: { dishIndex: number }) => job.dishIndex)).toEqual([0]);` に、`:74` の it 名の「(3 品のうち 1 品の書き込みが失敗なら 2)」を「(積めた 1・重複 1・失敗 1 の結果なら 2)」にする (`enqueue` の結果は差し替えの値なので、limit の期待は変えない) | B |
| `tests/integration/rls/meal-image-backfill.test.ts` (#1505 の道具を実 DB で。`dish()` (`:49-51`) は役割 `main` を付けるので、新しい献立 (`:113-117`) のカレー・サラダ・印なしはどれも主菜の役割で、最初の主菜はカレー。母集合の作り方 17) | サラダ (位置 1) が `not_auto_image_dish` になり、積む料理が 3 → 2 (カレーとうどん) になる (Q-16) | B-1 (`:149`): `:157` の `candidateDishes: 3` を `2` に、`:162` の `skipped` の期待に `not_auto_image_dish: 1` を足す。B-2 (`:169`): `:172` の `inserted: 2` を `1` に、`:174-177` の行の期待をカレーの 1 行 (`[newerMealId, 0, 'pending', MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE]`) だけに (`:176` の 1 行を消す)。B-3 (`:183`): `:186` の `duplicates: 2` を `1` に、`:187` の `toHaveLength(2)` を `1` に。冒頭の注の B-1 の箇条に「献立の主菜 (最初の主菜) でない待ちの料理は積まない (not_auto_image_dish。billing/03 Q-16)」を足す。B-4 は変えない (`processedMeals` は 2 のまま) | B (結合テスト。`scripts/lib/meal-image-backfill.ts` を変える段 B の PR で一緒に直し、段 B の結合テストで流す) |
| `tests/meal-image-route-contracts.test.ts` (`:296` の同意 → 上限 → ジョブの順・`:321` の安全弁で止めたときの `aiSkipped`) | 料理の保存の route の見送りの理由の 1 行 | 変更なし (偽物は `AI_USAGE_ALLOWED` / `AI_USAGE_DENIED` だけで `planLocked` を返さない。`consumeAiUsage` を呼ぶ順と `'meal_image_auto'` の名前は本冊で変えない。plan-locked の枝はテスト 98 が `meal-image-skip-routes.test.ts` で見る) | — |
| 呼び出し側の偽の `consume_ai_usage` (母集合の作り方 18): `tests/ai-consent-enforcement-routes.test.ts` (`:54-55` の `CONSUME_ALLOWED_ROW` / `CONSUME_DENIED_ROW` を `:756` で `h.state.rpc` に入れ、`:799`・`:802` で `consume_ai_usage` を呼んだ回数と `p_feature` を数える。`:1065-1074` の `CAPPED_ULTIMATE_DENIED_ROW` は `consume_ai_usage_capped` の止め (`capped_feature: 'menu_generation_ultimate'`))・`tests/consultation-action-raw-error-text.test.ts` (`:94-97`)・`tests/consultation-pantry-expiry-jst.test.ts` (`:72-75`)・`tests/consultation-prompt-meal-type-order-1631.test.ts` (`:94-97`) (どれも許可の行 `{ allowed: true, metered: true, usage_date, limit: 10, used: 1 }` を返す) | DB の `consume_ai_usage` / `consume_ai_usage_capped` の戻り値に `capped_feature` の値と `plan_locked` が増える (§6.5)・`parseConsumeAiUsageResult` がそれを読む (§8.8)・AI 相談の `dailyLimitResult` の code (§8.8) | 変更なし。(1) RPC の名前と呼び分け (`consumeAiUsage` が `consume_ai_usage` / `consume_ai_usage_capped` を呼ぶこと・渡す `p_feature` と `p_feature_daily_cap`) は本冊で変えない (`src/__tests__/lib/plan/entitlements.test.ts` の行)。(2) 偽の行はどれも `plan_locked` を持たず、`capped_feature` は無いか `menu_generation_ultimate` だけなので、§8.8 の `parseConsumeAiUsageResult` は今と同じ答え (許可の行は同じ形・止めの行は `planLocked` の無い `AiUsageDenied`。究極モードの止めは `cappedFeature: 'menu_generation_ultimate'` で究極モードの文) を返し、429 `AI_DAILY_LIMIT` の本文 (`limit` は偽の行の値) と AI 相談の `dailyLimitResult` の code (`AI_DAILY_LIMIT`) も変わらない。(3) 偽の行の `plan: 'free'`・`limit: 10` は DB を読まない偽の値で、route の振る舞いは値に依らない (free の 1 日の合計を 3 にする (§6.5) のは DB の行)。plan-locked の枝はテスト 41・97・98 が見る | — |
| free = 10 の文 (母集合の作り方 8。2026-10-19 の origin/main で `src/lib/plan/entitlements.ts:4`・`supabase/functions/_shared/ai-usage-core.ts:18`・`tests/helpers/ai-consent-enforced-paths.ts:22`・`tests/helpers/ai-usage-mock.ts:10`・`tests/consultation-action-usage.test.ts:13`・`tests/meal-image-route-contracts.test.ts:296`・`tests/integration/rls/ai-daily-limit-rpc.test.ts:5,12,210,262`・`tests/integration/operator/super-admin-llm.test.ts:130`・`tests/e2e/w5-3-menu-gen-adversarial.spec.ts:17`・`src/app/api/super-admin/llm/quotas/route.ts:12`・`supabase/functions/README.md:292`。同じ grep は `src/__tests__/lib/membership/invite-throttle.in-memory.test.ts:221` にも当たるが、家族の招待の回数の制限で AI の上限ではないので対象外) | `ai_daily_limits.free` が 3 に (§6.5)・`ai_plan_feature_caps` (§6.5)・有料プランの販売 | 文だけを直す (判定のコードは変えない)。`entitlements.ts:4` の「【いまの方針】課金は無料のまま計測する (いまは全員が free プラン)。AI の利用は 1 日 10 回まで (究極モードも 1 回)。」を「【方針】AI の利用回数の 1 日の上限はプランごと (DB の ai_daily_limits)。機能ごとの上限 (究極モード・献立の作成・料理画像の作成) は DB の ai_plan_feature_caps (0 = そのプランでは使えない。billing/03 §6.5)。」に (次の行の究極モードの環境変数の説明は「行の無いプランの究極モードは」で始める)。`ai-usage-core.ts:18`・`ai-consent-enforced-paths.ts:22`・`consultation-action-usage.test.ts:13`・`meal-image-route-contracts.test.ts:296` は「10 回」を消して値に依らない語 (「1 日の上限」「1 日の上限の回数に数えない」) に。`ai-usage-mock.ts:10` は「(テストの上限の回数。DB の既定の値とは独立)」に (値 `TEST_AI_DAILY_LIMIT = 10` は変えない)。`ai-daily-limit-rpc.test.ts` は上の `ai-usage-rpc` の行のとおり期待を 3 にし、コメントと it 名・describe 名の `free = 10` / `free = 1 日 10 回` も 3 に。`super-admin-llm.test.ts:130`・`w5-3:17` は各行のとおり。`quotas/route.ts:12` は凍結 (§15.2) なので触らない (文は migration `20261011020000` の既定を出典つきで書いたもの。§18 に載せる)。`supabase/functions/README.md:292` (段 A) は、「上限はプランごとの DB の `ai_daily_limits`（既定は free = 1 日 10 回。全機能の合計・JST の暦日・究極モードも 1 回）。」を「上限はプランごとの DB の `ai_daily_limits`（全機能の合計・JST の暦日・究極モードも 1 回。行の無いプランは free の行の値）と、プラン × 機能ごとの DB の `ai_plan_feature_caps`（0 = そのプランでは使えない。無料プランは究極モード・画像の作成・自動の料理画像が 0。billing/03 §6.5）。」に、同じ段落の「究極モード（`menu_generation_ultimate`。#1142）は 1 日の上限にも 1 回入り、そのうえ 1 日 1 回まで（環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT` で上書き。Vercel と同じ値を secrets に入れる）で、」を「究極モード（`menu_generation_ultimate`。#1142）は 1 日の上限にも 1 回入り、そのうえ `ai_plan_feature_caps` に行のあるプランはその値まで、行の無いプラン（組織の plan）は 1 日 1 回まで（環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT` で上書き。Vercel と同じ値を secrets に入れる）で、」にする (段落のほかの文は変えない。この README を読むテストは無い) | A・B・C |
| `tests/billing-public-plans.test.ts`・`tests/public-claims-guard.test.ts` の `vi.mock('@/lib/billing/public-plans')` | `listPurchasablePlans` を `listPublicPlans` に置き換える | テストの関数名と mock の名前を `listPublicPlans` に。「失敗したら空を返して error ログ」の it はそのまま (ログの文の期待があれば新しい文に) | B・C |
| `packages/shared/src/index.ts` を読むテスト (`git grep -l "packages/shared/src/index" origin/main -- tests packages`) | `export * from './billing-plans';` の 1 行 | export の一覧を固定する it があれば 1 行足す | B |
| `src/__tests__/lib/plan/entitlements.test.ts` (`aiFeatureDailyCap` が尋ねる名前・`consume_ai_usage_capped` の呼び分け) | 変更なし (呼び分けは変えない) | テスト 50 を足すだけ | B |
| `tests/ai-consent-enforcement.test.ts`・`tests/ai-usage-contract.test.ts` (棚卸し) / `tests/helpers/ai-consent-enforced-paths.ts` | `@/lib/env` に届く route: `webhooks/revenuecat`・`billing/iap/sync`・`billing/subscription` (遅延の再同期で `revenuecat-gateway` を import する) | `EXEMPT_ROUTES` に 3 行 (下の逐語)。`billing/iap/catalog` は届かない (載せない。テスト 31 が見る) | B |
| `src/__tests__/api/null-character-routes.test.ts` | `webhooks/revenuecat/route.ts` の POST が `request.text()` を読む | `EXCLUDED` に `'POST webhooks/revenuecat/route.ts': '本文は RevenueCat が署名して送るもので、利用者は書けない。大きさの上限と署名の確認より前に本文を JSON として読まない作り (billing/03 §9.1)'`。`iap/sync` は本文を読まない (載せない)・`iap/catalog` は GET | B |
| `lib/supabase/middleware.ts`・`lib/supabase/__tests__/middleware-maintenance.test.ts` (`:207-217` の `it.each(['/api/webhooks/stripe', '/api/webhooks'])`「Resend の Webhook を通しても、ほかの Webhook はメンテナンス中は 503 のまま」) | `/api/webhooks/revenuecat` | `middleware.ts` は変えない (Webhook の受け口の専用の除外の一覧は無い。`/api` の分岐 (`:179-`) は認証を要求せず、凍結・メンテナンス・同意だけを見る。セッションの無い Webhook は凍結の判定に当たらず、同意は許可リストの `/api/webhooks` (prefix・`no_user_session`) が通す。§9.1)。テスト 133: `:207` の配列に `'/api/webhooks/revenuecat'` を足す (メンテナンス中は 503 `MAINTENANCE_MODE`) | B |
| `src/lib/maintenance-mode.ts`・`src/__tests__/lib/maintenance-mode.test.ts` (`:89-140` の `it.each([...])('%s は止める')`) | 新しい route 3 本と Webhook | `maintenance-mode.ts` は変えない (`isMaintenanceExemptPath` (`:87-110`) は止めないパスを列挙するだけで、列挙に無い `/api` は既定で止まる。`:76-80` の注のとおり Stripe の Webhook もこれで止まる)。テスト 132: 「止める」の配列の `'/api/webhooks/stripe/'` (`:136`) の後に `'/api/webhooks/revenuecat'`・`'/api/billing/iap/catalog'`・`'/api/billing/iap/sync'` を足す | B |
| `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | 新しい route と `src/lib/billing/iap-*` | 固定の文だけ (`iapErrorResponse` / `billingErrorResponse`)。`RevenueCatApiError.rawMessage` はログ専用 | B |
| `tests/role-check-source-scan.test.ts` | `src/app/api/billing/iap/**` の handler | `requireUser` だけ | B |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` の import | `iap-repository.ts` は `getSupabaseAdmin` だけ | B |
| `tests/next15-async-request-api-scan.test.ts` | `createClient()`・`params` | `await` を付ける | B |
| `tests/edge-function-dep-pinning.test.ts` | Edge Function の依存 | Edge Function を足さず、Edge Function の依存も足さない (RevenueCat の SDK をサーバに入れない) | — |
| `tests/billing-core.test.ts` (billing/01 §14 の番号のテスト 1〜16・72・89・95・111・112。本冊の §14 の番号ではない) | `summarizeSubscription` の 4 つ目の引数・`BillingSummary` の項目 | 呼び出しに `EMPTY_PLAN_FEATURES` を足す。`BillingSummary` のリテラルの期待に `source`・`manage_in_store: null`・`features` を足す。`EXT_STRIPE_NOT_CONFIGURED` の文の期待 (#1911 の「お支払いを受け付けていません」) は変えない。テスト 34〜36 を足す | B |
| `tests/billing-service.test.ts`・`tests/api/billing-routes.test.ts`・`src/__tests__/app/account/billing-pages.test.ts`・`src/__tests__/app/frozen-billing-page.test.tsx` (`BillingSummary` の偽物・`summaryOf`) | `BillingSummary` の必須の項目が増える | 偽物に `manage_in_store: null`・`features: EMPTY_PLAN_FEATURES` を足す。`findPlanFeatures` の偽物を `BillingRepository` の偽物に足す。`tests/api/billing-routes.test.ts` の GET `/api/billing/subscription` まわりは次の行 (テスト 33 は別ファイル) | B |
| `tests/api/billing-routes.test.ts` の GET `/api/billing/subscription` まわり (`:61` の `REPOSITORY = { kind: 'repository' }` は関数を持たない・`:219-242` の「鍵が無くても 200」と直接の import の検査・`:244-263` の AI の印の棚卸し「…and the 2 GET billing routes do not reach them」) | §8.5 で subscription の route が `repository.findLiveSubscription` を呼び、`createRevenueCatGateway` (`@/lib/billing/revenuecat-gateway`。中で `@/lib/env` を import する) を import する。棚卸しの `:260-262` が `reachesAi` の結果を `src/app/api/billing/subscription/route.ts` について `false` で固定しているので赤になる (母集合の作り方 1) | (1) 偽物: `mocks` に `findLiveSubscription: vi.fn()`・`createRevenueCatGateway: vi.fn()`・`lazyResyncStoreSubscription: vi.fn()` を足し、`REPOSITORY` を `{ kind: 'repository', findLiveSubscription: (...args: unknown[]) => mocks.findLiveSubscription(...args) }` に、`beforeEach` に `mocks.findLiveSubscription.mockResolvedValue(null);` を足す。`vi.mock('@/lib/billing/revenuecat-gateway', () => ({ createRevenueCatGateway: () => mocks.createRevenueCatGateway() }))`・`vi.mock('@/lib/billing/iap-repository', () => ({ createIapRepository: () => ({ kind: 'iap-repository' }) }))`・`vi.mock('@/lib/billing/iap-service', () => ({ lazyResyncStoreSubscription: (...args: unknown[]) => mocks.lazyResyncStoreSubscription(...args) }))` を足す (`RevenueCatNotConfiguredError` と `needsLazyResync` は `iap-core.ts` の本物を使う)。行が null なら再同期は要らないので、既存の it の期待 (`getBillingSummary` に `{ repository: REPOSITORY }` だけを渡す・`createStripeGateway` を呼ばない・凍結中も 200 ほか) は変えない。(2) `:236-241` の直接の import の検査は変えない (route は `@/lib/env` も `@/lib/billing/stripe-gateway` も直接は import しない)。(3) `:244-263` の棚卸し: `'src/app/api/billing/subscription/route.ts'` を `:260` の配列から `reaching` の配列 (`:246-254`) へ移し (env.ts を辿らなければ届かないことも同じ it が見る)、`:260` の配列は `'src/app/api/billing/checkout/preview/route.ts'` の 1 本にする。it 名を `'AI reach inventory: the 5 Stripe-calling billing routes, GET /api/billing/subscription (lazy RevenueCat resync), the Stripe webhook route and account/delete reach the AI markers only through src/lib/env.ts, and GET /api/billing/checkout/preview does not reach them'` にする。(4) テスト 131 を足す | B |
| `tests/api/billing-routes.test.ts` の billing の route の走査 (`:291-321` の it `'the billing routes whose URL path is in FROZEN_ALLOWED_API_PATHS call requireUserAllowingFrozen and not requireUser, and every other billing route calls requireUser and not requireUserAllowingFrozen'`。`src/app/api/billing/**/route.ts` を数え、`:301` の `expect(files).toHaveLength(7)` で本数を固定する) | §8.5 の新しい route 2 本 (`src/app/api/billing/iap/catalog/route.ts`・`src/app/api/billing/iap/sync/route.ts`) で 9 本になり、`:301` が赤になる (母集合の作り方 14) | `:301` を `expect(files).toHaveLength(9);` にする (実数に合わせる。緩めない)。走査の残りは変えない: 2 本は `FROZEN_ALLOWED_API_PATHS` (`src/lib/auth/frozen.ts:70`。変えない) に無いので else の枝に入り、どちらも `requireUser(` を呼んで `requireUserAllowingFrozen(` を呼ばない (§8.5・S22) ので緑。末尾の `billingAllowed` の 3 本の期待も変えない | B |
| `tests/billing-manual-grant.test.ts`・`billing-manual-grant-service.test.ts`・`billing-manual-grant-client.test.ts`・`src/__tests__/components/admin/manual-plan-grant-section.test.tsx` | `source` の union に `'store'`・`SUBSCRIPTION_COLUMNS` | 偽物の行に `iap_store: null` を足す。`store` のときの表示の it を 1 つ足す | B |
| `tests/admin-audit-logs-insert-policy-migration-contract.test.ts` (#1736。`:35` の `DIRECT_INSERT_ALLOWED` = `['src/lib/admin/audit.ts', 'src/lib/billing/repository.ts']`。`:144-150` の it「admin_audit_logs に直接 INSERT するのは recordAdminAudit と課金の repository (service_role) だけ」が、`src` の全ファイル (テストを除く) を `from(…'admin_audit_logs'…).insert(` の正規表現で走査して `toEqual` で固定する。母集合の作り方 11) | `src/lib/billing/iap-repository.ts` の `recordIapAudit` (§8.3) が `admin.from('admin_audit_logs').insert({` で書く。Webhook の失敗の監査 `system.revenuecat.event_failed` は `actor_id` NULL・`system.*` なので `recordAdminAudit` (本人の JWT) では書けず (同じファイルの `:152-` の it が `recordAdminAudit` に `system.*` を渡すことを禁じる)、核の `repository.ts` の `recordAudit` と同じく service_role で直接書く | (1) `:35` を `const DIRECT_INSERT_ALLOWED = ['src/lib/admin/audit.ts', 'src/lib/billing/repository.ts', 'src/lib/billing/iap-repository.ts'];` に、その上の注を「アプリのコードで admin_audit_logs に直接 INSERT してよいファイル (書き手の全数。#1736 の表と、billing/03 §8.3 の iap-repository.ts)」に。(2) `:144` の it 名を `'admin_audit_logs に直接 INSERT するのは recordAdminAudit と課金の repository 2 本 (billing/01 の repository.ts・billing/03 の iap-repository.ts。service_role) だけ'` に (本文は変えない)。(3) `:139-142` の「src を読めている」の it に `expect(sourceFiles).toContain('src/lib/billing/iap-repository.ts');` を足す。(4) 冒頭の注 (`:13-14`) の「課金の repository (service_role) だけ」を「課金の repository 2 本 (src/lib/billing/repository.ts と iap-repository.ts。service_role) だけ」に。`system.*` の it (`:152-`) は変えない (`iap-repository.ts` は `recordAdminAudit` を呼ばない) | B |
| `tests/billing-audit-action-lists-doc.test.ts` (`operator/07` §4 の `*.billing.*` の名前は 2 つの一覧のどちらかにある) | `system.revenuecat.event_failed` (名前に `.billing.` を含まない) | 変更なし。`operator/07` §4.5 に名前を足す (§16.2)。`BILLING_AUDIT_ACTIONS` の数は変えない | — |
| `tests/public-claims-guard.test.ts` (F21。#1911 の後の main) | `FORBIDDEN` の `¥980`・`980円`・`9,800円` (`¥980`・`980円` = 家族 Basic の月額、`9,800円` = 家族 Basic の年額。どれも本冊の価格で、料金ページ・特商法・FAQ・紹介ページに出る)・`vi.mock` の `listPurchasablePlans`・`#1151 料金ページ` (0 件で「現在は無料でご利用いただけます。」を含み「有料プラン」を含まない)・`billing/01 §10.1` のデータ駆動 (0 件で FAQ を描く・`PurchasablePlan`)・`/legal` の「有料の販売で要る項目は出さない」・`/faq` の `無料プランでは`・`月額` を書かない・`#1867 (Q-12)` (`/faq`「現在、料金はかかりますか？」・`/pricing` の 0 件の文の数 3・`AI_DAILY_LIMIT_NOTE` の名前) | (1) `FORBIDDEN` から `¥980`・`980円`・`9,800円` の 3 行を消し、`依頼で名指しされた文字列` の `required` から `'¥980'` を消す (`¥1,980`・`1,980円` は残す)。(2) `vi.mock` を `listPublicPlans: async () => pricingMocks.plans` に、`pricingMocks.plans` と `plan()` の型を `PublicPlan` (`max_members: null` を足す) に。(3) `#1151 料金ページ` の it (`:428-436`) を「0 件 (読み取りの失敗) のときはフリーのカードだけで、`現在は無料`・`有料プラン`・`PENDING_WORDS` を出さず、プレミアム・ファミリー・月払い・年払いも出さない。`billingPeriod` を使わない」に。(4) `billing/01 §10.1` の 1 つ目の it (`:496-516`) を「0 件と金額 0 のプランだけのときはフリーのカードだけ (FAQ の節・`現在は無料でご利用いただけます。` は無い)」に、2 つ目 (`:518-560`) は Price のある間隔だけ CTA (いまの期待のうち `現在は無料でご利用いただけます。`・`現在、料金はかかりますか？` を消し、それ以外はそのまま) に、Price が無いプランの it をテスト 44 として足す。(5) `/legal` の it (`:333-341`) をテスト 46 に書き換える (`LEGAL_SALE_ROW_LABELS` は「出す」ことの検査に使う。`LEGAL_NOT_SELLING_TEXTS`・`PENDING_WORDS`・`PAID_PLAN_PENDING_NOTICE` は出さないことの検査のまま)。(6) `/faq` の it (`:567-571`) と `#1867 (Q-12)` の `/faq` の it (`:640-642`) をテスト 116 に (`faqAnswer(faq, '料金はかかりますか？')` が `AI_DAILY_LIMIT_PHRASE` を含む。禁止の語は `プレミアムプラン`・`年払い`・`Visa`・`解約後も次回更新日まで`)。(7) `#1867 (Q-12)` の `/pricing` の it (`:644-649`) の数を「フリーのカードに 1 回」(`split` の長さ 2) に、`:651-654` の `AI_DAILY_LIMIT_NOTE` を `FREE_PLAN_AI_LIMIT_NOTE` に。(8) `/company` の describe (`:366-419`) は変えない | C |
| `tests/business-info-legal-pages.test.ts` (#1911 の後の main) | `/legal` の行が増える (販売の 9 行) | 変更なし (会社情報の行の値・空欄と仮置きのマーカーが無いこと・`/company` と `/legal` の同じ欄の一致を見る。販売の行も値を持ち、マーカー (`確定次第掲載`・`XXX`・`TODO` ほか) を含まないので緑。`/terms`・`/privacy` の事業者名の検査は、段 E の文に `株式会社`・`Inc` が無いので緑) | — |
| `tests/e2e/b10-unexplored-areas.spec.ts` (4-1 `:240-255` / 4-3 `:267-293`) | 4-1 の「現在は無料でご利用いただけます。」の `toBeVisible` と `¥980` が無いこと、4-3 の `販売価格`・`支払方法` が無いこと | 4-1: 「現在は無料でご利用いただけます。」の行を「個人 Pro」と `¥580` が見えること (`getByText('¥580').first()`) に替え、`not.toContainText('¥980')` を消す (家族 Basic の月額)。`準備中`・`販売開始前`・`¥1,980`・`年払い` が無いことはそのまま (CTA の有無は環境 (Price の登録) で変わるので見ない)。4-3: `not.toContainText('販売価格')`・`not.toContainText('支払方法')` を、`販売価格` と `580円` が見えること (`planCatalogPriceText` の「個人 Pro: 月額 580円 …」) に替える。ほかの期待はそのまま | C |
| `tests/faq-guide-wording-1859.test.ts` (FAQ の項目を `a: '…'` の形で読み、数の一致と「」の名前の実在を見る。`:136-146`・`:265`) | FAQ の料金の項目の書き換え | 変更なし (§10.5 の 4 項目は一重引用符の文字列のまま。新しい答えが「」で挙げる名前は「プランとお支払い」だけで、Web の画面 `src/app/(main)/settings/page.tsx:457` に実在する。文の頭は Web の画面として読まれる) | — |
| `tests/landing-page-1867.test.ts` (紹介ページの文と殻のメタ情報) | U-24 (`すべて無料` を含む文字列がちょうど 3 つで、どれも「1 日にご利用いただける回数」を含む。§10.5 で 0 になる)・U-15 (`SITE_DESCRIPTION` の逐語「…いまは無料で使えます。」)・U-2 / U-3 (`claims` の `evidence` の実在・id の数 46。§10.5 は id を足さず、足す `evidence` の `packages/shared/src/billing-plans.ts` は段 B で実在する)・U-10 (`:402-433`。import の検査は `:403-427`。`src/components/marketing/` の全ファイルの import を、`allowedExact` (`react`・`next/link`・`next/image`・`lucide-react`・`framer-motion`・`zod`・`@/lib/site-config`・`@/app/guide/guide-content`・`@/components/handson-tour/useReducedMotion`) と相対と `@/components/marketing/` に限る。§10.5 が `landing-copy.ts` に `import { PAID_PLAN_SUMMARY, PLAN_CATALOG, formatJpy } from '@homegohan/shared';` を足すので `src/components/marketing/landing-copy.ts: @homegohan/shared` で赤。母集合の作り方 15) | U-24 を `it('U-24 LANDING_COPY のどの文字列 (claims を含む) も「すべて無料」「いまは無料」を含まず、無料の範囲を説明する 3 つ (trust の「無料プランと有料プラン」の body・pricing.lead・faq の「本当に無料で使えますか？」の答え) は「1 日にご利用いただける回数」と PAID_PLAN_SUMMARY を含む')` に書き換える (3 つは場所で取り出す。数のハードコードは置かない)。U-15 の期待の文を「…体重や健康診断の記録まで。無料で始められます。」に (長さと書かない語の検査はそのまま)。U-2 / U-3 は変更なし。U-10 は `allowedExact` の配列の最後に `'@homegohan/shared', // billing/03 §10.5: 料金の文の定数と関数 (PLAN_CATALOG・PAID_PLAN_SUMMARY・formatJpy)。packages/shared/src の本体は外部の import を持たず (node: の import はテストのファイルだけ)、package.json は sideEffects: false。'use client' の部品も既に読む (src/components/native-app/NativeAppTabRouter.tsx)` の 1 行を足す (it 名・ほかの許可先・島の本数の検査は変えない。`@homegohan/shared` の下の道は package.json の `exports` に無いので許さない)。テスト 104 を足す。`docs/design/marketing/01-landing-site.md` の文言の表と §8.1 の import の許可先の一覧は §16.2 の marketing の行で同じ PR に | C |
| `tests/landing-pricing-doc-1911.test.ts` (origin/main `359a16f9` で入った marketing/01 の料金の記述の番兵。母集合の作り方 4・6) | (1) `:77-80` の it: marketing/01 §13.1 の幅の表の行のうち `\| 未ログイン \|` で始まり「料金はカード」を含む行 (いまは 2 行) が、どれも「料金はカード {`LANDING_COPY.pricing.plans.length`} 枚」を含むこと。§10.5 が `pricing.plans` を 1 枚から 2 枚 (`free`・`paid`) にするので、marketing/01 が「料金はカード 1 枚」のままだと赤。(2) `:82-91` の it: marketing/01 の 3 つの行 (§4.1 の主張 `free-now` の行・§19 の `tests/public-claims-guard.test.ts` の `#1151 料金ページ (/pricing)` の行・§20 の `src/app/pricing/PricingPageView.tsx` の保持の行。行の頭は `EVIDENCE_ROW_MARKERS` (`:30-34`)) が、`PricingPageView.tsx:N` と `` `:N` `` の同じ行の番号の組を指すこと。§10.1 が根拠の行 (`:125` の「現在は無料でご利用いただけます。」の段落・`:68` の FAQ の答え) を消すので、marketing/01 の行の番号は書き換わる。行の頭を変える・行を消すと「行が見つからない」で赤 | テストの検査のコードは変えない。marketing/01 を §16.2 の marketing の行のとおり同じ PR で直す: (1) 幅の表の 2 行の「料金はカード 1 枚」を「料金はカード 2 枚」にする (「カード 2 列」とは書かない)。(2) 3 つの行の頭は変えず、根拠の行の番号を段 C の後の `PricingPageView.tsx` の 2 か所 (無料のカードで `FREE_PLAN_FEATURES` の箇条書きを描く行と、有料のカードで `PLAN_CATALOG` の `features` の箇条書きを描く行) にして、3 行とも `PricingPageView.tsx:<無料のカードの行>`・`` `:<有料のカードの行>` `` の同じ組で書く (§4.1 が正で、§19・§20 が従う)。it 名の「(1 枚)」は段 C の後の事実と違うので、`:77` の it 名だけを `'幅の表の料金は、すべての行で今のカードの数 (LANDING_COPY.pricing.plans の数) で言い、「カード 2 列」を書かない'` にする。古い文を捕まえる it (`:93-108`) は変更なし | C |
| `src/__tests__/lib/feature-flags.test.ts` ほか `plan_key_cached` の偽の DB | 意味は変えない | 変更なし | — |
| `tests/integration/security/legal-documents-acceptance.test.ts`・`tests/integration/rls/user-profiles-insert-guard.test.ts` | 特権列ガード | 変更なし (触らない) | — |
| 家族の結合テスト (`tests/integration/security/family-*.test.ts`・`membership-*.test.ts`・`invite-*.test.ts`・`tests/integration/rls/ai-usage-rpc.test.ts`・`family-member-names-scope.test.ts`・`family-rls-recursion.test.ts`・`hidden-content-visibility.test.ts`・`meals-meal-type-trigger.test.ts`・`membership-audit-select.test.ts`・`paste-meal-*.test.ts`・`tests/integration/security/account-deletion.test.ts`・`invite-rpc-token.test.ts`・`plan-deprecate-subscribers.test.ts`・`purge-dissolved-family-groups.test.ts`・`parental-consent.test.ts`・`rpc-profile-name-placeholder.test.ts`・`invite-accept-missing-profile.test.ts`・`tests/integration/rls/family-menu-visibility.test.ts`・`hidden-content-restore.test.ts` ほか `create_family_group` か `family_members` の INSERT を使うもの (母集合の作り方 2) | `create_family_group` の門・`family_members` の INSERT のトリガー | 共通の道具 `tests/integration/helpers/family-plan.ts` (新設) に `grantFamilyPlan(srAdmin, userId, planKey = 'family_basic')` = `billing_grant_manual_subscription(p_user_id, p_plan_key, NULL)` の RPC (service_role) を置き、グループを作る利用者 (代表者) に、`create_family_group` を呼ぶ前に 1 行足す。service_role の直接の INSERT でグループを作るテストは、メンバーを足す前に `family_groups.plan_key` を `family_basic` に UPDATE する (すでにそうしているテストは変えない)。期待値 (人数の上限・`plan_key` の値) は、代表者に家族プランが入ることで `free` → `family_basic` / 4 になる箇所だけ更新する (実数に合わせる。緩めない) | A |
| `tests/integration/operator/super-admin-plans*.test.ts`・`tests/plan-*.test.ts` (プランの行の値を前提にするもの) | 価格・`display_name` の UPDATE | 価格や名前をリテラルで期待する it があれば実数に合わせる (実装時に `git grep -n -E "'Pro'\|'Family Basic'\|980\|1480\|2480" origin/main -- tests` で確かめる。grep は左の glob に限らず `tests` の全体に当てる。当たったファイルのうち DB の行の値を読まず、偽の値を自分で置くもの (偽の client・固定の応答) は変えない)。当たらないもの (例: `tests/price-impact-applies-to.test.ts` は偽の client に置いた 1500 だけを期待し、`tests/e2e/operator/02-super-admin-flow.spec.ts` は価格を期待しない) は変更なし | A |
| `src/__tests__/app/transfer-accept-fake-client.ts` (`SCHEMA_COLUMNS`) | `family_groups`・`personal_subscriptions` | 変更なし (`personal_subscriptions` は一覧に無い。`family_groups` の列は変えない) | — |
| `tests/design-doc-removed-mobile-screens.test.ts`・`tests/mobile-removed-files-references.test.ts` | 本冊は `docs/design/` に置かれる | 本冊は消した画面を名指ししない (`apps/mobile/app/settings/plan.tsx` は新設で一覧に無い) | — |
| `tests/native-app-tabs-contract.test.ts` | タブ | 変更なし (タブを足さない。`/settings/plan` はタブの外) | — |
| `tests/mobile-account-frozen-contract.test.ts`・`lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts` | `FROZEN_ALLOWED_API_PATHS` | 変更なし (本冊の route は凍結中に通さない。一覧の `toEqual` が変わらないことと、テスト 118 が新しい 2 本の不在を見る) | — |
| `lib/supabase/__tests__/middleware-legal-consent-api.test.ts`・`packages/shared/src/legal-consent-api.test.ts` | `LEGAL_CONSENT_EXEMPT_API_PATHS` | 変更なし (本冊の route は許可リストに入れない。S21。`src/app/api` の全 route を走査する it が、新しい 3 本の route も表に入れて見る: catalog・sync は未同意の 403 と凍結中の 403、`/api/webhooks/revenuecat` は許可リストの `/api/webhooks` (prefix) に当たるので止めない) | — |
| 母集合の作り方 4 の公開の文の grep (`有料プラン`) が語だけで当たる、テストでないファイル: `apps/mobile/app/frozen.tsx:6` (凍結の画面の WebView の注。Web の画面の「有料プランの解約・お支払い」(`/frozen/billing`) の入口を名指す)・`packages/shared/src/legal-consent-api.ts:109-111` (`LEGAL_CONSENT_EXEMPT_API_PATHS` の課金の 3 本の注) | 公開の文と価格 | 変更なし (どちらも価格・「無料」の語・未完成を示す語を持たない。`/frozen/billing` のパスは変えず、画面の文の差分は §10.4 で Web の側にある。`legal-consent-api.ts` の許可リストは本冊の route を入れない (S21。上の `LEGAL_CONSENT_EXEMPT_API_PATHS` の行) ので、課金の 3 本の注はそのまま正しい) | — |
| `tests/legal-consent-*.test.ts`・`tests/e2e/legal-consent-gate.spec.ts`・`src/__tests__/api/cron/push-outbox.test.ts` (版の値を持つなら) | `LEGAL_DOCUMENTS` の版 (`v2026.2` → `v2026.3`) | cross/20 の実装で `LEGAL_DOCUMENTS` の値を読む形になっている (cross/20 §16)。残っていれば段 E で `LEGAL_DOCUMENTS` の値に替える (`git grep -n "v2026.2" -- tests src packages apps lib` で確かめる。2026-10-21 の origin/main `83d90a88` で当たるのは `legal-versions.ts` の定義と注と、保護者の同意書の版 (`PARENTAL_CONSENT_DOCUMENT.version` も `v2026.2`。`packages/shared/src/parental-consent.ts:36,38,43,174`・`packages/shared/src/parental-consent.test.ts:230-231`) だけで、同意書の版は `LEGAL_DOCUMENTS` と別の値なので替えない) | E |
| `LEGAL_DOCUMENTS` の値を読む、上の 2 行に入らないテスト (母集合の作り方 3 の `LEGAL_DOCUMENTS` で当たるもの。2026-10-19 の origin/main `2ba5b3b3`): `tests/auth-callback-legal-consent.test.ts`・`tests/policy-pages-public.test.tsx`・`tests/api/legal-status-route.test.ts`・`src/__tests__/api/legal/accept.test.ts`・`src/__tests__/lib/push/outbox.test.ts`・`tests/integration/rls/push-outbox.test.ts`・`lib/supabase/__tests__/middleware-legal-consent.test.ts`・`middleware-legal-consent-matrix.test.ts`・`middleware-family-menu.test.ts`・`middleware-self-dissolve.test.ts` (#1917 が `465727de` で足した。`:37-38` で版を読む)・`packages/shared/src/legal-versions.test.ts`・`packages/shared/src/parental-consent.test.ts` (`:34-35` の同意済みの利用者) | `LEGAL_DOCUMENTS` の版 (`v2026.2` → `v2026.3`) と施行日 (§11.6) | 変更なし (どれも版と施行日を `LEGAL_DOCUMENTS` から読み、値を直書きしない。`legal-versions.test.ts` は版の書式 (`LEGAL_VERSION_PATTERN`・長さ) と施行日が実在の `YYYY-MM-DD` であること・2 文書のキーを見るので、`v2026.3` と §11.6 の施行日で緑。`policy-pages-public.test.tsx:56-60`・`tests/api/legal-status-route.test.ts:181-194` は表示と応答の版・施行日が `LEGAL_DOCUMENTS` の値と一致することを見るので、値を上げても緑) | — |
| cross/20 のテスト `tests/legal-text-1901.test.ts`・`tests/legal-document-body.test.tsx`・`tests/legal-claims-1901.ts` (cross/20 §13。段 E の土台) | 第10条・第11条・第16条・第17条・第24条・ポリシー第3条・第4条・第7条・第10条・第12条の差分 | T-33 の書き換え・T-34 の移し替え・主張の表の 42 行の追加と 3 行の直し・`LEGAL_CLAIM_COUNT` (§11.4・§11.5)。T-1・T-2 (条の数)・T-6・T-7 (`PRIVACY_PROCESSORS` の根拠。段 B の `revenuecat-gateway.ts` が要る)・T-13・T-14 (`/legal` へのリンク)・T-16・T-17 (版)・T-19・T-24・T-28 (`本サービスは、無料で利用できます` が残る)・T-29 (CSP は変えない)・T-35・T-40 はコードを変えずに緑 | E |
| `tests/public-claims-guard.test.ts` の、cross/20 の実装が足す `/terms`・`/privacy` の走査 (cross/20 §13.1 の後の注) | 段 E の文 | 変更なし (段 E の文に `FORBIDDEN` の語 (価格の語を含む) が無い。価格は本文に書かない。§11.0) | E |
| `tests/mobile-toolchain-contract.test.ts` (#1591。`apps/mobile/package.json` と `package-lock.json` を読む: `BUNDLED_PINNED` の 6 つの宣言が `bundledNativeModules.json` と同じ・apps/mobile から見た `react` / `react-test-renderer` / `react-native` の lock の版・`HOISTED_TOOLCHAIN` がルート・`apps/mobile/node_modules/` の入れ子は `MOBILE_NESTED_ALLOWED` (`@types/react`・`react`) だけ・`REMOVED_UNUSED` が宣言に無い・`expo.install.exclude`・`jest.config.js` の `resolver`) | 段 D の `apps/mobile/package.json` の 2 行と、作り直した `package-lock.json` (母集合の作り方 13)・`jest.config.js` の `moduleNameMapper` の 1 行 | 変更なし。`jest.config.js` は `moduleNameMapper` に `'^react-native-purchases$'` の 1 行を足すだけで `resolver` の行を変えない。足す 2 つは `BUNDLED_PINNED`・`HOISTED_TOOLCHAIN`・`REMOVED_UNUSED` のどれでもなく、`expo.install.exclude` も変えない。ルートの `react` 19.2.8 と `react-native` 0.88.0 が `react-native-purchases` の peer (`react >= 16.6.3`・`react-native >= 0.73.0`) を満たし、`expo-dev-client` とその依存の peer は `expo *` / `react-native *` なので、npm は新しい 8 つをルートに置き、入れ子は増えない見込み (P19)。§8.10 の「依存の追加と `package-lock.json` の作り直し」の 4 で流し、赤なら期待 (`MOBILE_NESTED_ALLOWED` ほか) を変えず、lock を手で直さず、入れ子のキーの一覧を添えて報告する | D |
| `apps/mobile/__tests__/lib/jest-timeouts.test.ts` (`jest.config.js` と `jest.setup.js` を評価して、時間切れの既定を使うこと) | `jest.config.js` の `moduleNameMapper` の 1 行 | 変更なし (`testTimeout`・`setupFiles`・`setupFilesAfterEnv` を変えない) | D |
| `tests/react-types-version-contract.test.ts` (#1199。`apps/mobile/package.json` と `package-lock.json` で、apps/mobile から見た `react` と `@types/react` のメジャーと、入れ子の `@types/react` の固定) | 同上 | 変更なし (`react`・`@types/react` の宣言と置き場を変えない。§8.10 の同じ節の 3 の ④) | D |
| `tests/zod-single-copy-1444.test.ts` (#1444。ルートと `apps/mobile` の `zod` の範囲・ワークスペースの下に入れ子の `zod` が無い・lock のルートと `apps/mobile` の行の `zod`) | 同上 (段 D は lock の `packages["apps/mobile"].dependencies` に 2 行足す) | 変更なし (`zod` の宣言を変えず、足す 2 つとその依存 (P19) は `zod` に依存しない) | D |
| `tests/openai-sdk-v7-contract.test.ts` の `package-lock.json` の it (ルートの `openai` の宣言と lock の行) | 同上 | 変更なし (ルートの `package.json` と lock の `openai` の行を変えない) | D |
| `tests/posthog-not-adopted-contract.test.ts` (ルート・`apps/mobile`・`packages/*` の `package.json` の依存に PostHog の package が無い) | `apps/mobile/package.json` の `dependencies` に 2 行 | 変更なし (`react-native-purchases`・`expo-dev-client` は PostHog の package ではない) | D |
| `tests/mobile-test-workflow-paths.test.ts` (`apps/mobile/package.json` の依存のうちワークスペースのパッケージが `mobile-test.yml` の `paths` に入っている・モバイルのコードが相対パスで読む apps/mobile の外のファイル) | 同上と、段 D の新しいモバイルのファイルの import | 変更なし (足す 2 つはワークスペースのパッケージではない。§8.10 の新しいファイルが apps/mobile の外から読むのは `@homegohan/shared` だけで、`packages/shared/**` は既に `paths` にある) | D |
| `apps/mobile/__tests__/app/no-web-purchase-links.test.ts` | `apps/mobile` の `/pricing`・`/account/billing` | 変更なし (本冊はどちらも書かない。冒頭のコメントだけ本冊の規則に書き換える) | D |
| `apps/mobile/__tests__/app/route-targets-exist.test.ts` | `/settings/plan` | `app/settings/plan.tsx` が実在するので緑。`MIN_ROUTE_FILES` / `MIN_TARGETS` は下限なので変えない | D |
| `apps/mobile/__tests__/lib/env-example.test.ts` | `process.env.EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY` / `GOOGLE` | `apps/mobile/env.example` に 2 行 | D |
| `apps/mobile/__tests__/lib/env.test.ts` (名前を直接書く) | `purchases.ts` の読み方 | 名前を直接書いている (§8.10) ので緑 | D |
| `apps/mobile/__tests__/settings/*entry.test.tsx`・`profile-row.test.tsx` (設定タブの行の数や `last` を見るなら) | 行を 1 つ足す・栄養目標の行の `last` を外す | 期待があれば実数に合わせる | D |
| ほかに設定タブ (`apps/mobile/app/(tabs)/settings.tsx`) を描く・読むテストと、`apps/mobile` の `app/`・`src/` を走査するテスト (`apps/mobile/__tests__/settings/export-rows.test.tsx`・`logout.test.tsx`・`apps/mobile/__tests__/lib/date-basis-jst.test.tsx`・`src/__tests__/app/faq/account-answers.test.ts`・`tests/ai-consent-settings-entry.test.ts`・`tests/mobile-sign-out-doc-callers.test.ts`・`tests/ai-daily-limit-mobile-raw-fetch.test.ts`) | 設定タブの行 1 つと、段 D の新しいモバイルのファイル | 変更なし。どれも特定の行・文字列・呼び出しを探すだけで行の数を数えない。足す行は `router.push(PLAN_SCREEN_PATH)` だけで、段 D のファイルは生の `fetch` (通信は `getApi()` と SDK)・`signOutOnDevice` の呼び出し・端末のタイムゾーンや UTC で日付の文字列を作る書き方 (日付の文は `@homegohan/shared` の `formatBillingDateWire`) を足さない | D |
| `apps/mobile/__tests__/menus-weekly/ultimate-mode-toggle.test.tsx` | `locked` prop | テスト 57 を足す。既存の it は `locked` 無しで同じ | D |
| `apps/mobile/__tests__/lib/sign-out.test.ts`・`sign-out-push-token-release.test.ts`・`providers/auth-provider*.test.tsx` | `resetPurchasesOnSignOut`・`identifyPurchases` の呼び出し | `react-native-purchases` は `moduleNameMapper` の mock で読まれる。順序の期待に影響しない (掃除の前に 1 回 `await` が増えるだけ)。テスト 59 を足す | D |
| ほかに `AuthProvider` と `signOut.ts` を本物で読むモバイルのテスト (`git grep -l -E "providers/AuthProvider\|lib/signOut" origin/main -- apps/mobile/__tests__`。上の行のほかは画面・ゲート・WebView の認証のテストで、多くは `AuthProvider` を `jest.mock` で差し替える) | 同上 | 変更なし。jest の環境 (`apps/mobile/jest.env.setup.js`) は `EXPO_PUBLIC_REVENUECAT_*` を置かないので、`identifyPurchases` は `apiKeyForPlatform()` が `null` で何もせず、`resetPurchasesOnSignOut` は `configuredAppUserId === null` で何もしない (§8.10 の `purchases.ts`) | D |
| `apps/mobile/__tests__/menus-weekly/v4-generate-modal-range-max.test.tsx` (モバイルの `V4GenerateModal` を描く。`../../src/lib/api` を `getApi: () => ({ post: jest.fn(), get: jest.fn() })` に差し替える) | モーダルを開くたびの `fetchBillingSummary()` (§10.6 の錠) | 変更なし。`get` が `undefined` を返す → `summaryOrThrow` が `BillingSummaryShapeError` を投げる → モーダルは錠を出さない (読めなければ錠を出さない)。期待は日付の欄の値・保存した期間の読み込み (`AsyncStorage.getItem`)・`onGenerate` の呼び出しで、`get` の回数を見ない。体験ツアーのテスト (`handson-tour-hard-back-step2-3.test.tsx`・`handson-tour-menu-bubble.test.tsx`) は `V4GenerateModal` を `() => null` に差し替えるので当たらない | D |
| `tests/site-config-guard.test.ts` | ドメインを直接書かない | `STORE_SUBSCRIPTION_MANAGEMENT_URL` (`packages/shared/src/billing-plans.ts`) は Apple / Google のドメインで当社のドメインではない (このテストは当社のドメインの直接の記述を見る。実装時に正規表現を確かめ、当たるなら許可の一覧に足す) | B |
| `tests/no-committed-credentials.test.ts` | 新しい spec | アカウントの資格情報を書かない | B |
| `tests/integration/security/operator-mfa-db-gate.test.ts` (DB-1: 運営ロールの条件を持つポリシーは `operator_mfa_satisfied()` を呼び TO authenticated。DB-11: anon が `subscription_plans` を読める) | `plan_store_products_mutate_super_admin` (§6.3) | 変更なし (§6.3 のポリシーは TO authenticated で、`'super_admin' = ANY (roles)` の項に `(SELECT public.operator_mfa_satisfied())` を付けた形なので DB-1 の offenders に入らない。`DB_GATED_POLICY_MIN_COUNT` は下限なので変えない。cross/12 の付録 A は段 E の母集合の記録なので変えない。DB-11 は `subscription_plans` の RLS を変えないので緑) | A |
| `tests/integration/security/billing-personal-subscriptions-rls.test.ts` | `personal_subscriptions` の新しい列と CHECK (§6.4) | 変更なし (新しい列は NULL 可か既定値つき。RLS と権限は変えない (§6.9)。テストの行は `iap_store` を持たないので `personal_subscriptions_iap_pair_check` に当たらない) | A |
| `tests/integration/rls/billing-apply-subscription-rpc.test.ts` | `personal_subscriptions` (Stripe の写像) | 変更なし (`billing_apply_stripe_subscription` は凍結。手動の行で `BILL_LIVE_ROW_CONFLICT` を起こす it も、`iap_store` NULL の行なので同じ結果) | A |
| `tests/integration/rls/billing-manual-grant-rpc.test.ts`・`tests/integration/operator/super-admin-users-manual-plan.test.ts` | §6.7 の手動付与の 3 関数の述語 | 変更なし (ストアの行を作らない it では、M 行の選び方に `AND s.iap_store IS NULL` が増えても結果は同じ。ストアの行を残すことは本冊のテスト 63 が見る) | A |
| `tests/integration/security/billing-manual-grant-cron.test.ts` (billing/02 の 48・59。59 は 02 の migration の `cron.` を存在しない名前に差し替えた写しを postgres のロールで流し直す) | §6.7 で本冊が作り直す 3 つ (`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・PROCEDURE `billing_expire_manual_subscriptions`) | 変更なし (02 の写しは `CREATE OR REPLACE` だけなので、本冊の migration の後でも通る)。ただし 59 は同じローカルの DB の 3 つを 02 の定義 (`iap_store IS NULL` の無い形) に戻したまま終わるので、本冊の結合テストは手動付与の取り消し・失効でストアの行が残ることを DB で確かめない (その述語は契約テスト 63 が migration の文面で見る)。結合テストの順番に依らず緑のまま | A |
| `tests/migration-file-version-integrity.test.ts` (#1636。版の番号が重ならない・1 行目の見出し `-- migration:` / `-- rollback:` がファイル名と一致・本文が案内する `supabase/rollbacks/<名前>` が実在する・戻し口に同じ名前の migration がある) | 本冊の migration と戻し口 (§6.1・§6.8) | 変更なし。番号をマージの直前に確定・付け直すとき、2 つのファイル名と、1 行目に見出しを書くならその名前と、本文が案内する戻し口のパスを同じ番号にそろえる (テストは変えない) | A |
| `tests/membership-errors.test.ts`・`src/__tests__/api/family/groups.test.ts`・`invites/accept.test.ts`・`members/child.test.ts` ほか `MembershipErrorCode`・`MEMBERSHIP_ERROR_MESSAGES`・`ErrorStatusMap`・`mapPgErrorToHttp` を名指すテスト (`git grep -l -E "MembershipErrorCode\|MEMBERSHIP_ERROR_MESSAGES\|ErrorStatusMap\|mapPgErrorToHttp" origin/main -- tests src/__tests__`。2026-10-19 は 12 本) | `MembershipErrorCode.FAMILY_PLAN_REQUIRED`・402・文 (§9.5) | 変更なし。`ErrorStatusMap` と `MEMBERSHIP_ERROR_MESSAGES` は `Record<MembershipErrorCode, …>` なので、同じ差分で両方に 1 行ずつ足す (足さないと型検査で落ちる)。`membership-errors.test.ts` の「表は enum の全値を網羅」はそれで緑。`mapPgErrorToHttp` は単語の境界で照合し、既存の 60 の code に `FAMILY_PLAN_REQUIRED` を含むもの・それに含まれるものは無い。route のテストは個別の code を `it.each` で見るだけで、`FAMILY_PLAN_REQUIRED` の写しはテスト 49 が見る | B |
| `tests/integration/rls/coupon-apply-rpc.test.ts` | `pro` の `monthly_price_jpy` (980 → 580) | 割引額の期待は `proPlan.monthly_price_jpy` から計算しているので変えない。事実と違う記述を直す: it 名「定率: 小数は切り捨て (980 円の 33% = 323.4 -> 323)」を「(580 円の 33% = 191.4 -> 191)」に、`:132` のコメント「月額 980 円 (参照データ)」を「月額 580 円 (参照データ)」に (`:134` の `org_standard` は本冊が変えないので触らない) | A |
| `tests/integration/rls/subscription-plans-yearly-price-id.test.ts` | `subscription_plans` の列・ポリシー 3 本 | 変更なし (本冊は列もポリシーも足さない。§6.2 は 3 行の値の UPDATE だけ) | — |
| `tests/integration/operator/super-admin-llm.test.ts` | `ai_daily_limits.free` が 3 に (§6.5) | `:130` の it 名「全プランの上限 (free は 1 日 10 回)」を「(free は 1 日 3 回)」に、`:142` の期待 `daily_limit: 10, effective_daily_limit: 10` を `3` に (実数に合わせる。緩めない)。`:144` の `arrayContaining(['free', 'pro', …])` はそのまま | A |
| `tests/integration/operator/super-admin-input-validation.test.ts` | `subscription_plans` | 変更なし (自分で作ったプランの値だけを見る) | — |
| `tests/integration/security/health-endpoint.test.ts`・`tests/api/health-route.test.ts` (単体。偽の client で `from('subscription_plans')` を 1 行読む疎通を見る。値は見ない) | anon が `subscription_plans` を 1 行読む (`src/app/api/health/route.ts:105`) | 変更なし (`subscription_plans` の RLS を変えない) | — |
| `tests/super-admin-llm-quotas-page.test.tsx`・`tests/super-admin-llm-quotas-route.test.ts`・`tests/helpers/ai-usage-mock.ts`・`tests/ai-usage-photo-auto-grant.test.ts` (free = 10 を偽の DB の値・テストの上限として持つ) | `ai_daily_limits.free` | 変更なし (DB を読まない偽の値。画面と route の振る舞いは値に依らない) | — |
| 母集合の作り方 2 が当てる src の読み手・書き手 (`src/app/(main)/family/**`・`src/app/(main)/settings/membership/page.tsx`・`src/app/(main)/menus/weekly/page.tsx`・`src/app/api/family/members/me/share/route.ts`・`src/app/api/family/members/names/route.ts`・`src/app/api/operator/membership/family/[id]/**`・`src/app/api/admin/finance/**`・`src/app/api/admin/users/[id]/route.ts`・`src/lib/membership/exit-notification.ts`・`src/lib/super-admin/plan-subscribers.ts`・`src/app/api/super-admin/plans/**`・`src/app/api/super-admin/llm/quotas/route.ts`・`src/app/api/health/route.ts`) と、2 の grep には当たらないが同じ表を読む・書くもの (`personal_subscriptions` を DB 関数 `apply_coupon` で書く `src/app/api/super-admin/coupons/[id]/apply/route.ts`・`src/lib/plan/coupon.ts`、`plan_key_cached` を読む `src/app/api/feature-flags/route.ts`、route の応答を描く運営の画面 `src/app/admin/finance/**`・`src/app/admin/users/**`・`src/app/super-admin/plans/page.tsx`・`src/app/super-admin/plans/[id]/**`・`src/app/super-admin/llm/quotas/page.tsx`) | 本冊が変える表を読む・書く | 変更なし (読むだけか、§7.1 の書き手の表のとおり本冊の migration と干渉しない。運営の財務 4 本 (`dashboard`・`exports`・`invoices/[id]`・`reconciliation`)・利用者詳細・クーポンの適用の I 行の扱いと、運営の画面と `plan_key_cached` の読み手は §7.1 の各行。どれも `family_members` に INSERT しない — 家族の行の追加は RPC (`accept_family_invite` など) の中で、§6.6 のトリガーが受ける) | — |
| 母集合の作り方 2 の insert の grep が当てる既存の migration と rollback (`supabase/migrations/20261007150200_*`・`20261007160000_*`・`20261008090100_*`・`20261015170000_*`・`20261016200000_*` と `supabase/rollbacks/` の対の `.down.sql`・`20261017030000_*.down.sql`)・`supabase/baseline/prod_schema.sql`・`tests/accept-copies-profile-name-migration-contract.test.ts` (migration の文面を見る) | `insert into family_members` | 変更なし (既存の migration は書き換えない。それらが定義する関数の中の INSERT も §6.6 のトリガーが受ける。本冊は `accept_family_invite`・`accept_child_promotion` を置き換えない) | — |
| `src/app/super-admin/coupons/new/page.tsx` (`:38-39` の `const typicalPrice = 980;` と `:176` の「Pro ¥980 基準」) | `pro` の価格 (980 → 580。980 は家族 Basic の価格になる) | 基準の価格を `@homegohan/shared` の `PLAN_CATALOG` から読む (`import { PLAN_CATALOG, formatJpy, planDisplayName, type PaidPlanKey } from '@homegohan/shared';`): `const COUPON_PREVIEW_PLAN_KEY: PaidPlanKey = 'pro'; // 粗利のプレビューの基準 = 個人 Pro の月額 (billing/03 §8.9)` と `const typicalPrice = PLAN_CATALOG.find((p) => p.plan_key === COUPON_PREVIEW_PLAN_KEY)?.monthly_price_jpy ?? 0;`。文は `実質粗利プレビュー ({planDisplayName(COUPON_PREVIEW_PLAN_KEY)} {formatJpy(typicalPrice)} 基準)`。テストは無い (`tests/jst-today-source-scan.test.ts` の当たりは日付の扱いで、変更なし) | C |
| `src/app/super-admin/plans/new/page.tsx` (`:14-24` の `OFFICIAL_PLANS` のうち `:16-18` の `pro` (`'Pro'`・980)・`family_basic` (`'Family Basic'`・1480)・`family_pro` (`'Family Pro'`・2480)。選ぶと入力欄に入るひな形) | `pro`・`family_basic`・`family_pro` の表示名と月額 (§6.2) | 3 つのひな形の表示名と月額を `@homegohan/shared` の `PLAN_CATALOG` から読む (`import { PLAN_CATALOG, type PaidPlanKey } from '@homegohan/shared';`)。ファイルの中に足す関数: `/** 有料 3 プランのひな形の表示名と月額は公開の価格の写しから読む (billing/03 §8.9 の PLAN_CATALOG。旧案の値を持たない) */ function paidPlanTemplate(planKey: PaidPlanKey): { display_name: string; monthly_price_jpy: number } { const entry = PLAN_CATALOG.find((plan) => plan.plan_key === planKey); return { display_name: entry?.display_name ?? planKey, monthly_price_jpy: entry?.monthly_price_jpy ?? 0 }; }`。3 行は `{ plan_key: 'pro', plan_type: 'personal', ...paidPlanTemplate('pro') }`・`{ plan_key: 'family_basic', plan_type: 'family', ...paidPlanTemplate('family_basic') }`・`{ plan_key: 'family_pro', plan_type: 'family', ...paidPlanTemplate('family_pro') }` (`as const` と `OfficialPlanKey` の型はそのまま。`plan_key` の文字の値は変わらない)。ほかの 6 行 (`free`・`family_addon`・組織の 4 つ) は変えない。テストは無い (`git grep -l -E "OFFICIAL_PLANS\|plans/new" origin/main -- tests src/__tests__ apps` が 0 件) | C |
| `src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts` (「スイッチが表示され、無効化されていない」ほか) | §10.3 の錠 (`useBillingSummary`) | `vi.mock('@/hooks/useBillingSummary')` で既存の it は `null` (錠なし) を返す (既存の期待は変えない)。冒頭の経緯のコメントに「無料プランでは錠 (billing/03 §10.3)」を足す。テスト 103 を足す | C |
| `tests/e2e/bug-27-ultimate-mode-locked.spec.ts` (fresh-user = 無料の利用者でスイッチが操作できる) | §10.3 の錠 (無料では `menu_generation_ultimate` が 0) | 各 test の最初に、その利用者へ `grantManualPlanForE2e(userId, 'pro')` を呼ぶ (下の E2E の道具)。期待 (操作できる・`ultimateMode: true` が送られる) は変えない。冒頭の経緯のコメントに「有料プランで使える (billing/03 §10.3)。この spec は有料の利用者で確かめる」を足す | C |
| `tests/e2e/w5-3-menu-gen-adversarial.spec.ts` (A-3: テストごとの利用者で献立の作成の要求を 5 回。`:17` の「free は 10 回」) | 無料の献立の作成が 1 日 3 回・AI が 1 日 3 回に (§6.5) | `apiUserTest` の利用者で `/api/ai/menu/weekly/request` を 4 回以上送る test は、最初に `grantManualPlanForE2e(userId, 'pro')` を呼ぶ (pro は献立 10 回・1 日 30 回)。`:17` のコメントの回数を新しい値に。期待 (5 件とも 200) は変えない | C |
| 家族の E2E (`tests/e2e/fixtures/fresh-family.ts` の `family_groups` / `family_members` の直接の INSERT・`tests/e2e/helpers/membership-family.ts` と、それを使う `tests/e2e/family/*.spec.ts`・`tests/e2e/membership/05-*`〜`08-*`・`12-*`・`14-*`。UI からグループを作る spec) | `create_family_group` の門・`family_members` の INSERT のトリガー (free のグループにメンバーを足せない) | グループを作る前に、代表者へ `grantManualPlanForE2e(representativeUserId, 'family_basic')` を呼ぶ (billing/01 のトリガー `family_groups_billing_plan_follow_representative` が作成時に代表者の契約から `plan_key` / `member_limit` を決めるので、`plan_key: "free"` を直接書いても上書きされる。本文の `plan_key: "free"` は消す)。期待の人数の上限が 4 のままのものはそのまま、`free` を期待するものは `family_basic` に (実数に合わせる) | C |
| 使い方ページの撮影の種まき `scripts/guide-screenshots/seed.ts` (#1852・#1867。`scripts/guide-screenshots/run.sh` がローカルの Supabase に流す。`:164-165` の `const FAMILY_PLAN_KEY = 'free';`、`seedFamily` (`:443-487`) が service_role で `family_groups` を `plan_key: FAMILY_PLAN_KEY` で INSERT (`:450-454`) し、`family_members` に `representative`・`adult`・`child` を INSERT する (`:455-480`)。母集合の作り方 2) | §6.6 の家族の門 (`family_members_billing_plan_gate`)。代表者に家族プランの契約が無いのでグループは `free` になり、`adult` の INSERT が `FAMILY_PLAN_REQUIRED` で失敗し、`must('family_members adult', …)` が投げて種まきが止まる (家族の画面を撮れない) | 家族の結合テスト・E2E の fresh-family と同じ直し方 (代表者に家族プランを先に手動付与する): (1) `:164-165` を `/** 家族のグループのプラン (代表者に手動付与で入れる家族プラン。billing/03 §6.6 の家族の門は、家族プランの契約の無い代表者のグループにメンバーを足せない。e2e の fresh-family と同じ family_basic) */` と `const FAMILY_PLAN_KEY = 'family_basic';` に。(2) `seedFamily` の `completeProfile(admin, repId, …)` の行 (`:446`) の直後 (グループの INSERT の前。手動付与には `user_profiles` の行が要る (`BILL_UNKNOWN_USER`)) に `must('billing_grant_manual_subscription', await admin.rpc('billing_grant_manual_subscription', { p_user_id: repId, p_plan_key: FAMILY_PLAN_KEY }));` を足す (`p_expires_at` は既定の NULL = 期限なし。`20261017230000_billing_manual_plan_grant.sql:18-22`。EXECUTE は service_role。利用者を作り直すと契約の行も CASCADE で消える)。グループの INSERT の `plan_key: FAMILY_PLAN_KEY` はそのまま (billing/01 のトリガー `family_groups_billing_plan_follow_representative` が代表者の契約から同じ `family_basic` / 4 を入れる)。テストは無い (撮影の手順 `run.sh` で流す) | A |
| E2E の道具 `tests/e2e/helpers/billing-plan.ts` (新設) | — | `export async function grantManualPlanForE2e(userId: string, planKey: PaidPlanKey): Promise<void>` = `membership-family.ts` と同じ service_role の REST で `POST ${supabaseUrl}/rest/v1/rpc/billing_grant_manual_subscription` に `{ p_user_id: userId, p_plan_key: planKey, p_expires_at: null }` を送り、`!resp.ok` なら本文の先頭を付けて throw する (結合テストの `grantFamilyPlan` と同じ RPC。引数は `20261017230000_billing_manual_plan_grant.sql:18-22` の `p_user_id uuid, p_plan_key text, p_expires_at timestamptz DEFAULT NULL`、EXECUTE は service_role だけ `:103`)。fixture の後片付けは利用者の削除で契約の行も CASCADE で消える | C |
| #1911 の面 (§0.2 の対象外の欄のファイル) と、その「準備中」を見張るテスト (`tests/admin-preparing-pages.test.tsx`・`tests/preparing-notice.test.tsx`・`tests/admin-not-supported.test.ts`・`tests/super-admin-preparing-pages.test.tsx`・`tests/super-admin-exports-not-supported.test.ts`・`tests/moderation-route-contracts.test.ts`・`tests/admin-mutation-audit-coverage-1571.test.ts`・`tests/jst-today-source-scan.test.ts`・`tests/org-challenge-pages.test.tsx`・`tests/org-dashboard-refresh-route.test.tsx`・`tests/integration/operator/admin-moderation-detail.test.ts`・`tests/integration/operator/super-admin-exports.test.ts`・`tests/integration/security/super-admin-columns.test.ts`・`tests/integration/security/stop-aggregate-org-stats-cron.test.ts`・`tests/e2e/w5-12-admin-adversarial.spec.ts`・`src/__tests__/app/org/index-redirect.test.ts`) | 母集合の作り方 4 | 変更なし (#1911 が main に入れ済み。本冊は触らない) | — |
| 「準備中」が読み込み中の表示の意味で、課金と関係しないもの (`src/app/(main)/menus/weekly/_components/modals/NutritionDetailModal.tsx` の「分析を準備中...」とそのテスト・`src/app/(main)/menus/weekly/page.tsx` のコメント・`src/app/(main)/settings/security/mfa/setup/page.tsx` の「準備中…」) と、「準備中」が無いことを確かめる回帰のテスト (`src/__tests__/app/settings/data-export.test.ts`・`src/__tests__/app/settings/trainer-share-removed.test.ts`・`tests/data-share-not-consent.test.ts`・`tests/health-photo-entry.test.tsx`) | 母集合の作り方 4 の「準備中」 | 変更なし (本冊の面ではない) | — |
| `tests/integration-ci-coverage.test.ts` | 新しい結合テストのパス | `tests/integration/rls/` と `security/` に置く | A |
| `tests/no-pending-wording-1911.test.ts` (F21。`src/app`・`src/components`・`src/lib`・`src/hooks`・`apps/mobile/app`・`apps/mobile/src`・`supabase/functions` のコメントを除いたソース) | 本冊の新しいファイルと変えるファイルの文 (`src/lib/billing/iap-*.ts`・route 3 本・`src/hooks/useBillingSummary.ts`・`process-meal-image-jobs`・`_shared/meal-image.ts`・`_shared/ai-daily-limit.ts`・`PricingPageView.tsx`・`legal/page.tsx`・`faq/page.tsx`・`landing-copy.ts`・`apps/mobile/src/lib/{purchases,iap-catalog,billing-api,plan-screen}.ts`・`apps/mobile/app/settings/plan.tsx`・退会の 4 つの入口 (`src/app/(main)/settings/page.tsx`・`src/components/account/AccountSelfServicePanel.tsx`・`src/app/legal-consent/LegalConsentForm.tsx`・`apps/mobile/app/settings/account.tsx`)) | 変更なし (本冊の文 (コメントの外) に `FORBIDDEN_PATTERNS` の語は無い。`packages/shared` は走査の対象外だが、`billing-plans.ts` の文はテスト 40 が `UNFINISHED_WORDS` で見る) | B・C・D |
| `apps/mobile/__tests__/settings/account-delete.test.tsx` (origin/main `465727de` の行。`:132-138` の `Alert.alert` の偽物が、見出し「アカウント削除」のダイアログで文が「削除」のボタンを押す。`:325-339` は見出しが「アカウント削除」でない Alert を失敗の Alert として数える) | §10.4 のアプリの退会の確認 (本文とボタンが増える) | 変更なし (見出し「アカウント削除」とボタンの文「キャンセル」「削除」を変えない。偽物は「定期購読の管理を開く」を押さない)。テスト 129 を足す | C |
| `src/__tests__/app/frozen-account-page.test.tsx`・`tests/legal-consent-page.test.tsx`・`tests/legal-consent-account-page-1901.test.tsx` (凍結中の退会・規約の同意の画面の案内・同意の前の退会 (cross/20 の実装)。文は `toContain`・`[role="alert"]` の文・ボタンの文・呼んだ API の一覧で見る) | §10.4 の `<p>` が 1 つ増える (共通の部品に足すので `/frozen/account` と `/legal-consent/account` の両方) | 変更なし (足す `<p>` は `role` を持たず、ボタンも API も足さない)。テスト 128・130 を足す | C |
| `tests/ai-consent-provider-inventory.test.ts` (F25。コードの `https://` のホストの棚卸し) | `src/lib/billing/iap-core.ts` の `REVENUECAT_API_BASE_URL` (`api.revenuecat.com`)・`packages/shared/src/billing-plans.ts` の `STORE_SUBSCRIPTION_MANAGEMENT_URL` (`apps.apple.com`・`play.google.com`) | `NON_AI_HOSTS` に 3 行を足す (逐語): `'api.revenuecat.com': 'アプリ内課金の購入の確認と契約の取り直し (RevenueCat。billing/03 §8.3)。送るのは利用者の ID だけ'`・`'apps.apple.com': 'App Store の定期購読の管理のページへのリンク (billing/03 §8.9)。送信先ではない'`・`'play.google.com': 'Google Play の定期購読の管理のページへのリンク (billing/03 §8.9)。送信先ではない'` | B |
| `tests/helpers/ai-consent-enforced-paths.ts` の `ENFORCED_EDGE['process-meal-image-jobs']` (`:389-396`)・`tests/ai-usage-contract.test.ts` (`:543-545` が `recordedBy` に `AI_QUEUE_TABLES` を求める) | `process-meal-image-jobs` にプランの門を足す (§8.8) | `consent` の文に「同意のあとに、ジョブの持ち主のプランの門 (ai_plan_feature_caps の meal_image_auto = 0 なら取り消す。billing/03 §8.8) も見る」を足す。`recordedBy` は変えない (緑のまま) | B |
| `tests/meal-image-skip.test.ts`・`tests/meal-image-jobs-pickup-cron-contract.test.ts`・`tests/edge-function-cors.test.ts`・`tests/edge-function-verify-jwt.test.ts`・`tests/edge-missing-env-response.test.ts` (`process-meal-image-jobs` を名指し) | `processJob` の引数と、同意の後の門 | `meal-image-skip` にテスト 111 を足す。ほかは変更なし (貸し出しの長さ・CORS・JWT・環境変数の扱いを変えない。`edge-function-verify-jwt` は `Deno.serve(` 以降で認証より前の `.rpc(` を探すが、`readMealImageJobPlanDecision` の `.rpc(` は認証 (`requireServiceRole`) より後ろ。`edge-missing-env-response` の「設定がそろっていれば」の it は DB の罠でジョブの取得の前に 500 になり、門まで届かない)。テスト 111 の新設のソースの走査は `tests/meal-image-plan-gate-source.test.ts` | B |
| `tests/process-meal-image-jobs-worker-edges.test.ts` (#1553。ハンドラ (`index.ts`) を本物で動かし、`:150-167` の `vi.mock('@supabase/supabase-js')` が `createClient` を `{ from, storage }` だけの偽物にする。`:283-294` の `runWorker` が `expect(res.status).toBe(200)` を求め、`:472`・`:491` の it は warn の数を 1 と数える。母集合の作り方 12) | `processJob` が同意の判定の直後に `supabase.rpc("ai_plan_feature_daily_cap", …)` を呼ぶ (§8.8)。偽物に `rpc` が無いと `readMealImageJobPlanDecision` の `catch` が warn を 1 つ足して `"allowed"` を返すので、warn を数える 2 つの it が赤になる | (1) `:43-66` の `vi.hoisted` の `h` に 4 つ足す (逐語): `/** billing/03: ai_plan_feature_daily_cap の答え (既定 null = 行なし = 止めない) */ planCap: null as number \| null,`・`planCapError: null as { code: string; message: string } \| null,`・`planCapThrows: null as Error \| null,`・`rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,`。(2) `:151` の `createClient: () => ({` の中の `from` の次に `rpc: async (name: string, args: Record<string, unknown>) => { h.rpcCalls.push({ name, args }); if (h.planCapThrows) throw h.planCapThrows; return { data: h.planCap, error: h.planCapError }; },` を足す。(3) `:246` の `beforeEach` に `h.planCap = null; h.planCapError = null; h.planCapThrows = null; h.rpcCalls = [];` を足す (既存の it は `planCap = null` = 止めない・warn なしなので期待を変えない)。(4) `describe('(3) …')` の後に `describe('(4) プランの門 (billing/03 §8.8)', …)` を足し、テスト 140 (`h.planCap = 0` → `runWorker()` の結果が `{ jobId: JOB_ID, status: 'cancelled', message: 'skipped_plan' }`・`job()` が `{ status: 'cancelled', last_error: 'skipped_plan' }`・`h.generateCalls` が 0・`h.uploads` が空・`mealDish(0)` が `{ image_status: 'failed', image_error: 'skipped_plan' }`・`h.rpcCalls` が `[{ name: 'ai_plan_feature_daily_cap', args: { p_user_id: USER_ID, p_feature: 'meal_image_auto' } }]`) とテスト 141 (`'error'` は `h.planCapError = { code: 'XX000', message: 'db unavailable' }`、`'throws'` は `h.planCapThrows = new TypeError('fetch failed')` → 結果の `status` が `'completed'`・`h.generateCalls` が 1・`h.logs` の warn がちょうど 1 つで `metadata` が `{ ownerId: USER_ID }` を含む) を置く。冒頭の注に「(4) 料理画像のプランの門 (billing/03 §8.8): 0 なら作らず、読めなくても止めない」を足す。(5) `:231` の `pendingAiDishes` の注「AI の献立の料理 (画像がまだ無い pending の料理。subject_hash つき)」を「AI の献立の料理 (reconcileDishImages を通した。主菜は画像を待つ pending (subject_hash つき)、汁物は画像の無い状態 (billing/03 Q-16)。この file は主菜 (位置 0) のジョブだけを流す)」にする (期待は変えない。母集合の作り方 17) | B |

`tests/helpers/ai-consent-enforced-paths.ts` の `EXEMPT_ROUTES` に足す 3 行 (逐語。既存の `account/delete` の行の後):

```ts
// tsc:skip — tests/helpers/ai-consent-enforced-paths.ts の EXEMPT_ROUTES の末尾に足す
  // billing/03 (アプリ内課金)。RevenueCat の鍵と署名の秘密を getOptionalEnv で読むため環境変数の一覧 (src/lib/env.ts) に届くだけで、送る先は RevenueCat と DB だけ
  'src/app/api/webhooks/revenuecat/route.ts': {
    consent: 'RevenueCat からのストアの契約の知らせ。AI へは送らない (署名の秘密と鍵を読む env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'RevenueCat から契約を取り直して DB に写すだけ。送る先は RevenueCat' } },
  },
  'src/app/api/billing/iap/sync/route.ts': {
    consent: '本人のストアの契約の同期。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'RevenueCat から契約を取り直して DB に写すだけ' } },
  },
  'src/app/api/billing/subscription/route.ts': {
    consent: '契約の要約。期限を過ぎたストアの行だけ RevenueCat から取り直す (env.ts の一覧に届くだけ)。AI へは送らない',
    handlers: { GET: { noAi: 'DB の契約の要約を返すだけ (必要なときだけ RevenueCat から取り直す)' } },
  },
```

### 16.2 他の文書への追随 (専権 PATCH。本冊の設計ゲート PASS 後、実装のマージと同じ PR か直後)

**母集合の作り方**: `git grep -l -i -E "準備中|アプリ内課金|in-app purchase|RevenueCat|ai_daily_limits|究極モード|family_groups\.plan_key|create_family_group|10\.4" origin/main -- docs '*.md' ':!docs/design/billing/03-*'` で出たファイルを 1 本ずつ見る。自動の料理画像を主菜の 1 品に絞る (Q-16) 追随は `git grep -l -E "reconcileDishImages|1 dish 1 job|料理ごとにジョブ|meal_image_jobs" origin/main -- docs` で出たファイルのうち、料理画像のジョブを料理ごとに積むことを書いているもの (2026-10-19 の origin/main では 13 ファイルが出て、当たるのは `docs/meal-image-spec.md`・`docs/operations/meal-image-pipeline.md`・`docs/design/operator/06-ai-llm.md` (§5.2 の「料理画像 (#1487)」の箇条) の 3 本。`docs/meal-image-consistency-plan.md` は 2026-03 の計画の記録で対象外 (正本は `docs/meal-image-spec.md`)。ほかの 9 本は `meal_image_jobs` の表の名前・保存先・ログの文脈で挙げるだけで、積む料理の数を書かない)。

| 文書 | 箇所 | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/billing/01-billing-core.md` | 表紙の Status (配線の冊の一覧に本冊)・§0 の「アプリ内課金なし」(cross/20 §17 の「Issue #1912」の行が本冊に渡した点)・§3.1 R11「モバイル (アプリ内課金をしない)」・S14・§10.4「モバイル (アプリ内課金をしない)」・§17.3 の前提 (料金の画面の無い版)・§18 の 1 (価格)・2 (ストアの規約)・14 (特商法の文) (§13.1 の `EXT_STRIPE_NOT_CONFIGURED` の文は、billing/01 v1.12 (origin/main `359a16f9`) が main の「お支払いを受け付けていません」(#1911) に直し済みなので触らない) | §0 の「アプリ内課金なし」を「アプリ内課金 (App Store / Google Play。RevenueCat) は billing/03」に、R11 を「アプリ内課金 (App Store / Google Play) は billing/03。アプリの中に Web の購入のページへの誘導を出さない規則は保つ」に、§10.4 を「billing/03 §10.6 に置き換え (規則 = Web の購入のページへ誘導しない、のみ残す)」に、§18 の 1・2・14 を「billing/03 で確定」に | 段 B と同じ PR |
| `docs/design/billing/02-manual-plan-grant.md` | §6.3・§6.4 の M 行の述語・§7.1 の表の列 | 「M 行 = `stripe_subscription_id IS NULL AND iap_store IS NULL` (billing/03 §6.7)」に | 段 A と同じ PR |
| `docs/design/CLAUDE.md` | ドメイン構成の表の `billing/` の行 | 本冊 (`03-paid-plans-and-iap.md`。価格・線引き・アプリ内課金) を足す | 段 A と同じ PR |
| `docs/design/cross/04-api-conventions.md` | §4.2 エラーコード一覧 | §13.1 の [NEW] 7 つ (`BILL_IAP_INVALID_INPUT` / `BILL_IAP_UNKNOWN_PRODUCT` / `BILL_IAP_SYNC_CONFLICT` / `EXT_REVENUECAT_NOT_CONFIGURED` / `EXT_REVENUECAT_API_FAILED` / `AI_FEATURE_NOT_IN_PLAN` / `FAMILY_PLAN_REQUIRED`) と `EXT_STRIPE_NOT_CONFIGURED` の文 | 段 B と同じ PR |
| `docs/design/cross/08-legal-compliance.md` | §3.1 (最終確認画面の必須表示)・§7 (再同意) | §3.1 に「アプリ内課金の購入の画面はストアの要件 (billing/03 §10.6) で、特商法の確認画面は Web の Checkout だけ」を注記。§7 に本冊の段 E の版の繰り上げ (`v2026.2` → `v2026.3`) | 段 E と同じ PR |
| `docs/design/cross/08-legal-compliance.md` | §16.1 の表 (退会の「取り消し・復旧」の行) | 「確認画面には、App Store / Google Play でお申し込みの有料プランは退会しても解約されないことも出す (`STORE_SUBSCRIPTION_DELETION_NOTICE`。退会の 4 つの入口。billing/03 §10.4)」の行を足す | 段 C と同じ PR |
| `docs/design/cross/14-parental-consent.md` | §6.9 の画面の表の `minor_refused`・`guardian_missing` の行 (出すもの) | 本文の下に `STORE_SUBSCRIPTION_DELETION_NOTICE` の文 (ストアの購読は退会で解約されない。billing/03 §10.4) を足す (`guardian_missing` の「…だけ」の列挙にも入れる) | 段 C と同じ PR |
| `docs/design/cross/13a-legal-consent-api-server.md` | §6.2 許可リスト | 「billing/03 の `/api/billing/iap/*` と `/api/webhooks/revenuecat` は許可リストに入れない (Webhook はセッションを持たない受け口で、同意のゲートの対象外の形は Stripe と同じ)」を注記 | 段 B と同じ PR |
| `docs/design/mobile/01-architecture.md` | billing/01 §10.4 で足した「アプリ内に購入導線を出さない」の節 | 「アプリ内課金の購入の画面 (`app/settings/plan.tsx`。billing/03 §10.6)。Web の購入のページへの誘導は引き続き出さない」に書き換え、`react-native-purchases` と `expo-dev-client` (開発ビルドが要る) を依存の一覧に足す | 段 D と同じ PR |
| `docs/design/mobile/07-toolchain-upgrade.md` | 依存の一覧・開発ビルド | `react-native-purchases` 10.14.0・`expo-dev-client` ~58.0.14・「Expo Go では購入が動かない (Preview API Mode)」を足す (lockfile の置き場の §2.4 は変えない。足した 2 つとその依存はルートに置かれ、`apps/mobile/node_modules` の入れ子は `react` と `@types/react` の 2 つのまま。本冊 §8.10 の「依存の追加と `package-lock.json` の作り直し」) | 段 D と同じ PR |
| `docs/design/operator/04-plan-management.md` | §3.1 (価格の既定)・§5.2 (試用)・§4.1 (クーポンの適用) | 価格を本冊の値に・試用の「同じプランで 1 回」にストアの試用 (`trial_source` = ストア) の片向きの共有を注記。§4.1 に「App Store / Google Play の契約 (`iap_store` のある行) にも適用の記録は付けられるが、ストアの請求の額は変わらない (`apply_coupon` は DB の記録だけで、Stripe にもストアにも送らない。billing/03 §7.1)」を注記 | 段 A と同じ PR |
| `docs/design/operator/06-ai-llm.md`・`cross/06-perf-cache.md` (AI の上限の運営画面) | `/super-admin/llm/quotas` | 「プランごとの 1 日の上限は 4 行 (free 3 / pro 30 / family_basic 30 / family_pro 50)。機能ごとの上限 `ai_plan_feature_caps` は運営画面に無く SQL で変える (billing/03 §6.5)」を注記 | 段 A と同じ PR |
| `docs/design/operator/07-audit-monitoring.md` | §4.5 システム自動操作 | `system.revenuecat.event_failed` を足す (`target_type` の値 `revenuecat_event`)。`tests/billing-audit-action-lists-doc.test.ts` の規則 (`*.billing.*` でないので一覧の突き合わせの対象外) | 段 B と同じ PR |
| `docs/design/operator/01-data-model.md` | §3.7 DDL・§4 ER 図 | `personal_subscriptions` の 3 列・`plan_store_products`・`revenuecat_webhook_events`・`ai_plan_feature_caps` | 段 A と同じ PR |
| `docs/design/operator/09-runbook.md` | §3.2 適用順序の図・運用の手順 | 新設の 3 表と、`plan_store_products` に行を入れる手順 (§17.2)。二重購読の処置の表 (§13.3 の表をそのまま) と、App Store 同士のときの確かめ方 (監査 `system.billing.subscription_status_changed` の `details.source` が `:superseded` で終わる行) と利用者へ送る案内の文 (「どちらか一方の購読を App Store の定期購読の管理で解約し、その購入の返金を reportaproblem.apple.com から Apple にお申し込みください」)。`iap_is_sandbox = true` の行の見方 (テストの購入。売上ではない) | 段 A と同じ PR (二重購読の処置は段 B と同じ PR) |
| `docs/design/operator/06-ai-llm.md` (料理画像の見送りの理由 `skipped_ai_limit` を書いている箇所。`git grep -n "skipped_ai_limit" origin/main -- docs` で 1 ファイル) | 見送りの理由の一覧 | `skipped_plan` (ご利用中のプランでは自動の料理画像を作らない。`ai_plan_feature_caps` の `meal_image_auto` = 0。billing/03 §8.8) を足す | 段 B と同じ PR |
| `docs/design/family/01-data-model.md`・`family/CLAUDE.md`・`membership/02-flow-spec.md` | `create_family_group`・メンバーの追加 | 「家族グループの作成とメンバーの追加は家族プランの契約者だけ (`FAMILY_PLAN_REQUIRED`。billing/03 §6.6)。契約が終わったグループのメンバーはそのまま」を注記 | 段 A と同じ PR |
| `docs/design/marketing/01-landing-site.md` | 料金の章の表 (§4.17・§8.3 のカードの数。#1911 の後は 1 枚)・要点 (trust)・FAQ・家族の章・場面・features の家族のカード・`ASSURANCES`・`SITE_DESCRIPTION`・§24 の Q-12・`claims` の `free-now` / `family` / `ai-daily-limit` | §10.5 の表の文に合わせる (カードは無料プランと有料プランの 2 枚・`free-now` の主張を「無料プランの範囲と有料プラン 3 つ」に)。§13.1 の幅の表の `\| 未ログイン \|` の 2 行の「料金はカード 1 枚」を「料金はカード 2 枚」に、主張 `free-now` の根拠を指す 3 つの行 (§4.1・§19・§20。行の頭は変えない) の `PricingPageView.tsx` の行の番号を、段 C の後の 2 か所 (無料のカードの `FREE_PLAN_FEATURES`・有料のカードの `PLAN_CATALOG` の `features`) の同じ組に直す (`tests/landing-pricing-doc-1911.test.ts` が見る。§16.1 の行)。§19 の `#1151` の行の 3 列目の上限の文の場所「フリーのカードと、買えるプランが無いときの FAQ」は、§10.1 で FAQ の節が無くなるので「フリーのカード」だけにする。§8.1 の `src/components/marketing/` の import の許可先の一覧 (U-10) に `@homegohan/shared` (料金の文の定数。`landing-copy.ts` だけが使う) を足す (§16.1 の landing-page-1867 の行) | 段 C と同じ PR |
| `docs/design/cross/20-terms-privacy-text.md` | §0.1 P-5・F-57 (「有料プランは買えない」)・§0.6 の「有料プランの価格と条件」の行・§6 の第10条・第11条 1 項・第16条 2 項・第17条・第24条の文・§7 の第3条・第4条・第7条 (`PRIVACY_PROCESSORS` と注)・第10条・第12条・§10.2 の区分の数と §10.3 の主張の表 (`LEGAL_CLAIM_COUNT` 382 → 424 (cross/20 v1.16 の §10.2・§10.3 の値から。§11.4 の区分の数))・§13 の T-33・T-34 と §13.1 の定数 (`LEGAL_TEXT_PAID_TERMS` の使い方・`PRIVACY_DATA_TABLES` 72 → 74・`PRIVACY_DATA_EXCLUDED` 18 → 16・`PAID_PLAN_WRITER_*` を消す)・§17 の「Issue #1912」の行 (ストアの事業者を第7条に載せない (本冊 Q-17)・Q-6 は置かない (本冊 Q-14)・Q-21 は本冊 Q-15)・§18 の Q-6・Q-21 の結論・§9.1 の版 (`v2026.3`)・§9.3 の「版を上げる改定すべて」の行 (v2026.3 の公開で §9.4 の 2 を省いたときだけ、除外に v2026.3 を書き足す。行ったときは変えない。§11.6) | 本冊 §11 の差分を文の正典に写す (cross/20 が規約とポリシーの本文の正典なので、段 E の実装のあと、本文と主張の表を cross/20 に戻す) | 段 E と同じ PR |
| `.env.example`・`ENV_SETUP.md`・`apps/mobile/env.example` | 課金の節 | §8.7 | 段 B / D |
| `docs/meal-image-spec.md` | FR-2 (「`generate-menu-v4` が meal を保存したとき、各 dish について … `meal_image_jobs` に 1 dish 1 job で enqueue」)・FR-3 (直接の更新の経路で変わった dish を enqueue)・FR-5 (詳細は `dish.image_url` 優先、`meal.imageUrl` fallback) | FR-2・FR-3 に「自動で積むのは献立の主菜の 1 品だけ (役割 `main` / `主菜` の最初の料理、主菜の無い献立は先頭の料理。`autoImageDishIndexOf`。ほかの料理は画像の無い状態。billing/03 §8.8・Q-16)」を、FR-5 に「献立のカバーを代わりに出すのは、1 品の献立・主菜・写真や商品の料理だけ (`mealCoverRepresentsDish`。billing/03 §10.3)」を足す | 段 B と同じ PR |
| `docs/design/operator/06-ai-llm.md` | §5.2 の「料理画像 (#1487)」の箇条 (ジョブを積む料理の規則と、#1553 の作り直しの (a)) | 箇条の最初に「ジョブを積むのは献立の主菜の 1 品だけ (役割 `main` / `主菜` の最初の料理、主菜の無い献立は先頭の料理。`autoImageDishIndexOf`)。ほかの料理に積もうとした種は落とし、画像の無い状態 (状態なし・subject_hash なし) にする。主菜でない料理だけを変えた保存は安全弁の 1 回を数えない (billing/03 §8.8・Q-16)」を足し、(a) の「AI の画像のジョブを積み」「AI の画像の料理 (…) にしてジョブを積む」に「(献立の主菜のときだけ)」を足す | 段 B と同じ PR |
| `docs/operations/meal-image-pipeline.md` | §2 の B の行 (「`saveMealToDb` が料理ごとにジョブを積む」)・A の行・§4 の積み直しの道具の「対象の料理」 | B を「`saveMealToDb` が各食の主菜の 1 品にだけジョブを積む (billing/03 Q-16)」に、A に「積むのは献立の主菜の 1 品だけ (ほかの料理だけを変えた保存は数えない)」を足し、§4 の対象の料理の箇条に「献立の主菜 (自動の料理画像を作る 1 品) であること。主菜でない待ちの料理は `not_auto_image_dish` で数えるだけ (billing/03 Q-16)」を足す | 段 B と同じ PR |
| `supabase/functions/README.md` (上の母集合の作り方の `ai_daily_limits` に当たる) | 「AI 利用回数の上限と記録」の節の最初の段落 (`:292`。「既定は free = 1 日 10 回」と究極モードの 1 日 1 回) | 専権 PATCH にしない。コードの置き場所の README なので、§16.1 の「free = 10 の文」の行の直し方で段 A の実装が直す (§15.2 の変更の一覧に入っている) | 段 A と同じ PR |
| `README.md`・`CLAUDE.md` (リポジトリの根) に「準備中」「アプリ内課金をしない」の記述があれば | 母集合の作り方の grep | 本冊の規則に書き換える | 段 B と同じ PR |
| `docs/handover/**`・`docs/bug-fix-report-*.md` | その時点の記録 | 対象外 | — |

### 16.3 共有面の台帳 (2 つ以上の PR が触る面)

| 共有面 | 本冊の段 | ほかに触るもの | 衝突の避け方 |
|---|---|---|---|
| `supabase/migrations/` の番号・`rollbacks/` | A | ほかの migration の PR | 番号はマージの直前に確定 (§6.1) |
| `src/types/database.types.ts`・`packages/shared/src/database.types.ts` | A | ほかの migration の PR | マージの直前の main で再生成 |
| 既存の関数の置き換え (`create_family_group`・`consume_ai_usage_at`・`consume_ai_usage_capped_at`・手動付与の 2 関数と PROCEDURE 1 本) | A | それらを変える PR | マージの直前に `git grep -l` で最新の定義を確かめ、それを土台に作り直す (§6.5〜§6.7)。「最後の定義」を固定するテスト (§16.1 の母集合の作り方 9。2026-10-19 は `create_family_group` の 2 本と、`consume_ai_usage_at`・`consume_ai_usage_capped_at` を見る `tests/ai-usage-contract.test.ts` の 1 本) も、マージの直前の main で流し直して同じ PR で直す |
| `personal_subscriptions` の列・部分 UNIQUE | A | 配線の残りの冊 | 列の追加だけ (CHECK・既存の索引は触らない) |
| `src/lib/env.ts`・`.env.example`・`ENV_SETUP.md` | B | 環境変数を足す PR | 行の追加だけ。節の番号を増やさない |
| `cross/04` のエラー表 | B | エラーコードを足す PR | 専権 PATCH で集める |
| `tests/helpers/ai-consent-enforced-paths.ts`・`null-character-routes.test.ts`・メンテナンスの見張りのテスト (`src/__tests__/lib/maintenance-mode.test.ts`・`lib/supabase/__tests__/middleware-maintenance.test.ts`) | B | route を足す PR | 行の追加だけ (`maintenance-mode.ts` と `middleware.ts` は変えない。§9.1) |
| `src/lib/billing/core.ts` (`BillingSummary`・`summarizeSubscription`) | B | 配線の残りの冊 | 項目の追加だけ (`BILLING_ERROR_MESSAGES` は変えない) |
| `supabase/functions/process-meal-image-jobs/index.ts` (料理画像のジョブの処理) と、そのハンドラを本物で動かす `tests/process-meal-image-jobs-worker-edges.test.ts` | B | 料理画像の処理を変える PR | 同意の門の直後に門を 1 つ足し、テストの偽の client に `rpc` を足すだけ。マージの直前に `git log -- supabase/functions/process-meal-image-jobs tests/process-meal-image-jobs-worker-edges.test.ts` で後から入った変更を確かめる |
| `supabase/functions/_shared/meal-image.ts` の `reconcileDishImages` (料理画像のジョブの種。料理の保存・更新の 4 本の route・AI 相談・献立の作成 (Edge) と積み直しの道具 `scripts/lib/meal-image-backfill.ts`・Web の献立の画面 `page.tsx` が読む) と、それを本物で通すテスト (§16.1 の母集合の作り方 17 の 8 本) | B | 料理画像の扱いを変える PR (#1487・#1505・#1553 の系列)・献立の画面を変える PR | 関数の最後の絞り込み (`autoImageDishIndexOf`) と、同じファイルに名前を足すだけ (既存の枝は変えない)。マージの直前に `git log -- supabase/functions/_shared/meal-image.ts scripts/lib/meal-image-backfill.ts 'src/app/(main)/menus/weekly/page.tsx'` で後から入った変更を確かめ、母集合の作り方 17 の grep を流し直す |
| `scripts/guide-screenshots/seed.ts` (使い方ページの撮影の種まき) | A | 使い方ページの撮影の PR (F1 の常設のレーン) | 家族の代表者への手動付与の 1 行と定数の値だけ。マージの直前に `git log -- scripts/guide-screenshots/seed.ts` で後から入った変更を確かめる |
| `tests/admin-audit-logs-insert-policy-migration-contract.test.ts` の `DIRECT_INSERT_ALLOWED` | B | `admin_audit_logs` に直接書くファイルを足す PR | 一覧に 1 行足すだけ |
| 公開の面 (`PricingPageView`・`legal`・`faq`・`landing-copy.ts`・`marketing.css`) と `tests/public-claims-guard.test.ts`・`tests/no-pending-wording-1911.test.ts` | C | #1911 (main にマージ済み。`4b1e1abe`)・ほかに公開の面を触る PR | 本冊は #1911 の後の main を土台に書いた (§10.1〜§10.5 の行番号は `4b1e1abe`)。段 C の着手の時に `git log 4b1e1abe..origin/main -- <これらのファイル>` で後から入った変更を確かめ、あれば本冊の差分をその上に当てる (main が正) |
| `src/lib/legal/terms-text.ts`・`privacy-text.ts`・`tests/legal-claims-1901.ts`・`tests/legal-text-1901.test.ts`・`legal-versions.ts`・`docs/legal/archive/` | E | cross/20 (#1901) の実装 (origin/main `2ba5b3b3` でマージ済み)・#1917 (family/11 の実装。origin/main `465727de` でマージ済み) | #1917 (`465727de`) が版 `v2026.2` と旧版の控え `docs/legal/archive/v2026.1/` を先に使い、利用規約第11条 4 項・第12条 4 項・第17条 2 項・プライバシーポリシー第13条 9 項と主張の表の 6 行を変えた。段 E の版は `v2026.3`、旧版の控えは `docs/legal/archive/v2026.2/` (§11.6)。段 E の着手の時に `git log 465727de..origin/main -- <これらのファイル>` で後から入った変更を確かめ、あれば本冊の差分をその上に当てる (main が正。§11.0)。版が `v2026.2` から変わっていたら、段 E の版はその次にし、旧版の控えはその版の名前で作る。ほかに規約とポリシーの文を変える PR があれば直列にし、版はそれぞれ 1 つずつ上げる (cross/20 §9.3) |
| `apps/mobile/package.json`・`jest.config.js`・設定タブ・`AuthProvider`・`signOut.ts` | D | モバイルを変える PR | 行の追加だけ |
| `package-lock.json` (ルート。npm workspaces の 1 つの lock) | D | Dependabot の PR (週 1 回。ルートの lock)・依存を変えるほかの PR | 手で衝突を解かない。マージの直前の main の lock を土台に §8.10 の「依存の追加と `package-lock.json` の作り直し」の 2〜4 をやり直し、依存の宣言か lock を読む番兵 6 本 (§16.1 の母集合の作り方 13) を流し直す |
| `src/lib/errors/membership-errors.ts` (`MembershipErrorCode`) | B | `docs/design/family/11-self-dissolve.md` (#1917。設計は origin/main `f89ba354`、実装は `465727de` でマージ済み。解散のエラーコードを足した) | どちらも行の追加だけ (本冊は `FAMILY_PLAN_REQUIRED`)。family/11 の行が先に入ったので、本冊の段 B がマージの直前に `git log -- src/lib/errors/membership-errors.ts` で入った行を確かめて並べる。family/11 が足した凍結中と同意の前に通す API の 2 本 (`src/lib/auth/frozen.ts`・`packages/shared/src/legal-consent-api.ts`) は本冊が変えないファイルで、テスト 118 は本冊の 2 本が一覧に無いことだけを見るので、どちらが先に入っても赤にならない |

---

## 17. 本番の準備手順 (運用。秘密の値は発注者の作業)

### 17.1 順番 (§12 の表のとおり)

段 A・B・C のマージと本番の反映 と、cross/20 の実装と段 B のあとの段 E (規約とポリシーの有料の条文) の公開 → Stripe の有効化 (発注者) → 鍵と Price (= Web の販売開始) / 段 B・D のマージ → ストアと RevenueCat の設定 (発注者) → 鍵と商品の行 → 段 E の公開のあとに本番のビルドの提出と審査 (= アプリの販売開始)。

### 17.2 ストアの商品 ID と `plan_store_products` の行 (運営が SQL で入れる。`super_admin` の RLS でも書ける)

| plan_key | 間隔 | App Store の商品 ID (Subscription Group `homegohan_plans`) | App Store のグループの中のレベル (1 が最上位) | Google Play の購読 ID : base plan ID |
|---|---|---|---|---|
| `pro` | month | `homegohan_pro_month` | 3 | `homegohan_pro:monthly-autorenewing` |
| `pro` | year | `homegohan_pro_year` | 3 | `homegohan_pro:annual-autorenewing` |
| `family_basic` | month | `homegohan_family_basic_month` | 2 | `homegohan_family_basic:monthly-autorenewing` |
| `family_basic` | year | `homegohan_family_basic_year` | 2 | `homegohan_family_basic:annual-autorenewing` |
| `family_pro` | month | `homegohan_family_pro_month` | 1 | `homegohan_family_pro:monthly-autorenewing` |
| `family_pro` | year | `homegohan_family_pro_year` | 1 | `homegohan_family_pro:annual-autorenewing` |

- グループの中のレベル (App Store Connect の Subscription Group で、商品をドラッグして並べる順。P18): 提供する内容と月額の多い順に、家族 Pro (1,480 円。1 日 50 回・究極 3 回・8 人) > 家族 Basic (980 円。1 日 30 回・究極 2 回・4 人) > 個人 Pro (580 円。1 日 30 回・究極 2 回。家族なし) (価格は §0.4、回数は §0.6 の確定の値 (Q-2・Q-3。§0.4 の追記 3)。運営があとで回数を変えても、家族 Basic は個人 Pro の内容に家族を足したもの・家族 Pro は家族 Basic より多いものとして順は変えない)。同じプランの月額と年額は同じレベルに置く。これで、個人 Pro → 家族 Basic / 家族 Pro と家族 Basic → 家族 Pro は上位への変更 (すぐに効く)、逆向きは下位への変更 (期間の終わりに効く)、同じプランの月額 ⇄ 年額は期間の違う crossgrade (期間の終わりに効く。S32) になる (P18)。すぐに効く変更で取り直しに 2 つの商品が live で並んだときの写し方は §7.3 の「同じグループの 2 つの live」の行 (S36)。レベルは当社のコードに持たない (写像はレベルを見ず、`purchase_date` の新しい方を権利にする)。

```sql
-- tsc:skip 運営が本番で流す (service_role / super_admin)。商品 ID は実際に作ったものに合わせる
INSERT INTO public.plan_store_products (plan_key, store, billing_interval, product_id) VALUES  -- offered は既定の true
  ('pro', 'app_store', 'month', 'homegohan_pro_month'), ('pro', 'app_store', 'year', 'homegohan_pro_year'),
  ('family_basic', 'app_store', 'month', 'homegohan_family_basic_month'), ('family_basic', 'app_store', 'year', 'homegohan_family_basic_year'),
  ('family_pro', 'app_store', 'month', 'homegohan_family_pro_month'), ('family_pro', 'app_store', 'year', 'homegohan_family_pro_year'),
  ('pro', 'play_store', 'month', 'homegohan_pro:monthly-autorenewing'), ('pro', 'play_store', 'year', 'homegohan_pro:annual-autorenewing'),
  ('family_basic', 'play_store', 'month', 'homegohan_family_basic:monthly-autorenewing'), ('family_basic', 'play_store', 'year', 'homegohan_family_basic:annual-autorenewing'),
  ('family_pro', 'play_store', 'month', 'homegohan_family_pro:monthly-autorenewing'), ('family_pro', 'play_store', 'year', 'homegohan_family_pro:annual-autorenewing')
ON CONFLICT (store, product_id) DO UPDATE SET plan_key = EXCLUDED.plan_key, billing_interval = EXCLUDED.billing_interval, offered = true, updated_at = now();
```

- 商品を差し替えるとき (同じプランと間隔で新しい商品 ID を売る) は、古い行を `offered = false` にしてから新しい行を足す (古い行は消さない。購入の履歴の商品の `plan_key` を引くため。S28)。`offered = true` の行が同じプラン・ストア・間隔に 2 つあると `idx_plan_store_products_offered` で失敗する:

```sql
-- tsc:skip 運営が本番で流す。<旧い商品 ID> / <新しい商品 ID> は実際の値
UPDATE public.plan_store_products SET offered = false, updated_at = now() WHERE store = 'app_store' AND product_id = '<旧い商品 ID>';
INSERT INTO public.plan_store_products (plan_key, store, billing_interval, product_id) VALUES ('pro', 'app_store', 'month', '<新しい商品 ID>');
```

- RevenueCat: Entitlement `pro` ← `homegohan_pro_month` / `_year` と Google の 2 つ、`family_basic` と `family_pro` も同様。Offering `default` に 6 つの package (`$rc_monthly` / `$rc_annual` を使わず、商品ごとに custom の identifier (例 `pro_month`) にする。アプリは package の identifier を見ず `product.identifier` で突き合わせる)。
- Apple の無料体験は Introductory Offer (Free trial・7 日)、Google は base plan の offer (free trial・7 日) で設定する。価格は Q-1。

### 17.3 Vercel / EAS / Supabase

- Vercel (本番): `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET`。RevenueCat の Webhook の URL は本番の 1 つ (`https://<サイト>/api/webhooks/revenuecat`) だけを登録する。sandbox の購入 (審査・TestFlight・内部テスト) も本番の受け口と本番の DB に写る (Q-13。行は `iap_is_sandbox = true`)。
- EAS: `EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY` (公開 SDK キー)。`eas build --profile development` (sandbox の確認)・`preview` (APK。手元の端末への直接の配布だけ。Google Play には上げない)・`production` (AAB。Google Play の内部テストのトラックへの最初の上げ (§12 の順 4) と、両ストアの審査に出すビルド)。
- migration の適用 (段 A のマージ後。追加 + 3 行の UPDATE)。

### 17.4 受け入れの確認 (整合ゲートで読み取り・実機)

- `/pricing` に 3 プランの価格・無料体験・内容が出て、Price の登録の前は CTA が無い (「現在は無料」・FAQ の節が無い)。`/legal` に販売の 9 行 (販売価格の 3 行を含む) と #1911 の会社情報。`/faq` に料金の 4 項目。紹介ページの料金の章にカード 2 枚。どのページにも「準備中」「販売開始前」「いまは無料」が無い。
- 無料の利用者: 献立の作成 4 回目が 429 (「今日の献立の作成の利用回数の上限 (3 回) に達しました。…」)、1 週間の献立を作ると献立は保存され料理画像は作られない (料理の `image_error = 'skipped_plan'`・`meal_image_jobs` は `cancelled`。S27)、究極モードのトグルが錠、料理画像の作成が 403 (「料理画像の作成は、有料プランでお使いいただけます。」)、料理の保存で画像が付かず料理の画面に有料プランの案内、家族グループの作成が 402。
- 手動付与で `pro` にした利用者: 1 日 30 回・究極 2 回・料理画像が作れる。`family_basic` の利用者: グループを作れ、4 人まで足せる。
- iOS (TestFlight・sandbox のアカウント。本番の受け口と本番の DB): 設定 → プランとお支払い → 個人 Pro 月額 (ストアの価格の表示・7 日間無料の表示・自動更新の文) → 購入 → `personal_subscriptions` に `trialing`・`iap_store='app_store'`・`iap_is_sandbox = true`・`plan_key_cached='pro'`・`admin_audit_logs` に `subscription_created`。`revenuecat_webhook_events` に `INITIAL_PURCHASE` が `completed`。Web の `/account/billing` に「App Store でご契約中」。購入を復元 → 同じ行。sandbox の時間の進みで `RENEWAL` → `current_period_end` が進む。自動更新を切る → `cancel_at_period_end=true`。別の sandbox のアカウントで個人 Pro の体験中に iOS の設定の購読の管理から家族 Pro の月額に変える → 個人 Pro の行が `expired` (監査の `details.source` が `:superseded` で終わる)・家族 Pro の行が live・`plan_key_cached='family_pro'`・同期の API が 200 (S36)。
- Android (内部テスト): 同じ流れで `play_store`。
- 二重購読: Stripe で契約中の利用者のアプリに購入のボタンが出ない。
- App Store の審査の購入 (sandbox): 審査のあとに `personal_subscriptions` に `iap_is_sandbox = true` の行が live で写っていた (読み取りで確かめる。S24)。
- 退会: ストアの契約がある利用者を退会 → 行が消え、次の Webhook が 200 (`user_deleted`)。アプリの設定 → アカウント →「アカウント削除」の確認に、取り消しの文に続けて `STORE_SUBSCRIPTION_DELETION_NOTICE` の文が出て、「定期購読の管理を開く」で App Store (Android は Google Play) の購読の管理が開き、退会はしない (S35)。Web の設定 (ブラウザ)・`/frozen/account`・`/legal-consent/account`・規約の同意の画面の「登録をやめる」の案内にも同じ文が出る。
- ストアのメタデータ (§17.5): App Store の製品ページの説明に利用規約とプライバシーポリシーの URL があり、App のプライバシーに購入履歴がある。Google Play のデータ セーフティに購入履歴がある。

### 17.5 ストアのメタデータとプライバシーの申告 (§12 の順 4。発注者の作業。P16・R25)

審査の提出 (§12 の順 5) の前に入れる。`<サイト>` は本番のサイトの URL (アプリの `getTermsUrl()` / `getPrivacyUrl()` (`apps/mobile/src/lib/siteConfig.ts:49-56`) が開くページと同じ)。どれもストアの管理画面の設定で、当社のコードは変えない。

| ストア | 欄 | 入れるもの |
|---|---|---|
| App Store Connect | App 情報 → Privacy Policy URL (必須) | `https://<サイト>/privacy` |
| App Store Connect | App 情報 → License Agreement | Apple の標準の EULA のまま (custom EULA を入れない。当社の利用規約は次の行の説明文のリンクで示す) |
| App Store Connect | 各バージョン → 説明 (Description) の最後 | 次の 2 行 (逐語): `利用規約: https://<サイト>/terms` と `プライバシーポリシー: https://<サイト>/privacy` |
| App Store Connect | App のプライバシー (App Privacy) | 購入 (Purchases) → 購入履歴 (Purchase History) を足す: 収集する・ユーザーに紐づく (RevenueCat の app user ID は利用者の id で、メールアドレスに結び付く)・トラッキングに使わない・目的は App の機能 (App Functionality) と分析 (Analytics) (RevenueCat の案内のとおり)。識別子 (Identifiers) → ユーザー ID (User ID) がいまの回答に無ければ同じ扱いで足す。ほかの回答は変えない |
| Play Console | アプリのコンテンツ → プライバシー ポリシー (必須) | `https://<サイト>/privacy` |
| Play Console | アプリのコンテンツ → データ セーフティ | 金融情報 (Financial info) → 購入履歴 (Purchase history) を足す: 収集する・共有しない (RevenueCat は当社の指示で処理する service provider で、Google の定義では共有に当たらない)・一時的な処理ではない・任意ではない・目的はアプリの機能と分析。送信の暗号化は「はい」。ほかの回答は変えない |

---

## 18. 未解決事項 (openQuestions)

| # | 項目 | 本冊の仮置き |
|---|---|---|
| 1 | Q-1・Q-5〜Q-7・Q-10〜Q-15・Q-17・Q-18 (§0.5。Q-8・Q-9 は #1911 で確認済み、Q-2・Q-3・Q-4・Q-16 は 2026-10-19 の選択で確定 (§0.4 の追記 3)) | 推奨の値 (§0.6 の表)。発注者が確かめるか作業するもの (Q-1・Q-7・Q-12) は §12 の一覧 |
| 2 | App Store の日本の価格帯の一覧 (580 / 980 / 1,480 / 5,800 / 9,800 / 14,800 円が選べるか) は App Store Connect でしか確かめられない | Q-1 |
| 3 | 献立の作成の既定の LLM (`V4_FAST_LLM_PROVIDER`。本番で xAI か OpenAI か) と 1 回の token 数は本番の設定とログを読まないと分からない。§2.4 の原価は推計 | 推計で Q-2・Q-3・Q-16 の推奨を出し、発注者が選んだ (§0.4 の追記 3)。料理画像の 1 枚の単価も推計。主菜の 1 品だけにしても、週 1 回の 1 週間の作成で料理画像が月 ≈ 900 円 (推計) で、個人 Pro の月額 580 円を超えうる (§2.4)。販売開始の後、本番の記録 (`llm_usage_logs`・`app_logs`) で 1 週間の実測を取り、原価が価格を超えるなら回数か料理画像の量を見直す別の冊を立てる |
| 4 | RevenueCat の Webhook の再送が 5 回で止まること (P4) への網は、本人の操作からの同期と遅延の再同期 (Q-11)。本人が使わない契約の更新は写らないまま期限を迎える (権利が無い間は `expired` のまま) | 日次の reconcile (RevenueCat の全契約の列挙は API に無い (P5 の検索の結果) ので、`personal_subscriptions` のストアの live 行を 1 件ずつ取り直す) は配線の残りの冊 |
| 5 | Web で試用済みの利用者がストアで同じプランの試用を受けること (Q-10 の逆向き) | 止められない (ストアの判定)。許容する |
| 6 | 家族プランの無い利用者が招待を作れる (承諾で 402) こと | 招待の作成の route でも `billing_has_live_family_plan` を見て 402 にするかは family の冊。本冊は承諾の門だけ |
| 7 | 契約が終わった家族グループのメンバーの扱い (そのまま。Q-4) | billing/01 §18 の 15 と同じ |
| 8 | 二重購読の 2 本目の扱い。App Store の購入は開発者が返金できない (P14) | 当社が解約・返金できるもの (Stripe・手動付与・Google Play) は当社が処置し、App Store 同士は利用者に一方の解約と Apple への返金の申し込みを案内する (§13.3 の表。手順は `operator/09` の追随。§16.2)。App Store 同士は、同じ Apple ID のグループの中の変更 (S36) と別の Apple ID の二重購読を見分けられない (RevenueCat の `subscriptions` に Apple ID は無い) ので、どちらも写像は新しい方を権利にして止めない。別の Apple ID の二重購読は、どちらかが更新されるたびに `purchase_date` の新しい方へ権利が移る (状態の変化として監査に残る) が、問い合わせで一方が解約されるまでの間だけで、利用者はどちらかの有料プランを使い続けられる |
| 9 | ストアの `grace` (当社の `grace` = Stripe の配線のジョブが進める状態) をストアの行で使うか | 使わない (ストアの猶予期間は `past_due` で表す。§7.3) |
| 10 | `management_url` (RevenueCat) が null のときの行き先 | `STORE_SUBSCRIPTION_MANAGEMENT_URL` (§8.9) |
| 11 | モバイルの `/account/billing` の WebView の表示 (読み取り専用のまま) とネイティブの購入の画面の二重 | 本冊はネイティブの画面を正にし、WebView の `/account/billing` は Web の文のまま (リンクは出さない) |
| 12 | 運営画面での `plan_store_products`・`ai_plan_feature_caps` の編集 | SQL (§17.2)。画面は配線の残りの冊 |
| 13 | Google Play の Billing Library の版 (2026-08-31 以降は 8 以上。P8) を `react-native-purchases` 10.14.0 が満たすか | RevenueCat のリリースノートに版の記述が無い (P2・P8)。段 D の EAS のビルドで `purchases-android` の依存を確かめ、満たさなければ `react-native-purchases` を上げる |
| 14 | Apple の審査で「Web でご契約中」の文 (S3) が 3.1.3 の「誘導」と見なされるか | リンクを置かず、文だけにする (3.1.3(b) で Web の契約の利用は認められる)。指摘があれば文を「別の方法でご契約中」に |
| 15 | スマホソフトウェア競争促進法 (2025-12-18 施行) による外部決済の扱い | 本冊はストアの決済だけを使う (§0.4)。外部決済への誘導は作らない |
| 16 | `trial_source` の値 `app_store` / `play_store` を読む運営の画面があるか | 実装時に grep (`git grep -n trial_source origin/main -- src`) で確かめ、`'checkout'` を前提にした分岐があれば `IAP_STORES` を足す |
| 17 | テストの購入 (sandbox) を本番で権利にすること (Q-13) の悪用 | 販売開始の後、運営が `iap_is_sandbox = true` の行を確かめる。審査・TestFlight・ライセンステスターのほかの利用者の行が出たら、許可の一覧 (利用者 ID) の仕組みを別の冊で足す |
| 18 | プライバシーポリシーの保存期間 | §11.2 (e) で有料プランの 4 行を足した (契約の行は退会で消える・顧客とクーポンの記録は紐づけを外して残る・通知の記録は利用者の ID とともに残る・事業者の記録は各事業者の規約)。通知の記録を消す仕組み (保存の期限) は無く、作るなら別の冊で第12条を直して版を上げる |
| 19 | 凍結のファイル `src/app/api/super-admin/llm/quotas/route.ts:12` のコメント「既定は free = 1 日 10 回。migration 20261011020000_ai_daily_limits.sql」が本冊の migration の後の free (3) と合わない | 本冊は凍結 (§15.2) を守って触らない。運営の画面の冊 (operator/06) の次の改定で、コメントを「free の行の値 (billing/03 §6.5)」に直す |
| 20 | `menu_generation` が 1 週間の作成と 1 食の作り直しを同じ 1 回で数えること (無料は合わせて 1 日 3 回) | Q-3 の代替案 (1)。作り直しが 1 週間の作成を止めるのが問題になれば、1 週間の作成を別の機能名で数える冊を立てる |
| 21 | 料理画像のプランの門 (`process-meal-image-jobs`) は、`ai_plan_feature_daily_cap` を読めなかったとき (RPC がエラーを返した・投げた) 止めない (fail-open) | `consume_ai_usage` の「判定に失敗したときは止めない」と同じ扱い (§8.8)。投げたときも `readMealImageJobPlanDecision` が捕まえて `"allowed"` を返すので、ジョブは貸し出し中のまま残らず、同じ実行の残りのジョブも処理される (テスト 141)。読めない間は無料の利用者にも料理画像が作られうるが、DB が読めない間は同意の判定 (fail-closed) がジョブを取り消すことが多い |
| 22 | 段 E は cross/20 の実装のマージを待つ | 解消: cross/20 の実装は origin/main `2ba5b3b3` (#1918) でマージされた。段 E が待つのは本冊の段 B のマージだけ (§11.0・§15.1) |
| 23 | 退会のときに RevenueCat の顧客の記録 (app user ID = 利用者の id と購入履歴) を消すか (RevenueCat の案内は、データ セーフティの削除の依頼をお問い合わせで受け、Dashboard か REST API で顧客を消す形。P16) | 本冊は消さない (プライバシーポリシーの保存期間 (§11.2 (e)) の「事業者の記録は各事業者の規約」のまま)。退会の段階に RevenueCat の顧客の削除を足すかは、運営の手順 (`operator/09`) か別の冊で決める |
| 24 | App Store で体験中の購読を、当社がまだ写していないうちに上位へ変えた (最初の取り直しに、体験の商品と変えた先の商品が両方 live で並ぶ) とき、体験の商品は置き換えられた購読として `expired` の履歴の行で INSERT され、`trial_started_at` が入らない (写像の 6. は `trialing` のときだけ試用の列を書く。§6.4) | 許容する: その利用者は Web の同じプランの申し込みで体験を受けうる (Q-10 の「ストアの試用を Web の 1 回に数える」が効かない)。起きるのは購入から最初の取り直しまでの間 (同期の API はアプリの購入の直後に呼ぶ。§10.6) に変えたときだけ。数えるなら、置き換えられた購読が体験中だったこと (取り直しの `period_type`) を snapshot に持たせ、写像の INSERT がそれで試用の列を書く改定を別の冊で行う |
| 25 | 主菜でない料理 (副菜・汁物など) の画像を利用者が料理を選んで作る入口 (Q-18) | 本冊では足さない。いまの献立の編集の「AIで画像生成」は献立に 1 枚の画像を作り、料理が 2 品以上の献立ではカバーになる (F26)。料理を選んで作る入口は、料理の位置を受ける API と画面・AI の入口の棚卸しを足す別の冊で決める |
| 26 | 段 B のデプロイの前に積まれた、主菜でない料理の待ちのジョブ | 本番の読み取り (2026-10-19): `meal_image_jobs` は `completed` の 4 件だけで、待ちのジョブは 0 件。段 B のデプロイまでに主菜でない料理の待ちのジョブが積まれても、処理の門 (`process-meal-image-jobs`) は主菜かを見ないので、いまの規則のまま画像を書く (§7.3)。利用者はゼロなので許容する (取り消す仕組みは作らない) |

---

## 改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-19 | 新設 (設計ゲート R1 の叩き台。4 相: 外形固定 §3 → 構想 §4 → 構造裁定 §5 → 仕上げ §6〜§17) |
| v1.1 | 2026-10-19 | R1 の指摘の反映: sandbox の購入を本番でも写す (App Store の審査の購入を権利にする。`iap_is_sandbox` の列を足し、v1.0 の環境変数 `REVENUECAT_ACCEPT_SANDBOX_EVENTS` を廃止)・ストアの猶予期間 (`grace_period_expires_date`) を `past_due` に・`plan_locked` と機能ごとの上限を `_shared/ai-daily-limit.ts` の全文で確定 (AI 相談の自動実行・Edge の生成の文も同じ関数で正しくなる)・自動の料理画像 (`meal_image_auto`) を無料から外す (Q-3)・モバイルが読む型と文を `packages/shared/src/billing-plans.ts` に置く・未完成を示す文の禁止語に「まだ」の類を足す・二重購読の処理を「当社が持つ側を解約・返金する」に・規約の草案の食い違い (保存期間・プランの変更) を実際の動きに合わせる・申請の順を「規約とポリシーの有料の条文の公開 → Stripe の申請・ストアの審査」に・`verify.ts` の正典を既存の `verifyStripeSignature` の上に書き直す |
| v1.2 | 2026-10-19 | R2 の指摘の反映: 紹介ページ (`landing-copy.ts`) の変える箇所を逐語の表に (「すべて無料」「いまは無料」を書かない・無料のカードから「家族で使う」を消す・家族の 4 か所に家族プランの条件・有料のカードは `free` / `paid` の 2 枚の形のまま 3 プランの価格の行)・`PAID_PLAN_SUMMARY` を `billing-plans.ts` に・`SITE_DESCRIPTION` と `/pricing` の「現在は無料」を消す・`tests/landing-page-1867.test.ts` の追随 (U-24・U-15・テスト 104)・子供の昇格 (`accept_child_promotion` は UPDATE) を家族の門の対象から外す (Q-4・§6.6・§9.5・テスト 105)・組織の利用者の AI の 1 日の上限を変えない (組織の plan の値に適用前の free の値を写す。§6.5 (5a)・テスト 106・107)・Google Play の内部テストに上げる AAB を `production` のプロファイルで作る (§12 の順 4・§17.3) |
| v1.3 | 2026-10-19 | R3 の指摘の反映: 土台を origin/main `4b1e1abe` (#1911 のマージ。cross/20 の正典が入った後) に移し、§2.2 (F2・F13・F14・F20 を書き直し、F21〜F25 を足す)・§7.2・§10.1 (`onSale` と「現在は無料」・FAQ の節を消す)・§10.2 (#1911 の 8 行に販売の 9 行を足す。`business-info.ts`・運営会社のページは変えない)・§10.5 (FAQ は一重引用符の文字列で定数の写し・`PlanCardSchema` を 2 枚に戻し `marketing.css` を戻す)・§13.1 (`EXT_STRIPE_NOT_CONFIGURED` は変えない)・§16.1 を main に合わせた。§11 を cross/20 §17 の「Issue #1912」の行に沿って書き直した (第10条の 2〜11 項・第11条 1 項・第16条 2 項・第17条・第24条・ポリシー第3/4/7/10/12条・主張の表の 42 行と 3 行の直し・T-33 / T-34 の改め・版 `v2026.2`。ストアの事業者は第7条に載せない (Q-17))。Q-14〜Q-17 と機能 × プランの表 (§0.6) を足した。献立の作成 (Edge の `save-meal`) の料理画像を `process-meal-image-jobs` のプランの門 (`ai_plan_feature_daily_cap`) で止め、原価の表に料理画像を入れた (§2.4・Q-16)。`menu_generation` を数える入口を全部挙げ (F23)、無料の上限を 3 回・止めたときの機能名を「献立の作成」にした。対応の無い商品は live でなければ飛ばし、利用者の行があればその `plan_key` で写す (`unmappedStoreSubscriptionDecision`)・`plan_store_products` の主キーを `(store, product_id)` にして `offered` を足した。購入の画面の無料体験の文をストアの導入価格と体験の対象の判定から作る (`storeTrialOf`・`fetchTrialEligibility`)。取り直しに無くなった行を終わらせるとき `iap_is_sandbox` と `billing_interval` を保つ。状態遷移表に最初の取り直しの `past_due` の INSERT と解約の予約を足した。§6.7 の手動付与の述語を `billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・PROCEDURE `billing_expire_manual_subscriptions` に直した |
| v1.4 | 2026-10-19 | R4 の指摘の反映: 退会の API を呼ぶ 4 つの入口 (Web の設定・凍結中の退会・規約の同意の画面の「登録をやめる」・アプリの設定のアカウント (`apps/mobile/app/settings/account.tsx`。ネイティブの確認で WebView を通らない)) のすべてに、ストアの購読は退会で解約されないことの固定の文 `STORE_SUBSCRIPTION_DELETION_NOTICE` (§8.9) を出し、アプリの確認に「定期購読の管理を開く」を置いた (§10.4・R24・S35・テスト 127〜130・P17)。§12 と §17.5 にストアのメタデータ (Privacy Policy URL・説明文の利用規約とプライバシーポリシーの URL・App のプライバシーとデータ セーフティの購入履歴) を足した (R25・P16)。`create_family_group` の最後の定義を固定する 2 本のテスト (`parental-consent-migration-contract`・`rpc-profile-name-placeholder-migration-contract`) の直し方を §16.1 に足し、母集合の作り方に 9 (最後の定義を固定するテスト) と 10 (文を足す画面の入口) を足した。`tests/api/billing-routes.test.ts` の偽物と AI の印の棚卸しの直し方を §16.1 に足した (テスト 131。母集合の作り方 1 に既存の route が届くようになる場合を足した)。`middleware.ts` と `maintenance-mode.ts` には Webhook の除外・止める側の一覧が無いので、どちらも変えないと §9.1・§15・§16 を直し、止まることをテスト 132・133 で固定した。§7.1 の退会の行の参照を §10.4 に直した |
| v1.5 | 2026-10-19 | R5 の指摘の反映: (1) App Store の同じ Subscription Group の中の変更 (上位への変更・期間が同じ crossgrade・体験中の上位への変更) で取り直しに 2 つの商品が live で並ぶとき、`purchase_date` の新しい方を権利にし、古い方を `expired` (`p_source` に `:superseded`) で先に写す規則を足した (§8.1 `SUPERSEDE_WITHIN_GROUP_STORES`・`compareStoreSubscriptionRecency`・`selectStoreSubscriptions` の `supersededAt`・`projectStoreSubscription`・`unmappedStoreSubscriptionDecision`・§8.4 `syncStoreSubscriber`・§7.3 の 2 行・S36・P18・テスト 134〜137)。Google Play の 2 つの live は `BILL_LIVE_ROW_CONFLICT` のまま。§17.2 と §12 の順 4 にグループの中のレベル (家族 Pro > 家族 Basic > 個人 Pro) を足し、§13.3 の App Store 同士の処置と S25・R12 を直した。(2) `findPlanFeatures` の本体を正典で書いた (1 日の上限だけ free の行に倒し、機能ごとの上限はそのプランの行だけ。§8.6・§10.3・テスト 138・139)。(3) `admin_audit_logs` の書き手を固定する `tests/admin-audit-logs-insert-policy-migration-contract.test.ts` の追随 (`DIRECT_INSERT_ALLOWED` に `iap-repository.ts`) を §16.1 と §15.2 に足し、母集合の作り方 11 を足した。(4) `readMealImageJobPlanDecision` が RPC の例外も捕まえて止めないようにし (§8.8・§18 の 21)、ハンドラを本物で動かす `tests/process-meal-image-jobs-worker-edges.test.ts` の偽の client に `rpc` を足す追随とテスト 140・141 を §16.1 と §15.2 に足し、母集合の作り方 12 を足した。(5) 使い方ページの撮影の種まき `scripts/guide-screenshots/seed.ts` の家族の代表者に家族プランを手動付与する追随を §16.1・§15.1・§15.2・§16.3 に足し、母集合の作り方 2 の grep に `scripts` を加えた。§7.1・§7.2 に (1) と (2) の行を足し、§18 に 24 (体験の購読を写す前の上位への変更) を足した |
| v1.6 | 2026-10-19 | R6 の指摘の反映: 段 D の依存の追加が必ず書き換える `package-lock.json` (ルート。npm workspaces の 1 つの lock) を、触るファイルの母集合 (§15.2)・段 D (§15.1)・共有面 (§16.3) に足した。作り方を §8.10 の「依存の追加と `package-lock.json` の作り直し」に書いた (`apps/mobile/package.json` に `expo-dev-client` `~58.0.14` (`bundledNativeModules.json` の値) と `react-native-purchases` `10.14.0` を手で書き、offload の行き先で `npm install --package-lock-only` の差分だけを持ち帰る。差分の期待 (ルートに 8 つのキー・入れ子は `react` と `@types/react` のまま)・番兵の確認・dependency review と npm audit の緑を待つこと)。依存の宣言か lock を読む番兵 6 本 (`tests/mobile-toolchain-contract.test.ts` ほか) を §16.1 の行と母集合の作り方 13 に足し、`tests/zod-single-copy-1444.test.ts` の行の「依存を足さない」を段 D の事実に合わせて分けた。`app.json`・`eas.json`・ルートの `package.json` を変えない根拠と、足す依存の中身を §2.3 の P19 に足した。origin/main の突き合わせ: `2ba5b3b3` (#1918。cross/20 (#1901) の実装のマージ) に合わせ、退会の入口 (§10.4・テスト 127・母集合の作り方 10) を、凍結中の退会と同意の前の退会 (`/legal-consent/account`) の共通の部品 `src/components/account/AccountSelfServicePanel.tsx` に足す形に直し、`LegalConsentForm.tsx`・`lib/legal-consent.ts`・`tests/public-claims-guard.test.ts` の行の番号を直した。段 E (§11) の主張の表を実装の値に合わせた (`LEGAL_CLAIM_COUNT` 382 → 424・区分の数・第24条の足す行の `id` を `terms-24#10`〜`#12` に)。段 E が待つのは本冊の段 B のマージだけになった (§11.0・§15.1・§18 の 22) |
| v1.7 | 2026-10-19 | 続きの周の指摘の反映 (どれも既存の番兵が実装で赤になるのに §16.1 に行が無かったもの): (1) §6.5 の `consume_ai_usage_capped_at` の早期の委譲で `tests/ai-usage-contract.test.ts:707-720` の it (委譲の最初の出現が数える位置より後) が赤になる → §16.1 の行に、委譲の 2 か所の位置をそれぞれ固定する改め方を逐語で書き、段 A に入れ、母集合の作り方 9 の grep を `definitions[definitions.length - n]` にも広げて「関数ごとにすべての it」を対象に。(2) §8.8 の「403 で code が AI_FEATURE_NOT_IN_PLAN でなければ null」は誤り (`aiDailyLimitMessageOfBody` は状態を見ない) で、`tests/ai-daily-limit-client.test.tsx:42` (403 + AI_DAILY_LIMIT → null) が赤になる → 状態と code の組の正本 `aiDailyLimitMessageOfStatusAndBody` を `_shared/ai-daily-limit.ts` に足し、Web の `aiDailyLimitMessageOfResponse` とモバイルの `aiDailyLimitErrorOf` の正典コードをそれを呼ぶ形で逐語に (テスト 142 を足し、101・102 の it 名を広げる)。(3) `tests/api/billing-routes.test.ts:301` の route の本数 (7 → 9) と `tests/landing-page-1867.test.ts` の U-10 (`landing-copy.ts` の `@homegohan/shared`) の行を §16.1 に足し、母集合の作り方に 14 (route の本数を固定する走査) と 15 (import の許可先の一覧を持つ走査) を足した。marketing/01 §8.1 の許可先の一覧の追随を §16.2 に |
| v1.8 | 2026-10-19 | 発注者の確認事項への選択 (§0.4 の追記 3) の反映: Q-2 は「無料 3 にもっと絞る」で free の 1 日の合計を 3 回に (§0.5・§0.6・§2.4 の原価・§3.2 の S17 / S26・§6.5 の `UPDATE`・§7.1 / §7.2・§8.9 の `PLAN_AI_DAILY_LIMITS`・§10.5 の FAQ の写しと主張の表・§14 のテスト 107・§16.1 / §16.2 の回数の行・§18 の 19)。Q-3・Q-4 は推奨のまま確定。Q-16 は「主菜の 1 品だけ作る」で、自動の料理画像を献立の主菜の 1 品 (役割 `main` / `主菜` の最初の料理、主菜の無い献立は先頭の料理) だけに作る: 種を作る `reconcileDishImages` の最後の絞り込みと `autoImageDishIndexOf`・`mealCoverRepresentsDish` を `_shared/meal-image.ts` に足し (§8.8)、積み直しの道具に `not_auto_image_dish` を、Web の献立の画面に「主菜でない料理に献立のカバーを出さない」を足した (§10.3)。§2.2 に F26 (料理の役割の実データと料理画像の流れ)、§3.1 に R26、§3.2 に S37〜S41 とそのトレース、§5.2 に縁の発生源 (7)、§7.1 に「自動の料理画像を作る料理」の表、§7.2 に 3 行、§7.3 に料理の画像の状態の遷移の表、§14 にテスト 143〜155、§16.1 に母集合の作り方 17 と 6 本の行 (と `meal-image-skip`・`meal-image-skip-routes` の 2 本の行の書き直しと `process-meal-image-jobs-worker-edges` の行の注の追記)、§16.2 に料理画像の文書 3 本の行、§16.3 に共有面 1 行、§18 に 25・26、Q-18 (料理を選んで画像を作る入口は足さない) を足した。§8.9 の有料プランの料理画像の説明を「主菜の画像」に、§12 の発注者の作業の Q の一覧を直した。網羅性の反映 (改定の周 1): §7.3 に `expired` / `cancelled` の行を合図ごとに足した (規則の行と、期限切れ・返金済みのまま・期限切れ → 返金・live に戻る・`PRODUCT_CHANGE` の 5 行)。§7.1 の `subscription_plans`・`ai_daily_limits`・`ai_plan_feature_caps` の読み手の表に母集合の作り方と 6 行 (`public-plans.ts`・`repository.ts` の 2 行・`manual-grant-repository.ts`・health の route・`entitlements.ts`) を足した。§15.2 に `scripts/requeue-pending-meal-images.ts` (冒頭の注だけ) と `supabase/functions/README.md` を、§16.1 の「free = 10 の文」の行に `supabase/functions/README.md:292` の直し方と対象外の 1 件を、§16.1 に `LEGAL_DOCUMENTS` を読むテスト 11 本と語だけが当たる 2 ファイルの変更なしの行を、§16.2 に `supabase/functions/README.md` の行を足し、`v2026.1` の grep が同意書の版にも当たることを §11.6 と §16.1 に書いた |
| v1.9 | 2026-10-21 | 改定の周の R1 の指摘の反映: 前の主菜を消した・前の主菜の役割を外した保存で、自動の料理画像の位置 (`autoImageDishIndexOf`) が、中身・役割・位置の変わらない画像の無い料理へ移ると、その料理は for の中の「前回のまま写し、積まない」(#1487) に当たり、献立に画像もジョブも無くなっていた → 主菜の引き継ぎ `autoImageDishHandoverIndexOf` を足し、`reconcileDishImages` の for の直後 (§8.8 の (b0)) で、前回と今回の位置が違い・その位置に種が無く・その料理が画像の無い状態のときだけ種を 1 本足す (route と AI 相談は `meal_image_auto` を 1 回数える。位置が移らない保存し直しは積まないので #1487 は変わらない)。§3.1 R26・§3.2 S42 とトレース・§7.1 / §7.2 の行・§7.3 の行 (主菜 N の同じ料理の保存・「主菜でない → 主菜 (位置が移った先の、変わらない料理)」の 3 行・「主菜 → 主菜でない」の副作用)・§14 のテスト 156〜158・§14.4・§15.3 の export の一覧を追随。origin/main `359a16f9` との突き合わせ: 番兵 `tests/landing-pricing-doc-1911.test.ts` (料金のカードの数と主張 `free-now` の根拠の行) を §16.1 に足し (段 C。it 名の 1 か所を §15.2 に)、§16.1 の母集合の作り方 6 に marketing/01 を読む番兵を足し、§16.2 の marketing/01 の行に幅の表と根拠の 3 行の直し方を足した。§16.2 の billing/01 の行から、billing/01 v1.12 が直し済みの §13.1 の文を外した |
| v1.10 | 2026-10-21 | 改定の周の R2 の指摘の反映: (1) §7.3 の料理の画像の状態の遷移に、献立の作成が既存の献立を作り直す保存 (`save-meal` の `regeneration`・前回の献立が商品の献立でない・料理が変わった) の K の料理の 6 行を足した (#1553 の `releasePreviousDishImage` と `releaseOnRegeneration` が K の料理を種にし、最後の絞り込みが主菜の 1 本だけを残すので、主菜の K は P (`stale` / `pending`)、主菜でない K は自分の画像を持つ中身の同じ料理を除いて N)。前置きの「どの入口でも同じ」に作り直しの例外を書き、K の「保存」の 2 行と「主菜でない → 主菜」の R / K の行に作り直しを除くことを書いた。§7.1 の前置き・§7.2 の行・§8.8 の Q-16 の箇条を追随し、主菜でない中身の同じ写真の料理が N になる行を守るテスト 159 を §14.1 に足した (§15.2・§16.1 の `save-meal-photo-preserve` の行も)。(2) §15.1 の段 B に、v1.9 で足した主菜の引き継ぎ (`autoImageDishHandoverIndexOf` と (b0)) を内容に、テスト 156〜158 (と 159) をテストの列に足した (138〜155 → 138〜159)。網羅性の反映 (改定の周 3): §15.1 の段表の下に、テスト 82 (実機) は段の外で §17.4 の整合ゲートで行うこと (47 は欠番) を書き、§16.1 に母集合の作り方 18 (`consume_ai_usage` を名指しするテスト) と、呼び出し側の偽の `consume_ai_usage` を持つ 4 本の「変更なし」の行を足した |
| v1.11 | 2026-10-21 | 10/21 の整合ゲート (wf_cdb79b20-faa) の指摘の反映 (#1917 との版の取り合い): #1917 (family/11 の実装。origin/main `465727de`) が規約とポリシーの版 `v2026.2` (施行日 2026-10-21) と旧版の控え `docs/legal/archive/v2026.1/` を先に使ったので、段 E の版を `v2026.2` → `v2026.3`、旧版の控えを `docs/legal/archive/v2026.2/` にした (§11.6・§12・§15.1・§15.2・§16.1・§16.2・§16.3・F14・R17・状態比較表)。改定の予告 (cross/20 §9.4 の 2) は段 E の公開の前にオーナーに確かめると書き、確かめるときに cross/20 §9.3 の原則 (版を上げる改定すべてで必ず行う。除外は v2026.1 と v2026.2 の公開だけ) と利用規約第24条 1 項・プライバシーポリシー第18条 1 項の約束を添えると書いた (§11.6・§12・§16.2)。旧版の控えの形は `docs/legal/archive/v2026.1/` の並び (置き換わった旨の文は本文の前) に合わせた (§11.6)。#1917 が変えた §11 の土台 (利用規約第11条 4 項・第12条 4 項・第17条 2 項・プライバシーポリシー第13条 9 項と主張の表の 6 行) を §11.0 に書き、§11.4 の区分の数を `465727de` の値 (利用規約 product 72・process 3) から数え直した (計 424 は変わらない)。§16.3 の `membership-errors.ts` の行を family/11 の実装のマージ済みに合わせた。同じ `465727de` で変わった面の指し先と数も合わせた: 凍結中も通す API `FROZEN_ALLOWED_API_PATHS` (5 本 → 7 本。`frozen.ts:70`)・同意の許可リスト (`legal-consent-api.ts:103-137`・`/api/webhooks` は `:135`) (F17・S22・§7.1・§9.1・§16.1)、退会の部品 `AccountSelfServicePanel.tsx` (`:160-163`)・アプリのアカウント `account.tsx` (`:54-59`・`:75`・`:55-58`・`:60-64`)・`account-delete.test.tsx` (`:132-138`・`:325-339`) (§10.4・§16.1)、`tests/e2e-api-paths.test.ts:165` (§16.1 の母集合の作り方 14)、cross/20 §6 の第10条の置き場所の段落 (955 行目。F24・§11.1)。段 A〜D の設計は変えない |
