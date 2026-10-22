/**
 * プランとお支払い (billing/03 §10.6。R15・R16)。アプリ内課金 (App Store / Google Play。RevenueCat) の購入の画面。
 *
 *  1. 見出し
 *  2. 現在の状態 (GET /api/billing/subscription の要約。出どころが Web (Stripe) なら Web で管理する旨、ストアなら購読の管理を開くボタン)
 *  3. プランの一覧 (購入できる人 (can_purchase) で、このビルドがストアの購入を扱えて、カタログとストアの両方にある商品があるときだけ)。
 *     価格はストアの表示 (priceString) をそのまま出し、自動更新の説明を添える。無料体験の文は、ストアの導入価格と体験の対象の判定から作る。
 *     ストアの購入をこの利用者に結び付けられない (identifyPurchases が投げた) うちは出さない (前面復帰・再読み込みでやり直す。#1912)
 *  4. 購入 → サーバの同期 (POST /api/billing/iap/sync) → 要約を置き換える。購入の前に SDK の利用者を確かめ (ensurePurchasesIdentity)、
 *     確かめられなければ買わない。完了の文は同期の要約が live のときだけ (#1912)
 *  5. 購入の復元 (常に出す。ストアの購入を扱えないビルドでは押せない形。復元の前にも SDK の利用者を確かめる)
 *  6. 利用規約・プライバシーポリシー・特定商取引法に基づく表記へのリンク
 *  7. 要約の読み込み中・失敗 (失敗のときは 2・3 を出さず、再読み込みのボタン)
 *
 * Web の購入のページへは誘導しない (__tests__/app/no-web-purchase-links.test.ts)。ストアやサーバの生の文は出さない (billing-api.ts の固定の文)。
 */
import {
  FAMILY_PLAN_STATUS_SUFFIX,
  IAP_STORE_LABELS,
  ORG_PLAN_DISPLAY_NAME,
  PAID_PLAN_GENERIC_DISPLAY_NAME,
  PLAN_CATALOG,
  STORE_SUBSCRIPTION_MANAGEMENT_URL,
  currentPlanDisplay,
  isPurchaseStore,
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
  ensurePurchasesIdentity,
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
/** 購入が完了したときの文 (購入のあとの同期で、この利用者の契約が live になったときだけ出す。#1912) */
export const PLAN_PURCHASE_COMPLETED_MESSAGE = "お申し込みが完了しました";
/**
 * 購入はストアで済んだが、そのあとの同期の要約が live でない (この利用者に契約が付いていない) ときの文 (#1912)。
 * 完了の文は出さず、購入の復元 (ストアの購入をこの利用者に移して同期し直す) を案内する
 */
export const PLAN_PURCHASE_NOT_REFLECTED_MESSAGE =
  "購入は受け付けましたが、契約の反映を確認できませんでした。「購入を復元」をお試しください。";
/** 購入の復元で、復元できる契約が無かったときの文 */
export const PLAN_RESTORE_NOTHING_MESSAGE = "復元できる購入がありませんでした";
/** 無料プランの利用者の現在の状態 */
export const PLAN_FREE_STATUS_TEXT = "無料プランをご利用中です";
/**
 * 組織のプランが効いている利用者 (自分の契約も家族も無く、いま効いているプランが組織のプランの値 (isOrgPlanKey)) の現在の状態。
 * 組織のプランの内部の値 (standard など) は出さない (#1912)。Web の契約の画面と同じ「組織のプラン」の語 (ORG_PLAN_DISPLAY_NAME)
 */
export const PLAN_ORG_STATUS_TEXT = `${ORG_PLAN_DISPLAY_NAME}をご利用中です`;
/**
 * いま効いているプランが free でも PLAN_CATALOG の key でも組織のプランの値でもない (家族の追加枠・運営が新しく作った個人や家族のプランなど) ときの
 * 現在の状態。内部の値は出さず、汎用の名前 PAID_PLAN_GENERIC_DISPLAY_NAME で書く (#1912)
 */
export const PLAN_GENERIC_STATUS_TEXT = `${PAID_PLAN_GENERIC_DISPLAY_NAME}をご利用中です`;
/** 家族のプラン (自分の契約は無く、家族のプランが効いている) の現在の状態の後ろに添える文 (#1912。Web の契約の画面と同じ @homegohan/shared の文) */
export const PLAN_FAMILY_STATUS_SUFFIX = FAMILY_PLAN_STATUS_SUFFIX;
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

/**
 * 現在の状態の 1 行目 (§10.6 の 2)。分岐は Web の契約の画面と同じ currentPlanDisplay (@homegohan/shared。#1912):
 * live のときは契約の plan_key の名前 (planDisplayName。PLAN_CATALOG に無い key も内部の値を出さない)。
 * live でない (status が null か終わった契約) ときは、いま効いているプランで書く: 組織のプランの値なら組織の固定の文、
 * PLAN_CATALOG の key (家族のプラン) ならその名前に「(ご家族のプラン)」を添え、どれでもない key は汎用の名前の文
 */
function currentPlanText(summary: BillingSummaryWire): string {
  const current = currentPlanDisplay(summary);
  switch (current.source) {
    case "own":
      return `${current.name}をご利用中です`;
    case "free":
      return PLAN_FREE_STATUS_TEXT;
    case "org":
      return PLAN_ORG_STATUS_TEXT;
    case "generic":
      return PLAN_GENERIC_STATUS_TEXT;
    case "family":
      return `${current.name}をご利用中です${PLAN_FAMILY_STATUS_SUFFIX}`;
  }
}

/** live な契約 (trialing・active・past_due・grace・paused) か。状態の行 (subscriptionStatusLines) が出るのと同じ判定 */
function isLiveSummary(summary: BillingSummaryWire): boolean {
  return subscriptionStatusLines(summary).length > 0;
}

/** 買えるプランのカードの読み込みの段 (#1912): idle = まだ (失敗したらここに戻り、前面復帰・再読み込みでやり直す) / loading = 読み込み中 / done = 読んだ */
type CardsLoadState = "idle" | "loading" | "done";

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
  // 要約を一度でも置き換えたか (要約が無いうちはカードを読まない)
  const hasSummaryRef = useRef(false);
  // ストアの購入 (RevenueCat) をこの利用者に結び付けられたか。結び付けられないうちはカードを読まない (#1912)
  const identityReadyRef = useRef(false);
  // カードの読み込みの段 (同期と要約の読み込みのどちらが先に要約を置き換えても、1 回だけ読む)
  const cardsLoadStateRef = useRef<CardsLoadState>("idle");

  /** 要約を置き換え、読み込みの失敗の表示を消す */
  const applySummary = useCallback((next: BillingSummaryWire) => {
    hasSummaryRef.current = true;
    setSummary(next);
    setLoadError(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * カタログ × ストアの offerings × 体験の対象の判定 → 買えるプランのカード。どれかが失敗したら空 (一覧を出さない)。
   * 読めた (このビルドで購入を扱えず空にしたときも含む) なら true、失敗なら false (前面復帰・再読み込みでやり直す)
   */
  const loadCards = useCallback(async (): Promise<boolean> => {
    const store = deviceStore();
    if (store === null || !isPurchasesAvailable()) {
      if (mountedRef.current) setCards([]);
      return true;
    }
    try {
      const plans = await fetchIapCatalog(store);
      const offerings = await fetchOfferings();
      const packages = offerings.current?.availablePackages ?? [];
      const eligibility = await fetchTrialEligibility(packages.map((pkg) => pkg.product.identifier));
      if (mountedRef.current) setCards(matchCatalogWithPackages(store, plans, packages, eligibility));
      return true;
    } catch {
      if (mountedRef.current) setCards([]);
      return false;
    }
  }, []);

  /**
   * 要約があり、カードをまだ読んでいなければ、この利用者に結び付けてからカードを読む (#1912)。
   * 結び付け (identifyPurchases) が失敗したらカードを読まない (前の利用者や匿名のままの SDK で買わせない)。
   * 要約の読み込みのあと・同期が要約を置き換えたあと・前面復帰のときに呼ぶ (同期だけが要約を読めたときもカードを出す。P4)
   */
  const ensureCards = useCallback(async () => {
    if (userId === null || !hasSummaryRef.current || cardsLoadStateRef.current !== "idle") return;
    cardsLoadStateRef.current = "loading";
    if (!identityReadyRef.current) {
      try {
        await identifyPurchases(userId);
        identityReadyRef.current = true;
      } catch {
        // 結び付けられない: カードを出さない。前面復帰・再読み込みでやり直す
        cardsLoadStateRef.current = "idle";
        if (mountedRef.current) setCards([]);
        return;
      }
    }
    const loaded = await loadCards();
    cardsLoadStateRef.current = loaded ? "done" : "idle";
  }, [userId, loadCards]);

  /** 同期 (POST /api/billing/iap/sync) の結果で要約を置き換え、カードがまだならカードも読む。失敗しても画面は読んだ要約のまま */
  const syncQuietly = useCallback(async () => {
    try {
      const synced = await syncIapPurchases();
      if (!mountedRef.current) return;
      syncedSummaryRef.current = true;
      applySummary(synced);
    } catch {
      // 同期の失敗は画面に出さない (読んだ要約で描く)
      return;
    }
    await ensureCards();
  }, [applySummary, ensureCards]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    // 開くたび・再読み込みのたびに結び付けからやり直す
    identityReadyRef.current = false;
    cardsLoadStateRef.current = "idle";
    // 要約の読み込みと並行して、ストアの契約の同期を 1 回走らせる (成功したら要約を置き換える)
    syncedSummaryRef.current = false;
    void syncQuietly();
    try {
      const loaded = await fetchBillingSummary();
      if (!mountedRef.current) return;
      if (!syncedSummaryRef.current) applySummary(loaded);
    } catch {
      if (!mountedRef.current) return;
      setLoading(false);
      // 並行の同期が要約を読めていなければ、失敗の表示 (カードは読まない)
      if (!syncedSummaryRef.current) {
        setLoadError(true);
        return;
      }
      // 並行の同期が要約を読めていれば、それで描き、カードも読む (P4)
      await ensureCards();
      return;
    }
    setLoading(false);
    await ensureCards();
  }, [syncQuietly, ensureCards, applySummary]);

  useEffect(() => {
    void load();
  }, [load]);

  // アプリに戻ったとき (ストアの購読の管理から戻ったときなど) にもう一度同期する。結び付けかカードの読み込みが失敗していれば、やり直す
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void syncQuietly();
      void ensureCards();
    });
    return () => subscription.remove();
  }, [syncQuietly, ensureCards]);

  const startPurchase = useCallback(
    async (option: PurchasablePlanCard["options"][number]) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      try {
        // 購入の前に、SDK の利用者がログイン中の利用者であることを確かめる。確かめられなければ買わない (#1912。ストアの生の文は出さない)
        if (userId === null) {
          if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
          return;
        }
        try {
          await ensurePurchasesIdentity(userId);
        } catch {
          if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
          return;
        }
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
            // この利用者に契約が付いた (live) ときだけ完了の文。付いていなければ購入の復元を案内する (#1912)
            setNotice(isLiveSummary(synced) ? PLAN_PURCHASE_COMPLETED_MESSAGE : PLAN_PURCHASE_NOT_REFLECTED_MESSAGE);
          }
        } catch (error) {
          if (mountedRef.current) setNotice(billingErrorMessageOf(error));
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [applySummary, userId],
  );

  const startRestore = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // 復元の前に、SDK の利用者がログイン中の利用者であることを確かめる。確かめられなければ復元しない (#1912)
      if (userId === null) {
        if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
        return;
      }
      try {
        await ensurePurchasesIdentity(userId);
      } catch {
        if (mountedRef.current) setNotice(BILLING_PURCHASE_FAILED_MESSAGE);
        return;
      }
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
        // live な契約が無い (status が null か、終わった契約) なら、復元できる購入が無かった旨 (#1912。黙って終えない)
        if (!isLiveSummary(synced)) setNotice(PLAN_RESTORE_NOTHING_MESSAGE);
      } catch (error) {
        if (mountedRef.current) setNotice(billingErrorMessageOf(error));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [applySummary, userId]);

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
              <Text style={styles.currentTitle}>{currentPlanText(summary)}</Text>
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
