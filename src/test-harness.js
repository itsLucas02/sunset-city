// Headless smoke test: stubs DOM/WebGL/time, runs the real game logic for
// ~3400 deterministic 60fps frames with scripted input, then asserts sanity.
'use strict';
global.THREE = require('./three.min.js');
const THREE = global.THREE;

// --- stub the WebGL renderer (real three.js does all the math) ---
THREE.WebGLRenderer = function () {
  this.shadowMap = {};
  this.capabilities = { getMaxAnisotropy: () => 4 };
  this.setPixelRatio = () => {};
  this.setSize = () => {};
  this.domElement = {};
  this.render = () => {};
};

const ctxStub = new Proxy({}, {
  get: (t, p) => {
    if (p === 'createRadialGradient' || p === 'createLinearGradient')
      return () => ({ addColorStop() {} });
    return (typeof p === 'string' ? (() => {}) : undefined);
  },
  set: () => true,
});
const makeEl = () => ({
  style: {},
  className: '',
  classList: { add() {}, remove() {} },
  textContent: '',
  addEventListener() {},
  appendChild() {},
  getContext: () => ctxStub,
  width: 172,
  height: 172,
});

const winHandlers = {};
global.window = {
  addEventListener: (ev, fn) => { (winHandlers[ev] = winHandlers[ev] || []).push(fn); },
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  // no AudioContext on purpose: exercises the SFX guards
};
global.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub, style: {} }),
  body: { appendChild() {} },
  getElementById: () => makeEl(),
  addEventListener() {},
};

// deterministic clock: the game reads performance.now()
let simTime = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => simTime }, configurable: true, writable: true,
});

let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
global.setTimeout = () => 0; // silence toasts

// --- load the game (builds the whole city + spawns everything) ---
require('./game.js');
const DBG = global.window.__DBG;
if (!DBG) throw new Error('debug hook missing');

function fireKey(code, type) {
  (winHandlers[type] || []).forEach(fn => fn({ code, repeat: false, preventDefault() {} }));
}
const down = c => fireKey(c, 'keydown');
const up = c => fireKey(c, 'keyup');

function frames(n) {
  for (let i = 0; i < n; i++) {
    simTime += 16.7; // 60 fps
    const cb = rafCb; rafCb = null;
    cb(simTime);
    if (rafCb === null) throw new Error('rAF chain broken');
  }
}
const finite = v => Number.isFinite(v);
const aiCars = () => DBG.cars.filter(c => c.mode === 'ai');

// --- 1. traffic sanity BEFORE the player does anything ---
const pedPos0 = DBG.peds.map(p => p.pos.x + p.pos.z);
const aiPos0 = aiCars().map(c => c.pos.x + c.pos.z);
frames(300); // ~5s of pure city life
const pedsMoved = DBG.peds.filter((p, i) => Math.abs(p.pos.x + p.pos.z - pedPos0[i]) > 0.5).length;
const aiMoved = aiCars().filter((c, i) => Math.abs(c.pos.x + c.pos.z - aiPos0[i]) > 3).length;
console.log(`city life: ${aiMoved}/${aiCars().length} AI cars driving, ${pedsMoved}/${DBG.peds.length} peds walking`);
if (aiMoved < aiCars().length * 0.6) throw new Error('AI traffic is not driving');
if (pedsMoved < DBG.peds.length * 0.5) throw new Error('pedestrians are not walking');

// --- 2. player script ---
down('KeyW');  frames(120);       // start game, walk north
up('KeyW');
down('KeyS');  frames(120);       // walk south past the parked Stallion
up('KeyS');
down('KeyE');  frames(2);  up('KeyE');   // enter the car
if (DBG.player.state !== 'drive') throw new Error('failed to enter car');
console.log('entered car:', DBG.player.car.type.name);

down('KeyW');  frames(240);       // accelerate (wrong-way into traffic!)
down('KeyA');  frames(80);  up('KeyA');  // turn left (through the spawn park)
down('KeyD');  frames(160); up('KeyD');  // turn right
down('Space'); frames(90);  up('Space'); // handbrake drift
up('KeyW');
down('KeyS');  frames(60);  up('KeyS');  // brake/reverse
down('KeyE');  frames(2);  up('KeyE');   // exit
if (DBG.player.state !== 'foot') throw new Error('failed to exit car');
console.log('exited car, player at', DBG.player.pos.x.toFixed(1), DBG.player.pos.z.toFixed(1));

down('KeyW'); down('ShiftLeft'); frames(200);  // sprint around
up('ShiftLeft'); up('KeyW');
down('KeyH'); up('KeyH');                 // horn
down('KeyM'); up('KeyM');                 // mute
down('KeyP'); up('KeyP'); frames(30);     // pause
down('KeyP'); up('KeyP');                 // unpause

// --- 3. deliberate ped hit: get back in a car, line up behind a pedestrian ---
let nc = null, nd = 1e9;
for (const c of DBG.cars) {
  const d = Math.hypot(c.pos.x - DBG.player.pos.x, c.pos.z - DBG.player.pos.z);
  if (d < nd) { nd = d; nc = c; }
}
DBG.player.pos.x = nc.pos.x + 2.5;
DBG.player.pos.z = nc.pos.z;
down('KeyE'); frames(2); up('KeyE');      // re-enter nearest car
if (DBG.player.state !== 'drive') throw new Error('failed to re-enter car');
console.log('re-entered:', DBG.player.car.type.name, '(' + DBG.player.car.mode + ')');
const car = DBG.player.car;
const victim = DBG.peds.find(p => p.state !== 'down');
// stage on a clear stretch of the spawn road (z=270), ped facing the traffic
victim.pos.x = 300; victim.pos.z = 270;
victim.corners = null;                    // stand still for the setup
victim.state = 'walk';
car.pos.x = 293; car.pos.z = 270;
car.h = -Math.PI / 2;                     // face east: forward = (+1, 0)
car.vel.x = 14; car.vel.z = 0;            // already rolling — no escape
down('KeyW'); frames(70); up('KeyW');
console.log('run-over test: victim state =', victim.state);
if (victim.state !== 'down') throw new Error('ped was not knocked down by car');

// --- 4. rampage: weave through the city ---
for (let phase = 0; phase < 10; phase++) {
  down('KeyW');
  if (phase % 3 === 0) down('KeyA'); else if (phase % 3 === 1) down('KeyD');
  frames(140);
  up('KeyA'); up('KeyD'); up('KeyW');
}
frames(600); // let respawn manager + AI settle

// --- 5. wanted level & police chases ---
function enterSomeCar() {
  if (DBG.player.state === 'drive') return DBG.player.car;
  let best = null, bd = 1e9;
  for (const c of DBG.cars) {
    if (c.disabled) continue;
    const d = Math.hypot(c.pos.x - DBG.player.pos.x, c.pos.z - DBG.player.pos.z);
    if (d < bd) { bd = d; best = c; }
  }
  DBG.player.pos.x = best.pos.x + 2.5;
  DBG.player.pos.z = best.pos.z;
  down('KeyE'); frames(2); up('KeyE');
  if (DBG.player.state !== 'drive') throw new Error('could not enter a car');
  return DBG.player.car;
}
const ride = enterSomeCar();
ride.hp = 99999; ride.maxHp = 99999;   // keep the player alive through the chase
const copsNow = () => DBG.cars.filter(c => c.mode === 'police' && !c.retired);

DBG.addHeat(500);                       // 3 stars w/ headroom (heat decays until cops close in)
frames(30);
if (DBG.wanted.stars < 3) throw new Error('wanted stars did not rise');
frames(420);                            // cops trickle in on a 1.6s cadence
console.log('cops active at 3 stars:', copsNow().length);
if (copsNow().length < 3) throw new Error('police did not spawn');

const distToPlayer = c => Math.hypot(c.pos.x - DBG.player.pos.x, c.pos.z - DBG.player.pos.z);
const d0 = Math.min(...copsNow().map(distToPlayer));
frames(150);                            // ~2.5s of pursuit
const d1 = Math.min(...copsNow().map(distToPlayer));
console.log('pursuit distance', d0.toFixed(1), '→', d1.toFixed(1));
if (d1 > d0 && d1 > 25) throw new Error('police are not converging on the player');

// heat clears → cops stand down
DBG.wanted.heat = 0;
frames(120);
if (copsNow().length !== 0) throw new Error('police did not stand down at zero heat');

// heat decays while evading (no cops in sight)
DBG.wanted.noSpawn = true;
for (const c of DBG.cars.filter(c => c.mode === 'police')) DBG.removeCar(c);
for (const c of DBG.cars.filter(c => c.disabled)) DBG.removeCar(c);   // no fuse-explosions re-adding heat
DBG.wanted.heat = 300;
DBG.wanted.lastCopSeen = -9999;
frames(2000);                           // 33s: star-scaled decay 300→0 (~29s)
console.log('heat after evasion:', DBG.wanted.heat.toFixed(1), 'stars:', DBG.wanted.stars);
if (DBG.wanted.heat > 0) throw new Error('heat did not decay while evading');
DBG.wanted.noSpawn = false;

// --- 6. health, wasted, wreck ---
DBG.damagePlayer(50);
frames(300);                            // 5s of regen
if (DBG.player.hp <= 50) throw new Error('health did not regenerate');
DBG.addHeat(200);
DBG.damagePlayer(999);
frames(5);
if (DBG.player.wastedT <= 0) throw new Error('WASTED was not triggered');
frames(230);                            // 3.8s > 3.2s respawn timer
if (DBG.player.state !== 'foot' || DBG.player.hp !== 100) throw new Error('respawn failed');
if (DBG.wanted.heat !== 0) throw new Error('heat not cleared on respawn');
console.log('wasted + respawn OK, heat cleared');

frames(200);                            // burn off respawn invulnerability
const wreckRide = enterSomeCar();
DBG.wreck(wreckRide);
frames(3);
if (!wreckRide.disabled) throw new Error('car was not disabled by wreck');
if (DBG.player.hp >= 100) throw new Error('player took no damage from wrecking their car');
console.log('wreck test OK — player hp', DBG.player.hp.toFixed(0));
down('KeyE'); frames(2); up('KeyE');
if (DBG.player.state !== 'foot') throw new Error('could not exit the wreck');
frames(400);                            // settle, cleanup, respawn manager

// --- 7. missions & money ---
if (!DBG.phones.length) throw new Error('no phone booths spawned');
console.log('phones:', DBG.phones.length, '| wallet: $' + DBG.wallet.money, '·', DBG.wallet.missions, 'missions done');

// 7a. proximity: walking up to an idle booth makes it ring, then E answers it
DBG.ringPhoneAt(null);                          // silence everything first
DBG.player.pos.x = DBG.phones[3].x + 6;         // inside the 20-unit approach trigger
DBG.player.pos.z = DBG.phones[3].z;
frames(3);
if (!DBG.phones[3].ringing) throw new Error('walking up to a booth did not make it ring');
DBG.player.pos.x = DBG.phones[3].x + 1.5;
DBG.player.pos.z = DBG.phones[3].z;
down('KeyE'); frames(2); up('KeyE');
if (!DBG.mission.active) throw new Error('proximity-ringing phone could not be answered');
DBG.mission.tLeft = 0.05; frames(5);            // cancel it — 7b tests the scripted flow
if (DBG.mission.active) throw new Error('could not cancel proximity mission');
console.log('proximity ringing OK — booths ring as you approach');

// 7b. answer a ringing phone → first job is a delivery
DBG.ringPhoneAt(DBG.phones[0]);
DBG.player.pos.x = DBG.phones[0].x + 1.5;
DBG.player.pos.z = DBG.phones[0].z;
down('KeyE'); frames(2); up('KeyE');
if (!DBG.mission.active) throw new Error('answering the ringing phone did not start a mission');
if (DBG.mission.type !== 'delivery') throw new Error('first job should be a delivery, got ' + DBG.mission.type);
console.log('phone answered → mission:', DBG.mission.type, '· reward $' + DBG.mission.reward, '· time limit', DBG.mission.timeLimit.toFixed(0) + 's');

// 7b. deliver on foot (teleport to the gold marker)
const money0 = DBG.wallet.money;
DBG.player.pos.x = DBG.mission.target.x;
DBG.player.pos.z = DBG.mission.target.z;
frames(5);
if (DBG.mission.active) throw new Error('delivery did not complete at the gold marker');
if (DBG.wallet.money <= money0) throw new Error('delivery reward was not paid');
console.log('delivery complete — wallet $' + money0 + ' → $' + DBG.wallet.money + ' (missions done: ' + DBG.wallet.missions + ')');

// 7c. car boost: steal the gold Stallion, deliver it
DBG.startMission('car');
frames(2);
if (!DBG.mission.active) throw new Error('car boost did not start');
if (!DBG.mission.car) throw new Error('no gold Stallion was spawned');
DBG.player.pos.x = DBG.mission.car.pos.x + 1.5;
DBG.player.pos.z = DBG.mission.car.pos.z;
down('KeyE'); frames(3); up('KeyE');
if (DBG.player.car !== DBG.mission.car) throw new Error('could not enter the gold Stallion');
if (DBG.mission.stage !== 1) throw new Error('boost stage did not advance after stealing the Stallion');
DBG.player.car.pos.x = DBG.mission.target.x;   // teleport the goods to the dropoff
DBG.player.car.pos.z = DBG.mission.target.z;
frames(5);
if (DBG.mission.active) throw new Error('boost did not complete at the dropoff');
if (DBG.wallet.money <= money0) throw new Error('boost reward was not paid');
console.log('boost complete — wallet now $' + DBG.wallet.money);
down('KeyE'); frames(2); up('KeyE');           // leave the Stallion behind
if (DBG.player.state !== 'foot') throw new Error('could not exit after the boost');

// 7d. timeout failure
DBG.ringPhoneAt(DBG.phones[1]);
DBG.player.pos.x = DBG.phones[1].x + 1.5;
DBG.player.pos.z = DBG.phones[1].z;
down('KeyE'); frames(2); up('KeyE');
if (!DBG.mission.active) throw new Error('second phone did not start a mission');
DBG.mission.tLeft = 0.05;
frames(5);
if (DBG.mission.active) throw new Error('mission did not fail on timeout');
console.log('timeout failure OK');

// 7e. hot goods: instant heat, getting wasted cancels the job
DBG.startMission('hot');
frames(2);
if (!DBG.mission.active) throw new Error('hot goods run did not start');
if (DBG.wanted.heat < 300) throw new Error('hot goods did not trip the alarm (heat ' + DBG.wanted.heat.toFixed(0) + ')');
console.log('hot goods: instant heat', DBG.wanted.heat.toFixed(0), '· stars', DBG.wanted.stars);
DBG.damagePlayer(999);
frames(250);                            // wasted → respawn → mission failed
if (DBG.mission.active) throw new Error('getting wasted did not fail the mission');
if (DBG.player.hp !== 100 || DBG.player.state !== 'foot') throw new Error('respawn after hot run failed');
console.log('wasted cancels the mission OK');
frames(400);                            // settle phones / cops stand down

// --- 8. v4: packages, props, explosions, taxi, day/night ---
// 8a. hidden packages
if (DBG.pkgs.length < 20) throw new Error('too few packages spawned: ' + DBG.pkgs.length);
const pkN = DBG.pkgs.length, moneyPk = DBG.wallet.money;
DBG.player.pos.x = DBG.pkgs[0].x;
DBG.player.pos.z = DBG.pkgs[0].z;
frames(4);
if (DBG.pkgs.length !== pkN - 1) throw new Error('package was not collected');
if (DBG.wallet.money !== moneyPk + 100) throw new Error('package paid wrong amount');
console.log('package collected —', (25 - DBG.pkgs.length) + '/25 found, wallet $' + DBG.wallet.money);

// 8b. destructible props — drive through a hydrant and a trash can
const hyd = DBG.props.hydrants.find(h => !h.broken);
if (!hyd) throw new Error('no hydrants spawned');
const cn = DBG.props.cans.find(c => !c.broken);
if (!cn) throw new Error('no trash cans spawned');
const smashCar = enterSomeCar();
smashCar.hp = 99999; smashCar.maxHp = 99999;
smashCar.pos.x = hyd.x - 3; smashCar.pos.z = hyd.z;
smashCar.h = -Math.PI / 2; smashCar.vel.x = 13; smashCar.vel.z = 0;
frames(10);
if (!hyd.broken) throw new Error('hydrant did not break when hit');
smashCar.pos.x = cn.x - 3; smashCar.pos.z = cn.z;
smashCar.h = -Math.PI / 2; smashCar.vel.x = 13; smashCar.vel.z = 0;
frames(10);
if (!cn.broken) throw new Error('trash can did not break when hit');
frames(30);                             // let the can settle
console.log('props OK — hydrant geyser + flying trash can');

// 8c. explosions — wrecked cars burn, then blow up with area damage
down('KeyE'); frames(2); up('KeyE');     // get out of the car
if (DBG.player.state !== 'foot') throw new Error('could not exit before explosion test');
DBG.player.pos.x = 480; DBG.player.pos.z = 480;   // far corner, out of blast range
const boomVictim = DBG.cars.find(c => c.mode === 'ai');
boomVictim.mode = 'parked'; boomVictim.pos.x = 60; boomVictim.pos.z = 60; boomVictim.vel.x = 0; boomVictim.vel.z = 0;
const boomNeighbor = DBG.cars.find(c => c.mode === 'ai' && c !== boomVictim);
boomNeighbor.mode = 'parked'; boomNeighbor.pos.x = 64; boomNeighbor.pos.z = 60; boomNeighbor.vel.x = 0; boomNeighbor.vel.z = 0;
const hpN = boomNeighbor.hp;
DBG.wreck(boomVictim);
frames(470);                            // ~7.8s > 7s fuse
if (DBG.cars.includes(boomVictim)) throw new Error('wrecked car did not explode');
if (boomNeighbor.hp >= hpN) throw new Error('explosion did not damage the neighbor car');
console.log('explosion OK — victim removed, neighbor hp', hpN.toFixed(0), '→', boomNeighbor.hp.toFixed(0));

// 8d. taxi fares — hail, pick up, drop off, get paid
const moneyT = DBG.wallet.money;
const cab = DBG.spawnCab(DBG.player.pos.x + 3, DBG.player.pos.z);
DBG.player.pos.x = cab.pos.x + 1.5;
DBG.player.pos.z = cab.pos.z;
down('KeyE'); frames(2); up('KeyE');
if (DBG.player.car !== cab) throw new Error('could not enter the cab');
DBG.forceHail();
frames(3);
if (DBG.taxi.mode !== 'hail' || !DBG.taxi.ped) throw new Error('no passenger hailed the cab');
const farePed = DBG.taxi.ped;
cab.pos.x = farePed.pos.x; cab.pos.z = farePed.pos.z;
cab.vel.x = 0; cab.vel.z = 0;
frames(4);
if (DBG.taxi.mode !== 'riding' || !DBG.taxi.dest) throw new Error('passenger did not board');
cab.pos.x = DBG.taxi.dest.x; cab.pos.z = DBG.taxi.dest.z;
cab.vel.x = 0; cab.vel.z = 0;
frames(4);
if (DBG.taxi.mode !== 'off') throw new Error('fare did not complete at the drop-off');
if (DBG.wallet.money <= moneyT) throw new Error('fare was not paid');
console.log('taxi OK — fare paid, wallet $' + moneyT + ' → $' + DBG.wallet.money);
// timeout failure
DBG.forceHail();
frames(3);
cab.pos.x = DBG.taxi.ped.pos.x; cab.pos.z = DBG.taxi.ped.pos.z;
cab.vel.x = 0; cab.vel.z = 0;
frames(4);
DBG.taxi.tLeft = 0.05;
const moneyT2 = DBG.wallet.money;
frames(5);
if (DBG.taxi.mode !== 'off') throw new Error('timed-out fare did not reset');
if (DBG.wallet.money !== moneyT2) throw new Error('timed-out fare paid anyway');
console.log('taxi timeout OK — no pay');
down('KeyE'); frames(2); up('KeyE');     // leave the cab

// 8e. day / night cycle
DBG.setDayT(0.5); frames(3);
if (DBG.nightF() > 0.2) throw new Error('noon should be day, nightF=' + DBG.nightF().toFixed(2));
DBG.setDayT(0.0); frames(3);
if (DBG.nightF() < 0.7) throw new Error('midnight should be night, nightF=' + DBG.nightF().toFixed(2));
console.log('day/night OK — midnight nightF =', DBG.nightF().toFixed(2));
DBG.setDayT(0.36); frames(3);
frames(400);                            // settle

// --- assertions ---
for (const c of DBG.cars) {
  if (!finite(c.pos.x) || !finite(c.pos.z) || !finite(c.h)) throw new Error('car NaN: ' + c.type.name);
  if (!finite(c.vel.x) || !finite(c.vel.z)) throw new Error('car NaN velocity');
}
for (const p of DBG.peds) {
  if (!finite(p.pos.x) || !finite(p.pos.z)) throw new Error('ped NaN position');
}
if (!finite(DBG.player.pos.x) || !finite(DBG.player.pos.z)) throw new Error('player NaN');

const downed = DBG.peds.filter(p => p.state === 'down').length;
const fleeing = DBG.peds.filter(p => p.state === 'flee').length;
const avgAiSpeed = aiCars().reduce((s, c) => s + Math.hypot(c.vel.x, c.vel.z), 0) / aiCars().length;
console.log(`cars=${DBG.cars.length} (ai=${aiCars().length}) avgAiSpeed=${avgAiSpeed.toFixed(1)} | peds=${DBG.peds.length} downed=${downed} fleeing=${fleeing}`);
console.log(`sim time ${(simTime / 1000).toFixed(1)}s, player state=${DBG.player.state}`);
if (DBG.cars.length < 30) throw new Error('lost cars somehow');
if (DBG.peds.length < 40) throw new Error('lost peds somehow');
console.log('SMOKE TEST PASSED');
