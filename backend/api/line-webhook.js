const { supabase } = require('../lib/supabase');
const { verifySignature, reply, push, mainMenuQuickReply, mainMenuFlex, qrPostback, qrUri, liffLink } = require('../lib/line');
const { startBookingFlow, handleFlowPostback, handleFlowMessage } = require('../lib/line-booking-flow');

// Raw body is required to verify the LINE signature — must read the stream
// ourselves instead of letting the platform auto-parse JSON.
const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-line-signature'];
  if (!signature || !verifySignature(rawBody, signature)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const body = JSON.parse(rawBody);
  const events = body.events || [];

  await Promise.all(events.map(handleEvent));

  // LINE requires a 200 within a few seconds regardless of what we did above.
  res.status(200).json({ ok: true });
};

async function handleEvent(event) {
  try {
    if (event.type === 'follow') return onFollow(event);
    if (event.type === 'postback') return onPostback(event);
    if (event.type === 'message') return onMessage(event);
  } catch (err) {
    console.error('handleEvent error', err);
    if (event.replyToken) {
      await reply(event.replyToken, [{ type: 'text', text: 'อุ๊ย มะม่วงสะดุดนิดหน่อยค่ะ ลองกดใหม่อีกทีนะคะ 🙏🥭' }]);
    }
  }
}

async function onFollow(event) {
  const userId = event.source.userId;
  const { data: existing } = await supabase
    .from('employees')
    .select('code, name, nickname')
    .eq('line_user_id', userId)
    .maybeSingle();

  if (existing) {
    await reply(event.replyToken, [
      { type: 'text', text: `กลับมาแล้วเหรอคะ คุณ${existing.nickname || existing.name} 🥭 มะม่วงคิดถึงเลย มีอะไรให้ช่วยจองวันนี้ไหมคะ` },
      mainMenuFlex()
    ]);
    return;
  }

  await reply(event.replyToken, [
    {
      type: 'text',
      text: 'สวัสดีค่า~ มะม่วงเองนะคะ 🥭 ผู้ช่วยจองที่พักประจำทีมภาคสนาม ตั้งแต่วันนี้เป็นต้นไปมะม่วงจะคอยเตือนไม่ให้ลืมจองเลยนะ!\nก่อนเริ่มใช้งาน กดผูกบัญชีด้วยรหัสพนักงานครั้งเดียวก่อนน้า จะได้จำคุณได้ทุกครั้ง',
      quickReply: { items: [qrUri('🔗 ผูกบัญชี', liffLink('/link-account'))] }
    }
  ]);
}

async function onPostback(event) {
  const userId = event.source.userId;
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');

  const employee = await findEmployeeByLineId(userId);
  if (!employee && action !== 'menu') {
    await reply(event.replyToken, [
      { type: 'text', text: 'เอ๊ะ ยังไม่รู้จักกันเลยนะคะ กดผูกบัญชีก่อนน้า มะม่วงจะได้จำได้ 🥭', quickReply: { items: [qrUri('🔗 ผูกบัญชี', liffLink('/link-account'))] } }
    ]);
    return;
  }

  // Multi-step booking conversation takes priority over the fixed menu actions
  // below — a "flow=" postback only exists while a conversation is in progress.
  if (params.get('flow')) {
    const handled = await handleFlowPostback(event, employee, params);
    if (handled) return;
  }

  switch (action) {
    case 'menu':
      await reply(event.replyToken, [mainMenuFlex()]);
      return;

    case 'jobs':
      await startBookingFlow(event, employee);
      return;

    case 'status':
      await reply(event.replyToken, [
        { type: 'text', text: 'เช็คสถานะการจองล่าสุดของคุณได้ที่นี่เลยค่ะ', quickReply: { items: [qrUri('📦 เปิดหน้าสถานะ', liffLink('/home'))] } }
      ]);
      return;

    case 'voucher':
      return replyVoucher(event, employee);

    case 'change_menu':
      await reply(event.replyToken, [
        {
          type: 'text',
          text: 'อยากขอเปลี่ยนแปลงเรื่องไหนคะ บอกมาได้เลย',
          quickReply: {
            items: [
              qrUri('🛏️ ขอลดห้อง/ลดคืน/ย้ายที่พัก', liffLink('/home')),
              qrPostback('✖️ ขอยกเลิกการจอง', 'action=cancel_notice'),
              qrPostback('« กลับเมนูหลัก', 'action=menu')
            ]
          }
        }
      ]);
      return;

    case 'cancel_notice':
      await reply(event.replyToken, [
        { type: 'text', text: 'กดยกเลิกได้ในหน้าสถานะการจองเลยค่ะ ระบบจะขอเหตุผลสั้นๆ ก่อนส่งให้แอดมินนะ', quickReply: { items: [qrUri('📦 เปิดหน้าสถานะ', liffLink('/home'))] } }
      ]);
      return;

    case 'faq_menu':
      await reply(event.replyToken, [
        {
          type: 'text',
          text: 'สงสัยเรื่องไหนคะ ถามมาได้เลย มะม่วงรู้ทุกเรื่อง! 😤',
          quickReply: {
            items: [
              qrPostback('ต้องจองเองไหม', 'action=faq_who_books'),
              qrPostback('เลือกที่พักได้กี่ที่', 'action=faq_hotel_count'),
              qrPostback('ห้องแยกชาย-หญิงไหม', 'action=faq_room_rule'),
              qrPostback('« กลับเมนูหลัก', 'action=menu')
            ]
          }
        }
      ]);
      return;

    case 'faq_who_books':
      await replyFaq(event, 'หัวหน้าทีมหรือผู้จองสำรองของทีมเป็นคนกดส่งคำขอค่ะ ไม่ต้องรอแอดมินอนุมัติก่อนนะ ส่งได้เลยเมื่อใกล้ถึงวันงาน — แต่อย่าใกล้เกินไปล่ะ มะม่วงจะบ่น 😤');
      return;
    case 'faq_hotel_count':
      await replyFaq(event, 'เลือกได้สูงสุด 3 ที่พักต่อคำขอค่ะ ระบบจะโชว์ที่พักทั้งจังหวัดเรียงตามระยะทางให้เลือก แอดมินจะเลือกอันที่จองได้จริงอีกที');
      return;
    case 'faq_room_rule':
      await replyFaq(event, 'ห้องแยกชาย-หญิงเด็ดขาดค่ะ ห้องละ 2 คน ระบบจัดห้องให้อัตโนมัติตามจำนวนที่กรอก ไม่ต้องคิดเองเลย');
      return;

    case 'escalate':
      await escalateToAdmin(event, employee);
      return;

    case 'dismiss_reminder':
      await reply(event.replyToken, [
        { type: 'text', text: 'ก็ได้ค่ะ~ แต่มะม่วงจะเตือนอีกนะ อย่าลืมไปนานล่ะ 😤🥭' }
      ]);
      return;

    default:
      await reply(event.replyToken, [mainMenuFlex()]);
  }
}

async function onMessage(event) {
  if (event.message.type !== 'text') return;

  // Two bounded exceptions to the "no free text" rule while a booking conversation
  // is active: a guest's name (when not in the team roster) and the "อื่นๆ" mission
  // note — the same two exceptions the LIFF web form itself allows. Everything else,
  // including every date, still goes through buttons/native pickers only.
  const employee = await findEmployeeByLineId(event.source.userId);
  if (employee) {
    const handled = await handleFlowMessage(event, employee);
    if (handled) return;
  }

  // Enforced boundary: มะม่วงไม่รับพิมพ์อิสระ ไม่พยายามตีความข้อความ ส่งกลับไปที่เมนูเสมอ
  await reply(event.replyToken, [
    { type: 'text', text: 'แหม่~ พิมพ์มามะม่วงอ่านไม่ออกหรอกนะคะ 😅 กดเลือกจากเมนูด้านล่างเลยจ้า จะได้ไม่พลาดข้อมูลด้วย' },
    mainMenuFlex()
  ]);
}

async function findEmployeeByLineId(lineUserId) {
  const { data } = await supabase
    .from('employees')
    .select('code, name, nickname, team_code')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  return data;
}

async function replyVoucher(event, employee) {
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, confirmation_no, voucher_file_url, voucher_storage_path, status, checkin_date, checkout_date')
    .eq('created_by_employee', employee.code)
    .eq('status', 'จองสำเร็จ')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!booking || (!booking.voucher_file_url && !booking.voucher_storage_path)) {
    await reply(event.replyToken, [
      { type: 'text', text: 'ยังไม่มีวอเชอร์เลยค่ะตอนนี้ ถ้าเพิ่งจองอาจต้องรอแอดมินดำเนินการก่อนนะคะ ใจเย็นๆ นะ~ 🥭' }
    ]);
    return;
  }

  // A directly-uploaded voucher lives in a private Storage bucket with no stable
  // public URL — route through the redirect endpoint, which mints a fresh signed
  // URL on each click. A manually-pasted link (voucher_file_url) is already public.
  const voucherUrl = booking.voucher_storage_path
    ? `${process.env.PUBLIC_BASE_URL || 'https://sma-booking-backend.vercel.app'}/api/voucher-redirect?booking_id=${encodeURIComponent(booking.id)}`
    : booking.voucher_file_url;

  await reply(event.replyToken, [
    {
      type: 'text',
      text: `วอเชอร์ล่าสุดมาแล้วค่า! 🎫\nเลขยืนยัน: ${booking.confirmation_no || '-'}\nเข้าพัก: ${booking.checkin_date} – ${booking.checkout_date}\nเก็บไว้ให้ดีนะคะ~`,
      quickReply: { items: [qrUri('📎 เปิดไฟล์วอเชอร์', voucherUrl)] }
    }
  ]);
}

async function replyFaq(event, answer) {
  await reply(event.replyToken, [
    { type: 'text', text: answer, quickReply: { items: [qrPostback('« กลับเมนูหลัก', 'action=menu')] } }
  ]);
}

async function escalateToAdmin(event, employee) {
  await reply(event.replyToken, [
    { type: 'text', text: 'มะม่วงแจ้งแอดมินให้แล้วนะคะ เดี๋ยวจะติดต่อกลับหาคุณโดยตรงเลย รอแป๊บนึงน้า 🙏🥭' }
  ]);

  const { data: admins } = await supabase
    .from('employees')
    .select('line_user_id')
    .eq('team_code', 'HQ')
    .not('line_user_id', 'is', null);

  // Attach the employee's most recent booking so the admin has context on what
  // to follow up on, rather than a bare "someone wants to talk" ping.
  const { data: latestBooking } = await supabase
    .from('bookings')
    .select('id, status, branch_code, branches(name)')
    .eq('created_by_employee', employee.code)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const bookingContext = latestBooking
    ? `\nคำขอล่าสุด: ${latestBooking.id} · ${latestBooking.branches?.name || latestBooking.branch_code} · ${latestBooking.status}`
    : '';
  const notifyText = `🙋 ${employee.nickname || employee.name} (${employee.team_code}) ขอคุยกับแอดมินผ่านมะม่วงค่ะ${bookingContext}`;
  await Promise.all(
    (admins || [])
      .filter((a) => a.line_user_id)
      .map((a) => push(a.line_user_id, [{ type: 'text', text: notifyText }]))
  );
}

module.exports.config = config;
