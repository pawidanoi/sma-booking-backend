const { supabase } = require('../lib/supabase');
const { json, fail, readBody, roomsFor, nightsBetween, emptyBedsByGender } = require('../lib/http');
const { getActor, isAdmin: checkIsAdmin, isAreaApprover, getAreaTeamCodes, canAreaApprove } = require('../lib/auth');
const { drivingDistance } = require('../lib/directions');
const { push, qrUri, liffLink } = require('../lib/line');

const MISSION_TYPES = ['งานแฟร์', 'งานเปิดสาขา', 'สำรวจพื้นที่', 'อื่นๆ'];
const MAX_PRICE_PER_ROOM_NIGHT = 600;
// สรุป-requirement-แผนที่จองที่พัก.md §3 — home-distance-rule: warn (not block)
// when the employee's home is closer to the branch than this, since going home
// beats booking a room. Follows the same "push a string into rule_violations,
// forcing admin review" pattern as the RATE_CAP/empty-bed rules — no separate
// enforcement path to maintain.
const HOME_DISTANCE_WARN_KM = 10;

// booking_status_log — every status transition, from the first insert onward,
// so admin time-saved can eventually be measured against a real "before".
async function logStatus(bookingId, fromStatus, toStatus, changedBy) {
  await supabase.from('booking_status_log').insert({ booking_id: bookingId, from_status: fromStatus, to_status: toStatus, changed_by: changedBy });
}

// A guest's employee_code on the web form can be free-typed (the "ไม่มีในทะเบียน —
// กรอกเอง" path collects a code alongside the name), so a genuine new hire's code
// can reach here before anyone's run the bulk employee import — that used to 500
// on booking_guests' FK straight through to the employee. Auto-create a minimal
// employee row instead, from whatever the guest row itself already carries (same
// shape employee_home_import's create-path uses) — never overwrites an existing
// employee, only fills in one that's genuinely missing.
async function ensureEmployeesExist(guestRows) {
  const codes = [...new Set(guestRows.map((g) => g.employee_code).filter(Boolean))];
  if (!codes.length) return;
  const { data: existing } = await supabase.from('employees').select('code').in('code', codes);
  const knownCodes = new Set((existing || []).map((e) => e.code));
  const missing = codes.filter((c) => !knownCodes.has(c));
  if (!missing.length) return;

  const byCode = new Map();
  guestRows.forEach((g) => { if (missing.includes(g.employee_code) && !byCode.has(g.employee_code)) byCode.set(g.employee_code, g); });
  const newEmployees = missing.map((code) => {
    const g = byCode.get(code);
    return {
      code,
      name: g.name,
      team_code: g.team_code || null,
      gender: g.gender === 'M' || g.gender === 'F' ? g.gender : null,
      phone: g.phone || null,
      active: true
    };
  });
  const { error } = await supabase.from('employees').insert(newEmployees);
  if (error) console.error('ensureEmployeesExist failed', error.message);
}

// bookings <-> booking_hotel_choices are joined BOTH ways (choices point at the booking,
// and the booking points back at the one choice the admin picked), so the embed must name
// the constraint explicitly or PostgREST refuses it as ambiguous.
//
// booking_join_requests -> bookings is single-direction (no column on bookings points back
// at a join request), so no !fk hint is needed there — same safe shape as booking_guests.
const BOOKING_SELECT = `
  id, team_code, branch_code, work_schedule_id, checkin_date, checkout_date, status,
  reject_reason, chosen_hotel_choice_id, confirmation_no, voucher_file_url, voucher_storage_path, note,
  mission_type, mission_type_note, auto_approved, rule_violations,
  hotel_picked_by, hotel_picked_at, final_approved_by, final_approved_at,
  created_by_employee, created_at, updated_at,
  branches ( name, province, district, lat, lng ),
  booking_hotel_choices!booking_hotel_choices_booking_id_fkey ( id, hotel_id, custom_name, custom_map_link, custom_price, rank, unavailable_at, hotels ( code, name, province, district, lat, lng, map_link, default_price_per_night, on_choowap ) ),
  booking_guests ( id, team_code, employee_code, name, phone, gender, employees ( home_lat, home_lng ) ),
  booking_changes ( id, type, new_rooms, new_checkin, new_checkout, note, status, created_at ),
  booking_join_requests ( id, requested_by_employee, guest_name, guest_gender, guest_phone, guest_employee_code, guest_team_code, status, decided_by_employee, decided_at, created_at ),
  booking_status_log ( from_status, to_status, changed_by, changed_at )
`;

module.exports = async function handler(req, res) {
  const body = readBody(req);
  const actorCode = (req.query.actor || body.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน — เข้าสู่ระบบอีกครั้ง');

  const isAdmin = checkIsAdmin(actor);

  try {
    if (req.method === 'GET') return await listBookings(req, res, actor, isAdmin);
    if (req.method === 'POST') return await handlePost(req, res, actor, isAdmin, body);
    if (req.method === 'PATCH') return await handlePatch(req, res, actor, isAdmin, body);
    return fail(res, 405, 'method not allowed');
  } catch (err) {
    console.error('bookings handler error', err);
    return fail(res, 500, err.message || 'เกิดข้อผิดพลาดในระบบ');
  }
};

// ---------------------------------------------------------------- read

async function listBookings(req, res, actor, isAdmin) {
  const scope = req.query.scope || 'mine';
  const today = new Date().toISOString().slice(0, 10);
  let q = supabase.from('bookings').select(BOOKING_SELECT).order('created_at', { ascending: false });

  if (scope === 'admin') {
    if (!isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');
  } else if (scope === 'area') {
    if (!isAreaApprover(actor)) return fail(res, 403, 'เฉพาะผู้ตรวจอนุมัติพื้นที่เท่านั้น');
    const teamCodes = await getAreaTeamCodes(actor.code);
    // supabase-js's .in() with an empty array matches nothing correctly, but a
    // sentinel keeps intent explicit rather than relying on that edge case.
    // Also include the AREA person's own bookings — their home team is often not one
    // of the teams they're assigned to approve for, so without this an AREA employee
    // who books a room for themselves never sees it anywhere in their own queue.
    const teamFilter = (teamCodes.length ? teamCodes : ['__none__']).join(',');
    q = q.or(`team_code.in.(${teamFilter}),created_by_employee.eq.${actor.code}`);
  } else if (scope === 'open_beds') {
    // Anyone can browse rooms with a spare bed to request joining — not admin-gated.
    // A real room/hotel choice exists from รอเจ้าของอนุมัติ onward (choose_hotel already
    // ran); the old single "ดำเนินการจอง" stage split into two ("รอเจ้าของอนุมัติ" then
    // "รอเลขยืนยันโรงแรม"), so both need to stay in this list to keep the same real-world
    // set of bookings visible here.
    q = q.in('status', ['รอเจ้าของอนุมัติ', 'รอเลขยืนยันโรงแรม', 'จองสำเร็จ']).gte('checkout_date', today);
  } else {
    // An employee sees what they submitted plus anything else their team submitted,
    // so a stand-in can pick up a booking the usual booker started.
    q = q.or(`created_by_employee.eq.${actor.code},team_code.eq.${actor.team_code}`);
  }

  if (req.query.in_stay === '1') {
    q = q.eq('status', 'จองสำเร็จ').lte('checkin_date', today).gte('checkout_date', today);
  }

  const { data, error } = await q;
  if (error) return fail(res, 500, error.message);
  let rows = (data || []).map(decorate);

  if (scope === 'open_beds' || req.query.empty_beds === '1') {
    rows = rows.filter((b) => b.derived.empty_beds > 0);
  }

  if (scope === 'open_beds') {
    // This scope crosses team boundaries (unlike scope=mine), so it never exposes
    // other people's guest list/hotel/voucher details — just enough to decide whether
    // to request a spot. Admins get the full shape via scope=admin&empty_beds=1 instead.
    rows = rows.map((b) => ({
      id: b.id,
      branch_code: b.branch_code,
      branches: b.branches,
      team_code: b.team_code,
      checkin_date: b.checkin_date,
      checkout_date: b.checkout_date,
      empty_beds: b.derived.empty_beds
    }));
  }

  json(res, 200, { bookings: rows });
}

function decorate(b) {
  const guests = b.booking_guests || [];
  const rooms = roomsFor(guests);
  const nights = nightsBetween(b.checkin_date, b.checkout_date);
  const chosen = (b.booking_hotel_choices || []).find((c) => c.id === b.chosen_hotel_choice_id) || null;
  const pricePerNight = chosen ? (chosen.custom_price ?? chosen.hotels?.default_price_per_night ?? 0) : 0;
  return {
    ...b,
    derived: {
      rooms,
      nights,
      people: guests.length,
      male: guests.filter((g) => g.gender === 'M').length,
      female: guests.filter((g) => g.gender === 'F').length,
      capacity: rooms * 2,
      empty_beds: rooms * 2 - guests.length,
      est_total: pricePerNight * rooms * nights
    }
  };
}

// ---------------------------------------------------------------- create / change request

async function handlePost(req, res, actor, isAdmin, body) {
  const action = body.action || 'create';
  if (action === 'create') return createBooking(req, res, actor, body);
  if (action === 'request_change') return requestChange(req, res, actor, body);
  if (action === 'request_join') return requestJoin(req, res, actor, body);
  return fail(res, 400, `ไม่รู้จัก action: ${action}`);
}

async function nextBookingId() {
  const { data } = await supabase
    .from('bookings')
    .select('id')
    .like('id', 'BK69-%')
    .order('id', { ascending: false })
    .limit(1);
  const last = data && data[0] ? parseInt(String(data[0].id).replace('BK69-', ''), 10) : 460;
  return `BK69-${String((isNaN(last) ? 460 : last) + 1).padStart(4, '0')}`;
}

async function createBooking(req, res, actor, body) {
  const { branch_code, work_schedule_id, checkin_date, checkout_date, note, guests, hotel_choices, mission_type, mission_type_note, home_distance_reason } = body;

  if (!branch_code) return fail(res, 400, 'ยังไม่ได้เลือกสาขา');
  if (!checkin_date || !checkout_date) return fail(res, 400, 'ยังไม่ได้เลือกวันเข้าพัก–วันออก');
  if (new Date(checkout_date) <= new Date(checkin_date)) return fail(res, 400, 'วันออกต้องหลังวันเข้าพัก');
  if (!Array.isArray(guests) || guests.length === 0) return fail(res, 400, 'ยังไม่ได้กรอกผู้เข้าพัก');
  if (!Array.isArray(hotel_choices) || hotel_choices.length === 0) return fail(res, 400, 'ยังไม่ได้เลือกที่พัก');
  if (hotel_choices.length > 3) return fail(res, 400, 'เลือกที่พักได้สูงสุด 3 ที่');

  for (const g of guests) {
    if (!g.name || !String(g.name).trim()) return fail(res, 400, 'ผู้เข้าพักบางคนยังไม่มีชื่อ');
    if (g.gender !== 'M' && g.gender !== 'F') return fail(res, 400, 'ผู้เข้าพักบางคนยังไม่ระบุเพศ');
  }

  // Ad-hoc bookings (no work_schedule_id) must state what the trip is for; a
  // scheduled-job booking's purpose is already implicit (regular team work).
  if (!work_schedule_id) {
    if (!MISSION_TYPES.includes(mission_type)) return fail(res, 400, 'ต้องระบุประเภทภารกิจสำหรับการจองแบบเฉพาะกิจ');
    if (mission_type === 'อื่นๆ' && !String(mission_type_note || '').trim()) return fail(res, 400, 'กรุณาระบุรายละเอียดภารกิจ');
  }

  const { data: branchRow } = await supabase.from('branches').select('code, name, lat, lng').eq('code', branch_code).maybeSingle();
  if (!branchRow) return fail(res, 400, 'ไม่พบรหัสสาขานี้ในทะเบียน');

  // Rule: warn when the same person is already booked on overlapping dates.
  const conflicts = await findGuestConflicts(guests, checkin_date, checkout_date);

  // §8.5 item 2 — originally an auto-approve bypass; since the AREA-approval
  // stage was introduced every booking must land at ส่งคำขอ regardless (see
  // initialStatus below), so this only computes rule_violations as an
  // informational hint now, not a status shortcut. Checks: no date-overlap
  // conflict, every proposed hotel already in the registry (not a custom
  // entry awaiting confirmation), none exceeds the per-room-night price
  // ceiling. A booking with a spare bed (e.g. a lone traveller) is NOT
  // treated as a violation — that's an inherent, unavoidable cost until
  // cross-team room sharing (phase 2) exists, not something review would fix.
  const ruleViolations = [];
  if (conflicts.length) ruleViolations.push(...conflicts);

  // Recomputed server-side (not trusting a client-supplied distance) so the
  // warning can't be spoofed away. Silently skipped when either coordinate is
  // missing — matches the requirement doc's "ไม่มีข้อมูล ไม่ต้องบล็อกการขอที่พัก".
  // Most branches were bulk-imported with lat/lng defaulted to 0,0 rather than
  // left blank — treat that the same as "no coordinates yet" (see the matching
  // hasBranchCoords() guard in index.html), or this computes a meaningless trip
  // to Null Island instead of skipping the check.
  const branchHasCoords = branchRow.lat != null && branchRow.lng != null && branchRow.lat !== 0 && branchRow.lng !== 0;
  if (actor.home_lat != null && actor.home_lng != null && branchHasCoords) {
    const home = await drivingDistance(actor.home_lat, actor.home_lng, branchRow.lat, branchRow.lng);
    if (home && home.distance_km < HOME_DISTANCE_WARN_KM) {
      const reason = String(home_distance_reason || '').trim();
      ruleViolations.push(reason
        ? `บ้านห่างจากสาขาแค่ ${home.distance_km} กม. (ต่ำกว่า ${HOME_DISTANCE_WARN_KM} กม.) — เหตุผลที่ยังขอที่พัก: ${reason}`
        : `บ้านห่างจากสาขาแค่ ${home.distance_km} กม. (ต่ำกว่า ${HOME_DISTANCE_WARN_KM} กม.) — ยังไม่ระบุเหตุผลที่ไม่กลับบ้านแทน`);
    }
  }

  const customChoice = hotel_choices.find((c) => !c.hotel_id);
  if (customChoice) ruleViolations.push(`ที่พัก "${customChoice.custom_name || '(ไม่มีชื่อ)'}" เป็นที่พักนอกทะเบียน ต้องให้แอดมินยืนยันก่อน`);
  const hotelIds = hotel_choices.map((c) => c.hotel_id).filter(Boolean);
  const { data: hotelRows } = hotelIds.length ? await supabase.from('hotels').select('id, name, default_price_per_night').in('id', hotelIds) : { data: [] };
  const hotelById = new Map((hotelRows || []).map((h) => [h.id, h]));
  for (const c of hotel_choices) {
    const price = c.hotel_id ? hotelById.get(c.hotel_id)?.default_price_per_night : c.custom_price;
    if (price != null && Number(price) > MAX_PRICE_PER_ROOM_NIGHT) {
      const name = c.hotel_id ? hotelById.get(c.hotel_id)?.name : c.custom_name;
      ruleViolations.push(`ที่พัก "${name}" ราคา ${price}฿/ห้อง/คืน เกิน ${MAX_PRICE_PER_ROOM_NIGHT}฿`);
    }
  }
  const autoApproved = ruleViolations.length === 0;
  // auto_approved/rule_violations are still computed and stored below purely as
  // an informational hint for AREA/admin — every booking must land at ส่งคำขอ
  // and go through AREA review (checks WHO is staying, not booking-rule
  // compliance), so passing the automatic rule checks no longer skips that.
  const initialStatus = 'ส่งคำขอ';

  const id = await nextBookingId();
  const { error: insErr } = await supabase.from('bookings').insert({
    id,
    team_code: actor.team_code,
    branch_code,
    work_schedule_id: work_schedule_id || null,
    checkin_date,
    checkout_date,
    status: initialStatus,
    note: note || null,
    mission_type: work_schedule_id ? null : mission_type,
    mission_type_note: work_schedule_id ? null : (mission_type === 'อื่นๆ' ? (mission_type_note || null) : null),
    auto_approved: autoApproved,
    rule_violations: ruleViolations.length ? ruleViolations : null,
    created_by_employee: actor.code
  });
  if (insErr) return fail(res, 500, insErr.message);
  await logStatus(id, null, initialStatus, actor.code);

  const guestRows = guests.map((g) => ({
    booking_id: id,
    team_code: g.team_code || actor.team_code,
    employee_code: g.employee_code || null,
    name: String(g.name).trim(),
    phone: g.phone || null,
    gender: g.gender
  }));
  await ensureEmployeesExist(guestRows);
  const { error: gErr } = await supabase.from('booking_guests').insert(guestRows);
  if (gErr) {
    await supabase.from('bookings').delete().eq('id', id);
    return fail(res, 500, `บันทึกผู้เข้าพักไม่สำเร็จ: ${gErr.message}`);
  }

  const choiceRows = hotel_choices.map((c, i) => ({
    booking_id: id,
    hotel_id: c.hotel_id || null,
    custom_name: c.custom_name || null,
    custom_map_link: c.custom_map_link || null,
    custom_price: c.custom_price ?? null,
    custom_lat: c.custom_lat ?? null,
    custom_lng: c.custom_lng ?? null,
    rank: i + 1
  }));
  const { error: cErr } = await supabase.from('booking_hotel_choices').insert(choiceRows);
  if (cErr) {
    await supabase.from('bookings').delete().eq('id', id);
    return fail(res, 500, `บันทึกที่พักที่เลือกไม่สำเร็จ: ${cErr.message}`);
  }

  // Immediate ping the moment a request lands — the daily cron only catches AREA
  // at a fixed "4 days before checkin" checkpoint, which a late-submitted request
  // can sail straight past with nobody ever notified. Best-effort: a LINE failure
  // here must never take the successfully-created booking down with it.
  try {
    await notifyAreaApprovers(actor.team_code, branchRow.name || branch_code, checkin_date, checkout_date);
  } catch (err) {
    console.error('notifyAreaApprovers failed', err);
  }

  const { data: fresh } = await supabase.from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle();
  json(res, 201, { booking: fresh ? decorate(fresh) : null, warnings: conflicts });
}

async function notifyAreaApprovers(teamCode, branchName, checkinDate, checkoutDate) {
  const { data: assignments } = await supabase.from('area_team_assignments').select('area_employee_code').eq('team_code', teamCode);
  const codes = [...new Set((assignments || []).map((a) => a.area_employee_code))];
  if (!codes.length) return;
  const { data: approvers } = await supabase.from('employees').select('line_user_id').in('code', codes);
  const recipients = (approvers || []).map((a) => a.line_user_id).filter(Boolean);
  if (!recipients.length) return;
  const message = {
    type: 'text',
    text: `📋 มีคำขอที่พักใหม่รอตรวจอนุมัติพื้นที่ค่ะ — ทีม ${teamCode} ที่ ${branchName} เข้าพัก ${checkinDate}–${checkoutDate} กดตรวจได้เลยนะคะ 🥭`,
    quickReply: { items: [qrUri('ตรวจเลย', liffLink('/home'))] }
  };
  await Promise.all(recipients.map((lineId) => push(lineId, [message])));
}

async function findGuestConflicts(guests, newCheckin, newCheckout) {
  const codes = guests.map((g) => g.employee_code).filter(Boolean);
  if (codes.length === 0) return [];
  const { data } = await supabase
    .from('booking_guests')
    .select('name, employee_code, bookings!inner ( id, checkin_date, checkout_date, status )')
    .in('employee_code', codes);

  const from = new Date(newCheckin).getTime();
  const to = new Date(newCheckout).getTime();
  const out = [];
  for (const row of data || []) {
    const b = row.bookings;
    // A rejected booking isn't holding a room, so it can't be a real clash.
    if (!b || b.status === 'ต้องแก้ไข') continue;
    const bFrom = new Date(b.checkin_date).getTime();
    const bTo = new Date(b.checkout_date).getTime();
    if (bFrom < to && bTo > from) {
      out.push(`${row.name} มีการจองซ้อนวันอยู่แล้ว (${b.id}: ${b.checkin_date} – ${b.checkout_date})`);
    }
  }
  return out;
}

async function requestChange(req, res, actor, body) {
  const { booking_id, type, new_rooms, new_checkin, new_checkout, note } = body;
  const allowed = ['ลดจำนวนห้อง', 'ลดจำนวนคืน', 'ขอย้ายที่พัก', 'ยกเลิกการจอง'];
  if (!allowed.includes(type)) return fail(res, 400, 'ประเภทเรื่องแจ้งไม่ถูกต้อง');

  const { data: bk } = await supabase.from('bookings').select('id, status').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');
  // Confirmed rule: employees may only raise a change once a hotel is actually locked in.
  if (bk.status === 'ส่งคำขอ' || bk.status === 'รอเจ้าของอนุมัติ') return fail(res, 400, 'รอเลือกที่พักและอนุมัติก่อน ถึงจะขอเปลี่ยนแปลงได้');

  const { error } = await supabase.from('booking_changes').insert({
    booking_id,
    type,
    new_rooms: new_rooms ?? null,
    new_checkin: new_checkin || null,
    new_checkout: new_checkout || null,
    note: note || null,
    status: 'pending'
  });
  if (error) return fail(res, 500, error.message);
  json(res, 201, { ok: true });
}

async function requestJoin(req, res, actor, body) {
  const { booking_id, guest } = body;
  const { data: bk } = await supabase.from('bookings').select('id, status, checkout_date').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');
  if (!guest || !guest.name || !String(guest.name).trim()) return fail(res, 400, 'ข้อมูลผู้เข้าพักไม่ครบ');
  if (!guest || (guest.gender !== 'M' && guest.gender !== 'F')) return fail(res, 400, 'ข้อมูลผู้เข้าพักไม่ครบ');

  const { error } = await supabase.from('booking_join_requests').insert({
    booking_id,
    requested_by_employee: actor.code,
    guest_name: String(guest.name).trim(),
    guest_gender: guest.gender,
    guest_phone: guest.phone || null,
    guest_employee_code: guest.employee_code || null,
    guest_team_code: guest.team_code || actor.team_code,
    status: 'pending'
  });
  if (error) return fail(res, 500, error.message);
  json(res, 201, { ok: true });
}

// ---------------------------------------------------------------- admin actions

async function handlePatch(req, res, actor, isAdmin, body) {
  const { booking_id, action } = body;
  if (!booking_id) return fail(res, 400, 'ไม่ได้ระบุการจอง');

  const { data: bk } = await supabase.from('bookings').select('id, status, team_code, chosen_hotel_choice_id').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');

  // Two tiers now instead of one: cancel_booking is a hard, irreversible delete
  // (cascades to guests/choices/changes/join-requests/status-log) so it stays
  // owner-only; final_approve is the owner's mandatory sign-off gate itself.
  // Everything else AREA now does hands-on (the work that used to be admin's
  // alone) is scoped to their assigned teams via canAreaApprove, same rule the
  // old area_approve/area_reject already used.
  const adminOnly = ['final_approve', 'cancel_booking'];
  const adminOrArea = ['choose_hotel', 'submit_for_approval', 'confirm_booking', 'reject', 'mark_problem', 'accept_change', 'dismiss_change', 'add_guest_admin', 'accept_join_request', 'dismiss_join_request', 'mark_hotel_unavailable', 'add_hotel_choice'];
  if (adminOnly.includes(action) && !isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');
  if (adminOrArea.includes(action) && !isAdmin && !(await canAreaApprove(actor, bk.team_code))) return fail(res, 403, 'ไม่มีสิทธิ์ทำรายการนี้');

  const stamp = { updated_at: new Date().toISOString() };

  // Replaces start_processing — AREA (or the owner, bypassing AREA) has picked
  // a hotel via choose_hotel below and routes it to the owner's mandatory
  // final approval. Renamed because "start processing" described the old
  // admin-does-the-booking-legwork step; that legwork is choose_hotel now,
  // this action's only job left is "hand this to the owner."
  if (action === 'submit_for_approval') {
    if (!bk.chosen_hotel_choice_id) return fail(res, 400, 'ต้องเลือกที่พักก่อนส่งขออนุมัติ');
    if (bk.status !== 'ส่งคำขอ') return fail(res, 400, 'การจองนี้ผ่านขั้นนี้ไปแล้ว');
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'รอเจ้าของอนุมัติ', hotel_picked_by: actor.code, hotel_picked_at: new Date().toISOString(), ...stamp })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    await logStatus(booking_id, bk.status, 'รอเจ้าของอนุมัติ', actor.code);
    return await respondFresh(res, booking_id);
  }

  // The owner's mandatory sign-off — every booking AREA finishes must pass
  // through here, no exceptions. Also callable straight from ส่งคำขอ (skipping
  // AREA entirely) so the owner can still pick a hotel herself and approve in
  // one motion, exactly like before this rework.
  if (action === 'final_approve') {
    if (!bk.chosen_hotel_choice_id) return fail(res, 400, 'ยังไม่ได้เลือกที่พัก');
    if (bk.status !== 'รอเจ้าของอนุมัติ' && bk.status !== 'ส่งคำขอ') return fail(res, 400, 'การจองนี้ไม่ได้อยู่ในขั้นรออนุมัติ');
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'รอเลขยืนยันโรงแรม', final_approved_by: actor.code, final_approved_at: new Date().toISOString(), ...stamp })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    await logStatus(booking_id, bk.status, 'รอเลขยืนยันโรงแรม', actor.code);
    return await respondFresh(res, booking_id);
  }

  if (action === 'choose_hotel') {
    const { choice_id } = body;
    if (!choice_id) return fail(res, 400, 'ไม่ได้เลือกที่พัก');
    const { error } = await supabase.from('bookings').update({ chosen_hotel_choice_id: choice_id, ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  // Admin exception flow (map screen): a submitted hotel choice turned out to be full.
  // Kept in the row (not deleted) so its pin still shows grey on the map for history;
  // if it was the currently chosen one, that pick is cleared rather than left dangling.
  if (action === 'mark_hotel_unavailable') {
    const { choice_id } = body;
    if (!choice_id) return fail(res, 400, 'ไม่ได้ระบุที่พัก');
    const { error } = await supabase
      .from('booking_hotel_choices')
      .update({ unavailable_at: new Date().toISOString() })
      .eq('id', choice_id).eq('booking_id', booking_id);
    if (error) return fail(res, 500, error.message);
    const { data: bkNow } = await supabase.from('bookings').select('chosen_hotel_choice_id').eq('id', booking_id).maybeSingle();
    if (bkNow && bkNow.chosen_hotel_choice_id === choice_id) {
      await supabase.from('bookings').update({ chosen_hotel_choice_id: null, ...stamp }).eq('id', booking_id);
    }
    return await respondFresh(res, booking_id);
  }

  // Admin picks one of the map's suggested alternatives to replace an unavailable
  // choice — adds it as a new choice row and makes it the chosen one immediately,
  // since the admin already decided on the map, not just shortlisted it.
  if (action === 'add_hotel_choice') {
    const { hotel_id } = body;
    if (!hotel_id) return fail(res, 400, 'ไม่ได้ระบุที่พัก');
    const { data: existing } = await supabase
      .from('booking_hotel_choices').select('rank').eq('booking_id', booking_id)
      .order('rank', { ascending: false }).limit(1);
    const nextRank = (existing && existing[0] && existing[0].rank ? existing[0].rank : 0) + 1;
    const { data: inserted, error } = await supabase
      .from('booking_hotel_choices').insert({ booking_id, hotel_id, rank: nextRank })
      .select('id').single();
    if (error) return fail(res, 500, error.message);
    await supabase.from('bookings').update({ chosen_hotel_choice_id: inserted.id, ...stamp }).eq('id', booking_id);
    return await respondFresh(res, booking_id);
  }

  // Replaces attach_voucher — the voucher itself is emailed to the employee
  // from outside this system now, so the only thing this system still needs
  // is the hotel's real confirmation number. No status guard on purpose: AREA
  // enters it once the hotel actually confirms, and the owner can come back
  // and correct a typo afterward even once status is already จองสำเร็จ.
  if (action === 'confirm_booking') {
    const { confirmation_no } = body;
    if (!confirmation_no || !String(confirmation_no).trim()) return fail(res, 400, 'ต้องกรอกเลขยืนยันจากโรงแรมก่อน');
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'จองสำเร็จ', confirmation_no: String(confirmation_no).trim(), ...stamp })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    if (bk.status !== 'จองสำเร็จ') await logStatus(booking_id, bk.status, 'จองสำเร็จ', actor.code);
    return await respondFresh(res, booking_id);
  }

  if (action === 'reject') {
    const { reason } = body;
    if (!reason || !String(reason).trim()) return fail(res, 400, 'ต้องกรอกเหตุผลที่ส่งกลับให้แก้ไข');
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'ต้องแก้ไข', reject_reason: String(reason).trim(), ...stamp })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    await logStatus(booking_id, bk.status, 'ต้องแก้ไข', actor.code);
    return await respondFresh(res, booking_id);
  }

  // Lets whoever is actually reviewing (admin or the covering AREA approver)
  // patch in a better map link for a custom hotel entry, right from the
  // detail screen — same review-time need as the AREA-approval home-distance
  // display, just for the hotel side. No new lat/lng columns: distance is
  // derived client-side from whatever coordinates the link itself encodes.
  if (action === 'update_hotel_link') {
    const { choice_id, custom_map_link } = body;
    if (!isAdmin && !(await canAreaApprove(actor, bk.team_code))) return fail(res, 403, 'ไม่มีสิทธิ์แก้ไขที่พักของการจองนี้');
    if (!choice_id) return fail(res, 400, 'ไม่ได้ระบุที่พัก');
    if (!custom_map_link || !String(custom_map_link).trim()) return fail(res, 400, 'ไม่ได้วางลิงก์');
    const { error } = await supabase.from('booking_hotel_choices').update({ custom_map_link: String(custom_map_link).trim() }).eq('id', choice_id).eq('booking_id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'mark_problem') {
    const { error } = await supabase.from('bookings').update({ status: 'ติดปัญหา', ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    await logStatus(booking_id, bk.status, 'ติดปัญหา', actor.code);
    return await respondFresh(res, booking_id);
  }

  if (action === 'accept_change' || action === 'dismiss_change') {
    const { change_id } = body;
    if (!change_id) return fail(res, 400, 'ไม่ได้ระบุเรื่องแจ้ง');
    const { data: ch } = await supabase.from('booking_changes').select('*').eq('id', change_id).maybeSingle();
    if (!ch) return fail(res, 404, 'ไม่พบเรื่องแจ้งนี้');

    if (action === 'accept_change') {
      if (ch.type === 'ลดจำนวนคืน' && ch.new_checkin && ch.new_checkout) {
        const { error } = await supabase
          .from('bookings')
          .update({ checkin_date: ch.new_checkin, checkout_date: ch.new_checkout, ...stamp })
          .eq('id', booking_id);
        if (error) return fail(res, 500, error.message);
      }
      await supabase.from('booking_changes').update({ status: 'accepted' }).eq('id', change_id);
    } else {
      await supabase.from('booking_changes').update({ status: 'dismissed' }).eq('id', change_id);
    }
    return await respondFresh(res, booking_id);
  }

  if (action === 'add_guest_admin') {
    const { guest, force } = body;
    if (!guest || !guest.name || !String(guest.name).trim()) return fail(res, 400, 'ข้อมูลผู้เข้าพักไม่ครบ');
    if (!guest || (guest.gender !== 'M' && guest.gender !== 'F')) return fail(res, 400, 'ข้อมูลผู้เข้าพักไม่ครบ');
    const { data: existing } = await supabase.from('booking_guests').select('gender').eq('booking_id', booking_id);
    const { maleEmpty, femaleEmpty } = emptyBedsByGender(existing || []);
    const empty = guest.gender === 'M' ? maleEmpty : femaleEmpty;
    if (empty <= 0 && !force) return fail(res, 400, `ไม่มีเตียงว่างสำหรับเพศ${guest.gender === 'M' ? 'ชาย' : 'หญิง'}ในห้องนี้แล้ว`);
    const newGuestRow = {
      booking_id,
      team_code: guest.team_code || null,
      employee_code: guest.employee_code || null,
      name: String(guest.name).trim(),
      phone: guest.phone || null,
      gender: guest.gender
    };
    await ensureEmployeesExist([newGuestRow]);
    const { error } = await supabase.from('booking_guests').insert(newGuestRow);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'accept_join_request' || action === 'dismiss_join_request') {
    const { join_request_id, force } = body;
    if (!join_request_id) return fail(res, 400, 'ไม่ได้ระบุคำขอเข้าร่วม');
    const { data: jr } = await supabase.from('booking_join_requests').select('*').eq('id', join_request_id).maybeSingle();
    if (!jr) return fail(res, 404, 'ไม่พบคำขอนี้');

    if (action === 'dismiss_join_request') {
      await supabase.from('booking_join_requests').update({ status: 'dismissed', decided_by_employee: actor.code, decided_at: new Date().toISOString() }).eq('id', join_request_id);
      return await respondFresh(res, booking_id);
    }

    // Re-check bed availability at approval time — it may have filled since the request was filed.
    const { data: existing } = await supabase.from('booking_guests').select('gender').eq('booking_id', booking_id);
    const { maleEmpty, femaleEmpty } = emptyBedsByGender(existing || []);
    const empty = jr.guest_gender === 'M' ? maleEmpty : femaleEmpty;
    if (empty <= 0 && !force) return fail(res, 400, `ไม่มีเตียงว่างสำหรับเพศ${jr.guest_gender === 'M' ? 'ชาย' : 'หญิง'}ในห้องนี้แล้ว`);

    const joinGuestRow = {
      booking_id,
      team_code: jr.guest_team_code,
      employee_code: jr.guest_employee_code,
      name: jr.guest_name,
      phone: jr.guest_phone,
      gender: jr.guest_gender
    };
    await ensureEmployeesExist([joinGuestRow]);
    await supabase.from('booking_guests').insert(joinGuestRow);
    await supabase.from('booking_join_requests').update({ status: 'accepted', decided_by_employee: actor.code, decided_at: new Date().toISOString() }).eq('id', join_request_id);
    return await respondFresh(res, booking_id);
  }

  if (action === 'cancel_booking') {
    const { error } = await supabase.from('bookings').delete().eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return json(res, 200, { deleted: true });
  }

  if (action === 'edit') {
    // Employee resubmitting after a reject: replace guests + hotel choices wholesale.
    const { checkin_date, checkout_date, note, guests, hotel_choices, branch_code, work_schedule_id, mission_type, mission_type_note } = body;
    if (!checkin_date || !checkout_date) return fail(res, 400, 'ยังไม่ได้เลือกวันเข้าพัก–วันออก');
    if (new Date(checkout_date) <= new Date(checkin_date)) return fail(res, 400, 'วันออกต้องหลังวันเข้าพัก');
    if (!Array.isArray(guests) || guests.length === 0) return fail(res, 400, 'ยังไม่ได้กรอกผู้เข้าพัก');
    if (!Array.isArray(hotel_choices) || hotel_choices.length === 0) return fail(res, 400, 'ยังไม่ได้เลือกที่พัก');

    const { data: currentBk } = await supabase.from('bookings').select('work_schedule_id').eq('id', booking_id).maybeSingle();
    const isAdhoc = work_schedule_id !== undefined ? !work_schedule_id : !(currentBk && currentBk.work_schedule_id);
    if (isAdhoc) {
      if (!MISSION_TYPES.includes(mission_type)) return fail(res, 400, 'ต้องระบุประเภทภารกิจสำหรับการจองแบบเฉพาะกิจ');
      if (mission_type === 'อื่นๆ' && !String(mission_type_note || '').trim()) return fail(res, 400, 'กรุณาระบุรายละเอียดภารกิจ');
    }

    const { error: upErr } = await supabase
      .from('bookings')
      .update({
        checkin_date,
        checkout_date,
        note: note || null,
        branch_code: branch_code || undefined,
        status: 'ส่งคำขอ',
        reject_reason: null,
        chosen_hotel_choice_id: null,
        mission_type: isAdhoc ? mission_type : null,
        mission_type_note: isAdhoc && mission_type === 'อื่นๆ' ? (mission_type_note || null) : null,
        ...stamp
      })
      .eq('id', booking_id);
    if (upErr) return fail(res, 500, upErr.message);
    await logStatus(booking_id, bk.status, 'ส่งคำขอ', actor.code);

    await supabase.from('booking_guests').delete().eq('booking_id', booking_id);
    await supabase.from('booking_hotel_choices').delete().eq('booking_id', booking_id);

    const editGuestRows = guests.map((g) => ({
      booking_id,
      team_code: g.team_code || actor.team_code,
      employee_code: g.employee_code || null,
      name: String(g.name).trim(),
      phone: g.phone || null,
      gender: g.gender
    }));
    await ensureEmployeesExist(editGuestRows);
    await supabase.from('booking_guests').insert(editGuestRows);
    await supabase.from('booking_hotel_choices').insert(
      hotel_choices.map((c, i) => ({
        booking_id,
        hotel_id: c.hotel_id || null,
        custom_name: c.custom_name || null,
        custom_map_link: c.custom_map_link || null,
        custom_price: c.custom_price ?? null,
        rank: i + 1
      }))
    );
    return await respondFresh(res, booking_id);
  }

  return fail(res, 400, `ไม่รู้จัก action: ${action}`);
}

async function respondFresh(res, id) {
  const { data } = await supabase.from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle();
  json(res, 200, { booking: data ? decorate(data) : null });
}

// dashboard-summary.js reuses these so live-period cost figures are computed with the
// exact same query shape + formula as everywhere else in the app, instead of a second
// copy drifting.
module.exports.decorate = decorate;
module.exports.BOOKING_SELECT = BOOKING_SELECT;
