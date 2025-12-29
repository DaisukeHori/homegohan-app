import { createHttpClient, type HttpClient } from "@homegohan/core";

import { supabase } from "./supabase";

let _api: HttpClient | null = null;

export function getApiBaseUrl(): string {
  const value = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!value) throw new Error(`[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL`);
  return value;
}

export function getApi(): HttpClient {
  if (_api) return _api;
  _api = createHttpClient({
    baseUrl: getApiBaseUrl(),
    getAccessToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
  });
  return _api;
}


