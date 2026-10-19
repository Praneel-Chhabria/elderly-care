"use client";

import { useEffect, useState } from "react";
import { formatTime, type Dose, type DoseStatus } from "@/lib/api";

const MARKER: Record<DoseStatus, string> = {
  taken: "border-taken bg-taken text-white",
  missed: "border-missed bg-missed text-white",
  reminded: "border-due bg-due text-white",
  pending: "border-brand bg-paper text-brand",
  skipped: "border-line bg-mist text-muted",
};
const GLYPH: Record<DoseStatus, string> = { taken: "✓", missed: "!", reminded: "…", pending: "", skipped: "–" };
const LABEL: Record<DoseStatus, string> = {
  taken: "Taken",
  missed: "Missed",
  reminded: "Reminder sent",
  pending: "Upcoming",
  skipped: "Skipped",
};

const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};
const hourLabel = (h: number) => (h === 12 ? "12 pm" : h > 12 ? `${h - 12} pm` : `${h} am`);

/** A horizontal day ribbon. Each dose sits at its time, coloured by status, with a Now marker. */
export function DayTimeline({ doses }: { doses: Dose[] }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const mins = doses.map((d) => minutesOf(d.scheduled_for));
  const start = Math.min(6 * 60, ...mins.map((m) => Math.floor(m / 60) * 60));
  const end = Math.max(22 * 60, ...mins.map((m) => Math.ceil((m + 1) / 60) * 60));
  const pos = (m: number) => Math.min(100, Math.max(0, ((m - start) / (end - start)) * 100));

  const ticks: number[] = [];
  for (let h = start / 60; h <= end / 60; h += 3) ticks.push(h);

  // Place markers in lanes so close doses never overlap.
  const lastPos: number[] = [];
  const placed = [...doses]
    .sort((a, b) => minutesOf(a.scheduled_for) - minutesOf(b.scheduled_for))
    .map((d) => {
      const p = pos(minutesOf(d.scheduled_for));
      let lane = lastPos.findIndex((lp) => p - lp >= 5);
      if (lane === -1) {
        lane = lastPos.length;
        lastPos.push(p);
      } else {
        lastPos[lane] = p;
      }
      return { d, p, lane };
    });
  const lanes = Math.max(1, lastPos.length);
  const trackHeight = lanes * 38;

  let nowPos: number | null = null;
  if (now !== null) {
    const nd = new Date(now);
    const nm = nd.getHours() * 60 + nd.getMinutes();
    if (nm >= start && nm <= end) nowPos = pos(nm);
  }

  return (
    <div className="mx-4" aria-label="Today's doses on a timeline">
      <div className="relative" style={{ height: trackHeight + 30 }}>
        {ticks.map((h) => (
          <div key={h}>
            <div
              className="absolute top-0 border-l border-dashed border-line"
              style={{ left: `${pos(h * 60)}%`, height: trackHeight }}
            />
            <span
              className="absolute bottom-0 -translate-x-1/2 text-sm text-muted"
              style={{ left: `${pos(h * 60)}%` }}
            >
              {hourLabel(h)}
            </span>
          </div>
        ))}

        {nowPos !== null && (
          <div className="absolute top-0 w-0.5 bg-brand" style={{ left: `${nowPos}%`, height: trackHeight }}>
            <span className="absolute -top-0.5 left-1 rounded-full bg-brand px-2 text-xs font-bold text-white">
              Now
            </span>
          </div>
        )}

        {placed.map(({ d, p, lane }) => (
          <div
            key={d.id}
            title={`${formatTime(d.scheduled_for)}  ${d.medicine} ${d.dosage}  ${LABEL[d.status]}`}
            className={`absolute grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border-2 text-sm font-bold shadow-sm ${MARKER[d.status]}`}
            style={{ left: `${p}%`, top: lane * 38 + 2 }}
          >
            {GLYPH[d.status]}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Circular progress for doses taken today. Red if anything was missed. */
export function Ring({
  taken,
  total,
  missed = 0,
  size = 64,
}: {
  taken: number;
  total: number;
  missed?: number;
  size?: number;
}) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total === 0 ? 0 : Math.min(1, taken / total);
  const color =
    missed > 0 ? "var(--color-missed)" : total > 0 && taken === total ? "var(--color-taken)" : "var(--color-brand)";
  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${taken} of ${total} doses taken`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-mist)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
      </svg>
      <span className="absolute text-sm font-bold">{total === 0 ? "–" : `${taken}/${total}`}</span>
    </div>
  );
}
