/**
 * Devin quota for OpenClaw's `/usage` surface (account quota, not the per-turn
 * token usage in devin-usage.ts). Reads the API key that
 * `devin auth login` stores and calls the same `GetUserStatus` endpoint the
 * Devin CLI uses for its own `/usage` view.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/core";

export const DEVIN_USAGE_PROVIDER_ID = "devin-cli";
const DISPLAY_NAME = "Devin CLI";
const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

// GetUserStatus rejects metadata without both version fields.
const CLIENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export type DevinCredentials = { apiKey: string; apiServerUrl: string };

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

export function devinCredentialsPath(env: Env = process.env): string {
  const dataHome =
    env.XDG_DATA_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".local", "share");
  return path.join(dataHome, "devin", "credentials.toml");
}

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || undefined;
}

export function parseDevinCredentials(source: string): DevinCredentials | undefined {
  const apiKey = tomlString(source, "windsurf_api_key") ?? tomlString(source, "api_key");
  if (!apiKey) {
    return undefined;
  }
  const apiServerUrl = (tomlString(source, "api_server_url") ?? DEFAULT_API_SERVER_URL).replace(
    /\/+$/,
    "",
  );
  return { apiKey, apiServerUrl };
}

export async function readDevinCredentials(
  env: Env = process.env,
): Promise<DevinCredentials | undefined> {
  const source = await readFile(devinCredentialsPath(env), "utf8").catch(() => undefined);
  return source ? parseDevinCredentials(source) : undefined;
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** proto3 JSON encodes int64 as strings and omits zero values. */
function num(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function quotaWindow(
  label: string,
  remaining: unknown,
  resetAtUnix: unknown,
): ProviderUsageSnapshot["windows"][number] | undefined {
  const resetSeconds = num(resetAtUnix);
  // A zero remaining percent is omitted on the wire; the reset time still marks the window.
  const remainingPercent = num(remaining) ?? (resetSeconds ? 0 : undefined);
  if (remainingPercent === undefined) {
    return undefined;
  }
  return {
    label,
    usedPercent: clampPercent(100 - remainingPercent),
    ...(resetSeconds ? { resetAt: resetSeconds * 1000 } : {}),
  };
}

/** Normalize a `GetUserStatusResponse` (Connect JSON) into an OpenClaw usage snapshot. */
export function parseDevinUserStatus(body: unknown): ProviderUsageSnapshot {
  const response = record(body) ?? {};
  const userStatus = record(response.userStatus) ?? {};
  const planStatus = record(userStatus.planStatus) ?? {};
  const planInfo = record(planStatus.planInfo) ?? record(response.planInfo) ?? {};

  const windows: ProviderUsageSnapshot["windows"] = [];
  if (planInfo.hideDailyQuota !== true) {
    const daily = quotaWindow(
      "Daily",
      planStatus.dailyQuotaRemainingPercent,
      planStatus.dailyQuotaResetAtUnix,
    );
    if (daily) windows.push(daily);
  }
  if (planInfo.hideWeeklyQuota !== true) {
    const weekly = quotaWindow(
      "Weekly",
      planStatus.weeklyQuotaRemainingPercent,
      planStatus.weeklyQuotaResetAtUnix,
    );
    if (weekly) windows.push(weekly);
  }
  const acuLimit = num(planStatus.acuLimit);
  if (acuLimit && acuLimit > 0) {
    windows.push({
      label: "ACUs",
      usedPercent: clampPercent(((num(planStatus.acuConsumed) ?? 0) / acuLimit) * 100),
    });
  }

  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  const overageMicros = num(planStatus.overageBalanceMicros);
  if (overageMicros !== undefined) {
    billing.push({
      type: "balance",
      label: "Overage balance",
      amount: overageMicros / 1_000_000,
      unit: "USD",
    });
  }

  const plan = typeof planInfo.planName === "string" ? planInfo.planName.trim() : "";
  const email = typeof userStatus.email === "string" ? userStatus.email.trim() : "";
  return {
    provider: DEVIN_USAGE_PROVIDER_ID,
    displayName: DISPLAY_NAME,
    windows,
    ...(billing.length ? { billing } : {}),
    ...(plan ? { plan } : {}),
    ...(email ? { accountEmail: email } : {}),
  };
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return { provider: DEVIN_USAGE_PROVIDER_ID, displayName: DISPLAY_NAME, windows: [], error };
}

export async function fetchDevinUsageSnapshot(params: {
  token: string;
  apiServerUrl?: string;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const url = `${(params.apiServerUrl ?? DEFAULT_API_SERVER_URL).replace(/\/+$/, "")}${USER_STATUS_PATH}`;
  const response = await params.fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify({
      metadata: {
        apiKey: params.token,
        ideName: "devin-cli",
        ideVersion: CLIENT_VERSION,
        extensionName: "openclaw-devin-cli",
        extensionVersion: CLIENT_VERSION,
      },
    }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const detail = record(body);
    const code = typeof detail?.code === "string" ? detail.code : undefined;
    if (response.status === 401 || code === "unauthenticated") {
      return errorSnapshot("Devin CLI login expired; run `devin auth login`");
    }
    return errorSnapshot(`HTTP ${response.status}${code ? ` (${code})` : ""}`);
  }
  if (!record(body)) {
    return errorSnapshot("Unexpected GetUserStatus response");
  }
  return parseDevinUserStatus(body);
}

/** Shared `fetchUsageSnapshot` body for the provider and harness usage hooks. */
export async function fetchDevinUsageForContext(ctx: {
  token: string;
  env: Env;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  return await fetchDevinUsageSnapshot({
    token: ctx.token,
    apiServerUrl: (await readDevinCredentials(ctx.env))?.apiServerUrl,
    fetchFn: ctx.fetchFn,
  });
}
