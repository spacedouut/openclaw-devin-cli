# openclaw-devin-cli

**Experiment:** an [OpenClaw](https://openclaw.ai) CLI-backend plugin that wires
Cognition's [Devin CLI](https://github.com/CognitionAI/devin-cli) (`devin`) into
OpenClaw's agent runtime, so a model ref like `devin-cli/opus` runs a turn
through `devin -p` instead of a native API provider.

Status: experimental / alpha. It registers correctly and produces valid output
records, but it has not yet been exercised against a real authenticated
`devin` install end-to-end (see [Testing](#testing)).

## Why a bridge script?

OpenClaw's CLI-backend contract (`CliBackendConfig`) expects the spawned
process to emit JSON containing at minimum a `session_id` field (for
`sessionMode: "existing"`) and reply text under a `result`-style key.

`devin -p` does neither: it prints plain text and (as of devin-cli 3000.11.x)
has no `--json` flag, and its TUI-only `--resume` flow has no equivalent
machine-readable session listing beyond `devin list --format json`.

`bin/devin-openclaw-bridge.mjs` is the shim. It:

1. Extracts OpenClaw-private args (`--oc-prompt`, `--oc-system`) so they never
   reach `devin` itself.
2. Snapshots `devin list --format json` (cwd-scoped, works unauthenticated)
   before and after the run, and diffs the rows to recover the session id that
   `devin` created.
3. Spawns `devin -p -- "<prompt>"` (plus `--model`, `-r <sessionId>` on resume)
   with `CI=1 NO_COLOR=1 TERM=dumb`, captures stdout, strips ANSI escapes.
4. Emits exactly one JSON line OpenClaw can parse:

   ```json
   {"type":"result","session_id":"…","result":"…"}
   ```

   Errors are emitted as `{"type":"result","status":"error",…,"errors":[…]}`
   and the bridge always exits 0 so OpenClaw's watchdog sees the failure
   payload rather than a bare exit code.

## Install

Requires `devin` on `PATH` (`devin auth login` for actual model calls) and
OpenClaw >= 2026.9.0.

```bash
# from source
openclaw plugins install /path/to/openclaw-devin-cli
# or, once pushed:
openclaw plugins install git:github.com/spacedouut/openclaw-devin-cli
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
          // "permissionMode": "accept-edits" // auto | accept-edits | smart | dangerous
        }
      }
    }
  }
}
```

`permissionMode` maps to `devin --permission-mode`. When unset, the plugin
mirrors OpenClaw's own exec policy: a `full` exec mode grants Devin
`dangerous` (bypass all approvals); anything else defaults to `accept-edits`
so edits inside the agent workspace proceed without interactive prompts.
Side-question executions are forced to `auto` regardless.

## Usage

```bash
openclaw --model devin-cli/opus        # modelAliases: opus -> claude-opus-4.6
openclaw --model devin-cli/sonnet      # sonnet -> claude-sonnet-4
openclaw --model devin-cli/<model-id>  # anything else passed to devin --model
```

- **Session resume:** the bridge diffs `devin list` rows to find the new
  session id; OpenClaw then resumes that session via `devin -r <id>` on
  subsequent turns.
- **System prompts:** appended to the first turn's prompt (Devin CLI has no
  native system-prompt flag).
- **Images / MCP probing:** disabled in `liveTest` (`defaultImageProbe`,
  `defaultMcpProbe` false) — `devin -p` has no CLI flag for image input or
  structured MCP config.

## Caveats / open questions

- **No true streaming.** `devin -p` buffers output until the turn completes;
  OpenClaw sees one JSON record at the end. Interactive feel will differ from
  native providers.
- **Session-id recovery is heuristic.** It relies on `devin list --format
  json` output shape (`id`/`session_id`/`sessionId` + a timestamp field) and
  on the run actually creating a session row in the current cwd. If the CLI
  changes that shape, `session_id` goes missing and every turn starts fresh.
- **Auth required.** `devin` must be logged in (`devin auth login`);
  unauthenticated calls surface as error payloads.
- **Alternative path:** `devin acp` exposes the Agent Client Protocol — an
  OpenClaw ACP-agent backend (if one lands in the plugin SDK) would be a much
  cleaner integration than this stdout-parsing bridge.

## Testing

```bash
npm install
npm run check   # tsc --noEmit equivalent via build
npm run build   # compiles src/ -> dist/
```

Manual smoke test without OpenClaw:

```bash
# register path
node -e "import('./dist/index.js').then(m=>{
  m.default.register({registerCliBackend:b=>console.log(b.config)})})"

# bridge path (replace with a stub or a real devin binary)
DEVIN_OPENCLAW_COMMAND=devin node bin/devin-openclaw-bridge.mjs \
  --oc-prompt 'say hi' -p
```

End-to-end in OpenClaw (needs a logged-in `devin`):

```bash
openclaw plugins install -l /path/to/openclaw-devin-cli
openclaw --model devin-cli/opus "hello"
```

## Layout

| path | role |
| --- | --- |
| `openclaw.plugin.json` | manifest (`cliBackends: ["devin-cli"]`, config schema) |
| `src/index.ts` | plugin entry: builds `CliBackendConfig`, permission-mode normalization |
| `src/sdk-shim.d.ts` | typings for untyped `openclaw/plugin-sdk/*` subpaths |
| `bin/devin-openclaw-bridge.mjs` | runtime shim: spawn `devin`, recover session id, emit JSON |

MIT — see [LICENSE](LICENSE).
