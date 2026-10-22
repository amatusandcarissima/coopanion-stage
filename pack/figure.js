/**
 * whale-stage —— 形象包入口(api 2)
 *
 * 用现有鲸鲸的部件拼出"上墙/坐窗沿"的能力,不画新图:
 *   - 包的 body 直接建立在 kit 的 createBody 之上(所以表情、拖动、说话、漫游、原有动作全部继承);
 *   - "地板"由本包包装 host.bounds() 提供:perch 时把 floorY 换成屏幕上的任意高度,
 *     kit 自己的落地/影子/hit 圈/气泡都会跟着走;
 *   - 姿势只通过 whale.js 里的 o.pose 钩子改手势/头部参数(原生包不传 o.pose,行为不变);
 *   - move 目标 watch / type / floor / near 由本文件编排(kit 的 body 没有 move)。
 *
 * 坐标系:页面 px == 桌面 DIP;x/y 都是屏幕比例(0..1),y=0 屏幕顶端、y=1 屏幕底,
 * 落座地板 perchY = y * H。
 */
import { createWhaleFigure } from './whale.js';

/**
 * 自测钩子(交付版必须为 null):设为 { to: 'watch', params: [.55, .72] } 后,
 * 包加载 1.6 秒会自动发起一次 move,方便无人值守时对着屏幕截图验证落座。
 * 调试方法:把 null 改成目标对象 -> 重新安装/热切形象 -> 截图 -> 改回 null。
 */
const DEV_AUTOPOSE = null;

/**
 * 攀爬速度(毫秒)。形象包没有 UI 设置,调这里改爬行速度:
 *   CLIMB_RISE_MS —— 从低处爬到高处的基准时长(按爬升高度在 0.55~1.7 倍之间缩放)
 *   CLIMB_FALL_MS —— 从高处下来/向下爬的基准时长(比上升略快,像顺着墙小心地出溜下来)
 *   CLIMB_STEP_PX —— 每"抓一把"对应的屏幕像素;它决定手脚交替的频率(爬得多快,手就抓得多快)
 */
const CLIMB_RISE_MS = 1200;
const CLIMB_FALL_MS = 720;
const CLIMB_STEP_PX = 170;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** 本包自己的四个动作(写进 opts.words,body.do() 才认识;manifest vocab 里也有) */
const STAGE_WORDS = {
  climbup: { motion: { seconds: 1.6 } },
  watchsit: { motion: { seconds: 1.4 } },
  typepaw: { motion: { seconds: 1.4 } },
  gettup: { motion: { seconds: 1.2 } },
  bye: { motion: { seconds: 1.7 } }, // 教学示例:见 docs/自己拼动作_实操.md
};

const BUSY_MODES = ['drag', 'air', 'crouch'];

/** move.params 既可能是 {x,y},也可能是按声明顺序的数组;返回数字或 null */
function paramNum(p, id) {
  if (p == null) return null;
  let v;
  if (Array.isArray(p)) v = p[id === 'x' ? 0 : 1];
  else v = p[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function boot(base, opts) {
  const host = opts.host;
  const kit = opts.kit;
  const figureBase = await createWhaleFigure(base, opts);

  /** 本地舞台状态:地板高度、姿势、正在执行的 move、漫游压制 */
  const stage = {
    clock: 0,
    yRatio: null,     // 当前地板高度比例(0=屏幕顶 1=屏幕底);null = 原生桌面地板
    lifting: false,   // 正在升/降(攀爬、落回)
    pose: null,       // null | 'watch' | 'type'
    poseAt: 0,
    poseX: null,      // 落座时人在屏幕上的横向比例(0=最左 1=最右):决定 face 朝向/视线
    poseY: null,      // 落座面高度比例(0=屏幕顶 1=屏幕底):决定视线抬多少
    gesture: null,    // 一次性手势(如 bye):{at, dur}
    devPose: null,    // 调参钩子:页面 set({devPose:{armN,armF,headTilt,pitch,swing,face,look}}) 直接覆盖姿态
    parked: false,    // 姿势/定点时禁止自由漫游
    pageRoam: 'free', // 页面最近一次要求的漫游方式
    move: null,       // 正在编排的 move
    muted: new Set(), // 已经被本层报告过的 walkId,再收到同 id 的 arrived/interrupted 就吞掉
    dragging: false,
    lastFloor: null,
    done: [],         // 待补发的 done 事件(本层接管的动作)
    devIdx: 0,
  };

  /** 包装 host.bounds:perch 就是换一个 floorY。kit 只在 resize 时读它,所以地板变了我们要自己 resize() */
  function boundsNow() {
    const b = host.bounds();
    if (stage.yRatio == null) return b;
    return { ...b, floorY: clamp(stage.yRatio * b.H, 12, b.floorY) };
  }

  const curX = () => kitBody.layout().x;
  const mode = () => kitBody.layout().mode;

  /**
   * 从坐姿站起来。注意:不要用 kitBody.walk(原地)去逼 startle——那会在她头顶冒"!"惊吓特效,
   * 下行攀爬时看着像受惊。这里用 kit 的常规 stand(wake 是慢苏醒,1.8s),鲸鱼的"站起来"
   * 由 stageFrame 里的 f.sit=0 立即接管(见 climbFrame / type 姿势),kit 的 sitK 随后自己衰减。
   */
  function standFast() {
    const L = kitBody.layout();
    if (L.mode !== 'sit' && L.mode !== 'sleep') return false;
    kitBody.do('stand');
    return true;
  }

  /* ---------------- 事件:把编排中的 walk 自己收掉,其余原样透给页面 ---------------- */

  function onKitEvent(kind, detail) {
    const id = detail?.walkId;
    if (id != null && stage.muted.has(id)) {
      if (kind === 'arrived' || kind === 'interrupted') { stage.muted.delete(id); return; }
    }
    const mv = stage.move;
    if (kind === 'arrived' && mv && id === mv.walkId) {
      mv.walkId = null;
      stage.muted.add(id);
      if (mv.phase === 'travel') { riseToTarget(mv); return; }
      if (mv.phase === 'post') {
        stage.move = null;
        mv.reported = true;
        host.emit('arrived', { walkId: mv.id, x: Math.round(curX()) });
        return;
      }
      return;
    }
    if (kind === 'interrupted' && mv && id === mv.walkId) {
      mv.walkId = null;
      if (detail.by === 'drag') {
        // 被拎起来:页面要收到这条 interrupted(by: 'drag'),world 会当成 grabbed
        mv.reported = true;
        stage.muted.add(id);
        stage.move = null;
        stage.lifting = false;
        host.emit(kind, detail);
      } else {
        // 我们自己换单导致的打断:move() 里已经报过了
        stage.muted.add(id);
        abortMove();
      }
      return;
    }
    if (kind === 'mode' && detail?.mode === 'drag') onGrabbed();
    host.emit(kind, detail);
  }

  /* ---------------- 姿势 ---------------- */

  function park() {
    if (stage.parked) return;
    stage.parked = true;
    kitBody.set({ roam: 'off' });
  }
  function unpark() {
    if (!stage.parked) return;
    stage.parked = false;
    kitBody.set({ roam: stage.pageRoam });
  }

  /** 进入看视频/打字姿势(就地) */
  function enterPose(kind) {
    stage.pose = kind;
    stage.poseAt = stage.clock;
    const b = host.bounds();
    const L = kitBody.layout();
    stage.poseX = clamp(L.x / b.W, 0, 1);   // 落座位置(比例):决定脸的朝向
    stage.poseY = stage.yRatio;             // 落座面高度比例:决定视线抬多少
    park();
    const m = mode();
    if (kind === 'watch') {
      if (m !== 'sit' && m !== 'sleep') kitBody.do('sit');
      // 坐定后朝向要重新设:以屏幕中线为准,坐在左半边朝右看、右半边朝左看(朝向视频中心)
      kitBody.place(L.x, stage.poseX < .5 ? 1 : -1);
    } else if (kind === 'type') {
      standFast();
    }
  }
  function exitPose() {
    if (!stage.pose) return;
    stage.pose = null;
    unpark();
    standFast();
  }

  /* ---------------- move 编排 ---------------- */

  function startMove(moveReq, id) {
    const to = moveReq?.to ?? 'walk';
    const b = host.bounds();
    const L = kitBody.layout();
    const run = moveReq?.run === true;
    const px = paramNum(moveReq?.params, 'x');
    const py = paramNum(moveReq?.params, 'y');

    // 1) 先把旧单结束掉(局面:world 换目标了)
    const old = stage.move;
    if (old) {
      stage.move = null;
      stage.lifting = false;
      if (old.walkId) stage.muted.add(old.walkId);
      if (!old.reported && old.id != null) {
        old.reported = true;
        stage.muted.add(old.id);
        host.emit('interrupted', { walkId: old.id, x: Math.round(L.x), by: 'busy' });
      }
    }

    // 2) 目标
    let targetRatio;                       // 目标地板比例;null = 桌面地板
    if (to === 'floor') targetRatio = null;
    else if (py != null) targetRatio = clamp(py, 0, 1);
    else targetRatio = stage.yRatio ?? clamp(b.floorY / b.H, 0, 1);

    const xr = px != null ? clamp(px, 0, 1) : to === 'floor' ? null : clamp(L.x / b.W, 0, 1);
    const targetX = xr == null ? null : clamp(xr * b.W, 104 * b.S + 8, b.W - 104 * b.S - 8);
    const topLimit = 12;
    const targetFloor = targetRatio == null ? b.floorY : clamp(targetRatio * b.H, topLimit, b.floorY);
    const targetPose = to === 'watch' ? 'watch' : to === 'type' ? 'type' : null;

    // 3) 已经在桌面上、又是纯水平/纯下来:可以直接交给 kit 走(它自己会 emit arrived)
    const alreadyFloor = stage.yRatio == null && Math.abs(b.floorY - targetFloor) < 2;
    const oldPose = stage.pose;
    if (oldPose) exitPose();

    if (alreadyFloor && to !== 'near' && targetX != null && Math.abs(L.x - targetX) > 1.5) {
      if (!BUSY_MODES.includes(L.mode) && kitBody.walk(targetX, run, id)) return true;
      // busy:排队,下一帧再试
      stage.move = { id, to, run, phase: 'wait', walkId: null, targetX, targetRatio, targetPose, reported: false };
      return true;
    }

    stage.move = {
      id, to, run, phase: 'travel', walkId: null,
      targetX, targetRatio, targetFloor, targetPose, reported: false,
      postX: null,
    };
    planMove(stage.move);
    return true;
  }

  function planMove(mv) {
    const L = kitBody.layout();
    if (BUSY_MODES.includes(L.mode)) { mv.phase = 'wait'; return; }
    if (mv.targetX != null && Math.abs(L.x - mv.targetX) > 1.5) {
      mv.walkId = mv.id;
      mv.phase = 'travel';
      if (!kitBody.walk(mv.targetX, mv.run, mv.id)) { mv.walkId = null; mv.phase = 'wait'; }
      return;
    }
    riseToTarget(mv);
  }

  /** 水平到了之后把地板抬/降到目标高度 */
  function riseToTarget(mv) {
    const b = host.bounds();
    const fromRatio = stage.yRatio;
    const fromFloor = fromRatio == null ? b.floorY : clamp(fromRatio * b.H, 12, b.floorY);
    const toFloor = mv.targetFloor;
    const dy = toFloor - fromFloor;
    if (Math.abs(dy) < 2) { stage.yRatio = mv.targetRatio; finishMove(mv); return; }

    standFast();
    mv.phase = 'lift';
    // 上升/下降都走"爬":手速由 CLIMB_STEP_PX 换算成"抓几把",和地板插值同步
    stage.lifting = true;
    kitBody.set({ hold: 4 });                          // 爬的时候别让自由漫游把她叫走
    if (dy < 0) kitBody.do('climbup'); // 向上爬时叠一层 kit 的动作脉冲(抬手节奏)
    const dist = Math.abs(dy);
    const durMs = (dy < 0 ? CLIMB_RISE_MS : CLIMB_FALL_MS) * clamp(dist / 700, .55, 1.7);
    mv.lift = {
      from: fromFloor, to: toFloor, fromRatio, toRatio: mv.targetRatio, t0: stage.clock,
      dir: dy < 0 ? -1 : 1,                              // -1 = 向上爬, +1 = 向下爬
      dist,
      baseX: curX(),                                     // 重心左右倒时以这个 x 为基准
      cycles: Math.max(2, Math.round(dist / CLIMB_STEP_PX)), // 手脚交替的"把数"
      dur: durMs / 1000,
    };
  }

  function finishMove(mv) {
    if (stage.move !== mv) return;
    stage.move = null;
    stage.lifting = false;
    mv.reported = true;
    if (mv.postX != null) {
      mv.phase = 'post';
      stage.move = mv;
      mv.walkId = mv.id;
      if (!kitBody.walk(mv.postX, mv.run, mv.id)) { mv.walkId = null; mv.phase = 'wait'; }
      return;
    }
    if (mv.targetPose) enterPose(mv.targetPose);
    else if (mv.to === 'near') park();
    host.emit('arrived', { walkId: mv.id, x: Math.round(curX()) });
  }

  function abortMove() {
    const mv = stage.move;
    if (!mv) return;
    stage.move = null;
    stage.lifting = false;
    if (mv.walkId) stage.muted.add(mv.walkId);
    if (!mv.reported && mv.id != null) {
      mv.reported = true;
      stage.muted.add(mv.id);
      host.emit('interrupted', { walkId: mv.id, x: Math.round(curX()), by: 'busy' });
    }
  }

  function onGrabbed() {
    if (stage.dragging) return;
    stage.dragging = true;
    // 被拎走:落座状态作废,松手后落回桌面
    stage.yRatio = null;
    stage.lifting = false;
    exitPose();
    unpark();
    const mv = stage.move;
    if (mv) {
      stage.move = null;
      if (mv.walkId) stage.muted.add(mv.walkId);
      if (!mv.reported && mv.id != null) {
        mv.reported = true;
        stage.muted.add(mv.id);
        host.emit('interrupted', { walkId: mv.id, x: Math.round(curX()), by: 'drag' });
      }
    }
  }

  /* ---------------- 本包新增的四个动作 ---------------- */

  function scheduleDone(word, seconds) {
    stage.done.push({ word, at: stage.clock + seconds });
  }

  function doWord(word) {
    if (word === 'climbup') {
      standFast();
      // 原地爬:不挪地板,手脚交替爬 1.6 秒(真的在 move 里时由 move 的 lift 自己画)
      if (!stage.move) stage.gesture = { at: stage.clock, dur: STAGE_WORDS.climbup.motion.seconds, kind: 'climbup' };
      kitBody.do('climbup');   // kit 的 pulse:顺带给点身体反应
      scheduleDone(word, STAGE_WORDS.climbup.motion.seconds);
      return true;
    }
    if (word === 'watchsit') {
      enterPose('watch');
      scheduleDone(word, STAGE_WORDS.watchsit.motion.seconds);
      return true;
    }
    if (word === 'typepaw') {
      enterPose('type');
      scheduleDone(word, STAGE_WORDS.typepaw.motion.seconds);
      return true;
    }
    if (word === 'gettup') {
      exitPose();
      standFast();
      scheduleDone(word, STAGE_WORDS.gettup.motion.seconds);
      return true;
    }
    if (word === 'bye') {
      // 一次性手势:不占姿势位,计时结束后自动回 idle
      standFast();
      stage.gesture = { at: stage.clock, dur: STAGE_WORDS.bye.motion.seconds };
      scheduleDone(word, STAGE_WORDS.bye.motion.seconds);
      return true;
    }
    return kitBody.do(word);
  }

  /* ---------------- 页面 api(api 2 契约) ---------------- */

  function walk(x, run, id) {
    const b = host.bounds();
    const tx = clamp(x, 104 * b.S + 8, b.W - 104 * b.S - 8);
    if (stage.yRatio == null) {
      // 桌面上:完全交给 kit,arrived/interrupted 由 kit 自己报
      const old = stage.move;
      if (old) abortMove();
      if (!stage.pose) unpark();
      return kitBody.walk(tx, run, id);
    }
    // 在窗沿/画面高度上:先落回桌面,再走到 tx
    exitPose();
    unpark();
    const mv = {
      id, to: 'floor', run, phase: 'lift', walkId: null,
      targetX: null, targetRatio: null, targetFloor: host.bounds().floorY, targetPose: null,
      reported: false, postX: tx,
    };
    const old = stage.move;
    if (old) {
      stage.move = null;
      if (old.walkId) stage.muted.add(old.walkId);
      if (!old.reported && old.id != null) {
        old.reported = true;
        stage.muted.add(old.id);
        host.emit('interrupted', { walkId: old.id, x: Math.round(curX()), by: 'busy' });
      }
    }
    stage.move = mv;
    riseToTarget(mv);
    return true;
  }

  function move(moveReq, id) {
    return startMove(moveReq, id);
  }

  function stopWalk(id) {
    const mv = stage.move;
    if (mv && mv.id === id) {
      // 页面自己要求停:报 interrupted,并停掉 kit 的行走
      stage.move = null;
      stage.lifting = false;
      if (mv.walkId) stage.muted.add(mv.walkId);
      if (!mv.reported) {
        mv.reported = true;
        stage.muted.add(mv.id);
        host.emit('interrupted', { walkId: mv.id, x: Math.round(curX()), by: 'user' });
      }
      kitBody.stopWalk(id);
      return;
    }
    kitBody.stopWalk(id);
  }

  function set(s) {
    if (!s || typeof s !== 'object') { kitBody.set(s); return; }
    if ('devPose' in s) {
      // 调参钩子:只影响本层绘制,不落进 kit 的状态
      stage.devPose = s.devPose && typeof s.devPose === 'object' ? s.devPose : null;
      const { devPose, ...rest } = s;
      s = rest;
    }
    if (typeof s.roam === 'string') stage.pageRoam = s.roam;
    let ss = s;
    if (s.roam && s.roam !== 'off' && (stage.parked || stage.move)) ss = { ...s, roam: 'off' };
    kitBody.set(ss);
  }

  /* ---------------- 每帧 ---------------- */

  function stepInner(dt) {
    stage.clock += dt;
    const b = host.bounds();

    // 1) 升降动画:插值地板比例,kit 的 resize 会把 pet.fy 贴到新地板上
    const mv = stage.move;
    if (mv && mv.phase === 'lift' && mv.lift) {
      const l = mv.lift;
      const k = clamp((stage.clock - l.t0) / l.dur, 0, 1);
      // 阶梯式爬:每"抓一把"= 一阶。每阶前 46% 猛地上一小段(冲刺),后 54% 停顿稳住,
      // 所以竖直轨迹是台阶,不是斜线电梯。相位同时驱动 climbs 的左右倒重心。
      const n = Math.max(2, l.cycles | 0);
      const pos = k * n;
      const i = Math.min(n - 1, Math.floor(pos));
      const dash = 1 - Math.pow(1 - clamp((pos - i) / .34, 0, 1), 3);
      const e = k >= 1 ? 1 : (i + dash) / n;
      const fromR = l.fromRatio == null ? l.from / b.H : l.fromRatio;
      const toR = l.toRatio == null ? l.to / b.H : l.toRatio;
      stage.yRatio = lerp(fromR, toR, e);
      // 重心左右倒 + 横向微晃:手抓哪边,身体就往另一边压,别走成笔直竖线
      if (l.baseX != null) {
        const ph = pos * Math.PI * 2;
        const amp = l.dir < 0 ? 4.4 : 3.2;
        kitBody.place(l.baseX + Math.sin(ph) * amp, 0);
        l.swayPh = ph;
      }
      if (k >= 1) {
        stage.yRatio = l.toRatio;
        if (l.baseX != null) kitBody.place(l.baseX, 0);
        stage.lifting = false;
        finishMove(mv);
      }
    } else if (mv && mv.phase === 'wait') {
      const L = kitBody.layout();
      if (!BUSY_MODES.includes(L.mode)) {
        if (mv.postX != null) { mv.phase = 'post'; mv.walkId = mv.id; if (!kitBody.walk(mv.postX, mv.run, mv.id)) { mv.walkId = null; mv.phase = 'wait'; } }
        else planMove(mv);
      }
    }

    // 2) 地板变了就 resize(kit 只在 resize 里缓存 floorY)
    const floor = stage.yRatio == null ? b.floorY : clamp(stage.yRatio * b.H, 12, b.floorY);
    if (stage.lastFloor == null || Math.abs(floor - stage.lastFloor) > .4) {
      stage.lastFloor = floor;
      kitBody.resize();
    }

    // 3) kit 自己走一步
    kitBody.step(dt);

    // 4) 补发 done
    while (stage.done.length && stage.clock >= stage.done[0].at) {
      const d = stage.done.shift();
      host.emit('done', { word: d.word });
    }

    // 4b) 一次性手势到期
    if (stage.gesture && stage.clock > stage.gesture.at + stage.gesture.dur) stage.gesture = null;

    // 5) 拖拽状态
    const m2 = mode();
    if (m2 === 'drag') onGrabbed();
    else if (stage.dragging) stage.dragging = false;

    // 6) 自测钩子(交付版 DEV_AUTOPOSE = null,这段不会触发)
    if (DEV_AUTOPOSE && stage.devIdx === 0 && stage.clock > 1.6) {
      stage.devIdx = 1;
      move({ to: DEV_AUTOPOSE.to, params: DEV_AUTOPOSE.params, run: false }, 990001);
    }
  }

  function step(dt) {
    stepInner(dt);
  }

  /* ---------------- 姿势 → 帧参数(交给 whale.js 的 o.pose 钩子) ---------------- */

  function glanceOf(ph) {
    const c = ph % 9;
    if (c > 6.2 && c < 7.2) return 1;
    if (c > 7.4 && c < 8.4) return -1;
    return 0;
  }

  /**
   * 攀爬帧:ph = 迈步相位(每 π 换一条腿/一只手),dir = -1 向上爬 / +1 向下爬。
   * 只用现有部件,靠三样东西读出"在爬":
   *   ① 迈步:一条腿抬膝(foot 抬高收向身体中线)、另一条腿蹬直,手脚同侧反相;
   *   ② 手交替往上一把:近侧手在"放下"和"抬到脸侧"之间,远侧手反相(不背到身后);
   *   ③ 躯干每迈一步向上提一下(low),配合脖子前倾贴墙(tilt)、抬头看上方/低头看脚下、甩头发裙摆(swing)。
   * 相位由 move 的 cycles(距离/CLIMB_STEP_PX)决定,所以爬得越远迈得越多步、手速和位移同步。
   */
  function climbFrame(f, o, ph, dir) {
    const up = dir < 0;
    const s = Math.sin(ph), c = Math.cos(ph);
    // 抓握相位:手臂比台阶(竖直冲刺)略提前,读成"先够到、再拉上来";
    // 近手/远手完全反相,恰好一手够高、一手在下面拉。
    const grabN = .5 + .5 * Math.sin(ph - .55);       // 近侧手:0=在胸下拉, 1=够到脸侧
    const grabF = .5 - .5 * Math.sin(ph - .55);       // 远侧手反相
    f.swing = 19 * c;                                 // 身体/头发/裙摆/鳍左右甩(重心在两手间倒)
    f.tilt = up ? 3.4 + 2.2 * s : 1.2;                // 脖子前倾,像贴着墙、用胸口蹭着往上
    // 爬的时候人必须是"站起来"的:kit 从坐姿转唤醒(sitK 以 6/s 衰减)要 ~0.4s,
    // 而升降只有 0.5~0.9s,不压住就会"盘腿滑下去"。直接给鲸鱼帧 sit=0 立刻改站立骨架,
    // low 也不再吃 kit 的 sitK 下沉量。
    f.sit = 0;
    f.low = -(up ? 4.2 : 2.6) * Math.abs(s);          // 每提一把整个身体往上蹿一下
    f.look = [o.look[0] * .15 + .55 * c, o.look[1] * .15 + (up ? -2.2 : 1.5)];
    f.face = up ? 'determined' : 'worried';
    f.pose = {
      // 手够到脸侧再往下拉(rig 的手臂短,armN≈96 是现有部件能到的最高;再大就会向两侧摊开)
      armN: up ? 62 + 34 * grabN : 54 + 20 * grabN,
      armF: up ? -20 - 30 * grabF : -16 - 16 * grabF,
      headTilt: (up ? -5.5 : 2) + 1.6 * s,
      pitch: (up ? -.34 : .28) + .05 * s,
      swing: 0,                                       // 不走 kit 的走路摆臂
    };
    // 迈步:这里自己造站立腿,不用 kit 给的 o.legs——从坐姿出发时 kit 的 sitK 还是 ~1,
    // 它给的脚坐标是"盘腿在身前"的,直接叠加抬脚会变成"托着腿在滑"。用 rig 的站立基准
    // (HIPS=[[104,212],[150,212]], FOOT_Y=241,logo 坐标)自造交替蹬墙的腿。
    const HIPS = [[104, 212], [150, 212]];
    const FOOT_Y = 241;
    const stride = up ? 10 : 8;
    const knee = up ? 22 : 16;
    f.legs = HIPS.map((h, i) => {
      const k = .5 + .5 * Math.sin(ph + (i ? Math.PI : 0));   // 0..1 = 这条腿抬起来
      const inward = (up ? 9 : 6) * k;
      return [h[0], h[1] + (up ? -1.6 : -1) * Math.abs(s), h[0] + (i ? -stride : stride) * Math.cos(ph + (i ? Math.PI : 0)) + (i ? -inward : inward), FOOT_Y - knee * k];
    });
  }

  function stageFrame(o) {
    const g = stage.gesture;
    if (!stage.pose && !stage.lifting && !g && !stage.devPose) return o;
    const t = stage.clock;
    const f = { ...o };
    if (stage.pose === 'watch') {
      const ph = t - stage.poseAt;
      const glance = glanceOf(ph);
      // 视线:朝"屏幕中心偏上"看(视频中心)。坐在左右下角时,必须斜着朝中心的右上/左上看,
      // 而不是直勾勾往前——这是"她在看视频"的关键。dx 朝中线,dy 往上方。
      const xr = stage.poseX == null ? .5 : stage.poseX;
      const yr = stage.poseY == null ? .6 : stage.poseY;
      const dx = clamp((.5 - xr) * 7, -3.6, 3.6);
      const dy = -clamp((yr - .46) * 5.5, -2.2, 2.4);
      f.look = [o.look[0] * .2 + dx + glance * 1.2, o.look[1] * .2 + dy + glance * .35];
      f.face = 'content';
      f.pose = {
        armN: -6 + 1.4 * Math.sin(t * .55),
        armF: -12 + 1.4 * Math.sin(t * .55 + 1.1),
        headTilt: 2.4 + .7 * Math.sin(t * .45) + glance * 1.1,
        pitch: .3 + .04 * Math.sin(t * .5),
        swing: 0,
      };
    } else if (stage.pose === 'type') {
      const ph = t - stage.poseAt;
      const typing = ph > .3;
      const lookUp = typing && (ph % 7.2) > 6.0;
      const tap = Math.sin(t * 11.5), tap2 = Math.sin(t * 11.5 + 2.1);
      f.look = [o.look[0] * .25 + (lookUp ? -1.6 : .35), o.look[1] * .25 + (lookUp ? -1.0 : 1.1)];
      f.face = lookUp ? 'thinking' : 'determined';
      f.sit = 0;   // 打字必须是站着的:kit 的坐姿衰减要 0.4s,直接压掉
      f.pose = {
        // 两只爪子一起抬到胸前交替敲(tap), 头跟着节奏点; 每 7 秒抬头看一眼光标
        armN: typing ? 42 + 12 * tap : 8,
        armF: typing ? -38 + 12 * tap2 : -4,
        headTilt: 2.5 + 2.4 * Math.sin(t * 6.4) - (lookUp ? 5 : 0),
        pitch: .45 + .06 * Math.sin(t * 5.8) - (lookUp ? .1 : 0),
        swing: 0,
      };
    } else if (stage.lifting) {
      // 攀爬:手/脚交替,相位与地板插值同步(爬多远抓几把)
      const l = stage.move?.lift;
      const k = l ? clamp((t - l.t0) / l.dur, 0, 1) : 0;
      const cycles = l ? l.cycles : 3;
      climbFrame(f, o, k * cycles * Math.PI * 2, l ? l.dir : -1);
    }
    // 一次性手势叠在姿势之上(bye:抬手来回挥;climbup:原地手脚并用往上爬)
    if (g) {
      const k = clamp((t - g.at) / g.dur, 0, 1);
      if (g.kind === 'climbup') {
        climbFrame(f, o, k * Math.PI * 2 * 3, -1);
        const settle = smooth(.78, 1, k);            // 最后收势:手放下来、视线回正
        if (settle > 0) {
          f.pose.armN = lerp(f.pose.armN, 6, settle);
          f.pose.armF = lerp(f.pose.armF, -6, settle);
          f.look = [f.look[0], lerp(f.look[1], 0, settle)];
          f.face = settle > .5 ? 'happy' : f.face;
        }
      } else {
        const env = Math.min(1, k / .15, (1 - k) / .18);
        const w = Math.sin((t - g.at) * 13);
        f.face = 'happy';
        f.look = [o.look[0] * .2, o.look[1] * .2 - 1.2];
        f.pose = {
          ...(f.pose || {}),
          armN: 10 + (76 + 14 * w) * env,   // 正角=往前抬:近侧爪子举到胸前/脸侧来回挥
          armF: -8 - 4 * env,
          headTilt: 1.6 + 1.6 * env + .8 * w * env,
          pitch: .18,
          swing: 0,
        };
      }
    }
    // 调参钩子最后覆盖(调试时用 set({devPose:{...}}))
    const d = stage.devPose;
    if (d) {
      f.pose = { ...(f.pose || {}), ...(d.armN != null ? { armN: d.armN } : {}), ...(d.armF != null ? { armF: d.armF } : {}),
        ...(d.headTilt != null ? { headTilt: d.headTilt } : {}), ...(d.pitch != null ? { pitch: d.pitch } : {}),
        ...(d.swing != null ? { swing: d.swing } : {}) };
      if (d.face) f.face = d.face;
      if (Array.isArray(d.look)) f.look = d.look;
      // frame 子对象:直接改 kit 帧字段(调爬行/晃动用):swing/tilt/low/legs
      const fr = d.frame;
      if (fr) {
        if (fr.swing != null) f.swing = fr.swing;
        if (fr.tilt != null) f.tilt = fr.tilt;
        if (fr.low != null) f.low = fr.low;
        if (Array.isArray(fr.legs)) f.legs = fr.legs;
      }
    }
    return f;
  }

  // 用原型链包装 figure:原生能力(表情/scheme/anchors...)全部继承,只加 draw 钩子
  const figure = Object.create(figureBase);
  figure.draw = (petG, fc, o) => figureBase.draw(petG, fc, stageFrame(o));

  const wrapHost = {
    root: host.root,
    start: host.start,
    bounds: boundsNow,
    emit: onKitEvent,
    sound: host.sound,
  };

  const kitBody = kit.createBody(wrapHost, { figure, words: STAGE_WORDS });

  return {
    step,
    layout: () => kitBody.layout(),
    resize: () => kitBody.resize(),
    do: doWord,
    get words() { return kitBody.words; },
    walk,
    move,
    stopWalk,
    pointer: (type, p) => kitBody.pointer(type, p),
    drop: p => kitBody.drop(p),
    shift: (dx, dy) => kitBody.shift(dx, dy),
    place: (x, facing) => {
      stage.pose = null;
      unpark();
      kitBody.place(x, facing);
    },
    set,
    cue: kind => kitBody.cue(kind),
    talk: () => kitBody.talk(),
    setScheme: (id, o) => kitBody.setScheme(id, o),
    get z() { return kitBody.z; },
    dispose() { kitBody.dispose(); },
  };
}

/** 形象包入口:页面用 manifest 的 export 名调用 `await make(base, opts)` */
export async function createStageWhaleBody(base, opts) {
  return boot(base, opts);
}
