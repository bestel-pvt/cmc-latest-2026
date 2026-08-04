import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env from the monorepo root (env vars from the process still win).
for (const p of ['../../.env', '../.env', '.env']) {
  const full = resolve(process.cwd(), p);
  if (existsSync(full)) {
    try { (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile(full); break; }
    catch { /* Node < 20.6 — user must set env vars manually */ }
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  MEDIAMTX_API_URL: z.string().url().default('http://localhost:9997'),
  MEDIAMTX_METRICS_URL: z.string().url().default('http://localhost:9998/metrics'),
  MEDIAMTX_HLS_URL: z.string().url().default('http://localhost:8888'),
  MEDIAMTX_CONFIG_PATH: z.string().default('./infra/mediamtx/mediamtx.yml'),
  RECORDINGS_DIR: z.string().default('./data/recordings'),
  CLIPS_DIR: z.string().default('./data/clips'),
  MANIFEST_SIGNING_KEY: z.string().default('dev-only'),
  RETENTION_DAYS: z.coerce.number().default(30),
  AIR_GAP_MODE: z.coerce.boolean().default(false),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  GPT_MODEL: z.string().default('qwen2.5:3b-instruct'),
  GPT_MAX_CONTEXT_CHUNKS: z.coerce.number().default(20),
  GPT_TEMPERATURE: z.coerce.number().default(0.3),
  GPT_UPLOAD_DIR: z.string().default('./data/uploads'),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
