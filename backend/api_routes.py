"""
REST routes for the Next.js dashboard. Every route needs a signed in user (see auth.py).
Caregivers only see patients assigned to them. Admins see and control everything.
"""

import re
from datetime import time as dtime
from typing import List, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import admin_user, current_user, hash_password
from scheduler import generate_today_doses

router = APIRouter(prefix="/api")

DAY_START = "(date_trunc('day', now() AT TIME ZONE p.timezone)) AT TIME ZONE p.timezone"
DAY_END = "(date_trunc('day', now() AT TIME ZONE p.timezone) + interval '1 day') AT TIME ZONE p.timezone"
VISIBLE = "($1::boolean OR EXISTS (SELECT 1 FROM patient_caregivers pc WHERE pc.patient_id = p.id AND pc.caregiver_id = $2))"

SUMMARY = f"""
SELECT p.id, p.full_name,
       COUNT(*) FILTER (WHERE de.status = 'taken')                  AS taken,
       COUNT(*) FILTER (WHERE de.status IN ('pending', 'reminded')) AS pending,
       COUNT(*) FILTER (WHERE de.status = 'missed')                 AS missed,
       COUNT(de.id)                                                 AS total,
       (SELECT MAX(c.responded_at) FROM checkins c WHERE c.patient_id = p.id) AS last_checkin
FROM patients p
LEFT JOIN dose_events de
       ON de.patient_id = p.id
      AND de.scheduled_for >= {DAY_START}
      AND de.scheduled_for <  {DAY_END}
WHERE {VISIBLE}
GROUP BY p.id, p.full_name
ORDER BY p.full_name
"""

TODAY_DOSES = f"""
SELECT de.id, m.name AS medicine, m.dosage, de.scheduled_for, de.status
FROM dose_events de
JOIN medicines m ON m.id = de.medicine_id
JOIN patients  p ON p.id = de.patient_id
WHERE de.patient_id = $1
  AND de.scheduled_for >= {DAY_START}
  AND de.scheduled_for <  {DAY_END}
ORDER BY de.scheduled_for
"""

OPEN_ALERTS = f"""
SELECT a.id, a.patient_id, p.full_name AS patient_name, a.type, a.message, a.created_at
FROM alerts a
JOIN patients p ON p.id = a.patient_id
WHERE a.resolved_at IS NULL AND {VISIBLE}
ORDER BY a.created_at DESC
"""

ADHERENCE = """
SELECT to_char(g.d::date, 'Dy') AS day,
       COUNT(de.id) FILTER (WHERE de.status = 'taken') AS taken,
       COUNT(de.id) FILTER (WHERE de.status IN ('taken', 'missed', 'skipped')) AS total
FROM generate_series(
        (now() AT TIME ZONE 'Asia/Kolkata')::date - 6,
        (now() AT TIME ZONE 'Asia/Kolkata')::date,
        interval '1 day') AS g(d)
LEFT JOIN dose_events de
       ON de.patient_id = $1
      AND (de.scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = g.d::date
GROUP BY g.d
ORDER BY g.d
"""

# Courses that have ended drop off the list automatically.
MEDICINES = """
SELECT m.id, m.name, m.dosage, m.instructions,
       to_char(m.end_date, 'YYYY-MM-DD') AS end_date,
       array_agg(to_char(s.time_of_day, 'HH24:MI') ORDER BY s.time_of_day) AS times
FROM medicines m
JOIN medicine_schedules s ON s.medicine_id = m.id
WHERE m.patient_id = $1 AND m.active
  AND (m.end_date IS NULL OR m.end_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
GROUP BY m.id
ORDER BY m.name
"""

ADMIN_PATIENTS = f"""
SELECT p.id, p.full_name, p.phone_whatsapp AS chat_id, p.opted_in,
       to_char(p.checkin_time, 'HH24:MI') AS checkin_time,
       (SELECT COUNT(*) FROM dose_events de WHERE de.patient_id = p.id AND de.status = 'taken'
          AND de.scheduled_for >= {DAY_START} AND de.scheduled_for < {DAY_END}) AS taken,
       (SELECT COUNT(*) FROM dose_events de WHERE de.patient_id = p.id
          AND de.scheduled_for >= {DAY_START} AND de.scheduled_for < {DAY_END}) AS total,
       (SELECT COUNT(*) FROM dose_events de WHERE de.patient_id = p.id AND de.status = 'missed'
          AND de.scheduled_for >= {DAY_START} AND de.scheduled_for < {DAY_END}) AS missed,
       (SELECT COUNT(*) FROM alerts a WHERE a.patient_id = p.id AND a.resolved_at IS NULL) AS open_alerts,
       COALESCE((SELECT array_agg(pc.caregiver_id ORDER BY pc.escalation_order)
                 FROM patient_caregivers pc WHERE pc.patient_id = p.id), '{{}}') AS caregiver_ids
FROM patients p
ORDER BY p.full_name
"""


def _is_admin(user: dict) -> bool:
    return user["role"] == "admin"


async def _patient(db, user: dict, patient_id: int):
    row = await db.fetchrow(
        f"SELECT p.id, p.full_name, p.phone_whatsapp FROM patients p WHERE p.id = $3 AND {VISIBLE}",
        _is_admin(user), user["id"], patient_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return row


def _parse_time(value: str) -> dtime:
    try:
        return dtime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="Times must look like 08:30")


# ---------------------------------------------------------------------------
# Caregiver and admin: monitoring
# ---------------------------------------------------------------------------

@router.get("/dashboard")
async def dashboard(request: Request, user: dict = Depends(current_user)):
    db = request.app.state.db
    patients = []
    for r in await db.fetch(SUMMARY, _is_admin(user), user["id"]):
        doses = await db.fetch(TODAY_DOSES, r["id"])
        patients.append({**dict(r), "doses": [dict(d) for d in doses]})
    alerts = await db.fetch(OPEN_ALERTS, _is_admin(user), user["id"])
    return {"patients": patients, "alerts": [dict(a) for a in alerts]}


@router.get("/patients/{patient_id}")
async def patient_detail(patient_id: int, request: Request, user: dict = Depends(current_user)):
    db = request.app.state.db
    patient = await _patient(db, user, patient_id)
    return {
        **dict(patient),
        "doses": [dict(d) for d in await db.fetch(TODAY_DOSES, patient_id)],
        "medicines": [dict(m) for m in await db.fetch(MEDICINES, patient_id)],
        "adherence_7d": [dict(a) for a in await db.fetch(ADHERENCE, patient_id)],
    }


class NewMedicine(BaseModel):
    name: str
    dosage: str
    instructions: str = ""
    times: List[str]
    days: Optional[int] = None  # None means ongoing


@router.post("/patients/{patient_id}/medicines")
async def add_medicine(patient_id: int, body: NewMedicine, request: Request, user: dict = Depends(current_user)):
    db = request.app.state.db
    await _patient(db, user, patient_id)
    times = sorted({_parse_time(t) for t in body.times})
    if not times:
        raise HTTPException(status_code=400, detail="Add at least one time")
    if body.days is not None and not 1 <= body.days <= 365:
        raise HTTPException(status_code=400, detail="Days must be between 1 and 365")

    instructions = body.instructions.strip() or None
    async with db.acquire() as conn:
        async with conn.transaction():
            med = await conn.fetchrow(
                """
                INSERT INTO medicines (patient_id, name, dosage, instructions, start_date, end_date)
                SELECT $1, $2, $3, $4, t.d, CASE WHEN $5::int IS NULL THEN NULL ELSE t.d + ($5::int - 1) END
                FROM (SELECT (now() AT TIME ZONE p.timezone)::date AS d FROM patients p WHERE p.id = $1) t
                RETURNING id, to_char(end_date, 'YYYY-MM-DD') AS end_date
                """,
                patient_id, body.name.strip(), body.dosage.strip(), instructions, body.days,
            )
            await conn.execute(
                "INSERT INTO medicine_schedules (medicine_id, time_of_day) SELECT $1, unnest($2::time[])",
                med["id"], times,
            )
    await generate_today_doses(db)  # so today's doses appear straight away
    return {
        "id": med["id"],
        "name": body.name.strip(),
        "dosage": body.dosage.strip(),
        "instructions": instructions,
        "end_date": med["end_date"],
        "times": [t.strftime("%H:%M") for t in times],
    }


@router.delete("/patients/{patient_id}/medicines/{medicine_id}", status_code=204)
async def delete_medicine(patient_id: int, medicine_id: int, request: Request, user: dict = Depends(current_user)):
    """Stops the medicine for good. Doses already taken or missed stay in the history."""
    db = request.app.state.db
    await _patient(db, user, patient_id)
    async with db.acquire() as conn:
        async with conn.transaction():
            result = await conn.execute(
                "UPDATE medicines SET active = false WHERE id = $1 AND patient_id = $2 AND active",
                medicine_id, patient_id,
            )
            if result == "UPDATE 0":
                raise HTTPException(status_code=404, detail="Medicine not found")
            await conn.execute(
                "DELETE FROM dose_events WHERE medicine_id = $1 AND status IN ('pending', 'reminded')",
                medicine_id,
            )


class DoseReply(BaseModel):
    action: str  # "taken" or "skip"


@router.post("/doses/{dose_id}/reply")
async def reply_to_dose(dose_id: int, body: DoseReply, request: Request, user: dict = Depends(current_user)):
    """Same database change as a patient's reply. Used by the dashboard buttons."""
    status = {"taken": "taken", "skip": "skipped"}.get(body.action)
    if status is None:
        raise HTTPException(status_code=400, detail="action must be taken or skip")
    result = await request.app.state.db.execute(
        "UPDATE dose_events SET status = $2::dose_status, responded_at = now() "
        "WHERE id = $1 AND status IN ('pending', 'reminded', 'missed') "
        "AND ($3::boolean OR patient_id IN (SELECT patient_id FROM patient_caregivers WHERE caregiver_id = $4))",
        dose_id, status, _is_admin(user), user["id"],
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Dose not found or already answered")
    return {"ok": True}


@router.post("/alerts/{alert_id}/resolve", status_code=204)
async def resolve_alert(alert_id: int, request: Request, user: dict = Depends(current_user)):
    await request.app.state.db.execute(
        "UPDATE alerts SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL "
        "AND ($2::boolean OR patient_id IN (SELECT patient_id FROM patient_caregivers WHERE caregiver_id = $3))",
        alert_id, _is_admin(user), user["id"],
    )


# ---------------------------------------------------------------------------
# Admin only: patients and caregivers
# ---------------------------------------------------------------------------

@router.get("/admin/patients")
async def admin_patients(request: Request, admin: dict = Depends(admin_user)):
    return [dict(r) for r in await request.app.state.db.fetch(ADMIN_PATIENTS)]


@router.get("/admin/caregivers")
async def admin_caregivers(request: Request, admin: dict = Depends(admin_user)):
    rows = await request.app.state.db.fetch(
        "SELECT id, full_name, username, role, phone_whatsapp AS chat_id FROM caregivers "
        "ORDER BY role, full_name"
    )
    return [dict(r) for r in rows]


class NewPatient(BaseModel):
    full_name: str
    chat_id: str
    checkin_time: str = "09:00"
    caregiver_ids: List[int] = []


@router.post("/admin/patients", status_code=201)
async def create_patient(body: NewPatient, request: Request, admin: dict = Depends(admin_user)):
    name, chat = body.full_name.strip(), body.chat_id.strip()
    if not name or not chat:
        raise HTTPException(status_code=400, detail="Enter a name and a Telegram chat ID")
    checkin = _parse_time(body.checkin_time)
    try:
        async with request.app.state.db.acquire() as conn:
            async with conn.transaction():
                pid = await conn.fetchval(
                    "INSERT INTO patients (full_name, phone_whatsapp, checkin_time, opted_in) "
                    "VALUES ($1, $2, $3, true) RETURNING id",
                    name, chat, checkin,
                )
                for order, cid in enumerate(body.caregiver_ids, start=1):
                    await conn.execute(
                        "INSERT INTO patient_caregivers (patient_id, caregiver_id, escalation_order) "
                        "VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                        pid, cid, order,
                    )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="That Telegram chat ID already belongs to another patient")
    except asyncpg.ForeignKeyViolationError:
        raise HTTPException(status_code=400, detail="One of the chosen caregivers does not exist")
    return {"id": pid}


class PatientUpdate(BaseModel):
    full_name: Optional[str] = None
    chat_id: Optional[str] = None
    checkin_time: Optional[str] = None
    opted_in: Optional[bool] = None  # false pauses every reminder for this patient
    caregiver_ids: Optional[List[int]] = None


@router.patch("/admin/patients/{patient_id}", status_code=204)
async def update_patient(patient_id: int, body: PatientUpdate, request: Request, admin: dict = Depends(admin_user)):
    checkin = _parse_time(body.checkin_time) if body.checkin_time else None
    try:
        async with request.app.state.db.acquire() as conn:
            async with conn.transaction():
                result = await conn.execute(
                    "UPDATE patients SET full_name = COALESCE($2, full_name), "
                    "phone_whatsapp = COALESCE($3, phone_whatsapp), "
                    "checkin_time = COALESCE($4, checkin_time), opted_in = COALESCE($5, opted_in) "
                    "WHERE id = $1",
                    patient_id,
                    body.full_name.strip() if body.full_name else None,
                    body.chat_id.strip() if body.chat_id else None,
                    checkin, body.opted_in,
                )
                if result == "UPDATE 0":
                    raise HTTPException(status_code=404, detail="Patient not found")
                if body.caregiver_ids is not None:
                    await conn.execute("DELETE FROM patient_caregivers WHERE patient_id = $1", patient_id)
                    for order, cid in enumerate(body.caregiver_ids, start=1):
                        await conn.execute(
                            "INSERT INTO patient_caregivers (patient_id, caregiver_id, escalation_order) "
                            "VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                            patient_id, cid, order,
                        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="That Telegram chat ID already belongs to another patient")
    except asyncpg.ForeignKeyViolationError:
        raise HTTPException(status_code=400, detail="One of the chosen caregivers does not exist")


@router.delete("/admin/patients/{patient_id}", status_code=204)
async def delete_patient(patient_id: int, request: Request, admin: dict = Depends(admin_user)):
    """Removes the patient and all of their history."""
    result = await request.app.state.db.execute("DELETE FROM patients WHERE id = $1", patient_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Patient not found")


class NewCaregiver(BaseModel):
    full_name: str
    username: str
    password: str
    role: str = "caregiver"
    chat_id: Optional[str] = None


@router.post("/admin/caregivers", status_code=201)
async def create_caregiver(body: NewCaregiver, request: Request, admin: dict = Depends(admin_user)):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", body.username.strip()):
        raise HTTPException(status_code=400, detail="Username needs 3 to 32 letters, numbers, dots or dashes")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password needs at least 8 characters")
    if body.role not in ("caregiver", "admin"):
        raise HTTPException(status_code=400, detail="Role must be caregiver or admin")
    try:
        cid = await request.app.state.db.fetchval(
            "INSERT INTO caregivers (full_name, username, password_hash, role, phone_whatsapp) "
            "VALUES ($1, $2, $3, $4, $5) RETURNING id",
            body.full_name.strip() or body.username.strip(), body.username.strip(),
            hash_password(body.password), body.role, (body.chat_id or "").strip() or None,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="That username or chat ID is already taken")
    return {"id": cid}


class PasswordBody(BaseModel):
    password: str


@router.post("/admin/caregivers/{caregiver_id}/password", status_code=204)
async def reset_password(caregiver_id: int, body: PasswordBody, request: Request, admin: dict = Depends(admin_user)):
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password needs at least 8 characters")
    result = await request.app.state.db.execute(
        "UPDATE caregivers SET password_hash = $2 WHERE id = $1", caregiver_id, hash_password(body.password)
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Account not found")


@router.delete("/admin/caregivers/{caregiver_id}", status_code=204)
async def delete_caregiver(caregiver_id: int, request: Request, admin: dict = Depends(admin_user)):
    if caregiver_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    db = request.app.state.db
    role = await db.fetchval("SELECT role FROM caregivers WHERE id = $1", caregiver_id)
    if role is None:
        raise HTTPException(status_code=404, detail="Account not found")
    if role == "admin" and await db.fetchval("SELECT COUNT(*) FROM caregivers WHERE role = 'admin'") <= 1:
        raise HTTPException(status_code=400, detail="You cannot delete the last admin")
    await db.execute("DELETE FROM caregivers WHERE id = $1", caregiver_id)
