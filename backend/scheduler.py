"""
Background jobs for the Smart Elderly Care & Medicine Tracker (SIH26198).
Runs inside the FastAPI process, one pass every 30 seconds. No Celery or APScheduler needed.

Optional env vars:
    REMINDER_INTERVAL_MIN   minutes between reminders and before a dose counts as missed (default 10, use 1 for demos)
    MAX_REMINDERS           reminders sent before escalating (default 3)
"""

import asyncio
import os
import traceback

from twilio_sms import send_checkin, send_reminder, send_text

INTERVAL_MIN = int(os.environ.get("REMINDER_INTERVAL_MIN", "10"))
MAX_REMINDERS = int(os.environ.get("MAX_REMINDERS", "3"))
TICK_SECONDS = 30

GENERATE_DOSES = """
INSERT INTO dose_events (schedule_id, medicine_id, patient_id, scheduled_for)
SELECT s.id, m.id, p.id, (ld.d + s.time_of_day) AT TIME ZONE p.timezone
FROM medicine_schedules s
JOIN medicines m ON m.id = s.medicine_id AND m.active
JOIN patients  p ON p.id = m.patient_id  AND p.opted_in
CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE p.timezone)::date AS d) ld
WHERE m.start_date <= ld.d
  AND (m.end_date IS NULL OR m.end_date >= ld.d)
  AND EXTRACT(ISODOW FROM ld.d)::smallint = ANY (s.days_of_week)
ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
"""

# Pending doses older than 2 hours are ignored so a restart never floods old reminders.
DUE_REMINDERS = """
SELECT de.id AS dose_event_id, p.id AS patient_id, p.full_name, p.phone_whatsapp,
       m.name AS medicine, m.dosage, m.instructions
FROM dose_events de
JOIN patients p ON p.id = de.patient_id
JOIN medicines m ON m.id = de.medicine_id
WHERE m.active AND p.opted_in
  AND ((de.status = 'pending' AND de.scheduled_for <= now()
        AND de.scheduled_for > now() - interval '2 hours')
    OR (de.status = 'reminded' AND de.reminder_count < $2
        AND de.last_reminded_at <= now() - make_interval(mins => $1)))
ORDER BY de.scheduled_for
"""

MARK_REMINDED = """
UPDATE dose_events
SET status = 'reminded', reminder_count = reminder_count + 1, last_reminded_at = now()
WHERE id = $1
"""

ESCALATE = """
WITH missed AS (
    UPDATE dose_events SET status = 'missed'
    WHERE status = 'reminded'
      AND reminder_count >= $2
      AND last_reminded_at <= now() - make_interval(mins => $1)
    RETURNING id, patient_id, medicine_id
)
INSERT INTO alerts (patient_id, dose_event_id, type, message)
SELECT mi.patient_id, mi.id, 'missed_dose'::alert_type,
       p.full_name || ' missed ' || m.name || ' (' || m.dosage || ')'
FROM missed mi
JOIN patients p ON p.id = mi.patient_id
JOIN medicines m ON m.id = mi.medicine_id
"""

DUE_CHECKINS = """
SELECT p.id, p.full_name, p.phone_whatsapp
FROM patients p
WHERE p.opted_in
  AND (now() AT TIME ZONE p.timezone)::time >= p.checkin_time
  AND NOT EXISTS (
      SELECT 1 FROM checkins c
      WHERE c.patient_id = p.id
        AND c.sent_at >= (date_trunc('day', now() AT TIME ZONE p.timezone)) AT TIME ZONE p.timezone
  )
"""

NO_CHECKIN_ALERTS = """
INSERT INTO alerts (patient_id, type, message)
SELECT c.patient_id, 'no_checkin'::alert_type, p.full_name || ' has not replied to the morning check-in'
FROM checkins c
JOIN patients p ON p.id = c.patient_id
WHERE c.responded_at IS NULL
  AND c.sent_at <= now() - interval '2 hours'
  AND NOT EXISTS (
      SELECT 1 FROM alerts a
      WHERE a.patient_id = c.patient_id AND a.type = 'no_checkin' AND a.created_at >= c.sent_at
  )
"""

ALERTS_TO_SEND = """
SELECT id, patient_id, message FROM alerts
WHERE notified_at IS NULL AND resolved_at IS NULL
"""

CAREGIVERS_FOR_PATIENT = """
SELECT c.full_name, c.phone_whatsapp
FROM patient_caregivers pc
JOIN caregivers c ON c.id = pc.caregiver_id
WHERE pc.patient_id = $1 AND c.phone_whatsapp IS NOT NULL
ORDER BY pc.escalation_order
"""


async def _log_outbound(db, patient_id, wamid: str, body: str) -> None:
    await db.execute(
        "INSERT INTO message_log (patient_id, direction, provider_msg_id, body, status) "
        "VALUES ($1, 'outbound', $2, $3, 'sent')",
        patient_id, wamid, body,
    )


async def generate_today_doses(db) -> None:
    await db.execute(GENERATE_DOSES)


async def send_due_reminders(db) -> None:
    for r in await db.fetch(DUE_REMINDERS, INTERVAL_MIN, MAX_REMINDERS):
        try:
            wamid = await send_reminder(
                r["phone_whatsapp"], r["full_name"], r["medicine"], r["dosage"], r["instructions"]
            )
        except Exception as exc:
            print(f"Reminder failed for dose {r['dose_event_id']}: {exc}")
            continue
        await db.execute(MARK_REMINDED, r["dose_event_id"])
        await _log_outbound(db, r["patient_id"], wamid, f"Reminder: {r['medicine']} {r['dosage']}")


async def escalate_missed(db) -> None:
    await db.execute(ESCALATE, INTERVAL_MIN, MAX_REMINDERS)


async def send_due_checkins(db) -> None:
    for p in await db.fetch(DUE_CHECKINS):
        try:
            wamid = await send_checkin(p["phone_whatsapp"], p["full_name"])
        except Exception as exc:
            print(f"Check-in failed for patient {p['id']}: {exc}")
            continue
        await db.execute("INSERT INTO checkins (patient_id) VALUES ($1)", p["id"])
        await _log_outbound(db, p["id"], wamid, "Daily check-in")


async def alert_no_checkins(db) -> None:
    await db.execute(NO_CHECKIN_ALERTS)


async def notify_alerts(db) -> None:
    """Message every caregiver of the patient, in escalation order, once per alert."""
    for alert in await db.fetch(ALERTS_TO_SEND):
        for cg in await db.fetch(CAREGIVERS_FOR_PATIENT, alert["patient_id"]):
            try:
                await send_text(cg["phone_whatsapp"], f"Care alert: {alert['message']}")
            except Exception as exc:
                print(f"Could not alert {cg['full_name']}: {exc}")
        await db.execute("UPDATE alerts SET notified_at = now() WHERE id = $1", alert["id"])


async def run_forever(db) -> None:
    print(f"Scheduler started (interval {INTERVAL_MIN} min, max {MAX_REMINDERS} reminders)")
    while True:
        try:
            await generate_today_doses(db)
            await send_due_reminders(db)
            await escalate_missed(db)
            await send_due_checkins(db)
            await alert_no_checkins(db)
            await notify_alerts(db)
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(TICK_SECONDS)
