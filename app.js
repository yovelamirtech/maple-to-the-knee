// @ts-check
// Maple to the Knee: the app. Plain JS, no build. Structure adapted from arrow-to-the-knee.
(() => {
  'use strict';

  /**
   * @typedef {'job'|'quest'|'train'|'gear'|'ap'|'sp'|'pq'|'tip'} TaskType
   * @typedef {'one-handed'|'two-handed'} Variant
   * @typedef {{ exp?: number, mesos?: number, items?: string[] }} Rewards
   * @typedef {{
   *   id: string, type: TaskType, variant?: Variant|null, required?: boolean,
   *   priority?: 'high'|'medium'|'low', titleHe: string, titleEn?: string,
   *   summary?: string, why?: string, steps?: string[], npc?: string, route?: string[],
   *   maps?: string[], monsters?: string[], items?: string[], rewards?: Rewards,
   *   requirements?: { level?: number, str?: number, dex?: number },
   *   notes?: string[], sources?: string[], verified?: boolean, time?: PlayTime
   * }} Task
   * @typedef {{ min: number, max: number, overlap?: boolean }} PlayTime minutes of play; overlap = done while training
   * @typedef {{
   *   id: string, order: number, titleHe: string, levelFrom: number, levelTo: number,
   *   job: string, regionHe: string, goalHe: string, availability?: 'live'|'upcoming'|'not-in-game',
   *   time?: PlayTime, tasks: Task[]
   * }} Stage
   * @typedef {{ id: string, nameHe: string, nameEn: string, stages: Stage[], tips?: string[] }} Build
   * @typedef {{ id: string, nameEn: string, nameHe?: string, regionId?: string, levelRange?: string }} MapInfo
   * @typedef {{ id: string, nameEn: string, nameHe?: string, level: number, hp: number, exp: number, drops?: string[] }} MonsterInfo
   * @typedef {{ id: string, nameEn: string, nameHe?: string, mapId?: string }} NpcInfo
   * @typedef {{ id: string, nameEn: string, nameHe?: string, slot: string, weaponType?: string, reqLevel?: number,
   *   reqStr?: number, reqDex?: number, stats?: Record<string, number>, slots?: number, sources?: string[] }} ItemInfo
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
  const STAT_LABELS = { watk: 'W.ATK', matk: 'M.ATK', str: 'STR', dex: 'DEX', int: 'INT', luk: 'LUK', wdef: 'W.DEF', mdef: 'M.DEF', acc: 'ACC', avoid: 'Avoid', hp: 'HP', mp: 'MP' };

  const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_EXTERNAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

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
    openTimeline: byId('open-timeline'),
    viewBar: byId('view-bar'),
    stageHead: byId('stage-head'),
    banner: byId('banner'),
    list: byId('list'),
    sheet: /** @type {HTMLDialogElement} */ (byId('sheet')),
    sheetBody: byId('sheet-body'),
    toast: byId('toast'),
    toastText: byId('toast-text'),
    toastUndo: byId('toast-undo'),
  };

  const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const numFmt = new Intl.NumberFormat('en-US');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** @type {Build[]} */
  let builds = [];
  /** @type {{ maps: Record<string, MapInfo>, monsters: Record<string, MonsterInfo>, npcs: Record<string, NpcInfo>, items: Record<string, ItemInfo> }} */
  let world = { maps: {}, monsters: {}, npcs: {}, items: {} };
  /** @type {Store} */
  let store = emptyStore();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let toastTimer;
  /** @type {(() => void)|null} */
  let toastUndoFn = null;
  let doneOpen = false;
  /** @type {string|null} task id shown in the sheet, or TIMELINE */
  let sheetContent = null;
  let sheetHasHistory = false;
  /** @type {(() => void)|null} */
  let afterSheetClose = null;
  const TIMELINE = '#timeline';

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
  // A colon stays inside only when Latin text follows it ("Final Attack: Sword"), not before Hebrew ("Biggs: נשק").
  // A comma stays inside before a capitalised word ("Tree Dungeon, Forest Up North IV"), and so do <...> parts ("Line 1 <Area 1>").
  const LATIN_WORD = String.raw`(?:[A-Za-z0-9'’\->]|\.(?=[A-Za-z0-9])|[:,](?= <?[A-Z]))*`;
  const LATIN_RUN = new RegExp(String.raw`[A-Za-z]${LATIN_WORD}(?: +<?[A-Za-z0-9]${LATIN_WORD})*`, 'g');

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

  /** @param {number} n */
  function num(n) {
    return `<bdi dir="ltr">${escapeHtml(numFmt.format(n))}</bdi>`;
  }

  /** @param {number} minutes */
  function hoursText(minutes) {
    const h = Math.round((minutes / 60) * 2) / 2;
    return String(h);
  }

  /**
   * Play time as Hebrew text: "15–25 דק׳", "45 דק׳–1.5 שעות", "7–9 שעות".
   * @param {PlayTime|undefined} t
   */
  function timeText(t) {
    if (!t || !(t.max > 0)) return '';
    const min = Math.max(0, t.min || 0);
    const max = Math.max(min, t.max);
    if (max < 60) return min === max ? `${min} דק׳` : `${min}–${max} דק׳`;
    const b = hoursText(max);
    if (min < 60) return b === '1' ? `${min} דק׳–שעה` : `${min} דק׳–${b} שעות`;
    const a = hoursText(min);
    if (a === b) return a === '1' ? 'שעה' : `${a} שעות`;
    return `${a}–${b} שעות`;
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
   * The stage on screen: the one being viewed, or the current one.
   * @param {Build} build
   * @returns {Stage}
   */
  function shownStage(build) {
    const state = buildState(build.id);
    const viewed = build.stages.find((s) => s.id === state.viewStage);
    return viewed || currentStage(build);
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   * @param {number} step -1 for the previous stage, 1 for the next
   */
  function siblingStage(build, stage, step) {
    const stages = sortedStages(build);
    return stages[stages.indexOf(stage) + step] || null;
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

  /**
   * @param {Build} build
   * @param {string} taskId
   */
  function findTask(build, taskId) {
    for (const stage of build.stages) {
      const task = stage.tasks.find((t) => t.id === taskId);
      if (task) return { stage, task };
    }
    return null;
  }

  /** @param {string} id */
  function mapName(id) {
    const m = world.maps[id];
    return m ? m.nameEn : id;
  }

  /* ---------- Rendering ---------- */

  /** @param {Task} task */
  function badgesHtml(task) {
    const tag = tagOf(task);
    let html = `<span class="badge badge-${tag.cls}">${tag.label}</span>`;
    const lvl = task.requirements && task.requirements.level;
    if (lvl) html += `<span class="badge badge-level">רמה <bdi dir="ltr">${escapeHtml(lvl)}+</bdi></span>`;
    if (task.variant && VARIANTS[task.variant]) html += `<span class="badge badge-variant">${VARIANTS[task.variant]}</span>`;
    const time = timeText(task.time);
    if (time) html += `<span class="badge badge-time"><span aria-hidden="true">⏱</span> ${time}</span>`;
    return `<span class="badges">${html}</span>`;
  }

  /**
   * @param {Task} task
   * @param {boolean} large
   */
  function thumbHtml(task, large) {
    const icon = (TYPES[task.type] || { icon: '•' }).icon;
    return `<span class="thumb${large ? ' thumb-lg' : ''}"><span class="thumb-emoji" aria-hidden="true">${icon}</span></span>`;
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
    return `<li class="card" data-id="${escapeHtml(task.id)}">
      <button type="button" class="card-open" data-action="open" aria-haspopup="dialog">
        ${thumbHtml(task, false)}
        <span class="card-body">
          <span class="name-he">${richText(task.titleHe)}</span>
          ${task.titleEn ? `<span class="name-en" dir="ltr">${escapeHtml(task.titleEn)}</span>` : ''}
          ${meta}
        </span>
      </button>
      <button type="button" class="check" data-action="toggle" role="checkbox" aria-checked="${done}" aria-label="${escapeHtml(checkLabel)}">
        <span class="check-box">${ICON_CHECK}</span>
      </button>
    </li>`;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   */
  function renderViewBar(build, stage) {
    const current = currentStage(build);
    if (stage === current) {
      el.viewBar.innerHTML = '';
      return;
    }
    el.viewBar.innerHTML = `<div class="view-bar" role="status">
      <span class="view-bar-text">אתה צופה בשלב ${escapeHtml(stage.order)}</span>
      <span class="view-bar-actions">
        <button type="button" class="link-btn" data-action="back-to-current">חזרה לשלב הנוכחי</button>
        <button type="button" class="link-btn" data-action="make-current">הגדר כשלב נוכחי</button>
      </span>
    </div>`;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   */
  function renderStageHead(build, stage) {
    const p = stageProgress(build, stage);
    const pct = p.total ? (p.done / p.total) * 100 : 0;
    const prev = siblingStage(build, stage, -1);
    const next = siblingStage(build, stage, 1);
    // RTL: the right-hand arrow (first in the row) goes back.
    const arrow = (/** @type {Stage|null} */ s, /** @type {string} */ glyph, /** @type {string} */ label) =>
      s
        ? `<button type="button" class="stage-arrow" data-action="view-stage" data-stage="${escapeHtml(s.id)}" aria-label="${escapeHtml(`${label}: ${s.titleHe}`)}">${glyph}</button>`
        : `<span class="stage-arrow" aria-hidden="true"></span>`;
    el.stageHead.innerHTML = `
      <div class="stage-nav">
        ${arrow(prev, '›', 'לשלב הקודם')}
        <div class="stage-titles">
          <p class="stage-kicker">שלב ${escapeHtml(stage.order)} · ${levelsLabel(stage)} · ${richText(stage.regionHe)}</p>
          <h2 class="stage-title">${richText(stage.titleHe)}</h2>
        </div>
        ${arrow(next, '‹', 'לשלב הבא')}
      </div>
      <p class="stage-goal"><span class="stage-goal-label">🎯 מטרה:</span><span>${richText(stage.goalHe)}</span></p>
      ${timeText(stage.time) ? `<p class="stage-time"><span aria-hidden="true">⏱</span> בערך ${timeText(stage.time)} משחק למשימות החובה (הערכה)</p>` : ''}
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
    if (stage !== currentStage(build) || !p.total || p.done < p.total) {
      el.banner.innerHTML = '';
      return;
    }
    const next = siblingStage(build, stage, 1);
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
    const stage = shownStage(build);
    el.buildName.textContent = `${build.nameHe} · Classic World`;
    renderViewBar(build, stage);
    renderStageHead(build, stage);
    renderBanner(build, stage);
    renderList(build, stage);
    if (sheetContent === TIMELINE && el.sheet.open) el.sheetBody.innerHTML = timelineHtml(build);
  }

  /* ---------- Sheet: task details ---------- */

  /**
   * @param {string} title
   * @param {string} body
   */
  function section(title, body) {
    return body ? `<section class="sheet-section"><h3>${title}</h3>${body}</section>` : '';
  }

  /** @param {string[]|undefined} list */
  function listHtml(list, ordered = false) {
    if (!list || !list.length) return '';
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${list.map((s) => `<li>${richText(s)}</li>`).join('')}</${tag}>`;
  }

  /** @param {Task} task */
  function npcHtml(task) {
    if (!task.npc) return '';
    const npc = world.npcs[task.npc];
    if (!npc) return `<p><bdi>${escapeHtml(task.npc)}</bdi></p>`;
    const where = npc.mapId ? ` · ${richText(mapName(npc.mapId))}` : '';
    return `<p><strong><bdi>${escapeHtml(npc.nameEn)}</bdi></strong>${where}</p>`;
  }

  /** @param {Task} task */
  function routeHtml(task) {
    if (!task.route || !task.route.length) return '';
    return `<p class="route">${task.route.map((id) => `<span class="route-step"><bdi>${escapeHtml(mapName(id))}</bdi></span>`).join('<span class="route-sep" aria-hidden="true">←</span>')}</p>`;
  }

  /** @param {Task} task */
  function monstersHtml(task) {
    const list = (task.monsters || []).map((id) => world.monsters[id]).filter(Boolean);
    if (!list.length) return '';
    const rows = list
      .map((m) => `<tr>
        <th scope="row"><bdi>${escapeHtml(m.nameEn)}</bdi>${m.drops && m.drops.length ? `<span class="cell-sub"><bdi>${escapeHtml(m.drops.join(', '))}</bdi></span>` : ''}</th>
        <td>${num(m.level)}</td><td>${num(m.hp)}</td><td>${num(m.exp)}</td>
      </tr>`)
      .join('');
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th scope="col">מפלצת</th><th scope="col">רמה</th><th scope="col">HP</th><th scope="col">EXP</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  /** @param {Task} task */
  function itemsHtml(task) {
    const list = (task.items || []).map((id) => world.items[id]).filter(Boolean);
    if (!list.length) return '';
    return `<ul class="item-list">${list
      .map((it) => {
        const stats = Object.entries(it.stats || {})
          .map(([k, v]) => `${escapeHtml(STAT_LABELS[/** @type {keyof typeof STAT_LABELS} */ (k)] || k)} +${escapeHtml(v)}`)
          .join(', ');
        const req = [it.reqLevel ? `רמה ${escapeHtml(it.reqLevel)}` : '', it.reqStr ? `${escapeHtml(it.reqStr)} STR` : '', it.reqDex ? `${escapeHtml(it.reqDex)} DEX` : '']
          .filter(Boolean)
          .join(', ');
        return `<li><strong><bdi>${escapeHtml(it.nameEn)}</bdi></strong>${stats ? ` · <bdi dir="ltr">${stats}</bdi>` : ''}${req ? ` · ${req}` : ''}${
          it.sources && it.sources.length ? `<span class="cell-sub">${it.sources.map((s) => richText(s)).join(' · ')}</span>` : ''
        }</li>`;
      })
      .join('')}</ul>`;
  }

  /** @param {Task} task */
  function rewardsHtml(task) {
    const r = task.rewards;
    if (!r) return '';
    const parts = [];
    if (r.exp) parts.push(`${num(r.exp)} EXP`);
    if (r.mesos) parts.push(`${num(r.mesos)} מזו`);
    for (const it of r.items || []) parts.push(richText(it));
    return parts.length ? `<p>${parts.join(' · ')}</p>` : '';
  }

  /** @param {Task} task */
  function requirementsHtml(task) {
    const q = task.requirements || {};
    const parts = [];
    if (q.level) parts.push(`רמה ${escapeHtml(q.level)}`);
    if (q.str) parts.push(`${escapeHtml(q.str)} STR`);
    if (q.dex) parts.push(`${escapeHtml(q.dex)} DEX`);
    return parts.length ? `<p>${parts.join(' · ')}</p>` : '';
  }

  /** @param {Task} task */
  function playTimeHtml(task) {
    const text = timeText(task.time);
    if (!text) return '';
    const overlap = task.time && task.time.overlap ? ' ברובו תוך כדי אימון, אז לא מוסיפים אותו לזמן של השלב.' : '';
    return `<p>${text}.${overlap}</p><p class="cell-sub">הערכה גסה לפי טבלת ה-EXP ודיווחי קהילה, לא מדידה.</p>`;
  }

  /** @param {Task} task */
  function sourcesHtml(task) {
    const list = task.sources || [];
    if (!list.length) return '';
    return `<ul class="source-list">${list
      .map((url) => {
        let label = url;
        try {
          const u = new URL(url);
          label = u.hostname.replace(/^www\./, '') + decodeURIComponent(u.pathname).replace(/^\/(wiki|guides)\//, ' · ').replace(/_/g, ' ');
        } catch (e) {
          /* not a URL: show as is */
        }
        return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><bdi>${escapeHtml(label)}</bdi>${ICON_EXTERNAL}</a></li>`;
      })
      .join('')}</ul>`;
  }

  /**
   * @param {Build} build
   * @param {Stage} stage
   * @param {Task} task
   */
  function detailsHtml(build, stage, task) {
    const done = isDone(build, task.id);
    return `
      <div class="sheet-head">
        <span class="sheet-grip" aria-hidden="true"></span>
        <button type="button" class="sheet-close" data-action="close" aria-label="סגירה">${ICON_CLOSE}</button>
      </div>
      <div class="sheet-content">
        <div class="sheet-hero">
          ${thumbHtml(task, true)}
          <div>
            <h2 id="sheet-title">${richText(task.titleHe)}</h2>
            ${task.titleEn ? `<span class="name-en" dir="ltr">${escapeHtml(task.titleEn)}</span>` : ''}
            ${badgesHtml(task)}
            <span class="hero-meta">שלב ${escapeHtml(stage.order)} · ${richText(stage.titleHe)}${task.verified ? '' : ' · <span class="unverified">⚠ עוד לא אומת</span>'}</span>
          </div>
        </div>
        ${section('מה זה', task.summary ? `<p>${richText(task.summary)}</p>` : '')}
        ${section('למה זה מקדם אותך', task.why ? `<p>${richText(task.why)}</p>` : '')}
        ${section('צעדים', listHtml(task.steps, true))}
        ${section('NPC', npcHtml(task))}
        ${section('איך מגיעים', routeHtml(task))}
        ${section('מפלצות', monstersHtml(task))}
        ${section('ציוד', itemsHtml(task))}
        ${section('פרס', rewardsHtml(task))}
        ${section('דרישות', requirementsHtml(task))}
        ${section('זמן משחק משוער', playTimeHtml(task))}
        ${section('הערות', listHtml(task.notes))}
        ${section('מקורות', sourcesHtml(task))}
      </div>
      <div class="sheet-actions">
        <button type="button" class="toggle-btn" data-action="toggle" aria-pressed="${done}">
          <span class="check-box">${ICON_CHECK}</span>
          <span>${done ? 'בוצע · להחזיר לרשימה' : 'סימון כבוצע'}</span>
        </button>
      </div>`;
  }

  /* ---------- Sheet: stage timeline ---------- */

  /** @param {Build} build */
  function timelineHtml(build) {
    const state = buildState(build.id);
    const current = currentStage(build);
    const shown = shownStage(build);
    const rows = sortedStages(build)
      .map((s) => {
        const status = s === current ? 'current' : state.stagesCompleted[s.id] ? 'done' : 'future';
        const mark = { current: '●', done: '✔', future: '○' }[status];
        const statusLabel = { current: 'השלב הנוכחי', done: 'הושלם', future: 'עתידי' }[status];
        const p = stageProgress(build, s);
        const count = p.total ? `${p.done}/${p.total}` : 'בכתיבה';
        return `<li>
          <button type="button" class="timeline-row is-${status}${s === shown ? ' is-shown' : ''}" data-action="view-stage" data-stage="${escapeHtml(s.id)}">
            <span class="timeline-mark" aria-hidden="true">${mark}</span>
            <span class="timeline-body">
              <span class="timeline-title">${escapeHtml(s.order)}. ${richText(s.titleHe)}</span>
              <span class="timeline-meta">${levelsLabel(s)} · ${richText(s.regionHe)}${timeText(s.time) ? ` · ⏱ ${timeText(s.time)}` : ''}</span>
            </span>
            <span class="timeline-count"><span class="visually-hidden">${statusLabel}, </span>${count}</span>
          </button>
        </li>`;
      })
      .join('');
    return `
      <div class="sheet-head">
        <span class="sheet-grip" aria-hidden="true"></span>
        <button type="button" class="sheet-close" data-action="close" aria-label="סגירה">${ICON_CLOSE}</button>
      </div>
      <div class="sheet-content">
        <h2 id="sheet-title" class="sheet-heading">כל השלבים</h2>
        <ol class="timeline">${rows}</ol>
      </div>`;
  }

  /* ---------- Sheet open/close (history-aware, from arrow-to-the-knee) ---------- */

  /**
   * @param {string} content task id or TIMELINE
   * @param {string} html
   */
  function openSheet(content, html) {
    sheetContent = content;
    el.sheetBody.innerHTML = html;
    el.sheetBody.scrollTop = 0;
    if (el.sheet.open) return;
    el.sheet.showModal();
    document.body.classList.add('sheet-open');
    history.pushState({ sheet: content }, '');
    sheetHasHistory = true;
    requestAnimationFrame(() => requestAnimationFrame(() => el.sheet.classList.add('is-open')));
  }

  /** @param {string} taskId */
  function openDetails(taskId) {
    const build = activeBuild();
    const found = findTask(build, taskId);
    if (found) openSheet(taskId, detailsHtml(build, found.stage, found.task));
  }

  function openTimeline() {
    openSheet(TIMELINE, timelineHtml(activeBuild()));
  }

  function requestCloseSheet() {
    if (!el.sheet.open) return;
    if (sheetHasHistory) {
      sheetHasHistory = false;
      history.back();
    } else {
      closeSheetNow();
    }
  }

  function closeSheetNow() {
    if (!el.sheet.open) return;
    el.sheet.classList.remove('is-open');
    const finish = () => {
      if (el.sheet.open) el.sheet.close();
      onSheetClosed();
    };
    if (reducedMotion.matches) finish();
    else setTimeout(finish, 210);
  }

  // Runs once per close, whether we closed the dialog or the browser did.
  function onSheetClosed() {
    if (!sheetContent) return;
    el.sheet.classList.remove('is-open');
    document.body.classList.remove('sheet-open');
    sheetContent = null;
    // The dialog can close natively (e.g. a forced Escape); drop our history entry too.
    if (sheetHasHistory) {
      sheetHasHistory = false;
      history.back();
    }
    const cb = afterSheetClose;
    afterSheetClose = null;
    if (cb) cb();
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

  /** @param {string} stageId */
  function viewStage(stageId) {
    const build = activeBuild();
    if (!build.stages.some((s) => s.id === stageId)) return;
    const state = buildState(build.id);
    state.viewStage = stageId === currentStage(build).id ? null : stageId;
    saveStore();
    doneOpen = false;
    hideToast();
    render();
    window.scrollTo({ top: 0 });
  }

  function makeShownCurrent() {
    const build = activeBuild();
    const state = buildState(build.id);
    const stage = shownStage(build);
    state.currentStage = stage.id;
    state.viewStage = null;
    saveStore();
    render();
  }

  function goToNextStage() {
    const build = activeBuild();
    const stage = currentStage(build);
    const next = siblingStage(build, stage, 1);
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

  /**
   * @param {Event} e
   * @returns {HTMLElement|null}
   */
  function actionTarget(e) {
    const t = e.target;
    const btn = t instanceof Element ? t.closest('[data-action]') : null;
    return btn instanceof HTMLElement ? btn : null;
  }

  el.list.addEventListener('click', (e) => {
    const btn = actionTarget(e);
    if (!btn) return;
    const card = btn.closest('.card');
    if (!(card instanceof HTMLElement) || !card.dataset.id) return;
    if (btn.dataset.action === 'toggle') toggleTask(card.dataset.id);
    else if (btn.dataset.action === 'open') openDetails(card.dataset.id);
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
    const btn = actionTarget(e);
    if (btn && btn.dataset.action === 'next-stage') goToNextStage();
  });

  el.stageHead.addEventListener('click', (e) => {
    const btn = actionTarget(e);
    if (btn && btn.dataset.action === 'view-stage' && btn.dataset.stage) viewStage(btn.dataset.stage);
  });

  el.viewBar.addEventListener('click', (e) => {
    const btn = actionTarget(e);
    if (!btn) return;
    if (btn.dataset.action === 'back-to-current') viewStage(currentStage(activeBuild()).id);
    else if (btn.dataset.action === 'make-current') makeShownCurrent();
  });

  el.openTimeline.addEventListener('click', openTimeline);

  el.sheet.addEventListener('close', onSheetClosed);

  el.sheet.addEventListener('cancel', (e) => {
    e.preventDefault();
    requestCloseSheet();
  });

  el.sheet.addEventListener('click', (e) => {
    if (e.target === el.sheet) {
      requestCloseSheet();
      return;
    }
    const btn = actionTarget(e);
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'close') requestCloseSheet();
    else if (action === 'toggle' && sheetContent && sheetContent !== TIMELINE) {
      const id = sheetContent;
      afterSheetClose = () => toggleTask(id);
      requestCloseSheet();
    } else if (action === 'view-stage' && btn.dataset.stage) {
      const id = btn.dataset.stage;
      afterSheetClose = () => viewStage(id);
      requestCloseSheet();
    }
  });

  window.addEventListener('popstate', () => {
    sheetHasHistory = false;
    if (el.sheet.open) closeSheetNow();
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
   * @template T
   * @param {any} list
   * @returns {Record<string, T>}
   */
  function indexById(list) {
    /** @type {Record<string, T>} */
    const out = {};
    if (Array.isArray(list)) for (const x of list) if (isObj(x) && typeof x.id === 'string') out[x.id] = x;
    return out;
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
    // A reload while the sheet was open leaves a stale history entry.
    if (history.state && history.state.sheet) history.replaceState(null, '');
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
    // Maps, monsters, NPCs and items are optional: without them the details sheet skips those parts.
    const [maps, monsters, npcs, items] = await Promise.all(
      ['maps', 'monsters', 'npcs', 'items'].map((n) => fetchJson(`data/${n}.json`).catch(() => null))
    );
    world = { maps: indexById(maps), monsters: indexById(monsters), npcs: indexById(npcs), items: indexById(items) };
    if (!builds.some((b) => b.id === store.activeBuild)) store.activeBuild = builds[0].id;
    // The app always opens on the current stage.
    for (const b of builds) buildState(b.id).viewStage = null;
    saveStore();
    render();
  }

  init();
})();
