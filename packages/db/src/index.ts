// Load .env from the monorepo root BEFORE instantiating PrismaClient.
// Prisma reads DATABASE_URL at construction, and services that import
// @cmc/db (services/recording, janitor, failover-controller, ai-scheduler,
// apps/api) all start with a per-package cwd — so relative `.env` lookups
// need to walk up the tree.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (typeof process !== 'undefined' && !process.env.DATABASE_URL) {
  for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
    const full = resolve(process.cwd(), p);
    if (existsSync(full)) {
      try {
        (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile(full);
        break;
      } catch { /* Node < 20.6 — user must set env vars manually */ }
    }
  }
}

import { PrismaClient } from '@prisma/client';

declare global {

  var __demp_prisma: PrismaClient | undefined;
}

export const prisma =
  global.__demp_prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__demp_prisma = prisma;
}

export * from '@prisma/client';
