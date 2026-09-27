// src/lib/domainVerify.ts
// Real two-way XRP Ledger domain verification, per the xrp-ledger.toml spec (https://xrpl.org/docs/references/xrp-ledger-toml):
//   1) the account's OWN ledger `Domain` field decodes to a hostname — that is the account's half of the claim, and callers
//      already have it (it comes straight off account_info; there is nothing to verify about your own field).
//   2) that hostname's https://<host>/.well-known/xrp-ledger.toml must list the EXACT account address under a [[ACCOUNTS]]
//      table — the domain's half of the claim.
// Both directions must hold, or "verified" is a lie. The previous check here (removed) only ever did a raw substring search
// over the whole toml file for the address — that matches inside a comment, inside another account's `desc`, or anywhere
// else the bytes happen to appear, and is a false-positive magnet on a product (MPT issuer risk) that people read as a
// safety signal. This does a minimal, comment-safe, table-scoped parse of just the [[ACCOUNTS]] entries — not a full TOML
// grammar (no multi-line strings, no non-ACCOUNTS tables), which is all this needs and all it should trust itself to parse.

export interface TomlAccountsCheck {
  ok: boolean;
  reason: string;
  /** Every address this toml lists under [[ACCOUNTS]], for diagnostics — never more than a few dozen in practice. */
  accountsListed: string[];
}

const FETCH_TIMEOUT_MS = 6000;
const MAX_TOML_BYTES = 2_000_000; // refuse to parse an absurdly large response

function normaliseHost(domain: string): string | null {
  const host = domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host) ? host : null;
}

/** Cut a TOML line at the first unquoted '#'. Good enough for the single-line `key = "value"` entries this parses. */
function stripComment(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c as '"' | "'";
      continue;
    }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

const TABLE_HEADER_RE = /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]?\]\s*$/;
const ADDRESS_LINE_RE = /^\s*address\s*=\s*["']([^"']+)["']\s*$/i;

/**
 * Every address listed under a `[[ACCOUNTS]]` table in a raw xrp-ledger.toml file. Comment-safe and table-scoped: a
 * matching `address = "..."` line inside `[[VALIDATORS]]` or a comment is ignored. Case-sensitive on the address itself
 * (XRPL base58 addresses are case-sensitive), case-insensitive on the table name (`[[accounts]]` also counts).
 */
export function extractAccountsToml(text: string): string[] {
  const out: string[] = [];
  let inAccounts = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    const header = TABLE_HEADER_RE.exec(line);
    if (header) {
      inAccounts = header[1].toUpperCase() === "ACCOUNTS";
      continue;
    }
    if (!inAccounts) continue;
    const m = ADDRESS_LINE_RE.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Direction 2 of the two-way check: does `domain` (the account's OWN Domain field, already trusted by the caller) serve
 * an xrp-ledger.toml that lists `address` under [[ACCOUNTS]]? The caller supplies `domain` from the ledger and `address`
 * from the same account — this function never fetches or trusts anything about which domain to check beyond what was given.
 */
export async function verifyDomainTwoWay(domain: string, address: string): Promise<TomlAccountsCheck> {
  const host = normaliseHost(domain);
  if (!host) return { ok: false, reason: "the account's Domain field does not decode to a plausible hostname", accountsListed: [] };
  let text: string;
  try {
    const res = await fetch(`https://${host}/.well-known/xrp-ledger.toml`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/plain" },
    });
    if (!res.ok) return { ok: false, reason: `https://${host}/.well-known/xrp-ledger.toml returned HTTP ${res.status}`, accountsListed: [] };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_TOML_BYTES) return { ok: false, reason: "xrp-ledger.toml is larger than we parse", accountsListed: [] };
    text = new TextDecoder("utf-8").decode(buf);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? `could not fetch xrp-ledger.toml: ${e.message}` : "could not fetch xrp-ledger.toml", accountsListed: [] };
  }
  const accountsListed = extractAccountsToml(text);
  const ok = accountsListed.includes(address);
  return {
    ok,
    reason: ok
      ? `${address} is listed under [[ACCOUNTS]] in https://${host}/.well-known/xrp-ledger.toml`
      : `https://${host}/.well-known/xrp-ledger.toml does not list ${address} under [[ACCOUNTS]]`,
    accountsListed,
  };
}
