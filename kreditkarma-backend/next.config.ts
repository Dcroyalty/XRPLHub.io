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
  // The generic transaction catalog and its /services pages were removed 2026-10-07 (XRPLHub keeps only products nobody
  // else offers). The check pages go to Spend Controls, so "create an XRPL check" searches land on a real product;
  // every other old service page (and the catalog index) goes to the homepage. Specific rules first — first match wins.
  async redirects() {
    return [
      ...["checkcreate", "checkcash", "checkcancel"].map((id) => ({ source: `/services/${id}`, destination: "/spend", permanent: true })),
      { source: "/services/:id", destination: "/", permanent: true },
      { source: "/services", destination: "/", permanent: true },
    ];
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