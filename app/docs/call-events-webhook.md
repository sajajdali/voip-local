# راهنمای دریافت رویدادهای تماس (وب‌هوک مرکز تماس نورون)

این راهنما برای تیمی است که می‌خواهد رویدادهای مرکز تماس را در سامانه‌ی خودش (CRM، پرونده‌ی بیمار، داشبورد و…) دریافت کند.

مرکز تماس هر مرحله از هر تماس را **همان لحظه** با یک درخواست `POST` و بدنه‌ی JSON به **یک آدرس** که شما می‌دهید می‌فرستد. شما فقط باید یک endpoint بسازید که این درخواست‌ها را بگیرد، ذخیره کند و جواب `200` بدهد.

---

## ۱. خلاصه برای شروع سریع

| مورد | مقدار |
|---|---|
| متد | `POST` |
| نوع بدنه | `application/json; charset=utf-8` |
| آدرس | یک آدرس HTTPS که شما می‌سازید، مثلاً `https://crm.example.ir/api/callcenter/events` |
| پاسخ موفق | هر کد `2xx` (مثلاً `200` با بدنه‌ی `ok`) |
| مهلت پاسخ | پیش‌فرض ۱۰ ثانیه (قابل تنظیم بین ۲ تا ۶۰). بعد از آن، ارسال ناموفق حساب می‌شود |
| همه‌ی رویدادها | به همین یک آدرس؛ نوع رویداد در فیلد `event` و هدر `X-Event` است |

**مهم‌ترین قانون:** سریع جواب بدهید. درخواست را ذخیره کنید و فوراً `200` برگردانید. پردازش‌های سنگین (فراخوانی سرویس‌های دیگر، ارسال پیامک و…) را در صف یا job پس‌زمینه انجام دهید. اگر پاسخ دیر برسد یا 2xx نباشد، همان رویداد دوباره فرستاده می‌شود.

---

## ۲. هدرهای هر درخواست

| هدر | توضیح |
|---|---|
| `Content-Type` | `application/json; charset=utf-8` |
| `User-Agent` | `NeuronCallCenter/2.0` |
| `X-Event` | نوع رویداد، مثلاً `call.answered` (همان فیلد `event`) |
| `X-Event-Id` | شناسه‌ی یکتای این رویداد (همان `eventId`) |
| `X-Call-Id` | شناسه‌ی تماس (همان `callId`) |
| توکن (اختیاری) | اگر در تنظیمات مرکز تماس توکن گذاشته شود، در هدری با نام دلخواه می‌آید؛ پیش‌فرض `Authorization: Bearer <توکن>` |
| `X-Timestamp` (اختیاری) | فقط وقتی «رمز امضا» تنظیم شده باشد: زمان ارسال به ثانیه‌ی یونیکس |
| `X-Signature` (اختیاری) | فقط وقتی «رمز امضا» تنظیم شده باشد: `sha256=<hex>`. بخش ۷ را ببینید |

---

## ۳. قالب ثابت هر رویداد

همه‌ی رویدادها یک «پاکت» یکسان دارند و اطلاعات خاص هر رویداد داخل `data` است:

```json
{
  "event": "call.answered",
  "eventId": "7f3c9a2e-5b1d-4c8a-9e0f-2a6b7c8d9e10",
  "callId": "C1730371234.552",
  "seq": 4,
  "occurredAt": "2026-10-31T07:20:34.000Z",
  "data": { "...": "..." }
}
```

| فیلد | نوع | توضیح |
|---|---|---|
| `event` | string | نوع رویداد (فهرست در بخش ۴) |
| `eventId` | string (UUID) | یکتا برای هر رویداد. اگر همان `eventId` دوباره رسید، تکراری است و باید نادیده گرفته شود |
| `callId` | string | شناسه‌ی تماس. **در همه‌ی رویدادهای یک تماس یکسان است** و با شناسه‌ی تماس در پنل مرکز تماس برابر است |
| `seq` | integer | شماره‌ی ترتیب رویداد در همان تماس: ۱، ۲، ۳، … |
| `occurredAt` | string (ISO 8601، UTC) | زمان وقوع رویداد. برای نمایش به وقت تهران، ۳:۳۰ اضافه کنید |
| `test` | boolean (اختیاری) | فقط در ارسال‌های آزمایشی از دکمه‌ی «ارسال تست» برابر `true` است. در این حالت `callId` برابر `test` است |

**شکل `callId`:**
- `C…` (مثل `C1793952700.33`): یک تماس واقعی که در پنل هم با همین شناسه ثبت می‌شود.
- `B…`: تماس خودکاری که خود سامانه برای یادآوری نوبت یا اطلاع لغو می‌گیرد. این تماس‌ها فقط رویدادهای `booking.*` دارند و `call.*` ندارند.
- `test`: ارسال آزمایشی.
| `data` | object | اطلاعات رویداد (بخش ۴) |

**شماره‌ها:** شماره‌ی موبایل به شکل استاندارد ۱۱ رقمی است، مثل `09121234567`، و برای پیدا کردن بیمار مستقیماً قابل جستجوست. شماره‌های ناشناس یا ثابت ممکن است شکل دیگری داشته باشند.

---

## ۴. رویدادها و فیلدهای `data`

ترتیب معمول در یک تماس ورودی:

`call.started` → `call.ivr` → `call.queued` → `call.ringing` → `call.answered` → (`call.transferred`) → `survey.started` → `survey.completed` → `call.ended`

اگر تماس‌گیرنده وارد **نوبت‌دهی تلفنی** شود، رویدادهای نوبت‌دهی با **همان `callId`** و ادامه‌ی همان `seq` بین رویدادهای تماس می‌آیند:

`call.started` → `call.ivr` (کلید ۲) → `booking.entered` → `booking.step` × چند بار → (`booking.booked` یا `booking.cancelled`) → `booking.ended` → `call.ended`

هر رویداد در تنظیمات مرکز تماس جداگانه روشن یا خاموش می‌شود. سامانه‌ی شما باید رویدادی را که نمی‌شناسد بی‌خطا با `200` جواب بدهد و نادیده بگیرد؛ ممکن است بعداً رویداد تازه اضافه شود.

### `call.started`: شروع تماس
تماس ورودی وارد مرکز شد، یا تماس خروجی (از داخلی یا «تماس با بیمار» از پنل) شروع شد.

| فیلد | نوع | توضیح |
|---|---|---|
| `direction` | `inbound` \| `outbound` | جهت تماس |
| `phone` | string | شماره‌ی طرف بیرونی (بیمار) |
| `callerNumber` | string \| null | شماره‌ی تماس‌گیرنده (فقط ورودی) |
| `calledNumber` | string \| null | ورودی: شماره‌ی خطی که با آن تماس گرفته شد (DID)؛ خروجی: شماره‌ی مقصد |
| `patientName` | string \| null | نام بیمار، اگر در سامانه‌ی بیماران شناخته شود |
| `calls` | object \| null | سابقه‌ی تماس این شماره (جدول زیر). برای شماره‌ی ناشناس یا مخفی `null` است |
| `operator` | object (فقط خروجی) | `{ "extension": "101", "name": "خانم احمدی" }` |
| `isCallback` | boolean | `true` یعنی تماس خروجی از دکمه‌ی «تماس با بیمار» پنل |

فیلدهای `calls` (سابقه‌ی این شماره در مرکز تماس). **همین تماس هم شمرده شده است**، پس کسی که بار اول زنگ می‌زند `total: 1` و `today: 1` دارد:

| فیلد | نوع | توضیح |
|---|---|---|
| `total` | integer | تعداد کل تماس‌های این شماره (ورودی و خروجی) |
| `today` | integer | تعداد تماس‌های امروز این شماره (روز به وقت تهران) |
| `inboundTotal` | integer | فقط تماس‌هایی که خود او گرفته (ورودی)، کل |
| `inboundToday` | integer | فقط تماس‌های ورودی امروز |
| `lastCallAt` | string \| null | زمان آخرین تماس قبلی (ISO، UTC)؛ برای اولین تماس `null` |
| `firstCall` | boolean | `true` یعنی این شماره قبلاً هیچ تماسی نداشته |

```json
{ "event": "call.started", "eventId": "…", "callId": "C1730371234.552", "seq": 1, "occurredAt": "2026-10-31T07:20:10.000Z",
  "data": { "direction": "inbound", "phone": "09121234567", "callerNumber": "09121234567", "calledNumber": "02112345678", "patientName": "علی رضایی",
    "calls": { "total": 7, "today": 2, "inboundTotal": 5, "inboundToday": 2, "lastCallAt": "2026-10-31T04:12:00.000Z", "firstCall": false },
    "isCallback": false } }
```

### `call.ivr`: انتخاب در منوی تلفنی
تماس‌گیرنده در یک منوی IVR کلیدی زد. اگر چند منو پشت سر هم باشد، برای هر انتخاب یک رویداد می‌آید.

| فیلد | نوع | توضیح |
|---|---|---|
| `menu` | string | نام منو، مثلاً «منوی اصلی» |
| `key` | string | کلیدی که زده شد: `0`–`9`، `*` یا `#` |
| `label` | string \| null | عنوان آن گزینه، مثلاً «پذیرش» |

```json
"data": { "menu": "نوبت‌دهی (دکتر امیری)", "key": "2", "label": "پیگیری و لغو نوبت" }
```

### `call.queued`: ورود به صف
| فیلد | نوع | توضیح |
|---|---|---|
| `queue` | string | نام صف |
| `phone` | string | شماره‌ی تماس‌گیرنده |

### `call.ringing`: زنگ خوردن
گوشی داخلی (یا موبایلِ «دنبال‌کردن تماس»، یا شماره‌ی مقصد در تماس خروجی) زنگ می‌خورد.
- در صفِ «زنگ همه»، برای هر داخلی یک رویداد جدا می‌آید.
- اگر صف دوباره زنگ بزند، برای هر داخلی حداکثر هر ۳۰ ثانیه یک بار فرستاده می‌شود.

| فیلد | نوع | توضیح |
|---|---|---|
| `target` | `extension` \| `mobile` \| `external` \| `ai` | چه چیزی زنگ می‌خورد |
| `extension` | string (برای `extension`) | شماره‌ی داخلی |
| `operator` | string \| null (برای `extension`) | نام اپراتور آن داخلی |
| `number` | string (برای `mobile` و `external`) | شماره‌ی مقصد |
| `queue` | string \| null | صفی که تماس در آن است |

### `call.answered`: وصل شدن
داخلی (یا مقصد) جواب داد و مکالمه شروع شد. برای هر تماس یک بار؛ بعد از انتقال، وصل شدن به مقصد جدید دوباره فرستاده می‌شود.

| فیلد | نوع | توضیح |
|---|---|---|
| `target`, `extension`, `operator`, `number`, `queue` | | مثل `call.ringing` |
| `waitSeconds` | integer | چند ثانیه از شروع تماس تا وصل شدن گذشت |

```json
"data": { "target": "extension", "extension": "101", "operator": "خانم احمدی", "queue": "پذیرش", "waitSeconds": 18 }
```

### `call.transferred`: انتقال تماس
| فیلد | نوع | توضیح |
|---|---|---|
| `kind` | `blind` \| `attended` | انتقال مستقیم یا با هماهنگی |
| `from` | `{extension, name}` \| null | اپراتوری که منتقل کرد |
| `to` | `{extension, name}` یا `{number}` \| null | داخلی یا شماره‌ی مقصد |

```json
"data": { "kind": "blind", "from": { "extension": "101", "name": "خانم احمدی" }, "to": { "extension": "102", "name": "پذیرش ۲" } }
```

### `survey.started`: شروع نظرسنجی
بعد از اینکه اپراتور قطع کرد، نظرسنجی برای تماس‌گیرنده پخش شد.

| فیلد | نوع | توضیح |
|---|---|---|
| `phone` | string | شماره‌ی تماس‌گیرنده |
| `operator` | `{extension, name}` \| null | اپراتوری که با او صحبت کرد |

### `survey.completed`: پایان نظرسنجی
درست قبل از `call.ended` فرستاده می‌شود و فقط وقتی حداقل به یک سؤال جواب داده شده باشد.

| فیلد | نوع | توضیح |
|---|---|---|
| `phone` | string | |
| `answers` | integer[] | امتیاز هر سؤال به ترتیب، هر کدام ۱ تا ۵؛ اگر وسط نظرسنجی قطع کند، کوتاه‌تر است |
| `score` | number | میانگین، با یک رقم اعشار |
| `hasVoiceComment` | boolean | برای امتیاز پایین، تماس‌گیرنده پیام صوتی هم گذاشت |
| `operator` | `{extension, name}` \| null | |

```json
"data": { "phone": "09121234567", "answers": [5, 4, 5], "score": 4.7, "hasVoiceComment": false, "operator": { "extension": "101", "name": "خانم احمدی" } }
```

### `voicemail.left`: پیام صوتی
درست قبل از `call.ended` فرستاده می‌شود.

| فیلد | نوع | توضیح |
|---|---|---|
| `phone` | string | |
| `patientName` | string \| null | |
| `queue` | string | از کدام صندوق یا منو |
| `seconds` | integer | طول پیام |
| `hasRecording` | boolean | فایل پیام ذخیره شد |

### `call.ended`: پایان تماس (خلاصه‌ی کامل)
همیشه **آخرین** رویداد هر تماس است. اگر فقط به یک رویداد نیاز دارید، همین را بگیرید.

| فیلد | نوع | توضیح |
|---|---|---|
| `direction` | `inbound` \| `outbound` | |
| `status` | `answered` \| `missed` \| `voicemail` \| `transferred` | نتیجه. مکالمه‌ی کوتاه‌تر از ۵ ثانیه `missed` حساب می‌شود |
| `statusLabel` | string | همان به فارسی: پاسخ‌داده، بی‌پاسخ، پیام صوتی، انتقال‌یافته |
| `shortCall` | boolean | وصل شد ولی کمتر از ۵ ثانیه حرف زده شد |
| `phone`, `callerNumber`, `calledNumber`, `patientName` | | مثل `call.started` |
| `queue` | string | آخرین صف یا منویی که تماس در آن بود |
| `operator` | `{extension, name}` \| null | اپراتوری که جواب داد |
| `isCallback` | boolean | |
| `startedAt`, `endedAt` | ISO 8601 (UTC) | شروع و پایان |
| `date`, `time` | string | تاریخ شمسی و ساعت تهران، مثل `1405/08/09` و `10:52` |
| `waitSeconds` | integer | انتظار تا وصل شدن (یا کل تماس اگر وصل نشد) |
| `talkSeconds` | integer | مدت مکالمه (در تماس کوتاه، صفر) |
| `connectedSeconds` | integer | مدت وصل بودن، حتی اگر کوتاه بوده |
| `hasRecording` | boolean | مکالمه یا پیام ضبط شده است |
| `survey` | object \| null | `{ "answers": [5,4], "score": 4.5, "comment": "", "hasRec": false }` |
| `summary` | string \| null | یادداشت اپراتور برای «تماس با بیمار» |

```json
{ "event": "call.ended", "eventId": "…", "callId": "C1730371234.552", "seq": 8, "occurredAt": "2026-10-31T07:22:41.000Z",
  "data": { "direction": "inbound", "status": "answered", "statusLabel": "پاسخ‌داده", "shortCall": false,
    "phone": "09121234567", "callerNumber": "09121234567", "calledNumber": "02112345678", "patientName": "علی رضایی",
    "queue": "پذیرش", "operator": { "extension": "101", "name": "خانم احمدی" }, "isCallback": false,
    "startedAt": "2026-10-31T07:20:10.000Z", "endedAt": "2026-10-31T07:22:41.000Z", "date": "1405/08/09", "time": "10:50",
    "waitSeconds": 18, "talkSeconds": 133, "connectedSeconds": 133, "hasRecording": true,
    "survey": { "answers": [5, 4, 5], "score": 4.7, "comment": "", "hasRec": false }, "summary": null } }
```

---

## ۴ب. رویدادهای نوبت‌دهی تلفنی (`booking.*`)

این رویدادها فقط وقتی می‌آیند که در پنل، «نوبت‌دهی تلفنی» روشن باشد و تیک همان رویداد در «ارسال رویدادهای تماس» زده شده باشد. نوبت‌دهی به سامانه‌ی نوبت‌دهی مطب وصل است. تماس‌گیرنده زمان خالی می‌شنود، کد ملی و موبایل وارد می‌کند، نوبت ثبت می‌شود و کد پیگیری می‌گیرد. یا با کد پیگیری نوبتش را پیدا یا لغو می‌کند.

**حریم خصوصی:** کد ملی هیچ‌وقت کامل فرستاده نمی‌شود، همیشه به شکل `******4661`.

### مسیرها (`flow`)

| `flow` | `flowLabel` | توضیح |
|---|---|---|
| `book` | ثبت نوبت | تماس‌گیرنده «نوبت جدید» را انتخاب کرد |
| `mata` | لینک ماتا | در «نوبت جدید» گفت قبلاً درمان شده؛ به‌جای نوبت، لینک اپ ماتا پیامک می‌شود. `flow` از `book` به `mata` عوض می‌شود |
| `follow` | پیگیری با کد | «پیگیری و لغو نوبت»: کد ملی و کد پیگیری، شنیدن نوبت، و در صورت اجازه لغو آن |
| `remind` | تماس یادآوری | سامانه خودش زنگ می‌زند: «نوبت شما فردا ساعت …؛ ۱ تأیید، ۵ لغو». `callId` با `B` شروع می‌شود |
| `cancelnotice` | اطلاع لغو | سامانه خودش زنگ می‌زند و لغو نوبت را اطلاع می‌دهد. `callId` با `B` شروع می‌شود |

### `booking.entered`: ورود به نوبت‌دهی

| فیلد | نوع | توضیح |
|---|---|---|
| `flow` | `book` \| `follow` \| `remind` \| `cancelnotice` | مسیر (جدول بالا) |
| `flowLabel` | string | نام فارسی مسیر |
| `phone` | string \| null | شماره‌ی تماس‌گیرنده؛ در تماس یادآوری، موبایل بیمار |
| `appointment` | object (فقط `remind` و `cancelnotice`) | `{ "code": "85504499", "id": "1234", "slotAt": "ISO", "time": "10:30" }` |

```json
"data": { "flow": "book", "flowLabel": "ثبت نوبت", "phone": "09121234567" }
```

### `booking.step`: هر مرحله، همان لحظه

برای هر سؤالی که پرسیده می‌شود، هر کلیدی که زده می‌شود، هر زمانی که پیشنهاد می‌شود و هر پاسخی که سامانه‌ی نوبت‌دهی می‌دهد، یک رویداد می‌آید.

| فیلد | نوع | توضیح |
|---|---|---|
| `flow`, `flowLabel` | | مسیر فعلی |
| `step` | string | کد مرحله (جدول زیر) |
| `stepLabel` | string | نام فارسی مرحله |
| `key` | string \| null | کلیدی که تماس‌گیرنده زد. خالی (`""`) یعنی چیزی نزد. برای کد ملی، شکل پوشانده |
| `value` | string \| null | مقدار مرحله: زمان پیشنهادی (یونیکس)، موبایل، یا پاسخ سامانه مثل `ok 85504499` یا `fail #1: …` یا `error: …` |
| `elapsedMs` | integer | میلی‌ثانیه از ورود به نوبت‌دهی |
| `offeredAt`, `offeredDate`, `offeredTime` | فقط برای `chooseTime` | زمان پیشنهادی: ISO، تاریخ شمسی، ساعت تهران |
| `accepted` | boolean، فقط برای `chooseTime` | `true` یعنی همین زمان را پذیرفت (کلید ۱) |

| `step` | `stepLabel` | `key` | `value` |
|---|---|---|---|
| `treated` | سؤال «قبلاً توسط دکتر درمان شده‌اید؟» | ۱ = بله (لینک ماتا)، ۲ = خیر (نوبت جدید) | – |
| `mataMobile` | ورود موبایل برای لینک ماتا | موبایل واردشده | – |
| `mataOffer` | تأیید ارسال لینک ماتا | ۱ = بفرست | – |
| `apiMata` | ارسال لینک ماتا (سامانه نوبت‌دهی) | – | `ok` / `fail …` |
| `apiTimes` | دریافت زمان‌های خالی | – | مثل `311 times · doctor 4` یا `no schedule` |
| `chooseTime` | پیشنهاد زمان نوبت | ۱ = همین، ۲ = زمان بعدی، ۳ = روز بعد، `*` = منوی اصلی | زمان پیشنهادی (یونیکس) |
| `codeMeli` | ورود کد ملی | کد ملی پوشانده؛ `*` = برگشت | – |
| `enterMobile` | ورود شماره موبایل | موبایل واردشده | – |
| `mobileConfirm` | تأیید شماره موبایل | ۱ = تأیید، ۲ = شماره‌ی دیگر، `*` = برگشت | – |
| `mobile` | موبایل نهایی | – | موبایلی که نوبت با آن ثبت می‌شود |
| `apiStore` | ثبت نوبت (سامانه نوبت‌دهی) | – | `ok <کد پیگیری>` / `fail #1: …` (۱ = تکراری) |
| `survey` | نظرسنجی بعد از ثبت | امتیاز ۱ تا ۵ | – |
| `surveyScore` | امتیاز نظرسنجی | امتیاز | – |
| `surveyRec` | ضبط نظر صوتی | – | نام فایل روی سرور |
| `trackingCode` | ورود کد پیگیری | کد واردشده | – |
| `apiTrack` | جستجوی نوبت | – | `found <id>` / `not found` |
| `askCancel` | سؤال لغو نوبت | ۱ = لغو، ۲ یا `*` = منوی اصلی | – |
| `apiCancel` | لغو نوبت | – | `ok` / `fail …` |
| `remind` | پاسخ به تماس یادآوری | ۱ = تأیید، ۵ = لغو | – |
| `apiApprove` | تأیید نوبت | – | `ok` / `fail …` |

یک مرحله ممکن است چند بار بیاید. مثلاً `chooseTime` برای هر زمانی که پیشنهاد می‌شود، و `codeMeli` اگر کد ملی اشتباه وارد شود. ممکن است در آینده مرحله‌ی تازه اضافه شود؛ مرحله‌ی ناشناخته را با `stepLabel` نمایش دهید یا نادیده بگیرید.

```json
"data": { "flow": "book", "flowLabel": "ثبت نوبت", "step": "chooseTime", "stepLabel": "پیشنهاد زمان نوبت", "key": "1", "value": "1794216600",
  "elapsedMs": 21400, "offeredAt": "2026-11-09T07:00:00.000Z", "offeredDate": "1405/08/18", "offeredTime": "10:30", "accepted": true }
```

### `booking.booked`: نوبت ثبت شد

| فیلد | نوع | توضیح |
|---|---|---|
| `phone` | string \| null | شماره‌ی تماس‌گیرنده |
| `mobile` | string | موبایلی که نوبت با آن ثبت شد |
| `code` | string | کد پیگیری نوبت |
| `slotAt` | ISO 8601 | زمان نوبت |
| `date`, `time` | string | تاریخ شمسی و ساعت تهران نوبت |
| `doctor` | string \| null | پزشک، همان‌طور که سامانه‌ی نوبت‌دهی برگرداند |
| `nationalCodeMasked` | string | کد ملی پوشانده |

### `booking.cancelled`: نوبت لغو شد

| فیلد | نوع | توضیح |
|---|---|---|
| `via` | `follow` \| `remind` | از پیگیری تلفنی یا از تماس یادآوری |
| `phone`, `mobile`, `code` | | |
| `slotAt`, `date`, `time` | | زمان نوبتِ لغوشده (اگر معلوم باشد) |

### `booking.ended`: پایان نوبت‌دهی

همیشه **آخرین** رویداد نوبت‌دهی آن تماس است: نتیجه، اطلاعات نوبت و **همه‌ی مراحل**. اگر فقط به یک رویداد نوبت‌دهی نیاز دارید، همین را بگیرید.

| فیلد | نوع | توضیح |
|---|---|---|
| `flow`, `flowLabel` | | مسیر نهایی |
| `result` | string | نتیجه (جدول زیر) |
| `resultLabel` | string | نتیجه به فارسی |
| `phone`, `mobile`, `code`, `appointmentId`, `doctor` | | هر کدام اگر معلوم شد، وگرنه `null` |
| `slotAt`, `date`, `time` | | زمان نوبت (ثبت‌شده، پیداشده یا لغوشده) |
| `offeredTimes` | integer | چند زمان به او پیشنهاد شد |
| `nationalCodeMasked` | string \| null | |
| `surveyScore` | integer \| null | امتیاز نظرسنجی بعد از ثبت |
| `hasVoiceComment` | boolean | نظر صوتی گذاشت |
| `error` | string \| null | پیام خطای سامانه‌ی نوبت‌دهی |
| `durationSeconds` | integer | مدت حضور در نوبت‌دهی |
| `steps` | array | همه‌ی مراحل به ترتیب، با همان فیلدهای `booking.step` (بدون `flow`) |

| `result` | `resultLabel` | معنی |
|---|---|---|
| `booked` | نوبت گرفت | نوبت ثبت شد |
| `duplicate` | نوبت تکراری | این شخص قبلاً نوبت داشت |
| `not_booked` | ثبت نشد | سامانه‌ی نوبت‌دهی ثبت را نپذیرفت |
| `no_slots` | زمان خالی نبود | |
| `link_sent` | لینک ماتا ارسال شد | |
| `found` | نوبت اعلام شد | پیگیری: نوبت پیدا و خوانده شد |
| `not_found` | نوبت پیدا نشد | |
| `inactive` | نوبت فعال نیست | |
| `cancelled` | لغو شد | |
| `confirmed` | یادآوری تأیید شد | |
| `notified` | اطلاع لغو داده شد | |
| `invalid` | نیمه‌کاره رها کرد | چیزی نزد یا کلید اشتباه زد تا دفعات مجاز تمام شد |
| `back` | برگشت به منو | `*` زد و به منوی اصلی برگشت. ممکن است بعداً دوباره وارد شود و `booking.entered` تازه بیاید |
| `hangup` | وسط کار قطع کرد | |
| `error` | خطای سامانه | سامانه‌ی نوبت‌دهی جواب نداد یا خطا داد. تماس به مقصد پشتیبان (معمولاً اپراتور) می‌رود |

```json
"data": { "flow": "book", "flowLabel": "ثبت نوبت", "result": "booked", "resultLabel": "نوبت گرفت", "phone": "09121234567", "mobile": "09121234567",
  "code": "85504499", "appointmentId": null, "doctor": "دکتر امیری", "slotAt": "2026-11-09T07:00:00.000Z", "date": "1405/08/18", "time": "10:30",
  "offeredTimes": 2, "nationalCodeMasked": "******4661", "surveyScore": 5, "hasVoiceComment": false, "error": null, "durationSeconds": 96,
  "steps": [
    { "step": "treated", "stepLabel": "سؤال «قبلاً توسط دکتر درمان شده‌اید؟»", "key": "2", "value": null, "elapsedMs": 6100 },
    { "step": "apiTimes", "stepLabel": "دریافت زمان‌های خالی (سامانه نوبت‌دهی)", "key": null, "value": "14 times · doctor دکتر امیری", "elapsedMs": 7300 },
    { "step": "chooseTime", "stepLabel": "پیشنهاد زمان نوبت", "key": "1", "value": "1794216600", "elapsedMs": 21400, "offeredDate": "1405/08/18", "offeredTime": "10:30", "accepted": true },
    { "step": "codeMeli", "stepLabel": "ورود کد ملی", "key": "******4661", "value": null, "elapsedMs": 38800 },
    { "step": "apiStore", "stepLabel": "ثبت نوبت (سامانه نوبت‌دهی)", "key": null, "value": "ok 85504499", "elapsedMs": 54900 }
  ] }
```

**یک تماس، چند بار نوبت‌دهی:** اگر تماس‌گیرنده با `*` به منو برگردد و دوباره وارد شود، برای هر بار یک `booking.entered` و یک `booking.ended` جدا می‌آید، همه با همان `callId`. هر `booking.ended` مال آخرین `booking.entered` قبل از خودش است.

---

## ۵. ترتیب، تکرار و ارسال دوباره

- **ترتیب:** رویدادهای **یک تماس** به ترتیب `seq` فرستاده می‌شوند. تا رویداد قبلی تحویل نشده (یا بعد از همه‌ی تلاش‌ها ناموفق نشده)، بعدی نمی‌آید. رویدادهای **تماس‌های مختلف** ممکن است هم‌زمان و درهم برسند.
- **تکرار در صورت خطا:** اگر جواب 2xx ندهید یا در مهلت جواب ندهید، همان رویداد (با همان `eventId`) ۱۰ ثانیه، ۱ دقیقه و ۵ دقیقه بعد دوباره فرستاده می‌شود. بعد از آن «ناموفق» ثبت می‌شود و رویدادهای بعدی همان تماس ادامه پیدا می‌کنند.
- **دریافت تکراری:** ممکن است یک رویداد دو بار برسد؛ مثلاً اگر شما ذخیره کردید ولی پاسخ‌تان در شبکه گم شد، یا اپراتور از پنل «ارسال دوباره» زد. **با `eventId` تکراری‌ها را تشخیص دهید** و دوباره پردازش نکنید.
- **ترتیب سمت شما:** اگر به هر دلیلی رویدادی دیرتر رسید، با `seq` (یا `occurredAt`) مرتب کنید. مثلاً `call.answered` با `seq` بالاتر را روی `call.ringing` قبلی بنویسید.
- **رویداد جاافتاده:** اگر رویدادی را از دست دادید، `call.ended` همیشه خلاصه‌ی کامل تماس را دارد و می‌تواند جای خالی را پر کند.

---

## ۶. پیشنهاد پیاده‌سازی

۱. **endpoint:** یک مسیر `POST` بسازید. اگر مرکز تماس توکن یا امضا دارد، اول آن را چک کنید (بخش ۷).
۲. **ذخیره‌ی خام:** کل JSON را در جدول رویدادها ذخیره کنید، با `event_id` یکتا (unique index). اگر درج به‌خاطر تکراری بودن خطا داد، باز هم `200` برگردانید.
۳. **پاسخ:** همان لحظه `200` برگردانید.
۴. **پردازش در پس‌زمینه:**
   - بر اساس `callId` یک رکورد «تماس» بسازید یا به‌روز کنید (وضعیت لحظه‌ای: در صف، زنگ، در حال مکالمه با فلان داخلی…).
   - با `data.phone` به پرونده‌ی بیمار وصل کنید.
   - روی `call.ended` رکورد تماس را نهایی کنید (وضعیت، مدت‌ها، اپراتور، نظرسنجی).

جدول پیشنهادی:

```sql
CREATE TABLE callcenter_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id     CHAR(36)     NOT NULL UNIQUE,
  call_id      VARCHAR(40)  NOT NULL,
  seq          INT          NOT NULL,
  event        VARCHAR(40)  NOT NULL,
  occurred_at  DATETIME(3)  NOT NULL,
  phone        VARCHAR(20)  NULL,
  payload      JSON         NOT NULL,
  received_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (call_id, seq),
  INDEX (phone)
);
```

---

## ۷. بررسی امضا (اگر «رمز امضا» تنظیم شده باشد)

اگر در تنظیمات مرکز تماس «رمز امضا» گذاشته شود، همان رمز را در سامانه‌ی خود هم نگه دارید. امضا به این شکل ساخته می‌شود:

```
X-Signature = "sha256=" + hex( HMAC_SHA256( secret, X-Timestamp + "." + rawBody ) )
```

- **`rawBody`:** دقیقاً بایت‌های بدنه‌ی دریافتی است، **قبل از** parse کردن JSON. اگر JSON را parse و دوباره serialize کنید، امضا جور درنمی‌آید.
- **مقایسه:** با تابع مقایسه‌ی امن (constant-time) انجام شود.
- **جلوگیری از ارسال دوباره‌ی جعلی (replay):** درخواستی که `X-Timestamp` آن بیش از ۵ دقیقه با ساعت سرور شما فاصله دارد را رد کنید (`401`).
- **ساعت سرور:** ساعت سرور خود را با NTP همگام نگه دارید.

### PHP (Laravel)

```php
// routes/api.php
Route::post('/callcenter/events', [CallCenterWebhookController::class, 'handle']);

// app/Http/Controllers/CallCenterWebhookController.php
public function handle(Request $request)
{
    $raw = $request->getContent();
    $secret = config('services.callcenter.webhook_secret');      // همان «رمز امضا»

    if ($secret) {
        $ts  = (string) $request->header('X-Timestamp');
        $sig = (string) $request->header('X-Signature');
        $expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $raw, $secret);
        if (! hash_equals($expected, $sig) || abs(time() - (int) $ts) > 300) {
            return response('invalid signature', 401);
        }
    }

    $e = json_decode($raw, true);
    try {
        DB::table('callcenter_events')->insert([
            'event_id'    => $e['eventId'],
            'call_id'     => $e['callId'],
            'seq'         => $e['seq'],
            'event'       => $e['event'],
            'occurred_at' => Carbon::parse($e['occurredAt']),
            'phone'       => $e['data']['phone'] ?? null,
            'payload'     => $raw,
        ]);
        ProcessCallCenterEvent::dispatch($e['eventId']);            // پردازش در صف
    } catch (\Illuminate\Database\UniqueConstraintViolationException) {
        // تکراری: قبلاً دریافت شده
    }

    return response('ok', 200);
}
```

> اگر از گروه middleware به نام `web` استفاده می‌کنید، این مسیر را از CSRF مستثنی کنید (یا در `routes/api.php` بگذارید).

### Node.js (Express)

```js
import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.CALLCENTER_WEBHOOK_SECRET; // همان «رمز امضا»

app.post('/callcenter/events', express.raw({ type: 'application/json' }), async (req, res) => {
  const raw = req.body; // Buffer
  if (SECRET) {
    const ts = req.get('X-Timestamp') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(ts + '.').update(raw).digest('hex');
    const got = req.get('X-Signature') || '';
    const ok = got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).send('invalid signature');
  }
  const e = JSON.parse(raw.toString('utf8'));
  await saveIfNew(e);          // INSERT … با event_id یکتا؛ تکراری را نادیده بگیرید
  res.status(200).send('ok');  // سریع جواب بدهید
  queueProcessing(e);          // پردازش بعد از پاسخ
});
```

---

## ۸. تست

۱. **ارسال تست از پنل:** endpoint را بالا بیاورید و آدرس را به مسئول مرکز تماس بدهید. در پنل: **تنظیمات ← یکپارچه‌سازی ← «ارسال رویدادهای تماس (API)»** ← آدرس را وارد و ذخیره کنید ← روی هر رویداد بزنید و «ارسال تست» را بزنید. نمونه‌ی همان رویداد با `"test": true` و `"callId": "test"` می‌رسد. نتیجه (کد پاسخ شما و خطا) در «گزارش ارسال‌ها»ی همان صفحه دیده می‌شود.
۲. **تست دستی با curl** (بدون امضا):

```bash
curl -X POST https://crm.example.ir/api/callcenter/events \
  -H 'Content-Type: application/json' -H 'X-Event: call.started' \
  -d '{"event":"call.started","eventId":"11111111-2222-3333-4444-555555555555","callId":"test","seq":1,"occurredAt":"2026-10-31T07:20:10.000Z","test":true,"data":{"direction":"inbound","phone":"09121234567","callerNumber":"09121234567","calledNumber":"02112345678","patientName":null,"isCallback":false}}'
```

۳. **تماس واقعی:** بعد از روشن شدن ارسال در پنل، یک تماس واقعی بگیرید و در جدول خودتان ببینید همه‌ی رویدادهای آن تماس با یک `callId` و `seq` پشت سر هم رسیده‌اند.

---

## ۹. چک‌لیست تحویل

- [ ] آدرس HTTPS عمومی که از سرور مرکز تماس در دسترس باشد
- [ ] جواب `2xx` در کمتر از چند ثانیه؛ پردازش سنگین در پس‌زمینه
- [ ] ذخیره با `eventId` یکتا؛ تکراری‌ها بی‌خطا با `200` جواب بگیرند
- [ ] رویداد ناشناخته باعث خطا نشود (با `200` جواب بدهید)
- [ ] اگر توکن یا رمز امضا توافق شده: بررسی هدرها و رد درخواست نامعتبر با `401`
- [ ] مرتب‌سازی رویدادهای هر تماس با `seq`؛ نهایی کردن تماس با `call.ended`
- [ ] تست با دکمه‌ی «ارسال تست» برای همه‌ی رویدادهای موردنیاز

**اطلاعاتی که باید با مسئول مرکز تماس هماهنگ شود:** آدرس endpoint، توکن و نام هدرش (اگر لازم است)، رمز امضا (اگر لازم است)، و فهرست رویدادهایی که می‌خواهید.

---

## ۱۰. پیاده‌سازی کامل در Laravel (۱۱ یا ۱۲)

این بخش برای کسی است که می‌خواهد گیرنده را در یک پروژه‌ی Laravel بسازد. اگر این بخش را به یک برنامه‌نویس یا دستیار هوش مصنوعی بدهید، باید بتواند همه را بدون سؤال پیاده کند. ساختار:

- **ورودی:** `POST /api/callcenter/events`، بررسی توکن و امضا، ذخیره‌ی خام با `eventId` یکتا، پاسخ فوری `200`.
- **پردازش در صف:** job `ProcessCallCenterEvent` وضعیت هر تماس را در `callcenter_calls` و هر بار ورود به نوبت‌دهی را در `callcenter_bookings` به‌روز می‌کند.
- **همه‌چیز idempotent است:** رسیدن تکراری یا دیرتر یک رویداد، داده را خراب نمی‌کند.

### ۱۰.۱ تنظیمات

`.env`:

```dotenv
CALLCENTER_WEBHOOK_TOKEN=Bearer change-me-long-random      # همان «توکن» در پنل؛ خالی = بدون توکن
CALLCENTER_WEBHOOK_HEADER=Authorization                     # همان «نام هدر» در پنل
CALLCENTER_WEBHOOK_SECRET=                                  # همان «رمز امضا» در پنل؛ خالی = بدون امضا
QUEUE_CONNECTION=database
```

`config/services.php`:

```php
'callcenter' => [
    'webhook_token'  => env('CALLCENTER_WEBHOOK_TOKEN'),
    'webhook_header' => env('CALLCENTER_WEBHOOK_HEADER', 'Authorization'),
    'webhook_secret' => env('CALLCENTER_WEBHOOK_SECRET'),
    'max_skew'       => 300, // ثانیه؛ رد درخواست‌هایی که X-Timestamp آن‌ها بیش از این با ساعت سرور فاصله دارد
],
```

### ۱۰.۲ مسیر

Laravel ۱۱ و ۱۲ به‌طور پیش‌فرض `routes/api.php` ندارند. یک بار `php artisan install:api` بزنید. مسیرهای `api` CSRF ندارند.

```php
// routes/api.php
use App\Http\Controllers\CallCenterWebhookController;

Route::post('/callcenter/events', CallCenterWebhookController::class)
    ->middleware('throttle:600,1')
    ->name('callcenter.events');
```

اگر مسیر را در `routes/web.php` می‌گذارید، باید از CSRF مستثنا شود (`bootstrap/app.php` → `$middleware->validateCsrfTokens(except: ['callcenter/events'])`).

### ۱۰.۳ جدول‌ها (migration)

```php
// database/migrations/2026_11_06_000001_create_callcenter_tables.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // هر رویداد، خام و یک بار
        Schema::create('callcenter_events', function (Blueprint $t) {
            $t->id();
            $t->uuid('event_id')->unique();
            $t->string('call_id', 40)->index();
            $t->unsignedInteger('seq');
            $t->string('event', 40)->index();
            $t->timestamp('occurred_at', 3);
            $t->string('phone', 20)->nullable()->index();
            $t->boolean('is_test')->default(false);
            $t->json('payload');
            $t->timestamp('processed_at')->nullable();
            $t->timestamps();
            $t->index(['call_id', 'seq']);
        });

        // یک ردیف برای هر تماس: وضعیت لحظه‌ای و خلاصه‌ی نهایی
        Schema::create('callcenter_calls', function (Blueprint $t) {
            $t->id();
            $t->string('call_id', 40)->unique();
            $t->string('direction', 10)->nullable();          // inbound | outbound
            $t->string('phone', 20)->nullable()->index();
            $t->string('called_number', 20)->nullable();
            $t->string('patient_name')->nullable();
            $t->string('state', 20)->default('started');       // started, ivr, queued, ringing, talking, booking, ended
            $t->string('status', 20)->nullable();              // answered | missed | voicemail | transferred (پس از call.ended)
            $t->string('queue')->nullable();
            $t->string('operator_ext', 10)->nullable();
            $t->string('operator_name')->nullable();
            $t->json('ivr_path')->nullable();                  // [{menu, key, label, at}]
            $t->unsignedInteger('wait_seconds')->nullable();
            $t->unsignedInteger('talk_seconds')->nullable();
            $t->boolean('has_recording')->default(false);
            $t->decimal('survey_score', 3, 1)->nullable();
            $t->json('survey')->nullable();
            $t->boolean('is_callback')->default(false);
            $t->timestamp('started_at', 3)->nullable();
            $t->timestamp('ended_at', 3)->nullable();
            $t->unsignedInteger('last_seq')->default(0);       // بالاترین seq پردازش‌شده
            $t->json('summary')->nullable();                   // data کامل call.ended
            $t->timestamps();
        });

        // یک ردیف برای هر بار ورود به نوبت‌دهی (یک تماس می‌تواند چند بار وارد شود)
        Schema::create('callcenter_bookings', function (Blueprint $t) {
            $t->id();
            $t->string('call_id', 40)->index();
            $t->unsignedInteger('entered_seq');                // seq رویداد booking.entered
            $t->string('flow', 20);                            // book | mata | follow | remind | cancelnotice
            $t->string('phone', 20)->nullable()->index();
            $t->string('mobile', 20)->nullable()->index();
            $t->string('result', 20)->nullable();              // پس از booking.ended
            $t->string('result_label')->nullable();
            $t->string('code', 20)->nullable()->index();       // کد پیگیری
            $t->timestamp('slot_at')->nullable();              // زمان نوبت
            $t->string('slot_date', 10)->nullable();           // شمسی
            $t->string('slot_time', 5)->nullable();
            $t->string('doctor')->nullable();
            $t->string('national_code_masked', 12)->nullable();
            $t->unsignedSmallInteger('offered_times')->default(0);
            $t->unsignedTinyInteger('survey_score')->nullable();
            $t->string('error', 500)->nullable();
            $t->json('steps')->nullable();                     // [{step, stepLabel, key, value, elapsedMs, ...}]
            $t->string('last_step', 30)->nullable();
            $t->timestamp('entered_at', 3)->nullable();
            $t->timestamp('ended_at', 3)->nullable();
            $t->timestamps();
            $t->unique(['call_id', 'entered_seq']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('callcenter_bookings');
        Schema::dropIfExists('callcenter_calls');
        Schema::dropIfExists('callcenter_events');
    }
};
```

برای جدول صف: `php artisan make:queue-table` (اگر نیست) و بعد `php artisan migrate`.

### ۱۰.۴ مدل‌ها

```php
// app/Models/CallCenterEvent.php
namespace App\Models;
use Illuminate\Database\Eloquent\Model;

class CallCenterEvent extends Model
{
    protected $table = 'callcenter_events';
    protected $guarded = [];
    protected $casts = ['payload' => 'array', 'occurred_at' => 'datetime', 'processed_at' => 'datetime', 'is_test' => 'bool'];
}

// app/Models/CallCenterCall.php
class CallCenterCall extends Model
{
    protected $table = 'callcenter_calls';
    protected $guarded = [];
    protected $casts = ['ivr_path' => 'array', 'survey' => 'array', 'summary' => 'array', 'has_recording' => 'bool',
        'is_callback' => 'bool', 'started_at' => 'datetime', 'ended_at' => 'datetime'];

    public function bookings() { return $this->hasMany(CallCenterBooking::class, 'call_id', 'call_id'); }
}

// app/Models/CallCenterBooking.php
class CallCenterBooking extends Model
{
    protected $table = 'callcenter_bookings';
    protected $guarded = [];
    protected $casts = ['steps' => 'array', 'slot_at' => 'datetime', 'entered_at' => 'datetime', 'ended_at' => 'datetime'];
}
```

### ۱۰.۵ کنترلر: بررسی، ذخیره، پاسخ فوری

```php
// app/Http/Controllers/CallCenterWebhookController.php
namespace App\Http\Controllers;

use App\Jobs\ProcessCallCenterEvent;
use App\Models\CallCenterEvent;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

class CallCenterWebhookController extends Controller
{
    public function __invoke(Request $request)
    {
        $cfg = config('services.callcenter');
        $raw = $request->getContent();                       // بدنه‌ی خام؛ برای امضا لازم است

        // ۱) توکن (اگر تعریف شده)
        if (! empty($cfg['webhook_token'])) {
            $got = (string) $request->header($cfg['webhook_header'] ?: 'Authorization');
            if (! hash_equals($cfg['webhook_token'], $got)) {
                return response('unauthorized', 401);
            }
        }

        // ۲) امضا (اگر تعریف شده): sha256=HMAC(secret, timestamp + "." + rawBody)
        if (! empty($cfg['webhook_secret'])) {
            $ts  = (string) $request->header('X-Timestamp');
            $sig = (string) $request->header('X-Signature');
            $expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $raw, $cfg['webhook_secret']);
            if (! ctype_digit($ts) || abs(time() - (int) $ts) > $cfg['max_skew'] || ! hash_equals($expected, $sig)) {
                return response('invalid signature', 401);
            }
        }

        // ۳) قالب
        $e = json_decode($raw, true);
        if (! is_array($e) || empty($e['eventId']) || empty($e['event']) || ! isset($e['callId'], $e['seq'])) {
            return response('bad payload', 422);
        }

        // ۴) ذخیره‌ی یک‌باره (eventId یکتا). تکراری = قبلاً گرفته‌ایم؛ باز هم 200
        try {
            $row = CallCenterEvent::create([
                'event_id'    => $e['eventId'],
                'call_id'     => (string) $e['callId'],
                'seq'         => (int) $e['seq'],
                'event'       => $e['event'],
                'occurred_at' => Carbon::parse($e['occurredAt'] ?? 'now'),
                'phone'       => $e['data']['phone'] ?? null,
                'is_test'     => (bool) ($e['test'] ?? false),
                'payload'     => $e,
            ]);
            ProcessCallCenterEvent::dispatch($row->id);
        } catch (UniqueConstraintViolationException) {
            // duplicate delivery
        }

        return response('ok', 200);                          // سریع؛ کار اصلی در صف
    }
}
```

### ۱۰.۶ پردازش در صف

```php
// app/Jobs/ProcessCallCenterEvent.php
namespace App\Jobs;

use App\Models\CallCenterBooking;
use App\Models\CallCenterCall;
use App\Models\CallCenterEvent;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

class ProcessCallCenterEvent implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 5;
    public array $backoff = [5, 30, 120];

    public function __construct(public int $eventRowId) {}

    public function handle(): void
    {
        $ev = CallCenterEvent::find($this->eventRowId);
        if (! $ev || $ev->processed_at || $ev->is_test) {
            $ev?->update(['processed_at' => now()]);
            return;
        }
        $e = $ev->payload;
        $d = $e['data'] ?? [];
        $at = Carbon::parse($e['occurredAt']);

        // رویدادهای یک تماس یکی‌یکی (دو worker هم‌زمان روی یک تماس ننویسند)
        Cache::lock('callcenter-call-' . $e['callId'], 30)->block(20, function () use ($ev, $e, $d, $at) {
            DB::transaction(function () use ($ev, $e, $d, $at) {
                str_starts_with($e['event'], 'booking.') ? $this->booking($e, $d, $at) : $this->call($e, $d, $at);
                $ev->update(['processed_at' => now()]);
            });
        });
    }

    /** call.* و survey.* و voicemail.* */
    private function call(array $e, array $d, Carbon $at): void
    {
        $c = CallCenterCall::firstOrNew(['call_id' => $e['callId']]);
        $newer = $e['seq'] >= $c->last_seq;   // رویداد دیررسیده نباید «وضعیت لحظه‌ای» جدیدتر را عقب ببرد
        $set = fn (string $state) => $newer && $c->state !== 'ended' ? $c->state = $state : null;

        switch ($e['event']) {
            case 'call.started':
                $c->fill([
                    'direction' => $d['direction'] ?? null, 'phone' => $d['phone'] ?? null,
                    'called_number' => $d['calledNumber'] ?? null, 'patient_name' => $d['patientName'] ?? null,
                    'is_callback' => (bool) ($d['isCallback'] ?? false), 'started_at' => $c->started_at ?? $at,
                ]);
                $set('started');
                break;
            case 'call.ivr':
                $path = $c->ivr_path ?? [];
                $path[] = ['menu' => $d['menu'] ?? null, 'key' => $d['key'] ?? null, 'label' => $d['label'] ?? null, 'at' => $at->toIso8601String()];
                $c->ivr_path = $path;
                $set('ivr');
                break;
            case 'call.queued':
                if ($newer) $c->queue = $d['queue'] ?? $c->queue;
                $set('queued');
                break;
            case 'call.ringing':
                $set('ringing');
                break;
            case 'call.answered':
                if ($newer) $c->fill(['operator_ext' => $d['extension'] ?? null, 'operator_name' => $d['operator'] ?? null]);
                $set('talking');
                break;
            case 'call.transferred':
                if ($newer && isset($d['to']['extension'])) $c->fill(['operator_ext' => $d['to']['extension'], 'operator_name' => $d['to']['name'] ?? null]);
                break;
            case 'survey.completed':
                $c->fill(['survey_score' => $d['score'] ?? null]);
                break;
            case 'call.ended':
                // خلاصه‌ی کامل و نهایی؛ هر چیزی که جا افتاده بود را پر می‌کند
                $c->fill([
                    'direction' => $d['direction'] ?? $c->direction, 'phone' => $d['phone'] ?? $c->phone,
                    'called_number' => $d['calledNumber'] ?? $c->called_number, 'patient_name' => $d['patientName'] ?? $c->patient_name,
                    'state' => 'ended', 'status' => $d['status'] ?? null, 'queue' => $d['queue'] ?? $c->queue,
                    'operator_ext' => $d['operator']['extension'] ?? $c->operator_ext, 'operator_name' => $d['operator']['name'] ?? $c->operator_name,
                    'wait_seconds' => $d['waitSeconds'] ?? null, 'talk_seconds' => $d['talkSeconds'] ?? null,
                    'has_recording' => (bool) ($d['hasRecording'] ?? false), 'survey' => $d['survey'] ?? null,
                    'survey_score' => $d['survey']['score'] ?? $c->survey_score, 'is_callback' => (bool) ($d['isCallback'] ?? false),
                    'started_at' => isset($d['startedAt']) ? Carbon::parse($d['startedAt']) : $c->started_at,
                    'ended_at' => isset($d['endedAt']) ? Carbon::parse($d['endedAt']) : $at, 'summary' => $d,
                ]);
                break;
            // voicemail.left, survey.started و رویدادهای ناشناخته: فقط در callcenter_events می‌مانند
        }
        $c->last_seq = max($c->last_seq, (int) $e['seq']);
        $c->save();
    }

    /** booking.* */
    private function booking(array $e, array $d, Carbon $at): void
    {
        $callId = $e['callId'];

        if ($e['event'] === 'booking.entered') {
            CallCenterBooking::firstOrCreate(
                ['call_id' => $callId, 'entered_seq' => $e['seq']],
                ['flow' => $d['flow'] ?? 'book', 'phone' => $d['phone'] ?? null, 'entered_at' => $at,
                 'code' => $d['appointment']['code'] ?? null,
                 'slot_at' => isset($d['appointment']['slotAt']) ? Carbon::parse($d['appointment']['slotAt']) : null],
            );
            // تماس‌های یادآوری (callId با B) ردیف call ندارند؛ تماس‌های واقعی به حالت «در نوبت‌دهی» می‌روند
            if (str_starts_with($callId, 'C')) {
                CallCenterCall::where('call_id', $callId)->where('state', '!=', 'ended')->update(['state' => 'booking']);
            }
            return;
        }

        // رویداد مال آخرین ورود به نوبت‌دهی قبل از خودش است
        $b = CallCenterBooking::where('call_id', $callId)->where('entered_seq', '<', $e['seq'])->orderByDesc('entered_seq')->first();
        if (! $b) {
            // booking.entered هنوز نرسیده یا جا افتاده: یک ردیف بساز تا چیزی گم نشود
            $b = CallCenterBooking::create(['call_id' => $callId, 'entered_seq' => max(0, $e['seq'] - 1), 'flow' => $d['flow'] ?? 'book', 'entered_at' => $at]);
        }

        switch ($e['event']) {
            case 'booking.step':
                $steps = $b->steps ?? [];
                // همان مرحله با همان elapsedMs دو بار نیاید (ارسال تکراری)
                if (! collect($steps)->contains(fn ($s) => ($s['step'] ?? null) === $d['step'] && ($s['elapsedMs'] ?? null) === ($d['elapsedMs'] ?? null))) {
                    $steps[] = collect($d)->except(['flow', 'flowLabel'])->all();
                    usort($steps, fn ($x, $y) => ($x['elapsedMs'] ?? 0) <=> ($y['elapsedMs'] ?? 0));
                }
                $b->fill(['steps' => $steps, 'last_step' => $d['step'], 'flow' => $d['flow'] ?? $b->flow]);
                if (($d['step'] ?? '') === 'chooseTime') $b->offered_times = max($b->offered_times, count(array_filter($steps, fn ($s) => $s['step'] === 'chooseTime')));
                if (($d['step'] ?? '') === 'mobile') $b->mobile = $d['value'] ?? $b->mobile;
                break;
            case 'booking.booked':
            case 'booking.cancelled':
                $b->fill([
                    'mobile' => $d['mobile'] ?? $b->mobile, 'code' => $d['code'] ?? $b->code,
                    'slot_at' => isset($d['slotAt']) ? Carbon::parse($d['slotAt']) : $b->slot_at,
                    'slot_date' => $d['date'] ?? $b->slot_date, 'slot_time' => $d['time'] ?? $b->slot_time,
                    'doctor' => $d['doctor'] ?? $b->doctor, 'national_code_masked' => $d['nationalCodeMasked'] ?? $b->national_code_masked,
                ]);
                break;
            case 'booking.ended':
                // نتیجه‌ی نهایی با همه‌ی مراحل؛ جاافتاده‌ها پر می‌شوند
                $b->fill([
                    'flow' => $d['flow'] ?? $b->flow, 'result' => $d['result'] ?? null, 'result_label' => $d['resultLabel'] ?? null,
                    'phone' => $d['phone'] ?? $b->phone, 'mobile' => $d['mobile'] ?? $b->mobile, 'code' => $d['code'] ?? $b->code,
                    'slot_at' => isset($d['slotAt']) ? Carbon::parse($d['slotAt']) : $b->slot_at,
                    'slot_date' => $d['date'] ?? $b->slot_date, 'slot_time' => $d['time'] ?? $b->slot_time, 'doctor' => $d['doctor'] ?? $b->doctor,
                    'national_code_masked' => $d['nationalCodeMasked'] ?? $b->national_code_masked,
                    'offered_times' => $d['offeredTimes'] ?? $b->offered_times, 'survey_score' => $d['surveyScore'] ?? null,
                    'error' => isset($d['error']) ? mb_substr($d['error'], 0, 500) : null,
                    'steps' => $d['steps'] ?? $b->steps, 'ended_at' => $at,
                ]);
                break;
        }
        $b->save();
    }
}
```

اجرای صف در production (مثلاً با supervisor):

```bash
php artisan queue:work --queue=default --tries=5 --backoff=5
```

> `Cache::lock` به درایور cacheی نیاز دارد که قفل را پشتیبانی کند: `database`، `redis` یا `memcached`. با `file` روی یک سرور هم کار می‌کند.

### ۱۰.۷ نمایش زنده (اختیاری)

اگر صفحه‌ای دارید که باید همان لحظه نشان دهد چه کسی زنگ می‌زند، کجای منو یا نوبت‌دهی است و با کدام اپراتور حرف می‌زند، در پایان `handle()` یک event broadcast کنید (Laravel Reverb یا Pusher) و در صفحه گوش بدهید. مثلاً `CallCenterCallUpdated` با `call_id`، `state`، `phone` و `last_step`.

### ۱۰.۸ تست خودکار

```php
// tests/Feature/CallCenterWebhookTest.php
use App\Models\CallCenterBooking;
use App\Models\CallCenterCall;
use Illuminate\Support\Str;

function hook(array $body, ?string $secret = null) {
    $raw = json_encode($body, JSON_UNESCAPED_UNICODE);
    $headers = ['Content-Type' => 'application/json', 'X-Event' => $body['event']];
    if ($secret) { $ts = (string) time(); $headers['X-Timestamp'] = $ts; $headers['X-Signature'] = 'sha256=' . hash_hmac('sha256', $ts . '.' . $raw, $secret); }
    return test()->call('POST', '/api/callcenter/events', [], [], [], collect($headers)->mapWithKeys(fn ($v, $k) => ['HTTP_' . strtoupper(str_replace('-', '_', $k)) => $v])->all(), $raw);
}
function ev(string $event, int $seq, array $data, string $callId = 'C1793952700.33') {
    return ['event' => $event, 'eventId' => (string) Str::uuid(), 'callId' => $callId, 'seq' => $seq, 'occurredAt' => now()->toIso8601String(), 'data' => $data];
}

beforeEach(fn () => config(['services.callcenter.webhook_token' => null, 'services.callcenter.webhook_secret' => 'testsecret', 'queue.default' => 'sync']));

it('rejects a wrong signature', function () {
    $raw = json_encode(ev('call.started', 1, ['phone' => '09121234567']));
    $this->call('POST', '/api/callcenter/events', [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_X_TIMESTAMP' => time(), 'HTTP_X_SIGNATURE' => 'sha256=bad'], $raw)->assertStatus(401);
});

it('follows a call through booking to the end', function () {
    hook(ev('call.started', 1, ['direction' => 'inbound', 'phone' => '09121234567', 'calledNumber' => '982191090022']), 'testsecret')->assertOk();
    hook(ev('call.ivr', 2, ['menu' => 'منوی اصلی', 'key' => '2', 'label' => 'نوبت جدید']), 'testsecret')->assertOk();
    hook(ev('booking.entered', 3, ['flow' => 'book', 'flowLabel' => 'ثبت نوبت', 'phone' => '09121234567']), 'testsecret')->assertOk();
    hook(ev('booking.step', 4, ['flow' => 'book', 'step' => 'chooseTime', 'stepLabel' => 'پیشنهاد زمان نوبت', 'key' => '1', 'value' => '1794216600', 'elapsedMs' => 21400, 'accepted' => true]), 'testsecret')->assertOk();
    hook(ev('booking.booked', 5, ['phone' => '09121234567', 'mobile' => '09121234567', 'code' => '85504499', 'slotAt' => '2026-11-09T07:00:00Z', 'date' => '1405/08/18', 'time' => '10:30']), 'testsecret')->assertOk();
    hook(ev('booking.ended', 6, ['flow' => 'book', 'result' => 'booked', 'resultLabel' => 'نوبت گرفت', 'code' => '85504499', 'offeredTimes' => 1, 'steps' => []]), 'testsecret')->assertOk();
    hook(ev('call.ended', 7, ['direction' => 'inbound', 'status' => 'answered', 'phone' => '09121234567', 'waitSeconds' => 3, 'talkSeconds' => 0]), 'testsecret')->assertOk();

    expect(CallCenterCall::firstWhere('call_id', 'C1793952700.33'))->state->toBe('ended')->status->toBe('answered');
    expect(CallCenterBooking::firstWhere('call_id', 'C1793952700.33'))->result->toBe('booked')->code->toBe('85504499')->slot_time->toBe('10:30');
});

it('ignores a duplicate delivery', function () {
    $e = ev('call.started', 1, ['phone' => '09120000000']);
    hook($e, 'testsecret')->assertOk();
    hook($e, 'testsecret')->assertOk();
    expect(\App\Models\CallCenterEvent::where('event_id', $e['eventId'])->count())->toBe(1);
});
```

### ۱۰.۹ وصل کردن به پنل مرکز تماس

۱. **آماده کردن endpoint:** پروژه را روی آدرس HTTPS عمومی بالا بیاورید. آدرس: `https://<دامنه>/api/callcenter/events`.
۲. **تنظیم در پنل:** در پنل مرکز تماس، در صفحه‌ی «ارسال رویدادهای تماس (API)»:
   - **آدرس:** همان آدرس بالا.
   - **نام هدر و توکن:** همان مقادیر `CALLCENTER_WEBHOOK_HEADER` و `CALLCENTER_WEBHOOK_TOKEN`.
   - **رمز امضا:** دکمه‌ی «ساختن رمز تصادفی» را بزنید و همان را در `CALLCENTER_WEBHOOK_SECRET` بگذارید.
   - **رویدادها:** تیک رویدادهای لازم را بزنید، از جمله پنج رویداد `booking.*`.
   - «فعال» را بزنید و ذخیره کنید.
۳. **ارسال تست:** روی هر رویداد «ارسال تست» را بزنید. باید `✓ … کد 200` ببینید. تست‌ها `test: true` دارند و در `callcenter_events` ذخیره می‌شوند، ولی job آن‌ها را روی جدول تماس‌ها اعمال نمی‌کند.
۴. **تماس واقعی:** با خط مطب تماس بگیرید، کلید ۲ (نوبت جدید) را بزنید و چند مرحله جلو بروید. در `callcenter_calls` و `callcenter_bookings` همه‌ی مراحل را ببینید.
۵. **گزارش ارسال‌ها:** اگر چیزی نرسید، «گزارش ارسال‌ها»ی همان صفحه‌ی پنل کد پاسخ و خطای سرور شما را نشان می‌دهد. با دکمه‌ی «ارسال دوباره» می‌شود همان رویداد را دوباره فرستاد.
