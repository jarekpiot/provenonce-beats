export default function Home() {
  return (
    <main
      style={{
        fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
        minHeight: '100vh',
        margin: 0,
        padding: '56px 24px',
        color: '#0f172a',
        background:
          'radial-gradient(circle at 15% 10%, #c7f9cc 0%, rgba(199,249,204,0) 35%), radial-gradient(circle at 90% 15%, #fef3c7 0%, rgba(254,243,199,0) 30%), linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)',
      }}
    >
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: 44, letterSpacing: '-0.03em' }}>Provenonce Beats</h1>
        <p style={{ marginTop: 12, maxWidth: 760, fontSize: 18 }}>
          Public clock and timestamping service anchored on Solana. Stateless by design.
        </p>

        <div
          style={{
            marginTop: 30,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 14,
          }}
        >
          {[
            ['GET', '/api/health', 'service telemetry'],
            ['GET', '/api/v1/beat/anchor', 'latest global anchor'],
            ['GET', '/api/v1/beat/key', 'receipt verification key'],
            ['GET', '/api/v1/beat/verify', 'verify API metadata'],
            ['POST', '/api/v1/beat/verify', 'verify beat/chain/proof'],
            ['POST', '/api/v1/beat/timestamp', 'timestamp SHA-256 hash'],
          ].map(([method, href, note]) => (
            <a
              key={href}
              href={href}
              style={{
                textDecoration: 'none',
                color: '#0f172a',
                background: '#ffffffdd',
                border: '1px solid #dbeafe',
                borderRadius: 16,
                padding: '14px 16px',
                display: 'block',
              }}
            >
              <strong style={{ display: 'inline-block', minWidth: 52 }}>{method}</strong>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{href}</span>
              <div style={{ marginTop: 6, color: '#475569', fontSize: 14 }}>{note}</div>
            </a>
          ))}
        </div>

        <p style={{ marginTop: 20, color: '#334155' }}>
          Free tier: 5/min and 10/day per IP on timestamping. Optional pro tier token can raise limits.
        </p>
      </div>
    </main>
  );
}
