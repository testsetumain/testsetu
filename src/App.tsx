import { useEffect, useMemo, useState } from "react";
import {
  Award,
  Bell,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Copy,
  FileDown,
  FileQuestion,
  GraduationCap,
  LayoutDashboard,
  Lock,
  LogOut,
  Medal,
  Pencil,
  Play,
  Plus,
  QrCode,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Timer,
  Trash2,
  Upload,
  UserCheck,
  Users
} from "lucide-react";

type User = { id: number; email: string; name: string; role: "SUPER_ADMIN" | "TEACHER" | "STUDENT"; status: string };
type Question = any;
type Test = any;
type Result = any;

const tokenKey = "testsetu_token";
const runtimeEnv = ((import.meta as any).env || {}) as Record<string, string | undefined>;
const apiBaseUrl = String(runtimeEnv.VITE_API_URL || runtimeEnv.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "");

export default function App() {
  const [token, setToken] = useState(localStorage.getItem(tokenKey) || "");
  const [user, setUser] = useState<User | null>(null);
  const [setup, setSetup] = useState<any>(null);
  const [route, setRoute] = useState(location.hash || "#home");
  const [toast, setToast] = useState("");

  useEffect(() => {
    const onHash = () => setRoute(location.hash || "#home");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api("/setup/status").then(setSetup).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!token) return setUser(null);
    api("/auth/me", { token })
      .then((r) => setUser(r.user))
      .catch(() => {
        localStorage.removeItem(tokenKey);
        setToken("");
      });
  }, [token]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const loginDone = (payload: any) => {
    localStorage.setItem(tokenKey, payload.token);
    setToken(payload.token);
    setUser(payload.user);
    location.hash = "#home";
  };

  const logout = () => {
    localStorage.removeItem(tokenKey);
    setToken("");
    setUser(null);
  };

  if (route.startsWith("#test/")) return <PublicTest slug={route.replace("#test/", "")} token={token} notify={notify} />;
  if (route.startsWith("#result/")) return <ResultViewer id={route.replace("#result/", "")} token={token} notify={notify} />;
  if (route.startsWith("#certificate/")) return <CertificateViewer resultId={route.replace("#certificate/", "")} token={token} notify={notify} />;
  if (route.startsWith("#verify/")) return <VerifyCertificate id={route.replace("#verify/", "")} />;

  return (
    <div className="app">
      {toast && <div className="toast">{toast}</div>}
      <Topbar user={user} logout={logout} />
      {setup?.needsSetup && !user ? (
        <SetupCard setup={setup} onDone={() => api("/setup/status").then(setSetup)} notify={notify} />
      ) : !user ? (
        <AuthScreen onDone={loginDone} notify={notify} />
      ) : (
        <main className="shell">
          {user.role === "SUPER_ADMIN" && <AdminDashboard token={token} notify={notify} />}
          {user.role === "TEACHER" && <TeacherDashboard token={token} user={user} notify={notify} />}
          {user.role === "STUDENT" && <StudentDashboard token={token} notify={notify} />}
        </main>
      )}
    </div>
  );
}

function Topbar({ user, logout }: { user: User | null; logout: () => void }) {
  return (
    <header className="topbar">
      <a className="brand" href="#home" aria-label="TestSetu home">
        <span className="brandMark"><GraduationCap size={22} /></span>
        <span>TestSetu</span>
      </a>
      <nav className="topActions">
        <a href="#home">Dashboard</a>
        {user && <span className={`roleBadge ${user.role.toLowerCase()}`}>{user.role.replace("_", " ")}</span>}
        {user && <button className="iconBtn" onClick={logout} title="Logout"><LogOut size={18} /></button>}
      </nav>
    </header>
  );
}

function SetupCard({ setup, onDone, notify }: any) {
  const [form, setForm] = useState({ name: "Super Admin", email: "admin@testsetu.local", password: "", setupToken: setup.devSetupToken || "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (e: any) => {
    e.preventDefault();
    try {
      setError("");
      setSaving(true);
      await api("/setup", { method: "POST", body: form });
      notify("Super Admin created. Please log in.");
      onDone();
    } catch (err: any) {
      const message = err.message || "Super Admin setup failed.";
      setError(message);
      notify(message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="authStage">
      <section className="authPanel">
        <div className="panelIntro">
          <ShieldCheck size={34} />
          <h1>Initialize TestSetu</h1>
          <p>Create the first Super Admin. In production, enter the same setup token that is configured in Render.</p>
        </div>
        <form className="formGrid" onSubmit={submit}>
          {error && <div className="formError">{error}</div>}
          <Field label="Name" value={form.name} onChange={(v: string) => setForm({ ...form, name: v })} />
          <Field label="Email" value={form.email} onChange={(v: string) => setForm({ ...form, email: v })} />
          <Field label="Password" type="password" value={form.password} onChange={(v: string) => setForm({ ...form, password: v })} />
          <Field label="Setup token from Render" value={form.setupToken} onChange={(v: string) => setForm({ ...form, setupToken: v })} />
          <button className="primaryBtn" disabled={saving}><Lock size={18} /> {saving ? "Creating..." : "Create Super Admin"}</button>
        </form>
      </section>
    </main>
  );
}

function AuthScreen({ onDone, notify }: any) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [role, setRole] = useState<"STUDENT" | "TEACHER">("TEACHER");
  const [form, setForm] = useState({ name: "", email: "", password: "", organizationName: "", subject: "", designation: "", city: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (e: any) => {
    e.preventDefault();
    try {
      setError("");
      setSaving(true);
      const payload = mode === "login"
        ? await api("/auth/login", { method: "POST", body: { email: form.email, password: form.password } })
        : await api("/auth/register", { method: "POST", body: { ...form, role } });
      if (mode === "register" && role === "TEACHER") notify("Teacher registered. Super Admin approval is required.");
      onDone(payload);
    } catch (err: any) {
      const message = err.message || `${mode === "login" ? "Login" : "Registration"} failed.`;
      setError(message);
      notify(message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="authStage">
      <section className="productHero">
        <div className="heroRibbon"><Sparkles size={16} /> Online tests, results, certificates</div>
        <h1>TestSetu</h1>
        <p>Teachers create assessments, students take them smoothly on mobile, and verified results, ranks, certificates and objections stay connected to the database.</p>
        <div className="heroStats">
          <MetricCard tone="blue" icon={<FileQuestion />} label="Question Bank" value="10 Types" />
          <MetricCard tone="green" icon={<CheckCircle2 />} label="Evaluation" value="Auto + Manual" />
          <MetricCard tone="purple" icon={<Award />} label="Certificates" value="QR Verified" />
        </div>
      </section>
      <section className="authPanel">
        <CertificateLookup notify={notify} />
        <div className="segmented">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Login</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Register</button>
        </div>
        {mode === "register" && (
          <div className="segmented slim">
            <button className={role === "TEACHER" ? "active" : ""} onClick={() => setRole("TEACHER")}>Teacher</button>
            <button className={role === "STUDENT" ? "active" : ""} onClick={() => setRole("STUDENT")}>Student</button>
          </div>
        )}
        <form className="formGrid" onSubmit={submit}>
          {error && <div className="formError">{error}</div>}
          {mode === "register" && <Field label="Name" value={form.name} onChange={(v: string) => setForm({ ...form, name: v })} />}
          <Field label="Email" value={form.email} onChange={(v: string) => setForm({ ...form, email: v })} />
          <Field label="Password" type="password" value={form.password} onChange={(v: string) => setForm({ ...form, password: v })} />
          {mode === "register" && role === "TEACHER" && (
            <>
              <Field label="Organization optional" value={form.organizationName} onChange={(v: string) => setForm({ ...form, organizationName: v })} />
              <Field label="Subject" value={form.subject} onChange={(v: string) => setForm({ ...form, subject: v })} />
              <Field label="Designation" value={form.designation} onChange={(v: string) => setForm({ ...form, designation: v })} />
              <Field label="City" value={form.city} onChange={(v: string) => setForm({ ...form, city: v })} />
            </>
          )}
          <button className="primaryBtn" disabled={saving}><UserCheck size={18} /> {saving ? "Please wait..." : mode === "login" ? "Login" : "Create Account"}</button>
        </form>
      </section>
    </main>
  );
}

function CertificateLookup({ notify }: any) {
  const [certificateId, setCertificateId] = useState("");
  const verify = async (e: any) => {
    e.preventDefault();
    const id = certificateId.trim();
    if (!id) return notify("Certificate ID enter karein.");
    location.hash = `#verify/${encodeURIComponent(id)}`;
  };
  return (
    <form className="verifyStrip" onSubmit={verify}>
      <QrCode size={19} />
      <Field label="Certificate verification" value={certificateId} onChange={setCertificateId} />
      <button className="secondaryBtn">Verify</button>
    </form>
  );
}

function AdminDashboard({ token, notify }: any) {
  const [data, setData] = useState<any>({});
  const [teachers, setTeachers] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [tests, setTests] = useState<any[]>([]);
  const [infra, setInfra] = useState<any>(null);
  const refreshInfrastructure = async () => {
    setInfra(await api("/admin/infrastructure/status", { token }));
  };
  const refresh = async () => {
    setData(await api("/admin/dashboard", { token }));
    setTeachers((await api("/admin/teachers", { token })).teachers);
    setUsers((await api("/admin/users", { token })).users);
    setTests((await api("/admin/tests", { token })).tests);
    await refreshInfrastructure();
  };
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refreshInfrastructure().catch(() => undefined), 45000);
    return () => window.clearInterval(timer);
  }, []);
  const approve = async (id: number, action: "approve" | "reject") => {
    await api(`/admin/teachers/${id}/${action}`, { method: "POST", token });
    notify(`Teacher ${action}d.`);
    refresh();
  };
  return (
    <DashboardFrame title="Super Admin" subtitle="Verify teachers, monitor tests, users, certificates and audit logs." icon={<ShieldCheck />}>
      <StatsGrid stats={[
        ["Teachers", data.stats?.teachers, "purple", <Users />],
        ["Pending", data.stats?.pendingTeachers, "amber", <Bell />],
        ["Students", data.stats?.students, "green", <GraduationCap />],
        ["Tests", data.stats?.tests, "blue", <ClipboardList />],
        ["Certificates", data.stats?.certificates, "purple", <Award />],
        ["Open objections", data.stats?.objections, "red", <FileQuestion />]
      ]} />
      <InfrastructureStatus infra={infra} refresh={refreshInfrastructure} />
      <Section title="Teacher Verification" action={<RefreshButton onClick={refresh} />}>
        <DataTable rows={teachers} columns={["name", "email", "organization_name", "subject", "status"]} actions={(r: any) => (
          <>
            <button className="successBtn" onClick={() => approve(r.id, "approve")}>Approve</button>
            <button className="dangerBtn" onClick={() => approve(r.id, "reject")}>Reject</button>
          </>
        )} />
      </Section>
      <Section title="Users">
        <DataTable rows={users} columns={["id", "name", "email", "role", "status"]} />
      </Section>
      <Section title="Platform Tests">
        <DataTable rows={tests} columns={["title", "subject", "status", "teacher_name", "created_at"]} />
      </Section>
    </DashboardFrame>
  );
}

function InfrastructureStatus({ infra, refresh }: any) {
  const cluster1 = infra?.mongodb?.cluster1;
  const cluster2 = infra?.mongodb?.cluster2;
  const storage = infra?.storage;
  const backend = infra?.backend;
  return (
    <Section title="Infrastructure Status" action={<button className="secondaryBtn" onClick={refresh}>Refresh Status</button>}>
      <div className="infraGrid">
        <InfraCard title="MongoDB Cluster 1" subtitle="Primary MongoDB" status={cluster1?.status} rows={[
          ["Database", cluster1?.database || "-"],
          ["Latency", cluster1?.latency != null ? `${cluster1.latency} ms` : "-"],
          ["Collections", cluster1?.collectionsCount ?? "-"],
          ["Last checked", cluster1?.lastChecked ? formatDateTime(cluster1.lastChecked) : "-"]
        ]} />
        <InfraCard title="MongoDB Cluster 2" subtitle="Secondary MongoDB" status={cluster2?.status || "Not Configured"} rows={[
          ["Configured", cluster2?.configured ? "Yes" : "No"],
          ["Database", cluster2?.database || "-"],
          ["Latency", cluster2?.latency != null ? `${cluster2.latency} ms` : "-"],
          ["Last checked", cluster2?.lastChecked ? formatDateTime(cluster2.lastChecked) : "-"]
        ]} />
        <InfraCard title="MongoDB File Storage" subtitle="GridFS uploads bucket" status={storage?.status} rows={[
          ["Type", storage?.type || "MongoDB GridFS"],
          ["Database", storage?.database || "-"],
          ["Bucket", storage?.bucket || "uploads"],
          ["Last checked", storage?.lastChecked ? formatDateTime(storage.lastChecked) : "-"]
        ]} />
        <InfraCard title="Render Backend" subtitle="API health" status={backend?.status} rows={[
          ["Environment", backend?.environment || "-"],
          ["Uptime", backend?.uptime != null ? `${backend.uptime}s` : "-"],
          ["Last checked", backend?.lastChecked ? formatDateTime(backend.lastChecked) : "-"]
        ]} />
      </div>
    </Section>
  );
}

function InfraCard({ title, subtitle, status = "Checking", rows }: any) {
  const tone = status === "Connected" || status === "Healthy" ? "ok" : status === "Not Configured" ? "muted" : "bad";
  return (
    <article className="infraCard">
      <div className="infraTop">
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        <span className={`infraStatus ${tone}`}>{status}</span>
      </div>
      <dl>{rows.map(([label, value]: any) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </article>
  );
}

function TeacherDashboard({ token, user, notify }: any) {
  const [tab, setTab] = useState("overview");
  const [dashboard, setDashboard] = useState<any>({});
  const [questions, setQuestions] = useState<Question[]>([]);
  const [tests, setTests] = useState<Test[]>([]);
  const [students, setStudents] = useState<any>({});
  const [objections, setObjections] = useState<any[]>([]);
  const [selectedResults, setSelectedResults] = useState<any>(null);
  const [publishingId, setPublishingId] = useState<number | null>(null);
  const [editingTest, setEditingTest] = useState<any>(null);
  const [loadError, setLoadError] = useState("");
  const [testAction, setTestAction] = useState("");
  const load = async () => {
    try {
      setDashboard(await api("/teacher/dashboard", { token }));
      setQuestions((await api("/teacher/questions", { token })).questions);
      setTests((await api("/teacher/tests", { token })).tests);
      setStudents(await api("/teacher/students", { token }));
      setObjections((await api("/teacher/objections", { token })).objections);
      setLoadError("");
    } catch (error: any) {
      const message = error.message || "Dashboard data load failed.";
      setLoadError(message);
      notify(message);
    }
  };
  useEffect(() => { load(); }, []);
  const publish = async (id: number) => {
    try {
      setPublishingId(id);
      await api(`/teacher/tests/${id}/publish`, { method: "POST", token });
      await load();
      notify("Test published. Share link is ready.");
    } catch (error: any) {
      notify(error.message || "Publish failed.");
    } finally {
      setPublishingId(null);
    }
  };
  const deleteTest = async (id: number) => {
    if (!confirm("Delete this test and all related attempts, results, certificates and files?")) return;
    try {
      setTestAction(`delete-${id}`);
      await api(`/teacher/tests/${id}`, { method: "DELETE", token });
      await load();
      setSelectedResults(null);
      notify("Test and related data deleted.");
    } catch (error: any) {
      notify(error.message || "Delete failed.");
    } finally {
      setTestAction("");
    }
  };
  const editTest = async (id: number) => {
    try {
      setTestAction(`edit-${id}`);
      const r = await api(`/teacher/tests/${id}`, { token });
      setEditingTest(r.test);
      setTab("builder");
      notify("Test opened for editing.");
    } catch (error: any) {
      notify(error.message || "Unable to open test for editing.");
    } finally {
      setTestAction("");
    }
  };
  const reExam = async (id: number) => {
    try {
      setTestAction(`reexam-${id}`);
      const r = await api(`/teacher/tests/${id}/duplicate`, { method: "POST", token });
      await load();
      setEditingTest(r.test);
      setTab("builder");
      notify("Re-exam draft created. Review and publish it.");
    } catch (error: any) {
      notify(error.message || "Re-exam draft failed.");
    } finally {
      setTestAction("");
    }
  };
  const loadResults = async (id: number) => {
    try {
      setTestAction(`results-${id}`);
      const data = await api(`/teacher/tests/${id}/results`, { token });
      setSelectedResults(data);
      setTab("results");
      notify("Results loaded.");
    } catch (error: any) {
      notify(error.message || "Results load failed.");
    } finally {
      setTestAction("");
    }
  };
  const releaseResults = async (id: number) => {
    try {
      setTestAction(`release-${id}`);
      const data = await api(`/teacher/tests/${id}/results/release`, { method: "POST", token });
      setSelectedResults(data);
      await load();
      notify("Results released for students.");
    } catch (error: any) {
      notify(error.message || "Result release failed.");
    } finally {
      setTestAction("");
    }
  };
  const nav = [
    ["overview", LayoutDashboard],
    ["studio", Sparkles],
    ["builder", Plus],
    ["questions", FileQuestion],
    ["tests", ClipboardList],
    ["students", Users],
    ["results", Medal],
    ["objections", Bell],
    ["settings", Settings]
  ];
  return (
    <DashboardFrame title={`Namaste, ${user.name}`} subtitle="Create Test -> Questions -> Settings -> Preview -> Publish" icon={<BookOpen />}>
      <div className="tabs">{nav.map(([name, Icon]: any) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}><Icon size={17} /> {name}</button>)}</div>
      {loadError && <div className="formError">{loadError}</div>}
      {tab === "overview" && (
        <>
          <StatsGrid stats={[
            ["Tests", dashboard.stats?.tests, "blue", <ClipboardList />],
            ["Published", dashboard.stats?.published, "green", <CheckCircle2 />],
            ["Questions", dashboard.stats?.questions, "amber", <FileQuestion />],
            ["Submissions", dashboard.stats?.submissions, "purple", <Send />],
            ["Certificates", dashboard.stats?.certificates, "purple", <Award />],
            ["Objections", dashboard.stats?.objections, "red", <Bell />]
          ]} />
          <Section title="Recent Tests"><TestCards tests={tests.slice(0, 4)} publish={publish} results={loadResults} releaseResults={releaseResults} publishingId={publishingId} actionId={testAction} deleteTest={deleteTest} editTest={editTest} reExam={reExam} /></Section>
        </>
      )}
      {tab === "studio" && <ExamStudio token={token} onRefresh={load} notify={notify} />}
      {tab === "builder" && <TestBuilder token={token} questions={questions} editingTest={editingTest} onCancelEdit={() => setEditingTest(null)} onSaved={() => { notify(editingTest ? "Test updated." : "Test saved."); setEditingTest(null); load(); }} />}
      {tab === "questions" && <QuestionBank token={token} questions={questions} onSaved={() => { notify("Question saved."); load(); }} />}
      {tab === "tests" && <Section title="My Tests"><TestCards tests={tests} publish={publish} results={loadResults} releaseResults={releaseResults} publishingId={publishingId} actionId={testAction} deleteTest={deleteTest} editTest={editTest} reExam={reExam} /></Section>}
      {tab === "students" && <StudentManager token={token} data={students} onRefresh={load} notify={notify} />}
      {tab === "results" && <ResultsPanel data={selectedResults} tests={tests} loadResults={loadResults} releaseResults={releaseResults} actionId={testAction} token={token} />}
      {tab === "objections" && <ObjectionPanel token={token} objections={objections} onRefresh={load} notify={notify} />}
      {tab === "settings" && <TeacherSettings />}
    </DashboardFrame>
  );
}

function ExamStudio({ token, onRefresh, notify }: any) {
  const [paperQuestions, setPaperQuestions] = useState<any[]>([]);
  const [paperKey, setPaperKey] = useState(0);
  const addPaperQuestion = (question: any) => {
    const id = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPaperQuestions((items) => [...items, { ...question, id }]);
    notify("Question added to this paper only.");
  };
  const removePaperQuestion = (id: string) => setPaperQuestions((items) => items.filter((q) => q.id !== id));
  const resetPaper = () => {
    setPaperQuestions([]);
    setPaperKey((key) => key + 1);
  };
  return (
    <div className="studioGrid">
      <QuickQuestionComposer onCreated={addPaperQuestion} />
      <div className="studioPaper">
        <Section title="This Paper's Questions" action={<button className="secondaryBtn" type="button" onClick={resetPaper}>New Paper</button>}>
          {paperQuestions.length ? (
            <div className="paperQuestionList">
              {paperQuestions.map((q, index) => (
                <article className="paperQuestionItem" key={q.id}>
                  <div>
                    <span className="pill">Q{index + 1}</span>
                    <b>{q.marks} marks</b>
                  </div>
                  <p>{q.text}</p>
                  <button className="secondaryBtn" type="button" onClick={() => removePaperQuestion(q.id)}><Trash2 size={16} /> Remove</button>
                </article>
              ))}
            </div>
          ) : <Empty title="Add questions for this paper" />}
        </Section>
        <TestBuilder
          key={paperKey}
          token={token}
          questions={paperQuestions}
          studioMode
          onSaved={() => {
            notify("Paper saved. Studio is ready for the next paper.");
            resetPaper();
            onRefresh();
          }}
        />
      </div>
    </div>
  );
}

function QuickQuestionComposer({ onCreated }: any) {
  const empty = () => ({ type: "MCQ", text: "", options: ["", "", "", ""], correct: [], marks: 1, negativeMarks: 0, subject: "", topic: "", explanation: "", allowOther: false });
  const objectiveTypes = ["MCQ", "TRUE_FALSE", "ASSERTION_REASON", "IMAGE_BASED", "PASSAGE_BASED"];
  const optionTypes = [...objectiveTypes, "MULTIPLE_CORRECT"];
  const [form, setForm] = useState<any>(empty());
  const [error, setError] = useState("");
  const setOption = (i: number, v: string) => {
    const options = [...form.options];
    options[i] = v;
    setForm({ ...form, options });
  };
  const save = async (e: any) => {
    e.preventDefault();
    try {
      if (!String(form.text || "").trim()) throw new Error("Question text is required.");
      if (optionTypes.includes(form.type) && form.options.filter(Boolean).length < 2) throw new Error("At least two options are required.");
      if (!form.correct?.length) throw new Error("Correct answer select karein.");
      onCreated({ ...form, correct: Array.isArray(form.correct) ? form.correct : [form.correct] });
      setForm(empty());
    } catch (err: any) {
      setError(err.message || "Question save failed.");
    }
  };
  return (
    <Section title="Create Questions Here">
      <form className="formGrid" onSubmit={save}>
        {error && <div className="formError">{error}</div>}
        <Select label="Question type" value={form.type} onChange={(v: string) => setForm({ ...form, type: v, correct: [] })} options={["MCQ", "MULTIPLE_CORRECT", "TRUE_FALSE", "FILL_BLANK", "SHORT_ANSWER", "LONG_ANSWER", "NUMERICAL", "IMAGE_BASED"]} />
        <TextArea label="Question" value={form.text} onChange={(v: string) => setForm({ ...form, text: v })} />
        {optionTypes.includes(form.type) && (
          <div className="optionEditor">
            {form.options.map((op: string, i: number) => <Field key={i} label={`Option ${i + 1}`} value={op} onChange={(v: string) => setOption(i, v)} />)}
            <div className="rowActions">
              <button type="button" className="secondaryBtn" onClick={() => setForm({ ...form, options: [...form.options, ""] })}><Plus size={16} /> Add option</button>
              <button type="button" className="secondaryBtn" disabled={form.options.length <= 2} onClick={() => setForm({ ...form, options: form.options.slice(0, -1), correct: (form.correct || []).filter((x: string) => form.options.slice(0, -1).includes(x)) })}><Trash2 size={16} /> Remove last</button>
            </div>
            {objectiveTypes.includes(form.type) && <Toggle label="Allow Other answer textbox" value={form.allowOther} onChange={(v: boolean) => setForm({ ...form, allowOther: v })} />}
          </div>
        )}
        {objectiveTypes.includes(form.type) && <Select label="Correct option" value={form.correct?.[0] || ""} onChange={(v: string) => setForm({ ...form, correct: v ? [v] : [] })} options={["", ...form.options.filter(Boolean)]} />}
        {form.type === "MULTIPLE_CORRECT" && <div className="fieldRules">{form.options.filter(Boolean).map((op: string) => <Toggle key={op} label={op} value={(form.correct || []).includes(op)} onChange={(checked: boolean) => setForm({ ...form, correct: checked ? [...(form.correct || []), op] : (form.correct || []).filter((x: string) => x !== op) })} />)}</div>}
        {!optionTypes.includes(form.type) && <Field label="Correct answer" value={Array.isArray(form.correct) ? form.correct.join(",") : form.correct} onChange={(v: string) => setForm({ ...form, correct: v.split(",").map((x) => x.trim()).filter(Boolean) })} />}
        <div className="inlineFields"><Field label="Marks" type="number" value={form.marks} onChange={(v: string) => setForm({ ...form, marks: Number(v) })} /><Field label="Negative" type="number" value={form.negativeMarks} onChange={(v: string) => setForm({ ...form, negativeMarks: Number(v) })} /></div>
        <div className="inlineFields"><Field label="Subject" value={form.subject} onChange={(v: string) => setForm({ ...form, subject: v })} /><Field label="Topic" value={form.topic} onChange={(v: string) => setForm({ ...form, topic: v })} /></div>
        <TextArea label="Explanation" value={form.explanation} onChange={(v: string) => setForm({ ...form, explanation: v })} />
        <button className="primaryBtn"><Plus size={18} /> Add To Paper</button>
      </form>
    </Section>
  );
}

function QuestionBank({ token, questions, onSaved }: any) {
  const emptyQuestion = () => ({ type: "MCQ", text: "", options: ["", "", "", ""], correct: [], marks: 1, negativeMarks: 0, subject: "", topic: "", chapter: "", difficulty: "Medium", explanation: "", tags: "", allowOther: false });
  const objectiveTypes = ["MCQ", "TRUE_FALSE", "ASSERTION_REASON", "IMAGE_BASED", "PASSAGE_BASED"];
  const optionTypes = [...objectiveTypes, "MULTIPLE_CORRECT"];
  const [form, setForm] = useState<any>(emptyQuestion());
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const visible = questions.filter((q: any) => `${q.text} ${q.subject} ${q.topic}`.toLowerCase().includes(query.toLowerCase()));
  const setOption = (i: number, v: string) => {
    const options = [...form.options];
    options[i] = v;
    setForm({ ...form, options });
  };
  const addOption = () => setForm({ ...form, options: [...(form.options || []), ""] });
  const removeOption = (i: number) => {
    const removed = form.options[i];
    const options = form.options.filter((_: string, index: number) => index !== i);
    setForm({ ...form, options: options.length ? options : [""], correct: (form.correct || []).filter((x: string) => x !== removed) });
  };
  const upload = async (file: File) => {
    const dataUrl = await fileToDataUrl(file);
    const r = await api("/uploads", { method: "POST", token, body: { fileName: file.name, dataUrl } });
    setForm({ ...form, imageUrl: r.url });
  };
  const save = async (e: any) => {
    e.preventDefault();
    const body = { ...form, correct: Array.isArray(form.correct) ? form.correct : [form.correct] };
    if (editingId) await api(`/teacher/questions/${editingId}`, { method: "PUT", token, body });
    else await api("/teacher/questions", { method: "POST", token, body });
    setEditingId(null);
    setForm(emptyQuestion());
    onSaved();
  };
  const editQuestion = (q: any) => {
    setEditingId(q.id);
    setForm({
      type: q.type || "MCQ",
      text: q.text || "",
      imageUrl: q.imageUrl || "",
      options: q.options?.length ? q.options : ["", "", "", ""],
      correct: q.correct || [],
      marks: q.marks || 1,
      negativeMarks: q.negativeMarks || 0,
      subject: q.subject || "",
      topic: q.topic || "",
      chapter: q.chapter || "",
      difficulty: q.difficulty || "Medium",
      explanation: q.explanation || "",
      tags: Array.isArray(q.tags) ? q.tags.join(", ") : q.tags || "",
      allowOther: !!q.allowOther
    });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyQuestion());
  };
  return (
    <div className="twoCol">
      <Section title={editingId ? "Edit Question" : "Create Question"} action={editingId && <button className="secondaryBtn" onClick={cancelEdit}>Cancel</button>}>
        <form className="formGrid" onSubmit={save}>
          <Select label="Type" value={form.type} onChange={(v: string) => setForm({ ...form, type: v })} options={["MCQ", "MULTIPLE_CORRECT", "TRUE_FALSE", "FILL_BLANK", "SHORT_ANSWER", "LONG_ANSWER", "NUMERICAL", "MATCH", "ASSERTION_REASON", "IMAGE_BASED", "PASSAGE_BASED"]} />
          <TextArea label="Question" value={form.text} onChange={(v: string) => setForm({ ...form, text: v })} />
          <div className="uploadBox">
            <Upload size={18} />
            <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            {form.imageUrl && (
              <>
                <img src={assetUrl(form.imageUrl)} alt="Question upload" />
                <button type="button" className="secondaryBtn" onClick={() => setForm({ ...form, imageUrl: "" })}><Trash2 size={16} /> Remove photo</button>
              </>
            )}
          </div>
          {optionTypes.includes(form.type) && (
            <div className="optionEditor">
              {(form.options || []).map((op: string, i: number) => (
                <div className="inlineFields" key={i}>
                  <Field label={`Option ${i + 1}`} value={op} onChange={(v: string) => setOption(i, v)} />
                  <button type="button" className="iconBtn" onClick={() => removeOption(i)} title="Remove option"><Trash2 size={16} /></button>
                </div>
              ))}
              <button type="button" className="secondaryBtn" onClick={addOption}><Plus size={16} /> Add option</button>
              {objectiveTypes.includes(form.type) && <Toggle label="Allow Other answer textbox" value={form.allowOther} onChange={(v: boolean) => setForm({ ...form, allowOther: v })} />}
            </div>
          )}
          {objectiveTypes.includes(form.type) && (
            <Select label="Correct option" value={form.correct?.[0] || ""} onChange={(v: string) => setForm({ ...form, correct: v ? [v] : [] })} options={["", ...(form.options || []).filter(Boolean)]} />
          )}
          {form.type === "MULTIPLE_CORRECT" && (
            <div className="fieldRules">{(form.options || []).filter(Boolean).map((op: string) => <Toggle key={op} label={op} value={(form.correct || []).includes(op)} onChange={(checked: boolean) => setForm({ ...form, correct: checked ? [...(form.correct || []), op] : (form.correct || []).filter((x: string) => x !== op) })} />)}</div>
          )}
          {!optionTypes.includes(form.type) && <Field label="Correct answer(s), comma separated" value={Array.isArray(form.correct) ? form.correct.join(",") : form.correct} onChange={(v: string) => setForm({ ...form, correct: v.split(",").map((x) => x.trim()).filter(Boolean) })} />}
          <div className="inlineFields">
            <Field label="Marks" type="number" value={form.marks} onChange={(v: string) => setForm({ ...form, marks: Number(v) })} />
            <Field label="Negative" type="number" value={form.negativeMarks} onChange={(v: string) => setForm({ ...form, negativeMarks: Number(v) })} />
          </div>
          <div className="inlineFields">
            <Field label="Subject" value={form.subject} onChange={(v: string) => setForm({ ...form, subject: v })} />
            <Field label="Topic" value={form.topic} onChange={(v: string) => setForm({ ...form, topic: v })} />
          </div>
          <TextArea label="Explanation" value={form.explanation} onChange={(v: string) => setForm({ ...form, explanation: v })} />
          <button className="primaryBtn"><Plus size={18} /> {editingId ? "Update Question" : "Save Question"}</button>
        </form>
      </Section>
      <Section title="Question Bank" action={<label className="search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" /></label>}>
        <div className="questionList">{visible.map((q: any) => <QuestionCard key={q.id} q={q} action={<button className="secondaryBtn" onClick={() => editQuestion(q)}><Pencil size={16} /> Edit</button>} />)}</div>
      </Section>
    </div>
  );
}

function TestBuilder({ token, questions, onSaved, editingTest, onCancelEdit, studioMode = false }: any) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const defaultTestForm = () => ({
    title: "", subject: "", className: "", description: "", passingMarks: 0, accessMode: "GUEST_ALLOWED", accessCode: "",
    questionIds: [], instructionsEn: "Read every question carefully. Confirm when you are ready to start.", instructionsHi: "हर प्रश्न ध्यान से पढ़ें। तैयार होने पर टेस्ट शुरू करें।",
    settings: { durationMinutes: 45, maxAttempts: 1, rankingEnabled: true, tieBreakers: ["accuracy", "timeTaken"], resultRelease: "IMMEDIATE", certificate: { enabled: true, eligibility: "PASSED", minimumPercentage: 33, template: { style: "DigiCoders", color: "#c79a2b", issuerName: "TestSetu", headline: "Certificate of Achievement" } }, answerReview: { enabled: true, showCorrect: true, showExplanation: true } },
    studentFields: [
      { key: "fullName", label: "Full Name", mode: "required" },
      { key: "rollNumber", label: "Roll Number", mode: "optional" },
      { key: "className", label: "Class", mode: "optional" },
      { key: "section", label: "Section", mode: "optional" }
    ]
  });
  const [form, setForm] = useState<any>(defaultTestForm());
  useEffect(() => {
    if (!editingTest) return;
    const base = defaultTestForm();
    setForm({
      ...base,
      ...editingTest,
      questionIds: editingTest.questionIds || editingTest.questions?.map((q: any) => q.id) || [],
      settings: {
        ...base.settings,
        ...(editingTest.settings || {}),
        certificate: { ...base.settings.certificate, ...(editingTest.settings?.certificate || {}), template: { ...base.settings.certificate.template, ...(editingTest.settings?.certificate?.template || {}) } },
        answerReview: { ...base.settings.answerReview, ...(editingTest.settings?.answerReview || {}) }
      },
      studentFields: editingTest.studentFields || base.studentFields
    });
    setStep(1);
  }, [editingTest?.id]);
  useEffect(() => { if (!editingTest && !studioMode) localStorage.setItem("testsetu_builder_draft", JSON.stringify(form)); }, [form, editingTest, studioMode]);
  const selectedQuestionIds = studioMode ? questions.map((q: any) => q.id) : form.questionIds;
  const selectedQuestions = questions.filter((q: any) => selectedQuestionIds.includes(q.id));
  const totalMarks = selectedQuestions.reduce((s: number, q: any) => s + Number(q.marks), 0);
  const save = async (publish = false) => {
    try {
      setError("");
      setSaving(true);
      if (publish && selectedQuestions.length === 0) throw new Error("Publish karne se pehle at least one question add karein.");
      const path = editingTest ? `/teacher/tests/${editingTest.id}` : "/teacher/tests";
      const method = editingTest ? "PUT" : "POST";
      const payload = {
        ...form,
        questionIds: studioMode ? [] : form.questionIds,
        embeddedQuestions: studioMode ? selectedQuestions.map(({ id, ...q }: any) => q) : undefined,
        totalMarks,
        status: publish ? "PUBLISHED" : (editingTest?.status || "DRAFT")
      };
      const saved = await api(path, { method, token, body: payload });
      if (publish) await api(`/teacher/tests/${saved.test.id}/publish`, { method: "POST", token });
      onSaved();
    } catch (err: any) {
      setError(err.message || "Test save failed.");
    } finally {
      setSaving(false);
    }
  };
  const toggleQuestion = (id: number) => setForm({ ...form, questionIds: form.questionIds.includes(id) ? form.questionIds.filter((x: number) => x !== id) : [...form.questionIds, id] });
  const setFieldMode = (i: number, mode: string) => {
    const studentFields = [...form.studentFields];
    studentFields[i] = { ...studentFields[i], mode };
    setForm({ ...form, studentFields });
  };
  return (
    <Section title={editingTest ? `Edit Test: ${editingTest.title}` : "Step-by-step Test Builder"} action={<span className="pill">Step {step}/10</span>}>
      <div className="builderSteps">{["Basic", "Questions", "Timing", "Student Details", "Instructions", "Result", "Certificate", "Design", "Preview", "Publish"].map((s, i) => <button className={step === i + 1 ? "active" : ""} onClick={() => setStep(i + 1)} key={s}>{s}</button>)}</div>
      {error && <div className="formError">{error}</div>}
      {step === 1 && <div className="formGrid"><Field label="Test name" value={form.title} onChange={(v: string) => setForm({ ...form, title: v })} /><Field label="Subject" value={form.subject} onChange={(v: string) => setForm({ ...form, subject: v })} /><Field label="Class" value={form.className} onChange={(v: string) => setForm({ ...form, className: v })} /><TextArea label="Description" value={form.description} onChange={(v: string) => setForm({ ...form, description: v })} /></div>}
      {step === 2 && (studioMode ? (
        <div className="questionPicker">
          {questions.length ? questions.map((q: any, index: number) => <div className="questionChoice selected" key={q.id}><span>{index + 1}. {q.text}</span><b>{q.marks} marks</b></div>) : <Empty title="Add questions from the Studio composer first" />}
        </div>
      ) : <div className="questionPicker">{questions.map((q: any) => <button key={q.id} className={form.questionIds.includes(q.id) ? "selected" : ""} onClick={() => toggleQuestion(q.id)}><span>{q.text}</span><b>{q.marks} marks</b></button>)}</div>)}
      {step === 3 && <div className="formGrid"><Field label="Duration minutes" type="number" value={form.settings.durationMinutes} onChange={(v: string) => setForm({ ...form, settings: { ...form.settings, durationMinutes: Number(v) } })} /><Field label="Availability start" type="datetime-local" value={form.settings.availabilityStart || ""} onChange={(v: string) => setForm({ ...form, settings: { ...form.settings, availabilityStart: v } })} /><Field label="Availability end" type="datetime-local" value={form.settings.availabilityEnd || ""} onChange={(v: string) => setForm({ ...form, settings: { ...form.settings, availabilityEnd: v } })} /><Select label="Access mode" value={form.accessMode} onChange={(v: string) => setForm({ ...form, accessMode: v })} options={["LOGIN_REQUIRED", "GUEST_ALLOWED", "TEMPORARY_LOGIN", "EXISTING_ACCOUNT_ONLY"]} /></div>}
      {step === 4 && <div className="fieldRules">{form.studentFields.map((f: any, i: number) => <div key={f.key}><b>{f.label}</b><div className="segmented mini">{["hide", "optional", "required"].map((m) => <button className={f.mode === m ? "active" : ""} onClick={() => setFieldMode(i, m)} key={m}>{m}</button>)}</div></div>)}</div>}
      {step === 5 && <div className="formGrid"><TextArea label="English instructions" value={form.instructionsEn} onChange={(v: string) => setForm({ ...form, instructionsEn: v })} /><TextArea label="Hindi instructions" value={form.instructionsHi} onChange={(v: string) => setForm({ ...form, instructionsHi: v })} /></div>}
      {step === 6 && <div className="formGrid"><Select label="Result release" value={form.settings.resultRelease} onChange={(v: string) => setForm({ ...form, settings: { ...form.settings, resultRelease: v } })} options={["IMMEDIATE", "AFTER_TEST_END", "AFTER_TEACHER_PUBLISHES", "NEVER"]} /><Field label="Passing marks" type="number" value={form.passingMarks} onChange={(v: string) => setForm({ ...form, passingMarks: Number(v) })} /><Toggle label="Ranking enabled" value={form.settings.rankingEnabled} onChange={(v: boolean) => setForm({ ...form, settings: { ...form.settings, rankingEnabled: v } })} /></div>}
      {step === 7 && <div className="formGrid"><Toggle label="Certificates enabled" value={form.settings.certificate.enabled} onChange={(v: boolean) => setForm({ ...form, settings: { ...form.settings, certificate: { ...form.settings.certificate, enabled: v } } })} /><Select label="Eligibility" value={form.settings.certificate.eligibility} onChange={(v: string) => setForm({ ...form, settings: { ...form.settings, certificate: { ...form.settings.certificate, eligibility: v } } })} options={["EVERYONE", "PASSED", "MIN_PERCENTAGE", "TOP_STUDENTS", "MANUAL_APPROVAL"]} /></div>}
      {step === 8 && <CertificateDesignEditor form={form} setForm={setForm} totalMarks={totalMarks} />}
      {step >= 9 && <PreviewCard form={form} totalMarks={totalMarks} questions={selectedQuestions} />}
      <div className="builderActions">
        <button className="secondaryBtn" disabled={step === 1} onClick={() => setStep(step - 1)}>Previous</button>
        <button className="secondaryBtn" disabled={step === 10} onClick={() => setStep(step + 1)}>Next</button>
        {editingTest && <button className="secondaryBtn" onClick={onCancelEdit}>Cancel Edit</button>}
        <button className="primaryBtn" disabled={saving} onClick={() => save(false)}>{saving ? "Saving..." : "Save Draft"}</button>
        <button className="successBtn" disabled={saving} onClick={() => save(true)}>{saving ? "Publishing..." : "Publish"}</button>
      </div>
    </Section>
  );
}

function PublicTest({ slug, token, notify }: any) {
  const [test, setTest] = useState<Test | null>(null);
  const [details, setDetails] = useState<any>({});
  const [attempt, setAttempt] = useState<any>(null);
  const [guestKey, setGuestKey] = useState("");
  const [step, setStep] = useState<"details" | "instructions" | "test" | "result">("details");
  const [answers, setAnswers] = useState<any>({});
  const [result, setResult] = useState<Result | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [autoSubmitTried, setAutoSubmitTried] = useState(false);
  useEffect(() => { api(`/public/tests/${slug}`, { token }).then((r) => { setTest(r.test); setError(""); }).catch((e) => { setError(e.message); notify(e.message); }); }, [slug]);
  useEffect(() => {
    if (!attempt?.due_at || step !== "test") return;
    const tick = () => setRemaining(Math.max(0, Math.round((new Date(attempt.due_at).getTime() - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [attempt, step]);
  useEffect(() => {
    if (remaining !== null && remaining <= 0 && step === "test" && attempt && !submitting && !autoSubmitTried) {
      setAutoSubmitTried(true);
      submit(true);
    }
  }, [remaining, step, attempt, submitting, autoSubmitTried]);
  if (!test) return <main className="shell"><Empty title="Loading test" /></main>;
  const start = async () => {
    if (!ready) {
      setError("Please confirm that you are ready to start the test.");
      return;
    }
    try {
      setError("");
      setStarting(true);
      const r = await api(`/public/tests/${slug}/start`, { method: "POST", token, body: { details } });
      setAttempt(r.attempt);
      setGuestKey(r.guestKey || "");
      setRemaining(r.attempt.due_at ? Math.max(1, Math.round((new Date(r.attempt.due_at).getTime() - Date.now()) / 1000)) : null);
      setAutoSubmitTried(false);
      setStep("test");
    } catch (err: any) {
      const message = err.message || "Test could not be started.";
      setError(message);
      notify(message);
    } finally {
      setStarting(false);
    }
  };
  const saveAnswer = async (qid: number, value: any) => {
    const next = { ...answers, [qid]: value };
    setAnswers(next);
    try {
      setError("");
      const r = await api(`/public/attempts/${attempt.id}/answer`, { method: "POST", token, body: { questionId: qid, value, guestKey } });
      if (r.result) {
        setResult(r.result);
        setStep("result");
        notify("Time is over. Your test has been submitted.");
      }
    } catch (err: any) {
      const message = err.message || "Answer could not be saved.";
      setError(message);
      notify(message);
    }
  };
  const submit = async (auto = false) => {
    if (submitting) return;
    if (!attempt) return;
    setSubmitting(true);
    try {
      setError("");
      const r = await api(`/public/attempts/${attempt.id}/submit`, { method: "POST", token, body: { guestKey } });
      setResult(r.result);
      setStep("result");
      if (auto) notify("Time is over. Your test has been submitted.");
    } catch (error: any) {
      const message = error.message || "Submit failed.";
      setError(message);
      notify(message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <main className="testShell">
      <section className="testHeader">
        <div><h1>{test.title}</h1><p>{test.subject} {test.className ? `| ${test.className}` : ""}</p></div>
        {step === "test" && <div className="timer"><Timer size={18} /> {remaining === null ? "No limit" : formatTime(remaining)}</div>}
      </section>
      {error && <div className="formError">{error}</div>}
      {step === "details" && (
        <section className="testCard">
          <h2>Student Details</h2>
          <div className="formGrid">{test.studentFields.filter((f: any) => f.mode !== "hide").map((f: any) => <Field key={f.key} label={`${f.label}${f.mode === "required" ? " *" : ""}`} value={details[f.key] || ""} onChange={(v: string) => setDetails({ ...details, [f.key]: v })} />)}</div>
          <button className="primaryBtn" onClick={() => { setError(""); setStep("instructions"); }}>Next</button>
        </section>
      )}
      {step === "instructions" && (
        <section className="testCard">
          <h2>Instructions</h2>
          <div className="instructionGrid"><p>{test.instructionsEn}</p><p lang="hi">{test.instructionsHi}</p></div>
          <div className="rules">
            <span>{test.questions.length} questions</span><span>{test.totalMarks} marks</span><span>{test.settings.durationMinutes} minutes</span><span>Negative marking may apply</span>
          </div>
          <label className="checkLine"><input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> <span>Are you ready to start the test? क्या आप टेस्ट शुरू करने के लिए तैयार हैं?</span></label>
          <button className="successBtn" disabled={starting} onClick={start}><Play size={18} /> {starting ? "Starting..." : "Start Test"}</button>
        </section>
      )}
      {step === "test" && (
        <section className="testRun">
          <div className="questionPane">{test.questions.map((q: any, index: number) => <StudentQuestion key={q.id} q={q} index={index} value={answers[q.id]} onChange={(v: any) => saveAnswer(q.id, v)} />)}</div>
          <aside className="palette">{test.questions.map((q: any, i: number) => <a className={answers[q.id] ? "answered" : ""} href={`#q-${q.id}`} key={q.id}>{i + 1}</a>)}<button className="dangerBtn" disabled={submitting} onClick={() => submit()}>{submitting ? "Submitting..." : "Submit"}</button></aside>
        </section>
      )}
      {step === "result" && result && <ResultCard result={result} token={token} />}
    </main>
  );
}

function StudentQuestion({ q, index, value, onChange }: any) {
  const singleChoiceTypes = ["MCQ", "TRUE_FALSE", "IMAGE_BASED", "PASSAGE_BASED", "ASSERTION_REASON"];
  const otherActive = value?.option === "__OTHER__";
  return (
    <article className="studentQuestion" id={`q-${q.id}`}>
      <div className="qTop"><span>Question {index + 1}</span><b>{q.marks} marks</b></div>
      <h3>{q.text}</h3>
      {q.imageUrl && <img className="questionImage" src={assetUrl(q.imageUrl)} alt="" />}
      {singleChoiceTypes.includes(q.type) && <div className="optionStack">
        {q.options.map((op: string) => <label key={op} className={value === op ? "option active" : "option"}><input type="radio" checked={value === op} onChange={() => onChange(op)} />{op}</label>)}
        {q.allowOther && (
          <label className={otherActive ? "option active otherOption" : "option otherOption"}>
            <input type="radio" checked={otherActive} onChange={() => onChange({ option: "__OTHER__", text: "" })} />
            <span>Other</span>
            {otherActive && <input value={value?.text || ""} onChange={(e) => onChange({ option: "__OTHER__", text: e.target.value })} placeholder="Type your answer" />}
          </label>
        )}
      </div>}
      {q.type === "MULTIPLE_CORRECT" && <div className="optionStack">{q.options.map((op: string) => <label key={op} className={(value || []).includes(op) ? "option active" : "option"}><input type="checkbox" checked={(value || []).includes(op)} onChange={(e) => onChange(e.target.checked ? [...(value || []), op] : (value || []).filter((x: string) => x !== op))} />{op}</label>)}</div>}
      {!["MCQ", "TRUE_FALSE", "IMAGE_BASED", "PASSAGE_BASED", "ASSERTION_REASON", "MULTIPLE_CORRECT"].includes(q.type) && <textarea value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder="Type your answer" />}
      <button className="secondaryBtn" onClick={() => onChange("")}>Clear answer</button>
    </article>
  );
}

function StudentDashboard({ token, notify }: any) {
  const [data, setData] = useState<any>({});
  const [claim, setClaim] = useState({ displayId: "", claimCode: "" });
  const load = async () => setData(await api("/student/dashboard", { token }));
  useEffect(() => { load(); }, []);
  const claimTemp = async () => {
    await api("/student/claim-temporary", { method: "POST", token, body: claim });
    notify("Temporary identity linked to this account.");
    load();
  };
  return (
    <DashboardFrame title="Student Dashboard" subtitle="Upcoming tests, results, certificates and answer reviews." icon={<GraduationCap />}>
      <StatsGrid stats={[["Available tests", data.tests?.length, "blue", <ClipboardList />], ["Results", data.results?.length, "green", <Medal />], ["Certificates", data.certificates?.length, "purple", <Award />]]} />
      <Section title="Live & Upcoming Tests"><div className="cardGrid">{data.tests?.map((t: any) => <div className="miniCard" key={t.id}><h3>{t.title}</h3><p>{t.subject}</p><a className="primaryBtn" href={`#test/${t.shareSlug}`}>Open Test</a></div>)}</div></Section>
      <Section title="Results"><div className="cardGrid">{data.results?.map((r: any) => <ResultCard key={r.id} result={r} compact token={token} />)}</div></Section>
      <Section title="Certificates"><div className="cardGrid">{data.certificates?.map((c: any) => <CertificateMiniCard key={c.id} certificate={c} />)}</div></Section>
      <Section title="Claim Temporary Identity"><div className="inlineFields"><Field label="User ID" value={claim.displayId} onChange={(v: string) => setClaim({ ...claim, displayId: v })} /><Field label="Claim code" value={claim.claimCode} onChange={(v: string) => setClaim({ ...claim, claimCode: v })} /><button className="secondaryBtn" onClick={claimTemp}>Claim</button></div></Section>
    </DashboardFrame>
  );
}

function ResultViewer({ id, token, notify }: any) {
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    api(`/public/results/${id}`, { token }).then((r) => setResult(r.result)).catch((e) => notify(e.message));
  }, [id, token]);
  return (
    <main className="testShell">
      <section className="testHeader">
        <div><h1>Result</h1><p>Marks, rank, answer review and certificate downloads</p></div>
        <a className="secondaryBtn" href="#home">Dashboard</a>
      </section>
      {result ? <ResultCard result={result} token={token} /> : <Empty title="Loading result" />}
    </main>
  );
}

function CertificateViewer({ resultId, token, notify }: any) {
  const [data, setData] = useState<any>(null);
  const [qr, setQr] = useState("");
  useEffect(() => {
    api(`/public/certificates/${resultId}`, { token }).then((r) => {
      setData(r.certificate);
      return api(`/public/verify/${r.certificate.certificate_id}/qr`);
    }).then((r) => setQr(r.dataUrl)).catch((e) => notify(e.message));
  }, [resultId, token]);
  return (
    <main className="authStage single">
      <section className="certificateView">
        {data ? (
          <>
            <ProfessionalCertificate certificate={data} qr={qr} />
            <div className="rowActions centeredActions">
              <button className="primaryBtn" onClick={() => downloadFile(`/public/certificates/${resultId}/pdf`, `certificate-${data.certificate_id}.pdf`, token)}><FileDown size={16} /> Download PDF</button>
              <a className="secondaryBtn" href={`#verify/${data.certificate_id}`}>Verify</a>
            </div>
          </>
        ) : <Empty title="Loading certificate" />}
      </section>
    </main>
  );
}

function CertificateMiniCard({ certificate }: any) {
  return (
    <div className="miniCard">
      <Award size={24} />
      <h3>{certificate.title || "Certificate"}</h3>
      <p>{certificate.certificate_id}</p>
      <div className="rowActions">
        <a className="secondaryBtn" href={`#certificate/${certificate.result_id}`}>View</a>
        <a className="secondaryBtn" href={`#verify/${certificate.certificate_id}`}>Verify</a>
      </div>
    </div>
  );
}

function VerifyCertificate({ id }: any) {
  const [data, setData] = useState<any>(null);
  const [qr, setQr] = useState("");
  useEffect(() => {
    api(`/public/verify/${id}`).then(setData).catch((e) => setData({ valid: false, error: e.message }));
    api(`/public/verify/${id}/qr`).then((r) => setQr(r.dataUrl)).catch(() => undefined);
  }, [id]);
  return (
    <main className="verifyStage">
      <section className="certificateView">
        <div className="verifyHead">
          {data?.valid ? <CheckCircle2 size={34} /> : <Award size={34} />}
          <h1>{data?.valid ? "Certificate Verified" : "Certificate Not Found"}</h1>
        </div>
        {data?.valid ? (
          <>
            <ProfessionalCertificate certificate={data.certificate} qr={qr} />
            <div className="resultFacts">
              <span>Score {data.certificate.score}/{data.certificate.total_marks}</span>
              <span>{data.certificate.percentage}%</span>
              <span>{data.certificate.grade}</span>
              <span>{data.certificate.passed ? "Passed" : "Failed"}</span>
              {data.certificate.rank_label && <span>{data.certificate.rank_label}</span>}
            </div>
            <div className="verifyDetails">
              <p><b>Subject</b>{data.certificate.subject || "-"}</p>
              <p><b>Class</b>{data.certificate.className || "-"}</p>
              <p><b>Issued</b>{data.certificate.issued_at ? formatDateTime(data.certificate.issued_at) : "-"}</p>
              <p><b>Test marks</b>{data.certificate.test?.totalMarks ?? data.certificate.total_marks ?? "-"}</p>
              <p><b>Passing marks</b>{data.certificate.test?.passingMarks ?? "-"}</p>
              <p><b>Duration</b>{data.certificate.test?.durationMinutes ? `${data.certificate.test.durationMinutes} minutes` : "-"}</p>
              <p><b>Submitted</b>{data.certificate.attempt?.submitted_at ? formatDateTime(data.certificate.attempt.submitted_at) : "-"}</p>
              <p><b>Time taken</b>{data.certificate.attempt?.time_taken != null ? formatTime(Number(data.certificate.attempt.time_taken)) : "-"}</p>
              <p><b>Correct</b>{data.certificate.result?.correct ?? "-"}</p>
              <p><b>Wrong</b>{data.certificate.result?.wrong ?? "-"}</p>
              <p><b>Unattempted</b>{data.certificate.result?.unattempted ?? "-"}</p>
              <p><b>Accuracy</b>{data.certificate.result?.accuracy != null ? `${data.certificate.result.accuracy}%` : "-"}</p>
              {Object.entries(data.certificate.student_details || {}).map(([key, value]: any) => <p key={key}><b>{key}</b>{String(value || "-")}</p>)}
            </div>
            <AnswerReviewTable rows={data.certificate.answer_review || []} />
          </>
        ) : <p>{data?.error || "Checking certificate..."}</p>}
      </section>
    </main>
  );
}

function StudentManager({ token, data, onRefresh, notify }: any) {
  const [created, setCreated] = useState<any>(null);
  const create = async () => {
    const r = await api("/teacher/temporary-identities", { method: "POST", token, body: { fields: { batch: "Default" } } });
    setCreated(r);
    notify("Temporary identity generated.");
    onRefresh();
  };
  return (
    <>
      <Section title="Temporary Login" action={<button className="primaryBtn" onClick={create}><Plus size={17} /> Generate</button>}>
        {created && <div className="notice">User ID: <b>{created.identity.display_id}</b> Temporary password: <b>{created.tempPassword}</b> Claim code: <b>{created.claimCode}</b></div>}
        <DataTable rows={data.temporaryIdentities || []} columns={["display_id", "kind", "status", "expires_at"]} />
      </Section>
      <Section title="Connected Students"><DataTable rows={data.students || []} columns={["name", "email", "display_id", "kind", "attempts", "status"]} /></Section>
    </>
  );
}

function ResultsPanel({ data, tests, loadResults, releaseResults, actionId = "", token }: any) {
  const [activeResult, setActiveResult] = useState<any>(null);
  useEffect(() => setActiveResult(null), [data?.test?.id]);
  const releasing = data?.test?.id && actionId === `release-${data.test.id}`;
  return (
    <>
      <Section title="Choose Test">{tests.map((t: any) => <button className="secondaryBtn" key={t.id} onClick={() => loadResults(t.id)}>{t.title}</button>)}</Section>
      {data && <Section title={`Results: ${data.test.title}`} action={<div className="rowActions"><button className="successBtn" disabled={releasing} onClick={() => releaseResults(data.test.id)}>{releasing ? "Releasing..." : "Release Result"}</button><button className="secondaryBtn" onClick={() => downloadFile(`/teacher/exports/results/${data.test.id}.csv`, `testsetu-results-${data.test.id}.csv`, token)}>CSV</button></div>}>
        <StatsGrid stats={[["Highest", data.summary.highest, "green", <Medal />], ["Average", data.summary.average, "blue", <ClipboardList />], ["Pass %", `${data.summary.passPercentage}%`, "purple", <CheckCircle2 />]]} />
        <DataTable rows={data.results} columns={["studentName", "score", "total_marks", "percentage", "grade", "rank_label", "passed"]} actions={(r: any) => <><button className="secondaryBtn" onClick={() => setActiveResult(r)}>Details</button><a className="secondaryBtn" href={`#result/${r.id}`}>Open</a><button className="secondaryBtn" onClick={() => downloadFile(`/public/results/${r.id}/pdf`, `result-${r.id}.pdf`, token)}>Result PDF</button><button className="secondaryBtn" onClick={() => downloadFile(`/public/results/${r.id}/answer-review.pdf`, `answer-review-${r.id}.pdf`, token)}>Review PDF</button></>} />
      </Section>}
      {activeResult && <Section title={`Detailed Result: ${activeResult.studentName}`} action={<button className="secondaryBtn" onClick={() => setActiveResult(null)}>Close</button>}><ResultCard result={activeResult} token={token} /></Section>}
    </>
  );
}

function ObjectionPanel({ token, objections, onRefresh, notify }: any) {
  const respond = async (id: number, status: string) => {
    await api(`/teacher/objections/${id}/respond`, { method: "POST", token, body: { status, response: status === "ACCEPTED" ? "Accepted and result recalculated." : "Rejected after review." } });
    notify("Objection updated.");
    onRefresh();
  };
  return <Section title="Objections"><DataTable rows={objections} columns={["test_title", "student_name", "type", "message", "status"]} actions={(r: any) => <><button className="successBtn" onClick={() => respond(r.id, "ACCEPTED")}>Accept</button><button className="dangerBtn" onClick={() => respond(r.id, "REJECTED")}>Reject</button></>} /></Section>;
}

function TeacherSettings() {
  return (
    <Section title="Branding & Templates">
      <div className="settingsGrid">
        <div><h3>Branding Controls</h3><p>Teacher name, organization, logo, designation, contact and signature can be enabled globally or per test from builder design settings.</p></div>
        <div><h3>Reusable Templates</h3><p>Instruction, student detail, result and certificate templates are persisted through the API and ready for extension.</p></div>
      </div>
    </Section>
  );
}

function TestCards({ tests, publish, results, releaseResults, publishingId, actionId = "", deleteTest, editTest, reExam }: any) {
  if (!tests?.length) return <Empty title="No tests yet" />;
  return (
    <div className="cardGrid">
      {tests.map((t: any) => {
        const isPublished = t.status === "PUBLISHED";
        const isPublishing = publishingId === t.id;
        const life = testLifecycle(t);
        const busy = (name: string) => actionId === `${name}-${t.id}`;
        return (
          <div className="testCardSmall" key={t.id}>
            <div className="testCardTitle">
              <h3>{t.title}</h3>
              <p>{t.subject || "General"} | {t.totalMarks} marks</p>
            </div>
            <span className={`status ${String(t.status).toLowerCase()}`}>{t.status}</span>
            <div className="testMetaLine">
              <span className={`status ${life.tone}`}>{life.label}</span>
              <span><Timer size={14} /> {life.time}</span>
            </div>
            <div className="shareLine">
              <code title={`${location.origin}/#test/${t.shareSlug}`}>{location.origin}/#test/{t.shareSlug}</code>
              <button className="iconBtn" onClick={() => navigator.clipboard.writeText(`${location.origin}/#test/${t.shareSlug}`)} title="Copy"><Copy size={16} /></button>
            </div>
            <div className="rowActions cardActions">
              {editTest && <button className="secondaryBtn" disabled={busy("edit")} onClick={() => editTest(t.id)}><Pencil size={16} /> {busy("edit") ? "Opening..." : "Edit"}</button>}
              <button className="secondaryBtn" onClick={() => { location.hash = `#test/${t.shareSlug}`; }}>Preview</button>
              <button className="successBtn" disabled={isPublished || isPublishing} onClick={() => publish(t.id)}>{isPublishing ? "Publishing..." : isPublished ? "Published" : "Publish"}</button>
              <button className="secondaryBtn" disabled={busy("results")} onClick={() => results(t.id)}>{busy("results") ? "Loading..." : "Results"}</button>
              {releaseResults && <button className="successBtn" disabled={busy("release")} onClick={() => releaseResults(t.id)}>{busy("release") ? "Releasing..." : "Release Result"}</button>}
              {reExam && <button className="secondaryBtn" disabled={busy("reexam")} onClick={() => reExam(t.id)}><RotateCcw size={16} /> {busy("reexam") ? "Creating..." : "Re-exam"}</button>}
              {deleteTest && <button className="dangerBtn" disabled={busy("delete")} onClick={() => deleteTest(t.id)}>{busy("delete") ? "Deleting..." : "Delete"}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ResultCard({ result, compact = false, token }: any) {
  const detailsAvailable = result.detailsAvailable !== false;
  return (
    <section className={compact ? "resultCard compact" : "resultCard"}>
      <div><Medal size={28} /><h2>{detailsAvailable ? (result.testTitle || result.title || "Result") : "Score Card"}</h2></div>
      <p>{result.studentName}</p>
      <div className="scoreRing">{result.percentage}%</div>
      <div className="resultFacts">
        <span>{result.score}/{result.total_marks}</span>
        <span>{result.percentage}%</span>
        <span>{result.passed ? "Passed" : "Failed"}</span>
        {detailsAvailable && <span>{result.grade}</span>}
        {detailsAvailable && <span>{result.rank_label || "Rank pending"}</span>}
        {detailsAvailable && <span>Correct {result.correct}</span>}
        {detailsAvailable && <span>Wrong {result.wrong}</span>}
      </div>
      {!detailsAvailable && <div className="lockedNotice"><Lock size={17} /> Detailed result, rank, answer review and certificate will unlock after the test ends{result.lockedUntil ? ` (${formatDateTime(result.lockedUntil)})` : ""}.</div>}
      {detailsAvailable && !compact && <AnswerReview result={result} />}
      {result.id && <div className="rowActions centeredActions">
        <a className="secondaryBtn" href={`#result/${result.id}`}>{detailsAvailable ? "View Result" : "View Score"}</a>
        {detailsAvailable && <a className="secondaryBtn" href={`#certificate/${result.id}`}>View Certificate</a>}
        <button className="secondaryBtn" onClick={() => downloadFile(`/public/results/${result.id}/pdf`, `${detailsAvailable ? "result" : "score"}-${result.id}.pdf`, token)}><FileDown size={16} /> {detailsAvailable ? "Result PDF" : "Score PDF"}</button>
        {detailsAvailable && <button className="secondaryBtn" onClick={() => downloadFile(`/public/certificates/${result.id}/pdf`, `certificate-${result.id}.pdf`, token)}><Award size={16} /> Certificate PDF</button>}
      </div>}
    </section>
  );
}

function AnswerReview({ result }: any) {
  const breakdown = typeof result.breakdown_json === "string" ? safeJson(result.breakdown_json, {}) : result.breakdown_json;
  const questions = breakdown?.questions || [];
  if (!questions.length) return null;
  return (
    <div className="answerReview">
      <h3>Answer Review</h3>
      {questions.map((item: any, index: number) => (
        <article key={`${item.questionId}-${index}`} className="reviewItem">
          <div className="qTop"><span>Question {index + 1}</span><b>{item.awarded}/{item.marks}</b></div>
          <p>{item.questionText || `Question ID ${item.questionId}`}</p>
          <div className="reviewGrid">
            <span><b>Your answer</b>{formatAnswer(item.value)}</span>
            <span><b>Correct answer</b>{formatAnswer(item.correctAnswer)}</span>
            <span><b>Status</b>{item.status}</span>
          </div>
          {item.explanation && <small>{item.explanation}</small>}
        </article>
      ))}
    </div>
  );
}

function AnswerReviewTable({ rows }: any) {
  if (!rows?.length) return <Empty title="Answer details are not available yet" />;
  return (
    <div className="answerReview verifyAnswerReview">
      <h3>Question-wise Scorecard</h3>
      {rows.map((item: any) => (
        <article key={`${item.questionId}-${item.number}`} className="reviewItem">
          <div className="qTop"><span>Question {item.number}</span><b>{item.awarded}/{item.marks}</b></div>
          <p>{item.questionText}</p>
          <div className="reviewGrid">
            <span><b>Student answer</b>{formatAnswer(item.studentAnswer)}</span>
            <span><b>Correct answer</b>{formatAnswer(item.correctAnswer)}</span>
            <span><b>Status</b>{item.status}</span>
          </div>
          {item.explanation && <small>{item.explanation}</small>}
        </article>
      ))}
    </div>
  );
}

function PreviewCard({ form, totalMarks, questions }: any) {
  return <div className="previewCard"><h2>{form.title || "Untitled Test"}</h2><p>{form.subject} | {totalMarks} marks | {form.settings.durationMinutes} minutes</p><p>{questions.length} questions selected. Result release: {form.settings.resultRelease}. Ranking: {form.settings.rankingEnabled ? "On" : "Off"}.</p></div>;
}

function CertificateDesignEditor({ form, setForm, totalMarks }: any) {
  const template = form.settings.certificate.template || {};
  const setTemplate = (patch: any) => setForm({ ...form, settings: { ...form.settings, certificate: { ...form.settings.certificate, template: { ...template, ...patch } } } });
  const preview = {
    template,
    certificate_id: "TS-PREVIEW",
    student_name: "Abhinav Yadav",
    test_title: form.title || "Sample Test",
    subject: form.subject || "Course",
    className: form.className || "Batch",
    issued_at: new Date().toISOString(),
    teacher_name: template.issuerName || "TestSetu",
    organization_name: template.organization || "Verified Online Assessment",
    score: totalMarks || 95,
    total_marks: totalMarks || 100,
    percentage: totalMarks ? 100 : 95,
    grade: "A+",
    passed: true,
    rank_label: "Rank 1",
    test: { durationMinutes: form.settings.durationMinutes, passingMarks: form.passingMarks, totalMarks: totalMarks || 100 },
    result: { correct: 18, wrong: 1, unattempted: 1, accuracy: 95 },
    student_details: { rollNumber: "TSU-001", className: form.className || "Batch" }
  };
  return (
    <div className="certificateDesignGrid">
      <div className="formGrid">
        <Select label="Certificate style" value={template.style || "DigiCoders"} onChange={(v: string) => setTemplate({ style: v })} options={["DigiCoders", "Marksheet", "Classic"]} />
        <Field label="Certificate headline" value={template.headline || "Certificate of Achievement"} onChange={(v: string) => setTemplate({ headline: v })} />
        <Field label="Issuer / institute name" value={template.issuerName || "TestSetu"} onChange={(v: string) => setTemplate({ issuerName: v })} />
        <Field label="Organization tagline" value={template.organization || "Verified Online Assessment"} onChange={(v: string) => setTemplate({ organization: v })} />
        <Field label="Accent color" type="color" value={template.color || "#c79a2b"} onChange={(v: string) => setTemplate({ color: v })} />
      </div>
      <ProfessionalCertificate certificate={preview} qr="" compact />
    </div>
  );
}

function ProfessionalCertificate({ certificate, qr, compact = false }: any) {
  const template = certificate.template || certificate.test?.settings?.certificate?.template || {};
  const color = template.color || "#c79a2b";
  const styleName = String(template.style || "DigiCoders").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <article className={`proCertificate style-${styleName}${compact ? " compact" : ""}`} style={{ "--cert-accent": color } as any}>
      <div className="certCorner tl" /><div className="certCorner tr" /><div className="certCorner bl" /><div className="certCorner br" />
      <header>
        <b>{template.issuerName || certificate.teacher_name || certificate.organization_name || "TestSetu"}</b>
        <span>{template.organization || certificate.organization_name || "Verified Online Assessment"}</span>
      </header>
      <h2>{template.headline || "Certificate of Achievement"}</h2>
      <p>This certificate is proudly presented to</p>
      <h1>{certificate.student_name || "Student"}</h1>
      <p>for successfully completing</p>
      <h3>{certificate.test_title || certificate.title || "Completed Test"}</h3>
      <div className="certScoreBand">
        <span>Score <b>{certificate.score}/{certificate.total_marks}</b></span>
        <span>Percentage <b>{certificate.percentage}%</b></span>
        <span>Grade <b>{certificate.grade || "-"}</b></span>
        <span>{certificate.rank_label || (certificate.passed ? "Passed" : "Completed")}</span>
      </div>
      <footer>
        <span>Certificate ID<br /><b>{certificate.certificate_id}</b></span>
        {qr ? <img src={qr} alt="Verification QR" /> : <QrCode size={58} />}
        <span>Issued<br /><b>{certificate.issued_at ? formatDateTime(certificate.issued_at) : "-"}</b></span>
      </footer>
    </article>
  );
}

function DashboardFrame({ title, subtitle, icon, children }: any) {
  return <><section className="dashHero"><div className="heroIcon">{icon}</div><div><h1>{title}</h1><p>{subtitle}</p></div></section>{children}</>;
}

function StatsGrid({ stats }: any) {
  return <div className="statsGrid">{stats.map(([label, value, tone, icon]: any) => <MetricCard key={label} label={label} value={value ?? 0} tone={tone} icon={icon} />)}</div>;
}

function MetricCard({ label, value, tone, icon }: any) {
  return <div className={`metric ${tone}`}><div>{icon}</div><span>{label}</span><b>{value}</b></div>;
}

function Section({ title, action, children }: any) {
  return <section className="section"><div className="sectionHead"><h2>{title}</h2>{action}</div>{children}</section>;
}

function DataTable({ rows = [], columns, actions }: any) {
  if (!rows.length) return <Empty title="Nothing to show yet" />;
  return <div className="tableWrap"><table><thead><tr>{columns.map((c: string) => <th key={c}>{c.replace(/_/g, " ")}</th>)}{actions && <th>Actions</th>}</tr></thead><tbody>{rows.map((r: any, i: number) => <tr key={r.id || i}>{columns.map((c: string) => <td key={c}>{String(r[c] ?? "")}</td>)}{actions && <td className="rowActions">{actions(r)}</td>}</tr>)}</tbody></table></div>;
}

function QuestionCard({ q, action }: any) {
  return <article className="questionCard"><div><span className="pill">{q.type}</span><b>{q.marks} marks</b></div><h3>{q.text}</h3>{q.imageUrl && <img src={assetUrl(q.imageUrl)} alt="" />}<p>{q.subject} {q.topic ? `| ${q.topic}` : ""}</p>{action && <div className="rowActions">{action}</div>}</article>;
}

function Field({ label, value, onChange, type = "text" }: any) {
  return <label className="field"><span>{label}</span><input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></label>;
}

function TextArea({ label, value, onChange }: any) {
  return <label className="field"><span>{label}</span><textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></label>;
}

function Select({ label, value, onChange, options }: any) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((op: string) => <option key={op} value={op}>{op}</option>)}</select></label>;
}

function Toggle({ label, value, onChange }: any) {
  return <label className="toggle"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>;
}

function Empty({ title }: any) {
  return <div className="empty"><Sparkles size={22} /><p>{title}</p></div>;
}

function RefreshButton({ onClick }: any) {
  return <button className="secondaryBtn" onClick={onClick}>Refresh</button>;
}

async function api(path: string, opts: any = {}) {
  const response = await fetch(apiUrl(path), {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.trim() || `HTTP ${response.status}` };
    }
  }
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}

async function downloadFile(path: string, fileName: string, token?: string) {
  const authToken = token || localStorage.getItem(tokenKey) || "";
  const response = await fetch(apiUrl(path), {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
  });
  if (!response.ok) {
    const text = await response.text();
    let message = "Download failed";
    try { message = JSON.parse(text).error || message; } catch { /* ignore */ }
    alert(message);
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function apiUrl(path: string) {
  return `${apiBaseUrl}/api${path}`;
}

function assetUrl(url: string) {
  if (!url || url.startsWith("data:") || /^https?:\/\//i.test(url)) return url;
  return apiBaseUrl ? `${apiBaseUrl}${url.startsWith("/") ? url : `/${url}`}` : url;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function testLifecycle(test: any) {
  if (test.status !== "PUBLISHED") return { label: "Draft", tone: "draft", time: "Not live" };
  const now = Date.now();
  const start = test.settings?.availabilityStart ? new Date(test.settings.availabilityStart).getTime() : null;
  const end = test.settings?.availabilityEnd ? new Date(test.settings.availabilityEnd).getTime() : null;
  if (start && start > now) return { label: "Upcoming", tone: "draft", time: `Starts ${formatDateTime(test.settings.availabilityStart)}` };
  if (end && end <= now) return { label: "Complete", tone: "stopped", time: "Closed for new students" };
  if (end) return { label: "Running", tone: "published", time: `${formatTime(Math.max(0, Math.round((end - now) / 1000)))} left to join` };
  return { label: "Running", tone: "published", time: "Open" };
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function safeJson(text: string, fallback: any) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function formatAnswer(value: any) {
  if (value && typeof value === "object" && value.option === "__OTHER__") return `Other: ${value.text || ""}`;
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "Not answered");
}
