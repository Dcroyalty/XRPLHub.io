#!/usr/bin/env node
/* RESEARCH ONLY. Per-issuer MPT counts from Bithomp's free ?issuer= filter
 * (complete per issuer, no pagination cap) for the union of issuers found by
 * our state walk + Bithomp's top-100. Paced for the 10 req/min free tier.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const KEY = (process.env.BITHOMP_API_KEY || '').replace(/[<>]/g, '');
const OUT = path.join(__dirname, '.bithomp-reconcile.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const cp = require('./.mpt-census-checkpoint.json');
  const ourByIssuer = {};
  for (const r of Object.values(cp.issuances)) ourByIssuer[r.issuer] = (ourByIssuer[r.issuer] || 0) + 1;

  const os = require('os');
  const bhFile = path.join(os.tmpdir(), 'bithomp-mpts.json');
  const bhLines = fs.readFileSync(bhFile, 'utf8').trim().split('\n').filter(Boolean);
  let bhTop = [];
  for (const l of bhLines) { try { bhTop = bhTop.concat(JSON.parse(l).issuances || []); } catch {} }
  const bhTopIssuers = new Set(bhTop.map(x => x.issuer));

  const union = [...new Set([...Object.keys(ourByIssuer), ...bhTopIssuers])];

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}

  for (const issuer of union) {
    if (done[issuer]) continue;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await fetch(`https://bithomp.com/api/v2/mptokens?issuer=${issuer}&limit=100`, {
          headers: { 'x-bithomp-token': KEY }, signal: AbortSignal.timeout(25000),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error);
        const iss = j.issuances || [];
        done[issuer] = {
          bithompCount: iss.length,
          bithompMarker: j.marker || null, // if set, >100 and we're capped
          liveOutstanding: iss.filter(x => Number(x.outstandingAmount) > 0).length,
          holdersSum: iss.reduce((s, x) => s + (x.holders || 0), 0),
          ourWalkCount: ourByIssuer[issuer] || 0,
        };
        ok = true;
      } catch (e) {
        console.error(`  ${issuer} attempt ${attempt + 1}: ${e.message}`);
        await sleep(8000);
      }
    }
    if (!ok) done[issuer] = { error: 'failed after retries', ourWalkCount: ourByIssuer[issuer] || 0 };
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
    console.error(`  ${issuer}: bithomp=${done[issuer].bithompCount} live=${done[issuer].liveOutstanding} ours=${done[issuer].ourWalkCount} ${done[issuer].bithompMarker ? '(CAPPED >100)' : ''}`);
    await sleep(7000); // 10/min ceiling
  }

  // report
  let bhTotal = 0, ourTotal = 0, liveTotal = 0, holdersTotal = 0, capped = [];
  const rows = union.map(i => {
    const d = done[i];
    bhTotal += d.bithompCount || 0;
    ourTotal += d.ourWalkCount || 0;
    liveTotal += d.liveOutstanding || 0;
    holdersTotal += d.holdersSum || 0;
    if (d.bithompMarker) capped.push(i);
    return { issuer: i, ...d };
  }).sort((a, b) => (b.bithompCount || 0) - (a.bithompCount || 0));

  console.log('\n=== RECONCILIATION ===');
  console.log(`Union issuers: ${union.length}`);
  console.log(`Total MPT issuances — Bithomp: ${bhTotal}  |  our state walk: ${ourTotal}`);
  console.log(`Issuances with outstanding>0 (in circulation), Bithomp view: ${liveTotal}`);
  console.log(`Sum of holder counts across all issuances: ${holdersTotal}`);
  if (capped.length) console.log(`Issuers with >100 issuances (Bithomp count is a floor, free-tier capped): ${capped.join(', ')}`);
  console.log('\nissuer | bithomp | live(out>0) | ourWalk | holders');
  for (const r of rows) {
    console.log(`${r.issuer} | ${r.bithompCount ?? 'ERR'} | ${r.liveOutstanding ?? '-'} | ${r.ourWalkCount} | ${r.holdersSum ?? '-'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
