const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');
const { push, qrUri, qrPostback, liffLink } = require('../lib/line');

// v2: replaces the Google Sheet sync (schedule-sync.js, removed) — an admin
// uploads the real "แผนงาน" Excel file (parsed client-side in index.html, this
// endpoint just receives the already-parsed rows) instead of a background sync.
//
// POST /api/schedule-import  body: { actor, filename, rows: [{team_code, branch_code, date_start, date_end, advance_days}] }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const actor = await getActor(body.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูลในไฟล์');

  const { data: teams } = await supabase.from('teams').select('code, notify_contact_1_employee, notify_contact_2_employee');
  const { data: branches } = await supabase.from('branches').select('code, name');
  const teamByCode = new Map((teams || []).map((t) => [t.code, t]));
  const branchNameByCode = new Map((branches || []).map((b) => [b.code, b.name]));

  const valid = [];
  const skipped = [];

  rows.forEach((row, i) => {
    const { team_code, branch_code, date_start, date_end } = row;
    const advance_days = Number.isInteger(row.advance_days) && row.advance_days >= 0 && row.advance_days <= 14 ? row.advance_days : 0;
    const reasons = [];
    if (!teamByCode.has(team_code)) reasons.push(`ไม่พบทีม ${team_code || '(ว่าง)'}`);
    if (!branchNameByCode.has(branch_code)) reasons.push(`ไม่พบรหัสสาขา ${branch_code || '(ว่าง)'}`);
    if (!date_start || !date_end) reasons.push('วันที่ไม่ครบ');
    if (date_start && date_end && date_end <= date_start) reasons.push('วันจบต้องหลังวันเริ่ม');

    if (reasons.length) { skipped.push({ row: i + 2, reasons }); return; }
    valid.push({ team_code, branch_code, date_start, date_end, advance_days, source: 'excel_upload' });
  });

  let minDate = null, maxDate = null;
  if (valid.length > 0) {
    minDate = valid.reduce((m, r) => (r.date_start < m ? r.date_start : m), valid[0].date_start);
    maxDate = valid.reduce((m, r) => (r.date_end > m ? r.date_end : m), valid[0].date_end);
  }

  const { data: importRow, error: importErr } = await supabase
    .from('work_schedule_imports')
    .insert({
      uploaded_by: actor.code,
      filename: body.filename || null,
      date_range_start: minDate,
      date_range_end: maxDate,
      total_rows: rows.length,
      success_rows: valid.length,
      failed_rows: skipped.length,
      failed_row_details: skipped
    })
    .select()
    .single();
  if (importErr) return fail(res, 500, importErr.message);

  let inserted = [];
  if (valid.length > 0) {
    const { error: delErr } = await supabase
      .from('work_schedule')
      .delete()
      .eq('source', 'excel_upload')
      .gte('date_start', minDate)
      .lte('date_end', maxDate);
    if (delErr) return fail(res, 500, delErr.message);

    const { data: insertedRows, error: insErr } = await supabase
      .from('work_schedule')
      .insert(valid.map((v) => ({ ...v, import_id: importRow.id })))
      .select();
    if (insErr) return fail(res, 500, insErr.message);
    inserted = insertedRows || [];
  }

  await notifyTeams(inserted, teamByCode, branchNameByCode);

  return json(res, 200, {
    ok: true,
    import_id: importRow.id,
    inserted: valid.length,
    skipped: skipped.length,
    skipped_detail: skipped
  });
};

async function notifyTeams(insertedRows, teamByCode, branchNameByCode) {
  if (insertedRows.length === 0) return;

  const { data: employees } = await supabase.from('employees').select('code, line_user_id');
  const lineIdByEmployee = new Map((employees || []).map((e) => [e.code, e.line_user_id]));

  const byTeam = new Map();
  insertedRows.forEach((row) => {
    if (!byTeam.has(row.team_code)) byTeam.set(row.team_code, []);
    byTeam.get(row.team_code).push(row);
  });

  const notificationLogRows = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const [teamCode, teamRows] of byTeam) {
    const team = teamByCode.get(teamCode);
    const recipients = team
      ? [team.notify_contact_1_employee, team.notify_contact_2_employee].filter(Boolean).map((c) => lineIdByEmployee.get(c)).filter(Boolean)
      : [];

    if (recipients.length) {
      const message = {
        type: 'text',
        text: `📋 ทีมคุณมีงานใหม่ ${teamRows.length} รายการเข้ามาแล้วค่ะ กดดูแล้วรีบจองได้เลยนะ 🥭`,
        quickReply: { items: [qrUri('ดูรายการ', liffLink('/home')), qrPostback('« เมนูหลัก', 'action=menu')] }
      };
      await Promise.all(recipients.map((lineId) => push(lineId, [message])));
    }
    teamRows.forEach((row) => notificationLogRows.push({ work_schedule_id: row.id, type: 'import', sent_by: 'system' }));

    for (const row of teamRows) {
      const targetDate = addDays(row.date_start, -row.advance_days);
      const daysUntil = diffDays(today, targetDate);
      if (daysUntil > 5) continue; // still has time — the daily 5-day/3-day cron will catch it

      if (recipients.length) {
        const branchName = branchNameByCode.get(row.branch_code) || row.branch_code;
        const urgentMessage = {
          type: 'text',
          text: `😱 ด่วนมากค่ะ! งานที่ ${branchName} (ทีม ${row.team_code}) เหลืออีกแค่ ${Math.max(daysUntil, 0)} วัน แต่ยังไม่มีคำขอที่พักเลย รีบจองด่วนนะคะ!`,
          quickReply: { items: [qrUri('จองเลย', liffLink('/home'))] }
        };
        await Promise.all(recipients.map((lineId) => push(lineId, [urgentMessage])));
      }
      notificationLogRows.push({ work_schedule_id: row.id, type: 'urgent', sent_by: 'system' });
    }
  }

  if (notificationLogRows.length) {
    await supabase.from('work_schedule_notifications').insert(notificationLogRows);
  }
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
