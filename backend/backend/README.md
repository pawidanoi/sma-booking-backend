# Backend + เว็บแอป + LINE bot (มะม่วง) — ระบบจองที่พัก SMA

รันบน [Vercel](https://vercel.com) (ฟรี) + [Supabase](https://supabase.com) (ฟรี)

**URL จริงที่ใช้งานอยู่:** https://sma-booking-backend.vercel.app

## มีอะไรในนี้

| ไฟล์ | หน้าที่ |
|---|---|
| `public/index.html` | **เว็บแอปจองที่พัก** (พนักงาน + แอดมิน) — ดึงข้อมูลจาก API ทั้งหมด ไม่มีข้อมูลฝังในไฟล์ |
| `api/bootstrap.js` | เข้าสู่ระบบด้วยรหัสพนักงาน + ส่งข้อมูลอ้างอิงทั้งชุด (สาขา/ที่พัก/ทีม/พนักงาน/แผนงาน) |
| `api/bookings.js` | สร้าง/อ่าน/แก้ไขการจอง · เรื่องแจ้งเปลี่ยนแปลง · การกระทำของแอดมิน |
| `api/line-webhook.js` | รับ event จาก LINE — คุยผ่านปุ่มเท่านั้น ไม่อ่านข้อความอิสระ |
| `api/schedule-sync.js` | รับแผนงานจาก Google Apps Script (full-replace-by-range) |
| `api/cron-notify.js` | cron รายวัน 09:00 น. ไทย — เตือน 5 วัน + ซ้ำ 3 วันก่อนถึงกำหนด |
| `lib/supabase.js` `lib/line.js` `lib/http.js` | helper ที่ใช้ร่วมกัน |

## ตั้งค่าครั้งแรก (ทำครบแล้ว ✅)

1. ✅ Supabase project + รัน `schema.sql`
2. ✅ LINE Official Account "มะม่วงช่วยจองที่พัก"
3. ✅ LIFF app (`2010900630-XH4SC3XA`)
4. ✅ Vercel deploy + Environment Variables (ดู `.env.example`)
5. ✅ LINE Webhook URL = `https://sma-booking-backend.vercel.app/api/line-webhook`

## ที่ต้องทำเพิ่มหลังอัปเดตโค้ดรอบนี้

1. **รัน `seed.sql`** (อยู่โฟลเดอร์แม่) ใน Supabase → SQL Editor
   ใส่ข้อมูลจริง: สาขา 154 · ทีม 18 · พนักงาน 106 · ที่พัก 271 · แผนงาน ส.ค. 32 งาน
   อ่าน `seed-รายงานข้อมูลที่ต้องเติมเอง.md` เพื่อรู้ว่าจุดไหนระบบอนุมานให้

2. **แก้ LIFF Endpoint URL** ใน LINE Developers Console
   จาก `https://example.com` → `https://sma-booking-backend.vercel.app`

## หมายเหตุสถาปัตยกรรม

- **ไม่มี key ของ Supabase อยู่ในหน้าเว็บเลย** — หน้าเว็บเรียก `/api/*` เท่านั้น
  `SUPABASE_SERVICE_ROLE_KEY` ใช้ฝั่งเซิร์ฟเวอร์ล้วน ห้ามเอาไปฝังในไฟล์ `public/`
- `line-webhook.js` ปิด body parser ของ Vercel ไว้ (`config.api.bodyParser = false`)
  เพราะต้องอ่าน raw body ไปตรวจลายเซ็นของ LINE — ถ้าย้าย framework ต้องคงพฤติกรรมนี้
- **จำนวนห้องไม่เคยเก็บในฐานข้อมูล** — คำนวณตอนแสดงผลเสมอจาก `ceil(ชาย/2) + ceil(หญิง/2)`
  เพื่อให้กฎ "ห้องละ 2 คน แยกชาย-หญิงเด็ดขาด" ไม่มีทางถูกข้ามด้วยการแก้ข้อมูลตรงๆ
- `teams` มีแถว `AREA` และ `HQ` เพิ่มจากชีตทีมเดิม (SMA1–16) เพราะพนักงานกลุ่มผู้บริหาร/
  แอดมิน/หัวหน้าแผนกกิจกรรมมีจริงและต้องผ่าน FK `employees.team_code`

## ข้อจำกัดที่รู้อยู่ (ยังไม่ทำ)

- **ยืนยันตัวตน** ใช้รหัสพนักงานเป็นตัวระบุตัวตนตรงๆ ตามที่ตกลงใน HANDOFF ข้อ 3
  ใครรู้รหัสของคนอื่นก็สวมสิทธิ์ได้ — ถ้าจะรัดกุมขึ้นต้องตรวจ LIFF ID token ฝั่ง backend
- **ไฟล์วอเชอร์** ยังเป็นการวางลิงก์ (Google Drive/OneDrive) ไม่ใช่อัปโหลดไฟล์เข้าระบบ
  ถ้าต้องการอัปโหลดตรงๆ ต้องเปิด Supabase Storage เพิ่ม
- **แดชบอร์ดผู้บริหาร** ยังใช้ข้อมูลประวัติฝังในไฟล์ (460 รายการ มี.ค.–ก.ค.) แยกจากฐานข้อมูลนี้
  การจองใหม่จากระบบนี้จะยังไม่ไหลเข้าแดชบอร์ดอัตโนมัติ
