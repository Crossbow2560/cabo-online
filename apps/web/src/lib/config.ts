import { useEffect, useState } from 'react';

/** Runtime settings from the server (read at startup, so one build works on any domain). */
export interface ClientConfig {
  publicUrl: string | null;
  umami: { scriptUrl: string; websiteId: string } | null;
}

let cached: Promise<ClientConfig | null> | null = null;

export function loadConfig(): Promise<ClientConfig | null> {
  cached ??= fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return cached;
}

/** Address to put in invite links: the server's PUBLIC_URL if set, else wherever this page was opened. */
export function usePublicUrl(): string {
  const [url, setUrl] = useState(location.origin);
  useEffect(() => {
    let live = true;
    loadConfig().then((c) => live && c?.publicUrl && setUrl(c.publicUrl));
    return () => {
      live = false;
    };
  }, []);
  return url;
}
