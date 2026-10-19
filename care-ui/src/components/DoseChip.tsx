import { formatTime, type Dose, type DoseStatus } from "@/lib/api";

const STATUS: Record<DoseStatus, { label: string; glyph: string; pill: string; card: string }> = {
  taken: { label: "Taken", glyph: "✓", pill: "bg-taken-bg text-taken", card: "border-taken/25" },
  pending: { label: "Upcoming", glyph: "○", pill: "bg-mist text-muted", card: "border-line" },
  reminded: { label: "Reminder sent", glyph: "…", pill: "bg-due-bg text-due", card: "border-due/40 bg-due-bg/30" },
  missed: { label: "Missed", glyph: "!", pill: "bg-missed-bg text-missed", card: "border-missed/40 bg-missed-bg/30" },
  skipped: { label: "Skipped", glyph: "–", pill: "bg-mist text-muted", card: "border-line" },
};

interface Props {
  dose: Dose;
  onReply?: (doseId: number, action: "taken" | "skip") => void;
}

export default function DoseChip({ dose, onReply }: Props) {
  const s = STATUS[dose.status];
  const canReply = onReply && (dose.status === "reminded" || dose.status === "missed");
  return (
    <li className={`flex min-w-[220px] flex-col gap-2 rounded-2xl border bg-paper p-4 ${s.card}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-xl font-semibold">{formatTime(dose.scheduled_for)}</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${s.pill}`}>
          <span aria-hidden>{s.glyph}</span>
          {s.label}
        </span>
      </div>
      <p className="text-lg leading-snug">
        <span className="font-bold">{dose.medicine}</span>
        <span className="text-muted">, {dose.dosage}</span>
      </p>
      {canReply && (
        <div className="mt-1 flex gap-2">
          <button
            onClick={() => onReply(dose.id, "taken")}
            className="rounded-xl bg-taken px-4 py-2 text-base font-bold text-white transition hover:brightness-110 active:scale-95"
          >
            Mark taken
          </button>
          <button
            onClick={() => onReply(dose.id, "skip")}
            className="rounded-xl border border-line px-4 py-2 text-base font-bold text-muted transition hover:bg-mist active:scale-95"
          >
            Skip
          </button>
        </div>
      )}
    </li>
  );
}
