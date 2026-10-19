# cross/20 利用規約・プライバシーポリシーの本文 — 製品の実際の動きと法令に合わせた全文 (逐語の正典) と、版の上げ方

| | |
|---|---|
| 版 | v1.6 (2026-10-19) |
| Status | 設計ゲート審査中 (実装着手は通過後) |
| Issue | #1901 |
| 範囲の正本 | Issue #1901 の本文とコメント。前提と判断は本書 §0.1 に文として書く |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |
| 実装の範囲 | `src/lib/legal/` (新設 4 本)・`src/components/legal/LegalDocumentBody.tsx` (新設)・`src/app/terms/page.tsx`・`src/app/privacy/page.tsx`・`packages/shared/src/legal-versions.ts` (版)・新設のテスト (§13)・既存のテスト 2 本の追随 (`tests/public-claims-guard.test.ts` の走査の対象・`src/__tests__/api/cron/push-outbox.test.ts:176` の版の直書き。§14 段 B・§16)・`docs/legal/archive/` (旧版の控え)。DB・API・モバイルのコードは変えない |

発注 (Issue #1901 に記録された 2026-10-19 08 時台の指示) の逐語: 「利用規約とプライバシーポリシーが薄すぎる。しっかり内容作り込んで。今では明らかに足りないでしょう」

本書の中心は **§6 (利用規約の全文)** と **§7 (プライバシーポリシーの全文)** の 2 つの TS ブロックと、**§10 (各条項 ⇄ 製品の根拠の対応表)** である。実装 (B 型) は、この全文をそのままモジュールに置き、ページをそのモジュールから描く形に替え、版を上げ、再同意を動かすだけで済む。

⚠ **公開の前に弁護士の確認を受けることを勧める** (確認の有無はオーナーの判断。Issue #1901 の「進め方」も同じ扱いを求めている)。本書の文面は、製品の実際の動き (file:line) に当たる約束だけで書いたが、法令の当てはめ (委託と第三者提供の区別・外国の制度の情報・責任の制限の範囲・管轄の定め方) は法律の専門家の確認を要する。確認で変わりうる点は §18 に列挙した。

---

## 0. 外形固定と分冊判定 (相 1)

### 0.1 発注と前提

| # | 前提 | 出どころ |
|---|---|---|
| P-1 | 作るのは `/terms` と `/privacy` の本文。同意の仕組み (再同意・同意画面・API・モバイルのゲート) は既存のまま使い、版を上げて動かす | Issue #1901「版を上げると、既存の再同意の仕組み (#1174) で利用者に同意し直してもらう」 |
| P-2 | 主張・約束は製品の実際の動き (file:line) に当たるものだけ。できないことを約束しない | §10 の対応表が根拠。根拠の無い約束は書かない |
| P-3 | 事業者の名称・代表者・連絡先は、特定商取引法に基づく表記 (#1567・`src/lib/business-info.ts`) と公開の画面に今ある値だけを使う。所在地・電話番号は「請求があった場合に遅滞なく開示します」(`DISCLOSED_ON_REQUEST`) のまま。決まっていない値は「未定」と書き、作らない (§0.6) | `src/lib/business-info.ts:13-22`・`src/app/legal/page.tsx:28-32` |
| P-4 | 今ある約束はすべて引き継ぐ: 現行 `/terms` 第 1〜9 条・`/privacy` 第 1〜7 条・cross/08 §8 (医療免責の文)・§14 (AI 生成物の著作権 3 項)・AI の同意の文面 (`AI_CONSENT_COPY`)・保護者の同意書・特商法の表記 | §2.2 F-1〜F-4 |
| P-5 | 有料プランは販売開始前 (特商法の表記・料金ページが「準備中」)。課金の仕組み (Stripe Checkout・解約・退会時の即時解約) は実装済みで、買えるプランが出た時点で動く | `src/app/legal/page.tsx:24-25`・billing/01 §0・`tests/public-claims-guard.test.ts:196-198` |
| P-6 | 本番の同意ゲートは `LEGAL_CONSENT_ENFORCE=on` (2026-10-10 のオーナー判断、cross/08 §7.2)。版を上げてデプロイした時点から、サインイン中の全員に再同意が求められる | cross/08 §7.2・`packages/shared/src/legal-versions.ts:4-15` |
| P-7 | 旧版の文面は `docs/legal/archive/v<版>/` に控えを置く (cross/08 §7.2「改定のたびに手で行う」・§19 TODO)。本書の実装で初めて作る | cross/08 §7.2・§19 |
| P-8 | AI の同意の文面 (`AI_CONSENT_COPY`・`AI_CONSENT_VERSION = 'draft-2026-10-10'`) と保護者の同意書 (`PARENTAL_CONSENT_DOCUMENT`) は本書では変えない。プライバシーポリシーの AI の節は、同意画面と同じ事業者の一覧 (`AI_CONSENT_PROVIDERS` / `AI_CONSENT_PROVIDER_INFO`) から出し、食い違わないようにする | `src/lib/ai/consent-config.ts:16-31, 85-116`・`supabase/functions/_shared/ai-consent.ts:33, 42` |

### 0.2 要件行列

| # | 要件 | 根拠 | 本書の対応 |
|---|---|---|---|
| R-1 | 利用規約に、製品の実際の機能 (AI・上限・料金・家族・組織・公開範囲・凍結・退会・未成年) をすべて書く | Issue #1901 | §6 第 6〜17 条 |
| R-2 | 利用規約に医療免責 (cross/08 §8 の文をそのまま) と急病時の 119 の案内を置く | cross/08 §8 の 5「利用規約 §X」 | §6 第 9 条 |
| R-3 | 利用規約に AI 生成物の著作権 (ユーザー帰属・匿名化した集計利用・口コミの CC0 相当) の 3 項を置く | cross/08 §14 | §6 第 14 条 |
| R-4 | 責任の制限は消費者契約法 8〜10 条の範囲 (故意・重過失を除外、軽過失は通常損害に限る、全部免除にしない)。個別の条 (凍結などの措置・サービスの変更や中断) の損害も、責任を負わない形にせず第21条の範囲に寄せる | 消費者契約法 8 条・8 条の 2・9 条・10 条 (§3) | §6 第 16 条 5 項・第 18 条 4 項・第 20〜21 条 |
| R-5 | 内容が変わる規約の変更は、再同意の仕組み (ユーザーの同意による変更) で行い、変更の概要と施行日を施行日の前に本サービスのお知らせ (ホームに出る) に掲載する。同意を得ない変更 (民法 548 条の 4) の定めは置かない (Q-19) | 民法 548 条の 2〜4・#1174・F-31 | §6 第 24 条・§9.4 |
| R-6 | プライバシーポリシーに、集めるデータの全種類・利用目的・要配慮個人情報の取得の同意を書く | 個人情報保護法 17・18・20 条 2 項・21 条 | §7 §3〜§5 |
| R-7 | 外国にある第三者 (AI 事業者) への提供は、国名・制度の情報・事業者の措置の情報を示したうえで同意を得る形にする。事業者の一覧は同意画面と同じ定数から出す | 法 28 条 2 項・規則 17 条・`tests/business-info-legal-pages.test.ts:139-167` | §7 §6 |
| R-8 | 委託先 (Supabase・Vercel・Resend・Stripe・Upstash・Expo・Cloudflare・GitHub・Google) を用途・渡る情報・所在国つきで列挙し、外国への委託の扱い (法 28 条 1 項の基準適合体制) を書く | 法 25 条・27 条 5 項 1 号・28 条 1 項・規則 16 条 | §7 §7 |
| R-9 | 保有個人データの公表事項 (事業者の名称・代表者・利用目的・請求の手続・苦情の申出先・安全管理措置) を書く | 法 32 条 1 項・施行令 10 条 | §7 §1・§4・§11・§14・§17 |
| R-10 | 開示等の請求の手続 (画面・本人確認・期限・第三者提供記録の開示) を実装どおりに書く。AI 事業者への提供の記録が何であるかを書く | 法 29 条・33〜35 条・cross/15 | §7 §6 の 5・§14 |
| R-11 | 保存期間 (隠した投稿・ログ (ブラウザのセキュリティ違反の報告を含む)・ログイン履歴・送信待ち・プッシュ通知の宛先・AI 機能の利用回数・回数の制限の計数・バックアップ・退会後) を実装の値から書く | cross/17 §9.1・各 migration | §7 §12 |
| R-12 | 外部送信 (Cookie・ブラウザの保存・ブラウザから直接の Supabase・Vercel Speed Insights・Turnstile・Stripe・Google・祝日の一覧 (GitHub Pages)・Expo の通知) を、電気通信事業法 27 条の 12 の公表事項 (送る情報・送り先・目的) の形で書く。広告・計測の Cookie は使っていない | 電気通信事業法 27 条の 12・`src/__tests__/lib/security/csp.test.ts:264-272` (PostHog 不採用)・F-15 | §7 §10 |
| R-13 | 未成年 (18 歳未満は保護者の同意・13 歳未満の本人アカウント無し) を両文書に書く | cross/14・`packages/shared/src/parental-consent.ts:12-16` | §6 第 3・5 条・§7 §15 |
| R-14 | 家族・組織で誰に何が見えるかを書く。組織の管理者に見える項目は、組織の画面と API が実際に読む項目だけにする (設計書の計画の項目を書かない) | 家族の共有設定と招待 (F-18)・組織の管理者の画面 (F-19) | §6 第 11〜12 条・§7 §3・§9 |
| R-15 | 版を上げる (両文書とも)。上げると何が起きるか (Web・API・モバイル・通知) を設計に書く | #1174・13a・13b・`src/lib/push/outbox.ts:245-256` | §9 |
| R-16 | 文面は型のあるデータ (TS) で持ち、ページはそれを描く。文面の存在と製品の定数との一致はテストで固定する | 完成条件 (Sonnet が迷わない)・§13 | §5・§8・§13 |
| R-17 | 既存のテスト (事業者名が 1 種類・AI の送信先の一覧・版の表示・h1・戻るリンク・公開ページの禁止語) を壊さない。文面に「株式会社」「Inc」「最適な」「24時間以内」などの禁止語を書かない | `tests/business-info-legal-pages.test.ts:96-103`・`tests/policy-pages-public.test.tsx`・`tests/public-claims-guard.test.ts:113-187` | §16 |
| R-18 | 効果・治療・予防をうたわない (薬機法 66・68 条・景品表示法・健康増進法 65 条) | §3 | §6 第 9 条・§7 全体 |
| R-19 | 旧版の文面を `docs/legal/archive/` に残す | cross/08 §7.2・§19 | §14 段 B |
| R-20 | 仮名加工情報・匿名加工情報の作成の有無を言い切る (作成していない) | 法 2 条 5 項・6 項・41〜46 条・Issue #1901 の法令の項目 | §7 §4 末尾 |
| R-21 | 端末の機能 (カメラ・写真ライブラリ・通知) へのアクセスと使い道、取得しないもの (位置情報・連絡先・マイクの音声) を公表する | `apps/mobile/app.json:23-25, 34-41`・`apps/mobile/package.json:30` (F-25) | §7 §3 (端末の機能の表)・§10 (参照) |
| R-22 | AI 事業者へ送る情報は、同意画面の 6 項目の写しで済ませず、実際にプロンプトに入る項目 (ニックネーム・プロフィール・持病・服薬・妊娠/授乳の状況などの要配慮個人情報) まで書く。送らないと言い切れないもの (氏名・メールアドレス) は言い切らない | 法 28 条 2 項・20 条 2 項・F-29 | §7 §5・§6 |
| R-23 | 誰が何を見られるか (写真・つないだ未成年の記録・運営) は、実装の経路 (RLS・署名 API・RPC) どおりに書く | cross/19 §6.1・cross/14 §11・F-18・F-33 | §6 第 5・11・13 条・§7 §5・§9・§15 |
| R-24 | 「いつでも」「設定画面から」と書く約束 (退会・書き出し・解約) は、版を上げた後の同意の前 (設定画面が同意画面へ回る間) の手段まで書く。メール・多要素認証・保存のしかたの約束は、実装の範囲 (止める設定の有無・対象のロール・伏せる列) に限る | F-32・F-34〜F-36・§11.3 | §6 第 10・17・19・24 条・§7 §11〜§13・§16 |
| R-25 | IP アドレス・User-Agent を持つ表は、すべて第3条に載せるか、載せない理由 (利用者の情報でない・書き込む処理が無い) を持つ。表が増えたらテストが赤になる | F-17・F-37 | §7 §3・§12・T-30 |

### 0.3 ユーザーシナリオ (17 本。トレースは §4.3)

| # | シナリオ |
|---|---|
| S-1 | 未ログインの人が LP のフッターから `/terms` を開き、版・施行日のあとに章と条が並ぶ全文を読む。見出しは「利用規約」1 つ、戻るリンクはトップ |
| S-2 | ストア審査の担当者が `/privacy` を開き、集めるデータ・AI 事業者・委託先・保存期間・削除の方法・問い合わせ先を読む |
| S-3 | 版を上げてデプロイした直後、同意済み (v2025.1) の Web の利用者がホームを開く。middleware が `/legal-consent?next=/` へ回し、「改定されました」の導入文と、両文書に「改定あり」の印が出る。全文のリンクで新しい文面を読み、2 つのチェックで「同意して続ける」を押すと、`user_profiles` の 2 列が新しい版になり元の画面へ戻る |
| S-4 | 同じ利用者がアプリ (Expo) を開く。`GET /api/legal/status` が未同意を返し、ルートのゲートがアプリを `/legal-consent` の WebView 1 枚にする。同意すると `legal-consent-accepted` の合図で入口から振り分け直す |
| S-5 | 新しい版に同意していない利用者のアプリが `/api/meals` を呼ぶ。middleware が 403 `LEGAL_CONSENT_REQUIRED` を返し、画面は同意画面へ案内する。退会・書き出し・開示等の請求・お問い合わせ・有料プランの解約の API は通る (ただし、凍結されていない成人の未同意の人には、退会・書き出し・解約の画面 (`/settings`・`/account/billing`) は同意画面へ回されて出ない。画面があるのは請求とお問い合わせだけ。利用規約第10条 4 項・第17条 1 項とプライバシーポリシー第13条 1 項・3 項は、この間の手段を第24条 2 項 (お問い合わせからの削除と解約の依頼・開示の請求) と書く。F-32・S-17) |
| S-6 | 同意画面で「同意しない（ログアウトする）」を押す。ログアウトし、開示・訂正・利用停止・消去の請求 (`/settings/data-requests`) とお問い合わせへのリンクが出る。再ログインすると同意画面に戻る |
| S-7 | 版を上げた後、プッシュ通知の cron が未同意の利用者の行を送らずに `consent_outdated` (`PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED`) で止める。再同意すると次回から届く |
| S-8 | 新規登録の人がサインアップ画面で規約・プライバシーポリシーのリンクを開き、新しい全文を読んでから登録する。登録後 `/auth/callback` が同意画面へ回し、生年月日を入れて同意する |
| S-9 | AI 機能を初めて使う人が、プライバシーポリシー §6 の事業者の一覧 (同意画面と同じ 5 社) と、同意画面の一覧が同じであることを確かめる |
| S-10 | 健康診断の写真を登録した人が、プライバシーポリシー §5 で「健康診断の結果は要配慮個人情報に当たり、本人の操作による登録をもって同意を得る」「健康の記録と写真は家族にも組織にも表示されない」を読む |
| S-11 | 開示の請求をしたい人が、プライバシーポリシー §14 の手順 (設定 → 請求 → 本人確認メール → 30 日の応答期限) を読み、`/settings/data-requests` から請求する。凍結中・退会後の人は `/contact` から |
| S-12 | 退会したい人が、利用規約第 17 条で「即時削除・取り消せない・公開レシピは匿名化して残る・バックアップに一定期間残る」を読み、設定から退会する |
| S-13 | 凍結された人が `/frozen` を見て、利用規約第 16 条で「凍結中もデータの書き出し・退会・有料プランの解約・お問い合わせができる」ことを確かめる |
| S-14 | 保護者が 13 歳以上 18 歳未満の子を家族に追加し、保護者の同意書に同意して、子のアカウントをつなぐ。子は利用規約第 5 条を読み、保護者の同意とのつながりが切れたときは、保護者が家族に追加し直して本人が案内を承諾するか 18 歳になるまで、退会の道だけが出ることを知る |
| S-15 | 実装者 (Sonnet) が §6・§7 の TS ブロックを `src/lib/legal/` に置き、§8 の描画部品でページを描き、§13 のテストを足し、§9 の版を書き換える。手を止める箇所が無い |
| S-16 | 誤字の修正のように内容が変わらない直しをする人が、§9.3 の規律 (版を上げない) を読み、版を据え置いて文面だけ直す |
| S-17 | 版上げの後、新しい版に同意したくない成人 (凍結されていない) が、利用規約第24条 2 項で「同意の前でもできること」を読み、同意画面の「同意しない（ログアウトする）」から、お問い合わせでデータの削除を依頼する (設定の退会の画面は同意画面へ回されるので使えない)。有料プランを契約している人は、同じお問い合わせで解約を依頼し、自動更新を止める (設定の「お支払い」も同意画面へ回される) |

### 0.4 分冊判定

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (2 文書の全文を逐語で持つため) | 該当 |
| 消費先レーン 3 以上 | `/terms`・`/privacy` の 2 ページと、版の定数 1 つ。同意画面・API・モバイル・AI 同意は**変えない** (読むだけ) | 非該当 |
| 共有面 2 つ以上 | `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` (版。全員の再同意を動かす) の 1 つ。`business-info.ts`・`consent-config.ts` は読むだけ | 非該当 |

判定: **1 冊**。核 (全文) と配線 (ページ・版) を分けると、全文を参照しないページの冊に意味が無い。実装は 2 段 (段 A: 文面モジュール + 描画部品 + テスト / 段 B: ページの差し替え + 版上げ + 旧版の控え + 番兵の追随。§14) に分け、段ごとに 2 枚レビューを挟み、**マージは段 B のあと 1 回** (内容が変わる文面を版を据え置いたまま公開しないため。`legal-versions.ts:11-12` の規律)。

### 0.5 用語

| 語 | 意味 |
|---|---|
| 文面モジュール | 全文を TS のデータ (§8.1 の `LegalDocumentText`) として持つ `src/lib/legal/terms-text.ts`・`privacy-text.ts` |
| 文脈 (`LegalTextContext`) | 文面の中で製品の定数から埋める値 (事業者名・代表者・問い合わせ先・AI 事業者の一覧)。ページが組み立てて文面モジュールに渡す |
| 版 | `LEGAL_DOCUMENTS[type].version`。同意の記録と比べる文字列。`v2026.1` に上げる (§9) |
| 施行日 | `LEGAL_DOCUMENTS[type].effectiveDate`。画面に出すだけの値。再同意はデプロイの時点から始まる |
| 再同意 | 版の食い違いで同意ゲートが同意画面へ回すこと (#1174・13a・13b) |
| 要配慮個人情報 | 個人情報保護法 2 条 3 項。本サービスでは健康診断・血液検査の結果、病歴・服薬・妊娠の有無など (§7 §5) |

### 0.6 未定の値 (「未定」と書き、作らない)

| 値 | いまの扱い | 文面での書き方 |
|---|---|---|
| 所在地・電話番号 | `DISCLOSED_ON_REQUEST` (請求があった場合に遅滞なく開示) | プライバシーポリシー §1 に同じ文を書く。架空の住所・番号は書かない |
| 管轄裁判所の名称 | 本店所在地が公開されていない | 「当社の本店所在地を管轄する裁判所」(現行どおり) |
| AI 事業者の正式名称・所在地・保存期間・学習利用の有無 | `consent-config.ts:23-31` の弁護士への宿題 | 画面に出す呼び名と国だけ (同意画面と同じ)。保存は「事業者ごとに異なり、各事業者の規約に従う」 |
| 施行日 (`effectiveDate`) | 公開 (デプロイ) 日に合わせる | 実装では仮の施行日 `'2026-10-19'` (本書 v1.4 の日付。YYYY-MM-DD の形の実在する日付) を置き、同じ行に目印のコメント `仮置き: マージ直前に公開日へ置き換える` を付ける。オーケストレーターがマージ直前に公開日へ置き換え、目印を消す (§9.1・§9.4 の 3) |
| 認定個人情報保護団体への加入の有無 | 未確認 | 書かない (§18) |
| 本番の Supabase のリージョン | cross/07 §5.1 は東京 (hnd1) と書くが、本番の実体は本書で未確認 | 「主に日本国内のデータセンター」とは書かず、委託先の所在国 (事業者の本拠) だけを書く (§7 §7) |
| 個人情報の取扱いの責任者 | 公開の画面に記載が無い (現行 `/privacy` の窓口の見出しは「個人情報担当」だけ) | 書かない (窓口は「個人情報担当」のまま。Q-20) |
| 人的な安全管理措置 (従業者の教育・守秘) | 製品の挙動に当たらず、根拠が無い | 書かない。決まったら第11条に足して版を上げる (Q-20) |

### 0.7 読み方

- §1〜§3 が外形 (目的・現行の事実・法令)。§4 構想とトレース → §5 構造裁定 → §6〜§17 が仕上げ。実装者は §6〜§17 だけ読めば手を止めない。
- 正典の TS は §6・§7・§8・§9 の ```ts ブロック。§8.1 (型と定数) と §9.1 (版) は単独で型検査を通る。§6・§7・§8.2・§8.3 は新設モジュール同士の import を持つので、1 行目を `// tsc:skip` にし 2 行目に `// place=<パス>` を書く。実装者はその置き場所に置いてリポジトリ全体で `tsc` に掛ける。
- 既存の設計書との食い違いは本冊が正。追随の行は §17。

章構成テンプレート (`docs/design/CLAUDE.md` の「章構成テンプレート」§1〜§9) との対応。本書は A 型設計ゲートの 4 相 (外形固定 → 構想 → 構造裁定 → 仕上げ) の順に章を並べたので番号がずれる。テンプレートの各章の中身は次の場所にある。

| テンプレートの章 | 本書の場所 | 備考 |
|---|---|---|
| 1. 目的・スコープ | §1 | 対象外も §1 |
| 2. 関連要件 | §2 (関連する設計と現行の事実)・§0.2 (要件行列)・§3 (法令) | |
| 3. データモデル | **該当なし** | DB の変更は無い (テーブル・列・RLS・Storage・migration を足さない・変えない。§15 の最後の行)。文面が参照する既存のテーブルは §2.2 と §10 に挙げた |
| 4. API 仕様 | **該当なし** | 新しい API・route・エラーコードは無い (§15・§12)。版を上げたときに動く既存の API (`/api/legal/status`・`/api/legal/accept`・同意の許可リスト) は §4.2・§9.2 で参照だけする |
| 5. シーケンス | §4.2 (版を上げてデプロイした後の動きの図)・§4.3 (シナリオのトレース)・§9.2・§9.4 (公開の手順) | 図は Mermaid ではなくテキストの木で書いた (分岐が 1 段で、文字の図で読めるため) |
| 6. エラーハンドリング | §12 | 既存のエラーだけ (足さない) |
| 7. テスト方針 | §13 (テスト一覧)・§14 (段分けと変異試験)・§16 (既存の番兵の追随) | |
| 8. 既存実装との関連 (保持・削除・新規) | §2.2 (現行の事実)・§11.2 (状態比較表: 現行 vs 設計後)・§15 (新設一覧と既存ファイルの変更)・§16・§17 | 削除するファイルは無い (2 ページは同じパスで中身を差し替える) |
| 9. 未解決事項 | §18 | |

---

## 1. 目的・スコープ

- `/terms` (利用規約) と `/privacy` (プライバシーポリシー) の本文を、製品の実際の動きと法令に合わせて作り込み、版を上げて既存の再同意の仕組みで利用者に同意し直してもらう。
- 対象外: 同意の仕組みそのもの (13a・13b・14)・AI の同意の文面 (`AI_CONSENT_COPY`) と版・保護者の同意書・特商法の表記・Cookie 同意バナーの実装 (使っていないので不要。§7 §10)・30 日前のメール通知 (cross/08 §7.2 で未実装のまま)・運営による代理削除 (cross/08 §16.5)。

---

## 2. 関連要件・既存設計・現行の事実

### 2.1 関連要件・既存設計

| 文書 | 使う箇所 |
|---|---|
| cross/08-legal-compliance.md | §3 特商法の確認画面・§4 外国第三者提供 (実装メモ)・§7 再同意・§8 医療免責・§12 Cookie (未実装)・§13 PII フィルタ・§14 AI 生成物の著作権・§16 退会・§19 未解決 |
| cross/13a・13b | 同意ゲートの `/api` の許可リスト (`LEGAL_CONSENT_EXEMPT_API_PATHS`)・モバイルの WebView のゲート |
| cross/14-parental-consent.md | 年齢の境 (13・18)・保護者の同意とのつながり・同意画面の文 |
| cross/15-data-subject-requests.md | 請求の種類・本人確認・応答期限 (§12)・退会との関係 (§4.4)・凍結中の経路 (S-13) |
| cross/16-auth-history-sessions.md | ログイン履歴 90 日・セッション 30 日・新しい端末の通知 |
| cross/17-backup-automation.md | バックアップの層と保持 (§9.1)・R2・age の暗号化・GitHub Actions |
| cross/19-private-photo-buckets.md | 写真のバケットの非公開化・署名付き URL |
| billing/01-billing-core.md | Checkout・期間末の解約・退会時の即時解約と顧客の匿名化・アプリ内課金なし |
| org/07・org/10・org/03 | チャレンジは任意・順位は参加者どうし・管理者は集計のみ |
| family/01・08 | 共有設定 (`share_meals` / `share_health` / `share_menu`)・家族の食事の閲覧 |
| docs/design/CLAUDE.md・cross/CLAUDE.md | 章構成・日本語・RLS・監査ログ |

### 2.2 現行の事実 (origin/main `5b85bb3f`、2026-10-19)

| # | 事実 | 出どころ |
|---|---|---|
| F-1 | `/terms` は第 1〜9 条 (適用・利用登録・ID 管理・AI 解析・禁止事項 5 項・提供停止・免責・変更・準拠法)。料金・凍結・退会・家族・組織・未成年・知的財産・再同意・医療免責・問い合わせ先が無い | `src/app/terms/page.tsx:30-66` |
| F-2 | `/privacy` は第 1〜7 条。保存期間・委託先・安全管理措置・外国の制度の情報・要配慮の同意・請求の手続・退会後の扱いが無い。AI 事業者の一覧は `AI_CONSENT_PROVIDERS` から出す (`data-testid="privacy-ai-providers"`) | `src/app/privacy/page.tsx:34-78, 56-68` |
| F-3 | 版・施行日はページの `<main>` の先頭に `LegalDocumentMeta` で出す。両文書とも `v2025.1` / `2025-01-01` の仮置き | `src/components/legal/LegalDocumentMeta.tsx`・`packages/shared/src/legal-versions.ts:39-42` |
| F-4 | 事業者名 `株式会社MHD医健`・代表者・`DISCLOSED_ON_REQUEST`・問い合わせ先 `getSupportEmail()` | `src/lib/business-info.ts:13-22`・`src/lib/site-config.ts:148-156` |
| F-5 | 同意ゲート: 画面は middleware が `/legal-consent` へ、`/api` は 403 `LEGAL_CONSENT_REQUIRED` (許可リストあり)、モバイルは WebView 1 枚。本番は強制 on | cross/08 §7.2・`packages/shared/src/legal-consent-api.ts:88-110` |
| F-6 | 同意画面: 改定時の導入文 `introReconsent`・「改定あり」の印・「同意しない（ログアウトする）」・請求画面へのリンク | `packages/shared/src/legal-consent-copy.ts:8-28`・`src/app/legal-consent/LegalConsentForm.tsx:338-395, 456` |
| F-7 | プッシュ通知の送信側は、同意の強制が on のとき、同意済みの版が古い利用者へ送らない (`consent_outdated`)。判定は版だけで、保護者の同意とのつながりは見ない。凍結は版より先に `account_frozen` で止める | `src/lib/push/outbox.ts:53-54, 245-259` |
| F-8 | AI 事業者 5 社 (xAI・Google・OpenAI・Perplexity = アメリカ合衆国、AI/ML API = エストニア)。未同意なら送る手前で 403 `AI_CONSENT_REQUIRED`。同意は `external_data_consents` に版・IP・User-Agent つきで記録。撤回は `/settings/ai-consent` | `src/lib/ai/consent-config.ts:12-14, 85-116`・`supabase/functions/_shared/ai-consent.ts:21-56`・`src/app/api/ai/consent/route.ts:113-114` |
| F-9 | AI の 1 日の上限: `ai_daily_limits` (free = 10 回の初期値。運営画面で変えられる)・翌日 0 時 JST に戻る・究極モードの機能別上限・自動処理の安全弁 | `supabase/migrations/20261011020000_ai_daily_limits.sql:80-81`・`supabase/functions/_shared/ai-daily-limit.ts:38-66` |
| F-10 | 未成年: 18 歳未満は本人登録不可、13 歳未満の本人アカウント無し、保護者の同意書 `/legal/parental-consent`、つながりが切れたら退会のみ | `packages/shared/src/parental-consent.ts:12-18, 118-140` |
| F-11 | 退会は即時削除 (取り消し不可)。公開レシピは匿名化して残す。Stripe は即時解約・顧客の匿名化。削除の記録は id の HMAC。バックアップは daily 30 日・weekly 366 日・annual 2,557 日 | cross/08 §16.1-16.4・cross/17 §9.1 (行 159-161) |
| F-12 | 書き出し `GET /api/account/export` は 52 表を JSON で返す。凍結中も退会・書き出し・有料プランの解約 3 本・お問い合わせの送信は通る | `src/lib/account-export-tables.ts`・`src/lib/auth/frozen.ts:34-42`・cross/08 §16.2 |
| F-13 | 開示等の請求: 種類は開示・訂正・利用停止・消去。本人確認は登録メールのリンク (24 時間・送信は 5 回まで)。応答期限は本人確認から 30 日 (既定。環境変数 `DSR_RESPONSE_DUE_DAYS`)。凍結中は `/contact` | `src/lib/data-subject-requests/core.ts:8-9, 36-44`・cross/15 §12・S-13 |
| F-14 | 隠した投稿は 90 日で消す (`HIDDEN_CONTENT_RETENTION_DAYS`)。ログ (`app_logs`) 30 日。ログイン履歴 90 日・セッション無操作 30 日。送信待ち (メール・プッシュ) は送れた行 7 日・失敗 30 日 | `src/lib/admin/hidden-content-restore.ts:26`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:1120`・`src/lib/auth/sessions/constants.ts:12, 16`・`supabase/migrations/20261016234000_email_outbox.sql:271-272`・`20261016237000_push_outbox.sql:258-259` |
| F-15 | 外部送信: ブラウザから直接 Supabase (`*.supabase.co`。認証・データの読み書き・写真の署名付き URL)・Vercel Speed Insights (同一オリジン `/_vercel/speed-insights/*`。URL のクエリ・トークンを消してから送る)・Cloudflare Turnstile (ログイン・登録・メール確認・パスワード再設定)・Stripe Checkout・Google OAuth・祝日の一覧 (週間献立 `/menus/weekly` がブラウザから `HOLIDAYS_API_ORIGIN` = `https://holidays-jp.github.io` の `/api/v1/<年>/date.json` を取得。送るのは年だけ。GitHub Pages に端末の IP とブラウザの情報が渡る)。PostHog・GA は不採用。フォントは `next/font` でビルド時に取り込む (実行時に Google へ送らない)。ログイン画面の背景の画像 (`images.unsplash.com`) は `next/image` の最適化 (`/_next/image`) を通り、ブラウザは Unsplash へ直接取りに行かない。アプリの更新の取得 (EAS Update) は無効 (`updates.enabled: false`・`checkAutomatically: "NEVER"`。`expo-updates` を呼ぶコードも無い) | `src/lib/speed-insights-scrub.ts:1-20`・`src/lib/auth/turnstile-verify.ts:22`・`src/app/layout.tsx:2`・`src/__tests__/lib/security/csp.test.ts:264-272`・`src/lib/security/csp.ts:30-34, 103`・`src/app/(main)/menus/weekly/_state/japaneseHolidays.ts:7-8`・`src/app/(main)/menus/weekly/page.tsx:427`・`src/app/(auth)/layout.tsx:15`・`next.config.mjs:95-103`・`apps/mobile/app.json:68-72` |
| F-16 | 委託先: Supabase (認証・DB・Storage・Edge Functions)・Vercel (ホスティング)・Resend (メール)・Stripe (決済)・Upstash (Redis。回数制限のカウンタ。キーは利用者 ID / IP / 宛先のハッシュ)・Expo (プッシュ送信 `exp.host`)・Cloudflare (Turnstile・R2 のバックアップ)・GitHub (Actions がバックアップを実行)・Google (OAuth) | `src/lib/rate-limit.ts:17-31`・`src/lib/push/expo-transport.ts:14-15`・`src/lib/emails/outbox.ts`・`.github/workflows/db-backup.yml`・`src/app/(auth)/login/page.tsx:78-83` |
| F-17 | 端末とログ (IP・User-Agent を持つ表の全体は F-37): `user_sessions_metadata` に IP の全体 (`ip_address`。トリガー `auth_session_created` は `NEW.ip` をそのまま入れ、Web の route も受け取った IP をそのまま上書きする)・そのネットワーク (`ip_network`。IPv4 は /24、IPv6 は /48。`ip_address` とは別の列)・国 (`country_code`。Web のログインで Vercel のヘッダ `x-vercel-ip-country` から取る)・User-Agent・端末名。IP の全体と国は、本人の画面 (`/settings/security/sessions` のセッションとログイン履歴)・新しい端末の通知メール・運営の画面 (`/admin/users/[id]` のログイン履歴) に出る。CSP 違反の報告に User-Agent。お問い合わせは `x-forwarded-for` を回数制限のキーに使う。規約・ポリシーの同意の記録 (`terms_acceptances`) には、版と日時に加えて、サーバーが受け取った通信の IP (`extractClientIp`) と User-Agent (512 文字まで) を残す (`POST /api/legal/accept` が `p_ip`・`p_user_agent` で `accept_legal_documents` に渡し、関数が `terms_acceptances` の `ip_address`・`user_agent` に入れる)。`route.ts:19` の「IP・user_agent は残さない」は成功時のログの話で、記録の話ではない。`terms_acceptances` は退会で `ON DELETE CASCADE` により消える | `supabase/migrations/20261016243000_auth_history_sessions.sql:19-40, 56, 79-84`・`src/lib/auth/sessions/request-context.ts:3-15`・`src/lib/auth/sessions/web-login-context.ts:42`・`src/lib/auth/sessions/store.ts:141-144`・`src/app/(main)/settings/security/sessions/page.tsx:106-107, 146-147`・`src/lib/emails/account/login-new-device.ts:27-37`・`src/app/api/admin/users/[id]/login-history/route.ts:45-46`・`src/app/admin/users/[id]/page.tsx:142`・`src/app/api/csp-report/route.ts:11, 43`・`src/app/api/legal/accept/route.ts:19, 116-125`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:513-514`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:9408` (`terms_acceptances_user_id_fkey` の `ON DELETE CASCADE`) |
| F-18 | 家族: `family_members.share_meals` (既定 true)・`share_health` (既定 false)・`share_menu` (既定 true)。食事の閲覧は `can_view_user_meals` の RLS (`share_meals = TRUE` を見る)、献立は #1584 の関数 (`share_menu = TRUE` を見る)。健康の記録 (`health_records`・`health_checkups`・`blood_test_results`) の SELECT の RLS は本人だけで、`share_health` を読む RLS・関数・API は無い (設定の画面で切り替えられるだけ。家族に健康の記録を見せる経路は無い) | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:124-126, 951, 10008, 10016, 10038, 10568`・`20261016241000_family_menu_view_functions.sql:42` |
| F-19 | 組織: 組織の管理者の画面が読むのは次だけ。(1) メンバーの表示名・組織内の役割・参加日 (`/org/members` が `user_profiles` を `select('id, nickname, org_role, joined_org_at')`。ただし `user_profiles` の SELECT の RLS は本人の行だけなので、いまは他のメンバーの行は返らない)。(2) 招待 (招待先のメールアドレス・役割・部署・承諾の有無・期限。RLS `org_invites_select_admin`)。(3) 部署の名前と部署ごとの人数 (人数は service_role で数えて数だけ返す)。(4) 組織のメンバー数 (`GET /api/org/stats`。活力スコアなどの組織の集計と部署別の表示は止めている)。(5) チャレンジの参加人数と平均 (参加者が `ORG_CHALLENGE_MIN_PARTICIPANTS` 人に満たないときは出さない。個人の値は返らない)。社員番号の列はどこにも無い (`supabase/migrations`・`src`・`packages/shared/src/database.types.ts` で `employee_id`・`employee_number` が 0 件)。登録したメールアドレス・最終ログイン・ライセンスの状態は組織の画面に出ない (最終ログインを出すのは運営の画面 `admin/users/[id]`・`support/users` だけ)。`GET /api/org/members` は画面から呼ばれておらず、同じ RLS で本人の行しか返らない。組織への参加 (`accept_org_invite`) は組織ごとの人数の枠 (`org_license_pools.used_licenses`) を 1 つ使い、部署は招待の行にだけ持つ (`user_profiles.department_id` を書く処理は無い)。チャレンジは任意・順位は参加者どうし・名前の表示は環境変数 `ORG_CHALLENGE_SHOW_NAMES` で既定 off | `src/app/(org)/org/members/page.tsx:52`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:10076` (`Users can view own profile`)・`src/app/api/org/invites/route.ts:39-50`・同 migration `:10644` (`org_invites_select_admin`)・`src/app/api/org/departments/route.ts:78-90`・`src/app/api/org/stats/route.ts:29`・`src/app/(org)/org/dashboard/page.tsx:5-6, 64`・`src/app/api/org/challenges/route.ts:89-118`・`src/app/api/org/members/route.ts:22-23`・`supabase/migrations/20261017160000_org_invite_same_org_member.sql` (`accept_org_invite` の最新の定義。`used_licenses` を 1 足す)・`src/lib/org-challenges.ts:115-128` |
| F-20 | 凍結: `/frozen` に「利用規約違反等の理由により凍結」「一時的な凍結は解除予定日時の経過後に自動的に回復」「凍結中でもデータの書き出しと退会、有料プランの解約はできます」 | `src/app/frozen/page.tsx:48-56` |
| F-21 | 代表者・オーナーが 30 日以上ログインしていない (または削除済みの) 家族グループ・組織を、運営の一覧に出す。判定は RPC `list_families_with_inactive_representative`・`list_orgs_with_inactive_owner` の `au.last_sign_in_at < NOW() - INTERVAL '30 days'` で、画面の見出しも「30日以上未ログインまたは削除済みアカウント…」。運営はこの一覧から譲渡・解散を行う (操作の RPC `operator_force_*` そのものは日数を見ず、理由を付けて行う)。「90日以上未ログイン」は解散の理由を入れる欄の入力例 (placeholder) にだけある文で、判定ではない | `supabase/migrations/20261017130000_operator_mfa_db_gate.sql:91, 125, 129, 162` (2 つの RPC の最新の定義)・`src/app/(operator)/operator/membership/families/inactive/page.tsx:88` (見出し)・`.../orgs/inactive/page.tsx:92` (見出し)・`.../families/inactive/page.tsx:133`・`.../orgs/inactive/page.tsx:137` (placeholder の例文) |
| F-22 | プロフィールに病歴・服薬・妊娠の有無・健康診断の結果の欄がある (要配慮個人情報に当たりうる) | `supabase/migrations/20251126124224_create_meal_planner_tables.sql` の `user_profiles` (`health_conditions`・`medications`・`pregnancy_status`・`health_checkup_results`) |
| F-23 | 公開ページの禁止語の走査 (`FORBIDDEN`) の対象に `/terms` `/privacy` は入っていない。事業者名の走査は入っている (「株式会社〇〇」「〇〇 Inc」を拾う) | `tests/public-claims-guard.test.ts:79-110`・`tests/business-info-legal-pages.test.ts:96-103` |
| F-24 | 利用者向けの「ログイン中の端末・ログイン履歴」の画面 (`/settings/security/sessions`) があり、ログイン履歴・セッションの一覧と失効 (cross/16) がそこにある。設定画面のボタン (`settings-sessions-link`) から開く。パスの定数は `SESSIONS_SETTINGS_PATH`。`/settings/security` そのものの画面は無い (`settings/security/` の下は `mfa/**` と `sessions/` だけ。リダイレクトも無い)。コンテンツの通報の機能は無い | `src/lib/emails/account/login-new-device.ts:18`・`src/app/(main)/settings/page.tsx:409-410`・`src/app/(main)/settings/security/sessions/page.tsx`・`src/app/api` に report 系 route 無し |
| F-25 | 端末の機能: アプリはカメラと写真ライブラリを `expo-image-picker` で使い、撮影・選択は利用者の操作のときだけ (`mediaTypes: ["images"]`)。Web も `<input type="file" capture="environment">` でブラウザのカメラを使う。通知は利用者が許可したときだけ。端末の名前は機種名と OS の版だけ (利用者が付けた名前は使わない)。位置情報・連絡先・録音のコードは無い (`expo-location`・`geolocation`・`expo-contacts`・`getUserMedia`・`MediaRecorder` が 0 件)。一方で `app.json` は使っていない宣言 (iOS の `NSPhotoLibraryAddUsageDescription`、Android の `RECORD_AUDIO`・`WRITE_EXTERNAL_STORAGE`) を持つ | `apps/mobile/package.json:30`・`apps/mobile/app.json:23-25, 34-41`・`apps/mobile/app/health/blood-tests.tsx:245-264`・`src/app/(main)/meals/new/page.tsx:1377`・`apps/mobile/src/lib/pushNotifications.ts:261-264`・`apps/mobile/src/lib/device-name.ts:25-26` |
| F-26 | AI 事業者への提供の記録に当たるものは `external_data_consents` (事業者・同意の有無・日時・IP・User-Agent・撤回日時・`policy_version`) だけ。送るたびの記録は無い (`ai_usage_counters` は回数だけ)。この表は書き出しに含まれ、退会で `ON DELETE CASCADE` により消える | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:4672-4681, 8868`・`20261010090000_ai_consent_policy_version.sql:57`・`src/lib/account-export-tables.ts:244` |
| F-27 | 仮名加工情報・匿名加工情報を作るコードは無い (`src`・`lib`・`packages`・`supabase` で「仮名加工」「匿名加工」が 0 件)。運営の集計は個人を特定しない数値だけ | origin/main の `git grep` (2026-10-19)・F-19 |
| F-28 | 判定の順: `/api` は 凍結 (403 `AUTH_ACCOUNT_FROZEN`) → メンテナンス (503) → 同意 (403 `LEGAL_CONSENT_REQUIRED`)。画面は メンテナンス → 凍結 (`/frozen` へ。`/frozen`・`/contact`・`/auth/*`・`/terms`・`/privacy` は除く) → 同意 (`/legal-consent` へ)。凍結中は `/legal-consent` にも `POST /api/legal/accept` にも届かない | `lib/supabase/middleware.ts:196-197, 223-249, 262-283, 356-365, 370-402, 404-436` |
| F-29 | AI 事業者へ送るプロンプトには、同意画面の 6 項目 (`AI_CONSENT_COPY.dataCategories`) より広い項目が入る: ニックネーム (自由入力で、実名が入りうる)・年齢・性別・身長・体重・体脂肪率・目標・持病・服薬・妊娠/授乳の状況・アレルギーと好み・宗教上の制限・職業・業界・勤務形態・睡眠・ストレス・便通・飲酒・喫煙・家族の人数と子どもの年齢・調理と買い物の習慣・食費の予算・趣味など。メールアドレス・氏名を送らないことは、本書では確かめていない (言い切らない) | `supabase/functions/_shared/user-context.ts:363-377`・`src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts:284-356`・`src/lib/ai/consent-config.ts:126-133` |
| F-30 | 保護者の同意の記録 (`parental_consents`) は、署名した氏名・保護者であることの確認・署名時点の子どもの生年月日と年齢・日時・IP アドレス・User-Agent を持つ。署名した保護者が退会しても `parent_user_id` が `ON DELETE SET NULL` で外れるだけで行は残る。家族グループの行が消えると `ON DELETE CASCADE` で消える。宛先停止リスト (`email_blacklist`) は、苦情・バウンスのあったアドレスへ再送しないために、退会でも伏せない (生のアドレスが残る) | `supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:90-102`・cross/08 §16.3 (送信ログの行) |
| F-31 | 運営は `/admin/announcements` でお知らせを書け、公開 (`is_public`) のお知らせは Web とアプリのホームに出る (`GET /api/announcements?mode=public`)。`/news` の一覧はコードの中の空の配列で、運営画面からは載らない | `src/app/admin/announcements/page.tsx`・`src/app/api/announcements/route.ts:27-49`・`src/hooks/useHomeData.ts:307-311`・`apps/mobile/src/hooks/useHomeData.ts:364-367`・`src/app/news/page.tsx` (`const news: readonly NewsItem[] = []`) |
| F-32 | 未同意の人が画面で開けるのは、同意ゲートの対象外のパス (認証・`/terms`・`/privacy`・`/legal-consent`・`/settings/data-requests`・`/legal`・`/contact`・`/frozen`・`/handson-tour`) だけ。設定 (`/settings`。退会と書き出しの画面) と `/account/billing` (解約の画面) は同意画面へ回る。同意画面で「同意しない」を選んだ後に出るのは、お問い合わせからのデータの削除の依頼 (「ご本人であることを確認のうえ、アカウントと保存されているデータを削除します」) と、請求の画面へのリンクだけ。退会のボタンは 18 歳未満の案内 (`minor_refused` / `guardian_missing`) にしか出ない。有料プランの解約を運営が行うコードの経路 (運営の API・画面) は無い (`src/app/api/admin`・`src/app/api/operator` に billing の解約の route が無い。運営による解約は決済代行事業者の管理画面で行う運用になる。Q-21)。凍結中の人は `/frozen` から `/frozen/account` (退会・書き出し) と `/frozen/billing` (解約) を開ける (`/frozen` 以下は同意ゲートの対象外 (`EXEMPT_PREFIXES`) だが、凍結されていない人を `/frozen` へ案内する画面は無い) | `lib/legal-consent.ts:91-124`・`src/app/legal-consent/LegalConsentForm.tsx:200-217, 270-283, 284-318`・`src/app/frozen/page.tsx:9-10, 59-76` |
| F-33 | 写真 (食事・冷蔵庫) は家族にも組織にも経路が無い (家族の献立は `image_url` を返さない。署名 API は持ち主以外に null)。運営 (admin / super_admin / content_moderator) は審査 API の署名付き URL で閲覧できる。代わりに記録できるのは本人のアカウントが無い子どもの行 (`role = 'child'`・`user_id` が NULL) だけ。本人のアカウントをつないだ 13〜17 歳は、つなぐときに `share_meals` / `share_health` / `share_menu` を自分で選ぶ | cross/19 §6.1 (行 283・286)・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:133`・docs/design/family/01-data-model.md:347-348・cross/14 §11 の表 (`accept_child_promotion(p_token, p_share_meals, p_share_health, p_share_menu)`) |
| F-34 | 通知とメール: 利用者が変えられる通知の設定 (`notification_preferences`) は `notifications_enabled`・`auto_analyze_enabled`・`data_share_enabled` の 3 つだけで、`notifications_enabled` を読むのはプッシュの送信だけ (切っているとどの種類のプッシュも `notifications_disabled` で送らない)。メールを止める設定は無い (`src`・`supabase/migrations`・`apps/mobile` に 0 件)。送るメールは、アカウント (退会の完了・新しい端末からのログイン)・開示等の請求・家族と組織の招待とお知らせ・お問い合わせへの返信と、認証 (Supabase Auth の確認・パスワードの再設定) で、宣伝のメールの仕組みは無い。メールの送信を止めるのは苦情とバウンスの停止リスト (`email_blacklist`) だけ。改定を知らせる一斉メールの仕組みも無い (cross/08 §7.2 の 30 日前のメール通知は未実装。§1 の対象外) | `src/app/api/notification-preferences/route.ts:17-21, 73`・`src/lib/push/outbox-store.ts:29, 72, 87`・`src/lib/push/outbox.ts:260`・`src/lib/emails/account/`・`src/lib/emails/dsr/`・`src/lib/emails/membership/`・`src/lib/emails/support/`・`src/lib/emails/suppression.ts` |
| F-35 | 運営の多要素認証: 必須にするロールは `MFA_REQUIRED_ROLES = ['super_admin', 'admin', 'finance', 'org_industrial_doctor']` だけで、`support`・`sales`・`content_moderator`・`org_admin` は対象外。写真を審査 API で見られる `content_moderator` (F-33) にも多要素認証は要らない。必須のロールでも、猶予の開始日時 (環境変数 `OPERATOR_MFA_ENFORCE_FROM`) を設定しているとその日時までは未登録で通る (`pass_grace`)。未設定なら猶予なし (即時)。本番の値は本書では確かめていない (環境変数の値を読まない。Q-25) | `src/lib/auth/mfa/policy.ts:12-18, 97-105, 140-149` |
| F-36 | お問い合わせとサポートの記録: 退会の直前の `prepare_account_deletion` は `inquiries` の `email` を `redacted@redacted.invalid` に置き換えるだけで、件名 (`subject`)・本文 (`message`)・運営のメモは残す。`inquiries.user_id`・`support_tickets.user_id`・`support_ticket_messages.sender_id` は `ON DELETE SET NULL` で紐づけだけが外れ、チケットの件名とメッセージの本文は残る。これらを期限で消す処理は無い | `supabase/migrations/20261016234000_email_outbox.sql:468-472` (`prepare_account_deletion` の最新の定義の `inquiries` の段)・`20251126124224_create_meal_planner_tables.sql:5105-5119` (`inquiries` の列)・`:9023` (`inquiries_user_id_fkey`)・`20261010000100_auth_users_fk_on_delete.sql:186-194` (`support_tickets`・`support_ticket_messages` の `SET NULL`) |
| F-37 | IP・User-Agent を持つ表 (`packages/shared/src/database.types.ts` の `public` の表のうち、`Row` に `ip_address`・`ip_network`・`user_agent`・`country_code` の列があるもの) は 8 つ: `user_sessions_metadata` (ログインの履歴。F-17)・`terms_acceptances` (規約・ポリシーの同意。F-17)・`external_data_consents` (AI の同意。F-8)・`parental_consents` (保護者の同意。F-30)・`admin_audit_logs` (運営の操作の記録。入るのは操作した運営担当者の IP で、利用者の IP ではない)・`cookie_consents` (書き込む処理が無い。Cookie の同意のバナーは未実装)・`failed_invite_lookups` (書き込む処理が無く常に空。掃除のジョブも置いていない)・`catalog_sources` (`country_code` は商品の情報の出どころの国で、個人の情報ではない)。プライバシーポリシー第3条に載せるのは前の 4 つ | `packages/shared/src/database.types.ts` (`terms_acceptances` は `:6974-6983`)・`src/lib/admin/audit.ts:20-39, 147-148`・`src/lib/account-export-tables.ts:243` (`cookie_consents` は書き出しの表に名前があるだけ)・`docs/design/operator/08-cron-batches.md:87, 157`・`tests/log-cleanup-dau-snapshot-contract.test.ts:213-214` (`failed_invite_lookups` に書き込む処理が無い)・`src`・`supabase` に `INSERT INTO … cookie_consents` / `failed_invite_lookups`・`.from('cookie_consents')` / `.from('failed_invite_lookups')` が 0 件 |

---

## 3. 法令の要件と、文面への当てはめ

一次資料は、個人情報保護委員会 (PPC) のガイドライン (通則編・外国にある第三者への提供編)・総務省の外部送信規律のページ・e-Gov の条文と、下の §3.1 の表の資料を参照した (2026-10-19 に WebSearch / WebFetch で日本語と英語の両方で確認)。§3.2 の表の「法令」の列の「出典 L-n」は、その行の出典が §3.1 のどれかを示す (L-n の無い行は L-6)。**当てはめは弁護士の確認を前提にする** (§18)。

### 3.1 法令の一次資料 (出典)

条文の正本は e-Gov 法令検索 (法令番号で引く)。e-Gov の条文のページは本書の確認の道具 (WebFetch) では本文が描かれなかったので、条文の文言は政府の日本法令外国語訳データベース (Japanese Law Translation。日本語の原文と英訳を並べて載せる) で確かめ、所管の省庁の公式のページで制度の位置づけを確かめた。

| # | 法令 (法令番号) | 確かめた資料 (日本語・英語) | 確かめたこと |
|---|---|---|---|
| L-1 | 消費者契約法 (平成12年法律第61号。最終改正 令和4年法律第59号) | 消費者庁「消費者契約法」(`https://www.caa.go.jp/policies/policy/consumer_system/consumer_contract_act/`。逐条解説へのリンクがある)・Japanese Law Translation "Consumer Contract Act" (`https://www.japaneselawtranslation.go.jp/en/laws/view/4431/je`。日英対訳) | 8 条 1 項 1〜4 号 (全部免除・故意重過失の一部免除の無効)・8 条 3 項 (軽過失の一部免除は、故意・重過失を除く過失にだけ適用されることを明らかにしていなければ無効)・8 条の 2 (解除権の放棄の無効)・9 条 1 項 (平均的な損害を超える違約金・年 14.6% を超える遅延損害金の無効)・10 条 (信義則に反して消費者の利益を一方的に害する条項の無効) |
| L-2 | 不当景品類及び不当表示防止法 (景品表示法。昭和37年法律第134号) | 消費者庁「景品表示法」(`https://www.caa.go.jp/policies/policy/representation/fair_labeling/`)・Japanese Law Translation "Act against Unjustifiable Premiums and Misleading Representations" (`https://www.japaneselawtranslation.go.jp/en/laws/view/2888`) | 品質・内容を実際より著しく優良と示す表示 (優良誤認) の禁止 (不当な表示の禁止の条。令和5年の改正後の条番号は 5 条) |
| L-3 | 健康増進法 (平成14年法律第103号) | 消費者庁「健康増進法 (誇大表示の禁止)」(`https://www.caa.go.jp/policies/policy/representation/extravagant_advertisement/`)・同ページの「健康食品に関する景品表示法及び健康増進法上の留意事項について」(令和4年12月5日一部改定) | 65 条 1 項: 健康の保持増進の効果などについて、著しく事実に相違し、または著しく人を誤認させる表示の禁止。景品表示法と並んで適用される。特定の言葉で一律に決まらず、表示全体で判断される |
| L-4 | 医薬品、医療機器等の品質、有効性及び安全性の確保等に関する法律 (薬機法。昭和35年法律第145号) | 厚生労働省「医薬品等適正広告基準」(昭和55年10月9日薬発第1339号。平成29年9月29日に改正。改正の日付は検索結果の要約で確かめたもので、通知の本文は本書では読めていない) | 66 条 (医薬品等の名称・効能・効果について虚偽・誇大な広告の禁止。医師などが保証したと誤解させる記事も同じ)・68 条 (承認前の医薬品等の名称・効能・効果の広告の禁止)。本サービスは医薬品等ではないが、食事や健康の記録について「治る」「予防できる」とうたうと医薬品的な効能の標榜と見られうる |
| L-5 | 特定商取引に関する法律 (特定商取引法。昭和51年法律第57号) | 消費者庁「通信販売の申込み段階における表示についてのガイドライン(案)に関する意見募集について」(2021-11-24。`https://www.caa.go.jp/notice/entry/026648/`) | 11 条 (通信販売の広告の表示)・12 条の 6 (申込みの最終確認画面での表示。令和3年法律第72号で新設)。消費者庁の特定商取引法ガイドのサイトは本書の確認の時点で引けなかった (名前の解決に失敗) |
| L-6 | 個人情報の保護に関する法律 (平成15年法律第57号)・電気通信事業法 (昭和59年法律第86号)・民法 (明治29年法律第89号) | PPC のガイドライン (通則編・外国にある第三者への提供編) と外国の制度の調査結果・総務省の外部送信規律のページ・e-Gov の条文 (v1.0 の時点で参照) | 下の表の該当行 |


### 3.2 要件と、文面への当てはめ

| 法令 | 要件 | 文面での対応 (§6 = 利用規約、§7 = プライバシーポリシー) |
|---|---|---|
| 個人情報保護法 17 条 1 項 | 利用目的をできる限り具体的に特定 (「事業活動に用いるため」では足りない) | §7 §4 に機能ごとの目的を列挙 |
| 同 18 条 | 目的外利用の禁止 | §7 §4 末尾 |
| 同 20 条 2 項 | 要配慮個人情報は本人の同意を得て取得 (例外あり) | §7 §5: 健康の記録・病歴等は本人が自ら入力・撮影する操作をもって同意を得る旨を明示 |
| 同 21 条 | 取得時の利用目的の通知・公表。本人から直接書面等で取得するときは明示 | §7 全体を公開し、登録時に同意画面で明示 |
| 同 23 条・32 条 1 項 4 号・施行令 10 条 1 号 | 安全管理措置を講じ、その内容を本人の知り得る状態に置く (基本方針・規律・組織的・人的・物理的・技術的・外的環境の把握) | §7 §11 (実装に当たる措置だけ) |
| 同 25 条 | 委託先の監督 | §7 §7 末尾 |
| 同 27 条 1 項・5 項 | 第三者提供は同意。委託・事業承継・共同利用は第三者に当たらない | §7 §8 (共同利用はしない・オプトアウト提供はしない) |
| 同 28 条 1 項・2 項・規則 17 条 | 外国にある第三者への提供は、国名・その国の制度の情報・提供先の措置の情報を示して同意。指定国 (EU・英国) と基準適合体制の例外 | §7 §6 (AI 事業者: 国名・制度の情報・措置の情報・同意の撤回)・§7 §7 (委託先: 基準適合体制の整備と、規則 18 条 3 項の求めに応じた情報提供) |
| 同 32 条 1 項 | 事業者の名称・住所・代表者、利用目的、請求の手続、苦情の申出先 | §7 §1・§4・§14・§17 (住所は請求時開示。§18 で確認) |
| 同 29 条・規則 19〜21 条 | 第三者提供の記録の作成と保存 (本人の同意による提供では、同意の記録などで代えられる場合がある) | §7 §6 の 5 (AI 事業者への提供の記録 = 同意の記録 (F-26))。保存の期間と退会の即時削除の関係は §18 Q-16 |
| 同 33〜35 条・38 条 | 開示 (第三者提供記録を含む。33 条 5 項)・訂正等・利用停止等の請求と手続・手数料 | §7 §14 (手数料は無料)。第三者提供記録の開示は §7 §6 の 5 の記録をもとに行う |
| 同 40 条 | 苦情の適切かつ迅速な処理 | §7 §17 |
| 同 2 条 5 項・6 項・41〜46 条 | 仮名加工情報・匿名加工情報を作成するときは、作成の基準・安全管理・項目の公表など | 作成していない (F-27)。§7 §4 末尾に「作成していない・作成するときは公表して改定する」と書く |
| 電気通信事業法 27 条の 12 | 利用者の端末から外部へ情報を送らせるときは、送る情報の内容・送り先・利用目的を通知または公表 (対象役務に当たる場合) | §7 §10 に表で公表 (対象役務への該当は未確定でも、公表しておく) |
| 消費者契約法 8 条 1 項・3 項・8 条の 2 (出典 L-1) | 損害賠償責任の全部免除・故意重過失の一部免除・解除権の放棄は無効。軽過失の一部免除は、故意・重過失を除く過失にだけ適用されることを明らかにしなければ無効 (8 条 3 項) | §6 第 21 条 (故意・重過失を除く / 軽過失は通常損害に限る / 全部免除にしない)・第 16 条 5 項と第 18 条 4 項 (凍結などの措置・サービスの変更や中断による損害も「第21条に定める範囲で責任を負う」とし、軽過失の責任を全部は免除しない)・第 4 条 (第三者によるログインの手段の使用は、当社に故意または過失がある場合を除き責任を負わない = 当社に過失が無いときだけ)・第 17 条 1 項 (退会はいつでもできる)・第 10 条 4 項 (有料プランの解約はいつでもできる)。どちらも、版を上げた後の同意の前 (設定画面が同意画面へ回る間) は第 24 条 2 項のお問い合わせ (削除・解約の依頼) を手段として示し、解除の手段が無くなる期間を作らない |
| 同 9 条 1 項 (出典 L-1) | 平均的な損害を超える損害賠償の予定・年 14.6% 超の遅延損害金は無効 | 違約金・遅延損害金の条項を置かない |
| 同 10 条 (出典 L-1) | 信義則に反して消費者の利益を一方的に害する条項は無効 | 通知の「到達みなし」を置かない。サービス変更・終了は周知の努力を書く |
| 民法 5 条・120 条 | 未成年者の法律行為は法定代理人の同意が無ければ取り消しうる | §6 第 3・5 条 (18 歳未満は保護者の同意) |
| 民法 548 条の 2〜4 | 定型約款の合意・表示・変更 (同意を得ない変更は、周知と効力発生日が要る) | §6 第 1 条 (定型約款として合意)・第 24 条 (内容が変わる変更は再同意で行い、同意した時からそのユーザーに適用する。同意を得ない変更の定めは置かない。Q-19) |
| 個人情報保護法 20 条 2 項・28 条 2 項 (AI) | 外国にある第三者へ要配慮個人情報を送るなら、送る情報の範囲を示して同意 | §7 §5 の 4・§6 (送る情報にプロフィール・持病・服薬・妊娠/授乳の状況を明記。F-29)。同意画面の文 (`AI_CONSENT_COPY`) の追随は範囲外 (§17・Q-18) |
| 特定商取引法 11 条・12 条の 6 (出典 L-5) | 通信販売の表示・申込み前の確認画面 | §6 第 10 条 (特商法の表記と確認画面を参照) |
| 薬機法 66・68 条 (出典 L-4)・景品表示法 5 条 (出典 L-2)・健康増進法 65 条 1 項 (出典 L-3) | 虚偽誇大な効能・効果の表示、医薬品的な効能の標榜、健康の保持増進の効果の誇大表示の禁止 | §6 第 9 条 (診断・治療・予防を目的とせず、効果を保証しない)。両文書で効果・成果の表現を書かない |

---

## 4. 構想 (相 2)

### 4.1 構造

```
src/lib/legal/
  legal-text.ts        型 (LegalDocumentText / LegalChapter / LegalSection / LegalBlock / LegalTextContext) と、
                       文面が埋める製品の定数の写し (保存期間など。§8.1)
  terms-text.ts        termsText(ctx): LegalDocumentText        ← §6 の全文 (逐語)
  privacy-text.ts      privacyText(ctx): LegalDocumentText      ← §7 の全文 (逐語)
  index.ts             再エクスポート
src/components/legal/LegalDocumentBody.tsx   LegalDocumentText → h2 / h3 / p / ul / table / AI 事業者の ul / リンクの ul (§8.2)
src/app/terms/page.tsx    header・LegalDocumentMeta・<LegalDocumentBody document={termsText(ctx)} />・footer
src/app/privacy/page.tsx  同上 (privacyText)。ctx に AI_CONSENT_PROVIDERS / AI_CONSENT_PROVIDER_INFO から作った一覧を渡す
packages/shared/src/legal-versions.ts   LEGAL_DOCUMENTS を v2026.1 に (§9)
tests/legal-text-1901.test.ts           §13 (文面モジュールとページ)
tests/legal-document-body.test.tsx      §13 (描画部品。T-21〜T-23)
tests/public-claims-guard.test.ts       既存。走査の対象に 2 ページと 2 つの文面モジュールを足す (§16)
src/__tests__/api/cron/push-outbox.test.ts   既存。行 176 の版の直書きを LEGAL_DOCUMENTS に (§16)
docs/legal/archive/v2025.1/{terms,privacy}.md   旧版の控え (段 B)
```

- 文面は**データ** (見出しと段落の配列)。ページは配列を描くだけで文を持たない。文面モジュールは `React` を import しない (サーバーでもテストでも素のまま読める)。
- 文面の中の数 (保存期間・年齢・期限) は、製品の定数を import して埋める (`${HIDDEN_CONTENT_RETENTION_DAYS}日` のように)。文面モジュールに意味のある数を直接書かない。
- 文脈 (`LegalTextContext`) は**ページが組み立てる**。AI 事業者の一覧は `src/app/privacy/page.tsx` が `AI_CONSENT_PROVIDERS` / `AI_CONSENT_PROVIDER_INFO` から作って渡す (既存のテスト `tests/business-info-legal-pages.test.ts:162-167` がページのソースにこの 2 つの識別子があることを検査するため)。
- 版は `LEGAL_DOCUMENTS` の 2 文書を同時に `v2026.1` へ。再同意は既存の仕組みがそのまま動く。

### 4.2 動き (版を上げてデプロイした後)

```
デプロイ (LEGAL_DOCUMENTS = v2026.1)
  ├ Web の画面 GET: middleware (lib/supabase/middleware.ts) が user_profiles.*_version_accepted ≠ v2026.1 を見て
  │     /legal-consent?next=<元> へ (LEGAL_CONSENT_ENFORCE=on)。同意画面は introReconsent + 両文書に「改定あり」
  ├ /api/*: 許可リスト (LEGAL_CONSENT_EXEMPT_API_PATHS) 以外は 403 LEGAL_CONSENT_REQUIRED
  ├ モバイル: LegalConsentProvider が GET /api/legal/status → gaps に 2 文書 → ルートのゲートが WebView の /legal-consent に畳む
  ├ プッシュ通知の cron: decideEligibility が未同意の行を consent_outdated で止める (再同意まで届かない)
  └ 同意: POST /api/legal/accept { terms_version: v2026.1, privacy_version: v2026.1 } → accept_legal_documents →
        user_profiles の 2 列と terms_acceptances に記録 → 元の画面へ
```

### 4.3 シナリオのトレース (§4.1 の構造で手で走らせた記録)

| # | トレース |
|---|---|
| S-1 | `/terms` は `publicPaths` で未ログインでも開く → page が `termsText({ businessName: BUSINESS_NAME, businessRepresentative, supportEmail: getSupportEmail(), aiProviders: [] })` を描く → `<main>` の先頭は `LegalDocumentMeta` (版 v2026.1・施行日) → `LegalDocumentBody` が章を h2・条を h3 で描く → h1 は「利用規約」1 つ・header の a は `/` |
| S-2 | `/privacy` も同じ。ctx.aiProviders は 5 社 → §6 のブロック `ai_providers` が `<ul data-testid="privacy-ai-providers">` に 5 行 → 委託先の表 (`table`)・保存期間の表・請求の手順・窓口 (`contact`) が並ぶ |
| S-3 | middleware: `getOutdatedLegalDocuments({ terms_version_accepted: 'v2025.1', privacy_version_accepted: 'v2025.1' })` → `['terms_of_service','privacy_policy']` → `/legal-consent?next=/` → `LegalConsentForm` の `isReconsent=true, outdated=両方` → `introReconsent`・両方に `revisedBadge` → 全文のリンクは `LEGAL_DOCUMENT_PATHS` → 同意 → `POST /api/legal/accept` (body の版 = `LEGAL_DOCUMENTS` の値) → 200 → `next` へ |
| S-4 | アプリ: `GET /api/legal/status` (許可リストにあるので通る) → `gaps` に 2 文書 → ゲートが WebView → 同意 → `legal-consent-accepted` → `refresh()` → 入口へ |
| S-5 | `/api/meals` は許可リストに無い → 403 `{ code: 'LEGAL_CONSENT_REQUIRED' }` → 画面は同意画面へ。`/api/account/delete`・`/api/account/export`・`/api/account/data-requests/*`・`/api/contact`・`/api/billing/subscription*`・`/api/billing/portal` は許可リスト (`legal-consent-api.ts:88-110`) で通る。ただし退会・書き出し・解約を呼ぶ画面 (`/settings`・`/account/billing`) は同意画面へ回るので、利用規約第10条 4 項・第17条 1 項・プライバシーポリシー第13条 1 項・3 項は、この間の手段を第24条 2 項 (お問い合わせ・請求) と書く (F-32) |
| S-6 | 「同意しない（ログアウトする）」→ signOut → `declineUnavailable` の文と `DSR_SETTINGS_PATH`・`/contact` へのリンク → 再ログイン → S-3 に戻る |
| S-7 | `decideEligibility(row, user, { legalConsentEnforced: true })` → `hasAcceptedCurrentLegalDocuments` が false → `{ ok: false, code: PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED }` (= `consent_outdated`) → 送らない。再同意後は true |
| S-8 | サインアップ画面のリンク → `/terms`・`/privacy` (S-1/S-2) → 登録 → `/auth/callback` の `resolveFirstSignInDestination` が `/legal-consent?next=…` → 生年月日 + 2 つの同意 → `accept_legal_documents(p_birth_date)` |
| S-9 | 同意画面 (`AiDataConsentModal`) と `/privacy` §6 の一覧は同じ `AI_CONSENT_PROVIDERS` の順で 5 行 (`tests/business-info-legal-pages.test.ts:144-153` と §13 のテストが固定) |
| S-10 | §7 §5 の文は F-22 (プロフィールの欄)・`health_checkups` (写真は `health-checkups` バケット、非公開)・F-18 (健康の表の SELECT は本人だけ。`share_health` を読む経路は無い)・F-33 (写真は家族・組織に経路が無い)・F-19 (組織は集計のみ) に当たる |
| S-11 | §7 §14 は cross/15 の実装 (`DSR_REQUEST_TYPES`・`DSR_VERIFICATION_TTL_HOURS = 24`・`DSR_VERIFICATION_MAX_SENDS = 5`・`DSR_RESPONSE_DUE_DAYS_DEFAULT = 30`・`DSR_SETTINGS_PATH`) から数を埋める。凍結中・退会後は `/contact` (cross/15 S-13) |
| S-12 | §6 第 17 条は cross/08 §16.1-16.3 の表と一致 (即時・取り消し不可・公開レシピ匿名化・法令で残す記録は紐づけを外して残す・送信停止の記録はアドレスのまま残す・保護者として署名した同意の記録は残す (F-30)・バックアップの残存は §7 §12 を参照) |
| S-13 | §6 第 16 条 2 項は `FROZEN_ALLOWED_API_PATHS` (退会・書き出し・解約 3 本) + `/api/contact` の POST (F-12) と `/frozen` の文 (F-20) に当たる |
| S-14 | §6 第 5 条は `parental-consent.ts` の境 (18・13)・`LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedBody`・`guardianMissingHeading` (退会の道だけ) に当たる。第 5 条 3 項の「つないだ本人の記録の見え方は本人の共有の設定」は `accept_child_promotion` の 3 つの共有の引数、「代わりに記録できるのは本人のアカウントが無い子どもだけ」は `family_members_child_profile_consistency` (F-33) に当たる |
| S-15 | §6・§7・§8 のブロックを置き、§8.2 の部品と §8.3 のページの差分を当て、§13 のテストを足し、§9.1 の版を書き換える。`npx tsc`・`vitest` 全件は offload で流す |
| S-16 | §9.3: 内容が変わらない直しは版を据え置く。変わる直しは版を上げて再同意 |
| S-17 | 版上げ後、凍結されていない成人の未同意の人が `/settings` を開く → 同意画面へ回る (F-32)。「同意しない（ログアウトする）」→ `declined` の画面にお問い合わせ (データの削除の依頼) と請求の画面へのリンク → `/contact` から依頼 → 運営が本人確認のうえ削除。有料プランの人は同じ `/contact` から解約を依頼 → 運営が決済代行事業者の管理画面で解約する (運用。Q-21)。`/account/billing` も同意画面へ回る (F-32)。利用規約第24条 2 項の「同意の前でもできること」(請求・お問い合わせ (削除と解約の依頼を含む)) と、第10条 4 項・第17条 1 項・プライバシーポリシー第13条 1 項・3 項の「改めて同意するまでの間は第24条 2 項」と食い違わない |

---

## 5. 構造裁定 (相 3・1 回だけ)

| 案 | 中身 | 利点 | 欠点 |
|---|---|---|---|
| A. 現行どおり JSX に直書き | `page.tsx` に h3 と p を並べる | 変更が小さい | 文面の存在をテストで固定しにくい (HTML から拾う)。製品の定数との一致 (保存期間・年齢) を文の中で保てない。設計書の逐語とコードの逐語を突き合わせにくい |
| **B. 型のあるデータ + 描画部品 (採る)** | 文面を `LegalDocumentText` の配列にし、`LegalDocumentBody` が描く | 条の一覧・AI 事業者の一覧・数の由来をテストで固定できる。設計書の TS ブロックをそのまま置ける。文面モジュールは React を持たず、素のまま検査できる | 描画部品 1 つと型 1 本が増える |
| C. Markdown ファイルを読み込んで描く | `docs/legal/*.md` を実行時または build 時に読む | 文面の編集が楽 | 製品の定数 (事業者名・問い合わせ先・AI 事業者・保存期間) を埋められない。既存の 2 つのテストが要求する `data-testid` と識別子を満たすのに別の仕組みが要る |

「縁の発生源を消すより単純な構造は無いか」: 縁は「文面と製品の実態の食い違い」である。A・C は文面の中に数と名前を直接書くので、製品が変わるたびに食い違いが生まれる。B は数と名前を製品の定数から埋め、一覧を同意画面と同じ定数から出すので、発生源そのものが消える。**B で確定**。以後の仕上げ (§6〜§17) は B を機械的に展開したもので、構造の蒸し返しはしない。

---

## 6. 正典: 利用規約の全文 (`src/lib/legal/terms-text.ts`)

書き方の規則 (§7 も同じ):
- 文の中の数は `LEGAL_FACTS` (§8.1) から埋める。文面モジュールに意味のある数を直接書かない。
- 事業者名・代表者・問い合わせ先・AI 事業者は `ctx` から埋める。文面モジュールに `株式会社` や事業者の名前 (`Inc` を含む) を直接書かない (`tests/business-info-legal-pages.test.ts:96-103` の走査に掛かる)。
- `tests/public-claims-guard.test.ts:113-187` の禁止語 (「最適な」「24時間以内」「永久無料」「第三者に共有されることはありません」など) を書かない。
- 効果・成果 (「健康になれる」「改善」) を書かない。治療・予防を目的としないことを書く。
- 条番号は見出しに含める。`id` はページ内のアンカー (`/terms#terms-9`) で、他の画面が参照する。

```ts
// tsc:skip
// place=src/lib/legal/terms-text.ts (新設モジュール同士の import のため単独検査から外す。置き場所に置いてリポジトリ全体で検査する)
/**
 * 利用規約の全文 (#1901・設計書 cross/20 §6)。
 * 文面はデータとして持ち、src/app/terms/page.tsx が LegalDocumentBody で描く。
 * 数は LEGAL_FACTS、名前と問い合わせ先は ctx から埋める (このファイルに数・事業者名を直接書かない)。
 * 内容が変わる改定は packages/shared/src/legal-versions.ts の LEGAL_DOCUMENTS.terms_of_service.version を上げる (cross/20 §9)。
 */
import {
  LEGAL_DOCUMENT_PATHS,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  DSR_SETTINGS_PATH,
} from '@homegohan/shared';
import { AI_CONSENT_SETTINGS_PATH } from '@/lib/ai/consent-config';
import { SESSIONS_SETTINGS_PATH } from '@/lib/emails/account/login-new-device';
import {
  BILLING_PATH,
  CONTACT_PATH,
  LEGAL_FACTS,
  LEGAL_NOTICE_PATH,
  PRICING_PATH,
  type LegalDocumentText,
  type LegalTextContext,
} from './legal-text';

/** 利用規約の条の見出し (番号つき)。順と数は termsText の h3 と一致する (tests/legal-text-1901.test.ts が突き合わせる) */
export const TERMS_ARTICLE_HEADINGS = [
  '第1条（適用）',
  '第2条（定義）',
  '第3条（利用登録）',
  '第4条（アカウントの管理）',
  '第5条（未成年者の利用と保護者の同意）',
  '第6条（本サービスの内容）',
  '第7条（AI 機能）',
  '第8条（AI 機能の利用回数の上限）',
  '第9条（医療に関する免責）',
  '第10条（料金と有料プラン）',
  '第11条（家族グループ）',
  '第12条（組織）',
  '第13条（ユーザーコンテンツと公開の範囲）',
  '第14条（知的財産権）',
  '第15条（禁止事項）',
  '第16条（利用の制限とアカウントの凍結）',
  '第17条（退会）',
  '第18条（本サービスの変更・中断・終了）',
  '第19条（通知と連絡）',
  '第20条（保証の否認）',
  '第21条（損害賠償と責任の制限）',
  '第22条（ユーザーの責任）',
  '第23条（個人情報の取扱い）',
  '第24条（本規約の変更と再同意）',
  '第25条（権利義務の譲渡の禁止）',
  '第26条（分離可能性）',
  '第27条（準拠法と裁判管轄）',
  '第28条（お問い合わせ）',
] as const;

/** 条の数 (宣言)。実列挙 (TERMS_ARTICLE_HEADINGS.length と termsText の h3 の数) と一致することをテストが確かめる */
export const TERMS_ARTICLE_COUNT = 28;

/** 医療に関する免責の文 (cross/08 §8.1 の text と同じ 1 文。字句を変えない) */
export const TERMS_MEDICAL_DISCLAIMER =
  'ほめゴハンは食事管理を支援するアプリであり、医師の診察・診断・治療を代替するものではありません。';

/** 急病時の案内 (cross/08 §8.1 の急病時の表示と同じ趣旨) */
export const TERMS_EMERGENCY_NOTICE =
  '緊急の症状がある場合は、すぐに救急（119）または医療機関を受診してください。本サービスは医療行為を行いません。';

export function termsText(ctx: LegalTextContext): LegalDocumentText {
  const company = ctx.businessName;
  const f = LEGAL_FACTS;
  return {
    type: 'terms_of_service',
    chapters: [
      {
        id: 'terms-ch1',
        title: '第1章 総則',
        sections: [
          {
            id: 'terms-1',
            heading: TERMS_ARTICLE_HEADINGS[0],
            blocks: [
              {
                kind: 'ol',
                items: [
                  `この利用規約（以下「本規約」といいます）は、${company}（以下「当社」といいます）が提供するサービス「ほめゴハン」（Web 版および iOS・Android 向けのアプリ版を含み、以下「本サービス」といいます）の利用条件を定めるものです。`,
                  '本サービスを利用するすべての方（以下「ユーザー」といいます）は、本規約に同意のうえ本サービスを利用するものとします。本規約は、民法に定める定型約款として、当社とユーザーとの間の本サービスの利用契約の内容になります。',
                  '当社が本サービス上に掲載するプライバシーポリシー、特定商取引法に基づく表記、保護者の同意書、および AI 機能で使う日本国外の事業者へのデータ提供に関する同意の文書（以下あわせて「個別規定」といいます）は、本規約の一部を構成します。個別規定の内容が本規約と異なるときは、個別規定が優先します。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: 'プライバシーポリシー', href: LEGAL_DOCUMENT_PATHS.privacy_policy },
                  { label: '特定商取引法に基づく表記', href: LEGAL_NOTICE_PATH },
                  { label: '保護者の同意書', href: PARENTAL_CONSENT_DOCUMENT_PATH },
                ],
              },
            ],
          },
          {
            id: 'terms-2',
            heading: TERMS_ARTICLE_HEADINGS[1],
            blocks: [
              { kind: 'p', text: '本規約で使う用語の意味は、次のとおりです。' },
              {
                kind: 'ul',
                items: [
                  '「登録情報」: ユーザーが本サービスに登録・入力した、メールアドレス、生年月日、ニックネーム、身体・生活・健康に関する情報、好みやアレルギーなどの情報。',
                  '「ユーザーコンテンツ」: ユーザーが本サービスに記録・投稿・アップロードした食事や冷蔵庫の写真、食事の記録、健康の記録、健康診断や血液検査の写真と数値、レシピ、コメント、AI への相談の文章など。',
                  '「AI 機能」: 写真の読み取り、栄養の推定、献立や買い物リストの作成、AI 相談、健康診断・血液検査の結果へのコメント、健康に関するヒント、料理の画像の作成など、人工知能を用いて行う本サービスの機能。',
                  '「AI 事業者」: AI 機能のために当社がユーザーのデータを送る、日本国外にある事業者。一覧はプライバシーポリシーに記載します。',
                  '「家族グループ」: 複数のユーザーが食事の記録・献立・買い物リストを共有するための、本サービス上のグループ。',
                  '「組織」: 企業・団体が、その従業員や会員を招待して本サービスを利用するための、本サービス上の単位。',
                  `「保護者」: ${f.adultAgeYears} 歳未満のユーザーについて、親権者その他の法定代理人。`,
                ],
              },
            ],
          },
          {
            id: 'terms-3',
            heading: TERMS_ARTICLE_HEADINGS[2],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '登録を希望する方は、本規約とプライバシーポリシーに同意したうえで、メールアドレスとパスワード、または Google アカウントを用い、当社の定める方法で利用登録を行います。登録そのものに料金はかかりません。',
                  '登録のとき、またはその後に初めて本サービスを利用するとき、生年月日の申告が必要です。生年月日は年齢の確認のために用い、一度登録するとご自身では変更できません。誤って登録した場合はお問い合わせからご連絡ください。',
                  `${f.adultAgeYears} 歳未満の方は、ご自身では登録できません。${f.coppaAgeYears} 歳以上 ${f.adultAgeYears} 歳未満の方は、第5条の方法でのみ本サービスを利用できます。${f.coppaAgeYears} 歳未満の方の本人名義のアカウントは作成できません。`,
                  '当社は、登録を希望する方が次のいずれかに当たると判断したときは、登録を承認せず、または承認した後に登録を取り消すことがあります。当社は、その理由を開示する義務を負いません。',
                ],
              },
              {
                kind: 'ul',
                items: [
                  '申告した内容に虚偽、誤り、または記載漏れがあったとき。',
                  '過去に本規約に違反してアカウントを凍結され、または退会させられたことがあるとき。',
                  '暴力団、暴力団員、その他の反社会的勢力に該当し、またはこれらと関係があるとき。',
                  'その他、当社が登録を適当でないと判断したとき。',
                ],
              },
            ],
          },
          {
            id: 'terms-4',
            heading: TERMS_ARTICLE_HEADINGS[3],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'ユーザーは、自己の責任で、メールアドレス、パスワード、および Google アカウントなど本サービスへのログインに用いる手段を管理し、第三者に利用させてはなりません。',
                  'ユーザーは、設定画面の「ログイン中の端末・ログイン履歴」で、ログインの履歴と、ログイン中の端末（セッション）の一覧を確認し、心当たりのないセッションを失効させることができます。新しい端末からのログインがあったときは、登録されたメールアドレスへお知らせすることがあります。',
                  `一定期間（${f.sessionIdleExpireDays} 日）操作のないセッションは、自動的に失効します。`,
                  'ログインに用いる手段が第三者に使われたことによりユーザーに生じた損害について、当社は、当社に故意または過失がある場合を除き、責任を負いません。',
                ],
              },
              { kind: 'links', items: [{ label: '設定（ログイン中の端末・ログイン履歴）', href: SESSIONS_SETTINGS_PATH }] },
            ],
          },
          {
            id: 'terms-5',
            heading: TERMS_ARTICLE_HEADINGS[4],
            blocks: [
              {
                kind: 'ol',
                items: [
                  `${f.coppaAgeYears} 歳以上 ${f.adultAgeYears} 歳未満の方が本サービスを利用するには、保護者が家族グループにその方を追加し、保護者の同意書に同意したうえで、保護者に届く案内から本人のアカウントをつなぐ必要があります。保護者の同意は、本規約とプライバシーポリシーの内容を含めて行います。`,
                  `${f.coppaAgeYears} 歳未満の方については、本人名義のアカウントを作成せず、保護者が家族グループの記録として、その方の食事などを代わりに記録します。`,
                  '本人のアカウントをつないだ未成年者は、ほかのメンバーと同じく、食事の記録、健康の記録、献立のそれぞれを家族グループに共有するかどうかを、つなぐときに自分で選び、その後も自分で変更できます。保護者を含む家族グループのメンバーに表示されるのは、第11条2項のとおり、本人が共有を選んだ記録だけです。保護者が代わりに記録できるのは、本人のアカウントが無い家族の記録（前項と第11条4項）に限ります。',
                  `保護者の同意とのつながりが無くなったとき（家族グループから外れたとき、家族グループが解散したとき、保護者からの案内が無効になったときなど）は、その未成年者は、保護者が家族グループに追加し直して本人が案内を承諾するか、${f.adultAgeYears} 歳になるまでの間、本サービスを利用できず、退会のみを行うことができます。`,
                  '未成年者が保護者の同意を得ずに本サービスを利用した場合、保護者は、民法の定めに従い、その利用契約を取り消すことができます。',
                ],
              },
              { kind: 'links', items: [{ label: '保護者の同意書', href: PARENTAL_CONSENT_DOCUMENT_PATH }] },
            ],
          },
        ],
      },
      {
        id: 'terms-ch2',
        title: '第2章 本サービス',
        sections: [
          {
            id: 'terms-6',
            heading: TERMS_ARTICLE_HEADINGS[5],
            blocks: [
              { kind: 'p', text: '本サービスは、次の機能を提供します。機能の内容は、第18条のとおり変わることがあります。' },
              {
                kind: 'ul',
                items: [
                  '食事の写真や文章による食事の記録と、料理名・分量・栄養の推定。',
                  '献立と買い物リストの作成、冷蔵庫の写真からの食材の読み取り。',
                  '体重・体脂肪率・血圧などの健康の記録、健康診断や血液検査の結果の記録と、それに対するコメント。',
                  'AI 相談、健康に関するヒント、料理の画像の作成。',
                  'レシピの作成、公開、保存（コレクション）、いいね、コメント。',
                  '家族グループによる記録・献立・買い物リストの共有。',
                  '組織によるメンバーの招待と管理と、任意参加のチャレンジ。',
                  '記録の継続に応じたバッジ、お知らせ、メールやプッシュ通知による連絡。',
                ],
              },
            ],
          },
          {
            id: 'terms-7',
            heading: TERMS_ARTICLE_HEADINGS[6],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'AI 機能は、ユーザーが入力・撮影した内容を、日本国外にある AI 事業者へ送って処理します。AI 機能を利用するには、あらかじめ、プライバシーポリシーと同意画面に記載する内容（送る情報、送り先の事業者、その所在国と制度、利用目的）を確認し、同意する必要があります。同意しない場合、AI 機能は利用できませんが、本サービスのそれ以外の機能は利用できます。',
                  '同意は、設定の「AI へのデータ提供の同意」からいつでも確認し、撤回できます。撤回すると、AI 機能は利用できなくなります。もう一度利用するには、改めて同意が必要です。',
                  '画面を開くと自動で動く AI の処理（ホームの栄養のアドバイス、献立への栄養士のコメントなど）は、同意が無い間は実行しません。',
                  'AI 機能の結果（料理名、分量、栄養の数値、献立、コメント、画像など）は、推定に基づく参考情報です。当社は、その正確性、完全性、有用性を保証しません。写真からの読み取りや栄養の推定には誤りが含まれることがあります。ユーザーは、結果を自分で確認したうえで利用するものとします。',
                  'AI 機能の結果を、医療や健康に関する判断にそのまま用いないでください（第9条）。',
                  'ユーザーは、AI 機能に対し、第三者の個人情報、法令または公序良俗に反する内容、本サービスの動作を妨げることを目的とした内容を入力してはなりません。',
                ],
              },
              { kind: 'links', items: [{ label: 'AI へのデータ提供の同意（確認・撤回）', href: AI_CONSENT_SETTINGS_PATH }] },
            ],
          },
          {
            id: 'terms-8',
            heading: TERMS_ARTICLE_HEADINGS[7],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'AI 機能には、1 日にご利用いただける回数の上限があります。上限に達した日は、日本時間の翌日 0 時から再びご利用いただけます。',
                  '上限の回数は、ご利用のプランと当社の設定によって変わり、上限に達したときに画面に表示します。一部の機能には、機能ごとの上限があります。',
                  '画面を開くと自動で動く AI の処理には、上の上限とは別に、安全のための回数の上限があります。この上限に達した日は、その処理を行わず、翌日に再び行います。',
                ],
              },
            ],
          },
          {
            id: 'terms-9',
            heading: TERMS_ARTICLE_HEADINGS[8],
            blocks: [
              {
                kind: 'ol',
                items: [
                  TERMS_MEDICAL_DISCLAIMER,
                  '本サービスが示す栄養の数値、献立、健康に関するヒント、健康診断や血液検査の結果へのコメントは、一般的な情報と推定に基づく参考情報であり、疾病の診断、治療、予防を目的とするものではありません。当社は、本サービスの利用による健康上の効果を保証しません。',
                  '通院中・服薬中・妊娠中・授乳中の方、医師や管理栄養士から食事の指示を受けている方、食物アレルギーのある方は、本サービスの情報よりも、医師・管理栄養士等の指示を優先してください。',
                  TERMS_EMERGENCY_NOTICE,
                ],
              },
            ],
          },
          {
            id: 'terms-10',
            heading: TERMS_ARTICLE_HEADINGS[9],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '本サービスには、無料で利用できる機能があります。',
                  '当社は、有料プランを提供することがあります。有料プランの内容、料金、支払方法、支払時期、契約期間、自動更新の有無、解約の方法は、料金ページと特定商取引法に基づく表記に定め、申込みの前の確認画面に表示します。有料プランの販売を開始していない間は、料金ページと特定商取引法に基づく表記に「準備中」と表示します。',
                  '有料プランの決済は、決済代行事業者（Stripe）を通じて行います。クレジットカードの番号などの決済情報は、当社ではなく決済代行事業者が取り扱い、当社は保持しません。',
                  '有料プランは、ユーザーが解約の手続を行わない限り、契約期間ごとに自動的に更新されます。ユーザーは、いつでも解約を予約でき、予約した場合も契約期間の末日まで有料プランを利用できます。解約の予約は、設定の「お支払い」から行います。本規約またはプライバシーポリシーの改定後、改めて同意するまでの間は、設定の「お支払い」を利用できないため、第24条2項のとおり、お問い合わせから解約を依頼してください。契約期間の途中で解約した場合、法令で必要とされる場合を除き、日割りの返金は行いません。ただし、本サービスに重大な瑕疵があった場合は、個別に対応します。',
                  '有料プランの支払いが確認できないとき、当社は、有料プランの機能の提供を停止し、または契約を終了することがあります。',
                  '組織向けのプランは、組織と当社との契約により提供します。組織に参加できる人数には、契約に応じて上限（ライセンスの数）を設けることがあり、組織への招待を承諾したユーザーがその枠を使います。',
                  'アプリ版では、アプリ内課金を行いません。有料プランの申込みと解約は、Web 版で行います。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: '料金ページ', href: PRICING_PATH },
                  { label: '特定商取引法に基づく表記', href: LEGAL_NOTICE_PATH },
                  { label: '設定（お支払い）', href: BILLING_PATH },
                ],
              },
            ],
          },
          {
            id: 'terms-11',
            heading: TERMS_ARTICLE_HEADINGS[10],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'ユーザーは、家族グループを作成し、メールで他の方を招待できます。招待を受けた方が参加すると、家族グループのメンバーになります。',
                  '各メンバーは、食事の記録、健康の記録、献立のそれぞれについて、家族グループに共有するかどうかを自分で設定できます。食事の記録と献立は、本人が共有を選んだ場合に、家族グループのメンバーに表示されます。健康の記録は、現在、共有の設定にかかわらず家族グループのメンバーに表示されません（家族に健康の記録を表示する機能はありません）。',
                  '家族グループの代表者と管理者は、家族としての献立・買い物リストの作成、本人のアカウントが無い家族の記録の代理での記録、メンバーの管理を行うことができます。本人のアカウントがあるメンバーの記録を、代わりに記録することはできません。',
                  `${f.coppaAgeYears} 歳未満の子どもや、自分で操作しない家族の記録は、代表者または管理者が代わりに記録します。この記録はその家族の個人情報であり、記録する方は、その家族（未成年者については保護者）の了解のもとで記録してください。`,
                  'メンバーは、いつでも家族グループから退出できます。代表者は、退会の前に、代表者を他のメンバーへ譲渡するか、家族グループを解散する必要があります。',
                  `代表者が ${f.inactiveRepresentativeDays} 日以上ログインしていないなど、家族グループの運営に支障があるときは、当社が、代表者を他のメンバーへ譲渡し、または家族グループを解散することがあります。`,
                ],
              },
            ],
          },
          {
            id: 'terms-12',
            heading: TERMS_ARTICLE_HEADINGS[11],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '組織の管理者は、メンバーの招待（招待先のメールアドレス、組織内の役割、部署を指定します）と、メンバーの管理（組織からの削除など）を行います。組織の管理者に表示されるのは、メンバーの表示名、組織内の役割、組織に参加した日、招待の状況（招待先のメールアドレス、役割、部署、承諾したかどうか）、組織のメンバー数と部署ごとの人数、チャレンジの参加人数と平均（参加者が一定の人数以上の場合に限ります）です。',
                  '組織の管理者は、組織に所属する個々のユーザーの食事の記録、健康の記録、AI 相談の内容を閲覧できません。組織に対しては、個人を特定できない集計のみを提供します。',
                  '組織のチャレンジへの参加は任意です。順位は参加者どうしにのみ表示し、組織の管理者には集計のみを表示します。順位に参加者の表示名を出すかどうかは本サービスの設定によって決まり、出さないことを既定とします。',
                  `組織のオーナーは、退会の前に、オーナーを他の管理者へ譲渡するか、組織を解散する必要があります。オーナーが ${f.inactiveRepresentativeDays} 日以上ログインしていないなど、組織の運営に支障があるときは、当社が譲渡または解散を行うことがあります。`,
                  '組織を退出し、または組織から削除されたユーザーは、個人のユーザーとして本サービスを引き続き利用できます。',
                ],
              },
            ],
          },
          {
            id: 'terms-13',
            heading: TERMS_ARTICLE_HEADINGS[12],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '食事、冷蔵庫、健康診断や血液検査の写真は非公開で保存し、画面に表示できるのは本人だけです。これらの写真は、共有の設定にかかわらず、家族グループのメンバーにも組織の管理者にも表示されません。ただし、当社の運営担当者は、投稿の審査、不正利用や不具合の調査に必要な範囲で、これらの写真を閲覧することがあります（プライバシーポリシー第5条）。',
                  'レシピは、ユーザーが「公開」に設定した場合に限り、他のユーザーに表示されます。公開したレシピには、他のユーザーがコメント、保存（コレクション）、いいねをすることがあります。',
                  'ユーザーは、自分のユーザーコンテンツを本サービスに記録・投稿する権利を有し、それが第三者の著作権、肖像権、プライバシーその他の権利を侵害しないことを保証します。',
                  `当社は、本規約に違反し、または違反のおそれがあると判断したユーザーコンテンツを、通知なく非表示にすることがあります。非表示にしたコンテンツは、非表示にしてから ${f.hiddenContentRetentionDays} 日が経過すると完全に削除します。`,
                  '不適切なコンテンツを見つけたときは、お問い合わせからご連絡ください。',
                ],
              },
            ],
          },
          {
            id: 'terms-14',
            heading: TERMS_ARTICLE_HEADINGS[13],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '本サービスを構成するプログラム、デザイン、文章、画像、レシピや食材のデータベース、商標などに関する権利は、当社または正当な権利を有する第三者に帰属します。',
                  'ユーザーコンテンツの著作権は、ユーザーに留保されます。当社は、本サービスの提供、改善、不具合の調査に必要な範囲で、ユーザーコンテンツを複製、表示、加工（栄養の推定、縮小画像の作成、AI 機能での処理など）することができます。',
                  'AI 機能が生成した献立、レシピ、コメント、料理の画像などの権利は、法令上権利が生じる範囲で、個人利用の範囲でユーザーに帰属します。当社は、個人を特定できない集計と本サービスの改善の目的に限り、匿名化した形でこれらを利用できます。',
                  'ユーザーが公開したレシピへのコメント、口コミその他の評価は、当社が本サービスの運営と紹介のために、無償で、期間と地域の制限なく利用できるもの（CC0 相当）として当社に提供されます。',
                  'ユーザーは、当社の許諾なく、本サービスのコンテンツ（レシピや食材のデータベースを含みます）を複製、転載、配布、販売してはなりません。',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'terms-ch3',
        title: '第3章 禁止事項と利用の制限',
        sections: [
          {
            id: 'terms-15',
            heading: TERMS_ARTICLE_HEADINGS[14],
            blocks: [
              { kind: 'p', text: 'ユーザーは、本サービスの利用にあたり、次の行為をしてはなりません。' },
              {
                kind: 'ul',
                items: [
                  '法令または公序良俗に違反する行為、犯罪行為に関連する行為。',
                  '当社、他のユーザー、その他の第三者の著作権、商標権、肖像権、プライバシー、名誉その他の権利や利益を侵害する行為。',
                  '他人になりすます行為、虚偽の生年月日や登録情報を申告する行為、他人のアカウントを利用する行為。',
                  '本人または保護者の了解なく、他人の個人情報や健康に関する情報を本サービスに登録する行為。',
                  '他のユーザーの個人情報、投稿、写真を本人の許可なく収集、保存、公開する行為。',
                  '不正アクセス、パスワードの推測、本サービスのサーバーやネットワークへの過度な負荷、回数制限や同意の仕組みを回避する行為。',
                  'スクレイピング、自動化された手段による本サービスのデータの取得、本サービスのプログラムの解析（リバースエンジニアリング）や改変。',
                  'AI 機能に対し、有害な内容、違法な内容、または本サービスの動作や他のユーザーに影響を与えることを目的とした指示を入力する行為。',
                  '営利を目的として本サービスを利用し、または本サービスのコンテンツや AI 機能の結果を転売する行為。',
                  '他のユーザーへの嫌がらせ、差別的な表現、暴力的・性的な表現、未成年者に有害な内容を投稿する行為。',
                  '本サービスの運営を妨害する行為、当社の信用を毀損する行為、当社や他のユーザーへの迷惑行為。',
                  '反社会的勢力への利益供与、その他反社会的勢力との関係に基づく行為。',
                  'その他、当社が不適切と判断する行為。',
                ],
              },
            ],
          },
          {
            id: 'terms-16',
            heading: TERMS_ARTICLE_HEADINGS[15],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、ユーザーが本規約に違反し、または違反のおそれがあると判断したとき、事前に通知することなく、ユーザーコンテンツの非表示、AI 機能や投稿の制限、アカウントの一時的または無期限の凍結を行うことがあります。',
                  '凍結中は、本サービスの機能を利用できません。ただし、凍結中でも、データの書き出し、退会、有料プランの解約、お問い合わせの送信は行うことができます。',
                  '一時的な凍結は、解除予定の日時が経過すると自動的に解除されます。凍結に心当たりがない場合や、詳細を確認したい場合は、お問い合わせからご連絡ください。',
                  '当社は、凍結の判断の根拠となった情報を、法令で必要とされる場合を除き、開示する義務を負いません。',
                  '本条の措置によりユーザーに生じた損害について、当社は、第21条（損害賠償と責任の制限）に定める範囲で責任を負います。',
                ],
              },
            ],
          },
          {
            id: 'terms-17',
            heading: TERMS_ARTICLE_HEADINGS[16],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'ユーザーは、いつでも退会できます。退会は設定画面から行い（凍結中は第16条2項のとおりです）、退会すると、アカウントと、アカウントに紐づく個人データは直ちに削除され、取り消すことはできません。削除の前に、設定画面からデータを書き出すことができます。本規約またはプライバシーポリシーの改定後、改めて同意するまでの間は、設定画面を利用できないため、第24条2項のとおり、お問い合わせから削除を依頼し、データの開示は個人情報の開示の請求により求めてください。',
                  '組織のオーナーと家族グループの代表者は、退会の前に、オーナーまたは代表者を譲渡するか、組織または家族グループを解散する必要があります。',
                  '退会後も、次のものは残ります。（a）ユーザーが公開したレシピは、ユーザーとの紐づけを外して匿名の状態で残ります（他のユーザーの保存やコメントが付いていることがあるため）。非公開のレシピは削除します。（b）法令上の保存義務や、不正利用の防止、会計のために必要な記録（クーポンや紹介の利用記録、運営の操作の記録など）は、ユーザーとの紐づけを外して残します。（c）苦情や配信の失敗があったメールアドレスへの送信停止の記録は、再び送らないために、メールアドレスのまま残します。（d）保護者として未成年者の利用に同意したときの同意の記録（署名した氏名など）は、同意の根拠として、プライバシーポリシーに定めるとおり残します。（e）バックアップの中のデータは、プライバシーポリシーに定める期間が経過するまで残ります。',
                  '退会すると、有料プランの契約は直ちに解約されます。既に支払われた料金は、法令で必要とされる場合を除き、返金しません。',
                  '退会後に再び本サービスを利用するには、新規に登録する必要があります。削除したデータは復元できません。',
                ],
              },
            ],
          },
          {
            id: 'terms-18',
            heading: TERMS_ARTICLE_HEADINGS[17],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、本サービスの内容を変更、追加、または廃止することがあります。ユーザーの利用に大きな影響がある変更は、できる限り事前に本サービス上でお知らせします。',
                  '当社は、次の場合、事前に通知することなく、本サービスの全部または一部の提供を一時的に中断することがあります。（a）システムの保守・点検・更新を行うとき。（b）地震、火災、停電、通信障害などの不可抗力により提供が困難なとき。（c）当社が利用するクラウド、決済、メール、AI などの外部事業者のサービスに障害や停止があるとき。（d）不正アクセスやその他のセキュリティ上の理由があるとき。（e）その他、当社がやむを得ないと判断したとき。保守などで計画的に中断するときは、本サービスの画面にその旨を表示します。',
                  '当社は、本サービスの全部の提供を終了することがあります。その場合、できる限り事前に本サービス上でお知らせし、ユーザーがデータを書き出す機会を設けるよう努めます。',
                  '本条に基づく変更、中断、終了によりユーザーに生じた損害について、当社は、第21条（損害賠償と責任の制限）に定める範囲で責任を負います。',
                ],
              },
            ],
          },
          {
            id: 'terms-19',
            heading: TERMS_ARTICLE_HEADINGS[18],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社からユーザーへの連絡は、登録されたメールアドレスへのメール、本サービス上の表示、またはアプリのプッシュ通知により行います。ユーザーは、登録するメールアドレスを連絡の取れる状態に保つものとします。',
                  'プッシュ通知は、設定画面または端末の設定で止めることができます。止めている間も、本規約やプライバシーポリシーの改定など、本サービスの利用に必要なお知らせは、本サービス上の表示で行います。',
                  '当社がお送りするメール（アカウントやログインのお知らせ、本人確認、家族グループや組織の招待とお知らせ、お問い合わせへの返信、個人情報の請求への対応など）は、本サービスの利用に伴う連絡のためのもので、配信を止める設定はありません。',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'terms-ch4',
        title: '第4章 免責と責任',
        sections: [
          {
            id: 'terms-20',
            heading: TERMS_ARTICLE_HEADINGS[19],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、本サービスが、ユーザーの特定の目的に適合すること、期待する機能や正確性を備えること、中断や誤りが無いこと、セキュリティ上の欠陥が無いことを保証しません。',
                  '当社は、本サービスに関して、他のユーザーが投稿したコンテンツ、外部事業者のサービス、AI 機能の結果の内容について、保証しません。',
                  '当社は、本サービスのデータのバックアップを取得していますが、データが失われないことを保証するものではありません。大切なデータは、設定画面からの書き出しにより、ご自身でも保管してください。',
                ],
              },
            ],
          },
          {
            id: 'terms-21',
            heading: TERMS_ARTICLE_HEADINGS[20],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、本サービスに関してユーザーに生じた損害について、当社の故意または重大な過失による場合を除き、ユーザーに直接かつ通常生ずべき損害に限って賠償する責任を負い、特別な事情から生じた損害や逸失利益については責任を負いません。',
                  `前項の責任の額は、当社の故意または重大な過失による場合を除き、当社がそのユーザーから有料プランの料金として、損害が生じた時より前の ${f.liabilityCapMonths} か月間に受け取った金額を上限とします。ただし、その期間に有料プランの料金を受け取っていないユーザーには、本項の上限を適用しません（前項の範囲で責任を負います）。`,
                  '本条および本規約の他の条項による当社の責任の制限は、当社の故意または重大な過失による損害には適用されません。また、消費者契約法その他の強行法規に反する限度において適用されず、その場合、当社は法令が認める範囲で責任を負います。',
                ],
              },
            ],
          },
          {
            id: 'terms-22',
            heading: TERMS_ARTICLE_HEADINGS[21],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'ユーザーは、本規約に違反して当社に損害を与えたときは、その損害を賠償するものとします。',
                  'ユーザーが本サービスの利用に関して他のユーザーや第三者との間で紛争を生じたときは、ユーザーの責任と費用で解決するものとし、当社に故意または過失がある場合を除き、当社はその紛争に関与しません。',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'terms-ch5',
        title: '第5章 一般条項',
        sections: [
          {
            id: 'terms-23',
            heading: TERMS_ARTICLE_HEADINGS[22],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、ユーザーの個人情報を、プライバシーポリシーに従って取り扱います。',
                  'AI 機能のための日本国外の事業者へのデータの提供は、別途の同意の文書に基づいて行います。未成年者の情報の取扱いは、保護者の同意書にも従います。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: 'プライバシーポリシー', href: LEGAL_DOCUMENT_PATHS.privacy_policy },
                  { label: 'AI へのデータ提供の同意（確認・撤回）', href: AI_CONSENT_SETTINGS_PATH },
                  { label: '保護者の同意書', href: PARENTAL_CONSENT_DOCUMENT_PATH },
                ],
              },
            ],
          },
          {
            id: 'terms-24',
            heading: TERMS_ARTICLE_HEADINGS[23],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、本規約を変更することがあります。内容が変わる変更は、次項のとおりユーザーに改めて同意をお願いして行い、変更後の本規約は、ユーザーが同意した時から、そのユーザーに適用されます。当社は、変更の概要と施行日を、施行日の前に本サービスのお知らせに掲載します。',
                  '本規約またはプライバシーポリシーの内容が変わる改定を行ったときは、文書の版を更新し、施行日以後にユーザーが本サービスを利用するときに、改めて同意をお願いします。同意するまでの間は、本サービスの機能（設定画面を含みます）を利用できず、退会、データの書き出し、有料プランの解約の予約、AI へのデータ提供の同意の撤回なども、設定画面からは行えません（凍結中の方は第16条2項のとおりです）。ただし、個人情報の開示・訂正・利用停止・消去の請求と、お問い合わせ（アカウントと保存されたデータの削除の依頼と、有料プランの解約の依頼を含みます）は、同意の前でも行うことができます。同意しない場合は、お問い合わせから削除を依頼してください。当社は、ご本人であることを確認のうえ、アカウントと保存されたデータを削除します。',
                  '誤字の修正や表現の整理など、内容が変わらない修正は、版を更新せず、改めての同意をお願いしないことがあります。',
                  '各文書の版と施行日は、その文書のページの冒頭に表示します。改定前の版は当社が保管し、お問い合わせによりご提供します。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: '個人情報の開示・訂正・利用停止・消去の請求', href: DSR_SETTINGS_PATH },
                  { label: 'お問い合わせフォーム', href: CONTACT_PATH },
                ],
              },
            ],
          },
          {
            id: 'terms-25',
            heading: TERMS_ARTICLE_HEADINGS[24],
            blocks: [
              {
                kind: 'p',
                text: 'ユーザーは、当社の書面による事前の承諾なく、本規約に基づく権利または義務を第三者に譲渡し、または担保に供することはできません。当社が本サービスの事業を第三者に譲渡するときは、ユーザーの登録情報その他のデータを、プライバシーポリシーに従い、その譲受人に承継させることができます。',
              },
            ],
          },
          {
            id: 'terms-26',
            heading: TERMS_ARTICLE_HEADINGS[25],
            blocks: [
              {
                kind: 'p',
                text: '本規約のいずれかの条項またはその一部が、消費者契約法その他の法令により無効または執行不能と判断された場合でも、本規約の残りの条項、および一部が無効または執行不能と判断された条項の残りの部分は、引き続き効力を有します。',
              },
            ],
          },
          {
            id: 'terms-27',
            heading: TERMS_ARTICLE_HEADINGS[26],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '本規約の準拠法は日本法とします。',
                  '本サービスに関して当社とユーザーとの間で紛争が生じたときは、当社の本店所在地を管轄する裁判所を、第一審の専属的合意管轄裁判所とします。',
                ],
              },
            ],
          },
          {
            id: 'terms-28',
            heading: TERMS_ARTICLE_HEADINGS[27],
            blocks: [
              { kind: 'p', text: '本規約に関するお問い合わせは、お問い合わせフォームまたは次の窓口までお願いいたします。' },
              { kind: 'contact', lines: [`${company} ほめゴハン サポート窓口`], email: ctx.supportEmail },
              { kind: 'links', items: [{ label: 'お問い合わせフォーム', href: CONTACT_PATH }] },
            ],
          },
          {
            id: 'terms-supplementary',
            heading: '附則',
            blocks: [
              { kind: 'p', text: '本規約は、このページの冒頭に表示する施行日から適用します。改定の履歴は、版と施行日の表示によります。' },
            ],
          },
        ],
      },
    ],
  };
}
```

附則は条ではない (`TERMS_ARTICLE_HEADINGS` に入れない)。テストは「h3 のうち `第N条` で始まるものの列」が `TERMS_ARTICLE_HEADINGS` と等しいことを見る。

---

## 7. 正典: プライバシーポリシーの全文 (`src/lib/legal/privacy-text.ts`)

書き方の規則は §6 と同じ。加えて:
- AI 事業者の一覧は `ctx.aiProviders` (ページが `AI_CONSENT_PROVIDERS` / `AI_CONSENT_PROVIDER_INFO` から作る) だけから出す。文面モジュールに事業者の名前 (`Google`・`OpenAI`・`Perplexity`・`xAI`・`AI/ML API`) を書かない (`tests/business-info-legal-pages.test.ts:162-167` と同じ趣旨。`Google` は OAuth の事業者としては委託先の表 (`PRIVACY_PROCESSORS`) に出る)。
- 委託先の表は `PRIVACY_PROCESSORS` から描く。各行に製品の根拠 (`evidence`: ファイルとその中の語) を持たせ、テストが実在を確かめる (§13)。
- `evidence.needle` には、外部の事業者のホスト名 (`exp.host`・`api.resend.com` など)・`://` を含む URL を書かない。送り先や送信の部品を 1 つのファイルに限る走査テスト (`tests/push-expo-boundary-scan.test.ts` は `exp.host` を含むファイルを、`tests/ai-consent-provider-inventory.test.ts` は `https://<ホスト>` を含むファイルを数える) が、文面モジュールを送信の場所と数えて赤になるため。根拠のファイルの中の識別子 (定数名・import する名前・ワークフローの手順の文) を 6 文字以上で選ぶ (T-7 が形を検査する。§16)。
- 文面モジュールの文と JSDoc に `https://` で始まる URL を書かない (同じ理由。祝日の一覧の送り先は `HOLIDAYS_API_ORIGIN` を import してホストを作る)。
- 所在地・電話番号は `ctx.addressDisclosure` (= `DISCLOSED_ON_REQUEST`)。架空の値を書かない。

```ts
// tsc:skip
// place=src/lib/legal/privacy-text.ts (新設モジュール同士の import のため単独検査から外す。置き場所に置いてリポジトリ全体で検査する)
/**
 * プライバシーポリシーの全文 (#1901・設計書 cross/20 §7)。
 * 文面はデータとして持ち、src/app/privacy/page.tsx が LegalDocumentBody で描く。
 * 数は LEGAL_FACTS、名前・問い合わせ先・AI 事業者の一覧は ctx から埋める (このファイルに数・事業者名を直接書かない。
 * 委託先の名前だけは PRIVACY_PROCESSORS に持ち、tests/legal-text-1901.test.ts が evidence の実在を確かめる)。
 * 内容が変わる改定は packages/shared/src/legal-versions.ts の LEGAL_DOCUMENTS.privacy_policy.version を上げる (cross/20 §9)。
 */
import {
  LEGAL_DOCUMENT_PATHS,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  DSR_SETTINGS_PATH,
} from '@homegohan/shared';
import { AI_CONSENT_SETTINGS_PATH } from '@/lib/ai/consent-config';
import { SESSIONS_SETTINGS_PATH } from '@/lib/emails/account/login-new-device';
import { HOLIDAYS_API_ORIGIN } from '@/lib/security/csp';
import {
  CONTACT_PATH,
  LEGAL_FACTS,
  LEGAL_NOTICE_PATH,
  type LegalDocumentText,
  type LegalTextContext,
} from './legal-text';

/** 第10条の祝日の一覧の送り先のホスト (週間献立がブラウザから取得する。CSP の connect-src と同じ定数から作る) */
const HOLIDAYS_API_HOST = new URL(HOLIDAYS_API_ORIGIN).host;

/** プライバシーポリシーの条の見出し。順と数は privacyText の h3 と一致する */
export const PRIVACY_SECTION_HEADINGS = [
  '第1条（事業者の名称、代表者、連絡先）',
  '第2条（用語）',
  '第3条（取得する情報）',
  '第4条（利用目的）',
  '第5条（要配慮個人情報の取扱い）',
  '第6条（AI 機能と日本国外の事業者への提供）',
  '第7条（委託先と、外国にある事業者への委託）',
  '第8条（第三者提供）',
  '第9条（家族グループと組織での見え方）',
  '第10条（Cookie、端末内の保存、外部への送信）',
  '第11条（安全管理措置）',
  '第12条（保存期間）',
  '第13条（退会、削除、データの書き出し）',
  '第14条（開示、訂正、利用停止、消去などの請求）',
  '第15条（未成年者の個人情報）',
  '第16条（通知とメール）',
  '第17条（苦情と相談の窓口）',
  '第18条（本ポリシーの改定）',
] as const;

/** 条の数 (宣言)。実列挙と一致することをテストが確かめる */
export const PRIVACY_SECTION_COUNT = 18;

/**
 * 委託先の表の 1 行。evidence はリポジトリの中の根拠 (file にその needle が含まれる)。
 * needle は根拠のファイルの中の識別子にし、外部のホスト名や URL を書かない (送り先を 1 ファイルに限る走査テストが
 * このファイルを送信の場所と数えるため。設計書 cross/20 §7 の規則・T-7)。
 */
export interface PrivacyProcessor {
  readonly name: string;
  readonly country: string;
  readonly purpose: string;
  readonly data: string;
  readonly evidence: { readonly file: string; readonly needle: string };
}

/**
 * 委託先 (法 27 条 5 項 1 号) の一覧。実コードで実際にデータを渡している事業者だけを載せる。
 * 事業者を足したら、ここと tests/legal-text-1901.test.ts の両方に足し、プライバシーポリシーの版を上げる。
 * AI 事業者 (xai / google / openai / perplexity / aimlapi) はここではなく第6条 (ctx.aiProviders)。
 */
export const PRIVACY_PROCESSORS: readonly PrivacyProcessor[] = [
  {
    name: 'Supabase',
    country: 'アメリカ合衆国',
    purpose: '認証、データベース、写真などのファイルの保存、サーバー側の処理',
    data: 'アカウント、登録情報、ユーザーコンテンツ、同意の記録、ログなど本サービスのデータ全般',
    evidence: { file: 'package.json', needle: '@supabase/supabase-js' },
  },
  {
    name: 'Vercel',
    country: 'アメリカ合衆国',
    purpose: 'Web とサーバー処理のホスティング、画面の表示速度の計測',
    data: 'リクエストの内容（IP アドレス、ブラウザの種類、URL）、表示速度の計測値（URL のうち個人に関わる部分は送る前に消します）',
    evidence: { file: 'src/lib/speed-insights-scrub.ts', needle: '@vercel/speed-insights' },
  },
  {
    name: 'Google',
    country: 'アメリカ合衆国',
    purpose: 'Google アカウントでのログイン',
    data: 'ログインのときに Google と当社の間でやりとりする、Google アカウントの識別子、メールアドレス、名前、プロフィール画像（AI 機能での利用は第6条）',
    evidence: { file: 'src/app/(auth)/login/page.tsx', needle: "provider: 'google'" },
  },
  {
    name: 'Resend',
    country: 'アメリカ合衆国',
    purpose: 'メールの送信',
    data: '宛先のメールアドレス、件名、本文、配信の結果',
    evidence: { file: 'src/lib/emails/outbox.ts', needle: 'resend' },
  },
  {
    name: 'Stripe',
    country: 'アメリカ合衆国',
    purpose: '有料プランの決済、請求書、支払い方法の管理',
    data: 'メールアドレス、支払い情報（カード番号などは Stripe が直接受け取り、当社は保持しません）、契約と請求の情報',
    evidence: { file: 'src/lib/billing/core.ts', needle: 'stripe' },
  },
  {
    name: 'Upstash',
    country: 'アメリカ合衆国',
    purpose: '短時間の利用回数の制限（連打や大量送信の防止）',
    data: '利用者の ID、IP アドレス、宛先のハッシュをキーにした回数',
    evidence: { file: 'src/lib/rate-limit.ts', needle: '@upstash/ratelimit' },
  },
  {
    name: 'Expo',
    country: 'アメリカ合衆国',
    purpose: 'アプリのプッシュ通知の配信',
    data: '端末のプッシュ通知のトークン、通知の題名と本文',
    evidence: { file: 'src/lib/push/expo-transport.ts', needle: 'EXPO_PUSH_SEND_URL' },
  },
  {
    name: 'Cloudflare',
    country: 'アメリカ合衆国',
    purpose: 'ボットの判定（ログイン、登録、メールの確認、パスワードの再設定）と、暗号化したバックアップの保管',
    data: 'ボットの判定: ブラウザや端末の情報、IP アドレス。バックアップ: 暗号化したデータベースの内容',
    evidence: { file: 'src/lib/auth/turnstile-verify.ts', needle: 'siteverify' },
  },
  {
    name: 'GitHub',
    country: 'アメリカ合衆国',
    purpose: 'バックアップの取得処理の実行',
    data: '取得の処理中に一時的に扱うデータベースの内容（暗号化して保管先へ送ったあとは残しません）',
    evidence: { file: '.github/workflows/db-backup.yml', needle: 'apt-get install -y age' },
  },
];

export function privacyText(ctx: LegalTextContext): LegalDocumentText {
  const company = ctx.businessName;
  const f = LEGAL_FACTS;
  return {
    type: 'privacy_policy',
    preamble: [
      {
        kind: 'p',
        text: `${company}（以下「当社」といいます）は、当社が提供するサービス「ほめゴハン」（Web 版および iOS・Android 向けのアプリ版を含み、以下「本サービス」といいます）における、ユーザーの個人情報その他の情報の取扱いについて、個人情報の保護に関する法律（以下「個人情報保護法」といいます）その他の法令と、個人情報保護委員会のガイドラインに従い、次のとおりプライバシーポリシー（以下「本ポリシー」といいます）を定めます。`,
      },
    ],
    chapters: [
      {
        id: 'privacy-main',
        title: null,
        sections: [
          {
            id: 'privacy-1',
            heading: PRIVACY_SECTION_HEADINGS[0],
            blocks: [
              {
                kind: 'table',
                headers: ['項目', '内容'],
                rows: [
                  ['事業者の名称', company],
                  ['代表者', ctx.businessRepresentative],
                  ['所在地', ctx.addressDisclosure],
                  ['電話番号', ctx.addressDisclosure],
                  ['連絡先', `メール: ${ctx.supportEmail}（お問い合わせフォームからもご連絡いただけます）`],
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: 'お問い合わせフォーム', href: CONTACT_PATH },
                  { label: '特定商取引法に基づく表記', href: LEGAL_NOTICE_PATH },
                ],
              },
            ],
          },
          {
            id: 'privacy-2',
            heading: PRIVACY_SECTION_HEADINGS[1],
            blocks: [
              {
                kind: 'ul',
                items: [
                  '「個人情報」: 個人情報保護法 2 条 1 項にいう個人情報。生存する個人に関する情報で、氏名、生年月日、メールアドレスその他の記述により特定の個人を識別できるもの、または他の情報と容易に照合して識別できるもの。',
                  '「個人データ」「保有個人データ」: 個人情報保護法 16 条 3 項・4 項にいうもの。本サービスのデータベースに記録したユーザーの個人情報は、原則としてこれに当たります。',
                  '「要配慮個人情報」: 個人情報保護法 2 条 3 項にいうもの。本サービスでは、健康診断や血液検査の結果、病歴、服薬、妊娠の有無など、健康に関する情報がこれに当たります（第5条）。',
                  '「ユーザー」「ユーザーコンテンツ」「AI 機能」「AI 事業者」「家族グループ」「組織」「保護者」: 利用規約第2条の定義によります。',
                ],
              },
              { kind: 'links', items: [{ label: '利用規約', href: LEGAL_DOCUMENT_PATHS.terms_of_service }] },
            ],
          },
          {
            id: 'privacy-3',
            heading: PRIVACY_SECTION_HEADINGS[2],
            blocks: [
              { kind: 'p', text: '当社は、本サービスの提供のために、次の情報を取得します。ユーザーが自ら入力・撮影・アップロードするもののほか、本サービスの利用に伴って自動的に記録されるものがあります。' },
              {
                kind: 'table',
                headers: ['区分', '項目', '取得の方法'],
                rows: [
                  ['アカウント', 'メールアドレス、パスワード（ハッシュ化して保存し、元の文字列は保存しません）、Google アカウントでログインする場合は Google から受け取る識別子・メールアドレス・名前・プロフィール画像、生年月日、ニックネーム、同意した文書の版と日時', '登録と同意の画面での入力'],
                  ['プロフィール', '性別、年齢層、身長、体重、体脂肪率、目標、職業や勤務の形態、睡眠・運動・飲酒・喫煙などの生活習慣、食の好み、嫌いな調理法、宗教上の制限、食物アレルギー、持病・服薬・妊娠の有無（要配慮個人情報を含みます）', '初期設定とプロフィールの画面での入力（任意の項目を含みます）'],
                  ['食事と献立', '食事の写真、料理名、分量、栄養の推定値、食事の時間、ユーザーのメモ、食事へのコメント、冷蔵庫の写真と食材、献立、買い物リスト、レシピ、コレクション、いいね、コメント', '記録の画面での入力・撮影・アップロードと、AI 機能による推定'],
                  ['健康', '体重・体脂肪率・血圧などの記録、健康診断の写真と数値、血液検査の数値、健康の目標、これらへのコメント（要配慮個人情報を含みます）', '健康の画面での入力・撮影・アップロードと、AI 機能による読み取り'],
                  ['家族グループ', '家族グループの名前、メンバーの続柄、共有の設定、招待先のメールアドレス、保護者が登録する子どもの名前・生年月日・記録', '家族の画面での入力と招待'],
                  ['組織', '所属する組織、組織内の役割、組織に参加した日、組織からの招待（招待を受けたメールアドレス、役割、部署）、チャレンジへの参加と、チャレンジの集計のために食事の記録から計算する値', '組織の管理者による招待と、本サービスの利用'],
                  ['有料プラン', '決済代行事業者（Stripe）の顧客 ID、契約 ID、請求書 ID、契約の状態（カード番号などの決済情報は当社では保持しません）', '有料プランの申込みと決済代行事業者からの通知'],
                  ['お問い合わせ・サポート', 'お問い合わせの種類、件名、本文、メールアドレス、やりとりの履歴、満足度の回答', 'お問い合わせとサポートの画面での入力'],
                  ['同意の記録', '利用規約とプライバシーポリシーに同意した版・日時・IP アドレス・ブラウザや端末の種類。AI 機能のための日本国外の事業者への提供に同意した版・日時・IP アドレス・ブラウザや端末の種類。保護者の同意の署名（氏名）、親権者または法定代理人であることの確認、同意した版と日時、IP アドレス、ブラウザや端末の種類、署名の時点の子どもの生年月日と年齢', '同意の画面での操作（IP アドレスと端末の種類はサーバーが受け取った通信から取得します）'],
                  ['端末・利用状況・ログ', 'IP アドレス（ログインの履歴とログイン中のセッションの記録では、IP アドレスの全体に加えて、その IP アドレスが属するネットワークの範囲と、Web からのログインではホスティング事業者が通信から判定した国を記録します。これらは、ユーザー本人が設定画面の「ログイン中の端末・ログイン履歴」と新しい端末からのログインのお知らせのメールで確認でき、当社も運営の画面で確認することがあります）、ブラウザや端末の種類、アプリでの端末の機種名と OS の版（ユーザーが端末に付けた名前は使いません）、ログインの日時、ログイン中のセッション、プッシュ通知の宛先（トークン）、アプリの動作のログ（エラーの内容、処理の識別子）、ブラウザのセキュリティ違反の報告、AI 機能の利用回数、回数制限のための計数', '本サービスの利用に伴って自動的に記録'],
                  ['Cookie 等', '第10条のとおり', 'ブラウザとアプリ'],
                ],
              },
              { kind: 'p', text: '本サービスは、次の場面でだけ端末の機能を使います。アプリでは、端末が表示する許可の画面でユーザーの許可を得てから使い、許可は端末の設定からいつでも取り消せます。ブラウザでは、ブラウザの撮影・写真の選択の画面を通して、ユーザーが撮った写真または選んだ写真だけを受け取ります。' },
              {
                kind: 'table',
                headers: ['端末の機能', '使う場面', '許可しないとき'],
                rows: [
                  ['カメラ', 'ユーザーが、食事、冷蔵庫、健康診断や血液検査の写真を撮ることを選んだとき（アプリとブラウザ）。撮った写真は、第4条の目的で本サービスに保存し、AI 機能に使うときは第6条のとおり送ります', '撮影の機能は使えません。その他の機能は使えます'],
                  ['写真ライブラリ', 'ユーザーが、端末に保存した写真を選ぶとき。ユーザーが選んだ写真だけを受け取り、それ以外の写真は読み取りません', '写真の選択は使えません。その他の機能は使えます'],
                  ['通知', 'アプリへのプッシュ通知を受け取るとき（第16条）', '通知は届きません。その他の機能は使えます'],
                ],
              },
              { kind: 'p', text: '本サービスは、端末の位置情報、連絡先、マイクの音声を取得しません。' },
            ],
          },
          {
            id: 'privacy-4',
            heading: PRIVACY_SECTION_HEADINGS[3],
            blocks: [
              { kind: 'p', text: '当社は、取得した情報を次の目的で利用します。' },
              {
                kind: 'ul',
                items: [
                  '本サービスの提供（アカウントの管理、ログイン、記録の保存と表示、献立と買い物リストの作成、家族グループと組織の機能、バッジ、お知らせと通知）のため。',
                  'AI 機能の提供（写真の読み取り、栄養の推定、献立と買い物リストの作成、AI 相談への回答、健康診断や血液検査の結果へのコメント、健康に関するヒント、料理の画像の作成）のため。第6条のとおり、日本国外の AI 事業者への送信を含みます。',
                  '本人確認、なりすましや不正利用の防止、セキュリティの確保（ログインの履歴の記録、新しい端末からのログインの通知、ボットの判定、回数の制限、アカウントの凍結）のため。',
                  '年齢の確認と、未成年者についての保護者の同意の管理のため。',
                  '有料プランの契約、決済、請求、解約の管理のため。',
                  'お問い合わせ、サポート、個人情報の開示などの請求への対応と、そのための本人確認のため。',
                  '本サービスの重要なお知らせ、利用規約やプライバシーポリシーの改定の連絡、同意の取り直しのため。',
                  '本サービスの改善、不具合や障害の調査、個人を特定できない形での統計の作成のため。当社は、ユーザーの写真や記録を、当社自身が AI のモデルを学習させる目的には利用していません。',
                  '法令に基づく対応、権利の行使と防御のため。',
                  '当社の事業の承継のため（承継先に引き継ぐ場合に限ります）。',
                ],
              },
              { kind: 'p', text: '当社は、上の目的の達成に必要な範囲を超えて個人情報を利用しません。利用目的を変更するときは、変更前の目的と関連性があると合理的に認められる範囲で行い、本ポリシーの改定として公表します。' },
              { kind: 'p', text: '当社は、仮名加工情報および匿名加工情報（個人情報保護法 2 条 5 項・6 項）を作成していません。上の統計は、特定の個人と結びつかない集計の数値にとどめます。仮名加工情報または匿名加工情報を作成するときは、法令に従い、作成した情報に含まれる項目などを公表し、本ポリシーを改定します。' },
            ],
          },
          {
            id: 'privacy-5',
            heading: PRIVACY_SECTION_HEADINGS[4],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '本サービスで扱う情報のうち、健康診断や血液検査の結果、病歴、服薬、妊娠の有無などの健康に関する情報は、個人情報保護法の要配慮個人情報に当たります。食物アレルギーや体重・血圧などの記録も、健康に関する情報として同じ注意をもって取り扱います。',
                  'これらの情報の入力は任意です。入力しなくても、本サービスの他の機能は利用できます。当社は、ユーザー本人がこれらの情報を自ら入力・撮影・アップロードする操作をもって、要配慮個人情報の取得について本人の同意を得たものとして取り扱います。',
                  '保護者が家族グループの中で、本人のアカウントが無い子どもの健康に関する情報を記録する場合は、保護者の同意書に基づき、保護者の同意をもって取得します。',
                  'これらの情報を AI 機能のために日本国外の AI 事業者へ送るのは、第6条の同意がある場合に限ります。第6条のとおり、持病、服薬、妊娠・授乳の状況、健康診断や血液検査の結果は、AI 機能のために送る情報に含まれます。',
                  '健康に関する記録と、健康診断や血液検査の写真は、家族グループのメンバーにも組織の管理者にも表示されません（第9条）。',
                  '当社の運営担当者は、お問い合わせへの対応、投稿の審査、不正利用の調査、不具合の調査に必要な範囲でのみ、これらの情報と写真を取り扱い、運営担当者の操作は記録します。',
                  '要配慮個人情報を、本人の同意なく第三者に提供することはありません。本人の同意を得ずに行う第三者提供（いわゆるオプトアウトによる提供）は行いません。',
                ],
              },
            ],
          },
          {
            id: 'privacy-6',
            heading: PRIVACY_SECTION_HEADINGS[5],
            blocks: [
              { kind: 'p', text: '本サービスの AI 機能は、ユーザーが入力・撮影した内容を、日本国外にある次の事業者の AI に送って処理します。これらの事業者への提供は、個人情報保護法 28 条の「外国にある第三者への提供」として、次の情報をお示ししたうえで、ユーザー本人の同意を得て行います。' },
              { kind: 'ai_providers', providers: ctx.aiProviders },
              { kind: 'p', text: '送る情報は次のとおりです。' },
              {
                kind: 'ul',
                items: [
                  '食事の写真と食事の記録（料理名、栄養の数値など）',
                  '健康診断・血液検査の写真と数値',
                  'AI 相談に入力した文章と、それまでのやりとり',
                  '冷蔵庫の写真と食材の情報',
                  '献立の作成に使う、好み・アレルギー・健康目標などの情報',
                  '献立・買い物リストの料理名と食材の名前',
                  'プロフィールの情報（ニックネーム、年齢、性別、身長、体重、体脂肪率、目標、職業・業界・勤務の形態、睡眠・ストレス・便通・飲酒・喫煙などの生活習慣、家族の人数と子どもの年齢、調理や買い物の習慣、食費の予算、趣味など）',
                  '健康に関する情報（持病・健康上の注意点、服薬、妊娠・授乳の状況）。これらは要配慮個人情報に当たります（第5条）',
                ],
              },
              { kind: 'p', text: 'どの情報を送るかは、機能によって異なります。ニックネームは、AI 相談や献立の作成などで送ることがあります。ニックネームに実名を登録している場合は実名が送られることになるため、ニックネームには実名を使わないことをお勧めします。' },
              { kind: 'p', text: '利用する目的は、写真から料理・食材・数値を読み取るため、献立や栄養のアドバイスを作るため、AI 相談に回答するため、健康診断・血液検査の結果にコメントをつけるため、料理の栄養を推定し料理の画像を作るためです。' },
              { kind: 'p', text: '所在国の個人情報の保護に関する制度の情報は、次のとおりです。' },
              {
                kind: 'ul',
                items: [
                  'アメリカ合衆国: 民間部門を包括的に対象とする連邦の個人情報保護法はなく、分野ごとの連邦法と州法、および連邦取引委員会（FTC）による執行で規律されています。個人情報保護委員会が公表する「外国における個人情報の保護に関する制度等の調査」の結果に基づき、当社はこの制度の概要を把握しています。',
                  'エストニア: 欧州連合（EU）の加盟国で、EU 一般データ保護規則（GDPR）が適用されます。EU は、個人情報保護法 28 条 1 項に基づき個人情報保護委員会が定める、日本と同等の水準の保護制度を有する国・地域に含まれます。',
                ],
              },
              { kind: 'p', text: '各事業者が講じる個人情報の保護のための措置は、当社と各事業者との間の API の利用契約と、各事業者が公表する規約・ポリシーによります。送った内容は、各事業者のもとで、サービスの提供や不正利用の防止のために一定の期間保存されることがあります。保存の期間や扱いは事業者ごとに異なり、各事業者の規約に従います。' },
              {
                kind: 'ol',
                items: [
                  '同意は、AI 機能を初めて使うときに表示する同意画面で行います。同意の内容（事業者の一覧、送る情報、目的、保存）と、同意した版・日時・IP アドレス・端末の種類を記録します。',
                  '同意するまで、また同意を撤回した後は、当社のサーバーがユーザーのデータを AI 事業者へ送る手前で止めます。画面を開くと自動で動く AI の処理も行いません。',
                  '同意は、設定の「AI へのデータ提供の同意」からいつでも確認し、撤回できます。撤回すると AI 機能は利用できなくなり、再び利用するには改めて同意が必要です。',
                  '同意の文面や事業者の一覧を変更したときは、同意の版を更新し、AI 機能を使う前に改めて同意をお願いします。',
                  'AI 事業者への提供の記録として、同意の記録（同意した事業者、同意の版、日時、撤回した日時）を保存します。送る情報の項目と事業者は、同意の版ごとに、同意画面と本条に示したとおりです。第三者への提供の記録の開示の請求（第14条）には、この記録をもとにお答えします。同意の記録は、データの書き出し（第13条）にも含まれます。',
                ],
              },
              { kind: 'links', items: [{ label: 'AI へのデータ提供の同意（確認・撤回）', href: AI_CONSENT_SETTINGS_PATH }] },
            ],
          },
          {
            id: 'privacy-7',
            heading: PRIVACY_SECTION_HEADINGS[6],
            blocks: [
              { kind: 'p', text: '当社は、本サービスの提供に必要な範囲で、次の事業者に個人データの取扱いを委託しています。いずれも日本国外に本拠を置く事業者です。' },
              {
                kind: 'table',
                headers: ['事業者', '所在国', '用途', '渡る情報'],
                rows: PRIVACY_PROCESSORS.map((p) => [p.name, p.country, p.purpose, p.data]),
              },
              {
                kind: 'ol',
                items: [
                  '当社は、委託先との契約と各事業者の規約により、委託した業務の範囲を超えた利用の禁止、秘密の保持、安全管理措置の実施を確認し、委託先を監督します。',
                  '外国にある事業者への委託にあたっては、個人情報保護法 28 条 1 項に基づき、各事業者が個人情報保護法で求められる措置に相当する措置を継続的に講じるための体制を、当社と各事業者との契約により確保しています。ユーザーからの求めがあったときは、法令の定めに従い、その体制の概要、措置の実施状況の確認の方法、所在国の制度に関する情報を遅滞なく提供します。',
                  '委託先の所在国の制度に関する情報は、第6条のアメリカ合衆国についての記載と同じです。',
                ],
              },
            ],
          },
          {
            id: 'privacy-8',
            heading: PRIVACY_SECTION_HEADINGS[7],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、次の場合を除き、あらかじめユーザーの同意を得ることなく、個人データを第三者に提供しません。（a）法令に基づく場合。（b）人の生命、身体または財産の保護のために必要がある場合で、本人の同意を得ることが困難なとき。（c）公衆衛生の向上または児童の健全な育成の推進のために特に必要がある場合で、本人の同意を得ることが困難なとき。（d）国の機関や地方公共団体などが法令の定める事務を遂行することに協力する必要がある場合で、本人の同意を得ることによりその事務の遂行に支障を及ぼすおそれがあるとき。',
                  'AI 機能のための日本国外の AI 事業者への提供は、第6条の同意に基づいて行います。委託先への提供は、第7条のとおり、個人情報保護法上の第三者提供には当たりません。',
                  '家族グループのメンバーや組織の管理者に対する表示は、ユーザー自身の共有の設定、または組織への所属に基づいて行います（第9条）。',
                  '当社は、個人データの共同利用を行いません。本人の同意を得ずに行う第三者提供（オプトアウトによる提供）も行いません。',
                  '当社の事業を第三者に承継する場合は、承継先に個人データを引き継ぐことがあります。その場合、承継先は本ポリシーに従って個人データを取り扱います。',
                ],
              },
            ],
          },
          {
            id: 'privacy-9',
            heading: PRIVACY_SECTION_HEADINGS[8],
            blocks: [
              { kind: 'p', text: '家族グループのメンバーと組織の管理者には、それぞれ次の情報が表示されます。' },
              {
                kind: 'table',
                headers: ['情報', '家族グループのメンバー', '組織の管理者'],
                rows: [
                  ['ニックネーム', '表示されます', '表示名として表示されます'],
                  ['食事の記録', '本人の共有の設定に従います（初期設定では共有します）', '表示されません'],
                  ['写真（食事、冷蔵庫、健康診断、血液検査）', '表示されません', '表示されません'],
                  ['献立と買い物リスト', '本人の共有の設定に従います（初期設定では共有します）。家族としての献立と買い物リストはメンバーに表示されます', '表示されません'],
                  ['健康の記録、健康診断、血液検査', '表示されません（共有の設定の項目はありますが、現在、家族に健康の記録を表示する機能はありません）', '表示されません'],
                  ['AI 相談の内容', '表示されません', '表示されません'],
                  ['子ども（本人のアカウントが無い家族）の記録', '保護者または管理者が記録し、家族グループに表示されます', '表示されません'],
                  ['本人のアカウントをつないだ未成年者の記録', '上の各行のとおり、本人の共有の設定に従います（保護者も、ほかのメンバーと同じ扱いです）', '表示されません'],
                  ['登録したメールアドレス、ログインの履歴', '表示されません', '表示されません'],
                  ['招待の状況（招待先のメールアドレス、役割、承諾したかどうか）', '家族グループへの招待は、家族グループの代表者と大人のメンバーに表示されます', '組織への招待（部署を含みます）は、組織の管理者に表示されます'],
                  ['組織内の役割、組織に参加した日', '—', '表示されます'],
                  ['組織のメンバー数、部署ごとの人数', '—', '表示されます'],
                  ['チャレンジ', '—', '参加人数と、食事の記録から計算した平均だけが表示されます（参加者が一定の人数に満たないときは表示されません）。順位は参加者どうしにのみ表示され、参加者の表示名を出すかどうかは本サービスの設定によります（出さないことが初期設定です）'],
                  ['健康に関する集計（体重や食事の傾向など）', '—', '表示されません'],
                ],
              },
              { kind: 'p', text: '共有の設定は、家族の画面からいつでも変更できます。家族グループから退出すると、その後の記録はメンバーに表示されません。' },
            ],
          },
          {
            id: 'privacy-10',
            heading: PRIVACY_SECTION_HEADINGS[9],
            blocks: [
              { kind: 'p', text: '本サービスは、ユーザーのブラウザや端末に情報を保存し、または端末から外部の事業者へ情報を送信させることがあります。電気通信事業法の外部送信規律の趣旨に従い、その内容を次のとおり公表します。当社は、広告のための Cookie やアクセス解析のための第三者の Cookie を使用しておらず、第三者の広告も配信していません。そのため、Cookie の同意を求めるバナーは置いていません。' },
              {
                kind: 'table',
                headers: ['保存先・送信先', '情報の内容', '目的', '停止の方法'],
                rows: [
                  ['Supabase（当社の委託先。ブラウザとアプリから直接）', 'ログインの状態を示す識別子、読み書きするデータ、IP アドレス、ブラウザや端末の種類', 'ログイン、記録の保存と表示、写真の表示（第7条）', '本サービスの利用に必要な通信のため、停止はできません'],
                  ['当社（ブラウザの Cookie。認証の仕組みの Cookie を含みます）', 'ログインの状態を保つための識別子', 'ログインの維持、画面の表示の制御', `ログアウトすると消えます。一定期間（${f.sessionIdleExpireDays} 日）操作が無いセッションは失効します。本サービスの利用に必要な Cookie のため、停止はできません`],
                  ['当社（アプリ内のブラウザ（WebView）の保存領域）', 'ログインの状態、画面の設定', 'アプリでの画面の表示', 'ログアウトのときに利用者ごとに消去します'],
                  ['Vercel（表示速度の計測）', 'ページの URL（クエリ文字列と招待のトークンは送る前に消します）、表示速度の計測値、ブラウザの種類', '画面の表示速度の改善', '計測は個人を特定しない形で行い、停止の設定はありません'],
                  ['Cloudflare（Turnstile）', 'ブラウザや端末の情報、IP アドレス', 'ログイン、登録、メールの確認、パスワードの再設定の画面でのボットの判定', '判定を通らないと送信できないため、停止はできません'],
                  ['Stripe（決済の画面）', 'Stripe の画面で入力する情報、Stripe が設定する Cookie', '有料プランの決済と支払い方法の管理', '有料プランを申し込まなければ発生しません'],
                  ['Google（ログインの画面）', 'Google のログイン画面で Google が取得する情報', 'Google アカウントでのログイン', 'メールアドレスでの登録を選べば発生しません'],
                  [`GitHub（GitHub Pages の祝日の一覧。${HOLIDAYS_API_HOST}）`, '取得する年、IP アドレス、ブラウザの種類（ユーザーの記録は送りません）', '週間献立のカレンダーに日本の祝日を表示するため', '週間献立の画面を開かなければ発生しません'],
                  ['Expo（プッシュ通知）', '端末のプッシュ通知のトークン', 'アプリへの通知の配信', '端末の設定で通知を許可しなければ発生しません'],
                ],
              },
              { kind: 'p', text: 'カメラ、写真ライブラリ、通知などの端末の機能へのアクセスは、第3条のとおりです。' },
              { kind: 'links', items: [{ label: '設定（ログイン中の端末・ログイン履歴）: ログイン中のセッションの確認と失効', href: SESSIONS_SETTINGS_PATH }] },
            ],
          },
          {
            id: 'privacy-11',
            heading: PRIVACY_SECTION_HEADINGS[10],
            blocks: [
              { kind: 'p', text: '当社は、個人データの漏えい、滅失、毀損を防ぐため、次の安全管理措置を講じています。' },
              {
                kind: 'ul',
                items: [
                  '基本方針: 個人情報保護法と関係するガイドラインを遵守し、本ポリシーを定めて公表しています。',
                  '取扱いの規律: 個人データを扱う機能の設計を文書に定め、変更のたびに審査と自動テストを行っています。',
                  '組織的な措置: 運営の権限を役割ごとに分け、運営担当者の操作を記録しています。運営担当者のうち、管理者の権限などを持つ担当者のログインには、多要素認証を求めています。漏えいなどが生じたときは、法令に従い個人情報保護委員会への報告と本人への通知を行います。',
                  '物理的な措置: 本サービスのデータは、委託先のクラウド事業者のデータセンターで保管し、入退室管理などの物理的な措置は各事業者の管理に依拠しています。',
                  '技術的な措置: 通信の暗号化、パスワードのハッシュ化、本人の行だけを読み書きできるデータベースのアクセス制御、写真の非公開の保存と有効期限つきの URL による表示、回数の制限とボットの判定、ブラウザのセキュリティ設定（CSP）、ログにメールアドレスなどを残さない処理、バックアップの暗号化（復号の鍵を持つ者を限り、復旧の目的以外で開きません）、退会時の即時削除。',
                  '外的環境の把握: 委託先と AI 事業者の所在国（アメリカ合衆国、エストニア）の個人情報の保護に関する制度を把握したうえで、個人データを取り扱っています（第6条・第7条）。',
                ],
              },
            ],
          },
          {
            id: 'privacy-12',
            heading: PRIVACY_SECTION_HEADINGS[11],
            blocks: [
              { kind: 'p', text: '当社は、個人データを次の期間保存し、期間を過ぎたものは削除または個人を特定できない形にします。' },
              {
                kind: 'table',
                headers: ['情報', '保存の期間'],
                rows: [
                  ['アカウント、登録情報、ユーザーコンテンツ、利用規約・プライバシーポリシーと AI 機能への同意の記録（同意したときの IP アドレスと端末の種類を含みます）', '退会するまで。退会すると直ちに削除します（第13条）'],
                  ['保護者として署名した同意の記録（署名した氏名、日時、IP アドレス、端末の種類、子どもの生年月日の写しなど）', '同意の根拠として保存します。署名した保護者が退会しても、保護者のアカウントとの紐づけを外して残します。家族グループの記録が削除されると、あわせて削除します'],
                  ['当社が非表示にしたコンテンツ', `非表示にしてから ${f.hiddenContentRetentionDays} 日`],
                  ['ログインの履歴とセッションの記録', `セッションが失効してから ${f.loginHistoryRetentionDays} 日。セッションは ${f.sessionIdleExpireDays} 日間操作が無いと失効します`],
                  ['アプリの動作のログ（ブラウザのセキュリティ違反の報告を含みます）', `${f.appLogRetentionDays} 日`],
                  ['プッシュ通知の宛先（トークン）', '退会するまで。アプリでログアウトしたときと、通知の事業者から宛先が無効と知らされたときは、その端末の宛先をその時点で削除します'],
                  ['AI 機能の利用回数（日ごと・機能ごとの回数）', '退会するまで。退会すると直ちに削除します'],
                  ['回数の制限のための計数', '制限の判定に使う期間が過ぎた後、自動的に消えます'],
                  ['メールとプッシュ通知の送信待ちの記録', `送れたものは ${f.outboxSentRetentionDays} 日、送れなかったものは ${f.outboxDeadRetentionDays} 日。退会すると宛先・件名・本文を伏せます`],
                  ['お問い合わせとサポートの記録', '期限を定めずに保存します。退会すると、ユーザーとの紐づけを外し、お問い合わせのメールアドレスを伏せて残します（件名と本文はそのまま残ります。本文に氏名や連絡先を書いた場合は、それも残ります）'],
                  ['法令上の保存義務や、不正利用の防止、会計のために必要な記録（クーポンや紹介の利用記録、運営担当者の操作の記録）', '退会後も、ユーザーとの紐づけを外して残します。保存の期限は法令と当社の定めによります'],
                  ['メールの送信停止の記録（苦情や配信の失敗があったメールアドレス）', '再び送らないために、退会後もメールアドレスのまま残します（第16条）'],
                  ['退会の記録', '退会した日時と理由を、ユーザーを特定できない形（識別子のハッシュ）で残します'],
                  ['データベースのバックアップ', `日次のものは ${f.backupDailyRetentionDays} 日、週次のものは ${f.backupWeeklyRetentionDays} 日、年次のものは ${f.backupAnnualRetentionDays} 日（${f.backupAnnualRetentionYears} 年）。暗号化して保管し、障害からの復旧の目的以外では開きません。退会したユーザーのデータも、取得の時点のものはこの期間残ります`],
                  ['AI 事業者に送った内容', '各事業者の規約によります（第6条）'],
                  ['決済代行事業者の記録', '退会すると、決済代行事業者に残る当社の顧客の情報から氏名とメールアドレスを消します。取引の記録は決済代行事業者の規約と法令によります'],
                ],
              },
            ],
          },
          {
            id: 'privacy-13',
            heading: PRIVACY_SECTION_HEADINGS[12],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'ユーザーは、いつでも退会できます。退会は設定画面から行い、退会すると、アカウントと、アカウントに紐づく個人データ（食事、献立、健康の記録、写真、家族グループのメンバーとしての情報など）を直ちに削除します。削除は取り消せません。利用規約や本ポリシーの改定後、改めて同意するまでの間は、設定画面を利用できないため、利用規約第24条2項のとおり、お問い合わせから削除を依頼してください。',
                  '退会後も残るものは、利用規約第17条と本ポリシー第12条のとおりです。ユーザーが公開したレシピは、ユーザーとの紐づけを外して匿名の状態で残ります。',
                  'ユーザーは、設定画面から、自分の個人データを機械で読める形式（JSON）で書き出すことができます。アカウントの凍結中も、退会と書き出しは行えます。利用規約や本ポリシーの改定後、改めて同意するまでの間は、書き出しの代わりに、第14条の開示の請求により個人データの開示を求めることができます。',
                  '組織のオーナーと家族グループの代表者は、退会の前に譲渡または解散が必要です。',
                ],
              },
            ],
          },
          {
            id: 'privacy-14',
            heading: PRIVACY_SECTION_HEADINGS[13],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'ユーザーは、当社に対し、個人情報保護法の定めに従い、保有個人データの利用目的の通知、開示（第三者への提供の記録の開示を含みます）、内容の訂正・追加・削除、利用の停止・消去、第三者への提供の停止を請求できます。',
                  `請求は、設定の「個人情報の開示・訂正・利用停止・消去の請求」から行います。請求の種類と内容を送ると、登録されたメールアドレスへ本人確認のリンクを送ります。リンクは送信から ${f.dsrVerificationTtlHours} 時間有効で、確認のメールは 1 つの請求につき ${f.dsrVerificationMaxSends} 回まで送り直せます。本人確認が済んだ時点で請求を受け付け、受付の番号をお知らせします。`,
                  `当社は、本人確認が済んだ請求に遅滞なく対応します。対応は、本人確認が済んだ日から ${f.dsrResponseDueDaysDefault} 日以内を目安とし、結果をメールと画面でお知らせします。目安の期間内に対応できないときは、その理由と見込みをお知らせします。請求の進み具合は、同じ画面で確認できます。`,
                  '法令により開示などに応じられない場合（本人または第三者の生命、身体、財産その他の権利利益を害するおそれがある場合、当社の業務の適正な実施に著しい支障を及ぼすおそれがある場合、他の法令に違反することとなる場合など）は、その旨と理由をお知らせします。',
                  '開示は、本サービスの画面での表示、またはデータの書き出し（JSON）により行います。請求の手数料はいただきません。',
                  'アカウントが凍結されている方、退会した方、ログインできない方、および代理人による請求は、お問い合わせフォームまたはメールで受け付け、別途本人確認（代理人の場合は代理権の確認を含みます）を行います。',
                  '消去の請求は、本人による退会（第13条）で完了することがあります。利用の停止の請求は、当社が請求の内容を確認し、停止の方法をご案内します。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: '個人情報の開示・訂正・利用停止・消去の請求', href: DSR_SETTINGS_PATH },
                  { label: 'お問い合わせフォーム', href: CONTACT_PATH },
                ],
              },
            ],
          },
          {
            id: 'privacy-15',
            heading: PRIVACY_SECTION_HEADINGS[14],
            blocks: [
              {
                kind: 'ol',
                items: [
                  `${f.adultAgeYears} 歳未満の方の個人情報は、保護者の同意を得て取得します。${f.coppaAgeYears} 歳以上 ${f.adultAgeYears} 歳未満の方は、保護者が家族グループに追加し、保護者の同意書に同意したうえで、本人のアカウントをつなぐことで本サービスを利用できます。${f.coppaAgeYears} 歳未満の方の本人名義のアカウントは作成せず、保護者が家族グループの記録として代わりに記録します。`,
                  `保護者が家族グループの中で代わりに記録できるのは、本人のアカウントが無い子ども（${f.coppaAgeYears} 歳未満の子どもなど）の記録に限ります。本人のアカウントをつないだ未成年者の記録が保護者に表示されるかどうかは、本人の共有の設定によります（第9条）。未成年者の個人情報の開示などの請求は、本人または保護者から受け付けます。`,
                  '生年月日は年齢の確認のために用い、保護者の同意が必要な方を判定するために使います。',
                ],
              },
              { kind: 'links', items: [{ label: '保護者の同意書', href: PARENTAL_CONSENT_DOCUMENT_PATH }] },
            ],
          },
          {
            id: 'privacy-16',
            heading: PRIVACY_SECTION_HEADINGS[15],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'プッシュ通知は、設定画面と端末の設定で止めることができます。止めると、プッシュ通知は届かなくなります。',
                  '当社がお送りするメール（アカウントやログインのお知らせ、本人確認、家族グループや組織の招待とお知らせ、お問い合わせへの返信、第14条の請求への対応など）は、本サービスの利用に伴う連絡のためのもので、配信を止める設定はありません。',
                  '当社からのメールについて苦情が寄せられたとき、または届かない状態が続いたときは、そのメールアドレスへの送信を止めます。この送信停止の記録は、再び送らないために、退会後も残します。',
                ],
              },
            ],
          },
          {
            id: 'privacy-17',
            heading: PRIVACY_SECTION_HEADINGS[16],
            blocks: [
              { kind: 'p', text: '個人情報の取扱いに関する苦情やご相談は、次の窓口で受け付け、適切かつ迅速に対応します。' },
              { kind: 'contact', lines: [`${company} 個人情報担当`], email: ctx.supportEmail },
              { kind: 'links', items: [{ label: 'お問い合わせフォーム', href: CONTACT_PATH }] },
            ],
          },
          {
            id: 'privacy-18',
            heading: PRIVACY_SECTION_HEADINGS[17],
            blocks: [
              {
                kind: 'ol',
                items: [
                  '当社は、法令の改正や本サービスの変更に応じて、本ポリシーを改定することがあります。内容が変わる改定をするときは、改定の概要と施行日を施行日の前に本サービスのお知らせに掲載します。改定後の内容は、施行日からこのページに表示します。',
                  '個人情報の利用目的、第三者への提供、日本国外の事業者への提供など、内容が変わる改定を行ったときは、本ポリシーの版を更新し、ユーザーが次に本サービスを利用するときに改めて同意をお願いします。同意するまでの間の取扱いは、利用規約第24条のとおりです。',
                  '本ポリシーの版と施行日は、このページの冒頭に表示します。改定前の版は当社が保管し、お問い合わせによりご提供します。',
                ],
              },
            ],
          },
          {
            id: 'privacy-supplementary',
            heading: '附則',
            blocks: [
              { kind: 'p', text: '本ポリシーは、このページの冒頭に表示する施行日から適用します。' },
            ],
          },
        ],
      },
    ],
  };
}
```

---

## 8. 正典コード: 型・定数・描画部品・ページ

### 8.1 型と定数 (`src/lib/legal/legal-text.ts`。単独で型検査を通る)

```ts
/**
 * 利用規約・プライバシーポリシーの文面の型と、文面が埋める製品の定数の写し (#1901・設計書 cross/20 §8.1)。
 * React を import しない (サーバー・テスト・将来のモバイルから素のまま読める)。
 */
import type { LegalDocumentType } from '@homegohan/shared';

/** AI 事業者の 1 行 (src/lib/ai/consent-config.ts の AiConsentProviderInfo の表示用の写し。ページが作る) */
export interface AiProviderLine {
  readonly name: string;
  readonly country: string;
  readonly usage: string;
}

/** 文面の中で製品の定数から埋める値。ページ (src/app/terms, src/app/privacy) が組み立てる */
export interface LegalTextContext {
  /** 事業者の正式名称 (src/lib/business-info.ts の BUSINESS_NAME) */
  readonly businessName: string;
  /** 代表者 (BUSINESS_REPRESENTATIVE) */
  readonly businessRepresentative: string;
  /** 所在地・電話番号の欄に出す文 (DISCLOSED_ON_REQUEST) */
  readonly addressDisclosure: string;
  /** 問い合わせ先 (src/lib/site-config.ts の getSupportEmail()) */
  readonly supportEmail: string;
  /** AI 事業者の一覧 (AI_CONSENT_PROVIDERS の順)。利用規約では空でよい */
  readonly aiProviders: readonly AiProviderLine[];
}

export type LegalBlock =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'ul'; readonly items: readonly string[] }
  | { readonly kind: 'ol'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'links'; readonly items: readonly { readonly label: string; readonly href: string }[] }
  | { readonly kind: 'ai_providers'; readonly providers: readonly AiProviderLine[] }
  | { readonly kind: 'contact'; readonly lines: readonly string[]; readonly email: string };

export interface LegalSection {
  /** ページ内のアンカー (例: terms-9)。他の画面が /terms#terms-9 で参照できる */
  readonly id: string;
  /** h3 の文 (条の見出し。番号を含む) */
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export interface LegalChapter {
  readonly id: string;
  /** h2 の文。null なら h2 を出さない (プライバシーポリシーは章を持たない) */
  readonly title: string | null;
  readonly sections: readonly LegalSection[];
}

export interface LegalDocumentText {
  readonly type: LegalDocumentType;
  /** 条の前に出す前文 (無ければ省略) */
  readonly preamble?: readonly LegalBlock[];
  readonly chapters: readonly LegalChapter[];
}

/**
 * 文面からリンクするページ。既存の画面のパス (定数が無いものはここで決める)。
 * ログイン中の端末・ログイン履歴の画面は既存の SESSIONS_SETTINGS_PATH (src/lib/emails/account/login-new-device.ts) を
 * 文面モジュールが直接 import する (ここで同じ値を二重に持たない)。
 */
export const CONTACT_PATH = '/contact';
export const LEGAL_NOTICE_PATH = '/legal';
export const PRICING_PATH = '/pricing';
export const BILLING_PATH = '/account/billing';

/**
 * 文面が埋める数。製品の定数・migration・設計書の値の写しで、tests/legal-text-1901.test.ts が正本と突き合わせる
 * (文面モジュールに意味のある数を直接書かないための置き場。正本が変わったらここも変え、内容が変わるならポリシーの版を上げる)。
 */
export const LEGAL_FACTS = {
  /** 18 歳未満は保護者の同意 (packages/shared/src/parental-consent.ts ADULT_AGE_YEARS) */
  adultAgeYears: 18,
  /** 13 歳未満の本人アカウントは作らない (同 COPPA_AGE_YEARS) */
  coppaAgeYears: 13,
  /** 非表示にしたコンテンツを消すまでの日数 (src/lib/admin/hidden-content-restore.ts HIDDEN_CONTENT_RETENTION_DAYS) */
  hiddenContentRetentionDays: 90,
  /** app_logs の保持 (supabase/migrations/20251126124224_create_meal_planner_tables.sql の DELETE ... INTERVAL '30 days') */
  appLogRetentionDays: 30,
  /** 失効したセッションの記録の保持 (src/lib/auth/sessions/constants.ts LOGIN_HISTORY_RETENTION_DAYS) */
  loginHistoryRetentionDays: 90,
  /** 無操作で失効するまでの日数 (同 SESSION_IDLE_EXPIRE_DAYS) */
  sessionIdleExpireDays: 30,
  /** 送れた送信待ちの行の保持 (email_outbox / push_outbox の migration の c_sent_retention) */
  outboxSentRetentionDays: 7,
  /** 送れなかった行の保持 (同 c_dead_retention) */
  outboxDeadRetentionDays: 30,
  /** バックアップの保持 (docs/design/cross/17-backup-automation.md §9.1 の R2 Lifecycle) */
  backupDailyRetentionDays: 30,
  backupWeeklyRetentionDays: 366,
  backupAnnualRetentionDays: 2557,
  /** 年次の保持を年で言い直した値 (2,557 日 = 7 年。cross/17 §9.1 の表記) */
  backupAnnualRetentionYears: 7,
  /** 開示等の請求の本人確認リンクの有効時間 (src/lib/data-subject-requests/core.ts DSR_VERIFICATION_TTL_HOURS) */
  dsrVerificationTtlHours: 24,
  /** 確認メールを送れる回数 (同 DSR_VERIFICATION_MAX_SENDS) */
  dsrVerificationMaxSends: 5,
  /** 応答期限の既定 (同 DSR_RESPONSE_DUE_DAYS_DEFAULT。環境変数 DSR_RESPONSE_DUE_DAYS で上書きされうるので「目安」と書く) */
  dsrResponseDueDaysDefault: 30,
  /**
   * 代表者・オーナーが何日ログインしていないと、運営の一覧 (譲渡・解散の候補) に出るか。正本は一覧の判定:
   * supabase/migrations の list_families_with_inactive_representative / list_orgs_with_inactive_owner の最新の定義の
   * INTERVAL '30 days' (見出しの文「30日以上未ログイン…」も同じ値)。解散の理由の入力欄の例文 (placeholder) の日数は判定ではない
   */
  inactiveRepresentativeDays: 30,
  /** 責任の上限に使う、損害が生じた時より前の月数 (利用規約第21条 2 項の定め。製品の定数ではなく本書 §6 で決めた値。料金を受け取っていないユーザーには上限を適用しない) */
  liabilityCapMonths: 12,
} as const;
```

### 8.2 描画部品 (`src/components/legal/LegalDocumentBody.tsx`)

```ts
// tsc:skip
// place=src/components/legal/LegalDocumentBody.tsx (新設モジュール同士の import のため単独検査から外す)
import Link from 'next/link';
import type { LegalBlock, LegalDocumentText } from '@/lib/legal/legal-text';

/**
 * 利用規約・プライバシーポリシーの本文を描く (#1901)。文面は src/lib/legal の termsText / privacyText が作り、
 * ここは章を h2・条を h3・ブロックを p / ul / ol / table / リンクの一覧 / AI 事業者の一覧 / 窓口 に写すだけ。
 * AI 事業者の一覧の <ul data-testid="privacy-ai-providers"> と行の形「名前（国）：使い道」は
 * tests/business-info-legal-pages.test.ts が検査する (#1366 の形をそのまま引き継ぐ)。
 */
function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'p':
      return <p>{block.text}</p>;
    case 'ul':
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <table>
          <thead>
            <tr>
              {block.headers.map((h) => (
                <th key={h} scope="col">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.join('|')}>
                {row.map((cell, i) => (
                  <td key={`${i}-${cell}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'links':
      return (
        <ul data-legal-links="">
          {block.items.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="underline underline-offset-4 text-orange-700 hover:text-orange-800">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      );
    case 'ai_providers':
      return (
        <ul data-testid="privacy-ai-providers">
          {block.providers.map((p) => (
            <li key={p.name}>
              {p.name}（{p.country}）：{p.usage}
            </li>
          ))}
        </ul>
      );
    case 'contact':
      return (
        <p>
          {block.lines.map((line) => (
            <span key={line}>
              {line}
              <br />
            </span>
          ))}
          E-mail: {block.email}
        </p>
      );
  }
}

export function LegalDocumentBody({ document }: { document: LegalDocumentText }) {
  return (
    <>
      {document.preamble?.map((block, i) => <Block key={`preamble-${i}`} block={block} />)}
      {document.chapters.map((chapter) => (
        <section key={chapter.id} id={chapter.id}>
          {chapter.title !== null && <h2>{chapter.title}</h2>}
          {chapter.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h3>{section.heading}</h3>
              {section.blocks.map((block, i) => (
                <Block key={`${section.id}-${i}`} block={block} />
              ))}
            </section>
          ))}
        </section>
      ))}
    </>
  );
}
```

- `key` に文そのものを使うのは、同じ条の中に同じ文が 2 回出ないため (出たら実装者は index を足す)。
- 既存の `<main>` の Tailwind の子セレクタ (`[&_h3]…`) に、`[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-gray-900 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:mb-4 [&_table]:w-full [&_table]:text-sm [&_th]:text-left [&_th]:align-top [&_th]:p-2 [&_th]:border-b [&_td]:align-top [&_td]:p-2 [&_td]:border-b` を足す (§8.3)。

### 8.3 ページ (差し替え後の全文)

```ts
// tsc:skip
// place=src/app/terms/page.tsx (新設モジュール同士の import のため単独検査から外す)
import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocumentBody } from "@/components/legal/LegalDocumentBody";
import { LegalDocumentMeta } from "@/components/legal/LegalDocumentMeta";
import { BUSINESS_NAME, BUSINESS_REPRESENTATIVE, DISCLOSED_ON_REQUEST } from "@/lib/business-info";
import { termsText } from "@/lib/legal/terms-text";
import { publicPageMetadata } from "@/lib/seo/public-pages";
import { getSupportEmail } from "@/lib/site-config";

// #1174 (同意の前提): 未ログインでも読める公開ページ。サインアップ画面・LP フッターの同意リンクの着地点なので、
// (main) グループ (ログイン後の画面。アプリ用のナビ付き) の外に置く。
// ログイン・オンボーディング・凍結の差し戻しからは、lib/supabase/middleware.ts の publicPaths と
// lib/onboarding-routing.ts の isPolicyPath で除外している。
// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
// #1901: 本文は src/lib/legal/terms-text.ts (設計書 cross/20 §6) が正本。このファイルは文を持たない
export const metadata: Metadata = publicPageMetadata("/terms");

const MAIN_CLASS =
  "p-6 max-w-3xl mx-auto text-gray-700 leading-relaxed " +
  "[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-gray-900 " +
  "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:text-gray-900 " +
  "[&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1 " +
  "[&_table]:mb-4 [&_table]:w-full [&_table]:text-sm [&_th]:text-left [&_th]:align-top [&_th]:p-2 [&_th]:border-b " +
  "[&_td]:align-top [&_td]:p-2 [&_td]:border-b";

export default function TermsPage() {
  const document = termsText({
    businessName: BUSINESS_NAME,
    businessRepresentative: BUSINESS_REPRESENTATIVE,
    addressDisclosure: DISCLOSED_ON_REQUEST,
    supportEmail: getSupportEmail(),
    aiProviders: [],
  });
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto p-6 flex items-center gap-4">
          <Link href="/" aria-label="トップページへ戻る" className="p-2 -ml-2 hover:bg-gray-50 rounded-full">
            <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </Link>
          <h1 className="text-xl font-bold text-gray-900">利用規約</h1>
        </div>
      </header>

      <main className={MAIN_CLASS}>
        {/* 版・施行日は packages/shared の LEGAL_DOCUMENTS (同意の記録に使う版と同じ値) から出す */}
        <LegalDocumentMeta type="terms_of_service" />
        <LegalDocumentBody document={document} />
      </main>

      <footer className="py-8 border-t border-gray-100">
        <p className="text-center text-sm text-gray-500">© 2025 ほめゴハン All rights reserved.</p>
      </footer>
    </div>
  );
}
```

```ts
// tsc:skip
// place=src/app/privacy/page.tsx (新設モジュール同士の import のため単独検査から外す)
import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocumentBody } from "@/components/legal/LegalDocumentBody";
import { LegalDocumentMeta } from "@/components/legal/LegalDocumentMeta";
import { AI_CONSENT_PROVIDERS, AI_CONSENT_PROVIDER_INFO } from "@/lib/ai/consent-config";
import { BUSINESS_NAME, BUSINESS_REPRESENTATIVE, DISCLOSED_ON_REQUEST } from "@/lib/business-info";
import { privacyText } from "@/lib/legal/privacy-text";
import { publicPageMetadata } from "@/lib/seo/public-pages";
import { getSupportEmail } from "@/lib/site-config";

// #1174 (同意の前提): 未ログインでも読める公開ページ。サインアップ画面・LP フッターの同意リンクと、
// ストア審査に出すプライバシー URL の着地点なので、(main) グループ (ログイン後の画面。アプリ用のナビ付き) の外に置く。
// ログイン・オンボーディング・凍結の差し戻しからは、lib/supabase/middleware.ts の publicPaths と
// lib/onboarding-routing.ts の isPolicyPath で除外している。
// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
// #1901: 本文は src/lib/legal/privacy-text.ts (設計書 cross/20 §7) が正本。このファイルは文を持たない。
// #1366: AI 事業者の一覧は、同意画面と同じ AI_CONSENT_PROVIDERS / AI_CONSENT_PROVIDER_INFO から作って渡す
//        (実際の送信先と同意の一覧は tests/ai-consent-provider-inventory.test.ts が突き合わせている)
export const metadata: Metadata = publicPageMetadata("/privacy");

const MAIN_CLASS =
  "p-6 max-w-3xl mx-auto text-gray-700 leading-relaxed " +
  "[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-gray-900 " +
  "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:text-gray-900 " +
  "[&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1 " +
  "[&_table]:mb-4 [&_table]:w-full [&_table]:text-sm [&_th]:text-left [&_th]:align-top [&_th]:p-2 [&_th]:border-b " +
  "[&_td]:align-top [&_td]:p-2 [&_td]:border-b";

export default function PrivacyPage() {
  const document = privacyText({
    businessName: BUSINESS_NAME,
    businessRepresentative: BUSINESS_REPRESENTATIVE,
    addressDisclosure: DISCLOSED_ON_REQUEST,
    supportEmail: getSupportEmail(),
    aiProviders: AI_CONSENT_PROVIDERS.map((id) => {
      const info = AI_CONSENT_PROVIDER_INFO[id];
      return { name: info.name, country: info.country, usage: info.usage };
    }),
  });
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto p-6 flex items-center gap-4">
          <Link href="/" aria-label="トップページへ戻る" className="p-2 -ml-2 hover:bg-gray-50 rounded-full">
            <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </Link>
          <h1 className="text-xl font-bold text-gray-900">プライバシーポリシー</h1>
        </div>
      </header>

      <main className={MAIN_CLASS}>
        {/* 版・施行日は packages/shared の LEGAL_DOCUMENTS (同意の記録に使う版と同じ値) から出す */}
        <LegalDocumentMeta type="privacy_policy" />
        <LegalDocumentBody document={document} />
      </main>

      <footer className="py-8 border-t border-gray-100">
        <p className="text-center text-sm text-gray-500">© 2025 ほめゴハン All rights reserved.</p>
      </footer>
    </div>
  );
}
```

- `MAIN_CLASS` は 2 ページで同じ文字列で、各ページのローカルの定数として上のとおり置く (export しない)。共通の定数 (`LEGAL_MAIN_CLASS` など) は新設しない (文面モジュールにスタイルを持ち込まず、描画部品の公開面も増やさないため。§15)。
- `tests/policy-pages-public.test.tsx` の「`<main>` の先頭は `legal-document-meta`」「h1 は 1 つ」「header の a は `/`」「ソースに『最終更新日』が無く `LegalDocumentMeta` がある」はそのまま満たす。
- フッターの `© 2025` は本書の範囲外 (§17 の候補行)。

### 8.4 再エクスポート (`src/lib/legal/index.ts`)

```ts
// tsc:skip
// place=src/lib/legal/index.ts
export * from './legal-text';
export { termsText, TERMS_ARTICLE_HEADINGS, TERMS_ARTICLE_COUNT, TERMS_MEDICAL_DISCLAIMER, TERMS_EMERGENCY_NOTICE } from './terms-text';
export { privacyText, PRIVACY_SECTION_HEADINGS, PRIVACY_SECTION_COUNT, PRIVACY_PROCESSORS, type PrivacyProcessor } from './privacy-text';
```

---

## 9. 版の上げ方と、版を上げたときに起きること

### 9.1 版 (`packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS`)

```ts
/** 同意を求める文書の種類。terms_acceptances.document_type の値と同じ (既存。変えない) */
export const LEGAL_DOCUMENT_TYPES = ['terms_of_service', 'privacy_policy'] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export interface LegalDocumentInfo {
  version: string;
  effectiveDate: string;
}

/**
 * #1901 (cross/20): 本文を作り込んだ改定。内容が変わる (利用目的・第三者提供・AI の扱い・責任の範囲・未成年 ほか) ので
 * 両文書の版を v2025.1 → v2026.1 に上げる。上げるとサインイン中の全員に再同意が求められる (ファイル先頭のコメントのとおり)。
 * 施行日は公開 (デプロイ) の日。実装の時点では仮の施行日 (2026-10-19) を置き、マージの直前にオーケストレーターが実際の公開日
 * (JST の YYYY-MM-DD) に置き換えて、行末の目印のコメントを消す (cross/20 §9.4 の 3)。
 * 仮の値も YYYY-MM-DD の形の実在する日付にする (形を外すと /api/legal/status が 500 を返し、同意画面とテストが壊れる)。
 */
export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentType, LegalDocumentInfo>> = {
  terms_of_service: { version: 'v2026.1', effectiveDate: '2026-10-19' }, // 仮置き: マージ直前に公開日へ置き換える
  privacy_policy: { version: 'v2026.1', effectiveDate: '2026-10-19' }, // 仮置き: マージ直前に公開日へ置き換える
};
```

- `version` は `LEGAL_VERSION_PATTERN` (`^[0-9A-Za-z._-]{1,20}$`) を満たす (`v2026.1` = 7 文字)。
- 2 文書は**同時に**上げる (両方の内容が変わるため)。片方だけ上げると `getOutdatedLegalDocuments` がその片方だけを返し、同意画面の「改定あり」も片方だけに付く (仕組みとしては動くが、本書では両方)。
- ファイル先頭のコメント 17〜18 行目「いまの値は『現在公開している文面 (最終更新日 2025年1月1日)』を指す仮置きで…」は、「v2026.1 は #1901 (cross/20) で作り込んだ文面の版。弁護士の確認で文面を変えるときは、内容が変わるなら次の版 (v2026.2 など) に上げる」に書き換える (事実の更新。帰属の文は書かない)。
- `effectiveDate` の `'2026-10-19'` は**仮の施行日**で、migration の番号と同じく**マージ直前にオーケストレーターが公開日に置き換える**値。仮の値も YYYY-MM-DD の形の実在する日付にするのは、施行日の形を検査する既存の箇所がすべて通るようにするため: `packages/shared/src/legal-versions.test.ts` の「施行日は実在する日付の YYYY-MM-DD」(2 件)・`src/lib/legal-consent-api.ts:17, 32` の `EFFECTIVE_DATE_PATTERN` (形を外すと `src/app/api/legal/status/route.ts:50-52` の `safeParse` が失敗して 500 になり、`tests/api/legal-status-route.test.ts` と `tests/legal-consent-api-schema.test.ts` が赤になる)・`formatLegalEffectiveDate` (形を外すと値をそのまま返し、HTML の中で `<` が `&lt;` になって `tests/legal-consent-page.test.tsx:209` と `tests/policy-pages-public.test.tsx:60` の一致が外れる)。実装レーンは仮の値と行末の目印のコメント `// 仮置き: マージ直前に公開日へ置き換える` をそのまま残し、**全件は緑**で終える (既知の赤は無い)。仮の値は目印で見分ける (T-17 は値そのものを固定しない)。

### 9.2 版を上げたときに起きること (実装済みの仕組み。本書で変えない)

| 面 | 起きること | 根拠 |
|---|---|---|
| Web の画面 | サインイン中で `user_profiles.terms_version_accepted` / `privacy_version_accepted` が `v2026.1` でない人は、次の画面の取得で `/legal-consent?next=<元のパス>` へ。対象外: `/terms` `/privacy` `/legal` `/legal-consent` `/contact` `/settings/data-requests` `/frozen` `/auth/*` `/api/*` `/handson-tour` と静的ファイル | cross/08 §7.2・`lib/supabase/middleware.ts` |
| 同意画面 | `isReconsent=true`・`outdated=['terms_of_service','privacy_policy']` → 導入文 `introReconsent` (「利用規約・プライバシーポリシーが改定されました…」)・両文書に「改定あり」・版と施行日の行・全文のリンク (`/terms` `/privacy`)・チェック 2 つ・「同意して続ける」・「同意しない（ログアウトする）」・請求画面へのリンク。生年月日が無い人は欄が出る | `LegalConsentForm.tsx:338-395`・`legal-consent-copy.ts` |
| 同意の記録 | `POST /api/legal/accept` は body の版が `LEGAL_DOCUMENTS` と一致するときだけ `accept_legal_documents` を呼ぶ (違えば 409 `versionMismatch`)。`terms_acceptances` に 2 行 (版・日時と、サーバーが受け取った通信の IP・User-Agent (512 文字まで))、`user_profiles` の 2 列と `legal_accepted_at` を更新。ログには版だけを残し、IP・User-Agent はログに出さない (記録の表には残る。プライバシーポリシー第3条の同意の記録の行・F-17) | `src/app/api/legal/accept/route.ts:19, 116-125`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:513-514`・cross/08 §7.2 |
| `/api/*` | `LEGAL_CONSENT_EXEMPT_API_PATHS` 以外は 403 `LEGAL_CONSENT_REQUIRED`。通るもの: 同意 2 本・`/api/auth/*`・退会・書き出し・課金の解約 3 本・`/api/account/data-requests/*`・push token の claim・お問い合わせ・ログ・状態の窓口 | `packages/shared/src/legal-consent-api.ts:88-110` |
| モバイル | `LegalConsentProvider` が `GET /api/legal/status` → `gaps` に 2 文書 → ルートのゲートがアプリを `/legal-consent` の WebView 1 枚にする。同意後 `legal-consent-accepted` で入口へ。アプリ側の文面は無い (Web を開く) | 13b・`apps/mobile/src/providers/LegalConsentProvider.tsx` |
| プッシュ通知 | `LEGAL_CONSENT_ENFORCE=on` のとき、未同意の利用者への行は `consent_outdated` で送らない (再同意まで通知が届かない。食事のリマインドなども止まる) | `src/lib/push/outbox.ts:53-54, 245-259` |
| 新規登録 | `/auth/callback` が未同意の人を同意画面へ回す (強制の値に関わらず) | cross/08 §7.2「初回の作成」 |
| 凍結中 | `/legal-consent` に進めないが、凍結の例外 (退会・書き出し・解約 3 本・お問い合わせ) は同意の許可リストにもあるので止まらない | `legal-consent-api.ts` の注記 |
| AI の同意 | 影響なし (`AI_CONSENT_VERSION` は変えない。`external_data_consents` の判定は別) | `ai-consent.ts:42` |
| 保護者の同意 | 影響なし (`PARENTAL_CONSENT_DOCUMENT` は変えない) | `parental-consent.ts:33-36` |

### 9.3 以後の文面の直し方 (規律)

| 直し | 版 | 再同意 |
|---|---|---|
| 誤字・表現の整理・リンク先の修正など、内容が変わらない直し | 据え置く | 起きない |
| 利用目的・第三者提供・AI の扱い・保存期間・責任の範囲・未成年の扱いなど、内容が変わる直し | 上げる (`v2026.2` …。2 文書のうち内容が変わった方。両方なら両方) | 起きる |
| 弁護士の確認で文面を差し替える | 内容が変わるなら上げる | 同上 |
| AI 事業者を足す・外す | プライバシーポリシーの版を上げる。あわせて `AI_CONSENT_VERSION` も上げる (`ai-consent.ts:30-31` の規律) | 両方で起きる |
| 委託先を足す・外す | `PRIVACY_PROCESSORS` に足し、§13 の evidence を足し、プライバシーポリシーの版を上げる | 起きる |
| 外部送信の送り先を足す (CSP の `connect-src` に外部のオリジンを足す・アプリの更新の取得 (EAS Update) を有効にするなど) | プライバシーポリシー第10条の表に行を足し、版を上げる (T-27 が EAS Update の有効化で赤になる) | 起きる |
| 版を上げる改定すべて | §9.4 の 2 (施行日の前のお知らせ) を必ず行う | — |

### 9.4 公開の手順 (オーケストレーターの工程)

1. 弁護士の確認 (任意。オーナーの判断) → 文面の差し替えがあれば §6・§7 を改定 (本書の改定版) → 実装に反映。
2. 公開日 (施行日) を決め、**公開日より前に**、運営画面のお知らせ (`/admin/announcements`。公開 (`is_public`) にすると Web とアプリのホームに出る。F-31) に改定の予告を載せる。載せる中身: 題「利用規約・プライバシーポリシーの改定のお知らせ」、本文に改定の概要 (§11.2 の「設計後」の要点: AI 機能の送る情報と事業者・委託先・保存期間・未成年・責任の範囲・凍結と退会)・施行日・施行日以後に同意をお願いすること・同意するまでの間は設定画面を使えないこと・同意しない場合はお問い合わせから削除 (有料プランの人は解約も) を依頼できること。利用規約第24条 1 項とプライバシーポリシー第18条 1 項の「施行日の前にお知らせに掲載」はこの工程で守る (省くと公開した約束を破る)。メールでの一斉の知らせは仕組みが無いので行わず、文面もメールでの知らせを約束しない (F-34)。`/news` はコードの中の一覧で運営画面から載らないので使わない。
3. マージ直前: `effectiveDate` の仮の値 `'2026-10-19'` を公開日 (JST の YYYY-MM-DD) に置き換え、行末の目印のコメント `// 仮置き: マージ直前に公開日へ置き換える` を消す (2 文書とも同じ日)。`git grep -n '仮置き: マージ直前に公開日' -- packages/shared/src/legal-versions.ts` が 0 行になることを確かめる (公開日が仮の値と同じ日でも、目印は消す)。置き換えたあとに全件を流す。`docs/legal/archive/v2025.1/` の控えが PR に入っていることを確かめる。2 のお知らせが公開日より前に載っていることを確かめる。
4. デプロイ (公開日)。デプロイの時点から再同意が始まる (施行日の前からは求めない: 施行日 = デプロイ日にする)。
5. 公開後の整合: `/terms` `/privacy` を未ログインで開いて版 `v2026.1` と全文を確認。同意済みのテスト用アカウントで同意画面が出て「改定あり」が 2 つ付くこと、同意後に戻ること、アプリで WebView が出ることを確認。
6. ロールバックするときの注意: デプロイを戻すと `LEGAL_DOCUMENTS` も `v2025.1` に戻り、`v2026.1` に同意した人は「古い版 (v2025.1) に未同意」としてもう一度同意画面が出る。文面だけ戻したいときは、版を戻さずに文面モジュールだけ戻す (版の規律 §9.3)。

---

## 10. 条項 ⇄ 製品の根拠 (file:line) の対応表

### 10.1 利用規約

| 条 | 主張 | 根拠 |
|---|---|---|
| 第1条 | Web とアプリ・個別規定 (特商法表記・保護者の同意書・AI 同意) が一部 | `src/app/legal/page.tsx`・`src/app/legal/parental-consent/page.tsx`・`src/lib/ai/consent-config.ts:119-165` |
| 第2条 | 定義 (登録情報の項目は user_profiles の列、ユーザーコンテンツは meals / recipes / health_* / ai_consultation_*) | F-22・`src/lib/account-export-tables.ts` の表の一覧 |
| 第3条 | メールまたは Google・生年月日の申告 (1 回だけ・本人は変更不可)・18 歳未満は登録不可・13 歳未満のアカウント無し・登録は無料 | `src/app/(auth)/login/page.tsx:78-83`・`LEGAL_CONSENT_BIRTH_DATE_COPY.hint`・`parental-consent.ts:12-18, 123-134`・`src/app/pricing` (free プラン) |
| 第4条 | 「ログイン中の端末・ログイン履歴」の画面 (`SESSIONS_SETTINGS_PATH` = `/settings/security/sessions`) でログイン履歴とセッションの失効・新しい端末の通知・30 日無操作で失効 | F-24・`src/lib/emails/account/login-new-device.ts:18`・`sessions/constants.ts:16`・migration `20261016243000:381` |
| 第5条 | 保護者が家族に追加 → 同意書 → つなぐ・13 歳未満は代理記録・つないだ本人の記録の見え方は本人の共有の設定 (つなぐときに本人が選ぶ)・代わりに記録できるのは本人のアカウントが無い家族だけ・つながりが切れたら、追加し直して承諾するか 18 歳になるまで退会のみ | `parental-consent.ts:82-108, 118-140` (`guardian_consent` の gap・`guardianMissingBody`)・cross/14 §11 (`accept_child_promotion` の共有の引数)・F-33 |
| 第6条 | 機能の一覧 (組織はメンバーの招待と管理・チャレンジ) | `src/app/api/ai/*` (F-24 の一覧)・`src/app/api/family/**`・`src/app/(org)/org/**` (F-19)・`src/lib/badges/` |
| 第7条 | 外国の AI 事業者・同意が無ければ送らない・撤回・自動処理は同意前に実行しない・結果は推定 | F-8・`consent-config.ts:12-14, 29-30, 149-164` |
| 第8条 | 1 日の上限・翌日 0 時・プランと設定・機能別上限・自動処理の安全弁 | F-9・`ai-daily-limit.ts:38-66`・`tests/public-claims-guard.test.ts:189-193` (回数は書かない) |
| 第9条 | 医療免責の文 (逐語)・119 | cross/08 §8.1 |
| 第10条 | 無料の機能・有料は準備中の表示・Stripe・自動更新と期間末の解約 (解約はいつでも。予約は設定の「お支払い」から、改定後の同意の前は第24条 2 項のお問い合わせから)・返金は原則なし・組織のライセンス (参加できる人数の上限。招待の承諾で枠を 1 つ使う)・アプリ内課金なし | `src/app/legal/page.tsx:24-50`・billing/01 §0.2・§9.5 (S6)・`org_license_pools` (`total_licenses` が NULL なら上限なし)・F-19 (`accept_org_invite` が `used_licenses` を 1 足す)・F-32 (`/account/billing` は同意画面へ回る。運営が解約するコードの経路は無く運用で行う。Q-21) |
| 第11条 | 招待・共有設定 3 つ (食事と献立は共有を選べば表示・健康の記録は家族に表示する経路が無い)・代表者と管理者・代理記録は本人のアカウントが無い家族だけ・退出・譲渡か解散・30 日 (運営の一覧の判定。`LEGAL_FACTS.inactiveRepresentativeDays`) | F-18・F-21・F-33・cross/08 §16.2 の 409 |
| 第12条 | 管理者が行うこと (招待・メンバーの管理) と見る項目 (表示名・組織内の役割・参加日・招待の状況・メンバー数と部署ごとの人数・チャレンジの参加人数と平均。社員番号・登録したメールアドレス・最終ログイン・ライセンスの状態は見ない)・個人の記録は見ない・チャレンジは任意・順位は参加者どうし・名前は既定 off・譲渡か解散と 30 日・退出後も個人として利用 | F-19・F-21 |
| 第13条 | 写真は非公開 (署名付き URL)・家族と組織には表示しない・運営は審査などで閲覧することがある・公開レシピと社会機能・非表示と 90 日・通報は問い合わせ | cross/19 §6.1 (行 283・286)・F-33・migration `20261017070000`・`20251126124224:10088` (`Users can view public recipes`)・F-14・F-24 (通報機能無し) |
| 第14条 | AI 生成物 3 項 (cross/08 §14 逐語の趣旨)・ユーザーコンテンツの処理 | cross/08 §14 |
| 第15条 | 禁止事項 (現行 5 項を含む) | `src/app/terms/page.tsx:42-50`・`src/lib/rate-limit.ts` (回数制限の回避) |
| 第16条 | 非表示・制限・凍結・凍結中にできること・自動解除・措置による損害は第21条の範囲 (R-4) | F-12・F-20・`src/lib/admin/moderation-backend.ts` |
| 第17条 | いつでも退会できる (設定画面から。凍結中は第16条、改定後の同意の前は第24条 2 項のお問い合わせと開示の請求)・即時削除・取り消し不可・譲渡か解散・公開レシピ匿名化・法令で残す記録は紐づけを外して残す・送信停止の記録はアドレスのまま残す・保護者として署名した同意の記録は残す・バックアップ・Stripe 即時解約・返金なし | cross/08 §16.1-16.3・F-30・F-32・billing/01 §11 |
| 第18条 | 変更・中断 (保守・不可抗力・外部事業者)・メンテナンス表示・終了・変更などによる損害は第21条の範囲 (R-4) | `lib/supabase/middleware.ts:111-113, 337-338` (maintenance)・現行第 6・8 条 |
| 第19条 | メール・画面・プッシュ・プッシュは設定で止められる (止めている間の必要なお知らせは画面の表示)・メールは利用に伴う連絡で止める設定は無い | F-34・F-31 (お知らせはホームに出る) |
| 第20条 | 保証の否認・バックアップは保証でない | cross/17・現行第 7 条 |
| 第21条 | 故意重過失を除く・通常損害・損害の前 12 か月に受け取った有料プランの料金の上限 (料金を受け取っていないユーザーには上限を適用しない)・強行法規 | 消費者契約法 8 条 (§3)・R-4 |
| 第22〜23条 | 一般条項 | — (製品の挙動に当たらない) |
| 第24条 | 内容が変わる変更は再同意で行い、同意した時から適用・施行日の前にお知らせに掲載 (メールでの知らせは約束しない。F-34)・同意の前は設定画面を使えない (退会・書き出し・解約の予約・AI の同意の撤回も画面からはできない)・同意の前にできるのは請求とお問い合わせ (削除と解約の依頼を含む)・内容の変わらない修正は版据え置き・版と施行日の表示 | §9.2〜§9.4・F-31・F-32・F-34・`LegalConsentForm.tsx:284-318` |
| 第25〜26条 | 一般条項 | — (製品の挙動に当たらない) |
| 第27条 | 日本法・本店所在地の裁判所 | 現行第 9 条 |
| 第28条 | 窓口 | `getSupportEmail()`・`/contact` |

### 10.2 プライバシーポリシー

| 条 | 主張 | 根拠 |
|---|---|---|
| 第1条 | 名称・代表者・請求時開示・窓口 (取扱いの責任者は書かない。§0.6) | F-4 |
| 第2条 | 用語 | 法 2 条・16 条 |
| 第3条 | 取得する情報の表 (ログインの履歴は IP の全体・ネットワークの範囲・国 (Web のログイン) を記録し、本人の画面と新しい端末のお知らせのメールに出し、運営も見る。規約・ポリシーの同意も IP と端末の種類を記録する。組織は所属・役割・参加日・招待・チャレンジ。IP・User-Agent を持つ表は F-37 の 4 つを載せる)・端末の機能の表 (カメラ・写真ライブラリ・通知・位置情報等は取らない)・端末の機種名と OS の版 | F-25・F-22 (user_profiles)・`meals`・`health_checkups`・`blood_test_results`・`family_members`・`organizations`・`organization_invites`・`organization_challenge_participants` (F-19)・`billing_customers`・`inquiries` (migration `:5105`)・`external_data_consents` (`:4672`)・`terms_acceptances` (`:6553`。IP・User-Agent は `accept_legal_documents` が入れる。F-17)・`parental_consents`・`user_sessions_metadata`・`user_push_tokens` (`:6698`)・`app_logs` (`:3899`)・F-17・F-37 |
| 第4条 | 利用目的・仮名加工情報と匿名加工情報を作らない | 各機能 (F-8・F-9・F-13・F-16)・当社自身の学習に使わない = 学習のコードが無い・F-27 |
| 第5条 | 要配慮・任意・操作をもって同意・保護者 (本人のアカウントが無い子ども)・AI は別同意で、要配慮の項目も送る・健康の記録と写真は家族にも組織にも表示しない・運営は審査などの範囲で扱い操作は記録・オプトアウトなし | F-18・F-19・F-22・F-29・F-33・`admin_audit_logs` |
| 第6条 | AI 事業者 (動的)・送る情報 (`AI_CONSENT_COPY` の 6 項目 + プロフィールと健康の項目・ニックネーム。F-29)・目的 (`AI_CONSENT_COPY` と同じ)・米国とエストニアの制度・措置・同意の記録と撤回・提供の記録 (= 同意の記録。開示と書き出しに使う) | F-8・F-26・F-29・`consent-config.ts:126-147`・§3 の法 28 条・29 条 |
| 第7条 | 委託先 9 社と根拠 (`evidence`)・監督・基準適合体制 | F-16・`PRIVACY_PROCESSORS` |
| 第8条 | 第三者提供の原則と例外・共同利用なし・オプトアウトなし・承継 | 法 27 条 |
| 第9条 | 家族と組織の見え方の表 (写真は家族・組織に出ない・健康の記録は家族に出ない・つないだ未成年は本人の共有の設定・登録したメールアドレスとログインの履歴はどちらにも出ない・招待の状況は家族の代表者と大人のメンバー / 組織の管理者に出る・組織の管理者には役割・参加日・メンバー数と部署ごとの人数・チャレンジの参加人数と平均 (最小人数未満は出さない)・健康に関する集計は組織に出さない) | F-18・F-19・F-33・`can_view_user_meals` (migration `:10568`)・健康の表の SELECT は本人だけ (`:10008, 10016, 10038`)・`family_invites_select_adult` (`:10371`。`is_active_family_adult` は役割が `representative`・`adult`)・`org_invites_select_admin` (`:10644`) |
| 第10条 | ブラウザとアプリから直接の Supabase・Cookie (認証)・WebView の保存・Speed Insights・Turnstile・Stripe・Google・祝日の一覧 (GitHub Pages。`HOLIDAYS_API_ORIGIN`)・Expo (通知の許可のあとだけ)・広告/計測なし・バナーなし・端末の機能は第3条を参照・EAS Update は無効 (行を置かない。T-27) | F-15・F-25・`apps/mobile/src/lib/pushNotifications.ts:261-264`・`apps/mobile/src/components/web/WebViewScreen.tsx:232-251`・`sessions/constants.ts:16` |
| 第11条 | 安全管理措置 (ロールと監査ログ・運営の MFA (管理者などのロールだけ。F-35)・TLS・ハッシュ・RLS・非公開写真・回数制限・CSP・ログの伏せ・バックアップ暗号化 (鍵を持つ者を限る)・即時削除)。人的な措置と取扱いの責任者は根拠が無いので書かない (§0.6・Q-20) | cross/12・cross/18・cross/19・cross/17 §3.2・`src/lib/auth/mfa/policy.ts:18` (`MFA_REQUIRED_ROLES`)・`src/lib/emails/outbox.ts` (マスク)・cross/08 §16 |
| 第12条 | 保存期間の表 (規約・ポリシーと AI の同意の記録は IP と端末の種類を含み退会で消える・お問い合わせとサポートの記録は期限なしで、退会で紐づけを外しメールアドレスを伏せ件名と本文は残る・保護者の同意の記録は退会後も紐づけを外して残り、家族グループの削除で消える・送信停止の記録はアドレスのまま・ブラウザのセキュリティ違反の報告はアプリの動作のログと同じ保持・プッシュ通知の宛先はログアウトと無効の知らせで消え退会で消える・AI 機能の利用回数は退会まで・回数の制限の計数は期間の後に自動で消える) | F-11・F-14・F-17・F-30・F-36・cross/08 §16.3・`email_blacklist`・`src/app/api/csp-report/route.ts:1-6, 68-70` (報告は `app_logs` に warn で残すだけ)・`user_push_tokens` の `ON DELETE CASCADE` (migration `20251126124224_create_meal_planner_tables.sql:9472-9473`)・`apps/mobile/src/lib/signOut.ts:5` (ログアウトで端末の行を消す)・`src/lib/push/outbox.ts:298` (`DeviceNotRegistered` で端末の行を消す)・`ai_usage_counters` の `ON DELETE CASCADE` と消す処理が無いこと (`20261010140000_ai_usage_foundation.sql:62-63`)・`src/lib/rate-limit.ts:260` (`Ratelimit.slidingWindow`。`@upstash/ratelimit` はキーに期限 (`PEXPIRE`) を付ける) |
| 第13条 | いつでも退会できる (設定画面から。改定後の同意の前は利用規約第24条 2 項のお問い合わせ)・書き出し (JSON。改定後の同意の前は第14条の開示の請求)・凍結中も可 | F-11・F-12・F-32 |
| 第14条 | 請求の種類・手順・24 時間・5 回・遅滞なく (現行 `/privacy` 第6条の約束と法 33 条)・30 日の目安・例外・無料・凍結中と退会後は /contact・利用停止の扱い | F-13・cross/15 §7・§12・S-10・S-13 |
| 第15条 | 未成年・保護者が代わりに記録できるのは本人のアカウントが無い子どもだけ・つないだ本人の記録は本人の共有の設定 | F-10・F-33 |
| 第16条 | プッシュは設定で止められる・メールは利用に伴う連絡で止める設定は無い・送信停止リスト | F-34・cross/08 §16.3 (`email_blacklist` は伏せない) |
| 第17条 | 窓口 | F-4 |
| 第18条 | 改定と再同意・施行日の前にお知らせに掲載 (メールでの知らせは約束しない) | §9・F-31・F-34 |

---

## 11. 表 3 点

### 11.1 ①全パターン表 (文書 × 読む人の状態 × 入口 → 何が出るか)

| 文書 | 読む人 | 入口 | 出るもの |
|---|---|---|---|
| /terms, /privacy | 未ログイン | LP フッター・サインアップ画面のリンク・ストア審査の URL・直接 | 版 v2026.1 と施行日 → 全文。ログイン画面へ回さない (`publicPaths`) |
| 同 | ログイン済み・同意済み (v2026.1) | 設定・同意画面のリンク・直接 | 同上 (ゲートの対象外) |
| 同 | ログイン済み・未同意 (v2025.1 / 無し) | 同意画面の「全文を読む」 | 同上 (ゲートの対象外なので同意画面から読める) |
| 同 | 凍結中 | `/frozen` から直接 | 同上 (`/terms` `/privacy` は凍結の差し戻しの対象外) |
| 同 | アプリ | 設定タブの「利用規約」「プライバシーポリシー」(`apps/mobile/app/(public)/terms.tsx` の「Web版を開く」) | 外部ブラウザで Web の全文 |
| /legal-consent | 既存の利用者 (v2025.1) | 版上げ後の最初の画面 | 「改定されました」+ 2 つの「改定あり」+ 生年月日 (無い人) |
| /legal-consent | 新規 | `/auth/callback` | 「ご利用いただくには同意が必要です」(introFirst) + 生年月日 |
| /legal-consent | 18 歳未満で保護者の同意とのつながりが無い | 同上 | `guardianMissingHeading` と退会ボタンだけ |
| /legal-consent | 凍結中 (版は old・none・current のどれでも) | 版上げ後の最初の画面・直接 | 出ない。画面の判定は凍結が同意より先なので `/frozen` へ回る (F-28)。`/terms` `/privacy` `/contact` は読める |
| /legal-consent (WebView) | アプリの既存の利用者 | 起動時のゲート | Web と同じ画面 1 枚 |
| /api/* | 未同意 | アプリ・Web の fetch | 403 `LEGAL_CONSENT_REQUIRED` (許可リスト以外) |

### 11.2 ②状態比較表 (現行 vs 設計後)

| 観点 | 現行 | 設計後 |
|---|---|---|
| 利用規約の条 | 9 条 (74 行の JSX) | 28 条 + 附則 (5 章)。`TERMS_ARTICLE_HEADINGS` と `TERMS_ARTICLE_COUNT = 28` |
| プライバシーポリシーの条 | 7 条 (86 行の JSX) | 18 条 + 附則 + 前文。`PRIVACY_SECTION_HEADINGS` と `PRIVACY_SECTION_COUNT = 18` |
| 文面の置き場所 | ページの JSX | `src/lib/legal/terms-text.ts` / `privacy-text.ts` (データ)。ページは描くだけ |
| 文面の中の数 | 無い | `LEGAL_FACTS` から埋め、テストが正本と突き合わせる |
| 事業者名・代表者・窓口 | `BUSINESS_NAME`・`getSupportEmail()` を JSX に差し込む | `LegalTextContext` でページが渡す (同じ定数) |
| AI 事業者の一覧 | `AI_CONSENT_PROVIDERS` を JSX で map | ページが `ctx.aiProviders` に渡し、`ai_providers` ブロックが同じ `data-testid` で描く |
| 委託先 | 無い | `PRIVACY_PROCESSORS` 9 社 (evidence つき) |
| 版 | v2025.1 / 2025-01-01 (仮置き) | v2026.1 / 公開日 |
| 旧版の控え | 無い (`docs/legal/` が無い) | `docs/legal/archive/v2025.1/terms.md`・`privacy.md` |
| テスト | 事業者名・AI 一覧・版表示・h1・戻るリンク | 左に加えて `tests/legal-text-1901.test.ts` (§13) と `public-claims-guard` の走査対象に 2 ページ。`push-outbox.test.ts` の版の直書きを `LEGAL_DOCUMENTS` の値に |
| Cookie 同意バナー | 無い (cross/08 §12 は未実装) | 置かない (広告・計測の Cookie を使っていない旨を公表) |
| 医療免責・AI 著作権 | 規約に無い | 第 9 条・第 14 条 |
| 責任の制限 | 第7条「故意または重過失によらない場合には免責」・第8条「一切の責任を負いません」(軽過失の責任の全部免除) | 第 21 条 (故意・重過失を除き通常損害・上限は料金を受け取った人だけ)。第 16 条 5 項・第 18 条 4 項は「第21条に定める範囲で責任を負う」。軽過失の責任を全部免除する条は置かない |
| ログの IP と国の公表 | 無い | 第3条: ログインの履歴は IP の全体・ネットワークの範囲・国 (Web のログイン) を記録し、本人の画面とお知らせのメールに出し、運営も見る (F-17) |
| 外部送信の公表 | 無い | 第10条の表 9 行 (Supabase・当社の Cookie・WebView・Vercel・Turnstile・Stripe・Google・祝日の一覧 (GitHub Pages)・Expo)。CSP の `connect-src` と T-29 で突き合わせる |
| AI 事業者へ送る情報 | AI の同意の文の 6 項目の写し (現行 `/privacy` 第4条) | 実際の送信 (プロフィール・健康の項目・ニックネーム) まで (F-29) |
| 改定の知らせ方 | 無い | 施行日の前に運営のお知らせ (ホーム) に掲載 → 施行日にデプロイ → 再同意 (§9.4)。メールでの知らせは仕組みが無いので約束しない (F-34) |
| 同意の前の退会・書き出し・解約の手段 | 書いていない | 「いつでも」の権利は残し、版上げの後の同意の前は第24条 2 項 (お問い合わせからの削除と解約の依頼・開示の請求) と各条に書く (利用規約第10条 4 項・第17条 1 項・プライバシーポリシー第13条 1 項・3 項。F-32) |
| 組織の管理者に見える項目 | 書いていない (計画の設計書は社員番号・最終ログインなど) | 組織の画面と API が読む項目だけ (表示名・組織内の役割・参加日・招待の状況・メンバー数と部署ごとの人数・チャレンジの参加人数と平均。F-19) |
| メールを止める設定 | 書いていない | 止める設定は無いと書く (プッシュだけ止められる。F-34) |
| 同意の記録の IP・端末の種類 | 書いていない | 規約・ポリシーの同意も IP と端末の種類を記録すると第3条に書く (F-17)。IP・User-Agent を持つ表は T-30 が第3条と突き合わせる (F-37) |

### 11.3 ③状態遷移表 (利用者の同意の状態 × 出来事 → 遷移先・ガード・副作用)

状態: `none` (未同意 = 同意した版が無い。`user_profiles` の行が無い人を含む) / `old` (v2025.1 に同意) / `current` (v2026.1 に同意)。これと独立に、18 歳未満の本人には「保護者の同意とのつながり」の有無 (無ければ gap `guardian_consent`) と、凍結の有無がかかる。凍結は `user_profiles.frozen_at` / `unban_at` (`src/lib/auth/frozen.ts:10-31`) なので、凍結されうるのは `user_profiles` の行がある人だけ (`none` でも行があれば凍結されうる。§11.1 の凍結中の行と同じ)。

判定の順 (F-28): `/api` は 凍結 → メンテナンス → 同意、画面は メンテナンス → 凍結 → 同意。**凍結は同意ゲートより先に効く**ので、凍結中の利用者は版に関わらず同意画面に進めず、`/frozen` を見る。凍結が解けた後の最初の画面の取得で、版が古ければ同意画面へ回る。

| 状態 | 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| old | 版上げをデプロイ | old (判定が未同意になる) | — | 次の画面の取得で `/legal-consent`。`/api` は 403。プッシュは止まる |
| old / none | 同意画面で「同意して続ける」 | current | body の版 = `LEGAL_DOCUMENTS` (違えば 409)。生年月日 (無い人)。13 歳未満・つながりの無い 18 歳未満は `LEGAL_MINOR_SELF_SIGNUP_REFUSED` | `user_profiles` 2 列 + `legal_accepted_at`・`terms_acceptances` 2 行。元の画面へ。プッシュ再開 |
| old / none | 「同意しない（ログアウトする）」 | old / none | — | signOut。請求画面・問い合わせへのリンク |
| old / none (凍結でない。18 歳未満の案内 (`minor_refused` / `guardian_missing`) が出る人を除く) | 退会したい | old / none (画面からは退会できない) | — | 退会の画面 (`/settings`) は同意画面へ回る (F-32)。入口は同意画面の「同意しない（ログアウトする）」→ `declined` の案内 → `/contact` から削除の依頼 → 運営が本人確認のうえ削除。退会の API (`/api/account/delete`) は同意の許可リストにあるが、この人に出す退会のボタンは無い。利用規約第24条 2 項はこの経路だけを約束し、第17条 1 項とプライバシーポリシー第13条 1 項は「改めて同意するまでの間は第24条 2 項」と書く (「設定画面からいつでも」とは書かない) |
| current | 退会 | (削除) | 組織オーナー・家族代表でない (同じ) | 即時削除。`terms_acceptances`・`external_data_consents` も消える (F-26)。利用規約第17条・プライバシーポリシー第12条・第13条のとおり残るものだけ残る |
| old / none (凍結でない。18 歳未満の案内 (`minor_refused` / `guardian_missing`) が出る人を除く) | 請求・問い合わせ | old / none | — | 画面 (`/settings/data-requests`・`/contact`) は同意ゲートの対象外で開け、API も許可リストで通る |
| old / none (凍結でない。18 歳未満の案内 (`minor_refused` / `guardian_missing`) が出る人を除く) | 書き出し・有料プランの解約 | old / none (画面からはできない) | — | 画面 (`/settings`・`/account/billing`) は同意画面へ回る。API は許可リストで通るが、入口の画面が無い。データの開示は請求 (開示) で行える (プライバシーポリシー第13条 3 項)。解約は `/contact` から依頼し、運営が決済代行事業者の管理画面で行う (運用。コードの経路は無い。Q-21)。利用規約第10条 4 項と第24条 2 項はこの経路を書く。自動更新の日までに依頼が処理されないと更新されるので、運用の手順と期限は Q-21 |
| current | 文面だけの修正 (版据え置き) | current | §9.3 | 何も起きない |
| current | 次の内容が変わる改定 (v2026.2) | current (判定が未同意になる) | — | 最初の行と同じ |
| current | 凍結 | current | — | 画面は `/frozen`。例外の API だけ通る |
| old / none | 凍結 | old / none | `user_profiles` の行がある (凍結の列はこの表にある) | 画面は `/frozen` (同意画面より先。F-28)。`/legal-consent` へは進めず、`POST /api/legal/accept` も 403 `AUTH_ACCOUNT_FROZEN` (同意できない)。凍結の例外 (退会・書き出し・解約 3 本・お問い合わせの送信) は同意の許可リストにもあるので通る。プッシュは `account_frozen` で止まる。`/terms` `/privacy` は読める |
| old (凍結中) | 凍結の解除 (解除予定の日時の経過・運営の解除) | old | — | 次の画面の取得で `/legal-consent` (「改定されました」= `introReconsent`)。同意すると current |
| none (凍結中) | 凍結の解除 (同上) | none | — | 次の画面の取得で `/legal-consent` (「ご利用いただくには同意が必要です」= `introFirst`。生年月日の無い人は生年月日も)。同意すると current |
| current (凍結中) | 凍結の解除 (同上) | current | — | 同意画面は出ず、通常どおり使える。プッシュは次回から届く |
| none / old / current (凍結中) | 退会 (`/frozen` → `/frozen/account`) | (削除) | 退会の本体 (`deleteAccount`) のガードは凍結でない人と同じ (組織のオーナー・家族の代表でない) | `POST /api/account/delete` は凍結の例外 (`FROZEN_ALLOWED_API_PATHS`) と同意の許可リストの両方にあるので、版に関わらず通る。即時削除。利用規約第16条 2 項・第17条、プライバシーポリシー第12条・第13条のとおり残るものだけ残る |
| none / old / current (凍結中) | データの書き出し (`/frozen/account`) | 同じ状態のまま (凍結も続く) | — | `GET /api/account/export` が JSON を返す (凍結の例外・同意の許可リストの両方にある)。利用規約第16条 2 項・プライバシーポリシー第13条 3 |
| none / old / current (凍結中) | 有料プランの解約 (`/frozen` → `/frozen/billing`) | 同じ状態のまま (凍結も続く) | 解約できる契約がある | `GET /api/billing/subscription`・`POST /api/billing/subscription/cancel` (期間末に解約)・`POST /api/billing/portal` が通る (凍結の例外・同意の許可リストの両方)。解約の取り消し・購入は通らない (`src/lib/auth/frozen.ts:57-66`)。利用規約第16条 2 項 |
| none / old / current (凍結中) | お問い合わせ (`/frozen` → `/contact`) | 同じ状態のまま (凍結も続く) | — | `/contact` は凍結の差し戻しの対象外、送信 (`/api/contact` の POST) は凍結中も通る (F-12・F-28)。開示等の請求も `/contact` から (プライバシーポリシー第14条・cross/15 S-13) |
| none / old / current (18 歳未満・つながり有り) | 保護者の同意とのつながりが切れる (家族から外れる・家族の解散・案内を断る / 取り消される / 期限が切れる) | 同じ状態のまま (gap に `guardian_consent` が加わる) | — | 次の画面の取得で `/legal-consent` に `guardianMissingHeading`・`guardianMissingBody` と退会ボタンだけ (同意のボタンは出ない)。`/api` は 403 `LEGAL_CONSENT_REQUIRED` (許可リスト以外。退会は通る)。プッシュの判定は版だけを見るので、current の人には届き続ける (F-7) |
| none / old / current (18 歳未満・つながり無し) | 保護者が家族に追加し直し、本人が案内を承諾する / 18 歳になる | 同じ状態のまま (gap の `guardian_consent` が消える) | — | current なら通常どおり使える。old・none なら同意画面 (版の同意) が残る |
| none / old / current (18 歳未満・つながり無し) | 退会 (「登録をやめる（アカウントを削除する）」) | (削除) | — | 即時削除 (`withdrawnHeading`・`withdrawnBody`) |
| any | デプロイを戻す (v2025.1) | current → 未同意判定 | — | v2026.1 に同意した人にも同意画面 (§9.4 の 6) |

---

## 12. エラー表

本書は新しいエラーコードを足さない。文面と版の流れで利用者に見えるのは既存の次のものだけ (変更なし)。

| 場面 | コード / 文 | 状態 | 正本 |
|---|---|---|---|
| 未同意で `/api` を呼ぶ | `LEGAL_CONSENT_REQUIRED` 「利用規約・プライバシーポリシーへの同意が必要です。同意の画面から内容をご確認ください。」 | 403 | `legal-consent-api.ts:35-39` |
| 同意を送ったら版が変わっていた | `versionMismatch` 「利用規約・プライバシーポリシーが更新されました。画面を読み込み直して、内容をご確認ください。」 | 409 | `legal-consent-copy.ts:23`・`api/legal/accept` |
| 18 歳未満の自己登録 | `LEGAL_MINOR_SELF_SIGNUP_REFUSED` | 同意画面の案内 | cross/14 |
| 同意の記録に失敗 | `acceptFailed` | 画面の文 | `legal-consent-copy.ts:27` |
| AI 機能を未同意で使う | `AI_CONSENT_REQUIRED` | 403 | `ai-consent.ts:51-56` |

---

## 13. テスト一覧 (it 名)

新設 `tests/legal-text-1901.test.ts` (文面モジュールとページ) と `tests/legal-document-body.test.tsx` (描画部品)。描画は既存のテストと同じく `react-dom/server` の `renderToStaticMarkup` + `vi.mock('next/link')`。`renderText` はタグを空白に置き換える (`tests/business-info-legal-pages.test.ts:70-73` と同じ)。

| # | it 名 | 何を固定するか |
|---|---|---|
| T-1 | `利用規約の h3 のうち「第N条」で始まるものは TERMS_ARTICLE_HEADINGS と同じ順・同じ数で、TERMS_ARTICLE_COUNT と一致する` | 条の列挙と宣言の数 |
| T-2 | `プライバシーポリシーの h3 のうち「第N条」で始まるものは PRIVACY_SECTION_HEADINGS と同じ順・同じ数で、PRIVACY_SECTION_COUNT と一致する` | 同上 |
| T-3 | `LEGAL_FACTS の値は正本の定数と一致する (ADULT_AGE_YEARS・COPPA_AGE_YEARS・HIDDEN_CONTENT_RETENTION_DAYS・LOGIN_HISTORY_RETENTION_DAYS・SESSION_IDLE_EXPIRE_DAYS・DSR_VERIFICATION_TTL_HOURS・DSR_VERIFICATION_MAX_SENDS・DSR_RESPONSE_DUE_DAYS_DEFAULT)` | 写しの一致 (`@homegohan/shared`・`@/lib/admin/hidden-content-restore`・`@/lib/auth/sessions/constants`・`@/lib/data-subject-requests/core` を import して比べる) |
| T-4 | `LEGAL_FACTS の app_logs・送信待ちの保持は migration の文字列と一致する` | `supabase/migrations/20251126124224_create_meal_planner_tables.sql` に `DELETE FROM app_logs WHERE created_at < NOW() - INTERVAL '${appLogRetentionDays} days'`、`20261016234000_email_outbox.sql` と `20261016237000_push_outbox.sql` に `interval '${outboxSentRetentionDays} days'` と `interval '${outboxDeadRetentionDays} days'` が含まれる (大文字小文字を区別しない) |
| T-5 | `LEGAL_FACTS のバックアップの保持は cross/17 §9.1 の表記と一致する` | `docs/design/cross/17-backup-automation.md` に `30 日で削除`・`366 日で削除`・`2,557 日で削除` と `(7 年)` が含まれる |
| T-6 | `LEGAL_FACTS の未ログインの日数は、運営の一覧の判定 (RPC の INTERVAL) と見出しの文と一致する` | (1) `supabase/migrations` の `.sql` (`.down.sql` を除く) を名前の順に並べ、`list_families_with_inactive_representative` と `list_orgs_with_inactive_owner` のそれぞれについて、正規表現 `CREATE OR REPLACE FUNCTION\s+"?public"?\."?<名前>"?\s*\(` に当たる最後のファイルを選び、一致した位置から次の `$$;` までの文に `INTERVAL '${inactiveRepresentativeDays} days'` が含まれる (いまは `20261017130000_operator_mfa_db_gate.sql`)。(2) `src/app/(operator)/operator/membership/families/inactive/page.tsx` に `${inactiveRepresentativeDays}日以上未ログインまたは削除済みアカウントが代表者の家族グループ`、`orgs/inactive/page.tsx` に `${inactiveRepresentativeDays}日以上未ログインまたは削除済みアカウントが owner の組織` が含まれる (解散の理由の入力欄の例文 (placeholder) は判定ではないので見ない。F-21) |
| T-7 | `PRIVACY_PROCESSORS の各行の evidence (file に needle) が実在し、needle と文面モジュールに外部のホスト名・URL が無い` | 委託先の表が実コードに当たる (`fs.readFileSync` で `includes`)。各 needle は `://` を含まず、ホスト名の形 (`/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i`) に当たらず、6 文字以上 (テストのローカル定数 `MIN_NEEDLE_LENGTH = 6`。根拠コメント: §7 の規則)。`src/lib/legal/` の `.ts` 4 本のソースに `https://` と `exp.host` が含まれない (送り先を 1 ファイルに限る走査テスト `tests/push-expo-boundary-scan.test.ts`・`tests/ai-consent-provider-inventory.test.ts` を、文面モジュールが赤にしないため。§16) |
| T-8 | `プライバシーポリシーの保存期間と請求の手順の数は LEGAL_FACTS から埋まっている` | 描画した本文に `非表示にしてから ${hidden} 日`・`失効してから ${login} 日`・`${sessionIdle} 日間操作が無い`・`${appLog} 日`・`送れたものは ${sent} 日`・`${dsrTtl} 時間有効`・`${dsrSends} 回まで`・`${dsrDue} 日以内を目安`・`${daily} 日、週次のものは ${weekly} 日、年次のものは ${annual} 日（${years} 年）` が含まれる |
| T-9 | `利用規約第9条に cross/08 §8.1 と同じ医療免責の文と、救急（119）の案内がある` | `TERMS_MEDICAL_DISCLAIMER` が `docs/design/cross/08-legal-compliance.md` に逐語で含まれ、描画した本文に両方含まれる |
| T-10 | `利用規約第14条に AI 生成物の 3 項 (ユーザー帰属・匿名化した集計利用・CC0 相当) がある` | 描画した本文に `個人利用の範囲でユーザーに帰属`・`匿名化した形で`・`CC0 相当` が含まれる |
| T-11 | `文面モジュールは AI 事業者の名前を直接書かない (ctx の一覧が空なら本文に出ない)` | `privacyText({ …, aiProviders: [] })` の本文に `OpenAI`・`Perplexity`・`xAI`・`AI/ML API` が無い。`termsText` も同じ |
| T-12 | `AI 事業者の一覧は ctx の順で data-testid="privacy-ai-providers" の ul に「名前（国）：使い道」で出る。利用規約には出ない` | `/privacy` で `AI_CONSENT_PROVIDERS` の数と順。`/terms` に `privacy-ai-providers` が無い |
| T-13 | `文面モジュールは事業者名の形 (株式会社〇〇・〇〇 Inc) を直接書かない` | `termsText` / `privacyText` を `businessName: 'TESTCO'` で描いた本文に `株式会社` が無く、`/\b[A-Za-z]+,? Inc\b/` に当たらない |
| T-14 | `links ブロックの href はすべて実在するページを指す` | href の集合 ⊆ { `/terms` `/privacy` `/legal` `/legal/parental-consent` `/settings/data-requests` `/settings/ai-consent` `/contact` `/pricing` `/account/billing` `/settings/security/sessions` }、かつそれぞれ `src/app` の中にルートグループ `(x)` を無視して `<path>/page.tsx` が実在する |
| T-15 | `section の id は一意で、terms- / privacy- で始まる` | アンカーの衝突防止 |
| T-16 | `contact ブロックの email は ctx.supportEmail で、両文書に 1 つ以上ある` | 窓口の表示 (`tests/site-config-ui.test.tsx` の補強) |
| T-17 | `LEGAL_DOCUMENTS の 2 文書の版と施行日はそれぞれ同じで、版は仮置きの v2025.1 ではない` | 文面の作り込みに版上げが伴うこと (値そのものは固定しない。版の `not.toBe('v2025.1')` と、版・施行日それぞれの 2 文書の一致。施行日の形は既存の `legal-versions.test.ts` が見る) |
| T-18 | `/terms の h3 の数は TERMS_ARTICLE_COUNT + 1 (附則)、/privacy は PRIVACY_SECTION_COUNT + 1` | 描画とデータの一致 |
| T-19 | `/terms /privacy の本文に効果・成果の言い回しが無い` | テストのローカル定数 (export しない。§15) `LEGAL_TEXT_FORBIDDEN_CLAIMS = ['健康になれ', '改善します', '効果があります', '痩せ', '治ります', '予防できます']` が含まれない |
| T-20 | `docs/legal/archive/v2025.1/terms.md と privacy.md があり、旧版の条の見出しを含む` | `第1条（適用）`〜`第9条（準拠法・裁判管轄）` / `第1条（個人情報）`〜`第7条（お問い合わせ窓口）` |
| T-21 | `LegalDocumentBody は title が null の章に h2 を出さず、table に thead を出し、links を a で描く` | 描画部品 (`tests/legal-document-body.test.tsx`) |
| T-22 | `LegalDocumentBody は preamble を章の前に出す` | 前文の位置 |
| T-23 | `各 section の id が描画した HTML の id 属性に出る` | アンカー |
| T-24 | `プライバシーポリシー第7条の表の行数は PRIVACY_PROCESSORS.length と同じ` | 表とデータの一致 |
| T-25 | `プライバシーポリシーに、仮名加工情報・匿名加工情報を作成しない旨、AI 事業者への提供の記録、端末の機能の表がある` | 描画した本文に `仮名加工情報および匿名加工情報`・`提供の記録として、同意の記録`・`カメラ`・`写真ライブラリ`・`位置情報、連絡先、マイクの音声を取得しません`・`new URL(HOLIDAYS_API_ORIGIN).host` (祝日の一覧の送り先) が含まれる |
| T-26 | `apps/mobile/app.json の端末の権限の宣言は、既知の一覧に含まれる (新しい権限を足したら第3条の端末の機能の表を直す)` | `app.json` を `JSON.parse` し、`expo.ios.infoPlist` のうち `UsageDescription` で終わるキーの集合 ⊆ { `NSCameraUsageDescription`・`NSPhotoLibraryUsageDescription`・`NSPhotoLibraryAddUsageDescription` }、`expo.android.permissions` ⊆ { `CAMERA`・`READ_MEDIA_IMAGES`・`READ_EXTERNAL_STORAGE`・`WRITE_EXTERNAL_STORAGE`・`POST_NOTIFICATIONS`・`RECORD_AUDIO` に `android.permission.` を付けたもの }。既知の一覧はテストの中の定数 (根拠コメント: F-25。使っていない宣言は §17 の候補) |
| T-27 | `アプリの更新の取得 (EAS Update) は無効のまま (有効にしたらプライバシーポリシー第10条に送り先の行を足して版を上げる)` | `apps/mobile/app.json` を `JSON.parse` し `expo.updates.enabled === false` と `expo.updates.checkAutomatically === 'NEVER'`。`apps/mobile/app`・`apps/mobile/src` の `.ts`/`.tsx` に `expo-updates` の import (`from 'expo-updates'` / `from "expo-updates"`) が無い (根拠コメント: F-15) |
| T-28 | `利用規約・プライバシーポリシーの約束の文は実装に合わせてある (責任の上限と軽過失の責任・同意の前にできること・施行日の前のお知らせ・遅滞なく・写真と健康の見え方・AI に送る項目・送信停止の記録・ログとプッシュの宛先と AI の利用回数の保存期間・ログインの履歴の IP と国)` | `termsText(ctx)` を `LegalDocumentBody` で描いた本文に `その期間に有料プランの料金を受け取っていないユーザーには、本項の上限を適用しません`・`お問い合わせ（アカウントと保存されたデータの削除の依頼と、有料プランの解約の依頼を含みます）`・`施行日の前に本サービスのお知らせに掲載`・`第21条（損害賠償と責任の制限）に定める範囲で責任を負います` (第16条 5 項と第18条 4 項の 2 か所。出現の数が 2) が含まれ、`退会、データの書き出し、個人情報の開示`・`本人が共有を設定した家族グループのメンバーだけが閲覧`・`重大な過失がある場合を除き、責任を負いません` が含まれない。`privacyText(ctx)` を同じく描いた本文に `遅滞なく対応します`・`家族グループのメンバーにも組織の管理者にも表示されません`・`持病・健康上の注意点、服薬、妊娠・授乳の状況`・`メールアドレスのまま残します`・`ブラウザのセキュリティ違反の報告を含みます`・`その端末の宛先をその時点で削除します`・`AI 機能の利用回数（日ごと・機能ごとの回数）`・`IP アドレスの全体に加えて、その IP アドレスが属するネットワークの範囲`・`ホスティング事業者が通信から判定した国` が含まれ、`氏名は送りません`・`個人情報の取扱いの責任者`・`ネットワーク単位にして保存` が含まれない |
| T-29 | `CSP の connect-src の外部の送り先は、プライバシーポリシー第10条の表に行がある送り先だけ` | `buildContentSecurityPolicy({ nonce: 'n', isDev: false, supabaseUrl: 'https://example.supabase.co' })` を `cspDirectivesOf` で分け、`connect-src` の値の集合 ⊆ { `'self'`・`*.supabase.co`・`wss://*.supabase.co`・`*.vercel.app`・`HOLIDAYS_API_ORIGIN` }。テストの中の対応表 (値 → 第10条の行の送り先の語: `*.supabase.co`・`wss://*.supabase.co` → `Supabase`、`*.vercel.app` → `Vercel`、`HOLIDAYS_API_ORIGIN` → `GitHub`) の各語が `privacyText(ctx)` の第10条 (`id: 'privacy-10'`) の `table` ブロックの 1 列目のどれかに含まれる。connect-src に送り先を足したら、この集合と第10条の表と版を一緒に直す (根拠コメント: F-15・§9.3) |
| T-30 | `IP アドレス・User-Agent を持つ表は、プライバシーポリシー第3条に載せた表か、載せない理由を持つ表のどちらかに入っている` | `packages/shared/src/database.types.ts` を行ごとに読み、`public` の `Tables` の範囲 (行 `    Tables: {` から次の行 `    Views: {` まで) で、6 字下げの `<表>: {` を表の始まり、8 字下げの `Row: {` から次の 8 字下げの `}` までを列として、列名がテストのローカル定数 `IP_UA_COLUMNS = ['ip_address', 'ip_network', 'user_agent', 'country_code']` のどれかである表の集合を作る。その集合が `DISCLOSED_IP_UA_TABLES` と `EXCLUDED_IP_UA_TABLES` (どちらもテストのローカル定数。根拠コメント: F-37) のキーの和と等しい。`DISCLOSED_IP_UA_TABLES` (表 → 本文の文): `user_sessions_metadata` → `IP アドレスの全体に加えて`・`terms_acceptances` → `利用規約とプライバシーポリシーに同意した版・日時・IP アドレス`・`external_data_consents` → `日本国外の事業者への提供に同意した版・日時・IP アドレス`・`parental_consents` → `保護者の同意の署名`。各文が `privacyText(ctx)` を `LegalDocumentBody` で描いた本文に含まれる。`EXCLUDED_IP_UA_TABLES` (表 → 理由): `admin_audit_logs` (運営担当者の IP)・`cookie_consents` (書き込む処理が無い)・`failed_invite_lookups` (書き込む処理が無い)・`catalog_sources` (個人の情報でない)。理由が「書き込む処理が無い」の 2 つは、`src`・`supabase/functions` の `.ts`/`.tsx` (テストを除く) に `.from('<表>')`・`.from("<表>")` が無く、`supabase/migrations` の `.sql` に `INSERT INTO` に続く `<表>`・`public.<表>`・`"public"."<表>"` が無いことも確かめる (書き込む処理を足したら赤になり、第3条に載せ直す) |
| T-31 | `プライバシーポリシー第11条の多要素認証の文は MFA_REQUIRED_ROLES に当たる (管理者を含み、運営担当者の全員とは書かない)` | `MFA_REQUIRED_ROLES` (`@/lib/auth/mfa/policy`) が `'admin'` と `'super_admin'` を含む。`privacyText(ctx)` を描いた本文に `管理者の権限などを持つ担当者のログインには、多要素認証を求めています` が含まれ、`運営担当者のログインには多要素認証を求めています` が含まれない (F-35) |
| T-32 | `組織の管理者の画面が読む項目は、利用規約第12条とプライバシーポリシー第9条に書いた項目に当たる` | `src/app/(org)/org/members/page.tsx` に `.select('id, nickname, org_role, joined_org_at')` が含まれる。`src/app/api/org/invites/route.ts` の GET の `.select(` の直後のテンプレートリテラル (バッククォートで囲んだ文字列) の中の列 (空白と `,` で分けた語) の集合が { `id`・`email`・`role`・`department_id`・`token`・`expires_at`・`accepted_at`・`created_at`・`departments(name)` } と等しい。`src/app/(org)`・`src/app/api/org` の `.ts`/`.tsx` (テストを除く) に `last_sign_in_at` と `employee_` が含まれない (最終ログインと社員番号を組織の画面に足したら赤になり、文面を直す。F-19) |
| T-33 | `メール・同意の前の退会と解約の手段・お問い合わせの保存・組織の管理者に見える項目・同意の記録の IP の文は実装に合わせてある` | `termsText(ctx)` を描いた本文に `配信を止める設定はありません`・`改めて同意するまでの間は、設定の「お支払い」を利用できないため`・`改めて同意するまでの間は、設定画面を利用できないため`・`組織の管理者に表示されるのは、メンバーの表示名` が含まれ、`一部のメール`・`登録されたメールアドレスへもお知らせします`・`この設定にかかわらず行うことがあります`・`からいつでも予約でき`・`設定画面からいつでも退会できます`・`社員番号`・`最終ログイン日時` が含まれない。`privacyText(ctx)` を描いた本文に `配信を止める設定はありません`・`件名と本文はそのまま残ります`・`利用規約とプライバシーポリシーに同意した版・日時・IP アドレス`・`改めて同意するまでの間は、設定画面を利用できないため`・`第14条の開示の請求により個人データの開示を求めることができます` が含まれ、`一部のメール`・`登録されたメールアドレスへもお知らせします`・`設定にかかわらず送ることがあります`・`設定画面からいつでも退会できます`・`やりとりの記録は個人を特定できない形で残します`・`社員番号`・`最終ログイン日時`・`ライセンスの状態` が含まれない (F-17・F-19・F-32・F-34・F-36) |

既存テストの追随 (§16): `tests/public-claims-guard.test.ts` の `PUBLIC_PAGES` に `/terms` `/privacy` の 2 ページ、`PUBLIC_SOURCE_FILES` に `src/lib/legal/terms-text.ts`・`src/lib/legal/privacy-text.ts` を足す (禁止語の走査を本文にも掛ける)。`src/__tests__/api/cron/push-outbox.test.ts:176` の `'v2025.1'` 2 つを `LEGAL_DOCUMENTS` の値に置き換える。

テストの道具 (いずれも既存のテストにある書き方):
- `vi.mock('next/link', …)` → `a`。
- `renderToStaticMarkup(createElement(Page))`。
- `stripComments` (`tests/business-info-legal-pages.test.ts:62-64`)。

---

## 14. 段分け (実装 WF は 1 本・同じ worktree。段ごとに 2 枚レビュー。マージは段 B のあと 1 回)

| 段 | 中身 | 触るファイル | 確認 |
|---|---|---|---|
| A | 文面モジュールと描画部品 (ページは触らない) | 新設: `src/lib/legal/legal-text.ts`・`terms-text.ts`・`privacy-text.ts`・`index.ts`・`src/components/legal/LegalDocumentBody.tsx`・`tests/legal-text-1901.test.ts` (T-1〜T-16・T-19・T-24〜T-33 のうちページに依らないもの。文面モジュールを直接描くので T-25・T-28〜T-33 は段 A で書ける)・`tests/legal-document-body.test.tsx` (T-21〜T-23) | `tsc`・lint・全件 (すべて緑。ページ未切替なので挙動は変わらない) |
| B | ページの差し替え・版上げ・旧版の控え・番兵の追随 | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx` (§8.3 の全文)・`packages/shared/src/legal-versions.ts` (§9.1)・`tests/public-claims-guard.test.ts` (§13 末尾)・`docs/legal/archive/v2025.1/terms.md`・`privacy.md` (現行 `page.tsx` の条を Markdown に写す。版 v2025.1・施行日 2025-01-01 を冒頭に)・`src/__tests__/api/cron/push-outbox.test.ts:176` (`'v2025.1'` 2 つを `LEGAL_DOCUMENTS.terms_of_service.version` / `LEGAL_DOCUMENTS.privacy_policy.version` に置き換え、`import { LEGAL_DOCUMENTS } from '@homegohan/shared'` を足す。§16)・`tests/legal-text-1901.test.ts` に残りの it (T-12・T-17・T-18・T-20) | `tsc`・lint・全件 (すべて緑。既知の赤は無い)。`effectiveDate` は仮の施行日 `'2026-10-19'` と行末の目印のコメントのまま残す (§9.1。公開日への置き換えはオーケストレーターがマージ直前に行う) |

- 横断整合 (段 B のレビュー): `tests/business-info-legal-pages.test.ts`・`tests/policy-pages-public.test.tsx`・`tests/site-config-ui.test.tsx`・`tests/seo-public-pages-1867.test.tsx`・`tests/legal-consent-page.test.tsx` が変更なしで緑であること (§16)。
- 変異試験 (B 型の Haiku の枠): 製品コードは `src/lib/legal/*.ts`・`LegalDocumentBody.tsx`・2 ページ・`legal-versions.ts`。守りの中心 = T-3〜T-8 (数の一致)・T-11〜T-13 (名前の混入)・T-17 (版)・T-28・T-31・T-33 (約束の文)。

---

## 15. 新設一覧

| 種別 | 名前 | 置き場所 |
|---|---|---|
| ファイル | `legal-text.ts` | `src/lib/legal/` |
| ファイル | `terms-text.ts` | `src/lib/legal/` |
| ファイル | `privacy-text.ts` | `src/lib/legal/` |
| ファイル | `index.ts` | `src/lib/legal/` |
| ファイル | `LegalDocumentBody.tsx` | `src/components/legal/` |
| ファイル | `legal-text-1901.test.ts` | `tests/` |
| ファイル | `legal-document-body.test.tsx` | `tests/` |
| ファイル | `terms.md`・`privacy.md` | `docs/legal/archive/v2025.1/` |
| 既存ファイルの変更 (新設ではない) | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx` (§8.3)・`packages/shared/src/legal-versions.ts` (§9.1)・`tests/public-claims-guard.test.ts` (`PUBLIC_PAGES` に 2 ページ・`PUBLIC_SOURCE_FILES` に 2 つの文面モジュール。§13 末尾・§16)・`src/__tests__/api/cron/push-outbox.test.ts` (行 176 の `'v2025.1'` 2 つを `LEGAL_DOCUMENTS.terms_of_service.version` / `LEGAL_DOCUMENTS.privacy_policy.version` に。§16) | 段 B (§14) |
| 型 | `AiProviderLine`・`LegalTextContext`・`LegalBlock`・`LegalSection`・`LegalChapter`・`LegalDocumentText`・`PrivacyProcessor` | `legal-text.ts`・`privacy-text.ts` |
| 定数 | `CONTACT_PATH`・`LEGAL_NOTICE_PATH`・`PRICING_PATH`・`BILLING_PATH`・`LEGAL_FACTS` (ログイン中の端末の画面は既存の `SESSIONS_SETTINGS_PATH` を import し、新設しない) | `legal-text.ts` |
| 定数 | `TERMS_ARTICLE_HEADINGS`・`TERMS_ARTICLE_COUNT`・`TERMS_MEDICAL_DISCLAIMER`・`TERMS_EMERGENCY_NOTICE` | `terms-text.ts` |
| 定数 | `PRIVACY_SECTION_HEADINGS`・`PRIVACY_SECTION_COUNT`・`PRIVACY_PROCESSORS`・`HOLIDAYS_API_HOST` (export しない) | `privacy-text.ts` |
| 定数 (ページのローカル。export しない) | `MAIN_CLASS` (`<main>` のクラス。2 ページに同じ文字列を §8.3 のとおり置く。共通の定数 `LEGAL_MAIN_CLASS` などは新設しない) | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx` |
| 定数 (テストのローカル。export しない) | `LEGAL_TEXT_FORBIDDEN_CLAIMS` (T-19 の効果・成果の言い回しの一覧。根拠コメント: R-18・§3 の薬機法・景品表示法・健康増進法の行) | `tests/legal-text-1901.test.ts` |
| 定数 (テストのローカル。export しない) | `MIN_NEEDLE_LENGTH = 6` (T-7。根拠コメント: §7 の規則)・`IP_UA_COLUMNS`・`DISCLOSED_IP_UA_TABLES`・`EXCLUDED_IP_UA_TABLES` (T-30。根拠コメント: F-37) | `tests/legal-text-1901.test.ts` |
| 関数 | `termsText(ctx)`・`privacyText(ctx)` | 同上 |
| 部品 | `LegalDocumentBody({ document })` | `LegalDocumentBody.tsx` |
| 版 | `LEGAL_DOCUMENTS` の `version` を `v2026.1` (2 文書)、`effectiveDate` を公開日 | `packages/shared/src/legal-versions.ts` |
| DB・API・route・エラーコード・テーブル・列・RLS・Storage・環境変数 | 無し | — |

---

## 16. 既存の番兵 (契約テスト・走査テスト) の追随表

本設計が足す・変える・移すものの名前を grep の語にして `tests/`・`scripts/`・`src/__tests__/`・`packages/shared/src/*.test.ts`・`lib/**/__tests__`・`apps/mobile/__tests__` を走査した結果 (2026-10-19・origin/main `5b85bb3f`)。パス `/terms` `/privacy` を文字列で持つテストは、origin/main で 21 本 (`git grep` で `'/terms'` `'/privacy'` `href="/terms"` などの形を引いた集合) で、すべて下の表のどれかの行にある。2 ページは同じパスに残る (§4.1・§8.3) ので、パスの番兵はすべて変更なしで緑のまま。

もう 1 つの軸として、**新設のファイル (`src/lib/legal/*.ts`・`src/components/legal/LegalDocumentBody.tsx`) が走査の対象に入る番兵** を洗った。`src` を `readdirSync` で歩いてソースの中の文字列・書き方を数えるテスト (`tests/*-scan.test.ts`・`*-boundary-scan`・`*-single-implementation`・`ai-consent-provider-inventory` など) は、パスの語では引けないので、走査の対象 (`src` を含む) と数える語で引いた。審査 R3 の指摘 6 の実測 (本書 v1.5 の ts ブロックを置き場所どおりに置いて全件を流した結果。871 ファイル中 870 通過) で赤になったのは `tests/push-expo-boundary-scan.test.ts` の 1 本だけで、原因は委託先の表の `evidence.needle` に書いた `exp.host` だった。v1.6 で needle を根拠のファイルの中の識別子に替え (`EXPO_PUSH_SEND_URL`。GitHub の行も `apt-get install -y age` に)、needle の形の規則を §7 に、検査を T-7 に置いた。替えた needle の語は、`tests/`・`src/__tests__/`・`lib`・`packages/shared/src`・`apps/mobile/__tests__`・`scripts` の `git grep` でどの走査テストにも当たらない (当たるのは `src/__tests__/lib/push/expo-transport.test.ts` の import だけで、走査ではない)。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/business-info-legal-pages.test.ts` | `privacy-ai-providers`・`AI_CONSENT_PROVIDERS`・`AI_CONSENT_PROVIDER_INFO`・`株式会社`・`Inc` | `/privacy` のソースに 2 つの識別子があること (§8.3 で残す)・描画した本文の「株式会社〇〇」が `BUSINESS_NAME` だけであること・`〇〇 Inc` が無いこと (§6・§7 の規則)・AI の一覧が `AI_CONSENT_PROVIDERS` と同じ数と順で name / country / usage を含むこと (`ai_providers` ブロック) | 変更なし (満たす) | B |
| `tests/policy-pages-public.test.tsx` | `legal-document-meta`・`LegalDocumentMeta`・`最終更新日`・`h3`・`トップページへ戻る` | `<main>` の先頭が版の行、h1 が 1 つ、h3 が 1 つ以上、ソースに「最終更新日」が無い | 変更なし (満たす) | B |
| `tests/e2e/public-policy-pages.spec.ts` | `利用規約`・`プライバシーポリシー`・`トップページへ戻る` | h1 と戻るリンク | 変更なし | B |
| `tests/site-config-ui.test.tsx` | `PrivacyPage`・`getSupportEmail` | `/privacy` の窓口に `getSupportEmail()` が出る | 変更なし (`contact` ブロック) | B |
| `tests/seo-public-pages-1867.test.tsx` | `/terms`・`/privacy`・`publicPageMetadata` | metadata が `publicPageMetadata` の値 | 変更なし | B |
| `tests/public-claims-guard.test.ts` | `PUBLIC_PAGES`・`PUBLIC_SOURCE_FILES`・`FORBIDDEN` | 走査の対象に `/terms` `/privacy` が無い | `PUBLIC_PAGES` に 2 ページ、`PUBLIC_SOURCE_FILES` に 2 つの文面モジュールを足す (本文に禁止語が無いことを以後も守る) | B |
| `packages/shared/src/legal-versions.test.ts` | `LEGAL_DOCUMENTS`・`effectiveDate`・`実在する日付` | 版の形と、施行日が実在する日付の YYYY-MM-DD であること | 変更なし (仮の施行日 `'2026-10-19'` も公開日も満たす。§9.1) | B |
| `tests/legal-consent-page.test.tsx`・`tests/e2e/legal-consent-gate.spec.ts`・`src/__tests__/api/legal/accept.test.ts`・`tests/api/legal-status-route.test.ts`・`tests/legal-consent-api-schema.test.ts`・`tests/legal-consent-gate.test.ts` | `LEGAL_DOCUMENTS`・`effective_date`・`formatLegalEffectiveDate` | 版と施行日を `LEGAL_DOCUMENTS` から読むので、版の値と、YYYY-MM-DD の形の施行日の値には依らない。施行日の形を外すと、`/api/legal/status` が 500 (`src/lib/legal-consent-api.ts:17, 32`・`src/app/api/legal/status/route.ts:50-52`)、`resolveLegalConsentStatus` の結果が `LegalConsentStatusSchema` を通らず、施行日の表示の一致も外れる | 変更なし (仮の施行日も YYYY-MM-DD の形にする。§9.1) | B |
| `src/__tests__/api/cron/push-outbox.test.ts:176` | `'v2025.1'` | 版を直書きしているが、`LEGAL_CONSENT_ENFORCE` を未設定にしている (行 90) ので判定に使われず、緑のまま | `LEGAL_DOCUMENTS.terms_of_service.version` / `.privacy_policy.version` に置き換える (`import { LEGAL_DOCUMENTS } from '@homegohan/shared'`。`packages/shared/src/index.ts:12` が `legal-versions` を再エクスポートしている)。将来の版上げで「同意済みの利用者」の行が意味を失わないように | B |
| `tests/landing-page-1867.test.ts:530-531` | `href="/terms"`・`href="/privacy"` | フッターのリンク先 | 変更なし | — |
| `src/__tests__/lib/maintenance-mode.test.ts:66-68`・`tests/onboarding-routing.test.ts` | `/terms`・`/privacy` | 公開パスの判定 | 変更なし | — |
| `lib/supabase/__tests__/middleware.test.ts:512` (`describe.each(['/terms', '/privacy'])`・#1174)・`lib/supabase/__tests__/middleware-legal-consent.test.ts:251, 370-371`・`lib/supabase/__tests__/middleware-maintenance.test.ts:350-351` | `/terms`・`/privacy` | middleware が 2 つのパスを未ログイン・同意の前・メンテナンス中でも通すこと (公開パスの判定) | 変更なし (パスは変えない。middleware も変えない) | — |
| `tests/login-google-legal-note.test.tsx:48-49`・`tests/signup-legal-consent.test.tsx:96-97`・`tests/legal-parental-consent-page.test.tsx:35`・`tests/auth-callback-legal-consent.test.ts:191` | `/terms`・`/privacy`・`href="/privacy"` | ログイン・サインアップの同意の文・保護者の同意書のリンク先と、認証の戻り先が `/terms` のときの遷移 | 変更なし (リンク先のパスは変えない) | — |
| `tests/integration/security/feature-flags-runtime.test.ts:323-324` | `getPage('/terms')`・`getPage('/privacy')` | メンテナンス中でも 2 ページが 200 を返すこと (実際にページを GET する) | 変更なし (§8.3 のページは新しいサーバーの依存を足さず、`termsText` / `privacyText` は同期の純関数なので 200 のまま) | B |
| `apps/mobile/__tests__/components/PublicPage.test.tsx:85-87`・`apps/mobile/__tests__/components/account-frozen-gate.test.tsx:176`・`apps/mobile/__tests__/components/legal-consent-gate.test.tsx:144`・`apps/mobile/__tests__/lib/account-frozen.test.ts:267`・`apps/mobile/__tests__/lib/legal-consent.test.ts:153` | `/terms`・`/privacy` | モバイルが 2 ページを `getTermsUrl()` / `getPrivacyUrl()` の URL で開くこと・凍結と同意のゲートが 2 つのパスを公開として通すこと | 変更なし (モバイルのコードは変えない。§1) | — |
| `tests/integration/security/legal-documents-acceptance.test.ts`・`tests/integration/rls/push-outbox.test.ts:905-906, 924-925`・`src/__tests__/lib/push/outbox.test.ts:87-88`・`tests/legal-consent-minor-guardian.test.ts:17-18`・`packages/shared/src/parental-consent.test.ts:34-35` | `LEGAL_DOCUMENTS`・`_version_accepted` | 同意済みの版を `LEGAL_DOCUMENTS` の値から作る (`legal-documents-acceptance` はテスト用の版 `test-v1` など (行 91-94) で、DB は版の中身を見ない) ので、版の値に依らない。文面の文字列は見ない | 変更なし (版を v2026.1 に上げても緑) | B |
| `packages/shared/src/legal-consent-api.test.ts:330` | `'2025-01-01'` | 形の壊れた応答 (`version: ''`) を `isLegalConsentStatus` が弾くことの入力に、施行日の文字列を直書きしている。版 v2025.1 の施行日とは無関係の入力値 | 変更なし (`LEGAL_DOCUMENTS` の施行日を変えても、この入力は版が空なので弾かれたまま) | — |
| `tests/ai-consent-provider-inventory.test.ts` | `AI_CONSENT_PROVIDERS`・`https://` | 送信先と同意の一覧。`src`・`supabase/functions`・`shared`・`lib`・`packages`・`apps/mobile/app`・`apps/mobile/src` のコードの `https://<ホスト>` と送り先の SDK の import を集め、AI 事業者でないホストは理由つきの一覧に載っていることを求める | 変更なし (一覧は変えない。文面モジュールに `https://` を書かない規則 (§7) と T-7 で、新設のファイルが送信先として数えられないようにする) | A |
| `tests/push-expo-boundary-scan.test.ts` | `exp.host` | `src`・`supabase/functions`・`apps/mobile/src` の非テストの `.ts`/`.tsx` で `exp.host` を含むファイルが `src/lib/push/expo-transport.ts` だけであること (`expect(writers).toEqual([ALLOWED_FILE])`) | 変更なし。委託先の表の Expo の行の needle を `EXPO_PUSH_SEND_URL` にし (v1.5 の `exp.host` だと `src/lib/legal/privacy-text.ts` が数えられて赤になった。審査 R3 の指摘 6)、文面モジュールに `exp.host` を書かない (T-7 が検査する) | A |
| `tests/email-resend-boundary-scan.test.ts`・`tests/rate-limit-single-implementation.test.ts` | `resend`・`api.resend.com`・`@upstash/ratelimit` | `resend` の import と `api.resend.com` を含む文字列リテラル、`@upstash/ratelimit` の import を、許したファイルに限る (TypeScript の構文木で import と文字列リテラルを見る) | 変更なし (委託先の表の needle `resend`・`@upstash/ratelimit` は import ではなく、`api.resend.com` を含まない。審査 R3 の実測でも緑) | A |
| `src` を走査するその他の番兵 (`tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts`・`tests/env-source-scan.test.ts`・`tests/jst-today-source-scan.test.ts`・`tests/next15-async-request-api-scan.test.ts`・`tests/role-check-source-scan.test.ts`・`tests/signed-photo-display-scan.test.ts`・`tests/supabase-service-role-client-scan.test.ts`・`tests/operator-mfa-entry-points-scan.test.ts`・`tests/email-suppressed-log-level-scan.test.ts`・`tests/auth/*-source-scan.test.ts`・`tests/native-sign-out-order-source-scan.test.ts`) | 各テストの書き方 (`process.env`・`new Date`・service role の client・役割の判定・`error.message` の返し方など) | 文面モジュールと描画部品は、文字列のデータ・型・import・JSX だけで、これらが数える書き方を持たない | 変更なし (審査 R3 の実測で緑) | A |
| `tests/log-cleanup-dau-snapshot-contract.test.ts:213-214` | `failed_invite_lookups` | `failed_invite_lookups` に書き込む処理が無いので掃除のジョブを足さないこと | 変更なし (T-30 は同じ事実を「第3条に載せない理由」として使う。書き込む処理を足すときは、この番兵と T-30 の両方が直しを求める) | — |
| `tests/operator-mfa-db-gate-migration-contract.test.ts`・`tests/e2e-test-session.test.ts`・`tests/api/auth-mfa-routes.test.ts`・`tests/super-admin-mfa-reset-route.test.ts` | `MFA_REQUIRED_ROLES` | ロールの一覧と、DB・e2e の写しの一致 | 変更なし (T-31 は読むだけで、一覧を変えない) | — |
| `src/__tests__/lib/emails/account/login-new-device.test.ts:67` | `SESSIONS_SETTINGS_PATH` | 値が `/settings/security/sessions` であることを固定 (文面モジュールが import する) | 変更なし | — |
| `src/__tests__/lib/security/csp.test.ts` | `HOLIDAYS_API_ORIGIN`・`connect-src` | CSP の値の固定 (プライバシーポリシーの文面モジュールが `HOLIDAYS_API_ORIGIN` を import し、T-29 が `connect-src` を第10条と突き合わせる) | 変更なし | — |
| `tests/env-source-scan.test.ts`・`src/__tests__/lib/env.test.ts` | 環境変数名 | 新しい環境変数は無い | 変更なし | — |
| `tests/account-export-tables.test.ts` | テーブル名 | 新しいテーブルは無い | 変更なし | — |
| `lib/supabase/__tests__/middleware-legal-consent-matrix.test.ts:54-55, 192-193, 208` | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx`・`<LegalConsentBanner` | `PAGE_FILES` の 2 行がページのファイルの実在を検査する。お知らせ (`<LegalConsentBanner`) を描くのは `(main)` の下だけかを `src/app` の走査で検査する | 変更なし (2 ページのファイルは同じパスに残り、§8.3 のページと `LegalDocumentBody` は `<LegalConsentBanner` を描かない) | B |
| 設計書の lint (`scripts/` の `design-lint` 系・`gfm-integrity`・`doc-file-line-anchors`) | 本書の file:line | 本書のアンカーが実在すること | A 型の Haiku の検証の枠が流す | 設計 |
| 走査テスト (as any・マジックナンバー・PII) | `as any`・数のリテラル | 文面モジュールの数は `LEGAL_FACTS` から (直書きしない)。`LEGAL_FACTS` の各値には根拠コメント | §8.1 の形を守る | A |

---

## 17. 他の文書への追随表 (本書では編集しない。実装 PR または docs PR で)

| 文書 | 箇所 | 直すこと | 期日 |
|---|---|---|---|
| `docs/design/cross/CLAUDE.md` | ファイル一覧の表 | `20-terms-privacy-text.md` の行を足す (「利用規約・プライバシーポリシーの全文 (逐語の正典)・各条項 ⇄ 製品の根拠・版の上げ方」/ #1901) | 設計のマージと同日 |
| `docs/design/cross/08-legal-compliance.md` | §1「対象外: 利用規約・プライバシーポリシーの法的文書そのもの (法務担当が別途作成)」 | 「全文は cross/20 が正典」に現在形化 | 実装のマージと同日 |
| 同 | §3.1 の 6「利用規約 / プライバシーポリシーへのリンク」と §4.2 の `/legal/privacy#section5`・§12.1 の `/legal/privacy#cookies` | 実際のパスは `/terms`・`/privacy`。アンカーは `/privacy#privacy-6`・`/privacy#privacy-10` | 同上 |
| 同 | §7.2「版・施行日・同意文言は弁護士の確認を経て決める (T30)」「2026-10-10 … 版・施行日は仮置きのまま」 | 版 v2026.1・施行日 = 公開日に現在形化 (弁護士の確認の有無はオーナーの判断として残す) | 同上 |
| 同 | §8.1 の必須表示画面 5「利用規約 §X (法的文書内)」 | 「利用規約第9条 (cross/20 §6)」 | 同上 |
| 同 | §12 Cookie 同意バナー | 「広告・計測の Cookie を使っていないため置かない (cross/20 §7 第10条)。採用するときは本節を復活させ、プライバシーポリシーの版を上げる」の注記 | 同上 |
| 同 | §14 AI 生成コンテンツの著作権 | 「利用規約第14条として実装 (cross/20 §6)」の注記 | 同上 |
| 同 | §19 未解決「旧バージョン利用規約の docs/legal/archive/ 保管場所設定」 | 済 (`docs/legal/archive/v2025.1/`) | 同上 |
| 同 | §19 未解決「弁護士レビュー: 特商法表示内容・利用規約 §X の医療免責文言」 | 「cross/20 の全文を対象に含める。確認の有無はオーナーの判断」 | 同上 |
| `docs/design/cross/17-backup-automation.md` | §21「プライバシーポリシーへの追記は法務の確認の後」(cross/08 §16.3 も同じ文) | 「追記した (cross/20 §7 第12条)」 | 同上 |
| `docs/design/cross/15-data-subject-requests.md` | プライバシーポリシーの請求の節への参照があれば | 第14条 (`/privacy#privacy-14`) を指す | 同上 |
| `docs/design/cross/14-parental-consent.md` | 同上 (未成年の節) | 第15条・利用規約第5条を指す | 同上 |
| `docs/design/billing/01-billing-core.md` | §10 の確認画面のリンク先が cross/08 §3 の `/legal/terms` を参照していれば | `/terms` `/privacy` | 同上 |
| `packages/shared/src/legal-versions.ts` | 先頭コメント 17〜18 行 | §9.1 のとおり現在形化 (実装 PR で行う。設計正典ではない) | 実装 |
| `src/app/company/page.tsx` | 所在地が「準備中（確定次第掲載します）」で、`/legal` と本書の「請求があった場合に遅滞なく開示します」と食い違う | 候補: `DISCLOSED_ON_REQUEST` に揃える (本書の範囲外。`tests/public-claims-guard.test.ts:297-308` が「準備中」を固定しているので、直すときはテストも) | 候補 |
| `src/app/terms/page.tsx`・`privacy/page.tsx`・`legal/page.tsx`・`company/page.tsx` | フッター `© 2025 ほめゴハン` | 候補: 年の更新 (本書の範囲外) | 候補 |
| `apps/mobile/app.json` | iOS の `NSPhotoLibraryAddUsageDescription` (「解析結果の保存のために写真ライブラリへ追加する場合があります」)・Android の `RECORD_AUDIO`・`WRITE_EXTERNAL_STORAGE` | 使うコードが無い (F-25)。プライバシーポリシー第3条は使う機能 (カメラ・写真の選択・通知) だけを書き、マイクの音声は取得しないと書く。候補: 宣言を外す (ストアの申告と食い違わないように)。外すときは T-26 の既知の一覧も減らす。本書の範囲外 | 候補 |
| `src/lib/ai/consent-config.ts` | `AI_CONSENT_COPY.dataCategories` (6 項目) | 実際に AI 事業者へ送る項目 (プロフィール・持病・服薬・妊娠/授乳の状況・ニックネーム。F-29) より狭い。プライバシーポリシー第6条は実際の項目を書いたので、同意画面の文と食い違う。候補: 同意画面の文に項目を足し、`AI_CONSENT_VERSION` を上げる (AI の同意の取り直しが起きる)。本書の範囲外 (P-8)。Q-18 | 候補 (別 Issue) |
| `src/app/(main)/family/members/[id]/page.tsx`・`src/app/(main)/settings/membership/page.tsx` | 健康の記録の共有 (`share_health`) の切り替え | 切り替えられるが、読む経路が無い (F-18)。利用規約第11条 2 項・プライバシーポリシー第9条は「現在、家族に健康の記録を表示する機能はありません」と書いた。候補: 切り替えの文に同じ注記を出すか、機能を作る (作るときはプライバシーポリシーの版を上げる)。本書の範囲外 | 候補 |
| `src/lib/seo/public-pages.ts` | `/terms` `/privacy` の description | 変更不要 (「利用規約です」「プライバシーポリシー (個人情報の取り扱い) です」のまま) | — |
| `src/app/(operator)/operator/membership/families/inactive/page.tsx:133`・`orgs/inactive/page.tsx:137` | 解散の理由の入力欄の例文「代表者が90日以上未ログインのため…」「オーナーが90日以上未ログインのため…」 | 一覧の判定 (30 日) と見出し (30日以上未ログイン) と食い違う。利用規約第11条 6 項・第12条 4 項は判定の 30 日を書いた (F-21)。候補: 例文の日数を 30 に揃える (本書の範囲外。T-6 は例文を見ない) | 候補 |
| `lib/legal-consent.ts` (`EXEMPT_PREFIXES`)・`src/app/legal-consent/LegalConsentForm.tsx` の `declined` の画面 | 版上げの後、同意の前の人には退会・書き出し・解約の画面が無い (F-32) | 利用規約第10条 4 項・第17条 1 項・第24条 2 項は、この間の手段をお問い合わせ (運営が手で削除・解約する) と書いた。候補: 同意の前でも本人が自分で退会・書き出し・解約できる画面 (凍結中の `/frozen/account`・`/frozen/billing` と同じ部品) を `declined` の画面から開けるようにする。作ったら、3 つの条の「お問い合わせから依頼」を画面の案内に改め、版を上げる (Q-23) | 候補 (別 Issue) |
| `src/app/(org)/org/members/page.tsx:52` | 組織のメンバーの一覧が `user_profiles` を直接読むが、SELECT の RLS は本人の行だけ (F-19) | 組織の管理者には自分の行しか出ない (画面の意図と食い違う)。利用規約第12条 1 項・プライバシーポリシー第9条は、画面が読む項目 (表示名・組織内の役割・参加日) を上限として書いた。候補: 一覧を service_role の API で返すなど (本書の範囲外。直しても見える項目が同じなら文面は変えない) | 候補 (別 Issue) |

---

## 18. 未解決事項・弁護士の確認を勧める点・openQuestions

| # | 事項 | 本書の置き方 | 誰が決めるか |
|---|---|---|---|
| Q-1 | 公開の前に弁護士の確認を受けるか | 受けることを勧める (Issue #1901 の「進め方」と同じ)。確認で文面が変わるなら本書を改定し、版は §9.3 の規律 | オーナー |
| Q-2 | AI 事業者への送信を「第三者提供 (同意)」と扱うか「委託」と扱うか。エストニア (EU) の事業者は 28 条 1 項の指定国なので同意は法律上不要だが、本書は同意画面の仕組み (全事業者) に合わせて同意を取る形で書いた | 現行の仕組み (全事業者の同意) のまま。法的な整理は弁護士の確認 | 弁護士 |
| Q-3 | アメリカ合衆国の制度の情報の文 (第6条) が PPC の調査結果 (USA_report.pdf) に照らして十分か。「本人の権利利益に重大な影響を及ぼす可能性のある制度」(政府のアクセス) に触れるか | 概要だけを書いた。確認で補う | 弁護士 |
| Q-4 | 委託先 (Supabase・Vercel・Resend・Stripe・Upstash・Expo・Cloudflare・GitHub・Google) との契約 (DPA・利用規約) が 28 条 1 項の「基準適合体制」に当たるか。第7条はそう書いている | 各事業者の DPA を受諾していることをオーナーが確認する (未確認なら第7条 2 を「同意」の形に書き換える) | オーナー・弁護士 |
| Q-5 | 法 32 条の「住所」を `DISCLOSED_ON_REQUEST` (請求時開示) のままでよいか | 現行の特商法の表記と同じ扱い | 弁護士・オーナー |
| Q-6 | 第 21 条 2 項の責任の上限 (損害の前 12 か月に受け取った有料プランの料金。受け取っていないユーザーには上限を適用せず、1 項の通常損害の限定だけ) が消費者契約法 8 条・10 条に照らして妥当か | `LEGAL_FACTS.liabilityCapMonths = 12` | 弁護士 |
| Q-7 | 第 27 条の専属的合意管轄 (本店所在地) が消費者との関係で有効か | 現行どおり | 弁護士 |
| Q-8 | 電気通信事業法 27 条の 12 の対象役務に当たるか (当たらなくても第10条で公表する) | 公表する | 弁護士 |
| Q-9 | 認定個人情報保護団体への加入の有無 | 未確認なので書かない | オーナー |
| Q-10 | AI 事業者の正式名称・所在地・保存期間・学習利用の有無 (`consent-config.ts:23-31` の宿題) | 同意画面と同じ呼び名と国だけ | 弁護士・オーナー |
| Q-11 | 本番の Supabase のリージョン (cross/07 §5.1 は東京)。「日本国内に保管」と書くなら確認が要る | 書かない (委託先の所在国だけ) | オーナー (MCP の読み取りで確認可) |
| Q-12 | `effectiveDate` (公開日) | 実装は仮の施行日 `'2026-10-19'` と目印のコメントで置き、マージ直前に公開日へ置き換える (§9.1・§9.4 の 3) | オーケストレーター |
| Q-13 | Google OAuth で Google から受け取る項目 (識別子・メールアドレス・名前・プロフィール画像) の実測 (Supabase の `raw_user_meta_data`) | 第3条の表に書いた。実装の整合ゲートで本番の 1 行を読んで確かめる | 整合ゲート |
| Q-14 | 法令で残す記録 (クーポン・紹介・監査ログ) の保存の期限 (cross/08 §16.3「未決」) | 「法令と当社の定めによります」 | オーナー |
| Q-15 | `src/app/company/page.tsx` の所在地「準備中」と `/legal`・本書の「請求時開示」の食い違い | §17 の候補行 | オーナー |
| Q-16 | AI 事業者への提供の記録 (法 29 条) を同意の記録 (`external_data_consents`) で代えてよいか、またその保存の期間 (規則 21 条) と、退会で同意の記録が即時に消える (`ON DELETE CASCADE`。F-26) ことの関係。AI 事業者への提供を「第三者提供」でなく本人の指示による送信と整理できるかも含む (Q-2 と関連) | プライバシーポリシー第6条の 5 は「同意の記録を提供の記録として保存し、開示の請求にはこれをもとに答える」とだけ書き、退会後の保存は約束しない | 弁護士・オーナー (保存が要るなら別の設計で退会後も残す記録を作る) |
| Q-18 | AI の同意 (`AI_CONSENT_COPY` の 6 項目で取った同意) が、実際に送っている要配慮個人情報 (持病・服薬・妊娠/授乳の状況) とプロフィールの項目 (F-29) まで含む同意として足りるか (法 20 条 2 項・28 条 2 項の「情報の提供」) | プライバシーポリシー第6条には実際の項目を書いた。同意画面の文の追随と `AI_CONSENT_VERSION` の更新は別 Issue の候補 (§17) | 弁護士・オーナー |
| Q-19 | 同意を得ない規約の変更 (民法 548 条の 4) の定めを置くか | 置かない。内容が変わる変更はすべて再同意で行う (再同意のゲートがあるので同意を得ない変更の経路が要らない)。置くなら、施行日の前に変更後の全文をお知らせに載せる工程を §9.4 に足す | 弁護士・オーナー |
| Q-20 | 個人情報の取扱いの責任者と、人的な安全管理措置 (従業者の教育・守秘) | 根拠が無いので書かない (§0.6)。決まったら第1条・第11条に足して版を上げる | オーナー |
| Q-17 | `apps/mobile/app.json` の使っていない権限の宣言 (`NSPhotoLibraryAddUsageDescription`・`RECORD_AUDIO`・`WRITE_EXTERNAL_STORAGE`) を外すか | 本書では変えない。ポリシーは使う機能だけを書く (§17 の候補行) | オーナー |
| Q-21 | 版上げの後、同意の前の有料プランの利用者からお問い合わせで解約の依頼を受けたとき、運営が決済代行事業者 (Stripe) の管理画面で解約する運用 (コードの経路は無い。F-32) と、自動更新の日に間に合わせる期限をどう決めるか | 利用規約第10条 4 項・第24条 2 項は「お問い合わせから解約を依頼してください」とだけ書き、処理の期限は約束しない。有料プランは販売開始前 (P-5) なので、販売開始までに運用の手順を決めるか、Q-23 の画面を作る | オーナー |
| Q-22 | 代表者・オーナーの未ログインの日数を文面に書くか | 運営の一覧の判定 (30 日。F-21) を書いた (`LEGAL_FACTS.inactiveRepresentativeDays = 30`・T-6 が判定と突き合わせる)。日数を書かずに「長期間ログインしていないなど」とする案もある (そのときは `LEGAL_FACTS` からこの項目と T-6 を外す)。業務の判断で日数を変えるときは、判定の RPC と文面を一緒に変えて版を上げる | オーナー |
| Q-23 | 同意の前でも本人が自分で退会・書き出し・解約できる画面を作るか (§17 の候補行) | 本書では作らない (DB・API・画面を変えない範囲)。作れば、第10条 4 項・第17条 1 項・第24条 2 項の「お問い合わせから依頼」が画面に置き換わり、Q-21 の運用も要らなくなる | オーナー |
| Q-24 | 同型の指摘 (文面の主張が実装と食い違う) が審査の周をまたいで続いた (R2 のログインの履歴の IP → R3 の同意の記録の IP・組織の見える項目・メール・多要素認証)。発生源を消す構造として、文面のすべての主張の文に根拠のアンカー (ファイルと語。`PRIVACY_PROCESSORS` の `evidence` と同じ形) を持たせ、テストがアンカーの実在を確かめる形 (文と根拠の対応表をデータにする) に広げるか | 本書では、食い違いが出た面ごとに機械の検査を置いた (T-30 = IP・User-Agent を持つ表、T-31 = 多要素認証の対象、T-32 = 組織の画面が読む項目、T-6 = 未ログインの日数の判定、T-7 = needle の形)。全文に広げるのは文面の版の改定のときに検討する | オーナー (次の改定) |
| Q-25 | 本番で運営の多要素認証の猶予 (`OPERATOR_MFA_ENFORCE_FROM`) が未来の日時に設定されていないか | プライバシーポリシー第11条は「管理者の権限などを持つ担当者のログインには、多要素認証を求めています」と書いた (F-35)。猶予中なら、公開の前に猶予を終えるか、文を「求めることにしています」に改める | 整合ゲート・オーナー |

---

## 19. 改定履歴

| 版 | 日付 | 変更 |
|---|---|---|
| v1.0 | 2026-10-19 | 新規作成 (#1901)。利用規約 28 条 + 附則・プライバシーポリシー 18 条 + 附則の全文、型と描画部品、版 v2026.1、対応表、表 3 点、テスト 24 本、段分け、番兵の追随表 |
| v1.1 | 2026-10-19 | 網羅性の反映 (周 1): プライバシーポリシー第6条に提供の記録 (5)・第4条に仮名加工情報・匿名加工情報を作成しない旨・第3条に端末の機能の表と取得しないもの・第10条に参照。利用規約第5条の 4 をつながりの回復 (追加し直し・18 歳) に合わせた。F-25〜F-28・R-20〜R-21・§3 の法 29 条と 2 条 5・6 項の行・§11.1 の凍結中の行・§11.3 の (current, 退会)・(old, 凍結)・凍結の解除・つながりの切断と回復と退会の行と判定の順・T-25〜T-26・§16 の matrix テストの行・§17 の app.json の行・Q-16〜Q-17。プッシュの止まり方のコードを `consent_outdated` に直した (S-7・§4.2・§4.3・§9.2・F-7) |
| v1.2 | 2026-10-19 | 審査 R1 の反映: 利用規約第4条とプライバシーポリシー第10条のリンク先を実在の `/settings/security/sessions` (`SESSIONS_SETTINGS_PATH`) に (`SECURITY_SETTINGS_PATH` を廃止)・§8.1 の JSDoc の `*/` を除いた・利用規約第24条を再同意の実際 (同意の前は請求とお問い合わせだけ・施行日の前のお知らせ) に合わせ、§9.4 にお知らせの工程・§9.3 に外部送信の行・§11.3 の未同意の退会・書き出しの行を直した・写真は家族と組織に出ず運営は審査で見ることがある (第13条・第5条・第9条)・健康の記録は家族に出ない (第11条・第5条・第9条)・保護者が代わりに記録できるのは本人のアカウントが無い家族だけ (第5条・第11条・第15条)・AI に送る項目にプロフィールと健康の項目・ニックネームを足し「氏名は送りません」を削除 (第6条・第5条)・送信停止の記録はアドレスのまま、保護者の同意の記録は退会後も残る (第17条・第3条・第12条)・責任の上限を料金を受け取っていないユーザーに適用しない (第21条)・祝日の一覧と Supabase を外部送信に足した (第10条)・「遅滞なく」を戻した (第14条)・取扱いの責任者と人的な措置を削除。F-29〜F-33・R-22〜R-23・S-17・T-27〜T-29・§16 の 2 行・§17 の 2 行・Q-18〜Q-20 |
| v1.3 | 2026-10-19 | 網羅性の反映 (周 2): §11.3 の凍結の行を none にも広げ (凍結されうるのは `user_profiles` の行がある人)、none と current の凍結の解除・凍結中の退会・書き出し・有料プランの解約・お問い合わせの行を足した・プライバシーポリシー第12条の保存期間の表にプッシュ通知の宛先・AI 機能の利用回数・回数の制限の計数の行を足し、アプリの動作のログの行がブラウザのセキュリティ違反の報告を含むことを書いた (§10.2 の根拠も)・§15 に `MAIN_CLASS` (ページのローカル。`LEGAL_MAIN_CLASS` は新設しないと確定し §8.3 の注を直した)・`LEGAL_TEXT_FORBIDDEN_CLAIMS` (テストのローカル)・既存ファイルの変更の行を足した・冒頭の実装の範囲に既存のテスト 2 本を足し、`push-outbox.test.ts:176` の置き換えを任意から確定に (§14・§16)・§0.7 に章構成テンプレートとの対応表 (データモデルと API は該当なし)・§3 に法令の一次資料の表 (§3.1。消費者契約法・景品表示法・健康増進法・薬機法・特定商取引法の出典) を足し、要件の表を §3.2 にした・R-11 の保存期間の列挙 |
| v1.4 | 2026-10-19 | 審査 R2 の反映: 施行日の仮置きを `'<公開日はマージ時に確定>'` から YYYY-MM-DD の形の仮の施行日 `'2026-10-19'` + 行末の目印のコメントに替えた (形を外すと `/api/legal/status` が 500・`legal-consent-api-schema`・`legal-status-route`・`legal-consent-page`・`policy-pages-public` のテストも赤になるため。段 B は全件緑・既知の赤なし。§0.6・§9.1・§9.4 の 3・§14・§16・T-17・Q-12)・プライバシーポリシー第3条の IP の文を実装 (IP の全体を保存し、ネットワークの範囲と Web のログインでは国も記録・本人の画面とお知らせのメールに出し運営も見る) に合わせた (F-17・§10.2・§11.2・T-28)・利用規約第16条 5 項と第18条 4 項を軽過失の全部免除から「第21条に定める範囲で責任を負う」に改めた (R-4・§3.2・§10.1・§11.2・T-28) |
| v1.5 | 2026-10-19 | 網羅性の反映 (周 3): §16 の走査の範囲に `apps/mobile/__tests__` を足し、パス `/terms` `/privacy` を持つテスト 21 本がすべて表にあることを書いた。§16 に middleware の公開パスの番兵 3 本・ログイン / サインアップ / 保護者の同意書 / 認証の戻り先のリンク先の番兵 4 本・メンテナンス中のページの GET (`feature-flags-runtime`)・モバイルの番兵 5 本・版を `LEGAL_DOCUMENTS` から読む番兵 5 本・`legal-consent-api.test.ts:330` の施行日の直書き (無関係の入力値) の行を足した (すべて変更なし)。§4.1 の構造に `tests/legal-document-body.test.tsx` と既存のテスト 2 本の追随を足し、§13・§14・§15 と揃えた |
| v1.6 | 2026-10-19 | 審査 R3 の反映: 利用規約第19条とプライバシーポリシー第16条から「一部のメールは設定画面で止められる」を外し、メールは止める設定が無いと書いた (F-34)。利用規約第24条 1 項・プライバシーポリシー第18条 1 項の「必要に応じてメールでもお知らせ」を外した (一斉メールの仕組みが無い)・利用規約第10条 4 項・第17条 1 項・プライバシーポリシー第13条 1 項・3 項に、版上げの後の同意の前は第24条 2 項 (お問い合わせからの削除と解約の依頼・開示の請求) によると書き、第24条 2 項に解約の依頼と、同意の前は設定画面を使えないことを足した (R-24・§11.3・Q-21・Q-23)・プライバシーポリシー第12条のお問い合わせの記録を、メールアドレスを伏せ件名と本文は残す実装に合わせた (F-36)・第11条の多要素認証を管理者などのロールに限った (F-35)・未ログインの日数を運営の一覧の判定の 30 日にし、T-6 を RPC の判定と見出しに結んだ (F-21・Q-22)・委託先の表の Expo の needle `exp.host` が `tests/push-expo-boundary-scan.test.ts` を赤にするので `EXPO_PUSH_SEND_URL` に替え、GitHub の needle も `apt-get install -y age` に替え、needle の規則 (§7) と T-7 の形の検査と §16 の走査テストの行を足した・同意の記録 (`terms_acceptances`) が IP と User-Agent を残す実装に合わせて F-17・§9.2・第3条・第12条を直し、IP・User-Agent を持つ表の全体 (F-37) を T-30 で第3条と突き合わせる形にした (`failed_invite_lookups` は書き込む処理が無いので第3条に載せない)・組織の管理者に見える項目を画面と API が読む項目 (表示名・組織内の役割・参加日・招待の状況・メンバー数と部署ごとの人数・チャレンジの参加人数と平均) にし、社員番号・最終ログイン・ライセンスの状態を外した (利用規約第6条・第12条・プライバシーポリシー第3条・第9条・F-19・T-32)・家族の招待の状況が代表者と大人のメンバーに見えることを第9条に書いた・利用規約第2条・第10条 5 項・第12条 5 項のライセンスの書き方を、参加できる人数の枠 (招待の承諾で 1 つ使う) と組織からの削除に合わせた。R-24〜R-25・F-34〜F-37・T-30〜T-33・§11.2 の 4 行・§16 の 5 行・§17 の 3 行・Q-21〜Q-25 |
