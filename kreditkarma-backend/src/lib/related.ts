// src/lib/related.ts
// Cross-sell links. Each endpoint's response carries a small `related` block
// naming what else answers a question THIS response raised — the URL and the
// price. Rules: max 3, only where genuinely relevant. An irrelevant upsell
// teaches an agent to ignore the field, so the builders below are only ever
// called from a context where the link actually follows from the data.

export interface RelatedLink {
  question: string;
  url: string;
  price: string;
}

const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://www.xrplhub.io";
const origin = () => PUBLIC_ORIGIN;

/** The free 300–850 score for an account. */
export function scoreLink(address: string): RelatedLink {
  return {
    question: "This account's 300–850 XRPLScore and 8-signal breakdown",
    url: `${origin()}/api/score/${address}`,
    price: "free",
  };
}

/** The full paid risk report — score + flags + recommendations + on-chain snapshot. */
export function reportLink(address: string): RelatedLink {
  return {
    question: "Full risk report for this account — flags, recommendations, on-chain snapshot",
    url: `${origin()}/api/x402/report?wallet=${address}`,
    price: "0.08 RLUSD (x402)",
  };
}

/** Every credential an account holds (free, live). */
export function credentialsAccountLink(address: string): RelatedLink {
  return {
    question: "Every XLS-70 credential this account holds",
    url: `${origin()}/api/credentials/account?address=${address}`,
    price: "free",
  };
}

/** The on-chain verification page for a wallet's XRPLScore credential. */
export function verifyPageLink(subject: string): RelatedLink {
  return {
    question: "On-chain verification page for this account's XRPLScore credential",
    url: `${origin()}/verify/wallet/${subject}`,
    price: "free",
  };
}

/** The paid, full-detail version of the MPT risk view. */
export function mptFullLink(issuanceId: string): RelatedLink {
  return {
    question: "Full issuer risk — account age, verified domain, credentials, Bithomp cross-check",
    url: `${origin()}/api/x402/usdc/mpt/${issuanceId}`,
    price: "0.01 USDC (x402, Base)",
  };
}

/** The free per-issuance risk view. */
export function mptIssuanceLink(issuanceId: string): RelatedLink {
  return {
    question: "Issuer powers and issuance facts for this MPT (clawback, freeze, require-auth, transferable)",
    url: `${origin()}/api/mpt/${issuanceId}`,
    price: "free",
  };
}

/** Everything one issuer has issued, plus their XRPLScore (free, from the index). */
export function mptIssuerLink(address: string): RelatedLink {
  return {
    question: "Every MPT this issuer has out, plus the issuer's XRPLScore",
    url: `${origin()}/api/mpt/issuer?address=${address}`,
    price: "free",
  };
}
