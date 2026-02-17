const DEFAULT_BASE_URL = 'https://beats.provenonce.dev';

export function createBeatsClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const request = async (path, init = {}) => {
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  return {
    getHealth() {
      return request('/api/health');
    },
    getAnchor() {
      return request('/api/v1/beat/anchor');
    },
    getKey() {
      return request('/api/v1/beat/key');
    },
    verify(payload) {
      return request('/api/v1/beat/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    timestampHash(hash) {
      return request('/api/v1/beat/timestamp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
    },
  };
}

