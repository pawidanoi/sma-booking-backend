const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');
const { push, qrUri, qrPostback, liffLink } = require('../lib/line');

// Vercel Hobby caps a deployment at 12 serverless functions — combines what
// were 5 separate admin-only files (schedule-import, branch-import,
// schedule-pending, schedule-remind, schedule-delete) into one, dispatched by
// `action`. Behavior of each action is unchanged from its original file.
//
// GET  /api/admin-import?actor=...&action=schedule_pending|branch_provinces
// POST /api/admin-import  body: { actor, action: 'schedule_import'|'branch_import'|'schedule_remind'|'schedule_delete'|'employee_home_import'|'hotel_import', ... }
module.exports = async function handler(req, res) {
  const body = readBody(req);
  const actor = await getActor(req.query.actor || body.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  if (req.method === 'GET') {
    if (req.query.action === 'schedule_pending') return schedulePending(res);
    if (req.query.action === 'branch_provinces') return branchProvinces(res);
    return fail(res, 400, `ไม่รู้จัก action: ${req.query.action}`);
  }

  if (req.method === 'POST') {
    if (body.action === 'schedule_import') return scheduleImport(res, actor, body);
    if (body.action === 'branch_import') return branchImport(res, actor, body);
    if (body.action === 'schedule_remind') return scheduleRemind(res, actor, body);
    if (body.action === 'schedule_delete') return scheduleDelete(res, body);
    if (body.action === 'employee_home_import') return employeeHomeImport(res, body);
    if (body.action === 'hotel_import') return hotelImport(res, body);
    return fail(res, 400, `ไม่รู้จัก action: ${body.action}`);
  }

  return fail(res, 405, 'method not allowed');
};

// ---------------------------------------------------------------- schedule_pending (v2 §3.4)

async function schedulePending(res) {
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
}

// ---------------------------------------------------------------- schedule_import (v2)

async function scheduleImport(res, actor, body) {
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
}

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
      if (daysUntil > 5) continue;

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

// ---------------------------------------------------------------- branch_import

async function branchImport(res, actor, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูลในไฟล์');

  const valid = [];
  const skipped = [];
  rows.forEach((row, i) => {
    const code = String(row.code || '').trim();
    const name = String(row.name || '').trim();
    const lat = row.lat === null || row.lat === undefined || row.lat === '' ? null : Number(row.lat);
    const lng = row.lng === null || row.lng === undefined || row.lng === '' ? null : Number(row.lng);
    const reasons = [];
    if (!code) reasons.push('ไม่มีรหัสสาขา');
    if (!name) reasons.push('ไม่มีชื่อสาขา');

    if (reasons.length) { skipped.push({ row: i + 2, code, reasons }); return; }
    valid.push({
      code,
      name,
      district: row.district || null,
      province: row.province || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null
    });
  });

  let upserted = 0;
  if (valid.length > 0) {
    const { error } = await supabase.from('branches').upsert(valid, { onConflict: 'code' });
    if (error) return fail(res, 500, error.message);
    upserted = valid.length;
  }

  return json(res, 200, { ok: true, upserted, skipped: skipped.length, skipped_detail: skipped });
}

// ---------------------------------------------------------------- schedule_remind (v2 §3.4)

async function scheduleRemind(res, actor, body) {
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

  if (recipients.length === 0) return fail(res, 400, 'ทีมนี้ยังไม่มีผู้รับแจ้งเตือนที่ผูกบัญชี LINE ไว้');

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
}

// ---------------------------------------------------------------- schedule_delete (v2 §3.5)

async function scheduleDelete(res, body) {
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
}

// ---------------------------------------------------------------- branch_provinces
// (map feature groundwork) — tells the hotel-research pass exactly which
// provinces have a branch in them, instead of guessing from a stale list.

async function branchProvinces(res) {
  const { data, error } = await supabase
    .from('branches')
    .select('code, name, province, district, lat, lng')
    .order('province');
  if (error) return fail(res, 500, error.message);

  const byProvince = new Map();
  (data || []).forEach((b) => {
    const p = b.province || '(ไม่ระบุจังหวัด)';
    if (!byProvince.has(p)) byProvince.set(p, []);
    byProvince.get(p).push(b);
  });
  const provinces = Array.from(byProvince.entries())
    .map(([province, branches]) => ({ province, branch_count: branches.length }))
    .sort((a, b) => b.branch_count - a.branch_count);

  return json(res, 200, { total_branches: (data || []).length, provinces, branches: data || [] });
}

// ---------------------------------------------------------------- employee_home_import
// (map feature groundwork, §4 bulk import from HR) — updates existing employees
// only; never inserts, so a typo'd code just gets skipped instead of creating
// a broken half-row.

async function employeeHomeImport(res, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูล');

  const { data: existing, error: exErr } = await supabase.from('employees').select('code');
  if (exErr) return fail(res, 500, exErr.message);
  const knownCodes = new Set((existing || []).map((e) => e.code));

  let updated = 0;
  const skipped = [];
  for (const row of rows) {
    const code = String(row.code || '').trim();
    if (!code) { skipped.push({ code, reason: 'ไม่มีรหัสพนักงาน' }); continue; }
    if (!knownCodes.has(code)) { skipped.push({ code, reason: 'ไม่พบพนักงานนี้ในระบบ' }); continue; }

    const lat = row.home_lat === null || row.home_lat === undefined || row.home_lat === '' ? null : Number(row.home_lat);
    const lng = row.home_lng === null || row.home_lng === undefined || row.home_lng === '' ? null : Number(row.home_lng);
    const { error } = await supabase
      .from('employees')
      .update({
        home_address: row.home_address || null,
        home_subdistrict: row.home_subdistrict || null,
        home_district: row.home_district || null,
        home_province: row.home_province || null,
        home_lat: Number.isFinite(lat) ? lat : null,
        home_lng: Number.isFinite(lng) ? lng : null
      })
      .eq('code', code);
    if (error) { skipped.push({ code, reason: error.message }); continue; }
    updated++;
  }

  return json(res, 200, { ok: true, updated, skipped: skipped.length, skipped_detail: skipped });
}

// ---------------------------------------------------------------- hotel_import
// (map feature groundwork) — full refresh of one province's hotel entries from
// the Choowap corp-portal research pass. Won't delete a hotel still referenced
// by a real booking_hotel_choices row (keeps booking history intact); everything
// else in the province gets replaced by the fresh batch.

async function hotelImport(res, body) {
  const province = String(body.province || '').trim();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!province) return fail(res, 400, 'ไม่พบจังหวัด');
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูลโรงแรม');

  const { data: existing, error: exErr } = await supabase.from('hotels').select('id').eq('province', province);
  if (exErr) return fail(res, 500, exErr.message);
  const existingIds = (existing || []).map((h) => h.id);

  let referencedIds = new Set();
  if (existingIds.length) {
    const { data: refs, error: refErr } = await supabase
      .from('booking_hotel_choices')
      .select('hotel_id')
      .in('hotel_id', existingIds);
    if (refErr) return fail(res, 500, refErr.message);
    referencedIds = new Set((refs || []).map((r) => r.hotel_id));
  }

  const deletableIds = existingIds.filter((id) => !referencedIds.has(id));
  let deleted = 0;
  if (deletableIds.length) {
    const { error: delErr } = await supabase.from('hotels').delete().in('id', deletableIds);
    if (delErr) return fail(res, 500, delErr.message);
    deleted = deletableIds.length;
  }

  const valid = [];
  const skipped = [];
  rows.forEach((row, i) => {
    const name = String(row.name || '').trim();
    const price = Number(row.price);
    if (!name || !Number.isFinite(price)) { skipped.push({ row: i + 1, reason: 'ไม่มีชื่อหรือราคา' }); return; }
    const lat = Number(row.lat), lng = Number(row.lng);
    const reviewScore = Number(row.review_score);
    valid.push({
      name,
      province,
      district: row.district || null,
      address: row.address || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      map_link: Number.isFinite(lat) && Number.isFinite(lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null,
      default_price_per_night: price,
      review_score: Number.isFinite(reviewScore) ? reviewScore : null,
      review_url: row.review_url || null,
      choowap_addi_id: row.choowap_addi_id ? String(row.choowap_addi_id) : null,
      source: 'choowap',
      is_custom: false,
      active: true
    });
  });

  let inserted = 0;
  if (valid.length) {
    const { error: insErr } = await supabase.from('hotels').insert(valid);
    if (insErr) return fail(res, 500, insErr.message);
    inserted = valid.length;
  }

  return json(res, 200, {
    ok: true,
    province,
    deleted,
    kept_referenced: referencedIds.size,
    inserted,
    skipped: skipped.length,
    skipped_detail: skipped
  });
}

// ---------------------------------------------------------------- shared helpers

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((new Date(b).getTime() - a.getTime()) / 86400000);
}
