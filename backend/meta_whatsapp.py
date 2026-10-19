"""
Meta WhatsApp Cloud API integration for the Smart Elderly Care & Medicine Tracker (SIH26198).
Replaces twilio_whatsapp.py. Install: pip install httpx

Env vars (backend/.env):
    WHATSAPP_TOKEN            access token from Meta (API Setup page)
    WHATSAPP_PHONE_NUMBER_ID  phone number ID of the test number
    WHATSAPP_VERIFY_TOKEN     any string you choose, must match the one typed in Meta's webhook form
    META_APP_SECRET           App settings > Basic > App secret (enables signature checking)
    GRAPH_API_VERSION         optional, defaults to v23.0

Rules to remember:
    * Free form text and buttons only work within 24 hours of the user's last message to your number.
    * Outside that window you must send an approved template (hello_world works on the test number).
"""

import hashlib
import hmac
import json
import os
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse

TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
PHONE_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "")
VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN", "")
APP_SECRET = os.environ.get("META_APP_SECRET", "")
GRAPH_VERSION = os.environ.get("GRAPH_API_VERSION", "v23.0")
MESSAGES_URL = f"https://graph.facebook.com/{GRAPH_VERSION}/{PHONE_ID}/messages"

router = APIRouter()


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

def _digits(number: str) -> str:
    """Meta wants the number with country code and no plus sign, like 917822927040."""
    return "".join(c for c in number if c.isdigit())


async def _post(payload: dict) -> str:
    async with httpx.AsyncClient(timeout=15) as http:
        resp = await http.post(
            MESSAGES_URL,
            headers={"Authorization": f"Bearer {TOKEN}"},
            json={"messaging_product": "whatsapp", **payload},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"WhatsApp API error {resp.status_code}: {resp.text}")
    return resp.json()["messages"][0]["id"]


async def send_text(to: str, body: str) -> str:
    return await _post({"to": _digits(to), "type": "text", "text": {"body": body}})


async def send_buttons(to: str, body: str, buttons: list[tuple[str, str]]) -> str:
    """Up to 3 tap buttons. buttons is a list of (id, title), title max 20 characters."""
    return await _post({
        "to": _digits(to),
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body},
            "action": {
                "buttons": [{"type": "reply", "reply": {"id": i, "title": t}} for i, t in buttons]
            },
        },
    })


async def send_template(to: str, name: str = "hello_world", language: str = "en_US",
                        body_params: Optional[list[str]] = None) -> str:
    """Approved template. hello_world is available on every test number."""
    template: dict = {"name": name, "language": {"code": language}}
    if body_params:
        template["components"] = [
            {"type": "body", "parameters": [{"type": "text", "text": p} for p in body_params]}
        ]
    return await _post({"to": _digits(to), "type": "template", "template": template})


async def send_reminder(to: str, name: str, medicine: str, dosage: str,
                        instructions: Optional[str] = None) -> str:
    extra = f"\n({instructions})" if instructions else ""
    body = f"Hello {name}, it is time for your medicine.\n{medicine}, {dosage}{extra}"
    return await send_buttons(to, body, [("taken", "Taken"), ("skip", "Skip this dose")])


async def send_checkin(to: str, name: str) -> str:
    return await send_buttons(
        to,
        f"Good morning {name}. How are you feeling today?",
        [("good", "I am good"), ("okay", "I am okay"), ("help", "I need help")],
    )


# ---------------------------------------------------------------------------
# Receiving
# ---------------------------------------------------------------------------

def _check_signature(raw: bytes, header: str) -> None:
    if not APP_SECRET:
        return  # signature checking is off until META_APP_SECRET is set
    expected = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, header):
        raise HTTPException(status_code=403, detail="Invalid signature")


@router.get("/webhook/whatsapp")
async def verify(request: Request):
    """Meta calls this once when you click Verify and save in the webhook form."""
    q = request.query_params
    if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == VERIFY_TOKEN:
        return PlainTextResponse(q.get("hub.challenge", ""))
    raise HTTPException(status_code=403, detail="Verification failed")


@router.post("/webhook/whatsapp")
async def incoming(request: Request):
    """Meta posts every incoming message and delivery status here. Always answer 200 quickly."""
    raw = await request.body()
    _check_signature(raw, request.headers.get("X-Hub-Signature-256", ""))
    payload = json.loads(raw)
    db = request.app.state.db

    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for status in value.get("statuses", []):
                await db.execute(
                    "UPDATE message_log SET status = $2 WHERE provider_msg_id = $1",
                    status.get("id"), status.get("status"),
                )
            for msg in value.get("messages", []):
                try:
                    await _handle_message(db, msg)
                except Exception as exc:  # never return 500, Meta would keep retrying
                    print(f"Error handling WhatsApp message {msg.get('id')}: {exc}")
    return Response(status_code=200)


async def _handle_message(db, msg: dict) -> None:
    phone = "+" + msg["from"]
    wamid = msg["id"]
    kind = msg.get("type")

    if kind == "text":
        text = msg["text"]["body"]
    elif kind == "interactive":
        interactive = msg["interactive"]
        text = (interactive.get("button_reply") or interactive.get("list_reply") or {}).get("id", "")
    else:
        text = ""
    text = text.strip().upper()

    async with db.acquire() as conn:
        patient = await conn.fetchrow(
            "SELECT id, full_name FROM patients WHERE phone_whatsapp = $1", phone
        )
        if patient is None:
            reply = "This number is not registered. Please ask your caregiver to add you."
        else:
            if await conn.fetchval("SELECT 1 FROM message_log WHERE provider_msg_id = $1", wamid):
                return  # Meta sometimes delivers the same message twice
            await conn.execute(
                "INSERT INTO message_log (patient_id, direction, provider_msg_id, body) "
                "VALUES ($1, 'inbound', $2, $3)",
                patient["id"], wamid, text,
            )
            reply = await _process(conn, patient, phone, text)

    if reply:
        await send_text(phone, reply)


async def _process(conn, patient, phone: str, text: str) -> str:
    waiting = await conn.fetchval(
        "SELECT 1 FROM dose_events WHERE patient_id = $1 AND status = 'reminded' LIMIT 1",
        patient["id"],
    )

    if waiting and text in ("1", "TAKEN", "YES"):
        await conn.execute(MARK_TAKEN, phone)
        return "Thank you. Your dose is marked as taken."

    if waiting and text in ("2", "SKIP"):
        await conn.execute(MARK_SKIPPED, phone)
        return "Okay, this dose is marked as skipped. Your caregiver can see this."

    if text == "HELP" or (text == "3" and not waiting):
        await conn.execute(
            "INSERT INTO alerts (patient_id, type, message) VALUES ($1, 'needs_help', $2)",
            patient["id"], f"{patient['full_name']} asked for help",
        )
        return "Help is on the way. Your caregiver has been told."

    if text in ("GOOD", "OKAY") or (text in ("1", "2") and not waiting):
        label = {"1": "GOOD", "2": "OKAY"}.get(text, text)
        await conn.execute(RECORD_CHECKIN, phone, label)
        return "Thank you. Have a good day."

    return "Sorry, I did not understand. Reply 1 for taken, 2 to skip, or HELP."


# SQL from queries.sql (Q3, Q3b, Q5b)
MARK_TAKEN = """
UPDATE dose_events SET status = 'taken', responded_at = now()
WHERE id = (SELECT de.id FROM dose_events de JOIN patients p ON p.id = de.patient_id
            WHERE p.phone_whatsapp = $1 AND de.status = 'reminded'
            ORDER BY de.scheduled_for DESC LIMIT 1)
"""

MARK_SKIPPED = """
UPDATE dose_events SET status = 'skipped', responded_at = now()
WHERE id = (SELECT de.id FROM dose_events de JOIN patients p ON p.id = de.patient_id
            WHERE p.phone_whatsapp = $1 AND de.status = 'reminded'
            ORDER BY de.scheduled_for DESC LIMIT 1)
"""

RECORD_CHECKIN = """
UPDATE checkins SET response = $2, responded_at = now()
WHERE id = (SELECT c.id FROM checkins c JOIN patients p ON p.id = c.patient_id
            WHERE p.phone_whatsapp = $1 AND c.responded_at IS NULL
            ORDER BY c.sent_at DESC LIMIT 1)
"""
