-- Queries used by the backend (SIH26198). $1, $2 are asyncpg style parameters.
-- This file is a reference to copy from. Do not run it as a script.

-- ---------------------------------------------------------------------------

-- Q1. Generate today's dose events (run at 00:05 daily, and on startup). Safe to re-run.
INSERT INTO dose_events (schedule_id, medicine_id, patient_id, scheduled_for)
SELECT s.id, m.id, p.id, (ld.d + s.time_of_day) AT TIME ZONE p.timezone
FROM medicine_schedules s
JOIN medicines m ON m.id = s.medicine_id AND m.active
JOIN patients  p ON p.id = m.patient_id  AND p.opted_in
CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE p.timezone)::date AS d) ld
WHERE m.start_date <= ld.d
  AND (m.end_date IS NULL OR m.end_date >= ld.d)
  AND EXTRACT(ISODOW FROM ld.d)::smallint = ANY (s.days_of_week)
ON CONFLICT (schedule_id, scheduled_for) DO NOTHING;


-- Q2. Doses that need a WhatsApp reminder now (run every minute).
-- First reminder at the scheduled time, then repeat every 10 minutes, up to 3 reminders.
SELECT de.id AS dose_event_id, p.id AS patient_id, p.full_name, p.phone_whatsapp,
       m.name AS medicine, m.dosage, m.instructions, de.reminder_count
FROM dose_events de
JOIN patients p ON p.id = de.patient_id
JOIN medicines m ON m.id = de.medicine_id
WHERE (de.status = 'pending'  AND de.scheduled_for <= now())
   OR (de.status = 'reminded' AND de.reminder_count < 3
       AND de.last_reminded_at <= now() - interval '10 minutes')
ORDER BY de.scheduled_for;

-- Q2b. After the reminder is sent.
UPDATE dose_events
SET status = 'reminded', reminder_count = reminder_count + 1, last_reminded_at = now()
WHERE id = $1;


-- Q3. Patient replies TAKEN (or 1). Marks their most recent reminded dose.
UPDATE dose_events
SET status = 'taken', responded_at = now()
WHERE id = (
    SELECT de.id
    FROM dose_events de
    JOIN patients p ON p.id = de.patient_id
    WHERE p.phone_whatsapp = $1 AND de.status = 'reminded'
    ORDER BY de.scheduled_for DESC
    LIMIT 1
)
RETURNING id;

-- Q3b. Patient replies SKIP (or 2).
UPDATE dose_events
SET status = 'skipped', responded_at = now()
WHERE id = (
    SELECT de.id
    FROM dose_events de
    JOIN patients p ON p.id = de.patient_id
    WHERE p.phone_whatsapp = $1 AND de.status = 'reminded'
    ORDER BY de.scheduled_for DESC
    LIMIT 1
)
RETURNING id;


-- Q4. Escalation: mark unanswered doses as missed and raise alerts (run every minute).
WITH missed AS (
    UPDATE dose_events
    SET status = 'missed'
    WHERE status = 'reminded'
      AND reminder_count >= 3
      AND last_reminded_at <= now() - interval '10 minutes'
    RETURNING id, patient_id, medicine_id, scheduled_for
)
INSERT INTO alerts (patient_id, dose_event_id, type, message)
SELECT mi.patient_id, mi.id, 'missed_dose',
       p.full_name || ' missed ' || m.name || ' (' || m.dosage || ')'
FROM missed mi
JOIN patients p ON p.id = mi.patient_id
JOIN medicines m ON m.id = mi.medicine_id
RETURNING id, patient_id, message;

-- Q4b. Caregivers to message for an alert, in escalation order.
SELECT c.full_name, c.phone_whatsapp
FROM patient_caregivers pc
JOIN caregivers c ON c.id = pc.caregiver_id
WHERE pc.patient_id = $1
ORDER BY pc.escalation_order;

-- Q4c. After caregivers are messaged.
UPDATE alerts SET notified_at = now() WHERE id = $1;


-- Q5. Daily check-in: patients due for the "how are you" message (run every minute).
SELECT p.id, p.full_name, p.phone_whatsapp
FROM patients p
WHERE p.opted_in
  AND (now() AT TIME ZONE p.timezone)::time >= p.checkin_time
  AND NOT EXISTS (
      SELECT 1 FROM checkins c
      WHERE c.patient_id = p.id
        AND c.sent_at >= (date_trunc('day', now() AT TIME ZONE p.timezone)) AT TIME ZONE p.timezone
  );

-- Q5b. Record check-in sent, then the reply.
INSERT INTO checkins (patient_id) VALUES ($1) RETURNING id;

UPDATE checkins
SET response = $2, responded_at = now()
WHERE id = (
    SELECT c.id FROM checkins c
    JOIN patients p ON p.id = c.patient_id
    WHERE p.phone_whatsapp = $1 AND c.responded_at IS NULL
    ORDER BY c.sent_at DESC LIMIT 1
)
RETURNING patient_id;

-- Q5c. No check-in reply after 2 hours raises an alert.
INSERT INTO alerts (patient_id, type, message)
SELECT c.patient_id, 'no_checkin', p.full_name || ' has not replied to the morning check-in'
FROM checkins c
JOIN patients p ON p.id = c.patient_id
WHERE c.responded_at IS NULL
  AND c.sent_at <= now() - interval '2 hours'
  AND NOT EXISTS (
      SELECT 1 FROM alerts a
      WHERE a.patient_id = c.patient_id AND a.type = 'no_checkin'
        AND a.created_at >= c.sent_at
  );


-- Q6. Dashboard: today's summary per patient for one caregiver.
SELECT p.id, p.full_name,
       COUNT(*) FILTER (WHERE de.status = 'taken')                   AS taken,
       COUNT(*) FILTER (WHERE de.status IN ('pending', 'reminded'))  AS pending,
       COUNT(*) FILTER (WHERE de.status = 'missed')                  AS missed,
       COUNT(de.id)                                                  AS total,
       (SELECT MAX(c.responded_at) FROM checkins c WHERE c.patient_id = p.id) AS last_checkin
FROM patients p
JOIN patient_caregivers pc ON pc.patient_id = p.id AND pc.caregiver_id = $1
LEFT JOIN dose_events de
       ON de.patient_id = p.id
      AND de.scheduled_for >= (date_trunc('day', now() AT TIME ZONE p.timezone)) AT TIME ZONE p.timezone
      AND de.scheduled_for <  (date_trunc('day', now() AT TIME ZONE p.timezone) + interval '1 day') AT TIME ZONE p.timezone
GROUP BY p.id, p.full_name
ORDER BY p.full_name;

-- Q6b. Today's individual doses for a patient (the strip on the dashboard).
SELECT de.id, m.name AS medicine, m.dosage, de.scheduled_for, de.status
FROM dose_events de
JOIN medicines m ON m.id = de.medicine_id
JOIN patients  p ON p.id = de.patient_id
WHERE de.patient_id = $1
  AND de.scheduled_for >= (date_trunc('day', now() AT TIME ZONE p.timezone)) AT TIME ZONE p.timezone
  AND de.scheduled_for <  (date_trunc('day', now() AT TIME ZONE p.timezone) + interval '1 day') AT TIME ZONE p.timezone
ORDER BY de.scheduled_for;


-- Q7. Open alerts for a caregiver.
SELECT a.id, a.patient_id, p.full_name AS patient_name, a.type, a.message, a.created_at
FROM alerts a
JOIN patients p ON p.id = a.patient_id
JOIN patient_caregivers pc ON pc.patient_id = p.id AND pc.caregiver_id = $1
WHERE a.resolved_at IS NULL
ORDER BY a.created_at DESC;

-- Q7b. Resolve an alert.
UPDATE alerts SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL;


-- Q8. Seven day adherence for one patient.
SELECT to_char(day::date, 'Dy')                                   AS day,
       COUNT(de.id) FILTER (WHERE de.status = 'taken')            AS taken,
       COUNT(de.id) FILTER (WHERE de.status IN ('taken', 'missed', 'skipped')) AS total
FROM generate_series(current_date - 6, current_date, interval '1 day') AS day
LEFT JOIN dose_events de
       ON de.patient_id = $1
      AND (de.scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = day::date
GROUP BY day
ORDER BY day;


-- Q9. Patient detail: medicines with their times.
SELECT m.id, m.name, m.dosage, m.instructions,
       array_agg(to_char(s.time_of_day, 'HH24:MI') ORDER BY s.time_of_day) AS times
FROM medicines m
JOIN medicine_schedules s ON s.medicine_id = m.id
WHERE m.patient_id = $1 AND m.active
GROUP BY m.id
ORDER BY m.name;

-- Q9b. Add a medicine (run both in one transaction).
INSERT INTO medicines (patient_id, name, dosage, instructions) VALUES ($1, $2, $3, $4) RETURNING id;
INSERT INTO medicine_schedules (medicine_id, time_of_day) SELECT $1, unnest($2::time[]);


-- Q10. Log messages and update delivery status from Twilio callbacks.
INSERT INTO message_log (patient_id, direction, provider_msg_id, body, status)
VALUES ($1, $2, $3, $4, $5);

UPDATE message_log SET status = $2 WHERE provider_msg_id = $1;
