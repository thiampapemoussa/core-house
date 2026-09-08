import express from "express";
import serverless from "serverless-http";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import crypto from "node:crypto";

const app = express();
app.use(express.json());

/* ═══ Supabase ═══ */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ═══ Disciplines (mirror of frontend) ═══ */

const DISCIPLINES = {
  pilates: { label: "Mat Pilates", price: 15000, maxParticipants: 12 },
  yoga: { label: "Yoga", price: 12000, maxParticipants: 12 },
  box: { label: "Box Cardio", price: 15000, maxParticipants: 6 },
};

const MIN_PARTICIPANTS = 2;

/* ═══ Class Schedule ═══ */

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

/* ═══ Google Calendar (JWT + direct API, no googleapis dependency) ═══ */

let cachedToken = null;
let tokenExpiry = 0;

function createGoogleJWT(clientEmail, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey, "base64url");
  return `${input}.${signature}`;
}

async function getGoogleAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) return null;
  try {
    const jwt = createGoogleJWT(email, key);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    if (!res.ok) return null;
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return cachedToken;
  } catch { return null; }
}

async function upsertCalendarEvent(classData, bookings) {
  const token = await getGoogleAccessToken();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!token || !calendarId) return null;

  const disc = DISCIPLINES[classData.discipline];
  const total = bookings.reduce((s, b) => s + b.places, 0);
  const max = classData.max_participants;
  const statusText = total >= max ? "Complet" : total >= MIN_PARTICIPANTS ? "Cours confirmé" : "En attente de confirmation";
  const bookingLines = bookings.map(b => `• ${b.customer_name} — ${b.places} place${b.places > 1 ? "s" : ""}`).join("\n");
  const revenue = bookings.reduce((s, b) => s + b.total_price, 0);
  const revenueStr = revenue.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  const description = [
    `Discipline : ${disc.label}`,
    classData.coach ? `Coach : ${classData.coach}` : "",
    `Participants : ${total} / ${max}`,
    "", "Réservations :", bookingLines || "(aucune)",
    "", `Revenu réservé : ${revenueStr} XOF`, `Statut : ${statusText}`,
  ].filter(Boolean).join("\n");

  const pad = (n) => String(n).padStart(2, "0");
  const startISO = `${classData.date}T${pad(classData.hour)}:${pad(classData.minute)}:00`;
  const startDate = new Date(startISO);
  const endDate = new Date(startDate.getTime() + 55 * 60000);

  const eventBody = {
    summary: `${disc.label} — ${total}/${max}`,
    location: "Bourguiba, Dakar, Sénégal",
    description,
    start: { dateTime: startDate.toISOString(), timeZone: "Africa/Dakar" },
    end: { dateTime: endDate.toISOString(), timeZone: "Africa/Dakar" },
  };

  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    if (classData.google_calendar_event_id) {
      const res = await fetch(`${base}/${classData.google_calendar_event_id}`, { method: "PUT", headers, body: JSON.stringify(eventBody) });
      return (await res.json()).id || classData.google_calendar_event_id;
    } else {
      const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(eventBody) });
      return (await res.json()).id || null;
    }
  } catch { return classData.google_calendar_event_id || null; }
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
}

function formatPrice(amount) {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " XOF";
}

function formatDateFR(dateStr) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

async function sendConfirmationEmail(booking, participantCount) {
  if (!transporter) return;
  const disc = DISCIPLINES[booking.discipline];
  const timeStr = `${String(booking.hour).padStart(2, "0")}:${String(booking.minute).padStart(2, "0")}`;
  const coachLine = booking.coach ? `<tr><td style="color:#7F6F4C;padding:2px 0">Coach</td><td style="text-align:right;font-weight:500">${booking.coach}</td></tr>` : "";
  const statusMsg = participantCount >= MIN_PARTICIPANTS
    ? "Votre séance est confirmée."
    : "Votre réservation est enregistrée. La séance sera définitivement confirmée à partir de deux participants.";
  const statusBg = participantCount >= MIN_PARTICIPANTS ? "#E8F5E9" : "#FFF8E1";

  const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;color:#211A16">
<div style="padding:32px 24px;border-bottom:1px solid #E8E4DD"><h1 style="font-size:18px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;margin:0;color:#301905">CORE HOUSE DAKAR</h1></div>
<div style="padding:32px 24px">
<p style="font-size:16px;line-height:1.6;margin:0 0 24px">Bonjour ${booking.customer_name},</p>
<p style="font-size:16px;line-height:1.6;margin:0 0 24px">Votre réservation chez Core House Dakar a bien été enregistrée.</p>
<div style="background:#F8F4ED;border-radius:8px;padding:24px;margin:0 0 24px">
<h2 style="font-size:20px;font-weight:500;margin:0 0 16px;color:#6F3E14">${disc.label}</h2>
<table style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.8">
<tr><td style="color:#7F6F4C;padding:2px 0">Date</td><td style="text-align:right;font-weight:500">${formatDateFR(booking.date)}</td></tr>
<tr><td style="color:#7F6F4C;padding:2px 0">Heure</td><td style="text-align:right;font-weight:500">${timeStr}</td></tr>
${coachLine}
<tr><td style="color:#7F6F4C;padding:2px 0">Places</td><td style="text-align:right;font-weight:500">${booking.places}</td></tr>
<tr><td style="color:#7F6F4C;padding:2px 0">Adresse</td><td style="text-align:right;font-weight:500">Bourguiba, Dakar, Sénégal</td></tr>
<tr><td style="color:#7F6F4C;padding:2px 0;border-top:1px solid #D8AF82;padding-top:8px"><strong>Montant</strong></td><td style="text-align:right;font-weight:600;border-top:1px solid #D8AF82;padding-top:8px;color:#6F3E14">${formatPrice(booking.total_price)}</td></tr>
</table></div>
<p style="font-size:15px;line-height:1.6;margin:0 0 32px;padding:16px;background:${statusBg};border-radius:6px">${statusMsg}</p>
<p style="font-size:15px;line-height:1.6;margin:0">À bientôt,<br><strong>Core House Dakar</strong><br><span style="color:#7F6F4C;font-size:13px">Mat Pilates · Yoga · Box Cardio · House Bar</span></p>
</div></div>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "Core House Dakar <core21.lab@gmail.com>",
      to: booking.customer_email,
      subject: "Votre réservation — Core House Dakar",
      html,
    });
  } catch (err) { console.error("Email error:", err.message); }
}

async function sendInvitationEmail({ firstName, lastName, email, discipline, date, hour, minute, coach }) {
  if (!transporter) return;
  const disc = DISCIPLINES[discipline];
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}`;
  const dateFR = formatDateFR(date);
  const coachLine = coach ? `<tr><td style="color:#7F6F4C;padding:6px 0">Coach</td><td style="text-align:right;font-weight:500">${coach}</td></tr>` : "";

  const calTitle = encodeURIComponent(`${disc.label} — Core House Dakar`);
  const pad = (n) => String(n).padStart(2, "0");
  const startDate = new Date(`${date}T${pad(hour)}:${pad(minute || 0)}:00`);
  const endDate = new Date(startDate.getTime() + 55 * 60000);
  const fmtG = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
  const gCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${calTitle}&dates=${fmtG(startDate)}/${fmtG(endDate)}&location=${encodeURIComponent("Bourguiba, Dakar, Sénégal")}`;

  const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#FCFAF6;color:#211A16">
<div style="padding:40px 32px 24px;text-align:center;border-bottom:1px solid rgba(127,111,76,0.12)">
<p style="font-size:11px;font-weight:500;letter-spacing:0.25em;text-transform:uppercase;color:#7F6F4C;margin:0 0 8px">Invitation</p>
<h1 style="font-size:22px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;margin:0;color:#301905">CORE HOUSE DAKAR</h1></div>
<div style="padding:40px 32px;text-align:center">
<h2 style="font-family:Georgia,serif;font-size:28px;font-weight:300;color:#301905;margin:0 0 8px;line-height:1.2">Bienvenue à Core House.</h2>
<p style="font-size:16px;color:#7F6F4C;margin:0 0 32px">Votre première séance est réservée.</p>
<div style="background:#F8F4ED;border-radius:4px;padding:28px 24px;margin:0 0 32px;text-align:left">
<h3 style="font-family:Georgia,serif;font-size:22px;font-weight:400;color:#301905;margin:0 0 16px;text-align:center">${disc.label}</h3>
<table style="width:100%;border-collapse:collapse;font-size:15px;line-height:2">
<tr><td style="color:#7F6F4C;padding:6px 0">Date</td><td style="text-align:right;font-weight:500">${dateFR}</td></tr>
<tr><td style="color:#7F6F4C;padding:6px 0">Heure</td><td style="text-align:right;font-weight:500">${timeStr}</td></tr>
${coachLine}
<tr><td style="color:#7F6F4C;padding:6px 0">Lieu</td><td style="text-align:right;font-weight:500">Bourguiba, Dakar</td></tr>
</table></div>
<p style="font-size:15px;color:#301905;font-weight:500;margin:0 0 8px">Présentez cette invitation lors de votre arrivée.</p>
<p style="font-size:13px;color:#7F6F4C;margin:0 0 32px;line-height:1.6">Cette invitation est personnelle et valable uniquement pour la séance indiquée.</p>
<a href="${gCalUrl}" target="_blank" style="display:inline-block;padding:12px 28px;background:#301905;color:#F8F4ED;text-decoration:none;font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;border-radius:2px">Ajouter à mon calendrier</a>
</div>
<div style="padding:24px 32px;border-top:1px solid rgba(127,111,76,0.12);text-align:center">
<p style="font-size:13px;color:#7F6F4C;margin:0 0 4px">Core House Dakar</p>
<p style="font-size:12px;color:#7F6F4C;opacity:0.6;margin:0">Bourguiba, Dakar · Mat Pilates · Yoga · Box Cardio</p>
</div></div>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "Core House Dakar <core21.lab@gmail.com>",
      to: email,
      subject: "Votre invitation Core House Dakar",
      html,
    });
  } catch (err) { console.error("Invitation email error:", err.message); }
}

/* ═══ Staff Auth (stateless JWT) ═══ */

const STAFF_PIN = process.env.STAFF_PIN || "0000";
const STAFF_SECRET = process.env.STAFF_SECRET || STAFF_PIN;

function signStaffToken() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role: "staff", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 28800 })).toString("base64url");
  const sig = crypto.createHmac("sha256", STAFF_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function verifyStaffToken(token) {
  try {
    const [h, p, s] = token.split(".");
    const expected = crypto.createHmac("sha256", STAFF_SECRET).update(`${h}.${p}`).digest("base64url");
    if (s !== expected) return false;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function staffAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || !verifyStaffToken(auth.slice(7))) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }
  next();
}

/* ═══ Helpers ═══ */

function getClassId(dateStr, hour, minute, discipline) {
  return `${dateStr}-${hour}${minute > 0 ? ":" + minute : ""}-${discipline}`;
}

function normalizeEmail(email) { return email.trim().toLowerCase(); }
function normalizePhone(phone) { return phone.replace(/[\s\-.\(\)]/g, "").replace(/^00/, "+"); }

async function getParticipantCount(classId) {
  const { data } = await supabase.from("bookings").select("places").eq("class_id", classId);
  return (data || []).reduce((s, r) => s + r.places, 0);
}

async function ensureClass(classId, discipline, date, hour, minute, coach) {
  const disc = DISCIPLINES[discipline];
  const { data: existing } = await supabase.from("classes").select("*").eq("class_id", classId).maybeSingle();
  if (existing) return existing;
  const row = { class_id: classId, discipline, date, hour, minute: minute || 0, coach: coach || null, max_participants: disc.maxParticipants };
  await supabase.from("classes").upsert(row, { onConflict: "class_id" });
  return { ...row, google_calendar_event_id: null };
}

/* ═══ Routes ═══ */

/* POST /bookings */
app.post("/bookings", async (req, res) => {
  try {
    const { classId, discipline, date, hour, minute, coach, name, email, places, purchaseType, totalPrice, idempotencyKey } = req.body;

    if (!classId || !discipline || !date || hour === undefined || !name || !email || !places)
      return res.status(400).json({ success: false, error: "Données manquantes." });
    if (!DISCIPLINES[discipline])
      return res.status(400).json({ success: false, error: "Discipline invalide." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, error: "Adresse email invalide." });
    if (places < 1 || places > 4)
      return res.status(400).json({ success: false, error: "Nombre de places invalide." });

    if (idempotencyKey) {
      const { data: dup } = await supabase.from("bookings").select("id, status").eq("idempotency_key", idempotencyKey).maybeSingle();
      if (dup) return res.json({ success: true, bookingId: dup.id, status: dup.status, duplicate: true });
    }

    const disc = DISCIPLINES[discipline];
    const classRow = await ensureClass(classId, discipline, date, hour, minute, coach);
    const maxP = classRow.max_participants;
    const currentCount = await getParticipantCount(classId);

    if (currentCount >= maxP)
      return res.status(409).json({ success: false, error: "Ce cours est complet." });
    if (places > maxP - currentCount)
      return res.status(409).json({ success: false, error: `Il ne reste que ${maxP - currentCount} place${maxP - currentCount > 1 ? "s" : ""} disponible${maxP - currentCount > 1 ? "s" : ""}.` });

    const booking = {
      class_id: classId, discipline, date, hour, minute: minute || 0,
      coach: coach || null, customer_name: name, customer_email: email,
      places, purchase_type: purchaseType || "single",
      total_price: totalPrice || disc.price * places,
      status: "confirmed", idempotency_key: idempotencyKey || null,
    };

    const { data: inserted, error: insertErr } = await supabase.from("bookings").insert(booking).select("id").single();
    if (insertErr) {
      if (insertErr.code === "23505") return res.json({ success: true, bookingId: "duplicate", status: "confirmed", duplicate: true });
      throw insertErr;
    }

    const newTotal = await getParticipantCount(classId);
    const { data: allBookings } = await supabase.from("bookings").select("customer_name, places, total_price").eq("class_id", classId);

    const eventId = await upsertCalendarEvent({ ...classRow, date, hour, minute: minute || 0 }, allBookings || []);
    if (eventId && eventId !== classRow.google_calendar_event_id) {
      await supabase.from("classes").update({ google_calendar_event_id: eventId }).eq("class_id", classId);
    }

    sendConfirmationEmail({ ...booking, date }, newTotal).catch(() => {});

    res.json({ success: true, bookingId: inserted.id, status: "confirmed", participants: newTotal, maxParticipants: maxP });
  } catch (err) {
    console.error("Booking error:", err);
    res.status(500).json({ success: false, error: "Erreur serveur. Veuillez réessayer." });
  }
});

/* GET /classes/:classId */
app.get("/classes/:classId", async (req, res) => {
  const count = await getParticipantCount(req.params.classId);
  const { data: cls } = await supabase.from("classes").select("max_participants").eq("class_id", req.params.classId).maybeSingle();
  res.json({ participants: count, maxParticipants: cls?.max_participants || 12 });
});

/* GET /classes?date=YYYY-MM-DD */
app.get("/classes", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date query param required" });
  const { data: rows } = await supabase.from("classes").select("class_id, max_participants").eq("date", date);
  const result = {};
  for (const r of rows || []) {
    const count = await getParticipantCount(r.class_id);
    result[r.class_id] = { participants: count, maxParticipants: r.max_participants };
  }
  res.json(result);
});

/* GET /health */
app.get("/health", (req, res) => {
  res.json({ status: "ok", calendar: !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY), email: !!transporter });
});

/* GET /schedule */
app.get("/schedule", async (req, res) => {
  const { discipline, days } = req.query;
  const numDays = Math.min(parseInt(days) || 7, 14);
  const validDiscipline = discipline && DISCIPLINES[discipline] ? discipline : null;
  const sessions = [];
  const now = new Date();

  for (let d = 0; d < numDays; d++) {
    const dt = new Date(now);
    dt.setDate(now.getDate() + d);
    dt.setHours(0, 0, 0, 0);
    const dayOfWeek = dt.getDay();
    const dateStr = dt.toISOString().split("T")[0];

    for (const cls of CLASS_SCHEDULE.filter(c => c.day === dayOfWeek && (!validDiscipline || c.discipline === validDiscipline))) {
      if (d === 0) {
        const classTime = new Date(dt);
        classTime.setHours(cls.hour, cls.minute || 0);
        if (classTime <= now) continue;
      }
      const classId = getClassId(dateStr, cls.hour, cls.minute || 0, cls.discipline);
      const disc = DISCIPLINES[cls.discipline];
      const count = await getParticipantCount(classId);
      sessions.push({
        classId, date: dateStr, hour: cls.hour, minute: cls.minute || 0,
        discipline: cls.discipline, disciplineLabel: disc.label,
        coach: cls.coach, maxParticipants: disc.maxParticipants,
        currentParticipants: count, available: count < disc.maxParticipants,
      });
    }
  }
  res.json({ sessions });
});

/* POST /staff/login */
app.post("/staff/login", (req, res) => {
  const { pin } = req.body;
  if (!pin || pin !== STAFF_PIN) return res.status(401).json({ success: false, error: "Code incorrect." });
  res.json({ success: true, token: signStaffToken() });
});

/* POST /free-trial */
app.post("/free-trial", async (req, res) => {
  try {
    const { firstName, lastName, email, phone, marketingConsent, discipline, classId, date, hour, minute, coach, idempotencyKey } = req.body;

    if (!firstName || !lastName || !email || !phone || !discipline || !classId || !date || hour === undefined)
      return res.status(400).json({ success: false, error: "Données manquantes." });
    if (!DISCIPLINES[discipline])
      return res.status(400).json({ success: false, error: "Discipline invalide." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, error: "Adresse email invalide." });
    const phoneClean = normalizePhone(phone);
    if (phoneClean.length < 8)
      return res.status(400).json({ success: false, error: "Numéro de téléphone invalide." });

    if (idempotencyKey) {
      const { data: dup } = await supabase.from("free_invitations").select("token").eq("idempotency_key", idempotencyKey).maybeSingle();
      if (dup) return res.json({ success: true, token: dup.token, duplicate: true });
    }

    const emailNorm = normalizeEmail(email);
    const phoneNorm = normalizePhone(phone);

    const { data: byEmail } = await supabase.from("free_customers").select("id").eq("email_normalized", emailNorm).maybeSingle();
    const { data: byPhone } = await supabase.from("free_customers").select("id").eq("phone_normalized", phoneNorm).maybeSingle();
    if (byEmail || byPhone)
      return res.status(409).json({ success: false, error: "Une invitation Core House a déjà été attribuée à ces coordonnées." });

    const disc = DISCIPLINES[discipline];
    const classRow = await ensureClass(classId, discipline, date, hour, minute, coach);
    const currentCount = await getParticipantCount(classId);
    if (currentCount >= classRow.max_participants)
      return res.status(409).json({ success: false, error: "Cette séance est complète." });

    const customerId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(date + "T23:59:59").toISOString();

    await supabase.from("free_customers").insert({
      id: customerId, first_name: firstName.trim(), last_name: lastName.trim(),
      email: email.trim(), phone: phone.trim(),
      email_normalized: emailNorm, phone_normalized: phoneNorm,
      marketing_consent: !!marketingConsent,
    });

    await supabase.from("free_invitations").insert({
      customer_id: customerId, class_id: classId, discipline, date, hour,
      minute: minute || 0, coach: coach || null, token,
      expires_at: expiresAt, idempotency_key: idempotencyKey || null,
    });

    await supabase.from("bookings").insert({
      class_id: classId, discipline, date, hour, minute: minute || 0,
      coach: coach || null, customer_name: `${firstName.trim()} ${lastName.trim()}`,
      customer_email: email.trim(), places: 1, purchase_type: "free_trial",
      total_price: 0, status: "confirmed",
      idempotency_key: idempotencyKey ? `ft-${idempotencyKey}` : null,
    });

    sendInvitationEmail({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), discipline, date, hour, minute, coach }).catch(() => {});

    res.json({ success: true, token });
  } catch (err) {
    console.error("Free trial error:", err);
    if (err?.code === "23505") return res.status(409).json({ success: false, error: "Une invitation Core House a déjà été attribuée à ces coordonnées." });
    res.status(500).json({ success: false, error: "Erreur serveur." });
  }
});

/* GET /free-trial/verify/:token */
app.get("/free-trial/verify/:token", staffAuth, async (req, res) => {
  const { data: inv } = await supabase.from("free_invitations").select("*, free_customers(first_name, last_name)").eq("token", req.params.token).maybeSingle();
  if (!inv) return res.json({ valid: false, reason: "invalid" });

  if (inv.status === "booked" && inv.expires_at && new Date(inv.expires_at) < new Date()) {
    await supabase.from("free_invitations").update({ status: "expired" }).eq("token", req.params.token);
    inv.status = "expired";
  }

  res.json({
    valid: inv.status === "booked", status: inv.status,
    firstName: inv.free_customers?.first_name, lastName: inv.free_customers?.last_name,
    discipline: inv.discipline, disciplineLabel: DISCIPLINES[inv.discipline]?.label,
    date: inv.date, hour: inv.hour, minute: inv.minute, coach: inv.coach,
    usedAt: inv.used_at, checkedInBy: inv.checked_in_by,
  });
});

/* POST /free-trial/checkin/:token */
app.post("/free-trial/checkin/:token", staffAuth, async (req, res) => {
  const { data: inv } = await supabase.from("free_invitations").select("*, free_customers(first_name, last_name)").eq("token", req.params.token).maybeSingle();
  if (!inv) return res.status(404).json({ success: false, reason: "invalid" });

  if (inv.status === "used") return res.status(409).json({ success: false, reason: "already_used", usedAt: inv.used_at, firstName: inv.free_customers?.first_name, lastName: inv.free_customers?.last_name });
  if (inv.status !== "booked") return res.status(409).json({ success: false, reason: inv.status });

  if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
    await supabase.from("free_invitations").update({ status: "expired" }).eq("token", req.params.token);
    return res.status(409).json({ success: false, reason: "expired" });
  }

  const { error } = await supabase.from("free_invitations").update({ status: "used", used_at: new Date().toISOString(), checked_in_by: "staff" }).eq("token", req.params.token).eq("status", "booked");
  if (error) return res.status(409).json({ success: false, reason: "already_used" });

  res.json({
    success: true, firstName: inv.free_customers?.first_name, lastName: inv.free_customers?.last_name,
    discipline: inv.discipline, disciplineLabel: DISCIPLINES[inv.discipline]?.label,
    date: inv.date, hour: inv.hour, minute: inv.minute,
  });
});

/* GET /free-trial/admin */
app.get("/free-trial/admin", staffAuth, async (req, res) => {
  const { filter, discipline, search } = req.query;
  const todayStr = new Date().toISOString().split("T")[0];

  let query = supabase.from("free_invitations").select("*, free_customers(first_name, last_name, email, phone)").order("created_at", { ascending: false }).limit(200);

  if (filter === "today") query = query.eq("date", todayStr);
  else if (filter === "upcoming") query = query.eq("status", "booked").gte("date", todayStr);
  else if (filter === "used") query = query.eq("status", "used");
  else if (filter === "expired") query = query.eq("status", "expired");
  else if (filter === "cancelled") query = query.eq("status", "cancelled");

  if (discipline && DISCIPLINES[discipline]) query = query.eq("discipline", discipline);

  const { data } = await query;
  const invitations = (data || []).map(inv => ({
    ...inv, first_name: inv.free_customers?.first_name, last_name: inv.free_customers?.last_name,
    email: inv.free_customers?.email, phone: inv.free_customers?.phone,
  }));
  res.json({ invitations });
});

/* GET /free-trial/stats */
app.get("/free-trial/stats", staffAuth, async (req, res) => {
  const todayStr = new Date().toISOString().split("T")[0];
  const { count: total } = await supabase.from("free_invitations").select("*", { count: "exact", head: true });
  const { count: upcoming } = await supabase.from("free_invitations").select("*", { count: "exact", head: true }).eq("status", "booked").gte("date", todayStr);
  const { count: used } = await supabase.from("free_invitations").select("*", { count: "exact", head: true }).eq("status", "used");
  const { count: noShow } = await supabase.from("free_invitations").select("*", { count: "exact", head: true }).eq("status", "expired");
  const { count: cancelled } = await supabase.from("free_invitations").select("*", { count: "exact", head: true }).eq("status", "cancelled");
  const pastTotal = (used || 0) + (noShow || 0);
  const presenceRate = pastTotal > 0 ? Math.round(((used || 0) / pastTotal) * 100) : 0;
  res.json({ total: total || 0, upcoming: upcoming || 0, used: used || 0, noShow: noShow || 0, cancelled: cancelled || 0, presenceRate });
});

/* ═══ Export ═══ */

export const handler = serverless(app, { basePath: "/.netlify/functions/api" });
