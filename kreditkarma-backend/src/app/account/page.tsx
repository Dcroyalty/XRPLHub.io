// src/app/account/page.tsx
// Logged-in customer dashboard: purchase history, XRPLScore history, grant applications.
'use client';
import React, { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

interface User { email: string; name: string }
interface Purchase { productId:string; productName?:string; amount:string; currency:string; txHash:string; serviceTxHash?:string; status?:string; verifiedAt?:string; deliveredAt?:string }
interface ScorePoint { score:number; scannedAt:string }
interface GrantApp { id:string; category:string; amount:number; status:string; aiRecommendation?:string; createdAt:string }

export default function AccountDashboard() {
  const [user, setUser] = useState<User|null>(null);
  const [wallet, setWallet] = useState('');
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [score, setScore] = useState<ScorePoint[]>([]);
  const [grants, setGrants] = useState<GrantApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview'|'purchases'|'score'|'grants'>('overview');

  // Load session + data
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = localStorage.getItem('xh_user');
    const w = localStorage.getItem('xh_wallet') || '';
    if (u) { try { setUser(JSON.parse(u)); } catch {} }
    setWallet(w);
    (async () => {
      try {
        const email = u ? (JSON.parse(u).email || '') : '';
        const [pRes, sRes, gRes] = await Promise.all([
          fetch(`${API_URL}/api/purchase?email=${encodeURIComponent(email)}&wallet=${encodeURIComponent(w)}`).catch(()=>null),
          w ? fetch(`${API_URL}/api/score-history?wallet=${encodeURIComponent(w)}`).catch(()=>null) : null,
          fetch(`${API_URL}/api/grants?email=${encodeURIComponent(email)}&wallet=${encodeURIComponent(w)}`).catch(()=>null),
        ]);
        if (pRes && pRes.ok) { const d = await pRes.json(); setPurchases(Array.isArray(d)?d:(d.purchases||[])); }
        if (sRes && sRes.ok) { const d = await sRes.json(); setScore(Array.isArray(d)?d:(d.history||[])); }
        if (gRes && gRes.ok) { const d = await gRes.json(); setGrants(Array.isArray(d)?d:(d.grants||[])); }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const handleLogout = () => {
    if (typeof window !== 'undefined') { localStorage.removeItem('xh_user'); window.location.href = '/'; }
  };

  const fmtDate = (s?:string) => s ? new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  const statusColor = (s?:string) => ({ DELIVERED:'#10b981', PAID:'#10b981', APPROVED:'#10b981', PENDING:'#f59e0b', REVIEWING:'#38bdf8', REJECTED:'#ef4444', FAILED:'#ef4444' } as Record<string,string>)[s||''] || 'rgba(255,255,255,.5)';

  if (!user) {
    return (
      <main style={{ minHeight:'100vh', background:'#060616', color:'#fff', fontFamily:'system-ui,sans-serif', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
        <div style={{ maxWidth:420, textAlign:'center' }}>
          <h1 style={{ fontSize:28, fontWeight:900, marginBottom:14 }}>Sign In Required</h1>
          <p style={{ color:'rgba(255,255,255,.5)', marginBottom:24 }}>Please log in to see your account dashboard.</p>
          <a href="/" style={{ display:'inline-block', padding:'13px 26px', background:'#10b981', color:'#000', borderRadius:99, fontWeight:800, textDecoration:'none' }}>← Back to Home</a>
        </div>
      </main>
    );
  }

  const totalSpent = purchases.reduce((s,p)=>s + Number(p.amount||0), 0);
  const latestScore = score.length ? score[score.length-1].score : null;
  const activeGrants = grants.filter(g=>['PENDING','REVIEWING','APPROVED'].includes(g.status)).length;

  return (
    <main style={{ minHeight:'100vh', background:'#060616', color:'#fff', fontFamily:'system-ui,-apple-system,sans-serif' }}>
      {/* Header */}
      <header style={{ borderBottom:'1px solid rgba(255,255,255,.08)', padding:'16px 24px', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
        <a href="/" style={{ color:'#fff', textDecoration:'none', fontSize:18, fontWeight:900 }}>
          <span style={{ color:'#10b981' }}>xrpl</span><span style={{ color:'#38bdf8' }}>Hub</span><span style={{ color:'#ef4444' }}>.io</span>
        </a>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <span style={{ fontSize:13, color:'rgba(255,255,255,.45)' }}>{user.name || user.email}</span>
          <button onClick={handleLogout} style={{ background:'none', border:'1px solid rgba(255,255,255,.15)', color:'#fff', padding:'7px 14px', borderRadius:99, fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>Log Out</button>
        </div>
      </header>

      <div style={{ maxWidth:1100, margin:'0 auto', padding:'40px 24px' }}>
        <div style={{ marginBottom:30 }}>
          <p style={{ fontSize:11, fontWeight:700, color:'#10b981', letterSpacing:'.16em', textTransform:'uppercase', marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>My Account</p>
          <h1 style={{ fontSize:'clamp(26px,4vw,38px)', fontWeight:900, letterSpacing:'-1.5px' }}>Welcome back, {user.name || user.email.split('@')[0]}</h1>
          {wallet && <p style={{ fontSize:12, color:'rgba(255,255,255,.35)', marginTop:6, fontFamily:"'IBM Plex Mono',monospace" }}>Connected wallet: {wallet.slice(0,10)}…{wallet.slice(-6)}</p>}
        </div>

        {/* Stat cards */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))', gap:14, marginBottom:30 }}>
          <StatCard label="Total Purchases" value={String(purchases.length)} sub={purchases.length ? `${totalSpent.toFixed(0)} spent` : '—'} color="#10b981" />
          <StatCard label="Current XRPLScore™" value={latestScore?String(latestScore):'—'} sub={latestScore?'300–850 scale':'Connect wallet'} color="#34d399" />
          <StatCard label="Active Grant Apps" value={String(activeGrants)} sub={grants.length?`${grants.length} total`:'—'} color="#8b5cf6" />
          <StatCard label="Wallet" value={wallet?'Connected':'Not connected'} sub={wallet?'Xaman':'Connect on home'} color="#38bdf8" />
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:6, marginBottom:18, borderBottom:'1px solid rgba(255,255,255,.07)', overflowX:'auto' }}>
          {(['overview','purchases','score','grants'] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{ background:'none', border:'none', color:tab===t?'#10b981':'rgba(255,255,255,.5)', fontWeight:tab===t?800:600, fontSize:14, padding:'12px 16px', cursor:'pointer', fontFamily:'inherit', borderBottom:`2px solid ${tab===t?'#10b981':'transparent'}`, textTransform:'capitalize', whiteSpace:'nowrap' }}>{t}</button>
          ))}
        </div>

        {loading && <p style={{ color:'rgba(255,255,255,.4)', padding:20, textAlign:'center' }}>Loading your data…</p>}

        {!loading && tab === 'overview' && (
          <div style={{ display:'grid', gap:14 }}>
            <SectionCard title="Recent Purchases" empty={purchases.length===0} emptyText="No purchases yet. Visit the home page to explore services.">
              {purchases.slice(0,3).map((p,i)=>(<PurchaseRow key={i} p={p} fmtDate={fmtDate} statusColor={statusColor} />))}
            </SectionCard>
            <SectionCard title="Latest Grant Activity" empty={grants.length===0} emptyText="No grant applications yet.">
              {grants.slice(0,3).map(g=>(<GrantRow key={g.id} g={g} fmtDate={fmtDate} statusColor={statusColor} />))}
            </SectionCard>
          </div>
        )}

        {!loading && tab === 'purchases' && (
          <SectionCard title="All Purchases" empty={purchases.length===0} emptyText="No purchases yet.">
            {purchases.map((p,i)=>(<PurchaseRow key={i} p={p} fmtDate={fmtDate} statusColor={statusColor} />))}
          </SectionCard>
        )}

        {!loading && tab === 'score' && (
          <SectionCard title="XRPLScore™ History" empty={score.length===0} emptyText={wallet?'No score history yet. Run your first scan from the home page.':'Connect a wallet to see your score history.'}>
            {score.length>0 && <ScoreChart points={score} />}
            <div style={{ marginTop:14 }}>
              {score.slice().reverse().slice(0,12).map((s,i)=>(
                <div key={i} style={{ display:'flex',justifyContent:'space-between',padding:'10px 0',borderBottom:'1px solid rgba(255,255,255,.05)' }}>
                  <span style={{ fontSize:13,color:'rgba(255,255,255,.55)' }}>{fmtDate(s.scannedAt)}</span>
                  <span style={{ fontSize:14,fontWeight:800,color:'#10b981',fontFamily:"'IBM Plex Mono',monospace" }}>{s.score}</span>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {!loading && tab === 'grants' && (
          <SectionCard title="All Grant Applications" empty={grants.length===0} emptyText="No grant applications yet.">
            {grants.map(g=>(<GrantRow key={g.id} g={g} fmtDate={fmtDate} statusColor={statusColor} />))}
          </SectionCard>
        )}
      </div>
    </main>
  );
}

// ── Components ──
function StatCard({ label, value, sub, color }: { label:string; value:string; sub?:string; color:string }) {
  return (
    <div style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.07)', borderRadius:14, padding:'16px 18px' }}>
      <div style={{ fontSize:10,fontWeight:700,color:'rgba(255,255,255,.4)',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:'clamp(22px,2.4vw,26px)',fontWeight:900,color,fontFamily:"'IBM Plex Mono',monospace" }}>{value}</div>
      {sub && <div style={{ fontSize:11,color:'rgba(255,255,255,.35)',marginTop:4 }}>{sub}</div>}
    </div>
  );
}
function SectionCard({ title, children, empty, emptyText }: { title:string; children:React.ReactNode; empty?:boolean; emptyText?:string }) {
  return (
    <div style={{ background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)', borderRadius:16, padding:'18px 20px' }}>
      <h2 style={{ fontSize:14,fontWeight:800,color:'rgba(255,255,255,.85)',marginBottom:12 }}>{title}</h2>
      {empty ? <p style={{ fontSize:13,color:'rgba(255,255,255,.35)',padding:'12px 0' }}>{emptyText}</p> : children}
    </div>
  );
}
function PurchaseRow({ p, fmtDate, statusColor }: { p:Purchase; fmtDate:(s?:string)=>string; statusColor:(s?:string)=>string }) {
  return (
    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:'1px solid rgba(255,255,255,.05)',gap:10,flexWrap:'wrap' }}>
      <div style={{ flex:1,minWidth:160 }}>
        <div style={{ fontSize:13,fontWeight:700,color:'#fff' }}>{p.productName || p.productId}</div>
        <div style={{ fontSize:11,color:'rgba(255,255,255,.4)',marginTop:2 }}>{fmtDate(p.verifiedAt || p.deliveredAt)} · {p.amount} {p.currency}</div>
      </div>
      <span style={{ fontSize:10,fontWeight:800,color:statusColor(p.status?.startsWith('ACTIVE') ? 'REVIEWING' : p.status),background:statusColor(p.status?.startsWith('ACTIVE') ? 'REVIEWING' : p.status)+'18',border:`1px solid ${statusColor(p.status?.startsWith('ACTIVE') ? 'REVIEWING' : p.status)}40`,borderRadius:99,padding:'3px 10px',textTransform:'uppercase',letterSpacing:'.1em' }}>{p.status?.startsWith('ACTIVE') ? 'In progress' : (p.status || 'Verified')}</span>
      {p.serviceTxHash && p.serviceTxHash.split(',').filter(Boolean).map((h,i,all)=>(<a key={h} href={`https://xrpscan.com/tx/${h}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:11,color:'#10b981',textDecoration:'none',marginRight:8 }}>{all.length>1?`TX ${i+1} ↗`:'TX ↗'}</a>))}
    </div>
  );
}
function GrantRow({ g, fmtDate, statusColor }: { g:GrantApp; fmtDate:(s?:string)=>string; statusColor:(s?:string)=>string }) {
  return (
    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:'1px solid rgba(255,255,255,.05)',gap:10,flexWrap:'wrap' }}>
      <div style={{ flex:1,minWidth:160 }}>
        <div style={{ fontSize:13,fontWeight:700,color:'#fff' }}>{g.category} · ${g.amount}</div>
        <div style={{ fontSize:11,color:'rgba(255,255,255,.4)',marginTop:2 }}>{fmtDate(g.createdAt)}</div>
      </div>
      <span style={{ fontSize:10,fontWeight:800,color:statusColor(g.status),background:statusColor(g.status)+'18',border:`1px solid ${statusColor(g.status)}40`,borderRadius:99,padding:'3px 10px',textTransform:'uppercase',letterSpacing:'.1em' }}>{g.status}</span>
    </div>
  );
}
// Minimal inline SVG sparkline for score history — no chart library
function ScoreChart({ points }: { points:ScorePoint[] }) {
  if (points.length < 2) return null;
  const w = 600, h = 120, pad = 8;
  const scores = points.map(p=>p.score);
  const min = Math.min(...scores, 300), max = Math.max(...scores, 850);
  const range = Math.max(max-min, 1);
  const xs = (i:number) => pad + (i / (points.length-1)) * (w - 2*pad);
  const ys = (v:number) => h - pad - ((v-min)/range) * (h - 2*pad);
  const path = points.map((p,i) => `${i===0?'M':'L'}${xs(i).toFixed(1)},${ys(p.score).toFixed(1)}`).join(' ');
  const last = points[points.length-1];
  return (
    <div style={{ background:'rgba(16,185,129,.04)', border:'1px solid rgba(16,185,129,.15)', borderRadius:12, padding:12 }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width:'100%', height:120, display:'block' }}>
        <path d={path} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xs(points.length-1)} cy={ys(last.score)} r="4.5" fill="#10b981" />
      </svg>
      <div style={{ display:'flex',justifyContent:'space-between',fontSize:11,color:'rgba(255,255,255,.4)',marginTop:6,fontFamily:"'IBM Plex Mono',monospace" }}>
        <span>Min: {Math.min(...scores)}</span><span>Latest: <strong style={{ color:'#10b981' }}>{last.score}</strong></span><span>Max: {Math.max(...scores)}</span>
      </div>
    </div>
  );
}
