/* exam.js —— 模拟考试（轻量版，无简答）：随机组卷 → 作答(不即时判分) → 交卷统一判分 → 成绩单
   判分复用 grade.js；交卷后答错自动进错题本。题型范围：单选/多选/判断/填空。 */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const SUPPORTED = new Set(['single', 'multiple', 'judge', 'fill']);
  const JUDGE_OPTIONS = [
    { val: true, label: '正确' },
    { val: false, label: '错误' }
  ];

  const state = {
    bankId: null,
    questions: [],
    idx: 0,
    answers: new Map(),
    remain: 0,
    timerId: null,
    startedAt: null,
    finished: false,
    lastCfg: null
  };
  let lastExQid = null; // M7：上一道渲染的题目 id（切换题目时播放入场动画，同题重渲染不打扰）

  /* ============ 配置 ============ */
  async function onShow() {
    if (!$('#examRun').classList.contains('hidden')) return;
    const banks = await KSB.storeGetAll('banks');
    const sel = $('#exBank');
    const curVal = sel.value;
    sel.innerHTML = '';
    banks.forEach(b => {
      const o = document.createElement('option');
      o.value = b.id; o.textContent = b.name;
      sel.appendChild(o);
    });
    const uiSel = $('#bankSelect');
    const prefer = uiSel && uiSel.value ? uiSel.value : '';
    sel.value = (curVal && banks.some(b => b.id === curVal)) ? curVal
      : (banks.some(b => b.id === prefer) ? prefer : (banks.length ? banks[0].id : ''));
    await refreshNumOptions();
    updateNote();
  }

  async function refreshNumOptions() {
    const bid = $('#exBank').value;
    const sel = $('#exNum');
    const all = bid ? (await KSB.getBankQuestions(bid)).filter(q => SUPPORTED.has(q.type)) : [];
    const n = all.length;
    const cur = sel.value;
    const options = [];
    if (!n) options.push(['0', '（空题库）']);
    options.push(['all', '全部（' + n + '题）']);
    [5, 10, 15, 20, 25, 30, 40, 50, 100].forEach(x => { if (x < n) options.push([String(x), '随机 ' + x + ' 题']); });
    if (n > 0 && n < 100) options.push([String(n), '随机 ' + n + ' 题']);
    sel.innerHTML = options.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
    sel.value = cur && Array.from(sel.options).some(o => o.value === cur) ? cur : 'all';
  }

  function updateNote() {
    const time = Number($('#exTime').value);
    $('#exNote').textContent = '从题库随机抽题（单选/多选/判断/填空），' +
      (time ? '限时 ' + time + ' 分钟，到时自动交卷' : '不限时') +
      '。交卷统一判分，答错自动进错题本。';
  }

  async function start() {
    stopTimer();
    const bankId = $('#exBank').value;
    const numV = $('#exNum').value;
    const timeM = Number($('#exTime').value);
    let all = bankId ? await KSB.getBankQuestions(bankId) : [];
    all = all.filter(q => SUPPORTED.has(q.type));
    if (!all.length) { KSB.toast('该题库暂无可用题目', 'bad'); return; }
    let qs = shuffle(all);
    if (numV !== 'all') qs = qs.slice(0, Math.min(Number(numV), qs.length));
    state.bankId = bankId;
    state.questions = qs;
    state.answers.clear();
    state.idx = 0;
    state.remain = timeM ? timeM * 60 : 0;
    state.startedAt = new Date();
    state.finished = false;
    state.lastCfg = { bankId, numV, timeM, count: qs.length };

    const bank = await KSB.storeGet('banks', bankId);
    $('#exTitle').textContent = '📝 ' + (bank ? bank.name : '') + ' · ' + qs.length + ' 题'
      + (timeM ? ' · 限时 ' + timeM + ' 分钟' : ' · 不限时');
    $('#examConfig').classList.add('hidden');
    $('#examRun').classList.remove('hidden');
    $('#examResult').classList.add('hidden');
    renderExQuestion();
    updateExSheet();
    if (timeM) { updateTimer(); state.timerId = setInterval(updateTimer, 1000); }
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function updateTimer() {
    const el = $('#exTimer');
    if (!el) return;
    if (state.remain <= 0) { submit(true); return; }
    state.remain--;
    const m = Math.floor(state.remain / 60), s = state.remain % 60;
    el.textContent = '⏱ ' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    el.classList.toggle('warn', state.remain < 60);
  }

  /* ============ 渲染 ============ */
  function cur() { return state.questions[state.idx]; }

  function collectCurrentDOM() {
    const q = cur();
    if (!q) return;
    const box = $('#exOptions');
    if (box.dataset.qid !== q.id) return;
    if (q.type === 'fill') setAnswer(q, $$('#exOptions .fill-input').map(i => i.value));
    else if (q.type === 'multiple') setAnswer(q, $$('#exOptions input[type=checkbox]:checked').map(i => i.value));
  }

  function isBlankAnswer(q, user) {
    if (q.type === 'multiple') return !(user && user.length);
    if (q.type === 'fill') return !(Array.isArray(user) && user.some(v => String(v || '').trim() !== ''));
    return user == null || String(user) === '';
  }
  function setAnswer(q, user) {
    if (isBlankAnswer(q, user)) state.answers.delete(q.id);
    else state.answers.set(q.id, user);
  }
  function userTextOf(q, user) {
    if (isBlankAnswer(q, user)) return '（未作答）';
    if (q.type === 'judge') return String(user) === 'true' ? '正确' : String(user) === 'false' ? '错误' : String(user);
    if (q.type === 'multiple') return user.join('、');
    if (q.type === 'fill') return user.join(' ｜ ');
    return String(user);
  }

  function renderExQuestion() {
    const q = cur();
    const total = state.questions.length;
    const box = $('#exOptions');
    if (!q) { $('#exMeta').textContent = ''; $('#exStem').textContent = ''; box.innerHTML = ''; lastExQid = null; return; }
    $('#exMeta').textContent = (state.idx + 1) + ' / ' + total + ' · ' + (KSB.TYPES[q.type] || q.type)
      + (q.chapter ? ' · ' + q.chapter : '');
    $('#exStem').textContent = q.stem;
    box.dataset.qid = q.id;
    if (q.id !== lastExQid) {
      lastExQid = q.id;
      if (typeof KSB.fxPlay === 'function') {
        KSB.fxPlay($('#exStem'), 'fx-rise');
        KSB.fxPlay(box, 'fx-rise');
      }
    }
    const ans = state.answers.get(q.id);
    let html = '';

    if (q.type === 'fill') {
      const blankCount = Math.max(1, KSB.countBlanks(q.stem));
      for (let i = 0; i < blankCount; i++) {
        const v = ans && Array.isArray(ans) && ans[i] != null ? String(ans[i]) : '';
        html += '<input class="fill-input" data-blank="' + i + '" placeholder="填空 ' + (i + 1) + '" value="' + KSB.esc(v) + '">';
      }
      box.innerHTML = html;
      box.querySelectorAll('.fill-input').forEach(inp => inp.addEventListener('input', () => {
        setAnswer(q, $$('#exOptions .fill-input').map(x => x.value));
        updateExSheet();
      }));
      return;
    }

    const options = q.type === 'judge'
      ? JUDGE_OPTIONS.map(o => ({ val: o.val, text: o.label }))
      : (q.options || []).map(o => ({ val: o.key, text: o.key + '. ' + o.text }));

    if (q.type === 'multiple') {
      options.forEach(o => {
        const checked = ans && Array.isArray(ans) && ans.includes(o.val) ? ' checked' : '';
        html += '<label class="opt" data-val="' + KSB.esc(String(o.val)) + '"><input type="checkbox" value="' + KSB.esc(String(o.val)) + '"' + checked + '> <span>' + KSB.esc(o.text) + '</span></label>';
      });
      box.innerHTML = html;
      box.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
        setAnswer(q, $$('#exOptions input[type=checkbox]:checked').map(i => i.value));
        renderExQuestion();
        updateExSheet();
      }));
      return;
    }

    options.forEach(o => {
      const sel = !isBlankAnswer(q, ans) && String(ans) === String(o.val) ? ' selected' : '';
      html += '<button type="button" class="opt' + sel + '" data-val="' + KSB.esc(String(o.val)) + '"><span>' + KSB.esc(o.text) + '</span></button>';
    });
    box.innerHTML = html;
    box.querySelectorAll('.opt').forEach(btn => btn.addEventListener('click', () => {
      setAnswer(q, btn.dataset.val);
      renderExQuestion();
      updateExSheet();
    }));
  }

  function updateExSheet() {
    const total = state.questions.length;
    let answered = 0;
    const sheet = $('#exSheet');
    sheet.innerHTML = '';
    state.questions.forEach((q, i) => {
      const b = document.createElement('button');
      b.className = 'sheet-cell';
      if (!isBlankAnswer(q, state.answers.get(q.id))) { answered++; b.classList.add('sc-answered'); }
      b.textContent = i + 1;
      b.addEventListener('click', () => { collectCurrentDOM(); state.idx = i; renderExQuestion(); updateExSheet(); });
      sheet.appendChild(b);
    });
    $('#exSheetTitle').textContent = '答题卡（绿=已答 ' + answered + '/' + total + ' · 交卷前可修改）';
  }

  /* ============ 交卷与判分 ============ */
  async function submit(auto) {
    collectCurrentDOM();
    if (state.finished) return;
    const unanswered = state.questions.filter(q => isBlankAnswer(q, state.answers.get(q.id))).length;
    if (auto) { KSB.toast('⏱ 时间到，自动交卷', 'bad'); }
    else if (unanswered && !confirm('还有 ' + unanswered + ' 题未作答，确定交卷吗？')) return;

    state.finished = true;
    stopTimer();

    const rows = [];
    for (const q of state.questions) {
      const user = state.answers.get(q.id);
      const blank = isBlankAnswer(q, user);
      const res = KSB.gradeQuestion(q, blank ? null : user);
      rows.push({
        q,
        state: res.state,
        userText: blank ? '（未作答）' : userTextOf(q, user),
        expected: res.expected,
        detail: res.detail
      });
      if (res.state === 'wrong' && !blank) await KSB.wrongAdd(q, userTextOf(q, user));
    }
    if (typeof KSB.refreshWrongAll === 'function') KSB.refreshWrongAll();

    let correct = 0;
    rows.forEach(r => { if (r.state === 'correct') correct++; });
    const secs = Math.round((Date.now() - state.startedAt) / 1000);
    const mm = Math.floor(secs / 60), ss = secs % 60;
    const timeTxt = (mm ? mm + ' 分 ' : '') + ss + ' 秒';
    const rate = rows.length ? Math.round(correct / rows.length * 100) : 0;
    $('#exResultHead').innerHTML =
      '<div style="font-size:18px;font-weight:700;margin-bottom:6px;">成绩单</div>' +
      '<div>得分：<b style="font-size:20px;">' + correct + ' / ' + rows.length + '</b> · 正确率 ' + rate + '%</div>' +
      '<div class="mode-tip">用时 ' + timeTxt + ' · 答对 ' + correct + ' · 答错 ' + (rows.length - correct) +
      ' · 未答已计错（不进错题本）</div>';

    const wrap = $('#exResultWrap');
    wrap.innerHTML = '';
    rows.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'exr-card';
      const ok = r.state === 'correct';
      const stCls = ok ? 'exr-correct' : 'exr-wrong';
      const stTxt = ok ? '✓ 对' : '✗ 错';
      card.innerHTML =
        '<div class="exr-head"><span class="badge">' + (i + 1) + '. ' + KSB.esc(KSB.TYPES[r.q.type]) + '</span>' +
        '<span class="' + stCls + '">' + stTxt + '</span></div>' +
        '<div class="exr-stem">' + KSB.esc(r.q.stem) + '</div>' +
        '<div class="exr-detail"><b>你的答案：</b>' + KSB.esc(r.userText) + '<br><b>正确答案：</b>' + KSB.esc(r.expected) + '</div>' +
        (r.detail ? '<div class="exr-detail">' + KSB.esc(r.detail) + '</div>' : '') +
        (r.q.analysis ? '<div class="exr-detail"><b>解析：</b>' + KSB.esc(r.q.analysis) + '</div>' : '');
      wrap.appendChild(card);
    });

    $('#examRun').classList.add('hidden');
    $('#examResult').classList.remove('hidden');

    const finishedAt = new Date();
    const bank = await KSB.storeGet('banks', state.bankId);
    await KSB.storePut('history', {
      id: KSB.uid(),
      bankId: state.bankId,
      bankName: bank ? bank.name : '',
      type: 'exam',
      source: 'exam',
      mode: 'rand',
      startedAt: state.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSec: Math.round((finishedAt - state.startedAt) / 1000),
      total: state.questions.length,
      correct,
      wrong: rows.length - correct,
      unanswered,
      ratePct: rate,
      examNote: (state.lastCfg && state.lastCfg.timeM ? state.lastCfg.timeM + '分钟限时' : '不限时')
    });
  }

  function stopTimer() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
  }
  function goConfig() {
    stopTimer();
    state.finished = false;
    $('#examResult').classList.add('hidden');
    $('#examRun').classList.add('hidden');
    $('#examConfig').classList.remove('hidden');
    onShow();
  }

  /* ============ 事件 ============ */
  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      $('#exBank').addEventListener('change', async () => { await refreshNumOptions(); updateNote(); });
      $('#exNum').addEventListener('change', updateNote);
      $('#exTime').addEventListener('change', updateNote);
      $('#btnStartExam').addEventListener('click', start);
      $('#btnExPrev').addEventListener('click', () => { collectCurrentDOM(); if (state.idx > 0) { state.idx--; renderExQuestion(); updateExSheet(); } });
      $('#btnExNext').addEventListener('click', () => { collectCurrentDOM(); if (state.idx < state.questions.length - 1) { state.idx++; renderExQuestion(); updateExSheet(); } });
      $('#btnSubmitExam').addEventListener('click', () => submit(false));
      $('#btnExamAgain').addEventListener('click', goConfig);
      $('#btnExamBack').addEventListener('click', () => {
        const tab = Array.from(document.querySelectorAll('.tab')).find(t => t.dataset.tab === 'practice');
        if (tab) tab.click();
      });
    }
    ready();
  }

  KSB.exam = { onShow, start };
  bindUI();
})();
