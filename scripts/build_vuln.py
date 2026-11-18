"""보행 열 취약성 지수 (30m 격자, 연속값)
   취약성 = 위험·노출·민감도 평균 × (1 − 0.5 × 대응력)
   - 위험: Landsat 8 지표면온도 (2026-08-03)            data/lst.json
   - 노출: 14시 평균 생활인구 (250m 격자 → 가우시안 평활) data/population.json
   - 민감도: 65세 이상 비중 (같은 방식)
   - 대응력: 가로수·그늘막(현재) + 미스트 폴대·바닥 살수·쿨페이브먼트(시스템 도입 후)
   각 요소는 동대문구 안 백분위로 0~1 정규화한다."""
import json, math, base64
import numpy as np
from scipy.ndimage import gaussian_filter
from shapely.geometry import shape, Point, LineString
from rasterio.features import rasterize, geometry_mask
from rasterio.transform import from_origin
SITE = __file__.rsplit('/scripts/', 1)[0]
L = json.load(open(SITE + '/data/lst.json'))
W, H = L['w'], L['h']; w0, s0, e0, n0 = L['bounds']
dx, dy = (e0 - w0) / W, (n0 - s0) / H
tr = from_origin(w0, n0, dx, dy)
MX, MY = dx * 88300, dy * 111000          # 칸 크기(m)
bnd = json.load(open(SITE + '/data/boundary.json'))['geometry']
inside = ~geometry_mask([bnd], (H, W), tr)
lat = n0 - (np.arange(H) + 0.5) * dy; lon = w0 + (np.arange(W) + 0.5) * dx
LON, LAT = np.meshgrid(lon, lat)

def rank(a):
    v = a[inside & np.isfinite(a)]
    out = np.full(a.shape, np.nan, 'float32')
    order = np.argsort(np.argsort(v))
    out[inside & np.isfinite(a)] = order / max(1, len(v) - 1)
    return out

def smooth(val, sigma_m):
    s = (sigma_m / MY, sigma_m / MX)
    m = np.isfinite(val).astype('float32'); v = np.nan_to_num(val)
    return gaussian_filter(v, s) / np.maximum(gaussian_filter(m, s), 1e-6)

# 위험: 지표면온도
d = [x for x in L['dates'] if x['date'] == '2026-08-03'][0]
lst = np.frombuffer(base64.b64decode(d['data']), '<i2').reshape(H, W).astype('float32') / 10
lst[lst <= -3000] = np.nan
lst = smooth(lst, 30)
# 노출·민감도: 250m 격자를 칸에 입히고 평활
pop = json.load(open(SITE + '/data/population.json'))
shapes_p = [(f['geometry'], f['properties']['pop'][14] / 62500) for f in pop['features']]       # 명/㎡
shapes_o = [(f['geometry'], f['properties']['old65']) for f in pop['features'] if f['properties'].get('old65') is not None]
pd_ = rasterize(shapes_p, (H, W), transform=tr, fill=np.nan, dtype='float32')
od = rasterize(shapes_o, (H, W), transform=tr, fill=np.nan, dtype='float32')
pd_ = smooth(pd_, 150); od = smooth(od, 150)
# 대응력(현재): 가로수(수관 그늘)·그늘막 밀도
def kde(pts, sigma, weight=1.0):
    g = np.zeros((H, W), 'float32')
    for la, lo in pts:
        c = int((lo - w0) / dx); r = int((n0 - la) / dy)
        if 0 <= r < H and 0 <= c < W: g[r, c] += weight
    return gaussian_filter(g, (sigma / MY, sigma / MX)) * (2 * math.pi * (sigma / MX) * (sigma / MY))
trees = json.load(open(SITE + '/data/trees.json')); shades = json.load(open(SITE + '/data/shades.json'))
cap_tree = kde([(t[0], t[1]) for t in trees], 20)
cap_shade = kde([(s['lat'], s['lon']) for s in shades], 30, 2.0)
# 대응력(시스템): 미스트 폴대(지상 소화전 위치) + 바닥 살수·쿨페이브먼트(보행축 15m)
segs = json.load(open(SITE + '/data/segments.json'))
poles = [tuple(n) for s in segs if s['seg_type'] != 'D' for n in s['nozzles']]
cap_mist = kde(poles, 15, 3.0)
pave_lines = [({'type': 'LineString', 'coordinates': [[c[1], c[0]] for c in s['coords']]}, 1) for s in segs]
from scipy.ndimage import distance_transform_edt
ln = rasterize(pave_lines, (H, W), transform=tr, fill=0, dtype='uint8', all_touched=True)
dist = distance_transform_edt(ln == 0, sampling=(MY, MX))
cap_pave = np.clip(1 - dist / 25, 0, 1) * 1.0

def capacity(x): return 1 - np.exp(-x)
C0 = capacity(cap_tree * 0.6 + cap_shade)
C1 = capacity(cap_tree * 0.6 + cap_shade + cap_mist + cap_pave)
Hz, E, S = rank(lst), rank(pd_), rank(od)
base = np.nanmean(np.stack([Hz, E, S]), 0)
V0 = base * (1 - 0.5 * C0); V1 = base * (1 - 0.5 * C1)
V0[~inside] = np.nan; V1[~inside] = np.nan
q = lambda a: np.where(np.isfinite(a), np.clip(np.round(a * 250), 0, 250), 255).astype('uint8')
out = {'bounds': L['bounds'], 'w': W, 'h': H,
       'note': '취약성 = (지표면온도·14시 생활인구·65세 이상 비중의 백분위 평균) × (1 − 0.5 × 대응력)',
       'v0': base64.b64encode(q(V0).tobytes()).decode(), 'v1': base64.b64encode(q(V1).tobytes()).decode(),
       'hz': base64.b64encode(q(Hz).tobytes()).decode(), 'ex': base64.b64encode(q(E).tobytes()).decode(),
       'se': base64.b64encode(q(S).tobytes()).decode(), 'c0': base64.b64encode(q(C0).tobytes()).decode(),
       'c1': base64.b64encode(q(C1).tobytes()).decode()}
json.dump(out, open(SITE + '/data/vuln.json', 'w'), separators=(',', ':'))
v = V0[inside]; d_ = (V0 - V1)[inside]
print('V0 range', np.nanmin(v), np.nanmax(v), 'mean', np.nanmean(v), '| improvement max', np.nanmax(d_), 'cells improved>0.02', (d_ > 0.02).sum())
