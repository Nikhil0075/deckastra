"""Audio files: how long they are, what they look like, and a stand-in voice.

Integration plan 01 §3.8: a narration take's duration is **read from the encoded
file**, never taken from what a speech request asked for. A voice asked to speak
at 1.1× does not say a sentence in 1/1.1 of the time, a recording someone
uploads says nothing about its length at all, and a narrated deck that advances
on a wrong duration cuts its own narrator off mid-word.

Three containers are read, by their headers alone — nothing here decodes audio,
because nothing here needs to and a decoder is a dependency the frozen service
would have to carry:

- **WAV**: the `fmt` chunk's byte rate and the `data` chunk's size.
- **Ogg** (Opus, Vorbis): the last page's granule position over the stream's
  sample rate, minus Opus's pre-skip.
- **MP3**: walk the frames, summing samples; a Xing/Info header's frame count
  when the encoder wrote one.

An unreadable file is `None`, and the caller decides what that means — an
upload is refused, a synthesized take is a bug worth a 502.
"""

from __future__ import annotations

import math
import struct
from typing import Iterable


class AudioError(ValueError):
    """The bytes are not an audio file this service can read."""


def duration_ms(data: bytes, content_type: str | None = None) -> int | None:
    """Duration in whole milliseconds, read from the container, or None."""
    kind = sniff(data) or (content_type or "").split(";", 1)[0].strip().lower()
    try:
        if kind in ("wav", "audio/wav", "audio/x-wav", "audio/wave"):
            return _wav_duration(data)
        if kind in ("ogg", "audio/ogg", "audio/opus", "audio/webm"):
            return _ogg_duration(data)
        if kind in ("mp3", "audio/mpeg", "audio/mp3"):
            return _mp3_duration(data)
    except (struct.error, IndexError, ZeroDivisionError):
        return None
    return None


def sniff(data: bytes) -> str | None:
    """Which container the bytes are, from their first bytes."""
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "mp3"
    return None


# ------------------------------------------------------------------------ WAV


def _wav_chunks(data: bytes) -> Iterable[tuple[bytes, int, int]]:
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        yield chunk_id, offset + 8, size
        offset += 8 + size + (size & 1)


def _wav_format(data: bytes) -> tuple[int, int, int, int]:
    """(audio format, channels, sample rate, bits per sample)."""
    for chunk_id, start, _size in _wav_chunks(data):
        if chunk_id == b"fmt ":
            audio_format, channels, rate, _byte_rate, _align, bits = struct.unpack_from("<HHIIHH", data, start)
            return audio_format, channels, rate, bits
    raise AudioError("This WAV file has no format chunk.")


def _wav_duration(data: bytes) -> int | None:
    _, channels, rate, bits = _wav_format(data)
    for chunk_id, start, size in _wav_chunks(data):
        if chunk_id == b"data":
            available = min(size, len(data) - start)
            frame = channels * max(1, bits // 8)
            return round(available / frame / rate * 1000)
    return None


def wav_samples(data: bytes) -> list[float]:
    """Mono samples of a 16-bit PCM WAV, -1..1. Anything else raises AudioError."""
    audio_format, channels, _rate, bits = _wav_format(data)
    if audio_format != 1 or bits != 16:
        raise AudioError("Only 16-bit PCM WAV can be read for a waveform.")
    for chunk_id, start, size in _wav_chunks(data):
        if chunk_id == b"data":
            count = min(size, len(data) - start) // 2
            values = struct.unpack_from(f"<{count}h", data, start)
            if channels > 1:
                values = values[::channels]
            return [value / 32768 for value in values]
    raise AudioError("This WAV file has no data chunk.")


# ------------------------------------------------------------------------ Ogg


def _ogg_pages(data: bytes) -> Iterable[tuple[int, int, bytes]]:
    """(granule position, serial, first packet bytes of the page) for each page."""
    offset = 0
    while offset + 27 <= len(data):
        if data[offset : offset + 4] != b"OggS":
            next_page = data.find(b"OggS", offset + 1)
            if next_page < 0:
                return
            offset = next_page
            continue
        granule, serial = struct.unpack_from("<qI", data, offset + 6)
        segments = data[offset + 26]
        table = data[offset + 27 : offset + 27 + segments]
        body_start = offset + 27 + segments
        body_size = sum(table)
        yield granule, serial, data[body_start : body_start + body_size]
        offset = body_start + body_size


def _ogg_duration(data: bytes) -> int | None:
    rate: int | None = None
    pre_skip = 0
    last_granule = -1
    for granule, _serial, body in _ogg_pages(data):
        if rate is None:
            if body.startswith(b"OpusHead"):
                pre_skip = struct.unpack_from("<H", body, 10)[0]
                rate = 48_000  # Opus granules are always 48kHz
            elif body[1:7] == b"vorbis" and body[0] == 1:
                rate = struct.unpack_from("<I", body, 12)[0]
        if granule >= 0:
            last_granule = max(last_granule, granule)
    if not rate or last_granule < 0:
        return None
    return round(max(0, last_granule - pre_skip) / rate * 1000)


# ------------------------------------------------------------------------ MP3

_BITRATES = {
    (1, 1): [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    (1, 2): [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    (1, 3): [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    (2, 1): [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    (2, 2): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    (2, 3): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_RATES = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000]}


def _mp3_duration(data: bytes) -> int | None:
    offset = 0
    if data[:3] == b"ID3":
        size = data[6:10]
        offset = 10 + ((size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3])
    total_samples = 0
    rate = 0
    frames = 0
    while offset + 4 <= len(data):
        header = struct.unpack_from(">I", data, offset)[0]
        if (header >> 21) & 0x7FF != 0x7FF:
            offset += 1
            continue
        version_bits = (header >> 19) & 3
        layer_bits = (header >> 17) & 3
        bitrate_index = (header >> 12) & 0xF
        rate_index = (header >> 10) & 3
        padding = (header >> 9) & 1
        if version_bits == 1 or layer_bits == 0 or bitrate_index in (0, 15) or rate_index == 3:
            offset += 1
            continue
        version = {3: 1, 2: 2, 0: 25}[version_bits]
        layer = 4 - layer_bits
        rate = _RATES[version][rate_index]
        bitrate = _BITRATES[(1 if version == 1 else 2, layer)][bitrate_index] * 1000
        samples = 384 if layer == 1 else (1152 if layer == 2 or version == 1 else 576)
        if frames == 0:
            # A Xing/Info header in the first frame states the frame count, which
            # is the only exact answer for a variable-bitrate file.
            for tag in (b"Xing", b"Info"):
                at = data.find(tag, offset, offset + 64)
                if at >= 0:
                    flags = struct.unpack_from(">I", data, at + 4)[0]
                    if flags & 1:
                        count = struct.unpack_from(">I", data, at + 8)[0]
                        return round(count * samples / rate * 1000)
        length = (12 * bitrate // rate + padding) * 4 if layer == 1 else samples // 8 * bitrate // rate + padding
        if length <= 0:
            break
        total_samples += samples
        frames += 1
        offset += length
    if not rate or frames == 0:
        return None
    return round(total_samples / rate * 1000)


# --------------------------------------------------------------------- shapes


def peaks(samples: list[float], buckets: int = 256) -> list[float]:
    """The largest absolute sample in each of `buckets` slices, 0..1 (`waveformPeaks`)."""
    if not samples:
        return [0.0] * buckets
    size = max(1, len(samples) // buckets)
    out: list[float] = []
    for bucket in range(buckets):
        chunk = samples[bucket * size : (bucket + 1) * size]
        out.append(round(max((abs(value) for value in chunk), default=0.0), 3))
    return out


def valid_peaks(value: object, buckets: int = 256) -> list[float] | None:
    """A client-supplied waveform, checked: the right length, numbers in 0..1."""
    if not isinstance(value, list) or len(value) != buckets:
        return None
    out: list[float] = []
    for item in value:
        if not isinstance(item, (int, float)) or isinstance(item, bool) or not 0 <= item <= 1 or math.isnan(item):
            return None
        out.append(round(float(item), 3))
    return out


def encode_wav(samples: list[float], rate: int) -> bytes:
    """16-bit PCM mono WAV (`encodeWav` in the renderer's sound library)."""
    pcm = struct.pack(f"<{len(samples)}h", *(int(max(-1.0, min(1.0, s)) * 32767) for s in samples))
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def stub_voice(text: str, *, rate: int = 16_000, words_per_second: float = 2.6, pause_ms: int = 0) -> bytes:
    """A stand-in recording for a deck with no speech provider.

    The narration path — synthesize, store, attach, play in narrated mode, export
    — has to run on a fresh clone and in CI without a key or money, the same
    reason the stub planner exists. So this is a recording whose length is what
    the script would take to say, made of soft rising tones, one per word. It is
    unmistakably not a voice: a deck narrated by it sounds like a placeholder,
    which is what it is, and the take's `voice` says "stub".
    """
    words = [word for word in text.split() if word]
    seconds = max(0.8, len(words) / words_per_second)
    # A script's pauses are silence at the end: the stand-in's length is what
    # its timing claims, and a pause is part of how long a line takes.
    total = int(seconds * rate) + int(max(0, pause_ms) / 1000 * rate)
    out = [0.0] * total
    per_word = int(seconds * rate) / max(1, len(words))
    for index, word in enumerate(words or ["…"]):
        start = int(index * per_word)
        length = int(per_word * 0.7)
        base = 180 + (sum(word.encode("utf-8")) % 120)
        for i in range(length):
            if start + i >= total:
                break
            t = i / rate
            progress = i / max(1, length - 1)
            envelope = math.sin(math.pi * progress) ** 2
            frequency = base * (1 + 0.25 * progress)
            out[start + i] += 0.25 * envelope * math.sin(2 * math.pi * frequency * t)
    return encode_wav(out, rate)
