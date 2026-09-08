#!/usr/bin/env python3
import os
import re
import uuid
import secrets
import sqlite3
import smtplib
import time
import threading
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from urllib.parse import quote

try:
    from flask import Flask, request, jsonify
except ImportError:
    print("Flask non installé. Lancez : pip3 install flask")
    raise SystemExit(1)

try:
    import qrcode
    from io import BytesIO
    import base64
    QR_AVAILABLE = True
except ImportError:
    QR_AVAILABLE = False
    print("⚠️  qrcode/pillow non installés — QR désactivé. Lancez : pip3 install qrcode pillow")

# ── Config ──

PORT = int(os.environ.get("PORT", 3001))
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:8090")
SITE_URL = os.environ.get("SITE_URL", "http://localhost:8090")
STAFF_PIN = os.environ.get("STAFF_PIN", "0000")
EMAIL_HOST = os.environ.get("EMAIL_HOST", "smtp.gmail.com")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", 587))
EMAIL_USER = os.environ.get("EMAIL_USER", "")
EMAIL_PASS = os.environ.get("EMAIL_PASS", "")
EMAIL_FROM = os.environ.get("EMAIL_FROM", "Core House Dakar <core21.lab@gmail.com>")

# ── Load .env ──

env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    PORT = int(os.environ.get("PORT", 3001))
    FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:8090")
    SITE_URL = os.environ.get("SITE_URL", "http://localhost:8090")
    STAFF_PIN = os.environ.get("STAFF_PIN", "0000")
    EMAIL_HOST = os.environ.get("EMAIL_HOST", "smtp.gmail.com")
    EMAIL_PORT = int(os.environ.get("EMAIL_PORT", 587))
    EMAIL_USER = os.environ.get("EMAIL_USER", "")
    EMAIL_PASS = os.environ.get("EMAIL_PASS", "")
    EMAIL_FROM = os.environ.get("EMAIL_FROM", "Core House Dakar <core21.lab@gmail.com>")

# ── Flask App ──

app = Flask(__name__)

# ── Database ──

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookings.db")

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db

def init_db():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS bookings (
            id TEXT PRIMARY KEY,
            classId TEXT NOT NULL,
            discipline TEXT NOT NULL,
            date TEXT NOT NULL,
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            coach TEXT,
            customerName TEXT NOT NULL,
            customerEmail TEXT NOT NULL,
            places INTEGER NOT NULL DEFAULT 1,
            purchaseType TEXT NOT NULL DEFAULT 'single',
            totalPrice INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'confirmed',
            createdAt TEXT NOT NULL,
            idempotencyKey TEXT UNIQUE
        );

        CREATE TABLE IF NOT EXISTS classes (
            classId TEXT PRIMARY KEY,
            discipline TEXT NOT NULL,
            date TEXT NOT NULL,
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            coach TEXT,
            maxParticipants INTEGER NOT NULL DEFAULT 12,
            bookedParticipants INTEGER NOT NULL DEFAULT 0,
            googleCalendarEventId TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_bookings_classId ON bookings(classId);
        CREATE INDEX IF NOT EXISTS idx_bookings_idempotency ON bookings(idempotencyKey);
        CREATE INDEX IF NOT EXISTS idx_classes_date ON classes(date);

        CREATE TABLE IF NOT EXISTS free_customers (
            id TEXT PRIMARY KEY,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL,
            email_normalized TEXT NOT NULL,
            phone_normalized TEXT NOT NULL,
            marketing_consent INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS free_invitations (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            class_id TEXT NOT NULL,
            discipline TEXT NOT NULL,
            date TEXT NOT NULL,
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            coach TEXT,
            token TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'booked',
            created_at TEXT NOT NULL,
            expires_at TEXT,
            used_at TEXT,
            checked_in_by TEXT,
            idempotency_key TEXT UNIQUE
        );

        CREATE INDEX IF NOT EXISTS idx_free_customers_email ON free_customers(email_normalized);
        CREATE INDEX IF NOT EXISTS idx_free_customers_phone ON free_customers(phone_normalized);
        CREATE INDEX IF NOT EXISTS idx_free_invitations_token ON free_invitations(token);
        CREATE INDEX IF NOT EXISTS idx_free_invitations_status ON free_invitations(status);
        CREATE INDEX IF NOT EXISTS idx_free_invitations_customer ON free_invitations(customer_id);
    """)
    db.close()

init_db()

# ── Disciplines ──

DISCIPLINES = {
    "pilates": {"label": "Mat Pilates", "price": 15000, "maxParticipants": 12},
    "yoga": {"label": "Yoga", "price": 12000, "maxParticipants": 12},
    "box": {"label": "Box Cardio", "price": 15000, "maxParticipants": 6},
}

MIN_PARTICIPANTS = 2

# ── Class Schedule ──

CLASS_SCHEDULE = [
    {"day": 1, "hour": 8, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 1, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 1, "hour": 10, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 1, "hour": 11, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 1, "hour": 12, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 1, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 1, "hour": 14, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 1, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 1, "hour": 16, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 1, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 1, "hour": 18, "minute": 0, "discipline": "box", "coach": None},
    {"day": 1, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 1, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 1, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 2, "hour": 8, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 2, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 2, "hour": 10, "minute": 0, "discipline": "box", "coach": None},
    {"day": 2, "hour": 11, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 2, "hour": 12, "minute": 0, "discipline": "box", "coach": None},
    {"day": 2, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 2, "hour": 14, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 2, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 2, "hour": 16, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 2, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 2, "hour": 18, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 2, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 2, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 2, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 3, "hour": 8, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 3, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 3, "hour": 10, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 3, "hour": 11, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 3, "hour": 12, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 3, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 3, "hour": 14, "minute": 0, "discipline": "box", "coach": None},
    {"day": 3, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 3, "hour": 16, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 3, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 3, "hour": 18, "minute": 0, "discipline": "box", "coach": None},
    {"day": 3, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 3, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 3, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 4, "hour": 8, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 4, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 4, "hour": 10, "minute": 0, "discipline": "box", "coach": None},
    {"day": 4, "hour": 11, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 4, "hour": 12, "minute": 0, "discipline": "box", "coach": None},
    {"day": 4, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 4, "hour": 14, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 4, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 4, "hour": 16, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 4, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 4, "hour": 18, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 4, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 4, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 4, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 5, "hour": 8, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 5, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 5, "hour": 10, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 5, "hour": 11, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 5, "hour": 12, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 5, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 5, "hour": 14, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 5, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 5, "hour": 16, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 5, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 5, "hour": 18, "minute": 0, "discipline": "box", "coach": None},
    {"day": 5, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 5, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 5, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 6, "hour": 8, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 6, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 6, "hour": 10, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 6, "hour": 11, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 6, "hour": 12, "minute": 0, "discipline": "box", "coach": None},
    {"day": 6, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 6, "hour": 14, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 6, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 6, "hour": 16, "minute": 0, "discipline": "box", "coach": None},
    {"day": 6, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 6, "hour": 18, "minute": 0, "discipline": "box", "coach": None},
    {"day": 6, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 6, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 6, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 0, "hour": 8, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 0, "hour": 9, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 0, "hour": 10, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 0, "hour": 11, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 0, "hour": 12, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 0, "hour": 13, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 0, "hour": 14, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 0, "hour": 15, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 0, "hour": 16, "minute": 0, "discipline": "yoga", "coach": "Kezia"},
    {"day": 0, "hour": 17, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 0, "hour": 18, "minute": 0, "discipline": "yoga", "coach": "Sophie"},
    {"day": 0, "hour": 19, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
    {"day": 0, "hour": 20, "minute": 0, "discipline": "pilates", "coach": "Sophie"},
    {"day": 0, "hour": 21, "minute": 0, "discipline": "pilates", "coach": "Yassine"},
]

# ── Rate Limiting ──

rate_limit_store = {}
rate_limit_lock = threading.Lock()

def check_rate_limit(key, max_attempts, window_s):
    now = time.time()
    with rate_limit_lock:
        record = rate_limit_store.get(key)
        if not record or now - record["start"] > window_s:
            rate_limit_store[key] = {"start": now, "count": 1}
            return True
        if record["count"] >= max_attempts:
            return False
        record["count"] += 1
        return True

# ── Staff Auth ──

staff_sessions = {}
SESSION_DURATION_S = 8 * 3600

def validate_staff_auth():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    token = auth[7:]
    session = staff_sessions.get(token)
    if not session or time.time() > session["expires"]:
        staff_sessions.pop(token, None)
        return False
    return True

def staff_auth_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if not validate_staff_auth():
            return jsonify({"success": False, "error": "Non autorisé."}), 401
        return f(*args, **kwargs)
    return decorated

# ── Utilities ──

def normalize_email(email):
    return email.strip().lower()

def normalize_phone(phone):
    cleaned = re.sub(r"[\s\-\.\(\)]", "", phone)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    return cleaned

def generate_secure_token():
    return secrets.token_hex(32)

def get_class_id(date_str, hour, minute, discipline):
    suffix = f":{minute}" if minute > 0 else ""
    return f"{date_str}-{hour}{suffix}-{discipline}"

def format_date_fr(date_str):
    from locale import setlocale, LC_TIME
    try:
        setlocale(LC_TIME, "fr_FR.UTF-8")
    except Exception:
        pass
    d = datetime.strptime(date_str, "%Y-%m-%d")
    days_fr = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    months_fr = ["", "janvier", "février", "mars", "avril", "mai", "juin",
                 "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    return f"{days_fr[d.weekday()]} {d.day} {months_fr[d.month]} {d.year}"

def format_price(amount):
    s = str(amount)
    result = ""
    for i, ch in enumerate(reversed(s)):
        if i > 0 and i % 3 == 0:
            result = " " + result
        result = ch + result
    return result + " XOF"

def get_participant_count(db, class_id):
    row = db.execute("SELECT COALESCE(SUM(places), 0) as total FROM bookings WHERE classId = ?", (class_id,)).fetchone()
    return row["total"] if row else 0

def generate_qr_data_url(content):
    if not QR_AVAILABLE:
        return None
    qr = qrcode.QRCode(version=1, box_size=10, border=2)
    qr.add_data(content)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#301905", back_color="#F8F4ED")
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{b64}"

def generate_schedule_sessions(db, discipline, days):
    sessions = []
    now = datetime.now()

    for d in range(days):
        date = now + timedelta(days=d)
        date_start = date.replace(hour=0, minute=0, second=0, microsecond=0)
        day_of_week = date.isoweekday() % 7  # 0=Sunday
        date_str = date.strftime("%Y-%m-%d")

        day_classes = [c for c in CLASS_SCHEDULE
                       if c["day"] == day_of_week and (not discipline or c["discipline"] == discipline)]

        for cls in day_classes:
            if d == 0:
                class_time = date_start.replace(hour=cls["hour"], minute=cls["minute"])
                if class_time <= now:
                    continue

            class_id = get_class_id(date_str, cls["hour"], cls["minute"], cls["discipline"])
            disc = DISCIPLINES[cls["discipline"]]
            current_count = get_participant_count(db, class_id)
            max_p = disc["maxParticipants"]

            sessions.append({
                "classId": class_id,
                "date": date_str,
                "hour": cls["hour"],
                "minute": cls["minute"],
                "discipline": cls["discipline"],
                "disciplineLabel": disc["label"],
                "coach": cls["coach"],
                "maxParticipants": max_p,
                "currentParticipants": current_count,
                "available": current_count < max_p,
            })

    return sessions

# ── Email ──

def send_email(to, subject, html_body, attachments=None):
    if not EMAIL_USER or not EMAIL_PASS:
        print(f"Email non configuré — email à {to} ignoré.")
        return

    msg = MIMEMultipart("related")
    msg["From"] = EMAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    if attachments:
        for att in attachments:
            img = MIMEImage(att["content"], _subtype="png")
            img.add_header("Content-ID", f"<{att['cid']}>")
            img.add_header("Content-Disposition", "inline", filename=att["filename"])
            msg.attach(img)

    try:
        with smtplib.SMTP(EMAIL_HOST, EMAIL_PORT) as server:
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.send_message(msg)
        print(f"Email envoyé à {to}")
    except Exception as e:
        print(f"Erreur email: {e}")

def send_invitation_email(data):
    disc = DISCIPLINES[data["discipline"]]
    time_str = f"{data['hour']:02d}:{data.get('minute', 0):02d}"
    date_fr = format_date_fr(data["date"])
    coach = data.get("coach")
    coach_line = f'<tr><td style="color: #7F6F4C; padding: 6px 0;">Coach</td><td style="text-align: right; font-weight: 500;">{coach}</td></tr>' if coach else ""

    cal_title = quote(f"{disc['label']} — Core House Dakar")
    start_iso = f"{data['date']}T{data['hour']:02d}:{data.get('minute', 0):02d}:00"
    start_dt = datetime.fromisoformat(start_iso)
    end_dt = start_dt + timedelta(minutes=55)
    fmt_gcal = lambda d: d.strftime("%Y%m%dT%H%M%S")
    google_cal_url = f"https://calendar.google.com/calendar/render?action=TEMPLATE&text={cal_title}&dates={fmt_gcal(start_dt)}/{fmt_gcal(end_dt)}&location={quote('Bourguiba, Dakar, Sénégal')}"

    attachments = []
    qr_img_tag = ""
    qr_data_url = data.get("qrDataUrl")

    if qr_data_url:
        b64_data = qr_data_url.split(",", 1)[1] if "," in qr_data_url else qr_data_url
        qr_bytes = base64.b64decode(b64_data)
        attachments.append({
            "filename": "invitation-qr.png",
            "content": qr_bytes,
            "cid": "qrcode@corehouse",
        })
        qr_img_tag = '<img src="cid:qrcode@corehouse" alt="QR Code Invitation" width="220" height="220" style="display: block; margin: 0 auto;">'

    html_body = f"""
<div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #FCFAF6; color: #211A16;">
  <div style="padding: 40px 32px 24px; text-align: center; border-bottom: 1px solid rgba(127,111,76,0.12);">
    <p style="font-size: 11px; font-weight: 500; letter-spacing: 0.25em; text-transform: uppercase; color: #7F6F4C; margin: 0 0 8px;">Invitation</p>
    <h1 style="font-size: 22px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; margin: 0; color: #301905;">CORE HOUSE DAKAR</h1>
  </div>
  <div style="padding: 40px 32px; text-align: center;">
    <h2 style="font-family: Georgia, serif; font-size: 28px; font-weight: 300; color: #301905; margin: 0 0 8px; line-height: 1.2;">Bienvenue à Core House.</h2>
    <p style="font-size: 16px; color: #7F6F4C; margin: 0 0 32px;">Votre première séance est réservée.</p>
    <div style="background: #F8F4ED; border-radius: 4px; padding: 28px 24px; margin: 0 0 32px; text-align: left;">
      <h3 style="font-family: Georgia, serif; font-size: 22px; font-weight: 400; color: #301905; margin: 0 0 16px; text-align: center;">{disc['label']}</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; line-height: 2;">
        <tr><td style="color: #7F6F4C; padding: 6px 0;">Date</td><td style="text-align: right; font-weight: 500;">{date_fr}</td></tr>
        <tr><td style="color: #7F6F4C; padding: 6px 0;">Heure</td><td style="text-align: right; font-weight: 500;">{time_str}</td></tr>
        {coach_line}
        <tr><td style="color: #7F6F4C; padding: 6px 0;">Lieu</td><td style="text-align: right; font-weight: 500;">Bourguiba, Dakar</td></tr>
      </table>
    </div>
    <div style="margin: 0 0 24px; padding: 32px 24px; background: #F8F4ED; border-radius: 4px;">
      {qr_img_tag or '<p style="color: #7F6F4C; font-size: 14px;">[QR Code]</p>'}
    </div>
    <p style="font-size: 15px; color: #301905; font-weight: 500; margin: 0 0 8px;">Présentez cette invitation lors de votre arrivée.</p>
    <p style="font-size: 13px; color: #7F6F4C; margin: 0 0 32px; line-height: 1.6;">Cette invitation est personnelle et valable uniquement pour la séance indiquée.</p>
    <a href="{google_cal_url}" target="_blank" style="display: inline-block; padding: 12px 28px; background: #301905; color: #F8F4ED; text-decoration: none; font-size: 13px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; border-radius: 2px;">Ajouter à mon calendrier</a>
  </div>
  <div style="padding: 24px 32px; border-top: 1px solid rgba(127,111,76,0.12); text-align: center;">
    <p style="font-size: 13px; color: #7F6F4C; margin: 0 0 4px;">Core House Dakar</p>
    <p style="font-size: 12px; color: #7F6F4C; opacity: 0.6; margin: 0;">Bourguiba, Dakar · Mat Pilates · Yoga · Box Cardio</p>
  </div>
</div>"""

    threading.Thread(
        target=send_email,
        args=(data["email"], "Votre invitation Core House Dakar", html_body, attachments),
        daemon=True,
    ).start()

def send_confirmation_email(booking):
    disc = DISCIPLINES[booking["discipline"]]
    time_str = f"{booking['hour']:02d}:{booking.get('minute', 0):02d}"
    date_fr = format_date_fr(booking["date"])
    coach = booking.get("coach")

    db = get_db()
    count = get_participant_count(db, booking["classId"])
    db.close()

    status_msg = (
        "Votre séance est confirmée."
        if count >= MIN_PARTICIPANTS
        else "Votre réservation est enregistrée. La séance sera définitivement confirmée à partir de deux participants."
    )
    status_bg = "#E8F5E9" if count >= MIN_PARTICIPANTS else "#FFF8E1"

    coach_row = f'<tr><td style="color: #7F6F4C; padding: 2px 0;">Coach</td><td style="text-align: right; font-weight: 500;">{coach}</td></tr>' if coach else ""

    html_body = f"""
<div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #211A16;">
  <div style="padding: 32px 24px; border-bottom: 1px solid #E8E4DD;">
    <h1 style="font-size: 18px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; margin: 0; color: #301905;">CORE HOUSE DAKAR</h1>
  </div>
  <div style="padding: 32px 24px;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 24px;">Bonjour {booking['customerName']},</p>
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 24px;">Votre réservation chez Core House Dakar a bien été enregistrée.</p>
    <div style="background: #F8F4ED; border-radius: 8px; padding: 24px; margin: 0 0 24px;">
      <h2 style="font-size: 20px; font-weight: 500; margin: 0 0 16px; color: #6F3E14;">{disc['label']}</h2>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; line-height: 1.8;">
        <tr><td style="color: #7F6F4C; padding: 2px 0;">Date</td><td style="text-align: right; font-weight: 500;">{date_fr}</td></tr>
        <tr><td style="color: #7F6F4C; padding: 2px 0;">Heure</td><td style="text-align: right; font-weight: 500;">{time_str}</td></tr>
        {coach_row}
        <tr><td style="color: #7F6F4C; padding: 2px 0;">Places</td><td style="text-align: right; font-weight: 500;">{booking['places']}</td></tr>
        <tr><td style="color: #7F6F4C; padding: 2px 0;">Adresse</td><td style="text-align: right; font-weight: 500;">Bourguiba, Dakar, Sénégal</td></tr>
        <tr><td style="color: #7F6F4C; padding: 2px 0; border-top: 1px solid #D8AF82; padding-top: 8px;"><strong>Montant</strong></td><td style="text-align: right; font-weight: 600; border-top: 1px solid #D8AF82; padding-top: 8px; color: #6F3E14;">{format_price(booking['totalPrice'])}</td></tr>
      </table>
    </div>
    <p style="font-size: 15px; line-height: 1.6; margin: 0 0 32px; padding: 16px; background: {status_bg}; border-radius: 6px;">{status_msg}</p>
    <p style="font-size: 15px; line-height: 1.6; margin: 0;">À bientôt,<br><strong>Core House Dakar</strong><br><span style="color: #7F6F4C; font-size: 13px;">Mat Pilates · Yoga · Box Cardio · House Bar</span></p>
  </div>
</div>"""

    threading.Thread(
        target=send_email,
        args=(booking["customerEmail"], "Votre réservation — Core House Dakar", html_body),
        daemon=True,
    ).start()

# ── CORS ──

@app.after_request
def after_request(response):
    origin = request.headers.get("Origin", FRONTEND_URL)
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

@app.route("/api/<path:path>", methods=["OPTIONS"])
def handle_options(path):
    return "", 204

# ══════════════════════════════════════
#  API ROUTES
# ══════════════════════════════════════

# ── Health ──

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "email": bool(EMAIL_USER and EMAIL_PASS), "qrcode": QR_AVAILABLE})

# ── Schedule ──

@app.route("/api/schedule")
def schedule():
    discipline = request.args.get("discipline")
    days = min(int(request.args.get("days", 7)), 14)
    db = get_db()
    sessions = generate_schedule_sessions(db, discipline, days)
    db.close()
    return jsonify({"sessions": sessions})

# ── Staff Login ──

@app.route("/api/staff/login", methods=["POST"])
def staff_login():
    data = request.get_json(silent=True) or {}
    pin = data.get("pin", "")

    ip = request.remote_addr or "unknown"
    if not check_rate_limit(f"login:{ip}", 5, 300):
        return jsonify({"success": False, "error": "Trop de tentatives. Réessayez dans 5 minutes."}), 429

    if pin != STAFF_PIN:
        return jsonify({"success": False, "error": "Code PIN incorrect."}), 401

    token = secrets.token_hex(32)
    staff_sessions[token] = {"expires": time.time() + SESSION_DURATION_S}
    return jsonify({"success": True, "token": token})

# ── Bookings (existing system) ──

@app.route("/api/bookings", methods=["POST"])
def create_booking():
    data = request.get_json(silent=True) or {}

    required = ["classId", "discipline", "date", "hour", "name", "email", "places"]
    if not all(data.get(k) is not None for k in required):
        return jsonify({"success": False, "error": "Données manquantes."}), 400

    discipline = data["discipline"]
    if discipline not in DISCIPLINES:
        return jsonify({"success": False, "error": "Discipline invalide."}), 400

    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", data["email"]):
        return jsonify({"success": False, "error": "Adresse email invalide."}), 400

    places = int(data["places"])
    if places < 1 or places > 4:
        return jsonify({"success": False, "error": "Nombre de places invalide."}), 400

    db = get_db()
    try:
        idempotency_key = data.get("idempotencyKey")
        if idempotency_key:
            existing = db.execute("SELECT * FROM bookings WHERE idempotencyKey = ?", (idempotency_key,)).fetchone()
            if existing:
                db.close()
                return jsonify({"success": True, "bookingId": existing["id"], "status": existing["status"], "duplicate": True})

        disc = DISCIPLINES[discipline]
        max_p = disc["maxParticipants"]
        class_id = data["classId"]
        hour = int(data["hour"])
        minute = int(data.get("minute", 0))
        coach = data.get("coach")

        db.execute("""
            INSERT INTO classes (classId, discipline, date, hour, minute, coach, maxParticipants, bookedParticipants, googleCalendarEventId)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
            ON CONFLICT(classId) DO NOTHING
        """, (class_id, discipline, data["date"], hour, minute, coach, max_p))

        current_count = get_participant_count(db, class_id)
        remaining = max_p - current_count

        if remaining <= 0:
            db.close()
            return jsonify({"success": False, "error": "Ce cours est complet."}), 409
        if places > remaining:
            db.close()
            return jsonify({"success": False, "error": f"Il ne reste que {remaining} place{'s' if remaining > 1 else ''} disponible{'s' if remaining > 1 else ''} pour cette séance."}), 409

        booking_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        total_price = data.get("totalPrice", disc["price"] * places)

        db.execute("""
            INSERT INTO bookings (id, classId, discipline, date, hour, minute, coach, customerName, customerEmail, places, purchaseType, totalPrice, status, createdAt, idempotencyKey)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
        """, (booking_id, class_id, discipline, data["date"], hour, minute, coach,
              data["name"], data["email"], places, data.get("purchaseType", "single"),
              total_price, now, idempotency_key))

        db.execute("UPDATE classes SET bookedParticipants = bookedParticipants + ? WHERE classId = ?", (places, class_id))
        db.commit()

        new_total = get_participant_count(db, class_id)
        db.close()

        send_confirmation_email({
            "classId": class_id, "discipline": discipline, "date": data["date"],
            "hour": hour, "minute": minute, "coach": coach,
            "customerName": data["name"], "customerEmail": data["email"],
            "places": places, "totalPrice": total_price,
        })

        return jsonify({"success": True, "bookingId": booking_id, "status": "confirmed", "participants": new_total, "maxParticipants": max_p})

    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"success": True, "bookingId": "duplicate", "status": "confirmed", "duplicate": True})
    except Exception as e:
        db.close()
        print(f"Booking error: {e}")
        return jsonify({"success": False, "error": "Erreur serveur. Veuillez réessayer."}), 500

@app.route("/api/classes/<class_id>")
def get_class(class_id):
    db = get_db()
    row = db.execute("SELECT * FROM classes WHERE classId = ?", (class_id,)).fetchone()
    if not row:
        db.close()
        return jsonify({"participants": 0})
    count = get_participant_count(db, class_id)
    db.close()
    return jsonify({"participants": count, "maxParticipants": row["maxParticipants"]})

@app.route("/api/classes")
def get_classes():
    date = request.args.get("date")
    if not date:
        return jsonify({"error": "date query param required"}), 400
    db = get_db()
    rows = db.execute("SELECT * FROM classes WHERE date = ?", (date,)).fetchall()
    result = {}
    for r in rows:
        count = get_participant_count(db, r["classId"])
        result[r["classId"]] = {"participants": count, "maxParticipants": r["maxParticipants"]}
    db.close()
    return jsonify(result)

# ══════════════════════════════════════
#  FREE TRIAL ROUTES
# ══════════════════════════════════════

@app.route("/api/free-trial", methods=["POST"])
def create_free_trial():
    data = request.get_json(silent=True) or {}

    required = ["firstName", "lastName", "email", "phone", "discipline", "classId", "date"]
    if not all(data.get(k) for k in required) or data.get("hour") is None:
        return jsonify({"success": False, "error": "Données manquantes."}), 400

    discipline = data["discipline"]
    if discipline not in DISCIPLINES:
        return jsonify({"success": False, "error": "Discipline invalide."}), 400

    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", data["email"]):
        return jsonify({"success": False, "error": "Adresse email invalide."}), 400

    phone_clean = normalize_phone(data["phone"])
    if len(phone_clean) < 8:
        return jsonify({"success": False, "error": "Numéro de téléphone invalide."}), 400

    ip = request.remote_addr or "unknown"
    if not check_rate_limit(f"free-trial:{ip}", 3, 600):
        return jsonify({"success": False, "error": "Trop de tentatives. Veuillez réessayer plus tard."}), 429

    db = get_db()
    try:
        idempotency_key = data.get("idempotencyKey")
        if idempotency_key:
            existing = db.execute("SELECT * FROM free_invitations WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
            if existing:
                qr_data_url = None
                if QR_AVAILABLE:
                    qr_content = f"{SITE_URL}/invite/{existing['token']}" if SITE_URL else existing["token"]
                    qr_data_url = generate_qr_data_url(qr_content)
                db.close()
                return jsonify({"success": True, "token": existing["token"], "qrCodeDataUrl": qr_data_url, "duplicate": True})

        email_norm = normalize_email(data["email"])
        phone_norm = normalize_phone(data["phone"])

        existing_email = db.execute("SELECT id FROM free_customers WHERE email_normalized = ?", (email_norm,)).fetchone()
        existing_phone = db.execute("SELECT id FROM free_customers WHERE phone_normalized = ?", (phone_norm,)).fetchone()

        if existing_email or existing_phone:
            db.close()
            return jsonify({"success": False, "error": "Une invitation Core House a déjà été attribuée à ces coordonnées."}), 409

        disc = DISCIPLINES[discipline]
        max_p = disc["maxParticipants"]
        class_id = data["classId"]
        hour = int(data["hour"])
        minute = int(data.get("minute", 0))
        coach = data.get("coach")

        db.execute("""
            INSERT INTO classes (classId, discipline, date, hour, minute, coach, maxParticipants, bookedParticipants, googleCalendarEventId)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
            ON CONFLICT(classId) DO NOTHING
        """, (class_id, discipline, data["date"], hour, minute, coach, max_p))

        current_count = get_participant_count(db, class_id)
        if current_count >= max_p:
            db.close()
            return jsonify({"success": False, "error": "Cette séance est complète. Veuillez en choisir une autre."}), 409

        customer_id = str(uuid.uuid4())
        invitation_id = str(uuid.uuid4())
        token = generate_secure_token()
        now = datetime.now().isoformat()
        expires_at = datetime.strptime(data["date"], "%Y-%m-%d").replace(hour=23, minute=59, second=59).isoformat()

        db.execute("""
            INSERT INTO free_customers (id, first_name, last_name, email, phone, email_normalized, phone_normalized, marketing_consent, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (customer_id, data["firstName"].strip(), data["lastName"].strip(),
              data["email"].strip(), data["phone"].strip(), email_norm, phone_norm,
              1 if data.get("marketingConsent") else 0, now))

        db.execute("""
            INSERT INTO free_invitations (id, customer_id, class_id, discipline, date, hour, minute, coach, token, status, created_at, expires_at, idempotency_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)
        """, (invitation_id, customer_id, class_id, discipline, data["date"],
              hour, minute, coach, token, now, expires_at, idempotency_key))

        booking_id = str(uuid.uuid4())
        db.execute("""
            INSERT INTO bookings (id, classId, discipline, date, hour, minute, coach, customerName, customerEmail, places, purchaseType, totalPrice, status, createdAt, idempotencyKey)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'free_trial', 0, 'confirmed', ?, ?)
        """, (booking_id, class_id, discipline, data["date"], hour, minute, coach,
              f"{data['firstName'].strip()} {data['lastName'].strip()}", data["email"].strip(),
              now, f"ft-{idempotency_key}" if idempotency_key else None))

        db.execute("UPDATE classes SET bookedParticipants = bookedParticipants + 1 WHERE classId = ?", (class_id,))
        db.commit()
        db.close()

        qr_data_url = None
        if QR_AVAILABLE:
            qr_content = f"{SITE_URL}/invite/{token}" if SITE_URL else token
            qr_data_url = generate_qr_data_url(qr_content)

        send_invitation_email({
            "firstName": data["firstName"].strip(),
            "lastName": data["lastName"].strip(),
            "email": data["email"].strip(),
            "discipline": discipline,
            "date": data["date"],
            "hour": hour,
            "minute": minute,
            "coach": coach,
            "token": token,
            "qrDataUrl": qr_data_url,
        })

        return jsonify({"success": True, "token": token, "qrCodeDataUrl": qr_data_url})

    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"success": False, "error": "Une invitation Core House a déjà été attribuée à ces coordonnées."}), 409
    except Exception as e:
        db.close()
        print(f"Free trial error: {e}")
        return jsonify({"success": False, "error": "Erreur serveur. Veuillez réessayer."}), 500

# ── Verify Invitation (Staff) ──

@app.route("/api/free-trial/verify/<token>")
@staff_auth_required
def verify_invitation(token):
    db = get_db()
    invitation = db.execute("""
        SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
        FROM free_invitations fi
        JOIN free_customers fc ON fi.customer_id = fc.id
        WHERE fi.token = ?
    """, (token,)).fetchone()

    if not invitation:
        db.close()
        return jsonify({"valid": False, "reason": "invalid"})

    inv = dict(invitation)
    now = datetime.now()

    if inv["status"] == "booked" and inv["expires_at"]:
        try:
            if datetime.fromisoformat(inv["expires_at"]) < now:
                db.execute("UPDATE free_invitations SET status = 'expired' WHERE token = ? AND status = 'booked'", (token,))
                db.commit()
                inv["status"] = "expired"
        except ValueError:
            pass

    db.close()

    disc = DISCIPLINES.get(inv["discipline"], {})
    return jsonify({
        "valid": inv["status"] == "booked",
        "status": inv["status"],
        "firstName": inv["first_name"],
        "lastName": inv["last_name"],
        "discipline": inv["discipline"],
        "disciplineLabel": disc.get("label", inv["discipline"]),
        "date": inv["date"],
        "hour": inv["hour"],
        "minute": inv["minute"],
        "coach": inv["coach"],
        "usedAt": inv["used_at"],
        "checkedInBy": inv["checked_in_by"],
    })

# ── Check-in (Staff) ──

@app.route("/api/free-trial/checkin/<token>", methods=["POST"])
@staff_auth_required
def checkin_invitation(token):
    db = get_db()
    try:
        invitation = db.execute("""
            SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
            FROM free_invitations fi
            JOIN free_customers fc ON fi.customer_id = fc.id
            WHERE fi.token = ?
        """, (token,)).fetchone()

        if not invitation:
            db.close()
            return jsonify({"success": False, "reason": "invalid"}), 404

        inv = dict(invitation)

        if inv["status"] == "used":
            db.close()
            return jsonify({"success": False, "reason": "already_used", "usedAt": inv["used_at"],
                            "firstName": inv["first_name"], "lastName": inv["last_name"]}), 409

        if inv["status"] in ("cancelled", "expired"):
            db.close()
            return jsonify({"success": False, "reason": inv["status"]}), 409

        if inv["status"] != "booked":
            db.close()
            return jsonify({"success": False, "reason": "invalid_status", "status": inv["status"]}), 409

        now = datetime.now()
        if inv["expires_at"]:
            try:
                if datetime.fromisoformat(inv["expires_at"]) < now:
                    db.execute("UPDATE free_invitations SET status = 'expired' WHERE token = ? AND status = 'booked'", (token,))
                    db.commit()
                    db.close()
                    return jsonify({"success": False, "reason": "expired"}), 409
            except ValueError:
                pass

        cursor = db.execute(
            "UPDATE free_invitations SET status = 'used', used_at = ?, checked_in_by = 'staff' WHERE token = ? AND status = 'booked'",
            (now.isoformat(), token)
        )
        db.commit()

        if cursor.rowcount == 0:
            db.close()
            return jsonify({"success": False, "reason": "already_used"}), 409

        db.close()

        disc = DISCIPLINES.get(inv["discipline"], {})
        return jsonify({
            "success": True,
            "firstName": inv["first_name"],
            "lastName": inv["last_name"],
            "discipline": inv["discipline"],
            "disciplineLabel": disc.get("label"),
            "date": inv["date"],
            "hour": inv["hour"],
            "minute": inv["minute"],
        })

    except Exception as e:
        db.close()
        print(f"Check-in error: {e}")
        return jsonify({"success": False, "error": "Erreur serveur."}), 500

# ── Admin: List Invitations ──

@app.route("/api/free-trial/admin")
@staff_auth_required
def admin_invitations():
    filter_val = request.args.get("filter", "")
    discipline = request.args.get("discipline", "")
    search = request.args.get("search", "").strip()
    today_str = datetime.now().strftime("%Y-%m-%d")

    query = """
        SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
        FROM free_invitations fi
        JOIN free_customers fc ON fi.customer_id = fc.id
        WHERE 1=1
    """
    params = []

    if filter_val == "today":
        query += " AND fi.date = ?"
        params.append(today_str)
    elif filter_val == "upcoming":
        query += " AND fi.status = 'booked' AND fi.date >= ?"
        params.append(today_str)
    elif filter_val == "used":
        query += " AND fi.status = 'used'"
    elif filter_val == "no_show":
        query += " AND fi.status = 'expired' AND fi.date < ?"
        params.append(today_str)
    elif filter_val == "expired":
        query += " AND fi.status = 'expired'"
    elif filter_val == "cancelled":
        query += " AND fi.status = 'cancelled'"

    if discipline and discipline in DISCIPLINES:
        query += " AND fi.discipline = ?"
        params.append(discipline)

    if search:
        search_term = f"%{search}%"
        query += " AND (fc.first_name LIKE ? OR fc.last_name LIKE ? OR fc.email LIKE ? OR fc.phone LIKE ?)"
        params.extend([search_term] * 4)

    query += " ORDER BY fi.created_at DESC LIMIT 200"

    db = get_db()
    rows = db.execute(query, params).fetchall()
    db.close()

    invitations = [dict(r) for r in rows]
    return jsonify({"invitations": invitations})

# ── Admin: Stats ──

@app.route("/api/free-trial/stats")
@staff_auth_required
def admin_stats():
    db = get_db()
    today_str = datetime.now().strftime("%Y-%m-%d")

    total = db.execute("SELECT COUNT(*) as count FROM free_invitations").fetchone()["count"]
    upcoming = db.execute("SELECT COUNT(*) as count FROM free_invitations WHERE status = 'booked' AND date >= ?", (today_str,)).fetchone()["count"]

    status_rows = db.execute("SELECT status, COUNT(*) as count FROM free_invitations GROUP BY status").fetchall()
    status_counts = {r["status"]: r["count"] for r in status_rows}

    db.close()

    used = status_counts.get("used", 0)
    expired = status_counts.get("expired", 0)
    past_total = used + expired
    presence_rate = round((used / past_total) * 100) if past_total > 0 else 0

    return jsonify({
        "total": total,
        "upcoming": upcoming,
        "used": used,
        "noShow": expired,
        "cancelled": status_counts.get("cancelled", 0),
        "presenceRate": presence_rate,
    })

# ══════════════════════════════════════
#  START SERVER
# ══════════════════════════════════════

if __name__ == "__main__":
    pin_msg = "⚠️  PIN par défaut (0000) — changez STAFF_PIN dans .env" if STAFF_PIN == "0000" else "configuré"
    print(f"Core House backend (Python) sur le port {PORT}")
    print(f"Staff PIN: {pin_msg}")
    print(f"Email: {'configuré' if EMAIL_USER and EMAIL_PASS else 'non configuré'}")
    print(f"QR Code: {'activé' if QR_AVAILABLE else 'désactivé'}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
