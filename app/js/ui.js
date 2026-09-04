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
    committed: true
  };

  const wrongCache = new Map();
  const wrongScope = { cur: 'bank' };   // 错题本视图范围 'bank' | 'all'
  const starScope = { cur: 'all' };     // 收藏页签范围 'bank' | 'all'

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
    showTab('practice');
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

    // 练习源
    $$('#view-practice .chip[data-src]').forEach(c => c.addEventListener('click', () => switchSource(c.dataset.src)));
    // 题型过滤
    $$('#view-practice .chip[data-ftype]').forEach(c => c.addEventListener('click', () => {
      const t = c.dataset.ftype;
      if (!session.excluded.has(t) && session.excluded.size >= 3) { KSB.toast('至少保留一种题型', 'bad'); return; }
      if ((session.answers.size || session.drafts.size) && !confirm('调整题型范围将清空当前作答记录，继续？')) return;
      if (session.excluded.has(t)) session.excluded.delete(t); else session.excluded.add(t);
      startSession(session.bankId, { keepMode: true, source: session.source });
    }));
    // 章节筛选
    $('#chapterChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-chapter]');
      if (!chip) return;
      const ch = chip.dataset.chapter;
      if (ch === session.chapter) return;
      if ((session.answers.size || session.drafts.size) && !confirm('切换章节将清空当前作答记录，继续？')) return;
      session.chapter = ch;
      startSession(session.bankId, { keepMode: true, source: session.source });
    });
    // 模式
    $$('#view-practice .chip[data-mode]').forEach(c => c.addEventListener('click', () => {
      const mode = c.dataset.mode;
      if (mode === session.mode) return;
      if ((session.answers.size || session.drafts.size) && !confirm('切换练习模式将清空当前作答记录，继续？')) return;
      session.mode = mode;
      startSession(session.bankId, { keepMode: true, source: session.source });
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
    if ((session.answers.size || session.drafts.size) && !confirm('切换练习源将清空当前作答记录，继续？')) return;
    await startSession(session.bankId, { keepMode: true, source });
  }

  async function startSession(bankId, opts) {
    const keepMode = opts && opts.keepMode;
    const source = (opts && opts.source) || 'all';
    const bankChanged = bankId !== session.bankId;
    await commitHistory();
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
    session.questions = questions;
    session.source = source;
    session.idx = 0;
    session.answers.clear();
    session.drafts.clear();
    session.startedAt = new Date();
    session.committed = false;
    if (!keepMode) session.mode = 'seq';
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

  /* 练习历史落库：会话切换/重置/完成时各一次 */
  async function commitHistory() {
    if (!session.bankId || session.committed || session.startedAt == null) return;
    let correct = 0, wrong = 0;
    session.answers.forEach(a => {
      if (a.state === 'correct') correct++;
      else if (a.state === 'wrong') wrong++;
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
      return;
    }
    meta.textContent = (session.idx + 1) + ' / ' + total + ' · ' + (KSB.TYPES[q.type] || q.type)
      + (q.chapter ? ' · ' + q.chapter : '');
    $('#qStem').textContent = q.stem;
    const ans = session.answers.get(q.id);
    const draft = session.drafts.get(q.id);
    const done = !!(ans && ans.state);

    const box = $('#qOptions');
    box.dataset.qid = q.id;
    box.dataset.locked = done ? '1' : '0';
    box.classList.remove('locked');

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
      else if (draft) html += '<div class="note">已勾选未提交 → 答题卡显示"待判"，点"提交本题"判分</div>';
      box.innerHTML = html;
      if (done) {
        box.querySelectorAll('input').forEach(i => i.disabled = true);
        markChoiceHighlight(box, q, ans);
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
      box.innerHTML = html;
      if (done) {
        box.querySelectorAll('input').forEach(i => i.disabled = true);
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
    }
    renderFeedback(ans, q);
    syncStarUI(q);
  }

  function markChoiceHighlight(box, q, ans) {
    if (!ans) return;
    const correctKeys = q.type === 'judge'
      ? (q.answer === true ? ['true'] : ['false'])
      : q.type === 'single' ? [String(q.answer)]
      : (q.answer || []).map(String);
    const userVals = q.type === 'multiple' ? (ans.user || []).map(String) : [String(ans.user)];
    box.querySelectorAll('.opt').forEach(el => {
      const val = el.dataset.val;
      if (correctKeys.includes(val)) el.classList.add('opt-correct');
      else if (ans.state === 'wrong' && userVals.includes(val)) el.classList.add('opt-wrong');
    });
  }

  function renderFeedback(ans, q) {
    const fb = $('#feedback');
    if (!ans) { fb.hidden = true; return; }
    fb.hidden = false;
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
  }

  /* ============ 统计与答题卡 ============ */
  function refreshStats() {
    let correct = 0, wrong = 0;
    session.answers.forEach(a => {
      if (a.state === 'correct') correct++;
      else if (a.state === 'wrong') wrong++;
    });
    const total = session.questions.length;
    const doneCount = correct + wrong;
    const rate = doneCount ? Math.round(correct / doneCount * 100) + '%' : '—';
    $('#statAnswered').textContent = doneCount + '/' + total;
    $('#statCorrect').textContent = correct;
    $('#statWrong').textContent = wrong;
    $('#statRate').textContent = rate;
    $('#progressBar').style.width = (total ? doneCount / total * 100 : 0) + '%';

    const last = total > 0 && session.idx === total - 1 && doneCount === total;
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
    session.idx = i;
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    window.scrollTo({ top: 0 });
  }

  /* ============ 启动 ============ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
