"""Transports: real Ledger over USB HID, and the Speculos emulator over TCP."""
from __future__ import annotations

import socket
import struct
import time
from typing import Protocol

LEDGER_VID = 0x2C97
LEDGER_USAGE_PAGE = 0xFFA0  # vendor-defined APDU interface (not the FIDO page 0xF1D0)
_CHANNEL = 0x0101
_TAG_APDU = 0x05
_PACKET = 64


class TransportError(Exception):
    pass


class Transport(Protocol):
    def exchange(self, apdu: bytes, timeout: float = 120.0) -> tuple[bytes, int]: ...
    def close(self) -> None: ...


# ---- Ledger HID framing (pure, unit-tested) -------------------------------
def frame(apdu: bytes) -> list[bytes]:
    """Split an APDU into 64-byte Ledger HID packets."""
    payload = struct.pack(">H", len(apdu)) + apdu
    packets, seq = [], 0
    while payload:
        head = struct.pack(">HBH", _CHANNEL, _TAG_APDU, seq)
        chunk, payload = payload[: _PACKET - len(head)], payload[_PACKET - len(head) :]
        packets.append((head + chunk).ljust(_PACKET, b"\x00"))
        seq += 1
    return packets


class Deframer:
    """Reassemble a response from 64-byte packets. feed() returns the APDU when complete."""

    def __init__(self) -> None:
        self._seq = 0
        self._total: int | None = None
        self._buf = b""

    def feed(self, packet: bytes) -> bytes | None:
        if len(packet) < 5:
            raise TransportError("short HID packet")
        channel, tag, seq = struct.unpack(">HBH", packet[:5])
        if channel != _CHANNEL or tag != _TAG_APDU or seq != self._seq:
            raise TransportError("unexpected HID packet header")
        body = packet[5:]
        if self._total is None:
            if len(body) < 2:
                raise TransportError("short first HID packet")
            self._total = struct.unpack(">H", body[:2])[0]
            body = body[2:]
        self._buf += body
        self._seq += 1
        if len(self._buf) >= self._total:
            return self._buf[: self._total]
        return None


# ---- device discovery -------------------------------------------------------
def _hid():
    try:
        import hid  # package "hidapi"
    except ImportError as e:  # pragma: no cover
        raise TransportError("the 'hidapi' package is required for USB access") from e
    return hid


def list_ledgers() -> list[dict]:
    """APDU-capable HID interfaces of connected Ledger devices."""
    out = []
    for d in _hid().enumerate(LEDGER_VID, 0):
        # Windows/macOS report usage pages; Linux hidraw reports interface numbers.
        if d.get("usage_page") == LEDGER_USAGE_PAGE or (
            d.get("usage_page") in (0, None) and d.get("interface_number") == 0
        ):
            out.append(d)
    return out


def ledger_present() -> bool:
    """Any Ledger USB device attached, whatever app is open (used by the removal watcher)."""
    return bool(_hid().enumerate(LEDGER_VID, 0))


class HidTransport:
    def __init__(self, path: bytes | None = None):
        hid = _hid()
        if path is None:
            devs = list_ledgers()
            if not devs:
                raise TransportError("no Ledger found on USB (plugged in and unlocked?)")
            path = devs[0]["path"]
        self._dev = hid.device()
        try:
            self._dev.open_path(path)
        except OSError as e:
            raise TransportError(f"cannot open Ledger HID interface: {e}") from None

    def exchange(self, apdu: bytes, timeout: float = 120.0) -> tuple[bytes, int]:
        try:
            for p in frame(apdu):
                if self._dev.write(b"\x00" + p) < 0:  # leading report id 0
                    raise TransportError("HID write failed")
            de, deadline = Deframer(), time.monotonic() + timeout
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TransportError("timed out waiting for the device")
                data = self._dev.read(_PACKET, int(min(left, 0.5) * 1000))
                if not data:
                    continue
                resp = de.feed(bytes(data))
                if resp is not None:
                    break
        except OSError as e:
            raise TransportError(f"USB error (device removed?): {e}") from None
        if len(resp) < 2:
            raise TransportError("short response")
        return resp[:-2], int.from_bytes(resp[-2:], "big")

    def close(self) -> None:
        self._dev.close()


class SpeculosTransport:
    """Speculos raw APDU server (default 127.0.0.1:9999)."""

    def __init__(self, host: str = "127.0.0.1", port: int = 9999):
        try:
            self._s = socket.create_connection((host, port), timeout=5)
        except OSError as e:
            raise TransportError(f"cannot reach Speculos at {host}:{port}: {e}") from None

    def _read(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self._s.recv(n - len(buf))
            if not chunk:
                raise TransportError("Speculos closed the connection")
            buf += chunk
        return buf

    def exchange(self, apdu: bytes, timeout: float = 120.0) -> tuple[bytes, int]:
        self._s.settimeout(timeout)
        try:
            self._s.sendall(struct.pack(">I", len(apdu)) + apdu)
            n = struct.unpack(">I", self._read(4))[0]
            resp = self._read(n + 2)
        except socket.timeout:
            raise TransportError("timed out waiting for the device") from None
        except OSError as e:
            raise TransportError(f"socket error: {e}") from None
        return resp[:-2], int.from_bytes(resp[-2:], "big")

    def close(self) -> None:
        self._s.close()


def open_transport(spec: str | None) -> Transport:
    """None/'usb' -> real Ledger. 'speculos' or 'speculos:host:port' -> emulator."""
    if not spec or spec == "usb":
        return HidTransport()
    if spec.startswith("speculos"):
        parts = spec.split(":")
        host = parts[1] if len(parts) > 1 and parts[1] else "127.0.0.1"
        port = int(parts[2]) if len(parts) > 2 else 9999
        return SpeculosTransport(host, port)
    raise TransportError(f"unknown transport '{spec}'")
