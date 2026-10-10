"use client";

// 外国の AI 事業者への提供の同意: 「誰に・何を・何のために送るか」の説明部分 (T15 / #1154)
// 同意画面 (AiDataConsentModal) と設定ページ (settings/ai-consent) で同じ文面を使うために切り出している。
// 文面そのものは src/lib/ai/consent-config.ts の AI_CONSENT_COPY (弁護士の確認前の仮の文面)。

import { createElement, type ReactNode } from "react";
import {
  AI_CONSENT_COPY,
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_PROVIDER_INFO,
} from "@/lib/ai/consent-config";

export const consentColors = {
  bg: "#F7F6F3",
  card: "#FFFFFF",
  text: "#2D2D2D",
  textLight: "#4A4A4A",
  // WCAG AA のコントラストを満たす灰色 (ConfirmDeleteModal と同じ値)
  textMuted: "#6B6B6B",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  border: "#E8E8E8",
  danger: "#D64545",
  dangerLight: "#FDECEC",
  success: "#4C8A4C",
  successLight: "#EDF5ED",
} as const;

interface AiConsentDetailsProps {
  /** 見出しの階層。同意画面ではタイトルが h2 なので 3、設定ページではタイトルが h1 なので 2 */
  headingLevel?: 2 | 3;
}

function Section({ level, title, children }: { level: 2 | 3; title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 16 }}>
      {createElement(
        `h${level}`,
        { style: { fontSize: 13, fontWeight: 700, color: consentColors.text, margin: "0 0 6px" } },
        title,
      )}
      {children}
    </section>
  );
}

function BulletList({ items }: { items: readonly string[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: consentColors.textLight, lineHeight: 1.7 }}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function AiConsentDetails({ headingLevel = 3 }: AiConsentDetailsProps) {
  return (
    <div data-testid="ai-consent-details">
      <p style={{ fontSize: 13, color: consentColors.textLight, lineHeight: 1.7, margin: 0 }}>
        {AI_CONSENT_COPY.intro}
      </p>

      <Section level={headingLevel} title={AI_CONSENT_COPY.providersHeading}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {AI_CONSENT_PROVIDERS.map((provider) => {
            const info = AI_CONSENT_PROVIDER_INFO[provider];
            return (
              <li
                key={provider}
                data-testid={`ai-consent-provider-${provider}`}
                style={{
                  background: consentColors.bg,
                  borderRadius: 12,
                  padding: "10px 12px",
                  fontSize: 13,
                  color: consentColors.textLight,
                  lineHeight: 1.6,
                }}
              >
                <span style={{ fontWeight: 700, color: consentColors.text }}>{info.name}</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: consentColors.textMuted }}>
                  （{info.country}）
                </span>
                <div style={{ fontSize: 12, color: consentColors.textMuted }}>{info.usage}</div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section level={headingLevel} title={AI_CONSENT_COPY.dataHeading}>
        <BulletList items={AI_CONSENT_COPY.dataCategories} />
      </Section>

      <Section level={headingLevel} title={AI_CONSENT_COPY.purposesHeading}>
        <BulletList items={AI_CONSENT_COPY.purposes} />
      </Section>

      <Section level={headingLevel} title={AI_CONSENT_COPY.retentionHeading}>
        <p style={{ fontSize: 13, color: consentColors.textLight, lineHeight: 1.7, margin: 0 }}>
          {AI_CONSENT_COPY.retention}
        </p>
      </Section>
    </div>
  );
}
