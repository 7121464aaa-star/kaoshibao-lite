/* backup.js —— 设置页 备份/恢复（M3）：导出整库 JSON 快照（下载）、从文件恢复（整体替换）。
   复用 model.js 的 exportSnapshot / exportSnapshotJSON / importSnapshot；
   恢复前先自动下载一份当前数据备份，再整体替换并重载界面。 */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);

  function pad(n) { return String(n).padStart(2, '0'); }
  function stamp() {
    const d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function downloadJSON(obj, name) {
    const blob = new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function refreshInfo() {
    const info = $('#bakInfo');
    const c = await KSB.countAll();
    const last = await KSB.getSetting('lastBackupAt');
    info.textContent = '当前数据：题库 ' + c.banks + ' · 题目 ' + c.questions + ' · 错题 ' + c.wrong +
      ' · 收藏 ' + c.stars + ' · 历史记录 ' + c.history +
      (last ? '。上次导出备份：' + new Date(last).toLocaleString() : '。尚未导出过备份。');
  }

  async function exportBackup() {
    try {
      const json = await KSB.exportSnapshotJSON();
      downloadJSON(json, 'kaoshibao-lite-备份-' + stamp() + '.json');
      await KSB.setSetting('lastBackupAt', new Date().toISOString());
      refreshInfo();
      if (KSB.toast) KSB.toast('✓ 备份已导出（浏览器下载区）', 'ok');
    } catch (e) {
      if (KSB.toast) KSB.toast('导出失败：' + e.message, 'bad');
    }
  }

  function hideReport() {
    const r = $('#bakReport');
    r.classList.add('hidden');
    r.classList.remove('ok', 'bad');
    r.innerHTML = '';
  }

  function showReport(cls, html) {
    const r = $('#bakReport');
    r.className = 'imp-report ' + cls;
    r.innerHTML = html;
  }

  /* 解析并预览备份文件；确认后：自动备份当前数据 → 整体替换 → 重载 */
  function handleFile(file) {
    hideReport();
    if (!file) return;
    if (!/\.json$/i.test(file.name)) { showReport('bad', '请选择 .json 备份文件'); return; }
    const reader = new FileReader();
    reader.onerror = () => showReport('bad', '文件读取失败');
    reader.onload = () => {
      let snap;
      try { snap = JSON.parse(String(reader.result)); }
      catch (e) { showReport('bad', 'JSON 解析失败：' + e.message); return; }
      if (!snap || snap.app !== 'kaoshibao-lite') { showReport('bad', '不是有效的考试宝自用版备份文件（缺少 app 标识）'); return; }
      const data = snap.data || {};
      const cnt = (k) => Array.isArray(data[k]) ? data[k].length : 0;
      showReport('', // 中间态：等用户点确认
        '<div><b>将恢复备份文件：</b>' + KSB.esc(file.name) + '</div>' +
        '<div class="form-note">版本 ' + KSB.esc(snap.modelVersion || '?') + ' · 导出于 ' +
          KSB.esc(snap.exportedAt ? new Date(snap.exportedAt).toLocaleString() : '?') + '</div>' +
        '<div class="form-note">备份内容：题库 ' + cnt('banks') + ' · 题目 ' + cnt('questions') +
          ' · 错题 ' + cnt('wrong') + ' · 收藏 ' + cnt('stars') + ' · 历史记录 ' + cnt('history') + '</div>' +
        '<div class="form-note"><b>⚠ 恢复=整体替换</b>：当前全部数据将被备份内容覆盖。确认前会自动下载一份当前数据备份，以便反悔时还原。</div>' +
        '<div class="action-row"><button id="btnBakDoRestore" class="btn btn-danger">确认恢复（先自动备份当前数据）</button>' +
        '<button id="btnBakCancelRestore" class="btn">取消</button></div>');
      $('#btnBakCancelRestore').addEventListener('click', hideReport);
      $('#btnBakDoRestore').addEventListener('click', async () => {
        try {
          $('#btnBakDoRestore').disabled = true;
          // 1) 先自动导出当前数据（防误恢复）
          try {
            const cur = await KSB.exportSnapshotJSON();
            downloadJSON(cur, 'kaoshibao-lite-恢复前自动备份-' + stamp() + '.json');
          } catch (e) { /* 自动备份失败不阻断 */ }
          // 2) 整体替换
          await KSB.importSnapshot(snap);
          showReport('ok', '✓ 恢复完成，正在刷新界面…');
          setTimeout(() => window.location.reload(), 600);
        } catch (e) {
          $('#btnBakDoRestore').disabled = false;
          showReport('bad', '恢复失败：' + e.message + '（当前数据未被改动）');
        }
      });
    };
    reader.readAsText(file);
  }

  function onShow() {
    refreshInfo();
  }

  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      $('#btnExportBak').addEventListener('click', exportBackup);
      $('#bakFile').addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (f) handleFile(f);
        e.target.value = '';
      });
    }
    ready();
  }

  KSB.backup = { onShow, exportBackup };
  bindUI();
})();
