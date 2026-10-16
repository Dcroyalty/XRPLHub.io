// src/app/grants/page.tsx — XRPLHub community grants: open, free, honest.
// The pool's balance is read live from the XRP Ledger. Applications are saved and reviewed in order once the pool
// reaches its first milestone; no timeline is promised before that. Donations: Xaman or card, disclosed plainly.
import type { Metadata } from "next";
import { readPool, paidFirstGrants, poolTotals, rlusdReceiveStatus } from "@/lib/grantsPool";
import { xrpUsd } from "@/lib/xrpPrice";
import { prisma } from "@/lib/xrplscore-db";
import { GRANTS_POOL, FIRST_MILESTONE_XRP, FIRST_MILESTONE_GRANTS, LONG_TERM_GOAL_XRP, APPLICANT_STATUS, PAYOUT_LINE } from "@/lib/grantsCopy";
import { GRANT_APPLICATIONS_OPEN, GRANTS_PAUSED_MESSAGE } from "@/lib/grantsStatus";
import GrantApplyForm from "@/components/grants/GrantApplyForm";
import DonateBox from "@/components/grants/DonateBox";
import SiteNav from "@/components/SiteNav";
import { B, S } from "@/components/brand";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "XRPLHub Community Grants: Apply Free, Donate, See Every Payment | XRPLHub",
  description: "Apply for a small XRP grant (free, never a fee). The grants pool's balance is live from the XRP Ledger, and every donation and every grant paid is published.",
  alternates: { canonical: "https://www.xrplhub.io/grants" },
};

type Props = { searchParams: Promise<{ donated?: string; card_error?: string }> };

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div style={{ margin: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: B.ink, marginBottom: 5, gap: 8 }}>
        <span>{label}</span>
        <span style={{ whiteSpace: "nowrap" }}>{Math.floor(value).toLocaleString("en-US")} / {max.toLocaleString("en-US")} XRP</span>
      </div>
      <div style={{ height: 10, borderRadius: 99, background: "rgba(255,255,255,.14)", overflow: "hidden" }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div style={{ width: `${pct}%`, height: "100%", background: B.accent }} />
      </div>
    </div>
  );
}

export default async function GrantsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const [pool, firstQueue, price] = await Promise.all([readPool(), paidFirstGrants(prisma).catch(() => []), xrpUsd().catch(() => null)]);
  const t = poolTotals(pool, price);
  const bal = t.xrpEquivalent; // milestones count RLUSD at the current XRP price
  const firstReady = await Promise.all(firstQueue.map((g) => rlusdReceiveStatus(g.walletAddress, g.approvedAmount ?? 0)));
  return (
    <div style={{ minHeight: "100vh", fontFamily: B.sans, color: B.ink }}>
      <SiteNav active="grants" />
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "22px 16px 60px" }}>
        <div style={S.eyebrow}>Community grants</div>
        <h1 style={{ fontFamily: B.serif, fontSize: "clamp(30px,7vw,46px)", color: B.white, margin: "6px 0 10px", lineHeight: 1.1 }}>
          Grants are open. Applying is free.
        </h1>
        <p style={{ fontSize: 17, color: B.ink, margin: "0 0 18px", lineHeight: 1.55 }}>
          Small grants for people who need help with rent, bills, food or school, paid in RLUSD (a US-dollar stablecoin). There is never a fee to apply.
          Every donation in and every grant out is <a href="/grants/ledger" style={{ color: B.accent }}>published</a>.
        </p>

        {sp.donated === "card" && <div style={{ ...S.card, borderColor: B.accent, marginBottom: 14 }}>Thank you for your card donation. It appears on the <a href="/grants/ledger" style={{ color: B.accent }}>donations page</a> within a few minutes.</div>}
        {sp.card_error && <div role="alert" style={{ ...S.card, borderColor: "#fca5a5", marginBottom: 14 }}>{sp.card_error}</div>}

        <section style={{ ...S.card, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={S.eyebrow}>Grants pool, live from the XRP Ledger</div>
              <div style={{ fontFamily: B.serif, fontSize: 40, color: B.white, fontWeight: 700, lineHeight: 1.1 }}>
                {pool.balanceXrp == null ? "—" : `${bal.toLocaleString("en-US", { maximumFractionDigits: 2 })} XRP`}
              </div>
              <div style={{ color: B.ink, fontSize: 15 }}>{t.usd == null ? "" : `≈ $${t.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · `}{t.rlusd.toLocaleString("en-US", { maximumFractionDigits: 2 })} RLUSD + {t.xrp.toLocaleString("en-US", { maximumFractionDigits: 2 })} XRP</div>
            </div>
            <a href={`https://xrpscan.com/account/${GRANTS_POOL}`} rel="noopener" style={{ color: B.accent, fontSize: 13, wordBreak: "break-all" }}>{GRANTS_POOL}</a>
          </div>
          <Bar value={bal} max={FIRST_MILESTONE_XRP} label={`First milestone: the first ${FIRST_MILESTONE_GRANTS} grants go out at ${FIRST_MILESTONE_XRP.toLocaleString("en-US")} XRP`} />
          <Bar value={bal} max={LONG_TERM_GOAL_XRP} label="Long-term goal" />
          <p style={{ margin: "8px 0 0", color: B.white, fontWeight: 700 }}>{PAYOUT_LINE}</p>
          <p style={{ ...S.small, margin: "6px 0 0" }}>Milestones count RLUSD at the current XRP price{price ? ` ($${price.toFixed(4)})` : ""}. Read {new Date(pool.readAt).toUTCString().slice(17, 22)} UTC. The pool&apos;s keys are held by its owner in Xaman; XRPLHub&apos;s servers can&apos;t move this money.</p>
        </section>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,360px),1fr))", gap: 16, alignItems: "start" }}>
          {GRANT_APPLICATIONS_OPEN ? <GrantApplyForm /> : <div style={S.card}>{GRANTS_PAUSED_MESSAGE}</div>}
          <div>
            <DonateBox rlusdEnabled={pool.rlusd.enabled} />
            <div style={{ ...S.card, marginTop: 16 }}>
              <div style={S.eyebrow}>How it works</div>
              <ol style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6, fontSize: 14 }}>
                <li>{APPLICANT_STATUS}</li>
                {firstQueue.length > 0 && <li>First in the queue: {firstQueue.length} grants approved in July 2026 (${firstQueue.reduce((s, g) => s + (g.approvedAmount ?? 0), 0)} in total, paid in RLUSD), marked &quot;approved, paid first&quot; and paid from the first donations.{firstReady.some((r) => !r.canReceive) ? " Waiting for the recipient to add an RLUSD trust line." : ""}</li>}
                <li>When the pool reaches {FIRST_MILESTONE_XRP.toLocaleString("en-US")} XRP, the first {FIRST_MILESTONE_GRANTS} grants are paid, in the order applications came in.</li>
                <li>A person reads every application. Grants are paid in RLUSD on the XRP Ledger, straight to your wallet, and published. Your wallet needs an RLUSD trust line.</li>
                <li>We never ask for a fee, your keys or your seed. Anyone who does is not us.</li>
              </ol>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
