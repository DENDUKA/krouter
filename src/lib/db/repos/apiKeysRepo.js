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

export async function syncManagedApiKeys(keys) {
  const db = await getAdapter();
  let addedCount = 0;
  let disabledCount = 0;
  let reactivatedCount = 0;
  let deletedCount = 0;

  db.transaction(() => {
    const existingRows = db.all(`SELECT * FROM apiKeys WHERE managedBy = 'openrussia-router'`);
    const existingByValue = new Map(existingRows.map((r) => [r.key, rowToKey(r)]));
    const incomingValues = new Set(keys.map((k) => k.key));

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
        db.run(
          `INSERT INTO apiKeys(id, key, name, machineId, isActive, managedBy, visibleInDashboard, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [newApiKey.id, newApiKey.key, newApiKey.name, newApiKey.machineId, newApiKey.isActive, newApiKey.managedBy, newApiKey.visibleInDashboard, newApiKey.createdAt]
        );
        addedCount++;
      } else if (desiredActive && !existing.isActive) {
        db.run(`UPDATE apiKeys SET isActive = 1 WHERE id = ?`, [existing.id]);
        reactivatedCount++;
      } else if (!desiredActive && existing.isActive) {
        db.run(`UPDATE apiKeys SET isActive = 0 WHERE id = ?`, [existing.id]);
        disabledCount++;
      }
    }

    for (const existing of existingByValue.values()) {
      if (!incomingValues.has(existing.key)) {
        db.run(`DELETE FROM apiKeys WHERE id = ?`, [existing.id]);
        deletedCount++;
      }
    }
  });

  return { addedCount, disabledCount, reactivatedCount, deletedCount };
}
