#!/usr/bin/env node
/* scripts/test-xaman-payload-sizes.mjs
 *
 * Measures, LOCALLY, every custom_meta field XUMM_API actually validates -- identifier (max 40),
 * blob stringified (max 1500), instruction (max 280), per docs.xaman.dev's post-payload reference --
 * for the EXECUTE payload (every step of every one of the storefront services) and the PAYMENT payload (every
 * service + donate), using the real builders. No network call to Xaman, no money moved.
 *
 * Run: node scripts/test-xaman-payload-sizes.mjs
 */
import './ts-hooks.mjs';

const { buildServiceTx } = await import(new URL('../src/app/api/execute/txBuilder.ts', import.meta.url).href);
const { SERVICE_PRICE_USD } = await import(new URL('../src/lib/servicePrices.ts', import.meta.url).href);
const { safeIdentifier } = await import(new URL('../src/lib/xumm.ts', import.meta.url).href);

const LIMITS = { identifier: 40, blob: 1500, instruction: 280 };
const ACCOUNT = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF'; // a real, validly-checksummed address (the treasury's) -- needed to pass isAddr(); nothing is submitted anywhere
const HASH64 = 'A'.repeat(64);

// Other real, validly-checksummed mainnet addresses already known from this session -- used only as
// distinct counterparties for measurement, nothing is submitted anywhere.
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const ANCHOR = 'r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb';
const ISSUER3 = 'rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f';

// Minimal valid params per product so every builder actually returns steps instead of NEED(...).
const PARAMS = {
  regkey: { regularKey: RLUSD_ISSUER },
  tokenfee: { transferFee: 1 },
  trustline: { issuer: RLUSD_ISSUER, currency: 'USD' },
  trustsend: { issuer: RLUSD_ISSUER, currency: 'USD', destination: ANCHOR, amount: '1' },
  mptissue: { name: 'Example Token Name Long', ticker: 'EXAMPL', maximumAmount: '1000000' },
  mptsend: { destination: ANCHOR, mptIssuanceId: '0'.repeat(48), amount: '1' },
  freezeline: { holder: RLUSD_ISSUER, currency: 'USD' },
  ammlaunch: { assetValue: '1', asset2Value: '1', asset2Currency: 'USD' },
  paychannel: { destination: ANCHOR, amount: '1', publicKey: 'ED' + '0'.repeat(64) },
  nftmint: { uri: 'ipfs://Qm' + 'x'.repeat(44) },
  nftburn: { nftokenId: '0'.repeat(64) },
  nftoffer: { nftokenId: '0'.repeat(64), amount: '1' },
  checkcreate: { destination: ANCHOR, amount: '1' },
  checkcash: { checkId: '0'.repeat(64), amount: '1' },
  checkcancel: { checkId: '0'.repeat(64) },
  depositpreauth: { sender: RLUSD_ISSUER },
  escrow: { destination: ANCHOR, amount: '1', finishAfter: 800000000 },
  identity: { domain: 'example.com' },
  did: { uri: 'https://example.com/did.json' },
  compliance: { domain: 'example.com', didUri: 'https://example.com/did.json' },
  credentialissue: { subject: ANCHOR, credentialType: 'kyc-basic' },
  permdomain: { credentialType: 'kyc-basic' },
  multisig: { signers: `${RLUSD_ISSUER},${ANCHOR},${ISSUER3}`, quorum: 2 },
  issuercfg: { domain: 'example.com' },
  rippling: {},
  tickets: { ticketCount: 1 },
};

let worstIdentifier = 0, worstBlob = 0, worstInstruction = 0;
let anyOverflow = false;

console.log('=== EXECUTE step payloads (identifier = xrplhub_exec_<productId>_<ts>) ===');
for (const productId of Object.keys(SERVICE_PRICE_USD)) {
  if (productId === 'credential') continue; // not a builder product, excluded from /api/execute
  const built = await buildServiceTx(productId, ACCOUNT, PARAMS[productId] || {}, { step: 1 });
  if (!built.ok || !built.steps) {
    console.log(`  [SKIP] ${productId}: builder needs params this script didn't supply (${built.error})`);
    continue;
  }
  const plan = built.steps.map((s) => ({ id: s.id, type: String(s.txjson.TransactionType) }));
  for (let step = 1; step <= built.steps.length; step++) {
    const stepObj = built.steps[step - 1];
    const identifier = safeIdentifier('xrplhub_exec_', productId, `_${Date.now()}`);
    const blob = JSON.stringify({ productId, account: ACCOUNT, payTxHash: HASH64, step, totalSteps: plan.length });
    const instruction = `XRPLHub — ${stepObj.label}${plan.length > 1 ? ` (step ${step} of ${plan.length})` : ''}\nSign to execute your service on XRPL mainnet.`;
    const over = identifier.length > LIMITS.identifier || blob.length > LIMITS.blob || instruction.length > LIMITS.instruction;
    if (over) anyOverflow = true;
    worstIdentifier = Math.max(worstIdentifier, identifier.length);
    worstBlob = Math.max(worstBlob, blob.length);
    worstInstruction = Math.max(worstInstruction, instruction.length);
    console.log(
      `  ${over ? '[OVER]' : '[ok]  '} ${productId} step ${step}/${plan.length}: identifier=${identifier.length}/40, blob=${blob.length}/1500, instruction=${instruction.length}/280`
    );
  }
}

console.log('\n=== PAYMENT payload (identifier = xrplhub_<productId>_<ts>) ===');
for (const productId of [...Object.keys(SERVICE_PRICE_USD), 'donate']) {
  const identifier = safeIdentifier('xrplhub_', productId, `_${Date.now()}`);
  const over = identifier.length > LIMITS.identifier;
  if (over) anyOverflow = true;
  worstIdentifier = Math.max(worstIdentifier, identifier.length);
  console.log(`  ${over ? '[OVER]' : '[ok]  '} ${productId}: identifier=${identifier.length}/40`);
}

console.log('\n=== checkout/xaman payload (identifier = xrplhub_ckout_<invoiceId>) ===');
const cuidLen = 25; // Prisma's default cuid() -- fixed length, not variable
const ckoutId = safeIdentifier('xrplhub_ckout_', 'c'.repeat(cuidLen), '');
console.log(`  ${ckoutId.length > 40 ? '[OVER]' : '[ok, but only by ' + (40 - ckoutId.length) + ' char(s)]'} identifier=${ckoutId.length}/40 (worked out from a fixed-length 25-char cuid)`);

console.log(`\nworst identifier: ${worstIdentifier}/40, worst blob: ${worstBlob}/1500, worst instruction: ${worstInstruction}/280`);
console.log(anyOverflow ? '\nOVERFLOWS FOUND' : '\nno overflows');
process.exitCode = anyOverflow ? 1 : 0;
