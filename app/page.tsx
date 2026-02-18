'use client';

import { useEffect, useMemo, useState } from 'react';
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
  const [beatIndex, setBeatIndex] = useState<number | null>(null);
  const [beatHash, setBeatHash] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/beat/anchor', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        setBeatIndex(data?.anchor?.beat_index ?? null);
        setBeatHash(data?.anchor?.hash ?? null);
      } catch {
        // Ignore fetch failures on homepage.
      }
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, 15000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const curlExample = useMemo(
    () =>
      `curl -X POST https://beats.provenonce.dev/api/v1/beat/timestamp \\
  -H "content-type: application/json" \\
  -d '{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'`,
    []
  );

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <div className={styles.wordmark}>PROVENONCE</div>
        <h1 className={styles.title}>Provenonce Beats</h1>
        <p className={styles.subtitle}>
          Public clock and timestamping service anchored on Solana. Stateless by design.
        </p>

        <section className={styles.statusCard}>
          <div>
            <div className={styles.label}>Live Beat Index</div>
            <div className={styles.indexValue}>{beatIndex ?? '--'}</div>
          </div>
          <div>
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
