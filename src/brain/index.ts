import OpenAI from 'openai';

import type { Command, Decision, DecideInput } from '../shared/brain';

declare const process: { env: Record<string, string | undefined> };

export type { Command, Decision, DecideInput } from '../shared/brain';

export interface DecideOptions {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
}

export interface ScreenInput {
  b64: string;
  mime: string;
}

export interface ModelIds {
  reason: string;
  vision: string;
  embed: string;
}

export interface PreflightResult {
  required: ModelIds;
  found: string[];
  missing: string[];
}

type JsonRecord = Record<string, unknown>;

type ChatDeltaWithReasoning = {
  content?: string | null;
  reasoning_content?: string | null;
};

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';
const EMBEDDING_DIM = 1536;

const DEFAULT_MODELS: ModelIds = {
  reason: 'deepseek-ai/DeepSeek-V3.2',
  vision: 'Qwen/Qwen2.5-VL-72B-Instruct',
  embed: 'Qwen/Qwen3-Embedding-8B',
};

const COMMANDS: Command[] = ['run_agent', 'answer', 'capture_screen', 'clarify'];

const SYSTEM_PROMPT = `You are Nero, the brain of a desktop pixel-cat coding agent. The user talks to you by voice; an animated character speaks your words and a coding agent executes your commands.

You MUST respond with a SINGLE JSON object and nothing else:
{
  "narration": string,
  "command": "run_agent" | "answer" | "capture_screen" | "clarify",
  "args": object
}

COMMAND CONTRACT:
- "run_agent": dispatch a coding task to the executor. args = { "task": string, "cwd": string|null }.
  The executor is a coding agent with FULL read/write access to the project files — it can open,
  read, search, edit, and run code on its own. It does NOT need a screenshot to inspect code.
- "answer": just talk, no coding action. args = {}.
- "capture_screen": you need to SEE the user's screen to proceed. args = {}.
- "clarify": the request is ambiguous; ask one question. args = { "question": string }.

RULES:
- narration is spoken by the avatar, so keep it under 25 words and never include code, markdown, or JSON.
- Put all technical detail in args.task, not in narration.
- DEFAULT to "run_agent" for any coding, debugging, file, test, or build task — the executor reads and
  edits the project itself. Naming a file (e.g. "fix calc.py") is NOT a reason to capture the screen.
- Choose "capture_screen" ONLY when the request refers to something VISIBLE ON SCREEN that is not in the
  codebase — e.g. "what's this error on my screen", "look at what I'm seeing", a GUI/app/browser state.
- If RELEVANT MEMORY is provided, use it for project paths, user preferences, and prior context.
- If CURRENT SCREEN is provided, use it as visual context.
- Output only the JSON object. Do not wrap it in markdown fences.

EXAMPLE:
USER SAID: "add a health check endpoint to my api"
{"narration":"On it. I will add the health check now.","command":"run_agent","args":{"task":"Add a GET /health endpoint returning {status:'ok'} with HTTP 200 to the existing API. Wire it into the main router and update or add the focused test.","cwd":null}}`;

let cachedClient: OpenAI | null = null;
let cachedApiKey: string | null = null;

export function getModelIds(): ModelIds {
  return {
    reason: process.env.NEBIUS_MODEL || DEFAULT_MODELS.reason,
    vision: process.env.NEBIUS_VISION_MODEL || DEFAULT_MODELS.vision,
    embed: process.env.NEBIUS_EMBED_MODEL || DEFAULT_MODELS.embed,
  };
}

export async function preflight(): Promise<PreflightResult> {
  const models = getModelIds();
  const requiredIds = [models.reason, models.vision, models.embed];
  const list = await getNebiusClient().models.list();
  const availableIds = list.data.map((model) => model.id);
  const found = requiredIds.filter((id) => availableIds.indexOf(id) !== -1);
  const missing = requiredIds.filter((id) => availableIds.indexOf(id) === -1);
  const result = { required: models, found, missing };

  if (missing.length > 0) {
    throw new Error(
      `Nebius models missing: ${missing.join(', ')}. Available sample: ${availableIds.slice(0, 20).join(', ')}`,
    );
  }

  return result;
}

export async function decide(input: DecideInput, options: DecideOptions = {}): Promise<Decision> {
  const models = getModelIds();
  const stream = await getNebiusClient().chat.completions.create({
    model: models.reason,
    stream: true,
    temperature: 0.3,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildDecisionPrompt(input) },
    ],
  });

  let content = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as ChatDeltaWithReasoning | undefined;

    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      options.onReasoning?.(delta.reasoning_content);
    }

    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      options.onContent?.(delta.content);
    }
  }

  return parseDecision(content);
}

export async function describeScreen(input: ScreenInput): Promise<string> {
  const models = getModelIds();
  const dataUri = toImageDataUri(input);
  const response = await getNebiusClient().chat.completions.create({
    model: models.vision,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this screen for a coding assistant. Focus on visible apps, editor content, errors, terminal output, and UI state. Be concise.',
          },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Nebius vision returned empty content');
  }

  return content.trim();
}

export async function embed(text: string): Promise<number[]>;
export async function embed(text: string[]): Promise<number[][]>;
export async function embed(text: string | string[]): Promise<number[] | number[][]> {
  assertEmbeddableInput(text);

  const models = getModelIds();
  const response = await getNebiusClient().embeddings.create({
    model: models.embed,
    input: text,
    encoding_format: 'float',
    dimensions: EMBEDDING_DIM,
  });

  const vectors = response.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(`Expected ${EMBEDDING_DIM}-dim embedding, got ${vector.length}`);
    }
  }

  return Array.isArray(text) ? vectors : vectors[0];
}

function getNebiusClient(): OpenAI {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) {
    throw new Error('NEBIUS_API_KEY is required for Nebius Brain calls');
  }

  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new OpenAI({
      baseURL: NEBIUS_BASE_URL,
      apiKey,
      maxRetries: 2,
      timeout: 60_000,
    });
    cachedApiKey = apiKey;
  }

  return cachedClient;
}

function buildDecisionPrompt(input: DecideInput): string {
  return [
    input.memory ? `RELEVANT MEMORY:\n${input.memory}` : '',
    input.screen ? `CURRENT SCREEN:\n${input.screen}` : '',
    `USER SAID: ${JSON.stringify(input.transcript)}`,
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function parseDecision(raw: string): Decision {
  const json = extractJsonObject(raw);
  const parsed = JSON.parse(json) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`Brain JSON was not an object: ${raw.slice(0, 200)}`);
  }

  const narration = parsed.narration;
  const command = parsed.command;
  const args = parsed.args;

  if (typeof narration !== 'string' || narration.trim().length === 0) {
    throw new Error(`Brain JSON missing narration: ${raw.slice(0, 200)}`);
  }

  if (!isCommand(command)) {
    throw new Error(`Brain JSON had invalid command: ${String(command)}`);
  }

  if (args !== undefined && !isRecord(args)) {
    throw new Error(`Brain JSON args must be an object for command ${command}`);
  }

  return {
    narration: narration.trim(),
    command,
    args: (args ?? {}) as Record<string, unknown>,
  };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Brain returned no JSON object: ${raw.slice(0, 200)}`);
  }

  return withoutFence.slice(start, end + 1);
}

function toImageDataUri(input: ScreenInput): string {
  if (!input.b64.trim()) {
    throw new Error('describeScreen requires a non-empty b64 image');
  }

  if (!/^image\/[a-z0-9.+-]+$/i.test(input.mime)) {
    throw new Error(`describeScreen mime must be an image/* type, got ${input.mime}`);
  }

  if (/^data:/i.test(input.b64.trim())) {
    throw new Error('describeScreen expects raw base64 image data, not a data URI');
  }

  return `data:${input.mime};base64,${input.b64.replace(/\s+/g, '')}`;
}

function assertEmbeddableInput(input: string | string[]): void {
  if (typeof input === 'string') {
    if (input.length === 0) {
      throw new Error('embed requires a non-empty string');
    }
    return;
  }

  if (input.length === 0) {
    throw new Error('embed requires at least one string');
  }

  for (const item of input) {
    if (item.length === 0) {
      throw new Error('embed does not accept empty strings');
    }
  }
}

function isCommand(value: unknown): value is Command {
  return typeof value === 'string' && COMMANDS.indexOf(value as Command) !== -1;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
