const crypto = require('crypto');

const LINE_API = 'https://api.line.me/v2/bot/message';
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_URL = process.env.LIFF_URL; // e.g. https://liff.line.me/1234567890-abcdefgh

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function callLine(path, body) {
  const res = await fetch(`${LINE_API}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('LINE API error', res.status, text);
  }
  return res;
}

function reply(replyToken, messages) {
  return callLine('reply', { replyToken, messages });
}

function push(to, messages) {
  return callLine('push', { to, messages });
}

// The main menu — every option is a postback (structured data), never a free-text
// message action. This is the enforced boundary: มะม่วง never has to parse what a
// person typed, only which button they pressed.
function mainMenuQuickReply() {
  return {
    type: 'text',
    text: 'เอาล่ะ มะม่วงช่วยอะไรได้บ้างนะ~ เลือกจากเมนูด้านล่างได้เลยค่ะ 🥭',
    quickReply: {
      items: [
        qrPostback('📋 งานที่ต้องจอง', 'action=jobs'),
        qrPostback('📦 ดูสถานะการจอง', 'action=status'),
        qrPostback('🎫 ดูวอเชอร์อีกครั้ง', 'action=voucher'),
        qrPostback('🔁 ขอเปลี่ยนแปลง', 'action=change_menu'),
        qrUri('📊 ดูแดชบอร์ด', dashboardLink()),
        qrPostback('❓ คำถามที่พบบ่อย', 'action=faq_menu'),
        qrPostback('🙋 คุยกับแอดมิน', 'action=escalate')
      ]
    }
  };
}

// Same 6 options as mainMenuQuickReply(), as a Flex Message card instead of a plain
// text bubble — the "modern style" visual upgrade. Every tap is still a postback,
// so this changes nothing about the no-free-text rule, just how it looks.
const BRAND = { red: '#e0272a', gold: '#ffc72c', ink: '#2b1b12', paper: '#fff8ea' };
function menuButton(label, data, style) {
  return {
    type: 'button',
    action: { type: 'postback', label, data, displayText: label },
    style: style || 'secondary',
    color: style === 'primary' ? BRAND.red : undefined,
    height: 'sm'
  };
}
function menuButtonUri(label, uri, style) {
  return {
    type: 'button',
    action: { type: 'uri', label, uri },
    style: style || 'secondary',
    color: style === 'primary' ? BRAND.red : undefined,
    height: 'sm'
  };
}
// Public dashboard link — plain page, not routed through the LIFF app (it works
// fully logged-out, so it doesn't need the LIFF WebView's employee context).
function dashboardLink() {
  return `${process.env.PUBLIC_BASE_URL || 'https://sma-booking-backend.vercel.app'}/dashboard.html`;
}
function mainMenuFlex() {
  return {
    type: 'flex',
    altText: 'เมนูของมะม่วง 🥭 เลือกได้เลยค่ะ',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: BRAND.red, paddingAll: '14px',
        contents: [
          { type: 'text', text: '🥭 น้องมะม่วง', color: '#ffffff', weight: 'bold', size: 'md' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', backgroundColor: BRAND.paper,
        contents: [
          { type: 'text', text: 'วันนี้ให้มะม่วงช่วยอะไรดีคะ~', color: BRAND.ink, size: 'sm', margin: 'none', wrap: true },
          { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: [
            menuButton('📋 งานที่ต้องจอง', 'action=jobs', 'primary'),
            menuButton('📦 ดูสถานะการจอง', 'action=status'),
            menuButton('🎫 ดูวอเชอร์อีกครั้ง', 'action=voucher'),
            menuButton('🔁 ขอเปลี่ยนแปลง', 'action=change_menu'),
            menuButtonUri('📊 ดูแดชบอร์ด', dashboardLink()),
            menuButton('❓ คำถามที่พบบ่อย', 'action=faq_menu'),
            menuButton('🙋 คุยกับแอดมิน', 'action=escalate')
          ]}
        ]
      }
    }
  };
}

function qrPostback(label, data) {
  return { type: 'action', action: { type: 'postback', label, data, displayText: label } };
}

function qrUri(label, uri) {
  return { type: 'action', action: { type: 'uri', label, uri } };
}

function liffLink(path) {
  return `${LIFF_URL}${path || ''}`;
}

module.exports = { verifySignature, reply, push, mainMenuQuickReply, mainMenuFlex, qrPostback, qrUri, liffLink };
