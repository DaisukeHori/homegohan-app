import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { sourceAuditConfig } from "./source-audit-config.mjs";

const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceCode = args.source;
  if (!sourceCode) {
    throw new Error("Missing --source=<source_code>");
  }

  const config = sourceAuditConfig[sourceCode];
  if (!config) {
    throw new Error(`Unknown source: ${sourceCode}`);
  }

  const firecrawlConfig = getFirecrawlConfig();

  const sampleCount = Number(args.samples ?? 3);
  const maxDepth = Number(args.maxDepth ?? 2);
  const maxPages = Number(args.maxPages ?? 80);

  const listPages = [];
  const seenListUrls = new Set();
  const seenItemUrls = new Set();
  const pending = [];
  const errors = [];

  for (const seedUrl of config.seedListUrls ?? [config.rootUrl]) {
    pending.push({
      url: seedUrl,
      depth: seedUrl === config.rootUrl ? 0 : 1,
      label: seedUrl === config.rootUrl ? "root" : "seed",
      parentUrl: null,
    });
  }

  while (pending.length > 0 && seenListUrls.size < maxPages) {
    const next = pending.shift();
    if (!next) break;
    if (!next.url || seenListUrls.has(next.url) || next.depth > maxDepth) continue;

    seenListUrls.add(next.url);
    let discovered;
    try {
      discovered = await discoverListPage(firecrawlConfig, next.url, config);
    } catch (error) {
      errors.push({
        phase: "list-discovery",
        url: next.url,
        message: String(error),
      });
      continue;
    }
    const categoryUrls = discovered.categoryUrls;
    const itemUrls = discovered.itemUrls;

    listPages.push({
      url: next.url,
      depth: next.depth,
      label: next.label,
      parentUrl: next.parentUrl,
      pageRole: classifyPageRole(next.depth, categoryUrls.length),
      categoryCount: categoryUrls.length,
      itemCount: itemUrls.length,
      categoryUrls,
      discoveredItemUrls: itemUrls,
      sampleCandidateItems: itemUrls.slice(0, Math.max(sampleCount, 10)),
    });

    for (const itemUrl of itemUrls) {
      seenItemUrls.add(itemUrl);
    }
    for (const childUrl of categoryUrls) {
      pending.push({
        url: childUrl,
        depth: next.depth + 1,
        label: `${next.label}>child`,
        parentUrl: next.url,
      });
    }
  }

  const pageSamples = [];
  for (const page of listPages) {
    const itemUrls = Array.isArray(page.discoveredItemUrls) ? page.discoveredItemUrls : [];
    const sampled = sampleRandom(itemUrls, sampleCount);
    const detailSamples = [];

    for (const itemUrl of sampled) {
      try {
        const detail = await firecrawlScrape(firecrawlConfig, itemUrl, buildDetailPrompt(config), {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            nutritionText: { type: "string" },
            rawText: { type: "string" },
          },
        });

        const markers = scanMarkers(detail.markdown ?? "", config.nutritionMarkers);
        detailSamples.push({
          url: itemUrl,
          hasName: Boolean(detail.json?.name),
          markerHits: markers,
          hasAnyNutritionMarker: Object.values(markers).some(Boolean),
        });
      } catch (error) {
        errors.push({
          phase: "detail-sample",
          url: itemUrl,
          message: String(error),
        });
        detailSamples.push({
          url: itemUrl,
          hasName: false,
          markerHits: {},
          hasAnyNutritionMarker: false,
          error: String(error),
        });
      }
    }

    pageSamples.push({
      pageUrl: page.url,
      depth: page.depth,
      label: page.label,
      pageRole: page.pageRole,
      parentUrl: page.parentUrl,
      discoveredItemCount: itemUrls.length,
      sampledCount: sampled.length,
      hasRequiredMinimumSamples: sampled.length >= sampleCount,
      detailSamples,
    });
  }

  const report = {
    sourceCode,
    brandName: config.brandName,
    strategy: config.strategy,
    rootUrl: config.rootUrl,
    sampleCount,
    maxDepth,
    maxPages,
    crawledAt: new Date().toISOString(),
    listPages,
    totalUniqueItems: seenItemUrls.size,
    eligibleListPages: listPages.filter((page) => page.itemCount > 0).length,
    pageSamples,
    errors,
  };

  const outDir = path.join(process.cwd(), "tmp", "catalog-audits");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${sourceCode}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));

  process.stdout.write(`${outPath}\n`);
}

async function firecrawlScrape(firecrawlConfig, url, prompt, schema) {
  const res = await fetch(`${firecrawlConfig.baseUrl}/scrape`, {
    method: "POST",
    signal: AbortSignal.timeout(45000),
    headers: firecrawlConfig.headers,
    body: JSON.stringify({
      url,
      onlyMainContent: true,
      timeout: 30000,
      formats: [
        "markdown",
        {
          type: "json",
          prompt,
          schema,
        },
      ],
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`Firecrawl failed for ${url}: ${res.status} ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return {
    json: payload?.data?.json ?? null,
    markdown: typeof payload?.data?.markdown === "string" ? payload.data.markdown : "",
  };
}

async function discoverListPage(firecrawlConfig, url, config) {
  const htmlCandidates = await fetchHtmlUrlCandidates(url);
  const htmlCategoryUrls = filterUrls(htmlCandidates, config.categoryUrlPatterns);
  const htmlItemUrls = filterUrls(htmlCandidates, config.itemUrlPatterns);

  if (htmlCategoryUrls.length > 0 || htmlItemUrls.length > 0) {
    return {
      categoryUrls: htmlCategoryUrls,
      itemUrls: htmlItemUrls,
    };
  }

  const scrape = await firecrawlScrape(firecrawlConfig, url, buildDiscoveryPrompt(config), {
    type: "object",
    additionalProperties: false,
    properties: {
      categoryUrls: { type: "array", items: { type: "string" } },
      itemUrls: { type: "array", items: { type: "string" } },
    },
  });

  return {
    categoryUrls: filterUrls(
      [...(scrape.json?.categoryUrls ?? []), ...htmlCandidates],
      config.categoryUrlPatterns,
    ),
    itemUrls: filterUrls(
      [...(scrape.json?.itemUrls ?? []), ...htmlCandidates],
      config.itemUrlPatterns,
    ),
  };
}

function getFirecrawlConfig() {
  const baseUrl = normalizeFirecrawlBaseUrl(
    process.env.FIRECRAWL_BASE_URL || DEFAULT_FIRECRAWL_BASE_URL,
  );
  const authToken = process.env.FIRECRAWL_AUTH_TOKEN || process.env.FIRECRAWL_API_KEY;
  const authHeader = process.env.FIRECRAWL_AUTH_HEADER || "Authorization";
  const authScheme = process.env.FIRECRAWL_AUTH_SCHEME ?? "Bearer";

  const headers = {
    "Content-Type": "application/json",
  };

  if (authToken) {
    headers[authHeader] = authScheme.trim() ? `${authScheme.trim()} ${authToken}`.trim() : authToken;
  } else if (baseUrl === DEFAULT_FIRECRAWL_BASE_URL) {
    throw new Error("Missing FIRECRAWL_API_KEY or FIRECRAWL_AUTH_TOKEN");
  }

  return { baseUrl, headers };
}

function normalizeFirecrawlBaseUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_FIRECRAWL_BASE_URL;
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v2`;
}

async function fetchHtmlUrlCandidates(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HomegohanCatalogAudit/1.0; +https://homegohan.app)",
    },
  });
  if (!res.ok) {
    return [];
  }

  const html = await res.text();
  const urls = [];
  const seen = new Set();
  const pattern = /href=["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    let absolute;
    try {
      absolute = new URL(raw, url).toString();
    } catch {
      continue;
    }

    if (seen.has(absolute)) continue;
    seen.add(absolute);
    urls.push(absolute);
  }

  return urls;
}

function buildDiscoveryPrompt(config) {
  if (config.strategy === "news_feed_catalog") {
    return [
      "コンビニ系サイトの新商品 / お知らせ / 商品一覧ページです。",
      "次に辿るべき一覧ページや記事ページを categoryUrls に、商品詳細ページを itemUrls に抽出してください。",
      "絶対URLで返してください。",
      "商品でない一般サイトリンクは含めないでください。",
    ].join("\n");
  }

  return [
    "コンビニ商品サイトの一覧ページです。",
    "カテゴリやサブカテゴリの一覧ページURLを categoryUrls に、商品詳細ページURLを itemUrls に抽出してください。",
    "絶対URLで返してください。",
    "商品でない一般サイトリンクは含めないでください。",
  ].join("\n");
}

function buildDetailPrompt(config) {
  return [
    "コンビニ商品の詳細ページです。",
    "商品名を name に入れてください。",
    "栄養成分に該当するテキストがあれば nutritionText に入れてください。",
    "栄養、アレルギー、価格、販売地域まわりの本文があれば rawText に入れてください。",
    `brand=${config.brandName}`,
  ].join("\n");
}

function filterUrls(urls, patterns) {
  if (!Array.isArray(urls)) return [];
  const normalized = [];
  const seen = new Set();
  for (const raw of urls) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const url = raw.trim();
    if (patterns?.length && !patterns.some((pattern) => pattern.test(url))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  return normalized;
}

function sampleRandom(items, count) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

function scanMarkers(markdown, markers) {
  return Object.fromEntries(markers.map((marker) => [marker, markdown.includes(marker)]));
}

function classifyPageRole(depth, categoryCount) {
  if (depth === 0) return "root";
  if (categoryCount > 0) return "category";
  return "subcategory";
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv
      .filter((arg) => arg.startsWith("--"))
      .map((arg) => {
        const eq = arg.indexOf("=");
        if (eq === -1) return [arg.slice(2), "true"];
        return [arg.slice(2, eq), arg.slice(eq + 1)];
      }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
