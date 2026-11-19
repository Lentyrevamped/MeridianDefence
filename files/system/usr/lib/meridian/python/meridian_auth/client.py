"""High-level client: version, enrollment, challenge-response."""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from . import protocol as P
from .transport import Transport


def data_dir() -> Path:
    base = os.environ.get("MERIDIAN_AUTH_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share"), "MeridianAuthTest"
    )
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


@dataclass
class DeviceStatus:
    pin_set: bool
    tries_left: int
    keep_awake: bool
    max_tries: int


@dataclass
class AuthResult:
    ok: bool
    request: P.SignRequest
    signature: bytes
    detail: str


class Client:
    def __init__(self, transport: Transport, pc_key: P.PcKey | None = None):
        self.t = transport
        self.pc_key = pc_key  # app >= 1.4.0: sign 06/09 requests as a registered computer

    def _call(self, ins: int, p1: int = 0, data: bytes = b"", timeout: float = 120.0,
              p2: int = 0) -> bytes:
        resp, sw = self.t.exchange(P.apdu(ins, p1, p2, data), timeout)
        if sw != P.SW_OK:
            raise P.DeviceError(sw)
        return resp

    def app_name(self) -> str:
        return self._call(P.INS_GET_APP_NAME, timeout=5).decode("ascii", "replace")

    def version(self) -> str:
        v = self._call(P.INS_GET_VERSION, timeout=5)
        if len(v) != 3:
            raise P.ProtocolError("bad version response")
        return ".".join(str(b) for b in v)

    def get_public_key(self, slot: int, confirm: bool) -> bytes:
        pk = self._call(P.INS_GET_PUBLIC_KEY, 1 if confirm else 0, slot.to_bytes(4, "big"))
        P.load_pubkey(pk)  # validates length and that the point is on P-256
        return pk

    def _request(self, ins: int, body: bytes) -> bytes:
        if self.pc_key is not None:
            return self._call(ins, 0, P.pc_signed(body, self.pc_key), p2=P.P2_PC_SIGNED)
        return self._call(ins, 0, body)

    def sign(self, request: P.SignRequest) -> bytes:
        return self._request(P.INS_SIGN_CHALLENGE, request.encode())

    def register_pc(self, name: str, key: P.PcKey) -> int:
        """Register `key` as a computer allowed to send requests (hold + PIN on the device).
        Returns its slot on the Ledger. Already registered: returns at once, no prompt."""
        r = self._call(P.INS_REGISTER_PC, 0, P.register_payload(name, key))
        if len(r) != 1:
            raise P.ProtocolError("bad register response")
        return r[0]

    def list_pcs(self) -> tuple[bool, list[tuple[str, str]]]:
        return P.parse_pc_list(self._call(P.INS_LIST_PCS, timeout=5))

    def status(self) -> DeviceStatus:
        r = self._call(P.INS_GET_STATUS, timeout=5)
        if len(r) != 4:
            raise P.ProtocolError("bad status response")
        return DeviceStatus(bool(r[0]), r[1], bool(r[2]), r[3])

    def keepalive(self) -> bool:
        """Ask the device to stay awake. False if the on-device 'Stay awake' switch is off."""
        return self._call(P.INS_KEEPALIVE, timeout=5) == b"\x01"

    def events(self) -> int:
        """Pending on-device events (bit flags, P.EVT_*). Reading clears them. Needs app 1.2.0+;
        older apps answer 0x6D00 (unknown INS), which the caller should treat as 'no events'."""
        r = self._call(P.INS_GET_EVENTS, timeout=5)
        if len(r) != 1:
            raise P.ProtocolError("bad events response")
        return r[0]

    def derive_secret(self, slot: int, salt: bytes, host: str, info: str = "",
                      on_request=None) -> bytes:
        """32-byte secret bound to (seed, slot, salt). Needs review + Meridian PIN on the device.

        The secret crosses USB in the clear. Treat it as one share of a key, never the whole key.
        """
        req = P.SignRequest(slot, P.ACTION_VAULT_KEY, salt, host, info)
        if on_request:
            on_request(req)
        out = self._request(P.INS_DERIVE_SECRET, req.encode())
        if len(out) != P.SECRET_LEN:
            raise P.ProtocolError("bad secret length")
        return out

    def authenticate(self, pubkey: bytes, slot: int, action: int, host: str, info: str = "",
                     on_request=None) -> AuthResult:
        """Fresh challenge -> device approval -> verify against the ENROLLED key."""
        req = P.SignRequest.new(slot, action, host, info)
        if on_request:
            on_request(req)
        sig = self.sign(req)
        ok = P.verify(pubkey, req, sig)
        return AuthResult(ok, req, sig, "signature valid" if ok else "SIGNATURE DOES NOT VERIFY")


# ---- enrollment store (test tool only: a plain JSON file in the user profile) ----
def enrollment_path() -> Path:
    return data_dir() / "enrollment.json"


def save_enrollment(slot: int, pubkey: bytes) -> Path:
    path = enrollment_path()
    path.write_text(json.dumps({
        "slot": slot,
        "pubkey": pubkey.hex(),
        "fingerprint": P.fingerprint(pubkey),
        "enrolled_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }, indent=2))
    return path


def load_enrollment() -> tuple[int, bytes] | None:
    try:
        d = json.loads(enrollment_path().read_text())
        pk = bytes.fromhex(d["pubkey"])
        P.load_pubkey(pk)
        return int(d["slot"]), pk
    except (OSError, ValueError, KeyError, P.ProtocolError):
        return None
