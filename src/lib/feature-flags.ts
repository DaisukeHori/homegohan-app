/**
 * 機能フラグの判定 (#1148)
 *
 * 機能の ON/OFF は、feature_flags テーブル (運営画面 /super-admin/flags で切り替える) を唯一の置き場にする。
 * 判定は isFeatureEnabled(key, userId?) を使う。system_settings に新しいフラグを足したり、
 * route ごとに feature_flags を自分で読んだりしない (以前は system_settings の feature_flags を各 route が
 * 読んでいた。ログイン中のユーザー自身の権限で読んでいたため、admin / super_admin 以外には値が届かなかった)。
 *
 * 今アプリが読んでいるフラグ (FEATURE_FLAG_DEFAULTS):
 *   menu_generation_v5_wrapped  献立生成 (週間・1 日・1 食・AI 相談のアクション) のエンジン。ON で v5、OFF で v4
 *   menu_generation_v5_direct   汎用の献立生成 API (/api/ai/menu/v4/generate) のエンジン。ON で v5、OFF で v4
 *   ai_chat_enabled             AI 相談の緊急停止スイッチ。OFF のとき AI 相談の API は 503 を返す。通常は ON のまま
 *   maintenance_mode            ON のとき、ミドルウェアが運営 (admin / super_admin) 以外にメンテナンス中の画面を出す
 *
 * 【止めない側に倒す (fail-open)】
 * フラグの行が無い・読み出しに失敗した・読み出しが待ち時間の上限を超えたときは、FEATURE_FLAG_DEFAULTS の値で答える。
 * ai_chat_enabled は ON、maintenance_mode は OFF、menu_generation_v5_* は ON。つまり、フラグの仕組みの不調では、
 * AI への送信もサイトも止まらない。止めるのは、運営が feature_flags の行を明示的に切り替えたときだけ。
 * 読み出しの失敗は構造化ログ (src/lib/db-logger.ts) に残す。isFeatureEnabled は例外を投げない。
 *
 * 【メモリのキャッシュ】
 * フラグの行はサーバーのメモリに FEATURE_FLAG_CACHE_TTL_MS (30 秒) 覚える。ミドルウェアは全リクエストで呼ぶため、
 * 毎回 DB を読まないようにするのが目的。運営画面で切り替えたとき、全インスタンスに反映されるまで最大 30 秒かかる
 * (切り替えを受けたインスタンスは invalidateFeatureFlag で即座に反映する)。
 * 同じ key の読み出しが重なったときは 1 回にまとめる。読めなかったときは FEATURE_FLAG_FAILURE_RETRY_MS (10 秒) は
 * 読み直さず、既定値で答える (障害中に毎回読みに行って、リクエストを遅くしない)。
 *
 * 【ユーザーの属性】
 * フラグに plan / role / org の段階公開や条件 (constraints) があるときだけ、判定にユーザーの属性が要る。
 * options.context で渡した項目はそのまま使い、足りない項目は userId で user_profiles から 1 回読む
 * (userId は認証で確定した ID を渡すこと。読むのはその 1 行だけ)。userId が無い (未ログイン) のに属性が要るときは、
 * 判定できないので既定値で答える。
 */
import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  evaluateFlag,
  fetchFlagRecord,
  type FeatureFlagRecord,
  type UserFlagContext,
} from '@/lib/super-admin/evaluate-flag';

/**
 * アプリが読んでいるフラグと、行が無い・読めないときの値。
 * ここに無い key (運営画面で新しく作ったフラグなど) は、行が無い・読めないとき OFF として扱う。
 */
export const FEATURE_FLAG_DEFAULTS = {
  ai_chat_enabled: true,
  maintenance_mode: false,
  menu_generation_v5_wrapped: true,
  menu_generation_v5_direct: true,
} as const;

export type KnownFeatureFlagKey = keyof typeof FEATURE_FLAG_DEFAULTS;

/**
 * GET /api/feature-flags がクライアント (Web・モバイル) に返すフラグ。
 * クライアントが実際に使うものだけを許可リストで列挙する (運営が作った別のフラグの名前を一般ユーザーに見せない)。
 * クライアントがフラグを使い始めるときは、ここにも足す。
 */
export const CLIENT_FEATURE_FLAG_KEYS = ['ai_chat_enabled', 'maintenance_mode'] as const satisfies readonly KnownFeatureFlagKey[];

/** フラグの行をメモリに覚える時間 (ms)。運営画面で切り替えてから全員に反映されるまでの、最大の遅れ */
export const FEATURE_FLAG_CACHE_TTL_MS = 30_000;
/** 読み出しに失敗した (待ちきれなかった) あと、次に読み直すまでの間隔 (ms) */
export const FEATURE_FLAG_FAILURE_RETRY_MS = 10_000;
/** 読み出しを待つ上限 (ms)。超えたら既定値で答える */
export const FEATURE_FLAG_READ_TIMEOUT_MS = 1_500;
/**
 * 1 回の読み出しそのものを諦める時間 (ms)。待つ側の上限 (上の値) を超えても読み出しは続けて、遅れて返った値を
 * キャッシュに入れる。ただし、永遠に返ってこない読み出しが「読み出し中」として残り続けると、DB が戻っても
 * 読み直せなくなるため、この時間で打ち切る
 */
const FEATURE_FLAG_READ_HARD_LIMIT_MS = 10_000;
/** 覚えておく key の上限。定義済みの key は数個なので、超えるのは想定外 (key を動的に作る呼び出しがあったとき)。超えたら全部忘れる */
const MAX_CACHE_ENTRIES = 200;

/** 判定に使うユーザーの属性 (userId 以外)。渡した項目は DB から読み直さない */
export type FeatureFlagContext = Partial<Omit<UserFlagContext, 'userId'>>;

export interface IsFeatureEnabledOptions {
  /** 呼び出し側がすでに持っているユーザーの属性 (ミドルウェアは roles を持っている) */
  context?: FeatureFlagContext;
  /** 読み出しを待つ上限 (ms)。省略すると FEATURE_FLAG_READ_TIMEOUT_MS。ミドルウェアは短くする */
  timeoutMs?: number;
}

interface FlagReadResult {
  /** 読めた行。行が無いとき・読めなかったときは null */
  record: FeatureFlagRecord | null;
  /** 読み出しに失敗した (または待ちきれなかった)。このとき record は null */
  failed: boolean;
  /** この時刻 (epoch ms) までは読み直さない */
  expiresAt: number;
}

const logger = createLogger('feature-flags');

const resultCache = new Map<string, FlagReadResult>();
/** 読み出し中のもの。同じ key の読み出しを 1 回にまとめる */
const inflightReads = new Map<string, Promise<FlagReadResult>>();
/** 「行が無い」警告を出した key。同じ警告をキャッシュの期限ごとに繰り返さない */
const missingRowLogged = new Set<string>();

/** ログの失敗で判定を止めない (判定は止めない側に倒す) */
function logSafely(write: () => void): void {
  try {
    write();
  } catch {
    // ログが書けなくても、判定の結果は変えない
  }
}

/** 行が無い・読めないときの値。FEATURE_FLAG_DEFAULTS に無い key は OFF */
function defaultFor(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAG_DEFAULTS, key)
    ? FEATURE_FLAG_DEFAULTS[key as KnownFeatureFlagKey]
    : false;
}

function remember(key: string, value: Pick<FlagReadResult, 'record' | 'failed'>, ttlMs: number): FlagReadResult {
  if (resultCache.size >= MAX_CACHE_ENTRIES && !resultCache.has(key)) {
    resultCache.clear();
  }
  const result: FlagReadResult = { ...value, expiresAt: Date.now() + ttlMs };
  resultCache.set(key, result);
  return result;
}

/** DB を読む。決して reject しない (失敗は failed: true の結果にして、ログに残す) */
function startRead(key: string): Promise<FlagReadResult> {
  const read = (async (): Promise<FlagReadResult> => {
    try {
      const record = await withTimeout(
        fetchFlagRecord(key),
        FEATURE_FLAG_READ_HARD_LIMIT_MS,
        `feature_flags の読み出しが ${FEATURE_FLAG_READ_HARD_LIMIT_MS}ms を超えました`,
      );
      if (record === null && !missingRowLogged.has(key)) {
        missingRowLogged.add(key);
        logSafely(() =>
          logger.warn('feature_flags に行がありません。既定値で動作します', { key, fallback: defaultFor(key) }),
        );
      }
      return remember(key, { record, failed: false }, FEATURE_FLAG_CACHE_TTL_MS);
    } catch (error) {
      logSafely(() =>
        logger.error('機能フラグの読み出しに失敗しました。既定値で動作を続けます', error, {
          key,
          reason: 'read_error',
          fallback: defaultFor(key),
        }),
      );
      return remember(key, { record: null, failed: true }, FEATURE_FLAG_FAILURE_RETRY_MS);
    }
  })();

  inflightReads.set(key, read);
  void read.finally(() => {
    if (inflightReads.get(key) === read) inflightReads.delete(key);
  });
  return read;
}

/** 読み出しの結果を待つ。timeoutMs を超えたら、既定値に倒す結果を返す (遅れて返った本物の結果は、あとでキャッシュに入る) */
function waitForRead(key: string, read: Promise<FlagReadResult>, timeoutMs: number): Promise<FlagReadResult> {
  return new Promise<FlagReadResult>((resolve) => {
    const timer = setTimeout(() => {
      logSafely(() =>
        logger.error(
          '機能フラグの読み出しが時間内に終わりませんでした。既定値で動作を続けます',
          new Error(`feature_flags の読み出しが ${timeoutMs}ms を超えました`),
          { key, reason: 'timeout', timeoutMs, fallback: defaultFor(key) },
        ),
      );
      resolve(remember(key, { record: null, failed: true }, FEATURE_FLAG_FAILURE_RETRY_MS));
    }, timeoutMs);
    void read.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function readFlag(key: string, timeoutMs: number): Promise<FlagReadResult> {
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const read = inflightReads.get(key) ?? startRead(key);
  return waitForRead(key, read, timeoutMs);
}

type ContextField = keyof FeatureFlagContext;

/** このフラグの判定に、ユーザーのどの属性が要るか (evaluateFlag が見る項目) */
function requiredContextFields(record: FeatureFlagRecord): ContextField[] {
  const fields = new Set<ContextField>();

  const constraints = record.constraints;
  if (constraints) {
    if (typeof constraints.min_user_age_days === 'number') fields.add('accountCreatedAt');
    if ((constraints.exclude_plans?.length ?? 0) > 0 || (constraints.include_plans?.length ?? 0) > 0) fields.add('planKey');
    if ((constraints.include_roles?.length ?? 0) > 0) fields.add('roles');
    if ((constraints.include_org_ids?.length ?? 0) > 0) fields.add('organizationId');
  }

  switch (record.rollout_strategy?.type) {
    case 'plan':
      fields.add('planKey');
      break;
    case 'role':
      fields.add('roles');
      break;
    case 'org':
      fields.add('organizationId');
      break;
    default:
      break;
  }

  return [...fields];
}

/** userId 本人の属性を user_profiles から読む (その 1 行だけ。userId は認証で確定した ID であること) */
async function loadUserContext(userId: string): Promise<FeatureFlagContext> {
  const { data, error } = await getSupabaseAdmin()
    .from('user_profiles')
    .select('roles, organization_id, plan_key_cached, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`user_profiles の読み出しに失敗しました: ${error.message} (code: ${error.code ?? 'unknown'})`);
  }

  return {
    roles: Array.isArray(data?.roles) ? (data.roles as string[]) : [],
    organizationId: data?.organization_id ?? null,
    // plan_key_cached が空のユーザーは無料プランとして扱う (src/app/api/admin/users の一覧と同じ)
    planKey: data?.plan_key_cached ?? 'free',
    accountCreatedAt: data?.created_at ?? null,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** undefined の項目を除く (呼び出し側が持っていない項目で、読み込んだ値を上書きしない) */
function definedOnly(context: FeatureFlagContext | undefined): FeatureFlagContext {
  const result: FeatureFlagContext = {};
  if (!context) return result;
  for (const field of Object.keys(context) as ContextField[]) {
    if (context[field] !== undefined) (result as Record<string, unknown>)[field] = context[field];
  }
  return result;
}

/**
 * key のフラグが、このユーザーにとって ON かどうか。
 *
 * - 行が無い・読めない・待ちきれないときは、FEATURE_FLAG_DEFAULTS の値 (定義に無い key は false)。例外は投げない。
 * - 行があるときは evaluateFlag (enabled / rollout_strategy / constraints) の判定。
 * - userId は認証で確定したユーザー ID。未ログインなら省略する (全員一律の ON/OFF のフラグは、それで判定できる)。
 */
export async function isFeatureEnabled(
  key: string,
  userId?: string,
  options: IsFeatureEnabledOptions = {},
): Promise<boolean> {
  const fallback = defaultFor(key);

  try {
    const timeoutMs = options.timeoutMs ?? FEATURE_FLAG_READ_TIMEOUT_MS;
    const read = await readFlag(key, timeoutMs);
    if (read.failed || read.record === null) return fallback;

    const record = read.record;
    const provided = definedOnly(options.context);
    let context: UserFlagContext = { ...provided, userId: userId ?? '' };

    const missingFields = requiredContextFields(record).filter((field) => provided[field] === undefined);
    if (missingFields.length > 0) {
      // 属性が要るのに、ユーザーが分からない (未ログイン) なら判定できない。止めない側に倒す
      if (!userId) return fallback;
      const loaded = await withTimeout(
        loadUserContext(userId),
        timeoutMs,
        `ユーザーの属性の読み出しが ${timeoutMs}ms を超えました`,
      );
      context = { ...loaded, ...provided, userId };
    }

    return evaluateFlag(record, context);
  } catch (error) {
    logSafely(() =>
      logger.error('機能フラグの判定に失敗しました。既定値で動作を続けます', error, {
        key,
        reason: 'evaluate_error',
        fallback,
      }),
    );
    return fallback;
  }
}

/**
 * key の覚えているフラグを忘れる。運営画面の API (フラグの作成・更新・削除) を処理したインスタンスが、
 * 自分の API route 側のメモリを即座に新しくするために呼ぶ。
 * 他のインスタンスと、ミドルウェア (Edge ランタイム。API route (Node) とはメモリが別) は、
 * 最大 FEATURE_FLAG_CACHE_TTL_MS 遅れて反映される。
 */
export function invalidateFeatureFlag(key: string): void {
  resultCache.delete(key);
  missingRowLogged.delete(key);
}

/** 覚えているフラグをすべて忘れる (テスト用) */
export function clearFeatureFlagCache(): void {
  resultCache.clear();
  inflightReads.clear();
  missingRowLogged.clear();
}
