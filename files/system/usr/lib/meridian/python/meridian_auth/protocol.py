"""Wire protocol of the Meridian Defence Ledger app. Pure functions, no I/O.

Sign request (single APDU, CLA=E0 INS=06 P1=00 P2=00):

    slot(4, big endian) | action(1) | nonce(32) | host_len(1) | host | info_len(1) | info

The device shows action, host, info, slot and a check code, then signs

    digest = SHA-256( b"MERIDIAN-AUTH-V1" || request bytes )

with ECDSA P-256 (RFC 6979) using the key at m/19781'/0'/slot'. The reply is a DER
signature. The check code is the first 6 bytes of the digest, so comparing it between
PC and device screen confirms every field at once.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed

CLA = 0xE0
INS_GET_VERSION = 0x03
INS_GET_APP_NAME = 0x04
INS_GET_PUBLIC_KEY = 0x05
INS_SIGN_CHALLENGE = 0x06
INS_GET_STATUS = 0x07
INS_KEEPALIVE = 0x08
INS_DERIVE_SECRET = 0x09
INS_GET_EVENTS = 0x0A          # app >= 1.2.0: pending on-device events, cleared on read

INS_REGISTER_PC = 0x0B         # app >= 1.4.0: register this computer's key (hold + PIN)
INS_LIST_PCS = 0x0C            # app >= 1.4.0: bound flag + registered computers
P2_PC_SIGNED = 0x01            # INS 06/09: body | sig_len | DER sig by a registered computer

EVT_LOCKDOWN = 0x01            # "Lock down PC" approved on the Ledger (hold)
EVT_DURESS = 0x02              # app >= 1.4.0: the duress PIN was used: lock down now

PC_DOMAIN = b"MERIDIAN-PC-V1"
PC_REG_DOMAIN = b"MERIDIAN-PC-REG-V1"
PC_NAME_MAX = 16
MAX_PCS = 4

SW_OK = 0x9000
SW_REJECTED = 0x6985
SW_SECURITY = 0x6982
SW_INCORRECT_DATA = 0x6A80
SW_INCORRECT_P1_P2 = 0x6A86
SW_WRONG_LENGTH = 0x6A87
SW_INVALID_INS = 0x6D00
SW_INVALID_CLA = 0x6E00
SW_REVIEW_CANCELLED = 0xB001
SW_BUSY = 0x6901
SW_LOCKED = 0x5515
SW_PIN_NOT_SET = 0xB002
SW_PIN_BLOCKED = 0x6983
SW_PIN_WRONG_BASE = 0x63C0  # | tries left
SW_DURESS = 0xB003          # app >= 1.4.0: duress PIN entered, nothing released. LOCK DOWN.
SW_PC_UNKNOWN = 0xB004      # app >= 1.4.0: not signed by a registered computer
SW_PC_FULL = 0xB005         # app >= 1.4.0: 4 computers registered already

SW_TEXT = {
    SW_REJECTED: "rejected on the device",
    SW_SECURITY: "key derivation or signing refused by the device",
    SW_INCORRECT_DATA: "device rejected the request contents",
    SW_INCORRECT_P1_P2: "bad P1/P2",
    SW_WRONG_LENGTH: "bad request length",
    SW_INVALID_INS: "unknown instruction (is the Meridian Auth app open?)",
    SW_INVALID_CLA: "unknown class (is the Meridian Auth app open?)",
    SW_REVIEW_CANCELLED: "a pending review on the device was cancelled",
    SW_BUSY: "device is busy with a request that is waiting on its screen",
    SW_PIN_NOT_SET: "no Meridian PIN set on the device yet (set it from the app's home screen)",
    SW_PIN_BLOCKED: "Meridian PIN is blocked; delete and reinstall the app to reset it",
    SW_LOCKED: "device is locked, enter its PIN",
    SW_DURESS: "Ledger request failed",  # deliberately vague: whoever watches the PC must not learn
    SW_PC_UNKNOWN: "this computer is not registered on the Ledger",
    SW_PC_FULL: "the Ledger already has 4 computers; remove one in Settings > Computers",
}

ACTION_TEST = 0x01           # "Verify identity" on the device (name kept for compatibility)
ACTION_VERIFY = ACTION_TEST
ACTION_DISARM = 0x02
ACTION_ENROLL = 0x03
ACTION_USB_UNLOCK = 0x04      # Meridian PIN required on the device
ACTION_LOG_ACCESS = 0x05      # Meridian PIN required on the device
ACTION_LOG_CHECKPOINT = 0x06  # info = hex of the log chain head
ACTION_VAULT_KEY = 0x07       # INS_DERIVE_SECRET only, Meridian PIN required
ACTION_USB_ALLOW = 0x08       # app >= 1.4.0, PIN: allow a USB device (info: name + serial)
ACTION_PROTECTION = 0x09      # app >= 1.4.0, PIN: weaken Meridian (info: the exact change)
ACTION_LABELS = {
    ACTION_TEST: "Verify identity",
    ACTION_DISARM: "Disarm airgap",
    ACTION_ENROLL: "Confirm enrollment",
    ACTION_USB_UNLOCK: "Unlock data USB",
    ACTION_LOG_ACCESS: "View security logs",
    ACTION_LOG_CHECKPOINT: "Seal security log",
    ACTION_VAULT_KEY: "Unlock disk",
    ACTION_USB_ALLOW: "Allow USB device",
    ACTION_PROTECTION: "Change protection",
}
PIN_ACTIONS = frozenset({ACTION_USB_UNLOCK, ACTION_LOG_ACCESS, ACTION_VAULT_KEY,
                         ACTION_USB_ALLOW, ACTION_PROTECTION})
# App 1.5.0 (Linux only) shows just these; the other codes keep their numbers but the device
# refuses them like an unknown action (0x6A80), with no prompt.
DEVICE_ACTIONS_1_5 = frozenset({ACTION_TEST, ACTION_ENROLL, ACTION_VAULT_KEY})

DOMAIN = b"MERIDIAN-AUTH-V1"
KDF_DOMAIN = b"MERIDIAN-KDF-V1"
SECRET_LEN = 32
NONCE_LEN = 32
HOST_MAX_LEN = 32
INFO_MAX_LEN = 96
MAX_SLOT = 0x7FFFFFFF
PUBKEY_LEN = 65


class ProtocolError(Exception):
    pass


class DeviceError(ProtocolError):
    def __init__(self, sw: int):
        self.sw = sw
        if sw & 0xFFF0 == SW_PIN_WRONG_BASE:
            text = f"wrong Meridian PIN, {sw & 0x0F} tries left"
        else:
            text = SW_TEXT.get(sw, "unexpected status")
        super().__init__(f"device returned 0x{sw:04X}: {text}")


def apdu(ins: int, p1: int = 0, p2: int = 0, data: bytes = b"") -> bytes:
    if len(data) > 255:
        raise ProtocolError("APDU data too long")
    return bytes([CLA, ins, p1, p2, len(data)]) + data


def _printable(s: str, what: str, lo: int, hi: int) -> bytes:
    try:
        b = s.encode("ascii")
    except UnicodeEncodeError:
        raise ProtocolError(f"{what} must be ASCII") from None
    if not lo <= len(b) <= hi:
        raise ProtocolError(f"{what} must be {lo}..{hi} characters")
    if any(c < 0x20 or c > 0x7E for c in b):
        raise ProtocolError(f"{what} must be printable ASCII")
    return b


@dataclass(frozen=True)
class SignRequest:
    slot: int
    action: int
    nonce: bytes
    host: str
    info: str = ""

    @classmethod
    def new(cls, slot: int, action: int, host: str, info: str = "") -> "SignRequest":
        """Fresh request with a random 32-byte nonce from the OS CSPRNG."""
        return cls(slot, action, os.urandom(NONCE_LEN), host, info)

    def encode(self) -> bytes:
        if not 0 <= self.slot <= MAX_SLOT:
            raise ProtocolError("slot out of range")
        if self.action not in ACTION_LABELS:
            raise ProtocolError("unknown action")
        if len(self.nonce) != NONCE_LEN:
            raise ProtocolError("nonce must be 32 bytes")
        host = _printable(self.host, "host", 1, HOST_MAX_LEN)
        info = _printable(self.info, "info", 0, INFO_MAX_LEN)
        return (
            self.slot.to_bytes(4, "big")
            + bytes([self.action])
            + self.nonce
            + bytes([len(host)])
            + host
            + bytes([len(info)])
            + info
        )

    def digest(self) -> bytes:
        domain = KDF_DOMAIN if self.action == ACTION_VAULT_KEY else DOMAIN
        return hashlib.sha256(domain + self.encode()).digest()

    def check_code(self) -> str:
        return format_code(self.digest())


def format_code(digest: bytes) -> str:
    """'XXXX XXXX XXXX' from the first 6 bytes, as shown on the device."""
    h = digest[:6].hex().upper()
    return " ".join(h[i : i + 4] for i in range(0, 12, 4))


def fingerprint(pubkey: bytes) -> str:
    return format_code(hashlib.sha256(pubkey).digest())


def load_pubkey(raw: bytes) -> ec.EllipticCurvePublicKey:
    if len(raw) != PUBKEY_LEN or raw[0] != 0x04:
        raise ProtocolError("public key must be 65 bytes, uncompressed")
    try:
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError as e:
        raise ProtocolError(f"invalid public key: {e}") from None


def verify(pubkey: bytes, request: SignRequest, signature: bytes) -> bool:
    """True only if `signature` is a valid signature by `pubkey` over exactly `request`."""
    if request.action == ACTION_VAULT_KEY:
        return False  # that action is never signed, it only releases a secret
    try:
        load_pubkey(pubkey).verify(
            signature, request.digest(), ec.ECDSA(Prehashed(hashes.SHA256()))
        )
        return True
    except (InvalidSignature, ValueError):
        return False


# ---- registered computers (app >= 1.4.0) ------------------------------------------------
class PcKey:
    """The computer's own P-256 key. Reference/test implementation in software; Meridian keeps
    this key non-exportable in the TPM and only needs the same two operations."""

    def __init__(self, private: ec.EllipticCurvePrivateKey | None = None):
        self.private = private or ec.generate_private_key(ec.SECP256R1())

    @property
    def pubkey(self) -> bytes:
        from cryptography.hazmat.primitives import serialization
        return self.private.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)

    def sign(self, domain: bytes, data: bytes) -> bytes:
        """DER ECDSA-P256-SHA256 over domain || data."""
        return self.private.sign(domain + data, ec.ECDSA(hashes.SHA256()))


def register_payload(name: str, key: PcKey) -> bytes:
    """INS 0x0B body: name_len | name | pubkey | sig_len | proof (signature over REG domain)."""
    n = _printable(name, "computer name", 1, PC_NAME_MAX)
    signed = bytes([len(n)]) + n + key.pubkey
    proof = key.sign(PC_REG_DOMAIN, signed)
    return signed + bytes([len(proof)]) + proof


def pc_signed(body: bytes, key: PcKey) -> bytes:
    """INS 06/09 with P2=0x01: the unchanged request body, then sig_len | signature."""
    sig = key.sign(PC_DOMAIN, body)
    return body + bytes([len(sig)]) + sig


def parse_pc_list(raw: bytes) -> tuple[bool, list[tuple[str, str]]]:
    """INS 0x0C answer -> (bound, [(fingerprint, name), ...])."""
    if len(raw) < 2:
        raise ProtocolError("bad computer list")
    bound, count, off, out = bool(raw[0]), raw[1], 2, []
    for _ in range(count):
        if off + 7 > len(raw):
            raise ProtocolError("bad computer list")
        fp, n = raw[off:off + 6], raw[off + 6]
        name = raw[off + 7:off + 7 + n].decode("ascii", "replace")
        out.append((format_code(fp + bytes(26)), name))
        off += 7 + n
    return bound, out
