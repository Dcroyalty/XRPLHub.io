// src/components/BrandLogo.tsx — the header logo on every page: an exact copy of the homepage footer logo
// (src/app/page.tsx footer): /hub-logo.png at 26×26 with 7px corners, then the "xrplHub.io" wordmark at 15px, weight
// 900, Syne, in the brand gradient. Same file, colors and proportions; the footer itself is left as it is.
// Server- and client-safe (no hooks).
export const BRAND_GRADIENT = "linear-gradient(135deg,#d4a72c,#38bdf8)"; // must match BRAND_GRADIENT in src/app/page.tsx

export default function BrandLogo({ href = "/" }: { href?: string }) {
  return (
    <a href={href} aria-label="XRPLHub home" style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none", flex: "0 0 auto" }}>
      <img src="/hub-logo.png" alt="" width={26} height={26} style={{ width: 26, height: 26, borderRadius: 7, objectFit: "cover", display: "block" }} />
      <span
        className="xh-keep-font"
        style={{
          fontFamily: "'Syne', sans-serif",
          fontWeight: 900,
          letterSpacing: "-.5px",
          lineHeight: 1,
          fontSize: 15,
          background: BRAND_GRADIENT,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}
      >
        xrplHub.io
      </span>
    </a>
  );
}
