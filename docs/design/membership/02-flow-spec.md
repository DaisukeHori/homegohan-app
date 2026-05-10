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
        → 既存 pending 招待は revoked 化 (RPC 内)
        → SUPABASE.admin.listUsers({ filter: `email.eq.${email}` })
        → IF 既存 → invite_url = `${BASE_URL}/invite/${token}`, template = 'A'
        → IF 新規 → invite_url 同上, template = 'B'
        → Resend.send({ to: email, ...templateA|B })
        → IF email send fail → 500 EMAIL_SEND_FAILED (招待 row は残す, retry 可)
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
        → user_profiles 更新, organization_invites.status = 'accepted'
        → membership_audit に invite_accepted 記録
        → 200 { data: { organization_id, org_role } }
        → /org/dashboard へ redirect
```

### 1.3 Error path
```
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
server → UPDATE organization_invites SET status='revoked', revoked_at=NOW(), revoked_by=auth.uid()
        → 監査ログ
```

---

## 4. organization メンバ除名 + 自発脱退

```
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
       → Alice.org_role = 'admin', Bob.org_role = 'owner'
       → organizations.owner_id = bob_id
       → 監査ログ owner_transferred
       → 200 { data: { organization } }
```

---

## 6. family 家族グループ作成

```
[user=Mom] /family/setup → [家族グループを作る] → 名前入力「山田家」
POST /api/family/groups
       body: { name: '山田家', plan_key: 'free' }
server → rpc('create_family_group', { p_name, p_plan_key })
       → 整合性: caller が既に他 family にいたら ALREADY_IN_FAMILY
       → family_groups INSERT, family_members INSERT (representative)
       → user_profiles.family_id = new
       → 監査ログ
       → 201 { data: { family_group } }
```

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
       → user_profiles.family_id = X, family_members INSERT (role='adult', share_*)
       → 監査ログ
```

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

## 9. family 子供 → 実 user promote

```
[adult] /family/members/{id} → [アカウントを発行する]
       (子供本人の email or 親が代理 email 指定)
       (子供本人がスマホで signup → 親に通知 → 親が「同一人物」確認)

POST /api/family/members/{id}/promote
       body: { user_id }
server → rpc('promote_child_to_user', { p_member_id, p_user_id })
       → family_members.user_id = X, child_profile = NULL
       → user_profiles.family_id 設定
       → 過去 meals/health の "child_profile_id" 参照を user_id に書き換え (script)
       → 監査ログ
```

---

## 10. family 代表者譲渡 (2 step)

org owner 譲渡と同パターン。`propose_family_representative_transfer` / `accept_family_representative_transfer`。代表は他の adult にしか譲渡できない (child は不可)。

---

## 11. family メンバ除名 / 自発脱退

```
[adult] /family/members/{id} → [家族から外す]
POST /api/family/members/{user_id}/remove
server → rpc('remove_family_member', { p_family_id, p_user_id })
       → 整合性: target が representative なら CANNOT_REMOVE_REPRESENTATIVE
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

server → 認可: source_meal.user_id == auth.uid()
       → 整合性: 全 target が同 family の active member
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
| create_family_group | name, plan_key | family_groups | authenticated | POST /api/family/groups |
| create_family_invite | family_id, email, custom_message | family_invites | authenticated | POST /api/family/invites |
| accept_family_invite | token, share_meals, share_health, share_menu | family_members | authenticated | POST /api/family/invites/{token}/accept |
| reject_family_invite | token | family_invites | anon/authenticated | POST /api/family/invites/{token}/reject |
| revoke_family_invite | invite_id | family_invites | authenticated | POST /api/family/invites/{id}/revoke |
| add_family_child | family_id, display_name, child_profile | family_members | authenticated | POST /api/family/members/child |
| promote_child_to_user | member_id, user_id | family_members | authenticated | POST /api/family/members/{id}/promote |
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
