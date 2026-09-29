/**
 * Game sounds (Web Audio). Card sounds: "Casino Audio" by Kenney (kenney.nl, CC0), in public/sounds.
 *
 * Volumes chain master → game / music, each 0..1, saved per browser. Browsers only allow audio
 * after the player interacts with the page, so nothing plays until the first tap or key press;
 * sounds are also skipped while the tab is hidden, like the animations.
 */
import { useSyncExternalStore } from 'react';

export type SoundName = 'slide' | 'place' | 'shove' | 'fan' | 'reveal' | 'shuffle' | 'turn' | 'cabo';

/** Several recordings per sound, picked at random so repeats don't sound mechanical. */
const FILES: Record<SoundName, string[]> = {
  slide: ['card-slide-1', 'card-slide-2', 'card-slide-3', 'card-slide-4'], // a card leaves the stock
  place: ['card-place-1', 'card-place-2', 'card-place-3', 'card-place-4'], // a card lands
  shove: ['card-shove-1', 'card-shove-2'], // two cards trade places; a wrong snap
  fan: ['card-fan-1'], // a card is lifted to be looked at
  reveal: ['card-fan-2'], // round over: every hand turns up
  shuffle: ['card-shuffle'], // a new round is dealt
  turn: ['chip-lay-1'], // it's your turn
  cabo: ['chips-collide-1'], // someone called CABO
};

export interface SoundSettings {
  master: number;
  game: number;
  music: number;
  muted: boolean;
}

const KEY = 'cabo.sound';
const DEFAULTS: SoundSettings = { master: 0.8, game: 0.8, music: 0.5, muted: false };

let settings: SoundSettings = load();
const listeners = new Set<() => void>();

function load(): SoundSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return s ? { ...DEFAULTS, ...s } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function getSoundSettings() {
  return settings;
}

export function setSoundSettings(patch: Partial<SoundSettings>) {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings last for this page only */
  }
  applyVolumes();
  listeners.forEach((l) => l());
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );
}

// ---------------------------------------------------------------- audio graph

let ctx: AudioContext | null = null;
let masterGain: GainNode;
let gameGain: GainNode;
/** Reserved for background music (not added yet). */
let musicGain: GainNode;
const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<void>>();
const lastPlayed = new Map<SoundName, number>();

function applyVolumes() {
  if (!ctx) return;
  const t = ctx.currentTime;
  masterGain.gain.setTargetAtTime(settings.muted ? 0 : settings.master, t, 0.02);
  gameGain.gain.setTargetAtTime(settings.game, t, 0.02);
  musicGain.gain.setTargetAtTime(settings.music, t, 0.02);
}

function loadFile(file: string): Promise<void> {
  if (!ctx) return Promise.resolve();
  let p = loading.get(file);
  if (!p) {
    const c = ctx;
    p = fetch(`${import.meta.env.BASE_URL}sounds/${file}.mp3`)
      .then((r) => r.arrayBuffer())
      .then((b) => c.decodeAudioData(b))
      .then((buf) => void buffers.set(file, buf))
      .catch((e) => console.warn('[sound]', file, e));
    loading.set(file, p);
  }
  return p;
}

/** Create the audio graph on the first interaction (browsers block audio before one) and preload. */
function unlock() {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    masterGain = ctx.createGain();
    gameGain = ctx.createGain();
    musicGain = ctx.createGain();
    gameGain.connect(masterGain);
    musicGain.connect(masterGain);
    masterGain.connect(ctx.destination);
    applyVolumes();
    for (const files of Object.values(FILES)) files.forEach((f) => void loadFile(f));
  }
  if (ctx.state === 'suspended') void ctx.resume();
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, unlock, { capture: true, passive: true });
}

/**
 * Play a game sound `delay` ms from now. Quietly does nothing when muted, before the first
 * interaction, while the tab is hidden, or if the clip hasn't loaded yet.
 */
export function playSound(name: SoundName, { delay = 0, volume = 1 }: { delay?: number; volume?: number } = {}) {
  if (!ctx || ctx.state !== 'running' || document.hidden) return;
  if (settings.muted || settings.master === 0 || settings.game === 0) return;
  // Many cards moving at once (the deal, a reveal) shouldn't pile up into noise.
  const at = performance.now() + delay;
  if (Math.abs(at - (lastPlayed.get(name) ?? -1e9)) < 45) return;
  lastPlayed.set(name, at);
  const files = FILES[name];
  const file = files[Math.floor(Math.random() * files.length)];
  const buf = buffers.get(file);
  if (!buf) return void loadFile(file);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.94 + Math.random() * 0.12; // slight variety
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(gameGain);
  src.start(ctx.currentTime + Math.max(0, delay) / 1000);
}
