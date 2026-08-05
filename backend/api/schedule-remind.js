const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');
const { push, qrUri, qrPostback, liffLink } = require('../lib/line');

// v2 §3.4 — the [เตือนอีกครั้ง] button on the "แผนงานที่ยังไม่จอง" admin page:
// fires an immediate push to the team's 2 notify contacts, independent of the
// daily 5-day/3-day cron (cron-notify.js) so an admin isn't stuck waiting for it.
//
// POST /api/schedule-remind  body: { actor, work_schedule_id }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const actor = await getActor(body.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const scheduleId = body.work_schedule_id;
  if (!scheduleId) return fail(res, 400, 'ไม่พบแผนงานที่ต้องการเตือน');

  const { data: row, error: schedErr } = await supabase
    .from('work_schedule')
    .select('id, team_code, branch_code, branches(name)')
    .eq('id', scheduleId)
    .maybeSingle();
  if (schedErr) return fail(res, 500, schedErr.message);
  if (!row) return fail(res, 404, 'ไม่พบแผนงานนี้ — อาจถูกลบหรือจองไปแล้ว');

  const { data: team } = await supabase
    .from('teams')
    .select('notify_contact_1_employee, notify_contact_2_employee')
    .eq('code', row.team_code)
    .maybeSingle();

  const codes = [team?.notify_contact_1_employee, team?.notify_contact_2_employee].filter(Boolean);
  const { data: employees } = codes.length
    ? await supabase.from('employees').select('code, line_user_id').in('code', codes)
    : { data: [] };
  const recipients = (employees || []).map((e) => e.line_user_id).filter(Boolean);

  if (recipients.length === 0) {
    return fail(res, 400, 'ทีมนี้ยังไม่มีผู้รับแจ้งเตือนที่ผูกบัญชี LINE ไว้');
  }

  const branchName = row.branches?.name || row.branch_code;
  const message = {
    type: 'text',
    text: `📣 แอดมินฝากเตือนค่ะ งานที่ ${branchName} (ทีม ${row.team_code}) ยังไม่มีคำขอที่พักเข้ามาเลยนะคะ รีบจองด้วยน้า 🥭`,
    quickReply: { items: [qrUri('จองเลย', liffLink('/home')), qrPostback('« เมนูหลัก', 'action=menu')] }
  };
  await Promise.all(recipients.map((lineId) => push(lineId, [message])));

  await supabase.from('work_schedule_notifications').insert({
    work_schedule_id: row.id,
    type: 'manual_remind',
    sent_by: actor.code
  });

  return json(res, 200, { ok: true, sent: recipients.length });
};
