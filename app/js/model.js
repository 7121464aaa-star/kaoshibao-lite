/* model.js —— 数据契约实现：ID/题型常量、归一化工具、IndexedDB 封装、种子数据、快照导出
   契约见 docs/数据模型与判分规则.md */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};

  // ---------- 工具 ----------
  KSB.uid = function () {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  /* 归一化：去首尾空白、全角→半角、统一小写（用于填空/搜题比对） */
  KSB.norm = function (s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .trim().toLowerCase();
  };

  // ---------- 题型 ----------
  KSB.TYPES = { single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题' };

  /* 统计题干中的填空标记数量：全角（　）、两个及以上下划线、【　】 */
  KSB.countBlanks = function (stem) {
    const m = String(stem || '').match(/（\s*）|_{2,}|【\s*】/g);
    return m ? m.length : 1;
  };

  // ---------- IndexedDB ----------
  const DB_NAME = 'ksb-lite';
  const DB_VERSION = 3;   // v3（M4）：新增 snapshots store（一键同步冲突自动快照，保留最近 N 份）
  /* 业务 store：随快照导出/导入（备份、云同步共用）。settings 仅存本机配置；
     其中敏感键（sync.token 等）导出时剥离；导入时默认忽略远端 settings（保留本机凭据）。 */
  const DATA_STORES = ['banks', 'questions', 'wrong', 'stars', 'settings', 'history'];
  const STORES = {
    banks: 'id',
    questions: 'id',
    wrong: 'qid',
    stars: 'qid',
    settings: 'k',
    history: 'id',
    snapshots: 'id'       // 内部 store：冲突自动快照 { id, kind:'push'|'pull', at, note, snapshot }
  };
  const SENSITIVE_SETTING_KEYS = ['sync.token'];   // 绝不写入任何导出快照/云端
  KSB.SNAPSHOT_KEEP = 5;                            // 自动快照保留最近 N 份

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  KSB.db = null;
  KSB.ready = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('浏览器不支持 IndexedDB')); return; }
    const openReq = indexedDB.open(DB_NAME, DB_VERSION);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      for (const [store, key] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(store)) {
          const s = db.createObjectStore(store, { keyPath: key });
          if (store === 'questions') s.createIndex('bankId', 'bankId', { unique: false });
          if (store === 'wrong') s.createIndex('bankId', 'bankId', { unique: false });
          if (store === 'stars') s.createIndex('bankId', 'bankId', { unique: false });
          if (store === 'history') { s.createIndex('bankId', 'bankId', { unique: false }); s.createIndex('type', 'type', { unique: false }); }
        }
      }
    };
    openReq.onsuccess = () => { KSB.db = openReq.result; resolve(KSB.db); };
    openReq.onerror = () => reject(openReq.error);
  });

  function tx(store, mode) {
    return KSB.db.transaction(store, mode).objectStore(store);
  }
  function txDone(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  KSB.storePut = async function (store, item) {
    const t = KSB.db.transaction(store, 'readwrite');
    t.objectStore(store).put(item);
    await txDone(t);
  };
  KSB.storePutAll = async function (store, items) {
    if (!items || !items.length) return;
    const t = KSB.db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const it of items) s.put(it);
    await txDone(t);
  };
  KSB.storeGet = async function (store, key) {
    return reqToPromise(tx(store, 'readonly').get(key));
  };
  KSB.storeGetAll = async function (store) {
    return reqToPromise(tx(store, 'readonly').getAll());
  };
  KSB.storeGetAllBy = async function (store, index, value) {
    return reqToPromise(tx(store, 'readonly').index(index).getAll(value));
  };
  KSB.storeDel = async function (store, key) {
    const t = KSB.db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    await txDone(t);
  };
  KSB.storeClear = async function (store) {
    const t = KSB.db.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    await txDone(t);
  };

  // ---------- 种子数据 ----------
  KSB.seedSample = async function () {
    const banks = await KSB.storeGetAll('banks');
    if (banks.length) return banks[0].id;
    const S = window.SAMPLE_BANK;
    const bankId = S.bank.id || KSB.uid();
    const bank = Object.assign({}, S.bank, { id: bankId });
    const now = new Date().toISOString();
    const questions = S.questions.map((q, i) => Object.assign({}, q, {
      id: 'q-' + bankId + '-' + (i + 1),
      bankId: bankId,
      createdAt: now
    }));
    await KSB.storePut('banks', bank);
    await KSB.storePutAll('questions', questions);
    return bankId;
  };

  // ---------- 业务读取 ----------
  KSB.getBankQuestions = async function (bankId) {
    return KSB.storeGetAllBy('questions', 'bankId', bankId);
  };

  // ---------- 错题本 ----------
  KSB.wrongAdd = async function (q, userAnswerSummary) {
    const existing = await KSB.storeGet('wrong', q.id);
    const now = new Date().toISOString();
    const item = existing || { qid: q.id, bankId: q.bankId, wrongCount: 0, createdAt: now };
    item.wrongCount = (item.wrongCount || 0) + 1;
    item.lastWrongAt = now;
    if (userAnswerSummary) item.lastUserAnswer = userAnswerSummary;
    await KSB.storePut('wrong', item);
    return item;
  };
  KSB.wrongRemove = async function (qid) {
    await KSB.storeDel('wrong', qid);
  };
  KSB.wrongRemoveAllOfBank = async function (bankId) {
    const items = await KSB.storeGetAllBy('wrong', 'bankId', bankId);
    const t = KSB.db.transaction('wrong', 'readwrite');
    const s = t.objectStore('wrong');
    items.forEach(w => s.delete(w.qid));
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    return items.length;
  };

  // ---------- 收藏 ----------
  KSB.starToggle = async function (q) {
    const exists = await KSB.storeGet('stars', q.id);
    if (exists) { await KSB.storeDel('stars', q.id); return false; }
    await KSB.storePut('stars', { qid: q.id, bankId: q.bankId, starredAt: new Date().toISOString() });
    return true;
  };
  KSB.isStarred = async function (qid) {
    return !!(await KSB.storeGet('stars', qid));
  };
  KSB.getStarQids = async function (bankId) {
    const items = await KSB.storeGetAllBy('stars', 'bankId', bankId);
    return items.map(s => s.qid);
  };

  // ---------- 设置（键值，M3 起用） ----------
  KSB.setSetting = async function (k, v) {
    await KSB.storePut('settings', { k: k, v: v });
  };
  KSB.getSetting = async function (k) {
    const it = await KSB.storeGet('settings', k);
    return it ? it.v : null;
  };

  // ---------- 汇总统计（供设置页/关于展示） ----------
  KSB.countAll = async function () {
    const [banks, questions, wrong, stars, history] = await Promise.all([
      KSB.storeGetAll('banks'),
      KSB.storeGetAll('questions'),
      KSB.storeGetAll('wrong'),
      KSB.storeGetAll('stars'),
      KSB.storeGetAll('history')
    ]);
    return { banks: banks.length, questions: questions.length, wrong: wrong.length, stars: stars.length, history: history.length };
  };

  // ---------- 快照导出 / 导入（备份与一键同步共用） ----------
  /* 导出前剥离 settings 中的敏感键（sync.token 等），保证备份文件/云端内容不含凭据 */
  function sanitizeSnapshot(snap) {
    const data = Object.assign({}, snap.data);
    data.settings = (data.settings || []).filter(it => !SENSITIVE_SETTING_KEYS.includes(it.k));
    return Object.assign({}, snap, { data: data });
  }
  KSB.sanitizeSnapshot = sanitizeSnapshot;

  KSB.exportSnapshot = async function () {
    const data = {};
    for (const store of DATA_STORES) data[store] = await KSB.storeGetAll(store);
    return sanitizeSnapshot({
      app: 'kaoshibao-lite',
      modelVersion: 'v1',
      exportedAt: new Date().toISOString(),
      data: data
    });
  };
  KSB.exportSnapshotJSON = async function () {
    return JSON.stringify(await KSB.exportSnapshot(), null, 2);
  };

  /* 导入快照：整体替换业务 store（先清空再写入）。
     settings 与 snapshots 永不导入：settings 是本机配置/凭据（token 仅在本地），
     从备份或云端恢复一律保留本机 settings；snapshots 是内部冲突快照，不动。 */
  KSB.importSnapshot = async function (snapshot) {
    if (!snapshot || snapshot.app !== 'kaoshibao-lite') throw new Error('不是有效的考试宝自用版备份文件');
    const data = snapshot.data || {};
    const stores = DATA_STORES.filter(s => s !== 'settings');
    for (const store of stores) {
      await KSB.storeClear(store);
      await KSB.storePutAll(store, data[store] || []);
    }
    return true;
  };

  // ---------- 冲突自动快照（M4 云同步用；存本地 snapshots store，保留最近 N 份） ----------
  /* 记录一份快照到 snapshots store；payload 缺省=导出当前本地数据。
     无论哪种来源都先 sanitize（剥离 sync.token），快照内容永不携带凭据。
     超过 KSB.SNAPSHOT_KEEP 份时丢弃最旧的。kind: 'push'|'pull'|'cloud' */
  async function persistSnapshot(payload, kind, note) {
    const snap = sanitizeSnapshot(payload || await KSB.exportSnapshot());
    if (!snap || snap.app !== 'kaoshibao-lite') throw new Error('快照内容无效');
    const id = KSB.uid();
    await KSB.storePut('snapshots', {
      id: id,
      kind: kind || 'auto',
      at: new Date().toISOString(),
      note: note || '',
      snapshot: snap
    });
    // 裁剪：只保留最近 N 份
    const all = await KSB.storeGetAll('snapshots');
    all.sort((a, b) => (a.at < b.at ? 1 : -1));
    const drop = all.slice(KSB.SNAPSHOT_KEEP);
    for (const it of drop) await KSB.storeDel('snapshots', it.id);
    return { id: id, at: snap.exportedAt };
  }
  KSB.saveAutoSnapshot = function (kind, note) {
    return persistSnapshot(null, kind, note);
  };
  /* 把"给定快照载荷"（如云端现内容）存为本地自动快照——覆盖前先备份对方，防他设备数据丢失 */
  KSB.saveSnapshotOf = function (payload, kind, note) {
    return persistSnapshot(payload, kind, note);
  };
  /* 列出自动快照（新的在前），不含整份 snapshot 载荷（仅元信息） */
  KSB.listAutoSnapshots = async function () {
    const all = await KSB.storeGetAll('snapshots');
    all.sort((a, b) => (a.at < b.at ? 1 : -1));
    return all.map(it => ({ id: it.id, kind: it.kind, at: it.at, note: it.note }));
  };
  KSB.getAutoSnapshot = async function (id) {
    return KSB.storeGet('snapshots', id);
  };
  KSB.deleteAutoSnapshot = async function (id) {
    await KSB.storeDel('snapshots', id);
  };
})();
