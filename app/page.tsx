export default function Home() {
  return (
    <main style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial', padding: 24, lineHeight: 1.4 }}>
      <h1 style={{ margin: 0 }}>Provenonce Beats</h1>
      <p style={{ marginTop: 8, maxWidth: 820 }}>
        Stateless time authentication service. Beats publishes and reads global anchors from Solana memos, and provides public VDF-like
        sequential-work verification utilities.
      </p>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Endpoints</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <a href="/api/health">GET /api/health</a> (service status)
          </li>
          <li>
            <a href="/api/v1/beat/anchor">GET /api/v1/beat/anchor</a> (latest global anchor, read-only)
          </li>
          <li>
            <a href="/api/v1/beat/verify">GET /api/v1/beat/verify</a> (verification API info)
          </li>
          <li>
            <a href="/api/v1/beat/verify">POST /api/v1/beat/verify</a> (verify beat/chain/proof)
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 16 }}>Notes</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>This page is informational. All core functionality is exposed via the JSON APIs above.</li>
          <li>If this page loads but an API endpoint fails, check Solana RPC availability and the Beats cron status.</li>
        </ul>
      </section>
    </main>
  );
}
