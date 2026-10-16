import BrandLogo from "@/components/BrandLogo";
export default function PrivacyPage() {
  const H = { color:'#10b981', fontWeight:800 as const, fontSize:13, textTransform:'uppercase' as const, letterSpacing:'.04em', marginTop:28, marginBottom:8, display:'block' as const };
  const P = { fontSize:14, color:'rgba(255,255,255,.62)', lineHeight:1.85 as const, marginBottom:10 };
  return (
    <div style={{ minHeight:'100vh', background:'#030310', color:'#eeeef5', fontFamily:"'Syne',sans-serif", padding:'0 0 80px' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:99px}`}</style>

      {/* Nav */}
      <nav style={{ background:'rgba(3,4,14,.9)', backdropFilter:'blur(20px)', borderBottom:'1px solid rgba(16,185,129,.18)', padding:'0 24px', height:64, display:'flex', alignItems:'center', justifyContent:'space-between', position:'sticky', top:0, zIndex:100 }}>
        <BrandLogo />
        <a href="/" style={{ fontSize:13, color:'#10b981', textDecoration:'none', fontWeight:600 }}>← Back to Home</a>
      </nav>

      <div style={{ maxWidth:780, margin:'0 auto', padding:'52px 24px 0' }}>
        <div style={{ fontSize:11, fontWeight:700, color:'#10b981', letterSpacing:'.14em', textTransform:'uppercase', marginBottom:10 }}>Legal</div>
        <h1 style={{ fontSize:'clamp(28px,5vw,44px)', fontWeight:900, letterSpacing:'-2px', marginBottom:8 }}>Privacy Policy</h1>
        <p style={{ fontSize:12, color:'rgba(255,255,255,.28)', marginBottom:40, fontFamily:"'IBM Plex Mono',monospace" }}>
          xrplhub.io · Effective September 7, 2026 · Last updated {new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}
        </p>

        <div style={{ background:'rgba(16,185,129,.06)', border:'1px solid rgba(16,185,129,.18)', borderRadius:16, padding:'20px 24px', marginBottom:36 }}>
          <p style={{ fontSize:13, color:'rgba(255,255,255,.55)', lineHeight:1.8 }}>Your privacy is fundamental to how we built XRPLHub. This policy explains exactly what we collect, why, and how we protect it. We do not sell your data. We never will.</p>
        </div>

        <div style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.1)', borderRadius:16, padding:'20px 24px', marginBottom:36 }}>
          <div style={{ fontWeight:800, fontSize:14, marginBottom:8 }}>In plain English</div>
          <ul style={{ fontSize:13, color:'rgba(255,255,255,.6)', lineHeight:1.8, paddingLeft:18 }}>
            <li>We read public wallet history from the XRP Ledger. Anyone can see that history.</li>
            <li>We keep what you give us (like an email address or a grant application) and basic visit stats: pages viewed, device type, country.</li>
            <li>We never ask for your Social Security number or any ID, and we never see your wallet keys.</li>
            <li>We don&apos;t sell your data. You can ask us to see, fix or delete it.</li>
            <li>This summary doesn&apos;t replace the full policy below. If they differ, the full policy applies.</li>
          </ul>
        </div>

        <span style={H}>1. What We Collect</span>
        <p style={P}>We collect information you provide directly: name (optional), email address, phone number (optional), XRPL wallet address, and grant application details. We also read public on-chain data from the XRP Ledger to compute XRPLScore — this data is publicly visible on the blockchain by design. Standard web analytics (page views, device type, country) are collected to improve the platform. We do not collect Social Security Numbers or any government identifiers.</p>

        <span style={H}>2. What We Never Collect</span>
        <p style={P}>We never collect: Social Security Numbers or other government IDs · private keys or seed phrases · plain-text passwords · payment card numbers · bank account credentials. We will NEVER ask for your private key or seed phrase. Any message requesting this information is fraudulent and should be reported to <a href="mailto:support@xrplhub.io" style={{ color:'#10b981' }}>support@xrplhub.io</a> immediately.</p>

        <span style={H}>3. How We Use Your Information</span>
        <p style={P}>We use your information solely to: deliver the services you purchase, compute and display XRPLScore, process grant applications, send transaction receipts and service confirmations, comply with legal obligations, and investigate fraud or abuse.</p>

        <span style={H}>4. How We Share Your Information</span>
        <p style={P}>We do not sell, rent, or trade your personal information, and we do not furnish any information to consumer reporting agencies. We share data only with: service providers operating under strict confidentiality agreements (database hosting, email delivery, analytics), and law enforcement or regulatory authorities when required by valid legal process.</p>

        <span style={H}>5. Security</span>
        <p style={P}>All data is encrypted in transit using TLS 1.3. Data at rest is encrypted using AES-256. Access to personal data is restricted to authorized personnel on a need-to-know basis with role-based access controls. We conduct regular security reviews.</p>

        <span style={H}>6. Data Retention</span>
        <p style={P}>We retain your data for as long as your account is active or as needed to provide services. Transaction records are retained for up to 7 years to meet financial-recordkeeping obligations. You may request deletion of your personal data, subject to legal retention requirements, by contacting us at <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a>.</p>

        <span style={H}>7. Your Rights</span>
        <p style={P}>You have the right to: access the personal data we hold about you, correct inaccurate information, request deletion (subject to legal retention obligations), and receive a copy of your data in a portable format. To exercise any of these rights, email <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a> with subject line &quot;Data Request.&quot; We respond within 30 days.</p>

        <span style={H}>8. California Residents (CCPA)</span>
        <p style={P}>California residents have the right to know what personal information we collect, the right to delete personal information, and the right to opt out of the sale of personal information. We do not sell personal information. To exercise your CCPA rights, contact us at <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a>.</p>

        <span style={H}>9. Children</span>
        <p style={P}>xrplhub.io is intended for users 18 years of age and older. We do not knowingly collect personal information from minors. If we learn we have collected information from a minor, we will delete it immediately.</p>

        <span style={H}>10. Cookies & Tracking</span>
        <p style={P}>We use minimal cookies essential to platform function (session management, wallet-state persistence in localStorage). We do not use third-party advertising trackers and do not sell behavioral data to advertisers.</p>

        <span style={H} id="lending-list">11. XRPL Lending launch list</span>
        <p style={P}>If you sign up on <a href="/lending" style={{ color:'#10b981' }}>xrplhub.io/lending</a> to hear when XRPL lending goes live, we store your email address, the date you signed up, the exact sentence you agreed to, and a one-way hash of your IP address (used only to stop abuse; we can&apos;t turn it back into your IP). We use your email for one thing: a single email when lending is enabled on the XRP Ledger mainnet. We don&apos;t add you to any other list, don&apos;t share or sell the address, and don&apos;t use it for marketing. Every email has an unsubscribe link, and you can ask us to delete your address at any time at <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a>. If we use an email delivery provider to send that email, it receives your address only to deliver it. We delete the list once the launch email has been sent, except for addresses we must keep on a do-not-email list after an unsubscribe.</p>

        <span style={H} id="yield-alerts">12. Yield Desk grade alerts</span>
        <p style={P}>If you sign up on <a href="/yield" style={{ color:'#10b981' }}>xrplhub.io/yield</a> for grade-change alerts, we store your email address, the option you asked about (if any), the date, the exact sentence you agreed to, and a one-way hash of your IP address (used only to stop abuse). We use your email for one thing: telling you when a Yield Desk risk grade changes. We don&apos;t add you to any other list, don&apos;t share or sell the address, and don&apos;t use it for marketing. Every email has an unsubscribe link, and you can ask us to delete your address at any time at <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a>. If we use an email delivery provider, it receives your address only to deliver the email. Page visits on xrplhub.io are counted with Vercel Web Analytics, which uses no cookies and stores no personal data.</p>

        <span style={H} id="grants">13. Grant applications and donations</span>
        <p style={P}>If you apply for a grant on <a href="/grants" style={{ color:'#10b981' }}>xrplhub.io/grants</a>, we store your wallet address, email, the category and what you wrote, the date, and any payout details you add later (a destination tag or a different wallet). A person reads it. Applicant data is used only to review and pay grants, and to send updates you opted into. It is never sold or shared. We use your email only for this application (to tell you when review starts and what we decided) unless you separately opt in to updates after applying. We don&apos;t share or sell it. Grants paid are published on the XRP Ledger and on <a href="/grants/ledger" style={{ color:'#10b981' }}>our public ledger page</a> by wallet address only. Donations by card are processed by Stripe for Morrbiz LLC; we publish only the amount, card fee and date, never the donor&apos;s name or card details. XRP and RLUSD donations are public on the XRP Ledger. Ask us to delete your application at <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a>.</p>

        <span style={H}>14. Changes to This Policy</span>
        <p style={P}>We may update this Privacy Policy periodically. Material changes will be communicated via email to registered users. Continued use of the platform after changes constitutes acceptance of the updated policy.</p>

        <span style={H}>15. Contact Us</span>
        <p style={P}>Privacy inquiries: <a href="mailto:privacy@xrplhub.io" style={{ color:'#10b981' }}>privacy@xrplhub.io</a><br />General: <a href="mailto:support@xrplhub.io" style={{ color:'#10b981' }}>support@xrplhub.io</a></p>

        <div style={{ marginTop:48, paddingTop:24, borderTop:'1px solid rgba(255,255,255,.07)', display:'flex', gap:16, flexWrap:'wrap' }}>
          <a href="/terms" style={{ fontSize:13, color:'#10b981', textDecoration:'none', fontWeight:600 }}>Terms of Service →</a>
          <a href="/support" style={{ fontSize:13, color:'rgba(255,255,255,.4)', textDecoration:'none' }}>Support →</a>
          <a href="/" style={{ fontSize:13, color:'rgba(255,255,255,.4)', textDecoration:'none' }}>← Home</a>
        </div>
      </div>
    </div>
  );
}
