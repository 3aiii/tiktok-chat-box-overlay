# TikTok Live Chat Reader (TTS + Overlay)

อ่านคอมเมนต์จาก TikTok Live แบบ real-time พร้อมอ่านออกเสียง (TTS) และแสดงบนหน้าจอ (overlay) สำหรับใช้กับ OBS/Streamlabs

## ติดตั้ง

```bash
npm install
```

## รัน

Windows PowerShell:
```powershell
$env:TIKTOK_USERNAME = "your_tiktok_username"
npm start
```

Bash:
```bash
TIKTOK_USERNAME=your_tiktok_username npm start
```

ต้องเป็น username ของบัญชีที่ **กำลัง live อยู่จริง** ไม่งั้นจะ connect ไม่ติด

## ทดสอบแบบ Mock (ไม่ต้อง live จริง)

```powershell
$env:MOCK = "1"
npm start
```

จะยิงคอมเมนต์ปลอมทุก 2.5 วิ ให้เปิด `http://localhost:8080` ดูใน browser เพื่อดู overlay + ฟัง TTS ได้เลย

## ใช้งานกับ OBS/Streamlabs

1. รัน `npm start` ทิ้งไว้ (จะเปิด HTTP server ที่ `http://localhost:8080`)
2. ใน OBS/Streamlabs: เพิ่ม **Browser Source** ใหม่ → ใส่ URL `http://localhost:8080`
3. ตั้งขนาด/ตำแหน่งให้ซ้อนภาพตามต้องการ
4. เสียง TTS จะออกทาง speaker เครื่อง — ถ้าต้องการให้เสียงลงไปในสตรีมด้วย ให้ตั้งค่า audio capture ของ browser source ใน OBS ให้จับเสียงจากหน้านั้น (Interact → หรือใช้ desktop audio capture)

## หมายเหตุ

- ใช้ library `tiktok-live-connector` v2 (unofficial) — เชื่อมต่อฟรีด้วย username เฉยๆ ได้ แต่เบื้องหลังพึ่งบริการ signing จาก [Euler Stream](https://www.eulerstream.com/) (บุคคลที่สาม) ซึ่งมี **rate limit ฟรี** อยู่ — ถ้าใช้งานหนัก/เชื่อมต่อบ่อยเกิน อาจโดน throttle ต้องสมัคร `signApiKey` เพิ่ม (มีค่าใช้จ่าย)
- มีความเสี่ยงพังถ้า TikTok เปลี่ยนระบบภายใน เพราะเป็น unofficial reverse-engineered library
- TTS ใช้ Web Speech API ของเบราว์เซอร์ (ฟรี) — ถ้าอยากได้เสียงธรรมชาติกว่านี้ ค่อยเปลี่ยนไปใช้ `edge-tts` ทีหลังได้
