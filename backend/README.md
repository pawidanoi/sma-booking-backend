# Backend + LINE bot (มะม่วง) — SMA Booking

โค้ดชุดนี้รันบน [Vercel](https://vercel.com) (ฟรี) + [Supabase](https://supabase.com) (ฟรี) ตามแผนที่คุยกันไว้

## มีอะไรในนี้

- `api/line-webhook.js` — จุดรับ event จาก LINE (follow, postback, message) คุยผ่าน Quick Reply เท่านั้น ไม่มีการอ่าน/ตีความข้อความอิสระ
- `api/schedule-sync.js` — จุดรับข้อมูลแผนงานจาก Google Apps Script (full-replace-by-range ตามที่ตกลงไว้)
- `api/cron-notify.js` — cron รายวัน (ตั้งไว้ 09:00 น. ไทย ใน `vercel.json`) เตือน 5 วัน + ซ้ำ 3 วันก่อนถึงกำหนด
- `lib/supabase.js`, `lib/line.js` — helper ที่ใช้ร่วมกัน

## ต้องทำก่อนใช้งานได้จริง (ฝั่งคุณ)

1. สมัคร [supabase.com](https://supabase.com) (ฟรี, ล็อกอินด้วย GitHub ได้) → New Project → SQL Editor → รัน `schema.sql` ที่อยู่โฟลเดอร์แม่
2. เปิด LINE Official Account ฟรีที่ [entry.line.biz](https://entry.line.biz)
3. เข้า [LINE Developers Console](https://developers.line.biz) → ผูก OA เข้ากับ Provider → สร้าง Messaging API channel → เปิด LIFF app ชี้ไปที่เว็บแอป (จะ deploy คู่กับ backend นี้)
4. สมัคร [vercel.com](https://vercel.com) ด้วย GitHub ที่มีอยู่แล้ว → New Project → import repo นี้
5. ใน Vercel > Settings > Environment Variables ใส่ค่าตาม `.env.example` ให้ครบ
6. ใน LINE Developers Console ตั้ง Webhook URL = `https://<โปรเจกต์ของคุณ>.vercel.app/api/line-webhook`

## ส่งอะไรกลับมาให้ผม

ให้ผมมาต่อโค้ดส่วน LIFF app จริง (แปลง prototype ให้ยิง Supabase) และ seed ข้อมูลได้เลยเมื่อมี:
- Supabase connection string (URL + service role key)
- LINE Channel Secret + Access Token
- LIFF URL

## จุดที่ต้องระวังตอน seed ข้อมูล

`teams` ในทะเบียนจริงมีแค่ SMA1–SMA16 (ไม่มีแถว AREA/HQ) แต่ `employees.team_code` มี FK ไปที่ `teams(code)` และมีพนักงานทีม `Area`/`HQ` อยู่จริง (ผู้บริหาร/แอดมิน/หัวหน้าแผนกกิจกรรม) — ตอน seed ต้องเพิ่มแถว `teams` สำหรับ `AREA` และ `HQ` ด้วย ไม่งั้น insert พนักงานกลุ่มนี้จะชน FK constraint

## หมายเหตุสถาปัตยกรรม

- `line-webhook.js` ปิด body parser อัตโนมัติของ Vercel ไว้ (`config.api.bodyParser = false`) เพราะต้องอ่าน raw body ไปตรวจลายเซ็นของ LINE ก่อน — ถ้าย้ายไป framework อื่นต้องคง behavior นี้ไว้
- `SUPABASE_SERVICE_ROLE_KEY` ใช้ฝั่ง backend เท่านั้น ห้ามเอาไปฝังในโค้ดฝั่งเว็บ/LIFF (ฝั่งนั้นให้ใช้ anon key + Row Level Security แทน)
