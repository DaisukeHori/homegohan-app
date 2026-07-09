import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/db-logger';

/**
 * #1022 AIエンドポイントのユーザー単位レートリミット共通ヘルパー
 *
 * src/app/api/contact/route.ts の Upstash Ratelimit 実装を汎用化し、
 * `userId` + カテゴリ単位でレート制限を判定する。
 *
 * 【本番運用について】
 * 本番環境では UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN の設定が必須。
 * 未設定の場合は in-memory フォールバックで動作するが、これは単一サーバーレス
 * インスタンス内でのみ有効なベストエフォートの防御であり、Vercel のような
 * マルチインスタンス環境では実質的にレート制限として機能しない（インスタンスが
 * 分かれるたびにカウンタがリセットされるため）。fail-open（無制限に通す）は
 * セキュリティ上避けるべきなので、env 未設定時も in-memory フォールバックで
 * 最低限の制限をかけつつ warn ログを出す。
 */

export type RateLimitCategory = 'generation' | 'analysis' | 'image';

interface CategoryPreset {
  max: number;
  windowSec: number;
}

// カテゴリ別プリセット（#1022 spec 準拠）
// - generation: 献立生成系（menu v4/v5 generate, day/meal generate・regenerate,
//   weekly/request, consultation のアクション実行・チャット送信・要約生成 等）
// - analysis: 画像解析・軽量AI呼び出し系（analyze-fridge/meal-photo/health-checkup/
//   weight-scale, classify-photo, hint, nutrition analysis/feedback 等）
// - image: 画像生成（最も高コスト）。分あたりに加えて日次クォータも課す
const CATEGORY_PRESETS: Record<RateLimitCategory, CategoryPreset> = {
  generation: { max: 5, windowSec: 60 },
  analysis: { max: 10, windowSec: 60 },
  image: { max: 1, windowSec: 60 },
};

// image カテゴリのみ、分あたり制限に加えて日次クォータを追加で課す
const IMAGE_DAILY_QUOTA: CategoryPreset = { max: 20, windowSec: 24 * 60 * 60 };

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** epoch ms。この時刻以降に制限がリセットされる目安 */
  reset: number;
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
      'AIエンドポイントのレート制限は in-memory フォールバックで動作します（サーバーレス' +
      '環境ではインスタンスごとに独立するため実効性が下がります）。本番環境では必ず ' +
      'Upstash Redis の env を設定してください。',
  );
}

const upstashLimiters = new Map<string, Ratelimit>();

function getUpstashLimiter(category: string, preset: CategoryPreset): Ratelimit | null {
  if (!redisClient) return null;
  const cacheKey = `${category}:${preset.max}:${preset.windowSec}`;
  let limiter = upstashLimiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(preset.max, `${preset.windowSec} s`),
      prefix: `homegohan:ai-rl:${category}`,
    });
    upstashLimiters.set(cacheKey, limiter);
  }
  return limiter;
}

// in-memory フォールバック用ストア（key -> カウンタ）
const inMemoryStore = new Map<string, { count: number; resetAt: number }>();

function checkInMemory(key: string, preset: CategoryPreset): RateLimitResult {
  const now = Date.now();
  const windowMs = preset.windowSec * 1000;
  const entry = inMemoryStore.get(key);

  if (!entry || now > entry.resetAt) {
    inMemoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, limit: preset.max, remaining: preset.max - 1, reset: now + windowMs };
  }

  if (entry.count >= preset.max) {
    return { success: false, limit: preset.max, remaining: 0, reset: entry.resetAt };
  }

  entry.count += 1;
  return {
    success: true,
    limit: preset.max,
    remaining: preset.max - entry.count,
    reset: entry.resetAt,
  };
}

async function checkSingleLimit(
  category: string,
  key: string,
  preset: CategoryPreset,
): Promise<RateLimitResult> {
  const limiter = getUpstashLimiter(category, preset);
  if (limiter) {
    const result = await limiter.limit(key);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  }
  return checkInMemory(`${category}:${key}`, preset);
}

/**
 * 認証済みユーザーに対してカテゴリ別レートリミットを判定する。
 *
 * `image` カテゴリは分あたりの上限に加えて日次クォータも判定し、
 * いずれか一方でも超過していれば success=false を返す。
 *
 * 呼び出し側は認証（user 確定）直後、他の処理を行う前に呼び出すこと。
 */
export async function checkRateLimit(
  userId: string,
  category: RateLimitCategory,
): Promise<RateLimitResult> {
  const preset = CATEGORY_PRESETS[category];
  const minuteResult = await checkSingleLimit(category, userId, preset);

  if (!minuteResult.success) {
    return minuteResult;
  }

  if (category === 'image') {
    const dayResult = await checkSingleLimit('image-daily', userId, IMAGE_DAILY_QUOTA);
    if (!dayResult.success) {
      return dayResult;
    }
  }

  return minuteResult;
}

/**
 * レートリミット超過時の 429 レスポンスを生成する。
 * src/app/api/contact/route.ts の 429 応答形式に合わせる。
 */
export function rateLimitExceededResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
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
