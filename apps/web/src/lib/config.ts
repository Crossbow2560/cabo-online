import { useEffect, useState } from 'react';

let cached: Promise<string | null> | null = null;

function loadPublicUrl() {
  cached ??= fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { publicUrl?: string | null } | null) => c?.publicUrl ?? null)
    .catch(() => null);
  return cached;
}

/** Address to put in invite links: the server's PUBLIC_URL if set, else wherever this page was opened. */
export function usePublicUrl(): string {
  const [url, setUrl] = useState(location.origin);
  useEffect(() => {
    let live = true;
    loadPublicUrl().then((u) => live && u && setUrl(u));
    return () => {
      live = false;
    };
  }, []);
  return url;
}
