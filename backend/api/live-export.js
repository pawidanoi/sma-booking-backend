const { supabase } = require('../lib/supabase');
const { json, fail } = require('../lib/http');
const { decorate, BOOKING_SELECT } = require('./bookings');

// v2 item 16 — read-only mirror of live bookings into a Google Sheet, so a
// team lead can open raw data any time without a login. Postgres stays the
// source of truth; a Google Apps Script (scripts/live-export-apps-script.gs)
// pulls this on a timer and overwrites its own sheet — same shape as the
// schedule-import direction, just reversed.
//
// GET /api/live-export?token=...
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const token = req.headers['x-export-token'] || req.query.token;
  if (!token || token !== process.env.SHEET_EXPORT_TOKEN) return fail(res, 401, 'invalid export token');

  const { data, error } = await supabase.from('bookings').select(BOOKING_SELECT).order('created_at', { ascending: false });
  if (error) return fail(res, 500, error.message);

  const rows = (data || []).map(decorate).map((b) => ({
    id: b.id,
    team: b.team_code,
    branch: b.branches?.name || b.branch_code,
    checkin: b.checkin_date,
    checkout: b.checkout_date,
    nights: b.derived.nights,
    status: b.status,
    people: b.derived.people,
    male: b.derived.male,
    female: b.derived.female,
    rooms: b.derived.rooms,
    hotel: (b.booking_hotel_choices || []).find((c) => c.id === b.chosen_hotel_choice_id)?.hotels?.name
      || (b.booking_hotel_choices || []).find((c) => c.id === b.chosen_hotel_choice_id)?.custom_name || '',
    est_total: b.derived.est_total,
    confirmation_no: b.confirmation_no || '',
    guests: (b.booking_guests || []).map((g) => g.name).join('; '),
    auto_approved: !!b.auto_approved,
    created_at: b.created_at
  }));

  return json(res, 200, { rows });
};
