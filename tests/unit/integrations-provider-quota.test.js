import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────

const mockConnections = new Map();
let connIdCounter = 1;

function resetMockData() {
  mockConnections.clear();
  connIdCounter = 1;
}

function makeConnection(overrides = {}) {
  const id = overrides.id || `conn-${connIdCounter++}`;
  const entry = {
    id,
    provider: overrides.provider || "minimax",
    name: overrides.name || "Test Connection",
    authType: overrides.authType || "apikey",
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    apiKey: overrides.apiKey || "test-api-key",
    accessToken: overrides.accessToken || null,
    refreshToken: overrides.refreshToken || null,
    idToken: overrides.idToken || null,
    testStatus: overrides.testStatus || null,
    providerSpecificData: overrides.providerSpecificData || {},
    priority: overrides.priority || 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockConnections.set(id, entry);
  return entry;
}

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(() => [...mockConnections.values()]),
  getProviderConnectionById: vi.fn((id) => mockConnections.get(id) || null),
  updateProviderConnection: vi.fn((id, data) => {
    const existing = mockConnections.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...data };
    mockConnections.set(id, merged);
    return merged;
  }),
}));

vi.mock("../../src/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  }),
}));

// Mock usage service
vi.mock("../../open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

// Import after mocks
import { GET as getQuota } from "../../src/app/api/integrations/providers/quota/route.js";
import {
  getProviderConnections,
  updateProviderConnection,
} from "../../src/lib/localDb.js";
import {
  getProviderConnectionById as getDashboardProviderConnectionById,
  updateProviderConnection as updateDashboardProviderConnection,
} from "@/models";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  getCachedProviderQuotaResponse,
  getProviderQuotaCacheKey,
  setCachedProviderQuotaResponse,
  invalidateProviderQuotaCache,
} from "../../src/lib/integrations/providerQuotaCache.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeQuotaRequest(searchParams = "") {
  const url = `http://localhost:20128/api/integrations/providers/quota${searchParams ? `?${searchParams}` : ""}`;
  const req = new Request(url);
  return req;
}

// ========================================================================
// Quota aggregate
// ========================================================================

describe("GET /api/integrations/providers/quota", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
    invalidateProviderQuotaCache();
  });

  it("calls getUsageForProvider for eligible active connections", async () => {
    makeConnection({
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      apiKey: "minimax-key-1",
    });

    getUsageForProvider.mockResolvedValueOnce({
      quotas: { "session": { used: 10, total: 100 } },
    });

    const req = makeQuotaRequest();
    const res = await getQuota(req);
    expect(res.status).toBe(200);

    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
    const [connectionArg, proxyOptionsArg] = getUsageForProvider.mock.calls[0];
    expect(connectionArg.provider).toBe("minimax");
    // proxyOptions must be passed for apikey providers
    expect(proxyOptionsArg).toBeDefined();
    expect(proxyOptionsArg).toBeTypeOf("object");
  });

  it("passes proxyOptions for MiniMax/GLM-style API-key providers", async () => {
    makeConnection({
      provider: "glm",
      authType: "apikey",
      isActive: true,
      apiKey: "glm-key",
    });

    getUsageForProvider.mockResolvedValueOnce({ quotas: {} });

    const req = makeQuotaRequest();
    const res = await getQuota(req);
    expect(res.status).toBe(200);

    const proxyOptionsArg = getUsageForProvider.mock.calls[0][1];
    expect(proxyOptionsArg).toBeDefined();
    expect(proxyOptionsArg.connectionProxyEnabled).toBe(false);
  });

  it("returns 200 with error field when one provider fails", async () => {
    makeConnection({
      id: "fail-conn",
      provider: "claude",
      authType: "oauth",
      isActive: true,
      accessToken: "token-1",
    });

    getUsageForProvider.mockRejectedValueOnce(new Error("Provider timeout"));

    const req = makeQuotaRequest();
    const res = await getQuota(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].error).toBe("Provider timeout");
    expect(body.providers[0].connectionId).toBe("fail-conn");
  });

  it("includes inactive connection with includeInactive=true but does not fetch usage", async () => {
    makeConnection({
      id: "inactive-1",
      provider: "minimax",
      authType: "apikey",
      isActive: false,
      apiKey: "inactive-key",
    });

    const req = makeQuotaRequest("includeInactive=true");
    const res = await getQuota(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const inactiveEntry = body.providers.find((p) => p.connectionId === "inactive-1");
    expect(inactiveEntry).toBeDefined();
    // Should be present but usage should be null (no upstream fetch)
    expect(inactiveEntry.usage).toBeNull();
    // getUsageForProvider should NOT have been called for inactive connection
    expect(getUsageForProvider).not.toHaveBeenCalled();
  });

  it("handles response with message but no quotas as valid usage", async () => {
    makeConnection({
      provider: "kimi-coding",
      authType: "oauth",
      isActive: true,
      accessToken: "kimi-token",
    });

    getUsageForProvider.mockResolvedValueOnce({
      message: "Usage API not implemented",
    });

    const req = makeQuotaRequest();
    const res = await getQuota(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const entry = body.providers[0];
    expect(entry.usage).toBeDefined();
    expect(entry.usage.message).toBe("Usage API not implemented");
    expect(entry.error).toBeNull();
  });
});

// ========================================================================
// kimi-coding fixture
// ========================================================================

describe("kimi-coding provider in quota aggregate", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
    invalidateProviderQuotaCache();
  });

  it("is in USAGE_SUPPORTED_PROVIDERS and returns message-only usage", async () => {
    makeConnection({
      id: "kimi-conn",
      provider: "kimi-coding",
      authType: "oauth",
      isActive: true,
      accessToken: "kimi-token",
    });

    getUsageForProvider.mockResolvedValueOnce({
      message: "Usage API not implemented",
    });

    const req = makeQuotaRequest();
    const res = await getQuota(req);
    const body = await res.json();

    const entry = body.providers.find((p) => p.connectionId === "kimi-conn");
    expect(entry).toBeDefined();
    expect(entry.usage.message).toBe("Usage API not implemented");
    expect(entry.error).toBeNull();
  });
});

// ========================================================================
// Cache invalidation
// ========================================================================

describe("quota cache invalidation", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
    invalidateProviderQuotaCache();
  });

  it("PATCH provider status invalidates quota cache", async () => {
    makeConnection({
      id: "cache-conn",
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      apiKey: "test-key",
    });

    getUsageForProvider.mockResolvedValue({ quotas: {} });

    // First request populates cache
    const req1 = makeQuotaRequest("includeInactive=true");
    await getQuota(req1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);

    // Second request should hit cache
    await getQuota(req1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);

    const patchReq = new Request("http://localhost/api/test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    const patchRes = await patchProviderStatus(patchReq, {
      params: Promise.resolve({ connectionId: "cache-conn" }),
    });
    expect(patchRes.status).toBe(200);

    // Third request should miss cache and reflect inactive state without
    // another upstream usage fetch.
    const res = await getQuota(req1);
    const body = await res.json();
    expect(body.providers[0].isActive).toBe(false);
    expect(body.providers[0].usage).toBeNull();
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("dashboard PUT /api/providers/{id} invalidates quota cache when isActive changes", async () => {
    const existing = makeConnection({
      id: "dash-cache",
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      apiKey: "test-key",
    });

    getUsageForProvider.mockResolvedValue({ quotas: {} });
    const quotaReq = makeQuotaRequest("includeInactive=true");

    await getQuota(quotaReq);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);

    await getQuota(quotaReq);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);

    getDashboardProviderConnectionById.mockResolvedValueOnce(existing);
    updateDashboardProviderConnection.mockImplementationOnce((id, data) => {
      const updated = { ...existing, ...data };
      mockConnections.set(id, updated);
      return updated;
    });

    const putReq = new Request("http://localhost/api/providers/dash-cache", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    const putRes = await putDashboardProvider(putReq, {
      params: Promise.resolve({ id: "dash-cache" }),
    });
    expect(putRes.status).toBe(200);

    const res = await getQuota(quotaReq);
    const body = await res.json();
    expect(body.providers[0].isActive).toBe(false);
    expect(body.providers[0].usage).toBeNull();
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("dashboard PUT does not invalidate quota cache for equivalent boolean/int isActive", async () => {
    const existing = makeConnection({
      id: "dash-cache-int",
      provider: "minimax",
      authType: "apikey",
      isActive: 1,
      apiKey: "test-key",
    });
    const cacheKey = getProviderQuotaCacheKey({ includeInactive: true });
    const cachedResponse = {
      providers: [{ connectionId: "dash-cache-int", isActive: true }],
    };
    setCachedProviderQuotaResponse(cacheKey, cachedResponse);

    getDashboardProviderConnectionById.mockResolvedValueOnce(existing);
    updateDashboardProviderConnection.mockImplementationOnce((id, data) => ({
      ...existing,
      ...data,
    }));

    const putReq = new Request("http://localhost/api/providers/dash-cache-int", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    const putRes = await putDashboardProvider(putReq, {
      params: Promise.resolve({ id: "dash-cache-int" }),
    });
    expect(putRes.status).toBe(200);
    expect(getCachedProviderQuotaResponse(cacheKey)).toEqual(cachedResponse);
  });
});

// ========================================================================
// Provider status toggle — sanitization
// ========================================================================

import { PATCH as patchProviderStatus } from "../../src/app/api/integrations/providers/[connectionId]/status/route.js";
import { PUT as putDashboardProvider } from "../../src/app/api/providers/[id]/route.js";

describe("PATCH /api/integrations/providers/{connectionId}/status", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
    invalidateProviderQuotaCache();
  });

  it("returns 400 for non-boolean isActive", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: "yes" }),
    });

    const res = await patchProviderStatus(req, {
      params: Promise.resolve({ connectionId: "any" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/boolean/i);
  });

  it("returns 404 for unknown connectionId", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });

    const res = await patchProviderStatus(req, {
      params: Promise.resolve({ connectionId: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("response does not contain apiKey, accessToken, refreshToken, idToken, or providerSpecificData secrets", async () => {
    makeConnection({
      id: "sanitize-1",
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      apiKey: "secret-api-key",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      idToken: "secret-id-token",
      providerSpecificData: {
        baseUrl: "https://safe.example",
        copilotToken: "secret-copilot-token",
        cookieValue: "secret-cookie",
      },
    });

    const req = new Request("http://localhost/api/test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    const res = await patchProviderStatus(req, {
      params: Promise.resolve({ connectionId: "sanitize-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const conn = body.connection;
    expect(conn.apiKey).toBeUndefined();
    expect(conn.accessToken).toBeUndefined();
    expect(conn.refreshToken).toBeUndefined();
    expect(conn.idToken).toBeUndefined();
    expect(conn.providerSpecificData.baseUrl).toBe("https://safe.example");
    expect(conn.providerSpecificData.copilotToken).toBeUndefined();
    expect(conn.providerSpecificData.cookieValue).toBeUndefined();
  });

  it("changes isActive and invalidates quota cache", async () => {
    makeConnection({
      id: "status-1",
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      apiKey: "key",
    });

    const req = new Request("http://localhost/api/test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    const res = await patchProviderStatus(req, {
      params: Promise.resolve({ connectionId: "status-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.isActive).toBe(false);

    // Verify DB was called
    expect(updateProviderConnection).toHaveBeenCalledWith("status-1", { isActive: false });
  });
});
