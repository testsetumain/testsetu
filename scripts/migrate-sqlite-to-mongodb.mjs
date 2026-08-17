import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MongoClient, ObjectId } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
loadEnv();

const sqlitePath = path.resolve(root, process.env.SQLITE_MIGRATION_SOURCE || ".data/testsetu.db");
const mongoUri = process.env.MONGODB_CLUSTER_1_URI;

if (!mongoUri) throw new Error("MONGODB_CLUSTER_1_URI is required.");
if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite source not found: ${sqlitePath}`);

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const client = new MongoClient(mongoUri);
await client.connect();
const db = client.db();

const idMaps = new Map();
const mapId = (table, oldId) => {
  const key = `${table}:${oldId}`;
  if (!idMaps.has(key)) idMaps.set(key, new ObjectId().toString());
  return idMaps.get(key);
};

const tables = [
  ["users", "users"],
  ["teacher_profiles", "teacherProfiles"],
  ["student_profiles", "studentProfiles"],
  ["student_identities", "studentIdentities"],
  ["media_files", "mediaFiles"],
  ["questions", "questions"],
  ["tests", "tests"],
  ["attempts", "attempts"],
  ["results", "results"],
  ["certificates", "certificates"],
  ["objections", "objections"],
  ["notifications", "notifications"],
  ["templates", "templates"],
  ["audit_logs", "auditLogs"]
];

for (const [table, collection] of tables) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) continue;
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  for (const row of rows) {
    const doc = convertRow(table, row);
    await db.collection(collection).updateOne({ legacySqliteId: row.id }, { $setOnInsert: doc }, { upsert: true });
  }
  console.log(`Migrated ${rows.length} rows from ${table} -> ${collection}`);
}

sqlite.close();
await client.close();

function convertRow(table, row) {
  const doc = { _id: new ObjectId(mapId(table, row.id)), legacySqliteId: row.id };
  for (const [key, value] of Object.entries(row)) {
    if (key === "id") continue;
    const camel = camelCase(key);
    doc[camel] = parseValue(key, value);
  }
  if (table === "users") doc.passwordHash = row.password_hash;
  if (table === "teacher_profiles") doc.userId = mapId("users", row.user_id);
  if (table === "student_profiles") doc.userId = mapId("users", row.user_id);
  if (table === "questions") {
    doc.teacherId = mapId("users", row.teacher_id);
    doc.options = json(row.options_json, []);
    doc.correct = json(row.correct_json, []);
    doc.tags = json(row.tags_json, []);
  }
  if (table === "tests") {
    doc.teacherId = mapId("users", row.teacher_id);
    doc.settings = json(row.settings_json, {});
    doc.studentFields = json(row.student_fields_json, []);
    doc.branding = json(row.branding_json, {});
    doc.questionIds = sqlite.prepare("SELECT question_id FROM test_questions WHERE test_id=? ORDER BY sort_order").all(row.id).map((q) => mapId("questions", q.question_id));
  }
  if (table === "attempts") {
    doc.testId = mapId("tests", row.test_id);
    doc.studentUserId = row.student_user_id ? mapId("users", row.student_user_id) : null;
    doc.studentIdentityId = row.student_identity_id ? mapId("student_identities", row.student_identity_id) : null;
    doc.details = json(row.details_json, {});
    doc.answers = json(row.answers_json, {});
  }
  if (table === "results") {
    doc.testId = mapId("tests", row.test_id);
    doc.attemptId = mapId("attempts", row.attempt_id);
    doc.studentUserId = row.student_user_id ? mapId("users", row.student_user_id) : null;
    doc.studentIdentityId = row.student_identity_id ? mapId("student_identities", row.student_identity_id) : null;
    doc.totalMarks = row.total_marks;
    doc.rankLabel = row.rank_label;
    doc.timeTaken = row.time_taken;
    doc.visibility = json(row.visibility_json, {});
    doc.breakdown = json(row.breakdown_json, {});
  }
  if (table === "certificates") {
    doc.certificateId = row.certificate_id;
    doc.testId = mapId("tests", row.test_id);
    doc.resultId = mapId("results", row.result_id);
    doc.studentName = row.student_name;
    doc.template = json(row.template_json, {});
  }
  if (table === "notifications") doc.userId = row.user_id ? mapId("users", row.user_id) : null;
  if (table === "audit_logs") {
    doc.actorId = row.actor_id ? mapId("users", row.actor_id) : null;
    doc.entityType = row.entity_type;
    doc.entityId = row.entity_id;
    doc.details = json(row.details_json, {});
  }
  doc.createdAt = toDate(row.created_at) || new Date();
  doc.updatedAt = toDate(row.updated_at) || doc.createdAt;
  return doc;
}

function parseValue(key, value) {
  if (key.endsWith("_json")) return json(value, {});
  if (key.endsWith("_at") || key === "expires_at") return toDate(value);
  if (value === 0 || value === 1) return !!value;
  return value;
}

function json(text, fallback) {
  try { return JSON.parse(text || ""); } catch { return fallback; }
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function camelCase(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function loadEnv() {
  const envPath = path.resolve(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
