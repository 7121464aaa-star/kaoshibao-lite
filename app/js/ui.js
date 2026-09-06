/* ui.js —— 主控制器（M3）：Tab 路由、练习源(全部/错题重练/收藏)、题型过滤、章节筛选、
   顺序/随机、即时判分、答题卡(待判配色)、统计、错题本(当前库/全库)、收藏页签、练习历史落库。
   挂接 bank-mgmt.js / importer.js / exam.js / stats.js / search.js / backup.js；
   暴露 KSB.uiHooks / KSB.notifyBankDataChanged / KSB.refreshWrongAll / KSB.toast */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  KSB.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* 动效重放：移除→强制重排→添加，保证同一节点也能重播 CSS 动画（M7） */
  KSB.fxPlay = function (el, cls) {
    if (!el || !el.classList) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  /* 轻提示 */
  let toastTimer = null;
  KSB.toast = function (msg, type) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  };

  const JUDGE_OPTIONS = [
    { val: true, label: '正确' },
    { val: false, label: '错误' }
  ];
  const SOURCE_LABEL = { all: '本库全部', wrong: '错题重练', star: '我的收藏' };
  const SUPPORTED_TYPES = new Set(['single', 'multiple', 'judge', 'fill']);

  const session = {
    bankId: null,
    bank: null,
    questions: [],      // 展示顺序（已按 题型/章节/练习源 过滤）
    source: 'all',
    excluded: new Set(), // 被排除的题型（空 = 全部题型都练）
    chapter: '',        // '' = 全部章节；否则为章节名
    mode: 'seq',
    idx: 0,
    answers: new Map(), // qid -> { user, userText, state, expected, detail }
    drafts: new Map(),  // qid -> 草稿（多选勾选/填空输入未提交判分 → 答题卡"待判"）
    startedAt: null,
    committed: true,
    touched: 0         // M10：本轮实际作答次数（筛选内保留痕迹时，防止"全从旧痕迹继承"也被当成新完成一轮）
  };

  const wrongCache = new Map();
  const wrongScope = { cur: 'bank' };   // 错题本视图范围 'bank' | 'all'
  const starScope = { cur: 'all' };     // 收藏页签范围 'bank' | 'all'
  let lastQid = null;                   // M7：上一道渲染的题目 id（用于切换题目时播放入场动画）

  /* M8：答对自动下一题 定时器 + 本机偏好（主题/自动下一题，存 settings，见设置页）
     M9：新增「模式」维度（日光=浅色底 / 月光=深色底，正交于配色）+ 两种模式的「背景深浅」档位（1柔和/2标准/3明亮、1柔灰/2标准/3近黑） */
  let autoNextTimer = null;
  /* M11：prefs 增 showAnswer —— 背题模式（一直显示答案，免作答；默认关，settings 键 showAnswer） */
  const prefs = { theme: 'default', mode: 'sun', autoNext: true, shadeSun: '2', shadeMoon: '2', showAnswer: false };
  const THEME_COLORS = { default: '#2563eb', green: '#15803d', paper: '#b45309' };
  const THEME_NAMES = { default: '默认青蓝', green: '护眼绿', paper: '暖米纸张' };
  const MODE_NAMES = { sun: '日光', moon: '月光' };
  const SHADE_LABEL = {
    sun:  { '1': '柔和', '2': '标准', '3': '明亮' },
    moon: { '1': '柔灰', '2': '标准', '3': '近黑' }
  };
  /* meta theme-color（手机浏览器顶栏/任务卡配色）：日光沿用配色主色，月光用对应深色背景 */
  const META_COLORS = {
    sun:  THEME_COLORS,
    moon: { default: '#0f1a2b', green: '#0d1711', paper: '#191109' }
  };
  const AUTO_NEXT_DELAY = 600;          // 答对后自动跳下一题的延迟（毫秒）

  /* ============ 供其它模块调用 ============ */
  KSB.uiHooks = {};
  /* 外部（如模拟考试交卷）新增错题后调用，刷新本模块错题缓存 */
  KSB.refreshWrongAll = async function () {
    await refreshWrongCache();
    await refreshSourceChips();
    if (!$('#view-wrong').classList.contains('hidden')) renderWrong();
  };
  KSB.notifyBankDataChanged = async function (preferBankId) {
    const banks = await KSB.storeGetAll('banks');
    const sel = $('#bankSelect');
    if (!sel) return;
    sel.innerHTML = '';
    banks.forEach(b => {
      const o = document.createElement('option');
      o.value = b.id; o.textContent = b.name;
      sel.appendChild(o);
    });
    let target = preferBankId || session.bankId;
    if (target && !banks.some(b => b.id === target)) target = null;
    if (!target && banks.length) target = banks[0].id;
    if (target) {
      sel.value = target;
      if (target !== session.bankId) await startSession(target);
    } else if (!banks.length) {
      await commitHistory();
      session.bankId = null; session.bank = null; session.questions = []; session.source = 'all';
      session.chapter = '';
      session.answers.clear(); session.drafts.clear();
      $('#qMeta').textContent = '（暂无题库，请先导入）';
      renderSheet(); refreshStats(); renderChapterChips();
    }
    await refreshWrongCache();
    await refreshSourceChips();
  };

  /* ============ 初始化 ============ */
  async function init() {
    await KSB.ready;
    const bankId = await KSB.seedSample();
    await bindEvents();
    await KSB.notifyBankDataChanged(bankId);
    await loadPrefs();
    showTab('practice');
  }

  /* M8+M9+M11：读取并应用本机偏好（配色主题 + 模式(日光/月光) + 两种模式的背景深浅档位 + 答对自动下一题开关 + 背题模式开关） */
  async function loadPrefs() {
    try {
      const t = await KSB.getSetting('theme');
      if (t && THEME_COLORS[t]) prefs.theme = t;
      const m = await KSB.getSetting('mode');
      if (m === 'sun' || m === 'moon') prefs.mode = m;
      const ss = await KSB.getSetting('shadeSun');
      if (ss && SHADE_LABEL.sun[ss]) prefs.shadeSun = ss;
      const sm = await KSB.getSetting('shadeMoon');
      if (sm && SHADE_LABEL.moon[sm]) prefs.shadeMoon = sm;
      const an = await KSB.getSetting('autoNext');
      prefs.autoNext = an !== false;     // 默认开启
      const sa = await KSB.getSetting('showAnswer');
      prefs.showAnswer = sa === true;    // 默认关闭
    } catch (e) { /* 读取失败保持默认 */ }
    applyAppearance();
    syncPrefControls();
    syncFilterSummary();   // M11：首屏进入时若背题模式开着，摘要带上"背题"状态
  }

  /* M9：把 配色(theme) × 模式(mode) × 背景档位(shade) 落到 <html> 属性上，CSS 依此出整套外观；
     data-theme 决定色系，data-mode="moon" 决定深色底，data-shade 决定该模式下的背景深浅档位 */
  function applyAppearance() {
    const el = document.documentElement;
    el.dataset.theme = prefs.theme;
    el.dataset.mode = prefs.mode;
    el.dataset.shade = prefs.mode === 'moon' ? prefs.shadeMoon : prefs.shadeSun;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      // M10：月光档位（近黑/柔灰/标准）直接影响手机浏览器顶栏/任务卡颜色 → 点档位手机观感立刻变化；
      // 日光沿用各配色品牌色（观感同 M8/M9，不做改变）。
      const fallback = (META_COLORS[prefs.mode] || META_COLORS.sun)[prefs.theme] || '#2563eb';
      meta.content = prefs.mode === 'moon' ? (getEffectiveBg() || fallback) : fallback;
    }
  }
  /* 读当前生效页面底色：body 的 background 末层为 var(--bg)，其 backgroundColor 已解析成 rgb 色值；
     （自定义属性 --bg 的 getPropertyValue 在未注册属性下返回未替换的 var() 文本，不可直接给 meta 用） */
  function getEffectiveBg() {
    try {
      const cs = getComputedStyle(document.body);
      const c = cs.backgroundColor;
      if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
      return getComputedStyle(document.documentElement).backgroundColor || null;
    } catch (e) { return null; }
  }

  async function pickTheme(name) {
    if (!THEME_COLORS[name]) return;
    prefs.theme = name;
    applyAppearance();
    syncPrefControls();
    KSB.toast('已切换为「' + (THEME_NAMES[name] || name) + '」配色', 'ok');
    try { await KSB.setSetting('theme', name); } catch (e) { /* 持久化失败不影响本次 */ }
  }

  async function pickMode(mode) {
    if (mode !== 'sun' && mode !== 'moon') return;
    prefs.mode = mode;
    applyAppearance();
    syncPrefControls();
    KSB.toast('已切换到「' + MODE_NAMES[mode] + '」模式' +
      (mode === 'moon' ? '（深色底，适合天暗/夜间）' : '（浅色底，适合天亮/白天）'), 'ok');
    try { await KSB.setSetting('mode', mode); } catch (e) { /* 同上 */ }
  }

  async function pickShade(mode, val) {
    if (!SHADE_LABEL[mode] || !SHADE_LABEL[mode][val]) return;
    if (mode === 'sun') prefs.shadeSun = val; else prefs.shadeMoon = val;
    // M10：点「非当前模式」那组档位时，直接切到该模式再应用 → 手机上点档位必有可见效果（不再像"没反应"）
    if (prefs.mode !== mode) {
      prefs.mode = mode;
      try { await KSB.setSetting('mode', mode); } catch (e) { /* 同上 */ }
    }
    applyAppearance();
    syncPrefControls();
    KSB.toast('已设置' + MODE_NAMES[mode] + '背景：' + SHADE_LABEL[mode][val], '');
    try {
      await KSB.setSetting(mode === 'sun' ? 'shadeSun' : 'shadeMoon', val);
    } catch (e) { /* 同上 */ }
  }

  async function setAutoNextPref(on) {
    prefs.autoNext = !!on;
    KSB.toast(on ? '答对将自动跳下一题' : '已关闭自动下一题（答对停留）', '');
    try { await KSB.setSetting('autoNext', prefs.autoNext); } catch (e) { /* 同上 */ }
  }

  /* M11：背题模式（一直显示答案）——开/关即时生效并持久化。
     开启后每题不用作答，直接标绿正确选项/填入填空答案，并在下方显示 正确答案+解析；翻题也一直显示。 */
  async function setShowAnswerPref(on) {
    prefs.showAnswer = !!on;
    syncPrefControls();
    syncFilterSummary();
    renderQuestion();      // 当前题立即按新模式显示/隐藏答案
    KSB.toast(on ? '背题模式已开：每题直接显示正确答案与解析，翻题一直显示' : '已关闭背题模式（恢复正常作答判分）', on ? 'ok' : '');
    try { await KSB.setSetting('showAnswer', prefs.showAnswer); } catch (e) { /* 同上 */ }
  }

  function syncPrefControls() {
    $$('#themeSwatches .theme-swatch').forEach(b => {
      const on = b.dataset.theme === prefs.theme;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $$('#modeGroup .mode-btn').forEach(b => {
      const on = b.dataset.mode === prefs.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    ['sun', 'moon'].forEach(m => {
      const cur = m === 'sun' ? prefs.shadeSun : prefs.shadeMoon;
      $$('.shade-seg[data-for="' + m + '"] .shade-btn').forEach(b => {
        const on = b.dataset.shade === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
    const cb = $('#optAutoNext');
    if (cb) cb.checked = !!prefs.autoNext;
    // M11：背题模式开关（设置页复选框 + 刷题页工具条按钮同源同步）
    const cbAns = $('#optShowAnswer');
    if (cbAns) cbAns.checked = !!prefs.showAnswer;
    const ab = $('#btnAnsToggle');
    if (ab) {
      ab.classList.toggle('active', !!prefs.showAnswer);
      ab.setAttribute('aria-pressed', prefs.showAnswer ? 'true' : 'false');
      ab.textContent = prefs.showAnswer ? '👁 答案·开' : '👁 答案';
    }
  }

  /* M8：刷题页一行入口 —— 筛选面板开合 */
  function setFilterPanel(open) {
    const p = $('#filterPanel'), b = $('#btnFilterToggle');
    if (!p || !b) return;
    p.hidden = !open;
    b.classList.toggle('active', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* M8：答题卡整块开合（默认收起，节省垂直空间） */
  function setSheet(open, opts) {
    const w = $('#sheetWrap'), b = $('#btnSheetToggle');
    if (!w || !b) return;
    w.hidden = !open;
    b.classList.toggle('active', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && opts && opts.scroll) {
      requestAnimationFrame(() => { w.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    }
  }

  /* M8：切题后自动回到题目顶部（视口停在题目卡上沿附近，无需手动上拉） */
  function scrollToQuestion() {
    const card = $('#view-practice .question-card');
    if (!card) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const tb = document.querySelector('.topbar');
    const headH = tb ? tb.offsetHeight + 12 : 12;   // 吸顶顶栏之下留一点白
    const r = card.getBoundingClientRect();
    if (r.top < headH - 2) {
      // 题目上沿已在视口上方/被顶栏遮住 → 上拉回题目开头
      window.scrollBy({ top: r.top - headH, behavior: 'smooth' });
    } else if (r.top > document.documentElement.clientHeight * 0.55) {
      // 题目卡整体在视口下半部 → 下移让题目从顶部开始看
      window.scrollBy({ top: r.top - headH, behavior: 'smooth' });
    }
    // 其它情况题目已在上部可读区，不打扰
  }

  /* M8：答对自动下一题 —— 在 answerSheet 判对后调度一次延时跳题；
     用户手动换题/切会话会把旧定时器取消，定时器触发时也会复核条件 */
  function maybeAutoNext() {
    if (!prefs.autoNext) return;
    const q = cur();
    const a = q && session.answers.get(q.id);
    if (!q || !a || a.state !== 'correct') return;
    if (session.idx + 1 >= session.questions.length) return;   // 最后一题：停留展示完成提示
    cancelAutoNext();
    const fromIdx = session.idx;
    autoNextTimer = setTimeout(() => {
      autoNextTimer = null;
      if (!prefs.autoNext || session.idx !== fromIdx) return;
      const c = cur();
      const ac = c && session.answers.get(c.id);
      if (c && ac && ac.state === 'correct' && session.idx + 1 < session.questions.length) {
        goto(session.idx + 1);
      }
    }, AUTO_NEXT_DELAY);
  }

  function cancelAutoNext() {
    if (autoNextTimer != null) { clearTimeout(autoNextTimer); autoNextTimer = null; }
  }

  function bindEvents() {
    $('#bankSelect').addEventListener('change', e => startSession(e.target.value));
    $('#btnReset').addEventListener('click', () => {
      if ((session.answers.size || session.drafts.size) && !confirm('重新开始本套练习（清空当前作答记录）？')) return;
      startSession(session.bankId, { keepMode: true, source: session.source });
    });
    $('#btnPrev').addEventListener('click', () => goto(session.idx - 1));
    $('#btnNext').addEventListener('click', () => goto(session.idx + 1));
    $('#btnStar').addEventListener('click', async () => {
      const q = cur();
      if (!q) return;
      const starred = await KSB.starToggle(q);
      await syncStarUI(q, starred);
      await refreshSourceChips();
      refreshStarsIfVisible();
      KSB.toast(starred ? '已收藏 ★' : '已取消收藏', starred ? 'ok' : '');
    });
    $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    $('#qOptions').addEventListener('click', onOptionsClick);
    $('#qOptions').addEventListener('change', onDraftChange);
    $('#qOptions').addEventListener('input', onDraftInput);

    // 练习源（M10：切换不再清空当前作答痕迹、不再弹确认；统计/答题卡只按当前筛选内题目计）
    $$('#view-practice .chip[data-src]').forEach(c => c.addEventListener('click', () => switchSource(c.dataset.src)));
    // 题型过滤
    $$('#view-practice .chip[data-ftype]').forEach(c => c.addEventListener('click', () => {
      const t = c.dataset.ftype;
      if (!session.excluded.has(t) && session.excluded.size >= 3) { KSB.toast('至少保留一种题型', 'bad'); return; }
      if (session.excluded.has(t)) session.excluded.delete(t); else session.excluded.add(t);
      startSession(session.bankId, { keepMode: true, source: session.source, keepTraces: true });
    }));
    // 章节筛选
    $('#chapterChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-chapter]');
      if (!chip) return;
      const ch = chip.dataset.chapter;
      if (ch === session.chapter) return;
      session.chapter = ch;
      startSession(session.bankId, { keepMode: true, source: session.source, keepTraces: true });
    });
    // 模式
    $$('#view-practice .chip[data-mode]').forEach(c => c.addEventListener('click', () => {
      const mode = c.dataset.mode;
      if (mode === session.mode) return;
      session.mode = mode;
      startSession(session.bankId, { keepMode: true, source: session.source, keepTraces: true });
    }));

    // 错题本范围 chips
    $$('#view-wrong .chip[data-wscope]').forEach(c => c.addEventListener('click', () => {
      wrongScope.cur = c.dataset.wscope;
      $$('#view-wrong .chip[data-wscope]').forEach(x => x.classList.toggle('active', x === c));
      renderWrong();
    }));
    // 收藏页签范围 chips
    $$('#view-stars .chip[data-sscope]').forEach(c => c.addEventListener('click', () => {
      starScope.cur = c.dataset.sscope;
      $$('#view-stars .chip[data-sscope]').forEach(x => x.classList.toggle('active', x === c));
      renderStars();
    }));

    // 错题本工具
    $('#btnWrongPractice').addEventListener('click', () => {
      const has = wrongCache.size && Array.from(wrongCache.values()).some(w => w.bankId === session.bankId);
      if (!has) { KSB.toast('本库暂无错题', 'bad'); return; }
      startSession(session.bankId, { keepMode: true, source: 'wrong' });
      showTab('practice');
    });
    $('#btnWrongClear').addEventListener('click', async () => {
      const all = wrongScope.cur === 'all';
      const has = all ? wrongCache.size
        : Array.from(wrongCache.values()).some(w => w.bankId === session.bankId);
      if (!has) { KSB.toast(all ? '全库暂无错题' : '本库暂无错题', 'bad'); return; }
      const msg = all ? '确定把全部题库的错题都标记为已掌握并移除？' : '确定把本库全部错题标记为已掌握并移除？';
      if (!confirm(msg)) return;
      if (all) {
        const t = KSB.db.transaction('wrong', 'readwrite');
        const s = t.objectStore('wrong');
        wrongCache.forEach(w => s.delete(w.qid));
        await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      } else {
        await KSB.wrongRemoveAllOfBank(session.bankId);
      }
      await refreshWrongCache();
      await refreshSourceChips();
      renderWrong();
      KSB.toast(all ? '已移除全部错题' : '已移除本库全部错题', 'ok');
    });
    $('#wrongList').addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'wrong-mastered') {
        await KSB.wrongRemove(btn.dataset.qid);
        await refreshWrongCache();
        await refreshSourceChips();
        renderWrong();
      } else if (btn.dataset.act === 'wrong-bank-practice') {
        const bid = btn.dataset.bank;
        if (!wrongCache.size || !Array.from(wrongCache.values()).some(w => w.bankId === bid)) {
          KSB.toast('该库暂无错题', 'bad'); return;
        }
        await startSession(bid, { keepMode: true, source: 'wrong' });
        showTab('practice');
      } else if (btn.dataset.act === 'wrong-bank-clear') {
        const bid = btn.dataset.bank;
        if (!confirm('确定把该库全部错题标记为已掌握并移除？')) return;
        await KSB.wrongRemoveAllOfBank(bid);
        await refreshWrongCache();
        await refreshSourceChips();
        renderWrong();
      } else if (btn.dataset.act === 'q-practice') {
        const bid = btn.dataset.bank;
        if (!bid) { KSB.toast('该题所属题库不存在', 'bad'); return; }
        await practiceQuestion(bid, btn.dataset.qid, 'all');
      }
    });
    // 收藏页签列表动作
    $('#starList').addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const qid = btn.dataset.qid;
      if (btn.dataset.act === 'star-remove') {
        await KSB.storeDel('stars', qid);
        await refreshSourceChips();
        renderStars();
        KSB.toast('已取消收藏', '');
      } else if (btn.dataset.act === 'star-practice') {
        const q = await KSB.storeGet('questions', qid);
        if (!q) { KSB.toast('题目不存在', 'bad'); return; }
        await practiceQuestion(q.bankId, qid, 'star');
      }
    });

    // 供其它模块：从题库管理"刷题"进入 / 收藏入口等
    KSB.uiHooks.practiceBank = async function (id) {
      const sel = $('#bankSelect');
      if (sel && Array.from(sel.options).some(o => o.value === id)) sel.value = id;
      await startSession(id);
      showTab('practice');
    };

    // M8：刷题页一行入口 —— 筛选面板 / 答题卡 开合
    $('#btnFilterToggle').addEventListener('click', () => setFilterPanel($('#filterPanel').hidden));
    $('#btnFilterClose').addEventListener('click', () => setFilterPanel(false));
    $('#btnSheetToggle').addEventListener('click', () => setSheet(true, { scroll: true }));
    $('#btnSheetClose').addEventListener('click', () => setSheet(false));

    // M8：外观与刷题习惯（设置页）
    $$('#themeSwatches .theme-swatch').forEach(b => b.addEventListener('click', () => pickTheme(b.dataset.theme)));
    // M9：模式（日光/月光）与两种模式的背景深浅档位
    $$('#modeGroup .mode-btn').forEach(b => b.addEventListener('click', () => pickMode(b.dataset.mode)));
    $$('.shade-seg .shade-btn').forEach(b => {
      b.addEventListener('click', () => pickShade(b.closest('.shade-seg').dataset.for, b.dataset.shade));
    });
    $('#optAutoNext').addEventListener('change', e => setAutoNextPref(e.target.checked));
    // M11：背题模式开关（刷题页工具条按钮 + 设置页复选框）
    $('#optShowAnswer').addEventListener('change', e => setShowAnswerPref(e.target.checked));
    $('#btnAnsToggle').addEventListener('click', () => setShowAnswerPref(!prefs.showAnswer));
  }

  /* 练习某题库中的指定题目：切库 → 定位该题（source 过滤可选，如 star） */
  async function practiceQuestion(bankId, qid, source) {
    const sel = $('#bankSelect');
    if (sel && Array.from(sel.options).some(o => o.value === bankId)) sel.value = bankId;
    await startSession(bankId, { keepMode: true, source: source || 'all' });
    const idx = session.questions.findIndex(q => q.id === qid);
    if (idx >= 0) {
      goto(idx);
      showTab('practice');
      return true;
    }
    KSB.toast('未能在该筛选下定位到题目（可能被题型/章节/练习源过滤）', 'bad');
    showTab('practice');
    return false;
  }
  KSB.uiHooks.practiceQuestion = practiceQuestion;

  /* ============ 会话 ============ */
  async function switchSource(source) {
    if (source === session.source) return;
    if (source === 'wrong') {
      const has = Array.from(wrongCache.values()).some(w => w.bankId === session.bankId);
      if (!has) { KSB.toast('本库暂无错题', 'bad'); return; }
    }
    if (source === 'star') {
      const qids = await KSB.getStarQids(session.bankId);
      if (!qids.length) { KSB.toast('本库暂无收藏题目（答题页点 ☆ 收藏）', 'bad'); return; }
    }
    // M10：切换练习源不清空当前作答痕迹、不弹确认；统计/答题卡只按当前筛选内题目计
    await startSession(session.bankId, { keepMode: true, source, keepTraces: true });
  }

  async function startSession(bankId, opts) {
    cancelAutoNext();   // M8：会话重建时取消待触发的自动下一题
    const keepMode = opts && opts.keepMode;
    const source = (opts && opts.source) || 'all';
    const bankChanged = bankId !== session.bankId;
    const keepTraces = !!(opts && opts.keepTraces) && !bankChanged;
    if (!keepTraces) await commitHistory();   // 换库/重新开始：先落当前一轮历史再清空；筛选内切换(keepTraces)不落历史、保留痕迹
    const bank = await KSB.storeGet('banks', bankId);
    let questions = bankId ? await KSB.getBankQuestions(bankId) : [];
    questions.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    questions = questions.filter(q => SUPPORTED_TYPES.has(q.type)); // 轻量版仅支持 单选/多选/判断/填空
    if (session.excluded.size) questions = questions.filter(q => !session.excluded.has(q.type)); // 题型过滤

    // 章节筛选（chips 基于题型过滤后的本库全集；换库重置章节）
    if (bankChanged) session.chapter = '';
    const chapters = chaptersOf(questions);
    if (session.chapter && !chapters.includes(session.chapter)) session.chapter = '';
    if (session.chapter) questions = questions.filter(q => (q.chapter || '') === session.chapter);

    if (source === 'wrong') {
      const items = Array.from(wrongCache.values())
        .filter(w => w.bankId === bankId)
        .sort((a, b) => (b.lastWrongAt || '').localeCompare(a.lastWrongAt || ''));
      const qmap = new Map(questions.map(q => [q.id, q]));
      questions = items.map(w => qmap.get(w.qid)).filter(Boolean);
    } else if (source === 'star') {
      const qids = new Set(await KSB.getStarQids(bankId));
      questions = questions.filter(q => qids.has(q.id));
    }

    session.bankId = bankId;
    session.bank = bank;
    // 顺序/随机：顺序=题库 id 序；随机=Fisher-Yates 打乱（bugfix：M7/M8 筛选面板重构时丢了 shuffle 的调用点，
    // 导致"随机"与"顺序"排列完全相同；重开/切模式都会重新走 startSession → 随机模式每次重新打乱）
    if (!keepMode) session.mode = 'seq';
    session.questions = session.mode === 'rand' ? shuffle(questions) : questions;
    session.source = source;
    session.idx = 0;
    if (!keepTraces) {
      session.answers.clear();
      session.drafts.clear();
    }
    session.startedAt = new Date();
    session.committed = false;
    session.touched = 0;   // M10：新的一轮，作答计数归零
    syncChips();
    renderChapterChips(chapters);
    renderAll();
  }

  /* 取一组题目的去重章节列表（保持出现顺序） */
  function chaptersOf(questions) {
    const seen = [];
    const set = new Set();
    questions.forEach(q => {
      const ch = (q.chapter || '').trim();
      if (ch && !set.has(ch)) { set.add(ch); seen.push(ch); }
    });
    return seen;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function syncChips() {
    $$('#view-practice .chip[data-src]').forEach(c => c.classList.toggle('active', c.dataset.src === session.source));
    $$('#view-practice .chip[data-ftype]').forEach(c => c.classList.toggle('active', !session.excluded.has(c.dataset.ftype)));
    $$('#view-practice .chip[data-mode]').forEach(c => c.classList.toggle('active', c.dataset.mode === session.mode));
    const tip = $('#modeTip');
    tip.textContent = session.mode === 'rand' ? '随机顺序，点"重新开始"重新打乱' : '';
    const st = $('#srcTip');
    st.textContent = session.source === 'wrong' ? '正在重练错题（答对不会自动移除，去错题本手动标记）'
      : session.source === 'star' ? '正在练收藏题' : '';
    syncFilterSummary();
  }

  /* M8：顶部一行入口里的当前筛选摘要（省略号截断） */
  function syncFilterSummary() {
    const el = $('#filterSummary');
    if (!el) return;
    const typeLabel = { single: '单选', multiple: '多选', judge: '判断', fill: '填空' };
    const active = ['single', 'multiple', 'judge', 'fill']
      .filter(t => !session.excluded.has(t)).map(t => typeLabel[t]);
    const parts = [
      SOURCE_LABEL[session.source] || '本库全部',
      active.length === 4 ? '全题型' : active.join('+'),
      session.mode === 'rand' ? '随机' : '顺序',
      session.chapter || '全章节'
    ];
    if (prefs.showAnswer) parts.push('背题');   // M11：背题模式下摘要带状态
    el.textContent = parts.join(' · ');
    el.title = el.textContent;
  }

  /* 章节 chips：全部 + 各章节（基于当前会话过滤前的题型全集） */
  function renderChapterChips(chapters) {
    const wrap = $('#chapterChips');
    if (!wrap) return;
    const list = chapters || chaptersOf(session.questions);
    const html = ['<button class="chip' + (session.chapter === '' ? ' active' : '') + '" data-chapter="">全部</button>']
      .concat(list.map(ch =>
        '<button class="chip' + (session.chapter === ch ? ' active' : '') + '" data-chapter="' + KSB.esc(ch) + '">' + KSB.esc(ch) + '</button>'
      )).join('');
    wrap.innerHTML = html;
    const tip = $('#chapterTip');
    if (tip) {
      tip.textContent = !list.length ? '本章库题目未分章节，暂无法按章节筛选'
        : session.chapter ? '仅练习「' + session.chapter + '」章节' : '';
    }
  }

  async function refreshSourceChips() {
    const wc = Array.from(wrongCache.values()).filter(w => w.bankId === session.bankId).length;
    $('#srcWrongCount').textContent = wc;
    const stars = session.bankId ? await KSB.getStarQids(session.bankId) : [];
    $('#srcStarCount').textContent = stars.length;
  }

  async function refreshWrongCache() {
    wrongCache.clear();
    const items = await KSB.storeGetAll('wrong');
    items.forEach(it => wrongCache.set(it.qid, it));
  }

  /* 练习历史落库：换库/重新开始（离开当前一轮）时调用；筛选内切换(keepTraces)不落历史、痕迹保留。
     M10：统计只按「当前筛选内题目」计，保留在 answers/drafts 里但不属于当前题组的旧痕迹不计入。 */
  async function commitHistory() {
    if (!session.bankId || session.committed || session.startedAt == null) return;
    let correct = 0, wrong = 0;
    session.questions.forEach(q => {
      const a = session.answers.get(q.id);
      if (a && a.state === 'correct') correct++;
      else if (a && a.state === 'wrong') wrong++;
    });
    if (!correct && !wrong) return; // 无作答不记
    const finishedAt = new Date();
    const row = {
      id: KSB.uid(),
      bankId: session.bankId,
      bankName: session.bank ? session.bank.name : '',
      type: 'practice',
      source: session.source,
      mode: session.mode,
      chapter: session.chapter || '',
      startedAt: session.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSec: Math.round((finishedAt - session.startedAt) / 1000),
      total: session.questions.length,
      correct, wrong,
      unanswered: session.questions.length - correct - wrong,
      ratePct: correct + wrong ? Math.round(correct / (correct + wrong) * 100) : 0
    };
    session.committed = true;
    try { await KSB.storePut('history', row); } catch (e) { /* 不阻塞 */ }
  }

  /* ============ 渲染 ============ */
  function renderAll() {
    renderQuestion();
    refreshStats();
    renderSheet();
  }

  function cur() { return session.questions[session.idx]; }

  async function syncStarUI(q, starredOverride) {
    const b = $('#btnStar');
    if (!q) { b.textContent = '☆'; b.classList.remove('on'); return; }
    const starred = starredOverride != null ? starredOverride : await KSB.isStarred(q.id);
    b.textContent = starred ? '★' : '☆';
    b.classList.toggle('on', starred);
  }

  function renderQuestion() {
    const q = cur();
    const total = session.questions.length;
    const meta = $('#qMeta');
    if (!q) {
      const filtered = !!(session.chapter || session.excluded.size || session.source !== 'all');
      meta.textContent = total ? '' : (filtered
        ? '（该章节/题型/练习源筛选下暂无题目，可切换筛选范围）'
        : '（本库暂无题目，去"导入题库"添加）');
      $('#qStem').textContent = '';
      $('#qOptions').innerHTML = '';
      $('#feedback').hidden = true;
      $('#btnStar').textContent = '☆';
      $('#btnStar').classList.remove('on');
      lastQid = null;
      return;
    }
    meta.textContent = (session.idx + 1) + ' / ' + total + ' · ' + (KSB.TYPES[q.type] || q.type)
      + (q.chapter ? ' · ' + q.chapter : '');
    $('#qStem').textContent = q.stem;
    const ans = session.answers.get(q.id);
    const draft = session.drafts.get(q.id);
    const done = !!(ans && ans.state);
    /* M11：背题模式 —— 未判分时也直接展示正确答案（只读浏览，见 markReveal/renderFeedback） */
    const reveal = prefs.showAnswer && !done;

    const box = $('#qOptions');
    box.dataset.qid = q.id;
    box.dataset.locked = (done || reveal) ? '1' : '0';
    box.classList.remove('locked');

    /* M7：真正切到另一道题时，题干与选项做一次柔和入场（同题重渲染不打扰） */
    if (q.id !== lastQid) {
      lastQid = q.id;
      KSB.fxPlay($('#qStem'), 'fx-rise');
      KSB.fxPlay(box, 'fx-rise');
    }

    if (q.type === 'short') { return; } // 轻量版不支持简答（题库已过滤）

    let html = '';
    const options = q.type === 'judge'
      ? JUDGE_OPTIONS.map(o => ({ val: o.val, text: o.label }))
      : (q.options || []).map(o => ({ val: o.key, text: o.key + '. ' + o.text }));

    if (q.type === 'multiple') {
      const chosen = done ? (ans.user || []) : (draft ? draft.user : []);
      options.forEach(o => {
        const checked = chosen.includes(o.val) ? ' checked' : '';
        html += '<label class="opt" data-val="' + KSB.esc(String(o.val)) + '"><input type="checkbox" value="' + KSB.esc(String(o.val)) + '"' + checked + '> <span>' + KSB.esc(o.text) + '</span></label>';
      });
      html += '<div class="action-row"><button class="btn btn-primary" data-action="submit-multi">提交本题</button></div>';
      if (done) html += '<div class="note">本题已判分，不能修改答案</div>';
      else if (reveal) html += '<div class="note">背题模式：绿色为正确答案，直接浏览记忆即可</div>';
      else if (draft) html += '<div class="note">已勾选未提交 → 答题卡显示"待判"，点"提交本题"判分</div>';
      box.innerHTML = html;
      if (done) {
        box.querySelectorAll('input').forEach(i => i.disabled = true);
        markChoiceHighlight(box, q, ans);
        box.classList.add('locked');
      } else if (reveal) {
        box.querySelectorAll('input').forEach(i => i.disabled = true);
        markReveal(box, q);
        box.classList.add('locked');
      }
      renderFeedback(ans, q);
      syncStarUI(q);
      return;
    }

    if (q.type === 'fill') {
      const blankCount = Math.max(1, KSB.countBlanks(q.stem));
      const vals = done ? (ans.user || []) : (draft ? draft.user : []);
      for (let i = 0; i < blankCount; i++) {
        html += '<input class="fill-input" data-blank="' + i + '" placeholder="填空 ' + (i + 1) + '（第' + (i + 1) + '空）"' +
          (vals[i] != null ? ' value="' + KSB.esc(String(vals[i])) + '"' : '') + '>';
      }
      html += '<div class="action-row"><button class="btn btn-primary" data-action="submit-fill">提交本题</button></div>';
      if (reveal) html += '<div class="note">背题模式：已填入（第一个可接受的）正确答案，直接浏览记忆即可</div>';
      box.innerHTML = html;
      if (done) {
        box.querySelectorAll('input').forEach(i => i.disabled = true);
        box.classList.add('locked');
      } else if (reveal) {
        fillRevealInputs(box, q);
        box.classList.add('locked');
      }
      renderFeedback(ans, q);
      syncStarUI(q);
      return;
    }

    // single / judge
    options.forEach(o => {
      html += '<button type="button" class="opt" data-val="' + KSB.esc(String(o.val)) + '"><span>' + KSB.esc(o.text) + '</span></button>';
    });
    box.innerHTML = html;
    if (done) {
      box.classList.add('locked');
      markChoiceHighlight(box, q, ans);
    } else if (reveal) {
      box.classList.add('locked');
      markReveal(box, q);
    }
    renderFeedback(ans, q);
    syncStarUI(q);
  }

  /* 当前题正确选项的 key 列表（judge 用 'true'/'false'，single 用字母，multiple 用字母数组） */
  function correctKeysOf(q) {
    if (q.type === 'judge') return q.answer === true ? ['true'] : ['false'];
    if (q.type === 'single') return [String(q.answer)];
    return (q.answer || []).map(String);
  }

  function markChoiceHighlight(box, q, ans) {
    if (!ans) return;
    const correctKeys = correctKeysOf(q);
    const userVals = q.type === 'multiple' ? (ans.user || []).map(String) : [String(ans.user)];
    box.querySelectorAll('.opt').forEach(el => {
      const val = el.dataset.val;
      if (correctKeys.includes(val)) el.classList.add('opt-correct');
      else if (ans.state === 'wrong' && userVals.includes(val)) el.classList.add('opt-wrong');
    });
  }

  /* M11：背题模式 —— 直接标绿正确选项（无作答痕迹，不标错选） */
  function markReveal(box, q) {
    const correctKeys = correctKeysOf(q);
    box.querySelectorAll('.opt').forEach(el => {
      if (correctKeys.includes(el.dataset.val)) el.classList.add('opt-correct');
    });
  }

  /* M11：背题模式 —— 填空输入框直接填入每空第一组可接受答案并锁定 */
  function fillRevealInputs(box, q) {
    const a = q.answer;
    let blanks = [];
    if (a != null) {
      if (Array.isArray(a) && a.length && Array.isArray(a[0])) blanks = a.map(g => String(g[0] != null ? g[0] : ''));
      else if (Array.isArray(a)) blanks = a.map(v => String(v == null ? '' : v));
      else blanks = [String(a)];
    }
    box.querySelectorAll('.fill-input').forEach((inp, i) => {
      inp.value = blanks[i] != null ? blanks[i] : '';
      inp.disabled = true;
    });
  }

  function renderFeedback(ans, q) {
    const fb = $('#feedback');
    /* M11：背题模式且本题未作答 → 直接展示 正确答案+解析（无对错状态） */
    const reveal = prefs.showAnswer && !ans;
    if (!ans && !reveal) { fb.hidden = true; return; }
    fb.hidden = false;
    if (reveal) {
      fb.className = 'feedback fb-reveal';
      fb.innerHTML =
        '<div class="fb-state">📖 背题模式 · 正确答案如下</div>' +
        '<div class="fb-expected"><b>正确答案：</b>' + KSB.esc(KSB.answerText(q)) + '</div>' +
        (q && q.analysis ? '<div class="fb-analysis"><b>解析：</b>' + KSB.esc(q.analysis) + '</div>' : '');
      return;
    }
    fb.className = 'feedback ' + (ans.state === 'correct' ? 'fb-correct' : 'fb-wrong');
    const stateText = ans.state === 'correct' ? '✅ 回答正确' : '❌ 回答错误';
    fb.innerHTML =
      '<div class="fb-state">' + stateText + '</div>' +
      '<div class="fb-expected"><b>正确答案：</b>' + KSB.esc(ans.expected || '') + '</div>' +
      (ans.detail ? '<div class="fb-detail">' + KSB.esc(ans.detail) + '</div>' : '') +
      (q && q.analysis ? '<div class="fb-analysis"><b>解析：</b>' + KSB.esc(q.analysis) + '</div>' : '');
  }

  /* ============ 作答交互 ============ */
  function onOptionsClick(e) {
    const box = $('#qOptions');
    if (box.dataset.locked === '1') return;
    const q = cur();
    if (!q || q.id !== box.dataset.qid) return;

    const btn = e.target.closest('[data-action]');
    const optBtn = e.target.closest('.opt');

    if (btn && btn.dataset.action === 'submit-multi') {
      const vals = $$('#qOptions input[type=checkbox]:checked').map(i => i.value);
      if (!vals.length) { KSB.toast('请至少勾选一个选项', 'bad'); return; }
      submitAnswer(q, vals);
      return;
    }
    if (btn && btn.dataset.action === 'submit-fill') {
      const vals = $$('#qOptions .fill-input').map(i => i.value);
      submitAnswer(q, vals);
      return;
    }
    if (optBtn && (q.type === 'single' || q.type === 'judge')) {
      submitAnswer(q, optBtn.dataset.val);
    }
  }

  /* 多选勾选变化 → 草稿（未提交判分，答题卡显示"待判"） */
  function onDraftChange(e) {
    const box = $('#qOptions');
    if (box.dataset.locked === '1') return;
    const q = cur();
    if (!q || q.id !== box.dataset.qid || q.type !== 'multiple') return;
    const vals = $$('#qOptions input[type=checkbox]:checked').map(i => i.value);
    if (vals.length) session.drafts.set(q.id, { user: vals });
    else session.drafts.delete(q.id);
    renderSheet();
  }
  /* 填空输入 → 草稿 */
  function onDraftInput(e) {
    const box = $('#qOptions');
    if (box.dataset.locked === '1') return;
    const q = cur();
    if (!q || q.id !== box.dataset.qid || q.type !== 'fill') return;
    const vals = $$('#qOptions .fill-input').map(i => i.value);
    if (vals.some(v => String(v || '').trim() !== '')) session.drafts.set(q.id, { user: vals });
    else session.drafts.delete(q.id);
    renderSheet();
  }

  function submitAnswer(q, user) {
    const res = KSB.gradeQuestion(q, user);
    recordAnswer(q, user, res);
  }
  function userTextOf(q, user) {
    if (q.type === 'judge') return user === 'true' ? '正确' : user === 'false' ? '错误' : String(user);
    if (q.type === 'multiple') return Array.isArray(user) ? user.join('、') : String(user);
    if (q.type === 'fill') return Array.isArray(user) ? user.join(' ｜ ') : String(user);
    if (q.type === 'single') return String(user);
    return String(user || '').slice(0, 120);
  }

  async function recordAnswer(q, user, res) {
    const userText = userTextOf(q, user);
    session.answers.set(q.id, { user, userText, state: res.state, expected: res.expected, detail: res.detail });
    session.drafts.delete(q.id);
    session.touched++;   // M10：本轮真实作答计数（供"已完成"判定的防伪）
    renderQuestion();
    refreshStats();
    renderSheet();
    await refreshSourceChips();
    if (res.state === 'wrong') {
      const item = await KSB.wrongAdd(q, userText);
      wrongCache.set(q.id, item);
      renderWrongIfVisible();
      await refreshSourceChips();
    }
    // M8：判对 → 延时自动下一题（答错停留看答案/解析）
    if (res.state === 'correct') maybeAutoNext();
  }

  /* ============ 统计与答题卡 ============ */
  function refreshStats() {
    let correct = 0, wrong = 0;
    // M10：只统计当前筛选内题目；换筛选保留的旧痕迹不计入（答题卡同按当前题组）
    session.questions.forEach(q => {
      const a = session.answers.get(q.id);
      if (a && a.state === 'correct') correct++;
      else if (a && a.state === 'wrong') wrong++;
    });
    const total = session.questions.length;
    const doneCount = correct + wrong;
    const rate = doneCount ? Math.round(correct / doneCount * 100) + '%' : '—';
    $('#statAnswered').textContent = doneCount + '/' + total;
    $('#statCorrect').textContent = correct;
    $('#statWrong').textContent = wrong;
    $('#statRate').textContent = rate;
    $('#progressBar').style.width = (total ? doneCount / total * 100 : 0) + '%';
    const sc = $('#sheetCount');
    if (sc) sc.textContent = doneCount + '/' + total;

    const last = total > 0 && session.idx === total - 1 && doneCount === total && session.touched > 0;
    const tip = $('#doneTip');
    tip.hidden = !last;
    if (last) {
      $('#doneText').textContent = '已完成全部 ' + total + ' 题 · 答对 ' + correct + ' · 答错 ' + wrong + ' · 正确率 ' + rate;
      if (!session.committed) commitHistory();
    }
  }

  function renderSheet() {
    const sheet = $('#answerSheet');
    sheet.innerHTML = '';
    let pending = 0;
    session.questions.forEach((q, i) => {
      const b = document.createElement('button');
      b.className = 'sheet-cell';
      const a = session.answers.get(q.id);
      if (a && a.state === 'correct') b.classList.add('sc-correct');
      else if (a && a.state === 'wrong') b.classList.add('sc-wrong');
      else if (session.drafts.has(q.id)) { b.classList.add('sc-pending'); pending++; }
      b.textContent = i + 1;
      b.title = '第' + (i + 1) + '题';
      b.addEventListener('click', () => goto(i));
      sheet.appendChild(b);
    });
    const title = $('#sheetTitle');
    if (title) title.textContent = '答题卡（绿=对 红=错 橙=待判' + (pending ? ' ' + pending + '题' : '') + ' · 点击跳转）';
  }

  function goto(i) {
    if (i < 0 || i >= session.questions.length) return;
    cancelAutoNext();   // M8：手动切题时取消待触发的自动下一题
    session.idx = i;
    renderAll();
    scrollToQuestion(); // M8：切题后自动回到题目顶部（原为整页滚到最顶）
  }

  /* ============ 错题本（当前库 / 全库） ============ */
  function renderWrongIfVisible() {
    if ($('#view-wrong').classList.contains('hidden')) return;
    renderWrong();
  }
  function refreshStarsIfVisible() {
    if ($('#view-stars').classList.contains('hidden')) return;
    renderStars();
  }

  async function renderWrong() {
    const list = $('#wrongList');
    const summary = $('#wrongSummary');
    const tools = $('#wrongTools');
    const all = wrongScope.cur === 'all';
    const tip = $('#wrongScopeTip');
    if (tip) tip.textContent = all ? '汇总全部题库的错题，可按库重练/清除' : '只显示当前题库的错题';

    // 数据：所有相关题目（含已删题占位）与题库名
    const banks = await KSB.storeGetAll('banks');
    const bankName = new Map(banks.map(b => [b.id, b.name]));
    const qById = new Map();
    const qOfBank = new Map(); // bankId -> [questions]
    for (const b of banks) {
      const qs = await KSB.getBankQuestions(b.id);
      qOfBank.set(b.id, qs);
      qs.forEach(q => qById.set(q.id, q));
    }
    const items = Array.from(wrongCache.values())
      .filter(it => all || it.bankId === session.bankId)
      .sort((a, b) => (b.lastWrongAt || '').localeCompare(a.lastWrongAt || ''));

    if (all) {
      // 按题库分组
      const byBank = new Map();
      items.forEach(it => {
        if (!byBank.has(it.bankId)) byBank.set(it.bankId, []);
        byBank.get(it.bankId).push(it);
      });
      summary.textContent = items.length
        ? '全库共 ' + items.length + ' 道错题，分布于 ' + byBank.size + ' 个题库（做错自动收录）'
        : '全库暂无错题。做错的题会自动出现在这里。';
      tools.style.display = 'none';
      if (!items.length) { list.innerHTML = '<div class="empty-tip">暂无错题 🎉</div>'; return; }
      list.innerHTML = '';
      for (const [bid, its] of byBank) {
        const name = bankName.get(bid) || '（已删除题库）';
        const head = document.createElement('div');
        head.className = 'wrong-group-head';
        head.innerHTML = '<span class="wrong-group-name">📚 ' + KSB.esc(name) + '</span>' +
          '<span class="wrong-group-actions">' +
          '<button class="btn btn-xs" data-act="wrong-bank-practice" data-bank="' + KSB.esc(bid) + '">▶ 重练该库</button>' +
          '<button class="btn btn-xs btn-danger" data-act="wrong-bank-clear" data-bank="' + KSB.esc(bid) + '">清除该库</button>' +
          '</span>';
        list.appendChild(head);
        for (const it of its) list.appendChild(wrongCard(it, qById.get(it.qid)));
      }
      return;
    }

    // 当前库
    const bid = session.bankId;
    summary.textContent = items.length
      ? '本库共 ' + items.length + ' 道错题（做错自动收录；点击"已掌握"移除）'
      : '本库暂无错题。做错的题会自动出现在这里。';
    tools.style.display = '';
    $('#btnWrongClear').textContent = '已掌握：全部移除（本库）';
    if (!items.length) { list.innerHTML = '<div class="empty-tip">暂无错题 🎉</div>'; return; }
    list.innerHTML = '';
    for (const it of items) {
      list.appendChild(wrongCard(it, qById.get(it.qid)));
    }
  }

  function wrongCard(it, q) {
    const card = document.createElement('div');
    card.className = 'wrong-card';
    const typeName = q ? (KSB.TYPES[q.type] || '') : '已删除的题目';
    const stem = q ? q.stem : '（原题目已不存在）';
    const time = new Date(it.lastWrongAt).toLocaleString();
    const chapterTxt = q && q.chapter ? ' · ' + KSB.esc(q.chapter) : '';
    card.innerHTML =
      '<div class="wrong-head"><span class="badge">' + KSB.esc(typeName) + chapterTxt + '</span>' +
      '<span class="wrong-meta">错次 ' + it.wrongCount + ' · 最近 ' + KSB.esc(time) + '</span></div>' +
      '<div class="wrong-stem">' + KSB.esc(stem) + '</div>' +
      (it.lastUserAnswer ? '<div class="wrong-answer"><b>你的作答：</b>' + KSB.esc(it.lastUserAnswer) + '</div>' : '') +
      (q ? '<div class="wrong-answer"><b>正确答案：</b>' + KSB.esc(KSB.answerText(q)) + '</div>' : '') +
      '<div class="action-row"><button class="btn btn-xs" data-act="wrong-mastered" data-qid="' + KSB.esc(it.qid) + '">已掌握（移除）</button>' +
      (q && q.bankId ? '<button class="btn btn-xs" data-act="q-practice" data-qid="' + KSB.esc(q.id) + '" data-bank="' + KSB.esc(q.bankId) + '">练此题</button>' : '') +
      '</div>';
    return card;
  }

  /* ============ 收藏页签（当前库 / 全库） ============ */
  async function renderStars() {
    const list = $('#starList');
    const summary = $('#starSummary');
    const all = starScope.cur === 'all';
    const tip = $('#starScopeTip');
    if (tip) tip.textContent = all ? '汇总全部题库的收藏题' : '只显示当前题库的收藏题';

    const stars = await KSB.storeGetAll('stars');
    const banks = await KSB.storeGetAll('banks');
    const bankName = new Map(banks.map(b => [b.id, b.name]));
    const qById = new Map();
    for (const b of banks) {
      const qs = await KSB.getBankQuestions(b.id);
      qs.forEach(q => qById.set(q.id, q));
    }
    const items = stars
      .filter(s => all || s.bankId === session.bankId)
      .sort((a, b) => (b.starredAt || '').localeCompare(a.starredAt || ''));

    summary.textContent = items.length
      ? (all ? '全库共 ' : '本库共 ') + items.length + ' 道收藏题（答题页 ☆ 收藏 / 本页取消）'
      : (all ? '全库暂无收藏。答题时点 ☆ 可收藏题目。' : '本库暂无收藏。答题时点 ☆ 可收藏题目。');
    if (!items.length) { list.innerHTML = '<div class="empty-tip">暂无收藏 🎉</div>'; return; }
    list.innerHTML = '';
    for (const s of items) {
      const q = qById.get(s.qid);
      const card = document.createElement('div');
      card.className = 'wrong-card';
      if (!q) {
        card.innerHTML = '<div class="wrong-head"><span class="badge">已删除的题目</span></div>' +
          '<div class="wrong-stem">（原题目已不存在）</div>' +
          '<div class="action-row"><button class="btn btn-xs" data-act="star-remove" data-qid="' + KSB.esc(s.qid) + '">取消收藏</button></div>';
        list.appendChild(card);
        continue;
      }
      const time = new Date(s.starredAt).toLocaleString();
      const chTxt = q.chapter ? ' · ' + KSB.esc(q.chapter) : '';
      const bankTxt = all ? ' · ' + KSB.esc(bankName.get(q.bankId) || '') : '';
      card.innerHTML =
        '<div class="wrong-head"><span class="badge">★ ' + KSB.esc(KSB.TYPES[q.type] || q.type) + chTxt + bankTxt + '</span>' +
        '<span class="wrong-meta">收藏于 ' + KSB.esc(time) + '</span></div>' +
        '<div class="wrong-stem">' + KSB.esc(q.stem) + '</div>' +
        '<div class="action-row">' +
        '<button class="btn btn-xs btn-danger" data-act="star-remove" data-qid="' + KSB.esc(q.id) + '">取消收藏</button>' +
        '<button class="btn btn-xs" data-act="star-practice" data-qid="' + KSB.esc(q.id) + '">练此题</button>' +
        '</div>';
      list.appendChild(card);
    }
  }

  /* ============ Tab ============ */
  function showTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    ['practice', 'exam', 'wrong', 'stars', 'search', 'stats', 'banks', 'import', 'settings'].forEach(v =>
      $('#view-' + v).classList.toggle('hidden', v !== name));
    const shown = $('#view-' + name);
    if (shown) KSB.fxPlay(shown, 'fx-view');
    if (name === 'practice') { renderAll(); refreshSourceChips(); }
    if (name === 'exam' && KSB.exam && typeof KSB.exam.onShow === 'function') KSB.exam.onShow();
    if (name === 'wrong') renderWrong();
    if (name === 'stars') renderStars();
    if (name === 'search' && KSB.search && typeof KSB.search.onShow === 'function') KSB.search.onShow();
    if (name === 'stats' && KSB.stats && typeof KSB.stats.render === 'function') KSB.stats.render();
    if (name === 'banks' && typeof KSB.renderBankMgmt === 'function') KSB.renderBankMgmt();
    if (name === 'import' && KSB.importer && typeof KSB.importer.refreshTargetList === 'function') KSB.importer.refreshTargetList();
    if (name === 'settings' && KSB.backup && typeof KSB.backup.onShow === 'function') KSB.backup.onShow();
    if (name === 'settings' && KSB.sync && typeof KSB.sync.onShow === 'function') KSB.sync.onShow();
    if (name === 'settings') syncPrefControls();   // M8：同步主题/开关的当前选中态
    window.scrollTo({ top: 0 });
  }

  /* ============ 启动 ============ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
