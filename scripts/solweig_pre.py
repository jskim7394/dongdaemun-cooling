"""SOLWEIG 방식 단순화: 2m 격자에서 건물·수목 그림자(Ratti & Richens 2004)와 하늘 조망률(SVF)을 미리 계산한다."""
import json, math, base64, glob, time
import numpy as np, rasterio, shapefile
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling
from pyproj import Transformer
from scipy.ndimage import distance_transform_edt
SITE='/home/claude/dongdaemun-cooling'; UP='/mnt/user-data/uploads/데이터셋/1118 업데이트/'
RES=2.0; BUF=20; PAD=250
T=Transformer.from_crs(4326,5186,always_xy=True)
segs=json.load(open(SITE+'/data/segments.json'))
P=[T.transform(c[1],c[0]) for s in segs for c in s['coords']]
x0=math.floor(min(p[0] for p in P)-PAD); x1=math.ceil(max(p[0] for p in P)+PAD)
y0=math.floor(min(p[1] for p in P)-PAD); y1=math.ceil(max(p[1] for p in P)+PAD)
W=int((x1-x0)/RES); H=int((y1-y0)/RES); y1=y0+H*RES
tr=from_origin(x0,y1,RES,RES)
print('grid',W,H)
# 지면 높이
with rasterio.open(UP+'DEM/DDM_DEM_GLO30.tif') as r:
    dem=np.zeros((H,W),'float32'); reproject(r.read(1),dem,src_transform=r.transform,src_crs=r.crs,dst_transform=tr,dst_crs='EPSG:5186',resampling=Resampling.bilinear)
# 건물 높이
B=json.load(open(SITE+'/data/buildings_near.json'))
B.sort(key=lambda b:b['h'] or 0)
shapes=[({'type':'Polygon','coordinates':[[T.transform(x,y) for x,y in b['p']]]},float(b['h'] or 3.3)) for b in B]
bh=rasterize(shapes,out_shape=(H,W),transform=tr,fill=0,dtype='float32')
# 수목 높이 (1m → 2m 최댓값)
with rasterio.open(UP+'DEM/DDM_CanopyHeight_1m.tif') as r:
    ch=np.zeros((H,W),'float32'); reproject(r.read(1).astype('float32'),ch,src_transform=r.transform,src_crs=r.crs,dst_transform=tr,dst_crs='EPSG:5186',resampling=Resampling.max)
ch[ch<3]=0
# 가로수: 위성 AI 수관 자료가 가로수를 거의 못 잡아(4%) 수종별 평균 수관 지름·수고로 원판을 만든다 (가정값)
CROWN={'은행나무':(5,10),'양버즘나무':(9,14),'이팝나무':(4,7),'느티나무':(8,11),'벚나무':(6,8),'왕벚나무':(6,8),'배롱나무':(3,4),
       '회화나무':(6,10),'메타세쿼이아':(4,15),'소나무':(4,7),'단풍나무':(5,7),'칠엽수':(6,10),'산딸나무':(4,6),'백합나무':(7,14)}
trees=json.load(open(SITE+'/data/trees.json'))
from shapely.geometry import Point
tshapes=[]
for la,lo,sp in trees:
    d,h=next((v for k,v in CROWN.items() if k in sp),(5,8))
    x,y=T.transform(lo,la)
    if x0<x<x1 and y1-H*RES<y<y1: tshapes.append((Point(x,y).buffer(d/2,8).__geo_interface__,float(h)))
tc=rasterize(tshapes,out_shape=(H,W),transform=tr,fill=0,dtype='float32',merge_alg=rasterio.enums.MergeAlg.replace)
ch=np.maximum(ch,tc); ch[bh>0]=0
print('tree disks',len(tshapes),'canopy px share',(ch>0).mean())
dsmB=dem+bh; dsmV=dem+np.maximum(bh,ch)
# 보행축 선까지 거리
lines=[({'type':'LineString','coordinates':[T.transform(c[1],c[0]) for c in s['coords']]},1) for s in segs]
ln=rasterize(lines,out_shape=(H,W),transform=tr,fill=0,dtype='uint8',all_touched=True)
dist=distance_transform_edt(ln==0)*RES
sel=(dist<=BUF)&(bh==0)
idx=np.flatnonzero(sel); n=idx.size; print('pixels',n)
# 토지피복 (세분류 L3 코드 → 지표 유형)
lc=np.zeros((H,W),'uint8')
sh=[]
for f in glob.glob(''+UP+'토지피복/**/*.shp',recursive=True):
    rd=shapefile.Reader(f,encoding='cp949')
    for s_,rec in zip(rd.shapes(),rd.records()):
        c=rec['L3_CODE'][0]
        cls={'1':1,'2':2,'3':3,'4':2,'5':4,'6':5,'7':4}.get(c,1)   # 1 포장, 2 초지·농지, 3 숲, 4 물·습지, 5 나지
        sh.append((s_.__geo_interface__,cls))
lc=rasterize(sh,out_shape=(H,W),transform=tr,fill=1,dtype='uint8')
# 태양 위치 (NOAA 근사)
def sun(doy,hour_kst,lat=37.585,lon=127.05):
    g=2*math.pi/365*(doy-1+(hour_kst-12)/24)
    eq=229.18*(0.000075+0.001868*math.cos(g)-0.032077*math.sin(g)-0.014615*math.cos(2*g)-0.040849*math.sin(2*g))
    dec=0.006918-0.399912*math.cos(g)+0.070257*math.sin(g)-0.006758*math.cos(2*g)+0.000907*math.sin(2*g)-0.002697*math.cos(3*g)+0.00148*math.sin(3*g)
    tst=hour_kst*60+eq+4*lon-60*9
    ha=math.radians(tst/4-180); la=math.radians(lat)
    cz=math.sin(la)*math.sin(dec)+math.cos(la)*math.cos(dec)*math.cos(ha)
    zen=math.acos(max(-1,min(1,cz))); alt=90-math.degrees(zen)
    az=math.degrees(math.atan2(math.sin(ha),math.cos(ha)*math.sin(la)-math.tan(dec)*math.cos(la)))+180
    return alt,az%360
def shift(a,dr,dc,fill):
    out=np.full_like(a,fill)
    rs=slice(max(0,-dr),H-max(0,dr)); rd=slice(max(0,dr),H-max(0,-dr))
    cs=slice(max(0,-dc),W-max(0,dc)); cd=slice(max(0,dc),W-max(0,-dc))
    out[rd,cd]=a[rs,cs]; return out
def shadow(dsm,alt,az,maxd=300):
    # 해 쪽으로 걸어가며 그 지점 높이가 광선보다 높으면 그림자
    tanb=math.tan(math.radians(alt)); se,sn=math.sin(math.radians(az)),math.cos(math.radians(az))
    st=max(abs(se),abs(sn)); stepm=RES/st
    best=np.full((H,W),-1e9,'float32'); k=1
    while k*stepm<=maxd:
        dc=int(round(k*se/st)); dr=-int(round(k*sn/st))
        cand=shift(dsm,-dr,-dc,-1e9)-k*stepm*tanb
        np.maximum(best,cand,out=best); k+=1
        if k*stepm*tanb>dsm.max()-dsm.min()+5: break
    return best>dsm+0.3
DATES=[(191,'7월 10일'),(213,'8월 1일'),(234,'8월 22일')]; HOURS=list(range(8,19))
codes=np.zeros((len(DATES),len(HOURS),n),'uint8')
t0=time.time()
for di,(doy,_) in enumerate(DATES):
    for hi,h in enumerate(HOURS):
        alt,az=sun(doy,h-0.5)
        if alt<=2: codes[di,hi,:]=2; continue
        sb=shadow(dsmB,alt,az).ravel()[idx]; sv=shadow(dsmV,alt,az).ravel()[idx]
        codes[di,hi,:]=np.where(sb,2,np.where(sv,1,0))
    print('date',doy,round(time.time()-t0),'s')
# SVF (건물+수목, 32방향, 100m)
NA=32; s2=np.zeros(n,'float32')
for a in range(NA):
    az=a*360/NA; se,sn=math.sin(math.radians(az)),math.cos(math.radians(az)); st=max(abs(se),abs(sn)); stepm=RES/st
    g=np.zeros(n,'float32'); base=dsmV.ravel()[idx]; k=1
    while k*stepm<=100:
        dc=int(round(k*se/st)); dr=-int(round(k*sn/st))
        hgt=shift(dsmV,-dr,-dc,-1e9).ravel()[idx]
        np.maximum(g,np.arctan((hgt-base)/(k*stepm)),out=g); k+=1
    s2+=np.sin(np.clip(g,0,None))**2
svf=1-s2/NA
print('svf mean',svf.mean(),'sun share 14h aug1',(codes[1,6]==0).mean(),'canopy',(codes[1,6]==1).mean())
packed=np.zeros((len(DATES),len(HOURS),(n+3)//4),'uint8')
for j in range(4):
    part=codes[:,:,j::4]; packed[:,:,:part.shape[2]]|=(part<<(2*j))
out={'crs':'EPSG:5186','x0':x0,'y1':y1,'res':RES,'w':W,'h':H,'n':int(n),
     'dates':[{'doy':d,'label':l} for d,l in DATES],'hours':HOURS,
     'idx':base64.b64encode(idx.astype('<u4').tobytes()).decode(),
     'svf':base64.b64encode(np.round(svf*250).astype('uint8').tobytes()).decode(),
     'lc':base64.b64encode(lc.ravel()[idx].astype('uint8').tobytes()).decode(),
     'treeNote':'가로수 수관: 수종별 평균 지름·수고 원판(가정) + Meta·WRI 1m 수목높이(Tolan 외 2024)',
     'dist':base64.b64encode(np.minimum(255,np.round(dist.ravel()[idx])).astype('uint8').tobytes()).decode(),
     'shade':base64.b64encode(packed.tobytes()).decode(),
     'corners':[T.transform(*c,direction='INVERSE') for c in [(x0,y1),(x0+W*RES,y1),(x0+W*RES,y1-H*RES),(x0,y1-H*RES)]]}
json.dump(out,open(SITE+'/data/solweig.json','w'),separators=(',',':'))
import os; print('size',os.path.getsize(SITE+'/data/solweig.json'))
