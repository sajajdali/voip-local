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

## اتصال‌های بیرونی (قابل تنظیم در `/etc/callcenter/api.env`)

- `CLINIC_API_URL` / `CLINIC_API_TOKEN` / `CLINIC_LOOKUP_PATH`: جستجوی بیمار در سامانه نوبت‌دهی با شماره موبایل.
- `STT_URL`: سرویس تبدیل گفتار فارسی به متن (POST فایل، پاسخ `{text, confidence}`). تا وقتی تنظیم نشده، پیام‌های جدید «در انتظار تحلیل» نمایش داده می‌شوند. دسته‌بندی، احساس و اولویت از روی متن انجام می‌شود (`api/src/ai.ts`).

بعد از تغییر این فایل: `sudo systemctl restart callcenter-api`.
