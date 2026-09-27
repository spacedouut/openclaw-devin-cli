# openclaw-devin-cli

**Experiment:** an [OpenClaw](https://openclaw.ai) agent-harness plugin that
runs Cognition's [Devin CLI](https://github.com/CognitionAI/devin-cli) (`devin`)
as a native OpenClaw agent runtime. A model ref like `devin-cli/claude-opus-5-5`
runs the turn through `devin acp` with Devin's own login, models and sessions,
never through an upstream provider API.

Status: experimental / alpha, verified end-to-end on OpenClaw 2026.9.6 +
devin-cli 3000.11.x (see [Testing](#testing)).

## How it works

The plugin registers two things with the same id, `devin-cli`:

- a **provider**, which makes `devin-cli/<model>` refs resolvable, publishes
  the model catalog and reasoning slider, and reports Devin's native login as
  auth;
- an **agent harness** (`api.registerAgentHarness`), which claims every
  `devin-cli` route and runs the turn itself.

Per turn the harness (`src/harness-attempt.ts`):

1. Persists the user turn, spawns `devin acp --model <id>`, sends
   `initialize` (as client `devin-cli`, with `DEVIN_PREFER_EXEC_TOOL=true`),
   then `session/load` for the Devin session bound to this OpenClaw session,
   or `session/new` for a new one (`session/set_mode`: `dangerous`→`bypass`,
   `smart`→`smart`, `accept-edits`→`accept-edits`, `auto`→`ask`).
2. Sends `session/prompt`. The first turn of a Devin session carries
   OpenClaw's bootstrap/system context and any earlier OpenClaw history.
3. Mirrors Devin's ACP updates into the OpenClaw transcript as they arrive,
   the same way the built-in runtime stores a turn:

   ```text
   assistant  [text "Checking the kernel.", toolCall exec {command: "uname -r"}]
   toolResult exec → "6.8.0-1061-aws"
   assistant  [text "Now the hostname.",    toolCall exec {command: "hostname"}]
   toolResult exec → "devin-box"
   assistant  [text "devin-box runs 6.8.0-1061-aws."]
   ```

   Each group (assistant message + all of its tool results) is written
   atomically with stable idempotency keys, and live tool start/result events
   share Devin's tool-call id, so tool cards finish instead of staying
   "Running". A tool that never reports back gets an error result when the
   turn ends.
4. If Devin ends a turn without any text, the final message is a summary of
   the stop reason and tool activity, so the turn is never empty.

Devin session ids are kept per OpenClaw session in
`<stateDir>/plugins/devin-cli/sessions.json`; OpenClaw session reset or
deletion drops the binding so the next turn starts a fresh Devin session.

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
          // "tools": "openclaw",           // openclaw | both | devin (see "OpenClaw tools")
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
raises are auto-approved by the harness, except in `auto` (ACP `ask`, read-only),
where they are rejected.

## OpenClaw tools

Each turn the harness builds OpenClaw's tool set for that run (same policy,
allowlists, sandbox, approvals and hooks as OpenClaw's built-in runtime) and
serves it to Devin over MCP: a per-turn streamable-HTTP server on `127.0.0.1`,
guarded by a random bearer token, passed to `devin acp` in `session/new` /
`session/load` as the `openclaw` MCP server and closed when the turn ends.

- `openclaw` (default): Devin's built-in tools (exec, read/write/edit, grep,
  web, subagents, ...) are switched off through a generated Devin config
  (`disabled_tools`, merged over your `~/.config/devin/config.json` and passed
  with `devin --config`). Devin keeps only its MCP client controls
  (`mcp_list_tools`, `mcp_call_tool`, ...) and `skill`, so every action goes
  through an OpenClaw tool.
- `both`: Devin keeps its built-in tools; OpenClaw tools that duplicate them
  (`read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `web_search`,
  `web_fetch`) are left out of the MCP server.
- `devin`: no MCP server; Devin's built-in tools only.

OpenClaw tool calls show up under their OpenClaw names in the transcript and
tool cards. Devin's `mcp_list_tools` lookups against the `openclaw` server are
not shown.

## Session titles and utility completions

The harness implements OpenClaw's isolated completion, so OpenClaw's own
session-title generator (and other short utility prompts) run through Devin
instead of failing and leaving a random slug. Each call starts a throwaway
`devin acp` session with Devin's built-in tools disabled, no MCP servers and
read-only (`ask`) mode; if Devin still tries a tool or asks for a permission,
the completion fails closed.

Titles use the plugin's default utility model, `devin-cli/swe-2`, unless
`agents.defaults.utilityModel` is set. A title you set yourself (rename /
label) always wins over the generated one.

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

Unmapped ids also pass straight through to `devin --model`, so refs keep
working even for models missing from the catalog. Add your own short names
via `plugins.entries.devin-cli.config.modelAliases` in `openclaw.json`.

- **Images:** image attachments are passed to Devin as ACP image blocks.
- **MCP:** no OpenClaw MCP servers are forwarded; Devin uses its own tools.

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
npm test        # reasoning families + transcript projection (node:test, runs against dist/)
```

End-to-end in OpenClaw (needs a logged-in `devin`):

```bash
openclaw plugins install -l /path/to/openclaw-devin-cli
openclaw agent --local -m "hello" --model devin-cli/claude-opus-5-5 --thinking high
```

## Layout

| path | role |
| --- | --- |
| `openclaw.plugin.json` | manifest (`providers`, `activation.onAgentHarnesses`, `modelCatalog`, config schema) |
| `src/index.ts` | plugin entry: provider + harness registration, model/permission resolution |
| `src/harness.ts` | `AgentHarnessV2`: route selection, reset/deletion/dispose |
| `src/harness-attempt.ts` | one turn: ACP session, live events, transcript writes, attempt result |
| `src/devin-acp.ts` | `devin acp` JSON-RPC client |
| `src/turn-projector.ts` | ACP text/tool events → typed assistant/toolResult messages |
| `src/session-bindings.ts` | OpenClaw session → Devin session id store |
| `src/provider-discovery.ts` | catalog entry: `devin models list` -> model catalog, static fallback |
| `src/reasoning-families.ts` | family + thinking level → Devin variant |
| `src/sdk-shim.d.ts` | typings for untyped `openclaw/plugin-sdk/*` subpaths |

MIT — see [LICENSE](LICENSE).
