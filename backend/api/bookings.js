const { supabase } = require('../lib/supabase');
const { json, fail, readBody, roomsFor, nightsBetween, emptyBedsByGender } = require('../lib/http');
const { getActor, isAdmin: checkIsAdmin } = require('../lib/auth');

const MISSION_TYPES = ['งานแฟร์', 'งานเปิดสาขา', 'สำรวจพื้นที่', 'อื่นๆ'];
const MAX_PRICE_PER_ROOM_NIGHT = 600;

// booking_status_log — every status transition, from the first insert onward,
// so admin time-saved can eventually be measured against a real "before".
async function logStatus(bookingId, fromStatus, toStatus, changedBy) {
  await supabase.from('booking_status_log').insert({ booking_id: bookingId, from_status: fromStatus, to_status: toStatus, changed_by: changedBy });
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
  created_by_employee, created_at, updated_at,
  branches ( name, province, lat, lng ),
  booking_hotel_choices!booking_hotel_choices_booking_id_fkey ( id, hotel_id, custom_name, custom_map_link, custom_price, rank, hotels ( code, name, province, lat, lng, default_price_per_night, on_choowap ) ),
  booking_guests ( id, team_code, employee_code, name, phone, gender ),
  booking_changes ( id, type, new_rooms, new_checkin, new_checkout, note, status, created_at ),
  booking_join_requests ( id, requested_by_employee, guest_name, guest_gender, guest_phone, guest_employee_code, guest_team_code, status, decided_by_employee, decided_at, created_at )
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
  } else if (scope === 'open_beds') {
    // Anyone can browse rooms with a spare bed to request joining — not admin-gated.
    q = q.in('status', ['ดำเนินการจอง', 'จองสำเร็จ']).gte('checkout_date', today);
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
  const { branch_code, work_schedule_id, checkin_date, checkout_date, note, guests, hotel_choices, mission_type, mission_type_note } = body;

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

  const { data: branchRow } = await supabase.from('branches').select('code').eq('code', branch_code).maybeSingle();
  if (!branchRow) return fail(res, 400, 'ไม่พบรหัสสาขานี้ในทะเบียน');

  // Rule: warn when the same person is already booked on overlapping dates.
  const conflicts = await findGuestConflicts(guests, checkin_date, checkout_date);

  // §8.5 item 2 — auto-approve straight to "ดำเนินการจอง" (skip the manual
  // admin review gate) when every rule passes: no date-overlap conflict, every
  // proposed hotel is already in the registry (not a custom entry awaiting
  // admin confirmation), and none exceeds the per-room-night price ceiling.
  // A booking with a spare bed (e.g. a lone traveller) is NOT treated as a
  // violation — that's an inherent, unavoidable cost until cross-team room
  // sharing (phase 2) exists, not something this admin review would fix.
  const ruleViolations = [];
  if (conflicts.length) ruleViolations.push(...conflicts);
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
  const initialStatus = autoApproved ? 'ดำเนินการจอง' : 'ส่งคำขอ';

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
    rank: i + 1
  }));
  const { error: cErr } = await supabase.from('booking_hotel_choices').insert(choiceRows);
  if (cErr) {
    await supabase.from('bookings').delete().eq('id', id);
    return fail(res, 500, `บันทึกที่พักที่เลือกไม่สำเร็จ: ${cErr.message}`);
  }

  const { data: fresh } = await supabase.from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle();
  json(res, 201, { booking: fresh ? decorate(fresh) : null, warnings: conflicts });
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
  // Confirmed rule: employees may only raise a change once the admin has started booking.
  if (bk.status === 'ส่งคำขอ') return fail(res, 400, 'รอแอดมินเริ่มดำเนินการจองก่อน ถึงจะขอเปลี่ยนแปลงได้');

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

  const { data: bk } = await supabase.from('bookings').select('id, status').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');

  const adminOnly = ['start_processing', 'choose_hotel', 'attach_voucher', 'reject', 'mark_problem', 'accept_change', 'dismiss_change', 'cancel_booking', 'add_guest_admin', 'accept_join_request', 'dismiss_join_request'];
  if (adminOnly.includes(action) && !isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const stamp = { updated_at: new Date().toISOString() };

  if (action === 'start_processing') {
    const { error } = await supabase.from('bookings').update({ status: 'ดำเนินการจอง', ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    await logStatus(booking_id, bk.status, 'ดำเนินการจอง', actor.code);
    return await respondFresh(res, booking_id);
  }

  if (action === 'choose_hotel') {
    const { choice_id } = body;
    if (!choice_id) return fail(res, 400, 'ไม่ได้เลือกที่พัก');
    const { error } = await supabase.from('bookings').update({ chosen_hotel_choice_id: choice_id, ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'attach_voucher') {
    const { confirmation_no, voucher_file_url, voucher_storage_path } = body;
    // Confirmed rule: a booking cannot reach จองสำเร็จ without the Choowap confirmation number.
    if (!confirmation_no || !String(confirmation_no).trim()) return fail(res, 400, 'ต้องกรอกเลขยืนยันจากชูวับก่อน');
    // Either a directly-uploaded file (voucher_storage_path, private Storage bucket) or a
    // manually-pasted external link (voucher_file_url) — the admin's choice, not required together.
    if (!voucher_storage_path && !(voucher_file_url && String(voucher_file_url).trim())) {
      return fail(res, 400, 'แนบไฟล์หรือวางลิงก์วอเชอร์อย่างใดอย่างหนึ่งก่อน');
    }
    const { error } = await supabase
      .from('bookings')
      .update({
        status: 'จองสำเร็จ',
        confirmation_no: String(confirmation_no).trim(),
        voucher_file_url: voucher_file_url || null,
        voucher_storage_path: voucher_storage_path || null,
        ...stamp
      })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    await logStatus(booking_id, bk.status, 'จองสำเร็จ', actor.code);
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
    const { error } = await supabase.from('booking_guests').insert({
      booking_id,
      team_code: guest.team_code || null,
      employee_code: guest.employee_code || null,
      name: String(guest.name).trim(),
      phone: guest.phone || null,
      gender: guest.gender
    });
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

    await supabase.from('booking_guests').insert({
      booking_id,
      team_code: jr.guest_team_code,
      employee_code: jr.guest_employee_code,
      name: jr.guest_name,
      phone: jr.guest_phone,
      gender: jr.guest_gender
    });
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

    await supabase.from('booking_guests').insert(
      guests.map((g) => ({
        booking_id,
        team_code: g.team_code || actor.team_code,
        employee_code: g.employee_code || null,
        name: String(g.name).trim(),
        phone: g.phone || null,
        gender: g.gender
      }))
    );
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
