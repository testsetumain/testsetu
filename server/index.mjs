import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId, GridFSBucket } from "mongodb";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

loadEnv();

const PORT = Number(process.env.PORT || 4000);
const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || "http://localhost:5173";
const FRONTEND_URL = process.env.FRONTEND_URL || APP_URL;
const isProd = process.env.NODE_ENV === "production";
const setupToken = ensureSetupToken();
const startedAt = Date.now();

let mongo;
let db;
let filesBucket;

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

function ensureSetupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  if (isProd) return "";
  const file = path.resolve(root, ".data/setup-token.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const token = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token);
  return token;
}

class MongoDBManager {
  constructor() {
    this.cluster1 = this.createState("Primary MongoDB", process.env.MONGODB_CLUSTER_1_URI, true);
    const enabled = String(process.env.MONGODB_CLUSTER_2_ENABLED || "false").toLowerCase() === "true";
    this.cluster2 = this.createState("Secondary MongoDB", process.env.MONGODB_CLUSTER_2_URI, enabled);
  }

  createState(name, uri, enabled) {
    return { name, uri, enabled, configured: !!uri && enabled, client: null, db: null, status: enabled && uri ? "Connecting" : "Not Configured", latency: null, database: null, lastChecked: null, error: null, collectionsCount: null };
  }

  async connect() {
    if (!this.cluster1.uri) throw new Error("MONGODB_CLUSTER_1_URI is required.");
    this.cluster1.configured = true;
    await this.connectCluster(this.cluster1, true);
    if (this.cluster2.enabled && this.cluster2.uri) await this.connectCluster(this.cluster2, false);
  }

  async connectCluster(state, fatal) {
    const started = Date.now();
    try {
      state.client = new MongoClient(state.uri, { maxPoolSize: 20, minPoolSize: 1, serverSelectionTimeoutMS: 8000 });
      await state.client.connect();
      state.db = state.client.db();
      await state.db.command({ ping: 1 });
      state.status = "Connected";
      state.latency = Date.now() - started;
      state.database = state.db.databaseName;
      state.lastChecked = new Date().toISOString();
      state.error = null;
      state.collectionsCount = await state.db.listCollections({}, { nameOnly: true }).toArray().then((rows) => rows.length).catch(() => null);
    } catch (error) {
      state.status = "Disconnected";
      state.latency = null;
      state.lastChecked = new Date().toISOString();
      state.error = safeError(error);
      if (fatal) throw error;
    }
  }

  primaryDb() {
    if (!this.cluster1.db) throw new Error("Primary MongoDB is not connected.");
    return this.cluster1.db;
  }

  secondaryDb() {
    return this.cluster2.db;
  }

  async refreshHealth() {
    await this.refreshCluster(this.cluster1);
    if (this.cluster2.enabled && this.cluster2.uri) await this.refreshCluster(this.cluster2);
    else {
      this.cluster2.status = "Not Configured";
      this.cluster2.database = null;
      this.cluster2.latency = null;
      this.cluster2.collectionsCount = null;
      this.cluster2.lastChecked = new Date().toISOString();
    }
  }

  async refreshCluster(state) {
    const started = Date.now();
    try {
      if (!state.client) await this.connectCluster(state, false);
      else await state.db.command({ ping: 1 });
      state.status = "Connected";
      state.latency = Date.now() - started;
      state.database = state.db?.databaseName || null;
      state.collectionsCount = state.db ? await state.db.listCollections({}, { nameOnly: true }).toArray().then((rows) => rows.length).catch(() => null) : null;
      state.error = null;
    } catch (error) {
      state.status = "Disconnected";
      state.latency = null;
      state.error = safeError(error);
    }
    state.lastChecked = new Date().toISOString();
  }

  status() {
    const publicState = (state) => ({
      name: state.name,
      configured: !!state.uri && !!state.enabled,
      status: state.status,
      database: state.status === "Connected" ? state.database : null,
      latency: state.latency,
      lastChecked: state.lastChecked,
      collectionsCount: state.collectionsCount
    });
    return {
      mongodb: {
        cluster1: publicState(this.cluster1),
        cluster2: publicState(this.cluster2)
      },
      storage: {
        type: "MongoDB GridFS",
        status: this.cluster1.status === "Connected" ? "Connected" : "Disconnected",
        database: this.cluster1.status === "Connected" ? this.cluster1.database : null,
        bucket: "uploads",
        lastChecked: this.cluster1.lastChecked
      },
      backend: {
        status: "Healthy",
        uptime: Math.round((Date.now() - startedAt) / 1000),
        environment: process.env.NODE_ENV || "development",
        lastChecked: new Date().toISOString()
      }
    };
  }

  async close() {
    await Promise.all([this.cluster1.client?.close(), this.cluster2.client?.close()].filter(Boolean));
  }
}

mongo = new MongoDBManager();
await mongo.connect();
db = mongo.primaryDb();
filesBucket = new GridFSBucket(db, { bucketName: "uploads" });
await ensureIndexes();

if (process.argv.includes("--seed-only")) {
  await seedAdmin();
  await mongo.close();
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS") return send(res, 204);
    await handle(req, res);
  } catch (error) {
    if (error.status) return send(res, error.status, { error: error.message });
    console.error(safeError(error));
    send(res, 500, { error: "Something went wrong. Please try again." });
  }
});

server.listen(PORT, async () => {
  console.log(`TestSetu API running on http://localhost:${PORT}`);
  const primary = mongo.status().mongodb.cluster1;
  console.log(`MongoDB Cluster 1: ${primary.status}${primary.database ? ` (${primary.database})` : ""}`);
  console.log(`MongoDB Cluster 2: ${mongo.status().mongodb.cluster2.status}`);
  if (!isProd && (await countSuperAdmins().catch(() => 1)) === 0) {
    console.log(`Local setup token: ${setupToken}`);
  }
});

async function ensureIndexes() {
  await Promise.all([
    col("users").createIndex({ email: 1 }, { unique: true }),
    col("users").createIndex({ role: 1, status: 1 }),
    col("teacherProfiles").createIndex({ userId: 1 }, { unique: true }),
    col("studentProfiles").createIndex({ userId: 1 }, { unique: true }),
    col("studentIdentities").createIndex({ displayId: 1 }, { unique: true }),
    col("questions").createIndex({ teacherId: 1, archived: 1 }),
    col("questions").createIndex({ subject: 1, topic: 1, chapter: 1 }),
    col("tests").createIndex({ teacherId: 1, archived: 1 }),
    col("tests").createIndex({ shareSlug: 1 }, { unique: true }),
    col("attempts").createIndex({ testId: 1, studentUserId: 1 }),
    col("results").createIndex({ testId: 1 }),
    col("results").createIndex({ attemptId: 1 }, { unique: true }),
    col("certificates").createIndex({ certificateId: 1 }, { unique: true }),
    col("certificates").createIndex({ resultId: 1 }, { unique: true }),
    col("objections").createIndex({ testId: 1, status: 1 }),
    col("notifications").createIndex({ userId: 1, createdAt: -1 }),
    col("templates").createIndex({ ownerId: 1, type: 1 }),
    col("auditLogs").createIndex({ createdAt: -1 })
  ]);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/uploads/")) return serveUpload(res, url.pathname.split("/").pop());
  if (url.pathname.startsWith("/api/")) return routeApi(req, res, url);
  return serveApp(res, url.pathname);
}

async function routeApi(req, res, url) {
  const method = req.method || "GET";
  const pathName = url.pathname;
  const auth = await getAuthUser(req);

  if (method === "GET" && pathName === "/api/health") return send(res, 200, { ok: true, time: new Date().toISOString(), backend: mongo.status().backend });
  if (method === "GET" && pathName === "/api/setup/status") return send(res, 200, { needsSetup: (await countSuperAdmins()) === 0, devSetupToken: !isProd && (await countSuperAdmins()) === 0 ? setupToken : null });
  if (method === "POST" && pathName === "/api/setup") return setupSuperAdmin(req, res);
  if (method === "POST" && pathName === "/api/auth/register") return register(req, res);
  if (method === "POST" && pathName === "/api/auth/login") return login(req, res);
  if (method === "GET" && pathName === "/api/auth/me") return send(res, 200, { user: requireUser(auth) });
  if (pathName.startsWith("/api/public/")) return publicRoutes(req, res, pathName, method, auth);

  const user = requireUser(auth);
  if (method === "POST" && pathName === "/api/uploads") return uploadFile(req, res, user);
  if (method === "GET" && pathName === "/api/notifications") return listNotifications(res, user);
  if (method === "POST" && pathName.startsWith("/api/notifications/") && pathName.endsWith("/read")) return markNotification(res, user, idFrom(pathName, 3));
  if (pathName.startsWith("/api/admin/")) return adminRoutes(req, res, pathName, method, user);
  if (pathName.startsWith("/api/teacher/")) return teacherRoutes(req, res, pathName, method, user, url);
  if (pathName.startsWith("/api/student/")) return studentRoutes(req, res, pathName, method, user);
  return send(res, 404, { error: "Route not found" });
}

async function adminRoutes(req, res, pathName, method, user) {
  requireRole(user, "SUPER_ADMIN");
  if (method === "GET" && pathName === "/api/admin/infrastructure/status") {
    await mongo.refreshHealth();
    return send(res, 200, mongo.status());
  }
  if (method === "GET" && pathName === "/api/admin/dashboard") {
    return send(res, 200, {
      stats: {
        teachers: await count("users", { role: "TEACHER" }),
        pendingTeachers: await count("users", { role: "TEACHER", status: "PENDING" }),
        students: await count("users", { role: "STUDENT" }),
        tests: await count("tests"),
        certificates: await count("certificates"),
        objections: await count("objections", { status: "OPEN" })
      },
      recentAudit: await findMany("auditLogs", {}, { sort: { createdAt: -1 }, limit: 20 })
    });
  }
  if (method === "GET" && pathName === "/api/admin/users") return send(res, 200, { users: (await findMany("users", {}, { sort: { createdAt: -1 } })).map(cleanUser) });
  if (method === "GET" && pathName === "/api/admin/teachers") return send(res, 200, { teachers: await listAdminTeachers() });
  if (method === "POST" && pathName.match(/^\/api\/admin\/teachers\/[^/]+\/approve$/)) return setTeacherStatus(res, user, idFrom(pathName, 4), "ACTIVE");
  if (method === "POST" && pathName.match(/^\/api\/admin\/teachers\/[^/]+\/reject$/)) return setTeacherStatus(res, user, idFrom(pathName, 4), "REJECTED");
  if (method === "POST" && pathName.match(/^\/api\/admin\/users\/[^/]+\/role$/)) return changeUserRole(req, res, user, idFrom(pathName, 4));
  if (method === "POST" && pathName.match(/^\/api\/admin\/users\/[^/]+\/status$/)) return changeUserStatus(req, res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName === "/api/admin/tests") return send(res, 200, { tests: await listAdminTests() });
  if (method === "GET" && pathName === "/api/admin/objections") return send(res, 200, { objections: await listAdminObjections() });
  return send(res, 404, { error: "Admin route not found" });
}

async function teacherRoutes(req, res, pathName, method, user, url) {
  requireTeacher(user);
  if (method === "GET" && pathName === "/api/teacher/dashboard") return teacherDashboard(res, user);
  if (method === "GET" && pathName === "/api/teacher/questions") return listQuestions(res, user, url);
  if (method === "POST" && pathName === "/api/teacher/questions") return saveQuestion(req, res, user);
  if (method === "PUT" && pathName.match(/^\/api\/teacher\/questions\/[^/]+$/)) return updateQuestion(req, res, user, idFrom(pathName, 4));
  if (method === "DELETE" && pathName.match(/^\/api\/teacher\/questions\/[^/]+$/)) return archiveQuestion(res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName === "/api/teacher/tests") return listTeacherTests(res, user);
  if (method === "POST" && pathName === "/api/teacher/tests") return saveTest(req, res, user);
  if (method === "PUT" && pathName.match(/^\/api\/teacher\/tests\/[^/]+$/)) return updateTest(req, res, user, idFrom(pathName, 4));
  if (method === "DELETE" && pathName.match(/^\/api\/teacher\/tests\/[^/]+$/)) return deleteTest(res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName.match(/^\/api\/teacher\/tests\/[^/]+$/)) return send(res, 200, { test: await getFullTestForTeacher(idFrom(pathName, 4), user.id) });
  if (method === "POST" && pathName.match(/^\/api\/teacher\/tests\/[^/]+\/publish$/)) return setTestStatus(res, user, idFrom(pathName, 4), "PUBLISHED");
  if (method === "POST" && pathName.match(/^\/api\/teacher\/tests\/[^/]+\/stop$/)) return setTestStatus(res, user, idFrom(pathName, 4), "STOPPED");
  if (method === "POST" && pathName.match(/^\/api\/teacher\/tests\/[^/]+\/duplicate$/)) return duplicateTest(res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName.match(/^\/api\/teacher\/tests\/[^/]+\/results$/)) return teacherResults(res, user, idFrom(pathName, 4));
  if (method === "POST" && pathName.match(/^\/api\/teacher\/attempts\/[^/]+\/manual-evaluate$/)) return manualEvaluate(req, res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName === "/api/teacher/students") return teacherStudents(res, user);
  if (method === "POST" && pathName === "/api/teacher/temporary-identities") return createTempIdentity(req, res, user);
  if (method === "POST" && pathName.match(/^\/api\/teacher\/temporary-identities\/[^/]+\/reset$/)) return resetTempPassword(res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName === "/api/teacher/objections") return teacherObjections(res, user);
  if (method === "POST" && pathName.match(/^\/api\/teacher\/objections\/[^/]+\/respond$/)) return respondObjection(req, res, user, idFrom(pathName, 4));
  if (method === "GET" && pathName === "/api/teacher/templates") return send(res, 200, { templates: await findMany("templates", { ownerId: user.id }, { sort: { createdAt: -1 } }) });
  if (method === "POST" && pathName === "/api/teacher/templates") return saveTemplate(req, res, user);
  if (method === "GET" && pathName.match(/^\/api\/teacher\/exports\/results\/[^/]+\.csv$/)) return exportResultsCsv(res, user, pathName.split("/")[5].replace(".csv", ""));
  return send(res, 404, { error: "Teacher route not found" });
}

async function studentRoutes(req, res, pathName, method, user) {
  requireRole(user, "STUDENT");
  if (method === "GET" && pathName === "/api/student/dashboard") return studentDashboard(res, user);
  if (method === "POST" && pathName === "/api/student/claim-temporary") return claimTemporary(req, res, user);
  if (method === "POST" && pathName === "/api/student/objections") return createObjection(req, res, user);
  return send(res, 404, { error: "Student route not found" });
}

async function publicRoutes(req, res, pathName, method, user) {
  if (method === "GET" && pathName.match(/^\/api\/public\/tests\/[^/]+$/)) return publicTest(res, pathName.split("/").pop(), user);
  if (method === "POST" && pathName.match(/^\/api\/public\/tests\/[^/]+\/start$/)) return startAttempt(req, res, pathName.split("/")[4], user);
  if (method === "POST" && pathName.match(/^\/api\/public\/attempts\/[^/]+\/answer$/)) return saveAnswer(req, res, idFrom(pathName, 4), user);
  if (method === "POST" && pathName.match(/^\/api\/public\/attempts\/[^/]+\/submit$/)) return submitAttempt(req, res, idFrom(pathName, 4), user);
  if (method === "GET" && pathName.match(/^\/api\/public\/results\/[^/]+$/)) return publicResult(res, idFrom(pathName, 4), user);
  if (method === "GET" && pathName.match(/^\/api\/public\/results\/[^/]+\/pdf$/)) return resultPdf(res, idFrom(pathName, 4), user);
  if (method === "GET" && pathName.match(/^\/api\/public\/results\/[^/]+\/answer-review\.pdf$/)) return answerReviewPdf(res, idFrom(pathName, 4), user);
  if (method === "GET" && pathName.match(/^\/api\/public\/certificates\/[^/]+\/pdf$/)) return certificatePdf(res, idFrom(pathName, 4), user);
  if (method === "GET" && pathName.match(/^\/api\/public\/certificates\/[^/]+$/)) return certificateByResult(res, pathName.split("/").pop(), user);
  if (method === "GET" && pathName.match(/^\/api\/public\/verify\/[^/]+\/qr$/)) return qrForCertificate(res, pathName.split("/")[4]);
  if (method === "GET" && pathName.match(/^\/api\/public\/verify\/[^/]+$/)) return verifyCertificate(res, pathName.split("/").pop());
  return send(res, 404, { error: "Public route not found" });
}

async function setupSuperAdmin(req, res) {
  if ((await countSuperAdmins()) > 0) return send(res, 403, { error: "Setup is already complete." });
  const body = await readBody(req);
  if (!setupToken) return send(res, 500, { error: "SETUP_TOKEN is not configured on the backend." });
  if (body.setupToken !== setupToken) return send(res, 403, { error: "Invalid setup token. Use the exact SETUP_TOKEN configured in Render." });
  validateEmail(body.email);
  validatePassword(body.password);
  const user = await insert("users", {
    email: body.email.toLowerCase(),
    passwordHash: await hashPassword(body.password),
    role: "SUPER_ADMIN",
    status: "ACTIVE",
    name: body.name || "Super Admin",
    forcePasswordChange: false
  });
  await audit(user.id, "SETUP_SUPER_ADMIN", "User", user.id);
  return send(res, 201, { ok: true });
}

async function seedAdmin() {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Set SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD.");
  if ((await countSuperAdmins()) > 0) {
    console.log("Super Admin already exists.");
    return;
  }
  await insert("users", { email: email.toLowerCase(), passwordHash: await hashPassword(password), role: "SUPER_ADMIN", status: "ACTIVE", name: "Super Admin", forcePasswordChange: false });
  console.log(`Seeded Super Admin ${email}`);
}

async function register(req, res) {
  const body = await readBody(req);
  validateEmail(body.email);
  validatePassword(body.password);
  const role = body.role === "TEACHER" ? "TEACHER" : "STUDENT";
  const status = role === "TEACHER" ? "PENDING" : "ACTIVE";
  const user = await insert("users", {
    email: body.email.toLowerCase(),
    passwordHash: await hashPassword(body.password),
    role,
    status,
    name: body.name || body.email.split("@")[0],
    forcePasswordChange: false
  });
  if (role === "TEACHER") {
    await insert("teacherProfiles", {
      userId: user.id,
      teacherName: body.name || "",
      organizationName: body.organizationName || "",
      department: body.department || "",
      subject: body.subject || "",
      designation: body.designation || "",
      city: body.city || "",
      website: body.website || "",
      contactInfo: body.contactInfo || "",
      branding: defaultBranding()
    });
    await notifyAdmins("Teacher verification pending", `${body.name || body.email} registered as a teacher.`, "WARNING");
  } else {
    await insert("studentProfiles", { userId: user.id, fullName: body.name || "", rollNumber: body.rollNumber || "", className: body.className || "", section: body.section || "", mobile: body.mobile || "", fields: {} });
  }
  await audit(user.id, "REGISTER", "User", user.id, { role });
  return send(res, 201, { user: cleanUser(user), token: signToken(user.id) });
}

async function login(req, res) {
  const body = await readBody(req);
  const userDoc = await col("users").findOne({ email: String(body.email || "").toLowerCase() });
  if (!userDoc || !(await verifyPassword(body.password || "", userDoc.passwordHash))) return send(res, 401, { error: "Invalid email or password." });
  const user = toPublic(userDoc);
  if (["BLOCKED", "DEACTIVATED", "REJECTED"].includes(user.status)) return send(res, 403, { error: `Account is ${user.status.toLowerCase()}.` });
  if (user.role === "TEACHER" && user.status !== "ACTIVE") return send(res, 403, { error: "Teacher account is pending Super Admin approval." });
  await audit(user.id, "LOGIN", "User", user.id);
  return send(res, 200, { user: cleanUser(user), token: signToken(user.id) });
}

async function uploadFile(req, res, user) {
  const body = await readBody(req, 8_000_000);
  const match = String(body.dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return send(res, 400, { error: "Upload must be a data URL." });
  const mime = match[1];
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];
  if (!allowed.includes(mime)) return send(res, 400, { error: "Unsupported file type." });
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 5 * 1024 * 1024) return send(res, 400, { error: "File must be 5MB or smaller." });
  const safeName = sanitizeFileName(body.fileName || "upload");
  const fileId = new ObjectId();
  await new Promise((resolve, reject) => {
    const stream = filesBucket.openUploadStreamWithId(fileId, safeName, { contentType: mime, metadata: { ownerId: user.id, size: buffer.length } });
    stream.end(buffer);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  const media = await insert("mediaFiles", { ownerId: user.id, fileId: fileId.toString(), originalName: safeName, mimeType: mime, size: buffer.length, url: `/uploads/${fileId.toString()}`, storage: "mongodb-gridfs" });
  await audit(user.id, "UPLOAD_FILE", "Media", media.id, { mime, size: buffer.length, storage: "mongodb-gridfs" });
  return send(res, 201, { url: media.url, id: media.id });
}

async function serveUpload(res, fileId) {
  if (!ObjectId.isValid(fileId)) return send(res, 404, { error: "File not found" });
  const file = await db.collection("uploads.files").findOne({ _id: oid(fileId) });
  if (!file) return send(res, 404, { error: "File not found" });
  res.writeHead(200, { "Content-Type": file.contentType || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
  filesBucket.openDownloadStream(oid(fileId)).on("error", () => res.end()).pipe(res);
}

async function teacherDashboard(res, user) {
  const teacherTests = await findMany("tests", { teacherId: user.id });
  const testIds = teacherTests.map((t) => t.id);
  return send(res, 200, {
    stats: {
      tests: teacherTests.length,
      published: teacherTests.filter((t) => t.status === "PUBLISHED").length,
      questions: await count("questions", { teacherId: user.id, archived: false }),
      submissions: await count("attempts", { status: "SUBMITTED", testId: { $in: testIds } }),
      certificates: await count("certificates", { testId: { $in: testIds } }),
      objections: await count("objections", { status: "OPEN", testId: { $in: testIds } })
    },
    recentTests: teacherTests.sort(sortByCreatedDesc).slice(0, 6).map(parseTest),
    recentResults: await listRecentTeacherResults(user.id)
  });
}

async function listQuestions(res, user, url) {
  const q = url.searchParams.get("q") || "";
  const subject = url.searchParams.get("subject");
  const filter = { teacherId: user.id, archived: false };
  if (subject) filter.subject = subject;
  if (q) filter.$or = ["text", "topic", "chapter", "subject"].map((field) => ({ [field]: { $regex: escapeRegExp(q), $options: "i" } }));
  return send(res, 200, { questions: (await findMany("questions", filter, { sort: { createdAt: -1 } })).map(parseQuestion) });
}

async function saveQuestion(req, res, user) {
  const q = normalizeQuestion(await readBody(req));
  const question = await insert("questions", { ...q, teacherId: user.id, usageCount: 0, archived: false });
  await audit(user.id, "CREATE_QUESTION", "Question", question.id);
  return send(res, 201, { question: parseQuestion(question) });
}

async function updateQuestion(req, res, user, id) {
  await ensureOwnQuestion(user.id, id);
  const q = normalizeQuestion(await readBody(req));
  await updateOne("questions", { _id: oid(id), teacherId: user.id }, { $set: { ...q, updatedAt: new Date() } });
  await audit(user.id, "UPDATE_QUESTION", "Question", id);
  return send(res, 200, { question: parseQuestion(await getById("questions", id)) });
}

async function archiveQuestion(res, user, id) {
  await ensureOwnQuestion(user.id, id);
  await updateOne("questions", { _id: oid(id), teacherId: user.id }, { $set: { archived: true, updatedAt: new Date() } });
  await audit(user.id, "ARCHIVE_QUESTION", "Question", id);
  return send(res, 200, { ok: true });
}

async function listTeacherTests(res, user) {
  return send(res, 200, { tests: (await findMany("tests", { teacherId: user.id, archived: false }, { sort: { createdAt: -1 } })).map(parseTest) });
}

async function saveTest(req, res, user) {
  const b = normalizeTest(await readBody(req));
  if (b.status === "PUBLISHED" && b.questionIds.length === 0) throw statusError(400, "Add at least one question before publishing.");
  const test = await insert("tests", {
    teacherId: user.id,
    title: b.title,
    subject: b.subject,
    className: b.className,
    description: b.description,
    totalMarks: b.totalMarks,
    passingMarks: b.passingMarks,
    status: b.status,
    visibility: b.visibility,
    accessMode: b.accessMode,
    accessCode: b.accessCode,
    shareSlug: await uniqueSlug(b.title),
    settings: b.settings,
    studentFields: b.studentFields,
    instructionsEn: b.instructionsEn,
    instructionsHi: b.instructionsHi,
    branding: b.branding,
    version: 1,
    archived: false,
    publishedAt: b.status === "PUBLISHED" ? new Date() : null,
    questionIds: b.questionIds
  });
  await bumpQuestionUsage(user.id, b.questionIds);
  await snapshotTest(test.id);
  await audit(user.id, "CREATE_TEST", "Test", test.id);
  return send(res, 201, { test: await getFullTestForTeacher(test.id, user.id) });
}

async function updateTest(req, res, user, id) {
  await ensureOwnTest(user.id, id);
  const b = normalizeTest(await readBody(req));
  await updateOne("tests", { _id: oid(id), teacherId: user.id }, { $set: { ...b, questionIds: b.questionIds, updatedAt: new Date() }, $inc: { version: 1 } });
  await bumpQuestionUsage(user.id, b.questionIds);
  await snapshotTest(id);
  await audit(user.id, "UPDATE_TEST", "Test", id);
  return send(res, 200, { test: await getFullTestForTeacher(id, user.id) });
}

async function deleteTest(res, user, id) {
  await ensureOwnTest(user.id, id);
  const test = await getById("tests", id);
  const attempts = await findMany("attempts", { testId: id });
  const results = await findMany("results", { testId: id });
  const certificates = await findMany("certificates", { testId: id });
  const objections = await findMany("objections", { testId: id });
  const histories = await findMany("testHistory", { testId: id });
  const notifications = await findMany("notifications", { $or: [{ entityId: id }, { testId: id }] });
  const attemptIds = attempts.map((a) => a.id);
  const resultIds = results.map((r) => r.id);
  const certificateIds = certificates.map((c) => c.id);
  const objectionIds = objections.map((o) => o.id);
  const uploadIds = [...collectUploadIds([test, attempts, results, certificates, objections, histories, notifications])];

  await deleteUploadFiles(uploadIds);
  await Promise.all([
    col("tests").deleteOne({ _id: oid(id), teacherId: user.id }),
    col("attempts").deleteMany({ testId: id }),
    col("results").deleteMany({ testId: id }),
    col("certificates").deleteMany({ testId: id }),
    col("objections").deleteMany({ testId: id }),
    col("testHistory").deleteMany({ testId: id }),
    col("notifications").deleteMany({ $or: [{ entityId: id }, { testId: id }] }),
    col("auditLogs").deleteMany({ $or: [
      { entityType: "Test", entityId: id },
      { entityType: "Attempt", entityId: { $in: attemptIds } },
      { entityType: "Result", entityId: { $in: resultIds } },
      { entityType: "Certificate", entityId: { $in: certificateIds } },
      { entityType: "Objection", entityId: { $in: objectionIds } }
    ] })
  ]);

  await audit(user.id, "DELETE_TEST", "Test", id, {
    attempts: attemptIds.length,
    results: resultIds.length,
    certificates: certificateIds.length,
    objections: objectionIds.length,
    files: uploadIds.length
  });
  return send(res, 200, { ok: true, deleted: { test: id, attempts: attemptIds.length, results: resultIds.length, certificates: certificateIds.length, objections: objectionIds.length, files: uploadIds.length } });
}

async function getFullTestForTeacher(id, teacherId) {
  const test = await col("tests").findOne({ _id: oid(id), teacherId });
  if (!test) throw statusError(404, "Test not found.");
  const parsed = parseTest(test);
  parsed.questions = (await findMany("questions", { _id: { $in: (test.questionIds || []).map(oid) } })).sort(orderByIds(test.questionIds || [])).map(parseQuestion);
  return parsed;
}

async function setTestStatus(res, user, id, status) {
  await ensureOwnTest(user.id, id);
  const test = await getById("tests", id);
  if (status === "PUBLISHED" && !(test.questionIds || []).length) throw statusError(400, "Add at least one question before publishing.");
  await updateOne("tests", { _id: oid(id), teacherId: user.id }, { $set: { status, publishedAt: status === "PUBLISHED" ? new Date() : test.publishedAt || null, updatedAt: new Date() } });
  await audit(user.id, `TEST_${status}`, "Test", id);
  if (status === "PUBLISHED") await notifyTestStudents(id, "Test published", `${test.title} is available now.`, "INFO");
  return send(res, 200, { test: await getFullTestForTeacher(id, user.id) });
}

async function duplicateTest(res, user, id) {
  const original = await getFullTestForTeacher(id, user.id);
  const copy = await insert("tests", {
    ...stripMongo(original),
    teacherId: user.id,
    title: `${original.title} Copy`,
    status: "DRAFT",
    shareSlug: await uniqueSlug(`${original.title} Copy`),
    publishedAt: null,
    version: 1,
    questionIds: original.questions.map((q) => q.id)
  });
  await audit(user.id, "DUPLICATE_TEST", "Test", copy.id, { from: id });
  return send(res, 201, { test: await getFullTestForTeacher(copy.id, user.id) });
}

async function publicTest(res, slug, user) {
  const test = await col("tests").findOne({ shareSlug: slug, archived: false, status: "PUBLISHED" });
  if (!test) return send(res, 404, { error: "Test is not available." });
  const teacher = await getById("users", test.teacherId);
  const profile = await col("teacherProfiles").findOne({ userId: test.teacherId });
  const questions = (await findMany("questions", { _id: { $in: (test.questionIds || []).map(oid) } })).sort(orderByIds(test.questionIds || [])).map((q) => {
    const row = parseQuestion(q);
    delete row.correct;
    delete row.explanation;
    return row;
  });
  const parsed = parseTest(test);
  parsed.questions = shouldRandomize(parsed.settings.randomQuestions) ? shuffle(questions) : questions;
  parsed.teacher = { name: teacher?.name, organizationName: profile?.organizationName, logoUrl: profile?.logoUrl, signatureUrl: profile?.signatureUrl, designation: profile?.designation, contactInfo: profile?.contactInfo };
  parsed.serverTime = new Date().toISOString();
  parsed.user = user ? cleanUser(user) : null;
  return send(res, 200, { test: parsed });
}

async function startAttempt(req, res, slug, user) {
  const b = await readBody(req);
  const test = parseTest(await col("tests").findOne({ shareSlug: slug, status: "PUBLISHED" }));
  if (!test) return send(res, 404, { error: "Test not found." });
  ensureTestCanStart(test);
  if (test.accessCode && test.accessCode !== b.accessCode) return send(res, 403, { error: "Invalid access code." });
  if ((test.accessMode === "LOGIN_REQUIRED" || test.accessMode === "EXISTING_ACCOUNT_ONLY") && !user) return send(res, 401, { error: "Login is required for this test." });
  const details = validateStudentDetails(test.studentFields, b.details || {});
  let identityId = null;
  let guestKey = null;
  if (test.accessMode === "TEMPORARY_LOGIN") {
    const identity = await col("studentIdentities").findOne({ displayId: b.tempUserId, status: "ACTIVE" });
    if (!identity || !(await verifyPassword(b.tempPassword || "", identity.tempPasswordHash || ""))) return send(res, 401, { error: "Invalid temporary identity." });
    identityId = String(identity._id);
  } else if (!user) guestKey = crypto.randomBytes(16).toString("base64url");
  const attempts = user ? await count("attempts", { testId: test.id, studentUserId: user.id, isPractice: false }) : 0;
  if (user && attempts >= Number(test.settings.maxAttempts || 1)) return send(res, 400, { error: "Maximum attempts reached." });
  const now = new Date();
  const duration = Number(test.settings.durationMinutes || 0);
  const attempt = await insert("attempts", { testId: test.id, studentUserId: user?.id || null, studentIdentityId: identityId, guestKey, details, status: "IN_PROGRESS", startedAt: now, dueAt: duration ? new Date(now.getTime() + duration * 60_000) : null, timeTaken: 0, answers: {}, isPractice: !!b.isPractice });
  await audit(user?.id || null, "START_ATTEMPT", "Attempt", attempt.id, { testId: test.id });
  return send(res, 201, { attempt: hydrateAttempt(attempt), guestKey });
}

async function saveAnswer(req, res, id, user) {
  const body = await readBody(req);
  const attempt = await ensureAttemptAccess(id, user, body);
  if (attempt.status !== "IN_PROGRESS") return send(res, 400, { error: "Attempt is already submitted." });
  if (attempt.dueAt && new Date(attempt.dueAt) < new Date()) return submitAttempt(req, res, id, user, true);
  const answers = attempt.answers || {};
  answers[String(body.questionId)] = { value: body.value, markedForReview: !!body.markedForReview, savedAt: new Date().toISOString() };
  await updateOne("attempts", { _id: oid(id) }, { $set: { answers } });
  return send(res, 200, { ok: true, savedAt: answers[String(body.questionId)].savedAt });
}

async function submitAttempt(req, res, id, user, auto = false) {
  const body = req ? await readBody(req) : {};
  const attempt = await ensureAttemptAccess(id, user, body);
  if (attempt.status === "SUBMITTED") return send(res, 200, { result: studentVisibleResult(await getResultByAttempt(id), user) });
  const started = attempt.startedAt ? new Date(attempt.startedAt).getTime() : Date.now();
  const timeTaken = Math.max(0, Math.round((Date.now() - started) / 1000));
  await updateOne("attempts", { _id: oid(id) }, { $set: { status: "SUBMITTED", submittedAt: new Date(), timeTaken } });
  const result = await evaluateAttempt(id);
  await audit(user?.id || null, auto ? "AUTO_SUBMIT_ATTEMPT" : "SUBMIT_ATTEMPT", "Attempt", id);
  const test = await getById("tests", attempt.testId);
  await insert("notifications", { userId: test.teacherId, title: "New submission", body: `${studentName(attempt)} submitted ${test.title}.`, type: "SUCCESS", readAt: null });
  return send(res, 200, { result: studentVisibleResult(result, user) });
}

async function evaluateAttempt(attemptId, manualScores = {}) {
  const attempt = await getById("attempts", attemptId);
  const test = parseTest(await getById("tests", attempt.testId));
  const questions = (await findMany("questions", { _id: { $in: (test.questionIds || []).map(oid) } })).sort(orderByIds(test.questionIds || [])).map(parseQuestion);
  const answers = attempt.answers || {};
  let score = 0, correct = 0, wrong = 0, unattempted = 0, manualPending = 0;
  const breakdown = [];
  for (const q of questions) {
    const value = answers[String(q.id)]?.value;
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    let awarded = 0, status = "UNATTEMPTED";
    if (empty) unattempted++;
    else if (requiresManual(q)) {
      if (manualScores[q.id] !== undefined) {
        awarded = clamp(Number(manualScores[q.id]), 0, Number(q.marks));
        status = awarded > 0 ? "MANUAL_SCORED" : "WRONG";
      } else {
        manualPending++;
        status = "MANUAL_PENDING";
      }
    } else if (isCorrect(q, value)) {
      awarded = Number(q.marks);
      correct++;
      status = "CORRECT";
    } else {
      awarded = -Math.abs(Number(q.negativeMarks || 0));
      wrong++;
      status = "WRONG";
    }
    score += awarded;
    breakdown.push({ questionId: q.id, questionText: q.text, value, correctAnswer: q.correct, marks: q.marks, awarded, status, explanation: q.explanation, subject: q.subject, topic: q.topic });
  }
  const total = Number(test.totalMarks || questions.reduce((sum, q) => sum + Number(q.marks), 0) || 1);
  const percentage = Math.max(0, round((score / total) * 100));
  const payload = {
    testId: test.id,
    attemptId,
    studentUserId: attempt.studentUserId || null,
    studentIdentityId: attempt.studentIdentityId || null,
    score: round(score),
    totalMarks: total,
    percentage,
    grade: gradeFor(percentage),
    passed: score >= Number(test.passingMarks || 0),
    accuracy: correct + wrong ? round((correct / (correct + wrong)) * 100) : 0,
    correct,
    wrong,
    unattempted,
    timeTaken: (await getById("attempts", attemptId)).timeTaken,
    visibility: test.settings.resultVisibility || defaultResultVisibility(),
    breakdown: { questions: breakdown, manualPending },
    publishedAt: resultVisibleNow(test) ? new Date() : null
  };
  const existing = await col("results").findOne({ attemptId });
  let result;
  if (existing) {
    await updateOne("results", { _id: existing._id }, { $set: { ...payload, updatedAt: new Date() } });
    result = await getById("results", existing._id);
  } else result = await insert("results", payload);
  await recalculateRanks(test.id);
  const hydrated = await getResult(result.id);
  await maybeIssueCertificate(hydrated);
  return getResult(result.id);
}

async function manualEvaluate(req, res, user, attemptId) {
  const attempt = await getById("attempts", attemptId);
  const test = attempt ? await getById("tests", attempt.testId) : null;
  if (!attempt || !test || test.teacherId !== user.id) return send(res, 404, { error: "Attempt not found." });
  const result = await evaluateAttempt(attemptId, (await readBody(req)).scores || {});
  await audit(user.id, "MANUAL_EVALUATE", "Attempt", attemptId);
  return send(res, 200, { result });
}

async function recalculateRanks(testId) {
  const test = parseTest(await getById("tests", testId));
  if (!test.settings.rankingEnabled) {
    await col("results").updateMany({ testId }, { $set: { rank: null, rankLabel: null } });
    return;
  }
  const breakers = test.settings.tieBreakers || ["accuracy", "timeTaken"];
  const rows = await findMany("results", { testId });
  rows.sort((a, b) => compareRank(a, b, breakers));
  let previous = null, rank = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!previous || compareRank(row, previous, breakers) !== 0) rank = i + 1;
    const label = previous && compareRank(row, previous, breakers) === 0 ? `Joint Rank ${rank}` : `Rank ${rank}`;
    await updateOne("results", { _id: oid(row.id) }, { $set: { rank, rankLabel: label } });
    previous = row;
  }
}

async function maybeIssueCertificate(result) {
  const test = parseTest(await getById("tests", result.testId));
  const cfg = test.settings.certificate || {};
  if (!cfg.enabled) return null;
  const existing = await col("certificates").findOne({ resultId: result.id });
  if (existing) return existing;
  const eligible = cfg.eligibility === "EVERYONE" || (cfg.eligibility === "PASSED" && result.passed) || (cfg.eligibility === "MIN_PERCENTAGE" && result.percentage >= Number(cfg.minimumPercentage || 0)) || (cfg.eligibility === "TOP_STUDENTS" && result.rank && result.rank <= Number(cfg.topCount || 3));
  if (!eligible) return null;
  return insert("certificates", { certificateId: `TS-${new Date().getFullYear()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`, testId: result.testId, resultId: result.id, studentName: result.studentName, status: "VALID", issuedAt: new Date(), verificationToken: crypto.randomBytes(18).toString("base64url"), template: cfg.template || {} });
}

async function teacherResults(res, user, testId) {
  await ensureOwnTest(user.id, testId);
  const rows = await Promise.all((await findMany("results", { testId })).map(hydrateResultRow));
  rows.sort((a, b) => (a.rank || 999999) - (b.rank || 999999) || b.score - a.score);
  return send(res, 200, { test: parseTest(await getById("tests", testId)), results: rows, summary: resultSummary(rows) });
}

async function teacherStudents(res, user) {
  const tests = await findMany("tests", { teacherId: user.id });
  const testIds = tests.map((t) => t.id);
  const attempts = await findMany("attempts", { testId: { $in: testIds } }, { sort: { createdAt: -1 } });
  const students = [];
  const seen = new Set();
  for (const attempt of attempts) {
    const key = attempt.studentUserId || attempt.studentIdentityId || attempt.guestKey || attempt.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = attempt.studentUserId ? await getById("users", attempt.studentUserId) : null;
    const si = attempt.studentIdentityId ? await getById("studentIdentities", attempt.studentIdentityId) : null;
    students.push({ name: u?.name || attempt.details?.fullName || "", email: u?.email || "", status: u?.status || "GUEST", display_id: si?.displayId || "", kind: si?.kind || (u ? "PERMANENT" : "GUEST"), attempts: attempts.filter((a) => (a.studentUserId || a.studentIdentityId || a.guestKey) === key).length, details: attempt.details });
  }
  const temporaryIdentities = (await findMany("studentIdentities", { createdByTeacherId: user.id }, { sort: { createdAt: -1 } })).map(hydrateStudentIdentity);
  return send(res, 200, { students, temporaryIdentities });
}

async function createTempIdentity(req, res, user) {
  const body = await readBody(req);
  const displayId = `TSU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const tempPassword = randomPassword();
  const claimCode = crypto.randomBytes(10).toString("base64url");
  const identity = await insert("studentIdentities", { userId: null, createdByTeacherId: user.id, displayId, kind: "TEMPORARY", tempPasswordHash: await hashPassword(tempPassword), forcePasswordChange: true, expiresAt: body.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 180), claimCodeHash: await hashPassword(claimCode), fields: body.fields || {}, status: "ACTIVE" });
  await audit(user.id, "CREATE_TEMP_IDENTITY", "StudentIdentity", identity.id);
  return send(res, 201, { identity: hydrateStudentIdentity(identity), tempPassword, claimCode });
}

async function resetTempPassword(res, user, id) {
  const identity = await col("studentIdentities").findOne({ _id: oid(id), createdByTeacherId: user.id });
  if (!identity) return send(res, 404, { error: "Identity not found." });
  const tempPassword = randomPassword();
  await updateOne("studentIdentities", { _id: oid(id) }, { $set: { tempPasswordHash: await hashPassword(tempPassword), forcePasswordChange: true } });
  await audit(user.id, "RESET_TEMP_PASSWORD", "StudentIdentity", id);
  return send(res, 200, { tempPassword });
}

async function claimTemporary(req, res, user) {
  const body = await readBody(req);
  const identity = await col("studentIdentities").findOne({ displayId: body.displayId, status: "ACTIVE" });
  if (!identity || !(await verifyPassword(body.claimCode || "", identity.claimCodeHash || ""))) return send(res, 401, { error: "Invalid claim code." });
  const identityId = String(identity._id);
  await updateOne("studentIdentities", { _id: identity._id }, { $set: { userId: user.id, kind: "PERMANENT", tempPasswordHash: null, forcePasswordChange: false } });
  await col("attempts").updateMany({ studentIdentityId: identityId }, { $set: { studentUserId: user.id } });
  await col("results").updateMany({ studentIdentityId: identityId }, { $set: { studentUserId: user.id } });
  await audit(user.id, "CLAIM_TEMPORARY_IDENTITY", "StudentIdentity", identityId);
  return send(res, 200, { ok: true });
}

async function teacherObjections(res, user) {
  const tests = await findMany("tests", { teacherId: user.id });
  const rows = await Promise.all((await findMany("objections", { testId: { $in: tests.map((t) => t.id) } }, { sort: { createdAt: -1 } })).map(async (o) => ({ ...o, test_title: tests.find((t) => t.id === o.testId)?.title || "", student_name: o.studentUserId ? (await getById("users", o.studentUserId))?.name || "" : "" })));
  return send(res, 200, { objections: rows });
}

async function createObjection(req, res, user) {
  const b = await readBody(req);
  const result = await col("results").findOne({ _id: oid(b.resultId), studentUserId: user.id });
  if (!result) return send(res, 404, { error: "Result not found." });
  const objection = await insert("objections", { testId: result.testId, resultId: String(result._id), attemptId: result.attemptId, studentUserId: user.id, questionId: b.questionId || null, type: b.type || "RESULT", message: b.message, status: "OPEN", response: null, resolvedAt: null });
  const test = await getById("tests", result.testId);
  await insert("notifications", { userId: test.teacherId, title: "New objection", body: `${user.name} raised an objection for ${test.title}.`, type: "WARNING", readAt: null });
  await audit(user.id, "CREATE_OBJECTION", "Objection", objection.id);
  return send(res, 201, { objection });
}

async function respondObjection(req, res, user, id) {
  const b = await readBody(req);
  const objection = await getById("objections", id);
  const test = objection ? await getById("tests", objection.testId) : null;
  if (!objection || !test || test.teacherId !== user.id) return send(res, 404, { error: "Objection not found." });
  const status = b.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED";
  await updateOne("objections", { _id: oid(id) }, { $set: { status, response: b.response || "", resolvedAt: new Date() } });
  if (status === "ACCEPTED" && objection.attemptId) await evaluateAttempt(objection.attemptId, b.manualScores || {});
  if (objection.studentUserId) await insert("notifications", { userId: objection.studentUserId, title: "Objection response", body: b.response || `Your objection was ${status.toLowerCase()}.`, type: status === "ACCEPTED" ? "SUCCESS" : "INFO", readAt: null });
  await audit(user.id, "RESPOND_OBJECTION", "Objection", id, { status });
  return send(res, 200, { objection: await getById("objections", id) });
}

async function saveTemplate(req, res, user) {
  const b = await readBody(req);
  const template = await insert("templates", { ownerId: user.id, type: b.type || "CERTIFICATE", name: b.name || "Template", payload: b.payload || {} });
  return send(res, 201, { template });
}

async function publicResult(res, id, user) {
  const result = await getResult(id);
  ensureResultAccess(result, user);
  return send(res, 200, { result: studentVisibleResult(result, user) });
}

async function certificateByResult(res, resultId, user) {
  const result = await getResult(resultId);
  ensureResultAccess(result, user);
  if (!canSeeDetailedResult(result, user)) return send(res, 423, { error: "Certificate will be available after the test ends." });
  await maybeIssueCertificate(result);
  const cert = await getCertificateForResult(result.id);
  if (!cert) return send(res, 404, { error: "Certificate is not available for this result." });
  return send(res, 200, { certificate: cert });
}

async function certificatePdf(res, resultId, user) {
  const result = await getResult(resultId);
  ensureResultAccess(result, user);
  if (!canSeeDetailedResult(result, user)) return send(res, 423, { error: "Certificate PDF will be available after the test ends." });
  const cert = await maybeIssueCertificate(result) || await getCertificateForResult(result.id);
  if (!cert) return send(res, 404, { error: "Certificate is not available for this result." });
  sendPdf(res, simplePdf("TestSetu Certificate of Achievement", [`This certifies that ${cert.studentName}`, `has completed ${result.testTitle}`, `Marks: ${result.score} / ${result.totalMarks}`, `Percentage: ${result.percentage}%`, `Grade: ${result.grade}`, `Rank: ${result.rankLabel || "Not ranked"}`, `Certificate ID: ${cert.certificateId}`, `Issued: ${cert.issuedAt}`, `Verify: ${APP_URL}/#verify/${encodeURIComponent(cert.certificateId)}`]), `certificate-${cert.certificateId}.pdf`);
}

async function verifyCertificate(res, certId) {
  const cert = await col("certificates").findOne({ certificateId: certId });
  if (!cert || cert.status !== "VALID") return send(res, 404, { valid: false, error: "Certificate is invalid or not found." });
  return send(res, 200, { valid: true, certificate: await hydrateCertificate(cert) });
}

async function qrForCertificate(res, certId) {
  const url = `${APP_URL}/#verify/${encodeURIComponent(certId)}`;
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 });
  return send(res, 200, { dataUrl, url });
}

async function resultPdf(res, id, user) {
  const result = await getResult(id);
  ensureResultAccess(result, user);
  const detailed = canSeeDetailedResult(result, user);
  const lines = detailed ? [`Student: ${result.studentName}`, `Test: ${result.testTitle}`, `Marks: ${result.score} / ${result.totalMarks}`, `Percentage: ${result.percentage}%`, `Grade: ${result.grade}`, `Status: ${result.passed ? "Passed" : "Needs improvement"}`, `Rank: ${result.rankLabel || "Not ranked"}`, `Correct: ${result.correct}  Wrong: ${result.wrong}  Unattempted: ${result.unattempted}`, `Generated from verified TestSetu MongoDB records.`] : [`Student: ${result.studentName}`, `Test: ${result.testTitle}`, `Score: ${result.score} / ${result.totalMarks}`, `Percentage: ${result.percentage}%`, `Status: ${result.passed ? "Passed" : "Not passed"}`, `Detailed result, rank, answer review and certificate will unlock after the test ends.`];
  sendPdf(res, simplePdf(detailed ? "TestSetu Result Card" : "TestSetu Score Card", lines), `result-${id}.pdf`);
}

async function answerReviewPdf(res, id, user) {
  const result = await getResult(id);
  ensureResultAccess(result, user);
  if (!canSeeDetailedResult(result, user)) return send(res, 423, { error: "Answer review will be available after the test ends." });
  const review = result.breakdown?.questions || [];
  const lines = [`Student: ${result.studentName}`, `Test: ${result.testTitle}`, ""];
  for (const item of review) {
    lines.push(`Q: ${item.questionText || item.questionId}`);
    lines.push(`Student Answer=${stringifyAnswer(item.value)} Correct=${stringifyAnswer(item.correctAnswer)} Marks=${item.awarded}/${item.marks} Status=${item.status}`);
    if (item.explanation) lines.push(`Explanation: ${item.explanation}`);
  }
  sendPdf(res, simplePdf("TestSetu Answer Review", lines), `answer-review-${id}.pdf`);
}

async function exportResultsCsv(res, user, testId) {
  await ensureOwnTest(user.id, testId);
  const rows = await Promise.all((await findMany("results", { testId })).map(hydrateResultRow));
  rows.sort((a, b) => (a.rank || 999999) - (b.rank || 999999) || b.score - a.score);
  const csv = ["Student,Score,Total,Percentage,Grade,Rank,Passed,Accuracy,Correct,Wrong,Unattempted,Time Taken"];
  rows.forEach((r) => csv.push([r.studentName, r.score, r.totalMarks, r.percentage, r.grade, r.rankLabel || "", r.passed ? "Yes" : "No", r.accuracy, r.correct, r.wrong, r.unattempted, r.timeTaken].map(csvCell).join(",")));
  res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="testsetu-results-${testId}.csv"` });
  res.end(csv.join("\n"));
}

async function setTeacherStatus(res, actor, id, status) {
  const user = await getById("users", id);
  if (!user || user.role !== "TEACHER") return send(res, 404, { error: "Teacher not found." });
  await updateOne("users", { _id: oid(id) }, { $set: { status, updatedAt: new Date() } });
  if (status === "ACTIVE") await updateOne("teacherProfiles", { userId: id }, { $set: { approvedAt: new Date() } });
  await insert("notifications", { userId: id, title: status === "ACTIVE" ? "Teacher approved" : "Teacher registration rejected", body: status === "ACTIVE" ? "You can now create and publish tests." : "Please contact support for more information.", type: status === "ACTIVE" ? "SUCCESS" : "ERROR", readAt: null });
  await audit(actor.id, `TEACHER_${status}`, "User", id);
  return send(res, 200, { user: cleanUser(await getById("users", id)) });
}

async function changeUserRole(req, res, actor, id) {
  const b = await readBody(req);
  if (!["SUPER_ADMIN", "TEACHER", "STUDENT"].includes(b.role)) return send(res, 400, { error: "Invalid role." });
  await updateOne("users", { _id: oid(id) }, { $set: { role: b.role, status: b.role === "TEACHER" ? "ACTIVE" : undefined, updatedAt: new Date() } });
  if (b.role === "TEACHER") await col("teacherProfiles").updateOne({ userId: id }, { $setOnInsert: timestamps({ userId: id, teacherName: (await getById("users", id)).name, branding: defaultBranding(), approvedAt: new Date() }) }, { upsert: true });
  await audit(actor.id, "CHANGE_USER_ROLE", "User", id, { role: b.role });
  return send(res, 200, { user: cleanUser(await getById("users", id)) });
}

async function changeUserStatus(req, res, actor, id) {
  const b = await readBody(req);
  if (!["ACTIVE", "DEACTIVATED", "BLOCKED"].includes(b.status)) return send(res, 400, { error: "Invalid status." });
  await updateOne("users", { _id: oid(id) }, { $set: { status: b.status, updatedAt: new Date() } });
  await audit(actor.id, "CHANGE_USER_STATUS", "User", id, { status: b.status });
  return send(res, 200, { user: cleanUser(await getById("users", id)) });
}

async function listNotifications(res, user) {
  return send(res, 200, { notifications: await findMany("notifications", { userId: user.id }, { sort: { createdAt: -1 }, limit: 50 }) });
}

async function markNotification(res, user, id) {
  await updateOne("notifications", { _id: oid(id), userId: user.id }, { $set: { readAt: new Date() } });
  return send(res, 200, { ok: true });
}

async function studentDashboard(res, user) {
  const results = (await Promise.all((await findMany("results", { studentUserId: user.id }, { sort: { createdAt: -1 } })).map(hydrateResultRow))).map((r) => studentVisibleResult(r, user));
  const certs = [];
  for (const c of await findMany("certificates", {}, { sort: { createdAt: -1 } })) {
    const r = await getResult(c.resultId);
    if (r?.studentUserId === user.id && canSeeDetailedResult(r, user)) certs.push(await hydrateCertificate(c));
  }
  const tests = (await findMany("tests", { status: "PUBLISHED" }, { sort: { createdAt: -1 }, limit: 20 })).map(parseTest);
  return send(res, 200, { results, certificates: certs, tests });
}

async function listAdminTeachers() {
  const teachers = await findMany("users", { role: "TEACHER" }, { sort: { createdAt: -1 } });
  return Promise.all(teachers.map(async (u) => ({ ...cleanUser(u), ...(await col("teacherProfiles").findOne({ userId: u.id }) || {}) })));
}

async function listAdminTests() {
  const tests = await findMany("tests", {}, { sort: { createdAt: -1 } });
  return Promise.all(tests.map(async (t) => ({ ...parseTest(t), teacher_name: (await getById("users", t.teacherId))?.name || "" })));
}

async function listAdminObjections() {
  const objections = await findMany("objections", {}, { sort: { createdAt: -1 } });
  return Promise.all(objections.map(async (o) => ({ ...o, test_title: (await getById("tests", o.testId))?.title || "", student_name: o.studentUserId ? (await getById("users", o.studentUserId))?.name || "" : "" })));
}

async function listRecentTeacherResults(teacherId) {
  const tests = await findMany("tests", { teacherId });
  const rows = await findMany("results", { testId: { $in: tests.map((t) => t.id) } }, { sort: { createdAt: -1 }, limit: 8 });
  return Promise.all(rows.map(hydrateResultRow));
}

async function getCertificateForResult(resultId) {
  const cert = await col("certificates").findOne({ resultId });
  return cert ? hydrateCertificate(cert) : null;
}

async function hydrateCertificate(cert) {
  const test = await getById("tests", cert.testId);
  const teacher = test ? await getById("users", test.teacherId) : null;
  const profile = test ? await col("teacherProfiles").findOne({ userId: test.teacherId }) : null;
  const result = cert.resultId ? await getResult(cert.resultId) : null;
  const attempt = result?.attemptId ? await getById("attempts", result.attemptId) : null;
  return {
    ...toPublic(cert),
    certificate_id: cert.certificateId,
    result_id: cert.resultId,
    test_id: cert.testId,
    issued_at: cert.issuedAt,
    student_name: cert.studentName,
    student_details: result?.studentDetails || {},
    test_title: test?.title,
    title: test?.title,
    subject: test?.subject,
    className: test?.className,
    total_marks: result?.totalMarks,
    score: result?.score,
    percentage: result?.percentage,
    grade: result?.grade,
    passed: result?.passed,
    rank_label: result?.rankLabel,
    teacher_name: teacher?.name,
    organization_name: profile?.organizationName,
    test: test ? {
      title: test.title,
      subject: test.subject || "",
      className: test.className || "",
      description: test.description || "",
      totalMarks: test.totalMarks,
      passingMarks: test.passingMarks,
      durationMinutes: test.settings?.durationMinutes || null,
      publishedAt: test.publishedAt || null
    } : null,
    attempt: attempt ? {
      started_at: attempt.startedAt,
      submitted_at: attempt.submittedAt,
      time_taken: attempt.timeTaken,
      student_identity_id: attempt.studentIdentityId || null
    } : null,
    result: result ? {
      score: result.score,
      totalMarks: result.totalMarks,
      percentage: result.percentage,
      grade: result.grade,
      passed: result.passed,
      rankLabel: result.rankLabel,
      correct: result.correct,
      wrong: result.wrong,
      unattempted: result.unattempted,
      accuracy: result.accuracy
    } : null,
    verificationUrl: `${APP_URL}/#verify/${encodeURIComponent(cert.certificateId)}`
  };
}

function hydrateAttempt(attempt) {
  return { ...attempt, started_at: attempt.startedAt, submitted_at: attempt.submittedAt, due_at: attempt.dueAt, time_taken: attempt.timeTaken };
}

function hydrateStudentIdentity(identity) {
  return { ...identity, display_id: identity.displayId, expires_at: identity.expiresAt, created_at: identity.createdAt };
}

async function getResult(id) {
  const row = await getById("results", id);
  return row ? hydrateResultRow(row) : null;
}

async function getResultByAttempt(attemptId) {
  const row = await col("results").findOne({ attemptId });
  return row ? getResult(row._id) : null;
}

async function hydrateResultRow(row) {
  const attempt = await getById("attempts", row.attemptId);
  const test = await getById("tests", row.testId);
  const user = row.studentUserId ? await getById("users", row.studentUserId) : null;
  const cert = await col("certificates").findOne({ resultId: row.id });
  const details = attempt?.details || {};
  return {
    ...toPublic(row),
    total_marks: row.totalMarks,
    rank_label: row.rankLabel,
    time_taken: row.timeTaken,
    breakdown_json: JSON.stringify(row.breakdown || {}),
    certificate_id: cert?.certificateId,
    testSettings: test?.settings || {},
    test_status: test?.status,
    due_at: attempt?.dueAt,
    teacher_id: test?.teacherId,
    studentDetails: details,
    studentName: details.fullName || details.name || user?.name || "Student",
    testTitle: test?.title
  };
}

function parseQuestion(q) {
  if (!q) return null;
  return { ...toPublic(q), imageUrl: q.imageUrl || q.image_url, negativeMarks: Number(q.negativeMarks || 0), options: q.options || [], correct: q.correct || [], tags: q.tags || [], favorite: !!q.favorite, archived: !!q.archived };
}

function parseTest(t) {
  if (!t) return null;
  return { ...toPublic(t), totalMarks: Number(t.totalMarks || 0), passingMarks: Number(t.passingMarks || 0), shareSlug: t.shareSlug, accessMode: t.accessMode, accessCode: t.accessCode, settings: { ...defaultSettings(), ...(t.settings || {}) }, studentFields: t.studentFields || defaultStudentFields(), instructionsEn: t.instructionsEn, instructionsHi: t.instructionsHi, branding: t.branding || {}, questionIds: t.questionIds || [], published_at: t.publishedAt };
}

function normalizeQuestion(b) {
  if (!b.text || String(b.text).trim().length < 3) throw statusError(400, "Question text is required.");
  return { type: b.type || "MCQ", text: String(b.text).trim(), imageUrl: b.imageUrl || "", options: Array.isArray(b.options) ? b.options.filter(Boolean) : [], correct: Array.isArray(b.correct) ? b.correct : [b.correct].filter(Boolean), marks: Number(b.marks || 1), negativeMarks: Number(b.negativeMarks || 0), explanation: b.explanation || "", subject: b.subject || "", chapter: b.chapter || "", topic: b.topic || "", difficulty: b.difficulty || "Medium", tags: Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(",").map((x) => x.trim()).filter(Boolean), favorite: !!b.favorite };
}

function normalizeTest(b) {
  if (!b.title || String(b.title).trim().length < 3) throw statusError(400, "Test name is required.");
  const questionIds = Array.isArray(b.questionIds) ? b.questionIds.map(String).filter(Boolean) : [];
  return { title: String(b.title).trim(), subject: b.subject || "", className: b.className || "", description: b.description || "", totalMarks: Number(b.totalMarks || 0), passingMarks: Number(b.passingMarks || 0), status: b.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT", visibility: b.visibility || "PRIVATE", accessMode: b.accessMode || "GUEST_ALLOWED", accessCode: b.accessCode || "", settings: { ...defaultSettings(), ...(b.settings || {}) }, studentFields: Array.isArray(b.studentFields) && b.studentFields.length ? b.studentFields : defaultStudentFields(), instructionsEn: b.instructionsEn || "Read every question carefully. Your timer starts only after you press Start Test.", instructionsHi: b.instructionsHi || "हर प्रश्न ध्यान से पढ़ें। Start Test दबाने के बाद ही आपका टाइमर शुरू होगा।", branding: b.branding || defaultBranding(), questionIds };
}

function defaultSettings() {
  return { durationMinutes: 45, availabilityStart: "", availabilityEnd: "", maxAttempts: 1, allowPrevious: true, allowReviewMark: true, randomQuestions: false, randomOptions: false, fullscreen: false, tabSwitchWarning: true, calculatorAllowed: false, resultRelease: "IMMEDIATE", rankingEnabled: true, tieBreakers: ["accuracy", "timeTaken"], answerReview: { enabled: true, showCorrect: true, showExplanation: true }, certificate: { enabled: true, eligibility: "PASSED", minimumPercentage: 33, topCount: 3, template: { style: "Modern", color: "#7c3aed" } }, resultVisibility: defaultResultVisibility() };
}
function defaultResultVisibility() { return { marks: true, percentage: true, grade: true, rank: true, correctAnswers: true, wrongAnswers: true, explanations: true, topicAnalysis: true, feedback: true }; }
function defaultBranding() { return { showTeacherName: true, showOrganization: true, showLogo: true, showDesignation: true, showContact: false, showSignature: true }; }
function defaultStudentFields() { return [{ key: "fullName", label: "Full Name", mode: "required" }, { key: "rollNumber", label: "Roll Number", mode: "optional" }, { key: "className", label: "Class", mode: "optional" }, { key: "section", label: "Section", mode: "optional" }, { key: "email", label: "Email", mode: "optional" }]; }

function validateStudentDetails(fields, details) {
  const clean = {};
  for (const field of fields || defaultStudentFields()) {
    if (field.mode === "hide") continue;
    const value = String(details[field.key] || "").trim();
    if (field.mode === "required" && !value) throw statusError(400, `${field.label} is required.`);
    clean[field.key] = value;
  }
  return clean;
}
function ensureTestCanStart(test) { const now = Date.now(); if (test.settings.availabilityStart && new Date(test.settings.availabilityStart).getTime() > now) throw statusError(400, "Test has not started yet."); if (test.settings.availabilityEnd && new Date(test.settings.availabilityEnd).getTime() < now) throw statusError(400, "Test is closed for new students."); }
function requiresManual(q) { return ["LONG_ANSWER", "SHORT_ANSWER"].includes(q.type) && !q.correct.length; }
function isCorrect(q, value) { const correct = q.correct.map((v) => String(v).trim().toLowerCase()); if (q.type === "MULTIPLE_CORRECT") return JSON.stringify((Array.isArray(value) ? value : []).map((v) => String(v).trim().toLowerCase()).sort()) === JSON.stringify([...correct].sort()); if (q.type === "NUMERICAL") return correct.some((c) => Math.abs(Number(c) - Number(value)) < 0.00001); return correct.includes(String(value).trim().toLowerCase()); }
function resultVisibleNow(test) { return test.settings.resultRelease === "IMMEDIATE"; }
function gradeFor(p) { if (p >= 90) return "A+"; if (p >= 80) return "A"; if (p >= 70) return "B+"; if (p >= 60) return "B"; if (p >= 50) return "C"; return "D"; }
function resultSummary(rows) { if (!rows.length) return { highest: 0, lowest: 0, average: 0, passPercentage: 0 }; const scores = rows.map((r) => Number(r.score)); return { highest: Math.max(...scores), lowest: Math.min(...scores), average: round(scores.reduce((a, b) => a + b, 0) / scores.length), passPercentage: round((rows.filter((r) => r.passed).length / rows.length) * 100) }; }
async function snapshotTest(id) { await insert("testHistory", { testId: id, snapshot: { test: await getById("tests", id) } }); }
async function ensureOwnQuestion(teacherId, id) { if (!(await col("questions").findOne({ _id: oid(id), teacherId }))) throw statusError(404, "Question not found."); }
async function ensureOwnTest(teacherId, id) { if (!(await col("tests").findOne({ _id: oid(id), teacherId }))) throw statusError(404, "Test not found."); }
function requireTeacher(user) { requireRole(user, "TEACHER"); if (user.status !== "ACTIVE") throw statusError(403, "Teacher account is pending approval."); }
function requireRole(user, role) { if (!user || user.role !== role) throw statusError(403, "Access denied."); }
function requireUser(user) { if (!user) throw statusError(401, "Login required."); return cleanUser(user); }

async function getAuthUser(req) { const header = req.headers.authorization || ""; const token = header.startsWith("Bearer ") ? header.slice(7) : ""; const payload = verifyToken(token); if (!payload) return null; const user = await getById("users", payload.id); if (!user || user.status === "BLOCKED" || user.status === "DEACTIVATED") return null; return user; }
function signToken(id) { const payload = Buffer.from(JSON.stringify({ id, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString("base64url"); const sig = crypto.createHmac("sha256", authSecret()).update(payload).digest("base64url"); return `${payload}.${sig}`; }
function verifyToken(token) { try { if (!token || !token.includes(".")) return null; const [payload, sig] = token.split("."); const expected = crypto.createHmac("sha256", authSecret()).update(payload).digest("base64url"); if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return data.exp > Date.now() ? data : null; } catch { return null; } }
function authSecret() { if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET; if (isProd) throw new Error("AUTH_SECRET is required in production."); return setupToken || "dev-secret"; }
async function hashPassword(password) { const salt = crypto.randomBytes(16).toString("base64url"); const key = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, derived) => err ? reject(err) : resolve(derived.toString("base64url")))); return `scrypt$${salt}$${key}`; }
async function verifyPassword(password, hash) { if (!hash?.startsWith("scrypt$")) return false; const [, salt, key] = hash.split("$"); const actual = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, derived) => err ? reject(err) : resolve(derived.toString("base64url")))); return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(actual)); }
function cleanUser(user) { if (!user) return null; const { passwordHash, tempPasswordHash, claimCodeHash, ...rest } = toPublic(user); return rest; }
function validateEmail(email) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""))) throw statusError(400, "Valid email is required."); }
function validatePassword(password) { if (String(password || "").length < 8) throw statusError(400, "Password must be at least 8 characters."); }

async function ensureAttemptAccess(id, user, body = {}) { const attempt = await getById("attempts", id); if (!attempt) throw statusError(404, "Attempt not found."); if (attempt.studentUserId && (!user || attempt.studentUserId !== user.id)) throw statusError(403, "Access denied."); if (!attempt.studentUserId && attempt.guestKey && body.guestKey !== attempt.guestKey) throw statusError(403, "Access denied."); return attempt; }
function ensureResultAccess(result, user) { if (!result) throw statusError(404, "Result not found."); if (user?.role === "SUPER_ADMIN") return; if (user?.role === "TEACHER" && result.teacher_id === user.id) return; if (result.studentUserId && user?.id === result.studentUserId) return; if (!result.studentUserId) return; throw statusError(403, "Access denied."); }
function canSeeDetailedResult(result, user) { if (!result) return false; if (user?.role === "SUPER_ADMIN") return true; if (user?.role === "TEACHER" && result.teacher_id === user.id) return true; if (result.test_status && result.test_status !== "PUBLISHED") return true; const settings = result.testSettings || {}; if (settings.resultRelease === "NEVER") return false; const times = [settings.availabilityEnd, result.due_at].filter(Boolean).map((v) => new Date(v).getTime()).filter(Number.isFinite); return !times.length || Date.now() >= Math.max(...times); }
function studentVisibleResult(result, user) { if (!result) return result; const detailed = canSeeDetailedResult(result, user); const unlockAt = result.testSettings?.availabilityEnd || result.due_at || null; if (detailed) return { ...result, detailsAvailable: true, lockedUntil: null }; return { id: result.id, testId: result.testId, test_id: result.testId, attemptId: result.attemptId, attempt_id: result.attemptId, studentUserId: result.studentUserId, score: result.score, totalMarks: result.totalMarks, total_marks: result.totalMarks, percentage: result.percentage, passed: !!result.passed, grade: result.grade, studentName: result.studentName, testTitle: result.testTitle, detailsAvailable: false, lockedUntil: unlockAt, lockedMessage: "Detailed result, rank, answers and certificate will be available after the test ends." }; }

function compareRank(a, b, breakers) { if (Number(b.score) !== Number(a.score)) return Number(b.score) - Number(a.score); for (const br of breakers) { if (br === "accuracy" && Number(b.accuracy) !== Number(a.accuracy)) return Number(b.accuracy) - Number(a.accuracy); if (br === "correct" && Number(b.correct) !== Number(a.correct)) return Number(b.correct) - Number(a.correct); if (br === "negativeMarks" && Number(a.wrong) !== Number(b.wrong)) return Number(a.wrong) - Number(b.wrong); if (br === "timeTaken" && Number(a.timeTaken) !== Number(b.timeTaken)) return Number(a.timeTaken) - Number(b.timeTaken); } return 0; }
async function bumpQuestionUsage(teacherId, ids) { if (ids.length) await col("questions").updateMany({ _id: { $in: ids.map(oid) }, teacherId }, { $inc: { usageCount: 1 } }); }
async function uniqueSlug(title) { const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || "test"; let slug = `${base}-${crypto.randomBytes(3).toString("hex")}`; while (await col("tests").findOne({ shareSlug: slug })) slug = `${base}-${crypto.randomBytes(3).toString("hex")}`; return slug; }
function studentName(attempt) { return attempt.details?.fullName || attempt.details?.name || "A student"; }
function randomPassword() { return crypto.randomBytes(6).toString("base64url"); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function round(n) { return Math.round(Number(n) * 100) / 100; }
function shouldRandomize(value) { return value === true || value === "true"; }
function shuffle(items) { return [...items].sort(() => Math.random() - 0.5); }
function stringifyAnswer(value) { return Array.isArray(value) ? value.join("; ") : String(value ?? ""); }
function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function sortByCreatedDesc(a, b) { return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); }
function orderByIds(ids) { const order = new Map(ids.map((id, i) => [String(id), i])); return (a, b) => (order.get(String(a.id)) ?? 99999) - (order.get(String(b.id)) ?? 99999); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function stripMongo(doc) { const copy = { ...doc }; delete copy._id; delete copy.id; delete copy.createdAt; delete copy.updatedAt; delete copy.questions; return copy; }
function sanitizeFileName(value) { return path.basename(String(value)).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload"; }
function collectUploadIds(value, ids = new Set()) {
  if (!value) return ids;
  if (typeof value === "string") {
    const matches = value.matchAll(/\/uploads\/([a-f0-9]{24})/gi);
    for (const match of matches) ids.add(match[1]);
    return ids;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUploadIds(item, ids));
    return ids;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((item) => collectUploadIds(item, ids));
  }
  return ids;
}
async function deleteUploadFiles(ids) {
  const unique = [...new Set(ids)].filter((id) => ObjectId.isValid(id));
  await Promise.all(unique.map(async (id) => {
    await filesBucket.delete(oid(id)).catch(() => undefined);
    await col("mediaFiles").deleteMany({ $or: [{ fileId: id }, { url: `/uploads/${id}` }] });
  }));
}
function statusError(status, message) { const error = new Error(message); error.status = status; return error; }
function safeError(error) { return { message: error?.message || String(error), name: error?.name, code: error?.code }; }

async function readBody(req, limit = 1_500_000) { if (req._cachedBody) return req._cachedBody; const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw statusError(413, "Request is too large."); chunks.push(chunk); } const text = Buffer.concat(chunks).toString("utf8") || "{}"; req._cachedBody = JSON.parse(text); return req._cachedBody; }
function send(res, status, data = null) { if (data === null) { res.writeHead(status); return res.end(); } res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
function sendPdf(res, buffer, fileName) { res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${fileName}"` }); res.end(buffer); }
function serveApp(res, urlPath) { const dist = path.resolve(root, "dist"); const file = urlPath === "/" ? path.join(dist, "index.html") : path.join(dist, urlPath); if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveStatic(res, file, dist); const index = path.join(dist, "index.html"); if (fs.existsSync(index)) return serveStatic(res, index, dist); send(res, 200, { message: "TestSetu API is running. Start the Vite frontend with npm run client." }); }
function serveStatic(res, requested, base) { const resolved = path.resolve(requested); if (!resolved.startsWith(path.resolve(base))) return send(res, 403, { error: "Forbidden" }); if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return send(res, 404, { error: "File not found" }); res.writeHead(200, { "Content-Type": mimeFor(resolved) }); fs.createReadStream(resolved).pipe(res); }
function mimeFor(file) { if (file.endsWith(".html")) return "text/html"; if (file.endsWith(".js")) return "text/javascript"; if (file.endsWith(".css")) return "text/css"; if (file.endsWith(".svg")) return "image/svg+xml"; if (file.endsWith(".png")) return "image/png"; if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg"; if (file.endsWith(".pdf")) return "application/pdf"; return "application/octet-stream"; }
function applyCors(req, res) { const origin = req.headers.origin; if (origin && [FRONTEND_URL, APP_URL].filter(Boolean).includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); } res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS"); }

function col(name) { return db.collection(name); }
function oid(id) { if (id instanceof ObjectId) return id; if (!ObjectId.isValid(String(id))) throw statusError(400, "Invalid id."); return new ObjectId(String(id)); }
function toPublic(doc) { if (!doc) return doc; const copy = { ...doc, id: String(doc._id || doc.id) }; delete copy._id; return copy; }
function timestamps(doc) { const now = new Date(); return { ...doc, createdAt: doc.createdAt || now, updatedAt: doc.updatedAt || now }; }
async function insert(name, doc) { const payload = timestamps(doc); const result = await col(name).insertOne(payload); return toPublic({ ...payload, _id: result.insertedId }); }
async function updateOne(name, filter, update) { if (update.$set) update.$set = Object.fromEntries(Object.entries(update.$set).filter(([, v]) => v !== undefined)); return col(name).updateOne(filter, update); }
async function getById(name, id) { if (!id) return null; const doc = await col(name).findOne({ _id: oid(id) }); return doc ? toPublic(doc) : null; }
async function findMany(name, filter = {}, options = {}) { const rows = await col(name).find(filter).sort(options.sort || {}).limit(options.limit || 0).toArray(); return rows.map(toPublic); }
async function count(name, filter = {}) { return col(name).countDocuments(filter); }
async function countSuperAdmins() { return count("users", { role: "SUPER_ADMIN" }); }
async function audit(actorId, action, entityType, entityId, details = {}) { await insert("auditLogs", { actorId, action, entityType, entityId: String(entityId || ""), details }); }
async function notifyAdmins(title, body, type) { const admins = await findMany("users", { role: "SUPER_ADMIN", status: "ACTIVE" }); await Promise.all(admins.map((admin) => insert("notifications", { userId: admin.id, title, body, type, readAt: null }))); }
async function notifyTestStudents(testId, title, body, type) { const attempts = await findMany("attempts", { testId, studentUserId: { $ne: null } }); const ids = [...new Set(attempts.map((a) => a.studentUserId))]; await Promise.all(ids.map((id) => insert("notifications", { userId: id, title, body, type, readAt: null }))); }
function idFrom(pathName, index) { return decodeURIComponent(pathName.split("/")[index]); }

function simplePdf(title, lines) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const escaped = [title, ...lines].map((line) => String(line).replace(/[\\()]/g, "\\$&"));
  const text = ["BT", "/F1 22 Tf", "72 770 Td", `(${escaped[0]}) Tj`, "/F1 11 Tf"];
  for (const line of escaped.slice(1, 48)) text.push("0 -18 Td", `(${line.slice(0, 100)}) Tj`);
  text.push("ET");
  const stream = text.join("\n");
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(chunks.join(""))); chunks.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join(""));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) chunks.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.from(chunks.join(""));
}
