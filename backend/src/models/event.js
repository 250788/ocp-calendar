import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || path.join('/data', 'events.db');
const db = new Database(DB_PATH);

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cluster_name TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    openshift_version TEXT NOT NULL,
    notes TEXT,
    policy_name TEXT,
    policy_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_cluster_date ON events(cluster_name, scheduled_date);
  CREATE INDEX IF NOT EXISTS idx_policy_status ON events(policy_status);
`);

// Prepare statement for efficient inserts/updates
const upsertStmt = db.prepare(`
  INSERT INTO events (
    id, title, cluster_name, scheduled_date, start_time,
    duration_minutes, openshift_version, notes, policy_name,
    policy_status
  ) VALUES (
    @id, @title, @cluster_name, @scheduled_date, @start_time,
    @duration_minutes, @openshift_version, @notes, @policy_name,
    @policy_status
  ) ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    cluster_name = excluded.cluster_name,
    scheduled_date = excluded.scheduled_date,
    start_time = excluded.start_time,
    duration_minutes = excluded.duration_minutes,
    openshift_version = excluded.openshift_version,
    notes = excluded.notes,
    policy_name = excluded.policy_name,
    policy_status = excluded.policy_status,
    updated_at = CURRENT_TIMESTAMP
`);

export class EventModel {
  static create(eventData) {
    const {
      id,
      title,
      cluster_name,
      scheduled_date,
      start_time,
      duration_minutes = 60,
      openshift_version,
      notes,
      policy_name,
      policy_status = 'pending'
    } = eventData;

    return upsertStmt.run({
      id,
      title,
      cluster_name,
      scheduled_date,
      start_time,
      duration_minutes,
      openshift_version,
      notes,
      policy_name,
      policy_status
    });
  }

  static getAll() {
    return db.prepare(`
      SELECT * FROM events
      ORDER BY scheduled_date ASC, start_time ASC
    `).all();
  }

  static getById(id) {
    return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  }

  static getByCluster(clusterName) {
    return db.prepare(`
      SELECT * FROM events
      WHERE cluster_name = ?
      ORDER BY scheduled_date ASC, start_time ASC
    `).all(clusterName);
  }

  static getByDate(date) {
    return db.prepare(`
      SELECT * FROM events
      WHERE scheduled_date = ?
      ORDER BY start_time ASC
    `).all(date);
  }

  static getByPolicyStatus(status) {
    return db.prepare(`
      SELECT * FROM events
      WHERE policy_status = ?
      ORDER BY scheduled_date ASC
    `).all(status);
  }

  static updatePolicyStatus(id, policyStatus, policyName) {
    const stmt = db.prepare(`
      UPDATE events
      SET policy_status = ?, policy_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    return stmt.run(policyStatus, policyName, id);
  }

  static delete(id) {
    return db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }

  static exists(id) {
    const result = db.prepare('SELECT 1 FROM events WHERE id = ? LIMIT 1').get(id);
    return !!result;
  }
}

export default EventModel;