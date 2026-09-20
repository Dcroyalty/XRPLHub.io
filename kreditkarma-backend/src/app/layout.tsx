import type { Metadata } from 'next';
import './globals.css';
import { SERVICE_COUNT } from '@/app/api/execute/serviceCatalog';

export const metadata: Metadata = {
  // www.xrplhub.io is the one canonical host (xrp-ledger.toml + the treasury Domain point at it);
  // every other host (xrplhub.io, xrplhub.com, kreditkarma.us) redirects here.
  metadataBase: new URL('https://www.xrplhub.io'),
  alternates: { canonical: './' },
  title: 'XRPLHub — XRPL Services, Community Grants & the XRPLScore API',
  description: `${SERVICE_COUNT} done-for-you XRPL transaction services · A public grants treasury on the XRP Ledger · XRPLScore on-chain scoring (300–850 from 8 signals) with a REST API billed in RLUSD. Works with Xaman, Crossmark and GemWallet.`,
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
