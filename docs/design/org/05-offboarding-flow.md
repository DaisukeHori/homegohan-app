# org/ オフボーディングフロー (UC-ORG-17)

## 1. 目的・スコープ

退職者の組織ライセンス自動回収と、退職者が家族グループオーナーだった場合の凍結・選択肢提示フローを定義する。

対象:
- UC-ORG-17: 退職時の家族グループ owner 処理
- HR Webhook 受信の冪等化設計
- `hr_webhook_events` / `hr_revoke_jobs` のキュー処理
- pg_cron worker (5 分ごと処理)
- 30 日 grace period
- 楽観的ロック (`If-Unmodified-Since` + advisory lock)

## 2. 関連要件

- 要件定義 02 §4.17 (UC-ORG-17)
- 要件定義 02 §15.2 (保持する DB テーブル)
- 100-scenarios.md D7 / D8

## 3. フロー全体図

```mermaid
sequenceDiagram
  participant HR as HR System
  participant API as /api/webhooks/hr
  participant DB as PostgreSQL
  participant Cron as pg_cron (5分)
  participant User as 退職者
  participant Family as 家族メンバー

  HR->>API: POST /api/webhooks/hr (退職者リスト)
  API->>DB: INSERT hr_webhook_events (idempotent)
  API->>DB: INSERT hr_revoke_jobs × N
  API-->>HR: 202 Accepted (即時返却)

  loop 5分ごと
    Cron->>DB: SELECT hr_revoke_jobs WHERE status='pending' AND next_attempt_at <= NOW()
    DB-->>Cron: job list (batch 10件)

    loop 各ジョブ
      Cron->>DB: UPDATE hr_revoke_jobs SET status='processing'
      Cron->>DB: UPDATE org_license_assignments SET revoked_at=NOW(), status='revoked'
      Note over Cron,DB: trigger → family_groups 凍結チェック
      Cron->>DB: family_groups WHERE source_org_assignment_id = assignment_id
      alt 家族グループが見つかった場合
        Cron->>DB: UPDATE family_groups SET status='frozen', freeze_grace_until=NOW()+30d
        Cron->>User: Push + Email (凍結通知 + 選択肢)
        Cron->>Family: Push + Email (閲覧のみ可能通知)
      end
      Cron->>DB: UPDATE hr_revoke_jobs SET status='done'
    end
  end

  User->>API: POST /api/family/groups/{id}/migrate-to-personal
  Note over User,API: If-Unmodified-Since ヘッダ + advisory lock
  API->>DB: UPDATE family_groups SET status='active', source_org_assignment_id=NULL
  API->>Stripe: 個人プラン Checkout
```

## 4. HR Webhook 受信 (冪等化)

### 4.1 受信エンドポイント

`POST /api/webhooks/hr`

```typescript
export async function POST(req: Request) {
  // 1. Bearer token 検証
  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  const org = await verifyHrWebhookToken(token);  // organizations.scim_token_hash
  if (!org) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const body = await req.json();
  const { external_id, event_type, employees } = body;

  // 2. 冪等チェック (organization_id + external_id の unique 制約)
  const { data: existing } = await supabase
    .from('hr_webhook_events')
    .select('id')
    .eq('organization_id', org.id)
    .eq('external_id', external_id)
    .single();

  if (existing) {
    return Response.json({ idempotent: true, event_id: existing.id });
  }

  // 3. hr_webhook_events に raw 保存
  const { data: event } = await supabase
    .from('hr_webhook_events')
    .insert({
      organization_id: org.id,
      external_id,
      payload: body,
      processed: false,
    })
    .select('id')
    .single();

  // 4. hr_revoke_jobs を employees 件数分 INSERT (status=pending)
  const now = new Date().toISOString();
  const jobs = employees.map((emp: HrEmployee) => ({
    webhook_event_id: event.id,
    organization_id: org.id,
    user_id_or_email: emp.email,   // user_id 解決は worker で行う
    status: 'pending',
    next_attempt_at: now,
  }));

  await supabase.from('hr_revoke_jobs').insert(jobs);

  return Response.json(
    { event_id: event.id, jobs_queued: jobs.length, idempotent: false },
    { status: 202 }
  );
}
```

### 4.2 冪等保証の仕組み

```sql
-- hr_webhook_events の unique 制約で重複受信を防ぐ
UNIQUE (organization_id, external_id)
```

HR システムが同じ `external_id` で再送した場合:
- `INSERT` が `unique_violation` → 既存レコードを返して 200
- `hr_revoke_jobs` への INSERT は行われない
- 処理の二重実行なし

## 5. pg_cron Worker (hr_revoke_worker)

### 5.1 cron 設定

```sql
-- 5 分ごとに hr_revoke_worker を実行
SELECT cron.schedule(
  'hr_revoke_worker',
  '*/5 * * * *',
  $$SELECT process_hr_revoke_jobs()$$
);
```

### 5.2 Worker 関数

```sql
CREATE OR REPLACE FUNCTION process_hr_revoke_jobs()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_job RECORD;
  v_user_id UUID;
  v_assignment RECORD;
  v_family_group RECORD;
BEGIN
  -- バッチ 10 件を取得 (skip locked で並行 worker 対応)
  FOR v_job IN
    SELECT * FROM hr_revoke_jobs
    WHERE status IN ('pending', 'failed')
      AND next_attempt_at <= NOW()
      AND attempts < max_attempts
    ORDER BY next_attempt_at ASC
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  LOOP
    -- processing にマーク
    UPDATE hr_revoke_jobs
      SET status = 'processing', attempts = attempts + 1
      WHERE id = v_job.id;

    BEGIN
      -- user_id を解決 (email → user_id)
      SELECT up.id INTO v_user_id
        FROM user_profiles up
        WHERE up.organization_id = v_job.organization_id
          AND up.email = v_job.user_email;

      IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'user_not_found for job %', v_job.id;
      END IF;

      -- ライセンス回収
      UPDATE org_license_assignments
        SET status = 'revoked',
            revoked_at = NOW(),
            revoke_reason = 'hr_webhook',
            updated_at = NOW()
        WHERE user_id = v_user_id
          AND organization_id = v_job.organization_id
          AND status = 'active'
        RETURNING * INTO v_assignment;

      -- 家族グループ凍結チェック
      IF v_assignment IS NOT NULL THEN
        SELECT * INTO v_family_group
          FROM family_groups
          WHERE source_org_assignment_id = v_assignment.id
            AND status = 'active';

        IF FOUND THEN
          -- 凍結 (grace period は organizations.settings.freeze_grace_days で設定可能)
          UPDATE family_groups
            SET status = 'frozen',
                frozen_at = NOW(),
                freeze_grace_until = NOW() + INTERVAL '30 days'
            WHERE id = v_family_group.id;

          -- 通知 (Edge Function に委譲)
          PERFORM pg_notify(
            'family_group_frozen',
            json_build_object(
              'family_group_id', v_family_group.id,
              'owner_id', v_family_group.owner_id,
              'freeze_grace_until', (NOW() + INTERVAL '30 days')
            )::TEXT
          );
        END IF;
      END IF;

      -- 完了
      UPDATE hr_revoke_jobs
        SET status = 'done', completed_at = NOW()
        WHERE id = v_job.id;

    EXCEPTION WHEN OTHERS THEN
      -- exponential backoff (2^attempts * 60 秒)
      UPDATE hr_revoke_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
            last_error = SQLERRM,
            next_attempt_at = NOW() + (POWER(2, attempts) * INTERVAL '60 seconds')
        WHERE id = v_job.id;
    END;
  END LOOP;
END;
$$;
```

### 5.3 Exponential Backoff

| attempts | 次回実行までの待機 |
|---------|----------------|
| 1 | 2 分 |
| 2 | 4 分 |
| 3 | 8 分 |
| 4 | 16 分 |
| 5 (最終) | dead_letter 遷移 |

`dead_letter` になったジョブは Sentry アラート + org_admin へ通知。

## 6. 家族グループ凍結 (status = 'frozen')

### 6.1 凍結後の制限

| 機能 | 凍結中 |
|------|--------|
| 食事記録の新規作成・AI 解析 | **不可** |
| 既存データ閲覧 | 可 |
| 家族メンバー招待 | **不可** |
| 共有買い物リスト閲覧 | 可 |
| チャレンジ参加 | **不可** |

### 6.2 凍結時の通知

**退職者本人への通知**:
```
件名: 【ほめゴハン】家族グループが一時凍結されました

{org_name} を退職されたため、家族グループ「{family_group_name}」が一時凍結されました。
30 日以内 ({grace_until} まで) に以下から選択してください:

1. 個人プランへ移行 → {migrate_url}
   (Family Basic 1,480 円/月 または Family Pro 2,480 円/月)

2. オーナー権限を譲渡 → {transfer_url}
   (グループ内の他のメンバーへ)

3. グループを解散 → {dissolve_url}
   (データは 90 日後に削除)

ご不明な点はサポートまでお問い合わせください。
```

**家族メンバーへの通知**:
```
件名: 【ほめゴハン】家族グループが一時凍結中です

{owner_name} さんの事情により、家族グループ「{family_group_name}」が凍結中です。
現在は既存データの閲覧のみ可能です。

{grace_until} までにオーナーから対応予定です。
```

## 7. 退職者の選択肢 API

### 7.1 `POST /api/family/groups/{id}/migrate-to-personal`

**楽観的ロック**:
```
POST /api/family/groups/{id}/migrate-to-personal
If-Unmodified-Since: 2026-05-07T12:34:56Z   # 直前 GET の updated_at
```

**処理**:
```typescript
async function migrateToPersonal(groupId: string, actorId: string, ifUnmodifiedSince: string) {
  // 1. advisory lock (同一 family_group への並行操作を直列化)
  await supabase.rpc('advisory_lock_family_group', { family_group_id: groupId });

  // 2. 最新状態取得
  const { data: group } = await supabase
    .from('family_groups')
    .select('id, status, updated_at, owner_id, source_org_assignment_id')
    .eq('id', groupId)
    .single();

  // 3. 楽観的ロック確認
  if (new Date(group.updated_at) > new Date(ifUnmodifiedSince)) {
    return Response.json(
      { error: 'PRECONDITION_FAILED', current_updated_at: group.updated_at },
      { status: 412 }
    );
  }

  // 4. 事前条件確認
  if (group.status !== 'frozen') {
    return Response.json({ error: 'ORG_OFFBOARD_INVALID_STATUS' }, { status: 409 });
  }
  if (group.owner_id !== actorId) {
    return Response.json({ error: 'ORG_PERMISSION_DENIED' }, { status: 403 });
  }

  // 5. 個人プラン Stripe Checkout 起動
  const checkoutUrl = await createPersonalPlanCheckout(actorId, groupId);

  // Stripe 決済完了 webhook で以下を実行:
  // UPDATE family_groups SET status='active', source_org_assignment_id=NULL
  // INSERT personal_subscriptions (family_basic or family_pro)

  return Response.json({ checkout_url: checkoutUrl });
}
```

### 7.2 `POST /api/family/groups/{id}/transfer-ownership`

**追加制約**: 譲渡先は同グループの `family_members.role = 'admin'` のみ

```typescript
// 譲渡先が個人プランで課金済みの場合 → 即時譲渡
// 課金未済の場合 → Stripe Checkout 後に譲渡完了
```

### 7.3 `POST /api/family/groups/{id}/dissolve`

- パスワード再認証必須
- `status = 'dissolved'`
- さらに 90 日後に物理削除 (pg_cron)

### 7.4 advisory lock の実装

```sql
-- pg_advisory_xact_lock: トランザクション終了で自動解放
-- 同一 family_id への並行 UPDATE を直列化
CREATE OR REPLACE FUNCTION advisory_lock_family_group(p_family_group_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('family-group:' || p_family_group_id::TEXT));
END;
$$;
```

## 8. Grace Period 期限経過後のバッチ処理

```sql
-- pg_cron 日次 (UTC 03:00)
SELECT cron.schedule(
  'family_freeze_grace_expire',
  '0 3 * * *',
  $$SELECT process_family_archive_purge()$$
);

CREATE OR REPLACE FUNCTION process_family_archive_purge()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- grace_until 経過した凍結グループを archived に遷移
  UPDATE family_groups
    SET status = 'archived',
        archived_at = NOW()
    WHERE status = 'frozen'
      AND freeze_grace_until < NOW();

  -- owner の個人プラン確認 → カード登録済なら auto-migrate
  -- カード未登録 → Free に降格 (機能制限)
  -- 通知を送信 (pg_notify → Edge Function)
END;
$$;
```

90 日後の物理削除:
```sql
-- 別の日次バッチで archived から 90 日経過したグループを削除
DELETE FROM family_groups
  WHERE status = 'archived'
    AND archived_at < NOW() - INTERVAL '90 days';
```

## 9. 状態遷移図

```mermaid
stateDiagram-v2
  [*] --> active: 家族グループ作成
  active --> frozen: org_license 回収 (HR Webhook / 手動)
  frozen --> active: migrate-to-personal 完了
  frozen --> active: transfer-ownership 完了 (新オーナーが課金)
  frozen --> dissolved: dissolve API
  frozen --> archived: freeze_grace_until 経過 (バッチ)
  archived --> [*]: 90 日後物理削除
  dissolved --> [*]: 90 日後物理削除
```

## 10. エラーハンドリング

| 状況 | 処理 |
|------|------|
| HR Webhook の user_id 解決失敗 | `hr_revoke_jobs.status='failed'`、exponential backoff |
| 5 回失敗 | `dead_letter`、Sentry アラート、org_admin 通知 |
| advisory lock タイムアウト | 503 を返してクライアントにリトライさせる (デフォルト 30s) |
| `If-Unmodified-Since` 不一致 | 412 Precondition Failed + 最新 `updated_at` を返却 |
| grace period 内に複数 API を同時呼び出し | advisory lock で 1 つだけ成功、残りは 409 |

## 11. テスト方針

- **Integration**:
  - HR Webhook 冪等テスト: 同一 external_id を 2 回 POST → 2 回目は 200 (idempotent)
  - pg_cron worker テスト: `hr_revoke_jobs` に pending ジョブを INSERT → `process_hr_revoke_jobs()` 実行 → `org_license_assignments.revoked_at` が設定されること
  - 家族グループ凍結テスト: assignment revoke → family_groups.status='frozen' を確認
  - advisory lock テスト: 2 並行 POST /migrate-to-personal → 1 つ成功 / 1 つ 412
- **E2E**:
  - Playwright: HR Webhook 受信 → 30 日猶予 → migrate-to-personal 完了 → family_group active 復帰

## 12. 既存実装との関連

- `hr_webhook_events`, `hr_revoke_jobs`: 新規作成
- `family_groups.status`, `frozen_at`, `freeze_grace_until`: family ドメインで定義される列を参照
- `org_license_assignments.revoked_at`: org ドメインの主要な状態変更点

## 13. 未解決事項

- HR Webhook の HMAC 検証形式: ベンダーによって異なるため、Enterprise 個別対応
- `freeze_grace_days` の組織カスタマイズ: `organizations.settings.freeze_grace_days` で設定可能だが、デフォルト 30 日を変更できる範囲 (7〜90 日) の UI 設計が必要
- pg_notify → Edge Function の通知送信: Supabase Realtime channel 経由か、Edge Function を直接呼ぶか
