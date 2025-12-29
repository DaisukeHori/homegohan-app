export type SupabaseLinkParams = {
  code?: string;
  access_token?: string;
  refresh_token?: string;
  type?: string;
  error?: string;
  error_description?: string;
};

export function extractSupabaseLinkParams(url: string): SupabaseLinkParams {
  const [beforeHash, hash = ""] = url.split("#");

  let queryParams = new URLSearchParams();
  try {
    const u = new URL(beforeHash);
    queryParams = u.searchParams;
  } catch {
    // ignore
  }

  const fragmentParams = new URLSearchParams(hash);

  const get = (key: string) => fragmentParams.get(key) ?? queryParams.get(key) ?? undefined;

  return {
    code: get("code"),
    access_token: get("access_token"),
    refresh_token: get("refresh_token"),
    type: get("type"),
    error: get("error"),
    error_description: get("error_description"),
  };
}



