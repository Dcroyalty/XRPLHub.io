// src/lib/grantsStatus.ts
// Whether the community-grant APPLICATION form is open. One constant, read by BOTH the page
// (which shows the paused message instead of the form) and POST /api/grants/submit (which
// refuses new applications), so the pause can't be bypassed by posting to the API directly.
//
// Paused because approved grants are waiting to be paid and the treasury doesn't hold enough
// to pay them. Donations are unaffected. Flip to true once the treasury is funded.

export const GRANT_APPLICATIONS_OPEN = false;

export const GRANTS_PAUSED_TITLE = 'Grant applications are paused';

export const GRANTS_PAUSED_MESSAGE =
  "We're not taking new grant applications right now. Grants we've already approved are still waiting to be paid, and the treasury doesn't hold enough to pay them yet — so opening the queue to more people would only make people wait. Applications reopen once the treasury is funded.";

export const GRANTS_DONATE_NOTE =
  'You can still donate: every donation goes straight to the public treasury, and you can watch it on XRPScan.';
