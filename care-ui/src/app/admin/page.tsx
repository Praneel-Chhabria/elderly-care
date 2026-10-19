"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  createCaregiver,
  createPatient,
  deleteCaregiver,
  deletePatient,
  getAdminPatients,
  getCaregivers,
  resetPassword,
  updatePatient,
  type AdminPatient,
  type Caregiver,
} from "@/lib/api";
import { useSession } from "@/lib/auth";

const inputCls =
  "w-full rounded-xl border border-line bg-white px-4 py-2 text-lg placeholder:text-muted focus:border-brand";
const primaryBtn =
  "rounded-xl bg-brand px-5 py-2.5 font-bold text-white transition hover:brightness-110 active:scale-95 disabled:opacity-60";

export default function AdminPage() {
  const { user, ready } = useSession(true);
  const [patients, setPatients] = useState<AdminPatient[]>([]);
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // add patient form
  const [pName, setPName] = useState("");
  const [pChat, setPChat] = useState("");
  const [pCheckin, setPCheckin] = useState("09:00");
  const [pCaregivers, setPCaregivers] = useState<number[]>([]);
  // add caregiver form
  const [cName, setCName] = useState("");
  const [cUser, setCUser] = useState("");
  const [cPass, setCPass] = useState("");
  const [cRole, setCRole] = useState<"caregiver" | "admin">("caregiver");
  const [cChat, setCChat] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([getAdminPatients(), getCaregivers()]);
      setPatients(p);
      setCaregivers(c);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the admin console");
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setNotice("");
    try {
      await action();
      setError("");
      if (success) setNotice(success);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    }
  }

  async function addPatient(e: React.SyntheticEvent) {
    e.preventDefault();
    const ok = await run(
      () => createPatient({ full_name: pName, chat_id: pChat, checkin_time: pCheckin, caregiver_ids: pCaregivers }),
      `${pName.trim()} was added.`,
    );
    if (ok) {
      setPName("");
      setPChat("");
      setPCheckin("09:00");
      setPCaregivers([]);
    }
  }

  async function addCaregiver(e: React.SyntheticEvent) {
    e.preventDefault();
    const ok = await run(
      () => createCaregiver({ full_name: cName, username: cUser, password: cPass, role: cRole, chat_id: cChat }),
      `Account ${cUser.trim()} was created.`,
    );
    if (ok) {
      setCName("");
      setCUser("");
      setCPass("");
      setCRole("caregiver");
      setCChat("");
    }
  }

  const toggleIn = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  if (!ready) return <p className="text-muted">Loading</p>;

  const logins = caregivers.filter((c) => c.username);
  const openAlerts = patients.reduce((s, p) => s + p.open_alerts, 0);
  const missedToday = patients.reduce((s, p) => s + p.missed, 0);

  return (
    <main>
      <header className="rise mb-8">
        <p className="text-sm font-bold uppercase tracking-widest text-brand">Admin console</p>
        <h1 className="font-display text-5xl font-semibold tracking-tight">Manage everything</h1>
        <p className="text-muted">Add patients, choose who looks after them, pause reminders and manage logins.</p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-missed-bg px-4 py-3 font-bold text-missed">
          {error}
        </p>
      )}
      {notice && <p className="mb-4 rounded-xl bg-taken-bg px-4 py-3 font-bold text-taken">{notice}</p>}

      <section className="rise mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4" style={{ animationDelay: "60ms" }}>
        {[
          ["Patients", patients.length, ""],
          ["Logins", logins.length, ""],
          ["Open alerts", openAlerts, openAlerts > 0 ? "text-missed" : "text-taken"],
          ["Missed today", missedToday, missedToday > 0 ? "text-missed" : "text-taken"],
        ].map(([label, value, tone]) => (
          <div key={label as string} className="card p-5">
            <p className="text-sm font-bold uppercase tracking-wide text-muted">{label}</p>
            <p className={`font-display text-3xl font-semibold ${tone}`}>{value}</p>
          </div>
        ))}
      </section>

      <section aria-labelledby="patients-heading" className="mb-10">
        <h2 id="patients-heading" className="mb-3 font-display text-2xl font-semibold">
          Patients
        </h2>
        {patients.length === 0 && <p className="card px-5 py-6 text-muted">No patients yet. Add the first one below.</p>}
        <ul className="space-y-4">
          {patients.map((p) => (
            <li key={p.id} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <Link href={`/patients/${p.id}`} className="font-display text-2xl font-semibold hover:underline">
                    {p.full_name}
                  </Link>
                  <p className="text-muted">
                    Chat ID {p.chat_id}, check-in at {p.checkin_time}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-sm font-bold">
                    <span className="rounded-full bg-mist px-3 py-1 text-muted">
                      {p.taken}/{p.total} taken today
                    </span>
                    {p.missed > 0 && (
                      <span className="rounded-full bg-missed-bg px-3 py-1 text-missed">{p.missed} missed</span>
                    )}
                    {p.open_alerts > 0 && (
                      <span className="rounded-full bg-missed-bg px-3 py-1 text-missed">
                        {p.open_alerts} open alert{p.open_alerts === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 font-bold">
                    <span className={p.opted_in ? "text-taken" : "text-muted"}>
                      {p.opted_in ? "Reminders on" : "Paused"}
                    </span>
                    <button
                      role="switch"
                      aria-checked={p.opted_in}
                      aria-label={`Reminders for ${p.full_name}`}
                      onClick={() => run(() => updatePatient(p.id, { opted_in: !p.opted_in }))}
                      className={`relative h-7 w-12 rounded-full transition ${p.opted_in ? "bg-taken" : "bg-line"}`}
                    >
                      <span
                        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                          p.opted_in ? "left-6" : "left-1"
                        }`}
                      />
                    </button>
                  </label>
                  <button
                    onClick={() => {
                      if (window.confirm(`Remove ${p.full_name} and all of their history? This cannot be undone.`))
                        run(() => deletePatient(p.id), `${p.full_name} was removed.`);
                    }}
                    className="rounded-xl border border-missed/40 px-4 py-2 font-bold text-missed transition hover:bg-missed-bg active:scale-95"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <details className="mt-4 rounded-2xl bg-mist/60 px-4 py-3">
                <summary className="cursor-pointer font-bold">
                  Caregivers looking after {p.full_name.split(" ")[0]} ({p.caregiver_ids.length})
                </summary>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                  {logins.map((c) => (
                    <label key={c.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-[var(--color-brand)]"
                        checked={p.caregiver_ids.includes(c.id)}
                        onChange={() =>
                          run(() => updatePatient(p.id, { caregiver_ids: toggleIn(p.caregiver_ids, c.id) }))
                        }
                      />
                      {c.full_name} <span className="text-sm text-muted">({c.role})</span>
                    </label>
                  ))}
                  {logins.length === 0 && <span className="text-muted">Create a login below first.</span>}
                </div>
                <p className="mt-2 text-sm text-muted">Admins always see every patient.</p>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="add-patient-heading" className="mb-10">
        <h2 id="add-patient-heading" className="mb-3 font-display text-2xl font-semibold">
          Add a patient
        </h2>
        <form onSubmit={addPatient} className="card space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block font-bold">Full name</span>
              <input className={inputCls} value={pName} onChange={(e) => setPName(e.target.value)} required />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold">Telegram chat ID</span>
              <input className={inputCls} value={pChat} onChange={(e) => setPChat(e.target.value)} placeholder="6855885374" required />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold">Morning check-in</span>
              <input type="time" className={inputCls} value={pCheckin} onChange={(e) => setPCheckin(e.target.value)} required />
            </label>
          </div>
          <p className="text-muted">
            To find the chat ID, the patient opens your bot in Telegram and sends <b>/start</b>. The bot replies with
            their ID.
          </p>
          {logins.length > 0 && (
            <fieldset>
              <legend className="mb-1 font-bold">Who looks after this patient?</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {logins.map((c) => (
                  <label key={c.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[var(--color-brand)]"
                      checked={pCaregivers.includes(c.id)}
                      onChange={() => setPCaregivers((prev) => toggleIn(prev, c.id))}
                    />
                    {c.full_name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <button type="submit" className={primaryBtn}>
            Add patient
          </button>
        </form>
      </section>

      <section aria-labelledby="logins-heading" className="mb-10">
        <h2 id="logins-heading" className="mb-3 font-display text-2xl font-semibold">
          Logins
        </h2>
        <ul className="card divide-y divide-line">
          {caregivers.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="text-lg font-bold">
                  {c.full_name}{" "}
                  <span
                    className={`ml-1 rounded-full px-2 text-xs font-bold ${
                      c.role === "admin" ? "bg-brand-soft text-brand" : "bg-mist text-muted"
                    }`}
                  >
                    {c.role}
                  </span>
                </p>
                <p className="text-muted">
                  {c.username ? `@${c.username}` : "No login yet"}
                  {c.chat_id ? `, chat ID ${c.chat_id}` : ", no Telegram alerts"}
                </p>
              </div>
              {c.username && (
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const pw = window.prompt(`New password for ${c.username} (at least 8 characters)`);
                      if (pw) run(() => resetPassword(c.id, pw), `Password for ${c.username} was changed.`);
                    }}
                    className="rounded-xl border border-line px-4 py-2 font-bold text-muted transition hover:bg-mist"
                  >
                    Reset password
                  </button>
                  {c.id !== user?.id && (
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete the login for ${c.full_name}?`))
                          run(() => deleteCaregiver(c.id), `${c.full_name} was deleted.`);
                      }}
                      className="rounded-xl border border-missed/40 px-4 py-2 font-bold text-missed transition hover:bg-missed-bg"
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        <form onSubmit={addCaregiver} className="card mt-4 space-y-4 p-5">
          <h3 className="font-display text-xl font-semibold">Create a login</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block font-bold">Full name</span>
              <input className={inputCls} value={cName} onChange={(e) => setCName(e.target.value)} required />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold">Username</span>
              <input
                className={inputCls}
                value={cUser}
                onChange={(e) => setCUser(e.target.value)}
                autoCapitalize="none"
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold">Password (at least 8 characters)</span>
              <input
                className={inputCls}
                type="password"
                value={cPass}
                onChange={(e) => setCPass(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold">Role</span>
              <select
                className={inputCls}
                value={cRole}
                onChange={(e) => setCRole(e.target.value as "caregiver" | "admin")}
              >
                <option value="caregiver">Caregiver, sees only their patients</option>
                <option value="admin">Admin, sees and controls everything</option>
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block font-bold">Telegram chat ID for alerts (optional)</span>
              <input className={inputCls} value={cChat} onChange={(e) => setCChat(e.target.value)} />
            </label>
          </div>
          <button type="submit" className={primaryBtn}>
            Create login
          </button>
        </form>
      </section>
    </main>
  );
}
