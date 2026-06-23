/* ============================================================
   Irrigation hydraulic simulation
   ------------------------------------------------------------
   Model
   - Bore = constant-power pump. Hydraulic power P = eff * HP * 745.7 W
     must lift water from `depth` metres AND pressurise the surface
     network, so the head available at the manifold for a total flow Q is
         H_surf = P / (rho*g*Q) - depth          (clamped to [0, H0])
     This naturally falls as flow rises (a constant-power pump curve).
   - Pipes: Hazen-Williams friction (C ~= 150 for poly/PVC).
   - Sprinklers: pressure-driven emitters,  q = K * sqrt(head),
     with K fixed from the rated flow at the rated pressure.
   The network is treated as a tree rooted at the bore and solved by
   damped fixed-point iteration. Loops are detected and reported.
   ============================================================ */
(function () {
  const RHO = 1000;      // kg/m^3
  const G = 9.81;        // m/s^2
  const HP_W = 745.7;    // watts per horsepower

  // Sprinkler catalogue: rated flow (L/min) and throw radius (m).
  const SPRINKLER = {
    '360': { flow: 9.4, radius: 3.6, arc: 360, label: 'Spray head 360°' },
    '180': { flow: 5.6, radius: 3.6, arc: 180, label: 'Spray head 180°' },
    '90':  { flow: 3.0, radius: 3.6, arc: 90,  label: 'Spray head 90°'  },
  };

  // Pipe nominal diameters (m). Treated as internal bore for friction.
  const PIPE_DIAM = { 40: 0.040, 30: 0.030, 20: 0.020 };

  // Hazen-Williams head loss (m) for flow Q (m^3/s) over length L (m).
  function headLoss(Q, L, d, C) {
    if (Q <= 0 || L <= 0 || d <= 0) return 0;
    return 10.67 * L * Math.pow(Q, 1.852) / (Math.pow(C, 1.852) * Math.pow(d, 4.87));
  }

  function velocity(Q, d) {
    const a = Math.PI * d * d / 4;
    return a > 0 ? Q / a : 0;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* model = { nodes:[{id,x,y,type,sub,...}], pipes:[{id,a,b,size}],
              boreId, params:{eff,ratedP,hazenC} }
     Returns per-element results in L/min / kPa plus warnings.        */
  function simulate(model) {
    const { nodes, pipes, params } = model;
    const byId = {};
    nodes.forEach(n => (byId[n.id] = n));

    const warnings = [];
    const result = {
      ok: false, sprinklers: {}, pipes: {},
      totalFlow: 0, manifoldPressure: 0, pumpMaxFlow: 0,
      warnings,
    };

    const bore = nodes.find(n => n.type === 'bore');
    if (!bore) { warnings.push('No bore placed — add a bore to run the simulation.'); return result; }
    const sprinklers = nodes.filter(n => n.type === 'sprinkler');
    if (!sprinklers.length) { warnings.push('No sprinklers placed yet.'); return result; }

    // ---- adjacency ----
    const adj = {};
    nodes.forEach(n => (adj[n.id] = []));
    pipes.forEach(p => {
      if (!byId[p.a] || !byId[p.b]) return;
      const L = dist(byId[p.a], byId[p.b]);
      const d = PIPE_DIAM[p.size] || 0.03;
      adj[p.a].push({ to: p.b, pipe: p.id, L, d });
      adj[p.b].push({ to: p.a, pipe: p.id, L, d });
    });

    // ---- BFS spanning tree from bore ----
    const parent = {}, parentEdge = {}, order = [], visited = {};
    const children = {};
    nodes.forEach(n => (children[n.id] = []));
    const queue = [bore.id];
    visited[bore.id] = true;
    parent[bore.id] = null;
    const loopEdges = new Set();
    while (queue.length) {
      const u = queue.shift();
      order.push(u);
      for (const e of adj[u]) {
        if (!visited[e.to]) {
          visited[e.to] = true;
          parent[e.to] = u;
          parentEdge[e.to] = e;
          children[u].push({ child: e.to, edge: e });
          queue.push(e.to);
        } else if (parent[u] !== e.to) {
          loopEdges.add(e.pipe);
        }
      }
    }
    if (loopEdges.size) warnings.push(loopEdges.size + ' loop(s) detected — simulated as a tree (redundant pipe ignored for flow).');

    const disconnected = sprinklers.filter(s => !visited[s.id]);
    if (disconnected.length) warnings.push(disconnected.length + ' sprinkler(s) not connected to the bore — they receive no water.');

    // ---- emitter constants ----
    const ratedHead = params.ratedP * 1000 / (RHO * G); // m
    const K = {};
    sprinklers.forEach(s => {
      const spec = SPRINKLER[s.sub] || SPRINKLER['360'];
      const qRated = spec.flow / 60000; // L/min -> m^3/s
      K[s.id] = qRated / Math.sqrt(ratedHead);
    });

    // ---- pump curve ----
    const Pavail = params.eff * bore.hp * HP_W; // W
    const H0 = 120; // shutoff cap (m) to bound low-flow head
    result.pumpMaxFlow = (Pavail / (RHO * G * Math.max(bore.depth, 0.1))) * 60000; // L/min at zero surface head
    function pumpHead(Q) {
      if (Q < 1e-7) return H0;
      const h = Pavail / (RHO * G * Q) - bore.depth;
      return Math.max(0, Math.min(H0, h));
    }

    // ---- solve ----
    const head = {};
    const emit = {};
    const pipeFlow = {};     // by node id = flow in that node's parent edge
    sprinklers.forEach(s => (emit[s.id] = 0));

    // Inner solve: for a FIXED manifold head Hm, converge the tree.
    // This is a stable negative-feedback loop (more flow -> more friction
    // -> less head -> less flow), so it settles to a unique distribution.
    function solveTree(Hm) {
      for (let it = 0; it < 250; it++) {
        // post-order: parent-edge flow = sum of downstream emitter demand
        for (let i = order.length - 1; i >= 0; i--) {
          const u = order[i];
          let f = (byId[u].type === 'sprinkler') ? (emit[u] || 0) : 0;
          for (const c of children[u]) f += pipeFlow[c.child] || 0;
          pipeFlow[u] = f;
        }
        // pre-order: head falls down the tree from the manifold
        head[bore.id] = Hm;
        for (const u of order) {
          if (u === bore.id) continue;
          const e = parentEdge[u];
          head[u] = head[parent[u]] - headLoss(pipeFlow[u], e.L, e.d, params.hazenC);
        }
        // relax emitter flows toward q = K*sqrt(head)
        let maxd = 0;
        for (const s of sprinklers) {
          if (!visited[s.id]) { emit[s.id] = 0; continue; }
          const target = K[s.id] * Math.sqrt(Math.max(head[s.id], 0));
          const dq = 0.5 * (target - emit[s.id]);
          emit[s.id] = Math.max(0, emit[s.id] + dq);
          if (Math.abs(dq) > maxd) maxd = Math.abs(dq);
        }
        if (maxd < 1e-10 && it > 5) break;
      }
      let Q = 0;
      for (const s of sprinklers) if (visited[s.id]) Q += emit[s.id];
      return Q;
    }

    // Outer: the manifold head must satisfy the pump curve, i.e.
    //   Hm == pumpHead(totalFlow(Hm)).
    // totalFlow rises with Hm and pumpHead falls with flow, so the balance
    // is unique -> bisection finds it robustly (no winner-take-all states).
    let lo = 0, hi = H0;
    for (let b = 0; b < 60; b++) {
      const mid = 0.5 * (lo + hi);
      const ph = pumpHead(solveTree(mid));
      if (mid < ph) lo = mid; else hi = mid;
    }
    solveTree(0.5 * (lo + hi)); // settle emit/head/pipeFlow at the operating point

    // ---- collect results ----
    let total = 0;
    sprinklers.forEach(s => {
      const lpm = (emit[s.id] || 0) * 60000;
      const pkPa = Math.max(head[s.id], 0) * RHO * G / 1000;
      const spec = SPRINKLER[s.sub] || SPRINKLER['360'];
      const ratio = lpm / spec.flow;
      let status = 'ok';
      if (!visited[s.id]) status = 'bad';
      else if (ratio < 0.55) status = 'bad';
      else if (ratio < 0.85) status = 'low';
      result.sprinklers[s.id] = { flow: lpm, pressure: pkPa, rated: spec.flow, ratio, status };
      if (visited[s.id]) total += lpm;
    });
    result.totalFlow = total;
    result.manifoldPressure = pumpHead(total / 60000) * RHO * G / 1000;

    pipes.forEach(p => {
      // flow in a pipe = subtree flow of its child end
      let f = 0;
      if (parent[p.a] === p.b) f = pipeFlow[p.a] || 0;
      else if (parent[p.b] === p.a) f = pipeFlow[p.b] || 0;
      const d = PIPE_DIAM[p.size] || 0.03;
      result.pipes[p.id] = { flow: f * 60000, velocity: velocity(f, d) };
    });

    // velocity warning
    const fast = pipes.filter(p => result.pipes[p.id].velocity > 2.5);
    if (fast.length) warnings.push(fast.length + ' pipe(s) over 2.5 m/s — consider a larger diameter to cut friction & noise.');

    const starved = Object.values(result.sprinklers).filter(s => s.status === 'bad' && s.ratio > 0).length;
    if (starved) warnings.push(starved + ' sprinkler(s) badly under-supplied — too many heads on at once, or pipes too small / bore too weak.');
    if (result.manifoldPressure > 500) warnings.push('Manifold pressure is high (' + result.manifoldPressure.toFixed(0) + ' kPa) — the bore is oversized for this many heads; pressure regulation recommended.');

    result.ok = true;
    return result;
  }

  window.IrrigationSim = { simulate, headLoss, velocity, SPRINKLER, PIPE_DIAM };
})();
