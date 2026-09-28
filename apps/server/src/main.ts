import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCaboServer } from './server';
import { MemoryStore, PgStore, type Store } from './store';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../.env')); // apps/server/.env (gitignored)
} catch {
  /* no .env — rely on the real environment */
}

const url = process.env.DATABASE_URL;
const store: Store = url ? new PgStore(url) : new MemoryStore();
if (!url) console.warn('DATABASE_URL not set — using in-memory storage (nothing survives a restart)');

let publicUrl = process.env.PUBLIC_URL?.trim() || null;
if (publicUrl) {
  try {
    publicUrl = new URL(publicUrl).origin;
    console.log(`Public URL: ${publicUrl}`);
  } catch {
    console.warn(`PUBLIC_URL "${publicUrl}" is not a valid URL — ignoring it`);
    publicUrl = null;
  }
}

// Dev/testing only: CABO_SEED deals every round from a fixed seed, so the deck order is known.
const seedEnv = process.env.CABO_SEED?.trim();
const fixedSeed = seedEnv && Number.isInteger(Number(seedEnv)) ? Number(seedEnv) : null;
if (fixedSeed !== null) console.warn(`⚠ CABO_SEED=${fixedSeed}: every round deals the SAME deck. For testing only — never set this in production.`);

const server = await createCaboServer({ store, publicUrl, fixedSeed, webDist: path.resolve(here, '../../web/dist') });
const port = await server.listen(Number(process.env.PORT ?? 3101));
console.log(`Cabo server listening on :${port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await server.close();
    await store.close();
    process.exit(0);
  });
}
