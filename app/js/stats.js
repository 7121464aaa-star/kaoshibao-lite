/* stats.js —— 学习统计：汇总卡片 + 近14天答题量 + 练习/考试历史列表 */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  function dayKey(d) { return d.toISOString().slice(0, 10); }

  async function render() {
    const history = await KSB.storeGetAll('history');
    const wrongs = await KSB.storeGetAll('wrong');
    const stars = await KSB.storeGetAll('stars');
    const banks = await KSB.storeGetAll('banks');
    const bname = new Map(banks.map(b => [b.id, b.name]));

    history.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    let sumC = 0, sumW = 0, sumA = 0;
    history.forEach(h => { sumC += (h.correct || 0); sumW += (h.wrong || 0); sumA += (h.correct || 0) + (h.wrong || 0); });
    const rate = sumA ? Math.round(sumC / sumA * 100) : 0;

    const cards = $('#statCards');
    cards.innerHTML = '';
    const items = [
      ['累计记录', String(history.length), '次（练习+考试）'],
      ['累计答题', String(sumA), '对 ' + sumC + ' · 错 ' + sumW],
      ['综合正确率', rate ? rate + '%' : '—', '按已判答题计算'],
      ['错题数', String(wrongs.length), '全库累计'],
      ['收藏数', String(stars.length), '全库累计']
    ];
    items.forEach(([l, v, sub]) => {
      const d = document.createElement('div');
      d.className = 'stat-card';
      d.innerHTML = '<div class="v">' + KSB.esc(v) + '</div><div class="l">' + KSB.esc(l) + '</div><div class="l">' + KSB.esc(sub) + '</div>';
      cards.appendChild(d);
    });

    // 近 14 天
    const barsEl = $('#dailyBars');
    const byDay = {};
    history.forEach(h => {
      const k = dayKey(new Date(h.startedAt));
      byDay[k] = byDay[k] || { c: 0, w: 0 };
      byDay[k].c += (h.correct || 0);
      byDay[k].w += (h.wrong || 0);
    });
    if (!history.length) {
      barsEl.innerHTML = '<div class="hist-empty">还没有记录，先去刷几道题吧</div>';
    } else {
      barsEl.innerHTML = '';
      const maxV = Math.max(1, ...Object.values(byDay).map(d => d.c + d.w));
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const k = dayKey(d);
        const v = byDay[k] || { c: 0, w: 0 };
        const col = document.createElement('div');
        col.className = 'day-col';
        const total = v.c + v.w;
        const hC = Math.round(v.c / maxV * 56), hW = Math.round(v.w / maxV * 56);
        col.innerHTML =
          '<div class="day-bars">' +
          (v.w ? '<div class="day-bar no" style="height:' + Math.max(2, hW) + 'px" title="错' + v.w + '"></div>' : '') +
          (v.c ? '<div class="day-bar ok" style="height:' + Math.max(2, hC) + 'px" title="对' + v.c + '"></div>' : '') +
          '</div>' +
          '<div class="day-label">' + (total ? total : '·') + '<br>' + (d.getMonth() + 1) + '/' + d.getDate() + '</div>';
        barsEl.appendChild(col);
      }
    }

    // 历史列表
    const hist = $('#histList');
    if (!history.length) {
      hist.innerHTML = '<div class="hist-empty">暂无练习/考试记录</div>';
    } else {
      hist.innerHTML = history.slice(0, 20).map(h => {
        const typeTxt = h.type === 'exam' ? '📝 模拟考试' : '📖 练习';
        const srcTxt = h.type === 'practice' && h.source !== 'all' ? '（' + (h.source === 'wrong' ? '错题重练' : '收藏') + '）' : '';
        const when = new Date(h.startedAt).toLocaleString();
        const dur = h.durationSec != null ? ' · ' + h.durationSec + 's' : '';
        return '<div class="hist-item"><span><b>' + KSB.esc(typeTxt) + '</b> ' +
          KSB.esc((bname.get(h.bankId) || h.bankName || '?') + srcTxt) + '<br>' +
          '<span class="mode-tip">' + KSB.esc(when + dur) + (h.examNote ? ' · ' + KSB.esc(h.examNote) : '') + '</span></span>' +
          '<span class="hist-rate">' + KSB.esc(h.total + '题 · 对' + h.correct + ' · 错' + h.wrong) +
          '<br><b style="color:var(--primary)">' + (h.ratePct != null ? h.ratePct + '%' : '') + '</b></span></div>';
      }).join('');
    }
  }

  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      $('#btnHistClear').addEventListener('click', async () => {
        if (!confirm('确定清空全部练习/考试历史记录？此操作不可恢复。')) return;
        await KSB.storeClear('history');
        render();
        if (window.KSB && KSB.toast) KSB.toast('已清空历史', 'ok');
      });
    }
    ready();
  }

  KSB.stats = { render };
  bindUI();
})();
