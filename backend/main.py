import asyncio
import os
from contextlib import asynccontextmanager

import asyncpg
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import scheduler
from api_routes import router as api_router
from auth import router as auth_router
from twilio_sms import router as telegram_router  # the Telegram bot (file name kept)


@asynccontextmanager
async def lifespan(app):
    app.state.db = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    task = None
    if os.environ.get("ENABLE_SCHEDULER", "true").lower() == "true":
        task = asyncio.create_task(scheduler.run_forever(app.state.db))
    yield
    if task:
        task.cancel()
    await app.state.db.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(telegram_router)
app.include_router(auth_router)
app.include_router(api_router)
