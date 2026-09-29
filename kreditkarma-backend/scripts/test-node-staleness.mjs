#!/usr/bin/env node
/* scripts/test-node-staleness.mjs
 *
 * Exercises src/lib/xrplNodes.ts's staleness/amendment-block defense (see its header comment for the
 * design). Three rounds:
 *
 *   A. The real 8 rotation nodes, live — confirms today's actual ring state (trusted, nobody cooled).
 *   B. The real 8 nodes, but one swapped for a local mock server reporting a validated ledger 50 behind
 *      the rest — confirms a genuinely lagging node gets cooled while the other 7 stay in rotation and the
 *      majority is still correctly read off the real nodes (a single outlier can't flip trust).
 *   C. A fully synthetic 3-node ring (2 healthy + 1 far-behind) sized so cooling the bad one would drop the
 *      pool to 2 — below MIN_HEALTHY_NODES (3). Confirms the safety floor leaves it uncooled rather than
 *      shrinking the healthy pool, and that this is reported as floorHit so the watchdog can alert on it.
 *
 * Run: node scripts/test-node-staleness.mjs
 */
import './ts-hooks.mjs';
import http from 'node:http';

const REPO_ROOT = new URL('../', import.meta.url);
const { sweepNodeHealth, isCooling, XRPL_NODES, MIN_HEALTHY_NODES } = await import(
  new URL('src/lib/xrplNodes.ts', REPO_ROOT).href
);

let failures = 0;
function check(label, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

/** A throwaway HTTP server that answers server_info like a rippled node, with a fixed ledger seq and
 *  amendment_blocked flag — lets us simulate a specific node state without touching real infrastructure. */
function mockNode({ seq, amendmentBlocked = false }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { info: { validated_ledger: { seq }, amendment_blocked: amendmentBlocked } } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

(async () => {
  console.log('=== A. Real 8 nodes, live ===');
  const a = await sweepNodeHealth(XRPL_NODES);
  console.log('  ', JSON.stringify({ trusted: a.trusted, responded: a.responded, majorityLedgerIndex: a.majorityLedgerIndex, amendmentBlocked: a.amendmentBlocked, lagging: a.lagging, cooled: a.cooled, floorHit: a.floorHit }));
  check('all 8 nodes responded', a.responded === XRPL_NODES.length, `${a.responded}/${XRPL_NODES.length}`);
  check('ring is trusted', a.trusted === true);
  check('nobody amendment-blocked right now', a.amendmentBlocked.length === 0);
  check('nobody cooled', a.cooled.length === 0);

  console.log('\n=== B. 7 real nodes + 1 simulated laggard (50 behind) ===');
  const majority = a.majorityLedgerIndex ?? 0;
  const lagger = await mockNode({ seq: Math.max(0, majority - 50) });
  const poolB = [...XRPL_NODES.slice(0, 7), lagger.url];
  const b = await sweepNodeHealth(poolB);
  console.log('  ', JSON.stringify({ trusted: b.trusted, majorityLedgerIndex: b.majorityLedgerIndex, lagging: b.lagging, cooled: b.cooled, floorHit: b.floorHit }));
  check('majority still trusted with one outlier', b.trusted === true);
  check('the laggard was flagged', b.lagging.some((l) => l.host.includes(String(new URL(lagger.url).port))));
  check('the laggard is now cooling', isCooling(lagger.url));
  check('the 7 real nodes were left uncooled', poolB.slice(0, 7).every((u) => !isCooling(u)));
  check('floor was not hit (plenty of headroom)', b.floorHit === false);
  lagger.close();

  console.log('\n=== C. Synthetic 3-node ring: 2 healthy + 1 far-behind, floor = ' + MIN_HEALTHY_NODES + ' ===');
  const good1 = await mockNode({ seq: 1000 });
  const good2 = await mockNode({ seq: 1001 });
  const bad = await mockNode({ seq: 500 }); // 500 behind — way past the threshold
  const poolC = [good1.url, good2.url, bad.url];
  const c = await sweepNodeHealth(poolC);
  console.log('  ', JSON.stringify({ trusted: c.trusted, lagging: c.lagging, cooled: c.cooled, floorHit: c.floorHit }));
  check('the 2 good nodes form the trusted majority', c.trusted === true);
  check('the bad node was flagged as lagging', c.lagging.length === 1);
  check('the bad node was NOT cooled (cooling it would drop the pool to 2, below the floor)', c.cooled.length === 0);
  check('floorHit is true', c.floorHit === true);
  check('the bad node is still NOT in cooldown (left serving, on purpose)', !isCooling(bad.url));
  good1.close(); good2.close(); bad.close();

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
