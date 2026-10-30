'use client';

/**
 * /super-admin/backups — DB バックアップの取得の状態と DR 訓練の記録 (#1129 / #1191)
 * 設計: docs/design/cross/17-backup-automation.md §7.4 (正典)
 *
 * 権限は layout (src/app/super-admin/layout.tsx) の requireRoleForPage(['super_admin']) が見る。
 * 選択肢・ラベル・上限・パス・型・400 の文の読み方は src/lib/backups/core.ts から import する (page に書き写さない)。
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BACKUP_TIERS,
  BACKUP_TIER_LABELS,
  DR_TEST_BACKUP_KEY_MAX_LENGTH,
  DR_TEST_ENVIRONMENTS,
  DR_TEST_ENVIRONMENT_LABELS,
  DR_TEST_FIELDS,
  DR_TEST_KINDS,
  DR_TEST_KIND_LABELS,
  DR_TEST_NOTES_MAX_LENGTH,
  DR_TEST_RESULTS,
  DR_TEST_RESULT_LABELS,
  DR_TEST_RTO_MINUTES_MAX,
  DR_TEST_SMOKE_LABELS,
  DR_TEST_SMOKE_RESULTS,
  SUPER_ADMIN_BACKUPS_API_PATH,
  SUPER_ADMIN_DR_TESTS_API_PATH,
  drTestErrorsFromResponse,
  type BackupAuditRow,
  type BackupStatusResponse,
  type DrTestEnvironment,
  type DrTestField,
  type DrTestFieldErrors,
  type DrTestKind,
  type DrTestResult,
  type DrTestSmokeResult,
} from '@/lib/backups/core';
import { UNAUTHENTICATED_SCREEN_MESSAGE, forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import { AdminActionNoResponseError, adminActionErrorOfResponse } from '@/lib/admin/admin-screen-messages';
import {
  adminCreateFoundGuide,
  adminCreateNoResponseMessage,
  adminCreateNotFoundGuide,
  adminCreateStoppedMessage,
  confirmCreatedRow,
} from '@/lib/admin/admin-create-no-response';
import { formatJstDateTime } from '@/lib/admin/format-datetime';
import { jstToday } from '@/lib/jst-day-ranges';

// ── 定数 ──────────────────────────────────────────────────────────────────

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** 大きさの表示の単位 (1 MiB = 1024 × 1024 バイト) */
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
/** MiB の小数の桁 */
const SIZE_FRACTION_DIGITS = 1;
/** details の JSON の字下げ */
const DETAILS_JSON_INDENT = 2;

/** datetime-local の値 (YYYY-MM-DDTHH:mm) は日本時間として読む (運営の画面の日時は日本時間に固定する。src/lib/admin/format-datetime.ts と同じ方針) */
const JST_OFFSET = '+09:00';
/** datetime-local の値の長さ (秒の無い形 YYYY-MM-DDTHH:mm) */
const DATETIME_LOCAL_MINUTES_LENGTH = 'YYYY-MM-DDTHH:mm'.length;

/** 鮮度 (stale) を決める層 = 日次 (BACKUP_TIERS の先頭。core の toBackupStatusResponse は latest.daily で stale を決める) */
const FRESHNESS_TIER = BACKUP_TIERS[0];

const NO_RECORD_TEXT = '記録なし';
const LOAD_FAILED_TEXT = 'バックアップの状態を読み込めませんでした。時間をおいてもう一度開いてください';
const LOAD_FORBIDDEN_TEXT = 'この画面を見る権限がありません';
const SUBMIT_FORBIDDEN_TEXT = '記録する権限がありません';
const SUBMIT_FAILED_TEXT = '記録できませんでした。時間をおいてもう一度送ってください';
const SUBMIT_SUCCEEDED_TEXT = '記録しました';
/** 応答を受け取れなかったときの文の操作の名前 (「DR 訓練の記録の応答を受け取れませんでした（通信エラー）」。#2101 X2) */
const DR_TEST_RECORD_ACTION = 'DR 訓練の記録';
/** 読み直したときの文の対象の名前 (「読み込み直したところ、DR 訓練の記録は保存されていました」。#2101 X2) */
const DR_TEST_RECORD_SUBJECT = 'DR 訓練の記録';

// ── form ──────────────────────────────────────────────────────────────────

interface DrTestFormState {
  kind: DrTestKind;
  result: DrTestResult;
  performed_on: string;
  environment: DrTestEnvironment;
  restored_to: string;
  backup_key: string;
  rto_minutes: string;
  smoke: DrTestSmokeResult;
  notes: string;
}

function initialFormState(): DrTestFormState {
  return {
    kind: DR_TEST_KINDS[0],
    result: DR_TEST_RESULTS[0],
    performed_on: jstToday(),
    environment: DR_TEST_ENVIRONMENTS[0],
    restored_to: '',
    backup_key: '',
    rto_minutes: '',
    smoke: DR_TEST_SMOKE_RESULTS[0],
    notes: '',
  };
}

/** datetime-local の値を、日本時間のオフセットつきの ISO 8601 にする (空なら null) */
function restoredToIso(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const withSeconds = trimmed.length === DATETIME_LOCAL_MINUTES_LENGTH ? `${trimmed}:00` : trimmed;
  return `${withSeconds}${JST_OFFSET}`;
}

/** 数の入力。空なら null、数として読めなければ入力のまま送る (API の 400 の文で直してもらう) */
function rtoMinutesValue(value: string): number | string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? trimmed : parsed;
}

/** POST の本文 (drTestRecordBodySchema の形) */
function toRequestBody(form: DrTestFormState): Record<DrTestField, unknown> {
  const backupKey = form.backup_key.trim();
  return {
    kind: form.kind,
    result: form.result,
    performed_on: form.performed_on,
    environment: form.environment,
    restored_to: restoredToIso(form.restored_to),
    backup_key: backupKey === '' ? null : backupKey,
    rto_minutes: rtoMinutesValue(form.rto_minutes),
    smoke: form.smoke,
    notes: form.notes,
  };
}

const EMPTY_ERRORS: DrTestFieldErrors = { fields: {}, form: [] };

const fieldInputId = (field: DrTestField) => `dr-test-${field}`;
const fieldErrorId = (field: DrTestField) => `dr-test-field-error-${field}`;

const FIELD_LABELS: Readonly<Record<DrTestField, string>> = {
  kind: '訓練の種類',
  result: '結果',
  performed_on: '実施日',
  environment: '復元した先',
  restored_to: '復元した時点 (日本時間・任意)',
  backup_key: '復元に使った R2 のキー (任意)',
  rto_minutes: '復旧にかかった分 (任意)',
  smoke: 'smoke の結果',
  notes: 'メモ (成功以外は理由)',
};

/**
 * 記録の応答を受け取れなかった (サーバーで済んだか分からない) 訓練の記録 (#2101 X2)。これがあるあいだは送信を止める。
 *   - knownIds: 送る前に画面が持っていた訓練の記録の行の id (読めていなければ null)
 *   - retryable: 「確かめ直す」で読み直せば決まりうるか (読み直しの失敗 (401 / 403 を除く)、読み直した記録に送った記録がまだ無い (サーバーが書き込みの途中かもしれない))。
 *     比べる元が無くて決められない (ambiguous) とき・読み直しが 401 / 403 で断られた (読み込み直しても変わらない。integrity-1030c) ときは false
 */
interface UnconfirmedDrTest {
  readonly body: Readonly<Record<DrTestField, unknown>>;
  readonly knownIds: ReadonlySet<string> | null;
  readonly summary: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 読み直した訓練の記録の行が、送った本文と同じ内容か。
 * route は検証した本文をそのまま details に書く (recordAdminAudit の details)。値は文字・数・null だけなので、項目ごとに === で比べる
 */
function isSameDrTest(row: BackupAuditRow, body: Readonly<Record<DrTestField, unknown>>): boolean {
  return DR_TEST_FIELDS.every((field) => row.details?.[field] === body[field]);
}

/** 状態の応答の形か (data に訓練の記録の一覧がある)。中の行の形は API (backupAuditRowSchema) が確かめて返す */
function isBackupStatusResponse(json: unknown): json is BackupStatusResponse {
  if (typeof json !== 'object' || json === null) return false;
  const data = (json as { data?: unknown }).data;
  return typeof data === 'object' && data !== null && Array.isArray((data as { dr_tests?: unknown }).dr_tests);
}

// ── details の読み取り (中身を見ない record から、表示する値だけを型で確かめて読む) ──

type Details = BackupAuditRow['details'];

function detailString(details: Details, key: string): string | null {
  const value = details?.[key];
  return typeof value === 'string' ? value : null;
}

function detailNumber(details: Details, key: string): number | null {
  const value = details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function restoreCheckResult(details: Details): string | null {
  const value = details?.restore_check;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('result' in value)) return null;
  return typeof value.result === 'string' ? value.result : null;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '-';
  return `${(bytes / BYTES_PER_MIB).toFixed(SIZE_FRACTION_DIGITS)} MiB`;
}

function isDrTestResult(value: string | null): value is DrTestResult {
  return DR_TEST_RESULTS.some((result) => result === value);
}

function drTestResultText(details: Details): string {
  const result = detailString(details, 'result');
  return isDrTestResult(result) ? DR_TEST_RESULT_LABELS[result] : '-';
}

function stageReasonText(details: Details): string {
  const stage = detailString(details, 'stage');
  const reason = detailString(details, 'reason');
  if (stage === null && reason === null) return '-';
  return `${stage ?? '-'} / ${reason ?? '-'}`;
}

// ── 画面 ──────────────────────────────────────────────────────────────────

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; data: BackupStatusResponse['data'] }
  | { status: 'error'; message: string };

/**
 * 状態の読み込み (reload) の結果 (#2101 integrity-1030c。src/app/admin/sales/[id]/page.tsx の LeadLoadResult と同じ分け方):
 *   - loaded      : 読めた (data)
 *   - unauthorized: 401 (ログインが切れた)。message は「ログインし直してください」
 *   - forbidden   : 403 (権限が外れた・二段階認証の確認が要る など)。message は本文の理由の文か、この画面の固定の文
 *   - failed      : ほかの失敗 (500・本文の無い 502・通信の reject・形の違う本文)。読み込み直せば変わりうる
 * unauthorized / forbidden は読み込み直しても変わらないので、記録の応答を受け取れなかったあとの読み直しでは「確かめ直す」を出さない
 */
type BackupsLoadResult =
  | { outcome: 'loaded'; data: BackupStatusResponse['data'] }
  | { outcome: 'unauthorized' | 'forbidden'; message: string }
  | { outcome: 'failed' };

export default function SuperAdminBackupsPage() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [form, setForm] = useState<DrTestFormState>(initialFormState);
  const [errors, setErrors] = useState<DrTestFieldErrors>(EMPTY_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // 記録の応答を受け取れなかったあと、読み直しで記録できていたと確かめたときの文 (#2101 X2)
  const [confirmedNotice, setConfirmedNotice] = useState<string | null>(null);
  // 記録の応答を受け取れなかった (済んだか分からない) 訓練の記録 (#2101 X2)。押し直すと監査ログに 2 行入るので、これがあるあいだは送信を止める。
  // ref は再描画の前に続けて押されたときの守り
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedDrTest | null>(null);
  const unconfirmedRef = useRef<UnconfirmedDrTest | null>(null);
  // 送信と、そのあとの読み直しを待っているあいだは true (再描画の前に続けて押されたときも送らない守り。#2101 X2)
  const submitLockedRef = useRef(false);

  /**
   * 状態を読み、画面に出す。結果を 401 / 403 / ほかの失敗に分けて返す
   * (記録の応答を受け取れなかったあとの読み直しで、読めた data と比べ、401 / 403 なら「確かめ直す」を出さない。#2101 X2・integrity-1030c)
   */
  const reload = useCallback(async (): Promise<BackupsLoadResult> => {
    try {
      const res = await fetch(SUPER_ADMIN_BACKUPS_API_PATH);
      if (res.status === HTTP_UNAUTHORIZED) {
        // 401 は読み込み直しても変わらない。時間をおいて開き直す文ではなく、ログインし直す文を出す (#2101 integrity-1030c)
        setLoad({ status: 'error', message: UNAUTHENTICATED_SCREEN_MESSAGE });
        return { outcome: 'unauthorized', message: UNAUTHENTICATED_SCREEN_MESSAGE };
      }
      if (res.status === HTTP_FORBIDDEN) {
        // 403 は本文の理由の文 (二段階認証の確認が要る など) があればそちらを出す (#1917)
        const message = await forbiddenMessageOfResponse(res, LOAD_FORBIDDEN_TEXT);
        setLoad({ status: 'error', message });
        return { outcome: 'forbidden', message };
      }
      if (res.status !== HTTP_OK) {
        setLoad({ status: 'error', message: LOAD_FAILED_TEXT });
        return { outcome: 'failed' };
      }
      const json: unknown = await res.json();
      // 訓練の記録の一覧の無い形を読めたとは扱わない (読み直しで「記録されていない」と誤って決めない。#2101 X2)
      if (!isBackupStatusResponse(json)) {
        setLoad({ status: 'error', message: LOAD_FAILED_TEXT });
        return { outcome: 'failed' };
      }
      setLoad({ status: 'loaded', data: json.data });
      return { outcome: 'loaded', data: json.data };
    } catch {
      setLoad({ status: 'error', message: LOAD_FAILED_TEXT });
      return { outcome: 'failed' };
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setField = <K extends keyof DrTestFormState>(key: K, value: DrTestFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const markUnconfirmed = (pending: UnconfirmedDrTest | null) => {
    unconfirmedRef.current = pending;
    setUnconfirmed(pending);
  };

  /**
   * 記録の応答を受け取れなかったあと、状態を読み直して送った記録ができていたかを確かめる (#2101 X2)。
   * できていれば済んだとして入力を初めに戻し、送信の止めを外す。
   * まだ無い (サーバーが書き込みの途中かもしれない)・読み直しにも失敗した・前からあった行か決められないときは、送信を止めたままにする
   * (押し直すと監査ログに 2 行入りうる。押し直すのは、記録の一覧で確かめてから画面を開き直したときだけ)。
   * 読み直しが 401 / 403 なら、読み込み直しても必ず同じ理由で断られるので「確かめ直す」を出さず、理由の文
   * (「ログインし直してください」・403 の理由の文) を添える (#2101 integrity-1030c。お知らせ・営業のリードの活動と同じ)
   */
  const confirmUnconfirmedDrTest = async (pending: Omit<UnconfirmedDrTest, 'message' | 'retryable'>) => {
    const result = await reload();
    switch (result.outcome) {
      case 'loaded':
        break;
      case 'unauthorized':
      case 'forbidden':
        markUnconfirmed({ ...pending, message: adminCreateStoppedMessage(pending.summary, result.message), retryable: false });
        return;
      case 'failed':
        markUnconfirmed({ ...pending, message: adminCreateStoppedMessage(pending.summary), retryable: true });
        return;
    }
    const outcome = confirmCreatedRow(result.data.dr_tests, pending.knownIds, (row) => isSameDrTest(row, pending.body));
    if (outcome === 'ambiguous') {
      markUnconfirmed({ ...pending, message: adminCreateStoppedMessage(pending.summary), retryable: false });
      return;
    }
    if (outcome === 'not-found') {
      // まだ無いことは記録されていないことの確かめにならない (サーバーが書き込みの途中なら、押し直すと 2 行になる)。止めたまま確かめ直させる
      markUnconfirmed({
        ...pending,
        message: adminCreateStoppedMessage(pending.summary, adminCreateNotFoundGuide(DR_TEST_RECORD_SUBJECT)),
        retryable: true,
      });
      return;
    }
    markUnconfirmed(null);
    setErrors(EMPTY_ERRORS);
    setForm(initialFormState());
    setConfirmedNotice(adminCreateNoResponseMessage(pending.summary, adminCreateFoundGuide(DR_TEST_RECORD_SUBJECT)));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || submitLockedRef.current || unconfirmedRef.current !== null) return;
    submitLockedRef.current = true;
    setSubmitting(true);
    setSubmitted(false);
    setConfirmedNotice(null);
    const body = toRequestBody(form);
    // 応答を受け取れなかったときに、読み直した記録と比べるための、送る前の記録の行 (読めていなければ null。#2101 X2)
    const knownIds: ReadonlySet<string> | null =
      load.status === 'loaded' ? new Set(load.data.dr_tests.map((row) => row.id)) : null;
    try {
      let res: Response;
      try {
        res = await fetch(SUPER_ADMIN_DR_TESTS_API_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        // 通信そのものの失敗。サーバーが記録してから応答が切れたこともあるので、失敗とは言わずに読み直す (#2101 X2)
        throw new AdminActionNoResponseError(DR_TEST_RECORD_ACTION, null);
      }
      if (res.status === HTTP_CREATED) {
        setErrors(EMPTY_ERRORS);
        setForm(initialFormState());
        setSubmitted(true);
        await reload();
        return;
      }
      if (res.status === HTTP_BAD_REQUEST) {
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        setErrors(drTestErrorsFromResponse(json));
        return;
      }
      if (res.status === HTTP_FORBIDDEN) {
        // 403 は本文の理由の文 (二段階認証の確認が要る など) があればそちらを出す (#1917)
        setErrors({ fields: {}, form: [await forbiddenMessageOfResponse(res, SUBMIT_FORBIDDEN_TEXT)] });
        return;
      }
      // 本文に API の文の無い 502 / 503 / 504 は応答を受け取れなかったもの (手前のプロキシ・ホスティングの応答。#2101 X2)。
      // ほかの失敗はこれまでどおり固定の文 (本文の文は出さない)
      const failure = await adminActionErrorOfResponse(res, DR_TEST_RECORD_ACTION);
      if (failure instanceof AdminActionNoResponseError) throw failure;
      setErrors({ fields: {}, form: [SUBMIT_FAILED_TEXT] });
    } catch (e: unknown) {
      if (e instanceof AdminActionNoResponseError) {
        await confirmUnconfirmedDrTest({ body, knownIds, summary: e.message });
      } else {
        setErrors({ fields: {}, form: [SUBMIT_FAILED_TEXT] });
      }
    } finally {
      submitLockedRef.current = false;
      setSubmitting(false);
    }
  };

  /** 「確かめ直す」: 済んだか分からない記録を、状態を読み直して確かめる (#2101 X2) */
  const handleRetryConfirm = async () => {
    const pending = unconfirmedRef.current;
    if (pending === null || !pending.retryable || submitLockedRef.current) return;
    submitLockedRef.current = true;
    setSubmitting(true);
    try {
      await confirmUnconfirmedDrTest(pending);
    } finally {
      submitLockedRef.current = false;
      setSubmitting(false);
    }
  };

  /** 入力に付ける a11y の属性 (文のある項目は aria-invalid と、その文の要素を指す aria-describedby) */
  const fieldA11y = (field: DrTestField) =>
    errors.fields[field] === undefined
      ? { id: fieldInputId(field) }
      : { id: fieldInputId(field), 'aria-invalid': true as const, 'aria-describedby': fieldErrorId(field) };

  const fieldError = (field: DrTestField) => {
    const message = errors.fields[field];
    if (message === undefined) return null;
    return (
      <p id={fieldErrorId(field)} role="alert" data-testid={fieldErrorId(field)} className="mt-1 text-xs text-red-700">
        {message}
      </p>
    );
  };

  const labelFor = (field: DrTestField) => (
    <label htmlFor={fieldInputId(field)} className="block text-sm font-medium text-slate-700 mb-1">
      {FIELD_LABELS[field]}
    </label>
  );

  const inputClass = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">バックアップ・DR</h1>
        <p className="mt-1 text-sm text-slate-600">
          DB の論理バックアップ (GitHub Actions の db-backup) の取得の結果と、DR 訓練の記録です。
        </p>
      </div>

      {load.status === 'loading' ? <p className="text-sm text-slate-500">読み込み中…</p> : null}
      {load.status === 'error' ? (
        <div role="alert" data-testid="backups-load-error" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {load.message}
        </div>
      ) : null}

      {load.status === 'loaded' ? (
        <section aria-labelledby="backups-tiers-heading" className="space-y-3">
          <h2 id="backups-tiers-heading" className="text-lg font-bold text-slate-900">
            取得の状態
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {BACKUP_TIERS.map((tier) => {
              const row = load.data.latest[tier];
              const restoreCheck = row ? restoreCheckResult(row.details) : null;
              return (
                <div key={tier} data-testid={`backups-tier-${tier}`} className="rounded-lg border border-slate-200 bg-white p-4">
                  <h3 className="font-bold text-slate-900">{BACKUP_TIER_LABELS[tier]}</h3>
                  {row === null ? (
                    <p className="mt-2 text-sm text-slate-500">{NO_RECORD_TEXT}</p>
                  ) : (
                    <dl className="mt-2 space-y-1 text-sm text-slate-700">
                      <div>
                        <dt className="inline text-slate-500">最新: </dt>
                        <dd className="inline">{formatJstDateTime(row.created_at)}</dd>
                      </div>
                      <div>
                        <dt className="inline text-slate-500">大きさ: </dt>
                        <dd className="inline">{formatSize(detailNumber(row.details, 'size_bytes'))}</dd>
                      </div>
                      <div>
                        <dt className="inline text-slate-500">R2 のキー: </dt>
                        <dd className="inline break-all font-mono text-xs">{detailString(row.details, 'key') ?? '-'}</dd>
                      </div>
                      {restoreCheck !== null ? (
                        <div>
                          <dt className="inline text-slate-500">復元の検査: </dt>
                          <dd className="inline">{restoreCheck}</dd>
                        </div>
                      ) : null}
                    </dl>
                  )}
                  {tier === FRESHNESS_TIER && load.data.stale ? (
                    <div className="mt-3">
                      <span
                        data-testid="backups-stale-badge"
                        className="inline-block rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white"
                      >
                        古い ({load.data.stale_after_hours} 時間以上)
                      </span>
                      <p className="mt-1 text-xs text-red-700">GitHub Actions の db-backup が止まっていないか確かめる</p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="dr-tests-heading" className="space-y-4">
        <h2 id="dr-tests-heading" className="text-lg font-bold text-slate-900">
          DR 訓練
        </h2>

        {load.status === 'loaded' ? (
          <ul data-testid="dr-tests-latest" className="space-y-1 rounded-lg border border-slate-200 bg-white p-4 text-sm">
            {DR_TEST_KINDS.map((kind) => {
              const row = load.data.latest_dr_tests[kind];
              return (
                <li key={kind} data-testid={`dr-tests-latest-${kind}`}>
                  <span className="font-medium text-slate-900">{DR_TEST_KIND_LABELS[kind]}: </span>
                  {row === null ? (
                    <span className="text-slate-500">{NO_RECORD_TEXT}</span>
                  ) : (
                    <span>
                      {detailString(row.details, 'performed_on') ?? formatJstDateTime(row.created_at)} {drTestResultText(row.details)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        <form data-testid="dr-test-form" onSubmit={onSubmit} noValidate className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="font-bold text-slate-900">DR 訓練を記録</h3>
          {errors.form.length > 0 ? (
            <div role="alert" data-testid="dr-test-form-error" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {errors.form.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
            </div>
          ) : null}
          {submitted ? (
            <p role="status" data-testid="dr-test-form-success" className="text-sm text-green-700">
              {SUBMIT_SUCCEEDED_TEXT}
            </p>
          ) : null}
          {confirmedNotice !== null ? (
            <p role="status" data-testid="dr-test-form-confirmed" className="text-sm text-green-700">
              {confirmedNotice}
            </p>
          ) : null}
          {unconfirmed !== null ? (
            <div
              role="alert"
              data-testid="dr-test-form-unconfirmed"
              className="flex items-center justify-between gap-4 rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800"
            >
              <span>{unconfirmed.message}</span>
              {unconfirmed.retryable ? (
                <button
                  type="button"
                  onClick={() => void handleRetryConfirm()}
                  disabled={submitting}
                  className="shrink-0 rounded border border-yellow-300 bg-white px-3 py-1 text-sm font-medium text-yellow-800 hover:bg-yellow-50 disabled:opacity-50"
                >
                  確かめ直す
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              {labelFor('kind')}
              <select
                {...fieldA11y('kind')}
                className={inputClass}
                value={form.kind}
                onChange={(e) => {
                  const next = DR_TEST_KINDS.find((kind) => kind === e.target.value);
                  if (next !== undefined) setField('kind', next);
                }}
              >
                {DR_TEST_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {DR_TEST_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              {fieldError('kind')}
            </div>

            <div>
              {labelFor('result')}
              <select
                {...fieldA11y('result')}
                className={inputClass}
                value={form.result}
                onChange={(e) => {
                  const next = DR_TEST_RESULTS.find((result) => result === e.target.value);
                  if (next !== undefined) setField('result', next);
                }}
              >
                {DR_TEST_RESULTS.map((result) => (
                  <option key={result} value={result}>
                    {DR_TEST_RESULT_LABELS[result]}
                  </option>
                ))}
              </select>
              {fieldError('result')}
            </div>

            <div>
              {labelFor('performed_on')}
              <input
                {...fieldA11y('performed_on')}
                type="date"
                className={inputClass}
                value={form.performed_on}
                onChange={(e) => setField('performed_on', e.target.value)}
              />
              {fieldError('performed_on')}
            </div>

            <div>
              {labelFor('environment')}
              <select
                {...fieldA11y('environment')}
                className={inputClass}
                value={form.environment}
                onChange={(e) => {
                  const next = DR_TEST_ENVIRONMENTS.find((environment) => environment === e.target.value);
                  if (next !== undefined) setField('environment', next);
                }}
              >
                {DR_TEST_ENVIRONMENTS.map((environment) => (
                  <option key={environment} value={environment}>
                    {DR_TEST_ENVIRONMENT_LABELS[environment]}
                  </option>
                ))}
              </select>
              {fieldError('environment')}
            </div>

            <div>
              {labelFor('restored_to')}
              <input
                {...fieldA11y('restored_to')}
                type="datetime-local"
                className={inputClass}
                value={form.restored_to}
                onChange={(e) => setField('restored_to', e.target.value)}
              />
              {fieldError('restored_to')}
            </div>

            <div>
              {labelFor('backup_key')}
              <input
                {...fieldA11y('backup_key')}
                type="text"
                className={inputClass}
                maxLength={DR_TEST_BACKUP_KEY_MAX_LENGTH}
                value={form.backup_key}
                onChange={(e) => setField('backup_key', e.target.value)}
              />
              {fieldError('backup_key')}
            </div>

            <div>
              {labelFor('rto_minutes')}
              <input
                {...fieldA11y('rto_minutes')}
                type="number"
                min={0}
                max={DR_TEST_RTO_MINUTES_MAX}
                step={1}
                className={inputClass}
                value={form.rto_minutes}
                onChange={(e) => setField('rto_minutes', e.target.value)}
              />
              {fieldError('rto_minutes')}
            </div>

            <div>
              {labelFor('smoke')}
              <select
                {...fieldA11y('smoke')}
                className={inputClass}
                value={form.smoke}
                onChange={(e) => {
                  const next = DR_TEST_SMOKE_RESULTS.find((smoke) => smoke === e.target.value);
                  if (next !== undefined) setField('smoke', next);
                }}
              >
                {DR_TEST_SMOKE_RESULTS.map((smoke) => (
                  <option key={smoke} value={smoke}>
                    {DR_TEST_SMOKE_LABELS[smoke]}
                  </option>
                ))}
              </select>
              {fieldError('smoke')}
            </div>
          </div>

          <div>
            {labelFor('notes')}
            <input
              {...fieldA11y('notes')}
              type="text"
              className={inputClass}
              maxLength={DR_TEST_NOTES_MAX_LENGTH}
              value={form.notes}
              onChange={(e) => setField('notes', e.target.value)}
            />
            {fieldError('notes')}
          </div>

          <button
            type="submit"
            disabled={submitting || unconfirmed !== null}
            className="rounded bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {submitting ? '記録中…' : '記録する'}
          </button>
        </form>
      </section>

      {load.status === 'loaded' ? (
        <>
          <section aria-labelledby="backups-list-heading" className="space-y-3">
            <h2 id="backups-list-heading" className="text-lg font-bold text-slate-900">
              取得の記録
            </h2>
            <AuditRowTable rows={load.data.backups} testId="backups-list" showStageReason />
          </section>
          <section aria-labelledby="dr-tests-list-heading" className="space-y-3">
            <h2 id="dr-tests-list-heading" className="text-lg font-bold text-slate-900">
              訓練の記録
            </h2>
            <AuditRowTable rows={load.data.dr_tests} testId="dr-tests-list" showStageReason={false} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function AuditRowTable({
  rows,
  testId,
  showStageReason,
}: {
  rows: readonly BackupAuditRow[];
  testId: string;
  showStageReason: boolean;
}) {
  return (
    <div data-testid={testId} className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">{NO_RECORD_TEXT}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">日時</th>
              <th className="px-3 py-2">action_type</th>
              <th className="px-3 py-2">severity</th>
              {showStageReason ? <th className="px-3 py-2">stage / reason</th> : null}
              <th className="px-3 py-2">details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap px-3 py-2">{formatJstDateTime(row.created_at)}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.action_type}</td>
                <td className="px-3 py-2">{row.severity}</td>
                {showStageReason ? <td className="px-3 py-2 font-mono text-xs">{stageReasonText(row.details)}</td> : null}
                <td className="px-3 py-2">
                  <pre className="max-w-xl overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-600">
                    {JSON.stringify(row.details, null, DETAILS_JSON_INDENT)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
