'use client';

/**
 * 組織管理の本体 (一覧・検索・ページ送り + 新規作成 + プランの変更)
 * operator/03-ui-spec.md §7 準拠
 *
 * 権限 (admin / super_admin) の確認は、同じフォルダの page.tsx (サーバー) で行う。
 * API (GET / POST /api/admin/organizations・PATCH /api/admin/organizations/{id}) も、同じロールだけを通す。
 *
 * プランの変更: 組織のプランの段階は運営だけが変える (#1912)。組織の管理者の設定画面は表示だけで、変えるのはこの画面の
 * 一覧の行のプランの欄 (PATCH /api/admin/organizations/{id})。
 * 変更が 409 CONFLICT_STALE_DATA (別の運営が先にプランを変えた) か 404 NOT_FOUND (組織がもう無い) で断られたときは、
 * 行の表示が古いので、今の条件のまま一覧を読み直し、理由の文を一覧の上に出す (運営が手で読み直さなくてよいように)。
 * その文の「読み込み直した」かどうかは、一覧の読み込みの状態 (読み込み中・失敗・読めた) から描画のたびに決める
 * (読み直しに失敗したのに「読み込み直した」と出さない。「再読み込み」で読めたら「読み込み直した」文になる。#1917)。
 * プランの変更の結果の文 (通知・読み直しの文) は、その一覧の行についての文なので、運営が別の一覧へ移る操作 (検索・ページ送り・
 * 組織の作成の開始) でも消す (#1912 の続き。前の一覧の行についての文を、別の一覧の上に残さない)。
 * 変更の応答を待つ間に運営が別の一覧へ移ったら、遅れて届いた結果 (成功・409・404) では文を出さず、一覧も触らない
 * (変更を始めたときの一覧の世代を覚え、応答のときに違えば捨てる。世代は検索・ページ送り・組織の作成の成功で進む。#1917)。
 *
 * 読み直した一覧が 0 行で、今のページが件数から出る最後のページより後ろ (最後のページの唯一の行が消えたあとに同じページで読み直したときなど) のときは、
 * 空のページを「組織はまだありません」と見せずに、件数から最後のページへ取り直す (GET は範囲外のページで空の一覧と本当の件数を返す)。
 *
 * API が返すのは id・組織名・プラン・作成/更新日時だけ。設計書 §7 にある Seat 数・期限・売上/月・担当営業は、
 * まだ出せない。
 *
 * 組織の作成の応答を受け取れなかったとき (fetch の reject・本文に API の文の無い 502 / 503 / 504) は、失敗とは言わずに
 * 同じ名前の組織を読み直して、送った組織ができていたかを確かめる (#2107 Y4。#2101 X2 の src/lib/admin/admin-create-no-response.ts と同じ考え方)。
 * 比べる元は、送る直前に同じ条件で読んだ同じ名前の組織 (送る前に無かった行で決め、ブラウザの時計は使わない)。
 * できていれば済んだとして入力を空にし、確かめられなければ (まだ無い・読み直しの失敗・比べる元が無い) 送信を止める
 * (押し直すと、同じオーナーの 2 つ目の作成として 409 になるか、オーナーを指定しなかったときは組織が 2 つできうる)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { extractApiErrorCode, extractApiErrorMessage } from '@/lib/admin/api-error-message';
import {
  ADMIN_ACTION_NO_RESPONSE_STATUSES,
  adminActionNoResponseSummary,
  adminLoadFailedMessage,
  screenApiErrorMessage,
} from '@/lib/admin/admin-screen-messages';
import {
  adminCreateFoundGuide,
  adminCreateNoResponseMessage,
  adminCreateNotFoundGuide,
  adminCreateStoppedMessage,
  confirmCreatedRow,
} from '@/lib/admin/admin-create-no-response';
import { formatJstDateTime } from '@/lib/admin/format-datetime';
import { isUuid } from '@/lib/http-params';
import { ORG_PLAN_VALUES, type OrgPlanValue } from '@/lib/org-plans';

/** API (OrgSearchSchema / OrgCreateSchema) が受け付けるプラン (organizations.plan に書ける値) */
const PLANS = ORG_PLAN_VALUES;
type OrgPlan = OrgPlanValue;

/** 1 ページに出す件数 (API の既定値) */
const PER_PAGE = 30;

const LOAD_ERROR = '組織の一覧を取得できませんでした。しばらくしてから、もう一度お試しください。';
const CREATE_ERROR = '組織を作成できませんでした。しばらくしてから、もう一度お試しください。';
const PLAN_CHANGE_ERROR = 'プランを変更できませんでした。しばらくしてから、もう一度お試しください。';

/** 応答を受け取れなかったときの文の操作の名前 (「組織の作成の応答を受け取れませんでした（通信エラー）」。#2107 Y4) */
const CREATE_ACTION = '組織の作成';
/** 読み直したときの文の対象の名前 (「読み込み直したところ、組織は保存されていました」。#2107 Y4) */
const CREATE_SUBJECT = '組織';
/** 読み直しに失敗したときの文の対象の名前 (「組織の一覧を読み込めませんでした (HTTP 500)」) */
const CONFIRM_READ_SUBJECT = '組織の一覧';
/**
 * 作成の前後に同じ名前の組織を読むときの 1 ページの件数。API の per_page の上限 (route の OrgSearchSchema の max(100)) と同じ。
 * 同じ名前の組織がこれより多いときは全部を比べられないので、比べる元が無いものとして扱う
 */
const CONFIRM_PER_PAGE = 100;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** 読み直しが 401 で断られたときの理由 (読み直しても変わらないので「確かめ直す」を出さない) */
const CONFIRM_UNAUTHENTICATED_GUIDE = 'ログインの有効期限が切れました。ログインし直してください';
/** 読み直しが 403 で断られ、本文に理由の文が無いときの理由 */
const CONFIRM_FORBIDDEN_GUIDE = '権限がありません';

/**
 * プランの変更が「行の表示が古い」ことで断られたときの、エラーの code (PATCH /api/admin/organizations/{id})。
 * このときは一覧を読み直す (一覧の行は古い値のままなので)。
 *   - CONFLICT_STALE_DATA (409): 読んでから書くまでに、別の運営が先にプランを変えた
 *   - NOT_FOUND (404)          : 組織がもう無い (解散などで消えた)
 */
const STALE_ROW_ERROR_CODES = ['CONFLICT_STALE_DATA', 'NOT_FOUND'] as const;
type StaleRowErrorCode = (typeof STALE_ROW_ERROR_CODES)[number];

function isStaleRowErrorCode(code: string | null): code is StaleRowErrorCode {
  return code !== null && (STALE_ROW_ERROR_CODES as readonly string[]).includes(code);
}

/** 行の表示が古いことで断られたプランの変更 (一覧の上に出す文の元。#1917) */
interface PlanStale {
  code: StaleRowErrorCode;
  orgName: string;
}

/** 断られたあとの一覧の読み直しの状態 (一覧の読み込みの状態から決める。#1917) */
type ListReloadState = 'reloading' | 'reloaded' | 'failed';

/** 行の表示が古いことで断られた理由の文 */
function staleRowReason(code: StaleRowErrorCode, orgName: string): string {
  switch (code) {
    case 'CONFLICT_STALE_DATA':
      return `組織「${orgName}」のプランは、別の運営が先に変えていました。`;
    case 'NOT_FOUND':
      return `組織「${orgName}」が見つかりませんでした (解散などで消えた可能性があります)。`;
  }
}

/** 理由の文に続ける、一覧の読み直しの状態ごとの文 */
const STALE_ROW_RELOAD_TEXTS: Record<StaleRowErrorCode, Record<ListReloadState, string>> = {
  CONFLICT_STALE_DATA: {
    reloading: '一覧を読み込み直しています。',
    reloaded: '一覧を読み込み直したので、今のプランを確かめてから、もう一度変更してください。',
    failed: '一覧を読み込み直せなかったので、「再読み込み」で読み込み直し、今のプランを確かめてから、もう一度変更してください。',
  },
  NOT_FOUND: {
    reloading: '一覧を読み込み直しています。',
    reloaded: '一覧を読み込み直しました。',
    failed: '一覧を読み込み直せなかったので、「再読み込み」で読み込み直してください。',
  },
};

/**
 * 行の表示が古いことで断られたときに一覧の上に出す文 (サーバーの文は「一覧を読み込み直して」と頼む文なので使わない)。
 * 読み直しの状態に合わせる: 読み直せていないのに「読み込み直した」とは言わない (#1917)
 */
function staleRowMessage({ code, orgName }: PlanStale, reload: ListReloadState): string {
  return `${staleRowReason(code, orgName)}${STALE_ROW_RELOAD_TEXTS[code][reload]}`;
}

/** GET /api/admin/organizations が返す 1 件 */
interface Organization {
  id: string;
  name: string;
  plan: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 一覧を取る条件 */
interface Query {
  q: string;
  plan: '' | OrgPlan;
  page: number;
}

/** 取得できた一覧。どの条件で取ったかも持つ (条件を変えた直後の 1 フレームで、古い一覧に新しい条件の文言を付けないため) */
interface ListResult {
  organizations: Organization[];
  total: number;
  perPage: number;
  query: Query;
}

/** PATCH /api/admin/organizations/{id} が返す { organization } */
function parseOrganizationBody(body: unknown): Organization | null {
  if (typeof body !== 'object' || body === null) return null;
  const { organization } = body as { organization?: unknown };
  if (typeof organization !== 'object' || organization === null) return null;
  const candidate = organization as Partial<Organization>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return null;
  return organization as Organization;
}

/** 送った組織 (前後の空白を除いた組織名とプラン。route はこの値をそのまま書く) */
interface SentOrganization {
  readonly name: string;
  readonly plan: OrgPlan;
}

/**
 * 作成の応答を受け取れなかった (サーバーで済んだか分からない) 組織 (#2107 Y4)。これがあるあいだは送信を止める。
 *   - knownIds: 送る直前に読んだ、同じ名前の組織の id (読めなかった・全部を読めなかったときは null)
 *   - retryable: 「確かめ直す」で読み直せば決まりうるか (読み直しの失敗が通信・サーバーの一時的なもの、まだ見つからない)。
 *     読み直しが 401 / 403 (読み直しても変わらない) と、比べる元が無くて決められない (ambiguous) ときは false
 */
interface UnconfirmedCreate {
  readonly sent: SentOrganization;
  readonly knownIds: ReadonlySet<string> | null;
  readonly summary: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** 同じ名前の組織の読み込みの結果 (失敗なら HTTP のステータス (通信の失敗・形の違いは null) と、失敗の応答の本文) */
type SameNameRead =
  | { ok: true; organizations: Organization[]; complete: boolean }
  | { ok: false; status: number | null; body: unknown };

/**
 * 組織名 name を含む組織を、作成が新しい順に 1 ページ目 (CONFIRM_PER_PAGE 件) まで読む。
 * complete は、同じ名前を含む組織を全部読めたか (件数が 1 ページに収まったか)
 */
async function readSameNameOrganizations(name: string): Promise<SameNameRead> {
  const params = new URLSearchParams({ q: name, page: '1', per_page: String(CONFIRM_PER_PAGE) });
  try {
    const res = await fetch(`/api/admin/organizations?${params.toString()}`);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, body };
    const parsed = parseListBody(body, { q: name, plan: '', page: 1 });
    if (!parsed) return { ok: false, status: null, body: null };
    return { ok: true, organizations: parsed.organizations, complete: parsed.total <= parsed.organizations.length };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

/** 読み直した組織が、送った組織と同じ内容か (組織名とプラン。route は送った値をそのまま書く) */
function isSameOrganization(row: Organization, sent: SentOrganization): boolean {
  return row.name === sent.name && row.plan === sent.plan;
}

/** 読み直しに失敗した理由の文 (401 はログインし直し、403 は本文の理由の文、ほかは「組織の一覧を読み込めませんでした」の形) */
function confirmReadFailureGuide(status: number | null, body: unknown): string {
  if (status === HTTP_UNAUTHORIZED) return CONFIRM_UNAUTHENTICATED_GUIDE;
  if (status === HTTP_FORBIDDEN) return screenApiErrorMessage(body) ?? CONFIRM_FORBIDDEN_GUIDE;
  return screenApiErrorMessage(body) ?? adminLoadFailedMessage(CONFIRM_READ_SUBJECT, status);
}

function isOrgPlan(value: string | null): value is OrgPlan {
  return value !== null && (PLANS as readonly string[]).includes(value);
}

/**
 * 一覧の行のプランの欄: 今のプランを出し、選び直して「変更」でプランを変える (運営だけ。#1912)。
 * 今のプランが一覧 (ORG_PLAN_VALUES) に無い値のときは、その値をそのまま出し、選択肢の先頭は「選ぶ」にする。
 * 行の表示が古いことで断られた (STALE_ROW_ERROR_CODES) ときは、欄にエラーを出さずに onStale を呼ぶ
 * (親が一覧を読み直し、文は一覧の上に出す。読み直すとこの欄は作り直されるので、欄のエラーは残らない)
 */
function OrgPlanCell({
  org,
  onStart,
  onChanged,
  onStale,
}: {
  org: Organization;
  /** 変更を始める。戻り値は、そのときの一覧の世代 (onChanged / onStale に渡し返す。#1917) */
  onStart: () => number;
  onChanged: (org: Organization, listGeneration: number) => void;
  onStale: (stale: PlanStale, listGeneration: number) => void;
}) {
  const current = isOrgPlan(org.plan) ? org.plan : '';
  const [draft, setDraft] = useState<'' | OrgPlan>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = `org-plan-${org.id}`;

  async function handleChange() {
    if (saving || draft === '' || draft === current) return;
    setSaving(true);
    setError(null);
    const listGeneration = onStart();
    try {
      const res = await fetch(`/api/admin/organizations/${encodeURIComponent(org.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: draft }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = extractApiErrorCode(body);
        if (isStaleRowErrorCode(code)) {
          onStale({ code, orgName: org.name }, listGeneration);
          return;
        }
        setError(extractApiErrorMessage(body) ?? PLAN_CHANGE_ERROR);
        return;
      }
      const updated = parseOrganizationBody(body);
      if (!updated) {
        setError(PLAN_CHANGE_ERROR);
        return;
      }
      onChanged(updated, listGeneration);
    } catch {
      setError(PLAN_CHANGE_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="inline-block rounded bg-blue-50 px-2 py-0.5 font-mono text-xs text-blue-800">{org.plan ?? '-'}</span>
        <label htmlFor={selectId} className="sr-only">
          {`${org.name} のプラン`}
        </label>
        <select
          id={selectId}
          value={draft}
          onChange={(e) => setDraft(e.target.value as '' | OrgPlan)}
          disabled={saving}
          className="rounded border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
        >
          {current === '' && <option value="">選ぶ</option>}
          {PLANS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handleChange()}
          disabled={saving || draft === '' || draft === current}
          className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? '変更中...' : '変更'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/** 件数と 1 ページの件数から、最後のページの番号 (0 件でも 1) */
function lastPageOf(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

function parseListBody(body: unknown, query: Query): ListResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const { organizations, meta } = body as {
    organizations?: unknown;
    meta?: { total?: unknown; per_page?: unknown } | null;
  };
  if (!Array.isArray(organizations)) return null;
  return {
    organizations: organizations as Organization[],
    total: typeof meta?.total === 'number' ? meta.total : organizations.length,
    perPage: typeof meta?.per_page === 'number' && meta.per_page > 0 ? meta.per_page : PER_PAGE,
    query,
  };
}

export default function OrganizationsManager() {
  // 一覧
  const [query, setQuery] = useState<Query>({ q: '', plan: '', page: 1 });
  const [qDraft, setQDraft] = useState('');
  const [planDraft, setPlanDraft] = useState<'' | OrgPlan>('');
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 新規作成
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<OrgPlan>('standard');
  const [ownerId, setOwnerId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 作成の応答を受け取れなかった (済んだか分からない) 組織 (#2107 Y4)。これがあるあいだは送信と入力を止める。
  // ref は再描画の前に続けて押されたときの守り
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedCreate | null>(null);
  const unconfirmedRef = useRef<UnconfirmedCreate | null>(null);
  // 送信 (送る前の読み込み・送信・応答を受け取れなかったあとの読み直し) のあいだは true (再描画の前に続けて押されたときも送らない守り)
  const submitLockedRef = useRef(false);

  // 一覧の行のプランの変更 (#1912)
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  /**
   * 行の表示が古くて断られ、一覧を読み直した変更 (409 CONFLICT_STALE_DATA・404 NOT_FOUND)。文は一覧の読み込みの状態から
   * 描画のたびに決める (staleRowMessage。読み直しに失敗しているあいだは「読み込み直した」と出さない。#1917)
   */
  const [planStale, setPlanStale] = useState<PlanStale | null>(null);

  // 一覧を読み込むたびに増やす通し番号。条件を素早く切り替えたとき、遅れて届いた古い応答で
  // 新しい一覧を上書きしないために使う
  const latestLoad = useRef(0);

  // 一覧の世代: 運営が別の一覧へ移る操作 (検索・ページ送り・組織の作成で 1 ページ目から取り直すとき) のたびに増やす。
  // 同じ一覧を取り直すだけ (「再読み込み」・読み直し・範囲外のページからの取り直し) では増やさない。
  // プランの変更は始めたときの世代を覚え、応答のときに違えば (応答を待つ間に別の一覧へ移った)、前の一覧の行についての
  // 文を新しい一覧の上に出さない (#1917)
  const listGeneration = useRef(0);

  const load = useCallback(async (target: Query) => {
    const loadId = ++latestLoad.current;
    /** 範囲外のページだったので最後のページへ取り直した (読み込み中のまま次の取得に引き継ぐ) */
    let redirected = false;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (target.q) params.set('q', target.q);
      if (target.plan) params.set('plan', target.plan);
      params.set('page', String(target.page));
      params.set('per_page', String(PER_PAGE));

      const res = await fetch(`/api/admin/organizations?${params.toString()}`);
      const body: unknown = await res.json().catch(() => null);
      if (loadId !== latestLoad.current) return;

      if (!res.ok) {
        setLoadError(extractApiErrorMessage(body) ?? LOAD_ERROR);
        return;
      }
      const parsed = parseListBody(body, target);
      if (!parsed) {
        // 想定外の形を「組織が 0 件」と見せない
        setLoadError(LOAD_ERROR);
        return;
      }
      const lastPage = lastPageOf(parsed.total, parsed.perPage);
      if (parsed.organizations.length === 0 && target.page > lastPage) {
        // 今のページが件数より後ろ (最後のページの唯一の行が消えたあとの読み直しなど)。空のページを「組織はまだありません」と
        // 見せず、同じ条件で最後のページを取り直す。page は 1 以上で毎回小さくなるので、取り直しは必ず止まる
        redirected = true;
        setQuery({ ...target, page: lastPage });
        return;
      }
      setResult(parsed);
    } catch {
      if (loadId === latestLoad.current) setLoadError(LOAD_ERROR);
    } finally {
      if (loadId === latestLoad.current && !redirected) setLoading(false);
    }
  }, []);

  // 条件が変わるたびに取り直す。同じ条件で取り直したいときは、setQuery に新しいオブジェクトを渡す
  useEffect(() => {
    void load(query);
  }, [load, query]);

  /**
   * プランの変更の結果の表示 (通知・読み直しの文) を消す。どちらも、そのとき出ていた一覧の行についての文なので、
   * 別の一覧へ移る操作 (検索・ページ送り・組織の作成の開始) と、次の変更の開始で消す。
   * 同じ一覧を取り直すだけの操作 (「再読み込み」・読み直し・範囲外のページからの取り直し) では消さない
   */
  const clearPlanMessages = useCallback(() => {
    setPlanNotice(null);
    setPlanStale(null);
  }, []);

  /** 別の一覧へ移る操作の始まり: 前の一覧の行についての文を消し、一覧の世代を進める (#1917) */
  const moveToAnotherList = useCallback(() => {
    listGeneration.current += 1;
    clearPlanMessages();
  }, [clearPlanMessages]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    moveToAnotherList();
    setQuery({ q: qDraft.trim(), plan: planDraft, page: 1 });
  }

  /** ページ送り (前へ: -1・次へ: +1)。別のページの一覧へ移るので、前のページの行についての文を消す */
  function handlePageMove(step: -1 | 1) {
    moveToAnotherList();
    setQuery((current) => ({ ...current, page: current.page + step }));
  }

  const markUnconfirmed = (pending: UnconfirmedCreate | null) => {
    unconfirmedRef.current = pending;
    setUnconfirmed(pending);
  };

  /**
   * 作成が済んだ (応答で・読み直しで) とき: 入力を初期状態に戻して知らせ、1 ページ目から取り直す。
   * 一覧は作成が新しい順なので、1 ページ目から取り直す (今の検索条件は残す)。別の一覧へ移るので、一覧の世代を進める
   * (作成の応答を待つ間に届いたプランの変更の文も消す。#1917)
   */
  const finishCreated = (createdNotice: string) => {
    setName('');
    setPlan('standard');
    setOwnerId('');
    setCreateError(null);
    setNotice(createdNotice);
    moveToAnotherList();
    setQuery((current) => ({ ...current, page: 1 }));
  };

  /**
   * 作成の応答を受け取れなかったあと、同じ名前の組織を読み直して、送った組織ができていたかを確かめる (#2107 Y4)。
   * できていれば済んだとして入力を空にし、送信の止めを外す。
   * まだ無い (サーバーが書き込みの途中かもしれない)・読み直しにも失敗した・前からあった組織か決められないときは、送信を止めたままにする
   * (押し直すと 2 つ目の作成になる。押し直すのは、一覧で確かめてから画面を開き直したときだけ)
   */
  const confirmUnconfirmedCreate = async (pending: Omit<UnconfirmedCreate, 'message' | 'retryable'>) => {
    const reread = await readSameNameOrganizations(pending.sent.name);
    if (!reread.ok) {
      markUnconfirmed({
        ...pending,
        message: adminCreateStoppedMessage(pending.summary, confirmReadFailureGuide(reread.status, reread.body)),
        retryable: reread.status !== HTTP_UNAUTHORIZED && reread.status !== HTTP_FORBIDDEN,
      });
      return;
    }
    const outcome = confirmCreatedRow(reread.organizations, pending.knownIds, (row) => isSameOrganization(row, pending.sent));
    if (outcome === 'ambiguous') {
      markUnconfirmed({ ...pending, message: adminCreateStoppedMessage(pending.summary), retryable: false });
      return;
    }
    if (outcome === 'not-found') {
      // まだ無いことは作られていないことの確かめにならない (サーバーが書き込みの途中なら、押し直すと 2 つ目の作成になる)。止めたまま確かめ直させる
      markUnconfirmed({
        ...pending,
        message: adminCreateStoppedMessage(pending.summary, adminCreateNotFoundGuide(CREATE_SUBJECT)),
        retryable: true,
      });
      return;
    }
    markUnconfirmed(null);
    finishCreated(adminCreateNoResponseMessage(pending.summary, adminCreateFoundGuide(CREATE_SUBJECT)));
  };

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || submitLockedRef.current || unconfirmedRef.current !== null) return;

    setCreateError(null);
    setNotice(null);
    // 作成すると 1 ページ目から取り直す (別の一覧へ移る) ので、前の一覧の行についてのプランの変更の文も消す
    clearPlanMessages();

    const trimmedName = name.trim();
    const trimmedOwnerId = ownerId.trim();
    if (trimmedName === '') {
      setCreateError('組織名を入力してください。');
      return;
    }
    if (trimmedOwnerId !== '' && !isUuid(trimmedOwnerId)) {
      setCreateError('オーナーのユーザー ID は UUID の形式で入力してください。');
      return;
    }

    const sent: SentOrganization = { name: trimmedName, plan };
    submitLockedRef.current = true;
    setCreating(true);
    let created = false;
    try {
      // 応答を受け取れなかったときに読み直しと比べるための、送る前の同じ名前の組織 (読めない・全部を読めないときは null。#2107 Y4)
      const before = await readSameNameOrganizations(sent.name);
      const knownIds: ReadonlySet<string> | null =
        before.ok && before.complete ? new Set(before.organizations.map((org) => org.id)) : null;

      // 通信そのものが失敗 (fetch の reject) したら null
      let res: Response | null;
      try {
        res = await fetch('/api/admin/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: sent.name,
            plan: sent.plan,
            ...(trimmedOwnerId !== '' ? { owner_id: trimmedOwnerId } : {}),
          }),
        });
      } catch {
        res = null;
      }

      // 応答を受け取れなかった (サーバーで済んだか分からない) ときの文の頭 (#2107 Y4)
      let noResponseSummary: string | null = null;
      if (res === null) {
        // 通信そのものの失敗。サーバーが作ってから応答が切れたこともあるので、失敗とは言わずに読み直す
        noResponseSummary = adminActionNoResponseSummary(CREATE_ACTION, null);
      } else if (res.ok) {
        created = true;
      } else {
        const body: unknown = await res.json().catch(() => null);
        const apiMessage = extractApiErrorMessage(body);
        if (apiMessage === null && ADMIN_ACTION_NO_RESPONSE_STATUSES.includes(res.status)) {
          // 本文に API の文の無い 502 / 503 / 504 は、手前のプロキシ・ホスティングの応答 (関数の時間切れなど)。
          // サーバーで済んだか分からないので、失敗とは言わずに読み直す
          noResponseSummary = adminActionNoResponseSummary(CREATE_ACTION, res.status);
        } else {
          setCreateError(apiMessage ?? CREATE_ERROR);
        }
      }
      if (noResponseSummary !== null) {
        await confirmUnconfirmedCreate({ sent, knownIds, summary: noResponseSummary });
      }
    } catch {
      setCreateError(CREATE_ERROR);
    } finally {
      submitLockedRef.current = false;
      setCreating(false);
    }

    if (created) {
      finishCreated(`組織「${sent.name}」を作成しました。`);
    }
  }

  /** 「確かめ直す」: 済んだか分からない作成を、同じ名前の組織を読み直して確かめる (#2107 Y4) */
  async function handleRetryConfirm() {
    const pending = unconfirmedRef.current;
    if (pending === null || !pending.retryable || submitLockedRef.current) return;
    submitLockedRef.current = true;
    setCreating(true);
    try {
      await confirmUnconfirmedCreate(pending);
    } finally {
      submitLockedRef.current = false;
      setCreating(false);
    }
  }

  /** 行のプランの変更を始めたら、前の変更の結果の表示 (通知・読み直しの文) を消し、いまの一覧の世代を返す */
  const handlePlanChangeStart = useCallback(() => {
    clearPlanMessages();
    return listGeneration.current;
  }, [clearPlanMessages]);

  /**
   * 行の表示が古くて断られた (別の運営が先にプランを変えた・組織が消えた) ときは、今の条件 (ページ・検索) のまま一覧を
   * 読み直す。setQuery に新しいオブジェクトを渡すと、条件が同じでも取り直す (古い応答の上書きは latestLoad が防ぐ)。
   * 前の変更の通知は、変更を始めたとき (handlePlanChangeStart) に消している。
   * 応答を待つ間に別の一覧へ移っていたら (世代が違う)、文も読み直しも出さない (#1917)
   */
  const handlePlanStale = useCallback((stale: PlanStale, generation: number) => {
    if (generation !== listGeneration.current) return;
    setPlanStale(stale);
    // 読み直しの取得 (load) は描画のあとの effect で始まるので、文が先に「読み込み直した」に見えないよう、ここで読み込み中にする
    setLoading(true);
    setLoadError(null);
    setQuery((current) => ({ ...current }));
  }, []);

  /**
   * 行のプランを変えたら、その行だけを返ってきた値に置き換える (一覧は取り直さない)。
   * 応答を待つ間に別の一覧へ移っていたら (世代が違う)、通知を出さず、新しい一覧も触らない (#1917)
   */
  const handlePlanChanged = useCallback((updated: Organization, generation: number) => {
    if (generation !== listGeneration.current) return;
    setResult((current) =>
      current
        ? { ...current, organizations: current.organizations.map((org) => (org.id === updated.id ? updated : org)) }
        : current,
    );
    setPlanNotice(`組織「${updated.name}」のプランを ${updated.plan ?? '-'} に変更しました。`);
  }, []);

  // 送信中と、作成の応答を受け取れずに送信を止めているあいだは、入力欄と送信を止める (止めているあいだに書き足した入力を、
  // 確かめ直しで済んでいたと分かったときに消さないため。#2107 Y4)
  const formLocked = creating || unconfirmed !== null;
  const showList = !loading && !loadError && result !== null;
  const totalPages = result ? lastPageOf(result.total, result.perPage) : 1;
  const currentPage = result?.query.page ?? 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">組織管理</h1>
        {showList && <span className="text-sm text-gray-500">全 {result.total.toLocaleString()} 件</span>}
      </div>

      {/* 新規作成 */}
      <section
        aria-labelledby="org-create-heading"
        className="mb-8 rounded-lg border border-gray-200 bg-white p-5"
      >
        <h2 id="org-create-heading" className="mb-4 text-base font-semibold text-gray-900">
          組織を作成
        </h2>

        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label htmlFor="org-create-name" className="mb-1 block text-sm font-medium text-gray-700">
              組織名 <span aria-hidden="true" className="text-red-600">*</span>
            </label>
            <input
              id="org-create-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              disabled={formLocked}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            />
          </div>

          <div>
            <label htmlFor="org-create-plan" className="mb-1 block text-sm font-medium text-gray-700">
              プラン
            </label>
            <select
              id="org-create-plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value as OrgPlan)}
              disabled={formLocked}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            >
              {PLANS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="org-create-owner" className="mb-1 block text-sm font-medium text-gray-700">
              オーナーのユーザー ID (任意)
            </label>
            <input
              id="org-create-owner"
              type="text"
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              disabled={formLocked}
              autoComplete="off"
              spellCheck={false}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              aria-describedby="org-create-owner-help"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            />
            <p id="org-create-owner-help" className="mt-1 text-xs text-gray-500">
              空欄のときは、いま操作しているあなた自身がオーナーになります。すでに別の組織に所属しているユーザーは、オーナーにできません。
            </p>
          </div>

          {createError && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {createError}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
              {notice}
            </p>
          )}
          {unconfirmed && (
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
            >
              <span>{unconfirmed.message}</span>
              {unconfirmed.retryable && (
                <button
                  type="button"
                  onClick={() => void handleRetryConfirm()}
                  disabled={creating}
                  className="shrink-0 rounded border border-yellow-300 bg-white px-3 py-1 text-sm font-medium text-yellow-800 hover:bg-yellow-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  確かめ直す
                </button>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={formLocked}
            className="rounded-lg bg-orange-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? '作成中...' : '作成する'}
          </button>
        </form>
      </section>

      {/* 一覧 */}
      <section aria-labelledby="org-list-heading" aria-busy={loading}>
        <h2 id="org-list-heading" className="mb-3 text-base font-semibold text-gray-900">
          組織一覧
        </h2>

        <form onSubmit={handleSearch} role="search" aria-label="組織の検索" className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="org-search-q" className="mb-1 block text-sm font-medium text-gray-700">
              組織名
            </label>
            <input
              id="org-search-q"
              type="search"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              placeholder="組織名の一部で検索"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div>
            <label htmlFor="org-search-plan" className="mb-1 block text-sm font-medium text-gray-700">
              プラン
            </label>
            <select
              id="org-search-plan"
              value={planDraft}
              onChange={(e) => setPlanDraft(e.target.value as '' | OrgPlan)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="">すべてのプラン</option>
              {PLANS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-orange-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-800"
          >
            検索
          </button>
        </form>

        {planNotice && (
          <p role="status" className="mb-4 rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            {planNotice}
          </p>
        )}

        {planStale && (
          <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {staleRowMessage(planStale, loadError !== null ? 'failed' : loading ? 'reloading' : 'reloaded')}
          </p>
        )}

        {loadError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => setQuery((current) => ({ ...current }))}
              className="shrink-0 rounded border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              再読み込み
            </button>
          </div>
        )}

        {loading && (
          <p role="status" className="py-8 text-center text-sm text-gray-500">
            読み込み中...
          </p>
        )}

        {showList &&
          (result.organizations.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
              {result.query.q || result.query.plan ? '条件に一致する組織はありません' : '組織はまだありません'}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                <table className="w-full text-sm">
                  <caption className="sr-only">組織の一覧 (作成が新しい順)</caption>
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                        組織名
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                        プラン
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                        作成日時
                      </th>
                      <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                        ID
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.organizations.map((org) => (
                      <tr key={org.id}>
                        <td className="px-4 py-3 font-medium text-gray-900">{org.name}</td>
                        <td className="px-4 py-3">
                          <OrgPlanCell
                            key={`${org.id}:${org.plan ?? ''}`}
                            org={org}
                            onStart={handlePlanChangeStart}
                            onChanged={handlePlanChanged}
                            onStale={handlePlanStale}
                          />
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">{formatJstDateTime(org.created_at)}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{org.id.slice(0, 8)}...</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <nav aria-label="ページ送り" className="mt-4 flex items-center justify-between text-sm text-gray-600">
                  <span>
                    {(currentPage - 1) * result.perPage + 1}〜{Math.min(currentPage * result.perPage, result.total)} 件
                    / 全 {result.total.toLocaleString()} 件
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handlePageMove(-1)}
                      disabled={currentPage <= 1}
                      className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      前へ
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePageMove(1)}
                      disabled={currentPage >= totalPages}
                      className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      次へ
                    </button>
                  </div>
                </nav>
              )}
            </>
          ))}
      </section>
    </div>
  );
}
