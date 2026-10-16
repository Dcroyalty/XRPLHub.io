// src/lib/grantsStatus.ts
// Whether the community-grant APPLICATION form is open. One constant, read by BOTH the pages and
// POST /api/grants/submit, so a pause can't be bypassed by posting to the API directly.
//
// Reopened 2026-10-16 with the new grants pool (raiqAnACKxmVY7oCUWnCYdGquSrkMdsMuu, src/lib/grantsPool.ts):
// applications are saved and reviewed in order once the pool reaches its first milestone. No timeline is promised
// before then. Set to false to pause again; the messages below are what people see when paused.

export const GRANT_APPLICATIONS_OPEN = true;

export const GRANTS_PAUSED_TITLE = 'Grant applications are paused';

export const GRANTS_PAUSED_MESSAGE =
  "We're not taking new grant applications right now. You can still donate to the grants pool; every donation and every grant is published.";

export const GRANTS_DONATE_NOTE =
  'Every donation goes straight to the public grants pool on the XRP Ledger, and every grant paid is published.';
