# cross/20 利用規約・プライバシーポリシーの本文 — 製品の実際の動きと法令に合わせた全文 (逐語の正典) と、版の上げ方

| | |
|---|---|
| 版 | v1.18 (2026-10-22) |
| Status | 実装済み・公開済み (#1918 2ba5b3b3・2026-10-19)。版 v2026.2 (#1917 465727de・2026-10-21) と v2026.3 (#1930 f14f1741・2026-10-22) も公開済み。設計ゲート通過 (2026-10-19・wf_99d1e18c-96b の R1 で Opus・Sonnet の 2 枚が PASS)。実装は wf_9f341b60-578 (段 A・段 B) と、§18 Q-23・Q-27 の結論の反映 (v1.14)。公開の後の整合ゲート wf_1f7af830-226 で 2 枚とも PASS |
| Issue | #1901 |
| 範囲の正本 | Issue #1901 の本文とコメント。前提と判断は本書 §0.1 に文として書く |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする |
| 実装の範囲 | `src/lib/legal/` (新設 4 本)・`src/components/legal/LegalDocumentBody.tsx` (新設)・`src/app/terms/page.tsx`・`src/app/privacy/page.tsx`・`packages/shared/src/legal-versions.ts` (版)・新設のテスト (§13。`tests/legal-claims-1901.ts` の主張の表を含む)・既存のテスト 3 本の追随 (`tests/public-claims-guard.test.ts` の走査の対象・`tests/site-config-ui.test.tsx` の画面の一覧・`src/__tests__/api/cron/push-outbox.test.ts:176` の版の直書き。§14 段 B・§16)・`docs/legal/archive/` (旧版の控え)。v1.14 で、同意の前の退会と書き出しの画面 (`src/app/legal-consent/account/`・共通の部品 `src/components/account/AccountSelfServicePanel.tsx`)・同意画面の案内 (`LegalConsentForm.tsx`・`LEGAL_CONSENT_COPY`)・保護者の同意書と未成年の案内の文と版 (`packages/shared/src/parental-consent.ts`・子どもの追加の画面の注意書き) を足した (§14 段 C)。DB・API・モバイルのコード (コメントを除く) は変えない |

発注 (Issue #1901 に記録された 2026-10-19 08 時台の指示) の逐語: 「利用規約とプライバシーポリシーが薄すぎる。しっかり内容作り込んで。今では明らかに足りないでしょう」

本書の中心は **§6 (利用規約の全文)** と **§7 (プライバシーポリシーの全文)** の 2 つの TS ブロックと、**§10 (主張の表。本文の 1 文 = 1 行で、根拠つき)** である。実装 (B 型) は、この全文をそのままモジュールに置き、ページをそのモジュールから描く形に替え、版を上げ、再同意を動かすだけで済む。

本文には、**法令が求める事項と、ユーザーの権利と義務に関わる約束だけ**を書く。製品の操作の細部 (画面の名前・道順・機能の一覧・役割ごとの見え方) は書かず、未完成や予定を示す書き方も書かない (§6 の規則・P-9〜P-11)。有料プランの条文は、有料プランの販売 (#1912) の設計書 `docs/design/billing/03-paid-plans-and-iap.md` §11 が利用規約第10条・第11条 1 項・第16条 2 項・第17条・第24条とプライバシーポリシー第3条・第4条・第7条・第10条・第12条に足した項だけ (版 `v2026.3`。v1.17)。取得する情報・送り先・保存期間は種類の水準で書き、漏れは表と実コードの機械の突き合わせ (T-29・T-30・T-34・T-36) で閉じる。

⚠ **公開の前に弁護士の確認を受けることを勧める** (確認の有無はオーナーの判断。Issue #1901 の「進め方」も同じ扱いを求めている)。本書の文面は、製品の実際の動き (file:line) に当たる約束だけで書いたが、法令の当てはめ (委託と第三者提供の区別・外国の制度の情報・責任の制限の範囲・管轄の定め方・公表の具体性) は法律の専門家の確認を要する。確認で変わりうる点は §18 に列挙した。

---

## 0. 外形固定と分冊判定 (相 1)

### 0.1 発注と前提

| # | 前提 | 出どころ |
|---|---|---|
| P-1 | 作るのは `/terms` と `/privacy` の本文。同意の仕組み (再同意・同意画面・API・モバイルのゲート) は既存のまま使い、版を上げて動かす | Issue #1901「版を上げると、既存の再同意の仕組み (#1174) で利用者に同意し直してもらう」 |
| P-2 | 主張・約束は製品の実際の動き (file:line) に当たるものだけ。できないことを約束しない | 本文の 1 文ごとに §10 の主張の表 (`LEGAL_CLAIMS`) の 1 行と根拠を持ち、T-35 が本文と表の 1 対 1 を確かめる。根拠の無い約束は書かない |
| P-3 | 事業者の名称・所在地・代表者・連絡先・営業時間は、`src/lib/business-info.ts` の定数 (特定商取引法に基づく表記と運営会社のページと同じ値) から出す。電話番号は載せず、請求があれば遅滞なく開示すると書く (P-10)。値を文面に手で写さない | F-4・F-56・P-10 |
| P-4 | 今ある約束はすべて引き継ぐ: 現行 `/terms` 第 1〜9 条・`/privacy` 第 1〜7 条・cross/08 §8 (医療免責の文)・§14 (AI 生成物の著作権 3 項)・AI の同意の文面 (`AI_CONSENT_COPY`)・保護者の同意書・特商法の表記 | §2.2 F-1〜F-4 |
| P-5 | 有料プランは、いま買えない: 買えるプラン (`listPurchasablePlans`。決済の価格の ID を持つ公開のプラン) は 0 件で、本番の決済の顧客・契約・クーポンの利用の記録も 0 行 (2026-10-19 の読み取り。F-57)。本書の版の本文は有料の条文を書かない (P-9)。課金の仕組み (billing/01) は実装済みで、有料の条文は販売の案件 (#1912) が版を上げて足す (v1.17: billing/03 §11 が足し、版を `v2026.3` に上げた) | F-57・P-9 |
| P-6 | 本番の同意ゲートは `LEGAL_CONSENT_ENFORCE=on` (2026-10-10 のオーナー判断、cross/08 §7.2)。版を上げてデプロイした時点から、サインイン中の全員に再同意が求められる | cross/08 §7.2・`packages/shared/src/legal-versions.ts:4-15` |
| P-7 | 旧版の文面は `docs/legal/archive/v<版>/` に控えを置く (cross/08 §7.2「改定のたびに手で行う」・§19 TODO)。本書の実装で初めて作る | cross/08 §7.2・§19 |
| P-8 | AI の同意の文面 (`AI_CONSENT_COPY`・`AI_CONSENT_VERSION = 'draft-2026-10-10'`) は本書では変えない。プライバシーポリシーの AI の節は、同意画面と同じ事業者の一覧 (`AI_CONSENT_PROVIDERS` / `AI_CONSENT_PROVIDER_INFO`) から出し、食い違わないようにする。保護者の同意書 (`PARENTAL_CONSENT_DOCUMENT`) は v1.13 までは変えないとしていたが、P-12 の Q-27 の結論で、実装に無い約束を消して版を上げる (§14 段 C) | `src/lib/ai/consent-config.ts:16-31, 85-116`・`supabase/functions/_shared/ai-consent.ts:33, 42` |
| P-9 | オーナーの指示 (2026-10-19 11 時台) 逐語:「あと、全体として「まだできてません」みたいなのは書かないで取り除いて？価格も決めてしまいましょうかね。あとアプリ版はAppStoreやPlayStore経由で決済できないといけないよ」。選択式の回答:「準備中」の撤去 = 利用者と公開ページすべて。アプリ内課金 = RevenueCat。続けてオーナー「StripeはAppができないと申請できません。他もそうでしょう？」。本書はこれを次のように受ける: (1) 本文に未完成や予定を示す書き方をしない (R-32・T-6)。(2) 有料プランの条文 (価格・自動更新・解約・返金・App Store / Google Play での購入・決済の事業者への送信) は本書の版では書かず、有料プランの販売の案件 (#1912) が価格を公開する段で両文書の版を上げて足す (R-30・T-33・§17 の #1912 の行)。(3) 後から有料の条文を足しやすいように、料金の条を第10条に置き、項を足せば済む形にする (§6) | 本行の逐語 (2026-10-19 11 時台)・Issue #1911・#1912 |
| P-10 | オーナーの選択 (2026-10-19 11 時台・選択式):「全部そのまま使う」— 株式会社MHD医健の公開の会社情報 (mhd-iken.com の /api/company-info): 所在地 〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F / 設立 2025年1月31日 / 資本金 2,000,000円 / 代表者 堀 大輔 / メール info@mhd-iken.com / 営業時間 平日 9:00-17:00 (年末年始を除く)。電話番号 = 「請求があれば遅滞なく開示と書く」。本書はこれを次のように受ける: 規約とポリシーの事業者の名前・所在地・代表者・連絡先・営業時間は `src/lib/business-info.ts` の定数 (#1911 が入れる。F-56) から読み、プライバシーポリシーの個人情報の取扱いの窓口はお問い合わせのフォームと上のメールアドレスにする (§7 第1条・第17条、§6 第28条) | 本行の逐語 (2026-10-19 11 時台)・Issue #1911 |
| P-12 | 公開の前に決める事項 (§9.4 の 3・§18) のオーナーの選択 (2026-10-19 14 時台・選択式) 逐語: Q-23 (同意の前の退会)「同意なしでも退会・書き出しできるようにする (推奨)」。Q-27 (保護者の同意書)「同意書の文を実装に合わせて直す (推奨)」。Q-26 (解散)「利用者が自分で解散できるようにする (推奨)」。公開「予告なしで直し次第公開 (推奨)」。本書はこれを次のように受ける: (1) Q-23: 同意の前でも本人が退会とデータの書き出しを行える画面 `/legal-consent/account` を置き、同意画面・未成年の案内・「同意しない」の後の案内から案内する。利用規約第5条 3 項・第17条 1 項・第24条 2 項とプライバシーポリシー第13条 4 項をこの事実に合わせる (§14 段 C・§11.3)。(2) Q-27: 保護者の同意書・未成年の案内・子どもの追加の画面の文から実装に無い約束を消し、同意書の版を v2026.2 に上げる。(3) Q-26: 利用者が解散する機能は別の案件 (別の Issue と設計) で作る。本書の版の利用規約第11条 4 項・第12条 4 項 (お問い合わせ) は変えない。機能は #1917 (family/11) で作り、文面は §6・§7 のとおり改めた (版は family/11 §18.4)。(4) 公開: ローンチ前で利用者がいないので、§9.4 の 2 (お知らせへの予告) は今回は行わない。施行日 = 公開日 | 本行の逐語 (2026-10-19 14 時台) |
| P-11 | 本文に書くのは、法令が求める事項 (利用目的・取得する情報の種類・第三者提供と委託と外国への提供・外部送信の公表・保存期間・安全管理措置・開示等の請求の手続・未成年と保護者・事業者の情報・免責と責任の範囲・規約の変更) と、ユーザーの権利と義務に関わる約束だけ。製品の操作の細部 (メニューや画面の名前の引用・「設定の〜から」の道順・機能の一覧の列挙・役割ごとの細かい見え方) は書かない。v1.11 までの審査で「本文の製品の細部が実装と違う」指摘が 1 周ごとに別の箇所で出た (R1 15 → R2 3 → R3 9 → R4 約 10 → R5 約 8) 発生源が、本文が細部を説明していることだったため (§18 Q-24) | 本書の方針 (v1.12。審査の指摘の発生源への対処)・§18 Q-24 |

### 0.2 要件行列

| # | 要件 | 根拠 | 本書の対応 |
|---|---|---|---|
| R-1 | 利用規約に、ユーザーの権利と義務に関わる定め (AI 機能・利用回数の上限・料金・家族・組織・公開の範囲・凍結・退会・未成年) を書く。製品の操作の細部は書かない (R-28) | Issue #1901・P-11 | §6 第 5〜17 条 |
| R-2 | 利用規約に医療免責 (cross/08 §8 の文をそのまま) と急病時の 119 の案内を置く | cross/08 §8 の 5「利用規約 §X」 | §6 第 9 条 |
| R-3 | 利用規約に AI 生成物の著作権 (ユーザー帰属・匿名化した集計利用・口コミの CC0 相当) の 3 項を置く | cross/08 §14 | §6 第 14 条 |
| R-4 | 責任の制限は消費者契約法 8〜10 条の範囲 (故意・重過失を除外、軽過失は通常損害に限る、全部免除にしない)。個別の条 (凍結などの措置・サービスの変更や中断) の損害も、責任を負わない形にせず第21条の範囲に寄せる | 消費者契約法 8 条・8 条の 2・9 条・10 条 (§3) | §6 第 16 条 5 項・第 18 条 4 項・第 20〜21 条 |
| R-5 | 内容が変わる規約の変更は、再同意の仕組み (ユーザーの同意による変更) で行い、変更の概要と施行日を施行日の前に本サービスのお知らせ (ホームに出る) に掲載する。同意を得ない変更 (民法 548 条の 4) の定めは置かない (Q-19) | 民法 548 条の 2〜4・#1174・F-31 | §6 第 24 条・§9.4 |
| R-6 | プライバシーポリシーに、集めるデータの全種類 (種類の水準)・利用目的・要配慮個人情報の取得の同意を書く | 個人情報保護法 17・18・20 条 2 項・21 条 | §7 第3〜5条 |
| R-7 | 外国にある第三者 (AI 事業者) への提供は、国名・制度の情報・事業者の措置の情報を示したうえで同意を得る形にする。事業者の一覧は同意画面と同じ定数から出す | 法 28 条 2 項・規則 17 条・`tests/business-info-legal-pages.test.ts:139-167` | §7 第6条 |
| R-8 | 委託先 (Supabase・Vercel・Resend・Upstash・Expo・Cloudflare・GitHub・Google) を用途・渡る情報・所在国つきで列挙し、外国への委託の扱い (法 28 条 1 項の基準適合体制) を書く。決済の事業者は有料の条文と一緒に #1912 が足す (R-30) | 法 25 条・27 条 5 項 1 号・28 条 1 項・規則 16 条 | §7 第7条 |
| R-9 | 保有個人データの公表事項 (事業者の名称・住所・代表者・利用目的・請求の手続・苦情の申出先・安全管理措置) を書く | 法 32 条 1 項・施行令 10 条 | §7 第1条・第4条・第11条・第14条・第17条 |
| R-10 | 開示等の請求の手続 (請求の窓口・本人確認・期限・第三者提供記録の開示) を実装どおりに書く。AI 事業者への提供の記録が何であるかを書く | 法 29 条・33〜35 条・cross/15 | §7 第6条の 5・第14条 |
| R-11 | 保存期間 (隠した投稿・ログ (ブラウザのセキュリティ違反の報告を含む)・ログイン履歴・送信待ち・回数の制限の計数・解散した家族グループ・バックアップ・退会後に残るもの) を、種類の水準で実装の値から書く | cross/17 §9.1・各 migration・F-53 | §7 第12条 |
| R-12 | 外部送信 (Cookie・ブラウザの保存・ブラウザから直接の Supabase・Vercel Speed Insights・Turnstile・Google・祝日の一覧 (GitHub Pages)・Expo の通知) を、電気通信事業法 27 条の 12 の公表事項 (送る情報・送り先・目的) の形で書く。広告・計測の Cookie は使っていない | 電気通信事業法 27 条の 12・`src/__tests__/lib/security/csp.test.ts:264-272` (PostHog 不採用)・F-15 | §7 第10条 |
| R-13 | 未成年 (18 歳未満は保護者の同意・13 歳未満の本人アカウント無し) を両文書に書く | cross/14・`packages/shared/src/parental-consent.ts:12-16` | §6 第 3・5 条・§7 第15条 |
| R-14 | 家族・組織で誰に何が見えるかを、種類の水準で書く (役割ごとの操作の列挙はしない)。組織の管理者に見える情報は、組織の画面と API が読む項目を上限にして「〜だけ」と書く (T-32)。実装に無い機能 (代わりに記録・家族の買い物リスト) を書かない | 家族の共有設定と招待 (F-18・F-49・F-51)・組織の管理者の画面 (F-19) | §6 第 11〜12 条・§7 第9条 |
| R-15 | 版を上げる (両文書とも)。上げると何が起きるか (Web・API・モバイル・通知) を設計に書く | #1174・13a・13b・`src/lib/push/outbox.ts:245-256` | §9 |
| R-16 | 文面は型のあるデータ (TS) で持ち、ページはそれを描く。文面の存在と製品の定数との一致はテストで固定する | 完成条件 (Sonnet が迷わない)・§13 | §5・§8・§13 |
| R-17 | 既存のテスト (事業者名が 1 種類・AI の送信先の一覧・版の表示・h1・戻るリンク・公開ページの禁止語・未完成の語) を壊さない。文面に「株式会社」「Inc」「最適な」「24時間以内」などの禁止語を書かない | `tests/business-info-legal-pages.test.ts`・`tests/policy-pages-public.test.tsx`・`tests/public-claims-guard.test.ts`・#1911 の `tests/no-pending-wording-1911.test.ts` | §16 |
| R-18 | 効果・治療・予防をうたわない (薬機法 66・68 条・景品表示法・健康増進法 65 条) | §3 | §6 第 9 条・§7 全体 |
| R-19 | 旧版の文面を `docs/legal/archive/` に残す | cross/08 §7.2・§19 | §14 段 B |
| R-20 | 仮名加工情報・匿名加工情報の作成の有無を言い切る (作成していない) | 法 2 条 5 項・6 項・41〜46 条・Issue #1901 の法令の項目 | §7 第4条末尾 |
| R-21 | 端末の機能 (カメラ・写真ライブラリ・通知) へのアクセスと使い道、取得しないもの (位置情報・連絡先・マイクの音声) を公表する | `apps/mobile/app.json:23-25, 34-41`・`apps/mobile/package.json:30` (F-25) | §7 第3条 |
| R-22 | AI 事業者へ送る情報は、同意画面の 6 項目の写しで済ませず、実際にプロンプトに入る種類 (プロフィール・持病・服薬・妊娠/授乳の状況などの要配慮個人情報・ニックネーム) まで書く。送らないと言い切れないもの (氏名・メールアドレス) は言い切らない | 法 28 条 2 項・20 条 2 項・F-29 | §7 第5条・第6条 |
| R-23 | 誰が何を見られるか (写真・つないだ未成年の記録・運営) は、実装の経路 (RLS・署名 API・RPC) どおりに書く | cross/19 §6.1・cross/14 §11・F-18・F-33 | §6 第 5・13 条・§7 第5条・第9条・第15条 |
| R-24 | 退会・書き出しの約束は、版を上げた後の同意の前 (設定画面が同意画面へ回る間) に実際に使える手段だけを書く (v1.14: 同意の前でも本人が `/legal-consent/account` で退会と書き出しを行える。P-12。運営が代わりに削除する経路は無いので、お問い合わせによる削除は約束しない)。代表者・オーナーは譲渡するか解散するまで退会できないことを書く (F-59) | F-32・F-39・F-40・F-59・P-12・§11.3 | §6 第 5・11・12・17・24 条・§7 第13条 |
| R-25 | IP アドレス・User-Agent を持つ表は、すべて第3条に載せるか、載せない理由 (利用者の情報でない・書き込む処理が無い) を持つ。表が増えたらテストが赤になる | F-17・F-37 | §7 第3条・第12条・T-30 |
| R-26 | 本文の事実の主張を全部列挙し、1 文ごとに根拠を持たせる。表に無い主張を本文に残さない (文を足す・変えると機械の検査が赤になる) | 範囲の正本 (Issue #1901) の「製品の実際の動きを漏れなく」と P-2 | §10・T-35 |
| R-27 | 取得する情報 (第3条) は、利用者に紐づく表の全体 (書き出しの一覧と書き出さない一覧) から閉じる。各表を第3条の行に対応させるか、載せない理由 (書き込む処理が無い・運営担当者だけの情報・有料の条文と一緒に #1912 が載せる) を持つ。AI 事業者へ送る情報 (第6条) も、AI 相談が読む表を第6条の項目に対応させて閉じる | F-42・F-43・F-57 | §7 第3条・第6条・T-34・T-36 |
| R-28 | 本文に製品の操作の細部 (メニューや画面の名前の引用・「設定の〜から」の道順・機能の一覧・役割ごとの細かい見え方) を書かない。操作は本サービスの画面・使い方ガイド・お問い合わせへの案内で足りる。画面の名前の引用の形が本文に入ったら T-40 が赤になる (v1.11 の「画面の名前を実装の名前のまま書いて突き合わせる」形は廃止した) | P-11 | §6・§7 の規則・T-40 |
| R-29 | 写真・メールアドレス・解散した家族グループのように、保存する / しない・見える / 見えないが場合で分かれるものは、分かれ目を種類の水準で実装どおりに書き、分かれ目のコードを機械で突き合わせる | F-51〜F-54 | §6 第13条・§7 第5条・第9条・第12条・T-32・T-39・T-41・T-42 |
| R-30 | 有料プランの条文 (価格・自動更新・解約・返金・App Store / Google Play での購入・決済の事業者への送信) は、#1912 (billing/03 §11) が足した節 (利用規約第10条・第11条 1 項・第16条 2 項・第17条・第24条、プライバシーポリシー第3条・第4条・第7条・第10条・第12条) にだけ書く。価格と回数の数字は本文に書かず、料金のページと特定商取引法に基づく表記に掲げると書く (v1.17) | P-9・F-57 | §6 第10条・第16条・第17条・§7 第3条・第4条・第7条・第10条・第12条・T-33・§17 |
| R-31 | 事業者の名前・所在地・代表者・連絡先・営業時間は `src/lib/business-info.ts` の定数から読み、電話番号だけを「請求があれば遅滞なく開示します」とする。窓口のメールアドレスは事業者のメールアドレス | P-10・F-56 | §7 第1条・第17条・§6 第28条・§8.1・§8.3・T-16 |
| R-32 | 本文に未完成や予定を示す書き方 (「準備中」「販売開始前」「まだ〜していません」「今後〜する予定」「決まり次第」「〜する機能はありません」など) をしない | P-9 | §6・§7 の規則・T-6 |

### 0.3 ユーザーシナリオ (22 本。トレースは §4.3)

| # | シナリオ |
|---|---|
| S-1 | 未ログインの人が LP のフッターから `/terms` を開き、版・施行日のあとに章と条が並ぶ全文を読む。見出しは「利用規約」1 つ、戻るリンクはトップ |
| S-2 | ストア審査の担当者が `/privacy` を開き、集めるデータ・AI 事業者・委託先・保存期間・削除の方法・問い合わせ先を読む |
| S-3 | 版を上げてデプロイした直後、同意済み (v2025.1) の Web の利用者がホームを開く。middleware が `/legal-consent?next=/` へ回し、「改定されました」の導入文と、両文書に「改定あり」の印が出る。全文のリンクで新しい文面を読み、2 つのチェックで「同意して続ける」を押すと、`user_profiles` の 2 列が新しい版になり元の画面へ戻る |
| S-4 | 同じ利用者がアプリ (Expo) を開く。`GET /api/legal/status` が未同意を返し、ルートのゲートがアプリを `/legal-consent` の WebView 1 枚にする。同意すると `legal-consent-accepted` の合図で入口から振り分け直す |
| S-5 | 新しい版に同意していない利用者のアプリが `/api/meals` を呼ぶ。middleware が 403 `LEGAL_CONSENT_REQUIRED` を返し、画面は同意画面へ案内する。退会・書き出し・開示等の請求・お問い合わせの API は通る。設定画面 (`/settings`) は同意画面へ回るが、同意画面の下の `/legal-consent/account` で、同意しないまま退会と書き出しを行える (v1.14。利用規約第17条 1 項・第24条 2 項とプライバシーポリシー第13条 4 項。F-32・P-12・S-17) |
| S-6 | 同意画面で「同意しない（ログアウトする）」を押す。ログアウトし、開示・訂正・利用停止・消去の請求 (`/settings/data-requests`) とお問い合わせへのリンクが出る。再ログインすると同意画面に戻る |
| S-7 | 版を上げた後、プッシュ通知の cron が未同意の利用者の行を送らずに `consent_outdated` (`PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED`) で止める。再同意すると次回から届く |
| S-8 | 新規登録の人がサインアップ画面で規約・プライバシーポリシーのリンクを開き、新しい全文を読んでから登録する。登録後 `/auth/callback` が同意画面へ回し、生年月日を入れて同意する |
| S-9 | AI 機能を初めて使う人が、プライバシーポリシー第6条の事業者の一覧 (同意画面と同じ 5 社) と、同意画面の一覧が同じであることを確かめる |
| S-10 | 健康診断の結果を写真から読み取って登録した人が、プライバシーポリシー第5条で「健康診断の結果は要配慮個人情報に当たり、本人の操作による登録をもって同意を得る」「健康の記録は家族にも組織にも表示されない」「結果の写真は数値の読み取りに使うだけで保存しない」を読む |
| S-11 | 開示の請求をしたい人が、プライバシーポリシー第14条の手順 (請求の画面 → 登録のメールアドレスへの本人確認のリンク → 本人確認から 30 日以内を目安に対応) を読み、第14条のリンクから `/settings/data-requests` を開いて請求する。凍結中・退会後の人は `/contact` から |
| S-12 | 退会したい人が、利用規約第17条で「即時削除・取り消せない・削除の前に書き出せる」を、プライバシーポリシー第12条で退会後も残るもの (公開の状態のユーザーコンテンツは匿名で・お問い合わせの記録・保護者として署名した同意の記録・バックアップなど) を読み、本サービスの画面から退会する |
| S-13 | 凍結された人が `/frozen` を見て、利用規約第16条 2 項で「凍結中もデータの書き出し・退会・お問い合わせができる」ことを確かめる |
| S-14 | 保護者 (家族の代表者) が 13 歳以上 18 歳未満の子を家族に追加し、保護者の同意書に同意して署名し、子のメールアドレスへ案内を送る。子は案内のメールから登録して承諾する。子は利用規約第5条で、保護者の同意のもとでアカウントが保護者の家族グループにつながっている間だけ使えること、自分の記録が保護者に見えるかは自分の共有の設定によること、つながりが無くなると退会とデータの書き出しの道だけが出ることを知る |
| S-15 | 実装者 (Sonnet) が §6・§7 の TS ブロックを `src/lib/legal/` に置き、§8 の描画部品でページを描き、§13 のテストを足し、§9 の版を書き換える。手を止める箇所が無い |
| S-16 | 誤字の修正のように内容が変わらない直しをする人が、§9.3 の規律 (版を上げない) を読み、版を据え置いて文面だけ直す |
| S-17 | 版上げの後、新しい版に同意したくない成人 (凍結されていない) が、利用規約第24条 2 項と第17条 1 項を読み、同意の前でもできること (開示等の請求・お問い合わせ・退会とデータの書き出し) を知る。同意画面のフォームの下の案内から `/legal-consent/account` を開き、データを書き出してから退会する。先に「同意しない（ログアウトする）」を選んだ人には、もう一度ログインすれば同意しなくても退会と書き出しの画面へ進めることと、請求の画面・お問い合わせへのリンクが出る (P-12) |
| S-18 | ほかに 18 歳以上の大人のメンバーがいない家族の代表者が退会しようとする。退会は 409 (`ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE`) で止まり、メンバーシップ設定 (譲渡か解散) へ案内される。譲渡できる相手がいなければ、家族グループを解散してから退会する (F-59。利用規約第11条 4 項・第17条 2 項) |
| S-19 | 本人のアカウントをつないだ 15 歳のメンバーが、プライバシーポリシー第9条で、家族グループの中で表示名・役割・共有の設定がメンバーに閲覧できる状態になること、自分の食事の記録と献立の料理の名前は自分の共有の設定に従って表示されること、招待の宛先のメールアドレスと保護者の同意の記録が家族グループのメンバーの閲覧できる状態にあることを読む (F-38・F-49) |
| S-20 | AI 相談を使う人が、プライバシーポリシー第3条で相談の文章と回答・要約を取得すること、第6条で相談のたびにプロフィール・健康の記録・食事と献立の記録・冷蔵庫の食材などが AI 事業者へ送られること、第12条で退会まで保存されることを読む (F-43) |
| S-21 | 事業者の情報を確かめたい人が、プライバシーポリシー第1条で、事業者の名称・所在地・代表者・メールアドレス・営業時間と、電話番号は請求があれば遅滞なく開示することを読む。値は特定商取引法に基づく表記 (`/legal`) と運営会社 (`/company`) と同じ定数から出る (F-56) |
| S-22 | 有料プランの販売を始める案件 (#1912) の実装者が、本書 §17 の #1912 の行と §9.3 の規律を読み、利用規約第10条に有料の条文の項を足し、プライバシーポリシーの取得する情報・利用目的・委託先・外部送信・保存期間に決済の行を足し、T-33 と主張の表を直して、両文書の版を上げる。本書の版の本文には有料の条文が無いので、差し替えではなく追記になる |

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
| 文脈 (`LegalTextContext`) | 文面の中で製品の定数から埋める値 (事業者の名前・所在地・代表者・電話番号の欄の文・メールアドレス・営業時間・AI 事業者の一覧)。ページが `src/lib/business-info.ts` の定数から組み立てて文面モジュールに渡す |
| 版 | `LEGAL_DOCUMENTS[type].version`。同意の記録と比べる文字列。`v2026.1` に上げる (§9) |
| 施行日 | `LEGAL_DOCUMENTS[type].effectiveDate`。画面に出すだけの値。再同意はデプロイの時点から始まる |
| 再同意 | 版の食い違いで同意ゲートが同意画面へ回すこと (#1174・13a・13b) |
| 要配慮個人情報 | 個人情報保護法 2 条 3 項。本サービスでは健康診断・血液検査の結果、病歴・服薬・妊娠の有無など (§7 第5条) |
| 種類の水準 | 取得する情報・送り先・保存期間を、表の名前や画面の項目ではなく、利用者に分かる情報の種類で書くこと (例:「食事の写真と、そこから推定した料理と栄養の値」)。漏れは表と実コードの機械の突き合わせで閉じる (§7 の規則) |

### 0.6 決まっていない値と、書かない値

| 値 | いまの扱い | 文面での書き方 |
|---|---|---|
| 電話番号 | 載せない (P-10) | 「請求があれば遅滞なく開示します」(`PHONE_DISCLOSED_ON_REQUEST`) に請求の窓口の文を続ける (§7 第1条)。架空の番号は書かない |
| 管轄裁判所の名称 | 本店所在地は `BUSINESS_ADDRESS` (東京都港区。F-56) | 「当社の本店所在地を管轄する裁判所」(現行どおり。裁判所の名前は書かない。§18 Q-7) |
| AI 事業者の正式名称・所在地・保存期間・学習利用の有無 | `consent-config.ts:23-31` の弁護士への宿題 | 画面に出す呼び名と国だけ (同意画面と同じ)。保存は「事業者ごとに異なり、各事業者の規約に従う」 |
| 施行日 (`effectiveDate`) | 公開 (デプロイ) 日に合わせる | 公開日 `'2026-10-19'` (#1918 2ba5b3b3 で公開)。実装の間は仮の施行日と行末の目印のコメントで置き、マージの直前に公開日に確定して目印を消した (§9.1・§9.4 の 3) |
| 認定個人情報保護団体への加入の有無 | 未確認 | 書かない (§18) |
| 本番の Supabase のリージョン | ap-northeast-1 (東京)。2026-10-19 に読み取りで確認 (Q-11) | 「主に日本国内のデータセンター」とは書かず、委託先の所在国 (事業者の本拠) だけを書く (§7 第7条) |
| 個人情報の取扱いの責任者 | 公開の画面に記載が無い (現行 `/privacy` の窓口の見出しは「個人情報担当」だけ) | 書かない (窓口は「個人情報担当」のまま。Q-20) |
| 人的な安全管理措置 (従業者の教育・守秘) | 製品の挙動に当たらず、根拠が無い | 書かない。決まったら第11条に足して版を上げる (Q-20) |
| 有料プランの価格と条件 | 販売の案件 (#1912) が決めた (価格の正本は DB。billing/03 §8.9) | 数字は書かない。第10条 2 項に「料金のページと特定商取引法に基づく表記に掲げます」と書く (billing/03 §11.1。§17 の #1912 の行) |

### 0.7 読み方

- §1〜§3 が外形 (目的・現行の事実・法令)。§4 構想とトレース → §5 構造裁定 → §6〜§17 が仕上げ。実装者は §6〜§17 だけ読めば手を止めない。
- 正典の TS は §6・§7・§8・§9・§10.3・§13.1 の ```ts ブロック。§8.1 (型と定数)・§9.1 (版)・§10.3 (主張の表)・§13.1 の 1 つ目 (テストの定数) は単独で型検査を通る。§6・§7・§8.2・§8.3・§8.4・§13.1 の 2 つ目 (単位の作り方) は新設モジュール同士の import を持つので、1 行目を `// tsc:skip` にし 2 行目に `// place=<パス>` を書く。実装者はその置き場所に置いてリポジトリ全体で `tsc` に掛ける。
- 既存の設計書との食い違いは本冊が正。追随の行は §17。

章構成テンプレート (`docs/design/CLAUDE.md` の「章構成テンプレート」§1〜§9) との対応。本書は A 型設計ゲートの 4 相 (外形固定 → 構想 → 構造裁定 → 仕上げ) の順に章を並べたので番号がずれる。テンプレートの各章の中身は次の場所にある。

| テンプレートの章 | 本書の場所 | 備考 |
|---|---|---|
| 1. 目的・スコープ | §1 | 対象外も §1 |
| 2. 関連要件 | §2 (関連する設計と現行の事実)・§0.2 (要件行列)・§3 (法令) | |
| 3. データモデル | **該当なし** | DB の変更は無い (テーブル・列・RLS・Storage・migration を足さない・変えない。§15 の最後の行)。文面が参照する既存のテーブルは §2.2 と §10 に挙げ、利用者に紐づく表の全体とプライバシーポリシー第3条の行の対応は T-34 が固定する |
| 4. API 仕様 | **該当なし** | 新しい API・route・エラーコードは無い (§15・§12)。版を上げたときに動く既存の API (`/api/legal/status`・`/api/legal/accept`・同意の許可リスト) は §4.2・§9.2 で参照だけする |
| 5. シーケンス | §4.2 (版を上げてデプロイした後の動きの図)・§4.3 (シナリオのトレース)・§9.2・§9.4 (公開の手順) | 図は Mermaid ではなくテキストの木で書いた (分岐が 1 段で、文字の図で読めるため) |
| 6. エラーハンドリング | §12 | 既存のエラーだけ (足さない) |
| 7. テスト方針 | §13 (テスト一覧)・§14 (段分けと変異試験)・§16 (既存の番兵の追随) | |
| 8. 既存実装との関連 (保持・削除・新規) | §2.2 (現行の事実)・§11.2 (状態比較表: 現行 vs 設計後)・§15 (新設一覧と既存ファイルの変更)・§16・§17 | 削除するファイルは無い (2 ページは同じパスで中身を差し替える) |
| 9. 未解決事項 | §18 | |

---

## 1. 目的・スコープ

- `/terms` (利用規約) と `/privacy` (プライバシーポリシー) の本文を、製品の実際の動きと法令に合わせて作り込み、版を上げて既存の再同意の仕組みで利用者に同意し直してもらう。
- 本文は法令が求める事項と権利義務の約束だけにし、製品の操作の細部・未完成や予定の書き方・有料の条文を書かない (P-9〜P-11)。
- 対象外: 同意の仕組みそのもの (13a・13b・14。v1.14 で同意の前の退会と書き出しの画面だけを足す。P-12)・AI の同意の文面 (`AI_CONSENT_COPY`) と版・特商法の表記・Cookie 同意バナーの実装 (使っていないので不要。§7 §10)・30 日前のメール通知 (cross/08 §7.2 で未実装のまま)・運営による代理削除 (cross/08 §16.5)・有料プランの条文 (価格・自動更新・解約・返金・ストアでの購入・決済の事業者。P-9。#1912 が足す)・事業者の情報の値そのもの (#1911 が `src/lib/business-info.ts` に入れる。本書は読むだけ)。

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
| billing/01-billing-core.md | 課金の仕組み (Checkout・期間末の解約・退会時の即時解約と顧客の匿名化)。本書の本文は有料の条文を書かない (P-9。§0 の「アプリ内課金なし」はオーナーの選択と食い違うので #1912 が直す。§17) |
| Issue #1911 (#1916 4b1e1abe でマージ済み・2026-10-19) | 事業者の情報の定数 (`BUSINESS_ADDRESS`・`BUSINESS_EMAIL`・`BUSINESS_HOURS`・`PHONE_DISCLOSED_ON_REQUEST`。F-56)・未完成の語の検査 (`tests/no-pending-wording-1911.test.ts`) |
| Issue #1912 | 有料プランの販売 (有料の条文を足す側。§17 の #1912 の行) |
| org/07・org/10・org/03 | チャレンジは任意・順位は参加者どうし・管理者は集計のみ |
| family/01・08 | 共有設定 (`share_meals` / `share_health` / `share_menu`)・家族の食事の閲覧 |
| docs/design/CLAUDE.md・cross/CLAUDE.md | 章構成・日本語・RLS・監査ログ |

### 2.2 現行の事実 (origin/main `5b85bb3f`、2026-10-19。F-56〜F-58 は origin/main `a199f14a` と #1911 の枝で確かめた。F-3・F-4・F-56 は #1911 (#1916)・#1901 (#1918) のマージの後の origin/main `2ba5b3b3` に合わせて直した)

| # | 事実 | 出どころ |
|---|---|---|
| F-1 | `/terms` は第 1〜9 条 (適用・利用登録・ID 管理・AI 解析・禁止事項 5 項・提供停止・免責・変更・準拠法)。料金・凍結・退会・家族・組織・未成年・知的財産・再同意・医療免責・問い合わせ先が無い | `src/app/terms/page.tsx:30-66` |
| F-2 | `/privacy` は第 1〜7 条。保存期間・委託先・安全管理措置・外国の制度の情報・要配慮の同意・請求の手続・退会後の扱いが無い。AI 事業者の一覧は `AI_CONSENT_PROVIDERS` から出す (`data-testid="privacy-ai-providers"`) | `src/app/privacy/page.tsx:34-78, 56-68` |
| F-3 | 版・施行日はページの `<main>` の先頭に `LegalDocumentMeta` で出す。本書の時点は両文書とも `v2025.1` / `2025-01-01` の仮置きで、#1918 (2026-10-19) で `v2026.1` / `2026-10-19` に上げた | `src/components/legal/LegalDocumentMeta.tsx`・`packages/shared/src/legal-versions.ts:40-49` |
| F-4 | 事業者名 `BUSINESS_NAME` (`株式会社MHD医健`)・代表者 `BUSINESS_REPRESENTATIVE`・電話番号の欄の文 `PHONE_DISCLOSED_ON_REQUEST` (#1911 で `DISCLOSED_ON_REQUEST` から置き換わった。F-56)・問い合わせ先 `getSupportEmail()` | `src/lib/business-info.ts:17-41`・`src/lib/site-config.ts:148-156` |
| F-5 | 同意ゲート: 画面は middleware が `/legal-consent` へ、`/api` は 403 `LEGAL_CONSENT_REQUIRED` (許可リストあり)、モバイルは WebView 1 枚。本番は強制 on | cross/08 §7.2・`packages/shared/src/legal-consent-api.ts:88-110` |
| F-6 | 同意画面: 改定時の導入文 `introReconsent`・「改定あり」の印・「同意しない（ログアウトする）」・請求画面へのリンク | `packages/shared/src/legal-consent-copy.ts:8-28`・`src/app/legal-consent/LegalConsentForm.tsx:338-395, 456` |
| F-7 | プッシュ通知の送信側は、同意の強制が on のとき、同意済みの版が古い利用者へ送らない (`consent_outdated`)。判定は版だけで、保護者の同意とのつながりは見ない。凍結は版より先に `account_frozen` で止める | `src/lib/push/outbox.ts:53-54, 245-259` |
| F-8 | AI 事業者 5 社 (xAI・Google・OpenAI・Perplexity = アメリカ合衆国、AI/ML API = エストニア)。未同意なら送る手前で 403 `AI_CONSENT_REQUIRED`。同意は `external_data_consents` に版・IP・User-Agent つきで記録。撤回は `/settings/ai-consent` | `src/lib/ai/consent-config.ts:12-14, 85-116`・`supabase/functions/_shared/ai-consent.ts:21-56`・`src/app/api/ai/consent/route.ts:113-114` |
| F-9 | AI の 1 日の上限: `ai_daily_limits` (free = 3 回。migration `20261021100000_billing_paid_plans_iap.sql` の (5b)。運営画面で変えられる)・翌日 0 時 JST に戻る・究極モードの機能別上限・自動処理の安全弁 | `supabase/migrations/20261011020000_ai_daily_limits.sql:80-81`・`supabase/functions/_shared/ai-daily-limit.ts:38-66` |
| F-10 | 未成年: 18 歳未満は本人登録不可、13 歳未満の本人アカウント無し、保護者の同意書 `/legal/parental-consent`、つながりが切れたら退会のみ (v1.14 から退会とデータの書き出し。案内の画面から `/legal-consent/account` へ進める。P-12) | `packages/shared/src/parental-consent.ts:12-18, 118-140` |
| F-11 | 退会は即時削除 (取り消し不可)。公開レシピは匿名化して残す。Stripe は即時解約・顧客の匿名化。削除の記録は id の HMAC。バックアップは daily 30 日・weekly 366 日・annual 2,557 日 | cross/08 §16.1-16.4・cross/17 §9.1 (行 159-161) |
| F-12 | 書き出し `GET /api/account/export` は 52 表を JSON で返す。凍結中も退会・書き出し・有料プランの解約 3 本・お問い合わせの送信は通る | `src/lib/account-export-tables.ts`・`src/lib/auth/frozen.ts:34-42`・cross/08 §16.2 |
| F-13 | 開示等の請求: 種類は開示・訂正・利用停止・消去。本人確認は登録メールのリンク (24 時間・送信は 5 回まで)。応答期限は本人確認から 30 日 (既定。環境変数 `DSR_RESPONSE_DUE_DAYS`)。凍結中は `/contact` | `src/lib/data-subject-requests/core.ts:8-9, 36-44`・cross/15 §12・S-13 |
| F-14 | 隠した投稿は 90 日で消す (`HIDDEN_CONTENT_RETENTION_DAYS`)。ログ (`app_logs`) 30 日。ログイン履歴 90 日・セッション無操作 30 日。送信待ち (メール・プッシュ) は送れた行 7 日・失敗 30 日 | `src/lib/admin/hidden-content-restore.ts:26`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:1120`・`src/lib/auth/sessions/constants.ts:12, 16`・`supabase/migrations/20261016234000_email_outbox.sql:271-272`・`20261016237000_push_outbox.sql:258-259` |
| F-15 | 外部送信: ブラウザから直接 Supabase (`*.supabase.co`。認証・データの読み書き・写真の署名付き URL)・Vercel Speed Insights (同一オリジン `/_vercel/speed-insights/*`。URL のクエリ・トークンを消してから送る)・Cloudflare Turnstile (ログイン・登録・メール確認・パスワード再設定)・Stripe Checkout・Google OAuth・祝日の一覧 (週間献立 `/menus/weekly` がブラウザから `HOLIDAYS_API_ORIGIN` = `https://holidays-jp.github.io` の `/api/v1/<年>/date.json` を取得。送るのは年だけ。GitHub Pages に端末の IP とブラウザの情報が渡る)。PostHog・GA は不採用。フォントは `next/font` でビルド時に取り込む (実行時に Google へ送らない)。ログイン画面の背景の画像 (`images.unsplash.com`) は `next/image` の最適化 (`/_next/image`) を通り、ブラウザは Unsplash へ直接取りに行かない。アプリの更新の取得 (EAS Update) は無効 (`updates.enabled: false`・`checkAutomatically: "NEVER"`。`expo-updates` を呼ぶコードも無い) | `src/lib/speed-insights-scrub.ts:1-20`・`src/lib/auth/turnstile-verify.ts:22`・`src/app/layout.tsx:2`・`src/__tests__/lib/security/csp.test.ts:264-272`・`src/lib/security/csp.ts:30-34, 103`・`src/app/(main)/menus/weekly/_state/japaneseHolidays.ts:7-8`・`src/app/(main)/menus/weekly/page.tsx:427`・`src/app/(auth)/layout.tsx:15`・`next.config.mjs:95-103`・`apps/mobile/app.json:68-72` |
| F-16 | 委託先: Supabase (認証・DB・Storage・Edge Functions)・Vercel (ホスティング)・Resend (メール)・Stripe (決済)・Upstash (Redis。回数制限のカウンタ。キーは利用者 ID / IP / 宛先のハッシュ)・Expo (プッシュ送信 `exp.host`)・Cloudflare (Turnstile・R2 のバックアップ)・GitHub (Actions がバックアップを実行)・Google (OAuth) | `src/lib/rate-limit.ts:17-31`・`src/lib/push/expo-transport.ts:14-15`・`src/lib/emails/outbox.ts`・`.github/workflows/db-backup.yml`・`src/app/(auth)/login/page.tsx:78-83` |
| F-17 | 端末とログ (IP・User-Agent を持つ表の全体は F-37): `user_sessions_metadata` に IP の全体 (`ip_address`。トリガー `auth_session_created` は `NEW.ip` をそのまま入れ、Web の route も受け取った IP をそのまま上書きする)・そのネットワーク (`ip_network`。IPv4 は /24、IPv6 は /48。`ip_address` とは別の列)・国 (`country_code`。Web のログインで Vercel のヘッダ `x-vercel-ip-country` から取る)・User-Agent・端末名。IP の全体と国は、本人の画面 (`/settings/security/sessions` のセッションとログイン履歴)・新しい端末の通知メール・運営の画面 (`/admin/users/[id]` のログイン履歴) に出る。CSP 違反の報告に User-Agent。お問い合わせは `x-forwarded-for` を回数制限のキーに使う。規約・ポリシーの同意の記録 (`terms_acceptances`) には、版と日時に加えて、サーバーが受け取った通信の IP (`extractClientIp`) と User-Agent (512 文字まで) を残す (`POST /api/legal/accept` が `p_ip`・`p_user_agent` で `accept_legal_documents` に渡し、関数が `terms_acceptances` の `ip_address`・`user_agent` に入れる)。`route.ts:19` の「IP・user_agent は残さない」は成功時のログの話で、記録の話ではない。`terms_acceptances` は退会で `ON DELETE CASCADE` により消える | `supabase/migrations/20261016243000_auth_history_sessions.sql:19-40, 56, 79-84`・`src/lib/auth/sessions/request-context.ts:3-15`・`src/lib/auth/sessions/web-login-context.ts:42`・`src/lib/auth/sessions/store.ts:141-144`・`src/app/(main)/settings/security/sessions/page.tsx:106-107, 146-147`・`src/lib/emails/account/login-new-device.ts:27-37`・`src/app/api/admin/users/[id]/login-history/route.ts:45-46`・`src/app/admin/users/[id]/page.tsx:142`・`src/app/api/csp-report/route.ts:11, 43`・`src/app/api/legal/accept/route.ts:19, 116-125`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:513-514`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:9408` (`terms_acceptances_user_id_fkey` の `ON DELETE CASCADE`) |
| F-18 | 家族: `family_members.share_meals` (既定 true)・`share_health` (既定 false)・`share_menu` (既定 true)。食事の閲覧は `can_view_user_meals` の RLS (`share_meals = TRUE` を見る)、献立は #1584 の関数 (`share_menu = TRUE` を見る)。健康の記録 (`health_records`・`health_checkups`・`blood_test_results`) の SELECT の RLS は本人だけで、`share_health` を読む RLS・関数・API は無い (設定の画面で切り替えられるだけ。家族に健康の記録を見せる経路は無い) | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:124-126, 951, 10008, 10016, 10038, 10568`・`20261016241000_family_menu_view_functions.sql:42` |
| F-19 | 組織: 組織の管理者の画面が読むのは次だけ。(1) メンバーの表示名・組織内の役割・参加日 (`/org/members` が `user_profiles` を `select('id, nickname, org_role, joined_org_at')`。ただし `user_profiles` の SELECT の RLS は本人の行だけなので、いまは他のメンバーの行は返らない)。(2) 招待 (招待先のメールアドレス・役割・部署・承諾の有無・期限。RLS `org_invites_select_admin`)。(3) 部署の名前と部署ごとの人数 (人数は service_role で数えて数だけ返す)。(4) 組織のメンバー数 (`GET /api/org/stats`。活力スコアなどの組織の集計と部署別の表示は止めている)。(5) チャレンジの参加人数と平均 (参加者が `ORG_CHALLENGE_MIN_PARTICIPANTS` 人に満たないときは出さない。個人の値は返らない)。社員番号の列はどこにも無い (`supabase/migrations`・`src`・`packages/shared/src/database.types.ts` で `employee_id`・`employee_number` が 0 件)。最終ログイン・ライセンスの状態は組織の画面に出ない (最終ログインを出すのは運営の画面 `admin/users/[id]`・`support/users` だけ)。登録したメールアドレスは、招待を受けて参加したメンバーについてだけ、承諾済みの招待の宛先 (参加の時点の登録のアドレス) として (2) の招待の一覧に出る (F-51)。`GET /api/org/members` は画面から呼ばれておらず、同じ RLS で本人の行しか返らない。組織への参加 (`accept_org_invite`) は組織ごとの人数の枠 (`org_license_pools.used_licenses`) を 1 つ使い、部署は招待の行にだけ持つ (`user_profiles.department_id` を書く処理は無い)。チャレンジは任意・順位は参加者どうし・名前の表示は環境変数 `ORG_CHALLENGE_SHOW_NAMES` で既定 off | `src/app/(org)/org/members/page.tsx:52`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:10076` (`Users can view own profile`)・`src/app/api/org/invites/route.ts:39-50`・同 migration `:10644` (`org_invites_select_admin`)・`src/app/api/org/departments/route.ts:78-90`・`src/app/api/org/stats/route.ts:29`・`src/app/(org)/org/dashboard/page.tsx:5-6, 64`・`src/app/api/org/challenges/route.ts:89-118`・`src/app/api/org/members/route.ts:22-23`・`supabase/migrations/20261022100000_org_invite_dissolved.sql` (`accept_org_invite` の最新の定義。`used_licenses` を 1 足す)・`src/lib/org-challenges.ts:115-128` |
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
| F-30 | 保護者の同意の記録 (`parental_consents`) は、署名した氏名・保護者であることの確認・署名時点の子どもの生年月日と年齢・日時・IP アドレス・User-Agent を持つ。署名した保護者が退会しても `parent_user_id` が `ON DELETE SET NULL` で外れるだけで行は残る。家族グループの行が消えると `ON DELETE CASCADE` で消えるが、家族グループを消す処理 (解散から 90 日の物理削除のジョブ。F-53) は同意の記録を持つグループを候補から外すので、同意の記録は期限なく残る。宛先停止リスト (`email_blacklist`) は、苦情・バウンスのあったアドレスへ再送しないために、退会でも伏せない (生のアドレスが残る) | `supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:90-102`・cross/08 §16.3 (送信ログの行) |
| F-31 | 運営は `/admin/announcements` でお知らせを書け、公開 (`is_public`) のお知らせは Web とアプリのホームに出る (`GET /api/announcements?mode=public`)。`/news` の一覧はコードの中の空の配列で、運営画面からは載らない | `src/app/admin/announcements/page.tsx`・`src/app/api/announcements/route.ts:27-49`・`src/hooks/useHomeData.ts:307-311`・`apps/mobile/src/hooks/useHomeData.ts:364-367`・`src/app/news/page.tsx` (`const news: readonly NewsItem[] = []`) |
| F-32 | 未同意の人が画面で開けるのは、同意ゲートの対象外のパス (認証・`/terms`・`/privacy`・`/legal-consent` とその下 (`/legal-consent/account`)・`/settings/data-requests`・`/legal`・`/contact`・`/frozen`・`/handson-tour`) だけ。設定 (`/settings`) と `/account/billing` (解約の画面) は同意画面へ回る。v1.13 の時点 (origin/main `5b85bb3f`) では、同意の前の人に退会と書き出しの画面が無く、同意画面で「同意しない」を選んだ後に出るのはお問い合わせからのデータの削除の依頼 (「ご本人であることを確認のうえ、アカウントと保存されているデータを削除します」。裏付けが無い。F-40) と請求の画面へのリンクだけだった。v1.14 (P-12 の Q-23) で、同意の前でも本人が退会と書き出しを行える画面 `/legal-consent/account` (`LEGAL_CONSENT_ACCOUNT_PATH`。凍結中の `/frozen/account` と共通の部品 `AccountSelfServicePanel`) を置き、同意画面のフォームの下・未成年の案内 (`minor_refused` / `guardian_missing`)・「同意しない」の後の案内 (ログインの後にこの画面へ戻る) から案内する。お問い合わせによる削除の約束は画面から外した。呼ぶ API (`/api/account/delete`・`/api/account/export`) は同意の許可リストにある。有料プランの解約を運営が行うコードの経路 (運営の API・画面) は無い (`src/app/api/admin`・`src/app/api/operator` に billing の解約の route が無い。運営による解約は決済代行事業者の管理画面で行う運用になる。Q-21)。凍結中の人は `/frozen` から `/frozen/account` (退会・書き出し) と `/frozen/billing` (解約) を開ける。凍結の判定は同意より先なので、凍結中の人が `/legal-consent/account` を開くと `/frozen` へ回る | `lib/legal-consent.ts` (`LEGAL_CONSENT_ACCOUNT_PATH`・`isLegalConsentExemptPath`)・`src/app/legal-consent/LegalConsentForm.tsx`・`src/app/legal-consent/account/page.tsx`・`src/components/account/AccountSelfServicePanel.tsx`・`packages/shared/src/legal-consent-api.ts` (`LEGAL_CONSENT_EXEMPT_API_PATHS`)・`src/app/frozen/page.tsx:9-10, 59-76` |
| F-33 | 写真 (食事・冷蔵庫) は家族にも組織にも経路が無い (家族の献立は `image_url` を返さない。署名 API は持ち主以外に null)。運営 (admin / super_admin / content_moderator) は審査 API の署名付き URL で閲覧できる。本人のアカウントが無い子どもの行 (`role = 'child'`・`user_id` が NULL) が持つのは表示名・生年月日 (`family_members.birth_date`)・`child_profile` (追加の画面が入れるのは性別だけ) と保護者の同意の記録で、食事・健康の記録を家族の誰かが代わりに付ける経路は無い (`meals.user_id` は NOT NULL で代理の列が無い。`family_meal_logs` は旧機能で未使用。`src/lib/membership/family-menu.ts:29` は「(子供) の献立は、アカウントを持つまで出ません」と出す)。本人のアカウントをつないだ 13〜17 歳は、つなぐときに `share_meals` / `share_health` / `share_menu` を自分で選ぶ | cross/19 §6.1 (行 283・286)・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:133`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:59-74`・`src/app/(main)/family/members/child/new/page.tsx:108-110`・`packages/shared/src/database.types.ts` (`meals` の `Row`)・`src/lib/account-export-tables.ts:334`・cross/14 §11 の表 (`accept_child_promotion(p_token, p_share_meals, p_share_health, p_share_menu)`) |
| F-34 | 通知とメール: 利用者が変えられる通知の設定 (`notification_preferences`) は `notifications_enabled`・`auto_analyze_enabled`・`data_share_enabled` の 3 つだけで、`notifications_enabled` を読むのはプッシュの送信だけ (切っているとどの種類のプッシュも `notifications_disabled` で送らない)。メールを止める設定は無い (`src`・`supabase/migrations`・`apps/mobile` に 0 件)。送るメールは、アカウント (退会の完了・新しい端末からのログイン)・開示等の請求・家族と組織の招待とお知らせ・お問い合わせへの返信と、認証 (Supabase Auth の確認・パスワードの再設定) で、宣伝のメールの仕組みは無い。メールの送信を止めるのは苦情とバウンスの停止リスト (`email_blacklist`) だけ。改定を知らせる一斉メールの仕組みも無い (cross/08 §7.2 の 30 日前のメール通知は未実装。§1 の対象外) | `src/app/api/notification-preferences/route.ts:17-21, 73`・`src/lib/push/outbox-store.ts:29, 72, 87`・`src/lib/push/outbox.ts:260`・`src/lib/emails/account/`・`src/lib/emails/dsr/`・`src/lib/emails/membership/`・`src/lib/emails/support/`・`src/lib/emails/suppression.ts` |
| F-35 | 運営の多要素認証: 必須にするロールは `MFA_REQUIRED_ROLES = ['super_admin', 'admin', 'finance', 'org_industrial_doctor']` だけで、`support`・`sales`・`content_moderator`・`org_admin` は対象外。写真を審査 API で見られる `content_moderator` (F-33) にも多要素認証は要らない。必須のロールでも、猶予の開始日時 (環境変数 `OPERATOR_MFA_ENFORCE_FROM`) を設定しているとその日時までは未登録で通る (`pass_grace`)。未設定なら猶予なし (即時)。本番の値は本書では確かめていない (環境変数の値を読まない。Q-25) | `src/lib/auth/mfa/policy.ts:12-18, 97-105, 140-149` |
| F-36 | お問い合わせとサポートの記録: 退会の直前の `prepare_account_deletion` は `inquiries` の `email` を `redacted@redacted.invalid` に置き換えるだけで、件名 (`subject`)・本文 (`message`)・運営のメモ (`inquiries.admin_notes`) は残す。`inquiries.user_id`・`support_tickets.user_id`・`support_ticket_messages.sender_id` は `ON DELETE SET NULL` で紐づけだけが外れ、チケットの件名とメッセージの本文 (運営の内部のメッセージ `support_ticket_messages.is_internal` を含む) は残る。開示等の請求の運営の内部メモ (`data_subject_requests.admin_notes`) も、`user_id` が `ON DELETE SET NULL` で外れるだけで残る。これらを期限で消す処理は無い。退会で直ちに消える運営のメモは、アカウントについてのメモ (`admin_user_notes`。`user_id` が `ON DELETE CASCADE`) だけ | `supabase/migrations/20261016234000_email_outbox.sql:468-472` (`prepare_account_deletion` の最新の定義の `inquiries` の段)・`20251126124224_create_meal_planner_tables.sql:5105-5119` (`inquiries` の列。`admin_notes` は `:5113`)・`:9023` (`inquiries_user_id_fkey`)・`:6474-6481` (`support_ticket_messages` の列)・`:8663` (`admin_user_notes_user_id_fkey` の `ON DELETE CASCADE`)・`20261010000100_auth_users_fk_on_delete.sql:186-194` (`support_tickets`・`support_ticket_messages` の `SET NULL`)・`20261016220000_data_subject_requests.sql:20, 37` (`user_id` の `SET NULL` と `admin_notes`) |
| F-37 | IP・User-Agent を持つ表 (`packages/shared/src/database.types.ts` の `public` の表のうち、`Row` に `ip_address`・`ip_network`・`user_agent`・`country_code` の列があるもの) は 8 つ: `user_sessions_metadata` (ログインの履歴。F-17)・`terms_acceptances` (規約・ポリシーの同意。F-17)・`external_data_consents` (AI の同意。F-8)・`parental_consents` (保護者の同意。F-30)・`admin_audit_logs` (運営の操作の記録。入るのは操作した運営担当者の IP で、利用者の IP ではない)・`cookie_consents` (書き込む処理が無い。Cookie の同意のバナーは未実装)・`failed_invite_lookups` (書き込む処理が無く常に空。掃除のジョブも置いていない)・`catalog_sources` (`country_code` は商品の情報の出どころの国で、個人の情報ではない)。プライバシーポリシー第3条に載せるのは前の 4 つ | `packages/shared/src/database.types.ts` (`terms_acceptances` は `:6974-6983`)・`src/lib/admin/audit.ts:20-39, 147-148`・`src/lib/account-export-tables.ts:243` (`cookie_consents` は書き出しの表に名前があるだけ)・`docs/design/operator/08-cron-batches.md:87, 157`・`tests/log-cleanup-dau-snapshot-contract.test.ts:213-214` (`failed_invite_lookups` に書き込む処理が無い)・`src`・`supabase` に `INSERT INTO … cookie_consents` / `failed_invite_lookups`・`.from('cookie_consents')` / `.from('failed_invite_lookups')` が 0 件 |
| F-38 | 家族の役割は `family_role_enum` の 3 つ (`representative` / `adult` / `child`) だけで、画面の呼び名は「代表」「大人」「子供」。「管理者」という家族の役割は無い。家族を作った人が代表者 (`create_family_group`)、招待を承諾した人は `adult` (`accept_family_invite`)、本人のアカウントをつないだ未成年者も `adult` になる (`accept_child_promotion`)。`representative` と `adult` は同じ条件 (`role IN ('representative','adult')`) で、招待 (`create_family_invite`)・子どもの追加 (`add_family_child`)・昇格の依頼と取り消し (`request_child_promotion` / `revoke_child_promotion`)・代表者以外のメンバーの除名 (`remove_family_member`。対象が代表者なら `IS_FAMILY_REPRESENTATIVE`)・家族の名前の変更 (`family_groups_update_adult`)・招待と昇格の依頼の閲覧 (`family_invites_select_adult`・`family_promotion_requests_select_family`) ができる。18 歳未満 (`caller_is_minor_jst`) は家族の作成・招待の承諾・代表者とオーナーの譲渡の承諾ができない。代表者は `leave_family` で抜けられない (`IS_FAMILY_REPRESENTATIVE`)。代表者の譲渡の申し出は代表者だけが行え、相手は子どもでない有効なメンバー (`CANNOT_TRANSFER_TO_CHILD`) | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:88-92, 3075, 10360, 10371, 10396`・`src/app/(main)/family/members/page.tsx:139-143`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:373, 555, 737, 809, 816-821, 856, 926, 958, 1036`・`supabase/migrations/20261008100000_membership_daily_send_cap.sql:271, 462-474`・`supabase/migrations/20261008090100_family_lock_order.sql:366-368, 391, 413` |
| F-39 | 利用者が家族グループ・組織を解散する画面と API は、v2026.1 の設計の時点では無かった。#1917 で作った (F-59)。退会の 409 (`findBlocker`) を抜けるのは譲渡と解散。運営の強制解散の画面は、代表者・オーナーが 30 日以上未ログイン (または削除済み) の一覧 (F-21) からだけ開ける。組織のオーナーの譲渡の申し出の相手は組織のメンバー (役割を問わない) で、承諾は 18 歳未満にはできない。オーナーの譲渡の画面は候補を `user_profiles` から読むが、その SELECT の RLS は本人の行だけ (F-19) なので、いまは候補が出ない (§17) | `src/lib/account-deletion.ts:248-285`・`src/lib/account-self-service.ts:107-114`・`src/app/(operator)/operator/membership/families/inactive/page.tsx:68-72`・`supabase/migrations/20261008100000_membership_daily_send_cap.sql:497-512`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:1036`・`src/app/(org)/org/settings/owner-transfer/page.tsx:50-55` |
| F-40 | 運営が本人に代わってアカウントを削除するコードの経路は無い: `deleteAccount` を呼ぶのは本人の退会の route だけで、`ACCOUNT_DELETION_REASON.operator` は型の定義だけ。cross/08 §16.5 と operator/09 §9.2 も「未実装」とし、運用の手順は「本人に設定画面から削除してもらう」。消去の請求の運営の対応も「本人の退会を案内」(operator/09 の消去の行・cross/15 §4.4)。版を上げた後の同意の前は `/settings` が同意画面へ回る (F-32) が、v1.14 から同意しない人も `/legal-consent/account` で自分で削除できる (P-12) | `src/app/api/account/delete/route.ts:43`・`src/lib/account-deletion.ts:61-69`・`docs/design/cross/08-legal-compliance.md:908-910`・`docs/design/operator/09-runbook.md:420-433, 494`・`docs/design/cross/15-data-subject-requests.md:328` |
| F-41 | 運営の操作の記録 (`admin_audit_logs`): 運営の API (`src/app/api/{admin,super-admin,support,operator}`) の変更の操作 (POST / PUT / PATCH / DELETE) は記録する (表に無い handler が増えると赤になる見張りがある。投稿の非表示と復元、凍結と解除を含む)。閲覧で記録するのは審査の 1 件の詳細の GET (`admin.moderation.view`) で、審査の一覧 (`GET /api/admin/moderation`・`/queue`) は写真の署名付き URL を返すが記録しない。記録は失敗しても閲覧を止めない。見張りの外にある運営ロールの変更 (`POST /api/announcements` のお知らせの作成・`POST /api/comparison/trigger` の比較の集計のやり直し) は記録しないが、どちらも利用者のデータを書き換える操作ではない (お知らせは運営の文、集計のやり直しは全利用者の指標を作り直す処理) | `tests/admin-mutation-audit-coverage-1571.test.ts:1-22, 50-52, 61-62`・`src/app/api/admin/moderation/[type]/[id]/route.ts:163-180`・`src/app/api/admin/moderation/route.ts`・`src/app/api/admin/moderation/queue/route.ts` (`recordAdminAudit` が 0 件) |
| F-42 | 利用者に紐づく表の一覧は、書き出す表 (`ACCOUNT_EXPORT_TABLES`) と書き出さない表 (`ACCOUNT_EXPORT_EXCLUDED`。理由つき) の 2 つで閉じている (`tests/account-export-tables.test.ts` が本番のスキーマと突き合わせる)。このうち、書き込む処理 (コードの `.insert(` / `.upsert(` と migration の `INSERT INTO`) が無い表は 15: `cookie_consents`・`csat_feedbacks`・`nps_surveys`・`ai_content_logs`・`recipe_requests`・`recipe_flags`・`moderation_flags`・`announcement_reads`・`email_delivery_logs`・`referral_rewards`・`buddies`・`buddy_actions`・`legacy_family_groups`・`legacy_family_members`・`family_meal_logs`。プライバシーポリシー第3条の表の行と各表の対応は T-34 が固定する | `src/lib/account-export-tables.ts:127, 284`・T-34 |
| F-43 | AI 相談は、回答を作るときに、プロフィール (F-29)・今日と今後 1 週間と過去 14 日の献立・過去 14 日の健康の記録 (体重・体脂肪率・血圧・睡眠・体調・気分・ストレス・歩数)・健康の目標・栄養の目標・獲得したバッジの名前と説明・健康に関するヒント・買い物リスト・冷蔵庫の食材 (名前・量・賞味期限)・レシピのコレクションの名前・過去の相談の要約・重要とした過去のやりとりを読み、AI 事業者へ送る文に入れる | `src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts:157-232` |
| F-44 | 毎日のコンディション: ホームの「今日のコンディション」(休息日・通常・活動的・ストレス) は `daily_activity_logs.feeling` に書く (同じ表の歩数・消費カロリーの列に書く処理は無い)。コンディションの記録 (`user_performance_checkins`: 睡眠の時間と質・疲れ・集中・空腹・気分・筋肉痛・運動の強さと時間・体重・体脂肪率・安静時の心拍数・メモ) はホームと `/api/performance/checkins` が書く。`/api/performance/analyze` は 7 日の平均から栄養の目標の見直しを本サービスの中で計算し (AI 事業者へは送らない)、適用すると `performance_plans` に残す | `src/hooks/useHomeData.ts:707, 757, 991-997`・`apps/mobile/src/hooks/useHomeData.ts:535`・`src/app/(main)/home/page.tsx:433-440`・`src/app/api/performance/checkins/route.ts`・`src/app/api/performance/analyze/route.ts:1-12` |
| F-45 | 記録の比較: 毎時の集計 (`calculate-segment-stats`) が、全利用者の指標を年齢層・性別などの区分ごとに集計し (区分の人数が 5 人に満たないときは作らない)、各利用者の順位を `user_segment_rankings` に残す。`/comparison` は本人の順位と区分の集計だけを読む (順位と指標の SELECT の RLS は本人だけ。区分の集計は数値だけで誰でも読める)。順位と改善からバッジが付く | `supabase/functions/calculate-segment-stats/index.ts:467-474, 565-569`・`src/app/api/comparison/rankings/route.ts:33-58`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:10846, 11016, 11032`・`src/lib/badges/awardable.ts:36` |
| F-46 | 保存期間の追加の事実: AI 事業者の呼び出しの記録 (`llm_usage_logs`。日時・機能・モデル・トークン数・費用。送った文は入れない) は利用者への外部キーが無く、掃除のジョブも無い (退会後も利用者の id とともに残る)。栄養の計算の確認の記録 (`meal_nutrition_debug_logs`) と AI が作った料理のデータ (`derived_recipes`) とアプリの動作のログ (`app_logs`) は退会で `SET NULL` (紐づけだけ外れる。前 2 つは掃除のジョブが無い)。所属の変更の記録 (`membership_audit`) の招待先のアドレスは HMAC だけを残す。退会の直前の `prepare_account_deletion` は、本人宛と本人が受諾した招待・昇格の依頼のアドレスを伏せる。パスワードの履歴 (`password_history`) は変更のたびに一定の世代まで残る (退会で消える)。請求 (`data_subject_requests`) は退会で `SET NULL` | `docs/design/operator/08-cron-batches.md:87`・`supabase/functions/_shared/llm-usage.ts:350-372`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:8708, 8838, 9053`・`supabase/migrations/20261016190000_deletion_record_and_invite_email_hash.sql:9-13`・`supabase/migrations/20261016234000_email_outbox.sql:474-516`・`supabase/migrations/20261016243000_auth_history_sessions.sql:128-140`・`docs/design/cross/15-data-subject-requests.md:328` |
| F-47 | 開示等の請求の確認メールの回数の上限 `DSR_VERIFICATION_MAX_SENDS = 5` は**最初の送信を含む** (送り直しは 4 回まで。5 回送った後の再送は 409 `DSR_VERIFICATION_LIMIT`) | `src/lib/data-subject-requests/core.ts:38-39`・`src/__tests__/lib/data-subject-requests/service.test.ts:463-471` |
| F-48 | 体重計・体組成計の写真は、数値を読み取るためにブラウザで縮めて `POST /api/ai/analyze-weight-scale` へ送り、Edge Function `analyze-health-photo` が AI 事業者 (Google) へ送る。route と Edge Function に Storage へ保存する処理は無い (読み取った数値は、利用者が保存すれば健康の記録になる) | `src/app/(main)/meals/new/page.tsx:838-840`・`src/app/api/ai/analyze-weight-scale/route.ts`・`supabase/functions/analyze-health-photo/index.ts`・`src/lib/ai/consent-config.ts:96` |
| F-49 | 家族の中で見えるもの: 食事の行は `can_view_user_meals` (同じ家族の active なメンバーで、相手が `share_meals = TRUE`) の RLS で読める (退出・除名で `status` が active でなくなると読めない)。献立は `family_menu_visible_members` / `family_menu_planned_meals` が、相手が `share_menu = TRUE` のとき料理の名前だけを返す (メモ・栄養の詳細・画像は返さない)。`family_members` の行 (役割・表示名・共有の設定・子どもの生年月日と `child_profile`) は同じ家族の active なメンバー全員が読める。保護者の同意の記録 (`parental_consents`。署名した氏名・IP・User-Agent を含む) は、その家族の代表者と大人 (`is_active_family_adult`) と署名した本人と運営が読める。招待と昇格の依頼 (宛先のメールアドレス) は代表者と大人が読める。共有の設定は本人が `/api/family/members/me/share` で変える | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:940-953, 10371, 10385, 10396`・`supabase/migrations/20261016241000_family_menu_view_functions.sql:7-16, 42`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:127-134`・`src/app/api/family/members/me/share/route.ts` |
| F-50 | 18 歳未満の自己登録: 同意画面で生年月日を入れると、`accept_legal_documents` は何も書かずに `LEGAL_MINOR_SELF_SIGNUP_REFUSED` で断り、画面は「登録をやめる（アカウントを削除する）」を出す | `supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:19, 484-488`・`packages/shared/src/parental-consent.ts:132-135` |
| F-51 | 承諾済みの招待のメールアドレス: 招待の承諾は、招待の宛先のメールアドレスと、承諾する人の登録のメールアドレス (`auth.users.email`) が一致するときだけ通る (組織の `accept_org_invite` と家族の `accept_family_invite` は `INVITE_EMAIL_MISMATCH`、未成年者の本人のアカウントをつなぐ案内の `accept_child_promotion` は `PROMOTION_EMAIL_MISMATCH`)。承諾した後も招待の行は消えず、宛先のメールアドレスが残る (招待の行を消すのは、解散した家族グループの物理削除 (F-53) の `CASCADE` だけ)。組織の招待の一覧 (`GET /api/org/invites`) は承諾済みを含む全件を返し、`/org/invites` が「承諾済」と宛先のアドレスを出す。家族の招待の一覧 (`GET /api/family/invites`) も `select('*')` で全件を返し、`/family/members/invite` の招待履歴が「承諾済」と宛先のアドレスを出す (読めるのは代表者と大人。F-49)。どちらの一覧の GET にも承諾済みを除く条件は無い。退会の直前の `prepare_account_deletion` は、本人宛の招待と本人が承諾した招待のアドレスを伏せる (F-46)。登録のメールアドレスは設定から変えられる (`updateUser({ email })`) ので、招待に残るのは参加の時点の登録のアドレス | `supabase/migrations/20261022100000_org_invite_dissolved.sql:89-93`・`supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:694-696, 895-897`・`src/app/api/org/invites/route.ts:38-62`・`src/app/(org)/org/invites/page.tsx:124, 246, 292`・`src/app/api/family/invites/route.ts:46-50`・`src/app/(main)/family/members/invite/page.tsx:122, 233`・`supabase/migrations/20261016234000_email_outbox.sql:474-505`・`src/app/(main)/settings/account/page.tsx:12` |
| F-52 | 写真の保存: 食事の写真は保存する (Web の記録の画面が `/api/upload` で `fridge-images` の本人のフォルダへ。Edge Function `analyze-meal-photo` も同じバケットへ)。冷蔵庫の写真は、献立の作成の依頼の画面 (`/menus/weekly/request`) で撮影・選択したときだけ保存し (`fridge-images` の本人のフォルダ)、記録の画面・冷蔵庫の画面・週間献立の画面で食材を読み取るときは保存しない (`/api/pantry/from-photo` に写真の URL を渡さない)。健康診断の写真は保存しない (健康診断の画面は「撮影・アップロードした画像は数値の自動読み取りにのみ使用され、記録には保存されません」と出し、記録の画面 (`/meals/new`) のソースに `image_url` が無い)。血液検査の写真 (アプリ) は `/api/ai/analyze-health-checkup` に送るだけで、`blood_test_results.report_image_url` に書く処理は無い (この列を読むのは退会の削除だけ)。体重計・体組成計の写真も保存しない (F-48)。読み取りの route と Edge Function (`analyze-health-checkup`・`analyze-weight-scale`・`analyze-health-photo`) に Storage へ書く処理は無い。本番の読み取り (2026-10-19) で、`health_checkups.image_url` と `blood_test_results.report_image_url` が入った行は 0、`health-checkups` バケットのファイルは 0。アプリのカメラは、ネイティブの画面では血液検査だけが使い、食事・冷蔵庫・健康診断・体重計の撮影は、アプリの記録のタブ (Web の `/meals/new` を WebView で開く) からブラウザのカメラで行う | `src/app/(main)/meals/new/page.tsx:53, 62, 105-108, 1115-1128, 1377`・`supabase/functions/analyze-meal-photo/index.ts:102-109`・`src/app/(main)/menus/weekly/request/page.tsx:58-61`・`src/app/(main)/meals/new/page.tsx:1010-1020`・`src/app/(main)/pantry/page.tsx:165-168`・`src/app/(main)/menus/weekly/page.tsx:2914-2950`・`src/app/(main)/health/checkups/new/page.tsx:450-454`・`apps/mobile/app/health/blood-tests.tsx:242-277`・`src/lib/account-deletion-storage.ts:239-247`・`apps/mobile/app/(tabs)/meals.tsx:4` |
| F-53 | 解散した家族グループの物理削除: 解散した家族グループ (`family_groups.status = 'dissolved'`。解散は運営の強制解散と利用者の解散 (F-59) の 2 つ) は、毎日のジョブ `purge-dissolved-family-groups` が、解散から 90 日 (`c_retention`) を過ぎたものを物理削除する。外部キーの `CASCADE` で `family_members`・`family_invites`・`family_promotion_requests` も消える。保護者の同意の記録 (`parental_consents`) を持つグループは候補から外し、消さずに残す (`NOT EXISTS`)。`family_groups` を消す処理はこのジョブだけ (`representative_id` は `ON DELETE RESTRICT`) なので、同意の記録を持つグループとその同意の記録は期限なく残る | `supabase/migrations/20261018010000_purge_dissolved_family_groups.sql:3-18, 46, 55-59, 69-77`・`supabase/migrations/20251126124224_create_meal_planner_tables.sql:8883, 8893, 8923, 8938` |
| F-54 | レシピの公開と入口: レシピ (`recipes`) の SELECT の RLS (`Users can view public recipes`。最新は `20261009000500_hide_moderated_content.sql` の `ALTER POLICY`) は `TO` を持たず、隠されていない行のうち `user_id IS NULL OR is_public = true OR 本人` を返す。`anon` にも表の権限がある。`GET /api/recipes` は未ログインのとき `is_public = true` の行を返す。レシピを作る `POST /api/recipes` (`is_public` を受け取る) とコメントの `POST /api/recipes/[id]/comments` はあるが、呼ぶ画面は無い (`src/app`・`src/components`・`apps/mobile` に `/api/recipes` への POST と `isPublic` を参照する画面のコードが 0 件)。画面にあるのは、献立の「レシピを見る」(材料と作り方。`RecipeModal`)・週間献立のいいね (お気に入りの画面はいいねを外す)・AI 相談のコレクションへの追加 (`add_recipe_to_collection`)。本番の `recipes` は 0 行 (2026-10-19 の読み取り) | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:10088, 13825-13826`・`supabase/migrations/20261009000500_hide_moderated_content.sql:169-173`・`src/app/api/recipes/route.ts:36-44, 116-138`・`src/app/api/recipes/[id]/comments/route.ts:44`・`src/app/(main)/menus/weekly/_components/modals/RecipeModal.tsx`・`src/app/(main)/menus/weekly/page.tsx:3492`・`src/app/(main)/favorites/page.tsx:111`・`src/lib/ai/consultation-action-executor.ts:1220-1300` |
| F-55 | 画面のメニューの名前: 設定の請求の入口は `DSR_SETTINGS_ENTRY_TITLE = '開示・訂正・利用停止の請求'` (Web の設定と、アプリのアカウントの画面が同じ定数を出す)。お支払いの入口は「プランとお支払い」(Web の設定の項目と、`/account/billing` の見出し)。AI の同意の入口は `AI_CONSENT_SETTINGS_ENTRY_TITLE = 'AI へのデータ提供の同意'`。ログイン履歴の入口は「ログイン中の端末・ログイン履歴」。ホームの区画の名前は「今日のコンディション」。v1.12 で本文はこれらの名前を引用しない (R-28。T-40 が名前の定数と突き合わせて本文に入れさせない) | `packages/shared/src/data-subject-requests.ts:15`・`src/app/(main)/settings/page.tsx:416, 457, 512, 529`・`apps/mobile/app/settings/account.tsx:120-125`・`src/app/(main)/account/billing/page.tsx:229`・`supabase/functions/_shared/ai-consent.ts:313`・`src/app/(main)/home/page.tsx:434` |
| F-56 | #1911 (#1916 4b1e1abe でマージ済み・2026-10-19) は `src/lib/business-info.ts` に、所在地 `BUSINESS_ADDRESS` (`〒105-0013 東京都港区浜松町２丁目2番15号 浜松町ダイヤビル2F`)・設立 `BUSINESS_ESTABLISHED`・資本金 `BUSINESS_CAPITAL`・メールアドレス `BUSINESS_EMAIL` (`info@mhd-iken.com`)・営業時間 `BUSINESS_HOURS` (`平日 9:00-17:00 (年末年始を除く)`)・電話番号の欄の文 `PHONE_DISCLOSED_ON_REQUEST` (`請求があれば遅滞なく開示します`) を足し、`DISCLOSED_ON_REQUEST` を `PHONE_DISCLOSED_ON_REQUEST` に置き換えた。`/legal`・`/company` の電話番号の欄は、#1911 が足した部品 `PhoneOnRequest` が「`PHONE_DISCLOSED_ON_REQUEST`。ご請求は、`BUSINESS_EMAIL` またはお問い合わせフォームからお願いします。」と出し、`tests/business-info-legal-pages.test.ts`・`tests/public-claims-guard.test.ts` が値を固定する。アプリの問い合わせ先 (`getSupportEmail()`) は事業者のメールアドレスとは別のもの (同ファイルの JSDoc) | `src/lib/business-info.ts:17-41` の 8 つの定数・`src/components/legal/PhoneOnRequest.tsx`・`tests/business-info-legal-pages.test.ts` の電話番号の期待値 |
| F-57 | 有料プランは買えない: `listPurchasablePlans` は決済の価格の ID (`stripe_price_id`) を持つ公開のプランだけを返す。本番の読み取り (2026-10-19) で、その条件のプランは 0 件 (`subscription_plans` には価格の列の値があるが、決済の価格の ID が無い)。`billing_customers`・`personal_subscriptions`・`coupon_redemptions`・`org_license_pools` は 0 行。`billing_customers` を書くのは決済の申込みの処理 (`src/lib/billing/repository.ts` と `billing_core` の RPC) だけ、`coupon_redemptions` を書くのは super_admin のクーポンの適用 (`apply_coupon`) だけ。`personal_subscriptions` は決済の Webhook と運営の手動のプラン付与 (`billing_manual_plan_grant`) が書く (料金の無いプランの付与を含むので、第3条は「ご利用のプラン」としてアカウントの区分に入れる)。v1.17 追記: この行は 2026-10-19 の事実。有料プランの販売 (#1912) の後の事実は billing/03 §2.2・§6 が正本で、第3条は `personal_subscriptions`・`billing_customers`・`coupon_redemptions` を「有料プラン」の区分に入れた (billing/03 §11.5)。主張の表の `terms-10#1` の根拠は billing/03 §0.6 に移した (billing/03 §11.4) | `src/lib/billing/public-plans.ts:14-24`・`src/lib/billing/repository.ts:89`・`supabase/migrations/20261016210000_billing_core.sql:368`・`supabase/migrations/20261007160700_apply_coupon_rpc.sql:237`・`supabase/migrations/20261017230000_billing_manual_plan_grant.sql`・本番の読み取り (2026-10-19。MCP の SELECT) |
| F-58 | 使い方の案内: 未ログインでも開ける使い方ガイド `/guide` があり (`publicPaths`)、題は「使い方ガイド」 | `lib/supabase/middleware.ts:316`・`src/lib/seo/public-pages.ts:104`・`src/app/guide/page.tsx:62` |
| F-59 | 利用者が家族グループ・組織を解散する画面と API がある: `POST /api/family/dissolve` (代表者)・`POST /api/org/dissolve` (オーナー) と、メンバーシップ設定 (`/settings/membership`) の解散の区画・凍結中の退会の画面 (`/frozen/account`) と同意の前の退会と書き出しの画面 (`/legal-consent/account`) の 409 の分岐 (共通の枠 `AccountSelfServicePanel`)・モバイルの Alert からの WebView。解散の API は凍結中も同意の前も通る。解散した行は `representative_id` / `owner_id` が NULL になり、退会の 409 (`findBlocker`) と `auth.users` への RESTRICT に当たらない。解散した家族グループの物理削除 (F-53) と保護者の同意の記録の扱いは変わらない (docs/design/family/11-self-dissolve.md) | `src/app/api/family/dissolve/route.ts`・`src/app/api/org/dissolve/route.ts`・`src/components/account/AccountSelfServicePanel.tsx`・`src/lib/account-self-service.ts` (`ACCOUNT_DELETE_BLOCKED_GUIDE`)・`supabase/migrations/20261019120000_self_dissolve.sql` |

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
| 同 32 条 1 項 | 事業者の名称・住所・代表者、利用目的、請求の手続、苦情の申出先 | §7 第1条 (名称・所在地・代表者は `business-info.ts` の値。F-56)・第4条・第14条・第17条 |
| 同 29 条・規則 19〜21 条 | 第三者提供の記録の作成と保存 (本人の同意による提供では、同意の記録などで代えられる場合がある) | §7 §6 の 5 (AI 事業者への提供の記録 = 同意の記録 (F-26))。保存の期間と退会の即時削除の関係は §18 Q-16 |
| 同 33〜35 条・38 条 | 開示 (第三者提供記録を含む。33 条 5 項)・訂正等・利用停止等の請求と手続・手数料 | §7 §14 (手数料は無料)。第三者提供記録の開示は §7 §6 の 5 の記録をもとに行う |
| 同 40 条 | 苦情の適切かつ迅速な処理 | §7 §17 |
| 同 2 条 5 項・6 項・41〜46 条 | 仮名加工情報・匿名加工情報を作成するときは、作成の基準・安全管理・項目の公表など | 作成していない (F-27)。§7 §4 末尾に「作成していない・作成するときは公表して改定する」と書く |
| 電気通信事業法 27 条の 12 | 利用者の端末から外部へ情報を送らせるときは、送る情報の内容・送り先・利用目的を通知または公表 (対象役務に当たる場合) | §7 §10 に表で公表 (対象役務への該当は未確定でも、公表しておく) |
| 消費者契約法 8 条 1 項・3 項・8 条の 2 (出典 L-1) | 損害賠償責任の全部免除・故意重過失の一部免除・解除権の放棄は無効。軽過失の一部免除は、故意・重過失を除く過失にだけ適用されることを明らかにしなければ無効 (8 条 3 項) | §6 第 21 条 (故意・重過失を除く / 軽過失は通常損害に限る / 全部免除にしない / 強行法規に反する限度で適用しない)・第 16 条 5 項と第 18 条 4 項 (凍結などの措置・サービスの変更や中断による損害も「第21条に定める範囲で責任を負う」とし、軽過失の責任を全部は免除しない)・第 4 条 (第三者によるログインの手段の使用は、当社に故意または過失がある場合を除き責任を負わない = 当社に過失が無いときだけ)・第 17 条 1 項 (本サービスの画面から退会できる)。版を上げた後の同意の前 (設定画面が同意画面へ回る間) も、本人が同意画面の下の画面で退会とデータの書き出しを行える (v1.14。P-12。運営が代わりに削除する経路は無い。F-40)。同意を退会の前提にしない (Q-28 は解消)。料金に結ぶ責任の上限は置かない (有料の条文と一緒に #1912。Q-6) |
| 同 9 条 1 項 (出典 L-1) | 平均的な損害を超える損害賠償の予定・年 14.6% 超の遅延損害金は無効 | 違約金・遅延損害金の条項を置かない |
| 同 10 条 (出典 L-1) | 信義則に反して消費者の利益を一方的に害する条項は無効 | 通知の「到達みなし」を置かない。サービス変更・終了は周知の努力を書く |
| 民法 5 条・120 条 | 未成年者の法律行為は法定代理人の同意が無ければ取り消しうる | §6 第 3・5 条 (18 歳未満は保護者の同意) |
| 民法 548 条の 2〜4 | 定型約款の合意・表示・変更 (同意を得ない変更は、周知と効力発生日が要る) | §6 第 1 条 (定型約款として合意)・第 24 条 (内容が変わる変更は再同意で行い、同意した時からそのユーザーに適用する。同意を得ない変更の定めは置かない。Q-19) |
| 個人情報保護法 20 条 2 項・28 条 2 項 (AI) | 外国にある第三者へ要配慮個人情報を送るなら、送る情報の範囲を示して同意 | §7 第5条の 3・第6条 (送る情報にプロフィール・持病・服薬・妊娠/授乳の状況を明記。F-29)。同意画面の文 (`AI_CONSENT_COPY`) の追随は範囲外 (§17・Q-18) |
| 特定商取引法 11 条・12 条の 6 (出典 L-5) | 通信販売の表示・申込み前の確認画面 | 本書の版は有料の条文を書かない (§6 第 10 条は無料で利用できるという今の事実だけ。P-9)。通信販売の表示と確認画面への参照は、有料の条文と一緒に #1912 が足す。利用規約第1条 3 項は特定商取引法に基づく表記を個別規定として参照する |
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
                          (2 ページとも ctx の事業者の情報は src/lib/business-info.ts の定数。#1911)
packages/shared/src/legal-versions.ts   LEGAL_DOCUMENTS を v2026.1 に (§9)
tests/legal-text-1901.test.ts           §13 (文面モジュールとページ)
tests/legal-document-body.test.tsx      §13 (描画部品。T-21〜T-23)
tests/legal-claims-1901.ts              §10.3 (主張の表。T-35 が本文と突き合わせる)
tests/public-claims-guard.test.ts       既存。走査の対象に 2 ページと 2 つの文面モジュールを足す (§16)
tests/site-config-ui.test.tsx           既存。画面の一覧から /privacy を外す (窓口は事業者のメールアドレス。§16)
src/__tests__/api/cron/push-outbox.test.ts   既存。行 176 の版の直書きを LEGAL_DOCUMENTS に (§16)
docs/legal/archive/v2025.1/{terms,privacy}.md   旧版の控え (段 B)
```

- 文面は**データ** (見出しと段落の配列)。ページは配列を描くだけで文を持たない。文面モジュールは `React` を import しない (サーバーでもテストでも素のまま読める)。
- 文面の中の数 (保存期間・年齢・期限) は、製品の定数を import して埋める (`${HIDDEN_CONTENT_RETENTION_DAYS}日` のように)。文面モジュールに意味のある数を直接書かない。
- 文脈 (`LegalTextContext`) は**ページが組み立てる**。事業者の情報は `src/lib/business-info.ts` の定数 (#1911) から、AI 事業者の一覧は `src/app/privacy/page.tsx` が `AI_CONSENT_PROVIDERS` / `AI_CONSENT_PROVIDER_INFO` から作って渡す (既存のテスト `tests/business-info-legal-pages.test.ts` がページのソースにこの 2 つの識別子があることを検査するため)。
- 本文は法令の事項と権利義務の約束だけを持つ (§6 の規則)。製品の操作の細部・未完成や予定の文が入らないことを T-40・T-6 が、有料の語が billing/03 §11 の節の外に入らないことを T-33 が、文面モジュールで確かめる。
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
| S-1 | `/terms` は `publicPaths` で未ログインでも開く → page が `termsText({ businessName: BUSINESS_NAME, businessAddress: BUSINESS_ADDRESS, businessRepresentative: BUSINESS_REPRESENTATIVE, phoneDisclosure: PHONE_DISCLOSED_ON_REQUEST, businessEmail: BUSINESS_EMAIL, businessHours: BUSINESS_HOURS, aiProviders: [] })` を描く → `<main>` の先頭は `LegalDocumentMeta` (版 v2026.1・施行日) → `LegalDocumentBody` が章を h2・条を h3 で描く → h1 は「利用規約」1 つ・header の a は `/` |
| S-2 | `/privacy` も同じ。ctx.aiProviders は 5 社 → 第6条のブロック `ai_providers` が `<ul data-testid="privacy-ai-providers">` に 5 行 → 取得する情報の表 (種類の水準)・委託先の表 (`table`。8 行)・外部送信の表・保存期間の表・請求の手順・窓口 (`contact`。`BUSINESS_EMAIL`) が並ぶ |
| S-3 | middleware: `getOutdatedLegalDocuments({ terms_version_accepted: 'v2025.1', privacy_version_accepted: 'v2025.1' })` → `['terms_of_service','privacy_policy']` → `/legal-consent?next=/` → `LegalConsentForm` の `isReconsent=true, outdated=両方` → `introReconsent`・両方に `revisedBadge` → 全文のリンクは `LEGAL_DOCUMENT_PATHS` → 同意 → `POST /api/legal/accept` (body の版 = `LEGAL_DOCUMENTS` の値) → 200 → `next` へ |
| S-4 | アプリ: `GET /api/legal/status` (許可リストにあるので通る) → `gaps` に 2 文書 → ゲートが WebView → 同意 → `legal-consent-accepted` → `refresh()` → 入口へ |
| S-5 | `/api/meals` は許可リストに無い → 403 `{ code: 'LEGAL_CONSENT_REQUIRED' }` → 画面は同意画面へ。`/api/account/delete`・`/api/account/export`・`/api/account/data-requests/*`・`/api/contact` は許可リスト (`packages/shared/src/legal-consent-api.ts` の `LEGAL_CONSENT_EXEMPT_API_PATHS`) で通る。退会と書き出しを呼ぶ画面は、設定 (`/settings`) が同意画面へ回る (F-32) 代わりに、同意画面の下の `/legal-consent/account` が同意ゲートの対象外で開く (v1.14) ので、利用規約第17条 1 項・第24条 2 項とプライバシーポリシー第13条 4 項は、同意の前でも退会と書き出しを行えると書く。運営が代わりに削除する経路は無い (F-40) ので、お問い合わせによる削除は書かない |
| S-6 | 「同意しない（ログアウトする）」→ signOut → `declineUnavailable` の文と `DSR_SETTINGS_PATH`・`/contact` へのリンク → 再ログイン → S-3 に戻る |
| S-7 | `decideEligibility(row, user, { legalConsentEnforced: true })` → `hasAcceptedCurrentLegalDocuments` が false → `{ ok: false, code: PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED }` (= `consent_outdated`) → 送らない。再同意後は true |
| S-8 | サインアップ画面のリンク → `/terms`・`/privacy` (S-1/S-2) → 登録 → `/auth/callback` の `resolveFirstSignInDestination` が `/legal-consent?next=…` → 生年月日 + 2 つの同意 → `accept_legal_documents(p_birth_date)` |
| S-9 | 同意画面 (`AiDataConsentModal`) と `/privacy` 第6条の一覧は同じ `AI_CONSENT_PROVIDERS` の順で 5 行 (`tests/business-info-legal-pages.test.ts` の #1366 の検査と §13 の T-12 が固定) |
| S-10 | §7 第5条の文は F-22 (プロフィールの欄)・`health_checkups` (結果の数値。写真は読み取りに使うだけで保存しない。F-52)・F-18 (健康の表の SELECT は本人だけ。`share_health` を読む経路は無い)・F-33 (保存した写真は家族・組織に経路が無い)・F-19 (組織は集計のみ) に当たる |
| S-11 | §7 第14条は cross/15 の実装 (`DSR_REQUEST_TYPES`・本人確認のリンク・`DSR_RESPONSE_DUE_DAYS_DEFAULT = 30`) から書き、数は `LEGAL_FACTS.dsrResponseDueDaysDefault` から埋める。リンクの `href` は `DSR_SETTINGS_PATH`。凍結中・退会後は `/contact` (cross/15 S-13) |
| S-12 | §6 第 17 条は cross/08 §16.1-16.3 の表と一致 (即時・取り消し不可・削除の前に書き出せる)。退会後に残るものは §7 第12条の行 (公開の状態のユーザーコンテンツは匿名化・法令で残す記録は紐づけを外して残す・送信停止の記録はアドレスのまま残す・保護者として署名した同意の記録は残す (F-30)・お問い合わせの記録は紐づけを外してアドレスを伏せて残す (F-36)・バックアップは保持の期間だけ残る) |
| S-13 | §6 第 16 条 2 項は `FROZEN_ALLOWED_API_PATHS` の退会・書き出し + `/api/contact` の POST (F-12) と `/frozen` の文 (F-20) に当たる (解約の API も凍結の例外にあるが、有料の条文を書かないので本文に書かない。P-9) |
| S-14 | §6 第 5 条 1 項は `request_child_promotion` (家族の大人が子の行と宛先のメールアドレスを指定) と `accept_child_promotion` (宛先の本人が承諾。cross/14 の「本人のメール」) を「当社の定める方法でその方のアカウントが保護者の家族グループにつながった場合」と書いたもの。2 項は `accept_child_promotion` の共有の設定の 3 つの引数 (F-33) と、家族の中の見え方 (F-49) に当たる。3 項のつながりが切れたときの案内は `guardianMissingHeading`・`guardianMissingBody` (退会の道と、v1.14 から退会と書き出しの画面 `/legal-consent/account` へのリンク) |
| S-15 | §6・§7・§8 のブロックを置き、§8.2 の部品と §8.3 のページの差分を当て、§13 のテストを足し、§9.1 の版を書き換える。`npx tsc`・`vitest` 全件は offload で流す |
| S-16 | §9.3: 内容が変わらない直しは版を据え置く。変わる直しは版を上げて再同意 |
| S-17 | 版上げ後、凍結されていない成人の未同意の人が `/settings` を開く → 同意画面へ回る (F-32)。同意画面のフォームの下の案内 → `/legal-consent/account` (同意ゲートの対象外) → 「データをエクスポート」(`GET /api/account/export`。許可リスト) → 「削除します」と入力して「アカウントを削除」(`POST /api/account/delete`。許可リスト。組織のオーナー・家族の代表者は 409 で、同意の前は譲渡の API が止まるので、同意したうえで譲渡するか、相手がいなければお問い合わせ) → 端末のデータを消してログアウト → 「退会しました」(利用規約第24条 2 項)。先に「同意しない（ログアウトする）」を選んだ人は、`declined` の画面の「ログインして、退会・データの書き出しの画面へ」(`/login?next=%2Flegal-consent%2Faccount`) から同じ画面へ進む。`/settings/data-requests` から開示の請求も出せる |
| S-18 | 代表者の退会 → `POST /api/account/delete` → `findBlocker` が `family_groups.representative_id` を見つけて 409 `ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE` (F-59) → 画面は `ACCOUNT_DELETE_BLOCKED_GUIDE` でメンバーシップ設定 (`/settings/membership`) へ案内 (譲渡と解散)。譲渡の申し出の相手は子どもでない有効なメンバーで、承諾は 18 歳以上だけ (F-38)。相手がいなければ、メンバーシップ設定で家族グループを解散し (`POST /api/family/dissolve`。F-59)、そのあと退会する → 利用規約第11条 4 項の「譲渡するか、家族グループを解散するまで」 |
| S-19 | 15 歳の本人の行は `role = 'adult'` (F-38) → `is_active_family_adult` が真 → `family_invites_select_adult`・`family_promotion_requests_select_family` で招待と昇格の依頼 (宛先のメールアドレス) を読め、`parental_consents_select_signer_family_adult_or_operator` で保護者の同意の記録を読める (F-49)。本人の食事の記録と献立は `share_meals`・`share_menu` に従う。プライバシーポリシー第9条の 1〜3 項に当たる (役割ごとの操作は本文に書かない。R-28) |
| S-20 | `POST /api/ai/consultation/sessions/[sessionId]/messages` → AI の同意の確認 → F-43 の問い合わせでプロフィールと記録を読み、AI 事業者へ送る文に入れる → 回答を `ai_consultation_messages` に保存。第6条の送る情報の項目は T-36 が、この route の読む表と突き合わせる。保存はプライバシーポリシー第3条の「AI 相談」の行・第12条の最初の行 (退会まで。`ai_consultation_sessions` は退会で CASCADE) |
| S-21 | `/privacy` の第1条の表は `ctx.businessName`・`businessAddress`・`businessRepresentative`・電話番号の欄の文 (`phoneDisclosure` + 請求の窓口)・`businessEmail`・`businessHours` を出し、ページは `BUSINESS_*`・`PHONE_DISCLOSED_ON_REQUEST` を渡す (§8.3)。`/legal`・`/company` の同じ欄も同じ定数から出る (#1911。F-56)。T-16 が第1条の値と窓口の `email` を確かめる |
| S-22 | #1912 が §17 の #1912 の行のとおり、`terms-10` の `ol` に項を足し、`privacy-3` の表に有料プランの行、`privacy-4` に決済の目的、`PRIVACY_PROCESSORS` に決済の事業者、`privacy-10` に決済の画面の行、`privacy-12` に決済の記録の行を足す → T-33 の有料の語の検査を改め、T-34 の `PRIVACY_DATA_EXCLUDED` の `'paid_plan'` の 2 表を `PRIVACY_DATA_TABLES` へ移し、§10 の主張の表を作り直し、`LEGAL_DOCUMENTS` の版を上げる (§9.3) |

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
- **本文に書くのは、法令が求める事項と、ユーザーの権利と義務に関わる約束だけ** (R-28・P-11)。製品の操作の細部 (メニューや画面の名前の引用、「設定の〜から」の道順、機能の一覧の列挙、役割ごとの細かい見え方) は書かない。操作は、本サービスの画面・使い方ガイド・お問い合わせへの案内で足りる。画面の名前の引用の形 (`設定の「…」` など) は T-40 が本文から見つけて赤にする。
- **未完成や予定を示す書き方をしない** (R-32・P-9)。「準備中」「販売開始前」「まだ〜していません」「今後〜する予定」「決まり次第」のような文と、「〜する機能はありません」のように無い機能を示す文を書かない。今の版は、今の製品が実際にしていることだけを書く。T-6 が本文から見つけて赤にする。
- **有料プランの条文は billing/03 §11 の項だけ** (R-30・P-9)。価格・自動更新・解約・返金・App Store / Google Play での購入・決済の事業者への送信の条文は、有料プランの販売の案件 (#1912) が両文書の版を `v2026.3` に上げて足した (`docs/design/billing/03-paid-plans-and-iap.md` §11。§17 の #1912 の行)。第10条 (料金) の 2 項以降に足し、条の番号は変えていない。価格と回数の数字は本文に書かず、料金のページと特定商取引法に基づく表記に掲げると書く。T-33 が、有料の語がほかの条に入ると赤にする。
- 文の中の数は `LEGAL_FACTS` (§8.1) から埋める。文面モジュールに意味のある数を直接書かない。
- 事業者の名前・所在地・代表者・連絡先・営業時間・AI 事業者は `ctx` から埋める (R-31・P-10)。文面モジュールに `株式会社` や事業者の名前 (`Inc` を含む) を直接書かない (`tests/business-info-legal-pages.test.ts` の走査に掛かる)。
- `tests/public-claims-guard.test.ts` の禁止語 (「最適な」「24時間以内」「永久無料」「第三者に共有されることはありません」など) を書かない。
- 効果・成果 (「健康になれる」「改善」) を書かない。治療・予防を目的としないことを書く。
- 条番号は見出しに含める。`id` はページ内のアンカー (`/terms#terms-9`) で、他の画面が参照する。
- `links` の `label` は、リンク先の文書・ページを指す固定の文 (「プライバシーポリシー」「使い方ガイド」など) にし、`href` は定数から取る。ログインの後の設定の画面へのリンクは置かない (本文が設定の画面の名前と道順を持たないようにするため。開示等の請求の画面は、同意の前でも開ける請求の窓口なので置く)。

```ts
// tsc:skip
// place=src/lib/legal/terms-text.ts (新設モジュール同士の import のため単独検査から外す。置き場所に置いてリポジトリ全体で検査する)
/**
 * 利用規約の全文 (#1901・設計書 cross/20 §6)。
 * 文面はデータとして持ち、src/app/terms/page.tsx が LegalDocumentBody で描く。
 * 数は LEGAL_FACTS、名前と連絡先は ctx から埋める (このファイルに数・事業者名を直接書かない)。
 * 本文には、法令が求める事項と権利義務の約束だけを書き、画面の名前・道順・機能の一覧・未完成や予定の文を書かない (cross/20 §6 の規則)。
 * 有料の条文は billing/03 §11 が第10条・第16条・第17条・第24条に足した項だけ (docs/design/billing/03-paid-plans-and-iap.md §11.1)。
 * 内容が変わる改定は packages/shared/src/legal-versions.ts の LEGAL_DOCUMENTS.terms_of_service.version を上げる (cross/20 §9)。
 */
import {
  LEGAL_DOCUMENT_PATHS,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  DSR_SETTINGS_PATH,
} from '@homegohan/shared';
import {
  CONTACT_PATH,
  GUIDE_PATH,
  LEGAL_FACTS,
  LEGAL_NOTICE_PATH,
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
  '第10条（料金）',
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
                  '当社が本サービス上に掲載するプライバシーポリシー、特定商取引法に基づく表記、保護者の同意書、および AI 機能で使う日本国外の事業者へのデータ提供に関する同意の文書（以下あわせて「個別規定」といいます）は、本規約の一部を構成します。本規約と個別規定の内容が異なるときは、本規約が優先します。ただし、個人情報の取扱いに関する事項は、プライバシーポリシーの定めが、本規約とほかの個別規定に優先します。',
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
                  '「ユーザーコンテンツ」: ユーザーが本サービスに記録・投稿・アップロードした写真、文章、食事や健康の記録その他の情報。',
                  '「AI 機能」: 写真の読み取り、栄養の推定、献立の作成、AI 相談など、人工知能を用いて行う本サービスの機能。',
                  '「AI 事業者」: AI 機能のために当社がユーザーのデータを送る、日本国外にある事業者。一覧はプライバシーポリシーに記載します。',
                  '「家族グループ」: 複数のユーザーが、食事の記録などを家族の間で共有するための、本サービス上のグループ。',
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
                  '登録を希望する方は、本規約とプライバシーポリシーに同意したうえで、当社の定める方法で利用登録を行います。',
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
                  'ログインに用いる手段が第三者に使われたことによりユーザーに生じた損害について、当社は、当社に故意または過失がある場合を除き、責任を負いません。',
                ],
              },
            ],
          },
          {
            id: 'terms-5',
            heading: TERMS_ARTICLE_HEADINGS[4],
            blocks: [
              {
                kind: 'ol',
                items: [
                  `${f.coppaAgeYears} 歳以上 ${f.adultAgeYears} 歳未満の方は、保護者が保護者の同意書に同意し、当社の定める方法でその方のアカウントが保護者の家族グループにつながった場合に限り、本サービスを利用できます。保護者の同意は、本規約とプライバシーポリシーの内容を含めて行います。`,
                  '保護者の家族グループにつながった未成年者の記録が、保護者を含む家族グループのメンバーに表示されるかどうかは、ほかのメンバーと同じく、本人の共有の設定によります（第11条）。',
                  `保護者の同意とのつながりが無くなったときは、その未成年者は、つながりが戻るか ${f.adultAgeYears} 歳になるまでの間、本サービスを利用できず、退会とデータの書き出しのみを行うことができます。`,
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
              {
                kind: 'ol',
                items: [
                  '本サービスは、食事や健康の記録、献立の作成、AI 機能、家族グループや組織での利用などを通じて、ユーザーの食事の管理を支援するサービスです。',
                  '各機能の内容と使い方は、本サービスの画面と使い方ガイドでご案内します。',
                  '本サービスの機能の内容は、第18条のとおり変わることがあります。',
                ],
              },
              { kind: 'links', items: [{ label: '使い方ガイド', href: GUIDE_PATH }] },
            ],
          },
          {
            id: 'terms-7',
            heading: TERMS_ARTICLE_HEADINGS[6],
            blocks: [
              {
                kind: 'ol',
                items: [
                  'AI 機能は、ユーザーが入力・撮影した内容と、本サービスに記録されたユーザーの情報（プロフィール、食事や健康の記録など）を、日本国外にある AI 事業者へ送って処理します。AI 機能を利用するには、あらかじめ、プライバシーポリシーと同意画面に記載する内容（送る情報、送り先の事業者、その所在国と制度、利用目的）を確認し、同意する必要があります。同意しない場合、AI 機能は利用できませんが、本サービスのそれ以外の機能は利用できます。',
                  '同意は、本サービスの画面から確認し、撤回できます。撤回すると、AI 機能は利用できなくなります。もう一度利用するには、改めて同意が必要です。',
                  '同意が無い間は、自動で行う AI の処理も行いません。',
                  'AI 機能の結果（料理名、分量、栄養の数値、献立、コメント、画像など）は、推定に基づく参考情報です。当社は、その正確性、完全性、有用性を保証しません。写真からの読み取りや栄養の推定には誤りが含まれることがあります。ユーザーは、結果を自分で確認したうえで利用するものとします。',
                  'AI 機能の結果を、医療や健康に関する判断にそのまま用いないでください（第9条）。',
                  'ユーザーは、AI 機能に対し、第三者の個人情報、法令または公序良俗に反する内容、本サービスの動作を妨げることを目的とした内容を入力してはなりません。',
                ],
              },
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
                  '上限の回数は当社が定め、上限に達したときに画面に表示します。',
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
          {
            id: 'terms-11',
            heading: TERMS_ARTICLE_HEADINGS[10],
            blocks: [
              {
                kind: 'ol',
                items: [
                  `${f.adultAgeYears} 歳以上のユーザーは、家族プランを契約して家族グループを作成し、または家族プランを契約した代表者の家族グループに招待を受けて参加できます。家族グループを作成したユーザーが代表者になります。`,
                  '各メンバーは、自分の記録を家族グループに共有するかどうかを自分で設定できます。家族グループの中で誰に何が表示されるかは、プライバシーポリシー第9条のとおりです。',
                  `${f.adultAgeYears} 歳未満の子どもを家族グループに追加するには、追加する方が親権者または法定代理人であることを確認し、保護者の同意書に同意して、氏名を署名する必要があります。`,
                  '代表者以外のメンバーは、家族グループから退出できます。代表者は、代表者をほかのメンバーへ譲渡するか、家族グループを解散するまで、家族グループから退出することも、退会することもできません。家族グループの解散は、代表者が本サービスの画面から行え、解散すると、すべてのメンバーの所属が解除されます。',
                  '代表者が長期間ログインしていないなど、家族グループの運営に支障があるときは、当社が、代表者をほかのメンバーへ譲渡し、または家族グループを解散することがあります。解散した家族グループの情報の扱いは、プライバシーポリシー第12条のとおりです。',
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
                  '組織の管理者は、メンバーの招待と管理を行います。組織の管理者に表示される情報は、プライバシーポリシー第9条のとおりです。',
                  '組織の管理者は、組織に所属する個々のユーザーの食事の記録、健康の記録、AI 相談の内容を閲覧できません。',
                  '組織のチャレンジへの参加は任意です。',
                  '組織のオーナーは、オーナーを組織のほかのメンバーへ譲渡するか、組織を解散するまで、退会できません。組織の解散は、オーナーが本サービスの画面から行え、解散すると、すべてのメンバーの所属が解除されます。オーナーが長期間ログインしていないなど、組織の運営に支障があるときは、当社が譲渡または解散を行うことがあります。',
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
                  '本サービスに保存した食事と冷蔵庫の写真は、本人のほかには表示されず、家族グループのメンバーや組織の管理者にも表示されません。ただし、当社の運営担当者は、投稿の審査、不正利用や不具合の調査に必要な範囲で、これらの写真を閲覧することがあります（プライバシーポリシー第5条）。',
                  'ユーザーが公開の状態にしたユーザーコンテンツは、ログインしていない方を含め、誰でも閲覧できる状態になります。',
                  'ユーザーは、自分のユーザーコンテンツを本サービスに記録・投稿する権利を有し、それが第三者の著作権、肖像権、プライバシーその他の権利を侵害しないことを保証します。',
                  '当社は、本規約に違反し、または違反のおそれがあると判断したユーザーコンテンツを、通知なく非表示にすることがあります。非表示にしたコンテンツの保存の期間は、プライバシーポリシー第12条のとおりです。',
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
                  'ユーザーコンテンツの著作権は、ユーザーに留保されます。当社は、本サービスの提供、改善、不具合の調査に必要な範囲で、ユーザーコンテンツを複製、表示、加工（栄養の推定、AI 機能での処理など）することができます。',
                  'AI 機能が生成した献立、レシピ、コメント、料理の画像などの権利は、法令上権利が生じる範囲で、個人利用の範囲でユーザーに帰属します。当社は、個人を特定できない集計と本サービスの改善の目的に限り、匿名化した形でこれらを利用できます。',
                  'ユーザーが本サービスに投稿したコメント、口コミその他の評価は、当社が本サービスの運営と紹介のために、無償で、期間と地域の制限なく利用できるもの（CC0 相当）として当社に提供されます。',
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
                  '一時的な凍結は、当社が定めた解除の日時が経過すると自動的に解除されます。凍結に心当たりがない場合や、詳細を確認したい場合は、お問い合わせからご連絡ください。',
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
                  'ユーザーは、本サービスの画面から退会できます（凍結中は第16条2項のとおりです）。退会すると、アカウントと、アカウントに紐づく個人データは直ちに削除され、取り消すことはできません。削除の前に、データを書き出すことができます。本規約またはプライバシーポリシーの改定後、改めて同意するまでの間も、退会とデータの書き出しを行うことができます（第24条2項）。',
                  '組織のオーナーと家族グループの代表者は、第11条4項と第12条4項のとおり、オーナーまたは代表者を譲渡するか、組織または家族グループを解散するまで、退会できません。',
                  '退会後も残る情報と、その保存の期間は、プライバシーポリシー第12条のとおりです。',
                  '退会後に再び本サービスを利用するには、新規に登録する必要があります。削除したデータは復元できません。',
                  'App Store または Google Play で申し込んだ有料プランは、退会しても解約されません。退会の前に、各ストアの定期購読の管理から解約してください。Web で申し込んだ有料プランは、退会の手続のときに解約されます。',
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
                  '当社は、次の場合、事前に通知することなく、本サービスの全部または一部の提供を一時的に中断することがあります。（a）システムの保守・点検・更新を行うとき。（b）地震、火災、停電、通信障害などの不可抗力により提供が困難なとき。（c）当社が利用するクラウド、メール、AI などの外部事業者のサービスに障害や停止があるとき。（d）不正アクセスやその他のセキュリティ上の理由があるとき。（e）その他、当社がやむを得ないと判断したとき。保守などで計画的に中断するときは、本サービスの画面にその旨を表示します。',
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
                  'プッシュ通知は、本サービスの設定または端末の設定で止めることができます。止めている間も、本規約やプライバシーポリシーの改定など、本サービスの利用に必要なお知らせは、本サービス上の表示で行います。',
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
                  '当社は、本サービスのデータのバックアップを取得していますが、データが失われないことを保証するものではありません。大切なデータは、データの書き出しにより、ご自身でも保管してください。',
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
                  '本規約またはプライバシーポリシーの内容が変わる改定を行ったときは、文書の版を更新し、施行日以後にユーザーが本サービスを利用するときに、改めて同意をお願いします。同意するまでの間は、本サービスの機能を利用できません（凍結中の方は第16条2項のとおりです）。ただし、個人情報の開示・訂正・利用停止・消去などの請求、お問い合わせ、退会とデータの書き出しは、同意の前でも行うことができます。',
                  '誤字の修正や表現の整理など、内容が変わらない修正は、版を更新せず、改めての同意をお願いしないことがあります。',
                  '各文書の版と施行日は、その文書のページの冒頭に表示します。改定前の版は当社が保管し、お問い合わせによりご提供します。',
                  '改定の後、改めて同意するまでの間も、有料プランは解約できます。App Store または Google Play で申し込んだ有料プランは、各ストアの定期購読の管理から解約できます。Web で申し込んだ有料プランは、お問い合わせからのご依頼を受けて、当社が解約の手続を行います。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: '個人情報の開示等の請求', href: DSR_SETTINGS_PATH },
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
              { kind: 'contact', lines: [`${company} ほめゴハン お問い合わせ窓口`, `営業時間: ${ctx.businessHours}`], email: ctx.businessEmail },
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

第10条 (料金) の 1 項だけの `ol` は、#1912 が有料プランの条文を 2 項以降に足すための置き場所である (条の番号を動かさずに足せる。§17 の #1912 の行)。

---

## 7. 正典: プライバシーポリシーの全文 (`src/lib/legal/privacy-text.ts`)

書き方の規則は §6 と同じ。加えて:
- 取得する情報 (第3条)・送り先 (第6条・第7条・第10条)・保存の期間 (第12条) のように法令上列挙が要るものは、**種類の水準**で書く (例:「食事の写真と、そこから推定した料理と栄養の値」)。表の名前や画面の項目を 1 つずつ書かない。種類の列挙の漏れは、利用者に紐づく表の全体と第3条の行 (T-34)、AI 相談が読む表と第6条の項目 (T-36)、IP・User-Agent を持つ表と第3条の文 (T-30)、CSP の外部の送り先と第10条の表 (T-29)、委託先の根拠と第7条の表 (T-7・T-24) の機械の突き合わせで閉じる。
- AI 事業者の一覧は `ctx.aiProviders` (ページが `AI_CONSENT_PROVIDERS` / `AI_CONSENT_PROVIDER_INFO` から作る) だけから出す。文面モジュールに事業者の名前 (`Google`・`OpenAI`・`Perplexity`・`xAI`・`AI/ML API`) を書かない (`tests/business-info-legal-pages.test.ts` と同じ趣旨。`Google` は OAuth の事業者としては委託先の表 (`PRIVACY_PROCESSORS`) に出る)。
- 委託先の表は `PRIVACY_PROCESSORS` から描く。各行に製品の根拠 (`evidence`: ファイルとその中の語) を持たせ、テストが実在を確かめる (§13)。
- `evidence.needle` には、外部の事業者のホスト名 (`exp.host`・`api.resend.com` など)・`://` を含む URL を書かない。送り先や送信の部品を 1 つのファイルに限る走査テスト (`tests/push-expo-boundary-scan.test.ts` は `exp.host` を含むファイルを、`tests/ai-consent-provider-inventory.test.ts` は `https://<ホスト>` を含むファイルを数える) が、文面モジュールを送信の場所と数えて赤になるため。根拠のファイルの中の識別子 (定数名・import する名前・ワークフローの手順の文) を 6 文字以上で選ぶ (T-7 が形を検査する。§16)。
- 文面モジュールの文と JSDoc に `https://` で始まる URL を書かない (同じ理由。祝日の一覧の送り先は `HOLIDAYS_API_ORIGIN` を import してホストを作る)。
- 事業者の所在地・代表者・メールアドレス・営業時間は `ctx` (ページが `src/lib/business-info.ts` の定数から作る。§8.3) から埋める。電話番号は載せず、`ctx.phoneDisclosure` (= `PHONE_DISCLOSED_ON_REQUEST`「請求があれば遅滞なく開示します」) に、特定商取引法に基づく表記と運営会社のページの電話番号の欄 (#1911 の `PhoneOnRequest`) と同じ請求の窓口の文を続ける (P-10・F-56)。

```ts
// tsc:skip
// place=src/lib/legal/privacy-text.ts (新設モジュール同士の import のため単独検査から外す。置き場所に置いてリポジトリ全体で検査する)
/**
 * プライバシーポリシーの全文 (#1901・設計書 cross/20 §7)。
 * 文面はデータとして持ち、src/app/privacy/page.tsx が LegalDocumentBody で描く。
 * 数は LEGAL_FACTS、事業者の情報・AI 事業者の一覧は ctx から埋める (このファイルに数・事業者名を直接書かない。
 * 委託先の名前だけは PRIVACY_PROCESSORS に持ち、tests/legal-text-1901.test.ts が evidence の実在を確かめる)。
 * 取得する情報・送り先・保存の期間は種類の水準で書き、漏れはテストが表と突き合わせて閉じる (cross/20 §7 の規則)。
 * 内容が変わる改定は packages/shared/src/legal-versions.ts の LEGAL_DOCUMENTS.privacy_policy.version を上げる (cross/20 §9)。
 */
import {
  LEGAL_DOCUMENT_PATHS,
  PARENTAL_CONSENT_DOCUMENT_PATH,
  DSR_SETTINGS_PATH,
} from '@homegohan/shared';
import { HOLIDAYS_API_ORIGIN } from '@/lib/security/csp';
import {
  CONTACT_PATH,
  LEGAL_FACTS,
  LEGAL_NOTICE_PATH,
  type LegalDocumentText,
  type LegalTextContext,
} from './legal-text';

/** 第10条の祝日の一覧の送り先のホスト (献立のカレンダーがブラウザから取得する。CSP の connect-src と同じ定数から作る) */
const HOLIDAYS_API_HOST = new URL(HOLIDAYS_API_ORIGIN).host;

/** プライバシーポリシーの条の見出し。順と数は privacyText の h3 と一致する */
export const PRIVACY_SECTION_HEADINGS = [
  '第1条（事業者の名称、所在地、代表者、連絡先）',
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
 * 有料プランの決済の事業者 (Stripe) とアプリ内課金の購入の確認 (RevenueCat) は billing/03 §11.2 が足した。ストアの事業者 (Apple・Google) は委託先ではないので載せない (第3条に書く。billing/03 Q-17)。
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
                  ['所在地', ctx.businessAddress],
                  ['代表者', ctx.businessRepresentative],
                  ['電話番号', `${ctx.phoneDisclosure}。ご請求は、${ctx.businessEmail} またはお問い合わせフォームからお願いします。`],
                  ['メールアドレス', ctx.businessEmail],
                  ['営業時間', ctx.businessHours],
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
              { kind: 'p', text: '当社は、本サービスの提供のために、次の情報を取得します。ユーザーが入力・撮影・アップロードするもののほか、本サービスの利用に伴って自動的に記録・計算されるものがあります。' },
              {
                kind: 'table',
                headers: ['区分', '主な内容'],
                rows: [
                  ['アカウント', 'メールアドレス、パスワード（ハッシュ化して保存します）、Google アカウントで登録した場合に Google から受け取る情報、生年月日、ニックネーム、ご利用のプラン'],
                  ['有料プラン', '申し込んだ有料プランとその契約の状態・期間・無料体験の利用の有無、申し込んだ場所（Web・App Store・Google Play）、決済の事業者（Stripe）と RevenueCat が付ける顧客と契約の識別子、クーポンの利用の記録。App Store または Google Play で申し込んだ場合は、Apple または Google が各ストアの規約に従って決済を行い、当社は RevenueCat を通じて購入の情報（商品、購入と期限の日時、契約の状態）を受け取ります。クレジットカードの番号は、当社は受け取りません'],
                  ['プロフィール', '身長・体重などの身体の情報、生活習慣、食の好みとアレルギー、目標、健康上の注意点（持病、服薬、妊娠の有無など。要配慮個人情報を含みます）、栄養の目標'],
                  ['食事と献立', '食事の写真と、そこから推定した料理と栄養の値、食事の記録、献立と献立の作成の依頼の内容、冷蔵庫の写真と食材、買い物リスト'],
                  ['レシピ', 'いいねや保存をしたレシピ、ユーザーが登録したレシピとコメント'],
                  ['健康', '体重・血圧などの健康の記録、健康の目標、健康診断や血液検査の結果（要配慮個人情報を含みます）、これらへの AI のコメント、健康に関するヒント'],
                  ['毎日のコンディション', '体調、睡眠、運動などのコンディションの記録と、それをもとにした栄養の目標の見直し'],
                  ['AI 相談', '相談の文章、AI の回答、相談の要約、AI が提案した操作とその結果'],
                  ['記録の継続と比較', '記録の連続日数、チャレンジ、バッジ、記録から計算した指標と、年齢層・性別などが同じユーザーの中での順位'],
                  ['家族グループ', '家族グループとメンバーの情報（役割、表示名、共有の設定）、招待の宛先のメールアドレス、子どもの名前・生年月日・性別、代表者の譲渡の申し出'],
                  ['組織', '所属する組織と組織内の役割、組織からの招待の情報、チャレンジへの参加、オーナーの譲渡の申し出'],
                  ['お問い合わせ・サポート・請求', 'お問い合わせとサポートのやりとり、個人情報の開示などの請求の内容、これらへの対応の記録'],
                  ['同意の記録', '利用規約とプライバシーポリシーに同意した版・日時・IP アドレス・ブラウザや端末の種類、AI 機能のための日本国外の事業者への提供に同意した版・日時・IP アドレス・ブラウザや端末の種類、保護者の同意の署名（氏名）と、同意した日時・IP アドレス・端末の種類・子どもの生年月日'],
                  ['端末・利用状況・ログ', 'IP アドレス（ログインの記録では、IP アドレスとそのネットワークの範囲、通信から判定した国を含みます）、ブラウザや端末の種類、ログインの履歴とセッション、プッシュ通知の宛先と通知の設定、アプリの動作のログ、AI 機能の利用回数と AI 事業者を呼び出した記録、メールとプッシュ通知の送信待ちの記録、本サービスの改善のための試験の割り当て'],
                  ['運営の記録', '運営担当者が対応のために残すメモ、家族グループや組織の所属の変更の記録、栄養の計算を確かめるための記録、退会の記録'],
                  ['Cookie 等', '第10条のとおり'],
                ],
              },
              { kind: 'p', text: 'アプリは、ユーザーが写真を撮る・選ぶとき、またはプッシュ通知を受け取るときに限り、端末が表示する許可の画面でユーザーの許可を得て、カメラ、写真ライブラリ、通知を使います。許可は、端末の設定から取り消せます。本サービスは、端末の位置情報、連絡先、マイクの音声を取得しません。' },
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
                  '本サービスの提供（アカウントの管理、記録の保存と表示、献立の作成、家族グループと組織の機能、お知らせと通知）のため。',
                  '有料プランの提供（申込みの受付、契約と料金の請求の管理、解約と返金の対応、二重のお支払いの防止）のため。',
                  '記録の継続と比較の機能（記録から計算した指標を、年齢層・性別などが同じユーザーの集計と比べて本人に表示すること）のため。',
                  'AI 機能の提供のため。第6条のとおり、日本国外の AI 事業者への送信を含みます。',
                  '本人確認、なりすましや不正利用の防止、セキュリティの確保のため。',
                  '年齢の確認と、未成年者についての保護者の同意の管理のため。',
                  'お問い合わせ、サポート、個人情報の開示などの請求への対応のため。',
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
                  'これらの情報を AI 機能のために日本国外の AI 事業者へ送るのは、第6条の同意がある場合に限ります。持病、服薬、妊娠・授乳の状況、健康診断や血液検査の結果は、AI 機能のために送る情報に含まれます（第6条）。',
                  '健康に関する記録は、家族グループのメンバーにも組織の管理者にも表示されません（第9条）。健康診断や血液検査の結果と、体重計・体組成計の表示を読み取るために撮影・選択した写真は、数値の読み取りに使うだけで、本サービスには保存しません。',
                  '当社の運営担当者は、お問い合わせへの対応、投稿の審査、不正利用の調査、不具合の調査に必要な範囲でのみ、これらの情報と、本サービスに保存した写真を取り扱います。',
                  '要配慮個人情報を、本人の同意なく第三者に提供することはありません。本人の同意を得ずに行う第三者提供（いわゆるオプトアウトによる提供）は行いません。',
                ],
              },
            ],
          },
          {
            id: 'privacy-6',
            heading: PRIVACY_SECTION_HEADINGS[5],
            blocks: [
              { kind: 'p', text: '本サービスの AI 機能は、ユーザーが入力・撮影した内容と、本サービスに記録されたユーザーの情報を、日本国外にある次の事業者の AI に送って処理します。これらの事業者への提供は、個人情報保護法 28 条の「外国にある第三者への提供」として、次の情報をお示ししたうえで、ユーザー本人の同意を得て行います。' },
              { kind: 'ai_providers', providers: ctx.aiProviders },
              { kind: 'p', text: '送る情報は次のとおりです。どの情報を送るかは、機能によって異なります。' },
              {
                kind: 'ul',
                items: [
                  '食事の写真、食事と献立の記録、栄養の目標',
                  '健康の記録、健康の目標、健康診断や血液検査の結果と写真、体重計・体組成計の写真、健康に関するヒント',
                  'プロフィールの情報（ニックネーム、年齢、性別、身体の情報、仕事や生活の習慣、家族の構成、食の好みとアレルギー、目標など）',
                  '健康に関する情報（持病、服薬、妊娠・授乳の状況）。これらは要配慮個人情報に当たります（第5条）',
                  'AI 相談に入力した文章と、それまでのやりとりとその要約',
                  '冷蔵庫の写真と食材、買い物リスト、保存したレシピ、獲得したバッジ',
                ],
              },
              { kind: 'p', text: 'ニックネームは、AI 相談や献立の作成などで送ることがあります。ニックネームに実名を登録している場合は実名が送られることになるため、ニックネームには実名を使わないことをお勧めします。' },
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
                  '同意するまで、また同意を撤回した後は、当社のサーバーがユーザーのデータを AI 事業者へ送る手前で止めます。自動で行う AI の処理も行いません。',
                  '同意は、本サービスの画面から確認し、撤回できます。撤回すると AI 機能は利用できなくなり、再び利用するには改めて同意が必要です。',
                  '同意の文面や事業者の一覧を変更したときは、同意の版を更新し、AI 機能を使う前に改めて同意をお願いします。',
                  'AI 事業者への提供の記録として、同意の記録（同意した事業者、同意の版、日時、撤回した日時）を保存します。送る情報の項目と事業者は、同意の版ごとに、同意画面と本条に示したとおりです。第三者への提供の記録の開示の請求（第14条）には、この記録をもとにお答えします。同意の記録は、データの書き出し（第13条）にも含まれます。',
                ],
              },
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
              {
                kind: 'ol',
                items: [
                  '家族グループの中では、メンバーの表示名・役割・共有の設定と、子どもの名前・生年月日・性別を、家族グループのメンバーが閲覧できる状態になります。',
                  '食事の記録と、献立の料理の名前は、本人の共有の設定に従って、家族グループのメンバーに表示されます。初期設定では共有します。共有の設定は、本人が変更できます。',
                  '家族グループへの招待の宛先のメールアドレスと、保護者の同意の記録（署名した氏名、同意した日時、IP アドレス、端末の種類などを含みます）は、家族グループのメンバーが閲覧できる状態になります。',
                  '招待を承諾して参加したメンバーの、参加の時点で登録していたメールアドレスは、承諾した招待の宛先として残り、家族グループや組織から退出した後も、家族グループのメンバーや組織の管理者が閲覧できる状態になります。退会した後の扱いは第12条のとおりです。',
                  '組織の管理者に表示されるのは、メンバーの表示名、組織内の役割、参加した日、組織への招待の状況（招待の宛先のメールアドレスを含みます）、メンバーの人数、チャレンジの参加人数と平均などの個人を特定できない集計だけです。',
                  '組織のチャレンジに参加したユーザーの順位は、参加者どうしに表示されます。',
                  '本サービスに保存した写真、健康の記録、AI 相談の内容、ほかのユーザーとの比較の順位、ログインの履歴は、家族グループのメンバーにも組織の管理者にも表示されません。',
                  '家族グループから退出し、または外されたメンバーの食事の記録と献立は、ほかのメンバーに表示されなくなります。',
                ],
              },
            ],
          },
          {
            id: 'privacy-10',
            heading: PRIVACY_SECTION_HEADINGS[9],
            blocks: [
              { kind: 'p', text: '本サービスは、ユーザーのブラウザや端末に情報を保存し、または端末から外部の事業者へ情報を送信させることがあります。電気通信事業法の外部送信規律の趣旨に従い、その内容を次のとおり公表します。当社は、広告のための Cookie やアクセス解析のための第三者の Cookie を使用しておらず、第三者の広告も配信していません。' },
              {
                kind: 'table',
                headers: ['送信先・保存先', '送る情報・保存する情報', '目的'],
                rows: [
                  ['Supabase（当社の委託先。ブラウザとアプリから直接）', 'ログインの状態を示す識別子、読み書きするデータ、IP アドレス、ブラウザや端末の種類', 'ログイン、記録の保存と表示、写真の表示'],
                  ['当社（ブラウザの Cookie）', 'ログインの状態を保つための識別子', 'ログインの維持と、画面の表示の制御'],
                  ['当社（アプリ内のブラウザの保存領域）', 'ログインの状態、画面の設定', 'アプリでの画面の表示'],
                  ['Vercel（表示速度の計測）', 'ページの URL（個人に関わる部分は送る前に消します）、表示速度の計測値、ブラウザの種類', '画面の表示速度の改善'],
                  ['Cloudflare（ボットの判定）', 'ブラウザや端末の情報、IP アドレス', 'ログインや登録などの画面でのボットの判定'],
                  ['Google（ログインの画面）', 'Google のログイン画面で Google が取得する情報', 'Google アカウントでのログイン'],
                  [`GitHub（GitHub Pages の祝日の一覧。${HOLIDAYS_API_HOST}）`, '取得する年、IP アドレス、ブラウザの種類（ユーザーの記録は送りません）', '献立のカレンダーに日本の祝日を表示するため'],
                  ['Expo（プッシュ通知）', '端末のプッシュ通知のトークン', 'アプリへの通知の配信'],
                  ['Stripe（Web のお支払いの画面）', 'お支払いの画面で入力するカードの情報、メールアドレス、IP アドレス、ブラウザの種類', 'Web での有料プランのお支払い'],
                  ['RevenueCat（iOS・Android のアプリから）', '当社の利用者 ID、SDK が作る識別子、アプリの版、OS の種類、購入の情報', 'アプリ内課金の購入の確認と、契約の状態の同期'],
                ],
              },
              { kind: 'p', text: 'カメラ、写真ライブラリ、通知などの端末の機能へのアクセスは、第3条のとおりです。' },
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
                  '組織的な措置: 運営担当者の権限を役割ごとに分け、運営担当者が利用者のデータを変更する操作を記録しています。大きな権限を持つ運営担当者のログインに多要素認証を用いる仕組みを設けています。漏えいなどが生じたときは、法令に従い個人情報保護委員会への報告と本人への通知を行います。',
                  '物理的な措置: 本サービスのデータは、委託先のクラウド事業者のデータセンターで保管し、入退室管理などの物理的な措置は各事業者の管理に依拠しています。',
                  '技術的な措置: 通信の暗号化、パスワードのハッシュ化、データベースの行ごとのアクセス制御、写真の非公開の保存、回数の制限とボットの判定、ログにメールアドレスなどを残さない処理、バックアップの暗号化、退会時の即時削除。',
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
                  ['アカウントと、アカウントに紐づく情報（登録情報、ユーザーコンテンツ、利用規約・プライバシーポリシーと AI 機能への同意の記録、通知の設定、プッシュ通知の宛先、AI 機能の利用回数など）', '退会するまで。退会すると直ちに削除します（下の各行に定めるものを除きます。第13条）'],
                  ['公開の状態のユーザーコンテンツ', '退会後も、ユーザーとの紐づけを外して匿名の状態で残します'],
                  ['保護者として署名した同意の記録', '同意の根拠として、期限を定めずに保存します。署名した保護者が退会したときも、家族グループが解散したときも残します'],
                  ['解散した家族グループの情報（招待の宛先のメールアドレスを含みます）', `解散から ${f.dissolvedFamilyGroupRetentionDays} 日が経過すると削除します。ただし、保護者の同意の記録があるグループは、同意の根拠として、削除せずに残します`],
                  ['当社が非表示にしたコンテンツ', `非表示にしてから ${f.hiddenContentRetentionDays} 日`],
                  ['ログインの履歴とセッションの記録', `セッションが失効してから ${f.loginHistoryRetentionDays} 日。セッションは ${f.sessionIdleExpireDays} 日間操作が無いと失効します`],
                  ['アプリの動作のログ（ブラウザのセキュリティ違反の報告を含みます）', `${f.appLogRetentionDays} 日。退会した場合も、この期間が過ぎるまでは、ユーザーとの紐づけを外して残ります`],
                  ['メールとプッシュ通知の送信待ちの記録', `送れたものは ${f.outboxSentRetentionDays} 日、送れなかったものは ${f.outboxDeadRetentionDays} 日。退会すると宛先・件名・本文を伏せます`],
                  ['利用回数の制限のための計数', '制限の判定に使う期間が過ぎると、自動的に消えます'],
                  ['お問い合わせ、サポート、個人情報の請求の記録（運営担当者の対応のメモを含みます）', '期限を定めずに保存します。退会すると、ユーザーとの紐づけを外し、お問い合わせのメールアドレスを伏せて残します（件名と本文、請求の内容、運営担当者の対応のメモは残ります）'],
                  ['招待と、家族グループや組織の所属の変更の記録', '退会すると、ユーザーとの紐づけを外して残します。ユーザー宛ての招待と、ユーザーが承諾した招待のメールアドレスは伏せます（所属の変更の記録には、招待の宛先のメールアドレスはハッシュにした値だけを残します）'],
                  ['AI 事業者を呼び出した記録（日時、機能、利用量。送った内容は含みません）', '期限を定めずに保存します。退会した後も、アカウントの識別子（氏名やメールアドレスは含みません）とともに残ります'],
                  ['栄養の計算を確かめるための記録と、AI が献立のために作成した料理のデータ', '期限を定めずに保存します。退会すると、ユーザーとの紐づけを外して残します'],
                  ['法令上の保存義務や、不正利用の防止のために必要な記録（運営担当者の操作の記録など）', '退会後も、ユーザーとの紐づけを外して残します。保存の期限は法令と当社の定めによります'],
                  ['メールの送信停止の記録（苦情や配信の失敗があったメールアドレス）', '再び送らないために、退会後もメールアドレスのまま残します（第16条）'],
                  ['退会の記録', '退会した日時と理由を、ユーザーを特定できない形（識別子のハッシュ）で残します'],
                  ['データベースのバックアップ', `日次のものは ${f.backupDailyRetentionDays} 日、週次のものは ${f.backupWeeklyRetentionDays} 日、年次のものは ${f.backupAnnualRetentionDays} 日（${f.backupAnnualRetentionYears} 年）。暗号化して保管し、障害からの復旧の目的以外では開きません。退会したユーザーのデータも、取得の時点のものはこの期間残ります`],
                  ['AI 事業者に送った内容', '各事業者の規約によります（第6条）'],
                  ['有料プランの契約の記録（プラン、契約の状態、期間、申し込んだ場所）', '退会するまで。退会すると直ちに削除します'],
                  ['決済の事業者の顧客の記録と、クーポンの利用の記録', '期限を定めずに保存します。退会すると、ユーザーとの紐づけを外して残します（決済の事業者の顧客の情報は匿名にします）'],
                  ['決済の事業者と RevenueCat から届いた通知の記録（通知の種類・日時、契約の識別子、アカウントの識別子）', '期限を定めずに保存します。退会した後も、アカウントの識別子（氏名やメールアドレスは含みません）とともに残ります'],
                  ['決済の事業者とストアが保存する記録', '各事業者の規約によります'],
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
                  'ユーザーは、本サービスの画面から退会できます。退会すると、アカウントと、アカウントに紐づく個人データを直ちに削除します。削除は取り消せません。',
                  '退会後も残るものは、本ポリシー第12条のとおりです。',
                  'ユーザーは、自分の個人データを、機械で読める形式（JSON）で書き出すことができます。アカウントの凍結中も、退会と書き出しは行えます。',
                  '利用規約や本ポリシーの改定後、改めて同意するまでの間も、退会と書き出しを行うことができます（利用規約第24条2項）。この間も、第14条の開示の請求により、個人データの開示を求めることができます。',
                  '組織のオーナーと家族グループの代表者は、オーナーまたは代表者を譲渡するか、組織または家族グループを解散するまで、退会できません（利用規約第11条4項・第12条4項）。',
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
                  '請求は、本サービスの請求の画面から行います。請求の種類と内容を送ると、登録されたメールアドレスへ本人確認のためのリンクを送ります。本人確認が済んだ時点で請求を受け付けます。',
                  `当社は、本人確認が済んだ請求に遅滞なく対応します。対応は、本人確認が済んだ日から ${f.dsrResponseDueDaysDefault} 日以内を目安とし、結果をお知らせします。目安の期間内に対応できないときは、その理由と見込みをお知らせします。`,
                  '法令により開示などに応じられない場合（本人または第三者の生命、身体、財産その他の権利利益を害するおそれがある場合、当社の業務の適正な実施に著しい支障を及ぼすおそれがある場合、他の法令に違反することとなる場合など）は、その旨と理由をお知らせします。',
                  '開示は、本サービスの画面での表示、またはデータの書き出し（JSON）により行います。請求の手数料はいただきません。',
                  'アカウントが凍結されている方、退会した方、ログインできない方、および代理人による請求は、お問い合わせフォームまたはメールで受け付け、別途本人確認（代理人の場合は代理権の確認を含みます）を行います。',
                  'アカウントとデータ全体の消去の請求には、退会（第13条）の方法をご案内して対応します。利用の停止の請求は、当社が請求の内容を確認し、停止の方法をご案内します。',
                ],
              },
              {
                kind: 'links',
                items: [
                  { label: '個人情報の開示等の請求', href: DSR_SETTINGS_PATH },
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
                  `${f.adultAgeYears} 歳未満の方が本サービスを利用するには、保護者の同意が必要です。${f.coppaAgeYears} 歳以上 ${f.adultAgeYears} 歳未満の方は、利用規約第5条の方法でのみ本サービスを利用できます。${f.coppaAgeYears} 歳未満の方の本人名義のアカウントは作成しません。`,
                  '本人のアカウントが無い子どもについて、保護者が家族グループに登録できるのは、名前、生年月日、性別（任意）です。未成年者の個人情報の開示などの請求は、本人または保護者から受け付けます。',
                  `生年月日は年齢の確認のために用い、保護者の同意が必要な方を判定するために使います。保護者の同意とのつながりが無い ${f.adultAgeYears} 歳未満の方が、ご自身で登録して生年月日を申告したときは、生年月日を記録せずに利用をお断りし、登録をやめる（アカウントを削除する）手続をご案内します。`,
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
                  'プッシュ通知は、本サービスの設定または端末の設定で止めることができます。',
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
              { kind: 'contact', lines: [`${company} 個人情報担当`, `営業時間: ${ctx.businessHours}`], email: ctx.businessEmail },
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

/**
 * 文面の中で製品の定数から埋める値。ページ (src/app/terms, src/app/privacy) が src/lib/business-info.ts の定数から組み立てる。
 * 事業者の情報の値は、特定商取引法に基づく表記 (/legal) と運営会社 (/company) と同じ定数から出す (#1911)。
 */
export interface LegalTextContext {
  /** 事業者の正式名称 (BUSINESS_NAME) */
  readonly businessName: string;
  /** 所在地 (BUSINESS_ADDRESS) */
  readonly businessAddress: string;
  /** 代表者 (BUSINESS_REPRESENTATIVE) */
  readonly businessRepresentative: string;
  /** 電話番号の欄に出す文 (PHONE_DISCLOSED_ON_REQUEST。番号は載せない) */
  readonly phoneDisclosure: string;
  /** 連絡先のメールアドレス (BUSINESS_EMAIL) */
  readonly businessEmail: string;
  /** 営業時間 (BUSINESS_HOURS) */
  readonly businessHours: string;
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
 * 文面からリンクするページ。既存の公開のページのパス (定数が無いものはここで決める)。
 * 文書 (利用規約・プライバシーポリシー・保護者の同意書) と開示等の請求の画面は @homegohan/shared の定数を文面モジュールが直接 import する。
 * ログインの後の設定の画面へのリンクは置かない (cross/20 §6 の規則)。
 */
export const CONTACT_PATH = '/contact';
export const LEGAL_NOTICE_PATH = '/legal';
export const GUIDE_PATH = '/guide';

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
  /** 開示等の請求の応答期限の既定 (src/lib/data-subject-requests/core.ts DSR_RESPONSE_DUE_DAYS_DEFAULT。環境変数 DSR_RESPONSE_DUE_DAYS で上書きされうるので「目安」と書く) */
  dsrResponseDueDaysDefault: 30,
  /**
   * 解散した家族グループを物理削除するまでの日数。正本は削除のジョブの関数 purge_dissolved_family_groups の最新の定義の
   * c_retention (supabase/migrations/20261018010000_purge_dissolved_family_groups.sql の interval '90 days')。
   * 保護者の同意の記録 (parental_consents) を持つグループは、この日数を過ぎても消さない (同じ関数の NOT EXISTS)
   */
  dissolvedFamilyGroupRetentionDays: 90,
} as const;
```

- v1.11 にあった `PRICING_PATH`・`BILLING_PATH` (有料プランと設定の画面へのリンク)、`LEGAL_FACTS` の `dsrVerificationTtlHours`・`dsrVerificationMaxSends` (請求の確認メールの細部)・`inactiveRepresentativeDays` (運営の一覧の日数)・`liabilityCapMonths` (料金に結ぶ責任の上限) は、v1.12 で本文からその文を外したので置かない (R-28・R-30)。
- `LegalTextContext` の `addressDisclosure`・`supportEmail` は、v1.12 で `businessAddress`・`phoneDisclosure`・`businessEmail`・`businessHours` に置き換えた (P-10・F-56)。

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

前提: 本書の実装は #1911 のマージの後に始める (§14)。`src/lib/business-info.ts` に `BUSINESS_ADDRESS`・`BUSINESS_EMAIL`・`BUSINESS_HOURS`・`PHONE_DISCLOSED_ON_REQUEST` があること (F-56)。#1911 は #1916 (4b1e1abe) でマージ済みで、main の名前は下と同じ (§17 の #1911 の行)。

```ts
// tsc:skip
// place=src/app/terms/page.tsx (新設モジュール同士の import のため単独検査から外す)
import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocumentBody } from "@/components/legal/LegalDocumentBody";
import { LegalDocumentMeta } from "@/components/legal/LegalDocumentMeta";
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_HOURS,
  BUSINESS_NAME,
  BUSINESS_REPRESENTATIVE,
  PHONE_DISCLOSED_ON_REQUEST,
} from "@/lib/business-info";
import { termsText } from "@/lib/legal/terms-text";
import { publicPageMetadata } from "@/lib/seo/public-pages";

// #1174 (同意の前提): 未ログインでも読める公開ページ。サインアップ画面・LP フッターの同意リンクの着地点なので、
// (main) グループ (ログイン後の画面。アプリ用のナビ付き) の外に置く。
// ログイン・オンボーディング・凍結の差し戻しからは、lib/supabase/middleware.ts の publicPaths と
// lib/onboarding-routing.ts の isPolicyPath で除外している。
// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
// #1901: 本文は src/lib/legal/terms-text.ts (設計書 cross/20 §6) が正本。このファイルは文を持たない。
//        事業者の情報は src/lib/business-info.ts (#1911) の定数を渡す (特定商取引法に基づく表記・運営会社のページと同じ値)
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
    businessAddress: BUSINESS_ADDRESS,
    businessRepresentative: BUSINESS_REPRESENTATIVE,
    phoneDisclosure: PHONE_DISCLOSED_ON_REQUEST,
    businessEmail: BUSINESS_EMAIL,
    businessHours: BUSINESS_HOURS,
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
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_HOURS,
  BUSINESS_NAME,
  BUSINESS_REPRESENTATIVE,
  PHONE_DISCLOSED_ON_REQUEST,
} from "@/lib/business-info";
import { privacyText } from "@/lib/legal/privacy-text";
import { publicPageMetadata } from "@/lib/seo/public-pages";

// #1174 (同意の前提): 未ログインでも読める公開ページ。サインアップ画面・LP フッターの同意リンクと、
// ストア審査に出すプライバシー URL の着地点なので、(main) グループ (ログイン後の画面。アプリ用のナビ付き) の外に置く。
// ログイン・オンボーディング・凍結の差し戻しからは、lib/supabase/middleware.ts の publicPaths と
// lib/onboarding-routing.ts の isPolicyPath で除外している。
// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
// #1901: 本文は src/lib/legal/privacy-text.ts (設計書 cross/20 §7) が正本。このファイルは文を持たない。
//        事業者の情報と窓口は src/lib/business-info.ts (#1911) の定数を渡す (特定商取引法に基づく表記・運営会社のページと同じ値)
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
    businessAddress: BUSINESS_ADDRESS,
    businessRepresentative: BUSINESS_REPRESENTATIVE,
    phoneDisclosure: PHONE_DISCLOSED_ON_REQUEST,
    businessEmail: BUSINESS_EMAIL,
    businessHours: BUSINESS_HOURS,
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
- 2 ページは `getSupportEmail()` を読まない (v1.12)。窓口のメールアドレスは事業者のメールアドレス (`BUSINESS_EMAIL`) にした (P-10)。`tests/site-config-ui.test.tsx` の画面の一覧から `/privacy` を外し、T-16 が `/privacy` の窓口と第1条の値を `business-info.ts` の定数と突き合わせる (§16)。
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
 * 施行日は公開 (デプロイ) の日で、2026-10-19 に公開した (#1918。cross/20 §9.4 の 3)。
 * 施行日は YYYY-MM-DD の形の実在する日付にする (形を外すと /api/legal/status が 500 を返し、同意画面とテストが壊れる)。
 *
 * #1917 (docs/design/family/11-self-dissolve.md §18): 代表者・オーナーが解散してから退会できるようになり、利用規約第11条 4 項・第12条 4 項・第17条 2 項と
 * プライバシーポリシー第13条 9 項の退会の条件が変わるので、両文書を v2026.2 に上げる。
 * v2026.2 の施行日は公開 (デプロイ) の日の 2026-10-21 (cross/20 §9.4 の 3・family/11 §18.4)。
 *
 * billing/03 (#1912。docs/design/billing/03-paid-plans-and-iap.md §11): 有料プランの条文 (料金・自動更新・解約・返金・無料体験・
 * アプリ内課金・家族プラン、決済の事業者 (Stripe) と RevenueCat への提供と外部送信、保存期間) を利用規約第10条・第11条 1 項・
 * 第16条 2 項・第17条・第24条とプライバシーポリシー第3条・第4条・第7条・第10条・第12条に足すので、両文書を v2026.3 に上げる。
 * v2026.3 の施行日は公開 (デプロイ) の日 (cross/20 §9.4 の 3・billing/03 §11.6)。
 */
export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentType, LegalDocumentInfo>> = {
  terms_of_service: { version: 'v2026.3', effectiveDate: '2026-10-22' },
  privacy_policy: { version: 'v2026.3', effectiveDate: '2026-10-22' },
};
```

- `version` は `LEGAL_VERSION_PATTERN` (`^[0-9A-Za-z._-]{1,20}$`) を満たす (`v2026.1` = 7 文字。`v2026.2`・`v2026.3` も 7 文字)。
- v1.17: 有料プランの販売 (#1912) が有料の条文を足し、両文書の版を `v2026.3` に上げた (billing/03 §11.6)。改定前の版 (`v2026.2`) の文面は `docs/legal/archive/v2026.2/` に控えた。`effectiveDate` は公開日の 2026-10-22 (§9.4 の 3)。
- 2 文書は**同時に**上げる (両方の内容が変わるため)。片方だけ上げると `getOutdatedLegalDocuments` がその片方だけを返し、同意画面の「改定あり」も片方だけに付く (仕組みとしては動くが、本書では両方)。
- ファイル先頭のコメント 17〜18 行目 (v2025.1 の「現在公開している文面 (最終更新日 2025年1月1日)」を指す仮置きの説明) は、「v2026.1 は #1901 (cross/20) で作り込んだ文面の版。弁護士の確認で文面を変えるときは、内容が変わるなら次の版 (v2026.2 など) に上げる」に書き換えた (事実の更新。帰属の文は書かない)。
- 施行日 (`effectiveDate`) は公開日。v2026.1 = 2026-10-19 (#1918 2ba5b3b3)・v2026.2 = 2026-10-21 (#1917)・v2026.3 = 2026-10-22 (#1930)。実装の間は仮の施行日と行末の目印のコメントで置き、migration の番号と同じくマージの直前にオーケストレーターが公開日に確定して目印を消した (§9.4 の 3)。施行日を YYYY-MM-DD の形の実在する日付にするのは、施行日の形を検査する既存の箇所がすべて通るようにするため: `packages/shared/src/legal-versions.test.ts` の「施行日は実在する日付の YYYY-MM-DD」(2 件)・`src/lib/legal-consent-api.ts:17, 32` の `EFFECTIVE_DATE_PATTERN` (形を外すと `src/app/api/legal/status/route.ts:50-52` の `safeParse` が失敗して 500 になり、`tests/api/legal-status-route.test.ts` と `tests/legal-consent-api-schema.test.ts` が赤になる)・`formatLegalEffectiveDate` (形を外すと値をそのまま返し、HTML の中で `<` が `&lt;` になって `tests/legal-consent-page.test.tsx:209` と `tests/policy-pages-public.test.tsx:60` の一致が外れる)。T-17 は施行日の値そのものを固定しない。

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
| 保護者の同意 | 利用規約・プライバシーポリシーの版上げの影響は無い。保護者の同意書は v1.14 (Q-27) で文を直して `PARENTAL_CONSENT_DOCUMENT` を v2026.2 に上げた。v2026.1 で記録した同意は失効しない (cross/14 S15) | `parental-consent.ts:34-45` |

### 9.3 以後の文面の直し方 (規律)

| 直し | 版 | 再同意 |
|---|---|---|
| 誤字・表現の整理・リンク先の修正など、内容が変わらない直し | 据え置く | 起きない |
| 利用目的・第三者提供・AI の扱い・保存期間・責任の範囲・未成年の扱いなど、内容が変わる直し | 上げる (`v2026.2` …。2 文書のうち内容が変わった方。両方なら両方) | 起きる |
| 弁護士の確認で文面を差し替える | 内容が変わるなら上げる | 同上 |
| AI 事業者を足す・外す | プライバシーポリシーの版を上げる。あわせて `AI_CONSENT_VERSION` も上げる (`ai-consent.ts:30-31` の規律) | 両方で起きる |
| 委託先を足す・外す | `PRIVACY_PROCESSORS` に足し、§13 の evidence を足し、プライバシーポリシーの版を上げる | 起きる |
| 有料プランの条文を足す (#1912) | §17 の #1912 の行のとおり両文書に足し、T-33 と主張の表を改め、両文書の版を上げる (v1.17: billing/03 §11 で `v2026.3`) | 起きる |
| 本文に文を足す | まず、その文が法令の事項か権利義務の約束かを確かめる (製品の操作の細部なら本文に足さない。R-28・§10.1)。足すなら主張の表の行と根拠も足す | 内容が変わるなら起きる |
| 外部送信の送り先を足す (CSP の `script-src`・`frame-src`・`img-src`・`connect-src` に外部のオリジンを足す・アプリの更新の取得 (EAS Update) を有効にするなど) | プライバシーポリシー第10条の表に行を足し、版を上げる (T-27 が EAS Update の有効化で赤になる) | 起きる |
| 版を上げる改定すべて | §9.4 の 2 (施行日の前のお知らせ) を必ず行う (v2026.1 の公開は除く。P-12・§9.4 の 2。v2026.2 (#1917・family/11) の公開も除く: オーナーの選択 (2026-10-21・選択式)「予告なしで今日公開」。ローンチ前で利用者がいないため。v2026.3 (#1912・billing/03 §11) の公開も除く: オーナーの選択 (2026-10-21・選択式)「予告なしで続けて公開」) | — |

### 9.4 公開の手順 (オーケストレーターの工程)

実装済み・公開済み (#1918 2ba5b3b3・2026-10-19)。v2026.1 の公開では 1〜6 を次のとおり行った: 弁護士の確認は受けずに公開した (確認の有無はオーナーの判断。§18)・2 のお知らせは行わない (P-12)・3 の施行日は公開日 2026-10-19 に確定し、目印のコメントは 0 行・公開の後の整合はゲート wf_1f7af830-226 で 2 枚とも PASS。以下は、次に版を上げるときにも使う手順。

1. 弁護士の確認 (任意。オーナーの判断) → 文面の差し替えがあれば §6・§7 を改定 (本書の改定版) → 実装に反映。
2. (v1.14: 今回は行わない。P-12 の公開の選択「予告なしで直し次第公開」による。ローンチ前で利用者がいないため。利用規約第24条 1 項とプライバシーポリシー第18条 1 項の「施行日の前にお知らせに掲載」は v2026.1 の本文が以後の改定について約束するもので、v2025.1 の本文にこの約束は無い (`docs/legal/archive/v2025.1/`)。v2026.2・v2026.3 の公開でも行わなかった (§9.3 の除外の行)。次に版を上げる改定からは行う) 公開日 (施行日) を決め、**公開日より前に**、運営画面のお知らせ (`/admin/announcements`。公開 (`is_public`) にすると Web とアプリのホームに出る。F-31) に改定の予告を載せる。載せる中身: 題「利用規約・プライバシーポリシーの改定のお知らせ」、本文に改定の概要 (§11.2 の「設計後」の要点: AI 機能の送る情報と事業者・委託先・保存期間・未成年・責任の範囲・凍結と退会)・施行日・施行日以後に同意をお願いすること・同意するまでの間は設定画面を使えないこと・同意の前でも開示等の請求・お問い合わせ・退会とデータの書き出し (同意画面の下の `/legal-consent/account`) ができること (利用規約第24条 2 項・プライバシーポリシー第13条 4 項。お知らせでも、お問い合わせによる削除は約束しない。F-40・P-12)。利用規約第24条 1 項とプライバシーポリシー第18条 1 項の「施行日の前にお知らせに掲載」はこの工程で守る (省くと公開した約束を破る)。メールでの一斉の知らせは仕組みが無いので行わず、文面もメールでの知らせを約束しない (F-34)。`/news` はコードの中の一覧で運営画面から載らないので使わない。
3. マージ直前: `effectiveDate` の仮の値を公開日 (JST の YYYY-MM-DD) に置き換え、行末の目印のコメント `// 仮置き: マージ直前に公開日へ置き換える` を消す (2 文書とも同じ日)。保護者の同意書の施行日 (`packages/shared/src/parental-consent.ts` の `PARENTAL_CONSENT_DOCUMENT.effectiveDate`。v1.14 で版を v2026.2 に上げ、同じ仮の値と目印を置いた) も同じ公開日に置き換える。`git grep -n '仮置き: マージ直前に公開日' -- packages/shared/src/legal-versions.ts packages/shared/src/parental-consent.ts` が 0 行になることを確かめる (公開日が仮の値と同じ日でも、目印は消す)。置き換えたあとに全件を流す。`docs/legal/archive/v2025.1/` の控えが PR に入っていることを確かめる。#1911 が main にマージされ、`src/lib/business-info.ts` に §8.3 が読む定数があることを確かめる (§14。v2026.1 の公開では #1916 4b1e1abe でマージ済み)。(2 のお知らせは今回は行わない。P-12。) **公開の前に解決しておく事項が解決していることを確かめる**: §17 の期日が「公開の前」の行 (同意しない人の画面 `declined` の、お問い合わせによる削除の約束・保護者の同意書と未成年の案内の、代わりに記録する機能と削除の依頼の約束) が直っていること、§18 の Q-23 (同意の前の退会の入口)・Q-27 (保護者の同意書) に結論が出て、その結論が画面・同意書・本書の文面に反映されていること (v1.14 で反映した。P-12・§14 段 C)。1 つでも残っていればマージ (公開) しない (版を上げた直後から、同意しない人に規約と食い違う約束を出し、規約の一部である個別規定に実装に無い約束が残るため)。
4. デプロイ (公開日)。デプロイの時点から再同意が始まる (施行日の前からは求めない: 施行日 = デプロイ日にする)。
5. 公開後の整合: `/terms` `/privacy` を未ログインで開いて、`LEGAL_DOCUMENTS` のいまの版 (`v2026.3`) と全文を確認。同意済みのテスト用アカウントで同意画面が出て「改定あり」が 2 つ付くこと、同意後に戻ること、アプリで WebView が出ることを確認。
6. ロールバックするときの注意: デプロイを戻すと `LEGAL_DOCUMENTS` も `v2025.1` に戻り、`v2026.1` に同意した人は「古い版 (v2025.1) に未同意」としてもう一度同意画面が出る。文面だけ戻したいときは、版を戻さずに文面モジュールだけ戻す (版の規律 §9.3)。

---

## 10. 主張の表 (本文の 1 文 = 1 行。根拠つき)

### 10.1 規則

- **主張の単位**: 本文の `ul` / `ol` の項目と `p` を「。」で分けた 1 文 (前後の空白を除き、空の文は数えない) と、`table` の 1 行 (セルを ` | ` でつないだもの)。`links`・`ai_providers`・`contact` のブロックは主張の単位にしない (リンク先・事業者の一覧・窓口の表示で、文を持たない。事業者の一覧は同意画面と同じ定数から出し、T-12 が固定する)。前文の節の名前は `terms-preamble` / `privacy-preamble`。
- **1 主張 = 1 行**: 単位ごとに §10.3 の `LEGAL_CLAIMS` の 1 行を持つ。`fragment` は、その単位の中にあって、同じ節のほかの単位には含まれない部分文字列 (テストの文脈の事業者の情報の値を含めない)。`chars` は、テストの文脈 (下) で描いた単位の文字数 (`String.prototype.length`)。
- **区分 (`basis`)**: `product` = 製品の挙動 (根拠は §2.2 の F-n・§0.1 の P-n・リポジトリのファイル [:行])。`contract` = 当社とユーザーの間の定め・お願い・免責・文書の参照 (製品の挙動でない)。`law` = 法令の定めの説明。`process` = 運営の工程・運用の約束 (根拠は本書の工程 §9.3・§9.4・運用の文書と、それを支える F-n)。
- **表に無い主張を本文に残さない**: T-35 が、本文の単位と表の行が 1 対 1 で対応し (各行の `fragment` を含む単位がその節にちょうど 1 つ、各単位を含む行がちょうど 1 つ)、`chars` が一致することを確かめる。文を足す・言い換える・消すと赤になる。直すときは、本書 §6・§7 の文と §10.3 の行 (根拠を確かめ直して) を同じ改定で直す。
- **本文の粒度** (v1.12・R-28): 本文は法令が求める事項と権利義務の約束だけを書くので、主張の表の行も、製品の操作の細部 (画面の名前・道順・機能の一覧・役割ごとの見え方) の行を持たない。v1.11 の 479 行から、細部と有料の条文を外して 383 行にした。文を足すときは、まずその文が法令の事項か権利義務の約束かを確かめる (細部なら本文に足さず、使い方ガイドやお問い合わせへの案内で足りる)。
- **テストの文脈**: `{ businessName: 'TESTCO', businessAddress: 'TESTADDRESS', businessRepresentative: 'TESTREP', phoneDisclosure: 'TESTPHONE', businessEmail: 'contact@example.com', businessHours: 'TESTHOURS', aiProviders: [] }`。事業者の情報は仮の値で描く (`src/lib/business-info.ts` の値が変わっても `chars` が動かないように)。数は `LEGAL_FACTS` の値で描く。
- **根拠の検査**: T-35 は、`product` と `process` の行の `evidence` が空でないこと、`evidence` の中の `F-<数>`・`P-<数>` が本書の §2.2・§0.1 の表の行 (`| F-<数> |`・`| P-<数> |`) にあること、`evidence` の中のファイルのパス (`src/`・`lib/`・`supabase/`・`packages/`・`apps/`・`tests/`・`docs/`・`.github/` で始まり拡張子で終わるもの。後ろの `:行` は除く) が実在することを確かめる。行番号そのものは検査しない (行がずれるため。本書の行番号は設計の検証の道具が確かめる)。

### 10.2 区分の数 (いまの全文)

| 文書 | product | contract | law | process | 計 |
|---|---|---|---|---|---|
| 利用規約 | 93 | 96 | 3 | 7 | 199 |
| プライバシーポリシー | 159 | 22 | 31 | 13 | 225 |
| 計 | 252 | 118 | 34 | 20 | 424 |

`LEGAL_CLAIM_COUNT` はこの表の計と同じ値。§6・§7 の文を変えたら、この表と §10.3 を作り直す。

### 10.3 正典: 主張の表 (`tests/legal-claims-1901.ts`。単独で型検査を通る)

```ts
// place=tests/legal-claims-1901.ts (新設。テストの道具のデータ。src から import しない)
/**
 * 利用規約・プライバシーポリシーの本文の主張の表 (#1901・設計書 cross/20 §10)。
 * 主張の単位は、本文の ul / ol の項目と p を「。」で分けた 1 文と、table の 1 行 (セルを ' | ' でつないだもの)。
 * fragment はその単位の中で、同じ節 (section) のほかの単位に含まれない部分文字列。chars はその単位の文字数 (String.prototype.length)。
 * tests/legal-text-1901.test.ts の T-35 が、本文の単位とこの表の行が 1 対 1 で対応し、字数が一致することを確かめる
 * (文を足す・変える・消すと赤になる。直すときは、この表の行と根拠 (evidence) を設計書 §10 と一緒に直す)。
 * basis: product = 製品の挙動 (evidence は F-n (設計書 §2.2)・P-n (同 §0.1)・リポジトリのファイル [:行])、
 *        contract = 当社とユーザーの間の定め・お願い・文書の参照、law = 法令の定めの説明、process = 運営の工程・運用の約束。
 */
export type LegalClaimBasis = 'product' | 'contract' | 'law' | 'process';

export interface LegalClaim {
  /** <section>#<節の中の通し番号> */
  readonly id: string;
  /** LegalSection.id (前文は terms-preamble / privacy-preamble) */
  readonly section: string;
  readonly fragment: string;
  readonly chars: number;
  readonly basis: LegalClaimBasis;
  /** 根拠。複数のときは「・」で区切る。product と process は空にしない */
  readonly evidence: string;
}

/** 主張の数 (宣言)。実列挙 (LEGAL_CLAIMS.length) と本文の単位の数の両方と一致する (T-35) */
export const LEGAL_CLAIM_COUNT = 424;

export const LEGAL_CLAIMS: readonly LegalClaim[] = [
  { id: 'terms-1#1', section: 'terms-1', fragment: 'この利用規約（以下「本規約」', chars: 118, basis: 'product', evidence: 'F-1・apps/mobile/app.json' },
  { id: 'terms-1#2', section: 'terms-1', fragment: '本サービスを利用するすべての', chars: 57, basis: 'contract', evidence: '契約の定め (民法 548 条の 2。§3.2)' },
  { id: 'terms-1#3', section: 'terms-1', fragment: '本規約は、民法に定める定型約', chars: 48, basis: 'contract', evidence: '契約の定め (民法 548 条の 2。§3.2)' },
  { id: 'terms-1#4', section: 'terms-1', fragment: '当社が本サービス上に掲載する', chars: 115, basis: 'contract', evidence: '契約の定め (民法 548 条の 2。§3.2)' },
  { id: 'terms-1#5', section: 'terms-1', fragment: '本規約と個別規定の内容が異な', chars: 28, basis: 'contract', evidence: '契約の定め (個別規定との優先関係。民法 548 条の 2。§3.2)' },
  { id: 'terms-1#6', section: 'terms-1', fragment: 'ただし、個人情報の取扱いに関', chars: 52, basis: 'contract', evidence: '契約の定め (個別規定との優先関係。民法 548 条の 2。§3.2)' },
  { id: 'terms-2#1', section: 'terms-2', fragment: '本規約で使う用語の意味は、次', chars: 20, basis: 'contract', evidence: '用語の定めと文書の参照' },
  { id: 'terms-2#2', section: 'terms-2', fragment: '「登録情報」: ユーザーが本', chars: 75, basis: 'product', evidence: 'F-22・F-42' },
  { id: 'terms-2#3', section: 'terms-2', fragment: '「ユーザーコンテンツ」: ユ', chars: 58, basis: 'product', evidence: 'F-42・F-44・F-52' },
  { id: 'terms-2#4', section: 'terms-2', fragment: '「AI 機能」: 写真の読み', chars: 55, basis: 'product', evidence: 'F-8・F-29' },
  { id: 'terms-2#5', section: 'terms-2', fragment: '「AI 事業者」: AI 機', chars: 44, basis: 'product', evidence: 'F-8' },
  { id: 'terms-2#6', section: 'terms-2', fragment: '一覧はプライバシーポリシーに', chars: 19, basis: 'contract', evidence: '用語の定めと文書の参照' },
  { id: 'terms-2#7', section: 'terms-2', fragment: '「家族グループ」: 複数のユ', chars: 51, basis: 'product', evidence: 'F-18・F-49' },
  { id: 'terms-2#8', section: 'terms-2', fragment: '「組織」: 企業・団体が、そ', chars: 49, basis: 'product', evidence: 'F-19' },
  { id: 'terms-2#9', section: 'terms-2', fragment: '「保護者」: 18 歳未満の', chars: 35, basis: 'law', evidence: '民法 818 条・824 条 (法定代理人)' },
  { id: 'terms-3#1', section: 'terms-3', fragment: '登録を希望する方は、本規約と', chars: 51, basis: 'product', evidence: 'src/app/(auth)/login/page.tsx:78-83・F-5' },
  { id: 'terms-3#2', section: 'terms-3', fragment: '登録のとき、またはその後に初', chars: 41, basis: 'product', evidence: 'F-50・packages/shared/src/parental-consent.ts:129' },
  { id: 'terms-3#3', section: 'terms-3', fragment: '生年月日は年齢の確認のために', chars: 36, basis: 'product', evidence: 'packages/shared/src/parental-consent.ts:129・F-50' },
  { id: 'terms-3#4', section: 'terms-3', fragment: '誤って登録した場合はお問い合', chars: 25, basis: 'product', evidence: 'packages/shared/src/parental-consent.ts:129' },
  { id: 'terms-3#5', section: 'terms-3', fragment: '18 歳未満の方は、ご自身で', chars: 22, basis: 'product', evidence: 'F-10・F-50' },
  { id: 'terms-3#6', section: 'terms-3', fragment: '13 歳以上 18 歳未満の', chars: 38, basis: 'product', evidence: 'F-10' },
  { id: 'terms-3#7', section: 'terms-3', fragment: '13 歳未満の方の本人名義の', chars: 27, basis: 'product', evidence: 'F-10' },
  { id: 'terms-3#8', section: 'terms-3', fragment: '当社は、登録を希望する方が次', chars: 63, basis: 'contract', evidence: '契約の定め (登録の拒否)' },
  { id: 'terms-3#9', section: 'terms-3', fragment: '当社は、その理由を開示する義', chars: 21, basis: 'contract', evidence: '契約の定め (登録の拒否)' },
  { id: 'terms-3#10', section: 'terms-3', fragment: '申告した内容に虚偽、誤り、ま', chars: 26, basis: 'contract', evidence: '契約の定め (登録の拒否)' },
  { id: 'terms-3#11', section: 'terms-3', fragment: '過去に本規約に違反してアカウ', chars: 39, basis: 'contract', evidence: '契約の定め (登録の拒否)' },
  { id: 'terms-3#12', section: 'terms-3', fragment: '暴力団、暴力団員、その他の反', chars: 38, basis: 'contract', evidence: '契約の定め (登録の拒否)' },
  { id: 'terms-3#13', section: 'terms-3', fragment: 'その他、当社が登録を適当でな', chars: 22, basis: 'contract', evidence: '契約の定め (登録の拒否)' },
  { id: 'terms-4#1', section: 'terms-4', fragment: 'ユーザーは、自己の責任で、メ', chars: 82, basis: 'contract', evidence: '契約の定め (アカウントの管理・責任。消費者契約法 8 条の範囲。§3.2)' },
  { id: 'terms-4#2', section: 'terms-4', fragment: 'ログインに用いる手段が第三者', chars: 70, basis: 'contract', evidence: '契約の定め (アカウントの管理・責任。消費者契約法 8 条の範囲。§3.2)' },
  { id: 'terms-5#1', section: 'terms-5', fragment: '13 歳以上 18 歳未満の', chars: 86, basis: 'product', evidence: 'F-10・F-38' },
  { id: 'terms-5#2', section: 'terms-5', fragment: '保護者の同意は、本規約とプラ', chars: 33, basis: 'contract', evidence: '契約の定め (保護者の同意の範囲。§18 Q-1)' },
  { id: 'terms-5#3', section: 'terms-5', fragment: 'の家族グループにつながった未', chars: 85, basis: 'product', evidence: 'F-33・F-49' },
  { id: 'terms-5#4', section: 'terms-5', fragment: '保護者の同意とのつながりが無', chars: 86, basis: 'product', evidence: 'F-10・F-38・src/app/legal-consent/account/page.tsx・packages/shared/src/legal-consent-api.ts' },
  { id: 'terms-5#5', section: 'terms-5', fragment: '未成年者が保護者の同意を得ず', chars: 60, basis: 'law', evidence: '民法 5 条 2 項・120 条' },
  { id: 'terms-6#1', section: 'terms-6', fragment: '本サービスは、食事や健康の記', chars: 69, basis: 'product', evidence: 'F-8・F-18・F-19・F-42' },
  { id: 'terms-6#2', section: 'terms-6', fragment: '各機能の内容と使い方は、本サ', chars: 34, basis: 'product', evidence: 'F-58' },
  { id: 'terms-6#3', section: 'terms-6', fragment: '本サービスの機能の内容は、第', chars: 31, basis: 'contract', evidence: '第18条の参照' },
  { id: 'terms-7#1', section: 'terms-7', fragment: 'AI 機能は、ユーザーが入力', chars: 85, basis: 'product', evidence: 'F-8・F-29・F-43' },
  { id: 'terms-7#2', section: 'terms-7', fragment: 'AI 機能を利用するには、あ', chars: 85, basis: 'product', evidence: 'F-8' },
  { id: 'terms-7#3', section: 'terms-7', fragment: '同意しない場合、AI 機能は', chars: 43, basis: 'product', evidence: 'F-8' },
  { id: 'terms-7#4', section: 'terms-7', fragment: '同意は、本サービスの画面から', chars: 24, basis: 'product', evidence: 'F-8・src/app/api/ai/consent/revoke/route.ts' },
  { id: 'terms-7#5', section: 'terms-7', fragment: '撤回すると、AI 機能は利用', chars: 22, basis: 'product', evidence: 'F-8' },
  { id: 'terms-7#6', section: 'terms-7', fragment: 'もう一度利用するには、改めて', chars: 21, basis: 'product', evidence: 'F-8' },
  { id: 'terms-7#7', section: 'terms-7', fragment: '同意が無い間は、自動で行う', chars: 26, basis: 'product', evidence: 'F-8・src/app/api/cron/process-menu-queue/route.ts:60-64' },
  { id: 'terms-7#8', section: 'terms-7', fragment: 'AI 機能の結果（料理名、分', chars: 49, basis: 'contract', evidence: '契約の定め (AI の結果の扱い・入力の禁止)' },
  { id: 'terms-7#9', section: 'terms-7', fragment: '当社は、その正確性、完全性、', chars: 24, basis: 'contract', evidence: '契約の定め (AI の結果の扱い・入力の禁止)' },
  { id: 'terms-7#10', section: 'terms-7', fragment: '写真からの読み取りや栄養の推', chars: 31, basis: 'contract', evidence: '免責の説明 (推定の限界。§3.2 消費者契約法)' },
  { id: 'terms-7#11', section: 'terms-7', fragment: 'ユーザーは、結果を自分で確認', chars: 29, basis: 'contract', evidence: '契約の定め (AI の結果の扱い・入力の禁止)' },
  { id: 'terms-7#12', section: 'terms-7', fragment: 'AI 機能の結果を、医療や健', chars: 40, basis: 'contract', evidence: '契約の定め (AI の結果の扱い・入力の禁止)' },
  { id: 'terms-7#13', section: 'terms-7', fragment: 'ユーザーは、AI 機能に対し', chars: 73, basis: 'contract', evidence: '契約の定め (AI の結果の扱い・入力の禁止)' },
  { id: 'terms-8#1', section: 'terms-8', fragment: 'AI 機能には、1 日にご利', chars: 30, basis: 'product', evidence: 'F-9' },
  { id: 'terms-8#2', section: 'terms-8', fragment: '上限に達した日は、日本時間の', chars: 33, basis: 'product', evidence: 'F-9' },
  { id: 'terms-8#3', section: 'terms-8', fragment: '上限の回数は当社が定め、上限', chars: 29, basis: 'product', evidence: 'F-9' },
  { id: 'terms-9#1', section: 'terms-9', fragment: 'ほめゴハンは食事管理を支援す', chars: 47, basis: 'contract', evidence: 'cross/08 §8.1 の医療免責の文 (T-9)' },
  { id: 'terms-9#2', section: 'terms-9', fragment: '本サービスが示す栄養の数値、', chars: 94, basis: 'contract', evidence: '免責と注意の定め (薬機法・健康増進法。§3.2)' },
  { id: 'terms-9#3', section: 'terms-9', fragment: '当社は、本サービスの利用によ', chars: 28, basis: 'contract', evidence: '免責と注意の定め (薬機法・健康増進法。§3.2)' },
  { id: 'terms-9#4', section: 'terms-9', fragment: '通院中・服薬中・妊娠中・授乳', chars: 87, basis: 'contract', evidence: '免責と注意の定め (薬機法・健康増進法。§3.2)' },
  { id: 'terms-9#5', section: 'terms-9', fragment: '緊急の症状がある場合は、すぐ', chars: 38, basis: 'contract', evidence: '免責と注意の定め (薬機法・健康増進法。§3.2)' },
  { id: 'terms-9#6', section: 'terms-9', fragment: '本サービスは医療行為を行いま', chars: 16, basis: 'contract', evidence: '免責と注意の定め (薬機法・健康増進法。§3.2)' },
  { id: 'terms-10#1', section: 'terms-10', fragment: '本サービスは、無料で利用でき', chars: 16, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.6 の無料プラン)' },
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
  { id: 'terms-11#1', section: 'terms-11', fragment: '18 歳以上のユーザーは、家', chars: 70, basis: 'product', evidence: 'F-38・docs/design/billing/03-paid-plans-and-iap.md (§6.6)' },
  { id: 'terms-11#2', section: 'terms-11', fragment: '家族グループを作成したユーザ', chars: 24, basis: 'product', evidence: 'F-38' },
  { id: 'terms-11#3', section: 'terms-11', fragment: '各メンバーは、自分の記録を家', chars: 38, basis: 'product', evidence: 'F-18・src/app/api/family/members/me/share/route.ts' },
  { id: 'terms-11#4', section: 'terms-11', fragment: '家族グループの中で誰に何が表', chars: 40, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー第9条)' },
  { id: 'terms-11#5', section: 'terms-11', fragment: '18 歳未満の子どもを家族グ', chars: 79, basis: 'product', evidence: 'F-30・F-33' },
  { id: 'terms-11#6', section: 'terms-11', fragment: '代表者以外のメンバーは、家族', chars: 26, basis: 'product', evidence: 'F-38' },
  { id: 'terms-11#7', section: 'terms-11', fragment: '代表者は、代表者をほかのメン', chars: 65, basis: 'product', evidence: 'F-38・F-59' },
  { id: 'terms-11#8', section: 'terms-11', fragment: '家族グループの解散は、代表者', chars: 52, basis: 'product', evidence: 'F-59' },
  { id: 'terms-11#9', section: 'terms-11', fragment: '代表者が長期間ログインしてい', chars: 79, basis: 'product', evidence: 'F-21・F-39' },
  { id: 'terms-11#10', section: 'terms-11', fragment: '解散した家族グループの情報の', chars: 38, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー第12条。F-53)' },
  { id: 'terms-12#1', section: 'terms-12', fragment: '組織の管理者は、メンバーの招', chars: 23, basis: 'product', evidence: 'F-19' },
  { id: 'terms-12#2', section: 'terms-12', fragment: '組織の管理者に表示される情報', chars: 35, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー第9条)' },
  { id: 'terms-12#3', section: 'terms-12', fragment: '組織の管理者は、組織に所属す', chars: 51, basis: 'product', evidence: 'F-19' },
  { id: 'terms-12#4', section: 'terms-12', fragment: '組織のチャレンジへの参加は任', chars: 17, basis: 'product', evidence: 'F-19' },
  { id: 'terms-12#5', section: 'terms-12', fragment: '組織のオーナーは、オーナーを', chars: 48, basis: 'product', evidence: 'F-59' },
  { id: 'terms-12#6', section: 'terms-12', fragment: '組織の解散は、オーナーが本サ', chars: 49, basis: 'product', evidence: 'F-59' },
  { id: 'terms-12#7', section: 'terms-12', fragment: 'オーナーが長期間ログインして', chars: 55, basis: 'product', evidence: 'F-21・F-39' },
  { id: 'terms-12#8', section: 'terms-12', fragment: '組織を退出し、または組織から', chars: 51, basis: 'product', evidence: 'src/app/api/org/leave/route.ts・src/app/api/org/members/[user_id]/remove/route.ts' },
  { id: 'terms-13#1', section: 'terms-13', fragment: '本サービスに保存した食事と冷', chars: 61, basis: 'product', evidence: 'F-33・F-52' },
  { id: 'terms-13#2', section: 'terms-13', fragment: 'ただし、当社の運営担当者は、', chars: 72, basis: 'product', evidence: 'F-33・F-41' },
  { id: 'terms-13#3', section: 'terms-13', fragment: 'ユーザーが公開の状態にしたユ', chars: 53, basis: 'product', evidence: 'F-54' },
  { id: 'terms-13#4', section: 'terms-13', fragment: 'ユーザーは、自分のユーザーコ', chars: 79, basis: 'contract', evidence: '契約の定め (権利の保証・非表示の措置)' },
  { id: 'terms-13#5', section: 'terms-13', fragment: '当社は、本規約に違反し、また', chars: 57, basis: 'contract', evidence: '契約の定め (権利の保証・非表示の措置)' },
  { id: 'terms-13#6', section: 'terms-13', fragment: '非表示にしたコンテンツの保存', chars: 39, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー第12条)' },
  { id: 'terms-13#7', section: 'terms-13', fragment: '不適切なコンテンツを見つけた', chars: 33, basis: 'product', evidence: 'F-24 (通報の機能は無い)' },
  { id: 'terms-14#1', section: 'terms-14', fragment: '本サービスを構成するプログラ', chars: 76, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-14#2', section: 'terms-14', fragment: 'ユーザーコンテンツの著作権は', chars: 26, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-14#3', section: 'terms-14', fragment: '当社は、本サービスの提供、改', chars: 76, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-14#4', section: 'terms-14', fragment: 'AI 機能が生成した献立、レ', chars: 65, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-14#5', section: 'terms-14', fragment: '当社は、個人を特定できない集', chars: 48, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-14#6', section: 'terms-14', fragment: 'ユーザーが本サービスに投稿し', chars: 91, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-14#7', section: 'terms-14', fragment: 'ユーザーは、当社の許諾なく、', chars: 65, basis: 'contract', evidence: '契約の定め (cross/08 §14 の AI 生成物の著作権 3 項)' },
  { id: 'terms-15#1', section: 'terms-15', fragment: 'ユーザーは、本サービスの利用', chars: 32, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#2', section: 'terms-15', fragment: '法令または公序良俗に違反する', chars: 28, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#3', section: 'terms-15', fragment: '当社、他のユーザー、その他の', chars: 55, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#4', section: 'terms-15', fragment: '他人になりすます行為、虚偽の', chars: 46, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#5', section: 'terms-15', fragment: '本人または保護者の了解なく、', chars: 43, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#6', section: 'terms-15', fragment: '他のユーザーの個人情報、投稿', chars: 37, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#7', section: 'terms-15', fragment: '不正アクセス、パスワードの推', chars: 59, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#8', section: 'terms-15', fragment: 'スクレイピング、自動化された', chars: 63, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#9', section: 'terms-15', fragment: 'AI 機能に対し、有害な内容', chars: 63, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#10', section: 'terms-15', fragment: '営利を目的として本サービスを', chars: 49, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#11', section: 'terms-15', fragment: '他のユーザーへの嫌がらせ、差', chars: 47, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#12', section: 'terms-15', fragment: '本サービスの運営を妨害する行', chars: 44, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#13', section: 'terms-15', fragment: '反社会的勢力への利益供与、そ', chars: 32, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-15#14', section: 'terms-15', fragment: 'その他、当社が不適切と判断す', chars: 17, basis: 'contract', evidence: '契約の定め (禁止事項)' },
  { id: 'terms-16#1', section: 'terms-16', fragment: '当社は、ユーザーが本規約に違', chars: 103, basis: 'contract', evidence: '契約の定め (措置・責任の範囲。§3.2)' },
  { id: 'terms-16#2', section: 'terms-16', fragment: '凍結中は、本サービスの機能を', chars: 21, basis: 'product', evidence: 'F-28' },
  { id: 'terms-16#3', section: 'terms-16', fragment: 'ただし、凍結中でも、データの', chars: 50, basis: 'product', evidence: 'F-12・F-20' },
  { id: 'terms-16#4', section: 'terms-16', fragment: '一時的な凍結は、当社が定めた', chars: 35, basis: 'product', evidence: 'F-20・src/lib/auth/frozen.ts:10-31' },
  { id: 'terms-16#5', section: 'terms-16', fragment: '凍結に心当たりがない場合や、', chars: 41, basis: 'product', evidence: 'F-12 (お問い合わせは凍結中も送れる)' },
  { id: 'terms-16#6', section: 'terms-16', fragment: '当社は、凍結の判断の根拠とな', chars: 47, basis: 'contract', evidence: '契約の定め (措置・責任の範囲。§3.2)' },
  { id: 'terms-16#7', section: 'terms-16', fragment: '本条の措置によりユーザーに生', chars: 57, basis: 'contract', evidence: '契約の定め (措置・責任の範囲。§3.2)' },
  { id: 'terms-17#1', section: 'terms-17', fragment: 'ユーザーは、本サービスの画面', chars: 40, basis: 'product', evidence: 'F-11・F-12' },
  { id: 'terms-17#2', section: 'terms-17', fragment: '退会すると、アカウントと、ア', chars: 48, basis: 'product', evidence: 'F-11' },
  { id: 'terms-17#3', section: 'terms-17', fragment: '削除の前に、データを書き出す', chars: 21, basis: 'product', evidence: 'F-12' },
  { id: 'terms-17#4', section: 'terms-17', fragment: '本規約またはプライバシーポリ', chars: 63, basis: 'product', evidence: 'src/app/legal-consent/account/page.tsx・packages/shared/src/legal-consent-api.ts' },
  { id: 'terms-17#5', section: 'terms-17', fragment: '組織のオーナーと家族グループ', chars: 81, basis: 'product', evidence: 'F-59' },
  { id: 'terms-17#6', section: 'terms-17', fragment: '退会後も残る情報と、その保存', chars: 39, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー第12条)' },
  { id: 'terms-17#7', section: 'terms-17', fragment: '退会後に再び本サービスを利用', chars: 33, basis: 'product', evidence: 'F-11' },
  { id: 'terms-17#8', section: 'terms-17', fragment: '削除したデータは復元できませ', chars: 15, basis: 'product', evidence: 'F-11' },
  { id: 'terms-17#9', section: 'terms-17', fragment: 'App Store または ', chars: 51, basis: 'product', evidence: 'src/lib/billing/account-deletion.ts・docs/design/billing/03-paid-plans-and-iap.md (§7.1 の退会の行)' },
  { id: 'terms-17#10', section: 'terms-17', fragment: '退会の前に、各ストアの定期購', chars: 28, basis: 'contract', evidence: '契約の定め (ストアでの解約のお願い)' },
  { id: 'terms-17#11', section: 'terms-17', fragment: 'Web で申し込んだ有料プラ', chars: 32, basis: 'product', evidence: 'src/lib/billing/account-deletion.ts・F-11' },
  { id: 'terms-18#1', section: 'terms-18', fragment: '当社は、本サービスの内容を変', chars: 33, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#2', section: 'terms-18', fragment: 'ユーザーの利用に大きな影響が', chars: 42, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#3', section: 'terms-18', fragment: '当社は、次の場合、事前に通知', chars: 53, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#4', section: 'terms-18', fragment: '（a）システムの保守・点検・', chars: 21, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#5', section: 'terms-18', fragment: '（b）地震、火災、停電、通信', chars: 34, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#6', section: 'terms-18', fragment: '（c）当社が利用するクラウド', chars: 46, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#7', section: 'terms-18', fragment: '（d）不正アクセスやその他の', chars: 29, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#8', section: 'terms-18', fragment: '（e）その他、当社がやむを得', chars: 23, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#9', section: 'terms-18', fragment: '保守などで計画的に中断すると', chars: 35, basis: 'product', evidence: 'F-28・lib/supabase/middleware.ts:111-113' },
  { id: 'terms-18#10', section: 'terms-18', fragment: '当社は、本サービスの全部の提', chars: 27, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#11', section: 'terms-18', fragment: 'その場合、できる限り事前に本', chars: 51, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-18#12', section: 'terms-18', fragment: '本条に基づく変更、中断、終了', chars: 66, basis: 'contract', evidence: '契約の定め (変更・中断・終了・責任の範囲。§3.2)' },
  { id: 'terms-19#1', section: 'terms-19', fragment: '当社からユーザーへの連絡は、', chars: 62, basis: 'product', evidence: 'F-31・F-34' },
  { id: 'terms-19#2', section: 'terms-19', fragment: 'ユーザーは、登録するメールア', chars: 35, basis: 'contract', evidence: '契約の定め (連絡先の維持)' },
  { id: 'terms-19#3', section: 'terms-19', fragment: 'プッシュ通知は、本サービスの', chars: 35, basis: 'product', evidence: 'F-34' },
  { id: 'terms-19#4', section: 'terms-19', fragment: '止めている間も、本規約やプラ', chars: 60, basis: 'product', evidence: 'F-5・F-31' },
  { id: 'terms-20#1', section: 'terms-20', fragment: '当社は、本サービスが、ユーザ', chars: 79, basis: 'contract', evidence: '契約の定め (保証の否認。§3.2)' },
  { id: 'terms-20#2', section: 'terms-20', fragment: '当社は、本サービスに関して、', chars: 64, basis: 'contract', evidence: '契約の定め (保証の否認。§3.2)' },
  { id: 'terms-20#3', section: 'terms-20', fragment: '当社は、本サービスのデータの', chars: 55, basis: 'product', evidence: 'F-11 (cross/17)' },
  { id: 'terms-20#4', section: 'terms-20', fragment: '大切なデータは、データの書き', chars: 33, basis: 'contract', evidence: '契約の定め (保証の否認。§3.2)' },
  { id: 'terms-21#1', section: 'terms-21', fragment: '当社は、本サービスに関してユ', chars: 111, basis: 'contract', evidence: '契約の定め (消費者契約法 8 条の範囲の責任の制限。§3.2・R-4)' },
  { id: 'terms-21#2', section: 'terms-21', fragment: '本条および本規約の他の条項に', chars: 53, basis: 'contract', evidence: '契約の定め (消費者契約法 8 条の範囲の責任の制限。§3.2・R-4)' },
  { id: 'terms-21#3', section: 'terms-21', fragment: 'また、消費者契約法その他の強', chars: 57, basis: 'contract', evidence: '契約の定め (消費者契約法 8 条の範囲の責任の制限。§3.2・R-4)' },
  { id: 'terms-22#1', section: 'terms-22', fragment: 'ユーザーは、本規約に違反して', chars: 42, basis: 'contract', evidence: '契約の定め (ユーザーの責任)' },
  { id: 'terms-22#2', section: 'terms-22', fragment: 'ユーザーが本サービスの利用に', chars: 94, basis: 'contract', evidence: '契約の定め (ユーザーの責任)' },
  { id: 'terms-23#1', section: 'terms-23', fragment: '当社は、ユーザーの個人情報を', chars: 35, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー・AI の同意・保護者の同意書)' },
  { id: 'terms-23#2', section: 'terms-23', fragment: 'AI 機能のための日本国外の', chars: 44, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー・AI の同意・保護者の同意書)' },
  { id: 'terms-23#3', section: 'terms-23', fragment: '未成年者の情報の取扱いは、保', chars: 26, basis: 'contract', evidence: '文書の参照 (プライバシーポリシー・AI の同意・保護者の同意書)' },
  { id: 'terms-24#1', section: 'terms-24', fragment: '当社は、本規約を変更すること', chars: 19, basis: 'contract', evidence: '契約の定め (民法 548 条の 4 を使わない。§18 Q-19)' },
  { id: 'terms-24#2', section: 'terms-24', fragment: '内容が変わる変更は、次項のと', chars: 70, basis: 'product', evidence: 'F-5・§9.2' },
  { id: 'terms-24#3', section: 'terms-24', fragment: '当社は、変更の概要と施行日を', chars: 37, basis: 'process', evidence: '§9.4 の 2・F-31' },
  { id: 'terms-24#4', section: 'terms-24', fragment: '本規約またはプライバシーポリ', chars: 79, basis: 'product', evidence: 'F-5・§9.2' },
  { id: 'terms-24#5', section: 'terms-24', fragment: '同意するまでの間は、本サービ', chars: 46, basis: 'product', evidence: 'F-5・F-28・F-32' },
  { id: 'terms-24#6', section: 'terms-24', fragment: 'ただし、個人情報の開示・訂正', chars: 63, basis: 'product', evidence: 'F-32・src/app/legal-consent/account/page.tsx・packages/shared/src/legal-consent-api.ts' },
  { id: 'terms-24#7', section: 'terms-24', fragment: '誤字の修正や表現の整理など、', chars: 53, basis: 'process', evidence: '§9.3' },
  { id: 'terms-24#8', section: 'terms-24', fragment: '各文書の版と施行日は、その文', chars: 28, basis: 'product', evidence: 'F-3' },
  { id: 'terms-24#9', section: 'terms-24', fragment: '改定前の版は当社が保管し、お', chars: 28, basis: 'process', evidence: '§9.4・docs/legal/archive (段 B で作る)' },
  { id: 'terms-24#10', section: 'terms-24', fragment: '改定の後、改めて同意するまで', chars: 30, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.5 Q-15)・packages/shared/src/legal-consent-api.ts' },
  { id: 'terms-24#11', section: 'terms-24', fragment: 'App Store または ', chars: 59, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.5 Q-15)' },
  { id: 'terms-24#12', section: 'terms-24', fragment: 'Web で申し込んだ有料プラ', chars: 47, basis: 'process', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§0.5 Q-15)・F-28' },
  { id: 'terms-25#1', section: 'terms-25', fragment: 'ユーザーは、当社の書面による', chars: 62, basis: 'contract', evidence: '契約の定め (譲渡の禁止・事業の承継)' },
  { id: 'terms-25#2', section: 'terms-25', fragment: '当社が本サービスの事業を第三', chars: 74, basis: 'contract', evidence: '契約の定め (譲渡の禁止・事業の承継)' },
  { id: 'terms-26#1', section: 'terms-26', fragment: '本規約のいずれかの条項または', chars: 107, basis: 'contract', evidence: '契約の定め (分離可能性)' },
  { id: 'terms-27#1', section: 'terms-27', fragment: '本規約の準拠法は日本法としま', chars: 15, basis: 'contract', evidence: '契約の定め (準拠法)' },
  { id: 'terms-27#2', section: 'terms-27', fragment: '本サービスに関して当社とユー', chars: 66, basis: 'contract', evidence: '契約の定め (管轄。§18 Q-7)' },
  { id: 'terms-28#1', section: 'terms-28', fragment: '本規約に関するお問い合わせは', chars: 42, basis: 'product', evidence: 'F-56・P-10・src/app/contact/page.tsx' },
  { id: 'terms-supplementary#1', section: 'terms-supplementary', fragment: '本規約は、このページの冒頭に', chars: 28, basis: 'contract', evidence: '契約の定め (施行日)' },
  { id: 'terms-supplementary#2', section: 'terms-supplementary', fragment: '改定の履歴は、版と施行日の表', chars: 20, basis: 'product', evidence: 'F-3' },
  { id: 'privacy-preamble#1', section: 'privacy-preamble', fragment: '（以下「当社」といいます）は', chars: 211, basis: 'contract', evidence: '文書の目的 (個人情報保護法・PPC ガイドライン。§3)' },
  { id: 'privacy-1#1', section: 'privacy-1', fragment: '事業者の名称 |', chars: 15, basis: 'product', evidence: 'F-4' },
  { id: 'privacy-1#2', section: 'privacy-1', fragment: '所在地 |', chars: 17, basis: 'product', evidence: 'F-56・P-10' },
  { id: 'privacy-1#3', section: 'privacy-1', fragment: '代表者 |', chars: 13, basis: 'product', evidence: 'F-4' },
  { id: 'privacy-1#4', section: 'privacy-1', fragment: 'またはお問い合わせフォーム', chars: 64, basis: 'product', evidence: 'F-56・P-10' },
  { id: 'privacy-1#5', section: 'privacy-1', fragment: 'メールアドレス |', chars: 29, basis: 'product', evidence: 'F-56・P-10' },
  { id: 'privacy-1#6', section: 'privacy-1', fragment: '営業時間 |', chars: 16, basis: 'product', evidence: 'F-56・P-10' },
  { id: 'privacy-2#1', section: 'privacy-2', fragment: '「個人情報」: 個人情報保護', chars: 30, basis: 'law', evidence: '個人情報保護法 2 条・16 条の定義' },
  { id: 'privacy-2#2', section: 'privacy-2', fragment: '生存する個人に関する情報で、', chars: 74, basis: 'law', evidence: '個人情報保護法 2 条・16 条の定義' },
  { id: 'privacy-2#3', section: 'privacy-2', fragment: '「個人データ」「保有個人デー', chars: 43, basis: 'law', evidence: '個人情報保護法 2 条・16 条の定義' },
  { id: 'privacy-2#4', section: 'privacy-2', fragment: '本サービスのデータベースに記', chars: 41, basis: 'law', evidence: '個人情報保護法 16 条 3 項・4 項' },
  { id: 'privacy-2#5', section: 'privacy-2', fragment: '「要配慮個人情報」: 個人情', chars: 31, basis: 'law', evidence: '個人情報保護法 2 条・16 条の定義' },
  { id: 'privacy-2#6', section: 'privacy-2', fragment: '本サービスでは、健康診断や血', chars: 57, basis: 'product', evidence: 'F-22・F-42' },
  { id: 'privacy-2#7', section: 'privacy-2', fragment: '「ユーザー」「ユーザーコンテ', chars: 66, basis: 'law', evidence: '個人情報保護法 2 条・16 条の定義' },
  { id: 'privacy-3#1', section: 'privacy-3', fragment: '当社は、本サービスの提供のた', chars: 27, basis: 'contract', evidence: '列挙の導入' },
  { id: 'privacy-3#2', section: 'privacy-3', fragment: 'ユーザーが入力・撮影・アップ', chars: 56, basis: 'product', evidence: 'F-42' },
  { id: 'privacy-3#3', section: 'privacy-3', fragment: 'アカウント | メールアドレ', chars: 92, basis: 'product', evidence: 'F-42 (user_profiles・password_history・personal_subscriptions)・F-46・F-50・F-57・src/app/(auth)/login/page.tsx:78-83' },
  { id: 'privacy-3#4', section: 'privacy-3', fragment: 'プロフィール | 身長・体重', chars: 83, basis: 'product', evidence: 'F-22・F-42 (user_profiles・nutrition_targets)' },
  { id: 'privacy-3#5', section: 'privacy-3', fragment: '食事と献立 | 食事の写真と', chars: 68, basis: 'product', evidence: 'F-42 (meals・meal_ai_feedbacks・meal_nutrition_estimates・user_daily_meals・planned_meals・weekly_menus・weekly_menu_requests・pantry_items・shopping_lists・shopping_list_items・shopping_list_requests・meal_image_jobs・nutrition_feedback_cache・derived_recipes)・F-52' },
  { id: 'privacy-3#6', section: 'privacy-3', fragment: 'レシピ | いいねや保存をし', chars: 36, basis: 'product', evidence: 'F-42 (recipes・recipe_collections・recipe_collection_items・recipe_likes・recipe_comments)・F-54' },
  { id: 'privacy-3#7', section: 'privacy-3', fragment: '健康 | 体重・血圧などの健', chars: 76, basis: 'product', evidence: 'F-22・F-42 (health_records・health_goals・health_checkups・health_checkup_longitudinal_reviews・blood_test_results・blood_test_longitudinal_reviews・health_insights)' },
  { id: 'privacy-3#8', section: 'privacy-3', fragment: '毎日のコンディション | 体', chars: 53, basis: 'product', evidence: 'F-44' },
  { id: 'privacy-3#9', section: 'privacy-3', fragment: 'AI 相談 | 相談の文章、', chars: 42, basis: 'product', evidence: 'F-42 (ai_consultation_sessions・ai_consultation_messages・ai_action_logs)・F-43' },
  { id: 'privacy-3#10', section: 'privacy-3', fragment: '記録の継続と比較 | 記録の', chars: 62, basis: 'product', evidence: 'F-45・F-42 (health_streaks・health_challenges・user_badges・user_badge_period_awards・user_metrics・user_segment_rankings)' },
  { id: 'privacy-3#11', section: 'privacy-3', fragment: '家族グループ | 家族グルー', chars: 77, basis: 'product', evidence: 'F-38・F-42 (family_members・family_groups・family_invites・family_promotion_requests・ownership_transfer_proposals)' },
  { id: 'privacy-3#12', section: 'privacy-3', fragment: '組織 | 所属する組織と組織', chars: 51, basis: 'product', evidence: 'F-19・F-42 (organizations・organization_challenge_participants・organization_challenge_ranking_exclusions)' },
  { id: 'privacy-3#13', section: 'privacy-3', fragment: 'お問い合わせ・サポート・請求', chars: 60, basis: 'product', evidence: 'F-36・F-42 (inquiries・support_tickets・support_ticket_messages・data_subject_requests)' },
  { id: 'privacy-3#14', section: 'privacy-3', fragment: '同意の記録 | 利用規約とプ', chars: 146, basis: 'product', evidence: 'F-17・F-26・F-30・F-37' },
  { id: 'privacy-3#15', section: 'privacy-3', fragment: '端末・利用状況・ログ | I', chars: 183, basis: 'product', evidence: 'F-17・F-37・F-46・F-42 (user_sessions_metadata・user_push_tokens・native_bridge_codes・notification_preferences・app_logs・ai_usage_counters・ai_usage_grant_claims・llm_usage_logs・email_outbox・push_outbox・experiment_assignments)' },
  { id: 'privacy-3#16', section: 'privacy-3', fragment: '運営の記録 | 運営担当者が', chars: 65, basis: 'product', evidence: 'F-36・F-46・F-42 (admin_user_notes・membership_audit・meal_nutrition_debug_logs・gdpr_deletion_requests)' },
  { id: 'privacy-3#17', section: 'privacy-3', fragment: 'Cookie 等 | 第10', chars: 19, basis: 'contract', evidence: '第10条の参照' },
  { id: 'privacy-3#18', section: 'privacy-3', fragment: 'アプリは、ユーザーが写真を撮', chars: 84, basis: 'product', evidence: 'F-25' },
  { id: 'privacy-3#19', section: 'privacy-3', fragment: '許可は、端末の設定から取り消', chars: 17, basis: 'product', evidence: 'F-25' },
  { id: 'privacy-3#20', section: 'privacy-3', fragment: '本サービスは、端末の位置情報', chars: 32, basis: 'product', evidence: 'F-25' },
  { id: 'privacy-3#21', section: 'privacy-3', fragment: '有料プラン | 申し込んだ有', chars: 273, basis: 'product', evidence: 'supabase/migrations/20261016210000_billing_core.sql・docs/design/billing/03-paid-plans-and-iap.md (§6.3・§6.4)' },
  { id: 'privacy-4#1', section: 'privacy-4', fragment: '当社は、取得した情報を次の目', chars: 21, basis: 'contract', evidence: '列挙の導入 (個人情報保護法 17 条)' },
  { id: 'privacy-4#2', section: 'privacy-4', fragment: '本サービスの提供（アカウント', chars: 57, basis: 'product', evidence: 'F-18・F-19・F-31' },
  { id: 'privacy-4#3', section: 'privacy-4', fragment: '記録の継続と比較の機能（記録', chars: 59, basis: 'product', evidence: 'F-45' },
  { id: 'privacy-4#4', section: 'privacy-4', fragment: 'AI 機能の提供のため', chars: 11, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-4#5', section: 'privacy-4', fragment: '第6条のとおり、日本国外の', chars: 29, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-4#6', section: 'privacy-4', fragment: '本人確認、なりすましや不正利', chars: 31, basis: 'product', evidence: 'F-16・F-17・F-28' },
  { id: 'privacy-4#7', section: 'privacy-4', fragment: '年齢の確認と、未成年者につい', chars: 28, basis: 'product', evidence: 'F-10' },
  { id: 'privacy-4#8', section: 'privacy-4', fragment: 'お問い合わせ、サポート、個人', chars: 31, basis: 'product', evidence: 'F-13・F-36' },
  { id: 'privacy-4#9', section: 'privacy-4', fragment: '本サービスの重要なお知らせ、', chars: 46, basis: 'product', evidence: 'F-5・F-31' },
  { id: 'privacy-4#10', section: 'privacy-4', fragment: '本サービスの改善、不具合や障', chars: 39, basis: 'product', evidence: 'F-19・F-45 (集計の数値だけ)' },
  { id: 'privacy-4#11', section: 'privacy-4', fragment: '当社は、ユーザーの写真や記録', chars: 47, basis: 'product', evidence: 'F-27 (学習の処理のコードが無い)' },
  { id: 'privacy-4#12', section: 'privacy-4', fragment: '法令に基づく対応、権利の行使', chars: 20, basis: 'law', evidence: '個人情報保護法 17〜18 条・41〜46 条の定め' },
  { id: 'privacy-4#13', section: 'privacy-4', fragment: '当社の事業の承継のため（承継', chars: 28, basis: 'law', evidence: '個人情報保護法 17〜18 条・41〜46 条の定め' },
  { id: 'privacy-4#14', section: 'privacy-4', fragment: '当社は、上の目的の達成に必要', chars: 32, basis: 'law', evidence: '個人情報保護法 17〜18 条・41〜46 条の定め' },
  { id: 'privacy-4#15', section: 'privacy-4', fragment: '利用目的を変更するときは、変', chars: 58, basis: 'law', evidence: '個人情報保護法 17〜18 条・41〜46 条の定め' },
  { id: 'privacy-4#16', section: 'privacy-4', fragment: '当社は、仮名加工情報および匿', chars: 49, basis: 'product', evidence: 'F-27' },
  { id: 'privacy-4#17', section: 'privacy-4', fragment: '上の統計は、特定の個人と結び', chars: 29, basis: 'product', evidence: 'F-19・F-45' },
  { id: 'privacy-4#18', section: 'privacy-4', fragment: '仮名加工情報または匿名加工情', chars: 61, basis: 'law', evidence: '個人情報保護法 17〜18 条・41〜46 条の定め' },
  { id: 'privacy-4#19', section: 'privacy-4', fragment: '有料プランの提供（申込みの受', chars: 51, basis: 'product', evidence: 'src/lib/billing/service.ts・docs/design/billing/03-paid-plans-and-iap.md' },
  { id: 'privacy-5#1', section: 'privacy-5', fragment: '本サービスで扱う情報のうち、', chars: 72, basis: 'law', evidence: '個人情報保護法 2 条 3 項・F-22' },
  { id: 'privacy-5#2', section: 'privacy-5', fragment: '食物アレルギーや体重・血圧な', chars: 45, basis: 'product', evidence: 'F-18 (健康の表の SELECT は本人だけ)' },
  { id: 'privacy-5#3', section: 'privacy-5', fragment: 'これらの情報の入力は任意です', chars: 14, basis: 'product', evidence: 'F-22 (任意の欄)' },
  { id: 'privacy-5#4', section: 'privacy-5', fragment: '入力しなくても、本サービスの', chars: 25, basis: 'product', evidence: 'F-22' },
  { id: 'privacy-5#5', section: 'privacy-5', fragment: '当社は、ユーザー本人がこれら', chars: 74, basis: 'contract', evidence: '取得の同意の取り方 (個人情報保護法 20 条 2 項。§3.2)' },
  { id: 'privacy-5#6', section: 'privacy-5', fragment: 'これらの情報を AI 機能の', chars: 51, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-5#7', section: 'privacy-5', fragment: '持病、服薬、妊娠・授乳の状況', chars: 53, basis: 'product', evidence: 'F-29・F-43' },
  { id: 'privacy-5#8', section: 'privacy-5', fragment: '健康に関する記録は、家族グル', chars: 43, basis: 'product', evidence: 'F-18・F-33' },
  { id: 'privacy-5#9', section: 'privacy-5', fragment: '健康診断や血液検査の結果と、', chars: 71, basis: 'product', evidence: 'F-48・F-52' },
  { id: 'privacy-5#10', section: 'privacy-5', fragment: '当社の運営担当者は、お問い合', chars: 78, basis: 'process', evidence: 'F-33・F-35・F-52' },
  { id: 'privacy-5#11', section: 'privacy-5', fragment: '要配慮個人情報を、本人の同意', chars: 32, basis: 'product', evidence: 'F-8・F-27 (オプトアウトの提供の処理が無い)' },
  { id: 'privacy-5#12', section: 'privacy-5', fragment: '本人の同意を得ずに行う第三者', chars: 39, basis: 'product', evidence: 'F-8・F-27 (オプトアウトの提供の処理が無い)' },
  { id: 'privacy-6#1', section: 'privacy-6', fragment: '本サービスの AI 機能は、', chars: 76, basis: 'product', evidence: 'F-8・F-29・F-43' },
  { id: 'privacy-6#2', section: 'privacy-6', fragment: 'これらの事業者への提供は、個', chars: 74, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-6#3', section: 'privacy-6', fragment: '送る情報は次のとおりです', chars: 12, basis: 'contract', evidence: '列挙の導入' },
  { id: 'privacy-6#4', section: 'privacy-6', fragment: 'どの情報を送るかは、機能によ', chars: 21, basis: 'product', evidence: 'F-29・F-43' },
  { id: 'privacy-6#5', section: 'privacy-6', fragment: '食事の写真、食事と献立の記録', chars: 20, basis: 'product', evidence: 'F-29・F-43' },
  { id: 'privacy-6#6', section: 'privacy-6', fragment: '健康の記録、健康の目標、健康', chars: 49, basis: 'product', evidence: 'F-43・F-48・src/lib/ai/consent-config.ts:96' },
  { id: 'privacy-6#7', section: 'privacy-6', fragment: 'プロフィールの情報（ニックネ', chars: 60, basis: 'product', evidence: 'F-29' },
  { id: 'privacy-6#8', section: 'privacy-6', fragment: '健康に関する情報（持病、服薬', chars: 24, basis: 'product', evidence: 'F-29' },
  { id: 'privacy-6#9', section: 'privacy-6', fragment: 'これらは要配慮個人情報に当た', chars: 22, basis: 'law', evidence: '個人情報保護法 2 条 3 項' },
  { id: 'privacy-6#10', section: 'privacy-6', fragment: 'AI 相談に入力した文章と、', chars: 28, basis: 'product', evidence: 'F-43' },
  { id: 'privacy-6#11', section: 'privacy-6', fragment: '冷蔵庫の写真と食材、買い物リ', chars: 32, basis: 'product', evidence: 'F-43・src/lib/ai/consent-config.ts:85-116' },
  { id: 'privacy-6#12', section: 'privacy-6', fragment: 'ニックネームは、AI 相談や', chars: 31, basis: 'product', evidence: 'F-29' },
  { id: 'privacy-6#13', section: 'privacy-6', fragment: 'ニックネームに実名を登録して', chars: 58, basis: 'contract', evidence: 'お願い (ニックネームは自由入力。F-29)' },
  { id: 'privacy-6#14', section: 'privacy-6', fragment: '利用する目的は、写真から料理', chars: 103, basis: 'product', evidence: 'src/lib/ai/consent-config.ts:135-141' },
  { id: 'privacy-6#15', section: 'privacy-6', fragment: '所在国の個人情報の保護に関す', chars: 29, basis: 'contract', evidence: '列挙の導入' },
  { id: 'privacy-6#16', section: 'privacy-6', fragment: 'アメリカ合衆国: 民間部門を', chars: 78, basis: 'law', evidence: 'PPC「外国における個人情報の保護に関する制度等の調査」(§3.1 L-6。§18 Q-3)' },
  { id: 'privacy-6#17', section: 'privacy-6', fragment: '個人情報保護委員会が公表する', chars: 65, basis: 'law', evidence: '§3.1 L-6' },
  { id: 'privacy-6#18', section: 'privacy-6', fragment: 'エストニア: 欧州連合（EU', chars: 46, basis: 'law', evidence: '§3.1 L-6' },
  { id: 'privacy-6#19', section: 'privacy-6', fragment: 'EU は、個人情報保護法 2', chars: 66, basis: 'law', evidence: '個人情報保護法 28 条 1 項・規則 15 条' },
  { id: 'privacy-6#20', section: 'privacy-6', fragment: '各事業者が講じる個人情報の保', chars: 67, basis: 'contract', evidence: '契約の定め (API の利用契約。§18 Q-10)' },
  { id: 'privacy-6#21', section: 'privacy-6', fragment: '送った内容は、各事業者のもと', chars: 52, basis: 'product', evidence: 'src/lib/ai/consent-config.ts:143-145' },
  { id: 'privacy-6#22', section: 'privacy-6', fragment: '保存の期間や扱いは事業者ごと', chars: 31, basis: 'product', evidence: 'src/lib/ai/consent-config.ts:143-145' },
  { id: 'privacy-6#23', section: 'privacy-6', fragment: '同意は、AI 機能を初めて使', chars: 31, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-6#24', section: 'privacy-6', fragment: '同意の内容（事業者の一覧、送', chars: 54, basis: 'product', evidence: 'F-8・F-26' },
  { id: 'privacy-6#25', section: 'privacy-6', fragment: '同意するまで、また同意を撤回', chars: 53, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-6#26', section: 'privacy-6', fragment: '自動で行う AI の処理も行', chars: 18, basis: 'product', evidence: 'F-8・src/app/api/cron/process-menu-queue/route.ts:60-64' },
  { id: 'privacy-6#27', section: 'privacy-6', fragment: '同意は、本サービスの画面から', chars: 24, basis: 'product', evidence: 'F-8・src/app/api/ai/consent/revoke/route.ts' },
  { id: 'privacy-6#28', section: 'privacy-6', fragment: '撤回すると AI 機能は利用', chars: 39, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-6#29', section: 'privacy-6', fragment: '同意の文面や事業者の一覧を変', chars: 52, basis: 'product', evidence: 'supabase/functions/_shared/ai-consent.ts:30-33・F-8' },
  { id: 'privacy-6#30', section: 'privacy-6', fragment: 'AI 事業者への提供の記録と', chars: 52, basis: 'product', evidence: 'F-26' },
  { id: 'privacy-6#31', section: 'privacy-6', fragment: '送る情報の項目と事業者は、同', chars: 37, basis: 'product', evidence: 'F-26' },
  { id: 'privacy-6#32', section: 'privacy-6', fragment: '第三者への提供の記録の開示の', chars: 39, basis: 'process', evidence: 'F-13・F-26' },
  { id: 'privacy-6#33', section: 'privacy-6', fragment: '同意の記録は、データの書き出', chars: 28, basis: 'product', evidence: 'F-26' },
  { id: 'privacy-7#1', section: 'privacy-7', fragment: '当社は、本サービスの提供に必', chars: 43, basis: 'product', evidence: 'F-16' },
  { id: 'privacy-7#2', section: 'privacy-7', fragment: 'いずれも日本国外に本拠を置く', chars: 19, basis: 'product', evidence: 'F-16' },
  { id: 'privacy-7#3', section: 'privacy-7', fragment: 'Supabase | アメリ', chars: 97, basis: 'product', evidence: 'F-16・package.json' },
  { id: 'privacy-7#4', section: 'privacy-7', fragment: 'Vercel | アメリカ合', chars: 115, basis: 'product', evidence: 'F-15・F-16・src/lib/speed-insights-scrub.ts' },
  { id: 'privacy-7#5', section: 'privacy-7', fragment: 'Google | アメリカ合', chars: 120, basis: 'product', evidence: 'F-16・src/app/(auth)/login/page.tsx:78-83' },
  { id: 'privacy-7#6', section: 'privacy-7', fragment: 'Resend | アメリカ合', chars: 50, basis: 'product', evidence: 'F-16・src/lib/emails/outbox.ts' },
  { id: 'privacy-7#7', section: 'privacy-7', fragment: 'Upstash | アメリカ', chars: 77, basis: 'product', evidence: 'F-16・src/lib/rate-limit.ts:17-31' },
  { id: 'privacy-7#8', section: 'privacy-7', fragment: 'Expo | アメリカ合衆国', chars: 56, basis: 'product', evidence: 'F-16・src/lib/push/expo-transport.ts:14-15' },
  { id: 'privacy-7#9', section: 'privacy-7', fragment: 'Cloudflare | ア', chars: 123, basis: 'product', evidence: 'F-16・src/lib/auth/turnstile-verify.ts:22・.github/workflows/db-backup.yml' },
  { id: 'privacy-7#10', section: 'privacy-7', fragment: 'GitHub | アメリカ合', chars: 80, basis: 'product', evidence: 'F-16・.github/workflows/db-backup.yml' },
  { id: 'privacy-7#11', section: 'privacy-7', fragment: '当社は、委託先との契約と各事', chars: 71, basis: 'contract', evidence: '契約の定め (委託先の監督。個人情報保護法 25 条)' },
  { id: 'privacy-7#12', section: 'privacy-7', fragment: '外国にある事業者への委託にあ', chars: 103, basis: 'contract', evidence: '契約の定め (基準適合体制。§18 Q-4)' },
  { id: 'privacy-7#13', section: 'privacy-7', fragment: 'ユーザーからの求めがあったと', chars: 70, basis: 'law', evidence: '個人情報保護法 28 条 3 項・規則 18 条 3 項' },
  { id: 'privacy-7#14', section: 'privacy-7', fragment: '委託先の所在国の制度に関する', chars: 41, basis: 'contract', evidence: '契約の定め (委託先の監督。個人情報保護法 25 条)' },
  { id: 'privacy-7#15', section: 'privacy-7', fragment: 'Stripe | アメリカ合', chars: 114, basis: 'product', evidence: 'src/lib/billing/stripe-gateway.ts' },
  { id: 'privacy-7#16', section: 'privacy-7', fragment: 'RevenueCat | ア', chars: 88, basis: 'product', evidence: 'src/lib/billing/revenuecat-gateway.ts・docs/design/billing/03-paid-plans-and-iap.md (§8.3)' },
  { id: 'privacy-8#1', section: 'privacy-8', fragment: '当社は、次の場合を除き、あら', chars: 48, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#2', section: 'privacy-8', fragment: '（a）法令に基づく場合', chars: 11, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#3', section: 'privacy-8', fragment: '（b）人の生命、身体または財', chars: 47, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#4', section: 'privacy-8', fragment: '（c）公衆衛生の向上または児', chars: 55, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#5', section: 'privacy-8', fragment: '（d）国の機関や地方公共団体', chars: 81, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#6', section: 'privacy-8', fragment: 'AI 機能のための日本国外の', chars: 42, basis: 'product', evidence: 'F-8' },
  { id: 'privacy-8#7', section: 'privacy-8', fragment: '委託先への提供は、第7条のと', chars: 39, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#8', section: 'privacy-8', fragment: '家族グループのメンバーや組織', chars: 62, basis: 'product', evidence: 'F-18・F-19・F-49' },
  { id: 'privacy-8#9', section: 'privacy-8', fragment: '当社は、個人データの共同利用', chars: 20, basis: 'product', evidence: 'F-27 (共同利用・提供の処理が無い)' },
  { id: 'privacy-8#10', section: 'privacy-8', fragment: '本人の同意を得ずに行う第三者', chars: 35, basis: 'product', evidence: 'F-27' },
  { id: 'privacy-8#11', section: 'privacy-8', fragment: '当社の事業を第三者に承継する', chars: 39, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-8#12', section: 'privacy-8', fragment: 'その場合、承継先は本ポリシー', chars: 30, basis: 'law', evidence: '個人情報保護法 27 条 1 項・5 項' },
  { id: 'privacy-9#1', section: 'privacy-9', fragment: '家族グループの中では、メンバ', chars: 70, basis: 'product', evidence: 'F-49' },
  { id: 'privacy-9#2', section: 'privacy-9', fragment: '食事の記録と、献立の料理の名', chars: 48, basis: 'product', evidence: 'F-18・F-49' },
  { id: 'privacy-9#3', section: 'privacy-9', fragment: '初期設定では共有します', chars: 11, basis: 'product', evidence: 'F-18' },
  { id: 'privacy-9#4', section: 'privacy-9', fragment: '共有の設定は、本人が変更でき', chars: 16, basis: 'product', evidence: 'F-18・src/app/api/family/members/me/share/route.ts' },
  { id: 'privacy-9#5', section: 'privacy-9', fragment: '家族グループへの招待の宛先の', chars: 94, basis: 'product', evidence: 'F-38・F-49' },
  { id: 'privacy-9#6', section: 'privacy-9', fragment: '招待を承諾して参加したメンバ', chars: 102, basis: 'product', evidence: 'F-19・F-51' },
  { id: 'privacy-9#7', section: 'privacy-9', fragment: '退会した後の扱いは第12条の', chars: 19, basis: 'contract', evidence: '第12条の参照' },
  { id: 'privacy-9#8', section: 'privacy-9', fragment: '組織の管理者に表示されるのは', chars: 106, basis: 'product', evidence: 'F-19' },
  { id: 'privacy-9#9', section: 'privacy-9', fragment: '組織のチャレンジに参加したユ', chars: 35, basis: 'product', evidence: 'F-19・src/lib/org-challenges.ts:115-128' },
  { id: 'privacy-9#10', section: 'privacy-9', fragment: '本サービスに保存した写真、健', chars: 80, basis: 'product', evidence: 'F-17・F-18・F-19・F-33・F-43・F-45' },
  { id: 'privacy-9#11', section: 'privacy-9', fragment: '家族グループから退出し、また', chars: 52, basis: 'product', evidence: 'F-49' },
  { id: 'privacy-10#1', section: 'privacy-10', fragment: '本サービスは、ユーザーのブラ', chars: 56, basis: 'law', evidence: '電気通信事業法 27 条の 12 (§3.2)' },
  { id: 'privacy-10#2', section: 'privacy-10', fragment: '電気通信事業法の外部送信規律', chars: 36, basis: 'law', evidence: '電気通信事業法 27 条の 12 (§3.2)' },
  { id: 'privacy-10#3', section: 'privacy-10', fragment: '当社は、広告のための Coo', chars: 65, basis: 'product', evidence: 'F-15' },
  { id: 'privacy-10#4', section: 'privacy-10', fragment: 'Supabase（当社の委託', chars: 96, basis: 'product', evidence: 'F-15' },
  { id: 'privacy-10#5', section: 'privacy-10', fragment: '当社（ブラウザの Cooki', chars: 55, basis: 'product', evidence: 'F-15・F-14' },
  { id: 'privacy-10#6', section: 'privacy-10', fragment: '当社（アプリ内のブラウザの保', chars: 47, basis: 'product', evidence: 'apps/mobile/src/components/web/WebViewScreen.tsx:232-251' },
  { id: 'privacy-10#7', section: 'privacy-10', fragment: 'Vercel（表示速度の計測', chars: 75, basis: 'product', evidence: 'F-15・src/lib/speed-insights-scrub.ts:1-20' },
  { id: 'privacy-10#8', section: 'privacy-10', fragment: 'Cloudflare（ボット', chars: 62, basis: 'product', evidence: 'F-15・src/lib/auth/turnstile-verify.ts:22' },
  { id: 'privacy-10#9', section: 'privacy-10', fragment: 'Google（ログインの画面', chars: 69, basis: 'product', evidence: 'F-15・F-16' },
  { id: 'privacy-10#10', section: 'privacy-10', fragment: 'GitHub（GitHub', chars: 112, basis: 'product', evidence: 'F-15' },
  { id: 'privacy-10#11', section: 'privacy-10', fragment: 'Expo（プッシュ通知） |', chars: 42, basis: 'product', evidence: 'F-15・F-16' },
  { id: 'privacy-10#12', section: 'privacy-10', fragment: 'カメラ、写真ライブラリ、通知', chars: 39, basis: 'contract', evidence: '第3条の参照' },
  { id: 'privacy-10#13', section: 'privacy-10', fragment: 'Stripe（Web のお支', chars: 84, basis: 'product', evidence: 'src/lib/billing/stripe-gateway.ts' },
  { id: 'privacy-10#14', section: 'privacy-10', fragment: 'RevenueCat（iOS', chars: 97, basis: 'product', evidence: 'docs/design/billing/03-paid-plans-and-iap.md (§8.10)' },
  { id: 'privacy-11#1', section: 'privacy-11', fragment: '当社は、個人データの漏えい、', chars: 40, basis: 'contract', evidence: '列挙の導入 (個人情報保護法 23 条)' },
  { id: 'privacy-11#2', section: 'privacy-11', fragment: '基本方針: 個人情報保護法と', chars: 45, basis: 'process', evidence: '本ポリシーの公表 (F-2)' },
  { id: 'privacy-11#3', section: 'privacy-11', fragment: '取扱いの規律: 個人データを', chars: 49, basis: 'process', evidence: 'docs/design/CLAUDE.md (設計書と審査)・tests/' },
  { id: 'privacy-11#4', section: 'privacy-11', fragment: '組織的な措置: 運営担当者の', chars: 53, basis: 'product', evidence: 'F-41' },
  { id: 'privacy-11#5', section: 'privacy-11', fragment: '大きな権限を持つ運営担当者の', chars: 38, basis: 'product', evidence: 'F-35' },
  { id: 'privacy-11#6', section: 'privacy-11', fragment: '漏えいなどが生じたときは、法', chars: 43, basis: 'law', evidence: '個人情報保護法 26 条' },
  { id: 'privacy-11#7', section: 'privacy-11', fragment: '物理的な措置: 本サービスの', chars: 73, basis: 'contract', evidence: '委託先の管理に依拠 (§18 Q-4)' },
  { id: 'privacy-11#8', section: 'privacy-11', fragment: '技術的な措置: 通信の暗号化', chars: 107, basis: 'product', evidence: 'cross/12・cross/18・cross/19・cross/17 §3.2・F-14・F-16' },
  { id: 'privacy-11#9', section: 'privacy-11', fragment: '外的環境の把握: 委託先と', chars: 85, basis: 'product', evidence: 'F-8・F-16' },
  { id: 'privacy-12#1', section: 'privacy-12', fragment: '当社は、個人データを次の期間', chars: 46, basis: 'contract', evidence: '表の導入' },
  { id: 'privacy-12#2', section: 'privacy-12', fragment: 'アカウントと、アカウントに紐', chars: 138, basis: 'product', evidence: 'F-11・F-26・F-34・F-46・cross/08 §16.1-16.3' },
  { id: 'privacy-12#3', section: 'privacy-12', fragment: '公開の状態のユーザーコンテン', chars: 46, basis: 'product', evidence: 'F-11・F-54・supabase/migrations/20261010000100_auth_users_fk_on_delete.sql:52-55' },
  { id: 'privacy-12#4', section: 'privacy-12', fragment: '保護者として署名した同意の記', chars: 74, basis: 'product', evidence: 'F-30・F-53' },
  { id: 'privacy-12#5', section: 'privacy-12', fragment: '解散した家族グループの情報（', chars: 97, basis: 'product', evidence: 'F-53' },
  { id: 'privacy-12#6', section: 'privacy-12', fragment: '当社が非表示にしたコンテンツ', chars: 30, basis: 'product', evidence: 'F-14' },
  { id: 'privacy-12#7', section: 'privacy-12', fragment: 'ログインの履歴とセッションの', chars: 60, basis: 'product', evidence: 'F-14' },
  { id: 'privacy-12#8', section: 'privacy-12', fragment: 'アプリの動作のログ（ブラウザ', chars: 77, basis: 'product', evidence: 'F-14・F-46' },
  { id: 'privacy-12#9', section: 'privacy-12', fragment: 'メールとプッシュ通知の送信待', chars: 65, basis: 'product', evidence: 'F-14・F-46' },
  { id: 'privacy-12#10', section: 'privacy-12', fragment: '利用回数の制限のための計数', chars: 40, basis: 'product', evidence: 'F-16・src/lib/rate-limit.ts:17-31' },
  { id: 'privacy-12#11', section: 'privacy-12', fragment: 'お問い合わせ、サポート、個人', chars: 127, basis: 'product', evidence: 'F-36' },
  { id: 'privacy-12#12', section: 'privacy-12', fragment: '招待と、家族グループや組織の', chars: 126, basis: 'product', evidence: 'F-46・F-51' },
  { id: 'privacy-12#13', section: 'privacy-12', fragment: 'AI 事業者を呼び出した記録', chars: 95, basis: 'product', evidence: 'F-46' },
  { id: 'privacy-12#14', section: 'privacy-12', fragment: '栄養の計算を確かめるための記', chars: 76, basis: 'product', evidence: 'F-46' },
  { id: 'privacy-12#15', section: 'privacy-12', fragment: '法令上の保存義務や、不正利用', chars: 86, basis: 'product', evidence: 'F-11・F-41・F-46' },
  { id: 'privacy-12#16', section: 'privacy-12', fragment: 'メールの送信停止の記録（苦情', chars: 69, basis: 'product', evidence: 'F-30' },
  { id: 'privacy-12#17', section: 'privacy-12', fragment: '退会の記録 | 退会した日時', chars: 46, basis: 'product', evidence: 'F-11' },
  { id: 'privacy-12#18', section: 'privacy-12', fragment: 'データベースのバックアップ', chars: 120, basis: 'product', evidence: 'F-11' },
  { id: 'privacy-12#19', section: 'privacy-12', fragment: 'AI 事業者に送った内容 |', chars: 32, basis: 'product', evidence: 'src/lib/ai/consent-config.ts:143-145' },
  { id: 'privacy-12#20', section: 'privacy-12', fragment: '有料プランの契約の記録（プラ', chars: 56, basis: 'product', evidence: 'supabase/baseline/prod_schema.sql (personal_subscriptions_user_id_fkey の ON DELETE CASCADE)' },
  { id: 'privacy-12#21', section: 'privacy-12', fragment: '決済の事業者の顧客の記録と、', chars: 84, basis: 'product', evidence: 'src/lib/billing/account-deletion.ts・supabase/migrations/20261010000100_auth_users_fk_on_delete.sql' },
  { id: 'privacy-12#22', section: 'privacy-12', fragment: '決済の事業者と Revenu', chars: 114, basis: 'product', evidence: 'supabase/migrations/20261016210000_billing_core.sql・docs/design/billing/03-paid-plans-and-iap.md (§6.3)' },
  { id: 'privacy-12#23', section: 'privacy-12', fragment: '決済の事業者とストアが保存す', chars: 32, basis: 'contract', evidence: '各事業者の規約の参照' },
  { id: 'privacy-13#1', section: 'privacy-13', fragment: 'ユーザーは、本サービスの画面', chars: 22, basis: 'product', evidence: 'F-11' },
  { id: 'privacy-13#2', section: 'privacy-13', fragment: '退会すると、アカウントと、ア', chars: 36, basis: 'product', evidence: 'F-11' },
  { id: 'privacy-13#3', section: 'privacy-13', fragment: '削除は取り消せません', chars: 10, basis: 'product', evidence: 'F-11' },
  { id: 'privacy-13#4', section: 'privacy-13', fragment: '退会後も残るものは、本ポリシ', chars: 25, basis: 'contract', evidence: '第12条の参照' },
  { id: 'privacy-13#5', section: 'privacy-13', fragment: 'ユーザーは、自分の個人データ', chars: 42, basis: 'product', evidence: 'F-12' },
  { id: 'privacy-13#6', section: 'privacy-13', fragment: 'アカウントの凍結中も、退会と', chars: 23, basis: 'product', evidence: 'F-12' },
  { id: 'privacy-13#7', section: 'privacy-13', fragment: '利用規約や本ポリシーの改定後', chars: 57, basis: 'product', evidence: 'src/app/legal-consent/account/page.tsx・packages/shared/src/legal-consent-api.ts' },
  { id: 'privacy-13#8', section: 'privacy-13', fragment: 'この間も、第14条の開示の請', chars: 38, basis: 'product', evidence: 'F-32・F-13' },
  { id: 'privacy-13#9', section: 'privacy-13', fragment: '組織のオーナーと家族グループ', chars: 82, basis: 'product', evidence: 'F-59' },
  { id: 'privacy-14#1', section: 'privacy-14', fragment: 'ユーザーは、当社に対し、個人', chars: 103, basis: 'law', evidence: '個人情報保護法 32〜35 条' },
  { id: 'privacy-14#2', section: 'privacy-14', fragment: '請求は、本サービスの請求の画', chars: 21, basis: 'product', evidence: 'F-13・packages/shared/src/data-subject-requests.ts:12' },
  { id: 'privacy-14#3', section: 'privacy-14', fragment: '請求の種類と内容を送ると、登', chars: 42, basis: 'product', evidence: 'F-13' },
  { id: 'privacy-14#4', section: 'privacy-14', fragment: '本人確認が済んだ時点で請求を', chars: 20, basis: 'product', evidence: 'F-13' },
  { id: 'privacy-14#5', section: 'privacy-14', fragment: '当社は、本人確認が済んだ請求', chars: 24, basis: 'process', evidence: '個人情報保護法 33 条・F-13' },
  { id: 'privacy-14#6', section: 'privacy-14', fragment: '対応は、本人確認が済んだ日か', chars: 38, basis: 'product', evidence: 'F-13' },
  { id: 'privacy-14#7', section: 'privacy-14', fragment: '目安の期間内に対応できないと', chars: 33, basis: 'process', evidence: 'cross/15 §12 (運営の応答)' },
  { id: 'privacy-14#8', section: 'privacy-14', fragment: '法令により開示などに応じられ', chars: 122, basis: 'law', evidence: '個人情報保護法 33 条 2 項' },
  { id: 'privacy-14#9', section: 'privacy-14', fragment: '開示は、本サービスの画面での', chars: 41, basis: 'product', evidence: 'F-12・F-13' },
  { id: 'privacy-14#10', section: 'privacy-14', fragment: '請求の手数料はいただきません', chars: 14, basis: 'process', evidence: 'cross/15 (手数料の処理が無い)' },
  { id: 'privacy-14#11', section: 'privacy-14', fragment: 'アカウントが凍結されている方', chars: 97, basis: 'process', evidence: 'F-13・cross/15 S-13' },
  { id: 'privacy-14#12', section: 'privacy-14', fragment: 'アカウントとデータ全体の消去', chars: 42, basis: 'process', evidence: 'F-40 (cross/15 §4.4・operator/09 §9.3)' },
  { id: 'privacy-14#13', section: 'privacy-14', fragment: '利用の停止の請求は、当社が請', chars: 35, basis: 'process', evidence: 'F-40 (operator/09 §9.3)' },
  { id: 'privacy-15#1', section: 'privacy-15', fragment: '18 歳未満の方が本サービス', chars: 33, basis: 'product', evidence: 'F-10' },
  { id: 'privacy-15#2', section: 'privacy-15', fragment: '13 歳以上 18 歳未満の', chars: 42, basis: 'product', evidence: 'F-10' },
  { id: 'privacy-15#3', section: 'privacy-15', fragment: '13 歳未満の方の本人名義の', chars: 26, basis: 'product', evidence: 'F-10' },
  { id: 'privacy-15#4', section: 'privacy-15', fragment: '本人のアカウントが無い子ども', chars: 54, basis: 'product', evidence: 'F-33' },
  { id: 'privacy-15#5', section: 'privacy-15', fragment: '未成年者の個人情報の開示など', chars: 35, basis: 'process', evidence: 'F-13 (本人の請求)・お問い合わせ (保護者)' },
  { id: 'privacy-15#6', section: 'privacy-15', fragment: '生年月日は年齢の確認のために', chars: 40, basis: 'product', evidence: 'F-10' },
  { id: 'privacy-15#7', section: 'privacy-15', fragment: '保護者の同意とのつながりが無', chars: 92, basis: 'product', evidence: 'F-50' },
  { id: 'privacy-16#1', section: 'privacy-16', fragment: 'プッシュ通知は、本サービスの', chars: 35, basis: 'product', evidence: 'F-34' },
  { id: 'privacy-16#2', section: 'privacy-16', fragment: '当社からのメールについて苦情', chars: 58, basis: 'product', evidence: 'F-30・src/lib/emails/suppression.ts' },
  { id: 'privacy-16#3', section: 'privacy-16', fragment: 'この送信停止の記録は、再び送', chars: 29, basis: 'product', evidence: 'F-30' },
  { id: 'privacy-17#1', section: 'privacy-17', fragment: '個人情報の取扱いに関する苦情', chars: 42, basis: 'product', evidence: 'F-56・P-10・src/app/contact/page.tsx' },
  { id: 'privacy-18#1', section: 'privacy-18', fragment: '当社は、法令の改正や本サービ', chars: 40, basis: 'contract', evidence: '契約の定め (改定)' },
  { id: 'privacy-18#2', section: 'privacy-18', fragment: '内容が変わる改定をするときは', chars: 47, basis: 'process', evidence: '§9.4 の 2・F-31' },
  { id: 'privacy-18#3', section: 'privacy-18', fragment: '改定後の内容は、施行日からこ', chars: 24, basis: 'product', evidence: 'F-3' },
  { id: 'privacy-18#4', section: 'privacy-18', fragment: '個人情報の利用目的、第三者へ', chars: 93, basis: 'product', evidence: 'F-5・§9.2' },
  { id: 'privacy-18#5', section: 'privacy-18', fragment: '同意するまでの間の取扱いは、', chars: 28, basis: 'contract', evidence: '利用規約第24条の参照' },
  { id: 'privacy-18#6', section: 'privacy-18', fragment: '本ポリシーの版と施行日は、こ', chars: 27, basis: 'product', evidence: 'F-3' },
  { id: 'privacy-18#7', section: 'privacy-18', fragment: '改定前の版は当社が保管し、お', chars: 28, basis: 'process', evidence: '§9.4・docs/legal/archive (段 B で作る)' },
  { id: 'privacy-supplementary#1', section: 'privacy-supplementary', fragment: '本ポリシーは、このページの冒', chars: 30, basis: 'contract', evidence: '契約の定め (施行日)' },
];
```

---

## 11. 表 3 点

### 11.1 ①全パターン表 (文書 × 読む人の状態 × 入口 → 何が出るか)

| 文書 | 読む人 | 入口 | 出るもの |
|---|---|---|---|
| /terms, /privacy | 未ログイン | LP フッター・サインアップ画面のリンク・ストア審査の URL・直接 | 版 v2026.1 と施行日 → 全文。ログイン画面へ回さない (`publicPaths`) |
| 同 | ログイン済み・同意済み (v2026.1) | 設定・同意画面のリンク・直接 | 同上 (ゲートの対象外) |
| 同 | ログイン済み・未同意 (v2025.1 / 無し) | 同意画面の「全文を読む」 | 同上 (ゲートの対象外なので同意画面から読める) |
| 同 | 凍結中 | `/frozen` から直接 | 同上 (`/terms` `/privacy` は凍結の差し戻しの対象外) |
| 同 | アプリ・未ログイン | 最初の画面 (welcome) の下の「利用規約」「プライバシー」のリンク (`apps/mobile/app/index.tsx:83-87` の `/terms`・`/privacy`) | アプリの公開ページ (`apps/mobile/app/(public)/terms.tsx:7-11`・`apps/mobile/app/(public)/privacy.tsx:7-11`。`PublicPage` に `webPath` と子の文「…はWeb版にて最新の内容をご確認ください。」を渡す) → 「Web版を開く」(`apps/mobile/src/components/PublicPage.tsx:69-80`) で外部ブラウザの Web の全文。アプリの側に本文の写しは無いので、版上げで変えるものは無い (§17)。子の文を渡すので、`PublicPage` の子が無いときの文 (`apps/mobile/src/components/PublicPage.tsx:62-64`) はこの 2 ページに出ない |
| 同 | アプリ・ログイン済み | 設定タブの「利用規約」「プライバシーポリシー」(`apps/mobile/app/(tabs)/settings.tsx:406-419` の `Linking.openURL(getTermsUrl())`・`getPrivacyUrl()`) | 公開ページを通らず、直接外部ブラウザで Web の全文 |
| /legal/parental-consent (保護者の同意書。v1.14 で文を実装に合わせ、版を v2026.2 に上げた。P-12) | 未ログイン・保護者 | 子どもの追加の画面 (`src/app/(main)/family/members/child/new/page.tsx:223`)・メンバーの画面 (`src/app/(main)/family/members/[id]/page.tsx:295`)・同意の控えのメールの `document_url` (`src/app/api/family/members/child/route.ts:148`)・直接 (`/legal` は `publicPaths`。`lib/supabase/middleware.ts:308-319`) | 同意書の全文と、「個人情報の取り扱いはプライバシーポリシーをご確認ください」の `/privacy` へのリンク (`src/app/legal/parental-consent/page.tsx:47-55`。アンカーを付けないので、§7 の条の組み替えで壊れない)。同意書は利用規約第1条 3 項の個別規定で、登録できる情報 (お名前・生年月日・性別) と、保存の期間と消去の請求はプライバシーポリシーによることだけを書く (Q-27) |
| /legal-consent | 既存の利用者 (v2025.1) | 版上げ後の最初の画面 | 「改定されました」+ 2 つの「改定あり」+ 生年月日 (無い人) |
| /legal-consent | 新規 | `/auth/callback` | 「ご利用いただくには同意が必要です」(introFirst) + 生年月日 |
| /legal-consent | 18 歳未満で保護者の同意とのつながりが無い | 同上 | `guardianMissingHeading` と退会ボタンと、退会と書き出しの画面 (`/legal-consent/account`) へのリンク (v1.14) |
| /legal-consent/account (v1.14) | 未同意の人 (凍結でない。版は old・none。18 歳未満の案内が出る人を含む) | 同意画面のフォームの下・未成年の案内・「同意しない」の後の案内 (ログインの後) | 見出し「退会とデータの書き出し」と、書き出しと退会の 2 つの枠 (`AccountSelfServicePanel`)。退会の後は「退会しました」(ログインの画面へ移らない。アプリでは同意画面の上に「閉じる」が出る)。凍結中は `/frozen` へ回る |
| /legal-consent | 凍結中 (版は old・none・current のどれでも) | 版上げ後の最初の画面・直接 | 出ない。画面の判定は凍結が同意より先なので `/frozen` へ回る (F-28)。`/terms` `/privacy` `/contact` は読める |
| /legal-consent (WebView) | アプリの既存の利用者 | 起動時のゲート | Web と同じ画面 1 枚 |
| /api/* | 未同意 | アプリ・Web の fetch | 403 `LEGAL_CONSENT_REQUIRED` (許可リスト以外) |

### 11.2 ②状態比較表 (現行 vs 設計後)

| 観点 | 現行 | 設計後 |
|---|---|---|
| 利用規約の条 | 9 条 (74 行の JSX) | 28 条 + 附則 (5 章)。`TERMS_ARTICLE_HEADINGS` と `TERMS_ARTICLE_COUNT = 28` |
| プライバシーポリシーの条 | 7 条 (86 行の JSX) | 18 条 + 附則 + 前文。`PRIVACY_SECTION_HEADINGS` と `PRIVACY_SECTION_COUNT = 18` |
| 文面の置き場所 | ページの JSX | `src/lib/legal/terms-text.ts` / `privacy-text.ts` (データ)。ページは描くだけ |
| 本文の粒度 | 条ごとに短い要約 | 法令が求める事項と権利義務の約束だけ。製品の操作の細部 (画面の名前・道順・機能の一覧・役割ごとの見え方) は書かず、使い方ガイドとお問い合わせへ案内する。画面の名前の引用の形は T-40 が見つけて赤にする (R-28・P-11) |
| 未完成や予定の書き方 | 書いていない | 書かない (「準備中」「まだ〜」「予定」「〜する機能はありません」など)。T-6 が見つけて赤にする (R-32・P-9) |
| 文面の中の数 | 無い | `LEGAL_FACTS` から埋め、テストが正本と突き合わせる |
| 事業者の情報 | 名称は `BUSINESS_NAME`、代表者は `BUSINESS_REPRESENTATIVE`、問い合わせ先は `getSupportEmail()` を JSX に差し込む (`/privacy` に所在地の欄は無い) | 名称・所在地・代表者・メールアドレス・営業時間を `business-info.ts` の定数 (#1911) から `LegalTextContext` でページが渡す。電話番号は載せず「請求があれば遅滞なく開示します」と請求の窓口の文。窓口のメールアドレスは事業者のメールアドレス (`/legal`・`/company` と同じ値。R-31・P-10・T-16) |
| AI 事業者の一覧 | `AI_CONSENT_PROVIDERS` を JSX で map | ページが `ctx.aiProviders` に渡し、`ai_providers` ブロックが同じ `data-testid` で描く |
| 委託先 | 無い | `PRIVACY_PROCESSORS` 10 社 (evidence つき。決済の事業者 Stripe と RevenueCat は #1930 で足した) |
| 版 | v2025.1 / 2025-01-01 (仮置き) | v2026.1 / 公開日 |
| 旧版の控え | 無い (`docs/legal/` が無い) | `docs/legal/archive/v2025.1/terms.md`・`privacy.md` |
| テスト | 事業者名・AI 一覧・版表示・h1・戻るリンク | 左に加えて `tests/legal-text-1901.test.ts` (§13。T-6 = 未完成や予定の語、T-33 = 有料の語、T-34 = 個人データの表と第3条、T-35 = 本文と主張の表の 1 対 1、T-36 = AI 相談が読む表と第6条、T-40 = 画面の名前の引用の形、T-39・T-41・T-42 = 解散した家族グループの削除・写真を保存しないこと・公開の状態の見え方) と `tests/legal-claims-1901.ts` (主張の表) と `public-claims-guard` の走査対象に 2 ページ。`site-config-ui` の画面の一覧から `/privacy` を外す。`push-outbox.test.ts` の版の直書きを `LEGAL_DOCUMENTS` の値に |
| Cookie 同意バナー | 無い (cross/08 §12 は未実装) | 置かない (広告・計測の Cookie を使っていない旨を公表) |
| 医療免責・AI 著作権 | 規約に無い | 第 9 条・第 14 条 |
| 責任の制限 | 第7条「故意または重過失によらない場合には免責」・第8条「一切の責任を負いません」(軽過失の責任の全部免除) | 第 21 条 (故意・重過失を除き通常損害に限る。強行法規に反する限度で適用しない)。第 16 条 5 項・第 18 条 4 項は「第21条に定める範囲で責任を負う」。軽過失の責任を全部免除する条は置かない。料金に結ぶ責任の上限は置かない (有料の条文と一緒に #1912。Q-6) |
| AI 機能 | 現行 `/terms` 第4条: 食事画像とテキストを AI の栄養解析とフィードバックに使い、ユーザーはその処理に同意する (同意の取り方・撤回・送り先は書いていない)。免責は第7条の「AI による解析結果の正確性を保証するものではありません」 | 利用規約第7条: 日本国外の AI 事業者へ送ること・使う前にプライバシーポリシーと同意画面の内容に同意すること・同意しなくても AI 以外は使えること・本サービスの画面から確認し撤回できること・同意が無い間は自動で行う AI の処理も行わない・結果は推定の参考情報 (第9条へ)・AI に入れてはならない内容 (R-1・cross/08 §4) |
| AI 機能の 1 日の上限 | 書いていない | 利用規約第8条: 1 日の上限があり日本時間の翌日 0 時から再び使える・上限の回数は当社が定め、上限に達したときに画面に出す (回数そのものは運営画面で変えられるので本文に数を書かない。R-1・F-9) |
| 料金 | 書いていない (現行 `/terms` に料金の条は無い。F-1) | 利用規約第10条: 1 項「本サービスは、無料で利用できます」と、#1912 (billing/03 §11.1) が足した 2〜11 項 (有料プランの種類と価格の掲示先・申込みの方法・自動更新・無料体験・解約・返金・重ねた申込み・プランの変更・家族プラン・料金の改定) (R-30・T-33。v1.17) |
| 公開の範囲 | 書いていない | 利用規約第13条: 保存した食事・冷蔵庫の写真は本人だけに表示され、家族にも組織の管理者にも出ない (運営担当者は審査・調査に必要な範囲で見る)・公開の状態にしたユーザーコンテンツはログインしていない人を含め誰でも閲覧できる状態になる (F-54)・非表示にしたコンテンツの保存期間はプライバシーポリシー第12条 (R-1・R-23) |
| 家族グループと組織での見え方 | 書いていない (現行 `/terms` `/privacy` に家族と組織の条は無い。F-1・F-2) | プライバシーポリシー第9条に種類の水準で: 家族の中ではメンバーの表示名・役割・共有の設定と子どもの名前・生年月日・性別をメンバーが閲覧できる・食事の記録と献立の料理の名前は本人の共有の設定に従って表示される (初期は共有)・招待の宛先のメールアドレスと保護者の同意の記録をメンバーが閲覧できる・承諾した招待の宛先として参加の時点の登録のメールアドレスが退出後も残る (F-51)・組織の管理者に表示されるのは表示名・役割・参加日・招待の状況・人数・集計だけ (F-19)・チャレンジの順位は参加者どうし・保存した写真・健康の記録・AI 相談・比較の順位・ログインの履歴は家族にも組織の管理者にも出ない。利用規約第11条・第12条は、作成と参加・共有の設定・子どもの追加の同意書・組織の管理者が個人の記録を閲覧できないこと・代表者とオーナーの譲渡・当社による譲渡と解散を書く。役割ごとの操作 (招待・除名など) は書かない (R-14・R-28) |
| 凍結 | 書いていない (現行 `/terms` 第6条はサービス全体の停止だけ) | 利用規約第16条: 違反のときの非表示・制限・一時的または無期限の凍結・凍結中も書き出し・退会・お問い合わせの送信はできる・一時的な凍結は当社が定めた解除の日時の経過で自動で解除・判断の根拠の開示義務は負わない・措置による損害は第21条の範囲 (R-1・R-4・F-12・F-20) |
| 退会 | 書いていない (F-1・F-2) | 利用規約第17条・プライバシーポリシー第13条: 本サービスの画面から・アカウントと紐づく個人データを直ちに削除 (取り消せない)・削除の前に書き出せる・組織のオーナーと家族グループの代表者は譲渡するか解散するまで退会できない (F-59)・退会後に残るものはプライバシーポリシー第12条・改定後の同意の前も退会と書き出しを行える (利用規約第24条 2 項。R-1・R-24・cross/08 §16・F-40・P-12) |
| 未成年の扱い | 書いていない (F-1) | 利用規約第3条 3 項・第5条とプライバシーポリシー第15条: `LEGAL_FACTS.adultAgeYears` 歳未満は自分では登録できない・`coppaAgeYears` 歳以上 `adultAgeYears` 歳未満は保護者の同意書への同意のうえでアカウントが保護者の家族グループにつながった場合だけ使える・`coppaAgeYears` 歳未満は本人名義のアカウントを作らず、保護者は名前・生年月日・性別だけを登録できる (F-33)・つながった未成年者の記録が保護者に見えるかは本人の共有の設定による・つながりが無くなると退会とデータの書き出しだけができる・生年月日は年齢の確認に使い、つながりの無い 18 歳未満の自己登録は生年月日を記録せずに断る (F-50)・請求は本人または保護者から (R-13・cross/14) |
| 要配慮個人情報の取得の同意 | 現行 `/privacy` 第2条は「健康に関する情報（アレルギー、生活習慣など）を収集」と書くだけで、要配慮個人情報に当たること・取得の同意の取り方は書いていない (F-2) | プライバシーポリシー第5条: 健康診断・血液検査の結果・病歴・服薬・妊娠の有無は要配慮個人情報に当たる・入力は任意・本人が自ら入力・撮影・アップロードする操作をもって取得の同意とする・AI 事業者へ送るのは第6条の同意がある場合だけ・家族にも組織の管理者にも表示しない・読み取りの写真は保存しない・オプトアウトによる提供はしない (R-6・法 20 条 2 項・F-22) |
| 外国にある第三者 (AI 事業者) への提供 | 現行 `/privacy` 第5条: 日本国外の事業者の AI に画像とテキストが送られる場合がある旨と、事業者の一覧 (`AI_CONSENT_PROVIDERS`。国と使い道) だけ。所在国の制度の情報・事業者の措置の情報・同意の取り方は書いていない (F-2) | プライバシーポリシー第6条: 同じ一覧 (`ctx.aiProviders`) に加えて、法 28 条の外国にある第三者への提供として同意を得ること・送る情報の種類・目的・所在国の制度の情報 (アメリカ合衆国・エストニア)・事業者の措置 (API の利用契約と各社の規約)・同意の取り方・撤回・同意の版の更新・提供の記録 (同意の記録) とその開示 (R-7・法 28 条 2 項・規則 17 条・F-26・F-29) |
| 取得する情報 | 現行 `/privacy` 第2条の短い列挙 | プライバシーポリシー第3条の表に種類の水準で 16 区分 (アカウント・有料プラン (v1.17。billing/03 §11.2)・プロフィール・食事と献立・レシピ・健康・毎日のコンディション・AI 相談・記録の継続と比較・家族グループ・組織・お問い合わせ・サポート・請求・同意の記録・端末・利用状況・ログ・運営の記録・Cookie 等)。利用者に紐づく表の全体 (書き出しの一覧 52 + 書き出さない一覧 38) を第3条の区分か載せない理由に対応させ、T-34 が固定する (R-27・F-42) |
| 保存期間 | 書いていない (現行 `/privacy` に保存期間の条は無い。F-2) | プライバシーポリシー第12条の表 (18 行。情報の種類ごとの保存の期間): アカウントと紐づく情報 (退会まで)・公開の状態のユーザーコンテンツ・保護者の署名の記録 (期限を定めない。F-30・F-53)・解散した家族グループ (解散から `LEGAL_FACTS.dissolvedFamilyGroupRetentionDays` 日。F-53)・非表示にしたコンテンツ・ログインの履歴とセッション・アプリの動作のログ・送信待ち・回数の制限の計数・お問い合わせとサポートと請求 (F-36)・招待と所属の変更・AI 事業者の呼び出しの記録・栄養の計算の確認の記録と AI が作った料理のデータ・法令や不正防止の記録・送信停止の記録・退会の記録・バックアップ・AI 事業者に送った内容 (F-46)。日数は `LEGAL_FACTS` から埋め、T-3〜T-5・T-8・T-39 が正本と突き合わせる (R-11・F-14) |
| 開示等の請求の手続 | 現行 `/privacy` 第6条: 本人から開示・訂正・削除を求められたら本人確認のうえ遅滞なく応じる (請求の画面・本人確認の方法・期限・手数料・第三者提供の記録の開示は書いていない) | プライバシーポリシー第14条: 請求の種類 (利用目的の通知・開示 (第三者提供の記録を含む)・訂正・追加・削除・利用の停止・消去・第三者提供の停止)・本サービスの請求の画面から・登録のメールアドレスへ本人確認のリンク・遅滞なく対応し `dsrResponseDueDaysDefault` 日以内を目安・応じられない場合は理由を知らせる・手数料なし・凍結中・退会後・ログインできない人・代理人は `/contact` から (R-9・R-10・F-13・cross/15) |
| ログの IP と国の公表 | 無い | 第3条の端末・利用状況・ログの区分: ログインの記録は IP アドレスとそのネットワークの範囲・通信から判定した国を含む (F-17) |
| 外部送信の公表 | 無い | 第10条の表 8 行 (Supabase・当社の Cookie・アプリ内のブラウザの保存領域・Vercel・Cloudflare (ボットの判定)・Google・祝日の一覧 (GitHub Pages)・Expo)。CSP の外部の許可先 (`script-src`・`frame-src`・`img-src`・`connect-src`) と T-29 で突き合わせる (`images.unsplash.com` は画像の最適化を通るので行を持たない。F-15)。決済の画面の行は #1912 が足す |
| AI 事業者へ送る情報 | 現行 `/privacy` 第5条は「解析や生成に必要な範囲で画像データおよびテキストデータ」とだけ書く (同意画面の 6 項目 (`AI_CONSENT_COPY.dataCategories`) より粗い) | 実際の送信 (プロフィール・健康の項目・ニックネーム (F-29)、AI 相談が読む健康の記録・食事と献立・冷蔵庫の食材・買い物リスト・保存したレシピ・バッジ・過去の相談の要約 (F-43)、体重計・体組成計の写真 (F-48)) を種類の水準で。AI 相談が読む表と第6条の項目の対応は T-36 |
| 改定の知らせ方 | 無い | 施行日の前に運営のお知らせ (ホーム) に掲載 → 施行日にデプロイ → 再同意 (§9.4)。v2026.1 の公開は予告を行わない (P-12・§9.4 の 2)。メールでの知らせは仕組みが無いので約束しない (F-34) |
| 同意の前の退会・書き出しの手段 | 書いていない | 同意の前でも、本人が退会とデータの書き出しを行える (画面は同意画面の下の `/legal-consent/account`)。データの写しは開示の請求でも求められる (利用規約第17条 1 項・第24条 2 項・プライバシーポリシー第13条 4 項)。運営が代わりに削除する経路は無いので、お問い合わせによる削除は約束しない (F-32・F-40・Q-23・P-12) |
| メールの配信 | 書いていない | 当社からの連絡はメール・本サービス上の表示・プッシュ通知で行う (利用規約第19条)。プッシュ通知は本サービスの設定か端末の設定で止められる。苦情や不達のアドレスには送信を止め、その記録は残す (プライバシーポリシー第16条。F-34) |
| 同意の記録の IP・端末の種類 | 書いていない | 規約・ポリシーの同意も IP と端末の種類を記録すると第3条に書く (F-17)。IP・User-Agent を持つ表は T-30 が第3条と突き合わせる (F-37) |
| 本文の主張と根拠 | 無い (条ごとの要約の対応表。v1.7 まで) | 本文の 1 文 = 1 行の主張の表 (`LEGAL_CLAIMS`。区分と根拠つき) と、本文と表の 1 対 1 を確かめる T-35 (R-26・§10) |
| 運営の操作の記録 | 書いていない | 運営担当者が利用者のデータを変更する操作を記録していると書く (第11条。F-41) |
| 個別規定との優先関係 | 現行 `/terms` 第1条は適用だけで、個別規定 (特定商取引法に基づく表記・保護者の同意書・AI の同意の文書) との優先関係を書いていない | 利用規約第1条 3 項: 個別規定は本規約の一部を構成し、本規約と食い違うときは本規約が優先する。個人情報の取扱いはプライバシーポリシーが本規約とほかの個別規定に優先する。保護者の同意書・同意しない人の画面の、実装に無い約束 (§17 の「公開の前」の行) が規約の一部として優先しないようにするため。食い違いそのものは公開の前に直す (§9.4 の 3・Q-23・Q-27) |
| 写真の保存 | 現行 `/privacy` 第2条は「食事画像」を収集するとだけ書く | 食事の写真と冷蔵庫の写真は取得する (第3条)。健康診断・血液検査の結果と体重計・体組成計の表示の写真は数値の読み取りに使うだけで保存しない (プライバシーポリシー第5条 4 項。F-52・T-41) |
| 登録のメールアドレスの見え方 | 書いていない | 招待を承諾して参加したメンバーの、参加の時点の登録のメールアドレスは、承諾した招待の宛先として残り、家族のメンバー・組織の管理者が閲覧できる状態になる (退出した後も残る。プライバシーポリシー第9条 4 項。F-51・T-32) |
| 解散した家族グループ | 書いていない | 解散から `LEGAL_FACTS.dissolvedFamilyGroupRetentionDays` 日で削除し、保護者の同意の記録を持つグループは残す (利用規約第11条 5 項・プライバシーポリシー第12条。F-53・T-39) |
| 画面の名前の引用 | 無い | 引用しない。v1.11 で引用していた設定の項目とホームの区画の名前は本文から外した (R-28・T-40)。操作の案内は使い方ガイドへのリンク (`GUIDE_PATH`) と、文書・請求の窓口・お問い合わせへのリンクだけ |

### 11.3 ③状態遷移表 (利用者の同意の状態 × 出来事 → 遷移先・ガード・副作用)

状態: `none` (未同意 = 同意した版が無い。`user_profiles` の行が無い人を含む) / `old` (v2025.1 に同意) / `current` (v2026.1 に同意)。これと独立に、18 歳未満の本人には「保護者の同意とのつながり」の有無 (無ければ gap `guardian_consent`) と、凍結の有無がかかる。凍結は `user_profiles.frozen_at` / `unban_at` (`src/lib/auth/frozen.ts:10-31`) なので、凍結されうるのは `user_profiles` の行がある人だけ (`none` でも行があれば凍結されうる。§11.1 の凍結中の行と同じ)。

判定の順 (F-28): `/api` は 凍結 → メンテナンス → 同意、画面は メンテナンス → 凍結 → 同意。**凍結は同意ゲートより先に効く**ので、凍結中の利用者は版に関わらず同意画面に進めず、`/frozen` を見る。凍結が解けた後の最初の画面の取得で、版が古ければ同意画面へ回る。

| 状態 | 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| old | 版上げをデプロイ | old (判定が未同意になる) | — | 次の画面の取得で `/legal-consent`。`/api` は 403。プッシュは止まる |
| old / none | 同意画面で「同意して続ける」 | current | body の版 = `LEGAL_DOCUMENTS` (違えば 409)。生年月日 (無い人)。13 歳未満・つながりの無い 18 歳未満は `LEGAL_MINOR_SELF_SIGNUP_REFUSED` | `user_profiles` 2 列 + `legal_accepted_at`・`terms_acceptances` 2 行。元の画面へ。プッシュ再開 |
| old / none | 「同意しない（ログアウトする）」 | old / none | — | signOut。請求画面・問い合わせへのリンク |
| old / none (凍結でない。18 歳未満の案内 (`minor_refused` / `guardian_missing`) が出る人を含む) | 退会 (`/legal-consent/account`。v1.14) | (削除) | 退会の本体 (`deleteAccount`) のガードは同意済みの人と同じ (組織のオーナー・家族の代表でない。`findBlocker`) | 退会の画面 (`/settings`) は同意画面へ回る (F-32) が、同意画面の下の `/legal-consent/account` は同意ゲートの対象外で開き、`POST /api/account/delete` は同意の許可リストにあるので通る。入口は同意画面のフォームの下・未成年の案内・「同意しない」の後の案内 (ログインの後に戻る)。即時削除のあと端末のデータを消してログアウトし「退会しました」(`LEGAL_CONSENT_COPY.accountDeletedHeading`)。組織のオーナー・家族の代表者は 409 で、同意の前は譲渡の API (`/api/family/*`・`/api/org/*`) が止まるので、サーバーの文に続けて `LEGAL_CONSENT_COPY.accountDeleteBlockedGuidance` (解散すると退会できる・同意したうえで譲渡もできる) を出し、その場に解散の区画を出す (解散の API は同意の許可リストにある。family/11 §15.4)。利用規約第17条 1 項・第24条 2 項とプライバシーポリシー第13条 4 項 (P-12・Q-23) |
| current | 退会 | (削除) | 組織のオーナー・家族の代表者でない (`findBlocker`) | 即時削除。`terms_acceptances`・`external_data_consents` も消える (F-26)。利用規約第17条・プライバシーポリシー第12条・第13条のとおり残るものだけ残る |
| current | 退会 (組織のオーナー・家族の代表者) | current (退会できない) | `findBlocker` に当たる | 409 `ACCOUNT_DELETE_BLOCKED_ORG_OWNER` / `ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE` → 画面はメンバーシップ設定 (譲渡か解散) へ案内 (`ACCOUNT_DELETE_BLOCKED_GUIDE`)。譲渡の相手は 18 歳以上のメンバー (承諾できるのは 18 歳以上。F-38)。譲渡が済むか、本人が解散する (F-59。family/11 §10.3) と次の退会で上の行 (利用規約第11条 4 項・第12条 4 項・第17条 2 項) |
| current | 家族グループから退出 (代表者以外) | current | `leave_family` が代表者を断る (`IS_FAMILY_REPRESENTATIVE`) | 行の `status` が `left` になり、ほかのメンバーはその人の食事の記録と献立を読めなくなる (F-49)。その人が招待を受けて参加していた場合、承諾済みの招待とその宛先のメールアドレス (参加の時点の登録のアドレス) は招待の一覧に残り、代表者と大人が読める (F-51。プライバシーポリシー第9条 4 項)。未成年者なら保護者の同意とのつながりが切れる (下の行) |
| old / none (凍結でない) | 家族グループ・組織の操作 (招待の承諾による参加・退出・メンバーを外す・代表者やオーナーの譲渡の提案と承諾) | old / none (所属は変わらない) | `/api/family/*`・`/api/org/*` は同意の許可リスト (`packages/shared/src/legal-consent-api.ts:103-133`) に無い | 403 `LEGAL_CONSENT_REQUIRED` (§12)。画面は同意画面へ回る。同意すると current になり、current の行 (退会・退出) と同じ。本文 (利用規約第11条・第12条) は同意の前のこの操作について約束をしていない |
| none / old / current (凍結中) | 家族グループ・組織の操作 (同上) | 同じ状態のまま (所属は変わらない。凍結も続く) | `/api/family/*`・`/api/org/*` は凍結の例外 (`src/lib/auth/frozen.ts:60-66`) に無い。凍結の判定は同意より先 (F-28) | 403 `AUTH_ACCOUNT_FROZEN` (§12)。凍結の解除の後は、版に応じて上の行か current の行 |
| old / none (凍結でない。18 歳未満の案内 (`minor_refused` / `guardian_missing`) が出る人を除く) | 請求・問い合わせ | old / none | — | 画面 (`/settings/data-requests`・`/contact`) は同意ゲートの対象外で開け、API も許可リストで通る |
| old / none (凍結でない。18 歳未満の案内 (`minor_refused` / `guardian_missing`) が出る人を含む) | 書き出し (`/legal-consent/account`。v1.14) | old / none | — | 画面 (`/settings`) は同意画面へ回るが、`/legal-consent/account` の「データをエクスポート」で `GET /api/account/export` (許可リスト) が JSON を返す (アプリの WebView ではネイティブへ送って保存)。データの開示は請求 (開示) でも行える (プライバシーポリシー第13条 4 項)。有料プランの解約の API (`/api/billing/subscription*`・`/api/billing/portal`) も許可リストにあるが、有料プランを売っていない (F-57) ので本文は書かない。同意の前の解約の手段は #1912 が決める (Q-21) |
| current | 文面だけの修正 (版据え置き) | current | §9.3 | 何も起きない |
| current | 次の内容が変わる改定 (v2026.2) | current (判定が未同意になる) | — | 最初の行と同じ |
| current | 凍結 | current | — | 画面は `/frozen`。例外の API だけ通る |
| old / none | 凍結 | old / none | `user_profiles` の行がある (凍結の列はこの表にある) | 画面は `/frozen` (同意画面より先。F-28)。`/legal-consent` へは進めず、`POST /api/legal/accept` も 403 `AUTH_ACCOUNT_FROZEN` (同意できない)。凍結の例外 (退会・書き出し・解約 3 本・お問い合わせの送信) は同意の許可リストにもあるので通る。プッシュは `account_frozen` で止まる。`/terms` `/privacy` は読める |
| old (凍結中) | 凍結の解除 (解除予定の日時の経過・運営の解除) | old | — | 次の画面の取得で `/legal-consent` (「改定されました」= `introReconsent`)。同意すると current |
| none (凍結中) | 凍結の解除 (同上) | none | — | 次の画面の取得で `/legal-consent` (「ご利用いただくには同意が必要です」= `introFirst`。生年月日の無い人は生年月日も)。同意すると current |
| current (凍結中) | 凍結の解除 (同上) | current | — | 同意画面は出ず、通常どおり使える。プッシュは次回から届く |
| none / old / current (凍結中) | 退会 (`/frozen` → `/frozen/account`) | (削除) | 退会の本体 (`deleteAccount`) のガードは凍結でない人と同じ (組織のオーナー・家族の代表でない) | `POST /api/account/delete` は凍結の例外 (`FROZEN_ALLOWED_API_PATHS`) と同意の許可リストの両方にあるので、版に関わらず通る。即時削除。利用規約第16条 2 項・第17条、プライバシーポリシー第12条・第13条のとおり残るものだけ残る |
| none / old / current (凍結中) | データの書き出し (`/frozen/account`) | 同じ状態のまま (凍結も続く) | — | `GET /api/account/export` が JSON を返す (凍結の例外・同意の許可リストの両方にある)。利用規約第16条 2 項・プライバシーポリシー第13条 3 項 |
| none / old / current (凍結中) | 有料プランの解約 (`/frozen` → `/frozen/billing`) | 同じ状態のまま (凍結も続く) | 解約できる契約がある | `GET /api/billing/subscription`・`POST /api/billing/subscription/cancel` (期間末に解約)・`POST /api/billing/portal` が通る (凍結の例外・同意の許可リストの両方)。解約の取り消し・購入は通らない (`src/lib/auth/frozen.ts:57-66`)。有料プランを売っていない (F-57) ので、利用規約第16条 2 項は解約を書かない (#1912 が足す) |
| none / old / current (凍結中) | お問い合わせ (`/frozen` → `/contact`) | 同じ状態のまま (凍結も続く) | — | `/contact` は凍結の差し戻しの対象外、送信 (`/api/contact` の POST) は凍結中も通る (F-12・F-28)。開示等の請求も `/contact` から (プライバシーポリシー第14条・cross/15 S-13) |
| none / old / current (18 歳未満・つながり有り) | 保護者の同意とのつながりが切れる (家族から外れる・家族の解散・案内を断る / 取り消される / 期限が切れる) | 同じ状態のまま (gap に `guardian_consent` が加わる) | — | 次の画面の取得で `/legal-consent` に `guardianMissingHeading`・`guardianMissingBody` と退会ボタンと、退会と書き出しの画面へのリンク (同意のボタンは出ない。v1.14)。`/api` は 403 `LEGAL_CONSENT_REQUIRED` (許可リスト以外。退会と書き出しは通る)。プッシュの判定は版だけを見るので、current の人には届き続ける (F-7) |
| none / old / current (18 歳未満・つながり無し) | 保護者が家族に追加し直し、本人が案内を承諾する / 18 歳になる | 同じ状態のまま (gap の `guardian_consent` が消える) | — | current なら通常どおり使える。old・none なら同意画面 (版の同意) が残る |
| none / old / current (18 歳未満・つながり無し) | 退会 (「登録をやめる（アカウントを削除する）」) | (削除) | — | 即時削除 (`withdrawnHeading`・`withdrawnBody`) |
| any (家族グループのメンバー) | 運営が家族グループを解散する (代表者が長期間ログインしていないときなど。運営の一覧の判定は 30 日。F-21・F-39) | 同じ状態のまま | 運営の操作 | グループは `dissolved` になる。解散から `LEGAL_FACTS.dissolvedFamilyGroupRetentionDays` 日で、毎日のジョブがグループとメンバーの行・招待・未成年者の本人のアカウントをつなぐ案内を物理削除する。保護者の同意の記録を持つグループは削除せずに残す (F-53。利用規約第11条 5 項・プライバシーポリシー第12条)。つないだ未成年者は保護者の同意とのつながりが切れる (上の行) |
| any | デプロイを戻す (v2025.1) | current → 未同意判定 | — | v2026.1 に同意した人にも同意画面 (§9.4 の 6) |

#### 11.3.1 AI 事業者への提供の同意 (`external_data_consents`) の状態 × 出来事

利用規約第7条 1〜3 項とプライバシーポリシー第6条 (同意の 1〜5) が約束する、同意・撤回・再同意・版の更新の効果を、実装の遷移に対応させる。本書は AI の同意の仕組みを変えない (読むだけ)。

状態は事業者ごとに `summarizeAiConsent` (`supabase/functions/_shared/ai-consent.ts:122-153`) が決める: `granted` (現行の版 `AI_CONSENT_VERSION` への有効な同意の行がある) / `outdated` (有効な同意の行が古い版) / `none` (有効な同意の行が無い = 一度も同意していない・「同意しない」「あとで」(行を作らない。`src/lib/ai/consent.ts:23-24`)・撤回した)。AI 機能が使えるのは全事業者が `granted` のとき (`consented`) だけ。同意と撤回は全事業者の行をまとめて書き換えるので、下の表は全事業者が同じ状態として書く (事業者を足したときだけ、足した事業者が `none` になる。A-6 の行)。この状態は、上の表の利用規約・プライバシーポリシーの同意の状態と独立に持つ。`/api` では凍結と利用規約の同意の判定が先に効く (F-28)。

| # | 状態 | 出来事 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|---|
| A-1 | none / outdated | AI に送る操作 (写真の読み取り・献立の作成の依頼・AI 相談など) | 同じ | 送る手前の判定 `requireAiConsent` (`src/lib/ai/consent-guard.ts:72`) | 送らずに 403 `AI_CONSENT_REQUIRED` (§12)。画面は送る直前に同意画面を出し、「同意しない」「あとで」なら送らない。画面を開くと自動で動く AI の処理も行わない (利用規約第7条 1 項・3 項・プライバシーポリシー第6条の同意の 2) |
| A-2 | none / outdated | 同意画面で同意する (`POST /api/ai/consent`) | granted | body の版 = `AI_CONSENT_VERSION` (違えば 409 `AI_CONSENT_VERSION_MISMATCH`。`src/app/api/ai/consent/route.ts:98-107`) | 事業者ごとに、古い版の有効な行に `revoked_at` を入れて閉じ (撤回ではなく置き換え)、現行の版の行を作る。IP アドレスと端末の種類を記録する (`src/lib/ai/consent.ts:93-136`。プライバシーポリシー第6条の同意の 1) |
| A-3 | granted / outdated | 撤回 (Web の設定の「AI へのデータ提供の同意」= `AI_CONSENT_SETTINGS_PATH` (`src/lib/ai/consent-config.ts:69`)・アプリの `apps/mobile/app/settings/ai-consent.tsx` → `POST /api/ai/consent/revoke`) | none | 回数の制限なし。有効な同意が無ければ何も変えずに成功 (`src/app/api/ai/consent/revoke/route.ts:11-14`)。利用規約の同意が old / none の間と凍結中は、この API が同意の許可リスト (`packages/shared/src/legal-consent-api.ts:103`) にも凍結の例外 (`src/lib/auth/frozen.ts:60-66`) にも無いので 403 になる (A-7 の行・上の表の凍結の行) | 有効な行すべてに `revoked_at` を入れる。行は消さない (同意の記録として残り、書き出しと第三者提供の記録の開示に使う。`src/lib/ai/consent.ts:143-160`)。直後から A-1 の行の判定が止める (利用規約第7条 2 項・3 項・プライバシーポリシー第6条の同意の 2・3・5。本文は「本サービスの画面から確認し、撤回できます」と書き、画面の名前を引用しない) |
| A-4 | none (撤回の後) | 撤回の前に積んだ献立の作成の依頼を、キューのジョブが取り出す | none | ジョブが AI の同意を確かめる (`src/app/api/cron/process-menu-queue/route.ts:60-64`) | AI に送らず、依頼を失敗にする (`src/app/api/cron/process-menu-queue/route.ts:65-81`。fail-closed)。画面は失敗の文から同意画面へ案内する (プライバシーポリシー第6条の同意の 2「撤回した後は…送る手前で止めます」) |
| A-5 | none (撤回の後) | もう一度同意する | granted | A-2 の行と同じ | 撤回した行は履歴として残したまま、新しい行を作る (利用規約第7条 2 項・プライバシーポリシー第6条の同意の 3「再び利用するには改めて同意が必要」) |
| A-6 | granted | AI の同意の文面・事業者の一覧を変えて `AI_CONSENT_VERSION` を上げる (または事業者を足す) デプロイ | outdated (足した事業者は none) | — | `consented` が false になり、次に AI に送る操作で A-1 の行 → A-2 の行 (プライバシーポリシー第6条の同意の 4)。§17 の `consent-config.ts` の候補行を実施するとこれが起きる |
| A-7 | any | 利用規約・プライバシーポリシーの版上げ (本書の v2026.1) | 同じ (AI の同意は取り直さない) | — | 2 つの版は独立 (`LEGAL_DOCUMENTS` と `AI_CONSENT_VERSION`)。利用規約の同意が old / none の間は、`/api/ai/*` (撤回を含む) が 403 `LEGAL_CONSENT_REQUIRED` になり、設定の画面も同意画面へ回る。撤回は、改定後の内容に同意した後に設定から行える。キューのジョブ (A-4 の行) は AI の同意だけを確かめ、取り出しの RPC (`supabase/migrations/20261007160400_claim_menu_request_lease.sql`) も利用規約の同意と凍結を条件にしないので、版上げの前に積んだ依頼は AI の同意があれば処理される (本文はこの場合について約束をしていない。§18 Q-29) |
| A-8 | any | 退会 | (削除) | 上の表の退会の行と同じ | `external_data_consents` の行も消える (`ON DELETE CASCADE`。F-26・Q-16) |

---

## 12. エラー表

本書は新しいエラーコードを足さない。文面と版の流れ (§11.1・§11.3・§11.3.1 と、F-28 の判定の順) と、文面が書く退会・退出の制限で利用者に見えるのは既存の次のものだけ (変更なし)。利用者に見えない内部の記録のコードは §12.1 に分けて書く。最初の 3 行は `/api` の判定の順 (凍結 → メンテナンス → 同意) に並べる。

| 場面 | コード / 文 | 状態 | 正本 |
|---|---|---|---|
| 凍結中に `/api` を呼ぶ (凍結の例外 (`FROZEN_ALLOWED_API_PATHS` ほか) 以外。`POST /api/legal/accept` を含む。§11.3 の凍結の行) | `AUTH_ACCOUNT_FROZEN` 「アカウントが凍結されています」。判定は同意より先 (F-28) なので、凍結中は未同意でもこの 403 になる | 403 | `packages/shared/src/account-frozen.ts:15-30` (`ACCOUNT_FROZEN_CODE`・`ACCOUNT_FROZEN_STATUS`・`ACCOUNT_FROZEN_MESSAGE`)・`lib/supabase/middleware.ts:223-249` |
| メンテナンス中に `/api` を呼ぶ (運営ロール・止めないパス以外) | `MAINTENANCE_MODE`。判定は凍結の後・同意の前 (F-28) | 503 | `packages/shared/src/service-unavailable.ts:22` (`MAINTENANCE_API_CODE`)・`lib/supabase/middleware.ts:255-260` |
| 未同意で `/api` を呼ぶ (同意の許可リスト以外。家族グループ・組織の操作を含む。§11.3) | `LEGAL_CONSENT_REQUIRED` 「利用規約・プライバシーポリシーへの同意が必要です。同意の画面から内容をご確認ください。」 | 403 | `legal-consent-api.ts:35-39` |
| 同意を送ったら版が変わっていた | `versionMismatch` 「利用規約・プライバシーポリシーが更新されました。画面を読み込み直して、内容をご確認ください。」 | 409 | `legal-consent-copy.ts:23`・`api/legal/accept` |
| 18 歳未満の自己登録 | `LEGAL_MINOR_SELF_SIGNUP_REFUSED` | 同意画面の案内 | cross/14 |
| 同意の記録に失敗 | `acceptFailed` | 画面の文 | `legal-consent-copy.ts:27` |
| AI 機能を未同意で使う | `AI_CONSENT_REQUIRED` | 403 | `ai-consent.ts:51-56` |
| AI の同意を送ったら AI の同意の版が変わっていた (§11.3.1 A-2・A-5) | `AI_CONSENT_VERSION_MISMATCH`「同意の文面が更新されました。画面を開き直して、あらためてご確認ください。」(応答に現行の版 `currentVersion` を含む) | 409 | `src/app/api/ai/consent/route.ts:98-107` |
| 組織のオーナー・家族の代表者が退会する (利用規約第11条 4 項・第12条 4 項・第17条 2 項。§11.3) | `ACCOUNT_DELETE_BLOCKED_ORG_OWNER`「組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。」/ `ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE`「家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。」 | 409 | `src/lib/account-deletion.ts:248-285`・`src/lib/account-self-service.ts` の `ACCOUNT_DELETE_BLOCKED_GUIDE` (案内の行き先。family/11 §13.6) |
| 代表者が家族グループから抜ける・代表者を外そうとする | `IS_FAMILY_REPRESENTATIVE`「代表者はこの操作をできません。先に代表者を譲ってください。」 | 409 | `supabase/migrations/20261008090100_family_lock_order.sql:366-368, 413`・`src/lib/errors/membership-errors.ts:112, 209` |

### 12.1 内部の記録のコード (利用者には見えない)

プッシュ通知の送信待ちの行を送らなかった理由として、送信の cron が行に記録するコード (既存。変更なし)。利用者の画面にも API の応答にも出ない。判定の順は 凍結 → 未同意 (`decideEligibility`)。

| 場面 | コード | 結果 | 正本 |
|---|---|---|---|
| 宛先の利用者が凍結中 (§11.3 の凍結の行) | `account_frozen` (`PUSH_OUTBOX_ERROR_CODES.ACCOUNT_FROZEN`) | 送らない。判定は未同意より先 | `src/lib/push/outbox.ts:53, 253` |
| 同意の強制が on で、宛先の利用者が現行の版に同意していない (§11.3 の版上げの行・S-7・§9.2) | `consent_outdated` (`PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED`) | 送らない。再同意の後は届く (S-7) | `src/lib/push/outbox.ts:54, 254-259` |

---

## 13. テスト一覧 (it 名)

新設 `tests/legal-text-1901.test.ts` (文面モジュールとページ) と `tests/legal-document-body.test.tsx` (描画部品)。描画は既存のテストと同じく `react-dom/server` の `renderToStaticMarkup` + `vi.mock('next/link')`。`renderText` はタグを空白に置き換える (`tests/business-info-legal-pages.test.ts:70-73` と同じ)。

| # | it 名 | 何を固定するか |
|---|---|---|
| T-1 | `利用規約の h3 のうち「第N条」で始まるものは TERMS_ARTICLE_HEADINGS と同じ順・同じ数で、TERMS_ARTICLE_COUNT と一致する` | 条の列挙と宣言の数 |
| T-2 | `プライバシーポリシーの h3 のうち「第N条」で始まるものは PRIVACY_SECTION_HEADINGS と同じ順・同じ数で、PRIVACY_SECTION_COUNT と一致する` | 同上 |
| T-3 | `LEGAL_FACTS の値は正本の定数と一致する (ADULT_AGE_YEARS・COPPA_AGE_YEARS・HIDDEN_CONTENT_RETENTION_DAYS・LOGIN_HISTORY_RETENTION_DAYS・SESSION_IDLE_EXPIRE_DAYS・DSR_RESPONSE_DUE_DAYS_DEFAULT)` | 写しの一致 (`@homegohan/shared`・`@/lib/admin/hidden-content-restore`・`@/lib/auth/sessions/constants`・`@/lib/data-subject-requests/core` を import して比べる) |
| T-4 | `LEGAL_FACTS の app_logs・送信待ちの保持は migration の文字列と一致する` | `supabase/migrations/20251126124224_create_meal_planner_tables.sql` に `DELETE FROM app_logs WHERE created_at < NOW() - INTERVAL '${appLogRetentionDays} days'`、`20261016234000_email_outbox.sql` と `20261016237000_push_outbox.sql` に `interval '${outboxSentRetentionDays} days'` と `interval '${outboxDeadRetentionDays} days'` が含まれる (大文字小文字を区別しない) |
| T-5 | `LEGAL_FACTS のバックアップの保持は cross/17 §9.1 の表記と一致する` | `docs/design/cross/17-backup-automation.md` に `30 日で削除`・`366 日で削除`・`2,557 日で削除` と `(7 年)` が含まれる |
| T-6 | `利用規約・プライバシーポリシーの本文に、未完成や予定を示す語が無い` | `termsText(ctx)`・`privacyText(ctx)` を `LegalDocumentBody` で描いた本文 (§10.1 のテストの文脈) に、テストのローカル定数 `LEGAL_TEXT_PENDING_WORDS` (§13.1) のどの語も含まれない。`/coming soon/i` にも当たらない (R-32・P-9。文面モジュールが返す本文の語はこのテストが受け持つ。#1911 の `tests/no-pending-wording-1911.test.ts` も `src/lib` の下 (`src/lib/legal` を含む) をコメントの外で走査するが、無い機能を示す書き方 (§13.1 で足した語) は見ない) |
| T-7 | `PRIVACY_PROCESSORS の各行の evidence (file に needle) が実在し、needle と文面モジュールに外部のホスト名・URL が無い` | 委託先の表が実コードに当たる (`fs.readFileSync` で `includes`)。各 needle は `://` を含まず、ホスト名の形 (`/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i`) に当たらず、6 文字以上 (テストのローカル定数 `MIN_NEEDLE_LENGTH = 6`。根拠コメント: §7 の規則)。`src/lib/legal/` の `.ts` 4 本のソースに `https://` と `exp.host` が含まれない (送り先を 1 ファイルに限る走査テスト `tests/push-expo-boundary-scan.test.ts`・`tests/ai-consent-provider-inventory.test.ts` を、文面モジュールが赤にしないため。§16) |
| T-8 | `プライバシーポリシーの保存期間と請求の手順の数は LEGAL_FACTS から埋まっている` | 描画した本文に `非表示にしてから ${hidden} 日`・`失効してから ${login} 日`・`${sessionIdle} 日間操作が無い`・`${appLog} 日`・`送れたものは ${sent} 日`・`送れなかったものは ${dead} 日`・`${dsrDue} 日以内を目安`・`${daily} 日、週次のものは ${weekly} 日、年次のものは ${annual} 日（${years} 年）` が含まれる |
| T-9 | `利用規約第9条に cross/08 §8.1 と同じ医療免責の文と、救急（119）の案内がある` | `TERMS_MEDICAL_DISCLAIMER` が `docs/design/cross/08-legal-compliance.md` に逐語で含まれ、描画した本文に両方含まれる |
| T-10 | `利用規約第14条に AI 生成物の 3 項 (ユーザー帰属・匿名化した集計利用・CC0 相当) がある` | 描画した本文に `個人利用の範囲でユーザーに帰属`・`匿名化した形で`・`CC0 相当` が含まれる |
| T-11 | `文面モジュールは AI 事業者の名前を直接書かない (ctx の一覧が空なら本文に出ない)` | `privacyText({ …, aiProviders: [] })` の本文に `OpenAI`・`Perplexity`・`xAI`・`AI/ML API` が無い。`termsText` も同じ |
| T-12 | `AI 事業者の一覧は ctx の順で data-testid="privacy-ai-providers" の ul に「名前（国）：使い道」で出る。利用規約には出ない` | `/privacy` で `AI_CONSENT_PROVIDERS` の数と順。`/terms` に `privacy-ai-providers` が無い |
| T-13 | `文面モジュールは事業者名の形 (株式会社〇〇・〇〇 Inc) を直接書かない` | `termsText` / `privacyText` を `businessName: 'TESTCO'` で描いた本文に `株式会社` が無く、`/\b[A-Za-z]+,? Inc\b/` に当たらない |
| T-14 | `links ブロックの href はすべて実在する公開のページか請求の画面を指す` | href の集合 ⊆ { `/terms` `/privacy` `/legal` `/legal/parental-consent` `/settings/data-requests` `/contact` `/guide` }、かつそれぞれ `src/app` の中にルートグループ `(x)` を無視して `<path>/page.tsx` が実在する。ログインの後の設定の画面 (`/settings/ai-consent`・`/settings/security/sessions`・`/account/billing` など) を指さない (R-28) |
| T-15 | `section の id は一意で、terms- / privacy- で始まる` | アンカーの衝突防止 |
| T-16 | `プライバシーポリシー第1条の表と両文書の窓口は、ctx の事業者の情報を出す` | §10.1 のテストの文脈で描いた `privacyText(ctx)` の第1条 (`id: 'privacy-1'`) の `table` の行が、`[['事業者の名称', 'TESTCO'], ['所在地', 'TESTADDRESS'], ['代表者', 'TESTREP'], ['電話番号', 'TESTPHONE。ご請求は、contact@example.com またはお問い合わせフォームからお願いします。'], ['メールアドレス', 'contact@example.com'], ['営業時間', 'TESTHOURS']]` と等しい。`termsText(ctx)`・`privacyText(ctx)` の `contact` ブロックの `email` はどれも `ctx.businessEmail` で、各文書に 1 つ以上ある。電話番号の行の文は、#1911 の `PhoneOnRequest` の文 (`/legal`・`/company` の電話番号の欄) と同じ形 (`tests/business-info-legal-pages.test.ts` の電話番号の期待値と同じ組み立て) (R-31・P-10・F-56) |
| T-17 | `LEGAL_DOCUMENTS の 2 文書の版と施行日はそれぞれ同じで、版は仮置きの v2025.1 ではない` | 文面の作り込みに版上げが伴うこと (値そのものは固定しない。版の `not.toBe('v2025.1')` と、版・施行日それぞれの 2 文書の一致。施行日の形は既存の `legal-versions.test.ts` が見る) |
| T-18 | `/terms の h3 の数は TERMS_ARTICLE_COUNT + 1 (附則)、/privacy は PRIVACY_SECTION_COUNT + 1` | 描画とデータの一致 |
| T-19 | `/terms /privacy の本文に効果・成果の言い回しが無い` | `termsText(ctx)`・`privacyText(ctx)` を `LegalDocumentBody` で描いた本文 (2 ページが描く本文と同じもの。ページを描かないので段 A で書ける。ページそのものの走査は `public-claims-guard` が受け持つ。§16) に、テストのローカル定数 (export しない。§15) `LEGAL_TEXT_FORBIDDEN_CLAIMS = ['健康になれ', '改善します', '効果があります', '痩せ', '治ります', '予防できます']` が含まれない |
| T-20 | `docs/legal/archive/v2025.1/terms.md と privacy.md があり、旧版の条の見出しを含む` | `第1条（適用）`〜`第9条（準拠法・裁判管轄）` / `第1条（個人情報）`〜`第7条（お問い合わせ窓口）` |
| T-21 | `LegalDocumentBody は title が null の章に h2 を出さず、table に thead を出し、links を a で描く` | 描画部品 (`tests/legal-document-body.test.tsx`) |
| T-22 | `LegalDocumentBody は preamble を章の前に出す` | 前文の位置 |
| T-23 | `各 section の id が描画した HTML の id 属性に出る` | アンカー |
| T-24 | `プライバシーポリシー第7条の表の行数は PRIVACY_PROCESSORS.length と同じ` | 表とデータの一致 |
| T-25 | `プライバシーポリシーに、仮名加工情報・匿名加工情報を作成しない旨、AI 事業者への提供の記録、端末の機能の文がある` | 描画した本文に `仮名加工情報および匿名加工情報`・`提供の記録として、同意の記録`・`カメラ`・`写真ライブラリ`・`位置情報、連絡先、マイクの音声を取得しません`・`new URL(HOLIDAYS_API_ORIGIN).host` (祝日の一覧の送り先) が含まれる |
| T-26 | `apps/mobile/app.json の端末の権限の宣言は、既知の一覧に含まれる (新しい権限を足したら第3条の端末の機能の文を直す)` | `app.json` を `JSON.parse` し、`expo.ios.infoPlist` のうち `UsageDescription` で終わるキーの集合 ⊆ { `NSCameraUsageDescription`・`NSPhotoLibraryUsageDescription`・`NSPhotoLibraryAddUsageDescription` }、`expo.android.permissions` ⊆ { `CAMERA`・`READ_MEDIA_IMAGES`・`READ_EXTERNAL_STORAGE`・`WRITE_EXTERNAL_STORAGE`・`POST_NOTIFICATIONS`・`RECORD_AUDIO` に `android.permission.` を付けたもの }。既知の一覧はテストの中の定数 (根拠コメント: F-25。使っていない宣言は §17 の候補) |
| T-27 | `アプリの更新の取得 (EAS Update) は無効のまま (有効にしたらプライバシーポリシー第10条に送り先の行を足して版を上げる)` | `apps/mobile/app.json` を `JSON.parse` し `expo.updates.enabled === false` と `expo.updates.checkAutomatically === 'NEVER'`。`apps/mobile/app`・`apps/mobile/src` の `.ts`/`.tsx` に `expo-updates` の import (`from 'expo-updates'` / `from "expo-updates"`) が無い (根拠コメント: F-15) |
| T-28 | `利用規約・プライバシーポリシーの約束の文は実装に合わせてある (責任の範囲・同意の前にできること・施行日の前のお知らせ・遅滞なく・写真と健康の見え方・AI に送る種類・送信停止の記録・ログの保存期間・ログインの記録の IP と国)` | `termsText(ctx)` を `LegalDocumentBody` で描いた本文に `本規約と個別規定の内容が異なるときは、本規約が優先します`・`ただし、個人情報の開示・訂正・利用停止・消去などの請求、お問い合わせ、退会とデータの書き出しは、同意の前でも行うことができます`・`改めて同意するまでの間も、退会とデータの書き出しを行うことができます`・`譲渡するまで、退会できません`・`施行日の前に本サービスのお知らせに掲載`・`本サービスは、無料で利用できます`・`第21条（損害賠償と責任の制限）に定める範囲で責任を負います` (第16条 5 項と第18条 4 項の 2 か所。出現の数が 2) が含まれ、`個別規定が優先します`・`重大な過失がある場合を除き、責任を負いません`・`アカウントと保存されたデータを削除します`・`お問い合わせから削除を依頼`・`家族グループの代表者と管理者`・`代わりに記録`・`家族グループを解散する必要があります`・`いつでも退会できます`・`保護者に届く案内`・`同意したうえで、退会`・`退会のみを行うことができます` (v1.14) が含まれない。`privacyText(ctx)` を同じく描いた本文に `遅滞なく対応します`・`家族グループのメンバーにも組織の管理者にも表示されません`・`持病、服薬、妊娠・授乳の状況`・`メールアドレスのまま残します`・`ブラウザのセキュリティ違反の報告を含みます`・`IP アドレスとそのネットワークの範囲、通信から判定した国`・`体重計・体組成計の写真`・`運営担当者が利用者のデータを変更する操作を記録しています`・`改めて同意するまでの間も、退会と書き出しを行うことができます` (v1.14) が含まれ、`氏名は送りません`・`個人情報の取扱いの責任者`・`ネットワーク単位にして保存`・`運営担当者の操作は記録します`・`代わりに記録`・`回まで送り直せます`・`いつでも退会できます` が含まれない (F-17・F-38・F-40・F-41・F-48)。設計書の §9.4 の 2 (改定の予告) の行がちょうど 1 行あり、その行が `同意の前でも開示等の請求・お問い合わせ・退会とデータの書き出し` を含み、`同意したうえで` を含まない (v1.14。利用規約第24条 2 項と食い違う予告を載せない。R-24・P-12) |
| T-29 | `CSP の外部の許可先 (script-src・frame-src・img-src・connect-src) は、プライバシーポリシー第10条の表に行がある送り先か、端末から送らない理由を持つものだけ` | `buildContentSecurityPolicy({ nonce: 'n', isDev: false, supabaseUrl: 'https://example.supabase.co' })` を `cspDirectivesOf` で分け、`CSP_DISCLOSED_DIRECTIVES` (4 つ) の値から `CSP_NON_EXTERNAL_SOURCE_PATTERN` に当たるもの (`'self'`・`'nonce-…'`・`'report-sample'`・`data:`・`blob:`) を除いた集合を作る。(1) その集合 = `CSP_EXTERNAL_ORIGIN_DISCLOSURE` のキーの集合 (§13.1。足りなければ赤、使われていないキーが残っても赤)。(2) 値が文字列のキーごとに、その語が `privacyText(ctx)` の第10条 (`id: 'privacy-10'`) の `table` ブロックの 1 列目のどれかに含まれる。(3) 値が `null` のキー (`images.unsplash.com`) ごとに、`src/` の `.ts`・`.tsx` (`__tests__` と `src/lib/security/csp.ts` を除く) でそのホストの文字列を持つファイルが 1 つ以上あり、どれも `next/image` を import し `unoptimized` を持たない (ブラウザは `/_next/image` を取り、そのホストへ直接取りに行かない。F-15)。また `apps/mobile/` の `.ts`・`.tsx` はそのホストの文字列を持たない。CSP に外部の許可先を足したら、`CSP_EXTERNAL_ORIGIN_DISCLOSURE` と第10条の表と版を一緒に直す (根拠コメント: F-15・§9.3) |
| T-30 | `IP アドレス・User-Agent を持つ表は、プライバシーポリシー第3条に載せた表か、載せない理由を持つ表のどちらかに入っている` | `packages/shared/src/database.types.ts` を行ごとに読み、`public` の `Tables` の範囲 (行 `    Tables: {` から次の行 `    Views: {` まで) で、6 字下げの `<表>: {` を表の始まり、8 字下げの `Row: {` から次の 8 字下げの `}` までを列として、列名がテストのローカル定数 `IP_UA_COLUMNS = ['ip_address', 'ip_network', 'user_agent', 'country_code']` のどれかである表の集合を作る。その集合が `DISCLOSED_IP_UA_TABLES` と `EXCLUDED_IP_UA_TABLES` (どちらもテストのローカル定数。根拠コメント: F-37) のキーの和と等しい。`DISCLOSED_IP_UA_TABLES` (表 → 本文の文): `user_sessions_metadata` → `IP アドレスとそのネットワークの範囲`・`terms_acceptances` → `利用規約とプライバシーポリシーに同意した版・日時・IP アドレス`・`external_data_consents` → `日本国外の事業者への提供に同意した版・日時・IP アドレス`・`parental_consents` → `保護者の同意の署名`。各文が `privacyText(ctx)` を `LegalDocumentBody` で描いた本文に含まれる。`EXCLUDED_IP_UA_TABLES` (表 → 理由): `admin_audit_logs` (運営担当者の IP)・`cookie_consents` (書き込む処理が無い)・`failed_invite_lookups` (書き込む処理が無い)・`catalog_sources` (個人の情報でない)。理由が「書き込む処理が無い」の 2 つは、`src`・`supabase/functions` の `.ts`/`.tsx` (テストを除く) に `.from('<表>')`・`.from("<表>")` が無く、`supabase/migrations` の `.sql` に `INSERT INTO` に続く `<表>`・`public.<表>`・`"public"."<表>"` が無いことも確かめる (書き込む処理を足したら赤になり、第3条に載せ直す) |
| T-31 | `プライバシーポリシー第11条の多要素認証の文は MFA_REQUIRED_ROLES に当たる (大きな権限を持つ担当者の仕組みと書き、運営担当者の全員とは書かない)` | `MFA_REQUIRED_ROLES` (`@/lib/auth/mfa/policy`) が `'admin'` と `'super_admin'` を含み、`'support'` を含まない。`privacyText(ctx)` を描いた本文に `大きな権限を持つ運営担当者のログインに多要素認証を用いる仕組みを設けています` が含まれ、`運営担当者のログインには多要素認証を求めています` が含まれない (F-35) |
| T-32 | `組織の管理者の画面が読む項目は、プライバシーポリシー第9条に書いた項目を超えず、承諾済みの招待は宛先のメールアドレスとともに一覧に残る` | `src/app/(org)/org/members/page.tsx` に `.select('id, nickname, org_role, joined_org_at')` が含まれる。`src/app/api/org/invites/route.ts` の GET の `.select(` の直後のテンプレートリテラル (バッククォートで囲んだ文字列) の中の列 (空白と `,` で分けた語) の集合が { `id`・`email`・`invited_role`・`status`・`department_id`・`token`・`expires_at`・`accepted_at`・`created_at`・`departments(name)` } と等しい (役割は `create_org_invite` が書く `invited_role`。旧い `role` 列は既定 `'member'` のまま書かれないので読まない。`status` は取り消し・拒否の招待を一覧で見分けるため)。`src/app/(org)`・`src/app/api/org` の `.ts`/`.tsx` (テストを除く) に `last_sign_in_at` と `employee_` が含まれない (最終ログインと社員番号を組織の画面に足したら赤になり、文面を直す。F-19)。`src/app/api/org/invites/route.ts` と `src/app/api/family/invites/route.ts` の GET (`export async function GET` から次の `export async function` まで。無ければファイルの終わりまで) に、承諾済みの招待を除く条件 (`.is('accepted_at'`・`.not('accepted_at'`・`.eq('status'`・`.neq('status'`・`.in('status'`) が無い。`accept_org_invite`・`accept_family_invite` の最新の定義 (T-39 と同じ選び方) に `INVITE_EMAIL_MISMATCH` が、`accept_child_promotion` の最新の定義に `PROMOTION_EMAIL_MISMATCH` が含まれる。`privacyText(ctx)` を描いた本文に `組織の管理者に表示されるのは、メンバーの表示名、組織内の役割、参加した日` と `参加の時点で登録していたメールアドレスは、承諾した招待の宛先として残り` が含まれる (一覧から承諾済みを除いたら赤になり、第9条 4 項を直す。F-51) |
| T-33 | `利用規約・プライバシーポリシーの有料プランの条文は billing/03 §11 のとおりで、有料の語は有料の条文の節にだけ出て、委託先の表に決済の事業者と RevenueCat がある` | (1) `termsText(ctx)` の `terms-10` の最初の `ol` の `items` が、テストのローカル定数 `PAID_TERMS_10_ITEMS` (§13.1。billing/03 §11.1 (a) の 11 項を逐語で持つ) と等しい。(2) `legalTextUnits` (§13.1) の単位のうち `LEGAL_TEXT_PAID_TERMS` (§13.1) のどれかを含む単位が 1 つ以上あり、その `section` はどれもテストのローカル定数 `PAID_TERMS_SECTIONS` (§13.1) のどれか (有料の語をほかの条に足したら赤になる)。(3) `PRIVACY_PROCESSORS` の `name` に `Stripe` と `RevenueCat` があり、`Apple` が無い (billing/03 Q-17)。(4) `TERMS_ARTICLE_HEADINGS[9]` が `'第10条（料金）'` (R-30・billing/03 §11.5。v1.17) |
| T-34 | `利用者に紐づく表は、すべてプライバシーポリシー第3条の行か、載せない理由のどちらかに入っている` | テストのローカル定数 `PRIVACY_DATA_TABLES` (表 → 第3条の表の 1 列目の値) と `PRIVACY_DATA_EXCLUDED` (表 → 理由。`'no_writer'`・`'operator_only'` のどちらか) を §13.1 のとおり置く。(1) `ACCOUNT_EXPORT_TABLES` の `table` と `ACCOUNT_EXPORT_EXCLUDED` のキーの和集合 (`@/lib/account-export-tables`) が、2 つの定数のキーの和と等しく、2 つの定数のキーは重ならない。(2) `PRIVACY_DATA_TABLES` の値はどれも、`privacyText(ctx)` の第3条 (`id: 'privacy-3'`) の最初の `table` ブロックの行の 1 列目のどれかと等しい。(3) 第3条のその表の行の 1 列目のうち `Cookie 等` 以外は、どれも `PRIVACY_DATA_TABLES` の値に 1 回以上出る。(4) 理由が `'no_writer'` の表は、`src`・`supabase/functions`・`lib`・`packages/shared/src`・`apps/mobile/src`・`apps/mobile/app` の `.ts`/`.tsx` (テストを除く) で、`.from('<表>')`・`.from("<表>")` から次の `;` までに `.insert(`・`.upsert(` が無く、`supabase/migrations` の `.sql` (`.down.sql` を除く) に `INSERT INTO` に続く `<表>`・`public.<表>`・`"public"."<表>"` が無い (書き込む処理を足したら赤になり、第3条に載せる)。 有料プランの表 (`personal_subscriptions`・`billing_customers`・`coupon_redemptions`) は第3条の「有料プラン」の行に入れた (billing/03 §11.5。v1.17) (R-27・F-42) |
| T-35 | `利用規約とプライバシーポリシーの本文の主張 (1 文と表の 1 行) は、主張の表 LEGAL_CLAIMS と 1 対 1 で対応し、根拠を持つ` | §10.1 の規則のとおり。`legalTextUnits(document)` (§13.1) で `termsText(ctx)`・`privacyText(ctx)` (ctx は §10.1 のテストの文脈) の単位を作り、(1) 単位の数 = `LEGAL_CLAIMS.length` = `LEGAL_CLAIM_COUNT`。(2) 各行について、同じ `section` の単位のうち `fragment` を含むものがちょうど 1 つで、その単位の `length` が `chars` と等しい。(3) 各単位を含む行がちょうど 1 つ。(4) `id` は一意で `<section>#<数>` の形。(5) `basis` が `product` / `process` の行は `evidence` が空でない。(6) `evidence` の中の `F-<数>`・`P-<数>` は、`docs/design/cross/20-terms-privacy-text.md` に `\| F-<数> \|`・`\| P-<数> \|` の行があり、`evidence` の中のパス (正規表現 `/(?:\.github\|src\|lib\|supabase\|packages\|apps\|tests\|docs)\/[\w./()[\]@-]+?\.(?:tsx\|ts\|sql\|md\|json\|yml\|mjs\|js)(?!\w)/g` に当たるもの。JS の `\w` は ASCII だけなので、日本語の文字の前で止まる。後ろの `:行` は含まない) が実在する。失敗の文には、対応しない単位の文を出す (直す人が表の行を作れるように) (R-26・§10) |
| T-36 | `AI 相談が AI 事業者へ送る文のために読む表は、すべてプライバシーポリシー第6条の送る情報の項目に対応している` | `src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts` のソースから `.from('<表>')` の表の集合を取り、テストのローカル定数 `AI_CONTEXT_TABLES` (表 → 第6条の `ul` の項目に含まれる語。§13.1) のキーの集合と等しい。各語は `privacyText(ctx)` の第6条 (`id: 'privacy-6'`) の最初の `ul` の項目のどれかに含まれる (route が読む表を足したら赤になり、第6条を直して版を上げる) (R-27・F-43) |
| T-37 | `家族の役割は代表者・大人・子どもの 3 つで、本人のアカウントをつないだ未成年者は大人になる (利用規約第11条の「代表者」とプライバシーポリシー第9条の「家族グループのメンバー」の前提)` | `supabase/migrations/20251126124224_create_meal_planner_tables.sql` に `CREATE TYPE "public"."family_role_enum" AS ENUM (` から `);` までの値が `'representative'`・`'adult'`・`'child'` の 3 つだけ。`supabase/migrations` の `.sql` (`.down.sql` を除く) に `family_role_enum` に値を足す文 (`ALTER TYPE` と `family_role_enum` と `ADD VALUE` が同じ文にあるもの) が無い。`accept_child_promotion` の最新の定義 (T-39 と同じ選び方) に `role = 'adult'` が含まれる。`termsText(ctx)` を描いた本文に `家族グループの代表者と管理者` が含まれない (F-38) |
| T-38 | `運営の操作の記録の文 (利用者のデータを変更する操作) は、記録の見張りに当たる` | `tests/admin-mutation-audit-coverage-1571.test.ts` に `'src/app/api/admin/moderation/[type]/[id]/route.ts POST': 'audited'`・`'src/app/api/admin/users/[id]/freeze/route.ts POST': 'audited'` が含まれる。`privacyText(ctx)` を描いた本文に `運営担当者が利用者のデータを変更する操作を記録しています` が含まれ、`運営担当者の操作は記録します`・`運営担当者の操作を記録しています` が含まれない (F-41) |
| T-39 | `解散した家族グループの削除の日数と、保護者の同意の記録を持つグループを残すことは、削除のジョブの関数と一致する` | `supabase/migrations` の `.sql` (`.down.sql` を除く) を名前の順に並べ、`purge_dissolved_family_groups` について、正規表現 `CREATE OR REPLACE FUNCTION\s+"?public"?\."?<名前>"?\s*\(` に当たる最後のファイルを選び、一致した位置から次の `$$;` までの文 (= 最新の定義。いまは `20261018010000_purge_dissolved_family_groups.sql`) に `interval '${dissolvedFamilyGroupRetentionDays} days'` と `NOT EXISTS (SELECT 1 FROM public.parental_consents` が含まれる。T-32・T-37 の「最新の定義」も同じ選び方。`privacyText(ctx)` を描いた本文に `解散から ${dissolvedFamilyGroupRetentionDays} 日が経過すると削除します`・`保護者の同意の記録があるグループは、同意の根拠として、削除せずに残します`・`家族グループが解散したときも残します` が含まれる。`termsText(ctx)` を描いた本文に `解散した家族グループの情報の扱いは、プライバシーポリシー第12条のとおりです` が含まれる (日数や残す条件を変えたら赤になり、第12条を直して版を上げる。F-53) |
| T-40 | `本文は画面の名前の引用と画面の道順を書かない` | `termsText(ctx)`・`privacyText(ctx)` の単位 (`legalTextUnits`。§13.1) の文と、`links` ブロックの `label` のどれも、テストのローカル定数 `SCREEN_REFERENCE_PATTERNS` (§13.1) のどの正規表現にも当たらない。単位の文と `label` のどれも、`SCREEN_NAMES` (§13.1。実装の画面の名前の定数 `AI_CONSENT_SETTINGS_ENTRY_TITLE` (`@/lib/ai/consent-config`)・`DSR_SETTINGS_ENTRY_TITLE` (`@homegohan/shared`) と、定数の無い名前) のどの名前も含まない (本文に画面の名前や道順を足したら赤になる。R-28・P-11) |
| T-41 | `健康診断・血液検査・体重計の写真を保存しない文は、読み取りの処理が Storage に書かないことに当たる` | (1) `PHOTO_READ_ONLY_SOURCES` (§13.1) の各ファイルのソースに `.upload(` と `storage.from(` が無い。(2) `src`・`apps/mobile/app`・`apps/mobile/src`・`supabase/functions` の `.ts`/`.tsx` (テストと、名前が `database.types.ts` のファイルを除く) で `report_image_url` を含むのは `src/lib/account-deletion-storage.ts` だけ。(3) `src/app/(main)/meals/new/page.tsx` のソースに `image_url` が無い (健康診断の保存の body に写真の URL を渡さない)。(4) `src/app/(main)/health/checkups/new/page.tsx` のソースに `記録には保存されません` が含まれる。(5) `privacyText(ctx)` を描いた本文に `数値の読み取りに使うだけで、本サービスには保存しません` が含まれ、`撮った写真は、第4条の目的で本サービスに保存し` が含まれない (写真を保存する処理を足したら赤になり、第5条を直して版を上げる。F-48・F-52) |
| T-42 | `公開の状態のユーザーコンテンツ (レシピ) は未ログインの人にも読める実装に、利用規約第13条が合っている` | (1) `supabase/migrations/20251126124224_create_meal_planner_tables.sql` に `GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipes" TO "anon"` が含まれ、`20251126124224_create_meal_planner_tables.sql` より後の `supabase/migrations` の `.sql` (`.down.sql` を除く) に、正規表現 `/REVOKE[^;]*ON\s+(?:TABLE\s+)?(?:"?public"?\.)?"?recipes"?\s+FROM[^;]*\banon\b[^;]*;/gi` に当たる文 (表 `recipes` の権限を `anon` から外す文。関数の `REVOKE` は当たらない) が無い。(2) `supabase/migrations` の `.sql` (`.down.sql` を除く) を名前の順に並べ、正規表現 `/(?:CREATE\|ALTER) POLICY\s+"Users can view public recipes"[^;]*;/g` に当たる文のうち最後のもの (いまは `20261009000500_hide_moderated_content.sql` の `ALTER POLICY`) に `is_public = true` が含まれ、`TO authenticated` が含まれない。(3) `src/app/api/recipes/route.ts` に `dbQuery.eq('is_public', true)` が含まれる。(4) `termsText(ctx)` を描いた本文に `ユーザーが公開の状態にしたユーザーコンテンツは、ログインしていない方を含め、誰でも閲覧できる状態になります` が含まれ、`他のユーザーに表示されます`・`レシピの作成、公開`・`「公開」に設定` が含まれない (未ログインの人に読めなくしたら赤になり、第13条を直して版を上げる。F-54) |

### 13.1 テストのローカル定数と単位の作り方 (正典)

T-6・T-29・T-33・T-34・T-36・T-40・T-41 の表と T-35 の単位の作り方。`tests/legal-text-1901.test.ts` の中にこのとおり置く (export しない)。

```ts
/** T-34: 利用者に紐づく表 → プライバシーポリシー第3条の表の行 (1 列目の値)。根拠: 設計書 cross/20 F-42 */
const PRIVACY_DATA_TABLES: Readonly<Record<string, string>> = {
  password_history: 'アカウント',
  personal_subscriptions: '有料プラン',
  billing_customers: '有料プラン',
  coupon_redemptions: '有料プラン',
  user_profiles: 'プロフィール',
  nutrition_targets: 'プロフィール',
  meals: '食事と献立',
  meal_ai_feedbacks: '食事と献立',
  meal_nutrition_estimates: '食事と献立',
  user_daily_meals: '食事と献立',
  planned_meals: '食事と献立',
  weekly_menus: '食事と献立',
  weekly_menu_requests: '食事と献立',
  pantry_items: '食事と献立',
  shopping_lists: '食事と献立',
  shopping_list_items: '食事と献立',
  shopping_list_requests: '食事と献立',
  meal_image_jobs: '食事と献立',
  nutrition_feedback_cache: '食事と献立',
  derived_recipes: '食事と献立',
  recipes: 'レシピ',
  recipe_collections: 'レシピ',
  recipe_collection_items: 'レシピ',
  recipe_likes: 'レシピ',
  recipe_comments: 'レシピ',
  health_records: '健康',
  health_goals: '健康',
  health_checkups: '健康',
  health_checkup_longitudinal_reviews: '健康',
  blood_test_results: '健康',
  blood_test_longitudinal_reviews: '健康',
  health_insights: '健康',
  daily_activity_logs: '毎日のコンディション',
  user_performance_checkins: '毎日のコンディション',
  performance_plans: '毎日のコンディション',
  ai_consultation_sessions: 'AI 相談',
  ai_consultation_messages: 'AI 相談',
  ai_action_logs: 'AI 相談',
  health_streaks: '記録の継続と比較',
  health_challenges: '記録の継続と比較',
  user_badges: '記録の継続と比較',
  user_badge_period_awards: '記録の継続と比較',
  user_metrics: '記録の継続と比較',
  user_segment_rankings: '記録の継続と比較',
  family_members: '家族グループ',
  family_groups: '家族グループ',
  family_invites: '家族グループ',
  family_promotion_requests: '家族グループ',
  ownership_transfer_proposals: '家族グループ',
  organizations: '組織',
  organization_challenge_participants: '組織',
  organization_challenge_ranking_exclusions: '組織',
  inquiries: 'お問い合わせ・サポート・請求',
  support_tickets: 'お問い合わせ・サポート・請求',
  support_ticket_messages: 'お問い合わせ・サポート・請求',
  data_subject_requests: 'お問い合わせ・サポート・請求',
  terms_acceptances: '同意の記録',
  external_data_consents: '同意の記録',
  parental_consents: '同意の記録',
  user_sessions_metadata: '端末・利用状況・ログ',
  user_push_tokens: '端末・利用状況・ログ',
  native_bridge_codes: '端末・利用状況・ログ',
  notification_preferences: '端末・利用状況・ログ',
  app_logs: '端末・利用状況・ログ',
  ai_usage_counters: '端末・利用状況・ログ',
  ai_usage_grant_claims: '端末・利用状況・ログ',
  llm_usage_logs: '端末・利用状況・ログ',
  email_outbox: '端末・利用状況・ログ',
  push_outbox: '端末・利用状況・ログ',
  experiment_assignments: '端末・利用状況・ログ',
  admin_user_notes: '運営の記録',
  membership_audit: '運営の記録',
  meal_nutrition_debug_logs: '運営の記録',
  gdpr_deletion_requests: '運営の記録',
};

/**
 * T-34: 第3条に載せない表と理由。根拠: 設計書 cross/20 F-42
 * no_writer = 書き込む処理が無い。operator_only = 運営担当者だけの情報。
 * 有料プランの表 (billing_customers・coupon_redemptions) は billing/03 §11.5 で第3条の「有料プラン」の行へ移した (PRIVACY_DATA_TABLES)
 */
const PRIVACY_DATA_EXCLUDED: Readonly<Record<string, 'no_writer' | 'operator_only'>> = {
  cookie_consents: 'no_writer',
  csat_feedbacks: 'no_writer',
  nps_surveys: 'no_writer',
  ai_content_logs: 'no_writer',
  recipe_requests: 'no_writer',
  recipe_flags: 'no_writer',
  moderation_flags: 'no_writer',
  announcement_reads: 'no_writer',
  email_delivery_logs: 'no_writer',
  referral_rewards: 'no_writer',
  buddies: 'no_writer',
  buddy_actions: 'no_writer',
  legacy_family_groups: 'no_writer',
  legacy_family_members: 'no_writer',
  family_meal_logs: 'no_writer',
  operator_mfa_backup_codes: 'operator_only',
};

/** T-36: AI 相談の route が読む表 → 第6条の送る情報の項目に含まれる語。根拠: 設計書 cross/20 F-43 */
const AI_CONTEXT_TABLES: Readonly<Record<string, string>> = {
  user_profiles: 'プロフィールの情報',
  user_daily_meals: '食事と献立の記録',
  planned_meals: '食事と献立の記録',
  nutrition_targets: '栄養の目標',
  health_records: '健康の記録',
  health_goals: '健康の目標',
  health_insights: '健康に関するヒント',
  user_badges: '獲得したバッジ',
  shopping_lists: '買い物リスト',
  shopping_list_items: '買い物リスト',
  pantry_items: '冷蔵庫の写真と食材',
  recipe_collections: '保存したレシピ',
  ai_consultation_sessions: 'それまでのやりとりとその要約',
  ai_consultation_messages: 'AI 相談に入力した文章',
  ai_action_logs: 'それまでのやりとりとその要約',
};

/**
 * T-6: 本文に書かない、未完成や予定を示す語。根拠: 設計書 cross/20 R-32・P-9
 * (#1911 の tests/no-pending-wording-1911.test.ts の語に、無い機能を示す書き方を足したもの)
 */
const LEGAL_TEXT_PENDING_WORDS: readonly string[] = [
  '準備中',
  '販売開始前',
  '近日',
  '公開予定',
  '確定次第',
  '決まり次第',
  '決まりましたら',
  '順次整備',
  '予定',
  'まだ',
  '今後',
  '現在、',
  '機能はありません',
  '未対応',
];

/** T-33: 有料プランの条文の語。PAID_TERMS_SECTIONS の節にだけ出てよい。根拠: 設計書 cross/20 R-30・P-9・billing/03 §11.5 */
const LEGAL_TEXT_PAID_TERMS: readonly string[] = [
  '有料',
  '自動更新',
  '自動的に更新',
  '解約',
  '返金',
  '決済',
  'Stripe',
  'RevenueCat',
  'アプリ内課金',
  'App Store',
  'Google Play',
];

/** T-33: 有料の語が出てよい節 (billing/03 §11 が有料の条文を足した節)。ほかの条に足したら赤。根拠: 設計書 billing/03 §11.5 */
const PAID_TERMS_SECTIONS: readonly string[] = [
  'terms-10',
  'terms-16',
  'terms-17',
  'terms-24',
  'privacy-3',
  'privacy-4',
  'privacy-7',
  'privacy-10',
  'privacy-12',
];

/** T-33: 利用規約第10条 (料金) の最初の ol の 11 項 (逐語)。根拠: 設計書 billing/03 §11.1 (a) */
const PAID_TERMS_10_ITEMS: readonly string[] = [
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
];

/**
 * T-40: 本文の文と links の label に書かない、画面の名前の引用と道順の形。根拠: 設計書 cross/20 R-28・P-11
 * 「設定の「…」」「設定画面の「…」」「ホームの「…」」「…の画面で」の引用と、v1.11 の links の「設定（…）」の形
 */
const SCREEN_REFERENCE_PATTERNS: readonly RegExp[] = [
  /(?:設定|設定画面|ホーム|メニュー|タブ)の「/,
  /設定（/,
  /「[^」]+」(?:の画面|画面|から開|を開)/,
];

/**
 * T-40: 本文に書かない画面の名前。定数のあるものは import して使う (AI_CONSENT_SETTINGS_ENTRY_TITLE・DSR_SETTINGS_ENTRY_TITLE)。
 * 定数の無いものは v1.11 の本文が引用していた名前。根拠: 設計書 cross/20 F-55・R-28
 */
const SCREEN_NAMES_WITHOUT_CONSTANT: readonly string[] = [
  'ログイン中の端末・ログイン履歴',
  'プランとお支払い',
  '今日のコンディション',
  '週間献立の画面',
];

/** T-41: 健康診断・血液検査・体重計の写真を受け取って読み取るだけで、Storage に書かない処理のファイル。根拠: 設計書 cross/20 F-48・F-52 */
const PHOTO_READ_ONLY_SOURCES: readonly string[] = [
  'src/app/api/ai/analyze-health-checkup/route.ts',
  'src/app/api/ai/analyze-weight-scale/route.ts',
  'supabase/functions/analyze-health-photo/index.ts',
  'apps/mobile/app/health/blood-tests.tsx',
];
```

```ts
// tsc:skip
// place=tests/legal-text-1901.test.ts の中 (新設モジュールを import するので単独検査から外す)
import type { LegalDocumentText } from '@/lib/legal/legal-text';
import { AI_CONSENT_SETTINGS_ENTRY_TITLE } from '@/lib/ai/consent-config';
import { DSR_SETTINGS_ENTRY_TITLE } from '@homegohan/shared';
import { CSP_TURNSTILE_ORIGIN, HOLIDAYS_API_ORIGIN } from '@/lib/security/csp';

/** T-29: 第10条の表と突き合わせる CSP のディレクティブ (外部の送り先を許すもの)。根拠: 設計書 cross/20 F-15 */
const CSP_DISCLOSED_DIRECTIVES: readonly string[] = ['script-src', 'frame-src', 'img-src', 'connect-src'];

/** T-29: CSP の値のうち外部の送り先でないもの (引用符つきのキーワード・nonce と、data: / blob: のスキーム) */
const CSP_NON_EXTERNAL_SOURCE_PATTERN = /^(?:'.*'|data:|blob:)$/;

/**
 * T-29: CSP の外部の許可先 → 第10条の表の 1 列目に含まれる送り先の語。
 * null は「端末からそのホストへ送らない」もので、理由をコメントに書く (T-29 の (3) が理由を確かめる)。根拠: 設計書 cross/20 F-15
 */
const CSP_EXTERNAL_ORIGIN_DISCLOSURE: Readonly<Record<string, string | null>> = {
  '*.supabase.co': 'Supabase',
  'wss://*.supabase.co': 'Supabase',
  '*.vercel.app': 'Vercel',
  // Speed Insights のスクリプトの配信元 (本番は同一オリジンから読むが、CSP は許可している)
  '*.vercel-scripts.com': 'Vercel',
  // Turnstile のスクリプト (script-src) と判定の枠 (frame-src)
  [CSP_TURNSTILE_ORIGIN]: 'Cloudflare',
  [HOLIDAYS_API_ORIGIN]: 'GitHub',
  // ログイン画面の背景の画像。next/image の最適化 (/_next/image) を通り、ブラウザは直接取りに行かない
  'images.unsplash.com': null,
};

/** 主張の単位 (設計書 cross/20 §10.1)。p / ul / ol は「。」で分けた 1 文、table は 1 行。links・ai_providers・contact は単位にしない */
interface LegalTextUnit {
  readonly section: string;
  readonly text: string;
}

const SENTENCE_END = '。';
const TABLE_CELL_JOINER = ' | ';

function legalTextUnits(document: LegalDocumentText): LegalTextUnit[] {
  const units: LegalTextUnit[] = [];
  const pushSentences = (section: string, text: string) => {
    for (const sentence of text.split(SENTENCE_END)) {
      const trimmed = sentence.trim();
      if (trimmed !== '') units.push({ section, text: trimmed });
    }
  };
  const pushBlocks = (section: string, blocks: LegalDocumentText['chapters'][number]['sections'][number]['blocks']) => {
    for (const block of blocks) {
      if (block.kind === 'p') pushSentences(section, block.text);
      else if (block.kind === 'ul' || block.kind === 'ol') block.items.forEach((item) => pushSentences(section, item));
      else if (block.kind === 'table') block.rows.forEach((row) => units.push({ section, text: row.join(TABLE_CELL_JOINER) }));
    }
  };
  const prefix = document.type === 'terms_of_service' ? 'terms' : 'privacy';
  if (document.preamble) pushBlocks(`${prefix}-preamble`, document.preamble);
  for (const chapter of document.chapters) {
    for (const section of chapter.sections) pushBlocks(section.id, section.blocks);
  }
  return units;
}

/** T-40: 本文に書かない画面の名前の全部 (定数のあるものは定数から) */
const SCREEN_NAMES: readonly string[] = [AI_CONSENT_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_ENTRY_TITLE, ...SCREEN_NAMES_WITHOUT_CONSTANT];
```

- `PRIVACY_DATA_TABLES` は 74 表、`PRIVACY_DATA_EXCLUDED` は 16 表 (書き込む処理が無い 15 表・運営担当者だけの 1 表)。和は書き出しの一覧 52 表と書き出さない一覧 38 表の和 90 表 (`src/lib/account-export-tables.ts:127, 284`。origin/main `a199f14a` で数え直した)。v1.17: 有料プランの 2 表 (`billing_customers`・`coupon_redemptions`) を `PRIVACY_DATA_EXCLUDED` から `PRIVACY_DATA_TABLES` の「有料プラン」へ移し、`personal_subscriptions` も「アカウント」から「有料プラン」へ移した (billing/03 §11.5。和は 90 のまま)。
- `AI_CONTEXT_TABLES` の語は、第6条の最初の `ul` の項目の部分文字列 (T-36 が確かめる)。キーは 15 表で、AI 相談の route の `.from('<表>')` の集合 (origin/main `a199f14a` で 15 表) と等しい。
- `CSP_DISCLOSED_DIRECTIVES` は 4 つ、`CSP_EXTERNAL_ORIGIN_DISCLOSURE` は 7 キー (送り先の語を持つ 6 キー・`null` の 1 キー。origin/main `5b85bb3f` の `src/lib/security/csp.ts:96-103` の外部の許可先の全部)。
- `LEGAL_TEXT_PENDING_WORDS` は 14 語、`LEGAL_TEXT_PAID_TERMS` は 11 語、`SCREEN_REFERENCE_PATTERNS` は 3 つ、`SCREEN_NAMES_WITHOUT_CONSTANT` は 4 つ、`PHOTO_READ_ONLY_SOURCES` は 4 ファイル、`PAID_TERMS_SECTIONS` は 9 節、`PAID_TERMS_10_ITEMS` は 11 項 (v1.17。`PAID_PLAN_WRITER_MIGRATIONS`・`PAID_PLAN_WRITER_DIR` は消した)。
- `AI_CONSENT_SETTINGS_ENTRY_TITLE` は `src/lib/ai/consent-config.ts` が `supabase/functions/_shared/ai-consent.ts:313` から再エクスポートする名前で、`DSR_SETTINGS_ENTRY_TITLE` は `packages/shared/src/data-subject-requests.ts:15` の定数 (F-55)。本文はこれらを引用しないので、文面モジュールは import しない (テストだけが import する)。

既存テストの追随 (§16): `tests/public-claims-guard.test.ts` の `PUBLIC_PAGES` に `/terms` `/privacy` の 2 ページ、`PUBLIC_SOURCE_FILES` に `src/lib/legal/terms-text.ts`・`src/lib/legal/privacy-text.ts` を足す (禁止語の走査を本文にも掛ける)。`tests/site-config-ui.test.tsx` の `SCREENS` から `/privacy` の行を外す (窓口は事業者のメールアドレスにしたため。T-16 が代わりに確かめる)。`src/__tests__/api/cron/push-outbox.test.ts:176` の `'v2025.1'` 2 つを `LEGAL_DOCUMENTS` の値に置き換える。

テストの道具 (いずれも既存のテストにある書き方):
- `vi.mock('next/link', …)` → `a`。
- `renderToStaticMarkup(createElement(Page))`。
- `stripComments` (`tests/business-info-legal-pages.test.ts` の同名の関数)。

---

## 14. 段分け (実装 WF は 1 本・同じ worktree。段ごとに 2 枚レビュー。マージは段 B のあと 1 回)

**着手の条件**: #1911 (「準備中」の表記を取り除く・事業者の情報の値を入れる) が main にマージされていること。`src/lib/business-info.ts` に `BUSINESS_ADDRESS`・`BUSINESS_EMAIL`・`BUSINESS_HOURS`・`PHONE_DISCLOSED_ON_REQUEST` があることを確かめてから段 A を始める (§8.3 のページと T-16 が使う。F-56)。#1911 がマージした名前が本書と違えば、main の名前に合わせる (§17 の #1911 の行。実装者は本書を書き換えず、PR の本文に読み替えを書く)。この条件は満たした (#1911 は #1916 4b1e1abe でマージ済み・名前は本書と同じ)。

| 段 | 中身 | 触るファイル | 確認 |
|---|---|---|---|
| A | 文面モジュールと描画部品 (ページは触らない) | 新設: `src/lib/legal/legal-text.ts`・`terms-text.ts`・`privacy-text.ts`・`index.ts`・`src/components/legal/LegalDocumentBody.tsx`・`tests/legal-text-1901.test.ts` (T-1〜T-11・T-13〜T-16・T-19・T-24〜T-42 の 35 本。下の割り振り表)・`tests/legal-claims-1901.ts` (主張の表。§10.3)・`tests/legal-document-body.test.tsx` (T-21〜T-23 の 3 本。T-21〜T-23 は `legal-text-1901.test.ts` ではなくこのファイルに置くので、上の範囲に入れていない。段 A の it は合わせて T-1〜T-11・T-13〜T-16・T-19・T-21〜T-42 の 38 本で、下の割り振り表と同じ) | `tsc`・lint・全件 (すべて緑。ページ未切替なので挙動は変わらない) |
| B | ページの差し替え・版上げ・旧版の控え・番兵の追随 | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx` (§8.3 の全文)・`packages/shared/src/legal-versions.ts` (§9.1)・`tests/public-claims-guard.test.ts` (§13.1 末尾)・`tests/site-config-ui.test.tsx` (`SCREENS` から `/privacy` の行を外す。§16)・`docs/legal/archive/v2025.1/terms.md`・`privacy.md` (現行 `page.tsx` の条を Markdown に写す。版 v2025.1・施行日 2025-01-01 を冒頭に)・`src/__tests__/api/cron/push-outbox.test.ts:176` (`'v2025.1'` 2 つを `LEGAL_DOCUMENTS.terms_of_service.version` / `LEGAL_DOCUMENTS.privacy_policy.version` に置き換え、`import { LEGAL_DOCUMENTS } from '@homegohan/shared'` を足す。§16)・`tests/legal-text-1901.test.ts` に残りの it (T-12・T-17・T-18・T-20) | `tsc`・lint・全件 (すべて緑。既知の赤は無い)。`effectiveDate` は仮の施行日 `'2026-10-19'` と行末の目印のコメントのまま残す (§9.1。公開日への置き換えはオーケストレーターがマージ直前に行う) |

テストの割り振り (§13 の 42 本。各 it はどちらか一方の段にだけ入る)。判定の基準: **段 A** = 読むものが文面モジュール (`termsText(ctx)` / `privacyText(ctx)` とその定数。描くときは `LegalDocumentBody` で描く)・描画部品・リポジトリのファイル (migration・設計書・`app.json`・`database.types.ts`・CSP の関数・組織の画面と API のソース) だけで、段 A の時点で緑にできるもの。**段 B** = 2 ページ (`src/app/terms/page.tsx`・`src/app/privacy/page.tsx`) を描くもの、または段 B で変える・作るもの (版 `LEGAL_DOCUMENTS`・旧版の控え) を見るもの。

| 段 | it | 読むもの (判定の理由) |
|---|---|---|
| A | T-1・T-2 | 文面モジュールの h3 と `*_HEADINGS`・`*_COUNT` |
| A | T-3〜T-5 | `LEGAL_FACTS` と正本の定数・migration・cross/17 |
| A | T-6 | 文面モジュールを描いた本文 (未完成や予定の語) |
| A | T-7 | `PRIVACY_PROCESSORS` の evidence のファイルと `src/lib/legal/` のソース |
| A | T-8〜T-11・T-13 | 文面モジュールを描いた本文 (T-9 は cross/08 も読む) |
| A | T-14〜T-16 | 文面モジュールの `links`・section の id・`contact` ブロックと第1条の表 (T-14 は `src/app` の `page.tsx` の実在も見るが、リンク先のページは段 A の時点で既にある。T-16 はテストの文脈の仮の値で描くので、`business-info.ts` の値に依らない) |
| A | T-19 | 文面モジュールを描いた本文 (T-19 の行のとおり) |
| A | T-21〜T-23 | 描画部品 (`tests/legal-document-body.test.tsx`) |
| A | T-24・T-25 | `privacyText(ctx)` の第7条の表と `PRIVACY_PROCESSORS`・描いた本文 |
| A | T-26・T-27 | `apps/mobile/app.json` (と T-27 は `apps/mobile` のソース) |
| A | T-28・T-31・T-33 | 文面モジュールを描いた本文 (T-31 は `MFA_REQUIRED_ROLES`、T-33 は `PRIVACY_PROCESSORS` も) |
| A | T-29 | CSP の関数と `privacyText(ctx)` の第10条の表と、`src/`・`apps/mobile/` のソース (画像のホストの使われ方) |
| A | T-30 | `database.types.ts`・`src`・`supabase` のソースと `privacyText(ctx)` を描いた本文 |
| A | T-32 | 組織の画面と API のソース・migration・`privacyText(ctx)` を描いた本文 |
| A | T-34 | `@/lib/account-export-tables` の 2 つの一覧・`privacyText(ctx)` の第3条の表・`src` などのソースと migration |
| A | T-35 | `termsText(ctx)`・`privacyText(ctx)` の単位・`tests/legal-claims-1901.ts`・本設計書 (F-n・P-n の行) と根拠のファイルの実在 |
| A | T-36 | AI 相談の route のソースと `privacyText(ctx)` の第6条 |
| A | T-37 | migration・`termsText(ctx)` |
| A | T-38 | 運営の記録の見張りのテストのソース・`privacyText(ctx)` |
| A | T-39 | 解散した家族グループの削除の関数の migration・`termsText(ctx)`・`privacyText(ctx)` |
| A | T-40 | 文面モジュールの単位と `links`・AI の同意と請求の入口の定数 |
| A | T-41 | 写真を読み取る route・Edge Function・アプリの血液検査の画面・記録と健康診断の画面のソース・`src` などの `report_image_url`・文面モジュールを描いた本文 |
| A | T-42 | レシピの権限と RLS の migration・`/api/recipes` の route・`termsText(ctx)` |
| B | T-12 | `/privacy`・`/terms` のページを描く (ページが `ctx.aiProviders` に `AI_CONSENT_PROVIDERS` を渡すことを見る) |
| B | T-17 | `LEGAL_DOCUMENTS` の版 (段 B で v2026.1 に上げる) |
| B | T-18 | 2 ページを描いた h3 の数 |
| B | T-20 | `docs/legal/archive/v2025.1/` (段 B で作る) |

段 A は 38 本 (`legal-text-1901.test.ts` 35 本・`legal-document-body.test.tsx` 3 本)、段 B は 4 本 (`legal-text-1901.test.ts`)。合わせて 42 本。

- 横断整合 (段 B のレビュー): `tests/business-info-legal-pages.test.ts`・`tests/policy-pages-public.test.tsx`・`tests/seo-public-pages-1867.test.tsx`・`tests/legal-consent-page.test.tsx`・#1911 の `tests/no-pending-wording-1911.test.ts` が変更なしで緑であること、`tests/site-config-ui.test.tsx` が `/privacy` の行を外したうえで緑であること (§16)。
- 変異試験 (B 型の Haiku の枠): 製品コードは `src/lib/legal/*.ts`・`LegalDocumentBody.tsx`・2 ページ・`legal-versions.ts`。守りの中心 = T-3〜T-5・T-8 (数の一致)・T-6・T-33・T-40 (未完成や予定・有料・画面の名前を本文に入れない)・T-11〜T-13・T-16 (名前と事業者の情報の混入)・T-17 (版)・T-28・T-31 (約束の文)・T-34〜T-36 (主張と取得する情報と送る情報の閉包)・T-32・T-39・T-41・T-42 (見える / 見えない・保存する / しないの分かれ目のコード)。

**段 C (v1.14。§18 Q-23・Q-27 の結論の反映。P-12)**: 段 A・段 B (wf_9f341b60-578) の上に、同じ枝で積む。

| 触るファイル | 中身 |
|---|---|
| `src/components/account/AccountSelfServicePanel.tsx` (新設) | 書き出しと退会の 2 つの枠。凍結中の `src/app/frozen/account/page.tsx` から切り出し、退会の後の動き (`onDeleted`)・409 の案内 (`deleteBlockedGuidance`)・401 (`onUnauthorized`)・要素の id の接頭辞 (`idPrefix`) を props で受ける |
| `src/app/frozen/account/page.tsx` | 上の部品を使う (見た目・文・id `frozen-*`・退会の後に `/login` へ移る動きは変えない) |
| `src/app/legal-consent/account/page.tsx`・`AccountWithoutConsent.tsx` (新設) | 同意の前の退会と書き出しの画面。未ログインは `/login?next=%2Flegal-consent%2Faccount`。退会の後は「退会しました」を出す (ログインの画面へ移らない) |
| `lib/legal-consent.ts` | `LEGAL_CONSENT_ACCOUNT_PATH = \`${LEGAL_CONSENT_PATH}/account\`` (同意画面の下なので、同意ゲートと初期設定の差し戻しの判定は変えない)。`/contact` のコメントから「データの削除の依頼もここから」を外す |
| `packages/shared/src/legal-consent-copy.ts` | `LEGAL_CONSENT_COPY` に `accountEntryLead`・`accountEntryLink`・`declinedAccountGuide`・`declinedAccountLink`・`accountPageHeading`・`accountPageIntro`・`accountDeleteBlockedGuidance`・`accountDeletedHeading`・`accountDeletedBody` を足す |
| `src/app/legal-consent/LegalConsentForm.tsx` | フォームの下と未成年の案内 (`minor_refused` / `guardian_missing`) に `/legal-consent/account` へのリンク。`declined` の画面の「保存されているデータの削除について」(お問い合わせによる削除の約束) を、もう一度ログインすれば同意しなくても退会と書き出しができる案内 (`/login?next=%2Flegal-consent%2Faccount`) に替える (お問い合わせへのリンクは残す) |
| `packages/shared/src/legal-consent-api.ts` | 許可リストの退会・書き出し・お問い合わせの行の `note` を直す (path・match・reason は変えない) |
| `src/lib/legal/terms-text.ts`・`privacy-text.ts` | 利用規約第5条 3 項・第17条 1 項・第24条 2 項とプライバシーポリシー第13条 4 項 (§6・§7)。版は v2026.1 のまま (公開の前なので上げない) |
| `tests/legal-claims-1901.ts`・`tests/legal-text-1901.test.ts` | 主張の表 (383 → 382 行。§10.2・§10.3) と T-28 の語 |
| `packages/shared/src/parental-consent.ts`・`src/app/(main)/family/members/child/new/page.tsx` | `PARENTAL_CONSENT_DOCUMENT_COPY` の 1〜4 段落・`minorRefusedBody`・`promotionUnderCoppaAge`・子どもの追加の画面の注意書き。`PARENTAL_CONSENT_DOCUMENT` を `{ version: 'v2026.2', effectiveDate: '2026-10-19' }` (施行日は仮置きと目印。§9.4 の 3) |
| テスト | 新設 `tests/legal-consent-account-page-1901.test.tsx`。追記 `lib/supabase/__tests__/middleware-legal-consent-api.test.ts` (未同意の 3 通りで退会と書き出しの API と画面は通り、家族・組織の譲渡と退出・AI の同意の撤回・プロフィール・食事の API は 403 のまま。凍結中は `/frozen` へ)・`tests/legal-consent-page.test.tsx` (リンクと `declined` の案内)・`packages/shared/src/parental-consent.test.ts` (同意書の約束の語と版)・`tests/family-child-new-page.test.tsx` (注意書き)・`tests/e2e/legal-consent-gate.spec.ts` (`declined` の案内) |
| `apps/mobile/app/legal-consent.tsx`・`apps/mobile/src/lib/legal-consent.ts` | コメントだけ (同意画面の WebView の案内の中身)。同意画面の下のパスは同じ WebView の中で開き、タブのパスでないので `tab-navigate` にならない。ネイティブの動きは変えない |

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
| ファイル | `legal-claims-1901.ts` (主張の表のデータ。§10.3。テストだけが import する) | `tests/` |
| ファイル | `terms.md`・`privacy.md` | `docs/legal/archive/v2025.1/` |
| ファイル (v1.14・段 C) | `AccountSelfServicePanel.tsx` | `src/components/account/` |
| ファイル (v1.14・段 C) | `page.tsx`・`AccountWithoutConsent.tsx` (route `/legal-consent/account`) | `src/app/legal-consent/account/` |
| ファイル (v1.14・段 C) | `legal-consent-account-page-1901.test.tsx` | `tests/` |
| 定数 (v1.14・段 C) | `LEGAL_CONSENT_ACCOUNT_PATH` | `lib/legal-consent.ts` |
| 文面のキー (v1.14・段 C) | `LEGAL_CONSENT_COPY` の 9 キー (§14 段 C) | `packages/shared/src/legal-consent-copy.ts` |
| 既存ファイルの変更 (新設ではない) | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx` (§8.3)・`packages/shared/src/legal-versions.ts` (§9.1)・`tests/public-claims-guard.test.ts` (`PUBLIC_PAGES` に 2 ページ・`PUBLIC_SOURCE_FILES` に 2 つの文面モジュール。§13.1 末尾・§16)・`tests/site-config-ui.test.tsx` (`SCREENS` から `/privacy` の行を外す。§16)・`src/__tests__/api/cron/push-outbox.test.ts` (行 176 の `'v2025.1'` 2 つを `LEGAL_DOCUMENTS.terms_of_service.version` / `LEGAL_DOCUMENTS.privacy_policy.version` に。§16) | 段 B (§14) |
| 型 | `AiProviderLine`・`LegalTextContext` (欄は `businessName`・`businessAddress`・`businessRepresentative`・`phoneDisclosure`・`businessEmail`・`businessHours`・`aiProviders`)・`LegalBlock`・`LegalSection`・`LegalChapter`・`LegalDocumentText`・`PrivacyProcessor` | `legal-text.ts`・`privacy-text.ts` |
| 定数 | `CONTACT_PATH`・`LEGAL_NOTICE_PATH`・`GUIDE_PATH`・`LEGAL_FACTS` (キーは §8.1 のとおり 14 個) | `legal-text.ts` |
| 定数 | `TERMS_ARTICLE_HEADINGS`・`TERMS_ARTICLE_COUNT`・`TERMS_MEDICAL_DISCLAIMER`・`TERMS_EMERGENCY_NOTICE` | `terms-text.ts` |
| 定数 | `PRIVACY_SECTION_HEADINGS`・`PRIVACY_SECTION_COUNT`・`PRIVACY_PROCESSORS` (10 社。Stripe・RevenueCat を含む。#1930)・`HOLIDAYS_API_HOST` (export しない) | `privacy-text.ts` |
| 定数 (ページのローカル。export しない) | `MAIN_CLASS` (`<main>` のクラス。2 ページに同じ文字列を §8.3 のとおり置く。共通の定数 `LEGAL_MAIN_CLASS` などは新設しない) | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx` |
| 定数 (テストのローカル。export しない) | `LEGAL_TEXT_FORBIDDEN_CLAIMS` (T-19 の効果・成果の言い回しの一覧。根拠コメント: R-18・§3 の薬機法・景品表示法・健康増進法の行) | `tests/legal-text-1901.test.ts` |
| 定数 (テストのローカル。export しない) | `LEGAL_TEXT_PENDING_WORDS` (T-6。R-32)・`LEGAL_TEXT_PAID_TERMS` (T-33。R-30)・`MIN_NEEDLE_LENGTH = 6` (T-7。根拠コメント: §7 の規則)・`IP_UA_COLUMNS`・`DISCLOSED_IP_UA_TABLES`・`EXCLUDED_IP_UA_TABLES` (T-30。根拠コメント: F-37)・`PRIVACY_DATA_TABLES`・`PRIVACY_DATA_EXCLUDED`・`PAID_PLAN_WRITER_MIGRATIONS`・`PAID_PLAN_WRITER_DIR` (T-34。F-42・F-57)・`AI_CONTEXT_TABLES` (T-36。F-43)・`SENTENCE_END`・`TABLE_CELL_JOINER` (T-35。§10.1)・`SCREEN_REFERENCE_PATTERNS`・`SCREEN_NAMES_WITHOUT_CONSTANT`・`SCREEN_NAMES` (T-40。R-28)・`PHOTO_READ_ONLY_SOURCES` (T-41。F-52)・`CSP_DISCLOSED_DIRECTIVES`・`CSP_NON_EXTERNAL_SOURCE_PATTERN`・`CSP_EXTERNAL_ORIGIN_DISCLOSURE` (T-29。F-15) | `tests/legal-text-1901.test.ts` |
| 型・関数 (テストのローカル。export しない) | `LegalTextUnit`・`legalTextUnits(document)` (T-35・T-40。§13.1) | `tests/legal-text-1901.test.ts` |
| 型・定数 (テストのデータ) | `LegalClaimBasis`・`LegalClaim`・`LEGAL_CLAIMS`・`LEGAL_CLAIM_COUNT` (§10.3) | `tests/legal-claims-1901.ts` |
| 関数 | `termsText(ctx)`・`privacyText(ctx)` | `terms-text.ts`・`privacy-text.ts` |
| 部品 | `LegalDocumentBody({ document })` | `LegalDocumentBody.tsx` |
| 版 | `LEGAL_DOCUMENTS` の `version` を `v2026.1` (2 文書)、`effectiveDate` を公開日 (いまの版は `v2026.3`。§9.1) | `packages/shared/src/legal-versions.ts` |
| 版 (v1.14・段 C) | `PARENTAL_CONSENT_DOCUMENT` の `version` を `v2026.2`、`effectiveDate` を公開日 | `packages/shared/src/parental-consent.ts` |
| DB・API・エラーコード・テーブル・列・RLS・Storage・環境変数 | 無し (画面の route は v1.14 で `/legal-consent/account` を 1 つ足す) | — |

v1.11 から外したもの (新設しない): `PRICING_PATH`・`BILLING_PATH` (有料プランと設定の画面へのリンク)・`LEGAL_FACTS` の `dsrVerificationTtlHours`・`dsrVerificationMaxSends`・`inactiveRepresentativeDays`・`liabilityCapMonths`・テストのローカル定数 `QUOTED_SCREEN_NAME_SOURCES`・`QUOTED_SCREEN_NAME_PATTERN`・`SETTINGS_LINK_LABEL_PATTERN` (画面の名前を写して突き合わせる形の廃止。R-28)・`LegalTextContext` の `addressDisclosure`・`supportEmail`。文面モジュールは `AI_CONSENT_SETTINGS_PATH`・`SESSIONS_SETTINGS_PATH` を import しない。

---

## 16. 既存の番兵 (契約テスト・走査テスト) の追随表

本設計が足す・変える・移すものの名前を grep の語にして `tests/`・`scripts/`・`src/__tests__/`・`packages/shared/src/*.test.ts`・`lib/**/__tests__`・`apps/mobile/__tests__` を走査した結果 (2026-10-19・origin/main `5b85bb3f`。パスの集合は `ad44c2c5` で引き直した。`5b85bb3f` からの差分 12 ファイルのうち本書が根拠に引くのは `package.json` (needle `@supabase/supabase-js` は残る) と `apps/mobile/package.json:30` (`expo-image-picker` の行のまま) だけで、根拠は変わらない)。パス `/terms` `/privacy` を文字列で持つテストは、origin/main `ad44c2c5` で 30 本 (`git grep -l -E "/(terms|privacy)([^a-zA-Z_-]|$)"` を上の 6 つの範囲に掛けた集合。テンプレート文字列の `${DEFAULT_WEB_URL}/terms`・正規表現の `\/terms`・describe の名前・コメントも拾う。v1.5 で書いた「21 本」は引用符つきの形だけを引いた数で、`apps/mobile/__tests__/lib/siteConfig.test.ts` などが漏れていた) で、すべて下の表のどれかの行にある (表に載るのは 30 本と、パスの文字列を持たずに版や走査で反応する番兵)。2 ページは同じパスに残る (§4.1・§8.3) ので、パスの番兵はすべて変更なしで緑のまま。

もう 1 つの軸として、**新設のファイル (`src/lib/legal/*.ts`・`src/components/legal/LegalDocumentBody.tsx`) が走査の対象に入る番兵** を洗った。`src` を `readdirSync` で歩いてソースの中の文字列・書き方を数えるテスト (`tests/*-scan.test.ts`・`*-boundary-scan`・`*-single-implementation`・`ai-consent-provider-inventory` など) は、パスの語では引けないので、走査の対象 (`src` を含む) と数える語で引いた。審査 R3 の指摘 6 の実測 (本書 v1.5 の ts ブロックを置き場所どおりに置いて全件を流した結果。871 ファイル中 870 通過) で赤になったのは `tests/push-expo-boundary-scan.test.ts` の 1 本だけで、原因は委託先の表の `evidence.needle` に書いた `exp.host` だった。v1.6 で needle を根拠のファイルの中の識別子に替え (`EXPO_PUSH_SEND_URL`。GitHub の行も `apt-get install -y age` に)、needle の形の規則を §7 に、検査を T-7 に置いた。替えた needle の語は、`tests/`・`src/__tests__/`・`lib`・`packages/shared/src`・`apps/mobile/__tests__`・`scripts` の `git grep` でどの走査テストにも当たらない (当たるのは `src/__tests__/lib/push/expo-transport.test.ts` の import だけで、走査ではない)。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/business-info-legal-pages.test.ts` (#1911 の版) | `privacy-ai-providers`・`AI_CONSENT_PROVIDERS`・`AI_CONSENT_PROVIDER_INFO`・`株式会社`・`Inc`・`BUSINESS_*` | `/privacy` のソースに 2 つの識別子があること (§8.3 で残す)・描画した本文の「株式会社〇〇」が `BUSINESS_NAME` だけであること・`〇〇 Inc` が無いこと (§6・§7 の規則)・AI の一覧が `AI_CONSENT_PROVIDERS` と同じ数と順で name / country / usage を含むこと (`ai_providers` ブロック) | 変更なし (満たす) | B |
| `tests/policy-pages-public.test.tsx` | `legal-document-meta`・`LegalDocumentMeta`・`最終更新日`・`h3`・`トップページへ戻る` | `<main>` の先頭が版の行、h1 が 1 つ、h3 が 1 つ以上、ソースに「最終更新日」が無い | 変更なし (満たす) | B |
| `tests/e2e/public-policy-pages.spec.ts` | `利用規約`・`プライバシーポリシー`・`トップページへ戻る` | h1 と戻るリンク | 変更なし | B |
| `tests/site-config-ui.test.tsx` | `PrivacyPage`・`getSupportEmail`・`SCREENS` | 招待画面・お問い合わせの画面・`/privacy` の窓口に、`NEXT_PUBLIC_SUPPORT_EMAIL` (`getSupportEmail()`) のアドレスが出る | `SCREENS` から `/privacy` の行と `PrivacyPage` の import を外す。プライバシーポリシーの窓口は事業者のメールアドレス (`BUSINESS_EMAIL`) にした (P-10) ので、この番兵の「アプリの問い合わせ先に従う画面」の対象ではなくなる。代わりに T-16 が第1条と窓口の値を、`tests/business-info-legal-pages.test.ts` (#1911 の版) が事業者の情報の値を確かめる | B |
| `tests/seo-public-pages-1867.test.tsx` | `/terms`・`/privacy`・`publicPageMetadata` | metadata が `publicPageMetadata` の値 | 変更なし | B |
| `tests/public-claims-guard.test.ts` | `PUBLIC_PAGES`・`PUBLIC_SOURCE_FILES`・`FORBIDDEN` | 走査の対象に `/terms` `/privacy` が無い | `PUBLIC_PAGES` に 2 ページ、`PUBLIC_SOURCE_FILES` に 2 つの文面モジュールを足す (本文に禁止語が無いことを以後も守る)。#1911 がこのファイルを書き換えるので、#1911 のマージの後の版に足す | B |
| `tests/no-pending-wording-1911.test.ts` (#1911 が足した) | `準備中`・`予定です`・`SCAN_DIRS`・`SCAN_FILES` | `SCAN_DIRS` (`src/app`・`src/components`・`src/lib`・`src/hooks`・`apps/mobile/app`・`apps/mobile/src`・`supabase/functions`) の下の `.ts`/`.tsx` (`__tests__` の下と `*.test.*` を除く) と `SCAN_FILES` の 5 本のコメントの外に、未完成や予定の語が無い。あわせて、生成のリクエストの progress の SQL の既定値を見る。2 ページ・`LegalDocumentBody.tsx`・文面モジュール (`src/lib/legal`) が走査の対象に入る | 変更なし (2 ページと描画部品は文を持たず、コメントにも禁止の語を書かない。文面モジュールの本文は、この走査と T-6 の両方が見る) | B |
| `packages/shared/src/legal-versions.test.ts` | `LEGAL_DOCUMENTS`・`effectiveDate`・`実在する日付` | 版の形と、施行日が実在する日付の YYYY-MM-DD であること | 変更なし (仮の施行日 `'2026-10-19'` も公開日も満たす。§9.1) | B |
| `tests/legal-consent-page.test.tsx`・`tests/e2e/legal-consent-gate.spec.ts`・`src/__tests__/api/legal/accept.test.ts`・`tests/api/legal-status-route.test.ts`・`tests/legal-consent-api-schema.test.ts`・`tests/legal-consent-gate.test.ts` | `LEGAL_DOCUMENTS`・`effective_date`・`formatLegalEffectiveDate` | 版と施行日を `LEGAL_DOCUMENTS` から読むので、版の値と、YYYY-MM-DD の形の施行日の値には依らない。施行日の形を外すと、`/api/legal/status` が 500 (`src/lib/legal-consent-api.ts:17, 32`・`src/app/api/legal/status/route.ts:50-52`)、`resolveLegalConsentStatus` の結果が `LegalConsentStatusSchema` を通らず、施行日の表示の一致も外れる | 変更なし (仮の施行日も YYYY-MM-DD の形にする。§9.1) | B |
| `src/__tests__/api/cron/push-outbox.test.ts:176` | `'v2025.1'` | 版を直書きしているが、`LEGAL_CONSENT_ENFORCE` を未設定にしている (行 90) ので判定に使われず、緑のまま | `LEGAL_DOCUMENTS.terms_of_service.version` / `.privacy_policy.version` に置き換える (`import { LEGAL_DOCUMENTS } from '@homegohan/shared'`。`packages/shared/src/index.ts:12` が `legal-versions` を再エクスポートしている)。将来の版上げで「同意済みの利用者」の行が意味を失わないように | B |
| `tests/landing-page-1867.test.ts:530-531` | `href="/terms"`・`href="/privacy"` | フッターのリンク先 | 変更なし | — |
| `src/__tests__/lib/maintenance-mode.test.ts:66-68`・`tests/onboarding-routing.test.ts` | `/terms`・`/privacy` | 公開パスの判定 | 変更なし | — |
| `lib/supabase/__tests__/middleware.test.ts:512` (`describe.each(['/terms', '/privacy'])`・#1174)・`lib/supabase/__tests__/middleware-legal-consent.test.ts:251, 370-371`・`lib/supabase/__tests__/middleware-maintenance.test.ts:350-351` | `/terms`・`/privacy` | middleware が 2 つのパスを未ログイン・同意の前・メンテナンス中でも通すこと (公開パスの判定) | 変更なし (パスは変えない。middleware も変えない) | — |
| `tests/login-google-legal-note.test.tsx:48-49`・`tests/signup-legal-consent.test.tsx:96-97`・`tests/legal-parental-consent-page.test.tsx:35`・`tests/auth-callback-legal-consent.test.ts:191` | `/terms`・`/privacy`・`href="/privacy"` | ログイン・サインアップの同意の文・保護者の同意書のリンク先と、認証の戻り先が `/terms` のときの遷移 | 変更なし (リンク先のパスは変えない) | — |
| `tests/integration/security/feature-flags-runtime.test.ts:323-324` | `getPage('/terms')`・`getPage('/privacy')` | メンテナンス中でも 2 ページが 200 を返すこと (実際にページを GET する) | 変更なし (§8.3 のページは新しいサーバーの依存を足さず、`termsText` / `privacyText` は同期の純関数なので 200 のまま) | B |
| `apps/mobile/__tests__/components/PublicPage.test.tsx:85-87`・`apps/mobile/__tests__/components/account-frozen-gate.test.tsx:176`・`apps/mobile/__tests__/components/legal-consent-gate.test.tsx:144`・`apps/mobile/__tests__/lib/account-frozen.test.ts:267`・`apps/mobile/__tests__/lib/legal-consent.test.ts:153` | `/terms`・`/privacy` | モバイルが 2 ページを `getTermsUrl()` / `getPrivacyUrl()` の URL で開くこと・凍結と同意のゲートが 2 つのパスを公開として通すこと | 変更なし (モバイルのコードは変えない。§1) | — |
| `apps/mobile/__tests__/lib/siteConfig.test.ts:80-105` | `getTermsUrl`・`getPrivacyUrl`・`/terms`・`/privacy` | モバイルが開く 2 つの URL が、既定の Web (`DEFAULT_WEB_URL`) または `EXPO_PUBLIC_WEB_URL` のオリジンの `/terms`・`/privacy` であること (末尾の `/` の除去・空文字・https の形を含む) | 変更なし (パスは変えない。モバイルのコードは変えない。§1) | — |
| `apps/mobile/__tests__/app/navigator-font-styles.test.tsx:122` | `/terms`・`/privacy` (describe の名前) | モバイルの公開ページの区画 (`(public)/_layout`) が native-stack のヘッダを出さないこと。パスは describe の名前の中だけで、文面は見ない | 変更なし | — |
| `tests/e2e/.exploration/nutrition-badges-misc-explore.spec.ts:579-588`・`tests/e2e/.exploration/settings-profile-explore.spec.ts:278-311` | `/privacy`・`/terms`・`利用規約`・`プライバシーポリシー` | 探索用の e2e。ログインした人が `/privacy` を開いて 404 にならず失敗の request が無いこと、設定画面の「利用規約」「プライバシーポリシー」のボタンで 2 ページへ遷移し、本文 (`body` の文字数) が 100 文字を超えること | 変更なし (パスと設定画面のボタンは変えない。本文は長くなる。§8.3 のページは新しい request を足さない) | — |
| `tests/e2e/landing-page.spec.ts:93` | `/terms` (コメント) | トップページの JS の転送量の予算の根拠のコメントに「島を 1 つも持たない `/terms` の時点で 179 KB」とある。判定はトップページの転送量だけで、`/terms` は測らない | 変更なし (§8.2 の `LegalDocumentBody` と §8.3 のページは `'use client'` を持たず、クライアントの島を足さないので、コメントの前提も変わらない) | — |
| `tests/site-config-guard.test.ts` | `homegohan.app`・`homegohan.jp`・`homegohan.com`・`SCAN_ROOTS` | `src`・`apps/mobile` (と `supabase/functions` ほか) を `readdirSync` で歩き、`@homegohan.(app\|jp)`・`https://homegohan.(app\|jp)`・製品のコードの `homegohan.(app\|jp\|com)` を既定値の定数のほかに書かないこと。新設の文面モジュールと描画部品が走査の対象に入る (行 511 の `/terms` は判定の入力の見本で、パスの番兵ではない) | 変更なし (本書の §6・§7 の文面と §8 のコードに `homegohan.app`・`homegohan.jp`・`homegohan.com` は無い (2026-10-19 に本書を grep して 0 件)。窓口は `getSupportEmail()` から出し (`contact` ブロック)、文面に URL を書かない規則 (§7) と T-7 で守る) | A |
| `tests/integration/security/legal-documents-acceptance.test.ts`・`tests/integration/rls/push-outbox.test.ts:905-906, 924-925`・`src/__tests__/lib/push/outbox.test.ts:87-88`・`tests/legal-consent-minor-guardian.test.ts:17-18`・`packages/shared/src/parental-consent.test.ts:34-35` | `LEGAL_DOCUMENTS`・`_version_accepted` | 同意済みの版を `LEGAL_DOCUMENTS` の値から作る (`legal-documents-acceptance` はテスト用の版 `test-v1` など (行 91-94) で、DB は版の中身を見ない) ので、版の値に依らない。文面の文字列は見ない | 変更なし (版を v2026.1 に上げても緑) | B |
| `packages/shared/src/legal-consent-api.test.ts:330` | `'2025-01-01'` | 形の壊れた応答 (`version: ''`) を `isLegalConsentStatus` が弾くことの入力に、施行日の文字列を直書きしている。版 v2025.1 の施行日とは無関係の入力値 | 変更なし (`LEGAL_DOCUMENTS` の施行日を変えても、この入力は版が空なので弾かれたまま) | — |
| `tests/ai-consent-provider-inventory.test.ts` | `AI_CONSENT_PROVIDERS`・`https://` | 送信先と同意の一覧。`src`・`supabase/functions`・`shared`・`lib`・`packages`・`apps/mobile/app`・`apps/mobile/src` のコードの `https://<ホスト>` と送り先の SDK の import を集め、AI 事業者でないホストは理由つきの一覧に載っていることを求める | 変更なし (一覧は変えない。文面モジュールに `https://` を書かない規則 (§7) と T-7 で、新設のファイルが送信先として数えられないようにする) | A |
| `tests/push-expo-boundary-scan.test.ts` | `exp.host` | `src`・`supabase/functions`・`apps/mobile/src` の非テストの `.ts`/`.tsx` で `exp.host` を含むファイルが `src/lib/push/expo-transport.ts` だけであること (`expect(writers).toEqual([ALLOWED_FILE])`) | 変更なし。委託先の表の Expo の行の needle を `EXPO_PUSH_SEND_URL` にし (v1.5 の `exp.host` だと `src/lib/legal/privacy-text.ts` が数えられて赤になった。審査 R3 の指摘 6)、文面モジュールに `exp.host` を書かない (T-7 が検査する) | A |
| `tests/email-resend-boundary-scan.test.ts`・`tests/rate-limit-single-implementation.test.ts` | `resend`・`api.resend.com`・`@upstash/ratelimit` | `resend` の import と `api.resend.com` を含む文字列リテラル、`@upstash/ratelimit` の import を、許したファイルに限る (TypeScript の構文木で import と文字列リテラルを見る) | 変更なし (委託先の表の needle `resend`・`@upstash/ratelimit` は import ではなく、`api.resend.com` を含まない。審査 R3 の実測でも緑) | A |
| `src` を走査するその他の番兵 (`tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts`・`tests/env-source-scan.test.ts`・`tests/jst-today-source-scan.test.ts`・`tests/next15-async-request-api-scan.test.ts`・`tests/role-check-source-scan.test.ts`・`tests/signed-photo-display-scan.test.ts`・`tests/supabase-service-role-client-scan.test.ts`・`tests/operator-mfa-entry-points-scan.test.ts`・`tests/email-suppressed-log-level-scan.test.ts`・`tests/auth/*-source-scan.test.ts`・`tests/native-sign-out-order-source-scan.test.ts`) | 各テストの書き方 (`process.env`・`new Date`・service role の client・役割の判定・`error.message` の返し方など) | 文面モジュールと描画部品は、文字列のデータ・型・import・JSX だけで、これらが数える書き方を持たない | 変更なし (審査 R3 の実測で緑) | A |
| `tests/log-cleanup-dau-snapshot-contract.test.ts:213-214` | `failed_invite_lookups` | `failed_invite_lookups` に書き込む処理が無いので掃除のジョブを足さないこと | 変更なし (T-30 は同じ事実を「第3条に載せない理由」として使う。書き込む処理を足すときは、この番兵と T-30 の両方が直しを求める) | — |
| `tests/operator-mfa-db-gate-migration-contract.test.ts`・`tests/e2e-test-session.test.ts`・`tests/api/auth-mfa-routes.test.ts`・`tests/super-admin-mfa-reset-route.test.ts` | `MFA_REQUIRED_ROLES` | ロールの一覧と、DB・e2e の写しの一致 | 変更なし (T-31 は読むだけで、一覧を変えない) | — |
| `src/__tests__/lib/emails/account/login-new-device.test.ts:67` | `SESSIONS_SETTINGS_PATH` | 値が `/settings/security/sessions` であることを固定 (v1.11 は文面モジュールが import していたが、v1.12 の文面モジュールは設定の画面へリンクしないので import しない) | 変更なし | — |
| `src/__tests__/lib/security/csp.test.ts` | `HOLIDAYS_API_ORIGIN`・`CSP_TURNSTILE_ORIGIN`・`script-src`・`frame-src`・`img-src`・`connect-src` | CSP の値の固定 (プライバシーポリシーの文面モジュールが `HOLIDAYS_API_ORIGIN` を import し、T-29 が 4 つのディレクティブの外部の許可先を第10条と突き合わせる。T-29 は CSP の値を変えず読むだけ) | 変更なし | — |
| `tests/env-source-scan.test.ts`・`src/__tests__/lib/env.test.ts` | 環境変数名 | 新しい環境変数は無い | 変更なし | — |
| `tests/account-export-tables.test.ts` | テーブル名・`ACCOUNT_EXPORT_TABLES`・`ACCOUNT_EXPORT_EXCLUDED` | 新しいテーブルは無い。利用者に紐づく表を足すと、この番兵が 2 つの一覧への分類を求め、続けて T-34 が第3条の行への対応 (または載せない理由) を求める (2 段で閉じる) | 変更なし (T-34 は 2 つの一覧を読むだけ) | — |
| `tests/admin-mutation-audit-coverage-1571.test.ts` | `EXPECTED`・`recordAdminAudit` | T-38 がこのファイルのソースの 2 行 (審査の変更と凍結の `'audited'`) を読む。運営の変更の操作の記録をやめると、この番兵と T-38 の両方が赤になり、プライバシーポリシー第5条 6 項と第11条の文を直すことになる | 変更なし | — |
| 本設計書 (`docs/design/cross/20-terms-privacy-text.md`) | `\| F-<数> \|`・`\| P-<数> \|` | T-35 が主張の表の根拠の F-n・P-n の行の実在を、本書から読んで確かめる。本書の §2.2・§0.1 の行の番号を付け替えると T-35 が赤になる | 行の番号は付け替えない (消すときは主張の表の根拠も直す) | A |
| `lib/supabase/__tests__/middleware-legal-consent-matrix.test.ts:54-55, 192-193, 208` | `src/app/terms/page.tsx`・`src/app/privacy/page.tsx`・`<LegalConsentBanner` | `PAGE_FILES` の 2 行がページのファイルの実在を検査する。お知らせ (`<LegalConsentBanner`) を描くのは `(main)` の下だけかを `src/app` の走査で検査する | 変更なし (2 ページのファイルは同じパスに残り、§8.3 のページと `LegalDocumentBody` は `<LegalConsentBanner` を描かない) | B |
| `tests/docs-table-column-count.test.ts` | `docs/`・`KNOWN_MISMATCHES`・`\|` | `docs/` の下の `.md` の表 (コードのフェンスの外の、行頭が `\|` の行のかたまり) で、どの行も見出しの行と同じ数の区切りを持つ (コードの span とエスケープした `\|` は数えない)。本書もこの走査の対象 | 本書の表の行は見出しと同じ数の区切りを持たせる (v1.9 までの §4.3 の S-5・S-14・S-17〜S-20 は行末の `\|` が無く、マージすると赤になった。v1.10 で直した)。表のセルの中に `\|` を書くときはコードの span に入れるかエスケープする | 設計 |
| `tests/auth/no-login-lockout.test.ts` | `LOCK_AFFIRMING_DOC_PATTERNS`・`docs` | `docs/`・`apps/mobile` の `.md` に、ログインに続けて失敗したときに締め出す前提の文 (締め出しの段・時間・解除の手順を書いた文。正規表現の一覧はこのテストの `LOCK_AFFIRMING_DOC_PATTERNS`) が無い。本書も走査の対象 | 変更なし (本書は締め出しを書かない。2026-10-19 に本書へ同じ正規表現を当てて 0 件。この行も、正規表現に当たる語を例に書かない) | 設計 |
| `tests/design-doc-removed-mobile-screens.test.ts` | `REMOVED_MOBILE_SCREENS`・`apps/mobile/app/` | `docs/design/` の `.md` が、消したモバイルの画面を、消したと書かずに名指ししない。コードの文字列の `apps/mobile/app/<パス>` は、消した画面とその区画を指さない。本書も走査の対象 | 変更なし (本書が名指しするアプリの画面は `apps/mobile/app/health/blood-tests.tsx`・`apps/mobile/app/(tabs)/meals.tsx`・`apps/mobile/app/settings/account.tsx`・`apps/mobile/app/(public)/terms.tsx` で、どれも消した画面ではない。§13.1 の `PHOTO_READ_ONLY_SOURCES` の文字列 `apps/mobile/app/health/blood-tests.tsx` も消した画面・区画を指さない (区画は消した画面を含むディレクトリそのもので、その下の残したファイルは当たらない)) | 設計 |
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
| Issue #1911 (`src/lib/business-info.ts`・`src/app/company/page.tsx`・`src/app/legal/page.tsx`・組織の画面・運営の画面の「準備中」) | 事業者の情報の定数 (`BUSINESS_ADDRESS`・`BUSINESS_EMAIL`・`BUSINESS_HOURS`・`PHONE_DISCLOSED_ON_REQUEST`) と、利用者・公開ページ・運営の画面の未完成の語 | #1911 が持つ (本書の範囲外)。#1911 は #1916 (4b1e1abe・2026-10-19) でマージ済みで、本書の実装 (#1918) はその後に始めた (§14)。定数の名前は本書の §8.1・§8.3・§13 と同じ (`src/lib/business-info.ts:17-41`)。`/privacy` 第1条・`/legal`・`/company` が同じ定数から出ることは T-16 と `tests/business-info-legal-pages.test.ts` が確かめる | 済 (#1916) |
| Issue #1912 (有料プランの販売) | 有料の条文 | #1912 が価格を公開する段で、両文書の版を上げて足す (P-9・R-30。本書の版の本文には有料の条文が無いので追記になる)。足す場所: 利用規約第10条 (料金) の 2 項以降に、価格は料金ページと特定商取引法に基づく表記に定めること・自動更新・解約の方法と時期・返金・App Store / Google Play での購入 (RevenueCat)・Web での購入 (決済の事業者)。第16条 2 項 (凍結中の解約)・第17条 (退会のときの契約の扱い)・第21条 (料金に結ぶ責任の上限を置くか。弁護士の確認。Q-6)・第24条 2 項 (同意の前の解約の手段。Q-21)。プライバシーポリシー第3条 (有料プランの区分。T-34 の `PRIVACY_DATA_EXCLUDED` の `'paid_plan'` の 2 表を `PRIVACY_DATA_TABLES` へ)・第4条 (契約・決済・請求・解約の管理の目的)・第7条 (`PRIVACY_PROCESSORS` に決済の事業者と RevenueCat・ストアの事業者)・第10条 (決済の画面の外部送信)・第12条 (決済の記録の保存)。T-33 (有料の語が無い) を改め、§10 の主張の表を作り直し、§9.3 の規律で版を上げる。`docs/design/billing/01-billing-core.md` §0 の「アプリ内課金なし」はオーナーの選択 (RevenueCat。P-9) と食い違うので、#1912 の設計で直す v1.17: billing/03 §11 (段 E) で足し、両文書の版を `v2026.3` に上げた。この行と違う点: ストアの事業者 (Apple・Google) は第7条の委託先の表に載せず、第3条の有料プランの行に書いた (billing/03 Q-17)。第21条は変えない (料金に結ぶ上限を置かない。billing/03 Q-14)。同意の前の解約の手段は第24条の最後の項 (5 項) に足した (billing/03 Q-15) | #1912 の価格の公開 |
| `apps/mobile/app/index.tsx:83-87`・`apps/mobile/app/(public)/terms.tsx`・`apps/mobile/app/(public)/privacy.tsx`・`apps/mobile/src/components/PublicPage.tsx` | アプリの最初の画面の「利用規約」「プライバシー」のリンクと、アプリの公開ページ (「Web版を開く」で Web の全文を開く。§11.1) | 変更不要。アプリの側に本文の写しは無く、Web のパス `/terms`・`/privacy` は変えない (§8.3)。公開ページの子の文「…はWeb版にて最新の内容をご確認ください。」も版に触れない。`PublicPage` の子が無いときの文は #1911 が直す (#1911 の枝の差分に `apps/mobile/src/components/PublicPage.tsx` がある) | — |
| `src/app/legal/parental-consent/page.tsx:47-55` | 保護者の同意書のページの「個人情報の取り扱いはプライバシーポリシーをご確認ください」の `/privacy` へのリンク (§11.1) | 変更不要。パス `/privacy` は変えず、アンカーを付けないので条の組み替えで壊れない。同意書の本文の食い違いは下の `packages/shared/src/parental-consent.ts` の行 (Q-27) | — |
| `src/app/terms/page.tsx`・`privacy/page.tsx`・`legal/page.tsx`・`company/page.tsx` | フッター `© 2025 ほめゴハン` | 候補: 年の更新 (本書の範囲外) | 候補 |
| `apps/mobile/app.json` | iOS の `NSPhotoLibraryAddUsageDescription` (「解析結果の保存のために写真ライブラリへ追加する場合があります」)・Android の `RECORD_AUDIO`・`WRITE_EXTERNAL_STORAGE` | 使うコードが無い (F-25)。プライバシーポリシー第3条は使う機能 (カメラ・写真の選択・通知) だけを書き、マイクの音声は取得しないと書く。候補: 宣言を外す (ストアの申告と食い違わないように)。外すときは T-26 の既知の一覧も減らす。本書の範囲外 | 候補 |
| `src/lib/ai/consent-config.ts` | `AI_CONSENT_COPY.dataCategories` (6 項目) | 実際に AI 事業者へ送る種類 (プロフィール・持病・服薬・妊娠/授乳の状況・ニックネーム。F-29) より狭い。プライバシーポリシー第6条は実際の種類を書いたので、同意画面の文と食い違う。候補: 同意画面の文に種類を足し、`AI_CONSENT_VERSION` を上げる (AI の同意の取り直しが起きる)。本書の範囲外 (P-8)。Q-18 | 候補 (別 Issue) |
| `src/app/(main)/family/members/[id]/page.tsx`・`src/app/(main)/settings/membership/page.tsx` | 健康の記録の共有 (`share_health`) の切り替え | 切り替えられるが、読む経路が無い (F-18)。プライバシーポリシー第5条 4 項・第9条 7 項は「健康の記録は家族グループのメンバーにも組織の管理者にも表示されません」とだけ書き、切り替えの有無には触れない。候補: 切り替えを画面から外すか、機能を作る (作るときはプライバシーポリシーの版を上げる)。本書の範囲外 | 候補 |
| `src/components/marketing/landing-copy.ts` | 信頼の節「データの取り扱い」のリンク先 `/privacy`・フッターの「法的情報」の `/terms`・`/privacy`・主張 `privacy` の evidence `src/app/privacy/page.tsx` と condition「保存と第三者への提供は断定せず、プライバシーポリシーへ案内する」(行の番号は #1911 で動く) | 変更不要。2 ページは同じパスに残る (§8.3) ので、リンク先と evidence のファイルは実在のまま (`tests/landing-page-1867.test.ts` の U-2 はファイルの実在だけを見る)。信頼の節の文はプライバシーポリシーへ案内するだけで、保存と第三者への提供を断定しないので、本書の第7条・第8条・第12条の文と食い違わない | — |
| `src/components/billing/checkout-confirmation.tsx:87-88` | 有料プランの確認画面の「利用規約 および プライバシーポリシー に同意の上でお申し込みください」のリンク先 `/terms`・`/privacy` | 変更不要 (パスは変えない。文面の条番号を指さないので、全文の差し替えで壊れない。有料の条文は #1912 が足す) | — |
| `src/app/(main)/settings/page.tsx:574, 585` | 設定画面の「サポートと法的情報」の「利用規約」「プライバシーポリシー」のボタン (`router.push('/terms')`・`router.push('/privacy')`) | 変更不要 (パスは変えない。探索用の e2e `settings-profile-explore.spec.ts` もこのボタンで遷移する。§16) | — |
| `src/lib/seo/public-pages.ts` | `/terms` `/privacy` の description | 変更不要 (「利用規約です」「プライバシーポリシー (個人情報の取り扱い) です」のまま) | — |
| `lib/legal-consent.ts` (`EXEMPT_PREFIXES`)・`src/app/legal-consent/LegalConsentForm.tsx` の `declined` の画面 | v1.13 の時点では、版上げの後、同意の前の人には退会・書き出しの画面が無く (F-32)、`declined` の画面の文はお問い合わせによる削除を約束していた (F-40) | 済 (v1.14・段 C。P-12 の Q-23): 同意の前の退会と書き出しの画面 `/legal-consent/account` を置き、フォームの下・未成年の案内・`declined` の画面から案内する。`declined` の画面からお問い合わせによる削除の約束を外した。利用規約第24条 2 項・第17条 1 項・第5条 3 項とプライバシーポリシー第13条 4 項を合わせた (版は v2026.1 のまま。公開の前) | 公開の前 (済) |
| `docs/design/operator/09-runbook.md` §9.2・§9.3 | 同意の前の人からの依頼の扱い | (1) 削除の依頼: 運営が代わりに削除する経路は無い。同意の前でも本人が `/legal-consent/account` (同意画面の下の案内・ログインの後) で退会と書き出しを行えるので、それを案内する (利用規約第24条 2 項。P-12)。(2) 本人が解散してから退会できることを案内する (F-59) | 実装のマージと同日 (docs PR) |
| `src/lib/account-deletion.ts:248-285` (`findBlocker` の 2 つの文) | 「先に代表者を譲渡するか家族グループを解散してください」「先にオーナーを譲渡するか組織を解散してください」 | 利用者が解散する機能を作った (F-59)。文は今のまま事実に合う | 解決 (#1917。family/11)。文は変えない (譲渡と解散の両方ができる) |
| `packages/shared/src/parental-consent.ts` (`PARENTAL_CONSENT_DOCUMENT_COPY` の 1・2・3・4 段落・`LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedBody`・`PARENTAL_CONSENT_COPY.promotionUnderCoppaAge`)・`src/app/(main)/family/members/child/new/page.tsx:300` | v1.13 の時点では「保護者の方が代わりに記録します」「親が代わりに食事記録を管理します」「お子さまの情報（…食事の記録・アレルギーなどの健康に関する情報）」「AI による食事の解析・献立の提案にお子さまの記録が使われる」「保存済みの情報の削除は、お問い合わせからご依頼ください」と書いていた (F-33) | 済 (v1.14・段 C。P-12 の Q-27): 同意書は、登録できる情報 (お名前・生年月日・性別（任意）)・家族グループのメンバーが閲覧できる状態になること・13 歳未満の本人のアカウントを作らないこと・取り消し方・保存の期間と消去の請求はプライバシーポリシーによることだけを書き、`PARENTAL_CONSENT_DOCUMENT.version` を v2026.2 に上げた (v2026.1 で記録した同意は失効しない。cross/14 S15)。未成年の案内と子どもの追加の画面の文からも代わりに記録する約束を外した。cross/14 の正典の写し (§6 の `PARENTAL_CONSENT_DOCUMENT`・文面の定数) の追随は下の行 | 公開の前 (済) |
| `src/app/api/admin/moderation/route.ts`・`src/app/api/admin/moderation/queue/route.ts` | 審査の一覧は写真の署名付き URL を返すが、監査の記録を残さない (F-41) | プライバシーポリシー第11条は、記録するのを「利用者のデータを変更する操作」と書いた (閲覧の記録は約束しない)。候補: 一覧の閲覧も記録する (記録したら、文に閲覧を足して版を上げる)。本書の範囲外 | 候補 |
| `src/app/(org)/org/members/page.tsx:52` | 組織のメンバーの一覧が `user_profiles` を直接読むが、SELECT の RLS は本人の行だけ (F-19) | 組織の管理者には自分の行しか出ない (画面の意図と食い違う)。プライバシーポリシー第9条 5 項は、画面が読む項目 (表示名・組織内の役割・参加日) を上限として「〜だけ」と書いた。同じ理由で、オーナーの譲渡の画面 (`src/app/(org)/org/settings/owner-transfer/page.tsx:50-55`) も候補を出せない (F-39)。候補: 一覧と候補を service_role の API で返すなど (本書の範囲外。直しても見える項目が同じなら文面は変えない) | 候補 (別 Issue) |
| `src/app/api/recipes/route.ts` (POST)・`src/app/api/recipes/[id]/comments/route.ts` (POST) | レシピの作成とコメントの API は、呼ぶ画面が無いのにログインした人なら誰でも呼べ、`isPublic: true` で登録したレシピは未ログインの人にも読める (F-54) | 利用規約第13条 2 項は、公開の状態にしたユーザーコンテンツの見え方だけを種類の水準で書いた。プライバシーポリシー第3条のレシピの区分は「ユーザーが登録したレシピとコメント」と書いた。候補: 使わない API を外す、または作成・公開・コメントの画面を作る。本書の範囲外 (作っても、見え方が同じなら文面は変えない) | 候補 |
| `docs/design/cross/14-parental-consent.md` | 正典の写し (`PARENTAL_CONSENT_DOCUMENT`・`LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedBody`・`PARENTAL_CONSENT_COPY.promotionUnderCoppaAge`・`PARENTAL_CONSENT_DOCUMENT_COPY`) と定数の表の `PARENTAL_CONSENT_DOCUMENT` の行・§10 の 14 の第 3 段落の引用 | 実装 (段 C) の値に合わせる (v1.14) | 実装のマージと同日 |
| `docs/design/cross/13a-legal-consent-api-server.md` §6.4 | 許可リストの `/api/contact` の理由「データの削除の依頼もここから」と、退会・書き出しの `note` | 実装 (段 C) の `note` に合わせる (path・match・reason は変わらない) | 実装のマージと同日 |
| `docs/design/cross/13b-legal-consent-mobile.md` | 「同意しない」の後の Web の案内を「削除の依頼先 (お問い合わせ)」と書く箇所 (§0・§2 の表・R-12・S4・状態の表・正典のコメント) | 「退会と書き出しの画面へのログイン (`/login?next=%2Flegal-consent%2Faccount`)・請求の画面・お問い合わせ」に。同意の前の退会 (`/legal-consent/account`) の後もネイティブへ `sign-out` が届き、同意画面は `signed-out-notice` で「閉じる」を出す | 実装のマージと同日 |
| `docs/design/cross/08-legal-compliance.md` §7.2 (同意画面の行) | 「同意しない」はログアウトして「データ削除の依頼先 (お問い合わせ)」を案内する | 同意の前の退会と書き出しの画面 (`/legal-consent/account`) への案内に (v1.14) | 実装のマージと同日 |
| `docs/design/membership/03-ui-spec.md` (子どもの追加の画面の図) | 「親が代わりに食事記録を管理します」。図そのものも古い (年齢・アレルギー・アバター色の欄があり、実装の生年月日・性別の欄と違う) | 候補: 図を実装 (名前・生年月日・性別と、18 歳未満の保護者の同意の欄) に合わせて描き直し、注意書きを「登録するのは、名前・生年月日・性別だけです」にする (本書の範囲外。membership の設計書の改定) | 候補 |
| 利用者が家族グループ・組織を自分で解散する機能 | Q-26 | 別の案件 (別の Issue と設計) で作る (P-12)。作ったら利用規約第11条 4 項・第12条 4 項・`findBlocker` の文を改め、版を上げる | 別の案件 |

v1.11 にあって外した行: `src/app/(operator)/operator/membership/families/inactive/page.tsx:133`・`orgs/inactive/page.tsx:137` の例文の日数 (本文が未ログインの日数を書かなくなったので、本書との食い違いではなくなった。運営の画面の例文の直しは本書の範囲外)。`src/app/company/page.tsx`・`src/app/legal/page.tsx`・組織の画面・運営の画面の「準備中」の 4 行は、#1911 の行に 1 つにまとめた。

---

## 18. 未解決事項・弁護士の確認を勧める点・openQuestions

| # | 事項 | 本書の置き方 | 誰が決めるか |
|---|---|---|---|
| Q-1 | 公開の前に弁護士の確認を受けるか | 受けることを勧める (Issue #1901 の「進め方」と同じ)。確認で文面が変わるなら本書を改定し、版は §9.3 の規律 | オーナー |
| Q-2 | AI 事業者への送信を「第三者提供 (同意)」と扱うか「委託」と扱うか。エストニア (EU) の事業者は 28 条 1 項の指定国なので同意は法律上不要だが、本書は同意画面の仕組み (全事業者) に合わせて同意を取る形で書いた | 現行の仕組み (全事業者の同意) のまま。法的な整理は弁護士の確認 | 弁護士 |
| Q-3 | アメリカ合衆国の制度の情報の文 (第6条) が PPC の調査結果 (USA_report.pdf) に照らして十分か。「本人の権利利益に重大な影響を及ぼす可能性のある制度」(政府のアクセス) に触れるか | 概要だけを書いた。確認で補う | 弁護士 |
| Q-4 | 委託先 (Supabase・Vercel・Resend・Upstash・Expo・Cloudflare・GitHub・Google) との契約 (DPA・利用規約) が 28 条 1 項の「基準適合体制」に当たるか。第7条はそう書いている | 各事業者の DPA を受諾していることをオーナーが確認する (未確認なら第7条 2 を「同意」の形に書き換える) | オーナー・弁護士 |
| Q-5 | 法 32 条の「住所」 | 解決 (v1.12): 所在地は `BUSINESS_ADDRESS` (#1911) の値を第1条に載せる。電話番号だけを請求時開示にする (P-10) | — |
| Q-6 | 第 21 条の責任の制限 (故意・重過失を除き通常損害に限る。強行法規に反する限度で適用しない) が消費者契約法 8 条・10 条に照らして妥当か。料金に結ぶ責任の上限 (v1.11 の 2 項) は、有料の条文と一緒に #1912 で置くかを決める | 本書の版は上限を置かない (有料の条文を書かない。P-9)。v1.17: #1912 は第21条を変えず、料金に結ぶ上限を置かない (billing/03 Q-14 の推奨) | 弁護士・#1912 |
| Q-7 | 第 27 条の専属的合意管轄 (本店所在地。東京都港区) が消費者との関係で有効か | 現行どおり「当社の本店所在地を管轄する裁判所」 | 弁護士 |
| Q-8 | 電気通信事業法 27 条の 12 の対象役務に当たるか (当たらなくても第10条で公表する) | 公表する | 弁護士 |
| Q-9 | 認定個人情報保護団体への加入の有無 | 未確認なので書かない | オーナー |
| Q-10 | AI 事業者の正式名称・所在地・保存期間・学習利用の有無 (`consent-config.ts:23-31` の宿題) | 同意画面と同じ呼び名と国だけ | 弁護士・オーナー |
| Q-11 | 本番の Supabase のリージョン (cross/07 §5.1 は東京)。「日本国内に保管」と書くなら確認が要る | 書かない (委託先の所在国だけ)。本番の Supabase は ap-northeast-1 (東京)。2026-10-19 に読み取りで確認 | オーナー |
| Q-12 | `effectiveDate` (公開日) | 解決: 公開日 2026-10-19 に確定し、目印のコメントを消した (#1918 2ba5b3b3。§9.1・§9.4 の 3) | — |
| Q-13 | Google OAuth で Google から受け取る項目 (識別子・メールアドレス・名前・プロフィール画像) の実測 (Supabase の `raw_user_meta_data`) | 第3条は「Google から受け取る情報」と種類の水準で書き、委託先の表に項目を書いた。実装の整合ゲートで本番の 1 行を読んで確かめる | 整合ゲート |
| Q-14 | 法令で残す記録 (監査ログなど) の保存の期限 (cross/08 §16.3「未決」) | 「法令と当社の定めによります」 | オーナー |
| Q-15 | #1911 の定数の名前と本書の揃え方 | 解決 (v1.12): #1911 の枝の名前 (`BUSINESS_ADDRESS`・`BUSINESS_EMAIL`・`BUSINESS_HOURS`・`PHONE_DISCLOSED_ON_REQUEST`。F-56) を前提にした。#1911 は #1916 (4b1e1abe) でマージ済みで、main の名前は同じ (§17 の #1911 の行) | — |
| Q-16 | AI 事業者への提供の記録 (法 29 条) を同意の記録 (`external_data_consents`) で代えてよいか、またその保存の期間 (規則 21 条) と、退会で同意の記録が即時に消える (`ON DELETE CASCADE`。F-26) ことの関係。AI 事業者への提供を「第三者提供」でなく本人の指示による送信と整理できるかも含む (Q-2 と関連) | プライバシーポリシー第6条の 5 は「同意の記録を提供の記録として保存し、開示の請求にはこれをもとに答える」とだけ書き、退会後の保存は約束しない | 弁護士・オーナー (保存が要るなら別の設計で退会後も残す記録を作る) |
| Q-17 | `apps/mobile/app.json` の使っていない権限の宣言 (`NSPhotoLibraryAddUsageDescription`・`RECORD_AUDIO`・`WRITE_EXTERNAL_STORAGE`) を外すか | 本書では変えない。ポリシーは使う機能だけを書く (§17 の候補行) | オーナー |
| Q-18 | AI の同意 (`AI_CONSENT_COPY` の 6 項目で取った同意) が、実際に送っている要配慮個人情報 (持病・服薬・妊娠/授乳の状況) とプロフィールの種類 (F-29) まで含む同意として足りるか (法 20 条 2 項・28 条 2 項の「情報の提供」) | プライバシーポリシー第6条には実際の種類を書いた。同意画面の文の追随と `AI_CONSENT_VERSION` の更新は別 Issue の候補 (§17) | 弁護士・オーナー |
| Q-19 | 同意を得ない規約の変更 (民法 548 条の 4) の定めを置くか | 置かない。内容が変わる変更はすべて再同意で行う (再同意のゲートがあるので同意を得ない変更の経路が要らない)。置くなら、施行日の前に変更後の全文をお知らせに載せる工程を §9.4 に足す | 弁護士・オーナー |
| Q-20 | 個人情報の取扱いの責任者と、人的な安全管理措置 (従業者の教育・守秘) | 根拠が無いので書かない (§0.6)。決まったら第1条・第11条に足して版を上げる | オーナー |
| Q-21 | 版上げの後、同意の前の有料プランの利用者の解約の手段 | 本書の版は有料の条文を書かない (P-9)。有料プランを売り始める #1912 が、同意の前の解約の手段 (画面を作るか、お問い合わせから依頼を受けて運営が行う運用か) を決め、利用規約第24条 2 項に足す (§17 の #1912 の行)。v1.17: #1912 は、ストアの契約は各ストアの定期購読の管理から、Web の契約はお問い合わせからの依頼を受けて当社が解約の手続を行うと、利用規約第24条の最後の項 (5 項) に足した (billing/03 §11.1 (f)・Q-15) | #1912・オーナー |
| Q-22 | 代表者・オーナーの未ログインの日数を文面に書くか | 解決 (v1.12): 書かない。「長期間ログインしていないなど」とする (本文に製品の細部を書かない。R-28)。運営の一覧の判定 (30 日。F-21) を変えても文面は変わらない | — |
| Q-23 | 同意の前でも本人が自分で退会・書き出しできる画面を作るか (§17 の候補行) | 解決 (v1.14): オーナーの選択「同意なしでも退会・書き出しできるようにする (推奨)」(P-12) で、同意画面の下に `/legal-consent/account` を置いた (§14 段 C・§11.3)。利用規約第24条 2 項は「同意の前でも、請求・お問い合わせ・退会とデータの書き出しを行える」とした。同じ画面の退会の 409 から、代表者・オーナーが家族グループ・組織を解散できる (family/11 §15.4。解散の API は同意の許可リストにある) | — |
| Q-24 | 同型の指摘 (本文の製品の細部の主張が実装と食い違う) が審査の周をまたいで続いた (R1 15 → R2 3 → R3 9 → R4 約 10 → R5 約 8)。v1.8 で本文の 1 文 = 1 行の主張の表 (§10) と T-35 にし、v1.10 で分かれ目のコードを T-32・T-39〜T-42 に結んだが、細部を 1 つ直しても別の細部が残った | 解決 (v1.12): 発生源 (本文が製品の細部を説明していること) を消した。本文は法令の事項と権利義務の約束だけにし、取得する情報・送り先・保存期間は種類の水準で書いて表と実コードの機械の突き合わせ (T-29・T-30・T-34・T-36) で閉じ、画面の名前と道順は T-40 が本文に入れさせない (R-28・P-11)。主張の表は 479 行から 383 行に減った。以後、文を足すときは §10.1 の「本文の粒度」の規則で、まず法令の事項か権利義務の約束かを確かめる | — |
| Q-25 | 本番で運営の多要素認証の猶予 (`OPERATOR_MFA_ENFORCE_FROM`) が未来の日時に設定されていないか | 解決 (v1.12): プライバシーポリシー第11条を「大きな権限を持つ運営担当者のログインに多要素認証を用いる仕組みを設けています」とし、猶予の有無に依らない文にした (F-35・T-31)。公開の前の確認の対象から外した (§9.4 の 3) | — |
| Q-26 | ほかに 18 歳以上のメンバーがいない家族の代表者・組織のオーナーは、譲渡できず、利用者が解散する手段も無いので、退会できない (F-39)。運営の強制解散の画面は 30 日以上未ログインの一覧からだけ開ける | 解決 (#1917): 利用者が解散できる機能を family/11 で作った。文面は §6・§7 のとおり改め、版は family/11 §18.4 の規律 | — |
| Q-27 | 保護者の同意書 (`PARENTAL_CONSENT_DOCUMENT_COPY`) と未成年の案内の文が「保護者が代わりに記録します」と書くが、その機能は無い (F-33) | 解決 (v1.14): オーナーの選択「同意書の文を実装に合わせて直す (推奨)」(P-12) で、同意書・未成年の案内・子どもの追加の画面の文から実装に無い約束を消し、同意書の版を v2026.2 に上げた (§14 段 C・§17) | — |
| Q-28 | 同意の前の退会に、改定後の内容への同意を求める形 (利用規約第24条 2 項) が、消費者契約法 10 条・個人情報保護法 35 条 (消去等の請求) に照らして妥当か | 解消 (v1.14): Q-23 の画面を作り、同意の前の退会に同意を求めなくなった (P-12) | — |
| Q-29 | 献立の作成の依頼のキューのジョブ (`src/app/api/cron/process-menu-queue/route.ts:60-81`) と取り出しの RPC は、AI の同意だけを確かめ、利用規約の同意と凍結を確かめない (§11.3.1 の A-7)。版上げの前、または凍結の前に積んだ依頼は、AI の同意があれば AI 事業者へ送られる | 本書の本文はこの場合について約束をしない (「同意が無い間は送らない」の対象は AI の同意。利用規約第7条・プライバシーポリシー第6条)。ジョブにも利用規約の同意と凍結の判定を足すかは本書の範囲外 (候補) | オーナー |
| Q-30 | 取得する情報・送り先・保存期間を種類の水準で書いたこと (v1.12) が、法 21 条 (利用目的の通知・公表)・32 条 (保有個人データの公表事項)・電気通信事業法 27 条の 12 (外部送信の公表) の具体性として足りるか | 種類の水準で書き、漏れを機械の突き合わせで閉じた (§7 の規則)。確認で細かくするよう求められたら、細かくする行を足して版を上げる (その行も主張の表と機械の突き合わせに結ぶ) | 弁護士 |

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
| v1.7 | 2026-10-19 | 網羅性の反映 (周 4): §11.2 の状態比較表に、AI 機能・AI 機能の 1 日の上限・料金と有料プラン・公開の範囲・家族グループでの見え方・凍結・退会・未成年の扱い・要配慮個人情報の取得の同意・外国にある第三者への提供・保存期間・開示等の請求の手続の行を足し、AI 事業者へ送る情報の行の現行の条番号を第5条に直した (現行 `/privacy` の AI の記載は第5条)。§12 のエラー表に、凍結中の 403 `AUTH_ACCOUNT_FROZEN` とメンテナンス中の 503 `MAINTENANCE_MODE` の行を足した (§11.3 の凍結の行と F-28 の判定の順が挙げるもの)。§14 の段分けで T-12 を段 B だけにし (2 ページを描くため)、33 本の it の段への割り振り表と判定の基準を足した。T-19 の読むものを文面モジュールを描いた本文と明記した |
| v1.8 | 2026-10-19 | 審査 R4 の反映: 家族の役割を実装の 3 つ (代表者・大人・子ども) に直し、「管理者」を消した。大人のメンバー (本人のアカウントをつないだ未成年者を含む) が同じ権限で招待・招待先のメールアドレスの閲覧・子どもの追加・除名を行えることと、未成年者は家族の作成・参加・代表者の引き受けができないことを書いた (利用規約第5条・第11条・プライバシーポリシー第9条・F-38)。実装に無い「代わりに記録」「家族としての献立・買い物リスト」を削り、子どもについて登録できるのは名前・生年月日・性別だけと書いた (第2条・第5条・第6条・第11条・プライバシーポリシー第3条・第5条・第9条・第15条・F-33)。昇格の案内は保護者から本人のメールアドレスに届き本人が承諾すると直した (第5条 1 項)。利用者が解散する手段は無いので、代表者・オーナーは譲渡するまで退会できず、相手がいなければお問い合わせと書いた (第11条 5 項・第12条 4 項・第17条 2 項・プライバシーポリシー第13条 4 項・F-39・Q-26)。運営が代わりに削除する経路は無いので、同意の前の退会は「改定後の内容に同意したうえで設定画面から」と書き、お問い合わせによる削除の約束を消した (第17条 1 項・第24条 2 項・プライバシーポリシー第13条 1 項・第14条 7 項・F-40・Q-23・Q-28)。運営の操作の記録は、データを変更する操作と個別の投稿の確認に限った (プライバシーポリシー第5条 6 項・第11条・F-41)。取得する情報に AI 相談・毎日のコンディション・記録の継続と比較・運営の記録・パスワードの履歴などを足し、利用者に紐づく表の全体と第3条の行の対応を T-34 で閉じた (F-42・F-44・F-45)。AI 事業者へ送る情報に体重計・体組成計の写真と、AI 相談が読む健康の記録・最近の献立・冷蔵庫の食材・買い物リスト・バッジ・過去の相談の要約を足し、T-36 で閉じた (F-43・F-48)。保存期間に公開したレシピ・AI 事業者の呼び出しの記録・栄養の計算の確認の記録・請求の記録・招待と所属の変更の記録を足した (F-46)。確認メールの回数を「最初の送信を含めて 5 回まで」に直した (F-47)。家族の食事の記録は「閲覧できる状態になる」、献立は「料理の名前が表示される」と実装どおりに書いた (F-49)。§10 を、本文の 1 文 = 1 行の主張の表 (474 行。区分と根拠つき。`tests/legal-claims-1901.ts`) に作り替え、本文と表の 1 対 1 を T-35 で確かめる形にした (R-26。Q-24 を解決)。F-38〜F-50・R-26〜R-27・S-18〜S-20・T-34〜T-38・§13.1・§11.2〜§11.3・§12 の 2 行・§16 の 2 行・§17 の 5 行・Q-26〜Q-28 |
| v1.9 | 2026-10-19 | 網羅性の反映 (周 5): §16 のパス `/terms` `/privacy` を持つテストの集合を、引用符の無い形 (テンプレート文字列・正規表現・describe の名前・コメント) も拾う grep で origin/main `ad44c2c5` に引き直し (30 本)、表に無かった 6 本 (`apps/mobile/__tests__/lib/siteConfig.test.ts`・`apps/mobile/__tests__/app/navigator-font-styles.test.tsx`・探索用の e2e 2 本・`tests/e2e/landing-page.spec.ts`・`tests/site-config-guard.test.ts`) の行を足した (`site-config-guard` は新設の文面モジュールを走査の対象に含める番兵として段 A に)。§17 に、2 ページへリンクする製品のファイル 3 つ (`landing-copy.ts`・`checkout-confirmation.tsx`・設定画面) の行を「変更不要」として足した。§14 の段 A の触るファイルの欄に、`legal-text-1901.test.ts` の 31 本と `legal-document-body.test.tsx` の 3 本 (T-21〜T-23) の内訳と合計 34 本を書き、割り振り表と同じであることを明示した (中身は変えていない) |
| v1.10 | 2026-10-19 | 審査 R5 の反映: プライバシーポリシー第9条の「登録したメールアドレス」を、招待を受けて参加したメンバーと本人のアカウントをつないだ未成年者の参加の時点の登録のメールアドレスが承諾済みの招待や案内の宛先として残り、家族の代表者と大人・組織の管理者に見えると直し、ログインの履歴の行と分けた (F-51・F-19・§11.2・T-32・T-33)。写真の保存を実装に合わせ、食事の写真と献立の作成の依頼の画面の冷蔵庫の写真は保存し、健康診断・血液検査の結果と体重計・体組成計の表示の写真は読み取りに使うだけで保存しないと書いた (利用規約第2条・第13条 1 項・プライバシーポリシー第3条の健康の行とカメラの行・第5条・第9条。F-52・T-41)。運営のメモを、退会で消えるアカウントについてのメモと、残るお問い合わせ・請求の対応のメモに分けた (利用規約第17条 3 項 (e)・プライバシーポリシー第3条・第12条。F-36)。解散した家族グループを解散から 90 日で削除し、保護者の同意の記録を持つグループは残すことを第12条に足し、保護者の同意の記録の保存を期限を定めない形に直し、利用規約第11条 6 項から参照した (`LEGAL_FACTS.dissolvedFamilyGroupRetentionDays`。F-53・F-30・T-39)。利用規約第1条 3 項を、本規約が個別規定に優先し、個人情報の取扱いはプライバシーポリシーが優先する形に改め、§9.4 の 3 に「公開の前」の事項 (§17 の 2 行・Q-23・Q-25・Q-27) の解決を確かめる工程を足した。レシピは画面に作成・公開・コメントの入口が無く、公開の状態のレシピは未ログインの人にも読めるので、利用規約第6条を画面にある表示・いいね・コレクションに、第13条 2 項を公開の状態の見え方に、第14条 4 項を投稿した評価一般に、プライバシーポリシー第3条のレシピの行を実際の取得の方法に直した (F-54・T-42・§17 の候補行)。引用したメニューの名前を実装の「プランとお支払い」「開示・訂正・利用停止の請求」に直し、T-40 で実装と突き合わせる形にした (F-55・R-28)。利用規約第10条 2 項から、販売を始めていない間の「準備中」の表示の文を外した (範囲の正本の方針: 未完成や予定を示す書き方をしない)。§4.3 の表の 6 行の行末の `\|` を足し、docs を走査する番兵 3 本を §16 に足した。主張の表を作り直した (479 行)。プライバシーポリシー第5条の運営の操作の記録の行の根拠を F-41 に直した。F-51〜F-55・R-28〜R-29・T-39〜T-42・§13.1 の定数 4 つ |
| v1.11 | 2026-10-19 | 網羅性の反映 (周 6): §11.1 に、アプリの最初の画面 (welcome) の「利用規約」「プライバシー」→ アプリの公開ページ → 「Web版を開く」の行を足し、ログイン済みのアプリの設定タブの行を、公開ページを通らず直接外部ブラウザで開く実装 (`apps/mobile/app/(tabs)/settings.tsx:406-419`) に直した。保護者の同意書 (`/legal/parental-consent`) の入口と `/privacy` へのリンクの行を足した。§11.3.1 に、AI 事業者への提供の同意 (`external_data_consents`) の状態 (granted・outdated・none) × 出来事 (送る操作・同意・撤回・撤回の後のキューの依頼・再同意・AI の同意の版の更新・利用規約の版上げ・退会) の表 (A-1〜A-8) を足し、利用規約第7条 1〜3 項とプライバシーポリシー第6条 (同意の 1〜5) が約束する撤回と再同意の効果を実装に対応させた。§17 の `src/app/company/page.tsx` の行を範囲外の候補から #1911 が持つ行に直し、`src/app/legal/page.tsx:24-25`・組織の画面 2 つ (`src/app/(org)/org/dashboard/page.tsx:64`・`src/app/(org)/org/challenges/page.tsx:51`)・運営の画面 (本書の行にしない理由)・アプリの公開ページ (変更不要。`PublicPage` の子が無いときの文は候補)・保護者の同意書のページ (変更不要) の行を足した。Q-15 を直し、Q-29 (献立の依頼のキューのジョブが利用規約の同意と凍結を確かめないこと) を足した。本文 (§6・§7) と主張の表 (§10) は変えていない |
| v1.12 | 2026-10-19 | 修正 R0 (前の走行の R6 の 12 件の blocking と、2026-10-19 11〜12 時台の範囲の判断 (P-9〜P-11) を設計書の全体に当てる書き直し): (1) 本文の粒度 (P-11・R-28): 本文を法令が求める事項と権利義務の約束だけにした。利用規約第6条の機能の一覧・画面の名前の引用 (「設定の「…」」「ホームの「…」」・links の「設定（…）」)・道順・家族の役割ごとの操作の列挙 (第5条 4 項・第11条 3 項)・組織の管理者の画面の項目の細部・第4条のログイン履歴の画面・第8条の機能ごとと自動処理の上限・第19条のメールの列挙を外し、プライバシーポリシー第3条 (取得する情報。15 区分の種類の水準)・第4条・第6条 (送る情報の種類)・第9条 (20 行の表を 8 項の種類の水準に)・第10条 (停止の方法の列を外した)・第12条 (18 行)・第14条 (確認メールの時間と回数を外した) を種類の水準に畳んだ。R-28 と T-40 を「画面の名前を写して突き合わせる」形から「画面の名前の引用の形を本文に入れさせない」形に改め、`QUOTED_SCREEN_NAME_SOURCES` などを廃止した。主張の表を 479 行から 383 行に作り直した。(2) 有料の条文 (P-9・R-30): 利用規約第10条を「料金」の条にして「本サービスは、無料で利用できます」だけにし、自動更新・解約・返金・決済の事業者・「アプリ内課金を行いません」の項と第17条の返金・第16条と第24条の解約・第21条の料金に結ぶ責任の上限を外した。プライバシーポリシーの有料プランの区分・決済の目的・委託先の Stripe・決済の画面の外部送信・決済の記録の保存を外した。#1912 が版を上げて足す行を §17 に置き、T-33 (有料の語が無い) を新設した。T-34 に有料プランの 2 表の理由 `paid_plan` を足した。(3) 未完成や予定の書き方 (R-32): 「現在、家族に健康の記録を表示する機能はありません」「解除予定の日時」「配信を止める設定はありません」を外し、T-6 (未完成や予定の語が無い) を新設した (旧 T-6 の未ログインの日数は、本文が日数を書かなくなったので廃止)。(4) 事業者の情報 (P-10・R-31): `LegalTextContext` を `businessAddress`・`phoneDisclosure`・`businessEmail`・`businessHours` に改め、プライバシーポリシー第1条に所在地・代表者・電話番号の欄の文・メールアドレス・営業時間を、窓口 (利用規約第28条・プライバシーポリシー第17条) に事業者のメールアドレスと営業時間を出す形にした。定数は #1911 の名前 (F-56)。着手の条件に #1911 のマージを足した (§14)。`tests/site-config-ui.test.tsx` の追随を §16 に足し、T-16 を事業者の情報の検査に改めた。(5) その他: 多要素認証の文を猶予に依らない形にし (Q-25 を解決)、未ログインの日数を「長期間」にし (Q-22 を解決)、Q-5・Q-15・Q-24 を解決、Q-6・Q-21 を #1912 へ、Q-30 を足した。F-56〜F-58・P-9〜P-11・R-30〜R-32・S-21〜S-22 を足した。§11.2 の状態比較表・§11.3 の条の参照・§13 のテスト (T-3・T-6・T-8・T-14・T-16・T-25・T-28・T-30〜T-34・T-36〜T-42)・§13.1 の定数・§15・§16・§17・§18 を追随させた |
| v1.14 | 2026-10-19 | 公開の前に決める事項のオーナーの選択 (P-12) を反映: 同意の前でも本人が退会と書き出しを行える画面 `/legal-consent/account` と、同意画面・未成年の案内・「同意しない」の後の案内からの入口 (Q-23)。利用規約第5条 3 項・第17条 1 項・第24条 2 項とプライバシーポリシー第13条 4 項を合わせ (版は v2026.1 のまま)、主張の表を 382 行に (§10.2・§10.3)。保護者の同意書・未成年の案内・子どもの追加の画面の文を実装に合わせ、同意書の版を v2026.2 に (Q-27)。Q-26 は別の案件へ。§9.4 の 2 (お知らせへの予告) は今回は行わない (§9.3・§11.2 も合わせ、次の改定でお知らせに載せる中身を、同意の前でも退会と書き出しができることに直した)。F-10・F-32・F-40・R-24・S-5・S-14・S-17・§11.1〜§11.3・§13 の T-28・§14 段 C・§15・§17・§18 (Q-23・Q-26〜Q-28) を追随 |
| v1.13 | 2026-10-19 | 網羅性の反映 (周 1): T-29 を CSP の `connect-src` だけから `script-src`・`frame-src`・`img-src`・`connect-src` の外部の許可先の全部に広げ、許可先 → 第10条の送り先の語の対応をテストのローカル定数 `CSP_EXTERNAL_ORIGIN_DISCLOSURE` (7 キー)・`CSP_DISCLOSED_DIRECTIVES`・`CSP_NON_EXTERNAL_SOURCE_PATTERN` にした (§13.1・§15)。`images.unsplash.com` は第10条の表に行を足さず、`null` (端末から送らない) とし、T-29 がその理由 (`next/image` の最適化を通る・アプリは使わない) をソースで確かめる (F-15。本番の DB の画像の URL の列にもこのホストは 0 件)。§11.3 に、未同意 (old / none) と凍結中の人の家族グループ・組織の操作の 2 行を足した。§12 に `AI_CONSENT_VERSION_MISMATCH` (409) の行と、内部の記録のコード `account_frozen`・`consent_outdated` の §12.1 を足した。§9.3・§11.2・§14・§16 の CSP の行を追随 |
| v1.15 | 2026-10-19 | 公開の後の現在形化 (製品の挙動は変えない): Status と §9.4 を実装済み・公開済み (#1918 2ba5b3b3) に、F-3・F-4・F-56・§2.1・§8.3 の前提・§14 の着手の条件・§17 の #1911 の行・Q-15 を #1911 のマージ済み (#1916 4b1e1abe) に、§0.6・§9.1 の施行日の仮置きと目印の記述を公開日 2026-10-19 に確定した書き方に (Q-12 は解決)、§9.2 の保護者の同意の行を v1.14 の版上げ (v2026.2) に、§16 の `tests/no-pending-wording-1911.test.ts` の行と T-6 を今の走査の範囲 (`src/lib` を含む) に直した。§0.6 と Q-11 に本番の Supabase のリージョン (ap-northeast-1・2026-10-19 に読み取りで確認) を足した |
| v1.16 | 2026-10-21 | #1917 (docs/design/family/11-self-dissolve.md §18) への追随: 利用者が家族グループ・組織を解散する画面と API ができたので F-59 を足し、F-39・F-53・R-24・S-18・§11.2・§11.3 (`current` と `old / none` の退会の行)・§12 の 409 の行・§17 の 2 行・§18 Q-23・Q-26・§0.1 P-12 の受け方の (3) を現在形にした。§6 の利用規約第11条 4 項・第12条 4 項・第17条 2 項と §7 のプライバシーポリシー第13条 9 項を「譲渡するか解散するまで退会できない」に改め、主張の表 (§10.3) の 6 行と区分の数 (§10.2) を合わせた。版は family/11 §18.4 の規律で v2026.2 |
| v1.17 | 2026-10-21 | #1912 (docs/design/billing/03-paid-plans-and-iap.md §11・段 E) への追随: 有料プランの条文を足した利用規約 (§6。第10条 2〜11 項・第11条 1 項・第16条 2 項・第17条 5 項・第24条 5 項) とプライバシーポリシー (§7。第3条の有料プランの行・第4条の目的・第7条の Stripe と RevenueCat・第10条の 2 行・第12条の 4 行) を実装の文面モジュールの全文に合わせ、主張の表 (§10.3。42 行の追加と 3 行の直しで 424 行) と区分の数 (§10.2)、T-33・T-34 (§13) と §13.1 の定数、§9.1 の版 (`v2026.3`。施行日は仮置き)、P-5・R-30・F-57・§0.6・§11.2・§17 の #1912 の行・§18 Q-6・Q-21 を合わせた。旧版の控えは `docs/legal/archive/v2026.2/` |
| v1.18 | 2026-10-22 | 公開の後の現在形化 (製品の挙動は変えない): v2026.3 の施行日を公開日 2026-10-22 (#1930 f14f1741) に確定した (v1.17 の「施行日は仮置き」は当時の記録)。Status に v2026.2 (#1917)・v2026.3 (#1930) の公開を足し、§9.1 の施行日の箇条を 3 つの版の公開日に、§9.4 の 2 の括弧を「v2026.2・v2026.3 の公開でも行わなかった」に、5 の確認する版をいまの版に、F-9 の free の回数を 3 に、§11.2 と §15 の `PRIVACY_PROCESSORS` を 10 社に直した |
