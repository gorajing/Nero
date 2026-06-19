# Companion — Demo Runbook (hackathon)

**Verdict:** the wow moment is proven end-to-end — Nebius `decide()` → real Codex
→ `calc.py` fixed → tests pass (measured: 78.9s, red→green). Everything below is
the *same single app launch* (one `sessionId` is minted per launch and memory
recall is filtered to it, so Turn 1's memory is recallable by Turn 3 with no
hacks).

## Pre-flight (do this right before going on stage)

```bash
# 1. Clean workspace so the live run shows ONLY Codex's edit
git -C /Users/jinchoi/Code/companion/agent-workspace clean -fdx
git -C /Users/jinchoi/Code/companion/agent-workspace status --short   # must be empty
# 2. Confirm the planted bug is intact
grep -n "return a + b" /Users/jinchoi/Code/companion/agent-workspace/calc.py   # the bug
# 3. Pre-warm Codex so an auth/MCP-load stall never hits you live
codex exec --skip-git-repo-check -s workspace-write \
  -C /Users/jinchoi/Code/companion/agent-workspace 'echo hi'            # expect JSONL turn.completed
# 4. Launch the app
cd /Users/jinchoi/Code/companion/app && npm start
```

- Use a **wired / phone-hotspot** connection, not venue Wi-Fi.
- Keep a terminal ready with `pkill -f 'codex exec'` typed but not entered (manual abort backstop).

## The flow — type these three turns into the box

**Turn 1 — plant the memory (Nebius reasoning + Insforge write):**
> `Remember this: this is my calc.py calculator project. Always run the tests with pytest and show me the failing test before and after you fix anything.`
- Point at **Nebius**: the timeline shows *"DeepSeek (Nebius) is planning the task…"* and the cat speaks the acknowledgement DeepSeek produced. (Expect `answer` — no Codex run.)
- Point at **Insforge**: "that acknowledgement just got written to our pgvector memory."

**Turn 2 — the wow (all three: Insforge recall + Nebius + Codex):**
> `Now fix the failing subtract test in calc.py`
- **Insforge** beat fires: *"Insforge memory (pgvector): recalled N relevant items"* — the agent already knows it's a calc.py/pytest project from Turn 1.
- **Nebius** → decision `run_agent` → timeline fills: pytest fails → `calc.py` file_change → pytest passes → done. End on the green `2 passed`. ~60–90s — **let it breathe**; narrate while it works.

**Turn 3 — make recall undeniable (clean Insforge beat):**
> `Remind me how I like my tests run`
- No project context in the sentence — the only way to answer is memory. The cat speaks back the pytest / show-before-and-after preference from two turns ago.
- Point at **Insforge**: "it's answering purely from memory — I never repeated that this turn." (Verified recall sim ≈ 0.65.)

*Optional 4th (stretch, only if Screen Recording is granted):* `Look at the error on my screen and tell me what's wrong` → exercises Qwen2.5-VL vision on Nebius. Keep it LAST; never a dependency.

## If something breaks on stage

- **Codex hangs in Turn 2** (cat stuck "working"): click **Stop** (it arms once "Coding agent running" appears), or hit Enter on the pre-typed `pkill -f 'codex exec'`, then re-submit Turn 2.
- **Long silent pause before the agent starts:** the timeline's *"Insforge memory (pgvector): recalled N…"* then *"DeepSeek (Nebius) is planning…"* beats are the proof of life — point at them ("it's querying memory, then planning on Nebius"). Never re-click Send (one turn at a time is enforced).
- **Turn 1 routes to `run_agent` instead of answering:** not fatal (a run summary still stores), but rehearse it once; if it misroutes, drop "calc.py" from the Turn 1 wording so it reads as a pure preference. Use the **exact** Turn 2 string above — it's the verified-working one; don't improvise wording live.

## Known non-issues (don't worry about these)
- Insforge recall/insert failures degrade silently to a still-working run.
- Malformed Nebius response → clean error pose, not a crash.
- Voice (Vapi) is deprioritized/broken — the typed path is the demo.
