# billing/03 有料プランの販売 — 価格・有料と無料の線引き・アプリ内課金 (RevenueCat)

| | |
|---|---|
| 版 | v1.1 (2026-10-19) |
| Status | 設計ゲート R1 の指摘を反映した版 (R2 の審査に出す) |
| Issue | #1912 (有料プランの販売を始める: 価格・有料と無料の線引き・アプリ内課金)。関連: #1911 (「準備中」の撤去)・#1901 (規約とポリシーの作り込み)・#1567 (特定商取引法の表記の残り)・#1113 (本番の Stripe の鍵) |
| 範囲の正本 | Issue #1912 の本文とコメント。本冊の §0.4 に、発注者の決定を逐語で写す |
| 前提の冊 | `docs/design/billing/01-billing-core.md` (核。段 A〜C は main 実装済み)・`02-manual-plan-grant.md` (手動付与。段 A〜D 実装済み)。本冊は両冊の契約の上に積み、核の契約 (写像の入口・`personal_subscriptions` の列・`plan_key_cached` の同期) を壊さない |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |

本冊は、課金の核 (billing/01) が作った「Stripe で買う」経路に、(1) 決めた価格、(2) 有料と無料の線引き (AI の回数・重い AI・家族の機能・無料の範囲)、(3) App Store / Google Play のアプリ内課金 (RevenueCat 経由) を足し、Web・iOS・Android のどこで買っても同じ権利の表 (`personal_subscriptions` → `get_effective_plan` → `plan_key_cached`) に写るようにする。あわせて、販売の開始と同時に出す公開の面 (料金ページ・特定商取引法の表記・運営会社・FAQ・規約とポリシーの有料の条文) を、未完成や予定を示す文を使わずに書き直す。

---

## 0. 分冊判定・範囲・読み方・発注者の決定・確認事項

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (正典コード・SQL・表 3 点・トレースを 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | DB (価格・ストアの商品の対応表・ストアの契約の写像・AI の機能の上限・家族の門)・サーバ (RevenueCat の Webhook と同期の API・カタログ)・Web の画面 (料金・契約の管理・究極モードの錠)・公開の面 (特商法・運営会社・FAQ・紹介ページ)・モバイル (購入の画面)・規約とポリシー = 6 | 該当 |
| 共有面 2 つ以上 | `personal_subscriptions` (核・手動付与・権利判定)・`subscription_plans` の行 (価格)・`ai_daily_limits` / AI の判定の DB 関数 (全 AI の入口が通る)・家族の DB 関数 (`create_family_group`・メンバーの INSERT)・`src/lib/env.ts` の一覧・`cross/04` のエラー表・公開ページの見張り (`tests/public-claims-guard.test.ts`)・`packages/shared` の規約の版 | 該当 |

判定: **設計は 1 冊 (本書) のまま、実装を 5 段 (A: DB 層 / B: サーバ層 / C: Web の画面と公開の面 / D: モバイル / E: 規約とポリシーの条文。§15) に分け、段ごとに 2 枚レビューを挟む**。理由: ストアの契約の写像 (SQL 関数) と、それを呼ぶ Webhook・同期の API (TS) は 1 つの契約 (§8.1 のスナップショット) を挟んで表裏で、分けると「未マージの核を参照する配線」の指摘を自分で作る (billing/01 §0.1 と同じ理由)。段 A は単独でマージできる (価格の更新・表と列と関数の新設・既存の関数への門の追加。本番の利用者はゼロなので挙動の変化で困る人はいない)。段 B〜D はそれぞれ前の段のマージ済みの実コードを参照する。段 E は #1901 の版の上に足す差分なので、#1901 のマージ後に単独で行う。

分けない案との比較 (採らない): 「核 = プランと権利と線引き / 配線 = RevenueCat とモバイルの購入画面」の 2 冊に分ける案は、配線の冊が核の冊の DB 関数 (`billing_apply_store_subscription`) と `plan_store_products` の列を未マージのまま参照することになり、設計ゲートで「未マージの前提」の指摘を生む。価格と線引き (段 A・C) と RevenueCat (段 B・D) は同じ `personal_subscriptions` の行と同じ `BillingSummary` を読むので、冊を分けても行数はほとんど減らない。

### 0.2 本冊の範囲と、対象外

| 本冊 | 対象外 (別の冊・別の Issue) |
|---|---|
| `subscription_plans` の 3 プランの価格と無料体験の更新 (§6.2) と、公開ページの価格の表示 (Stripe の鍵が無い間も DB の値から出す。§10.1) | Stripe・App Store Connect・Google Play Console・RevenueCat の設定の変更そのもの (発注者の作業。§17 に手順と順番) |
| 有料と無料の線引き: AI の 1 日の回数の上限のプランごとの値、機能ごとの上限 (究極モード・料理画像の作成・献立の生成) を持つ `ai_plan_feature_caps`、家族の機能 (グループの作成・メンバーの追加) の門 (§6.5・§6.6・§7) | 運営画面での `ai_plan_feature_caps` の編集 (運営は SQL で変える。画面は配線の残りの冊)・組織 (`org_*`) の課金・`family_addon` |
| App Store / Google Play の購入を RevenueCat の Webhook と同期の API で `personal_subscriptions` に写す仕組み (§6.3・§6.4・§8・§9) | RevenueCat の Stripe 連携 (Web の購入を RevenueCat に写すこと。§5.1 で採らない)・RevenueCat の Paywall UI (`react-native-purchases-ui`。自前の画面で作る) |
| モバイルの購入の画面 (ストアの審査の要件を満たす形。§10.6)・購入の復元・ストアでの購読の管理への案内 | ネイティブの画面での契約の状態の細かい表示 (本冊は購入の画面に最小の状態を出す)・Web の `/account/billing` の WebView の表示の変更 (読み取り専用のまま) |
| 公開の面の書き直し (料金ページ・特商法・運営会社・FAQ・紹介ページの料金の節。未完成や予定を示す文を書かない。§10.1〜§10.5・§11) | #1911 のうち本冊の面 (料金・特商法・運営会社・FAQ・紹介ページの料金) 以外 (バッジ・組織の画面・運営の画面の「準備中」)。ファイルで言うと、運営の画面 = `src/components/operator/finance/BillingNotStartedNotice.tsx` (「課金は未開始のため準備中」)・`src/components/operator/PreparingNotice.tsx`・`src/app/admin/page.tsx`・`src/app/admin/finance/**`・`src/app/admin/moderation/**`・`src/app/api/admin/moderation/**`・`src/lib/admin/moderation-backend.ts`・`src/lib/admin/not-supported.ts`・`src/app/super-admin/exports/**`・`src/app/api/super-admin/exports/**`・`src/lib/super-admin/exports-schemas.ts`、組織の画面 = `src/app/(org)/org/page.tsx`・`src/app/(org)/org/dashboard/page.tsx`・`src/app/(org)/org/challenges/page.tsx`。§16.1 の母集合の作り方 4 の grep はこれらにも当たるが、本冊では変えない (§16.1 の「#1911 の面」の行) |
| 利用規約・プライバシーポリシーの有料の条文の差分と版の繰り上げ (#1901 の版の上に。§11) | #1901 の本文そのもの (本冊はその版の上に足す差分だけ) |
| 「準備中」「販売開始前」「近日」「今後〜予定」などの文を、画面と規約の本文に書かない (§10・§11・§13 の文もその規則で選ぶ) | — |

### 0.3 読み方

- §3 要件行列・§3.2 シナリオ → §4 構想とトレース → §5 構造裁定 → §6 以降が仕上げ (実装者は §6〜§16 だけ読めば手を止めない)。
- 正典の TS は §8 の ```ts ブロック。`import` が zod だけか無いブロック (§8.1 `iap-core.ts`・§8.8 `ai-daily-limit.ts`・§8.9 `billing-plans.ts`・§8.10 `iap-catalog.ts`) は単独で型検査できる。1 行目に `// tsc:skip place=<パス>` / `insert=<パス>` / `append=<パス>` の印があるブロックは、既存のモジュール (`@/lib/...`・`react-native-purchases`) を import するので単独の検査から外し、billing/01 §8.0 の手順で置き場所に置いてリポジトリ全体と一緒に検査する。印の無い `// tsc:skip` のブロックは説明用の断片だけ。SQL は §6。
- 既存の設計書との食い違いは本冊が正 (billing/01 §10.4 の「アプリ内課金をしない」は本冊が改定する。§16.2)。

### 0.4 発注者の決定 (Issue #1912 の本文と、その後の指示。逐語)

指示:「あと、全体として「まだできてません」みたいなのは書かないで取り除いて？価格も決めてしまいましょうかね。あとアプリ版はAppStoreやPlayStore経由で決済できないといけないよ」

選択式の回答:
- 価格 = 「個人を競合並みに下げる」: 個人 Pro 580円/月・5,800円/年 / 家族 Basic 980円/月・9,800円/年 (4人) / 家族 Pro 1,480円/月・14,800円/年 (8人) / 無料体験 7日
- 有料で増えるもの (複数選択・4 つ全部): 「AI の回数の上限を上げる」「究極モードなど重い AI を有料に」「家族で使う機能を有料に」「いまの無料の範囲を絞る」
- 「準備中」の撤去 = 「利用者と公開ページすべて」(別 Issue #1911 で行う。この設計でも、未完成や予定を示す文を画面と本文に書かない)
- アプリ内課金 = 「RevenueCat を使う」(両ストアの購入・更新・解約を 1 つの仕組みでまとめ、Web の Stripe と同じ権利の表に寄せる)

追記 1 (発注者の指摘):「StripeはAppができないと申請できません。他もそうでしょう？」— 外部の手続きは、作り終わった後でないと出せない。順番を「作る → 発注者が申請する → 鍵と商品を入れて販売開始」にする (§17)。

追記 2 (会社情報の値。選択式の回答):「全部そのまま使う」— 株式会社MHD医健の公開の会社情報 (所在地 〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F / 設立 2025年1月31日 / 資本金 2,000,000円 / 代表者 (既存の `BUSINESS_REPRESENTATIVE`) / メール info@mhd-iken.com / 営業時間 平日 9:00-17:00 (年末年始を除く))。電話番号 = 「請求があれば遅滞なく開示と書く」(電話番号は載せず「請求があれば遅滞なく開示します」と書く)。特商法の表記の有料の項目 (価格・支払方法と時期・提供時期・解約と返金・動作環境・定期購入の表示) は、この値と並べて足す (#1567 の残り)。

### 0.5 発注者への確認事項 (Q-n。推奨つき。選ばれるまでは本冊の「推奨」の値を実装し、選択で変わる値は §6.2・§6.5 の migration の値と §8.9 の `billing-plans.ts` の定数だけが変わる)

| # | 項目 | 推奨 | 根拠・代替案 |
|---|---|---|---|
| Q-1 | App Store の日本の価格帯で 580 / 980 / 1,480 / 5,800 / 9,800 / 14,800 円が選べるか | **App Store Connect の「サブスクリプションの価格」で発注者が確かめる** (一次情報は App Store Connect の画面だけ。Apple の公開ヘルプは「800 の価格帯から選ぶ」と書き、日本円の一覧は載せていない (§2.3)) | 選べない値があれば、近い上の価格帯 (例: 580 → 600・5,800 → 6,000) をストアの価格にし、Web (Stripe) は決めた値のまま (ストアの手数料の分だけストアの価格が高いのは、両ストアの規約が許す形 (§2.3 Apple 3.1.3(b))。Web とストアの価格が違うときは、料金ページの「アプリ内課金の価格はストアの表示が正」の 1 文で説明する (§10.1)) |
| Q-2 | AI の 1 日の回数の上限 (`ai_daily_limits`) のプランごとの値 | **free 5 / 個人 Pro 30 / 家族 Basic 30 (メンバー 1 人ごと) / 家族 Pro 50 (同)** | いまは free = 10 (本番の行)。「いまの無料の範囲を絞る」の選択を回数で受ける。AI の原価は §2.4 (献立の生成 1 回 ≈ 26 円 (推計)・写真 1 枚 ≈ 0.2 円・料理画像 1 枚 ≈ 10 円)。無料で 5 回 = 写真 3 食 + 献立の生成 1 回 + 相談 1 回の使い方が収まる。上限は上限で、回数だけでは原価の上限にならないので、重い機能は Q-3 の機能ごとの上限と組にする。競合 (あすけん) は無料で写真の記録なし・プレミアム 580 円 (§2.4) |
| Q-3 | 機能ごとの 1 日の上限 (`ai_plan_feature_caps`) の値 | **究極モード: free 0 (使えない) / Pro 2 / 家族 Basic 2 / 家族 Pro 3。料理画像の作成 (`image_generation`。`POST /api/ai/image/generate`): free 0 / 有料は行なし (1 日の上限の中で)。料理を保存したときの自動の料理画像 (`meal_image_auto`): free 0 / 有料は行なし (いまの安全弁 1 日 20 回のまま)。献立の生成 (`menu_generation`): free 2 / Pro 10 / 家族 Basic 10 / 家族 Pro 15** | 「究極モードなど重い AI を有料に」を機能ごとの上限で受ける (0 = そのプランでは使えない。§6.5)。献立の生成は 1 回 ≈ 26 円で最も重いので、無料は 1 日 2 回に絞る。料理画像は 1 枚 ≈ 10 円で、自動の料理画像は保存 1 回で料理の数だけ画像を作る (1 回と数える。`src/app/api/meals/route.ts:170-174` の注) ので、無料に残すと 1 日 20 回 × 料理の数 × 10 円が原価の上限になる (§2.4)。無料では料理は画像なしで保存され、料理の画面は「料理画像の作成は有料プランでお使いいただけます」を出す (§8.8 (meal-image))。代替案: 自動の料理画像を無料に残す (行を入れない。原価の上限は §2.4 の下の行。有料の箇条書きの「料理画像の作成」は `image_generation` だけを指す文に変える)。いまの究極モードは全員 1 日 1 回 (環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT` の既定)。本冊のあとは、行のあるプランは行の値が勝ち、行の無いプランだけ環境変数の既定 (§6.5) |
| Q-4 | 家族の機能の門の範囲 | **家族グループの作成と、メンバーの追加 (招待の承諾・子供の追加・昇格による追加) を家族プラン (`family_basic` / `family_pro`) の契約がある代表者のグループだけに限る。契約が終わったグループは、いるメンバーはそのまま (読める・外れられる・解散できる) で、新しいメンバーを足せない** | 「家族で使う機能を有料に」を「グループに入ること」で受ける (家族の献立の表示・貼り付け・共有の設定はグループのメンバーであることが前提なので、入口を閉じれば全部が有料になる)。契約が終わったグループのメンバーをすぐ外す案は、家族の冊の判断 (billing/01 §18 の 15 と同じく外さない) に合わせない |
| Q-5 | Stripe の鍵と Price が無い間の、料金ページの有料プランのカードの CTA | **CTA を置かない (価格と内容だけを出す)。Price が入った間隔から「月額で始める」「年額で始める」が出る (いまの `isPurchasable` の規則)** | 「準備中」と書かない (§0.4)。CTA を「無料で始める」(新規登録) にする案は、有料プランのカードの押しどころが新規登録なのは紛らわしい。CTA を出して確認画面で止める案は、押せるのに申し込めないので採らない |
| Q-6 | `subscription_plans.display_name` を日本語にする | **`個人 Pro` / `家族 Basic` / `家族 Pro`** (いまは `Pro` / `Family Basic` / `Family Pro`) | §0.4 の呼び名に合わせる。画面・特商法・規約・ストアの商品の表示名 (§17) に同じ名前を使う |
| Q-7 | 本番の `subscription_plans` にある試験の行 2 件 (`test_integration_plan_*`・`test_patch_plan_*`。status `draft`) | **消す (発注者が SQL で `DELETE`)** | 本冊の migration は本番の行を消さない (段 A は追加と価格の UPDATE だけ)。`draft` は公開ページにも購入にも出ないので、残っていても利用者には見えない |
| Q-8 | 特定商取引法の表記の「メールアドレス」と、運営会社ページの連絡先 | **特商法の「メールアドレス」= `info@mhd-iken.com` (会社の公開の連絡先。`BUSINESS_EMAIL`)。お問い合わせフォーム (`/contact`) の案内はそのまま。プライバシーポリシーの窓口は `getSupportEmail()` のまま** | 追記 2 の会社情報を「全部そのまま使う」。サポート窓口 (`support@…`) は運用の宛先で、特商法の事業者の連絡先には会社の公開の連絡先を書く。異議があれば `getSupportEmail()` に戻す (1 行) |
| Q-9 | 電話番号の欄の文 | **既存の `DISCLOSED_ON_REQUEST` (「請求があった場合に遅滞なく開示します」) のまま** | 追記 2 の「請求があれば遅滞なく開示します」と意味が同じ。文字を合わせるなら定数の値を 1 行変える (見張り `tests/business-info-legal-pages.test.ts` は定数を参照するので緑のまま) |
| Q-10 | 無料体験 (7 日) の「1 人 1 回」の範囲 | **Web (Stripe) は同じプランで 1 回 (いまの `hasUsedTrial`)。ストアは各ストアの判定 (Apple ID / Google アカウントごとに 1 回) に任せ、ストアで試用した行は `trial_started_at` に写して、同じ利用者が後で Web で同じプランを買うときは試用を付けない** | ストアの試用の可否はストアが決め、当社は止められない (§2.3)。逆向き (Web で試用済みの人がストアで試用) は止められないので、Q として残す |
| Q-11 | ストアの契約の更新が Webhook で届かなかったときの網 | **(a) アプリは購入・復元・起動・前面復帰で同期の API を呼ぶ (§9.3)、(b) サーバは期限を過ぎたストアの行を読むときに RevenueCat から取り直す (遅延の再同期。§8.4)。日次の reconcile は配線の残りの冊** | RevenueCat の再送は 5 回・約 80 分で止まる (§2.3) ので、Stripe の 3 日の再送より網が要る |
| Q-12 | 動作環境の表記 (いまは iOS 14.0 以上 / Android 8.0 以上) | **Expo SDK 58 の最低要件に合わせる (発注者が EAS のビルドの設定で確かめる)。本冊の推奨は未確定のまま `§18` に残す** | #1567 の 5 と同じ |
| Q-13 | テストの購入 (sandbox。App Store の審査・TestFlight・Google Play のライセンステスター) を本番で権利にするか | **本番でも本物の購入と同じに写す (`personal_subscriptions.iap_is_sandbox = true` の印を付ける。§6.4)** | App Store の審査は本番のビルドの購入を sandbox の環境で確かめる (P12) ので、本番が sandbox を捨てると審査の購入に権利が付かず、「アプリ版は AppStore / PlayStore 経由で決済できる」を満たせない。利用者 ID で絞る案 (許可の一覧) は、審査官が審査用に渡したアカウントのほかで買ったときに権利が付かず、審査の結果に響く危険がある。RevenueCat の既定 (「Anybody」) も sandbox の購入に権利を与える (P12)。sandbox で買えるのは、開発者が App Store Connect で作ったテストのアカウント・TestFlight に招いた人・Play Console のライセンステスターだけ。代替案: 販売開始の後に `iap_is_sandbox` の行を運営が確かめ、想定外の利用者の行があれば許可の一覧の仕組みを足す (§18 の 17) |

---

## 1. 目的・スコープ

- 利用者が有料プラン (`pro` = 個人 Pro / `family_basic` = 家族 Basic / `family_pro` = 家族 Pro) を、Web では Stripe Checkout (billing/01)、iOS では App Store、Android では Google Play で買え、どこで買っても `personal_subscriptions` に 1 行の live な契約として写り、`get_effective_plan` / `plan_key_cached` / 家族グループのプランが同じ規則で決まる。
- 有料と無料の線引き (AI の回数・重い AI・家族の機能・無料の範囲) が DB の値 (`ai_daily_limits`・`ai_plan_feature_caps`・家族の門) で決まり、画面はその結果を説明する。
- 公開の面 (料金・特商法・運営会社・FAQ・紹介ページ・規約・ポリシー) が、販売の内容と会社情報を、未完成や予定を示す文を使わずに載せる。
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

### 2.2 現行の事実 (origin/main `ad44c2c5` と本番の読み取り (`subscription_plans`・`ai_daily_limits`・`ai_unmetered_daily_caps`・`feature_packages`・`feature_flags`・`pg_proc`・`information_schema.columns`)。2026-10-19)

| # | 事実 | 出どころ |
|---|---|---|
| F1 | 本番の `subscription_plans`: `pro` 980 / 9,800・試用 7 日・`display_order` 20 / `family_basic` 1,480 / 14,800・`max_members` 4・30 / `family_pro` 2,480 / 24,800・`max_members` 8・40 / `free` 0 / `family_addon` 280 (private) / `org_*` 4 行。全行の `stripe_product_id` / `stripe_price_id` / `stripe_yearly_price_id` が NULL。`feature_packages` は全行 `[]`。`draft` の試験の行が 2 件 (`test_integration_plan_1778236006448`・`test_patch_plan_1778236006448`)。シードは `supabase/migrations/20251126124224_create_meal_planner_tables.sql:14165-14169` | 本番 SELECT |
| F2 | 公開の面は「準備中」で固定されている: `src/app/pricing/PricingPageView.tsx:45` `PAID_PLAN_PENDING = '有料プランは準備中です（販売開始前）'` (買えるプランが 0 件のときの段落・カード・FAQ)・`src/app/legal/page.tsx:26` 同文 (販売価格・支払方法・支払時期・サービス提供時期・解約について の 5 行)・`src/app/faq/page.tsx:188`・`src/app/company/page.tsx:35` `PENDING = '準備中（確定次第掲載します）'` (所在地)・`src/components/marketing/landing-copy.ts:755,768,778,813,860`。見張り: `tests/public-claims-guard.test.ts` (`FORBIDDEN` に `¥980`・`980円`・`9,800円`・`資本金`、`PAID_PLAN_PENDING_NOTICE` の描画の期待、`#1151 料金ページ` の describe)・`tests/business-info-legal-pages.test.ts` (`所在地` = `DISCLOSED_ON_REQUEST`)・`tests/e2e/b10-unexplored-areas.spec.ts:240-276` (4-1 / 4-3) | 各ファイル |
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
| F13 | 事業者情報は `src/lib/business-info.ts` (`BUSINESS_NAME`・`BUSINESS_REPRESENTATIVE`・`DISCLOSED_ON_REQUEST = '請求があった場合に遅滞なく開示します'`) の 3 定数だけ。`/legal` の所在地・電話番号はどちらも `DISCLOSED_ON_REQUEST`、メールアドレスは `getSupportEmail()` | `src/app/legal/page.tsx:28-33` |
| F14 | 規約の版: `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` (`terms_of_service` / `privacy_policy` とも `version: 'v2025.1'`・`effectiveDate: '2025-01-01'`)。形式 `^[0-9A-Za-z._-]{1,20}$`。版を変えると再同意が走る (middleware の同意ゲート)。`/terms` は第 1〜9 条、`/privacy` は第 1〜7 条 (第 5 条に AI の送信先の一覧 `AI_CONSENT_PROVIDERS` を描く)。#1901 (open・PR なし・2026-10-19) がこの本文を作り込む | 各ファイル |
| F15 | Webhook の受け口の規約: `src/app/api/webhooks/stripe/route.ts` (`runtime nodejs`・`maxDuration 30`・大きさの上限 → 署名 → 外形 → 鍵 → モード → claim → 処理 → finish)・`src/lib/webhook/verify.ts` (Svix と Stripe の署名の確認。`WebhookSecretMissingError`)・`stripe_webhook_events` + `billing_claim_stripe_event` / `billing_finish_stripe_event` (冪等キー = event.id。`claimed / completed / in_progress`)。メンテナンス中は 503 で Stripe が再送する (`src/lib/maintenance-mode.ts`) | 各ファイル |
| F16 | AI の入口の棚卸し `tests/ai-consent-enforcement.test.ts` は、`@/lib/env` (AI の印に届く) を import する route をすべて `EXEMPT_ROUTES` (`tests/helpers/ai-consent-enforced-paths.ts`) に載せることを求める。課金の route 5 本と Webhook と退会が載っている (billing/01 §16.1) | 各ファイル |
| F17 | 未同意でも止めない API の許可リスト `packages/shared/src/legal-consent-api.ts:103-128` (`LEGAL_CONSENT_EXEMPT_API_PATHS`。課金の 3 本が `leave_service`)。凍結中も通す API `src/lib/auth/frozen.ts` の `FROZEN_ALLOWED_API_PATHS` (5 本。`toEqual` で固定: `lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts`) | 各ファイル |
| F18 | 本番の DB 関数 (`pg_proc`): `billing_apply_stripe_subscription`・`billing_claim_stripe_event`・`billing_finish_stripe_event`・`billing_family_plan_follow_representative`・`billing_grant_manual_subscription`・`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・`billing_expire_manual_subscriptions`・`billing_manual_subscription_sync_after_end`・`consume_ai_usage`・`consume_ai_usage_capped`・`refund_ai_usage`・`claim_ai_usage_grant`・`get_effective_plan`・`create_family_group(p_name, p_plan_key)`・`guard_user_profiles_privileged(_on_insert)` が実在する (本冊の土台) | 本番 `pg_proc` |
| F19 | `tests/billing-audit-action-lists-doc.test.ts` は、課金の監査の名前の一覧が `BILLING_AUDIT_ACTIONS` (core.ts の 9 つ) と `MANUAL_GRANT_AUDIT_ACTION_VALUES` の 2 つで、`operator/07` §4 の網羅リストの `*.billing.*` の名前がどちらかの一覧にあること・`BILLING_AUDIT_ACTIONS` の数の記述 (「N つ」) がコードと同じことを見る | 同ファイル |
| F20 | 紹介ページの文言の正本 `src/components/marketing/landing-copy.ts`: 料金の章 (`:766-781`。`eyebrow: '料金'`・`title: 'いまは、無料で使えます。'`・カード `free` と `paid` (`badge: '準備中'`))・要点 (`:755`)・FAQ (`:813`)・主張の表 `claims` の `free-now` (`:860`。evidence は `PricingPageView.tsx`) と `ai-daily-limit` (`:861`)。`tests/public-claims-guard.test.ts` はこのファイルのソースを `FORBIDDEN` で走査する (描画はしない) | 同ファイル |

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

### 2.4 AI の原価の推計と、競合の線引き (Q-2・Q-3 の根拠。推計は 1 ドル = 150 円・入出力の token 数は本冊の見積もり)

| 機能 (AI_FEATURES) | モデル (コードの既定) | 単価 (1M token。一次情報は Google。OpenAI は公式ページを取得できず二次情報) | 1 回の入出力の見積もり | 1 回の原価 (推計) |
|---|---|---|---|---|
| `menu_generation` (週間 = 最大 21 食) | OpenAI `gpt-5.2` (`supabase/functions/_shared/v4-fast-llm.ts:36`。`XAI_API_KEY` があると xAI `grok-4-1-fast-non-reasoning` に切り替わる (`:43`)。本番の設定は読めない) | gpt-5.2: 入力 $1.75 / 出力 $14 (二次情報: pricepertoken.com・benchlm.ai) | 入力 20k・出力 10k (6 段階の合計) | ≈ $0.175 ≈ **26 円** (xAI なら 1 桁下。未確認) |
| `menu_generation_ultimate` | 同上を倍の 6 段階 (`ai-usage-core.ts:57`) | 同上 | 2 倍 | ≈ **52 円** |
| `photo_analysis` | Google `gemini-3.1-flash-lite-preview` (`src/lib/ai/image-recognition.ts:1`) | 入力 $0.25 / 出力 $1.50 (一次情報: ai.google.dev の料金表 2026-10-19) | 画像 1.5k + 文 1k・出力 0.5k | ≈ $0.0014 ≈ **0.2 円** |
| `image_generation` / `meal_image_auto` | Google `gemini-3.1-flash-image-preview` (`src/app/api/ai/image/generate/route.ts:16`) | 画像 1 枚 (1K) $0.067 (一次情報: 同上) | 1 枚 (`meal_image_auto` は保存 1 回で料理の数だけ) | ≈ **10 円 / 枚** |
| `nutrition_advice` (栄養士のコメント) / `nutrition_advice_auto` (同じ API の自動の取得。上限に数えない) | OpenAI `gpt-5.2` (`src/app/api/ai/nutrition/feedback/route.ts:112`) | 同上 | 入力 3k・出力 0.6k | ≈ **2 円** |
| `consultation` | xAI (二次情報の単価は gpt-5.2 より低い) | 未確認 | 入力 4k・出力 0.8k | ≈ **1〜3 円** (未確認) |

- 上限に数えない機能 (`c_unmetered`) は 1 日の上限 (`ai_daily_limits`) に入らず、機能ごとの安全弁 (`ai_unmetered_daily_caps`。本番: `nutrition_advice_auto` 30・`meal_image_auto` 20) だけで止まる (F7)。`nutrition_advice_auto` (画面を開くと自動で取る栄養士のコメント。`gpt-5.2`・1 回 ≈ 2 円) と `meal_image_auto` (料理を保存・更新したときの自動の料理画像。保存 1 回を 1 回と数え、保存した料理の数だけ画像を作る。1 枚 ≈ 10 円。`src/app/api/meals/route.ts:170-174`) も原価に入れる。
- 無料の最悪の 1 日 (Q-2・Q-3 の推奨): 1 日の上限 5 回のうち献立の生成 2 回 (52 円) + 残り 3 回 (相談・栄養士のコメント・写真。1 回 3 円以下で ≈ 9 円) ≈ 61 円 + `nutrition_advice_auto` の安全弁 30 回 (≈ 60 円) ≈ 121 円、月 ≈ 3,600 円。自動の料理画像は無料では作らない (Q-3 の `meal_image_auto` = 0)。無料に残す代替案では、安全弁 20 回 × 保存した料理の数 × 10 円 (料理 3 品なら 600 円) が 1 日に加わり、最悪は 5 倍以上になる。ふつうの使い方 (毎食の写真・献立の生成を週 1〜2 回) なら無料は 1 日 ≈ 5〜10 円。
- 個人 Pro (580 円) の最悪の 1 日 = 献立 10 回 (260 円) + 究極 2 回 (104 円) + 残り 18 回 (料理画像の作成 18 枚 ≈ 180 円) + `nutrition_advice_auto` 60 円 + 自動の料理画像 (安全弁 20 回 × 料理の数 × 10 円) で、上限は濫用の歯止め。ふつうの使い方 (週 1〜2 回の献立・毎食の写真と保存の画像) なら月 ≈ 300〜600 円。
- 競合: あすけん (公式 asken.jp/premium。2026-10-19 取得) はプレミアム月額 580 円・7 日間無料トライアルで、プレミアムの機能に「画像解析機能」「1 食ごとのアドバイス」を挙げる。§0.4 の「個人を競合並みに下げる」の 580 円はこれに並ぶ。本冊は写真の記録を無料に残し (紹介ページの主張 `photo-analyze` と FAQ の事実を保つ)、重い AI (献立の生成の回数・究極モード・料理画像の作成と自動の料理画像) と家族を有料にする線引きにする。

---

## 3. 相 1 外形固定

### 3.1 要件行列

| ID | 要件 | 出どころ | 本冊の答え |
|---|---|---|---|
| R1 | 価格は個人 Pro 580 / 5,800・家族 Basic 980 / 9,800 (4 人)・家族 Pro 1,480 / 14,800 (8 人)・無料体験 7 日 | #1912 (§0.4) | `subscription_plans` の 3 行を migration で UPDATE (§6.2)。価格の正本は DB、公開の文の正本は `PLAN_CATALOG` (§8.9) で、両者の一致を契約テスト (テスト 60) が見る |
| R2 | Stripe の鍵と Price が無い間も、料金ページと特商法に価格と有料の中身を公開する (Stripe の有効化の審査が見る)。購入できるかどうかは別に判定する | 追記 1 (§0.4)・P11 | `listPublicPlans()` (表示用。`stripe_price_id` で絞らない) と `isPurchasable` (購入用。変えない) に分ける (§8.6・§10.1)。CTA は買える間隔だけ (Q-5) |
| R3 | 「準備中」「販売開始前」「近日」「今後〜予定」「まだ〜」などの未完成や予定を示す文を画面と規約の本文に書かない | #1912 (§0.4)・#1911 | §10・§11 の文と §13 のエラーの文はその規則で選び、禁止語の一覧 (`UNFINISHED_WORDS`。§14.1) を見張りのテストが持つ。`EXT_STRIPE_NOT_CONFIGURED` の文「お支払いの受付は準備中です」(billing/01 §13.1) を本冊で改める (§13.1) |
| R4 | AI の 1 日の回数の上限をプランごとに上げる・無料の範囲を絞る | #1912 (§0.4) | `ai_daily_limits` に 4 プランの行 (Q-2。§6.5)。判定の関数は変えない (プランごとの行は既に効く。F7) |
| R5 | 究極モードなど重い AI を有料に | #1912 (§0.4) | `ai_plan_feature_caps (plan_key, feature, daily_cap)` を新設し、`consume_ai_usage_at` が機能ごとの上限を判定する (0 = そのプランでは使えない。§6.5)。上限に数えない自動の料理画像 (`meal_image_auto`) も同じ表で無料を 0 にする (料理は保存し、画像だけ作らない。§8.8)。止めたときの応答は 403 `AI_FEATURE_NOT_IN_PLAN` (使えない) か 429 `AI_DAILY_LIMIT` (回数) (§8.8・§13)。画面はプランの機能の表 (`BillingSummary.features`) で錠を出す (§10.3・§10.6) |
| R6 | 家族で使う機能を有料に | #1912 (§0.4) | 家族グループの作成 (`create_family_group`) とメンバーの追加 (`family_members` の BEFORE INSERT のトリガー) を、代表者の live な家族プランの契約があるグループだけに限る (`FAMILY_PLAN_REQUIRED`。§6.6)。範囲は Q-4 |
| R7 | iOS / Android の購入はストア経由 (App Store / Google Play) で、RevenueCat で両ストアをまとめる | #1912 (§0.4)・P9・P10 | `react-native-purchases` の `purchasePackage` → RevenueCat の Webhook と同期の API → `billing_apply_store_subscription` (§6.4・§8・§9・§10.6)。テストの購入 (sandbox。App Store の審査を含む) も Webhook・同期の API・遅延の再同期のすべてで本物の購入と同じに写し、行に `iap_is_sandbox` の印を付ける (Q-13・P12・S24) |
| R8 | どこで買っても同じ `plan_key_cached` になる | #1912 | ストアの契約も `personal_subscriptions` の行 (1 利用者 1 live 行) に写し、`plan_key_cached` と家族グループの同期は写像の中で核と同じ式で行う (§6.4)。権利判定 (`get_effective_plan`) は変えない |
| R9 | RevenueCat の Webhook: 署名の検証・冪等・順序の入れ替わり | #1912・P4 | HMAC の署名 (§8.2)・`revenuecat_webhook_events` + claim (§6.3)・イベントは合図として扱い `GET /v1/subscribers/{app_user_id}` で取り直して `p_fetched_at` で単調に写す (§4.1) |
| R10 | app_user_id と Supabase の user id の結び付け | #1912・P3 | app_user_id = Supabase の `auth.users.id` (UUID v4。P3 の条件を満たす)。アプリはログイン中の利用者の id で `configure` / `logIn` し、サインアウトで `logOut` する (§10.6)。Webhook の `app_user_id` / `transferred_*` を UUID として検証し、UUID でない (匿名 ID) は無視する (§8.1) |
| R11 | 購入の復元 | #1912・P3・P9 | 「購入を復元」のボタン → `restorePurchases()` → 同期の API (§9.3・§10.6)。Restore behavior は既定 (Transfer to new App User ID) のまま (§17)。TRANSFER のイベントは移動元と移動先の両方を取り直す (§4.1) |
| R12 | Web で買った人がアプリで使える・アプリで買った人の解約はストアで・二重購読の防止と案内 | #1912・P9 (3.1.3(b)) | 権利は DB の行なのでどこで買っても使える。アプリの画面は `GET /api/billing/subscription` で live な契約があれば購入のボタンを出さず、契約の出どころ (`source`) に応じて「Web でご契約中」/ ストアの購読の管理へのリンクを出す (§10.6)。ストアの契約は `can_cancel` / `can_resume` を偽にし、`manage_in_store` を返す (§8.1)。2 本目の live な契約は写像が `BILL_LIVE_ROW_CONFLICT` で止め、監査に残す (§7.3・§13.3)。運営は当社が止められる側 (Stripe の契約・手動付与・Google Play の購入) を解約・返金して写し直し、App Store 同士のときは利用者に Apple への返金の申し込みを案内する (P14・§13.3 の手順。S13・S25) |
| R13 | 家族のプランの席の数え方 | #1912 | いまのまま: `family_groups.member_limit` = プランの `max_members` (4 / 8) を写像とトリガーが同期し、人数は `family_members` の active な行 (子供を含む) で数える (F9・billing/01 §6.4 (10))。本冊は席を変えない |
| R14 | 無料体験の 1 人 1 回 | #1912・operator/04 §5.2 | Q-10 のとおり (Web は `hasUsedTrial`、ストアはストア任せ + 行の `trial_started_at` で片向きに共有。S23) |
| R15 | モバイルの購入の画面はストアの審査の要件を満たす | #1912・P9・P10 | プラン名と期間・提供する内容・更新の価格 (ストアの `priceString`)・無料体験の長さと終了後の価格・自動更新の説明・解約の方法 (ストアの管理へのリンク)・「購入を復元」・利用規約とプライバシーポリシーへのリンクを 1 画面に (§10.6) |
| R16 | アプリの中に、Web での購入への誘導を出さない | billing/01 R11 の改定・P9 (3.1.3) | アプリの中にアプリ内課金の購入の画面を持つ (R7)。Web の購入のページ (`/pricing`・`/account/billing`) へのリンクは引き続き出さない (見張り `no-web-purchase-links.test.ts` は保つ。§10.6・§16.1) |
| R17 | 販売の開始と同時に出す文: 規約・ポリシー (Stripe と RevenueCat への送信・外部送信の公表)・特商法 | #1912 (決めること 5)・追記 2 | §11 (差分として書き、#1901 の版の上に足す)。特商法の表記の会社情報は追記 2 の値 (§10.2) |
| R18 | 作る → 発注者が申請する → 鍵と商品を入れて販売開始、の順。鍵や価格が無ければ買えるプランを出さない | 追記 1 | §15 (段) と §17 (申請の順と、それぞれの段で何が開くか)。Web は `stripe_price_id`、ストアは `plan_store_products` の行と offerings の一致で買える判定 (§8.4・§10.6) |
| R19 | 本番の書き込み・外部の設定の変更はしない (設計) | #1912 の守ること | 本冊は読み取りだけ。設定の手順は §17 |
| R20 | migration の番号はマージ時に確定・`.down.sql` を対で | 設計の規約 | §6.1 |
| R21 | as any 禁止・マジックナンバー禁止 | 設計の規約 | §8 の定数に根拠。RevenueCat の型は Zod で自前に定義 (SDK を入れない) |
| R22 | 監査ログ必須 | `docs/design/CLAUDE.md` | 状態の変化は写像が `admin_audit_logs` に書く (核と同じ名前)。Webhook の失敗は `system.revenuecat.event_failed` (§8.1) |
| R23 | 既存の番兵の追随と、2 PR 以上が触る共有面の台帳 | 設計の規約 | §16 |

### 3.2 ユーザーシナリオ (25 本)

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
| S15 | ストアの商品が未登録: `plan_store_products` に行が無い間、カタログの API は空を返し、アプリの購入の画面は現在のプランの状態だけを出す (プランの一覧も購入のボタンも出さない)。Webhook で未登録の商品が届いたら `BILL_IAP_UNKNOWN_PRODUCT` で `failed` (運営が行を足し、次の同期で写る) |
| S16 | Stripe の Price が無い間の料金ページ: 本番に Price が無い間、`/pricing` は 3 プランのカード (価格・無料体験・内容) を出し、CTA は出さない (Q-5)。`/legal` は販売価格・支払方法・支払時期・提供時期・解約の行を販売の内容で出す。Stripe の有効化の審査はこの公開の面を見る (P11) |
| S17 | 無料の利用者の線引き: 無料の利用者が献立の生成を 1 日 3 回目に頼むと 429 `AI_DAILY_LIMIT` (機能の上限 2 回)。究極モードのトグルは錠つきで押せず、押すと「究極モードは有料プランでお使いいただけます」の案内。料理画像の作成を押すと 403 `AI_FEATURE_NOT_IN_PLAN`。家族グループを作ろうとすると 402 `FAMILY_PLAN_REQUIRED`。料理を保存すると、料理は画像なしで保存され (`aiSkipped` は付かない)、料理の画面は「料理画像の作成は有料プランでお使いいただけます。」を出す |
| S18 | 有料の利用者の線引き: 個人 Pro の利用者は 1 日 30 回・献立 10 回・究極 2 回・料理画像は上限の中で何度でも。家族 Basic のメンバー (代表者でない大人) も家族プランの上限 (30 回) と機能 (究極 2 回) を受ける (`get_effective_plan` が家族のプランを返す) |
| S19 | 家族プランが終わったグループ: 代表者の家族 Basic が `expired` になる。グループは `free` / 4 に戻り、いるメンバーはそのまま。新しい招待の承諾・子供の追加は 402 `FAMILY_PLAN_REQUIRED`。メンバーの AI の上限は free の値に戻る |
| S20 | 運営の手動付与との共存: 運営が利用者に `family_pro` を手動で付与 (M 行)。その利用者がアプリで買おうとしても購入のボタンは出ない (live)。手動付与の取り消し・期限切れは、ストアの行 (`iap_store IS NOT NULL`) を M 行と見ない (§6.7) |
| S21 | 規約の改定の再同意: 段 E で規約とポリシーの版が上がる。サインイン中の全員に再同意が求められる (既存の仕組み)。再同意していない人の購入の API は 403 `LEGAL_CONSENT_REQUIRED` で、同意してから買う (購入の API は未同意の許可リストに入れない) |
| S22 | 凍結 (BAN) 中のストアの契約: 凍結中の利用者のストアの購読は更新され続ける (核の Stripe と同じく凍結は課金を止めない)。`/frozen/billing` はストアの行には「App Store / Google Play の購読の管理から解約できます」の文を出し、解約のボタンを出さない。Webhook と写像は凍結を見ない |
| S23 | 無料体験の 1 人 1 回: 利用者が iOS で個人 Pro の月額を 7 日間の無料体験つきで買い (行は `trialing`)、体験中に App Store で自動更新を切る。体験の終わりに行は `expired` になる。後日 Web の `/pricing` から個人 Pro を申し込むと、確認画面の無料体験は 0 日で、Checkout も試用なしで作られる。家族 Basic を Web で申し込むときは 7 日の無料体験が付く (試用は同じプランで 1 回)。同じ Apple ID でストアからもう一度買うときの試用の可否は App Store が決める (Q-10) |
| S24 | App Store の審査 (sandbox の購入): 審査官が本番のビルドに審査用のアカウントでログインし、sandbox の Apple ID で個人 Pro の月額を買う。Webhook (`environment` = `SANDBOX`) と同期の API が本物の購入と同じに写し、行は `trialing`・`iap_is_sandbox = true`・`plan_key_cached = 'pro'`。究極モードの錠が外れ、「プランとお支払い」は「個人 Pro をご利用中です」を出す。TestFlight・Google Play の内部テストの購入も同じ |
| S25 | 二重購読の防止と案内 (ストア同士): App Store で個人 Pro を契約中の利用者が、別の端末 (Android) の購入の画面から Google Play でも買ってしまう。写像が `BILL_LIVE_ROW_CONFLICT` で止め、同期の API は 409 (S13 と同じ文)。運営は Google Play の購入を Play Console で返金する (購読はすぐ終わる。P14)。2 本とも App Store の購入のとき (別の Apple ID) は、運営は利用者に reportaproblem.apple.com からの返金の申し込みを案内する (Apple の購入は開発者が返金できない。P14) |

---

## 4. 相 2 構想

### 4.1 構造 (発明相の結論)

1. **権利の正本は DB の行のまま、ストアの契約も同じ表の行にする。** `personal_subscriptions` に `iap_store` / `iap_product_id` / `iap_synced_at` を足し、ストアの契約は `(user_id, iap_store, iap_product_id)` で 1 行 (部分 UNIQUE)。Stripe の行 (`stripe_subscription_id`)・手動付与の行 (どちらも NULL) と同じ表・同じ status の語彙・同じ部分 UNIQUE (1 利用者 1 live 行) に乗せる。権利判定 (`get_effective_plan`)・`plan_key_cached`・家族グループの同期・運営の手動付与・退会は、行の出どころを問わない (手動付与の述語だけ `iap_store IS NULL` を足す)。RevenueCat の entitlement は当社の権利判定には使わない (アプリは `GET /api/billing/subscription` を読む)。
2. **RevenueCat のイベントは「何かが変わった合図」。契約は必ず `GET /v1/subscribers/{app_user_id}` で取り直してから写す** (核の Stripe と同じ考え。R9)。写す入口は DB 関数 `billing_apply_store_subscription(p_snapshot, p_fetched_at, p_source)` の 1 本で、Webhook・同期の API・遅延の再同期がすべてこれを呼ぶ。取り直した時刻で単調に写す (古い取り直しは stale)。
3. **同期の API (`POST /api/billing/iap/sync`) を、Webhook と同じ写像を本人の操作から呼ぶ入口にする。** アプリは購入・復元・画面を開いたとき・前面復帰で呼ぶ。Webhook の再送が尽きても (P4)、本人が使う限り写る。さらに `GET /api/billing/subscription` が、期限を過ぎたストアの行を読むときに取り直す (遅延の再同期)。
4. **商品の対応は表 `plan_store_products (plan_key, store, billing_interval, product_id)`。** RevenueCat の entitlement の id は `plan_key` と同じ文字列 (`pro` / `family_basic` / `family_pro`) に決める (表は要らない)。カタログの API は、ストアごとにこの表の行を返し、アプリは offerings の `product.identifier` と突き合わせた package だけを買える商品として出す。行が無い商品は出ない (R18)。
5. **線引きは DB の値。** `ai_daily_limits` の 4 行 + 新設 `ai_plan_feature_caps` の行 (0 = 使えない) を `consume_ai_usage_at` が読む (上限に数えない機能の枝より前に読むので、自動の料理画像も同じ表で止まる)。止めたときの文と応答は `_shared/ai-daily-limit.ts` の 1 か所で決まり、Web の route・Edge の生成・AI 相談の自動実行が同じ関数を通る。家族の門は `create_family_group` の 1 行の判定と `family_members` の BEFORE INSERT のトリガー。画面は `BillingSummary.features` (プランの上限の表) で錠と案内を出すだけで、判定は持たない。
6. **公開の面は「表示」と「購入の可否」を分ける。** `listPublicPlans()` (public・個人/家族・free でない・金額 > 0) で価格と内容を出し、CTA は `isPurchasable` (Price あり) の間隔だけ。文の正本 `PLAN_CATALOG` (プランの説明の箇条書き・特商法の文) は DB の価格と契約テストで一致させる。
7. **モバイルは自前の購入の画面 1 つ** (`app/settings/plan.tsx`) + RevenueCat の薄い包み (`src/lib/purchases.ts`。`configure` / `logIn` / `logOut` / `getOfferings` / `purchasePackage` / `restorePurchases`)。WebView の `/pricing`・`/account/billing` は読み取り専用のまま。

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
| S15 | 4: `GET /api/billing/iap/catalog?store=app_store` → `plan_store_products` が 0 行 → `plans: []` → 画面は状態だけ。Webhook の未登録の商品 → `projectStoreSubscription` の `plan_key = null` → 写像が `BILL_UNKNOWN_PLAN`... 本冊では TS 側で `BILL_IAP_UNKNOWN_PRODUCT` として `failed` に記録 (§8.4) |
| S16 | 6: `listPublicPlans()` → 3 行 (Price なし) → `PricingPageView` が価格・体験・内容を描き、`isPurchasable` が偽なので CTA 無し。`/legal` は `PLAN_CATALOG` の文を描く |
| S17 | 5: `consume_ai_usage_at` が `ai_plan_feature_caps(free, menu_generation) = 2` → 3 回目は `{allowed:false, capped_feature:'menu_generation', limit:2}` → 429。`image_generation` = 0 → `{allowed:false, limit:0, capped_feature}` → `aiDailyLimitPayload` が 403 `AI_FEATURE_NOT_IN_PLAN`。究極モードのトグルは `features.ai_feature_caps.menu_generation_ultimate === 0` で錠。`POST /api/family/groups` → `create_family_group` が `FAMILY_PLAN_REQUIRED` → 402。料理の保存 (`POST /api/meals`) → `consumeAiUsage(user, 'meal_image_auto')` → `ai_plan_feature_caps(free, meal_image_auto) = 0` → `{allowed:false, capped_feature:'meal_image_auto', plan_locked:true}` → `mealImageSkipReasonOf` = `'plan'` → 料理の `image_status = 'failed'`・`image_error = 'skipped_plan'` で保存・`aiDailyLimitSkippedField` は `planLocked` なので空 (`aiSkipped` なし) → 料理の画面は `isMealImagePlanSkippedError` で「料理画像の作成は有料プランでお使いいただけます。」 |
| S18 | 5: `get_effective_plan` = `pro` → `ai_daily_limits(pro)=30`・`ai_plan_feature_caps(pro, menu_generation)=10`・`(pro, menu_generation_ultimate)=2`・`image_generation` 行なし → 上限の中で可。家族のメンバーは `get_effective_plan` = `family_basic` (家族の行) で同じ表を引く |
| S19 | 1: 写像の 10. (ELSE 枝) が `family_groups` を `free` / 4 に。5: `family_members` の INSERT のトリガーが `plan_key='free'` で `FAMILY_PLAN_REQUIRED`。メンバーの `get_effective_plan` は家族の `free` → free の上限 |
| S20 | 1: M 行は live なので `BillingSummary.can_purchase=false` → アプリは購入のボタンを出さない。6.7: 取り消し・期限切れの述語 `stripe_subscription_id IS NULL AND iap_store IS NULL` でストアの行を触らない |
| S21 | 既存の同意ゲート: `/api/billing/iap/*` は `LEGAL_CONSENT_EXEMPT_API_PATHS` に入れない → 未同意は 403 `LEGAL_CONSENT_REQUIRED` (アプリは既存の `LegalConsentGate` が同意画面に畳む) |
| S22 | 既存: Webhook と写像は `frozen_at` を見ない。`/frozen/billing` は `summary.source` がストアなら文だけ (§10.4) |
| S23 | 1・2: 購入の取り直し (`period_type` trial) → 写像の 6. の INSERT が `trialing` の行に `trial_started_at = purchase_date`・`trial_ends_at = expires_date`・`trial_source = 'app_store'` を入れる (§6.4)。自動更新 OFF → `cancel_at_period_end=true` (S5 と同じ)。体験の終わりの取り直し → `expired`。UPDATE は `trial_started_at` / `trial_source` を `COALESCE` で保つ。Web: `previewCheckout` / `startCheckout` (`src/lib/billing/service.ts:73,97`) → `repository.hasUsedTrial(user, 'pro')` (`src/lib/billing/repository.ts:72-80`。同じ利用者・同じ `plan_key` で `trial_started_at` のある行を数える。行の出どころを見ないので I 行も入る。コードは変えない) = true → `trialDaysFor(7, true)` = 0 (`src/lib/billing/core.ts:446-448`)。`family_basic` は `hasUsedTrial(user, 'family_basic')` = false → 7 日。ストアでの買い直しは同じ (user, store, product) の行を再利用し、`trial_started_at` は最初の値を保つ (§7.3) |
| S24 | 7・3: 審査官の購入 → 同期の API → 取り直し → `subscriptions['homegohan_pro_month']` (`is_sandbox: true`・`period_type` trial) → 2: `projectStoreSubscription` が `is_sandbox: true` の snapshot → 1: 行 INSERT (`trialing`・`iap_is_sandbox = true`)・`plan_key_cached='pro'`・監査の details に `is_sandbox: true`。Webhook (`environment: SANDBOX`) も環境を見ずに同じ取り直し (stale か同値)。route・同期・遅延の再同期のどれも環境で絞らない (§9.1) |
| S25 | 2: Android の購入の取り直し → 写像の 5. が App Store の live 行を見つけ `BILL_LIVE_ROW_CONFLICT` → S13 と同じ記録と 409。運営: Play Console で Google Play の購入 (最新の注文) を返金 → 購読が終わる → RevenueCat の `EXPIRATION` (または `CANCELLATION`) → 取り直し → Google の商品は `refunded_at` あり (`cancelled` の履歴の行が INSERT。live でないので衝突しない)。App Store 同士は運営が利用者へ返金の申し込みを案内し、Apple が返金すると `CANCELLATION` → 取り直し → `refunded_at` → その行は `cancelled` |

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
--     行の有無が「そのストアで買えるか」の合図 (Web の stripe_price_id と同じ考え。R18)。書くのは運営 (service_role / super_admin)。
CREATE TABLE IF NOT EXISTS public.plan_store_products (
  plan_key          varchar(100) NOT NULL REFERENCES public.subscription_plans(plan_key) ON UPDATE CASCADE ON DELETE RESTRICT,
  store             varchar(20)  NOT NULL,
  billing_interval  varchar(10)  NOT NULL,
  product_id        varchar(255) NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT plan_store_products_pkey PRIMARY KEY (plan_key, store, billing_interval),
  CONSTRAINT plan_store_products_store_check CHECK (store IN ('app_store', 'play_store')),
  CONSTRAINT plan_store_products_interval_check CHECK (billing_interval IN ('month', 'year')),
  CONSTRAINT plan_store_products_product_id_not_blank CHECK (btrim(product_id) <> '')
);
-- 同じストアの同じ商品 ID を 2 つのプランに付けない (Webhook の product_id → plan_key が一意に決まる)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_store_products_store_product ON public.plan_store_products (store, product_id);
COMMENT ON TABLE public.plan_store_products IS
  'billing/03 §6.3: App Store / Google Play の商品 ID と plan_key・間隔の対応。行があるストア・間隔だけアプリの購入の画面に出る (Web の stripe_price_id と同じ合図)';
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

  -- 5. 同じ利用者の別の live 行 (Stripe の契約・手動付与・別のストアの契約) があれば失敗させる (二重購読の防止。S13)
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
    UPDATE public.personal_subscriptions
       SET status               = v_status,
           billing_interval     = NULLIF(p_snapshot->>'billing_interval', ''),
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
-- (5) 1 日の上限 (Q-2 の推奨値)。free は本番の行 (10) を書き換える (§0.4 の「いまの無料の範囲を絞る」)。ほかは行が無ければ足す
UPDATE public.ai_daily_limits SET daily_limit = 5, updated_at = now() WHERE plan_key = 'free';
INSERT INTO public.ai_daily_limits (plan_key, daily_limit) VALUES ('pro', 30), ('family_basic', 30), ('family_pro', 50)
ON CONFLICT (plan_key) DO NOTHING;

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
-- 既定 (Q-3 の推奨値)。運営が変えた値は上書きしない
INSERT INTO public.ai_plan_feature_caps (plan_key, feature, daily_cap) VALUES
  ('free',         'menu_generation_ultimate', 0),
  ('free',         'image_generation',         0),
  ('free',         'meal_image_auto',          0),
  ('free',         'menu_generation',          2),
  ('pro',          'menu_generation_ultimate', 2),
  ('pro',          'menu_generation',          10),
  ('family_basic', 'menu_generation_ultimate', 2),
  ('family_basic', 'menu_generation',          10),
  ('family_pro',   'menu_generation_ultimate', 3),
  ('family_pro',   'menu_generation',          15)
ON CONFLICT (plan_key, feature) DO NOTHING;
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
  それ以外 (行の無いプラン) は従来どおり `p_feature_daily_cap` で判定する。
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
--      family_members に INSERT する経路 (accept_family_invite / add_family_child / 昇格 / service_role の直接の INSERT) をすべて受ける。
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
  `GRANT` / `REVOKE` は既存のまま (`authenticated`・`service_role` に EXECUTE)。
- グループの `plan_key` は billing/01 のトリガー (作成・代表者の交代) と写像 (購入・終了) が同期するので、門はそれを読むだけ。契約が終わった (`free` に戻った) グループのいるメンバーは触らない (S19・Q-4)。

### 6.7 (7) 手動付与 (billing/02) の述語に `iap_store IS NULL` を足す (F5)

`billing_revoke_manual_subscription(p_user_id)`・`billing_expire_manual_subscription_for_user(p_user_id)`・`billing_manual_subscription_sync_after_end(p_user_id, p_plan_key)` の 3 本を、origin/main の最新の定義 (`20261017230000_billing_manual_plan_grant.sql`) を土台に丸ごと写し、M 行を選ぶ `AND s.stripe_subscription_id IS NULL` の行 (同ファイル `:171`・`:226`・`:273`) をそれぞれ `AND s.stripe_subscription_id IS NULL AND s.iap_store IS NULL` にする (ほかは逐語)。`billing_grant_manual_subscription` は変えない (別の live 行の検査は出どころを問わない)。`tests/billing-manual-plan-grant-migration-contract.test.ts` が見る文面は、本冊の migration の中の定義も同じ検査に当てる (§16.1)。

### 6.8 ロールバック (`<番号>_billing_paid_plans_iap.down.sql`)

順に: (a) トリガー `family_members_billing_plan_gate` と関数を落とす。(b) `create_family_group` を土台にした migration の定義に戻す (逐語)。(c) 手動付与の 3 関数を `20261017230000` の定義に戻す (逐語)。(d) `consume_ai_usage_at`・`consume_ai_usage_capped_at` を土台の定義に戻す (逐語)。(e) `ai_plan_feature_caps` を落とす。`ai_daily_limits` は `free` を 10 に戻し、`pro` / `family_basic` / `family_pro` の行を消す。(f) `billing_apply_store_subscription`・`billing_claim_revenuecat_event`・`billing_finish_revenuecat_event` を落とす。(g) `idx_personal_subscriptions_iap_product`・制約 2 本・列 4 本 (`iap_store`・`iap_product_id`・`iap_synced_at`・`iap_is_sandbox`) を落とす (ストアの行があれば列ごと消えるので、本番に行が無いことを確かめてから流す)。(h) `revenuecat_webhook_events`・`plan_store_products` を落とす。(i) `subscription_plans` の 3 行を旧い値 (`Pro` 980 / 9800、`Family Basic` 1480 / 14800、`Family Pro` 2480 / 24800) に戻す。`trial_source` の COMMENT を `20261016210000` の前の文に戻す必要は無い (COMMENT だけ)。

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
| `user_profiles.plan_key_cached` (機能フラグ) | 写像 (9) が書く | 02 の関数が書く | 本冊の写像 (§6.4 の 7.) が同じ式で書く | NULL |
| `family_groups.plan_key / member_limit` | 写像 (10) + トリガー | 02 の関数 + トリガー | 本冊の写像 (§6.4 の 7.) + 既存のトリガー (作成・交代は `billing_has_live_family_plan` と同じ live の集合を読む) | `free` / 4 |
| 家族の門 (`create_family_group`・`family_members` の INSERT。§6.6) | family なら通る | family なら通る | family なら通る | 通らない (`FAMILY_PLAN_REQUIRED`) |
| AI の 1 日の上限 (`ai_daily_limits`) | プランの行 | プランの行 | プランの行 | `free` の行 (5) |
| AI の機能ごとの上限 (`ai_plan_feature_caps`) | プランの行 | プランの行 | プランの行 | `free` の行 (究極 0・画像の作成 0・自動の料理画像 0・献立 2) |
| 料理の保存の自動の料理画像 (`meal_image_auto`。4 本の route と AI 相談の自動実行) | 有料プランは行なし → 安全弁 (1 日 20 回) で作る | 同左 | 同左 | 作らない (`plan_locked` → 料理は `image_error = 'skipped_plan'` で保存・`aiSkipped` なし。§8.8) |
| `GET /api/billing/subscription` (`BillingSummary`) | `source='stripe'`・Portal / 解約 / 取り消し | `source='manual'`・ボタン無し | `source='app_store' / 'play_store'`・`manage_in_store`・ボタン無し (§8.1) | `status=null`・`can_purchase=true` |
| `/account/billing` (Web) | いまのまま | いまのまま | 状態 + 「<ストア> でご契約中…」の文とストアの管理へのリンク (§10.3) | 「プランを見る」 |
| `/frozen/billing` | いまのまま | 文だけ | 文だけ + ストアの管理の案内 (§10.4) | 「契約はありません」 |
| アプリの購入の画面 (§10.6) | 「Web でご契約中」(ボタン無し) | 「ご利用中」(ボタン無し) | 状態 + 「購読の管理」(ストア) + 「購入を復元」 | プランの一覧 + 購入 + 「購入を復元」 |
| `POST /api/billing/checkout` (Web の購入) | 409 | 409 | 409 (`findLiveSubscription` が I 行も返す) | 可 |
| `POST /api/billing/subscription/cancel` / `resume`・`portal` | 可 | `BILL_NO_LIVE_SUBSCRIPTION` (Stripe の id なし) | 同左 (`stripe_subscription_id IS NULL`。ストアの解約はストアで) | 同左 |
| `POST /api/billing/iap/sync` (本冊) | 取り直して写す (I 行が無ければ `BILL_LIVE_ROW_CONFLICT` になりうる) | 同左 | 取り直して写す | 取り直して写す (ストアに契約が無ければ何も作らない) |
| RevenueCat の Webhook (本冊) | 同上 | 同上 | 同上 | 同上 |
| 手動付与の取り消し・期限切れ (02) | 触らない | 触る | 触らない (§6.7) | — |
| 退会 (`deleteAccount` の段階 `billing`) | Stripe を解約 | — | ストアの購読は解約できない (ストアが契約の主体)。行は CASCADE で消え、以後の Webhook は `user_deleted` で何もしない (§6.4 の 1.)。退会の画面に「ストアの購読は各ストアで解約してください」を足す (§10.5) | — |
| 本人のデータの書き出し (`account-export-tables.ts`) | `omit` 済み | — | 新しい列 `iap_store`・`iap_product_id`・`iap_is_sandbox` は書き出す (本人の契約の内容)。`iap_synced_at` は `omit` (内部の時刻。`stripe_synced_at` と同じ扱い) | — |
| `countPlanSubscribers` (運営のプランの廃止の判定) | 数える | 数える | 数える (live 5 値で数える。変更なし) | — |
| 無料体験の 1 人 1 回 (R14・Q-10・S23。Web の `hasUsedTrial` = 同じ利用者・同じ `plan_key` で `trial_started_at` のある行が 1 行でもあれば Checkout に試用を付けない。出どころを見ない。コードは変えない) | 写像 (9) が Checkout の試用の `trial_start` を `trial_started_at` に書く → 数える | `trial_started_at` を入れない (billing/02 §4.1) → 数えない | 写像 (§6.4 の 6.) が `trialing` のときだけ `trial_started_at` / `trial_ends_at` / `trial_source` (`app_store` / `play_store`) を書き、期限切れ・買い直しでも保つ → 数える (Web の同じプランの試用は付かない)。ストアの試用の可否はストアが決める (当社は止めない。§18 の 5) | 数えない (Web の最初の申し込みは `trial_days` = 7) |

公開の面 (プランの表示):

| 面 | Stripe の Price なし (いま) | Price あり | ストアの商品の行なし | ストアの商品の行あり |
|---|---|---|---|---|
| `/pricing` | 3 プランのカード (価格・体験・内容)。CTA 無し (Q-5) | 買える間隔の CTA | (ストアは関係しない) | (同左) |
| `/legal` (特商法) | 価格・支払方法・時期・提供・解約の 5 行を販売の内容で (§10.2) | 同左 | 同左 | 同左 |
| `GET /api/billing/iap/catalog?store=…` | (Stripe は関係しない) | (同左) | `plans: []` | 行のある plan × 間隔 |
| アプリの購入の画面 | (同左) | (同左) | 現在の状態だけ | offerings と一致した商品のカード |

`subscription_plans` と `ai_daily_limits` の書き手 (本冊の migration と干渉しないか):

| 書き手 | 書く列 | 本冊での扱い | 本冊の migration (§6.2・§6.5) との関係 |
|---|---|---|---|
| 本冊の migration (§6.2) | `pro`・`family_basic`・`family_pro` の `monthly_price_jpy`・`yearly_price_jpy`・`trial_days`・`display_name`・`max_members` | 新設 | `stripe_product_id`・`stripe_price_id`・`stripe_yearly_price_id` は書かない (F1 の本番の値はどれも NULL のまま) |
| `POST /api/super-admin/plans/[id]/price-change` (`src/app/api/super-admin/plans/[id]/price-change/route.ts:320-331`) | 変えた間隔の `monthly_price_jpy` / `yearly_price_jpy` と、Stripe の新しい Price の ID (`stripe_price_id` = 月額・`stripe_yearly_price_id` = 年額)。`plan_price_history` に 1 行 | 変更なし | migration の適用は §12 の順 1 (Stripe の Price の登録は順 3 の後)。順 3 で運営がこの API で Price の ID を入れるとき、価格は migration が入れた値のまま (`new_*_price_jpy` に同じ値を渡す)。migration は `stripe_*` を書かないので、この API が入れた ID を消さない |
| Edge Function `stripe-price-sync` (`supabase/functions/stripe-price-sync/index.ts`・`sync.ts`・`deactivation.ts`) | DB に書かない (旧 Price の ID を `subscription_plans` から読むだけ。Stripe に新しい Price を作り、旧 Price を無効にする。`index.ts` の冒頭の契約の注) | 変更なし | 呼ばれるのは上の `price-change` からだけ。本冊は Stripe の Price を作らない |
| `PATCH` / `DELETE /api/super-admin/plans/[id]`・`POST /api/super-admin/plans` (`src/app/api/super-admin/plans/[id]/route.ts`・`src/app/api/super-admin/plans/route.ts`) | プランの行 (表示名・状態・`stripe_product_id` など。operator/04) | 変更なし | 本冊の migration の後に運営が変えた値は、運営の値が正 (migration を流し直さない)。`plan_key` は変えない。`DELETE` は `draft` の行だけ (`:296-301`) で、`draft` の行には `plan_store_products` の行を入れない (§17.2 の行は 3 つの有料プランだけ) ので `ON DELETE RESTRICT` に当たらない |
| `PATCH /api/super-admin/llm/quotas` (`src/app/api/super-admin/llm/quotas/route.ts:129-139`) | `ai_daily_limits` の upsert | 変更なし | migration は `free` を 5 に UPDATE し、有料の 3 行を `ON CONFLICT DO NOTHING` で足す (運営が先に入れた有料の行は上書きしない)。`ai_plan_feature_caps` は運営の画面に出さない (§0.2) |

### 7.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main `ad44c2c5`) | 設計後 |
|---|---|---|
| `subscription_plans` の 3 行 | `Pro` 980 / 9,800、`Family Basic` 1,480 / 14,800、`Family Pro` 2,480 / 24,800 (試用 7) | `個人 Pro` 580 / 5,800、`家族 Basic` 980 / 9,800 (4 人)、`家族 Pro` 1,480 / 14,800 (8 人) (試用 7) |
| `/pricing` | 買えるプラン 0 件 → 「有料プランは準備中です（販売開始前）」 | 公開の 3 プランのカード (価格・体験・内容)。CTA は買える間隔だけ。「準備中」の段落・カード・FAQ は無い |
| `/legal` | 5 行が「有料プランは準備中です（販売開始前）」、所在地・電話番号は請求時開示 | 5 行が販売の内容、所在地・設立・資本金・営業時間・メールは会社情報、電話番号は請求時開示 |
| `/company` | 所在地「準備中（確定次第掲載します）」 | 所在地・設立・資本金・営業時間・メール |
| `/faq` 料金 | 「有料プランは準備中です」 | 無料と有料の線引きと価格 (§10.5) |
| 紹介ページ 料金の章 | 「いまは、無料で使えます。」+ 準備中のカード | 無料と 3 プランのカード (§10.5) |
| `EXT_STRIPE_NOT_CONFIGURED` の文 | 「お支払いの受付は準備中です」 | 「お申し込みを完了できませんでした。時間をおいてお試しください」(§13.1) |
| AI の 1 日の上限 | 全員 10 (free の行だけ) | free 5 / pro 30 / family_basic 30 / family_pro 50 (Q-2) |
| 究極モード | 全員 1 日 1 回 (環境変数) | free 0 (錠)・pro 2・family_basic 2・family_pro 3 (`ai_plan_feature_caps`)。行の無いプラン (org_* など) は環境変数の既定 |
| 料理画像の作成 (`POST /api/ai/image/generate`) | 全員 (上限の中) | free は 403 `AI_FEATURE_NOT_IN_PLAN`、有料は上限の中 |
| 料理の保存の自動の料理画像 (`meal_image_auto`) | 全員 (安全弁 1 日 20 回。達したら画像だけ見送り `skipped_ai_limit` + `aiSkipped`) | free は作らない (`skipped_plan`・`aiSkipped` なし・料理の画面は有料プランの案内)。有料は従来どおり |
| テストの購入 (sandbox) | (ストアの購入が無い) | 本番でも本物の購入と同じに写し、`iap_is_sandbox = true` (Q-13) |
| ストアの猶予期間 (grace period) | (ストアの購入が無い) | `grace_period_expires_date` > now の間は `past_due` (権利は続く。P13) |
| 献立の生成 | 全員 (上限の中) | free 2 / pro 10 / family_basic 10 / family_pro 15 (1 日) |
| 家族グループの作成・メンバーの追加 | 誰でも (グループは `free` / 4) | 家族プランの契約者だけ (`FAMILY_PLAN_REQUIRED`) |
| ストアの購入 | 無い (アプリは料金の画面も無い) | アプリの「プランとお支払い」で App Store / Google Play の購入・復元・管理 |
| ストアの契約の写し | 無い | `personal_subscriptions` の I 行 (`iap_store` / `iap_product_id` / `iap_synced_at`) |
| RevenueCat の Webhook | 無い | `POST /api/webhooks/revenuecat` (署名・claim・取り直し・写像) |
| `BillingSummary.source` | `'stripe' / 'manual' / null` | `'stripe' / 'manual' / 'app_store' / 'play_store' / null` + `manage_in_store` + `features` |
| 手動付与の M 行の述語 | `stripe_subscription_id IS NULL` | `stripe_subscription_id IS NULL AND iap_store IS NULL` |
| 無料体験の 1 人 1 回 (R14・Q-10) | Web だけ: 同じ `plan_key` で `trial_started_at` のある行 (S 行) があれば Checkout に試用を付けない (`hasUsedTrial`。`src/lib/billing/repository.ts:72-80`) | Web の規則は同じ (コードは変えない)。I 行の `trial_started_at` も同じ問い合わせに入るので、ストアで試用した利用者は Web で同じプランの試用を受けない (S23)。ストアの試用はストアの判定 (Apple ID / Google アカウントごと)。Web で試用した利用者のストアの試用は止めない (§18 の 5) |
| 規約・ポリシーの版 | `v2025.1` (#1901 が上げる予定の版を x とする) | x の次の版 (§11) |
| billing/01 §10.4 の規則 (アプリ内課金をしない) | アプリに購入の画面を置かない | アプリ内課金の購入の画面を置く。Web の購入のページへのリンクは引き続き出さない (§16.2) |

### 7.3 状態遷移表 (I 行: 状態 × 出来事 → 遷移先・ガード・副作用)

取り直した `subscriptions[<product_id>]` から状態を決める規則 (`deriveStoreStatus`。§8.1): `refunded_at` あり → `cancelled` / `expires_date` が無い → `active` / `expires_date` > now → (`billing_issues_detected_at` あり → `past_due`、`period_type` が `trial` → `trialing`、それ以外 → `active`) / `expires_date` ≤ now かつ `grace_period_expires_date` > now → `past_due` (ストアの猶予期間。P13) / それ以外 (`expires_date` ≤ now で猶予が無いか尽きた) → `expired`。`cancel_at_period_end` = `unsubscribe_detected_at` あり。イベントの種類は遷移を決めない (すべて取り直しの合図)。

| 現在 | 出来事 (RevenueCat の合図・本人の操作) | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| – (行なし) | `INITIAL_PURCHASE` / 同期 (期間内・trial) | `trialing` | 別の live 行なし | INSERT・`plan_key_cached`・家族グループ・監査 `subscription_created`・`trial_started_at` |
| – | 同上 (期間内・normal / intro) | `active` | 同上 | 同上 |
| – | 同上だが別の live 行あり (S / M / 別の I) | – | — | `BILL_LIVE_ROW_CONFLICT` → Webhook `failed` + 監査 `system.revenuecat.event_failed` (warn) / 同期 409 (S13) |
| – | 取り直したが `subscriptions` に当社の商品が無い (購入していない・別の app_user_id) | – | — | 何もしない (`applied: false, skipped: 'no_subscription'` を TS が返す。§8.4) |
| – | 取り直した商品が `plan_store_products` に無い | – | — | `BILL_IAP_UNKNOWN_PRODUCT` → Webhook `failed` / 同期 422 (S15) |
| – | 取り直した姿が期限切れ・返金済み (履歴) | `expired` / `cancelled` | — | INSERT (履歴の行。live でないので `plan_key_cached` は変わらない) |
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
| `expired` / `cancelled` | 同じ商品を買い直す (`INITIAL_PURCHASE` / `RENEWAL`) | `trialing` / `active` | 別の live 行なし | UPDATE (同じ (user, store, product) の行を再利用。`trial_started_at` は最初の値を保つ) |
| `active` (月額) | `PRODUCT_CHANGE` (年額へ) | 月額の行は期限で `expired`、年額の商品は新しい行 | 年額の行の INSERT 時に月額の行が live なら `BILL_LIVE_ROW_CONFLICT` | 取り直しの `subscriptions` には両方の商品が入る。TS は live でないものを先に、次に `expires_date` の早い順に写し (§8.1 `selectStoreSubscriptions`・§8.4)、月額の行が先に `expired` になってから年額を INSERT する (同じ取り直しの中で順に適用) |
| `trialing` (月額) | `PRODUCT_CHANGE` (年額へ) | 上の `active` (月額) の行と同じ (月額の行は取り直しで期限を過ぎた時点で `expired`、年額の商品は新しい行) | 同上 | 順は上の行と同じ。年額の行の status は年額の取り直しの `period_type` で決まる (`trial` なら `trialing`、それ以外は `active`。§8.1 `deriveStoreStatus`)。月額の行の `trial_started_at` は保つので、Web の同じ `plan_key` の試用は付かない (S23) |
| `past_due` (月額) | `PRODUCT_CHANGE` (年額へ) | 月額の行は取り直しの姿のまま (`past_due`。回復しなければ `EXPIRATION` で `expired`)、年額の商品は取り直しに現れた時点で新しい行 | 同上 (年額の行の INSERT 時に月額の行が live なら `BILL_LIVE_ROW_CONFLICT`) | 順は上の行と同じ (live でないものが先、次に `expires_date` の早い順) |
| 任意 | `TRANSFER` (別の利用者へ移った) | 移動元: `expired` (取り直しの `subscriptions` から消える・または期限切れ) / 移動先: 上の「– (行なし)」の規則 | 移動先に別の live 行があれば `BILL_LIVE_ROW_CONFLICT` | 両方の利用者を取り直す (§8.4)。移動元が `subscriptions` に商品を持たなくなったときは、移動元の live な I 行を `expired` にする (TS が `expires_date=now` の snapshot を作る。§8.4 `projectMissingSubscription`) |
| 任意 | 取り直しが古い (`iap_synced_at` ≥ `p_fetched_at`) | 同じ | — | `skipped: 'stale'` |
| 任意 | 退会 (`user_deleted`) | 行は CASCADE で消える | — | 以後の Webhook は `skipped: 'user_deleted'`・200 |
| 任意 | 凍結 (BAN) | 同じ | — | 写像は凍結を見ない (S22) |

同じ利用者の S 行・M 行の遷移は billing/01 §7.3・billing/02 §7.3 のまま (I 行があるときの「別の live 行あり」の枝が増えるだけ)。

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
| §8.6 `public-plans.ts` (全文の置き換え)・`core.ts` の差分 | 既存 | `place=` / `insert=` |
| §8.7 `env.ts` の差分 | 既存 | `insert=` |
| §8.8 `ai-daily-limit.ts` (全文の置き換え) | `supabase/functions/_shared/ai-daily-limit.ts` (Web・Edge・モバイル共用。import なし) | 単独 (import なし) |
| §8.8 `meal-image.ts` の差分 | `supabase/functions/_shared/meal-image.ts`・`lib/meal-image.ts` (再 export) | `insert=` |
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

/** RevenueCat の REST が 2xx 以外を返した (502)。生の文面は rawMessage に持ち、ログにだけ残す */
export class RevenueCatApiError extends Error {
  readonly status: number;
  readonly rawMessage: string | null;
  constructor(input: { status: number; rawMessage?: string | null }) {
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
  nowMs: number;
}

export function projectStoreSubscription(input: ProjectStoreSubscriptionInput): StoreSubscriptionSnapshot {
  const { sub } = input;
  const transactionId = sub.store_transaction_id;
  return {
    user_id: input.userId,
    iap_store: input.store,
    iap_product_id: input.productId,
    plan_key: input.mapping?.plan_key ?? null,
    billing_interval: input.mapping?.billing_interval ?? null,
    iap_status: deriveStoreStatus(sub, input.nowMs),
    is_sandbox: sub.is_sandbox ?? false,
    purchase_date: sub.purchase_date,
    original_purchase_date: sub.original_purchase_date ?? null,
    expires_date: sub.expires_date ?? null,
    cancel_at_period_end: parseMs(sub.unsubscribe_detected_at) !== null && deriveStoreStatus(sub, input.nowMs) !== 'expired',
    refunded_at: sub.refunded_at ?? null,
    store_transaction_id: transactionId === null || transactionId === undefined ? null : String(transactionId),
  };
}

/**
 * 取り直した subscriptions に無くなった live なストアの行 (TRANSFER で別の利用者へ移った・RevenueCat 側で消えた) を終わらせる snapshot。
 * purchase_date は既存の行の値 (current_period_start か starts_at) を渡す (SQL は purchase_date を必須にしている)
 */
export function projectMissingSubscription(input: {
  userId: string;
  store: IapStore;
  productId: string;
  planKey: string;
  purchaseDate: string;
  nowMs: number;
}): StoreSubscriptionSnapshot {
  return {
    user_id: input.userId,
    iap_store: input.store,
    iap_product_id: input.productId,
    plan_key: input.planKey,
    billing_interval: null,
    iap_status: 'expired',
    is_sandbox: false,
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
}

/**
 * 取り直した subscriptions のうち本冊のストア (app_store / play_store) のものを、適用する順 (live でないものが先、次に expires_date の早い順) に並べる。
 * 順が要る理由: 月額 → 年額の変更 (§7.3 PRODUCT_CHANGE) で、月額の行を先に expired にしてから年額を INSERT しないと BILL_LIVE_ROW_CONFLICT になる
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
    selected.push({ productId, store, sub, mapping: byStoreAndProduct.get(`${store}:${productId}`) ?? null });
  }
  const rank = (entry: SelectedStoreSubscription): number => (isLiveStoreStatus(deriveStoreStatus(entry.sub, nowMs)) ? 1 : 0);
  return selected.sort((a, b) => rank(a) - rank(b) || (parseMs(a.sub.expires_date) ?? 0) - (parseMs(b.sub.expires_date) ?? 0));
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

/** GET /api/billing/iap/catalog の data。アプリは product_id を offerings の package.product.identifier と突き合わせる */
export interface IapCatalogPlan {
  plan_key: string;
  display_name: string;
  trial_days: number;
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
  trial_days: number;
  max_members: number | null;
}

/** 公開のプランとストアの商品の行から、そのストアのカタログを組む (商品の行が無いプランは出さない。R18) */
export function buildIapCatalog(store: IapStore, plans: readonly CatalogPlanRow[], products: readonly PlanStoreProductRow[]): IapCatalog {
  const result: IapCatalogPlan[] = [];
  for (const plan of plans) {
    const rows = products
      .filter((row) => row.store === store && row.plan_key === plan.plan_key)
      .sort((a, b) => IAP_BILLING_INTERVALS.indexOf(a.billing_interval) - IAP_BILLING_INTERVALS.indexOf(b.billing_interval));
    if (rows.length === 0) continue;
    result.push({
      plan_key: plan.plan_key,
      display_name: plan.display_name,
      trial_days: plan.trial_days,
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

/** 利用者の live なストアの行 (取り直した subscriptions に無くなった行を終わらせるために読む) */
export interface LiveStoreSubscriptionRow {
  iap_store: IapStore;
  iap_product_id: string;
  plan_key: string;
  current_period_start: string | null;
  starts_at: string;
}

export interface IapRepository {
  listStoreProducts(): Promise<PlanStoreProductRow[]>;
  listLiveStoreSubscriptions(userId: string): Promise<LiveStoreSubscriptionRow[]>;
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
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REVENUECAT_REQUEST_TIMEOUT_MS),
      });
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
  type LiveStoreSubscriptionRow,
  type PlanStoreProductRow,
  type RevenueCatEventClaim,
  type StoredRevenueCatEventPayload,
} from '@/lib/billing/iap-core';

/** DB の RPC が P0001 で返す業務エラーのうち本冊の写像が足すもの (核の BillingRpcError の code の集合に足す。§13.3) */
const STORE_RPC_ERROR_CODES = new Set(['BILL_UNKNOWN_PLAN', 'BILL_UNKNOWN_IAP_STATUS', 'BILL_LIVE_ROW_CONFLICT']);

const LIVE_STATUSES = ['trialing', 'active', 'paused', 'past_due', 'grace'] as const;

type Admin = ReturnType<typeof getSupabaseAdmin>;

export function createIapRepository(admin: Admin = getSupabaseAdmin()): IapRepository {
  return {
    async listStoreProducts() {
      const { data, error } = await admin.from('plan_store_products').select('plan_key, store, billing_interval, product_id');
      if (error) throw error;
      return (data ?? []).filter((row): row is PlanStoreProductRow => isIapStore(row.store) && (row.billing_interval === 'month' || row.billing_interval === 'year'));
    },
    async listLiveStoreSubscriptions(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select('iap_store, iap_product_id, plan_key, current_period_start, starts_at')
        .eq('user_id', userId)
        .not('iap_store', 'is', null)
        .in('status', [...LIVE_STATUSES]);
      if (error) throw error;
      return (data ?? []).filter((row): row is LiveStoreSubscriptionRow => row.iap_store !== null && isIapStore(row.iap_store) && row.iap_product_id !== null);
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
  needsLazyResync,
  projectMissingSubscription,
  projectStoreSubscription,
  revenueCatWebhookSource,
  selectStoreSubscriptions,
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
 *   1. GET /v1/subscribers/{user id} → 本冊のストアの契約を適用する順に並べる (live でないものが先)
 *   2. plan_store_products に無い商品が 1 つでもあれば BILL_IAP_UNKNOWN_PRODUCT (運営が行を足したあとの同期で写る。S15)
 *   3. 取り直した subscriptions に無い live なストアの行 (TRANSFER で移った・消えた) は expired の snapshot で終わらせる
 *   4. 1 件ずつ billing_apply_store_subscription。BILL_LIVE_ROW_CONFLICT はそのまま投げる (route が 409 / failed にする。S13)
 */
export async function syncStoreSubscriber(deps: IapDeps, userId: string, source: string): Promise<StoreSyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const info = await deps.gateway.getSubscriber(userId);
  const products = await deps.repository.listStoreProducts();
  const selected = selectStoreSubscriptions(info, products, now.getTime());
  if (selected.some((entry) => entry.mapping === null)) throw new IapError('BILL_IAP_UNKNOWN_PRODUCT');
  const outcome: StoreSyncOutcome = { user_id: userId, applied: 0, stale: 0, no_subscription: selected.length === 0, ended: 0 };

  const present = new Set(selected.map((entry) => `${entry.store}:${entry.productId}`));
  for (const row of await deps.repository.listLiveStoreSubscriptions(userId)) {
    if (present.has(`${row.iap_store}:${row.iap_product_id}`)) continue;
    const snapshot = projectMissingSubscription({
      userId, store: row.iap_store, productId: row.iap_product_id, planKey: row.plan_key,
      purchaseDate: row.current_period_start ?? row.starts_at, nowMs: now.getTime(),
    });
    const result = await deps.repository.applyStoreSubscription({ snapshot, fetchedAt: now, source });
    if (result.applied) outcome.ended += 1;
  }
  for (const entry of selected) {
    const snapshot = projectStoreSubscription({ userId, store: entry.store, productId: entry.productId, sub: entry.sub, mapping: entry.mapping, nowMs: now.getTime() });
    const result = await deps.repository.applyStoreSubscription({ snapshot, fetchedAt: now, source });
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
    details.push(`${outcome.applied}/${outcome.stale}/${outcome.ended}${outcome.no_subscription ? '/none' : ''}`);
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
 * 公開のプラン (listPublicPlans) と plan_store_products (RLS の公開の SELECT) だけを読む。鍵も Stripe も RevenueCat も見ない (@/lib/env に届かない)。
 * ログインは要る (アプリの画面からだけ呼ぶ。requireUser)。商品の行が無いプランは返さない (R18)
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
    const { data, error } = await supabase.from('plan_store_products').select('plan_key, store, billing_interval, product_id').eq('store', parsed.data.store);
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
- `GET /api/billing/subscription` (`src/app/api/billing/subscription/route.ts`) の差分: 要約を作る前に `const row = await repository.findLiveSubscription(user.id)` を読み、`needsLazyResync(row, Date.now())` が真のときだけ `createRevenueCatGateway()` を試み (鍵が無ければ `RevenueCatNotConfiguredError` を捕まえて何もしない)、`lazyResyncStoreSubscription({ gateway, repository: createIapRepository() }, user.id, row)` を待ってから `getBillingSummary` を呼ぶ。`findLiveSubscription` は既存の repository の関数 (本冊で `SUBSCRIPTION_VIEW_COLUMNS` に `iap_store, iap_synced_at` を足す。§8.6)。この route は `createRevenueCatGateway` を import するので `@/lib/env` に届き、`EXEMPT_ROUTES` に載せる (§16.1)。凍結中も通す route のまま (認証は `requireUserAllowingFrozen` のまま)。

### 8.6 `src/lib/billing/public-plans.ts` と `src/lib/billing/core.ts` の差分

```ts
// tsc:skip place=src/lib/billing/public-plans.ts — ファイルの全文 (置き換え)。listPurchasablePlans (呼び出し元は /pricing だけ。git grep で確かめた) を listPublicPlans に置き換える
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
  /** ai_daily_limits の値 (プランの行、無ければ free の行。NULL = 無制限) */
  ai_daily_limit: number | null;
  /** ai_plan_feature_caps の行 (feature → daily_cap。0 = 使えない・NULL = 機能ごとの上限なし。行の無い機能は入らない) */
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
// (f) BILLING_ERROR_MESSAGES の EXT_STRIPE_NOT_CONFIGURED の文 (R3。未完成や予定を示す語を使わない)
//   EXT_STRIPE_NOT_CONFIGURED: 'お申し込みを完了できませんでした。時間をおいてお試しください',
// (g) BillingRepository に 1 本足す (repository.ts は ai_daily_limits と ai_plan_feature_caps を service_role で読む。プランの行が無ければ free の行)
//   findPlanFeatures(planKey: string): Promise<PlanFeatures>;
// (h) BILLING_STATUS_TEXT は変えない。ストアの行の 1 行目も同じ文 (「ご利用中」ほか)
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
| Next の AI の route (`src/lib/plan/entitlements.ts:255` `aiDailyLimitResponse`) | `aiDailyLimitPayload(denied)` | 403 `AI_FEATURE_NOT_IN_PLAN` (使えない機能) / 429 (回数) | なし |
| Edge の AI の関数 (`supabase/functions/_shared/ai-usage.ts:185` `aiDailyLimitEdgeResponse`) | `aiDailyLimitPayload(denied)` | 同上 | なし |
| Edge の献立の生成の行の失敗の欄 (`generate-menu-v4/index.ts:2908`・`generate-menu-v5/index.ts:3637`) | `aiDailyLimitMessageOfDenied(aiUsage)` | 「究極モードは、有料プランでお使いいただけます。」/「今日の献立の生成の利用回数の上限 (2 回) に達しました。…」 | なし (読む側の `isAiDailyLimitMessage` がこの文を通す) |
| AI 相談の自動実行の結果 (`src/lib/ai/consultation-action-executor.ts:299-301` `dailyLimitResult`) | `aiDailyLimitMessageOfDenied(denied)` | 同上 | **あり**: `code` を `denied.planLocked === true ? AI_FEATURE_NOT_IN_PLAN_CODE : AI_DAILY_LIMIT_CODE` にし、戻り値の型を `{ error: string; code: typeof AI_DAILY_LIMIT_CODE \| typeof AI_FEATURE_NOT_IN_PLAN_CODE }` にする (import に `AI_FEATURE_NOT_IN_PLAN_CODE` を足す) |
| 行の失敗の文の読み手 (`src/lib/weekly-menu-request-error.ts`・`src/lib/shopping-list-request-error.ts`・`apps/mobile/src/lib/menu-request-error.ts`・`supabase/functions/_shared/stored-failure-messages.ts`) | `isAiDailyLimitMessage(value)` | 使えない機能の文も「こちらで書いた文」として出す | なし |
| Web の画面 (`src/lib/ai/daily-limit-client.ts` `aiDailyLimitMessageOfResponse`) | `aiDailyLimitMessageOfBody` | 403 の本文からも文を作る | **あり** (下の箇条) |
| モバイル (`apps/mobile/src/lib/ai-daily-limit.ts` `aiDailyLimitErrorOf`) | `aiDailyLimitMessageOfBody` | 同上 | **あり** (下の箇条) |
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
 *    画面に出す文 (aiDailyLimitMessage / aiDailyLimitMessageOfBody / aiDailyLimitMessageOfDenied。上限に数えない機能の安全弁で止めたときは
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
  menu_generation: "献立の生成",
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
```

- `src/lib/ai/daily-limit-client.ts` の `aiDailyLimitMessageOfResponse`: 最初の判定を `if (res.status !== AI_DAILY_LIMIT_STATUS && res.status !== AI_FEATURE_NOT_IN_PLAN_STATUS) return null;` にする (import に `AI_FEATURE_NOT_IN_PLAN_STATUS` を足す)。403 で本文の `code` が `AI_FEATURE_NOT_IN_PLAN` でなければ `aiDailyLimitMessageOfBody` が null を返すので、同意の 403 (`AI_CONSENT_REQUIRED`。`aiFetch` が先に `isAiConsentRequiredResponse` で見る) と取り違えない。`aiFetch` は文があれば `notifyAiDailyLimit(message)` で全画面共通の案内を出す (既存の経路)。
- `apps/mobile/src/lib/ai-daily-limit.ts` の `aiDailyLimitErrorOf`: 状態の判定を `const status = Number(match[1]); if (status !== AI_DAILY_LIMIT_STATUS && status !== AI_FEATURE_NOT_IN_PLAN_STATUS) return null;` にする (import に `AI_FEATURE_NOT_IN_PLAN_STATUS` を足す)。`withFriendlyErrors` (`apps/mobile/src/lib/api.ts:83`) と `errorOfFailedResponse` (`apps/mobile/src/lib/failed-response.ts:71`) は `aiDailyLimitErrorOf` を最初に見るので、`legalConsentRequiredErrorOf` (403) より前に判定される (本文の `code` が違うので取り違えない)。
- 料理の保存の自動の料理画像 (`meal_image_auto`) の見送りの理由を分ける (`supabase/functions/_shared/meal-image.ts`。再 export の `lib/meal-image.ts` の名前の一覧に `mealImageSkipReasonOf`・`isMealImagePlanSkippedError` を足す):

```ts
// tsc:skip insert=supabase/functions/_shared/meal-image.ts — MealImageSkipReason・MEAL_IMAGE_SKIPPED_ERRORS を置き換え、isMealImageSkippedError の下に 2 つの関数を足す
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
```

- 4 本の route (`src/app/api/meals/route.ts:187`・`src/app/api/meals/[id]/route.ts:236`・`src/app/api/meal-plans/meals/route.ts:122`・`src/app/api/meal-plans/meals/[id]/route.ts:194`) と `src/lib/ai/consultation-action-executor.ts:838` の `const skipReason = imageUsage?.allowed === false ? 'ai_limit' : 'rate_limit';` を `const skipReason = mealImageSkipReasonOf(imageUsage);` にする (import を足す。`skipReason === 'rate_limit'` の分岐はそのまま)。`'plan'` のとき応答に `aiSkipped` は付かない (`aiDailyLimitSkippedField` が `planLocked` を見る)。
- 料理の画面 `src/app/(main)/menus/weekly/_components/modals/RecipeModal.tsx:213-229`: `isMealImageSkippedError` の 2 か所の前に `isMealImagePlanSkippedError(...)` の枝を置き、画像の枠の文は「料理画像の作成は有料プランでお使いいただけます」、下の注は「料理画像の作成は有料プランでお使いいただけます。有料プランにすると、料理を保存し直したときに画像を作ります。」にする (`skipped_ai_limit` / `skipped_rate_limit` の文は変えない)。`needsImageRetry` は変えない (保存し直すたびに判定し、有料プランになっていれば作る)。

### 8.9 `packages/shared/src/billing-plans.ts` (公開の文とモバイルが読む型の正本。純。import なし)

Web (公開の面・`/account/billing`・`/frozen/billing`・究極モードの錠) とモバイル (購入の画面・究極モードの錠) の両方が読むものを、モバイルが既に読んでいる共有のパッケージ `@homegohan/shared` (`packages/shared`。モバイルは `apps/mobile/app/(auth)/signup.tsx` などで import 済み) に置く。モバイルは Web の `src/` を import しない (origin/main の規則のまま)。`packages/shared/src/index.ts` に `export * from './billing-plans';` を 1 行足す (このファイルが export する名前が origin/main の `packages/shared` に無いことを、名前の一覧の `git grep -n -E "export (const|function|type|interface) (<名前の一覧>)\\b" origin/main -- packages/shared` が 0 件であることで確かめた。実装の段の最初にもう一度流す)。

```ts
/**
 * 有料プランの表示の正本 (billing/03 §8.9)。Web (公開の面・契約の画面) とモバイル (購入の画面・究極モードの錠) が
 * `@homegohan/shared` から読む。純粋な TypeScript (import なし・Intl を使わない。React Native の Hermes でも同じ結果になる)。
 *  - プランの説明の箇条書き・価格の写し・AI の回数の表示 (PLAN_CATALOG ほか)。価格の正本は DB (subscription_plans)。ここの価格は
 *    特定商取引法の表記 (静的なページ) に書くための写しで、tests/billing-plan-catalog.test.ts が migration の値と一致することを見る
 *  - ストアの表示名と購読の管理のページ (IAP_STORE_LABELS・STORE_SUBSCRIPTION_MANAGEMENT_URL)
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

// ─────────────────────────────────────────────────────────────────────────────
// プランの説明 (Q-2・Q-3・Q-4 の推奨値。発注者の選択で変わるのはこの節の数と migration の値だけ)
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

/** AI の 1 日の回数 (Q-2 の推奨。ai_daily_limits の既定の行と同じ値。tests/billing-plan-catalog.test.ts が突き合わせる) */
export const PLAN_AI_DAILY_LIMITS = { free: 5, pro: 30, family_basic: 30, family_pro: 50 } as const;
/** 究極モードの 1 日の回数 (Q-3 の推奨。ai_plan_feature_caps の既定の行と同じ値) */
export const PLAN_ULTIMATE_DAILY_CAPS = { free: 0, pro: 2, family_basic: 2, family_pro: 3 } as const;
/** 献立の生成の 1 日の回数 (Q-3 の推奨) */
export const PLAN_MENU_GENERATION_DAILY_CAPS = { free: 2, pro: 10, family_basic: 10, family_pro: 15 } as const;
/** 家族の人数の上限 (subscription_plans.max_members の値と同じ) */
export const FAMILY_PLAN_MAX_MEMBERS = { family_basic: 4, family_pro: 8 } as const;

/** 有料プランの料理画像の説明 (image_generation と meal_image_auto。無料では作らない。Q-3) */
const PAID_MEAL_IMAGE_FEATURE = "料理画像の作成 (記録した料理の画像を AI が作ります)";

export const PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  {
    plan_key: "pro",
    display_name: "個人 Pro",
    monthly_price_jpy: 580,
    yearly_price_jpy: 5800,
    trial_days: 7,
    max_members: null,
    features: [
      `AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.pro} 回まで (無料プランは ${PLAN_AI_DAILY_LIMITS.free} 回)`,
      `献立の生成を 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.pro} 回まで (無料プランは ${PLAN_MENU_GENERATION_DAILY_CAPS.free} 回)`,
      `究極モード (AI が献立を見直して栄養バランスを改善) を 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.pro} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
  {
    plan_key: "family_basic",
    display_name: "家族 Basic",
    monthly_price_jpy: 980,
    yearly_price_jpy: 9800,
    trial_days: 7,
    max_members: FAMILY_PLAN_MAX_MEMBERS.family_basic,
    features: [
      `家族グループ (${FAMILY_PLAN_MAX_MEMBERS.family_basic} 人まで)。家族の献立の表示・共有の設定・子供の記録`,
      `メンバー 1 人ごとに AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.family_basic} 回まで`,
      `献立の生成を 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.family_basic} 回まで・究極モードを 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.family_basic} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
  {
    plan_key: "family_pro",
    display_name: "家族 Pro",
    monthly_price_jpy: 1480,
    yearly_price_jpy: 14800,
    trial_days: 7,
    max_members: FAMILY_PLAN_MAX_MEMBERS.family_pro,
    features: [
      `家族グループ (${FAMILY_PLAN_MAX_MEMBERS.family_pro} 人まで)。家族の献立の表示・共有の設定・子供の記録`,
      `メンバー 1 人ごとに AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.family_pro} 回まで`,
      `献立の生成を 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.family_pro} 回まで・究極モードを 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.family_pro} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
];

/** 無料プランでできること (料金ページのフリーのカード・FAQ。実際にある機能だけ) */
export const FREE_PLAN_FEATURES: readonly string[] = [
  "写真で食事の記録 (AI が料理を認識して栄養を推定)",
  "記録をほめるひと言 (記録コメント) と栄養メモ",
  `献立の提案 (1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.free} 回まで)`,
  "健康の記録",
  "バッジ",
  "過去の記録の閲覧",
];
/** 無料プランの AI の 1 日の回数の文 (料金ページ・FAQ。回数は PLAN_AI_DAILY_LIMITS.free と同じ) */
export const FREE_PLAN_AI_LIMIT_NOTE = `AI を使う機能 (写真の解析や献立の提案など) は、無料プランでは 1 日 ${PLAN_AI_DAILY_LIMITS.free} 回までご利用いただけます。上限に達した日は翌日 0 時からまたお使いいただけます。`;

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

- 料金ページ・特商法・FAQ・紹介ページ・Web の契約の画面は `@homegohan/shared` から `PLAN_CATALOG`・`FREE_PLAN_FEATURES`・`FREE_PLAN_AI_LIMIT_NOTE`・`planCatalogPriceText`・`planDisplayName`・`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL` を import する。
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
import Purchases, { LOG_LEVEL, type CustomerInfo, type PurchasesOfferings, type PurchasesPackage } from "react-native-purchases";

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
```

```ts
/**
 * apps/mobile/src/lib/iap-catalog.ts (新設。import なしで単独で型検査できる)
 * カタログ (GET /api/billing/iap/catalog) の読み取りと offerings の突き合わせ (純粋。RN の API は使わない。__tests__/lib/iap-catalog.test.ts)。
 * 画面に出すのは、カタログにあり、かつ offerings にある商品だけ (どちらか一方に無い商品は出さない。R18)
 */
export interface CatalogPlanLike {
  plan_key: string;
  display_name: string;
  trial_days: number;
  max_members: number | null;
  products: Array<{ billing_interval: "month" | "year"; product_id: string }>;
}
export interface PackageLike {
  identifier: string;
  product: { identifier: string; priceString: string };
}
export interface PurchasablePlanCard {
  plan_key: string;
  display_name: string;
  trial_days: number;
  max_members: number | null;
  options: Array<{ billing_interval: "month" | "year"; product_id: string; priceString: string; packageIdentifier: string }>;
}

export function matchCatalogWithPackages(plans: readonly CatalogPlanLike[], packages: readonly PackageLike[]): PurchasablePlanCard[] {
  const byProduct = new Map<string, PackageLike>();
  for (const pkg of packages) byProduct.set(pkg.product.identifier, pkg);
  const cards: PurchasablePlanCard[] = [];
  for (const plan of plans) {
    const options: PurchasablePlanCard["options"] = [];
    for (const product of plan.products) {
      const pkg = byProduct.get(product.product_id);
      if (pkg === undefined) continue;
      options.push({ billing_interval: product.billing_interval, product_id: product.product_id, priceString: pkg.product.priceString, packageIdentifier: pkg.identifier });
    }
    if (options.length > 0) cards.push({ plan_key: plan.plan_key, display_name: plan.display_name, trial_days: plan.trial_days, max_members: plan.max_members, options });
  }
  return cards;
}

/** 月額 / 年額の行の文 (自動更新の説明を含む。ストアの審査の要件 P9・P10) */
export function renewalText(interval: "month" | "year", priceString: string, trialDays: number): string {
  const period = interval === "month" ? "1 か月" : "1 年";
  const trial = trialDays > 0 ? `${trialDays} 日間の無料体験のあと、` : "";
  return `${trial}${period}ごとに ${priceString} が自動で更新されます。解約しない限り更新が続きます。`;
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
    const plan = item as { plan_key?: unknown; display_name?: unknown; trial_days?: unknown; max_members?: unknown; products?: unknown };
    if (typeof plan.plan_key !== "string" || typeof plan.display_name !== "string") continue;
    if (typeof plan.trial_days !== "number" || !Number.isInteger(plan.trial_days)) continue;
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
      plans.push({ plan_key: plan.plan_key, display_name: plan.display_name, trial_days: plan.trial_days, max_members: plan.max_members, products });
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
| `matchCatalogWithPackages`・`renewalText`・`CatalogPlanLike`・`PackageLike` | `apps/mobile/src/lib/iap-catalog.ts` |
| `isPurchasesAvailable`・`identifyPurchases`・`fetchOfferings`・`purchase`・`restore`・`currentCustomerInfo` | `apps/mobile/src/lib/purchases.ts` |
| `getTermsUrl`・`getPrivacyUrl`・`webPageUrl` | `apps/mobile/src/lib/siteConfig.ts` (設定タブ `app/(tabs)/settings.tsx:13` と同じ) |
| `PageHeader`・`LoadingState`・`Button`・`Card` | `apps/mobile/src/components/ui` (`app/settings/account.tsx:8` と同じ) |
| `useAuth` | `apps/mobile/src/providers/AuthProvider` |
- `apps/mobile/src/providers/AuthProvider.tsx` の差分: セッションが決まったとき (`applySession` で `userId` が入ったとき) に `identifyPurchases(userId)` を待たずに呼ぶ (`.catch` でログだけ)。`apps/mobile/src/lib/signOut.ts` の `signOutOnDevice` / `signOutWithCleanup` / `signOutAfterAccountDeletion` の掃除の前に `await resetPurchasesOnSignOut()` を足す (失敗しても投げない)。
- 設定タブ `apps/mobile/app/(tabs)/settings.tsx`: 「個人情報」の節の最後 (栄養目標の行の下) に `SettingRow` (icon `💳`・iconBg `#FFF7ED`・title `プランとお支払い`・subtitle `有料プランの購入・復元・購読の管理`・testID `settings-plan-row`・`onPress={() => router.push(PLAN_SCREEN_PATH)}`) を足す。`PLAN_SCREEN_PATH = "/settings/plan"` は `apps/mobile/src/lib/plan-screen.ts` (純) に置く。栄養目標の行から `last` を外し、新しい行に `last` を付ける。
- `apps/mobile/package.json`: `"react-native-purchases": "10.14.0"`・`"expo-dev-client": "~58.0.0"` (Expo SDK 58 に合う版は `npx expo install expo-dev-client` が選ぶ。設計では範囲を書き、実装時に `npx expo install` の結果で固定する) を `dependencies` に足す。`react-native-purchases-ui` は入れない。
- jest: `apps/mobile/__mocks__/react-native-purchases.js` (`configure` / `setLogLevel` / `logIn` / `logOut` / `isAnonymous` / `getOfferings` / `purchasePackage` / `restorePurchases` / `getCustomerInfo` を `jest.fn()` で持つ default export と `LOG_LEVEL`・`PURCHASES_ERROR_CODE`) と `jest.config.js` の `moduleNameMapper` に `'^react-native-purchases$': '<rootDir>/__mocks__/react-native-purchases.js'`。

---

## 9. API 仕様

共通: 本文は `{ data }` / `{ error: { code, message } }` (cross/04 §5)。固定の文だけ (生のエラー文を入れない)。`Cache-Control: no-store`。レート制限は既存のカテゴリ `billing`。

### 9.1 `POST /api/webhooks/revenuecat` — RevenueCat の Webhook の受け口

| 項目 | 内容 |
|---|---|
| 認証 | 署名 (`X-RevenueCat-Webhook-Signature`。§8.2)。ログインのセッションは見ない。middleware の `/api` の分岐は、Stripe の受け口 (`/api/webhooks/stripe`) と同じ扱い (署名で認証する公開の受け口。`lib/supabase/middleware.ts` の Webhook の除外に `/api/webhooks/revenuecat` を足す。§16.1) |
| 本文 | `{ api_version: '1.0', event: {...} }` (P4)。256 KiB 以下 |
| 流れ | 大きさ → 署名 → 外形 (`RevenueCatWebhookEnvelopeSchema`) → 鍵 → claim (`billing_claim_revenuecat_event`。`payload` は最小化した写し) → `handleRevenueCatEvent` (取り直し → 写像) → finish |
| 応答 | §13.2 |
| メンテナンス中 | 503 (Stripe と同じ扱い。`src/lib/maintenance-mode.ts` の止める側の一覧に足す)。RevenueCat は 5 回まで再送する (P4)。それで止まった分は本人の操作からの同期と遅延の再同期が受ける (Q-11) |
| 環境 | `event.environment` が `SANDBOX` のイベントも本番の受け口に届く (RevenueCat は環境を分けない。P4)。本冊は環境で分けない: `SANDBOX` も `PRODUCTION` も同じ流れで取り直して写す (App Store の審査・TestFlight・Google Play の内部テストの購入を権利にするため。Q-13・P12・S24)。どの行がテストの購入かは、取り直した `subscriptions[].is_sandbox` を写像が `personal_subscriptions.iap_is_sandbox` と監査の details の `is_sandbox` に残す (§6.4)。同期の API・遅延の再同期も同じ (route・`handleRevenueCatEvent`・`syncStoreSubscriber` のどこにも環境の分岐を置かない)。環境変数での切り替えは持たない |

### 9.2 `GET /api/billing/iap/catalog?store=app_store|play_store` — ストアで買えるプランと商品 ID

| 項目 | 内容 |
|---|---|
| 認証 | `requireUser` (凍結中は 403。未同意は 403 `LEGAL_CONSENT_REQUIRED`) |
| 入力 | クエリ `store` (`IapCatalogQuerySchema`)。それ以外は 400 `BILL_IAP_INVALID_INPUT` |
| 出力 | `{ data: IapCatalog }` = `{ store, plans: [{ plan_key, display_name, trial_days, max_members, products: [{ billing_interval, product_id }] }] }`。商品の行が無いプランは入らない。価格は返さない (ストアの表示が正。アプリは `package.product.priceString` を出す) |
| 読むもの | `listPublicPlans()` (§8.6) と `plan_store_products` (公開の SELECT)。鍵は見ない |

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

- `POST /api/family/groups` (`create_family_group`)・`POST /api/family/invites/[id]/accept` (`accept_family_invite`)・`POST /api/family/members/child` (`add_family_child`)・`POST /api/family/promotions/[token]/accept` (昇格による `family_members` の INSERT) の各 route は、RPC のエラー文に `FAMILY_PLAN_REQUIRED` が含まれるとき 402 `{ error: { code: 'FAMILY_PLAN_REQUIRED', message: MEMBERSHIP_ERROR_MESSAGES.FAMILY_PLAN_REQUIRED } }` を返す (既存の `MEMBER_LIMIT_EXCEEDED` の写しと同じ形。route は DB の生の文を出さない)。
- `src/lib/errors/membership-errors.ts`: `MembershipErrorCode.FAMILY_PLAN_REQUIRED = 'FAMILY_PLAN_REQUIRED'`、HTTP 402、文「家族プランのご契約が必要です。」を足す (§13.1)。
- `POST /api/family/invites` (招待の作成) は DB の門に当たらない (INSERT は `family_invites`) が、作っても承諾できないので、route の最初で `billing_has_live_family_plan` 相当の判定はしない (招待を作れる・承諾で 402 になる、より先に止めるかは §18 の 6)。

---

## 10. 画面 (Web と公開の面・モバイル)

### 10.1 `/pricing` (公開ページ) — 価格と内容は DB の値、CTA は買える間隔だけ (R2・Q-5)

- `src/app/pricing/page.tsx`: `listPurchasablePlans()` を `listPublicPlans()` (§8.6) に替える (ほかは同じ。Cookie `is_native_app` で `isNativeApp`)。
- `src/app/pricing/PricingPageView.tsx` (`props: { plans: PublicPlan[]; isNativeApp: boolean }`):
  - 消すもの: `PAID_PLAN_PENDING` の定数とその上の注 (`:44`「有料プランは販売開始前。…まだ決まっていないので載せない。」)、それを使う段落・「有料プラン (準備中)」のカード・FAQ (`faqs`) の節。`freeFeatures` と `AI_DAILY_LIMIT_NOTE` は `@homegohan/shared` の `FREE_PLAN_FEATURES` / `FREE_PLAN_AI_LIMIT_NOTE` に置き換える。
  - フリーのカード: 見出し「フリー」・「¥0」・`FREE_PLAN_FEATURES` の箇条書き・`FREE_PLAN_AI_LIMIT_NOTE`・「無料で始める」(`/signup`)。
  - 有料のカード (`plans` の順。`isNativeApp` では描かない。いまと同じ規則): 見出し `display_name`・`trial_days > 0` なら「X日間無料」・`PLAN_CATALOG` の同じ `plan_key` の `features` の箇条書き (`PLAN_CATALOG` に無い `plan_key` は箇条書きなし)・金額の行は **両方の間隔を常に出す** (`¥{amount} / 月（税込）`・`¥{amount} / 年（税込）`。`amountJpyFor` が null か 0 の間隔は出さない)・CTA は `isPurchasable(plan, interval)` が真の間隔だけ (「月額で始める」/「年額で始める」。行き先は既存の `checkoutHref`)。買える間隔が 1 つも無いカードは CTA の代わりに何も置かない (文も置かない。Q-5)。
  - ページの末尾の「まずは無料で始めてみませんか？」+「無料で始める」は残す。
  - 注記 (有料のカードの下に 1 段落。`isNativeApp` では描かない): 「お支払いはクレジットカード (Stripe) のほか、iOS / Android アプリでは App Store / Google Play のアプリ内課金でもお申し込みいただけます。アプリ内課金の価格は各ストアの表示が正となります。」(Q-1 で価格が違うときの説明を兼ねる)。
- `tests/public-claims-guard.test.ts` の直し方 (§16.1): `FORBIDDEN` から `¥980`・`980円`・`9,800円` を外し (本冊の価格)、「依頼で名指しされた文字列」の `required` から `¥980` を外す。`#1151 料金ページ` の describe は「価格と内容を出し、『準備中』『販売開始前』を出さない。`billingPeriod` を使わない」に書き換える。`billing/01 §10.1` の describe のテスト 50 は「Price なし → カードは出るが CTA が無い」に、51 は「Price あり → CTA」に (0 件の `plans` のときはフリーのカードだけ)。
- `src/lib/seo/public-pages.ts` の `/pricing` の description に「準備中」があれば販売の文に替える (grep で確かめる。§16.1)。

### 10.2 `/legal` (特定商取引法に基づく表記) と `/company` (運営会社) — 追記 2 の会社情報と販売の内容

- `src/lib/business-info.ts` に定数を足す (既存の 3 つはそのまま。Q-9 で `DISCLOSED_ON_REQUEST` の文は変えない):
  ```ts
  // tsc:skip append=src/lib/business-info.ts
  /** 所在地 (特定商取引法に基づく表記・運営会社ページ) */
  export const BUSINESS_ADDRESS = '〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F';
  /** 設立 */
  export const BUSINESS_FOUNDED = '2025年1月31日';
  /** 資本金 */
  export const BUSINESS_CAPITAL = '2,000,000円';
  /** 会社の公開の連絡先のメールアドレス (特定商取引法に基づく表記・運営会社ページ。Q-8) */
  export const BUSINESS_EMAIL = 'info@mhd-iken.com';
  /** 営業時間 */
  export const BUSINESS_HOURS = '平日 9:00〜17:00 (年末年始を除く)';
  ```
- `src/app/legal/page.tsx` の `rows` (上から。文は固定。`PAID_PLAN_PENDING` の定数とその上の注 (`:24`) は消す):
  | label | value |
  |---|---|
  | 販売事業者 | `BUSINESS_NAME` |
  | 代表者 | `BUSINESS_REPRESENTATIVE` |
  | 所在地 | `BUSINESS_ADDRESS` |
  | 電話番号 | `DISCLOSED_ON_REQUEST` |
  | メールアドレス | `BUSINESS_EMAIL` (Q-8) |
  | 営業時間 | `BUSINESS_HOURS` |
  | お問い合わせ | (いまのまま。`/contact` のリンク) |
  | 販売価格 | `planCatalogPriceText()` (3 行。税込) + 改行 + 「無料プランは 0 円です。」 |
  | 商品代金以外の必要料金 | (いまのまま) |
  | 支払方法 | 「クレジットカード (Stripe の決済画面で受け付けるカード)。iOS / Android アプリでは App Store / Google Play のアプリ内課金。」 |
  | 支払時期 | 「お申し込み時に初回のお支払いをいただきます (無料体験のあるプランは、無料体験の終了時)。以後は毎月または毎年の更新日に自動でお支払いいただきます。」 |
  | サービス提供時期 | 「お支払いの手続きが完了した時点から、すぐにご利用いただけます。」 |
  | 返品・キャンセル | 「デジタルコンテンツの性質上、購入後の返品・返金は原則としてお受けしておりません。\n\nただし、サービスに重大な瑕疵があった場合は、個別に対応いたします。」(いまのまま) |
  | 解約について | 「いつでも解約できます。Web でお申し込みの方は「プランとお支払い」の画面から、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。期間の途中の解約による日割りの返金はありません。」 |
  | 定期購入について | 「有料プランは自動更新の定期購入です。解約しない限り、更新日に同じ金額が自動で請求されます。」 |
  | 動作環境 | (いまのまま。Q-12) |
  - 「最終更新日」の文は実装の日付に更新する。
- `src/app/company/page.tsx`: `PENDING` の定数とその上の注 (`:32`) を消し、会社情報の表を 会社名 / 代表者 / 所在地 (`BUSINESS_ADDRESS`) / 設立 (`BUSINESS_FOUNDED`) / 資本金 (`BUSINESS_CAPITAL`) / メールアドレス (`BUSINESS_EMAIL`) / 営業時間 (`BUSINESS_HOURS`) / お問い合わせ (`/contact`) にする。問い合わせ欄の「メールアドレス・電話番号・所在地の掲載は準備中です」の文を消す。
- 見張りの直し方: `tests/business-info-legal-pages.test.ts` (所在地の期待を `BUSINESS_ADDRESS` に・メールアドレスを `BUSINESS_EMAIL` に・`営業時間` の行の存在)、`tests/public-claims-guard.test.ts` (`FORBIDDEN` から `資本金` を外す・`/legal` の 5 行の `PAID_PLAN_PENDING_NOTICE` の it を販売の文の it に・`/company` の所在地の期待を `BUSINESS_ADDRESS` に・`PENDING_NOTICE` が無いことの it はそのまま)、`tests/e2e/b10-unexplored-areas.spec.ts` の 4-1 / 4-3 (「準備中」の `toBeVisible` を、価格の文 (`580円`) の `toBeVisible` に)。

### 10.3 `/account/billing`・究極モードの錠・料理画像の作成 (Web)

- `src/app/(main)/account/billing/page.tsx` (`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL`・`planDisplayName` は `@homegohan/shared` から import): `const store = summary.manage_in_store;` が null でないとき、ボタン (Portal・解約・取り消し) を描かず、状態の文の下に「`{IAP_STORE_LABELS[store]}` でご契約中です。解約・お支払い方法の変更は `{IAP_STORE_LABELS[store]}` の定期購読の管理から行えます。」と、`STORE_SUBSCRIPTION_MANAGEMENT_URL[store]` への外部リンク「定期購読の管理を開く」(`target="_blank" rel="noopener"`)。`isNativeApp` では文だけ (リンクも出さない。アプリの購入の画面が受け持つ)。`planLabel` は `planDisplayName(summary.plan_key)` を出す。
- 究極モードの錠 (`src/components/ai-assistant/V4GenerateModal.tsx`): `GET /api/billing/subscription` の `features.ai_feature_caps.menu_generation_ultimate` が `0` のとき、トグルを `aria-disabled` + 錠のアイコンにし、説明に「究極モードは有料プランでお使いいただけます」を出す (押しても ON にならない)。`features` が読めない (401・失敗) ときは錠を出さない (サーバの判定が最後の砦)。読むのは `src/hooks/useBillingSummary.ts` (新設。`export const BILLING_SUBSCRIPTION_API_PATH = '/api/billing/subscription';`・`export function useBillingSummary(enabled: boolean): BillingSummaryWire | null` = `enabled` が偽から真になるたびに `fetch(BILLING_SUBSCRIPTION_API_PATH)` を 1 回読み、`res.ok` なら本文の `data` を `@homegohan/shared` の `parseBillingSummaryWire` で読む。失敗・形が違うときは null。`SWR` は使わない) で、モーダルが開くたびに読む (`useBillingSummary(open)`)。
- 料理画像の作成 (`POST /api/ai/image/generate` を押す画面): 403 `AI_FEATURE_NOT_IN_PLAN` の本文の `error` (固定の文) をそのまま出す (既存の `daily-limit-client.ts` の経路。§8.8)。ボタンの錠は付けない (押して案内が出る)。

### 10.4 `/frozen/billing` と退会の画面

- `src/app/frozen/billing/page.tsx` (`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL` は `@homegohan/shared` から): `const store = summary.manage_in_store;` が null でないとき、解約のボタンを描かず「`{IAP_STORE_LABELS[store]}` の定期購読の管理から解約できます。」の文を出す (`STORE_SUBSCRIPTION_MANAGEMENT_URL[store]` へのリンクは `isNativeApp` でなければ出す)。
- 退会の画面 (`src/app/(main)/settings/page.tsx` の退会の確認と `src/app/frozen/account/page.tsx`): 確認の文に「App Store / Google Play でお申し込みの有料プランは、退会しても自動では解約されません。各ストアの定期購読の管理から解約してください。」を足す (ストアの契約が無い人にも出す。固定の文。§7.1 の退会の行)。

### 10.5 FAQ (`/faq`)・紹介ページ (`landing-copy.ts`)

- `/faq` の `payment` の 3 項目を次に置き換える (1 項目 1 行の `{ category, q, a }` の形は保つ。見張り `tests/public-claims-guard.test.ts` の FAQ の describe は `faqAnswer` で読む):
  - 「現在、料金はかかりますか？」→ 「無料プランでは、写真での食事の記録、記録をほめるひと言、献立の提案、健康の記録などをお使いいただけます。`FREE_PLAN_AI_LIMIT_NOTE` 有料プランでは、AI を使う回数の上限が上がり、究極モード・料理画像の作成 (記録した料理の画像) ・家族グループが使えます。」(文は `@homegohan/shared` の `billing-plans.ts` の定数から組む)
  - 「有料プランはありますか？」→ 「個人 Pro (月額 580 円 / 年額 5,800 円)、家族 Basic (月額 980 円 / 年額 9,800 円・4 人まで)、家族 Pro (月額 1,480 円 / 年額 14,800 円・8 人まで) があります。どのプランも 7 日間の無料体験つきです。料金ページでご案内しています。」(`PLAN_CATALOG` から組む。`/pricing` へのリンクは FAQ の本文には書けないので文だけ)
  - 「返金はできますか？」→ (いまのまま)
  - 追加: 「有料プランを解約するには？」→ 「Web でお申し込みの方は、設定の「プランとお支払い」から解約できます。App Store / Google Play でお申し込みの方は、各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。」
- `src/components/marketing/landing-copy.ts` (紹介ページ。設計書 `marketing/01-landing-site.md` の文言の正本。§16.2):
  - 要点 (`:755`) と FAQ (`:813`) の「有料プランは準備中です（販売開始前）。内容や料金が決まりましたらご案内します。」を「有料プランでは、AI を使う回数の上限が上がり、究極モード・料理画像の作成・家族グループが使えます。」に。
  - 料金の章 (`:766-781`): `title: '無料ではじめて、必要になったら有料プランへ。'`、`lead` を「登録してお使いいただける機能は無料です。AI を使う機能には 1 日の利用回数の上限があります。有料プランでは上限が上がり、究極モード・料理画像の作成・家族グループが使えます。」に、カード `paid` を 3 枚 (`PLAN_CATALOG` の `display_name`・`月額 580円 / 年額 5,800円` の形・`features` の先頭 2 つ・`cta: { label: '料金プランを見る', href: '/pricing' }`) に。`badge: '準備中'` は消す。
  - 主張の表 `claims` の `free-now` (`:860`) を「登録して使える機能は無料・有料プランは 3 つ (個人 Pro / 家族 Basic / 家族 Pro)」に、`evidence` に `packages/shared/src/billing-plans.ts` を足す。`ai-daily-limit` (`:861`) の `condition` の「既定は free の 10 回」を「free は 5 回」に (回数は文に書かないまま)。
  - `ASSURANCES` の「いまは無料で使えます」は「無料で始められます」に。
- `src/app/(main)/badges/page.tsx`・組織の画面・運営の画面の「準備中」は #1911 (本冊の面ではない)。

### 10.6 モバイルの購入の画面 `apps/mobile/app/settings/plan.tsx` (R15・R16)

識別子の取り込み元は §8.10 の表 (Web の `src/` を import しない)。画面の状態: `summary: BillingSummaryWire | null`・`loadError: boolean`・`cards: PurchasablePlanCard[]`・`busy: boolean` (購入・復元の最中はボタンを押せない)・`notice: string | null` (完了・失敗の文)。

画面の要素 (上から):

| # | 要素 | 文・振る舞い |
|---|---|---|
| 1 | 見出し | 「プランとお支払い」(`PageHeader`。戻るで設定タブへ) |
| 2 | 現在の状態 | `fetchBillingSummary()` の `summary`: `status === null` かつ `effective_plan_key === 'free'` → 「無料プランをご利用中です」/ `status === null` かつ `effective_plan_key !== 'free'` (家族・組織のプラン) → 「`planDisplayName(summary.effective_plan_key)` をご利用中です (ご家族または組織のプラン)」/ live → 「`planDisplayName(summary.plan_key)` をご利用中です」+ `subscriptionStatusLines(summary)` の各行 (無料期間中（X まで）・解約の予約) + 出どころ: `source === 'stripe'` → 「Web でお申し込みのプランです。解約・お支払い方法の変更は Web の「プランとお支払い」から行えます。」(リンク無し。R16) / `'manual'` → 文なし / `'app_store'`・`'play_store'` → 「`IAP_STORE_LABELS[source]` でお申し込みのプランです。」+ ボタン「定期購読の管理を開く」(押すと `const info = await currentCustomerInfo(); Linking.openURL(info?.managementURL ?? STORE_SUBSCRIPTION_MANAGEMENT_URL[source])`) |
| 3 | プランの一覧 (`summary.can_purchase` かつ `isPurchasesAvailable()` かつ `cards.length > 0` のときだけ) | カード = `display_name`・`PLAN_CATALOG` の同じ `plan_key` の `features` (無ければ箇条書きなし)・`max_members` があれば「X 人まで」・間隔ごとの行 = `priceString` + `renewalText(interval, priceString, trial_days)` (自動更新と無料体験の長さ・終了後の価格の説明。P9・P10) + ボタン「`<display_name>` を月額で始める」/「`<display_name>` を年額で始める」。請求額 (`priceString`) をカードで最も大きい文字にする (P9 の「most prominent」)。`trial_days > 0` なら「`trial_days` 日間無料」の見出しの下に「体験の終了後は `priceString` が請求されます」 |
| 4 | 購入 | ボタン → `busy = true` → `purchase(pkg)` (`pkg` は `fetchOfferings()` の `current.availablePackages` のうち `identifier === option.packageIdentifier` のもの) → `ok` なら `syncIapPurchases()` → `summary` を置き換え、`notice` =「お申し込みが完了しました」。`cancelled` なら何もしない。`ok: false, cancelled: false` → `notice` = `BILLING_PURCHASE_FAILED_MESSAGE` (ストアの生の文は出さない)。同期が投げた例外 → `notice` = `billingErrorMessageOf(e)` (409 `BILL_IAP_SYNC_CONFLICT` などはサーバの固定の文)。最後に `busy = false` |
| 5 | 購入を復元 | ボタン「購入を復元」(常に出す。P9 3.1.1。`isPurchasesAvailable()` が偽なら押せない形で出す) → `restore()` → `syncIapPurchases()` → `summary` を置き換え。置き換えた `summary.status` が null なら `notice` =「復元できる購入がありませんでした」。例外 → `notice` = `billingErrorMessageOf(e)` |
| 6 | 規約へのリンク | 「利用規約」「プライバシーポリシー」(`getTermsUrl()` / `getPrivacyUrl()`。`Linking.openURL`。設定タブと同じ) と「特定商取引法に基づく表記」(`webPageUrl('/legal')`)。P9 (Terms of Use と Privacy Policy へのリンク) |
| 7 | 読み込み・失敗 | 要約の読み込み中は `LoadingState`。`fetchBillingSummary()` が投げたら `loadError = true` で `BILLING_SUMMARY_LOAD_FAILED_MESSAGE` と「再読み込み」のボタン (2・3 は出さない。5・6 は出す) |

- 画面を開いたとき: `identifyPurchases(user.id)` (`useAuth().user`) → `fetchBillingSummary()` → `Platform.OS` が `ios` なら `'app_store'`、`android` なら `'play_store'` を `store` にし (それ以外は 3 を出さない) → `fetchIapCatalog(store)` → `fetchOfferings()` (`current?.availablePackages ?? []`) → `cards = matchCatalogWithPackages(plans, packages)`。カタログか offerings の読み込みが失敗したら `cards = []` (3 を出さない。2 はそのまま)。並行して `syncIapPurchases()` を 1 回 (成功したら `summary` を置き換え。失敗しても画面は読んだ要約で描く)。`AppState` が `active` に戻ったとき `syncIapPurchases()` をもう一度。
- 錠 (究極モード): `apps/mobile/src/components/menu/UltimateModeToggle.tsx` に `locked?: boolean` を足し、`V4GenerateModal` (`apps/mobile/src/components/menu/V4GenerateModal.tsx`) がモーダルを開くたびに `fetchBillingSummary()` を 1 回読み、`summary.features.ai_feature_caps.menu_generation_ultimate === 0` のとき `locked` を渡す (読めなければ錠を出さない。サーバの 403 が最後の砦)。`locked` のトグルを押すと `Alert.alert("プランとお支払い", "究極モードは有料プランでお使いいただけます。設定の「プランとお支払い」からお申し込みいただけます。")` (Web の文と同じ意味)。
- Web の購入のページ (料金・契約の管理) のパスの文字列は書かない (見張り `no-web-purchase-links.test.ts` はそのまま。冒頭のコメントを本冊の規則 (アプリ内課金はアプリの画面で、Web の購入のページへは誘導しない) に書き換える)。
- 遷移先の実在 (`route-targets-exist.test.ts`): `/settings/plan` は `app/settings/plan.tsx` で満たす。

---

## 11. 利用規約・プライバシーポリシー・特定商取引法の有料の条文 (段 E。#1901 の版の上に足す差分)

- 前提: #1901 (規約とポリシーの作り込み) が先にマージされる。その版を x (`LEGAL_DOCUMENTS.terms_of_service.version` / `privacy_policy.version`) とし、本冊の段 E は両方の版を x の次 (`vYYYY.N` の N を 1 進める。形式 `^[0-9A-Za-z._-]{1,20}$`) に上げ、`effectiveDate` を公開の日にする。版を上げると既存の再同意の仕組みが全員に再同意を求める (F14・S21)。#1901 が先に入らない場合は、本冊の段 E は #1901 のマージを待つ (§15.1)。
- 文言の最終の確認 (弁護士) は #1901 と同じ扱い (発注者の作業。§12)。本冊の条文は、その確認に出す草案。
- 未完成や予定を示す語 (§14.1 の `UNFINISHED_WORDS`: 準備中・販売開始前・近日・予定・まだ・確定次第・これから) を書かない。

### 11.1 利用規約に足す条 (`src/app/terms/page.tsx`。条の番号は #1901 の版の最後に続ける)

| 条 | 見出し | 内容 (草案) |
|---|---|---|
| 有料プラン | 有料プラン | 当社は、無料プランのほかに有料プラン (個人 Pro・家族 Basic・家族 Pro) を提供する。各プランの内容と料金 (税込) は料金ページと特定商取引法に基づく表記に掲げる。有料プランは自動更新の定期購入で、利用者が解約しない限り、月額または年額の期間ごとに同じ料金が自動で請求される |
| お支払い | お支払いの方法 | Web では当社が利用する決済代行事業者 (Stripe) を通じたクレジットカード、iOS / Android のアプリでは App Store / Google Play のアプリ内課金で支払う。アプリ内課金の請求・返金・領収はそれぞれのストアの規約に従う。アプリ内課金の価格は各ストアの表示が正となる |
| 無料体験 | 無料体験 | 有料プランに 7 日間の無料体験を付けることがある。無料体験は同じプランにつき 1 回限りとし、期間が終わると自動で有料の期間に移って請求が始まる。無料体験の間に解約すれば請求は発生しない |
| 解約 | 解約と返金 | 利用者はいつでも解約できる (Web はプランとお支払いの画面から、アプリ内課金は各ストアの定期購読の管理から)。解約後も支払い済みの期間の終わりまで利用できる。期間の途中の解約による日割りの返金は行わない。法令で定める場合を除き、支払い済みの料金は返金しない |
| プランの変更 | プランの変更 | Web (Stripe) と Google Play でお申し込みのプランを変えるときは、いまのプランを解約し、期間の終わりのあとに新しいプランを申し込む。App Store でお申し込みのプランは、App Store の定期購読の管理からプランと期間を変更できる (変更の時期と精算は App Store の規約に従う)。同時に契約できる有料プランは 1 つで、2 つ目の契約 (Web とアプリ内課金の両方・2 つのストア) は当社のサービスに反映されない。その場合は当社にご連絡いただければ、二重のお支払いにならないよう、当社が解約・返金できるもの (Web の契約・Google Play の購入) は当社が解約・返金し、App Store の購入は Apple への返金の申し込みの方法をご案内する |
| 料金の改定 | 料金の改定 | 当社は料金を改定することがある。改定は新しい申し込みから適用し、契約中の利用者には、法令とストアの規約の定めに従って事前に通知する |
| 家族プラン | 家族プラン | 家族プランの契約者 (代表者) は、プランの人数の上限までメンバーを家族グループに招待できる。契約が終わると、新しいメンバーの追加はできなくなる。メンバーの利用は本規約に従う |
| 利用の制限 | 利用回数の上限 | AI を使う機能には、プランごとに 1 日の利用回数の上限がある。上限の値は料金ページに掲げる。当社は濫用を防ぐために上限を変えることがある |

### 11.2 プライバシーポリシーに足す項 (`src/app/privacy/page.tsx`)

保存期間の条は本冊の差分に含めない (保存期間を書くかどうかは #1901 の版の範囲)。本冊の動きは、契約の行 (`personal_subscriptions`) は退会で消え (CASCADE。§7.1 の退会の行)、監査の記録 (`admin_audit_logs`) と RevenueCat のイベントの最小化した写し (`revenuecat_webhook_events.payload`) は運営の保存期間 (operator/07) に従う。ポリシーに新しい保存期間を書くときは、この動きに合わせる (§18 の 18)。

| 項 | 内容 (草案) |
|---|---|
| 決済に関する情報の取扱い (第三者提供・委託) | Web でのお支払いでは、クレジットカードの番号は当社のサーバを通らず、決済代行事業者 Stripe (Stripe, Inc. (アメリカ合衆国) および Stripe Japan 株式会社) が取り扱う。当社は Stripe から、顧客の識別子・契約の状態・請求の金額と日付を受け取る。アプリ内課金では、Apple (App Store) または Google (Google Play) が決済を行い、当社は RevenueCat, Inc. (アメリカ合衆国) を通じて、購入の識別子・商品・期間・状態を受け取る。当社は、利用者の識別子 (当社の利用者 ID) を RevenueCat に送信する |
| 外国にある第三者への提供 | 上の Stripe (アメリカ合衆国)・RevenueCat (アメリカ合衆国)・Apple・Google への提供は、個人情報保護法第 28 条に基づき、各事業者の所在する国の制度と講じている措置について本ポリシーで公表したうえで行う (#1901 が整える外国にある第三者の節に、決済の 2 社を足す) |
| 外部送信 (電気通信事業法) | iOS / Android アプリは、アプリ内課金のために RevenueCat の SDK を組み込み、端末の識別子 (SDK が生成する匿名 ID と当社の利用者 ID)・アプリの版・OS・購入の情報を RevenueCat に送信する。送信の目的は購入の確認と契約の状態の同期。#1901 が設ける外部送信の一覧 (情報送信指令通信の公表) に RevenueCat の行を足す |

### 11.3 特定商取引法に基づく表記

§10.2 の表のとおり (条文の差分ではなく、ページの行の置き換え)。

### 11.4 版の繰り上げとテスト

- `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` の 2 つの `version` と `effectiveDate` を上げる。`packages/shared/src/legal-versions.test.ts` (形式) はそのまま緑。`tests/legal-consent-*` のスナップショットに版が入っていれば更新する (§16.1)。
- 同意画面 (`/legal-consent`) の「改定あり」の表示は既存の仕組みで出る。

---

## 12. 発注者の作業と申請の順 (追記 1。どの段が終わったら何を出せるか)

| 順 | 前提 (すべて終わってから) | 当社の作業 (段) | 終わると出せる申請 (発注者) | 申請のあとに当社がすること |
|---|---|---|---|---|
| 1 | — | 段 A (DB: 価格・線引き・ストアの表) と段 C (公開の面: 料金・特商法・運営会社・FAQ・紹介ページ) のマージと本番の反映 | なし (Stripe の申請には順 2 の規約とポリシーの有料の条文の公開も要る) | — |
| 2 | #1901 (規約とポリシーの作り込み) のマージ | 段 E (規約とポリシーの有料の条文。§11) | 弁護士の確認 (#1901 と同じ) | 確認のあと、版を上げてデプロイ (再同意が走る) = 規約とポリシーの有料の条文の公開 |
| 3 | 順 1 と順 2 の本番の反映 (サイトに価格・有料の中身・特商法・規約とポリシーの有料の条文・解約と返金の条件・連絡先がそろっている状態。追記 1・P11) | — | **Stripe の本番の有効化** (事業の情報・銀行口座・サイトの URL。P11) | 承認後: Vercel に `STRIPE_SECRET_KEY` (`sk_live_`) と `STRIPE_WEBHOOK_SECRET` (#1113)。Stripe の Dashboard の設定 (billing/01 §17.1)。Product と Price を作り `PATCH /api/super-admin/plans/[id]` + `price-change` で `stripe_price_id` / `stripe_yearly_price_id` を入れる = **Web の販売開始** (`/pricing` に CTA が出る) |
| 4 | — (順 1〜3 と並行してよい。ストアの契約・商品の作成は審査の提出ではない) | 段 B (サーバ: Webhook・同期・カタログ) と段 D (モバイル: 購入の画面) のマージ + EAS の開発ビルド (sandbox で購入の流れを確かめられる状態) | **App Store**: Paid Applications Agreement の署名・税と銀行の登録 → In-App Purchase Key (`.p8`) と Issuer ID の発行 (P7) → Subscription Group と 6 つの商品 (個人 Pro 月 / 年・家族 Basic 月 / 年・家族 Pro 月 / 年。商品 ID は §17.2 の表) の作成・価格 (Q-1)・ローカライズ・無料体験 (7 日。Introductory Offer)・審査用のスクリーンショット **/ Google Play**: Google Payments の merchant profile → `eas build --profile preview --platform android` の AAB を内部テストのトラックにアップロード (Billing Library 入り。P8) → 3 つの購読と base plan 6 つ (`monthly-autorenewing` / `annual-autorenewing`) + 無料体験の offer → Google Cloud のサービスアカウントと権限 (P8。36 時間) **/ RevenueCat**: プロジェクト・iOS と Android のアプリ (bundle id `com.homegohan.app`)・`.p8` と Issuer ID・サービスアカウントの JSON・商品 6 つ (Google は `<subscription_id>:<base_plan_id>`)・Entitlement 3 つ (`pro` / `family_basic` / `family_pro`。それぞれに月額と年額の商品)・Offering `default` に 6 つの package・Webhook (URL `https://<サイト>/api/webhooks/revenuecat`・署名 ON・秘密を控える)・App Store Server Notifications と Google RTDN の接続 (推奨)・Restore behavior は既定のまま | 承認後: Vercel に `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET`、EAS に `EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY` を登録 → `plan_store_products` に 6 行 (運営が SQL で INSERT。§17.2) → 本番のビルド (`eas build --profile production`) |
| 5 | 順 2 と順 4 (アプリの購入の画面の「利用規約」「プライバシーポリシー」のリンク先 (§10.6 の 6) に有料の条文が載っている状態) | 本番のビルドの提出 | **App Store の審査** (最初の購読は購入の流れが入ったアプリの版と一緒に提出。審査用のメモに「購入の画面は 設定 → プランとお支払い」「購入の復元のボタン」「テスト用のサンドボックスのアカウント」を書く) **/ Google Play の審査** (製品版のトラックへ昇格) | 公開後: 整合ゲートで §17.4 の受け入れを確かめる = **アプリの販売開始** |

- 順 1 と順 4 は並行してよい。順 2 は #1901 のマージのあと。順 3 (Stripe の有効化) は順 1 と順 2 の本番の反映のあと。順 5 (ストアの審査) は順 2 と順 4 のあと。
- 発注者の作業の一覧 (Issue #1912 の「オーナー作業」+ 本冊で増えたもの): Stripe の鍵と商品 (#1113)・App Store Connect (契約・税・銀行・商品・審査)・Google Play Console (merchant・AAB・購読・サービスアカウント)・RevenueCat (アカウント・接続・商品・entitlement・offering・Webhook・鍵)・特商法の会社情報 (追記 2 で確定済み)・規約の弁護士の確認・Q-1〜Q-13 の選択。

---

## 13. エラー表

### 13.1 API (利用者向け。本文は固定の文。未完成や予定を示す語 (準備中・販売開始前・近日・予定・まだ・確定次第・これから) を使わない)

| コード | HTTP | 出どころ | 文 |
|---|---|---|---|
| `BILL_IAP_INVALID_INPUT` [NEW] | 400 | catalog のクエリ | 入力値が不正です |
| `AUTH_UNAUTHENTICATED` | 401 | `requireUser` | 認証が必要です |
| `AUTH_ACCOUNT_FROZEN` | 403 | middleware・`requireUser` (catalog・sync は凍結中は通さない) | 権限がありません |
| `LEGAL_CONSENT_REQUIRED` | 403 | middleware の同意ゲート (catalog・sync は許可リストに入れない) | 既存の文 |
| `AI_FEATURE_NOT_IN_PLAN` [NEW] | 403 | `consume_ai_usage_at` (`plan_locked`) → `aiDailyLimitPayload` | `{機能}は、有料プランでお使いいただけます。` (`aiFeatureNotInPlanMessage`。`feature` も返す) |
| `FAMILY_PLAN_REQUIRED` [NEW] | 402 | `create_family_group`・`family_members` のトリガー → family の route | 家族プランのご契約が必要です。 |
| `BILL_IAP_SYNC_CONFLICT` [NEW] | 409 | sync (`BILL_LIVE_ROW_CONFLICT` の写し) | すでに別のご契約があるため、この購入をご利用のプランに反映できませんでした。お問い合わせフォームからご連絡ください。二重のお支払いにならないよう対応します |
| `BILL_IAP_UNKNOWN_PRODUCT` [NEW] | 422 | sync (`plan_store_products` に無い商品) | この購入をご利用のプランに結び付けられませんでした。お問い合わせフォームからご連絡ください |
| `AI_DAILY_LIMIT` | 429 | `consume_ai_usage_at` (1 日の上限・機能ごとの上限 (cap > 0)) | 既存の文 (機能ごとの上限は `aiFeatureDailyLimitMessage`。究極モードの文はいまと同じ) |
| `RATE_LIMITED` | 429 | `rateLimitExceededResponse` | 既存の文 |
| `INTERNAL_ERROR` | 500 | `internalError` | 処理中にエラーが発生しました |
| `EXT_REVENUECAT_API_FAILED` [NEW] | 502 | gateway | 購入の確認サービスとの通信に失敗しました。しばらくしてからお試しください |
| `EXT_REVENUECAT_NOT_CONFIGURED` [NEW] | 503 | gateway (鍵なし) | 購入の確認を完了できませんでした。時間をおいてお試しください |
| `EXT_STRIPE_NOT_CONFIGURED` (文の変更) | 503 | 核 | お申し込みを完了できませんでした。時間をおいてお試しください (R3。billing/01 §13.1 の文を置き換える) |

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
| `BILL_UNKNOWN_IAP_STATUS` [NEW] | status | snapshot の status が 5 値の外 (TS の不具合) | 同上 |
| `BILL_LIVE_ROW_CONFLICT` | 既存の live 行の id | 同じ利用者に別の live 行 (S13・S25・PRODUCT_CHANGE の順の崩れ・TRANSFER の先に別の契約) | Webhook `failed` + 監査 `system.revenuecat.event_failed` (warn)。sync は 409。運営の処置は下の表 (利用者は後の購入のストアの契約で使い続けられるようにする) |
| `FAMILY_PLAN_REQUIRED` [NEW] | family_id (トリガー) / なし (`create_family_group`) | 家族プランの契約の無い代表者のグループを作る・メンバーを足す | route が 402 |

二重購読 (`BILL_LIVE_ROW_CONFLICT`) のときの運営の処置 (S13・S25。operator/09 の手順に足す。§16.2):

| 先にある live 行 (DETAIL の行) | 後から来た購入 | 運営の処置 | 根拠 |
|---|---|---|---|
| S 行 (Stripe) | ストア | Stripe の Dashboard で契約をすぐに解約し、その期間の料金を返金する → Stripe の Webhook で S 行が `cancelled` → RevenueCat の Dashboard でイベントを Retry (または利用者がアプリの「プランとお支払い」を開いて同期) → I 行が INSERT | 当社が持つ契約なので当社が解約・返金できる |
| M 行 (手動付与) | ストア | `DELETE /api/super-admin/users/[id]/manual-plan` (付与の取り消し。billing/02) → Retry / 同期 | 手動付与は当社の操作で外せる |
| I 行 (App Store か Google Play) | Google Play | Play Console で後から来た Google Play の注文を返金する (購読はすぐ終わる。P14)。利用者は先の契約で使い続ける | Google Play は開発者が返金できる (P14) |
| I 行 (Google Play) | App Store | Play Console で先の Google Play の最新の注文を返金する → 取り直しで先の行が `cancelled` → Retry / 同期で App Store の行が INSERT | 同上 |
| I 行 (App Store) | App Store (別の Apple ID) | 利用者に、後から買った方の購入の返金を reportaproblem.apple.com から Apple に申し込むよう案内する (固定の案内の文は operator/09)。Apple が返金すると `CANCELLATION` → 取り直しで `refunded_at` → その商品の行は `cancelled` (live でないので衝突しない) | App Store の購入は開発者が返金できない (P14) |
| I 行 (App Store) | Stripe (Web) | Stripe の写像が `BILL_LIVE_ROW_CONFLICT` で止める (billing/01 の既存の扱い)。運営は Stripe の Dashboard で後から来た Stripe の契約を解約・返金する | 当社が持つ契約 |

核の `BILL_UNKNOWN_USER` (billing/01 §13.3) は本冊の写像 `billing_apply_store_subscription` では使わない。`app_user_id` が `auth.users` に無いとき (退会済み) は業務エラーにせず `{ applied: false, skipped: 'user_deleted' }` を返し、Webhook は 200 (§6.4 の 1.・§7.3・テスト 72)。そのため `STORE_RPC_ERROR_CODES` (§8.3) にも入れない。

---

## 14. テスト一覧 (it 名)

### 14.1 単体 (`npm test`。DB も RevenueCat も使わない)

未完成や予定を示す語の見張り (テスト 13・36・40・48・56・96) は、どれも同じ禁止語の一覧をテストの中にリテラルで持つ: `const UNFINISHED_WORDS = ['準備中', '販売開始前', '近日', '予定', 'まだ', '確定次第', 'これから'] as const;` (発注者の指示「「まだできてません」みたいなのは書かないで」。§0.4)。対象の文に 1 つでも含まれたら赤。

`tests/billing-iap-core.test.ts` (`src/lib/billing/iap-core.ts`):
1. `it('iap-core imports only zod (no I/O, no @/lib)')` (ソースの import を走査。`tests/billing-core.test.ts` と同じ形)
2. `it('classifyRevenueCatEvent maps the 21 documented types and treats unknown types as sync')`
3. `it('appUserIdsToSync returns the single uuid for sync events, both sides for TRANSFER, nothing for ignore, and drops anonymous ids')`
4. `it('deriveStoreStatus follows §7.3: refunded → cancelled, no expiry → active, future expiry → past_due / trialing / active, past expiry with a future grace_period_expires_date → past_due, past expiry without grace (null or past) → expired')`
5. `it('projectStoreSubscription builds the snapshot with plan_key and interval from the mapping and cancel_at_period_end from unsubscribe_detected_at')`
6. `it('projectMissingSubscription builds an expired snapshot with expires_date = now')`
7. `it('selectStoreSubscriptions keeps only app_store / play_store entries and orders non-live before live, then by expires_date')`
8. `it('needsLazyResync is true only for store rows past current_period_end whose iap_synced_at is older than 5 minutes')`
9. `it('minimizeRevenueCatEventPayload keeps only the allow-listed fields and drops subscriber_attributes / aliases / price')`
10. `it('buildIapCatalog returns only plans that have products for the store, month before year')`
11. `it('RevenueCatWebhookEnvelopeSchema accepts the documented INITIAL_PURCHASE / RENEWAL / TRANSFER samples and rejects a body without event.id')`
12. `it('RevenueCatCustomerInfoSchema accepts the documented subscriber shape (subscriptions keyed by product id)')`
13. `it('IAP_ERROR_MESSAGES do not contain any UNFINISHED_WORDS (準備中 / 販売開始前 / 近日 / 予定 / まだ / 確定次第 / これから)')` (禁止語の一覧はテストの中にリテラルで書く。§14.1 冒頭)
85. `it('deriveStoreStatus / projectStoreSubscription keep past_due with cancel_at_period_end = true for an unsubscribed billing-issue subscription, and false after uncancellation')` (§7.3 の `past_due` の行。83 以降は網羅性の反映で足した通し番号で、置き場所はファイルごとの組に合わせる)
95. `it('IAP_STORES equals PURCHASE_STORES of @homegohan/shared (billing-plans.ts)')`

`src/__tests__/lib/webhook/verify.test.ts` (追加):
14. `it('verifyRevenueCatSignature returns missing_headers for a null or malformed header and invalid_timestamp for a non-numeric t')`
15. `it('verifyRevenueCatSignature accepts HMAC-SHA256 hex of "<t>.<body>" keyed by the raw secret within WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS and rejects mismatch / stale timestamp')` (期待の署名はテストの中で `crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')` で作る)
16. `it('verifyRevenueCatWebhook throws WebhookSecretMissingError when REVENUECAT_WEBHOOK_SECRET is missing')`

`tests/billing-iap-service.test.ts` (`iap-service.ts`。gateway と repository は偽物):
17. `it('syncStoreSubscriber fetches the subscriber, applies non-live entries before live ones and returns counts')`
18. `it('syncStoreSubscriber throws BILL_IAP_UNKNOWN_PRODUCT when a store subscription has no plan_store_products row')`
19. `it('syncStoreSubscriber ends live store rows that are missing from the subscriber (TRANSFER away) with an expired snapshot')`
20. `it('syncStoreSubscriber reports no_subscription when the subscriber has no app_store / play_store entries and writes nothing')`
21. `it('handleRevenueCatEvent syncs both transferred_from and transferred_to for TRANSFER and ignores TEST')`
22. `it('handleRevenueCatEvent lets BILL_LIVE_ROW_CONFLICT propagate (route records the failure)')`
23. `it('recordRevenueCatEventFailure marks the event failed and audits system.revenuecat.event_failed (audit is fail-open)')`
24. `it('lazyResyncStoreSubscription syncs only when needsLazyResync and swallows failures')`

`tests/webhooks-revenuecat-route.test.ts` (route。署名は本物、ほかは偽物):
25. `it('returns 413 for bodies over 256 KiB, 401 for a bad signature, 400 for malformed JSON or envelope')`
26. `it('returns 503 when REVENUECAT_WEBHOOK_SECRET or REVENUECAT_SECRET_API_KEY is missing')`
27. `it('returns 200 duplicate for completed claims, 409 for in_progress, and 200 synced after handling')`
28. `it('returns 500 and records failure with the BillingRpcError / IapError code when handling throws')`
29. `it('handles SANDBOX events exactly like PRODUCTION events (no environment branch): the sync is called and the response is 200 synced')`
30. `it('maxDuration literal equals REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS')`

`tests/api/billing-iap-routes.test.ts` (catalog・sync・subscription の差分):
31. `it('GET catalog requires a valid store query, returns plans with products for that store and never reads env')` (`reachesAi` で届かないことも見る)
32. `it('POST sync returns the summary after syncing, 409 BILL_IAP_SYNC_CONFLICT on BILL_LIVE_ROW_CONFLICT, 503 when the key is missing')`
33. `it('GET subscription lazily resyncs expired store rows and still returns the summary when RevenueCat is not configured')`

`tests/billing-core.test.ts` (追加):
34. `it('summarizeSubscription marks store rows with source and manage_in_store and never can_cancel / can_resume them')`
35. `it('summarizeSubscription includes features and keeps the stripe / manual behaviour unchanged')`
36. `it('BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED contains none of UNFINISHED_WORDS')`

`tests/billing-plan-catalog.test.ts` (`packages/shared/src/billing-plans.ts` と migration の突き合わせ):
37. `it('PLAN_CATALOG prices and trial days equal the UPDATE statements in the billing_paid_plans_iap migration')`
38. `it('PLAN_AI_DAILY_LIMITS / PLAN_ULTIMATE_DAILY_CAPS / PLAN_MENU_GENERATION_DAILY_CAPS equal the migration seed rows')`
39. `it('planCatalogPriceText renders 3 lines with tax-included prices and the member limits')`
93. `tests/billing-status-lines-parity.test.ts`: `it('subscriptionStatusLines (@homegohan/shared) equals billingStatusLines (core.ts) for the 5 live statuses × cancel_at_period_end × trial_ends_at / cancel_at present or null, including dates near JST midnight')`
94. `tests/billing-summary-wire.test.ts`: `it('summarizeSubscription results are assignable to BillingSummaryWire (type) and parseBillingSummaryWire returns them unchanged for S / M / I / no-row cases, and returns null for a missing features field')`
40. `it('no billing-plans.ts text (PLAN_CATALOG features, FREE_PLAN_FEATURES, FREE_PLAN_AI_LIMIT_NOTE, planCatalogPriceText, status lines) contains any of UNFINISHED_WORDS')`

`tests/ai-daily-limit-core.test.ts` (追加):
41. `it('parseConsumeAiUsageResult reads capped_feature for the 4 plan-capped features, sets planLocked only with plan_locked true and a known feature, and ignores unknown feature names')`
42. `it('aiDailyLimitPayload returns 403 AI_FEATURE_NOT_IN_PLAN { error, code, feature } without Retry-After when planLocked, 429 with aiFeatureDailyLimitMessage when a cap > 0 is reached, and the unchanged ultimate-mode text')`
43. `it('isAiDailyLimitMessage accepts the feature-not-in-plan messages (all 4 features and the fallback) and the feature-limit messages, and aiDailyLimitMessageOfBody reads both 403 and 429 bodies (flat and nested)')`
89. `it('aiDailyLimitMessageOfDenied returns the not-in-plan message for planLocked denials, so the Edge row error_message and the consultation action result carry it, and aiDailyLimitSkippedField returns {} for planLocked')`
97. `tests/consultation-action-usage.test.ts` (追加): `it('dailyLimitResult returns code AI_FEATURE_NOT_IN_PLAN with the not-in-plan message for planLocked denials and AI_DAILY_LIMIT otherwise')`
101. `tests/ai-daily-limit-client.test.tsx` (追加): `it('aiDailyLimitMessageOfResponse returns the not-in-plan message for 403 AI_FEATURE_NOT_IN_PLAN and null for 403 AI_CONSENT_REQUIRED')`
92. `tests/meal-image-skip.test.ts` (追加): `it('mealImageSkipReasonOf returns plan for planLocked denials, ai_limit for other denials and rate_limit for null / allowed; MEAL_IMAGE_SKIPPED_ERRORS.plan is skipped_plan and isMealImagePlanSkippedError matches only it')`
98. `tests/api/meals-plan-locked-image.test.ts` (新設): `it('POST /api/meals, PATCH /api/meals/[id], POST /api/meal-plans/meals and PATCH /api/meal-plans/meals/[id] save the meal with image_error skipped_plan and no aiSkipped when meal_image_auto is plan-locked')` (consumeAiUsage の偽物が planLocked の止めを返す)
99. `src/__tests__/app/menus/weekly/recipe-modal-plan-skipped.test.tsx` (新設): `it('RecipeModal shows the paid-plan wording for skipped_plan and keeps the existing wording for skipped_ai_limit / skipped_rate_limit')`

`tests/public-claims-guard.test.ts` (書き換え。§10.1・§10.2):
44. `it('pricing page shows the three plans with prices, trial and features and no CTA when no Price is registered')`
45. `it('pricing page shows CTA only for purchasable intervals and hides paid cards in native app mode')`
46. `it('legal page shows prices, payment method, timing, provision, cancellation and subscription rows from the catalog, and the business address')`
47. `it('company page shows address, founded, capital, email and hours and no 準備中')`
48. `it('no public page source or render (pricing / legal / company / faq / landing-copy) contains any of UNFINISHED_WORDS')`

`tests/business-info-legal-pages.test.ts` (書き換え): 所在地 = `BUSINESS_ADDRESS`・メールアドレス = `BUSINESS_EMAIL`・営業時間の行。

Web の契約の画面 (追加。§10.3・§10.4):
87. `src/__tests__/app/account/billing-pages.test.ts`: `it('account billing page shows the store contract wording with the store management link and no cancel / resume / portal buttons for app_store and play_store rows')` (S4)
88. `src/__tests__/app/frozen-billing-page.test.tsx`: `it('frozen billing page shows the store management wording and no cancel button for a store row')` (S22)
103. `src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts` (追加。§10.3): `it('locks the ultimate-mode toggle with aria-disabled and the paid-plan wording when features.ai_feature_caps.menu_generation_ultimate is 0, and leaves it operable when the summary is null or the cap is above 0')` (`useBillingSummary` を `vi.mock` で差し替える) (S17)

家族・AI の route:
49. `tests/api/family-plan-required.test.ts`: `it('family routes map FAMILY_PLAN_REQUIRED from the RPC to 402 with the fixed message')`
50. `src/__tests__/lib/plan/entitlements.test.ts` (追加): `it('consumeAiUsage passes through plan_locked denials unchanged (403 is decided by aiDailyLimitPayload)')`

モバイル (`apps/mobile`、jest):
51. `__tests__/lib/iap-catalog.test.ts`: `it('matchCatalogWithPackages keeps only products present in both the catalog and the offerings, and renewalText states trial and renewal')`
52. `__tests__/lib/purchases.test.ts`: `it('identifyPurchases configures once with the user id, logs in on user change, and resetPurchasesOnSignOut logs out only when not anonymous; without keys it does nothing')`
53. `__tests__/settings/plan-entry.test.tsx`: `it('settings tab has the プランとお支払い row that opens /settings/plan')`
54. `__tests__/settings/plan-screen.test.tsx`: `it('plan screen shows the current plan from the summary, hides purchase cards when a live contract exists, shows Web / store wording by source, and always shows 購入を復元 and the legal links')`
55. 同: `it('plan screen purchases a package, then syncs and shows the updated summary; cancelled purchases show nothing')`
56. 同: `it('plan screen shows no plan cards when the catalog is empty or purchases are unavailable, and no rendered text contains any of UNFINISHED_WORDS')`
57. `__tests__/menus-weekly/ultimate-mode-toggle.test.tsx` (追加): `it('locked toggle does not switch on and announces the plan requirement')`
58. `__tests__/app/no-web-purchase-links.test.ts`: 変更なし (緑のまま)
59. `__tests__/lib/sign-out.test.ts` (追加): `it('sign-out paths call resetPurchasesOnSignOut before clearing user-scoped data')`
96. `__tests__/lib/billing-api.test.ts` (新設): `it('fetchBillingSummary / syncIapPurchases parse the data with parseBillingSummaryWire and throw BillingSummaryShapeError on a bad shape; fetchIapCatalog drops malformed plans; billingErrorMessageOf returns the server fixed text for the 4 IAP codes, the generic text for other HTTP errors, and none of UNFINISHED_WORDS appears')`
102. `__tests__/lib/ai-daily-limit.test.ts` (追加): `it('aiDailyLimitErrorOf turns HTTP 403 AI_FEATURE_NOT_IN_PLAN into AiDailyLimitError with the not-in-plan message and leaves 403 LEGAL_CONSENT_REQUIRED alone')`

### 14.2 契約・結合 (ローカル Supabase。`tests/integration/rls` と `security` に置く)

`tests/billing-paid-plans-migration-contract.test.ts` (SQL の文面):
60. `it('migration updates exactly the 3 plan rows with the decided prices, trial days and display names, and touches no stripe_* column')`
61. `it('migration creates plan_store_products / revenuecat_webhook_events / ai_plan_feature_caps with RLS and the documented grants')`
62. `it('billing_apply_store_subscription, claim / finish, billing_has_live_family_plan and the family gate trigger are SECURITY DEFINER with empty search_path and EXECUTE only for service_role')`
63. `it('manual-grant functions select M rows with stripe_subscription_id IS NULL AND iap_store IS NULL')`
64. `it('rollback restores create_family_group, the manual-grant functions and the AI functions verbatim from their source migrations and drops everything the migration added')`
65. `it('no UPDATE / DELETE outside function bodies except the 3 plan rows and the free ai_daily_limits row')`
100. `it('the ai_plan_feature_caps feature CHECK lists exactly AI_PLAN_CAPPED_FEATURES and consume_ai_usage_at checks ai_plan_feature_caps before the c_unmetered branch')`

`tests/integration/rls/billing-apply-store-subscription-rpc.test.ts`:
66. `it('inserts a trialing store row, syncs plan_key_cached and the family group, and audits subscription_created')`
67. `it('is monotonic by p_fetched_at (older fetch is stale) and idempotent for the same snapshot')`
68. `it('raises BILL_LIVE_ROW_CONFLICT when a Stripe or manual live row exists, and the Stripe mapping raises the same when a store row is live')`
69. `it('transitions active → expired on a past expires_date and clears plan_key_cached and the family plan')`
70. `it('reuses the same (user, store, product) row on repurchase and keeps trial_started_at')`
71. `it('applies PRODUCT_CHANGE in order: month row expired first, then the yearly row inserted')`
72. `it('returns user_deleted without writing for a missing auth user')`
90. `it('writes iap_is_sandbox from the snapshot (true for sandbox, false otherwise) and records is_sandbox in the audit details, with the same status and plan_key_cached as a production purchase')` (S24)
83. `it('writes trial_started_at / trial_ends_at / trial_source = store on a trialing store row and keeps them after the row expires')` (S23)
84. `it('Web repository hasUsedTrial counts a store trial row for the same plan_key and not for another plan_key')` (S23。`createBillingRepository` の既存の `hasUsedTrial` をローカル Supabase で呼ぶ)
86. `it('applies PRODUCT_CHANGE from a trialing month row: month row expired with trial_started_at kept, then the yearly row inserted with the status from its own period_type')` (§7.3 の `trialing` (月額) の行)

`tests/integration/rls/billing-revenuecat-events-claim-rpc.test.ts`:
73. `it('claim returns claimed / completed / in_progress and lets failed and stale processing rows be reclaimed')`

`tests/integration/rls/ai-plan-feature-caps-rpc.test.ts`:
74. `it('consume_ai_usage denies with plan_locked for a 0 cap, with capped_feature for a reached cap, and counts normally otherwise')`
75. `it('consume_ai_usage_capped uses the plan row when present and the env cap otherwise')`
76. `it('family plan members inherit the family plan limits via get_effective_plan')`
91. `it('meal_image_auto is denied with plan_locked for free before the unmetered branch (no counter row), while a paid plan without a row still uses the ai_unmetered_daily_caps safety cap')`

`tests/integration/security/family-plan-gate.test.ts`:
77. `it('create_family_group raises FAMILY_PLAN_REQUIRED without a live family plan and succeeds with a manual family grant')`
78. `it('family_members insert (invite accept, child add) raises FAMILY_PLAN_REQUIRED when the group is free and succeeds when the representative has a family plan')`
79. `it('existing members stay when the plan expires; new members are refused')`

`tests/integration/security/plan-store-products-rls.test.ts`:
80. `it('anon and authenticated can read public plan products, only super_admin can write, service_role can write')`

`tests/integration/security/account-export-scope.test.ts` (延長): `iap_synced_at` を出力しない列に。

### 14.3 E2E (手動。`tests/e2e/.manual/`。CI では流さない)

81. `tests/e2e/.manual/iap-webhook.spec.ts`: 本番の受け口 (RevenueCat に登録した 1 つの Webhook) へ RevenueCat の Dashboard の Test event (`TEST` → 200 `ignored`) と、TestFlight の sandbox の購入のイベントを送り、`personal_subscriptions` (`iap_is_sandbox = true`) と `revenuecat_webhook_events` を読み取りで確かめる (§17.4)。
82. 実機 (整合ゲート): §17.4。

### 14.4 シナリオ ⇄ テスト (§3.2 の 25 本がどのテストで守られるか)

| シナリオ | テスト (番号は §14.1〜§14.3) |
|---|---|
| S1 iOS の新規購入 (無料体験) | 17・32・51・54・55・66・83・82 (実機) |
| S2 Android の年額 (家族 Basic) | 17・66・77・82 (実機) |
| S3 Web で買った人がアプリを開く | 35・54・93・94 |
| S4 アプリで買った人が Web を開く | 34・68・87 |
| S5 ストアでの解約の予約 → 期限切れ | 5・69 |
| S6 更新 | 4・67 |
| S7 支払いの問題 (猶予 → 期限切れ) | 4・69・85 |
| S8 返金 | 4 |
| S9 購入の復元 | 32・54 |
| S10 別の利用者が復元 (TRANSFER) | 3・19・21 |
| S11 順序の入れ替わり・重複・再送 | 27・67・73 |
| S12 Webhook が届かない | 8・24・33 |
| S13 二重購読の防止と案内 (Web とストア) | 22・28・32・68・96 |
| S14 鍵が無い | 16・26・31・32 |
| S15 ストアの商品が未登録 | 10・18・56 |
| S16 Stripe の Price が無い間の料金ページ | 44・46 |
| S17 無料の利用者の線引き | 41・42・49・57・74・77・89・91・92・97・98・99・101・102・103 |
| S18 有料の利用者の線引き | 74・75・76 |
| S19 家族プランが終わったグループ | 69・78・79 |
| S20 手動付与との共存 | 63・68・77 |
| S21 規約の改定の再同意 | §16.1 の `middleware-legal-consent-api` の行 (許可リストは変えないので既存のテストが緑のまま守る) |
| S22 凍結中のストアの契約 | 88 |
| S23 無料体験の 1 人 1 回 | 70・83・84・86 |
| S24 App Store の審査 (sandbox の購入) | 29・90・81 (手動)・82 (実機) |
| S25 二重購読の防止と案内 (ストア同士) | 68・32・96 |

---

## 15. 段分け・触るファイルの母集合・新設一覧

### 15.1 段分け (1 つの B 型 WF の中で段ごとに 2 枚レビュー。段 A・段 C・段 E はそれぞれ単独でマージしてよい)

| 段 | 内容 | ファイル | テスト |
|---|---|---|---|
| A: DB 層 | migration + rollback (§6)、`database.types.ts` の再生成 (2 本)、SQL の契約テスト、結合テスト、本人の書き出しの `omit`、家族の結合テストの前提 (家族プランの手動付与) | §6・`src/types/database.types.ts`・`packages/shared/src/database.types.ts`・`src/lib/account-export-tables.ts`・§16.1 の結合テストの追随 | 60〜80・83・84・86・90・91・100 |
| B: サーバ層 | `iap-core.ts`・`revenuecat-gateway.ts`・`iap-repository.ts`・`iap-service.ts`・`http.ts` の差分・`core.ts` の差分・`repository.ts` の差分 (`SUBSCRIPTION_VIEW_COLUMNS`・`findPlanFeatures`・`BillingRpcError` の code)・`service.ts` の差分・`public-plans.ts` (`listPublicPlans`)・`packages/shared/src/billing-plans.ts` と `index.ts` の 1 行・`verify.ts`・`env.ts`・`.env.example`・`ENV_SETUP.md`・route 3 本・`subscription/route.ts` の差分・family の route 4 本の 402・`membership-errors.ts`・`_shared/ai-daily-limit.ts` (全文) と Web の `daily-limit-client.ts`・モバイルの `aiDailyLimitErrorOf`・`consultation-action-executor.ts` (`dailyLimitResult` の code と見送りの理由)・`_shared/meal-image.ts` と `lib/meal-image.ts` の再 export・料理の保存の 4 本の route の見送りの理由・`RecipeModal.tsx` の文・`maintenance-mode.ts`・middleware の Webhook の除外・`EXEMPT_ROUTES`・`null-character-routes` の表 | §8・§9 | 1〜43, 49, 50, 85, 89, 92〜95, 97〜99, 101, 102。81 (手動の E2E。段 B のマージ後、§17.4 の整合ゲートで流す) |
| C: Web の画面と公開の面 | `/pricing`・`/legal`・`/company`・`/faq`・`landing-copy.ts`・`business-info.ts`・`/account/billing`・`/frozen/billing`・退会の文・究極モードの錠 (`V4GenerateModal`・`useBillingSummary`)・`public-claims-guard`・`business-info-legal-pages`・`b10` の E2E | §10.1〜§10.5 | 44〜48, 87, 88, 103 |
| D: モバイル | `react-native-purchases`・`expo-dev-client` の追加、`purchases.ts`・`iap-catalog.ts`・`billing-api.ts`・`plan-screen.ts`・`app/settings/plan.tsx`・設定タブの行・`AuthProvider`・`signOut.ts`・`UltimateModeToggle` と `V4GenerateModal` の錠・`env.example`・jest の mock と `moduleNameMapper`・`no-web-purchase-links.test.ts` のコメント | §8.10・§10.6 | 51〜59, 96 |
| E: 規約とポリシーの条文 | `/terms`・`/privacy` の条・`legal-versions.ts` の版 | §11 | §16.1 の規約の行 |

段 B は段 A のマージ後 (型の再生成済み)。段 C と段 D は段 B のマージ後 (段 C と段 D は並行できる)。段 E は #1901 のマージ後 (本冊のほかの段とは独立)。30 ファイルを超えるので段ごとにレビューを挟む。

- 段 A の本番の適用から段 B のマージまでの間は、DB が新しい `capped_feature` (`menu_generation`・`image_generation`・`meal_image_auto`) と `plan_locked` を返すが、古い `parseConsumeAiUsageResult` はそれを読まない。この間も門 (止めること) は効き、止めたときの文が 1 日の上限の文 (回数は機能の上限の値) になり、無料の料理の保存では `skipped_ai_limit` と `aiSkipped` が付く。利用者はゼロなので受け入れ、段 B は段 A の直後にマージする。段 B の `supabase/functions/_shared/**` の変更は、main へのマージで Edge Function のデプロイ (`.github/workflows/deploy-supabase-functions.yml` の `paths: supabase/functions/**`) が走って Edge の文も新しくなる。

### 15.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking。例外は §16.1 冒頭の「母集合の作り方」で新たに出た、同じ型の行がそのまま当てはまるファイルだけ)

新設:
- `supabase/migrations/<番号>_billing_paid_plans_iap.sql`・`supabase/rollbacks/<番号>_billing_paid_plans_iap.down.sql`
- `src/lib/billing/iap-core.ts`・`revenuecat-gateway.ts`・`iap-repository.ts`・`iap-service.ts`
- `packages/shared/src/billing-plans.ts`
- `src/app/api/webhooks/revenuecat/route.ts`・`src/app/api/billing/iap/catalog/route.ts`・`src/app/api/billing/iap/sync/route.ts`
- `src/hooks/useBillingSummary.ts`
- テストの道具: `tests/integration/helpers/family-plan.ts` (`grantFamilyPlan`。§16.1 の家族の結合テストの行)・`tests/e2e/helpers/billing-plan.ts` (`grantManualPlanForE2e`。§16.1 の E2E の行)
- `apps/mobile/src/lib/purchases.ts`・`iap-catalog.ts`・`billing-api.ts`・`plan-screen.ts`・`apps/mobile/app/settings/plan.tsx`・`apps/mobile/__mocks__/react-native-purchases.js`
- テスト: `tests/billing-iap-core.test.ts`・`tests/billing-iap-service.test.ts`・`tests/webhooks-revenuecat-route.test.ts`・`tests/api/billing-iap-routes.test.ts`・`tests/billing-plan-catalog.test.ts`・`tests/api/family-plan-required.test.ts`・`tests/billing-paid-plans-migration-contract.test.ts`・`tests/integration/rls/billing-apply-store-subscription-rpc.test.ts`・`tests/integration/rls/billing-revenuecat-events-claim-rpc.test.ts`・`tests/integration/rls/ai-plan-feature-caps-rpc.test.ts`・`tests/integration/security/family-plan-gate.test.ts`・`tests/integration/security/plan-store-products-rls.test.ts`・`tests/e2e/.manual/iap-webhook.spec.ts`・`apps/mobile/__tests__/lib/iap-catalog.test.ts`・`purchases.test.ts`・`billing-api.test.ts`・`apps/mobile/__tests__/settings/plan-entry.test.tsx`・`plan-screen.test.tsx`・`tests/billing-status-lines-parity.test.ts`・`tests/billing-summary-wire.test.ts`・`tests/api/meals-plan-locked-image.test.ts`・`src/__tests__/app/menus/weekly/recipe-modal-plan-skipped.test.tsx`

変更:
- `src/lib/billing/core.ts`・`repository.ts`・`service.ts`・`http.ts`・`public-plans.ts`・`manual-grant.ts`・`manual-grant-repository.ts`・`src/components/admin/ManualPlanGrantSection.tsx`
- `src/lib/webhook/verify.ts`・`src/__tests__/lib/webhook/verify.test.ts`
- `src/lib/env.ts`・`.env.example`・`ENV_SETUP.md`・`apps/mobile/env.example`
- `src/app/api/billing/subscription/route.ts`
- `src/app/api/family/groups/route.ts`・`invites/[id]/accept/route.ts`・`members/child/route.ts`・`promotions/[token]/accept/route.ts`・`src/lib/errors/membership-errors.ts`
- `supabase/functions/_shared/ai-daily-limit.ts`・`src/lib/ai/daily-limit-client.ts`・`apps/mobile/src/lib/ai-daily-limit.ts`・`src/lib/ai/consultation-action-executor.ts` (`dailyLimitResult` の code と、料理画像の見送りの理由の 1 行)
- `supabase/functions/_shared/meal-image.ts`・`lib/meal-image.ts` (再 export の名前)・`src/app/api/meals/route.ts`・`src/app/api/meals/[id]/route.ts`・`src/app/api/meal-plans/meals/route.ts`・`src/app/api/meal-plans/meals/[id]/route.ts` (見送りの理由の 1 行と import)・`src/app/(main)/menus/weekly/_components/modals/RecipeModal.tsx` (文)
- `packages/shared/src/index.ts` (`export * from './billing-plans';` の 1 行)
- `src/lib/maintenance-mode.ts`・`src/__tests__/lib/maintenance-mode.test.ts`・`lib/supabase/middleware.ts` (Webhook の除外)・`lib/supabase/__tests__/middleware*.test.ts` のうち Webhook の除外を固定するもの
- `tests/helpers/ai-consent-enforced-paths.ts` (`EXEMPT_ROUTES` に 3 行)・`src/__tests__/api/null-character-routes.test.ts` (`EXCLUDED` に 1 行)
- `src/app/pricing/page.tsx`・`PricingPageView.tsx`・`src/app/legal/page.tsx`・`src/app/company/page.tsx`・`src/app/faq/page.tsx`・`src/components/marketing/landing-copy.ts`・`src/lib/business-info.ts`・`src/lib/seo/public-pages.ts` (description に「準備中」があれば)
- `src/app/(main)/account/billing/page.tsx`・`src/app/frozen/billing/page.tsx`・`src/app/(main)/settings/page.tsx` (退会の文)・`src/app/frozen/account/page.tsx` (退会の文)・`src/components/ai-assistant/V4GenerateModal.tsx`
- `tests/public-claims-guard.test.ts`・`tests/business-info-legal-pages.test.ts`・`tests/e2e/b10-unexplored-areas.spec.ts`・`src/__tests__/app/account/billing-pages.test.ts`・`src/__tests__/app/frozen-billing-page.test.tsx`・`tests/billing-core.test.ts`・`tests/billing-service.test.ts`・`tests/api/billing-routes.test.ts`・`tests/billing-manual-grant*.test.ts`・`tests/ai-daily-limit-core.test.ts`・`tests/ai-daily-limit-client.test.tsx`・`tests/consultation-action-usage.test.ts`・`tests/meal-image-skip.test.ts`・`tests/billing-public-plans.test.ts` (`listPurchasablePlans` → `listPublicPlans`)・`src/__tests__/lib/plan/entitlements.test.ts`・`tests/ai-usage-contract.test.ts` (突き合わせの対象が増える分だけ)・`apps/mobile/__tests__/lib/ai-daily-limit.test.ts`
- `src/lib/account-export-tables.ts`・`tests/account-export-tables.test.ts`・`tests/integration/security/account-export-scope.test.ts`
- `src/types/database.types.ts`・`packages/shared/src/database.types.ts` (再生成)
- 家族の結合テスト (§16.1 の行。家族プランの手動付与を前提に足す)
- `apps/mobile/package.json`・`apps/mobile/jest.config.js`・`apps/mobile/app/(tabs)/settings.tsx`・`apps/mobile/src/providers/AuthProvider.tsx`・`apps/mobile/src/lib/signOut.ts`・`apps/mobile/src/components/menu/UltimateModeToggle.tsx`・`V4GenerateModal.tsx`・`apps/mobile/__tests__/app/no-web-purchase-links.test.ts` (コメントだけ)・`apps/mobile/__tests__/menus-weekly/ultimate-mode-toggle.test.tsx`・`apps/mobile/__tests__/lib/sign-out.test.ts`
- `src/app/terms/page.tsx`・`src/app/privacy/page.tsx`・`packages/shared/src/legal-versions.ts` (段 E)
- `src/app/super-admin/coupons/new/page.tsx` (粗利のプレビューの基準の価格。§16.1 の行)
- `src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts` (テスト 103 と冒頭の経緯のコメント)・`tests/integration/operator/super-admin-llm.test.ts`・`tests/integration/rls/coupon-apply-rpc.test.ts` (it 名とコメントだけ)
- E2E: `tests/e2e/fixtures/fresh-family.ts`・`tests/e2e/helpers/membership-family.ts`・`tests/e2e/bug-27-ultimate-mode-locked.spec.ts`・`tests/e2e/w5-3-menu-gen-adversarial.spec.ts` と、§16.1 の E2E の行の母集合 (母集合の作り方 7) で同じ直し方が当てはまる spec
- docs: `docs/design/billing/03-paid-plans-and-iap.md` (本書)。他の文書は §16.2 の行だけ (専権 PATCH)

触らない (凍結): `supabase/functions/stripe-price-sync/**`・`src/app/api/super-admin/plans/**` (`price-change`・`price-impact`・`[id]`・一覧。§7.1 の書き手の表)・`src/app/api/super-admin/llm/quotas/route.ts`・`src/app/api/health/route.ts`・`src/lib/super-admin/plan-subscribers.ts`・`src/lib/membership/exit-notification.ts`・既存の `supabase/migrations/**` と `supabase/rollbacks/**` (§16.1 の母集合の作り方 2 が当てても書き換えない)・#1911 の面 (§0.2 の対象外の欄のファイル)・`supabase/baseline/**`・`billing_apply_stripe_subscription`・`get_effective_plan`・`guard_user_profiles_privileged(_on_insert)`・`family_groups` の DDL とトリガー・`stripe_webhook_events`・`billing_customers`・Stripe の route 7 本と Webhook・`src/lib/billing/stripe-gateway.ts`・`account-deletion.ts`。

### 15.3 新設一覧 (識別子)

| 種別 | 名前 |
|---|---|
| テーブル | `public.plan_store_products`・`public.revenuecat_webhook_events`・`public.ai_plan_feature_caps` |
| 列 | `personal_subscriptions.iap_store` / `.iap_product_id` / `.iap_synced_at` / `.iap_is_sandbox` |
| 制約・索引 | `plan_store_products_pkey`・`plan_store_products_store_check`・`plan_store_products_interval_check`・`plan_store_products_product_id_not_blank`・`idx_plan_store_products_store_product`・`personal_subscriptions_iap_store_check`・`personal_subscriptions_iap_pair_check`・`idx_personal_subscriptions_iap_product`・`revenuecat_webhook_events_status_check`・`ai_plan_feature_caps_pkey`・`ai_plan_feature_caps_feature_check`・`ai_plan_feature_caps_daily_cap_nonneg` |
| RLS ポリシー | `plan_store_products_select_public`・`plan_store_products_mutate_super_admin`・`revenuecat_webhook_events_no_access` |
| トリガー | `plan_store_products_set_updated_at`・`family_members_billing_plan_gate` |
| DB 関数 | `billing_claim_revenuecat_event(text, text, jsonb, interval)`・`billing_finish_revenuecat_event(text, boolean, text)`・`billing_apply_store_subscription(jsonb, timestamptz, text)`・`billing_has_live_family_plan(uuid)`・トリガー関数 `family_members_billing_plan_gate()` |
| 既存の関数の置き換え | `consume_ai_usage_at`・`consume_ai_usage_capped_at` (§6.5)・`create_family_group` (§6.6)・`billing_revoke_manual_subscription`・`billing_expire_manual_subscription_for_user`・`billing_manual_subscription_sync_after_end` (§6.7) |
| DB の戻り値の項目 | `consume_ai_usage*` の `plan_locked` |
| DB の業務エラー | `BILL_UNKNOWN_IAP_STATUS`・`FAMILY_PLAN_REQUIRED` |
| 監査 action_type | `system.revenuecat.event_failed` (`target_type` の値 `revenuecat_event`)。写像は核の `system.billing.subscription_created` / `subscription_status_changed` を使う |
| route | `POST /api/webhooks/revenuecat`・`GET /api/billing/iap/catalog`・`POST /api/billing/iap/sync` |
| ページ (Web) | 無し (既存の変更だけ) |
| ページ (モバイル) | `/settings/plan` (`apps/mobile/app/settings/plan.tsx`) |
| 料理画像の見送りの値 | `MealImageSkipReason` の `'plan'`・`image_error` の値 `'skipped_plan'` |
| TS モジュール | `src/lib/billing/{iap-core,revenuecat-gateway,iap-repository,iap-service}.ts`・`packages/shared/src/billing-plans.ts`・`src/hooks/useBillingSummary.ts`・`apps/mobile/src/lib/{purchases,iap-catalog,billing-api,plan-screen}.ts` |
| TS の export (iap-core) | §8.1 の `export` のとおり (数は §8.1 が正。ストアの表示名と管理のページは `billing-plans.ts`) |
| TS の export (ほか) | `verify.ts`: `verifyRevenueCatSignature`・`verifyRevenueCatWebhook` / `core.ts`: `PublicPlan`・`PlanFeatures`・`EMPTY_PLAN_FEATURES` / `public-plans.ts`: `listPublicPlans` (`listPurchasablePlans` を置き換え) / `http.ts`: `iapErrorResponse` / `iap-service.ts`: `IapDeps`・`syncStoreSubscriber`・`handleRevenueCatEvent`・`recordRevenueCatEventFailure`・`lazyResyncStoreSubscription`・`RevenueCatEventOutcome` / `revenuecat-gateway.ts`: `createRevenueCatGateway` / `iap-repository.ts`: `createIapRepository` / `packages/shared/src/billing-plans.ts`: `PURCHASE_STORES`・`PurchaseStore`・`isPurchaseStore`・`IAP_STORE_LABELS`・`STORE_SUBSCRIPTION_MANAGEMENT_URL`・`PAID_PLAN_KEYS`・`PaidPlanKey`・`PlanCatalogEntry`・`PLAN_AI_DAILY_LIMITS`・`PLAN_ULTIMATE_DAILY_CAPS`・`PLAN_MENU_GENERATION_DAILY_CAPS`・`FAMILY_PLAN_MAX_MEMBERS`・`PLAN_CATALOG`・`FREE_PLAN_FEATURES`・`FREE_PLAN_AI_LIMIT_NOTE`・`formatJpy`・`planCatalogPriceText`・`FREE_PLAN_DISPLAY_NAME`・`planDisplayName`・`SUBSCRIPTION_STATUSES_WIRE`・`SubscriptionStatusWire`・`BILLING_SOURCES_WIRE`・`BillingSourceWire`・`BILLING_INTERVALS_WIRE`・`BillingIntervalWire`・`PlanFeaturesWire`・`BillingSummaryWire`・`parseBillingSummaryWire`・`SUBSCRIPTION_STATUS_TEXT_WIRE`・`CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE`・`formatBillingDateWire`・`subscriptionStatusLines` / `ai-daily-limit.ts` (新しい名前): `AI_FEATURE_NOT_IN_PLAN_CODE`・`AI_FEATURE_NOT_IN_PLAN_STATUS`・`AI_PLAN_CAPPED_FEATURES`・`AiPlanCappedFeature`・`AI_PLAN_CAPPED_FEATURE_LABELS`・`aiFeatureDailyLimitMessage`・`aiFeatureNotInPlanMessage`・`AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE`・`AiFeatureNotInPlanBody`・`AiUsageDeniedBody`・`AiUsageDenialReason` / `_shared/meal-image.ts`: `mealImageSkipReasonOf`・`isMealImagePlanSkippedError` / `business-info.ts`: `BUSINESS_ADDRESS`・`BUSINESS_FOUNDED`・`BUSINESS_CAPITAL`・`BUSINESS_EMAIL`・`BUSINESS_HOURS` / `membership-errors.ts`: `MembershipErrorCode.FAMILY_PLAN_REQUIRED` / `src/hooks/useBillingSummary.ts`: `BILLING_SUBSCRIPTION_API_PATH`・`useBillingSummary` / モバイル `purchases.ts`: `isPurchasesAvailable`・`identifyPurchases`・`resetPurchasesOnSignOut`・`fetchOfferings`・`purchase`・`restore`・`currentCustomerInfo`・`PurchaseOutcome` / `iap-catalog.ts`: `CatalogPlanLike`・`PackageLike`・`PurchasablePlanCard`・`matchCatalogWithPackages`・`renewalText`・`parseIapCatalogPlans` / `billing-api.ts`: `BILLING_SUBSCRIPTION_API_PATH`・`IAP_CATALOG_API_PATH`・`IAP_SYNC_API_PATH`・`BILLING_SUMMARY_LOAD_FAILED_MESSAGE`・`BILLING_PURCHASE_FAILED_MESSAGE`・`BillingSummaryShapeError`・`fetchBillingSummary`・`fetchIapCatalog`・`syncIapPurchases`・`billingErrorMessageOf` / `plan-screen.ts`: `PLAN_SCREEN_PATH` |
| 環境変数 | `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET` (Web。一覧に追加)・`EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY` (モバイル) |
| エラーコード | §13.1 の [NEW] 7 つ |
| 依存 (モバイル) | `react-native-purchases` 10.14.0・`expo-dev-client` |
| 画面の定数 | `PLAN_SCREEN_PATH = "/settings/plan"` |
| テストの道具 | `tests/integration/helpers/family-plan.ts` の `grantFamilyPlan`・`tests/e2e/helpers/billing-plan.ts` の `grantManualPlanForE2e` |
| 運営の画面の定数 | `src/app/super-admin/coupons/new/page.tsx` の `COUPON_PREVIEW_PLAN_KEY` (粗利のプレビューの基準のプラン) |

---

## 16. 追随表

### 16.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語 = 本冊が足す・変える名前。段 = §15.1。

**母集合の作り方** (実装の各段の最初に origin/main で流し直す。表に無いファイルが出たら、同じ型の行の「直し方」がそのまま当てはまるときに限り直してよい。当てはまらなければ報告する):
1. 本冊の新しい route・ページが AI の印に届くか: `tests/helpers/ai-reach.ts` の `reachesAi` を当てる (`@/lib/env` を import するもの = `revenuecat-gateway.ts`・`verify.ts` を import する route)。
2. 本冊が変える表への書き込み: `git grep -n -E "from\(['\"](personal_subscriptions|family_members|ai_daily_limits|subscription_plans)['\"]\)" origin/main -- tests src` と `git grep -n -i -E "insert into (public\.)?(family_members|personal_subscriptions)" origin/main -- tests supabase`。
3. 本冊が変える既存の関数・型・定数を名指しするテスト: `git grep -n -E "summarizeSubscription|SUBSCRIPTION_VIEW_COLUMNS|BillingSummary|BILLING_ERROR_MESSAGES|EXT_STRIPE_NOT_CONFIGURED|create_family_group|consume_ai_usage_capped|AI_DAILY_CAPPED_FEATURES|AI_CAPPED_FEATURES|parseConsumeAiUsageResult|aiDailyLimitPayload|aiDailyLimitMessageOfDenied|aiDailyLimitSkippedField|AiDailyLimitBody|MEAL_IMAGE_SKIPPED_ERRORS|MealImageSkipReason|LEGAL_DOCUMENTS|BUSINESS_REPRESENTATIVE|DISCLOSED_ON_REQUEST|listPurchasablePlans|PAID_PLAN_PENDING" origin/main -- tests src/__tests__ lib/supabase/__tests__ apps/mobile/__tests__ packages/shared/src`。
4. 公開の面の文を名指しするもの: `git grep -n -E "準備中|販売開始前|¥980|980円|9,800円|資本金" origin/main -- src apps packages tests ':!**/node_modules/**'`。
5. 表の列の一覧を持つ偽の client: `git grep -n -E "SCHEMA_COLUMNS|KNOWN_COLUMNS|ALLOWED_COLUMNS" origin/main -- tests src`。
6. docs の番兵: `git grep -n -E "docs/design/billing|BILLING_AUDIT_ACTIONS|REMOVED_MOBILE_SCREENS" origin/main -- tests`。
7. E2E (本物のサーバに届く通信。上の 2 の `from(...)` は REST の直接の通信に当たらない): `git grep -l -E "rest/v1/family_(groups|members)|api/family/groups|api/ai/menu/weekly/request|api/ai/menu/v4/generate|api/ai/image/generate|ultimate-mode-toggle" origin/main -- tests/e2e`。当たった spec のうち、その API を `page.route` で差し替えていないものが対象 (差し替えていれば本冊の判定に届かない)。

| 番兵 | 反応する理由 (grep の語) | 直し方 | 段 |
|---|---|---|---|
| `tests/env-source-scan.test.ts` | `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET` を `getOptionalEnv` で読む・`.env.example` との突き合わせ・`ENV_SETUP.md` の節の番号 | `SERVER_ENV_VARS` に 2 つ (§8.7)、`.env.example` に 2 行、`ENV_SETUP.md` の `4.` の Stripe の節に RevenueCat の 2 つを足す (番号は増やさない) | B |
| `tests/check-env-script.test.ts` | 一覧の読み込み | 変更なし | B |
| `tests/database-types-migrations-contract.test.ts` | `plan_store_products`・`revenuecat_webhook_events`・`ai_plan_feature_caps`・`billing_apply_store_subscription`・`billing_claim_revenuecat_event`・`billing_finish_revenuecat_event`・`billing_has_live_family_plan` | 両方の `database.types.ts` を再生成する (270k / 256 で) | A |
| `supabase/baseline/**`・`tests/helpers/schema-snapshot.ts`・`scripts/supabase-local.sh` | 本冊の表・列・関数 | 変更なし (凍結。migration が上に積まれる) | A |
| `tests/schema-checked-supabase.test.ts` / `tests/schema-checked-db.test.ts` | `.from('plan_store_products')`・`.from('revenuecat_webhook_events')`・`.from('ai_plan_feature_caps')` | 型の再生成で緑 | A → B |
| `tests/billing-migration-contract.test.ts` (核の migration の文面) | 本冊の migration は別ファイル | 変更なし (`*_billing_core.sql` だけを見る) | — |
| `tests/billing-manual-plan-grant-migration-contract.test.ts` (02 の migration の文面。M 行の述語 `stripe_subscription_id IS NULL` を見るなら) | §6.7 の置き換え | 02 の migration は触らない (緑のまま)。本冊の migration の中の 3 関数の定義は、本冊の契約テスト 63 が `stripe_subscription_id IS NULL AND s.iap_store IS NULL` を見る | A |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` | `cron.schedule` | 変更なし (本冊に cron は無い) | — |
| `tests/integration/security/anon-definer-execute.test.ts` (A1: 許可リストに無い SECURITY DEFINER 関数に anon の EXECUTE が無い) | 新しい SECURITY DEFINER 関数 5 本 | 変更なし (どれも `REVOKE … FROM PUBLIC, anon, authenticated`) | — |
| `tests/integration/security/auth-users-fk-on-delete.test.ts` | `ai_plan_feature_caps.updated_by` (SET NULL) | D の `EXPECTED_ACTIONS` に 1 行 | A |
| `tests/account-export-tables.test.ts` / `src/lib/account-export-tables.ts` | `personal_subscriptions` の新しい列 (`iap_synced_at` は `SENSITIVE_NAME` に当たらないが内部の時刻)。新設の 3 表 | `omit` に `iap_synced_at` を足す (`iap_store`・`iap_product_id` は書き出す)。`ACCOUNT_EXPORT_EXCLUDED` に `revenuecat_webhook_events` (利用者を指す列は無いが、`requiredTables` が `user_id` の有無で求めるなら不要。実装時に `:275` の判定で確かめる) と、`ai_plan_feature_caps` / `plan_store_products` (利用者の列を持たないので分類の対象外。同じ判定で確かめる) | A |
| `tests/integration/security/account-export-scope.test.ts` | 「出力しない列」の一覧 | `iap_synced_at` を足す | A |
| `tests/integration/rls/ai-usage-rpc.test.ts`・`ai-daily-limit-rpc.test.ts`・`ai-usage-feature-cap-rpc.test.ts` (free = 10 を前提に回数を回す・究極モードの env cap を前提にする) | `ai_daily_limits.free` が 5 に・`ai_plan_feature_caps` の free の行 (究極 0・献立 2・画像 0) | 回数の期待を 5 に合わせる (ハードコードの実数は更新。緩めない)。究極モードの既存の it は、利用者を `pro` の手動付与にして行の値 (2) で見るか、`ai_plan_feature_caps` の行を消して env の既定 (1) で見るかを it ごとに選ぶ。`menu_generation` を 3 回以上数える it は、free では 2 回で止まるので `pro` にする。`meal_image_auto` の安全弁 (`ai_unmetered_daily_caps`) を回す it は、free では `plan_locked` で 1 回目から止まるので利用者を `pro` の手動付与にする (安全弁の期待値は変えない)。`image_generation` を数える it も同じ | A |
| `tests/ai-usage-contract.test.ts` (9: 上限に数えない機能・既定のプランは migration と同じ・`AI_DAILY_CAPPED_FEATURES` = `AI_CAPPED_FEATURES`) | `consume_ai_usage_at` の置き換え | 変更なし (本冊は `c_unmetered` と `AI_CAPPED_FEATURES` を変えない。`AI_PLAN_CAPPED_FEATURE_LABELS` は別の名前)。migration の走査が「最新の `consume_ai_usage_at` の定義」を本冊の migration から拾うなら、`c_unmetered` の行を逐語で保つことで緑 | B |
| `tests/ai-daily-limit-core.test.ts`・`tests/ai-usage-edge.test.ts`・`tests/ai-daily-limit-client.test.tsx`・`tests/consultation-action-usage.test.ts`・`apps/mobile/__tests__/lib/ai-daily-limit.test.ts`・`src/__tests__/lib/plan/entitlements.test.ts` | `_shared/ai-daily-limit.ts` の全文の置き換え (`cappedFeature` の型が `AiPlanCappedFeature` に・`aiDailyLimitPayload` の本文が `AiUsageDeniedBody` に・`planLocked`) | 既存の期待は変えない (429 の本文の形・究極モードの文・1 日の上限の文は同じ)。「知らない機能名は付けない」の it が `menu_generation`・`image_generation`・`meal_image_auto` を知らない名前の例に使っていれば、AI_PLAN_CAPPED_FEATURES に無い名前 (例 `consultation`) に替える (実数に合わせる。緩めない)。テスト 41〜43・89・97・101・102 を足す | B |
| `tests/meal-image-skip.test.ts`・料理の保存の route のテスト (`git grep -l -E "skipped_ai_limit\|markDishImagesSkipped\|meal_image_auto" origin/main -- tests src/__tests__` で母集合を作る) | `MEAL_IMAGE_SKIPPED_ERRORS` に `plan` が増える・見送りの理由を `mealImageSkipReasonOf` で決める | 既存の期待 (安全弁の `skipped_ai_limit` と `aiSkipped`・レート制限の `skipped_rate_limit`) は変えない (偽の `consumeAiUsage` は `planLocked` を返さないので同じ枝)。`Object.values(MEAL_IMAGE_SKIPPED_ERRORS)` の数を数える it があれば 3 に。テスト 92・98・99 を足す | B |
| `tests/billing-public-plans.test.ts`・`tests/public-claims-guard.test.ts` の `vi.mock('@/lib/billing/public-plans')` | `listPurchasablePlans` を `listPublicPlans` に置き換える | テストの関数名と mock の名前を `listPublicPlans` に。「失敗したら空を返して error ログ」の it はそのまま (ログの文の期待があれば新しい文に) | B・C |
| `packages/shared/src/index.ts` を読むテスト (`git grep -l "packages/shared/src/index" origin/main -- tests packages`) | `export * from './billing-plans';` の 1 行 | export の一覧を固定する it があれば 1 行足す | B |
| `src/__tests__/lib/plan/entitlements.test.ts` (`aiFeatureDailyCap` が尋ねる名前・`consume_ai_usage_capped` の呼び分け) | 変更なし (呼び分けは変えない) | テスト 50 を足すだけ | B |
| `tests/ai-consent-enforcement.test.ts`・`tests/ai-usage-contract.test.ts` (棚卸し) / `tests/helpers/ai-consent-enforced-paths.ts` | `@/lib/env` に届く route: `webhooks/revenuecat`・`billing/iap/sync`・`billing/subscription` (遅延の再同期で `revenuecat-gateway` を import する) | `EXEMPT_ROUTES` に 3 行 (下の逐語)。`billing/iap/catalog` は届かない (載せない。テスト 31 が見る) | B |
| `src/__tests__/api/null-character-routes.test.ts` | `webhooks/revenuecat/route.ts` の POST が `request.text()` を読む | `EXCLUDED` に `'POST webhooks/revenuecat/route.ts': '本文は RevenueCat が署名して送るもので、利用者は書けない。大きさの上限と署名の確認より前に本文を JSON として読まない作り (billing/03 §9.1)'`。`iap/sync` は本文を読まない (載せない)・`iap/catalog` は GET | B |
| `lib/supabase/middleware.ts` と `lib/supabase/__tests__/middleware*.test.ts` (Webhook の受け口を認証の分岐から除く一覧) | `/api/webhooks/revenuecat` | Stripe の受け口と同じ除外に足す (実装時に Stripe の除外の書き方を grep で確かめ、同じ形で足す)。固定しているテストに 1 行 | B |
| `src/lib/maintenance-mode.ts`・`src/__tests__/lib/maintenance-mode.test.ts` | 新しい route 3 本と Webhook | 止める側 (503) に `/api/webhooks/revenuecat`・`/api/billing/iap/*` を足す (Stripe の Webhook と同じ扱い) | B |
| `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | 新しい route と `src/lib/billing/iap-*` | 固定の文だけ (`iapErrorResponse` / `billingErrorResponse`)。`RevenueCatApiError.rawMessage` はログ専用 | B |
| `tests/role-check-source-scan.test.ts` | `src/app/api/billing/iap/**` の handler | `requireUser` だけ | B |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient` の import | `iap-repository.ts` は `getSupabaseAdmin` だけ | B |
| `tests/next15-async-request-api-scan.test.ts` | `createClient()`・`params` | `await` を付ける | B |
| `tests/zod-single-copy-1444.test.ts`・`tests/edge-function-dep-pinning.test.ts` | 依存・Edge Function | 依存を足さない (RevenueCat の SDK をサーバに入れない)。Edge Function を足さない | — |
| `tests/billing-core.test.ts` (billing/01 §14 の番号のテスト 1〜16・72・89・95・111・112。本冊の §14 の番号ではない) | `summarizeSubscription` の 4 つ目の引数・`BillingSummary` の項目・`EXT_STRIPE_NOT_CONFIGURED` の文 | 呼び出しに `EMPTY_PLAN_FEATURES` を足す。`BillingSummary` のリテラルの期待に `source`・`manage_in_store: null`・`features` を足す。文の期待を新しい文に。テスト 34〜36 を足す | B |
| `tests/billing-service.test.ts`・`tests/api/billing-routes.test.ts`・`src/__tests__/app/account/billing-pages.test.ts`・`src/__tests__/app/frozen-billing-page.test.tsx` (`BillingSummary` の偽物・`summaryOf`) | `BillingSummary` の必須の項目が増える | 偽物に `manage_in_store: null`・`features: EMPTY_PLAN_FEATURES` を足す。`findPlanFeatures` の偽物を `BillingRepository` の偽物に足す。`billing-routes` の GET subscription の it に「遅延の再同期が要らない行では RevenueCat を呼ばない」を足す (テスト 33 は別ファイル) | B |
| `tests/billing-manual-grant.test.ts`・`billing-manual-grant-service.test.ts`・`billing-manual-grant-client.test.ts`・`src/__tests__/components/admin/manual-plan-grant-section.test.tsx` | `source` の union に `'store'`・`SUBSCRIPTION_COLUMNS` | 偽物の行に `iap_store: null` を足す。`store` のときの表示の it を 1 つ足す | B |
| `tests/billing-audit-action-lists-doc.test.ts` (`operator/07` §4 の `*.billing.*` の名前は 2 つの一覧のどちらかにある) | `system.revenuecat.event_failed` (名前に `.billing.` を含まない) | 変更なし。`operator/07` §4.5 に名前を足す (§16.2)。`BILLING_AUDIT_ACTIONS` の数は変えない | — |
| `tests/public-claims-guard.test.ts` | `FORBIDDEN` の `¥980`・`980円`・`9,800円`・`資本金`、`PAID_PLAN_PENDING_NOTICE` の描画、`/legal` の 5 行、`/company` の所在地、`#1151 料金ページ` の describe、`required` の `¥980` | §10.1・§10.2 の直し方 (テスト 44〜48) | C |
| `tests/business-info-legal-pages.test.ts` | 所在地 = `DISCLOSED_ON_REQUEST`・メールアドレスの形 | 所在地 = `BUSINESS_ADDRESS`・メールアドレス = `BUSINESS_EMAIL`・営業時間の行の存在。`it.each` のマーカー (「確定次第掲載」など) はそのまま緑 | C |
| `tests/e2e/b10-unexplored-areas.spec.ts` (4-1 / 4-3) | 「有料プランは準備中です（販売開始前）」の `toBeVisible` | 価格の文 (`580円`) の `toBeVisible` に (4-1 は `年払い` が無いことはそのまま。CTA の有無は環境 (Price の登録) で変わるので見ない) | C |
| `tests/faq-guide-wording-1859.test.ts` (FAQ の「」の名前が画面に実在する) | FAQ の料金の項目の書き換え | 新しい答えが「」で挙げる画面の名前 (「プランとお支払い」) が `src/app/(main)/settings/page.tsx` と `apps/mobile/app/(tabs)/settings.tsx` に実在する (段 D の行の title と同じ文字列) | C・D |
| `docs/design/marketing/01-landing-site.md` の文言の表を見張るテスト (`tests/landing-*` があれば。実装時に `git grep -l landing-copy origin/main -- tests` で確かめる) | `landing-copy.ts` の料金の章と `claims` | 設計書の表 (§16.2 の marketing の行) と同じ変更を同じ PR で | C |
| `src/__tests__/lib/feature-flags.test.ts` ほか `plan_key_cached` の偽の DB | 意味は変えない | 変更なし | — |
| `tests/integration/security/legal-documents-acceptance.test.ts`・`tests/integration/rls/user-profiles-insert-guard.test.ts` | 特権列ガード | 変更なし (触らない) | — |
| 家族の結合テスト (`tests/integration/security/family-*.test.ts`・`membership-*.test.ts`・`invite-*.test.ts`・`tests/integration/rls/ai-usage-rpc.test.ts`・`family-member-names-scope.test.ts`・`family-rls-recursion.test.ts`・`hidden-content-visibility.test.ts`・`meals-meal-type-trigger.test.ts`・`membership-audit-select.test.ts`・`paste-meal-*.test.ts`・`tests/integration/security/account-deletion.test.ts`・`invite-rpc-token.test.ts`・`plan-deprecate-subscribers.test.ts`・`purge-dissolved-family-groups.test.ts`・`parental-consent.test.ts`・`rpc-profile-name-placeholder.test.ts`・`invite-accept-missing-profile.test.ts`・`tests/integration/rls/family-menu-visibility.test.ts`・`hidden-content-restore.test.ts` ほか `create_family_group` か `family_members` の INSERT を使うもの (母集合の作り方 2) | `create_family_group` の門・`family_members` の INSERT のトリガー | 共通の道具 `tests/integration/helpers/family-plan.ts` (新設) に `grantFamilyPlan(srAdmin, userId, planKey = 'family_basic')` = `billing_grant_manual_subscription(p_user_id, p_plan_key, NULL)` の RPC (service_role) を置き、グループを作る利用者 (代表者) に、`create_family_group` を呼ぶ前に 1 行足す。service_role の直接の INSERT でグループを作るテストは、メンバーを足す前に `family_groups.plan_key` を `family_basic` に UPDATE する (すでにそうしているテストは変えない)。期待値 (人数の上限・`plan_key` の値) は、代表者に家族プランが入ることで `free` → `family_basic` / 4 になる箇所だけ更新する (実数に合わせる。緩めない) | A |
| `tests/integration/operator/super-admin-plans*.test.ts`・`tests/plan-*.test.ts` (プランの行の値を前提にするもの) | 価格・`display_name` の UPDATE | 価格や名前をリテラルで期待する it があれば実数に合わせる (実装時に `git grep -n -E "'Pro'\|'Family Basic'\|980\|1480\|2480" origin/main -- tests` で確かめる) | A |
| `src/__tests__/app/transfer-accept-fake-client.ts` (`SCHEMA_COLUMNS`) | `family_groups`・`personal_subscriptions` | 変更なし (`personal_subscriptions` は一覧に無い。`family_groups` の列は変えない) | — |
| `tests/design-doc-removed-mobile-screens.test.ts`・`tests/mobile-removed-files-references.test.ts` | 本冊は `docs/design/` に置かれる | 本冊は消した画面を名指ししない (`apps/mobile/app/settings/plan.tsx` は新設で一覧に無い) | — |
| `tests/native-app-tabs-contract.test.ts` | タブ | 変更なし (タブを足さない。`/settings/plan` はタブの外) | — |
| `tests/mobile-account-frozen-contract.test.ts`・`lib/supabase/__tests__/middleware-frozen-allowed-api.test.ts` | `FROZEN_ALLOWED_API_PATHS` | 変更なし (本冊の route は凍結中に通さない) | — |
| `lib/supabase/__tests__/middleware-legal-consent-api.test.ts`・`packages/shared/src/legal-consent-api.test.ts` | `LEGAL_CONSENT_EXEMPT_API_PATHS` | 変更なし (本冊の route は許可リストに入れない。S21) | — |
| `tests/legal-consent-*.test.ts`・`tests/e2e/legal-consent-gate.spec.ts` (版の値をスナップショットに持つなら) | `LEGAL_DOCUMENTS` の版 | 段 E で版の値を更新する (実装時に `git grep -n "v2025.1" origin/main -- tests src packages apps` で確かめる) | E |
| `apps/mobile/__tests__/app/no-web-purchase-links.test.ts` | `apps/mobile` の `/pricing`・`/account/billing` | 変更なし (本冊はどちらも書かない。冒頭のコメントだけ本冊の規則に書き換える) | D |
| `apps/mobile/__tests__/app/route-targets-exist.test.ts` | `/settings/plan` | `app/settings/plan.tsx` が実在するので緑。`MIN_ROUTE_FILES` / `MIN_TARGETS` は下限なので変えない | D |
| `apps/mobile/__tests__/lib/env-example.test.ts` | `process.env.EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY` / `GOOGLE` | `apps/mobile/env.example` に 2 行 | D |
| `apps/mobile/__tests__/lib/env.test.ts` (名前を直接書く) | `purchases.ts` の読み方 | 名前を直接書いている (§8.10) ので緑 | D |
| `apps/mobile/__tests__/settings/*entry.test.tsx`・`profile-row.test.tsx` (設定タブの行の数や `last` を見るなら) | 行を 1 つ足す・栄養目標の行の `last` を外す | 期待があれば実数に合わせる | D |
| `apps/mobile/__tests__/menus-weekly/ultimate-mode-toggle.test.tsx` | `locked` prop | テスト 57 を足す。既存の it は `locked` 無しで同じ | D |
| `apps/mobile/__tests__/lib/sign-out.test.ts`・`sign-out-push-token-release.test.ts`・`providers/auth-provider*.test.tsx` | `resetPurchasesOnSignOut`・`identifyPurchases` の呼び出し | `react-native-purchases` は `moduleNameMapper` の mock で読まれる。順序の期待に影響しない (掃除の前に 1 回 `await` が増えるだけ)。テスト 59 を足す | D |
| `tests/site-config-guard.test.ts` | ドメインを直接書かない | `STORE_SUBSCRIPTION_MANAGEMENT_URL` (`packages/shared/src/billing-plans.ts`) は Apple / Google のドメインで当社のドメインではない (このテストは当社のドメインの直接の記述を見る。実装時に正規表現を確かめ、当たるなら許可の一覧に足す) | B |
| `tests/no-committed-credentials.test.ts` | 新しい spec | アカウントの資格情報を書かない | B |
| `tests/integration/security/operator-mfa-db-gate.test.ts` (DB-1: 運営ロールの条件を持つポリシーは `operator_mfa_satisfied()` を呼び TO authenticated。DB-11: anon が `subscription_plans` を読める) | `plan_store_products_mutate_super_admin` (§6.3) | 変更なし (§6.3 のポリシーは TO authenticated で、`'super_admin' = ANY (roles)` の項に `(SELECT public.operator_mfa_satisfied())` を付けた形なので DB-1 の offenders に入らない。`DB_GATED_POLICY_MIN_COUNT` は下限なので変えない。cross/12 の付録 A は段 E の母集合の記録なので変えない。DB-11 は `subscription_plans` の RLS を変えないので緑) | A |
| `tests/integration/security/billing-personal-subscriptions-rls.test.ts` | `personal_subscriptions` の新しい列と CHECK (§6.4) | 変更なし (新しい列は NULL 可か既定値つき。RLS と権限は変えない (§6.9)。テストの行は `iap_store` を持たないので `personal_subscriptions_iap_pair_check` に当たらない) | A |
| `tests/integration/rls/billing-apply-subscription-rpc.test.ts` | `personal_subscriptions` (Stripe の写像) | 変更なし (`billing_apply_stripe_subscription` は凍結。手動の行で `BILL_LIVE_ROW_CONFLICT` を起こす it も、`iap_store` NULL の行なので同じ結果) | A |
| `tests/integration/rls/billing-manual-grant-rpc.test.ts`・`tests/integration/operator/super-admin-users-manual-plan.test.ts` | §6.7 の手動付与の 3 関数の述語 | 変更なし (ストアの行を作らない it では、M 行の選び方に `AND s.iap_store IS NULL` が増えても結果は同じ。ストアの行を残すことは本冊のテスト 63 が見る) | A |
| `tests/integration/rls/coupon-apply-rpc.test.ts` | `pro` の `monthly_price_jpy` (980 → 580) | 割引額の期待は `proPlan.monthly_price_jpy` から計算しているので変えない。事実と違う記述を直す: it 名「定率: 小数は切り捨て (980 円の 33% = 323.4 -> 323)」を「(580 円の 33% = 191.4 -> 191)」に、`:132` のコメント「月額 980 円 (参照データ)」を「月額 580 円 (参照データ)」に (`:134` の `org_standard` は本冊が変えないので触らない) | A |
| `tests/integration/rls/subscription-plans-yearly-price-id.test.ts` | `subscription_plans` の列・ポリシー 3 本 | 変更なし (本冊は列もポリシーも足さない。§6.2 は 3 行の値の UPDATE だけ) | — |
| `tests/integration/operator/super-admin-llm.test.ts` | `ai_daily_limits.free` が 5 に (§6.5) | `:130` の it 名「全プランの上限 (free は 1 日 10 回)」を「(free は 1 日 5 回)」に、`:142` の期待 `daily_limit: 10, effective_daily_limit: 10` を `5` に (実数に合わせる。緩めない)。`:144` の `arrayContaining(['free', 'pro', …])` はそのまま | A |
| `tests/integration/operator/super-admin-input-validation.test.ts` | `subscription_plans` | 変更なし (自分で作ったプランの値だけを見る) | — |
| `tests/integration/security/health-endpoint.test.ts` | anon が `subscription_plans` を 1 行読む (`src/app/api/health/route.ts:105`) | 変更なし (`subscription_plans` の RLS を変えない) | — |
| `tests/super-admin-llm-quotas-page.test.tsx`・`tests/super-admin-llm-quotas-route.test.ts`・`tests/helpers/ai-usage-mock.ts`・`tests/ai-usage-photo-auto-grant.test.ts` (free = 10 を偽の DB の値・テストの上限として持つ) | `ai_daily_limits.free` | 変更なし (DB を読まない偽の値。画面と route の振る舞いは値に依らない) | — |
| 母集合の作り方 2 が当てる src の読み手・書き手 (`src/app/(main)/family/**`・`src/app/(main)/settings/membership/page.tsx`・`src/app/(main)/menus/weekly/page.tsx`・`src/app/api/family/members/me/share/route.ts`・`src/app/api/family/members/names/route.ts`・`src/app/api/operator/membership/family/[id]/**`・`src/app/api/admin/finance/**`・`src/app/api/admin/users/[id]/route.ts`・`src/lib/membership/exit-notification.ts`・`src/lib/super-admin/plan-subscribers.ts`・`src/app/api/super-admin/plans/**`・`src/app/api/super-admin/llm/quotas/route.ts`・`src/app/api/health/route.ts`) | 本冊が変える表を読む・書く | 変更なし (読むだけか、§7.1 の書き手の表のとおり本冊の migration と干渉しない。どれも `family_members` に INSERT しない — 家族の行の追加は RPC (`accept_family_invite` など) の中で、§6.6 のトリガーが受ける) | — |
| 母集合の作り方 2 の insert の grep が当てる既存の migration と rollback (`supabase/migrations/20261007150200_*`・`20261007160000_*`・`20261008090100_*`・`20261015170000_*`・`20261016200000_*` と `supabase/rollbacks/` の対の `.down.sql`・`20261017030000_*.down.sql`)・`supabase/baseline/prod_schema.sql`・`tests/accept-copies-profile-name-migration-contract.test.ts` (migration の文面を見る) | `insert into family_members` | 変更なし (既存の migration は書き換えない。それらが定義する関数の中の INSERT も §6.6 のトリガーが受ける。本冊は `accept_family_invite`・`accept_child_promotion` を置き換えない) | — |
| `src/app/super-admin/coupons/new/page.tsx` (`:38-39` の `const typicalPrice = 980;` と `:176` の「Pro ¥980 基準」) | `pro` の価格 (980 → 580。980 は家族 Basic の価格になる) | 基準の価格を `@homegohan/shared` の `PLAN_CATALOG` から読む (`import { PLAN_CATALOG, formatJpy, planDisplayName, type PaidPlanKey } from '@homegohan/shared';`): `const COUPON_PREVIEW_PLAN_KEY: PaidPlanKey = 'pro'; // 粗利のプレビューの基準 = 個人 Pro の月額 (billing/03 §8.9)` と `const typicalPrice = PLAN_CATALOG.find((p) => p.plan_key === COUPON_PREVIEW_PLAN_KEY)?.monthly_price_jpy ?? 0;`。文は `実質粗利プレビュー ({planDisplayName(COUPON_PREVIEW_PLAN_KEY)} {formatJpy(typicalPrice)} 基準)`。テストは無い (`tests/jst-today-source-scan.test.ts` の当たりは日付の扱いで、変更なし) | C |
| `src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts` (「スイッチが表示され、無効化されていない」ほか) | §10.3 の錠 (`useBillingSummary`) | `vi.mock('@/hooks/useBillingSummary')` で既存の it は `null` (錠なし) を返す (既存の期待は変えない)。冒頭の経緯のコメントに「無料プランでは錠 (billing/03 §10.3)」を足す。テスト 103 を足す | C |
| `tests/e2e/bug-27-ultimate-mode-locked.spec.ts` (fresh-user = 無料の利用者でスイッチが操作できる) | §10.3 の錠 (無料では `menu_generation_ultimate` が 0) | 各 test の最初に、その利用者へ `grantManualPlanForE2e(userId, 'pro')` を呼ぶ (下の E2E の道具)。期待 (操作できる・`ultimateMode: true` が送られる) は変えない。冒頭の経緯のコメントに「有料プランで使える (billing/03 §10.3)。この spec は有料の利用者で確かめる」を足す | C |
| `tests/e2e/w5-3-menu-gen-adversarial.spec.ts` (A-3: テストごとの利用者で献立の生成の要求を 5 回。`:17` の「free は 10 回」) | 無料の献立の生成が 1 日 2 回・AI が 1 日 5 回に (§6.5) | `apiUserTest` の利用者で `/api/ai/menu/weekly/request` を 3 回以上送る test は、最初に `grantManualPlanForE2e(userId, 'pro')` を呼ぶ (pro は献立 10 回・1 日 30 回)。`:17` のコメントの回数を新しい値に。期待 (5 件とも 200) は変えない | C |
| 家族の E2E (`tests/e2e/fixtures/fresh-family.ts` の `family_groups` / `family_members` の直接の INSERT・`tests/e2e/helpers/membership-family.ts` と、それを使う `tests/e2e/family/*.spec.ts`・`tests/e2e/membership/05-*`〜`08-*`・`12-*`・`14-*`。UI からグループを作る spec) | `create_family_group` の門・`family_members` の INSERT のトリガー (free のグループにメンバーを足せない) | グループを作る前に、代表者へ `grantManualPlanForE2e(representativeUserId, 'family_basic')` を呼ぶ (billing/01 のトリガー `family_groups_billing_plan_follow_representative` が作成時に代表者の契約から `plan_key` / `member_limit` を決めるので、`plan_key: "free"` を直接書いても上書きされる。本文の `plan_key: "free"` は消す)。期待の人数の上限が 4 のままのものはそのまま、`free` を期待するものは `family_basic` に (実数に合わせる) | C |
| E2E の道具 `tests/e2e/helpers/billing-plan.ts` (新設) | — | `export async function grantManualPlanForE2e(userId: string, planKey: PaidPlanKey): Promise<void>` = `membership-family.ts` と同じ service_role の REST で `POST ${supabaseUrl}/rest/v1/rpc/billing_grant_manual_subscription` に `{ p_user_id: userId, p_plan_key: planKey, p_expires_at: null }` を送り、`!resp.ok` なら本文の先頭を付けて throw する (結合テストの `grantFamilyPlan` と同じ RPC。引数は `20261017230000_billing_manual_plan_grant.sql:18-22` の `p_user_id uuid, p_plan_key text, p_expires_at timestamptz DEFAULT NULL`、EXECUTE は service_role だけ `:103`)。fixture の後片付けは利用者の削除で契約の行も CASCADE で消える | C |
| #1911 の面 (§0.2 の対象外の欄のファイル) と、その「準備中」を見張るテスト (`tests/admin-preparing-pages.test.tsx`・`tests/preparing-notice.test.tsx`・`tests/admin-not-supported.test.ts`・`tests/super-admin-preparing-pages.test.tsx`・`tests/super-admin-exports-not-supported.test.ts`・`tests/moderation-route-contracts.test.ts`・`tests/admin-mutation-audit-coverage-1571.test.ts`・`tests/jst-today-source-scan.test.ts`・`tests/org-challenge-pages.test.tsx`・`tests/org-dashboard-refresh-route.test.tsx`・`tests/integration/operator/admin-moderation-detail.test.ts`・`tests/integration/operator/super-admin-exports.test.ts`・`tests/integration/security/super-admin-columns.test.ts`・`tests/integration/security/stop-aggregate-org-stats-cron.test.ts`・`tests/e2e/w5-12-admin-adversarial.spec.ts`・`src/__tests__/app/org/index-redirect.test.ts`) | 母集合の作り方 4 の「準備中」 | 変更なし (#1911 が受け持つ) | — |
| 「準備中」が読み込み中の表示の意味で、課金と関係しないもの (`src/app/(main)/menus/weekly/_components/modals/NutritionDetailModal.tsx` の「分析を準備中...」とそのテスト・`src/app/(main)/menus/weekly/page.tsx` のコメント・`src/app/(main)/settings/security/mfa/setup/page.tsx` の「準備中…」) と、「準備中」が無いことを確かめる回帰のテスト (`src/__tests__/app/settings/data-export.test.ts`・`src/__tests__/app/settings/trainer-share-removed.test.ts`・`tests/data-share-not-consent.test.ts`・`tests/health-photo-entry.test.tsx`) | 母集合の作り方 4 の「準備中」 | 変更なし (本冊の面ではない) | — |
| `tests/integration-ci-coverage.test.ts` | 新しい結合テストのパス | `tests/integration/rls/` と `security/` に置く | A |

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

**母集合の作り方**: `git grep -l -i -E "準備中|アプリ内課金|in-app purchase|RevenueCat|ai_daily_limits|究極モード|family_groups\.plan_key|create_family_group|10\.4" origin/main -- docs '*.md' ':!docs/design/billing/03-*'` で出たファイルを 1 本ずつ見る。

| 文書 | 箇所 | 直し方 | 期日 |
|---|---|---|---|
| `docs/design/billing/01-billing-core.md` | 表紙の Status (配線の冊の一覧に本冊)・§3.1 R11「モバイル (アプリ内課金をしない)」・S14・§10.4「モバイル (アプリ内課金をしない)」・§13.1 `EXT_STRIPE_NOT_CONFIGURED` の文・§17.3 の前提 (料金の画面の無い版)・§18 の 1 (価格)・2 (ストアの規約)・14 (特商法の文) | R11 を「アプリ内課金 (App Store / Google Play) は billing/03。アプリの中に Web の購入のページへの誘導を出さない規則は保つ」に、§10.4 を「billing/03 §10.6 に置き換え (規則 = Web の購入のページへ誘導しない、のみ残す)」に、§13.1 の文を本冊 §13.1 の文に、§18 の 1・2・14 を「billing/03 で確定」に | 段 B と同じ PR |
| `docs/design/billing/02-manual-plan-grant.md` | §6.3・§6.4 の M 行の述語・§7.1 の表の列 | 「M 行 = `stripe_subscription_id IS NULL AND iap_store IS NULL` (billing/03 §6.7)」に | 段 A と同じ PR |
| `docs/design/CLAUDE.md` | ドメイン構成の表の `billing/` の行 | 本冊 (`03-paid-plans-and-iap.md`。価格・線引き・アプリ内課金) を足す | 段 A と同じ PR |
| `docs/design/cross/04-api-conventions.md` | §4.2 エラーコード一覧 | §13.1 の [NEW] 7 つ (`BILL_IAP_INVALID_INPUT` / `BILL_IAP_UNKNOWN_PRODUCT` / `BILL_IAP_SYNC_CONFLICT` / `EXT_REVENUECAT_NOT_CONFIGURED` / `EXT_REVENUECAT_API_FAILED` / `AI_FEATURE_NOT_IN_PLAN` / `FAMILY_PLAN_REQUIRED`) と `EXT_STRIPE_NOT_CONFIGURED` の文 | 段 B と同じ PR |
| `docs/design/cross/08-legal-compliance.md` | §3.1 (最終確認画面の必須表示)・§7 (再同意) | §3.1 に「アプリ内課金の購入の画面はストアの要件 (billing/03 §10.6) で、特商法の確認画面は Web の Checkout だけ」を注記。§7 に本冊の段 E の版の繰り上げ | 段 E と同じ PR |
| `docs/design/cross/13a-legal-consent-api-server.md` | §6.2 許可リスト | 「billing/03 の `/api/billing/iap/*` と `/api/webhooks/revenuecat` は許可リストに入れない (Webhook はセッションを持たない受け口で、同意のゲートの対象外の形は Stripe と同じ)」を注記 | 段 B と同じ PR |
| `docs/design/mobile/01-architecture.md` | billing/01 §10.4 で足した「アプリ内に購入導線を出さない」の節 | 「アプリ内課金の購入の画面 (`app/settings/plan.tsx`。billing/03 §10.6)。Web の購入のページへの誘導は引き続き出さない」に書き換え、`react-native-purchases` と `expo-dev-client` (開発ビルドが要る) を依存の一覧に足す | 段 D と同じ PR |
| `docs/design/mobile/07-toolchain-upgrade.md` | 依存の一覧・開発ビルド | `react-native-purchases` 10.14.0・`expo-dev-client`・「Expo Go では購入が動かない (Preview API Mode)」を足す | 段 D と同じ PR |
| `docs/design/operator/04-plan-management.md` | §3.1 (価格の既定)・§5.2 (試用) | 価格を本冊の値に・試用の「同じプランで 1 回」にストアの試用 (`trial_source` = ストア) の片向きの共有を注記 | 段 A と同じ PR |
| `docs/design/operator/06-ai-llm.md`・`cross/06-perf-cache.md` (AI の上限の運営画面) | `/super-admin/llm/quotas` | 「プランごとの 1 日の上限は 4 行 (free 5 / pro 30 / family_basic 30 / family_pro 50)。機能ごとの上限 `ai_plan_feature_caps` は運営画面に無く SQL で変える (billing/03 §6.5)」を注記 | 段 A と同じ PR |
| `docs/design/operator/07-audit-monitoring.md` | §4.5 システム自動操作 | `system.revenuecat.event_failed` を足す (`target_type` の値 `revenuecat_event`)。`tests/billing-audit-action-lists-doc.test.ts` の規則 (`*.billing.*` でないので一覧の突き合わせの対象外) | 段 B と同じ PR |
| `docs/design/operator/01-data-model.md` | §3.7 DDL・§4 ER 図 | `personal_subscriptions` の 3 列・`plan_store_products`・`revenuecat_webhook_events`・`ai_plan_feature_caps` | 段 A と同じ PR |
| `docs/design/operator/09-runbook.md` | §3.2 適用順序の図・運用の手順 | 新設の 3 表と、`plan_store_products` に行を入れる手順 (§17.2)。二重購読 (`BILL_LIVE_ROW_CONFLICT`) の処置の表 (§13.3 の表をそのまま) と、App Store 同士のときに利用者へ送る案内の文 (「後からお買い上げの購入の返金は、reportaproblem.apple.com から Apple にお申し込みください」)。`iap_is_sandbox = true` の行の見方 (テストの購入。売上ではない) | 段 A と同じ PR (二重購読の処置は段 B と同じ PR) |
| `docs/design/operator/06-ai-llm.md` (料理画像の見送りの理由 `skipped_ai_limit` を書いている箇所。`git grep -n "skipped_ai_limit" origin/main -- docs` で 1 ファイル) | 見送りの理由の一覧 | `skipped_plan` (ご利用中のプランでは自動の料理画像を作らない。`ai_plan_feature_caps` の `meal_image_auto` = 0。billing/03 §8.8) を足す | 段 B と同じ PR |
| `docs/design/family/01-data-model.md`・`family/CLAUDE.md`・`membership/02-flow-spec.md` | `create_family_group`・メンバーの追加 | 「家族グループの作成とメンバーの追加は家族プランの契約者だけ (`FAMILY_PLAN_REQUIRED`。billing/03 §6.6)。契約が終わったグループのメンバーはそのまま」を注記 | 段 A と同じ PR |
| `docs/design/marketing/01-landing-site.md` | 料金の章の表・§24 の Q-12・`claims` の `free-now` | §10.5 の文に合わせる (`free-now` の主張を「有料プランは 3 つ」に) | 段 C と同じ PR |
| `.env.example`・`ENV_SETUP.md`・`apps/mobile/env.example` | 課金の節 | §8.7 | 段 B / D |
| `README.md`・`CLAUDE.md` (リポジトリの根) に「準備中」「アプリ内課金をしない」の記述があれば | 母集合の作り方の grep | 本冊の規則に書き換える | 段 B と同じ PR |
| `docs/handover/**`・`docs/bug-fix-report-*.md` | その時点の記録 | 対象外 | — |

### 16.3 共有面の台帳 (2 つ以上の PR が触る面)

| 共有面 | 本冊の段 | ほかに触るもの | 衝突の避け方 |
|---|---|---|---|
| `supabase/migrations/` の番号・`rollbacks/` | A | ほかの migration の PR | 番号はマージの直前に確定 (§6.1) |
| `src/types/database.types.ts`・`packages/shared/src/database.types.ts` | A | ほかの migration の PR | マージの直前の main で再生成 |
| 既存の関数の置き換え (`create_family_group`・`consume_ai_usage_at`・`consume_ai_usage_capped_at`・手動付与の 3 本) | A | それらを変える PR | マージの直前に `git grep -l` で最新の定義を確かめ、それを土台に作り直す (§6.5〜§6.7) |
| `personal_subscriptions` の列・部分 UNIQUE | A | 配線の残りの冊 | 列の追加だけ (CHECK・既存の索引は触らない) |
| `src/lib/env.ts`・`.env.example`・`ENV_SETUP.md` | B | 環境変数を足す PR | 行の追加だけ。節の番号を増やさない |
| `cross/04` のエラー表 | B | エラーコードを足す PR | 専権 PATCH で集める |
| `tests/helpers/ai-consent-enforced-paths.ts`・`null-character-routes.test.ts`・middleware の Webhook の除外・`maintenance-mode.ts` | B | route を足す PR | 行の追加だけ |
| `src/lib/billing/core.ts` (`BillingSummary`・`summarizeSubscription`・`BILLING_ERROR_MESSAGES`) | B | 配線の残りの冊 | 項目の追加と文の置き換えだけ |
| 公開の面 (`PricingPageView`・`legal`・`company`・`faq`・`landing-copy.ts`) と `tests/public-claims-guard.test.ts` | C | #1911 (「準備中」の撤去) | 本冊の面 (料金・特商法・運営会社・FAQ・紹介ページの料金) は本冊が書き換え、#1911 はそれ以外 (バッジ・組織・運営の画面) を扱う。同じファイルを触る PR は直列にマージし、後の方が相手の文を取り込む |
| `src/app/terms/page.tsx`・`privacy/page.tsx`・`legal-versions.ts` | E | #1901 | #1901 のあとに本冊の段 E (§11) |
| `apps/mobile/package.json`・`jest.config.js`・設定タブ・`AuthProvider`・`signOut.ts` | D | モバイルを変える PR | 行の追加だけ |

---

## 17. 本番の準備手順 (運用。秘密の値は発注者の作業)

### 17.1 順番 (§12 の表のとおり)

段 A・C のマージと本番の反映 と、#1901 のあとの段 E (規約とポリシーの有料の条文) の公開 → Stripe の有効化 (発注者) → 鍵と Price (= Web の販売開始) / 段 B・D のマージ → ストアと RevenueCat の設定 (発注者) → 鍵と商品の行 → 段 E の公開のあとに本番のビルドの提出と審査 (= アプリの販売開始)。

### 17.2 ストアの商品 ID と `plan_store_products` の行 (運営が SQL で入れる。`super_admin` の RLS でも書ける)

| plan_key | 間隔 | App Store の商品 ID (Subscription Group `homegohan_plans`) | Google Play の購読 ID : base plan ID |
|---|---|---|---|
| `pro` | month | `homegohan_pro_month` | `homegohan_pro:monthly-autorenewing` |
| `pro` | year | `homegohan_pro_year` | `homegohan_pro:annual-autorenewing` |
| `family_basic` | month | `homegohan_family_basic_month` | `homegohan_family_basic:monthly-autorenewing` |
| `family_basic` | year | `homegohan_family_basic_year` | `homegohan_family_basic:annual-autorenewing` |
| `family_pro` | month | `homegohan_family_pro_month` | `homegohan_family_pro:monthly-autorenewing` |
| `family_pro` | year | `homegohan_family_pro_year` | `homegohan_family_pro:annual-autorenewing` |

```sql
-- tsc:skip 運営が本番で流す (service_role / super_admin)。商品 ID は実際に作ったものに合わせる
INSERT INTO public.plan_store_products (plan_key, store, billing_interval, product_id) VALUES
  ('pro', 'app_store', 'month', 'homegohan_pro_month'), ('pro', 'app_store', 'year', 'homegohan_pro_year'),
  ('family_basic', 'app_store', 'month', 'homegohan_family_basic_month'), ('family_basic', 'app_store', 'year', 'homegohan_family_basic_year'),
  ('family_pro', 'app_store', 'month', 'homegohan_family_pro_month'), ('family_pro', 'app_store', 'year', 'homegohan_family_pro_year'),
  ('pro', 'play_store', 'month', 'homegohan_pro:monthly-autorenewing'), ('pro', 'play_store', 'year', 'homegohan_pro:annual-autorenewing'),
  ('family_basic', 'play_store', 'month', 'homegohan_family_basic:monthly-autorenewing'), ('family_basic', 'play_store', 'year', 'homegohan_family_basic:annual-autorenewing'),
  ('family_pro', 'play_store', 'month', 'homegohan_family_pro:monthly-autorenewing'), ('family_pro', 'play_store', 'year', 'homegohan_family_pro:annual-autorenewing')
ON CONFLICT (plan_key, store, billing_interval) DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();
```

- RevenueCat: Entitlement `pro` ← `homegohan_pro_month` / `_year` と Google の 2 つ、`family_basic` と `family_pro` も同様。Offering `default` に 6 つの package (`$rc_monthly` / `$rc_annual` を使わず、商品ごとに custom の identifier (例 `pro_month`) にする。アプリは package の identifier を見ず `product.identifier` で突き合わせる)。
- Apple の無料体験は Introductory Offer (Free trial・7 日)、Google は base plan の offer (free trial・7 日) で設定する。価格は Q-1。

### 17.3 Vercel / EAS / Supabase

- Vercel (本番): `REVENUECAT_SECRET_API_KEY`・`REVENUECAT_WEBHOOK_SECRET`。RevenueCat の Webhook の URL は本番の 1 つ (`https://<サイト>/api/webhooks/revenuecat`) だけを登録する。sandbox の購入 (審査・TestFlight・内部テスト) も本番の受け口と本番の DB に写る (Q-13。行は `iap_is_sandbox = true`)。
- EAS: `EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY`・`EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY` (公開 SDK キー)。`eas build --profile development` (sandbox の確認)・`preview` (内部テスト)・`production`。
- migration の適用 (段 A のマージ後。追加 + 3 行の UPDATE)。

### 17.4 受け入れの確認 (整合ゲートで読み取り・実機)

- `/pricing` に 3 プランの価格・無料体験・内容が出て、Price の登録の前は CTA が無い。`/legal` に販売価格の 3 行と会社情報。`/company` に所在地・設立・資本金・営業時間。どのページにも「準備中」「販売開始前」が無い。
- 無料の利用者: 献立の生成 3 回目が 429、究極モードのトグルが錠、料理画像の作成が 403 (「料理画像の作成は、有料プランでお使いいただけます。」)、料理の保存で画像が付かず料理の画面に有料プランの案内、家族グループの作成が 402。
- 手動付与で `pro` にした利用者: 1 日 30 回・究極 2 回・料理画像が作れる。`family_basic` の利用者: グループを作れ、4 人まで足せる。
- iOS (TestFlight・sandbox のアカウント。本番の受け口と本番の DB): 設定 → プランとお支払い → 個人 Pro 月額 (ストアの価格の表示・7 日間無料の表示・自動更新の文) → 購入 → `personal_subscriptions` に `trialing`・`iap_store='app_store'`・`iap_is_sandbox = true`・`plan_key_cached='pro'`・`admin_audit_logs` に `subscription_created`。`revenuecat_webhook_events` に `INITIAL_PURCHASE` が `completed`。Web の `/account/billing` に「App Store でご契約中」。購入を復元 → 同じ行。sandbox の時間の進みで `RENEWAL` → `current_period_end` が進む。自動更新を切る → `cancel_at_period_end=true`。
- Android (内部テスト): 同じ流れで `play_store`。
- 二重購読: Stripe で契約中の利用者のアプリに購入のボタンが出ない。
- App Store の審査の購入 (sandbox): 審査のあとに `personal_subscriptions` に `iap_is_sandbox = true` の行が live で写っていた (読み取りで確かめる。S24)。
- 退会: ストアの契約がある利用者を退会 → 行が消え、次の Webhook が 200 (`user_deleted`)。

---

## 18. 未解決事項 (openQuestions)

| # | 項目 | 本冊の仮置き |
|---|---|---|
| 1 | Q-1〜Q-13 (§0.5) | 推奨の値 |
| 2 | App Store の日本の価格帯の一覧 (580 / 980 / 1,480 / 5,800 / 9,800 / 14,800 円が選べるか) は App Store Connect でしか確かめられない | Q-1 |
| 3 | 献立の生成の既定の LLM (`V4_FAST_LLM_PROVIDER`。本番で xAI か OpenAI か) と 1 回の token 数は本番の設定とログを読まないと分からない。§2.4 の原価は推計 | 推計で Q-2・Q-3 の推奨を出した。本番のログ (`app_logs`) で 1 週間の実測を取ってから値を見直す |
| 4 | RevenueCat の Webhook の再送が 5 回で止まること (P4) への網は、本人の操作からの同期と遅延の再同期 (Q-11)。本人が使わない契約の更新は写らないまま期限を迎える (権利が無い間は `expired` のまま) | 日次の reconcile (RevenueCat の全契約の列挙は API に無い (P5 の検索の結果) ので、`personal_subscriptions` のストアの live 行を 1 件ずつ取り直す) は配線の残りの冊 |
| 5 | Web で試用済みの利用者がストアで同じプランの試用を受けること (Q-10 の逆向き) | 止められない (ストアの判定)。許容する |
| 6 | 家族プランの無い利用者が招待を作れる (承諾で 402) こと | 招待の作成の route でも `billing_has_live_family_plan` を見て 402 にするかは family の冊。本冊は承諾の門だけ |
| 7 | 契約が終わった家族グループのメンバーの扱い (そのまま。Q-4) | billing/01 §18 の 15 と同じ |
| 8 | 二重購読の 2 本目の扱い。App Store の購入は開発者が返金できない (P14) | 当社が解約・返金できるもの (Stripe・手動付与・Google Play) は当社が処置し、App Store 同士は利用者に Apple への返金の申し込みを案内する (§13.3 の表。手順は `operator/09` の追随。§16.2) |
| 9 | ストアの `grace` (当社の `grace` = Stripe の配線のジョブが進める状態) をストアの行で使うか | 使わない (ストアの猶予期間は `past_due` で表す。§7.3) |
| 10 | `management_url` (RevenueCat) が null のときの行き先 | `STORE_SUBSCRIPTION_MANAGEMENT_URL` (§8.9) |
| 11 | モバイルの `/account/billing` の WebView の表示 (読み取り専用のまま) とネイティブの購入の画面の二重 | 本冊はネイティブの画面を正にし、WebView の `/account/billing` は Web の文のまま (リンクは出さない) |
| 12 | 運営画面での `plan_store_products`・`ai_plan_feature_caps` の編集 | SQL (§17.2)。画面は配線の残りの冊 |
| 13 | Google Play の Billing Library の版 (2026-08-31 以降は 8 以上。P8) を `react-native-purchases` 10.14.0 が満たすか | RevenueCat のリリースノートに版の記述が無い (P2・P8)。段 D の EAS のビルドで `purchases-android` の依存を確かめ、満たさなければ `react-native-purchases` を上げる |
| 14 | Apple の審査で「Web でご契約中」の文 (S3) が 3.1.3 の「誘導」と見なされるか | リンクを置かず、文だけにする (3.1.3(b) で Web の契約の利用は認められる)。指摘があれば文を「別の方法でご契約中」に |
| 15 | スマホソフトウェア競争促進法 (2025-12-18 施行) による外部決済の扱い | 本冊はストアの決済だけを使う (§0.4)。外部決済への誘導は作らない |
| 16 | `trial_source` の値 `app_store` / `play_store` を読む運営の画面があるか | 実装時に grep (`git grep -n trial_source origin/main -- src`) で確かめ、`'checkout'` を前提にした分岐があれば `IAP_STORES` を足す |
| 17 | テストの購入 (sandbox) を本番で権利にすること (Q-13) の悪用 | 販売開始の後、運営が `iap_is_sandbox = true` の行を確かめる。審査・TestFlight・ライセンステスターのほかの利用者の行が出たら、許可の一覧 (利用者 ID) の仕組みを別の冊で足す |
| 18 | プライバシーポリシーの保存期間 | 本冊の差分に含めない (§11.2)。書くときは、契約の行は退会で消え、監査の記録とイベントの写しは運営の保存期間に従うという本冊の動きに合わせる |

---

## 改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-19 | 新設 (設計ゲート R1 の叩き台。4 相: 外形固定 §3 → 構想 §4 → 構造裁定 §5 → 仕上げ §6〜§17) |
| v1.1 | 2026-10-19 | R1 の指摘の反映: sandbox の購入を本番でも写す (App Store の審査の購入を権利にする。`iap_is_sandbox` の列を足し、v1.0 の環境変数 `REVENUECAT_ACCEPT_SANDBOX_EVENTS` を廃止)・ストアの猶予期間 (`grace_period_expires_date`) を `past_due` に・`plan_locked` と機能ごとの上限を `_shared/ai-daily-limit.ts` の全文で確定 (AI 相談の自動実行・Edge の生成の文も同じ関数で正しくなる)・自動の料理画像 (`meal_image_auto`) を無料から外す (Q-3)・モバイルが読む型と文を `packages/shared/src/billing-plans.ts` に置く・未完成を示す文の禁止語に「まだ」の類を足す・二重購読の処理を「当社が持つ側を解約・返金する」に・規約の草案の食い違い (保存期間・プランの変更) を実際の動きに合わせる・申請の順を「規約とポリシーの有料の条文の公開 → Stripe の申請・ストアの審査」に・`verify.ts` の正典を既存の `verifyStripeSignature` の上に書き直す |
