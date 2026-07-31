const { json, fail } = require('../lib/http');

// index.html calls this to get the raw LIFF ID for liff.init() when it might be
// opened inside LINE (LIFF_URL, e.g. https://liff.line.me/1234567890-abcdefgh,
// already contains it — no separate secret needed).
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const liffUrl = process.env.LIFF_URL || '';
  const liffId = liffUrl.split('/').filter(Boolean).pop();
  if (!liffId) return fail(res, 500, 'LIFF_URL ยังไม่ได้ตั้งค่าใน environment');

  return json(res, 200, { liffId });
};
