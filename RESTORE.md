# بازگردانی کامل سامانه مرکز تماس دکتر افلاکی

این راهنما برای وقتی است که سرور (۱۹۲.۱۶۸.۰.۲۵۴) از کار افتاده یا هاردش سوخته و باید همه چیز روی یک دستگاه جدید برگردد.

## چه چیزی کجاست

| چیز | کجا نگه داشته می‌شود |
|---|---|
| همه کدها (پنل، بک‌اند، تنظیمات Asterisk، اسکریپت‌های نصب) | همین مخزن گیت |
| تنظیمات VoIP **بدون رمزها** + فایل‌های صوتی | همین مخزن: `app/backup/` |
| بکاپ کامل **رمزگذاری‌شده**: دیتابیس (تماس‌ها، پیگیری‌ها، کاربران)، رمزهای SIP داخلی‌ها، رمزهای سرور، گواهی HTTPS، تنظیمات Asterisk، صداها | مک مدیر: `~/Backups/aflaki-callcenter/` (هر شب ساعت ۲۳:۳۰، ۳۰ نسخه آخر) |
| رمز باز کردن بکاپ‌ها | مک مدیر: `~/.aflaki-backup-pass` — **حتماً یک نسخه در Password Manager نگه دارید** |

داده بیماران و رمزها هیچ‌وقت داخل گیت نیستند. فایل‌های ضبط مکالمه در بکاپ نیستند.

## بازگردانی روی دستگاه جدید

1. **نصب اوبونتو** (۲۶.۰۴ یا جدیدتر)، ساخت کاربر `sajjad`، و اضافه کردن کلید SSH مک به `~/.ssh/authorized_keys`.
2. **sudo بدون رمز** (یک بار روی خود دستگاه، بعد از `sudo -i`):
   ```bash
   echo 'sajjad ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-sajjad && chmod 440 /etc/sudoers.d/90-sajjad
   ```
3. **کد را روی سرور بیاورید** و پیش‌نیازها و Asterisk 22 را نصب کنید (حدود ۲۰ دقیقه):
   ```bash
   sudo mkdir -p /opt/callcenter && sudo chown sajjad /opt/callcenter
   git clone git@github.com:sajajdali/araflaki_voip.git /tmp/cc && cp -a /tmp/cc/app/. /opt/callcenter/
   sudo bash /opt/callcenter/deploy/install-server.sh
   sudo bash /opt/callcenter/deploy/setup-server.sh
   ```
4. **ساخت برنامه** (روی سرور):
   ```bash
   cd /opt/callcenter/web && npm ci && npm run build
   cd /opt/callcenter/api && npm ci && npm run build
   sudo bash -c 'set -a; . /etc/callcenter/api.env; set +a; cd /opt/callcenter/api && npx prisma db push --skip-generate'
   ```
5. **برگرداندن آخرین بکاپ کامل** (از مک؛ دیتابیس، رمزها، تنظیمات و صداها برمی‌گردند):
   ```bash
   app/deploy/restore-from-backup.sh ~/Backups/aflaki-callcenter/<آخرین فایل>.tar.gz.enc sajjad@<آدرس سرور> 22
   ```
6. **شبکه**: تنظیم شبکه سرور قبلی در `/etc/callcenter/netplan-01-callcenter.yaml.from-backup` است (IP `192.168.0.254`، IP خط اپراتور `10.198.40.222` و مسیر `10.153.101.175`). اگر دستگاه جای سرور قبلی قرار می‌گیرد:
   ```bash
   sudo cp /etc/callcenter/netplan-01-callcenter.yaml.from-backup /etc/netplan/01-callcenter.yaml && sudo chmod 600 /etc/netplan/01-callcenter.yaml && sudo netplan apply
   ```
7. **چک نهایی**: `sudo bash /opt/callcenter/deploy/cutover.sh check` — ترانک، گوشی‌ها، سرویس‌ها و پنل.

چون رمزهای SIP همان قبلی برمی‌گردند، گوشی‌ها بدون تنظیم دوباره وصل می‌شوند.

## اگر بکاپ رمزگذاری‌شده در دسترس نبود

تنظیمات VoIP از نسخه داخل گیت برمی‌گردد (بعد از مرحله ۴):
```bash
sudo bash -c 'set -a; . /etc/callcenter/api.env; set +a; cd /opt/callcenter/api && node dist/seed.js > /etc/callcenter/initial-passwords.json && node dist/config-snapshot.js import /opt/callcenter/backup/config-snapshot.json'
# seed.js also loads the design's sample calls: remove them
sudo -u postgres psql -d callcenter -c 'DELETE FROM "Note"; DELETE FROM "Follow"; DELETE FROM "Call"; DELETE FROM "Patient";'
sudo cp /opt/callcenter/backup/sounds/*.wav /var/lib/asterisk/sounds/custom/ && sudo chown asterisk:asterisk /var/lib/asterisk/sounds/custom/*
sudo systemctl restart callcenter-api
```
در این حالت تاریخچه تماس‌ها برنمی‌گردد و **برای داخلی‌ها رمز SIP جدید ساخته می‌شود**؛ رمز جدید هر داخلی را از «مدیریت داخلی‌ها» ببینید (یا با «تغییر رمز» عوض کنید) و در گوشی‌ها وارد کنید. رمز ترانک و توکن «تنظیمات API» را هم دوباره در پنل وارد کنید.

## بکاپ دستی

```bash
app/deploy/backup-to-mac.sh
```
گزارش بکاپ‌های شبانه: `~/Backups/aflaki-callcenter/backup.log`.
پیشنهاد: پوشه `~/Backups/aflaki-callcenter` را هر چند وقت یک بار روی یک هارد جدا یا فضای ابری هم کپی کنید تا اگر مک هم از دست رفت، بکاپ‌ها بمانند.

## به‌روزرسانی مخزن گیت بعد از هر تغییر

```bash
cd "/Applications/sajjad/for jobs/aflaki call center"
git add -A && git commit -m "توضیح تغییر" && git push
```
