/**
 * プランとお支払い (billing/03 §10.6。R15・R16)。アプリ内課金 (App Store / Google Play。RevenueCat) の購入の画面。
 *
 *  1. 見出し
 *  2. 現在の状態 (GET /api/billing/subscription の要約。出どころが Web (Stripe) なら Web で管理する旨、ストアなら購読の管理を開くボタン)
 *  3. プランの一覧 (購入できる人 (can_purchase) で、このビルドがストアの購入を扱えて、カタログとストアの両方にある商品があるときだけ)。
 *     価格はストアの表示 (priceString) をそのまま出し、自動更新の説明を添える。無料体験の文は、ストアの導入価格と体験の対象の判定から作る
 *  4. 購入 → サーバの同期 (POST /api/billing/iap/sync) → 要約を置き換える
 *  5. 購入の復元 (常に出す。ストアの購入を扱えないビルドでは押せない形)
 *  6. 利用規約・プライバシーポリシー・特定商取引法に基づく表記へのリンク
 *  7. 要約の読み込み中・失敗 (失敗のときは 2・3 を出さず、再読み込みのボタン)
 *
 * Web の購入のページへは誘導しない (__tests__/app/no-web-purchase-links.test.ts)。ストアやサーバの生の文は出さない (billing-api.ts の固定の文)。
 */
import {
  IAP_STORE_LABELS,
  PLAN_CATALOG,
  STORE_SUBSCRIPTION_MANAGEMENT_URL,
  isPurchaseStore,
  planDisplayName,
  subscriptionStatusLines,
  type BillingSummaryWire,
  type PurchaseStore,
} from "@homegohan/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, ScrollView, StyleSheet, View } from "react-native";

import { Button, Card, LoadingState, PageHeader } from "../../src/components/ui";
import { Text } from "../../src/components/ui/Text";
import {
  BILLING_PURCHASE_FAILED_MESSAGE,
  BILLING_SUMMARY_LOAD_FAILED_MESSAGE,
  billingErrorMessageOf,
  fetchBillingSummary,
  fetchIapCatalog,
  syncIapPurchases,
} from "../../src/lib/billing-api";
import { matchCatalogWithPackages, renewalText, type PurchasablePlanCard } from "../../src/lib/iap-catalog";
import {
  currentCustomerInfo,
  fetchOfferings,
  fetchTrialEligibility,
  identifyPurchases,
  isPurchasesAvailable,
  purchase,
  restore,
} from "../../src/lib/purchases";
import { getPrivacyUrl, getTermsUrl, webPageUrl } from "../../src/lib/siteConfig";
import { useAuth } from "../../src/providers/AuthProvider";
import { colors, spacing } from "../../src/theme";

/** 画面の見出し */
export const PLAN_SCREEN_TITLE = "プランとお支払い";
/** 購入が完了したときの文 */
export const PLAN_PURCHASE_COMPLETED_MESSAGE = "お申し込みが完了しました";
/** 購入の復元で、復元できる契約が無かったときの文 */
export const PLAN_RESTORE_NOTHING_MESSAGE = "復元できる購入がありませんでした";
/** 無料プランの利用者の現在の状態 */
export const PLAN_FREE_STATUS_TEXT = "無料プランをご利用中です";
/** Web (Stripe) で申し込んだ契約の出どころの文 (Web の画面へのリンクは出さない。R16) */
export const PLAN_STRIPE_SOURCE_TEXT =
  "Web でお申し込みのプランです。解約・お支払い方法の変更は Web の「プランとお支払い」から行えます。";
/** ストアの購読の管理を開くボタン */
export const PLAN_MANAGE_STORE_BUTTON_LABEL = "定期購読の管理を開く";
/** 購入の復元のボタン */
export const PLAN_RESTORE_BUTTON_LABEL = "購入を復元";
/** 要約の読み込みに失敗したときの、再読み込みのボタン */
export const PLAN_RELOAD_BUTTON_LABEL = "再読み込み";
/** 特定商取引法に基づく表記の Web のパス */
const LEGAL_NOTICE_WEB_PATH = "/legal";

/** 間隔ごとの購入のボタンの文 */
const INTERVAL_BUTTON_SUFFIX: Readonly<Record<"month" | "year", string>> = {
  month: "を月額で始める",
  year: "を年額で始める",
};

/** この端末のストア (iOS = App Store・Android = Google Play。それ以外はストアの購入を出さない) */
function deviceStore(): PurchaseStore | null {
  if (Platform.OS === "ios") return "app_store";
  if (Platform.OS === "android") return "play_store";
  return null;
}

/** 現在の状態の 1 行目 (§10.6 の 2)。live でない (status が null か終わった契約) ときは、いま効いているプランで書く */
function currentPlanText(summary: BillingSummaryWire, live: boolean): string {
  if (live) return `${planDisplayName(summary.plan_key)}をご利用中です`;
  if (summary.effective_plan_key === "free") return PLAN_FREE_STATUS_TEXT;
  return `${planDisplayName(summary.effective_plan_key)}をご利用中です (ご家族または組織のプラン)`;
}

export default function PlanSettingsScreen() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [summary, setSummary] = useState<BillingSummaryWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [cards, setCards] = useState<PurchasablePlanCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // 購入・復元の最中の二重押しを、再描画を待たずに止める
  const busyRef = useRef(false);
  // 同期 (並行して走る) が要約を先に置き換えたか。置き換えたあとに届いた最初の読み込みの結果で古い要約に戻さない
  const syncedSummaryRef = useRef(false);

  /** 要約を置き換え、読み込みの失敗の表示を消す */
  const applySummary = useCallback((next: BillingSummaryWire) => {
    setSummary(next);
    setLoadError(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 同期 (POST /api/billing/iap/sync) の結果で要約を置き換える。失敗しても画面は読んだ要約のまま */
  const syncQuietly = useCallback(async () => {
    try {
      const synced = await syncIapPurchases();
      if (!mountedRef.current) return;
      syncedSummaryRef.current = true;
      applySummary(synced);
    } catch {
      // 同期の失敗は画面に出さない (読んだ要約で描く)
    }
  }, [applySummary]);

  /** カタログ × ストアの offerings × 体験の対象の判定 → 買えるプランのカード。どれかが失敗したら空 (一覧を出さない) */
  const loadCards = useCallback(async () => {
    const store = deviceStore();
    if (store === null || !isPurchasesAvailable()) {
      if (mountedRef.current) setCards([]);
      return;
    }
    try {
      const plans = await fetchIapCatalog(store);
      const offerings = await fetchOfferings();
      const packages = offerings.current?.availablePackages ?? [];
      const eligibility = await fetchTrialEligibility(packages.map((pkg) => pkg.product.identifier));
      if (mountedRef.current) setCards(matchCatalogWithPackages(store, plans, packages, eligibility));
    } catch {
      if (mountedRef.current) setCards([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    if (userId !== null) {
      try {
        await identifyPurchases(userId);
      } catch {
        // 結び付けに失敗しても要約は読む (offerings の読み込みが失敗すれば一覧を出さない)
      }
    }
    // 要約の読み込みと並行して、ストアの契約の同期を 1 回走らせる (成功したら要約を置き換える)
    syncedSummaryRef.current = false;
    void syncQuietly();
    try {
      const loaded = await fetchBillingSummary();
      if (!mountedRef.current) return;
      if (!syncedSummaryRef.current) applySummary(loaded);
    } catch {
      if (!mountedRef.current) return;
      // 並行の同期が要約を読めていれば、それで描く
      if (!syncedSummaryRef.current) setLoadError(true);
      setLoading(false);
      return;
    }
    setLoading(false);
    await loadCards();
  }, [userId, syncQuietly, loadCards, applySummary]);

  useEffect(() => {
    void load();
  }, [load]);

  // アプリに戻ったとき (ストアの購読の管理から戻ったときなど) にもう一度同期する
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncQuietly();
    });
    return () => subscription.remove();
  }, [syncQuietly]);

  const startPurchase = useCallback(
    async (option: PurchasablePlanCard["options"][number]) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      try {
        let outcome: Awaited<ReturnType<typeof purchase>>;
        try {
          const offerings = await fetchOfferings();
          const pkg = (offerings.current?.availablePackages ?? []).find((item) => item.identifier === option.packageIdentifier);
          if (pkg === undefined) {
            if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
            return;
          }
          outcome = await purchase(pkg);
        } catch {
          // offerings の読み込みの失敗 (ストアの生の文は出さない)
          if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
          return;
        }
        if (!outcome.ok) {
          if (!outcome.cancelled && mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
          return;
        }
        try {
          const synced = await syncIapPurchases();
          if (mountedRef.current) {
            applySummary(synced);
            setNotice(PLAN_PURCHASE_COMPLETED_MESSAGE);
          }
        } catch (error) {
          if (mountedRef.current) setNotice(billingErrorMessageOf(error));
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [applySummary],
  );

  const startRestore = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      try {
        await restore();
      } catch {
        // ストアの復元の失敗 (ストアの生の文は出さない)
        if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
        return;
      }
      try {
        const synced = await syncIapPurchases();
        if (!mountedRef.current) return;
        applySummary(synced);
        if (synced.status === null) setNotice(PLAN_RESTORE_NOTHING_MESSAGE);
      } catch (error) {
        if (mountedRef.current) setNotice(billingErrorMessageOf(error));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [applySummary]);

  const openStoreManagement = useCallback(async (store: PurchaseStore) => {
    let url: string = STORE_SUBSCRIPTION_MANAGEMENT_URL[store];
    try {
      const info = await currentCustomerInfo();
      if (info?.managementURL) url = info.managementURL;
    } catch {
      // 読めなければストアの購読の管理のページ
    }
    await Linking.openURL(url);
  }, []);

  const statusLines = summary === null ? [] : subscriptionStatusLines(summary);
  // live な契約 (trialing・active・past_due・grace・paused) のときだけ状態の行が出る
  const live = statusLines.length > 0;
  const liveSource = live && summary !== null ? summary.source : null;
  const showCards = summary !== null && !loadError && summary.can_purchase && isPurchasesAvailable() && cards.length > 0;

  return (
    <View style={styles.container}>
      <PageHeader title={PLAN_SCREEN_TITLE} />
      <ScrollView contentContainerStyle={styles.content} testID="plan-screen">
        {loading && summary === null ? (
          <LoadingState />
        ) : loadError || summary === null ? (
          <Card testID="plan-load-error">
            <Text style={styles.body}>{BILLING_SUMMARY_LOAD_FAILED_MESSAGE}</Text>
            <Button variant="secondary" onPress={() => void load()} testID="plan-reload" style={styles.topGap}>
              {PLAN_RELOAD_BUTTON_LABEL}
            </Button>
          </Card>
        ) : (
          <>
            <Card testID="plan-current">
              <Text style={styles.currentTitle}>{currentPlanText(summary, live)}</Text>
              {statusLines.map((line) => (
                <Text key={line} style={styles.body}>
                  {line}
                </Text>
              ))}
              {liveSource === "stripe" ? (
                <Text style={[styles.body, styles.topGap]} testID="plan-source-stripe">
                  {PLAN_STRIPE_SOURCE_TEXT}
                </Text>
              ) : null}
              {liveSource !== null && isPurchaseStore(liveSource) ? (
                <View style={styles.topGap}>
                  <Text style={styles.body} testID="plan-source-store">
                    {`${IAP_STORE_LABELS[liveSource]} でお申し込みのプランです。`}
                  </Text>
                  <Button
                    variant="outline"
                    onPress={() => void openStoreManagement(liveSource)}
                    testID="plan-manage-store"
                    style={styles.topGap}
                  >
                    {PLAN_MANAGE_STORE_BUTTON_LABEL}
                  </Button>
                </View>
              ) : null}
            </Card>

            {showCards
              ? cards.map((card) => {
                  const features = PLAN_CATALOG.find((plan) => plan.plan_key === card.plan_key)?.features ?? [];
                  return (
                    <Card key={card.plan_key} testID={`plan-card-${card.plan_key}`}>
                      <Text style={styles.cardTitle}>{card.display_name}</Text>
                      {features.map((feature) => (
                        <Text key={feature} style={styles.feature}>
                          {`・${feature}`}
                        </Text>
                      ))}
                      {card.max_members !== null ? <Text style={styles.body}>{`${card.max_members} 人まで`}</Text> : null}
                      {card.options.map((option) => (
                        <View key={option.product_id} style={styles.option} testID={`plan-option-${card.plan_key}-${option.billing_interval}`}>
                          {option.trial !== null ? (
                            <View testID={`plan-trial-${card.plan_key}-${option.billing_interval}`}>
                              <Text style={styles.trialTitle}>{`${option.trial.lengthText}無料`}</Text>
                              <Text style={styles.body}>{`体験の終了後は ${option.priceString} が請求されます`}</Text>
                            </View>
                          ) : null}
                          <Text style={styles.price}>{option.priceString}</Text>
                          <Text style={styles.small}>{renewalText(option.billing_interval, option.priceString, option.trial)}</Text>
                          <Button
                            onPress={() => void startPurchase(option)}
                            disabled={busy}
                            testID={`plan-buy-${card.plan_key}-${option.billing_interval}`}
                            style={styles.topGap}
                          >
                            {`${card.display_name}${INTERVAL_BUTTON_SUFFIX[option.billing_interval]}`}
                          </Button>
                        </View>
                      ))}
                    </Card>
                  );
                })
              : null}
          </>
        )}

        {notice !== null ? (
          <Text style={styles.notice} testID="plan-notice">
            {notice}
          </Text>
        ) : null}

        <Button
          variant="secondary"
          onPress={() => void startRestore()}
          disabled={busy || !isPurchasesAvailable()}
          testID="plan-restore"
        >
          {PLAN_RESTORE_BUTTON_LABEL}
        </Button>

        <View style={styles.links}>
          <Text style={styles.link} onPress={() => void Linking.openURL(getTermsUrl())} testID="plan-terms" accessibilityRole="link">
            利用規約
          </Text>
          <Text style={styles.link} onPress={() => void Linking.openURL(getPrivacyUrl())} testID="plan-privacy" accessibilityRole="link">
            プライバシーポリシー
          </Text>
          <Text
            style={styles.link}
            onPress={() => void Linking.openURL(webPageUrl(LEGAL_NOTICE_WEB_PATH))}
            testID="plan-legal"
            accessibilityRole="link"
          >
            特定商取引法に基づく表記
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  currentTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: spacing.sm },
  feature: { fontSize: 13, color: colors.textLight, marginTop: 2 },
  body: { fontSize: 13, color: colors.textLight, marginTop: 2 },
  small: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  // 請求額はカードで最も大きい文字にする (ストアの審査の要件 P9)
  price: { fontSize: 24, fontWeight: "700", color: colors.text, marginTop: spacing.sm },
  trialTitle: { fontSize: 15, fontWeight: "700", color: colors.accent },
  option: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  notice: { fontSize: 14, color: colors.text, textAlign: "center" },
  topGap: { marginTop: spacing.sm },
  links: { gap: spacing.sm, alignItems: "center", paddingBottom: spacing["2xl"] },
  link: { fontSize: 13, color: colors.accent, textDecorationLine: "underline" },
});
