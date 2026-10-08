import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/db-logger';

/**
 * #1022 AIエンドポイントのユーザー単位レートリミット共通ヘルパー
 * #1163 招待メール・参加リクエストなど「ユーザー操作で外部へメールが出る API」の送信回数制限にも使う
 *
 * src/app/api/contact/route.ts の Upstash Ratelimit 実装を汎用化し、
 * `key` + カテゴリ単位でレート制限を判定する。
 * `key` は呼び出し側が決める不透明な文字列で、ユーザー ID のほか、組織 ID や
 * 「送信先メールアドレスのハッシュ」などを渡す (招待メールの制限は invite-throttle.ts 経由)。
 *
 * 【key の信頼性】
 * リクエストの body / URL に載っていて未検証の ID (family_id, member_id など) を key にしてはならない。
 * 他テナントの ID を指定するだけで、その枠を使い切らせることができてしまうため。
 * key にするのは、認証で確定した user.id か、プロフィールなどサーバー側で検証済みの ID だけ。
 *
 * 【本番運用について】
 * 本番環境では UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN の設定が必須。
 * 未設定の場合は in-memory フォールバックで動作するが、これは単一サーバーレス
 * インスタンス内でのみ有効なベストエフォートの防御であり、Vercel のような
 * マルチインスタンス環境では実質的にレート制限として機能しない（インスタンスが
 * 分かれるたびにカウンタがリセットされるため）。特に日次上限 (24h) はインスタンスの
 * 入れ替わりで簡単にリセットされるので、Upstash 未設定のままでは「日次上限」は成り立たない。
 * fail-open（無制限に通す）はセキュリティ上避けるべきなので、env 未設定時も in-memory
 * フォールバックで最低限の制限をかけつつ warn ログを出す。
 */

export type RateLimitCategory =
  | 'generation'
  | 'analysis'
  | 'image'
  | 'family-invite'
  | 'org-invite'
  | 'org-invite-scope'
  | 'child-promotion'
  | 'invite-target'
  | 'transfer-propose'
  | 'export';

/** 1 つの制限ルール。name は Upstash の prefix / in-memory の名前空間に使う (既存キーを変えないこと) */
interface RateRule {
  name: string;
  max: number;
  windowSec: number;
}

const MINUTE_SEC = 60;
// 「日次」は暦日（0時リセット）ではなく、直近24時間のローリングウィンドウで判定する
// （sliding window / in-memory どちらの実装も「初回リクエスト時刻 + 24h」を基準にするため）。
const DAY_SEC = 24 * 60 * 60;

// カテゴリ別ルール。先頭から順に判定し、どれか 1 つでも超過していれば失敗として打ち切る。
//
// 【AI 系 (#1022 spec 準拠)】
// - generation: 献立生成系（menu v4/v5 generate, day/meal generate・regenerate,
//   weekly/request, consultation のアクション実行・チャット送信・要約生成 等）
// - analysis: 画像解析・軽量AI呼び出し系（analyze-fridge/meal-photo/health-checkup/
//   weight-scale, classify-photo, hint, nutrition analysis/feedback 等）
// - image: 画像生成（最も高コスト）。分あたりに加えて日次クォータも課す
//
// 【招待メール系 (#1163)】 key の渡し方は src/lib/membership/invite-throttle.ts を参照
// - family-invite: 家族の招待メール (key = 招待者の user.id)
// - org-invite: 組織の招待メール (key = 招待者の user.id)
// - org-invite-scope: 組織ごとの日次上限。管理者が複数いても組織全体で送れる量を抑える (key = プロフィールの organization_id)
// - child-promotion: 子供メンバーの昇格(参加リクエスト)メール (key = 依頼者の user.id)
// - invite-target: 同じ宛先への連続送信 (key = `${flow}:${scopeId}:${宛先メールのハッシュ}`)
// - transfer-propose: 代表者・オーナー譲渡の提案メール (key = 提案者の user.id)
//
// 【その他】
// - export: 個人データエクスポート（#1131。AI は使わないが全テーブルを走査する重い読み取り）。
//   正当な再実行（失敗後のやり直し等）は妨げず、連打による DB 負荷だけ防ぐ。10 分あたり 5 回
const CATEGORY_RULES: Record<RateLimitCategory, readonly RateRule[]> = {
  generation: [{ name: 'generation', max: 5, windowSec: MINUTE_SEC }],
  analysis: [{ name: 'analysis', max: 10, windowSec: MINUTE_SEC }],
  image: [
    { name: 'image', max: 1, windowSec: MINUTE_SEC },
    { name: 'image-daily', max: 20, windowSec: DAY_SEC },
  ],
  // 家族の人数上限は DB の CHECK で最大 20 人。日次 20 通は、実在する家族が 1 日に送る数
  // (再送を含めても数通) を十分に上回る値
  'family-invite': [
    { name: 'family-invite', max: 5, windowSec: MINUTE_SEC },
    { name: 'family-invite-daily', max: 20, windowSec: DAY_SEC },
  ],
  'org-invite': [
    { name: 'org-invite', max: 10, windowSec: MINUTE_SEC },
    { name: 'org-invite-daily', max: 200, windowSec: DAY_SEC },
  ],
  'org-invite-scope': [{ name: 'org-invite-scope-daily', max: 500, windowSec: DAY_SEC }],
  'child-promotion': [
    { name: 'child-promotion', max: 5, windowSec: MINUTE_SEC },
    { name: 'child-promotion-daily', max: 10, windowSec: DAY_SEC },
  ],
  // ダブルクリック + 再送 1 回で 3 になるので、3 より小さくしない
  'invite-target': [{ name: 'invite-target-daily', max: 3, windowSec: DAY_SEC }],
  'transfer-propose': [
    { name: 'transfer-propose', max: 3, windowSec: MINUTE_SEC },
    { name: 'transfer-propose-daily', max: 10, windowSec: DAY_SEC },
  ],
  export: [{ name: 'export', max: 5, windowSec: 10 * MINUTE_SEC }],
};

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** epoch ms。この時刻以降に制限がリセットされる目安 */
  reset: number;
  /**
   * この結果を出したルールのウィンドウ秒数 (失敗時は超過したルール)。
   * 分あたり (60) と日次 (86400) で呼び出し側が文言を出し分けるために使う。
   */
  windowSec?: number;
}

const logger = createLogger('rate-limit');

function getRedisClient(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  try {
    return new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch (err) {
    logger.warn(
      '[rate-limit] Upstash Redis クライアント初期化に失敗しました。in-memory フォールバックを使用します。',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

const redisClient = getRedisClient();

if (!redisClient) {
  logger.warn(
    '[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が未設定です。' +
      'AIエンドポイントや招待メールのレート制限は in-memory フォールバックで動作します（サーバーレス' +
      '環境ではインスタンスごとに独立するため実効性が下がります。特に日次上限は成り立ちません）。' +
      '本番環境では必ず Upstash Redis の env を設定してください。',
  );
}

const upstashLimiters = new Map<string, Ratelimit>();

function getUpstashLimiter(rule: RateRule): Ratelimit | null {
  if (!redisClient) return null;
  const cacheKey = `${rule.name}:${rule.max}:${rule.windowSec}`;
  let limiter = upstashLimiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(rule.max, `${rule.windowSec} s`),
      prefix: `homegohan:ai-rl:${rule.name}`,
    });
    upstashLimiters.set(cacheKey, limiter);
  }
  return limiter;
}

// in-memory フォールバック用ストア（`${ルール名}:${key}` -> カウンタ）
const inMemoryStore = new Map<string, { count: number; resetAt: number }>();

// 招待メールの宛先ハッシュのように key が高カーディナリティになるため、期限切れのエントリを掃除する。
// 件数がしきい値を超えたときだけ走査し、全件が有効なまま超過している場合に毎回走査しないよう
// 最短の掃除間隔も設ける。
const IN_MEMORY_SWEEP_THRESHOLD = 10_000;
const IN_MEMORY_SWEEP_MIN_INTERVAL_MS = 60_000;
let lastInMemorySweepAt = 0;

function sweepExpiredInMemoryEntries(now: number): void {
  if (inMemoryStore.size <= IN_MEMORY_SWEEP_THRESHOLD) return;
  if (now - lastInMemorySweepAt < IN_MEMORY_SWEEP_MIN_INTERVAL_MS) return;
  lastInMemorySweepAt = now;
  for (const [storeKey, entry] of inMemoryStore) {
    if (now > entry.resetAt) inMemoryStore.delete(storeKey);
  }
}

/** in-memory ストアの件数 (掃除のテストと監視用) */
export function getInMemoryStoreSize(): number {
  return inMemoryStore.size;
}

function checkInMemory(rule: RateRule, key: string): RateLimitResult {
  const now = Date.now();
  const windowMs = rule.windowSec * 1000;
  const storeKey = `${rule.name}:${key}`;
  const entry = inMemoryStore.get(storeKey);

  if (!entry || now > entry.resetAt) {
    sweepExpiredInMemoryEntries(now);
    inMemoryStore.set(storeKey, { count: 1, resetAt: now + windowMs });
    return {
      success: true,
      limit: rule.max,
      remaining: rule.max - 1,
      reset: now + windowMs,
      windowSec: rule.windowSec,
    };
  }

  if (entry.count >= rule.max) {
    return { success: false, limit: rule.max, remaining: 0, reset: entry.resetAt, windowSec: rule.windowSec };
  }

  entry.count += 1;
  return {
    success: true,
    limit: rule.max,
    remaining: rule.max - entry.count,
    reset: entry.resetAt,
    windowSec: rule.windowSec,
  };
}

async function checkSingleLimit(rule: RateRule, key: string): Promise<RateLimitResult> {
  const limiter = getUpstashLimiter(rule);
  if (limiter) {
    // 【意図的な設計判断: fail-close】
    // ここで `limiter.limit(key)` が例外を投げた場合（Upstash env は設定済みだが実行時に
    // Redis へ到達できない等）、あえて try/catch で握りつぶさず呼び出し元まで例外を伝播させる。
    // 呼び出し元の route は既存の catch ブロック（またはフレームワークの実行時エラー処理）で
    // 500 を返すため、結果的に「判定不能なら拒否する」fail-close になる。
    // fail-open（例外時は success: true 扱いにする）は #1022 のセキュリティ目的に反するため禁止。
    const result = await limiter.limit(key);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      windowSec: rule.windowSec,
    };
  }
  return checkInMemory(rule, key);
}

/**
 * key に対してカテゴリ別レートリミットを判定する。
 *
 * カテゴリに複数のルール（分あたり + 日次など）がある場合は定義順に判定し、
 * いずれか一方でも超過していれば、その時点で打ち切って超過したルールの結果 (success=false) を返す。
 * すべて通った場合は先頭ルールの結果を返す。
 *
 * 呼び出し側は認証（user 確定）直後、他の処理を行う前に呼び出すこと。
 * key にはサーバー側で検証済みの ID だけを渡す（ファイル先頭の「key の信頼性」を参照）。
 */
export async function checkRateLimit(
  key: string,
  category: RateLimitCategory,
): Promise<RateLimitResult> {
  const rules = CATEGORY_RULES[category];
  let firstResult: RateLimitResult | null = null;

  for (const rule of rules) {
    const result = await checkSingleLimit(rule, key);
    if (!result.success) {
      return result;
    }
    firstResult ??= result;
  }

  // rules は常に 1 件以上ある (CATEGORY_RULES の定義による)
  return firstResult as RateLimitResult;
}

/** 超過時に何秒後に再試行できるか (Retry-After ヘッダー / retryAfter の値) */
export function getRetryAfterSec(result: RateLimitResult): number {
  return Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
}

/**
 * レートリミット超過時の 429 レスポンスを生成する。
 * src/app/api/contact/route.ts の 429 応答形式に合わせる。
 * (membership 系 API は UI が error.message を読むため、別形式のネスト本文を
 *  src/lib/membership/invite-throttle.ts の inviteThrottleResponse で返す)
 */
export function rateLimitExceededResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = getRetryAfterSec(result);
  return NextResponse.json(
    {
      error: 'リクエストが多すぎます。しばらく時間をおいてからお試しください。',
      code: 'RATE_LIMITED',
      retryAfter: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}
