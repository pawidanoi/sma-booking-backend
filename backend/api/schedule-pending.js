const { supabase } = require('../lib/supabase');
const { json, fail } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');

// v2 §3.4 — admin-only view across every team of work_schedule rows that don't
// have a booking yet, soonest-first, so an admin can spot what's about to be
// missed without waiting for the 5-day/3-day cron reminder.
//
// GET /api/schedule-pending?actor=CMT2600940
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const actor = await getActor(req.query.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const { data: schedule, error: schedErr } = await supabase
    .from('work_schedule')
    .select('id, team_code, branch_code, date_start, date_end, advance_days, branches(name)')
    .order('date_start');
  if (schedErr) return fail(res, 500, schedErr.message);

  const { data: openBookings, error: bookErr } = await supabase
    .from('bookings')
    .select('work_schedule_id')
    .not('work_schedule_id', 'is', null);
  if (bookErr) return fail(res, 500, bookErr.message);
  const bookedIds = new Set((openBookings || []).map((b) => b.work_schedule_id));

  const pending = (schedule || [])
    .filter((row) => !bookedIds.has(row.id))
    .map((row) => ({
      id: row.id,
      team_code: row.team_code,
      branch_code: row.branch_code,
      branch_name: row.branches?.name || row.branch_code,
      date_start: row.date_start,
      date_end: row.date_end,
      advance_days: row.advance_days,
      target_date: addDays(row.date_start, -row.advance_days)
    }));

  return json(res, 200, { pending });
};

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
