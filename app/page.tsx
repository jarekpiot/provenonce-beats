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
  -d '{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'`;

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
          <pre className={styles.code}>{curlExample}</pre>
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
        </footer>
      </div>
    </main>
  );
}
