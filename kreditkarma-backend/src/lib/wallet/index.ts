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
 * Which wallets to show. Xaman is included whenever the server says it's
 * configured (xamanAvailable). Each extension is included only if its
 * isAvailable() resolves true right now.
 */
export async function resolveProviderOptions(opts: {
  xamanAvailable: boolean;
}): Promise<ProviderOption[]> {
  const checks = await Promise.all(
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
  // Xaman first; then available extensions; drop unavailable extensions entirely
  // (no dead buttons) unless NONE are available — then keep one as an install hint.
  const xaman = checks.find((c) => c.provider.id === "xaman")!;
  const exts = checks.filter((c) => c.provider.id !== "xaman");
  const availableExts = exts.filter((c) => c.available);
  const shown = [xaman, ...availableExts];
  if (!xaman.available && availableExts.length === 0) {
    // Nothing works — surface the extensions as install links so it isn't a dead end.
    return exts;
  }
  return shown;
}
