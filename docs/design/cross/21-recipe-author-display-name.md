# 公開レシピの作者の表示名を出す (#1917 の続き) 設計

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-24 | 新設 (Issue #1917 の続き (api-read-errors のあと) の設計ゲート・A 型 4 相。公開レシピの一覧・詳細・コメントの作者名を、本人以外にも表示名で出す) |

要件の正本は Issue #1917 の本文とコメント。本書はその上で決めた範囲と設計で、Issue と食い違ったら本書が正。
ファイル名は cross/21 (cross/ の既存は 01〜09・12・13a・13b・14〜20。10・11・13 は欠番)。

前提 (本書が従う条件):

- オーナーの選択 (2026-10-24): 他の人の公開レシピの作者名を表示名で出す。
- 読み込みの失敗の直し (fix/api-read-errors の枝 `a8d75cec`。`src/lib/recipes/viewer-lookups.ts` の `loadRecipeViewerLookups` が作者の名前と自分のいいねを別のクエリで引く形) が main に入ったあとに積む。本書はその枝の形を土台にし、枝がまだ main に無いことを §3 の事実に書く。
- 本番の DB には書き込まない (本書の事実は 2026-10-24 の読み取りだけ。§3.4)。
- ローンチ前。本番の `auth.users` は 195 行・`user_profiles` は 65 行・`recipes` と `recipe_comments` は 0 行 (2026-10-24 の SELECT。§3.4)。既存の行の書き換えは無い。
- `user_profiles` の SELECT の RLS (本人の行だけ) は変えない。他人の行を公開の場に出す経路は、本書が足す 1 本の関数だけ。
- Next.js の API で service_role を使わない (cross/02 §3.3)。
- 範囲外: 作者名を描く画面を新しく作ること (今は Web・モバイルのどこにも作者名を描く画面が無い。§3.3 F-13)。プロフィールの画面に足すのは「名前を出すか」の切り替え 1 つだけ。新しい要求は発明しない。

---

## 0. 外形固定と分冊判定 (相 1)

### 0.1 発注と決めること

公開レシピの一覧 (`GET /api/recipes`)・詳細 (`GET /api/recipes/[id]`)・コメント (`GET` / `POST /api/recipes/[id]/comments`) が返す `authorName` は、`user_profiles` の SELECT の RLS が本人の行だけを通すため、他の人が作ったレシピ・コメントではいつも既定の呼称「匿名」になる。本書は、他の人にも作者の表示名が出るようにする。

本書で決めること (列挙):

1. 出す名前の列と、名前が無い人・退会した人・凍結中の人・18 歳未満の本人のアカウント (保護者の同意の経路) の扱い → §6.1
2. 読み方 (service_role / RLS / VIEW / SECURITY DEFINER の関数のどれか)。最小の情報 (名前だけ・公開レシピの作者だけ) に絞る。cross/02 §3.3 との整合 → §5・§6.2
3. 未ログインの人にも出すか → §6.3
4. プライバシーポリシーの文面が足りるか。足りないなら、版 v2026.4 に入れるか別の版にするかの選択肢 → §6.4・§21 Q-1
5. 本人が名前を出さない選択 (匿名で公開) を持つか。持つなら設定の置き場 → §6.5
6. 段分けと触るファイル (api-read-errors のあとに積む) → §15

### 0.2 要件行列

| # | 要件 | 出どころ | 本書の節 |
|---|---|---|---|
| R-1 | 他の人が作った公開レシピの一覧・詳細と、そのコメントで、`authorName` が作者の表示名 (`user_profiles.nickname` を `normalizeProfileName` で整えたもの) になる | 発注 | §6.1, §7.1, §7.3 |
| R-2 | 名前が無い人 (空・空白だけ・仮置きの `'Guest'`) は今までどおり既定の呼称「匿名」 | `src/lib/recipes/author-name.ts:9-12` の既存の規則 | §6.1 (1) |
| R-3 | 退会した人の公開レシピは `user_id` が NULL になって残り (`recipes_user_id_fkey` は `ON DELETE SET NULL`)、作者名は「匿名」。退会した人のコメントは `ON DELETE CASCADE` で消える | プライバシーポリシー第12条 (`src/lib/legal/privacy-text.ts:420`)・`supabase/migrations/20261010000100_auth_users_fk_on_delete.sql:51-54` | §6.1 (2) |
| R-4 | 凍結中の人 (`isAccountFrozen` が真) の作者名は出さない (「匿名」)。一時凍結の期限が過ぎた人は出す | 決めること 1 | §6.1 (3), §7.1 |
| R-5 | 18 歳未満の本人のアカウント (`user_profiles.birth_date` で 18 歳未満。`ADULT_AGE_YEARS`) の作者名は出さない。生年月日の無い人も出さない | 決めること 1・cross/14 §0 (年齢は `birth_date` だけで判定) | §6.1 (4), §7.1 |
| R-6 | 他人の `user_profiles` を読むのは、公開レシピ (`is_public = true` かつ `hidden_at IS NULL`) の作者か、そのレシピへのコメントを書いた人の、表示名 1 列だけ。それ以外の列・それ以外の人は読めない | 決めること 2 (最小の情報) | §5, §6.2, §7.1 |
| R-7 | Next.js の API と `viewer-lookups.ts` は service_role を使わない。`user_profiles` の RLS ポリシーは足さない・変えない | cross/02 §3.3・CLAUDE.md §3 | §5, §7.1, §9.3 |
| R-8 | 読む経路は SECURITY DEFINER の関数 1 本。`SET search_path = ''`・完全修飾・引数の型まで含めた完全形で REVOKE してから必要なロールにだけ GRANT (#1039 / #1020 の定型) | `supabase/migrations/20261023130000_account_deletion_owner_guard.sql` の定型 | §7.1 |
| R-9 | 未ログインの人にも出す (公開レシピは未ログインでも読める。利用規約第13条 2 項「ログインしていない方を含め、誰でも閲覧できる状態」)。関数は anon も呼べる | 決めること 3・`src/lib/legal/terms-text.ts:299` | §6.3, §7.1, §7.8 |
| R-10 | 本人には、自分のレシピ・コメントの `authorName` に自分の名前が今までどおり出る (非公開のレシピ・名前を出さない設定のときも) | fix 枝の `tests/integration/security/recipes-api-logged-in.test.ts` (本人の非公開のレシピに本人の nickname が出る) | §6.1 (5), §7.1 |
| R-11 | 本人が「名前を出さない」を選べる。置き場はプロフィールの編集 (`/profile` のニックネームの欄のすぐ下)。既定は「出す」 | 決めること 5 | §6.5, §7.6, §7.7 |
| R-12 | API の返り値の形 (`authorName: string`・コメントの `user_id` を返さない (#168)) は変えない | 既存の契約 | §8 |
| R-13 | 名前が読めなかったときは今までどおり 500 (名前が無いように見せない) | fix 枝の `viewer-lookups.ts` の決まり | §10 |
| R-14 | プライバシーポリシーの文面が足りるかを判定し、足りないなら逐語の文と版の選択肢を出す | 決めること 4 | §6.4, §7.12, §21 Q-1 |
| R-15 | migration と `.down.sql`・関数の権限・TS の定数の突き合わせを DB を使わない契約テストで固定し、実 DB の結合テストで R-1〜R-6・R-9・R-10 を確かめる | `tests/rpc-profile-name-placeholder-migration-contract.test.ts` の前例 | §7.9, §7.10, §12 |
| R-16 | 段の順序で、レシピの API が 500 を返す時間を作らない (関数が無い状態でコードを出さない) | 段分けの原則 | §15, §19 |
| R-17 | 設計の正典コードに `as any`・マジックナンバーを置かない (年齢の境・関数名・文面は名前付きの定数) | 設計の絶対条件 | §7, §13 |
| R-18 | 新しい環境変数・route・テーブル・RLS ポリシーを足さない。足すのは列 1 つ・関数 1 本・索引 1 つ | 発明しない | §14 |

### 0.3 ユーザーシナリオ (16 本。トレースは §4.3)

| # | シナリオ |
|---|---|
| S-1 | ログインしている利用者 A が、18 歳以上の利用者 B (名前あり・設定は既定) の公開レシピを一覧で見ると、`authorName` が B の表示名になる |
| S-2 | ログインしていない人が、B の公開レシピの詳細を開くと、`authorName` が B の表示名になる (コメントは RLS で 0 件のまま) |
| S-3 | A が B の公開レシピの詳細を開くと、コメントを書いた C (18 歳以上・名前あり) の `authorName` が C の表示名になる |
| S-4 | B が自分の非公開のレシピの詳細を開くと、`authorName` は今までどおり B 自身の名前 |
| S-5 | A が、名前を入れていない (仮置きの `'Guest'` のままの) 利用者 D の公開レシピを見ると、`authorName` は「匿名」 |
| S-6 | 利用者 E が退会すると、E の公開レシピは `user_id` が NULL になって残り、`authorName` は「匿名」。E のコメントは消える |
| S-7 | 運営が利用者 F を凍結 (無期限) すると、F の公開レシピの `authorName` は「匿名」になる。凍結を解除すると表示名に戻る |
| S-8 | 運営が利用者 G を一時凍結 (`unban_at` が未来) した間は「匿名」。`unban_at` を過ぎると表示名に戻る (ログインの判定 `isAccountFrozen` と同じ境) |
| S-9 | 16 歳の本人のアカウント H (保護者の同意の経路) が公開したレシピの `authorName` は「匿名」。H が自分で見ると自分の名前。18 歳の誕生日 (JST) から他の人にも表示名になる |
| S-10 | 利用者 I がプロフィールの編集で「公開したレシピとコメントに、ニックネームを作者名として表示する」をオフにして保存すると、他の人には I の公開レシピ・コメントの `authorName` が「匿名」になり、I 自身には自分の名前のまま。オンに戻すと表示名に戻る |
| S-11 | 利用者 J が公開レシピを 1 つも持たず、他人の公開レシピにコメントもしていないとき、誰かが J の id で関数を直接呼んでも J の名前は返らない (0 行) |
| S-12 | B が公開レシピを非公開に戻し、ほかに公開レシピもコメントも無いなら、B の名前は他の人には返らなくなる (B 自身の一覧には自分の名前) |
| S-13 | 運営が B の公開レシピを隠す (`hidden_at`) と、そのレシピは本人以外に出なくなる (既存の RLS)。B にほかの公開レシピ・コメントが無ければ、B の名前も他の人には返らなくなる |
| S-14 | C が B の公開レシピにコメントを投稿すると、`POST` の返り値の `authorName` は C 自身の名前 (名前を出さない設定でも、本人には自分の名前) |
| S-15 | `user_id` が NULL のシステムのレシピは、今までどおり `authorName` が「匿名」 (関数に id を渡さない) |
| S-16 | 関数の読み込みが失敗すると (接続の失敗など)、一覧・詳細・コメントの API は 500 を返す (名前が無いように見せない。既存の決まり) |

### 0.4 分冊判定

目安は「設計書 800 行超 / 消費先のレーン 3 以上 / 共有面に 2 つ以上触る」。本書は行数で目安に掛かり、共有面も 2 つ (`user_profiles` の列・プライバシーポリシーの文面) に触る。それでも **1 冊** とする。理由:

- 核は関数 1 本 (`recipe_author_display_names`) と lib 1 つ (`viewer-lookups.ts`) で、消費先の route 3 本は同じ lib の呼び出し側 (1 レーン)。核と配線に分けると、配線の冊は「`lookups.nicknames` を `lookups.authorNames` に改める」1 行の冊になる。
- プライバシーポリシーの文面は本書では編集しない (cross/20 が正典)。本書は逐語の文と版の選択肢を出し (§7.12・§21 Q-1)、改定は cross/20 の改定版か docs PR で行う。
- 段分け (§15) で、DB (段 A) → API と設定 (段 B) → 文面 (段 C。オーナーの選択のあと) の順に閉じる。

### 0.5 用語

| 語 | 意味 |
|---|---|
| 表示名 | `user_profiles.nickname` を `normalizeProfileName` (TS) / `public.normalize_profile_name` (SQL) で整えた名前。無い・空白だけ・仮置きの `'Guest'` は「名前が無い」 |
| 既定の呼称 | `RECIPE_AUTHOR_FALLBACK_NAME` = `'匿名'` (`src/lib/recipes/author-name.ts:9`) |
| 公開レシピ | `recipes.is_public = true` かつ `hidden_at IS NULL` の行 (RLS `Users can view public recipes` で本人以外にも見える行) |
| 公開の作者 | 公開レシピの `user_id` の人、または公開レシピへのコメント (`recipe_comments`) を書いた人 |
| 凍結中 | `isAccountFrozen` (`src/lib/auth/frozen.ts:25`) が真: `frozen_at` があり、`unban_at` が無いか未来 |
| 本人 | 関数を呼んだときの `auth.uid()` と同じ id の人 |
| 見ている人 | API を呼んだ人。未ログイン (`viewerId` が null) を含む |

### 0.6 読み方

- §3 が事実、§4〜§6 が決めたことと理由、§7 が正典コード (実装者はここを写す)、§9〜§12 が表とテスト、§15 が段の順序、§16〜§17 が既存のテストと他の文書への追随、§21 がオーナーに聞くこと。
- 本書の TS のブロックは、`// tsc:skip` を 1 行目に持つものを除き、そのまま型検査を通る形で書いてある (import を省かない)。`// tsc:skip` のブロックは、まだ main に無いファイル (fix 枝の `viewer-lookups.ts`) や結合テストの helper を相対パスで import するもの、既存ファイルの差分の断片。

---

## 1. 目的・スコープ

公開レシピの作者名を、本人以外 (ログインしている利用者と未ログインの人) にも表示名で返す。読む範囲は「公開の作者の表示名 1 列」に絞り、`user_profiles` の RLS は変えず、service_role も使わない。本人が名前を出さない選択を持てるようにし、凍結中・18 歳未満・退会・名前なしの人は「匿名」のまま残す。

対象外: 作者名を描く画面の新設。作者のプロフィール画面・作者ごとのレシピ一覧。コメントの `user_id` の公開。

---

## 2. 関連要件・既存設計

| 文書 | 関係 |
|---|---|
| cross/02-rls-patterns.md §3.3 (行 43-48) | Next.js の API で service_role を使わない。本書は SECURITY DEFINER の関数で読む (§5) |
| cross/02 §10 (行 585) | anon が EXECUTE できる関数は理由つきの許可一覧だけ (`tests/integration/security/anon-definer-execute.test.ts:95-100`)。本書の関数は一覧に足す (§7.8) |
| cross/14-parental-consent.md §0 (行 18-19) | 年齢の判定は `user_profiles.birth_date` だけ。18 歳未満の本人のアカウントは保護者の同意の経路。本書は 18 歳未満の名前を公開の場に出さない (§6.1 (4)) |
| cross/20-terms-privacy-text.md §2.2 F-19 (行 213)・F-33 (行 227)・F-49 (行 243) | `user_profiles` の SELECT が本人の行だけであること・家族の中の表示名の見え方。公開レシピの作者としての表示名の記載は無い (§6.4) |
| cross/20 §9.3 (行 2000) | 内容が変わる文面の直しは版を上げる。本書の文の追加は版を上げる改定に当たる (§6.4・§21 Q-1) |
| cross/20 §9.4 (行 2014) | 版を上げる改定は施行日の前にお知らせで予告する |
| プライバシーポリシー第12条 (`src/lib/legal/privacy-text.ts:420`) | 公開の状態のユーザーコンテンツは退会後も紐づけを外して匿名で残す。本書の R-3 の根拠 |
| 利用規約第13条 2 項 (`src/lib/legal/terms-text.ts:299`) | 公開の状態のユーザーコンテンツは未ログインの人を含め誰でも閲覧できる。本書の R-9 の根拠 |
| #1917 の続き (fix/api-read-errors) | `loadRecipeViewerLookups` の形 (別のクエリで引く・失敗は 500) を土台にする |

---

## 3. 現状の事実 (origin/main `c9ee3e59`・fix/api-read-errors `a8d75cec`・本番の読み取り 2026-10-24)

### 3.1 API と lib

| # | 事実 | 根拠 |
|---|---|---|
| F-1 | main の一覧 `GET /api/recipes` は `*, user_profiles(nickname), recipe_likes(user_id)` の埋め込みで作者名を読む。認証時は `is_public.eq.true,user_id.eq.<自分>`、未認証は `is_public = true` に絞る。`authorName` は `recipeAuthorName(...)` | `src/app/api/recipes/route.ts:31-33, 42-44, 81` |
| F-2 | main の詳細 `GET /api/recipes/[id]` は `user_profiles(nickname, id)` とコメントの中の `user_profiles(nickname)` を埋め込む | `src/app/api/recipes/[id]/route.ts:28, 35, 54, 80` |
| F-3 | main のコメント `GET` / `POST /api/recipes/[id]/comments` も埋め込みで名前を読む。`GET` は未認証なら 401 | `src/app/api/recipes/[id]/comments/route.ts:37, 103` |
| F-4 | fix 枝では、埋め込みを外し、`src/lib/recipes/viewer-lookups.ts` の `loadRecipeViewerLookups(supabase, viewerId, { authorIds, recipeIds })` が `user_profiles` を `.select('id, nickname').in('id', authorIds)` で、`recipe_likes` を自分の `user_id` とレシピの id で引く。`viewerId` が null なら DB に問い合わせず空を返す。失敗は `{ ok: false, table: 'user_profiles' または 'recipe_likes', error }` で、route が `internalError` の 500 にする。返り値は `nicknames: ReadonlyMap<string, unknown>`・`likedRecipeIds: ReadonlySet<string>` | fix 枝 `a8d75cec` の `src/lib/recipes/viewer-lookups.ts` (`RecipeViewerDb`・`RecipeViewerLookups`・`RecipeViewerLookupResult`・`loadRecipeViewerLookups`) |
| F-5 | fix 枝の route 4 本 (一覧・詳細・コメント GET / POST) は `recipeAuthorName(lookups.nicknames.get(<user_id>))` で `authorName` を作る (詳細はレシピとコメントの両方)。コメントの `user_id` は返さない (#168)。詳細の閲覧数の加算 (`supabase.rpc('increment_recipe_view_count', …)`) はログイン時だけ | fix 枝の `src/app/api/recipes/route.ts`・`[id]/route.ts`・`[id]/comments/route.ts` |
| F-6 | `recipeAuthorName(nickname)` は `normalizeProfileName(nickname) ?? RECIPE_AUTHOR_FALLBACK_NAME`。`RECIPE_AUTHOR_FALLBACK_NAME = '匿名'` | `src/lib/recipes/author-name.ts:9, 12` |
| F-7 | `normalizeProfileName` は前後の空白を除き、空と仮置きの `PROFILE_NAME_PLACEHOLDER = 'Guest'` (厳密一致) を null にする。SQL の `public.normalize_profile_name(text)` が同じ規則 (IMMUTABLE・SECURITY INVOKER・`search_path = ''`。EXECUTE は service_role だけで、SECURITY DEFINER の関数の本文からは所有者 postgres の権限で呼べる) | `packages/shared/src/profile-name.ts`・`supabase/migrations/20261016200000_rpc_profile_name_placeholder.sql` |
| F-8 | fix 枝の `viewer-lookups.ts` の冒頭コメントは「名前が引けるのは RLS で見ている人が読める行だけ (いまは本人の行だけ)。引けなかった作者は既定の呼称」と書いている。他人の名前がいつも「匿名」になるのはこのため | 同ファイルの冒頭コメント |
| F-9 | RLS の効くクライアント `createClient()` は anon キー + Cookie / Authorization ヘッダ。service_role は `getSupabaseAdmin()` だけ (`tests/supabase-service-role-client-scan.test.ts` が見張る) | `lib/supabase/server.ts` (`getSupabaseAdmin`・`createClient`) |
| F-10 | 他人の `user_profiles` を読むときは認可のあとに `getSupabaseAdmin()` (対象を絞る条件つき) というのが root CLAUDE.md の規則。未ログインの一覧・詳細には認可が無い | `CLAUDE.md:83` |
| F-11 | `PUT /api/profile` は `fromUserProfile(body)` (camelCase → snake_case) の結果を RLS のクライアントで `user_profiles` に `update` する。`FIELD_MAP` (行 27) は栄養の再計算の判定にだけ使う。`toUserProfile` は `GET` の行を camelCase にする | `src/app/api/profile/route.ts:27, 165-166`・`lib/converter.ts:21, 144, 158, 278` |
| F-12 | `UserProfile` (ドメイン型) は `types/domain.ts:171` (`nickname` は行 173・`aiLearningEnabled` は行 298)。DB の行の手書きの型 `DbUserProfile` は `types/database.ts:4` (`ai_learning_enabled: boolean / null` は行 132)。`toUserProfile` は `ai_learning_enabled ?? true` のように既定を補う | `types/domain.ts`・`types/database.ts`・`lib/converter.ts:144` |
| F-13 | `authorName` を読む画面は Web (`src/app`・`src/components`) にもモバイル (`apps/mobile`) にも無い (`authorName` / `author_name` / 「作者」の参照は API route と `author-name.ts` だけ)。`/api/recipes/{id}` を呼ぶのは `src/app/(main)/favorites/_components/FavoriteRecipeModal.tsx` (いいねの解除) と `src/app/(main)/menus/weekly/page.tsx` (レシピの表示) で、どちらも `authorName` を描かない | origin/main の `git grep` (2026-10-24) |
| F-14 | プロフィールの編集画面はニックネームの欄 (`Label` + `Input`。`editForm.nickname`・`updateField('nickname', …)`) を基本情報タブの先頭に持ち、保存は `fetch('/api/profile', …)` (PUT)。`editForm` は `Partial<UserProfile>`、`updateField(field: keyof UserProfile, value)` | `src/app/(main)/profile/page.tsx:121, 242, 296, 725-733` |

### 3.2 DB (migration と本番)

| # | 事実 | 根拠 |
|---|---|---|
| F-15 | `user_profiles` の SELECT のポリシーは `Users can view own profile` (`auth.uid() = id`。TO 句なし = public) だけ。INSERT / UPDATE も本人の行だけ。後の migration で SELECT のポリシーは足されていない。本番も同じ 3 本 | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:10076`・本番の `pg_policies` (2026-10-24) |
| F-16 | `recipes` の SELECT のポリシー `Users can view public recipes` は `(hidden_at IS NULL OR auth.uid() = user_id) AND (user_id IS NULL OR is_public = true OR auth.uid() = user_id)`。TO 句なしで anon も読める。`recipe_comments` の SELECT は `Anyone can view comments` (TO authenticated・USING true) で anon は読めない | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:10088`・`supabase/migrations/20261009000500_hide_moderated_content.sql:169`・本番の `pg_policies` |
| F-17 | 外部キー: `recipes.user_id` → `auth.users` (`ON DELETE SET NULL`)・`recipe_comments.user_id` → `auth.users` (`ON DELETE CASCADE`)・`user_profiles.id` → `auth.users` (`ON DELETE CASCADE`)。`user_profiles` を指す外部キーは無い (PostgREST の埋め込みが解決できない理由) | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:9463`・本番の `pg_constraint` (2026-10-24) |
| F-18 | 退会の直前の `prepare_account_deletion` は本人の非公開のレシピだけを消し、公開のレシピは `user_id` を外して残す (プライバシーポリシー第12条のとおり) | `supabase/migrations/20261010000100_auth_users_fk_on_delete.sql:51-54, 462` |
| F-19 | 凍結の列は `user_profiles.frozen_at` / `unban_at` / `frozen_by` / `frozen_reason` (特権列。本人は書けない)。凍結の判定は `isAccountFrozen({ frozenAt, unbanAt })` = `frozen_at` があり、`unban_at` が無いか今より未来。middleware と `requireUser` が使う | `src/lib/auth/frozen.ts:25`・`lib/supabase/middleware.ts:58` |
| F-19a | 凍結中の本人がセッションつきで `/api/*` を呼ぶと、middleware が `isAccountFrozen` で判定し、`FROZEN_ALLOWED_API_PATHS` (退会・書き出し・解約・解散など) と例外の 2 つ (ネイティブ認証ブリッジのコード・お問い合わせの POST) を除いて 403 `AUTH_ACCOUNT_FROZEN` を返す (レシピの route は除外に無い)。凍結の判定に要る `user_profiles` が読めなかったときは止めない (fail-open) | `lib/supabase/middleware.ts:179-247`・`src/lib/auth/frozen.ts:70` |
| F-19b | `recipe_comments` の INSERT のポリシー `Users can create comments` は `user_id = auth.uid()` だけで、レシピが公開か・隠されていないかを見ない。fix 枝のコメント `GET` もレシピの見え方を見ずに、`recipe_comments` を RLS (authenticated に USING true) で読む | `supabase/migrations/20251126124224_create_meal_planner_tables.sql:9602, 9719`・fix 枝の `src/app/api/recipes/[id]/comments/route.ts` |
| F-20 | 年齢は `user_profiles.birth_date` (write-once の特権列。`accept_legal_documents` だけが書く) と SQL の `public.age_years_jst(date)` (JST の暦日の満年齢。EXECUTE は全ロールから外してあり、DEFINER の関数の本文から呼ぶ)。18 は `ADULT_AGE_YEARS` (`packages/shared/src/parental-consent.ts:13`) | `supabase/migrations/20261017030000_parental_consent_and_birth_date.sql:52, 79-85, 282` |
| F-21 | `user_profiles` の特権列ガード (`guard_user_profiles_privileged` / `_on_insert`) は列を名指しで止める。名指しに無い列は本人が RLS のクライアントで書ける | `supabase/migrations/20261017030000_parental_consent_and_birth_date.sql` の 8 |
| F-22 | 索引: `recipes` に `idx_recipes_user_id` (user_id) がある。`recipe_comments` には `idx_recipe_comments_recipe_id` と主キーだけで、`user_id` の索引は無い | 本番の `pg_indexes` (2026-10-24) |
| F-23 | public の関数の既定の権限: 作ると anon / authenticated / service_role と PUBLIC に EXECUTE が付く。引数の型まで含めた完全形で REVOKE し、必要なロールにだけ GRANT するのが定型。anon が EXECUTE できる SECURITY DEFINER の関数は許可一覧 (`get_invite_details(text)`・`get_promotion_details(text)`) だけ | `supabase/migrations/20261023130000_account_deletion_owner_guard.sql` の冒頭・`tests/integration/security/anon-definer-execute.test.ts:95-100` |
| F-24 | 公開 VIEW の前例は `user_consultation_history` の 1 つだけ。本番の public の VIEW もその 1 つ。作者名を返す関数・VIEW は無い (`pg_proc` で author / nickname / display_name を名に持つ関数は `normalize_profile_name` だけ) | 本番の `pg_class` / `pg_proc` (2026-10-24) |

### 3.3 文面 (利用規約・プライバシーポリシー)

| # | 事実 | 根拠 |
|---|---|---|
| F-25 | 利用規約第13条 2 項: 「ユーザーが公開の状態にしたユーザーコンテンツは、ログインしていない方を含め、誰でも閲覧できる状態になります。」 | `src/lib/legal/terms-text.ts:299` |
| F-26 | プライバシーポリシー第3条はニックネームを取得する情報に載せる。第4条の利用目的は「本サービスの提供（アカウントの管理、記録の保存と表示、…）」。第6条は AI 事業者への送信にニックネームが含まれることと「ニックネームには実名を使わないことをお勧めします」を書く。第8条 3 項は「家族グループのメンバーや組織の管理者に対する表示は…（第9条）」。第9条の見出しは「家族グループと組織での見え方」で、公開レシピの作者としてニックネームが他の利用者 (未ログインを含む) に出ることは、どの条にも書いていない | `src/lib/legal/privacy-text.ts:290, 342, 356-360` |
| F-27 | 第12条の表: 「公開の状態のユーザーコンテンツ」は「退会後も、ユーザーとの紐づけを外して匿名の状態で残します」。第15条: 18 歳未満は保護者の同意が必要・13 歳未満の本人名義のアカウントは作らない。18 歳未満の本人の公開レシピの作者名の扱いは文面に無い | `src/lib/legal/privacy-text.ts:420, 493` |
| F-28 | いまの版は両文書とも v2026.3 (施行日 2026-10-22)。PR #1997 (OPEN・`feat/siwa-d-legal`) がプライバシーポリシーに Apple を足して両文書を v2026.4 にし、`effectiveDate` は仮置きの 2026-11-01、施行日の前にお知らせで予告してからマージする手順。予告の文は Issue #1139 のコメントに置いてあり、「Apple についての記載を加えるもの」と書いている | `packages/shared/src/legal-versions.ts` (`LEGAL_DOCUMENTS`)・PR #1997 の本文・Issue #1139 のコメント |
| F-29 | 文面の 1 文 = 主張の表 `tests/legal-claims-1901.ts` の 1 行 (`LEGAL_CLAIM_COUNT = 424`。`fragment` が文の中に 1 回だけ現れ、`chars` が文の字数 (文末の 。を除く))。文を足すと行と `LEGAL_CLAIM_COUNT` を足す | `tests/legal-claims-1901.ts:25, 354-364`・`tests/legal-text-1901.test.ts:1058-1073` |

### 3.4 本番の読み取り (2026-10-24。SELECT だけ。書き込みなし)

| 数 | 値 |
|---|---|
| `auth.users` | 195 |
| `user_profiles` | 65 (うち仮置き `'Guest'` 2・空 0・凍結中 0・`birth_date` あり 5) |
| `recipes` / `recipe_comments` | 0 / 0 |
| `user_profiles` の列 | `nickname text NOT NULL`・`frozen_at`・`unban_at`・`birth_date date` を含む 130 列。表示名の専用の列は無い |

既存の行の書き換えは無い (列の追加の既定値が 65 行に入るだけ)。

---

## 4. 構想 (相 2)

### 4.1 構造

```
見ている人 (本人 / 他のログイン利用者 / 未ログイン)
   │ GET /api/recipes・/api/recipes/[id]・/api/recipes/[id]/comments  (route は変えない。呼び出しの 1 語だけ)
   ▼
loadRecipeViewerLookups(supabase (RLS の anon キーのクライアント), viewerId, { authorIds, recipeIds })
   ├─ 名前: supabase.rpc('recipe_author_display_names', { p_user_ids: authorIds })   ← 未ログインでも呼ぶ
   └─ いいね: ログイン中だけ、recipe_likes を自分の user_id で (fix 枝のまま)
   ▼
public.recipe_author_display_names(uuid[])  SECURITY DEFINER・STABLE・search_path = ''
   入力の id ごとに、user_profiles を主キーで引き、次のどちらかなら (id, 表示名) を返す。それ以外は行を返さない
     (a) id = auth.uid()  … 本人には自分の名前をいつも返す (非公開のレシピ・名前を出さない設定でも)
     (b) 公開の作者 (公開レシピの user_id か、公開レシピへのコメントの user_id)
         かつ show_recipe_author_name = true かつ 凍結中でない かつ birth_date があり 18 歳以上
   表示名は normalize_profile_name(nickname)。NULL (名前が無い) の人は返さない
   ▼
route: recipeAuthorName(lookups.authorNames.get(user_id))  → 返らなかった人は '匿名'
```

- 読む列は `user_profiles` の `id`・`nickname`・`show_recipe_author_name`・`frozen_at`・`unban_at`・`birth_date` (判定に使う) で、返すのは `id` と表示名だけ。
- 他人の名前が返る条件 (b) は「公開の場にすでに出ているコンテンツの作者」に閉じる。公開レシピもコメントも無い人の id を渡しても 0 行 (R-6・S-11)。
- 本人の選択は `user_profiles.show_recipe_author_name boolean NOT NULL DEFAULT true` の列 1 つ。特権列ではなく、本人が `PUT /api/profile` (RLS の UPDATE) で書く。
- RLS ポリシーは足さない。anon / authenticated の `user_profiles` の SELECT は本人の行だけのまま。

### 4.2 動き

1. 一覧: route が今までどおり `recipes` を RLS で読み、行の `user_id` を `authorIds` に渡す。`loadRecipeViewerLookups` が RPC で名前の表を作る。ログイン中は同時に `recipe_likes` も引く。
2. 詳細: レシピの `user_id` とコメントの `user_id` を `authorIds` に渡す。あとは一覧と同じ。
3. コメント GET: 未認証は 401 のまま。認証済みはコメントの `user_id` を渡す。
4. コメント POST: 保存の前に自分の id だけを渡す (本人の規則 (a) で自分の名前が返る)。
5. 設定: プロフィールの編集画面の基本情報タブで、ニックネームの欄の下のチェックを外して保存すると `PUT /api/profile` が `show_recipe_author_name = false` を書く。次の読み込みから他の人には「匿名」。

### 4.3 シナリオのトレース (§4.1 の構造で手で走らせた記録)

| # | 走らせた結果 | 判定の枝 |
|---|---|---|
| S-1 | 一覧 → `authorIds = [B]` → RPC: B は (b) を満たす (公開レシピあり・設定 true・凍結なし・18 歳以上・名前あり) → `(B, 'Bの表示名')` → `authorName` = B の表示名 | (b) |
| S-2 | 未ログイン → `viewerId` null でも RPC は呼ぶ (anon に EXECUTE) → `auth.uid()` は NULL なので (a) は偽・(b) で B の名前 → 表示名。コメントは `recipe_comments` の RLS (authenticated だけ) で 0 件 | (b) |
| S-3 | 詳細 → `authorIds = [B, C]` → C は公開レシピへのコメントがある → (b) → C の表示名 | (b) |
| S-4 | B 自身 → `auth.uid() = B` → (a) → 非公開でも B の名前 | (a) |
| S-5 | D は `normalize_profile_name('Guest')` が NULL → 行を返さない → `recipeAuthorName(undefined)` = 「匿名」 | 名前なし |
| S-6 | 退会 → `user_profiles` の行は CASCADE で消え、`recipes.user_id` は NULL → `distinctIds` が NULL を除くので RPC に渡らない → 「匿名」。コメントは CASCADE で消える | 行なし |
| S-7 | F: `frozen_at` あり・`unban_at` NULL → 凍結中 → (b) の凍結の条件で偽 → 行なし → 「匿名」。解除 (`frozen_at` NULL) で (b) に戻る | 凍結 |
| S-8 | G: `unban_at` が未来 → 凍結中 → 「匿名」。`unban_at <= now()` になると凍結中でない → 表示名 (`isAccountFrozen` と同じ境) | 凍結 (一時) |
| S-9 | H: `age_years_jst(birth_date) = 16 < 18` → (b) 偽 → 他の人には「匿名」。H 自身には (a)。18 歳の誕生日 (JST) に `age_years_jst` が 18 になり (b) 真 | 年齢 |
| S-10 | I: `show_recipe_author_name = false` → (b) 偽 → 他の人には「匿名」。I 自身には (a) で自分の名前。true に戻すと (b) 真 | 設定 |
| S-11 | J: 公開レシピもコメントも無い → (b) の EXISTS が偽 → 0 行。J 自身が呼べば (a) で自分の名前だけ | 公開の作者でない |
| S-12 | B が非公開に戻す → EXISTS (公開レシピ) が偽・コメントも無ければ (b) 偽 → 他の人には「匿名」。B 自身は (a) | 公開の作者でない |
| S-13 | 隠す → `hidden_at` あり → EXISTS の `hidden_at IS NULL` で外れる → ほかに公開の内容が無ければ「匿名」。レシピ自体は RLS で本人以外に出ない | 公開の作者でない |
| S-14 | POST → `authorIds = [C]` → `auth.uid() = C` → (a) → C の名前 (設定に関わらず) | (a) |
| S-15 | `user_id` NULL → `distinctIds` が除く → RPC に渡らない → 「匿名」 (fix 枝と同じ) | 行なし |
| S-16 | RPC が `error` を返す → `{ ok: false, table: 'recipe_author_display_names', error }` → route が `internalError` で 500 | 失敗 |

---

## 5. 構造裁定 (相 3・1 回だけ)

### 5.1 代替案の比較

| 案 | 中身 | 最小の情報か | cross/02 §3.3 との整合 | 未ログインに出せるか | 変更の大きさ | 判定 |
|---|---|---|---|---|---|---|
| A (採用) | SECURITY DEFINER の関数 `recipe_author_display_names(uuid[])` が、公開の作者の表示名だけを返す。route は RLS のクライアントで `rpc` を呼ぶ | 名前 1 列・公開の作者だけ・本人の選択と凍結・年齢の条件を関数が持つ | 整合する (service_role を使わない。関数の権限は定型で絞る。anon の許可一覧に 1 本足す) | 出せる (anon に EXECUTE) | migration 1 本 + lib 1 つ + route の呼び出しの 1 語 × 5 + 設定の列と画面 | 採用 |
| B | route が `getSupabaseAdmin()` (service_role) で `user_profiles` の `nickname` を `.in('id', authorIds)` で読む | 列は絞れるが、「公開の作者だけ」の条件をコードで書く必要があり、未ログインの route には認可が無い | 違反 (§3.3「API Routes 内での service_role を禁止」。CLAUDE.md:83 は認可のあとだけ) | 出せる | 小さい | 不採用 |
| C | `user_profiles` に SELECT のポリシーを足す (公開の作者の行を誰でも読める) | 行の全列 (健康・家族の構成・生年月日など 130 列) が読めてしまう。PostgREST は列の権限をポリシーごとに絞れない。列の権限を anon / authenticated から外すと本人の読み込みも壊れる | RLS の変更そのもの | 出せる | ポリシー 1 本だが露出が大きい | 不採用 |
| C' | 所有者 postgres の VIEW (`security_invoker` でない) で `id` と表示名だけを出す | 列は絞れる。条件も書ける | VIEW は Supabase の advisor が「SECURITY DEFINER view」として警告する対象。前例は 1 つだけで、権限の契約テストの型 (関数の ACL) に乗らない | 出せる | VIEW 1 つ | 不採用 (A と同じ露出で、既存の検査の型に乗る A を取る) |
| D | `recipes` / `recipe_comments` に作者名の列を持ち、書くときに写す (トリガーで nickname の変更に追随) | 名前だけだが、書く経路 (API・AI の保存・RPC) の全部とトリガーが要る。設定・凍結・年齢の条件を列に写し続けるのは無理がある | 整合する | 出せる | 大きい (書く経路の全列挙) | 不採用 |
| E | 何も足さず、ログイン中だけ今のまま (他人は「匿名」) | — | — | — | 0 | 発注に反する |

### 5.2 F の問い (縁の発生源を消すより単純な構造は無いか)

- 縁は「どの人の名前を出すか」(本人・公開の作者・凍結・年齢・設定) の 5 つの条件で、どれも発注と決めること 1・5 から来る。条件を減らす = 名前を広く出すことになり、最小の情報の要件 (R-6) に反する。
- 条件をコード (TS) に持つ案 (B) は service_role が要る。条件を関数 1 本に持ち、route は関数を呼ぶだけ、が最も単純。
- 「本人には自分の名前をいつも返す」(a) は、fix 枝の今の挙動 (RLS で自分の行は読める) をそのまま残すための条件で、これを外すと本人の非公開のレシピの `authorName` が「匿名」に変わる (既存の結合テストが赤になる挙動の変更)。残す。

### 5.3 確定

構造 A で確定する。以後の仕上げ (§6〜§17) はこの構造の機械的な展開で、構造の疑義が出たら本節への差し戻し事由として扱う (blocking にしない)。

---

## 6. 決めたこと (0.1 の 1〜6 への答え)

### 6.1 出す名前と、各状態の扱い (決めること 1)

| 状態 | `authorName` (他の人から) | `authorName` (本人から) | 根拠・理由 |
|---|---|---|---|
| 名前あり・設定は既定・凍結なし・18 歳以上・公開の作者 | 表示名 | 表示名 | 発注 |
| (1) 名前が無い (空・空白だけ・仮置きの `'Guest'`) | 「匿名」 | 「匿名」 | 既存の規則 (F-6・F-7)。SQL も `normalize_profile_name` で同じ判定 |
| (2) 退会した | 「匿名」 (`user_id` が NULL。コメントは消える) | — | 第12条 (F-27)・外部キー (F-17・F-18) |
| (3) 凍結中 (`isAccountFrozen` が真) | 「匿名」 | N/A (レシピの API に届かない: middleware が凍結中の本人の `/api/*` を 403 `AUTH_ACCOUNT_FROZEN` で止め、`FROZEN_ALLOWED_API_PATHS` にレシピの route は無い。F-19a。関数を PostgREST から直接呼べば (a) で自分の名前だけが返る) | 凍結は運営の処分で、本人は設定を変えられない。名前を公開の場に出し続けない。一時凍結の期限が過ぎた人はログインの判定と同じく凍結中でない |
| (4) 18 歳未満の本人のアカウント (`birth_date` で 18 歳未満)・生年月日の無い人 | 「匿名」 | 表示名 | 18 歳未満の本人の名前を未ログインの人を含む公開の場に出すことは、保護者の同意書 (cross/14) にもプライバシーポリシー第15条にも無い。生年月日の無い人は同意ゲート (`/legal-consent`) を通っていない人で、年齢を確かめられないので出さない (fail closed)。18 歳になった日 (JST) から出す |
| (5) 本人が自分のレシピ・コメントを見る | — | 表示名 (非公開・設定オフでも) | fix 枝の今の挙動を残す (R-10) |
| (6) 名前を出さない設定 (`show_recipe_author_name = false`) | 「匿名」 | 表示名 | 決めること 5 (§6.5)。画面の注記で「他の人には「匿名」と表示されます」と説明する |
| (7) 公開レシピもコメントも無い人 | 行を返さない (= 「匿名」) | 表示名 | 最小の情報 (R-6)。`userId` は一覧の返り値に含まれるので、関数を uuid → 名前の引き直しに使えないようにする |
| (8) `user_id` が NULL のシステムのレシピ | 「匿名」 | — | fix 枝と同じ (関数に渡さない) |

出す名前の列は `user_profiles.nickname` (表示名の専用の列は無い。F-14・§3.4)。新しい列は作らない (ニックネームと別の「表示名」を持つと、どちらをどこに出すかの決まりが増える)。

### 6.2 読み方 (決めること 2)

§5 のとおり SECURITY DEFINER の関数 1 本 (`public.recipe_author_display_names(p_user_ids uuid[])`)。

- `SET search_path = ''`・参照は完全修飾・`STABLE` (読むだけ・`auth.uid()` と `now()` を使う)。
- 権限: `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role;` のあと `GRANT EXECUTE … TO anon, authenticated;`。service_role には付けない (service_role は表を直接読める。呼ぶ所が無い)。
- anon の許可一覧 (`tests/integration/security/anon-definer-execute.test.ts` の `ANON_EXECUTABLE_DEFINER_ALLOWLIST`) に理由つきで足す (§7.8)。
- `normalize_profile_name` と `age_years_jst` は本文から呼ぶ (所有者 postgres の権限。F-7・F-20)。
- 関数の中で読む列は判定に要る 6 列だけ。返すのは `(author_id uuid, display_name text)`。
- 入力の配列の大きさに上限は置かない (route が渡すのは DB から読んだ行の `user_id` で、一覧は 100 行まで。詳細はコメントの数に従う。関数の仕事は id ごとに主キー 1 回 + 索引つきの EXISTS 2 回で線形。直接 `/rest/v1/rpc` から大きな配列を渡す費用は、今も PostgREST の `in.(…)` が受け付ける費用と同じ)。
- 索引: `recipes` は `idx_recipes_user_id` が既にある (F-22)。`recipe_comments (user_id)` に `idx_recipe_comments_user_id` を足す (コメントの EXISTS が表の走査にならないように)。

### 6.3 未ログインの人にも出すか (決めること 3)

出す。理由: 公開レシピは未ログインでも読める (F-16。一覧 `GET /api/recipes` と詳細は anon に 200 を返す) し、利用規約第13条 2 項が「公開の状態にしたユーザーコンテンツは、ログインしていない方を含め、誰でも閲覧できる」と書いている (F-25)。作者名は公開レシピの一部として同じ範囲に出す。ログイン中だけ出すと、同じ公開レシピの `authorName` が見る人のログインの有無で変わり、画面が作られたときに説明できない。

`GET /api/recipes/[id]/comments` の未認証の 401 は変えない。詳細の未ログインのコメントは RLS (authenticated だけ) で 0 件のまま。

### 6.4 プライバシーポリシーの文面 (決めること 4)

判定: **足りない**。第3条はニックネームを取得すると書き、第4条は「記録の保存と表示」を目的に挙げるが、ニックネームが誰に見えるかを書いた条 (第6条 AI・第9条 家族と組織) のどれにも「公開レシピの作者として他の利用者 (未ログインを含む) に出る」は無い (F-26)。読む人は「ニックネームが見えるのは家族・組織・AI だけ」と読める。他人に見える範囲が広がるのは内容が変わる改定なので、cross/20 §9.3 の規律で版を上げる (再同意が起きる)。

文面の逐語 (第9条に 5 文を足し、見出しを改める) は §7.12。版の置き方は 3 択で、オーナーに聞く (§21 Q-1):

| 選択肢 | 中身 | 利点 | 代償 |
|---|---|---|---|
| (a) 推奨 | v2026.4 (PR #1997。施行日 2026-11-01 の仮置き・予告のあとマージ) に入れる | 再同意が 1 回で済む。予告の工程が 1 回 | PR #1997 の文面と主張の表に本書の 5 文を足す (`LEGAL_CLAIM_COUNT` を +5)。Issue #1139 の予告の文を「Apple の記載と、公開レシピの作者名の表示」に改めてから投稿する。段 B (API) の本番の公開は v2026.4 の施行日 (2026-11-01) 以後にそろえる |
| (b) | 別の版 (v2026.5) にする | PR #1997 と Issue #1139 の予告を触らない | 予告 → 施行の工程がもう 1 回。再同意が 2 回続く。段 B の公開は v2026.5 の施行日まで待つ |
| (c) | 版を上げずに文だけ足す (内容が変わらない直しと整理する) | すぐ公開できる | §9.3 の規律に反する (他人に見える範囲が広がる改定を「内容が変わらない」とは言えない)。本書は勧めない |

本書の既定 (オーナーの回答が無い間): (a) として段 C を書く。段 A (migration) は版と独立に先に適用できる。段 B のマージの時期はオーナーの回答に従う (§15)。

### 6.5 本人が名前を出さない選択 (決めること 5)

持つ。理由: ニックネームに実名を入れている人がいる (第6条が「実名を使わないことをお勧めします」と書くほどには起きる)。公開レシピの `is_public` を切る以外に名前だけを伏せる手段が無いと、名前を伏せたい人はレシピの公開そのものをやめるしかない。

- 置き場: `user_profiles.show_recipe_author_name boolean NOT NULL DEFAULT true` (列 1 つ)。レシピごとの列にしない (レシピを作る・編集する画面が無く、設定を置く所が無い。F-13)。
- 既定は「出す」(本書の冒頭の前提のとおり)。
- 画面: プロフィールの編集 (`/profile`) の基本情報タブ、ニックネームの欄のすぐ下にチェック 1 つ (§7.7)。保存は既存の `PUT /api/profile` (F-11)。本人が RLS の UPDATE で書ける列 (特権列ガードの名指しに入れない。F-21)。
- 文言 (定数。§7.4): ラベル「公開したレシピとコメントに、ニックネームを作者名として表示する」、注記「オフにすると、他の人には「匿名」と表示されます。あなた自身の画面には、自分の名前が表示されます。」。

### 6.6 段分け (決めること 6)

§15。段 A (DB) → 段 B (API・設定) → 段 C (文面。オーナーの選択のあと)。段 A の本番の適用は段 B のマージより前 (R-16)。

---

## 7. 正典コード

### 7.1 `supabase/migrations/<番号はマージ時に確定>_recipe_author_display_names.sql`

番号はマージの直前に origin/main の `supabase/migrations` の最大より大きい番号で確定する (ファイル名・1 行目の見出し・「戻し方」の参照・戻し口のファイル名と見出しの 4 か所を同時に)。

```sql
-- migration: <番号はマージ時に確定>_recipe_author_display_names.sql
-- 戻し方: supabase/rollbacks/<同じ番号>_recipe_author_display_names.down.sql
-- #1917 の続き (docs/design/cross/21-recipe-author-display-name.md): 公開レシピの一覧・詳細・コメントの作者名を、本人以外にも表示名で出す。
--
-- 背景:
--   user_profiles の SELECT の RLS は "Users can view own profile" (本人の行だけ)。レシピの API (src/lib/recipes/viewer-lookups.ts) は
--   RLS の効くクライアントで作者の user_profiles.nickname を引くので、他人の作者名はいつも既定の呼称 '匿名' になっていた。
--   Next.js の API では service_role を使わない (docs/design/cross/02-rls-patterns.md §3.3)。RLS のポリシーを足すと行の全列が読めてしまう。
--
-- 変更:
--   1. 列 user_profiles.show_recipe_author_name boolean NOT NULL DEFAULT true: 本人が「公開したレシピとコメントに作者名を出す」を選ぶ。
--      特権列ではない (本人が PUT /api/profile で書く)。既存の 65 行には既定値 true が入る。
--   2. 索引 idx_recipe_comments_user_id (recipe_comments.user_id): 下の関数のコメントの EXISTS 用。recipes.user_id は idx_recipes_user_id が既にある。
--   3. 関数 public.recipe_author_display_names(p_user_ids uuid[]) RETURNS TABLE (author_id uuid, display_name text):
--      渡された id のうち、(a) 呼び出した本人 (auth.uid()) か、(b) 公開の作者 (is_public かつ hidden_at IS NULL のレシピの user_id、
--      またはそのレシピへのコメントの user_id) で、名前を出す設定・凍結中でない・生年月日があり 18 歳以上 の人だけ、
--      (id, normalize_profile_name(nickname)) を返す。名前が無い人 (NULL) は返さない。返らなかった人は route が '匿名' にする。
--      読むのは user_profiles の判定に要る列だけで、返すのは id と表示名だけ。RLS のポリシーは足さない・変えない。
--      凍結中の判定は src/lib/auth/frozen.ts の isAccountFrozen と同じ (frozen_at があり、unban_at が無いか今より未来)。
--      年齢は public.age_years_jst (JST の暦日。20261017030000) で、境は @homegohan/shared の ADULT_AGE_YEARS と同じ 18。
--
-- 権限の定型 (#1039/#1020): 新しい関数には既定で anon / authenticated / service_role と PUBLIC に EXECUTE が付くので、
--   引数の型まで含めた完全形で REVOKE し、anon と authenticated にだけ GRANT する (未ログインの一覧・詳細も名前を出す。
--   service_role には付けない: 表を直接読めるので呼ぶ所が無い)。anon の許可一覧 (tests/integration/security/anon-definer-execute.test.ts) に載せる。
--   関数は SET search_path = ''、参照は完全修飾。normalize_profile_name と age_years_jst は所有者 postgres の権限で本文から呼ぶ。
-- 既存データへの影響: 列の既定値が入るだけ。既存の行の値は書き換えない。
-- ロック: ADD COLUMN は user_profiles に ACCESS EXCLUSIVE ロックを短く取る (既定値は PG 11 以降の fast default で行を書き換えない)。
--   lock_timeout を 10 秒にし、待ちが長ければ失敗させる (再実行で直る)。
-- 冪等: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION / REVOKE / GRANT。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/recipe-author-display-names.test.ts (実 DB)
--       tests/recipe-author-display-names-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. 本人の選択: 公開したレシピとコメントに作者名を出す
-- ----------------------------------------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS show_recipe_author_name boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.show_recipe_author_name IS
  'cross/21: 公開したレシピとコメントに、ニックネームを作者名として他の人に表示するか (既定 true)。false なら他の人には ''匿名''。本人には自分の名前が出る。本人が PUT /api/profile で書く (特権列ではない)。読むのは recipe_author_display_names だけ';

-- ----------------------------------------------------------------
-- 2. コメントの作者の EXISTS 用の索引
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_recipe_comments_user_id
  ON public.recipe_comments (user_id);

-- ----------------------------------------------------------------
-- 3. 公開の作者の表示名
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recipe_author_display_names(p_user_ids uuid[])
RETURNS TABLE (author_id uuid, display_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- 名前を出す作者の年齢の下限 (歳)。@homegohan/shared の ADULT_AGE_YEARS (packages/shared/src/parental-consent.ts) と同じ値。
  -- 18 歳未満の本人のアカウント (保護者の同意の経路) の名前は公開の場に出さない (cross/21 §6.1 (4))
  c_adult_age_years CONSTANT pg_catalog.int4 := 18;
  -- 呼び出した本人。未ログイン (anon) は NULL
  v_viewer pg_catalog.uuid := auth.uid();
BEGIN
  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT t.u AS id
      FROM pg_catalog.unnest(COALESCE(p_user_ids, '{}'::pg_catalog.uuid[])) AS t(u)
     WHERE t.u IS NOT NULL
  )
  SELECT p.id, public.normalize_profile_name(p.nickname)
    FROM ids
    JOIN public.user_profiles AS p ON p.id = ids.id
   WHERE public.normalize_profile_name(p.nickname) IS NOT NULL
     AND (
       -- (a) 本人には自分の名前をいつも返す (非公開のレシピ・名前を出さない設定でも)
       p.id = v_viewer
       OR (
         -- (b) 公開の作者で、出す設定・凍結中でない・18 歳以上
         p.show_recipe_author_name
         AND (p.frozen_at IS NULL OR (p.unban_at IS NOT NULL AND p.unban_at <= pg_catalog.now()))
         AND p.birth_date IS NOT NULL
         AND public.age_years_jst(p.birth_date) >= c_adult_age_years
         AND (
           EXISTS (
             SELECT 1 FROM public.recipes AS r
              WHERE r.user_id = p.id AND r.is_public = true AND r.hidden_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM public.recipe_comments AS c
               JOIN public.recipes AS r ON r.id = c.recipe_id
              WHERE c.user_id = p.id AND r.is_public = true AND r.hidden_at IS NULL
           )
         )
       )
     );
END
$function$;

REVOKE ALL ON FUNCTION public.recipe_author_display_names(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recipe_author_display_names(uuid[]) TO anon, authenticated;

COMMENT ON FUNCTION public.recipe_author_display_names(uuid[]) IS
  'cross/21: 公開レシピの作者・コメントの書き手の表示名。渡した id のうち、本人か、公開の作者 (出す設定・凍結中でない・18 歳以上) だけを (author_id, display_name) で返す。名前の無い人は返さない。レシピの API (src/lib/recipes/viewer-lookups.ts) が RLS のクライアントで呼ぶ。anon / authenticated';
```

### 7.2 `supabase/rollbacks/<同じ番号>_recipe_author_display_names.down.sql`

```sql
-- rollback: <同じ番号>_recipe_author_display_names.down.sql
-- cross/21 の戻し口。関数 → 索引 → 列 の順に消す。
-- 注意: 先にコードを戻す (viewer-lookups.ts が rpc を呼んだまま関数を消すと、レシピの API が PGRST202 の 500 になる)。
-- 列を消すと、本人の「名前を出さない」の選択は失われる (戻したあとに再適用しても既定の true に戻る)。
-- anon / authenticated への GRANT は何も付け直さない (TRUNCATE / ALL を含む。20261022190000 より後の戻し口の規律)。

DROP FUNCTION IF EXISTS public.recipe_author_display_names(uuid[]);
DROP INDEX IF EXISTS public.idx_recipe_comments_user_id;
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS show_recipe_author_name;
```

### 7.3 `src/lib/recipes/viewer-lookups.ts` (fix 枝のファイルの差し替え後の全文)

変わる所: 名前は `rpc` で引く (未ログインでも)。返り値の `nicknames` を `authorNames: ReadonlyMap<string, string>` に改める。失敗の `table` に `'recipe_author_display_names'`。いいねは fix 枝のまま。

```ts
// src/lib/recipes/viewer-lookups.ts
// レシピの API (GET /api/recipes・GET /api/recipes/[id]・GET / POST /api/recipes/[id]/comments) が、作者の表示名と、
// 見ている人のいいね (recipe_likes) を、レシピ・コメントとは別のクエリで引く (#1917。docs/design/cross/21-recipe-author-display-name.md)。
//
// select の埋め込み (`user_profiles(nickname)`・`recipe_likes(user_id)`) を使わない理由 (supabase/baseline/prod_schema.sql):
//   - recipes.user_id・recipe_comments.user_id の外部キーは auth.users 宛で、public のどのテーブルも user_profiles への外部キーを
//     持たない。PostgREST は関係を外部キーで見つけるので、`user_profiles(...)` の埋め込みは解決できず PGRST200 の失敗になる
//   - recipe_likes は recipes への外部キーを 2 本 (recipe_id・recipe_uuid) 持つので、`recipe_likes(...)` の埋め込みは
//     どちらの関係か決まらず PGRST201 の失敗になる
// 解決できない埋め込みは tests/postgrest-embed-relationship-scan.test.ts が src の全域で見張る。
//
// 作者の表示名は、RLS の効くクライアントで SECURITY DEFINER の関数 recipe_author_display_names を呼んで引く
// (user_profiles の SELECT の RLS は本人の行だけなので、表を直接読むと他人の名前はいつも既定の呼称になる)。
// 関数は、本人と、公開の作者 (名前を出す設定・凍結中でない・18 歳以上) の表示名だけを返す。返らなかった作者は
// recipeAuthorName の既定の呼称になる。未ログインでも呼ぶ (公開レシピは未ログインでも読める。関数は anon も呼べる)。
// いいねは、ログイン中だけ自分の recipe_likes を引く (未ログインにはいいねが無い)。
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

/** レシピの API が使う、RLS の効く Supabase クライアント (from と rpc だけを使う) */
export type RecipeViewerDb = Pick<SupabaseClient, 'from' | 'rpc'>;

/** 作者の表示名を返す関数の名前 (supabase/migrations/*_recipe_author_display_names.sql) */
export const RECIPE_AUTHOR_DISPLAY_NAMES_RPC = 'recipe_author_display_names';

/** 引いたものを、作者の表示名といいねに分けて持つ */
export interface RecipeViewerLookups {
  /** 作者の id → 表示名 (関数が返した作者だけ。返らなかった作者は入らない = 既定の呼称になる) */
  authorNames: ReadonlyMap<string, string>;
  /** 見ている人がいいねしたレシピの id */
  likedRecipeIds: ReadonlySet<string>;
}

/** 失敗したら、どの読み込みが失敗したかと DB のエラーを返す (route が 500 にする) */
export type RecipeViewerLookupResult =
  | ({ ok: true } & RecipeViewerLookups)
  | { ok: false; table: typeof RECIPE_AUTHOR_DISPLAY_NAMES_RPC | 'recipe_likes'; error: PostgrestError };

/** recipe_author_display_names の 1 行 (RETURNS TABLE (author_id uuid, display_name text)) */
interface AuthorNameRow {
  author_id: string;
  display_name: string;
}

interface LikeRow {
  recipe_id: string;
}

/** 無い値 (作者のいないシステムのレシピの user_id は NULL) と重複を除く */
function distinctIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

/**
 * 見ている人 (viewerId。未ログインは null) から見た、作者の表示名と、自分のいいね。
 * authorIds が空なら関数を呼ばない。recipeIds が空か未ログインなら、いいねを引かない。
 * いいねは recipe_likes.recipe_id で照らす (いいねの API (src/app/api/recipes/[id]/like/route.ts) と
 * AI 相談の like_recipe が書く列。recipe_uuid はどちらも書かない)。
 */
export async function loadRecipeViewerLookups(
  supabase: RecipeViewerDb,
  viewerId: string | null,
  targets: { authorIds: ReadonlyArray<string | null | undefined>; recipeIds: ReadonlyArray<string | null | undefined> },
): Promise<RecipeViewerLookupResult> {
  const authorIds = distinctIds(targets.authorIds);
  const recipeIds = viewerId === null ? [] : distinctIds(targets.recipeIds);

  const [names, likes] = await Promise.all([
    authorIds.length > 0
      ? supabase.rpc(RECIPE_AUTHOR_DISPLAY_NAMES_RPC, { p_user_ids: authorIds })
      : Promise.resolve({ data: [] as AuthorNameRow[], error: null }),
    viewerId !== null && recipeIds.length > 0
      ? supabase.from('recipe_likes').select('recipe_id').eq('user_id', viewerId).in('recipe_id', recipeIds)
      : Promise.resolve({ data: [] as LikeRow[], error: null }),
  ]);

  if (names.error) return { ok: false, table: RECIPE_AUTHOR_DISPLAY_NAMES_RPC, error: names.error };
  if (likes.error) return { ok: false, table: 'recipe_likes', error: likes.error };

  const nameRows: AuthorNameRow[] = names.data ?? [];
  const likeRows: LikeRow[] = likes.data ?? [];
  return {
    ok: true,
    authorNames: new Map(nameRows.map((row) => [row.author_id, row.display_name])),
    likedRecipeIds: new Set(likeRows.map((row) => row.recipe_id)),
  };
}
```

### 7.4 `src/lib/recipes/author-name.ts` (差し替え後の全文。設定の文言の定数を足す)

```ts
// src/lib/recipes/author-name.ts
// レシピ・レシピのコメントの API (GET/POST /api/recipes・/api/recipes/[id]・/api/recipes/[id]/comments) が返す authorName (#1649)。
//
// 作者の表示名は、user_profiles.nickname を normalizeProfileName で整えたもの (空・空白だけ・仮置きの 'Guest' は「名前が無い」)。
// 他人の名前は SECURITY DEFINER の関数 recipe_author_display_names (src/lib/recipes/viewer-lookups.ts) が、公開の作者で
// 名前を出す設定の人についてだけ返す (docs/design/cross/21-recipe-author-display-name.md)。返らなかった作者・名前が無い作者は
// 既定の呼称 '匿名' にする。
import { normalizeProfileName } from '@/lib/profile-name';

/** 作者の名前が無いときに返す呼称 (Web のレシピの画面がそのまま出す) */
export const RECIPE_AUTHOR_FALLBACK_NAME = '匿名';

/** プロフィールの編集画面の「名前を出す」の切り替え (user_profiles.show_recipe_author_name) のラベル */
export const RECIPE_AUTHOR_NAME_SETTING_LABEL = '公開したレシピとコメントに、ニックネームを作者名として表示する';

/** 同じ切り替えの注記 (オフにしたときの見え方) */
export const RECIPE_AUTHOR_NAME_SETTING_NOTE = `オフにすると、他の人には「${RECIPE_AUTHOR_FALLBACK_NAME}」と表示されます。あなた自身の画面には、自分の名前が表示されます。`;

/** 関数が返した表示名 (または user_profiles.nickname) から、API が返す作者名を作る */
export function recipeAuthorName(nickname: unknown): string {
  return normalizeProfileName(nickname) ?? RECIPE_AUTHOR_FALLBACK_NAME;
}
```

### 7.5 route 3 本の差分 (fix 枝のファイルに対する 1 語の置き換え。ほかは変えない)

```ts
// tsc:skip
// src/app/api/recipes/route.ts (一覧): 1 か所
//   authorName: recipeAuthorName(lookups.nicknames.get(item.user_id)),
// → authorName: recipeAuthorName(lookups.authorNames.get(item.user_id)),
//
// src/app/api/recipes/[id]/route.ts (詳細): 2 か所 (レシピとコメント)
//   authorName: recipeAuthorName(lookups.nicknames.get(data.user_id)),
// → authorName: recipeAuthorName(lookups.authorNames.get(data.user_id)),
//   authorName: recipeAuthorName(lookups.nicknames.get(c.user_id)),
// → authorName: recipeAuthorName(lookups.authorNames.get(c.user_id)),
//
// src/app/api/recipes/[id]/comments/route.ts (GET と POST): 2 か所
//   authorName: recipeAuthorName(lookups.nicknames.get(c.user_id)),
// → authorName: recipeAuthorName(lookups.authorNames.get(c.user_id)),
//   authorName: recipeAuthorName(lookups.nicknames.get(user.id)),
// → authorName: recipeAuthorName(lookups.authorNames.get(user.id)),
//
// route のコメントのうち「名前が引けるのは本人の行だけ」「未ログインのときは名前を問い合わせない」の趣旨の文は、
// 「作者の表示名は recipe_author_display_names で引く (未ログインでも)」に現在形化する。詳細の閲覧数の加算・404 の判定・
// コメント POST の「保存の前に引く」の順番は変えない。
```

### 7.6 設定の列を型と変換に通す (3 ファイル。断片)

```ts
// tsc:skip
// types/domain.ts: interface UserProfile の「=== NEW: Meta ===」の aiLearningEnabled (行 298) の次に 1 行
  /** 公開したレシピとコメントに、ニックネームを作者名として他の人に表示する (user_profiles.show_recipe_author_name。既定 true。cross/21) */
  showRecipeAuthorName: boolean;

// types/database.ts: interface DbUserProfile の ai_learning_enabled (行 132) の次に 1 行
  show_recipe_author_name: boolean | null;

// lib/converter.ts: toUserProfile の aiLearningEnabled (行 144) の次に 1 行 (列がまだ無い行は既定の true)
  showRecipeAuthorName: db.show_recipe_author_name ?? true,

// lib/converter.ts: fromUserProfile の aiLearningEnabled (行 278) の次に 1 行
  if (profile.showRecipeAuthorName !== undefined) result.show_recipe_author_name = profile.showRecipeAuthorName;
```

- `PUT /api/profile` は `fromUserProfile(body)` をそのまま `update` するので、route の変更は無い (F-11)。`POST /api/profile` (作成) も変えない (列の既定値 true)。
- `packages/shared/src/database.types.ts` と `src/types/database.types.ts` は生成し直す (関数 `recipe_author_display_names` が `Functions` に、列が `user_profiles` の `Row` / `Insert` / `Update` に入る。`tests/database-types-migrations-contract.test.ts` の作り直し方のとおり)。

### 7.7 プロフィールの編集画面 (`src/app/(main)/profile/page.tsx`。断片)

```tsx
// tsc:skip
// import に足す
import { RECIPE_AUTHOR_NAME_SETTING_LABEL, RECIPE_AUTHOR_NAME_SETTING_NOTE } from '@/lib/recipes/author-name';

// 基本情報タブの、ニックネームの欄 (<Label>ニックネーム</Label> … </div>。行 725-733) の直後に置く
<div className="space-y-1">
  <div className="flex items-start gap-2">
    <input
      id="profile-show-recipe-author-name"
      type="checkbox"
      className="mt-1"
      checked={editForm.showRecipeAuthorName ?? true}
      onChange={(e) => updateField('showRecipeAuthorName', e.target.checked)}
    />
    <Label htmlFor="profile-show-recipe-author-name" className="font-normal">
      {RECIPE_AUTHOR_NAME_SETTING_LABEL}
    </Label>
  </div>
  <p className="text-xs text-gray-500 pl-6">{RECIPE_AUTHOR_NAME_SETTING_NOTE}</p>
</div>
```

- 保存は既存の「保存」ボタン (`fetch('/api/profile', { method: 'PUT', … })`) に乗る。`editForm` は `toUserProfile` の結果なので、列が無い環境でも `true` が入る。
- `tests/no-pending-wording-1911.test.ts`・`tests/public-claims-guard.test.ts` の禁止語 (準備中・予定です など) を文言に入れない。

### 7.8 anon の許可一覧 (`tests/integration/security/anon-definer-execute.test.ts` の `ANON_EXECUTABLE_DEFINER_ALLOWLIST`。断片)

```ts
// tsc:skip
const ANON_EXECUTABLE_DEFINER_ALLOWLIST: Record<string, string> = {
  'get_invite_details(text)':
    '招待ページ /invite/[token] が、ログイン前に招待の中身 (組織名・メール・期限) を出すために呼ぶ (src/app/invite/[token]/page.tsx)',
  'get_promotion_details(text)':
    '参加リクエストの承認ページ /family/promotions/[token] が、ログイン前に内容を出すために呼ぶ (src/app/family/promotions/[token]/page.tsx)',
  'recipe_author_display_names(uuid[])':
    '公開レシピの一覧・詳細 (GET /api/recipes・GET /api/recipes/[id]) が、未ログインでも作者の表示名を出すために呼ぶ (src/lib/recipes/viewer-lookups.ts。cross/21)',
};
```

同じファイルの describe の名前「許可リストの 2 本だけ」と A1b の it の名前「許可リストの 2 本は」は「3 本」に改める。

### 7.9 `tests/recipe-author-display-names-migration-contract.test.ts` (新。DB を使わない静的な検査)

```ts
// @vitest-environment node
/**
 * cross/21 (#1917 の続き): migration *_recipe_author_display_names.sql (と、その戻し口) と、それを呼ぶ TS・許可一覧・型の突き合わせ (DB は使わない)
 *
 * 本物の DB での振る舞い (他人の表示名が返る・返らない人・anon が呼べる・user_profiles の RLS が変わっていない) は
 * tests/integration/security/recipe-author-display-names.test.ts が確かめる。ここでは、ファイルの文面だけで崩れやすい所を確かめる。
 *   C-1 migration はちょうど 1 本。1 行目の見出しと「戻し方」の参照がファイル名と一致し、戻し口が実在して見出しも一致する
 *   C-2 列 show_recipe_author_name は boolean NOT NULL DEFAULT true。特権列ガードの関数を作り直していない
 *   C-3 関数は SECURITY DEFINER・STABLE・search_path が空・RETURNS TABLE (author_id uuid, display_name text)
 *   C-4 年齢の境の定数が @homegohan/shared の ADULT_AGE_YEARS と同じ。age_years_jst と normalize_profile_name を呼び、どちらも作り直していない
 *   C-5 凍結中の判定が isAccountFrozen と同じ形 (frozen_at IS NULL OR (unban_at IS NOT NULL AND unban_at <= now()))
 *   C-6 権限: 完全形で PUBLIC / anon / authenticated / service_role から REVOKE し、anon と authenticated にだけ GRANT EXECUTE。TRUNCATE / ALL を付けない
 *   C-7 戻し口は関数 → 索引 → 列 の順に消し、GRANT を書かない
 *   C-8 viewer-lookups.ts の RECIPE_AUTHOR_DISPLAY_NAMES_RPC が関数の名前と同じで、user_profiles を直接 select していない
 *   C-9 anon の許可一覧に関数の完全形がある。2 つの database.types.ts に関数と列が入っている
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADULT_AGE_YEARS } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_recipe_author_display_names';
const FUNCTION_NAME = 'recipe_author_display_names';
const FUNCTION_SIGNATURE = `public.${FUNCTION_NAME}(uuid[])`;
const COLUMN_NAME = 'show_recipe_author_name';
const INDEX_NAME = 'idx_recipe_comments_user_id';
const VIEWER_LOOKUPS = 'src/lib/recipes/viewer-lookups.ts';
const ALLOWLIST_TEST = 'tests/integration/security/anon-definer-execute.test.ts';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
/** 特権列ガード・年齢・名前の関数は、この migration が作り直してはいけない (ほかの契約テストの前提) */
const MUST_NOT_REDEFINE = [
  'guard_user_profiles_privileged',
  'guard_user_profiles_privileged_on_insert',
  'age_years_jst',
  'normalize_profile_name',
] as const;

const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

function migrationFile(): string {
  const files = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(`${STEM_SUFFIX}.sql`));
  expect(files, 'migration はちょうど 1 本').toHaveLength(1);
  return files[0];
}

/** SQL のコメント (-- から行末) を除き、空白を 1 つに詰める */
function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('cross/21 recipe_author_display_names の migration (静的)', () => {
  const file = migrationFile();
  const stem = file.replace(/\.sql$/, '');
  const sql = read(`${MIGRATIONS_DIR}/${file}`);
  const flat = normalizeSql(sql);
  const rollbackFile = `${stem}.down.sql`;

  it('C-1: 見出し・戻し方の参照・戻し口のファイル名と見出しがそろう', () => {
    expect(sql.split('\n')[0]).toBe(`-- migration: ${file}`);
    expect(sql).toContain(`${ROLLBACKS_DIR}/${rollbackFile}`);
    const rollbackPath = path.join(ROOT, ROLLBACKS_DIR, rollbackFile);
    expect(fs.existsSync(rollbackPath), `${rollbackFile} が実在する`).toBe(true);
    expect(read(`${ROLLBACKS_DIR}/${rollbackFile}`).split('\n')[0]).toBe(`-- rollback: ${rollbackFile}`);
  });

  it('C-2: 列は boolean NOT NULL DEFAULT true。特権列ガードを作り直さない', () => {
    expect(flat).toContain(
      `ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS ${COLUMN_NAME} boolean NOT NULL DEFAULT true;`,
    );
    for (const fn of MUST_NOT_REDEFINE) {
      expect(flat, `${fn} を作り直さない`).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
    }
  });

  it('C-3: 関数は SECURITY DEFINER・STABLE・search_path が空・(author_id uuid, display_name text) を返す', () => {
    expect(flat).toContain(`CREATE OR REPLACE FUNCTION ${FUNCTION_SIGNATURE.replace('(uuid[])', '(p_user_ids uuid[])')}`);
    expect(flat).toContain('RETURNS TABLE (author_id uuid, display_name text)');
    const head = flat.slice(flat.indexOf(`CREATE OR REPLACE FUNCTION public.${FUNCTION_NAME}`), flat.indexOf('AS $function$'));
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toContain('STABLE');
    expect(head).toMatch(/SET search_path = ''/);
  });

  it('C-4: 年齢の境は ADULT_AGE_YEARS と同じ。age_years_jst と normalize_profile_name を呼ぶ', () => {
    expect(flat).toContain(`c_adult_age_years CONSTANT pg_catalog.int4 := ${ADULT_AGE_YEARS};`);
    expect(flat).toContain('public.age_years_jst(p.birth_date) >= c_adult_age_years');
    expect(flat).toContain('public.normalize_profile_name(p.nickname) IS NOT NULL');
    expect(flat).toContain('p.birth_date IS NOT NULL');
  });

  it('C-5: 凍結中の判定は isAccountFrozen と同じ形', () => {
    expect(flat).toContain('(p.frozen_at IS NULL OR (p.unban_at IS NOT NULL AND p.unban_at <= pg_catalog.now()))');
  });

  it('C-6: 権限は完全形で外してから anon と authenticated にだけ付ける。TRUNCATE / ALL を付けない', () => {
    expect(flat).toContain(`REVOKE ALL ON FUNCTION ${FUNCTION_SIGNATURE} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(flat).toContain(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE} TO anon, authenticated;`);
    expect(flat).not.toMatch(/GRANT (ALL|TRUNCATE)/);
    expect(flat).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE.replace(/[().\[\]]/g, '\\$&')} TO [^;]*service_role`));
    expect(flat).toContain(`CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON public.recipe_comments (user_id);`);
  });

  it('C-7: 戻し口は関数 → 索引 → 列 の順に消し、GRANT を書かない', () => {
    const down = normalizeSql(read(`${ROLLBACKS_DIR}/${rollbackFile}`));
    const dropFn = down.indexOf(`DROP FUNCTION IF EXISTS ${FUNCTION_SIGNATURE};`);
    const dropIdx = down.indexOf(`DROP INDEX IF EXISTS public.${INDEX_NAME};`);
    const dropCol = down.indexOf(`ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS ${COLUMN_NAME};`);
    expect(dropFn).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(dropFn);
    expect(dropCol).toBeGreaterThan(dropIdx);
    expect(down).not.toMatch(/\bGRANT\b/);
  });

  it('C-8: viewer-lookups.ts は関数の名前の定数で rpc を呼び、user_profiles を直接 select しない', () => {
    const src = read(VIEWER_LOOKUPS);
    expect(src).toContain(`export const RECIPE_AUTHOR_DISPLAY_NAMES_RPC = '${FUNCTION_NAME}';`);
    expect(src).toContain('supabase.rpc(RECIPE_AUTHOR_DISPLAY_NAMES_RPC, { p_user_ids: authorIds })');
    expect(src).not.toMatch(/from\('user_profiles'\)/);
  });

  it('C-9: anon の許可一覧と 2 つの database.types.ts に関数がある。型に列がある', () => {
    expect(read(ALLOWLIST_TEST)).toContain(`'${FUNCTION_NAME}(uuid[])':`);
    for (const typeFile of TYPE_FILES) {
      const types = read(typeFile);
      expect(types, `${typeFile} に関数`).toMatch(new RegExp(`^\\s+${FUNCTION_NAME}: \\{`, 'm'));
      expect(types, `${typeFile} に列`).toMatch(new RegExp(`^\\s+${COLUMN_NAME}: boolean`, 'm'));
    }
  });
});
```

### 7.10 `tests/integration/security/recipe-author-display-names.test.ts` (新。ローカル Supabase + Next の開発サーバー)

置き場は `tests/integration/security/` (CI の指定 `tests/integration/security` に当たる。`.github/workflows/security-regression.yml:95`。`tests/integration-ci-coverage.test.ts` が確かめる)。helper を相対パスで import するので本書では型検査に掛けない。

```ts
// tsc:skip
// @vitest-environment node
/**
 * cross/21 (#1917 の続き): 公開レシピの作者の表示名が、本人以外 (ログインした利用者・未ログイン) にも出ることの結合テスト
 *
 * 確かめること (関数 recipe_author_display_names を直接と、レシピの API 経由の両方):
 *   I-1  未ログイン (anon) が関数を呼ぶと、公開の作者 (18 歳以上・名前あり・設定は既定) の表示名が返る
 *   I-2  返らない人: 18 歳未満・生年月日なし・凍結中 (無期限 / 一時で未来)・名前を出さない設定・名前なし ('Guest')・公開レシピもコメントも無い人
 *   I-3  一時凍結の期限が過ぎた人は返る (isAccountFrozen と同じ境)
 *   I-4  公開レシピへのコメントだけの人も返る (コメントの作者)
 *   I-5  本人には自分の名前が返る (非公開のレシピだけの人・名前を出さない設定の人・18 歳未満の本人)。他の人には返らない
 *   I-6  重複と NULL と知らない id は無視され、空の配列は 0 行
 *   I-7  GET /api/recipes (未ログイン・ログイン中): 公開レシピの authorName が作者の表示名。18 歳未満の作者は '匿名'
 *   I-8  GET /api/recipes/[id] (未ログイン): authorName が作者の表示名。ログイン中: コメントの authorName (コメントの作者は表示名・設定オフの人は '匿名')
 *   I-9  PUT /api/profile で showRecipeAuthorName を false にすると他の人には '匿名'、true に戻すと表示名。本人の一覧には自分の名前のまま
 *   I-10 公開レシピを非公開に戻す・運営が隠す (hidden_at) と、ほかに公開の内容が無い作者の名前は返らなくなる
 *   I-11 権限: anon と authenticated は EXECUTE でき、PUBLIC と service_role には EXECUTE が無い。user_profiles の SELECT のポリシーは本人の行だけの 1 本のまま
 *   I-12 作者を退会 (auth.admin.deleteUser) させると、公開レシピは user_id が NULL で残り authorName は '匿名'、コメントは消える
 *   I-13 凍結を解除 (frozen_at を NULL) すると、凍結中に返らなかった作者の名前が返る (S-7)
 *   I-14 18 歳の誕生日 (JST) の境: 今日が 18 歳の誕生日の人は返り、明日が 18 歳の誕生日の人は返らない (S-9。DB の時計の JST の今日で生年月日を決める)
 *   I-15 user_id が NULL のシステムの公開レシピは、一覧・詳細 (未ログイン・ログイン中) で authorName が '匿名' (S-15)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next の開発サーバー。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/recipe-author-display-names.test.ts
 * 作った行とユーザーは afterAll で消す。本番には接続しない。
 * 生年月日・凍結の列は特権列なので service_role (supabaseAdmin) で入れる (本番で入れるのは accept_legal_documents と運営の凍結)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADULT_AGE_YEARS, PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared';
import { apiCall } from '../helpers/api';
import { pgQuery, supabaseAdmin, supabaseAnon, supabaseAsUser } from '../helpers/supabase';
import { cleanupTestUser, createTestUserWithRoles, type TestUser } from '../helpers/users';

const TS = Date.now();
const RPC = 'recipe_author_display_names';
/** 既定の呼称 (src/lib/recipes/author-name.ts の RECIPE_AUTHOR_FALLBACK_NAME と同じ値) */
const FALLBACK = '匿名';
/** 18 歳以上と確かめられる生年月日 (ADULT_AGE_YEARS + 12 年前の 1 月 1 日。誕生日の境に掛からない) */
const ADULT_BIRTH_DATE = `${new Date().getFullYear() - ADULT_AGE_YEARS - 12}-01-01`;
/** 18 歳未満の生年月日 (ADULT_AGE_YEARS - 2 年前の 1 月 1 日) */
const MINOR_BIRTH_DATE = `${new Date().getFullYear() - ADULT_AGE_YEARS + 2}-01-01`;
/** 一時凍結の解除予定 (未来・過去) に使う幅 (ミリ秒)。境の 1 日 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** 開発サーバーが最初の要求でルートをコンパイルするのを待つ時間 (ミリ秒) */
const FIRST_COMPILE_TIMEOUT_MS = 180_000;

type Person = { user: TestUser; nickname: string };
type AuthorNameRow = { author_id: string; display_name: string };

const people: Record<
  | 'author' | 'minor' | 'noBirth' | 'frozen' | 'tempFrozen' | 'tempFrozenExpired' | 'optOut' | 'noName' | 'privateOnly' | 'commenter' | 'viewer'
  | 'unfreeze' | 'turns18Today' | 'turns18Tomorrow',
  Person
> = {} as never;
let publicRecipeId: string;
let privateRecipeId: string;
let systemRecipeId: string;

async function makePerson(key: keyof typeof people, profile: Record<string, unknown>): Promise<void> {
  const nickname = `作者${key}${TS}`;
  const user = await createTestUserWithRoles({ email: `sec-author-${key}-${TS}@homegohan.test`, roles: ['user'] });
  const { error } = await supabaseAdmin.from('user_profiles').update({ nickname, ...profile }).eq('id', user.userId);
  if (error) throw new Error(`user_profiles (${key}): ${error.message}`);
  people[key] = { user, nickname };
}

async function namesAs(client: ReturnType<typeof supabaseAnon>, ids: Array<string | null>): Promise<Map<string, string>> {
  const { data, error } = await client.rpc(RPC, { p_user_ids: ids });
  if (error) throw new Error(`${RPC}: ${error.message}`);
  return new Map((data as AuthorNameRow[]).map((r) => [r.author_id, r.display_name]));
}

beforeAll(async () => {
  const now = Date.now();
  await makePerson('author', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('minor', { birth_date: MINOR_BIRTH_DATE });
  await makePerson('noBirth', {});
  await makePerson('frozen', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now).toISOString(), unban_at: null });
  await makePerson('tempFrozen', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now).toISOString(), unban_at: new Date(now + ONE_DAY_MS).toISOString() });
  await makePerson('tempFrozenExpired', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now - 2 * ONE_DAY_MS).toISOString(), unban_at: new Date(now - ONE_DAY_MS).toISOString() });
  await makePerson('optOut', { birth_date: ADULT_BIRTH_DATE, show_recipe_author_name: false });
  await makePerson('noName', { birth_date: ADULT_BIRTH_DATE, nickname: PROFILE_NAME_PLACEHOLDER });
  await makePerson('privateOnly', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('commenter', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('viewer', { birth_date: ADULT_BIRTH_DATE });
  await makePerson('unfreeze', { birth_date: ADULT_BIRTH_DATE, frozen_at: new Date(now).toISOString(), unban_at: null });
  // I-14 の 2 人の生年月日は、JST の 0 時をまたがないよう it の中で入れ直す (ここでは 18 歳未満の値で作る)
  await makePerson('turns18Today', { birth_date: MINOR_BIRTH_DATE });
  await makePerson('turns18Tomorrow', { birth_date: MINOR_BIRTH_DATE });

  // 公開レシピ: author のもの 1 件 + 返らない人たちのもの 1 件ずつ (公開レシピがあっても返らないことを確かめる)
  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: people.author.user.userId, name: `t-cross21-public-${TS}`, is_public: true })
    .select('id')
    .single();
  if (recipeError || !recipe) throw new Error(`recipes: ${recipeError?.message}`);
  publicRecipeId = recipe.id as string;
  for (const key of ['minor', 'noBirth', 'frozen', 'tempFrozen', 'tempFrozenExpired', 'optOut', 'noName', 'unfreeze', 'turns18Today', 'turns18Tomorrow'] as const) {
    const { error } = await supabaseAdmin
      .from('recipes')
      .insert({ user_id: people[key].user.userId, name: `t-cross21-${key}-${TS}`, is_public: true });
    if (error) throw new Error(`recipes (${key}): ${error.message}`);
  }
  const { data: priv, error: privError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: people.privateOnly.user.userId, name: `t-cross21-private-${TS}`, is_public: false })
    .select('id')
    .single();
  if (privError || !priv) throw new Error(`recipes (private): ${privError?.message}`);
  privateRecipeId = priv.id as string;
  // 作者のいないシステムの公開レシピ (user_id NULL。RLS の user_id IS NULL の枝で誰にでも見える)
  const { data: sys, error: sysError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: null, name: `t-cross21-system-${TS}`, is_public: true })
    .select('id')
    .single();
  if (sysError || !sys) throw new Error(`recipes (system): ${sysError?.message}`);
  systemRecipeId = sys.id as string;

  // コメント: commenter (公開レシピへ)・optOut (公開レシピへ)・minor (公開レシピへ)
  for (const key of ['commenter', 'optOut', 'minor'] as const) {
    const { error } = await supabaseAdmin
      .from('recipe_comments')
      .insert({ recipe_id: publicRecipeId, user_id: people[key].user.userId, content: `t-cross21-comment-${key}-${TS}`, rating: 4 });
    if (error) throw new Error(`recipe_comments (${key}): ${error.message}`);
  }

  await apiCall('GET', `/api/recipes?q=t-cross21-public-${TS}`, null);
  await apiCall('GET', `/api/recipes/${publicRecipeId}`, null);
}, FIRST_COMPILE_TIMEOUT_MS);

afterAll(async () => {
  await supabaseAdmin.from('recipes').delete().like('name', `t-cross21-%-${TS}`);
  for (const p of Object.values(people)) if (p) await cleanupTestUser(p.user.userId);
}, FIRST_COMPILE_TIMEOUT_MS);

describe('I-1〜I-6: 関数 recipe_author_display_names', () => {
  it('I-1: anon が呼ぶと、公開の作者の表示名が返る', async () => {
    const names = await namesAs(supabaseAnon(), [people.author.user.userId]);
    expect(names.get(people.author.user.userId)).toBe(people.author.nickname);
  });

  it('I-2: 18 歳未満・生年月日なし・凍結中・設定オフ・名前なし・公開の内容が無い人は返らない', async () => {
    const keys = ['minor', 'noBirth', 'frozen', 'tempFrozen', 'optOut', 'noName', 'privateOnly', 'viewer'] as const;
    const names = await namesAs(supabaseAnon(), keys.map((k) => people[k].user.userId));
    expect([...names.keys()]).toEqual([]);
  });

  it('I-3: 一時凍結の期限が過ぎた人は返る', async () => {
    const names = await namesAs(supabaseAnon(), [people.tempFrozenExpired.user.userId]);
    expect(names.get(people.tempFrozenExpired.user.userId)).toBe(people.tempFrozenExpired.nickname);
  });

  it('I-4: 公開レシピへのコメントだけの人も返る', async () => {
    const names = await namesAs(supabaseAnon(), [people.commenter.user.userId]);
    expect(names.get(people.commenter.user.userId)).toBe(people.commenter.nickname);
  });

  it('I-5: 本人には自分の名前が返る (非公開だけ・設定オフ・18 歳未満)。他の人には返らない', async () => {
    for (const key of ['privateOnly', 'optOut', 'minor'] as const) {
      const self = await namesAs(supabaseAsUser(people[key].user.jwt), [people[key].user.userId]);
      expect(self.get(people[key].user.userId), `${key} 本人`).toBe(people[key].nickname);
      const other = await namesAs(supabaseAsUser(people.viewer.user.jwt), [people[key].user.userId]);
      expect(other.has(people[key].user.userId), `${key} を viewer から`).toBe(false);
    }
  });

  it('I-6: 重複・NULL・知らない id は無視。空の配列は 0 行', async () => {
    const id = people.author.user.userId;
    const names = await namesAs(supabaseAnon(), [id, id, null, '00000000-0000-0000-0000-000000000000']);
    expect([...names.entries()]).toEqual([[id, people.author.nickname]]);
    expect([...(await namesAs(supabaseAnon(), [])).keys()]).toEqual([]);
  });
});

describe('I-7〜I-10: レシピの API 経由', () => {
  type ListBody = { recipes: Array<{ id: string; userId: string | null; authorName: string }> };
  type DetailBody = { recipe: { authorName: string; comments: Array<{ content: string; authorName: string }> } };

  it('I-7: 一覧の authorName は作者の表示名 (未ログイン・ログイン中)。18 歳未満の作者は既定の呼称', async () => {
    for (const jwt of [null, people.viewer.user.jwt]) {
      const res = await apiCall<ListBody>('GET', `/api/recipes?q=t-cross21-`, jwt);
      expect(res.status).toBe(200);
      const byId = new Map(res.body.recipes.map((r) => [r.id, r]));
      expect(byId.get(publicRecipeId)?.authorName).toBe(people.author.nickname);
      const minorRecipe = res.body.recipes.find((r) => r.userId === people.minor.user.userId);
      expect(minorRecipe?.authorName).toBe(FALLBACK);
    }
  });

  it('I-8: 詳細の authorName とコメントの authorName', async () => {
    const anonRes = await apiCall<DetailBody>('GET', `/api/recipes/${publicRecipeId}`, null);
    expect(anonRes.status).toBe(200);
    expect(anonRes.body.recipe.authorName).toBe(people.author.nickname);
    const res = await apiCall<DetailBody>('GET', `/api/recipes/${publicRecipeId}`, people.viewer.user.jwt);
    expect(res.status).toBe(200);
    const byContent = new Map(res.body.recipe.comments.map((c) => [c.content, c.authorName]));
    expect(byContent.get(`t-cross21-comment-commenter-${TS}`)).toBe(people.commenter.nickname);
    expect(byContent.get(`t-cross21-comment-optOut-${TS}`)).toBe(FALLBACK);
    expect(byContent.get(`t-cross21-comment-minor-${TS}`)).toBe(FALLBACK);
  });

  it('I-9: PUT /api/profile の showRecipeAuthorName で他の人への見え方が変わる。本人の一覧は自分の名前のまま', async () => {
    const off = await apiCall('PUT', '/api/profile', people.author.user.jwt, { showRecipeAuthorName: false });
    expect(off.status).toBe(200);
    const hidden = await apiCall<ListBody>('GET', `/api/recipes?q=t-cross21-public-${TS}`, people.viewer.user.jwt);
    expect(hidden.body.recipes[0]?.authorName).toBe(FALLBACK);
    const own = await apiCall<ListBody>('GET', `/api/recipes?q=t-cross21-public-${TS}`, people.author.user.jwt);
    expect(own.body.recipes[0]?.authorName).toBe(people.author.nickname);
    const on = await apiCall('PUT', '/api/profile', people.author.user.jwt, { showRecipeAuthorName: true });
    expect(on.status).toBe(200);
    const shown = await apiCall<ListBody>('GET', `/api/recipes?q=t-cross21-public-${TS}`, people.viewer.user.jwt);
    expect(shown.body.recipes[0]?.authorName).toBe(people.author.nickname);
  });

  it('I-10: 非公開に戻す・隠すと、ほかに公開の内容が無い作者の名前は返らなくなる', async () => {
    const id = people.tempFrozenExpired.user.userId;
    await supabaseAdmin.from('recipes').update({ is_public: false }).eq('user_id', id);
    expect((await namesAs(supabaseAnon(), [id])).has(id)).toBe(false);
    await supabaseAdmin.from('recipes').update({ is_public: true, hidden_at: new Date().toISOString() }).eq('user_id', id);
    expect((await namesAs(supabaseAnon(), [id])).has(id)).toBe(false);
    await supabaseAdmin.from('recipes').update({ hidden_at: null }).eq('user_id', id);
    expect((await namesAs(supabaseAnon(), [id])).get(id)).toBe(people.tempFrozenExpired.nickname);
  });
});

describe('I-11〜I-12: 権限・RLS・退会', () => {
  it('I-11: EXECUTE は anon と authenticated だけ。user_profiles の SELECT のポリシーは本人の行だけの 1 本', async () => {
    const acl = await pgQuery<{ role: string; can: boolean }>(`
      SELECT r.role, has_function_privilege(r.role, 'public.recipe_author_display_names(uuid[])', 'EXECUTE') AS can
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
    `);
    expect(Object.fromEntries(acl.map((a) => [a.role, a.can]))).toEqual({ anon: true, authenticated: true, service_role: false });
    const pub = await pgQuery<{ public_exec: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE n.nspname = 'public' AND p.proname = 'recipe_author_display_names' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
      ) AS public_exec
    `);
    expect(pub[0]?.public_exec).toBe(false);
    const policies = await pgQuery<{ policyname: string; qual: string }>(`
      SELECT policyname, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' AND cmd = 'SELECT'
    `);
    expect(policies).toEqual([{ policyname: 'Users can view own profile', qual: '(auth.uid() = id)' }]);
  });

  it('I-12: 退会すると公開レシピは user_id が NULL で残り authorName は既定の呼称。コメントは消える', async () => {
    const victim = people.commenter;
    const { error } = await supabaseAdmin.auth.admin.deleteUser(victim.user.userId);
    expect(error).toBeNull();
    const res = await apiCall<{ recipe: { comments: Array<{ content: string }> } }>('GET', `/api/recipes/${publicRecipeId}`, people.viewer.user.jwt);
    expect(res.body.recipe.comments.map((c) => c.content)).not.toContain(`t-cross21-comment-commenter-${TS}`);
    const { data: row } = await supabaseAdmin.from('recipes').select('user_id').eq('id', privateRecipeId).maybeSingle();
    expect(row).not.toBeNull();
  });
});

describe('I-13〜I-15: 凍結の解除・18 歳の誕生日の境・システムのレシピ', () => {
  it('I-13: 凍結を解除 (frozen_at を NULL) すると名前が返る', async () => {
    const id = people.unfreeze.user.userId;
    expect((await namesAs(supabaseAnon(), [id])).has(id), '凍結中').toBe(false);
    const { error } = await supabaseAdmin.from('user_profiles').update({ frozen_at: null, unban_at: null }).eq('id', id);
    expect(error).toBeNull();
    expect((await namesAs(supabaseAnon(), [id])).get(id), '解除のあと').toBe(people.unfreeze.nickname);
  });

  it('I-14: 今日が 18 歳の誕生日 (JST) の人は返り、明日が 18 歳の誕生日の人は返らない', async () => {
    // 関数 (age_years_jst) と同じ DB の時計で、JST の今日から ADULT_AGE_YEARS 年前 (と、その翌日) を作る。
    // 2 月 29 日は、PG の date - interval が平年の 2 月 28 日にし、age_years_jst も同じ日に 18 とするので、境の意味は変わらない
    const [d] = await pgQuery<{ birthday_today: string; birthday_tomorrow: string }>(`
      SELECT to_char(((now() AT TIME ZONE 'Asia/Tokyo')::date - make_interval(years => ${ADULT_AGE_YEARS}))::date, 'YYYY-MM-DD') AS birthday_today,
             to_char(((now() AT TIME ZONE 'Asia/Tokyo')::date - make_interval(years => ${ADULT_AGE_YEARS}))::date + 1, 'YYYY-MM-DD') AS birthday_tomorrow
    `);
    const today = people.turns18Today.user.userId;
    const tomorrow = people.turns18Tomorrow.user.userId;
    // birth_date は特権列 (本人は書けない)。service_role は特権列ガードの対象外
    for (const [id, birthDate] of [[today, d.birthday_today], [tomorrow, d.birthday_tomorrow]] as const) {
      const { error } = await supabaseAdmin.from('user_profiles').update({ birth_date: birthDate }).eq('id', id);
      expect(error).toBeNull();
    }
    const names = await namesAs(supabaseAnon(), [today, tomorrow]);
    expect(names.get(today), '今日が 18 歳の誕生日').toBe(people.turns18Today.nickname);
    expect(names.has(tomorrow), '明日が 18 歳の誕生日 (今日は 17 歳)').toBe(false);
  });

  it('I-15: user_id が NULL のシステムの公開レシピは、一覧と詳細で authorName が既定の呼称', async () => {
    for (const jwt of [null, people.viewer.user.jwt]) {
      const list = await apiCall<{ recipes: Array<{ id: string; authorName: string }> }>('GET', `/api/recipes?q=t-cross21-system-${TS}`, jwt);
      expect(list.status).toBe(200);
      expect(list.body.recipes.find((r) => r.id === systemRecipeId)?.authorName).toBe(FALLBACK);
      const detail = await apiCall<{ recipe: { authorName: string } }>('GET', `/api/recipes/${systemRecipeId}`, jwt);
      expect(detail.status).toBe(200);
      expect(detail.body.recipe.authorName).toBe(FALLBACK);
    }
  });
});
```

(helper の名前 `supabaseAnon` / `supabaseAsUser` / `pgQuery` は `tests/integration/helpers/supabase.ts` の既存の export に合わせる。無い名前があれば、`anon-definer-execute.test.ts` の `client(anonKey)` / `client(anonKey, jwt)` / `pgQuery` と同じ作りを本テストの中に置く。)

### 7.11 既存の単体テストの直し (`tests/recipe-viewer-lookups-1917.test.ts` ほか。断片)

```ts
// tsc:skip
// モックの rpc は関数名で分岐する (詳細の increment_recipe_view_count と、名前の recipe_author_display_names の 2 つが同じ rpc を通る)
const authorNameRows: Array<{ author_id: string; display_name: string }> = [];
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
const supabaseMock = {
  auth: { getUser: async () => ({ data: { user: viewer }, error: null }) },
  rpc: async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (fn === 'recipe_author_display_names') return { data: authorNameRows, error: null };
    return { data: null, error: null };
  },
  from: (table: string) => query(table),   // recipe_likes だけ (user_profiles は呼ばれない)
};
```

- it の名前は §12 の U-1〜U-10。`argsOf('user_profiles', …)` の期待は `rpcCalls` の期待 (`{ fn: 'recipe_author_display_names', args: { p_user_ids: [AUTHOR_ID, COMMENTER_ID] } }`) に置き換える。
- `tests/recipes-route.test.ts`・`tests/recipe-detail-hidden-404.test.ts`・`tests/api-security-cluster.test.ts`・`tests/recipe-author-name-1649.test.ts` も同じ形 (`from('user_profiles')` の分岐を消し、`rpc` を関数名で分岐)。

### 7.12 段 C: プライバシーポリシーの文 (`src/lib/legal/privacy-text.ts`。オーナーの選択 §21 Q-1 のあと)

第9条の見出しと、第9条の `ol` の末尾に足す項 (3 項。文は 5 つ):

```ts
// tsc:skip
// PRIVACY_SECTION_HEADINGS[8] (いま '第9条（家族グループと組織での見え方）')
'第9条（家族グループ、組織、公開したレシピでの見え方）',

// 第9条 (id 'privacy-9') の ol の items の末尾に 3 項
'ユーザーが公開の状態にしたレシピとそのコメントには、ニックネームが作者名として表示され、ログインしていない方を含め、誰でも閲覧できる状態になります（利用規約第13条）。',
'作者名を表示しない設定にすると、ほかのユーザーには「匿名」と表示されます。初期設定では表示します。',
`${f.adultAgeYears} 歳未満のユーザーと、アカウントが凍結されているユーザーの作者名は表示しません。退会した後は作者名は表示されず、公開の状態のレシピの扱いは第12条のとおりです。`,
```

主張の表 (`tests/legal-claims-1901.ts`) に足す 5 行 (`chars` は文末の 。を除いた字数。実装で T の実行と食い違えば実測に合わせる):

```ts
// tsc:skip
{ id: 'privacy-9#12', section: 'privacy-9', fragment: 'ユーザーが公開の状態にしたレ', chars: 83, basis: 'product', evidence: 'cross/21 §6.3・supabase/migrations/*_recipe_author_display_names.sql・src/lib/legal/terms-text.ts (第13条 2 項)' },
{ id: 'privacy-9#13', section: 'privacy-9', fragment: '作者名を表示しない設定にする', chars: 36, basis: 'product', evidence: 'cross/21 §6.5・user_profiles.show_recipe_author_name' },
{ id: 'privacy-9#14', section: 'privacy-9', fragment: '初期設定では表示します', chars: 11, basis: 'product', evidence: 'cross/21 §6.5 (DEFAULT true)' },
{ id: 'privacy-9#15', section: 'privacy-9', fragment: '歳未満のユーザーと、アカウン', chars: 41, basis: 'product', evidence: 'cross/21 §6.1 (3)(4)・recipe_author_display_names の (b)' },
{ id: 'privacy-9#16', section: 'privacy-9', fragment: '退会した後は作者名は表示され', chars: 39, basis: 'product', evidence: 'cross/21 §6.1 (2)・第12条の参照' },
```

- `LEGAL_CLAIM_COUNT` を +5 (PR #1997 のあとなら 426 → 431。先なら 424 → 429)。
- 版: 選択肢 (a) なら PR #1997 の v2026.4 のまま (版は上げない。文を足すだけ)。(b) なら `LEGAL_DOCUMENTS` の両文書を v2026.5 にし、`docs/legal/archive/v2026.4/` に控えを作る (cross/20 §9.1 の手順)。
- 利用規約は変えない (第13条 2 項がすでに公開の範囲を書いている)。
- 見出しの変更は `tests/legal-text-1901.test.ts` の見出しの検査 (`PRIVACY_SECTION_HEADINGS` を読む所) と `src/lib/legal/index.ts` の再エクスポートに影響しない (配列の要素の値だけが変わる)。見出しの逐語を直書きしたテストがあれば直す (§16)。

---

## 8. facade 契約

| 面 | 契約 (逐語) | 変更 |
|---|---|---|
| SQL | `public.recipe_author_display_names(p_user_ids uuid[]) RETURNS TABLE (author_id uuid, display_name text)`。STABLE・SECURITY DEFINER・`search_path = ''`。EXECUTE: anon・authenticated | 新設 |
| SQL | `user_profiles.show_recipe_author_name boolean NOT NULL DEFAULT true` | 新設 (列) |
| TS | `export const RECIPE_AUTHOR_DISPLAY_NAMES_RPC = 'recipe_author_display_names'` | 新設 |
| TS | `export type RecipeViewerDb = Pick<SupabaseClient, 'from' / 'rpc'>` (`/` は union) | `'rpc'` を足す |
| TS | `export interface RecipeViewerLookups { authorNames: ReadonlyMap<string, string>; likedRecipeIds: ReadonlySet<string> }` | `nicknames: ReadonlyMap<string, unknown>` → `authorNames` |
| TS | `export type RecipeViewerLookupResult = ({ ok: true } & RecipeViewerLookups) / { ok: false; table: 'recipe_author_display_names' / 'recipe_likes'; error: PostgrestError }` | `table` の値を改める |
| TS | `export async function loadRecipeViewerLookups(supabase: RecipeViewerDb, viewerId: string / null, targets: { authorIds; recipeIds }): Promise<RecipeViewerLookupResult>` | 引数は同じ。未ログインでも名前を引く |
| TS | `export function recipeAuthorName(nickname: unknown): string`・`RECIPE_AUTHOR_FALLBACK_NAME = '匿名'` | 変更なし |
| TS | `RECIPE_AUTHOR_NAME_SETTING_LABEL`・`RECIPE_AUTHOR_NAME_SETTING_NOTE` | 新設 |
| TS | `UserProfile.showRecipeAuthorName: boolean`・`DbUserProfile.show_recipe_author_name: boolean / null` | 新設 |
| API | `GET /api/recipes`・`GET /api/recipes/[id]`・`GET / POST /api/recipes/[id]/comments` の返り値の形 (`authorName: string`) | 変更なし。値が変わる |
| API | `PUT /api/profile` の body に `showRecipeAuthorName?: boolean` | 既存の変換で通る (route の変更なし) |

---

## 9. 表 3 点

### 9.1 ①全パターン表 (作者の状態 × 見ている人 → `authorName`)

列: 一覧 (`GET /api/recipes`) / 詳細の作者 (`GET /api/recipes/[id]`) / 詳細・コメント GET のコメントの作者 / コメント POST の返り値。

| 作者の状態 | 見ている人 | 一覧 | 詳細の作者 | コメントの作者 | POST の返り値 |
|---|---|---|---|---|---|
| 名前あり・既定・凍結なし・18 歳以上・公開レシピあり | 他のログイン利用者 | 表示名 | 表示名 | 表示名 | — |
| 同 | 未ログイン | 表示名 | 表示名 | (RLS で 0 件 / GET は 401) | — |
| 同 | 本人 | 表示名 | 表示名 | 表示名 | 表示名 |
| 名前なし (`'Guest'`・空) | 全員 | 匿名 | 匿名 | 匿名 | 匿名 |
| 退会 (`user_id` NULL) | 全員 | 匿名 | 匿名 | (消える) | — |
| 凍結中 (無期限・一時で未来) | 他人・未ログイン | 匿名 | 匿名 | 匿名 | — |
| 凍結中 (無期限・一時で未来) | 本人 | N/A (403 `AUTH_ACCOUNT_FROZEN`。middleware が route の手前で止める。F-19a) | N/A (同) | N/A (同) | N/A (同) |
| 一時凍結の期限切れ | 他人・未ログイン | 表示名 | 表示名 | 表示名 | — |
| 18 歳未満・生年月日なし | 他人・未ログイン | 匿名 | 匿名 | 匿名 | — |
| 18 歳未満・生年月日なし | 本人 | 表示名 | 表示名 | 表示名 | 表示名 |
| 設定オフ (`show_recipe_author_name = false`) | 他人・未ログイン | 匿名 | 匿名 | 匿名 | — |
| 設定オフ | 本人 | 表示名 | 表示名 | 表示名 | 表示名 |
| 公開レシピなし・コメントだけ (公開レシピへ) | 他人 | — | — | 表示名 | — |
| 公開レシピなし・コメントなし (非公開だけ) | 本人 | 表示名 | 表示名 | — | 表示名 |
| 同 | 他人 (本人の非公開レシピは見えない) | — | — | — | — |
| 公開レシピを運営が隠した (ほかに公開なし) | 他人・未ログイン | (レシピが出ない) | (404) | コメント GET (ログイン中だけ) は今までどおり返る (F-19b)。書き手の名前は、ほかに公開の内容が無ければ匿名 (隠したレシピは (b) の公開に数えない) | — |
| 公開レシピを運営が隠した (ほかに公開なし) | 本人 | 表示名 (本人の一覧は `user_id.eq.自分` で隠したレシピも出る。F-1・F-16) | 表示名 (RLS で本人には見えて 200) | 本人のコメントは表示名 ((a))。他の書き手は、ほかに公開の内容が無ければ匿名 | 表示名 ((a)。INSERT はレシピの見え方を見ない。F-19b) |
| `user_id` NULL のシステムのレシピ | 全員 | 匿名 | 匿名 | — | — |
| 関数の失敗 | 全員 | 500 | 500 | 500 | 500 (保存しない) |

### 9.2 ②状態比較表 (現行 vs 設計後)

| 面 | main (`c9ee3e59`) | fix 枝 (`a8d75cec`) | 設計後 |
|---|---|---|---|
| 作者名の読み方 | select の埋め込み (`user_profiles(nickname)`。PostgREST が解決できず 500 / 空) | 別のクエリ (`user_profiles` を `.in('id', …)`。RLS で本人の行だけ) | SECURITY DEFINER の関数 `recipe_author_display_names` (本人 + 公開の作者) |
| 他人の公開レシピの `authorName` | (500 / 空) | 「匿名」 | 表示名 (凍結中・18 歳未満・設定オフ・名前なしは「匿名」) |
| 本人の `authorName` | (500 / 空) | 表示名 | 表示名 (変わらない) |
| 未ログインの `authorName` | 「匿名」 (未認証は埋め込まない) | 「匿名」 (DB に問い合わせない) | 表示名 (関数を呼ぶ) |
| いいね (`isLiked`) | 埋め込み | 別のクエリ (ログイン中だけ) | 変わらない |
| `user_profiles` の RLS | 本人の行だけ | 同 | 同 (変えない) |
| service_role | 使わない | 使わない | 使わない |
| 本人の選択 | 無い | 無い | `show_recipe_author_name` (プロフィールの編集) |
| プライバシーポリシー | 公開レシピの作者名の記載なし | 同 | 第9条に 3 項 (段 C。版はオーナーの選択) |
| anon が呼べる DEFINER の関数 | 2 本 | 2 本 | 3 本 |

### 9.3 ③状態遷移表 (作者の「他の人からの見え方」× 出来事 → 遷移先・ガード・副作用)

状態は 1 次元の列挙ではなく、他の人に名前が返るための **5 つの条件** (関数の (b) の 4 つと、本人を含む全員に掛かる K-名前) の組で表す (条件は互いに独立で、同時に何本でも欠けうる)。

| 記号 | 条件 (満たす = 真) | 関数 (§7.1) の式 |
|---|---|---|
| K-設定 | 名前を出す設定が on | `p.show_recipe_author_name` |
| K-凍結 | 凍結中でない | `p.frozen_at IS NULL OR (p.unban_at IS NOT NULL AND p.unban_at <= now())` |
| K-年齢 | 生年月日があり 18 歳以上 | `p.birth_date IS NOT NULL AND age_years_jst(p.birth_date) >= c_adult_age_years` |
| K-名前 | 表示名がある | `normalize_profile_name(p.nickname) IS NOT NULL` |
| K-公開 | 公開の内容がある (公開かつ隠されていないレシピ、またはそのレシピへのコメント) | 2 つの `EXISTS` の OR |

- 状態 = 「欠けている条件の集合」。**表示** = 集合が空 (5 つとも真)。**匿名{…}** = 1 つ以上欠けている (例: 匿名{設定, 凍結})。ほかに終わりの状態 **退会** (`user_profiles` の行が無い) がある。
- 他の人に返るのは **表示** のときだけ。どの条件が欠けているか (何個欠けているか) は返り値から分からない (§20)。
- 本人からは、退会を除くどの状態でも自分の名前 ((a)。K-名前 が偽なら本人にも「匿名」)。凍結中の本人はレシピの API に届かない (F-19a)。
- 関数は呼ばれるたびに 5 つの条件を今の行と時刻で計算し直す。状態を記録する列は無い (`show_recipe_author_name` は K-設定 の入力で、状態そのものではない)。したがって遷移先は「出来事が変えた 1 つの条件を集合に足す / 集合から除く」で決まり、出来事の順序に依らない (解除の順序は問わない。最後に欠けていた条件が満たされたときに初めて **表示** になる)。

出来事 × 条件 (1 つの出来事が変える条件は 1 つ):

| 出来事 | 変わる条件 | 遷移 (欠けている集合 X に対して) | ガード | 副作用 |
|---|---|---|---|---|
| 本人が設定を off にする (`PUT /api/profile`) | K-設定 を偽に | X → X ∪ {設定} | 本人の RLS の UPDATE (凍結中は 403 で届かない) | `show_recipe_author_name = false` |
| 本人が設定を on にする | K-設定 を真に | X → X − {設定} | 同 | 列を true に |
| 運営が凍結する (`frozen_at` を入れる・`unban_at` は無いか未来) | K-凍結 を偽に | X → X ∪ {凍結} | 運営 (service_role) | 既存の凍結の副作用 (ログイン不可・`/api/*` は 403) |
| 運営が凍結を解除する (`frozen_at` を NULL) / `unban_at` を過ぎる | K-凍結 を真に | X → X − {凍結} | 運営 / 時刻 | 解除は列の更新。期限切れは時刻で切れる (列は変わらない) |
| 18 歳の誕生日 (JST) を迎える | K-年齢 を真に | X → X − {年齢} | 生年月日があること | 時刻で切れる (列は変わらない) |
| 生年月日が記録される (`accept_legal_documents`) | K-年齢 を、18 歳以上なら真に (18 歳未満なら偽のまま) | X → X − {年齢} (18 歳以上のとき) / X のまま | `birth_date` が NULL の人だけ (write-once) | 既存の同意の副作用 |
| 18 歳未満と記録し直される | — | 起きない (`birth_date` は write-once で、18 歳以上の人が 18 歳未満になることは無い) | — | — |
| 本人がニックネームを空・`'Guest'` にする | K-名前 を偽に | X → X ∪ {名前} | `PUT /api/profile` | — |
| 本人が名前を入れる | K-名前 を真に | X → X − {名前} | 同 | — |
| レシピを公開にする (`is_public = true`) / 公開レシピにコメントする / 運営が隠したのを戻す (`hidden_at` を NULL) | K-公開 を真に | X → X − {公開} | 本人の RLS の書き込み / 運営 | 次の読み込みから |
| 最後の公開レシピを非公開に戻す / 運営が隠す / 最後の公開のコメントを消す (ほかに公開の内容が無いとき) | K-公開 を偽に | X → X ∪ {公開} | 同 | — |
| 退会する | (全部) | どの状態からも → **退会** | `prepare_account_deletion` → `deleteUser` | `recipes.user_id` NULL・`recipe_comments` 消える・`user_profiles` 消える |
| (退会のあと) | — | 戻らない | — | — |

重なった条件の例 (順序に依らないことの確認):

| 始めの状態 | 出来事の列 | 途中の状態 | 終わりの状態 | 他の人から |
|---|---|---|---|---|
| 匿名{設定, 凍結} | 凍結を解除 → 設定を on | 匿名{設定} | 表示 | 匿名 → 匿名 → 表示名 |
| 匿名{設定, 凍結} | 設定を on → 凍結を解除 | 匿名{凍結} | 表示 | 匿名 → 匿名 → 表示名 |
| 匿名{年齢, 公開} | 18 歳の誕生日 → レシピを公開 | 匿名{公開} | 表示 | 匿名 → 匿名 → 表示名 |
| 表示 | 凍結 → 設定を off → 凍結を解除 | 匿名{凍結} → 匿名{凍結, 設定} | 匿名{設定} | 表示名 → 匿名 → 匿名 → 匿名 |
| 匿名{凍結, 名前} | 退会 | — | 退会 | 匿名 (`user_id` NULL) |

表に無い遷移を作らない (例: 運営が作者名だけを隠す操作は無い。隠すのはレシピ単位の `hidden_at`)。

---

## 10. エラー表

| 場面 | 返すもの | 記録 | 根拠 |
|---|---|---|---|
| 関数の読み込みが失敗 (接続・PGRST202 (関数が無い)・権限) | 一覧・詳細・コメント GET: 500 (`internalError`、本文は汎用の文)。コメント POST: 保存せずに 500 | `internalError` の構造化ログ (`table: 'recipe_author_display_names'`) | fix 枝の決まり (名前が無いように見せない)。R-13 |
| `p_user_ids` が NULL / 空 / NULL を含む / 知らない id | 0 行 (エラーにしない) | なし | §7.1 の `COALESCE` と `WHERE t.u IS NOT NULL` |
| 未ログインで関数を呼ぶ | 公開の作者の名前だけ (エラーにしない) | なし | anon に EXECUTE |
| `PUT /api/profile` に `showRecipeAuthorName` が boolean でない値 | 既存の `fromUserProfile` はそのまま渡し、DB の型の失敗を `internalError` の 500 にする (既存の挙動。本書では検査を足さない) | 既存 | 既存の route の形 (ほかの boolean の列と同じ) |
| コードを先に出し、関数が無い (段の順序の違反) | 全部の一覧・詳細が 500 | — | R-16。§15 の順序で防ぐ |

新しいエラーコード (cross/04 の一覧) は足さない。

---

## 11. シーケンス

```mermaid
sequenceDiagram
    participant V as 見ている人 (本人 / 他人 / 未ログイン)
    participant R as GET /api/recipes[/id]
    participant L as loadRecipeViewerLookups
    participant DB as Postgres (RLS)
    participant F as recipe_author_display_names (DEFINER)
    V->>R: GET
    R->>DB: recipes を RLS で読む (公開 or 自分)
    DB-->>R: 行 (user_id を含む)
    R->>L: authorIds / recipeIds / viewerId
    par 名前 (未ログインでも)
        L->>F: rpc(p_user_ids)
        F->>F: 本人 or (公開の作者 and 設定 on and 凍結なし and 18 歳以上)
        F-->>L: (author_id, display_name) の行
    and いいね (ログイン中だけ)
        L->>DB: recipe_likes を自分の user_id で
        DB-->>L: recipe_id
    end
    L-->>R: authorNames / likedRecipeIds
    R-->>V: authorName (返らなかった人は '匿名')
```

---

## 12. テスト一覧 (it 名)

「(直す)」「(既存)」と書いたファイルのうち、`tests/recipe-viewer-lookups-1917.test.ts`・`tests/integration/security/recipes-api-logged-in.test.ts` と、§7.3 の `src/lib/recipes/viewer-lookups.ts` は、origin/main (`c9ee3e59`) には無く、fix/api-read-errors の枝 (`a8d75cec`) にある。本書の実装はその枝が main に入ったあとに積む (冒頭の前提・§3)。`tests/recipes-route.test.ts` ほかの「(直す)」も、fix 枝での形を土台にする。

| 種別 | ファイル | it 名 |
|---|---|---|
| 契約 (静的) | `tests/recipe-author-display-names-migration-contract.test.ts` (新) | C-1〜C-9 (§7.9 のとおり) |
| 結合 (実 DB) | `tests/integration/security/recipe-author-display-names.test.ts` (新) | I-1〜I-15 (§7.10 のとおり) |
| 単体 | `tests/recipe-viewer-lookups-1917.test.ts` (直す) | U-1「作者の表示名は recipe_author_display_names に id を渡して引き、いいねは自分の recipe_likes をレシピの id で引く。NULL の作者と重複は除く」/ U-2「未ログイン (viewerId が null) でも名前は引く。いいねは引かない」/ U-3「引く作者が無ければ関数を呼ばない。レシピが無ければいいねを引かない」/ U-4「data が null で返っても (失敗ではない)、名前もいいねも空として扱う」/ U-5「GET /api/recipes/[id]: レシピとコメントの作者の表示名・自分のいいねを返す。select に user_profiles・recipe_likes を埋め込まない」/ U-6「GET /api/recipes/[id]: 未ログインでも作者の表示名を返す (いいねは false)」/ U-7「GET /api/recipes/[id]/comments: 書いた人の表示名を返し、user_id は返さない」/ U-8「POST /api/recipes/[id]/comments: 自分の表示名を返す。名前が読めなければコメントを保存せずに 500」/ U-9 (`it.each` で GET 3 本)「%s: 作者の表示名 (recipe_author_display_names) が読めなければ 500。DB の生の文面は本文に出さず、読めなかった読み込みの名前をログに残す」(fix 枝の「作者の名前 (user_profiles) が読めなければ 500 …」の it.each を置き換える。S-16) / U-10「GET /api/recipes/[id]: user_id が NULL のシステムのレシピは authorName が既定の呼称で、関数に id を渡さない (コメントも無ければ関数を呼ばない)」(S-15)。ここに挙げない fix 枝の it (「いいねしていないレシピは isLiked が false」「自分のいいね (recipe_likes) が読めなければ 500 …」) は名前も中身も変えない |
| 単体 | `tests/recipes-route.test.ts` (直す) | 「認証済みなら公開レシピと自分のレシピを取る。作者の表示名と自分のいいねは埋め込まず、関数と別のクエリで引く (#1917・cross/21)」/「未ログインでも作者の表示名は関数で引く。いいねは DB に問い合わせない」/「取得した行を camelCase に変換し、関数が返した表示名と自分のいいねを反映する」 |
| 単体 | `tests/recipe-author-name-1649.test.ts`・`tests/recipe-detail-hidden-404.test.ts`・`tests/api-security-cluster.test.ts` (直す) | it 名は変えない。モックを §7.11 の形に |
| 単体 | `tests/recipe-author-name-setting-1917.test.tsx` (新) | P-1「toUserProfile: show_recipe_author_name が無い行は showRecipeAuthorName が true」/ P-2「fromUserProfile: showRecipeAuthorName を show_recipe_author_name に写す。undefined なら書かない」/ P-3「プロフィールの編集の基本情報タブに、ニックネームの下の切り替えがラベルと注記つきで出て、外して保存すると PUT /api/profile の本文に showRecipeAuthorName: false が入る」 |
| 結合 (既存) | `tests/integration/security/recipes-api-logged-in.test.ts` | 変更なし (本人の非公開のレシピに本人の名前。関数の (a) で同じ結果) |
| 結合 (既存) | `tests/integration/security/anon-definer-execute.test.ts` | A1 / A1b の期待を 3 本に (§7.8) |
| 文面 (段 C) | `tests/legal-text-1901.test.ts`・`tests/legal-claims-1901.ts` | 主張の表に 5 行・`LEGAL_CLAIM_COUNT` +5 (§7.12) |

---

## 13. 定数一覧 (名前付きの値と根拠)

| 定数 | 値 | 置き場 | 根拠 | 環境変数で上書き |
|---|---|---|---|---|
| `c_adult_age_years` | 18 | §7.1 の関数 | `ADULT_AGE_YEARS` (法令の年齢。cross/14) と同じ。C-4 が突き合わせる | しない (法令の値) |
| `RECIPE_AUTHOR_DISPLAY_NAMES_RPC` | `'recipe_author_display_names'` | `viewer-lookups.ts` | 関数の名前。C-8 が突き合わせる | しない |
| `RECIPE_AUTHOR_FALLBACK_NAME` | `'匿名'` | `author-name.ts` (既存) | 既定の呼称 | しない |
| `RECIPE_AUTHOR_NAME_SETTING_LABEL` / `_NOTE` | §7.4 | `author-name.ts` | 画面の文言 | しない |
| 列の既定値 | `true` | migration | 本書の冒頭の前提 (作者名を出す) | しない |
| `lock_timeout` | `'10s'` | migration | 既存の migration の定型 (`20261023130000`) | しない |

運用で変えうる値 (回数・時間・上限) は本書に無い (入力の配列の上限を置かない理由は §6.2)。

---

## 14. 新設一覧

| 種別 | 名前 | 置き場所 |
|---|---|---|
| ファイル | `<番号>_recipe_author_display_names.sql` | `supabase/migrations/` |
| ファイル | `<番号>_recipe_author_display_names.down.sql` | `supabase/rollbacks/` |
| 列 | `user_profiles.show_recipe_author_name boolean NOT NULL DEFAULT true` | DB |
| 索引 | `idx_recipe_comments_user_id` (`recipe_comments (user_id)`) | DB |
| 関数 | `public.recipe_author_display_names(uuid[])` | DB |
| 定数 | `RECIPE_AUTHOR_DISPLAY_NAMES_RPC` | `src/lib/recipes/viewer-lookups.ts` |
| 型 | `AuthorNameRow` (非公開) | 同 |
| 欄 | `RecipeViewerLookups.authorNames` (`nicknames` の置き換え) | 同 |
| 定数 | `RECIPE_AUTHOR_NAME_SETTING_LABEL`・`RECIPE_AUTHOR_NAME_SETTING_NOTE` | `src/lib/recipes/author-name.ts` |
| 欄 | `UserProfile.showRecipeAuthorName`・`DbUserProfile.show_recipe_author_name` | `types/domain.ts`・`types/database.ts` |
| ファイル | `recipe-author-display-names-migration-contract.test.ts` | `tests/` |
| ファイル | `recipe-author-display-names.test.ts` | `tests/integration/security/` |
| ファイル | `recipe-author-name-setting-1917.test.tsx` | `tests/` |
| 許可一覧の行 | `'recipe_author_display_names(uuid[])'` | `tests/integration/security/anon-definer-execute.test.ts` |
| 既存ファイルの変更 (新設ではない) | `src/app/api/recipes/route.ts`・`[id]/route.ts`・`[id]/comments/route.ts` (§7.5)・`lib/converter.ts` (§7.6)・`src/app/(main)/profile/page.tsx` (§7.7)・`src/types/database.types.ts`・`packages/shared/src/database.types.ts` (生成し直し)・`tests/recipe-viewer-lookups-1917.test.ts`・`tests/recipes-route.test.ts`・`tests/recipe-author-name-1649.test.ts`・`tests/recipe-detail-hidden-404.test.ts`・`tests/api-security-cluster.test.ts` (§7.11)・段 C: `src/lib/legal/privacy-text.ts`・`tests/legal-claims-1901.ts` (§7.12) | — |
| 設計書 | `docs/design/cross/21-recipe-author-display-name.md` (本書) | `docs/design/cross/` |

新しい環境変数・route・テーブル・RLS ポリシー・エラーコードは無い (R-18)。

---

## 15. 段分け (実装 WF は 2 本 + 段 C。それぞれで 2 枚レビューを閉じる)

| 段 | 中身 | 前提 | 本番の順序 |
|---|---|---|---|
| A (DB) | §7.1 migration・§7.2 戻し口・§7.9 契約テスト・§7.10 結合テストの I-1〜I-6・I-11・I-13・I-14・`database.types.ts` 2 本の生成し直し・§7.8 許可一覧 | fix/api-read-errors が main に入っていること (結合テストの API 経由の部分は段 B へ)。`tests/database-types-migrations-contract.test.ts` が関数と列を見るので、型の生成し直しは同じ PR | マージの前に本番へ適用する (追加だけの migration。適用の確認は §19)。列と関数が先に存在しても、fix 枝のコードは使わないので挙動は変わらない |
| B (API・設定) | §7.3 `viewer-lookups.ts`・§7.4 `author-name.ts`・§7.5 route の 1 語 × 5・§7.6 型と変換・§7.7 画面・§7.11 単体テストの直し (U-1〜U-10)・§7.10 の I-7〜I-10・I-12・I-15・P-1〜P-3 | 段 A が本番に適用済み (関数が無いと全部の一覧・詳細が 500。R-16) | マージ = 公開。段 C の版の選択肢 (a)(b) を取るなら、公開の日を文面の施行日 (v2026.4 なら 2026-11-01) 以後にそろえる。(c) ならすぐ |
| C (文面) | §7.12 の 5 文・見出し・主張の表 5 行・版 (選択肢に従う) | オーナーの選択 (§21 Q-1) | 文面の版の施行日 (予告のあと) |

- A と B は同じ worktree で積んでもよいが、PR は分ける (A の本番の適用を B のマージの前に確かめるため)。
- 戻すとき: B のコードを戻してから A の戻し口を流す (§7.2 の注意)。
- 段 B の変更は 15 ファイル以内・1,500 行以内 (分割パネルは要らない)。

---

## 16. 既存の番兵 (契約テスト・走査テスト) の追随表

本設計が足す・変える・移すものの名前を grep の語にして `tests/`・`src/__tests__/`・`lib/**/__tests__`・`packages/shared/src/*.test.ts`・`scripts/` を走査した結果 (2026-10-24・origin/main `c9ee3e59` と fix 枝 `a8d75cec`)。「(fix 枝)」と書いた番兵は main には無く、fix/api-read-errors が main に入ってから実在する (§12 の注記と同じ)。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/recipe-viewer-lookups-1917.test.ts` (fix 枝) | `nicknames`・`user_profiles`・`argsOf('user_profiles'` | `from('user_profiles')` の select / in を期待し、`nicknames` を読むので赤 | §7.11 の形に直し、it 名を U-1〜U-10 に (U-9 は fix 枝の「作者の名前 (user_profiles) が読めなければ 500」の it.each の置き換え) | B |
| `tests/recipes-route.test.ts` (fix 枝) | `lookupResults.user_profiles`・`未ログインなら作者の名前もいいねも DB に問い合わせない` | `user_profiles` のクエリと「未ログインは問い合わせない」を期待するので赤 | `rpc` を関数名で分岐するモックに替え、it 名を §12 のとおりに | B |
| `tests/recipe-author-name-1649.test.ts`・`tests/recipe-detail-hidden-404.test.ts`・`tests/api-security-cluster.test.ts` (fix 枝) | `table === 'user_profiles'`・`emptyLookup` | `from('user_profiles')` の分岐で名前を返す / 0 行にしているので、名前を期待する it が赤 | `rpc` の分岐で `recipe_author_display_names` の行を返す (§7.11)。it 名は変えない | B |
| `tests/postgrest-embed-relationship-scan.test.ts` (fix 枝) | `.select('`・`MIN_CHECKED_EMBEDS` | `rpc` は埋め込みではないので数えない。埋め込みの数は変わらない | 変更なし | — |
| `tests/integration/security/recipes-api-logged-in.test.ts` (fix 枝) | `authorName`・`NICKNAME` | 本人の非公開のレシピの `authorName` が本人の nickname。関数の (a) で同じ結果 | 変更なし (段 A の適用後に緑のまま。段 B で実際に関数を通る) | — |
| `tests/integration/security/anon-definer-execute.test.ts:95-100, 123-151` | `ANON_EXECUTABLE_DEFINER_ALLOWLIST`・`許可リストの 2 本` | A1: 許可一覧に無い DEFINER の関数を anon が呼べると赤。A1b: 一覧の関数が anon に呼べないと赤 | §7.8 の行を足し、describe / it の「2 本」を「3 本」に | A |
| `tests/integration/security/anon-invoker-execute.test.ts` | `prosecdef`・`許可一覧` | SECURITY INVOKER の関数だけを見る。本書の関数は DEFINER | 変更なし | — |
| `tests/database-types-migrations-contract.test.ts:202-225` | `Functions`・`Tables`・`CREATE FUNCTION` | migration の関数が 2 つの型ファイルの `Functions` に無いと赤。写しがずれると赤 | ローカルの Supabase で型を生成し直し、2 つのファイルに同じ内容を置く (`__InternalSupabase` は残す) | A |
| `tests/migration-file-version-integrity.test.ts:53-109` | `-- migration:`・`-- rollback:`・`supabase/rollbacks/` | 1 行目の見出しがファイル名と違う・戻し口が無い・見出しが違うと赤 | §7.1・§7.2 の形。番号の確定で 4 か所を同時に書き換える | A |
| `tests/db-privilege-hardening-migration-contract.test.ts` | `GRANT ALL`・`TRUNCATE` | 新しい migration / 戻し口が anon / authenticated に表の TRUNCATE (ALL を含む) を付けると赤 | 本書の migration は関数の EXECUTE だけを GRANT する (C-6・C-7 が重ねて見る) | A |
| `tests/rpc-profile-name-placeholder-migration-contract.test.ts:161` | `normalize_profile_name を定義する migration は本 migration だけ` | 別の migration が `normalize_profile_name` を CREATE すると赤 | 本書の migration は呼ぶだけ (C-2 の `MUST_NOT_REDEFINE`) | — |
| `tests/parental-consent-migration-contract.test.ts` | `age_years_jst`・`guard_user_profiles_privileged` | 特権列ガードや年齢の関数を作り直すと赤になりうる | 作り直さない (C-2) | — |
| `tests/integration/security/legal-documents-acceptance.test.ts` | `guard_user_profiles_privileged` | ガードの列が減ると赤 | ガードを触らない | — |
| `tests/integration-ci-coverage.test.ts:90-99` | `tests/integration/security` | 新しい結合テストが CI の指定に当たらないと赤 | `tests/integration/security/` に置く (指定に当たる) | A・B |
| `tests/integration/rls/hidden-content-visibility.test.ts` (B2〜B4) | `Users can view public recipes` | `recipes` の RLS を変えると赤 | 変えない | — |
| `src/__tests__/api/null-character-routes.test.ts:168-174` | `recipes/route.ts`・`profile/route.ts` | 本文を読む route の一覧。新しい route は無い | 変更なし | — |
| `tests/supabase-service-role-client-scan.test.ts` | `createClient(`・`SUPABASE_JS_CLIENT_ALLOWLIST` | service_role のクライアントを自前で作ると赤 | 作らない | — |
| `tests/api-raw-error-message-scan.test.ts`・`tests/lib-raw-error-message-scan.test.ts` | `error.message` | 生のエラーの文を本文に返すと赤 | `internalError` のまま | — |
| `tests/env-source-scan.test.ts` | `process.env` | 新しい環境変数は無い | 変更なし | — |
| `tests/no-pending-wording-1911.test.ts`・`tests/public-claims-guard.test.ts` | `準備中`・`予定です`・`FORBIDDEN` | `src` の文言に未完成・予定の語があると赤 | §7.4 の文言に入れない | B |
| `tests/legal-text-1901.test.ts:1058-1073`・`tests/legal-claims-1901.ts:25` | `LEGAL_CLAIM_COUNT`・`fragment`・`chars` | 文を足して主張の表を足さないと赤。字数が違うと赤 | §7.12 の 5 行と +5 | C |
| `tests/legal-text-1901.test.ts` (見出し) | `PRIVACY_SECTION_HEADINGS`・`家族グループと組織での見え方` | 見出しの逐語を直書きした検査があれば赤 | 直書きがあれば新しい見出しに | C |
| `packages/shared/src/legal-versions.test.ts` | `LEGAL_DOCUMENTS`・`effectiveDate` | 版の形と施行日の形 | 選択肢 (b) で版を上げるときも形は同じ | C |
| `tests/docs-table-column-count.test.ts` | `docs/`・`\|` | 本書の表の行が見出しと違う数の区切りを持つと赤 | 本書の表はセルの中の `\|` をコードの span に入れるか、`/` で書く | 設計 |
| `tests/design-doc-version-header-matches-history.test.ts` | `\| 版 \| v` | 表紙の版と改定履歴の最後の版が食い違うと赤 | 本書の表紙は版の表 (§22 と同じ行) | 設計 |
| `tests/design-doc-removed-mobile-screens.test.ts`・`tests/docs-mobile-removed-references.test.ts` | `apps/mobile/app/` | 消したモバイルの画面を名指しすると赤 | 本書はモバイルの画面を名指ししない | 設計 |
| `tests/auth/no-login-lockout.test.ts` | `LOCK_AFFIRMING_DOC_PATTERNS` | docs にログインの締め出しを前提にした文があると赤 | 本書は書かない | 設計 |
| 走査テスト (as any・マジックナンバー) | `as any`・数のリテラル | 本書の TS に `as any` は無い。数は §13 の定数 | §13 の形を守る | A・B |

---

## 17. 他の文書への追随表 (本書では編集しない。実装 PR または docs PR で)

| 文書 | 箇所 | 直すこと | 期日 |
|---|---|---|---|
| `docs/design/cross/CLAUDE.md` | ファイル一覧の表 | `21-recipe-author-display-name.md` の行を足す (「公開レシピの作者の表示名 (SECURITY DEFINER の関数で公開の作者だけ・本人の選択・凍結と年齢の扱い)」/ #1917 の続き)。「10・11 は欠番」の文はそのまま | 設計のマージと同日 |
| `docs/design/cross/02-rls-patterns.md` | §3.3 の末尾 | 「他人の `user_profiles` の表示名を公開レシピの作者として出す経路は、SECURITY DEFINER の関数 `recipe_author_display_names` (cross/21。RLS のポリシーは足していない)」の 1 行 | 段 A のマージと同日 |
| 同 | §10 の表の Security の行 (行 585) | anon が EXECUTE できる DEFINER の関数の許可一覧が 3 本になること (関数名を添える) | 同上 |
| `docs/design/cross/20-terms-privacy-text.md` | §7 第9条・§10.3 主張の表・§9.1 (版)・§2.2 (F の行を 1 つ足す: 公開レシピの作者名の表示の経路) | §7.12 の文と行。版はオーナーの選択 (§21 Q-1) に従う。cross/20 は A 型の正規の経路か docs PR で改定する | 段 C |
| `docs/design/cross/14-parental-consent.md` | §8 (別 Issue・注記) | 「18 歳未満の本人のアカウントの公開レシピの作者名は公開の場に出さない (cross/21 §6.1 (4))」の 1 行 | 段 A のマージと同日 |
| `CLAUDE.md` (root) | 行 83 (他ユーザーの行を読むときは認可のあとに `getSupabaseAdmin()`) | 例外の 1 文: 「公開レシピの作者の表示名だけは、認可の無い一覧・詳細でも SECURITY DEFINER の関数 `recipe_author_display_names` で読む (cross/21)」 | 段 B のマージと同日 |
| Issue #1139 のコメント (予告の文) | 「Apple についての記載を加えるもの」 | 選択肢 (a) のとき、公開レシピの作者名の表示の記載も加えることを文に足す (投稿の前) | 段 C (オーナーの選択のあと) |
| `supabase/baseline/prod_function_acl.sql` | 関数の ACL の控え | 次にベースラインを作り直すときに本関数の行が入る (手で直さない) | 次のベースラインの更新 |

---

## 18. 既存実装との関連

| 対象 | 扱い |
|---|---|
| fix 枝の `viewer-lookups.ts`・route 3 本・テスト | 土台にして差し替える (§7.3・§7.5・§7.11)。fix 枝が main に入る前に本書の実装を始めない |
| `recipeAuthorName`・`RECIPE_AUTHOR_FALLBACK_NAME`・`normalizeProfileName` | 保持 (変えない) |
| `user_profiles` の RLS 3 本・`recipes` / `recipe_comments` の RLS | 保持 (変えない) |
| `increment_recipe_view_count` の呼び出し・詳細の 404 の判定・コメント POST の検査 | 保持 |
| `PUT /api/profile`・`fromUserProfile` / `toUserProfile` | 列を 1 つ通す (§7.6)。route は変えない |
| プロフィールの編集画面 | チェック 1 つを足す (§7.7) |
| `prepare_account_deletion`・外部キーの `ON DELETE` | 保持 (退会の扱いは既存のまま) |
| `age_years_jst`・`normalize_profile_name` | 本文から呼ぶ。作り直さない |

---

## 19. 受入条件と本番の確認 (オーケストレーターが行う。本書のコードは本番に書き込まない)

段 A の適用のあと (読み取りだけ):

1. `schema_migrations` に本 migration の番号がある。
2. `information_schema.columns` で `user_profiles.show_recipe_author_name` が `boolean`・`NOT NULL`・既定 `true`。`SELECT count(*) FROM user_profiles WHERE show_recipe_author_name IS DISTINCT FROM true` が 0。
3. `pg_proc` で `recipe_author_display_names` が `prosecdef = true`・`provolatile = 's'`・`proconfig` に `search_path=`。
4. `has_function_privilege` が anon・authenticated で true、service_role で false。PUBLIC の EXECUTE が無い (I-11 と同じ SQL)。
5. `pg_policies` の `user_profiles` の SELECT が `Users can view own profile` の 1 本のまま。
6. `pg_indexes` に `idx_recipe_comments_user_id`。

段 B の公開のあと:

7. 未ログインで `GET /api/recipes` (公開レシピがあれば) の `authorName` が「匿名」以外になりうること (本番は `recipes` が 0 行なので、捨てアカウント 2 つ (18 歳以上・生年月日あり) で公開レシピ 1 件を作って確かめ、用済み後に消す。捨て伝票・捨てデータの恒常承認の範囲)。
8. 同じ公開レシピを、捨てアカウントの一方で `PUT /api/profile { showRecipeAuthorName: false }` にしてから他方で読み、「匿名」になること。
9. デプロイ後整合ゲート (2 枚) で、本書 §9.1 の行のうち本番で確かめられるもの (未ログイン・他人・本人・設定オフ) を実測する。

---

## 20. 性能・安全の考慮

- 一覧 1 ページ (最大 100 行) で関数の呼び出しは 1 回。id ごとに `user_profiles` の主キー 1 回・`recipes` の `idx_recipes_user_id` の EXISTS 1 回・`recipe_comments` の `idx_recipe_comments_user_id` + `recipes` の主キーの EXISTS 1 回。
- 関数は `STABLE` なので 1 文の中で `auth.uid()`・`now()` は 1 回の値。
- 関数が返すのは id と表示名だけ。判定に使う列 (生年月日・凍結・設定) の値は返さない。「返らなかった」ことから分かるのは「公開の作者でないか、名前を出さない状態」のどれかで、どれかは分からない。
- `user_id` が一覧の返り値に含まれるので、関数を uuid → 名前の引き直しに使えるかが論点になる。(b) の EXISTS で「公開の場にすでに名前が出る人」に閉じているので、関数から新しく分かることは無い。
- 直接 `/rest/v1/rpc` から呼ぶ anon の費用は、配列の長さに線形。PostgREST の本文の大きさの上限と、既存の `in.(…)` と同じ露出 (§6.2)。

---

## 21. 未解決事項 (設計は上の既定で進める)

| # | 事項 | 本書の置き方 | 誰が決めるか |
|---|---|---|---|
| Q-1 | プライバシーポリシーの文 (§7.12) の版の置き方: (a) v2026.4 (PR #1997・施行日 2026-11-01 の仮置き) に入れ、Issue #1139 の予告の文に作者名の表示を足してから投稿する / (b) 別の版 v2026.5 / (c) 版を上げずに文だけ足す | (a) を既定にして段 C を書いた。(a)(b) のときは段 B の公開を施行日以後にそろえる。(c) は勧めない (§6.4) | オーナー |
| Q-2 | 作者名を描く画面が今は無い (F-13)。API の `authorName` を一覧・詳細のどこに描くかは別の発注 | 本書は API の値と設定の切り替えまで。画面は別 Issue の候補 | オーナー |
| Q-3 | 18 歳未満の本人の作者名を出さない (§6.1 (4)) ことは本書の既定。保護者の同意書に「公開レシピの作者名」を足して出す案は取らない | 出さないまま。変えるなら cross/14 の同意書の版上げを伴う別の設計 | オーナー |
| Q-4 | 凍結中の作者名を出さない (§6.1 (3)) ことは本書の既定 | 出さないまま | オーナー |
| Q-5 | 本人には設定オフでも自分の名前が出る (§6.1 (5))。画面で「他の人には匿名」と分かる印 (`isOwner` を使う) は作者名を描く画面ができるときに | 注記の文言 (§7.4) で説明する | — (Q-2 と一緒) |

---

## 22. 改定履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-24 | 新設 (A 型 4 相。構造 A = SECURITY DEFINER の関数 `recipe_author_display_names` + 本人の選択の列 `show_recipe_author_name`。段 A/B/C。プライバシーポリシーの版はオーナーに聞く (Q-1)) |
