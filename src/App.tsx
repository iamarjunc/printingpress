import { useEffect, useMemo, useRef, useState } from "react";
import { GitHubClient } from "./lib/github";
import { ADDED_BY, normalize } from "./lib/records";
import { downloadRecords } from "./lib/export";
import type { GitHubConfig, StoredRecord, PrintingRecord } from "./types";
import { Icon, type IconName } from "./components/Icon";
import { Dialog } from "./components/Dialog";
import {
  ConnectionForm,
  type RepositoryPreferences,
} from "./components/ConnectionForm";
import { RecordForm } from "./components/RecordForm";

type View = "dashboard" | "add" | "records" | "customers" | "settings";
type Connection = RepositoryPreferences & {
  private: boolean;
  canWrite: boolean;
};
const nav: { id: View; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "add", label: "Add record", icon: "plus" },
  { id: "records", label: "All records", icon: "records" },
  { id: "customers", label: "Customers", icon: "users" },
  { id: "settings", label: "Settings", icon: "settings" },
];
const number = (n: number) => new Intl.NumberFormat("en-IN").format(n);
const date = (s: string, full = false) =>
  new Date(s).toLocaleDateString(undefined, {
    day: "numeric",
    month: full ? "long" : "short",
    year: "numeric",
  });
const initials = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toLocaleUpperCase();
const personClass = (s: string) =>
  s === "Chandrakumar"
    ? "person-sage"
    : s === "Sreelekha"
      ? "person-blue"
      : s === "Appu"
        ? "person-amber"
        : "person-purple";
function initialPreferences(): RepositoryPreferences {
  try {
    const p = JSON.parse(
      localStorage.getItem("pressbook.repository") || "null",
    );
    if (
      p &&
      typeof p.owner === "string" &&
      typeof p.repo === "string" &&
      typeof p.branch === "string"
    )
      return p;
  } catch {
    /* storage may be unavailable */
  }
  return { owner: "iamarjunc", repo: "printingpress-data", branch: "main" };
}
function initialView(): View {
  const hash = location.hash.slice(1);
  return nav.some((n) => n.id === hash) ? (hash as View) : "dashboard";
}
function EmptyState({
  connected,
  onConnect,
  onAdd,
  filtered = false,
}: {
  connected: boolean;
  onConnect: () => void;
  onAdd: () => void;
  filtered?: boolean;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={filtered ? "search" : "book"} size={28} />
      </span>
      <h3>
        {filtered
          ? "No matching records"
          : connected
            ? "Ready for your first record"
            : "A home for every printing order"}
      </h3>
      <p>
        {filtered
          ? "Try a different name, number, or date range."
          : connected
            ? "Add a printing order, or import your diary records using the migration script."
            : "Connect your private GitHub repository to see your records and keep every job organised."}
      </p>
      {!filtered && (
        <button
          className="btn btn-primary"
          onClick={connected ? onAdd : onConnect}
        >
          <Icon name={connected ? "plus" : "shield"} size={17} />
          {connected ? "Add your first record" : "Connect your repository"}
        </button>
      )}
    </div>
  );
}
function RecordTable({
  records,
  onOpen,
}: {
  records: StoredRecord[];
  onOpen: (r: StoredRecord) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="records-table">
        <thead>
          <tr>
            <th>Customer / bill type</th>
            <th>Number range</th>
            <th>Production</th>
            <th>Added by</th>
            <th>Created</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((stored) => {
            const r = stored.record;
            return (
              <tr key={stored.path}>
                <td>
                  <button
                    className="customer-link"
                    onClick={() => onOpen(stored)}
                  >
                    <span className="customer-avatar">
                      {initials(r.customer_name)}
                    </span>
                    <span>
                      <strong>{r.customer_name}</strong>
                      <span className="table-sub">{r.bill_type}</span>
                    </span>
                  </button>
                </td>
                <td>
                  <span className="range-text">
                    {number(r.start_no)} <span className="range-dash">–</span>{" "}
                    {number(r.end_no)}
                  </span>
                  {r.is_legacy && (
                    <span className="legacy-mark">Diary record</span>
                  )}
                </td>
                <td>
                  <strong className="cell-books">
                    {number(r.books)} books
                  </strong>
                  <span className="table-sub">
                    {number(r.pages)} pages / book
                  </span>
                </td>
                <td>
                  <span className={`person-pill ${personClass(r.added_by)}`}>
                    <span className="person-dot" />
                    {r.added_by}
                  </span>
                </td>
                <td>
                  <span className="cell-date">{date(r.created_at)}</span>
                  <span className="table-sub">
                    {new Date(r.created_at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </td>
                <td>
                  <button
                    className="icon-btn"
                    aria-label={`View ${r.customer_name} record ${r.id}`}
                    onClick={() => onOpen(stored)}
                  >
                    <Icon name="chevron" size={17} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Photo({ client, path }: { client: GitHubClient; path: string }) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      objectUrl = "";
    client
      .loadPhoto(path)
      .then((blob) => {
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load photo");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, path]);
  return error ? (
    <div className="notice notice-warning">{error}</div>
  ) : url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="detail-photo-link"
    >
      <img className="detail-photo" src={url} alt="Printing order reference" />
      <span>
        Open full photo <Icon name="external" size={13} />
      </span>
    </a>
  ) : (
    <p className="muted">
      <span className="spinner" /> Loading reference photo…
    </p>
  );
}

export default function App() {
  const [view, setView] = useState<View>(initialView),
    [preferences, setPreferences] = useState(initialPreferences),
    [connection, setConnection] = useState<Connection | null>(null),
    [records, setRecords] = useState<StoredRecord[]>([]),
    [issues, setIssues] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [lastSync, setLastSync] = useState<Date | null>(null);
  const [notice, setNotice] = useState<{
      kind: "success" | "warning" | "error";
      message: string;
    } | null>(null),
    [connectOpen, setConnectOpen] = useState(false),
    [detail, setDetail] = useState<StoredRecord | null>(null),
    [editing, setEditing] = useState<StoredRecord | null>(null),
    [deleting, setDeleting] = useState<StoredRecord | null>(null),
    [deleteBusy, setDeleteBusy] = useState(false),
    [deleteError, setDeleteError] = useState(""),
    [formKey, setFormKey] = useState(0),
    [addDirty, setAddDirty] = useState(false),
    [editDirty, setEditDirty] = useState(false);
  const [search, setSearch] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [person, setPerson] = useState(""),
    [sort, setSort] = useState("newest"),
    [page, setPage] = useState(1),
    [customerSearch, setCustomerSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const client = useRef<GitHubClient | null>(null),
    pendingConnection = useRef<GitHubClient | null>(null);
  const generation = useRef(0),
    connectionAttempt = useRef(0),
    refreshSequence = useRef(0);
  const busyRef = useRef(false),
    mutationBusy = useRef(false),
    addDirtyRef = useRef(addDirty),
    viewRef = useRef(view);
  addDirtyRef.current = addDirty;
  viewRef.current = view;
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const hash = () => navigate(initialView());
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("hashchange", hash);
      connectionAttempt.current++;
      generation.current++;
      refreshSequence.current++;
      pendingConnection.current?.disconnect();
      client.current?.disconnect();
    };
  }, []);
  useEffect(() => setPage(1), [search, from, to, person, sort]);
  function cancelConnecting() {
    connectionAttempt.current++;
    pendingConnection.current?.disconnect();
    pendingConnection.current = null;
  }
  function navigate(next: View) {
    if (pendingConnection.current) cancelConnecting();
    // A pristine form should start with today's date, even in a tab left open overnight.
    if (
      next === "add" &&
      viewRef.current !== "add" &&
      !addDirtyRef.current &&
      !mutationBusy.current
    )
      setFormKey((k) => k + 1);
    viewRef.current = next;
    setView(next);
    history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function closeConnection() {
    if (mutationBusy.current) return;
    cancelConnecting();
    setConnectOpen(false);
  }
  async function connect(config: GitHubConfig) {
    if (mutationBusy.current || saving)
      throw new Error(
        "Wait for the current GitHub save to finish before changing connections.",
      );
    const switching =
      !!client.current &&
      !!connection &&
      (normalize(connection.owner) !== normalize(config.owner) ||
        normalize(connection.repo) !== normalize(config.repo) ||
        connection.branch !== config.branch);
    if (
      switching &&
      (addDirty || editDirty) &&
      !window.confirm(
        "Change repository and clear your unsaved entry? Your current connection will be kept if the new connection fails.",
      )
    )
      throw new Error(
        "Connection unchanged. Your unsaved entry has been kept.",
      );
    cancelConnecting();
    const next = new GitHubClient(config),
      attempt = ++connectionAttempt.current;
    pendingConnection.current = next;
    try {
      const access = await next.verifyAccess();
      if (attempt !== connectionAttempt.current) return;
      const loaded = await next.loadRecords();
      if (attempt !== connectionAttempt.current) return;
      if (mutationBusy.current)
        throw new Error(
          "A save is in progress. Finish it before changing connections.",
        );
      generation.current++;
      refreshSequence.current++;
      busyRef.current = false;
      setBusy(false);
      client.current?.disconnect();
      client.current = next;
      pendingConnection.current = null;
      const prefs = {
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
      };
      setPreferences(prefs);
      try {
        localStorage.setItem("pressbook.repository", JSON.stringify(prefs));
      } catch {
        /* preferences are optional */
      }
      setConnection({ ...prefs, ...access });
      setRecords(loaded.records);
      setIssues(loaded.issues);
      setLastSync(new Date());
      if (switching) {
        setDetail(null);
        setEditing(null);
        setDeleting(null);
        setDeleteError("");
        setDeleteBusy(false);
        setFormKey((k) => k + 1);
        setAddDirty(false);
        setEditDirty(false);
        setSearch("");
        setFrom("");
        setTo("");
        setPerson("");
        setCustomerSearch("");
        setPage(1);
      }
      setConnectOpen(false);
      setNotice({
        kind: access.private ? "success" : "warning",
        message: access.private
          ? "Connected to your private repository. Records are up to date."
          : "This repository is public. Every record and photo can be read by anyone.",
      });
    } catch (error) {
      next.disconnect();
      if (attempt === connectionAttempt.current) throw error;
      // A canceled dialog has no consumer for an error and must never create a session.
    } finally {
      if (pendingConnection.current === next) pendingConnection.current = null;
      if (client.current !== next) next.disconnect();
    }
  }
  function invalidateRefresh() {
    refreshSequence.current++;
    busyRef.current = false;
    setBusy(false);
  }
  async function syncRecords(force = false, confirmedMessage?: string) {
    const current = client.current;
    if (!current || (!force && (busyRef.current || mutationBusy.current)))
      return;
    const id = generation.current,
      sequence = ++refreshSequence.current;
    busyRef.current = true;
    setBusy(true);
    const isLatest = () =>
      id === generation.current &&
      sequence === refreshSequence.current &&
      client.current === current;
    try {
      const loaded = await current.loadRecords(true);
      if (isLatest()) {
        setRecords(loaded.records);
        setIssues(loaded.issues);
        setLastSync(new Date());
      }
    } catch (error) {
      if (isLatest())
        setNotice({
          kind: confirmedMessage ? "warning" : "error",
          message: `${confirmedMessage ? `${confirmedMessage} The latest list could not be refreshed.` : "Could not refresh."} ${error instanceof Error ? error.message : "Please try again."} Existing records remain visible.`,
        });
    } finally {
      if (isLatest()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    await syncRecords();
  }
  function disconnect() {
    if (mutationBusy.current || saving) {
      setNotice({
        kind: "warning",
        message:
          "Wait for GitHub to confirm the current change before disconnecting.",
      });
      return;
    }
    if (
      (addDirty || editDirty) &&
      !window.confirm(
        "Disconnect and clear this session, including your unsaved form?",
      )
    )
      return;
    cancelConnecting();
    generation.current++;
    invalidateRefresh();
    client.current?.disconnect();
    client.current = null;
    setConnection(null);
    setRecords([]);
    setIssues([]);
    setLastSync(null);
    setConnectOpen(false);
    setDetail(null);
    setEditing(null);
    setDeleting(null);
    setDeleteBusy(false);
    setDeleteError("");
    setFormKey((k) => k + 1);
    setAddDirty(false);
    setEditDirty(false);
    setNotice({
      kind: "success",
      message:
        "Disconnected. Your token and loaded records have been cleared from this tab.",
    });
  }
  async function save(record: PrintingRecord, photoChange?: Blob | null) {
    const current = client.current,
      target = editing;
    if (!current) throw new Error("Connect to GitHub before saving.");
    if (mutationBusy.current)
      throw new Error(
        "Another change is being saved. Wait for GitHub confirmation before trying again.",
      );
    if (!navigator.onLine)
      throw new Error(
        "You are offline. Your entry is still here; reconnect before saving.",
      );
    const id = generation.current;
    mutationBusy.current = true;
    setSaving(true);
    invalidateRefresh();
    try {
      const result = target
        ? await current.update(target, record, photoChange)
        : await current.create(record, photoChange ?? undefined);
      if (id !== generation.current)
        throw new Error(
          "The session ended. Reconnect and refresh to check whether GitHub committed this record.",
        );
      setRecords((previous) =>
        [result, ...previous.filter((r) => r.path !== result.path)].sort(
          (a, b) =>
            Date.parse(b.record.created_at) - Date.parse(a.record.created_at),
        ),
      );
      setEditing(null);
      setEditDirty(false);
      // Editing an existing order must not discard an unrelated prepared new order.
      if (!target) {
        setFormKey((k) => k + 1);
        setAddDirty(false);
      }
      navigate("records");
      const confirmedMessage = `${target ? "Changes saved" : "Record saved"} to GitHub.`;
      setNotice({
        kind: current.warnings.length ? "warning" : "success",
        message: `${confirmedMessage} ${current.warnings.join(" ")}`,
      });
      await syncRecords(true, confirmedMessage);
    } finally {
      mutationBusy.current = false;
      if (id === generation.current) setSaving(false);
    }
  }
  async function remove() {
    const current = client.current,
      target = deleting;
    if (!target || !current || mutationBusy.current) return;
    const id = generation.current;
    mutationBusy.current = true;
    setDeleteBusy(true);
    setDeleteError("");
    invalidateRefresh();
    try {
      const result = await current.delete(target);
      if (id !== generation.current) return;
      setRecords((previous) => previous.filter((r) => r.path !== target.path));
      setDetail(null);
      setDeleting(null);
      const confirmedMessage = "Record deleted from GitHub.";
      setNotice({
        kind: result.warnings.length ? "warning" : "success",
        message: `${confirmedMessage} ${result.warnings.join(" ")}`,
      });
      await syncRecords(true, confirmedMessage);
    } catch (error) {
      if (id === generation.current)
        setDeleteError(
          error instanceof Error
            ? error.message
            : "Deletion failed. Please refresh and try again.",
        );
    } finally {
      mutationBusy.current = false;
      if (id === generation.current) setDeleteBusy(false);
    }
  }
  async function reloadLatest(): Promise<StoredRecord> {
    const current = client.current,
      target = editing;
    if (!current || !target)
      throw new Error(
        "Reconnect and open the record again before reviewing changes.",
      );
    if (mutationBusy.current)
      throw new Error("Wait for the current save to finish.");
    const id = generation.current,
      sequence = ++refreshSequence.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const loaded = await current.loadRecords(true);
      if (id !== generation.current || sequence !== refreshSequence.current)
        throw new Error(
          "The session changed. Reconnect and review the record again.",
        );
      setRecords(loaded.records);
      setIssues(loaded.issues);
      setLastSync(new Date());
      const latest = loaded.records.find(
        (stored) => stored.path === target.path,
      );
      if (!latest)
        throw new Error(
          loaded.issues.some((issue) => issue.startsWith(target.path))
            ? "This file could not be loaded. Review it in GitHub; your entered values have been kept."
            : "This record was deleted from GitHub. Your entered values have been kept; review them before creating a new record.",
        );
      setEditing(latest);
      return latest;
    } finally {
      if (id === generation.current && sequence === refreshSequence.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function closeEdit() {
    if (mutationBusy.current || saving) return;
    if (editDirty && !window.confirm("Discard your unsaved changes?")) return;
    setEditing(null);
    setEditDirty(false);
  }
  const sorted = useMemo(
    () =>
      [...records].sort(
        (a, b) =>
          Date.parse(b.record.created_at) - Date.parse(a.record.created_at),
      ),
    [records],
  );
  const customers = useMemo(() => {
    const map = new Map<
      string,
      { name: string; records: StoredRecord[]; books: number }
    >();
    for (const r of sorted) {
      const key = normalize(r.record.customer_name),
        old = map.get(key);
      if (old) {
        old.records.push(r);
        old.books += r.record.books;
      } else
        map.set(key, {
          name: r.record.customer_name,
          records: [r],
          books: r.record.books,
        });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sorted]);
  const filtered = useMemo(() => {
    const needle = normalize(search.trim());
    return records
      .filter(({ record: r }) => {
        const serial = Number(needle.replaceAll(",", ""));
        const text = [
          r.customer_name,
          r.bill_type,
          String(r.start_no),
          String(r.end_no),
        ].some((s) => normalize(s).includes(needle));
        return (
          (!needle ||
            text ||
            (/^\d[\d,]*$/.test(needle) &&
              serial >= r.start_no &&
              serial <= r.end_no)) &&
          (!from || r.date_key >= from) &&
          (!to || r.date_key <= to) &&
          (!person || r.added_by === person)
        );
      })
      .sort((a, b) =>
        sort === "customer"
          ? a.record.customer_name.localeCompare(b.record.customer_name)
          : sort === "oldest"
            ? Date.parse(a.record.created_at) - Date.parse(b.record.created_at)
            : Date.parse(b.record.created_at) - Date.parse(a.record.created_at),
      );
  }, [records, search, from, to, person, sort]);
  const month = new Date(),
    thisMonth = records.filter(({ record: r }) => {
      const d = new Date(r.created_at);
      return (
        d.getFullYear() === month.getFullYear() &&
        d.getMonth() === month.getMonth()
      );
    }).length;
  const connected = !!connection,
    activeLabel = nav.find((n) => n.id === view)!.label;
  const onConnect = () => {
      if (!mutationBusy.current && !saving) setConnectOpen(true);
    },
    onAdd = () => navigate("add");
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("dashboard")}
          aria-label="Pressbook dashboard"
        >
          <span className="brand-mark">
            <Icon name="book" size={25} />
            <i />
          </span>
          <span className="brand-name">
            pressbook<span>PRINTING PRESS RECORDS</span>
          </span>
        </button>
        <span className="nav-label">WORKSPACE</span>
        <nav className="desktop-nav" aria-label="Main navigation">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              {item.id === "records" && connected && (
                <span className="nav-count">{records.length}</span>
              )}
              {item.id === "add" && addDirty && <i className="draft-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-card">
            <span className="storage-icon">
              <Icon name="shield" size={18} />
            </span>
            <strong>
              {connected
                ? connection.private
                  ? "Your private workspace"
                  : "Your workspace"
                : "Your records. Your repository."}
            </strong>
            <p>
              {connected
                ? `${connection.owner}/${connection.repo}`
                : "Stored in GitHub. Owned by you. Simple by design."}
            </p>
            <button
              onClick={() => (connected ? navigate("settings") : onConnect())}
            >
              {connected ? "Manage connection" : "Set up your workspace"}
              <Icon name="arrow" size={15} />
            </button>
          </div>
          <div className="sidebar-foot">
            <span className="tiny-logo">
              <Icon name="book" size={14} />
            </span>{" "}
            A little more organised.
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <Icon name="chevron" size={13} />
            <strong>{activeLabel}</strong>
          </div>
          <div className="topbar-right">
            <span
              className={`sync-badge ${connected && online ? "is-connected" : ""}`}
            >
              <span className="status-dot" />
              {!online
                ? "Offline"
                : connected
                  ? "GitHub connected"
                  : "Not connected"}
            </span>
            <button
              className="account-avatar"
              onClick={() => navigate("settings")}
              aria-label="Open workspace settings"
            >
              PP
            </button>
          </div>
        </header>
        <main id="main" className="main-content" tabIndex={-1}>
          {!online && (
            <div role="status" className="notice notice-warning">
              <Icon name="wifi" size={18} />
              <span>
                You’re offline. You can view loaded records and prepare an
                entry. Saving needs an internet connection.
              </span>
            </div>
          )}
          {notice && (
            <div role="status" className={`notice notice-${notice.kind}`}>
              <Icon
                name={notice.kind === "success" ? "check" : "alert"}
                size={18}
              />
              <span>{notice.message}</span>
              <button
                className="icon-btn"
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {issues.length > 0 && (
            <details className="notice notice-warning data-issues">
              <summary>
                {issues.length} data issue{issues.length === 1 ? "" : "s"} need
                review. Some files could not be loaded.
              </summary>
              <ul>
                {issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
              <p>
                These files have been preserved in GitHub. Correct them there
                and refresh.
              </p>
            </details>
          )}
          {view === "dashboard" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">THE EVERYDAY, ORGANISED</div>
                  <h1>
                    Your press, at a glance
                    <span className="accent-period">.</span>
                  </h1>
                  <p>
                    A clear picture of your work, from the first page to the
                    last book.
                  </p>
                </div>
                <button className="btn btn-primary" onClick={onAdd}>
                  <Icon name="plus" size={18} />
                  Add record
                </button>
              </div>
              <div className="date-line">
                <Icon name="calendar" size={15} />
                {new Date().toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
                <span className="date-separator" />
                Your daily workspace
              </div>
              {!connected && (
                <div className="connect-banner">
                  <span className="banner-icon">
                    <Icon name="shield" size={24} />
                  </span>
                  <div>
                    <strong>A private space for your printing records</strong>
                    <p>
                      Connect your GitHub data repository to get started. No
                      subscriptions, just your records.
                    </p>
                  </div>
                  <button className="btn btn-secondary" onClick={onConnect}>
                    Connect GitHub
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
              )}
              <div className="stats-grid">
                {[
                  {
                    label: "Total records",
                    value: records.length,
                    icon: "records",
                    note: "Every order, accounted for",
                  },
                  {
                    label: "Total customers",
                    value: customers.length,
                    icon: "users",
                    note: "Familiar names, easy to find",
                  },
                  {
                    label: "Total books",
                    value: records.reduce((n, r) => n + r.record.books, 0),
                    icon: "book",
                    note: "Across all printing orders",
                  },
                  {
                    label: "Added this month",
                    value: thisMonth,
                    icon: "calendar",
                    note: month.toLocaleDateString(undefined, {
                      month: "long",
                      year: "numeric",
                    }),
                  },
                ].map((s, i) => (
                  <div className="stat-card" key={s.label}>
                    <div className="stat-top">
                      <span>{s.label}</span>
                      <span className={`stat-icon stat-icon-${i}`}>
                        <Icon name={s.icon as IconName} size={19} />
                      </span>
                    </div>
                    <div className="stat-value">
                      {connected ? number(s.value) : "—"}
                    </div>
                    <div className="stat-note">
                      {i === 3 && <span className="mini-dot" />}
                      {s.note}
                    </div>
                  </div>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel recent-panel">
                  <div className="panel-head">
                    <div>
                      <h2>
                        Recent orders{" "}
                        <span className="count-pill">
                          {connected ? records.length : 0}
                        </span>
                      </h2>
                      <p>The latest entries in your pressbook.</p>
                    </div>
                    <button
                      className="text-btn"
                      onClick={() => navigate("records")}
                    >
                      View all
                      <Icon name="arrow" size={15} />
                    </button>
                  </div>
                  {sorted.length ? (
                    <RecordTable
                      records={sorted.slice(0, 6)}
                      onOpen={setDetail}
                    />
                  ) : (
                    <EmptyState
                      connected={connected}
                      onConnect={onConnect}
                      onAdd={onAdd}
                    />
                  )}
                  <div className="panel-foot">
                    <span className="status-dot" />{" "}
                    {lastSync
                      ? `Last checked at ${lastSync.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                      : "Connect once to start your session"}
                    <button
                      className="text-btn"
                      disabled={
                        !connected || busy || !online || saving || deleteBusy
                      }
                      onClick={refresh}
                    >
                      <Icon
                        name="refresh"
                        size={13}
                        className={busy ? "spinning" : ""}
                      />
                      Refresh
                    </button>
                  </div>
                </section>
                <aside className="dashboard-side">
                  <section className="quick-card">
                    <span className="eyebrow">BEFORE THE NEXT PRINT</span>
                    <span className="quick-card-icon">
                      <Icon name="search" size={24} />
                    </span>
                    <h2>Know where you left off.</h2>
                    <p>
                      Look up a customer’s previous orders and number ranges
                      before starting a new job.
                    </p>
                    <button
                      className="btn btn-secondary"
                      onClick={() => navigate("customers")}
                    >
                      Find a customer
                      <Icon name="arrow" size={16} />
                    </button>
                  </section>
                  <div className="quiet-note">
                    <Icon name="shield" size={18} />
                    <p>
                      <strong>Good records. Peace of mind.</strong>Every
                      confirmed save is a GitHub commit, with a history of your
                      changes.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}
          <div hidden={view !== "add"}>
            <div className="page-heading">
              <div>
                <div className="eyebrow">A NEW CHAPTER</div>
                <h1>
                  Add a printing record<span className="accent-period">.</span>
                </h1>
                <p>Keep the details today. Find them easily tomorrow.</p>
              </div>
              <span className="subtle-label">
                <Icon name="clock" size={15} />
                Times shown in your device’s timezone
              </span>
            </div>
            <RecordForm
              key={formKey}
              records={records}
              connected={connected}
              onConnect={onConnect}
              onSave={save}
              onCancel={() => navigate("dashboard")}
              onDirtyChange={setAddDirty}
              onSavingChange={setSaving}
            />
          </div>
          {view === "records" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR COMPLETE PRESSBOOK</div>
                  <h1>
                    All records<span className="accent-period">.</span>
                  </h1>
                  <p>
                    Find an order, check a number, pick up where you left off.
                  </p>
                </div>
                <div className="button-group">
                  <button
                    className="btn btn-secondary"
                    disabled={!records.length}
                    onClick={() =>
                      downloadRecords(
                        records.map((r) => r.record),
                        "csv",
                      )
                    }
                  >
                    <Icon name="download" size={17} />
                    Export CSV
                  </button>
                  <button className="btn btn-primary" onClick={onAdd}>
                    <Icon name="plus" size={17} />
                    Add record
                  </button>
                </div>
              </div>
              <section className="panel">
                <div className="filters">
                  <label className="search-input">
                    <Icon name="search" size={19} />
                    <input
                      aria-label="Search records"
                      placeholder="Search customer, bill type, or serial number…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        className="icon-btn"
                        aria-label="Clear search"
                        onClick={() => setSearch("")}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    )}
                  </label>
                  <div className="filter-row">
                    <label className="filter-field">
                      From
                      <input
                        type="date"
                        className="input"
                        value={from}
                        max={to || undefined}
                        onChange={(e) => setFrom(e.target.value)}
                      />
                    </label>
                    <label className="filter-field">
                      To
                      <input
                        type="date"
                        className="input"
                        value={to}
                        min={from || undefined}
                        onChange={(e) => setTo(e.target.value)}
                      />
                    </label>
                    <label className="filter-field">
                      Added by
                      <select
                        className="input"
                        value={person}
                        onChange={(e) => setPerson(e.target.value)}
                      >
                        <option value="">Everyone</option>
                        {[
                          ...new Set([
                            ...ADDED_BY,
                            ...records.map((r) => r.record.added_by),
                          ]),
                        ].map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </label>
                    <label className="filter-field">
                      Sort by
                      <select
                        className="input"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="customer">Customer A–Z</option>
                      </select>
                    </label>
                    <button
                      className="icon-btn refresh-filter"
                      onClick={refresh}
                      disabled={
                        !connected || busy || !online || saving || deleteBusy
                      }
                      aria-label="Refresh records"
                    >
                      <Icon name="refresh" className={busy ? "spinning" : ""} />
                    </button>
                  </div>
                </div>
                <div className="results-heading">
                  <span>
                    <strong>{filtered.length}</strong>{" "}
                    {filtered.length === 1 ? "record" : "records"}
                    {filtered.length !== records.length
                      ? ` of ${records.length}`
                      : ""}
                  </span>
                  {(search || from || to || person) && (
                    <button
                      className="text-btn"
                      onClick={() => {
                        setSearch("");
                        setFrom("");
                        setTo("");
                        setPerson("");
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
                {filtered.length ? (
                  <RecordTable
                    records={filtered.slice((page - 1) * 25, page * 25)}
                    onOpen={setDetail}
                  />
                ) : (
                  <EmptyState
                    connected={connected}
                    onConnect={onConnect}
                    onAdd={onAdd}
                    filtered={connected && records.length > 0}
                  />
                )}
                <div className="pagination">
                  <span>
                    {filtered.length
                      ? `${(page - 1) * 25 + 1}–${Math.min(page * 25, filtered.length)} of ${filtered.length}`
                      : "No records to show"}
                  </span>
                  <div className="button-group">
                    <button
                      className="btn btn-secondary btn-small"
                      disabled={page === 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Previous
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      disabled={page * 25 >= filtered.length}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
          {view === "customers" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    FAMILIAR NAMES. COMPLETE HISTORIES.
                  </div>
                  <h1>
                    Your customers<span className="accent-period">.</span>
                  </h1>
                  <p>Every previous order and printing range, all together.</p>
                </div>
                <span className="count-badge">
                  {customers.length}{" "}
                  {customers.length === 1 ? "customer" : "customers"}
                </span>
              </div>
              <label className="search-input standalone-search">
                <Icon name="search" size={19} />
                <input
                  aria-label="Search customers"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Find a customer by name…"
                />
              </label>
              {customers.length ? (
                <div className="customer-grid">
                  {customers
                    .filter((c) =>
                      normalize(c.name).includes(normalize(customerSearch)),
                    )
                    .map((c) => (
                      <article
                        className="panel customer-card"
                        key={normalize(c.name)}
                      >
                        <div className="customer-card-head">
                          <span className="customer-avatar large">
                            {initials(c.name)}
                          </span>
                          <span className="pill">
                            {c.records.length}{" "}
                            {c.records.length === 1 ? "order" : "orders"}
                          </span>
                        </div>
                        <h2>{c.name}</h2>
                        <p className="muted">
                          {number(c.books)} books across all orders
                        </p>
                        <div className="last-order">
                          <span className="eyebrow">LAST PRINTED RANGE</span>
                          <strong>
                            {number(c.records[0].record.start_no)}{" "}
                            <span>–</span> {number(c.records[0].record.end_no)}
                          </strong>
                          <span>
                            {c.records[0].record.bill_type} ·{" "}
                            {date(c.records[0].record.created_at)}
                          </span>
                        </div>
                        <button
                          className="text-btn"
                          onClick={() => {
                            setSearch(c.name);
                            setFrom("");
                            setTo("");
                            setPerson("");
                            navigate("records");
                          }}
                        >
                          View all orders
                          <Icon name="arrow" size={16} />
                        </button>
                      </article>
                    ))}
                </div>
              ) : (
                <section className="panel">
                  <EmptyState
                    connected={connected}
                    onConnect={onConnect}
                    onAdd={onAdd}
                  />
                </section>
              )}
              {customers.length > 0 &&
                !customers.some((c) =>
                  normalize(c.name).includes(normalize(customerSearch)),
                ) && <p className="notice">No customers match this name.</p>}
            </>
          )}
          {view === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SIMPLE, SAFE, AND YOURS</div>
                  <h1>
                    Workspace settings<span className="accent-period">.</span>
                  </h1>
                  <p>Manage your connection and keep a copy of your records.</p>
                </div>
              </div>
              <div className="settings-grid">
                <section className="panel settings-panel">
                  <div className="panel-head">
                    <div>
                      <h2>
                        <Icon name="shield" size={20} />
                        GitHub connection
                      </h2>
                      <p>
                        Your permanent storage, with no database subscription.
                      </p>
                    </div>
                  </div>
                  <div className="settings-body">
                    {connection ? (
                      <>
                        <div className="connection-status">
                          <span className="status-dot" />
                          <strong>Connected this session</strong>
                          <span className="pill">
                            {connection.private
                              ? "Private repository"
                              : "Public repository"}
                          </span>
                        </div>
                        <dl className="settings-dl">
                          <div>
                            <dt>Repository</dt>
                            <dd>
                              {connection.owner}/{connection.repo}
                            </dd>
                          </div>
                          <div>
                            <dt>Branch</dt>
                            <dd>{connection.branch}</dd>
                          </div>
                          <div>
                            <dt>Token storage</dt>
                            <dd>In memory only</dd>
                          </div>
                          <div>
                            <dt>Records loaded</dt>
                            <dd>{records.length}</dd>
                          </div>
                        </dl>
                        {!connection.private && (
                          <div className="notice notice-warning">
                            Your records and photos are publicly readable. Use a
                            separate private repository for confidential data.
                          </div>
                        )}
                        <div className="button-group">
                          <button
                            className="btn btn-secondary"
                            onClick={onConnect}
                            disabled={saving || deleteBusy}
                          >
                            Change connection
                          </button>
                          <button
                            className="btn btn-danger-outline"
                            onClick={disconnect}
                            disabled={saving || deleteBusy}
                          >
                            <Icon name="logout" size={16} />
                            Disconnect
                          </button>
                        </div>
                      </>
                    ) : (
                      <ConnectionForm
                        preferences={preferences}
                        onConnect={connect}
                      />
                    )}
                  </div>
                </section>
                <div>
                  <section className="panel settings-panel">
                    <div className="panel-head">
                      <div>
                        <h2>
                          <Icon name="download" size={20} />
                          Export & backup
                        </h2>
                        <p>Download a copy from your current session.</p>
                      </div>
                    </div>
                    <div className="settings-body">
                      <p className="muted">
                        JSON keeps every record field and can be restored with
                        the import script. CSV opens in a spreadsheet. Photos
                        are separate files; clone your private repository for a
                        full backup.
                      </p>
                      <div className="button-group">
                        <button
                          className="btn btn-secondary"
                          disabled={!records.length}
                          onClick={() =>
                            downloadRecords(
                              records.map((r) => r.record),
                              "json",
                            )
                          }
                        >
                          <Icon name="file" size={16} />
                          Export JSON
                        </button>
                        <button
                          className="btn btn-secondary"
                          disabled={!records.length}
                          onClick={() =>
                            downloadRecords(
                              records.map((r) => r.record),
                              "csv",
                            )
                          }
                        >
                          <Icon name="download" size={16} />
                          Export CSV
                        </button>
                      </div>
                      <p className="field-hint">
                        Exported files contain business data. Keep them on a
                        trusted device.
                      </p>
                    </div>
                  </section>
                  <section className="privacy-note">
                    <Icon name="shield" size={21} />
                    <div>
                      <h3>A note on shared devices</h3>
                      <p>
                        A GitHub token grants access to your data. Use a trusted
                        device, choose a short expiry, and disconnect when
                        finished. A browser password cannot protect a public
                        data repository.
                      </p>
                      <p>
                        Only the repository name is remembered on this device.
                        Tokens and records are never saved to browser storage.
                      </p>
                    </div>
                  </section>
                </div>
              </div>
            </>
          )}
          <footer className="main-footer">
            <span>
              pressbook <span className="footer-dot">·</span> Thoughtful
              recordkeeping.
            </span>
            <span>
              <Icon name="shield" size={13} /> Your data lives in your GitHub
              repository.
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.id)}
            className={`${view === item.id ? "active" : ""} ${item.id === "add" ? "mobile-add" : ""}`}
            aria-current={view === item.id ? "page" : undefined}
          >
            <span>
              <Icon name={item.icon} size={21} />
            </span>
            {item.id === "dashboard"
              ? "Home"
              : item.id === "records"
                ? "Records"
                : item.id === "add"
                  ? "Add record"
                  : item.label}
          </button>
        ))}
      </nav>
      {connectOpen && (
        <Dialog
          title="Connect your workspace"
          description="A private repository. A simpler way to keep records."
          onClose={closeConnection}
        >
          <ConnectionForm preferences={preferences} onConnect={connect} />
        </Dialog>
      )}
      {detail && (
        <Dialog
          title={detail.record.customer_name}
          description={detail.record.bill_type}
          onClose={() => setDetail(null)}
        >
          <div className="detail-top">
            <span
              className={`person-pill ${personClass(detail.record.added_by)}`}
            >
              {detail.record.added_by}
            </span>
            {detail.record.is_legacy && (
              <span className="pill">Imported diary record</span>
            )}
          </div>
          <div className="detail-range">
            <span className="eyebrow">PRINTED NUMBER RANGE</span>
            <strong>
              {number(detail.record.start_no)} <span>–</span>{" "}
              {number(detail.record.end_no)}
            </strong>
          </div>
          <div className="detail-stats">
            <div>
              <strong>{number(detail.record.books)}</strong>
              <span>Books</span>
            </div>
            <div>
              <strong>{number(detail.record.pages)}</strong>
              <span>Pages per book</span>
            </div>
          </div>
          <dl className="settings-dl">
            <div>
              <dt>Created</dt>
              <dd>
                {date(detail.record.created_at, true)}
                <br />
                {new Date(detail.record.created_at).toLocaleTimeString()}
              </dd>
            </div>
            {detail.record.updated_at && (
              <div>
                <dt>Last edited</dt>
                <dd>{new Date(detail.record.updated_at).toLocaleString()}</dd>
              </div>
            )}
            <div>
              <dt>Record ID</dt>
              <dd className="mono">{detail.record.id}</dd>
            </div>
          </dl>
          {detail.record.photo_path && client.current && (
            <Photo client={client.current} path={detail.record.photo_path} />
          )}
          <div className="detail-actions">
            <button
              className="btn btn-secondary"
              onClick={() => {
                setSearch(detail.record.customer_name);
                setFrom("");
                setTo("");
                setPerson("");
                setDetail(null);
                navigate("records");
              }}
            >
              Customer history
            </button>
            <button
              className="btn btn-secondary"
              disabled={saving || deleteBusy}
              onClick={() => {
                if (!mutationBusy.current) {
                  setEditing(detail);
                  setDetail(null);
                }
              }}
            >
              <Icon name="edit" size={16} />
              Edit
            </button>
            <button
              className="btn btn-danger-outline"
              onClick={() => {
                if (!mutationBusy.current) {
                  setDeleting(detail);
                  setDeleteError("");
                }
              }}
              disabled={!online || saving || deleteBusy}
            >
              <Icon name="trash" size={16} />
              Delete
            </button>
          </div>
        </Dialog>
      )}
      {editing && (
        <Dialog
          title="Edit printing record"
          description="The original creation timestamp is preserved."
          wide
          onClose={closeEdit}
        >
          <RecordForm
            records={records}
            initial={editing}
            connected={connected}
            onConnect={onConnect}
            onSave={save}
            onCancel={closeEdit}
            onDirtyChange={setEditDirty}
            onSavingChange={setSaving}
            onReloadLatest={reloadLatest}
          />
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title="Delete this record?"
          description="Please check the details before continuing."
          onClose={() => {
            if (!mutationBusy.current && !deleteBusy) setDeleting(null);
          }}
        >
          <div className="delete-summary">
            <strong>{deleting.record.customer_name}</strong>
            <span>{deleting.record.bill_type}</span>
            <span>
              {number(deleting.record.start_no)} –{" "}
              {number(deleting.record.end_no)} · {deleting.record.books} books
            </span>
          </div>
          <p className="muted">
            The JSON record will be deleted from GitHub. Unshared reference
            photos will also be removed where possible. Previous versions remain
            in Git history.
          </p>
          {deleteError && (
            <div role="alert" className="notice notice-error">
              {deleteError}
            </div>
          )}
          <div className="button-group dialog-actions">
            <button
              className="btn btn-secondary"
              disabled={deleteBusy}
              onClick={() => setDeleting(null)}
            >
              Keep record
            </button>
            <button
              className="btn btn-danger"
              disabled={deleteBusy || !online}
              onClick={remove}
            >
              {deleteBusy ? (
                <span className="spinner" />
              ) : (
                <Icon name="trash" size={16} />
              )}{" "}
              {deleteBusy ? "Deleting…" : "Delete record"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
