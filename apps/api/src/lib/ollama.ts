import { request } from 'undici';
import { env } from '../env.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Stream a chat completion from a local Ollama instance.
 *
 * We use the native `/api/chat` endpoint with `stream: true` — Ollama emits
 * one JSON object per line (NDJSON). Each object contains a `message.content`
 * chunk. We forward each chunk to the caller via the async iterator.
 *
 * No internet dependency: Ollama runs on the same host; the model has been
 * pre-pulled into the mounted volume.
 */
export async function *streamChat(messages: ChatMessage[], opts?: { model?: string; temperature?: number; abort?: AbortSignal }): AsyncGenerator<string, { model: string; totalTokens: number; promptTokens: number }, void> {
  const model = opts?.model ?? env.GPT_MODEL;
  const res = await request(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature: opts?.temperature ?? env.GPT_TEMPERATURE },
    }),
    signal: opts?.abort,
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`ollama chat ${res.statusCode}: ${body.slice(0, 200)}`);
  }
  let buf = '';
  let promptTokens = 0, completionTokens = 0;
  for await (const chunk of res.body) {
    buf += chunk.toString();
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      try {
        const j = JSON.parse(line) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
          done?: boolean;
        };
        if (j.message?.content) yield j.message.content;
        if (typeof j.prompt_eval_count === 'number') promptTokens = j.prompt_eval_count;
        if (typeof j.eval_count === 'number')        completionTokens = j.eval_count;
      } catch { /* skip malformed line */ }
    }
  }
  return { model, promptTokens, totalTokens: promptTokens + completionTokens };
}

export async function isOllamaReachable(): Promise<boolean> {
  try {
    const r = await request(`${env.OLLAMA_URL}/api/tags`, { method: 'GET' });
    return r.statusCode < 400;
  } catch { return false; }
}

export async function listModels(): Promise<Array<{ name: string; size: number }>> {
  const r = await request(`${env.OLLAMA_URL}/api/tags`, { method: 'GET' });
  if (r.statusCode >= 400) return [];
  const j = await r.body.json() as { models?: Array<{ name: string; size: number }> };
  return j.models ?? [];
}
