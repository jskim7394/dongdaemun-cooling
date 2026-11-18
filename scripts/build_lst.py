import rasterio, numpy as np, json, base64, math
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin
from rasterio.features import geometry_mask
SITE='/home/claude/dongdaemun-cooling'
bnd=json.load(open(SITE+'/data/boundary.json'))
ring=bnd['geometry']['coordinates'][0]
lon0,lon1=min(c[0] for c in ring)-0.001,max(c[0] for c in ring)+0.001
lat0,lat1=min(c[1] for c in ring)-0.001,max(c[1] for c in ring)+0.001
dx,dy=0.0003,0.00027
W=math.ceil((lon1-lon0)/dx); H=math.ceil((lat1-lat0)/dy)
tr=from_origin(lon0,lat1,dx,dy)
inside=~geometry_mask([bnd['geometry']],(H,W),tr)
segs=json.load(open(SITE+'/data/segments.json'))
out={'bounds':[lon0,lat1-H*dy,lon0+W*dx,lat1],'w':W,'h':H,'scale':10,'dates':[],'segments':{}}
from shapely.geometry import LineString
for date,f in [('2026-06-16','DDM_LC08_116034_20260616.tif'),('2026-08-03','DDM_LC08_116034_20260803.tif')]:
    with rasterio.open('/mnt/user-data/uploads/데이터셋/1118 업데이트/LST/'+f) as r:
        st=r.read(1).astype('float32'); qa=r.read(2)
        bad=(qa & 0b11111)>0
        t=st*0.00341802+149-273.15
        t[bad|(st==0)]=np.nan
        dst=np.full((H,W),np.nan,'float32')
        reproject(t,dst,src_transform=r.transform,src_crs=r.crs,dst_transform=tr,dst_crs='EPSG:4326',resampling=Resampling.nearest,src_nodata=np.nan,dst_nodata=np.nan)
    dst[~inside]=np.nan
    v=dst[np.isfinite(dst)]
    print(date,'valid',v.size,'of',inside.sum(),'min',v.min(),'p5',np.percentile(v,5),'median',np.median(v),'p95',np.percentile(v,95),'max',v.max())
    arr=np.where(np.isfinite(dst),np.round(dst*10),-32768).astype('<i2')
    out['dates'].append({'date':date,'time':'11:10','sat':'Landsat 8','median':round(float(np.median(v)),1),'data':base64.b64encode(arr.tobytes()).decode()})
    # 구간별 평균 (보행축 선 30m 안)
    for s in segs:
        ls=LineString([(c[1],c[0]) for c in s['coords']])
        vals=[]
        for yy in range(H):
            la=lat1-(yy+0.5)*dy
            if abs(la-s['coords'][0][0])>0.003: continue
            for xx in range(W):
                lo=lon0+(xx+0.5)*dx
                if abs(lo-s['coords'][0][1])>0.004: continue
                if math.isfinite(dst[yy,xx]):
                    # 대략 m 거리
                    p=ls.interpolate(ls.project(__import__('shapely').geometry.Point(lo,la)))
                    d=math.hypot((p.x-lo)*88300,(p.y-la)*111000)
                    if d<=30: vals.append(float(dst[yy,xx]))
        out['segments'].setdefault(s['seg_id'],{})[date]=round(sum(vals)/len(vals),1) if vals else None
json.dump(out,open(SITE+'/data/lst.json','w'),separators=(',',':'))
print({k:v for k,v in list(out['segments'].items())[:5]})
import os; print(os.path.getsize(SITE+'/data/lst.json'))
