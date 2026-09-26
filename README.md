# openclaw-devin-cli

**Experiment:** an [OpenClaw](https://openclaw.ai) CLI-backend plugin that wires
Cognition's [Devin CLI](https://github.com/CognitionAI/devin-cli) (`devin`) into
OpenClaw's agent runtime, so a model ref like `devin-cli/opus` runs a turn
through Devin CLI (driven over ACP via `devin acp`) instead of a native API provider.

Status: experimental / alpha, verified end-to-end on OpenClaw 2026.9.6 +
devin-cli 3000.11.x (`openclaw agent --local -m "…" --model devin-cli/opus`
returns a real Devin reply; see [Testing](#testing)).

## Why a bridge script?

OpenClaw's CLI-backend contract (`CliBackendConfig`) expects the spawned
process to emit JSON containing a `session_id` and the reply text under a
`result`-style key. `devin -p` only prints the final assistant text, so a turn
that ends right after a tool call (or a rejected tool approval) looks like an
empty success and OpenClaw reports "CLI backend returned an empty response".

`bin/devin-openclaw-bridge.mjs` instead drives `devin acp` — Devin's Agent
Client Protocol server (JSON-RPC over stdio). Per turn it:

1. Extracts OpenClaw's args (`--oc-prompt`, `--oc-system`, `--model`,
   `--permission-mode`, `-r <sessionId>`).
2. Spawns `devin acp --model <id>`, sends `initialize`, then `session/new`
   (or `session/load` + `session/set_config_option model` on resume), and
   `session/set_mode` (`dangerous`→`bypass`, `smart`→`smart`,
   `accept-edits`→`accept-edits`, `auto`→`ask`).
3. Sends `session/prompt` and collects `agent_message_chunk` text, tool-call
   lifecycle updates, and usage. `session/request_permission` is answered by
   the bridge (allow, except in `ask` mode), so tools never hang on a missing
   TTY.
4. Streams the turn to stdout as JSONL in Gemini CLI's `stream-json` shape
   (`jsonlDialect: "gemini-stream-json"`), so OpenClaw shows text deltas and
   Devin's native tool calls live:

   ```jsonl
   {"type":"init","session_id":"quilt-bubbler","model":"deepseek-v4-1-flash-high"}
   {"type":"message","role":"assistant","content":"I'll run it.","delta":true}
   {"type":"tool_use","tool_id":"call_…","tool_name":"exec","parameters":{"title":"Ran uname","command":"uname -r"}}
   {"type":"tool_result","tool_id":"call_…","status":"success","output":"6.8.0-1061-aws"}
   {"type":"message","role":"assistant","content":"\n\nKernel is 6.8.0-1061-aws.","delta":true}
   {"type":"result","status":"success","session_id":"quilt-bubbler","usage":{…}}
   ```

   If Devin ends a turn without any text, the bridge streams a summary of the
   stop reason and tool activity as the reply instead of leaving it empty.
   Cancellations, refusals and ACP errors end with
   `{"type":"result","status":"error",…}`.

## Install

Requires `devin` on `PATH` (`devin auth login` for actual model calls) and
OpenClaw >= 2026.9.0.

```bash
# from source
openclaw plugins install /path/to/openclaw-devin-cli
# or, once pushed:
openclaw plugins install git:github.com/spacedouut/openclaw-devin-cli

# if the install left it disabled, enable it explicitly:
openclaw plugins enable devin-cli --accept-capabilities
```

> For `git:` installs, OpenClaw runs `npm install --ignore-scripts`, so the
> compiled `dist/` is committed to this repo on purpose.

## Configuration

`openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "devin-cli": {
        "config": {
          // "command": "devin",            // binary name or absolute path
          // "permissionMode": "smart",     // auto | accept-edits | smart | dangerous
          // "modelAliases": { "max": "swe-2-max" } // custom short ids -> devin --model ids
          // "autoReasoningFamilies": true, // one model per family; thinking level picks the variant
          // "reasoningFamilies": { ... }   // explicit family -> level -> variant maps (see below)
        }
      }
    }
  }
}
```

`permissionMode` maps to a Devin ACP session mode (see above). When unset, the
plugin mirrors OpenClaw's own exec policy: a `full` exec mode grants Devin
`dangerous` (bypass all approvals); anything else defaults to `smart`, which
auto-runs actions a fast model judges safe. Permission prompts Devin still
raises are auto-approved by the bridge, except in `auto` (ACP `ask`, read-only).
Side-question executions are forced to `auto` regardless.

## Reasoning families

Devin encodes effort in the model id (`claude-opus-5-5-medium`, `-high`,
`-max`, ...). The plugin collapses those into **one OpenClaw model per family**
(`devin-cli/claude-opus-5-5`) and picks the variant from OpenClaw's thinking
level (`/think`, the reasoning slider) on every run, so the model list stays
short and the slider does the work.

- **Auto (default):** families are derived from `devin models list`: every
  variant named `<family>-<none|minimal|low|medium|high|xhigh|max>` becomes a
  tier (`none` = OpenClaw `off`). `-fast` / `-priority` variants are used when
  OpenClaw fast mode is on. Variants that don't follow the pattern (`fusion-*`,
  `-1m`, `MODEL_*`, ...) stay as individual models. Devin's family aliases
  (`opus`, `sonnet`, `codex`, ...) resolve to the family.
- **Explicit:** `reasoningFamilies` defines or overrides a family; only the
  listed levels appear in the slider.

```jsonc
"reasoningFamilies": {
  "claude-opus-5-5": {
    "levels": {
      "medium": "claude-opus-5-5-medium",
      "max": "claude-opus-5-5-max"
    },
    "fastLevels": { "max": "claude-opus-5-5-max-fast" }, // optional
    "defaultLevel": "medium"                              // optional
  }
}
```

Resolution per run: exact level -> `base` variant (if set) -> nearest lower
tier -> lowest tier. With no level set the family's `defaultLevel` is used
(else `medium`, else `high`, else the lowest tier). Set
`"autoReasoningFamilies": false` to list every Devin variant individually
again (configured families still collapse). Variant ids like
`devin-cli/claude-opus-5-5-max` keep working as direct refs.

## Usage

The plugin exposes a model catalog for `devin-cli`: a static manifest seed
keeps the provider visible offline, and `dist/provider-discovery.js` (declared
via `providerCatalogEntry`) runs `devin models list --format json` when
discovery refreshes, publishing one row per reasoning family plus the
variants that don't belong to one. The last catalog is cached in
`~/.cache/openclaw-devin-cli/models.json` for per-run lookups.

```bash
openclaw agent --local -m "hello" --model devin-cli/claude-opus-5-5 --thinking max  # -> claude-opus-5-5-max
openclaw agent --local -m "hello" --model devin-cli/swe-2-max   # any model_uid still works
openclaw agent --local -m "hello" --model devin-cli/adaptive
openclaw agent --local -m "hello" --model devin-cli/sonnet      # Devin alias -> claude-sonnet-5 family
# or interactively: openclaw chat, then /model devin-cli/opus
```

> `openclaw infer model run` / `capability model run` only drives the
> OpenAI-compatible HTTP transport — it cannot exercise CLI backends
> (`codex` errors there for the same reason). Use `openclaw agent --local`,
> `openclaw chat`, or the gateway agent path.

Unmapped ids also pass straight through to `devin --model`, so refs keep
working even for models missing from the catalog. Add your own short names
via `plugins.entries.devin-cli.config.modelAliases` in `openclaw.json`.

- **Session resume:** the ACP `session/new` id is returned as `session_id`;
  later turns reload it with ACP `session/load`.
- **System prompts:** appended to the first turn's prompt (Devin CLI has no
  native system-prompt flag).
- **Images / MCP probing:** disabled in `liveTest` (`defaultImageProbe`,
  `defaultMcpProbe` false) — the bridge currently sends text-only prompts and
  no MCP servers.

## Caveats / open questions

- **Auth required.** `devin` must be logged in (`devin auth login`); the
  plugin publishes it as synthetic auth (`syntheticAuthRefs` +
  `prepareSyntheticAuth`, probing `devin auth status`) so OpenClaw does not
  ask for an API key for `devin-cli`.
- **Workspace trust.** Devin CLI refuses to run in untrusted directories. If a
  run fails with "Refusing to run in an untrusted workspace", trust the dir
  interactively or set `skip_workspace_trust` in `devin`'s config.

## Testing

```bash
npm install
npm run check   # tsc --noEmit equivalent via build
npm run build   # compiles src/ -> dist/
npm test        # reasoning-family resolution (node:test, runs against dist/)
```

Manual smoke test without OpenClaw:

```bash
# register path
node -e "import('./dist/index.js').then(m=>{
  m.default.register({registerCliBackend:b=>console.log(b.config)})})"

# bridge path (replace with a stub or a real devin binary)
DEVIN_OPENCLAW_COMMAND=devin node bin/devin-openclaw-bridge.mjs \
  --oc-prompt 'say hi' --model adaptive
```

End-to-end in OpenClaw (needs a logged-in `devin`):

```bash
openclaw plugins install -l /path/to/openclaw-devin-cli
openclaw agent --local -m "hello" --model devin-cli/opus
```

## Layout

| path | role |
| --- | --- |
| `openclaw.plugin.json` | manifest (`cliBackends`, `modelCatalog`, `sessionRouteStateOwners`, config schema) |
| `src/index.ts` | plugin entry: builds `CliBackendConfig`, permission-mode normalization |
| `src/provider-discovery.ts` | catalog entry: `devin models list` -> model catalog, static fallback |
| `src/sdk-shim.d.ts` | typings for untyped `openclaw/plugin-sdk/*` subpaths |
| `bin/devin-openclaw-bridge.mjs` | runtime shim: spawn `devin`, recover session id, emit JSON |

MIT — see [LICENSE](LICENSE).
