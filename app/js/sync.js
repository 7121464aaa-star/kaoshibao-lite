/* sync.js —— 设置页「云同步」（M4）：GitHub Secret Gist 一键推送 / 拉取。
   设计约束（用户拍板，勿回退）：
   - 凭据（token / 用户名）只存本机 IndexedDB settings，绝不写入 gist 快照内容：
     导出走 KSB.exportSnapshot()（内部剥离 sync.token）；拉取忽略远端 settings（保留本机凭据）。
   - 冲突策略 = 后写覆盖 + 自动快照：覆盖前把"被覆盖方"存为本地自动快照，保留最近 N=5 份（model.js）。
   - Gist 内仅一份文件 kaoshibao-lite-snapshot.json（JSON 快照文本），gist 为 Secret（public:false）。
   - 依赖：model.js（exportSnapshot/importSnapshot/saveAutoSnapshot/saveSnapshotOf/listAutoSnapshots/getAutoSnapshot/deleteAutoSnapshot）
            ui.js（KSB.toast / KSB.esc）；加载顺序在 backup.js 之后。
   浏览器注意：fetch 需 https 或 localhost（file:// 下跨域到 api.github.com 依赖其 CORS 放行，token 场景推荐部署到 https 后使用）。 */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const $ = s => document.querySelector(s);
  const API = 'https://api.github.com';
  const FILE = 'kaoshibao-lite-snapshot.json';
  const KEY_USER = 'sync.username';
  const KEY_TOKEN = 'sync.token';
  const KEY_GIST = 'sync.gistId';
  const KEY_LAST_PUSH = 'sync.lastPushAt';
  const KEY_LAST_PULL = 'sync.lastPullAt';

  /* ---------- 凭据（只存本机 settings） ---------- */
  async function loadCred() {
    const [username, token, gistId, lastPush, lastPull] = await Promise.all([
      KSB.getSetting(KEY_USER), KSB.getSetting(KEY_TOKEN), KSB.getSetting(KEY_GIST),
      KSB.getSetting(KEY_LAST_PUSH), KSB.getSetting(KEY_LAST_PULL)
    ]);
    return { username: username || '', token: token || '', gistId: gistId || '', lastPush, lastPull };
  }

  /* ---------- GitHub REST ---------- */
  async function gh(path, opts) {
    const token = (await KSB.getSetting(KEY_TOKEN)) || '';
    if (!token) throw new Error('未填写 Personal Access Token');
    opts = opts || {};
    const headers = Object.assign({
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, opts.headers || {});   // 先并 headers：Authorization 永不被 opts 覆盖
    const init = { method: opts.method || 'GET', headers: headers };
    if (opts.body) init.body = opts.body;
    const res = await fetch(API + path, init);
    if (res.status === 401 || res.status === 403) {
      throw new Error('GitHub 拒绝访问（HTTP ' + res.status + '）：token 无效、已过期，或缺少 gist 权限（请用仅勾选 gist 的 token）');
    }
    if (!res.ok) {
      let msg = '';
      try { const e = await res.json(); msg = (e.message || ''); } catch (e2) { /* ignore */ }
      throw new Error('GitHub API 失败（HTTP ' + res.status + '）：' + (msg || res.statusText));
    }
    return res.status === 204 ? null : res.json();
  }

  function ghBody(data) {
    return { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } };
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  /* 业务内容比较：只看会被同步/导入覆盖的 5 个 store（settings 永不导入，不参与比较）。
     避免因 exportedAt 时间戳每次导出都变、或两端 settings 不同而误判冲突。 */
  const BIZ_STORES = ['banks', 'questions', 'wrong', 'stars', 'history'];
  function bizKey(snap) {
    const d = (snap && snap.data) || {};
    const o = {};
    for (const s of BIZ_STORES) o[s] = d[s] || [];
    return JSON.stringify(o);
  }
  function bizEqual(a, b) { return bizKey(a) === bizKey(b); }

  /* ---------- 推送：本机 → Secret Gist ---------- */
  async function pushToCloud() {
    const cred = await loadCred();
    if (!cred.token) throw new Error('请先填写 Personal Access Token 并保存');
    const json = await KSB.exportSnapshotJSON();
    const localSnap = JSON.parse(json);
    let gistId = cred.gistId;
    let cloudSaved = false;

    if (gistId) {
      // 覆盖前先探测云端旧内容：业务内容与本地不同则存为自动快照（防他设备数据丢失）
      try {
        const g = await gh('/gists/' + encodeURIComponent(gistId));
        const f = g.files && g.files[FILE];
        if (f && f.content) {
          const old = JSON.parse(f.content);
          if (old && old.app === 'kaoshibao-lite' && !bizEqual(old, localSnap)) {
            await KSB.saveSnapshotOf(old, 'cloud', '云端旧数据（被本机覆盖前自动保存）');
            cloudSaved = true;
          }
        }
      } catch (e) {
        // 404 或解析失败 → 视为 gist 失效，重新创建
        if (/404|失效/.test(e.message) || e.message.indexOf('HTTP 404') >= 0) { gistId = ''; }
        else throw e;
      }
    }

    if (!gistId) {
      const files0 = {};
      files0[FILE] = { content: json };
      const created = await gh('/gists', Object.assign({ method: 'POST' }, ghBody({
        description: '考试宝自用版（kaoshibao-lite）数据快照 · 自动云同步，请勿删除',
        public: false,
        files: files0
      })));
      gistId = created.id;
      await KSB.setSetting(KEY_GIST, gistId);
      await KSB.setSetting(KEY_LAST_PUSH, new Date().toISOString());
      return { gistId: gistId, cloudSaved: cloudSaved };
    }

    // 写入/覆盖文件
    const files = {};
    files[FILE] = { content: json };
    await gh('/gists/' + encodeURIComponent(gistId), Object.assign({ method: 'PATCH' }, ghBody({ files: files })));
    await KSB.setSetting(KEY_LAST_PUSH, new Date().toISOString());
    return { gistId: gistId, cloudSaved: cloudSaved };
  }

  /* ---------- 拉取：Secret Gist → 本机（覆盖前自动快照本地） ---------- */
  async function pullFromCloud() {
    const cred = await loadCred();
    if (!cred.token) throw new Error('请先填写 Personal Access Token 并保存');
    if (!cred.gistId) throw new Error('尚未关联 Gist：请先在设置页点「推送到云端」完成首次上传，或在下方填写已建好的 Gist ID');

    const g = await gh('/gists/' + encodeURIComponent(cred.gistId));
    const f = g.files && g.files[FILE];
    if (!f || !f.content) throw new Error('该 Gist 中未找到数据文件（' + FILE + '）');
    let remote;
    try { remote = JSON.parse(f.content); }
    catch (e) { throw new Error('云端数据解析失败：不是有效的 JSON'); }
    if (!remote || remote.app !== 'kaoshibao-lite') {
      throw new Error('云端数据不是有效的考试宝自用版快照（缺少 app 标识）');
    }
    return { remote: remote, cloudUpdatedAt: f.updated_at || null };
  }

  /* 执行"用云端覆盖本机"：确认后 存本地自动快照 → importSnapshot → 刷新 */
  async function applyRemote(remote, cloudUpdatedAt, force) {
    const local = await KSB.exportSnapshot();
    const same = bizEqual(local, remote);
    if (same) return { same: true };

    const localTxt = '本机：' + fmtTime(local.exportedAt);
    const cloudTxt = '云端：' + fmtTime(cloudUpdatedAt || remote.exportedAt);
    if (!force && !confirm('用云端数据覆盖本机？（冲突策略=后写覆盖，覆盖前会先把本机当前数据存为自动快照，可随时还原）\n\n' + cloudTxt + '\n' + localTxt)) {
      return { cancelled: true };
    }
    await KSB.saveAutoSnapshot('pull', '拉取云端前自动保存本机数据');
    await KSB.importSnapshot(remote);
    await KSB.setSetting(KEY_LAST_PULL, new Date().toISOString());
    return { replaced: true };
  }

  /* ---------- UI ---------- */
  function esc(s) { return KSB.esc ? KSB.esc(s) : String(s); }

  function reportEl() { return $('#synReport'); }
  function showReport(cls, html) {
    const r = reportEl();
    if (!r) return;
    r.className = 'imp-report ' + (cls || '');
    r.innerHTML = html;
  }
  function clearReport() { showReport('', ''); }

  async function refreshStatus() {
    const cred = await loadCred();
    const u = $('#synUser'); const t = $('#synToken'); const g = $('#synGist');
    if (u) u.value = cred.username;
    if (t) t.value = cred.token;
    if (g) g.value = cred.gistId;
    const info = $('#synInfo');
    if (info) {
      const counts = await KSB.countAll().catch(() => null);
      const snaps = await KSB.listAutoSnapshots().catch(() => []);
      info.innerHTML = '用户名：' + esc(cred.username || '—') +
        ' · 已关联 Gist：' + esc(cred.gistId ? cred.gistId.slice(0, 12) + '…' : '否') +
        '<br>上次推送：' + fmtTime(cred.lastPush) + ' · 上次拉取：' + fmtTime(cred.lastPull) +
        (counts ? '<br>本机数据：题库 ' + counts.banks + ' · 题目 ' + counts.questions + ' · 错题 ' + counts.wrong + ' · 收藏 ' + counts.stars + ' · 历史 ' + counts.history : '') +
        '<br>自动快照（冲突覆盖前自动保存，最多保留 ' + KSB.SNAPSHOT_KEEP + ' 份）：' + snaps.length + ' 份';
    }
    renderSnapshots();
  }

  async function renderSnapshots() {
    const box = $('#synSnapList');
    if (!box) return;
    const snaps = await KSB.listAutoSnapshots().catch(() => []);
    if (!snaps.length) { box.innerHTML = '<div class="form-note">暂无自动快照。推送/拉取发生覆盖时会自动保存，可在覆盖后回滚。</div>'; return; }
    box.innerHTML = snaps.map(s =>
      '<div class="syn-snap-item"><div class="syn-snap-meta"><b>' +
      ({ push: '推送前', pull: '拉取前', cloud: '云端旧数据' }[s.kind] || s.kind) + '</b> · ' +
      esc(fmtTime(s.at)) + (s.note ? ' · ' + esc(s.note) : '') + '</div>' +
      '<div class="action-row"><button class="btn btn-xs btn-primary" data-syn-restore="' + esc(s.id) + '">还原此快照</button>' +
      '<button class="btn btn-xs" data-syn-del="' + esc(s.id) + '">删除</button></div></div>'
    ).join('');
  }

  async function restoreSnapshot(id) {
    const it = await KSB.getAutoSnapshot(id);
    if (!it || !it.snapshot) { showReport('bad', '快照不存在或已损坏'); return; }
    const cur = await KSB.countAll();
    const s = it.snapshot;
    const cnt = k => Array.isArray(s.data && s.data[k]) ? s.data[k].length : 0;
    if (!confirm('还原该自动快照到本机？（先自动保存当前数据，可再回滚）\n\n快照时间：' + fmtTime(it.at) +
      '\n快照内容：题库 ' + cnt('banks') + ' · 题目 ' + cnt('questions') + ' · 错题 ' + cnt('wrong') + ' · 收藏 ' + cnt('stars') + ' · 历史 ' + cnt('history') +
      '\n当前本机：题库 ' + cur.banks + ' · 题目 ' + cur.questions + ' · 错题 ' + cur.wrong + ' · 收藏 ' + cur.stars + ' · 历史 ' + cur.history)) return;
    await KSB.saveAutoSnapshot('restore', '还原快照前自动保存当前数据');
    await KSB.importSnapshot(s);
    showReport('ok', '✓ 已还原该自动快照，正在刷新界面…');
    setTimeout(() => window.location.reload(), 700);
  }

  async function saveCred() {
    const u = ($('#synUser').value || '').trim();
    const t = ($('#synToken').value || '').trim();
    const g = ($('#synGist').value || '').trim();
    if (t) await KSB.setSetting(KEY_TOKEN, t);
    else await KSB.setSetting(KEY_TOKEN, '');
    await KSB.setSetting(KEY_USER, u);
    await KSB.setSetting(KEY_GIST, g);
    await refreshStatus();
    if (KSB.toast) KSB.toast(t ? '✓ 凭据已保存（仅存本机）' : '已清空凭据', 'ok');
  }

  /* 结果落盘 + 汇报（push 入口） */
  async function doPush() {
    clearReport();
    try {
      const r = await pushToCloud();
      await KSB.setSetting(KEY_GIST, r.gistId);
      await refreshStatus();
      showReport('ok',
        '✓ 已推送到云端 Secret Gist（ID: ' + esc(r.gistId) + '）' +
        (r.cloudSaved ? '<br><b>注</b>：覆盖前已把云端旧数据自动存为本地快照（可在下方还原）。' : '') +
        '<br><a target="_blank" rel="noopener" href="https://gist.github.com/' + esc(r.gistId) + '">在 GitHub 中查看该 Gist →</a>');
      if (KSB.toast) KSB.toast('✓ 云端同步完成', 'ok');
    } catch (e) {
      showReport('bad', '推送失败：' + esc(e.message));
      if (KSB.toast) KSB.toast('推送失败', 'bad');
    }
  }

  /* 拉取入口：先只读，报告差异，再经确认覆盖 */
  async function doPull() {
    clearReport();
    let got;
    try { got = await pullFromCloud(); }
    catch (e) { showReport('bad', '拉取失败：' + esc(e.message)); if (KSB.toast) KSB.toast('拉取失败', 'bad'); return; }
    try {
      const out = await applyRemote(got.remote, got.cloudUpdatedAt, false);
      if (out.same) { showReport('ok', '云端与本机一致（导出时间相同），无需覆盖。'); return; }
      if (out.cancelled) { showReport('', '已取消，本机数据未改动。'); return; }
      await refreshStatus();
      showReport('ok', '✓ 已从云端覆盖本机，正在刷新界面…');
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      showReport('bad', '拉取失败：' + esc(e.message));
    }
  }

  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      const btnSave = $('#btnSynSave');
      const btnPush = $('#btnSynPush');
      const btnPull = $('#btnSynPull');
      const list = $('#synSnapList');
      if (btnSave) btnSave.addEventListener('click', saveCred);
      if (btnPush) btnPush.addEventListener('click', doPush);
      if (btnPull) btnPull.addEventListener('click', doPull);
      if (list) list.addEventListener('click', async e => {
        const r = e.target.closest('[data-syn-restore]');
        const d = e.target.closest('[data-syn-del]');
        if (r) await restoreSnapshot(r.getAttribute('data-syn-restore'));
        if (d) { await KSB.deleteAutoSnapshot(d.getAttribute('data-syn-del')); renderSnapshots(); }
      });
    }
    ready();
  }

  function onShow() { refreshStatus(); }

  bindUI();
  KSB.sync = {
    onShow: onShow,
    refreshStatus: refreshStatus,
    // 供自动化冒烟/测试调用
    _api: { pushToCloud: pushToCloud, pullFromCloud: pullFromCloud, applyRemote: applyRemote, loadCred: loadCred, KEY_FILE: FILE }
  };
})();
