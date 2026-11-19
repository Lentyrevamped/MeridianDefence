"""Meridian OS: Ledger sign-in for GDM and the lock screen (Meridian Ledger app 1.5, "Verify identity").

Used by /usr/libexec/meridian/ledger-login (PAM, gdm-password only) and /usr/bin/meridian-ledger (enrol, test,
disable). The text printed for the user follows the Meridian contract that the login screen understands:

    Confirm on your Ledger · code XXXX XXXX XXXX
    Approved on Ledger
    Rejected on Ledger

Security model:
- A fresh 32-byte nonce per attempt; the Ledger signs SHA256("MERIDIAN-AUTH-V1" || request) and the signature
  is checked here against the public key enrolled by root. The device's answer is never trusted by itself.
- Enrolment files live in /etc/meridian/ledger/<user>.json, must be owned by root and not group/world writable.
- Only GDM's password service uses this. Text consoles (login), sudo/run0 and polkit keep the password, so a
  lost or broken Ledger never locks the owner out: log in on Ctrl+Alt+F3 and run `run0 meridian-ledger disable`.
"""
from __future__ import annotations

import json
import os
import re
import select
import socket
import stat
import time
from pathlib import Path

from meridian_auth import protocol as P
from meridian_auth.client import Client
from meridian_auth.transport import Deframer, TransportError, frame

ENROLL_DIR = Path("/etc/meridian/ledger")
SLOT = 0
INFO = "Linux sign-in"
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
WAIT_FOR_DEVICE = 60.0      # seconds to wait for the Ledger to be plugged in and the app opened
WAIT_FOR_APPROVAL = 90.0    # seconds to wait for the hold on the device

MSG_CONFIRM = "Confirm on your Ledger · code {code}"
MSG_OK = "Approved on Ledger"
MSG_REJECTED = "Rejected on Ledger"
MSG_CONNECT = "Connect your Ledger and open the Meridian app"


class LoginError(Exception):
    """Refused. The message is safe to show on the login screen."""


# ---- hidraw transport (no extra Python packages needed) ---------------------------------------------
LEDGER_VID = "00002C97"


def _ledger_hidraw() -> str | None:
    """/dev/hidrawN of the Ledger's APDU interface (HID usage page 0xFFA0), if one is connected."""
    base = Path("/sys/class/hidraw")
    if not base.is_dir():
        return None
    for node in sorted(base.iterdir()):
        try:
            uevent = (node / "device" / "uevent").read_text()
            desc = (node / "device" / "report_descriptor").read_bytes()
        except OSError:
            continue
        hid_id = next((l.split("=", 1)[1] for l in uevent.splitlines() if l.startswith("HID_ID=")), "")
        if LEDGER_VID not in hid_id.upper():
            continue
        if desc[:3] == b"\x06\xa0\xff":  # Usage Page (Vendor 0xFFA0) = APDU channel, not FIDO (0xF1D0)
            return f"/dev/{node.name}"
    return None


class HidrawTransport:
    def __init__(self, path: str):
        try:
            self._fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
        except OSError as e:
            raise TransportError(f"cannot open {path}: {e.strerror}") from None

    def exchange(self, apdu: bytes, timeout: float = 120.0) -> tuple[bytes, int]:
        try:
            for p in frame(apdu):
                os.write(self._fd, b"\x00" + p)  # report id 0
            de, deadline = Deframer(), time.monotonic() + timeout
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TransportError("timed out waiting for the device")
                r, _, _ = select.select([self._fd], [], [], min(left, 0.5))
                if not r:
                    continue
                resp = de.feed(os.read(self._fd, 64))
                if resp is not None:
                    break
        except OSError as e:
            raise TransportError(f"USB error (Ledger removed?): {e.strerror}") from None
        if len(resp) < 2:
            raise TransportError("short response")
        return resp[:-2], int.from_bytes(resp[-2:], "big")

    def close(self) -> None:
        os.close(self._fd)


def open_ledger(say, wait: float = WAIT_FOR_DEVICE, still_wanted=None):
    """Wait for the Ledger with the Meridian app open. Returns a transport.
    still_wanted(): checked while waiting; False stops at once (e.g. `meridian-ledger disable` ran meanwhile)."""
    deadline, told = time.monotonic() + wait, False
    while True:
        if still_wanted is not None and not still_wanted():
            raise LoginError("Ledger sign-in was turned off")
        path = _ledger_hidraw()
        if path:
            t = HidrawTransport(path)
            try:
                name = Client(t).app_name()
                if name.startswith("Meridian"):
                    return t
            except (TransportError, P.ProtocolError):
                pass  # dashboard open or another app: keep waiting
            t.close()
        if not told:
            say(MSG_CONNECT)
            told = True
        if time.monotonic() > deadline:
            raise LoginError("No Ledger with the Meridian app found")
        time.sleep(0.5)


# ---- enrolment store --------------------------------------------------------------------------------
def host_name() -> str:
    h = socket.gethostname().split(".")[0].upper()
    h = re.sub(r"[^A-Z0-9-]", "", h)[: P.HOST_MAX_LEN]
    return h or "MERIDIAN"


def check_user(user: str) -> str:
    if not user or not USER_RE.match(user):
        raise LoginError("Invalid user name")
    return user


def enrollment_path(user: str) -> Path:
    return ENROLL_DIR / f"{check_user(user)}.json"


def load_enrollment(user: str) -> tuple[int, bytes] | None:
    """(slot, pubkey) or None. Refuses files that are not root-owned or are writable by others."""
    path = enrollment_path(user)
    try:
        st = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise LoginError("Ledger enrolment file has unsafe permissions")
    for parent in (ENROLL_DIR, ENROLL_DIR.parent):
        pst = os.stat(parent)
        if pst.st_uid != 0 or pst.st_mode & 0o022:
            raise LoginError("Ledger enrolment folder has unsafe permissions")
    d = json.loads(path.read_text())
    pub = bytes.fromhex(d["pubkey"])
    P.load_pubkey(pub)  # length + on-curve check
    return int(d.get("slot", SLOT)), pub


def save_enrollment(user: str, slot: int, pubkey: bytes) -> Path:
    ENROLL_DIR.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chmod(ENROLL_DIR.parent, 0o755)
    os.chmod(ENROLL_DIR, 0o755)
    path = enrollment_path(user)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "user": user, "slot": slot, "pubkey": pubkey.hex(), "fingerprint": P.fingerprint(pubkey),
        "host": host_name(), "enrolled_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }, indent=2) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return path


# ---- the sign-in check ------------------------------------------------------------------------------
def _device_error(e: P.DeviceError) -> LoginError:
    if e.sw in (P.SW_REJECTED, P.SW_REVIEW_CANCELLED):
        return LoginError(MSG_REJECTED)
    if e.sw == P.SW_BUSY:
        return LoginError("Finish or reject the request waiting on your Ledger, then try again")
    if e.sw == P.SW_LOCKED:
        return LoginError("Unlock your Ledger, then try again")
    if e.sw == P.SW_PC_UNKNOWN:
        return LoginError("This Ledger only accepts registered computers")
    return LoginError("Ledger sign-in failed")  # duress and everything else: deliberately generic


def verify_with_ledger(transport, slot: int, pubkey: bytes, say, info: str = INFO,
                       action: int = P.ACTION_VERIFY) -> None:
    """One sign-in attempt. Returns on success, raises LoginError otherwise."""
    client = Client(transport)
    req = P.SignRequest.new(slot, action, host_name(), info)
    say(MSG_CONFIRM.format(code=req.check_code()))
    try:
        sig = client._call(P.INS_SIGN_CHALLENGE, 0, req.encode(), timeout=WAIT_FOR_APPROVAL)
    except P.DeviceError as e:
        raise _device_error(e) from None
    except TransportError as e:
        raise LoginError(f"Ledger connection lost: {e}") from None
    if not P.verify(pubkey, req, sig):
        raise LoginError("Ledger answer did not verify")
    say(MSG_OK)


def login(user: str, say, transport=None) -> None:
    """Full flow for PAM: enrolment lookup -> wait for device -> approval -> verify."""
    enr = load_enrollment(check_user(user))
    if enr is None:
        raise LoginError("No Ledger enrolled for this user")
    slot, pub = enr
    own = transport is None
    t = transport or open_ledger(say, still_wanted=lambda: enrollment_path(user).exists())
    try:
        verify_with_ledger(t, slot, pub, say)
    finally:
        if own:
            t.close()
