'use client';

/**
 * 組織管理の本体 (一覧・検索・ページ送り + 新規作成)
 * operator/03-ui-spec.md §7 準拠
 *
 * 権限 (admin / super_admin) の確認は、同じフォルダの page.tsx (サーバー) で行う。
 * API (GET / POST /api/admin/organizations) も、同じロールだけを通す。
 *
 * API が返すのは id・組織名・プラン・作成/更新日時だけ。設計書 §7 にある Seat 数・期限・売上/月・担当営業は、
 * まだ出せない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { extractApiErrorMessage } from '@/lib/admin/api-error-message';
import { formatJstDateTime } from '@/lib/admin/format-datetime';
import { isUuid } from '@/lib/http-params';

/** API (OrgSearchSchema / OrgCreateSchema) が受け付けるプラン */
const PLANS = ['standard', 'premium', 'enterprise'] as const;
type OrgPlan = (typeof PLANS)[number];

/** 1 ページに出す件数 (API の既定値) */
const PER_PAGE = 30;

const LOAD_ERROR = '組織の一覧を取得できませんでした。しばらくしてから、もう一度お試しください。';
const CREATE_ERROR = '組織を作成できませんでした。しばらくしてから、もう一度お試しください。';

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

  // 一覧を読み込むたびに増やす通し番号。条件を素早く切り替えたとき、遅れて届いた古い応答で
  // 新しい一覧を上書きしないために使う
  const latestLoad = useRef(0);

  const load = useCallback(async (target: Query) => {
    const loadId = ++latestLoad.current;
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
      setResult(parsed);
    } catch {
      if (loadId === latestLoad.current) setLoadError(LOAD_ERROR);
    } finally {
      if (loadId === latestLoad.current) setLoading(false);
    }
  }, []);

  // 条件が変わるたびに取り直す。同じ条件で取り直したいときは、setQuery に新しいオブジェクトを渡す
  useEffect(() => {
    void load(query);
  }, [load, query]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery({ q: qDraft.trim(), plan: planDraft, page: 1 });
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;

    setCreateError(null);
    setNotice(null);

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

    setCreating(true);
    let created = false;
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          plan,
          ...(trimmedOwnerId !== '' ? { owner_id: trimmedOwnerId } : {}),
        }),
      });
      if (res.ok) {
        created = true;
      } else {
        const body: unknown = await res.json().catch(() => null);
        setCreateError(extractApiErrorMessage(body) ?? CREATE_ERROR);
      }
    } catch {
      setCreateError(CREATE_ERROR);
    } finally {
      setCreating(false);
    }

    if (created) {
      setName('');
      setPlan('standard');
      setOwnerId('');
      setNotice(`組織「${trimmedName}」を作成しました。`);
      // 一覧は作成が新しい順なので、1 ページ目から取り直す (今の検索条件は残す)
      setQuery((current) => ({ ...current, page: 1 }));
    }
  }

  const showList = !loading && !loadError && result !== null;
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.perPage)) : 1;
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
              disabled={creating}
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
              disabled={creating}
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
              disabled={creating}
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

          <button
            type="submit"
            disabled={creating}
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
                          <span className="inline-block rounded bg-blue-50 px-2 py-0.5 font-mono text-xs text-blue-800">
                            {org.plan ?? '-'}
                          </span>
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
                      onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
                      disabled={currentPage <= 1}
                      className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      前へ
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
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
