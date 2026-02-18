'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'beats_devnet_banner_dismissed_v1';

export function DevnetBanner() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    try {
      const dismissed = window.localStorage.getItem(STORAGE_KEY) === '1';
      setVisible(!dismissed);
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="devnet-banner">
      <div className="devnet-banner-inner">
        <p>Devnet Preview: data may reset, no production guarantees.</p>
        <button
          type="button"
          className="devnet-banner-dismiss"
          onClick={() => {
            try {
              window.localStorage.setItem(STORAGE_KEY, '1');
            } catch {}
            setVisible(false);
          }}
          aria-label="Dismiss devnet notice"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
