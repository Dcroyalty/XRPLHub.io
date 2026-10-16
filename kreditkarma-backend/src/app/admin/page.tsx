'use client';
import BrandLogo from "@/components/BrandLogo";
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { watchXaman } from '@/lib/wallet/xamanWatch';
import WalletPicker from '@/lib/wallet/WalletPicker';
import XamanPayPrompt from '@/components/XamanPayPrompt';
import { getProvider, resolveProviderOptions, WalletCancelled, type ProviderOption, type ProveContext } from '@/lib/wallet';

const API_URL = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) || '';
// Admin auth is a signed session COOKIE (httpOnly), set by /api/admin/auth/claim after a Xaman SignIn
// proves control of a wallet in ADMIN_WALLETS -- see src/lib/adminSession.ts. Same-origin fetch sends
// it automatically; nothing to store or thread through props client-side.

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Grant {
  id: string; walletAddress: string; category: string;
  amountRequested: number; currency: string; description: string;
  urgency: string; status: string; aiScore?: number; aiReasoning?: string;
  approvedAmount?: number; paidAmount?: number; txHash?: string; paidAt?: string;
  createdAt: string; scoreSnapshot?: number;
  round?: string | null; email?: string | null;
  payoutAddress?: string | null; payoutTag?: number | null;
  proposedPayoutAddress?: string | null; proposedPayoutTag?: number | null; proposedAt?: string | null;
}
// Grants are paid in RLUSD from the grants pool (owner rule 2026-10-16); the payout goes to the accepted payout
// address/tag, else the applicant's wallet.
const GRANTS_POOL_ACCOUNT = 'raiqAnACKxmVY7oCUWnCYdGquSrkMdsMuu';
const payTo = (g: Grant) => ({ address: g.payoutAddress || g.walletAddress, tag: g.payoutTag ?? null });
interface ScoreCheck {
  address: string; score: number; tier: string; checkedAt: string;
}
interface Donation {
  id: string; fromAddress: string; amount: number;
  currency: string; txHash: string; createdAt: string;
}
interface Payment {
  id: string; productId: string; currency: string; amount: string;
  wallet: string | null; txHash: string | null; status: string;
  verifiedAt: string; deliveredAt: string | null;
}
interface CredentialActivity {
  objectIndex: string; issuer: string; subject: string; credentialType: string;
  accepted: boolean; expirationRipple: number | null; lastSeenAt: string;
}
interface QueuedCredential {
  id: string; kind: string; subject: string; tier: string; subjectRef: string | null; requestedAt: string;
}
interface WatchdogOpen { key: string; alertingSince: string | null; }
interface AdminData {
  treasury: { address: string; balanceXRP: number; balanceUSD: number; xrpPrice: number };
  grants:   { total: number; byStatus: Record<string,number>; pending: number; recent: Grant[] };
  scores:   { totalChecks: number; recent: ScoreCheck[] };
  donations:{ count: number; totalXRP: number; recent: Donation[] };
  payments: { byStatus: Record<string,number>; recent: Payment[] };
  credentials: { byRequestStatus: Record<string,number>; queued: QueuedCredential[]; recentOnLedger: CredentialActivity[] };
  watchdog: { lastPassAt: string | null; open: WatchdogOpen[] };
  updatedAt: string;
}

// ─── STYLE HELPERS ────────────────────────────────────────────────────────────
const GLASS: React.CSSProperties = { background:'rgba(6,6,22,.82)', backdropFilter:'blur(20px)', WebkitBackdropFilter:'blur(20px)', border:'1px solid rgba(255,255,255,.09)', borderRadius:16 };
const CARD = (accent = '#d4a72c'): React.CSSProperties => ({ ...GLASS, padding:20, borderLeft:`3px solid ${accent}` });
const INP: React.CSSProperties = { width:'100%', background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.15)', borderRadius:10, padding:'11px 14px', fontSize:14, color:'#fff', outline:'none', fontFamily:'inherit', boxSizing:'border-box' };

function StatusBadge({ s }: { s: string }) {
  const map: Record<string,[string,string]> = {
    PENDING:   ['#fbbf24','rgba(251,191,36,.15)'],
    REVIEWING: ['#60a5fa','rgba(96,165,250,.15)'],
    APPROVED:  ['#d4a72c','rgba(212,167,44,.15)'],
    REJECTED:  ['#f87171','rgba(248,113,113,.15)'],
    PAID:      ['#e3bf55','rgba(52,211,153,.15)'],
    FAILED:    ['#f97316','rgba(249,115,22,.15)'],
  };
  const [color, bg] = map[s] || ['#9ca3af','rgba(156,163,175,.1)'];
  return <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:99, background:bg, color, letterSpacing:'.06em', border:`1px solid ${color}40` }}>{s}</span>;
}

function UrgencyBadge({ u }: { u: string }) {
  const map: Record<string,string> = { EMERGENCY:'#ef4444', HIGH:'#f97316', MEDIUM:'#fbbf24', LOW:'#d4a72c' };
  const c = map[u] || '#9ca3af';
  return <span style={{ fontSize:9, fontWeight:800, padding:'2px 7px', borderRadius:99, background:`${c}18`, color:c, border:`1px solid ${c}30` }}>{u}</span>;
}

function trunc(a: string, n = 8) { return a ? `${a.slice(0,n)}…${a.slice(-4)}` : '—'; }
function fmt(d: string) { return new Date(d).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }

// ─── GRANT ACTIONS PANEL ──────────────────────────────────────────────────────
// "Issue" is the one-tap payout: POST /api/admin/pay-link builds a pre-filled treasury -> recipient
// Xaman payload (the treasury key stays in Xaman, never touches the server -- same guarantee every
// other payment flow on this site already gives customers). We poll it, and on signed, auto-submit
// the resulting hash to the SAME /api/grants/approve PAID action the manual "paste a hash" path
// already used -- nothing about grant approval itself changed, only how the hash gets there.
function GrantActions({ grant, onUpdate }: { grant: Grant; onUpdate: () => void }) {
  const [loading, setLoading] = useState('');
  const [note, setNote]       = useState('');
  const [amount, setAmount]   = useState(String(grant.amountRequested));
  const [payTxHash, setPayTxHash] = useState('');
  const txHashValid = /^[A-Fa-f0-9]{64}$/.test(payTxHash.trim());
  const [issueQr, setIssueQr] = useState<string | null>(null);
  const [issueLink, setIssueLink] = useState<string | null>(null);
  const [issueUuid, setIssueUuid] = useState<string | null>(null);
  const [issueMsg, setIssueMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const act = async (action: string, body: object) => {
    setLoading(action);
    try {
      const verbMap: Record<string,string> = { approve:'APPROVE', reject:'REJECT', pay:'PAID' };
      const payload = { id: grant.id, action: verbMap[action] || action.toUpperCase(), ...body };
      const res = await fetch(`${API_URL}/api/grants/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        alert(`Action failed: ${json.error || res.status}. The grant was not updated.`);
      }
      onUpdate();
    } catch (e) {
      alert(`Network error — grant not updated. ${e instanceof Error ? e.message : ''}`);
    }
    finally { setLoading(''); }
  };

  const startIssue = async () => {
    setLoading('issue'); setIssueMsg('');
    try {
      // RLUSD from the grants pool account, with the destination tag when there is one. You sign it in Xaman.
      const t = payTo(grant);
      const res = await fetch(`${API_URL}/api/admin/pay-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: t.address,
          ...(t.tag != null ? { destinationTag: t.tag } : {}),
          rlusd: String(parseFloat(amount)),
          account: GRANTS_POOL_ACCOUNT,
          instruction: `XRPLHub grant — ${grant.category} — ${amount} RLUSD from the grants pool`,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.uuid) { setIssueMsg(data.message || 'Could not create the payment. Mark it paid manually below instead.'); setLoading(''); return; }
      setIssueQr(data.qrPng); setIssueLink(data.deepLink); setIssueUuid(data.uuid);
    } catch (e) {
      setIssueMsg(e instanceof Error ? e.message : 'Network error.'); setLoading('');
    }
  };

  useEffect(() => {
    if (!issueUuid) return;
    const xw = watchXaman(issueUuid, () => { if (pollRef.current) clearTimeout(pollRef.current); poll(); });
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/admin/pay-link/status?uuid=${encodeURIComponent(issueUuid)}`);
        const data = await res.json();
        if (data.state === 'signed' && data.txid) {
          setIssueUuid(null); setIssueQr(null); setIssueLink(null);
          setLoading('pay');
          await act('pay', { amount: parseFloat(amount), txHash: data.txid });
          setLoading('');
          return;
        }
        if (data.state === 'rejected') { setIssueMsg('Declined in Xaman.'); setIssueUuid(null); setLoading(''); return; }
        if (data.state === 'expired') { setIssueMsg('Request expired. Tap Issue to try again.'); setIssueUuid(null); setLoading(''); return; }
      } catch { /* keep polling */ }
      pollRef.current = setTimeout(poll, xw.delay());
    };
    poll();
    return () => { xw.stop(); if (pollRef.current) clearTimeout(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueUuid]);

  if (['PAID','REJECTED','FAILED'].includes(grant.status)) {
    return (
      <div style={{ fontSize:11, color:'rgba(255,255,255,.3)', fontStyle:'italic' }}>
        {grant.status === 'PAID' ? `✅ Paid ${grant.paidAmount ?? grant.approvedAmount ?? grant.amountRequested} ${grant.currency} · TX: ${trunc(grant.txHash||'',10)}` : `Closed — ${grant.status}`}
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        <input type="number" value={amount} onChange={e=>setAmount(e.target.value)}
          style={{ ...INP, width:100, padding:'7px 10px', fontSize:12 }} placeholder="Amount" />
        <input type="text" value={note} onChange={e=>setNote(e.target.value)}
          style={{ ...INP, flex:1, minWidth:140, padding:'7px 10px', fontSize:12 }} placeholder="Note (optional)" />
      </div>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        {['PENDING','REVIEWING'].includes(grant.status) && (
          <>
            <button onClick={()=>act('approve',{approvedAmount:parseFloat(amount),note})} disabled={!!loading}
              style={{ padding:'8px 14px', borderRadius:8, border:'1px solid rgba(212,167,44,.4)', background:'rgba(212,167,44,.12)', color:'#d4a72c', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
              {loading==='approve' ? '…' : '✅ Approve'}
            </button>
            <button onClick={()=>act('reject',{note})} disabled={!!loading}
              style={{ padding:'8px 14px', borderRadius:8, border:'1px solid rgba(248,113,113,.4)', background:'rgba(248,113,113,.08)', color:'#f87171', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
              {loading==='reject' ? '…' : '✗ Deny'}
            </button>
          </>
        )}
        {grant.proposedAt && (
          <button onClick={()=>act('accept_payout',{})} disabled={!!loading}
            style={{ padding:'8px 14px', borderRadius:8, border:'1px solid rgba(212,167,44,.5)', background:'rgba(212,167,44,.12)', color:'#d4a72c', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
            Accept payout details: {trunc(grant.proposedPayoutAddress || '', 8)}{grant.proposedPayoutTag != null ? ` tag ${grant.proposedPayoutTag}` : ''}
          </button>
        )}
        {grant.status === 'APPROVED' && !issueUuid && (
          <button onClick={startIssue} disabled={!!loading}
            style={{ padding:'10px 16px', borderRadius:8, border:'none', background:'#d4a72c', color:'#000', fontSize:12, fontWeight:800, cursor:loading?'wait':'pointer', opacity:loading?0.6:1, fontFamily:'inherit', width:'100%' }}>
            {loading==='issue' ? '⚡ Creating…' : loading==='pay' ? '⚡ Recording…' : '📱 Pay with Xaman (RLUSD from the pool)'}
          </button>
        )}
      </div>
      {issueUuid && (
        <div style={{ background:'rgba(212,167,44,.06)', border:'1px solid rgba(212,167,44,.25)', borderRadius:12, padding:14 }}>
          <XamanPayPrompt theme="light" mode="pay" qrPng={issueQr} deepLink={issueLink} uuid={issueUuid}
            amount={parseFloat(amount)} currency="RLUSD" destination={payTo(grant).address} destinationTag={payTo(grant).tag} />
          <p style={{ fontSize:11, color:'rgba(255,255,255,.4)', marginTop:8, textAlign:'center' }}>Waiting for your signature — this finishes itself once signed.</p>
        </div>
      )}
      {issueMsg && <p style={{ fontSize:11, color:'#fca5a5' }}>{issueMsg}</p>}
      {grant.status === 'APPROVED' && !issueUuid && (
        <details style={{ marginTop:2 }}>
          <summary style={{ fontSize:11, color:'rgba(255,255,255,.35)', cursor:'pointer' }}>Already sent it another way? Enter the TX hash manually</summary>
          <div style={{ marginTop:8 }}>
            <input type="text" value={payTxHash} onChange={e=>setPayTxHash(e.target.value)}
              placeholder="TX hash from Xaman after you send the payout"
              style={{ ...INP, width:'100%', padding:'7px 10px', fontSize:11, fontFamily:"'IBM Plex Mono',monospace", marginBottom:6 }} />
            <button onClick={()=>act('pay',{amount:parseFloat(amount), txHash:payTxHash.trim()})} disabled={!!loading || !txHashValid}
              style={{ padding:'6px 14px', borderRadius:8, border:'none', background:'rgba(255,255,255,.1)', color:'#fff', fontSize:11, fontWeight:700, cursor:(!!loading||!txHashValid)?'not-allowed':'pointer', opacity:(!!loading||!txHashValid)?0.5:1, fontFamily:'inherit' }}>
              {loading==='pay' ? '⚡ Sending…' : '💸 Mark Paid'}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// XAMAN ADMIN SIGN-IN
// ═══════════════════════════════════════════════════════════════════════════════
type AuthPhase = 'idle' | 'loading' | 'picker' | 'xaman-wait' | 'ext-wait' | 'rejected' | 'expired' | 'not_admin' | 'error';

function AdminSignIn({ onAuthed }: { onAuthed: (wallet: string) => void }) {
  const [phase, setPhase] = useState<AuthPhase>('idle');
  const [msg, setMsg] = useState('');
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const startData = useRef<{ challenge:{id:string;hex:string}; uuid:string|null; qrPng:string|null; deepLink:string|null } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const applyStatus = useCallback((status: string, wallet?: string) => {
    if (status === 'ok' && wallet) { onAuthed(wallet); return; }
    if (status === 'not_admin') { setPhase('not_admin'); return; }
    if (status === 'rejected') { setPhase('rejected'); return; }
    if (status === 'expired') { setPhase('expired'); return; }
    if (status === 'pending') return;
    setPhase('error'); setMsg('Unexpected response. Try again.');
  }, [onAuthed]);

  const start = useCallback(async () => {
    setPhase('loading'); setMsg('');
    try {
      const res = await fetch(`${API_URL}/api/admin/auth/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.challenge) { setPhase('error'); setMsg(data.message ?? 'Could not start. Try again shortly.'); return; }
      startData.current = data;
      const xamanAvailable = !!data.xamanAvailable;
      const xamanProv = getProvider('xaman')!;
      setOptions([{ provider: xamanProv, available: xamanAvailable }]);
      setSelected(xamanAvailable ? 'xaman' : null);
      setPhase('picker');
      resolveProviderOptions({ xamanAvailable }).then((opts) => {
        setOptions(opts);
        setSelected((cur) => cur ?? opts.find(o=>o.available)?.provider.id ?? null);
      });
    } catch { setPhase('error'); setMsg('Could not reach the server.'); }
  }, []);

  useEffect(() => { start(); }, [start]);

  const pick = useCallback(async (id: string) => {
    const sd = startData.current;
    const provider = getProvider(id);
    if (!sd || !provider) return;
    const ctx: ProveContext = { challengeId: sd.challenge.id, challengeHex: sd.challenge.hex, xamanUuid: sd.uuid, xamanQrPng: sd.qrPng, xamanDeepLink: sd.deepLink };
    const handle = provider.proveControl(ctx);
    if (provider.id === 'xaman') { setQr(handle.qrPng); setLink(handle.deepLink); setPhase('xaman-wait'); return; }
    setPhase('ext-wait'); setMsg(`Approve the request in ${provider.label}…`);
    try {
      const body = await handle.body;
      const res = await fetch(`${API_URL}/api/admin/auth/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      applyStatus(data.status, data.wallet);
    } catch (e) {
      if (e instanceof WalletCancelled) setPhase('rejected');
      else { setPhase('error'); setMsg(e instanceof Error ? e.message : 'Signing failed.'); }
    }
  }, [applyStatus]);

  useEffect(() => {
    if (phase !== 'xaman-wait' || !startData.current?.uuid) return;
    const id = startData.current.uuid;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/api/admin/auth/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uuid: id }) });
        const data = await res.json();
        if (data.status !== 'pending') { live = false; applyStatus(data.status, data.wallet); return; }
      } catch { /* keep polling */ }
      if (live) timer = setTimeout(tick, xw.delay());
    };
    const xw = watchXaman(id, () => { if (timer) clearTimeout(timer); void tick(); });
    timer = setTimeout(tick, xw.delay());
    return () => { live = false; xw.stop(); if (timer) clearTimeout(timer); };
  }, [phase, applyStatus]);

  return (
    <div style={{ minHeight:'100vh', background:'#030310', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'Syne',sans-serif", color:'#eeeef5', padding:16 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;900&display=swap')`}</style>
      <div style={{ ...GLASS, padding:'36px 28px', width:'100%', maxWidth:380, textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>🛡️</div>
        <h2 style={{ fontSize:22, fontWeight:900, marginBottom:4 }}>XRPLHub Admin</h2>
        <p style={{ fontSize:12, color:'rgba(255,255,255,.38)', marginBottom:24 }}>Sign in with your wallet</p>

        {phase === 'loading' && <p style={{ fontSize:13, color:'rgba(255,255,255,.5)' }}>Starting…</p>}

        {phase === 'picker' && options.length > 0 && (
          <>
            <div style={{ marginBottom:16 }}><WalletPicker options={options} selected={selected ?? 'xaman'} onSelect={setSelected} /></div>
            <button onClick={() => selected && pick(selected)} disabled={!selected}
              style={{ width:'100%', padding:'14px', borderRadius:99, background:'#d4a72c', color:'#000', border:'none', fontWeight:800, fontSize:14, cursor:'pointer', fontFamily:'inherit' }}>
              Sign In →
            </button>
          </>
        )}

        {phase === 'xaman-wait' && (
          <div>
            <XamanPayPrompt theme="light" mode="signin" qrPng={qr} deepLink={link} uuid={startData.current?.uuid ?? undefined} />
            <p style={{ fontSize:12, color:'rgba(255,255,255,.4)', marginTop:10 }}>Scan or tap to sign in — no transaction, no funds move.</p>
          </div>
        )}

        {phase === 'ext-wait' && <p style={{ fontSize:13, color:'#d4a72c' }}>{msg}</p>}

        {phase === 'not_admin' && (
          <>
            <p style={{ fontSize:13, color:'#fbbf24', marginBottom:16 }}>That wallet isn&rsquo;t on the admin allowlist.</p>
            <button onClick={start} style={{ width:'100%', padding:'12px', borderRadius:99, background:'rgba(255,255,255,.1)', color:'#fff', border:'none', fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'inherit' }}>Try a different wallet →</button>
          </>
        )}
        {(phase === 'rejected' || phase === 'expired' || phase === 'error') && (
          <>
            <p style={{ fontSize:13, color:'#f87171', marginBottom:16 }}>{phase === 'rejected' ? 'Sign-in declined.' : phase === 'expired' ? 'Request expired.' : (msg || 'Something went wrong.')}</p>
            <button onClick={start} style={{ width:'100%', padding:'12px', borderRadius:99, background:'#d4a72c', color:'#000', border:'none', fontWeight:800, fontSize:14, cursor:'pointer', fontFamily:'inherit' }}>Try Again →</button>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ADMIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
// Xaman push diagnostic: Xaman's own record of sign requests (was it pushed? opened?), token state, and ONE test push.
// Every action shows its result in plain words right under its button (2026-10-11: the raw JSON at the bottom of the
// panel was off-screen on a phone and looked like "nothing happens").
type XRec = { uuid: string; error?: string; xamanError?: unknown; meta?: { signed?: boolean; cancelled?: boolean; expired?: boolean; pushed?: boolean; app_opened?: boolean }; signer?: string | null; issuedToken?: { present: boolean; state?: { active: boolean | null; expires?: string | null; note?: string } | null } };
type Line = { text: string; tone: 'wait' | 'ok' | 'bad' } | null;
async function adminJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25_000);
  try {
    const r = await fetch(url, { ...init, cache: 'no-store', signal: ctl.signal });
    const text = await r.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { body = { error: `The server answered HTTP ${r.status} with something that isn't JSON: ${text.slice(0, 120)}` }; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).name === 'AbortError' ? 'No answer from the server within 25 seconds.' : `Could not reach the server: ${String(e)}` } };
  } finally { clearTimeout(timer); }
}
const errText = (r: { status: number; body: Record<string, unknown> }) => `${r.status === 401 ? 'Your admin sign-in expired (1 hour). Reload /admin and sign in again.' : String(r.body.message ?? r.body.error ?? 'Unknown error')}${r.status ? ` (HTTP ${r.status})` : ''}`;
function signinVerdict(x: XRec | undefined): { line: Line; done: boolean } {
  if (!x) return { line: { text: 'Xaman returned nothing for this request.', tone: 'bad' }, done: true };
  if (x.error || x.xamanError) return { line: { text: `Xaman error: ${x.error ?? JSON.stringify(x.xamanError)}`, tone: 'bad' }, done: true };
  const m = x.meta ?? {};
  if (m.signed) {
    const tk = x.issuedToken;
    if (!tk?.present) return { line: { text: `Signed by ${x.signer ?? '?'}, but Xaman issued NO push token. Send Xaman the message from the report.`, tone: 'bad' }, done: true };
    if (tk.state?.active === true) return { line: { text: `✓ Signed by ${x.signer ?? '?'}. Xaman issued a push token and says it is ACTIVE${tk.state.expires ? ` (until ${new Date(tk.state.expires).toLocaleString()})` : ''}. Now do step 2.`, tone: 'ok' }, done: true };
    return { line: { text: `Signed. Xaman issued a token but says it is NOT active (${tk.state?.note ?? 'active = false'}).`, tone: 'bad' }, done: true };
  }
  if (m.cancelled) return { line: { text: 'You declined this sign-in. Press "New sign-in request" and approve it instead.', tone: 'bad' }, done: true };
  if (m.expired) return { line: { text: 'This sign-in expired (10 minutes). Press "New sign-in request" again.', tone: 'bad' }, done: true };
  return { line: { text: `Waiting for your signature… (checked ${new Date().toLocaleTimeString()}${m.app_opened ? ', opened in Xaman' : ', not opened in Xaman yet'})`, tone: 'wait' }, done: false };
}
function pushVerdict(x: XRec | undefined): { line: Line; done: boolean } {
  const m = x?.meta ?? {};
  if (!x || x.error || x.xamanError) return { line: { text: `Xaman error: ${x?.error ?? JSON.stringify(x?.xamanError)}`, tone: 'bad' }, done: true };
  if (m.cancelled) return { line: { text: '✓ It reached your Xaman and you declined it. Reminders work.', tone: 'ok' }, done: true };
  if (m.signed) return { line: { text: '✓ It reached your Xaman (you approved the sign-in; nothing was sent). Reminders work.', tone: 'ok' }, done: true };
  if (m.expired) return { line: { text: `It expired without being opened${m.pushed ? ' (Xaman says it was pushed)' : ' and Xaman says it was NOT pushed'}.`, tone: 'bad' }, done: true };
  return { line: { text: `Xaman says pushed = ${m.pushed === true ? 'true' : 'false'}. ${m.app_opened ? 'Opened in Xaman.' : 'Not opened yet: look in Xaman Events.'} (checked ${new Date().toLocaleTimeString()})`, tone: m.pushed ? 'wait' : 'bad' }, done: false };
}
function StatusLine({ line }: { line: Line }) {
  if (!line) return null;
  const c = line.tone === 'ok' ? '#d4a72c' : line.tone === 'bad' ? '#f87171' : '#fbbf24';
  return <div role="status" aria-live="polite" style={{ margin:'10px 0', padding:'10px 12px', borderRadius:8, border:`1px solid ${c}`, color:c, fontSize:13, lineHeight:1.5 }}>{line.text}</div>;
}
function XamanPushPanel() {
  const [uuids, setUuids] = useState('a55209bf-1d20-458d-9227-4d018059a6dc,5227b6e5-0320-4fab-ab5c-a28ca47e246f');
  const [planId, setPlanId] = useState('cmv1b95kl0000k006c36ihr5a');
  const [tokenFrom, setTokenFrom] = useState('');
  const [out, setOut] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [signin, setSignin] = useState<{ uuid: string; qr_png: string | null; deep_link: string | null } | null>(null);
  const [busy, setBusy] = useState('');
  const [s1, setS1] = useState<Line>(null);
  const [s2, setS2] = useState<Line>(null);
  const [s3, setS3] = useState<Line>(null);
  const [tokenOk, setTokenOk] = useState(false);
  const poll = useRef<{ kind: 'signin' | 'push'; uuid: string; until: number } | null>(null);
  const inp: React.CSSProperties = { width:'100%', padding:'8px 10px', borderRadius:8, border:'1px solid rgba(255,255,255,.15)', background:'rgba(255,255,255,.04)', color:'#fff', fontFamily:'monospace', fontSize:12, marginBottom:8 };
  const btn: React.CSSProperties = { padding:'10px 14px', borderRadius:8, border:'1px solid #d4a72c', background:'rgba(212,167,44,.15)', color:'#d4a72c', fontWeight:700, cursor:'pointer', marginRight:8, marginBottom:6 };
  const label: React.CSSProperties = { fontSize:12, color:'rgba(255,255,255,.6)', margin:'4px 0 6px', lineHeight:1.5 };

  const look = useCallback(async (uuid: string) => adminJson(`${API_URL}/api/admin/xaman-push?uuids=${encodeURIComponent(uuid)}&planId=${encodeURIComponent(planId)}`), [planId]);
  const checkSignin = useCallback(async (uuid: string, quiet = false) => {
    if (!quiet) setS1({ text: 'Checking with Xaman…', tone: 'wait' });
    const r = await look(uuid);
    setOut(JSON.stringify(r.body, null, 2));
    if (!r.ok) { setS1({ text: errText(r), tone: 'bad' }); return true; }
    const v = signinVerdict((r.body.requests as XRec[] | undefined)?.[0]);
    setS1(v.line);
    if (v.done && v.line?.tone === 'ok') { setTokenOk(true); setTokenFrom(uuid); }
    return v.done;
  }, [look]);
  const checkPush = useCallback(async (uuid: string, quiet = false) => {
    if (!quiet) setS2({ text: 'Checking with Xaman…', tone: 'wait' });
    const r = await look(uuid);
    setOut(JSON.stringify(r.body, null, 2));
    if (!r.ok) { setS2({ text: errText(r), tone: 'bad' }); return true; }
    const v = pushVerdict((r.body.requests as XRec[] | undefined)?.[0]);
    setS2(v.line);
    return v.done;
  }, [look]);

  // Poll Xaman every 4 s while a sign-in or a test push is outstanding (max 10 minutes), so no button needs pressing.
  useEffect(() => {
    const id = setInterval(async () => {
      const p = poll.current;
      if (!p) return;
      if (Date.now() > p.until) { poll.current = null; return; }
      const done = p.kind === 'signin' ? await checkSignin(p.uuid, true) : await checkPush(p.uuid, true);
      if (done && poll.current?.uuid === p.uuid) poll.current = null;
    }, 4000);
    return () => clearInterval(id);
  }, [checkSignin, checkPush]);

  const freshToken = async () => {
    setBusy('signin'); setTokenOk(false); setS2(null); setSignin(null);
    setS1({ text: 'Creating a sign-in request…', tone: 'wait' });
    const r = await adminJson(`${API_URL}/api/admin/xaman-push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'signin' }) });
    setOut(JSON.stringify(r.body, null, 2));
    if (!r.ok || !r.body.uuid) setS1({ text: errText(r), tone: 'bad' });
    else {
      const sx = r.body as unknown as { uuid: string; qr_png: string | null; deep_link: string | null };
      setSignin(sx);
      setS1({ text: 'Waiting for your signature. On this phone: tap "Open in Xaman" below. On a computer: scan the QR with Xaman. This page checks every 4 seconds.', tone: 'wait' });
      poll.current = { kind: 'signin', uuid: sx.uuid, until: Date.now() + 10 * 60_000 };
    }
    setBusy('');
  };
  const push = async () => {
    if (!window.confirm('Send ONE test request to your Xaman app now? Nothing is signed or sent; tap Decline.')) return;
    setBusy('push'); setS2({ text: 'Sending one test push…', tone: 'wait' });
    const r = await adminJson(`${API_URL}/api/admin/xaman-push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenFrom }) });
    setOut(JSON.stringify(r.body, null, 2));
    if (!r.ok || !r.body.uuid) setS2({ text: errText(r), tone: 'bad' });
    else {
      setSent(String(r.body.uuid));
      setS2(r.body.pushed === true
        ? { text: 'Xaman says pushed = true. Watch your phone, then tap Decline. This page checks every 4 seconds.', tone: 'wait' }
        : { text: 'Xaman says pushed = FALSE: it did not send the notification.', tone: 'bad' });
      poll.current = { kind: 'push', uuid: String(r.body.uuid), until: Date.now() + 10 * 60_000 };
    }
    setBusy('');
  };
  const inspect = async () => {
    setBusy('inspect'); setS3({ text: 'Checking with Xaman…', tone: 'wait' });
    const r = await adminJson(`${API_URL}/api/admin/xaman-push?uuids=${encodeURIComponent(uuids)}&planId=${encodeURIComponent(planId)}`);
    setOut(JSON.stringify(r.body, null, 2));
    setS3(r.ok ? { text: `Done. Xaman's records are in "Details" below (checked ${new Date().toLocaleTimeString()}).`, tone: 'ok' } : { text: errText(r), tone: 'bad' });
    setBusy('');
  };

  return (
    <div style={{ ...GLASS, padding:'18px 20px' }}>
      <div style={{ fontSize:15, fontWeight:700, marginBottom:10 }}>Xaman push check</div>

      <div style={{ fontSize:13, fontWeight:700 }}>Step 1: get a fresh push token</div>
      <div style={label}>Sign a sign-in request (nothing is sent). This page then asks Xaman whether it issued a push token.</div>
      <button style={btn} disabled={!!busy} onClick={() => void freshToken()}>{busy === 'signin' ? 'Creating…' : 'New sign-in request'}</button>
      {signin && <button style={btn} disabled={!!busy} onClick={() => void checkSignin(signin.uuid)}>Check the sign-in now</button>}
      <StatusLine line={s1} />
      {signin?.deep_link && !tokenOk && <a href={signin.deep_link} target="_blank" rel="noreferrer" style={{ ...btn, display:'block', textAlign:'center', textDecoration:'none', background:'#d4a72c', color:'#000', margin:'6px 0 10px' }}>Open in Xaman</a>}
      {signin?.qr_png && !tokenOk && <div style={{ margin:'6px 0 12px' }}><img src={signin.qr_png} alt="Sign-in QR for Xaman" width={180} height={180} style={{ background:'#fff', borderRadius:8 }} /></div>}

      <div style={{ fontSize:13, fontWeight:700, marginTop:14 }}>Step 2: one test push</div>
      <div style={label}>{tokenOk ? 'Uses the token Xaman just issued. Your phone should show the request; tap Decline.' : 'Available after step 1 shows ✓.'}</div>
      <button style={{ ...btn, opacity: tokenOk ? 1 : 0.4 }} disabled={!!busy || !tokenOk} onClick={() => void push()}>{busy === 'push' ? 'Sending…' : 'Send ONE test push…'}</button>
      {sent && <button style={btn} disabled={!!busy} onClick={() => void checkPush(sent)}>Check the test push now</button>}
      <StatusLine line={s2} />

      <details style={{ marginTop:16 }}>
        <summary style={{ fontSize:13, fontWeight:700, cursor:'pointer' }}>Inspect earlier requests</summary>
        <div style={label}>Xaman request uuids (comma-separated)</div>
        <input style={inp} value={uuids} onChange={(e) => setUuids(e.target.value)} />
        <div style={label}>Spend plan id (its stored push token is checked, never shown)</div>
        <input style={inp} value={planId} onChange={(e) => setPlanId(e.target.value)} />
        <button style={btn} disabled={!!busy} onClick={() => void inspect()}>Check with Xaman</button>
        <StatusLine line={s3} />
      </details>
      {out && <details style={{ marginTop:10 }}><summary style={{ fontSize:12, cursor:'pointer', color:'rgba(255,255,255,.6)' }}>Details (Xaman&apos;s raw answer)</summary><pre style={{ marginTop:8, fontSize:11, whiteSpace:'pre-wrap', wordBreak:'break-all', color:'rgba(255,255,255,.75)' }}>{out}</pre></details>}
    </div>
  );
}

export default function AdminPage() {
  const [authed, setAuthed]       = useState(false);
  const [wallet, setWallet]       = useState('');
  const [data, setData]           = useState<AdminData|null>(null);
  const [loading, setLoading]     = useState(false);
  const [tab, setTab]             = useState<'overview'|'grants'|'payments'|'credentials'|'watchdog'|'scores'|'donations'|'xaman'>('overview');
  const [copiedAddr, setCopiedAddr] = useState('');
  const [grantFilter, setGF]      = useState('ALL');
  const [lastRefresh, setLastRefresh] = useState('');

  const logout = useCallback(async () => {
    try { await fetch(`${API_URL}/api/admin/auth/logout`, { method: 'POST' }); } catch {}
    setAuthed(false); setWallet(''); setData(null);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/admin`, { cache: 'no-store' });
      if (res.status === 401) { logout(); return; }
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [logout]);

  const onAuthed = useCallback((w: string) => { setWallet(w); setAuthed(true); fetchData(); }, [fetchData]);

  // ── Login screen ──
  if (!authed) return <AdminSignIn onAuthed={onAuthed} />;

  const grants   = data?.grants.recent || [];
  const filtered = grantFilter === 'ALL' ? grants : grants.filter(g => g.status === grantFilter);
  const watchdogOpen = data?.watchdog.open || [];

  return (
    <div style={{ minHeight:'100vh', background:'#030310', fontFamily:"'Syne',sans-serif", color:'#eeeef5', paddingBottom:60 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;900&family=IBM+Plex+Mono:wght@400;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:99px}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
        table{border-collapse:collapse;width:100%}
        th{text-align:left;font-size:10px;font-weight:700;color:rgba(255,255,255,.32);text-transform:uppercase;letter-spacing:.08em;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
        td{padding:11px 12px;font-size:12px;color:rgba(255,255,255,.7);border-bottom:1px solid rgba(255,255,255,.04);vertical-align:top}
        tr:hover td{background:rgba(255,255,255,.02)}
        .tbl-wrap{overflow-x:auto}
      `}</style>

      {/* ── HEADER (wraps on phone widths) ── */}
      <div style={{ background:'rgba(6,6,22,.9)', backdropFilter:'blur(20px)', borderBottom:'1px solid rgba(212,167,44,.18)', padding:'10px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10, position:'sticky', top:0, zIndex:50 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <BrandLogo />
          <span style={{ fontSize:10, fontWeight:700, color:'#d4a72c', background:'rgba(212,167,44,.12)', border:'1px solid rgba(212,167,44,.25)', borderRadius:99, padding:'2px 8px', fontFamily:"'IBM Plex Mono',monospace" }}>ADMIN</span>
          <span style={{ fontSize:10, color:'rgba(255,255,255,.3)', fontFamily:"'IBM Plex Mono',monospace" }}>{trunc(wallet,8)}</span>
          {loading && <span style={{ fontSize:11, color:'#d4a72c', animation:'pulse 1s infinite' }}>⟳</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {lastRefresh && <span style={{ fontSize:10, color:'rgba(255,255,255,.28)', fontFamily:"'IBM Plex Mono',monospace" }}>{lastRefresh}</span>}
          <button onClick={fetchData} style={{ padding:'8px 14px', borderRadius:99, background:'rgba(212,167,44,.12)', border:'1px solid rgba(212,167,44,.28)', color:'#d4a72c', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>↻</button>
          <button onClick={logout} style={{ padding:'8px 14px', borderRadius:99, background:'rgba(255,255,255,.06)', border:'1px solid rgba(255,255,255,.12)', color:'rgba(255,255,255,.5)', fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>Out</button>
        </div>
      </div>

      <div style={{ maxWidth:1280, margin:'0 auto', padding:'20px 16px' }}>

        {/* ── WATCHDOG BANNER (only shows when something is actually open) ── */}
        {watchdogOpen.length > 0 && (
          <div style={{ ...GLASS, padding:'12px 16px', marginBottom:18, borderLeft:'3px solid #ef4444', background:'rgba(239,68,68,.06)' }}>
            <div style={{ fontSize:11, fontWeight:800, color:'#f87171', marginBottom:6, textTransform:'uppercase', letterSpacing:'.06em' }}>⚠️ Watchdog: {watchdogOpen.length} open</div>
            {watchdogOpen.map(w => (
              <div key={w.key} style={{ fontSize:12, color:'rgba(255,255,255,.6)', marginBottom:2 }}>
                <code style={{ color:'#fca5a5' }}>{w.key}</code>{w.alertingSince ? ` — since ${fmt(w.alertingSince)}` : ''}
              </div>
            ))}
          </div>
        )}

        {/* ── STAT CARDS ── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:12, marginBottom:24 }}>
          {[
            { label:'Treasury XRP', value:data ? `${data.treasury.balanceXRP} XRP` : '—', sub: data ? `$${data.treasury.balanceUSD}` : '', color:'#d4a72c' },
            { label:'Pending Grants', value:data ? String(data.grants.pending) : '—', sub:`${data?.grants.total||0} total`, color:'#fbbf24' },
            { label:'Credentials Queued', value:data ? String(data.credentials.byRequestStatus.queued||0) : '—', sub:'awaiting issuance', color:'#a78bfa' },
            { label:'Watchdog', value: watchdogOpen.length ? `${watchdogOpen.length} open` : 'clean', sub: data?.watchdog.lastPassAt ? `last pass ${fmt(data.watchdog.lastPassAt)}` : 'no pass yet', color: watchdogOpen.length ? '#ef4444' : '#d4a72c' },
          ].map(s=>(
            <div key={s.label} style={{ ...CARD(s.color) }}>
              <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,.38)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>{s.label}</div>
              <div style={{ fontSize:20, fontWeight:900, color:s.color, lineHeight:1, marginBottom:4 }}>{s.value}</div>
              <div style={{ fontSize:10, color:'rgba(255,255,255,.32)' }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* ── TAB NAV (wraps) ── */}
        <div style={{ display:'flex', gap:6, marginBottom:18, borderBottom:'1px solid rgba(255,255,255,.07)', paddingBottom:12, flexWrap:'wrap' }}>
          {(['overview','grants','payments','credentials','watchdog','scores','donations','xaman'] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{ padding:'8px 14px', borderRadius:99, border:`1px solid ${tab===t?'#d4a72c':'rgba(255,255,255,.1)'}`, background:tab===t?'rgba(212,167,44,.15)':'transparent', color:tab===t?'#d4a72c':'rgba(255,255,255,.45)', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'inherit', textTransform:'capitalize' }}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'xaman' && <XamanPushPanel />}

        {/* ── OVERVIEW ── */}
        {tab === 'overview' && data && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))', gap:16 }}>
            <div style={{ ...GLASS, padding:'18px 20px' }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>🏦 Treasury</div>
              <div style={{ fontSize:20, fontWeight:900, color:'#d4a72c', marginBottom:4 }}>{data.treasury.balanceXRP} XRP</div>
              <div style={{ fontSize:12, color:'rgba(255,255,255,.4)', marginBottom:10 }}>${data.treasury.balanceUSD} · ${data.treasury.xrpPrice}/XRP</div>
              <a href={`https://xrpscan.com/account/${data.treasury.address}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:'#d4a72c' }}>{trunc(data.treasury.address,12)} ↗</a>
            </div>
            <div style={{ ...GLASS, padding:'18px 20px' }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>💳 Payments</div>
              {Object.entries(data.payments.byStatus).map(([s,n]) => (
                <div key={s} style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}><span style={{ color:'rgba(255,255,255,.5)' }}>{s}</span><span style={{ fontWeight:700 }}>{n}</span></div>
              ))}
              {Object.keys(data.payments.byStatus).length === 0 && <div style={{ fontSize:12, color:'rgba(255,255,255,.3)' }}>None yet</div>}
            </div>
            <div style={{ ...GLASS, padding:'18px 20px' }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>🪪 Credentials</div>
              {Object.entries(data.credentials.byRequestStatus).map(([s,n]) => (
                <div key={s} style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}><span style={{ color:'rgba(255,255,255,.5)' }}>{s}</span><span style={{ fontWeight:700 }}>{n}</span></div>
              ))}
            </div>
          </div>
        )}

        {/* ── GRANTS ── */}
        {tab === 'grants' && (
          <div>
            <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }}>
              {['ALL','PENDING','REVIEWING','APPROVED','REJECTED','PAID'].map(f=>(
                <button key={f} onClick={()=>setGF(f)} style={{ padding:'7px 14px', borderRadius:99, border:`1px solid ${grantFilter===f?'#d4a72c':'rgba(255,255,255,.1)'}`, background:grantFilter===f?'rgba(212,167,44,.15)':'transparent', color:grantFilter===f?'#d4a72c':'rgba(255,255,255,.45)', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
                  {f} {f!=='ALL'&&data?`(${data.grants.byStatus[f]||0})`:''}
                </button>
              ))}
            </div>
            {filtered.length === 0
              ? <div style={{ ...GLASS, padding:40, textAlign:'center', fontSize:13, color:'rgba(255,255,255,.3)' }}>No grant applications</div>
              : filtered.map(g=>(
                <div key={g.id} style={{ ...GLASS, padding:'18px 20px', marginBottom:12 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10, marginBottom:12 }}>
                    <div style={{ flex:1, minWidth:200 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6, flexWrap:'wrap' }}>
                        <StatusBadge s={g.status} />
                        <UrgencyBadge u={g.urgency} />
                        <span style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,.55)', background:'rgba(255,255,255,.06)', padding:'2px 7px', borderRadius:6 }}>{g.category}</span>
                      </div>
                      <p style={{ fontSize:13, color:'rgba(255,255,255,.7)', lineHeight:1.6, marginBottom:8 }}>{g.description}</p>
                      <button onClick={()=>{ navigator.clipboard.writeText(g.walletAddress).then(()=>{ setCopiedAddr(g.id); setTimeout(()=>setCopiedAddr(''),2000); }).catch(()=>{}); }}
                        style={{ fontSize:11, color: copiedAddr===g.id ? '#d4a72c' : 'rgba(255,255,255,.55)', fontFamily:"'IBM Plex Mono',monospace", background:'rgba(255,255,255,.06)', border:'1px solid rgba(255,255,255,.12)', borderRadius:6, padding:'3px 8px', cursor:'pointer' }}>
                        👛 {copiedAddr===g.id ? 'Copied ✓' : trunc(g.walletAddress, 10)}
                      </button>
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0 }}>
                      <div style={{ fontSize:20, fontWeight:900, color:'#d4a72c' }}>${g.approvedAmount ?? g.amountRequested} <span style={{ fontSize:11 }}>RLUSD</span></div>
                      <div style={{ fontSize:11, color:'rgba(255,255,255,.5)', fontFamily:"'IBM Plex Mono',monospace" }}>pay to {trunc(payTo(g).address, 8)}{payTo(g).tag != null ? ` · tag ${payTo(g).tag}` : ''}</div>
                      {g.round === 'paid-first' && <div style={{ fontSize:11, color:'#d4a72c' }}>approved, paid first</div>}
                    </div>
                  </div>
                  <GrantActions grant={g} onUpdate={fetchData} />
                </div>
              ))
            }
          </div>
        )}

        {/* ── PAYMENTS ── */}
        {tab === 'payments' && (
          <div className="tbl-wrap" style={{ ...GLASS, padding:0, overflow:'hidden' }}>
            <table>
              <thead><tr><th>Product</th><th>Amount</th><th>Wallet</th><th>Status</th><th>Time</th></tr></thead>
              <tbody>
                {(data?.payments.recent||[]).length === 0
                  ? <tr><td colSpan={5} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:40 }}>No payments yet</td></tr>
                  : (data?.payments.recent||[]).map(p => (
                    <tr key={p.id}>
                      <td>{p.productId}</td>
                      <td>{p.amount} {p.currency}</td>
                      <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{p.wallet ? trunc(p.wallet,10) : '—'}</code></td>
                      <td>{p.status}</td>
                      <td style={{ fontSize:11, color:'rgba(255,255,255,.4)' }}>{fmt(p.verifiedAt)}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        )}

        {/* ── CREDENTIALS ── */}
        {tab === 'credentials' && (
          <div>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>Queued ({data?.credentials.queued.length||0})</div>
            <div className="tbl-wrap" style={{ ...GLASS, padding:0, overflow:'hidden', marginBottom:20 }}>
              <table>
                <thead><tr><th>Kind</th><th>Subject</th><th>Tier / Ref</th><th>Requested</th></tr></thead>
                <tbody>
                  {(data?.credentials.queued||[]).length === 0
                    ? <tr><td colSpan={4} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:24 }}>Nothing queued</td></tr>
                    : (data?.credentials.queued||[]).map(q => (
                      <tr key={q.id}>
                        <td>{q.kind}</td>
                        <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{trunc(q.subject,10)}</code></td>
                        <td style={{ fontSize:11 }}>{q.subjectRef || q.tier}</td>
                        <td style={{ fontSize:11, color:'rgba(255,255,255,.4)' }}>{fmt(q.requestedAt)}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>Recent on-ledger activity</div>
            <div className="tbl-wrap" style={{ ...GLASS, padding:0, overflow:'hidden' }}>
              <table>
                <thead><tr><th>Subject</th><th>Type</th><th>Accepted</th><th>Last seen</th></tr></thead>
                <tbody>
                  {(data?.credentials.recentOnLedger||[]).length === 0
                    ? <tr><td colSpan={4} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:24 }}>None yet</td></tr>
                    : (data?.credentials.recentOnLedger||[]).map(c => (
                      <tr key={c.objectIndex}>
                        <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{trunc(c.subject,10)}</code></td>
                        <td style={{ fontSize:11 }}>{c.credentialType}</td>
                        <td>{c.accepted ? '✅' : '⏳'}</td>
                        <td style={{ fontSize:11, color:'rgba(255,255,255,.4)' }}>{fmt(c.lastSeenAt)}</td>
                      </tr>
                    ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── WATCHDOG ── */}
        {tab === 'watchdog' && (
          <div style={{ ...GLASS, padding:'20px' }}>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>Last pass: {data?.watchdog.lastPassAt ? fmt(data.watchdog.lastPassAt) : 'never'}</div>
            <p style={{ fontSize:11, color:'rgba(255,255,255,.35)', marginBottom:16 }}>Runs on the daily crons. This reflects the last real pass, not a live re-check.</p>
            {watchdogOpen.length === 0
              ? <div style={{ color:'#d4a72c', fontSize:14, fontWeight:700 }}>✅ Nothing open</div>
              : watchdogOpen.map(w => (
                <div key={w.key} style={{ padding:'10px 0', borderBottom:'1px solid rgba(255,255,255,.06)' }}>
                  <code style={{ color:'#fca5a5', fontSize:13 }}>{w.key}</code>
                  {w.alertingSince && <span style={{ fontSize:11, color:'rgba(255,255,255,.4)', marginLeft:10 }}>since {fmt(w.alertingSince)}</span>}
                </div>
              ))
            }
          </div>
        )}

        {/* ── SCORES ── */}
        {tab === 'scores' && (
          <div className="tbl-wrap" style={{ ...GLASS, padding:0, overflow:'hidden' }}>
            <table>
              <thead><tr><th>Wallet</th><th>Score</th><th>Grade</th><th>Time</th></tr></thead>
              <tbody>
                {(data?.scores.recent||[]).length === 0
                  ? <tr><td colSpan={4} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:40 }}>No score checks yet</td></tr>
                  : (data?.scores.recent||[]).map((s,i)=>(
                    <tr key={i}>
                      <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#e3bf55' }}>{trunc(s.address,12)}</code></td>
                      <td><span style={{ fontSize:15, fontWeight:900, color:s.score>=740?'#d4a72c':s.score>=580?'#fbbf24':'#ef4444' }}>{s.score}</span></td>
                      <td style={{ fontSize:11 }}>{s.tier}</td>
                      <td style={{ color:'rgba(255,255,255,.4)', fontSize:11 }}>{fmt(s.checkedAt)}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        )}

        {/* ── DONATIONS ── */}
        {tab === 'donations' && (
          <div className="tbl-wrap" style={{ ...GLASS, padding:0, overflow:'hidden' }}>
            <table>
              <thead><tr><th>From</th><th>Amount</th><th>Time</th><th>TX</th></tr></thead>
              <tbody>
                {(data?.donations.recent||[]).length === 0
                  ? <tr><td colSpan={4} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:40 }}>No donations yet</td></tr>
                  : (data?.donations.recent||[]).map((d,i)=>(
                    <tr key={i}>
                      <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#e3bf55' }}>{trunc(d.fromAddress,12)}</code></td>
                      <td>{d.amount} {d.currency}</td>
                      <td style={{ color:'rgba(255,255,255,.4)', fontSize:11 }}>{fmt(d.createdAt)}</td>
                      <td><a href={`https://xrpscan.com/tx/${d.txHash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:'#d4a72c', fontFamily:"'IBM Plex Mono',monospace" }}>{trunc(d.txHash,10)} ↗</a></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
}
