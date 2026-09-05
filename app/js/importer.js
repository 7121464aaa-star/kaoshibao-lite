/* importer.js —— 题库导入器：段落文字(考试宝文字模式) / CSV / JSON → 规范题目对象 → 入库
   全部纯前端解析（不依赖第三方库）。Word/Excel 请先"另存为 .txt/.csv(UTF-8)"或直接复制粘贴。
   暴露：KSB.importer = { parse, doImport, refreshTargetList, samples, hints } */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};

  const TYPE_ALIAS = {
    single: ['single', '单选', '单选题', '单项选择'],
    multiple: ['multiple', '多选', '多选题', '多项选择'],
    judge: ['judge', '判断', '判断题', '正误'],
    fill: ['fill', '填空', '填空题'],
    short: ['short', '简答', '简答题', '问答', '主观']
  };
  function typeFromLabel(label) {
    const s = String(label || '').trim().toLowerCase();
    for (const [type, aliases] of Object.entries(TYPE_ALIAS)) {
      if (aliases.some(a => s === a || s.includes(a))) return type;
    }
    return '';
  }
  const JUDGE_TRUE = ['对', '正确', '是', 't', 'true', '√', '✓', 'v'];
  const JUDGE_FALSE = ['错', '错误', '否', 'f', 'false', '×', 'x', '✗'];

  function judgeBool(text) {
    const s = KSB.norm(text);
    if (JUDGE_TRUE.includes(s)) return true;
    if (JUDGE_FALSE.includes(s)) return false;
    return null;
  }
  function splitLetters(s) {
    const t = String(s == null ? '' : s).toUpperCase().replace(/[^A-H]/g, '');
    return t ? Array.from(new Set(t.split(''))).sort() : [];
  }
  function normOptions(list) {
    const seen = new Set();
    const out = [];
    for (const o of list) {
      if (!o || o.text == null || o.text === '') continue;
      const key = String(o.key || '').toUpperCase().replace(/[^A-H]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, text: String(o.text).trim() });
    }
    return out.sort((a, b) => a.key < b.key ? -1 : 1);
  }

  /* 空位解析：answer 可能为
     规范二维数组 → 原样；['A','B']（旧式单空）→ [['A','B']]；字符串 '空1||空2' → 每空 '|' 分隔变体 */
  function normFillAnswer(answer, stem) {
    if (answer == null) return null;
    if (Array.isArray(answer) && answer.length && Array.isArray(answer[0])) return answer;
    let blanks;
    if (Array.isArray(answer)) blanks = [answer];
    else blanks = String(answer).split('||');
    return blanks.map(b => String(b).split('|').map(v => v.trim()).filter(Boolean));
  }

  /* 由原始字段构建规范题目；返回 Question 或抛错(msg) */
  function buildQuestion(raw, ctx) {
    const stem = String(raw.stem || '').trim();
    if (!stem) throw new Error('题干为空');
    let type = typeFromLabel(raw.typeHint || raw.type);
    const options = normOptions(raw.options || []);
    const answerRaw = raw.answer;
    const hasBlanks = KSB.countBlanks(stem) > 0 || String(stem).match(/（\s*）/);

    // 题型推断
    if (!type) {
      if (options.length >= 2) {
        const letters = splitLetters(answerRaw);
        type = letters.length > 1 ? 'multiple' : 'single';
      } else {
        const jb = judgeBool(answerRaw);
        if (jb !== null) type = 'judge';
        else if (hasBlanks) type = 'fill';
        else type = 'short';
      }
    }

    const q = {
      type,
      stem,
      options,
      analysis: String(raw.analysis || '').trim(),
      chapter: String(raw.chapter || '').trim() || undefined
    };

    if (type === 'short') {
      throw new Error('简答题已不支持（轻量版无自评），该题被跳过');
    }

    switch (type) {
      case 'single': {
        if (!options.length) throw new Error('单选缺少选项');
        const letters = splitLetters(String(answerRaw == null ? '' : answerRaw));
        const ansKey = Array.isArray(answerRaw) ? String(answerRaw[0] || '') : splitLetters(answerRaw)[0] || '';
        if (!ansKey || !options.some(o => o.key === ansKey)) {
          throw new Error('单选题答案 "' + answerRaw + '" 不在选项 ' + options.map(o => o.key).join('/') + ' 中');
        }
        void letters;
        q.answer = ansKey;
        break;
      }
      case 'multiple': {
        if (!options.length) throw new Error('多选缺少选项');
        let ansKeys;
        if (Array.isArray(answerRaw)) ansKeys = answerRaw.map(String).map(s => s.trim().toUpperCase()).filter(Boolean);
        else ansKeys = splitLetters(answerRaw);
        ansKeys = Array.from(new Set(ansKeys)).sort();
        if (!ansKeys.length || !ansKeys.every(k => options.some(o => o.key === k))) {
          throw new Error('多选题答案 "' + answerRaw + '" 非法');
        }
        q.answer = ansKeys;
        break;
      }
      case 'judge': {
        const b = typeof answerRaw === 'boolean' ? answerRaw : judgeBool(answerRaw);
        if (b === null) throw new Error('判断题答案需为 对/错/正确/错误/√/×');
        q.answer = b;
        q.options = [];
        break;
      }
      case 'fill': {
        const blanks = normFillAnswer(answerRaw, stem);
        if (!blanks) throw new Error('填空题缺少答案');
        const nBlanks = blanks.length;
        const stemBlanks = KSB.countBlanks(stem);
        if (stemBlanks > 1 && stemBlanks !== nBlanks) {
          throw new Error('题干有 ' + stemBlanks + ' 个空位，但答案给了 ' + nBlanks + ' 空');
        }
        q.answer = blanks;
        q.options = [];
        break;
      }
      default:
        throw new Error('不支持的题型：' + (raw.typeHint || raw.type || type));
    }
    return q;
  }

  /* ============ JSON ============ */
  function parseJSON(text) {
    const errors = [];
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { questions: [], errors: [{ row: 0, msg: 'JSON 语法错误：' + e.message }], bankName: '' }; }
    let arr = null, bankName = '';
    if (Array.isArray(obj)) arr = obj;
    else if (obj && obj.app === 'kaoshibao-lite') {
      return { questions: [], errors: [{ row: 0, msg: '这是整库备份文件，请到"设置 → 备份/恢复"导入，不要在此导入' }], bankName: '' };
    } else if (obj && Array.isArray(obj.questions)) { arr = obj.questions; bankName = (obj.bank && obj.bank.name) || obj.bankName || ''; }
    if (!arr) return { questions: [], errors: [{ row: 0, msg: '无法识别为题库 JSON（应为题目数组或 {questions:[...]}）' }], bankName: '' };
    const questions = [];
    arr.forEach((it, i) => {
      try {
        const q = buildQuestion({
          stem: it.stem, type: it.type, typeHint: it.typeHint,
          options: it.options, answer: it.answer, analysis: it.analysis, chapter: it.chapter
        }, 'json#' + (i + 1));
        questions.push(q);
      } catch (e) { errors.push({ row: i + 1, msg: e.message }); }
    });
    return { questions, errors, bankName };
  }

  /* ============ CSV ============ */
  function tokenizeCSV(text) {
    const rows = []; let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQ = false;
        } else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(x => x.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
  }
  const CSV_HEADER = {
    stem: ['题干', '题目', '试题', 'question', 'stem', '题目内容'],
    type: ['题型', 'type', '题目类型'],
    answer: ['答案', '正确答案', '参考答案', 'answer', 'correct', 'key'],
    analysis: ['解析', '分析', '解释', 'explanation', '答案分析'],
    chapter: ['章节', '分类', 'chapter', '章']
  };
  function mapCSVHeader(header) {
    const map = { stem: '', type: '', answer: '', analysis: '', chapter: '', opts: {} };
    header.forEach((h, idx) => {
      const key = String(h || '').trim().replace(/\s+/g, '');
      const up = key.toUpperCase();
      if (!key) return;
      for (const [field, aliases] of Object.entries(CSV_HEADER)) {
        if (aliases.some(a => key.toLowerCase() === a || key === a)) { map[field] = idx; return; }
      }
      if (/^[A-H]$/.test(up)) { map.opts[up] = idx; return; }
      const m = /^选项([A-H])$/.exec(key);
      if (m) { map.opts[m[1]] = idx; return; }
      if (/题型|题目类型/i.test(key)) map.type = idx;
    });
    return map;
  }
  function parseCSV(text) {
    const rows = tokenizeCSV(text);
    const errors = [];
    if (!rows.length) return { questions: [], errors: [{ row: 0, msg: '文件为空' }] };
    const map = mapCSVHeader(rows[0]);
    if (map.stem === '' && !Object.keys(map.opts).length) {
      return { questions: [], errors: [{ row: 1, msg: '找不到表头：需要 题干 列（选项列可用 选项A/选项B… 或 A/B…）' }] };
    }
    const cell = (r, idx) => (idx === '' ? '' : (r[idx] == null ? '' : String(r[idx]).trim()));
    const questions = [];
    rows.slice(1).forEach((r, ri) => {
      const rowno = ri + 2;
      try {
        const options = Object.entries(map.opts)
          .sort((a, b) => a[0] < b[0] ? -1 : 1)
          .map(([key, idx]) => ({ key, text: cell(r, idx) }))
          .filter(o => o.text);
        const q = buildQuestion({
          stem: cell(r, map.stem),
          type: cell(r, map.type),
          options,
          answer: cell(r, map.answer),
          analysis: cell(r, map.analysis),
          chapter: cell(r, map.chapter)
        }, 'csv#' + rowno);
        questions.push(q);
      } catch (e) { errors.push({ row: rowno, msg: e.message }); }
    });
    return { questions, errors, bankName: '' };
  }

  /* ============ 段落文字 ============ */
  const RE_TYPEHINT = /^题型\s*[:：]?\s*(.+)$/;
  const RE_OPT = /^([A-Ha-h])\s*[\.．、:：)）]\s*(.*)$/;
  const RE_ANSWER = /^(【?答案】?|正确答案|参考答案|标准答案)\s*[:：]?\s*(.*)$/;
  const RE_ANALYSIS = /^(解析|答案解析|解释|评析|【解析】|参考|要点|评分标准|答题要点)/;
  function parseText(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const errors = [];
    const questions = [];
    let block = [], blockNo = 0;
    function flushBlock() {
      if (!block.length) return;
      blockNo++;
      const raw = { options: [], typeHint: '', analysis: '' };
      let stemLines = [], afterAnswer = false, hasAnswerLine = false;
      block.forEach((ln, li) => {
        const line = ln.trim();
        if (!line) return;
        if (li === 0) {
          const num = /^\d+\s*[\.．、)）]\s*/.exec(line);
          if (num) { stemLines.push(line.slice(num[0].length)); return; }
        }
        const th = RE_TYPEHINT.exec(line);
        if (th && li < 2) { raw.typeHint = th[1].trim(); return; }
        if (afterAnswer) { raw.analysis = (raw.analysis ? raw.analysis + '\n' : '') + line; return; }
        const om = RE_OPT.exec(line);
        if (om) { raw.options.push({ key: om[1].toUpperCase(), text: om[2].trim() }); return; }
        const am = RE_ANSWER.exec(line);
        if (am && am[1]) { raw.answer = (am[2] || '').trim(); hasAnswerLine = true; afterAnswer = true; return; }
        if (RE_ANALYSIS.test(line)) { raw.analysis = (raw.analysis ? raw.analysis + '\n' : '') + line.replace(RE_ANALYSIS, '').replace(/^[:：]?\s*/, ''); return; }
        stemLines.push(line);
      });
      const stem = stemLines.join('\n').trim();
      if (!stem && !raw.options.length) { block = []; return; }
      // 答案行可能在选项行之后（上述已处理）；若无答案行但有选项：尝试末行解析答案
      if (!hasAnswerLine) {
        // 常见写法 答案在题干/选项间？容错：不强行
      }
      try {
        raw.stem = stem;
        if (!raw.answer && !raw.options.length && raw.analysis) raw.answer = raw.analysis; // 无答案有解析的简答
        const q = buildQuestion(raw, 'text#' + blockNo);
        questions.push(q);
      } catch (e) {
        errors.push({ row: blockNo, msg: e.message + '（题干：' + stem.slice(0, 24) + '…）' });
      }
      block = [];
    }
    for (const ln of lines) {
      const line = ln.trim();
      if (!line) { flushBlock(); continue; }
      // 一行即一道（无空行分隔）的紧凑格式容错：若该行既像题干又含 答案：xxx
      block.push(line);
    }
    flushBlock();
    return { questions, errors, bankName: '' };
  }

  /* ============ 汇总 ============ */
  function parse(fmt, text) {
    try {
      if (fmt === 'json') return parseJSON(text);
      if (fmt === 'csv') return parseCSV(text);
      return parseText(text);
    } catch (e) {
      return { questions: [], errors: [{ row: 0, msg: '解析异常：' + e.message }], bankName: '' };
    }
  }

  function typeStats(questions) {
    const s = { single: 0, multiple: 0, judge: 0, fill: 0, short: 0 };
    questions.forEach(q => { if (s[q.type] != null) s[q.type]++; });
    return s;
  }

  /* ============ 落库 ============ */
  async function doImport(opts) {
    const { targetBankId, newBankName, questions, sourceName } = opts;
    let bankId = targetBankId;
    if (!bankId) {
      const now = new Date();
      const stamp = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
      const bank = {
        id: KSB.uid(),
        name: (newBankName || '').trim() || ('导入题库-' + stamp),
        description: '导入自：' + (sourceName || '未知') + '（' + stamp + '）',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      await KSB.storePut('banks', bank);
      bankId = bank.id;
    }
    const bank = await KSB.storeGet('banks', bankId);
    if (!bank) throw new Error('目标题库不存在');
    const ts = Date.now().toString(36);
    const items = questions.map((q, i) => Object.assign({}, q, {
      id: 'q-' + bankId + '-' + ts + '-' + (i + 1),
      bankId,
      createdAt: new Date().toISOString(),
      source: sourceName || bank.name
    }));
    await KSB.storePutAll('questions', items);
    bank.updatedAt = new Date().toISOString();
    await KSB.storePut('banks', bank);
    return { bankId, count: items.length, bankName: bank.name };
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* ============ 示例与提示 ============ */
  const HINTS = {
    text: '【段落文字】每道题用空行隔开，支持：\n' +
      '题型：单选/多选/判断/填空（可省略，自动识别；简答已不支持，会跳过并提示）\n' +
      '题干放首行；选项行 A. / B． / C) / D、\n' +
      '答案行：答案：A（多选 ABD；判断 对/错；填空 第1空||第2空，每空多答案用 | 分隔）\n' +
      '解析行：解析：……（可选）\n从 Word/Excel 复制后粘贴即可；也可直接"载入文件"选 .docx 自动提取文字（老式 .doc 请另存为 .docx/.txt）。',
    csv: '【CSV 表格】第一行为表头，列名用：题干、题型、选项A..选项H（或 A..H）、答案、解析、章节。\n' +
      '多选答案写 ABD 或 A,B,D；判断写 对/错；填空同段落格式（空与空 || ，可接受答案 | ）。\n注意：Excel 另存 CSV 请选"UTF-8"，否则中文会乱码。',
    json: '【JSON 题库】标准结构：题目数组，或 { "bank": {"name":"…"}, "questions":[…] }。\n字段与数据模型一致：type/stem/options/answer/analysis/chapter。这是最稳妥的格式（M5 导出辅助将产出它）。'
  };
  const SAMPLES = {
    text: '题型：单选\n我国现行宪法规定，国家的根本制度是？\nA. 人民代表大会制度\nB. 社会主义制度\nC. 民主集中制\nD. 民族区域自治制度\n答案：B\n解析：宪法第一条：社会主义制度是根本制度；A 是根本政治制度。\n\n题型：多选\n以下属于我国公民基本义务的有？\nA. 维护国家统一和民族团结\nB. 遵守宪法和法律\nC. 依法纳税\nD. 服兵役\n答案：ABCD\n\n题型：判断\n法律是由国家制定或认可的行为规范。\n答案：对\n\n题型：填空\n我国的根本大法是《（　）》。\n答案：宪法|根本法',
    csv: '题干,题型,选项A,选项B,选项C,选项D,答案,解析\n我国现行宪法规定国家的根本制度是？,单选,人民代表大会制度,社会主义制度,民主集中制,民族区域自治制度,B,宪法第一条\n以下属于公民基本义务的有？,多选,维护国家统一,遵守宪法法律,依法纳税,服兵役,ABCD,,\n法律是由国家制定或认可的行为规范。,判断,,,,,对,,\n我国现行宪法是哪一年颁布的？,填空,,,,,1954年|1954,,',
    json: '{\n  "bank": { "name": "宪法基础-样例" },\n  "questions": [\n    {\n      "type": "single",\n      "stem": "我国现行宪法是哪一年颁布的？",\n      "options": [ { "key": "A", "text": "1949" }, { "key": "B", "text": "1954" }, { "key": "C", "text": "1978" }, { "key": "D", "text": "1982" } ],\n      "answer": "B",\n      "analysis": "1954 年颁布第一部宪法；现行宪法为 1982 年宪法。"\n    },\n    {\n      "type": "judge",\n      "stem": "宪法是国家的根本法，具有最高法律效力。",\n      "answer": true\n    }\n  ]\n}'
  };

  /* ============ UI 挂接 ============ */
  let pending = null;   // { questions, bankName }
  let fmt = 'text';

  function el(id) { return document.getElementById(id); }

  function parseFromSource() {
    const res = parse(fmt, el('impSource').value);
    pending = { questions: res.questions, bankName: res.bankName };
    // JSON 题库自带库名（bank.name）→ 新建题库时自动填入，实现"一键导入"
    if (res.bankName) {
      const ni = el('impNewName');
      if (ni && !ni.value.trim()) ni.value = res.bankName;
    }
    renderResult(res);
    return res;
  }

  function refreshTargetList() {
    const sel = el('impTarget');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="new">＋ 新建题库…</option>';
    KSB.storeGetAll('banks').then(banks => {
      banks.forEach(b => {
        const o = document.createElement('option');
        o.value = b.id;
        o.textContent = '追加到：' + b.name;
        sel.appendChild(o);
      });
      sel.value = cur && Array.from(sel.options).some(o => o.value === cur) ? cur : 'new';
      toggleNewRow();
    });
  }
  function toggleNewRow() {
    const v = el('impTarget').value;
    el('impNewRow').classList.toggle('hidden', v !== 'new');
    el('impHint'); // keep
  }

  function setHint() {
    el('impHint').textContent = HINTS[fmt] || '';
    document.querySelectorAll('#view-import .chip[data-fmt]').forEach(c => c.classList.toggle('active', c.dataset.fmt === fmt));
  }

  function renderResult(res) {
    const report = el('impReport');
    const n = res.questions.length, errs = res.errors;
    report.classList.remove('hidden', 'ok', 'bad');
    report.classList.add(errs.length && !n ? 'bad' : 'ok');
    const ts = typeStats(res.questions);
    const typeLine = ['single', 'multiple', 'judge', 'fill', 'short']
      .filter(t => ts[t]).map(t => (KSB.TYPES[t] || t) + ' ' + ts[t]).join(' · ');
    let html = '解析完成：<b>成功 ' + n + '</b> 道' + (typeLine ? '（' + typeLine + '）' : '') + (errs.length ? '，<b style="color:var(--wrong)">失败 ' + errs.length + '</b>' : '');
    if (res.bankName) html += '；JSON 中题库名："' + KSB.esc(res.bankName) + '"（导入到新题库时将采用）';
    if (errs.length) {
      html += '<ul class="imp-err-list">' + errs.slice(0, 8).map(e => '<li>第' + e.row + '项：' + KSB.esc(e.msg) + '</li>').join('') + '</ul>';
    }
    report.innerHTML = html;

    const pv = el('impPreview');
    if (n) {
      const rows = res.questions.slice(0, 10).map((q, i) =>
        '<tr><td>' + (i + 1) + '</td><td>' + KSB.esc(KSB.TYPES[q.type]) + '</td><td>' + KSB.esc(q.stem.replace(/\n/g, ' ').slice(0, 46)) + '</td><td>' + KSB.esc(KSB.answerText(q).slice(0, 30)) + '</td></tr>').join('');
      pv.innerHTML = '<table class="pv-table"><tr><th>#</th><th>题型</th><th>题干</th><th>答案</th></tr>' + rows + '</table>';
    } else pv.innerHTML = '';

    const btn = el('btnImport');
    const row = el('impImportRow');
    row.classList.toggle('hidden', !n);
    if (n) btn.textContent = '✓ 确认导入 ' + n + ' 道题';
  }

  function bindUI() {
    const ready = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bindUI) : doBind();
    function doBind() {
      document.querySelectorAll('#view-import .chip[data-fmt]').forEach(c => c.addEventListener('click', () => {
        fmt = c.dataset.fmt; setHint(); pending = null; el('impImportRow').classList.add('hidden');
      }));
      el('impTarget').addEventListener('change', toggleNewRow);
      el('btnFillSample').addEventListener('click', () => { el('impSource').value = SAMPLES[fmt] || ''; });
      el('impFile').addEventListener('change', async () => {
        const f = el('impFile').files[0];
        if (!f) return;
        el('impFile').value = '';
        const name = String(f.name || '').toLowerCase();
        if (name.endsWith('.docx')) {
          // Word 文档：提取正文 → 按"段落文字"解析预览（可直接编辑后再解析）
          try {
            const r = await KSB.docxToText(f);
            if (!String(r.text || '').trim()) { toast('未能从该 .docx 提取到文字（可能是扫描/图片版）', 'bad'); return; }
            fmt = 'text'; setHint();
            el('impSource').value = r.text;
            parseFromSource();
            const report = el('impReport');
            const warn = (r.warnings && r.warnings.length) ? ' ⚠' + r.warnings[0] : '';
            report.innerHTML = '<div style="margin-bottom:6px">📄 ' + KSB.esc(f.name) +
              ' → 已提取正文文字并解析（可修改上方文字后点"解析预览"重新解析）' + warn + '</div>' + report.innerHTML;
            toast('✓ 已载入 .docx 并提取文字', 'ok');
          } catch (e) {
            toast('解析 .docx 失败：' + e.message, 'bad');
          }
          return;
        }
        if (name.endsWith('.doc')) {
          toast('暂不支持老式 .doc：请用 Word 另存为 .docx 或 .txt 后再导入', 'bad');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => { el('impSource').value = String(reader.result || ''); toast('已载入：' + f.name); };
        reader.readAsText(f);
      });
      el('btnParse').addEventListener('click', parseFromSource);
      el('btnImport').addEventListener('click', async () => {
        if (!pending || !pending.questions.length) return;
        const target = el('impTarget').value;
        const sourceName = '粘贴/文件导入';
        try {
          const r = await doImport({
            targetBankId: target === 'new' ? null : target,
            newBankName: target === 'new' ? el('impNewName').value : '',
            questions: pending.questions,
            sourceName
          });
          pending = null;
          el('impImportRow').classList.add('hidden');
          el('impSource').value = '';
          el('impReport').classList.add('hidden');
          el('impPreview').innerHTML = '';
          if (window.KSB && KSB.notifyBankDataChanged) KSB.notifyBankDataChanged(r.bankId);
          toast('✓ 已导入 ' + r.count + ' 道 → 「' + r.bankName + '」', 'ok');
        } catch (e) { toast('导入失败：' + e.message, 'bad'); }
      });
      setHint();
      refreshTargetList();
    }
    ready();
  }
  function toast(msg, type) {
    if (window.KSB && KSB.toast) return KSB.toast(msg, type);
  }

  KSB.importer = { parse, doImport, refreshTargetList, samples: SAMPLES, hints: HINTS };
  bindUI();
})();
