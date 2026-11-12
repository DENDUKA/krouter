// Add managedBy and visibleInDashboard columns to apiKeys.
// Enables service-managed (OpenRussiaRouter) keys to be hidden from dashboard.
// Idempotent: skips ALTER TABLE if columns already exist (they may have been
// created by the 001-initial migration if schema.js was updated before this
// migration ran on a fresh database).
export default {
  version: 2,
  name: "api-key-management",
  up(db) {
    const existing = new Set(db.all(`PRAGMA table_info(apiKeys)`).map((r) => r.name));
    if (!existing.has("managedBy")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN managedBy TEXT`);
    }
    if (!existing.has("visibleInDashboard")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN visibleInDashboard INTEGER`);
    }
  },
};
