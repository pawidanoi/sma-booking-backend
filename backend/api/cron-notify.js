const { supabase } = require('../lib/supabase');
const { push, qrPostback, qrUri, liffLink } = require('../lib/line');

// Runs daily via Vercel Cron (see vercel.json — 02:00 UTC = 09:00 Thailand time).
// For every work_schedule row without a booking yet, push a reminder to the
// team's two notify contacts (หัวหน้า + ผู้จองสำรอง) at 5 days out, then again
// at 3 days out if still nothing — per the confirmed HANDOFF design.
module.exports = async function handler(req, res) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const { data: schedule } = await supabase
    .from('work_schedule')
    .select('id, team_code, branch_code, date_start, date_end, advance_days, branches(name)');

  const { data: openBookings } = await supabase
    .from('bookings')
    .select('work_schedule_id')
    .not('work_schedule_id', 'is', null);
  const bookedScheduleIds = new Set((openBookings || []).map((b) => b.work_schedule_id));

  const { data: teams } = await supabase
    .from('teams')
    .select('code, notify_contact_1_employee, notify_contact_2_employee');
  const teamByCode = new Map((teams || []).map((t) => [t.code, t]));

  const { data: employees } = await supabase.from('employees').select('code, line_user_id');
  const lineIdByEmployee = new Map((employees || []).map((e) => [e.code, e.line_user_id]));

  let sent = 0;
  const results = [];

  for (const row of schedule || []) {
    if (bookedScheduleIds.has(row.id)) continue;

    const targetDate = addDays(row.date_start, -row.advance_days);
    const daysUntil = diffDays(today, targetDate);
    if (daysUntil !== 5 && daysUntil !== 3) continue;

    const team = teamByCode.get(row.team_code);
    if (!team) continue;

    const recipients = [team.notify_contact_1_employee, team.notify_contact_2_employee]
      .filter(Boolean)
      .map((code) => lineIdByEmployee.get(code))
      .filter(Boolean);

    const roundLabel = daysUntil === 5 ? 'แจ้งเตือนรอบแรก' : 'แจ้งเตือนซ้ำ';
    const branchName = row.branches?.name || row.branch_code;
    const message = {
      type: 'text',
      text: `🔔 ${roundLabel} — อีก ${daysUntil} วันถึงกำหนดงานที่ ${branchName} (ทีม ${row.team_code}) แล้วนะคะ ยังไม่เห็นคำขอที่พักเลย จองเลยไหมคะ? 🥭`,
      // Matches the mascot spec's example exactly — a push message still supports
      // quickReply, so the reminder itself is one tap away from booking or dismissing.
      quickReply: {
        items: [
          qrUri('จองเลย', liffLink('/home')),
          qrUri('ดูรายละเอียดงาน', liffLink('/home')),
          qrPostback('ยังไม่ต้องตอนนี้', 'action=dismiss_reminder')
        ]
      }
    };

    await Promise.all(recipients.map((lineId) => push(lineId, [message])));
    sent += recipients.length;
    results.push({ team: row.team_code, branch: branchName, daysUntil, recipients: recipients.length });
  }

  res.status(200).json({ sent, results });
};

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
