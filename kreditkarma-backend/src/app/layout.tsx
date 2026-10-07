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
  title: 'XRPLHub — XRPLScore, Spend Controls & MPT Issuer Risk',
  description: 'XRPLScore: a 300–850 credit-style score for any XRP Ledger wallet, with monitoring and XLS-66 lending readiness · Spend Controls: budgets and subscriptions paid by XRPL checks you sign · MPT issuer-power risk · an agent payment pre-check. Works with Xaman, Crossmark and GemWallet.',
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
