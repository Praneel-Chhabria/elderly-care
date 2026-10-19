# Smart Elderly Care and Medicine Tracker

Smart India Hackathon 2026, problem statement SIH26198.

Caregivers get a live dashboard of medicine reminders for elderly patients. Patients answer on
Telegram with tap buttons. Missed doses raise alerts and message the caregiver. Admins add
patients, assign caregivers and control reminders.

## Stack
- Frontend: Next.js and Tailwind (care-ui)
- Backend: FastAPI with a background scheduler (backend)
- Database: PostgreSQL, 9 tables (backend/schema.sql)
- Messaging: Telegram bot, reached through an ngrok tunnel while developing

## Run it
1. Database

        createdb elderly_care
        psql -d elderly_care -f backend/schema.sql
        psql -d elderly_care -f backend/seed_sunita.sql

2. Backend

        cd backend
        python3 -m venv venv && source venv/bin/activate
        pip install -r requirements.txt
        cp .env.example .env     # then fill in the values
        python manage_users.py YOUR_USERNAME --admin --name "Your Name"
        uvicorn main:app --reload --port 8000

3. Frontend

        cd care-ui
        npm install
        npm run dev

   Open http://localhost:3000 and sign in.

4. Telegram: create a bot with @BotFather, put its token in .env, run ngrok http 8000, then point the
   webhook at https://YOUR-NGROK-ADDRESS/webhook/telegram

## Roles
- Caregiver: sees only the patients assigned to them.
- Admin: sees everything, adds patients and logins, pauses reminders.
