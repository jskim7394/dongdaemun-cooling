"""서울 열린데이터광장 S-DoT 실시간 환경정보를 받아 동대문구 센서 값만 data/realtime.json으로 저장한다.

GitHub Actions에서 매시간 실행된다. 인증키는 GitHub Secrets(SEOUL_API_KEY)로만 받으며,
키가 들어간 URL은 로그에 절대 출력하지 않는다.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = os.environ.get("SDOT_BASE", "http://openapi.seoul.go.kr:8088")
PAGE = 1000          # 서울시 API 1회 최대 건수
PAGES = int(os.environ.get("SDOT_PAGES", "3"))  # 최신 자료가 앞쪽에 오므로 앞에서부터 읽는다 (약 2~3시간 분량)
KEEP_HOURS = 48

KEY = os.environ.get("SEOUL_API_KEY", "").strip()
SERVICE = os.environ.get("SDOT_SERVICE", "").strip()


def fail(msg):
    print(f"[중단] {msg}")
    sys.exit(1)


def call(start, end):
    url = f"{BASE}/{KEY}/json/{SERVICE}/{start}/{end}/"
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            body = r.read().decode("utf-8")
    except Exception as e:  # 키가 담긴 URL은 출력하지 않는다
        fail(f"API 호출 실패 ({start}~{end}): {type(e).__name__}")
    data = json.loads(body)
    if SERVICE in data:
        block = data[SERVICE]
    else:
        block = next((v for v in data.values() if isinstance(v, dict) and "row" in v), None)
        if block is None:
            res = data.get("RESULT", data)
            fail(f"응답에 자료가 없습니다: {json.dumps(res, ensure_ascii=False)[:300]}")
    return block


def pick(keys, patterns):
    for p in patterns:
        for k in keys:
            if re.search(p, k, re.I):
                return k
    return None


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    if not KEY:
        fail("SEOUL_API_KEY가 없습니다. 저장소 Settings > Secrets에 등록하세요.")
    if not SERVICE:
        fail("SDOT_SERVICE가 없습니다. 저장소 Settings > Variables에 서비스명을 등록하세요.")

    first = call(1, PAGE)
    total = int(first.get("list_total_count", 0))
    rows = list(first.get("row", []))
    for p in range(1, PAGES):
        s = p * PAGE + 1
        if s > total:
            break
        rows += call(s, min(s + PAGE - 1, total)).get("row", [])
    if not rows:
        fail("받은 행이 없습니다.")

    keys = list(rows[0].keys())
    f_serial = pick(keys, [r"^SN$", r"SERIAL", r"시리얼", r"SN$", r"SENSOR_?ID"])
    f_time = pick(keys, [r"MSRMT", r"SENSING", r"MEASURE", r"측정", r"전송", r"TIME", r"DATE", r"DT$"])
    f_temp = pick(keys, [r"^AVG_TP$", r"(AVG|MEAN).*TEMP", r"TEMP.*(AVG|MEAN)", r"평균.*온도", r"온도.*평균", r"TEMP", r"온도"])
    f_humi = pick(keys, [r"^AVG_HUM$", r"(AVG|MEAN).*HUM", r"HUM.*(AVG|MEAN)", r"평균.*습도", r"습도.*평균", r"HUM", r"습도"])
    f_gu = pick(keys, [r"^CGG$", r"자치구", r"GU", r"ADDR", r"주소"])
    f_no = pick(keys, [r"DATA_?NO"])
    fields = {"serial": f_serial, "time": f_time, "temp": f_temp, "humi": f_humi, "gu": f_gu, "data_no": f_no}
    DATA.joinpath("_debug_fields.json").write_text(
        json.dumps({"service": SERVICE, "total": total, "keys": keys, "detected": fields, "sample": rows[0]},
                   ensure_ascii=False, indent=1), encoding="utf-8")
    print("감지한 필드:", json.dumps(fields, ensure_ascii=False))
    if not (f_serial and f_time and f_temp and f_humi):
        fail("필수 필드를 찾지 못했습니다. data/_debug_fields.json을 확인하세요.")

    sensors = json.loads(DATA.joinpath("sensors.json").read_text(encoding="utf-8"))
    known = {s["serial"] for s in sensors}

    latest, hourly = {}, {}
    for r in rows:
        serial = str(r.get(f_serial, "")).strip()
        gu = str(r.get(f_gu, "")) if f_gu else ""
        in_ddm = serial in known or "동대문" in gu or "Dongdaemun" in gu
        if not in_ddm:
            continue
        stamp = re.sub(r"\D", "", str(r.get(f_time, "")))[:10]  # YYYYMMDDHH
        if len(stamp) < 10:
            continue
        t, h = to_float(r.get(f_temp)), to_float(r.get(f_humi))
        if t is not None and not (-30 < t < 60):
            t = None                      # -40℃ 단선 코드 등 제거
        if h is not None and not (0 <= h <= 100):
            h = None
        no = to_float(r.get(f_no)) if f_no else 1
        prev = latest.get(serial)
        if prev is None or stamp > prev["stamp"] or (stamp == prev["stamp"] and (no or 1) >= prev["no"]):
            latest[serial] = {"stamp": stamp, "t": t, "rh": h, "no": no or 1}
        if t is not None and h is not None:
            hourly.setdefault(stamp, {})[serial] = (t, h)

    out_sensors = [
        {"serial": s, "time": v["stamp"], "t": v["t"], "rh": v["rh"]}
        for s, v in sorted(latest.items())
    ]
    # 이전 실행에서 쌓은 이력과 합쳐 최근 48시간을 유지한다
    prev_path = DATA.joinpath("realtime.json")
    hist = {}
    if prev_path.exists():
        try:
            hist = json.loads(prev_path.read_text(encoding="utf-8")).get("hist", {}) or {}
        except json.JSONDecodeError:
            hist = {}
    for stamp, sv in hourly.items():
        hist.setdefault(stamp, {}).update({k: list(v) for k, v in sv.items()})
    hist = {k: hist[k] for k in sorted(hist)[-KEEP_HOURS:]}

    series = []
    for stamp in sorted(hist):
        vals = list(hist[stamp].values())
        series.append({
            "time": stamp,
            "t": round(sum(v[0] for v in vals) / len(vals), 2),
            "rh": round(sum(v[1] for v in vals) / len(vals), 1),
            "n": len(vals),
        })

    result = {
        "updated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "latest_obs": max((v["stamp"] for v in latest.values()), default=None),
        "rows_scanned": len(rows),
        "sensors": out_sensors,
        "series": series,
        "hist": hist,
    }
    DATA.joinpath("realtime.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                                              encoding="utf-8")
    valid = sum(1 for s in out_sensors if s["t"] is not None)
    print(f"완료: 전체 {total}행 중 {len(rows)}행 확인, 동대문구 센서 {len(out_sensors)}대(정상값 {valid}대), "
          f"최신 관측 {result['latest_obs']}")


if __name__ == "__main__":
    main()
