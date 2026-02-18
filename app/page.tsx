import styles from './page.module.css';
import { readLatestAnchorCached } from '@/lib/solana';

const ENDPOINTS = [
  ['GET', '/api/health', 'service telemetry'],
  ['GET', '/api/v1/beat/anchor', 'latest global anchor'],
  ['GET', '/api/v1/beat/key', 'receipt verification key'],
  ['GET', '/api/v1/beat/verify', 'verify API metadata'],
  ['POST', '/api/v1/beat/verify', 'verify beat/chain/proof'],
  ['POST', '/api/v1/beat/timestamp', 'timestamp SHA-256 hash'],
] as const;

export const dynamic = 'force-dynamic';

const curlExample = `curl -X POST https://beats.provenonce.dev/api/v1/beat/timestamp \\
  -H "content-type: application/json" \\
  -d '{"hash":"<your-lowercase-sha256-hash>"}'`;

export default async function Home() {
  let beatIndex: number | null = null;
  let beatHash: string | null = null;
  let difficulty: number | null = null;
  let nextAnchorAt: string | null = null;

  try {
    const latest = await readLatestAnchorCached(5_000);
    if (latest) {
      beatIndex = latest.beat_index;
      beatHash = latest.hash;
      difficulty = latest.difficulty;
      nextAnchorAt = new Date(latest.utc + 60_000).toISOString();
    }
  } catch {
    // Keep homepage available even if anchor fetch fails.
  }

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <img src="/logo.png" alt="Provenonce" style={{ width: 36, height: 36, margin: '0 auto 0.75rem' }} />
        <div className={styles.wordmark}>PROVENONCE</div>
        <h1 className={styles.title}>Provenonce Beats</h1>
        <p className={styles.subtitle}>
          Public clock and timestamping service anchored on Solana. Stateless by design.
        </p>

        <section className={styles.statusCard}>
          <div className={styles.counterItem}>
            <div className={styles.label}>Live Beat Index</div>
            <div className={styles.indexValue}>{beatIndex ?? '--'}</div>
          </div>
          <div className={styles.counterItem}>
            <div className={styles.label}>Difficulty</div>
            <div className={styles.smallValue}>{difficulty ?? '--'}</div>
          </div>
          <div className={styles.counterItem}>
            <div className={styles.label}>Next Anchor (UTC)</div>
            <div className={styles.smallValue}>
              {nextAnchorAt ? new Date(nextAnchorAt).toISOString().replace('T', ' ').replace('Z', '') : '--'}
            </div>
          </div>
          <div className={styles.counterItem}>
            <div className={styles.label}>Anchor Hash</div>
            <div className={styles.hashValue}>{beatHash ? `${beatHash.slice(0, 16)}...` : '--'}</div>
          </div>
        </section>

        <section className={styles.curlBlock}>
          <div className={styles.curlTitle}>Quick Start (`/beat/timestamp`)</div>
          <p className={styles.curlHint}>
            Replace <code>&lt;your-lowercase-sha256-hash&gt;</code> with a real 64-character lowercase SHA-256 hash.
          </p>
          <pre className={styles.code}>{curlExample}</pre>
        </section>

        <section className={styles.testFlow}>
          <h2 className={styles.testFlowTitle}>Test Beats in 5 Steps</h2>
          <ol className={styles.testFlowList}>
            <li>Generate a SHA-256 hash locally for any file or payload.</li>
            <li>POST it to <code>/api/v1/beat/timestamp</code>.</li>
            <li>Confirm response includes <code>on_chain.tx_signature</code> and signed <code>receipt</code>.</li>
            <li>Open the Solana explorer URL from the response (devnet) and confirm the transaction exists.</li>
            <li>Fetch <code>/api/v1/beat/key</code> and verify the receipt signature offline.</li>
          </ol>
          <div className={styles.expectedBlock}>
            <strong>Expected response fields:</strong>{' '}
            <code>submitted_hash</code>, <code>anchor.beat_index</code>, <code>on_chain.tx_signature</code>, <code>receipt.signature</code>
          </div>
          <p className={styles.testFlowLinks}>
            Full guide:{' '}
            <a href="https://provenonce.dev/getting-started/beats-only">provenonce.dev/getting-started/beats-only</a>
          </p>
        </section>

        <div className={styles.endpointGrid}>
          {ENDPOINTS.map(([method, href, note]) => (
            <a key={href} href={href} className={styles.endpointCard}>
              <strong className={styles.endpointMethod}>{method}</strong>
              <span className={styles.endpointPath}>{href}</span>
              <div className={styles.endpointNote}>{note}</div>
            </a>
          ))}
        </div>

        <p className={styles.tierNote}>
          Free tier: 5/min and 10/day per IP on timestamping. Optional pro tier token can raise limits.
        </p>

        <footer className={styles.footer}>
          Part of the Provenonce network. <a href="https://provenonce.io">provenonce.io</a>
          {' '}| Beats-only client install:{' '}
          <a href="https://provenonce.dev/getting-started/beats-only">provenonce.dev/getting-started/beats-only</a>
        </footer>
      </div>
    </main>
  );
}
