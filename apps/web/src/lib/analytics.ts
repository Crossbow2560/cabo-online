import { loadConfig } from './config';

/**
 * Umami analytics (cookie-free). The server says where the script lives (UMAMI_SCRIPT_URL /
 * UMAMI_WEBSITE_ID); with either unset nothing is loaded and `track` does nothing.
 * Umami counts page views on its own; `track` adds game events (see docs/analytics.md).
 */
declare global {
  interface Window {
    umami?: { track(event: string, data?: Record<string, string | number | boolean>): void };
  }
}

export function initAnalytics() {
  loadConfig().then((c) => {
    if (!c?.umami || document.querySelector('script[data-website-id]')) return;
    const s = document.createElement('script');
    s.defer = true;
    s.src = c.umami.scriptUrl;
    s.dataset.websiteId = c.umami.websiteId;
    document.head.appendChild(s);
  });
}

/** Record a game event. Never throws: analytics must not break the game (or be blocked into it). */
export function track(event: string, data?: Record<string, string | number | boolean>) {
  try {
    window.umami?.track(event, data);
  } catch {
    /* blocked or not loaded */
  }
}
