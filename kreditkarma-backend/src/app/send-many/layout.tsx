import type { Metadata } from 'next';

// /send-many is a client page, so its title and description live here.
export const metadata: Metadata = {
  title: 'Send XRP to Multiple People at Once — Batch Payments, One Approval | XRPLHub',
  description: 'Pay up to 8 people in XRP or RLUSD with one approval in your own wallet. Everyone gets paid or nobody does. Free, and we check every payment first.',
};

export default function SendManyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
