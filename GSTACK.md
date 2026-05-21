# GSTACK.md — Using gstack to Build This Project

## Install gstack first (30 seconds)

Open Claude Code in your terminal and paste:

```
Install gstack: run git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp__claude-in-chrome__* tools, and lists the available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /setup-gbrain, /retro, /investigate, /document-release, /document-generate, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn
```

---

## The Sprint Order for This Project

### Step 1: Office Hours
```
/office-hours
```
Describe: "I'm building a CLI MCP server that takes an OpenAPI spec URL or file and generates a complete TypeScript MCP server with Zod schemas and config. Target: portfolio project for a FDE role at an AI-first consultancy."

This will challenge your framing and surface hidden complexity. Key questions it'll force:
- What's the minimum viable spec coverage for a compelling demo?
- Should run_validation actually call the generated API, or just probe MCP protocol?
- What's the narrative hook for the application?

### Step 2: CEO Review
```
/plan-ceo-review
```
This will push you on scope. Expected challenge: "Why 6 tools? Could parse + generate be one tool?" Hold your ground — the 6-tool breakdown demonstrates you understand MCP design (tools should be composable, single-purpose, and Claude-orchestratable).

### Step 3: Engineering Review
```
/plan-eng-review
```
Key things it will catch:
- State management: where does the parsed spec live between tool calls? (module-level Map by source)
- Error surface: what happens if output_dir is on a read-only filesystem?
- Concurrency: what if two tools are called simultaneously on the same spec?
- Process lifecycle: how does run_validation clean up the spawned server if it hangs?

### Step 4: Build
Paste the PROMPT.md kickoff into Claude Code.

Use `/careful` before any file write operations to prevent accidents:
```
/careful
```

Use `/freeze src/codegen/` while debugging zod-gen.ts so Claude doesn't accidentally "fix" other files:
```
/freeze src/codegen
```

### Step 5: Review
```
/review
```
It will check for:
- Missing error handling paths
- Drive-by edits to unrelated files
- Unnecessary complexity
- Missing tests

### Step 6: Security Audit
```
/cso
```
This is important for this project. MCP servers that accept user-supplied file paths and URLs have real attack surface:
- Path traversal: `output_dir: "../../.ssh/"` 
- SSRF: `source: "http://169.254.169.254/latest/meta-data/"`
- Command injection in run_validation (if you spawn npm with unvalidated paths)

gstack's /cso runs OWASP Top 10 + STRIDE. Fix everything it finds.

### Step 7: Documentation
```
/document-generate
```
Generates the README using Diataxis framework. Essential for a portfolio project.

### Step 8: Ship
```
/ship
```
Opens a clean PR with test coverage summary.

---

## Useful gstack Patterns for This Build

### When Claude gets stuck on zod-gen edge cases
```
/investigate
```
It uses "Iron Law: no fixes without investigation" — traces the data flow, tests hypotheses. Better than just asking Claude to fix it.

### When you want a second opinion on the codegen approach
```
/codex
```
Gets an independent review from Codex CLI. Especially useful for the zod-gen.ts logic.

### Context save/restore between sessions
gstack has continuous checkpoint mode. Enable it so you don't lose progress:
```
gstack-config set checkpoint_mode continuous
```
Then `/context-restore` at the start of new sessions picks up where you left off.

---

## Why gstack is the Right Tool for This Specific Project

This project is a developer tool (MCP server), so the relevant review is:
- `/plan-eng-review` (architecture, state, edge cases) — most important
- `/cso` (path traversal, SSRF) — critical for a tool that writes files
- `/devex-review` (after build) — because the generated servers ARE your DX deliverable

Skip:
- `/design-review` — it's CLI only, no UI
- `/qa` — there's no staging URL to browse
- `/benchmark` — not relevant at this scale

---

## The realfast.ai Angle

realfast operates Claude Code in "cockpit mode" — agents execute, you steer. gstack IS that workflow. By using gstack to build this project, you're demonstrating exactly how you'd work at realfast:

- `/office-hours` → interrogate the requirement before writing code
- `/autoplan` → get the full plan reviewed before touching a file
- `/review` + `/cso` → QA gate before shipping
- `/document-generate` → docs stay current automatically

In your application, you can say: "I used gstack's sprint workflow to build this — the same cockpit-mode approach I'd use at realfast."
