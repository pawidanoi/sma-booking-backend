const { supabase } = require('../lib/supabase');
const { fail, json } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');

// One-off admin-triggered wipe of transactional test data before real usage
// starts (requested during v2 setup — nothing in bookings/work_schedule had
// been used for a real booking yet). Registries (employees/branches/hotels/
// teams) and booking_legacy_summary (real historical dashboard data) are left
// untouched. bookings has ON DELETE CASCADE to every child table (guests,
// hotel_choices, changes, join_requests, deposit_claims), so deleting it
// clears those automatically.
//
// GET /api/reset-test-data?actor=CMT2600940
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const actorCode = (req.query.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const { count: bookingsBefore } = await supabase.from('bookings').select('id', { count: 'exact', head: true });
  const { count: scheduleBefore } = await supabase.from('work_schedule').select('id', { count: 'exact', head: true });

  const { error: bookingsErr } = await supabase.from('bookings').delete().not('id', 'is', null);
  if (bookingsErr) return fail(res, 500, bookingsErr.message);

  const { error: scheduleErr } = await supabase.from('work_schedule').delete().not('id', 'is', null);
  if (scheduleErr) return fail(res, 500, scheduleErr.message);

  return json(res, 200, {
    ok: true,
    deleted: { bookings: bookingsBefore || 0, work_schedule: scheduleBefore || 0 }
  });
};
