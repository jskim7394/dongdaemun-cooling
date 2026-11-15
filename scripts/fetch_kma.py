"""기상청 단기예보 조회서비스(초단기실황·초단기예보·단기예보)를 받아 data/kma.json으로 저장한다.

동대문구 격자 nx=61, ny=127. 인증키는 GitHub Secrets(KMA_API_KEY)로만 받으며 URL은 출력하지 않는다.
일부 호출이 실패해도 받은 부분만 저장하고, 모두 실패하면 이전 파일을 그대로 둔다.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "kma.json"
BASE = os.environ.get("KMA_BASE", "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0")
NX, NY = 61, 127
KST = timezone(timedelta(hours=9))

RAW_KEY = os.environ.get("KMA_API_KEY", "").strip()
# 공공데이터포털은 Encoding/Decoding 키를 모두 준다. 이미 인코딩된 키(%)면 그대로, 아니면 인코딩한다.
KEY = RAW_KEY if "%" in RAW_KEY else urllib.parse.quote(RAW_KEY, safe="")


def call(op, base_date, base_time, rows=1000):
    q = f"serviceKey={KEY}&pageNo=1&numOfRows={rows}&dataType=JSON&base_date={base_date}&base_time={base_time}&nx={NX}&ny={NY}"
    try:
        with urllib.request.urlopen(f"{BASE}/{op}?{q}", timeout=40) as r:
            body = r.read().decode("utf-8")
    except Exception as e:  # 키가 담긴 URL은 출력하지 않는다
        print(f"[{op}] 호출 실패: {type(e).__name__}")
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        print(f"[{op}] JSON이 아닌 응답: {body[:160]!r}")  # 키 오류는 XML로 온다
        return None
    hdr = data.get("response", {}).get("header", {})
    if hdr.get("resultCode") != "00":
        print(f"[{op}] {hdr.get('resultCode')} {hdr.get('resultMsg')} (base {base_date} {base_time})")
        return None
    return data["response"]["body"]["items"]["item"]


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return v  # 강수량 '강수없음' 등은 문자열 그대로


def pivot(items, val_key):
    out = {}
    for it in items:
        t = it["fcstDate"] + it["fcstTime"][:2] if "fcstDate" in it else it["baseDate"] + it["baseTime"][:2]
        out.setdefault(t, {"time": t})[it["category"]] = num(it[val_key])
    return [out[k] for k in sorted(out)]


def try_bases(op, cands, val_key):
    for d, t in cands:
        items = call(op, d, t)
        if items:
            return {"base": d + t, "rows": pivot(items, val_key)}
    return None


def main():
    if not RAW_KEY:
        print("[중단] KMA_API_KEY가 없습니다. Settings > Secrets에 등록하세요.")
        sys.exit(1)
    now = datetime.now(KST)

    # 초단기실황: 매시 정시 자료, 약 40분 이후 제공
    ncst_c = [((now - timedelta(minutes=40) - timedelta(hours=i)).strftime("%Y%m%d"),
               (now - timedelta(minutes=40) - timedelta(hours=i)).strftime("%H00")) for i in range(3)]
    # 초단기예보: 매시 30분 발표, 약 45분 이후 제공
    ultra_c = [((now - timedelta(minutes=45) - timedelta(hours=i)).strftime("%Y%m%d"),
                (now - timedelta(minutes=45) - timedelta(hours=i)).strftime("%H30")) for i in range(3)]
    # 단기예보: 02·05·08·11·14·17·20·23시 발표, 약 10분 이후 제공
    short_c, t = [], now - timedelta(minutes=10)
    while len(short_c) < 3:
        if t.hour % 3 == 2:
            short_c.append((t.strftime("%Y%m%d"), t.strftime("%H00")))
        t -= timedelta(hours=1)
        t = t.replace(minute=0)

    ncst = try_bases("getUltraSrtNcst", ncst_c, "obsrValue")
    ultra = try_bases("getUltraSrtFcst", ultra_c, "fcstValue")
    short = try_bases("getVilageFcst", short_c, "fcstValue")

    if not (ncst or ultra or short):
        print("[경고] 기상청 자료를 하나도 받지 못해 이전 kma.json을 유지합니다.")
        return

    prev = {}
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            prev = {}
    result = {
        "updated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "grid": {"nx": NX, "ny": NY},
        "ncst": (ncst["rows"][0] | {"base": ncst["base"]}) if ncst else prev.get("ncst"),
        "ultra": ultra or prev.get("ultra"),
        "short": short or prev.get("short"),
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("완료:", "실황", ncst and ncst["base"], "/ 초단기", ultra and ultra["base"],
          "/ 단기", short and short["base"], f"({len(short['rows']) if short else 0}시간)")


if __name__ == "__main__":
    main()
