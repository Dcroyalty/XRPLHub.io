// src/app/score/page.tsx
// Compatibility redirect: any /score visit lands on the home page's XRPLScore section.
// (The full personalized wallet report lives inline on home when wallet is connected.)
'use client';
import { useEffect } from 'react';

export default function ScoreRedirect() {
  useEffect(() => {
    if (typeof window !== 'undefined') window.location.replace('/#score');
  }, []);
  return (
    <main style={{ minHeight:'60vh', background:'#060616', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'system-ui,-apple-system,sans-serif' }}>
      <p style={{ color:'rgba(255,255,255,.5)', fontSize:14 }}>Redirecting to XRPLScore™…</p>
    </main>
  );
}
