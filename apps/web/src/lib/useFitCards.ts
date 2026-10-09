import { useLayoutEffect, type RefObject } from 'react';

/**
 * Sizes the table's cards to the largest that fit on one screen, with nothing scrolling or spilling.
 *
 * CSS alone can't know how many seats, cards and buttons share a row, so this measures: it tries a
 * card size, checks every seat, pile, hand and button sits inside its row and inside the table, and
 * binary-searches the biggest size that does. Three passes:
 *   1. everything together (large = mine, medium = piles ≈ 0.89, small = opponents ≈ 0.65);
 *   2. if the opponents' row was the limit, grow my hand and the piles on their own;
 *   3. if my hand was the limit, grow the opponents' cards (never past 0.8 of mine).
 * It sets --card-lg / --card-md / --card-sm on the table, which override the CSS defaults.
 */
const MIN = 22;
const MAX = 150;
const SM_MAX_RATIO = 0.8;
const ITEMS = '.seat, .mine__hand, .actions, .pile, .prompt-strip';
const REGIONS = '.seats, .seats-side, .felt, .mine';

export function useFitCards(ref: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;

    const set = (lg: number, md: number, sm: number) => {
      table.style.setProperty('--card-lg', `${lg}px`);
      table.style.setProperty('--card-md', `${md}px`);
      table.style.setProperty('--card-sm', `${sm}px`);
    };

    const inside = (r: DOMRect, box: { left: number; top: number; right: number; bottom: number }) =>
      r.left >= box.left - 1 && r.top >= box.top - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1;

    const fits = () => {
      const t = table.getBoundingClientRect();
      const cs = getComputedStyle(table);
      const inner = {
        left: t.left + table.clientLeft + parseFloat(cs.paddingLeft) * 0.5,
        top: t.top + table.clientTop + parseFloat(cs.paddingTop) * 0.5,
        right: t.right - table.clientLeft - parseFloat(cs.paddingRight) * 0.5,
        bottom: t.bottom - table.clientTop - parseFloat(cs.paddingBottom) * 0.5,
      };
      for (const el of table.querySelectorAll<HTMLElement>(ITEMS)) {
        if (el.closest('.results, .paused-overlay')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (!inside(r, inner)) return false;
        const region = el.parentElement?.closest<HTMLElement>(REGIONS);
        // A row that scrolls (the opponents' row) or a felt that spills shows up as an item outside it.
        if (region && getComputedStyle(region).display !== 'contents' && !inside(r, region.getBoundingClientRect())) return false;
      }
      return true;
    };

    /** Largest whole-pixel value in [lo, hi] for which `ok` holds (lo if none). */
    const search = (lo: number, hi: number, ok: (v: number) => boolean) => {
      lo = Math.floor(lo);
      hi = Math.floor(hi);
      if (hi <= lo) return lo;
      if (ok(hi)) return hi;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };

    const fit = () => {
      const all = (s: number) => (set(s, s * 0.89, s * 0.65), fits());
      const s = search(MIN, MAX, all);
      const sm0 = Math.round(s * 0.65);
      const lg = search(s, MAX, (v) => (set(v, v * 0.89, sm0), fits()));
      const md = Math.round(lg * 0.89);
      const sm = search(sm0, Math.max(sm0, lg * SM_MAX_RATIO), (v) => (set(lg, md, v), fits()));
      set(lg, md, sm);
    };

    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    };
    fit();
    // The table's own size only changes with the window (card sizes never change it), so no loop.
    const ro = new ResizeObserver(refit);
    ro.observe(table);
    document.fonts?.ready.then(refit);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, key]);
}
