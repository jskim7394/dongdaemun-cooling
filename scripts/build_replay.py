"""S-DoT 여름 CSV(열린데이터광장 파일 다운로드)를 data/replay.json으로 바꾼다.

사용법 (저장소 폴더에서):
    python scripts/build_replay.py 내려받은파일1.csv [파일2.csv ...] --start 2026-07-01 --end 2026-08-31

동대문구 센서(data/sensors.json의 시리얼 또는 자치구 열이 '동대문구'인 행)만 골라
날짜·시간별 센서 값을 저장한다. 열 이름은 자동으로 찾는다.
"""
import argparse
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def open_csv(path):
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            f = open(path, encoding=enc, newline="")
            f.readline()
            f.seek(0)
            return f
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"인코딩을 읽을 수 없습니다: {path}")


def pick(keys, patterns):
    for p in patterns:
        for k in keys:
            if re.search(p, k, re.I):
                return k
    return None


def num(v):
    try:
        return float(str(v).strip())
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--start", default="2026-07-01")
    ap.add_argument("--end", default="2026-08-31")
    a = ap.parse_args()
    lo, hi = a.start.replace("-", ""), a.end.replace("-", "")

    known = {s["serial"] for s in json.loads((DATA / "sensors.json").read_text(encoding="utf-8"))}
    cells = {}  # (YYYYMMDD, HH) -> {serial: [t, rh, data_no]}

    for path in a.csv:
        f = open_csv(path)
        reader = csv.DictReader(f)
        keys = reader.fieldnames or []
        fs = {
            "serial": pick(keys, [r"시리얼", r"SERIAL", r"SN$"]),
            "time": pick(keys, [r"측정", r"전송", r"SENSING", r"TIME", r"일시", r"DATE"]),
            "temp": pick(keys, [r"평균.*온도", r"온도.*평균", r"(AVG|MEAN).*TEMP", r"TEMP.*(AVG|MEAN)", r"온도", r"TEMP"]),
            "humi": pick(keys, [r"평균.*습도", r"습도.*평균", r"(AVG|MEAN).*HUM", r"HUM.*(AVG|MEAN)", r"습도", r"HUM"]),
            "gu": pick(keys, [r"자치구", r"GU$", r"주소"]),
            "no": pick(keys, [r"DATA_?NO"]),
        }
        print(f"{Path(path).name}: {json.dumps(fs, ensure_ascii=False)}")
        if not all(fs[k] for k in ("serial", "time", "temp", "humi")):
            raise SystemExit("필수 열을 찾지 못했습니다. 위에 출력된 열 이름을 확인하세요.")
        for r in reader:
            serial = (r.get(fs["serial"]) or "").strip()
            if serial not in known and not (fs["gu"] and any(k in (r.get(fs["gu"]) or "") for k in ("동대문", "Dongdaemun"))):
                continue
            stamp = re.sub(r"\D", "", r.get(fs["time"]) or "")[:10]
            if len(stamp) < 10 or not (lo <= stamp[:8] <= hi):
                continue
            t, h = num(r.get(fs["temp"])), num(r.get(fs["humi"]))
            if t is None or not (-30 < t < 60) or h is None or not (0 <= h <= 100):
                continue
            no = num(r.get(fs["no"])) if fs["no"] else 1
            slot = cells.setdefault((stamp[:8], stamp[8:10]), {})
            if serial not in slot or (no or 1) >= slot[serial][2]:
                slot[serial] = [round(t, 2), round(h, 1), no or 1]
        f.close()

    days = {}
    for (d, hh), sens in sorted(cells.items()):
        vals = list(sens.values())
        days.setdefault(d, []).append({
            "h": int(hh),
            "ta": round(sum(v[0] for v in vals) / len(vals), 2),
            "rh": round(sum(v[1] for v in vals) / len(vals), 1),
            "n": len(vals),
            "s": {k: v[:2] for k, v in sens.items()},
        })
    if not days:
        raise SystemExit("조건에 맞는 동대문구 자료가 없습니다.")

    def label(d, hours):
        mx = max(x["ta"] for x in hours)
        return f"{d[:4]}-{d[4:6]}-{d[6:]} (최고 {mx:.1f}℃)"

    out = {
        "source": "S-DoT 도시데이터센서 시간 평균값(동대문구 센서)",
        "note": "-30℃ 이하 단선 코드와 범위를 벗어난 습도는 제외했습니다.",
        "days": [{"date": f"{d[:4]}-{d[4:6]}-{d[6:]}", "label": label(d, hs), "hours": hs}
                 for d, hs in sorted(days.items())],
    }
    (DATA / "replay.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"완료: {len(days)}일, {sum(len(h) for h in days.values())}시간 → data/replay.json")


if __name__ == "__main__":
    main()
