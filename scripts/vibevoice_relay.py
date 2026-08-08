#!/usr/bin/env python3
"""VibeVoice 릴레이 TTS — 브리핑 대본을 멀티보이스 WAV로 합성.

네이티브 멀티화자(Speaker 1/2/…를 한 컨텍스트에 올려 generate() 1회)는
화자 수에 비례해 메모리가 늘어 16GB M4에서 2화자부터 스왑 스래싱으로 실패한다.
(실측: 1화자 6.3분 완주 / 2화자 13시간 ETA / 4화자 30시간 ETA)

대신 단락마다 단일화자로 개별 생성한 뒤 이어붙인다:
  - 메모리가 화자 수와 무관하게 고정 → 보이스를 몇 개 쓰든 동일
  - 세그먼트가 짧아 컨텍스트도 짧음 → 단일화자 한 방보다 오히려 빠름
    (실측: 1화자 380초 vs 4화자 릴레이 355초)

실행에는 vibevoice가 설치된 venv가 필요하다 (VIBEVOICE_PYTHON 참조).
"""
import os, re, sys, json, time, argparse, pathlib
import numpy as np
import soundfile as sf
import torch
from vibevoice.modular.modeling_vibevoice_inference import VibeVoiceForConditionalGenerationInference
from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor

SR = 24000

VOICE_FILES = {
    "Alice":  "en-Alice_woman.wav",
    "Carter": "en-Carter_man.wav",
    "Frank":  "en-Frank_man.wav",
    "Maya":   "en-Maya_woman.wav",
    "Mary":   "en-Mary_woman_bgm.wav",   # 배경음악 포함 — 뉴스에는 비권장
    "Samuel": "in-Samuel_man.wav",
}


def assign_voices(count, anchor, body):
    """세그먼트별 보이스 배정.

    첫·마지막을 같은 보이스(anchor)로 묶어 진행자를 인지시키고,
    본문은 body를 순환시켜 인접 세그먼트가 겹치지 않게 한다.
    브리핑마다 단락 수가 달라지므로 개수와 무관하게 동작해야 한다.
    """
    if count <= 0:
        return []
    if count == 1:
        return [anchor]
    if count == 2:
        return [anchor, anchor]
    inner = [body[i % len(body)] for i in range(count - 2)]
    return [anchor] + inner + [anchor]


def split_segments(text):
    """빈 줄 기준 단락 분할. 각 단락이 곧 하나의 기사(또는 인사말/마무리)."""
    return [p.strip().replace("\n", " ") for p in re.split(r"\n\s*\n+", text.strip()) if p.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True, help="대본 파일 경로")
    ap.add_argument("--out", required=True, help="출력 WAV 경로")
    ap.add_argument("--model", default=os.environ.get("VIBEVOICE_MODEL", ""))
    ap.add_argument("--voices-dir", default=os.environ.get("VIBEVOICE_VOICES_DIR", ""))
    ap.add_argument("--anchor", default=os.environ.get("VIBEVOICE_ANCHOR", "Maya"),
                    help="첫·마지막 세그먼트 보이스")
    # 기본 순환은 확정된 배정(Maya Frank Alice Carter Alice Carter Maya)을 재현한다.
    # Frank가 본문을 열고 Alice·Carter가 번갈아 받는 형태이며,
    # 이 패턴을 반복해도 인접 세그먼트가 겹치지 않는다.
    ap.add_argument("--body", default=os.environ.get("VIBEVOICE_BODY", "Frank,Alice,Carter,Alice,Carter"),
                    help="본문 순환 보이스 (콤마 구분)")
    ap.add_argument("--gap", type=float, default=0.4, help="세그먼트 사이 무음(초)")
    ap.add_argument("--cfg-scale", type=float, default=1.3)
    ap.add_argument("--ddpm-steps", type=int, default=10)
    args = ap.parse_args()

    if not args.model:
        sys.exit("[error] --model 또는 VIBEVOICE_MODEL 이 필요합니다")
    voices_dir = pathlib.Path(args.voices_dir) if args.voices_dir else None
    if not voices_dir or not voices_dir.is_dir():
        sys.exit(f"[error] 보이스 디렉터리를 찾을 수 없습니다: {args.voices_dir}")

    body = [v.strip() for v in args.body.split(",") if v.strip()]
    unknown = [v for v in [args.anchor] + body if v not in VOICE_FILES]
    if unknown:
        sys.exit(f"[error] 알 수 없는 보이스: {unknown} (사용가능: {list(VOICE_FILES)})")

    segments = split_segments(pathlib.Path(args.script).read_text(encoding="utf-8"))
    if not segments:
        sys.exit("[error] 대본이 비어 있습니다")
    assign = assign_voices(len(segments), args.anchor, body)

    print(f"[relay] 세그먼트 {len(segments)}개 / anchor={args.anchor} body={body}", flush=True)
    for i, (v, s) in enumerate(zip(assign, segments), 1):
        print(f"[relay]   {i}. {v:<7} {len(s):>4}자  {s[:48]}...", flush=True)

    t0 = time.time()
    processor = VibeVoiceProcessor.from_pretrained(args.model)
    model = VibeVoiceForConditionalGenerationInference.from_pretrained(
        args.model, torch_dtype=torch.float32, attn_implementation="sdpa", device_map=None,
    )
    model.to("mps")
    model.eval()
    model.set_ddpm_inference_steps(num_steps=args.ddpm_steps)
    load_sec = time.time() - t0
    print(f"[relay] 모델 로드 {load_sec:.1f}초", flush=True)

    chunks = []
    silence = np.zeros(int(SR * args.gap), dtype=np.float32)
    total_gen = 0.0

    for i, (voice, seg) in enumerate(zip(assign, segments), 1):
        inputs = processor(
            text=[f"Speaker 1: {seg}"],
            voice_samples=[[str(voices_dir / VOICE_FILES[voice])]],
            padding=True, return_tensors="pt", return_attention_mask=True,
        )
        for k, v in inputs.items():
            if torch.is_tensor(v):
                inputs[k] = v.to("mps")

        t = time.time()
        out = model.generate(
            **inputs, max_new_tokens=None, cfg_scale=args.cfg_scale,
            tokenizer=processor.tokenizer,
            generation_config={"do_sample": False}, verbose=False,
        )
        gen = time.time() - t
        total_gen += gen

        audio = out.speech_outputs[0]
        if torch.is_tensor(audio):
            audio = audio.detach().float().cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)

        if chunks:
            chunks.append(silence)
        chunks.append(audio)
        dur = len(audio) / SR
        print(f"[relay] {i}/{len(segments)} {voice:<7} 오디오 {dur:5.1f}초 / 생성 {gen:5.1f}초 / RTF {gen/dur if dur else 0:.2f}x", flush=True)

        del inputs, out
        # 세그먼트마다 비워야 메모리가 누적되지 않는다 (릴레이의 핵심)
        if hasattr(torch, "mps"):
            torch.mps.empty_cache()

    merged = np.concatenate(chunks)
    dst = pathlib.Path(args.out)
    dst.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(dst), merged, SR)

    duration = len(merged) / SR
    summary = {
        "ok": True,
        "output": str(dst),
        "duration_sec": round(duration, 2),
        "generate_sec": round(total_gen, 2),
        "load_sec": round(load_sec, 2),
        "rtf": round(total_gen / duration, 3) if duration else None,
        "segments": len(segments),
        "voices": assign,
    }
    print("RELAY_RESULT " + json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
