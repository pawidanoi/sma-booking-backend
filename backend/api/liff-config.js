const { json, fail } = require('../lib/http');

// The /link-account page needs the raw LIFF ID to call liff.init() client-side.
// LIFF_URL (e.g. https://liff.line.me/1234567890-abcdefgh) already contains it —
// no separate secret needed, just parse the last path segment.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const liffUrl = process.env.LIFF_URL || '';
  const liffId = liffUrl.split('/').filter(Boolean).pop();
  if (!liffId) return fail(res, 500, 'LIFF_URL ยังไม่ได้ตั้งค่าใน environment');

  return json(res, 200, { liffId });
};
