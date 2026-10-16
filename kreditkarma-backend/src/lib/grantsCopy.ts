// src/lib/grantsCopy.ts — grants pool constants and wording shared by server code and client components
// (no server imports here). The pool itself is read in src/lib/grantsPool.ts.

export const GRANTS_POOL = "raiqAnACKxmVY7oCUWnCYdGquSrkMdsMuu";
export const FIRST_MILESTONE_XRP = 1_000; // the first 10 grants go out when the pool reaches this
export const FIRST_MILESTONE_GRANTS = 10;
export const LONG_TERM_GOAL_XRP = 100_000;
export const DONATION_DISCLOSURE =
  "XRPLHub is run by Morrbiz LLC, a for-profit company. Donations are not tax-deductible. 100% of donations, after card fees, go to the grants pool. Every grant paid is published on the XRP Ledger.";
export const APPLICANT_STATUS =
  "Applications are saved and reviewed in order once the pool reaches its first milestone. We'll email you when review starts.";
export const GRANT_UPDATES_CONSENT = "Email me occasional XRPLHub updates (new free tools and grant news). Unsubscribe any time.";
export const GRANT_CATEGORIES = ["Rent or housing", "Utilities", "Food", "Medical", "School", "Small business", "Other"];
