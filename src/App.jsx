import { useState, useEffect, useMemo, Fragment } from "react";
import {
  ClipboardList,
  UserCircle2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Plus,
  X,
  FileText,
  Filter,
  Loader2,
  ChevronDown,
  Search,
  Package,
  Download,
  Pause,
  Play,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Brand tokens — pulled from the BTS logo (orange sweep / gunmetal)   */
/* ------------------------------------------------------------------ */
const BRAND = {
  orange: "#F26522",
  orangeDark: "#D9531A",
  gunmetal: "#58595B",
  ink: "#231F20",
  paper: "#FAFAF9",
  card: "#FFFFFF",
  line: "#E7E5E3",
  ok: "#2E8B57",
  warn: "#D9A017",
  danger: "#C0392B",
  info: "#3B6FA0",
};

const PRIORITIES = ["Urgent", "High", "Medium", "Low"];
const STATUSES = ["Open", "In Progress", "Paused", "Completed"];
const PAUSE_REASONS = [
  "Waiting for parts",
  "Waiting for customer",
  "Waiting for site access",
  "Waiting for approval",
  "Weather",
  "Other",
];

const PRIORITY_COLOR = {
  Urgent: BRAND.danger,
  High: BRAND.orange,
  Medium: BRAND.warn,
  Low: BRAND.info,
};

const STATUS_COLOR = {
  Open: BRAND.gunmetal,
  "In Progress": BRAND.info,
  Paused: BRAND.warn,
  Completed: BRAND.ok,
};

const STORAGE_KEY = "bts-work-orders-v1";
const DAY_MINUTES = 480; // standard working day (8 hours)
const SHIFT_PRESETS = [
  { label: "6:00 am shift", start: "06:00", end: "14:00" },
  { label: "7:00 am shift", start: "07:00", end: "15:00" },
];
// time that is not linked to a work order
const NON_WO_ACTIVITIES = [
  "Cleaning",
  "General manufacturing",
  "Manuals & procedures",
  "Meeting",
  "Leave",
  "Other",
];
const REPORTS_KEY = "bts-daily-report-history-v1";
const HOURS_KEY = "bts-time-entries-v1";
const SHIFTS_KEY = "bts-shifts-v1";
const WORKERS_KEY = "bts-worker-list-v1";

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let t = String(v);
  // stop spreadsheet apps from running text that starts like a formula
  if (/^[=+\-@]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function downloadCSV(filename, headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExportBtn({ onClick, label = "Export CSV" }) {
  return (
    <button className="wo-btn ghost" onClick={onClick} title="Download as a CSV file (opens in Excel)">
      <Download size={13} /> {label}
    </button>
  );
}

function fmtClock(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + " " + (h >= 12 ? "pm" : "am");
}

function fmtMin(n) {
  const m = Math.round(n || 0);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return m + " min (" + h + "h" + (r ? " " + r + "m" : "") + ")";
}

// A work order can have several assigned workers (assignees: []).
function getAssignees(o) {
  if (Array.isArray(o.assignees)) return o.assignees;
  return o.assignee && o.assignee !== "Unassigned" ? [o.assignee] : [];
}
function assigneeText(o) {
  const a = getAssignees(o);
  return a.length ? a.join(", ") : "Unassigned";
}
function workerNamesOf(o) {
  const a = getAssignees(o);
  return a.length ? a : ["Unassigned"];
}
function normalizeOrder(o) {
  const { assignee, ...rest } = o;
  return {
    ...rest,
    status: o.status === "On Hold" ? "Paused" : o.status,
    pauses: Array.isArray(o.pauses) ? o.pauses : [],
    assignees: getAssignees(o),
  };
}

// ---- pause tracking ----
// While paused, an order does not count as overdue or long-pending.
function isOverdueOrder(o) {
  return o.status !== "Completed" && o.status !== "Paused" && o.dueDate < todayISO();
}
function activePause(o) {
  const list = o.pauses || [];
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].to) return list[i];
  return null;
}
function pauseDays(p) {
  return daysBetween(p.from, p.to || todayISO());
}
function totalPausedDays(o) {
  return (o.pauses || []).reduce((sum, p) => sum + pauseDays(p), 0);
}
// keeps the pause history in step with status changes
function trackPause(prev, next, reason, note) {
  const pauses = ((prev && prev.pauses) || []).map((p) => ({ ...p }));
  const wasPaused = !!prev && prev.status === "Paused";
  const isPaused = next.status === "Paused";
  if (!wasPaused && isPaused) {
    pauses.push({ from: todayISO(), to: null, reason: reason || "Not specified", note: note || "" });
  }
  if (wasPaused && !isPaused) {
    const last = pauses[pauses.length - 1];
    if (last && !last.to) last.to = todayISO();
  }
  let statusBeforePause = null;
  if (isPaused) statusBeforePause = wasPaused ? prev.statusBeforePause || null : (prev && prev.status) || null;
  return { ...next, pauses, statusBeforePause };
}
// Time is recorded in minutes. Old entries stored in hours are converted.
function normalizeEntry(t) {
  if (typeof t.minutes === "number") return t;
  const { hours, ...rest } = t;
  return { ...rest, minutes: Math.round((hours || 0) * 60) };
}

function monthKey(isoDate) {
  return isoDate.slice(0, 7); // YYYY-MM
}

const BTS_LOGO_DATA_URI =
  "data:image/png;base64,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";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(isoStart, isoEnd) {
  const start = new Date(isoStart + "T00:00:00");
  const end = new Date(isoEnd + "T00:00:00");
  return Math.round((end - start) / 86400000);
}

function seedOrders() {
  // Start with a clean, empty system (no sample work orders).
  return [];
}

/* ------------------------------------------------------------------ */

export default function WorkOrderDashboard() {
  const [orders, setOrders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [statusFilter, setStatusFilter] = useState("Open+Progress");
  const [assigneeFilter, setAssigneeFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [reportHistory, setReportHistory] = useState([]);
  const [timeEntries, setTimeEntries] = useState([]);
  const [workerList, setWorkerList] = useState([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [expandedTimeId, setExpandedTimeId] = useState(null);
  const [pauseTargetId, setPauseTargetId] = useState(null);
  const [shifts, setShifts] = useState([]);

  // ---- load ----
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, true);
        if (res && res.value) {
          setOrders(JSON.parse(res.value).map(normalizeOrder));
        } else {
          const seed = seedOrders();
          setOrders(seed);
          await window.storage.set(STORAGE_KEY, JSON.stringify(seed), true);
        }
      } catch (e) {
        const seed = seedOrders();
        setOrders(seed);
        try {
          await window.storage.set(STORAGE_KEY, JSON.stringify(seed), true);
        } catch (e2) {
          /* ignore */
        }
      } finally {
        setLoading(false);
      }
      try {
        const res = await window.storage.get(REPORTS_KEY, true);
        if (res && res.value) setReportHistory(JSON.parse(res.value));
      } catch (e) {
        /* no history saved yet */
      }
      try {
        const res = await window.storage.get(HOURS_KEY, true);
        if (res && res.value) setTimeEntries(JSON.parse(res.value).map(normalizeEntry));
      } catch (e) {
        /* no hours logged yet */
      }
      try {
        const res = await window.storage.get(WORKERS_KEY, true);
        if (res && res.value) setWorkerList(JSON.parse(res.value));
      } catch (e) {
        /* no custom worker list yet */
      }
      try {
        const res = await window.storage.get(SHIFTS_KEY, true);
        if (res && res.value) setShifts(JSON.parse(res.value));
      } catch (e) {
        /* no shifts recorded yet */
      }
    })();
  }, []);

  async function persist(next) {
    setOrders(next);
    try {
      const res = await window.storage.set(STORAGE_KEY, JSON.stringify(next), true);
      setSaveError(!res);
    } catch (e) {
      setSaveError(true);
    }
  }

  function upsertOrder(order) {
    if (!orders) return;
    const exists = orders.some((o) => o.id === order.id);
    const prior = orders.find((o) => o.id === order.id);
    const withClosedDate =
      order.status === "Completed"
        ? { ...order, closedDate: (prior && prior.closedDate) || order.closedDate || todayISO() }
        : { ...order, closedDate: null };
    const tracked = trackPause(prior, withClosedDate);
    const next = exists
      ? orders.map((o) => (o.id === order.id ? tracked : o))
      : [tracked, ...orders];
    persist(next);
    setShowForm(false);
    setEditingId(null);
  }

  function pauseOrder(id, reason, note) {
    if (!orders) return;
    persist(
      orders.map((o) =>
        o.id === id ? trackPause(o, { ...o, status: "Paused", closedDate: null }, reason, note) : o
      )
    );
    setPauseTargetId(null);
  }

  function resumeOrder(id) {
    const o = orders && orders.find((x) => x.id === id);
    if (!o) return;
    const back =
      o.statusBeforePause && o.statusBeforePause !== "Paused" && o.statusBeforePause !== "Completed"
        ? o.statusBeforePause
        : "Open";
    setStatus(id, back);
  }

  function setStatus(id, status) {
    if (!orders) return;
    const next = orders.map((o) => {
      if (o.id !== id) return o;
      const base =
        status === "Completed"
          ? { ...o, status, closedDate: o.closedDate || todayISO() }
          : { ...o, status, closedDate: null };
      return trackPause(o, base);
    });
    persist(next);
  }

  async function persistHours(next) {
    setTimeEntries(next);
    try {
      const res = await window.storage.set(HOURS_KEY, JSON.stringify(next), true);
      setSaveError(!res);
    } catch (e) {
      setSaveError(true);
    }
  }

  async function persistShifts(next) {
    setShifts(next);
    try {
      const res = await window.storage.set(SHIFTS_KEY, JSON.stringify(next), true);
      setSaveError(!res);
    } catch (e) {
      setSaveError(true);
    }
  }

  // Save one worker's whole timesheet for one day (replaces that day's entries).
  function saveTimesheet(date, worker, rows, shift) {
    const kept = timeEntries.filter((t) => !(t.date === date && t.worker === worker));
    const added = rows.map((r, i) => ({
      id: "TE-" + Date.now() + "-" + i + "-" + Math.floor(Math.random() * 100000),
      date,
      worker,
      woId: r.woId || null,
      activity: r.activity || null,
      minutes: r.minutes,
      note: r.note || "",
    }));
    persistHours([...added, ...kept]);
    if (shift && shift.start && shift.end) {
      const keptShifts = shifts.filter((x) => !(x.date === date && x.worker === worker));
      persistShifts([{ date, worker, start: shift.start, end: shift.end }, ...keptShifts]);
    }
  }

  function deleteTimeEntry(id) {
    persistHours(timeEntries.filter((t) => t.id !== id));
  }

  const minutesByWO = useMemo(() => {
    const map = {};
    timeEntries.forEach((t) => {
      map[t.woId] = (map[t.woId] || 0) + t.minutes;
    });
    return map;
  }, [timeEntries]);

  const allWorkerNames = useMemo(() => {
    const set = new Set(workerList);
    (orders || []).forEach((o) => {
      getAssignees(o).forEach((a) => set.add(a));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [workerList, orders]);

  async function saveWorkerList(next) {
    setWorkerList(next);
    try {
      await window.storage.set(WORKERS_KEY, JSON.stringify(next), true);
    } catch (e) {
      setSaveError(true);
    }
  }

  function addWorker(name) {
    const n = name.trim();
    if (!n) return "Enter a name.";
    if (allWorkerNames.some((w) => w.toLowerCase() === n.toLowerCase()))
      return "That worker already exists.";
    saveWorkerList([...allWorkerNames, n]);
    return "";
  }

  function renameWorker(oldName, newName) {
    const n = newName.trim();
    if (!n) return "Name can't be empty.";
    if (n === oldName) return "";
    if (allWorkerNames.some((w) => w !== oldName && w.toLowerCase() === n.toLowerCase()))
      return "That name is already used.";
    saveWorkerList(allWorkerNames.map((w) => (w === oldName ? n : w)));
    persist(
      orders.map((o) =>
        getAssignees(o).includes(oldName)
          ? { ...o, assignees: getAssignees(o).map((a) => (a === oldName ? n : a)) }
          : o
      )
    );
    persistHours(timeEntries.map((t) => (t.worker === oldName ? { ...t, worker: n } : t)));
    persistShifts(shifts.map((x) => (x.worker === oldName ? { ...x, worker: n } : x)));
    const nextHist = reportHistory.map((r) => ({
      ...r,
      workers: (r.workers || []).map((w) => (w.name === oldName ? { ...w, name: n } : w)),
    }));
    setReportHistory(nextHist);
    window.storage.set(REPORTS_KEY, JSON.stringify(nextHist), true).catch(() => {});
    if (assigneeFilter === oldName) setAssigneeFilter(n);
    return "";
  }

  function removeWorker(name) {
    saveWorkerList(allWorkerNames.filter((w) => w !== name));
    persist(
      orders.map((o) =>
        getAssignees(o).includes(name)
          ? { ...o, assignees: getAssignees(o).filter((a) => a !== name) }
          : o
      )
    );
    if (assigneeFilter === name) setAssigneeFilter("All");
  }

  function removeOrder(id) {
    if (!orders) return;
    persist(orders.filter((o) => o.id !== id));
    // also remove hours that were logged against this work order
    persistHours(timeEntries.filter((t) => t.woId !== id));
    setConfirmDeleteId(null);
  }

  function purgeOrphanHours() {
    if (!orders) return;
    const ids = new Set(orders.map((o) => o.id));
    persistHours(timeEntries.filter((t) => !t.woId || ids.has(t.woId)));
  }

  function deleteReportDay(date) {
    const next = reportHistory.filter((r) => r.date !== date);
    setReportHistory(next);
    window.storage.set(REPORTS_KEY, JSON.stringify(next), true).catch(() => {});
  }

  const assignees = useMemo(() => {
    if (!orders) return [];
    const names = new Set();
    orders.forEach((o) => workerNamesOf(o).forEach((n) => names.add(n)));
    return Array.from(names).sort();
  }, [orders]);

  const openOrders = useMemo(
    () => (orders || []).filter((o) => o.status !== "Completed"),
    [orders]
  );

  const overdue = useMemo(
    () =>
      openOrders.filter(isOverdueOrder),
    [openOrders]
  );

  const dueToday = useMemo(
    () => openOrders.filter((o) => o.dueDate === todayISO() && o.status !== "Paused"),
    [openOrders]
  );

  const unassigned = useMemo(
    () => openOrders.filter((o) => getAssignees(o).length === 0),
    [openOrders]
  );

  const openManMinutes = useMemo(
    () => openOrders.reduce((sum, o) => sum + (minutesByWO[o.id] || 0), 0),
    [openOrders, minutesByWO]
  );

  const filtered = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      const statusOk =
        statusFilter === "All"
          ? true
          : statusFilter === "Open+Progress"
          ? o.status === "Open" || o.status === "In Progress"
          : o.status === statusFilter;
      const assigneeOk = assigneeFilter === "All" || workerNamesOf(o).includes(assigneeFilter);
      const searchOk =
        q === "" ||
        [o.id, o.title, o.productCode, o.productName, assigneeText(o)]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(q));
      return statusOk && assigneeOk && searchOk;
    });
  }, [orders, statusFilter, assigneeFilter, search]);

  const createdToday = useMemo(
    () => (orders || []).filter((o) => o.createdDate === todayISO()),
    [orders]
  );

  // Rollover report: orders that already existed before today (i.e. were
  // open coming into today) — carried in from the prior day.
  const carriedIn = useMemo(
    () =>
      (orders || []).filter(
        (o) => o.createdDate < todayISO() && (!o.closedDate || o.closedDate >= todayISO())
      ),
    [orders]
  );
  const closedToday = useMemo(
    () => (orders || []).filter((o) => o.status === "Completed" && o.closedDate === todayISO()),
    [orders]
  );
  const carriedForward = useMemo(
    () => carriedIn.filter((o) => o.status !== "Completed"),
    [carriedIn]
  );
  const completedToday = closedToday;

  const workerCarryOverToday = useMemo(() => {
    const names = Array.from(
      new Set([...carriedIn, ...closedToday].flatMap((o) => workerNamesOf(o)))
    ).sort();
    return names.map((name) => ({
      name,
      inCount: carriedIn.filter((o) => workerNamesOf(o).includes(name)).length,
      closedCount: closedToday.filter((o) => workerNamesOf(o).includes(name)).length,
      forwardCount: carriedForward.filter((o) => workerNamesOf(o).includes(name)).length,
    }));
  }, [carriedIn, closedToday, carriedForward]);

  const longPendingCount = useMemo(
    () => (orders || []).filter((o) => o.status !== "Completed" && o.status !== "Paused" && daysBetween(o.createdDate, todayISO()) >= 3).length,
    [orders]
  );

  // ---- auto-record today's snapshot into the report archive ----
  useEffect(() => {
    if (!orders) return;
    // don't create report records for a completely empty system
    if (orders.length === 0 && reportHistory.length === 0) return;
    const today = todayISO();
    const snapshot = {
      date: today,
      totalOpen: openOrders.length,
      createdToday: createdToday.length,
      carriedIn: carriedIn.length,
      closedToday: closedToday.length,
      carriedForward: carriedForward.length,
      longPending: longPendingCount,
      overdue: overdue.length,
      workers: workerCarryOverToday,
    };
    const prevEntry = reportHistory.find((r) => r.date === today);
    if (prevEntry && JSON.stringify(prevEntry) === JSON.stringify(snapshot)) return;
    const next = [...reportHistory.filter((r) => r.date !== today), snapshot].sort((a, b) =>
      a.date < b.date ? 1 : -1
    );
    setReportHistory(next);
    window.storage.set(REPORTS_KEY, JSON.stringify(next), true).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  return (
    <div className="wo-root">
      <style>{`
        .wo-root {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          background: ${BRAND.paper};
          color: ${BRAND.ink};
          min-height: 100%;
          border: 1px solid ${BRAND.line};
        }
        .wo-header {
          background: ${BRAND.card};
          border-bottom: 1px solid ${BRAND.line};
        }
        .wo-header-inner {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 18px 24px 14px 24px;
        }
        .wo-mark {
          display: block;
          line-height: 0;
        }
        .wo-mark-img {
          display: block;
          height: 52px;
          width: auto;
        }
        .wo-divider {
          width: 1px;
          height: 40px;
          background: ${BRAND.gunmetal};
          opacity: 0.4;
        }
        .wo-wordmark {
          font-weight: 800;
          font-size: 15px;
          letter-spacing: 0.3px;
          color: ${BRAND.ink};
          line-height: 1.25;
          text-transform: uppercase;
        }
        .wo-subtitle {
          margin-left: auto;
          text-align: right;
          font-size: 12px;
          color: ${BRAND.gunmetal};
        }
        .wo-stripe {
          height: 5px;
          background: linear-gradient(90deg, ${BRAND.orange}, ${BRAND.orangeDark});
        }
        .wo-tabs {
          display: flex;
          gap: 4px;
          padding: 0 24px;
          background: ${BRAND.card};
          border-bottom: 1px solid ${BRAND.line};
        }
        .wo-tab {
          border: none;
          background: transparent;
          padding: 12px 16px;
          font-size: 13px;
          font-weight: 700;
          color: ${BRAND.gunmetal};
          cursor: pointer;
          border-bottom: 3px solid transparent;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }
        .wo-tab.active {
          color: ${BRAND.ink};
          border-bottom-color: ${BRAND.orange};
        }
        .wo-body { padding: 22px 24px 32px 24px; }
        .wo-kpis {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 12px;
          margin-bottom: 22px;
        }
        .wo-kpi {
          background: ${BRAND.card};
          border: 1px solid ${BRAND.line};
          border-left: 4px solid var(--accent, ${BRAND.orange});
          border-radius: 6px;
          padding: 14px 16px;
        }
        .wo-kpi-num { font-size: 26px; font-weight: 800; line-height: 1; }
        .wo-kpi-label {
          font-size: 11px;
          color: ${BRAND.gunmetal};
          text-transform: uppercase;
          letter-spacing: 0.4px;
          margin-top: 6px;
          font-weight: 700;
        }
        .wo-panel {
          background: ${BRAND.card};
          border: 1px solid ${BRAND.line};
          border-radius: 8px;
          overflow: hidden;
        }
        .wo-panel-head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          border-bottom: 1px solid ${BRAND.line};
        }
        .wo-panel-title {
          font-weight: 800;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }
        .wo-controls { display: flex; gap: 8px; margin-left: auto; align-items: center; }
        .wo-select {
          font-size: 12px;
          border: 1px solid ${BRAND.line};
          border-radius: 5px;
          padding: 6px 8px;
          background: ${BRAND.paper};
          color: ${BRAND.ink};
        }
        .wo-search {
          display: flex;
          align-items: center;
          gap: 6px;
          border: 1px solid ${BRAND.line};
          border-radius: 5px;
          padding: 6px 9px;
          background: ${BRAND.paper};
          min-width: 190px;
        }
        .wo-search-input {
          border: none;
          background: transparent;
          font-size: 12px;
          outline: none;
          width: 100%;
          color: ${BRAND.ink};
        }
        .wo-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: ${BRAND.orange};
          color: white;
          border: none;
          border-radius: 5px;
          padding: 7px 12px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .wo-btn:hover { background: ${BRAND.orangeDark}; }
        .wo-btn.ghost {
          background: transparent;
          color: ${BRAND.gunmetal};
          border: 1px solid ${BRAND.line};
        }
        .wo-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .wo-table th {
          text-align: left;
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          color: ${BRAND.gunmetal};
          padding: 10px 14px;
          border-bottom: 1px solid ${BRAND.line};
          background: ${BRAND.paper};
        }
        .wo-table td {
          padding: 11px 14px;
          border-bottom: 1px solid ${BRAND.line};
          vertical-align: top;
        }
        .wo-table tr:last-child td { border-bottom: none; }
        .wo-id { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; color: ${BRAND.gunmetal}; }
        .wo-title { font-weight: 600; }
        .wo-pill {
          display: inline-block;
          font-size: 11px;
          font-weight: 700;
          padding: 2px 9px;
          border-radius: 20px;
          color: white;
        }
        .wo-assignee { display: flex; align-items: center; gap: 6px; }
        .wo-overdue-tag {
          color: ${BRAND.danger};
          font-weight: 700;
          font-size: 11px;
        }
        .wo-status-select {
          font-size: 11.5px;
          border: 1px solid ${BRAND.line};
          border-radius: 4px;
          padding: 3px 5px;
          background: white;
        }
        .wo-row-actions { display: flex; gap: 6px; }
        .wo-icon-btn {
          border: none;
          background: transparent;
          color: ${BRAND.gunmetal};
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
        }
        .wo-icon-btn:hover { background: ${BRAND.paper}; }
        .wo-link {
          border: none; background: none; padding: 0; cursor: pointer; text-align: left;
          font-family: inherit; font-size: 12.5px; font-weight: 700;
          color: ${BRAND.orangeDark}; text-decoration: underline dotted;
        }
        .wo-checklist {
          border: 1px solid ${BRAND.line}; border-radius: 5px; padding: 6px 8px;
          max-height: 112px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
        }
        .wo-field .wo-check {
          display: flex; align-items: center; gap: 6px; margin: 0;
          font-size: 13px; font-weight: 500; text-transform: none; letter-spacing: 0; color: ${BRAND.ink};
        }
        .wo-field .wo-check input { width: auto; padding: 0; }
        .wo-mini {
          border: 1px solid ${BRAND.line}; border-radius: 4px; padding: 5px 7px;
          font-size: 12.5px; font-family: inherit; box-sizing: border-box;
        }
        .wo-worker-head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          border: none;
          background: transparent;
          cursor: pointer;
          text-align: left;
          font-family: inherit;
        }
        .wo-worker-head:hover { background: ${BRAND.paper}; }
        .wo-worker-name {
          font-weight: 800;
          font-size: 14px;
          color: ${BRAND.ink};
        }
        .wo-worker-stats {
          display: flex;
          gap: 14px;
          font-size: 12px;
          font-weight: 600;
          flex-wrap: wrap;
        }
        @media (max-width: 700px) {
          .wo-worker-head { flex-wrap: wrap; }
          .wo-worker-stats { width: 100%; margin-left: 28px; }
        }
        .wo-modal-backdrop {
          position: fixed; inset: 0; background: rgba(35,31,32,0.45);
          display: flex; align-items: center; justify-content: center; z-index: 50;
          padding: 16px;
        }
        .wo-modal {
          background: white; border-radius: 10px; width: 100%; max-width: 520px;
          padding: 20px; max-height: 90vh; overflow-y: auto;
        }
        .wo-modal-head { display: flex; align-items: center; margin-bottom: 14px; }
        .wo-modal-title { font-weight: 800; font-size: 15px; text-transform: uppercase; }
        .wo-field { margin-bottom: 12px; }
        .wo-field label {
          display: block; font-size: 11px; font-weight: 700; color: ${BRAND.gunmetal};
          text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px;
        }
        .wo-field input, .wo-field select, .wo-field textarea {
          width: 100%; border: 1px solid ${BRAND.line}; border-radius: 5px;
          padding: 8px 10px; font-size: 13px; font-family: inherit; box-sizing: border-box;
        }
        .wo-field-row { display: flex; gap: 10px; }
        .wo-field-row > div { flex: 1; }
        .wo-empty {
          padding: 30px; text-align: center; color: ${BRAND.gunmetal}; font-size: 13px;
        }
        .wo-report-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;
        }
        @media (max-width: 640px) { .wo-report-grid { grid-template-columns: 1fr; } .wo-field-row { flex-direction: column; } }
        .wo-report-list { list-style: none; margin: 0; padding: 0; }
        .wo-report-list li {
          padding: 8px 0; border-bottom: 1px solid ${BRAND.line}; font-size: 13px;
          display: flex; justify-content: space-between; gap: 10px;
        }
        .wo-report-list li:last-child { border-bottom: none; }
        .wo-save-note { font-size: 11px; color: ${BRAND.warn}; padding: 8px 16px; }
        .wo-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 60px; color: ${BRAND.gunmetal}; }
        .spin { animation: wo-spin 1s linear infinite; }
        @keyframes wo-spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* ---- Header, styled after the BTS banner ---- */}
      <div className="wo-header">
        <div className="wo-header-inner">
          <div className="wo-mark">
            <img src={BTS_LOGO_DATA_URI} alt="BTS logo" className="wo-mark-img" />
          </div>
          <div className="wo-divider" />
          <div className="wo-wordmark">
            Beaver
            <br />
            Technology
            <br />
            Services
          </div>
          <div className="wo-subtitle">
            Work Order Operations
            <br />
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </div>
        </div>
      </div>
      <div className="wo-stripe" />

      <div className="wo-tabs">
        <button
          className={`wo-tab ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={`wo-tab ${tab === "report" ? "active" : ""}`}
          onClick={() => setTab("report")}
        >
          Daily Report
        </button>
        <button
          className={`wo-tab ${tab === "workers" ? "active" : ""}`}
          onClick={() => setTab("workers")}
        >
          Workers
        </button>
        <button
          className={`wo-tab ${tab === "archive" ? "active" : ""}`}
          onClick={() => setTab("archive")}
        >
          Reports Archive
        </button>
        <button
          className={`wo-tab ${tab === "hours" ? "active" : ""}`}
          onClick={() => setTab("hours")}
        >
          Timesheets
        </button>
      </div>

      {loading || !orders ? (
        <div className="wo-loading">
          <Loader2 size={18} className="spin" />
          Loading work orders…
        </div>
      ) : (
        <div className="wo-body">
          {saveError && (
            <div className="wo-save-note">
              Changes are only saved locally in this session — storage didn't confirm the save.
            </div>
          )}

          {tab === "dashboard" ? (
            <>
              {/* KPIs */}
              <div className="wo-kpis">
                <div className="wo-kpi" style={{ "--accent": BRAND.gunmetal }}>
                  <div className="wo-kpi-num">{openOrders.length}</div>
                  <div className="wo-kpi-label">Open work orders</div>
                </div>
                <div className="wo-kpi" style={{ "--accent": BRAND.danger }}>
                  <div className="wo-kpi-num">{overdue.length}</div>
                  <div className="wo-kpi-label">Overdue</div>
                </div>
                <div className="wo-kpi" style={{ "--accent": BRAND.orange }}>
                  <div className="wo-kpi-num">{dueToday.length}</div>
                  <div className="wo-kpi-label">Due today</div>
                </div>
                <div className="wo-kpi" style={{ "--accent": BRAND.warn }}>
                  <div className="wo-kpi-num">{unassigned.length}</div>
                  <div className="wo-kpi-label">Unassigned</div>
                </div>
                <div
                  className="wo-kpi"
                  style={{ "--accent": BRAND.warn, cursor: "pointer" }}
                  title="Show paused work orders"
                  onClick={() => setStatusFilter("Paused")}
                >
                  <div className="wo-kpi-num">{openOrders.filter((o) => o.status === "Paused").length}</div>
                  <div className="wo-kpi-label">Paused</div>
                </div>
                <div className="wo-kpi" style={{ "--accent": BRAND.info }}>
                  <div className="wo-kpi-num" style={{ fontSize: 18, lineHeight: 1.2 }}>
                    {fmtMin(openManMinutes)}
                  </div>
                  <div className="wo-kpi-label">Man-hours on open orders</div>
                </div>
              </div>

              {/* Work order table */}
              <div className="wo-panel">
                <div className="wo-panel-head">
                  <ClipboardList size={16} color={BRAND.orange} />
                  <div className="wo-panel-title">Work Orders</div>
                  <div className="wo-controls">
                    <div className="wo-search">
                      <Search size={13} color={BRAND.gunmetal} />
                      <input
                        className="wo-search-input"
                        placeholder="Search ID, title, product…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <select
                      className="wo-select"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="Open+Progress">Open + In progress</option>
                      <option value="All">All statuses</option>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s} only
                        </option>
                      ))}
                    </select>
                    <select
                      className="wo-select"
                      value={assigneeFilter}
                      onChange={(e) => setAssigneeFilter(e.target.value)}
                    >
                      <option value="All">All assignees</option>
                      {assignees.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                    <ExportBtn
                      onClick={() =>
                        downloadCSV(
                          `work-orders-${todayISO()}.csv`,
                          ["ID", "Title", "Product code", "Product name", "Assignee", "Priority", "Status", "Pause reason", "Paused since", "Days paused (total)", "Opened", "Due", "Closed", "Minutes logged", "Notes"],
                          filtered.map((o) => [
                            o.id, o.title, o.productCode, o.productName, assigneeText(o), o.priority, o.status,
                            o.status === "Paused" && activePause(o) ? activePause(o).reason : "",
                            o.status === "Paused" && activePause(o) ? activePause(o).from : "",
                            totalPausedDays(o) || "",
                            o.createdDate, o.dueDate, o.closedDate || "",
                            minutesByWO[o.id] || "",
                            o.notes,
                          ])
                        )
                      }
                    />
                    <button
                      className="wo-btn"
                      onClick={() => {
                        setEditingId(null);
                        setShowForm(true);
                      }}
                    >
                      <Plus size={14} /> New order
                    </button>
                  </div>
                </div>

                {filtered.length === 0 ? (
                  <div className="wo-empty">No work orders match this filter.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="wo-table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Title</th>
                          <th>Product</th>
                          <th>Assignee</th>
                          <th>Priority</th>
                          <th>Status</th>
                          <th>Opened</th>
                          <th>Man-hours</th>
                          <th>Due</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((o) => {
                          const isOverdue = isOverdueOrder(o);
                          return (
                            <Fragment key={o.id}>
                            <tr>
                              <td className="wo-id">{o.id}</td>
                              <td>
                                <div className="wo-title">{o.title}</div>
                                {o.notes && (
                                  <div style={{ fontSize: 11.5, color: BRAND.gunmetal, marginTop: 3 }}>
                                    {o.notes}
                                  </div>
                                )}
                              </td>
                              <td>
                                {o.productCode || o.productName ? (
                                  <div>
                                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 600 }}>
                                      <Package size={13} color={BRAND.gunmetal} />
                                      {o.productCode || "—"}
                                    </div>
                                    {o.productName && (
                                      <div style={{ fontSize: 11.5, color: BRAND.gunmetal, marginTop: 2 }}>
                                        {o.productName}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span style={{ color: BRAND.gunmetal, fontSize: 12 }}>—</span>
                                )}
                              </td>
                              <td>
                                <div className="wo-assignee">
                                  <UserCircle2 size={15} color={BRAND.gunmetal} />
                                  {assigneeText(o)}
                                </div>
                              </td>
                              <td>
                                <span
                                  className="wo-pill"
                                  style={{ background: PRIORITY_COLOR[o.priority] }}
                                >
                                  {o.priority}
                                </span>
                              </td>
                              <td>
                                <select
                                  className="wo-status-select"
                                  value={o.status}
                                  style={{ color: STATUS_COLOR[o.status] }}
                                  onChange={(e) =>
                                    e.target.value === "Paused"
                                      ? setPauseTargetId(o.id)
                                      : setStatus(o.id, e.target.value)
                                  }
                                >
                                  {STATUSES.map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                                {o.status === "Paused" &&
                                  (() => {
                                    const pz = activePause(o);
                                    return (
                                      <div style={{ fontSize: 11.5, color: BRAND.warn, marginTop: 4 }}>
                                        Paused
                                        {pz ? " since " + pz.from + " · " + pauseDays(pz) + " day(s)" : ""}
                                        {pz && pz.reason ? " — " + pz.reason : ""}
                                        {pz && pz.note ? (
                                          <div style={{ color: BRAND.gunmetal }}>{pz.note}</div>
                                        ) : null}
                                      </div>
                                    );
                                  })()}
                              </td>
                              <td>{o.createdDate}</td>
                              <td>
                                {minutesByWO[o.id] ? (
                                  <button
                                    className="wo-link"
                                    title="Show who logged this time"
                                    onClick={() => setExpandedTimeId(expandedTimeId === o.id ? null : o.id)}
                                  >
                                    {fmtMin(minutesByWO[o.id])}
                                  </button>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td>
                                {o.dueDate}
                                {isOverdue && <div className="wo-overdue-tag">Overdue</div>}
                              </td>
                              <td>
                                <div className="wo-row-actions">
                                  <button
                                    className="wo-icon-btn"
                                    title="Edit"
                                    onClick={() => {
                                      setEditingId(o.id);
                                      setShowForm(true);
                                    }}
                                  >
                                    <FileText size={14} />
                                  </button>
                                  {o.status === "Paused" ? (
                                    <button className="wo-icon-btn" title="Resume" onClick={() => resumeOrder(o.id)}>
                                      <Play size={14} />
                                    </button>
                                  ) : o.status !== "Completed" ? (
                                    <button className="wo-icon-btn" title="Pause" onClick={() => setPauseTargetId(o.id)}>
                                      <Pause size={14} />
                                    </button>
                                  ) : null}
                                  {confirmDeleteId === o.id ? (
                                    <>
                                      <button
                                        className="wo-btn"
                                        style={{ background: BRAND.danger, padding: "3px 8px" }}
                                        onClick={() => removeOrder(o.id)}
                                      >
                                        Delete + its time entries?
                                      </button>
                                      <button
                                        className="wo-icon-btn"
                                        title="Cancel"
                                        onClick={() => setConfirmDeleteId(null)}
                                      >
                                        <X size={14} />
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      className="wo-icon-btn"
                                      title="Delete"
                                      onClick={() => setConfirmDeleteId(o.id)}
                                    >
                                      <X size={14} />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {expandedTimeId === o.id && minutesByWO[o.id] ? (
                              <tr>
                                <td colSpan={10} style={{ background: BRAND.paper }}>
                                  <TimeBreakdown entries={timeEntries.filter((t) => t.woId === o.id)} />
                                </td>
                              </tr>
                            ) : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : tab === "report" ? (
            <DailyReport
              orders={orders}
              createdToday={createdToday}
              completedToday={completedToday}
              carriedIn={carriedIn}
              closedToday={closedToday}
              carriedForward={carriedForward}
              overdue={overdue}
              dueToday={dueToday}
              openOrders={openOrders}
            />
          ) : tab === "workers" ? (
            <>
              <WorkerManager
                workers={allWorkerNames}
                orders={orders}
                onAdd={addWorker}
                onRename={renameWorker}
                onRemove={removeWorker}
              />
              <WorkerView orders={orders} />
            </>
          ) : tab === "hours" ? (
            <HoursView
              orders={orders}
              workerNames={allWorkerNames}
              entries={timeEntries}
              shifts={shifts}
              onPurge={purgeOrphanHours}
              onSaveSheet={saveTimesheet}
              onDelete={deleteTimeEntry}
            />
          ) : (
            <ReportsArchive history={reportHistory} onDelete={deleteReportDay} />
          )}
        </div>
      )}

      {pauseTargetId && orders && orders.find((o) => o.id === pauseTargetId) && (
        <PauseModal
          order={orders.find((o) => o.id === pauseTargetId)}
          onCancel={() => setPauseTargetId(null)}
          onConfirm={(reason, note) => pauseOrder(pauseTargetId, reason, note)}
        />
      )}
      {showForm && (
        <OrderForm
          initial={orders.find((o) => o.id === editingId) || null}
          existingIds={orders.map((o) => o.id)}
          workers={allWorkerNames}
          onCancel={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSave={upsertOrder}
        />
      )}
    </div>
  );
}

function DailyReport({ orders, carriedIn, closedToday, carriedForward, createdToday, overdue, dueToday, openOrders }) {
  const [pendingThreshold, setPendingThreshold] = useState(3);

  const longPending = useMemo(
    () =>
      (orders || [])
        .filter((o) => o.status !== "Completed" && o.status !== "Paused" && daysBetween(o.createdDate, todayISO()) >= pendingThreshold)
        .sort((a, b) => daysBetween(b.createdDate, todayISO()) - daysBetween(a.createdDate, todayISO())),
    [orders, pendingThreshold]
  );

  const workerCarryOver = useMemo(() => {
    const names = Array.from(
      new Set([...carriedIn, ...closedToday].flatMap((o) => workerNamesOf(o)))
    ).sort();
    return names
      .map((name) => {
        const inCount = carriedIn.filter((o) => workerNamesOf(o).includes(name)).length;
        const closedCount = closedToday.filter((o) => workerNamesOf(o).includes(name)).length;
        const forwardCount = carriedForward.filter((o) => workerNamesOf(o).includes(name)).length;
        return { name, inCount, closedCount, forwardCount };
      })
      .sort((a, b) => b.inCount - a.inCount);
  }, [carriedIn, closedToday, carriedForward]);

  const rolloverRows = useMemo(
    () =>
      [...carriedIn].sort((a, b) => (a.status === "Completed" ? 1 : 0) - (b.status === "Completed" ? 1 : 0)),
    [carriedIn]
  );

  return (
    <div>
      <div className="wo-kpis" style={{ marginBottom: 18 }}>
        <div className="wo-kpi" style={{ "--accent": BRAND.gunmetal }}>
          <div className="wo-kpi-num">{carriedIn.length}</div>
          <div className="wo-kpi-label">Carried from yesterday</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.ok }}>
          <div className="wo-kpi-num">{closedToday.length}</div>
          <div className="wo-kpi-label">Closed today</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.warn }}>
          <div className="wo-kpi-num">{carriedForward.length}</div>
          <div className="wo-kpi-label">Carried to tomorrow</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.warn }}>
          <div className="wo-kpi-num">{openOrders.filter((o) => o.status === "Paused").length}</div>
          <div className="wo-kpi-label">Paused (not counted overdue)</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.danger }}>
          <div className="wo-kpi-num">{longPending.length}</div>
          <div className="wo-kpi-label">Long-pending ({pendingThreshold}+ days)</div>
        </div>
      </div>

      {/* Carry-over rollover */}
      <div className="wo-panel" style={{ marginBottom: 16 }}>
        <div className="wo-panel-head">
          <Clock size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Carry-over rollover</div>
          <div className="wo-controls">
            <ExportBtn
              onClick={() =>
                downloadCSV(
                  `carry-over-${todayISO()}.csv`,
                  ["ID", "Title", "Assignee", "Opened", "Days open", "Outcome today"],
                  rolloverRows.map((o) => [
                    o.id, o.title, assigneeText(o), o.createdDate, daysBetween(o.createdDate, todayISO()),
                    o.status === "Completed" && o.closedDate === todayISO() ? "Closed today" : o.status === "Paused" ? "Paused" : "Carried forward",
                  ])
                )
              }
            />
          </div>
        </div>
        {rolloverRows.length === 0 ? (
          <div className="wo-empty">Nothing carried in from yesterday — every open order was created today.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wo-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Assignee</th>
                  <th>Opened</th>
                  <th>Days open</th>
                  <th>Outcome today</th>
                </tr>
              </thead>
              <tbody>
                {rolloverRows.map((o) => {
                  const wasClosedToday = o.status === "Completed" && o.closedDate === todayISO();
                  return (
                    <tr key={o.id}>
                      <td className="wo-id">{o.id}</td>
                      <td className="wo-title">{o.title}</td>
                      <td>{assigneeText(o)}</td>
                      <td>{o.createdDate}</td>
                      <td>{daysBetween(o.createdDate, todayISO())}</td>
                      <td>
                        {wasClosedToday ? (
                          <span style={{ color: BRAND.ok, fontWeight: 700, fontSize: 12 }}>Closed today</span>
                        ) : o.status === "Paused" ? (
                          <span style={{ color: BRAND.warn, fontWeight: 700, fontSize: 12 }}>Paused</span>
                        ) : (
                          <span style={{ color: BRAND.warn, fontWeight: 700, fontSize: 12 }}>Carried forward</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Long-pending snapshot */}
      <div className="wo-panel" style={{ marginBottom: 16 }}>
        <div className="wo-panel-head">
          <AlertTriangle size={16} color={BRAND.danger} />
          <div className="wo-panel-title">Long-pending work orders</div>
          <div className="wo-controls">
            <ExportBtn
              onClick={() =>
                downloadCSV(
                  `long-pending-${todayISO()}.csv`,
                  ["ID", "Title", "Product code", "Product name", "Assignee", "Priority", "Opened", "Days open"],
                  longPending.map((o) => [
                    o.id, o.title, o.productCode, o.productName, assigneeText(o), o.priority,
                    o.createdDate, daysBetween(o.createdDate, todayISO()),
                  ])
                )
              }
            />
            <select
              className="wo-select"
              value={pendingThreshold}
              onChange={(e) => setPendingThreshold(Number(e.target.value))}
            >
              <option value={2}>2+ days open</option>
              <option value={3}>3+ days open</option>
              <option value={5}>5+ days open</option>
              <option value={7}>7+ days open</option>
            </select>
          </div>
        </div>
        {longPending.length === 0 ? (
          <div className="wo-empty">No open work orders have been sitting for {pendingThreshold}+ days.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wo-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Product</th>
                  <th>Assignee</th>
                  <th>Priority</th>
                  <th>Opened</th>
                  <th>Days open</th>
                </tr>
              </thead>
              <tbody>
                {longPending.map((o) => (
                  <tr key={o.id}>
                    <td className="wo-id">{o.id}</td>
                    <td className="wo-title">{o.title}</td>
                    <td>
                      {o.productCode || o.productName ? (
                        <div>
                          <div style={{ fontWeight: 600 }}>{o.productCode || "—"}</div>
                          {o.productName && (
                            <div style={{ fontSize: 11.5, color: BRAND.gunmetal }}>{o.productName}</div>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: BRAND.gunmetal, fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td>{assigneeText(o)}</td>
                    <td>
                      <span className="wo-pill" style={{ background: PRIORITY_COLOR[o.priority] }}>
                        {o.priority}
                      </span>
                    </td>
                    <td>{o.createdDate}</td>
                    <td style={{ fontWeight: 700, color: BRAND.danger }}>
                      {daysBetween(o.createdDate, todayISO())}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-worker carry-over report */}
      <div className="wo-panel">
        <div className="wo-panel-head">
          <UserCircle2 size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Worker carry-over report</div>
          <div className="wo-controls">
            <ExportBtn
              onClick={() =>
                downloadCSV(
                  `worker-carry-over-${todayISO()}.csv`,
                  ["Worker", "Carried from yesterday", "Closed today", "Carried forward"],
                  workerCarryOver.map((w) => [w.name, w.inCount, w.closedCount, w.forwardCount])
                )
              }
            />
          </div>
        </div>
        {workerCarryOver.length === 0 ? (
          <div className="wo-empty">No carried-over work to report on.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wo-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Carried from yesterday</th>
                  <th>Closed today</th>
                  <th>Carried forward</th>
                </tr>
              </thead>
              <tbody>
                {workerCarryOver.map((w) => (
                  <tr key={w.name}>
                    <td>
                      <div className="wo-assignee">
                        <UserCircle2 size={15} color={BRAND.gunmetal} />
                        {w.name}
                      </div>
                    </td>
                    <td style={{ fontWeight: 700 }}>{w.inCount}</td>
                    <td style={{ fontWeight: 700, color: BRAND.ok }}>{w.closedCount}</td>
                    <td style={{ fontWeight: 700, color: BRAND.warn }}>{w.forwardCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerManager({ workers, orders, onAdd, onRename, onRemove }) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [msg, setMsg] = useState("");

  const openCounts = useMemo(() => {
    const m = {};
    orders.forEach((o) => {
      if (o.status !== "Completed") getAssignees(o).forEach((n) => (m[n] = (m[n] || 0) + 1));
    });
    return m;
  }, [orders]);

  function add(e) {
    e.preventDefault();
    const err = onAdd(newName);
    setMsg(err);
    if (!err) setNewName("");
  }

  function saveRename(oldName) {
    const err = onRename(oldName, editValue);
    setMsg(err);
    if (!err) setEditing(null);
  }

  return (
    <div className="wo-panel" style={{ marginBottom: 16 }}>
      <div className="wo-panel-head">
        <UserCircle2 size={16} color={BRAND.orange} />
        <div className="wo-panel-title">Manage workers</div>
      </div>
      <div style={{ padding: 16 }}>
        <form onSubmit={add} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            className="wo-select"
            style={{ flex: 1, padding: "8px 10px" }}
            placeholder="New worker name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="wo-btn">
            <Plus size={14} /> Add worker
          </button>
        </form>
        {msg && <div style={{ color: BRAND.danger, fontSize: 12, marginBottom: 8 }}>{msg}</div>}
        {workers.length === 0 ? (
          <div className="wo-empty">No workers yet. Add one above.</div>
        ) : (
          <ul className="wo-report-list">
            {workers.map((w) => (
              <li key={w} style={{ alignItems: "center" }}>
                {editing === w ? (
                  <span style={{ display: "flex", gap: 6, flex: 1 }}>
                    <input
                      className="wo-select"
                      style={{ flex: 1, padding: "6px 8px" }}
                      value={editValue}
                      autoFocus
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename(w);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <button className="wo-btn" onClick={() => saveRename(w)}>
                      Save
                    </button>
                    <button className="wo-btn ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <span>
                      <strong>{w}</strong>{" "}
                      <span style={{ color: BRAND.gunmetal, fontSize: 12 }}>
                        · {openCounts[w] || 0} open
                      </span>
                    </span>
                    <span style={{ display: "flex", gap: 6 }}>
                      {confirmRemove === w ? (
                        <>
                          <button
                            className="wo-btn"
                            style={{ background: BRAND.danger }}
                            onClick={() => {
                              onRemove(w);
                              setConfirmRemove(null);
                            }}
                          >
                            Confirm remove (taken off their work orders)
                          </button>
                          <button className="wo-btn ghost" onClick={() => setConfirmRemove(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="wo-btn ghost"
                            onClick={() => {
                              setEditing(w);
                              setEditValue(w);
                              setMsg("");
                            }}
                          >
                            Rename
                          </button>
                          <button className="wo-btn ghost" onClick={() => setConfirmRemove(w)}>
                            Remove
                          </button>
                        </>
                      )}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div style={{ fontSize: 11.5, color: BRAND.gunmetal, marginTop: 8 }}>
          Renaming updates the name on all work orders, logged time and past reports.
        </div>
      </div>
    </div>
  );
}

function WorkerView({ orders }) {
  const [expanded, setExpanded] = useState(null);

  const byWorker = useMemo(() => {
    const map = {};
    (orders || []).forEach((o) => {
      workerNamesOf(o).forEach((name) => {
        map[name] = map[name] || [];
        map[name].push(o);
      });
    });
    return Object.entries(map)
      .map(([name, list]) => {
        const open = list.filter((o) => o.status === "Open").length;
        const inProgress = list.filter((o) => o.status === "In Progress").length;
        const paused = list.filter((o) => o.status === "Paused").length;
        const completed = list.filter((o) => o.status === "Completed").length;
        const overdue = list.filter(isOverdueOrder).length;
        const sorted = [...list].sort((a, b) =>
          a.status === "Completed" && b.status !== "Completed"
            ? 1
            : b.status === "Completed" && a.status !== "Completed"
            ? -1
            : a.dueDate < b.dueDate
            ? -1
            : 1
        );
        return { name, list: sorted, open, inProgress, paused, completed, overdue, total: list.length };
      })
      .sort((a, b) => (b.open + b.inProgress + b.paused) - (a.open + a.inProgress + a.paused));
  }, [orders]);

  if (byWorker.length === 0) {
    return (
      <div className="wo-panel">
        <div className="wo-empty">No work orders yet.</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <ExportBtn
          label="Export all workers' orders"
          onClick={() =>
            downloadCSV(
              `orders-by-worker-${todayISO()}.csv`,
              ["Worker", "ID", "Title", "Product code", "Product name", "Priority", "Status", "Opened", "Due", "Closed"],
              byWorker.flatMap((w) =>
                w.list.map((o) => [
                  w.name, o.id, o.title, o.productCode, o.productName, o.priority, o.status,
                  o.createdDate, o.dueDate, o.closedDate || "",
                ])
              )
            )
          }
        />
      </div>
      <div className="wo-kpis" style={{ marginBottom: 18 }}>
        <div className="wo-kpi" style={{ "--accent": BRAND.gunmetal }}>
          <div className="wo-kpi-num">{byWorker.length}</div>
          <div className="wo-kpi-label">Workers with orders</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.orange }}>
          <div className="wo-kpi-num">
            {(orders || []).filter((o) => o.status !== "Completed").length}
          </div>
          <div className="wo-kpi-label">Total active orders</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.danger }}>
          <div className="wo-kpi-num">{(orders || []).filter(isOverdueOrder).length}</div>
          <div className="wo-kpi-label">Overdue across team</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.ok }}>
          <div className="wo-kpi-num">{(orders || []).filter((o) => o.status === "Completed").length}</div>
          <div className="wo-kpi-label">Completed all-time</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {byWorker.map((w) => {
          const isOpen = expanded === w.name;
          return (
            <div className="wo-panel" key={w.name}>
              <button
                className="wo-worker-head"
                onClick={() => setExpanded(isOpen ? null : w.name)}
              >
                <UserCircle2 size={18} color={BRAND.gunmetal} />
                <span className="wo-worker-name">{w.name}</span>
                <span className="wo-worker-stats">
                  <span title="Open" style={{ color: STATUS_COLOR.Open }}>{w.open} open</span>
                  <span title="In progress" style={{ color: STATUS_COLOR["In Progress"] }}>{w.inProgress} in progress</span>
                  <span title="Paused" style={{ color: STATUS_COLOR.Paused }}>{w.paused} paused</span>
                  <span title="Completed" style={{ color: STATUS_COLOR.Completed }}>{w.completed} completed</span>
                  {w.overdue > 0 && (
                    <span style={{ color: BRAND.danger, fontWeight: 700 }}>{w.overdue} overdue</span>
                  )}
                </span>
                <ChevronDown
                  size={16}
                  color={BRAND.gunmetal}
                  style={{
                    marginLeft: "auto",
                    transform: isOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                />
              </button>

              {isOpen && (
                <div style={{ overflowX: "auto" }}>
                  <table className="wo-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Title</th>
                        <th>Product</th>
                        <th>Priority</th>
                        <th>Status</th>
                        <th>Opened</th>
                        <th>Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.list.map((o) => {
                        const isOverdue = isOverdueOrder(o);
                        return (
                          <tr key={o.id}>
                            <td className="wo-id">{o.id}</td>
                            <td className="wo-title">{o.title}</td>
                            <td>
                              {o.productCode || o.productName ? (
                                <div>
                                  <div style={{ fontWeight: 600 }}>{o.productCode || "—"}</div>
                                  {o.productName && (
                                    <div style={{ fontSize: 11.5, color: BRAND.gunmetal }}>
                                      {o.productName}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span style={{ color: BRAND.gunmetal, fontSize: 12 }}>—</span>
                              )}
                            </td>
                            <td>
                              <span className="wo-pill" style={{ background: PRIORITY_COLOR[o.priority] }}>
                                {o.priority}
                              </span>
                            </td>
                            <td>
                              <span style={{ color: STATUS_COLOR[o.status], fontWeight: 700, fontSize: 12 }}>
                                {o.status}
                              </span>
                            </td>
                            <td>{o.createdDate}</td>
                            <td>
                              {o.dueDate}
                              {isOverdue && <div className="wo-overdue-tag">Overdue</div>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PauseModal({ order, onCancel, onConfirm }) {
  const [reason, setReason] = useState(PAUSE_REASONS[0]);
  const [note, setNote] = useState("");
  return (
    <div className="wo-modal-backdrop" onClick={onCancel}>
      <div className="wo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wo-modal-head">
          <div className="wo-modal-title">Pause {order.id}</div>
          <button className="wo-icon-btn" style={{ marginLeft: "auto" }} onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div style={{ fontSize: 13, marginBottom: 12 }}>{order.title}</div>
        <div className="wo-field">
          <label>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {PAUSE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="wo-field">
          <label>Note (optional)</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any details" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="wo-btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="wo-btn" onClick={() => onConfirm(reason, note.trim())}>
            Pause work order
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: BRAND.gunmetal, marginTop: 10 }}>
          While paused, this work order won't count as overdue or long-pending.
        </div>
      </div>
    </div>
  );
}

function TimeBreakdown({ entries }) {
  const byWorker = {};
  const byDay = {};
  entries.forEach((t) => {
    byWorker[t.worker] = (byWorker[t.worker] || 0) + t.minutes;
    byDay[t.date] = byDay[t.date] || [];
    byDay[t.date].push(t);
  });
  const days = Object.keys(byDay).sort().reverse();
  const head = {
    fontWeight: 800,
    marginBottom: 4,
    textTransform: "uppercase",
    fontSize: 11,
    color: BRAND.gunmetal,
  };
  return (
    <div style={{ display: "flex", gap: 36, flexWrap: "wrap", padding: "10px 6px", fontSize: 12.5 }}>
      <div>
        <div style={head}>Time by worker</div>
        {Object.entries(byWorker)
          .sort((a, b) => b[1] - a[1])
          .map(([n, m]) => (
            <div key={n}>
              {n}: <strong>{fmtMin(m)}</strong>
            </div>
          ))}
      </div>
      <div>
        <div style={head}>Time by day</div>
        {days.map((d) => (
          <div key={d}>
            <strong>{d}</strong> — {byDay[d].map((t) => t.worker + " " + t.minutes + " min").join(", ")}
          </div>
        ))}
      </div>
    </div>
  );
}

function HoursView({ orders, workerNames, entries, shifts, onSaveSheet, onDelete, onPurge }) {
  const [date, setDate] = useState(todayISO());
  const [worker, setWorker] = useState("");
  const [sheet, setSheet] = useState({});
  const [filter, setFilter] = useState("");
  const [showPaused, setShowPaused] = useState(false);
  const [shiftStart, setShiftStart] = useState("");
  const [shiftEnd, setShiftEnd] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const orderById = useMemo(() => {
    const m = {};
    orders.forEach((o) => (m[o.id] = o));
    return m;
  }, [orders]);

  const orphanCount = useMemo(() => {
    const ids = new Set(orders.map((o) => o.id));
    return entries.filter((t) => t.woId && !ids.has(t.woId)).length;
  }, [orders, entries]);

  const shiftMap = useMemo(() => {
    const m = {};
    shifts.forEach((x) => (m[x.date + "|" + x.worker] = x));
    return m;
  }, [shifts]);

  // load the saved timesheet whenever the date or worker changes
  useEffect(() => {
    const m = {};
    if (worker) {
      entries
        .filter((t) => t.date === date && t.worker === worker)
        .forEach((t) => {
          m[t.activity ? "act:" + t.activity : t.woId] = { on: true, minutes: String(t.minutes), note: t.note || "" };
        });
    }
    setSheet(m);
    const sh = worker ? shifts.find((x) => x.date === date && x.worker === worker) : null;
    setShiftStart(sh ? sh.start : "");
    setShiftEnd(sh ? sh.end : "");
    setError("");
    setSaved("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, worker]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return orders
      .filter(
        (o) =>
          (o.status !== "Completed" && (showPaused || o.status !== "Paused")) || (sheet[o.id] && sheet[o.id].on)
      )
      .filter(
        (o) =>
          !q ||
          [o.id, o.title, o.productCode, o.productName]
            .filter(Boolean)
            .some((f) => f.toLowerCase().includes(q))
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }, [orders, sheet, filter, showPaused]);

  const tickedEntries = Object.entries(sheet).filter(([, r]) => r.on);
  const mins = (r) => parseInt(r.minutes, 10) || 0;
  const woTotal = tickedEntries.filter(([k]) => !k.startsWith("act:")).reduce((sum, [, r]) => sum + mins(r), 0);
  const actTotal = tickedEntries.filter(([k]) => k.startsWith("act:")).reduce((sum, [, r]) => sum + mins(r), 0);
  const sheetTotal = woTotal + actTotal;

  const toMin = (hhmm) => {
    const [h, m] = (hhmm || "0:0").split(":").map(Number);
    return h * 60 + m;
  };
  const shiftLen = shiftStart && shiftEnd ? (toMin(shiftEnd) - toMin(shiftStart) + 1440) % 1440 : 0;
  const target = shiftLen || DAY_MINUTES;
  const scale = Math.max(target, sheetTotal) || 1;
  const woPct = (woTotal / scale) * 100;
  const actPct = (actTotal / scale) * 100;
  const left = target - sheetTotal;
  const dayStatusColor = left === 0 ? BRAND.ok : left < 0 ? BRAND.danger : BRAND.gunmetal;
  const dayStatusText =
    left === 0 ? "✓ Full shift accounted for" : left < 0 ? -left + " min over the shift" : left + " min left to fill";

  function toggle(id) {
    setSheet((s) => {
      const cur = s[id];
      if (cur && cur.on) return { ...s, [id]: { ...cur, on: false } };
      return { ...s, [id]: { on: true, minutes: (cur && cur.minutes) || "", note: (cur && cur.note) || "" } };
    });
    setSaved("");
  }

  function fillRest(key) {
    const others = Object.entries(sheet)
      .filter(([k, r]) => k !== key && r.on)
      .reduce((sum, [, r]) => sum + (parseInt(r.minutes, 10) || 0), 0);
    setField(key, "minutes", String(Math.max(0, target - others)));
  }

  function setField(id, field, value) {
    setSheet((s) => ({ ...s, [id]: { ...s[id], [field]: value } }));
    setSaved("");
  }

  function save() {
    if (!worker) return setError("Choose a worker first.");
    if (!shiftLen)
      return setError("Choose the shift start and end (6:00 am or 7:00 am shift, or enter your own times).");
    const out = [];
    for (const [key, r] of Object.entries(sheet)) {
      if (!r.on) continue;
      const isAct = key.startsWith("act:");
      const label = isAct ? key.slice(4) : key;
      const m = Number(r.minutes);
      if (!Number.isInteger(m) || m < 1) return setError("Enter whole minutes (1 or more) for " + label + ".");
      const note = (r.note || "").trim();
      out.push(isAct ? { activity: label, minutes: m, note } : { woId: key, minutes: m, note });
    }
    const total = out.reduce((sum, r) => sum + r.minutes, 0);
    if (total > 1440) return setError("A day can't exceed 1440 minutes (24 hours).");
    setError("");
    onSaveSheet(date, worker, out, { start: shiftStart, end: shiftEnd });
    setSaved(
      out.length
        ? "Timesheet saved: " + out.length + " line(s), " + fmtMin(total) + "."
        : "Timesheet cleared for this worker and day."
    );
  }

  const dayEntries = useMemo(() => entries.filter((t) => t.date === date), [entries, date]);
  const dayByWorker = useMemo(() => {
    const m = {};
    dayEntries.forEach((t) => (m[t.worker] = (m[t.worker] || 0) + t.minutes));
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [dayEntries]);
  const dayTotal = dayEntries.reduce((sum, t) => sum + t.minutes, 0);

  const ranged = useMemo(
    () => entries.filter((t) => (!from || t.date >= from) && (!to || t.date <= to)),
    [entries, from, to]
  );
  const byWO = useMemo(() => {
    const m = {};
    ranged.forEach((t) => {
      if (t.activity || !t.woId) return;
      if (!m[t.woId]) m[t.woId] = { woId: t.woId, total: 0, workers: {}, days: new Set() };
      m[t.woId].total += t.minutes;
      m[t.woId].workers[t.worker] = (m[t.woId].workers[t.worker] || 0) + t.minutes;
      m[t.woId].days.add(t.date);
    });
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [ranged]);
  const grandTotal = byWO.reduce((sum, r) => sum + r.total, 0);

  const split = useMemo(() => {
    const m = {};
    ranged.forEach((t) => {
      if (!m[t.worker]) m[t.worker] = { worker: t.worker, wo: 0, acts: {}, total: 0 };
      if (t.activity) m[t.worker].acts[t.activity] = (m[t.worker].acts[t.activity] || 0) + t.minutes;
      else m[t.worker].wo += t.minutes;
      m[t.worker].total += t.minutes;
    });
    return Object.values(m).sort((a, b) => (a.worker < b.worker ? -1 : 1));
  }, [ranged]);

  return (
    <div>
      {orphanCount > 0 && (
        <div
          className="wo-panel"
          style={{ marginBottom: 16, padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
        >
          <AlertTriangle size={16} color={BRAND.warn} />
          <span style={{ fontSize: 13 }}>
            {orphanCount} time {orphanCount === 1 ? "entry belongs" : "entries belong"} to work orders that were
            deleted.
          </span>
          <button className="wo-btn" style={{ marginLeft: "auto" }} onClick={onPurge}>
            Remove these entries
          </button>
        </div>
      )}

      <div className="wo-kpis" style={{ marginBottom: 18 }}>
        <div className="wo-kpi" style={{ "--accent": BRAND.orange }}>
          <div className="wo-kpi-num" style={{ fontSize: 18, lineHeight: 1.2 }}>{fmtMin(dayTotal)}</div>
          <div className="wo-kpi-label">Logged on {date}</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.gunmetal }}>
          <div className="wo-kpi-num">{dayByWorker.length}</div>
          <div className="wo-kpi-label">Workers with a timesheet that day</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.ok }}>
          <div className="wo-kpi-num" style={{ fontSize: 18, lineHeight: 1.2 }}>{fmtMin(grandTotal)}</div>
          <div className="wo-kpi-label">Cumulative (report range)</div>
        </div>
        <div className="wo-kpi" style={{ "--accent": BRAND.info }}>
          <div className="wo-kpi-num">{byWO.length}</div>
          <div className="wo-kpi-label">Work orders with time</div>
        </div>
      </div>

      {/* ---- daily timesheet ---- */}
      <div className="wo-panel" style={{ marginBottom: 16, overflow: "visible" }}>
        <div className="wo-panel-head">
          <Clock size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Daily timesheet</div>
          <div className="wo-controls">
            <input type="date" className="wo-select" value={date} onChange={(e) => setDate(e.target.value)} />
            <select className="wo-select" value={worker} onChange={(e) => setWorker(e.target.value)}>
              <option value="">Select worker…</option>
              {workerNames.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!worker ? (
          <div className="wo-empty">Choose a worker to fill in their timesheet for {date}.</div>
        ) : (
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12.5, color: BRAND.gunmetal, marginBottom: 10 }}>
              Tick the work orders {worker} worked on and enter the minutes for each. Time that isn't linked to a
              work order (cleaning, meetings, leave…) goes in the second table. The bar shows how much of the shift
              is accounted for; not every minute has to be filled in. Saving replaces this worker's timesheet for
              the day.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <span
                style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3, color: BRAND.gunmetal }}
              >
                Shift
              </span>
              {SHIFT_PRESETS.map((pr) => {
                const active = shiftStart === pr.start && shiftEnd === pr.end;
                return (
                  <button
                    key={pr.label}
                    type="button"
                    className={active ? "wo-btn" : "wo-btn ghost"}
                    onClick={() => {
                      setShiftStart(pr.start);
                      setShiftEnd(pr.end);
                      setSaved("");
                    }}
                  >
                    {pr.label}
                  </button>
                );
              })}
              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                Start
                <input
                  type="time"
                  className="wo-mini"
                  value={shiftStart}
                  onChange={(e) => {
                    setShiftStart(e.target.value);
                    setSaved("");
                  }}
                />
              </label>
              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                End
                <input
                  type="time"
                  className="wo-mini"
                  value={shiftEnd}
                  onChange={(e) => {
                    setShiftEnd(e.target.value);
                    setSaved("");
                  }}
                />
              </label>
              <span style={{ fontSize: 12, color: BRAND.gunmetal }}>
                {shiftLen
                  ? fmtClock(shiftStart) + " – " + fmtClock(shiftEnd) + " · " + fmtMin(shiftLen)
                  : "Choose the shift start and end"}
              </span>
            </div>

            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 5,
                background: "#fff",
                padding: "10px 0 12px",
                marginBottom: 12,
                borderBottom: "1px solid " + BRAND.line,
              }}
            >
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 6 }}
              >
                <div style={{ fontWeight: 800, fontSize: 14 }}>
                  {sheetTotal} of {target} min
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: dayStatusColor }}>{dayStatusText}</div>
              </div>
              <div
                style={{ position: "relative", height: 16, background: "#EFEDEB", borderRadius: 8, overflow: "hidden", display: "flex" }}
              >
                <div style={{ width: woPct + "%", background: BRAND.orange, transition: "width 0.2s" }} />
                <div style={{ width: actPct + "%", background: "#9A9B9D", transition: "width 0.2s" }} />
                {sheetTotal > target && (
                  <div
                    style={{ position: "absolute", left: (target / scale) * 100 + "%", top: 0, bottom: 0, width: 2, background: BRAND.ink }}
                  />
                )}
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: BRAND.gunmetal, marginTop: 6 }}>
                <span>
                  <span style={{ display: "inline-block", width: 9, height: 9, background: BRAND.orange, borderRadius: 2, marginRight: 4 }} />
                  Work orders {woTotal} min
                </span>
                <span>
                  <span style={{ display: "inline-block", width: 9, height: 9, background: "#9A9B9D", borderRadius: 2, marginRight: 4 }} />
                  Other activities {actTotal} min
                </span>
                <span>
                  <span style={{ display: "inline-block", width: 9, height: 9, background: "#EFEDEB", border: "1px solid #D8D5D2", borderRadius: 2, marginRight: 4 }} />
                  Left {Math.max(0, left)} min
                </span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
              <div className="wo-search" style={{ maxWidth: 320 }}>
                <Search size={13} color={BRAND.gunmetal} />
                <input
                  className="wo-search-input"
                  placeholder="Filter work orders…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={showPaused} onChange={(e) => setShowPaused(e.target.checked)} />
                Show paused work orders
              </label>
            </div>

            {rows.length === 0 ? (
              <div className="wo-empty">No open work orders to log time against.</div>
            ) : (
              <div style={{ overflowX: "auto", border: "1px solid " + BRAND.line, borderRadius: 6 }}>
                <table className="wo-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Work order</th>
                      <th>Assigned</th>
                      <th>Minutes</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => {
                      const r = sheet[o.id];
                      const on = !!(r && r.on);
                      return (
                        <tr key={o.id} style={on ? { background: "#FFF6F0" } : undefined}>
                          <td>
                            <input type="checkbox" checked={on} onChange={() => toggle(o.id)} />
                          </td>
                          <td>
                            <div>
                              <span className="wo-id">{o.id}</span> <span className="wo-title">{o.title}</span>
                              {o.status === "Paused" && (
                                <span className="wo-pill" style={{ background: STATUS_COLOR.Paused, marginLeft: 8 }}>
                                  Paused
                                </span>
                              )}
                            </div>
                            {(o.productCode || o.productName) && (
                              <div style={{ fontSize: 11.5, color: BRAND.gunmetal }}>
                                {[o.productCode, o.productName].filter(Boolean).join(" · ")}
                              </div>
                            )}
                          </td>
                          <td style={{ fontSize: 12 }}>{assigneeText(o)}</td>
                          <td>
                            <input
                              className="wo-mini"
                              type="number"
                              min="1"
                              step="1"
                              style={{ width: 90 }}
                              disabled={!on}
                              value={on ? r.minutes : ""}
                              placeholder="min"
                              onChange={(e) => setField(o.id, "minutes", e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              className="wo-mini"
                              style={{ width: "100%", minWidth: 140 }}
                              disabled={!on}
                              value={on ? r.note : ""}
                              placeholder="optional"
                              onChange={(e) => setField(o.id, "note", e.target.value)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontWeight: 800,
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                  color: BRAND.gunmetal,
                  marginBottom: 6,
                }}
              >
                Other time (not linked to a work order)
              </div>
              <div style={{ overflowX: "auto", border: "1px solid " + BRAND.line, borderRadius: 6 }}>
                <table className="wo-table">
                  <tbody>
                    {NON_WO_ACTIVITIES.map((a) => {
                      const key = "act:" + a;
                      const r = sheet[key];
                      const on = !!(r && r.on);
                      return (
                        <tr key={a} style={on ? { background: "#FFF6F0" } : undefined}>
                          <td style={{ width: 28 }}>
                            <input type="checkbox" checked={on} onChange={() => toggle(key)} />
                          </td>
                          <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{a}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <input
                              className="wo-mini"
                              type="number"
                              min="1"
                              step="1"
                              style={{ width: 90 }}
                              disabled={!on}
                              value={on ? r.minutes : ""}
                              placeholder="min"
                              onChange={(e) => setField(key, "minutes", e.target.value)}
                            />
                            {on && (
                              <button className="wo-link" style={{ marginLeft: 8 }} onClick={() => fillRest(key)}>
                                fill rest of day
                              </button>
                            )}
                          </td>
                          <td>
                            <input
                              className="wo-mini"
                              style={{ width: "100%", minWidth: 140 }}
                              disabled={!on}
                              value={on ? r.note : ""}
                              placeholder="optional"
                              onChange={(e) => setField(key, "note", e.target.value)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14 }}>
                  Total: <span style={{ color: sheetTotal > 1440 ? BRAND.danger : BRAND.orange }}>{fmtMin(sheetTotal)}</span>
                  <span style={{ fontWeight: 500, fontSize: 12, color: BRAND.gunmetal }}>
                    {" "}
                    of a {target}-minute shift
                  </span>
                </div>
                <div style={{ fontSize: 12, color: BRAND.gunmetal }}>
                  Work orders {woTotal} min · Other activities {actTotal} min ·{" "}
                  {dayStatusText}
                </div>
              </div>
              <button className="wo-btn" onClick={save}>
                Save timesheet
              </button>
              {error && <span style={{ color: BRAND.danger, fontSize: 12.5 }}>{error}</span>}
              {saved && <span style={{ color: BRAND.ok, fontSize: 12.5, fontWeight: 700 }}>{saved}</span>}
            </div>
          </div>
        )}
      </div>

      {/* ---- day record ---- */}
      <div className="wo-panel" style={{ marginBottom: 16 }}>
        <div className="wo-panel-head">
          <UserCircle2 size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Time recorded — {date}</div>
          <div className="wo-controls">
            <ExportBtn
              label="Export this day"
              onClick={() =>
                downloadCSV(
                  "timesheets-" + date + ".csv",
                  ["Date", "Worker", "Shift start", "Shift end", "Work order", "Title", "Activity (not a work order)", "Minutes", "Note"],
                  dayEntries.map((t) => [
                    t.date,
                    t.worker,
                    (shiftMap[t.date + "|" + t.worker] || {}).start || "",
                    (shiftMap[t.date + "|" + t.worker] || {}).end || "",
                    t.woId || "",
                    orderById[t.woId] ? orderById[t.woId].title : "",
                    t.activity || "",
                    t.minutes,
                    t.note,
                  ])
                )
              }
            />
          </div>
        </div>
        {dayEntries.length === 0 ? (
          <div className="wo-empty">No time recorded for this date.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wo-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Work order</th>
                  <th>Minutes</th>
                  <th>Note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[...dayEntries]
                  .sort((a, b) => (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : (a.woId || "~" + a.activity) < (b.woId || "~" + b.activity) ? -1 : 1))
                  .map((t) => (
                    <tr key={t.id}>
                      <td>{t.worker}</td>
                      <td>
                        {t.activity ? (
                          <span style={{ fontWeight: 600 }}>
                            {t.activity} <span style={{ color: BRAND.gunmetal, fontWeight: 400 }}>(not a work order)</span>
                          </span>
                        ) : (
                          <>
                            <span className="wo-id">{t.woId}</span> {orderById[t.woId] ? orderById[t.woId].title : ""}
                          </>
                        )}
                      </td>
                      <td style={{ fontWeight: 700 }}>{t.minutes} min</td>
                      <td style={{ color: BRAND.gunmetal, fontSize: 12 }}>{t.note}</td>
                      <td>
                        <button className="wo-icon-btn" title="Delete entry" onClick={() => onDelete(t.id)}>
                          <X size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <ul className="wo-report-list" style={{ padding: "8px 16px", background: BRAND.paper }}>
              {dayByWorker.map(([name, m]) => (
                <li key={name}>
                  <span>
                    {name} — total for the day
                    {shiftMap[date + "|" + name]
                      ? " · shift " +
                        fmtClock(shiftMap[date + "|" + name].start) +
                        " – " +
                        fmtClock(shiftMap[date + "|" + name].end)
                      : ""}
                  </span>
                  <span style={{ fontWeight: 800 }}>{fmtMin(m)}</span>
                </li>
              ))}
              <li>
                <span style={{ fontWeight: 800 }}>All workers</span>
                <span style={{ fontWeight: 800, color: BRAND.orange }}>{fmtMin(dayTotal)}</span>
              </li>
            </ul>
          </div>
        )}
      </div>

      {/* ---- cumulative by work order ---- */}
      <div className="wo-panel">
        <div className="wo-panel-head">
          <ClipboardList size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Cumulative time by work order</div>
          <div className="wo-controls">
            <ExportBtn
              label="Export summary"
              onClick={() =>
                downloadCSV(
                  "time-by-work-order-" + todayISO() + ".csv",
                  ["Work order", "Title", "Product code", "Status", "Minutes by worker", "Days worked", "Total minutes"],
                  byWO.map((r) => {
                    const o = orderById[r.woId];
                    return [
                      r.woId,
                      o ? o.title : "(deleted work order)",
                      o ? o.productCode : "",
                      o ? o.status : "",
                      Object.entries(r.workers)
                        .sort((a, b) => b[1] - a[1])
                        .map(([n, m]) => n + ": " + m + " min")
                        .join("; "),
                      r.days.size,
                      r.total,
                    ];
                  })
                )
              }
            />
            <ExportBtn
              label="Export all entries"
              onClick={() =>
                downloadCSV(
                  "time-entries-" + todayISO() + ".csv",
                  ["Date", "Worker", "Shift start", "Shift end", "Work order", "Title", "Activity (not a work order)", "Product code", "Minutes", "Note"],
                  [...ranged]
                    .sort((a, b) => (a.date < b.date ? 1 : -1))
                    .map((t) => [
                      t.date,
                      t.worker,
                      (shiftMap[t.date + "|" + t.worker] || {}).start || "",
                      (shiftMap[t.date + "|" + t.worker] || {}).end || "",
                      t.woId || "",
                      orderById[t.woId] ? orderById[t.woId].title : "",
                      t.activity || "",
                      orderById[t.woId] ? orderById[t.woId].productCode : "",
                      t.minutes,
                      t.note,
                    ])
                )
              }
            />
            <input type="date" className="wo-select" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
            <input type="date" className="wo-select" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
            {(from || to) && (
              <button
                className="wo-btn ghost"
                onClick={() => {
                  setFrom("");
                  setTo("");
                }}
              >
                All time
              </button>
            )}
          </div>
        </div>
        {byWO.length === 0 ? (
          <div className="wo-empty">No time recorded in this range.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wo-table">
              <thead>
                <tr>
                  <th>Work order</th>
                  <th>Product</th>
                  <th>Status</th>
                  <th>Time by worker</th>
                  <th>Days worked</th>
                  <th>Total time</th>
                </tr>
              </thead>
              <tbody>
                {byWO.map((r) => {
                  const o = orderById[r.woId];
                  return (
                    <tr key={r.woId}>
                      <td>
                        <div className="wo-id">{r.woId}</div>
                        <div className="wo-title">{o ? o.title : "(deleted work order)"}</div>
                      </td>
                      <td>{o && o.productCode ? o.productCode : "—"}</td>
                      <td style={{ color: o ? STATUS_COLOR[o.status] : BRAND.gunmetal, fontWeight: 700, fontSize: 12 }}>
                        {o ? o.status : "—"}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {Object.entries(r.workers)
                          .sort((a, b) => b[1] - a[1])
                          .map(([n, m]) => (
                            <div key={n}>
                              {n}: <strong>{m} min</strong>
                            </div>
                          ))}
                      </td>
                      <td>{r.days.size}</td>
                      <td style={{ fontWeight: 800, color: BRAND.orange }}>{fmtMin(r.total)}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={5} style={{ fontWeight: 800, textAlign: "right" }}>
                    Grand total
                  </td>
                  <td style={{ fontWeight: 800 }}>{fmtMin(grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="wo-panel" style={{ marginTop: 16 }}>
        <div className="wo-panel-head">
          <UserCircle2 size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Work orders vs other activities</div>
          <div className="wo-controls">
            <ExportBtn
              onClick={() =>
                downloadCSV(
                  "time-by-category-" + todayISO() + ".csv",
                  ["Worker", "Work orders (min)", ...NON_WO_ACTIVITIES.map((a) => a + " (min)"), "Total (min)", "% on work orders"],
                  split.map((r) => [
                    r.worker,
                    r.wo,
                    ...NON_WO_ACTIVITIES.map((a) => r.acts[a] || 0),
                    r.total,
                    r.total ? Math.round((r.wo * 100) / r.total) : 0,
                  ])
                )
              }
            />
          </div>
        </div>
        {split.length === 0 ? (
          <div className="wo-empty">No time recorded in this range.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="wo-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Work orders</th>
                  {NON_WO_ACTIVITIES.map((a) => (
                    <th key={a}>{a}</th>
                  ))}
                  <th>Total</th>
                  <th>% on work orders</th>
                </tr>
              </thead>
              <tbody>
                {split.map((r) => (
                  <tr key={r.worker}>
                    <td style={{ fontWeight: 600 }}>{r.worker}</td>
                    <td style={{ fontWeight: 700, color: BRAND.orange }}>{r.wo} min</td>
                    {NON_WO_ACTIVITIES.map((a) => (
                      <td key={a}>{r.acts[a] ? r.acts[a] + " min" : "—"}</td>
                    ))}
                    <td style={{ fontWeight: 700 }}>{fmtMin(r.total)}</td>
                    <td>{r.total ? Math.round((r.wo * 100) / r.total) + "%" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11.5, color: BRAND.gunmetal, padding: "8px 16px" }}>
              Uses the From / To dates above (all time if empty).
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReportsArchive({ history, onDelete }) {
  const [expandedDate, setExpandedDate] = useState(null);
  const [confirmDate, setConfirmDate] = useState(null);

  const monthly = useMemo(() => {
    const map = {};
    history.forEach((r) => {
      const key = monthKey(r.date);
      if (!map[key]) {
        map[key] = {
          month: key,
          days: 0,
          closed: 0,
          opened: 0,
          carriedForwardSum: 0,
          maxLongPending: 0,
          maxOverdue: 0,
          lastCarriedForward: 0,
        };
      }
      const m = map[key];
      m.days += 1;
      m.closed += r.closedToday;
      m.opened += r.createdToday;
      m.carriedForwardSum += r.carriedForward;
      m.maxLongPending = Math.max(m.maxLongPending, r.longPending);
      m.maxOverdue = Math.max(m.maxOverdue, r.overdue);
    });
    // last recorded carried-forward value in each month (most recent day)
    Object.values(map).forEach((m) => {
      const daysInMonth = history.filter((r) => monthKey(r.date) === m.month).sort((a, b) => (a.date < b.date ? 1 : -1));
      m.lastCarriedForward = daysInMonth.length ? daysInMonth[0].carriedForward : 0;
    });
    return Object.values(map).sort((a, b) => (a.month < b.month ? 1 : -1));
  }, [history]);

  const sortedDaily = useMemo(() => [...history].sort((a, b) => (a.date < b.date ? 1 : -1)), [history]);

  if (history.length === 0) {
    return (
      <div className="wo-panel">
        <div className="wo-empty">
          No report history yet — a snapshot is recorded automatically each day the dashboard is
          used, starting today.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="wo-panel" style={{ marginBottom: 16 }}>
        <div className="wo-panel-head">
          <ClipboardList size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Monthly rollup</div>
          <div className="wo-controls">
            <ExportBtn
              onClick={() =>
                downloadCSV(
                  `monthly-report-${todayISO()}.csv`,
                  ["Month", "Days recorded", "Opened", "Closed", "Carried forward (last day)", "Peak long-pending", "Peak overdue"],
                  monthly.map((m) => [m.month, m.days, m.opened, m.closed, m.lastCarriedForward, m.maxLongPending, m.maxOverdue])
                )
              }
            />
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="wo-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Days recorded</th>
                <th>Opened</th>
                <th>Closed</th>
                <th>Carried-forward (last day)</th>
                <th>Peak long-pending</th>
                <th>Peak overdue</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td className="wo-title">{m.month}</td>
                  <td>{m.days}</td>
                  <td>{m.opened}</td>
                  <td style={{ color: BRAND.ok, fontWeight: 700 }}>{m.closed}</td>
                  <td style={{ color: BRAND.warn, fontWeight: 700 }}>{m.lastCarriedForward}</td>
                  <td style={{ color: BRAND.danger, fontWeight: 700 }}>{m.maxLongPending}</td>
                  <td style={{ color: BRAND.danger, fontWeight: 700 }}>{m.maxOverdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wo-panel">
        <div className="wo-panel-head">
          <Clock size={16} color={BRAND.orange} />
          <div className="wo-panel-title">Daily report records</div>
          <div className="wo-controls">
            <ExportBtn
              label="Export daily records"
              onClick={() =>
                downloadCSV(
                  `daily-reports-${todayISO()}.csv`,
                  ["Date", "Total open", "Opened", "Carried in", "Closed", "Carried forward", "Long-pending", "Overdue"],
                  sortedDaily.map((r) => [r.date, r.totalOpen, r.createdToday, r.carriedIn, r.closedToday, r.carriedForward, r.longPending, r.overdue])
                )
              }
            />
            <ExportBtn
              label="Export worker breakdown"
              onClick={() =>
                downloadCSV(
                  `daily-worker-breakdown-${todayISO()}.csv`,
                  ["Date", "Worker", "Carried from prior day", "Closed", "Carried forward"],
                  sortedDaily.flatMap((r) =>
                    (r.workers || []).map((w) => [r.date, w.name, w.inCount, w.closedCount, w.forwardCount])
                  )
                )
              }
            />
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="wo-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Carried in</th>
                <th>Closed</th>
                <th>Carried forward</th>
                <th>Long-pending</th>
                <th>Overdue</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedDaily.map((r) => {
                const isOpen = expandedDate === r.date;
                return (
                  <Fragment key={r.date}>
                    <tr>
                      <td className="wo-title">{r.date}</td>
                      <td>{r.carriedIn}</td>
                      <td style={{ color: BRAND.ok, fontWeight: 700 }}>{r.closedToday}</td>
                      <td style={{ color: BRAND.warn, fontWeight: 700 }}>{r.carriedForward}</td>
                      <td style={{ color: BRAND.danger, fontWeight: 700 }}>{r.longPending}</td>
                      <td>{r.overdue}</td>
                      <td>
                        <button
                          className="wo-icon-btn"
                          onClick={() => setExpandedDate(isOpen ? null : r.date)}
                          title="Worker breakdown"
                        >
                          <ChevronDown
                            size={15}
                            style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                          />
                        </button>
                        {confirmDate === r.date ? (
                          <button
                            className="wo-btn"
                            style={{ background: BRAND.danger, padding: "3px 8px", marginLeft: 6 }}
                            onClick={() => {
                              onDelete(r.date);
                              setConfirmDate(null);
                            }}
                          >
                            Delete record?
                          </button>
                        ) : (
                          <button
                            className="wo-icon-btn"
                            title="Delete this day's record"
                            onClick={() => setConfirmDate(r.date)}
                          >
                            <X size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} style={{ background: BRAND.paper, padding: 0 }}>
                          {r.workers.length === 0 ? (
                            <div className="wo-empty">No worker activity recorded that day.</div>
                          ) : (
                            <table className="wo-table" style={{ margin: "0 0 0 0" }}>
                              <thead>
                                <tr>
                                  <th>Worker</th>
                                  <th>Carried from prior day</th>
                                  <th>Closed</th>
                                  <th>Carried forward</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.workers.map((w) => (
                                  <tr key={w.name}>
                                    <td>{w.name}</td>
                                    <td>{w.inCount}</td>
                                    <td style={{ color: BRAND.ok, fontWeight: 700 }}>{w.closedCount}</td>
                                    <td style={{ color: BRAND.warn, fontWeight: 700 }}>{w.forwardCount}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function OrderForm({ initial, existingIds, workers = [], onCancel, onSave }) {
  const [form, setForm] = useState(
    (initial && normalizeOrder(initial)) || {
      id: "",
      title: "",
      productCode: "",
      productName: "",
      assignees: [],
      priority: "Medium",
      status: "Open",
      createdDate: todayISO(),
      dueDate: todayISO(),
      notes: "",
    }
  );

  // The "WO-" prefix is fixed; the number is typed in by the user.
  const [idNumber, setIdNumber] = useState(initial ? initial.id.replace(/^WO-/i, "") : "");
  const [idError, setIdError] = useState("");

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function submit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    if (initial) {
      onSave(form);
      return;
    }
    const num = idNumber.trim();
    if (!/^\d+$/.test(num)) {
      setIdError("Enter the work order number using digits only, e.g. 1045.");
      return;
    }
    const id = "WO-" + num;
    const taken = existingIds.some(
      (x) =>
        x.toLowerCase() === id.toLowerCase() ||
        (/^WO-\d+$/i.test(x) && parseInt(x.slice(3), 10) === parseInt(num, 10))
    );
    if (taken) {
      setIdError(id + " already exists. Use a different number.");
      return;
    }
    setIdError("");
    onSave({ ...form, id });
  }

  return (
    <div className="wo-modal-backdrop" onClick={onCancel}>
      <div className="wo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wo-modal-head">
          <div className="wo-modal-title">
            {initial ? `Edit ${form.id}` : "New work order"}
          </div>
          <button
            className="wo-icon-btn"
            style={{ marginLeft: "auto" }}
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="wo-field">
            <label>Work order number</label>
            <div style={{ display: "flex", alignItems: "stretch" }}>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0 10px",
                  background: BRAND.paper,
                  border: "1px solid " + BRAND.line,
                  borderRight: "none",
                  borderRadius: "5px 0 0 5px",
                  fontWeight: 800,
                  fontSize: 13,
                }}
              >
                WO-
              </span>
              <input
                style={{ flex: 1, width: "auto", minWidth: 0, borderRadius: "0 5px 5px 0" }}
                value={idNumber}
                disabled={!!initial}
                inputMode="numeric"
                placeholder="e.g. 1045"
                required
                onChange={(e) => {
                  setIdNumber(e.target.value.replace(/\D/g, ""));
                  setIdError("");
                }}
              />
            </div>
            {idError && <div style={{ color: BRAND.danger, fontSize: 12, marginTop: 4 }}>{idError}</div>}
            {initial && (
              <div style={{ fontSize: 11.5, color: BRAND.gunmetal, marginTop: 4 }}>
                The number can't be changed after the work order is created.
              </div>
            )}
          </div>
          <div className="wo-field">
            <label>Title</label>
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. Replace failed switch — Rack 4"
              required
            />
          </div>
          <div className="wo-field-row">
            <div className="wo-field">
              <label>Product code</label>
              <input
                value={form.productCode}
                onChange={(e) => set("productCode", e.target.value)}
                placeholder="e.g. NET-SW24"
              />
            </div>
            <div className="wo-field">
              <label>Product name</label>
              <input
                value={form.productName}
                onChange={(e) => set("productName", e.target.value)}
                placeholder="e.g. 24-Port Managed Switch"
              />
            </div>
          </div>
          <div className="wo-field-row">
            <div className="wo-field">
              <label>Assigned workers (pick one or more)</label>
              <div className="wo-checklist">
                {Array.from(new Set([...workers, ...form.assignees])).length === 0 ? (
                  <span style={{ fontSize: 12, color: BRAND.gunmetal }}>
                    No workers yet — add them on the Workers tab.
                  </span>
                ) : (
                  Array.from(new Set([...workers, ...form.assignees]))
                    .sort()
                    .map((w) => (
                      <label key={w} className="wo-check">
                        <input
                          type="checkbox"
                          checked={form.assignees.includes(w)}
                          onChange={() =>
                            set(
                              "assignees",
                              form.assignees.includes(w)
                                ? form.assignees.filter((x) => x !== w)
                                : [...form.assignees, w]
                            )
                          }
                        />
                        {w}
                      </label>
                    ))
                )}
              </div>
            </div>
            <div className="wo-field">
              <label>Priority</label>
              <select value={form.priority} onChange={(e) => set("priority", e.target.value)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="wo-field-row">
            <div className="wo-field">
              <label>Status</label>
              <select value={form.status} onChange={(e) => set("status", e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="wo-field">
              <label>Due date</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </div>
          </div>
          <div className="wo-field">
            <label>Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Optional context for the team"
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="wo-btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="wo-btn">
              {initial ? "Save changes" : "Create order"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
