/* ============================================================
   Irrigation designer — drawing, editing, rendering, BOM
   ============================================================ */
(function () {
  const SIM = window.IrrigationSim;
  const GRID = 0.1;                         // metres
  const PIPE_W = { 40: 6, 30: 4, 20: 2.5 }; // line weight by size
  // preset fills for areas (garden bed, soil/shed, concrete, water, other)
  const SHAPE_COLORS = ['#3fae5a', '#9c6b3f', '#7d8893', '#3f7dae', '#b04a8f'];

  const S = {
    yard: { w: 15, h: 20 },
    nodes: [],   // {id,x,y,type:'bore'|'sprinkler'|'junction', sub, rot, hp, depth}
    pipes: [],   // {id,a,b,size}
    shapes: [],  // {id,x,y,w,h,label,color} — garden beds / sheds / zones
    params: { eff: 0.5, ratedP: 200, hazenC: 150 },
    nextId: 1,
    view: { scale: 60, ox: 40, oy: 40 },
    tool: 'select',
    pipeSize: 30,
    selected: null,        // {kind:'node'|'pipe', id}
    pipeStart: null,       // world point while drawing
    mouse: null,           // world point
    sim: null,
    tab: 'inspector',
  };

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  let DPR = window.devicePixelRatio || 1;

  // ---------- coordinate helpers ----------
  const toScreen = (x, y) => ({ x: x * S.view.scale + S.view.ox, y: y * S.view.scale + S.view.oy });
  const toWorld = (sx, sy) => ({ x: (sx - S.view.ox) / S.view.scale, y: (sy - S.view.oy) / S.view.scale });
  const snap = v => Math.round(v / GRID) * GRID;
  const snapPt = p => ({ x: +snap(p.x).toFixed(2), y: +snap(p.y).toFixed(2) });
  const nid = () => 'n' + (S.nextId++);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function nodeById(id) { return S.nodes.find(n => n.id === id); }
  function degree(id) { return S.pipes.filter(p => p.a === id || p.b === id).length; }

  function fitView() {
    const rect = cv.getBoundingClientRect();
    const m = 0.6; // margin in metres
    const sx = rect.width / (S.yard.w + m * 2);
    const sy = rect.height / (S.yard.h + m * 2);
    S.view.scale = Math.max(8, Math.min(sx, sy));
    S.view.ox = (rect.width - S.yard.w * S.view.scale) / 2;
    S.view.oy = (rect.height - S.yard.h * S.view.scale) / 2;
  }

  // ---------- hit testing ----------
  function nodeAt(world, thresh) {
    let best = null, bd = thresh;
    for (const n of S.nodes) {
      const d = dist(n, world);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function pipeAt(world, thresh) {
    let best = null, bd = thresh;
    for (const p of S.pipes) {
      const a = nodeById(p.a), b = nodeById(p.b);
      if (!a || !b) continue;
      const d = distToSeg(world, a, b);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function shapeById(id) { return S.shapes.find(s => s.id === id); }
  function shapeAt(world) {
    // topmost area containing the point
    for (let i = S.shapes.length - 1; i >= 0; i--) {
      const s = S.shapes[i];
      if (world.x >= s.x && world.x <= s.x + s.w && world.y >= s.y && world.y <= s.y + s.h) return s;
    }
    return null;
  }
  function shapeCorners(s) {
    return {
      nw: toScreen(s.x, s.y),            ne: toScreen(s.x + s.w, s.y),
      sw: toScreen(s.x, s.y + s.h),      se: toScreen(s.x + s.w, s.y + s.h),
    };
  }
  function shapeHandleAt(s, sx, sy, r) {
    const c = shapeCorners(s);
    for (const k of ['nw', 'ne', 'sw', 'se']) {
      if (Math.hypot(sx - c[k].x, sy - c[k].y) < r) return k;
    }
    return null;
  }

  // ---------- mutations ----------
  // Project point p onto segment a-b; null if it lands in the endpoint zone.
  function projectOnSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return null;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    if (t <= 0.02 || t >= 0.98) return null;
    return { x: a.x + t * dx, y: a.y + t * dy };
  }
  // Replace pipe p with two pipes meeting at `node` (forms a T / cross).
  function splitPipeWithNode(p, node) {
    const a = p.a, b = p.b, size = p.size;
    S.pipes = S.pipes.filter(x => x.id !== p.id);
    if (a !== node.id) S.pipes.push({ id: nid(), a, b: node.id, size });
    if (b !== node.id) S.pipes.push({ id: nid(), a: node.id, b, size });
  }
  // Split every pipe whose interior passes through `node` (handles crossings).
  function splitPipesThrough(node, tol) {
    for (const p of S.pipes.slice()) {
      if (p.a === node.id || p.b === node.id) continue;
      const a = nodeById(p.a), b = nodeById(p.b);
      if (!a || !b) continue;
      const proj = projectOnSeg(node, a, b);
      if (proj && dist(node, proj) < tol) splitPipeWithNode(p, node);
    }
  }

  function getOrCreateNode(world) {
    // 1) reuse an existing node nearby
    const existing = nodeAt(world, GRID * 0.7);
    if (existing) return existing;
    // 2) landed on an existing pipe's interior -> junction there, split the pipe
    let best = null, bestD = GRID * 0.9, bestPt = null;
    for (const p of S.pipes) {
      const a = nodeById(p.a), b = nodeById(p.b);
      if (!a || !b) continue;
      const proj = projectOnSeg(world, a, b);
      if (!proj) continue;
      const d = dist(world, proj);
      if (d < bestD) { bestD = d; best = p; bestPt = proj; }
    }
    if (best) {
      const node = { id: nid(), x: +bestPt.x.toFixed(3), y: +bestPt.y.toFixed(3), type: 'junction' };
      S.nodes.push(node);
      splitPipesThrough(node, GRID * 0.5);
      return node;
    }
    // 3) plain junction snapped to the grid
    const sp = snapPt(world);
    const n = { id: nid(), x: sp.x, y: sp.y, type: 'junction' };
    S.nodes.push(n);
    return n;
  }

  // Heal nodes that visually sit on a pipe but aren't wired into it
  // (older layouts, or near-misses where the grid point fell just off an
  // angled pipe). Snaps the node onto the pipe and splits the pipe.
  function repairConnections() {
    let changed = false;
    for (const n of S.nodes) {
      for (const p of S.pipes.slice()) {
        if (p.a === n.id || p.b === n.id) continue;
        const a = nodeById(p.a), b = nodeById(p.b);
        if (!a || !b) continue;
        const proj = projectOnSeg(n, a, b);
        if (proj && dist(n, proj) < GRID * 1.05) {
          n.x = +proj.x.toFixed(3); n.y = +proj.y.toFixed(3);
          splitPipeWithNode(p, n);
          changed = true;
        }
      }
    }
    if (changed) S.sim = null;
    return changed;
  }
  function addPipe(p1, p2) {
    const n1 = getOrCreateNode(p1);
    const n2 = getOrCreateNode(p2);
    if (n1.id === n2.id) return;
    const dup = S.pipes.find(p =>
      (p.a === n1.id && p.b === n2.id) || (p.a === n2.id && p.b === n1.id));
    if (dup) return;
    S.pipes.push({ id: nid(), a: n1.id, b: n2.id, size: S.pipeSize });
    S.sim = null;
  }
  function placeComponent(world, type, sub) {
    const n = getOrCreateNode(world); // reuses a node, or splits a pipe, or makes one
    if (type === 'bore') {
      const other = S.nodes.find(x => x.type === 'bore' && x.id !== n.id);
      if (other) other.type = 'junction';
    }
    n.type = type;
    if (type === 'sprinkler') { n.sub = sub; if (n.rot == null) n.rot = 0; }
    if (type === 'bore') { if (n.hp == null) n.hp = 2.5; if (n.depth == null) n.depth = 6; }
    S.selected = { kind: 'node', id: n.id };
    S.sim = null;
  }
  function deleteSelected() {
    if (!S.selected) return;
    if (S.selected.kind === 'node') {
      const id = S.selected.id;
      S.pipes = S.pipes.filter(p => p.a !== id && p.b !== id);
      S.nodes = S.nodes.filter(n => n.id !== id);
    } else if (S.selected.kind === 'pipe') {
      S.pipes = S.pipes.filter(p => p.id !== S.selected.id);
      cleanupOrphans();
    } else if (S.selected.kind === 'shape') {
      S.shapes = S.shapes.filter(s => s.id !== S.selected.id);
    }
    S.selected = null;
    S.sim = null;
  }
  function cleanupOrphans() {
    S.nodes = S.nodes.filter(n => n.type !== 'junction' || degree(n.id) > 0);
  }

  // ---------- fitting derivation (for inspector + BOM) ----------
  function pipeDirs(id) {
    const node = nodeById(id);
    return S.pipes.filter(p => p.a === id || p.b === id).map(p => {
      const other = nodeById(p.a === id ? p.b : p.a);
      return { ang: Math.atan2(other.y - node.y, other.x - node.x), size: p.size };
    });
  }
  function fittingFor(node) {
    if (node.type === 'bore') return { name: 'Bore / pump', sizes: pipeSizesAt(node.id) };
    if (node.type === 'sprinkler') return { name: 'Sprinkler riser', sizes: pipeSizesAt(node.id) };
    const dirs = pipeDirs(node.id);
    const deg = dirs.length;
    const sizes = pipeSizesAt(node.id);
    if (deg === 0) return { name: 'Unused point', sizes };
    if (deg === 1) return { name: 'End cap', sizes };
    if (deg === 2) {
      const diff = Math.abs(Math.abs(dirs[0].ang - dirs[1].ang) - Math.PI);
      const straight = diff < 0.25;
      const reducing = dirs[0].size !== dirs[1].size;
      if (straight) return { name: reducing ? 'Reducing coupling' : 'Coupling', sizes };
      return { name: 'Elbow', sizes };
    }
    if (deg === 3) return { name: 'Tee', sizes };
    if (deg === 4) return { name: 'Cross (4-way)', sizes };
    return { name: deg + '-way manifold', sizes };
  }
  function pipeSizesAt(id) {
    return S.pipes.filter(p => p.a === id || p.b === id).map(p => p.size).sort((a, b) => b - a);
  }

  // ---------- rendering ----------
  function resize() {
    const rect = cv.getBoundingClientRect();
    DPR = window.devicePixelRatio || 1;
    cv.width = rect.width * DPR;
    cv.height = rect.height * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw();
  }

  function draw() {
    const rect = cv.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    drawGrid(rect);

    // areas (garden beds / sheds) sit behind pipes & heads
    for (const s of S.shapes) drawShape(s);

    // throw arcs only while in simulate mode
    if (S.sim) for (const n of S.nodes) if (n.type === 'sprinkler') drawThrow(n);

    // pipes
    for (const p of S.pipes) drawPipe(p);

    // rubber-band while drawing
    if (S.tool === 'pipe' && S.pipeStart && S.mouse) {
      const a = toScreen(S.pipeStart.x, S.pipeStart.y);
      const b = toScreen(snap(S.mouse.x), snap(S.mouse.y));
      ctx.strokeStyle = '#4dabf7'; ctx.lineWidth = PIPE_W[S.pipeSize];
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // nodes
    for (const n of S.nodes) drawNode(n);

    // selected area outline + resize handles (on top of everything)
    if (S.selected && S.selected.kind === 'shape') {
      const s = shapeById(S.selected.id);
      if (s) drawShapeSelection(s);
    }
    // rubber-band rectangle while drawing a new area
    if (S.tool === 'rect' && rectDraft) drawRectDraft();

    // snap cursor
    if (S.mouse && S.tool !== 'select' && S.tool !== 'pan') {
      const s = toScreen(snap(S.mouse.x), snap(S.mouse.y));
      ctx.strokeStyle = '#4dabf7'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawShape(s) {
    const o = toScreen(s.x, s.y);
    const w = s.w * S.view.scale, h = s.h * S.view.scale;
    ctx.save();
    ctx.fillStyle = s.color || SHAPE_COLORS[0];
    ctx.globalAlpha = 0.30;
    ctx.fillRect(o.x, o.y, w, h);
    ctx.restore();
    ctx.strokeStyle = s.color || SHAPE_COLORS[0];
    ctx.lineWidth = 1.5;
    ctx.strokeRect(o.x, o.y, w, h);
    if (s.label) {
      ctx.fillStyle = '#e9ecef'; ctx.font = '11px system-ui';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(s.label, o.x + w / 2, o.y + h / 2);
      ctx.textAlign = 'left';
    }
  }
  function drawShapeSelection(s) {
    const o = toScreen(s.x, s.y);
    const w = s.w * S.view.scale, h = s.h * S.view.scale;
    ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.strokeRect(o.x, o.y, w, h);
    ctx.setLineDash([]);
    const c = shapeCorners(s);
    ctx.fillStyle = '#ffd43b';
    for (const k of ['nw', 'ne', 'sw', 'se']) ctx.fillRect(c[k].x - 4, c[k].y - 4, 8, 8);
  }
  function drawRectDraft() {
    const x = Math.min(rectDraft.x0, rectDraft.x1), y = Math.min(rectDraft.y0, rectDraft.y1);
    const w = Math.abs(rectDraft.x1 - rectDraft.x0), h = Math.abs(rectDraft.y1 - rectDraft.y0);
    const o = toScreen(x, y);
    ctx.fillStyle = 'rgba(77,171,247,0.15)';
    ctx.fillRect(o.x, o.y, w * S.view.scale, h * S.view.scale);
    ctx.strokeStyle = '#4dabf7'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
    ctx.strokeRect(o.x, o.y, w * S.view.scale, h * S.view.scale);
    ctx.setLineDash([]);
  }

  function drawGrid(rect) {
    const sc = S.view.scale;
    // yard fill
    const o = toScreen(0, 0);
    const e = toScreen(S.yard.w, S.yard.h);
    ctx.fillStyle = '#0e1822';
    ctx.fillRect(o.x, o.y, e.x - o.x, e.y - o.y);

    // minor grid (skip when too dense)
    if (GRID * sc >= 6) {
      ctx.strokeStyle = '#152230'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= S.yard.w + 1e-6; x += GRID) {
        const p = toScreen(x, 0), q = toScreen(x, S.yard.h);
        ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      }
      for (let y = 0; y <= S.yard.h + 1e-6; y += GRID) {
        const p = toScreen(0, y), q = toScreen(S.yard.w, y);
        ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    // major grid (1 m)
    ctx.strokeStyle = '#26384a'; ctx.lineWidth = 1;
    ctx.fillStyle = '#5a6b7c'; ctx.font = '10px system-ui'; ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let x = 0; x <= S.yard.w + 1e-6; x += 1) {
      const p = toScreen(x, 0), q = toScreen(x, S.yard.h);
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
    }
    for (let y = 0; y <= S.yard.h + 1e-6; y += 1) {
      const p = toScreen(0, y), q = toScreen(S.yard.w, y);
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    for (let x = 0; x <= S.yard.w + 1e-6; x += 1) {
      const p = toScreen(x, 0); ctx.fillText(x + 'm', p.x + 2, o.y + 2);
    }
    for (let y = 1; y <= S.yard.h + 1e-6; y += 1) {
      const p = toScreen(0, y); ctx.fillText(y + 'm', o.x + 2, p.y + 2);
    }
    // border
    ctx.strokeStyle = '#3b5168'; ctx.lineWidth = 1.5;
    ctx.strokeRect(o.x, o.y, e.x - o.x, e.y - o.y);
  }

  // Effective throw (m): rated radius scaled by the flow ratio, since
  // throw distance ~ sqrt(pressure) and flow ratio = sqrt(P/P_rated).
  // Capped at 1.0 — the head's rated 3.6 m is its physical maximum reach.
  function effectiveThrow(n) {
    const spec = SIM.SPRINKLER[n.sub] || SIM.SPRINKLER['360'];
    const sd = S.sim && S.sim.sprinklers[n.id];
    const factor = sd ? Math.min(1, Math.max(0, sd.ratio)) : 1;
    return spec.radius * factor;
  }
  function drawThrow(n) {
    const spec = SIM.SPRINKLER[n.sub] || SIM.SPRINKLER['360'];
    const c = toScreen(n.x, n.y);
    const r = effectiveThrow(n) * S.view.scale;
    if (r < 1) return;
    const rot = (n.rot || 0) * Math.PI / 180;
    const half = (spec.arc * Math.PI / 180) / 2;
    const sd = S.sim && S.sim.sprinklers[n.id];
    const palette = {
      ok:  ['rgba(77,171,247,0.13)', 'rgba(77,171,247,0.40)'],
      low: ['rgba(232,163,61,0.14)', 'rgba(232,163,61,0.45)'],
      bad: ['rgba(224,49,49,0.15)',  'rgba(224,49,49,0.50)'],
    };
    const [fill, stroke] = palette[sd ? sd.status : 'ok'] || palette.ok;
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1;
    ctx.beginPath();
    if (spec.arc >= 360) {
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    } else {
      ctx.moveTo(c.x, c.y);
      ctx.arc(c.x, c.y, r, rot - half, rot + half);
      ctx.closePath();
    }
    ctx.fill(); ctx.stroke();
  }

  function drawPipe(p) {
    const a = nodeById(p.a), b = nodeById(p.b);
    if (!a || !b) return;
    const sa = toScreen(a.x, a.y), sb = toScreen(b.x, b.y);
    const sel = S.selected && S.selected.kind === 'pipe' && S.selected.id === p.id;
    let color = '#7d909f';
    if (S.sim && S.sim.pipes[p.id]) {
      const v = S.sim.pipes[p.id].velocity;
      color = v > 2.5 ? '#ff8787' : v > 1.5 ? '#e8a33d' : '#4dabf7';
    }
    if (sel) color = '#ffd43b';
    ctx.strokeStyle = color;
    ctx.lineWidth = PIPE_W[p.size] || 3;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();

    // size + flow label at midpoint
    const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
    ctx.fillStyle = '#9fb1c1'; ctx.font = '9px system-ui';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    let lbl = p.size + 'mm';
    if (S.sim && S.sim.pipes[p.id]) lbl += '  ' + S.sim.pipes[p.id].flow.toFixed(1) + ' L/min';
    ctx.fillText(lbl, mx, my - 8);
    ctx.textAlign = 'left';
  }

  function drawNode(n) {
    const c = toScreen(n.x, n.y);
    const sel = S.selected && S.selected.kind === 'node' && S.selected.id === n.id;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    if (n.type === 'bore') {
      ctx.fillStyle = '#1971c2';
      ctx.beginPath(); ctx.rect(c.x - 9, c.y - 9, 18, 18); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.fillText('B', c.x, c.y + 0.5);
    } else if (n.type === 'sprinkler') {
      const r = S.sim && S.sim.sprinklers[n.id]
        ? ({ ok: '#2f9e44', low: '#e8a33d', bad: '#e03131' }[S.sim.sprinklers[n.id].status])
        : '#2f9e44';
      ctx.fillStyle = r;
      ctx.beginPath(); ctx.arc(c.x, c.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b1118'; ctx.font = 'bold 8px system-ui';
      ctx.fillText(n.sub === '360' ? '360' : n.sub, c.x, c.y + 0.5);
      if (S.sim && S.sim.sprinklers[n.id]) {
        ctx.fillStyle = '#cdd9e3'; ctx.font = '9px system-ui';
        ctx.fillText(S.sim.sprinklers[n.id].flow.toFixed(1) + ' L/min', c.x, c.y + 16);
      }
    } else {
      const deg = degree(n.id);
      ctx.fillStyle = '#90a2b4';
      ctx.beginPath(); ctx.arc(c.x, c.y, deg >= 3 ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
    }
    if (sel) {
      ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.x, c.y, 12, 0, Math.PI * 2); ctx.stroke();
      // draggable aim handle for directional heads
      if (n.type === 'sprinkler' && n.sub !== '360') {
        const hp = aimHandlePos(n);
        ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(hp.x, hp.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd43b';
        ctx.beginPath(); ctx.arc(hp.x, hp.y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b1118'; ctx.font = 'bold 10px system-ui';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.fillText('↻', hp.x, hp.y + 0.5);
      }
    }
    ctx.textAlign = 'left';
  }

  // ---------- interaction ----------
  let dragging = null;       // dragging a node
  let panning = null;        // pan start
  let rotating = null;       // dragging a sprinkler aim handle
  let rectDraft = null;      // {x0,y0,x1,y1} while dragging out a new area
  let shapeDrag = null;      // {id,gx,gy} moving an area
  let shapeResize = null;    // {id,fx,fy} resizing an area (fx,fy = fixed corner)

  // Screen position of the aim handle at the edge of a sprinkler's spray.
  function aimHandlePos(n) {
    const spec = SIM.SPRINKLER[n.sub] || SIM.SPRINKLER['360'];
    const c = toScreen(n.x, n.y);
    const r = Math.max(28, spec.radius * S.view.scale);
    const a = (n.rot || 0) * Math.PI / 180;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  }
  function updateRotUI(deg) {
    const inp = document.querySelector('#panelBody [data-act="rot"]');
    if (inp) { inp.value = deg; const lbl = inp.previousElementSibling; if (lbl) lbl.textContent = 'Facing (°): ' + deg; }
  }

  cv.addEventListener('mousedown', ev => {
    const rect = cv.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const world = toWorld(sx, sy);
    const hitThresh = Math.max(GRID * 0.7, 10 / S.view.scale);

    // right-click cancels an in-progress pipe (same as Esc)
    if (ev.button === 2 && S.tool === 'pipe' && S.pipeStart) {
      S.pipeStart = null; draw();
      ev.preventDefault();
      return;
    }

    if (ev.button === 1 || ev.button === 2 || S.tool === 'pan' || ev.shiftKey) {
      panning = { sx, sy, ox: S.view.ox, oy: S.view.oy };
      ev.preventDefault();
      return;
    }

    if (S.tool === 'select') {
      // aim handle of the selected sprinkler takes priority over node drag
      if (S.selected && S.selected.kind === 'node') {
        const sn = nodeById(S.selected.id);
        if (sn && sn.type === 'sprinkler' && sn.sub !== '360') {
          const hp = aimHandlePos(sn);
          if (Math.hypot(sx - hp.x, sy - hp.y) < 12) { rotating = { id: sn.id }; return; }
        }
      }
      // resize handle of the selected area
      if (S.selected && S.selected.kind === 'shape') {
        const ss = shapeById(S.selected.id);
        const k = ss && shapeHandleAt(ss, sx, sy, 9);
        if (k) {
          shapeResize = {
            id: ss.id,
            fx: k.includes('w') ? ss.x + ss.w : ss.x,
            fy: k.includes('n') ? ss.y + ss.h : ss.y,
          };
          return;
        }
      }
      const n = nodeAt(world, hitThresh);
      if (n) {
        S.selected = { kind: 'node', id: n.id };
        dragging = { id: n.id };
        renderSide(); draw();
        return;
      }
      const p = pipeAt(world, hitThresh);
      if (p) { S.selected = { kind: 'pipe', id: p.id }; renderSide(); draw(); return; }
      // areas are large, so test them after nodes & pipes
      const sh = shapeAt(world);
      if (sh) {
        S.selected = { kind: 'shape', id: sh.id };
        shapeDrag = { id: sh.id, gx: world.x - sh.x, gy: world.y - sh.y };
        renderSide(); draw();
        return;
      }
      S.selected = null;
      renderSide(); draw();
      return;
    }

    if (S.tool === 'pipe') {
      const snapped = snapPt(world);
      if (!S.pipeStart) { S.pipeStart = snapped; }
      else { addPipe(S.pipeStart, snapped); S.pipeStart = snapped; renderSide(); }
      draw();
      return;
    }

    if (S.tool === 'rect') {
      const x = snap(world.x), y = snap(world.y);
      rectDraft = { x0: x, y0: y, x1: x, y1: y };
      draw();
      return;
    }

    if (S.tool === 'bore') { placeComponent(world, 'bore'); }
    else if (S.tool.startsWith('spr')) { placeComponent(world, 'sprinkler', S.tool.slice(3)); }
    else if (S.tool === 'erase') { eraseAt(world, hitThresh); }
    renderSide(); draw();
  });

  function eraseAt(world, thresh) {
    const n = nodeAt(world, thresh);
    if (n) { S.selected = { kind: 'node', id: n.id }; deleteSelected(); return; }
    const p = pipeAt(world, thresh);
    if (p) { S.selected = { kind: 'pipe', id: p.id }; deleteSelected(); return; }
    const s = shapeAt(world);
    if (s) { S.selected = { kind: 'shape', id: s.id }; deleteSelected(); }
  }

  cv.addEventListener('mousemove', ev => {
    const rect = cv.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    S.mouse = toWorld(sx, sy);

    if (rectDraft) {
      rectDraft.x1 = snap(S.mouse.x); rectDraft.y1 = snap(S.mouse.y);
      draw(); updateCoords(); return;
    }
    if (shapeResize) {
      const s = shapeById(shapeResize.id);
      const nx = snap(S.mouse.x), ny = snap(S.mouse.y);
      s.x = Math.min(shapeResize.fx, nx); s.y = Math.min(shapeResize.fy, ny);
      s.w = Math.abs(nx - shapeResize.fx); s.h = Math.abs(ny - shapeResize.fy);
      draw(); updateCoords(); return;
    }
    if (shapeDrag) {
      const s = shapeById(shapeDrag.id);
      s.x = +snap(S.mouse.x - shapeDrag.gx).toFixed(2);
      s.y = +snap(S.mouse.y - shapeDrag.gy).toFixed(2);
      draw(); updateCoords(); return;
    }
    if (rotating) {
      const n = nodeById(rotating.id);
      const c = toScreen(n.x, n.y);
      let deg = Math.atan2(sy - c.y, sx - c.x) * 180 / Math.PI;
      deg = (Math.round(deg / 5) * 5 + 360) % 360;
      n.rot = deg; S.sim = null;
      updateRotUI(deg); draw(); return;
    }
    if (panning) {
      S.view.ox = panning.ox + (sx - panning.sx);
      S.view.oy = panning.oy + (sy - panning.sy);
      draw(); return;
    }
    if (dragging) {
      const n = nodeById(dragging.id);
      const sp = snapPt(S.mouse);
      n.x = sp.x; n.y = sp.y; S.sim = null;
      draw(); updateCoords(); return;
    }
    // cursor feedback: aim handle, area resize handles, area body
    if (S.tool === 'select') {
      let cursor = 'default';
      if (S.selected && S.selected.kind === 'node') {
        const sn = nodeById(S.selected.id);
        if (sn && sn.type === 'sprinkler' && sn.sub !== '360') {
          const hp = aimHandlePos(sn);
          if (Math.hypot(sx - hp.x, sy - hp.y) < 12) cursor = 'grab';
        }
      }
      if (cursor === 'default' && S.selected && S.selected.kind === 'shape') {
        const ss = shapeById(S.selected.id);
        const k = ss && shapeHandleAt(ss, sx, sy, 9);
        if (k) cursor = (k === 'nw' || k === 'se') ? 'nwse-resize' : 'nesw-resize';
      }
      if (cursor === 'default' && shapeAt(S.mouse)) cursor = 'move';
      cv.style.cursor = cursor;
    }
    updateCoords();
    if (S.tool === 'pipe' || S.tool !== 'select') draw();
  });

  window.addEventListener('mouseup', () => {
    if (rectDraft) {
      const x = Math.min(rectDraft.x0, rectDraft.x1), y = Math.min(rectDraft.y0, rectDraft.y1);
      const w = Math.abs(rectDraft.x1 - rectDraft.x0), h = Math.abs(rectDraft.y1 - rectDraft.y0);
      rectDraft = null;
      if (w >= 0.2 && h >= 0.2) {
        const s = { id: nid(), x: +x.toFixed(2), y: +y.toFixed(2), w: +w.toFixed(2), h: +h.toFixed(2), label: '', color: SHAPE_COLORS[0] };
        S.shapes.push(s);
        S.selected = { kind: 'shape', id: s.id };
      }
      renderSide(); draw(); save();
    }
    if (shapeResize) {
      const s = shapeById(shapeResize.id);
      if (s) {
        if (s.w < 0.2) s.w = 0.2;
        if (s.h < 0.2) s.h = 0.2;
        s.x = +s.x.toFixed(2); s.y = +s.y.toFixed(2); s.w = +s.w.toFixed(2); s.h = +s.h.toFixed(2);
      }
    }
    if (dragging || rotating || shapeDrag || shapeResize) { renderSide(); save(); }
    dragging = null; panning = null; rotating = null; shapeDrag = null; shapeResize = null;
  });
  cv.addEventListener('contextmenu', e => e.preventDefault());

  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const rect = cv.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const before = toWorld(sx, sy);
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    S.view.scale = Math.max(8, Math.min(400, S.view.scale * factor));
    // keep cursor anchored
    S.view.ox = sx - before.x * S.view.scale;
    S.view.oy = sy - before.y * S.view.scale;
    draw();
  }, { passive: false });

  window.addEventListener('keydown', ev => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { deleteSelected(); renderSide(); draw(); }
    if (ev.key === 'Escape') { S.pipeStart = null; rectDraft = null; draw(); }
  });

  function updateCoords() {
    const el = document.getElementById('coords');
    if (!S.mouse) { el.textContent = ''; return; }
    const p = snapPt(S.mouse);
    el.textContent = `x: ${p.x.toFixed(1)} m   y: ${p.y.toFixed(1)} m`;
  }

  // ---------- side panel ----------
  function setTab(t) { S.tab = t; renderSide(); }
  function renderSide() {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    const body = document.getElementById('panelBody');
    if (S.tab === 'inspector') body.innerHTML = renderInspector();
    else if (S.tab === 'results') body.innerHTML = renderResults();
    else if (S.tab === 'parts') body.innerHTML = renderBOM();
    else body.innerHTML = renderSettings();
    wireSide();
  }

  function renderInspector() {
    if (!S.selected) return '<p class="empty">Select an item to edit it, or pick a tool and click the yard to draw.</p>';
    if (S.selected.kind === 'pipe') {
      const p = S.pipes.find(x => x.id === S.selected.id);
      if (!p) return '<p class="empty">—</p>';
      const a = nodeById(p.a), b = nodeById(p.b);
      const len = dist(a, b);
      const sim = S.sim && S.sim.pipes[p.id];
      return `
        <h3>Pipe</h3>
        <div class="prop"><label>Diameter</label>
          <select data-act="pipeSize">
            ${[40, 30, 20].map(s => `<option value="${s}" ${s == p.size ? 'selected' : ''}>${s} mm</option>`).join('')}
          </select></div>
        <div class="kv"><span>Length</span><span>${len.toFixed(2)} m</span></div>
        ${sim ? `<div class="kv"><span>Flow</span><span>${sim.flow.toFixed(1)} L/min</span></div>
                 <div class="kv"><span>Velocity</span><span>${sim.velocity.toFixed(2)} m/s</span></div>` : ''}
        <button class="danger-btn" data-act="del">Delete pipe</button>`;
    }
    if (S.selected.kind === 'shape') {
      const s = shapeById(S.selected.id);
      if (!s) return '<p class="empty">—</p>';
      const swatches = SHAPE_COLORS.map(c =>
        `<button class="swatch${c === s.color ? ' on' : ''}" data-act="shapeColor" data-color="${c}" style="background:${c}" title="${c}"></button>`
      ).join('');
      return `
        <h3>Area / bed</h3>
        <div class="prop"><label>Label</label>
          <input type="text" value="${(s.label || '').replace(/"/g, '&quot;')}" data-act="shapeLabel" placeholder="e.g. Veggie bed, Shed"></div>
        <div class="prop"><label>Colour</label>
          <div class="swatches">${swatches}<input type="color" value="${s.color}" data-act="shapeColorPick" class="swatch-pick" title="Custom colour"></div></div>
        <div class="prop row2">
          <div><label>Width (m)</label><input type="number" min="0.1" step="0.1" value="${s.w}" data-act="shapeW"></div>
          <div><label>Height (m)</label><input type="number" min="0.1" step="0.1" value="${s.h}" data-act="shapeH"></div>
        </div>
        <div class="kv"><span>Position</span><span>${s.x.toFixed(1)}, ${s.y.toFixed(1)} m</span></div>
        <div class="kv"><span>Area</span><span>${(s.w * s.h).toFixed(1)} m²</span></div>
        <p class="empty" style="margin-top:8px">Drag the body to move, or the yellow corner handles to resize.</p>
        <button class="danger-btn" data-act="del">Delete area</button>`;
    }
    const n = nodeById(S.selected.id);
    if (!n) return '<p class="empty">—</p>';
    if (n.type === 'bore') {
      return `
        <h3>Bore / pump</h3>
        <div class="prop"><label>Power (HP)</label>
          <input type="number" step="0.25" min="0.25" value="${n.hp}" data-act="hp"></div>
        <div class="prop"><label>Depth underground (m)</label>
          <input type="number" step="1" min="1" value="${n.depth}" data-act="depth"></div>
        <div class="kv"><span>Position</span><span>${n.x.toFixed(1)}, ${n.y.toFixed(1)} m</span></div>
        <button class="danger-btn" data-act="del">Delete bore</button>`;
    }
    if (n.type === 'sprinkler') {
      const spec = SIM.SPRINKLER[n.sub];
      const sim = S.sim && S.sim.sprinklers[n.id];
      return `
        <h3>Sprinkler</h3>
        <div class="prop"><label>Type</label>
          <select data-act="sub">
            ${['360', '180', '90'].map(s => `<option value="${s}" ${s == n.sub ? 'selected' : ''}>${SIM.SPRINKLER[s].label}</option>`).join('')}
          </select></div>
        ${n.sub !== '360' ? `<div class="prop"><label>Facing (°): ${n.rot || 0}</label>
          <input type="range" min="0" max="355" step="5" value="${n.rot || 0}" data-act="rot">
          <p class="empty" style="margin:4px 0 0">Tip: drag the yellow ↻ handle on the head to aim the spray. 0°=east, 90°=south.</p></div>` : ''}
        <div class="kv"><span>Rated flow</span><span>${spec.flow} L/min</span></div>
        <div class="kv"><span>Throw radius</span><span>${spec.radius} m</span></div>
        ${sim ? `<div class="kv"><span>Simulated flow</span><span>${sim.flow.toFixed(1)} L/min ${badge(sim.status)}</span></div>
                 <div class="kv"><span>Pressure</span><span>${sim.pressure.toFixed(0)} kPa</span></div>
                 <div class="kv"><span>Effective throw</span><span>${effectiveThrow(n).toFixed(1)} m</span></div>` : ''}
        <button class="danger-btn" data-act="del">Delete sprinkler</button>`;
    }
    // junction
    const fit = fittingFor(n);
    return `
      <h3>Fitting (auto)</h3>
      <div class="kv"><span>Type</span><span>${fit.name}</span></div>
      <div class="kv"><span>Ports</span><span>${fit.sizes.length ? fit.sizes.map(s => s + 'mm').join(' / ') : '—'}</span></div>
      <p class="empty" style="margin-top:8px">Fitting type is derived from the pipes meeting here. Connect another pipe to change it, or use a sprinkler/bore tool to turn this into a head or source.</p>
      <button class="danger-btn" data-act="del">Delete junction</button>`;
  }

  function badge(st) {
    const m = { ok: ['ok', 'OK'], low: ['low', 'LOW'], bad: ['bad', 'STARVED'] };
    const [c, t] = m[st] || m.ok;
    return `<span class="badge ${c}">${t}</span>`;
  }

  function renderResults() {
    runSim();
    const r = S.sim;
    if (!r) return '<p class="empty">—</p>';
    let html = '';
    if (r.warnings.length) {
      const err = r.warnings.some(w => /not connected|No bore|under-supplied/.test(w));
      html += `<div class="warnbox ${err ? 'err' : ''}"><b>Notes</b><ul>${r.warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>`;
    }
    if (!r.ok) return html || '<p class="empty">Add a bore and sprinklers, then results appear here.</p>';
    html += `
      <div class="kv"><span>Total demand</span><span>${r.totalFlow.toFixed(1)} L/min</span></div>
      <div class="kv"><span>Manifold pressure</span><span>${r.manifoldPressure.toFixed(0)} kPa</span></div>
      <div class="kv"><span>Bore max flow*</span><span>${r.pumpMaxFlow.toFixed(0)} L/min</span></div>
      <h3>Per sprinkler</h3>`;
    const sprs = S.nodes.filter(n => n.type === 'sprinkler');
    sprs.forEach((s, i) => {
      const d = r.sprinklers[s.id];
      if (!d) return;
      html += `<div class="kv"><span>#${i + 1} ${s.sub}°</span><span>${d.flow.toFixed(1)} / ${d.rated} L/min ${badge(d.status)}</span></div>`;
    });
    html += `<p class="empty" style="margin-top:10px">*Theoretical max flow at zero surface pressure — real usable flow is lower.</p>`;
    return html;
  }

  function renderBOM() {
    const sprCount = { '360': 0, '180': 0, '90': 0 };
    S.nodes.filter(n => n.type === 'sprinkler').forEach(n => sprCount[n.sub]++);
    const pipeLen = { 40: 0, 30: 0, 20: 0 };
    S.pipes.forEach(p => { pipeLen[p.size] += dist(nodeById(p.a), nodeById(p.b)); });
    const fits = {};
    S.nodes.filter(n => n.type === 'junction').forEach(n => {
      const f = fittingFor(n);
      if (f.name === 'Unused point') return;
      const key = f.name + (f.sizes.length ? ' (' + f.sizes.map(s => s + 'mm').join('/') + ')' : '');
      fits[key] = (fits[key] || 0) + 1;
    });
    let rows = '';
    let any = false;
    Object.entries(sprCount).forEach(([k, v]) => { if (v) { any = true; rows += `<tr><td>${SIM.SPRINKLER[k].label}</td><td>${v}</td></tr>`; } });
    Object.entries(pipeLen).forEach(([k, v]) => { if (v > 0.001) { any = true; rows += `<tr><td>${k} mm pipe</td><td>${v.toFixed(2)} m</td></tr>`; } });
    Object.entries(fits).forEach(([k, v]) => { any = true; rows += `<tr><td>${k}</td><td>${v}</td></tr>`; });
    const bore = S.nodes.find(n => n.type === 'bore');
    if (bore) { any = true; rows += `<tr><td>Bore pump (${bore.hp} HP, ${bore.depth} m)</td><td>1</td></tr>`; }
    if (!any) return '<p class="empty">Draw your layout to generate a parts list.</p>';
    return `<h3>Parts list</h3><table class="bom">${rows}</table>`;
  }

  function renderSettings() {
    return `
      <h3>Simulation parameters</h3>
      <div class="prop"><label>Pump efficiency (0–1)</label>
        <input type="number" step="0.05" min="0.1" max="0.9" value="${S.params.eff}" data-act="eff"></div>
      <div class="prop"><label>Sprinkler rated pressure (kPa)</label>
        <input type="number" step="10" min="50" value="${S.params.ratedP}" data-act="ratedP"></div>
      <div class="prop"><label>Pipe roughness — Hazen-Williams C</label>
        <input type="number" step="5" min="80" max="160" value="${S.params.hazenC}" data-act="hazenC"></div>
      <h3>Yard</h3>
      <div class="prop row2">
        <div><label>Width (m)</label><input type="number" min="1" value="${S.yard.w}" data-act="yw"></div>
        <div><label>Height (m)</label><input type="number" min="1" value="${S.yard.h}" data-act="yh"></div>
      </div>
      <p class="empty">Grid is fixed at 0.1 m. Spray heads have a 3.6 m throw; flows are 9.4 / 5.6 / 3.0 L/min for 360 / 180 / 90°.</p>`;
  }

  function wireSide() {
    document.querySelectorAll('#panelBody [data-act]').forEach(el => {
      const act = el.dataset.act;
      const typed = ['range', 'number', 'text', 'color'].includes(el.type);
      const ev = (el.tagName === 'SELECT' || typed) ? 'input' : 'click';
      el.addEventListener(ev, () => {
        const n = S.selected ? nodeById(S.selected.id) : null;
        const p = S.selected && S.selected.kind === 'pipe' ? S.pipes.find(x => x.id === S.selected.id) : null;
        const s = S.selected && S.selected.kind === 'shape' ? shapeById(S.selected.id) : null;
        switch (act) {
          case 'del': deleteSelected(); break;
          case 'pipeSize': if (p) p.size = +el.value; S.sim = null; break;
          case 'hp': if (n) n.hp = +el.value; S.sim = null; break;
          case 'depth': if (n) n.depth = +el.value; S.sim = null; break;
          case 'sub': if (n) n.sub = el.value; S.sim = null; break;
          case 'rot': if (n) n.rot = +el.value; break;
          case 'eff': S.params.eff = +el.value; S.sim = null; break;
          case 'ratedP': S.params.ratedP = +el.value; S.sim = null; break;
          case 'hazenC': S.params.hazenC = +el.value; S.sim = null; break;
          case 'yw': S.yard.w = Math.max(1, +el.value); document.getElementById('yw').value = S.yard.w; fitView(); break;
          case 'yh': S.yard.h = Math.max(1, +el.value); document.getElementById('yh').value = S.yard.h; fitView(); break;
          case 'shapeLabel': if (s) s.label = el.value; break;
          case 'shapeColor': if (s) s.color = el.dataset.color; break;
          case 'shapeColorPick': if (s) s.color = el.value; break;
          case 'shapeW': if (s) s.w = Math.max(0.1, +el.value); break;
          case 'shapeH': if (s) s.h = Math.max(0.1, +el.value); break;
        }
        save();
        if (act === 'del' || act === 'sub' || act === 'shapeColor') renderSide();
        else if (act === 'rot') updateRotUI(n ? (n.rot || 0) : 0);
        else if (S.tab === 'results') renderSide();
        draw();
      });
    });
  }

  // ---------- simulation ----------
  function runSim() {
    if (S.sim) return;
    repairConnections(); // wire up any pipe-on-pipe touch points first
    S.sim = SIM.simulate({ nodes: S.nodes, pipes: S.pipes, params: S.params });
  }
  function simulateNow() {
    S.sim = null; runSim(); S.tab = 'results'; renderSide(); draw();
  }

  // ---------- persistence ----------
  const KEY = 'irrigationDesign_v1';
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        yard: S.yard, nodes: S.nodes, pipes: S.pipes, shapes: S.shapes, params: S.params, nextId: S.nextId,
      }));
    } catch (e) {}
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      Object.assign(S, { yard: d.yard, nodes: d.nodes, pipes: d.pipes, shapes: d.shapes || [], params: d.params, nextId: d.nextId || 1 });
      return true;
    } catch (e) { return false; }
  }
  function exportJSON() {
    const blob = new Blob([JSON.stringify({ yard: S.yard, nodes: S.nodes, pipes: S.pipes, shapes: S.shapes, params: S.params }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'irrigation-layout.json'; a.click();
  }
  function importJSON(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        S.yard = d.yard || S.yard; S.nodes = d.nodes || []; S.pipes = d.pipes || []; S.shapes = d.shapes || [];
        S.params = Object.assign(S.params, d.params || {});
        S.nextId = 1 + S.nodes.concat(S.pipes, S.shapes).reduce((m, x) => Math.max(m, +(String(x.id).replace('n', '')) || 0), 0);
        S.sim = null; S.selected = null; fitView(); renderSide(); draw(); save();
      } catch (e) { alert('Could not read that file.'); }
    };
    fr.readAsText(file);
  }

  // ---------- toolbar wiring ----------
  function setTool(t) {
    S.tool = t; S.pipeStart = null; rectDraft = null;
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    cv.style.cursor = t === 'select' ? 'default' : t === 'pan' ? 'grab' : 'crosshair';
    draw();
  }
  document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  document.getElementById('pipeSize').addEventListener('change', e => { S.pipeSize = +e.target.value; });
  document.getElementById('yw').addEventListener('input', e => { S.yard.w = Math.max(1, +e.target.value); fitView(); draw(); save(); });
  document.getElementById('yh').addEventListener('input', e => { S.yard.h = Math.max(1, +e.target.value); fitView(); draw(); save(); });
  document.getElementById('simBtn').addEventListener('click', simulateNow);
  document.getElementById('fitBtn').addEventListener('click', () => { fitView(); draw(); });
  document.getElementById('exportBtn').addEventListener('click', exportJSON);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); });
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Clear the whole layout?')) { S.nodes = []; S.pipes = []; S.shapes = []; S.sim = null; S.selected = null; renderSide(); draw(); save(); }
  });

  // ---------- init ----------
  function init() {
    if (!load()) {
      // starter: a bore in a corner
      S.nodes.push({ id: nid(), x: 1, y: 1, type: 'bore', hp: 2.5, depth: 6 });
    }
    repairConnections(); // heal touch points in any previously-saved layout
    document.getElementById('yw').value = S.yard.w;
    document.getElementById('yh').value = S.yard.h;
    document.getElementById('pipeSize').value = S.pipeSize;
    fitView();
    resize();
    setTool('select');
    renderSide();
  }
  window.addEventListener('resize', resize);
  // save periodically on changes
  setInterval(save, 1500);
  init();
})();
