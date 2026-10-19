"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import DoseChip from "@/components/DoseChip";
import {
  addMedicine,
  deleteMedicine,
  getPatient,
  replyToDose,
  type DoseStatus,
  type Medicine,
  type PatientDetail,
} from "@/lib/api";
import { useSession } from "@/lib/auth";

const DAY_CHIPS: (number | null)[] = [null, 3, 5, 7, 10, 14, 30];

const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function PatientContent() {
  const { ready } = useSession();
  const params = useParams<{ id: string }>();
  const patientId = Number(params.id);

  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [loadError, setLoadError] = useState("");

  const [name, setName] = useState("");
  const [dosage, setDosage] = useState("");
  const [instructions, setInstructions] = useState("");
  const [times, setTimes] = useState<string[]>(["08:00"]);
  const [days, setDays] = useState<number | null>(null); // null means ongoing
  const [customDays, setCustomDays] = useState("");
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await getPatient(patientId);
      setPatient(data);
      setMedicines(data.medicines);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this patient");
    }
  }, [patientId]);

  // Refresh every 5 seconds so replies from Telegram show up without a manual reload.
  useEffect(() => {
    if (!ready) return;
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [ready, load]);

  async function handleReply(doseId: number, action: "taken" | "skip") {
    const status: DoseStatus = action === "taken" ? "taken" : "skipped";
    setPatient((prev) =>
      prev ? { ...prev, doses: prev.doses.map((d) => (d.id === doseId ? { ...d, status } : d)) } : prev,
    );
    try {
      await replyToDose(doseId, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the reply");
    }
  }

  async function handleDelete(m: Medicine) {
    const ok = window.confirm(
      `Delete ${m.name}? Its upcoming reminders will stop. Doses already taken stay in the history.`,
    );
    if (!ok) return;
    try {
      await deleteMedicine(patientId, m.id);
      setMedicines((prev) => prev.filter((x) => x.id !== m.id));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the medicine");
    }
  }

  function setTimeAt(index: number, value: string) {
    setTimes((prev) => prev.map((t, i) => (i === index ? value : t)));
  }

  function onCustomDays(value: string) {
    setCustomDays(value);
    const n = parseInt(value, 10);
    setDays(value === "" || !Number.isFinite(n) || n < 1 ? null : Math.min(n, 365));
  }

  async function handleAdd(e: React.SyntheticEvent) {
    e.preventDefault();
    setError("");
    const cleanTimes = times.filter(Boolean);
    if (!name.trim() || !dosage.trim() || cleanTimes.length === 0) {
      setError("Enter a medicine name, a dosage and at least one time.");
      return;
    }
    setSaving(true);
    try {
      const created = await addMedicine(patientId, {
        name: name.trim(),
        dosage: dosage.trim(),
        instructions: instructions.trim(),
        times: cleanTimes,
        days,
      });
      setMedicines((prev) => [...prev, created]);
      setName("");
      setDosage("");
      setInstructions("");
      setTimes(["08:00"]);
      setDays(null);
      setCustomDays("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the medicine");
    } finally {
      setSaving(false);
    }
  }

  if (!ready) return <p className="text-muted">Loading</p>;
  if (loadError && !patient) {
    return (
      <main>
        <Link href="/" className="font-bold text-brand hover:underline">
          Back to care board
        </Link>
        <p role="alert" className="mt-4 rounded-xl bg-missed-bg px-4 py-3 font-bold text-missed">
          {loadError}
        </p>
      </main>
    );
  }
  if (!patient) return <p className="text-muted">Loading patient</p>;

  const endLabel =
    days !== null && nowMs !== null
      ? new Date(nowMs + (days - 1) * 86400000).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
      : null;

  const inputCls =
    "w-full rounded-xl border border-line bg-white px-4 py-2 text-lg placeholder:text-muted focus:border-brand";
  const chip = (active: boolean) =>
    `rounded-full border px-4 py-1.5 font-bold transition ${
      active ? "border-brand bg-brand text-white" : "border-line bg-paper text-muted hover:bg-mist"
    }`;

  return (
    <main>
      <Link href="/" className="font-bold text-brand hover:underline">
        Back to care board
      </Link>

      <header className="rise mb-8 mt-4">
        <h1 className="font-display text-5xl font-semibold tracking-tight">{patient.full_name}</h1>
        <p className="text-muted">Telegram chat ID {patient.phone_whatsapp}</p>
      </header>

      {(error || loadError) && (
        <p role="alert" className="mb-6 rounded-xl bg-missed-bg px-4 py-3 font-bold text-missed">
          {error || loadError}
        </p>
      )}

      <section aria-labelledby="doses-heading" className="mb-10">
        <h2 id="doses-heading" className="mb-3 font-display text-2xl font-semibold">
          Today
        </h2>
        {patient.doses.length === 0 ? (
          <p className="text-muted">No doses scheduled today.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {patient.doses.map((d) => (
              <DoseChip key={d.id} dose={d} onReply={handleReply} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="adherence-heading" className="mb-10">
        <h2 id="adherence-heading" className="mb-3 font-display text-2xl font-semibold">
          Last 7 days
        </h2>
        <ul className="card space-y-2 px-5 py-4">
          {patient.adherence_7d.map((d) => {
            const pct = d.total === 0 ? 0 : Math.round((d.taken / d.total) * 100);
            return (
              <li key={d.day} className="flex items-center gap-4">
                <span className="w-12 font-bold">{d.day}</span>
                <div className="h-4 flex-1 rounded-full bg-mist" role="img" aria-label={`${d.taken} of ${d.total} doses taken`}>
                  <div
                    className={`h-4 rounded-full ${pct === 100 ? "bg-taken" : "bg-due"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-24 text-right text-base text-muted">
                  {d.taken} of {d.total}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="meds-heading" className="mb-10">
        <h2 id="meds-heading" className="mb-3 font-display text-2xl font-semibold">
          Medicines
        </h2>
        <ul className="card divide-y divide-line">
          {medicines.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="text-xl font-bold">
                  {m.name}, <span className="font-normal text-muted">{m.dosage}</span>
                </p>
                <p className="text-muted">
                  Daily at {m.times.join(", ")}
                  {m.instructions ? `. ${m.instructions}` : ""}
                </p>
                <span className="mt-1 inline-block rounded-full bg-brand-soft px-3 py-0.5 text-sm font-bold text-brand">
                  {m.end_date ? `Until ${shortDate(m.end_date)}` : "Ongoing"}
                </span>
              </div>
              <button
                onClick={() => handleDelete(m)}
                className="rounded-xl border border-missed/40 px-4 py-2 font-bold text-missed transition hover:bg-missed-bg active:scale-95"
              >
                Delete
              </button>
            </li>
          ))}
          {medicines.length === 0 && <li className="px-5 py-4 text-muted">No medicines added yet.</li>}
        </ul>
      </section>

      <section aria-labelledby="add-heading">
        <h2 id="add-heading" className="mb-3 font-display text-2xl font-semibold">
          Add a medicine
        </h2>
        <form onSubmit={handleAdd} className="card space-y-5 px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block font-bold">Medicine name</span>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Metformin" />
            </label>
            <label className="block">
              <span className="mb-1 block font-bold">Dosage</span>
              <input className={inputCls} value={dosage} onChange={(e) => setDosage(e.target.value)} placeholder="500 mg" />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block font-bold">Instructions (optional)</span>
            <input
              className={inputCls}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="After breakfast"
            />
          </label>

          <fieldset>
            <legend className="mb-1 font-bold">Reminder times each day</legend>
            <div className="flex flex-wrap gap-3">
              {times.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="time"
                    aria-label={`Reminder time ${i + 1}`}
                    className="rounded-xl border border-line bg-white px-3 py-2 text-lg"
                    value={t}
                    onChange={(e) => setTimeAt(i, e.target.value)}
                  />
                  {times.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setTimes((prev) => prev.filter((_, idx) => idx !== i))}
                      className="rounded-xl border border-line px-3 py-2 text-base font-bold hover:bg-mist"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setTimes((prev) => [...prev, "20:00"])}
                className="rounded-xl border border-line px-4 py-2 font-bold hover:bg-mist"
              >
                Add another time
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 font-bold">How long should it continue?</legend>
            <div className="flex flex-wrap items-center gap-2">
              {DAY_CHIPS.map((d) => (
                <button
                  key={d ?? "ongoing"}
                  type="button"
                  className={chip(days === d && customDays === "")}
                  onClick={() => {
                    setDays(d);
                    setCustomDays("");
                  }}
                >
                  {d === null ? "Ongoing" : `${d} days`}
                </button>
              ))}
              <label className="flex items-center gap-2">
                <span className="text-muted">or</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  inputMode="numeric"
                  placeholder="days"
                  aria-label="Number of days"
                  value={customDays}
                  onChange={(e) => onCustomDays(e.target.value)}
                  className="w-24 rounded-xl border border-line bg-white px-3 py-1.5 text-lg"
                />
              </label>
            </div>
            <p className="mt-2 text-muted">
              {days === null
                ? "Reminders continue every day until you delete the medicine."
                : `Reminders run for ${days} day${days === 1 ? "" : "s"}, starting today${
                    endLabel ? ` and ending ${endLabel}` : ""
                  }.`}
            </p>
          </fieldset>

          {error && (
            <p role="alert" className="font-bold text-missed">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-brand px-6 py-3 text-lg font-bold text-white transition hover:brightness-110 active:scale-95 disabled:opacity-60"
          >
            {saving ? "Saving medicine" : "Save medicine"}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function PatientPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading patient</p>}>
      <PatientContent />
    </Suspense>
  );
}
