-- Smart Elderly Care & Medicine Tracker (SIH26198), schema and seed data
-- PostgreSQL 14+. Run once: psql -d elderly_care -f schema.sql

BEGIN;

CREATE TYPE dose_status AS ENUM ('pending', 'reminded', 'taken', 'missed', 'skipped');
CREATE TYPE alert_type  AS ENUM ('missed_dose', 'no_checkin', 'needs_help');
CREATE TYPE msg_direction AS ENUM ('outbound', 'inbound');

CREATE TABLE caregivers (
    id              BIGSERIAL PRIMARY KEY,
    full_name       TEXT NOT NULL,
    phone_whatsapp  TEXT NOT NULL UNIQUE,          -- E.164, e.g. +919876543210
    email           TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patients (
    id              BIGSERIAL PRIMARY KEY,
    full_name       TEXT NOT NULL,
    phone_whatsapp  TEXT NOT NULL UNIQUE,          -- E.164
    language        TEXT NOT NULL DEFAULT 'en',    -- en, hi, mr
    timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    checkin_time    TIME NOT NULL DEFAULT '09:00', -- daily "how are you" message
    opted_in        BOOLEAN NOT NULL DEFAULT false, -- true after they join / accept on WhatsApp
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patient_caregivers (
    patient_id       BIGINT NOT NULL REFERENCES patients(id)   ON DELETE CASCADE,
    caregiver_id     BIGINT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
    escalation_order SMALLINT NOT NULL DEFAULT 1,  -- 1 is alerted first
    PRIMARY KEY (patient_id, caregiver_id)
);

CREATE TABLE medicines (
    id            BIGSERIAL PRIMARY KEY,
    patient_id    BIGINT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    dosage        TEXT NOT NULL,                   -- "500 mg", "1 tablet"
    instructions  TEXT,                            -- "after breakfast"
    start_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date      DATE,
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE medicine_schedules (
    id           BIGSERIAL PRIMARY KEY,
    medicine_id  BIGINT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    time_of_day  TIME NOT NULL,                    -- patient local time
    days_of_week SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',  -- ISO: 1 Monday to 7 Sunday
    UNIQUE (medicine_id, time_of_day)
);

CREATE TABLE dose_events (
    id                BIGSERIAL PRIMARY KEY,
    schedule_id       BIGINT NOT NULL REFERENCES medicine_schedules(id) ON DELETE CASCADE,
    medicine_id       BIGINT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    patient_id        BIGINT NOT NULL REFERENCES patients(id)  ON DELETE CASCADE,
    scheduled_for     TIMESTAMPTZ NOT NULL,
    status            dose_status NOT NULL DEFAULT 'pending',
    reminder_count    SMALLINT NOT NULL DEFAULT 0,
    last_reminded_at  TIMESTAMPTZ,
    responded_at      TIMESTAMPTZ,
    UNIQUE (schedule_id, scheduled_for)            -- makes daily generation safe to re-run
);
CREATE INDEX idx_dose_open  ON dose_events (status, scheduled_for) WHERE status IN ('pending', 'reminded');
CREATE INDEX idx_dose_patient_time ON dose_events (patient_id, scheduled_for);

CREATE TABLE checkins (
    id           BIGSERIAL PRIMARY KEY,
    patient_id   BIGINT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    response     TEXT,                             -- "GOOD", "OKAY", "HELP"
    responded_at TIMESTAMPTZ
);
CREATE INDEX idx_checkins_patient ON checkins (patient_id, sent_at DESC);

CREATE TABLE alerts (
    id            BIGSERIAL PRIMARY KEY,
    patient_id    BIGINT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    dose_event_id BIGINT REFERENCES dose_events(id) ON DELETE SET NULL,
    type          alert_type NOT NULL,
    message       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at   TIMESTAMPTZ,                     -- when caregivers were messaged
    resolved_at   TIMESTAMPTZ
);
CREATE INDEX idx_alerts_open ON alerts (patient_id) WHERE resolved_at IS NULL;

CREATE TABLE message_log (
    id          BIGSERIAL PRIMARY KEY,
    patient_id  BIGINT REFERENCES patients(id) ON DELETE SET NULL,
    direction   msg_direction NOT NULL,
    provider_msg_id  TEXT,
    body        TEXT,
    status      TEXT,                              -- queued, sent, delivered, read, failed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_msglog_sid ON message_log (provider_msg_id);

COMMIT;


-- ---------------------------------------------------------------------------
-- SEED DATA (optional, for testing)
-- ---------------------------------------------------------------------------
INSERT INTO caregivers (full_name, phone_whatsapp) VALUES ('Adi', '+919999999999');
INSERT INTO patients (full_name, phone_whatsapp, opted_in) VALUES ('Sunita Deshmukh', '+918888888888', true);
INSERT INTO patient_caregivers (patient_id, caregiver_id) VALUES (1, 1);
INSERT INTO medicines (patient_id, name, dosage, instructions) VALUES (1, 'Metformin', '500 mg', 'After breakfast');
INSERT INTO medicine_schedules (medicine_id, time_of_day) VALUES (1, '08:30'), (1, '20:30');

