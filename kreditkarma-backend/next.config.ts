import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  // TypeScript errors FAIL the build (they used to be ignored, so a type error shipped silently).
  eslint: {
    ignoreDuringBuilds: true,
  },
  // xrp-ledger.toml: the spec wants application/toml (text/plain also accepted) and CORS open,
  // so browser-based checkers can read it. Served from public/.well-known/.
  // DEX order, swap and AMM deposit/withdraw builders were removed 2026-10-06 (Xaman charges for those; we don't
  // compete with the wallet we sign through). Send their old indexed pages to the catalog instead of a 404.
  async redirects() {
    return ["dexorder", "smartswap", "ammentry", "ammwithdraw"].map((id) => ({
      source: `/services/${id}`,
      destination: "/services",
      permanent: true,
    }));
  },
  async headers() {
    return [
      {
        source: "/.well-known/xrp-ledger.toml",
        headers: [
          { key: "Content-Type", value: "application/toml; charset=utf-8" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
        ],
      },
    ];
  },
};

export default nextConfig;