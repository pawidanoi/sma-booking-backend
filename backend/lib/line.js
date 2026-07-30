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
    text: 'มะม่วงช่วยอะไรได้บ้างคะ เลือกจากเมนูด้านล่างได้เลย 🥭',
    quickReply: {
      items: [
        qrPostback('📋 งานที่ต้องจอง', 'action=jobs'),
        qrPostback('📦 ดูสถานะการจอง', 'action=status'),
        qrPostback('🎫 ดูวอเชอร์อีกครั้ง', 'action=voucher'),
        qrPostback('🔁 ขอเปลี่ยนแปลง', 'action=change_menu'),
        qrPostback('❓ คำถามที่พบบ่อย', 'action=faq_menu'),
        qrPostback('🙋 คุยกับแอดมิน', 'action=escalate')
      ]
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

module.exports = { verifySignature, reply, push, mainMenuQuickReply, qrPostback, qrUri, liffLink };
