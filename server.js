/**
 * Riverside Health — Example Backend
 * -----------------------------------
 * Saves bookings to a real Postgres database (via Neon's free tier) and
 * emails hospital staff a notification when a new one comes in.
 *
 * WHY YOU NEED THIS:
 * The patient-facing widget (hospital-assistant.html) is a static file with
 * no server behind it — it cannot safely hold an email API key or write to
 * a shared database. This server is the missing piece.
 *
 * SETUP:
 *   1. npm install express cors resend pg
 *   2. Create a free database at https://neon.tech, copy its connection string
 *   3. Sign up at https://resend.com (free tier available), get an API key
 *   4. Set environment variables on your host (e.g. Render):
 *        DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
 *        RESEND_API_KEY=your_key_here
 *        STAFF_EMAIL=frontdesk@yourhospital.com
 *        FROM_EMAIL=onboarding@resend.dev
 *        DASHBOARD_PASSWORD=choose_a_real_password
 *   5. node server.js — on first run it automatically creates the
 *      "bookings" table if it doesn't exist yet. No manual SQL needed.
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
app.use(cors());          // In production, restrict this to your widget's actual domain
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// ---------- Postgres connection ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Neon's hosted Postgres
});

// Creates the bookings table on first run if it doesn't already exist.
async function ensureTable(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      confirmation_id TEXT PRIMARY KEY,
      patient_name TEXT NOT NULL,
      patient_email TEXT NOT NULL,
      patient_mobile TEXT NOT NULL,
      insurance TEXT,
      reason TEXT,
      department TEXT,
      appt_date TEXT,
      appt_time TEXT,
      reviewed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Bookings table ready.');
}

// ---------- simple password protection for staff-only routes ----------
// This is a basic safeguard, not full authentication. Good enough for a
// small pilot; replace with real per-user login before handling real volume.
function requireDashboardPassword(req, res, next){
  const provided = req.headers['x-dashboard-password'];
  if(!process.env.DASHBOARD_PASSWORD){
    return res.status(500).json({ error: 'Dashboard password not configured on server.' });
  }
  if(provided !== process.env.DASHBOARD_PASSWORD){
    return res.status(401).json({ error: 'Incorrect or missing dashboard password.' });
  }
  next();
}

function rowToBooking(row){
  return {
    confirmationId: row.confirmation_id,
    patient: {
      name: row.patient_name,
      email: row.patient_email,
      mobile: row.patient_mobile,
      insurance: row.insurance
    },
    reason: row.reason,
    department: row.department,
    date: row.appt_date,
    time: row.appt_time,
    reviewed: row.reviewed,
    createdAt: row.created_at
  };
}

// ---------- routes ----------

// Create a new booking (called by the patient widget)
app.post('/api/bookings', async (req, res) => {
  const record = req.body;

  if(!record?.patient?.name || !record?.patient?.email || !record?.patient?.mobile){
    return res.status(400).json({ error: 'Missing required patient details.' });
  }
  if(!record.confirmationId){
    return res.status(400).json({ error: 'Missing confirmationId.' });
  }

  try{
    await pool.query(
      `INSERT INTO bookings
        (confirmation_id, patient_name, patient_email, patient_mobile, insurance, reason, department, appt_date, appt_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.confirmationId,
        record.patient.name,
        record.patient.email,
        record.patient.mobile,
        record.patient.insurance || null,
        record.reason || null,
        record.department || null,
        record.date || null,
        record.time || null
      ]
    );
  }catch(dbErr){
    console.error('Could not save booking to database:', dbErr);
    return res.status(500).json({ error: 'Could not save booking.' });
  }

  // Notify staff by email — booking is already saved even if this fails
  try{
    await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: process.env.STAFF_EMAIL,
      subject: `New appointment request — ${record.patient.name} (${record.department})`,
      html: `
        <h2>New appointment request</h2>
        <p><strong>Confirmation ID:</strong> ${record.confirmationId}</p>
        <table cellpadding="6" style="border-collapse:collapse;">
          <tr><td><strong>Name</strong></td><td>${record.patient.name}</td></tr>
          <tr><td><strong>Email</strong></td><td>${record.patient.email}</td></tr>
          <tr><td><strong>Mobile</strong></td><td>${record.patient.mobile}</td></tr>
          <tr><td><strong>Insurance</strong></td><td>${record.patient.insurance || 'None'}</td></tr>
          <tr><td><strong>Reason</strong></td><td>${record.reason}</td></tr>
          <tr><td><strong>Department</strong></td><td>${record.department}</td></tr>
          <tr><td><strong>Date</strong></td><td>${record.date}</td></tr>
          <tr><td><strong>Time</strong></td><td>${record.time}</td></tr>
        </table>
        <p>View it on the staff dashboard for full details.</p>
      `
    });
  }catch(emailErr){
    console.error('Email notification failed:', emailErr);
  }

  res.status(201).json({ success: true, confirmationId: record.confirmationId });
});

// List all bookings (called by the staff dashboard) — password protected
app.get('/api/bookings', requireDashboardPassword, async (req, res) => {
  try{
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows.map(rowToBooking));
  }catch(dbErr){
    console.error('Could not fetch bookings:', dbErr);
    res.status(500).json({ error: 'Could not fetch bookings.' });
  }
});

// Mark a booking as reviewed
app.patch('/api/bookings/:id/reviewed', requireDashboardPassword, async (req, res) => {
  try{
    const result = await pool.query(
      'UPDATE bookings SET reviewed = TRUE WHERE confirmation_id = $1 RETURNING *',
      [req.params.id]
    );
    if(result.rowCount === 0){
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({ success: true });
  }catch(dbErr){
    console.error('Could not update booking:', dbErr);
    res.status(500).json({ error: 'Could not update booking.' });
  }
});

const PORT = process.env.PORT || 3000;

ensureTable()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Riverside Health backend running on http://localhost:${PORT}`);
      console.log('Connected to Postgres database.');
    });
  })
  .catch(err => {
    console.error('Could not connect to database on startup:', err);
    process.exit(1);
  });
