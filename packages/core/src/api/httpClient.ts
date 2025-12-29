export type GetAccessToken = () => Promise<string | null> | string | null;

export type HttpClient = {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  del<T>(path: string, init?: RequestInit): Promise<T>;
};

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

async function buildHeaders(getAccessToken?: GetAccessToken, initHeaders?: HeadersInit) {
  const headers = new Headers(initHeaders);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  if (getAccessToken) {
    const token = await getAccessToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  return headers;
}

export function createHttpClient(config: {
  baseUrl: string;
  getAccessToken?: GetAccessToken;
}): HttpClient {
  const { baseUrl, getAccessToken } = config;

  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit) {
    const url = joinUrl(baseUrl, path);
    const headers = await buildHeaders(getAccessToken, init?.headers);

    const res = await fetch(url, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const message = (json && (json.error || json.message)) ? JSON.stringify(json) : text;
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${message}`);
    }

    return json as T;
  }

  return {
    get: (path, init) => request("GET", path, undefined, init),
    post: (path, body, init) => request("POST", path, body, init),
    put: (path, body, init) => request("PUT", path, body, init),
    patch: (path, body, init) => request("PATCH", path, body, init),
    del: (path, init) => request("DELETE", path, undefined, init),
  };
}



