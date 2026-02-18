import styles from './page.module.css';

const ENDPOINTS = [
  ['GET', '/api/health', 'service telemetry'],
  ['GET', '/api/v1/beat/anchor', 'latest global anchor'],
  ['GET', '/api/v1/beat/key', 'receipt verification key'],
  ['GET', '/api/v1/beat/verify', 'verify API metadata'],
  ['POST', '/api/v1/beat/verify', 'verify beat/chain/proof'],
  ['POST', '/api/v1/beat/timestamp', 'timestamp SHA-256 hash'],
] as const;

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <h1 className={styles.title}>Provenonce Beats</h1>
        <p className={styles.subtitle}>
          Public clock and timestamping service anchored on Solana. Stateless by design.
        </p>

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
      </div>
    </main>
  );
}
