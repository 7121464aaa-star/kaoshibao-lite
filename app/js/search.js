/* search.js —— 本地关键词搜题（M3）：按题干/选项/解析/章节 匹配，空格分隔多词 AND。
   范围：当前题库 / 全部题库。动作：查看答案/解析、收藏、直接练习该题。 */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const scope = { cur: 'bank' }; // 'bank' | 'all'
  const expanded = new Set();    // 已展开答案的 qid

  function qHaystack(q) {
    const parts = [q.stem, q.analysis || '', q.chapter || ''];
    (q.options || []).forEach(o => parts.push(o.text));
    return KSB.norm(parts.join(' '));
  }

  async function collectPool() {
    if (scope.cur === 'bank') {
      const bid = $('#bankSelect') && $('#bankSelect').value;
      if (!bid) return [];
      const bank = await KSB.storeGet('banks', bid);
      const qs = await KSB.getBankQuestions(bid);
      return qs.map(q => Object.assign({ _bankName: bank ? bank.name : '' }, q));
    }
    const banks = await KSB.storeGetAll('banks');
    const bname = new Map(banks.map(b => [b.id, b.name]));
    const all = await KSB.storeGetAll('questions');
    return all.map(q => Object.assign({ _bankName: bname.get(q.bankId) || '' }, q));
  }

  async function runSearch() {
    const kw = $('#searchInput').value.trim();
    const report = $('#searchReport');
    report.classList.add('hidden');
    if (!kw) { $('#searchList').innerHTML = '<div class="empty-tip">输入关键词开始搜题（可多个词，空格分隔）</div>'; return; }
    const tokens = kw.split(/\s+/).map(t => KSB.norm(t)).filter(Boolean);
    const pool = await collectPool();
    const hits = pool.filter(q => {
      const hay = qHaystack(q);
      return tokens.every(t => hay.includes(t));
    }).sort((a, b) => {
      // 当前题库靠前，其余按 bankId + id
      if (a.bankId !== b.bankId) return a.bankId < b.bankId ? -1 : 1;
      return a.id.localeCompare(b.id, 'en', { numeric: true });
    });
    const starSet = new Set((await KSB.storeGetAll('stars')).map(s => s.qid));
    const show = hits.slice(0, 200);
    report.classList.remove('hidden');
    report.className = 'imp-report ' + (show.length ? 'ok' : 'bad');
    report.innerHTML = hits.length
      ? '匹配 ' + hits.length + ' 题' + (hits.length > show.length ? '（仅显示前 200 条，请用更精确关键词）' : '')
      : '没有匹配的题目。可减少关键词或改用"全部题库"范围。';
    if (!show.length) { $('#searchList').innerHTML = ''; return; }
    $('#searchList').innerHTML = '';
    for (const q of show) {
      const card = document.createElement('div');
      card.className = 'wrong-card';
      const isStar = starSet.has(q.id);
      const typeName = KSB.TYPES[q.type] || q.type;
      const chTxt = q.chapter ? ' · ' + KSB.esc(q.chapter) : '';
      const bankTxt = scope.cur === 'all' ? ' · ' + KSB.esc(q._bankName) : '';
      const ansHtml = expanded.has(q.id)
        ? '<div class="wrong-answer"><b>正确答案：</b>' + KSB.esc(KSB.answerText(q)) + '</div>' +
          (q.analysis ? '<div class="wrong-answer"><b>解析：</b>' + KSB.esc(q.analysis) + '</div>' : '')
        : '';
      card.innerHTML =
        '<div class="wrong-head"><span class="badge">' + KSB.esc(typeName) + chTxt + bankTxt + '</span>' +
        '<span class="wrong-meta">' + (isStar ? '★' : '☆') + '</span></div>' +
        '<div class="wrong-stem">' + KSB.esc(q.stem) + '</div>' + ansHtml +
        '<div class="action-row">' +
        '<button class="btn btn-xs" data-act="toggle-ans" data-qid="' + KSB.esc(q.id) + '">' + (expanded.has(q.id) ? '收起答案' : '看答案') + '</button>' +
        '<button class="btn btn-xs" data-act="toggle-star" data-qid="' + KSB.esc(q.id) + '">' + (isStar ? '取消收藏' : '☆ 收藏') + '</button>' +
        '<button class="btn btn-xs btn-primary" data-act="do-practice" data-qid="' + KSB.esc(q.id) + '" data-bank="' + KSB.esc(q.bankId) + '">去练习</button>' +
        '</div>';
      $('#searchList').appendChild(card);
    }
  }

  function onShow() {
    const sel = $('#bankSelect');
    // 显示当前题库名提示
    const scopeTip = $('#searchReport');
    void scopeTip;
    // 若输入框为空，展示引导
    if (!$('#searchInput').value.trim()) $('#searchList').innerHTML = '<div class="empty-tip">输入关键词开始搜题（可多个词，空格分隔）</div>';
    void sel;
  }

  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      $$('#view-search .chip[data-qscope]').forEach(c => c.addEventListener('click', () => {
        scope.cur = c.dataset.qscope;
        $$('#view-search .chip[data-qscope]').forEach(x => x.classList.toggle('active', x === c));
        runSearch();
      }));
      $('#btnSearch').addEventListener('click', runSearch);
      $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
      $('#btnSearchReset').addEventListener('click', () => {
        $('#searchInput').value = '';
        expanded.clear();
        $('#searchReport').classList.add('hidden');
        $('#searchList').innerHTML = '<div class="empty-tip">输入关键词开始搜题（可多个词，空格分隔）</div>';
      });
      $('#searchList').addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const qid = btn.dataset.qid;
        const q = await KSB.storeGet('questions', qid);
        if (btn.dataset.act === 'toggle-ans') {
          if (expanded.has(qid)) expanded.delete(qid); else expanded.add(qid);
          runSearch();
        } else if (btn.dataset.act === 'toggle-star') {
          if (!q) { KSB.toast('题目不存在', 'bad'); return; }
          const starred = await KSB.starToggle(q);
          KSB.toast(starred ? '已收藏 ★' : '已取消收藏', starred ? 'ok' : '');
          runSearch();
        } else if (btn.dataset.act === 'do-practice') {
          if (!q) { KSB.toast('题目不存在', 'bad'); return; }
          const bid = btn.dataset.bank;
          if (KSB.uiHooks && typeof KSB.uiHooks.practiceQuestion === 'function') {
            await KSB.uiHooks.practiceQuestion(bid, qid, 'all');
          }
        }
      });
    }
    ready();
  }

  KSB.search = { onShow, runSearch };
  bindUI();
})();
