/**
 * Riverside Health — Example Backend
 * -----------------------------------
 * This is a minimal, working example of the backend piece that's missing
 * from the static widget. It does two things when a booking comes in:
 *   1. Saves it to a local JSON "database" (swap for real Postgres/Mongo later)
 *   2. Sends an email notification to hospital staff (using Resend's API)
 *
 * WHY YOU NEED THIS:
 * The patient-facing widget (hospital-assistant.html) is a static file with
 * no server behind it — it cannot safely hold an email API key or write to
 * a shared database. This server is the missing piece. Deploy it somewhere
 * (Render, Railway, Fly.io, a VPS, etc.), then point the widget at it.
 *
 * SETUP:
 *   1. npm install express cors resend
 *   2. Sign up at https://resend.com (free tier available), get an API key
 *   3. Set environment variables:
 *        RESEND_API_KEY=your_key_here
 *        STAFF_EMAIL=frontdesk@yourhospital.com
 *        FROM_EMAIL=onboarding@yourdomain.com   (must be a verified sender)
 *   4. node server.js
 *   5. In hospital-assistant.html, replace the window.storage.set() call
 *      in finalizeBooking() with:
 *
 *        await fetch('https://your-backend-url.com/api/bookings', {
 *          method: 'POST',
 *          headers: {'Content-Type':'application/json'},
 *          body: JSON.stringify(record)
 *        });
 *
 *   6. In staff-dashboard.html, replace fetchBookings() with a call to
 *      GET /api/bookings instead of window.storage.list()
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

const app = express();
app.use(cors());          // In production, restrict this to your widget's actual domain
app.use(express.json());

const DB_FILE = path.join(__dirname, 'bookings.json');
const resend = new Resend(process.env.RESEND_API_KEY);

// ---------- tiny file-based "database" (swap for Postgres/Mongo in production) ----------
function readBookings(){
  if(!fs.existsSync(DB_FILE)) return [];
  try{
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }catch(e){
    console.error('Could not read bookings.json:', e);
    return [];
  }
}

function writeBookings(bookings){
  fs.writeFileSync(DB_FILE, JSON.stringify(bookings, null, 2));
}

// ---------- routes ----------

// Create a new booking (called by the patient widget)
app.post('/api/bookings', async (req, res) => {
  const record = req.body;

  // Basic server-side validation — never trust the client alone
  if(!record?.patient?.name || !record?.patient?.email || !record?.patient?.mobile){
    return res.status(400).json({ error: 'Missing required patient details.' });
  }

  const bookings = readBookings();
  bookings.push(record);
  writeBookings(bookings);

  // Notify staff by email
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
    // Don't fail the whole booking just because email didn't send —
    // the booking is already saved, log the error and move on
    console.error('Email notification failed:', emailErr);
  }

  res.status(201).json({ success: true, confirmationId: record.confirmationId });
});

// List all bookings (called by the staff dashboard)
app.get('/api/bookings', (req, res) => {
  res.json(readBookings());
});

// Mark a booking as reviewed (optional — dashboard currently does this client-side only)
app.patch('/api/bookings/:id/reviewed', (req, res) => {
  const bookings = readBookings();
  const booking = bookings.find(b => b.confirmationId === req.params.id);
  if(!booking) return res.status(404).json({ error: 'Booking not found' });
  booking.reviewed = true;
  writeBookings(bookings);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Riverside Health backend running on http://localhost:${PORT}`);
  console.log(`Bookings stored in: ${DB_FILE}`);
});
