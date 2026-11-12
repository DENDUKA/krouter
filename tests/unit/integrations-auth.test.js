import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";

// ── Unit tests for validateRouterControlToken ──────────────────────────
// Pure function — no mocks needed for the core logic.

import {
  validateRouterControlToken,
} from "../../src/lib/auth/routerControlToken.js";

// ── Unit tests for dashboardGuard proxy (integration auth branch) ──────
// We mock DB / JWT / machineId so that the proxy() function only exercises
// the /api/integrations/* branch.

vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/lib/auth/dashboardSession.js", () => ({
  verifyDashboardAuthToken: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/shared/utils/machineId.js", () => ({
  getConsistentMachineId: vi.fn().mockResolvedValue("test-machine-id"),
}));

import { proxy } from "../../src/dashboardGuard.js";
import { verifyDashboardAuthToken } from "../../src/lib/auth/dashboardSession.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeRequest(path, { headers = {} } = {}) {
  const url = `http://localhost:20128${path}`;
  const req = new Request(url, { headers });
  // Next.js middleware expects nextUrl on the request
  req.nextUrl = new URL(url);
  return req;
}

function bearerHeader(token) {
  return { authorization: `Bearer ${token}` };
}

// ========================================================================
// validateRouterControlToken — unit tests
// ========================================================================

describe("validateRouterControlToken", () => {
  const originalEnv = process.env.ROUTER_CONTROL_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ROUTER_CONTROL_TOKEN = originalEnv;
    } else {
      delete process.env.ROUTER_CONTROL_TOKEN;
    }
  });

  it("returns { valid: false, configured: false } when ROUTER_CONTROL_TOKEN is not set", () => {
    delete process.env.ROUTER_CONTROL_TOKEN;
    const req = makeRequest("/api/integrations/keys");
    const result = validateRouterControlToken(req);
    expect(result.configured).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("returns { valid: false, configured: false } when ROUTER_CONTROL_TOKEN is empty string", () => {
    process.env.ROUTER_CONTROL_TOKEN = "";
    const req = makeRequest("/api/integrations/keys");
    const result = validateRouterControlToken(req);
    expect(result.configured).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("returns { valid: false, configured: true } when token is configured but request has no Authorization", () => {
    process.env.ROUTER_CONTROL_TOKEN = "my-secret-token";
    const req = makeRequest("/api/integrations/keys");
    const result = validateRouterControlToken(req);
    expect(result.configured).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("returns { valid: false, configured: true } for wrong bearer token", () => {
    process.env.ROUTER_CONTROL_TOKEN = "my-secret-token";
    const req = makeRequest("/api/integrations/keys", {
      headers: bearerHeader("wrong-token"),
    });
    const result = validateRouterControlToken(req);
    expect(result.configured).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("returns { valid: true, configured: true } for correct bearer token", () => {
    process.env.ROUTER_CONTROL_TOKEN = "my-secret-token";
    const req = makeRequest("/api/integrations/keys", {
      headers: bearerHeader("my-secret-token"),
    });
    const result = validateRouterControlToken(req);
    expect(result.configured).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("returns { valid: true, configured: true } for correct X-ORR-Node-Token header", () => {
    process.env.ROUTER_CONTROL_TOKEN = "my-secret-token";
    const req = makeRequest("/api/integrations/keys", {
      headers: { "x-orr-node-token": "my-secret-token" },
    });
    const result = validateRouterControlToken(req);
    expect(result.configured).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("uses constant-time comparison helper instead of direct equality", () => {
    const source = readFileSync(
      new URL("../../src/lib/auth/routerControlToken.js", import.meta.url),
      "utf8",
    );
    const helperBody = source.match(
      /function constantTimeStringEqual\(expected, actual\) \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(helperBody).toBeDefined();
    expect(helperBody).not.toMatch(/expected\s*={2,3}\s*actual/);
    expect(helperBody).not.toMatch(/actual\s*={2,3}\s*expected/);

    process.env.ROUTER_CONTROL_TOKEN = "abc";
    const req = makeRequest("/api/integrations/keys", {
      headers: bearerHeader("abd"),
    });
    const result = validateRouterControlToken(req);
    expect(result.valid).toBe(false);
  });
});

// ========================================================================
// dashboardGuard proxy — /api/integrations/* branch
// ========================================================================

describe("dashboardGuard proxy — /api/integrations/* auth", () => {
  const originalEnv = process.env.ROUTER_CONTROL_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ROUTER_CONTROL_TOKEN = originalEnv;
    } else {
      delete process.env.ROUTER_CONTROL_TOKEN;
    }
  });

  it("rejects request without Authorization (401)", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "test-token";
    const req = makeRequest("/api/integrations/keys");
    const res = await proxy(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects wrong bearer token (401)", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "test-token";
    const req = makeRequest("/api/integrations/keys", {
      headers: bearerHeader("wrong"),
    });
    const res = await proxy(req);
    expect(res.status).toBe(401);
  });

  it("allows correct ROUTER_CONTROL_TOKEN bearer", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "test-token";
    const req = makeRequest("/api/integrations/keys", {
      headers: bearerHeader("test-token"),
    });
    const res = await proxy(req);
    // proxy returns NextResponse.next() which has no specific status override
    // but should NOT be 401/503
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });

  it("allows correct ROUTER_CONTROL_TOKEN via x-orr-node-token", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "test-token";
    const req = makeRequest("/api/integrations/keys", {
      headers: { "x-orr-node-token": "test-token" },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });

  it("returns 503 when ROUTER_CONTROL_TOKEN is not configured", async () => {
    delete process.env.ROUTER_CONTROL_TOKEN;
    const req = makeRequest("/api/integrations/keys");
    const res = await proxy(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it("returns 503 when ROUTER_CONTROL_TOKEN is an empty string", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "";
    const req = makeRequest("/api/integrations/keys");
    const res = await proxy(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it("dashboard cookie does NOT grant access to integrations", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "test-token";
    // Simulate valid dashboard JWT cookie
    verifyDashboardAuthToken.mockResolvedValueOnce(true);
    // Create request with a cookie (simulated via headers)
    const req = makeRequest("/api/integrations/keys", {
      headers: { cookie: "auth_token=fake-jwt" },
    });
    const res = await proxy(req);
    // Should still be rejected because integrations require ROUTER_CONTROL_TOKEN
    expect(res.status).toBe(401);
  });

  it("requireLogin === false does NOT grant access to integrations", async () => {
    process.env.ROUTER_CONTROL_TOKEN = "test-token";
    // getSettings returns requireLogin: false
    const { getSettings } = await import("../../src/lib/localDb.js");
    getSettings.mockResolvedValueOnce({ requireLogin: false });
    const req = makeRequest("/api/integrations/keys");
    const res = await proxy(req);
    expect(res.status).toBe(401);
  });
});
