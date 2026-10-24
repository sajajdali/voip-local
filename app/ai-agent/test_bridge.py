#!/usr/bin/python3

import json
import os
import socket
import tempfile
import struct
import sys
import unittest
import uuid
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import bridge
import caller_lookup
import outbound_api


class CodecTests(unittest.TestCase):
    def test_known_alaw_silence(self):
        self.assertEqual(bridge.linear_to_alaw(0), 0xD5)
        self.assertEqual(bridge.alaw_to_linear(0xD5), 8)

    def test_codec_roundtrip_is_bounded(self):
        for sample in (-32000, -10000, -1000, 0, 1000, 10000, 32000):
            decoded = bridge.alaw_to_linear(bridge.linear_to_alaw(sample))
            self.assertLess(abs(decoded - sample), max(32, abs(sample) // 8))

    def test_pcm_conversion_length(self):
        pcm = struct.pack("<160h", *range(160))
        encoded = bridge.pcm_to_alaw(pcm)
        self.assertEqual(len(encoded), 160)
        self.assertEqual(len(bridge.alaw_to_pcm(encoded)), 320)

    def test_gemini_sample_rate_conversion(self):
        pcm8 = struct.pack("<160h", *range(160))
        pcm16 = bridge.pcm8_to_pcm16(pcm8)
        self.assertEqual(len(pcm16), 640)
        samples = struct.unpack("<320h", pcm16)
        self.assertEqual(samples[:4], (0, 0, 1, 1))

        pcm24 = struct.pack("<6h", 3, 6, 9, -3, -6, -9)
        downsampled, remainder = bridge.pcm24_to_pcm8(pcm24[:8])
        tail, remainder = bridge.pcm24_to_pcm8(pcm24[8:], remainder)
        self.assertEqual(struct.unpack("<2h", downsampled + tail), (6, -6))
        self.assertEqual(remainder, b"")


class AudioSocketTests(unittest.TestCase):
    def test_pack_and_read_fragmented_frame(self):
        left, right = socket.socketpair()
        payload = uuid.uuid4().bytes
        packed = bridge.pack_frame(bridge.UUID_KIND, payload)
        for byte in packed:
            left.send(bytes((byte,)))
        self.assertEqual(bridge.read_frame(right), (bridge.UUID_KIND, payload))
        left.close()
        right.close()

    def test_uuid_payload(self):
        value = uuid.uuid4()
        self.assertEqual(bridge.call_id_from_payload(value.bytes), str(value))

    def test_payload_limit(self):
        with self.assertRaises(ValueError):
            bridge.pack_frame(bridge.AUDIO_KIND, b"x" * 65536)

    def test_dtmf_frame_kind_matches_audiosocket_protocol(self):
        self.assertEqual(bridge.DTMF_KIND, 0x03)


class EventTests(unittest.TestCase):
    def test_session_uses_pcma_and_persian(self):
        config = bridge.Config(api_key="test")
        event = bridge.session_update(config)
        self.assertEqual(event["session"]["audio"]["input"]["format"]["type"], "audio/pcma")
        self.assertEqual(event["session"]["audio"]["output"]["format"]["type"], "audio/pcma")
        self.assertIn("Persian", event["session"]["instructions"])
        self.assertIn("receptionist", event["session"]["instructions"])
        self.assertIn("Strict Topic Scope", event["session"]["instructions"])
        self.assertIn("rhinoplasty", event["session"]["instructions"])
        self.assertEqual(event["session"]["reasoning"]["effort"], "low")
        self.assertEqual(
            [tool["name"] for tool in event["session"]["tools"]],
            [
                "verify_surgery_by_national_code",
                "confirm_postoperative_identity",
                "send_emergency_sms",
                "transfer_to_doctor",
            ],
        )

    def test_default_limits(self):
        config = bridge.Config(api_key="test")
        self.assertEqual(config.max_calls, 4)
        self.assertEqual(config.max_seconds, 300)
        self.assertEqual(config.closing_seconds, 15)
        self.assertEqual(
            bridge.CLOSING,
            "متأسفانه محدودیت صحبت با من تمام شده و مجبورم قطع کنم. "
            "امیدوارم که تونسته باشم شما را راهنمایی کرده باشم. خدانگهدار.",
        )

    def test_gemini_setup_uses_audio_voice_tools_and_persian(self):
        config = bridge.Config(
            api_key="test", provider="gemini",
            model="gemini-3.1-flash-live-preview", voice="Kore",
        )
        setup = bridge.gemini_setup(config)["setup"]
        self.assertEqual(setup["model"], "models/gemini-3.1-flash-live-preview")
        self.assertEqual(setup["generationConfig"]["responseModalities"], ["AUDIO"])
        self.assertEqual(
            setup["generationConfig"]["speechConfig"]["voiceConfig"]
            ["prebuiltVoiceConfig"]["voiceName"],
            "Kore",
        )
        self.assertIn("Persian", setup["systemInstruction"]["parts"][0]["text"])
        self.assertEqual(
            [tool["name"] for tool in setup["tools"][0]["functionDeclarations"]],
            [
                "verify_surgery_by_national_code",
                "confirm_postoperative_identity",
                "send_emergency_sms",
                "transfer_to_doctor",
            ],
        )

    def test_provider_specific_environment(self):
        values = {
            "AI_PROVIDER": "gemini",
            "GEMINI_API_KEY": "gemini-test-key",
            "GEMINI_LIVE_MODEL": "gemini-test-model",
            "GEMINI_LIVE_VOICE": "Kore",
        }
        old = {name: os.environ.get(name) for name in values}
        try:
            os.environ.update(values)
            config = bridge.Config.from_env()
            self.assertEqual(config.provider, "gemini")
            self.assertEqual(config.api_key, "gemini-test-key")
            self.assertEqual(config.model, "gemini-test-model")
        finally:
            for name, value in old.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_doctor_transfer_creates_call_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
                transfer_dir=os.path.join(temp, "transfers"),
            )
            session = bridge.CallSession(right, config, b"")
            session.call_id = str(uuid.uuid4())
            result = session.execute_tool("transfer_to_doctor", {})
            self.assertEqual(result["status"], "transferring")
            self.assertTrue(os.path.exists(os.path.join(config.transfer_dir, session.call_id)))
            self.assertIsNotNone(session.transfer_deadline)
            left.close()
            right.close()

    def test_national_code_lookup_is_guarded_by_call_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            with mock.patch("bridge.caller_lookup.api_lookup_by_national_code") as lookup:
                denied = session.execute_tool(
                    "verify_surgery_by_national_code",
                    {"national_code": "0012345678"},
                )
            self.assertEqual(denied, {"status": "error", "reason": "lookup_not_allowed"})
            lookup.assert_not_called()
            left.close()
            right.close()

    def test_application_link_is_disabled(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            with mock.patch("bridge.caller_lookup.send_application_link") as sender:
                result = session.execute_tool(
                    "send_application_link",
                    {"mobile": "09121234567", "confirmed": True},
                )
            self.assertEqual(
                result, {"status": "error", "reason": "appointment_flow_disabled"}
            )
            sender.assert_not_called()
            left.close()
            right.close()

    def test_ten_keypad_digits_are_injected_as_national_code(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            session.allow_national_code_lookup = True
            with mock.patch.object(session, "send_json") as send_json:
                for digit in "045375466":
                    session.handle_dtmf(digit.encode())
                send_json.assert_not_called()
                session.handle_dtmf(b"1")
            self.assertEqual(session.dtmf_digits, "")
            self.assertEqual(send_json.call_count, 2)
            item = send_json.call_args_list[0].args[0]
            self.assertEqual(item["type"], "conversation.item.create")
            text = item["item"]["content"][0]["text"]
            self.assertIn("0453754661", text)
            self.assertIn("phone keypad", text)
            self.assertEqual(
                send_json.call_args_list[1].args[0], {"type": "response.create"}
            )
            left.close()
            right.close()

    def test_star_clears_partial_keypad_code(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            session.allow_national_code_lookup = True
            for digit in "04537":
                session.handle_dtmf(digit.encode())
            session.handle_dtmf(b"*")
            self.assertEqual(session.dtmf_digits, "")
            left.close()
            right.close()

    def test_application_link_stays_disabled_without_confirmation(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            with mock.patch("bridge.caller_lookup.send_application_link") as sender:
                result = session.execute_tool(
                    "send_application_link",
                    {"mobile": "09121234567", "confirmed": True},
                )
            self.assertEqual(
                result,
                {"status": "error", "reason": "appointment_flow_disabled"},
            )
            sender.assert_not_called()
            left.close()
            right.close()

    def test_national_code_lookup_runs_immediately_without_readback(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            session.allow_national_code_lookup = True
            verified = {"status": "verified", "name": "نازنین"}
            session.pending_keypad_national_code = "0012345678"
            with mock.patch(
                "bridge.caller_lookup.api_lookup_by_national_code",
                return_value=verified,
            ) as lookup, mock.patch(
                "bridge.caller_lookup.load_env", return_value={}
            ):
                result = session.execute_tool(
                    "verify_surgery_by_national_code",
                    {"national_code": "۰۰۱۲۳۴۵۶۷۸"},
                )
            self.assertEqual(result, verified)
            lookup.assert_called_once_with({}, "0012345678")
            self.assertTrue(session.pending_postoperative_identity)
            self.assertEqual(session.pending_verified_national_code, "0012345678")
            self.assertEqual(session.pending_verified_name, "نازنین")
            left.close()
            right.close()

    def test_national_code_lookup_waits_for_ten_keypad_digits(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            session.allow_national_code_lookup = True
            with mock.patch("bridge.caller_lookup.api_lookup_by_national_code") as lookup:
                result = session.execute_tool(
                    "verify_surgery_by_national_code",
                    {"national_code": "04537"},
                )
            self.assertEqual(
                result, {"status": "waiting", "reason": "ten_keypad_digits_required"}
            )
            lookup.assert_not_called()
            left.close()
            right.close()

    def test_emergency_sms_requires_verified_postoperative_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            with mock.patch("bridge.caller_lookup.send_emergency_sms") as sender:
                denied = session.execute_tool("send_emergency_sms", {})
            self.assertEqual(
                denied, {"status": "error", "reason": "emergency_not_allowed"}
            )
            sender.assert_not_called()
            left.close()
            right.close()

    def test_confirmed_identity_allows_one_emergency_sms(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            session.pending_postoperative_identity = True
            session.pending_verified_national_code = "0012345678"
            session.pending_verified_name = "نازنین رضایی"
            session.caller_mobile = "09121234567"
            verified = session.execute_tool(
                "confirm_postoperative_identity",
                {"confirmed": True, "emergency_reported": False, "summary": ""},
            )
            self.assertEqual(verified, {"status": "verified"})
            with mock.patch(
                "bridge.caller_lookup.send_emergency_sms",
                return_value={"status": "sent"},
            ) as sender, mock.patch(
                "bridge.caller_lookup.load_env", return_value={}
            ):
                sent = session.execute_tool(
                    "send_emergency_sms",
                    {"summary": "بیمار خون‌ریزی شدید بینی را گزارش کرده و درخواست تماس دارد."},
                )
                duplicate = session.execute_tool(
                    "send_emergency_sms",
                    {"summary": "بیمار خون‌ریزی شدید بینی را گزارش کرده و درخواست تماس دارد."},
                )
            self.assertEqual(sent, {"status": "sent"})
            self.assertEqual(duplicate, {"status": "already_sent"})
            sender.assert_called_once_with(
                {},
                "09121234567",
                "0012345678",
                "نازنین رضایی",
                "بیمار خون‌ریزی شدید بینی را گزارش کرده و درخواست تماس دارد.",
            )
            left.close()
            right.close()

    def test_identity_confirmation_sends_reported_emergency_immediately(self):
        with tempfile.TemporaryDirectory() as temp:
            left, right = socket.socketpair()
            config = bridge.Config(
                api_key="test",
                appointments_db=os.path.join(temp, "appointments.db"),
            )
            session = bridge.CallSession(right, config, b"")
            session.pending_postoperative_identity = True
            session.pending_verified_national_code = "0012345678"
            session.pending_verified_name = "نازنین رضایی"
            session.caller_mobile = "09121234567"
            with mock.patch(
                "bridge.caller_lookup.send_emergency_sms",
                return_value={"status": "sent"},
            ) as sender, mock.patch(
                "bridge.caller_lookup.load_env", return_value={}
            ):
                result = session.execute_tool(
                    "confirm_postoperative_identity",
                    {
                        "confirmed": True,
                        "emergency_reported": True,
                        "summary": "بیمار از تنگی نفس شدید پس از عمل شکایت دارد.\nدرخواست تماس فوری دارد.",
                    },
                )
            self.assertEqual(
                result, {"status": "verified", "emergency_sms_status": "sent"}
            )
            sender.assert_called_once_with(
                {},
                "09121234567",
                "0012345678",
                "نازنین رضایی",
                "بیمار از تنگی نفس شدید پس از عمل شکایت دارد.\nدرخواست تماس فوری دارد.",
            )
            self.assertTrue(session.emergency_sms_sent)
            left.close()
            right.close()

    def test_personalized_greeting_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            call_id = str(uuid.uuid4())
            path = os.path.join(temp, f"{call_id}.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"name":"علی"}')
            name = bridge.load_caller_name(temp, call_id)
            self.assertEqual(name, "علی")
            self.assertEqual(
                bridge.greeting_for_name(name),
                "سلام علی، من دستیار دکتر افلاکی هستم، چه کمکی از من برمیاد؟",
            )
            self.assertFalse(os.path.exists(path))

    def test_caller_mobile_is_available_for_emergency_sms(self):
        with tempfile.TemporaryDirectory() as temp:
            call_id = str(uuid.uuid4())
            caller_lookup.write_metadata(
                temp, call_id, "علی", True, "۰۹۱۲۱۲۳۴۵۶۷"
            )
            metadata = bridge.load_caller_metadata(temp, call_id)
            self.assertEqual(metadata.mobile, "09121234567")
            self.assertTrue(metadata.has_surgery_record)

    def test_fixed_caller_number_is_available_for_emergency_sms(self):
        with tempfile.TemporaryDirectory() as temp:
            call_id = str(uuid.uuid4())
            caller_lookup.write_metadata(temp, call_id, "علی", False, "22498671")
            metadata = bridge.load_caller_metadata(temp, call_id)
            self.assertEqual(metadata.mobile, "22498671")

    def test_completed_phone_lookup_metadata_includes_surgery_timing(self):
        with tempfile.TemporaryDirectory() as temp:
            call_id = str(uuid.uuid4())
            caller_lookup.write_metadata(
                temp,
                call_id,
                "سجاد",
                True,
                "09121234567",
                "2026-09-20",
                7,
            )
            metadata = bridge.load_caller_metadata(temp, call_id)
            self.assertEqual(metadata.name, "سجاد")
            self.assertTrue(metadata.has_surgery_record)
            self.assertEqual(metadata.last_surgery_date, "2026-09-20")
            self.assertEqual(metadata.days_since_surgery, 7)
            instructions = bridge.instructions_for_caller(metadata)
            self.assertIn("has_completed_surgery=true", instructions)
            self.assertIn("Verified patient name: سجاد", instructions)
            self.assertIn("Last surgery date: 2026-09-20", instructions)
            self.assertIn("Days since surgery: 7", instructions)

    def test_unverified_surgery_adds_followup_instructions(self):
        with tempfile.TemporaryDirectory() as temp:
            call_id = str(uuid.uuid4())
            caller_lookup.write_metadata(temp, call_id, "نازنین", False)
            metadata = bridge.load_caller_metadata(temp, call_id)
            self.assertEqual(metadata.name, "نازنین")
            self.assertFalse(metadata.has_surgery_record)
            instructions = bridge.instructions_for_caller(metadata)
            self.assertIn("آیا عمل جراحی‌تون رو دکتر افلاکی انجام داده؟", instructions)
            self.assertIn("کد ملی‌تون رو با استفاده از گوشی و قسمت شماره‌گیریش", instructions)
            self.assertIn("کنید تا بتونم بررسی کنم", instructions)
            self.assertIn("verify_surgery_by_national_code", instructions)
            self.assertIn("call verify_surgery_by_national_code immediately", instructions)
            self.assertIn("Never repeat the national code aloud", instructions)
            self.assertIn("never ask the caller to confirm it", instructions)
            self.assertIn("شما [نام] هستید، درسته؟", instructions)
            self.assertIn("days_since_surgery", instructions)
            self.assertIn("روز قبل عمل کردید، درسته؟", instructions)
            self.assertIn("until the caller answers", instructions)

    def test_unknown_surgery_record_also_requires_verification(self):
        instructions = bridge.instructions_for_caller(bridge.CallerMetadata())
        self.assertIn("verification is mandatory at the beginning", instructions)
        self.assertIn("کد ملی", instructions)

    def test_completed_phone_match_skips_national_code_for_ordinary_guidance(self):
        instructions = bridge.instructions_for_caller(
            bridge.CallerMetadata(
                name="سجاد",
                has_surgery_record=True,
                last_surgery_date="2026-09-20",
                days_since_surgery=7,
            )
        )
        self.assertIn("has_completed_surgery=true", instructions)
        self.assertIn("Do not ask for the national code during an ordinary", instructions)
        self.assertIn("شما [نام] هستید و [تعداد] روز قبل عمل کردید، درسته؟", instructions)
        self.assertIn("Verified patient name: سجاد", instructions)
        self.assertIn("Days since surgery: 7", instructions)

    def test_appointment_flow_is_not_offered(self):
        instructions = bridge.instructions_for_caller(bridge.CallerMetadata())
        self.assertNotIn("send_application_link", instructions)
        self.assertNotIn("مایلید برای ویزیت دکتر افلاکی نوبت بگیرید؟", instructions)
        self.assertNotIn("لینکش براتون پیامک شد", instructions)
        self.assertIn("Never offer appointment booking or an application link", instructions)

    def test_missing_appointment_countdown_must_never_be_spoken(self):
        instructions = bridge.instructions_for_caller(bridge.CallerMetadata())
        self.assertIn("تا زمان نوبت شما", instructions)
        self.assertIn("never speak a sentence with a missing number", instructions)

    def test_verified_emergency_items_notify_postoperative_support(self):
        instructions = bridge.instructions_for_caller(
            bridge.CallerMetadata(has_surgery_record=True)
        )
        self.assertIn("severe, heavy, persistent, or uncontrolled nasal bleeding", instructions)
        self.assertIn("suspected significant infection", instructions)
        self.assertIn("send_emergency_sms", instructions)
        self.assertIn("national code has also been collected", instructions)
        self.assertIn("شرایط شما اضطراری است", instructions)
        self.assertIn("بچه‌های پشتیبانی پس از عمل", instructions)
        self.assertIn("say only that exact sentence", instructions)
        self.assertIn("115 or emergency services", instructions)
        self.assertIn("keep the call open and listen", instructions)
        self.assertIn("do not end the conversation", instructions)
        self.assertIn("calling 115", instructions)


class CallerLookupTests(unittest.TestCase):
    def test_agi_preserves_fixed_caller_number_when_phone_lookup_fails(self):
        with mock.patch.object(caller_lookup, "read_agi_environment"), mock.patch.object(
            caller_lookup, "load_env", return_value={"CRM_METADATA_DIR": "/tmp/test-callers"}
        ), mock.patch.object(
            caller_lookup, "api_lookup_payload", side_effect=TimeoutError
        ), mock.patch.object(
            caller_lookup, "write_metadata"
        ) as write_metadata, mock.patch.object(
            sys, "argv", ["caller_lookup.py", "00000000-0000-0000-0000-000000000001", "22498671"]
        ), mock.patch("builtins.print"):
            caller_lookup.main()
        write_metadata.assert_called_once_with(
            "/tmp/test-callers",
            "00000000-0000-0000-0000-000000000001",
            "",
            None,
            "22498671",
            "",
            None,
        )

    def test_normalizes_iranian_mobile_formats(self):
        self.assertEqual(caller_lookup.normalize_phone("+98 912 123 4567"), "09121234567")
        self.assertEqual(caller_lookup.normalize_phone("۹۱۲۱۲۳۴۵۶۷"), "09121234567")
        self.assertEqual(caller_lookup.normalize_phone("09121234567"), "09121234567")

    def test_sanitizes_crm_name(self):
        self.assertEqual(caller_lookup.sanitize_name("  علی رضایی!\n"), "علی رضایی")
        self.assertEqual(caller_lookup.sanitize_name(None), "")

    def test_detects_surgery_record_from_crm_flags(self):
        self.assertFalse(caller_lookup.surgery_record_status({
            "has_future_surgery_appointment": False,
            "has_surgery_appointment": False,
            "has_past_surgery_appointment": False,
            "has_completed_surgery": False,
        }))
        self.assertTrue(caller_lookup.surgery_record_status({
            "has_completed_surgery": True,
        }))
        self.assertIsNone(caller_lookup.surgery_record_status({}))

    def test_only_completed_surgery_authorizes_postoperative_guidance(self):
        self.assertFalse(caller_lookup.completed_surgery_status({
            "has_past_surgery_appointment": True,
            "has_completed_surgery": False,
        }))
        self.assertTrue(caller_lookup.completed_surgery_status({
            "has_completed_surgery": True,
        }))
        self.assertIsNone(caller_lookup.completed_surgery_status({}))

    def test_normalizes_only_requested_national_code_format(self):
        self.assertEqual(caller_lookup.normalize_national_code("۰۰۱۲ ۳۴۵ ۶۷۸"), "0012345678")
        self.assertEqual(caller_lookup.normalize_national_code("1012345678"), "")
        self.assertEqual(caller_lookup.normalize_national_code("001234567"), "")

    def test_national_code_lookup_posts_json_and_maps_verified_result(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _limit):
                return json.dumps({
                    "matched": True,
                    "name": "علی رضایی",
                    "has_future_surgery_appointment": False,
                    "has_surgery_appointment": False,
                    "has_past_surgery_appointment": True,
                    "has_completed_surgery": True,
                    "days_since_surgery": 25,
                }).encode()

        config = {
            "CRM_API_URL": "https://crm.example/api/v1/voip/surgery-status",
            "CRM_API_USERNAME": "user",
            "CRM_API_PASSWORD": "pass",
        }
        with mock.patch("caller_lookup.urllib.request.urlopen", return_value=Response()) as opened:
            result = caller_lookup.api_lookup_by_national_code(config, "۰۰۱۲۳۴۵۶۷۸")
        request = opened.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.full_url, "https://crm.example/api/v1/voip/surgery-status/by-national-code")
        self.assertEqual(json.loads(request.data), {"national_code": "0012345678"})
        self.assertEqual(result, {
            "status": "verified", "has_surgery_record": True, "name": "علی رضایی",
            "days_since_surgery": 25,
        })

    def test_invalid_national_code_never_calls_api(self):
        with mock.patch("caller_lookup.urllib.request.urlopen") as opened:
            result = caller_lookup.api_lookup_by_national_code({}, "1012345678")
        self.assertEqual(result, {"status": "invalid", "reason": "invalid_national_code"})
        opened.assert_not_called()

    def test_application_link_posts_confirmed_mobile(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _limit):
                return b'{"success":true}'

        config = {
            "CRM_API_URL": "https://crm.example/api/v1/voip/surgery-status",
            "CRM_API_USERNAME": "user",
            "CRM_API_PASSWORD": "pass",
        }
        with mock.patch("caller_lookup.urllib.request.urlopen", return_value=Response()) as opened:
            result = caller_lookup.send_application_link(config, "۰۹۱۲۱۲۳۴۵۶۷")
        request = opened.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            request.full_url,
            "https://crm.example/api/v1/voip/surgery-status/application-link",
        )
        self.assertEqual(json.loads(request.data), {"mobile": "09121234567"})
        self.assertEqual(result, {"status": "sent"})

    def test_invalid_application_mobile_never_calls_api(self):
        with mock.patch("caller_lookup.urllib.request.urlopen") as opened:
            result = caller_lookup.send_application_link({}, "02112345678")
        self.assertEqual(result, {"status": "invalid", "reason": "invalid_mobile"})
        opened.assert_not_called()

    def test_emergency_sms_posts_identifiers_name_and_complaint_summary(self):
        class Response:
            status = 201

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _limit):
                return b'{"message":"success"}'

        config = {
            "CRM_API_URL": "https://crm.example/api/v1/voip/surgery-status",
            "CRM_API_USERNAME": "user",
            "CRM_API_PASSWORD": "pass",
        }
        with mock.patch("caller_lookup.urllib.request.urlopen", return_value=Response()) as opened:
            result = caller_lookup.send_emergency_sms(
                config,
                "۰۹۱۲۱۲۳۴۵۶۷",
                "۰۰۱۲۳۴۵۶۷۸",
                "  نازنین   رضایی  ",
                " بیمار خون‌ریزی شدید دارد. \r\n لطفاً سریع تماس گرفته شود. ",
            )
        request = opened.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            request.full_url,
            "https://crm.example/api/v1/voip/surgery-status/emergency-sms",
        )
        self.assertEqual(json.loads(request.data), {
            "mobile": "09121234567",
            "national_code": "0012345678",
            "name": "نازنین رضایی",
            "summary": "بیمار خون‌ریزی شدید دارد.\nلطفاً سریع تماس گرفته شود.",
        })
        self.assertEqual(result, {"status": "sent"})

    def test_emergency_sms_rejects_missing_identifiers(self):
        with mock.patch("caller_lookup.urllib.request.urlopen") as opened:
            invalid_mobile = caller_lookup.send_emergency_sms(
                {}, "", "0012345678"
            )
            invalid_code = caller_lookup.send_emergency_sms(
                {}, "09121234567", "1012345678"
            )
            missing_summary = caller_lookup.send_emergency_sms(
                {}, "09121234567", "0012345678", "نازنین"
            )
            missing_name = caller_lookup.send_emergency_sms(
                {}, "09121234567", "0012345678", "", "درخواست تماس فوری دارد."
            )
        self.assertEqual(invalid_mobile, {"status": "invalid", "reason": "caller_number_missing"})
        self.assertEqual(invalid_code, {"status": "invalid", "reason": "invalid_national_code"})
        self.assertEqual(missing_summary, {"status": "invalid", "reason": "summary_missing"})
        self.assertEqual(missing_name, {"status": "invalid", "reason": "name_missing"})
        opened.assert_not_called()


class OutboundApiTests(unittest.TestCase):
    def test_accepts_only_iranian_mobile_format(self):
        self.assertIsNotNone(outbound_api.MOBILE_PATTERN.fullmatch("09121234567"))
        self.assertIsNone(outbound_api.MOBILE_PATTERN.fullmatch("02112345678"))
        self.assertIsNone(outbound_api.MOBILE_PATTERN.fullmatch("09121234567;reload"))

    def test_rate_limiter_blocks_duplicate_and_excess_calls(self):
        limiter = outbound_api.RateLimiter(2, 60)
        self.assertTrue(limiter.allow("09121234567"))
        self.assertFalse(limiter.allow("09121234567"))
        self.assertTrue(limiter.allow("09121234568"))
        self.assertFalse(limiter.allow("09121234569"))


class AppointmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = bridge.AppointmentStore(os.path.join(self.temp.name, "appointments.db"))

    def tearDown(self):
        self.temp.cleanup()

    def test_book_and_prevent_double_booking(self):
        slot = self.store.available_slots()
        result = self.store.book("علی رضایی", "09121234567", slot["date"], slot["times"][0])
        self.assertEqual(result["status"], "booked")
        conflict = self.store.book("مریم احمدی", "09121234568", slot["date"], slot["times"][0])
        self.assertEqual(conflict["status"], "conflict")

    def test_persian_phone_normalization(self):
        self.assertEqual(self.store.normalize_phone("۰۹۱۲ ۱۲۳ ۴۵۶۷"), "09121234567")


if __name__ == "__main__":
    unittest.main(verbosity=2)
