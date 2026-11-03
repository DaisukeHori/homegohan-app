// @vitest-environment node
// 一時的な調べ (#2195 V1)。網羅の検査を組むための実測。あとで消す
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import {
  SourceScanner,
  caseLabelOf,
  listFiles,
  routeSegmentsOf,
  switchCasesOf,
  urlMatchesRoute,
} from './helpers/ai-consultation-refetch-scan';

const ROOT = path.resolve(__dirname, '..');

it('report', { timeout: 120_000 }, () => {
  const scanner = new SourceScanner(ROOT);
  const report: Record<string, unknown> = {};
  const exec = 'src/lib/ai/consultation-action-executor.ts';
  const mod = scanner.module(exec)!;
  const cases = switchCasesOf(mod.sf, 'runConsultationAction', 'action.action_type');
  const execOut: Record<string, unknown> = {};
  for (const c of cases) {
    const f = scanner.newFindings();
    for (const st of c.statements) scanner.scanNode(exec, st, f);
    execOut[caseLabelOf(c) ?? '?'] = {
      tables: f.tables.map((t) => `${t.kind}:${t.table}@${t.at}[${t.columns?.join(',') ?? '*'}|${t.writeArg?.getText() ?? ''}]`),
      invoke: f.invokesEdgeFunction,
      edgeUrls: [...f.edgeFunctionUrls],
      rpcs: [...f.rpcs.keys()],
    };
  }
  report.exec = execOut;
  for (const ef of ['generate-menu-v4', 'generate-menu-v5']) {
    const f = scanner.newFindings();
    scanner.scanWholeModule(`supabase/functions/${ef}/index.ts`, f);
    report[`edge:${ef}`] = [...new Set(f.tables.map((t) => `${t.kind}:${t.table}`)), ...[...f.rpcs.keys()].map((k) => `rpc:${k}`)].sort();
  }
  const apiRoot = 'src/app/api';
  const routes = listFiles(ROOT, apiRoot, (r) => r.endsWith('/route.ts'));
  const routeReads: Record<string, unknown> = {};
  const routeInfo = (r: string, method: string) => {
    const f = scanner.newFindings();
    scanner.scanExport(r, method, f);
    return [...new Set(f.tables.filter((t) => t.kind !== 'write').map((t) => `${t.kind}:${t.table}${t.table === 'user_profiles' ? `[${t.columns?.join(',') ?? '*'}]@${t.at}` : ''}`)), ...[...f.rpcs.keys()].map((k) => `rpc:${k}`)].sort();
  };
  const pages = listFiles(ROOT, 'src/app/(main)', (r) => r.endsWith('/page.tsx'));
  const pagesOut: Record<string, unknown> = {};
  for (const p of pages) {
    const f = scanner.newFindings();
    scanner.scanWholeModule(p, f);
    const urls = [...f.apiUrls].sort();
    const matched: Record<string, string[]> = {};
    for (const u of urls) matched[u] = routes.filter((r) => urlMatchesRoute(u, routeSegmentsOf(r, apiRoot)));
    const getReads: Record<string, unknown> = {};
    for (const rs of Object.values(matched).flat()) {
      getReads[rs] = { GET: routeInfo(rs, 'GET'), POST: routeInfo(rs, 'POST'), PUT: routeInfo(rs, 'PUT'), PATCH: routeInfo(rs, 'PATCH') };
    }
    pagesOut[p] = {
      direct: [...new Set(f.tables.map((t) => `${t.kind}:${t.table}@${t.at}[${t.columns?.join(',') ?? '*'}]`))].sort(),
      rpcs: [...f.rpcs.entries()].map(([k, v]) => `${k}@${v}`),
      edgeUrls: [...f.edgeFunctionUrls],
      urls: matched,
      routeReads: getReads,
      visitedCount: f.visited.size,
    };
  }
  report.pages = pagesOut;
  void routeReads;
  fs.writeFileSync(path.join(ROOT, 'zz-scan-report.json'), JSON.stringify(report, null, 1));
});
