# Nero — Recommended Architecture (fresh, 2026)

**Status:** Research-backed proposal for review · **Date:** 2026-06-20 · Companion to the product plan.

> Researched fresh across every layer against current (2026) options, grounded in the locked strategy: an **open-source, local-first client** (free, BYO-keys) + a **paid hosted tier** (the un-copyable moat), one codebase, ship soon, always-on, 2-person team.

---

## The one idea that makes the whole thing work

**Replicate the proven `ActionEvent` adapter pattern at *every* layer.** The hackathon's best decision was normalizing two different coding-agent CLIs into one frozen 11-kind event union behind an `Executor` facade — so the rest of the app never knew or cared which agent ran. We make that the architectural law: a **provider interface at each seam**, with a *local adapter* and a *hosted adapter* behind it.

```
BrainProvider      decide(ctx) → stream of {reasoning_delta, narration_delta, command, args}
ExecutorProvider   run(opts)   → AsyncIterable<ActionEvent>      (the frozen 11-kind union)
StorageProvider    upsert / query(vec,k) / getProfile / patchProfile
AuthProvider       session / owner_id
```

**Mode (free-local vs paid-hosted) becomes a config swap behind these interfaces — never a fork of the client.** This is what makes "one client, two modes" real, and it's why the free→Pro upgrade is "log in and your local data uploads," not a rewrite.

---

## Recommended stack at a glance

| Layer | Pick | Why (one line) | Confidence |
|---|---|---|---|
| **Desktop shell** | **Stay on Electron 42** (forge + Vite) | Tauri's macOS WKWebView *still* breaks the exact 3 things Nero needs — mic, screen-capture, transparent click-through — in 2026. | **High** |
| **Avatar render** | **Procedural cat on PixiJS v8** + an event-driven **frame governor** | v8 static frame ≈ 0.12ms (vs 21ms v7); kill the rAF when occluded → near-zero idle battery. | **High** |
| **Agent exec (local)** | **Claude Agent SDK + Codex SDK** | Kills the hardcoded-path / `--verbose`-coupling / PATH-strip footguns; emits the same event shapes the mappers already parse. | **High** |
| **Agent exec (hosted)** | **E2B Firecracker sandboxes** running identical `claude --output-format stream-json` | microVM isolation for a stranger's repo; snapshot/resume in 5–30ms = "feels instant." | **High** |
| **Memory substrate** | **Postgres + pgvector — *everywhere*** (PGlite embedded local ↔ any hosted Postgres: Neon/Supabase/self-host) | Open standard, runs both modes, `pg_dump` to exit — **no Redis lock-in for the moat**. | **High** \* |
| **The moat itself** | **You own it**: a typed, confidence-scored profile (portable JSON) + your own `MemoryDistiller`, behind `StorageProvider` | The DB is a swappable ~200-line adapter; the *only* real lock-in is the embedding model, not the engine. | **High** |
| **Redis credits ($2,500)** | Spend on **swappable plumbing only** — Streams (transport) + LangCache (semantic cache) | Rip-out-able without touching memory; the moat never sits on a single vendor. | **High** |
| **Accounts / sync / transport** | **better-auth** (OSS, Electron plugin) · **pull-on-login** (no CRDT) · **SSE over Redis Streams** | Same auth lib in both modes; SSE auto-reconnects + Last-Event-ID replay; CRDT is over-engineering for single-writer data. | **High** |
| **Brain / LLM** | **`BrainProvider`**: hosted = **Claude Haiku 4.5**, local = **BYO / Ollama**, **LangCache** in front | Haiku is fast (~0.75s TTFT), cheap ($1/$5), *native structured outputs* + a thinking stream → snappy + reliable JSON. | **High** |

---

## Topology

```
                       ┌──────────────────────────────────────────────┐
                       │              ONE ELECTRON CLIENT             │
                       │      (Electron 42 · Vite · procedural cat)   │
  renderer ────────────│  PixiJS v8 cat + frame governor              │
                       │     ASLEEP/occluded → app.stop() (0 fps)     │
                       │     idle → 8–12fps · attentive → 30fps       │
                       │     active(trick) → 60fps                    │
                       │  MoodCore = orthogonal mood vector           │
                       │            (modulates pose params)           │
                       │                                              │
  main process ────────│   ▼▼  provider interfaces (the seams)  ▼▼    │
                       │  BrainProvider  ExecutorProvider             │
                       │  StorageProvider  AuthProvider               │
                       └──────┬─────────────────────────────┬─────────┘
                              │                              │
            LOCAL / FREE mode │                              │ HOSTED / PRO mode
         (BYO keys, on-device)│   same client, config swap   │ (managed, synced)
                              ▼                              ▼
   Brain     BYO key or Ollama (local, $0)        Claude Haiku 4.5 + LangCache
   Executor  Claude Agent SDK / Codex SDK          E2B Firecracker microVM
             (local subprocess)                     running claude -p, snapshot-resume
   Storage   PGlite (embedded Postgres)             Hosted Postgres + pgvector
             + Transformers.js embeddings            (Neon / Supabase / self-host)
             (nothing leaves device)                 — pg_dump to exit, no Redis
   Auth      local owner (no account)               better-auth → JWT, owner-scoped
   Sync      none (single device)                   pull-on-login + SSE / Redis Streams
                              │                              │
                              └────────────  same  ──────────┘
            frozen 11-kind ActionEvent union  +  typed profile (JSON) + MemoryDistiller
                                  └─ THE MOAT: you OWN it, substrate is swappable ─┘
            (Redis credits → only swappable plumbing: Streams transport + LangCache)
```

---

## The open-core boundary (what's free vs paid)

**Free / open-source client (local-first, BYO everything):**
- The whole Electron client + the procedural cat + personality/mood + presence.
- Local coding agent via the SDKs (your own Codex/Claude auth). Code never leaves the machine.
- Memory + the typed profile in a local **embedded-Postgres (PGlite) file** you own/export/delete; embeddings on-device (Transformers.js). At Nero's scale, recall is **brute-force cosine — no ANN index needed**.
- Brain = your own key or local **Ollama**. The network tab shows only your chosen LLM, nothing to Nero's servers.
- No account, works offline-ish. *This is the funnel and the community — and it quietly builds local profiles that create the upgrade pull.*

**Paid hosted tier (the un-copyable layer):**
- **Zero-config managed agent** (E2B sandbox, no CLI/keys to install) + managed **Haiku** brain + **LangCache**.
- **Postgres-backed memory** (managed pgvector — Neon/Supabase/self-host) + the **structured, accumulating "knows-you" profile** + **cross-device sync**.
- `better-auth` identity scoping every row/key to `owner_id`.
- *The moat is the server-side accumulated profile + the relationship + the brand — not the client code (which will be cloned within months regardless).*

---

## What the FIRST shippable milestone actually needs

The architecture is deliberately shaped so the **OSS launch needs almost none of the hosted infrastructure** — you ride the demo momentum with the local-first client, and the hosted moat is purely additive behind the same interfaces:

**First milestone (alive + runnable OSS):** Electron (keep) · PixiJS **v8 port** + frame governor · local executor via the **Agent SDKs** (fixes the hardcoded-path footgun) · **embedded-Postgres (PGlite) / SQLite** local store + the owned `MemoryDistiller` · **BYO/Ollama** brain. 
**Not needed yet:** any hosted DB, E2B sandboxes, better-auth, sync, Redis/LangCache, managed Haiku. *All of that is Phase 2+ (the paid tier), turned on behind the provider interfaces without touching the client.*

---

## How this differs from the current hackathon stack

| Keep | Change | Add (later, hosted) |
|---|---|---|
| Electron shell + secure window model | PixiJS **v7 → v8** + a real frame governor (idle battery) | Hosted Postgres/pgvector; Redis only for Streams + LangCache |
| The procedural pixel cat (the star) | Raw CLI `spawn` → **official Agent SDKs** (no hardcoded paths) | E2B Firecracker sandbox executor |
| The **11-kind ActionEvent** seam (now law at every layer) | Insforge → **Postgres/pgvector *everywhere*** (PGlite local ↔ hosted PG) behind `StorageProvider`; **own** the typed profile + `MemoryDistiller` | better-auth + pull-on-login sync + SSE |
| Provider-agnostic brain (OpenAI-compatible) | Add **structured profile** (the moat) atop flat memory; default hosted brain → **Haiku 4.5** | Managed brain + LangCache + cross-device profile |
| CharacterDriver facade | Add **MoodCore** as an orthogonal vector modulating pose | — |

---

## The handful of things to verify before committing (and the real risks)

Most picks are high-confidence "keep/boring/proven." The genuine unknowns:

1. **PGlite durability in Electron is the main memory risk.** PGlite is single-process/single-writer WASM; an always-on, force-quit-prone pet risks WAL/checkpoint corruption, and a macOS 26 (Tahoe) WASM-init crash was reported in 2026. **Mitigation:** the main process is the *sole* DB owner (renderer reaches it via IPC only); durable WAL for `profile_facts` writes, `relaxedDurability` only for the high-volume episodic log; checkpoint on quit/idle; keep a periodic `pg_dump` sidecar so a corrupted datadir auto-rebuilds; treat the hosted copy as the durable source of truth. **If PGlite proves fragile, fall back to better-sqlite3/libSQL locally + Postgres hosted** — the `StorageProvider` makes that a swap, not a rewrite. *(Run this durability spike before committing to PGlite-everywhere — it's the asterisk on the table.)*
2. **Own the moat; don't rent it.** *No* agent-memory vendor (Redis Iris, Mem0, Zep, Letta, cognee) emits a *typed, confidence-scored* profile — they give free-text facts or graphs. Keep the typed profile (portable JSON) + the `MemoryDistiller` (promotion → dedup → contradiction-reconcile → read-time decay) as **your** code over a plain table, so the substrate stays swappable and the moat survives any vendor change. *(This — not raw vector recall — is the actual product; treat the distiller as core, not glue.)*
3. **The real lock-in is the embedding model + dimension, not the DB.** Changing it forces a re-embed of the episodic store (the DB is the cheap part to swap; the embedding choice is the expensive one). Store `model_id`+`dim` with every vector and write the re-embed job on day one; the typed profile is text, so it's immune.
4. **E2B**: verify **paused-snapshot storage pricing** and that **Anthropic's ToS permits org-key auth in a multi-tenant sandbox** before hosted launch. Cap each run with the SDK's `maxBudgetUsd`.
5. **Agent SDK churn:** Claude Agent SDK **V2 drops async generators** for `send()/stream()`. Wrap it behind the `ExecutorProvider` facade so the change touches one file; keep the `__fixtures__` mapper tests as a shape-drift tripwire.
6. **Idle battery is a launch-blocking acceptance test**, not a nicety (OpenAI's own Electron Codex pet shipped an idle-GPU bug). CI a measured `<1–2%` idle CPU / near-zero GPU on Apple Silicon, with `app.stop()` on occlusion verified.
7. **Embedding dimensions differ** (local all-MiniLM 384d vs a hosted 1536d model). Store `model_id` + `dim` with every vector; **re-embed on tier change**, never mix vector spaces.

---

## Why each call, in one breath

- **Electron, not Tauri** — verified the team's original reason still holds: Tauri 2.x WKWebView mic (`tauri#11951/#10898`), screen-capture (`wry#1101`), and transparency/click-through (`#13415/#11461`) are *still* broken/workaround-only on macOS in 2026. Native Swift is the best *resident* (~15MB idle) but forks the cat and kills cross-platform — a v2 rewrite, not now.
- **PixiJS v8 + frame governor** — the battery problem is the 60fps treadmill, not the renderer; v8 gives first-class `app.stop()/maxFPS` to escape it, and a static frame is ~free. Mood = a continuous vector modulating pose params, never per-mood animation assets.
- **Agent SDKs (local) + E2B (hosted)** — the SDKs delete your worst footguns and emit the shapes you already map; E2B runs the *identical* `claude` stream so one mapper feeds both tiers; Firecracker snapshot-resume is the "instant" path a pet needs.
- **Postgres/pgvector everywhere, moat owned** — one open-standard engine runs embedded (PGlite) *and* hosted, so the moat exits any vendor with `pg_dump`; Redis is demoted to swappable plumbing (Streams + LangCache). The typed profile + `MemoryDistiller` are your code/JSON; the DB is a ~200-line adapter. At Nero's scale, **brute-force cosine needs no ANN index**, which de-risks the embedded vector choice entirely. (libSQL/SQLite-local + Postgres-hosted is the equally-portable fallback if PGlite's Electron durability disappoints.)
- **better-auth + SSE/Redis-Streams** — same OSS auth lib in both modes (Clerk/WorkOS are hosted-only, can't serve the local tier); SSE gives free reconnect+replay; CRDT sync solves a conflict problem Nero doesn't have.
- **Haiku 4.5 brain** — the brain is a tiny latency-critical structured call (the *intelligence* lives in the executor), so fast+cheap+native-JSON beats a flagship; BYO/Ollama keeps the local tier honest; LangCache cuts the repetitive-chatter bill.

---

## Cross-agent memory exposure (MCP + markdown mirror) — a power-feature, not the headline

The owned memory (`StorageProvider` + typed profile + `MemoryDistiller`) is exposed so **every** coding agent can use it, not just Nero — turning the moat into a churn-proof, cross-agent asset (agents come and go; your profile persists across all of them). This is **additive (~1 week as a thin facade over the existing memory layer)**, not a rebuild.

- **One local stdio MCP server**, deliberately tiny — 4 tools: `search_memory` · `get_profile(scope)` · `add_episode` · `record_decision` — so it survives the MCP context-bloat tax (5–10 servers ≈ 50–67k tokens; design for Tool-Search deferral, GA Feb 2026; never auto-dump the profile). External agents are **append-only**: they emit episodes tagged by `source_agent`; the **`MemoryDistiller` stays the *sole* promotion authority.** "Many writers, one promoter" — so multi-agent writes need **no** distributed-write engine.
- **A markdown / `AGENTS.md` mirror** (size-capped <150 lines; Codex truncates >32KiB) — a zero-integration path any file-reading agent gets for free, and the plaintext privacy proof for devs who read the network tab.
- **The pet is just another client** of the same store, subscribed to the distiller's change-feed (PGlite reactive bindings) — so it **visibly reacts when an external agent teaches it something.** That cross-agent-learning moment *is* the demo and the delight, not a backend detail.
- **Targets:** Claude Code + Codex (the validated devs; both now expose a `UserPromptSubmit` hook for silent profile injection — one shim, used twice). OpenClaw / Hermes are MCP-reachable "also-works" bullets, **not** build targets — they're messaging/personal agents (Steinberger / Nous Research), not the coding-IDE audience that pulled the repo.
- **Hosted mode** = the same tool contract over Streamable HTTP + OAuth (owner-scoped) for cross-device sync. Identical contract; only transport + `StorageProvider` swap.

**Positioning discipline (load-bearing):** the headline stays *"the coding pet that remembers you"*; cross-agent is *sentence two* ("…and your profile travels, so every agent gets smarter — not just Nero"). **"Memory API" is banned positioning** — that lane is a 2026 red ocean (Mem0 $24M, Supermemory, Zep, Cloudflare Agent Memory, and **ClawMem**, which already ships Nero's *bare* typed-memory-cross-agent moat **minus the pet**). So **embodiment is Nero's only uncontested surface** — tie memory to the pet (mood driven by the profile) and out-craft on personality/animation, which infra teams are structurally slow to fake.

**Sequencing:** Milestone 1 = pet + ONE agent + persistent local memory (the validated demo). Cross-agent exposure = Milestone 2 fast-follow, demoed *live* ("watch your profile follow you from Claude Code into Codex"), never merely claimed. Monetize on **sync + team-shared profile/convention inheritance** (the flagged high-willingness-to-pay feature), keeping solo local memory free to protect the OSS/local-first wedge.
