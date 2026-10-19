"""
Create or update a login from the terminal. Use it once to make the first admin.

    python manage_users.py adi --admin --name "Adi" --chat-id 6855885374

If an account with that username or Telegram chat ID already exists, it is linked to the
login (keeping its patients). Otherwise a new account is created. The password is asked
for twice and never shown or stored in plain text.
"""

import argparse
import asyncio
import getpass
import os
import sys

import asyncpg
from dotenv import load_dotenv

load_dotenv()

from auth import hash_password


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("username")
    ap.add_argument("--admin", action="store_true", help="give this account admin rights")
    ap.add_argument("--name", help="full name")
    ap.add_argument("--chat-id", help="Telegram chat ID for caregiver alerts")
    args = ap.parse_args()

    password = getpass.getpass("Password (at least 8 characters): ")
    if len(password) < 8:
        sys.exit("Password is too short.")
    if password != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match.")

    role = "admin" if args.admin else "caregiver"
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        row = await conn.fetchrow(
            "SELECT id FROM caregivers WHERE lower(username) = lower($1) "
            "OR ($2::text IS NOT NULL AND phone_whatsapp = $2) LIMIT 1",
            args.username, args.chat_id,
        )
        if row:
            await conn.execute(
                "UPDATE caregivers SET username = $2, password_hash = $3, role = $4, "
                "full_name = COALESCE($5, full_name) WHERE id = $1",
                row["id"], args.username, hash_password(password), role, args.name,
            )
            print(f"Updated account {args.username} ({role}).")
        else:
            await conn.execute(
                "INSERT INTO caregivers (full_name, username, password_hash, role, phone_whatsapp) "
                "VALUES ($1, $2, $3, $4, $5)",
                args.name or args.username, args.username, hash_password(password), role, args.chat_id,
            )
            print(f"Created account {args.username} ({role}).")
    finally:
        await conn.close()


asyncio.run(main())
