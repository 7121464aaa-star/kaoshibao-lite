/* bank-mgmt.js —— 题库管理：新建 / 重命名 / 删除(级联清理题目与错题) / 多题库合并 / 列表展示 */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  async function listWithCounts() {
    const banks = await KSB.storeGetAll('banks');
    const counts = {};
    for (const b of banks) {
      const qs = await KSB.getBankQuestions(b.id);
      counts[b.id] = qs.length;
    }
    return { banks, counts };
  }

  function fillMergeSelects(banks, keepSrc, keepDst) {
    const src = $('#mergeSrc'), dst = $('#mergeDst');
    if (!src || !dst) return;
    const mk = (sel, keep) => {
      sel.innerHTML = '';
      banks.forEach(b => {
        const o = document.createElement('option');
        o.value = b.id; o.textContent = b.name;
        sel.appendChild(o);
      });
      if (banks.length >= 2) {
        if (keep && banks.some(b => b.id === keep)) sel.value = keep;
        else {
          // 默认 src=第一项 dst=第二项
          sel.value = sel === src ? banks[0].id : (banks[1] ? banks[1].id : banks[0].id);
        }
      }
    };
    mk(src, keepSrc);
    mk(dst, keepDst);
    if (src.value === dst.value && banks.length >= 2) {
      dst.value = banks.find(b => b.id !== src.value) ? banks.find(b => b.id !== src.value).id : '';
    }
  }

  async function renderBanks() {
    const listEl = $('#bankList');
    if (!listEl) return;
    const { banks, counts } = await listWithCounts();
    const mergeCard = $('#mergeCard');
    if (mergeCard) {
      const can = banks.length >= 2;
      mergeCard.classList.toggle('hidden', !can);
      if (can) {
        const keepSrc = $('#mergeSrc') && $('#mergeSrc').value;
        const keepDst = $('#mergeDst') && $('#mergeDst').value;
        fillMergeSelects(banks, keepSrc && banks.some(b => b.id === keepSrc) ? keepSrc : null, keepDst && banks.some(b => b.id === keepDst) ? keepDst : null);
      }
    }
    if (!banks.length) {
      listEl.innerHTML = '<div class="empty-tip">还没有题库。去"导入题库"导入你的题目，或点右上角新建。</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const b of banks) {
      const card = document.createElement('div');
      card.className = 'bank-card';
      card.dataset.id = b.id;
      const n = counts[b.id] || 0;
      const created = new Date(b.createdAt).toLocaleDateString();
      card.innerHTML =
        '<div class="bank-info">' +
        '<div class="bank-name">' + KSB.esc(b.name) + '</div>' +
        (b.description ? '<div class="bank-desc">' + KSB.esc(b.description) + '</div>' : '') +
        '<div class="bank-meta">' + n + ' 题 · 创建于 ' + KSB.esc(created) + '</div>' +
        '</div>' +
        '<div class="bank-actions">' +
        '<button class="btn btn-primary btn-xs" data-act="practice">刷题</button>' +
        '<button class="btn btn-xs" data-act="rename">重命名</button>' +
        '<button class="btn btn-danger btn-xs" data-act="delete">删除</button>' +
        '</div>';
      listEl.appendChild(card);
    }
  }

  function notify(bankId) {
    if (window.KSB && typeof KSB.notifyBankDataChanged === 'function') {
      KSB.notifyBankDataChanged(bankId);
    } else if (window.KSB && KSB.uiHooks && typeof KSB.uiHooks.banksChanged === 'function') {
      KSB.uiHooks.banksChanged(bankId);
    }
  }

  async function createBank(name, description) {
    const now = new Date().toISOString();
    const bank = {
      id: KSB.uid(),
      name: (name || '').trim() || '未命名题库',
      description: (description || '').trim(),
      createdAt: now,
      updatedAt: now
    };
    await KSB.storePut('banks', bank);
    return bank.id;
  }

  async function renameBank(id) {
    const bank = await KSB.storeGet('banks', id);
    if (!bank) return;
    const name = prompt('新题库名称：', bank.name);
    if (name == null || !name.trim()) return;
    bank.name = name.trim();
    bank.updatedAt = new Date().toISOString();
    await KSB.storePut('banks', bank);
    notify(id);
  }

  async function deleteBank(id) {
    const bank = await KSB.storeGet('banks', id);
    if (!bank) return;
    const qs = await KSB.getBankQuestions(id);
    if (!confirm('确定删除题库「' + bank.name + '」？\n将同时删除其中 ' + qs.length + ' 道题及其错题记录，且无法撤销！')) return;
    const questions = await KSB.getBankQuestions(id);
    const wrongs = await KSB.storeGetAllBy('wrong', 'bankId', id);
    const t = KSB.db.transaction(['banks', 'questions', 'wrong'], 'readwrite');
    const qStore = t.objectStore('questions');
    questions.forEach(q => qStore.delete(q.id));
    const wStore = t.objectStore('wrong');
    wrongs.forEach(w => wStore.delete(w.qid));
    t.objectStore('banks').delete(id);
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    notify(null);
  }

  /* 多题库合并：把源题库全部题目移入目标题库，错题/收藏记录随迁（qid 全局唯一无冲突），
     源题库删除；事务内完成。 */
  async function mergeBank(srcId, dstId) {
    if (!srcId || !dstId || srcId === dstId) return;
    const srcBank = await KSB.storeGet('banks', srcId);
    const dstBank = await KSB.storeGet('banks', dstId);
    if (!srcBank || !dstBank) return;
    const questions = await KSB.getBankQuestions(srcId);
    const wrongs = await KSB.storeGetAllBy('wrong', 'bankId', srcId);
    const stars = await KSB.storeGetAllBy('stars', 'bankId', srcId);
    const msg = '把题库「' + srcBank.name + '」的 ' + questions.length + ' 道题全部合并到「' +
      dstBank.name + '」？\n错题 ' + wrongs.length + ' 条、收藏 ' + stars.length +
      ' 条将随题目迁移，源题库将被删除（历史记录保留原名）。\n此操作不可撤销！';
    if (!confirm(msg)) return;
    const t = KSB.db.transaction(['banks', 'questions', 'wrong', 'stars'], 'readwrite');
    const qStore = t.objectStore('questions');
    questions.forEach(q => { q.bankId = dstId; qStore.put(q); });
    const wStore = t.objectStore('wrong');
    wrongs.forEach(w => { w.bankId = dstId; wStore.put(w); });
    const sStore = t.objectStore('stars');
    stars.forEach(s => { s.bankId = dstId; sStore.put(s); });
    t.objectStore('banks').delete(srcId);
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    notify(dstId);
    await renderBanks();
    if (window.KSB && KSB.toast) KSB.toast('✓ 已合并：' + questions.length + ' 题移入「' + dstBank.name + '」', 'ok');
  }

  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      $('#btnNewBank').addEventListener('click', () => {
        $('#newBankForm').classList.toggle('hidden');
        $('#nbName').focus();
      });
      $('#btnNbCancel').addEventListener('click', () => $('#newBankForm').classList.add('hidden'));
      $('#btnNbOk').addEventListener('click', async () => {
        const id = await createBank($('#nbName').value, $('#nbDesc').value);
        $('#nbName').value = ''; $('#nbDesc').value = '';
        $('#newBankForm').classList.add('hidden');
        notify(id);
        await renderBanks();
        if (window.KSB && KSB.toast) KSB.toast('✓ 已创建题库', 'ok');
      });
      $('#nbName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnNbOk').click(); });
      const mergeBtn = $('#btnMerge');
      if (mergeBtn) mergeBtn.addEventListener('click', () => {
        mergeBank($('#mergeSrc').value, $('#mergeDst').value);
      });
      $('#bankList').addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const card = btn.closest('.bank-card');
        const id = card ? card.dataset.id : null;
        if (!id) return;
        const act = btn.dataset.act;
        if (act === 'practice') {
          if (KSB.uiHooks && typeof KSB.uiHooks.practiceBank === 'function') KSB.uiHooks.practiceBank(id);
        } else if (act === 'rename') await renameBank(id);
        else if (act === 'delete') await deleteBank(id);
        await renderBanks();
      });
    }
    ready();
  }

  KSB.renderBankMgmt = renderBanks;
  bindUI();
})();
