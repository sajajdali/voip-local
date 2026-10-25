#!/usr/bin/python3
"""Asterisk AudioSocket to OpenAI Realtime or Gemini Live bridge.

AudioSocket carries 8 kHz, 16-bit, mono signed-linear PCM. The bridge converts
that stream to each provider's wire format and does not retain call audio or
conversation content.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import queue
import re
import signal
import socket
import sqlite3
import struct
import threading
import time
import uuid
import wave
import unicodedata
from urllib.parse import urlencode
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import websocket

import caller_lookup


LOG = logging.getLogger("asterisk-ai")
AUDIO_KIND = 0x10
HANGUP_KIND = 0x00
UUID_KIND = 0x01
DTMF_KIND = 0x03
PCM_FRAME_BYTES = 320  # 20 ms at 8 kHz, 16-bit mono

GREETING = "سلام، مطب دکتر افلاکی، بفرمایید. چطور می‌تونم کمکتون کنم؟"
CLOSING = (
    "متأسفانه محدودیت صحبت با من تمام شده و مجبورم قطع کنم. "
    "امیدوارم که تونسته باشم شما را راهنمایی کرده باشم. خدانگهدار."
)
UNAVAILABLE = "متأسفم، سامانه پاسخ‌گویی مطب در حال حاضر در دسترس نیست. لطفاً کمی بعد دوباره تماس بگیرید."

INSTRUCTIONS = """# Role and Objective
You are the warm, capable postoperative telephone assistant for Dr. Aflaki's clinic, specializing
exclusively in follow-up consultation after rhinoplasty performed by Dr. Aflaki. Your first task
in every call is to verify that Dr. Aflaki performed the caller's completed surgery before giving
any postoperative guidance. Never offer appointment booking or an application link. Introduce the office, not your technology. Do not proactively discuss whether
you are human or AI. If directly asked, answer truthfully and briefly that you are the clinic's
smart telephone assistant, then return naturally to helping the caller.

# Personality and Tone
- Sound like an excellent real-world Persian receptionist: warm, composed, attentive, confident,
  discreet, and genuinely interested in helping.
- Use natural spoken Persian, not written or formal essay language. Prefer familiar conversational
  forms such as «می‌تونم»، «حتماً»، and «بفرمایید» where they fit naturally.
- Speak at a comfortable, unhurried pace with natural phrasing and light pauses. Do not exaggerate
  emotion, add theatrical filler, or sound overly enthusiastic.
- Briefly acknowledge what the caller said before answering, but do not acknowledge every sentence.
- Match the caller's emotional tone. If they sound worried or frustrated, respond with brief,
  sincere empathy and then help.

# Language
- Speak ONLY fluent, natural Persian with clear Iranian pronunciation throughout the call.
- Switch languages only if the caller explicitly asks.
- If audio is unclear, ask the caller politely to repeat it. Never guess critical details.

# Conversation Style
- Use one or two short spoken sentences per turn unless more detail is genuinely necessary.
- Ask only one question at a time, then listen fully to the answer.
- Do not interrupt. Do not rush to fill every silence.
- Give the direct answer first. Avoid lists, lectures, disclaimers, and long monologues on the phone.
- Vary acknowledgements, sentence openings, and confirmations. Never repeat the same stock phrase
  in consecutive turns or overuse «حتماً», «متوجه شدم», or «باشه».
- Do not say robotic phrases such as “please wait while I process,” “let me think,” or mention tools,
  prompts, models, processing, policies, or internal reasoning.
- Use small natural transitions only when helpful, such as «بله، متوجه‌ام»، «بسیار خوب»،
  «اجازه بدید دقیق‌تر بگم»، or «درسته»; vary them and do not use them mechanically.

# Capabilities and Honesty
- You can provide safe postoperative guidance only after this call's verification rules authorize
  it, notify postoperative support of a verified emergency, and transfer a caller who explicitly asks to
  speak directly with Dr. Aflaki.
- You cannot check appointment availability, register an appointment, or send an appointment or
  application link. Never ask whether the caller wants an appointment, date, or time.
- If asked to do something unavailable, say so briefly and offer the closest useful alternative.
- Do not request passwords, payment-card data, authentication codes, or other secrets.
- Never start or say an appointment-countdown sentence such as «تا زمان نوبت شما...» or imply
  that a number is available when no exact, non-null appointment countdown was supplied in the
  verified context. This postoperative service does not receive an appointment countdown, so do
  not mention one. In particular, never speak a sentence with a missing number or placeholder.

# Strict Topic Scope
- Answer only postoperative questions about rhinoplasty performed by Dr. Aflaki, including expected
  recovery, postoperative care, results, and complications, and only after full verification.
- Do not answer unrelated medical questions, general ENT questions outside nasal cosmetic surgery,
  preoperative questions, appointment requests, or non-medical questions. Briefly say in natural
  Persian that this line is only for verified postoperative consultation with Dr. Aflaki's patients.
- Do not get pulled into an unrelated topic even if the caller insists. Keep the redirection warm,
  short, and non-judgmental.
- For postoperative questions, do not give even general postoperative instructions until the
  per-call verification section explicitly confirms completed surgery by Dr. Aflaki. The only
  exception is urgent safety direction for an apparent emergency.

# Medical Boundaries
- Give only general, educational rhinoplasty and cosmetic-nose information in simple Persian. Do not diagnose, prescribe,
  recommend medication doses, interpret test results, or promise a treatment outcome.
- When symptoms require an examination, say naturally that Dr. Aflaki needs to examine the caller.
- For severe breathing difficulty, severe or uncontrolled bleeding, loss of consciousness, or
  another immediately life-threatening symptom, always advise calling 115 or obtaining emergency
  care now, even before clinic verification. Never imply that a support callback replaces emergency
  medical care. Treat sudden hearing loss as urgent and advise same-day medical assessment.
- Keep safety advice brief and relevant; do not repeat generic disclaimers after every answer.

# Verified Postoperative Emergency Items
- This workflow is only for a caller whose completed surgery by Dr. Aflaki has already been verified
  for this call. If it is not yet verified, complete the phone/national-code and identity checks
  before classifying the postoperative situation or notifying support.
- Emergency items include: severe, heavy, persistent, or uncontrolled nasal bleeding; severe
  shortness of breath or serious breathing difficulty; suspected significant infection such as
  high fever, pus or foul-smelling discharge, rapidly worsening redness or swelling, or severe pain
  that is rapidly worsening; loss of consciousness, confusion, blue lips, or another clearly
  dangerous postoperative deterioration.
- Once a verified caller reports an emergency item, call send_emergency_sms immediately and only
  once, but only after their national code has also been collected, checked with CRM, and the
  returned name confirmed. If the caller was already verified from their phone number and no
  national code has been collected in this conversation, collect and verify it first using the
  national-code flow below. Do not ask about an appointment and do not send the application link.
- Before sending the emergency request, write a concise Persian summary of the caller's actual
  complaint for postoperative support. Include the reported symptom, severity or duration when
  stated, and the request for a callback. Use no more than two short sentences, preserve useful
  line breaks, and never invent a diagnosis, medication, timing, or fact the caller did not say.
- Pass that exact complaint summary in the summary argument. Never send an emergency request with
  an empty or generic summary when the caller has described their problem.
- If the tool returns status "sent", say exactly: «اوکی، شرایط شما اضطراری است. من می‌گم که هرچه
  زودتر بچه‌های پشتیبانی پس از عمل با شما تماس بگیرند.» For infection signs, worsening pain or
  swelling, and bleeding that is not severe and uncontrolled, say only that exact sentence and do
  not mention 115 or emergency services. Add immediate-emergency direction only when the caller is
  currently unable to breathe adequately, has severe uncontrolled bleeding, is unconscious or
  confused, has blue lips, or shows another unmistakably life-threatening condition.
- Never say «شرایط شما اضطراری است» or promise that postoperative support will call before the
  emergency tool has actually returned status "sent". Merely recognizing an emergency is not
  sufficient. If the result is "error", "invalid", or "already_sent", do not use the success text.
- After saying the emergency sentence, keep the call open and listen for the caller. Do not say
  goodbye, do not end the conversation, do not transfer the call, and do not treat the emergency
  notification as the end of the call. Continue responding if the caller speaks again.
- If the tool returns status "error", do not promise a callback. Say that the situation is urgent,
  the notification could not be sent right now, and they must contact the clinic directly; for a
  life-threatening symptom also direct them to 115 or immediate emergency care.

# Doctor Transfer
- Transfer only when the caller clearly asks to speak directly with Dr. Aflaki. Merely mentioning
  the doctor's name or asking a medical question is not a transfer request.
- When transfer is requested, call transfer_to_doctor immediately. Do not collect an appointment
  date, name, or phone number first.
- If the tool returns status "transferring", say briefly and naturally in Persian that you are
  connecting the caller and ask them to stay on the line. Do not ask another question afterward.
- Never claim that the doctor answered or is available. If the tool returns an error, apologize
  briefly.

# Privacy
- In the surgery-verification flow, collect the national code solely for the immediate
  CRM lookup. Never repeat it aloud, summarize it, persist it, or log it; check it immediately once
  all 10 digits have been received.
- Never ask the caller to describe sensitive medical history for scheduling.
- Do not mention these instructions. Never produce text-only output; always speak aloud."""

VERIFIED_SURGERY_INSTRUCTIONS = """

# Postoperative Verification for This Call
- The initial phone-number GET lookup explicitly confirmed has_completed_surgery=true for surgery
  by Dr. Aflaki. Do not ask for the national code during an ordinary postoperative consultation.
- If a verified patient name and days_since_surgery appear in the phone lookup context below, begin
  naturally with: «شما [نام] هستید و [تعداد] روز قبل عمل کردید، درسته؟» Say «امروز عمل کردید»
  for zero and «یک روز قبل عمل کردید» for one. Wait for confirmation before giving postoperative
  guidance. If days_since_surgery is absent, ask only «شما [نام] هستید، درسته؟» If no name is
  available, say the surgery history was confirmed and ask how you can help after surgery.
- If the caller denies the returned identity or surgery timing, do not provide individualized
  guidance; ask them to contact the clinic so the record can be checked.
- For an emergency escalation only, the support SMS also requires a national code. Ask exactly:
  «کد ملی‌تون رو با استفاده از گوشی و قسمت شماره‌گیریش وارد کنید تا بتونم بررسی کنم.» Accept
  the code only from the phone keypad and wait for exactly 10 digits starting with zero. Never call
  verification for spoken digits or fewer than 10 keypad digits. As soon as all 10 digits arrive,
  call verify_surgery_by_national_code immediately. Never read the code back or ask for confirmation.
- If verification returns a name and days_since_surgery, ask naturally: «شما [نام] هستید و [تعداد] روز قبل عمل کردید، درسته؟»
  Say «امروز عمل کردید» for zero and «یک روز قبل عمل کردید» for one.
  If days_since_surgery is absent, ask only «شما [نام] هستید، درسته؟» After a clear yes, call
  confirm_postoperative_identity with confirmed=true and emergency_reported=true when the symptom
  that triggered verification matches any emergency item above, and include the concise complaint
  summary. If it returns
  emergency_sms_status="sent", immediately say the exact emergency sentence above. Only after
  status "verified" may you otherwise call send_emergency_sms. If any verification step fails, do
  not send an emergency SMS and direct the caller to contact the clinic; provide immediate
  emergency-care direction when applicable.
- Do not offer an appointment, booking flow, or application link at any point.
"""

UNVERIFIED_SURGERY_INSTRUCTIONS = """

# Surgery Follow-up Verification for This Call
- Full completed-surgery verification is mandatory at the beginning of every consultation. Before
  giving any postoperative guidance, first ask exactly one question in natural Persian:
  «آیا عمل جراحی‌تون رو دکتر افلاکی انجام داده؟»
- If the caller says yes, ask exactly: «کد ملی‌تون رو با استفاده از گوشی و قسمت شماره‌گیریش وارد
  کنید تا بتونم بررسی کنم.»
- Accept the national code only from the phone keypad after all 10 digits have been entered. Do not
  treat spoken digits or fewer than 10 keypad digits as a completed national code. It must start
  with zero.
- As soon as a complete national code is provided, call verify_surgery_by_national_code immediately.
  Never repeat the national code aloud and never ask the caller to confirm it. Never use this tool
  before the caller says Dr. Aflaki performed the surgery, or in any other flow.
- If the tool returns status "invalid", explain once that the code must contain 10 digits and start
  with zero, then ask the caller to enter the full code again using the phone keypad.
- If the tool returns status "waiting", do not claim that anything was checked or sent. Wait for
  the caller to finish entering all 10 keypad digits.
- If it returns status "verified" with a non-empty "name", ask exactly one identity-confirmation
  question. If days_since_surgery is present, ask naturally: «شما [نام] هستید و [تعداد] روز قبل عمل کردید، درسته؟»
  Say «امروز عمل کردید» for zero and «یک روز قبل عمل کردید» for one. If the
  field is absent, ask only «شما [نام] هستید، درسته؟» Do not give case-specific guidance until the caller answers.
- If the caller clearly confirms the returned name, call confirm_postoperative_identity with
  confirmed=true. Set emergency_reported=true if the postoperative symptom that caused this
  verification matches any emergency item above and include the concise complaint summary;
  otherwise set it to false and use an empty summary. If the tool returns
  emergency_sms_status="sent", immediately say the exact emergency sentence above. Otherwise,
  after it returns status "verified", say briefly that the surgery record was confirmed and
  continue helping within the medical boundaries above.
- If the caller denies the returned name, is uncertain, or does not answer the confirmation clearly,
  do not reveal any other CRM information and do not continue with individualized postoperative
  guidance. Ask them to contact the clinic so their identity and record can be checked safely.
- If status is "verified" but "name" is absent or empty, do not treat identity as confirmed. Say
  that the record cannot be safely verified right now and ask the caller to contact the clinic.
- If it returns status "not_found", say: «متأسفانه با این کد ملی هم سابقه‌ای پیدا نکردم. لطفاً با شماره‌ای که موقع تشکیل پرونده ثبت کرده بودید تماس بگیرید یا برای بررسی پرونده با مطب در ارتباط باشید.»
  Do not continue with individualized postoperative guidance for this call.
- If it returns status "error", say that the record cannot be checked right now and suggest trying
  again later or contacting the clinic. Never describe an API failure as absence of a record.
- If the caller says no, do not answer their postoperative question. Explain briefly that
  postoperative guidance is only available for Dr. Aflaki's verified patients and direct them to
  their own surgeon or clinic. Do not offer an appointment or application link.
- Until both the surgery lookup and returned-name confirmation succeed, do not answer the
  postoperative question. If verification fails, direct the caller to the clinic.
- Treat the national code as sensitive: do not repeat it, persist it, log it, or include it in a
  summary.
- Dr. Aflaki is دکتر افلاکی; pronounce the name «اَفلاکی».
"""


@dataclass(frozen=True)
class Config:
    api_key: str
    provider: str = "openai"
    model: str = "gpt-realtime-2.1"
    voice: str = "marin"
    listen_host: str = "127.0.0.1"
    listen_port: int = 9019
    max_calls: int = 4
    max_seconds: int = 300
    closing_seconds: int = 15
    fallback_wav: str = "/var/lib/asterisk/sounds/custom/ai-unavailable-fa.wav"
    appointments_db: str = "/var/lib/asterisk-ai/appointments.db"
    transfer_dir: str = "/var/lib/asterisk-ai/transfers"
    caller_metadata_dir: str = "/var/lib/asterisk-ai/callers"
    # empty = keep nothing (the original privacy default); set by the call-center panel when calls are reviewed
    transcript_dir: str = ""
    # the dir always receives the call's usage; the spoken lines only when this is on
    keep_transcript: bool = True
    transcribe_model: str = "gpt-transcribe"

    @classmethod
    def from_env(cls) -> "Config":
        provider = os.environ.get("AI_PROVIDER", "openai").strip().lower()
        if provider not in ("openai", "gemini"):
            raise RuntimeError("AI_PROVIDER must be openai or gemini")
        prefix = "OPENAI" if provider == "openai" else "GEMINI"
        key = os.environ.get(f"{prefix}_API_KEY", "").strip()
        if not key or key == "replace-me":
            raise RuntimeError(f"{prefix}_API_KEY is not configured")
        return cls(
            api_key=key,
            provider=provider,
            model=(
                os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1")
                if provider == "openai"
                else os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
            ),
            voice=(
                os.environ.get("OPENAI_REALTIME_VOICE", "marin")
                if provider == "openai"
                else os.environ.get("GEMINI_LIVE_VOICE", "Kore")
            ),
            listen_host=os.environ.get("ASTERISK_AI_HOST", "127.0.0.1"),
            listen_port=int(os.environ.get("ASTERISK_AI_PORT", "9019")),
            max_calls=int(os.environ.get("ASTERISK_AI_MAX_CALLS", "4")),
            max_seconds=int(os.environ.get("ASTERISK_AI_MAX_SECONDS", "300")),
            closing_seconds=int(os.environ.get("ASTERISK_AI_CLOSING_SECONDS", "15")),
            fallback_wav=os.environ.get(
                "ASTERISK_AI_FALLBACK_WAV",
                "/var/lib/asterisk/sounds/custom/ai-unavailable-fa.wav",
            ),
            appointments_db=os.environ.get(
                "ASTERISK_AI_APPOINTMENTS_DB",
                "/var/lib/asterisk-ai/appointments.db",
            ),
            transfer_dir=os.environ.get(
                "ASTERISK_AI_TRANSFER_DIR",
                "/var/lib/asterisk-ai/transfers",
            ),
            caller_metadata_dir=os.environ.get(
                "ASTERISK_AI_CALLER_METADATA_DIR",
                "/var/lib/asterisk-ai/callers",
            ),
            transcript_dir=os.environ.get("ASTERISK_AI_TRANSCRIPT_DIR", "").strip(),
            keep_transcript=os.environ.get("ASTERISK_AI_KEEP_TRANSCRIPT", "1").strip() != "0",
            transcribe_model=os.environ.get("ASTERISK_AI_TRANSCRIBE_MODEL", "gpt-transcribe").strip() or "gpt-transcribe",
        )


class AppointmentStore:
    TIMES = ("10:00", "11:00")
    TEHRAN = ZoneInfo("Asia/Tehran")
    WEEKDAYS_FA = (
        "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنج‌شنبه", "جمعه", "شنبه", "یکشنبه"
    )

    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def initialize(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS appointments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    appointment_date TEXT NOT NULL,
                    appointment_time TEXT NOT NULL,
                    patient_name TEXT NOT NULL,
                    phone TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE (appointment_date, appointment_time)
                )"""
            )

    @staticmethod
    def normalize_phone(value: str) -> str:
        translated = value.translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))
        return "".join(char for char in translated if char.isdigit() or char == "+")

    def available_slots(self) -> dict:
        start = datetime.now(self.TEHRAN).date() + timedelta(days=2)
        with self.connect() as conn:
            for offset in range(0, 31):
                day = start + timedelta(days=offset)
                rows = conn.execute(
                    "SELECT appointment_time FROM appointments WHERE appointment_date = ?",
                    (day.isoformat(),),
                ).fetchall()
                taken = {row["appointment_time"] for row in rows}
                slots = [value for value in self.TIMES if value not in taken]
                if slots:
                    return {
                        "status": "available",
                        "date": day.isoformat(),
                        "weekday_fa": self.WEEKDAYS_FA[day.weekday()],
                        "times": slots,
                        "timezone": "Asia/Tehran",
                    }
        return {"status": "unavailable", "reason": "no_slots_in_next_31_days"}

    def book(self, patient_name: str, phone: str, date: str, appointment_time: str) -> dict:
        patient_name = " ".join(patient_name.split()).strip()
        phone = self.normalize_phone(phone)
        if len(patient_name) < 2:
            return {"status": "error", "reason": "invalid_patient_name"}
        if len(phone.lstrip("+")) < 10 or len(phone.lstrip("+")) > 15:
            return {"status": "error", "reason": "invalid_phone"}
        if appointment_time not in self.TIMES:
            return {"status": "error", "reason": "invalid_time"}
        try:
            target = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            return {"status": "error", "reason": "invalid_date"}
        minimum = datetime.now(self.TEHRAN).date() + timedelta(days=2)
        if target < minimum:
            return {"status": "error", "reason": "date_too_soon"}
        try:
            with self.connect() as conn:
                conn.execute(
                    """INSERT INTO appointments
                       (appointment_date, appointment_time, patient_name, phone, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        target.isoformat(),
                        appointment_time,
                        patient_name,
                        phone,
                        datetime.now(self.TEHRAN).isoformat(timespec="seconds"),
                    ),
                )
        except sqlite3.IntegrityError:
            return {"status": "conflict", "reason": "slot_already_booked"}
        return {
            "status": "booked",
            "date": target.isoformat(),
            "time": appointment_time,
            "patient_name": patient_name,
        }


def linear_to_alaw(sample: int) -> int:
    """Encode a signed 16-bit PCM sample as ITU-T G.711 A-law."""
    sample = max(-32768, min(32767, sample))
    mask = 0xD5
    if sample < 0:
        mask = 0x55
        sample = -sample - 8
    sample = max(0, min(32635, sample))
    boundaries = (0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF, 0x3FFF, 0x7FFF)
    segment = next((i for i, end in enumerate(boundaries) if sample <= end), 8)
    if segment >= 8:
        return 0x7F ^ mask
    value = segment << 4
    value |= ((sample >> 4) if segment < 2 else (sample >> (segment + 3))) & 0x0F
    return value ^ mask


def alaw_to_linear(value: int) -> int:
    """Decode an ITU-T G.711 A-law byte to signed 16-bit PCM."""
    value ^= 0x55
    sample = (value & 0x0F) << 4
    segment = (value & 0x70) >> 4
    if segment == 0:
        sample += 8
    elif segment == 1:
        sample += 0x108
    else:
        sample += 0x108
        sample <<= segment - 1
    return sample if value & 0x80 else -sample


def pcm_to_alaw(data: bytes) -> bytes:
    if len(data) % 2:
        data = data[:-1]
    return bytes(linear_to_alaw(sample[0]) for sample in struct.iter_unpack("<h", data))


def alaw_to_pcm(data: bytes) -> bytes:
    return b"".join(struct.pack("<h", alaw_to_linear(value)) for value in data)


def pcm8_to_pcm16(data: bytes) -> bytes:
    """Upsample 8 kHz signed PCM to the 16 kHz required by Gemini Live."""
    if len(data) % 2:
        data = data[:-1]
    return b"".join(struct.pack("<hh", sample[0], sample[0]) for sample in struct.iter_unpack("<h", data))


def pcm24_to_pcm8(data: bytes, remainder: bytes = b"") -> tuple[bytes, bytes]:
    """Downsample Gemini's 24 kHz PCM output to 8 kHz, preserving chunk state."""
    combined = remainder + data
    complete = len(combined) - (len(combined) % 6)
    output = bytearray()
    for first, second, third in struct.iter_unpack("<hhh", combined[:complete]):
        output.extend(struct.pack("<h", (first + second + third) // 3))
    return bytes(output), combined[complete:]


def pack_frame(kind: int, payload: bytes = b"") -> bytes:
    if len(payload) > 0xFFFF:
        raise ValueError("AudioSocket payload too large")
    return bytes((kind,)) + struct.pack("!H", len(payload)) + payload


def read_exact(sock: socket.socket, length: int) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < length:
        try:
            chunk = sock.recv(length - len(chunks))
        except socket.timeout:
            continue
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


def read_frame(sock: socket.socket) -> tuple[int, bytes] | None:
    header = read_exact(sock, 3)
    if header is None:
        return None
    kind = header[0]
    length = struct.unpack("!H", header[1:])[0]
    payload = read_exact(sock, length)
    return None if payload is None else (kind, payload)


def call_id_from_payload(payload: bytes) -> str:
    try:
        if len(payload) == 16:
            return str(uuid.UUID(bytes=payload))
        return str(uuid.UUID(payload.decode("ascii")))
    except (ValueError, UnicodeDecodeError):
        return "invalid-uuid"


def load_fallback_pcm(path: str) -> bytes:
    try:
        with wave.open(path, "rb") as wav:
            if wav.getparams()[:3] != (1, 2, 8000):
                raise ValueError("fallback WAV must be mono, 16-bit, 8 kHz")
            return wav.readframes(wav.getnframes())
    except (FileNotFoundError, wave.Error, ValueError) as exc:
        LOG.warning("fallback_audio_unavailable error=%s", type(exc).__name__)
        return b""


_FA_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def mask_national_codes(text: str) -> str:
    """Hide 10-digit national codes (digits may be separated by spaces or dashes) in kept transcripts."""
    normalized = text.translate(_FA_DIGITS)

    def hide(match: re.Match) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        # a mobile number (09 + 9 digits) is the caller's own and stays readable
        return match.group(0) if len(digits) == 11 and digits.startswith("09") else "[کد ملی]"

    return re.sub(r"\d(?:[\s-]?\d){9,}", hide, normalized)


def sanitize_caller_name(value: object) -> str:
    if not isinstance(value, str):
        return ""
    compact = " ".join(value.split())[:80].strip()
    allowed = []
    for char in compact:
        category = unicodedata.category(char)
        if category.startswith(("L", "M")) or char in " ‌-'ـ":
            allowed.append(char)
    return " ".join("".join(allowed).split()).strip(" -'")


@dataclass(frozen=True)
class CallerMetadata:
    name: str = ""
    has_surgery_record: bool | None = None
    mobile: str = ""
    last_surgery_date: str = ""
    days_since_surgery: int | None = None


def load_caller_metadata(directory: str, call_id: str) -> CallerMetadata:
    try:
        uuid.UUID(call_id)
        path = Path(directory) / f"{call_id}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return CallerMetadata()
        surgery_status = payload.get("has_surgery_record")
        if not isinstance(surgery_status, bool):
            surgery_status = None
        last_surgery_date = payload.get("last_surgery_date")
        if not isinstance(last_surgery_date, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}", last_surgery_date
        ):
            last_surgery_date = ""
        days_since_surgery = payload.get("days_since_surgery")
        if (
            not isinstance(days_since_surgery, int)
            or isinstance(days_since_surgery, bool)
            or days_since_surgery < 0
        ):
            days_since_surgery = None
        return CallerMetadata(
            name=sanitize_caller_name(payload.get("name")),
            has_surgery_record=surgery_status,
            mobile=(
                caller_lookup.normalize_phone(payload.get("mobile", ""))
                if isinstance(payload.get("mobile"), str)
                else ""
            ),
            last_surgery_date=last_surgery_date,
            days_since_surgery=days_since_surgery,
        )
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        return CallerMetadata()
    finally:
        try:
            (Path(directory) / f"{call_id}.json").unlink(missing_ok=True)
        except (OSError, ValueError):
            pass


def load_caller_name(directory: str, call_id: str) -> str:
    """Compatibility wrapper for callers that need only the personalized greeting."""
    return load_caller_metadata(directory, call_id).name


def greeting_for_name(name: str) -> str:
    return f"سلام {name}، من دستیار دکتر افلاکی هستم، چه کمکی از من برمیاد؟" if name else GREETING


def instructions_for_caller(metadata: CallerMetadata) -> str:
    if metadata.has_surgery_record is True:
        details = ["\n# Verified Phone Lookup Context"]
        if metadata.name:
            details.append(f"- Verified patient name: {metadata.name}")
        if metadata.last_surgery_date:
            details.append(f"- Last surgery date: {metadata.last_surgery_date}")
        if metadata.days_since_surgery is not None:
            details.append(f"- Days since surgery: {metadata.days_since_surgery}")
        return INSTRUCTIONS + VERIFIED_SURGERY_INSTRUCTIONS + "\n".join(details) + "\n"
    return INSTRUCTIONS + UNVERIFIED_SURGERY_INSTRUCTIONS


def function_declarations() -> list[dict]:
    return [
        {
            "name": "verify_surgery_by_national_code",
            "description": (
                "Verify completed surgery by national code at the beginning of every postoperative "
                "consultation after the caller explicitly confirms that Dr. Aflaki performed their "
                "surgery. Call only after the bridge reports that all 10 keypad digits were entered. "
                "Never call for spoken or partial digits, repeat the code aloud, or ask the caller "
                "to confirm it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "national_code": {
                        "type": "string",
                        "description": "Exactly 10 digits and starting with 0",
                    },
                },
                "required": ["national_code"],
            },
        },
        {
            "name": "confirm_postoperative_identity",
            "description": (
                "Mark postoperative identity as verified only after the national-code lookup "
                "returned a name and the caller explicitly confirmed that returned name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "confirmed": {
                        "type": "boolean",
                        "description": "True only after the caller explicitly confirms the returned name",
                    },
                    "emergency_reported": {
                        "type": "boolean",
                        "description": (
                            "True when the postoperative symptom that triggered verification "
                            "matches an emergency item in the instructions; false otherwise"
                        ),
                    },
                    "summary": {
                        "type": "string",
                        "description": (
                            "When emergency_reported is true, a concise Persian summary of the "
                            "caller's reported symptom, severity or duration if stated, and callback request; "
                            "empty when emergency_reported is false"
                        ),
                    },
                },
                "required": ["confirmed", "emergency_reported", "summary"],
            },
        },
        {
            "name": "send_emergency_sms",
            "description": (
                "Notify postoperative support of an emergency. Use only after completed surgery "
                "by Dr. Aflaki, the caller's identity, and their national code are verified for "
                "this call, and only when the caller reports an emergency item defined in the "
                "instructions. The bridge always sends the verified name, caller mobile, national "
                "code, and a concise summary of the caller's actual complaint to CRM."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": (
                            "Concise Persian summary of the caller's reported emergency symptom, "
                            "severity or duration if stated, and request for a callback"
                        ),
                    },
                },
                "required": ["summary"],
            },
        },
        {
            "name": "transfer_to_doctor",
            "description": (
                "Transfer the active call to Dr. Aflaki's registered extension. "
                "Call only when the caller explicitly asks to speak directly with the doctor."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    ]


def session_update(config: Config, instructions: str = INSTRUCTIONS) -> dict:
    return {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "output_modalities": ["audio"],
            "instructions": instructions,
            "reasoning": {"effort": "low"},
            "tools": [{"type": "function", **tool} for tool in function_declarations()],
            "tool_choice": "auto",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcma"},
                    **(
                        {"transcription": {"model": config.transcribe_model, "language": "fa"}}
                        if config.transcript_dir and config.keep_transcript
                        else {}
                    ),
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": True,
                        "interrupt_response": True,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 600,
                    },
                },
                "output": {
                    "format": {"type": "audio/pcma"},
                    "voice": config.voice,
                },
            },
        },
    }


def spoken_response(text: str) -> dict:
    return {
        "type": "response.create",
        "response": {
            "output_modalities": ["audio"],
            "instructions": f"Say exactly this in natural Persian, without adding anything: {text}",
        },
    }


def user_text_event(text: str) -> dict:
    return {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": text}],
        },
    }


def gemini_setup(config: Config, instructions: str = INSTRUCTIONS) -> dict:
    return {
        "setup": {
            "model": f"models/{config.model}",
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": config.voice}}
                },
            },
            "systemInstruction": {"parts": [{"text": instructions}]},
            "tools": [{"functionDeclarations": function_declarations()}],
            **(
                {"inputAudioTranscription": {}, "outputAudioTranscription": {}}
                if config.transcript_dir and config.keep_transcript
                else {}
            ),
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "disabled": False,
                    "prefixPaddingMs": 300,
                    "silenceDurationMs": 600,
                },
                "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
            },
        }
    }


def gemini_text_request(text: str) -> dict:
    return {
        "clientContent": {
            "turns": [{
                "role": "user",
                "parts": [{"text": f"Say exactly this in natural Persian, without adding anything: {text}"}],
            }],
            "turnComplete": True,
        }
    }


def gemini_user_request(text: str) -> dict:
    return {
        "clientContent": {
            "turns": [{"role": "user", "parts": [{"text": text}]}],
            "turnComplete": True,
        }
    }


class CallSession:
    def __init__(self, conn: socket.socket, config: Config, fallback_pcm: bytes):
        self.conn = conn
        self.config = config
        self.fallback_pcm = fallback_pcm
        self.call_id = "unknown"
        self.started = time.monotonic()
        self.stop = threading.Event()
        self.send_lock = threading.Lock()
        self.response_lock = threading.Lock()
        self.output: queue.Queue[bytes] = queue.Queue(maxsize=1000)
        self.ws: websocket.WebSocket | None = None
        self.api_failed = False
        self.caller_hungup = False
        self.gemini_audio_remainder = b""
        self.gemini_output_buffer = bytearray()
        self.transfer_deadline: float | None = None
        self.allow_national_code_lookup = False
        self.pending_application_mobile: str | None = None
        self.pending_postoperative_identity = False
        self.pending_verified_national_code: str | None = None
        self.pending_verified_name = ""
        self.verified_national_code: str | None = None
        self.verified_name = ""
        self.caller_mobile = ""
        self.allow_emergency_sms = False
        self.emergency_sms_sent = False
        self.dtmf_digits = ""
        self.pending_keypad_national_code: str | None = None
        self.openai_response_active = False
        self.pending_openai_response: dict | None = None
        self.appointments = AppointmentStore(config.appointments_db)
        self.transcript: list[dict] = []
        # what the provider billed for this call, as it reported it
        self.usage: dict = {"realtime": {"text_in": 0, "audio_in": 0, "cached": 0, "text_out": 0, "audio_out": 0, "responses": 0}, "transcribe": {"seconds": 0.0, "in_tokens": 0, "out_tokens": 0, "audio_tokens": 0, "count": 0}}
        self.gemini_turn = {"caller": "", "assistant": ""}
        self.end_reason = ""

    def send_ast(self, kind: int, payload: bytes = b"") -> None:
        with self.send_lock:
            self.conn.sendall(pack_frame(kind, payload))

    def clear_output(self) -> None:
        while True:
            try:
                self.output.get_nowait()
            except queue.Empty:
                return

    def send_json(self, event: dict) -> None:
        if self.ws is not None:
            self.ws.send(json.dumps(event, ensure_ascii=False))

    def request_openai_response(self, event: dict | None = None) -> None:
        response_event = event or {"type": "response.create"}
        with self.response_lock:
            if self.openai_response_active:
                self.pending_openai_response = response_event
                return
            self.openai_response_active = True
        self.send_json(response_event)

    def finish_openai_response(self) -> None:
        pending = None
        with self.response_lock:
            self.openai_response_active = False
            if self.pending_openai_response is not None:
                pending = self.pending_openai_response
                self.pending_openai_response = None
                self.openai_response_active = True
        if pending is not None:
            self.send_json(pending)

    def connect_openai(self, greeting: str, instructions: str = INSTRUCTIONS) -> None:
        url = f"wss://api.openai.com/v1/realtime?model={self.config.model}"
        self.ws = websocket.create_connection(
            url,
            header=[f"Authorization: Bearer {self.config.api_key}"],
            timeout=20,
            enable_multithread=True,
        )
        self.ws.settimeout(1)
        self.send_json(session_update(self.config, instructions))
        self.request_openai_response(spoken_response(greeting))

    def connect_gemini(self, greeting: str, instructions: str = INSTRUCTIONS) -> None:
        query = urlencode({"key": self.config.api_key})
        url = (
            "wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?"
            f"{query}"
        )
        self.ws = websocket.create_connection(url, timeout=20, enable_multithread=True)
        self.send_json(gemini_setup(self.config, instructions))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            event = json.loads(self.ws.recv())
            if "setupComplete" in event:
                break
            if "error" in event:
                raise RuntimeError("Gemini rejected session setup")
        else:
            raise TimeoutError("Gemini setup timed out")
        self.ws.settimeout(1)
        self.send_json(gemini_text_request(greeting))

    def connect_provider(self, greeting: str, instructions: str = INSTRUCTIONS) -> None:
        if self.config.provider == "gemini":
            self.connect_gemini(greeting, instructions)
        else:
            self.connect_openai(greeting, instructions)

    def ws_reader(self) -> None:
        assert self.ws is not None
        try:
            while not self.stop.is_set():
                try:
                    raw = self.ws.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                if not raw:
                    raise RuntimeError("provider WebSocket closed")
                event = json.loads(raw)
                if self.config.provider == "gemini":
                    self.handle_gemini_event(event)
                    continue
                event_type = event.get("type", "")
                if event_type == "response.created":
                    with self.response_lock:
                        self.openai_response_active = True
                elif event_type == "response.done":
                    self.add_usage(event.get("response", {}).get("usage") or {})
                    self.finish_openai_response()
                elif event_type in ("response.output_audio.delta", "response.audio.delta"):
                    pcm = alaw_to_pcm(base64.b64decode(event.get("delta", "")))
                    for offset in range(0, len(pcm), PCM_FRAME_BYTES):
                        frame = pcm[offset : offset + PCM_FRAME_BYTES]
                        if frame:
                            try:
                                self.output.put(frame, timeout=1)
                            except queue.Full:
                                self.clear_output()
                                LOG.warning("call=%s output_queue_overflow", self.call_id)
                elif event_type == "input_audio_buffer.speech_started":
                    self.clear_output()
                elif event_type == "conversation.item.input_audio_transcription.completed":
                    self.add_transcribe_usage(event.get("usage") or {})
                    self.note("caller", event.get("transcript", ""))
                elif event_type in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                    self.note("assistant", event.get("transcript", ""))
                elif event_type == "response.output_item.done":
                    item = event.get("item", {})
                    if item.get("type") == "function_call":
                        self.handle_function_call(item)
                elif event_type == "error":
                    error = event.get("error", {})
                    if error.get("code") == "response_cancel_not_active":
                        LOG.info("call=%s response_cancel_not_active", self.call_id)
                        continue
                    if error.get("code") == "conversation_already_has_active_response":
                        LOG.warning("call=%s response_create_deferred", self.call_id)
                        with self.response_lock:
                            self.openai_response_active = True
                            if self.pending_openai_response is None:
                                self.pending_openai_response = {"type": "response.create"}
                        continue
                    LOG.error(
                        "call=%s api_error code=%s type=%s",
                        self.call_id,
                        error.get("code", "unknown"),
                        error.get("type", "unknown"),
                    )
                    raise RuntimeError("OpenAI Realtime error")
        except Exception as exc:  # Session-level failure; never log content or secrets.
            if not self.stop.is_set():
                self.api_failed = True
                LOG.error("call=%s websocket_failure error=%s", self.call_id, type(exc).__name__)
                self.stop.set()

    def queue_pcm(self, pcm: bytes) -> None:
        for offset in range(0, len(pcm), PCM_FRAME_BYTES):
            frame = pcm[offset : offset + PCM_FRAME_BYTES]
            if frame:
                try:
                    self.output.put(frame, timeout=1)
                except queue.Full:
                    self.clear_output()
                    LOG.warning("call=%s output_queue_overflow", self.call_id)

    def handle_gemini_event(self, event: dict) -> None:
        meta = event.get("usageMetadata")
        if isinstance(meta, dict):
            r = self.usage["realtime"]
            by = lambda key: {d.get("modality"): int(d.get("tokenCount") or 0) for d in (meta.get(key) or []) if isinstance(d, dict)}
            p, o = by("promptTokensDetails"), by("responseTokensDetails")
            r["text_in"], r["audio_in"] = p.get("TEXT", 0), p.get("AUDIO", 0)
            r["text_out"], r["audio_out"] = o.get("TEXT", 0), o.get("AUDIO", 0)
            r["cached"] = int(meta.get("cachedContentTokenCount") or 0)
            r["responses"] += 1
        content = event.get("serverContent", {})
        for key, role in (("inputTranscription", "caller"), ("outputTranscription", "assistant")):
            text = (content.get(key) or {}).get("text", "")
            if text:
                other = "assistant" if role == "caller" else "caller"
                if self.gemini_turn[other]:
                    self.note(other, self.gemini_turn[other])
                    self.gemini_turn[other] = ""
                self.gemini_turn[role] += text
        if content.get("turnComplete"):
            for role in ("caller", "assistant"):
                if self.gemini_turn[role]:
                    self.note(role, self.gemini_turn[role])
                    self.gemini_turn[role] = ""
        if content.get("interrupted"):
            self.clear_output()
            self.gemini_audio_remainder = b""
            self.gemini_output_buffer.clear()
        for part in content.get("modelTurn", {}).get("parts", []):
            inline = part.get("inlineData", {})
            if inline.get("data"):
                pcm, self.gemini_audio_remainder = pcm24_to_pcm8(
                    base64.b64decode(inline["data"]), self.gemini_audio_remainder
                )
                self.gemini_output_buffer.extend(pcm)
                complete = len(self.gemini_output_buffer) - (len(self.gemini_output_buffer) % PCM_FRAME_BYTES)
                if complete:
                    self.queue_pcm(bytes(self.gemini_output_buffer[:complete]))
                    del self.gemini_output_buffer[:complete]
        if content.get("turnComplete") and self.gemini_output_buffer:
            frame = bytes(self.gemini_output_buffer).ljust(PCM_FRAME_BYTES, b"\0")
            self.gemini_output_buffer.clear()
            self.queue_pcm(frame)
        if "toolCall" in event:
            self.handle_gemini_tool_calls(event["toolCall"])
        if "goAway" in event:
            LOG.warning("call=%s provider_go_away", self.call_id)

    def execute_tool(self, name: str, arguments: dict) -> dict:
        result = self.run_tool(name, arguments)
        if self.config.transcript_dir and self.config.keep_transcript:
            status = result.get("status", "") if isinstance(result, dict) else ""
            self.transcript.append({"t": round(time.monotonic() - self.started, 1), "role": "event", "name": name, "status": str(status)[:40]})
        return result

    def add_usage(self, u: dict) -> None:
        """Token counts from an OpenAI Realtime response.done event."""
        if not isinstance(u, dict) or not u:
            return
        r = self.usage["realtime"]
        inp, out = u.get("input_token_details") or {}, u.get("output_token_details") or {}
        r["text_in"] += int(inp.get("text_tokens") or 0)
        r["audio_in"] += int(inp.get("audio_tokens") or 0)
        r["cached"] += int(inp.get("cached_tokens") or 0)
        r["text_out"] += int(out.get("text_tokens") or 0)
        r["audio_out"] += int(out.get("audio_tokens") or 0)
        r["responses"] += 1

    def add_transcribe_usage(self, u: dict) -> None:
        """The caller-side transcription is billed separately (by duration or by tokens)."""
        if not isinstance(u, dict) or not u:
            return
        t = self.usage["transcribe"]
        t["count"] += 1
        if u.get("type") == "duration":
            t["seconds"] += float(u.get("seconds") or 0)
        else:
            t["in_tokens"] += int(u.get("input_tokens") or 0)
            t["out_tokens"] += int(u.get("output_tokens") or 0)
            t["audio_tokens"] += int((u.get("input_token_details") or {}).get("audio_tokens") or 0)

    def note(self, role: str, text: str) -> None:
        """One spoken line for the call review; national codes are masked before anything is kept."""
        if not (self.config.transcript_dir and self.config.keep_transcript):
            return
        text = mask_national_codes(" ".join(str(text or "").split()))
        if text:
            self.transcript.append({"t": round(time.monotonic() - self.started, 1), "role": role, "text": text[:2000]})

    def write_transcript(self, duration: int) -> None:
        if not self.config.transcript_dir:
            return
        try:
            uuid.UUID(self.call_id)
        except ValueError:
            return  # not a call (health probe or a broken AudioSocket start)
        try:
            for role in ("caller", "assistant"):
                if self.gemini_turn.get(role):
                    self.note(role, self.gemini_turn[role])
            payload = {
                "call_id": self.call_id,
                "provider": self.config.provider,
                "model": self.config.model,
                "duration": duration,
                "end_reason": self.end_reason,
                "transcript": self.transcript,
                "usage": self.usage,
            }
            path = Path(self.config.transcript_dir) / f"{self.call_id}.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except (OSError, ValueError) as exc:
            LOG.warning("call=%s transcript_not_written error=%s", self.call_id, type(exc).__name__)

    def run_tool(self, name: str, arguments: dict) -> dict:
        try:
            if name == "send_application_link":
                result = {"status": "error", "reason": "appointment_flow_disabled"}
            elif name == "verify_surgery_by_national_code":
                if not (self.allow_national_code_lookup or self.allow_emergency_sms):
                    result = {"status": "error", "reason": "lookup_not_allowed"}
                elif self.pending_keypad_national_code is None:
                    result = {"status": "waiting", "reason": "ten_keypad_digits_required"}
                else:
                    national_code = caller_lookup.normalize_national_code(
                        self.pending_keypad_national_code
                    )
                    self.pending_keypad_national_code = None
                    if not national_code:
                        self.pending_postoperative_identity = False
                        self.pending_verified_national_code = None
                        self.pending_verified_name = ""
                        result = {"status": "invalid", "reason": "invalid_national_code"}
                    else:
                        crm_config = caller_lookup.load_env(caller_lookup.CONFIG_PATH)
                        result = caller_lookup.api_lookup_by_national_code(
                            crm_config,
                            national_code,
                        )
                        self.pending_postoperative_identity = (
                            result.get("status") == "verified" and bool(result.get("name"))
                        )
                        self.pending_verified_national_code = (
                            national_code if self.pending_postoperative_identity else None
                        )
                        self.pending_verified_name = (
                            caller_lookup.sanitize_name(result.get("name"))
                            if self.pending_postoperative_identity
                            else ""
                        )
            elif name == "confirm_postoperative_identity":
                if (
                    arguments.get("confirmed") is True
                    and self.pending_postoperative_identity
                    and self.pending_verified_national_code
                ):
                    self.pending_postoperative_identity = False
                    self.verified_national_code = self.pending_verified_national_code
                    self.verified_name = self.pending_verified_name
                    self.pending_verified_national_code = None
                    self.pending_verified_name = ""
                    self.allow_national_code_lookup = False
                    self.allow_emergency_sms = True
                    result = {"status": "verified"}
                    if arguments.get("emergency_reported") is True:
                        emergency_result = self.execute_emergency_sms(
                            arguments.get("summary", "")
                        )
                        LOG.info(
                            "call=%s emergency_sms status=%s reason=%s",
                            self.call_id,
                            emergency_result.get("status"),
                            emergency_result.get("reason", "none"),
                        )
                        result["emergency_sms_status"] = emergency_result.get("status")
                        if emergency_result.get("reason"):
                            result["emergency_sms_reason"] = emergency_result["reason"]
                else:
                    self.pending_postoperative_identity = False
                    self.pending_verified_national_code = None
                    self.pending_verified_name = ""
                    result = {"status": "error", "reason": "identity_not_verified"}
            elif name == "send_emergency_sms":
                result = self.execute_emergency_sms(arguments.get("summary", ""))
            elif name == "transfer_to_doctor":
                try:
                    uuid.UUID(self.call_id)
                except ValueError:
                    result = {"status": "error", "reason": "invalid_call_id"}
                else:
                    transfer_dir = Path(self.config.transfer_dir)
                    transfer_dir.mkdir(parents=True, exist_ok=True)
                    marker = transfer_dir / self.call_id
                    marker.touch(mode=0o640, exist_ok=True)
                    self.transfer_deadline = time.monotonic() + 8
                    cleanup = threading.Timer(120, lambda: marker.unlink(missing_ok=True))
                    cleanup.daemon = True
                    cleanup.start()
                    result = {"status": "transferring", "destination": "doctor_extension"}
            else:
                result = {"status": "error", "reason": "unknown_tool"}
        except (TypeError, ValueError, OSError, KeyError, sqlite3.Error) as exc:
            LOG.error("call=%s tool=%s failure=%s", self.call_id, name, type(exc).__name__)
            result = {"status": "error", "reason": "internal_error"}
        LOG.info(
            "call=%s tool=%s status=%s reason=%s",
            self.call_id,
            name,
            result.get("status"),
            result.get("reason", "none"),
        )
        return result

    def execute_emergency_sms(self, summary: str = "") -> dict:
        if not self.allow_emergency_sms:
            return {"status": "error", "reason": "emergency_not_allowed"}
        if not self.caller_mobile:
            return {"status": "error", "reason": "caller_mobile_missing"}
        if not self.verified_national_code:
            return {"status": "error", "reason": "national_code_missing"}
        if not caller_lookup.sanitize_emergency_summary(summary):
            return {"status": "invalid", "reason": "summary_missing"}
        if self.emergency_sms_sent:
            return {"status": "already_sent"}
        crm_config = caller_lookup.load_env(caller_lookup.CONFIG_PATH)
        result = caller_lookup.send_emergency_sms(
            crm_config,
            self.caller_mobile,
            self.verified_national_code,
            self.verified_name,
            summary,
        )
        if result.get("status") == "sent":
            self.emergency_sms_sent = True
        return result

    def handle_function_call(self, item: dict) -> None:
        name = item.get("name", "")
        call_id = item.get("call_id", "")
        try:
            arguments = json.loads(item.get("arguments") or "{}")
        except (TypeError, ValueError):
            arguments = {}
        result = self.execute_tool(name, arguments)
        self.send_json(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": json.dumps(result, ensure_ascii=False),
                },
            }
        )
        self.request_openai_response()

    def handle_gemini_tool_calls(self, tool_call: dict) -> None:
        responses = []
        for call in tool_call.get("functionCalls", []):
            result = self.execute_tool(call.get("name", ""), call.get("args") or {})
            responses.append({
                "id": call.get("id", ""),
                "name": call.get("name", ""),
                "response": {"result": result},
            })
        if responses:
            self.send_json({"toolResponse": {"functionResponses": responses}})

    def send_caller_audio(self, pcm: bytes) -> None:
        if self.config.provider == "gemini":
            audio = pcm8_to_pcm16(pcm)
            self.send_json({
                "realtimeInput": {
                    "audio": {
                        "data": base64.b64encode(audio).decode("ascii"),
                        "mimeType": "audio/pcm;rate=16000",
                    }
                }
            })
        else:
            self.send_json({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm_to_alaw(pcm)).decode("ascii"),
            })

    def submit_keypad_national_code(self) -> None:
        national_code = self.dtmf_digits
        self.dtmf_digits = ""
        self.pending_keypad_national_code = national_code
        text = (
            "The caller entered this 10-digit national code using the phone keypad: "
            f"{national_code}. Treat it as the national code they just provided. "
            "Verify it immediately. Never read the national code back and never ask the caller "
            "to confirm it."
        )
        if self.config.provider == "gemini":
            self.send_json(gemini_user_request(text))
        else:
            self.send_json(user_text_event(text))
            self.request_openai_response()

    def handle_dtmf(self, payload: bytes) -> None:
        if not (self.allow_national_code_lookup or self.allow_emergency_sms):
            return
        if len(payload) != 1:
            return
        try:
            digit = payload.decode("ascii")
        except UnicodeDecodeError:
            return
        if digit == "*":
            self.dtmf_digits = ""
            self.pending_keypad_national_code = None
            return
        if digit == "#":
            if len(self.dtmf_digits) == 10:
                self.submit_keypad_national_code()
            return
        if digit not in "0123456789":
            return
        if len(self.dtmf_digits) >= 10:
            self.dtmf_digits = ""
        self.dtmf_digits += digit
        if len(self.dtmf_digits) == 10:
            self.submit_keypad_national_code()

    def send_closing(self) -> None:
        if self.config.provider == "gemini":
            self.send_json(gemini_text_request(CLOSING))
        else:
            try:
                self.send_json({"type": "response.cancel"})
            except Exception:
                pass
            self.request_openai_response(spoken_response(CLOSING))

    def audio_sender(self) -> None:
        deadline = time.monotonic()
        try:
            while not self.stop.is_set() or not self.output.empty():
                try:
                    frame = self.output.get(timeout=0.1)
                except queue.Empty:
                    continue
                deadline = max(deadline + 0.020, time.monotonic())
                delay = deadline - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                self.send_ast(AUDIO_KIND, frame)
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.caller_hungup = True
            self.stop.set()

    def play_local(self, pcm: bytes) -> None:
        for offset in range(0, len(pcm), PCM_FRAME_BYTES):
            if self.caller_hungup:
                return
            frame = pcm[offset : offset + PCM_FRAME_BYTES]
            if len(frame) < PCM_FRAME_BYTES:
                frame += b"\0" * (PCM_FRAME_BYTES - len(frame))
            self.send_ast(AUDIO_KIND, frame)
            time.sleep(0.020)

    def run(self) -> None:
        ws_thread: threading.Thread | None = None
        sender_thread: threading.Thread | None = None
        closing_sent = False
        try:
            self.conn.settimeout(1)
            first = read_frame(self.conn)
            if first is None or first[0] != UUID_KIND:
                raise ValueError("missing AudioSocket UUID frame")
            self.call_id = call_id_from_payload(first[1])
            LOG.info("call=%s started", self.call_id)
            caller_metadata = load_caller_metadata(self.config.caller_metadata_dir, self.call_id)
            self.allow_national_code_lookup = True
            self.allow_emergency_sms = False
            self.caller_mobile = caller_metadata.mobile
            self.connect_provider(
                greeting_for_name(caller_metadata.name),
                instructions_for_caller(caller_metadata),
            )
            ws_thread = threading.Thread(target=self.ws_reader, daemon=True)
            sender_thread = threading.Thread(target=self.audio_sender, daemon=True)
            ws_thread.start()
            sender_thread.start()

            while not self.stop.is_set():
                elapsed = time.monotonic() - self.started
                if self.transfer_deadline is not None and time.monotonic() >= self.transfer_deadline:
                    self.stop.set()
                    break
                if not closing_sent and elapsed >= self.config.max_seconds - self.config.closing_seconds:
                    closing_sent = True
                    self.clear_output()
                    self.send_closing()
                if elapsed >= self.config.max_seconds:
                    self.stop.set()
                    break
                frame = read_frame(self.conn)
                if frame is None or frame[0] == HANGUP_KIND:
                    self.caller_hungup = True
                    self.stop.set()
                    break
                if frame[0] == AUDIO_KIND and not closing_sent:
                    self.send_caller_audio(frame[1])
                elif frame[0] == DTMF_KIND and not closing_sent:
                    self.handle_dtmf(frame[1])
        except Exception as exc:
            if not self.caller_hungup:
                self.api_failed = True
                LOG.error("call=%s session_failure error=%s", self.call_id, type(exc).__name__)
        finally:
            self.stop.set()
            if self.api_failed:
                self.clear_output()
            if self.ws is not None:
                try:
                    self.ws.close()
                except Exception:
                    pass
            if ws_thread is not None:
                ws_thread.join(timeout=2)
            if sender_thread is not None:
                sender_thread.join(timeout=2)
            if self.api_failed and not self.caller_hungup:
                try:
                    self.clear_output()
                    self.play_local(self.fallback_pcm)
                except OSError:
                    self.caller_hungup = True
            if not self.caller_hungup:
                try:
                    self.send_ast(HANGUP_KIND)
                except OSError:
                    pass
            try:
                self.conn.close()
            except OSError:
                pass
            duration = int(time.monotonic() - self.started)
            if not self.end_reason:
                self.end_reason = (
                    "transfer" if self.transfer_deadline is not None
                    else "api_failed" if self.api_failed
                    else "caller_hangup" if self.caller_hungup
                    else "time_limit" if duration >= self.config.max_seconds
                    else "assistant_ended"
                )
            self.write_transcript(duration)
            LOG.info("call=%s ended duration_seconds=%d", self.call_id, duration)


class BridgeServer:
    def __init__(self, config: Config):
        self.config = config
        self.fallback_pcm = load_fallback_pcm(config.fallback_wav)
        self.slots = threading.BoundedSemaphore(config.max_calls)
        self.shutdown = threading.Event()
        self.listener: socket.socket | None = None

    def handle(self, conn: socket.socket) -> None:
        if not self.slots.acquire(blocking=False):
            try:
                CallSession(conn, self.config, self.fallback_pcm).play_local(self.fallback_pcm)
                conn.sendall(pack_frame(HANGUP_KIND))
            except OSError:
                pass
            finally:
                conn.close()
            return
        try:
            CallSession(conn, self.config, self.fallback_pcm).run()
        finally:
            self.slots.release()

    def serve(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            self.listener = listener
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((self.config.listen_host, self.config.listen_port))
            listener.listen(16)
            listener.settimeout(1)
            LOG.info(
                "bridge_started address=%s:%d max_calls=%d provider=%s",
                self.config.listen_host,
                self.config.listen_port,
                self.config.max_calls,
                self.config.provider,
            )
            while not self.shutdown.is_set():
                try:
                    conn, _ = listener.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self.handle, args=(conn,), daemon=True).start()


def generate_fallback(config: Config) -> None:
    if config.provider == "gemini":
        generate_gemini_fallback(config)
        return
    url = f"wss://api.openai.com/v1/realtime?model={config.model}"
    ws = websocket.create_connection(
        url,
        header=[f"Authorization: Bearer {config.api_key}"],
        timeout=15,
    )
    audio = bytearray()
    try:
        ws.send(json.dumps(session_update(config), ensure_ascii=False))
        ws.send(json.dumps(spoken_response(UNAVAILABLE), ensure_ascii=False))
        while True:
            event = json.loads(ws.recv())
            if event.get("type") in ("response.output_audio.delta", "response.audio.delta"):
                audio.extend(alaw_to_pcm(base64.b64decode(event.get("delta", ""))))
            elif event.get("type") == "response.done":
                break
            elif event.get("type") == "error":
                raise RuntimeError("OpenAI rejected fallback-audio generation")
    finally:
        ws.close()
    if not audio:
        raise RuntimeError("OpenAI returned no fallback audio")
    path = Path(config.fallback_wav)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(audio)
    os.chmod(path, 0o640)
    LOG.info("fallback_audio_generated frames=%d", len(audio) // 2)


def generate_gemini_fallback(config: Config) -> None:
    query = urlencode({"key": config.api_key})
    url = (
        "wss://generativelanguage.googleapis.com/ws/"
        "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?"
        f"{query}"
    )
    ws = websocket.create_connection(url, timeout=20)
    audio = bytearray()
    remainder = b""
    try:
        ws.send(json.dumps(gemini_setup(config), ensure_ascii=False))
        while True:
            event = json.loads(ws.recv())
            if "setupComplete" in event:
                break
            if "error" in event:
                raise RuntimeError("Gemini rejected fallback session setup")
        ws.send(json.dumps(gemini_text_request(UNAVAILABLE), ensure_ascii=False))
        while True:
            event = json.loads(ws.recv())
            content = event.get("serverContent", {})
            for part in content.get("modelTurn", {}).get("parts", []):
                inline = part.get("inlineData", {})
                if inline.get("data"):
                    pcm, remainder = pcm24_to_pcm8(base64.b64decode(inline["data"]), remainder)
                    audio.extend(pcm)
            if content.get("turnComplete"):
                break
            if "error" in event:
                raise RuntimeError("Gemini rejected fallback-audio generation")
    finally:
        ws.close()
    if not audio:
        raise RuntimeError("Gemini returned no fallback audio")
    path = Path(config.fallback_wav)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(audio)
    os.chmod(path, 0o640)
    LOG.info("fallback_audio_generated frames=%d provider=gemini", len(audio) // 2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate-fallback", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    config = Config.from_env()
    if args.check:
        LOG.info("configuration_valid")
        return
    if args.generate_fallback:
        generate_fallback(config)
        return
    server = BridgeServer(config)
    signal.signal(signal.SIGTERM, lambda *_: server.shutdown.set())
    signal.signal(signal.SIGINT, lambda *_: server.shutdown.set())
    server.serve()


if __name__ == "__main__":
    main()
