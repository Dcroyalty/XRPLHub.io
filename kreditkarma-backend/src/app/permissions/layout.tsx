import type { Metadata } from 'next';

// /permissions is a client page, so its title and description live here.
export const metadata: Metadata = {
  title: 'Who Can Move Money From My XRP Wallet? Free XRP Wallet Permissions Check | XRPLHub',
  description: 'Paste any XRP wallet address and see everyone who can move money out of it — a second key, multi-sign signers, permission delegations, checks — and remove the ones you don’t want. Free.',
};

export default function PermissionsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
