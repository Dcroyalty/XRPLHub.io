import type { Plugin } from "@elizaos/core";
import { createActions } from "./actions.ts";
import { createClient, type XrplhubClient } from "./client.ts";

/**
 * Build the plugin around a client. Exported for tests and for hosts that want to inject their own fetch;
 * most agents just use the default export.
 *
 * Deliberately absent: services, providers, evaluators, routes, event handlers, and any setting. There is nothing to
 * configure and nothing that touches a key. `scripts/check-surface.mjs` fails the build if that ever changes.
 */
export function createXrplhubPlugin(client: XrplhubClient = createClient()): Plugin {
  return {
    name: "plugin-xrplhub",
    description:
      "XRPLHub for XRPL agents: score a wallet (300–850), screen an address against OFAC SDN, and look up what an MPT issuer can do to holders. Read-only: never builds, signs or submits a transaction, never holds keys.",
    actions: createActions(client),
  };
}

export const xrplhubPlugin: Plugin = createXrplhubPlugin();

export default xrplhubPlugin;
