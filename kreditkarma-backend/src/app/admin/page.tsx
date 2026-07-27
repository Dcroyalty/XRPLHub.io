'use client';
import React, { useState, useEffect, useCallback } from 'react';

const API_URL   = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) || '';
const ADMIN_PWD = 'xrplhub2026';  // change this to your preferred password

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Grant {
  id: string; walletAddress: string; category: string;
  amountRequested: number; currency: string; description: string;
  urgency: string; status: string; aiScore?: number; aiReasoning?: string;
  approvedAmount?: number; txHash?: string; paidAt?: string;
  createdAt: string; scoreSnapshot?: number;
}
interface ScoreCheck {
  address: string; score: number; tier: string; checkedAt: string;
}
interface Donation {
  id: string; fromAddress: string; amount: number;
  currency: string; txHash: string; createdAt: string;
}
interface AdminData {
  treasury: { address: string; balanceXRP: number; balanceUSD: number; xrpPrice: number };
  grants:   { total: number; byStatus: Record<string,number>; pending: number; recent: Grant[] };
  scores:   { totalChecks: number; recent: ScoreCheck[] };
  donations:{ count: number; totalXRP: number; recent: Donation[] };
  updatedAt: string;
}

// ─── STYLE HELPERS ────────────────────────────────────────────────────────────
const GLASS: React.CSSProperties = { background:'rgba(6,6,22,.82)', backdropFilter:'blur(20px)', WebkitBackdropFilter:'blur(20px)', border:'1px solid rgba(255,255,255,.09)', borderRadius:16 };
const CARD = (accent = '#10b981'): React.CSSProperties => ({ ...GLASS, padding:20, borderLeft:`3px solid ${accent}` });
const INP: React.CSSProperties = { width:'100%', background:'rgba(255,255,255,.07)', border:'1px solid rgba(255,255,255,.15)', borderRadius:10, padding:'11px 14px', fontSize:14, color:'#fff', outline:'none', fontFamily:'inherit', boxSizing:'border-box' };

function StatusBadge({ s }: { s: string }) {
  const map: Record<string,[string,string]> = {
    PENDING:   ['#fbbf24','rgba(251,191,36,.15)'],
    REVIEWING: ['#60a5fa','rgba(96,165,250,.15)'],
    APPROVED:  ['#10b981','rgba(16,185,129,.15)'],
    REJECTED:  ['#f87171','rgba(248,113,113,.15)'],
    PAID:      ['#34d399','rgba(52,211,153,.15)'],
    FAILED:    ['#f97316','rgba(249,115,22,.15)'],
  };
  const [color, bg] = map[s] || ['#9ca3af','rgba(156,163,175,.1)'];
  return <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:99, background:bg, color, letterSpacing:'.06em', border:`1px solid ${color}40` }}>{s}</span>;
}

function UrgencyBadge({ u }: { u: string }) {
  const map: Record<string,string> = { EMERGENCY:'#ef4444', HIGH:'#f97316', MEDIUM:'#fbbf24', LOW:'#10b981' };
  const c = map[u] || '#9ca3af';
  return <span style={{ fontSize:9, fontWeight:800, padding:'2px 7px', borderRadius:99, background:`${c}18`, color:c, border:`1px solid ${c}30` }}>{u}</span>;
}

function trunc(a: string, n = 8) { return a ? `${a.slice(0,n)}…${a.slice(-4)}` : '—'; }
function fmt(d: string) { return new Date(d).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }

// ─── GRANT ACTIONS PANEL ──────────────────────────────────────────────────────
function GrantActions({ grant, onUpdate }: { grant: Grant; onUpdate: () => void }) {
  const [loading, setLoading] = useState('');
  const [note, setNote]       = useState('');
  const [amount, setAmount]   = useState(String(grant.amountRequested));

  const act = async (action: string, body: object) => {
    setLoading(action);
    try {
      await fetch(`${API_URL}/api/grants/${grant.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      onUpdate();
    } catch { /* silent */ }
    finally { setLoading(''); }
  };

  if (['PAID','REJECTED','FAILED'].includes(grant.status)) {
    return (
      <div style={{ fontSize:11, color:'rgba(255,255,255,.3)', fontStyle:'italic' }}>
        {grant.status === 'PAID' ? `✅ Paid ${grant.paidAmount} RLUSD · TX: ${trunc(grant.txHash||'',10)}` : `Closed — ${grant.status}`}
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      <div style={{ display:'flex', gap:8 }}>
        <input type="number" value={amount} onChange={e=>setAmount(e.target.value)}
          style={{ ...INP, width:100, padding:'7px 10px', fontSize:12 }} placeholder="Amount" />
        <input type="text" value={note} onChange={e=>setNote(e.target.value)}
          style={{ ...INP, flex:1, padding:'7px 10px', fontSize:12 }} placeholder="Note (optional)" />
      </div>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        {grant.status === 'PENDING' && (
          <button onClick={()=>act('review',{})} disabled={!!loading}
            style={{ padding:'6px 12px', borderRadius:8, border:'1px solid rgba(96,165,250,.4)', background:'rgba(96,165,250,.12)', color:'#60a5fa', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
            {loading==='review' ? '…' : '🔍 Review'}
          </button>
        )}
        {['PENDING','REVIEWING'].includes(grant.status) && (
          <>
            <button onClick={()=>act('approve',{approvedAmount:parseFloat(amount),note})} disabled={!!loading}
              style={{ padding:'6px 12px', borderRadius:8, border:'1px solid rgba(16,185,129,.4)', background:'rgba(16,185,129,.12)', color:'#10b981', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
              {loading==='approve' ? '…' : '✅ Approve'}
            </button>
            <button onClick={()=>act('reject',{note})} disabled={!!loading}
              style={{ padding:'6px 12px', borderRadius:8, border:'1px solid rgba(248,113,113,.4)', background:'rgba(248,113,113,.08)', color:'#f87171', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
              {loading==='reject' ? '…' : '✗ Reject'}
            </button>
          </>
        )}
        {grant.status === 'APPROVED' && (
          <button onClick={()=>act('pay',{amount:parseFloat(amount)})} disabled={!!loading}
            style={{ padding:'6px 14px', borderRadius:8, border:'none', background:'#10b981', color:'#000', fontSize:11, fontWeight:800, cursor:'pointer', fontFamily:'inherit' }}>
            {loading==='pay' ? '⚡ Sending…' : '💸 Pay Now'}
          </button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ADMIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
export default function AdminPage() {
  const [authed, setAuthed]       = useState(false);
  const [pwd, setPwd]             = useState('');
  const [pwdErr, setPwdErr]       = useState(false);
  const [data, setData]           = useState<AdminData|null>(null);
  const [loading, setLoading]     = useState(false);
  const [tab, setTab]             = useState<'overview'|'grants'|'scores'|'donations'>('overview');
  const [grantFilter, setGF]      = useState('ALL');
  const [lastRefresh, setLastRefresh] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/admin`, { cache: 'no-store' });
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchData();
    const iv = setInterval(fetchData, 60_000);
    return () => clearInterval(iv);
  }, [authed, fetchData]);

  // ── Login screen ──
  if (!authed) return (
    <div style={{ minHeight:'100vh', background:'#030310', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'Syne',sans-serif", color:'#eeeef5' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;900&display=swap')`}</style>
      <div style={{ ...GLASS, padding:'40px 36px', width:360, textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>🛡️</div>
        <h2 style={{ fontSize:22, fontWeight:900, marginBottom:4 }}>XRPLHub Admin</h2>
        <p style={{ fontSize:12, color:'rgba(255,255,255,.38)', marginBottom:24 }}>Internal use only</p>
        <input type="password" value={pwd} onChange={e=>{setPwd(e.target.value);setPwdErr(false);}}
          onKeyDown={e=>{if(e.key==='Enter'){if(pwd===ADMIN_PWD){setAuthed(true);}else{setPwdErr(true);}}}}
          placeholder="Admin password" autoFocus
          style={{ ...INP, marginBottom:12, textAlign:'center', letterSpacing:'.15em', borderColor: pwdErr?'#f87171':'rgba(255,255,255,.15)' }} />
        {pwdErr && <p style={{ fontSize:12, color:'#f87171', marginBottom:10 }}>Incorrect password</p>}
        <button onClick={()=>{ if(pwd===ADMIN_PWD){setAuthed(true);}else{setPwdErr(true);} }}
          style={{ width:'100%', padding:'12px', borderRadius:99, background:'#10b981', color:'#000', border:'none', fontWeight:800, fontSize:14, cursor:'pointer', fontFamily:'inherit' }}>
          Enter →
        </button>
      </div>
    </div>
  );

  const grants   = data?.grants.recent || [];
  const filtered = grantFilter === 'ALL' ? grants : grants.filter(g => g.status === grantFilter);

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
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background:'rgba(6,6,22,.9)', backdropFilter:'blur(20px)', borderBottom:'1px solid rgba(16,185,129,.18)', padding:'0 28px', height:60, display:'flex', alignItems:'center', justifyContent:'space-between', position:'sticky', top:0, zIndex:50 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:18, fontWeight:900 }}>XRPLHub</span>
          <span style={{ fontSize:10, fontWeight:700, color:'#10b981', background:'rgba(16,185,129,.12)', border:'1px solid rgba(16,185,129,.25)', borderRadius:99, padding:'2px 8px', fontFamily:"'IBM Plex Mono',monospace" }}>ADMIN</span>
          {loading && <span style={{ fontSize:11, color:'#10b981', animation:'pulse 1s infinite' }}>⟳ refreshing…</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          {lastRefresh && <span style={{ fontSize:10, color:'rgba(255,255,255,.28)', fontFamily:"'IBM Plex Mono',monospace" }}>Updated {lastRefresh}</span>}
          <button onClick={fetchData} style={{ padding:'6px 14px', borderRadius:99, background:'rgba(16,185,129,.12)', border:'1px solid rgba(16,185,129,.28)', color:'#10b981', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>↻ Refresh</button>
          <button onClick={()=>setAuthed(false)} style={{ padding:'6px 14px', borderRadius:99, background:'rgba(255,255,255,.06)', border:'1px solid rgba(255,255,255,.12)', color:'rgba(255,255,255,.5)', fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>Log Out</button>
        </div>
      </div>

      <div style={{ maxWidth:1280, margin:'0 auto', padding:'28px 24px' }}>

        {/* ── STAT CARDS ── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:14, marginBottom:28 }}>
          {[
            { label:'Treasury XRP', value:data ? `${data.treasury.balanceXRP} XRP` : '—', sub: data ? `$${data.treasury.balanceUSD} USD · $${data.treasury.xrpPrice}/XRP` : '', color:'#10b981' },
            { label:'Total Score Checks', value:data ? data.scores.totalChecks.toLocaleString() : '—', sub:'All time', color:'#34d399' },
            { label:'Pending Grants', value:data ? String(data.grants.pending) : '—', sub:`${data?.grants.total||0} total applications`, color:'#fbbf24' },
            { label:'Paid Grants', value:data ? String(data.grants.byStatus.PAID||0) : '—', sub:`${data?.grants.byStatus.APPROVED||0} approved, awaiting payout`, color:'#a78bfa' },
            { label:'Total Donations', value:data ? `${data.donations.totalXRP} XRP` : '—', sub:`${data?.donations.count||0} donors`, color:'#f59e0b' },
          ].map(s=>(
            <div key={s.label} style={{ ...CARD(s.color) }}>
              <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,.38)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>{s.label}</div>
              <div style={{ fontSize:24, fontWeight:900, color:s.color, lineHeight:1, marginBottom:4 }}>{s.value}</div>
              <div style={{ fontSize:10, color:'rgba(255,255,255,.32)' }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* ── GRANT STATUS BREAKDOWN ── */}
        {data && (
          <div style={{ ...GLASS, padding:'16px 20px', marginBottom:28, display:'flex', flexWrap:'wrap', gap:'8px 28px', alignItems:'center' }}>
            <span style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,.4)', textTransform:'uppercase', letterSpacing:'.08em' }}>Grant Pipeline</span>
            {Object.entries(data.grants.byStatus).map(([s,n])=>(
              <div key={s} style={{ display:'flex', alignItems:'center', gap:6 }}>
                <StatusBadge s={s} />
                <span style={{ fontSize:16, fontWeight:900, color:'#fff' }}>{n}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── TAB NAV ── */}
        <div style={{ display:'flex', gap:6, marginBottom:22, borderBottom:'1px solid rgba(255,255,255,.07)', paddingBottom:12 }}>
          {(['overview','grants','scores','donations'] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{ padding:'8px 18px', borderRadius:99, border:`1px solid ${tab===t?'#10b981':'rgba(255,255,255,.1)'}`, background:tab===t?'rgba(16,185,129,.15)':'transparent', color:tab===t?'#10b981':'rgba(255,255,255,.45)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit', textTransform:'capitalize', letterSpacing:'.03em', transition:'all .15s' }}>
              {t === 'overview' ? '📊 Overview' : t === 'grants' ? `📋 Grants ${data?`(${data.grants.total})`:''}` : t === 'scores' ? `🎯 Scores ${data?`(${data.scores.totalChecks})`:''}` : `💚 Donations ${data?`(${data.donations.count})`:''}` }
            </button>
          ))}
        </div>

        {/* ── OVERVIEW TAB ── */}
        {tab === 'overview' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(340px,1fr))', gap:18 }}>

            {/* Recent grants */}
            <div style={{ ...GLASS, padding:0, overflow:'hidden' }}>
              <div style={{ padding:'14px 18px', borderBottom:'1px solid rgba(255,255,255,.07)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontSize:13, fontWeight:700 }}>Recent Grant Applications</span>
                <button onClick={()=>setTab('grants')} style={{ fontSize:11, color:'#10b981', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}>View all →</button>
              </div>
              {grants.slice(0,5).length === 0
                ? <div style={{ padding:24, textAlign:'center', fontSize:12, color:'rgba(255,255,255,.3)' }}>No applications yet</div>
                : grants.slice(0,5).map(g=>(
                  <div key={g.id} style={{ padding:'12px 18px', borderBottom:'1px solid rgba(255,255,255,.04)', display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:10 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:3, flexWrap:'wrap' }}>
                        <StatusBadge s={g.status} />
                        <UrgencyBadge u={g.urgency} />
                        <span style={{ fontSize:11, color:'rgba(255,255,255,.45)' }}>{g.category}</span>
                      </div>
                      <div style={{ fontSize:11, color:'rgba(255,255,255,.55)', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{g.description}</div>
                      <div style={{ fontSize:10, color:'rgba(255,255,255,.28)', fontFamily:"'IBM Plex Mono',monospace" }}>{trunc(g.walletAddress)} · {fmt(g.createdAt)}</div>
                    </div>
                    <div style={{ fontSize:14, fontWeight:900, color:'#10b981', flexShrink:0 }}>${g.amountRequested}</div>
                  </div>
                ))
              }
            </div>

            {/* Recent score checks */}
            <div style={{ ...GLASS, padding:0, overflow:'hidden' }}>
              <div style={{ padding:'14px 18px', borderBottom:'1px solid rgba(255,255,255,.07)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontSize:13, fontWeight:700 }}>Recent XRPLScore Checks</span>
                <button onClick={()=>setTab('scores')} style={{ fontSize:11, color:'#10b981', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}>View all →</button>
              </div>
              {(data?.scores.recent||[]).slice(0,6).length === 0
                ? <div style={{ padding:24, textAlign:'center', fontSize:12, color:'rgba(255,255,255,.3)' }}>No score checks yet — check a wallet on the homepage to start</div>
                : (data?.scores.recent||[]).slice(0,6).map((s,i)=>(
                  <div key={i} style={{ padding:'10px 18px', borderBottom:'1px solid rgba(255,255,255,.04)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div>
                      <div style={{ fontSize:11, color:'rgba(255,255,255,.6)', fontFamily:"'IBM Plex Mono',monospace", marginBottom:2 }}>{trunc(s.address,10)}</div>
                      <div style={{ fontSize:10, color:'rgba(255,255,255,.28)' }}>{fmt(s.checkedAt)}</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:18, fontWeight:900, color: s.score>=740?'#10b981':s.score>=580?'#fbbf24':'#ef4444' }}>{s.score}</div>
                      <div style={{ fontSize:9, color:'rgba(255,255,255,.35)' }}>{s.tier}</div>
                    </div>
                  </div>
                ))
              }
            </div>

            {/* Treasury */}
            <div style={{ ...GLASS, padding:'18px 20px' }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:16 }}>🏦 Treasury Status</div>
              {data ? (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:12, color:'rgba(255,255,255,.45)' }}>XRP Balance</span>
                    <span style={{ fontSize:16, fontWeight:900, color:'#10b981' }}>{data.treasury.balanceXRP} XRP</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:12, color:'rgba(255,255,255,.45)' }}>USD Value</span>
                    <span style={{ fontSize:14, fontWeight:700, color:'#34d399' }}>${data.treasury.balanceUSD}</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:12, color:'rgba(255,255,255,.45)' }}>XRP Price</span>
                    <span style={{ fontSize:12, color:'rgba(255,255,255,.6)' }}>${data.treasury.xrpPrice}</span>
                  </div>
                  <div style={{ height:1, background:'rgba(255,255,255,.07)', margin:'4px 0' }} />
                  <a href={`https://xrpscan.com/account/${data.treasury.address}`} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize:11, color:'#10b981', textDecoration:'none', fontFamily:"'IBM Plex Mono',monospace" }}>
                    {trunc(data.treasury.address, 12)} ↗ XRPScan
                  </a>
                </div>
              ) : <div style={{ fontSize:12, color:'rgba(255,255,255,.3)' }}>Loading…</div>}
            </div>

          </div>
        )}

        {/* ── GRANTS TAB ── */}
        {tab === 'grants' && (
          <div>
            <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }}>
              {['ALL','PENDING','REVIEWING','APPROVED','REJECTED','PAID'].map(f=>(
                <button key={f} onClick={()=>setGF(f)} style={{ padding:'7px 14px', borderRadius:99, border:`1px solid ${grantFilter===f?'#10b981':'rgba(255,255,255,.1)'}`, background:grantFilter===f?'rgba(16,185,129,.15)':'transparent', color:grantFilter===f?'#10b981':'rgba(255,255,255,.45)', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
                  {f} {f!=='ALL'&&data?`(${data.grants.byStatus[f]||0})`:''}
                </button>
              ))}
            </div>
            {filtered.length === 0
              ? <div style={{ ...GLASS, padding:40, textAlign:'center', fontSize:13, color:'rgba(255,255,255,.3)' }}>No grant applications yet</div>
              : filtered.map(g=>(
                <div key={g.id} style={{ ...GLASS, padding:'18px 20px', marginBottom:12 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10, marginBottom:12 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6, flexWrap:'wrap' }}>
                        <StatusBadge s={g.status} />
                        <UrgencyBadge u={g.urgency} />
                        <span style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,.55)', background:'rgba(255,255,255,.06)', padding:'2px 7px', borderRadius:6 }}>{g.category}</span>
                        <span style={{ fontSize:10, color:'rgba(255,255,255,.28)', fontFamily:"'IBM Plex Mono',monospace" }}>{fmt(g.createdAt)}</span>
                      </div>
                      <p style={{ fontSize:13, color:'rgba(255,255,255,.7)', lineHeight:1.6, marginBottom:8 }}>{g.description}</p>
                      <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                        <span style={{ fontSize:11, color:'rgba(255,255,255,.38)', fontFamily:"'IBM Plex Mono',monospace" }}>👛 {trunc(g.walletAddress, 10)}</span>
                        {g.scoreSnapshot && <span style={{ fontSize:11, color:'#34d399' }}>📊 XRPLScore: {g.scoreSnapshot}</span>}
                        {g.aiScore != null && <span style={{ fontSize:11, color:'#a78bfa' }}>🤖 AI Risk: {g.aiScore.toFixed(1)}</span>}
                      </div>
                      {g.aiReasoning && <p style={{ fontSize:11, color:'rgba(255,255,255,.35)', marginTop:6, fontStyle:'italic' }}>🤖 {g.aiReasoning}</p>}
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0 }}>
                      <div style={{ fontSize:22, fontWeight:900, color:'#10b981' }}>${g.amountRequested}</div>
                      <div style={{ fontSize:10, color:'rgba(255,255,255,.35)' }}>{g.currency}</div>
                    </div>
                  </div>
                  <GrantActions grant={g} onUpdate={fetchData} />
                </div>
              ))
            }
          </div>
        )}

        {/* ── SCORES TAB ── */}
        {tab === 'scores' && (
          <div style={{ ...GLASS, padding:0, overflow:'hidden' }}>
            <table>
              <thead>
                <tr><th>Wallet</th><th>Score</th><th>Grade</th><th>Time</th><th>XRPScan</th></tr>
              </thead>
              <tbody>
                {(data?.scores.recent||[]).length === 0
                  ? <tr><td colSpan={5} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:40 }}>No score checks yet — check any wallet on xrplhub.io to see it appear here</td></tr>
                  : (data?.scores.recent||[]).map((s,i)=>(
                    <tr key={i}>
                      <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#34d399' }}>{trunc(s.address,12)}</code></td>
                      <td><span style={{ fontSize:16, fontWeight:900, color:s.score>=740?'#10b981':s.score>=580?'#fbbf24':'#ef4444' }}>{s.score}</span></td>
                      <td><span style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,.5)' }}>{s.tier}</span></td>
                      <td style={{ color:'rgba(255,255,255,.4)', fontSize:11 }}>{fmt(s.checkedAt)}</td>
                      <td><a href={`https://xrpscan.com/account/${s.address}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:'#10b981' }}>↗</a></td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        )}

        {/* ── DONATIONS TAB ── */}
        {tab === 'donations' && (
          <div style={{ ...GLASS, padding:0, overflow:'hidden' }}>
            <table>
              <thead>
                <tr><th>From</th><th>Amount</th><th>Currency</th><th>Time</th><th>TX Hash</th></tr>
              </thead>
              <tbody>
                {(data?.donations.recent||[]).length === 0
                  ? <tr><td colSpan={5} style={{ textAlign:'center', color:'rgba(255,255,255,.3)', padding:40 }}>No donations recorded yet</td></tr>
                  : (data?.donations.recent||[]).map((d,i)=>(
                    <tr key={i}>
                      <td><code style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#34d399' }}>{trunc(d.fromAddress,12)}</code></td>
                      <td><span style={{ fontSize:15, fontWeight:900, color:'#10b981' }}>{d.amount}</span></td>
                      <td style={{ color:'rgba(255,255,255,.55)', fontSize:11 }}>{d.currency}</td>
                      <td style={{ color:'rgba(255,255,255,.4)', fontSize:11 }}>{fmt(d.createdAt)}</td>
                      <td><a href={`https://xrpscan.com/tx/${d.txHash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:'#10b981', fontFamily:"'IBM Plex Mono',monospace" }}>{trunc(d.txHash,10)} ↗</a></td>
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
