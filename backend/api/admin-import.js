const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin, AREA_APPROVER_POSITION, isAreaApprover, getAreaTeamCodes } = require('../lib/auth');
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

  // One carved-out action for AREA approvers — everything else in this file
  // stays strictly admin-only, checked right below as before.
  if (req.method === 'GET' && req.query.action === 'area_pending_schedule') {
    if (!isAreaApprover(actor)) return fail(res, 403, 'เฉพาะผู้ตรวจอนุมัติพื้นที่เท่านั้น');
    return areaPendingSchedule(res, actor);
  }

  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  if (req.method === 'GET') {
    if (req.query.action === 'schedule_pending') return schedulePending(res);
    if (req.query.action === 'branch_provinces') return branchProvinces(res);
    if (req.query.action === 'area_assignments') return areaAssignmentsList(res);
    if (req.query.action === 'schedule_flow') return scheduleFlow(res);
    if (req.query.action === 'urgent_now') return urgentNow(res);
    if (req.query.action === 'cycle_time') return cycleTime(res);
    if (req.query.action === 'employee_list') return employeeList(res);
    if (req.query.action === 'hotel_list') return hotelList(res);
    return fail(res, 400, `ไม่รู้จัก action: ${req.query.action}`);
  }

  if (req.method === 'POST') {
    if (body.action === 'schedule_import') return scheduleImport(res, actor, body);
    if (body.action === 'branch_import') return branchImport(res, actor, body);
    if (body.action === 'schedule_remind') return scheduleRemind(res, actor, body);
    if (body.action === 'schedule_delete') return scheduleDelete(res, body);
    if (body.action === 'employee_home_import') return employeeHomeImport(res, body);
    if (body.action === 'hotel_import') return hotelImport(res, body);
    if (body.action === 'backfill_hotel_codes') return backfillHotelCodes(res);
    if (body.action === 'hotel_geocode') return hotelGeocode(res, body);
    if (body.action === 'hotel_places_lookup') return hotelPlacesLookup(res, body);
    if (body.action === 'area_assignment_save') return areaAssignmentSave(res, body);
    if (body.action === 'area_approver_add') return areaApproverAdd(res, body);
    if (body.action === 'legacy_import') return legacyImport(res, body);
    if (body.action === 'employee_update') return employeeUpdate(res, body);
    if (body.action === 'hotel_update_coords') return hotelUpdateCoords(res, body);
    if (body.action === 'hotel_maplink_apply') return hotelMaplinkApply(res, body);
    if (body.action === 'hotel_remove') return hotelRemove(res, body);
    if (body.action === 'hotel_coords_apply') return hotelCoordsApply(res, body);
    if (body.action === 'legacy_guest_names_update') return legacyGuestNamesUpdate(res, body);
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

// ---------------------------------------------------------------- schedule_flow — every schedule row's current pipeline stage

const SCHEDULE_STAGE_BY_STATUS = {
  'ส่งคำขอ': 'awaiting_area',
  'อนุมัติพื้นที่แล้ว': 'awaiting_admin',
  'ดำเนินการจอง': 'admin_processing',
  'จองสำเร็จ': 'done',
  'ต้องแก้ไข': 'needs_fix',
  'ติดปัญหา': 'problem'
};

async function scheduleFlow(res) {
  const { data: schedule, error: schedErr } = await supabase
    .from('work_schedule')
    .select('id, team_code, branch_code, date_start, date_end, branches(name)')
    .order('date_start');
  if (schedErr) return fail(res, 500, schedErr.message);

  const { data: bookings, error: bookErr } = await supabase
    .from('bookings')
    .select('work_schedule_id, status, checkin_date')
    .not('work_schedule_id', 'is', null);
  if (bookErr) return fail(res, 500, bookErr.message);
  // At most one live booking per work_schedule_id — cancel_booking hard-deletes,
  // edit updates in place, so this is never ambiguous in practice.
  const bookingByScheduleId = new Map((bookings || []).map((b) => [b.work_schedule_id, b]));

  const rows = (schedule || []).map((s) => {
    const b = bookingByScheduleId.get(s.id);
    return {
      id: s.id,
      team_code: s.team_code,
      branch_name: s.branches?.name || s.branch_code,
      date_start: s.date_start,
      date_end: s.date_end,
      stage: b ? (SCHEDULE_STAGE_BY_STATUS[b.status] || 'unknown') : 'not_booked',
      booking_status: b ? b.status : null
    };
  });

  return json(res, 200, { rows });
}

// ---------------------------------------------------------------- area_pending_schedule
// Same shape as schedule_flow, but scoped to the teams this AREA approver
// covers — lets them proactively check which of their teams' jobs still
// haven't been requested at all, not just what's sitting in their own queue.

async function areaPendingSchedule(res, actor) {
  const teamCodes = await getAreaTeamCodes(actor.code);
  if (!teamCodes.length) return json(res, 200, { rows: [] });

  const { data: schedule, error: schedErr } = await supabase
    .from('work_schedule')
    .select('id, team_code, branch_code, date_start, date_end, branches(name)')
    .in('team_code', teamCodes)
    .order('date_start');
  if (schedErr) return fail(res, 500, schedErr.message);

  const { data: bookings, error: bookErr } = await supabase
    .from('bookings')
    .select('work_schedule_id, status, checkin_date')
    .not('work_schedule_id', 'is', null);
  if (bookErr) return fail(res, 500, bookErr.message);
  const bookingByScheduleId = new Map((bookings || []).map((b) => [b.work_schedule_id, b]));

  const rows = (schedule || []).map((s) => {
    const b = bookingByScheduleId.get(s.id);
    return {
      id: s.id,
      team_code: s.team_code,
      branch_name: s.branches?.name || s.branch_code,
      date_start: s.date_start,
      date_end: s.date_end,
      stage: b ? (SCHEDULE_STAGE_BY_STATUS[b.status] || 'unknown') : 'not_booked',
      booking_status: b ? b.status : null
    };
  });

  return json(res, 200, { rows });
}

// ---------------------------------------------------------------- urgent_now
// One combined "what needs attention right now" feed across the three places
// a booking can silently stall — unbooked jobs, AREA review, and a missing
// voucher — instead of a head having to check schedule_flow, the AREA queue,
// and the admin queue separately to see what's actually at risk today.

async function urgentNow(res) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysUntil = (dateStr) => Math.round((new Date(dateStr).getTime() - today.getTime()) / 86400000);

  const { data: schedule, error: schedErr } = await supabase
    .from('work_schedule')
    .select('id, team_code, branch_code, date_start, advance_days, branches(name)');
  if (schedErr) return fail(res, 500, schedErr.message);
  const { data: scheduledBookings, error: sbErr } = await supabase
    .from('bookings').select('work_schedule_id').not('work_schedule_id', 'is', null);
  if (sbErr) return fail(res, 500, sbErr.message);
  const bookedScheduleIds = new Set((scheduledBookings || []).map((b) => b.work_schedule_id));

  const items = [];
  (schedule || []).forEach((s) => {
    if (bookedScheduleIds.has(s.id)) return;
    const target = addDays(s.date_start, -(s.advance_days || 0));
    const d = daysUntil(target);
    if (d > 5) return;
    items.push({ type: 'not_booked', schedule_id: s.id, team_code: s.team_code, branch_name: s.branches?.name || s.branch_code, date: s.date_start, days_until: d });
  });

  const { data: bookings, error: bErr } = await supabase
    .from('bookings')
    .select('id, team_code, branch_code, status, checkin_date, voucher_file_url, voucher_storage_path, branches(name)')
    .in('status', ['ส่งคำขอ', 'ดำเนินการจอง']);
  if (bErr) return fail(res, 500, bErr.message);
  (bookings || []).forEach((b) => {
    const d = daysUntil(b.checkin_date);
    if (b.status === 'ส่งคำขอ' && d <= 4) {
      items.push({ type: 'awaiting_area', booking_id: b.id, team_code: b.team_code, branch_name: b.branches?.name || b.branch_code, date: b.checkin_date, days_until: d });
    }
    if (b.status === 'ดำเนินการจอง' && d <= 2 && !b.voucher_file_url && !b.voucher_storage_path) {
      items.push({ type: 'missing_voucher', booking_id: b.id, team_code: b.team_code, branch_name: b.branches?.name || b.branch_code, date: b.checkin_date, days_until: d });
    }
  });

  items.sort((a, b) => a.days_until - b.days_until);
  return json(res, 200, { items });
}

// ---------------------------------------------------------------- cycle_time
// How long each stage actually takes, from booking_status_log — the dashboard
// answers "how much money" but nothing today answers "how much time," which
// is the other half of "did the AREA-approval stage actually help."

async function cycleTime(res) {
  const { data: logs, error } = await supabase
    .from('booking_status_log')
    .select('booking_id, from_status, to_status, changed_by, changed_at')
    .order('changed_at');
  if (error) return fail(res, 500, error.message);

  const byBooking = new Map();
  (logs || []).forEach((l) => {
    if (!byBooking.has(l.booking_id)) byBooking.set(l.booking_id, []);
    byBooking.get(l.booking_id).push(l);
  });

  const areaHours = []; // ส่งคำขอ -> อนุมัติพื้นที่แล้ว, keyed by who approved
  const adminHours = []; // อนุมัติพื้นที่แล้ว (or ส่งคำขอ) -> ดำเนินการจอง, keyed by who started it

  for (const rows of byBooking.values()) {
    const at = (status) => rows.find((r) => r.to_status === status);
    const submitted = at('ส่งคำขอ');
    const areaApproved = at('อนุมัติพื้นที่แล้ว');
    const processing = at('ดำเนินการจอง');
    if (submitted && areaApproved) {
      areaHours.push({ code: areaApproved.changed_by, hours: (new Date(areaApproved.changed_at) - new Date(submitted.changed_at)) / 3600000 });
    }
    if (processing) {
      const from = areaApproved || submitted;
      if (from) adminHours.push({ code: processing.changed_by, hours: (new Date(processing.changed_at) - new Date(from.changed_at)) / 3600000 });
    }
  }

  const { data: employees } = await supabase.from('employees').select('code, name, nickname');
  const nameByCode = new Map((employees || []).map((e) => [e.code, e.nickname || e.name]));

  const groupBy = (rows) => {
    const byCode = new Map();
    rows.forEach((r) => {
      if (!byCode.has(r.code)) byCode.set(r.code, []);
      byCode.get(r.code).push(r.hours);
    });
    return Array.from(byCode.entries()).map(([code, hoursList]) => ({
      code,
      name: nameByCode.get(code) || code,
      count: hoursList.length,
      avg_hours: Math.round((hoursList.reduce((a, h) => a + h, 0) / hoursList.length) * 10) / 10
    })).sort((a, b) => b.count - a.count);
  };

  const avgOf = (rows) => rows.length ? Math.round((rows.reduce((a, r) => a + r.hours, 0) / rows.length) * 10) / 10 : null;

  return json(res, 200, {
    area_avg_hours: avgOf(areaHours),
    admin_avg_hours: avgOf(adminHours),
    area_by_approver: groupBy(areaHours),
    admin_by_person: groupBy(adminHours)
  });
}

// ---------------------------------------------------------------- employee_list / employee_update

async function employeeList(res) {
  const { data, error } = await supabase
    .from('employees')
    .select('code, name, nickname, team_code, gender, phone, position, active, line_user_id, home_lat, home_lng')
    .order('team_code');
  if (error) return fail(res, 500, error.message);
  return json(res, 200, { employees: data || [] });
}

async function hotelList(res) {
  const { data, error } = await supabase
    .from('hotels')
    .select('id, code, name, province, district, address, near_area, lat, lng, source, is_custom, active')
    .order('province');
  if (error) return fail(res, 500, error.message);
  return json(res, 200, { hotels: data || [] });
}

async function employeeUpdate(res, body) {
  const code = String(body.code || '').trim();
  if (!code) return fail(res, 400, 'ไม่ได้ระบุรหัสพนักงาน');

  const patch = {};
  if (body.team_code !== undefined) patch.team_code = body.team_code || null;
  if (body.position !== undefined) patch.position = body.position || null;
  if (body.gender !== undefined) patch.gender = body.gender === 'M' || body.gender === 'F' ? body.gender : null;
  if (body.phone !== undefined) patch.phone = body.phone || null;
  if (body.active !== undefined) patch.active = !!body.active;
  if (Object.keys(patch).length === 0) return fail(res, 400, 'ไม่มีข้อมูลที่จะแก้ไข');

  const { error } = await supabase.from('employees').update(patch).eq('code', code);
  if (error) return fail(res, 500, error.message);
  return json(res, 200, { ok: true });
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
// (map feature groundwork, §4 bulk import from HR) — updates address fields on a
// known employee; creates a new employee row when the code doesn't exist yet
// (needs name + a valid team_code, since employees.team_code is a real FK —
// missing either just skips that row with a reason instead of a half-row insert).

async function employeeHomeImport(res, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูล');

  const { data: existing, error: exErr } = await supabase.from('employees').select('code');
  if (exErr) return fail(res, 500, exErr.message);
  const knownCodes = new Set((existing || []).map((e) => e.code));

  const { data: teams, error: teamErr } = await supabase.from('teams').select('code');
  if (teamErr) return fail(res, 500, teamErr.message);
  const knownTeamCodes = new Set((teams || []).map((t) => t.code));

  const homeFields = (row) => {
    const lat = row.home_lat === null || row.home_lat === undefined || row.home_lat === '' ? null : Number(row.home_lat);
    const lng = row.home_lng === null || row.home_lng === undefined || row.home_lng === '' ? null : Number(row.home_lng);
    return {
      home_address: row.home_address || null,
      home_subdistrict: row.home_subdistrict || null,
      home_district: row.home_district || null,
      home_province: row.home_province || null,
      home_lat: Number.isFinite(lat) ? lat : null,
      home_lng: Number.isFinite(lng) ? lng : null
    };
  };

  let updated = 0, created = 0;
  const skipped = [];
  for (const row of rows) {
    const code = String(row.code || '').trim();
    if (!code) { skipped.push({ code, reason: 'ไม่มีรหัสพนักงาน' }); continue; }

    if (knownCodes.has(code)) {
      const { error } = await supabase.from('employees').update(homeFields(row)).eq('code', code);
      if (error) { skipped.push({ code, reason: error.message }); continue; }
      updated++;
      continue;
    }

    const name = String(row.name || '').trim();
    const teamCode = String(row.team_code || '').trim();
    if (!name) { skipped.push({ code, reason: 'ไม่มีชื่อ — สร้างพนักงานใหม่ไม่ได้' }); continue; }
    if (!teamCode || !knownTeamCodes.has(teamCode)) { skipped.push({ code, reason: `ไม่พบทีม "${teamCode || '(ว่าง)'}" — สร้างพนักงานใหม่ไม่ได้` }); continue; }

    const gender = row.gender === 'M' || row.gender === 'F' ? row.gender : null;
    const { error } = await supabase.from('employees').insert({
      code,
      name,
      nickname: row.nickname || null,
      team_code: teamCode,
      gender,
      phone: row.phone || null,
      active: true,
      ...homeFields(row)
    });
    if (error) { skipped.push({ code, reason: error.message }); continue; }
    knownCodes.add(code);
    created++;
  }

  return json(res, 200, { ok: true, updated, created, skipped: skipped.length, skipped_detail: skipped });
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
    const choowapAddiId = row.choowap_addi_id ? String(row.choowap_addi_id) : null;
    valid.push({
      // hotels.code is what the frontend's toggleHotel()/hotelIdByCode() key
      // off of — the registry's existing rows use "H###", but Choowap's own
      // addi_id is already unique per hotel, so prefixing it sidesteps any
      // collision with those without needing to know the current max H###.
      code: choowapAddiId ? `CW${choowapAddiId}` : null,
      name,
      province,
      district: row.district || null,
      address: row.address || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      map_link: Number.isFinite(lat) && Number.isFinite(lng) ? `https://www.google.com/maps?q=${lat},${lng}(${encodeURIComponent(name)})` : null,
      default_price_per_night: price,
      review_score: Number.isFinite(reviewScore) ? reviewScore : null,
      review_url: row.review_url || null,
      choowap_addi_id: choowapAddiId,
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

// ---------------------------------------------------------------- hotel_update_coords
// Spot-fix for a single mis-geocoded hotel — found by cross-checking the
// distance a booking form showed against the hotel's real listing on Google
// Maps (a ปราจีนบุรี hotel batch had several entries pinned many km from
// their real address despite the correct province). Rather than re-running
// the whole province's hotelImport() (which replaces every unreferenced
// hotel in that province), this only ever touches the one row named.

async function hotelUpdateCoords(res, body) {
  const code = String(body.code || '').trim();
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!code) return fail(res, 400, 'ไม่ได้ระบุรหัสที่พัก');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(res, 400, 'พิกัดไม่ถูกต้อง');
  const { data: existing } = await supabase.from('hotels').select('name').eq('code', code).maybeSingle();
  if (!existing) return fail(res, 404, 'ไม่พบที่พักรหัสนี้');
  // map_link on Choowap-imported rows is nothing but a frozen "?q=lat,lng"
  // snapshot taken at import time — leaving it untouched here silently
  // re-breaks the "ดูใน Maps" button for every hotel this endpoint fixes,
  // since the frontend falls back to it whenever lat/lng aren't both set.
  // The name is embedded in the query so the pin shows this hotel's own
  // label when clicked, not an unlabeled dot indistinguishable from any other.
  const mapLink = `https://www.google.com/maps?q=${lat},${lng}(${encodeURIComponent(existing.name)})`;
  const { data, error } = await supabase.from('hotels').update({ lat, lng, map_link: mapLink }).eq('code', code).select('id, name').maybeSingle();
  if (error) return fail(res, 500, error.message);
  return json(res, 200, { ok: true, name: data.name });
}

// ------------------------------------------------------------ hotel_maplink_apply
// Bulk write-back for the coordinate audit CSV: sets map_link (the working
// query_place_id direct-jump link, built from the Places/Geocoding lookups)
// per hotel. Never touches lat/lng — the audit deliberately left those alone
// once a hotel's coordinates were separately confirmed.
const HOTEL_MAPLINK_BATCH_CAP = 200;

async function hotelMaplinkApply(res, body) {
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return fail(res, 400, 'ไม่มีข้อมูลให้ปรับปรุง');
  if (updates.length > HOTEL_MAPLINK_BATCH_CAP) return fail(res, 400, `ส่งได้ครั้งละไม่เกิน ${HOTEL_MAPLINK_BATCH_CAP} ที่`);

  const results = { updated: 0, failed: [] };
  for (const u of updates) {
    const code = String(u.code || '').trim();
    const mapLink = String(u.map_link || '').trim();
    if (!code || !mapLink) { results.failed.push({ code, reason: 'missing code or map_link' }); continue; }
    const { error } = await supabase.from('hotels').update({ map_link: mapLink }).eq('code', code);
    if (error) results.failed.push({ code, reason: error.message });
    else results.updated++;
  }
  return json(res, 200, { ok: true, ...results });
}

// ---------------------------------------------------------------- hotel_remove
// Deletes hotel rows the operator identified as junk/duplicate (e.g. no
// province/district on record, or a duplicate of another row) during the
// coordinate audit — same "keep booking history intact" guard as
// hotelImport()'s province refresh: a hotel still referenced by a real
// booking_hotel_choices row is deactivated instead of deleted.
async function hotelRemove(res, body) {
  const codes = Array.isArray(body.codes) ? body.codes.map(String) : [];
  if (!codes.length) return fail(res, 400, 'ไม่ได้ระบุรหัสที่พัก');

  const { data: rows, error: selErr } = await supabase.from('hotels').select('id, code').in('code', codes);
  if (selErr) return fail(res, 500, selErr.message);
  const ids = (rows || []).map((r) => r.id);

  let referencedIds = new Set();
  if (ids.length) {
    const { data: refs, error: refErr } = await supabase
      .from('booking_hotel_choices')
      .select('hotel_id')
      .in('hotel_id', ids);
    if (refErr) return fail(res, 500, refErr.message);
    referencedIds = new Set((refs || []).map((r) => r.hotel_id));
  }

  const deletableIds = (rows || []).filter((r) => !referencedIds.has(r.id)).map((r) => r.id);
  const keepIds = (rows || []).filter((r) => referencedIds.has(r.id)).map((r) => r.id);

  let deleted = 0, deactivated = 0;
  if (deletableIds.length) {
    const { error: delErr } = await supabase.from('hotels').delete().in('id', deletableIds);
    if (delErr) return fail(res, 500, delErr.message);
    deleted = deletableIds.length;
  }
  if (keepIds.length) {
    const { error: deErr } = await supabase.from('hotels').update({ active: false }).in('id', keepIds);
    if (deErr) return fail(res, 500, deErr.message);
    deactivated = keepIds.length;
  }
  return json(res, 200, { ok: true, deleted, deactivated, found: (rows || []).length, requested: codes.length });
}

// ------------------------------------------------------------ hotel_coords_apply
// Bulk write-back for the coordinate audit's verified corrections (AI deep
// research + Geocoding + Places API, all cross-checked against the current
// value before being called "wrong") — same batch shape as
// hotel_maplink_apply, distinct action since it writes lat/lng instead.
const HOTEL_COORDS_BATCH_CAP = 200;

async function hotelCoordsApply(res, body) {
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return fail(res, 400, 'ไม่มีข้อมูลให้ปรับปรุง');
  if (updates.length > HOTEL_COORDS_BATCH_CAP) return fail(res, 400, `ส่งได้ครั้งละไม่เกิน ${HOTEL_COORDS_BATCH_CAP} ที่`);

  const results = { updated: 0, failed: [] };
  for (const u of updates) {
    const code = String(u.code || '').trim();
    const lat = Number(u.lat), lng = Number(u.lng);
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) { results.failed.push({ code, reason: 'missing code or coords' }); continue; }
    const { error } = await supabase.from('hotels').update({ lat, lng }).eq('code', code);
    if (error) results.failed.push({ code, reason: error.message });
    else results.updated++;
  }
  return json(res, 200, { ok: true, ...results });
}

// ---------------------------------------------------------------- hotel_geocode
// Batched Google Geocoding API lookup — report-only, never writes lat/lng
// itself. Every automated attempt at bulk hotel coordinates this project has
// tried (Choowap import, a district-centroid heuristic, free Nominatim
// geocoding) turned out wrong or simply had no data for small Thai
// guesthouses; Google's own index is the one source with real coverage for
// them, but still needs a human to look at the result before trusting it —
// same "verify before apply" pattern as the manual audit this replaces.
// Capped at 80 hotels per call to stay well inside a serverless function's
// execution window (see vercel.json maxDuration for this file).
const HOTEL_GEOCODE_BATCH_CAP = 80;

async function hotelGeocode(res, body) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return fail(res, 500, 'ยังไม่ได้ตั้งค่า GOOGLE_MAPS_API_KEY ใน Vercel (Settings > Environment Variables แล้ว Redeploy)');

  const codes = Array.isArray(body.codes) ? body.codes.map(String) : null;
  let q = supabase.from('hotels').select('code, name, province, district, lat, lng').eq('active', true).order('code');
  if (codes && codes.length) q = q.in('code', codes);
  else q = q.limit(HOTEL_GEOCODE_BATCH_CAP);
  const { data: hotels, error } = await q;
  if (error) return fail(res, 500, error.message);
  if (codes && codes.length > HOTEL_GEOCODE_BATCH_CAP) return fail(res, 400, `ส่งได้ครั้งละไม่เกิน ${HOTEL_GEOCODE_BATCH_CAP} ที่`);

  const results = [];
  for (const h of hotels || []) {
    const query = h.district ? `${h.name} อ.${h.district} จ.${h.province}` : `${h.name} จ.${h.province}`;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=th&language=th&components=country:TH&key=${key}`;
    try {
      const r = await fetch(url);
      const d = await r.json();
      if (d.status === 'OK' && d.results && d.results[0]) {
        const g = d.results[0];
        results.push({
          code: h.code, name: h.name, query,
          current_lat: h.lat, current_lng: h.lng,
          found_lat: g.geometry.location.lat, found_lng: g.geometry.location.lng,
          formatted_address: g.formatted_address,
          location_type: g.geometry.location_type,
          partial_match: !!g.partial_match
        });
      } else {
        results.push({ code: h.code, name: h.name, query, current_lat: h.lat, current_lng: h.lng, status: d.status, error: d.error_message || null });
      }
    } catch (e) {
      results.push({ code: h.code, name: h.name, query, current_lat: h.lat, current_lng: h.lng, error: e.message });
    }
  }
  return json(res, 200, { ok: true, count: results.length, results });
}

// ---------------------------------------------------------------- hotel_places_lookup
// hotel_geocode (Geocoding API) only matches structured postal addresses, so
// it came back low-confidence for ~360/667 hotels — small guesthouses with no
// registered address at all. Places Text Search searches by business name
// instead (the same mechanism behind Maps' own search bar and the
// name+district+province search links already used elsewhere in this app),
// so it should resolve exactly the cases the address-based lookup couldn't.
// Uses Places API (New) — the legacy findplacefromtext endpoint returns
// REQUEST_DENIED on projects that only enabled the old "Places API" product;
// Google now gates new projects to "Places API (New)" specifically, a
// different product in the API library with a different request shape
// (POST + JSON body + a required response field mask, not GET + query
// string). Same key, same env var, just a different API enabled on it.
const HOTEL_PLACES_BATCH_CAP = 80;

async function hotelPlacesLookup(res, body) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return fail(res, 500, 'ยังไม่ได้ตั้งค่า GOOGLE_MAPS_API_KEY ใน Vercel (Settings > Environment Variables แล้ว Redeploy)');

  const codes = Array.isArray(body.codes) ? body.codes.map(String) : null;
  let q = supabase.from('hotels').select('code, name, province, district, lat, lng').eq('active', true).order('code');
  if (codes && codes.length) q = q.in('code', codes);
  else q = q.limit(HOTEL_PLACES_BATCH_CAP);
  const { data: hotels, error } = await q;
  if (error) return fail(res, 500, error.message);
  if (codes && codes.length > HOTEL_PLACES_BATCH_CAP) return fail(res, 400, `ส่งได้ครั้งละไม่เกิน ${HOTEL_PLACES_BATCH_CAP} ที่`);

  const results = [];
  for (const h of hotels || []) {
    const query = h.district ? `${h.name} อ.${h.district} จ.${h.province}` : `${h.name} จ.${h.province}`;
    try {
      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
        },
        body: JSON.stringify({ textQuery: query, languageCode: 'th', regionCode: 'TH' })
      });
      const d = await r.json();
      if (d.places && d.places[0]) {
        const p = d.places[0];
        results.push({
          code: h.code, name: h.name, query,
          current_lat: h.lat, current_lng: h.lng,
          found_name: p.displayName && p.displayName.text,
          found_lat: p.location.latitude, found_lng: p.location.longitude,
          formatted_address: p.formattedAddress,
          place_id: p.id
        });
      } else {
        results.push({ code: h.code, name: h.name, query, current_lat: h.lat, current_lng: h.lng, status: 'NO_MATCH', error: (d.error && d.error.message) || null });
      }
    } catch (e) {
      results.push({ code: h.code, name: h.name, query, current_lat: h.lat, current_lng: h.lng, error: e.message });
    }
  }
  return json(res, 200, { ok: true, count: results.length, results });
}

// ---------------------------------------------------------------- backfill_hotel_codes
// One-off repair: every one of today's 662 Choowap-imported hotels went in
// with hotels.code left null (hotelImport() didn't set it at the time), which
// made them completely unselectable in the booking form — toggleHotel(esc(h.code))
// resolved to toggleHotel('') for all of them, indistinguishable from each
// other. Fixed going forward in hotelImport(); this repairs the rows already
// in the table using their choowap_addi_id, which is already unique per hotel.

async function backfillHotelCodes(res) {
  const { data: rows, error: selErr } = await supabase
    .from('hotels')
    .select('id, choowap_addi_id')
    .is('code', null)
    .not('choowap_addi_id', 'is', null);
  if (selErr) return fail(res, 500, selErr.message);

  let updated = 0;
  const failed = [];
  for (const r of rows || []) {
    const { error } = await supabase.from('hotels').update({ code: `CW${r.choowap_addi_id}` }).eq('id', r.id);
    if (error) failed.push({ id: r.id, reason: error.message });
    else updated++;
  }

  return json(res, 200, { ok: true, updated, failed: failed.length, failed_detail: failed });
}

// ---------------------------------------------------------------- area_team_assignments (AREA approval stage)

async function areaApproverAdd(res, body) {
  const code = String(body.area_employee_code || '').trim();
  if (!code) return fail(res, 400, 'ไม่ได้ระบุรหัสพนักงาน');
  const { data: emp, error: empErr } = await supabase.from('employees').select('code').eq('code', code).maybeSingle();
  if (empErr) return fail(res, 500, empErr.message);
  if (!emp) return fail(res, 400, 'ไม่พบพนักงานรหัสนี้');
  const { error } = await supabase.from('employees').update({ position: AREA_APPROVER_POSITION }).eq('code', code);
  if (error) return fail(res, 500, error.message);
  return json(res, 200, { ok: true });
}

async function areaAssignmentsList(res) {
  const { data: approvers, error: empErr } = await supabase
    .from('employees')
    .select('code, name, nickname')
    .eq('position', AREA_APPROVER_POSITION)
    .eq('active', true);
  if (empErr) return fail(res, 500, empErr.message);

  const { data: assignments, error: asgErr } = await supabase.from('area_team_assignments').select('area_employee_code, team_code');
  if (asgErr) return fail(res, 500, asgErr.message);

  const { data: teams, error: teamErr } = await supabase.from('teams').select('code, name').order('code');
  if (teamErr) return fail(res, 500, teamErr.message);

  const teamCodesByEmp = new Map();
  (assignments || []).forEach((a) => {
    if (!teamCodesByEmp.has(a.area_employee_code)) teamCodesByEmp.set(a.area_employee_code, []);
    teamCodesByEmp.get(a.area_employee_code).push(a.team_code);
  });

  const rows = (approvers || []).map((e) => ({
    code: e.code, name: e.name, nickname: e.nickname, team_codes: teamCodesByEmp.get(e.code) || []
  }));

  return json(res, 200, { approvers: rows, teams: teams || [] });
}

async function areaAssignmentSave(res, body) {
  const code = String(body.area_employee_code || '').trim();
  const teamCodes = Array.isArray(body.team_codes) ? body.team_codes : [];
  if (!code) return fail(res, 400, 'ไม่ได้ระบุผู้ตรวจอนุมัติพื้นที่');

  const { data: emp, error: empErr } = await supabase.from('employees').select('code, position').eq('code', code).maybeSingle();
  if (empErr) return fail(res, 500, empErr.message);
  if (!emp) return fail(res, 400, 'ไม่พบพนักงานนี้');
  if (emp.position !== AREA_APPROVER_POSITION) return fail(res, 400, 'พนักงานนี้ยังไม่ได้ตั้งตำแหน่งเป็นผู้ตรวจอนุมัติพื้นที่');

  // Replace the whole set every save — simpler and safer than diffing, and
  // the set per approver is always small (a handful of teams at most).
  const { error: delErr } = await supabase.from('area_team_assignments').delete().eq('area_employee_code', code);
  if (delErr) return fail(res, 500, delErr.message);

  if (teamCodes.length) {
    const { error: insErr } = await supabase
      .from('area_team_assignments')
      .insert(teamCodes.map((t) => ({ area_employee_code: code, team_code: t })));
    if (insErr) return fail(res, 500, insErr.message);
  }

  return json(res, 200, { ok: true, team_codes: teamCodes });
}

// ---------------------------------------------------------------- legacy_import
// Manual monthly-plan spreadsheets (per-branch rows, not per-guest bookings)
// dropped straight into booking_legacy_summary as a stopgap snapshot — for
// months the admin is still tracking on paper/Excel while the real bookings
// get entered through the live flow. id is prefixed per import batch so a
// later cleanup pass (once the matching live bookings exist) can find and
// delete this exact batch with a single `id LIKE` query instead of guessing.

async function legacyImport(res, body) {
  const monthStart = String(body.month_start || '').trim();
  const monthLabel = String(body.month_label || '').trim();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const batchTag = String(body.batch_tag || '').trim();
  if (!monthStart || !monthLabel) return fail(res, 400, 'ไม่พบเดือนของข้อมูล');
  if (!batchTag) return fail(res, 400, 'ไม่พบ batch_tag สำหรับ import นี้');
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูล');

  const valid = [];
  const skipped = [];
  rows.forEach((row, i) => {
    const teamCode = String(row.team_code || '').trim();
    const branchName = String(row.branch_name || '').trim();
    const hotelName = String(row.hotel_name || '').trim();
    const nights = Number(row.nights);
    const rooms = Number(row.rooms);
    const people = Number(row.people);
    const pricePerRoomNight = Number(row.price_per_room_night);
    const totalCost = Number(row.total_cost);
    const emptyBeds = Number(row.empty_beds) || 0;
    const reasons = [];
    if (!teamCode) reasons.push('ไม่มีทีม');
    if (!branchName) reasons.push('ไม่มีชื่อสาขา');
    if (!hotelName) reasons.push('ไม่มีชื่อที่พัก');
    if (!Number.isFinite(nights) || nights <= 0) reasons.push('จำนวนคืนไม่ถูกต้อง');
    if (!Number.isFinite(people) || people <= 0) reasons.push('จำนวนคนไม่ถูกต้อง');
    if (!Number.isFinite(totalCost)) reasons.push('ยอดรวมค่าใช้จ่ายไม่ถูกต้อง');

    if (reasons.length) { skipped.push({ row: i + 1, reasons }); return; }

    const personNights = people * nights;
    // teams.code is stored uppercase ("AREA") — the source spreadsheet's own
    // casing ("Area") would otherwise violate the team_code foreign key.
    const normalizedTeamCode = teamCode.toUpperCase() === 'AREA' ? 'AREA' : teamCode;
    valid.push({
      id: `${batchTag}-${i + 1}`,
      month_label: monthLabel,
      month_start: monthStart,
      src: normalizedTeamCode === 'AREA' ? 'AREA' : 'SMA',
      team_code: normalizedTeamCode,
      branch_code: row.branch_code || null,
      branch_name: branchName,
      hotel_name: hotelName,
      checkin_date: row.checkin_date || null,
      checkout_date: row.checkout_date || null,
      // Distinct from checkin/checkout: the actual on-site work dates, one day
      // narrower than the hotel stay (staff arrive the night before, leave the
      // morning after). Falls back to the hotel dates for older batches that
      // never recorded this separately.
      event_date_start: row.event_date_start || row.checkin_date || null,
      event_date_end: row.event_date_end || row.checkout_date || null,
      guest_names: row.guest_names || null,
      nights,
      rooms: Number.isFinite(rooms) ? rooms : null,
      people,
      male: Number.isFinite(Number(row.male)) ? Number(row.male) : null,
      female: Number.isFinite(Number(row.female)) ? Number(row.female) : null,
      capacity: people + emptyBeds,
      empty_beds: emptyBeds,
      price_per_room_night: Number.isFinite(pricePerRoomNight) ? pricePerRoomNight : null,
      total_cost: totalCost,
      person_nights: personNights,
      baht_per_person_night: personNights > 0 ? Math.round((totalCost / personNights) * 100) / 100 : 0,
      empty_bed_cost: Number.isFinite(pricePerRoomNight) ? Math.round((pricePerRoomNight / 2) * emptyBeds * nights * 100) / 100 : 0,
      date_status: 'manual_snapshot',
      needs_manual_fix: false
    });
  });

  let inserted = 0;
  if (valid.length > 0) {
    const { error } = await supabase.from('booking_legacy_summary').insert(valid);
    if (error) return fail(res, 500, error.message);
    inserted = valid.length;
  }

  return json(res, 200, { ok: true, inserted, skipped: skipped.length, skipped_detail: skipped });
}

// ------------------------------------------------------------ legacy_guest_names_update
// Manual bookings imported via legacy_import carry no guest names (the source
// spreadsheets only ever had head-counts by gender) — this lets an admin fill
// them in afterward from the dashboard, same free-text shape as the column.
async function legacyGuestNamesUpdate(res, body) {
  const id = String(body.id || '').trim();
  const guestNames = String(body.guest_names || '').trim();
  if (!id) return fail(res, 400, 'ไม่พบรหัสรายการ');
  const { data, error } = await supabase
    .from('booking_legacy_summary')
    .update({ guest_names: guestNames || null })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) return fail(res, 500, error.message);
  if (!data) return fail(res, 404, 'ไม่พบรายการนี้');
  return json(res, 200, { ok: true, id: data.id });
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
