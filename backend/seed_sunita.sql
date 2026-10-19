-- Stock data for Sunita Deshmukh (SIH26198).
-- Run:  psql -d elderly_care -f seed_sunita.sql
--
-- This REPLACES Sunita's current medicines, doses, check-ins, alerts and message log with a
-- realistic set: 5 medicines (one is a 30 day course), 14 days of dose history, daily
-- check-ins and a few resolved alerts. Safe to run again, it starts from a clean slate each time.
-- Today's doses that are still in the future are left for the scheduler to create and send.

\set ON_ERROR_STOP on

-- Older databases still have the Twilio column name. Rename it once if needed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'message_log' AND column_name = 'twilio_sid') THEN
    ALTER TABLE message_log RENAME COLUMN twilio_sid TO provider_msg_id;
  END IF;
END $$;

SELECT id AS pid FROM patients WHERE full_name ILIKE 'sunita%' ORDER BY id LIMIT 1 \gset

BEGIN;

-- 1. Clean slate for this patient (medicine_schedules go with their medicines)
DELETE FROM alerts      WHERE patient_id = :pid;
DELETE FROM message_log WHERE patient_id = :pid;
DELETE FROM checkins    WHERE patient_id = :pid;
DELETE FROM dose_events WHERE patient_id = :pid;
DELETE FROM medicines   WHERE patient_id = :pid;

-- 2. Medicines and their daily times
CREATE TEMP TABLE seed_meds (
  name text, dosage text, instructions text, start_off int, end_off int, times text[]
) ON COMMIT DROP;

INSERT INTO seed_meds VALUES
  ('Thyroxine',    '50 mcg',    'Empty stomach, 30 minutes before breakfast', -45, NULL, '{06:30}'),
  ('Metformin',    '500 mg',    'After meals',                                -60, NULL, '{08:30,20:30}'),
  ('Amlodipine',   '5 mg',      'For blood pressure',                         -60, NULL, '{09:00}'),
  ('Vitamin D3',   '1 capsule', 'With lunch. 30 day course',                   -9,   20, '{13:00}'),
  ('Atorvastatin', '10 mg',     'At bedtime',                                 -60, NULL, '{21:00}');

WITH ins AS (
  INSERT INTO medicines (patient_id, name, dosage, instructions, start_date, end_date)
  SELECT :pid, sm.name, sm.dosage, sm.instructions,
         t.d + sm.start_off,
         CASE WHEN sm.end_off IS NULL THEN NULL ELSE t.d + sm.end_off END
  FROM seed_meds sm
  CROSS JOIN (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d) t
  RETURNING id, name
)
INSERT INTO medicine_schedules (medicine_id, time_of_day)
SELECT ins.id, unnest(sm.times)::time
FROM ins JOIN seed_meds sm ON sm.name = ins.name;

-- 3. Fourteen days of dose history: about 86% taken, 8% missed, 6% skipped
INSERT INTO dose_events
  (schedule_id, medicine_id, patient_id, scheduled_for, status, reminder_count, last_reminded_at, responded_at)
SELECT s.id, m.id, m.patient_id, x.sched, x.status::dose_status, x.rc,
       x.sched + make_interval(mins => (x.rc - 1) * 10),
       CASE x.status
         WHEN 'taken'   THEN x.sched + make_interval(mins => 2 + x.r % 20 + (x.rc - 1) * 10)
         WHEN 'skipped' THEN x.sched + make_interval(mins => 4)
         ELSE NULL
       END
FROM medicine_schedules s
JOIN medicines m ON m.id = s.medicine_id AND m.patient_id = :pid
JOIN patients  p ON p.id = m.patient_id
CROSS JOIN LATERAL generate_series(
    ((now() AT TIME ZONE p.timezone)::date - 14)::timestamp,
    ((now() AT TIME ZONE p.timezone)::date - 1)::timestamp,
    interval '1 day') AS g(day)
CROSS JOIN LATERAL (
    SELECT (g.day::date + s.time_of_day) AT TIME ZONE p.timezone AS sched,
           abs(hashtext(s.id::text || g.day::text)) % 100 AS r
) y
CROSS JOIN LATERAL (
    SELECT y.sched, y.r,
           CASE WHEN y.r < 86 THEN 'taken' WHEN y.r < 94 THEN 'missed' ELSE 'skipped' END AS status,
           CASE WHEN y.r < 86 THEN 1 + (y.r % 5 = 0)::int WHEN y.r < 94 THEN 3 ELSE 1 END AS rc
) x
WHERE g.day::date >= m.start_date
  AND g.day::date <= COALESCE(m.end_date, g.day::date)
ON CONFLICT (schedule_id, scheduled_for) DO NOTHING;

-- 4. Today's doses whose time has already passed count as taken
INSERT INTO dose_events
  (schedule_id, medicine_id, patient_id, scheduled_for, status, reminder_count, last_reminded_at, responded_at)
SELECT s.id, m.id, m.patient_id, y.sched, 'taken'::dose_status, 1, y.sched,
       y.sched + make_interval(mins => 3 + y.r % 10)
FROM medicine_schedules s
JOIN medicines m ON m.id = s.medicine_id AND m.patient_id = :pid
JOIN patients  p ON p.id = m.patient_id
CROSS JOIN LATERAL (
    SELECT (((now() AT TIME ZONE p.timezone)::date) + s.time_of_day) AT TIME ZONE p.timezone AS sched,
           abs(hashtext(s.id::text || 'today')) % 100 AS r
) y
WHERE y.sched < now() - interval '15 minutes'
  AND (now() AT TIME ZONE p.timezone)::date >= m.start_date
  AND (m.end_date IS NULL OR m.end_date >= (now() AT TIME ZONE p.timezone)::date)
ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
  SET status = EXCLUDED.status, reminder_count = EXCLUDED.reminder_count,
      last_reminded_at = EXCLUDED.last_reminded_at, responded_at = EXCLUDED.responded_at;

-- 5. Daily check-ins, every one answered
INSERT INTO checkins (patient_id, sent_at, response, responded_at)
SELECT p.id, y.sent,
       CASE WHEN y.r < 80 THEN 'GOOD' ELSE 'OKAY' END,
       y.sent + make_interval(mins => 3 + y.r % 40)
FROM patients p
CROSS JOIN LATERAL generate_series(
    ((now() AT TIME ZONE p.timezone)::date - 14)::timestamp,
    ((now() AT TIME ZONE p.timezone)::date)::timestamp,
    interval '1 day') AS g(day)
CROSS JOIN LATERAL (
    SELECT (g.day::date + p.checkin_time) AT TIME ZONE p.timezone AS sent,
           abs(hashtext('c' || g.day::text)) % 100 AS r
) y
WHERE p.id = :pid
  AND y.sent + make_interval(mins => 3 + y.r % 40) < now();

-- 6. Alert history, all resolved: one per missed dose plus one help request
INSERT INTO alerts (patient_id, dose_event_id, type, message, created_at, notified_at, resolved_at)
SELECT de.patient_id, de.id, 'missed_dose'::alert_type,
       p.full_name || ' missed ' || m.name || ' (' || m.dosage || ')',
       de.last_reminded_at + interval '10 minutes',
       de.last_reminded_at + interval '10 minutes 20 seconds',
       de.last_reminded_at + interval '3 hours'
FROM dose_events de
JOIN patients  p ON p.id = de.patient_id
JOIN medicines m ON m.id = de.medicine_id
WHERE de.patient_id = :pid AND de.status = 'missed';

INSERT INTO alerts (patient_id, type, message, created_at, notified_at, resolved_at)
SELECT p.id, 'needs_help'::alert_type, p.full_name || ' asked for help',
       now() - interval '4 days 3 hours',
       now() - interval '4 days 3 hours' + interval '15 seconds',
       now() - interval '4 days 2 hours'
FROM patients p WHERE p.id = :pid;

-- 7. Message log: every reminder sent and every reply received
INSERT INTO message_log (patient_id, direction, provider_msg_id, body, status, created_at)
SELECT de.patient_id, 'outbound'::msg_direction, 'seed-out-' || de.id,
       'Reminder: ' || m.name || ' ' || m.dosage, 'delivered', de.scheduled_for
FROM dose_events de JOIN medicines m ON m.id = de.medicine_id
WHERE de.patient_id = :pid
UNION ALL
SELECT de.patient_id, 'inbound'::msg_direction, 'seed-in-' || de.id,
       CASE de.status WHEN 'taken' THEN 'TAKEN' ELSE 'SKIP' END, 'received', de.responded_at
FROM dose_events de
WHERE de.patient_id = :pid AND de.responded_at IS NOT NULL;

COMMIT;

-- Summary
\echo
\echo 'Medicines'
SELECT m.name, m.dosage, to_char(m.end_date, 'DD Mon') AS ends,
       string_agg(to_char(s.time_of_day, 'HH24:MI'), ', ' ORDER BY s.time_of_day) AS times
FROM medicines m JOIN medicine_schedules s ON s.medicine_id = m.id
WHERE m.patient_id = :pid GROUP BY m.id ORDER BY m.name;

\echo 'Dose history by status'
SELECT status, COUNT(*) FROM dose_events WHERE patient_id = :pid GROUP BY status ORDER BY status;

\echo 'Rows added'
SELECT (SELECT COUNT(*) FROM dose_events WHERE patient_id = :pid) AS doses,
       (SELECT COUNT(*) FROM checkins    WHERE patient_id = :pid) AS checkins,
       (SELECT COUNT(*) FROM alerts      WHERE patient_id = :pid) AS alerts,
       (SELECT COUNT(*) FROM message_log WHERE patient_id = :pid) AS messages;
