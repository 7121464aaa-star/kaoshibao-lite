/* docx2json.mjs —— M5 一次性转换工具：考试宝导出的 .docx 题库 → 本应用"标准 JSON"导入格式
 * 目标文档结构（见 docs/项目进度与交接.md §9，已实测 2710 段、无表格/图片）：
 *   段① 判断题 001..100：单行题干，答案括号在句尾 （ √ ）/（ × ）/（×）
 *   段② 单选题 001..300：题干 1 段 + 选项 4 段（A、…），答案内嵌题干括号（ A ）；
 *       题号有笔误：05、(缺分隔)055法国、057对客观、089党的二十大
 *   段③ 多选题 001..200：同单选结构，答案内嵌题干括号（  ABD  ）等；个别含 2 组括号（ BD ）与（  ）；
 *       有 1 行选项粘连笔误 "A自发地…"
 *   段④ 时政杂题："题库新增20道题" 标记之后。单选多为题干/选项同段或分段的 "A. xxx B. xxx …"，
 *       答案独立行 "答案：X"；另含 2 个无字母前缀的多选（万隆/红船：选项逐行，答案行 ABCD/ABC）
 * 转换规则：
 *   - id/时间戳不由本工具生成：应用导入时按 M0 契约自动生成（id = q-{bankId}-{ts}-i）
 *   - 题干内嵌纯字母答案括号 → 从题干剥离并转成 answer；原括号位置替换为全角空括号（　），避免泄露答案
 *   - 判断题（ √/× ）→ answer: true/false，括号从题干剥离
 *   - 选项规范化：key 大写 A..H；剥离 "A、/A./A．/A)" 前缀；兼容 "A自发地…" 粘连
 * 零第三方库：内置 ZIP 中央目录解析 + Node zlib 解压（与 app/js/docx.js 浏览器端逻辑等价）
 * 用法：node tools/docx2json.mjs <题库.docx> <输出.json> [--bank "题库名"]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/* ================= ZIP 读取（Node 版，逻辑同 app/js/docx.js） ================= */
function readU16(dv, o) { return dv.getUint16(o, true); }
function readU32(dv, o) { return dv.getUint32(o, true); }

function findEOCD(dv) {
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
    const nameBytes = new Uint8Array(dv.buffer, dv.byteOffset + o + 46, nameLen);
    let name = '';
    try { name = new TextDecoder('utf-8').decode(nameBytes); } catch (e) { name = ''; }
    out.push({ name, method, compSize, localOff });
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
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(Buffer.from(data));
  throw new Error('不支持的压缩方式(' + entry.method + ')');
}

function readDocxMainXml(docxPath) {
  const buf = fs.readFileSync(docxPath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 4 || readU32(dv, 0) !== 0x04034b50) {
    throw new Error('不是有效的 .docx 文件（应为 ZIP 格式）');
  }
  const entries = centralEntries(dv);
  const target = entries.filter(e => /word\/document\.xml$/i.test(e.name))[0];
  if (!target) throw new Error('不是有效的 .docx（缺少 word/document.xml）');
  return extractEntry(dv, target).toString('utf-8');
}

/* ================= document.xml → 段落 ================= */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** 解析 w:p 块内文本（w:t/w:tab/w:br），返回 [{text, auto}]（auto=带 Word 自动编号） */
function xmlToParagraphs(xml) {
  const paras = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = pRe.exec(xml))) {
    const inner = m[1];
    const auto = /<w:numPr\b/.test(inner);
    let text = '';
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
    let tm;
    while ((tm = tRe.exec(inner))) {
      if (tm[1] !== undefined) text += unescapeXml(tm[1]);
      else if (/<w:tab\b/.test(tm[0])) text += '\t';
      else if (/<w:br\b/.test(tm[0])) text += '\n';
    }
    paras.push({ text: text.replace(/\s+$/g, ''), auto });
  }
  return paras;
}

/* ================= 题干/选项解析 ================= */
const FULLWIDTH_SPACE = '\u3000';
function cleanSpace(s) {
  // 只折叠 ASCII 空白；保留全角空格（（　）空位标记等）
  return String(s).replace(/[ \t\u00a0]+/g, ' ').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '').replace(/ +/g, ' ');
}

/** 剥离题号前缀：001、 / 05、 / 7. / 16. / 055法国(无分隔粘连)。4 位年份（2026年…）开头不受影响。 */
function stripQNo(s) {
  let t = String(s || '').trim();
  const m1 = /^(\d{1,3})\s*[、.．:：]/.exec(t);
  if (m1) return t.slice(m1[0].length).trim();
  const m2 = /^(\d{1,3})(?=[\u4e00-\u9fff（(])/.exec(t);
  if (m2 && +m2[1] > 0) return t.slice(m2[0].length).trim(); // 055法国…；年份为 4 位不会命中 1-3 位
  return t;
}

/** 题干中的答案括号（内容仅 A-H 字母，可含空格）→ {letters, clean}。括号原位替换为全角空括号（　） */
function extractParenLetters(stem) {
  const spans = [];
  const re = /[（(]\s*([A-Ha-h]{1,8})\s*[）)]/g;
  let m;
  while ((m = re.exec(stem))) {
    spans.push({ start: m.index, end: m.index + m[0].length, letters: m[1].toUpperCase() });
  }
  if (!spans.length) return { letters: [], clean: cleanSpace(stem) };
  const all = spans.map(sp => sp.letters).join('');
  const letters = Array.from(new Set(all.split(''))).sort();
  let clean = stem;
  for (let i = spans.length - 1; i >= 0; i--) {
    clean = clean.slice(0, spans[i].start) + '（' + FULLWIDTH_SPACE + '）' + clean.slice(spans[i].end);
  }
  return { letters, clean: cleanSpace(clean) };
}

/** 判断题题干尾部答案括号（ √/× ）→ {answer:boolean|null, clean} */
function extractJudgeAnswer(stem) {
  const re = /[（(]\s*([√×])\s*[）)]\s*$/;
  const m = re.exec(stem);
  if (!m) return { answer: null, clean: stem.trim() };
  return { answer: m[1] === '√', clean: stem.slice(0, m.index).trim() };
}

/** 单行选项 → {key,text}；支持 A、/A./A．/A)/A：以及粘连笔误 "A自发地…" */
function parseOptionLine(line) {
  const t = String(line || '').trim();
  const m = /^([A-Ha-h])\s*(?:[、.．:：)）]|(?=[\u4e00-\u9fff])|\s)(.*)$/.exec(t);
  if (m) {
    const text = cleanSpace(m[2]);
    if (text) return { key: m[1].toUpperCase(), text };
  }
  return null;
}

function isOptionLine(line) {
  const t = String(line || '').trim();
  return /^[A-Ha-h]\s*[、.．:：)）]/.test(t) || /^[A-Ha-h](?=[\u4e00-\u9fff])/.test(t);
}

/** 拆一段内联选项文本：" A. xxx B. xxx C. xxx D. xxx" → [{key,text}] */
function parseInlineOptions(text) {
  const out = [];
  const re = /(?:^|[\s\u3000])([A-Ha-h])\s*[.．、:：)）]\s*/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) {
    marks.push({ idx: m.index + m[0].indexOf(m[1]), key: m[1].toUpperCase() });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx;
    let seg;
    if (i + 1 < marks.length) seg = text.slice(start + 1, marks[i + 1].idx);
    else seg = text.slice(start + 1);
    seg = seg.replace(/^[.．、:：)）\s]+/, '').trim();
    if (seg) out.push({ key: marks[i].key, text: seg });
  }
  return out;
}

/** 规范化选项：去重、按 key 排序、文本去空白 */
function normalizeOptions(opts) {
  const seen = new Set();
  return opts
    .filter(o => o && o.key && o.text)
    .map(o => ({ key: String(o.key).toUpperCase(), text: cleanSpace(o.text) }))
    .filter(o => { if (seen.has(o.key)) return false; seen.add(o.key); return true; })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/* ================= 主解析 ================= */
/**
 * @param {string} docxPath
 * @param {string} bankName
 * @returns {{questions:Array, stats:object, warnings:Array}}
 */
export function convertDocx(docxPath, bankName) {
  const xml = readDocxMainXml(docxPath);
  const paras = xmlToParagraphs(xml).filter(p => p.text.trim() !== '');
  const warnings = [];
  const questions = [];
  const stats = { judge: 0, single: 0, multiple: 0, fill: 0, short: 0 };

  const isJudgeLine = t => /[（(]\s*[√×]\s*[）)]\s*$/.test(t.trim());

  let i = 0;
  // ---- 段① 判断题 ----
  for (; i < paras.length; i++) {
    const t = paras[i].text.trim();
    if (!t) continue;
    if (!isJudgeLine(t)) break;
    const jr = extractJudgeAnswer(stripQNo(t));
    if (jr.answer === null) { warnings.push('判断题缺少答案标记：' + t.slice(0, 40)); continue; }
    questions.push({ type: 'judge', stem: jr.clean, answer: jr.answer });
    stats.judge++;
  }

  // ---- 段②③ 单选/多选：题干段 + 4 选项段；题干内嵌答案括号 ----
  function pushChoice(stemText, opts) {
    const ex = extractParenLetters(stripQNo(stemText));
    const options = normalizeOptions(opts);
    if (!ex.letters.length) { warnings.push('题干无内嵌答案：' + stripQNo(stemText).slice(0, 50)); return; }
    if (options.length < 2) { warnings.push('选项不足：' + ex.clean.slice(0, 40)); return; }
    const type = ex.letters.length > 1 ? 'multiple' : 'single';
    if (type === 'single') {
      if (!options.some(o => o.key === ex.letters[0])) {
        warnings.push('单选答案不在选项中：' + ex.clean.slice(0, 50)); return;
      }
      questions.push({ type, stem: ex.clean, options, answer: ex.letters[0] });
    } else {
      const bad = ex.letters.filter(k => !options.some(o => o.key === k));
      if (bad.length) { warnings.push('多选答案含非法键 ' + bad.join('') + '：' + ex.clean.slice(0, 50)); return; }
      questions.push({ type, stem: ex.clean, options, answer: ex.letters });
    }
    stats[type]++;
  }

  let curStem = null;
  let curOpts = [];
  function flushChoice() {
    if (curStem !== null) pushChoice(curStem, curOpts);
    curStem = null; curOpts = [];
  }
  const choiceEnd = paras.findIndex(p => p.text.trim() === '题库新增20道题');
  const choiceLimit = choiceEnd >= 0 ? choiceEnd : paras.length;
  for (; i < choiceLimit; i++) {
    const t = paras[i].text.trim();
    if (!t) continue;
    if (isJudgeLine(t)) { warnings.push('单选/多选区遇到判断题样式行：' + t.slice(0, 40)); continue; }
    if (isOptionLine(t) && curStem !== null) {
      const o = parseOptionLine(t);
      if (o) curOpts.push(o);
      else warnings.push('选项行解析失败：' + t.slice(0, 40));
    } else {
      flushChoice();
      curStem = t;
    }
  }
  flushChoice();

  // ---- 段④ 时政杂题（"题库新增20道题" 之后）：以 "答案：X" 行为块界 ----
  const tailStart = paras.findIndex(p => p.text.indexOf('题库新增20道题') >= 0);
  if (tailStart >= 0) {
    const chunks = [];
    let cur = [];
    for (let k = tailStart + 1; k < paras.length; k++) {
      const t = paras[k].text.trim();
      if (!t) continue;
      const am = /^答案\s*[:：]\s*([A-Ha-h\s]+)$/.exec(t);
      if (am) {
        chunks.push({ lines: cur, ans: am[1].replace(/\s+/g, '').toUpperCase() });
        cur = [];
      } else {
        cur.push(t);
      }
    }
    if (cur.length) chunks.push({ lines: cur, ans: '' });

    for (const ch of chunks) {
      if (!ch.lines.length) continue;
      if (!ch.ans) { warnings.push('时政题缺答案行：' + ch.lines[0].slice(0, 40)); continue; }
      const ansLetters = Array.from(new Set(ch.ans.split(''))).sort();
      const lines = ch.lines;
      let stem = lines[0];
      let opts = [];

      // 情形1：题干同行内联选项（如 "7. …？ A. 蒋万安 B. …"）
      const firstOpt = parseInlineOptions(stem);
      if (firstOpt.length >= 2) {
        const mm = /(?:^|[\s\u3000])([A-Ha-h])\s*[.．、:：)）]/.exec(stem);
        const splitAt = mm ? mm.index + mm[0].indexOf(mm[1]) : -1;
        if (splitAt > 0) {
          stem = stem.slice(0, splitAt).trim();
          opts = parseInlineOptions(lines.join(' ').slice(splitAt));
        } else {
          opts = firstOpt;
        }
      } else {
        // 情形2：题干一段，选项在后续段
        const rest = lines.slice(1);
        if (rest.length) {
          if (rest.every(r => /^[A-Ha-h]\s*[.．、:：)）]/.test(r.trim()))) {
            opts = rest.flatMap(r => parseInlineOptions(r)).filter(o => o && o.text);
          } else {
            // 无字母前缀（万隆/红船 多选）：逐行为选项，自动补 A..H
            const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
            rest.forEach((r, idx) => { if (r.trim() && idx < 8) opts.push({ key: keys[idx], text: r.trim() }); });
          }
        }
      }

      opts = normalizeOptions(opts);
      const cleanStem = stripQNo(stem).trim();
      if (!cleanStem) { warnings.push('时政题题干为空'); continue; }
      if (!opts.length) { warnings.push('时政题选项为空：' + cleanStem.slice(0, 50)); continue; }
      const type = ansLetters.length > 1 ? 'multiple' : 'single';
      if (type === 'single') {
        if (!opts.some(o => o.key === ansLetters[0])) {
          warnings.push('时政单选答案不在选项中：' + cleanStem.slice(0, 50)); continue;
        }
        questions.push({ type, stem: cleanStem, options: opts, answer: ansLetters[0] });
      } else {
        const bad = ansLetters.filter(k => !opts.some(o => o.key === k));
        if (bad.length) { warnings.push('时政多选答案含非法键 ' + bad.join('') + '：' + cleanStem.slice(0, 50)); continue; }
        questions.push({ type, stem: cleanStem, options: opts, answer: ansLetters });
      }
      stats[type]++;
    }
  }

  return { questions, stats, warnings };
}

/* ================= CLI ================= */
function main() {
  const args = process.argv.slice(2);
  let docxPath = null;
  let outPath = null;
  let bankName = '';
  for (let a = 0; a < args.length; a++) {
    if (args[a] === '--bank') { bankName = args[++a] || ''; continue; }
    if (args[a].startsWith('--')) continue;
    if (!docxPath) docxPath = args[a];
    else if (!outPath) outPath = args[a];
  }
  if (!docxPath) {
    console.error('用法: node tools/docx2json.mjs <题库.docx> <输出.json> [--bank "题库名"]');
    process.exit(2);
  }
  if (!outPath) outPath = docxPath.replace(/\.docx$/i, '') + '.json';
  if (!bankName) bankName = path.basename(docxPath).replace(/\.docx$/i, '');

  const { questions, stats, warnings } = convertDocx(docxPath, bankName);
  const out = { bank: { name: bankName }, questions };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf-8');

  console.log('✔ 转换完成 → ' + outPath);
  console.log('  题库名：' + bankName);
  const line = ['judge', 'single', 'multiple', 'fill', 'short']
    .filter(t => stats[t]).map(t => t + '=' + stats[t]).join('  ');
  console.log('  题型统计：' + line + '  合计=' + questions.length);
  if (warnings.length) {
    console.log('  ⚠ 告警 ' + warnings.length + ' 条（前 15 条）：');
    warnings.slice(0, 15).forEach(w => console.log('    - ' + w));
  } else {
    console.log('  无告警');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
