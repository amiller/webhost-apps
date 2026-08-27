#!/usr/bin/env python3
"""Synthesize speech WAVs via libespeak-ng (no espeak binary on this box) for the
#93 deployed-staging run: the utterances fed to POST /listen."""
import ctypes
import sys
import wave

lib = ctypes.CDLL("libespeak-ng.so.1")
AUDIO_OUTPUT_RETRIEVAL = 1  # samples are delivered to the synth callback
POS_CHARACTER = 1
espeakCHARS_AUTO = 0
espeakRATE, espeakPITCH, espeakVOLUME = 1, 2, 3

samples = []


@ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
def on_samples(wav, numsamples, _events):
    if numsamples > 0 and wav:
        samples.extend(wav[i] for i in range(numsamples))
    return 0


rate = lib.espeak_Initialize(AUDIO_OUTPUT_RETRIEVAL, 0, None, 0)
if rate <= 0:
    raise SystemExit(f"espeak_Initialize failed: {rate}")
lib.espeak_SetSynthCallback(on_samples)
lib.espeak_SetParameter(espeakRATE, 140, 0)


def synth(text: str, path: str) -> None:
    samples.clear()
    b = text.encode("utf-8")
    r = lib.espeak_Synth(b, len(b) + 1, 0, POS_CHARACTER, 0, espeakCHARS_AUTO, None, None)
    if r != 0:
        raise SystemExit(f"espeak_Synth failed: {r}")
    lib.espeak_Synchronize()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((ctypes.c_short * len(samples))(*samples))
    print(f"{path}: {len(samples) / rate:.1f}s @ {rate}Hz")


if __name__ == "__main__":
    synth(sys.argv[1], sys.argv[2])
