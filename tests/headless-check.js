/*
 * NOVA Blocks · 星核方块 v3 — 无头自动化检查
 *
 * 用法：  node tests/headless-check.js
 *
 * 为什么这么写：游戏是「单个 HTML 文件 + 内联 <script>」，没有任何构建产物，
 * 直接用 Node 的 vm 把这段脚本连同 DOM 桩一起跑起来，就能在没有浏览器的情况下
 * 验证真实代码。三个关键技巧：
 *   1. 定时器换成虚拟时钟（setTimeout 入队的回调由 flush() 手动推进），
 *      否则动画时序无法在无头环境里确定性地推进；
 *   2. Canvas 上下文换成 Proxy 桩，需要"看得见"时用 record 模式录下绘制坐标，
 *      这样"有没有画到棋盘外"这类问题可以被量出来，而不是靠肉眼；
 *   3. 对 layout 的验收直接用真实的 L.H 与可用高度比较，
 *      不重新推导公式——推导公式会让测试与实现一起错。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'index.html');
const SRC = fs.readFileSync(FILE, 'utf8');

let fails = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + msg + (extra ? '  -> ' + extra : ''));
  if (!cond) fails++;
};

function loadGame(record) {
  const src = srcOfTemplate(SRC);
  let timers = [], tid = 1, vnow = 0;
  const st = (fn, ms) => { timers.push({ id: tid, fn, due: vnow + (ms || 0) }); return tid++; };
  const ct = id => { timers = timers.filter(t => t.id !== id); };
  const flush = (limit = 500) => {
    let n = 0;
    while (timers.length && n < limit) {
      timers.sort((a, b) => a.due - b.due);
      const t = timers.shift(); vnow = Math.max(vnow, t.due); t.fn(); n++;
    }
    return n;
  };

  const drawn = [];
  const grad = { addColorStop() {} };
  const ctx2d = new Proxy({}, {
    get(t, k) {
      if (typeof k === 'string' && k.startsWith('create')) return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      return (...a) => {
        if (record && ['moveTo', 'lineTo', 'arcTo', 'rect', 'fillRect', 'roundRect'].includes(k))
          drawn.push([a[0], a[1]]);
      };
    },
    set() { return true; }
  });

  const win = { innerHeight: 900, innerWidth: 1400, devicePixelRatio: 2, addEventListener() {}, removeEventListener() {}, __cellDraws: [] };
  function mkEl(id) {
    const cls = new Set();
    return {
      id, style: {}, dataset: {}, value: '', checked: false, textContent: '', innerHTML: '',
      scrollTop: 0, scrollHeight: 0, classList: {
        add: (...c) => c.forEach(x => cls.add(x)),
        remove: (...c) => c.forEach(x => cls.delete(x)),
        toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : f; on ? cls.add(c) : cls.delete(c); return on; },
        contains: c => cls.has(c)
      },
      addEventListener() {}, removeEventListener() {},
      querySelector: () => mkEl('q'), querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: win.innerWidth, height: win.innerHeight }),
      setPointerCapture() {}, releasePointerCapture() {},
      getContext: () => ctx2d,
      // stage 的宽度：跟随视口，便于真实地验收不同屏幕尺寸下的布局
      get parentElement() { return { clientWidth: Math.min(win.innerWidth * 0.94, 520) }; },
      appendChild() {}, remove() {}
    };
  }
  const cache = new Map();
  const getEl = id => (cache.has(id) ? cache.get(id) : (cache.set(id, mkEl(id)), cache.get(id)));
  const store = new Map();

  const sandbox = {
    window: win,
    document: {
      getElementById: getEl, body: mkEl('body'), hidden: false,
      addEventListener() {}, removeEventListener() {},
      createElement: () => mkEl('n'), querySelector: () => mkEl('q')
    },
    setTimeout: st, clearTimeout: ct, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    performance: { now: () => vnow },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    navigator: { clipboard: { writeText() {} } },
    getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
    console, Math, Date, JSON, parseInt, parseFloat, isNaN, Set, Map, Array, Object, String, Number, Infinity
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'nova-inline.js' });

  // 把 drawBlockCell 包一层，用于精确测量"托盘里每个格子画了多少像素"
  vm.runInContext(`
    const __origCell = drawBlockCell;
    drawBlockCell = function(x, y, s, hi, lo, a, g){
      window.__cellDraws.push({x, y, s});
      return __origCell(x, y, s, hi, lo, a, g);
    };
  `, sandbox);

  const api = vm.runInContext(`({
    State, CONFIG, L, resetRun, placePiece, anyMoveLeft, botBestMove, canPlace,
    dealTray, newPiece, drawDragPiece, drawDragGhost, drawTray, computeLayout,
    traySlotRect, trayPieceCell, mulberry32
  })`, sandbox);
  return { ...api, sandbox, win, flush, drawn, getEl };
}

function srcOfTemplate(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html 里找不到内联 <script>');
  return m[1];
}

console.log('NOVA Blocks v3 · 无头检查  (' + path.relative(process.cwd(), FILE) + ')\n');

/* ---------- 1. 落子动画坐标 ---------- */
console.log('[1] 落子动画落在正确的列');
{
  const g = loadGame();
  g.State.phase = 'PLAYING'; g.State.auto = false; g.resetRun(123);
  g.State.tray[0] = { id: 999, shape: [[1, 1, 1]], colorIdx: 2, w: 3, h: 1 };
  g.State.pops = [];
  g.placePiece(0, 0, 3);
  const cols = g.State.pops.map(p => p.col);
  ok(JSON.stringify(cols) === '[3,4,5]', '横条放入第 3/4/5 列 -> pops.col', JSON.stringify(cols));
  ok(g.State.pops.every(p => p.c === 3), '颜色值存在独立字段 c，未覆盖列号');
}

/* ---------- 2. 消除闪光坐标 ---------- */
console.log('\n[2] 整行消除的闪光落在正确的列');
{
  const g = loadGame();
  g.State.phase = 'PLAYING'; g.State.auto = false; g.resetRun(7);
  for (let c = 0; c < 7; c++) g.State.grid[0][c] = 1 + (c % 8);
  g.State.tray[0] = { id: 998, shape: [[1]], colorIdx: 5, w: 1, h: 1 };
  g.State.pops = [];
  g.placePiece(0, 0, 7);
  const flashDur = g.CONFIG.CLEAR_FLASH_MS / 1000;
  ok(g.State.pops.length === 1 && g.State.pops[0].col === 7, '补最后一格 -> 动画指向第 7 列');
  g.flush();
  const flash = g.State.pops.filter(p => Math.abs(p.dur - flashDur) < 1e-6);
  const cols = flash.map(p => p.col).sort((a, b) => a - b);
  ok(cols.length === 8 && new Set(cols).size === 8, '整行 8 格各有独立列号', JSON.stringify(cols));
  ok(g.State.grid[0].every(v => v === 0), '闪完之后整行被真正清掉');
}

/* ---------- 3. 拖拽不越界 ---------- */
console.log('\n[3] 拖拽预览被约束在棋盘内');
{
  const g = loadGame(true);
  g.State.phase = 'PLAYING'; g.State.auto = false; g.resetRun(5);
  g.computeLayout();
  const { L, CONFIG } = g;
  const size = L.cell * CONFIG.GRID;
  const probe = (cellR, cellC, label) => {
    g.drawn.length = 0;
    g.State.tray = [{ id: 1, shape: [[1, 1], [1, 1]], colorIdx: 0, w: 2, h: 2 }];
    g.State.drag = { idx: 0, x: 300, y: 600, grabRow: 0, grabCol: 0, lift: 0, cellR, cellC };
    g.drawDragPiece();
    const xs = g.drawn.map(d => d[0]).filter(v => typeof v === 'number');
    const ys = g.drawn.map(d => d[1]).filter(v => typeof v === 'number');
    const tol = 4;
    const inside = Math.min(...xs) >= L.boardX - tol && Math.max(...xs) <= L.boardX + size + tol &&
                   Math.min(...ys) >= L.boardY - tol && Math.max(...ys) <= L.boardY + size + tol;
    ok(inside, label, `x[${Math.min(...xs).toFixed(0)},${Math.max(...xs).toFixed(0)}] y[${Math.min(...ys).toFixed(0)},${Math.max(...ys).toFixed(0)}]`);
  };
  probe(9, 9, '从托盘起手拖到右下角外');
  probe(7, 7, '最后一行最后一列');
  probe(-2, -2, '左上角外');
  probe(0, 8, '横向越界一格');
}

/* ---------- 4. 触控抬升 ---------- */
console.log('\n[4] 触控抬升只对手指生效');
{
  const s = srcOfTemplate(SRC);
  ok(/pointerType === 'touch'/.test(s), '按 pointerType 区分触控与鼠标');
  ok(/targetY = y - \(d\.lift\|\|0\) - d\.grabRow\*L\.cell - L\.boardY/.test(s), '取格时减去了抬升量');
  ok(/\(d\.lift\|\|0\)/.test(s), '自由跟随分支同样减去抬升量');
}

/* ---------- 5. 布局不溢出（用真实 L.H 验收） ---------- */
console.log('\n[5] 各视口下画布不溢出可用高度');
{
  const g = loadGame();
  const cases = [
    ['桌面       1440x900', 1440, 900], ['iPhone SE   375x667', 375, 667],
    ['iPhone 14  390x844', 390, 844], ['安卓小屏    360x640', 360, 640],
    ['手机横屏    844x390', 844, 390], ['手机横屏    667x375', 667, 375],
    ['极矮窗口   1200x420', 1200, 420]
  ];
  for (const [name, w, h] of cases) {
    g.win.innerWidth = w; g.win.innerHeight = h;
    g.computeLayout();
    const availH = h - 150;                    // 与实现一致：HUD + 脚注 + 间距
    const slack = availH - g.L.H;
    ok(slack >= -0.5, `${name}  画布高 ${g.L.H.toFixed(0)}px / 可用 ${availH}px`,
       slack >= 0 ? `余 ${slack.toFixed(0)}px` : `溢出 ${(-slack).toFixed(0)}px（会被 overflow:hidden 裁掉）`);
  }
  g.win.innerWidth = 1440; g.win.innerHeight = 900;
}

/* ---------- 6. 提示不复活 ---------- */
console.log('\n[6] resize / 转屏后操作提示不再复活');
{
  const g = loadGame();
  const hint = g.getEl('hint');
  g.State.hintShown = false; g.win.innerHeight = 800; g.win.innerWidth = 500;
  g.computeLayout();
  ok(hint.style.display === '', '首局提示可见');
  g.State.hintShown = true;
  g.computeLayout();
  ok(hint.style.display === 'none', '已隐藏后 resize 仍保持隐藏');
}

/* ---------- 7. 托盘方块可见且与抓取口径一致 ---------- */
console.log('\n[7] 托盘方块清晰可见，且抓取映射使用同一口径');
{
  const g = loadGame();
  g.State.phase = 'PLAYING'; g.State.auto = false;
  const measure = (spec, vw, vh) => {
    g.win.innerWidth = vw; g.win.innerHeight = vh;
    g.resetRun(2026); g.computeLayout();
    const p = { shape: spec.m.map(r => r.slice()), colorIdx: 1, w: spec.m[0].length, h: spec.m.length };
    g.State.tray = [p, null, null];
    g.sandbox.window.__cellDraws.length = 0;
    g.drawTray(0);
    const cells = g.sandbox.window.__cellDraws.slice();
    const solid = spec.m.flat().filter(v => v).length;
    const slot = g.traySlotRect(0);
    const cs = g.trayPieceCell(p, slot);
    const inSlot = cells.every(c =>
      c.x >= slot.x - 2 && c.y >= slot.y - 2 &&
      c.x + c.s <= slot.x + slot.w + 2 && c.y + c.s <= slot.y + slot.h + 2);
    return { cells: cells.length, solid, cs, inSlot, w: p.w, h: p.h };
  };
  // 遍历「视口 × 形状」全组合：只测一个视口正是这轮曾经漏掉问题的原因。
  const VIEWPORTS = [
    ['桌面 1440x900', 1440, 900, 12], ['iPhone SE 375x667', 375, 667, 8],
    ['iPhone 14 390x844', 390, 844, 8], ['安卓小屏 360x640', 360, 640, 8],
    ['手机横屏 844x390', 844, 390, 7.5], ['手机横屏 667x375', 667, 375, 7.5],
    ['极矮窗口 1200x420', 1200, 420, 7.5]
  ];
  for (const [name, vw, vh, floor] of VIEWPORTS) {
    let worst = Infinity, worstShape = '', bad = 0;
    for (const spec of g.CONFIG.PIECES) {
      const r = measure(spec, vw, vh);
      if (r.cs < worst) { worst = r.cs; worstShape = `${r.w}x${r.h}`; }
      if (!(r.cells === r.solid && r.cs >= floor && r.inSlot)) bad++;
    }
    ok(bad === 0, `${name}  ${g.CONFIG.PIECES.length} 种形状全部可见且在槽位内`,
       `最小 ${worst.toFixed(1)}px/格（${worstShape}，阈值 ${floor}）`);
  }
}

/* ---------- 8. 发牌保底 ---------- */
console.log('\n[8] 发牌保底：任何盘面都不会出现"刚发完就无路可走"');
{
  const rnd = (() => { let a = 20260926; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  const g = loadGame();
  for (const ratio of [0.6, 0.7, 0.8, 0.9]) {
    let dead = 0; const trials = 300;
    for (let t = 0; t < trials; t++) {
      g.State.grid = Array.from({ length: 8 }, () => Array(8).fill(0));
      const target = Math.round(64 * ratio);
      let placed = 0, guard = 0;
      while (placed < target && guard++ < 5000) {
        const r = Math.floor(rnd() * 8), c = Math.floor(rnd() * 8);
        if (!g.State.grid[r][c]) { g.State.grid[r][c] = 1 + Math.floor(rnd() * 8); placed++; }
      }
      g.State.rng = g.mulberry32(t + 555);
      g.dealTray();
      if (!g.anyMoveLeft()) dead++;
    }
    ok(dead === 0, `棋盘占用 ${(ratio * 100).toFixed(0)}% 时发牌死局率`, `${(dead / trials * 100).toFixed(1)}% (${trials} 次)`);
  }
}

/* ---------- 9. 种子可复现 ---------- */
console.log('\n[9] 指定种子可完整复现同一局');
{
  const snap = () => {
    const g = loadGame();
    g.State.phase = 'PLAYING'; g.State.auto = false;
    g.resetRun(20260926);
    const seq = [];
    for (let i = 0; i < 3; i++)
      seq.push(g.State.tray.map(p => p.shape.map(r => r.join('')).join('/') + '#' + p.colorIdx).join('|'));
    return seq;
  };
  ok(JSON.stringify(snap()) === JSON.stringify(snap()), '同种子两次开局发出完全相同的三块');
}

/* ---------- 10. 整局回归 ---------- */
console.log('\n[10] 回归：20 局 AI 自动演示的不变量');
{
  const g = loadGame();
  const errs = [], scores = [], steps = [];
  for (let s = 0; s < 20; s++) {
    g.State.phase = 'PLAYING'; g.State.auto = false; g.resetRun(1000 + s * 37);
    let k = 0;
    while (g.State.phase === 'PLAYING' && k < 5000) {
      const mv = g.botBestMove();
      if (!mv) { errs.push(`局${s}：AI 找不到落点但 anyMoveLeft 为真`); break; }
      if (!g.canPlace(g.State.tray[mv.i], mv.r, mv.c)) { errs.push(`局${s}：非法落点`); break; }
      const before = g.State.score;
      g.placePiece(mv.i, mv.r, mv.c);
      g.flush();
      if (g.State.score < before) errs.push(`局${s}：分数倒退`);
      if (g.State.tray.length > 3) errs.push(`局${s}：托盘超限`);
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const v = g.State.grid[r][c];
        if (!(v >= 0 && v <= 8)) errs.push(`局${s}：非法格值`);
      }
      k++;
    }
    if (g.State.phase !== 'GAMEOVER') errs.push(`局${s}：未正常终局`);
    scores.push(g.State.score); steps.push(g.State.placements);
  }
  const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  ok(errs.length === 0, '20 局无异常', errs.slice(0, 3).join(' | '));
  console.log(`       平均分 ${avg(scores)} · 平均落子 ${avg(steps)} 步`);
}

console.log('\n==============================');
console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED');
process.exit(fails === 0 ? 0 : 1);
