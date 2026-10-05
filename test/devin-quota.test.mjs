import assert from "node:assert/strict";
import { test } from "node:test";
import {
  devinCredentialsPath,
  fetchDevinUsageSnapshot,
  parseDevinCredentials,
  parseDevinUserStatus,
} from "../dist/devin-quota.js";

const userStatus = {
  userStatus: {
    email: "dev@example.com",
    planStatus: {
      planInfo: { planName: "Max", billingStrategy: "BILLING_STRATEGY_QUOTA" },
      dailyQuotaRemainingPercent: 75,
      weeklyQuotaRemainingPercent: 98,
      overageBalanceMicros: "100000000",
      dailyQuotaResetAtUnix: "1791273600",
      weeklyQuotaResetAtUnix: "1791705600",
    },
  },
};

test("credentials path follows XDG_DATA_HOME, then HOME", () => {
  assert.equal(
    devinCredentialsPath({ XDG_DATA_HOME: "/x", HOME: "/h" }),
    "/x/devin/credentials.toml",
  );
  assert.equal(devinCredentialsPath({ HOME: "/h" }), "/h/.local/share/devin/credentials.toml");
});

test("parses Devin credentials.toml", () => {
  assert.deepEqual(
    parseDevinCredentials(
      'windsurf_api_key = "sk-1"\napi_server_url = "https://server.example.com/"\n',
    ),
    { apiKey: "sk-1", apiServerUrl: "https://server.example.com" },
  );
  assert.deepEqual(parseDevinCredentials("api_key = 'sk-2'\n"), {
    apiKey: "sk-2",
    apiServerUrl: "https://server.codeium.com",
  });
  assert.equal(parseDevinCredentials('api_server_url = "https://x"\n'), undefined);
});

test("maps quota windows, plan, email and overage balance", () => {
  assert.deepEqual(parseDevinUserStatus(userStatus), {
    provider: "devin-cli",
    displayName: "Devin CLI",
    windows: [
      { label: "Daily", usedPercent: 25, resetAt: 1791273600000 },
      { label: "Weekly", usedPercent: 2, resetAt: 1791705600000 },
    ],
    billing: [{ type: "balance", label: "Overage balance", amount: 100, unit: "USD" }],
    plan: "Max",
    accountEmail: "dev@example.com",
  });
});

test("honors hidden quotas and omitted zero values", () => {
  const snapshot = parseDevinUserStatus({
    userStatus: {
      planStatus: {
        planInfo: { hideDailyQuota: true },
        dailyQuotaRemainingPercent: 50,
        dailyQuotaResetAtUnix: "1791273600",
        weeklyQuotaResetAtUnix: "1791705600",
        acuConsumed: 30,
        acuLimit: "120",
      },
    },
  });
  assert.deepEqual(snapshot.windows, [
    { label: "Weekly", usedPercent: 100, resetAt: 1791705600000 },
    { label: "ACUs", usedPercent: 25 },
  ]);
  assert.equal(snapshot.billing, undefined);
});

test("fetch posts Connect JSON with the API key", async () => {
  let call;
  const fetchFn = async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify(userStatus), { status: 200 });
  };
  const snapshot = await fetchDevinUsageSnapshot({
    token: "sk-1",
    apiServerUrl: "https://server.example.com/",
    fetchFn,
  });
  assert.equal(
    call.url,
    "https://server.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
  );
  assert.equal(call.init.headers["connect-protocol-version"], "1");
  const { metadata } = JSON.parse(call.init.body);
  assert.equal(metadata.apiKey, "sk-1");
  assert.ok(metadata.ideVersion && metadata.extensionVersion);
  assert.equal(snapshot.plan, "Max");
});

test("fetch reports auth and HTTP errors", async () => {
  const respond = (status, body) => async () =>
    new Response(JSON.stringify(body), { status });
  const expired = await fetchDevinUsageSnapshot({
    token: "bad",
    fetchFn: respond(401, { code: "unauthenticated", message: "nope" }),
  });
  assert.match(expired.error, /devin auth login/);
  assert.deepEqual(expired.windows, []);
  const failed = await fetchDevinUsageSnapshot({
    token: "sk",
    fetchFn: respond(503, { code: "unavailable" }),
  });
  assert.equal(failed.error, "HTTP 503 (unavailable)");
});
