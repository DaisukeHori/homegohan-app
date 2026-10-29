# 02. Flow Spec — State Machines and Sequences

各フローを **状態遷移 + sequence diagram (テキスト)** で定義する。実装時は本ファイルがテストケースと照合される。

---

## 1. organization 招待 — 既存ユーザ編 (α-1, α-2)

### 1.1 状態機械
```
                ┌──────────┐
                │ pending  │ ◄── create_org_invite() でここに INSERT
                └────┬─────┘
       ┌─────────────┼─────────────┬──────────────┐
       │             │             │              │
       ▼             ▼             ▼              ▼
 ┌──────────┐ ┌──────────┐ ┌──────────┐  ┌────────────┐
 │ accepted │ │ rejected │ │ expired  │  │  revoked   │
 └──────────┘ └──────────┘ └──────────┘  └────────────┘
   accept_      reject_      expires_at      admin が
   org_invite() org_invite() < NOW()         create_org_invite()
                              (deferred       で再発行時 or
                               CHECK)         明示 revoke API
```

### 1.2 Happy path sequence
```
[admin] POST /api/org/invites
        body: { organization_id, email: alice@a.com, role: 'member', custom_message? }

server  → 認可: caller.org_role IN ('owner','admin')
        → SUPABASE: SELECT seat_limit/used_seats from org_license_pools
        → IF seats full → 400 SEAT_LIMIT_EXCEEDED
        → SUPABASE.rpc('create_org_invite', { ... }) → invite row
        → 宛先がこの組織の在籍者・持ち主なら 409 ALREADY_IN_ORG (RPC 内。招待を作らない・既存の pending も取り消さない。#1799)
        → 既存 pending 招待は revoked 化 (RPC 内)
        → SUPABASE.admin.listUsers({ filter: `email.eq.${email}` })
        → IF 既存 → invite_url = `${BASE_URL}/invite/${token}`, template = 'A'
        → IF 新規 → invite_url 同上, template = 'B'
        → Resend.send({ to: email, ...templateA|B })
        → IF email send fail → ログに残し (org-invite.ts の warn と、sendEmail の app_logs への error)、招待 row は残して 200 (sendEmail は送信の失敗で例外を投げず結果で返す。src/lib/membership/org-invite.ts)
        → 200 { data: { invite, invite_url } }

[Alice (既存)] mail click → /invite/{token}

server (Next.js page)
        → SUPABASE.rpc('get_invite_details', { token }) — 認証不要 SECURITY DEFINER
        → IF expired → 表示「期限切れ」
        → IF accepted → 表示「すでに承諾済」+ /home へ CTA
        → IF rejected → 表示「拒否済み」
        → IF revoked → 表示「招待は取り消されました」
        → IF pending かつ未ログイン →「ログイン or signup」
        → IF pending かつログイン中 かつ email 一致 → 承諾画面 (organization 詳細表示)
        → IF pending かつログイン中 かつ email 不一致 → 「signOut してから再 click」案内

[Alice] [承諾する] click

POST /api/org/invites/{token}/accept

server  → SUPABASE.rpc('accept_org_invite', { token })
        → user_profiles 更新 (プロフィール行が無ければ既定値で作る。#1273), organization_invites.status = 'accepted'
        → membership_audit に invite_accepted 記録
        → 200 { data: { organization_id, org_role } }
        → /org/dashboard へ redirect
```

### 1.3 Error path
```
[Alice] [承諾する] - だが既に同じ組織に所属 (持ち主を含む。#1799)
  → server: ALREADY_IN_ORG エラー (org_role は変えない。招待は pending のまま・席数も監査ログも変わらない)
  → UI: 「既に組織に所属しています。」
  → 不要な招待は /api/org/invites/{token}/reject で拒否できる

[Alice] [承諾する] - だが既に他組織所属
  → server: ALREADY_IN_ORG エラー
  → UI: 「あなたは現在 orgA に所属しています。orgB に移動しますか?」
  → ユーザが「移動する」選択 → 先に /api/org/leave を呼ぶ (脱退) → 再度 accept
  → ユーザが「拒否」選択 → /api/org/invites/{token}/reject

[Alice] [承諾する] - だが Alice は別 orgA の owner
  → server: IS_ORG_OWNER エラー
  → UI: 「あなたは orgA の Owner です。先に Owner を譲渡してください」
  → /org/owner-transfer へ誘導
```

---

## 2. organization 招待 — 新規ユーザ編 (α-4)

### 2.1 sequence
```
[admin] POST /api/org/invites (上記と同じ、template = 'B' になる)

[Alice (未登録)] mail click → /invite/{token}

server (Next.js page)
        → get_invite_details → pending かつ未認証
        → 表示: 「アカウントを作成して参加」フォーム (email pre-fill, disabled)

[Alice] password 入力 → [作成して参加]

POST /api/auth/signup-and-accept-invite
        body: { token, password }

server  → SUPABASE.auth.signUp({ email: invite.email, password, options: { email_confirm: false } })
        → SUPABASE.auth.signInWithPassword({ email, password })  -- session 取得
        → SUPABASE.rpc('accept_org_invite', { token })  -- 上記 RPC をそのまま呼ぶ
        → 200 { data: { organization_id, org_role, user_id } }
        → onboarding 1問目から開始
```

---

## 3. organization 招待拒否 / revoke

```
[Alice] /invite/{token} → [拒否]
POST /api/org/invites/{token}/reject
server → rpc('reject_org_invite', { token }) → status=rejected
UI: 「招待を拒否しました」

[admin] org/invites 一覧 → 該当 invite 行 → [取り消す]
POST /api/org/invites/{id}/revoke
server → rpc('revoke_org_invite', { p_invite_id }) (SECURITY DEFINER。利用者の UPDATE の権限は外してある: 20261022180000)
        → 監査ログ
```

---

## 4. organization メンバ除名 + 自発脱退

```
[admin] /org/members (メンバーの一覧)
GET /api/org/members
server → requireOrgAdmin (JWT の本人・所属組織・org_role が owner / admin。本人の行は RLS で読む。違えば 403・未ログインは 401)
       → 確かめた organization_id の user_profiles を service_role で読む (user_profiles の SELECT の RLS は本人の行だけのため。#2073 S4)
       → 返すのは id・nickname・org_role・joined_org_at だけ (ORG_MEMBER_NAME_COLUMNS。参加した日の古い順)
       → 200 { members: [...] }

[admin] /org/members/{id} → [このメンバを外す]
POST /api/org/members/{user_id}/remove
server → rpc('remove_org_member', { p_organization_id, p_user_id })
       → 整合性: target が owner なら拒否
       → 整合性: caller が admin で target が admin なら拒否 (owner のみが admin を外せる)
       → user_profiles.organization_id = NULL, org_role = NULL
       → 監査ログ

[member=Alice] /settings/membership → [脱退する]
POST /api/org/leave
server → rpc('leave_org')
       → 整合性: caller が owner なら IS_ORG_OWNER エラー (先に譲渡を要求)
       → user_profiles 同上更新
       → 監査ログ
```

---

## 5. organization owner 譲渡 (2 step)

```
[owner=Alice] /org/settings/owner-transfer (候補の一覧)
GET /api/org/owner-transfer/candidates
server → requireOrgAdmin + org_role = 'owner' (管理者・一般メンバーは 403・未ログインは 401)
       → 確かめた organization_id の user_profiles のうち、自分と org_role = 'owner' を除いた行を service_role で読む (#2073 S4)
       → 返すのは id・nickname・org_role・joined_org_at だけ (参加した日の古い順)
       → 200 { candidates: [...] }

[owner=Alice] /org/settings/owner-transfer → [Bob を新 owner にする]
POST /api/org/owner-transfer/propose
       body: { to_user_id: bob_id }
server → rpc('propose_org_owner_transfer', { p_organization_id, p_to_user_id })
       → membership_audit に owner_transfer_proposed 記録 (proposal_id 返却)
       → Resend で Bob に通知メール「○○組織の Owner 譲渡が打診されました」
       → 200 { data: { proposal_id, expires_at } }

[Bob] mail link → /org/transfer-accept/{proposal_id}
       UI: 「Alice さんから ○○組織の Owner を引き継ぎますか?」
       [承諾] / [拒否]

POST /api/org/owner-transfer/{proposal_id}/accept
server → rpc('accept_org_owner_transfer', { p_proposal_id })
       → 提案の行 → organizations → Bob の user_profiles → Alice の user_profiles をロックしてから判定する
       → 整合性: 組織が解散していれば ORG_ALREADY_DISSOLVED (409)
       → 整合性: 承諾時点で Bob が今もこの組織のメンバーでなければ TRANSFER_ACCEPTOR_NOT_IN_ORG (403)
       → 整合性: Alice が今もこの組織のオーナーでなければ NOT_ORG_OWNER (403)
       → Alice.org_role = 'admin', Bob.org_role = 'owner'
       → organizations.owner_id = bob_id
       → 監査ログ owner_transferred
       → Resend で Alice (旧オーナー) と Bob (新オーナー) に完了メール (失敗しても 200。構造化ログに残す。04 §5.2)
       → 200 { data: { organization } }
```

**承諾時の不変条件 (#1236):** 提案 (`ownership_transfer_proposals`) は最長 7 日間 pending のまま残り、その間に宛先が脱退・別組織へ移籍することがある。承諾 RPC は承諾時点で `user_profiles.organization_id = 提案の組織` を再検証し、満たさなければ何も変更せずに `TRANSFER_ACCEPTOR_NOT_IN_ORG` (403) を返す。提案の行は `status = 'pending'` の条件つきで `FOR NO KEY UPDATE` で取る (`supabase/migrations/20261022140000_org_transfer_toctou.sql`) ので、同時の二重承諾や辞退と競合したとき、後から来た側は再評価で行が外れて `TRANSFER_PROPOSAL_NOT_FOUND` (404) になる (二重承諾の防止)。accepted への更新の `status = 'pending'` 条件と `TRANSFER_NOT_PENDING` (409) は防御として残る (通常は届かない)。

**解散・強制譲渡と同時の承諾 (`supabase/migrations/20261022140000_org_transfer_toctou.sql`):** 承諾 RPC は、提案の行 → `organizations` の行 → 承諾者の `user_profiles` → 旧オーナーの `user_profiles` を `FOR NO KEY UPDATE` で取ってから判定する (ロックの向きは `docs/design/family/11-self-dissolve.md` §11.3)。判定の順は `MINOR_ACCOUNT_NOT_ALLOWED` → `TRANSFER_PROPOSAL_NOT_FOUND` → `TRANSFER_PROPOSAL_EXPIRED` → `ORG_ALREADY_DISSOLVED` → `TRANSFER_ACCEPTOR_NOT_IN_ORG` → `TRANSFER_NOT_PENDING` → `NOT_ORG_OWNER`。解散した組織の提案は `ORG_ALREADY_DISSOLVED`、運営の強制譲渡のあとに残った提案 (提案者がもうオーナーでない) は `NOT_ORG_OWNER` で止め、どちらも何も変更しない (提案は pending のまま)。所属の外れた行へ `org_role` を書かない (CHECK `user_profiles_org_consistency` (23514) にならない)。想定外の DB のエラーは生の文を本文に出さず、500 と汎用の文にして構造化ログに残す。

| エラーコード | HTTP | 意味 |
|---|---|---|
| `TRANSFER_PROPOSAL_NOT_FOUND` | 404 | pending かつ自分宛ての提案が無い (承諾済み・他人宛て・存在しない) |
| `TRANSFER_PROPOSAL_EXPIRED` | 410 | 期限切れ |
| [NEW] `TRANSFER_ACCEPTOR_NOT_IN_ORG` | 403 | 承諾時点で組織のメンバーでない |
| `TRANSFER_NOT_PENDING` | 409 | 防御として残る (accepted への更新の `status = 'pending'` 条件が外れたとき)。提案の行を pending の条件つきでロックするので、同時の承諾・辞退との競合は `TRANSFER_PROPOSAL_NOT_FOUND` になり、通常は届かない |
| `ORG_ALREADY_DISSOLVED` | 409 | 組織が解散している (解散のあとに残った提案・解散と同時の承諾)。`supabase/migrations/20261022140000_org_transfer_toctou.sql` |
| `NOT_ORG_OWNER` | 403 | 提案者が今はこの組織のオーナーでない (運営の強制譲渡のあとに残った提案)。`supabase/migrations/20261022140000_org_transfer_toctou.sql` |
| `CONFLICT_RETRY` | 409 | デッドロック (40P01)。組織の関数どうしは組織の行を最初に取るので起きない (`docs/design/family/11-self-dissolve.md` §11.3) が、想定の外の組み合わせで検出されたときも生の文を出さずにやり直しを促す (route が SQLSTATE を `mapPgErrorToHttp` に渡す。既存の規約)。やり直せば通る |

**未成年 (#1173):** `accept_org_owner_transfer` は、本人の `user_profiles.birth_date` が 18 歳未満なら `MINOR_ACCOUNT_NOT_ALLOWED` (403。設計書 `cross/14-parental-consent.md` §6.4 の 12)。18 歳未満の本人が家族に入るのは昇格 (§9) だけで、家族の代表者・組織のオーナーは引き受けない (保護者の同意とのつながりが切れたときの退会を 409 で塞がない)。

---

## 6. family 家族グループ作成

```
[user=Mom] /family/setup → [家族グループを作る] → 名前入力「山田家」
POST /api/family/groups
       body: { name: '山田家' }
server → rpc('create_family_group', { p_name })   ※ プランは渡さない (p_plan_key は既定の 'free'。グループのプランは代表者の契約から DB のトリガーが決める: billing/01 S20)
       → 整合性: caller が既に他 family にいたら ALREADY_IN_FAMILY
       → family_groups INSERT, family_members INSERT (representative)
       → user_profiles.family_id = new
       → 監査ログ
       → 201 { data: { family_group } }
```

**未成年 (#1173):** `create_family_group` は、本人の `user_profiles.birth_date` が 18 歳未満なら `MINOR_ACCOUNT_NOT_ALLOWED` (403。設計書 `cross/14-parental-consent.md` §6.4 の 12)。18 歳未満の本人が家族に入るのは昇格 (§9) だけで、家族の代表者・組織のオーナーは引き受けない (保護者の同意とのつながりが切れたときの退会を 409 で塞がない)。 **退会の手続き中 (#1917 の続き):** 新しい退会の印 (`account_deletion_guards`) のある本人は家族を作れない (`family_groups` のトリガー `trg_representative_not_deleting` (関数 `family_groups_representative_not_deleting`) が `REPRESENTATIVE_ACCOUNT_DELETING` で止める。route は 409。`supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql`)。 退会が `deleteUser` の前に止まると (409・途中の失敗)、退会の本体が返す前に印を消すので、そのあとは作れる (`20261024120000_account_deletion_guard_release.sql`)。

---

## 7. family 招待 + 受諾 (大人)

α-1 と同パターン (template 'C' を使用)。子供招待 (`invited_role=child`) は仕様上拒否される (`CHECK invited_role IN ('adult')`)。子供は親が直接 add_family_child で追加。

承諾画面で **閲覧権限選択 ダイアログ** を必須:
```
[Dad] /invite/family/{token} → [承諾する] click

承諾モーダル表示:
┌────────────────────────────────────┐
│ 山田家への参加を承諾します          │
│                                    │
│ あなたが家族に共有する情報:        │
│  ☑ 食事記録 (献立・食べたもの)     │
│  ☐ 健康記録 (体重・血圧)           │
│  ☑ 週間献立                        │
│  (後で変更できます)                │
│                                    │
│ [承諾する]  [戻る]                 │
└────────────────────────────────────┘

POST /api/family/invites/{token}/accept
       body: { share_meals: true, share_health: false, share_menu: true }
server → rpc('accept_family_invite', { p_token, p_share_meals, p_share_health, p_share_menu })
       → user_profiles.family_id = X (プロフィール行が無ければ既定値で作る。#1273), family_members INSERT (role='adult', share_*,
         display_name = 本人の user_profiles.nickname を normalizeProfileName と同じ判定で写したもの。前後の空白を除く。
         空・空白だけ・仮置きの 'Guest'・プロフィール行が無い人は NULL。#1584・20261015170000)
       → 監査ログ
```

**未成年 (#1173):** `accept_family_invite` は、本人の `user_profiles.birth_date` が 18 歳未満なら `MINOR_ACCOUNT_NOT_ALLOWED` (403。設計書 `cross/14-parental-consent.md` §6.4 の 12)。18 歳未満の本人が家族に入るのは昇格 (§9) だけで、家族の代表者・組織のオーナーは引き受けない (保護者の同意とのつながりが切れたときの退会を 409 で塞がない)。

---

## 8. family 子供メンバ追加 (auth account なし)

```
[adult] /family/members → [子供を追加] → 名前/年齢/性別/アレルギー入力
POST /api/family/members/child
       body: { display_name, child_profile: { age, gender, allergies, ... } }
server → rpc('add_family_child', { p_family_id, p_display_name, p_child_profile })
       → family_members INSERT (user_id=NULL, role='child', child_profile)
       → 整合性: family.member_limit に対する human count 検証
       → 監査ログ
```

---

## 9. family 子供 → 実 user promote (本人同意フロー、#1232)

旧設計 (代表者・大人が `promote_child_to_user` で即時に紐付ける) は、本人の同意なしに既存ユーザーを
家族へ編入できたため廃止した (#1232)。`promote_child_to_user` は両方の引数の版とも常に
`PROMOTION_DIRECT_DISABLED` を返す (もしくは削除済み)。

```
[rep/adult] /family/members/{id}/promote → 子供本人のメールアドレスを入力
POST /api/family/members/{id}/promote  body: { email }
server → rpc('request_child_promotion', { p_member_id, p_email })
       → family_promotion_requests に pending 行 (token 64 桁 hex、14 日有効)
       → 同意依頼メール (リンク: /family/promotions/{token})。token は HTTP 応答に含めない
       → family_members / user_profiles は変えない
       (DELETE 同 URL → rpc('revoke_child_promotion') で取消。再送は旧 pending を自動で取消)

[本人] /family/promotions/{token} (未ログイン・初期設定前でも開ける)
       → rpc('get_promotion_details', { p_token }) で内容を表示
       → 宛先メールアドレスのアカウントでログインして承認 / 拒否
POST /api/family/promotions/{token}/accept  body: { share_meals, share_health, share_menu }
server → rpc('accept_child_promotion', ...)
       → 本人の auth.uid() のメールが宛先と一致するときだけ
         family_members.user_id = 本人, role = 'adult', child_profile = NULL, share_* = 本人の選択
         display_name は空 (NULL・空白だけ) のときだけ本人のプロフィールの名前を写す (判定は §7 と同じ。
         子供のときの呼び名が入っていれば上書きしない。#1584・20261015170000)
       → user_profiles.family_id 設定 (プロフィール行が無ければ既定値で作る)
       → 監査ログ (child_promoted)
POST /api/family/promotions/{token}/reject → rpc('reject_child_promotion')
```

---

## 10. family 代表者譲渡 (2 step)

org owner 譲渡と同パターン。`propose_family_representative_transfer` / `accept_family_representative_transfer`。代表は他の adult にしか譲渡できない (child は不可)。提案時に宛先へ提案メール、承諾後に旧代表者と新代表者へ完了メールを送る (§5 と同じ。宛先のメールアドレスは `auth.users` から引く。04 §5)。

**承諾時の不変条件 (#1237):** 承諾 RPC は承諾時点で、承諾者がその家族の `status = 'active'` かつ `role IN ('representative', 'adult')` のメンバーであることを再検証し、満たさなければ何も変更せずに [NEW] `TRANSFER_ACCEPTOR_NOT_IN_FAMILY` (403) を返す (脱退・除名済みのユーザーが古い提案で代表者になり、家族グループを DELETE CASCADE できてしまうのを防ぐ。いまは利用者による家族の行の直接の DELETE そのものが無い: `20261022200000_family_groups_no_direct_delete.sql`・#1961)。二重承諾の防止とその他のエラーコードは §5 と同じ。

**未成年 (#1173):** `accept_family_representative_transfer` は、本人の `user_profiles.birth_date` が 18 歳未満なら `MINOR_ACCOUNT_NOT_ALLOWED` (403。設計書 `cross/14-parental-consent.md` §6.4 の 12)。18 歳未満の本人が家族に入るのは昇格 (§9) だけで、家族の代表者・組織のオーナーは引き受けない (保護者の同意とのつながりが切れたときの退会を 409 で塞がない)。 **退会の手続き中 (#1917 の続き):** 新しい退会の印のある承諾者は代表者を引き受けない (トリガー `trg_representative_not_deleting` (関数 `family_groups_representative_not_deleting`) が `REPRESENTATIVE_ACCOUNT_DELETING` で止め、提案は pending のまま。route は 409。運営の強制譲渡 `operator_force_representative_transfer` の譲渡先も同じで、route は 409「譲渡先のユーザーは退会の手続き中です」。`20261023150000`)。 退会が `deleteUser` の前に止まると (409・途中の失敗)、退会の本体が返す前に印を消すので、そのあとは引き受けられる (`20261024120000`)。

---

## 11. family メンバ除名 / 自発脱退

```
[adult] /family/members/{id} → [家族から外す]
POST /api/family/members/{user_id}/remove
server → rpc('remove_family_member', { p_family_id, p_user_id })
       → 整合性: target が representative なら IS_FAMILY_REPRESENTATIVE (409)
       → family_members.status = 'removed', removed_at = NOW()
       → user_profiles.family_id = NULL
       → meals 等は保持 (削除しない)
       → 監査ログ

[member=Dad] /settings/membership → [家族から脱退する]
POST /api/family/leave
server → rpc('leave_family')
       → 整合性: caller が representative なら IS_FAMILY_REPRESENTATIVE
       → family_members.status = 'left'
       → user_profiles.family_id = NULL
```

---

## 12. ペースト実行 (UI 操作 → DB)

```
[Mom] /menus/weekly → 既存夕食レコード長押し → action sheet → [家族にもペースト]
       → モーダル: メンバチェックボックス [☑ 父 ☐ 子A ☑ 子B]
       → [選択してペースト]

POST /api/meals/paste
       body: { source_meal_id, target_user_ids: [father_id, childB_id] }

server → 認可: source_meal.user_id == auth.uid()。他人の行は 403 INSUFFICIENT_PERMISSION (DB の NOT_MEAL_OWNER)
       → 元の行が無いときも 403 INSUFFICIENT_PERMISSION (DB の NOT_MEAL_OWNER。#1634。他人の行と同じ返し方にし、その id の行が在るかどうかを教えない)
       → 運営が隠した食事 (hidden_at IS NOT NULL) は 403 MEAL_HIDDEN (#1101。持ち主の確認のあと)
       → ハンズオンのお試しの記録 (is_sandbox = true) は 403 MEAL_SANDBOX (#1627。隠した食事の確認のあと)
       → 自分が家族にいない (user_profiles.family_id が NULL) ときは 403 NOT_IN_FAMILY (#1634。お試しの記録の確認のあと)
       → 整合性: 全 target が同 family の active member。貼り付け先が家族にいないときは 400 USER_NOT_IN_FAMILY (DB の TARGET_NOT_IN_FAMILY。#1634)
       → (ここまでの確認は、どれも paste_meal_to_family の中で行う。断ったときは、家族の側の行・元の行の paste_group_id・監査の行のどれも残らない。
          DB の例外の語は src/app/api/meals/paste/route.ts が語の完全一致で引く。TARGET_NOT_IN_FAMILY を NOT_IN_FAMILY と取り違えない)
       → SUPABASE.rpc('paste_meal_to_family', { p_source_meal_id, p_target_user_ids })
       → 各 target に新 meal レコード INSERT (paste_group_id 共通)
       → source meal にも paste_group_id を後付け
       → 監査ログ paste_executed
       → 200 { data: { paste_group_id, inserted_count: 2 } }

[UI] 各メンバの献立表に同じ夕食レコードが appear。paste_group_id で「🔗 3人で共有」表示。
```

---

## 13. 共有設定変更

```
[Dad] /settings/membership/share → [食事記録 OFF] toggle
PATCH /api/family/members/me/share
       body: { share_meals: false }
server → caller の family_members 行を UPDATE
       → 即時 RLS が反映、Mom から Dad の meals が見えなくなる
       → 既にペーストされた Mom 自身の meal copies は影響なし (各自の所有物)
```

---

## 14. 運営管理者 緊急介入 (Owner/Representative 不在時)

詳細は `05-operator-emergency-ui.md` 参照。要点:
- `is_inactive_member()` 関数で 90 日以上 last_login_at が NULL or 90 日以上前のメンバを判定
- operator が `force_transfer_org_owner` / `force_transfer_family_representative` / `force_dissolve_*` RPC を呼ぶ (super_admin 権限のみ)
- 監査ログに `actor_id = NULL, metadata.operator_id = caller_id` を記録 (system actor として)
- 強制実行前に email/SMS で対象メンバに「Owner 不在のため操作を実行します」通知 (24h 待機オプション)

---

## 15. 全 RPC 一覧 (一覧表)

| RPC name | 引数 | 戻り値 | 認証 | 想定呼出経路 |
|---|---|---|---|---|
| create_org_invite | org_id, email, role, custom_message | organization_invites | authenticated | POST /api/org/invites |
| accept_org_invite | token | user_profiles | authenticated | POST /api/org/invites/{token}/accept |
| reject_org_invite | token | organization_invites | anon/authenticated | POST /api/org/invites/{token}/reject |
| revoke_org_invite | invite_id | organization_invites | authenticated | POST /api/org/invites/{id}/revoke |
| remove_org_member | org_id, user_id | user_profiles | authenticated | POST /api/org/members/{user_id}/remove |
| leave_org | (none) | user_profiles | authenticated | POST /api/org/leave |
| propose_org_owner_transfer | org_id, to_user_id | UUID (proposal_id) | authenticated | POST /api/org/owner-transfer/propose |
| accept_org_owner_transfer | proposal_id | organizations | authenticated | POST /api/org/owner-transfer/{id}/accept |
| create_family_group | name, plan_key (既定 'free'。POST /api/family/groups は name だけを渡す) | family_groups | authenticated | POST /api/family/groups |
| create_family_invite | family_id, email, custom_message | family_invites | authenticated | POST /api/family/invites |
| accept_family_invite | token, share_meals, share_health, share_menu | family_members | authenticated | POST /api/family/invites/{token}/accept |
| reject_family_invite | token | family_invites | anon/authenticated | POST /api/family/invites/{token}/reject |
| revoke_family_invite | invite_id | family_invites | authenticated | POST /api/family/invites/{id}/revoke |
| add_family_child | family_id, display_name, child_profile | family_members | authenticated | POST /api/family/members/child |
| request_child_promotion (#1232) | member_id, email | JSONB (token はメール用。HTTP 応答には含めない) | authenticated | POST /api/family/members/{id}/promote |
| revoke_child_promotion (#1232) | member_id | family_promotion_requests | authenticated | DELETE /api/family/members/{id}/promote |
| accept_child_promotion (#1232) | token, share_meals, share_health, share_menu | family_members | authenticated | POST /api/family/promotions/{token}/accept |
| reject_child_promotion (#1232) | token | family_promotion_requests | authenticated | POST /api/family/promotions/{token}/reject |
| get_promotion_details (#1232) | token | JSONB | anon/authenticated | (承認ページ /family/promotions/{token} から直接) |
| promote_child_to_user (廃止、#1232) | member_id, email | family_members | authenticated | (常に PROMOTION_DIRECT_DISABLED) |
| remove_family_member | family_id, user_id | family_members | authenticated | POST /api/family/members/{user_id}/remove |
| leave_family | (none) | family_members | authenticated | POST /api/family/leave |
| propose_family_representative_transfer | family_id, to_user_id | UUID | authenticated | POST /api/family/representative-transfer/propose |
| accept_family_representative_transfer | proposal_id | family_groups | authenticated | POST /api/family/representative-transfer/{id}/accept |
| paste_meal_to_family | source_meal_id, target_user_ids | UUID (paste_group_id) | authenticated | POST /api/meals/paste |
| update_my_share_settings | family_id, share_meals, share_health, share_menu | family_members | authenticated | PATCH /api/family/members/me/share |
| force_transfer_org_owner | org_id, new_owner_id, reason | organizations | super_admin | POST /api/operator/membership/org/{id}/transfer |
| force_transfer_family_representative | family_id, new_rep_id, reason | family_groups | super_admin | POST /api/operator/membership/family/{id}/transfer |
| force_dissolve_org | org_id, reason | organizations | super_admin | POST /api/operator/membership/org/{id}/dissolve |
| force_dissolve_family | family_id, reason | family_groups | super_admin | POST /api/operator/membership/family/{id}/dissolve |

---

## 16. テスト戦略 (各フローを E2E でカバー)

| spec ファイル | カバー範囲 |
|---|---|
| tests/e2e/membership/01-org-invite-existing-user.spec.ts | α-1, α-2 (既存ユーザ承諾, 既ログイン承諾) |
| tests/e2e/membership/02-org-invite-new-user.spec.ts | α-4 (新規 signup → 即メンバ化) |
| tests/e2e/membership/03-org-invite-edge-cases.spec.ts | α-3 (email 不一致), α-5 (既所属), α-6 (owner), α-7 (expired), α-8 (invalid token), α-9 (再 click), α-10 (拒否) |
| tests/e2e/membership/04-org-member-management.spec.ts | α-11 (除名), α-12 (脱退), α-13 (Owner 譲渡), α-14 (seat 上限) |
| tests/e2e/membership/05-family-create-and-invite.spec.ts | β-1, β-2 (作成 + 招待 + 承諾 + 共有設定) |
| tests/e2e/membership/06-family-edge-cases.spec.ts | β-3 (別 family owner), β-4 (別 family member), β-8 (人数上限) |
| tests/e2e/membership/07-family-child-management.spec.ts | β-5 (子供追加), β-6 (子供 promote), 子供削除 |
| tests/e2e/membership/08-family-representative-transfer.spec.ts | 代表譲渡, 解除 |
| tests/e2e/membership/09-meal-paste.spec.ts | ペースト実行, paste_group 表示, 編集独立性 |
| tests/e2e/membership/10-share-settings.spec.ts | share_meals OFF で家族から見えなくなる, ON で復活 |
| tests/e2e/membership/11-operator-emergency.spec.ts | 強制 owner 譲渡, 強制 representative 譲渡, 強制解散 |
| tests/e2e/membership/15-self-dissolve.spec.ts | 代表者 / オーナーの解散と、そのあとの退会 |
