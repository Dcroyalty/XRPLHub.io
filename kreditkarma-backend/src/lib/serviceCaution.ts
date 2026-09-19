// src/lib/serviceCaution.ts
// Confirmation-step copy for caution-tier services whose consequences are specific and
// serious. The execute route returns this (409, requiresConfirmation) before it will issue
// a sign request; the page renders heading / listTitle / warning / irreversible / confirmPrompt.
// Wording is grounded in the XRPL reference for each flag (see comments).

export interface CautionCopy {
  heading: string;
  listTitle: string;
  warning: string;
  irreversible: string[];
  confirmPrompt: string;
}

const countSigners = (v: unknown) =>
  new Set(String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)).size;
const on = (v: unknown) => v === true || v === 'true' || v === 'on' || v === 'yes' || v === 1 || v === '1';

export function cautionCopyFor(productId: string, params: Record<string, unknown>): CautionCopy | null {
  if (productId === 'issuerdecl') {
    // XRPL docs: asfNoFreeze "permanently give[s] up the ability to freeze individual trust lines or
    // disable Global Freeze. This flag can never be disabled after being enabled." Master key only.
    return {
      heading: 'This is permanent — read every line',
      listTitle: 'What you are giving up, forever',
      warning:
        'You are about to enable No Freeze (asfNoFreeze) on your issuing account. Once it is on it can never be turned off — not by you, not by us, not by anyone. Your freeze authority over individual holders is permanently gone.',
      irreversible: [
        'PERMANENT: this account can never again freeze an individual trust line. The "Freeze a Trust Line" service will stop working for this account, for every token it issues — now or later.',
        'PERMANENT: Global Freeze becomes a one-way door. You keep the ability to switch it ON, but once it is on it can never be switched off — every holder of every token you issue would be frozen for good.',
        'It applies to ALL tokens issued by this account, in every currency. It does not affect tokens that other accounts issue.',
        "You must sign with your account's MASTER key. A regular key or a multi-signed transaction is rejected by the ledger, so this cannot be done from a delegated key.",
        'Clearing the flag later does not work — the ledger ignores any attempt to disable No Freeze. The only way to "undo" it is to issue from a brand-new account.',
      ],
      confirmPrompt:
        'I understand my account permanently loses the ability to freeze individual trust lines, that Global Freeze can never be turned off once switched on, and that none of this can ever be reversed.',
    };
  }

  if (productId === 'multisig') {
    const n = countSigners(params.signers);
    const q = Number(params.quorum) || 0;
    if (!on(params.disableMaster)) {
      return {
        heading: 'Read carefully — this does NOT lock your master key',
        listTitle: 'What this does and does not do',
        warning:
          `This sets a ${q}-of-${n} signer list on your account. It does not, by itself, stop your master key (or a regular key) from signing on its own — anyone with either key can still move your funds without your signers.`,
        irreversible: [
          'Your master key and any regular key keep full signing power. To make multi-signing the ONLY way to move funds, go back and turn on "Also disable my master key" (a 3-step lockdown).',
          `Every signer address must be an account whose keys you (or the people you trust) actually control. A wrong address means a signer that can never sign.`,
          'The signer list is reversible: you can replace or delete it later, signing with your master key.',
        ],
        confirmPrompt: 'I understand this sets a signer list only, and that my master key can still sign by itself.',
      };
    }
    return {
      heading: 'Read carefully — you are locking your own account',
      listTitle: 'What happens next, and what cannot be undone',
      warning:
        `You are about to make multi-signing the ONLY way to move funds from your account. Three signed steps: set a ${q}-of-${n} signer list, remove your regular key (if you have one), then disable your master key.`,
      irreversible: [
        `After the last step, EVERY transaction from this account needs ${q} of your ${n} signers to co-sign. No single key — including your master key — can move funds again.`,
        `If you cannot reach ${q} of your ${n} signers (lost keys, wrong addresses, unavailable people), this account is locked forever and everything in it is unrecoverable.`,
        'Re-enabling the master key is only possible with a multi-signed transaction that reaches your quorum.',
        'Multi-signed transactions cost a higher network fee, and every signer needs a wallet that can multi-sign (Xaman can).',
        'Double-check every signer address now. Consider trying this on a small test account first.',
      ],
      confirmPrompt:
        `I understand that after this, only ${q} of my ${n} signers can ever move funds from this account, and that if they cannot be reached the account and its funds are lost for good.`,
    };
  }
  return null;
}
