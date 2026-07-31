const fs = require('fs');
const path = require('path');
const { fail, json } = require('../lib/http');
const { getActor, isAdmin: checkIsAdmin } = require('../lib/auth');

const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOT_API = 'https://api.line.me/v2/bot';
const BOT_DATA_API = 'https://api-data.line.me/v2/bot';

// One-off admin-triggered setup: creates the Rich Menu (image + 6 tappable regions
// matching the main menu's postback actions), uploads the image bytes read straight
// from this deployment's own /public/richmenu.png, and sets it as the default menu
// for every follower. Safe to re-run — LINE just creates a new menu and re-links it.
//
// GET /api/setup-richmenu?actor=CMT2600940
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const actorCode = (req.query.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!checkIsAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  try {
    const cw = Math.floor(2500 / 3);
    const ch = Math.floor(843 / 2);
    const richMenu = {
      size: { width: 2500, height: 843 },
      selected: true,
      name: 'มะม่วง main menu',
      chatBarText: 'เมนู',
      areas: [
        { bounds: { x: 0, y: 0, width: cw, height: ch }, action: { type: 'postback', data: 'action=jobs' } },
        { bounds: { x: cw, y: 0, width: cw, height: ch }, action: { type: 'postback', data: 'action=status' } },
        { bounds: { x: cw * 2, y: 0, width: 2500 - cw * 2, height: ch }, action: { type: 'postback', data: 'action=voucher' } },
        { bounds: { x: 0, y: ch, width: cw, height: 843 - ch }, action: { type: 'postback', data: 'action=change_menu' } },
        { bounds: { x: cw, y: ch, width: cw, height: 843 - ch }, action: { type: 'postback', data: 'action=faq_menu' } },
        { bounds: { x: cw * 2, y: ch, width: 2500 - cw * 2, height: 843 - ch }, action: { type: 'postback', data: 'action=escalate' } }
      ]
    };

    const createRes = await fetch(`${BOT_API}/richmenu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_TOKEN}` },
      body: JSON.stringify(richMenu)
    });
    const createBody = await createRes.json();
    if (!createRes.ok) return fail(res, 500, 'สร้าง rich menu ไม่สำเร็จ: ' + JSON.stringify(createBody));
    const richMenuId = createBody.richMenuId;

    const imagePath = path.join(process.cwd(), 'public', 'richmenu.png');
    const imageBytes = fs.readFileSync(imagePath);
    const uploadRes = await fetch(`${BOT_DATA_API}/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${CHANNEL_TOKEN}` },
      body: imageBytes
    });
    if (!uploadRes.ok) {
      const t = await uploadRes.text();
      return fail(res, 500, 'อัปโหลดรูป rich menu ไม่สำเร็จ: ' + t);
    }

    const defaultRes = await fetch(`${BOT_API}/user/all/richmenu/${richMenuId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` }
    });
    if (!defaultRes.ok) {
      const t = await defaultRes.text();
      return fail(res, 500, 'ตั้งเป็นเมนูหลักไม่สำเร็จ: ' + t);
    }

    json(res, 200, { ok: true, richMenuId });
  } catch (err) {
    fail(res, 500, err.message || 'เกิดข้อผิดพลาดในระบบ');
  }
};
