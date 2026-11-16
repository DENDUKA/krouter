import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    managedBy: row.managedBy || null,
    visibleInDashboard: row.visibleInDashboard === null || row.visibleInDashboard === undefined ? true : (row.visibleInDashboard === 1 || row.visibleInDashboard === true),
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys WHERE visibleInDashboard IS NULL OR visibleInDashboard = 1 ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByValue(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  return getApiKeyByValue(key);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );
  return apiKey;
}

export async function createApiKeyWithValue({ name, key, machineId, managedBy, visibleInDashboard }) {
  const db = await getAdapter();
  const apiKey = {
    id: uuidv4(),
    name,
    key,
    machineId: machineId || null,
    isActive: true,
    managedBy: managedBy || null,
    visibleInDashboard: visibleInDashboard !== undefined ? (visibleInDashboard ? 1 : 0) : null,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, managedBy, visibleInDashboard, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.managedBy, apiKey.visibleInDashboard, apiKey.createdAt]
  );
  return rowToKey(apiKey);
}

export async function getManagedApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys WHERE managedBy = 'openrussia-router' ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function setApiKeyActive(id, isActive) {
  const db = await getAdapter();
  db.run(`UPDATE apiKeys SET isActive = ? WHERE id = ?`, [isActive ? 1 : 0, id]);
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

function isUniqueConstraintError(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error?.cause?.message || "");
  return (
    code === "SQLITE_CONSTRAINT" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    /unique constraint/i.test(message) ||
    /constraint failed/i.test(message)
  );
}

// Bulk sync of the service-managed key set. The service (OpenRussiaRouter) is the source
// of truth: it sends every non-deleted key with its desired active state.
//
// Two things here are load-bearing and were both wrong before:
//
// 1. The lookup covers EVERY row, not just `managedBy = 'openrussia-router'`. `apiKeys.key`
//    is UNIQUE, so a key that already sits on the node under a manual/imported row (this
//    fleet had 351 of them) does not stop existing when we narrow the SELECT. Inserting it
//    again threw `UNIQUE constraint failed: apiKeys.key`, the transaction rolled back, and
//    the node ended up with NONE of the service's keys — the caller only ever saw an opaque
//    HTTP 500 while the node silently rejected every request with 401.
//
// 2. Such an existing-but-unmanaged row is *adopted* rather than rejected: same key value
//    means it is the same key, and only ownership transfer makes later disable/delete reach
//    it. Leaving it unmanaged would keep a revoked key alive on the node.
//
// A per-row conflict is also absorbed instead of failing the batch, so one racing insert
// cannot cost the other 350 keys.
export async function syncManagedApiKeys(keys) {
  const db = await getAdapter();
  let addedCount = 0;
  let adoptedCount = 0;
  let disabledCount = 0;
  let reactivatedCount = 0;
  let deletedCount = 0;

  db.transaction(() => {
    const existingRows = db.all(`SELECT * FROM apiKeys`);
    const existingByValue = new Map(existingRows.map((r) => [r.key, rowToKey(r)]));
    const incomingValues = new Set(keys.map((k) => k.key));

    const adopt = (existing, incomingKey, desiredActive) => {
      db.run(
        `UPDATE apiKeys SET managedBy = 'openrussia-router', name = ?, isActive = ?, visibleInDashboard = 1 WHERE id = ?`,
        [incomingKey.name, desiredActive ? 1 : 0, existing.id]
      );
    };

    for (const incomingKey of keys) {
      const desiredActive = incomingKey.isActive === undefined ? true : Boolean(incomingKey.isActive);
      const existing = existingByValue.get(incomingKey.key);

      if (!existing) {
        const newApiKey = {
          id: uuidv4(),
          name: incomingKey.name,
          key: incomingKey.key,
          machineId: incomingKey.machineId || null,
          isActive: desiredActive ? 1 : 0,
          managedBy: "openrussia-router",
          visibleInDashboard: incomingKey.visibleInDashboard !== undefined ? (incomingKey.visibleInDashboard ? 1 : 0) : null,
          createdAt: new Date().toISOString(),
        };
        try {
          db.run(
            `INSERT INTO apiKeys(id, key, name, machineId, isActive, managedBy, visibleInDashboard, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
            [newApiKey.id, newApiKey.key, newApiKey.name, newApiKey.machineId, newApiKey.isActive, newApiKey.managedBy, newApiKey.visibleInDashboard, newApiKey.createdAt]
          );
          addedCount++;
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          // Raced with a concurrent insert of the same value — adopt whatever landed.
          const raced = rowToKey(db.get(`SELECT * FROM apiKeys WHERE key = ?`, [incomingKey.key]));
          if (!raced) throw error;
          adopt(raced, incomingKey, desiredActive);
          adoptedCount++;
        }
      } else if (existing.managedBy !== "openrussia-router") {
        adopt(existing, incomingKey, desiredActive);
        adoptedCount++;
      } else if (desiredActive && !existing.isActive) {
        db.run(`UPDATE apiKeys SET isActive = 1 WHERE id = ?`, [existing.id]);
        reactivatedCount++;
      } else if (!desiredActive && existing.isActive) {
        db.run(`UPDATE apiKeys SET isActive = 0 WHERE id = ?`, [existing.id]);
        disabledCount++;
      }
    }

    // Only keys the service owns are eligible for removal. Rows that stayed manual (never
    // matched an incoming key) belong to somebody else and must not be touched.
    for (const existing of existingByValue.values()) {
      if (existing.managedBy === "openrussia-router" && !incomingValues.has(existing.key)) {
        db.run(`DELETE FROM apiKeys WHERE id = ?`, [existing.id]);
        deletedCount++;
      }
    }
  });

  return { addedCount, adoptedCount, disabledCount, reactivatedCount, deletedCount };
}
