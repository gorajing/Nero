# Nero — Run & Integration Guide

Built via multi-agent (Codex + Claude) on 2026-06-19. **8 components, type-check clean together (TS 5.6, 0 src errors), executor live-verified against codex 0.139.0.** The headless-testable core is proven; the steps below are what needs *your Mac + keys* to bring it alive.

## 1. Keys — create `.env`
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
> Nero still uses the `COMPANION_*` env prefix for compatibility with the existing runtime config and IPC surfaces.

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

## 3. Live2D model (optional — Nero works without it)
Drop `live2dcubismcore.min.js` + a Cubism-4 model into `public/live2d/` (default `public/live2d/Haru.model3.json`). See `public/live2d/README.md`. Without it Nero renders as the built-in pixel cat (fully functional — same `CharacterDriver` API). Tune the state→expression/motion map to the real model's group names.

## 4. Voice proxy (Vapi → Nebius) — Vapi can't reach localhost, and appends `/chat/completions`
```
# terminal A — start the SSE proxy (listens on :8788)
npx tsx src/proxy/index.ts
# terminal B — expose it
ngrok http 8788          # copy the https URL
```
Inject renderer config (in `index.html` before the bundle, or via preload):
```js
window.COMPANION_CFG = {
  vapiPublicKey: '...', customLlmUrl: '<ngrok-https-root>',
  customLlmModel: 'deepseek-ai/DeepSeek-R1-0528', voiceId: '<11labs-id>',
  modelUrl: '/live2d/Haru.model3.json',
};
```
Set the Vapi assistant `model.url` = the **ngrok root** (no `/chat/completions` — Vapi appends it).

## 5. macOS permissions
Grant **Microphone** + **Screen Recording** to the launching binary; **relaunch** after granting (TCC grants bind to the app/signing identity).

## 6. Run
```
npm start
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
- **⚠️ Not yet run (needs Mac + keys):** Electron GUI; mic TCC prompt; Vapi voice call; live Nebius (decide/vision/embed); Insforge round-trip (after §2); screen capture (after §5 grant); the Live2D model.

## Known notes
- Codex v0.139.0 emits no standalone `reasoning` events (CoT folds into `agent_message`) → the "thinking" animation is driven by the **Nebius brain's** `reasoning_content`, not Codex.
- Claude executor path is unit-checked but not live-run (no key during build) — smoke-test once `ANTHROPIC_API_KEY` is set.
- Absolute exec paths hardcoded with env overrides: `COMPANION_CODEX_BIN`, `COMPANION_CLAUDE_BIN`.
