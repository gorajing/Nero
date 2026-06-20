declare const require: {
  (moduleName: string): any;
  main?: unknown;
};
declare const module: unknown;
declare const process: {
  env: Record<string, string | undefined>;
};

const express = require('express');

const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.2';
const NEBIUS_COMPLETIONS_URL = 'https://api.tokenfactory.nebius.com/v1/chat/completions';
const VAPI_META_FIELDS = new Set(['call', 'metadata', 'phoneNumber', 'customer', 'timestamp']);

type JsonRecord = Record<string, unknown>;

interface ProxyRequest {
  body?: unknown;
}

interface ProxyResponse {
  statusCode: number;
  headersSent: boolean;
  status(code: number): ProxyResponse;
  type(contentType: string): ProxyResponse;
  json(body: unknown): unknown;
  send(body: string): unknown;
  setHeader(name: string, value: string): void;
  flushHeaders?: () => void;
  write(chunk: Uint8Array | string): boolean;
  end(): void;
}

export interface ProxyServer {
  close(callback?: () => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): ProxyServer;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildNebiusBody(body: unknown): JsonRecord {
  const incoming = isJsonRecord(body) ? body : {};
  const outbound: JsonRecord = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (!VAPI_META_FIELDS.has(key)) {
      outbound[key] = value;
    }
  }

  outbound.model = process.env.NEBIUS_MODEL ?? DEFAULT_MODEL;
  outbound.stream = true;
  return outbound;
}

async function streamChatCompletions(req: ProxyRequest, res: ProxyResponse): Promise<void> {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'NEBIUS_API_KEY is not configured' } });
    return;
  }

  const upstream = await fetch(NEBIUS_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildNebiusBody(req.body)),
  });

  if (!upstream.ok) {
    const contentType = upstream.headers.get('content-type') ?? 'text/plain';
    const message = await upstream.text();
    res.status(upstream.status).type(contentType).send(message);
    return;
  }

  if (!upstream.body) {
    res.status(502).json({ error: { message: 'Nebius returned an empty streaming body' } });
    return;
  }

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: { message } });
      return;
    }
  }

  res.end();
}

function createApp() {
  const app = express();

  app.use(express.json({ limit: '4mb' }));
  app.get('/health', (_req: unknown, res: ProxyResponse) => {
    res.json({ ok: true });
  });
  app.post('/chat/completions', (req: ProxyRequest, res: ProxyResponse) => {
    streamChatCompletions(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(502).json({ error: { message } });
        return;
      }
      res.end();
    });
  });

  return app;
}

export function startProxy(port: number): ProxyServer {
  const server = createApp().listen(port, '127.0.0.1') as ProxyServer;
  server.on('listening', () => {
    console.log(`[proxy] listening on http://127.0.0.1:${port}`);
  });
  return server;
}

if (require.main === module) {
  startProxy(Number(process.env.PORT || 8788));
}
