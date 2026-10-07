// src/lib/serviceContent.ts
// Content copy for the ONE transaction product still on the homepage: MPT issuance with a recorded backing declaration
// (it feeds the io.xrplhub.mpt.v1.declared credential and the MPT issuer-risk registry). The generic transaction builders and
// their /services pages were removed 2026-10-07 — XRPLHub keeps only products nobody else offers.
//
// This module has NO 'use client' and imports nothing React — it is plain data.

import { SERVICE_PRICE_USD } from '@/lib/servicePrices';

export const RAW_PRODUCTS = [
  { id:'mptissue', cat:'Token Issuer', emoji:'🎫', name:'Multi-Purpose Token (MPT) Issuance', featured:true, tag:'NEW', comingSoon:false, color:'#38bdf8',
    amendment:'MPTokenIssuanceCreate', tagline:'Tokenize on XRPL — a plain-English guide to what is permanent and what is not',
    desc:'Fill a form, tokenize on XRPL. You choose the supply cap, decimals, the 6 capability flags (we explain in plain English what each one lets you do TO holders — clawback means you can take the token back from anyone), and a backing declaration recorded on-ledger. Free preview shows the decoded transaction and exactly what is permanent, what you can lock, and what the issuer could still change — read live from the XRPL amendment state. Pay to build; you sign it in your own wallet.',
    aiDetail:'MPTokenIssuanceCreate is the only chance to set the flags, supply, scale, fee, and metadata. Supply and decimals never change, and a flag you switch on stays on; the rest is fixed only while the DynamicMPT amendment (XLS-94) stays inactive — once it is active the issuer can change it unless it is locked. A confirmation step states which case applies right now, read live from the ledger. Your backing declaration is written into the on-ledger metadata; XRPLHub publishes it but does not and cannot verify it. New issuances appear in the XRPLHub MPT registry automatically.',
    features:['Plain-English guide to all 6 flags','On-ledger backing declaration','Free preview of the decoded tx','Live confirmation: what is permanent vs changeable','Auto-listed in the MPT registry','You sign it in your own wallet'] },
] as const;

// The RLUSD (USD) price of every card comes from src/lib/servicePrices.ts — the SAME table the
// server verifies every payment against. There is no price (and no XRP price) typed in this file.
export const PRODUCTS = RAW_PRODUCTS.map((p) => ({ ...p, priceRLUSD: SERVICE_PRICE_USD[p.id] }));

// PRODUCTS is a heterogeneous array literal — not every entry has `tag`. Widen the element
// type so it is safely optional rather than a per-member union access.
export type Product = typeof PRODUCTS[number] & { tag?: string };
