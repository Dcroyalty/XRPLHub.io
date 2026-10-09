import type { Metadata } from 'next';
import './globals.css';
// Vercel Web Analytics: page views + referrers (e.g. youtube.com), no cookies, no personal data,
// no consent banner needed -- it's aggregate/anonymous by design. View it at vercel.com -> the
// kreditkarma-obi2 project -> Analytics tab. Already an installed dependency; just never mounted.
import { Analytics } from '@vercel/analytics/next';

export const metadata: Metadata = {
  // www.xrplhub.io is the one canonical host (xrp-ledger.toml + the treasury Domain point at it);
  // every other host (xrplhub.io, xrplhub.com, kreditkarma.us) redirects here.
  metadataBase: new URL('https://www.xrplhub.io'),
  alternates: { canonical: './' },
  title: 'XRP Wallet Checker, Allowances & Recurring XRP Payments — XRPLHub',
  description: "Check any XRP wallet's track record, set up an XRP allowance for kids or a recurring XRP payment, and check a token before you buy. Free. You approve everything in your own wallet.",
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
