import "react-native-url-polyfill/auto";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name: keyof NodeJS.ProcessEnv): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[mobile] Missing env: ${name}. Set it in your shell or EAS Secrets (EXPO_PUBLIC_*)`
    );
  }
  return value;
}

const supabaseUrl = requireEnv("EXPO_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY");

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});



