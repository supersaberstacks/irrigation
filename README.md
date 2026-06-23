# Irrigation Designer

A browser-based tool for designing a backyard irrigation layout and checking
whether it will actually work — before you dig. Draw your yard, lay pipe from a
bore (pump), drop in sprinkler heads, then run a hydraulic simulation that tells
you how much water each head really gets at the pressure your pump can deliver.

No build step, no dependencies, no server. It's plain HTML + CSS + vanilla
JavaScript running on a `<canvas>`.

## Running it

Open `index.html` in any modern browser. That's it.

> Tip: because everything is client-side, you can also just double-click
> `index.html`. Your work auto-saves to the browser's `localStorage`, so it's
> still there when you reopen the page.

## Using it

1. **Set the yard size** (top bar) — width × height in metres.
2. **Place a bore** (`■` tool) — this is your pump/water source. Select it to set
   its horsepower and depth (how far it has to lift water).
3. **Draw pipe** (`━` tool) — click point-to-point. Click on an existing pipe to
   tee into it; `Esc` or right-click ends a run. Choose 40/30/20 mm in the top bar.
4. **Add sprinklers** — `◉` 360°, `◐` 180°, `◔` 90°. Rotate a head with its aim handle.
5. **Draw areas** (`▭` tool) — garden beds, sheds, paving, etc. (visual only).
6. **▶ Simulate** — solves the network and colours each head by how well it's supplied.

Navigation: mouse wheel = zoom, right-drag / Shift-drag = pan, **Fit** recentres,
`Delete` removes the selection.

The side panel has four tabs:

- **Inspect** — properties of the selected element.
- **Results** — per-head flow & pressure, total flow, manifold pressure, warnings.
- **Parts** — an auto-generated bill of materials (pipe lengths, head counts, bore).
- **Settings** — pump efficiency, sprinkler rated pressure, pipe roughness (Hazen C).

## How the simulation works

The hydraulics live in [`sim.js`](sim.js) (`window.IrrigationSim.simulate`). In short:

- **Pump** — modelled as constant *power*: `P = efficiency × HP × 745.7 W`. That
  power must both lift water from the bore `depth` and pressurise the surface
  network, so available head **falls as flow rises** — a realistic pump curve.
- **Pipes** — Hazen–Williams friction loss (default roughness `C = 150`, typical
  for poly/PVC). Flow velocity is reported and flagged above 2.5 m/s.
- **Sprinklers** — pressure-driven emitters, `q = K·√head`, where `K` is fixed
  from each head's rated flow at the rated pressure.
- **Solver** — the network is reduced to a spanning tree rooted at the bore (loops
  are detected and reported, then ignored for flow). An inner damped fixed-point
  loop settles the flow distribution for a given manifold head; an outer bisection
  finds the manifold head where the pump curve and network demand balance. This is
  numerically stable and converges to a unique operating point.

Heads are rated **ok / low / bad** by how close actual flow is to rated flow
(≥85% ok, ≥55% low, otherwise bad). Warnings call out disconnected heads,
loops, over-fast pipes, starved heads, and an oversized bore.

## Project layout

| File | Role |
|------|------|
| [`index.html`](index.html) | Page shell — top bar, tool rail, canvas, side panel. |
| [`styles.css`](styles.css) | All styling. |
| [`sim.js`](sim.js) | Pure hydraulic model — no DOM. Exposes `window.IrrigationSim`. |
| [`app.js`](app.js) | Everything interactive: drawing, editing, rendering, BOM, save/load. |

`sim.js` deliberately has no DOM dependencies, so the model can be tested or
reused independently of the editor.

## Save / load format

**Export** writes a JSON file; **Import** reads one back. The shape is:

```json
{
  "yard":   { "w": 15, "h": 20 },
  "nodes":  [ { "id": "n1", "x": 5, "y": 5, "type": "bore", "hp": 2.5, "depth": 6 } ],
  "pipes":  [ { "id": "n3", "a": "n1", "b": "n2", "size": 30 } ],
  "shapes": [ { "id": "s1", "x": 1, "y": 1, "w": 4, "h": 3, "label": "Bed", "color": "#3fae5a" } ],
  "params": { "eff": 0.5, "ratedP": 200, "hazenC": 150 }
}
```

Coordinates are in metres. The same object is what gets auto-saved to
`localStorage`.

## Notes & limitations

- All flows are simulated as a **tree**; redundant (looping) pipes are ignored for
  flow distribution.
- Sprinkler catalogue, pipe diameters, and defaults are hard-coded near the top of
  [`sim.js`](sim.js) — edit there to match your real hardware.
- It's an engineering *estimate*, not a guarantee. Validate against your actual
  pump curve and fittings before committing to a trench.
