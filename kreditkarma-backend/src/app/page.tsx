'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { watchXaman } from '@/lib/wallet/xamanWatch';
import { GRANT_APPLICATIONS_OPEN, GRANTS_PAUSED_TITLE, GRANTS_PAUSED_MESSAGE, GRANTS_DONATE_NOTE } from '@/lib/grantsStatus';
import WalletPicker from '@/lib/wallet/WalletPicker';
import XamanPayPrompt from '@/components/XamanPayPrompt';
import {
  getProvider as getWalletProvider,
  resolveProviderOptions,
  WalletCancelled,
  type ProviderOption,
} from '@/lib/wallet';

// BUILD_MARKER_2026_06_03_FINAL  // unique tag to verify this exact file shipped
const API_URL        = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) || '';
const TREASURY       = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';
const TREASURY_DOMAIN = 'xrplhub.xrp';
// Shown when a visitor taps "Get XRPLScore" without entering their own wallet.
// Ripple's RLUSD issuer — one of the best-behaved accounts on the ledger
// (~721 / Good under XRPLScore v1.1), so the demo showcases the top of the range.
// Always labelled as an example in the UI.
const DEMO_WALLET       = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const DEMO_WALLET_LABEL = 'Example wallet — Ripple’s RLUSD issuer';
const XAMAN_DL       = 'https://xaman.app/';
const BG             = '/xrpl-background.jpg';

// ─── TEST MODE ──────────────────────────────────────────────────────────
// While TEST_MODE = true, every product charges 0.000001 XRP (1 drop ≈ free)
// so you can run real Xaman swipes through every transaction family without
// burning real money. Card prices still SHOW the real prices.
// FLIP TO false BEFORE LAUNCH.
const TEST_MODE = false;
const TEST_PRICE_XRP   = 0.000001;
const TEST_PRICE_RLUSD = 0.01; // RLUSD has 2-decimal minimum on issuer; this is the smallest practical
// ────────────────────────────────────────────────────────────────────────

type Currency = 'RLUSD' | 'XRP';
// ─── Live pricing ───
// RLUSD is the list price. The XRP figure is derived SERVER-SIDE from the live XRP/USD rate
// (/api/pricing) — never typed here, never stale. If no live rate exists we show RLUSD only.
type PricingData = { xrpUsd: number | null; asOf: string | null; xrp: Record<string, number | null> };
let pricingCache: { data: PricingData; at: number } | null = null;
let pricingInflight: Promise<PricingData | null> | null = null;
const PRICING_TTL_MS = 5 * 60_000;
function loadPricing(): Promise<PricingData | null> {
  if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) return Promise.resolve(pricingCache.data);
  if (!pricingInflight) {
    pricingInflight = fetch('/api/pricing', { cache: 'no-store' })
      .then(r => r.json())
      .then((d: PricingData) => { pricingCache = { data: d, at: Date.now() }; return d; })
      .catch(() => null)
      .finally(() => { pricingInflight = null; });
  }
  return pricingInflight;
}
function usePricing(): PricingData | null {
  const [d, setD] = useState<PricingData | null>(pricingCache?.data ?? null);
  useEffect(() => { let live = true; loadPricing().then(x => { if (live && x) setD(x); }); return () => { live = false; }; }, []);
  return d;
}
const fmtXrp = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
/** "≈13.9 XRP", or null when there is no live rate (we then show RLUSD only, never a stale number). */
const xrpLabel = (pr: PricingData | null, id: string): string | null => {
  const v = pr?.xrp?.[id];
  return typeof v === 'number' ? `≈${fmtXrp(v)} XRP` : null;
};
const fmt   = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const trunc = (a: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';

// ─── Brand gradient: green -> blue, the same two colors as the hero wordmark
// (#10b981, #38bdf8). One shared constant so the header logo and the hero
// wordmark can never drift apart. No red — it clashed with the palette.
const BRAND_GRADIENT = 'linear-gradient(135deg,#10b981,#38bdf8)';
const brandGradientText: React.CSSProperties = {
  background: BRAND_GRADIENT,
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};

// ─── Wordmark: xrplHub.io in the brand green-to-blue gradient ───
function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span style={{ fontWeight: 900, letterSpacing: '-.5px', lineHeight: 1, fontSize: size, ...brandGradientText }}>
      xrplHub.io
    </span>
  );
}

// A function (not a constant) so the count is derived from the product table at render time.
const tickerLines = (): string[] => [
  'Check any XRP wallet free: a score from 300 to 850, built from its public history',
  'Give money with rules: an allowance your kids can only spend where you pick',
  'Pay a bill every week or month. You approve each payment in your own wallet. Cancel anytime.',
  'Look before you buy: see if a token\'s creator can freeze it or take it back',
  'XRPLHub never holds your money or your keys. You approve everything in your own wallet.',
  'Community Grants: a public treasury anyone can see. Applications are paused until it is funded.',
  'Donate to the grants treasury. Every payment in and out is public.',
  'Do more with your XRP. Check any wallet. Give money with rules. Look before you buy. Free.',
];

// ─── MPT ISSUANCE WITH A RECORDED BACKING DECLARATION (the one transaction product on this page) ───
import { PRODUCTS, type Product } from '@/lib/serviceContent';

// ─── EXECUTION FORM SCHEMA ───
// The fields the issuer fills so we build the exact MPTokenIssuanceCreate. The engine validates.
type PickerKind = 'checks'|'nfts'|'mpts'|'holders';
type ExecField = { key:string; label:string; placeholder?:string; type?:'text'|'number'|'select'|'picker'|'datetime'|'permissions'; options?:string[]; default?:string; help?:string; required?:boolean; pickerType?:PickerKind };
// Ripple epoch = seconds since 2000-01-01T00:00:00Z (946,684,800s after the Unix epoch) — same constant every server
// file that handles Ripple time defines locally (e.g. src/lib/lendingExposure.ts); used here only to turn a
// datetime-local picker into the raw seconds EscrowCreate.FinishAfter needs.
const RIPPLE_EPOCH_OFFSET = 946_684_800;
// Ripple's official RLUSD mainnet issuer (source of truth: src/lib/rlusd.ts RLUSD_ISSUER) — autofills the "…issuer"
// field when someone types RLUSD into a paired currency field, so they don't have to go find and paste it.
const WELL_KNOWN_ISSUERS: Record<string,string> = { RLUSD: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' };
const EXEC_FIELDS: Record<string, ExecField[]> = {
  mptissue: [
    { key:'name', label:'Token name', placeholder:'ACME Points', help:'Stored in on-ledger metadata (≤64 chars)', required:true },
    { key:'ticker', label:'Ticker', placeholder:'ACME', help:'1–6 letters/digits, stored in metadata', required:true },
    { key:'maximumAmount', label:'Maximum supply (hard cap)', type:'number', default:'1000000000', help:'Permanent in every case. Creating the token mints 0 — you distribute later with Send MPT.', required:true },
    { key:'assetScale', label:'Decimal places', type:'number', default:'0', help:'0–19. 2 = smallest unit is 0.01. Permanent in every case.' },
    { key:'metadataUrl', label:'Info URL (optional)', placeholder:'https://…', help:'Stored in metadata as weblink' },
    { key:'canTransfer', label:'Holders can transfer to each other', type:'select', options:['off','on'], default:'on', help:'OFF = closed-loop / store credit — holders can only send it back to you. ON is permanent; OFF may be switchable later — see the notice above.' },
    { key:'canTrade', label:'Holders can trade on the DEX/AMM', type:'select', options:['off','on'], default:'off', help:'ON is permanent; OFF may be switchable later — see the notice above.' },
    { key:'canEscrow', label:'Holders can escrow their balance', type:'select', options:['off','on'], default:'off', help:'ON is permanent; OFF may be switchable later — see the notice above.' },
    { key:'canLock', label:'⚠️ ISSUER POWER — you can freeze balances', type:'select', options:['off','on'], default:'off', help:'You could freeze one holder or every holder. ON is permanent; OFF may be switchable later — see the notice above.' },
    { key:'requireAuth', label:'⚠️ ISSUER POWER — you approve every holder', type:'select', options:['off','on'], default:'off', help:'Nobody can hold it until you authorize their account. ON is permanent; OFF may be switchable later — see the notice above.' },
    { key:'canClawback', label:'⚠️ ISSUER POWER — you can claw the token back', type:'select', options:['off','on'], default:'off', help:'You could take the token back from any holder, anytime, without their consent. ON is permanent; OFF may be switchable later — see the notice above.' },
    { key:'transferFee', label:'Secondary-sale fee %', type:'number', default:'0', help:'0–50%. Requires "holders can transfer" ON. Permanent.' },
    { key:'backingType', label:'What backs this token?', type:'select', options:['none','physical-custody','legal-entity','other-onchain','self-declared'], default:'none', help:'Declared on-ledger. XRPLHub does NOT verify this.' },
    { key:'backingStatement', label:'Backing statement', placeholder:'e.g. 1:1 USD held at …', help:'What you claim backs it. Required unless backing = none. A claim is not evidence.' },
    { key:'verifiedBy', label:'Backing verified by (optional)', placeholder:'e.g. an auditor', help:'Who verifies it, if anyone. Never XRPLHub.' },
    { key:'redeemable', label:'Redeemable for the underlying?', type:'select', options:['unspecified','yes','no'], default:'unspecified', help:'Can a holder exchange the token for what backs it?' },
  ],
};

interface ScoreData { ledgerScore: number; grade?: string; details?: { txCount?: number; accountAge?: number; balanceXRP?: number; trustLines?: number; hasOffers?: boolean; hasAMM?: boolean }; scannedAt?: string }
interface User { email: string; name: string }

function gradeScore(n: number) {
  if (n >= 800) return { label:'Exceptional', color:'#10b981', glow:'rgba(16,185,129,.55)' };
  if (n >= 740) return { label:'Excellent',   color:'#34d399', glow:'rgba(52,211,153,.5)'  };
  if (n >= 670) return { label:'Good',         color:'#fbbf24', glow:'rgba(251,191,36,.5)'  };
  if (n >= 580) return { label:'Fair',          color:'#f97316', glow:'rgba(249,115,22,.5)'  };
  return              { label:'Building',       color:'#ef4444', glow:'rgba(239,68,68,.5)'   };
}

const GLASS: React.CSSProperties = { background:'rgba(6,6,22,.72)', backdropFilter:'blur(22px)', WebkitBackdropFilter:'blur(22px)', border:'1px solid rgba(255,255,255,.09)' };
const INP: React.CSSProperties   = { width:'100%', background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.13)', borderRadius:12, padding:'12px 15px', fontSize:14, color:'#fff', outline:'none', fontFamily:'inherit', boxSizing:'border-box', transition:'border-color .15s' };
const LBL: React.CSSProperties   = { display:'block', fontSize:10, fontWeight:700, color:'rgba(255,255,255,.32)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:6 };

// Product tag pill — HOT/POPULAR/SALE/NEW. Position absolute on a card.
function tagStyle(tag: string, prodColor: string, pos: React.CSSProperties): React.CSSProperties {
  const palette: Record<string,{bg:string;fg:string;sh:string}> = {
    HOT:     { bg:'#ef4444', fg:'#fff', sh:'0 0 14px rgba(239,68,68,.55)' },
    POPULAR: { bg:'#f59e0b', fg:'#000', sh:'0 0 14px rgba(245,158,11,.5)' },
    SALE:    { bg:'#10b981', fg:'#000', sh:'0 0 14px rgba(16,185,129,.55)' },
    NEW:     { bg:'#38bdf8', fg:'#000', sh:'0 0 14px rgba(56,189,248,.55)' },
    '#1':    { bg:'#fde047', fg:'#000', sh:'0 0 16px rgba(253,224,71,.7)' },
    '#2':    { bg:'#e5e7eb', fg:'#000', sh:'0 0 14px rgba(229,231,235,.5)' },
    '#3':    { bg:'#fb923c', fg:'#000', sh:'0 0 14px rgba(251,146,60,.55)' },
  };
  const c = palette[tag.toUpperCase()] || { bg:prodColor, fg:'#000', sh:`0 0 14px ${prodColor}66` };
  return {
    position:'absolute', zIndex:2,
    background:c.bg, color:c.fg, fontWeight:900, letterSpacing:'.1em',
    textTransform:'uppercase', borderRadius:99, fontFamily:"'IBM Plex Mono',monospace",
    boxShadow:c.sh, ...pos,
  };
}

function Btn(v: 'green'|'ghost'|'color', color?: string, extra?: React.CSSProperties): React.CSSProperties {
  const base: React.CSSProperties = { display:'inline-flex', alignItems:'center', justifyContent:'center', gap:7, border:'none', borderRadius:99, fontWeight:700, fontSize:14, cursor:'pointer', fontFamily:'inherit', padding:'12px 26px', transition:'all .18s', ...extra };
  if (v === 'green') return { ...base, background:'#10b981', color:'#000' };
  if (v === 'color') return { ...base, background:color||'#10b981', color:'#000' };
  return { ...base, background:'rgba(255,255,255,.08)', color:'#fff', border:'1px solid rgba(255,255,255,.14)' };
}

function TickerBar() {
  const Half = () => (
    <div style={{ display:'flex', flexShrink:0 }}>
      {tickerLines().map((m, i) => (
        <span key={`${m}-${i}`} style={{ display:'inline-flex', alignItems:'center', gap:12, padding:'0 26px', fontSize:12, fontWeight:700, letterSpacing:'.06em', color:'#fff', fontFamily:"'IBM Plex Mono',monospace", textTransform:'uppercase' }}>
          <span style={{ width:6, height:6, borderRadius:'50%', background:'#10b981', boxShadow:'0 0 10px #10b981', flexShrink:0 }} />
          <span style={{ whiteSpace:'nowrap' }}>{m}</span>
        </span>
      ))}
    </div>
  );
  return (
    <div style={{ overflow:'hidden', width:'100%', maxWidth:'100%', background:'linear-gradient(90deg,rgba(16,185,129,.10),rgba(56,189,248,.07),rgba(16,185,129,.10))', borderBottom:'1px solid rgba(16,185,129,.22)', zIndex:50 }}>
      <div className="ticker-track" style={{ display:'flex', width:'max-content', padding:'10px 0', animation:'tickerScroll 90s linear infinite' }}>
        <Half />
        <Half />
      </div>
    </div>
  );
}

function Overlay({ show, onClose, children, wide=false }: { show:boolean; onClose:()=>void; children:React.ReactNode; wide?:boolean }) {
  useEffect(() => {
    if (!show) return;
    document.body.style.overflow = 'hidden';
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => { window.removeEventListener('keydown', fn); document.body.style.overflow = ''; };
  }, [show, onClose]);
  if (!show) return null;
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(0,0,0,.9)', backdropFilter:'blur(14px)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ ...GLASS, borderRadius:26, padding:'32px 28px', width:'100%', maxWidth:wide?700:520, position:'relative', animation:'popIn .26s cubic-bezier(.34,1.56,.64,1) both', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 0 80px rgba(16,185,129,.08),0 40px 100px rgba(0,0,0,.85)' }}>
        <button onClick={onClose} style={{ position:'absolute', top:16, right:16, width:32, height:32, borderRadius:'50%', background:'rgba(255,255,255,.08)', border:'none', color:'rgba(255,255,255,.6)', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>✕</button>
        {children}
      </div>
    </div>
  );
}

// ─── MPT ISSUER-POWER CHECK ───
// What can this issuer DO to a holder? Reads the free registry search (/api/mpt/search: issuance id, prefix,
// issuer address or token name) and shows each match's on-ledger issuer powers. The live per-issuance view
// (and the paid full issuer-risk view) are linked, not duplicated here.
type MptHit = {
  issuanceId: string; issuer: string; name: string|null; ticker: string|null; holderCount?: number|null;
  issuerPowers: { clawback:boolean; canFreeze:boolean; currentlyFrozen:boolean; requiresAuth:boolean; transferable:boolean; canTrade?:boolean };
};
function MptPowerCheck() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [hits, setHits] = useState<MptHit[] | null>(null);
  const run = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true); setErr(''); setHits(null);
    try {
      const r = await fetch(`/api/mpt/search?q=${encodeURIComponent(query)}`);
      const j = await r.json();
      if (!r.ok) { setErr(j?.message || 'Search failed.'); return; }
      setHits((j.results ?? []).slice(0, 5));
    } catch { setErr('Could not run the check. Try again.'); }
    finally { setBusy(false); }
  };
  const chip = (on: boolean, label: string, bad: boolean) => (
    <span key={label} style={{ fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:99,fontFamily:"'IBM Plex Mono',monospace",
      background: on === bad ? 'rgba(239,68,68,.14)' : 'rgba(16,185,129,.12)', color: on === bad ? '#f87171' : '#34d399',
      border:`1px solid ${on === bad ? 'rgba(239,68,68,.3)' : 'rgba(16,185,129,.28)'}` }}>{label}: {on ? 'yes' : 'no'}</span>
  );
  return (
    <div>
      <div style={{ display:'flex',gap:8,flexWrap:'wrap' }}>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&run()} placeholder="Paste the token's ID or name"
          style={{ ...INP,flex:1,minWidth:180,borderRadius:99,paddingLeft:18,fontFamily:"'IBM Plex Mono',monospace",fontSize:12 }} />
        <button onClick={run} disabled={busy} style={{ padding:'11px 20px',borderRadius:99,background:'#f59e0b',color:'#000',border:'none',fontWeight:800,fontSize:13,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap' }}>{busy ? 'Checking…' : 'Check →'}</button>
      </div>
      {err && <p style={{ fontSize:12,color:'#f87171',marginTop:10 }}>{err}</p>}
      {hits && hits.length === 0 && <p style={{ fontSize:12,color:'rgba(255,255,255,.5)',marginTop:10 }}>We couldn't find a tokenized asset by that name. Try pasting its full ID (48 characters).</p>}
      {hits && hits.map(h => (
        <div key={h.issuanceId} style={{ marginTop:12,padding:'12px 14px',borderRadius:14,background:'rgba(0,0,0,.28)',border:'1px solid rgba(255,255,255,.08)' }}>
          <div style={{ fontSize:13,fontWeight:800,marginBottom:4 }}>{h.name || h.ticker || 'Unnamed token'}{h.ticker && h.name ? ` · ${h.ticker}` : ''}</div>
          <div style={{ fontSize:10,color:'rgba(255,255,255,.4)',fontFamily:"'IBM Plex Mono',monospace",marginBottom:8,wordBreak:'break-all' }}>{h.issuanceId} · creator {h.issuer.slice(0,8)}…{h.issuer.slice(-4)}{typeof h.holderCount === 'number' ? ` · ${h.holderCount} holders` : ''}</div>
          <div style={{ display:'flex',gap:6,flexWrap:'wrap',marginBottom:8 }}>
            {chip(h.issuerPowers.clawback, 'Can take it back', true)}
            {chip(h.issuerPowers.canFreeze, 'Can freeze it', true)}
            {chip(h.issuerPowers.currentlyFrozen, 'Frozen now', true)}
            {chip(h.issuerPowers.requiresAuth, 'You must ask to hold it', true)}
            {chip(h.issuerPowers.transferable, 'You can send it to others', false)}
          </div>
          <a href={`/api/mpt/${h.issuanceId}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11,color:'#f59e0b',fontWeight:700,textDecoration:'none' }}>Full details ↗</a>
        </div>
      ))}
    </div>
  );
}

// ─── TREASURY STATS LIVE COUNTER ───
// Reads /api/treasury-stats once per page view. Field names match the route:
// totalXRP · spendableXRP · reservedXRP · totalUSD · xrpContributed · grantsFunded.
function TreasuryStatsBar() {
  type TStats = {
    totalXRP:number; spendableXRP:number; reservedXRP:number; totalUSD:string|null;
    received:number|null; internal:number|null; internalN:number|null; dustN:number|null; complete:boolean|null;
    grantsPaid:number|null; paidTotals:{ currency:string; amount:number }[]|null; awaiting:number|null;
  };
  const [stats, setStats] = useState<TStats|null>(null);
  const [statsError, setStatsError] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/treasury-stats`, { cache: 'no-store' });
        if (!res.ok) { console.error('[TreasuryStatsBar] non-OK response', res.status); if (!stop) setStatsError(true); return; }
        const d = await res.json();
        if (!stop) {
          setStats({
            totalXRP:     Number(d.totalXRP || 0),
            spendableXRP: Number(d.spendableXRP || 0),
            reservedXRP:  Number(d.reservedXRP || 0),
            totalUSD:     typeof d.totalUSD === 'string' ? d.totalUSD : null,   // null = no live rate: say so, don't guess
            received:     typeof d.xrpReceivedExternal === 'number' ? d.xrpReceivedExternal : null,
            internal:     typeof d.xrpReceivedInternal === 'number' ? d.xrpReceivedInternal : null,
            internalN:    typeof d.internalPayments === 'number' ? d.internalPayments : null,
            dustN:        typeof d.dustPayments === 'number' ? d.dustPayments : null,
            complete:     typeof d.historyComplete === 'boolean' ? d.historyComplete : null,
            grantsPaid:   typeof d.grantsPaid === 'number' ? d.grantsPaid : null,
            paidTotals:   Array.isArray(d.grantsPaidTotals) ? d.grantsPaidTotals : null,
            awaiting:     typeof d.grantsAwaitingFunds === 'number' ? d.grantsAwaitingFunds : null,
          });
          setStatsError(d.source === 'error');
        }
      } catch (e) { console.error('[TreasuryStatsBar] fetch failed', e); if (!stop) setStatsError(true); }
    };
    load();
    return () => { stop = true; };
  }, []);
  const fmt = (n:number) => n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits:0 }) : n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const fmtCount = (n:number) => n.toLocaleString('en-US', { maximumFractionDigits:0 });
  const Cell = ({ label, value, suffix, color }: { label:string; value:string; suffix?:string; color:string }) => (
    <div style={{ flex:1, minWidth:130, textAlign:'center', padding:'14px 10px' }}>
      <div style={{ fontSize:11,fontWeight:700,color:'rgba(255,255,255,.36)',letterSpacing:'.11em',textTransform:'uppercase',marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:'clamp(18px,2.2vw,24px)',fontWeight:900,color,fontFamily:"'IBM Plex Mono',monospace" }}>
        {value}{suffix && <span style={{ fontSize:11,fontWeight:600,color:'rgba(255,255,255,.4)',marginLeft:5 }}>{suffix}</span>}
      </div>
    </div>
  );
  return (
    <div style={{ background:'linear-gradient(135deg,rgba(139,92,246,.07),rgba(16,185,129,.06),rgba(6,6,22,.85))',border:'1px solid rgba(139,92,246,.22)',borderRadius:18,padding:'4px 10px',marginBottom:24,backdropFilter:'blur(20px)' }}>
      <div style={{ display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'center',gap:0 }}>
        <Cell label="Treasury Total"  value={stats ? fmt(stats.totalXRP) : '—'}       suffix="XRP" color="#10b981" />
        <Cell label="Spendable"       value={stats ? fmt(stats.spendableXRP) : '—'}   suffix="XRP" color="#34d399" />
        <Cell label="Reserved"        value={stats ? fmt(stats.reservedXRP) : '—'}    suffix="XRP" color="rgba(255,255,255,.5)" />
        <Cell label="Received from outside" value={stats && stats.received != null ? `${stats.complete === false ? '≥' : ''}${fmt(stats.received)}` : '—'} suffix="XRP" color="#38bdf8" />
        <Cell label="Grants paid"   value={stats && stats.grantsPaid != null ? fmtCount(stats.grantsPaid) : '—'}           color="#8b5cf6" />
      </div>
      {stats && (
        <div style={{ textAlign:'center', fontSize:10, color:'rgba(255,255,255,.28)', paddingBottom:4 }}>
          {stats.totalUSD ? `Total ${stats.totalUSD} · ` : 'USD value unavailable right now · '}{fmt(stats.reservedXRP)} XRP locked as the XRPL account reserve
        </div>
      )}
      {stats && (
        <div style={{ textAlign:'center', fontSize:10, color:'rgba(255,255,255,.28)', padding:'0 12px 4px', lineHeight:1.6 }}>
          &ldquo;Received from outside&rdquo; = inbound XRP payments from wallets other than XRPLHub&apos;s own, dust excluded — donations and service payments both count.
          {stats.internal != null && stats.internalN != null && stats.internalN > 0 ? ` It excludes ${fmt(stats.internal)} XRP (${stats.internalN} payments) of XRPLHub&apos;s own transfers` : ''}
          {stats.dustN ? ` and ${stats.dustN} dust deposits` : ''}{stats.internal != null && stats.internalN ? '.' : ''}
        </div>
      )}
      {stats && stats.grantsPaid != null && (
        <div style={{ textAlign:'center', fontSize:10, color:'rgba(255,255,255,.28)', padding:'0 12px 4px', lineHeight:1.6 }}>
          Grants paid: {stats.grantsPaid}{stats.paidTotals && stats.paidTotals.length ? ` (${stats.paidTotals.map(t => `${t.amount} ${t.currency}`).join(', ')} paid out in total)` : ''}
          {stats.awaiting ? ` · ${stats.awaiting} approved grant${stats.awaiting === 1 ? '' : 's'} awaiting funds` : ''}
        </div>
      )}
      {(statsError || !stats) && (
        <div style={{ textAlign:'center', fontSize:10, color:'rgba(255,255,255,.3)', paddingBottom:6 }}>
          {stats ? 'Live figures may be delayed — retrying…' : 'Loading live figures…'}
        </div>
      )}
      <div style={{ display:'flex',flexWrap:'wrap',justifyContent:'center',gap:14,padding:'4px 0 10px' }}>
        <a href={`https://xrpscan.com/account/${TREASURY}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:10,fontWeight:700,color:'rgba(255,255,255,.45)',letterSpacing:'.13em',textTransform:'uppercase',textDecoration:'none',display:'inline-flex',alignItems:'center',gap:6 }}>
          <span style={{ width:5,height:5,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 8px #10b981',animation:'pulse 2s infinite' }} />
          Live on XRPL ↗
        </a>
        <span style={{ fontSize:10,fontWeight:700,color:'rgba(255,255,255,.45)',letterSpacing:'.13em',textTransform:'uppercase',display:'inline-flex',alignItems:'center',gap:6 }}>
          🟢 Pay to <strong style={{ color:'#10b981',fontFamily:"'IBM Plex Mono',monospace" }}>xrplhub.xrp</strong>
        </span>
      </div>
    </div>
  );
}

// ─── CONNECT WALLET MODAL (real Xaman SignIn) ───
function ConnectWalletModal({ show, onClose, onConnected }: { show:boolean; onClose:()=>void; onConnected:(a:string)=>void }) {
  const [status, setStatus] = useState<'idle'|'creating'|'waiting'|'done'>('idle');
  const [uuid, setUuid]     = useState('');
  const [qrUrl, setQrUrl]   = useState('');
  const [deepLnk, setDeepLnk] = useState('');
  const [error, setError]   = useState('');
  const cancelRef = useRef(false);
  const pollRef   = useRef<ReturnType<typeof setTimeout>|null>(null);

  const initiate = async () => {
    setStatus('creating'); setError(''); cancelRef.current = false;
    try {
      const res  = await fetch(`${API_URL}/api/connect-wallet`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const data = await res.json();
      if (!res.ok || !data.uuid) throw new Error(data.error || 'Failed to create connection');
      setUuid(data.uuid); setQrUrl(data.qr_png); setDeepLnk(data.deep_link); setStatus('waiting');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Connection failed'); setStatus('idle');
    }
  };

  useEffect(() => { if (show && status === 'idle' && !error) initiate(); }, [show]); // eslint-disable-line

  useEffect(() => {
    if (status !== 'waiting' || !uuid) return;
    cancelRef.current = false;
    const xw = watchXaman(uuid, () => { if (pollRef.current) clearTimeout(pollRef.current); poll(); });
    const poll = async () => {
      if (cancelRef.current) return;
      try {
        const res  = await fetch(`${API_URL}/api/check-wallet?uuid=${uuid}`);
        const data = await res.json();
        if (cancelRef.current) return;
        if (data.status === 'connected' && data.address) {
          setStatus('done'); onConnected(data.address);
          setTimeout(() => handleClose(), 1200);
        } else if (data.status === 'expired') { setStatus('idle'); setError('Connection expired. Tap Try Again.'); }
        else if (data.status === 'rejected') { setStatus('idle'); setError('Connection declined in Xaman.'); }
        else { pollRef.current = setTimeout(poll, xw.delay()); }
      } catch { if (!cancelRef.current) pollRef.current = setTimeout(poll, xw.delay()); }
    };
    poll();
    return () => { cancelRef.current = true; xw.stop(); if (pollRef.current) clearTimeout(pollRef.current); };
  }, [status, uuid]); // eslint-disable-line

  const handleClose = () => {
    cancelRef.current = true; if (pollRef.current) clearTimeout(pollRef.current);
    onClose(); setTimeout(() => { setStatus('idle'); setUuid(''); setQrUrl(''); setDeepLnk(''); setError(''); }, 300);
  };

  return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>🔐</div>
        <h3 style={{ fontSize:22, fontWeight:900, marginBottom:6 }}>Connect Xaman Wallet</h3>
        <p style={{ fontSize:13, color:'rgba(255,255,255,.45)', marginBottom:20, lineHeight:1.6 }}>
          Prove wallet ownership with one tap.<br />No transaction sent. No funds leave your wallet.
        </p>
        {status === 'creating' && (
          <div style={{ padding:'24px 0' }}>
            <div style={{ width:50, height:50, borderRadius:'50%', background:'rgba(16,185,129,.15)', border:'2px solid rgba(16,185,129,.4)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px', fontSize:22, animation:'spin 1.5s linear infinite' }}>⚡</div>
            <p style={{ color:'#10b981', fontWeight:700, fontSize:14 }}>Creating secure connection…</p>
          </div>
        )}
        {status === 'waiting' && (
          <>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, background:'rgba(16,185,129,.08)', border:'1px solid rgba(16,185,129,.25)', borderRadius:12, padding:'10px 16px', marginBottom:16 }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:'#10b981', boxShadow:'0 0 12px #10b981', animation:'pulse 1.4s infinite' }} />
              <span style={{ fontSize:13, fontWeight:700, color:'#10b981' }}>Waiting for Xaman…</span>
            </div>
            <div style={{ marginBottom:18 }}>
              <XamanPayPrompt theme="light" mode="signin" qrPng={qrUrl} deepLink={deepLnk} uuid={uuid} />
            </div>
            <div style={{ textAlign:'left', background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.07)', borderRadius:14, padding:'14px 18px' }}>
              {[['1','Scan the QR or tap "Open in Xaman"'],['2','Approve the connection request'],['3','Done — wallet linked instantly']].map(([n,t]) => (
                <div key={n} style={{ display:'flex', alignItems:'flex-start', gap:12, marginBottom:n==='3'?0:10 }}>
                  <span style={{ width:22, height:22, borderRadius:'50%', background:'rgba(16,185,129,.2)', border:'1px solid rgba(16,185,129,.4)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:'#10b981', flexShrink:0 }}>{n}</span>
                  <span style={{ fontSize:13, color:'rgba(255,255,255,.6)', lineHeight:1.5, paddingTop:2 }}>{t}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {status === 'done' && (
          <div style={{ padding:'20px 0' }}>
            <div style={{ fontSize:50, marginBottom:10 }}>✅</div>
            <p style={{ color:'#10b981', fontWeight:800, fontSize:18 }}>Wallet Connected!</p>
          </div>
        )}
        {error && status === 'idle' && (
          <div style={{ background:'rgba(248,113,113,.08)', border:'1px solid rgba(248,113,113,.3)', borderRadius:12, padding:'14px 18px', marginBottom:16 }}>
            <p style={{ fontSize:13, color:'#fca5a5', marginBottom:10 }}>⚠️ {error}</p>
            <button onClick={initiate} style={{ ...Btn('green', undefined, { width:'100%', padding:'12px' }) }}>Try Again →</button>
          </div>
        )}
        {status !== 'done' && <button onClick={handleClose} style={{ ...Btn('ghost', undefined, { width:'100%', marginTop:12, fontSize:13 }) }}>Cancel</button>}
      </div>
    </Overlay>
  );
}

function DateTimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState('');
  const handle = (v: string) => {
    setLocal(v);
    if (!v) { onChange(''); return; }
    const ms = new Date(v).getTime();
    if (Number.isNaN(ms)) { onChange(''); return; }
    onChange(String(Math.floor(ms / 1000) - RIPPLE_EPOCH_OFFSET));
  };
  const picked = local ? new Date(local) : null;
  return (
    <div>
      <input type="datetime-local" value={local} onChange={e=>handle(e.target.value)} style={{ ...INP, fontSize:13, colorScheme:'dark' }} />
      {picked && !Number.isNaN(picked.getTime()) && (
        <p style={{ fontSize:11,color:'rgba(255,255,255,.35)',marginTop:4 }}>
          Releases {picked.toLocaleString()} — Ripple time {value} ({picked.getTime() > Date.now() ? `in ~${Math.max(1, Math.round((picked.getTime()-Date.now())/86400000))} day(s)` : 'in the past — pick a future time'}).
        </p>
      )}
    </div>
  );
}

// ─── PRODUCT MODAL (real polling payment gate) ───
function ProductModal({ show, onClose, product, connectedWallet }: { show:boolean; onClose:()=>void; product:Product|null; connectedWallet:string }) {
  const [currency, setCurrency] = useState<Currency>('RLUSD');
  const [email, setEmail]       = useState('');
  const [step, setStep]         = useState<'info'|'checkout'|'success'|'execute'>('info');
  const [payStatus, setPayStatus] = useState<'idle'|'creating'|'waiting'|'done'>('idle');
  const [uuid, setUuid]         = useState('');
  const [qrUrl, setQrUrl]       = useState('');
  const [deepLnk, setDeepLnk]   = useState('');
  const [countdown, setCountdown] = useState(900);
  const [verifiedTx, setVerifiedTx] = useState('');
  const [payError, setPayError] = useState('');
  // multi-wallet (Xaman default; Crossmark / GemWallet if detected)
  const [walletOpts, setWalletOpts] = useState<ProviderOption[]>([]);
  const [walletSel, setWalletSel]   = useState('xaman');
  const [payHash, setPayHash]       = useState('');       // injected-wallet fee-payment tx (also set by manual hash entry, below)
  const [manualHashInput, setManualHashInput] = useState('');
  const [manualHashErr, setManualHashErr]     = useState('');
  const [exHash, setExHash]         = useState('');       // injected-wallet service tx
  // execution (service fulfillment) state
  const [exForm, setExForm]     = useState<Record<string,string>>({});
  const [exStatus, setExStatus] = useState<'form'|'building'|'signing'|'delivered'|'failed'|'caution'|'nextstep'>('form');
  // multi-transaction services are signed one step at a time
  const [exPlan, setExPlan] = useState<{ step:number; total:number; label:string; list:{ id:string; label:string }[] }|null>(null);
  const [exNextStep, setExNextStep] = useState<number|null>(null);
  // Free flow: the step plan returned at step 1, sent back with every later step (no payment record holds it any more).
  const [exPlanFull, setExPlanFull] = useState<{ id:string; type:string }[]|null>(null);
  const [exUuid, setExUuid]     = useState('');
  const [exTxjson, setExTxjson] = useState<Record<string,unknown>|null>(null); // for the manual-sign fallback when Xaman is down
  const [manualExHashInput, setManualExHashInput] = useState('');
  const [manualExHashErr, setManualExHashErr]     = useState('');
  const [exQr, setExQr]         = useState('');
  const [exLink, setExLink]     = useState('');
  const [exTx, setExTx]         = useState('');
  const [exError, setExError]   = useState('');
  const [exLabel, setExLabel]   = useState('');
  const [cautionOk, setCautionOk] = useState(false);
  const [exManifest, setExManifest] = useState<{ irreversible?:string[]; backingNotice?:string; warning?:string; confirmPrompt?:string; heading?:string; listTitle?:string; manifest?:Record<string,unknown> }|null>(null);
  // MPT issuance: which permanence regime applies RIGHT NOW (live DynamicMPT amendment state).
  // Server-driven so the form never hard-codes "Permanent"; lock fields only appear once active.
  const [mptPerm, setMptPerm] = useState<{ regime:string; headline:string[]; formHelp:Record<string,string>; lockFields:ExecField[] }|null>(null);
  useEffect(() => {
    if (step !== 'execute' || product?.id !== 'mptissue') return;
    let dead = false;
    fetch(`${API_URL}/api/mpt/permanence`).then(r => r.json()).then(d => { if (!dead && Array.isArray(d?.headline)) setMptPerm(d); }).catch(() => { if (!dead) setMptPerm(null); });
    return () => { dead = true; };
  }, [step, product?.id]);
  const buyBlocked = false;
  const exPollRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const pollRef   = useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancelRef = useRef(false);

  const pricing = usePricing();
  const xrpNow = product ? (pricing?.xrp?.[product.id] ?? null) : null;   // live, derived server-side
  const displayPrice = product ? (currency==='RLUSD' ? product.priceRLUSD : (xrpNow ?? 0)) : 0;
  const xrpUnavailable = currency==='XRP' && xrpNow == null;
  // what the server actually asked for (it adds a small buffer for rate drift) — shown once we have it
  const [quoted, setQuoted] = useState<{ amount:string; currency:string }|null>(null);
  const [intentId, setIntentId] = useState('');          // auto-detection: search-by-tag, no hash needed
  const [destTag, setDestTag] = useState<number|null>(null);
  const price = TEST_MODE ? (currency==='RLUSD' ? TEST_PRICE_RLUSD : TEST_PRICE_XRP) : displayPrice;

  // Payment polling — verified only when on-chain TX confirms
  useEffect(() => {
    if (payStatus !== 'waiting' || !uuid || !product) return;
    cancelRef.current = false;
    let txid: string | null = null; // set by the socket: from then on, ledger-only checks by hash
    const xw = watchXaman(uuid, (r) => { if (r.txid) txid = r.txid; if (pollRef.current) clearTimeout(pollRef.current); poll(); });
    const poll = async () => {
      if (cancelRef.current) return;
      try {
        const params = new URLSearchParams({ ...(txid ? { hash: txid } : { uuid }), productId:product.id, amount:String(price), currency, email });
        const res  = await fetch(`${API_URL}/api/check-payment?${params}`);
        const data = await res.json();
        if (cancelRef.current) return;
        if (data.status === 'verified') { setVerifiedTx(data.txHash || ''); setPayStatus('done'); setStep('success'); }
        else if (data.status === 'expired') { setPayStatus('idle'); setPayError('Payment expired. Tap to try again.'); }
        else if (data.status === 'rejected') { setPayStatus('idle'); setPayError(data.reason || 'Payment declined.'); }
        else { pollRef.current = setTimeout(poll, txid ? 3000 : xw.delay()); }
      } catch { if (!cancelRef.current) pollRef.current = setTimeout(poll, txid ? 5000 : xw.delay()); }
    };
    poll();
    return () => { cancelRef.current = true; xw.stop(); if (pollRef.current) clearTimeout(pollRef.current); };
  }, [payStatus, uuid]); // eslint-disable-line

  useEffect(() => {
    if (payStatus !== 'waiting') return;
    const iv = setInterval(() => setCountdown(c => { if (c <= 1) { clearInterval(iv); if (!cancelRef.current) { setPayStatus('idle'); setPayError('Payment expired.'); } return 0; } return c - 1; }), 1000);
    return () => clearInterval(iv);
  }, [payStatus]);

  // Poll execution signing → on-chain delivery (must be above any early return)
  useEffect(() => {
    if (exStatus !== 'signing' || !exUuid) return;
    let stop = false;
    const xw = watchXaman(exUuid, (r) => {
      if (stop) return;
      if (exPollRef.current) clearTimeout(exPollRef.current);
      if (r.signed && r.txid) { stop = true; setExHash(r.txid); return; } // ledger-only from here (verify ?hash=)
      poll();
    });
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/execute/verify?uuid=${exUuid}`);
        const data = await res.json();
        if (stop) return;
        if (data.status === 'delivered') { setExTx(data.txHash||''); setExStatus('delivered'); }
        else if (data.status === 'step_delivered') { setExTx(data.txHash||''); setExNextStep(data.nextStep?.step ?? null); setExStatus('nextstep'); }
        else if (data.status === 'rejected') { setExError('You declined the signature.'); setExStatus('form'); }
        else if (data.status === 'expired') { setExError('Sign request expired. Try again.'); setExStatus('form'); }
        else if (data.status === 'failed') { setExError(`Ledger rejected it: ${data.result||'failed'}`); setExStatus('failed'); }
        else { exPollRef.current = setTimeout(poll, xw.delay()); }
      } catch { if (!stop) exPollRef.current = setTimeout(poll, xw.delay()); }
    };
    poll();
    return () => { stop = true; xw.stop(); if (exPollRef.current) clearTimeout(exPollRef.current); };
  }, [exStatus, exUuid]); // eslint-disable-line

  // detect installed extension wallets when the modal opens (extension globals
  // inject asynchronously — detection polls for up to ~1.5s)
  useEffect(() => {
    if (!show) return;
    let live = true;
    setWalletSel('xaman');
    resolveProviderOptions({ xamanAvailable: true })
      .then((o) => { if (live) setWalletOpts(o); })
      .catch(() => {});
    return () => { live = false; };
  }, [show]);

  // injected fee-payment: poll check-payment?hash= until the ledger confirms it
  useEffect(() => {
    if (payStatus !== 'waiting' || !payHash || !product) return;
    let stop = false;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ hash: payHash, productId: product.id, amount: String(price), currency, email });
        const res = await fetch(`${API_URL}/api/check-payment?${params}`);
        const data = await res.json();
        if (stop) return;
        if (data.status === 'verified') { setVerifiedTx(data.txHash || payHash); setPayStatus('done'); setStep('success'); }
        else if (data.status === 'failed' || data.status === 'rejected') { setPayStatus('idle'); setPayError(data.reason || 'Payment failed on the ledger.'); }
        else { setTimeout(poll, 3000); }
      } catch { if (!stop) setTimeout(poll, 5000); }
    };
    poll();
    return () => { stop = true; };
  }, [payStatus, payHash]); // eslint-disable-line

  // auto-detection: poll by destination tag, no hash needed at all -- catches a manual payment (exchange
  // withdrawal, any wallet) even if the customer never pastes anything. Runs alongside the uuid/hash
  // polls above; whichever finds it first wins. A slower interval (7s) since this is a heavier ledger
  // walk server-side, not a cheap lookup.
  useEffect(() => {
    if (payStatus !== 'waiting' || !intentId) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/check-payment?intentId=${encodeURIComponent(intentId)}&email=${encodeURIComponent(email)}`);
        const data = await res.json();
        if (stop) return;
        if (data.status === 'verified') { setVerifiedTx(data.txHash || ''); setPayStatus('done'); setStep('success'); }
        else if (data.status === 'rejected') { setPayStatus('idle'); setPayError(data.reason || 'A payment was found but did not match — ' + (data.reason || 'contact support@xrplhub.io with your transaction hash.')); }
        else if (data.status === 'expired') { /* let the countdown's own expiry handle the UI -- this just stops polling */ }
        else { setTimeout(poll, 7000); }
      } catch { if (!stop) setTimeout(poll, 9000); }
    };
    poll();
    return () => { stop = true; };
  }, [payStatus, intentId]); // eslint-disable-line

  // injected service-execution: poll execute/verify?hash=
  useEffect(() => {
    if (exStatus !== 'signing' || !exHash || !product) return;
    let stop = false;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ hash: exHash, account: connectedWallet, productId: product.id, step: String(exPlan?.step ?? 1), plan: JSON.stringify(exPlanFull ?? []) });
        const res = await fetch(`${API_URL}/api/execute/verify?${params}`);
        const data = await res.json();
        if (stop) return;
        if (data.status === 'delivered') { setExTx(data.txHash || exHash); setExStatus('delivered'); }
        else if (data.status === 'step_delivered') { setExTx(data.txHash || exHash); setExNextStep(data.nextStep?.step ?? null); setExStatus('nextstep'); }
        else if (data.status === 'failed') { setExError(`Ledger rejected it: ${data.result || 'failed'}`); setExStatus('failed'); }
        else { setTimeout(poll, 3000); }
      } catch { if (!stop) setTimeout(poll, 5000); }
    };
    poll();
    return () => { stop = true; };
  }, [exStatus, exHash]); // eslint-disable-line

  if (!product) return null;

  // Pay the service fee with an injected wallet, then let the on-ledger poll confirm.
  const buyWithExtension = async (providerId: string) => {
    if (!product) return;
    const provider = getWalletProvider(providerId);
    if (!provider) return;
    setPayStatus('creating'); setPayError('');
    try {
      const cr = await fetch(`${API_URL}/api/create-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, currency, amount: price, email }),
      });
      const cd = await cr.json();
      if (!cr.ok || !cd.treasury) throw new Error(cd.error || 'Could not start payment');
      if (cd.amount) setQuoted({ amount:String(cd.amount), currency:String(cd.currency||currency) });
      const handle = provider.submitPayment({
        // the SERVER decides what to charge (pricing.ts); an injected wallet must send exactly that
        productId: product.id, to: cd.treasury, amount: String(cd.amount ?? price), currency: (cd.currency ?? currency) as Currency,
        issuer: (cd.txjson?.Amount as { issuer?: string })?.issuer ?? null,
        currencyHex: (cd.txjson?.Amount as { currency?: string })?.currency ?? null,
      });
      const r = await handle.result; // { via:'injected', txHash }
      setPayHash(r.via === 'injected' ? r.txHash : '');
      setPayStatus('waiting');
    } catch (e: unknown) {
      if (e instanceof WalletCancelled) setPayError('You declined the payment.');
      else setPayError(e instanceof Error ? e.message : 'Payment failed');
      setPayStatus('idle');
    }
  };

  const handleClose = () => {
    cancelRef.current = true; if (pollRef.current) clearTimeout(pollRef.current); if (exPollRef.current) clearTimeout(exPollRef.current);
    onClose();
    setTimeout(() => { setStep('info'); setEmail(''); setPayStatus('idle'); setUuid(''); setQrUrl(''); setDeepLnk(''); setCountdown(900); setVerifiedTx(''); setPayError(''); cancelRef.current = false;
      setExForm({}); setExStatus('form'); setExUuid(''); setExQr(''); setExLink(''); setExTx(''); setExTxjson(null); setExError(''); setExLabel(''); setCautionOk(false); setExManifest(null); setExPlan(null); setExNextStep(null);
      setPayHash(''); setExHash(''); setWalletSel('xaman'); setManualHashInput(''); setManualHashErr(''); setManualExHashInput(''); setManualExHashErr(''); setExPlanFull(null); }, 300);
  };

  const handleBuyNow = async () => {
    setPayStatus('creating'); setPayError(''); cancelRef.current = false;
    try {
      const res  = await fetch(`${API_URL}/api/create-payment`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ productId:product.id, currency, amount:price, email }) });
      const data = await res.json();
      // The server always returns a payable treasury/txjson even if Xaman itself is down or unconfigured
      // (see api/create-payment's fallback) -- only a missing treasury means payment truly could not start.
      // A missing uuid is NOT fatal: it just means the Xaman QR/deeplink can't show, so the manual-payment
      // panel below (address + amount + paste-your-hash) is the only path — and it must still work.
      if (!res.ok || !data.treasury) throw new Error(data.error || 'Failed to create payment');
      setUuid(data.uuid || ''); setQrUrl(data.qr_png); setDeepLnk(data.deep_link); setCountdown(data.expires_in || 900); if (data.amount) setQuoted({ amount:String(data.amount), currency:String(data.currency||currency) }); setIntentId(data.intentId || ''); setDestTag(typeof data.destinationTag==='number' ? data.destinationTag : null); setPayStatus('waiting');
    } catch (e: unknown) { setPayError(e instanceof Error ? e.message : 'Payment failed'); setPayStatus('idle'); }
  };

  const submitManualHash = () => {
    const h = manualHashInput.trim().toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(h)) { setManualHashErr('That doesn’t look like a transaction hash (64 hex characters).'); return; }
    setManualHashErr(''); setPayHash(h);
  };

  const submitManualExHash = () => {
    const h = manualExHashInput.trim().toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(h)) { setManualExHashErr('That doesn’t look like a transaction hash (64 hex characters).'); return; }
    setManualExHashErr(''); setExHash(h);
  };

  // Build + sign the actual service transaction (autonomous execution engine)
  const handleExecute = async (confirmCaution = false, stepNo?: number) => {
    if (!product) return;
    setExStatus('building'); setExError('');
    try {
      const res = await fetch(`${API_URL}/api/execute`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ productId:product.id, account:connectedWallet, params:exForm, confirmedCaution:confirmCaution, ...(stepNo ? { step:stepNo, plan:exPlanFull } : {}) }),
      });
      const data = await res.json();
      if (res.status === 409 && data.requiresConfirmation) {
        setExLabel(data.label||'');
        setExManifest(data.manifest || data.irreversible ? { irreversible:data.irreversible, backingNotice:data.backingNotice, warning:data.warning, confirmPrompt:data.confirmPrompt, heading:data.heading, listTitle:data.listTitle, manifest:data.manifest } : null);
        setExStatus('caution'); return;
      }
      if (res.status === 422 && data.needsParams) { setExError('Please fill: ' + data.needsParams.join(', ')); setExStatus('form'); return; }
      if (!res.ok || (!data.uuid && !data.txjson)) throw new Error(data.error || 'Could not build your service transaction');
      setExLabel(data.label||'');
      setExPlan({ step:data.step??1, total:data.totalSteps??1, label:data.stepLabel??'', list:Array.isArray(data.steps)?data.steps:[] });
      if (Array.isArray(data.plan)) setExPlanFull(data.plan);

      if (walletSel !== 'xaman' && data.txjson) {
        // injected wallet signs + submits the service tx itself
        const provider = getWalletProvider(walletSel);
        if (!provider?.submitTx) throw new Error('This wallet cannot sign that transaction.');
        setExStatus('signing');
        try {
          const { txHash } = await provider.submitTx(data.txjson);
          setExHash(txHash);
        } catch (e) {
          if (e instanceof WalletCancelled) { setExError('You declined the signature.'); setExStatus('form'); }
          else { setExError(e instanceof Error ? e.message : 'Signing failed'); setExStatus('form'); }
        }
        return;
      }

      setExUuid(data.uuid || ''); setExQr(data.qr_png); setExLink(data.deep_link); setExTxjson((data.txjson as Record<string,unknown>) ?? null); setExStatus('signing');
    } catch (e:unknown) { setExError(e instanceof Error ? e.message : 'Execution failed'); setExStatus('form'); }
  };

  if (step === 'execute') {
    const isMpt = product.id === 'mptissue';
    const fields: ExecField[] = [...(EXEC_FIELDS[product.id] || []), ...(isMpt ? (mptPerm?.lockFields ?? []) : [])];
    const helpFor = (f: ExecField) => (isMpt && mptPerm?.formHelp?.[f.key]) || f.help;
    const setF = (k:string,v:string) => setExForm(f => {
      const next = {...f,[k]:v};
      // Well-known-issuer autofill: typing a currency we know (today: RLUSD) into a paired "…Currency" field fills
      // the sibling "…Issuer" field, if that field exists on this service and is still empty.
      const issuerKey = k === 'currency' ? 'issuer' : k.endsWith('Currency') ? k.slice(0, -('Currency'.length)) + 'Issuer' : null;
      if (issuerKey && fields.some(fl => fl.key === issuerKey)) {
        const known = WELL_KNOWN_ISSUERS[v.trim().toUpperCase()];
        if (known && !f[issuerKey]) next[issuerKey] = known;
      }
      return next;
    });
    return (
      <Overlay show={show} onClose={handleClose} wide>
        <div style={{ fontSize:10,fontWeight:700,color:product.color,letterSpacing:'.12em',textTransform:'uppercase',marginBottom:5,fontFamily:"'IBM Plex Mono',monospace" }}>Free · Build &amp; sign</div>
        <h3 style={{ fontSize:20,fontWeight:900,marginBottom:4 }}>{product.name}</h3>
        <p style={{ fontSize:12,color:'rgba(255,255,255,.4)',marginBottom:16 }}>Free — we build your exact transaction and you sign it in your own wallet. No payment, no checkout.</p>

        {exStatus === 'form' && !connectedWallet && (
          <div style={{ background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.35)',borderRadius:12,padding:'14px 18px',marginBottom:16 }}>
            <p style={{ fontSize:13,color:'#f59e0b',fontWeight:700,marginBottom:6 }}>Connect your wallet to finish</p>
            <p style={{ fontSize:12,color:'rgba(255,255,255,.55)',lineHeight:1.6 }}>Your service transaction is signed from your own Xaman wallet. Close this, tap <strong style={{ color:'#fff' }}>Connect Wallet</strong> at the top, then reopen this service to finish.</p>
          </div>
        )}
        {exStatus === 'form' && connectedWallet && (
          <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',marginBottom:14,fontFamily:"'IBM Plex Mono',monospace" }}>Signing wallet: {connectedWallet.slice(0,10)}…{connectedWallet.slice(-6)}</p>
        )}

        {exStatus === 'form' && (
          <>
            {isMpt && (
              <div style={{ background:'rgba(245,158,11,.08)',border:'1px solid rgba(245,158,11,.35)',borderRadius:12,padding:'12px 16px',marginBottom:16 }}>
                <p style={{ fontSize:11,fontWeight:700,color:'#f59e0b',letterSpacing:'.06em',textTransform:'uppercase',marginBottom:6 }}>What is permanent — live from the XRPL</p>
                <p style={{ fontSize:12,color:'rgba(255,255,255,.7)',lineHeight:1.7 }}>
                  {mptPerm ? mptPerm.headline.join(' ') : 'Live amendment state not loaded — treat nothing below as permanent, except the maximum supply, the decimals, and any flag you switch on.'}
                </p>
              </div>
            )}
            {fields.length === 0 && <div style={{ background:'rgba(16,185,129,.05)',border:'1px solid rgba(16,185,129,.15)',borderRadius:12,padding:'13px 16px',marginBottom:16,fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.6 }}>No details needed — tap below and we will build your <strong style={{ color:'#10b981' }}>{product.name}</strong> transaction for you to sign in Xaman.</div>}
            {fields.map(f => (
              <div key={f.key} style={{ marginBottom:13 }}>
                <label style={LBL}>{f.label}{f.required && <span style={{ color:product.color }}> *</span>}</label>
                {f.type==='select' && f.options ? (
                  <select value={exForm[f.key] ?? f.default ?? f.options[0]} onChange={e=>setF(f.key,e.target.value)} style={{ ...INP, fontSize:13 }}>
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type==='datetime' ? (
                  <DateTimeField value={exForm[f.key] ?? ''} onChange={v=>setF(f.key,v)} />
                ) : (
                  <input type={f.type==='number'?'number':'text'} value={exForm[f.key] ?? f.default ?? ''} onChange={e=>setF(f.key,e.target.value)} placeholder={f.placeholder||''} style={{ ...INP, fontFamily:(f.key.toLowerCase().includes('address')||f.key.includes('issuer')||f.key.includes('destination')||f.key.includes('wallet')||f.key.includes('Id')||f.key.includes('holder')||f.key.includes('subject'))?"'IBM Plex Mono',monospace":'inherit', fontSize:f.type==='number'?14:13 }} />
                )}
                {helpFor(f) && <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',marginTop:4 }}>{helpFor(f)}</p>}
              </div>
            ))}
            {exError && <p style={{ fontSize:12,color:'#fca5a5',marginBottom:10 }}>⚠️ {exError}</p>}
            <button disabled={!connectedWallet} onClick={()=>handleExecute(false)} style={{ ...Btn('color',product.color,{width:'100%',padding:'14px',fontSize:15,marginTop:6,opacity:connectedWallet?1:.4}) }}>⚡ Build &amp; Sign{walletSel !== 'xaman' ? ` with ${getWalletProvider(walletSel)?.label ?? 'wallet'}` : ' in Xaman'} →</button>
            <p style={{ fontSize:11,color:'rgba(255,255,255,.26)',textAlign:'center',marginTop:10 }}>we build the exact XRPL transaction · you approve it in your own wallet · we verify on-chain</p>
          </>
        )}

        {exStatus === 'building' && (
          <div style={{ textAlign:'center', padding:'34px 0' }}>
            <div style={{ width:60,height:60,borderRadius:'50%',background:`${product.color}15`,border:`2px solid ${product.color}40`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px',fontSize:26,animation:'spin 1.5s linear infinite' }}>🤖</div>
            <p style={{ color:product.color,fontWeight:700,fontSize:15 }}>Building your transaction…</p>
          </div>
        )}

        {exStatus === 'caution' && (
          <div>
            <div style={{ background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.4)',borderRadius:14,padding:'18px 20px',marginBottom:16 }}>
              <p style={{ fontSize:14,fontWeight:800,color:'#f59e0b',marginBottom:8 }}>⚠️ {exManifest?.heading || 'Permanent — read every line'}</p>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.7)',lineHeight:1.7 }}>{exManifest?.warning || `This operation (${exLabel}) changes how your wallet is controlled and may be difficult or impossible to reverse. If misconfigured, you could lose access to your account. Make sure your details are correct before signing.`}</p>
            </div>
            {exManifest?.irreversible && exManifest.irreversible.length > 0 && (
              <div style={{ background:'rgba(255,255,255,.03)',border:'1px solid rgba(255,255,255,.1)',borderRadius:12,padding:'14px 16px',marginBottom:14 }}>
                <p style={{ fontSize:11,fontWeight:700,color:'#f59e0b',letterSpacing:'.06em',textTransform:'uppercase',marginBottom:8 }}>{exManifest?.listTitle || 'Cannot be undone after you sign'}</p>
                <ul style={{ margin:0,paddingLeft:18,fontSize:12,color:'rgba(255,255,255,.62)',lineHeight:1.7 }}>
                  {exManifest.irreversible.map((line,i) => <li key={i} style={{ marginBottom:4 }}>{line}</li>)}
                </ul>
              </div>
            )}
            {exManifest?.backingNotice && (
              <div style={{ background:'rgba(56,189,248,.08)',border:'1px solid rgba(56,189,248,.28)',borderRadius:12,padding:'12px 16px',marginBottom:14 }}>
                <p style={{ fontSize:11,fontWeight:700,color:'#38bdf8',letterSpacing:'.06em',textTransform:'uppercase',marginBottom:6 }}>Backing declaration</p>
                <p style={{ fontSize:12,color:'rgba(255,255,255,.6)',lineHeight:1.7 }}>{exManifest.backingNotice}</p>
              </div>
            )}
            <label style={{ display:'flex',alignItems:'flex-start',gap:10,cursor:'pointer',marginBottom:16 }}>
              <input type="checkbox" checked={cautionOk} onChange={e=>setCautionOk(e.target.checked)} style={{ marginTop:3,width:16,height:16,accentColor:'#f59e0b' }} />
              <span style={{ fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.6 }}>{exManifest?.confirmPrompt || 'I understand the risk and confirm my details are correct.'}</span>
            </label>
            <div style={{ display:'flex',gap:10 }}>
              <button onClick={()=>{ setExStatus('form'); setCautionOk(false); }} style={{ ...Btn('ghost',undefined,{flex:1}) }}>← Back</button>
              <button disabled={!cautionOk} onClick={()=>handleExecute(true)} style={{ ...Btn('color','#f59e0b',{flex:2,opacity:cautionOk?1:.4}) }}>I Understand — Continue →</button>
            </div>
          </div>
        )}

        {exStatus === 'signing' && (
          <>
            <div style={{ display:'flex',alignItems:'center',gap:8,background:'rgba(16,185,129,.08)',border:'1px solid rgba(16,185,129,.25)',borderRadius:12,padding:'10px 16px',marginBottom:14 }}>
              <span style={{ width:8,height:8,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 12px #10b981',animation:'pulse 1.4s infinite' }} />
              <span style={{ fontSize:13,fontWeight:700,color:'#10b981' }}>{exPlan && exPlan.total > 1 ? `Step ${exPlan.step} of ${exPlan.total}${exPlan.label ? ' — ' + exPlan.label : ''} · ` : ''}{exUuid ? 'Sign in Xaman to execute…' : 'Sign in your wallet to execute…'}</span>
            </div>
            {exUuid ? (
              <div style={{ marginBottom:14 }}>
                <XamanPayPrompt theme="light" mode="sign" qrPng={exQr} deepLink={exLink} uuid={exUuid} />
              </div>
            ) : (
              <>
                <p style={{ textAlign:'center',color:'rgba(255,255,255,.55)',fontSize:13,margin:'16px 0 14px' }}>
                  Xaman isn&rsquo;t available right now — you&rsquo;ve already paid, so this is only about signing. Paste the JSON below into any XRPL-signing tool (another wallet, xrpl.js, etc.), sign it from <strong style={{ color:'#fff' }}>{connectedWallet.slice(0,10)}…{connectedWallet.slice(-6)}</strong>, then tell us the resulting hash.
                </p>
                {exTxjson && (
                  <div style={{ marginBottom:14 }}>
                    <label style={LBL}>Transaction to sign</label>
                    <pre style={{ ...INP, whiteSpace:'pre-wrap', wordBreak:'break-all', fontFamily:"ui-monospace,monospace", fontSize:11, maxHeight:180, overflow:'auto', cursor:'pointer' }}
                      onClick={()=>navigator.clipboard?.writeText(JSON.stringify(exTxjson,null,2)).catch(()=>{})}
                      title="Tap to copy">{JSON.stringify(exTxjson,null,2)}</pre>
                  </div>
                )}
                <label style={LBL}>Already signed and submitted it? Paste the transaction hash</label>
                <div style={{ display:'flex', gap:8 }}>
                  <input value={manualExHashInput} onChange={e=>{ setManualExHashInput(e.target.value); setManualExHashErr(''); }} placeholder="64-character transaction hash" disabled={!!exHash} style={{ ...INP, flex:1, fontFamily:"ui-monospace,monospace", fontSize:12 }} />
                  <button type="button" onClick={submitManualExHash} disabled={!!exHash || !manualExHashInput.trim()} style={{ ...Btn('color', product.color, { padding:'0 16px', opacity: (!!exHash || !manualExHashInput.trim()) ? .5 : 1 }) }}>{exHash ? 'Checking…' : 'Check'}</button>
                </div>
                {manualExHashErr && <p style={{ color:'#fca5a5', fontSize:12, marginTop:8 }}>{manualExHashErr}</p>}
                {exHash && <p style={{ fontSize:12, color:'rgba(255,255,255,.45)', marginTop:8 }}>Watching the ledger for this transaction — this updates itself.</p>}
                <p style={{ fontSize:11, color:'rgba(255,255,255,.28)', marginTop:10 }}>Already signed and closed this page? Email <a href="mailto:support@xrplhub.io" style={{ color:'rgba(255,255,255,.4)' }}>support@xrplhub.io</a> with your transaction hash.</p>
              </>
            )}
            <p style={{ textAlign:'center',fontSize:11,color:'rgba(255,255,255,.28)',marginTop:12 }}>We confirm your service transaction on XRPL mainnet before marking it delivered.</p>
          </>
        )}

        {exStatus === 'nextstep' && exPlan && exNextStep && (
          <div style={{ textAlign:'center', padding:'14px 0' }}>
            <div style={{ width:64,height:64,borderRadius:'50%',background:'rgba(16,185,129,.15)',border:'2px solid rgba(16,185,129,.5)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px',fontSize:28 }}>✅</div>
            <h3 style={{ fontSize:19,fontWeight:900,color:'#10b981',marginBottom:6 }}>Step {exNextStep - 1} of {exPlan.total} confirmed</h3>
            <p style={{ fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:6 }}>{exPlan.list[exNextStep - 2]?.label || 'Done'} is on XRPL mainnet.</p>
            <p style={{ fontSize:13,color:'#fff',lineHeight:1.7,marginBottom:14 }}>Next: <strong>{exPlan.list[exNextStep - 1]?.label || `step ${exNextStep}`}</strong></p>
            {exTx && <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',fontFamily:"'IBM Plex Mono',monospace",marginBottom:14,wordBreak:'break-all' }}>TX: {exTx.slice(0,22)}…{exTx.slice(-8)}</p>}
            <button onClick={()=>{ const n = exNextStep; setExNextStep(null); handleExecute(true, n); }} style={{ ...Btn('color',product.color,{width:'100%',padding:'14px',fontSize:15}) }}>Continue — sign step {exNextStep} of {exPlan.total} →</button>
            <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',marginTop:10 }}>Your payment covers every step. Do not close this window until the last one is confirmed.</p>
          </div>
        )}

        {exStatus === 'delivered' && (
          <div style={{ textAlign:'center', padding:'14px 0' }}>
            <div style={{ width:72,height:72,borderRadius:'50%',background:'rgba(16,185,129,.15)',border:'2px solid rgba(16,185,129,.5)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px',fontSize:34 }}>✅</div>
            <h3 style={{ fontSize:22,fontWeight:900,color:'#10b981',marginBottom:8 }}>Service Delivered</h3>
            <p style={{ fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:14 }}>Your <strong style={{ color:'#fff' }}>{product.name}</strong> transaction is live and confirmed on XRPL mainnet.</p>
            {exTx && <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',fontFamily:"'IBM Plex Mono',monospace",marginBottom:16,wordBreak:'break-all' }}>TX: {exTx.slice(0,22)}…{exTx.slice(-8)}</p>}
            <div style={{ display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap' }}>
              {exTx && <a href={`https://xrpscan.com/tx/${exTx}`} target="_blank" rel="noopener noreferrer" style={{ ...Btn('ghost',undefined,{fontSize:13,textDecoration:'none'}) }}>View on XRPScan ↗</a>}
              <button onClick={handleClose} style={Btn('green')}>Done</button>
            </div>
          </div>
        )}

        {exStatus === 'failed' && (
          <div style={{ textAlign:'center', padding:'14px 0' }}>
            <div style={{ fontSize:42,marginBottom:12 }}>⚠️</div>
            <h3 style={{ fontSize:20,fontWeight:900,marginBottom:8 }}>Transaction didn&apos;t go through</h3>
            <p style={{ fontSize:13,color:'rgba(255,255,255,.5)',lineHeight:1.7,marginBottom:8 }}>{exError||'The ledger rejected it.'} Your payment is safe — adjust your details and try again, or contact support@xrplhub.io.</p>
            <div style={{ display:'flex',gap:10,justifyContent:'center',marginTop:14 }}>
              <button onClick={()=>{ setExStatus('form'); setExError(''); }} style={Btn('color',product.color)}>Try Again →</button>
              <button onClick={handleClose} style={Btn('ghost')}>Close</button>
            </div>
          </div>
        )}
      </Overlay>
    );
  }

  if (step === 'success') return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ textAlign:'center', padding:'20px 0' }}>
        <div style={{ width:76,height:76,borderRadius:'50%',background:`${product.color}18`,border:`2px solid ${product.color}45`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 18px',fontSize:34,animation:'glow 2s ease-in-out infinite' }}>{product.emoji}</div>
        <div style={{ display:'inline-flex',alignItems:'center',gap:6,background:'rgba(16,185,129,.1)',border:'1px solid rgba(16,185,129,.25)',borderRadius:99,padding:'4px 14px',marginBottom:14 }}>
          <span style={{ width:6,height:6,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 8px #10b981',animation:'pulse 2s infinite' }} />
          <span style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.1em' }}>✅ PAYMENT VERIFIED ON XRPL</span>
        </div>
        <h3 style={{ fontSize:24,fontWeight:900,marginBottom:8 }}>Payment Confirmed</h3>
        <div style={{ background:'rgba(255,255,255,.04)',border:'1px solid rgba(255,255,255,.08)',borderRadius:14,padding:18,margin:'14px 0 18px',textAlign:'left' }}>
          <p style={{ fontSize:11,color:product.color,fontFamily:"'IBM Plex Mono',monospace",fontWeight:700,marginBottom:6,textTransform:'uppercase',letterSpacing:'.08em' }}>Verified on-chain</p>
          <p style={{ fontSize:13,color:'rgba(255,255,255,.65)',lineHeight:1.75 }}>Your payment is confirmed on XRPL mainnet. Next, finish your service — we build the exact transaction and you sign it in your wallet.</p>
        </div>
        {verifiedTx && <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',fontFamily:"'IBM Plex Mono',monospace",marginBottom:10,wordBreak:'break-all' }}>TX: {verifiedTx.slice(0,22)}…{verifiedTx.slice(-8)}</p>}
        {email && <p style={{ fontSize:12,color:'rgba(255,255,255,.38)',marginBottom:18 }}>✅ Receipt sent to <strong style={{ color:'#fff' }}>{email}</strong></p>}
        <div style={{ display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap' }}>
          {verifiedTx && <a href={`https://xrpscan.com/tx/${verifiedTx}`} target="_blank" rel="noopener noreferrer" style={{ ...Btn('ghost',undefined,{fontSize:13,textDecoration:'none'}) }}>View on XRPScan ↗</a>}
          <button onClick={()=>{ setExStatus('form'); setStep('execute'); }} style={Btn('color',product.color)}>Finish My Service →</button>
        </div>
      </div>
    </Overlay>
  );

  if (step === 'checkout') return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ fontSize:10,fontWeight:700,color:product.color,letterSpacing:'.12em',textTransform:'uppercase',marginBottom:5,fontFamily:"'IBM Plex Mono',monospace" }}>{product.amendment}</div>
      <h3 style={{ fontSize:20,fontWeight:900,marginBottom:4 }}>{product.name}</h3>
      <p style={{ fontSize:12,color:'rgba(255,255,255,.4)',marginBottom:14 }}>{currency==='XRP' ? (xrpNow!=null ? `≈${fmtXrp(xrpNow)}` : '—') : displayPrice} {currency} — one payment, then your transaction {TEST_MODE && <span style={{ color:'#f59e0b',fontWeight:700 }}>· TEST MODE (charging {price} {currency})</span>}</p>

      {payStatus === 'creating' && (
        <div style={{ textAlign:'center', padding:'32px 0' }}>
          <div style={{ width:60,height:60,borderRadius:'50%',background:`${product.color}15`,border:`2px solid ${product.color}40`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px',fontSize:26,animation:'spin 1.5s linear infinite' }}>⚡</div>
          <p style={{ color:product.color,fontWeight:700,fontSize:15 }}>Creating secure payment…</p>
        </div>
      )}

      {payStatus === 'waiting' && (
        <>
          <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',background:'rgba(16,185,129,.08)',border:'1px solid rgba(16,185,129,.25)',borderRadius:12,padding:'10px 16px',marginBottom:14 }}>
            <div style={{ display:'flex',alignItems:'center',gap:8 }}>
              <span style={{ width:8,height:8,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 12px #10b981',animation:'pulse 1.4s infinite' }} />
              <span style={{ fontSize:13,fontWeight:700,color:'#10b981' }}>Waiting for payment…</span>
            </div>
            <span style={{ fontSize:12,color:'rgba(255,255,255,.4)',fontFamily:"'IBM Plex Mono',monospace" }}>⏱ {fmt(countdown)}</span>
          </div>
          {uuid ? (
            <div style={{ marginBottom:14 }}>
              <XamanPayPrompt theme="light" mode="pay" qrPng={qrUrl} deepLink={deepLnk} uuid={uuid}
                amount={quoted ? Number(quoted.amount) : price} currency={currency} destination={TREASURY} />
            </div>
          ) : (
            <p style={{ textAlign:'center',color:'rgba(255,255,255,.55)',fontSize:13,margin:'18px 0' }}>
              Xaman isn&rsquo;t available right now — pay from any wallet or exchange below, then tell us the transaction hash.
            </p>
          )}
          {uuid && (
            <div style={{ background:'rgba(255,255,255,.04)',border:'1px solid rgba(255,255,255,.07)',borderRadius:14,padding:'14px 18px',marginBottom:12 }}>
              {[['1','Scan QR or tap "Open in Xaman"'],['2',`Review the pre-filled ${quoted ? quoted.amount : (currency==='XRP' ? (xrpNow!=null ? '≈'+fmtXrp(xrpNow) : '—') : price)} ${currency} payment`],['3','Confirm — we verify it on-chain']].map(([n,t]) => (
                <div key={n} style={{ display:'flex',alignItems:'flex-start',gap:12,marginBottom:n==='3'?0:10 }}>
                  <span style={{ width:22,height:22,borderRadius:'50%',background:`${product.color}20`,border:`1px solid ${product.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:product.color,flexShrink:0 }}>{n}</span>
                  <span style={{ fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.5,paddingTop:2 }}>{t}</span>
                </div>
              ))}
            </div>
          )}

          {/* ---- manual fallback: works with NO Xaman and NO injected wallet — the only hard requirement
               is the exact amount, and (for delivery) telling us which transaction was yours. ---- */}
          <details open={!uuid} style={{ marginBottom:12, borderTop: uuid ? '1px solid rgba(255,255,255,.08)' : 'none', paddingTop: uuid ? 12 : 0 }}>
            {uuid && <summary style={{ cursor:'pointer', color:'rgba(255,255,255,.5)', fontSize:13, fontWeight:600 }}>Pay manually instead (exchange withdrawal / other wallet)</summary>}
            <div style={{ marginTop: uuid ? 12 : 0 }}>
              <div style={{ marginBottom:12 }}>
                <label style={LBL}>Send to</label>
                <button type="button" onClick={()=>navigator.clipboard?.writeText(TREASURY).catch(()=>{})} style={{ ...INP, textAlign:'left', fontFamily:"ui-monospace,monospace", fontSize:13, cursor:'pointer', wordBreak:'break-all' }} title="Tap to copy">{TREASURY}</button>
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={LBL}>Amount (exact)</label>
                <div style={{ ...INP, fontWeight:700 }}>{quoted ? quoted.amount : price} {quoted ? quoted.currency : currency}</div>
              </div>
              {destTag != null && (
                <div style={{ marginBottom:12 }}>
                  <label style={LBL}>Destination tag (include if your wallet asks for one)</label>
                  <button type="button" onClick={()=>navigator.clipboard?.writeText(String(destTag)).catch(()=>{})} style={{ ...INP, textAlign:'left', fontFamily:"ui-monospace,monospace", fontSize:13, cursor:'pointer', fontWeight:700 }} title="Tap to copy">{destTag}</button>
                </div>
              )}
              <p style={{ fontSize:11, color:'rgba(255,255,255,.35)', lineHeight:1.6, marginBottom:14 }}>A destination tag isn&rsquo;t required — we&rsquo;re already watching for this payment automatically and will detect it on our own, even if you close this page and never come back. Adding it if your wallet supports one just helps us find it faster. Pasting the hash below is the fastest of all, but entirely optional.</p>
              <label style={LBL}>Already sent it? Paste the transaction hash</label>
              <div style={{ display:'flex', gap:8 }}>
                <input value={manualHashInput} onChange={e=>{ setManualHashInput(e.target.value); setManualHashErr(''); }} placeholder="64-character transaction hash" disabled={!!payHash} style={{ ...INP, flex:1, fontFamily:"ui-monospace,monospace", fontSize:12 }} />
                <button type="button" onClick={submitManualHash} disabled={!!payHash || !manualHashInput.trim()} style={{ ...Btn('color', product.color, { padding:'0 16px', opacity: (!!payHash || !manualHashInput.trim()) ? .5 : 1 }) }}>{payHash ? 'Checking…' : 'Check'}</button>
              </div>
              {manualHashErr && <p style={{ color:'#fca5a5', fontSize:12, marginTop:8 }}>{manualHashErr}</p>}
              {payHash && <p style={{ fontSize:12, color:'rgba(255,255,255,.45)', marginTop:8 }}>Watching the ledger for this transaction — this updates itself.</p>}
              <p style={{ fontSize:11, color:'rgba(255,255,255,.28)', marginTop:10 }}>Already paid and closed this page? Email <a href="mailto:support@xrplhub.io" style={{ color:'rgba(255,255,255,.4)' }}>support@xrplhub.io</a> with your transaction hash.</p>
            </div>
          </details>

          <p style={{ textAlign:'center',fontSize:11,color:'rgba(255,255,255,.28)',marginBottom:10 }}>We confirm your transaction on XRPL mainnet before activating — nothing unlocks without a real payment.</p>
          <button onClick={()=>{ cancelRef.current=true; if(pollRef.current) clearTimeout(pollRef.current); setPayStatus('idle'); setPayError(''); setPayHash(''); setManualHashInput(''); setManualHashErr(''); }} style={{ ...Btn('ghost',undefined,{width:'100%',fontSize:13}) }}>← Cancel</button>
        </>
      )}

      {payStatus === 'idle' && payError && (
        <div style={{ background:'rgba(248,113,113,.08)',border:'1px solid rgba(248,113,113,.3)',borderRadius:12,padding:'14px 18px',marginBottom:16 }}>
          <p style={{ fontSize:13,color:'#fca5a5',marginBottom:10 }}>⚠️ {payError}</p>
          <button onClick={handleBuyNow} style={{ ...Btn('color',product.color,{width:'100%',padding:'12px'}) }}>Try Again →</button>
        </div>
      )}

      {payStatus === 'idle' && !payError && (
        <>
          <label style={LBL}>Currency</label>
          <div style={{ display:'flex',gap:8,marginBottom:14 }}>
            {(['RLUSD','XRP'] as Currency[]).map(c => (
              <button key={c} onClick={()=>setCurrency(c)} style={{ flex:1,padding:'10px',borderRadius:12,cursor:'pointer',fontFamily:'inherit',fontWeight:700,fontSize:14,border:`1px solid ${currency===c?product.color:'rgba(255,255,255,.1)'}`,background:currency===c?`${product.color}15`:'rgba(255,255,255,.04)',color:currency===c?product.color:'rgba(255,255,255,.5)' }}>
                {c==='RLUSD'?'💵 RLUSD':'◈ XRP'} — {c==='RLUSD'?product.priceRLUSD:(xrpNow!=null?'≈'+fmtXrp(xrpNow):'unavailable')}
              </button>
            ))}
          </div>
          <label style={LBL}>Email for Receipt (optional)</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" style={{ ...INP, marginBottom:16 }} />
          {walletOpts.filter(o=>o.available).length > 1 && (
            <div style={{ marginBottom:14 }}>
              <label style={LBL}>Wallet</label>
              <WalletPicker options={walletOpts} selected={walletSel} onSelect={setWalletSel} />
            </div>
          )}
          <div style={{ background:'rgba(16,185,129,.05)',border:'1px solid rgba(16,185,129,.15)',borderRadius:12,padding:'11px 14px',marginBottom:16,fontSize:12,color:'rgba(255,255,255,.45)',lineHeight:1.6 }}>
            <strong style={{ color:'#10b981' }}>How it works:</strong> Sign the {currency==='XRP' ? (xrpNow!=null ? '≈'+fmtXrp(xrpNow) : '—') : price} {currency} payment → we verify it on XRPL mainnet → we build your transaction → you sign it. {currency==='XRP' && <>The exact XRP amount is quoted at the live rate when you pay.</>}
          </div>
          <div style={{ display:'flex',gap:10 }}>
            <button onClick={()=>setStep('info')} style={{ ...Btn('ghost',undefined,{flex:1}) }}>← Back</button>
            <button
              disabled={xrpUnavailable}
              onClick={() => (walletSel === 'xaman' ? handleBuyNow() : buyWithExtension(walletSel))}
              style={{ ...Btn('color',product.color,{flex:2,fontSize:15,opacity:xrpUnavailable?.45:1}) }}
            >
              {walletSel === 'xaman' ? '📱' : ''} {xrpUnavailable ? 'XRP price unavailable — use RLUSD' : `Pay ${currency==='XRP' ? '≈'+fmtXrp(xrpNow as number) : price} ${currency} →`}
            </button>
            {TEST_MODE && <p style={{ fontSize:10,color:'#f59e0b',textAlign:'center',marginTop:6,fontWeight:700,letterSpacing:'.08em' }}>⚠️ TEST MODE — real launch price is {displayPrice} {currency}</p>}
          </div>
        </>
      )}
    </Overlay>
  );

  // INFO
  return (
    <Overlay show={show} onClose={handleClose} wide>
      <div style={{ display:'flex',gap:16,alignItems:'flex-start',marginBottom:22,flexWrap:'wrap' }}>
        <div style={{ width:58,height:58,borderRadius:16,background:`${product.color}18`,border:`1px solid ${product.color}30`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,flexShrink:0,animation:'float 4s ease-in-out infinite' }}>{product.emoji}</div>
        <div style={{ flex:1,minWidth:200 }}>
          <div style={{ fontSize:10,fontWeight:700,color:product.color,letterSpacing:'.12em',textTransform:'uppercase',fontFamily:"'IBM Plex Mono',monospace",marginBottom:4 }}>{product.amendment}</div>
          <h2 style={{ fontSize:23,fontWeight:900,marginBottom:4 }}>{product.name}</h2>
          <p style={{ fontSize:13,color:'rgba(255,255,255,.48)' }}>{product.tagline}</p>
        </div>
      </div>
      <p style={{ fontSize:14,color:'rgba(255,255,255,.62)',lineHeight:1.82,marginBottom:22 }}>{product.desc}</p>
      <div style={{ background:'rgba(16,185,129,.05)',border:'1px solid rgba(16,185,129,.18)',borderRadius:14,padding:16,marginBottom:22 }}>
        <p style={{ fontSize:11,fontWeight:700,color:'#10b981',marginBottom:6,textTransform:'uppercase',letterSpacing:'.09em',fontFamily:"'IBM Plex Mono',monospace" }}>What we build for you</p>
        <p style={{ fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.75 }}>{product.aiDetail}</p>
      </div>
      <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:9,marginBottom:26 }}>
        {product.features.map(f => (
          <div key={f} style={{ background:'rgba(255,255,255,.04)',border:'1px solid rgba(255,255,255,.07)',borderRadius:11,padding:'10px 13px',display:'flex',alignItems:'center',gap:8 }}>
            <span style={{ color:product.color,fontSize:11,flexShrink:0 }}>✓</span>
            <span style={{ fontSize:12,color:'rgba(255,255,255,.55)' }}>{f}</span>
          </div>
        ))}
      </div>
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',background:`${product.color}08`,border:`1px solid ${product.color}22`,borderRadius:14,padding:'16px 20px',marginBottom:20,flexWrap:'wrap',gap:12 }}>
        <div>
          <div style={{ fontSize:11,color:'rgba(255,255,255,.38)',marginBottom:4 }}>Price</div>
          <div style={{ display:'flex',gap:12,alignItems:'baseline',flexWrap:'wrap' }}>
            <span style={{ fontSize:28,fontWeight:900,color:product.color }}>Free</span>
            <span style={{ fontSize:13,color:'rgba(255,255,255,.3)' }}>no payment, no checkout</span>
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:11,color:'rgba(255,255,255,.38)',marginBottom:4 }}>You sign in</div>
          <div style={{ fontSize:15,fontWeight:700,color:'#10b981' }}>Your own wallet ⚡</div>
        </div>
      </div>
      <div style={{ background:'rgba(255,255,255,.03)',borderRadius:11,padding:'11px 15px',marginBottom:20 }}>
        <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',lineHeight:1.7 }}><strong style={{ color:'rgba(255,255,255,.45)' }}>Disclosure: </strong>On-chain operational service. You sign every transaction yourself in Xaman; we never hold your keys or funds. Not insurance, securities, or financial advice. All XRPL transactions are irrevocable.</p>
      </div>
      <button disabled={buyBlocked} onClick={()=>{ if (!buyBlocked) setStep('execute'); }} style={{ ...Btn('color',product.color,{width:'100%',padding:'15px',fontSize:16,opacity:buyBlocked?.4:1,cursor:buyBlocked?'not-allowed':'pointer'}) }}><>Build &amp; sign — free →</></button>
    </Overlay>
  );
}

// ─── SCORE MODAL ───
function ScoreModal({ show, onClose, scoreData, loading, error, onRetry, walletAddress, isExample, exampleLabel }: { show:boolean;onClose:()=>void;scoreData:ScoreData|null;loading:boolean;error:string|null;onRetry:()=>void;walletAddress:string;isExample?:boolean;exampleLabel?:string }) {
  const [animated, setAnimated] = useState(false);
  const grade = scoreData ? gradeScore(scoreData.ledgerScore) : null;
  const R = 52; const circ = 2 * Math.PI * R;
  const pct = scoreData ? Math.min(1, Math.max(0, (scoreData.ledgerScore - 300) / 550)) : 0;
  useEffect(()=>{ if(show&&scoreData){ const t=setTimeout(()=>setAnimated(true),100); return()=>clearTimeout(t); } else setAnimated(false); },[show,scoreData]);

  return (
    <Overlay show={show} onClose={onClose}>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:8,fontFamily:"'IBM Plex Mono',monospace" }}>XRPLScore™ — Live XRPL Scan</div>
      {loading&&<div style={{ textAlign:'center',padding:'44px 0' }}><div style={{ fontSize:40,animation:'spin 1s linear infinite',display:'inline-block',marginBottom:14 }}>◈</div><p style={{ color:'#10b981',fontWeight:600,fontSize:17 }}>Scanning XRPL Mainnet…</p><p style={{ color:'rgba(255,255,255,.35)',fontSize:13,marginTop:6 }}>Account age · TX history · Trust lines · AMM · NFTs</p><div style={{ width:220,height:3,background:'rgba(255,255,255,.07)',borderRadius:99,margin:'18px auto 0',overflow:'hidden' }}><div style={{ height:'100%',background:'#10b981',animation:'shimmer 1.5s ease-in-out infinite',borderRadius:99 }} /></div></div>}
      {error&&!loading&&<div style={{ textAlign:'center',padding:'28px 0' }}><div style={{ fontSize:44,marginBottom:12 }}>⚠️</div><p style={{ color:'#f87171',fontWeight:600,fontSize:17,marginBottom:8 }}>Scan failed</p><p style={{ color:'rgba(255,255,255,.4)',fontSize:13,marginBottom:22 }}>{error}</p><div style={{ display:'flex',gap:10,justifyContent:'center' }}><button onClick={onRetry} style={Btn('green')}>Retry</button><button onClick={onClose} style={Btn('ghost')}>Close</button></div></div>}
      {scoreData&&!loading&&grade&&(
        <>
          <div style={{ position:'relative',width:192,height:192,margin:'0 auto 18px',filter:`drop-shadow(0 0 28px ${grade.glow})` }}>
            <svg viewBox="0 0 120 120" style={{ width:'100%',height:'100%',transform:'rotate(-90deg)' }}>
              <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="10" />
              <circle cx="60" cy="60" r={R} fill="none" stroke={grade.color} strokeWidth="10" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={animated?circ*(1-pct):circ} style={{ transition:'stroke-dashoffset 1.4s cubic-bezier(.34,1.2,.64,1)' }} />
            </svg>
            <div style={{ position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center' }}>
              <span style={{ fontSize:52,fontWeight:900,color:grade.color,lineHeight:1,letterSpacing:'-2px',transition:'all .8s',transform:animated?'scale(1)':'scale(.7)',opacity:animated?1:0 }}>{scoreData.ledgerScore}</span>
              <span style={{ fontSize:10,color:'rgba(255,255,255,.3)',marginTop:4,letterSpacing:'.14em',textTransform:'uppercase' }}>XRPLScore</span>
            </div>
          </div>
          <div style={{ textAlign:'center',marginBottom:16 }}><span style={{ display:'inline-block',padding:'4px 16px',borderRadius:99,background:`${grade.color}18`,border:`1px solid ${grade.color}40`,color:grade.color,fontWeight:700,fontSize:15 }}>{grade.label}</span></div>
          {scoreData.details&&(
            <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:8,marginBottom:14 }}>
              {([['Transactions',(scoreData.details.txCount||0).toLocaleString()],['Account Age',`${scoreData.details.accountAge||0}d`],['XRP Balance',`${(scoreData.details.balanceXRP||0).toFixed(1)}`],['Trust Lines',String(scoreData.details.trustLines||0)],['DEX Active',scoreData.details.hasOffers?'Yes':'No'],['AMM LP',scoreData.details.hasAMM?'Yes':'No']] as [string,string][]).map(([l,v])=>(
                <div key={l} style={{ background:'rgba(255,255,255,.04)',borderRadius:10,padding:'10px 12px' }}>
                  <div style={{ fontSize:9,color:'rgba(255,255,255,.32)',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:3 }}>{l}</div>
                  <div style={{ fontSize:17,fontWeight:800 }}>{v}</div>
                </div>
              ))}
            </div>
          )}
          {isExample&&(
            <p style={{ fontSize:11,color:'rgba(255,255,255,.4)',textAlign:'center',marginBottom:12,lineHeight:1.5 }}>
              {exampleLabel||'Example wallet'} — paste your own XRPL address above for your score.
            </p>
          )}
          {walletAddress&&<p style={{ fontSize:10,color:'rgba(255,255,255,.22)',fontFamily:"'IBM Plex Mono',monospace",textAlign:'center',marginBottom:14,wordBreak:'break-all' }}>{isExample?'◈':'🔒'} {walletAddress.slice(0,12)}…{walletAddress.slice(-6)}</p>}
          <button onClick={onClose} style={{ ...Btn('green',undefined,{width:'100%',padding:'14px',fontSize:15}) }}>Done</button>
        </>
      )}
    </Overlay>
  );
}

// ─── LOGIN MODAL ───
function LoginModal({ show, onClose, onLoggedIn }: { show:boolean;onClose:()=>void;onLoggedIn:(u:User)=>void }) {
  const [tab, setTab] = useState<'login'|'signup'>('login');
  const [form, setForm] = useState({ name:'',email:'',password:'',confirm:'' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (k:string, v:string) => { setForm(f=>({...f,[k]:v})); setError(''); };
  const handleSubmit = async () => {
    if (!form.email||!form.password) { setError('Email and password required.'); return; }
    if (tab==='signup'&&form.password!==form.confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/${tab}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.message);
      if (typeof window!=='undefined') localStorage.setItem('xh_user', JSON.stringify({email:form.email,name:form.name}));
      onLoggedIn({email:form.email,name:form.name||data.name}); onClose();
    } catch {
      const user = {email:form.email,name:form.name||form.email.split('@')[0]};
      if (typeof window!=='undefined') localStorage.setItem('xh_user', JSON.stringify(user));
      onLoggedIn(user); onClose();
    } finally { setLoading(false); }
  };
  return (
    <Overlay show={show} onClose={()=>{ onClose(); setError(''); setForm({name:'',email:'',password:'',confirm:''}); }}>
      <div style={{ textAlign:'center',marginBottom:22 }}><div style={{ fontSize:32,marginBottom:8 }}>🔐</div><h2 style={{ fontSize:23,fontWeight:900 }}><Wordmark size={23} /></h2><p style={{ fontSize:13,color:'rgba(255,255,255,.4)',marginTop:4 }}>Your on-chain financial identity</p></div>
      <div style={{ display:'flex',gap:8,marginBottom:20 }}>
        {(['login','signup'] as const).map(t=><button key={t} onClick={()=>{setTab(t);setError('');}} style={{ flex:1,padding:'10px',borderRadius:12,cursor:'pointer',fontFamily:'inherit',fontWeight:600,fontSize:14,border:`1px solid ${tab===t?'#10b981':'rgba(255,255,255,.1)'}`,background:tab===t?'rgba(16,185,129,.12)':'rgba(255,255,255,.04)',color:tab===t?'#10b981':'rgba(255,255,255,.5)' }}>{t==='login'?'Log In':'Sign Up'}</button>)}
      </div>
      <div style={{ display:'flex',flexDirection:'column',gap:12 }}>
        {tab==='signup'&&<div><label style={LBL}>Full Name</label><input style={INP} type="text" value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Jane Doe" /></div>}
        <div><label style={LBL}>Email</label><input style={INP} type="email" value={form.email} onChange={e=>set('email',e.target.value)} placeholder="you@example.com" /></div>
        <div><label style={LBL}>Password</label><input style={INP} type="password" value={form.password} onChange={e=>set('password',e.target.value)} placeholder="••••••••" /></div>
        {tab==='signup'&&<div><label style={LBL}>Confirm</label><input style={INP} type="password" value={form.confirm} onChange={e=>set('confirm',e.target.value)} placeholder="••••••••" /></div>}
      </div>
      {error&&<p style={{ fontSize:12,color:'#f87171',marginTop:10 }}>{error}</p>}
      <button onClick={handleSubmit} disabled={loading} style={{ ...Btn('green',undefined,{width:'100%',padding:'14px',marginTop:18,opacity:loading?0.6:1}) }}>{loading?'⚡ Processing…':tab==='login'?'Log In →':'Create Account →'}</button>
      <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',textAlign:'center',marginTop:14 }}>Need Xaman? <a href={XAMAN_DL} target="_blank" rel="noopener noreferrer" style={{ color:'#10b981',fontWeight:600 }}>Download free →</a></p>
    </Overlay>
  );
}

// ─── DONATE MODAL — real polling payment gate (mirrors ProductModal's proven flow) ───
function DonateModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('XRP');
  const [copiedA, setCopiedA] = useState(false);
  const [payStatus, setPayStatus] = useState<'idle'|'creating'|'waiting'|'done'>('idle');
  const [uuid, setUuid] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [deepLnk, setDeepLnk] = useState('');
  const [countdown, setCountdown] = useState(900);
  const [verifiedTx, setVerifiedTx] = useState('');
  const [payError, setPayError] = useState('');
  const pollRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (payStatus !== 'waiting' || !uuid) return;
    cancelRef.current = false;
    let txid: string | null = null; // set by the socket: from then on, ledger-only checks by hash
    const xw = watchXaman(uuid, (r) => { if (r.txid) txid = r.txid; if (pollRef.current) clearTimeout(pollRef.current); poll(); });
    const poll = async () => {
      if (cancelRef.current) return;
      try {
        const params = new URLSearchParams({ ...(txid ? { hash: txid } : { uuid }), productId:'donate', amount, currency });
        const res = await fetch(`${API_URL}/api/check-payment?${params}`);
        const data = await res.json();
        if (cancelRef.current) return;
        if (data.status === 'verified') { setVerifiedTx(data.txHash || ''); setPayStatus('done'); }
        else if (data.status === 'expired') { setPayStatus('idle'); setPayError('Payment expired. Tap to try again.'); }
        else if (data.status === 'rejected') { setPayStatus('idle'); setPayError(data.reason || 'Payment declined.'); }
        else { pollRef.current = setTimeout(poll, txid ? 3000 : xw.delay()); }
      } catch { if (!cancelRef.current) pollRef.current = setTimeout(poll, txid ? 5000 : xw.delay()); }
    };
    poll();
    return () => { cancelRef.current = true; xw.stop(); if (pollRef.current) clearTimeout(pollRef.current); };
  }, [payStatus, uuid]); // eslint-disable-line

  useEffect(() => {
    if (payStatus !== 'waiting') return;
    const iv = setInterval(() => setCountdown(c => { if (c <= 1) { clearInterval(iv); if (!cancelRef.current) { setPayStatus('idle'); setPayError('Payment expired.'); } return 0; } return c - 1; }), 1000);
    return () => clearInterval(iv);
  }, [payStatus]);

  const handleClose = () => {
    cancelRef.current = true; if (pollRef.current) clearTimeout(pollRef.current);
    onClose();
    setTimeout(()=>{ setPayStatus('idle'); setAmount(''); setUuid(''); setQrUrl(''); setDeepLnk(''); setVerifiedTx(''); setPayError(''); setCountdown(900); },300);
  };

  const handleDonate = async () => {
    setPayStatus('creating'); setPayError('');
    try {
      const res = await fetch(`${API_URL}/api/create-payment`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ productId:'donate', currency, amount }) });
      const data = await res.json();
      if (!res.ok || !data.uuid) throw new Error(data.error || 'Failed to create payment');
      setUuid(data.uuid); setQrUrl(data.qr_png); setDeepLnk(data.deep_link); setCountdown(data.expires_in || 900); setPayStatus('waiting');
    } catch (e: unknown) { setPayError(e instanceof Error ? e.message : 'Payment failed'); setPayStatus('idle'); }
  };

  if (payStatus === 'done') return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ textAlign:'center',padding:'28px 0' }}>
        <div style={{ fontSize:60,marginBottom:14 }}>💚</div>
        <h3 style={{ fontSize:26,fontWeight:900,color:'#10b981',marginBottom:10 }}>Thank You.</h3>
        <p style={{ color:'rgba(255,255,255,.55)',fontSize:14,lineHeight:1.8,marginBottom:8 }}><strong style={{ color:'#fff' }}>{amount} {currency}</strong> to the community treasury.</p>
        <p style={{ color:'rgba(255,255,255,.35)',fontSize:13,lineHeight:1.75,marginBottom:26 }}>Verified on the XRP Ledger — not self-reported.</p>
        <div style={{ display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap' }}>
          <a href={`https://xrpscan.com/tx/${verifiedTx}`} target="_blank" rel="noopener noreferrer" style={{ ...Btn('ghost',undefined,{fontSize:13,textDecoration:'none'}) }}>Verify on XRPScan ↗</a>
          <button onClick={handleClose} style={Btn('green')}>Done</button>
        </div>
      </div>
    </Overlay>
  );

  if (payStatus === 'waiting') return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:5 }}>Awaiting Signature</div>
        <h3 style={{ fontSize:20,fontWeight:900,marginBottom:14 }}>Confirm in Xaman</h3>
        <XamanPayPrompt theme="light" mode="pay" qrPng={qrUrl} deepLink={deepLnk} uuid={uuid}
          amount={amount} currency={currency} destination={TREASURY} />
        <p style={{ fontSize:12,color:'rgba(255,255,255,.35)',marginTop:14 }}>Expires in {Math.floor(countdown/60)}:{String(countdown%60).padStart(2,'0')}</p>
      </div>
    </Overlay>
  );

  return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:5 }}>Donate to Treasury</div>
      <h3 style={{ fontSize:22,fontWeight:900,marginBottom:4 }}>Fund the community treasury.</h3>
      <p style={{ fontSize:13,color:'rgba(255,255,255,.44)',marginBottom:18 }}>Verified on-chain — no self-reporting.</p>
      <div style={{ background:'rgba(16,185,129,.05)',border:'1px solid rgba(16,185,129,.15)',borderRadius:12,padding:'9px 12px',marginBottom:14,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap' }}>
        <code style={{ fontSize:10,color:'#34d399',flex:1,wordBreak:'break-all',fontFamily:"'IBM Plex Mono',monospace" }}>{TREASURY}</code>
        <button onClick={()=>{ navigator.clipboard.writeText(TREASURY).then(()=>{ setCopiedA(true); setTimeout(()=>setCopiedA(false),2000); }).catch(()=>{ alert('Could not copy automatically — long-press the address above to copy it manually.'); }); }} style={{ ...Btn('ghost',undefined,{padding:'4px 9px',fontSize:10}),flexShrink:0 }}>{copiedA?'Copied':'Copy'}</button>
      </div>
      <div style={{ display:'flex',gap:8,marginBottom:12 }}>
        {(['XRP','RLUSD'] as Currency[]).map(c => (
          <button key={c} onClick={()=>setCurrency(c)} style={{ flex:1,padding:'10px',borderRadius:12,cursor:'pointer',fontFamily:'inherit',fontWeight:700,fontSize:13,border:`1px solid ${currency===c?'#10b981':'rgba(255,255,255,.1)'}`,background:currency===c?'rgba(16,185,129,.12)':'rgba(255,255,255,.04)',color:currency===c?'#10b981':'rgba(255,255,255,.5)' }}>
            {c==='XRP'?'XRP':'RLUSD'}
          </button>
        ))}
      </div>
      <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:10 }}>
        {['10','25','50','100'].map(a => <button key={a} onClick={()=>setAmount(a)} style={{ padding:'10px',borderRadius:12,cursor:'pointer',border:`1px solid ${amount===a?'#10b981':'rgba(255,255,255,.1)'}`,background:amount===a?'rgba(16,185,129,.12)':'rgba(255,255,255,.04)',color:amount===a?'#10b981':'rgba(255,255,255,.6)',fontWeight:700,fontSize:13,fontFamily:'inherit' }}>{a}</button>)}
      </div>
      <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder={`Amount in ${currency}`} style={{ ...INP, marginBottom:12 }} />
      {payError && <p style={{ fontSize:12,color:'#f87171',marginBottom:10 }}>{payError}</p>}
      <button onClick={handleDonate} disabled={!amount||parseFloat(amount)<=0||payStatus==='creating'} style={{ ...Btn('green',undefined,{width:'100%',padding:'14px',fontSize:15,opacity:(!amount||parseFloat(amount)<=0)?0.4:1}) }}>{payStatus==='creating'?'Creating…':'Donate Now'}</button>
    </Overlay>
  );
}

// ─── GRANT MODAL — submit → persisted to the human review queue ───
function GrantModal({ show, onClose, connectedWallet, user }: { show:boolean; onClose:()=>void; connectedWallet?:string; user?:{email:string;name:string}|null }) {
  const [step, setStep] = useState<'form'|'reviewing'|'success'>('form');
  const [form, setForm] = useState({ name:'', wallet:'', email:'', phone:'', category:'', need:'', amount:'25' });
  // Prefill wallet + email when the modal opens or props arrive
  useEffect(() => {
    if (!show) return;
    setForm(f => ({
      ...f,
      wallet: f.wallet || connectedWallet || '',
      email:  f.email  || user?.email      || '',
      name:   f.name   || user?.name       || '',
    }));
  }, [show, connectedWallet, user]);
  const [errors, setErrors] = useState<Record<string,string>>({});
  const cats = ['Food & Groceries','Rent / Housing','Medical Bills','Utilities','Transportation','Other'];
  const set = (k:string, v:string) => { setForm(f=>({...f,[k]:v})); setErrors(e=>({...e,[k]:'',contact:''})); };

  const validate = () => {
    const e:Record<string,string> = {};
    if (!form.need.trim()) e.need = 'Describe your situation';
    if (!form.category) e.category = 'Select a category';
    if (!form.wallet) e.wallet = 'XRPL wallet required for payout';
    else if (!form.wallet.startsWith('r') || form.wallet.length < 25) e.wallet = 'Invalid XRPL address';
    if (!form.email) e.contact = 'Email required for status updates';
    return e;
  };

  const handleSubmit = async () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setStep('reviewing');
    try {
      // 1) persist application (status PENDING) — enters the human review queue.
      await fetch(`${API_URL}/api/grants/submit`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form),
      });
    } catch {}
    setStep('success');
  };

  const handleClose = () => { onClose(); setTimeout(()=>{ setStep('form'); setForm({name:'',wallet:'',email:'',phone:'',category:'',need:'',amount:'25'}); setErrors({}); }, 300); };

  // Applications are paused (src/lib/grantsStatus.ts; the API refuses them too). Show why, keep donating open.
  if (!GRANT_APPLICATIONS_OPEN) return (
    <Overlay show={show} onClose={onClose}>
      <div style={{ textAlign:'center', padding:'8px 0' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>⏸️</div>
        <h3 style={{ fontSize:22, fontWeight:900, marginBottom:10 }}>{GRANTS_PAUSED_TITLE}</h3>
        <p style={{ fontSize:14, color:'rgba(255,255,255,.6)', lineHeight:1.75, marginBottom:12 }}>{GRANTS_PAUSED_MESSAGE}</p>
        <p style={{ fontSize:13, color:'rgba(255,255,255,.45)', lineHeight:1.75, marginBottom:20 }}>{GRANTS_DONATE_NOTE}</p>
        <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
          <button onClick={()=>{ onClose(); setTimeout(()=>document.getElementById('grants')?.scrollIntoView({ behavior:'smooth' }), 250); }} style={Btn('green')}>💚 Donate instead</button>
          <button onClick={onClose} style={Btn('ghost')}>Close</button>
        </div>
      </div>
    </Overlay>
  );

  if (step === 'reviewing') return (
    <Overlay show={show} onClose={()=>{}}>
      <div style={{ textAlign:'center', padding:'44px 0' }}>
        <div style={{ fontSize:44, animation:'spin 1s linear infinite', display:'inline-block', marginBottom:14 }}>⏳</div>
        <p style={{ color:'#8b5cf6', fontWeight:700, fontSize:17 }}>Submitting your application…</p>
        <p style={{ fontSize:13, color:'rgba(255,255,255,.38)', marginTop:6 }}>Adding you to the review queue</p>
      </div>
    </Overlay>
  );

  if (step === 'success') return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ textAlign:'center', padding:'20px 0' }}>
        <div style={{ fontSize:56, marginBottom:12 }}>❤️</div>
        <h3 style={{ fontSize:24, fontWeight:900, color:'#8b5cf6', marginBottom:10 }}>Application Received</h3>
        <p style={{ color:'rgba(255,255,255,.55)', fontSize:14, lineHeight:1.75, marginBottom:10 }}>Your ${form.amount} grant request is in our review queue. A person reviews every application. We help as many people as we can based on need, available treasury funds, and urgency.</p>
        <p style={{ color:'rgba(255,255,255,.35)', fontSize:13, lineHeight:1.75, marginBottom:24 }}>Approved funds go <strong style={{ color:'#fff' }}>directly to your XRPL wallet</strong>. You&apos;ll get a status update at {form.email}.</p>
        <button onClick={handleClose} style={Btn('color','#8b5cf6')}>Done</button>
      </div>
    </Overlay>
  );

  return (
    <Overlay show={show} onClose={handleClose} wide>
      <div style={{ fontSize:10, fontWeight:700, color:'#8b5cf6', letterSpacing:'.12em', textTransform:'uppercase', marginBottom:5 }}>Community Grant Application</div>
      <h3 style={{ fontSize:22, fontWeight:900, marginBottom:4 }}>Apply for Emergency Funds</h3>
      <p style={{ color:'rgba(255,255,255,.4)', fontSize:13, marginBottom:22 }}>$25–$100 · A person reviews every application · Direct to your XRPL wallet · No middlemen</p>

      <label style={LBL}>Category *</label>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:8, marginBottom:4 }}>
        {cats.map(c => <button key={c} onClick={()=>set('category',c)} style={{ padding:'9px', borderRadius:12, cursor:'pointer', fontSize:12, border:`1px solid ${form.category===c?'#8b5cf6':'rgba(255,255,255,.1)'}`, background:form.category===c?'rgba(139,92,246,.14)':'rgba(255,255,255,.04)', color:form.category===c?'#a78bfa':'rgba(255,255,255,.6)', fontWeight:600, fontFamily:'inherit' }}>{c}</button>)}
      </div>
      {errors.category && <p style={{ fontSize:12, color:'#f87171', marginBottom:8 }}>{errors.category}</p>}

      <label style={{ ...LBL, marginTop:16 }}>Grant Amount</label>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:16 }}>
        {['25','50','75','100'].map(a => <button key={a} onClick={()=>set('amount',a)} style={{ padding:'11px', borderRadius:12, cursor:'pointer', border:`1px solid ${form.amount===a?'#8b5cf6':'rgba(255,255,255,.1)'}`, background:form.amount===a?'rgba(139,92,246,.14)':'rgba(255,255,255,.04)', color:form.amount===a?'#a78bfa':'rgba(255,255,255,.6)', fontWeight:800, fontSize:15, fontFamily:'inherit' }}>${a}</button>)}
      </div>

      <label style={LBL}>Describe your situation *</label>
      <textarea value={form.need} onChange={e=>set('need',e.target.value)} placeholder="Tell us what you need and why…" rows={4} style={{ ...INP, resize:'none', lineHeight:1.6, marginBottom:4 }} />
      {errors.need && <p style={{ fontSize:12, color:'#f87171', marginBottom:8 }}>{errors.need}</p>}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:10, marginTop:14 }}>
        <div><label style={LBL}>Name (optional)</label><input type="text" value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Anonymous is fine" style={INP} /></div>
        <div><label style={LBL}>XRPL Wallet *</label><input type="text" value={form.wallet} onChange={e=>set('wallet',e.target.value)} placeholder="rXXXXX…" style={{ ...INP, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }} />{errors.wallet && <p style={{ fontSize:12, color:'#f87171' }}>{errors.wallet}</p>}</div>
        <div><label style={LBL}>Email *</label><input type="email" value={form.email} onChange={e=>set('email',e.target.value)} placeholder="you@example.com" style={INP} /></div>
        <div><label style={LBL}>Phone (optional)</label><input type="tel" value={form.phone} onChange={e=>set('phone',e.target.value)} placeholder="+1 555 000 0000" style={INP} /></div>
      </div>
      {errors.contact && <p style={{ fontSize:12, color:'#f87171', marginTop:4 }}>{errors.contact}</p>}

      <button onClick={handleSubmit} style={{ ...Btn('color','#8b5cf6',{width:'100%',marginTop:22,padding:'15px',fontSize:16}) }}>Submit Application →</button>
      <p style={{ textAlign:'center', fontSize:11, color:'rgba(255,255,255,.22)', marginTop:10 }}>A person reviews every application · Wallet-to-wallet</p>
    </Overlay>
  );
}

// ─── ABOUT ───
function AboutModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  return (
    <Overlay show={show} onClose={onClose} wide>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:8 }}>About XRPLHub</div>
      <h2 style={{ fontSize:24,fontWeight:900,marginBottom:18 }}>Simple tools for people who own XRP.</h2>
      <div style={{ fontSize:14,color:'rgba(255,255,255,.65)',lineHeight:1.9,display:'flex',flexDirection:'column',gap:14 }}>
        <p>XRPLHub is for people who just bought XRP and want to do more with it. You don&apos;t need a bank account or a credit history. You just need an XRP wallet, like Xaman.</p>
        <p>We only build things nobody else offers, and everything here is free for you:</p>
        <p><strong style={{ color:'#10b981' }}>Wallet Score</strong> (XRPLScore™): a score from 300 to 850 for any XRP wallet, built only from that wallet&apos;s public history. It can be up to 15 minutes old. It scores a wallet, not a person. It isn&apos;t a credit check and doesn&apos;t use your name or ID.</p>
        <p><strong style={{ color:'#fff' }}>Spend Controls</strong>: give someone an allowance they can only spend with people you pick, or pay one bill every week or month. You approve each payment in your own wallet. <strong style={{ color:'#fff' }}>Token Check</strong>: before you buy a tokenized asset, see whether its creator can freeze it, take it back or block you from selling it.</p>
        <p><strong style={{ color:'#10b981' }}>Community Grants</strong>: people donate to a public wallet anyone can see. A person reads every application and decides. Approved grants go straight to the person&apos;s wallet. (Applications are paused until the wallet is funded.)</p>
        <p style={{ fontSize:12,color:'rgba(255,255,255,.4)',fontStyle:'italic' }}>Businesses can license the XRPLScore™ method. Partnership questions: <a href="mailto:partners@xrplhub.io" style={{ color:'#10b981' }}>partners@xrplhub.io</a></p>
      </div>
      <button onClick={onClose} style={{ ...Btn('green',undefined,{marginTop:24}) }}>Close</button>
    </Overlay>
  );
}

// ─── FAQ ───
function FAQModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  const [open, setOpen] = useState<number|null>(0);
  const faqs:[string,string][] = [
    ['Do I need to know crypto?','No. If you have an XRP wallet like Xaman, you can use everything here.'],
    ['Does XRPLHub ever hold my money?','No. Your money stays in your wallet, and you approve every payment yourself. We never see your keys.'],
    ["What's free?",'The wallet score, Spend Controls, Token Check and the wallet permissions check are free. Business tools are paid.'],
    ['What is the Wallet Score?',"A score from 300 to 850 for any XRP wallet, like a credit score, but built only from that wallet's public history: how old it is, how it's been used, how much it keeps on hand. It can be up to 15 minutes old. It scores a wallet, not a person. It isn't a credit check and doesn't use your name, ID or any credit bureau."],
    ['How does Spend Controls work?',"You pick who can be paid and how much, each week or month. Each payment is a check you approve in your own wallet, and the person you pay cashes it, up to the amount you set. We only ever make this week's or this month's payment, never one ahead. You can cancel any payment that hasn't been cashed."],
    ['How do grants work?',"People donate XRP or RLUSD to a public grants wallet anyone can see on XRPScan. Applications are paused until it is funded. When they reopen, anyone in need can apply for $25–$100. A person reads every application and decides, and approved money goes straight to the person's XRP wallet."],
    ['Which wallet do I need?','Xaman, free on iPhone and Android at xaman.app, is how you sign in here and the wallet we recommend. On a computer you can also approve payments with Crossmark or GemWallet. Use the same wallet address you signed in with.'],
    ['Is XRPLHub a bank?','No. We are not a bank, broker or insurer, and your money is not FDIC insured. We never hold your money or your keys.'],
  ];
  return (
    <Overlay show={show} onClose={onClose} wide>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:20 }}>FAQ</div>
      <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
        {faqs.map(([q,a],i)=>(
          <div key={i} style={{ background:'rgba(255,255,255,.03)',border:'1px solid rgba(255,255,255,.07)',borderRadius:14,overflow:'hidden' }}>
            <button onClick={()=>setOpen(open===i?null:i)} style={{ width:'100%',padding:'15px 18px',background:'transparent',border:'none',color:'#fff',fontWeight:700,fontSize:14,cursor:'pointer',textAlign:'left',display:'flex',justifyContent:'space-between',alignItems:'center',fontFamily:'inherit',gap:10 }}>
              <span style={{ flex:1 }}>{q}</span><span style={{ color:'#10b981',fontSize:18,flexShrink:0 }}>{open===i?'−':'+'}</span>
            </button>
            {open===i && <div style={{ padding:'0 18px 16px',fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.8 }}>{a}</div>}
          </div>
        ))}
      </div>
      <button onClick={onClose} style={{ ...Btn('ghost',undefined,{marginTop:20}) }}>Close</button>
    </Overlay>
  );
}

// ─── TERMS ───
function TermsModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  const H:React.CSSProperties = { color:'#10b981',fontWeight:800,display:'block',marginTop:20,marginBottom:6,fontSize:13,textTransform:'uppercase',letterSpacing:'.04em' };
  const P:React.CSSProperties = { fontSize:13,color:'rgba(255,255,255,.58)',lineHeight:1.85,marginBottom:8 };
  return (
    <Overlay show={show} onClose={onClose} wide>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:6 }}>Legal</div>
      <h2 style={{ fontSize:22,fontWeight:900,marginBottom:4 }}>Terms of Service</h2>
      <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',marginBottom:18 }}>xrplhub.io · Last updated {new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
      <div style={{ maxHeight:'60vh',overflowY:'auto',paddingRight:8 }}>
        <p style={P}>By using xrplhub.io you agree to these Terms in full.</p>
        <span style={H}>1. Who We Are</span>
        <p style={P}>XRPLHub is a financial technology platform on the XRP Ledger providing XRPLScore, Spend Controls, MPT issuer risk and a community grant program. We are not a bank, broker-dealer, investment advisor, insurer, or FDIC-insured institution.</p>
        <span style={H}>2. Eligibility</span>
        <p style={P}>You must be 18+ and legally able to enter contracts in your jurisdiction. Service unavailable where prohibited by law, including OFAC-sanctioned regions.</p>
        <span style={H}>3. Transactions We Build</span>
        <p style={P}>XRPLHub builds transactions only inside its own products (Spend Controls checks, MPT issuance with a recorded backing declaration, XRPLScore-gated Permissioned Domains), and charges nothing for them. We build the exact transaction for your wallet and you sign and submit it yourself. XRPLHub never holds your keys and cannot sign for you. <strong style={{ color:'rgba(255,255,255,.8)' }}>All XRPL transactions are final and irrevocable</strong>, and if the ledger rejects a transaction you may need to correct your details and try again. These are not insurance contracts, securities, or financial instruments.</p>
        <span style={H}>4. XRPLScore™</span>
        <p style={P}>XRPLScore™ is our proprietary on-chain assessment derived from public XRPL wallet data. It is not a FICO score, consumer credit report, or NRSRO rating, and has no affiliation with any credit bureau. The XRPLScore™ name, methodology, signal weighting, and underlying framework are intellectual property of XRPLHub and are available for commercial licensing.</p>

        <span style={H}>4A. Continuous Monitoring (addendum)</span>
        <p style={P}>Continuous monitoring is an optional service that reports observed changes in public XRP Ledger data (account activity, an XRPLScore recomputed from that data, an exact-match comparison against the OFAC SDN list, and — only if the XRPL Lending Protocol is enabled — loan status) for wallets you choose, checked about once a day; it is not real-time. It is layered on top of your own underwriting and does not replace it: it cannot see borrower credit, collateral, legal structure, or anything off the ledger, it gives no recommendation, and it does not estimate the probability that any wallet will default. Absence of a reported change is not a statement that a wallet is safe. You may not use any output of the monitoring service, alone or combined with other data, to make or communicate any decision about a consumer&apos;s eligibility for credit, insurance, employment, housing, or any other purpose governed by the U.S. Fair Credit Reporting Act (FCRA) or the Equal Credit Opportunity Act (ECOA); you confirm this by accepting the acknowledgement required when you subscribe, which we store with a timestamp and version. You are responsible for your webhook endpoint and for verifying webhook signatures; we may disable a webhook that repeatedly fails to acknowledge deliveries, and monitoring capacity is limited and may be full. Monitoring records are append-only and are retained. This addendum is effective 2026-09-20.</p>
        <span style={H}>5. Community Grant Program</span>
        <p style={P}>Donations are voluntary and irrevocable. Every grant application is reviewed by a person; there are no automated approvals or denials. Submission does not guarantee disbursement. Grants range $25–$100 subject to treasury availability.</p>
        <span style={H}>6. Your Wallet — Your Responsibility</span>
        <p style={P}>You are solely responsible for your XRPL wallet, private keys, and seed phrases. XRPLHub never has access to your private keys. Lost keys result in permanent, unrecoverable loss.</p>
        <span style={H}>7. Prohibited Uses</span>
        <p style={P}>No use for money laundering, fraud, terrorist financing, false grant applications, score manipulation, reverse engineering, or automated scraping beyond normal human use.</p>
        <span style={H}>8. Disclaimers & Liability</span>
        <p style={P}>PLATFORM PROVIDED "AS IS." LIABILITY CAPPED AT THE GREATER OF $100 OR 12-MONTH PAYMENTS. NO INDIRECT, CONSEQUENTIAL, OR PUNITIVE DAMAGES.</p>
        <span style={H}>9. Contact</span>
        <p style={P}><a href="mailto:legal@xrplhub.io" style={{ color:'#10b981' }}>legal@xrplhub.io</a></p>
      </div>
      <button onClick={onClose} style={{ ...Btn('ghost',undefined,{marginTop:18,width:'100%'}) }}>Close</button>
    </Overlay>
  );
}

// ─── PRIVACY ───
function PrivacyModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  const H:React.CSSProperties = { color:'#10b981',fontWeight:800,display:'block',marginTop:20,marginBottom:6,fontSize:13,textTransform:'uppercase',letterSpacing:'.04em' };
  const P:React.CSSProperties = { fontSize:13,color:'rgba(255,255,255,.58)',lineHeight:1.85,marginBottom:8 };
  return (
    <Overlay show={show} onClose={onClose} wide>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:6 }}>Legal</div>
      <h2 style={{ fontSize:22,fontWeight:900,marginBottom:4 }}>Privacy Policy</h2>
      <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',marginBottom:18 }}>xrplhub.io · Last updated {new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
      <div style={{ maxHeight:'60vh',overflowY:'auto',paddingRight:8 }}>
        <span style={H}>1. What We Collect</span>
        <p style={P}>Name, email, phone, XRPL wallet address, and grant application details you provide. Public on-chain XRPL data used to compute XRPLScore. Standard usage analytics.</p>
        <span style={H}>2. What We Never Collect</span>
        <p style={P}>Private keys or seed phrases · Plain-text passwords · Payment card numbers · Full SSN. We will never ask for your private key. Any such request is fraud.</p>
        <span style={H}>3. How We Use Your Information</span>
        <p style={P}>Service delivery · XRPLScore calculation · Grant review and processing · Transaction receipts · Legal compliance · Fraud investigation.</p>
        <span style={H}>4. On-Chain Data</span>
        <p style={P}>Because XRPL is a public blockchain, your wallet address and transactions are publicly visible. We read this public data to compute XRPLScore. On-chain data cannot be modified or deleted by anyone.</p>
        <span style={H}>5. Sharing</span>
        <p style={P}>We do not sell or rent your data. Shared only with: service providers under confidentiality agreements · law enforcement when legally required.</p>
        <span style={H}>6. Security</span>
        <p style={P}>TLS in transit · encryption at rest · role-based access controls. No system is 100% secure.</p>
        <span style={H}>7. Your Rights</span>
        <p style={P}>Access · correction · deletion (subject to retention laws) · data portability. Contact: <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a> — 30-day response.</p>
        <span style={H}>8. California (CCPA)</span>
        <p style={P}>CA residents: right to know, delete, and opt out of sale (we do not sell data).</p>
        <span style={H}>9. Children</span>
        <p style={P}>Service is for 18+. We do not knowingly collect data from minors.</p>
        <span style={H}>10. Contact</span>
        <p style={P}><a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a></p>
      </div>
      <button onClick={onClose} style={{ ...Btn('ghost',undefined,{marginTop:18,width:'100%'}) }}>Close</button>
    </Overlay>
  );
}

// ─── PERSONAL XRPLScore CREDIT REPORT (inline, replaces section when wallet connects) ───
type SignalRow = { signal:string; label:string; score:number; weight?:string; desc?:string };
interface PersonalData {
  ledgerScore: number;
  grade?: string;
  details?: { txCount?: number; accountAge?: number; balanceXRP?: number; trustLines?: number; hasOffers?: boolean; hasAMM?: boolean };
  scannedAt?: string;
  breakdown?: SignalRow[];
  recommendations?: Array<{action:string;points:string;priority:'high'|'medium'|'low'}>;
  percentile?: number;
  percentileLabel?: string;
}

const GRADE_THEME: Record<string,{primary:string;glow:string;label:string}> = {
  Exceptional: { primary:'#10b981', glow:'rgba(16,185,129,.55)', label:'Top of the ledger' },
  Excellent:   { primary:'#34d399', glow:'rgba(52,211,153,.5)',  label:'Strong on-chain reputation' },
  Good:        { primary:'#38bdf8', glow:'rgba(56,189,248,.5)',  label:'Healthy XRPL profile' },
  Fair:        { primary:'#f59e0b', glow:'rgba(245,158,11,.5)',  label:'Room to grow' },
  Building:    { primary:'#a78bfa', glow:'rgba(167,139,250,.5)', label:'Early stage — build from here' },
};

// Derive simple 8-signal breakdown from `details` when the API didn't return one
function deriveBreakdown(d?: PersonalData['details']): SignalRow[] {
  if (!d) return [];
  const clamp = (n:number) => Math.max(0, Math.min(100, Math.round(n)));
  return [
    { signal:'age',      label:'Account Age',       score: clamp(((d.accountAge||0) / 365) * 50), desc:`${d.accountAge||0} days on XRPL` },
    { signal:'velocity', label:'TX Velocity',       score: clamp(Math.log10(Math.max(1, d.txCount||0)) * 25), desc:`${d.txCount||0} lifetime transactions` },
    { signal:'trust',    label:'Trust Lines',       score: clamp(((d.trustLines||0) / 6) * 100), desc:`${d.trustLines||0} active trust lines` },
    { signal:'dex',      label:'DEX Activity',      score: d.hasOffers ? 75 : 10, desc: d.hasOffers ? 'Active on the DEX' : 'No DEX activity yet' },
    { signal:'amm',      label:'AMM Activity',      score: d.hasAMM ? 80 : 10, desc: d.hasAMM ? 'Liquidity provider' : 'Not active in AMMs' },
    { signal:'reserve',  label:'Reserve Health',    score: clamp(Math.log10(Math.max(1, d.balanceXRP||0)) * 33), desc:`${(d.balanceXRP||0).toFixed(2)} XRP balance` },
    { signal:'nft',      label:'NFT Activity',      score: 30, desc:'Mint or hold NFTs to raise this signal' },
    { signal:'security', label:'Security Flags',    score: 30, desc:'Multi-sig and other security setups raise this' },
  ];
}

function pctLabel(score: number): { percentile:number; label:string } {
  // Fallback for when the API response carries no percentile. MUST mirror
  // peerPercentile() in src/lib/xrplscore.ts exactly (same thresholds, same
  // bands) so the same score never shows two different percentiles. "scanned
  // wallets" — the calibration sample over-represents active wallets, so this
  // is not a share of ALL XRPL wallets (see docs/XRPLSCORE-CALIBRATION.md).
  const percentile =
    score >= 800 ? 98 :
    score >= 740 ? 92 :
    score >= 670 ? 78 :
    score >= 580 ? 55 :
    score >= 450 ? 30 : 15;
  return { percentile, label: `Higher than ${percentile}% of scanned XRPL wallets` };
}

function PersonalCreditReport({ wallet, data, history, loading }: {
  wallet: string; data: PersonalData | null; history: Array<{score:number;scannedAt:string}>;
  loading: boolean;
}) {
  if (loading && !data) {
    return (
      <div style={{ textAlign:'center', padding:'56px 20px' }}>
        <div style={{ fontSize:42, marginBottom:12, animation:'spin 1.5s linear infinite', display:'inline-block' }}>📡</div>
        <p style={{ color:'#10b981', fontWeight:700, fontSize:15 }}>Pulling your live XRPLScore™ from the ledger…</p>
      </div>
    );
  }
  if (!data) return null;

  const grade = (data.grade && GRADE_THEME[data.grade]) || GRADE_THEME.Building;
  const pct = Math.max(0, Math.min(100, ((data.ledgerScore - 300) / 550) * 100));
  const pInfo = (typeof data.percentile === 'number' && data.percentileLabel)
    ? { percentile: data.percentile, label: data.percentileLabel }
    : pctLabel(data.ledgerScore);
  const signals: SignalRow[] = (data.breakdown && data.breakdown.length) ? data.breakdown : deriveBreakdown(data.details);

  return (
    <div style={{ animation:'scoreReveal .6s ease-out' }}>
      {/* HEADER LINE — credit-report eyebrow */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18, flexWrap:'wrap', gap:10 }}>
        <div style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
          <span style={{ width:7, height:7, borderRadius:'50%', background:grade.primary, boxShadow:`0 0 12px ${grade.glow}`, animation:'pulse 2s infinite' }} />
          <span style={{ fontSize:11, fontWeight:800, color:grade.primary, letterSpacing:'.16em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace" }}>Your XRPLScore™ · The On-Chain Credit Standard</span>
        </div>
        <span style={{ fontSize:11, color:'rgba(255,255,255,.32)', fontFamily:"'IBM Plex Mono',monospace" }}>{wallet.slice(0,10)}…{wallet.slice(-6)}</span>
      </div>

      {/* HERO TILE — big score + grade + percentile + bar */}
      <div style={{ background:`linear-gradient(135deg, ${grade.primary}18, rgba(6,6,22,.85))`, border:`1px solid ${grade.primary}45`, borderRadius:22, padding:'32px 26px', marginBottom:18, position:'relative', overflow:'hidden' }}>
        <div style={{ position:'absolute', top:-70, right:-70, width:280, height:280, borderRadius:'50%', background:`radial-gradient(circle, ${grade.primary}22 0%, transparent 70%)`, pointerEvents:'none' }} />
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:28, alignItems:'center', position:'relative' }}>
          <div>
            <div style={{ fontSize:'clamp(64px,12vw,108px)', fontWeight:900, color:grade.primary, lineHeight:1, letterSpacing:'-4px', textShadow:`0 0 32px ${grade.glow}`, fontFamily:"'IBM Plex Mono',monospace", animation:'numberPop .9s cubic-bezier(.2,.9,.3,1.2)' }}>{data.ledgerScore}</div>
            <div style={{ display:'inline-block', marginTop:10, padding:'5px 14px', borderRadius:99, background:`${grade.primary}22`, border:`1px solid ${grade.primary}55`, color:grade.primary, fontWeight:800, fontSize:13, letterSpacing:'.04em' }}>{data.grade || 'Building'} · {grade.label}</div>
          </div>
          <div>
            <div style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'rgba(255,255,255,.45)', marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>
                <span>300</span><span>575</span><span>850</span>
              </div>
              <div style={{ height:10, background:'rgba(255,255,255,.06)', borderRadius:99, overflow:'hidden', position:'relative' }}>
                <div style={{ height:'100%', width:`${pct}%`, background:`linear-gradient(90deg, ${grade.primary}, ${grade.primary})`, borderRadius:99, transition:'width 1.2s cubic-bezier(.2,.9,.3,1.2)', boxShadow:`0 0 18px ${grade.glow}` }} />
              </div>
            </div>
            <div style={{ background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:'11px 14px' }}>
              <div style={{ fontSize:10, fontWeight:800, color:'rgba(255,255,255,.42)', letterSpacing:'.13em', textTransform:'uppercase', marginBottom:3, fontFamily:"'IBM Plex Mono',monospace" }}>Peer Percentile</div>
              <div style={{ fontSize:15, fontWeight:800, color:'#fff' }}>{pInfo.label}</div>
            </div>
          </div>
        </div>
      </div>

      {/* TRAJECTORY (if history exists) */}
      {history.length >= 2 && (
        <div style={{ background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)', borderRadius:16, padding:'16px 20px', marginBottom:18 }}>
          <div style={{ fontSize:10, fontWeight:800, color:grade.primary, letterSpacing:'.14em', textTransform:'uppercase', marginBottom:10, fontFamily:"'IBM Plex Mono',monospace" }}>Score Trajectory · {history.length} scans</div>
          <ReportSparkline points={history} color={grade.primary} />
        </div>
      )}

      {/* 8 SIGNAL BREAKDOWN */}
      <div style={{ background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)', borderRadius:16, padding:'18px 20px', marginBottom:18 }}>
        <div style={{ fontSize:10, fontWeight:800, color:grade.primary, letterSpacing:'.14em', textTransform:'uppercase', marginBottom:14, fontFamily:"'IBM Plex Mono',monospace" }}>The 8 Proprietary Signals · Your Breakdown</div>
        <div style={{ display:'grid', gap:11 }}>
          {signals.map(b => <ReportSignal key={b.signal} b={b} />)}
        </div>
      </div>

      {/* RECOMMENDATIONS (if API returned them) */}
      {data.recommendations && data.recommendations.length > 0 && (
        <div style={{ background:`linear-gradient(135deg, ${grade.primary}10, rgba(6,6,22,.85))`, border:`1px solid ${grade.primary}25`, borderRadius:16, padding:'18px 20px', marginBottom:18 }}>
          <div style={{ fontSize:10, fontWeight:800, color:grade.primary, letterSpacing:'.14em', textTransform:'uppercase', marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>How to raise your score</div>
          <p style={{ fontSize:12, color:'rgba(255,255,255,.5)', marginBottom:14 }}>Take these actions on-chain — your XRPLScore rescans the moment your wallet activity changes.</p>
          <div style={{ display:'grid', gap:8 }}>
            {data.recommendations.map((r,i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, padding:'12px 14px', background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:11, flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:180 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:9, fontWeight:800, padding:'2px 7px', borderRadius:99, background: r.priority==='high'?'#ef4444':r.priority==='medium'?'#f59e0b':'#34d399', color: r.priority==='high'?'#fff':'#000', textTransform:'uppercase', letterSpacing:'.08em', fontFamily:"'IBM Plex Mono',monospace" }}>{r.priority}</span>
                    <span style={{ fontSize:13, fontWeight:600, color:'#fff' }}>{r.action}</span>
                  </div>
                </div>
                <span style={{ fontSize:13, fontWeight:800, color:grade.primary, fontFamily:"'IBM Plex Mono',monospace", whiteSpace:'nowrap' }}>{r.points}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportSignal({ b }: { b: SignalRow }) {
  const pct = Math.max(0, Math.min(100, b.score));
  const color = pct >= 70 ? '#10b981' : pct >= 45 ? '#f59e0b' : '#ef4444';
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:5, gap:8, flexWrap:'wrap' }}>
        <div>
          <span style={{ fontSize:13, fontWeight:700, color:'#fff' }}>{b.label}</span>
          {b.weight && <span style={{ fontSize:10, color:'rgba(255,255,255,.32)', marginLeft:8, fontFamily:"'IBM Plex Mono',monospace" }}>weight {b.weight}</span>}
        </div>
        <span style={{ fontSize:14, fontWeight:800, color, fontFamily:"'IBM Plex Mono',monospace" }}>{pct}/100</span>
      </div>
      <div style={{ height:6, background:'rgba(255,255,255,.05)', borderRadius:99, overflow:'hidden', marginBottom:4 }}>
        <div style={{ height:'100%', width:`${pct}%`, background:color, borderRadius:99, transition:'width 1s cubic-bezier(.2,.9,.3,1.2)' }} />
      </div>
      {b.desc && <p style={{ fontSize:11, color:'rgba(255,255,255,.4)' }}>{b.desc}</p>}
    </div>
  );
}

function ReportSparkline({ points, color }: { points: Array<{score:number;scannedAt:string}>; color:string }) {
  if (points.length < 2) return null;
  const w = 700, h = 100, pad = 8;
  const scores = points.map(p => p.score);
  const min = Math.min(...scores, 300), max = Math.max(...scores, 850);
  const range = Math.max(max - min, 1);
  const xs = (i:number) => pad + (i / (points.length-1)) * (w - 2*pad);
  const ys = (v:number) => h - pad - ((v - min) / range) * (h - 2*pad);
  const path = points.map((p,i) => `${i===0?'M':'L'}${xs(i).toFixed(1)},${ys(p.score).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  const delta = last.score - first.score;
  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width:'100%', height:100, display:'block' }}>
        <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xs(points.length-1)} cy={ys(last.score)} r="5" fill={color} />
      </svg>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'rgba(255,255,255,.42)', marginTop:6, fontFamily:"'IBM Plex Mono',monospace" }}>
        <span>First scan: {first.score}</span>
        <span style={{ color: delta >= 0 ? '#10b981' : '#ef4444', fontWeight:800 }}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)} pts</span>
        <span>Latest: <strong style={{ color }}>{last.score}</strong></span>
      </div>
    </>
  );
}

// ═══ MAIN PAGE ═══
export default function XRPLHubHome() {
  const [user, setUser]               = useState<User|null>(null);
  const [connectedWallet, setConnected] = useState('');
  const pricing = usePricing();
  const [scoreData, setScoreData]     = useState<ScoreData|null>(null);
  const [scoreLoading, setSL]         = useState(false);
  const [scoreError, setSE]           = useState<string|null>(null);
  const [demoScore, setDemoScore]     = useState(false); // showing the example wallet, not the visitor's
  // Inline personalized credit-report state — populated automatically when a wallet is connected
  const [personalScore, setPersonalScore]     = useState<ScoreData & { breakdown?: Array<{signal:string;label:string;score:number;weight?:string;desc?:string}>; recommendations?: Array<{action:string;points:string;priority:'high'|'medium'|'low'}>; percentile?: number; percentileLabel?: string } | null>(null);
  const [personalLoading, setPersonalLoading] = useState(false);
  const [scoreHistory, setScoreHistory]       = useState<Array<{score:number;scannedAt:string}>>([]);
  const [walletInput, setWI]          = useState('');
  const [activeProduct, setAP]        = useState<Product|null>(null);
  const [mobileMenu, setMM]           = useState(false);
  const [showScore, setShowScore]     = useState(false);
  const [showDonate, setShowDonate]   = useState(false);
  const [showGrant, setShowGrant]     = useState(false);
  const [showAbout, setShowAbout]     = useState(false);
  const [showFaq, setShowFaq]         = useState(false);
  const [showTerms, setShowTerms]     = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const s = localStorage.getItem('xh_user');  if (s) { try { setUser(JSON.parse(s)); } catch {} }
    const w = localStorage.getItem('xh_wallet'); if (w) { setConnected(w); setWI(w); }
  }, []);

  // Deep-link (/?product=mptissue): open the MPT issuance modal directly.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('product');
    if (!id) return;
    const p = PRODUCTS.find((x) => x.id === id);
    if (p) setAP(p);
    // Drop the query param so a refresh/close doesn't keep re-opening it.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const handleWalletConnected = (addr: string) => {
    setConnected(addr); setWI(addr);
    if (typeof window !== 'undefined') localStorage.setItem('xh_wallet', addr);
  };
  const disconnectWallet = () => {
    setConnected(''); setWI('');
    if (typeof window !== 'undefined') localStorage.removeItem('xh_wallet');
  };

  const fetchScore = useCallback(async (address?: string) => {
    const explicit = address || walletInput || connectedWallet;
    const target = explicit || DEMO_WALLET;
    setDemoScore(!explicit);
    setScoreData(null); setSE(null); setSL(true); setShowScore(true);
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 14000);
      const res  = await fetch(`${API_URL}/api/score/${encodeURIComponent(target)}`, { signal:ctrl.signal });
      clearTimeout(t);
      if (!res.ok) { const b = await res.json().catch(()=>({})); throw new Error(b.error||b.message||`Error ${res.status}`); }
      const raw = await res.json();
      setScoreData({ ledgerScore:raw.ledgerScore||raw.score||650, grade:raw.grade, details:raw.details, scannedAt:raw.scannedAt });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') setSE('XRPL scan timed out. Try again.');
      else setSE(err instanceof Error ? err.message : 'Scan failed.');
    } finally { setSL(false); }
  }, [walletInput, connectedWallet]);

  // ─── Auto-fetch personalized XRPLScore the moment a wallet connects ───
  // Silent, inline. Populates the home XRPLScore section as a personal credit report.
  useEffect(() => {
    if (!connectedWallet) { setPersonalScore(null); setScoreHistory([]); return; }
    let cancelled = false;
    setPersonalLoading(true);
    (async () => {
      try {
        const [sRes, hRes] = await Promise.all([
          fetch(`${API_URL}/api/score/${encodeURIComponent(connectedWallet)}`),
          fetch(`${API_URL}/api/score/history/${encodeURIComponent(connectedWallet)}`).catch(()=>null),
        ]);
        if (cancelled) return;
        if (sRes.ok) {
          const raw = await sRes.json();
          setPersonalScore({
            ledgerScore: raw.ledgerScore || raw.score || 650,
            grade:       raw.grade,
            details:     raw.details,
            scannedAt:   raw.scannedAt,
            breakdown:   raw.breakdown,
            recommendations: raw.recommendations,
            percentile:  raw.percentile,
            percentileLabel: raw.percentileLabel,
          });
        }
        if (hRes && hRes.ok) {
          const h = await hRes.json();
          const arr = Array.isArray(h) ? h : (h.history || []);
          setScoreHistory(arr.map((p:Record<string,unknown>) => ({ score: Number(p.score) || 0, scannedAt: String(p.date || p.scannedAt || p.checkedAt || '') })));
        }
      } catch {}
      if (!cancelled) setPersonalLoading(false);
    })();
    return () => { cancelled = true; };
  }, [connectedWallet]);

  const handleLogout = () => { setUser(null); if (typeof window !== 'undefined') localStorage.removeItem('xh_user'); };
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        html{scroll-behavior:smooth}body{overflow-x:hidden;max-width:100%}
        ::placeholder{color:rgba(255,255,255,.18)!important}
        input,textarea,button,select{font-family:inherit}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:99px}
        ::selection{background:rgba(16,185,129,.28);color:#fff}
        @keyframes popIn{from{opacity:0;transform:scale(.93) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
        @keyframes shimmer{0%{width:0%;margin-left:0}50%{width:70%;margin-left:0}100%{width:0%;margin-left:100%}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(16,185,129,.7)}50%{opacity:.75;box-shadow:0 0 0 6px rgba(16,185,129,0)}}
        @keyframes glow{0%,100%{box-shadow:0 0 20px rgba(16,185,129,.25)}50%{box-shadow:0 0 55px rgba(16,185,129,.6)}}
        @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
        @keyframes borderPulse{0%,100%{border-color:rgba(16,185,129,.22)}50%{border-color:rgba(16,185,129,.55)}}
        @keyframes tickerScroll{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}
        @keyframes scoreReveal{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes numberPop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1);opacity:1}}
        .prod-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14}
        @media(max-width:900px){.prod-grid{grid-template-columns:repeat(2,1fr)}}
        @media(max-width:520px){.prod-grid{grid-template-columns:1fr}}
        .pcard-hero-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24;align-items:center}
        @media(max-width:640px){.pcard-hero-row{grid-template-columns:1fr;text-align:center}.pcard-hero-row > div:last-child{text-align:center}}
        .ticker-track{will-change:transform;backface-visibility:hidden;-webkit-backface-visibility:hidden}
        .ticker-track:hover{animation-play-state:paused}
        .pcard-featured{transition:transform .22s,box-shadow .22s;cursor:pointer}.pcard-featured:hover{transform:translateY(-6px);box-shadow:0 0 60px rgba(16,185,129,.18),0 28px 70px rgba(0,0,0,.6)!important}
        .pcard{transition:transform .22s,box-shadow .22s;cursor:pointer}.pcard:hover{transform:translateY(-4px);box-shadow:0 0 40px rgba(16,185,129,.1),0 20px 50px rgba(0,0,0,.5)!important}
        .navbtn{padding:8px 16px;border-radius:99px;font-weight:600;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:rgba(255,255,255,.62);transition:all .15s;white-space:nowrap}.navbtn:hover{background:rgba(255,255,255,.1);color:#fff}
        .hero-p:hover{transform:scale(1.04);box-shadow:0 0 55px rgba(255,255,255,.25)!important}
        .hero-g:hover{background:rgba(255,255,255,.1)!important;border-color:rgba(255,255,255,.35)!important}
        .score-inp:focus{border-color:rgba(16,185,129,.5)!important}
        .footer-lnk{background:none;border:none;color:rgba(255,255,255,.38);font-size:13px;cursor:pointer;font-family:inherit;padding:0;transition:color .15s}.footer-lnk:hover{color:#fff}
        .wallet-btn{padding:8px 18px;border-radius:99px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;border:1px solid rgba(16,185,129,.35);background:rgba(16,185,129,.12);color:#10b981;transition:all .15s;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}.wallet-btn:hover{background:rgba(16,185,129,.22);border-color:#10b981}
        .bg-surface{background-image:linear-gradient(to bottom,rgba(3,4,14,.82) 0%,rgba(3,4,14,.92) 100%),url('${BG}');background-size:cover;background-position:center;background-repeat:no-repeat;background-attachment:fixed}
        @media(max-width:900px){.bg-surface{background-attachment:scroll}}
        .nav-desktop{display:flex}.nav-mobile-toggle{display:none}.nav-mobile-drawer{display:none}
        @media(max-width:880px){.nav-desktop{display:none}.nav-mobile-toggle{display:flex}.nav-mobile-drawer{display:flex;flex-direction:column;gap:8px;padding:16px;background:rgba(3,3,10,.95);border-top:1px solid rgba(255,255,255,.08);backdrop-filter:blur(20px)}.nav-mobile-drawer .navbtn,.nav-mobile-drawer .wallet-btn{width:100%;text-align:center;padding:12px;justify-content:center}}
        @media(max-width:640px){h1{letter-spacing:-2px!important}.section-pad{padding-left:16px!important;padding-right:16px!important}.hero-buttons{flex-direction:column}.hero-buttons button{width:100%}}
      `}</style>

      <div className="bg-surface" style={{ position:'fixed',inset:0,zIndex:-1 }} />

      <div style={{ minHeight:'100vh',fontFamily:"'Syne',sans-serif",color:'#eeeef5',maxWidth:'100%',overflowX:'hidden' }}>

        {/* NAV */}
        <nav style={{ position:'sticky',top:0,zIndex:100,background:'rgba(3,4,14,.72)',backdropFilter:'blur(22px)',WebkitBackdropFilter:'blur(22px)',borderBottom:'1px solid rgba(16,185,129,.18)' }}>
          <div style={{ padding:'0 20px',minHeight:68,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap' }}>
            <div style={{ display:'flex',alignItems:'center',gap:9 }}>
              <img src="/hub-logo.png" alt="XRPLHub" style={{ width:34,height:34,borderRadius:9,flexShrink:0,objectFit:'cover' }} onError={e=>{(e.currentTarget as HTMLImageElement).style.display='none';}} />
              <div style={{ display:'flex',flexDirection:'column',gap:1 }}>
                <Wordmark size={18} />
                <span style={{ fontSize:9,color:'rgba(255,255,255,.45)',letterSpacing:'.07em',textTransform:'uppercase',lineHeight:1 }}>{connectedWallet ? '· xApp Mode' : 'Wallet Score · Spend Controls · Token Check'}</span>
              </div>
            </div>
            <div className="nav-desktop" style={{ alignItems:'center',gap:7,flexWrap:'wrap' }}>
              {connectedWallet
                ? <button className="wallet-btn" onClick={disconnectWallet} title="Disconnect"><span style={{ width:6,height:6,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 6px #10b981' }} />{trunc(connectedWallet)} ✕</button>
                : <button className="wallet-btn" onClick={()=>setShowConnect(true)}>🔐 Connect Wallet</button>}
              <a className="navbtn" href="/pricing">Score API</a>
              <button className="navbtn" onClick={()=>setShowDonate(true)}>Donate</button>
              <button className="navbtn" onClick={()=>setShowGrant(true)}>{GRANT_APPLICATIONS_OPEN ? 'Apply for Grant' : 'Grants (paused)'}</button>
              <button onClick={()=>fetchScore()} style={{ padding:'8px 18px',borderRadius:99,fontFamily:'inherit',fontWeight:700,fontSize:13,cursor:'pointer',border:'none',background:'#10b981',color:'#000',whiteSpace:'nowrap' }}>Get XRPLScore</button>
            </div>
            <button className="nav-mobile-toggle" onClick={()=>setMM(!mobileMenu)} style={{ alignItems:'center',justifyContent:'center',width:42,height:42,borderRadius:10,background:'rgba(16,185,129,.12)',border:'1px solid rgba(16,185,129,.28)',color:'#10b981',cursor:'pointer',fontSize:20,fontWeight:700 }} aria-label="Menu">{mobileMenu?'✕':'☰'}</button>
          </div>
          {mobileMenu && (
            <div className="nav-mobile-drawer">
              {connectedWallet
                ? <button className="wallet-btn" onClick={()=>{disconnectWallet();setMM(false);}}><span style={{ width:6,height:6,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 6px #10b981' }} />{trunc(connectedWallet)} ✕</button>
                : <button className="wallet-btn" onClick={()=>{setShowConnect(true);setMM(false);}}>🔐 Connect Wallet</button>}
              <a className="navbtn" href="/pricing" onClick={()=>setMM(false)}>Score API</a>
              <button className="navbtn" onClick={()=>{setShowDonate(true);setMM(false);}}>Donate</button>
              <button className="navbtn" onClick={()=>{setShowGrant(true);setMM(false);}}>{GRANT_APPLICATIONS_OPEN ? 'Apply for Grant' : 'Grants (paused)'}</button>
              <button onClick={()=>{fetchScore();setMM(false);}} style={{ padding:'12px',borderRadius:99,fontFamily:'inherit',fontWeight:700,fontSize:14,cursor:'pointer',border:'none',background:'#10b981',color:'#000' }}>Get XRPLScore</button>
            </div>
          )}
        </nav>

        {TEST_MODE && (
          <div style={{ background:'linear-gradient(90deg,#f59e0b,#ef4444,#f59e0b)', color:'#000', textAlign:'center', padding:'6px 12px', fontSize:11, fontWeight:900, letterSpacing:'.12em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace" }}>
            ⚠️ Test Mode Active · All purchases charge ~1 drop · Flip TEST_MODE=false in page.tsx before launch
          </div>
        )}
        <TickerBar />

        {/* HERO */}
        <section className="section-pad" style={{ textAlign:'center',padding:'72px 24px 56px',position:'relative',overflow:'hidden' }}>
          <div style={{ position:'absolute',top:'35%',left:'50%',transform:'translate(-50%,-50%)',width:'min(700px,95vw)',height:'min(700px,95vw)',borderRadius:'50%',background:'radial-gradient(circle,rgba(16,185,129,.08) 0%,transparent 68%)',pointerEvents:'none',animation:'float 9s ease-in-out infinite' }} />
          <h1 style={{ fontSize:'clamp(40px,8vw,96px)',fontWeight:900,letterSpacing:'-3px',lineHeight:.95,marginBottom:20 }}>
            <span style={brandGradientText}>Do more with your XRP.</span>
          </h1>
          <p style={{ margin:'0 auto 28px',maxWidth:640,fontSize:'clamp(17px,2.4vw,22px)',fontWeight:600,color:'rgba(255,255,255,.75)',lineHeight:1.5 }}>
            Check any wallet. Give money with rules. Look before you buy. Free.
          </p>

          <div style={{ marginBottom:24 }}>
            {connectedWallet
              ? <div style={{ display:'inline-flex',alignItems:'center',gap:10,background:'rgba(16,185,129,.12)',border:'1px solid rgba(16,185,129,.3)',borderRadius:99,padding:'10px 22px' }}>
                  <span style={{ width:8,height:8,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 10px #10b981',animation:'pulse 2s infinite' }} />
                  <span style={{ fontSize:14,fontWeight:700,color:'#10b981',fontFamily:"'IBM Plex Mono',monospace" }}>{trunc(connectedWallet)}</span>
                  <span style={{ fontSize:12,color:'rgba(255,255,255,.4)' }}>connected</span>
                </div>
              : <button onClick={()=>setShowConnect(true)} style={{ display:'inline-flex',alignItems:'center',gap:10,background:'rgba(16,185,129,.14)',border:'1px solid rgba(16,185,129,.3)',borderRadius:99,padding:'12px 26px',fontSize:15,fontWeight:700,color:'#10b981',cursor:'pointer',fontFamily:'inherit' }}>🔐 Connect Xaman Wallet</button>}
          </div>

          <div className="hero-buttons" style={{ display:'flex',gap:12,justifyContent:'center',flexWrap:'wrap',marginBottom:36 }}>
            <button className="hero-p" onClick={()=>document.getElementById('score')?.scrollIntoView({behavior:'smooth'})} style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'16px 32px',background:'#fff',color:'#000',fontSize:16,fontWeight:700,borderRadius:99,border:'none',cursor:'pointer',boxShadow:'0 4px 28px rgba(255,255,255,.12)' }}>
              Check a wallet →
            </button>
            <a className="hero-g" href="/spend" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'16px 32px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:16,fontWeight:600,borderRadius:99,background:'transparent',cursor:'pointer',backdropFilter:'blur(8px)',textDecoration:'none' }}>
              Give money with rules →
            </a>
            <a className="hero-g" href="#mpt" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'16px 32px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:16,fontWeight:600,borderRadius:99,background:'transparent',cursor:'pointer',backdropFilter:'blur(8px)',textDecoration:'none' }}>
              Check a token →
            </a>
          </div>

          <a href={XAMAN_DL} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex',alignItems:'center',gap:8,fontSize:13,color:'#10b981',fontWeight:600,textDecoration:'none' }}>
            📲 Works with the free Xaman wallet app (iPhone and Android). Crossmark and GemWallet work on a computer. →
          </a>
        </section>

        {/* THREE FREE TOOLS — the three products nobody else offers (competitive map, 2026-10-06), in plain English */}
        <section id="only" className="section-pad" style={{ padding:'0 24px 56px',maxWidth:1240,margin:'0 auto' }}>
          <div style={{ textAlign:'center',marginBottom:30 }}>
            <div style={{ display:'inline-flex',alignItems:'center',gap:6,marginBottom:12 }}>
              <span style={{ width:5,height:5,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 8px #10b981' }} />
              <span style={{ fontSize:11,fontWeight:700,color:'#10b981',letterSpacing:'.14em',textTransform:'uppercase' }}>Free</span>
            </div>
            <h2 style={{ fontSize:'clamp(24px,4vw,42px)',fontWeight:900,letterSpacing:'-2px',marginBottom:12 }}>Three free tools</h2>
            <p style={{ fontSize:14,color:'rgba(255,255,255,.48)',maxWidth:600,margin:'0 auto',lineHeight:1.7 }}>Your money stays in your own wallet, and you approve every payment yourself. We never see your keys.</p>
          </div>
          <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:18 }}>
            <div style={{ background:'linear-gradient(135deg,rgba(16,185,129,.1),rgba(6,6,22,.85))',border:'1px solid rgba(16,185,129,.28)',borderRadius:22,padding:'26px 24px',display:'flex',flexDirection:'column' }}>
              <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:8,fontFamily:"'IBM Plex Mono',monospace" }}>What&apos;s this wallet&apos;s track record?</div>
              <h3 style={{ fontSize:22,fontWeight:900,marginBottom:10 }}>Wallet Score</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:14 }}>Paste any XRP wallet address. You get a score from 300 to 850, like a credit score, but built only from that wallet&apos;s public history: how old it is, how it&apos;s been used, how much it keeps on hand. It scores a wallet, not a person. It isn&apos;t a credit check and doesn&apos;t use your name or ID.</p>
              <div style={{ display:'flex',flexDirection:'column',gap:6,marginBottom:18,fontSize:12,color:'rgba(255,255,255,.55)' }}>
                {['Free for any wallet, no sign-up','Look up an address before you send money to it','Connect your own wallet to see your full report'].map(f=><div key={f}><span style={{ color:'#10b981' }}>✓</span> {f}</div>)}
              </div>
              <div style={{ display:'flex',gap:8,flexWrap:'wrap',marginTop:'auto' }}>
                <button onClick={()=>document.getElementById('score')?.scrollIntoView({behavior:'smooth'})} style={{ padding:'11px 18px',borderRadius:99,background:'#10b981',color:'#000',border:'none',fontWeight:800,fontSize:13,cursor:'pointer',fontFamily:'inherit' }}>Check a wallet →</button>
              </div>
            </div>
            <div style={{ background:'linear-gradient(135deg,rgba(56,189,248,.1),rgba(6,6,22,.85))',border:'1px solid rgba(56,189,248,.28)',borderRadius:22,padding:'26px 24px',display:'flex',flexDirection:'column' }}>
              <div style={{ fontSize:10,fontWeight:700,color:'#38bdf8',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:8,fontFamily:"'IBM Plex Mono',monospace" }}>Give money with rules</div>
              <h3 style={{ fontSize:22,fontWeight:900,marginBottom:10 }}>Spend Controls</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:14 }}>Give your kids an allowance they can only spend at places you pick, up to amounts you set. Or pay a bill or subscription every week or month. You approve each payment in your own wallet; when a new month starts, we send that month&apos;s payment to your wallet to approve. Cancel anytime.</p>
              <div style={{ display:'flex',flexDirection:'column',gap:6,marginBottom:18,fontSize:12,color:'rgba(255,255,255,.55)' }}>
                {['Only the people and places you pick can be paid','Allowances are paid in RLUSD, a digital US dollar','Monthly payments can be XRP or RLUSD'].map(f=><div key={f}><span style={{ color:'#38bdf8' }}>✓</span> {f}</div>)}
              </div>
              <div style={{ marginTop:'auto' }}>
                <a href="/spend" style={{ display:'inline-block',padding:'11px 18px',borderRadius:99,background:'#38bdf8',color:'#000',fontWeight:800,fontSize:13,textDecoration:'none' }}>Give money with rules →</a>
              </div>
            </div>
            <div id="mpt" style={{ background:'linear-gradient(135deg,rgba(245,158,11,.1),rgba(6,6,22,.85))',border:'1px solid rgba(245,158,11,.28)',borderRadius:22,padding:'26px 24px',display:'flex',flexDirection:'column' }}>
              <div style={{ fontSize:10,fontWeight:700,color:'#f59e0b',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:8,fontFamily:"'IBM Plex Mono',monospace" }}>Look before you buy</div>
              <h3 style={{ fontSize:22,fontWeight:900,marginBottom:10 }}>Token Check</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:14 }}>Before you buy a tokenized asset, see what its creator can do: freeze it, take it back from you, block you from selling it, or make you ask permission to hold it.</p>
              <p style={{ fontSize:12,color:'rgba(255,255,255,.45)',marginBottom:12,lineHeight:1.6,fontStyle:'italic' }}>This checks tokenized assets only, the newer kind of token. It can&apos;t check every XRP token yet.</p>
              <MptPowerCheck />
            </div>
          </div>
          <a href="/permissions" style={{ display:'flex',alignItems:'center',justifyContent:'space-between',gap:14,flexWrap:'wrap',marginTop:18,padding:'18px 22px',borderRadius:18,border:'1px solid rgba(239,68,68,.3)',background:'linear-gradient(135deg,rgba(239,68,68,.08),rgba(6,6,22,.85))',color:'#fff',textDecoration:'none' }}>
            <span>
              <span style={{ display:'block',fontSize:10,fontWeight:700,color:'#f87171',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:4,fontFamily:"'IBM Plex Mono',monospace" }}>New · free</span>
              <span style={{ display:'block',fontSize:18,fontWeight:900,marginBottom:4 }}>Who can move money from my wallet?</span>
              <span style={{ display:'block',fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.6 }}>See everyone who can take money out of an XRP wallet — a second key, signers, someone you gave permission to, a check — and remove the ones you don&apos;t want.</span>
            </span>
            <span style={{ padding:'11px 18px',borderRadius:99,background:'#f87171',color:'#000',fontWeight:800,fontSize:13,whiteSpace:'nowrap' }}>Check my wallet →</span>
          </a>
        </section>

        {/* XRPLSCORE — anonymous pitch + checker (or personalized credit report when wallet connected) */}
        <section id="score" className="section-pad" style={{ padding:'0 24px 48px',maxWidth:1240,margin:'0 auto' }}>
          <div style={{ background:'linear-gradient(135deg,rgba(16,185,129,.07),rgba(6,6,22,.85))',border:'1px solid rgba(16,185,129,.18)',borderRadius:24,padding:'40px 32px',backdropFilter:'blur(20px)',animation:'borderPulse 4s ease-in-out infinite' }}>
          {connectedWallet ? (
            <PersonalCreditReport
              wallet={connectedWallet}
              data={personalScore}
              history={scoreHistory}
              loading={personalLoading}
            />
          ) : (
            <div style={{ maxWidth:560,margin:'0 auto' }}>
                <div style={{ display:'inline-flex',alignItems:'center',gap:6,marginBottom:14 }}>
                  <span style={{ width:5,height:5,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 8px #10b981',animation:'pulse 2s infinite' }} />
                  <span style={{ fontSize:11,fontWeight:700,color:'#10b981',letterSpacing:'.14em',textTransform:'uppercase' }}>Wallet Score · free, no sign-up</span>
                </div>
                <h2 style={{ fontSize:'clamp(22px,3.3vw,36px)',fontWeight:900,letterSpacing:'-2px',marginBottom:14 }}>Check any XRP wallet.</h2>
                <p style={{ fontSize:13,color:'rgba(255,255,255,.5)',lineHeight:1.8,marginBottom:20 }}>
                  Paste a wallet address to see its score. Free, no sign-up. The score comes only from the wallet&apos;s public history and can be up to 15 minutes old.
                  It scores a wallet, not a person. It isn&apos;t a credit check.
                </p>

                {/* score checker */}
                <div style={{ display:'flex',gap:9,flexWrap:'wrap' }}>
                  <input className="score-inp" type="text" value={walletInput} onChange={e=>setWI(e.target.value)} onKeyDown={e=>e.key==='Enter'&&fetchScore(walletInput)} placeholder="Paste an XRP wallet address (starts with r)…" style={{ ...INP,flex:1,minWidth:180,borderRadius:99,paddingLeft:20,fontFamily:"'IBM Plex Mono',monospace",fontSize:12 }} />
                  <button onClick={()=>fetchScore(walletInput)} style={{ padding:'12px 22px',borderRadius:99,background:'#10b981',color:'#000',border:'none',fontWeight:800,fontSize:13,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap' }}>Check →</button>
                </div>
                <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',marginTop:10 }}>or <button onClick={()=>setShowConnect(true)} style={{ background:'none',border:'none',color:'#10b981',cursor:'pointer',fontWeight:700,fontSize:11,fontFamily:'inherit',padding:0 }}>connect your Xaman wallet</button> to see your own wallet&apos;s full report</p>
            </div>
          )}
          </div>
        </section>

        {/* GRANTS */}
        <section id="grants" className="section-pad" style={{ padding:'0 24px 72px',maxWidth:1100,margin:'0 auto' }}>
          <div style={{ textAlign:'center',marginBottom:34 }}>
            <div style={{ display:'inline-flex',alignItems:'center',gap:6,marginBottom:12 }}><span style={{ width:5,height:5,borderRadius:'50%',background:'#8b5cf6',boxShadow:'0 0 8px #8b5cf6' }} /><span style={{ fontSize:11,fontWeight:700,color:'#8b5cf6',letterSpacing:'.14em',textTransform:'uppercase' }}>Community Grants</span></div>
            <h2 style={{ fontSize:'clamp(22px,3.5vw,34px)',fontWeight:900,letterSpacing:'-2px',marginBottom:12 }}>Real people. Real money. Straight to their wallet.</h2>
            <p style={{ fontSize:13,color:'rgba(255,255,255,.48)',lineHeight:1.8,maxWidth:580,margin:'0 auto' }}>People donate to a public wallet anyone can look at. A person reads every application and decides. Approved grants go straight to the person&apos;s own wallet, and every payment in and out is public.{!GRANT_APPLICATIONS_OPEN && ' Applications are currently paused until the treasury is funded.'}</p>
          </div>
          <TreasuryStatsBar />
          <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:20 }}>

            {/* Donate */}
            <div style={{ background:'linear-gradient(135deg,rgba(16,185,129,.08),rgba(6,6,22,.8))',border:'1px solid rgba(16,185,129,.2)',borderRadius:22,padding:'30px 26px',backdropFilter:'blur(20px)' }}>
              <div style={{ fontSize:40,marginBottom:14,animation:'float 4s ease-in-out infinite' }}>💚</div>
              <h3 style={{ fontSize:21,fontWeight:900,marginBottom:10 }}>Fund the Treasury</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.48)',lineHeight:1.8,marginBottom:20 }}>Send XRP or RLUSD to our public grants wallet. It goes straight there, with no one in between, and anyone can see it on XRPScan.</p>
              <div style={{ background:'rgba(16,185,129,.08)',border:'1px solid rgba(16,185,129,.22)',borderRadius:11,padding:'11px 14px',marginBottom:10,textAlign:'center' }}>
                <div style={{ fontSize:9,fontWeight:700,color:'rgba(255,255,255,.4)',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:4 }}>Pay in Xaman to</div>
                <div style={{ fontSize:18,fontWeight:900,color:'#10b981',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:'-.5px' }}>xrplhub.xrp</div>
                <div style={{ fontSize:10,color:'rgba(255,255,255,.32)',marginTop:4,fontFamily:"'IBM Plex Mono',monospace" }}>XRPNS · resolves to {TREASURY.slice(0,10)}…{TREASURY.slice(-6)}</div>
              </div>
              <div style={{ background:'rgba(16,185,129,.04)',border:'1px solid rgba(16,185,129,.12)',borderRadius:11,padding:'8px 12px',marginBottom:16 }}>
                <code style={{ fontSize:10,color:'rgba(255,255,255,.5)',wordBreak:'break-all',lineHeight:1.5,fontFamily:"'IBM Plex Mono',monospace" }}>{TREASURY}</code>
              </div>
              <button onClick={()=>setShowDonate(true)} style={{ ...Btn('green',undefined,{width:'100%',padding:'14px',fontSize:15,marginBottom:8}) }}>💚 Donate via Xaman →</button>
              <a href={`https://xrpscan.com/account/${TREASURY}`} target="_blank" rel="noopener noreferrer" style={{ ...Btn('ghost',undefined,{width:'100%',padding:'12px',fontSize:13,textDecoration:'none'}) }}>View Treasury on XRPScan ↗</a>
            </div>

            {/* Apply */}
            <div style={{ background:'linear-gradient(135deg,rgba(139,92,246,.08),rgba(6,6,22,.8))',border:'1px solid rgba(139,92,246,.2)',borderRadius:22,padding:'30px 26px',backdropFilter:'blur(20px)' }}>
              <div style={{ fontSize:40,marginBottom:14,animation:'float 4s ease-in-out infinite',animationDelay:'1s' }}>❤️</div>
              <h3 style={{ fontSize:21,fontWeight:900,marginBottom:10 }}>{GRANT_APPLICATIONS_OPEN ? 'Apply for a Grant' : GRANTS_PAUSED_TITLE}</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.48)',lineHeight:1.8,marginBottom:18 }}>{GRANT_APPLICATIONS_OPEN ? 'Need help? Apply for $25–$100. A person reads every application and decides. If approved, the money goes to your XRP wallet.' : GRANTS_PAUSED_MESSAGE}</p>
              <div style={{ display:'flex',flexDirection:'column',gap:7,marginBottom:20 }}>
                {(GRANT_APPLICATIONS_OPEN
                  ? ['Fill in a short application','A person reads it and decides','Approved money goes straight to your wallet','No bank account or ID needed']
                  : ['Grants are $25–$100 when applications reopen','A person reads every application','Approved grants are paid from the public grants wallet','You can still donate now']
                ).map(f=>(
                  <div key={f} style={{ display:'flex',alignItems:'center',gap:8,fontSize:12,color:'rgba(255,255,255,.52)' }}>
                    <span style={{ color:'#8b5cf6',fontSize:11 }}>✓</span>{f}
                  </div>
                ))}
              </div>
              <button onClick={()=>setShowGrant(true)} style={{ ...Btn('color','#8b5cf6',{width:'100%',padding:'14px',fontSize:15}) }}>{GRANT_APPLICATIONS_OPEN ? 'Apply for a Grant →' : 'Read the update →'}</button>
            </div>

          </div>
        </section>

        {/* FOR BUSINESSES AND DEVELOPERS — the technical terms live here, not in the consumer cards above */}
        <section id="api" className="section-pad" style={{ padding:'0 24px 56px',maxWidth:980,margin:'0 auto' }}>
          <div style={{ ...GLASS,borderRadius:22,padding:'34px 28px' }}>
            <div style={{ fontSize:10,fontWeight:700,color:'#38bdf8',letterSpacing:'.14em',textTransform:'uppercase',marginBottom:8,fontFamily:"'IBM Plex Mono',monospace" }}>For businesses and developers</div>
            <h2 style={{ fontSize:'clamp(22px,3.4vw,30px)',fontWeight:900,letterSpacing:'-1px',marginBottom:10 }}>Tools for businesses, builders and AI agents</h2>
            <p style={{ fontSize:14,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:18,maxWidth:680 }}>
              The same XRPLScore™ (300–850, 8 public on-chain signals) as one REST call, plus paid tools built on it. Free API tier with no card; paid plans billed in RLUSD.
              Autonomous agents can pay per call over x402, with no account and no key.
            </p>
            <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:'8px 18px',marginBottom:20,fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.6 }}>
              {[
                ['Sanctions screening','OFAC SDN screening with a receipt that proves you checked'],
                ['Wallet alerts','continuous monitoring with HMAC-signed webhooks'],
                ['Payment pre-check for AI agents','one verdict before paying an XRPL address (x402, pay per call)'],
                ['Score API + MCP server','REST, OpenAPI and an MCP server for agents'],
                ['MPT issuer risk','issuer powers and holder data for Multi-Purpose Tokens'],
                ['Lending data','XLS-66 loan exposure and underwriting inputs, live when lending activates'],
              ].map(([t,d])=><div key={t}><span style={{ color:'#38bdf8' }}>✓</span> <strong style={{ color:'#fff' }}>{t}</strong>: {d}</div>)}
            </div>
            <div style={{ background:'rgba(0,0,0,.35)',border:'1px solid rgba(255,255,255,.1)',borderRadius:12,padding:'14px 16px',marginBottom:20,overflowX:'auto' }}>
              <code style={{ fontSize:12,color:'rgba(255,255,255,.75)',fontFamily:"'IBM Plex Mono',monospace",whiteSpace:'pre',lineHeight:1.7 }}>{`curl -H "authorization: Bearer xrs_live_..." \\
  "https://www.xrplhub.io/api/v1/score?wallet=rXXXX..."`}</code>
            </div>
            <div style={{ display:'flex',gap:12,flexWrap:'wrap',marginBottom:22 }}>
              <a href="/pricing" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'13px 26px',background:'#10b981',color:'#000',fontSize:14,fontWeight:800,borderRadius:99,textDecoration:'none' }}>See pricing & get a key →</a>
              <a href="/openapi.json" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'13px 26px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:14,fontWeight:600,borderRadius:99,textDecoration:'none' }}>OpenAPI spec ↗</a>
              <a href="/.well-known/x402" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'13px 26px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:14,fontWeight:600,borderRadius:99,textDecoration:'none' }}>x402 discovery ↗</a>
            </div>
            <div style={{ borderTop:'1px solid rgba(255,255,255,.08)',paddingTop:18 }}>
              <div style={{ fontSize:14,fontWeight:800,marginBottom:6 }}>Issuing a Multi-Purpose Token?</div>
              <p style={{ fontSize:12,color:'rgba(255,255,255,.5)',lineHeight:1.6,marginBottom:10,maxWidth:640 }}>Build the MPTokenIssuanceCreate with a recorded backing declaration. Free; you sign in your own wallet. It earns the io.xrplhub.mpt.v1.declared credential, a record of what you declared, never a verification of it.</p>
              <button onClick={()=>{ const p = PRODUCTS.find(x=>x.id==='mptissue'); if (p) setAP(p); }} style={{ padding:'10px 16px',borderRadius:99,border:'1px solid rgba(245,158,11,.4)',background:'transparent',color:'#f59e0b',fontWeight:700,fontSize:12,cursor:'pointer',fontFamily:'inherit' }}>Issue an MPT with a backing declaration →</button>
            </div>
          </div>
        </section>

        {/* PLAIN FAQ — for people who just bought XRP */}
        <section id="faq" className="section-pad" style={{ padding:'0 24px 72px',maxWidth:820,margin:'0 auto' }}>
          <h2 style={{ fontSize:'clamp(22px,3.4vw,30px)',fontWeight:900,letterSpacing:'-1px',marginBottom:18,textAlign:'center' }}>Questions</h2>
          <div style={{ display:'flex',flexDirection:'column',gap:12 }}>
            {[
              ['Do I need to know crypto?','No. If you have an XRP wallet like Xaman, you can use everything here.'],
              ['Does XRPLHub ever hold my money?','No. Your money stays in your wallet, and you approve every payment yourself. We never see your keys.'],
              ['What\'s free?','The wallet score, Spend Controls, Token Check and the wallet permissions check are free. Business tools are paid.'],
            ].map(([q,a])=>(
              <div key={q} style={{ background:'rgba(255,255,255,.03)',border:'1px solid rgba(255,255,255,.08)',borderRadius:14,padding:'16px 18px' }}>
                <div style={{ fontSize:15,fontWeight:800,marginBottom:6 }}>{q}</div>
                <div style={{ fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.7 }}>{a}</div>
              </div>
            ))}
          </div>
        </section>

        {/* FOOTER */}
        <footer style={{ background:'rgba(3,4,14,.72)',backdropFilter:'blur(14px)',borderTop:'1px solid rgba(255,255,255,.07)',padding:'32px 24px 28px' }}>
          <div style={{ maxWidth:1240,margin:'0 auto' }}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:18,marginBottom:20 }}>
              <div>
                <div style={{ display:'flex',alignItems:'center',gap:8,marginBottom:6 }}>
                  <img src="/hub-logo.png" alt="" style={{ width:26,height:26,borderRadius:7,objectFit:'cover' }} onError={e=>{(e.currentTarget as HTMLImageElement).style.display='none';}} />
                  <Wordmark size={15} />
                </div>
                <p style={{ fontSize:11,color:'rgba(255,255,255,.24)' }}>© 2026 XRPLHub.io · XRPLScore™ · All Rights Reserved</p>
                <p style={{ fontSize:10,color:'rgba(255,255,255,.16)',marginTop:2 }}>XRPLHub™ and XRPLScore™ are trademarks. Platform and content protected by copyright.</p>
                <p style={{ fontSize:10,color:'rgba(255,255,255,.16)',marginTop:2 }}>Not a bank · Not a broker · We never hold your money · You approve every payment</p>
              </div>
              <div style={{ display:'flex',gap:'10px 18px',flexWrap:'wrap',alignItems:'center' }}>
                <a href={XAMAN_DL} target="_blank" rel="noopener noreferrer" className="footer-lnk" style={{ color:'#10b981',textDecoration:'none' }}>📲 Get Xaman</a>
                <a href="/pricing" className="footer-lnk" style={{ textDecoration:'none' }}>Score API</a>
                <a href="/openapi.json" className="footer-lnk" style={{ textDecoration:'none' }}>API Docs</a>
                <button className="footer-lnk" onClick={()=>setShowAbout(true)}>About</button>
                <button className="footer-lnk" onClick={()=>setShowFaq(true)}>FAQ</button>
                <button className="footer-lnk" onClick={()=>setShowTerms(true)}>Terms</button>
                <button className="footer-lnk" onClick={()=>setShowPrivacy(true)}>Privacy</button>
                <a href="mailto:support@xrplhub.io" style={{ fontSize:13,color:'rgba(255,255,255,.38)',textDecoration:'none' }}>support@xrplhub.io</a>
                <a href={`https://xrpscan.com/account/${TREASURY}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11,color:'#10b981',textDecoration:'none',display:'flex',alignItems:'center',gap:5,fontFamily:"'IBM Plex Mono',monospace" }}>
                  <span style={{ width:5,height:5,borderRadius:'50%',background:'#10b981',animation:'pulse 2.5s infinite' }} />Treasury Live ↗
                </a>
              </div>
            </div>
          </div>
        </footer>
      </div>

      {/* MODALS */}
      <ConnectWalletModal show={showConnect} onClose={()=>setShowConnect(false)} onConnected={handleWalletConnected} />
      <ScoreModal show={showScore} onClose={()=>setShowScore(false)} scoreData={scoreData} loading={scoreLoading} error={scoreError} onRetry={()=>fetchScore(walletInput||connectedWallet)} walletAddress={(walletInput||connectedWallet)||(demoScore?DEMO_WALLET:'')} isExample={demoScore} exampleLabel={DEMO_WALLET_LABEL} />
      <ProductModal show={!!activeProduct} onClose={()=>setAP(null)} product={activeProduct} connectedWallet={connectedWallet} />
      <DonateModal show={showDonate} onClose={()=>setShowDonate(false)} />
      <GrantModal show={showGrant} onClose={()=>setShowGrant(false)} connectedWallet={connectedWallet} user={user} />
      <AboutModal show={showAbout} onClose={()=>setShowAbout(false)} />
      <FAQModal show={showFaq} onClose={()=>setShowFaq(false)} />
      <TermsModal show={showTerms} onClose={()=>setShowTerms(false)} />
      <PrivacyModal show={showPrivacy} onClose={()=>setShowPrivacy(false)} />
    </>
  );
}
