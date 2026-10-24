# Asterisk AI Receptionist

A realtime Persian telephone receptionist for an ENT clinic. Asterisk accepts
the SIP call and streams 8 kHz signed-linear audio over AudioSocket to a Python
bridge. The bridge can use either OpenAI Realtime or Gemini Live, answers safe
general rhinoplasty questions, verifies postoperative callers, and sends the
clinic application link by SMS for appointment requests.

## Features

- Selectable `openai` or `gemini` provider through one environment variable
- Natural Persian audio conversations with caller interruption support
- PJSIP inbound trunk and AudioSocket dialplan examples
- CRM-backed application-link SMS after explicit mobile confirmation
- Caller-requested handoff to a registered doctor extension
- Fail-open CRM caller-name lookup for personalized greetings
- Token-protected HTTP trigger for mobile-to-extension calls
- Unprivileged, hardened systemd service
- No call recordings or conversation transcripts retained
- Local unavailable-message fallback when the realtime provider fails

## Requirements

- Linux with Python 3.11 or newer
- Asterisk with PJSIP and AudioSocket support
- Python `websocket-client`
- An OpenAI API key or Gemini API key

## Installation outline

1. Copy `bridge.py` to `/opt/asterisk-ai/bridge.py` and make it executable.
2. Install `websocket-client` for the system Python.
3. Create an unprivileged `asterisk-ai` system user.
4. Copy `config/asterisk-ai.env.example` to
   `/etc/asterisk-ai/asterisk-ai.env`, set mode `0640`, and add one API key.
5. Customize and include the PJSIP and extensions examples in Asterisk.
6. Install `systemd/asterisk-ai.service`, reload systemd, and enable the service.
7. Generate the fallback audio with `bridge.py --generate-fallback`.

Never commit the real environment file, SIP password, API keys, appointment
database, or generated audio. The included `.gitignore` excludes these files.

## Personalized caller greeting

Before answering an external call, `caller_lookup.py` normalizes the Asterisk
caller ID and performs an HTTPS GET request using Basic Authentication. It
extracts the JSON `name` and surgery-status fields, sets the Asterisk
`CALLER_NAME` variable, and writes short-lived UUID-keyed metadata for the AI bridge. A non-empty name
produces a greeting such as `سلام علی، من دستیار دکتر افلاکی هستم، چه کمکی از من
برمیاد؟`; otherwise the normal clinic greeting is used.

Postoperative guidance is allowed only when CRM explicitly reports
`has_completed_surgery=true`. Otherwise, when the caller asks a postoperative
question, the assistant verifies whether the surgery was performed by Dr. Aflaki.
If so, it collects a 10-digit national code beginning with zero and sends it in
the JSON body of an authenticated POST request to
`CRM_NATIONAL_CODE_API_URL` immediately after all 10 digits arrive. It never repeats the
national code aloud or asks the caller to confirm it. National codes are never
persisted or logged.
When the lookup confirms surgery and returns a name, the assistant asks the caller
to confirm that returned name before continuing with postoperative help.
API failures remain unknown and do not activate this flow.

National codes may be spoken or entered with the phone keypad. AudioSocket DTMF
frames (`0x03`) are collected in memory for the active call and, after the tenth
digit, injected into the provider conversation as a keypad-entered national code.
No keypad digits are logged or persisted; `*` clears a partial entry.

For general or preoperative questions, the assistant gives brief general guidance
and asks whether the caller wants an appointment. It does not book a date or time.
After the caller accepts, supplies an Iranian mobile, and confirms a digit-by-digit
read-back, the bridge posts the mobile to `CRM_APPLICATION_LINK_API_URL`. Only a
successful response is described as an SMS being sent.

## Verified postoperative emergencies

Postoperative emergency escalation is available only after CRM has explicitly
confirmed completed surgery by Dr. Aflaki and, for national-code fallback, the
caller has confirmed the returned patient name. Emergency items include severe
or uncontrolled nasal bleeding, severe breathing difficulty, significant signs
of infection, loss of consciousness, confusion, blue lips, and similarly
dangerous deterioration. After the national code and returned patient name are
also confirmed, the bridge posts the caller's `mobile` and `national_code` to
`CRM_EMERGENCY_SMS_API_URL`; CRM-side configuration selects the support recipient
and message. The call is deduplicated to one emergency SMS per call.
Life-threatening symptoms are always directed to 115 or immediate emergency
care; a support callback is never presented as a replacement.

The lookup timeout is capped at three seconds and all network, HTTP, JSON, and
missing-name errors fail open to the normal greeting. Store the real endpoint
and credentials in `/etc/asterisk-ai/crm.env` with mode `0640`; never commit it.

## Authenticated outbound call API

`outbound_api.py` exposes `GET /v1/call?mobile=09xxxxxxxxx` on a configurable
LAN address. A valid `Authorization: Bearer ...` header is required. Accepted
requests originate the mobile leg through the configured SIP trunk; after the
mobile answers, Asterisk rings extension `1001` and bridges the two parties.

Only exact Iranian mobile numbers are accepted. The service blocks duplicate
numbers for 60 seconds, limits total requests per minute, never invokes a shell,
and does not log tokens or phone numbers. Put it behind HTTPS before exposing it
outside a trusted LAN. Public reachability also requires router/NAT forwarding.


## Provider selection

For OpenAI:

```ini
AI_PROVIDER=openai
OPENAI_API_KEY=replace-me
```

For Gemini:

```ini
AI_PROVIDER=gemini
GEMINI_API_KEY=replace-me
```

Gemini availability depends on Google's supported regions. If its WebSocket
endpoint returns HTTP 403, use a supported deployment region or select OpenAI.

## Validation

```sh
python3 -m unittest -v test_bridge.py
python3 bridge.py --check
python3 smoke_call.py
```

The smoke call expects the service to be listening on `127.0.0.1:9019`.

## Zoiper test extension

The examples include a restricted PJSIP endpoint for extension `1001`. It can
dial `600` or `5000` to reach the AI receptionist, or `6000` for an Asterisk echo test.
It cannot place outbound trunk calls. Copy both Zoiper example files into
`/etc/asterisk`, customize the transport and password, include them from
`pjsip.conf` and `extensions.conf`, then reload PJSIP and the dialplan.

The optional outbound pattern in the dialplan example accepts only Iranian
mobile numbers in the exact `09xxxxxxxxx` format. Customize the trunk endpoint
and caller ID before enabling it. It limits the extension to one concurrent
outbound call and a maximum call duration of 30 minutes.

## Doctor transfer

When a caller explicitly asks to speak directly with the doctor, the realtime
model calls `transfer_to_doctor`. The bridge creates a short-lived marker for
that AudioSocket call and ends the AI session after a brief hold message. The
Asterisk dialplan runs AudioSocket on an isolated Local channel, then the
original caller channel consumes the marker and dials the configured doctor
PJSIP extension. The transfer directory must be writable by the bridge service and
readable/removable by Asterisk; a setgid directory owned by the shared Asterisk
group is recommended.

The example rings the doctor extension for 10 seconds. If it is busy,
unavailable, congested, or unanswered, Asterisk sends the call to a configured
mobile number through the authenticated SIP trunk. Replace all mobile, caller-ID,
and trunk placeholders before enabling this route.

## Medical and privacy boundary

The prompt limits the receptionist to rhinoplasty information. It does not
diagnose, prescribe, interpret test results, or claim that an application-link
SMS was sent before the CRM call succeeds. Postoperative answers require verified
completed surgery by Dr. Aflaki; emergency symptoms are always directed to
immediate medical care.
