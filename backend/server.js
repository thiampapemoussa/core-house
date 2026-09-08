require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const path = require("path");

let QRCode;
try { QRCode = require("qrcode"); } catch { QRCode = null; console.warn("qrcode package not installed — QR generation disabled. Run: npm install qrcode"); }

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

/* ═══ Database ═══ */

const db = new Database(path.join(__dirname, "bookings.db"));
db.pragma("journal_mode = WAL");

db.exec(`
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
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
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
`);

/* ═══ Free Trial Tables ═══ */

db.exec(`
  CREATE TABLE IF NOT EXISTS free_customers (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    phone_normalized TEXT NOT NULL,
    marketing_consent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
`);

const stmts = {
  getClass: db.prepare("SELECT * FROM classes WHERE classId = ?"),
  upsertClass: db.prepare(`
    INSERT INTO classes (classId, discipline, date, hour, minute, coach, maxParticipants, bookedParticipants, googleCalendarEventId)
    VALUES (@classId, @discipline, @date, @hour, @minute, @coach, @maxParticipants, 0, NULL)
    ON CONFLICT(classId) DO NOTHING
  `),
  updateClassParticipants: db.prepare("UPDATE classes SET bookedParticipants = bookedParticipants + @places WHERE classId = @classId"),
  updateClassCalendarId: db.prepare("UPDATE classes SET googleCalendarEventId = @eventId WHERE classId = @classId"),
  insertBooking: db.prepare(`
    INSERT INTO bookings (id, classId, discipline, date, hour, minute, coach, customerName, customerEmail, places, purchaseType, totalPrice, status, createdAt, idempotencyKey)
    VALUES (@id, @classId, @discipline, @date, @hour, @minute, @coach, @customerName, @customerEmail, @places, @purchaseType, @totalPrice, @status, @createdAt, @idempotencyKey)
  `),
  getBookingByIdempotency: db.prepare("SELECT * FROM bookings WHERE idempotencyKey = ?"),
  getBookingsByClass: db.prepare("SELECT customerName, places FROM bookings WHERE classId = ?"),
  getParticipantCount: db.prepare("SELECT COALESCE(SUM(places), 0) as total FROM bookings WHERE classId = ?"),
  getClassesByDate: db.prepare("SELECT * FROM classes WHERE date = ?"),
};

/* ═══ Free Trial Prepared Statements ═══ */

const freeStmts = {
  findCustomerByEmail: db.prepare("SELECT id FROM free_customers WHERE email_normalized = ?"),
  findCustomerByPhone: db.prepare("SELECT id FROM free_customers WHERE phone_normalized = ?"),
  insertCustomer: db.prepare(`
    INSERT INTO free_customers (id, first_name, last_name, email, phone, email_normalized, phone_normalized, marketing_consent, created_at)
    VALUES (@id, @first_name, @last_name, @email, @phone, @email_normalized, @phone_normalized, @marketing_consent, @created_at)
  `),
  insertInvitation: db.prepare(`
    INSERT INTO free_invitations (id, customer_id, class_id, discipline, date, hour, minute, coach, token, status, created_at, expires_at, idempotency_key)
    VALUES (@id, @customer_id, @class_id, @discipline, @date, @hour, @minute, @coach, @token, 'booked', @created_at, @expires_at, @idempotency_key)
  `),
  getInvitationByToken: db.prepare(`
    SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
    FROM free_invitations fi
    JOIN free_customers fc ON fi.customer_id = fc.id
    WHERE fi.token = ?
  `),
  getInvitationByIdempotency: db.prepare("SELECT * FROM free_invitations WHERE idempotency_key = ?"),
  checkinInvitation: db.prepare(`
    UPDATE free_invitations SET status = 'used', used_at = @used_at, checked_in_by = @checked_in_by
    WHERE token = @token AND status = 'booked'
  `),
  expireInvitation: db.prepare("UPDATE free_invitations SET status = 'expired' WHERE token = ? AND status = 'booked'"),
  cancelInvitation: db.prepare("UPDATE free_invitations SET status = 'cancelled' WHERE token = ? AND status = 'booked'"),
  getCustomerInvitations: db.prepare("SELECT * FROM free_invitations WHERE customer_id = ?"),
  getAllInvitations: db.prepare(`
    SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
    FROM free_invitations fi
    JOIN free_customers fc ON fi.customer_id = fc.id
    ORDER BY fi.created_at DESC
  `),
  getInvitationsByFilter: db.prepare(`
    SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
    FROM free_invitations fi
    JOIN free_customers fc ON fi.customer_id = fc.id
    WHERE 1=1
    ORDER BY fi.created_at DESC
  `),
  countByStatus: db.prepare("SELECT status, COUNT(*) as count FROM free_invitations GROUP BY status"),
  countTotal: db.prepare("SELECT COUNT(*) as count FROM free_invitations"),
  countUpcoming: db.prepare("SELECT COUNT(*) as count FROM free_invitations WHERE status = 'booked' AND date >= ?"),
  countUsed: db.prepare("SELECT COUNT(*) as count FROM free_invitations WHERE status = 'used'"),
};

/* ═══ Disciplines config (mirror of frontend) ═══ */

const DISCIPLINES = {
  pilates: { label: "Mat Pilates", price: 15000, maxParticipants: 12 },
  yoga: { label: "Yoga", price: 12000, maxParticipants: 12 },
  box: { label: "Box Cardio", price: 15000, maxParticipants: 6 },
};

const MIN_PARTICIPANTS = 2;

/* ═══ Class Schedule (shared with frontend) ═══ */

const CLASS_SCHEDULE = [
  { day: 1, hour: 8, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 1, hour: 9, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 1, hour: 10, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 1, hour: 11, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 1, hour: 12, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 1, hour: 13, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 1, hour: 14, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 1, hour: 15, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 1, hour: 16, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 1, hour: 17, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 1, hour: 18, minute: 0, discipline: "box", coach: null },
  { day: 1, hour: 19, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 1, hour: 20, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 1, hour: 21, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 2, hour: 8, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 2, hour: 9, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 2, hour: 10, minute: 0, discipline: "box", coach: null },
  { day: 2, hour: 11, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 2, hour: 12, minute: 0, discipline: "box", coach: null },
  { day: 2, hour: 13, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 2, hour: 14, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 2, hour: 15, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 2, hour: 16, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 2, hour: 17, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 2, hour: 18, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 2, hour: 19, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 2, hour: 20, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 2, hour: 21, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 3, hour: 8, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 3, hour: 9, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 3, hour: 10, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 3, hour: 11, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 3, hour: 12, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 3, hour: 13, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 3, hour: 14, minute: 0, discipline: "box", coach: null },
  { day: 3, hour: 15, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 3, hour: 16, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 3, hour: 17, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 3, hour: 18, minute: 0, discipline: "box", coach: null },
  { day: 3, hour: 19, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 3, hour: 20, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 3, hour: 21, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 4, hour: 8, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 4, hour: 9, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 4, hour: 10, minute: 0, discipline: "box", coach: null },
  { day: 4, hour: 11, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 4, hour: 12, minute: 0, discipline: "box", coach: null },
  { day: 4, hour: 13, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 4, hour: 14, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 4, hour: 15, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 4, hour: 16, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 4, hour: 17, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 4, hour: 18, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 4, hour: 19, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 4, hour: 20, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 4, hour: 21, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 5, hour: 8, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 5, hour: 9, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 5, hour: 10, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 5, hour: 11, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 5, hour: 12, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 5, hour: 13, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 5, hour: 14, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 5, hour: 15, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 5, hour: 16, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 5, hour: 17, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 5, hour: 18, minute: 0, discipline: "box", coach: null },
  { day: 5, hour: 19, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 5, hour: 20, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 5, hour: 21, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 6, hour: 8, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 6, hour: 9, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 6, hour: 10, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 6, hour: 11, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 6, hour: 12, minute: 0, discipline: "box", coach: null },
  { day: 6, hour: 13, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 6, hour: 14, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 6, hour: 15, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 6, hour: 16, minute: 0, discipline: "box", coach: null },
  { day: 6, hour: 17, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 6, hour: 18, minute: 0, discipline: "box", coach: null },
  { day: 6, hour: 19, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 6, hour: 20, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 6, hour: 21, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 0, hour: 8, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 0, hour: 9, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 0, hour: 10, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 0, hour: 11, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 0, hour: 12, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 0, hour: 13, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 0, hour: 14, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 0, hour: 15, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 0, hour: 16, minute: 0, discipline: "yoga", coach: "Kezia" },
  { day: 0, hour: 17, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 0, hour: 18, minute: 0, discipline: "yoga", coach: "Sophie" },
  { day: 0, hour: 19, minute: 0, discipline: "pilates", coach: "Yassine" },
  { day: 0, hour: 20, minute: 0, discipline: "pilates", coach: "Sophie" },
  { day: 0, hour: 21, minute: 0, discipline: "pilates", coach: "Yassine" },
];

/* ═══ Google Calendar ═══ */

let calendar = null;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar"]
  );
  calendar = google.calendar({ version: "v3", auth });
  console.log("Google Calendar configured.");
} else {
  console.warn("Google Calendar not configured — events will be skipped.");
}

async function upsertCalendarEvent(classData, bookings) {
  if (!calendar || !CALENDAR_ID) return null;

  const disc = DISCIPLINES[classData.discipline];
  const total = classData.bookedParticipants;
  const max = classData.maxParticipants;

  let statusText = "Places disponibles";
  if (total >= max) statusText = "Complet";
  else if (total >= MIN_PARTICIPANTS) statusText = "Cours confirmé";
  else statusText = "En attente de confirmation";

  const title = `${disc.label} — ${total}/${max}`;

  const bookingLines = bookings
    .map((b) => `• ${b.customerName} — ${b.places} place${b.places > 1 ? "s" : ""}`)
    .join("\n");

  const revenue = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const revenueStr = revenue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  const description = [
    `Discipline : ${disc.label}`,
    classData.coach ? `Coach : ${classData.coach}` : "",
    `Participants : ${total} / ${max}`,
    "",
    "Réservations :",
    bookingLines || "(aucune)",
    "",
    `Revenu réservé : ${revenueStr} XOF`,
    `Statut : ${statusText}`,
  ]
    .filter(Boolean)
    .join("\n");

  const startISO = `${classData.date}T${String(classData.hour).padStart(2, "0")}:${String(classData.minute).padStart(2, "0")}:00`;
  const startDate = new Date(startISO);
  const endDate = new Date(startDate.getTime() + 55 * 60000);

  const eventBody = {
    summary: title,
    location: "Bourguiba, Dakar, Sénégal",
    description,
    start: { dateTime: startDate.toISOString(), timeZone: "Africa/Dakar" },
    end: { dateTime: endDate.toISOString(), timeZone: "Africa/Dakar" },
  };

  try {
    if (classData.googleCalendarEventId) {
      const res = await calendar.events.update({
        calendarId: CALENDAR_ID,
        eventId: classData.googleCalendarEventId,
        requestBody: eventBody,
      });
      return res.data.id;
    } else {
      const res = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: eventBody,
      });
      return res.data.id;
    }
  } catch (err) {
    console.error("Google Calendar error:", err.message);
    return classData.googleCalendarEventId || null;
  }
}

/* ═══ Email ═══ */

let transporter = null;

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  console.log("Email transporter configured.");
} else {
  console.warn("Email not configured — emails will be skipped.");
}

function formatPrice(amount) {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " XOF";
}

function formatDateFR(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

async function sendConfirmationEmail(booking) {
  if (!transporter) return;

  const disc = DISCIPLINES[booking.discipline];
  const timeStr = `${String(booking.hour).padStart(2, "0")}:${String(booking.minute).padStart(2, "0")}`;
  const coachLine = booking.coach ? `Coach : ${booking.coach}` : "";

  const count = stmts.getParticipantCount.get(booking.classId).total;
  const statusMsg =
    count >= MIN_PARTICIPANTS
      ? "Votre séance est confirmée."
      : "Votre réservation est enregistrée. La séance sera définitivement confirmée à partir de deux participants.";

  const htmlBody = `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #211A16;">
      <div style="padding: 32px 24px; border-bottom: 1px solid #E8E4DD;">
        <h1 style="font-size: 18px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; margin: 0; color: #301905;">CORE HOUSE DAKAR</h1>
      </div>
      <div style="padding: 32px 24px;">
        <p style="font-size: 16px; line-height: 1.6; margin: 0 0 24px;">Bonjour ${booking.customerName},</p>
        <p style="font-size: 16px; line-height: 1.6; margin: 0 0 24px;">Votre réservation chez Core House Dakar a bien été enregistrée.</p>
        <div style="background: #F8F4ED; border-radius: 8px; padding: 24px; margin: 0 0 24px;">
          <h2 style="font-size: 20px; font-weight: 500; margin: 0 0 16px; color: #6F3E14;">${disc.label}</h2>
          <table style="width: 100%; border-collapse: collapse; font-size: 15px; line-height: 1.8;">
            <tr><td style="color: #7F6F4C; padding: 2px 0;">Date</td><td style="text-align: right; font-weight: 500;">${formatDateFR(booking.date)}</td></tr>
            <tr><td style="color: #7F6F4C; padding: 2px 0;">Heure</td><td style="text-align: right; font-weight: 500;">${timeStr}</td></tr>
            ${coachLine ? `<tr><td style="color: #7F6F4C; padding: 2px 0;">Coach</td><td style="text-align: right; font-weight: 500;">${booking.coach}</td></tr>` : ""}
            <tr><td style="color: #7F6F4C; padding: 2px 0;">Places</td><td style="text-align: right; font-weight: 500;">${booking.places}</td></tr>
            <tr><td style="color: #7F6F4C; padding: 2px 0;">Adresse</td><td style="text-align: right; font-weight: 500;">Bourguiba, Dakar, Sénégal</td></tr>
            <tr><td style="color: #7F6F4C; padding: 2px 0; border-top: 1px solid #D8AF82; padding-top: 8px; margin-top: 8px;"><strong>Montant</strong></td><td style="text-align: right; font-weight: 600; border-top: 1px solid #D8AF82; padding-top: 8px; color: #6F3E14;">${formatPrice(booking.totalPrice)}</td></tr>
          </table>
        </div>
        <p style="font-size: 15px; line-height: 1.6; margin: 0 0 32px; padding: 16px; background: ${count >= MIN_PARTICIPANTS ? "#E8F5E9" : "#FFF8E1"}; border-radius: 6px;">
          ${statusMsg}
        </p>
        <p style="font-size: 15px; line-height: 1.6; margin: 0;">À bientôt,<br><strong>Core House Dakar</strong><br><span style="color: #7F6F4C; font-size: 13px;">Mat Pilates · Yoga · Box Cardio · House Bar</span></p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "Core House Dakar <core21.lab@gmail.com>",
      to: booking.customerEmail,
      subject: "Votre réservation — Core House Dakar",
      html: htmlBody,
    });
    console.log(`Email sent to ${booking.customerEmail}`);
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

/* ═══ Rate Limiting ═══ */

const rateLimitStore = new Map();

function checkRateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const record = rateLimitStore.get(key);
  if (!record || now - record.start > windowMs) {
    rateLimitStore.set(key, { start: now, count: 1 });
    return true;
  }
  if (record.count >= maxAttempts) return false;
  record.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore) {
    if (now - record.start > 3600000) rateLimitStore.delete(key);
  }
}, 600000);

/* ═══ Staff Authentication ═══ */

const STAFF_PIN = process.env.STAFF_PIN || "0000";
const staffSessions = new Map();
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function validateStaffAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const session = staffSessions.get(token);
  if (!session || Date.now() > session.expires) {
    staffSessions.delete(token);
    return false;
  }
  return true;
}

function staffAuth(req, res, next) {
  if (!validateStaffAuth(req)) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }
  next();
}

/* ═══ Utilities ═══ */

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function normalizePhone(phone) {
  return phone.replace(/[\s\-\.\(\)]/g, "").replace(/^00/, "+");
}

function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getClassId(dateStr, hour, minute, discipline) {
  return `${dateStr}-${hour}${minute > 0 ? ":" + minute : ""}-${discipline}`;
}

function generateScheduleSessions(discipline, days) {
  const sessions = [];
  const now = new Date();

  for (let d = 0; d < days; d++) {
    const date = new Date(now);
    date.setDate(now.getDate() + d);
    date.setHours(0, 0, 0, 0);
    const dayOfWeek = date.getDay();
    const dateStr = date.toISOString().split("T")[0];

    const dayClasses = CLASS_SCHEDULE.filter(
      (c) => c.day === dayOfWeek && (!discipline || c.discipline === discipline)
    );

    for (const cls of dayClasses) {
      if (d === 0) {
        const classTime = new Date(date);
        classTime.setHours(cls.hour, cls.minute || 0);
        if (classTime <= now) continue;
      }

      const classId = getClassId(dateStr, cls.hour, cls.minute || 0, cls.discipline);
      const disc = DISCIPLINES[cls.discipline];
      const classRow = stmts.getClass.get(classId);
      const currentCount = classRow
        ? stmts.getParticipantCount.get(classId).total
        : 0;
      const maxP = disc.maxParticipants;

      sessions.push({
        classId,
        date: dateStr,
        hour: cls.hour,
        minute: cls.minute || 0,
        discipline: cls.discipline,
        disciplineLabel: disc.label,
        coach: cls.coach,
        maxParticipants: maxP,
        currentParticipants: currentCount,
        available: currentCount < maxP,
      });
    }
  }

  return sessions;
}

/* ═══ Existing API Routes ═══ */

app.post("/api/bookings", async (req, res) => {
  try {
    const { classId, discipline, date, hour, minute, coach, name, email, places, purchaseType, totalPrice, idempotencyKey } = req.body;

    if (!classId || !discipline || !date || hour === undefined || !name || !email || !places) {
      return res.status(400).json({ success: false, error: "Données manquantes." });
    }

    if (!DISCIPLINES[discipline]) {
      return res.status(400).json({ success: false, error: "Discipline invalide." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: "Adresse email invalide." });
    }

    if (places < 1 || places > 4) {
      return res.status(400).json({ success: false, error: "Nombre de places invalide." });
    }

    if (idempotencyKey) {
      const existing = stmts.getBookingByIdempotency.get(idempotencyKey);
      if (existing) {
        return res.json({ success: true, bookingId: existing.id, status: existing.status, duplicate: true });
      }
    }

    const disc = DISCIPLINES[discipline];
    const maxP = disc.maxParticipants;

    stmts.upsertClass.run({
      classId,
      discipline,
      date,
      hour,
      minute: minute || 0,
      coach: coach || null,
      maxParticipants: maxP,
    });

    const classRow = stmts.getClass.get(classId);
    const currentCount = stmts.getParticipantCount.get(classId).total;
    const remaining = maxP - currentCount;

    if (remaining <= 0) {
      return res.status(409).json({ success: false, error: "Ce cours est complet." });
    }
    if (places > remaining) {
      return res.status(409).json({
        success: false,
        error: `Il ne reste que ${remaining} place${remaining > 1 ? "s" : ""} disponible${remaining > 1 ? "s" : ""} pour cette séance.`,
      });
    }

    const bookingId = uuidv4();
    const now = new Date().toISOString();

    const booking = {
      id: bookingId,
      classId,
      discipline,
      date,
      hour,
      minute: minute || 0,
      coach: coach || null,
      customerName: name,
      customerEmail: email,
      places,
      purchaseType: purchaseType || "single",
      totalPrice: totalPrice || disc.price * places,
      status: "confirmed",
      createdAt: now,
      idempotencyKey: idempotencyKey || null,
    };

    stmts.insertBooking.run(booking);
    stmts.updateClassParticipants.run({ classId, places });

    const updatedClass = stmts.getClass.get(classId);
    const allBookings = stmts.getBookingsByClass.all(classId);
    const newTotal = stmts.getParticipantCount.get(classId).total;

    const eventId = await upsertCalendarEvent(updatedClass, allBookings);
    if (eventId && eventId !== updatedClass.googleCalendarEventId) {
      stmts.updateClassCalendarId.run({ eventId, classId });
    }

    await sendConfirmationEmail(booking);

    res.json({
      success: true,
      bookingId,
      status: "confirmed",
      participants: newTotal,
      maxParticipants: maxP,
    });
  } catch (err) {
    console.error("Booking error:", err);
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.json({ success: true, bookingId: "duplicate", status: "confirmed", duplicate: true });
    }
    res.status(500).json({ success: false, error: "Erreur serveur. Veuillez réessayer." });
  }
});

app.get("/api/classes/:classId", (req, res) => {
  const { classId } = req.params;
  const row = stmts.getClass.get(classId);
  if (!row) {
    return res.json({ participants: 0 });
  }
  const count = stmts.getParticipantCount.get(classId).total;
  res.json({
    participants: count,
    maxParticipants: row.maxParticipants,
  });
});

app.get("/api/classes", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date query param required" });
  const rows = stmts.getClassesByDate.all(date);
  const result = {};
  rows.forEach((r) => {
    const count = stmts.getParticipantCount.get(r.classId).total;
    result[r.classId] = { participants: count, maxParticipants: r.maxParticipants };
  });
  res.json(result);
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", calendar: !!calendar, email: !!transporter, qrcode: !!QRCode });
});

/* ═══ Schedule API ═══ */

app.get("/api/schedule", (req, res) => {
  const { discipline, days } = req.query;
  const numDays = Math.min(parseInt(days) || 7, 14);
  const validDiscipline = discipline && DISCIPLINES[discipline] ? discipline : null;
  const sessions = generateScheduleSessions(validDiscipline, numDays);
  res.json({ sessions });
});

/* ═══ Staff Login ═══ */

app.post("/api/staff/login", (req, res) => {
  const { pin } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!checkRateLimit(`staff-login:${ip}`, 5, 300000)) {
    return res.status(429).json({ success: false, error: "Trop de tentatives. Réessayez dans 5 minutes." });
  }

  if (!pin || pin !== STAFF_PIN) {
    return res.status(401).json({ success: false, error: "Code incorrect." });
  }

  const token = generateSecureToken();
  staffSessions.set(token, { expires: Date.now() + SESSION_DURATION_MS, ip });

  res.json({ success: true, token });
});

/* ═══ Free Trial API ═══ */

app.post("/api/free-trial", async (req, res) => {
  try {
    const { firstName, lastName, email, phone, marketingConsent, discipline, classId, date, hour, minute, coach, idempotencyKey } = req.body;

    if (!firstName || !lastName || !email || !phone || !discipline || !classId || !date || hour === undefined) {
      return res.status(400).json({ success: false, error: "Données manquantes." });
    }

    if (!DISCIPLINES[discipline]) {
      return res.status(400).json({ success: false, error: "Discipline invalide." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: "Adresse email invalide." });
    }

    const phoneClean = normalizePhone(phone);
    if (phoneClean.length < 8) {
      return res.status(400).json({ success: false, error: "Numéro de téléphone invalide." });
    }

    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(`free-trial:${ip}`, 3, 600000)) {
      return res.status(429).json({ success: false, error: "Trop de tentatives. Veuillez réessayer plus tard." });
    }

    if (idempotencyKey) {
      const existing = freeStmts.getInvitationByIdempotency.get(idempotencyKey);
      if (existing) {
        const inv = freeStmts.getInvitationByToken.get(existing.token);
        let qrDataUrl = null;
        if (QRCode) {
          const siteUrl = process.env.SITE_URL || "";
          const qrContent = siteUrl ? `${siteUrl}/invite/${existing.token}` : existing.token;
          qrDataUrl = await QRCode.toDataURL(qrContent, { width: 400, margin: 2, color: { dark: "#301905", light: "#F8F4ED" } });
        }
        return res.json({ success: true, token: existing.token, qrCodeDataUrl: qrDataUrl, duplicate: true });
      }
    }

    const emailNorm = normalizeEmail(email);
    const phoneNorm = normalizePhone(phone);

    const existingByEmail = freeStmts.findCustomerByEmail.get(emailNorm);
    const existingByPhone = freeStmts.findCustomerByPhone.get(phoneNorm);

    if (existingByEmail || existingByPhone) {
      return res.status(409).json({
        success: false,
        error: "Une invitation Core House a déjà été attribuée à ces coordonnées.",
      });
    }

    const disc = DISCIPLINES[discipline];
    const maxP = disc.maxParticipants;

    stmts.upsertClass.run({
      classId,
      discipline,
      date,
      hour,
      minute: minute || 0,
      coach: coach || null,
      maxParticipants: maxP,
    });

    const currentCount = stmts.getParticipantCount.get(classId).total;
    if (currentCount >= maxP) {
      return res.status(409).json({ success: false, error: "Cette séance est complète. Veuillez en choisir une autre." });
    }

    const customerId = uuidv4();
    const invitationId = uuidv4();
    const token = generateSecureToken();
    const now = new Date().toISOString();
    const expiresAt = new Date(date + "T23:59:59").toISOString();

    const createInvitation = db.transaction(() => {
      freeStmts.insertCustomer.run({
        id: customerId,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        email_normalized: emailNorm,
        phone_normalized: phoneNorm,
        marketing_consent: marketingConsent ? 1 : 0,
        created_at: now,
      });

      freeStmts.insertInvitation.run({
        id: invitationId,
        customer_id: customerId,
        class_id: classId,
        discipline,
        date,
        hour,
        minute: minute || 0,
        coach: coach || null,
        token,
        created_at: now,
        expires_at: expiresAt,
        idempotency_key: idempotencyKey || null,
      });

      stmts.insertBooking.run({
        id: uuidv4(),
        classId,
        discipline,
        date,
        hour,
        minute: minute || 0,
        coach: coach || null,
        customerName: `${firstName.trim()} ${lastName.trim()}`,
        customerEmail: email.trim(),
        places: 1,
        purchaseType: "free_trial",
        totalPrice: 0,
        status: "confirmed",
        createdAt: now,
        idempotencyKey: idempotencyKey ? `ft-${idempotencyKey}` : null,
      });

      stmts.updateClassParticipants.run({ classId, places: 1 });
    });

    createInvitation();

    let qrDataUrl = null;
    if (QRCode) {
      const siteUrl = process.env.SITE_URL || "";
      const qrContent = siteUrl ? `${siteUrl}/invite/${token}` : token;
      qrDataUrl = await QRCode.toDataURL(qrContent, { width: 400, margin: 2, color: { dark: "#301905", light: "#F8F4ED" } });
    }

    sendInvitationEmail({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      discipline,
      date,
      hour,
      minute: minute || 0,
      coach,
      token,
      qrDataUrl,
    }).catch((err) => console.error("Invitation email error:", err.message));

    res.json({ success: true, token, qrCodeDataUrl: qrDataUrl });
  } catch (err) {
    console.error("Free trial error:", err);
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        success: false,
        error: "Une invitation Core House a déjà été attribuée à ces coordonnées.",
      });
    }
    res.status(500).json({ success: false, error: "Erreur serveur. Veuillez réessayer." });
  }
});

/* ═══ Verify Invitation (Staff) ═══ */

app.get("/api/free-trial/verify/:token", staffAuth, (req, res) => {
  const { token } = req.params;
  const invitation = freeStmts.getInvitationByToken.get(token);

  if (!invitation) {
    return res.json({ valid: false, reason: "invalid" });
  }

  const now = new Date();
  if (invitation.status === "booked" && invitation.expires_at && new Date(invitation.expires_at) < now) {
    freeStmts.expireInvitation.run(token);
    invitation.status = "expired";
  }

  res.json({
    valid: invitation.status === "booked",
    status: invitation.status,
    firstName: invitation.first_name,
    lastName: invitation.last_name,
    discipline: invitation.discipline,
    disciplineLabel: DISCIPLINES[invitation.discipline]?.label || invitation.discipline,
    date: invitation.date,
    hour: invitation.hour,
    minute: invitation.minute,
    coach: invitation.coach,
    usedAt: invitation.used_at,
    checkedInBy: invitation.checked_in_by,
  });
});

/* ═══ Check-in (Staff) ═══ */

app.post("/api/free-trial/checkin/:token", staffAuth, (req, res) => {
  const { token } = req.params;

  const checkin = db.transaction(() => {
    const invitation = freeStmts.getInvitationByToken.get(token);

    if (!invitation) {
      return { success: false, reason: "invalid" };
    }

    if (invitation.status === "used") {
      return {
        success: false,
        reason: "already_used",
        usedAt: invitation.used_at,
        firstName: invitation.first_name,
        lastName: invitation.last_name,
      };
    }

    if (invitation.status === "cancelled") {
      return { success: false, reason: "cancelled" };
    }

    if (invitation.status === "expired") {
      return { success: false, reason: "expired" };
    }

    if (invitation.status !== "booked") {
      return { success: false, reason: "invalid_status", status: invitation.status };
    }

    const now = new Date();
    if (invitation.expires_at && new Date(invitation.expires_at) < now) {
      freeStmts.expireInvitation.run(token);
      return { success: false, reason: "expired" };
    }

    const result = freeStmts.checkinInvitation.run({
      token,
      used_at: now.toISOString(),
      checked_in_by: "staff",
    });

    if (result.changes === 0) {
      return { success: false, reason: "already_used" };
    }

    return {
      success: true,
      firstName: invitation.first_name,
      lastName: invitation.last_name,
      discipline: invitation.discipline,
      disciplineLabel: DISCIPLINES[invitation.discipline]?.label,
      date: invitation.date,
      hour: invitation.hour,
      minute: invitation.minute,
    };
  });

  const result = checkin();
  if (!result.success) {
    return res.status(result.reason === "invalid" ? 404 : 409).json(result);
  }
  res.json(result);
});

/* ═══ Admin: List Invitations ═══ */

app.get("/api/free-trial/admin", staffAuth, (req, res) => {
  const { filter, discipline, search } = req.query;
  const todayStr = new Date().toISOString().split("T")[0];

  let query = `
    SELECT fi.*, fc.first_name, fc.last_name, fc.email, fc.phone
    FROM free_invitations fi
    JOIN free_customers fc ON fi.customer_id = fc.id
    WHERE 1=1
  `;
  const params = [];

  if (filter === "today") {
    query += " AND fi.date = ?";
    params.push(todayStr);
  } else if (filter === "upcoming") {
    query += " AND fi.status = 'booked' AND fi.date >= ?";
    params.push(todayStr);
  } else if (filter === "used") {
    query += " AND fi.status = 'used'";
  } else if (filter === "no_show") {
    query += " AND fi.status = 'expired' AND fi.date < ?";
    params.push(todayStr);
  } else if (filter === "expired") {
    query += " AND fi.status = 'expired'";
  } else if (filter === "cancelled") {
    query += " AND fi.status = 'cancelled'";
  }

  if (discipline && DISCIPLINES[discipline]) {
    query += " AND fi.discipline = ?";
    params.push(discipline);
  }

  if (search) {
    const searchTerm = `%${search.trim()}%`;
    query += " AND (fc.first_name LIKE ? OR fc.last_name LIKE ? OR fc.email LIKE ? OR fc.phone LIKE ?)";
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  query += " ORDER BY fi.created_at DESC LIMIT 200";

  const stmt = db.prepare(query);
  const invitations = stmt.all(...params);

  res.json({ invitations });
});

/* ═══ Admin: Stats ═══ */

app.get("/api/free-trial/stats", staffAuth, (req, res) => {
  const todayStr = new Date().toISOString().split("T")[0];

  const total = freeStmts.countTotal.get().count;
  const upcoming = freeStmts.countUpcoming.get(todayStr).count;
  const used = freeStmts.countUsed.get().count;

  const statusCounts = {};
  for (const row of freeStmts.countByStatus.all()) {
    statusCounts[row.status] = row.count;
  }

  const pastTotal = (statusCounts.used || 0) + (statusCounts.expired || 0);
  const presenceRate = pastTotal > 0 ? Math.round(((statusCounts.used || 0) / pastTotal) * 100) : 0;

  res.json({
    total,
    upcoming,
    used: statusCounts.used || 0,
    noShow: statusCounts.expired || 0,
    cancelled: statusCounts.cancelled || 0,
    presenceRate,
  });
});

/* ═══ Free Trial Invitation Email ═══ */

async function sendInvitationEmail({ firstName, lastName, email, discipline, date, hour, minute, coach, token, qrDataUrl }) {
  if (!transporter) {
    console.warn("Email not configured — invitation email skipped.");
    return;
  }

  const disc = DISCIPLINES[discipline];
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}`;
  const dateFR = formatDateFR(date);
  const coachLine = coach ? `<tr><td style="color: #7F6F4C; padding: 6px 0;">Coach</td><td style="text-align: right; font-weight: 500;">${coach}</td></tr>` : "";

  const siteUrl = process.env.SITE_URL || "";
  const calendarTitle = encodeURIComponent(`${disc.label} — Core House Dakar`);
  const startISO = `${date}T${String(hour).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}:00`;
  const startDate = new Date(startISO);
  const endDate = new Date(startDate.getTime() + 55 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  const fmtGCal = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
  const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${calendarTitle}&dates=${fmtGCal(startDate)}/${fmtGCal(endDate)}&location=${encodeURIComponent("Bourguiba, Dakar, Sénégal")}`;

  const attachments = [];
  let qrImgTag = "";

  if (qrDataUrl) {
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    attachments.push({
      filename: "invitation-qr.png",
      content: Buffer.from(base64Data, "base64"),
      cid: "qrcode@corehouse",
    });
    qrImgTag = `<img src="cid:qrcode@corehouse" alt="QR Code Invitation" width="220" height="220" style="display: block; margin: 0 auto;">`;
  }

  const htmlBody = `
<div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #FCFAF6; color: #211A16;">
  <div style="padding: 40px 32px 24px; text-align: center; border-bottom: 1px solid rgba(127,111,76,0.12);">
    <p style="font-size: 11px; font-weight: 500; letter-spacing: 0.25em; text-transform: uppercase; color: #7F6F4C; margin: 0 0 8px;">Invitation</p>
    <h1 style="font-size: 22px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; margin: 0; color: #301905;">CORE HOUSE DAKAR</h1>
  </div>

  <div style="padding: 40px 32px; text-align: center;">
    <h2 style="font-family: Georgia, serif; font-size: 28px; font-weight: 300; color: #301905; margin: 0 0 8px; line-height: 1.2;">Bienvenue à Core House.</h2>
    <p style="font-size: 16px; color: #7F6F4C; margin: 0 0 32px;">Votre première séance est réservée.</p>

    <div style="background: #F8F4ED; border-radius: 4px; padding: 28px 24px; margin: 0 0 32px; text-align: left;">
      <h3 style="font-family: Georgia, serif; font-size: 22px; font-weight: 400; color: #301905; margin: 0 0 16px; text-align: center;">${disc.label}</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; line-height: 2;">
        <tr><td style="color: #7F6F4C; padding: 6px 0;">Date</td><td style="text-align: right; font-weight: 500;">${dateFR}</td></tr>
        <tr><td style="color: #7F6F4C; padding: 6px 0;">Heure</td><td style="text-align: right; font-weight: 500;">${timeStr}</td></tr>
        ${coachLine}
        <tr><td style="color: #7F6F4C; padding: 6px 0;">Lieu</td><td style="text-align: right; font-weight: 500;">Bourguiba, Dakar</td></tr>
      </table>
    </div>

    <div style="margin: 0 0 24px; padding: 32px 24px; background: #F8F4ED; border-radius: 4px;">
      ${qrImgTag || '<p style="color: #7F6F4C; font-size: 14px;">[QR Code]</p>'}
    </div>

    <p style="font-size: 15px; color: #301905; font-weight: 500; margin: 0 0 8px;">Présentez cette invitation lors de votre arrivée.</p>
    <p style="font-size: 13px; color: #7F6F4C; margin: 0 0 32px; line-height: 1.6;">Cette invitation est personnelle et valable uniquement pour la séance indiquée.</p>

    <a href="${googleCalUrl}" target="_blank" style="display: inline-block; padding: 12px 28px; background: #301905; color: #F8F4ED; text-decoration: none; font-size: 13px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; border-radius: 2px;">Ajouter à mon calendrier</a>
  </div>

  <div style="padding: 24px 32px; border-top: 1px solid rgba(127,111,76,0.12); text-align: center;">
    <p style="font-size: 13px; color: #7F6F4C; margin: 0 0 4px;">Core House Dakar</p>
    <p style="font-size: 12px; color: #7F6F4C; opacity: 0.6; margin: 0;">Bourguiba, Dakar · Mat Pilates · Yoga · Box Cardio</p>
  </div>
</div>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "Core House Dakar <core21.lab@gmail.com>",
      to: email,
      subject: "Votre invitation Core House Dakar",
      html: htmlBody,
      attachments,
    });
    console.log(`Invitation email sent to ${email}`);
  } catch (err) {
    console.error("Invitation email error:", err.message);
  }
}

/* ═══ Start Server ═══ */

app.listen(PORT, () => {
  console.log(`Core House backend running on port ${PORT}`);
  console.log(`Staff PIN: ${STAFF_PIN === "0000" ? "⚠️  Using default PIN (0000) — set STAFF_PIN in .env" : "configured"}`);
});
