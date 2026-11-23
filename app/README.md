# سامانه مرکز تماس دکتر افلاکی

پنل مرکز تماس که **جای Issabel/FreePBX را می‌گیرد** و مستقیم روی Asterisk 22 کار می‌کند.
هر تنظیمی که در پنل ذخیره شود در PostgreSQL نگه داشته می‌شود، پیکربندی Asterisk از روی آن ساخته می‌شود و reload انجام می‌شود (معادل Apply Config).

## ساختار

| مسیر | توضیح |
|---|---|
| `web/` | فرانت React (Vite). صفحه‌ها از روی قالب طرح (`web/design/*.template.html`) با `tools/dc2jsx.py` تولید می‌شوند |
| `web/design/design-logic.reference.js` | منطق نمونه طرح؛ `tools/port-logic.py` آن را همراه با `tools/app-head.js` به `web/src/App.jsx` تبدیل می‌کند |
| `api/` | بک‌اند NestJS + Prisma (PostgreSQL) + Socket.IO |
| `api/src/asterisk/generator.ts` | تولید `pjsip.conf`، دیال‌پلن، صف‌ها و موسیقی انتظار از روی تنظیمات پنل |
| `api/src/asterisk/ami.ts` | کلاینت AMI (وضعیت زنده، Originate، reload، AstDB) |
| `asterisk/conf/` | فایل‌های پایه Asterisk که فایل‌های تولیدی `/etc/asterisk/cc/*.conf` را include می‌کنند |
| `deploy/` | `install-server.sh` (پیش‌نیازها و build Asterisk)، `setup-server.sh` (دیتابیس، سرویس‌ها، nginx، فایروال)، `deploy.sh` (انتشار) |

بعد از تغییر قالب طرح یا منطق: `cd web && npm run gen && npm run build`.

> **توجه:** `web/src/App.jsx` حالا مستقیم ویرایش می‌شود و از `tools/app-head.js` جلوتر است؛ `npm run gen` (که `port-logic.py` را هم اجرا می‌کند) تغییرات آن را پاک می‌کند. بعد از تغییر قالب فقط نما را بسازید: `python3 ../tools/dc2jsx.py design/app.template.html src/generated/AppView.jsx AppView` و بعد `sed -i '' "s#'./JalaliDatePicker.jsx'#'../JalaliDatePicker.jsx'#" src/generated/AppView.jsx`.

## روی سرور (192.168.100.38)

- پنل: `https://192.168.100.38` (گواهی self-signed؛ بار اول مرورگر هشدار می‌دهد)
- سرویس‌ها: `asterisk`، `callcenter-api`، `nginx`، `postgresql`
- تنظیمات و رمزها: `/etc/callcenter/api.env` (فقط root/asterisk)
- رمزهای اولیه کاربران: `/etc/callcenter/initial-passwords.json` (بعد از اولین ورود عوض شود)
- پیکربندی تولیدی Asterisk: `/etc/asterisk/cc/`
- ضبط مکالمه‌ها: `/var/spool/asterisk/monitor/cc/` و پیام‌های صوتی: `/var/spool/asterisk/monitor/cc-vm/` (فقط با توکن از API پخش می‌شوند)
- پشتیبان شبانه دیتابیس: `/var/backups/callcenter/` (۱۴ روز)
- لاگ: `journalctl -u callcenter-api -f` و `asterisk -rvvv`

انتشار نسخه جدید از مک: `app/deploy/deploy.sh`

## نحوه کار تماس‌ها

- **ورودی:** ترانک ← `from-trunk` ← بررسی لیست سیاه (AstDB) ← مسیر ورودی منطبق (DID+CID، DID، CID، پیش‌فرض؛ بعد اولویت) ← مقصد (صف، گروه زنگ، IVR، شرط زمانی، داخلی، صندوق صوتی، بوق اشغال، قطع).
- **تست بدون ترانک:** از هر داخلی `*88` + DID را بگیرید (مثلاً `*8802188001234`)؛ تماس دقیقاً مثل تماس ورودی روی آن DID مسیریابی می‌شود. `*43` تست اکو است.
- **ثبت تماس:** در پایان هر تماس، hangup handler دیال‌پلن (`cc-hangup`) اطلاعات تماس را به `/api/hooks/call` می‌فرستد (پاسخ‌دهنده، زمان انتظار، مدت، ضبط، پیام صوتی، نظرسنجی). CDR خام هم با `cdr_pgsql` در جدول `cdr` ذخیره می‌شود.
- **ضبط:** MixMonitor روی کانال پاسخ‌دهنده (هر دو طرف مکالمه)، طبق تنظیم مسیر یا داخلی.
- **تماس با بیمار:** AMI Originate؛ اول تلفن اپراتور زنگ می‌خورد و بعد شماره بیمار گرفته می‌شود؛ همیشه ضبط می‌شود.
- **نظرسنجی:** بعد از قطع تماس توسط اپراتور، تماس‌گیرنده سه سؤال را با کلید ۱ تا ۵ پاسخ می‌دهد.
- **نوبت‌دهی تلفنی** (`api/src/booking.ts`، تنظیمات ← «نوبت‌دهی تلفنی»): همان سناریوی IVR نوبت‌دهی دکتر امیری روی ایزابل (`/var/saman/ivr/amiri/voip`، کلید ۲ و ۳ منوی اصلی) با API سامانه ماتا (`https://app.mata-app.com/api/v1/voip`). Asterisk با FastAGI به `127.0.0.1:4573` وصل می‌شود: `cc-book,s` ثبت نوبت (مقصد `book`، کد تست `*643`)، `cc-book,track` پیگیری و لغو (مقصد `booktrack`، کد تست `*644`)، `cc-book-call` تماس یادآوری و اطلاع لغو. سامانه نوبت‌دهی تماس یادآوری را با `POST /api/booking/remind` (هدر `X-Booking-Token`) می‌خواهد و پنل یک call file در `/var/spool/asterisk/outgoing` می‌سازد؛ در `appointment_v4` با `VOIP_PANEL_URL` و `VOIP_PANEL_TOKEN` روشن می‌شود (بدون آن‌ها همان SSH قبلی به ایزابل). صداهای ضبط‌شده قبلی در `asterisk/sounds/booking/` هستند و روی سرور در `/var/lib/asterisk/sounds/booking/` نصب می‌شوند (با مسیر کامل پخش می‌شوند، مستقل از زبان کانال). هر تماس در جدول `BookingLog` ثبت می‌شود؛ پیام صوتی نظرسنجی در `monitor/cc-svc/booking-*.wav`. تست‌ها: `cd api && npm test`.
- **منوی نوبت‌دهی و گزارش آن:** IVR «نوبت‌دهی (دکتر امیری)» (`ibook`) با کلید ۷ منوی روز: ۱ دریافت نوبت، ۲ پیگیری و لغو، ۰ اپراتور، * منوی اصلی. صفحه «تماس‌های نوبت‌دهی» (دسترسی `bookings`، API `GET /api/booking-calls`) گزارش روزانه، فهرست تماس‌ها با مرحله‌ای که هر تماس به آن رسید، تایم‌لاین قدم‌به‌قدم (هر قدم با زمان از شروع تماس، در `BookingLog.steps`)، نظرسنجی با پخش پیام صوتی و پیگیری کسانی که نوبت نگرفتند (`PUT /api/booking-calls/:id/follow`) را نشان می‌دهد. تماس‌هایی که به نوبت‌دهی رسیده‌اند در لیست تماس‌ها نشان «نوبت‌دهی» دارند (`BookingLog.callId` = `Call.id`).

## ارسال رویدادهای تماس (وب‌هوک)

تنظیمات ← یکپارچه‌سازی ← «ارسال رویدادهای تماس (API)»: یک آدرس، رویدادهای انتخابی، توکن و رمز امضای اختیاری.
هر رویداد با `POST` و JSON فرستاده می‌شود:

```json
{ "event": "call.answered", "eventId": "…uuid…", "callId": "C1730371234.552", "seq": 3, "occurredAt": "2026-10-31T10:20:34.000Z", "data": { … } }
```

- رویدادها: `call.started`، `call.ivr`، `call.queued`، `call.ringing`، `call.answered`، `call.transferred`، `survey.started`، `survey.completed`، `voicemail.left`، `call.ended`.
- `callId` در همه رویدادهای یک تماس یکی است و با شناسه تماس در پنل برابر است؛ `seq` ترتیب در همان تماس؛ `eventId` برای تشخیص ارسال تکراری.
- هدرها: `X-Event`، `X-Event-Id`، `X-Call-Id`، توکن در هدر انتخابی، و اگر رمز امضا تنظیم شده باشد `X-Timestamp` و `X-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
- هر رویداد اول در جدول `CallEvent` ذخیره و بعد به ترتیب هر تماس ارسال می‌شود؛ پاسخ غیر 2xx: تکرار بعد از ۱۰ ثانیه، ۱ دقیقه، ۵ دقیقه، بعد «ناموفق». خاموش کردن ارسال، رویدادهای در صف را لغو می‌کند.
- منبع: نشانه‌های `UserEvent(CCEvent,…)` در dialplan (شروع، کلید IVR، صف، نظرسنجی) و رویدادهای AMI (`DialBegin`/`DialEnd`/انتقال) در `api/src/callevents.ts`؛ پایان تماس از hangup handler (`WebhookService.finished`).

## اتصال‌های بیرونی (قابل تنظیم در `/etc/callcenter/api.env`)

- `CLINIC_API_URL` / `CLINIC_API_TOKEN` / `CLINIC_LOOKUP_PATH`: جستجوی بیمار در سامانه نوبت‌دهی با شماره موبایل.
- `STT_URL`: سرویس تبدیل گفتار فارسی به متن (POST فایل، پاسخ `{text, confidence}`). تا وقتی تنظیم نشده، پیام‌های جدید «در انتظار تحلیل» نمایش داده می‌شوند. دسته‌بندی، احساس و اولویت از روی متن انجام می‌شود (`api/src/ai.ts`).

بعد از تغییر این فایل: `sudo systemctl restart callcenter-api`.
