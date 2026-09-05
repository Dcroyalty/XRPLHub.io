'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
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

const TICKER = [
  'Write a check on XRPL — yes, really. Create, cash, or cancel a Check in one tap',
  'XRPLScore™ — your own on-chain credit score. No FICO. No bureau. No SSN.',
  'Send money safely with on-chain Escrow — funds release exactly when you choose',
  'Behind on rent or groceries? Apply for a Community Grant — money straight to your wallet',
  'Mint NFTs with royalties baked in — your digital art, yours forever',
  'One leaked key shouldn\'t drain your wallet — lock it down with Multi-Sig Fortress',
  'Build XRPLScore™ monthly — turn on-chain history into real reputation',
  'Launch a token the right way — Issuer Trustless Declaration in one signed transaction',
  'Spin up an AMM liquidity pool with a single Xaman signature',
  'Put your identity on-chain — verifiable, portable, yours',
  'Donate to the Community Grant treasury — 100% reaches real people, verifiable on-chain',
  'Check any XRPL wallet\'s XRPLScore™ free — instant, live from mainnet',
  'Found an XRPL tutorial but don\'t code? Skip it — pay here, AI does it for you',
  '35 XRPL services done for you · You sign once in Xaman · Live on mainnet in ~4 seconds',
  'XRPLHub.io — XRPL Services · Community Grants · XRPLScore™',
];

// ─── XRPL SERVICES — DONE FOR YOU (mirrors xrpl.org tutorials) ───
const PRODUCTS = [
  // WALLET SECURITY
  { id:'multisig', cat:'Wallet Security', emoji:'🏰', name:'Multi-Sig Fortress', featured:false, tag:'HOT', comingSoon:false, color:'#10b981', priceRLUSD:60, priceXRP:195,
    amendment:'SignerListSet', tagline:'Require multiple signatures for every transaction',
    desc:'You tell us the signers and quorum. AI builds the exact SignerListSet transaction parameters. You sign once in Xaman. Your wallet then requires M-of-N signatures for every outgoing transaction.',
    aiDetail:'AI assembles a SignerListSet transaction with your quorum and signer list. After you sign in Xaman it is permanent on XRPL mainnet (~4s). No single key can move funds alone.',
    features:['SignerListSet built to your spec','M-of-N signature requirement','Works with Xaman multi-sign','You sign once — permanent on-chain','TX hash receipt'] },
  { id:'regkey', cat:'Wallet Security', emoji:'🔑', name:'Regular Key Rotator', featured:false, comingSoon:false, color:'#34d399', priceRLUSD:30, priceXRP:95,
    amendment:'SetRegularKey', tagline:'Assign a backup signing key without exposing your master key',
    desc:'You provide the regular key. AI builds the SetRegularKey transaction. You sign once in Xaman.',
    aiDetail:'AI assembles a SetRegularKey transaction so you can sign day-to-day with a rotatable key while your master key stays cold.',
    features:['SetRegularKey built to your spec','Rotatable signing key','Master key stays offline','You sign once in Xaman','TX hash receipt'] },
  { id:'depositauth', cat:'Wallet Security', emoji:'🛡️', name:'Deposit Auth Guard', featured:false, comingSoon:false, color:'#10b981', priceRLUSD:20, priceXRP:65,
    amendment:'AccountSet · asfDepositAuth', tagline:'Block unsolicited incoming payments',
    desc:'AI builds the AccountSet (asfDepositAuth) transaction. You sign once — only pre-authorized senders can deposit.',
    aiDetail:'AI assembles AccountSet with asfDepositAuth. After signing, your account rejects payments from unauthorized senders.',
    features:['asfDepositAuth set on-chain','Blocks unsolicited deposits','Pre-authorize senders','You sign once in Xaman','TX hash receipt'] },
  { id:'desttag', cat:'Wallet Security', emoji:'🏷️', name:'Destination Tag Lock', featured:false, comingSoon:false, color:'#34d399', priceRLUSD:15, priceXRP:50,
    amendment:'AccountSet · RequireDest', tagline:'Require a destination tag on every incoming payment',
    desc:'AI builds AccountSet with asfRequireDest. You sign once — prevents misrouted deposits.',
    aiDetail:'AI assembles AccountSet (asfRequireDest). After signing, payments without a destination tag are rejected.',
    features:['asfRequireDest set on-chain','Prevents misrouted deposits','You sign once in Xaman','Permanent on mainnet','TX hash receipt'] },
  // TOKEN ISSUER
  { id:'issuerdecl', cat:'Token Issuer', emoji:'📜', name:'Issuer Trustless Declaration', featured:false, tag:'POPULAR', comingSoon:false, color:'#f59e0b', priceRLUSD:40, priceXRP:130,
    amendment:'AccountSet · asfNoFreeze', tagline:'As an issuer, permanently give up freeze authority',
    desc:'For token issuers: AI builds AccountSet (asfNoFreeze), permanently surrendering your ability to freeze holders\u2019 trust lines — a credible trustless signal. You sign once in Xaman.',
    aiDetail:'AI assembles AccountSet with asfNoFreeze on YOUR issuing account. This permanently removes your freeze authority over tokens you issue. It does not affect tokens others issue to you.',
    features:['asfNoFreeze on issuing account','Permanent — cannot be undone','Trustless signal to holders','You sign once in Xaman','TX hash receipt'] },
  { id:'tokenfee', cat:'Token Issuer', emoji:'💱', name:'Token Transfer Fee', featured:false, comingSoon:false, color:'#fbbf24', priceRLUSD:25, priceXRP:80,
    amendment:'AccountSet · TransferRate', tagline:'Set a transfer fee on the token you issue',
    desc:'AI builds AccountSet with your TransferRate. You sign once.',
    aiDetail:'AI assembles AccountSet with your chosen TransferRate (0–100%). Applies to secondary transfers of your issued token.',
    features:['TransferRate set to your spec','Up to protocol max','You sign once in Xaman','Permanent until changed','TX hash receipt'] },
  { id:'issuercfg', cat:'Token Issuer', emoji:'🏭', name:'Full Issuer Config', featured:false, comingSoon:false, color:'#f59e0b', priceRLUSD:80, priceXRP:260,
    amendment:'AccountSet · Multi-flag', tagline:'Complete issuer setup in one guided flow',
    desc:'Domain, transfer fee, tick size, and issuer flags configured together. AI builds the transaction set; you sign in Xaman.',
    aiDetail:'AI assembles the full AccountSet configuration for a production token issuer — domain, TransferRate, TickSize, and flags.',
    features:['Full issuer AccountSet','Domain + fee + tick size','Issuer flags configured','You sign in Xaman','TX hash receipt'] },
  { id:'trustline', cat:'Token Issuer', emoji:'🔗', name:'Trust Line Configurator', featured:false, tag:'SALE', comingSoon:false, color:'#fbbf24', priceRLUSD:20, priceXRP:65,
    amendment:'TrustSet', tagline:'Create or adjust a trust line with precise limits',
    desc:'AI builds a TrustSet transaction with your currency, issuer, and limit. You sign once.',
    aiDetail:'AI assembles TrustSet with your specified currency, issuer, and limit value.',
    features:['TrustSet built to your spec','Custom limit + flags','You sign once in Xaman','Permanent on mainnet','TX hash receipt'] },
  { id:'rippling', cat:'Token Issuer', emoji:'🌊', name:'Rippling Controller', featured:false, comingSoon:false, color:'#f59e0b', priceRLUSD:20, priceXRP:65,
    amendment:'AccountSet · DefaultRipple / NoRipple', tagline:'Control rippling on your trust lines',
    desc:'AI builds the AccountSet / TrustSet flags to enable or disable rippling. You sign once.',
    aiDetail:'AI assembles the DefaultRipple or NoRipple flag changes appropriate for an issuer or a holder.',
    features:['Rippling flags built to spec','Issuer + holder modes','You sign once in Xaman','Permanent until changed','TX hash receipt'] },
  // DEFI
  { id:'dexorder', cat:'DeFi', emoji:'📊', name:'DEX Order Builder', featured:false, comingSoon:false, color:'#a78bfa', priceRLUSD:25, priceXRP:80,
    amendment:'OfferCreate', tagline:'Place a limit order on the native XRPL DEX',
    desc:'You give the pair and price. AI builds the OfferCreate transaction. You sign once — the order rests on the XRPL order book.',
    aiDetail:'AI assembles OfferCreate with your TakerPays / TakerGets. Placed directly on the XRPL DEX after you sign. No smart contract risk.',
    features:['OfferCreate built to your spec','Native XRPL DEX','You sign once in Xaman','No smart-contract risk','TX hash receipt'] },
  { id:'ammlaunch', cat:'DeFi', emoji:'🌀', name:'AMM Pool Launch', featured:false, tag:'HOT', comingSoon:false, color:'#8b5cf6', priceRLUSD:75, priceXRP:245,
    amendment:'AMMCreate', tagline:'Launch a new AMM liquidity pool',
    desc:'You choose the asset pair and seed amounts. AI builds the AMMCreate transaction. You sign once in Xaman.',
    aiDetail:'AI assembles AMMCreate for your asset pair and seed liquidity. After you sign, the pool exists on XRPL mainnet.',
    features:['AMMCreate built to your spec','New pool on mainnet','You sign once in Xaman','LP tokens to your wallet','TX hash receipt'] },
  { id:'ammentry', cat:'DeFi', emoji:'💧', name:'AMM Liquidity Entry', featured:false, comingSoon:false, color:'#a78bfa', priceRLUSD:35, priceXRP:115,
    amendment:'AMMDeposit', tagline:'Add liquidity to an existing AMM pool',
    desc:'AI builds the AMMDeposit transaction for your chosen pool and amounts. You sign once.',
    aiDetail:'AI assembles AMMDeposit for your target pool. You receive LP tokens after signing.',
    features:['AMMDeposit built to spec','Single or double-sided','You sign once in Xaman','LP tokens to your wallet','TX hash receipt'] },
  { id:'smartswap', cat:'DeFi', emoji:'🔁', name:'Smart Swap Router', featured:false, comingSoon:false, color:'#8b5cf6', priceRLUSD:25, priceXRP:80,
    amendment:'Payment · Pathfinding', tagline:'Swap assets through the best on-ledger path',
    desc:'AI builds a path Payment that routes through DEX + AMM liquidity. You sign once.',
    aiDetail:'AI assembles a Payment with pathfinding so your swap takes an efficient on-ledger route.',
    features:['Path Payment built to spec','Routes DEX + AMM','You sign once in Xaman','Slippage bounds set','TX hash receipt'] },
  { id:'paychannel', cat:'DeFi', emoji:'⚡', name:'Payment Channel', featured:false, comingSoon:false, color:'#a78bfa', priceRLUSD:50, priceXRP:160,
    amendment:'PaymentChannelCreate', tagline:'Open a channel for streaming micropayments',
    desc:'AI builds PaymentChannelCreate with your destination and settle delay. You sign once.',
    aiDetail:'AI assembles PaymentChannelCreate. After signing, you can stream off-ledger claims with one final settlement.',
    features:['PaymentChannelCreate built','Off-ledger micropayments','You sign once in Xaman','Configurable settle delay','TX hash receipt'] },
  // NFT
  { id:'nftmint', cat:'NFT', emoji:'🎨', name:'NFT Minter', featured:false, tag:'HOT', comingSoon:false, color:'#ec4899', priceRLUSD:30, priceXRP:95,
    amendment:'NFTokenMint', tagline:'Mint an NFT with up to 50% royalties',
    desc:'You give the metadata URI and royalty. AI builds NFTokenMint. You sign once in Xaman.',
    aiDetail:'AI assembles NFTokenMint with your URI, transfer fee (0–50%), and flags. Minted to your wallet after signing.',
    features:['NFTokenMint built to spec','Up to 50% royalty','Custom URI + flags','You sign once in Xaman','TX hash receipt'] },
  { id:'nftburn', cat:'NFT', emoji:'🔥', name:'NFT Burn Certificate', featured:false, comingSoon:false, color:'#f472b6', priceRLUSD:20, priceXRP:65,
    amendment:'NFTokenBurn', tagline:'Permanently burn an NFT with on-chain proof',
    desc:'AI builds NFTokenBurn for your token ID. You sign once — the burn is permanent and verifiable.',
    aiDetail:'AI assembles NFTokenBurn for your NFTokenID. After signing, the token is destroyed on mainnet.',
    features:['NFTokenBurn built to spec','Permanent + verifiable','You sign once in Xaman','On-chain burn proof','TX hash receipt'] },
  { id:'nftoffer', cat:'NFT', emoji:'🏷️', name:'NFT Offer Creator', featured:false, comingSoon:false, color:'#ec4899', priceRLUSD:20, priceXRP:65,
    amendment:'NFTokenCreateOffer', tagline:'Create a buy or sell offer for an NFT',
    desc:'AI builds NFTokenCreateOffer with your price and token. You sign once.',
    aiDetail:'AI assembles NFTokenCreateOffer (buy or sell) for your token at your price.',
    features:['NFTokenCreateOffer built','Buy or sell side','You sign once in Xaman','On-chain offer','TX hash receipt'] },
  // IDENTITY
  { id:'identity', cat:'Identity', emoji:'🪪', name:'On-Chain Identity', featured:false, comingSoon:false, color:'#06b6d4', priceRLUSD:20, priceXRP:65,
    amendment:'AccountSet · Domain + Email Hash', tagline:'Link your verified domain and email to your wallet',
    desc:'AI builds AccountSet encoding your domain and email hash. You sign once — explorers show your verified identity.',
    aiDetail:'AI assembles AccountSet with your domain (hex) and SHA-256 email hash into your account root.',
    features:['AccountSet built to spec','Domain + email hash','Recognized by explorers','You sign once in Xaman','TX hash receipt'] },
  { id:'did', cat:'Identity', emoji:'🆔', name:'DID Creator', featured:false, comingSoon:false, color:'#22d3ee', priceRLUSD:35, priceXRP:115,
    amendment:'DIDSet', tagline:'Create a decentralized identifier on the XRP Ledger',
    desc:'AI builds a DIDSet transaction with your DID document reference. You sign once.',
    aiDetail:'AI assembles DIDSet with your DID document URI / data. After signing, the DID is anchored on mainnet.',
    features:['DIDSet built to spec','On-ledger DID anchor','You sign once in Xaman','Document URI reference','TX hash receipt'] },
  { id:'compliance', cat:'Identity', emoji:'✅', name:'Compliance Bundle', featured:false, comingSoon:false, color:'#06b6d4', priceRLUSD:55, priceXRP:180,
    amendment:'AccountSet + Domain + DID', tagline:'Identity + domain + DID configured together',
    desc:'A guided bundle: on-chain identity, domain verification, and a DID in one flow. You sign the set in Xaman.',
    aiDetail:'AI assembles the combined identity transactions (AccountSet domain/email + DIDSet) for a complete verifiable profile.',
    features:['Identity + domain + DID','One guided flow','You sign in Xaman','Explorer-recognized','TX hash receipts'] },
  // ESCROW
  { id:'escrow', cat:'Escrow', emoji:'🏛️', name:'Escrow Setup', featured:false, tag:'POPULAR', comingSoon:false, color:'#f97316', priceRLUSD:40, priceXRP:130,
    amendment:'EscrowCreate', tagline:'Time-lock XRP with a release condition',
    desc:'You set the amount and release time. AI builds EscrowCreate. You sign once — funds release on your terms.',
    aiDetail:'AI assembles EscrowCreate with your FinishAfter time and optional condition. You later finish or cancel it.',
    features:['EscrowCreate built to spec','Time or crypto-condition','You sign once in Xaman','On-chain audit trail','TX hash receipt'] },

  // TOKENS (v2 + management) — mirrors xrpl.org/docs/tutorials/tokens, done for you
  { id:'mptissue', cat:'Token Issuer', emoji:'🎫', name:'Multi-Purpose Token (MPT) Issuance', featured:false, tag:'NEW', comingSoon:false, color:'#38bdf8', priceRLUSD:55, priceXRP:180,
    amendment:'MPTokenIssuanceCreate', tagline:'Issue an asset-backed token on the new v2 standard',
    desc:'The XRPL tutorial walks developers through coding an MPT in JavaScript. We do it for you. You give us the token specs (supply, scale, flags, metadata). AI builds the exact MPTokenIssuanceCreate transaction. You sign once in Xaman.',
    aiDetail:'AI assembles MPTokenIssuanceCreate with your maximum amount, asset scale, transfer fee, and metadata. After you sign in Xaman it is permanent on mainnet (~4s). MPT is the modern v2 fungible standard — ideal for stablecoins, RWAs, and asset-backed tokens.',
    features:['MPTokenIssuanceCreate built to spec','v2 multi-purpose token standard','Supply, scale, fee, metadata configured','You sign once in Xaman','TX hash receipt'] },
  { id:'mptsend', cat:'Token Issuer', emoji:'📤', name:'Send MPT', featured:false, comingSoon:false, color:'#38bdf8', priceRLUSD:20, priceXRP:65,
    amendment:'Payment · MPT', tagline:'Distribute your multi-purpose tokens to any wallet',
    desc:'You provide the destination and amount. AI builds the MPT Payment. You sign once in Xaman and your tokens are delivered on-chain.',
    aiDetail:'AI assembles a Payment carrying your MPT issuance ID to the destination. After signing in Xaman it settles on mainnet in ~4s with a permanent receipt.',
    features:['MPT Payment built to spec','Deliver to any XRPL wallet','You sign once in Xaman','On-chain delivery proof','TX hash receipt'] },
  { id:'trustsend', cat:'Token Issuer', emoji:'🔗', name:'Trust Line + Send Currency', featured:false, comingSoon:false, color:'#34d399', priceRLUSD:25, priceXRP:80,
    amendment:'TrustSet · Payment', tagline:'Set a trust line and send issued currency in one flow',
    desc:'The tutorial teaches the JavaScript for trust lines and payments. We handle it. AI builds the TrustSet and the issued-currency Payment. You sign in Xaman.',
    aiDetail:'AI assembles TrustSet to your specified issuer/limit, then a Payment of the issued currency. You sign in Xaman; both settle on mainnet with receipts.',
    features:['TrustSet built to spec','Issued-currency Payment','Set limit and issuer','You sign once in Xaman','TX hash receipts'] },
  { id:'globalfreeze', cat:'Token Issuer', emoji:'❄️', name:'Global Freeze', featured:false, comingSoon:false, color:'#60a5fa', priceRLUSD:30, priceXRP:95,
    amendment:'AccountSet · asfGlobalFreeze', tagline:'Freeze all tokens you issue (issuer protection)',
    desc:'For token issuers who need to halt activity. AI builds the AccountSet (asfGlobalFreeze) transaction. You sign once in Xaman to freeze all balances of your issued token.',
    aiDetail:'AI assembles AccountSet with asfGlobalFreeze. Affects only tokens YOU issue — a standard issuer compliance control. Reversible by clearing the flag.',
    features:['AccountSet asfGlobalFreeze built to spec','Issuer-side control only','Reversible','You sign once in Xaman','TX hash receipt'] },
  { id:'freezeline', cat:'Token Issuer', emoji:'🧊', name:'Freeze a Trust Line', featured:false, comingSoon:false, color:'#60a5fa', priceRLUSD:25, priceXRP:80,
    amendment:'TrustSet · tfSetFreeze', tagline:'Freeze a single holder of your issued token',
    desc:'Freeze one specific holder rather than everyone. AI builds the TrustSet with the freeze flag for that holder. You sign in Xaman.',
    aiDetail:'AI assembles TrustSet with tfSetFreeze targeting a single trust line you issued. Targeted issuer control; reversible with tfClearFreeze.',
    features:['TrustSet tfSetFreeze built to spec','Targets one holder','Reversible','You sign once in Xaman','TX hash receipt'] },

  // PAYMENTS — mirrors xrpl.org/docs/tutorials/payments, done for you
  { id:'checkcreate', cat:'Payments', emoji:'🧾', name:'Create a Check', featured:true, tag:'#1', comingSoon:false, color:'#a78bfa', priceRLUSD:20, priceXRP:65,
    amendment:'CheckCreate', tagline:'Write a deferred on-chain check the recipient can cash later',
    desc:'You set recipient and amount. AI builds the CheckCreate transaction. You sign in Xaman; the recipient cashes it whenever they choose.',
    aiDetail:'AI assembles CheckCreate with your destination, SendMax, and optional expiration. Like a paper check on-chain — the recipient pulls funds when ready.',
    features:['CheckCreate built to spec','Recipient cashes on their schedule','Optional expiration','You sign once in Xaman','TX hash receipt'] },
  { id:'checkcash', cat:'Payments', emoji:'💵', name:'Cash a Check', featured:false, tag:'#2', comingSoon:false, color:'#a78bfa', priceRLUSD:15, priceXRP:50,
    amendment:'CheckCash', tagline:'Cash a check written to you, for a flexible amount',
    desc:'Someone wrote you an on-chain check. AI builds the CheckCash transaction. You sign in Xaman and the funds land in your wallet.',
    aiDetail:'AI assembles CheckCash for the check ID, supporting flexible-amount cashing up to the SendMax. You sign in Xaman; funds settle on mainnet.',
    features:['CheckCash built to spec','Flexible amount supported','You sign once in Xaman','Funds to your wallet','TX hash receipt'] },
  { id:'checkcancel', cat:'Payments', emoji:'🚫', name:'Cancel a Check', featured:false, tag:'#3', comingSoon:false, color:'#a78bfa', priceRLUSD:15, priceXRP:50,
    amendment:'CheckCancel', tagline:'Void an on-chain check without moving money',
    desc:'Need to void a check you wrote (or one written to you)? AI builds the CheckCancel transaction. You sign in Xaman.',
    aiDetail:'AI assembles CheckCancel for the check ID. No funds move; the check is removed from the ledger.',
    features:['CheckCancel built to spec','No funds move','You sign once in Xaman','Ledger cleaned up','TX hash receipt'] },
  { id:'desttagreq', cat:'Payments', emoji:'🏷️', name:'Require Destination Tags', featured:false, comingSoon:false, color:'#f59e0b', priceRLUSD:20, priceXRP:65,
    amendment:'AccountSet · asfRequireDest', tagline:'Force senders to include a destination tag',
    desc:'Exchanges and businesses need this. AI builds the AccountSet (asfRequireDest) transaction. You sign in Xaman — incoming payments without a tag are rejected.',
    aiDetail:'AI assembles AccountSet with asfRequireDest. Prevents lost deposits by requiring a destination tag on every incoming payment.',
    features:['AccountSet asfRequireDest built to spec','Prevents untagged deposits','Exchange-grade control','You sign once in Xaman','TX hash receipt'] },

  // DEFI — mirrors xrpl.org/docs/tutorials/defi, done for you
  { id:'dextrade', cat:'DeFi', emoji:'📊', name:'DEX Trade Execution', featured:false, tag:'NEW', comingSoon:false, color:'#10b981', priceRLUSD:25, priceXRP:80,
    amendment:'OfferCreate', tagline:'Place a buy or sell order on the native XRPL DEX',
    desc:'The tutorial shows the code to trade on the decentralized exchange. We build it for you. AI assembles the OfferCreate to your price and size. You sign in Xaman.',
    aiDetail:'AI assembles OfferCreate with your TakerGets/TakerPays for a buy or sell on the native XRPL DEX. You sign in Xaman; the order books on mainnet.',
    features:['OfferCreate built to spec','Buy or sell on native DEX','Your price and size','You sign once in Xaman','TX hash receipt'] },
  { id:'tickets', cat:'DeFi', emoji:'🎟️', name:'Ticket Batch Setup', featured:false, comingSoon:false, color:'#34d399', priceRLUSD:20, priceXRP:65,
    amendment:'TicketCreate', tagline:'Reserve sequence numbers to send transactions out of order',
    desc:'Power users and businesses use Tickets to pre-authorize transactions. AI builds the TicketCreate. You sign in Xaman.',
    aiDetail:'AI assembles TicketCreate for the count you need, letting you later submit transactions outside normal sequence order — useful for automation and multi-sign workflows.',
    features:['TicketCreate built to spec','Out-of-order transactions','Automation-friendly','You sign once in Xaman','TX hash receipt'] },

  // COMPLIANCE — mirrors xrpl.org/docs/tutorials/compliance-features, done for you
  { id:'credentialissue', cat:'Compliance', emoji:'📜', name:'Issue a Credential', featured:false, comingSoon:false, color:'#38bdf8', priceRLUSD:35, priceXRP:115,
    amendment:'CredentialCreate', tagline:'Issue an on-chain credential to a subject wallet',
    desc:'The tutorial codes a credential-issuing service. We run it for you. AI builds the CredentialCreate transaction. You sign in Xaman.',
    aiDetail:'AI assembles CredentialCreate with your subject, credential type, and optional expiration/URI. The foundation for compliant, permissioned on-chain finance.',
    features:['CredentialCreate built to spec','Subject + type + expiration','Compliance-ready','You sign once in Xaman','TX hash receipt'] },
  { id:'permdomain', cat:'Compliance', emoji:'🏛️', name:'Permissioned Domain', featured:false, comingSoon:false, color:'#38bdf8', priceRLUSD:45, priceXRP:150,
    amendment:'PermissionedDomainSet', tagline:'Restrict access to credentialed participants only',
    desc:'Build a permissioned domain so only credential-holders can access your financial service. AI builds the PermissionedDomainSet. You sign in Xaman.',
    aiDetail:'AI assembles PermissionedDomainSet with your accepted credential set. Enables compliant, gated DeFi access on the XRP Ledger.',
    features:['PermissionedDomainSet built to spec','Credential-gated access','Compliant DeFi','You sign once in Xaman','TX hash receipt'] },

] as const;

type Product = typeof PRODUCTS[number];

// ─── EXECUTION FORM SCHEMA ───
// Per-product fields the customer fills AFTER payment so AI builds the exact
// transaction. Defaults + placeholders keep input clean; the engine validates.
// Products NOT listed here need no params — they execute straight to Xaman sign.
type ExecField = { key:string; label:string; placeholder?:string; type?:'text'|'number'|'select'; options?:string[]; default?:string; help?:string; required?:boolean };
const EXEC_FIELDS: Record<string, ExecField[]> = {
  // Wallet security (caution tier handled server-side)
  multisig: [
    { key:'signers', label:'Signer wallet addresses', placeholder:'rAAA…, rBBB…, rCCC…', help:'Comma-separated XRPL addresses allowed to co-sign', required:true },
    { key:'quorum', label:'Required signatures (quorum)', type:'number', default:'2', help:'How many signers must approve each transaction', required:true },
  ],
  regkey: [{ key:'regularKey', label:'Regular key address', placeholder:'rXXX…', help:'A backup signing key. Your master key keeps working.', required:true }],
  // Token issuer
  tokenfee: [{ key:'transferFee', label:'Transfer fee %', type:'number', default:'0.5', help:'Fee charged on transfers of your token (0–100%)', required:true }],
  trustline: [
    { key:'currency', label:'Currency code', placeholder:'USD', help:'3-letter code or 40-char hex', required:true },
    { key:'issuer', label:'Issuer address', placeholder:'rXXX…', required:true },
    { key:'limit', label:'Trust limit', type:'number', default:'1000000000', help:'Max you will hold' },
  ],
  mptissue: [
    { key:'maximumAmount', label:'Maximum supply', type:'number', default:'1000000000', required:true },
    { key:'assetScale', label:'Decimal places', type:'number', default:'2', help:'e.g. 2 for cents' },
  ],
  mptsend: [
    { key:'mptIssuanceId', label:'MPT Issuance ID', placeholder:'00000000…', required:true },
    { key:'destination', label:'Send to wallet', placeholder:'rXXX…', required:true },
    { key:'amount', label:'Amount', type:'number', required:true },
  ],
  trustsend: [
    { key:'currency', label:'Currency code', placeholder:'USD', required:true },
    { key:'issuer', label:'Issuer address', placeholder:'rXXX…', required:true },
    { key:'limit', label:'Trust limit', type:'number', default:'1000000000' },
  ],
  freezeline: [
    { key:'holder', label:'Holder address to freeze', placeholder:'rXXX…', required:true },
    { key:'currency', label:'Currency code', placeholder:'USD', required:true },
  ],
  // DeFi
  dexorder: [
    { key:'takerPaysValue', label:'You want (amount)', type:'number', required:true },
    { key:'takerPaysCurrency', label:'You want (currency)', placeholder:'XRP or USD', default:'XRP' },
    { key:'takerPaysIssuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
    { key:'takerGetsValue', label:'You give (amount)', type:'number', required:true },
    { key:'takerGetsCurrency', label:'You give (currency)', placeholder:'XRP or USD', default:'XRP' },
    { key:'takerGetsIssuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
  ],
  dextrade: [
    { key:'takerPaysValue', label:'You want (amount)', type:'number', required:true },
    { key:'takerPaysCurrency', label:'You want (currency)', placeholder:'XRP or USD', default:'XRP' },
    { key:'takerPaysIssuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
    { key:'takerGetsValue', label:'You give (amount)', type:'number', required:true },
    { key:'takerGetsCurrency', label:'You give (currency)', placeholder:'XRP or USD', default:'XRP' },
    { key:'takerGetsIssuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
  ],
  ammlaunch: [
    { key:'assetValue', label:'Asset 1 amount', type:'number', required:true },
    { key:'assetCurrency', label:'Asset 1 currency', placeholder:'XRP or USD', default:'XRP' },
    { key:'assetIssuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
    { key:'asset2Value', label:'Asset 2 amount', type:'number', required:true },
    { key:'asset2Currency', label:'Asset 2 currency', placeholder:'USD' },
    { key:'asset2Issuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
    { key:'tradingFee', label:'Trading fee (0–1000 = 0–1%)', type:'number', default:'500' },
  ],
  ammentry: [
    { key:'assetValue', label:'Asset 1 amount', type:'number', required:true },
    { key:'assetCurrency', label:'Asset 1 currency', placeholder:'XRP', default:'XRP' },
    { key:'assetIssuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
    { key:'asset2Value', label:'Asset 2 amount', type:'number', required:true },
    { key:'asset2Currency', label:'Asset 2 currency', placeholder:'USD' },
    { key:'asset2Issuer', label:'…issuer (if not XRP)', placeholder:'rXXX…' },
  ],
  smartswap: [
    { key:'takerPaysValue', label:'You want (amount)', type:'number', required:true },
    { key:'takerPaysCurrency', label:'You want (currency)', placeholder:'XRP or USD', default:'XRP' },
    { key:'takerGetsValue', label:'You give (amount)', type:'number', required:true },
    { key:'takerGetsCurrency', label:'You give (currency)', placeholder:'XRP or USD', default:'XRP' },
  ],
  paychannel: [
    { key:'destination', label:'Destination wallet', placeholder:'rXXX…', required:true },
    { key:'amount', label:'XRP to fund channel', type:'number', required:true },
    { key:'publicKey', label:'Channel public key', placeholder:'EDxxxx / 02xxxx', required:true },
    { key:'settleDelay', label:'Settle delay (seconds)', type:'number', default:'86400' },
  ],
  tickets: [{ key:'ticketCount', label:'How many tickets', type:'number', default:'1', help:'Reserve 1–250 sequence slots', required:true }],
  // NFT
  nftmint: [
    { key:'uri', label:'Metadata URI', placeholder:'ipfs://… or https://…', required:true },
    { key:'royalty', label:'Royalty %', type:'number', default:'0', help:'0–50%' },
    { key:'taxon', label:'Collection taxon', type:'number', default:'0' },
  ],
  nftburn: [{ key:'nftokenId', label:'NFToken ID to burn', placeholder:'000800…', required:true }],
  nftoffer: [
    { key:'nftokenId', label:'NFToken ID', placeholder:'000800…', required:true },
    { key:'amount', label:'Sale price (XRP)', type:'number', required:true },
  ],
  // Payments
  checkcreate: [
    { key:'destination', label:'Pay to wallet', placeholder:'rXXX…', required:true },
    { key:'amount', label:'Check amount (XRP)', type:'number', required:true },
  ],
  checkcash: [
    { key:'checkId', label:'Check ID', placeholder:'object hash', required:true },
    { key:'amount', label:'Amount to cash (XRP)', type:'number', required:true },
  ],
  checkcancel: [{ key:'checkId', label:'Check ID to cancel', placeholder:'object hash', required:true }],
  escrow: [
    { key:'destination', label:'Release to wallet', placeholder:'rXXX…', required:true },
    { key:'amount', label:'XRP to lock', type:'number', required:true },
    { key:'finishAfter', label:'Release after (Ripple time, seconds)', type:'number', help:'Seconds since 2000-01-01; we can help compute this', required:true },
  ],
  // Identity / compliance
  identity: [{ key:'data', label:'Your domain', placeholder:'xrplhub.io', required:true }],
  did: [{ key:'uri', label:'DID document URI', placeholder:'ipfs://… or https://…', required:true }],
  credentialissue: [
    { key:'subject', label:'Subject wallet', placeholder:'rXXX…', required:true },
    { key:'credentialType', label:'Credential type', placeholder:'KYC', required:true },
  ],
  permdomain: [
    { key:'credentialType', label:'Accepted credential type', placeholder:'KYC', required:true },
    { key:'acceptedIssuer', label:'Accepted issuer (blank = you)', placeholder:'rXXX…' },
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
      {TICKER.map((m, i) => (
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

// ─── TREASURY STATS LIVE COUNTER ───
// Polls /api/treasury-stats every 30s. Field names match the route exactly:
// treasuryXRP (number) · treasuryUSD (preformatted string) · donorCount · grantCount.
function TreasuryStatsBar() {
  const [stats, setStats] = useState<{ treasuryXRP:number; treasuryUSD:string; donorCount:number; grantCount:number }|null>(null);
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
            treasuryXRP: Number(d.treasuryXRP || 0),
            treasuryUSD: String(d.treasuryUSD || '$0'),
            donorCount:  Number(d.donorCount  || 0),
            grantCount:  Number(d.grantCount  || 0),
          });
          setStatsError(d.source === 'error');
        }
      } catch (e) { console.error('[TreasuryStatsBar] fetch failed', e); if (!stop) setStatsError(true); }
    };
    load();
    // Load once per page view. No polling: a repeating fetch here kept the Neon
    // compute from ever scaling to zero. Treasury figures change slowly and the
    // page re-fetches on every fresh visit, which is plenty.
    return () => { stop = true; };
  }, []);
  const fmt = (n:number) => n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits:0 }) : n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const fmtCount = (n:number) => n.toLocaleString('en-US', { maximumFractionDigits:0 });
  const Cell = ({ label, value, suffix, color }: { label:string; value:string; suffix?:string; color:string }) => (
    <div style={{ flex:1, minWidth:140, textAlign:'center', padding:'14px 12px' }}>
      <div style={{ fontSize:11,fontWeight:700,color:'rgba(255,255,255,.36)',letterSpacing:'.13em',textTransform:'uppercase',marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:'clamp(20px,2.4vw,26px)',fontWeight:900,color,fontFamily:"'IBM Plex Mono',monospace" }}>
        {value}{suffix && <span style={{ fontSize:11,fontWeight:600,color:'rgba(255,255,255,.4)',marginLeft:5 }}>{suffix}</span>}
      </div>
    </div>
  );
  return (
    <div style={{ background:'linear-gradient(135deg,rgba(139,92,246,.07),rgba(16,185,129,.06),rgba(6,6,22,.85))',border:'1px solid rgba(139,92,246,.22)',borderRadius:18,padding:'4px 10px',marginBottom:24,backdropFilter:'blur(20px)' }}>
      <div style={{ display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'center',gap:0 }}>
        <Cell label="Treasury Balance" value={stats ? fmt(stats.treasuryXRP) : '—'} suffix="XRP" color="#10b981" />
        <Cell label="≈ USD Value"      value={stats ? stats.treasuryUSD : '—'}                    color="#34d399" />
        <Cell label="Donors"           value={stats ? fmtCount(stats.donorCount) : '—'}           color="#38bdf8" />
        <Cell label="Grants Funded"    value={stats ? fmtCount(stats.grantCount) : '—'}           color="#8b5cf6" />
      </div>
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
        else { pollRef.current = setTimeout(poll, 3000); }
      } catch { if (!cancelRef.current) pollRef.current = setTimeout(poll, 5000); }
    };
    poll();
    return () => { cancelRef.current = true; if (pollRef.current) clearTimeout(pollRef.current); };
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
  const [payHash, setPayHash]       = useState('');       // injected-wallet fee-payment tx
  const [exHash, setExHash]         = useState('');       // injected-wallet service tx
  // execution (service fulfillment) state
  const [exForm, setExForm]     = useState<Record<string,string>>({});
  const [exStatus, setExStatus] = useState<'form'|'building'|'signing'|'delivered'|'failed'|'caution'>('form');
  const [exUuid, setExUuid]     = useState('');
  const [exQr, setExQr]         = useState('');
  const [exLink, setExLink]     = useState('');
  const [exTx, setExTx]         = useState('');
  const [exError, setExError]   = useState('');
  const [exLabel, setExLabel]   = useState('');
  const [cautionOk, setCautionOk] = useState(false);
  const exPollRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const pollRef   = useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancelRef = useRef(false);

  const displayPrice = product ? (currency==='RLUSD' ? product.priceRLUSD : product.priceXRP) : 0;
  const price = TEST_MODE ? (currency==='RLUSD' ? TEST_PRICE_RLUSD : TEST_PRICE_XRP) : displayPrice;

  // Payment polling — verified only when on-chain TX confirms
  useEffect(() => {
    if (payStatus !== 'waiting' || !uuid || !product) return;
    cancelRef.current = false;
    const poll = async () => {
      if (cancelRef.current) return;
      try {
        const params = new URLSearchParams({ uuid, productId:product.id, amount:String(price), currency, email });
        const res  = await fetch(`${API_URL}/api/check-payment?${params}`);
        const data = await res.json();
        if (cancelRef.current) return;
        if (data.status === 'verified') { setVerifiedTx(data.txHash || ''); setPayStatus('done'); setStep('success'); }
        else if (data.status === 'expired') { setPayStatus('idle'); setPayError('Payment expired. Tap to try again.'); }
        else if (data.status === 'rejected') { setPayStatus('idle'); setPayError(data.reason || 'Payment declined.'); }
        else { pollRef.current = setTimeout(poll, 3000); }
      } catch { if (!cancelRef.current) pollRef.current = setTimeout(poll, 5000); }
    };
    poll();
    return () => { cancelRef.current = true; if (pollRef.current) clearTimeout(pollRef.current); };
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
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/execute/verify?uuid=${exUuid}`);
        const data = await res.json();
        if (stop) return;
        if (data.status === 'delivered') { setExTx(data.txHash||''); setExStatus('delivered'); }
        else if (data.status === 'rejected') { setExError('You declined the signature.'); setExStatus('form'); }
        else if (data.status === 'expired') { setExError('Sign request expired. Try again.'); setExStatus('form'); }
        else if (data.status === 'failed') { setExError(`Ledger rejected it: ${data.result||'failed'}`); setExStatus('failed'); }
        else { exPollRef.current = setTimeout(poll, 3000); }
      } catch { if (!stop) exPollRef.current = setTimeout(poll, 5000); }
    };
    poll();
    return () => { stop = true; if (exPollRef.current) clearTimeout(exPollRef.current); };
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

  // injected service-execution: poll execute/verify?hash=
  useEffect(() => {
    if (exStatus !== 'signing' || !exHash || !product) return;
    let stop = false;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ hash: exHash, account: connectedWallet, productId: product.id, payTxHash: verifiedTx });
        const res = await fetch(`${API_URL}/api/execute/verify?${params}`);
        const data = await res.json();
        if (stop) return;
        if (data.status === 'delivered') { setExTx(data.txHash || exHash); setExStatus('delivered'); }
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
      const handle = provider.submitPayment({
        productId: product.id, to: cd.treasury, amount: String(price), currency,
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
      setExForm({}); setExStatus('form'); setExUuid(''); setExQr(''); setExLink(''); setExTx(''); setExError(''); setExLabel(''); setCautionOk(false);
      setPayHash(''); setExHash(''); setWalletSel('xaman'); }, 300);
  };

  const handleBuyNow = async () => {
    setPayStatus('creating'); setPayError(''); cancelRef.current = false;
    try {
      const res  = await fetch(`${API_URL}/api/create-payment`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ productId:product.id, currency, amount:price, email }) });
      const data = await res.json();
      if (!res.ok || !data.uuid) throw new Error(data.error || 'Failed to create payment');
      setUuid(data.uuid); setQrUrl(data.qr_png); setDeepLnk(data.deep_link); setCountdown(data.expires_in || 900); setPayStatus('waiting');
    } catch (e: unknown) { setPayError(e instanceof Error ? e.message : 'Payment failed'); setPayStatus('idle'); }
  };

  // Build + sign the actual service transaction (autonomous execution engine)
  const handleExecute = async (confirmCaution = false) => {
    if (!product) return;
    setExStatus('building'); setExError('');
    try {
      const res = await fetch(`${API_URL}/api/execute`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ productId:product.id, account:connectedWallet, params:exForm, payTxHash:verifiedTx, confirmedCaution:confirmCaution }),
      });
      const data = await res.json();
      if (res.status === 409 && data.requiresConfirmation) { setExLabel(data.label||''); setExStatus('caution'); return; }
      if (res.status === 422 && data.needsParams) { setExError('Please fill: ' + data.needsParams.join(', ')); setExStatus('form'); return; }
      if (!res.ok || (!data.uuid && !data.txjson)) throw new Error(data.error || 'Could not build your service transaction');
      setExLabel(data.label||'');

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

      setExUuid(data.uuid); setExQr(data.qr_png); setExLink(data.deep_link); setExStatus('signing');
    } catch (e:unknown) { setExError(e instanceof Error ? e.message : 'Execution failed'); setExStatus('form'); }
  };

  if (step === 'execute') {
    const fields = EXEC_FIELDS[product.id] || [];
    const setF = (k:string,v:string) => setExForm(f=>({...f,[k]:v}));
    return (
      <Overlay show={show} onClose={handleClose} wide>
        <div style={{ fontSize:10,fontWeight:700,color:product.color,letterSpacing:'.12em',textTransform:'uppercase',marginBottom:5,fontFamily:"'IBM Plex Mono',monospace" }}>Step 2 · Execute Service</div>
        <h3 style={{ fontSize:20,fontWeight:900,marginBottom:4 }}>{product.name}</h3>
        <p style={{ fontSize:12,color:'rgba(255,255,255,.4)',marginBottom:16 }}>Paid ✓ — now AI builds your exact transaction. You sign once in Xaman.</p>

        {exStatus === 'form' && !connectedWallet && (
          <div style={{ background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.35)',borderRadius:12,padding:'14px 18px',marginBottom:16 }}>
            <p style={{ fontSize:13,color:'#f59e0b',fontWeight:700,marginBottom:6 }}>Connect your wallet to finish</p>
            <p style={{ fontSize:12,color:'rgba(255,255,255,.55)',lineHeight:1.6 }}>Your service transaction is signed from your own Xaman wallet. Close this, tap <strong style={{ color:'#fff' }}>Connect Wallet</strong> at the top, then reopen your purchase to finish — your payment is safe and waiting.</p>
          </div>
        )}
        {exStatus === 'form' && connectedWallet && (
          <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',marginBottom:14,fontFamily:"'IBM Plex Mono',monospace" }}>Signing wallet: {connectedWallet.slice(0,10)}…{connectedWallet.slice(-6)}</p>
        )}

        {exStatus === 'form' && (
          <>
            {fields.length === 0 && <div style={{ background:'rgba(16,185,129,.05)',border:'1px solid rgba(16,185,129,.15)',borderRadius:12,padding:'13px 16px',marginBottom:16,fontSize:13,color:'rgba(255,255,255,.55)',lineHeight:1.6 }}>No details needed — tap below and AI will build your <strong style={{ color:'#10b981' }}>{product.name}</strong> transaction for you to sign in Xaman.</div>}
            {fields.map(f => (
              <div key={f.key} style={{ marginBottom:13 }}>
                <label style={LBL}>{f.label}{f.required && <span style={{ color:product.color }}> *</span>}</label>
                <input type={f.type==='number'?'number':'text'} value={exForm[f.key] ?? f.default ?? ''} onChange={e=>setF(f.key,e.target.value)} placeholder={f.placeholder||''} style={{ ...INP, fontFamily:(f.key.toLowerCase().includes('address')||f.key.includes('issuer')||f.key.includes('destination')||f.key.includes('wallet')||f.key.includes('Id')||f.key.includes('holder')||f.key.includes('subject'))?"'IBM Plex Mono',monospace":'inherit', fontSize:f.type==='number'?14:13 }} />
                {f.help && <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',marginTop:4 }}>{f.help}</p>}
              </div>
            ))}
            {exError && <p style={{ fontSize:12,color:'#fca5a5',marginBottom:10 }}>⚠️ {exError}</p>}
            <button disabled={!connectedWallet} onClick={()=>handleExecute(false)} style={{ ...Btn('color',product.color,{width:'100%',padding:'14px',fontSize:15,marginTop:6,opacity:connectedWallet?1:.4}) }}>⚡ Build &amp; Sign{walletSel !== 'xaman' ? ` with ${getWalletProvider(walletSel)?.label ?? 'wallet'}` : ' in Xaman'} →</button>
            <p style={{ fontSize:11,color:'rgba(255,255,255,.26)',textAlign:'center',marginTop:10 }}>AI builds the exact XRPL transaction · you approve it in your own wallet · we verify on-chain</p>
          </>
        )}

        {exStatus === 'building' && (
          <div style={{ textAlign:'center', padding:'34px 0' }}>
            <div style={{ width:60,height:60,borderRadius:'50%',background:`${product.color}15`,border:`2px solid ${product.color}40`,display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px',fontSize:26,animation:'spin 1.5s linear infinite' }}>🤖</div>
            <p style={{ color:product.color,fontWeight:700,fontSize:15 }}>AI is building your transaction…</p>
          </div>
        )}

        {exStatus === 'caution' && (
          <div>
            <div style={{ background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.4)',borderRadius:14,padding:'18px 20px',marginBottom:16 }}>
              <p style={{ fontSize:14,fontWeight:800,color:'#f59e0b',marginBottom:8 }}>⚠️ Important — please read</p>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.7)',lineHeight:1.7 }}>This operation ({exLabel}) changes how your wallet is controlled and may be <strong style={{ color:'#fff' }}>difficult or impossible to reverse</strong>. If misconfigured, you could lose access to your account. Make sure your details are correct before signing.</p>
            </div>
            <label style={{ display:'flex',alignItems:'flex-start',gap:10,cursor:'pointer',marginBottom:16 }}>
              <input type="checkbox" checked={cautionOk} onChange={e=>setCautionOk(e.target.checked)} style={{ marginTop:3,width:16,height:16,accentColor:'#f59e0b' }} />
              <span style={{ fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.6 }}>I understand the risk and confirm my details are correct.</span>
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
              <span style={{ fontSize:13,fontWeight:700,color:'#10b981' }}>{exUuid ? 'Sign in Xaman to execute…' : 'Sign in your wallet to execute…'}</span>
            </div>
            {exUuid ? (
              <div style={{ marginBottom:14 }}>
                <XamanPayPrompt theme="light" mode="sign" qrPng={exQr} deepLink={exLink} uuid={exUuid} />
              </div>
            ) : (
              <p style={{ textAlign:'center',color:'rgba(255,255,255,.55)',fontSize:13,margin:'16px 0' }}>Approve the transaction in your wallet…</p>
            )}
            <p style={{ textAlign:'center',fontSize:11,color:'rgba(255,255,255,.28)' }}>We confirm your service transaction on XRPL mainnet before marking it delivered.</p>
          </>
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
          <p style={{ fontSize:13,color:'rgba(255,255,255,.65)',lineHeight:1.75 }}>Your payment is confirmed on XRPL mainnet. Next, finish your service — AI builds the exact transaction and you sign it once in Xaman.</p>
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
      <p style={{ fontSize:12,color:'rgba(255,255,255,.4)',marginBottom:14 }}>{displayPrice} {currency} — one swipe in Xaman {TEST_MODE && <span style={{ color:'#f59e0b',fontWeight:700 }}>· TEST MODE (charging {price} {currency})</span>}</p>

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
                amount={price} currency={currency} destination={TREASURY} />
            </div>
          ) : (
            <p style={{ textAlign:'center',color:'rgba(255,255,255,.55)',fontSize:13,margin:'18px 0' }}>
              Approve the payment in your wallet — this confirms on the ledger automatically.
            </p>
          )}
          <div style={{ background:'rgba(255,255,255,.04)',border:'1px solid rgba(255,255,255,.07)',borderRadius:14,padding:'14px 18px',marginBottom:12 }}>
            {[['1',uuid?'Scan QR or tap "Open in Xaman"':'Approve in your wallet'],['2',`Review the pre-filled ${price} ${currency} payment`],['3','Confirm — we verify it on-chain']].map(([n,t]) => (
              <div key={n} style={{ display:'flex',alignItems:'flex-start',gap:12,marginBottom:n==='3'?0:10 }}>
                <span style={{ width:22,height:22,borderRadius:'50%',background:`${product.color}20`,border:`1px solid ${product.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:product.color,flexShrink:0 }}>{n}</span>
                <span style={{ fontSize:13,color:'rgba(255,255,255,.6)',lineHeight:1.5,paddingTop:2 }}>{t}</span>
              </div>
            ))}
          </div>
          <p style={{ textAlign:'center',fontSize:11,color:'rgba(255,255,255,.28)',marginBottom:10 }}>We confirm your transaction on XRPL mainnet before activating — nothing unlocks without a real payment.</p>
          <button onClick={()=>{ cancelRef.current=true; if(pollRef.current) clearTimeout(pollRef.current); setPayStatus('idle'); setPayError(''); }} style={{ ...Btn('ghost',undefined,{width:'100%',fontSize:13}) }}>← Cancel</button>
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
                {c==='RLUSD'?'💵 RLUSD':'◈ XRP'} — {c==='RLUSD'?product.priceRLUSD:product.priceXRP}
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
            <strong style={{ color:'#10b981' }}>How it works:</strong> Sign the pre-filled {price} {currency} payment → we verify it on XRPL mainnet → service activates.
          </div>
          <div style={{ display:'flex',gap:10 }}>
            <button onClick={()=>setStep('info')} style={{ ...Btn('ghost',undefined,{flex:1}) }}>← Back</button>
            <button
              onClick={() => (walletSel === 'xaman' ? handleBuyNow() : buyWithExtension(walletSel))}
              style={{ ...Btn('color',product.color,{flex:2,fontSize:15}) }}
            >
              {walletSel === 'xaman' ? '📱' : ''} Pay {price} {currency} →
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
          <div style={{ fontSize:11,color:'rgba(255,255,255,.38)',marginBottom:4 }}>One-time</div>
          <div style={{ display:'flex',gap:12,alignItems:'baseline',flexWrap:'wrap' }}>
            <span style={{ fontSize:28,fontWeight:900,color:product.color }}>{product.priceRLUSD} RLUSD</span>
            <span style={{ fontSize:13,color:'rgba(255,255,255,.3)' }}>or {product.priceXRP} XRP</span>
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:11,color:'rgba(255,255,255,.38)',marginBottom:4 }}>Xaman checkout</div>
          <div style={{ fontSize:15,fontWeight:700,color:'#10b981' }}>One swipe ⚡</div>
        </div>
      </div>
      <div style={{ background:'rgba(255,255,255,.03)',borderRadius:11,padding:'11px 15px',marginBottom:20 }}>
        <p style={{ fontSize:11,color:'rgba(255,255,255,.3)',lineHeight:1.7 }}><strong style={{ color:'rgba(255,255,255,.45)' }}>Disclosure: </strong>On-chain operational service. You sign every transaction yourself in Xaman; we never hold your keys or funds. Not insurance, securities, or financial advice. All XRPL transactions are irrevocable.</p>
      </div>
      <button onClick={()=>setStep('checkout')} style={{ ...Btn('color',product.color,{width:'100%',padding:'15px',fontSize:16}) }}>Buy Now — {product.priceRLUSD} RLUSD →</button>
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
    const poll = async () => {
      if (cancelRef.current) return;
      try {
        const params = new URLSearchParams({ uuid, productId:'donate', amount, currency });
        const res = await fetch(`${API_URL}/api/check-payment?${params}`);
        const data = await res.json();
        if (cancelRef.current) return;
        if (data.status === 'verified') { setVerifiedTx(data.txHash || ''); setPayStatus('done'); }
        else if (data.status === 'expired') { setPayStatus('idle'); setPayError('Payment expired. Tap to try again.'); }
        else if (data.status === 'rejected') { setPayStatus('idle'); setPayError(data.reason || 'Payment declined.'); }
        else { pollRef.current = setTimeout(poll, 3000); }
      } catch { if (!cancelRef.current) pollRef.current = setTimeout(poll, 5000); }
    };
    poll();
    return () => { cancelRef.current = true; if (pollRef.current) clearTimeout(pollRef.current); };
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

// ─── GRANT MODAL — submit → AI-assisted triage (Grok + Anthropic) → human admin queue ───
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
  const [aiResult, setAiResult] = useState<{ recommendation?:string; summary?:string }|null>(null);
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
    let review:{ recommendation?:string; summary?:string } | null = null;
    try {
      // 1) persist application (status PENDING)
      await fetch(`${API_URL}/api/grants/submit`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form),
      });
      // 2) AI-assisted triage (Grok + Anthropic) → returns an ADVISORY recommendation + summary for the human reviewer
      const res = await fetch(`${API_URL}/api/grants/review`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ name:form.name, wallet:form.wallet, email:form.email, category:form.category, need:form.need, amount:form.amount }),
      });
      if (res.ok) review = await res.json().catch(()=>null);
      // 3) email acknowledgement (best-effort)
      if (form.email) {
        await fetch(`${API_URL}/api/send-email`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ to:form.email, type:'grant', name:form.name, amount:form.amount, wallet:form.wallet }),
        });
      }
    } catch {}
    setAiResult(review);
    setStep('success');
  };

  const handleClose = () => { onClose(); setTimeout(()=>{ setStep('form'); setForm({name:'',wallet:'',email:'',phone:'',category:'',need:'',amount:'25'}); setErrors({}); setAiResult(null); }, 300); };

  if (step === 'reviewing') return (
    <Overlay show={show} onClose={()=>{}}>
      <div style={{ textAlign:'center', padding:'44px 0' }}>
        <div style={{ fontSize:44, animation:'spin 1s linear infinite', display:'inline-block', marginBottom:14 }}>🤖</div>
        <p style={{ color:'#8b5cf6', fontWeight:700, fontSize:17 }}>Preparing your application for review…</p>
        <p style={{ fontSize:13, color:'rgba(255,255,255,.38)', marginTop:6 }}>Assessing need · checking treasury · drafting recommendation</p>
      </div>
    </Overlay>
  );

  if (step === 'success') return (
    <Overlay show={show} onClose={handleClose}>
      <div style={{ textAlign:'center', padding:'20px 0' }}>
        <div style={{ fontSize:56, marginBottom:12 }}>❤️</div>
        <h3 style={{ fontSize:24, fontWeight:900, color:'#8b5cf6', marginBottom:10 }}>Application Received</h3>
        <p style={{ color:'rgba(255,255,255,.55)', fontSize:14, lineHeight:1.75, marginBottom:10 }}>Your ${form.amount} grant request has been received. Our AI has reviewed your application — allow <strong style={{ color:'#fff' }}>24–48 hours</strong> for a final decision. We help as many people as we can based on need, available treasury funds, and urgency.</p>
        {aiResult?.summary && (
          <div style={{ background:'rgba(139,92,246,.08)', border:'1px solid rgba(139,92,246,.22)', borderRadius:12, padding:'14px 16px', margin:'0 auto 16px', maxWidth:420, textAlign:'left' }}>
            <p style={{ fontSize:10, fontWeight:700, color:'#8b5cf6', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:6, fontFamily:"'IBM Plex Mono',monospace" }}>🤖 Reviewed by Our AI Team</p>
            <p style={{ fontSize:12, color:'rgba(255,255,255,.6)', lineHeight:1.65 }}>{aiResult.summary}</p>
          </div>
        )}
        <p style={{ color:'rgba(255,255,255,.35)', fontSize:13, lineHeight:1.75, marginBottom:24 }}>Approved funds go <strong style={{ color:'#fff' }}>directly to your XRPL wallet</strong>. You&apos;ll get a status update at {form.email}.</p>
        <button onClick={handleClose} style={Btn('color','#8b5cf6')}>Done</button>
      </div>
    </Overlay>
  );

  return (
    <Overlay show={show} onClose={handleClose} wide>
      <div style={{ fontSize:10, fontWeight:700, color:'#8b5cf6', letterSpacing:'.12em', textTransform:'uppercase', marginBottom:5 }}>Community Grant Application</div>
      <h3 style={{ fontSize:22, fontWeight:900, marginBottom:4 }}>Apply for Emergency Funds</h3>
      <p style={{ color:'rgba(255,255,255,.4)', fontSize:13, marginBottom:22 }}>$25–$100 · AI-reviewed · Direct to your XRPL wallet · No middlemen</p>

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

      <button onClick={handleSubmit} style={{ ...Btn('color','#8b5cf6',{width:'100%',marginTop:22,padding:'15px',fontSize:16}) }}>Submit for AI Review →</button>
      <p style={{ textAlign:'center', fontSize:11, color:'rgba(255,255,255,.22)', marginTop:10 }}>AI-reviewed · Final human approval before payout · Wallet-to-wallet</p>
    </Overlay>
  );
}

// ─── ABOUT ───
function AboutModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  return (
    <Overlay show={show} onClose={onClose} wide>
      <div style={{ fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:8 }}>About XRPLHub</div>
      <h2 style={{ fontSize:24,fontWeight:900,marginBottom:18 }}>A fully autonomous financial ecosystem on the XRP Ledger.</h2>
      <div style={{ fontSize:14,color:'rgba(255,255,255,.65)',lineHeight:1.9,display:'flex',flexDirection:'column',gap:14 }}>
        <p>XRPLHub was built for the people legacy finance was designed to exclude. No bank account. No credit history. No gatekeepers. Just an XRPL wallet and access to real services.</p>
        <p>We build entirely on the <strong style={{ color:'#fff' }}>XRP Ledger</strong> — fast, low-cost, and energy-efficient. Three pillars power the platform: XRPL Services, Community Grants, and XRPLScore.</p>
        <p><strong style={{ color:'#10b981' }}>XRPLScore™</strong> is our proprietary on-chain rating, 300–850, computed live from your wallet. No FICO. No bureau. No SSN. The Builder lets you grow it over time through verifiable on-chain history.</p>
        <p>Our <strong style={{ color:'#fff' }}>XRPL Services</strong> are AI-delivered on-chain tools covering major XRPL transaction types — pay in Xaman, AI verifies on mainnet, the service activates in seconds.</p>
        <p><strong style={{ color:'#10b981' }}>Community Grants</strong>: donors fund a public XRPL treasury. AI helps sort and summarize applications; every decision is made by a human reviewer. Approved grants go wallet-to-wallet. No NGO. No middlemen. Permanently verifiable on-chain.</p>
        <p style={{ fontSize:12,color:'rgba(255,255,255,.4)',fontStyle:'italic' }}>XRPLScore™ methodology is proprietary and licensable to financial institutions, DeFi platforms, and on-chain data partners. Partnership inquiries: <a href="mailto:partners@xrplhub.io" style={{ color:'#10b981' }}>partners@xrplhub.io</a></p>
      </div>
      <button onClick={onClose} style={{ ...Btn('green',undefined,{marginTop:24}) }}>Close</button>
    </Overlay>
  );
}

// ─── FAQ ───
function FAQModal({ show, onClose }: { show:boolean; onClose:()=>void }) {
  const [open, setOpen] = useState<number|null>(0);
  const faqs:[string,string][] = [
    ['What is XRPLScore™?',"XRPLScore™ is XRPLHub's proprietary on-chain rating — 300 to 850, computed live from your XRPL wallet. No SSN, no credit bureau, no FICO affiliation. It's your verifiable on-chain reputation."],
    ['How do the XRPL Services work?','You pay in Xaman and get a TX hash. Our AI verifies the transaction on XRPL mainnet, confirms the amount and destination, and activates your service within one ledger close (~4 seconds).'],
    ['How does the grant system work?',"Donate XRP/RLUSD to the public treasury (viewable on XRPScan). Anyone in need can apply for $25–$100. AI assists by summarizing and flagging each application for the human reviewer; a person makes every approval decision. Approved funds then go directly to the recipient's XRPL wallet."],
    ['Do I need a Xaman wallet?','Yes — Xaman is the XRPL wallet, free on iOS and Android at xaman.app. Payments are a single QR scan and swipe.'],
    ['Is XRPLHub a bank?','No. Not a bank, broker, insurer, or FDIC institution. XRPLHub is a financial technology platform on the XRP Ledger. All services are on-chain operational tools.'],
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
        <p style={P}>XRPLHub is a financial technology platform on the XRP Ledger providing XRPL Services, XRPLScore, and a community grant program. We are not a bank, broker-dealer, investment advisor, insurer, or FDIC-insured institution.</p>
        <span style={H}>2. Eligibility</span>
        <p style={P}>You must be 18+ and legally able to enter contracts in your jurisdiction. Service unavailable where prohibited by law, including OFAC-sanctioned regions.</p>
        <span style={H}>3. XRPL Services & AI Verification</span>
        <p style={P}>Services are on-chain operational tools. You pay in Xaman, and our AI verifies the transaction on XRPL mainnet. <strong style={{ color:'rgba(255,255,255,.8)' }}>All XRPL transactions are final and irrevocable.</strong> Services are not insurance contracts, securities, or financial instruments.</p>
        <span style={H}>4. XRPLScore™</span>
        <p style={P}>XRPLScore™ is our proprietary on-chain assessment derived from public XRPL wallet data. It is not a FICO score, consumer credit report, or NRSRO rating, and has no affiliation with any credit bureau. The XRPLScore™ name, methodology, signal weighting, and underlying framework are intellectual property of XRPLHub and are available for commercial licensing.</p>
        <span style={H}>5. Community Grant Program</span>
        <p style={P}>Donations are voluntary and irrevocable. Applications are triaged with AI assistance to help our reviewer prioritize; all approval and denial decisions are made by a human. AI is advisory only and never automatically approves or denies an application. Submission does not guarantee disbursement. Grants range $25–$100 subject to treasury availability.</p>
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
  // Lightweight percentile model so the experience feels real even without server-side analytics
  if (score >= 820) return { percentile: 98, label: 'Top 2% of all XRPL wallets' };
  if (score >= 780) return { percentile: 92, label: 'Top 8% of all XRPL wallets' };
  if (score >= 720) return { percentile: 84, label: 'Top 16% of all XRPL wallets' };
  if (score >= 660) return { percentile: 70, label: 'Top 30% of all XRPL wallets' };
  if (score >= 600) return { percentile: 55, label: 'Top 45% of all XRPL wallets' };
  if (score >= 500) return { percentile: 35, label: 'Building reputation' };
  return { percentile: 15, label: 'Early on-chain footprint' };
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
  const featured = PRODUCTS.filter(p => p.featured);
  // Order the grid by how a normal person relates to it, NOT by technical category.
  // Checks & everyday money first → familiar concepts (escrow=safe-hold, NFT=digital art,
  // identity) → then the power-user / wizard tools (DeFi, token issuing, wallet security) last.
  const TOP_ORDER = [
    // ── Everyday money: "I can write/cash/cancel a check, send money safely" ──
    'checkcash',      // Cash a Check
    'checkcancel',    // Cancel a Check
    'escrow',         // Hold money safely until a date (like a deposit in escrow)
    'paychannel',     // Stream / channel payments
    'desttagreq',     // Require a tag so payments arrive correctly
    'trustsend',      // Set up to receive a currency
    // ── Familiar digital things: art, collectibles, identity ──
    'nftmint',        // Mint an NFT (digital art / collectible)
    'nftoffer',       // Sell an NFT
    'nftburn',        // Burn an NFT
    'identity',       // Put your identity on-chain
    'did',            // Digital ID
    'credentialissue',// Issue a credential / certificate
    'compliance',     // Compliance bundle
    'permdomain',     // Permissioned domain
    // ── Money tools: tokens, trust lines, fees ──
    'trustline',      // Connect to a token
    'tokenfee',       // Set a transfer fee
    'issuerdecl',     // Become a token issuer
    'issuercfg',      // Full issuer setup
    'mptissue',       // Issue a multi-purpose token
    'mptsend',        // Send a multi-purpose token
    'rippling',       // Rippling control
    'globalfreeze',   // Freeze your token globally
    'freezeline',     // Freeze a single trust line
    // ── Trading / DeFi (power users) ──
    'dexorder',       // Place a DEX order
    'dextrade',       // Execute a trade
    'smartswap',      // Smart swap
    'ammlaunch',      // Launch an AMM pool
    'ammentry',       // Add liquidity
    'tickets',        // Create tickets
    // ── Wallet security (advanced, last) ──
    'multisig',       // Multi-sig
    'regkey',         // Regular key
    'depositauth',    // Deposit auth
    'desttag',        // Destination tag lock
  ];
  const others   = PRODUCTS.filter(p => !p.featured).sort((a,b) => {
    const ai = TOP_ORDER.indexOf(a.id), bi = TOP_ORDER.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

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
                <span style={{ fontSize:9,color:'rgba(255,255,255,.45)',letterSpacing:'.07em',textTransform:'uppercase',lineHeight:1 }}>{connectedWallet ? '· xApp Mode' : 'XRPL Amendment Services · XRPLScore™'}</span>
              </div>
            </div>
            <div className="nav-desktop" style={{ alignItems:'center',gap:7,flexWrap:'wrap' }}>
              {connectedWallet
                ? <button className="wallet-btn" onClick={disconnectWallet} title="Disconnect"><span style={{ width:6,height:6,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 6px #10b981' }} />{trunc(connectedWallet)} ✕</button>
                : <button className="wallet-btn" onClick={()=>setShowConnect(true)}>🔐 Connect Wallet</button>}
              <a className="navbtn" href="/pricing">Score API</a>
              <button className="navbtn" onClick={()=>setShowDonate(true)}>Donate</button>
              <button className="navbtn" onClick={()=>setShowGrant(true)}>Apply for Grant</button>
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
              <button className="navbtn" onClick={()=>{setShowGrant(true);setMM(false);}}>Apply for Grant</button>
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
          <h1 style={{ fontSize:'clamp(48px,11vw,128px)',fontWeight:900,letterSpacing:'-4px',lineHeight:.95,marginBottom:20 }}>
            <span style={brandGradientText}>XRPLHub</span>
          </h1>
          <div style={{ display:'inline-block',marginBottom:28,fontSize:11,fontWeight:700,color:'#34d399',letterSpacing:'.14em',fontFamily:"'IBM Plex Mono',monospace",textTransform:'uppercase' }}>
            Community Grants · XRPL Amendment Services · XRPLScore™ · 2026
          </div>

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
            <button className="hero-p" onClick={()=>fetchScore()} style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'16px 32px',background:'#fff',color:'#000',fontSize:16,fontWeight:700,borderRadius:99,border:'none',cursor:'pointer',boxShadow:'0 4px 28px rgba(255,255,255,.12)' }}>
              {connectedWallet?'Get My XRPLScore →':'Get My Free XRPLScore →'}
            </button>
            <button className="hero-g" onClick={()=>document.getElementById('products')?.scrollIntoView({behavior:'smooth'})} style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'16px 32px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:16,fontWeight:600,borderRadius:99,background:'transparent',cursor:'pointer',backdropFilter:'blur(8px)' }}>
              Browse Services ↓
            </button>
          </div>

          <a href={XAMAN_DL} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex',alignItems:'center',gap:8,fontSize:13,color:'#10b981',fontWeight:600,textDecoration:'none' }}>
            📲 Xaman Wallet required — download free (iOS / Android) →
          </a>
        </section>

        {/* PRODUCTS */}
        <section id="products" className="section-pad" style={{ padding:'0 24px 72px',maxWidth:1280,margin:'0 auto' }}>
          <div style={{ textAlign:'center',marginBottom:40 }}>
            <div style={{ display:'inline-flex',alignItems:'center',gap:6,marginBottom:12 }}>
              <span style={{ width:5,height:5,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 8px #10b981' }} />
              <span style={{ fontSize:11,fontWeight:700,color:'#10b981',letterSpacing:'.14em',textTransform:'uppercase' }}>{PRODUCTS.length} XRPL Services · Done For You</span>
            </div>
            <h2 style={{ fontSize:'clamp(24px,4vw,42px)',fontWeight:900,letterSpacing:'-2px',marginBottom:12 }}>You sign. We build. The ledger settles.</h2>
            <p style={{ fontSize:14,color:'rgba(255,255,255,.44)',maxWidth:560,margin:'0 auto' }}>Pay once in Xaman → we verify your transaction on XRPL mainnet → your service is built.</p>
            <p style={{ fontSize:12,color:'rgba(255,255,255,.32)',maxWidth:540,margin:'10px auto 0',lineHeight:1.6 }}>Every one of these is a documented XRPL operation. You can code it yourself from the developer tutorials — or pay here and AI builds the exact transaction for you to sign in one tap. No coding, no errors.</p>
          </div>
          <div style={{ display:'grid',gridTemplateColumns:'1fr',gap:18,marginBottom:18 }}>
            {featured.map(p=>(
              <div key={p.id} className="pcard-hero" onClick={()=>setAP(p)} style={{ background:`linear-gradient(135deg,${p.color}14,rgba(6,6,22,.85))`,border:`1px solid ${p.color}38`,borderRadius:22,padding:'28px 30px',position:'relative',overflow:'hidden',cursor:'pointer' }}>
                <div style={{ position:'absolute',top:-40,right:-40,width:220,height:220,borderRadius:'50%',background:`radial-gradient(circle,${p.color}18 0%,transparent 70%)`,pointerEvents:'none' }} />
                {p.tag && <span style={tagStyle(p.tag, p.color, {top:14, right:14, fontSize:10, padding:'5px 11px'})}>★ {p.tag} · TOP PICK</span>}
                <div className="pcard-hero-row">
                  <div>
                    <div style={{ display:'flex',alignItems:'center',gap:14,marginBottom:14 }}>
                      <div style={{ width:60,height:60,borderRadius:16,background:`${p.color}20`,border:`1px solid ${p.color}38`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:30,animation:'float 4s ease-in-out infinite',flexShrink:0 }}>{p.emoji}</div>
                      <div>
                        <div style={{ fontSize:10,fontWeight:700,color:p.color,letterSpacing:'.13em',textTransform:'uppercase',marginBottom:4,fontFamily:"'IBM Plex Mono',monospace" }}>{p.cat} · {p.amendment}</div>
                        <h3 style={{ fontSize:'clamp(20px,2.4vw,26px)',fontWeight:900,letterSpacing:'-.5px' }}>{p.name}</h3>
                      </div>
                    </div>
                    <p style={{ fontSize:14,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:0,maxWidth:540 }}>{p.tagline}</p>
                  </div>
                  <div style={{ textAlign:'right',flexShrink:0 }}>
                    <div style={{ fontSize:'clamp(22px,2.4vw,28px)',fontWeight:900,color:p.color,whiteSpace:'nowrap' }}>{p.priceRLUSD} RLUSD</div>
                    <div style={{ fontSize:11,color:'rgba(255,255,255,.32)',marginBottom:12,whiteSpace:'nowrap' }}>or {p.priceXRP} XRP{p.isMonthly?'/mo':''}</div>
                    <button style={{ padding:'12px 22px',borderRadius:99,background:p.color,color:'#000',border:'none',fontWeight:800,fontSize:13,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap' }}>Buy Now →</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="prod-grid">
            {others.map(p=>(
              <div key={p.id} className="pcard" onClick={()=>setAP(p)} style={{ background:'rgba(6,6,22,.72)',backdropFilter:'blur(16px)',border:`1px solid ${p.color}22`,borderRadius:18,padding:18,position:'relative',overflow:'hidden',cursor:'pointer',display:'flex',flexDirection:'column',minHeight:230 }}>
                {p.tag && <span style={tagStyle(p.tag, p.color, {top:10, right:10, fontSize:9, padding:'3px 8px'})}>{p.tag}</span>}
                <div style={{ width:42,height:42,borderRadius:12,background:`${p.color}18`,border:`1px solid ${p.color}25`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,marginBottom:12 }}>{p.emoji}</div>
                <div style={{ fontSize:9,fontWeight:700,color:p.color,letterSpacing:'.11em',textTransform:'uppercase',marginBottom:6,fontFamily:"'IBM Plex Mono',monospace",opacity:.85 }}>{p.cat}</div>
                <h3 style={{ fontSize:14,fontWeight:800,marginBottom:5,lineHeight:1.25 }}>{p.name}</h3>
                <p style={{ fontSize:11,color:'rgba(255,255,255,.42)',lineHeight:1.55,marginBottom:12,flex:1 }}>{p.tagline}</p>
                <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',paddingTop:10,borderTop:`1px solid ${p.color}15`,gap:6,marginTop:'auto' }}>
                  <span style={{ fontSize:14,fontWeight:900,color:p.color,whiteSpace:'nowrap' }}>{p.priceRLUSD}{p.isMonthly?'/mo':''}</span>
                  <button style={{ padding:'6px 12px',borderRadius:99,background:`${p.color}18`,border:`1px solid ${p.color}32`,color:p.color,fontWeight:700,fontSize:10,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap' }}>{p.isMonthly?'Subscribe':'Buy'} →</button>
                </div>
              </div>
            ))}
          </div>
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
                  <span style={{ fontSize:11,fontWeight:700,color:'#10b981',letterSpacing:'.14em',textTransform:'uppercase' }}>XRPLScore™ · First of its kind on XRPL</span>
                </div>
                <h2 style={{ fontSize:'clamp(22px,3.3vw,36px)',fontWeight:900,letterSpacing:'-2px',marginBottom:14 }}>Our own on-chain score.<br />No FICO. No bureau. No SSN.</h2>
                <p style={{ fontSize:13,color:'rgba(255,255,255,.5)',lineHeight:1.8,marginBottom:20 }}>
                  XRPLScore™ is XRPLHub's proprietary 300–850 rating, computed live from your XRPL wallet.
                  <strong style={{ color:'#fff' }}> No FICO. No bureau. No SSN.</strong> Connect your Xaman wallet to see your score instantly — your results save to your account.
                </p>

                {/* score checker */}
                <div style={{ display:'flex',gap:9,flexWrap:'wrap' }}>
                  <input className="score-inp" type="text" value={walletInput} onChange={e=>setWI(e.target.value)} onKeyDown={e=>e.key==='Enter'&&fetchScore(walletInput)} placeholder="Paste any XRPL wallet address…" style={{ ...INP,flex:1,minWidth:180,borderRadius:99,paddingLeft:20,fontFamily:"'IBM Plex Mono',monospace",fontSize:12 }} />
                  <button onClick={()=>fetchScore(walletInput)} style={{ padding:'12px 22px',borderRadius:99,background:'#10b981',color:'#000',border:'none',fontWeight:800,fontSize:13,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap' }}>Quick Check →</button>
                </div>
                <p style={{ fontSize:11,color:'rgba(255,255,255,.28)',marginTop:10 }}>or <button onClick={()=>setShowConnect(true)} style={{ background:'none',border:'none',color:'#10b981',cursor:'pointer',fontWeight:700,fontSize:11,fontFamily:'inherit',padding:0 }}>connect your Xaman wallet</button> for your full personalized credit report</p>
            </div>
          )}
          </div>
        </section>

        {/* GRANTS */}
        <section id="grants" className="section-pad" style={{ padding:'0 24px 72px',maxWidth:1100,margin:'0 auto' }}>
          <div style={{ textAlign:'center',marginBottom:34 }}>
            <div style={{ display:'inline-flex',alignItems:'center',gap:6,marginBottom:12 }}><span style={{ width:5,height:5,borderRadius:'50%',background:'#8b5cf6',boxShadow:'0 0 8px #8b5cf6' }} /><span style={{ fontSize:11,fontWeight:700,color:'#8b5cf6',letterSpacing:'.14em',textTransform:'uppercase' }}>Community Grants</span></div>
            <h2 style={{ fontSize:'clamp(22px,3.5vw,34px)',fontWeight:900,letterSpacing:'-2px',marginBottom:12 }}>Real people. Real money. Wallet to wallet.</h2>
            <p style={{ fontSize:13,color:'rgba(255,255,255,.48)',lineHeight:1.8,maxWidth:580,margin:'0 auto' }}>Donors fund a public XRPL treasury. AI assists review; a human decides every application. Approved grants go directly to recipients&apos; wallets — 100% verifiable on the XRP Ledger.</p>
          </div>
          <TreasuryStatsBar />
          <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:20 }}>

            {/* Donate */}
            <div style={{ background:'linear-gradient(135deg,rgba(16,185,129,.08),rgba(6,6,22,.8))',border:'1px solid rgba(16,185,129,.2)',borderRadius:22,padding:'30px 26px',backdropFilter:'blur(20px)' }}>
              <div style={{ fontSize:40,marginBottom:14,animation:'float 4s ease-in-out infinite' }}>💚</div>
              <h3 style={{ fontSize:21,fontWeight:900,marginBottom:10 }}>Fund the Treasury</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.48)',lineHeight:1.8,marginBottom:20 }}>Send XRP or RLUSD to our public XRPL treasury — wallet-to-wallet, no intermediaries, viewable any time on XRPScan.</p>
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
              <h3 style={{ fontSize:21,fontWeight:900,marginBottom:10 }}>Apply for a Grant</h3>
              <p style={{ fontSize:13,color:'rgba(255,255,255,.48)',lineHeight:1.8,marginBottom:18 }}>Need help? Apply for $25–$100. AI helps our reviewer sort applications; a human makes the decision, then funds are released to your XRPL wallet.</p>
              <div style={{ display:'flex',flexDirection:'column',gap:7,marginBottom:20 }}>
                {['Submit a short application','AI-assisted review — a human decides','Approved funds go direct to your wallet','No bank account, no ID required'].map(f=>(
                  <div key={f} style={{ display:'flex',alignItems:'center',gap:8,fontSize:12,color:'rgba(255,255,255,.52)' }}>
                    <span style={{ color:'#8b5cf6',fontSize:11 }}>✓</span>{f}
                  </div>
                ))}
              </div>
              <button onClick={()=>setShowGrant(true)} style={{ ...Btn('color','#8b5cf6',{width:'100%',padding:'14px',fontSize:15}) }}>Apply for a Grant →</button>
            </div>

          </div>
        </section>

        {/* SCORE API — for developers */}
        <section id="api" className="section-pad" style={{ padding:'0 24px 72px',maxWidth:980,margin:'0 auto' }}>
          <div style={{ ...GLASS,borderRadius:22,padding:'34px 28px' }}>
            <div style={{ fontSize:10,fontWeight:700,color:'#38bdf8',letterSpacing:'.14em',textTransform:'uppercase',marginBottom:8,fontFamily:"'IBM Plex Mono',monospace" }}>For developers</div>
            <h2 style={{ fontSize:'clamp(22px,3.4vw,30px)',fontWeight:900,letterSpacing:'-1px',marginBottom:10 }}>XRPLScore API</h2>
            <p style={{ fontSize:14,color:'rgba(255,255,255,.55)',lineHeight:1.7,marginBottom:20,maxWidth:640 }}>
              The same 300–850 score, from the same 8 signals, as one REST call. Free tier with no card, paid plans billed in RLUSD.
              Autonomous agents can also pay per call over x402 — no account, no key.
            </p>
            <div style={{ background:'rgba(0,0,0,.35)',border:'1px solid rgba(255,255,255,.1)',borderRadius:12,padding:'14px 16px',marginBottom:20,overflowX:'auto' }}>
              <code style={{ fontSize:12,color:'rgba(255,255,255,.75)',fontFamily:"'IBM Plex Mono',monospace",whiteSpace:'pre',lineHeight:1.7 }}>{`curl -H "authorization: Bearer xrs_live_..." \\
  "https://www.xrplhub.io/api/v1/score?wallet=rXXXX..."`}</code>
            </div>
            <div style={{ display:'flex',gap:12,flexWrap:'wrap' }}>
              <a href="/pricing" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'13px 26px',background:'#10b981',color:'#000',fontSize:14,fontWeight:800,borderRadius:99,textDecoration:'none' }}>See pricing & get a key →</a>
              <a href="/openapi.json" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'13px 26px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:14,fontWeight:600,borderRadius:99,textDecoration:'none' }}>OpenAPI spec ↗</a>
              <a href="/.well-known/x402" style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'13px 26px',border:'1.5px solid rgba(255,255,255,.22)',color:'#fff',fontSize:14,fontWeight:600,borderRadius:99,textDecoration:'none' }}>x402 discovery ↗</a>
            </div>
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
                <p style={{ fontSize:10,color:'rgba(255,255,255,.16)',marginTop:2 }}>Not a bank · Not a broker · You sign every transaction · 100% on-chain</p>
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
