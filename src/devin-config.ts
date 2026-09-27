/**
 * Devin CLI config that switches off Devin's built-in tools so a session only
 * sees the MCP servers it is given (plus Devin's MCP client controls).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Devin CLI 3000.x built-in tools, excluding its MCP client controls. */
export const DEVIN_NATIVE_TOOLS = [
  "ask_user_question",
  "browser_preview",
  "close_browser_preview",
  "edit",
  "exec",
  "find_file_by_name",
  "get_output",
  "grep",
  "kill_shell",
  "notebook_edit",
  "notebook_read",
  "read",
  "read_subagent",
  "request_scope",
  "run_subagent",
  "todo_write",
  "web_search",
  "webfetch",
  "write",
  "write_to_process",
] as const;

export function devinUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(base, "devin", "config.json");
}

function readJsonObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Devin config ${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Merges the native-tool deny list over the user's Devin config. */
export function openClawOnlyDevinConfig(base: Record<string, unknown>): Record<string, unknown> {
  const existing = Array.isArray(base.disabled_tools)
    ? base.disabled_tools.filter((name): name is string => typeof name === "string")
    : [];
  return {
    ...base,
    disabled_tools: [...new Set([...existing, ...DEVIN_NATIVE_TOOLS])],
    subagents_enabled: false,
  };
}

/** Writes the OpenClaw-tools-only Devin config under `stateDir` and returns its path. */
export function writeOpenClawOnlyDevinConfig(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const config = openClawOnlyDevinConfig(readJsonObject(devinUserConfigPath(params.env)));
  mkdirSync(params.stateDir, { recursive: true });
  const target = path.join(params.stateDir, "devin-config.openclaw-tools.json");
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  return target;
}
