// @ts-check
// Maple to the Knee: the app. Plain JS, no build. Structure adapted from arrow-to-the-knee.
(() => {
  'use strict';

  /**
   * @typedef {'job'|'quest'|'train'|'gear'|'ap'|'sp'|'pq'|'tip'} TaskType
   * @typedef {'one-handed'|'two-handed'} Variant
   * @typedef {{
   *   id: string, type: TaskType, variant?: Variant|null, required?: boolean,
   *   priority?: 'high'|'medium'|'low', titleHe: string, titleEn?: string,
   *   summary?: string, why?: string, steps?: string[], npc?: string, route?: string[],
   *   maps?: string[], monsters?: string[], rewards?: object, requirements?: { level?: number, str?: number, dex?: number },
   *   notes?: string[], sources?: string[], verified?: boolean
   * }} Task
   * @typedef {{
   *   id: string, order: number, titleHe: string, levelFrom: number, levelTo: number,
   *   job: string, regionHe: string, goalHe: string, availability?: 'live'|'upcoming'|'not-in-game',
   *   tasks: Task[]
   * }} Stage
   * @typedef {{ id: string, nameHe: string, nameEn: string, stages: Stage[], tips?: string[] }} Build
   * @typedef {{
   *   currentStage: string|null, viewStage: string|null, myLevel: number|null,
   *   weaponStyle: Variant|null, done: Record<string, string>, stagesCompleted: Record<string, string>
   * }} BuildState
   * @typedef {{ v: number, activeBuild: string|null, builds: Record<string, BuildState> }} Store
   */

  const STORAGE_KEY = 'maple-to-the-knee-v1';
  const STORE_VERSION = 1;
  const TOAST_MS = 5000;

  /** @type {Record<TaskType, { icon: string, nameHe: string }>} */
  const TYPES = {
    job: { icon: '🗡️', nameHe: 'מעבר ג׳וב' },
    quest: { icon: '📜', nameHe: 'קווסטים' },
    train: { icon: '⚔️', nameHe: 'איפה להתאמן' },
    gear: { icon: '🛡️', nameHe: 'ציוד' },
    ap: { icon: '💪', nameHe: 'נקודות יכולת (AP)' },
    sp: { icon: '✨', nameHe: 'סקילים (SP)' },
    pq: { icon: '👥', nameHe: 'פרטי קווסט' },
    tip: { icon: '💡', nameHe: 'טיפים' },
  };
  const TYPE_ORDER = /** @type {TaskType[]} */ (Object.keys(TYPES));
  const VARIANTS = { 'one-handed': '🛡️ חד-ידנית', 'two-handed': '⚔️ דו-ידנית' };
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  function byId(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error('missing #' + id);
    return node;
  }

  const el = {
    buildName: byId('build-name'),
    stageHead: byId('stage-head'),
    banner: byId('banner'),
    list: byId('list'),
    toast: byId('toast'),
    toastText: byId('toast-text'),
    toastUndo: byId('toast-undo'),
  };

  const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** @type {Build[]} */
  let builds = [];
  /** @type {Store} */
  let store = emptyStore();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let toastTimer;
  /** @type {(() => void)|null} */
  let toastUndoFn = null;
  let doneOpen = false;

  /* ---------- Storage ---------- */

  /** @returns {Store} */
  function emptyStore() {
    return { v: STORE_VERSION, activeBuild: null, builds: {} };
  }

  /** @param {unknown} v */
  function isObj(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  }

  /** @returns {Store} */
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStore();
      return migrate(JSON.parse(raw));
    } catch (e) {
      return emptyStore();
    }
  }

  /**
   * Accepts any older or damaged shape and returns a valid current store.
   * @param {any} data
   * @returns {Store}
   */
  function migrate(data) {
    if (!isObj(data)) return emptyStore();
    /** @type {Store} */
    const out = {
      v: STORE_VERSION,
      activeBuild: typeof data.activeBuild === 'string' ? data.activeBuild : null,
      builds: {},
    };
    if (isObj(data.builds)) {
      for (const [id, s] of Object.entries(data.builds)) out.builds[id] = cleanBuildState(s);
    }
    return out;
  }

  /**
   * @param {any} s
   * @returns {BuildState}
   */
  function cleanBuildState(s) {
    const src = isObj(s) ? s : {};
    /** @param {any} m */
    const dates = (m) => {
      /** @type {Record<string, string>} */
      const r = {};
      if (isObj(m)) for (const [k, v] of Object.entries(m)) if (typeof v === 'string') r[k] = v;
      return r;
    };
    const level = Number(src.myLevel);
    return {
      currentStage: typeof src.currentStage === 'string' ? src.currentStage : null,
      viewStage: typeof src.viewStage === 'string' ? src.viewStage : null,
      myLevel: Number.isInteger(level) && level > 0 ? level : null,
      weaponStyle: src.weaponStyle === 'one-handed' || src.weaponStyle === 'two-handed' ? src.weaponStyle : null,
      done: dates(src.done),
      stagesCompleted: dates(src.stagesCompleted),
    };
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      /* storage unavailable: keep working in memory */
    }
  }

  /**
   * @param {string} buildId
   * @returns {BuildState}
   */
  function buildState(buildId) {
    if (!store.builds[buildId]) store.builds[buildId] = cleanBuildState(null);
    return store.builds[buildId];
  }

  /* ---------- Helpers ---------- */

  /** @param {unknown} str */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Runs of Latin text get wrapped in <bdi> so punctuation around them stays in the right place.
  const LATIN_RUN = /[A-Za-z](?:[A-Za-z0-9'’\-:]|\.(?=[A-Za-z0-9]))*(?: +[A-Za-z0-9](?:[A-Za-z0-9'’\-:]|\.(?=[A-Za-z0-9]))*)*/g;

  /** @param {unknown} str */
  function richText(str) {
    const text = String(str == null ? '' : str);
    let out = '';
    let last = 0;
    for (const m of text.matchAll(LATIN_RUN)) {
      const offset = m.index || 0;
      out += escapeHtml(text.slice(last, offset)) + '<bdi>' + escapeHtml(m[0]) + '</bdi>';
      last = offset + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
  }

  /** @param {string|undefined} iso */
  function formatDate(iso) {
    const d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : dateFmt.format(d);
  }

  /** @returns {Build} */
  function activeBuild() {
    return builds.find((b) => b.id === store.activeBuild) || builds[0];
  }

  /** @param {Build} build */
  function sortedStages(build) {
    return build.stages.slice().sort((a, b) => a.order - b.order);
  }

  /**
   * The stage the user is on. Falls back to the first stage not marked complete.
   * @param {Build} build
   * @returns {Stage}
   */
  function currentStage(build) {
    const state = buildState(build.id);
    const stages = sortedStages(build);
    const found = stages.find((s) => s.id === state.currentStage);
    if (found) return found;
    const next = stages.find((s) => !state.stagesCompleted[s.id]) || stages[stages.length - 1];
    state.currentStage = next.id;
    saveStore();
    return next;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   */
  function nextStage(build, stage) {
    const stages = sortedStages(build);
    return stages[stages.indexOf(stage) + 1] || null;
  }

  /**
   * @param {Build} build
   * @param {string} taskId
   */
  function isDone(build, taskId) {
    return Boolean(buildState(build.id).done[taskId]);
  }

  /**
   * Tasks that apply to the chosen weapon style. With no style chosen, both variants show.
   * @param {Build} build
   * @param {Stage} stage
   */
  function visibleTasks(build, stage) {
    const style = buildState(build.id).weaponStyle;
    return stage.tasks.filter((t) => !t.variant || !style || t.variant === style);
  }

  /**
   * Required tasks that decide whether the stage is complete, and how many are done.
   * With no weapon style chosen, a stage counts as complete when the shared required tasks
   * and the required tasks of either style are done; progress follows the closer style.
   * @param {Build} build
   * @param {Stage} stage
   * @returns {{ done: number, total: number }}
   */
  function stageProgress(build, stage) {
    const required = visibleTasks(build, stage).filter((t) => t.required);
    /** @param {Task[]} list */
    const count = (list) => ({ done: list.filter((t) => isDone(build, t.id)).length, total: list.length });
    const style = buildState(build.id).weaponStyle;
    const hasVariants = required.some((t) => t.variant);
    if (style || !hasVariants) return count(required);
    const shared = required.filter((t) => !t.variant);
    const options = /** @type {Variant[]} */ (['one-handed', 'two-handed'])
      .map((v) => count(shared.concat(required.filter((t) => t.variant === v))))
      .filter((c) => c.total > shared.length);
    options.sort((a, b) => b.done / b.total - a.done / a.total || a.total - b.total);
    return options[0] || count(shared);
  }

  /**
   * @param {Task} task
   * @returns {{ cls: string, label: string }}
   */
  function tagOf(task) {
    if (task.required && task.type !== 'pq') return { cls: 'required', label: 'חובה' };
    if (task.priority === 'low' || task.type === 'pq') return { cls: 'optional', label: 'רשות' };
    return { cls: 'recommended', label: 'מומלץ' };
  }

  /** @param {Task[]} tasks */
  function sortTasks(tasks) {
    return tasks
      .map((task, index) => ({ task, index }))
      .sort((a, b) => {
        const ra = a.task.required ? 0 : 1;
        const rb = b.task.required ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const pa = PRIORITY_RANK[a.task.priority || 'medium'];
        const pb = PRIORITY_RANK[b.task.priority || 'medium'];
        if (pa !== pb) return pa - pb;
        const la = (a.task.requirements && a.task.requirements.level) || 0;
        const lb = (b.task.requirements && b.task.requirements.level) || 0;
        if (la !== lb) return la - lb;
        return a.index - b.index;
      })
      .map((x) => x.task);
  }

  /** @param {Stage} stage */
  function levelsLabel(stage) {
    return stage.levelFrom === stage.levelTo
      ? `רמה ${escapeHtml(stage.levelFrom)}`
      : `רמות <bdi dir="ltr">${escapeHtml(stage.levelFrom)}–${escapeHtml(stage.levelTo)}</bdi>`;
  }

  /* ---------- Rendering ---------- */

  /** @param {Task} task */
  function badgesHtml(task) {
    const tag = tagOf(task);
    let html = `<span class="badge badge-${tag.cls}">${tag.label}</span>`;
    const lvl = task.requirements && task.requirements.level;
    if (lvl) html += `<span class="badge badge-level">רמה <bdi dir="ltr">${escapeHtml(lvl)}+</bdi></span>`;
    if (task.variant && VARIANTS[task.variant]) html += `<span class="badge badge-variant">${VARIANTS[task.variant]}</span>`;
    return `<span class="badges">${html}</span>`;
  }

  /**
   * @param {Build} build
   * @param {Task} task
   */
  function cardHtml(build, task) {
    const doneAt = buildState(build.id).done[task.id];
    const done = Boolean(doneAt);
    const meta = done
      ? `<span class="done-date">בוצע ב-${escapeHtml(formatDate(doneAt))}</span>`
      : `${task.summary ? `<span class="summary">${richText(task.summary)}</span>` : ''}${badgesHtml(task)}`;
    const checkLabel = done ? `החזרה לרשימה: ${task.titleHe}` : `סימון כבוצע: ${task.titleHe}`;
    const icon = (TYPES[task.type] || { icon: '•' }).icon;
    return `<li class="card" data-id="${escapeHtml(task.id)}">
      <div class="card-main">
        <span class="thumb"><span class="thumb-emoji" aria-hidden="true">${icon}</span></span>
        <span class="card-body">
          <span class="name-he">${richText(task.titleHe)}</span>
          ${task.titleEn ? `<span class="name-en" dir="ltr">${escapeHtml(task.titleEn)}</span>` : ''}
          ${meta}
        </span>
      </div>
      <button type="button" class="check" data-action="toggle" role="checkbox" aria-checked="${done}" aria-label="${escapeHtml(checkLabel)}">
        <span class="check-box">${ICON_CHECK}</span>
      </button>
    </li>`;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   */
  function renderStageHead(build, stage) {
    const p = stageProgress(build, stage);
    const pct = p.total ? (p.done / p.total) * 100 : 0;
    el.stageHead.innerHTML = `
      <p class="stage-kicker">שלב ${escapeHtml(stage.order)} · ${levelsLabel(stage)} · ${richText(stage.regionHe)}</p>
      <h2 class="stage-title">${richText(stage.titleHe)}</h2>
      <p class="stage-goal"><span class="stage-goal-label">🎯 מטרה:</span><span>${richText(stage.goalHe)}</span></p>
      ${p.total ? `<div class="stage-progress">
        <span class="progress-bar" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></span>
        <span class="progress-text">${p.done}/${p.total} משימות חובה</span>
      </div>` : ''}`;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   */
  function renderBanner(build, stage) {
    const p = stageProgress(build, stage);
    if (!p.total || p.done < p.total) {
      el.banner.innerHTML = '';
      return;
    }
    const next = nextStage(build, stage);
    el.banner.innerHTML = next
      ? `<section class="banner" aria-live="polite">
          <p class="banner-title">🎉 השלב הושלם!</p>
          <p class="banner-text">כל משימות החובה בשלב הזה סומנו.</p>
          <button type="button" class="banner-btn" data-action="next-stage">← לשלב הבא: ${richText(next.titleHe)}</button>
        </section>`
      : `<section class="banner" aria-live="polite">
          <p class="banner-title">🍁 הגעת לרמה ${escapeHtml(stage.levelTo)}, התוכן הבא בדרך</p>
          <p class="banner-text">זה השלב האחרון שנכתב עד עכשיו.</p>
        </section>`;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   */
  function renderList(build, stage) {
    const tasks = visibleTasks(build, stage);
    const open = tasks.filter((t) => !isDone(build, t.id));
    const done = tasks.filter((t) => isDone(build, t.id));
    let html = '';
    if (!tasks.length) {
      el.list.innerHTML = '<p class="empty">התוכן לשלב הזה עוד בכתיבה.</p>';
      return;
    }
    for (const type of TYPE_ORDER) {
      const items = sortTasks(open.filter((t) => t.type === type));
      if (!items.length) continue;
      html += `<section class="group"><h3 class="group-title"><span aria-hidden="true">${TYPES[type].icon}</span>${escapeHtml(TYPES[type].nameHe)}</h3>
        <ul class="cards">${items.map((t) => cardHtml(build, t)).join('')}</ul></section>`;
    }
    if (!open.length) html += '<p class="empty">כל המשימות בשלב הזה סומנו.</p>';
    if (done.length) {
      const doneMap = buildState(build.id).done;
      const sorted = done.slice().sort((a, b) => String(doneMap[b.id]).localeCompare(String(doneMap[a.id])));
      html += `<details class="done-section" id="done-section"${doneOpen ? ' open' : ''}>
        <summary>בוצע בשלב הזה (${done.length})</summary>
        <ul class="cards">${sorted.map((t) => cardHtml(build, t)).join('')}</ul>
      </details>`;
    }
    el.list.innerHTML = html;
  }

  function render() {
    const build = activeBuild();
    if (!build) return;
    const stage = currentStage(build);
    el.buildName.textContent = `${build.nameHe} · Classic World`;
    renderStageHead(build, stage);
    renderBanner(build, stage);
    renderList(build, stage);
  }

  /* ---------- Actions ---------- */

  /** @param {string} taskId */
  async function toggleTask(taskId) {
    const build = activeBuild();
    const state = buildState(build.id);
    const prev = state.done[taskId];
    const wasDone = Boolean(prev);
    if (wasDone) delete state.done[taskId];
    else state.done[taskId] = new Date().toISOString();
    saveStore();

    const card = el.list.querySelector(`.card[data-id="${CSS.escape(taskId)}"]`);
    if (card instanceof HTMLElement) {
      const box = card.querySelector('.check');
      if (box) box.setAttribute('aria-checked', String(!wasDone));
      await animateOut(card);
    }
    render();

    const buildId = build.id;
    showToast(wasDone ? 'הוחזר לרשימה' : 'סומן כבוצע', () => {
      const s = buildState(buildId);
      if (wasDone) s.done[taskId] = /** @type {string} */ (prev);
      else delete s.done[taskId];
      saveStore();
      render();
    });
  }

  function goToNextStage() {
    const build = activeBuild();
    const stage = currentStage(build);
    const next = nextStage(build, stage);
    if (!next) return;
    const state = buildState(build.id);
    state.stagesCompleted[stage.id] = new Date().toISOString();
    state.currentStage = next.id;
    state.viewStage = null;
    saveStore();
    doneOpen = false;
    hideToast();
    render();
    window.scrollTo({ top: 0 });
  }

  /** @param {HTMLElement} node */
  function animateOut(node) {
    if (reducedMotion.matches || typeof node.animate !== 'function' || document.hidden) return Promise.resolve();
    // Never let a stalled animation hold up the list.
    return Promise.race([runAnimateOut(node), new Promise((r) => setTimeout(r, 900))]);
  }

  /** @param {HTMLElement} node */
  async function runAnimateOut(node) {
    try {
      const cs = getComputedStyle(node);
      node.style.overflow = 'hidden';
      node.style.pointerEvents = 'none';
      await node.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-28px)' }],
        { duration: 200, delay: 120, easing: 'ease-in', fill: 'forwards' }
      ).finished;
      await node.animate(
        [
          { height: node.offsetHeight + 'px', marginBottom: cs.marginBottom },
          { height: '0px', marginBottom: '0px' },
        ],
        { duration: 180, easing: 'ease-out', fill: 'forwards' }
      ).finished;
    } catch (e) {
      /* animation interrupted: fall through to re-render */
    }
  }

  /**
   * @param {string} message
   * @param {() => void} undoFn
   */
  function showToast(message, undoFn) {
    clearTimeout(toastTimer);
    toastUndoFn = undoFn;
    el.toastText.textContent = message;
    el.toast.hidden = false;
    // restart the entrance animation
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth;
    el.toast.style.animation = '';
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastUndoFn = null;
    el.toast.hidden = true;
  }

  /* ---------- Events ---------- */

  el.list.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = target.closest('[data-action]');
    if (!(btn instanceof HTMLElement)) return;
    const card = btn.closest('.card');
    if (!(card instanceof HTMLElement) || !card.dataset.id) return;
    if (btn.dataset.action === 'toggle') toggleTask(card.dataset.id);
  });

  el.list.addEventListener(
    'toggle',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLDetailsElement && t.id === 'done-section') doneOpen = t.open;
    },
    true
  );

  el.banner.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('[data-action="next-stage"]')) goToNextStage();
  });

  el.toastUndo.addEventListener('click', () => {
    const fn = toastUndoFn;
    hideToast();
    if (fn) fn();
  });

  /* ---------- Boot ---------- */

  /** @param {string} url */
  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(url + ': ' + res.status);
    return res.json();
  }

  /**
   * @param {any} data
   * @returns {Build[]}
   */
  function parseGuide(data) {
    const list = isObj(data) && Array.isArray(data.builds) ? data.builds : [];
    return list
      .filter((/** @type {any} */ b) => isObj(b) && typeof b.id === 'string')
      .map((/** @type {any} */ b) => ({
        ...b,
        stages: (Array.isArray(b.stages) ? b.stages : [])
          .filter((/** @type {any} */ s) => isObj(s) && typeof s.id === 'string')
          .map((/** @type {any} */ s) => ({
            ...s,
            tasks: (Array.isArray(s.tasks) ? s.tasks : []).filter(
              (/** @type {any} */ t) => isObj(t) && typeof t.id === 'string' && t.type in TYPES
            ),
          })),
      }))
      .filter((/** @type {Build} */ b) => b.stages.length);
  }

  async function init() {
    store = loadStore();
    try {
      builds = parseGuide(await fetchJson('data/guide.json'));
    } catch (e) {
      el.list.innerHTML = '<p class="empty">לא הצלחתי לטעון את הנתונים. נסה לרענן את הדף.</p>';
      return;
    }
    if (!builds.length) {
      el.list.innerHTML = '<p class="empty">אין בילדים בקובץ הנתונים.</p>';
      return;
    }
    if (!builds.some((b) => b.id === store.activeBuild)) store.activeBuild = builds[0].id;
    saveStore();
    render();
  }

  init();
})();
