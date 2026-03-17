const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";

interface FirecrawlFormat {
  type: string;
  prompt?: string;
  schema?: Record<string, unknown>;
}

interface FirecrawlScrapeResult {
  success?: boolean;
  data?: Record<string, unknown>;
}

type FirecrawlFormatRequest = string | FirecrawlFormat;

export async function firecrawlScrapeStructured<T>(
  url: string,
  options: {
    prompt: string;
    schema: Record<string, unknown>;
    timeout?: number;
    includeMarkdown?: boolean;
  },
): Promise<{ json: T | null; markdown: string | null; raw: FirecrawlScrapeResult }> {
  const { baseUrl, headers } = getFirecrawlConfig();

  const formats: FirecrawlFormatRequest[] = [];
  if (options.includeMarkdown) {
    formats.push("markdown");
  }
  formats.push({
    type: "json",
    prompt: options.prompt,
    schema: options.schema,
  } satisfies FirecrawlFormat);

  const body = {
    url,
    timeout: options.timeout ?? 30000,
    onlyMainContent: true,
    formats,
  };

  const response = await fetch(`${baseUrl}/scrape`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Firecrawl scrape failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return {
    json: payload?.data?.json && typeof payload.data.json === "object"
      ? payload.data.json as T
      : null,
    markdown: typeof payload?.data?.markdown === "string" ? payload.data.markdown : null,
    raw: payload as FirecrawlScrapeResult,
  };
}

function getFirecrawlConfig() {
  const baseUrl = normalizeFirecrawlBaseUrl(
    Deno.env.get("FIRECRAWL_BASE_URL") || DEFAULT_FIRECRAWL_BASE_URL,
  );
  const authToken = Deno.env.get("FIRECRAWL_AUTH_TOKEN") || Deno.env.get("FIRECRAWL_API_KEY");
  const authHeader = Deno.env.get("FIRECRAWL_AUTH_HEADER") || "Authorization";
  const authScheme = Deno.env.get("FIRECRAWL_AUTH_SCHEME") ?? "Bearer";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authToken) {
    headers[authHeader] = authScheme.trim() ? `${authScheme.trim()} ${authToken}`.trim() : authToken;
  } else if (baseUrl === DEFAULT_FIRECRAWL_BASE_URL) {
    throw new Error("Missing FIRECRAWL_API_KEY or FIRECRAWL_AUTH_TOKEN");
  }

  return { baseUrl, headers };
}

function normalizeFirecrawlBaseUrl(raw: string) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_FIRECRAWL_BASE_URL;
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v2`;
}

export async function firecrawlScrapeJson<T>(
  url: string,
  options: {
    prompt: string;
    schema: Record<string, unknown>;
    timeout?: number;
  },
): Promise<{ json: T; raw: FirecrawlScrapeResult }> {
  const result = await firecrawlScrapeStructured<T>(url, options);
  if (!result.json || typeof result.json !== "object") {
    throw new Error(`Firecrawl returned invalid json payload for ${url}`);
  }

  return {
    json: result.json,
    raw: result.raw,
  };
}
