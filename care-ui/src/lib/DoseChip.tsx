import { formatTime, type Dose, type DoseStatus } from "@/lib/api";

const STATUS: Record<DoseStatus, { label: string; cls: string }> = {
  taken: { label: "Taken", cls: "bg-taken-bg text-taken" },
  pending: { label: "Upcoming", cls: "bg-paper text-muted border border-line" },
  reminded: { label: "Reminder sent", cls: "bg-due-bg text-due" },
  missed: { label: "Missed", cls: "bg-missed-bg text-missed" },
  skipped: { label: "Skipped", cls: "bg-paper text-muted border border-line" },
};

interface Props {
  dose: Dose;
  onReply?: (doseId: number, action: "taken" | "skip") => void;
}

export default function DoseChip({ dose, onReply }: Props) {
  const s = STATUS[dose.status];
  const canReply = onReply && (dose.status === "reminded" || dose.status === "missed");
  return (
    <li className={`rounded-xl px-4 py-2 ${s.cls}`}>
      <p className="text-base font-bold leading-tight">{formatTime(dose.scheduled_for)}</p>
      <p className="text-base leading-tight">
        {dose.medicine}, {dose.dosage}
      </p>
      <p className="text-sm font-bold leading-tight">{s.label}</p>
      {canReply && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onReply(dose.id, "taken")}
            className="rounded-lg bg-ink px-3 py-1 text-sm font-bold text-paper hover:opacity-90"
          >
            Mark taken
          </button>
          <button
            onClick={() => onReply(dose.id, "skip")}
            className="rounded-lg border border-current px-3 py-1 text-sm font-bold hover:bg-white/60"
          >
            Skip
          </button>
        </div>
      )}
    </li>
  );
}
