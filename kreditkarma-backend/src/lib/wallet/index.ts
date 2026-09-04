// src/lib/wallet/index.ts
// The wallet registry. Xaman stays the default (first, always shown). Extension
// providers are only offered after isAvailable() confirms the extension is
// present in this browser — detection, not assumption.

import type { WalletProvider } from "./types";
import { xamanProvider } from "./providers/xaman";
import { crossmarkProvider } from "./providers/crossmark";
import { gemwalletProvider } from "./providers/gemwallet";

export * from "./types";

export const ALL_PROVIDERS: WalletProvider[] = [
  xamanProvider, // default — index 0
  crossmarkProvider,
  gemwalletProvider,
];

export function getProvider(id: string): WalletProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

export interface ProviderOption {
  provider: WalletProvider;
  available: boolean;
}

/**
 * Detect every provider's availability. Returns ALL providers (Xaman first)
 * with an accurate `available` flag — the picker renders available ones as
 * selectable rows and names the rest so a user knows what to install.
 * Extension detection polls for up to ~2.5s (globals inject asynchronously).
 */
export async function resolveProviderOptions(opts: {
  xamanAvailable: boolean;
}): Promise<ProviderOption[]> {
  return Promise.all(
    ALL_PROVIDERS.map(async (provider) => {
      if (provider.id === "xaman") return { provider, available: opts.xamanAvailable };
      let available = false;
      try {
        available = await provider.isAvailable();
      } catch {
        available = false;
      }
      return { provider, available };
    })
  );
}
