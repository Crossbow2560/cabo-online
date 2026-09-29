/*
 * Cabo browser bot: paste into a tab that's open on the Cabo site, then call
 *
 *   caboBot({ name: 'Bot Ana', room: 'ABC123' })
 *
 * It signs in (or reuses the tab's saved player), joins the room, and plays by clicking
 * the real UI: memorise → draw → keep/discard → abilities → snap → Cabo. It only sees
 * what a human in that seat would see (the DOM and "just you" toasts).
 *
 * Open each bot on its own `?profile=NAME` (or its own origin/browser profile) so bots
 * don't share one identity. See docs/bots.md.
 *
 * Status: window.__caboBot.status() · stop: window.__caboBot.stop()
 */
(function () {
  const POINTS = { A: 1, J: 11, Q: 12 };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.random() * (b - a);
  const btn = (text) => $$('button').find((b) => !b.disabled && b.textContent.trim().startsWith(text));

  /** "7♠" / "10♥" / "K♣" / "Joker" → { rank, red, pts } */
  function parse(label) {
    label = (label || '').trim();
    if (!label || label === '★' || /^joker/i.test(label)) return { rank: 'JOKER', red: false, pts: -1 };
    const suit = label.slice(-1);
    const rank = label.slice(0, -1);
    const red = suit === '♥' || suit === '♦';
    const pts = rank === 'K' ? (red ? 0 : 13) : POINTS[rank] ?? Number(rank);
    return { rank, red, pts };
  }
  const faceOf = (el) => (el && el.classList.contains('pcard--face') ? parse($('.pcard__corner', el)?.textContent) : null);

  function setInput(el, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  window.caboBot = function caboBot(opts) {
    if (window.__caboBot) window.__caboBot.stop();
    const o = {
      name: 'Bot',
      room: '',
      think: [700, 1800], // ms before each move, so a human can follow along
      snap: true, // snap own cards that match the discard
      snapDelay: [600, 1400], // reaction time, keeps snaps winnable for humans
      caboAt: 8, // call CABO when all cards are known and total ≤ this
      caboAfterTurns: 12, // …or after this many own turns regardless
      ...opts,
    };
    const log = (...a) => console.log(`[bot ${o.name}]`, ...a);
    const known = {}; // my slot index → parsed card
    let busy = false;
    let stopped = false;
    let lastKey = '';
    let acted = false;
    let turns = 0;
    let round = null;
    let seenToasts = new WeakSet();
    const history = [];

    const meId = () => $('.mine__hand')?.dataset.seat;
    const mySlots = () =>
      $$('.mine [data-spot^="slot:"]').map((el) => ({ el, i: Number(el.dataset.spot.split(':')[2]), gap: el.classList.contains('pcard--gap') }));
    const oppSlots = () => $$('[data-spot^="slot:"]').filter((el) => !el.closest('.mine') && !el.classList.contains('pcard--gap'));
    const prompt = () => $('.prompt-strip')?.textContent.trim() ?? '';
    const discardTop = () => faceOf($('[data-spot="discard"]'));
    const drawn = () => faceOf($('.pile--drawn .pcard'));

    function remember() {
      for (const s of mySlots()) {
        if (s.gap) delete known[s.i];
        const f = faceOf(s.el);
        if (f) known[s.i] = f;
      }
    }

    // What "just you" toasts and public log lines say about my cards.
    function readToasts() {
      const me = o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const t of $$('.toast')) {
        if (seenToasts.has(t)) continue;
        seenToasts.add(t);
        const text = t.textContent.replace(/^just you/, '').trim();
        let m;
        if ((m = text.match(/^Your slot (\d+) is (.+)$/))) known[m[1] - 1] = parse(m[2]);
        // Someone swapped a card into my hand, or gave me one: I no longer know that slot.
        if ((m = text.match(new RegExp(`(?:with|into) ${me}'s slot (\\d+)`)))) delete known[m[1] - 1];
        // A wrong snap on one of my cards shows it to everyone.
        m = text.match(new RegExp(`^${me} tried to snap their own slot (\\d+) but it was (.+?) —`)) ??
          text.match(new RegExp(`tried to snap ${me}'s slot (\\d+) but it was (.+?) —`));
        if (m) known[m[1] - 1] = parse(m[2]);
      }
    }

    const unknownSlots = () => mySlots().filter((s) => !s.gap && !known[s.i]);
    const worstKnown = () =>
      mySlots()
        .filter((s) => !s.gap && known[s.i])
        .sort((a, b) => known[b.i].pts - known[a.i].pts)[0];

    /** Where to put a card worth `pts`, or null to not keep it. */
    function slotFor(pts) {
      const worst = worstKnown();
      if (worst && pts < known[worst.i].pts) return worst;
      const unk = unknownSlots();
      if (unk.length && pts <= 4) return unk[0];
      return null;
    }

    async function click(el, why) {
      if (!el || stopped) return false;
      history.push(`${new Date().toLocaleTimeString()} ${why}`);
      if (history.length > 50) history.shift();
      log(why);
      acted = true;
      el.click();
      await sleep(400); // let the server answer before deciding again
      return true;
    }

    async function joinFlow() {
      if (btn('Play now')) return click(btn('Play now'), 'play now');
      const nick = $('input.input:not(.code-input)');
      if (nick && $('form button[type="submit"]')) {
        setInput(nick, o.name);
        await sleep(50);
        return click($('form button[type="submit"]'), `nickname ${o.name}`);
      }
      const code = $('input.code-input');
      if (code && o.room) {
        if (code.value !== o.room.toUpperCase()) setInput(code, o.room.toUpperCase());
        await sleep(50);
        return click($('form button[type="submit"]'), `join ${o.room}`);
      }
      if (o.room && btn('Join room')) return click(btn('Join room'), 'open join form');
      if (btn('Use it here')) log('this identity is open in another tab — give each bot its own ?profile=');
      return false;
    }

    async function play() {
      readToasts();
      remember();
      const snapping = !!$('.snap-banner');

      if (snapping) {
        if (!o.snap) return;
        const top = discardTop();
        const match = top && mySlots().find((s) => !s.gap && known[s.i]?.rank === top.rank);
        if (!match) return;
        await sleep(jitter(...o.snapDelay));
        if ($('.snap-banner') && match.el.classList.contains('pcard--selectable')) {
          delete known[match.i];
          await click(match.el, `snap my #${match.i + 1} (${top.rank})`);
        }
        return;
      }
      if (btn("Don't give a card")) return click(btn("Don't give a card"), "don't give");

      if (btn("I've memorised them")) {
        const r = $('.tbar__round')?.textContent;
        if (r !== round) {
          round = r;
          turns = 0;
          for (const k of Object.keys(known)) delete known[k];
          remember();
        }
        await sleep(jitter(1500, 3000));
        remember();
        return click(btn("I've memorised them"), `memorised ${JSON.stringify(Object.fromEntries(Object.entries(known).map(([k, v]) => [+k + 1, v.rank])))}`);
      }

      const stock = $('[data-spot="stock"]');
      const myTurn = stock?.classList.contains('pcard--selectable');
      if (!myTurn && !btn('Swap them') && !btn('Skip ability') && !btn('Discard it')) return;
      await sleep(jitter(...o.think));
      if (stopped) return;

      // Black King decision: swap if theirs is better than mine.
      if (btn('Swap them')) {
        const sel = $$('.pcard--selected').map((el) => ({ el, mine: !!el.closest('.mine'), f: faceOf(el) }));
        const mine = sel.find((s) => s.mine)?.f;
        const theirs = sel.find((s) => !s.mine)?.f;
        const mySlot = sel.find((s) => s.mine)?.el.dataset.spot.split(':')[2];
        if (mine && theirs && theirs.pts < mine.pts) {
          known[mySlot] = theirs;
          return click(btn('Swap them'), `swap (${theirs.rank} for ${mine.rank})`);
        }
        return click(btn('Keep them'), 'keep them');
      }

      // Ability in play.
      if (btn('Skip ability')) {
        const ability = $('.ability-badge')?.textContent ?? '';
        const unk = unknownSlots().filter((s) => s.el.classList.contains('pcard--selectable'));
        if (/Peek at yours/.test(ability) && unk.length) return click(unk[0].el, `peek my #${unk[0].i + 1}`);
        const opp = oppSlots().filter((el) => el.classList.contains('pcard--selectable'));
        if (/Spy|Look/.test(ability) && opp.length) {
          const t = opp[Math.floor(Math.random() * opp.length)];
          return click(t, `look at ${t.title}`);
        }
        if (/Look/.test(ability)) {
          // Black King step 2: look at my worst known card (or any).
          const mine = mySlots().filter((s) => s.el.classList.contains('pcard--selectable'));
          const w = worstKnown();
          const pick = mine.find((s) => w && s.i === w.i) ?? mine[0];
          if (pick) return click(pick.el, `look at my #${pick.i + 1}`);
        }
        return click(btn('Skip ability'), 'skip ability');
      }

      // Drew a card: keep it somewhere or discard it.
      if (btn('Discard it')) {
        const d = drawn();
        const s = d && slotFor(d.pts);
        if (s) {
          known[s.i] = d;
          return click(s.el, `keep ${d.rank} in #${s.i + 1}`);
        }
        return click(btn('Discard it'), `discard ${d?.rank ?? '?'}`);
      }

      // Start of my turn (Call CABO is disabled once someone has called it).
      if ($('[data-spot="stock"]')?.classList.contains('pcard--selectable')) {
        turns++;
        const live = mySlots().filter((s) => !s.gap);
        const total = live.reduce((t, s) => t + (known[s.i]?.pts ?? 99), 0);
        if (btn('Call CABO') && (total <= o.caboAt || turns > o.caboAfterTurns)) return click(btn('Call CABO'), `CABO (known total ${total})`);
        const top = discardTop();
        const s = top && top.pts <= 3 && slotFor(top.pts);
        const pile = $('[data-spot="discard"]');
        if (s && pile.classList.contains('pcard--selectable')) {
          await click(pile, `take discard ${top.rank}`);
          await sleep(300);
          const el = $(`.mine [data-spot="slot:${meId()}:${s.i}"]`);
          if (el?.classList.contains('pcard--selectable')) {
            known[s.i] = top;
            return click(el, `…into #${s.i + 1}`);
          }
          return;
        }
        return click($('[data-spot="stock"]'), 'draw');
      }
    }

    async function tick() {
      if (busy || stopped) return;
      // Only act when something on screen changed since the last decision.
      const key = [
        prompt(),
        $$('.actions button').map((b) => b.textContent).join('|'),
        $$('.pcard--selectable').length,
        !!$('.snap-banner'),
        $('main')?.className,
        $$('button').length,
      ].join('#');
      if (key === lastKey) return;
      lastKey = key;
      busy = true;
      acted = false;
      try {
        if ($('.table-screen')) await play();
        else await joinFlow();
      } catch (e) {
        log('error', e);
      } finally {
        busy = false;
        // After a move, look again even if the screen hasn't visibly changed yet.
        if (acted) {
          lastKey = '';
          setTimeout(tick, 250);
        }
      }
    }

    const obs = new MutationObserver(() => tick());
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled'] });
    const timer = setInterval(tick, 1000);
    tick();

    window.__caboBot = {
      opts: o,
      stop() {
        stopped = true;
        obs.disconnect();
        clearInterval(timer);
        log('stopped');
      },
      status: () => ({
        name: o.name,
        screen: $('.table-screen') ? 'game' : $('.lobby') ? 'lobby' : 'menu',
        prompt: prompt(),
        known: Object.fromEntries(Object.entries(known).map(([k, v]) => [`#${+k + 1}`, v.rank])),
        turns,
        recent: history.slice(-8),
      }),
    };
    log('started', o);
    return 'started';
  };
})();
