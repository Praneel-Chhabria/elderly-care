"""
Login and session helpers. Passwords are hashed with PBKDF2 and sessions are signed tokens,
so no extra packages are needed. Set AUTH_SECRET in backend/.env.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/auth")

TOKEN_HOURS = 12
ITERATIONS = 200_000


def _secret() -> bytes:
    value = os.environ.get("AUTH_SECRET")
    if not value:
        print("WARNING: AUTH_SECRET is not set in .env. Using an insecure development secret.")
        value = "dev-secret-change-me"
    return value.encode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
    return f"pbkdf2${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
    except ValueError:
        return False
    return hmac.compare_digest(test, digest)


def make_token(user_id: int) -> str:
    body = _b64(json.dumps({"uid": user_id, "exp": int(time.time()) + TOKEN_HOURS * 3600}).encode())
    sig = _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def read_token(token: str) -> Optional[dict]:
    try:
        body, sig = token.split(".")
        expected = _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_unb64(body))
    except (ValueError, json.JSONDecodeError):
        return None
    return payload if payload.get("exp", 0) > time.time() else None


async def current_user(request: Request) -> dict:
    """Dependency: the signed in user, loaded fresh so deleted accounts lose access at once."""
    header = request.headers.get("Authorization", "")
    payload = read_token(header[7:]) if header.startswith("Bearer ") else None
    if payload is None:
        raise HTTPException(status_code=401, detail="Please sign in")
    row = await request.app.state.db.fetchrow(
        "SELECT id, full_name, username, role FROM caregivers "
        "WHERE id = $1 AND password_hash IS NOT NULL",
        payload["uid"],
    )
    if row is None:
        raise HTTPException(status_code=401, detail="Please sign in")
    return dict(row)


async def admin_user(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(body: LoginBody, request: Request):
    row = await request.app.state.db.fetchrow(
        "SELECT id, full_name, username, role, password_hash FROM caregivers "
        "WHERE lower(username) = lower($1)",
        body.username.strip(),
    )
    if row is None or not row["password_hash"] or not verify_password(body.password, row["password_hash"]):
        await asyncio.sleep(0.6)  # slows down password guessing
        raise HTTPException(status_code=401, detail="Wrong username or password")
    user = {k: row[k] for k in ("id", "full_name", "username", "role")}
    return {"token": make_token(user["id"]), "user": user}


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    return user
