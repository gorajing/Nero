# Companion — Run & Integration Guide

Built via multi-agent (Codex + Claude) on 2026-06-19. **8 components, type-check clean together (TS 5.6, 0 src errors), executor live-verified against codex 0.139.0.** The headless-testable core is proven; the steps below are what needs *your Mac + keys* to bring it alive.

## 1. Keys — create `app/.env`
```
NEBIUS_API_KEY=...
NEBIUS_MODEL=deepseek-ai/DeepSeek-R1-0528
NEBIUS_VISION_MODEL=Qwen/Qwen2-VL-72B-Instruct
NEBIUS_EMBED_MODEL=BAAI/bge-en-icl
INSFORGE_URL=https://<project>.insforge.app
INSFORGE_KEY=...
ANTHROPIC_API_KEY=...                 # only if you use the Claude executor (Codex is default)
COMPANION_WORKDIR=/abs/path/to/scratch-git-repo   # the repo the agent actually codes in
```
> Verify Nebius ids first: `curl -s https://api.tokenfactory.nebius.com/v1/models -H "Authorization: Bearer $NEBIUS_API_KEY" | grep -o '"id":"[^"]*"' | head` — catalog rotates; fix the env if an id differs.

## 2. Provision Insforge (once) — run this SQL in your project
```sql
create table if not exists public.memory (
  id uuid primary key default gen_random_uuid(),
  session_id text not null, kind text not null, text text not null,
  payload jsonb, created_at timestamptz default now()
);
create extension if not exists vector;
alter table public.memory add column if not exists embedding vector(1536);
create index if not exists memory_embedding_hnsw on public.memory using hnsw (embedding vector_cosine_ops);
create or replace function public.match_memory(query_embedding vector(1536), k int default 5, p_session_id text default null)
returns table (id uuid, session_id text, kind text, text text, payload jsonb, created_at timestamptz, similarity float)
language sql stable as $func$
  select m.id, m.session_id, m.kind, m.text, m.payload, m.created_at, 1 - (m.embedding <=> query_embedding) as similarity
  from public.memory m
  where m.embedding is not null and (p_session_id is null or m.session_id = p_session_id)
  order by m.embedding <=> query_embedding limit k;
$func$;
```
Then smoke-test: a `remember()` + `recall()` round-trip should return the row with a similarity score.

## 3. The avatar — a hand-built pixel-art cat (default; no assets needed)
The character is a procedurally-drawn 16-bit pixel cat that ships **in code** — it animates through agent state with posture (stands / sits / **walks** while working, with a real leg cycle) and needs **no model files**. It renders out of the box, with no extra setup.

> **Optional — swap in a Live2D model instead.** Drop `live2dcubismcore.min.js` + a Cubism-4 model into `app/public/live2d/` and point `modelUrl` at it (see `app/public/live2d/README.md`). The same model-agnostic `CharacterDriver` facade drives either one, so voice + the event pipeline are unchanged; tune the state→expression/motion map in `stateMachine.ts` to the real model's group names.

## 4. Voice proxy (Vapi → Nebius) — Vapi can't reach localhost, and appends `/chat/completions`
```
# terminal A — start the SSE proxy (listens on :8788)
cd app && npx tsx src/proxy/index.ts
# terminal B — expose it
ngrok http 8788          # copy the https URL
```
Inject renderer config (in `index.html` before the bundle, or via preload):
```js
window.COMPANION_CFG = {
  vapiPublicKey: '...', customLlmUrl: '<ngrok-https-root>',
  customLlmModel: 'deepseek-ai/DeepSeek-R1-0528', voiceId: '<11labs-id>',
  // modelUrl is OPTIONAL — only set it if you added a Live2D model (§3).
  // The default pixel cat needs no path.
};
```
Set the Vapi assistant `model.url` = the **ngrok root** (no `/chat/completions` — Vapi appends it).

## 5. macOS permissions
Grant **Microphone** + **Screen Recording** to the launching binary; **relaunch** after granting (TCC grants bind to the app/signing identity).

## 6. Run
```
cd app && npm start
```
Summon (Cmd+Shift+Space) → click **Start** (mic-gesture gate) → speak a task → the character thinks (Nebius `reasoning_content`) → drives Codex in `COMPANION_WORKDIR` (each action narrated + animated) → writes to Insforge memory. Then ask *"what did we do?"* for the pgvector recall beat.

### Optional floating character window

For a no-border character demo, run with:

```
COMPANION_FLOATING_WINDOW=1 npm start
```

This keeps the normal window as the default. The opt-in mode shrinks the
Electron window, removes the frame, makes the background transparent, and hides
every overlay panel so the only visible surface is the cat. Use the normal app
window for controls and debugging.

## Proven vs. needs-your-machine
- **✅ Proven headlessly:** all 8 modules type-check together (0 src errors); executor live-verified vs real codex 0.139.0; renderer Vite build OK (500 modules); brain/memory/vision/proxy code-complete + scoped-clean.
- **⚠️ Not yet run (needs Mac + keys):** Electron GUI; mic TCC prompt; Vapi voice call; live Nebius (decide/vision/embed); Insforge round-trip (after §2); screen capture (after §5 grant). *(The pixel-cat avatar needs none of these — it renders in code. Only an **optional** Live2D model swap is untested.)*

## Known notes
- Codex v0.139.0 emits no standalone `reasoning` events (CoT folds into `agent_message`) → the "thinking" animation is driven by the **Nebius brain's** `reasoning_content`, not Codex.
- Claude executor path is unit-checked but not live-run (no key during build) — smoke-test once `ANTHROPIC_API_KEY` is set.
- Absolute exec paths hardcoded with env overrides: `COMPANION_CODEX_BIN`, `COMPANION_CLAUDE_BIN`.
