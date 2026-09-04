/* docx.js —— Word(.docx) 纯前端文字提取（M3.1）
   原理：.docx = ZIP 包。本模块直接解析 ZIP 中央目录 → 取 word/document.xml →
   (a) 方法8 deflate 用浏览器原生 DecompressionStream('deflate-raw') 解压（方法0 直接拷贝）
   → (b) DOMParser 解析 XML → 按 w:p/w:tbl 还原为纯文本段落，
   并按"题号/题型"前缀插入空行作为题目分隔，可直接交给 importer 的"段落文字"解析器。
   不引入任何第三方库。老式 .doc（OLE 二进制）不在支持范围。
   暴露：KSB.docxToText(arrayBuffer|File) → Promise<{text, warnings}> */
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  /* ---------- ZIP 读取 ---------- */
  function readU16(dv, o) { return dv.getUint16(o, true); }
  function readU32(dv, o) { return dv.getUint32(o, true); }

  function findEOCD(dv) {
    // 从文件尾向前找 PK\x05\x06（限最后 64KB + 22）
    const end = dv.byteLength;
    const from = Math.max(0, end - 22 - 65536);
    for (let i = end - 22; i >= from; i--) {
      if (readU32(dv, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function centralEntries(dv) {
    const eocd = findEOCD(dv);
    if (eocd < 0) return [];
    const cdOffset = readU32(dv, eocd + 16);
    const total = readU16(dv, eocd + 10);
    const out = [];
    let o = cdOffset;
    for (let n = 0; n < total; n++) {
      if (readU32(dv, o) !== 0x02014b50) break;
      const method = readU16(dv, o + 10);
      const compSize = readU32(dv, o + 20);
      const nameLen = readU16(dv, o + 28);
      const extraLen = readU16(dv, o + 30);
      const commentLen = readU16(dv, o + 32);
      const localOff = readU32(dv, o + 42);
      const name = '';
      const bytes = [];
      for (let i = 0; i < nameLen; i++) bytes.push(dv.getUint8(o + 46 + i));
      let s = '';
      try { s = new TextDecoder('utf-8').decode(new Uint8Array(bytes)); } catch (e) { s = ''; }
      out.push({ name: s, method, compSize, localOff });
      o += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function extractEntry(dv, entry) {
    const local = entry.localOff;
    if (readU32(dv, local) !== 0x04034b50) throw new Error('ZIP 局部头损坏');
    const nameLen = readU16(dv, local + 26);
    const extraLen = readU16(dv, local + 28);
    const start = local + 30 + nameLen + extraLen;
    const data = new Uint8Array(dv.buffer, dv.byteOffset + start, entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new Error('不支持的压缩方式(' + entry.method + ')，请用 Word 另存为标准 .docx 或 .txt');
  }

  async function inflateRaw(u8) {
    if (!window.DecompressionStream) {
      throw new Error('当前浏览器不支持 .docx 解压（需要较新版本 Chrome/Edge 或 Safari 16.4+），请另存为 .txt 导入');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* ---------- document.xml → 文本 ---------- */
  function localName(n) { return n.localName || n.nodeName.replace(/^.*:/, ''); }

  function paragraphText(p) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === 3) return; // 文本节点由 w:t 统一取
      for (const ch of node.childNodes) {
        const ln = localName(ch);
        if (ch.nodeType === 1) {
          if (ln === 't') out += ch.textContent || '';
          else if (ln === 'tab') out += '\t';
          else if (ln === 'br' || ln === 'cr') out += '\n';
          else if (ln === 'pPr') { /* 跳过格式 */ }
          else if (ln === 'footnoteReference' || ln === 'endnoteReference') { /* 正文不含脚注文字 */ }
          else walk(ch);
        }
      }
    };
    walk(p);
    return out;
  }
  function hasNumPr(p) {
    return p.getElementsByTagNameNS(W, 'numPr').length > 0;
  }
  function tableToLines(tbl) {
    const lines = [];
    const rows = tbl.getElementsByTagNameNS(W, 'tr');
    for (const tr of rows) {
      const cells = tr.getElementsByTagNameNS(W, 'tc');
      const cellTexts = [];
      for (const tc of cells) {
        const ps = tc.getElementsByTagNameNS(W, 'p');
        const cellLines = [];
        for (const p of ps) {
          const t = paragraphText(p).trim();
          if (t) cellLines.push(t);
        }
        cellTexts.push(cellLines.join('\n'));
      }
      if (cellTexts.length) lines.push(cellTexts.join('\t'));
    }
    return lines;
  }

  function isQuestionStart(line) {
    return /^题型\s*[:：]/.test(line) || /^\d+\s*[\.．、)）]/.test(line);
  }
  function isMetaLine(line) { // 选项/答案/解析行 —— 不是新题
    return /^[A-Ha-h]\s*[\.．、:：)）]/.test(line) || /^(\[?答案\]?|正确答案|参考答案|标准答案|解析|答案解析|解释|评析|【解析】|参考|要点)/.test(line);
  }

  function bodyToText(xmlDoc) {
    const body = xmlDoc.getElementsByTagNameNS(W, 'body')[0];
    if (!body) throw new Error('文档缺少正文(body)');
    const blocks = []; // { t: 文本, auto: 该段带 Word 自动编号 }
    for (const node of body.childNodes) {
      if (node.nodeType !== 1) continue;
      const ln = localName(node);
      if (ln === 'p') {
        const t = paragraphText(node).trim();
        if (t) blocks.push({ t, auto: hasNumPr(node) });
      } else if (ln === 'tbl') {
        const ls = tableToLines(node);
        ls.forEach(l => { if (l.trim()) blocks.push({ t: l, auto: false }); });
      } else if (ln === 'sectPr') { /* 节属性 */ }
    }
    // 题间插空行：题干/题型/带自动编号 视为新题起始（选项/答案/解析行除外）
    const out = [];
    for (const blk of blocks) {
      const first = String(blk.t).split('\n')[0].trim();
      const startNew = isQuestionStart(first) || (blk.auto && !isMetaLine(first));
      if (startNew && out.length && out[out.length - 1] !== '') out.push('');
      out.push(blk.t);
    }
    return out.join('\n');
  }

  /* ---------- 对外入口 ---------- */
  async function docxToText(input) {
    const buf = input instanceof ArrayBuffer ? input
      : input && typeof input.arrayBuffer === 'function' ? await input.arrayBuffer()
      : null;
    if (!buf) throw new Error('无法读取文件内容');
    const dv = new DataView(buf);
    // 魔数检查：ZIP 以 PK\x03\x04 开头
    if (dv.byteLength < 4 || readU32(dv, 0) !== 0x04034b50) {
      throw new Error('不是有效的 .docx 文件（应为 ZIP 格式）；老式 .doc 请用 Word 另存为 .docx 或 .txt');
    }
    const entries = centralEntries(dv);
    if (!entries.length) throw new Error('ZIP 目录为空或损坏');
    const target = entries.filter(e => /word\/document\.xml$/i.test(e.name))[0];
    if (!target) throw new Error('不是有效的 .docx（缺少 word/document.xml）');
    const raw = await extractEntry(dv, target);
    let xml = '';
    try { xml = new TextDecoder('utf-8').decode(raw); }
    catch (e) { xml = ''; }
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('document.xml 解析失败');
    const text = bodyToText(doc);
    const warnings = [];
    if (!text.trim()) warnings.push('未从正文提取到文字（可能是扫描/图片版），请确认文档可选中复制');
    return { text, warnings };
  }

  KSB.docxToText = docxToText;
})();
