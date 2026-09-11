const { supabase } = require('../lib/supabase');
const { push, qrPostback, qrUri, liffLink } = require('../lib/line');
const { syncStaffFromSheet } = require('../lib/staff-sync');

// Runs daily via Vercel Cron (see vercel.json — 02:00 UTC = 09:00 Thailand time).
// Two independent stages:
//   1) work_schedule-based — no booking exists yet, so this has to be keyed off
//      the job's own date_start/advance_days (unchanged from the original design).
//   2) bookings-based — the AREA-picks-a-hotel/owner-approves/hotel-confirmation
//      stages below, keyed off the booking's own checkin_date (which can differ
//      from the job's date_start).
module.exports = async function handler(req, res) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // ซิงค์ทะเบียนพนักงานจากชีต HR ก่อนงานแจ้งเตือน — best-effort เหมือนกันเพราะถ้าชีต
  // ดึงไม่ได้ตอนนี้ (เช่น เน็ตเวิร์กสะดุด) ไม่ควรทำให้การแจ้งเตือนรายวันพังไปด้วย
  let staffSync;
  try {
    staffSync = await syncStaffFromSheet();
  } catch (e) {
    staffSync = { error: e.message };
  }

  const stage1 = await runStage1(today);
  const stage2to4 = await runBookingStages(today);

  res.status(200).json({ staffSync, stage1, stage2to4 });
};

// ---------------------------------------------------------------- stage 1: remind employee to submit (day -5, -3)

async function runStage1(today) {
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

    const branchName = row.branches?.name || row.branch_code;
    // Round 2 gets a more insistent/naggy tone than round 1 — matches the confirmed
    // "kind but a little naggy" personality: friendly nudge first, firmer follow-up.
    const text = daysUntil === 5
      ? `🔔 อีก ${daysUntil} วันถึงกำหนดงานที่ ${branchName} (ทีม ${row.team_code}) แล้วนะคะ ยังไม่เห็นคำขอที่พักจากทีมเลย จองเลยไหมคะ? 🥭`
      : `🔔 เอ๊ะ นี่จะจองรึยังคะเนี่ย?! อีกแค่ ${daysUntil} วันจะถึงงานที่ ${branchName} (ทีม ${row.team_code}) แล้วนะ ยังไม่มีคำขอเข้ามาเลย มะม่วงเป็นห่วงนะ จองด่วนเลยค่ะ! 😤🥭`;
    const message = {
      type: 'text',
      text,
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

  return { sent, results };
}

// ---------------------------------------------------------------- stages 2-4: AREA picks a hotel / owner approves / hotel confirmation number

async function runBookingStages(today) {
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, team_code, branch_code, checkin_date, status, confirmation_no, branches(name)')
    .in('status', ['ส่งคำขอ', 'รอเจ้าของอนุมัติ', 'รอเลขยืนยันโรงแรม']);

  const { data: assignments } = await supabase.from('area_team_assignments').select('area_employee_code, team_code');
  const areaCodesByTeam = new Map();
  (assignments || []).forEach((a) => {
    if (!areaCodesByTeam.has(a.team_code)) areaCodesByTeam.set(a.team_code, []);
    areaCodesByTeam.get(a.team_code).push(a.area_employee_code);
  });

  const { data: employees } = await supabase.from('employees').select('code, line_user_id, position');
  const lineIdByEmployee = new Map((employees || []).map((e) => [e.code, e.line_user_id]));
  const adminLineIds = (employees || [])
    .filter((e) => e.position === 'แอดมิน')
    .map((e) => e.line_user_id)
    .filter(Boolean);

  let sent = 0;
  const results = [];

  for (const b of bookings || []) {
    const daysUntil = diffDays(today, new Date(b.checkin_date));
    const branchName = b.branches?.name || b.branch_code;

    // Stage 2 — AREA remind, day -4, soft nudge to pick a hotel (was "approve").
    if (b.status === 'ส่งคำขอ' && daysUntil === 4) {
      const areaCodes = areaCodesByTeam.get(b.team_code) || [];
      const recipients = areaCodes.map((c) => lineIdByEmployee.get(c)).filter(Boolean);
      if (recipients.length) {
        await Promise.all(recipients.map((lineId) => push(lineId, [{
          type: 'text',
          text: `🔔 อีก 4 วันจะถึงวันเข้าพักของทีม ${b.team_code} ที่ ${branchName} แล้วนะคะ ช่วยเลือกที่พักแล้วส่งขออนุมัติให้ด้วยนะ 🥭`,
          quickReply: { items: [qrUri('เลือกที่พักเลย', liffLink('/home'))] }
        }])));
        sent += recipients.length;
      }
      results.push({ stage: 'area_remind', booking: b.id, recipients: recipients.length });
    }

    // Stage 3 — day -3. Still un-picked at this point → escalate the AREA
    // nudge (harder tone, same recipients as stage 2). Already picked and
    // waiting on the owner's mandatory final approval → remind the owner
    // instead (adminLineIds — the "แอดมิน" position is the owner today).
    if (b.status === 'ส่งคำขอ' && daysUntil === 3) {
      const areaCodes = areaCodesByTeam.get(b.team_code) || [];
      const recipients = areaCodes.map((c) => lineIdByEmployee.get(c)).filter(Boolean);
      if (recipients.length) {
        await Promise.all(recipients.map((lineId) => push(lineId, [{
          type: 'text',
          text: `📣 อีกแค่ 3 วันจะถึงวันเข้าพักของทีม ${b.team_code} ที่ ${branchName} แล้วนะ ยังไม่เห็นเลือกที่พักเลย รีบหน่อยนะคะ 😤🥭`,
          quickReply: { items: [qrUri('เลือกที่พักเลย', liffLink('/home'))] }
        }])));
        sent += recipients.length;
      }
      results.push({ stage: 'area_remind_escalate', booking: b.id, recipients: recipients.length });
    }
    if (b.status === 'รอเจ้าของอนุมัติ' && daysUntil === 3) {
      if (adminLineIds.length) {
        await Promise.all(adminLineIds.map((lineId) => push(lineId, [{
          type: 'text',
          text: `📣 อีก 3 วันถึงวันเข้าพักของทีม ${b.team_code} ที่ ${branchName} แล้ว รออนุมัติขั้นสุดท้ายอยู่นะคะ`,
          quickReply: { items: [qrUri('เปิดคิว', liffLink('/home'))] }
        }])));
        sent += adminLineIds.length;
      }
      results.push({ stage: 'final_approval_remind', booking: b.id, recipients: adminLineIds.length });
    }

    // Stage 4 — day -1/-2, approved but no hotel confirmation number yet.
    // Sent to both AREA (scoped to this booking's team, since they're the
    // one who typically enters it) and the owner.
    if (b.status === 'รอเลขยืนยันโรงแรม' && !b.confirmation_no && (daysUntil === 1 || daysUntil === 2)) {
      const areaCodes = areaCodesByTeam.get(b.team_code) || [];
      const recipients = [...new Set([
        ...areaCodes.map((c) => lineIdByEmployee.get(c)).filter(Boolean),
        ...adminLineIds
      ])];
      if (recipients.length) {
        await Promise.all(recipients.map((lineId) => push(lineId, [{
          type: 'text',
          text: `🎫 อีก ${daysUntil} วันถึงวันเข้าพักของทีม ${b.team_code} ที่ ${branchName} แล้ว ยังไม่เห็นเลขยืนยันจากโรงแรมเลยนะคะ`,
          quickReply: { items: [qrUri('กรอกเลขยืนยัน', liffLink('/home'))] }
        }])));
        sent += recipients.length;
      }
      results.push({ stage: 'confirmation_remind', booking: b.id, recipients: recipients.length });
    }
  }

  return { sent, results };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
