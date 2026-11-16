// POST /api/integrations/keys/sync is how OpenRussiaRouter makes a node's key set match
// its own. The node is REQUIRED to accept it: if this route throws, every request the
// service proxies to that node comes back 401, and the only symptom the caller sees is an
// opaque 500 from the provider client.
//
// The failure this file pins down is subtle, because `syncManagedApiKeys` looks correct in
// isolation. It searched only `managedBy = 'openrussia-router'` rows and then INSERTed any
// incoming key it did not find. `apiKeys.key` is UNIQUE, so a key already present under a
// row the service does not own — a manual key, an imported key, a pre-ownership row — was
// invisible to the lookup but not to the constraint. The INSERT threw
// `UNIQUE constraint failed: apiKeys.key`, the whole `db.transaction()` rolled back, and
// the node kept NONE of the keys instead of all of them. The production fleet hit exactly
// that: 351 of 352 keys already existed under manual rows, so every sync failed and the
// node served 401 to the whole service.
//
// These tests run against a real SQLite database (temp DATA_DIR + the real driver chain),
// not a mock, because the behaviour under test IS the constraint's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "krouter-key-sync-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
});

afterAll(() => {
  // Windows keeps the SQLite file locked while the adapter's WAL handles are open, so the
  // temp dir can only go after close(). Best-effort: a leftover temp dir must never turn a
  // green suite red.
  try {
    adapter?.close?.();
  } catch { /* already closed */ }
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* locked by the OS; temp dir is disposable */ }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  adapter.run("DELETE FROM apiKeys");
});

// The real schema declares `key TEXT UNIQUE NOT NULL`; recreate that shape explicitly so
// the constraint is the production one even if TABLES drifts.
function seedKey({ id, key, name = "seed", isActive = 1, managedBy = null }) {
  adapter.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, managedBy, visibleInDashboard, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, key, name, "machine-1", isActive, managedBy, 1, new Date().toISOString()]
  );
}

function row(key) {
  return adapter.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
}

describe("syncManagedApiKeys — key already present as a manual row", () => {
  it("adopts it instead of colliding with the UNIQUE constraint", async () => {
    // The exact production shape: the key exists, but under a row the service does not own.
    seedKey({ id: "manual-1", key: "sk-or-existing-key-0001", name: "loadtest-14", managedBy: null });

    const result = await repo.syncManagedApiKeys([
      { name: "real-name", key: "sk-or-existing-key-0001", isActive: true },
    ]);

    expect(result.addedCount).toBe(0);
    expect(result.adoptedCount).toBe(1);

    const stored = row("sk-or-existing-key-0001");
    expect(stored.managedBy).toBe("openrussia-router");
    expect(stored.name).toBe("real-name");
    expect(stored.isActive).toBe(1);
    // One row, not two — the key value is still unique.
    expect(adapter.all(`SELECT id FROM apiKeys WHERE key = ?`, ["sk-or-existing-key-0001"])).toHaveLength(1);
  });

  it("survives a fleet-sized batch where almost every key pre-exists as manual", async () => {
    // 351/352 is what production actually looked like; the batch must not abort midway.
    const incoming = [];
    for (let i = 0; i < 352; i++) {
      const key = `sk-or-bulk-key-${String(i).padStart(4, "0")}`;
      incoming.push({ name: `k${i}`, key, isActive: true });
      // All but the last one already exist as manual rows.
      if (i < 351) seedKey({ id: `m${i}`, key, name: `loadtest-${i}`, managedBy: null });
    }

    const result = await repo.syncManagedApiKeys(incoming);

    expect(result.addedCount).toBe(1);
    expect(result.adoptedCount).toBe(351);
    expect(adapter.get(`SELECT COUNT(*) AS c FROM apiKeys`).c).toBe(352);
    expect(
      adapter.get(`SELECT COUNT(*) AS c FROM apiKeys WHERE managedBy = 'openrussia-router'`).c
    ).toBe(352);
  });

  it("reproduces the original failure against the pre-fix query", () => {
    // Guards the reason this file exists: the old lookup misses the manual row, so the
    // INSERT that follows hits UNIQUE. If this ever stops throwing, the bug is gone by
    // construction and the tests above are testing nothing.
    seedKey({ id: "manual-2", key: "sk-or-existing-key-0002", managedBy: null });

    const existingRows = adapter.all(`SELECT * FROM apiKeys WHERE managedBy = 'openrussia-router'`);
    const existingByValue = new Map(existingRows.map((r) => [r.key, r]));
    expect(existingByValue.has("sk-or-existing-key-0002")).toBe(false);

    expect(() =>
      adapter.run(
        `INSERT INTO apiKeys(id, key, name, machineId, isActive, managedBy, visibleInDashboard, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        ["dup", "sk-or-existing-key-0002", "n", null, 1, "openrussia-router", 1, new Date().toISOString()]
      )
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

describe("syncManagedApiKeys — active-state transitions", () => {
  it("reactivates a managed key that the service now reports active", async () => {
    seedKey({ id: "managed-1", key: "sk-or-managed-0001", isActive: 0, managedBy: "openrussia-router" });

    const result = await repo.syncManagedApiKeys([
      { name: "n", key: "sk-or-managed-0001", isActive: true },
    ]);

    expect(result.reactivatedCount).toBe(1);
    expect(row("sk-or-managed-0001").isActive).toBe(1);
  });

  it("disables a managed key the service reports inactive", async () => {
    seedKey({ id: "managed-2", key: "sk-or-managed-0002", isActive: 1, managedBy: "openrussia-router" });

    const result = await repo.syncManagedApiKeys([
      { name: "n", key: "sk-or-managed-0002", isActive: false },
    ]);

    expect(result.disabledCount).toBe(1);
    expect(row("sk-or-managed-0002").isActive).toBe(0);
  });

  it("applies the incoming active state while adopting a manual row", async () => {
    // Adoption must not blindly activate: a key the service says is revoked has to arrive
    // revoked, or a deleted key would keep working on this node.
    seedKey({ id: "manual-3", key: "sk-or-existing-key-0003", isActive: 1, managedBy: null });

    const result = await repo.syncManagedApiKeys([
      { name: "n", key: "sk-or-existing-key-0003", isActive: false },
    ]);

    expect(result.adoptedCount).toBe(1);
    expect(row("sk-or-existing-key-0003").isActive).toBe(0);
  });
});

describe("syncManagedApiKeys — deletion is scoped to owned rows", () => {
  it("deletes a managed key no longer in the incoming set", async () => {
    seedKey({ id: "managed-3", key: "sk-or-gone-0001", isActive: 1, managedBy: "openrussia-router" });

    const result = await repo.syncManagedApiKeys([{ name: "n", key: "sk-or-other-0001", isActive: true }]);

    expect(result.deletedCount).toBe(1);
    expect(row("sk-or-gone-0001")).toBeUndefined();
  });

  it("never deletes a manual key just because the service did not send it", async () => {
    // A manual key is somebody else's. The old code only ever enumerated managed rows, so
    // this was safe by accident; now that the SELECT is wide, the filter is explicit.
    seedKey({ id: "manual-keep", key: "sk-or-manual-keep-1", isActive: 1, managedBy: null });

    const result = await repo.syncManagedApiKeys([{ name: "n", key: "sk-or-other-0002", isActive: true }]);

    expect(result.deletedCount).toBe(0);
    expect(row("sk-or-manual-keep-1")).toBeDefined();
  });
});

describe("syncManagedApiKeys — idempotency", () => {
  it("is a no-op when the node already matches the service", async () => {
    const incoming = [
      { name: "a", key: "sk-or-idem-0001", isActive: true },
      { name: "b", key: "sk-or-idem-0002", isActive: true },
    ];
    seedKey({ id: "i1", key: "sk-or-idem-0001", managedBy: "openrussia-router" });
    seedKey({ id: "i2", key: "sk-or-idem-0002", managedBy: "openrussia-router" });

    const result = await repo.syncManagedApiKeys(incoming);

    expect(result).toMatchObject({
      addedCount: 0,
      adoptedCount: 0,
      reactivatedCount: 0,
      disabledCount: 0,
      deletedCount: 0,
    });
  });
});

describe("POST /api/integrations/keys/sync — route contract", () => {
  let POST;

  beforeAll(async () => {
    ({ POST } = await import("@/app/api/integrations/keys/sync/route.js"));
  });

  function makeRequest(body) {
    return new Request("http://localhost:20128/api/integrations/keys/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 200 with the sync counters, including adopted", async () => {
    seedKey({ id: "route-manual", key: "sk-or-route-key-0001", managedBy: null });

    const res = await POST(makeRequest({ keys: [{ name: "n", key: "sk-or-route-key-0001", isActive: true }] }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.adoptedCount).toBe(1);
    expect(body.addedCount).toBe(0);
    expect(body).toHaveProperty("disabledCount");
    expect(body).toHaveProperty("reactivatedCount");
    expect(body).toHaveProperty("deletedCount");
  });

  it("rejects a body without a keys array", async () => {
    const res = await POST(makeRequest({ nope: true }));
    expect(res.status).toBe(400);
  });

  it("skips malformed entries instead of failing the whole batch", async () => {
    const res = await POST(
      makeRequest({
        keys: [
          { name: "ok", key: "sk-or-route-key-0002", isActive: true },
          { name: "", key: "sk-or-route-key-0003" },        // no name
          { name: "bad", key: "not-an-sk-or-key-xxxxxxx" }, // wrong prefix
        ],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.addedCount).toBe(1);
  });
});
