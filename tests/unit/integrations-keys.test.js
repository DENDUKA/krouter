import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────
// All DB functions are mocked so tests are isolated from real SQLite.

const mockApiKeys = new Map();
let autoIdCounter = 1;

function resetMockData() {
  mockApiKeys.clear();
  autoIdCounter = 1;
}

function makeApiKey(overrides = {}) {
  const id = overrides.id || `key-${autoIdCounter++}`;
  const entry = {
    id,
    key: overrides.key || `sk-test-auto-${id}`,
    name: overrides.name || "test-key",
    machineId: overrides.machineId || "machine-1",
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    managedBy: overrides.managedBy || null,
    visibleInDashboard:
      overrides.visibleInDashboard !== undefined ? overrides.visibleInDashboard : true,
    createdAt: overrides.createdAt || new Date().toISOString(),
  };
  mockApiKeys.set(id, entry);
  return entry;
}

vi.mock("../../src/lib/localDb.js", () => ({
  getApiKeys: vi.fn(() => {
    // Returns only dashboard-visible keys (visibleInDashboard IS NULL or 1)
    return [...mockApiKeys.values()].filter(
      (k) => k.visibleInDashboard === true || k.visibleInDashboard === null,
    );
  }),
  getApiKeyById: vi.fn((id) => mockApiKeys.get(id) || null),
  createApiKey: vi.fn((name, machineId) => {
    const entry = makeApiKey({
      name,
      machineId,
      key: `sk-test-auto-${autoIdCounter - 1}`,
    });
    return entry;
  }),
  createApiKeyWithValue: vi.fn((opts) => {
    const entry = makeApiKey({
      name: opts.name,
      key: opts.key,
      machineId: opts.machineId,
      managedBy: opts.managedBy,
      visibleInDashboard: opts.visibleInDashboard,
    });
    return entry;
  }),
  getApiKeyByValue: vi.fn((key) => {
    for (const entry of mockApiKeys.values()) {
      if (entry.key === key) return entry;
    }
    return null;
  }),
  getManagedApiKeys: vi.fn(() =>
    [...mockApiKeys.values()].filter((k) => k.managedBy === "openrussia-router"),
  ),
  setApiKeyActive: vi.fn((id, isActive) => {
    const entry = mockApiKeys.get(id);
    if (entry) entry.isActive = isActive;
    return entry;
  }),
  deleteApiKey: vi.fn((id) => mockApiKeys.delete(id)),
  validateApiKey: vi.fn((key) => {
    for (const entry of mockApiKeys.values()) {
      if (entry.key === key) return entry.isActive;
    }
    return false;
  }),
}));

vi.mock("../../src/shared/utils/machineId.js", () => ({
  getConsistentMachineId: vi.fn().mockResolvedValue("test-machine-id"),
}));

// ── Import route handlers AFTER mocks are set up ────────────────────────

import { POST as oldPostKeys, GET as oldGetKeys } from "../../src/app/api/keys/route.js";
import {
  POST as postIntegrationsKeys,
  GET as getIntegrationsKeys,
} from "../../src/app/api/integrations/keys/route.js";
import { PATCH as patchKeyStatus } from "../../src/app/api/integrations/keys/[keyId]/status/route.js";
import { DELETE as deleteKey } from "../../src/app/api/integrations/keys/[keyId]/route.js";
import {
  validateApiKey,
  createApiKeyWithValue,
  getApiKeyByValue,
  getApiKeys,
  getManagedApiKeys,
} from "../../src/lib/localDb.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeJsonRequest(method, body, { params = {} } = {}) {
  const req = new Request("http://localhost:20128/api/test", {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  req.params = params;
  return req;
}

// ========================================================================
// Old POST /api/keys — auto-generated local key
// ========================================================================

describe("POST /api/keys (legacy auto-generated key)", () => {
  beforeEach(resetMockData);

  it("creates an auto-generated local key and returns full key value", async () => {
    const req = makeJsonRequest("POST", { name: "my-local-key" });
    const res = await oldPostKeys(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toBeDefined();
    expect(body.name).toBe("my-local-key");
    expect(body.id).toBeDefined();
  });

  it("appears in GET /api/keys with full key", async () => {
    const created = makeApiKey({
      name: "visible-key",
      key: "sk-visible-key-12345",
      managedBy: null,
      visibleInDashboard: true,
    });

    const req = makeJsonRequest("GET", null);
    const res = await oldGetKeys(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.keys.find((k) => k.id === created.id);
    expect(found).toBeDefined();
    expect(found.key).toBe("sk-visible-key-12345");
  });
});

// ========================================================================
// Existing rows with managedBy IS NULL and visibleInDashboard IS NULL
// ========================================================================

describe("legacy rows — managedBy IS NULL, visibleInDashboard IS NULL", () => {
  beforeEach(resetMockData);

  it("treated as local visible dashboard keys after migration", async () => {
    // Simulate a pre-migration row
    makeApiKey({
      id: "legacy-1",
      key: "sk-legacy-key-12345",
      name: "legacy-key",
      managedBy: null,
      visibleInDashboard: null,
    });

    // GET /api/keys returns visible keys (null or true)
    const req = makeJsonRequest("GET", null);
    const res = await oldGetKeys(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.keys.find((k) => k.id === "legacy-1");
    expect(found).toBeDefined();
  });
});

// ========================================================================
// POST /api/integrations/keys — service-managed key
// ========================================================================

describe("POST /api/integrations/keys", () => {
  beforeEach(resetMockData);

  it("creates a service-managed key with sk-or- prefix", async () => {
    const req = makeJsonRequest("POST", {
      name: "managed-key",
      key: "sk-or-testkey12345678",
    });
    const res = await postIntegrationsKeys(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.id).toBeDefined();
  });

  it("is idempotent for the same managed key", async () => {
    // First create
    const existing = makeApiKey({
      id: "existing-1",
      key: "sk-or-duplicate-key-123",
      managedBy: "openrussia-router",
    });

    const req = makeJsonRequest("POST", {
      name: "managed-key",
      key: "sk-or-duplicate-key-123",
    });
    const res = await postIntegrationsKeys(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.id).toBe("existing-1");
  });

  it("returns 409 for duplicate unmanaged/local key", async () => {
    makeApiKey({
      id: "local-1",
      key: "sk-or-conflict-key-123",
      managedBy: null,
    });

    const req = makeJsonRequest("POST", {
      name: "new-managed",
      key: "sk-or-conflict-key-123",
    });
    const res = await postIntegrationsKeys(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("handles UNIQUE race as idempotent for a managed key", async () => {
    const racedExisting = {
      id: "race-managed-1",
      key: "sk-or-race-managed-123",
      managedBy: "openrussia-router",
      isActive: true,
    };

    getApiKeyByValue
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(racedExisting);
    createApiKeyWithValue.mockRejectedValueOnce(
      Object.assign(new Error("UNIQUE constraint failed: apiKeys.key"), {
        code: "SQLITE_CONSTRAINT",
      }),
    );

    const req = makeJsonRequest("POST", {
      name: "managed-key",
      key: "sk-or-race-managed-123",
    });
    const res = await postIntegrationsKeys(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.id).toBe("race-managed-1");
  });

  it("handles UNIQUE race as conflict for an unmanaged key", async () => {
    const racedExisting = {
      id: "race-local-1",
      key: "sk-or-race-local-12345",
      managedBy: null,
      isActive: true,
    };

    getApiKeyByValue
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(racedExisting);
    createApiKeyWithValue.mockRejectedValueOnce(
      Object.assign(new Error("UNIQUE constraint failed: apiKeys.key"), {
        code: "SQLITE_CONSTRAINT",
      }),
    );

    const req = makeJsonRequest("POST", {
      name: "managed-key",
      key: "sk-or-race-local-12345",
    });
    const res = await postIntegrationsKeys(req);
    expect(res.status).toBe(409);
  });
});

// ========================================================================
// GET /api/integrations/keys — does not reveal full key
// ========================================================================

describe("GET /api/integrations/keys", () => {
  beforeEach(resetMockData);

  it("does not reveal full service-managed key", async () => {
    makeApiKey({
      id: "managed-1",
      key: "sk-or-abcdefghij1234567890xyzw",
      name: "managed-key",
      managedBy: "openrussia-router",
      visibleInDashboard: false,
    });

    const req = makeJsonRequest("GET", null);
    const res = await getIntegrationsKeys(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.keys.find((k) => k.id === "managed-1");
    expect(found).toBeDefined();
    // keyPreview should NOT contain the full key
    expect(found.keyPreview).not.toBe("sk-or-abcdefghij1234567890xyzw");
    // keyPreview should be a shortened form
    expect(found.keyPreview).toContain("...");
    // Full key field should not be present
    expect(found.key).toBeUndefined();
  });
});

// ========================================================================
// GET /api/keys — service-managed keys are not disclosed
// ========================================================================

describe("GET /api/keys with service-managed keys", () => {
  beforeEach(resetMockData);

  it("does not reveal the full service-managed key through dashboard keys list", async () => {
    makeApiKey({
      id: "managed-hidden-1",
      key: "sk-or-hidden-service-key-1234567890",
      name: "managed-hidden",
      managedBy: "openrussia-router",
      visibleInDashboard: false,
    });

    makeApiKey({
      id: "local-visible-1",
      key: "sk-local-visible-key-12345",
      name: "local-visible",
      managedBy: null,
      visibleInDashboard: true,
    });

    const req = makeJsonRequest("GET", null);
    const res = await oldGetKeys(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys.some((k) => k.key === "sk-or-hidden-service-key-1234567890")).toBe(false);
    expect(body.keys.find((k) => k.id === "managed-hidden-1")).toBeUndefined();
    expect(body.keys.find((k) => k.id === "local-visible-1")?.key).toBe(
      "sk-local-visible-key-12345",
    );
  });
});

// ========================================================================
// validateApiKey — active/inactive
// ========================================================================

describe("validateApiKey()", () => {
  beforeEach(resetMockData);

  it("returns true for active key", async () => {
    makeApiKey({ id: "active-1", key: "sk-active-key", isActive: true });
    const result = await validateApiKey("sk-active-key");
    expect(result).toBe(true);
  });

  it("returns false for inactive key after PATCH status", async () => {
    makeApiKey({ id: "inactive-1", key: "sk-inactive-key", isActive: true });

    // Simulate PATCH status -> isActive: false
    await setApiKeyActive("inactive-1", false);

    const result = await validateApiKey("sk-inactive-key");
    expect(result).toBe(false);
  });

  it("returns false for non-existent key", async () => {
    const result = await validateApiKey("nonexistent-key");
    expect(result).toBe(false);
  });
});

// ========================================================================
// PATCH /api/integrations/keys/{keyId}/status
// ========================================================================

import { setApiKeyActive } from "../../src/lib/localDb.js";

describe("PATCH /api/integrations/keys/{keyId}/status", () => {
  beforeEach(resetMockData);

  it("toggles isActive to false", async () => {
    makeApiKey({
      id: "toggle-1",
      key: "sk-or-toggle-key-12345678",
      managedBy: "openrussia-router",
      isActive: true,
    });

    const req = makeJsonRequest("PATCH", { isActive: false }, { params: { keyId: "toggle-1" } });
    const res = await patchKeyStatus(req, { params: Promise.resolve({ keyId: "toggle-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(false);
  });

  it("returns 404 for unknown keyId", async () => {
    const req = makeJsonRequest("PATCH", { isActive: false }, { params: { keyId: "unknown-id" } });
    const res = await patchKeyStatus(req, { params: Promise.resolve({ keyId: "unknown-id" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-boolean isActive", async () => {
    const req = makeJsonRequest("PATCH", { isActive: "yes" }, { params: { keyId: "any" } });
    const res = await patchKeyStatus(req, { params: Promise.resolve({ keyId: "any" }) });
    expect(res.status).toBe(400);
  });

  it("response does not expose full key", async () => {
    makeApiKey({
      id: "expose-1",
      key: "sk-or-secret-key-1234567890ab",
      managedBy: "openrussia-router",
      isActive: true,
    });

    const req = makeJsonRequest("PATCH", { isActive: true }, { params: { keyId: "expose-1" } });
    const res = await patchKeyStatus(req, { params: Promise.resolve({ keyId: "expose-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBeUndefined();
    expect(body.keyPreview).toContain("...");
  });
});

// ========================================================================
// DELETE /api/integrations/keys/{keyId}
// ========================================================================

import { deleteApiKey } from "../../src/lib/localDb.js";

describe("DELETE /api/integrations/keys/{keyId}", () => {
  beforeEach(() => {
    resetMockData();
    deleteApiKey.mockClear();
  });

  it("permanently deletes a service-managed key", async () => {
    makeApiKey({
      id: "del-1",
      key: "sk-or-delete-key-12345678",
      managedBy: "openrussia-router",
      isActive: false,
    });

    const req = makeJsonRequest("DELETE", null, { params: { keyId: "del-1" } });
    const res = await deleteKey(req, { params: Promise.resolve({ keyId: "del-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(deleteApiKey).toHaveBeenCalledWith("del-1");
    expect(mockApiKeys.has("del-1")).toBe(false);
  });

  it("returns 404 for unknown keyId", async () => {
    const req = makeJsonRequest("DELETE", null, { params: { keyId: "missing" } });
    const res = await deleteKey(req, { params: Promise.resolve({ keyId: "missing" }) });
    expect(res.status).toBe(404);
    expect(deleteApiKey).not.toHaveBeenCalled();
  });

  it("returns 403 for a key not managed by OpenRussiaRouter", async () => {
    makeApiKey({
      id: "local-del-1",
      key: "sk-local-key-12345678",
      managedBy: null,
    });

    const req = makeJsonRequest("DELETE", null, { params: { keyId: "local-del-1" } });
    const res = await deleteKey(req, { params: Promise.resolve({ keyId: "local-del-1" }) });
    expect(res.status).toBe(403);
    expect(deleteApiKey).not.toHaveBeenCalled();
    expect(mockApiKeys.has("local-del-1")).toBe(true);
  });
});
