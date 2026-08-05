const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');

// v2 §3.5 — deleting a work_schedule row:
//   no booking attached          -> delete the schedule row directly
//   booking not yet completed    -> delete the booking too (cascades guests/
//                                    hotel_choices/changes/join_requests/
//                                    deposit_claims/status_log with it)
//   booking already จองสำเร็จ    -> keep the booking (voucher/history), just
//                                    unlink it (work_schedule_id = null)
//
// POST /api/schedule-delete  body: { actor, work_schedule_id }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const actor = await getActor(body.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const scheduleId = body.work_schedule_id;
  if (!scheduleId) return fail(res, 400, 'ไม่พบแผนงานที่ต้องการลบ');

  const { data: linkedBookings, error: bkErr } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('work_schedule_id', scheduleId);
  if (bkErr) return fail(res, 500, bkErr.message);

  let deletedBookings = 0, unlinkedBookings = 0;
  for (const b of linkedBookings || []) {
    if (b.status === 'จองสำเร็จ') {
      const { error } = await supabase.from('bookings').update({ work_schedule_id: null }).eq('id', b.id);
      if (error) return fail(res, 500, error.message);
      unlinkedBookings++;
    } else {
      const { error } = await supabase.from('bookings').delete().eq('id', b.id);
      if (error) return fail(res, 500, error.message);
      deletedBookings++;
    }
  }

  const { error: delErr } = await supabase.from('work_schedule').delete().eq('id', scheduleId);
  if (delErr) return fail(res, 500, delErr.message);

  return json(res, 200, { ok: true, deleted_bookings: deletedBookings, unlinked_bookings: unlinkedBookings });
};
