"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import DoseChip from "@/components/DoseChip";
import { DayTimeline, Ring } from "@/components/DayTimeline";
import {
  getDashboard,
  replyToDose,
  resolveAlert,
  timeAgo,
  type Alert,
  type DoseStatus,
  type PatientSummary,
} from "@/lib/api";
import { useSession } from "@/lib/auth";

const AVATARS = [
  "bg-brand-soft text-brand",
  "bg-due-bg text-due",
  "bg-taken-bg text-taken",
  "bg-[#e6e3f7] text-[#4a3f9a]",
];
const ALERT_ICON: Record<Alert["type"], string> = { missed_dose: "💊", no_checkin: "💬", needs_help: "🆘" };

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

export default function Dashboard() {
  const { user, ready } = useSession();
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [today, setToday] = useState("");

  useEffect(() => {
    // The date is set in the browser only, so server and browser never disagree.
    setToday(
      new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }),
    );
  }, []);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const load = async () => {
      try {
        const data = await getDashboard();
        if (!active) return;
        setPatients(data.patients);
        setAlerts(data.alerts);
        setError("");
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load the care board");
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 5000); // Telegram replies appear without a manual reload
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready]);

  async function handleResolve(id: number) {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await resolveAlert(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve the alert");
    }
  }

  async function handleReply(doseId: number, action: "taken" | "skip") {
    const status: DoseStatus = action === "taken" ? "taken" : "skipped";
    setPatients((prev) =>
      prev.map((p) => {
        const doses = p.doses.map((d) => (d.id === doseId ? { ...d, status } : d));
        return {
          ...p,
          doses,
          taken: doses.filter((d) => d.status === "taken").length,
          missed: doses.filter((d) => d.status === "missed").length,
          pending: doses.filter((d) => d.status === "pending" || d.status === "reminded").length,
        };
      }),
    );
    try {
      await replyToDose(doseId, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the reply");
    }
  }

  if (!ready) return <p className="text-muted">Loading</p>;

  const totalDoses = patients.reduce((s, p) => s + p.total, 0);
  const takenDoses = patients.reduce((s, p) => s + p.taken, 0);
  const missedDoses = patients.reduce((s, p) => s + p.missed, 0);

  return (
    <main>
      <header className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-widest text-brand">
            {user?.role === "admin" ? "Admin view, all patients" : "Caregiver dashboard"}
          </p>
          <h1 className="font-display text-5xl font-semibold tracking-tight">Care board</h1>
          <p className="h-6 text-muted">{today}</p>
        </div>
        {error ? (
          <span className="rounded-full bg-missed-bg px-3 py-1 text-sm font-bold text-missed">Offline</span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full bg-paper px-3 py-1 text-sm font-bold text-taken shadow-sm">
            <span className="pulse-green h-2.5 w-2.5 rounded-full bg-taken" />
            Live
          </span>
        )}
      </header>

      {error && (
        <p role="alert" className="mb-6 rounded-xl bg-missed-bg px-4 py-3 font-bold text-missed">
          {error}
        </p>
      )}

      <section className="rise mb-8 grid gap-4 sm:grid-cols-3" style={{ animationDelay: "60ms" }}>
        <div className="card flex items-center gap-4 p-5">
          <Ring taken={takenDoses} total={totalDoses} missed={missedDoses} size={72} />
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-muted">Doses today</p>
            <p className="font-display text-3xl font-semibold">
              {takenDoses}
              <span className="text-muted">/{totalDoses}</span>
            </p>
          </div>
        </div>
        <div className="card p-5">
          <p className="text-sm font-bold uppercase tracking-wide text-muted">People you care for</p>
          <p className="font-display text-3xl font-semibold">{patients.length}</p>
        </div>
        <div className={`card p-5 ${alerts.length > 0 ? "border-missed/40" : ""}`}>
          <p className="text-sm font-bold uppercase tracking-wide text-muted">Needs attention</p>
          <p
            className={`flex items-center gap-2 font-display text-3xl font-semibold ${
              alerts.length > 0 ? "text-missed" : "text-taken"
            }`}
          >
            {alerts.length > 0 && <span className="pulse-red h-3 w-3 rounded-full bg-missed" />}
            {alerts.length > 0 ? `${alerts.length} open` : "All clear"}
          </p>
        </div>
      </section>

      {alerts.length > 0 && (
        <section aria-labelledby="alerts-heading" className="rise mb-8">
          <h2 id="alerts-heading" className="mb-3 font-display text-2xl font-semibold">
            Needs attention
          </h2>
          <ul className="card divide-y divide-line border-missed/40">
            {alerts.map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-missed-bg text-xl" aria-hidden>
                    {ALERT_ICON[alert.type]}
                  </span>
                  <div>
                    <p className="font-bold text-missed">{alert.message}</p>
                    <p className="text-base text-muted">{timeAgo(alert.created_at)}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/patients/${alert.patient_id}`}
                    className="rounded-xl border border-line px-4 py-2 font-bold transition hover:bg-mist"
                  >
                    Open patient
                  </Link>
                  <button
                    onClick={() => handleResolve(alert.id)}
                    className="rounded-xl bg-ink px-4 py-2 font-bold text-white transition hover:opacity-90 active:scale-95"
                  >
                    Mark resolved
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="today-heading">
        <h2 id="today-heading" className="mb-3 font-display text-2xl font-semibold">
          Today
        </h2>

        {loading && (
          <div className="space-y-6">
            {[0, 1].map((i) => (
              <div key={i} className="card h-56 animate-pulse opacity-60" />
            ))}
          </div>
        )}

        {!loading && !error && patients.length === 0 && (
          <p className="card px-5 py-6 text-muted">
            {user?.role === "admin" ? (
              <>
                No patients yet. Add one in the{" "}
                <Link href="/admin" className="font-bold text-brand hover:underline">
                  admin console
                </Link>
                .
              </>
            ) : (
              "No patients are assigned to you yet. Ask your admin to assign one."
            )}
          </p>
        )}

        <ul className="space-y-6">
          {patients.map((p, i) => (
            <li key={p.id} className="card rise p-5 sm:p-6" style={{ animationDelay: `${120 + i * 80}ms` }}>
              <div className="flex items-center gap-4">
                <span
                  className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl font-display text-xl font-semibold ${
                    AVATARS[p.id % AVATARS.length]
                  }`}
                  aria-hidden
                >
                  {initials(p.full_name)}
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={`/patients/${p.id}`} className="font-display text-2xl font-semibold hover:underline">
                    {p.full_name}
                  </Link>
                  <p className="text-muted">
                    {p.taken} of {p.total} doses taken
                    {p.missed > 0 && <span className="font-bold text-missed">, {p.missed} missed</span>}
                  </p>
                </div>
                <Ring taken={p.taken} total={p.total} missed={p.missed} />
              </div>

              <div className="mt-5 rounded-2xl bg-mist/60 px-2 py-3">
                <DayTimeline doses={p.doses} />
              </div>

              {p.doses.length === 0 ? (
                <p className="mt-4 text-muted">No doses scheduled today.</p>
              ) : (
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {p.doses.map((d) => (
                    <DoseChip key={d.id} dose={d} onReply={handleReply} />
                  ))}
                </ul>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 rounded-full bg-mist px-3 py-1 text-sm text-muted">
                  💬 {p.last_checkin ? `Last check-in reply ${timeAgo(p.last_checkin)}` : "No check-in reply yet"}
                </span>
                <Link href={`/patients/${p.id}`} className="font-bold text-brand hover:underline">
                  Open details
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
