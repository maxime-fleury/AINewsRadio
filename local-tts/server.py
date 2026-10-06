"""Local-only Chatterbox V3 bridge. Run with the project's isolated Python environment."""
import asyncio
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from contextlib import asynccontextmanager

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / ".local-tts" / "cache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

VOICES = ROOT / ".local-tts" / "voices"
VOICES.mkdir(parents=True, exist_ok=True)
lock = threading.Lock()
model = None
load_error = None
loaded_at = None
builtin_conditionals = None
reference_cache = {}


def clone_conditionals(value):
    if value is None:
        return None
    from chatterbox.mtl_tts import Conditionals
    from chatterbox.models.t3.modules.cond_enc import T3Cond
    def clone(item):
        if torch.is_tensor(item):
            return item.detach().clone()
        if isinstance(item, dict):
            return {key: clone(entry) for key, entry in item.items()}
        return item
    return Conditionals(T3Cond(**clone(value.t3.__dict__)), clone(value.gen))


def load_model():
    global model, load_error, loaded_at, builtin_conditionals
    try:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        device = "cuda" if torch.cuda.is_available() else "cpu"
        torch.set_num_threads(4)
        model = ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
        builtin_conditionals = clone_conditionals(model.conds)
        loaded_at = time.time()
        print(f"Chatterbox Multilingual V3 ready on {device}", flush=True)
    except Exception as exc:
        load_error = str(exc)
        print(f"Chatterbox load failed: {exc}", flush=True)


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load_model, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ready": model is not None, "model": "chatterbox-multilingual-v3", "device": "cuda" if torch.cuda.is_available() else "cpu", "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None, "error": load_error, "voices": [{"id": f"host-{i}", "label": f"Voix locale {i}", "reference": (VOICES / f"host-{i}.wav").exists()} for i in [1, 2]], "loadedAt": loaded_at}


class Speech(BaseModel):
    input: str = Field(min_length=1, max_length=2000)
    voice: str = "host-1"
    language: str = "fr"
    exaggeration: float = Field(default=0.5, ge=0, le=1)
    cfg_weight: float = Field(default=0.4, ge=0, le=1)
    speed: float = Field(default=1, ge=0.5, le=2)


def render(body: Speech, cancelled: threading.Event):
    if model is None:
        raise RuntimeError("Modèle en cours de chargement" if not load_error else load_error)
    if body.voice not in ["host-1", "host-2"]:
        raise ValueError("Voix inconnue")
    # Split into short sentences to bound generation and avoid long-form hallucination.
    pieces = re.findall(r"[^.!?]+[.!?]*", body.input.strip())
    chunks = []
    for piece in pieces:
        words = piece.split()
        chunks.extend(" ".join(words[i:i + 45]) for i in range(0, len(words), 45))
    wavs = []
    import numpy as np
    with lock:
        if cancelled.is_set():
            raise RuntimeError("Requête annulée")
        reference = VOICES / f"{body.voice}.wav"
        if reference.exists():
            key = (body.voice, reference.stat().st_mtime_ns, body.exaggeration)
            if key not in reference_cache:
                model.prepare_conditionals(str(reference), exaggeration=body.exaggeration)
                if len(reference_cache) >= 8:
                    reference_cache.pop(next(iter(reference_cache)))
                reference_cache[key] = clone_conditionals(model.conds)
            model.conds = clone_conditionals(reference_cache[key])
        else:
            model.conds = clone_conditionals(builtin_conditionals)
        for text in chunks:
            if cancelled.is_set():
                raise RuntimeError("Requête annulée")
            wav = model.generate(text, language_id=body.language, exaggeration=body.exaggeration, cfg_weight=body.cfg_weight, temperature=0.7)
            samples = wav.squeeze().numpy()
            if samples.size == 0 or not np.isfinite(samples).all():
                raise RuntimeError("Audio local vide ou invalide")
            wavs.append(samples)
            wavs.append(np.zeros(int(model.sr * 0.12), dtype=np.float32))
    if cancelled.is_set():
        raise RuntimeError("Requête annulée")
    buffer = io.BytesIO()
    sf.write(buffer, np.concatenate(wavs), model.sr, format="WAV", subtype="PCM_16")
    command = [shutil.which("ffmpeg") or "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-af", f"atempo={body.speed}", "-f", "mp3", "-codec:a", "libmp3lame", "-b:a", "96k", "pipe:1"]
    result = subprocess.run(command, input=buffer.getvalue(), capture_output=True, timeout=30, check=True)
    return result.stdout


@app.post("/audio/speech")
async def speech(body: Speech, request: Request):
    if model is None:
        raise HTTPException(503, load_error or "Chatterbox V3 : chargement des poids en cours")
    if body.language not in ["fr", "en"]:
        raise HTTPException(400, "Langue non prise en charge par la radio")
    started = time.perf_counter()
    cancelled = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(render, body, cancelled))
    try:
        while not task.done():
            if await request.is_disconnected():
                cancelled.set()
                break
            await asyncio.sleep(0.1)
        audio = await task
        return Response(audio, media_type="audio/mpeg", headers={"x-tts-ms": str(round((time.perf_counter() - started) * 1000)), "x-tts-model": "chatterbox-multilingual-v3"})
    except Exception as exc:
        if cancelled.is_set():
            raise HTTPException(499, "Requête annulée") from exc
        raise HTTPException(500, f"Synthèse locale : {exc}") from exc
    finally:
        cancelled.set()


@app.put("/voices/{voice}")
async def upload_voice(voice: str, request: Request):
    if voice not in ["host-1", "host-2"]:
        raise HTTPException(400, "Voix inconnue")
    data = await request.body()
    if len(data) > 10_000_000:
        raise HTTPException(413, "Référence limitée à 10 Mo")
    try:
        audio, rate = sf.read(io.BytesIO(data), dtype="float32")
        duration = len(audio) / rate
        if not 3 <= duration <= 30:
            raise ValueError("Extrait de 3 à 30 secondes requis")
        with lock:
            sf.write(VOICES / f"{voice}.wav", audio, rate, format="WAV", subtype="PCM_16")
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"voice": voice, "duration": duration}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LOCAL_TTS_PORT", "8765")))
