#!/usr/bin/python3
"""Fail-open Asterisk AGI caller-name lookup for the clinic CRM."""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.error
import urllib.request
import uuid
from pathlib import Path


CONFIG_PATH = os.environ.get("CRM_CONFIG_PATH", "/etc/asterisk-ai/crm.env")
DEFAULT_METADATA_DIR = "/var/lib/asterisk-ai/callers"
MAX_RESPONSE_BYTES = 65536


def read_agi_environment() -> None:
    for line in sys.stdin:
        if not line.strip():
            break


def load_env(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def normalize_phone(value: str) -> str:
    translated = value.translate(
        str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
    )
    digits = re.sub(r"\D", "", translated)
    if digits.startswith("0098"):
        digits = "0" + digits[4:]
    elif digits.startswith("98"):
        digits = "0" + digits[2:]
    elif len(digits) == 10 and digits.startswith("9"):
        digits = "0" + digits
    return digits


def normalize_national_code(value: object) -> str:
    """Normalize spoken/Persian digits, while accepting only the requested format."""
    if not isinstance(value, str):
        return ""
    translated = value.translate(
        str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
    )
    digits = re.sub(r"[\s-]", "", translated)
    return digits if re.fullmatch(r"0\d{9}", digits) else ""


def sanitize_name(value: object) -> str:
    if not isinstance(value, str):
        return ""
    name = " ".join(value.split())[:80].strip()
    name = "".join(char for char in name if char.isalpha() or char in " ‌-'ـ")
    return " ".join(name.split()).strip(" -'")


def sanitize_emergency_summary(value: object) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t\f\v]+", " ", line).strip() for line in normalized.split("\n")]
    summary = "\n".join(line for line in lines if line).strip()
    return "".join(
        char for char in summary if char in {"\n", "‌"} or char.isprintable()
    )[:1000]


def api_lookup_payload(config: dict[str, str], phone: str) -> dict:
    base_url = config["CRM_API_URL"]
    username = config["CRM_API_USERNAME"]
    password = config["CRM_API_PASSWORD"]
    timeout = min(3.0, max(0.5, float(config.get("CRM_API_TIMEOUT", "2.5"))))
    separator = "&" if "?" in base_url else "?"
    url = f"{base_url}{separator}{urllib.parse.urlencode({'mobile': phone})}"
    token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Basic {token}", "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status < 200 or response.status >= 300:
            return {}
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            return {}
    payload = json.loads(raw.decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def api_lookup_by_national_code(config: dict[str, str], national_code: str) -> dict:
    """Look up surgery status without placing the national code in the URL."""
    normalized = normalize_national_code(national_code)
    if not normalized:
        return {"status": "invalid", "reason": "invalid_national_code"}

    base_url = config["CRM_API_URL"].rstrip("/")
    url = config.get(
        "CRM_NATIONAL_CODE_API_URL",
        f"{base_url}/by-national-code",
    )
    username = config["CRM_API_USERNAME"]
    password = config["CRM_API_PASSWORD"]
    timeout = min(3.0, max(0.5, float(config.get("CRM_API_TIMEOUT", "2.5"))))
    token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    body = json.dumps({"national_code": normalized}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                return {"status": "error", "reason": "lookup_unavailable"}
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return {"status": "error", "reason": "invalid_response"}
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return {"status": "error", "reason": "lookup_unavailable"}

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"status": "error", "reason": "invalid_response"}
    if not isinstance(payload, dict) or not isinstance(payload.get("matched"), bool):
        return {"status": "error", "reason": "invalid_response"}
    if payload["matched"] is False:
        return {"status": "not_found", "reason": "patient_not_found"}

    surgery_status = completed_surgery_status(payload)
    if surgery_status is True:
        result = {"status": "verified", "has_surgery_record": True}
        name = sanitize_name(payload.get("name"))
        if name:
            result["name"] = name
        days_since_surgery = payload.get("days_since_surgery")
        if (
            isinstance(days_since_surgery, int)
            and not isinstance(days_since_surgery, bool)
            and days_since_surgery >= 0
        ):
            result["days_since_surgery"] = days_since_surgery
        return result
    if surgery_status is False:
        return {"status": "not_found", "reason": "no_surgery_record"}
    return {"status": "error", "reason": "invalid_response"}


def send_application_link(config: dict[str, str], mobile: str) -> dict:
    """Ask CRM to send the clinic application link to a confirmed mobile."""
    normalized = normalize_phone(mobile)
    if not re.fullmatch(r"09\d{9}", normalized):
        return {"status": "invalid", "reason": "invalid_mobile"}

    base_url = config["CRM_API_URL"].rstrip("/")
    url = config.get(
        "CRM_APPLICATION_LINK_API_URL",
        f"{base_url}/application-link",
    )
    username = config["CRM_API_USERNAME"]
    password = config["CRM_API_PASSWORD"]
    timeout = min(3.0, max(0.5, float(config.get("CRM_API_TIMEOUT", "2.5"))))
    token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    body = json.dumps({"mobile": normalized}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                return {"status": "error", "reason": "send_unavailable"}
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return {"status": "error", "reason": "invalid_response"}
    except urllib.error.HTTPError as exc:
        if exc.code == 422:
            return {"status": "invalid", "reason": "invalid_mobile"}
        return {"status": "error", "reason": "send_unavailable"}
    except (urllib.error.URLError, TimeoutError, OSError):
        return {"status": "error", "reason": "send_unavailable"}
    return {"status": "sent"}


def send_emergency_sms(
    config: dict[str, str],
    mobile: str,
    national_code: str,
    name: str = "",
    summary: str = "",
) -> dict:
    """Notify the CRM-configured postoperative support recipient."""
    normalized_mobile = normalize_phone(mobile)
    normalized_code = normalize_national_code(national_code)
    if not normalized_mobile:
        return {"status": "invalid", "reason": "caller_number_missing"}
    if not normalized_code:
        return {"status": "invalid", "reason": "invalid_national_code"}
    sanitized_name = sanitize_name(name)
    if not sanitized_name:
        return {"status": "invalid", "reason": "name_missing"}
    sanitized_summary = sanitize_emergency_summary(summary)
    if not sanitized_summary:
        return {"status": "invalid", "reason": "summary_missing"}
    base_url = config["CRM_API_URL"].rstrip("/")
    url = config.get(
        "CRM_EMERGENCY_SMS_API_URL",
        f"{base_url}/emergency-sms",
    )
    username = config["CRM_API_USERNAME"]
    password = config["CRM_API_PASSWORD"]
    timeout = min(3.0, max(0.5, float(config.get("CRM_API_TIMEOUT", "2.5"))))
    token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    body = {
        "name": sanitized_name,
        "mobile": normalized_mobile,
        "national_code": normalized_code,
        "summary": sanitized_summary,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                return {"status": "error", "reason": "send_unavailable"}
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return {"status": "error", "reason": "invalid_response"}
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return {"status": "error", "reason": "send_unavailable"}
    return {"status": "sent"}


def api_lookup(config: dict[str, str], phone: str) -> str:
    """Return only the caller name for compatibility with existing callers."""
    return sanitize_name(api_lookup_payload(config, phone).get("name"))


def surgery_record_status(payload: dict) -> bool | None:
    """Whether CRM reports any appointment/history indicating surgery."""
    fields = (
        "has_future_surgery_appointment",
        "has_surgery_appointment",
        "has_past_surgery_appointment",
        "has_completed_surgery",
    )
    values = [payload.get(field) for field in fields]
    if any(value is True for value in values):
        return True
    if all(value is False for value in values):
        return False
    return None


def completed_surgery_status(payload: dict) -> bool | None:
    """Whether CRM explicitly confirms a completed surgery with Dr. Aflaki."""
    value = payload.get("has_completed_surgery")
    return value if isinstance(value, bool) else None


def write_metadata(
    directory: str,
    call_id: str,
    name: str,
    has_surgery_record: bool | None = None,
    mobile: str = "",
    last_surgery_date: str = "",
    days_since_surgery: int | None = None,
) -> None:
    uuid.UUID(call_id)
    target_dir = Path(directory)
    target_dir.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{call_id}.", dir=target_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            metadata: dict[str, object] = {"name": name}
            if has_surgery_record is not None:
                metadata["has_surgery_record"] = has_surgery_record
            normalized_mobile = normalize_phone(mobile)
            if normalized_mobile:
                metadata["mobile"] = normalized_mobile
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", last_surgery_date):
                metadata["last_surgery_date"] = last_surgery_date
            if (
                isinstance(days_since_surgery, int)
                and not isinstance(days_since_surgery, bool)
                and days_since_surgery >= 0
            ):
                metadata["days_since_surgery"] = days_since_surgery
            json.dump(metadata, handle, ensure_ascii=False)
        os.chmod(temporary, 0o640)
        os.replace(temporary, target_dir / f"{call_id}.json")
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def agi_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def main() -> None:
    read_agi_environment()
    call_id = sys.argv[1] if len(sys.argv) > 1 else ""
    caller_number = sys.argv[2] if len(sys.argv) > 2 else ""
    name = ""
    phone = normalize_phone(caller_number)
    has_surgery_record = None
    last_surgery_date = ""
    days_since_surgery = None
    config: dict[str, str] = {}
    try:
        config = load_env(CONFIG_PATH)
        if phone:
            try:
                payload = api_lookup_payload(config, phone)
            except Exception:
                payload = {}
            name = sanitize_name(payload.get("name"))
            has_surgery_record = completed_surgery_status(payload)
            if has_surgery_record is True:
                raw_date = payload.get("last_surgery_date")
                if isinstance(raw_date, str):
                    last_surgery_date = raw_date
                raw_days = payload.get("days_since_surgery")
                if isinstance(raw_days, int) and not isinstance(raw_days, bool) and raw_days >= 0:
                    days_since_surgery = raw_days
    except Exception:
        # CRM/config failures must not discard a caller number supplied by Asterisk.
        pass
    try:
        write_metadata(
            config.get("CRM_METADATA_DIR", DEFAULT_METADATA_DIR),
            call_id,
            name,
            has_surgery_record,
            phone,
            last_surgery_date,
            days_since_surgery,
        )
    except Exception:
        # Metadata failures must not interrupt the call.
        pass
    print(f'SET VARIABLE CALLER_NAME "{agi_escape(name)}"', flush=True)


if __name__ == "__main__":
    main()
