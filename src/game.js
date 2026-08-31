'use strict';
/* ============================================================================
   SUNSET CITY — a GTA-style top-down joyride (three.js r128)
   ----------------------------------------------------------------------------
   - Procedural city grid: roads, sidewalks, parks, buildings, street props
   - On-foot player + enterable cars (parked or carjack moving traffic)
   - Arcade car physics (drift handbrake, reverse, body roll)
   - Traffic AI on a right-hand-traffic lane graph, pedestrians on sidewalks
   - Collisions, knockdowns, engine/skid/horn/thud audio (WebAudio, no assets)
   ============================================================================ */

// ----------------------------- 0. utils -------------------------------------
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const RNG=mulberry32(20260831);                 // deterministic city
const rr=(a,b)=>a+RNG()*(b-a);
const ri=(a,b)=>Math.floor(rr(a,b+1));
const pick=(a)=>a[Math.floor(RNG()*a.length)];
const clamp=(v,a,b)=>v<a?a:(v>b?b:v);
const lerp=(a,b,t)=>a+(b-a)*t;
function wrapAngle(a){a=(a+Math.PI)%(Math.PI*2);if(a<0)a+=Math.PI*2;return a-Math.PI;}
const dist2=(ax,az,bx,bz)=>{const dx=ax-bx,dz=az-bz;return Math.sqrt(dx*dx+dz*dz);};
// heading convention: forward = (-sin(h), -cos(h))  → h=0 faces north (-Z)
const headingTo=(dx,dz)=>Math.atan2(-dx,-dz);
function turnToward(h,target,maxDelta){const d=wrapAngle(target-h);if(Math.abs(d)<=maxDelta)return target;return h+Math.sign(d)*maxDelta;}
const rightOf=(dx,dz)=>({x:-dz,z:dx});          // right-hand side of a travel dir
const DIRS4=[[1,0],[-1,0],[0,1],[0,-1]];

// ----------------------------- 1. city config --------------------------------
const N=10;                 // blocks per side
const P=54;                 // pitch (block + road)
const RH=9;                 // road half-width (road = 18 wide, 2 lanes + parking)
const BLOCK=P-2*RH;         // 36
const CITY=N*P;             // 540
const SIDEWALK=3.5;
const LANE=3.6;             // driving lane offset from road centerline
const PARK_LANE=7.3;        // parked-car offset from road centerline

// ----------------------------- 2. renderer / scene ---------------------------
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene=new THREE.Scene();
scene.background=new THREE.Color(0xa9cbe6);
scene.fog=new THREE.Fog(0xa9cbe6,340,780);

const camera=new THREE.PerspectiveCamera(44,window.innerWidth/window.innerHeight,1,1200);
window.addEventListener('resize',()=>{
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
});

const hemi=new THREE.HemisphereLight(0xbfd6ec,0x71805c,0.78);
scene.add(hemi);
const sun=new THREE.DirectionalLight(0xfff1d6,1.0);
sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.left=-150;sun.shadow.camera.right=150;
sun.shadow.camera.top=150;sun.shadow.camera.bottom=-150;
sun.shadow.camera.near=20;sun.shadow.camera.far=460;
sun.shadow.bias=-0.0003;
if('normalBias' in sun.shadow) sun.shadow.normalBias=0.4;
scene.add(sun);scene.add(sun.target);

// ----------------------------- 3. shared materials ---------------------------
const _matCache=new Map();
function matOf(hex){
  if(!_matCache.has(hex))_matCache.set(hex,new THREE.MeshLambertMaterial({color:hex}));
  return _matCache.get(hex);
}
function makeWallTex(wallHex){
  const c=document.createElement('canvas');c.width=128;c.height=128;
  const g=c.getContext('2d');
  g.fillStyle='#'+wallHex.toString(16).padStart(6,'0');
  g.fillRect(0,0,128,128);
  for(let r=0;r<4;r++)for(let q=0;q<4;q++){          // 4x4 window modules (3m each)
    const x=q*32+6,y=r*32+6;
    g.fillStyle='#1e2b37';g.fillRect(x,y,20,22);
    if(RNG()<0.30){g.fillStyle='rgba(165,195,220,0.55)';g.fillRect(x+2,y+2,16,9);}
    else if(RNG()<0.15){g.fillStyle='rgba(120,145,170,0.35)';g.fillRect(x+2,y+2,16,8);}
    g.fillStyle='rgba(0,0,0,0.22)';g.fillRect(x,y+22,20,2);
  }
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());
  return t;
}
const WALL_COLORS=[0x8f5a44,0xc9b48d,0x97a0a6,0xb59d76,0x67747d,0x7e918e,0x84644e,0xcdc6b4];
const wallMats=WALL_COLORS.map(c=>new THREE.MeshLambertMaterial({map:makeWallTex(c)}));
const roofMats=[0x5f5a52,0x6a655c,0x565a60].map(c=>matOf(c));

// ----------------------------- 4. static collision grid ----------------------
// per-block-cell lists; one-cell lookup is enough because nothing reachable
// crosses a road centerline (cell boundary) by more than the road margin.
const cellStatics=[];
for(let i=0;i<(N+2)*(N+2);i++)cellStatics.push({aabbs:[],circles:[]});
const cellAt=(i,j)=>cellStatics[(clamp(i,-1,N)+1)*(N+2)+(clamp(j,-1,N)+1)];
const cellOf=(x,z)=>cellAt(Math.floor(x/P),Math.floor(z/P));
function registerAABB(b){
  const i0=clamp(Math.floor(b.minX/P),-1,N),i1=clamp(Math.floor(b.maxX/P),-1,N);
  const j0=clamp(Math.floor(b.minZ/P),-1,N),j1=clamp(Math.floor(b.maxZ/P),-1,N);
  for(let i=i0;i<=i1;i++)for(let j=j0;j<=j1;j++)cellAt(i,j).aabbs.push(b);
}
function registerCircle(x,z,r){cellOf(x,z).circles.push({x:x,z:z,r:r});}
// resolves an entity {pos:{x,z}, vel?} with radius r against statics. returns impact speed.
function resolveStatics(ent,r){
  let impact=0;
  const cell=cellOf(ent.pos.x,ent.pos.z);
  const aabbs=cell.aabbs;
  for(let k=0;k<aabbs.length;k++){
    const b=aabbs[k];
    const cx=clamp(ent.pos.x,b.minX,b.maxX),cz=clamp(ent.pos.z,b.minZ,b.maxZ);
    let nx=ent.pos.x-cx,nz=ent.pos.z-cz;
    const d2=nx*nx+nz*nz;
    if(d2>=r*r)continue;
    let pen;
    if(d2>1e-6){const d=Math.sqrt(d2);nx/=d;nz/=d;pen=r-d;}
    else{
      const dl=ent.pos.x-b.minX,drt=b.maxX-ent.pos.x,dt=ent.pos.z-b.minZ,db=b.maxZ-ent.pos.z;
      const m=Math.min(dl,drt,dt,db);
      if(m===dl){nx=-1;nz=0;pen=r+dl;}
      else if(m===drt){nx=1;nz=0;pen=r+drt;}
      else if(m===dt){nx=0;nz=-1;pen=r+dt;}
      else{nx=0;nz=1;pen=r+db;}
    }
    ent.pos.x+=nx*pen;ent.pos.z+=nz*pen;
    if(ent.vel){
      const vn=ent.vel.x*nx+ent.vel.z*nz;
      if(vn<0){ent.vel.x-=nx*vn*1.55;ent.vel.z-=nz*vn*1.55;if(-vn>impact)impact=-vn;}
    }
  }
  const circs=cell.circles;
  for(let k=0;k<circs.length;k++){
    const t=circs[k];const R=r+t.r;
    let nx=ent.pos.x-t.x,nz=ent.pos.z-t.z;
    const d2=nx*nx+nz*nz;
    if(d2>=R*R||d2<1e-6)continue;
    const d=Math.sqrt(d2);nx/=d;nz/=d;const pen=R-d;
    ent.pos.x+=nx*pen;ent.pos.z+=nz*pen;
    if(ent.vel){
      const vn=ent.vel.x*nx+ent.vel.z*nz;
      if(vn<0){ent.vel.x-=nx*vn*1.4;ent.vel.z-=nz*vn*1.4;if(-vn>impact)impact=-vn;}
    }
  }
  return impact;
}
function circleFree(x,z,r){
  const cell=cellOf(x,z);
  for(let k=0;k<cell.aabbs.length;k++){
    const b=cell.aabbs[k];
    const cx=clamp(x,b.minX,b.maxX),cz=clamp(z,b.minZ,b.maxZ);
    const dx=x-cx,dz=z-cz;
    if(dx*dx+dz*dz<r*r)return false;
  }
  for(let k=0;k<cell.circles.length;k++){
    const t=cell.circles[k],R=r+t.r,dx=x-t.x,dz=z-t.z;
    if(dx*dx+dz*dz<R*R)return false;
  }
  return true;
}

// ----------------------------- 5. instancing helper --------------------------
const unitBox=new THREE.BoxGeometry(1,1,1);
function makeInstanced(geo,material,items,cast,recv){
  if(!items.length)return null;
  const m=new THREE.InstancedMesh(geo,material,items.length);
  const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),E=new THREE.Euler(),
        S=new THREE.Vector3(),T=new THREE.Vector3();
  for(let idx=0;idx<items.length;idx++){
    const it=items[idx];
    E.set(0,it.ry||0,0);Q.setFromEuler(E);
    const s=it.s||[1,1,1];
    S.set(s[0],s[1],s[2]);T.set(it.p[0],it.p[1],it.p[2]);
    M.compose(T,Q,S);
    m.setMatrixAt(idx,M);
  }
  m.instanceMatrix.needsUpdate=true;
  m.castShadow=!!cast;m.receiveShadow=!!recv;
  scene.add(m);
  return m;
}

// ----------------------------- 6. city generation ----------------------------
const cars=[];
const peds=[];
let buildingCount=0;
const parkSet=new Set();

function addBuilding(cx,cz,w,d,h,plinthItems,acItems){
  const geo=new THREE.BoxGeometry(w,h,d);
  // scale UVs so window modules stay ~3m on every face
  const uv=geo.attributes.uv;
  const su=[d/12,d/12,1,1,w/12,w/12],sv=[h/12,h/12,1,1,h/12,h/12];
  for(let f=0;f<6;f++)for(let v=0;v<4;v++){
    const i=f*4+v;uv.setXY(i,uv.getX(i)*su[f],uv.getY(i)*sv[f]);
  }
  const mi=ri(0,wallMats.length-1);
  const rm=roofMats[ri(0,roofMats.length-1)];
  const mesh=new THREE.Mesh(geo,[wallMats[mi],wallMats[mi],rm,rm,wallMats[mi],wallMats[mi]]);
  mesh.position.set(cx,0.22+h/2,cz);
  mesh.castShadow=true;mesh.receiveShadow=true;
  scene.add(mesh);
  registerAABB({minX:cx-w/2,maxX:cx+w/2,minZ:cz-d/2,maxZ:cz+d/2});
  buildingCount++;
  plinthItems.push({p:[cx,1.8,cz],s:[w+0.7,3.2,d+0.7]});
  if(RNG()<0.7&&h>10)acItems.push({p:[cx+rr(-w/4,w/4),0.22+h+0.5,cz+rr(-d/4,d/4)],s:[rr(1.2,2.2),1,rr(1.2,2.2)]});
}

function genBlockBuildings(bx,bz,plinthItems,acItems){
  const x0=bx+SIDEWALK+1,x1=bx+BLOCK-SIDEWALK-1;
  const z0=bz+SIDEWALK+1,z1=bz+BLOCK-SIDEWALK-1;
  const cx=(x0+x1)/2,cz=(z0+z1)/2;
  const dCore=1-Math.min(1,dist2(cx,cz,CITY/2,CITY/2)/(CITY*0.52));
  const hBase=lerp(9,30,Math.pow(dCore,1.6));
  const r=RNG();
  const B=[];
  if(r<0.30){
    B.push({x:cx+rr(-1.5,1.5),z:cz+rr(-1.5,1.5),w:rr(17,25),d:rr(17,25)});
  }else if(r<0.70){
    const m=rr(0.44,0.56);
    if(RNG()<0.5){ // split along x
      const span=x1-x0;
      B.push({x:x0+span*m*0.5-0.75,z:cz+rr(-2,2),w:span*m-1.5,d:rr(15,25)});
      B.push({x:x1-span*(1-m)*0.5+0.75,z:cz+rr(-2,2),w:span*(1-m)-1.5,d:rr(15,25)});
    }else{        // split along z
      const span=z1-z0;
      B.push({x:cx+rr(-2,2),z:z0+span*m*0.5-0.75,w:rr(15,25),d:span*m-1.5});
      B.push({x:cx+rr(-2,2),z:z1-span*(1-m)*0.5+0.75,w:rr(15,25),d:span*(1-m)-1.5});
    }
  }else{
    const mx=lerp(x0,x1,0.5),mz=lerp(z0,z1,0.5);
    B.push({x:lerp(x0,mx,0.5),z:lerp(z0,mz,0.5),w:rr(8.5,11.5),d:rr(8.5,11.5)});
    B.push({x:lerp(mx,x1,0.5),z:lerp(z0,mz,0.5),w:rr(8.5,11.5),d:rr(8.5,11.5)});
    B.push({x:lerp(x0,mx,0.5),z:lerp(mz,z1,0.5),w:rr(8.5,11.5),d:rr(8.5,11.5)});
    B.push({x:lerp(mx,x1,0.5),z:lerp(mz,z1,0.5),w:rr(8.5,11.5),d:rr(8.5,11.5)});
  }
  for(let k=0;k<B.length;k++){
    const b=B[k];
    const h=clamp(hBase*rr(0.55,1.35),6.5,40);
    addBuilding(b.x,b.z,b.w,b.d,h,plinthItems,acItems);
  }
}

function buildCity(){
  // ground: grass everywhere, asphalt city pad
  const grass=new THREE.Mesh(new THREE.PlaneGeometry(2400,2400),matOf(0x6b8f4e));
  grass.rotation.x=-Math.PI/2;grass.position.set(CITY/2,-0.06,CITY/2);
  grass.receiveShadow=true;scene.add(grass);
  const asph=new THREE.Mesh(new THREE.PlaneGeometry(CITY+2*RH+36,CITY+2*RH+36),matOf(0x3b3e44));
  asph.rotation.x=-Math.PI/2;asph.position.set(CITY/2,0,CITY/2);
  asph.receiveShadow=true;scene.add(asph);

  const sidewalkItems=[],plotItems=[],parkItems=[],plinthItems=[],acItems=[];
  const trunkItems=[],folItemsA=[],folItemsB=[],poleItems=[],headItems=[];
  const addTree=(x,z,big)=>{
    trunkItems.push({p:[x,1.2,z]});
    const it={p:[x,3.4,z],s:[rr(0.85,1.25),rr(1.0,1.4),rr(0.85,1.25)]};
    (RNG()<0.5?folItemsA:folItemsB).push(it);
    registerCircle(x,z,big?0.7:0.5);
  };

  for(let i=0;i<N;i++)for(let j=0;j<N;j++){
    const park=(i===4&&j===4)||RNG()<0.13;
    if(park)parkSet.add(i+','+j);
    const bx=i*P+RH,bz=j*P+RH,cx=bx+BLOCK/2,cz=bz+BLOCK/2;
    sidewalkItems.push({p:[cx,0.08,cz],s:[BLOCK,0.16,BLOCK]});
    if(park){
      parkItems.push({p:[cx,0.11,cz],s:[BLOCK-2*SIDEWALK,0.22,BLOCK-2*SIDEWALK]});
      const nT=ri(6,9);
      for(let t=0;t<nT;t++){
        addTree(bx+SIDEWALK+rr(2.5,BLOCK-SIDEWALK-2.5),bz+SIDEWALK+rr(2.5,BLOCK-SIDEWALK-2.5),true);
      }
    }else{
      plotItems.push({p:[cx,0.11,cz],s:[BLOCK-2*SIDEWALK,0.22,BLOCK-2*SIDEWALK]});
      genBlockBuildings(bx,bz,plinthItems,acItems);
    }
    // street lamps on one diagonal of corners
    const lc=[[bx+0.9,bz+0.9],[bx+BLOCK-0.9,bz+BLOCK-0.9]];
    if(RNG()<0.5)lc.reverse();
    poleItems.push({p:[lc[0][0],3.6,lc[0][1]]});headItems.push({p:[lc[0][0],7.35,lc[0][1]]});
    if(RNG()<0.75){poleItems.push({p:[lc[1][0],3.6,lc[1][1]]});headItems.push({p:[lc[1][0],7.35,lc[1][1]]});}
    // sidewalk trees on the other diagonal
    if(RNG()<0.4)addTree(bx+BLOCK-1.2,bz+1.2,false);
    if(RNG()<0.4)addTree(bx+1.2,bz+BLOCK-1.2,false);
  }

  // dashed centerlines
  const dashItems=[];
  for(let i=0;i<=N;i++)for(let j=0;j<N;j++){      // vertical roads (along z)
    const z0=j*P+RH+2.5,z1=(j+1)*P-RH-2.5;
    for(let z=z0;z<=z1;z+=5.2)dashItems.push({p:[i*P,0.035,z+1.1],s:[0.35,0.03,2.3]});
  }
  for(let j=0;j<=N;j++)for(let i=0;i<N;i++){      // horizontal roads (along x)
    const x0=i*P+RH+2.5,x1=(i+1)*P-RH-2.5;
    for(let x=x0;x<=x1;x+=5.2)dashItems.push({p:[x+1.1,0.035,j*P],s:[2.3,0.03,0.35]});
  }
  // zebra crosswalks at every intersection arm
  const cwItems=[];
  for(let i=0;i<=N;i++)for(let j=0;j<=N;j++){
    for(let a=0;a<4;a++){
      const d=DIRS4[a];
      const bxc=i*P+d[0]*(RH-2.0),bzc=j*P+d[1]*(RH-2.0);
      const alongX=d[0]!==0;
      for(let k=-5;k<=5;k++){
        const off=k*1.5;
        cwItems.push({p:[bxc-d[1]*off,0.035,bzc+d[0]*off],s:alongX?[2.6,0.03,0.75]:[0.75,0.03,2.6]});
      }
    }
  }

  makeInstanced(unitBox,matOf(0x9d978b),sidewalkItems,false,true);
  makeInstanced(unitBox,matOf(0x8f8b83),plotItems,false,true);
  makeInstanced(unitBox,matOf(0x5c8a45),parkItems,false,true);
  makeInstanced(unitBox,matOf(0x565049),plinthItems,false,true);
  makeInstanced(unitBox,matOf(0x8d9195),acItems,true,false);
  makeInstanced(new THREE.CylinderGeometry(0.22,0.3,2.4,6),matOf(0x5d4530),trunkItems,true,false);
  makeInstanced(new THREE.IcosahedronGeometry(1.7,0),matOf(0x4d7a38),folItemsA,true,false);
  makeInstanced(new THREE.IcosahedronGeometry(1.7,0),matOf(0x6f9a49),folItemsB,true,false);
  makeInstanced(new THREE.CylinderGeometry(0.09,0.13,7.2,6),matOf(0x3a3f45),poleItems,false,false);
  makeInstanced(new THREE.BoxGeometry(0.85,0.3,0.45),matOf(0xd8d2b8),headItems,false,false);
  makeInstanced(unitBox,matOf(0xd9b13c),dashItems,false,true);
  makeInstanced(unitBox,matOf(0xd6d9d3),cwItems,false,true);
}

// ----------------------------- 7. cars ---------------------------------------
const CAR_TYPES=[
  {name:'BREEZY',  w:2.05,len:4.25,cab:{h:0.48,z:0.45,l:0.42},van:false,maxSpeed:22,accel:9, brake:16,turn:2.5, cruise:11,  hp:90,  colors:[0xc9ced4,0x8494a4,0x5d6d7e,0x3e4a56,0xaeb8be,0x7a4a42]},
  {name:'MIDIAN',  w:2.20,len:4.75,cab:{h:0.50,z:0.40,l:0.45},van:false,maxSpeed:26,accel:11,brake:18,turn:2.4, cruise:12.5,hp:100, colors:[0x8a2f2a,0x2f4a6e,0x4f6e46,0x6e6259,0x272a30,0xb0a894]},
  {name:'CABBIE',  w:2.20,len:4.75,cab:{h:0.50,z:0.40,l:0.45},van:false,maxSpeed:25,accel:10,brake:18,turn:2.5, cruise:12.5,hp:105, colors:[0xd8a52a],taxi:true},
  {name:'BOXVILLE',w:2.40,len:5.35,cab:{h:1.05,z:-0.35,l:0.60},van:true, maxSpeed:19,accel:7, brake:14,turn:2.1, cruise:9.5, hp:135, colors:[0xd9d5cc,0x8a8d92,0x6e5a46]},
  {name:'STALLION',w:2.10,len:4.60,cab:{h:0.42,z:0.40,l:0.40},van:false,maxSpeed:33,accel:14,brake:19,turn:2.75,cruise:14,  hp:115, colors:[0xc23b2e,0xd8b13c,0x2e6e8e,0x1f2226,0xb56a2a]},
  {name:'INTERCEPTOR',w:2.20,len:4.80,cab:{h:0.46,z:0.40,l:0.42},van:false,maxSpeed:30,accel:13,brake:19,turn:2.6,cruise:13,hp:150, colors:[0xe8eaec],cop:true},
];
const POLICE_IDX=5;
const ZERO_INP={throttle:0,steer:0,handbrake:false};
let simNow=0;                        // game clock (seconds, pauses with the game)

function buildCarMesh(T,colorHex){
  const g=new THREE.Group();
  const bodyH=T.van?1.05:0.58,bodyY=T.van?0.72:0.6;
  const body=new THREE.Mesh(new THREE.BoxGeometry(T.w,bodyH,T.len),matOf(colorHex));
  body.position.y=bodyY;body.castShadow=true;g.add(body);
  const cab=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.84,T.cab.h,T.len*T.cab.l),matOf(0x1c2733));
  cab.position.set(0,bodyY+bodyH/2+T.cab.h/2-0.02,T.cab.z);
  cab.castShadow=true;g.add(cab);
  const wheelGeo=new THREE.CylinderGeometry(0.42,0.42,0.34,10);
  const wMat=matOf(0x15171b);
  const wpos=[[ T.w/2-0.05,-T.len*0.30],[-(T.w/2-0.05),-T.len*0.30],
              [ T.w/2-0.05, T.len*0.30],[-(T.w/2-0.05), T.len*0.30]];
  const frontGroups=[];
  for(let i=0;i<wpos.length;i++){
    const wh=new THREE.Mesh(wheelGeo,wMat);
    wh.rotation.z=Math.PI/2;
    if(i<2){ // front wheels (nose is -Z)
      const grp=new THREE.Group();
      grp.position.set(wpos[i][0],0.42,wpos[i][1]);
      grp.add(wh);g.add(grp);frontGroups.push(grp);
    }else{
      wh.position.set(wpos[i][0],0.42,wpos[i][1]);g.add(wh);
    }
  }
  const hl=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.7,0.15,0.1),matOf(0xfff1bf));
  hl.position.set(0,bodyY+bodyH/2-0.1,-T.len/2+0.02);g.add(hl);
  const tl=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.7,0.13,0.1),matOf(0xd83a2e));
  tl.position.set(0,bodyY+bodyH/2-0.1,T.len/2-0.02);g.add(tl);
  if(T.taxi){
    const sign=new THREE.Mesh(new THREE.BoxGeometry(0.8,0.26,0.42),matOf(0xe8b53a));
    sign.position.set(0,bodyY+bodyH/2+T.cab.h+0.15,T.cab.z);g.add(sign);
  }
  let lightMats=null;
  if(T.cop){
    // black hood + trunk decals
    const hood=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.92,bodyH*0.55,T.len*0.26),matOf(0x17191d));
    hood.position.set(0,bodyY+bodyH/2+0.02,-T.len*0.33);g.add(hood);
    const trunk=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.92,bodyH*0.55,T.len*0.20),matOf(0x17191d));
    trunk.position.set(0,bodyY+bodyH/2+0.02,T.len*0.38);g.add(trunk);
    // roof lightbar with per-car emissive materials (flashing)
    const barBase=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.62,0.13,0.32),matOf(0x101114));
    barBase.position.set(0,bodyY+bodyH/2+T.cab.h+0.12,-T.len*0.02);g.add(barBase);
    const mL=new THREE.MeshLambertMaterial({color:0x3a0c0c,emissive:0xff2a20});
    const mR=new THREE.MeshLambertMaterial({color:0x0c143a,emissive:0x2a55ff});
    const lL=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.26,0.16,0.28),mL);
    lL.position.set(-T.w*0.16,bodyY+bodyH/2+T.cab.h+0.24,-T.len*0.02);g.add(lL);
    const lR=new THREE.Mesh(new THREE.BoxGeometry(T.w*0.26,0.16,0.28),mR);
    lR.position.set(T.w*0.16,bodyY+bodyH/2+T.cab.h+0.24,-T.len*0.02);g.add(lR);
    lightMats=[mL,mR];
  }
  return {group:g,body:body,frontGroups:frontGroups,lightMats:lightMats};
}

class Car{
  constructor(ti,colorHex,x,z,h,mode){
    this.type=CAR_TYPES[ti];
    const m=buildCarMesh(this.type,colorHex);
    this.mesh=m.group;this.bodyMesh=m.body;this.frontGroups=m.frontGroups;
    this.lightMats=m.lightMats;
    this.pos={x:x,z:z};this.h=h;this.vel={x:0,z:0};
    this.steer=0;this.fs=0;this.lat=0;
    this.mode=mode||'parked';
    this.hp=this.type.hp||100;this.maxHp=this.hp;this.disabled=false;
    this.maxSpeed=this.type.maxSpeed;this.accel=this.type.accel;
    this.isCop=!!this.type.cop;this.retired=false;
    this.stuckT=0;this.revT=0;
    this.aiInp={throttle:0,steer:0,handbrake:false};
    this.ai={from:null,to:null,wps:[],blocked:0,honk:0,stun:0,turning:false};
    scene.add(this.mesh);
    cars.push(this);
    this.syncMesh();
  }
  forward(){return {x:-Math.sin(this.h),z:-Math.cos(this.h)};}
  lightsOff(){
    if(this.lightMats){
      this.lightMats[0].emissive.setHex(0x1a0806);
      this.lightMats[1].emissive.setHex(0x080c1a);
    }
  }
  step(dt,inp){
    if(this.disabled)inp=ZERO_INP;
    const T=this.type;
    const f=this.forward();
    const rx=Math.cos(this.h),rz=-Math.sin(this.h);
    let fs=this.vel.x*f.x+this.vel.z*f.z;
    // steering smoothing
    this.steer+=clamp(clamp(inp.steer,-1,1)-this.steer,-5.5*dt,5.5*dt);
    if(this.mode==='parked')this.steer*=(1-3*dt);
    // engine / brake / reverse
    let a=0;
    if(inp.throttle>0.01){
      if(fs<-0.5)a=T.brake;
      else a=inp.throttle*this.accel*Math.max(0,1-Math.max(0,fs)/this.maxSpeed);
    }else if(inp.throttle<-0.01){
      if(fs>0.5)a=-T.brake;
      else a=inp.throttle*this.accel*0.55*Math.max(0,1-Math.max(0,-fs)/10);
    }
    this.vel.x+=f.x*a*dt;this.vel.z+=f.z*a*dt;
    // steering → angular velocity (speed-sensitive, flips in reverse)
    const sgn=fs>=0?1:-1;
    this.h+=this.steer*T.turn*clamp(Math.abs(fs)/9,0,1)*sgn*dt*(inp.handbrake?1.35:1);
    // lateral grip (handbrake = drift)
    const lat=this.vel.x*rx+this.vel.z*rz;
    this.lat=lat;
    const grip=inp.handbrake?1.7:6.5;
    const cut=lat*Math.min(1,grip*dt);
    this.vel.x-=rx*cut;this.vel.z-=rz*cut;
    // drag / rolling resistance
    const drag=(Math.abs(inp.throttle)>0.01?0.06:0.55)+(inp.handbrake?1.1:0)+(this.mode==='parked'?2.6:0);
    const dr=Math.max(0,1-drag*dt);
    this.vel.x*=dr;this.vel.z*=dr;
    // integrate
    this.pos.x+=this.vel.x*dt;this.pos.z+=this.vel.z*dt;
    this.pos.x=clamp(this.pos.x,-6,CITY+6);this.pos.z=clamp(this.pos.z,-6,CITY+6);
    this.fs=fs;
  }
  collideStatics(){
    const f=this.forward();
    let imp=0;
    const offs=[this.type.len*0.27,-this.type.len*0.27];
    for(let k=0;k<2;k++){
      const off=offs[k];
      const probe={pos:{x:this.pos.x+f.x*off,z:this.pos.z+f.z*off},vel:this.vel};
      const i=resolveStatics(probe,1.12);
      if(i>0){
        this.pos.x+=probe.pos.x-(this.pos.x+f.x*off);
        this.pos.z+=probe.pos.z-(this.pos.z+f.z*off);
        if(i>imp)imp=i;
      }
    }
    if(imp>4.5&&this===player.car){
      SFX.thud(imp);
      shake=Math.max(shake,Math.min(1,imp/18));
    }
    if(imp>8){
      this.hp-=(imp-8)*1.8;
      if(this.hp<=0)wreckCar(this);
    }
  }
  syncMesh(){
    this.mesh.position.set(this.pos.x,0,this.pos.z);
    this.mesh.rotation.y=this.h;
    for(let i=0;i<this.frontGroups.length;i++)this.frontGroups[i].rotation.y=this.steer*0.42;
    this.bodyMesh.rotation.z=clamp(-this.steer*this.fs*0.0035,-0.1,0.1);
    if(this.isCop&&this.mode!=='ai'&&this.mode!=='parked'&&!this.retired&&!this.disabled&&this.lightMats){
      const ph=Math.floor(simNow*7)%2===0;
      this.lightMats[0].emissive.setHex(ph?0xff2a20:0x220604);
      this.lightMats[1].emissive.setHex(ph?0x111a44:0x2a55ff);
    }
  }
  // ---- AI ----
  planRoute(){
    for(let t=0;t<30;t++){
      const i=ri(0,N),j=ri(0,N);
      const d=pick(DIRS4);
      const ni=i+d[0],nj=j+d[1];
      if(ni<0||ni>N||nj<0||nj>N)continue;
      this.ai.from={i:i,j:j};this.ai.to={i:ni,j:nj};
      this.ai.wps=[approachPoint(this.ai.from,this.ai.to)];
      return;
    }
  }
  advanceRoute(){
    const ai=this.ai;
    const node=ai.to;
    if(!node){this.planRoute();return;}
    let cands=[];
    for(let k=0;k<4;k++){
      const d=DIRS4[k],ni=node.i+d[0],nj=node.j+d[1];
      if(ni>=0&&ni<=N&&nj>=0&&nj<=N)cands.push(d);
    }
    let back=null;
    if(ai.from)back=[ai.from.i-node.i,ai.from.j-node.j];
    let list=cands.filter(d=>!back||!(d[0]===back[0]&&d[1]===back[1]));
    if(!list.length)list=cands;
    const curDir=back?[-back[0],-back[1]]:null;
    let total=0;
    const ws=list.map(d=>{const w=(curDir&&d[0]===curDir[0]&&d[1]===curDir[1])?2.6:1;total+=w;return w;});
    let r=RNG()*total,pickD=list[0];
    for(let k=0;k<list.length;k++){r-=ws[k];if(r<=0){pickD=list[k];break;}}
    const next={i:node.i+pickD[0],j:node.j+pickD[1]};
    ai.from=node;ai.to=next;
    ai.turning=!curDir||!(pickD[0]===curDir[0]&&pickD[1]===curDir[1]);
    ai.wps=[exitPoint(node,pickD),approachPoint(node,next)];
  }
  aiThink(dt){
    const inp={throttle:0,steer:0,handbrake:false};
    const ai=this.ai;
    if(ai.stun>0){ai.stun-=dt;this.aiInp=inp;return;}
    if(!ai.to)this.planRoute();
    if(!ai.wps.length)this.advanceRoute();
    let wp=ai.wps[0];
    let d=dist2(this.pos.x,this.pos.z,wp.x,wp.z);
    if(d<5.5){
      ai.wps.shift();
      if(!ai.wps.length)this.advanceRoute();
      wp=ai.wps[0];
      d=dist2(this.pos.x,this.pos.z,wp.x,wp.z);
    }
    const dx=wp.x-this.pos.x,dz=wp.z-this.pos.z;
    const diff=wrapAngle(headingTo(dx,dz)-this.h);
    inp.steer=clamp(diff*2.2,-1,1);
    const f=this.forward();
    const fs=this.vel.x*f.x+this.vel.z*f.z;
    let st=this.type.cruise;
    if(Math.abs(diff)>0.35)st=Math.min(st,4.5);
    const npos={x:ai.to.i*P,z:ai.to.j*P};
    if(dist2(this.pos.x,this.pos.z,npos.x,npos.z)<30&&ai.turning)st=Math.min(st,6.2);
    // obstacle probe ahead
    const px=this.pos.x+f.x*(4.6+Math.max(0,fs)*1.15);
    const pz=this.pos.z+f.z*(4.6+Math.max(0,fs)*1.15);
    let blocked=false;
    for(let k=0;k<cars.length;k++){
      const o=cars[k];
      if(o===this)continue;
      if(dist2(px,pz,o.pos.x,o.pos.z)<3.4){blocked=true;break;}
    }
    if(!blocked&&player.state==='foot'&&dist2(px,pz,player.pos.x,player.pos.z)<2.6)blocked=true;
    if(!blocked)for(let k=0;k<peds.length;k++){
      const p=peds[k];
      if(p.state==='down')continue;
      if(dist2(px,pz,p.pos.x,p.pos.z)<2.3){blocked=true;break;}
    }
    if(blocked)st=0;
    inp.throttle=fs<st-0.8?0.85:(fs>st+2.5?-0.75:0.05);
    if(blocked&&fs<2){
      ai.blocked+=dt;
      if(ai.blocked>1.3&&ai.honk<=0){SFX.horn();ai.honk=4+Math.random()*3;}
    }else ai.blocked=0;
    ai.honk-=dt;
    if(ai.blocked>10){ai.blocked=0;spawnAIOnEdgeNear(this,focusX(),focusZ(),70,190);}
    this.aiInp=inp;
  }
  // ---- police chase AI ----
  policeThink(dt){
    const inp={throttle:0,steer:0,handbrake:false};
    const ai=this.ai;
    if(ai.stun>0){ai.stun-=dt;this.aiInp=inp;return;}
    if(this.retired||this.disabled){this.aiThink(dt);return;}
    const fx=focusX(),fz=focusZ();
    // lead the target
    let tx=fx,tz=fz;
    const pv=player.state==='drive'?player.car.vel:{x:0,z:0};
    const psp=Math.hypot(pv.x,pv.z);
    if(psp>2){const l=Math.min(psp*0.55,16);tx+=pv.x/psp*l;tz+=pv.z/psp*l;}
    const dx=tx-this.pos.x,dz=tz-this.pos.z;
    const dist=Math.hypot(dx,dz);
    const diff=wrapAngle(headingTo(dx,dz)-this.h);
    const f=this.forward();
    const fs=this.vel.x*f.x+this.vel.z*f.z;
    // reverse maneuver to unstick
    if(this.revT>0){
      this.revT-=dt;
      inp.throttle=-1;
      inp.steer=clamp(-diff*2,-1,1);
      this.aiInp=inp;
      return;
    }
    if(Math.abs(fs)<1.2)this.stuckT+=dt;else this.stuckT=0;
    if(this.stuckT>1.1){this.revT=0.85;this.stuckT=0;}
    inp.steer=clamp(diff*2.6,-1,1);
    let st=this.maxSpeed;
    if(Math.abs(diff)>1.1)st=7;
    else if(dist<12)st=Math.max(9,dist*1.5);
    // short obstacle probe — never brakes for the target (that's the point)
    const px=this.pos.x+f.x*(3.6+Math.max(0,fs)*0.8);
    const pz=this.pos.z+f.z*(3.6+Math.max(0,fs)*0.8);
    let blocked=false;
    for(let k=0;k<cars.length;k++){
      const o=cars[k];
      if(o===this||o===player.car)continue;
      if(o.mode==='police'&&!o.retired)continue;   // don't brake for fellow cops
      if(dist2(px,pz,o.pos.x,o.pos.z)<2.9){blocked=true;break;}
    }
    if(!blocked&&player.state==='foot'&&dist2(px,pz,player.pos.x,player.pos.z)<2.4)blocked=true;
    if(!blocked)for(let k=0;k<peds.length;k++){
      const p=peds[k];
      if(p.state==='down')continue;
      if(dist2(px,pz,p.pos.x,p.pos.z)<2.0){blocked=true;break;}
    }
    if(blocked)st=Math.min(st,5);
    if(probeHitsBuilding(px,pz))st=Math.min(st,4.5);
    inp.throttle=fs<st-0.8?1:(fs>st+3?-0.7:0.1);
    this.aiInp=inp;
  }
}
// lane-graph helpers (right-hand traffic)
function exitPoint(node,d){
  const r=rightOf(d[0],d[1]);
  return {x:node.i*P+d[0]*(RH+3)+r.x*LANE,z:node.j*P+d[1]*(RH+3)+r.z*LANE};
}
function approachPoint(a,b){
  const dx=b.i-a.i,dz=b.j-a.j;
  const r=rightOf(dx,dz);
  return {x:b.i*P-dx*(RH+3)+r.x*LANE,z:b.j*P-dz*(RH+3)+r.z*LANE};
}
function spawnAIOnEdgeNear(c,fx,fz,minD,maxD){
  minD=minD||70;maxD=maxD||190;
  for(let t=0;t<30;t++){
    const i=ri(0,N),j=ri(0,N);
    const d=pick(DIRS4);
    const ni=i+d[0],nj=j+d[1];
    if(ni<0||ni>N||nj<0||nj>N)continue;
    const tt=rr(0.2,0.8);
    const px=(i+d[0]*tt)*P,pz=(j+d[1]*tt)*P;
    const dd=dist2(px,pz,fx,fz);
    if(dd<minD||dd>maxD)continue;
    c.pos.x=px;c.pos.z=pz;
    c.h=headingTo(d[0],d[1]);
    c.steer=0;
    const f=c.forward();
    c.vel.x=f.x*8;c.vel.z=f.z*8;
    c.ai.from={i:i,j:j};c.ai.to={i:ni,j:nj};
    c.ai.wps=[approachPoint(c.ai.from,c.ai.to)];
    c.ai.blocked=0;c.ai.stun=0;c.ai.turning=false;
    return true;
  }
  return false;
}
function randomCarType(){
  const w=[0.28,0.26,0.12,0.16,0.18];
  let r=RNG(),acc=0;
  for(let i=0;i<w.length;i++){acc+=w[i];if(r<=acc)return i;}
  return 0;
}
function spawnAICar(){
  const ti=randomCarType();
  const T=CAR_TYPES[ti];
  return new Car(ti,T.colors[Math.floor(RNG()*T.colors.length)],0,0,0,'ai');
}
function spawnParkedCar(ti,x,z,h){
  const T=CAR_TYPES[ti];
  new Car(ti,T.colors[Math.floor(RNG()*T.colors.length)],x,z,h,'parked');
}
function spawnParked(){
  // two guaranteed starter cars by the spawn park
  spawnParkedCar(4,243,262.7,-Math.PI/2);   // STALLION — faces east
  spawnParkedCar(0,251,262.7,-Math.PI/2);   // BREEZY
  let placed=0,guard=0;
  while(placed<24&&guard<400){
    guard++;
    const i=ri(0,N-1),j=ri(0,N-1);
    const side=ri(0,3);
    const t=rr(0.25,0.75);
    const bx=i*P+RH,bz=j*P+RH;
    let x,z,h;
    if(side===0){      // north road (z=j*P), south curb
      x=bx+t*BLOCK;z=j*P+PARK_LANE;h=Math.PI/2;      // faces west
    }else if(side===1){ // south road (z=(j+1)*P), north curb
      x=bx+t*BLOCK;z=(j+1)*P-PARK_LANE;h=-Math.PI/2; // faces east
    }else if(side===2){ // west road (x=i*P), east curb
      x=i*P+PARK_LANE;z=bz+t*BLOCK;h=0;              // faces north
    }else{              // east road (x=(i+1)*P), west curb
      x=(i+1)*P-PARK_LANE;z=bz+t*BLOCK;h=Math.PI;    // faces south
    }
    let ok=true;
    for(let k=0;k<cars.length;k++){
      if(dist2(x,z,cars[k].pos.x,cars[k].pos.z)<7){ok=false;break;}
    }
    if(!ok)continue;
    spawnParkedCar(randomCarType(),x,z,h);
    placed++;
  }
}

// ----------------------------- 8. pedestrians --------------------------------
const SKINS=[0xe8b48c,0xcf9265,0x9c6238,0x6b4226,0xf2cba3];
const SHIRTS=[0xb5443a,0x3e6e52,0x4a5f8f,0xc9a13b,0x7c4a8e,0x30343c,0xd9d0bd,0x8a5a30,0x2e7e8c,0xa02a5e];
const PANTS=[0x2b3038,0x3d3a33,0x4a4f57,0x27405c];
function buildPedMesh(shirtHex,pantsHex,skinHex){
  const g=new THREE.Group();
  const legs=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.36,0.72,7),matOf(pantsHex));
  legs.position.y=0.36;g.add(legs);
  const torso=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.33,0.62,7),matOf(shirtHex));
  torso.position.y=1.03;torso.castShadow=true;g.add(torso);
  const head=new THREE.Mesh(new THREE.SphereGeometry(0.27,8,7),matOf(skinHex));
  head.position.y=1.6;g.add(head);
  return {g:g};
}
function blockRing(i,j){
  const x0=i*P+RH+1.7,z0=j*P+RH+1.7,x1=(i+1)*P-RH-1.7,z1=(j+1)*P-RH-1.7;
  return [{x:x0,z:z0},{x:x1,z:z0},{x:x1,z:z1},{x:x0,z:z1}];
}
class Ped{
  constructor(){
    this.mesh=buildPedMesh(pick(SHIRTS),pick(PANTS),pick(SKINS));
    this.pos={x:0,z:0};this.h=0;
    this.state='walk';this.phase=rr(0,6);
    this.corners=null;this.ci=0;this.dirSign=1;
    this.idleT=0;this.downT=0;this.fleeT=0;this.fleeDir={x:1,z:0};
    this.scT=rr(0,0.25);this.spdJit=rr(-0.3,0.5);
    scene.add(this.mesh.g);
    peds.push(this);
  }
  setBlock(i,j){
    this.corners=blockRing(i,j);
    this.dirSign=RNG()<0.5?1:-1;
    const k=ri(0,3);
    const nxt=(k+this.dirSign+4)%4;
    const t=rr(0.15,0.85);
    const a=this.corners[k],b=this.corners[nxt];
    this.pos.x=lerp(a.x,b.x,t);this.pos.z=lerp(a.z,b.z,t);
    this.ci=nxt;
    this.state='walk';this.downT=0;this.idleT=0;this.fleeT=0;
  }
  pickNearestCorner(){
    if(!this.corners)return;
    let best=0,bd=1e9;
    for(let k=0;k<4;k++){
      const d=dist2(this.pos.x,this.pos.z,this.corners[k].x,this.corners[k].z);
      if(d<bd){bd=d;best=k;}
    }
    this.ci=best;
  }
  fleeFrom(x,z){
    if(this.state==='down')return;
    let dx=this.pos.x-x,dz=this.pos.z-z;
    const d=Math.hypot(dx,dz)||1;
    this.fleeDir={x:dx/d,z:dz/d};
    this.state='flee';this.fleeT=1.5;
  }
  knock(car){
    this.state='down';
    this.downT=2.6+Math.random()*2.2;
    const sp=Math.hypot(car.vel.x,car.vel.z);
    if(sp>1){
      const inv=1/sp;
      this.pos.x+=car.vel.x*inv*0.6;
      this.pos.z+=car.vel.z*inv*0.6;
    }
  }
  checkScare(){
    for(let k=0;k<cars.length;k++){
      const c=cars[k];
      const sp=Math.hypot(c.vel.x,c.vel.z);
      if(sp<6)continue;
      const d=dist2(this.pos.x,this.pos.z,c.pos.x,c.pos.z);
      if(d>=6.5)continue;
      const f=c.forward();
      const tox=this.pos.x-c.pos.x,toz=this.pos.z-c.pos.z;
      if(f.x*tox+f.z*toz>0.3*d)this.fleeFrom(c.pos.x+f.x*2,c.pos.z+f.z*2);
    }
  }
  update(dt){
    if(this.state==='down'){
      this.downT-=dt;
      if(this.downT<=0){this.state='walk';this.pickNearestCorner();}
      return;
    }
    if(this.state==='idle'){
      this.idleT-=dt;
      if(this.idleT<=0)this.state='walk';
    }else if(this.state==='flee'){
      this.fleeT-=dt;
      if(this.fleeT<=0){this.state='walk';this.pickNearestCorner();}
      const spd=6.4;
      this.pos.x+=this.fleeDir.x*spd*dt;
      this.pos.z+=this.fleeDir.z*spd*dt;
      this.h=turnToward(this.h,headingTo(this.fleeDir.x,this.fleeDir.z),12*dt);
      this.phase+=dt*14;
    }else if(this.corners){
      const c=this.corners[this.ci];
      const dx=c.x-this.pos.x,dz=c.z-this.pos.z;
      const d=Math.hypot(dx,dz);
      if(d<0.5){
        this.ci=(this.ci+this.dirSign+4)%4;
        if(RNG()<0.18){this.state='idle';this.idleT=rr(1,3);}
      }else{
        const spd=2.2+this.spdJit;
        const inv=1/d;
        this.pos.x+=dx*inv*spd*dt;
        this.pos.z+=dz*inv*spd*dt;
        this.h=turnToward(this.h,headingTo(dx,dz),10*dt);
        this.phase+=dt*9;
      }
    }
    this.scT-=dt;
    if(this.scT<=0){this.scT=0.25;this.checkScare();}
    resolveStatics(this,0.4);
  }
  syncMesh(){
    const g=this.mesh.g;
    const down=this.state==='down';
    g.position.set(this.pos.x,down?0.42:(0.12+Math.abs(Math.sin(this.phase))*0.07),this.pos.z);
    g.rotation.y=this.h;
    g.rotation.x=down?-1.45:0;
  }
}
function pedRelocate(p,fx,fz,minD,maxD){
  minD=minD||25;maxD=maxD||150;
  for(let t=0;t<30;t++){
    const i=ri(0,N-1),j=ri(0,N-1);
    const bx=i*P+RH+BLOCK/2,bz=j*P+RH+BLOCK/2;
    const dd=dist2(bx,bz,fx,fz);
    if(dd<minD||dd>maxD)continue;
    p.setBlock(i,j);
    return;
  }
}
function scarePeds(x,z,radius){
  for(let k=0;k<peds.length;k++){
    const p=peds[k];
    if(p.state==='down')continue;
    if(dist2(p.pos.x,p.pos.z,x,z)<radius)p.fleeFrom(x,z);
  }
}

// ----------------------------- 9. player -------------------------------------
const player={state:'foot',pos:{x:243,z:259.3},h:0,phase:0,moving:false,car:null,
              hp:100,invulnT:0,wastedT:0};
const playerMesh=buildPedMesh(0xe8e4da,0x23262b,0xcf9265);
(function(){ // cap so the player stands out
  const cap=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.28,0.14,8),matOf(0x22262c));
  cap.position.y=1.82;playerMesh.g.add(cap);
})();
scene.add(playerMesh.g);
let pressedE=false,started=false,paused=false,shake=0;

function nearestEnterable(radius){
  let best=null,bd=radius;
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    if(c.mode==='player')continue;
    const d=dist2(player.pos.x,player.pos.z,c.pos.x,c.pos.z);
    if(d<bd){bd=d;best=c;}
  }
  return best;
}
function tryEnterCar(){
  const c=nearestEnterable(4.6);
  if(!c)return;
  if(c.mode==='ai'){
    toast('CARJACKED!');
    addHeat(60);
    if(peds.length<70){
      const rx=Math.cos(c.h),rz=-Math.sin(c.h);
      const dp=new Ped();
      dp.pos.x=c.pos.x-rx*2.2;dp.pos.z=c.pos.z-rz*2.2;
      dp.corners=blockRing(clamp(Math.floor(c.pos.x/P),0,N-1),clamp(Math.floor(c.pos.z/P),0,N-1));
      dp.state='flee';dp.fleeT=2.4;dp.fleeDir={x:-rx,z:-rz};
    }
  }else if(c.mode==='police'){
    toast('STOLE A COP CAR!');
    addHeat(130);
  }else{
    toast(c.type.name);
    if(c.isCop)addHeat(40);
  }
  c.mode='player';
  player.state='drive';player.car=c;
  playerMesh.g.visible=false;
  cnameEl.textContent=c.type.name;
}
function tryExitCar(){
  const c=player.car;
  if(!c)return;
  const f=c.forward();
  const rx=Math.cos(c.h),rz=-Math.sin(c.h);
  const spots=[[rx*2.6,rz*2.6],[-rx*2.6,-rz*2.6],[-f.x*(c.type.len/2+1.5),-f.z*(c.type.len/2+1.5)]];
  let placed=false;
  for(let k=0;k<spots.length;k++){
    const sx=c.pos.x+spots[k][0],sz=c.pos.z+spots[k][1];
    if(sx<2||sx>CITY-2||sz<2||sz>CITY-2)continue;
    if(!circleFree(sx,sz,0.55))continue;
    player.pos.x=sx;player.pos.z=sz;placed=true;break;
  }
  if(!placed){player.pos.x=c.pos.x+rx*2.6;player.pos.z=c.pos.z+rz*2.6;}
  c.mode='parked';
  player.state='foot';player.car=null;player.h=c.h;
  playerMesh.g.visible=true;
}
function pushPlayerFromCars(){
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    const f=c.forward();
    const offs=[c.type.len*0.27,-c.type.len*0.27];
    for(let s=0;s<2;s++){
      const cx=c.pos.x+f.x*offs[s],cz=c.pos.z+f.z*offs[s];
      let nx=player.pos.x-cx,nz=player.pos.z-cz;
      const d2=nx*nx+nz*nz,R=1.12+0.45;
      if(d2>=R*R||d2<1e-6)continue;
      const d=Math.sqrt(d2);
      player.pos.x+=nx/d*(R-d);player.pos.z+=nz/d*(R-d);
      // getting clipped by a moving car hurts
      const sp=Math.hypot(c.vel.x,c.vel.z);
      if(sp>6&&player.invulnT<=0&&player.wastedT<=0){
        damagePlayer(Math.min(70,sp*3));
        player.invulnT=1.3;
        player.pos.x+=c.vel.x*0.08;player.pos.z+=c.vel.z*0.08;
      }
    }
  }
}
function updatePlayer(dt){
  player.invulnT=Math.max(0,player.invulnT-dt);
  if(player.wastedT>0){
    // dead: car coasts, input ignored, then respawn
    pressedE=false;
    if(player.state==='drive'){
      player.car.step(dt,ZERO_INP);
      player.pos.x=player.car.pos.x;player.pos.z=player.car.pos.z;
    }
    player.wastedT-=dt;
    if(player.wastedT<=0){
      wastedEl.style.display='none';
      respawnPlayer();
    }
    return;
  }
  if(player.hp<100)player.hp=Math.min(100,player.hp+2.2*dt);
  if(pressedE){
    pressedE=false;
    if(started&&!paused){
      if(player.state==='foot'){
        if(!tryAnswerPhone())tryEnterCar();
      }else tryExitCar();
    }
  }
  if(player.state==='drive'){
    const c=player.car;
    const inp={
      throttle:(keyState.f?1:0)+(keyState.b?-1:0),
      steer:(keyState.l?1:0)+(keyState.r?-1:0),
      handbrake:!!keyState.hb
    };
    c.step(dt,inp);
    player.pos.x=c.pos.x;player.pos.z=c.pos.z;
  }else if(started&&!paused){
    let dx=(keyState.r?1:0)-(keyState.l?1:0);
    let dz=(keyState.b?1:0)-(keyState.f?1:0);
    if(dx||dz){
      const inv=1/Math.hypot(dx,dz);
      dx*=inv;dz*=inv;
      const spd=keyState.run?10:6.2;
      player.pos.x+=dx*spd*dt;
      player.pos.z+=dz*spd*dt;
      player.h=turnToward(player.h,headingTo(dx,dz),12*dt);
      player.moving=true;player.phase+=dt*spd*1.5;
    }else player.moving=false;
    player.pos.x=clamp(player.pos.x,1,CITY-1);
    player.pos.z=clamp(player.pos.z,1,CITY-1);
    resolveStatics(player,0.45);
    pushPlayerFromCars();
  }else{
    player.moving=false;
  }
}
function syncPlayerMesh(){
  const g=playerMesh.g;
  if(player.state==='drive'){g.visible=false;return;}
  g.visible=player.invulnT>0?(Math.floor(simNow*9)%2===0):true;
  g.position.set(player.pos.x,0.12+(player.moving?Math.abs(Math.sin(player.phase))*0.07:0),player.pos.z);
  g.rotation.y=player.h;
}
const focusX=()=>player.state==='drive'?player.car.pos.x:player.pos.x;
const focusZ=()=>player.state==='drive'?player.car.pos.z:player.pos.z;

// ----------------------------- 9.5 wanted level / police / damage ------------
const wanted={heat:0,stars:0,everWanted:false,lastCopSeen:-999,lastCopHit:-99,lastTrafficHit:-99,noSpawn:false};
const STAR_THRESH=[40,140,320,560,850];
const WANTED_COPS=[0,1,2,3,4,6];
function starsFromHeat(){
  let s=0;
  for(let i=0;i<STAR_THRESH.length;i++)if(wanted.heat>=STAR_THRESH[i])s=i+1;
  return s;
}
function addHeat(h){
  if(player.wastedT>0)return;
  wanted.heat=Math.min(1200,wanted.heat+h);
  if(wanted.heat>0)wanted.everWanted=true;
}
function removeCar(c){
  const i=cars.indexOf(c);
  if(i>=0)cars.splice(i,1);
  scene.remove(c.mesh);
}
function probeHitsBuilding(px,pz){
  const cell=cellOf(px,pz);
  for(let k=0;k<cell.aabbs.length;k++){
    const b=cell.aabbs[k];
    if(px>b.minX-1.2&&px<b.maxX+1.2&&pz>b.minZ-1.2&&pz<b.maxZ+1.2)return true;
  }
  return false;
}
function damagePlayer(x){
  if(player.wastedT>0||player.invulnT>0)return;
  player.hp-=x;
  shake=Math.max(shake,Math.min(1,x/50));
  SFX.thud(Math.min(18,x*0.5));
  if(player.hp<=0){
    player.hp=0;
    player.wastedT=3.2;
    wastedEl.style.display='flex';
  }
}
function respawnPlayer(){
  failMission('YOU GOT WASTED');
  if(player.car){player.car.mode='parked';player.car=null;}
  player.state='foot';
  player.pos.x=243;player.pos.z=259.3;player.h=0;
  player.hp=100;player.invulnT=2.5;player.wastedT=0;
  wanted.heat=0;
  playerMesh.g.visible=true;
  camPos.set(243,70,259.3+17);
  lookPos.set(243,0,259.3);
  toast('BACK ON YOUR FEET');
}
function wreckCar(car){
  if(car.disabled)return;
  car.disabled=true;
  car.hp=0;
  if(car.mode!=='player')car.mode='parked';
  car.bodyMesh.material=new THREE.MeshLambertMaterial({color:0x25241f});
  car.lightsOff();
  if(car===player.car){
    damagePlayer(55);
    toast('YOUR RIDE IS TOTALLED');
  }else{
    if(dist2(car.pos.x,car.pos.z,focusX(),focusZ())<90){SFX.thud(15);shake=Math.max(shake,0.35);}
    if(car.isCop)addHeat(140);
  }
}
function retireCop(c){
  c.retired=true;
  c.lightsOff();
  c.ai.to=null;c.ai.wps=[];c.ai.blocked=0;
}
function spawnCopPlace(c,fx,fz){
  for(let pass=0;pass<2;pass++){
    const mn=pass===0?85:40,mx=pass===0?140:240;
    for(let t=0;t<40;t++){
      const i=ri(0,N),j=ri(0,N);
      const d=pick(DIRS4);
      const ni=i+d[0],nj=j+d[1];
      if(ni<0||ni>N||nj<0||nj>N)continue;
      const tt=rr(0.15,0.85);
      const px=(i+d[0]*tt)*P,pz=(j+d[1]*tt)*P;
      const dd=dist2(px,pz,fx,fz);
      if(dd<mn||dd>mx)continue;
      c.pos.x=px;c.pos.z=pz;
      c.h=headingTo(fx-px,fz-pz);
      c.steer=0;
      const f=c.forward();
      c.vel.x=f.x*10;c.vel.z=f.z*10;
      c.ai.stun=0;c.stuckT=0;c.revT=0;
      return true;
    }
  }
  return false;
}
function spawnCop(fx,fz){
  const c=new Car(POLICE_IDX,0xe8eaec,-999,-999,0,'police');
  if(!spawnCopPlace(c,fx,fz)){removeCar(c);return;}
  c.maxSpeed=Math.min(34.5,26.5+starsFromHeat()*1.5);
  c.accel=13.5;
}
let copSpawnT=0;
function wantedTick(dt){
  copSpawnT-=dt;
  const fx=focusX(),fz=focusZ();
  const active=[];
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    if(c.mode==='police'&&!c.retired&&!c.disabled)active.push(c);
  }
  // cops "see" the player within 75 units — that pauses heat decay
  let nearest=1e9;
  for(let k=0;k<active.length;k++){
    const d=dist2(active[k].pos.x,active[k].pos.z,fx,fz);
    if(d<nearest)nearest=d;
  }
  if(nearest<75)wanted.lastCopSeen=simNow;
  if(wanted.heat>0&&simNow-wanted.lastCopSeen>6){
    wanted.heat=Math.max(0,wanted.heat-22*dt);
  }
  const stars=starsFromHeat();
  const desired=WANTED_COPS[stars];
  let need=desired-active.length;
  if(need>0){
    // revive retired cops first
    for(let k=0;k<cars.length&&need>0;k++){
      const c=cars[k];
      if(c.mode==='police'&&c.retired&&!c.disabled){c.retired=false;need--;}
    }
    if(need>0&&!wanted.noSpawn&&copSpawnT<=0){
      spawnCop(fx,fz);
      copSpawnT=1.6;
    }
  }else if(need<0){
    active.sort((a,b)=>dist2(b.pos.x,b.pos.z,fx,fz)-dist2(a.pos.x,a.pos.z,fx,fz));
    for(let k=0;k<-need&&k<active.length;k++)retireCop(active[k]);
  }
  // keep chasers' performance scaled to the current wanted level
  for(let k=0;k<active.length;k++)active[k].maxSpeed=Math.min(34.5,26.5+stars*1.5);
  // clean up far-away retired cops and far-away wrecks
  for(let k=cars.length-1;k>=0;k--){
    const c=cars[k];
    if(c===player.car)continue;
    const far=dist2(c.pos.x,c.pos.z,fx,fz)>230;
    if(((c.mode==='police'&&c.retired)||c.disabled)&&far)removeCar(c);
  }
  // pull in chasers that fell way behind
  for(let k=0;k<active.length;k++){
    if(dist2(active[k].pos.x,active[k].pos.z,fx,fz)>290)spawnCopPlace(active[k],fx,fz);
  }
}

// ----------------------------- 10. collisions --------------------------------
function collideCars(){
  for(let i=0;i<cars.length;i++)for(let j=i+1;j<cars.length;j++){
    const A=cars[i],B=cars[j];
    const cdx=A.pos.x-B.pos.x,cdz=A.pos.z-B.pos.z;
    if(cdx*cdx+cdz*cdz>100)continue;
    const fa=A.forward(),fb=B.forward();
    const mA=A.mode==='parked'?1.6:1,mB=B.mode==='parked'?1.6:1;
    const tot=mA+mB;
    const oa=A.type.len*0.27,ob=B.type.len*0.27;
    for(let sa=-1;sa<=1;sa+=2)for(let sb=-1;sb<=1;sb+=2){
      const ax=A.pos.x+fa.x*oa*sa,az=A.pos.z+fa.z*oa*sa;
      const bx=B.pos.x+fb.x*ob*sb,bz=B.pos.z+fb.z*ob*sb;
      let nx=ax-bx,nz=az-bz;
      const d=Math.hypot(nx,nz),R=2.28;
      if(d>=R||d<1e-4)continue;
      nx/=d;nz/=d;
      const pen=R-d;
      A.pos.x+=nx*pen*(mB/tot);A.pos.z+=nz*pen*(mB/tot);
      B.pos.x-=nx*pen*(mA/tot);B.pos.z-=nz*pen*(mA/tot);
      const rvx=A.vel.x-B.vel.x,rvz=A.vel.z-B.vel.z;
      const rel=rvx*nx+rvz*nz;
      if(rel<0){
        const jj=-(1.3)*rel/(1/mA+1/mB);
        A.vel.x+=nx*jj/mA;A.vel.z+=nz*jj/mA;
        B.vel.x-=nx*jj/mB;B.vel.z-=nz*jj/mB;
        const imp=-rel;
        // crash damage
        if(imp>2.5){
          const mult=(A.isCop&&B.isCop)?0.35:1;
          const dmg=imp*1.05*mult;
          A.hp-=dmg;B.hp-=dmg;
          if(A.hp<=0)wreckCar(A);
          if(B.hp<=0)wreckCar(B);
        }
        // crimes raise heat
        if(A===player.car||B===player.car){
          const other=(A===player.car)?B:A;
          if(other.isCop&&imp>3&&simNow-wanted.lastCopHit>1.5){
            wanted.lastCopHit=simNow;addHeat(90);
          }else if(!other.isCop&&imp>4&&simNow-wanted.lastTrafficHit>1.0){
            wanted.lastTrafficHit=simNow;addHeat(12);
          }
        }
        if(imp>3){
          if(A.mode==='ai')A.ai.stun=Math.max(A.ai.stun,0.8);
          if(B.mode==='ai')B.ai.stun=Math.max(B.ai.stun,0.8);
          if(A===player.car||B===player.car){
            SFX.thud(imp);
            shake=Math.max(shake,Math.min(1,imp/16));
          }else if(imp>6&&dist2(A.pos.x,A.pos.z,focusX(),focusZ())<90){
            SFX.thud(imp*0.5);
          }
        }
      }
    }
  }
}
function pedCarInteractions(){
  for(let k=0;k<peds.length;k++){
    const p=peds[k];
    if(p.state==='down')continue;
    for(let c=0;c<cars.length;c++){
      const car=cars[c];
      const f=car.forward();
      const oa=car.type.len*0.27;
      let hit=false;
      for(let s=-1;s<=1&&!hit;s+=2){
        const cx=car.pos.x+f.x*oa*s,cz=car.pos.z+f.z*oa*s;
        const d=dist2(cx,cz,p.pos.x,p.pos.z);
        if(d<1.55){
          const sp=Math.hypot(car.vel.x,car.vel.z);
          if(sp>3.5){
            p.knock(car);
            if(car===player.car)addHeat(80);   // vehicular assault is a crime
            hit=true;
          }
          else if(d>1e-4){
            const nx=(p.pos.x-cx)/d,nz=(p.pos.z-cz)/d;
            p.pos.x+=nx*(1.55-d);p.pos.z+=nz*(1.55-d);
          }
        }else if(d<2.2&&Math.hypot(car.vel.x,car.vel.z)>8&&p.state!=='flee'){
          p.fleeFrom(cx,cz);
        }
      }
    }
  }
}

// ----------------------------- 10.5 missions & money -------------------------
const wallet={money:0,missions:0};
function loadWallet(){
  try{
    const m=parseInt(window.localStorage.getItem('sc_money'),10);
    if(!isNaN(m)&&m>=0)wallet.money=m;
    const n=parseInt(window.localStorage.getItem('sc_missions'),10);
    if(!isNaN(n)&&n>=0)wallet.missions=n;
  }catch(e){}
}
function saveWallet(){
  try{
    window.localStorage.setItem('sc_money',String(wallet.money));
    window.localStorage.setItem('sc_missions',String(wallet.missions));
  }catch(e){}
}

// ---- phone booths ----
const phones=[];
function spawnPhones(){
  const spots=[];
  spots.push({x:4*P+RH+BLOCK-3.2,z:4*P+RH+BLOCK-3.2});   // spawn park corner
  let guard=0;
  while(spots.length<7&&guard<500){
    guard++;
    const i=ri(0,N-1),j=ri(0,N-1);
    const x=i*P+RH+rr(6,BLOCK-6);
    const z=j*P+RH+1.9;                                   // north sidewalk
    let ok=true;
    for(let s=0;s<spots.length;s++)if(dist2(x,z,spots[s].x,spots[s].z)<110){ok=false;break;}
    if(!ok)continue;
    spots.push({x:x,z:z});
  }
  for(let s=0;s<spots.length;s++){
    const sp=spots[s];
    const g=new THREE.Group();
    const body=new THREE.Mesh(new THREE.BoxGeometry(1.15,2.9,1.15),matOf(0x24466b));
    body.position.y=1.6;body.castShadow=true;g.add(body);
    const cap=new THREE.Mesh(new THREE.BoxGeometry(1.32,0.18,1.32),matOf(0x2c5d94));
    cap.position.y=3.1;g.add(cap);
    const screenMat=new THREE.MeshLambertMaterial({color:0x0c2229,emissive:0x0a3a44});
    const screen=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.75,0.08),screenMat);
    screen.position.set(0,2.15,-0.62);g.add(screen);
    const ring=new THREE.Mesh(new THREE.RingGeometry(1.0,1.35,24),
      new THREE.MeshBasicMaterial({color:0x54e0e8,transparent:true,opacity:0.8,side:THREE.DoubleSide,depthWrite:false}));
    ring.rotation.x=-Math.PI/2;ring.position.y=3.7;ring.visible=false;g.add(ring);
    g.position.set(sp.x,0.16,sp.z);
    scene.add(g);
    registerCircle(sp.x,sp.z,0.75);
    phones.push({x:sp.x,z:sp.z,g:g,ring:ring,screenMat:screenMat,ringing:false,ringT:0});
  }
}

// ---- mission markers ----
function makeMarker(){
  const g=new THREE.Group();
  const ring=new THREE.Mesh(new THREE.RingGeometry(2.6,3.4,32),
    new THREE.MeshBasicMaterial({color:0xffd23f,transparent:true,opacity:0.9,side:THREE.DoubleSide,depthWrite:false}));
  ring.rotation.x=-Math.PI/2;ring.position.y=0.25;g.add(ring);
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(1.1,1.7,52,12,1,true),
    new THREE.MeshBasicMaterial({color:0xffd23f,transparent:true,opacity:0.15,side:THREE.DoubleSide,depthWrite:false}));
  beam.position.y=26;g.add(beam);
  scene.add(g);
  return {g:g,ring:ring,beam:beam};
}

// ---- mission manager ----
const mission={active:false,phase:'idle',type:null,title:'',tLeft:0,timeLimit:0,reward:0,
              target:null,marker:null,car:null,stage:0,blip:null};
let phoneCd=4,lastRingSnd=0;

function pickRoadPoint(minD,maxD,fx,fz){
  if(fx===undefined)fx=focusX();
  if(fz===undefined)fz=focusZ();
  for(let t=0;t<50;t++){
    const i=ri(0,N),j=ri(0,N);
    const d=pick(DIRS4);
    const ni=i+d[0],nj=j+d[1];
    if(ni<0||ni>N||nj<0||nj>N)continue;
    const tt=rr(0.2,0.8);
    const px=(i+d[0]*tt)*P,pz=(j+d[1]*tt)*P;
    const dd=dist2(px,pz,fx,fz);
    if(dd<minD||dd>maxD)continue;
    const r=rightOf(d[0],d[1]);
    return {x:px+r.x*LANE,z:pz+r.z*LANE,h:headingTo(d[0],d[1]),dx:d[0],dz:d[1]};
  }
  return null;
}
function pickParkedPoint(minD,maxD,fx,fz){
  const p=pickRoadPoint(minD,maxD,fx,fz);
  if(!p)return null;
  const r=rightOf(p.dx,p.dz);
  return {x:p.x+r.x*3.7,z:p.z+r.z*3.7,h:p.h};
}
function pickMissionType(){
  const done=wallet.missions;
  if(done<=0)return 'delivery';
  if(done===1)return RNG()<0.55?'delivery':'car';
  const r=RNG();
  return r<0.34?'delivery':(r<0.67?'car':'hot');
}
function ringPhoneAt(ph){
  for(let k=0;k<phones.length;k++){
    phones[k].ringing=false;phones[k].ring.visible=false;phones[k].ringT=0;
    phones[k].screenMat.emissive.setHex(0x0a3a44);
  }
  if(ph){ph.ringing=true;ph.ringT=0;}
}
function nearRingingPhone(r){
  for(let k=0;k<phones.length;k++){
    const ph=phones[k];
    if(ph.ringing&&dist2(player.pos.x,player.pos.z,ph.x,ph.z)<r)return ph;
  }
  return null;
}
function chooseRingingPhone(){
  const fx=focusX(),fz=focusZ();
  const cands=[];
  for(let k=0;k<phones.length;k++){
    const d=dist2(phones[k].x,phones[k].z,fx,fz);
    if(d>40&&d<240)cands.push(phones[k]);
  }
  if(!cands.length){phoneCd=3;return;}
  ringPhoneAt(pick(cands));
}
function tryAnswerPhone(){
  const ph=nearRingingPhone(2.8);
  if(!ph)return false;
  ph.ringing=false;ph.ring.visible=false;
  ph.screenMat.emissive.setHex(0x0a3a44);
  startMission(pickMissionType());
  return true;
}
function startMission(type){
  cleanupMission();
  const fx=focusX(),fz=focusZ();
  if(type==='car'){
    const pa=pickParkedPoint(90,180,fx,fz);
    let ok=!!pa;
    if(ok){
      mission.car=new Car(4,0xd4af37,pa.x,pa.z,pa.h,'parked');
      const pb=pickRoadPoint(120,220,pa.x,pa.z);
      if(pb)mission.target={x:pb.x,z:pb.z};
      else{removeCar(mission.car);mission.car=null;ok=false;}
    }
    if(!ok)type='delivery';
  }
  if(type==='delivery'||type==='hot'){
    const p=pickRoadPoint(110,240,fx,fz);
    if(!p){toast('NO JOBS RIGHT NOW — CHECK BACK');return;}
    mission.target={x:p.x,z:p.z};
  }
  mission.type=type;mission.active=true;mission.phase='run';mission.stage=0;
  mission.marker=makeMarker();
  const tgt=(type==='car')?mission.car.pos:mission.target;
  mission.marker.g.position.set(tgt.x,0,tgt.z);
  mission.blip={x:tgt.x,z:tgt.z};
  const manh=Math.abs(tgt.x-fx)+Math.abs(tgt.z-fz);
  if(type==='delivery'||type==='hot'){
    mission.timeLimit=manh/10.5+18;
    mission.reward=180+Math.round(manh*1.1);
    if(type==='hot'){
      mission.reward+=350;
      mission.title='HOT GOODS — SHAKE THE COPS, MAKE THE DROP';
      addHeat(340);
      toast('THE ALARM TIPPED OFF THE COPS — DELIVER ANYWAY',3800);
    }else{
      mission.title='DELIVERY — MAKE THE DROP';
      toast('PACKAGE IN HAND — GET IT TO THE GOLD MARKER',3800);
    }
  }else{
    const manh2=Math.abs(mission.target.x-mission.car.pos.x)+Math.abs(mission.target.z-mission.car.pos.z);
    mission.timeLimit=manh/12+manh2/12+30;
    mission.reward=320+Math.round((manh+manh2)*0.9);
    mission.title='BOOST — STEAL THE GOLD STALLION';
    toast('A GOLD STALLION IS MARKED — BRING IT IN',3800);
  }
  mission.tLeft=mission.timeLimit;
  SFX.blip();
}
function completeMission(){
  const bonus=Math.round(Math.max(0,mission.tLeft)*4);
  const total=mission.reward+bonus;
  wallet.money+=total;wallet.missions++;
  saveWallet();
  if(mission.type==='hot')wanted.heat*=0.4;
  toast('MISSION COMPLETE — +$'+total+' (TIME BONUS $'+bonus+')',3600);
  SFX.jingle();
  cleanupMission();
  phoneCd=9;
}
function failMission(reason){
  if(!mission.active)return;
  toast('MISSION FAILED — '+reason);
  SFX.buzz();
  cleanupMission();
  phoneCd=12;
}
function cleanupMission(){
  if(mission.marker){
    scene.remove(mission.marker.g);
    mission.marker.ring.geometry.dispose();mission.marker.ring.material.dispose();
    mission.marker.beam.geometry.dispose();mission.marker.beam.material.dispose();
    mission.marker=null;
  }
  if(mission.car&&mission.car!==player.car)removeCar(mission.car);
  mission.car=null;mission.active=false;mission.phase='idle';
  mission.target=null;mission.blip=null;
}
function missionTick(dt){
  if(!mission.active){
    // walking up to an idle booth makes it ring for you (the ring follows
    // the player, GTA1-style); ambient rings elsewhere still happen
    let anyRing=false,idleNear=null;
    for(let k=0;k<phones.length;k++){
      const ph=phones[k];
      if(ph.ringing){anyRing=true;continue;}
      if(!idleNear&&dist2(player.pos.x,player.pos.z,ph.x,ph.z)<20)idleNear=ph;
    }
    if(idleNear)ringPhoneAt(idleNear);
    if(!anyRing&&!idleNear){
      phoneCd-=dt;
      if(phoneCd<=0)chooseRingingPhone();
    }
    for(let k=0;k<phones.length;k++){
      const ph=phones[k];
      if(!ph.ringing)continue;
      ph.ringT+=dt;
      ph.ring.visible=true;
      ph.ring.scale.setScalar(0.9+0.25*Math.sin(simNow*7));
      ph.ring.material.opacity=0.45+0.4*Math.sin(simNow*7);
      ph.screenMat.emissive.setHex(Math.floor(simNow*5)%2===0?0x37e0e8:0x0a3a44);
      if(simNow-lastRingSnd>2.2){
        lastRingSnd=simNow;
        const d=dist2(ph.x,ph.z,focusX(),focusZ());
        SFX.ring(Math.max(0,0.07*(1-d/260)));
      }
      if(ph.ringT>40){ph.ringing=false;ph.ring.visible=false;ph.screenMat.emissive.setHex(0x0a3a44);phoneCd=4;}
    }
    return;
  }
  if(mission.phase!=='run')return;
  mission.tLeft-=dt;
  if(mission.tLeft<=0){failMission('OUT OF TIME');return;}
  const m=mission.marker;
  if(m){
    m.ring.scale.setScalar(1+0.12*Math.sin(simNow*5));
    m.ring.material.opacity=0.6+0.3*Math.sin(simNow*5);
    m.beam.rotation.y+=dt*0.6;
  }
  if(mission.type==='car'){
    if(!mission.car||mission.car.disabled){failMission('THE STALLION IS TOTALLED');return;}
    if(mission.stage===0){
      if(m&&mission.car)m.g.position.set(mission.car.pos.x,0,mission.car.pos.z);
      if(player.car===mission.car){
        mission.stage=1;
        if(m)m.g.position.set(mission.target.x,0,mission.target.z);
        toast('GOOD — NOW DELIVER IT');
        SFX.blip();
      }
    }
    mission.blip=mission.stage===0
      ?{x:mission.car.pos.x,z:mission.car.pos.z}
      :{x:mission.target.x,z:mission.target.z};
  }else{
    mission.blip={x:mission.target.x,z:mission.target.z};
  }
  const fx=focusX(),fz=focusZ();
  if(mission.type==='car'){
    if(mission.stage===1&&player.car===mission.car&&
       dist2(fx,fz,mission.target.x,mission.target.z)<5.5)completeMission();
  }else{
    if(dist2(fx,fz,mission.target.x,mission.target.z)<4.5)completeMission();
  }
}

// ----------------------------- 11. audio -------------------------------------
const SFX={
  ctx:null,master:null,engOsc1:null,engOsc2:null,engFilter:null,engGain:null,
  skidGain:null,noiseBuf:null,muted:false,
  init(){
    if(this.ctx)return;
    try{
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC)return;
      this.ctx=new AC();
      this.master=this.ctx.createGain();
      this.master.gain.value=0.5;
      this.master.connect(this.ctx.destination);
      const len=(this.ctx.sampleRate*0.3)|0;
      const buf=this.ctx.createBuffer(1,len,this.ctx.sampleRate);
      const d=buf.getChannelData(0);
      for(let i=0;i<len;i++)d[i]=Math.random()*2-1;
      this.noiseBuf=buf;
      // engine
      this.engOsc1=this.ctx.createOscillator();this.engOsc1.type='sawtooth';this.engOsc1.frequency.value=60;
      this.engOsc2=this.ctx.createOscillator();this.engOsc2.type='square';this.engOsc2.frequency.value=90;
      const g2=this.ctx.createGain();g2.gain.value=0.35;
      this.engFilter=this.ctx.createBiquadFilter();this.engFilter.type='lowpass';this.engFilter.frequency.value=600;
      this.engGain=this.ctx.createGain();this.engGain.gain.value=0;
      this.engOsc1.connect(this.engFilter);this.engOsc2.connect(g2);g2.connect(this.engFilter);
      this.engFilter.connect(this.engGain);this.engGain.connect(this.master);
      this.engOsc1.start();this.engOsc2.start();
      // tire skid
      const sk=this.ctx.createBufferSource();sk.buffer=buf;sk.loop=true;
      const bp=this.ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=950;bp.Q.value=0.8;
      this.skidGain=this.ctx.createGain();this.skidGain.gain.value=0;
      sk.connect(bp);bp.connect(this.skidGain);this.skidGain.connect(this.master);
      sk.start();
      // police siren (wailing triangle, frequency-modulated)
      this.sirOsc=this.ctx.createOscillator();this.sirOsc.type='triangle';this.sirOsc.frequency.value=760;
      this.sirLFO=this.ctx.createOscillator();this.sirLFO.type='sine';this.sirLFO.frequency.value=1.3;
      this.sirDepth=this.ctx.createGain();this.sirDepth.gain.value=190;
      this.sirLFO.connect(this.sirDepth);this.sirDepth.connect(this.sirOsc.frequency);
      this.sirGain=this.ctx.createGain();this.sirGain.gain.value=0;
      this.sirOsc.connect(this.sirGain);this.sirGain.connect(this.master);
      this.sirOsc.start();this.sirLFO.start();
    }catch(e){this.ctx=null;}
  },
  resume(){if(this.ctx&&this.ctx.state==='suspended')this.ctx.resume();},
  update(driving,spd,throttle,lat,sirOn,sirDist){
    if(!this.ctx)return;
    const t=this.ctx.currentTime;
    const f=55+spd*7.5;
    this.engOsc1.frequency.setTargetAtTime(f,t,0.06);
    this.engOsc2.frequency.setTargetAtTime(f*1.494,t,0.06);
    this.engFilter.frequency.setTargetAtTime(420+spd*34+Math.abs(throttle)*260,t,0.08);
    const eg=driving?(0.045+Math.abs(throttle)*0.075+Math.min(spd*0.0012,0.02)):0;
    this.engGain.gain.setTargetAtTime(eg,t,0.09);
    const sg=(driving&&lat>5.5)?Math.min(0.13,(lat-5.5)*0.028):0;
    this.skidGain.gain.setTargetAtTime(sg,t,0.05);
    const sig=(sirOn&&sirDist<140)?Math.min(0.11,0.12*(1-sirDist/150)):0;
    this.sirGain.gain.setTargetAtTime(sig,t,0.15);
  },
  thud(vol){
    if(!this.ctx||this.muted)return;
    const t=this.ctx.currentTime;
    const s=this.ctx.createBufferSource();s.buffer=this.noiseBuf;
    const f=this.ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=260+vol*40;
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.5,vol*0.09),t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.22);
    s.connect(f);f.connect(g);g.connect(this.master);
    s.start(t);s.stop(t+0.25);
  },
  horn(){
    if(!this.ctx||this.muted)return;
    const t=this.ctx.currentTime;
    const o1=this.ctx.createOscillator();o1.type='square';o1.frequency.value=392;
    const o2=this.ctx.createOscillator();o2.type='square';o2.frequency.value=466;
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0.09,t);
    g.gain.setValueAtTime(0.09,t+0.18);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.32);
    o1.connect(g);o2.connect(g);g.connect(this.master);
    o1.start(t);o2.start(t);o1.stop(t+0.35);o2.stop(t+0.35);
  },
  ring(vol){
    if(!this.ctx||this.muted||vol<=0.004)return;
    const t=this.ctx.currentTime;
    for(let k=0;k<2;k++){
      const o=this.ctx.createOscillator();o.type='sine';o.frequency.value=k===0?1180:940;
      const g=this.ctx.createGain();
      const st=t+k*0.19;
      g.gain.setValueAtTime(0,st);
      g.gain.linearRampToValueAtTime(vol,st+0.015);
      g.gain.exponentialRampToValueAtTime(0.001,st+0.13);
      o.connect(g);g.connect(this.master);
      o.start(st);o.stop(st+0.16);
    }
  },
  jingle(){
    if(!this.ctx||this.muted)return;
    const t=this.ctx.currentTime;
    const notes=[660,880,1180];
    for(let k=0;k<notes.length;k++){
      const o=this.ctx.createOscillator();o.type='triangle';o.frequency.value=notes[k];
      const g=this.ctx.createGain();
      const st=t+k*0.1;
      g.gain.setValueAtTime(0.11,st);
      g.gain.exponentialRampToValueAtTime(0.001,st+0.22);
      o.connect(g);g.connect(this.master);
      o.start(st);o.stop(st+0.25);
    }
  },
  buzz(){
    if(!this.ctx||this.muted)return;
    const t=this.ctx.currentTime;
    const o=this.ctx.createOscillator();o.type='sawtooth';
    o.frequency.setValueAtTime(180,t);
    o.frequency.exponentialRampToValueAtTime(70,t+0.35);
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0.09,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.38);
    o.connect(g);g.connect(this.master);
    o.start(t);o.stop(t+0.4);
  },
  blip(){
    if(!this.ctx||this.muted)return;
    const t=this.ctx.currentTime;
    const o=this.ctx.createOscillator();o.type='square';o.frequency.value=980;
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0.07,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.09);
    o.connect(g);g.connect(this.master);
    o.start(t);o.stop(t+0.1);
  },
  toggle(){
    this.muted=!this.muted;
    if(this.master)this.master.gain.value=this.muted?0:0.5;
    return this.muted;
  }
};

// ----------------------------- 12. HUD / input -------------------------------
const titleEl=document.getElementById('title');
const hintEl=document.getElementById('hint');
const toastEl=document.getElementById('toast');
const speedoEl=document.getElementById('speedo');
const spdEl=document.getElementById('spd');
const cnameEl=document.getElementById('cname');
const pausedEl=document.getElementById('paused');
const wastedEl=document.getElementById('wasted');
const starEls=[
  document.getElementById('star0'),document.getElementById('star1'),
  document.getElementById('star2'),document.getElementById('star3'),
  document.getElementById('star4')
];
const hpfillEl=document.getElementById('hpfill');
const carbarWrapEl=document.getElementById('carbarwrap');
const carfillEl=document.getElementById('carfill');
const mmC=document.getElementById('minimap');
const mmCtx=(mmC&&mmC.getContext)?mmC.getContext('2d'):null;
const missionbarEl=document.getElementById('missionbar');
const mtitleEl=document.getElementById('mtitle');
const mtimerEl=document.getElementById('mtimer');
const moneyEl=document.getElementById('money');
const mcountEl=document.getElementById('mcount');
let toastTimer=0;
function toast(msg,dur){
  toastEl.textContent=msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toastEl.classList.remove('show'),dur||2600);
}
const keyState={f:0,b:0,l:0,r:0,run:0,hb:0};
const KEYMAP={KeyW:'f',ArrowUp:'f',KeyS:'b',ArrowDown:'b',KeyA:'l',ArrowLeft:'l',KeyD:'r',ArrowRight:'r',ShiftLeft:'run',ShiftRight:'run',Space:'hb'};
window.addEventListener('keydown',e=>{
  if(!started)startGame();
  const k=KEYMAP[e.code];
  if(k){keyState[k]=1;e.preventDefault();}
  if(e.repeat)return;
  if(e.code==='KeyE'){if(started&&!paused)pressedE=true;}
  else if(e.code==='KeyH'){
    if(started&&!paused&&player.state==='drive'){
      SFX.horn();
      scarePeds(player.car.pos.x,player.car.pos.z,17);
    }
  }
  else if(e.code==='KeyM'){toast(SFX.toggle()?'SOUND OFF':'SOUND ON');}
  else if(e.code==='KeyP'){
    if(started){paused=!paused;pausedEl.style.display=paused?'block':'none';}
  }
});
window.addEventListener('keyup',e=>{const k=KEYMAP[e.code];if(k)keyState[k]=0;});
window.addEventListener('blur',()=>{for(const k in keyState)keyState[k]=0;});
titleEl.addEventListener('click',startGame);
function startGame(){
  if(started)return;
  started=true;
  titleEl.classList.add('hide');
  SFX.init();SFX.resume();
  setTimeout(()=>toast('WELCOME TO SUNSET CITY — GRAB A RIDE (E)'),450);
}
function updateHUD(){
  if(player.state==='drive'){
    speedoEl.style.display='block';
    spdEl.textContent=Math.round(Math.abs(player.car.fs)*3.6);
  }else{
    speedoEl.style.display='none';
  }
  // wanted stars
  const s=starsFromHeat();
  wanted.stars=s;
  if(s>prevStars)toast('WANTED LEVEL '+'★'.repeat(s));
  else if(s===0&&prevStars>0&&wanted.everWanted)toast('YOU LOST THE COPS');
  if(s>0)wanted.everWanted=true;else wanted.everWanted=false;
  const pop=s>prevStars;
  prevStars=s;
  for(let i=0;i<5;i++){
    const cls=i<s?('star on'+(pop?' pop':'')):'star';
    if(starEls[i].className!==cls)starEls[i].className=cls;
  }
  // health + car damage
  const pct=clamp(player.hp,0,100);
  hpfillEl.style.width=pct+'%';
  hpfillEl.style.background=pct>60?'#57c15a':(pct>30?'#e0a63a':'#e04b3a');
  if(player.state==='drive'){
    carbarWrapEl.style.display='block';
    carfillEl.style.width=clamp(player.car.hp/player.car.maxHp*100,0,100)+'%';
  }else{
    carbarWrapEl.style.display='none';
  }
  // money + missions
  if(wallet.money!==lastMoneyShown){
    lastMoneyShown=wallet.money;
    moneyEl.textContent='$'+wallet.money.toLocaleString('en-US');
    moneyEl.className='';void moneyEl.offsetWidth;moneyEl.className='pop';
  }
  mcountEl.textContent='MISSIONS · '+wallet.missions;
  // mission bar
  if(mission.active&&mission.phase==='run'){
    missionbarEl.style.display='block';
    mtitleEl.textContent=mission.title;
    const s=Math.max(0,Math.ceil(mission.tLeft));
    mtimerEl.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
    mtimerEl.className=mission.tLeft<10?'low':'';
  }else{
    missionbarEl.style.display='none';
  }
  // context hint (phone beats car)
  let msg='';
  if(started&&player.state==='foot'&&player.wastedT<=0){
    if(nearRingingPhone(2.8))msg='E — ANSWER PHONE';
    else{
      const c=nearestEnterable(4.6);
      if(c)msg='E — ENTER '+c.type.name;
    }
  }
  if(msg){hintEl.textContent=msg;hintEl.style.display='block';}
  else hintEl.style.display='none';
  drawMinimap();
}
let prevStars=0,lastMoneyShown=-1;
// ----------------------------- 12.5 minimap ----------------------------------
function drawMinimap(){
  if(!mmCtx)return;
  const g=mmCtx;
  const W=mmC.width||172,H=mmC.height||172,cx=W/2,cy=H/2;
  const fx=focusX(),fz=focusZ();
  const R=Math.min(cx,cy)-3,worldR=105,sc=R/worldR;
  const mx=wx=>cx+(wx-fx)*sc;
  const my=wz=>cy+(wz-fz)*sc;
  g.clearRect(0,0,W,H);
  g.save();
  g.beginPath();g.arc(cx,cy,R,0,Math.PI*2);g.clip();
  // grass base, then city asphalt pad
  g.fillStyle='#26301e';g.fillRect(0,0,W,H);
  g.fillStyle='#3a4048';
  g.fillRect(mx(-RH-18),my(-RH-18),(CITY+2*RH+36)*sc,(CITY+2*RH+36)*sc);
  // blocks: parks green, others dark; buildings darker still
  const i0=Math.max(0,Math.floor((fx-worldR-RH)/P)),i1=Math.min(N-1,Math.floor((fx+worldR)/P));
  const j0=Math.max(0,Math.floor((fz-worldR-RH)/P)),j1=Math.min(N-1,Math.floor((fz+worldR)/P));
  for(let i=i0;i<=i1;i++)for(let j=j0;j<=j1;j++){
    g.fillStyle=parkSet.has(i+','+j)?'#31502a':'#23272d';
    g.fillRect(mx(i*P+RH),my(j*P+RH),BLOCK*sc,BLOCK*sc);
    const cell=cellAt(i,j);
    g.fillStyle='#15171b';
    for(let k=0;k<cell.aabbs.length;k++){
      const b=cell.aabbs[k];
      g.fillRect(mx(b.minX),my(b.minZ),(b.maxX-b.minX)*sc,(b.maxZ-b.minZ)*sc);
    }
  }
  // traffic
  g.fillStyle='#c9ced6';
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    if(c.mode!=='ai')continue;
    g.fillRect(mx(c.pos.x)-1,my(c.pos.z)-1,2,2);
  }
  // police (flashing red/blue)
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    if(c.mode!=='police'||c.retired)continue;
    g.fillStyle=(Math.floor(simNow*5)%2===0)?'#ff3b30':'#3b7bff';
    g.beginPath();g.arc(mx(c.pos.x),my(c.pos.z),3,0,Math.PI*2);g.fill();
  }
  // mission target (gold, pulsing) or ringing phone (cyan, pulsing)
  if(mission.active&&mission.blip){
    g.fillStyle=(Math.floor(simNow*4)%2===0)?'#ffd23f':'#c7952a';
    g.beginPath();g.arc(mx(mission.blip.x),my(mission.blip.z),4.5,0,Math.PI*2);g.fill();
  }else{
    for(let k=0;k<phones.length;k++){
      const ph=phones[k];
      if(!ph.ringing)continue;
      g.fillStyle=(Math.floor(simNow*4)%2===0)?'#54e0e8':'#2a8f96';
      g.beginPath();g.arc(mx(ph.x),my(ph.z),3,0,Math.PI*2);g.fill();
    }
  }
  // player arrow
  const ph=player.state==='drive'?player.car.h:player.h;
  g.save();
  g.translate(cx,cy);g.rotate(-ph);
  g.fillStyle='#ffd23f';
  g.beginPath();g.moveTo(0,-6);g.lineTo(4.2,4.5);g.lineTo(0,2.4);g.lineTo(-4.2,4.5);g.closePath();g.fill();
  g.restore();
  g.restore();
  // ring + north marker
  g.strokeStyle='rgba(255,210,63,.85)';g.lineWidth=2;
  g.beginPath();g.arc(cx,cy,R,0,Math.PI*2);g.stroke();
  g.fillStyle='rgba(255,255,255,.7)';g.font='bold 9px Arial';g.textAlign='center';
  g.fillText('N',cx,11);
}

// ----------------------------- 13. camera ------------------------------------
const camPos=new THREE.Vector3(player.pos.x,70,player.pos.z+17);
const lookPos=new THREE.Vector3(player.pos.x,0,player.pos.z);
function updateCamera(dt){
  const drv=player.state==='drive';
  const c=drv?player.car:null;
  const fx=focusX(),fz=focusZ();
  let vx=0,vz=0,spd=0;
  if(c){vx=c.vel.x;vz=c.vel.z;spd=Math.hypot(vx,vz);}
  const lead=Math.min(spd*0.42,11);
  let tx=fx,tz=fz;
  if(spd>1){tx+=vx/spd*lead;tz+=vz/spd*lead;}
  const hgt=drv?76+Math.min(spd,32)*0.5:70;
  const back=17+Math.min(spd,32)*0.14;
  const k=1-Math.exp(-4.5*dt),k2=1-Math.exp(-7*dt);
  camPos.x+=(tx-camPos.x)*k;
  camPos.y+=(hgt-camPos.y)*k;
  camPos.z+=(tz+back-camPos.z)*k;
  lookPos.x+=(tx-lookPos.x)*k2;
  lookPos.z+=(tz-lookPos.z)*k2;
  camera.position.copy(camPos);
  if(shake>0){
    shake=Math.max(0,shake-dt*2.4);
    const s=shake*shake*1.6;
    camera.position.x+=(Math.random()-0.5)*s;
    camera.position.z+=(Math.random()-0.5)*s;
    camera.position.y+=(Math.random()-0.5)*s*0.5;
  }
  camera.lookAt(lookPos.x,0,lookPos.z);
}

// ----------------------------- 14. respawn manager ---------------------------
let respT=1.5;
function respawnTick(dt){
  respT-=dt;
  if(respT>0)return;
  respT=1.2;
  const fx=focusX(),fz=focusZ();
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    if(c.mode!=='ai')continue;
    if(dist2(c.pos.x,c.pos.z,fx,fz)>310)spawnAIOnEdgeNear(c,fx,fz,90,190);
  }
  for(let k=0;k<peds.length;k++){
    const p=peds[k];
    if(dist2(p.pos.x,p.pos.z,fx,fz)>200)pedRelocate(p,fx,fz);
  }
}

// ----------------------------- 15. world update ------------------------------
function update(dt){
  simNow+=dt;
  updatePlayer(dt);
  for(let k=0;k<cars.length;k++){
    const c=cars[k];
    if(c===player.car)continue;
    if(c.mode==='ai')c.aiThink(dt);
    else if(c.mode==='police')c.policeThink(dt);
    c.step(dt,(c.mode==='ai'||c.mode==='police')?c.aiInp:ZERO_INP);
  }
  collideCars();
  for(let k=0;k<cars.length;k++)cars[k].collideStatics();
  for(let k=0;k<peds.length;k++)peds[k].update(dt);
  pedCarInteractions();
  wantedTick(dt);
  missionTick(dt);
  respawnTick(dt);
  for(let k=0;k<cars.length;k++)cars[k].syncMesh();
  for(let k=0;k<peds.length;k++)peds[k].syncMesh();
  syncPlayerMesh();
}

// ----------------------------- 16. boot --------------------------------------
buildCity();
spawnParked();
loadWallet();
spawnPhones();
for(let i=0;i<24;i++){
  const c=spawnAICar();
  spawnAIOnEdgeNear(c,player.pos.x,player.pos.z,55,280);
}
for(let i=0;i<44;i++){
  const p=new Ped();
  pedRelocate(p,player.pos.x,player.pos.z,12,150);
}
for(let i=0;i<4;i++)peds[i].setBlock(4,4); // a few locals in the spawn park
syncPlayerMesh();
console.log('[SUNSET CITY] ready — '+buildingCount+' buildings, '+cars.length+' cars, '+peds.length+' peds');

let last=performance.now();
function tick(){
  requestAnimationFrame(tick);
  const now=performance.now();
  let dt=(now-last)/1000;
  last=now;
  if(dt>0.05)dt=0.05;
  if(dt<0)dt=0;
  if(!paused)update(dt);
  updateCamera(dt);
  updateHUD();
  const c=player.car;
  // siren loudness from the nearest active cop
  let sirOn=false,sirDist=1e9;
  for(let k=0;k<cars.length;k++){
    const pc=cars[k];
    if(pc.mode!=='police'||pc.retired||pc.disabled)continue;
    sirOn=true;
    const dd=dist2(pc.pos.x,pc.pos.z,focusX(),focusZ());
    if(dd<sirDist)sirDist=dd;
  }
  SFX.update(!!c,c?Math.abs(c.fs):0,c?((keyState.f?1:0)-(keyState.b?1:0)):0,c?Math.abs(c.lat):0,sirOn,sirDist);
  const fx=focusX(),fz=focusZ();
  sun.position.set(fx-80,130,fz-55);
  sun.target.position.set(fx,0,fz);
  sun.target.updateMatrixWorld();
  renderer.render(scene,camera);
}
tick();

// debug/testing hook (harmless in production)
window.__DBG={player:player,cars:cars,peds:peds,wanted:wanted,
              addHeat:addHeat,damagePlayer:damagePlayer,wreck:wreckCar,removeCar:removeCar,
              mission:mission,phones:phones,wallet:wallet,
              ringPhoneAt:ringPhoneAt,startMission:startMission};
