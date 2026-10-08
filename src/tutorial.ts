// Primordium — interactive guided tutorial.
//
// A coach overlay mixing explanation steps with task steps that only advance
// once the player actually performs the action on the field (pause, select,
// paint, lysin, game mode…). Scripted demos paste a hand-built protocell and
// drive the live sim via the normal ControlMsg channel.
//
// Navigation: Next/Back buttons, ←/→ keys, progress dots; "Skip tour"
// leaves anytime and restores the pause/speed state. Esc is left to the
// app (inspector, lab, panel) and never exits the tour.

import type { ControlMsg, SelectionState } from './snapshot';
import { RADIUS } from './cell';

export interface TutorialDeps {
  send(msg: ControlMsg): void;
  logStatus(msg: string): void;
  isPanelOpen(): boolean;
  openPanel(): void;
  closePanel(): void;
  /** Toggle-style brush activation — the adapter in main.ts is idempotent. */
  setBrush(brush: 'pan' | 'soup' | 'water' | 'select'): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  openInspector(): void;
  closeInspector(): void;
  isInspectorOpen(): boolean;
  /** Lab modal (chemistry editor + atom dictionary) state. */
  isLabOpen(): boolean;
  closeLab(): void;
  /** Lab modal open with the dictionary tab selected. */
  isDictionaryOpen(): boolean;
  viewCenterWorld(): { x: number; y: number };
  getBrush(): 'pan' | 'soup' | 'water' | 'select';
  /** Slide the viewport toward the nearest arena edge (scripted drops). */
  panTowardEdge(): void;
  /** Center the camera on a world point, zooming so `radius` fits snugly. */
  focusOn(x: number, y: number, radius: number): void;
  /** Camera-follow the centroid of the current selection. */
  setFollow(on: boolean): void;
  isFollowing(): boolean;
  setRate(f: number): void;
  getRate(): number;
  setLysin(on: boolean): void;
  isGameMode(): boolean;
  toggleGame(): void;
}

interface Step {
  title: string;
  html: string;
  /** CSS selector of an element to ring with the spotlight. */
  spotlight?: string;
  enter?(d: TutorialDeps): void;
  exit?(d: TutorialDeps): void;
  /**
   * Task gate: while set, the step only completes once this returns true.
   * `saw(type)` reports control messages observed after the step's enter
   * hooks ran (tutorial-injected ones are already in the baseline).
   */
  task?(d: TutorialDeps, saw: (type: ControlMsg['type']) => boolean): boolean;
}

// ── Control-message observation ─────────────────────────────────────────────
// main.ts calls observeControl() inside its send() choke point so user
// actions on canvas/panel are visible to task conditions.
const counts: Partial<Record<ControlMsg['type'], number>> = {};
let baseline: Partial<Record<ControlMsg['type'], number>> = {};

export function observeControl(msg: ControlMsg): void {
  counts[msg.type] = (counts[msg.type] ?? 0) + 1;
}

function sawFactory(): (type: ControlMsg['type']) => boolean {
  return (type) => (counts[type] ?? 0) > (baseline[type] ?? 0);
}

// ── Demo protocell ──────────────────────────────────────────────────────────
// Same geometry as init.ts buildCell: a closed 'a' membrane (states S=39,
// T=40 anchors) enclosing the gene strand e-b-b-a-c-b-d-f (state 1).
// pasteSelection re-centers the coordinates, so we build around the origin.
const S = 39;
const T = 40;

function buildDemoCell(): SelectionState {
  const D = RADIUS * 2;
  const cellX: number[] = [];
  const cellY: number[] = [];
  const cellType: string[] = [];
  const cellState: number[] = [];
  const bonds: number[] = [];

  const add = (x: number, y: number, type: string, state: number): number => {
    cellX.push(x); cellY.push(y); cellType.push(type); cellState.push(state);
    return cellX.length - 1;
  };
  const bond = (a: number, b: number): void => { bonds.push(a, b); };

  // Gene strand — indices 0..7
  const geneTypes = ['e', 'b', 'b', 'a', 'c', 'b', 'd', 'f'];
  const gene = geneTypes.map((t, i) => add((i + 1) * D, 0, t, 1));
  for (let i = 0; i < gene.length - 1; i++) bond(gene[i], gene[i + 1]);

  // Membrane loop around the strand (mirrors buildCell: memLen=2, memWid=8)
  const sy = -D;
  let prev = add(0, sy, 'a', T);
  const memStart = prev;
  bond(memStart, gene[0]);
  for (let i = 0; i < 2; i++) { const c = add(0, sy + (i + 1) * D, 'a', S); bond(c, prev); prev = c; }
  for (let i = 0; i < 8; i++) {
    const c = add((i + 1) * D, sy + 2 * D, 'a', i === 7 ? T : S);
    if (i === 7) bond(c, gene[gene.length - 1]);
    bond(c, prev); prev = c;
  }
  for (let i = 1; i >= 0; i--) { const c = add(9 * D, sy + (i + 1) * D, 'a', S); bond(c, prev); prev = c; }
  for (let i = 8; i >= 0; i--) { const c = add((i + 1) * D, sy, 'a', S); bond(c, prev); prev = c; }
  bond(prev, memStart);

  // Interior soup — like the seeded cells in initSimple which sit in a
  // full soup, the demo cell carries free atoms inside its membrane:
  // 8 'd' polymerases (the strand's own 'd' is bonded into the template
  // and can't act as enzyme) plus a/b/c/e raw material for the copy.
  const inner: string[] = [
    'd', 'a', 'd', 'b', 'a', 'c', 'd', 'a',
    'd', 'b', 'a', 'd', 'c', 'd', 'e', 'd',
  ];
  for (let i = 0; i < inner.length; i++) {
    const row = i % 2;
    const x = (0.8 + 1.05 * (i >> 1) + 0.5 * row) * D;
    const y = (row === 0 ? -0.55 : 0.55) * D;
    add(x, y, inner[i], 0);
  }

  return {
    magic: 'primordium-selection', version: 1,
    savedAt: new Date().toISOString(),
    atomCount: cellX.length, cellX, cellY, cellType, cellState, bonds,
  };
}

// ── Steps ───────────────────────────────────────────────────────────────────
const STEPS: Step[] = [
  {
    title: 'Welcome to Primordium',
    html: `Primordium is an <b>artificial chemistry</b>: thousands of atoms drift
      through a 2D soup, react with their neighbors and form bonds — and out
      of that, membrane-enclosed cells emerge that copy their genome and
      divide.<br><br>This is a <b>guided tour</b>: some steps ask you to do
      things on the field — the tour only continues once you've done them.
      <b>Skip tour</b> leaves anytime.`,
  },
  {
    title: 'The soup: atoms, states, bonds',
    html: `Every dot is an <b>atom</b> with a <b>type</b>
      (<code>a–f, w, p</code>) and a numeric <b>state</b>. Atoms jiggle in
      Brownian motion. When two collide, a reaction rule can flip their
      states or create/break a <b>bond</b> — that is all the physics there
      is.<br><br>Bonds build structures: chains, loops, cells.`,
  },
  {
    title: 'Tour of the panel',
    spotlight: '#control-panel',
    enter: (d) => d.openPanel(),
    html: `Everything lives in the <b>Controls</b> panel (<kbd>M</kbd> /
      ☰ button) — playback, brushes, world seeding, physics sliders, lab
      tools and archive/export, grouped in cards.<br><br>The
      <b>Shortcuts</b> card at the bottom lists every keybind.`,
  },
  {
    title: 'Task: pause the simulation',
    task: (d) => d.isPaused(),
    exit: (d) => d.closePanel(),
    html: `<span class="tutorial-task">TASK — press <kbd>Space</kbd> (or the
      Pause button) to freeze the sim.</span><br><br>Frozen, the atoms stop
      jittering — zoom in: every atom has a <b>type letter and a state
      number</b>; the inspector reveals them two steps from now.`,
  },
  {
    title: 'Task: select some atoms',
    task: (_d, saw) => saw('selectAt') || saw('selectBox'),
    html: `<span class="tutorial-task">TASK — press <kbd>M</kbd>, hit
      <b>🎯 Select</b>, then <b>click an atom</b> or drag a box around
      several.</span><br><br>A halo marks the selection. The button label
      shows ON — like the brushes, <b>clicking it again switches it off</b>
      and gets you back to panning (outside the tour, <kbd>Esc</kbd>
      does too).`,
  },
  {
    title: 'Task: open the inspector',
    task: (d) => d.isInspectorOpen(),
    html: `<span class="tutorial-task">TASK — press <kbd>I</kbd> to open the
      <b>inspector</b>: a frozen atom-level view of your selection.</span>
      <br><br>In <b>Edit</b> mode you could add, bond or delete atoms —
      for now just look, then continue.`,
  },
  {
    title: 'Task: close the inspector',
    task: (d) => !d.isInspectorOpen(),
    html: `<span class="tutorial-task">TASK — close the inspector
      yourself: the <b>✕</b> in its top-right corner, or
      <kbd>Esc</kbd>.</span><br><br><kbd>Esc</kbd> closes the topmost
      thing everywhere in Primordium — inspector, panel, lab.`,
  },
  {
    title: 'Task: switch Select off',
    task: (d) => d.getBrush() === 'pan',
    html: `<span class="tutorial-task">TASK — click <b>🎯 Select</b> in the
      panel (<kbd>M</kbd>) again so it reads OFF.</span><br><br>With a brush
      active you can't drag the canvas — every tool in Primordium toggles back
      to panning.`,
  },
  {
    title: 'A real protocell',
    enter: (d) => {
      // Clear any leftover selection and slide the camera toward the
      // arena edge so the drop lands in open space, not inside whatever
      // cell the user was inspecting at view center.
      d.setBrush('pan');
      d.panTowardEdge();
      const c = d.viewCenterWorld();
      d.send({ type: 'pasteSelection', x: c.x, y: c.y, selection: buildDemoCell() });
      // Paused so the cell can't drift away before you've looked at it.
      d.setPaused(true);
      d.focusOn(c.x, c.y, 110);
      d.logStatus('Tutorial: pasted a hand-built protocell at view center');
    },
    html: `I just dropped a <b>minimal protocell</b>, zoomed in on it and
      paused the sim so it can't drift away: a closed ring of
      <code>a</code> atoms (the membrane) enclosing a gene strand
      <code>e-b-b-a-c-b-d-f</code> plus some loose cargo atoms.<br><br>
      The colors are the atom types — each atom has a <b>type letter and
      a state number</b>, and the inspector (<kbd>I</kbd>) you just used
      reads them. The yellow halo means the drop is <b>selected</b>.`,
  },
  {
    title: 'Task: open the atom dictionary',
    spotlight: '#dict-btn',
    enter: (d) => d.openPanel(),
    task: (d) => d.isDictionaryOpen(),
    html: `What do all those letters and state numbers mean? Every atom
      in the sim is explained in the <b>atom dictionary</b> — plain
      English, including the gene machinery: <code>e</code> anchors the
      strand to the membrane, <code>d</code> is the walking polymerase
      enzyme, <code>f</code> ends the gene and triggers division.<br><br>
      <span class="tutorial-task">TASK — in the panel's new
      <b>Learn</b> card, hit <b>📖 Atom dictionary</b> and read the
      entries for <code>a</code>, <code>d</code>, <code>e</code> and
      <code>f</code>.</span><br><br>The <b>Editor</b> tab in the same
      popup is for writing custom chemistries — advanced territory, no
      need yet.`,
  },
  {
    title: 'Task: close the dictionary',
    task: (d) => !d.isLabOpen(),
    html: `<span class="tutorial-task">TASK — close the dictionary: the
      <b>✕</b> in its top-right corner, or <kbd>Esc</kbd>.</span><br><br>
      Same rule as the inspector: <kbd>Esc</kbd> always closes the
      topmost thing.`,
  },
  {
    title: 'Task: track the cell',
    spotlight: '#follow-btn',
    enter: (d) => d.openPanel(),
    task: (d) => d.isFollowing(),
    html: `See the halo? A selected thing can be <b>tracked</b> — and the
      drop arrived already selected.<br><br>
      <span class="tutorial-task">TASK: press <b>🎥 Follow</b> (right next
      to 🎯 Select). The camera will keep your cell centered wherever it
      drifts — zooming stays locked on, any pan hands the camera back to
      you, and the button greys out while nothing is selected.</span>`,
  },
  {
    title: 'Genome copying & division',
    enter: (d) => { d.setPaused(false); d.setRate(1); },
    exit: (d) => d.setFollow(false),
    html: `Resuming at high speed — watch the <b>free
      <code>d</code> polymerases</b> inside the membrane. When one touches
      the strand start (<code>e</code>), it enters walk state and copies
      the template base by base. Reaching <code>f</code> splits the cell
      into <b>two daughters</b>.<br><br>Follow stays on — the camera
      rides along. Real replication, driven only by local reaction rules.`,
  },
  {
    title: 'Task: paint atoms',
    task: (_d, saw) => saw('paintSoup'),
    html: `<span class="tutorial-task">TASK — press <kbd>B</kbd> for the
      soup brush, then <b>drag on the canvas</b> to seed free atoms.</span>
      <br><br>More atoms = more reactions = faster evolution. Press
      <kbd>B</kbd> again to switch the brush off and get back to panning —
      the button label shows ON/OFF.`,
  },
  {
    title: 'Task: drop some water',
    task: (_d, saw) => saw('paintWater'),
    html: `<span class="tutorial-task">TASK — press <kbd>W</kbd> and click
      on the canvas to drop water.</span> Press <kbd>W</kbd> again to
      switch it off.<br><br>Droplets are held by
      surface tension and fuse on contact. <kbd>C</kbd> clears all water.
      With <b>hydrolysis</b> (<kbd>H</kbd>) on, water actively cleaves
      bonds — but live cells are protected while their membrane holds.`,
  },
  {
    title: 'Task: release the lysin',
    task: (_d, saw) => saw('toggleLysin'),
    exit: (d) => d.setLysin(false),
    html: `<span class="tutorial-task">TASK — press <kbd>P</kbd> to seed
      <b>lysin</b> (<code>p</code> atoms).</span><br><br>It's a catalyst
      that eats membrane <code>a-a</code> bonds and is never consumed —
      membranes dissolve on contact. This is how cells die in the soup.`,
  },
  {
    title: 'Noise & evolution',
    spotlight: '#noise-btn',
    enter: (d) => d.openPanel(),
    html: `In the panel's <b>Lab</b> section, <b>Noise</b> (<kbd>N</kbd>)
      injects copy misfires, decay and bond failures — mutation. Mutated
      gene strands produce different cells; cells compete for soup
      atoms.<br><br>That's real evolution: variation + selection.`,
  },
  {
    title: 'Task: enter play mode',
    task: (d, saw) => saw('startGame') || d.isGameMode(),
    enter: (d) => d.closePanel(),
    html: `<span class="tutorial-task">TASK — enter <b>play mode</b>:
      press <kbd>G</kbd>, or reopen <b>Controls</b> (<kbd>M</kbd> / ☰)
      and tap 🦠 <b>Steer a microbe</b>.</span><br><br>The green microbe
      will be yours: <b>press &amp; hold on the canvas</b> to steer it
      toward the pointer — <b>WASD</b> does the same on a keyboard.
      You win when no enemy cell survives ~5 s with a closed membrane —
      you lose if all your cells are lysed.`,
  },
  {
    title: "You're playing now",
    html: `That was the tour — the world stays in play mode, so
      <b>keep steering</b> your microbe.<br><br>
      📄 <a href="https://github.com/rubo77/Evoloom/blob/main/How_to_play.md"
      target="_blank" rel="noopener"><b>How_to_play.md</b></a> — the full
      manual in the repo<br>
      🧪 <a href="https://github.com/rubo77/OrganicBuilder" target="_blank"
      rel="noopener">Organic Builder</a> — a step-by-step tutorial app for
      this exact reaction model<br><br>
      Crank the noise, seed a cell, watch what emerges.`,
  },
];

// ── Engine ──────────────────────────────────────────────────────────────────
let overlay: HTMLDivElement | null = null;
let spot: HTMLDivElement | null = null;
let card: HTMLDivElement | null = null;
let deps: TutorialDeps | null = null;
let index = 0;
let active = false;
let taskDone = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let savedPaused = false;
let savedRate = 1;

export function startTutorial(d: TutorialDeps): void {
  if (active) return;
  deps = d;
  active = true;
  index = 0;
  savedPaused = d.isPaused();
  savedRate = d.getRate();
  buildDom();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', positionSpotlight);
  renderStep();
}

function buildDom(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  spot = document.createElement('div');
  spot.id = 'tutorial-spot';
  spot.hidden = true;
  card = document.createElement('div');
  card.id = 'tutorial-card';
  overlay.appendChild(spot);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function renderStep(): void {
  const step = STEPS[index];
  const d = deps!;
  if (step.enter) step.enter(d);
  taskDone = !step.task;
  // Baseline the observed message counts AFTER enter hooks so scripted
  // demo sends can't satisfy the task condition.
  baseline = { ...counts };
  const dots = STEPS.map((_, i) =>
    `<span class="tutorial-dot${i === index ? ' current' : ''}"></span>`).join('');
  const isLast = index === STEPS.length - 1;
  card!.innerHTML = `
    <div class="tutorial-step-label">Step ${index + 1} / ${STEPS.length}</div>
    <div class="tutorial-title">${taskDone ? '' : '☐ '}${step.title}</div>
    <div class="tutorial-body">${step.html}</div>
    <div class="tutorial-nav">
      <button id="tut-prev" ${index === 0 ? 'disabled' : ''}>← Back</button>
      <span class="tutorial-dots">${dots}</span>
      <button id="tut-skip">Skip tour</button>
      <button id="tut-next" ${taskDone ? '' : 'disabled'}
        title="${taskDone ? '' : 'Complete the task to continue'}">
        ${isLast ? 'Done ✓' : 'Next →'}</button>
    </div>`;
  byId('tut-prev').addEventListener('click', () => goTo(index - 1));
  byId('tut-next').addEventListener('click', () => {
    if (taskDone) goTo(index + 1);
  });
  byId('tut-skip').addEventListener('click', closeTutorial);
  positionSpotlight();
  // The panel slides in over 0.24s — re-aim the ring once it settles.
  setTimeout(positionSpotlight, 260);
  if (step.task) startPolling(step);
}

function startPolling(step: Step): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!active || !step.task) return;
    if (step.task(deps!, sawFactory())) {
      completeTask();
    }
  }, 200);
}

function completeTask(): void {
  stopPolling();
  taskDone = true;
  const title = card!.querySelector('.tutorial-title');
  if (title) {
    title.innerHTML = `✓ ${STEPS[index].title.replace(/^Task: /, '')}`;
    title.classList.add('tutorial-done');
  }
  const next = card!.querySelector('#tut-next') as HTMLButtonElement | null;
  if (next) { next.disabled = false; next.title = ''; }
  // Auto-advance shortly after success — unless the user navigated meanwhile.
  const at = index;
  setTimeout(() => { if (active && index === at) goTo(at + 1); }, 900);
}

function stopPolling(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

function byId(id: string): HTMLElement {
  return card!.querySelector('#' + id) as HTMLElement;
}

function positionSpotlight(): void {
  if (!spot) return;
  const sel = STEPS[index].spotlight;
  const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
  // Panel controls can sit below the fold — scroll the target into view
  // so the ring lands on it instead of off-screen.
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = el ? el.getBoundingClientRect() : null;
  if (!el || !rect || (rect.width === 0 && rect.height === 0)) {
    spot.hidden = true;
    return;
  }
  const pad = 6;
  spot.hidden = false;
  spot.style.left = `${rect.left - pad}px`;
  spot.style.top = `${rect.top - pad}px`;
  spot.style.width = `${rect.width + pad * 2}px`;
  spot.style.height = `${rect.height + pad * 2}px`;
}

function goTo(next: number): void {
  stopPolling();
  if (next < 0 || next >= STEPS.length) { closeTutorial(); return; }
  const leaving = STEPS[index];
  if (leaving.exit) leaving.exit(deps!);
  index = next;
  renderStep();
}

function onKey(e: KeyboardEvent): void {
  if (!active) return;
  // Esc never exits the tour — it stays owned by the app: inspector,
  // lab modal and panel close on Esc, and the "close it yourself"
  // tasks depend on that. Only Skip tour leaves.
  if (e.code === 'Escape') return;
  if (e.code === 'ArrowRight' && taskDone) {
    e.stopPropagation();
    goTo(index + 1);
  } else if (e.code === 'ArrowLeft') {
    e.stopPropagation();
    goTo(index - 1);
  }
}

function closeTutorial(): void {
  if (!active) return;
  stopPolling();
  const leaving = STEPS[index];
  if (leaving.exit) leaving.exit(deps!);
  active = false;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', positionSpotlight);
  overlay?.remove();
  overlay = spot = card = null;
  // Restore the world state the tutorial found. Play mode entered by the
  // player stays on — the tour ends inside the game by design.
  deps!.setRate(savedRate);
  deps!.setPaused(savedPaused);
  if (deps!.isInspectorOpen()) deps!.closeInspector();
  if (deps!.isLabOpen()) deps!.closeLab();
  deps!.setFollow(false);
  deps!.setBrush('pan');
  deps!.logStatus('Tutorial finished — the soup is yours.');
}
