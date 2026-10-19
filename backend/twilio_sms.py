"""
Telegram bot channel for the Smart Elderly Care & Medicine Tracker (SIH26198).

The file keeps the name twilio_sms.py so scheduler.py and main.py need no changes.
patients.phone_whatsapp and caregivers.phone_whatsapp hold Telegram chat ids.

Env var (backend/.env):
    TELEGRAM_BOT_TOKEN
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import List, Optional, Tuple

from fastapi import APIRouter, Request

router = APIRouter()

TAKEN_WORDS = {"taken", "take", "took", "done", "yes", "1"}
SKIP_WORDS = {"skip", "skipped", "no", "2"}
CHECKIN_WORDS = {"checkin", "check-in", "good", "okay", "ok", "fine"}

# Latest dose that is due now. A dose waiting for a reply comes first, then missed, then pending.
DOSE_LOOKUP = """
SELECT de.id, m.name AS medicine
FROM dose_events de
JOIN medicines m ON m.id = de.medicine_id
WHERE de.patient_id = $1
  AND de.status IN ('reminded', 'missed', 'pending')
  AND de.scheduled_for <= NOW()
  AND de.scheduled_for >= NOW() - INTERVAL '3 hours'
ORDER BY (de.status = 'reminded') DESC, de.scheduled_for DESC
LIMIT 1
"""


# ---------------------------------------------------------------------------
# Telegram helpers
# ---------------------------------------------------------------------------

def _telegram_call(method: str, payload: dict) -> dict:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Telegram {method} failed with {exc.code}: {exc.read().decode()}")


async def _call(method: str, payload: dict) -> dict:
    return await asyncio.to_thread(_telegram_call, method, payload)


async def send_message(chat_id: str, text: str, buttons: Optional[List[List[Tuple[str, str]]]] = None) -> str:
    """Send a message. buttons is rows of (label, callback_data) shown as tap buttons."""
    payload: dict = {"chat_id": chat_id, "text": text}
    if buttons:
        payload["reply_markup"] = {
            "inline_keyboard": [[{"text": label, "callback_data": data} for label, data in row] for row in buttons]
        }
    result = await _call("sendMessage", payload)
    return str(result.get("result", {}).get("message_id", "sent"))


async def send_text(to_number: str, message: str) -> str:
    return await send_message(to_number, message)


async def send_reminder(to_number: str, name: str, medicine: str, dosage: str, instructions: Optional[str] = None) -> str:
    extra = f"\n({instructions})" if instructions else ""
    text = f"Hello {name}, it is time for your medicine.\n\n{medicine}, {dosage}{extra}"
    return await send_message(to_number, text, [[("Taken", "taken"), ("Skip", "skip")]])


async def send_checkin(to_number: str, name: str) -> str:
    return await send_message(
        to_number,
        f"Good morning {name}. How are you feeling today?",
        [[("I am good", "checkin"), ("I need help", "help")]],
    )


async def _safe_send(chat_id: str, text: str) -> None:
    """Replies inside the webhook must never raise, or Telegram keeps retrying the update."""
    try:
        await send_message(chat_id, text)
    except Exception as exc:
        print(f"Telegram reply failed: {exc}")


# ---------------------------------------------------------------------------
# Webhook for incoming messages and button taps
# ---------------------------------------------------------------------------

@router.post("/webhook/telegram")
async def telegram_webhook(request: Request):
    update = await request.json()

    callback = update.get("callback_query")
    if callback:
        chat_id = str((callback.get("message") or {}).get("chat", {}).get("id", ""))
        text = (callback.get("data") or "").strip().lower()
        try:
            await _call("answerCallbackQuery", {"callback_query_id": callback["id"]})
        except Exception as exc:
            print(f"answerCallbackQuery failed: {exc}")
        # Remove the buttons once one is tapped so the same reminder cannot be answered twice.
        msg_id = (callback.get("message") or {}).get("message_id")
        if msg_id:
            try:
                await _call(
                    "editMessageReplyMarkup",
                    {"chat_id": chat_id, "message_id": msg_id, "reply_markup": {"inline_keyboard": []}},
                )
            except Exception as exc:
                print(f"Could not remove buttons: {exc}")
    else:
        message = update.get("message") or {}
        chat_id = str(message.get("chat", {}).get("id", ""))
        text = (message.get("text") or "").strip().lower().lstrip("/")

    if not chat_id or not text:
        return {"status": "ignored"}

    db = getattr(request.app.state, "pool", getattr(request.app.state, "db", None))
    if db is None:
        return {"status": "db_not_found"}

    patient = await db.fetchrow("SELECT id, full_name FROM patients WHERE phone_whatsapp = $1", chat_id)
    if patient is None:
        await _safe_send(chat_id, f"This chat is not linked to a patient yet. Give your caregiver this number: {chat_id}")
        return {"status": "patient_not_found"}

    patient_id = patient["id"]

    if text == "start":
        await _safe_send(chat_id, f"Hello {patient['full_name']}. You are connected. Your medicine reminders will appear here.")

    elif text in TAKEN_WORDS or text in SKIP_WORDS:
        status = "taken" if text in TAKEN_WORDS else "skipped"
        dose = await db.fetchrow(DOSE_LOOKUP, patient_id)
        if dose:
            await db.execute(
                "UPDATE dose_events SET status = $1::dose_status, responded_at = NOW() WHERE id = $2",
                status, dose["id"],
            )
            await _safe_send(chat_id, f"Recorded: {dose['medicine']} marked as {status}.")
        else:
            await _safe_send(chat_id, "There is no medicine waiting for a reply right now.")

    elif text in CHECKIN_WORDS:
        row = await db.fetchrow(
            "SELECT id FROM checkins WHERE patient_id = $1 AND responded_at IS NULL "
            "ORDER BY sent_at DESC LIMIT 1",
            patient_id,
        )
        if row:
            await db.execute(
                "UPDATE checkins SET responded_at = NOW(), response = 'GOOD' WHERE id = $1", row["id"]
            )
            await _safe_send(chat_id, "Thank you. Your check-in is recorded. Have a good day.")
        else:
            await _safe_send(chat_id, "There is no check-in waiting for a reply right now.")

    elif text == "help":
        await db.execute(
            "INSERT INTO alerts (patient_id, type, message) VALUES ($1, 'needs_help', $2)",
            patient_id, f"{patient['full_name']} asked for help",
        )
        await _safe_send(chat_id, "Help is on the way. Your caregiver has been told.")

    else:
        await _safe_send(chat_id, "Please tap Taken or Skip, or type taken or skip. Type help if you need help.")

    return {"status": "success"}


# Kept so any existing imports or old webhook settings do not break.
@router.post("/webhook/whatsapp")
async def whatsapp_webhook(request: Request):
    return {"status": "received"}


@router.post("/test-sms")
async def test_sms():
    return {"status": "ok"}
