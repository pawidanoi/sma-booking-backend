// Full conversational booking flow, entirely inside LINE chat — no LIFF web form
// needed. Every step is a button/native-picker tap; the only free-text exceptions
// are a guest's name when they're not in the team roster, and the "อื่นๆ" mission
// note — the exact same two exceptions the LIFF web form itself allows. Dates are
// always LINE's native datetimepicker action, never typed, preserving the
// confirmed "no free-typed dates" rule that the whole system exists to enforce.
//
// State is kept in `line_conversation_state` (one row per LINE user) since the
// webhook itself is stateless between messages. The final submission calls the
// SAME public /api/bookings endpoint the web app uses, so every business rule
// (guest conflicts, room math, mission-type validation) runs identically either way.

const { supabase } = require('./supabase');
const { reply, qrPostback, qrUri } = require('./line');

const MISSION_TYPES = ['งานแฟร์', 'งานเปิดสาขา', 'สำรวจพื้นที่', 'อื่นๆ'];
const ROSTER_PAGE_SIZE = 10;
const HOTEL_PAGE_SIZE = 8;
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://sma-booking-backend.vercel.app';

async function getState(lineUserId) {
  const { data } = await supabase.from('line_conversation_state').select('*').eq('line_user_id', lineUserId).maybeSingle();
  return data;
}
async function setState(lineUserId, employeeCode, step, data) {
  await supabase.from('line_conversation_state').upsert({
    line_user_id: lineUserId, employee_code: employeeCode, step, data, updated_at: new Date().toISOString()
  });
}
async function clearState(lineUserId) {
  await supabase.from('line_conversation_state').delete().eq('line_user_id', lineUserId);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cancelChip() { return qrPostback('« ยกเลิกทั้งหมด', 'flow=cancel'); }

// ---------------------------------------------------------------- entry point

async function startBookingFlow(event, employee) {
  const { data: schedule } = await supabase
    .from('work_schedule')
    .select('id, branch_code, date_start, date_end, branches(name, province, lat, lng)')
    .eq('team_code', employee.team_code);
  const { data: existingBookings } = await supabase.from('bookings').select('work_schedule_id').not('work_schedule_id', 'is', null);
  const booked = new Set((existingBookings || []).map((b) => b.work_schedule_id));
  const openJobs = (schedule || []).filter((s) => !booked.has(s.id));

  const items = openJobs.slice(0, 10).map((j) =>
    qrPostback(`📋 ${(j.branches && j.branches.name) || j.branch_code}`, `flow=pick_job&job=${j.id}`)
  );
  items.push(qrPostback('✏️ จองแบบอื่น (นอกแผนงาน)', 'flow=pick_job&job=adhoc'));
  items.push(cancelChip());

  await setState(event.source.userId, employee.code, 'select_job', { jobsCache: openJobs });
  await reply(event.replyToken, [{
    type: 'text',
    text: openJobs.length ? 'จะจองงานไหนดีคะ เลือกจากรายการนี้เลย~ 🥭' : 'ตอนนี้ทีมไม่มีงานในแผนเลยนะ ถ้าจะจองแบบอื่นก็เลือกได้เลยค่ะ',
    quickReply: { items }
  }]);
}

// ---------------------------------------------------------------- dispatch

async function handleFlowPostback(event, employee, params) {
  const step = params.get('flow');
  const state = await getState(event.source.userId);

  if (step === 'cancel') {
    await clearState(event.source.userId);
    await reply(event.replyToken, [{ type: 'text', text: 'ยกเลิกแล้วค่ะ ไม่เป็นไรนะ เริ่มใหม่เมื่อไหร่ก็บอกได้เลย 🥭' }]);
    return true;
  }

  if (!state) return false; // not mid-flow — let the caller fall through to the main menu

  const handlers = {
    pick_job: () => onPickJob(event, employee, state, params),
    pick_mission: () => onPickMission(event, employee, state, params),
    pick_checkin: () => onPickCheckin(event, employee, state, params),
    pick_checkout: () => onPickCheckout(event, employee, state, params),
    guest_gender: () => onGuestGender(event, employee, state, params),
    guest_page: () => onGuestPage(event, employee, state, params),
    guest_pick: () => onGuestPick(event, employee, state, params),
    guest_manual: () => onGuestManualPrompt(event, employee, state, params),
    hotel_page: () => onHotelPage(event, employee, state, params),
    hotel_pick: () => onHotelPick(event, employee, state, params),
    hotel_done: () => goToReview(event, employee, state),
    confirm: () => onConfirm(event, employee, state)
  };
  const fn = handlers[step];
  if (!fn) return false;
  await fn();
  return true;
}

// Called from onMessage() when free text arrives while a state exists — only
// two steps ever expect typed text; everything else still redirects to the menu.
async function handleFlowMessage(event, employee) {
  const state = await getState(event.source.userId);
  if (!state) return false;
  if (state.step === 'guest_manual_name') {
    await onGuestManualName(event, employee, state);
    return true;
  }
  if (state.step === 'mission_note') {
    await onMissionNote(event, employee, state);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- steps

async function onPickJob(event, employee, state, params) {
  const jobId = params.get('job');
  let job;
  if (jobId === 'adhoc') {
    job = { adhoc: true };
  } else {
    const found = (state.data.jobsCache || []).find((j) => String(j.id) === jobId);
    if (!found) { await reply(event.replyToken, [{ type: 'text', text: 'เอ๊ะ หางานนี้ไม่เจอเลย ลองใหม่อีกทีนะคะ 🥭' }]); return; }
    job = { adhoc: false, id: found.id, branch_code: found.branch_code, checkin_date: found.date_start, checkout_date: found.date_end };
  }

  if (job.adhoc) {
    const items = MISSION_TYPES.map((t) => qrPostback(t, `flow=pick_mission&t=${encodeURIComponent(t)}`));
    items.push(cancelChip());
    await setState(event.source.userId, employee.code, 'pick_mission', { ...state.data, job });
    await reply(event.replyToken, [{ type: 'text', text: 'จองแบบนอกแผนงานนะคะ ก่อนอื่นบอกมะม่วงหน่อยว่าเป็นภารกิจอะไรคะ', quickReply: { items } }]);
    return;
  }

  // Scheduled job already has dates from the plan — still let them confirm/adjust
  // via the same native date-picker, defaulting to the plan's dates.
  await setState(event.source.userId, employee.code, 'pick_checkin', { ...state.data, job });
  await promptCheckin(event, job.checkin_date);
}

async function onPickMission(event, employee, state) {
  const params = new URLSearchParams(event.postback.data);
  const t = decodeURIComponent(params.get('t') || '');
  if (!MISSION_TYPES.includes(t)) return;
  const data = { ...state.data, mission_type: t };

  if (t === 'อื่นๆ') {
    await setState(event.source.userId, employee.code, 'mission_note', data);
    await reply(event.replyToken, [{ type: 'text', text: 'พิมพ์สั้นๆ บอกมะม่วงหน่อยว่าเป็นภารกิจอะไรคะ (ข้อความนี้พิมพ์ได้ปกติ ไม่เหมือนช่องอื่นนะ)' }]);
    return;
  }
  await setState(event.source.userId, employee.code, 'pick_checkin', data);
  await promptCheckin(event, null);
}

async function onMissionNote(event, employee, state) {
  const note = String(event.message.text || '').trim();
  if (!note) { await reply(event.replyToken, [{ type: 'text', text: 'พิมพ์อะไรมาสักหน่อยนะคะ 🥭' }]); return; }
  const data = { ...state.data, mission_type_note: note };
  await setState(event.source.userId, employee.code, 'pick_checkin', data);
  await promptCheckin(event, null);
}

async function promptCheckin(event, defaultDate) {
  await reply(event.replyToken, [{
    type: 'template',
    altText: 'เลือกวันเข้าพัก',
    template: {
      type: 'buttons',
      text: 'เลือกวันเข้าพักเลยค่ะ (กดปุ่มเลือกวันที่ ห้ามพิมพ์เองนะ)',
      actions: [{ type: 'datetimepicker', label: '📅 เลือกวันเข้าพัก', data: 'flow=pick_checkin', mode: 'date', initial: defaultDate || undefined }]
    }
  }]);
}

async function onPickCheckin(event, employee, state) {
  const date = event.postback.params && event.postback.params.date;
  if (!date) { await reply(event.replyToken, [{ type: 'text', text: 'เลือกวันที่ก่อนนะคะ 🥭' }]); return; }
  const data = { ...state.data, checkin_date: date };
  await setState(event.source.userId, employee.code, 'pick_checkout', data);
  await reply(event.replyToken, [{
    type: 'template',
    altText: 'เลือกวันออก',
    template: {
      type: 'buttons',
      text: `เข้าพัก ${date} ค่ะ ทีนี้เลือกวันออกด้วยนะ`,
      actions: [{ type: 'datetimepicker', label: '📅 เลือกวันออก', data: 'flow=pick_checkout', mode: 'date', initial: date }]
    }
  }]);
}

async function onPickCheckout(event, employee, state) {
  const date = event.postback.params && event.postback.params.date;
  if (!date) { await reply(event.replyToken, [{ type: 'text', text: 'เลือกวันที่ก่อนนะคะ 🥭' }]); return; }
  if (new Date(date) <= new Date(state.data.checkin_date)) {
    await reply(event.replyToken, [{ type: 'text', text: 'วันออกต้องหลังวันเข้าพักนะคะ เลือกใหม่อีกทีจ้า' }]);
    return;
  }
  const data = { ...state.data, checkout_date: date, guests: [] };
  await setState(event.source.userId, employee.code, 'guest_gender', data);
  await promptGuestGender(event, data);
}

async function promptGuestGender(event, data) {
  const n = (data.guests || []).length;
  const items = [
    qrPostback('👩 เพิ่มผู้เข้าพักหญิง', 'flow=guest_gender&g=F'),
    qrPostback('👨 เพิ่มผู้เข้าพักชาย', 'flow=guest_gender&g=M')
  ];
  if (n > 0) items.push(qrPostback('✅ เพิ่มครบแล้ว ไปต่อ', 'flow=guest_gender&g=done'));
  items.push(cancelChip());
  await reply(event.replyToken, [{
    type: 'text',
    text: n > 0 ? `ตอนนี้มี ${n} คนแล้วนะ เพิ่มอีกไหมคะ` : 'ใครไปพักบ้างคะ เริ่มเพิ่มทีละคนเลย~',
    quickReply: { items }
  }]);
}

async function onGuestGender(event, employee, state, params) {
  const g = params.get('g');
  if (g === 'done') {
    if (!(state.data.guests || []).length) { await reply(event.replyToken, [{ type: 'text', text: 'ต้องมีผู้เข้าพักอย่างน้อย 1 คนก่อนนะคะ 🥭' }]); return; }
    await setState(event.source.userId, employee.code, 'hotel_page', { ...state.data, hotelPicks: [] });
    await showHotelPage(event, employee, { ...state.data, hotelPicks: [] }, 0);
    return;
  }
  await setState(event.source.userId, employee.code, 'guest_page', { ...state.data, pendingGender: g });
  await showGuestPage(event, employee, { ...state.data, pendingGender: g }, 0);
}

async function showGuestPage(event, employee, data, page) {
  const { data: roster } = await supabase.from('employees').select('code, name, nickname').eq('team_code', employee.team_code).eq('active', true);
  const all = roster || [];
  const start = page * ROSTER_PAGE_SIZE;
  const pageItems = all.slice(start, start + ROSTER_PAGE_SIZE);
  const items = pageItems.map((p) => qrPostback(`${p.nickname || p.name}`, `flow=guest_pick&code=${p.code}&g=${data.pendingGender}`));
  if (start + ROSTER_PAGE_SIZE < all.length) items.push(qrPostback('» หน้าถัดไป', `flow=guest_page&page=${page + 1}&g=${data.pendingGender}`));
  items.push(qrPostback('✏️ ไม่มีในทะเบียน (พิมพ์ชื่อเอง)', `flow=guest_manual&g=${data.pendingGender}`));
  items.push(cancelChip());
  await reply(event.replyToken, [{ type: 'text', text: `เลือกคน${data.pendingGender === 'F' ? 'หญิง' : 'ชาย'}จากทีมเลยค่ะ`, quickReply: { items } }]);
}

async function onGuestPage(event, employee, state, params) {
  const page = parseInt(params.get('page') || '0', 10);
  const g = params.get('g');
  await showGuestPage(event, employee, { ...state.data, pendingGender: g }, page);
}

async function onGuestPick(event, employee, state, params) {
  const code = params.get('code');
  const g = params.get('g');
  const { data: person } = await supabase.from('employees').select('code, name, nickname, phone').eq('code', code).maybeSingle();
  if (!person) { await reply(event.replyToken, [{ type: 'text', text: 'หาคนนี้ไม่เจอเลย ลองใหม่นะคะ' }]); return; }
  const guest = { employee_code: person.code, name: person.name, phone: person.phone || null, gender: g, team_code: employee.team_code };
  const guests = [...(state.data.guests || []), guest];
  const data = { ...state.data, guests, pendingGender: undefined };
  await setState(event.source.userId, employee.code, 'guest_gender', data);
  await reply(event.replyToken, [{ type: 'text', text: `เพิ่ม ${person.nickname || person.name} แล้วค่ะ ✓` }]);
  await promptGuestGender(event, data);
}

async function onGuestManualPrompt(event, employee, state, params) {
  const g = params.get('g');
  await setState(event.source.userId, employee.code, 'guest_manual_name', { ...state.data, pendingGender: g });
  await reply(event.replyToken, [{ type: 'text', text: 'พิมพ์ชื่อ-นามสกุลของคนนี้มาได้เลยค่ะ (ช่องนี้พิมพ์ได้ปกติ)' }]);
}

async function onGuestManualName(event, employee, state) {
  const name = String(event.message.text || '').trim();
  if (!name) { await reply(event.replyToken, [{ type: 'text', text: 'พิมพ์ชื่อมาหน่อยนะคะ 🥭' }]); return; }
  const guest = { employee_code: null, name, phone: null, gender: state.data.pendingGender, team_code: employee.team_code };
  const guests = [...(state.data.guests || []), guest];
  const data = { ...state.data, guests, pendingGender: undefined };
  await setState(event.source.userId, employee.code, 'guest_gender', data);
  await reply(event.replyToken, [{ type: 'text', text: `เพิ่ม ${name} แล้วค่ะ ✓` }]);
  await promptGuestGender(event, data);
}

// Hotels: registry-only via this chat flow (a custom/off-registry hotel still
// needs the web form's map-link + price fields — scoped out here on purpose to
// keep the chat flow from becoming its own multi-field form-within-a-form).
async function showHotelPage(event, employee, data, page) {
  const job = data.job;
  let branch = null;
  if (!job.adhoc) {
    const { data: b } = await supabase.from('branches').select('code, name, province, lat, lng').eq('code', job.branch_code).maybeSingle();
    branch = b;
  }
  if (!branch) {
    await reply(event.replyToken, [{ type: 'text', text: 'จองแบบนี้ต้องเลือกสาขา/จังหวัดก่อน ซึ่งช่องแชทยังทำไม่ได้ — ใช้หน้าเว็บ (จองเพิ่ม) สำหรับเคสนี้ก่อนนะคะ 🙏' }]);
    await clearState(event.source.userId);
    return;
  }
  const { data: hotels } = await supabase.from('hotels').select('id, name, province, lat, lng, default_price_per_night').eq('active', true).eq('province', branch.province);
  let list = (hotels || []).map((h) => ({ ...h, _km: haversineKm(branch.lat, branch.lng, h.lat, h.lng) }));
  list.sort((a, b) => (a._km == null ? 9999 : a._km) - (b._km == null ? 9999 : b._km));

  const start = page * HOTEL_PAGE_SIZE;
  const pageItems = list.slice(start, start + HOTEL_PAGE_SIZE);
  const picks = data.hotelPicks || [];
  const items = pageItems
    .filter((h) => !picks.some((p) => p.hotel_id === h.id))
    .map((h) => qrPostback(`${h.name.slice(0, 16)} ${h.default_price_per_night ? '(' + h.default_price_per_night + '฿)' : ''}`, `flow=hotel_pick&id=${h.id}`));
  if (start + HOTEL_PAGE_SIZE < list.length) items.push(qrPostback('» หน้าถัดไป', `flow=hotel_page&page=${page + 1}`));
  if (picks.length > 0) items.push(qrPostback('✅ เลือกครบแล้ว ไปต่อ', 'flow=hotel_done'));
  items.push(cancelChip());

  await setState(event.source.userId, employee.code, 'hotel_page', data);
  await reply(event.replyToken, [{
    type: 'text',
    text: picks.length ? `เลือกแล้ว ${picks.length}/3 ที่ — เลือกเพิ่มได้อีกไหมคะ` : `เลือกที่พักใน จ.${branch.province} เรียงตามระยะทางจากสาขาเลยค่ะ (สูงสุด 3 ที่)`,
    quickReply: { items }
  }]);
}

async function onHotelPage(event, employee, state, params) {
  const page = parseInt(params.get('page') || '0', 10);
  await showHotelPage(event, employee, state.data, page);
}

async function onHotelPick(event, employee, state, params) {
  const id = params.get('id');
  const picks = [...(state.data.hotelPicks || [])];
  if (picks.length >= 3) { await reply(event.replyToken, [{ type: 'text', text: 'เลือกได้สูงสุด 3 ที่พักนะคะ' }]); return; }
  picks.push({ hotel_id: id });
  const data = { ...state.data, hotelPicks: picks };
  await setState(event.source.userId, employee.code, 'hotel_page', data);
  await reply(event.replyToken, [{ type: 'text', text: 'เพิ่มที่พักนี้แล้วค่ะ ✓' }]);
  await showHotelPage(event, employee, data, 0);
}

async function goToReview(event, employee, state) {
  const d = state.data;
  const females = (d.guests || []).filter((g) => g.gender === 'F').length;
  const males = (d.guests || []).filter((g) => g.gender === 'M').length;
  const rooms = Math.ceil(females / 2) + Math.ceil(males / 2);
  const lines = [
    `สาขา: ${d.job.adhoc ? '(นอกแผนงาน)' : ''}`,
    `เข้าพัก: ${d.checkin_date} – ${d.checkout_date}`,
    `ผู้เข้าพัก: ${(d.guests || []).length} คน (${females} หญิง, ${males} ชาย) · ${rooms} ห้อง`,
    `ที่พักที่เลือก: ${(d.hotelPicks || []).length} ที่`
  ];
  if (d.mission_type) lines.push(`ภารกิจ: ${d.mission_type}${d.mission_type_note ? ' — ' + d.mission_type_note : ''}`);

  await setState(event.source.userId, employee.code, 'confirm', d);
  await reply(event.replyToken, [{
    type: 'text',
    text: `สรุปคำขอจองค่ะ 📋\n${lines.join('\n')}\n\nถูกต้องไหมคะ? กดยืนยันเพื่อส่งคำขอให้แอดมินเลย`,
    quickReply: { items: [qrPostback('✅ ยืนยันส่งคำขอ', 'flow=confirm'), cancelChip()] }
  }]);
}

async function onConfirm(event, employee, state) {
  const d = state.data;
  const payload = {
    actor: employee.code,
    action: 'create',
    branch_code: d.job.adhoc ? null : d.job.branch_code,
    work_schedule_id: d.job.adhoc ? null : d.job.id,
    checkin_date: d.checkin_date,
    checkout_date: d.checkout_date,
    note: '',
    mission_type: d.job.adhoc ? d.mission_type : null,
    mission_type_note: d.job.adhoc && d.mission_type === 'อื่นๆ' ? d.mission_type_note : null,
    guests: d.guests,
    hotel_choices: d.hotelPicks
  };
  // Ad-hoc bookings still need a real branch — the flow scopes ad-hoc to "pick from
  // a job" today, so branch_code can be missing here; guard rather than 500 from the API.
  if (d.job.adhoc && !payload.branch_code) {
    await reply(event.replyToken, [{ type: 'text', text: 'จองนอกแผนงานผ่านแชทยังเลือกสาขาไม่ได้ค่ะ ใช้หน้าเว็บ (จองเพิ่ม) สำหรับเคสนี้ก่อนนะคะ 🙏' }]);
    await clearState(event.source.userId);
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!res.ok) {
      await reply(event.replyToken, [{ type: 'text', text: `ส่งคำขอไม่สำเร็จค่ะ: ${body.error || 'ไม่ทราบสาเหตุ'} 😥` }]);
      return;
    }
    await clearState(event.source.userId);
    const warnText = body.warnings && body.warnings.length ? `\n⚠️ ${body.warnings[0]}` : '';
    await reply(event.replyToken, [{ type: 'text', text: `ส่งคำขอให้แอดมินแล้วค่ะ! ✅ (เลขที่ ${body.booking.id})${warnText}\nรอแอดมินตรวจแล้วมะม่วงจะแจ้งวอเชอร์ให้ทีหลังนะคะ 🥭` }]);
  } catch (err) {
    await reply(event.replyToken, [{ type: 'text', text: 'ส่งคำขอไม่สำเร็จค่ะ ลองใหม่อีกทีนะคะ 🙏' }]);
  }
}

module.exports = { startBookingFlow, handleFlowPostback, handleFlowMessage };
