/**
 * 退会の段階 apple_revoke (docs/design/mobile/08-sign-in-with-apple.md §9.3)。
 * 保管している refresh token を行ごとに失効させる。例外を投げない (退会の結果を変えない)。失敗は warn のログ。
 * 表の読み取りと、行ごとの処理 (client_secret の作成と失効) をそれぞれ try で囲む (秘密鍵が壊れていると createAppleClientSecret が投げる)。
 * 段階全体 (表の読み取りから最後の行まで) の時間は APPLE_REVOKE_TOTAL_BUDGET_MS まで (§13.1。退会の route の maxDuration に収める)。
 * 締め切りは入口で 1 回決める。試行ごとの待ちは APPLE_API_TIMEOUT_MS と締め切りまでの残りの短いほう。
 * 締め切りを過ぎたら、やり直しも次の行の失効もしない。残りの行は Apple を呼ばずに failed に数え、warn を 1 回出す。
 */
import { createAppleClientSecret } from './client-secret';
import {
  APPLE_API_TIMEOUT_MS,
  APPLE_CLIENT_SECRET_TTL_SECONDS,
  APPLE_REVOKE_ATTEMPTS,
  APPLE_REVOKE_TOTAL_BUDGET_MS,
  readAppleSignInServerConfig,
} from './config';
import { revokeAppleRefreshToken, type AppleRevokeResult, type FetchLike } from './rest';
import { listAppleRefreshTokens, type AppleRefreshTokenRow, type AppleTokenStore } from './tokens';

/** 退会の本体 (deleteAccount) が受け取る報告 (成功のログの metadata に載る) */
export interface AppleRevocationReport {
  readonly tokens: number;
  readonly revoked: number;
  /** 失効できなかった行 (Apple の失敗・client_secret を作れない・締め切りを過ぎて呼ばなかった) */
  readonly failed: number;
  /** 秘密が無く Apple を呼ばなかった */
  readonly skipped: 'not_configured' | null;
}

/** ログの口 (createLogger(...).withUser(...) の一部。AccountDeletionBillingLogger と同じ形) */
export interface AppleRevocationLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
}

/** 退会の差し替え口 (Stripe の AccountDeletionBilling と同じ位置づけ。テストは偽物を渡す) */
export interface AccountDeletionAppleRevocation {
  revokeForAccountDeletion(userId: string, log: AppleRevocationLogger, requestId: string): Promise<AppleRevocationReport>;
}

/** 1 行の結果。not_attempted = 締め切りを過ぎていて Apple を呼ばなかった (failed に数える) */
type RevokeRowOutcome = 'revoked' | 'failed' | 'not_attempted';
type AppleRevokeFailure = Extract<AppleRevokeResult, { ok: false }>;

const MS_PER_SECOND = 1000;

export function createAccountDeletionAppleRevocation(deps: {
  admin: () => AppleTokenStore;
  fetchImpl?: FetchLike;
  /** 時計 (client_secret の iat と締め切り)。テストは進む偽物を渡す。省略すると new Date() */
  now?: () => Date;
  /** 段階全体の時間の上限 (ミリ秒)。テスト用。省略すると APPLE_REVOKE_TOTAL_BUDGET_MS */
  budgetMs?: number;
}): AccountDeletionAppleRevocation {
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();
  return {
    async revokeForAccountDeletion(userId, log, requestId) {
      const budgetMs = deps.budgetMs ?? APPLE_REVOKE_TOTAL_BUDGET_MS;
      const deadlineMs = nowMs() + budgetMs;
      const remainingMs = (): number => deadlineMs - nowMs();
      let rows: AppleRefreshTokenRow[];
      try {
        rows = await listAppleRefreshTokens(deps.admin(), userId);
      } catch (error) {
        log.warn('account deletion: could not read apple refresh tokens (deletion continues; nothing revoked)', {
          request_id: requestId,
          step: 'apple_revoke',
          error_name: error instanceof Error ? error.name : 'unknown',
        });
        return { tokens: 0, revoked: 0, failed: 0, skipped: null };
      }
      if (rows.length === 0) return { tokens: 0, revoked: 0, failed: 0, skipped: null };
      const config = readAppleSignInServerConfig();
      if (!config) {
        log.warn('account deletion: apple server config is missing; refresh tokens not revoked', {
          request_id: requestId,
          step: 'apple_revoke',
          tokens: rows.length,
        });
        return { tokens: rows.length, revoked: 0, failed: 0, skipped: 'not_configured' };
      }
      /** 1 行を失効させる。投げない (client_secret を作れないときも failed を返して warn) */
      const revokeRow = async (row: AppleRefreshTokenRow): Promise<RevokeRowOutcome> => {
        if (remainingMs() <= 0) return 'not_attempted';
        try {
          const clientSecret = createAppleClientSecret({
            teamId: config.teamId,
            keyId: config.keyId,
            privateKeyPem: config.privateKeyPem,
            clientId: row.client_id,
            issuedAtSeconds: Math.floor(nowMs() / MS_PER_SECOND),
            ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
          });
          let attempts = 0;
          let lastFailure: AppleRevokeFailure | null = null;
          while (attempts < APPLE_REVOKE_ATTEMPTS) {
            const remaining = remainingMs();
            if (remaining <= 0) break;
            attempts += 1;
            const result = await revokeAppleRefreshToken(
              {
                clientId: row.client_id,
                clientSecret,
                refreshToken: row.refresh_token,
                timeoutMs: Math.min(APPLE_API_TIMEOUT_MS, remaining),
              },
              deps.fetchImpl,
            );
            if (result.ok) return 'revoked';
            lastFailure = result;
          }
          // client_secret を作る間に締め切りを過ぎた (1 回も呼んでいない)
          if (attempts === 0) return 'not_attempted';
          log.warn('account deletion: apple token revocation failed (deletion continues)', {
            request_id: requestId,
            step: 'apple_revoke',
            client_id: row.client_id,
            attempts,
            apple_status: lastFailure?.status ?? null,
            apple_error: lastFailure?.error ?? null,
            budget_exhausted: remainingMs() <= 0,
          });
          return 'failed';
        } catch (error) {
          // 秘密鍵が壊れている (createPrivateKey・sign が投げた) など。値・PEM はログに出さない
          log.warn('account deletion: could not revoke the apple token (deletion continues)', {
            request_id: requestId,
            step: 'apple_revoke',
            client_id: row.client_id,
            error_name: error instanceof Error ? error.name : 'unknown',
          });
          return 'failed';
        }
      };
      let revoked = 0;
      let notAttempted = 0;
      for (const row of rows) {
        const outcome = await revokeRow(row);
        if (outcome === 'revoked') revoked += 1;
        if (outcome === 'not_attempted') notAttempted += 1;
      }
      if (notAttempted > 0) {
        log.warn('account deletion: apple revocation ran out of its time budget; the remaining tokens were not sent to apple (deletion continues)', {
          request_id: requestId,
          step: 'apple_revoke',
          not_attempted: notAttempted,
          budget_ms: budgetMs,
        });
      }
      return { tokens: rows.length, revoked, failed: rows.length - revoked, skipped: null };
    },
  };
}
