import type { Metadata } from 'next';

// /spend and its pages are client components, so their title and description live here.
export const metadata: Metadata = {
  title: 'XRP Allowance for Kids & Recurring XRP Payments — Spend Controls | XRPLHub',
  description: 'Give an allowance in RLUSD (a digital US dollar) that can only be spent where you pick, or set up a recurring XRP or RLUSD subscription payment. Free. You approve every payment in your own wallet.',
};

export default function SpendLayout({ children }: { children: React.ReactNode }) {
  return children;
}
