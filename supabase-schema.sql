-- ══════════════════════════════════════════════
-- CORE HOUSE DAKAR — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ══════════════════════════════════════════════

-- Bookings
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id TEXT NOT NULL,
  discipline TEXT NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL DEFAULT 0,
  coach TEXT,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  places INTEGER NOT NULL DEFAULT 1,
  purchase_type TEXT NOT NULL DEFAULT 'single',
  total_price INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT UNIQUE
);

CREATE INDEX idx_bookings_class_id ON bookings(class_id);
CREATE INDEX idx_bookings_date ON bookings(date);

-- Classes (tracks calendar event IDs and capacity overrides)
CREATE TABLE classes (
  class_id TEXT PRIMARY KEY,
  discipline TEXT NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL DEFAULT 0,
  coach TEXT,
  max_participants INTEGER NOT NULL DEFAULT 12,
  google_calendar_event_id TEXT
);

CREATE INDEX idx_classes_date ON classes(date);

-- Free trial customers
CREATE TABLE free_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_free_customers_email ON free_customers(email_normalized);
CREATE INDEX idx_free_customers_phone ON free_customers(phone_normalized);

-- Free trial invitations
CREATE TABLE free_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES free_customers(id),
  class_id TEXT NOT NULL,
  discipline TEXT NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL DEFAULT 0,
  coach TEXT,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'booked',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  checked_in_by TEXT,
  idempotency_key TEXT UNIQUE
);

CREATE INDEX idx_free_invitations_token ON free_invitations(token);
CREATE INDEX idx_free_invitations_status ON free_invitations(status);
CREATE INDEX idx_free_invitations_customer ON free_invitations(customer_id);

-- Helper: count participants for a class
CREATE OR REPLACE FUNCTION get_participant_count(p_class_id TEXT)
RETURNS INTEGER AS $$
  SELECT COALESCE(SUM(places), 0)::INTEGER FROM bookings WHERE class_id = p_class_id;
$$ LANGUAGE SQL STABLE;

-- RLS: disable for all tables (access is only via service key from Netlify Functions)
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON bookings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON classes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON free_customers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON free_invitations FOR ALL USING (true) WITH CHECK (true);
