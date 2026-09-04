/* grade.js —— 判分引擎（判分是产品硬性要求，所有模式共用此文件）
   契约见 docs/数据模型与判分规则.md §3 §6
   gradeQuestion(q, user) → { state:'correct'|'wrong'|'manual', expected, detail }
     user 取值：
       single: 'A'  ; judge: true/false
       multiple: ['A','C']（有序无所谓）
       fill: [空1输入, 空2输入, ...]（长度应=空位数）或单字符串（单空简写）
       short: 忽略（返回 manual）
*/
(function () {
  'use strict';
  const KSB = window.KSB = window.KSB || {};

  /* 多选题判错时的补充说明：漏选/多选哪些 */
  function multipleDetail(answerKeys, userKeys) {
    const as = new Set(answerKeys), us = new Set(userKeys);
    const missing = answerKeys.filter(k => !us.has(k));
    const extra = userKeys.filter(k => !as.has(k));
    const parts = [];
    if (missing.length) parts.push('漏选了 ' + missing.join('、'));
    if (extra.length) parts.push('多选了 ' + extra.join('、'));
    return parts.join('；') || '答案不匹配';
  }

  /* 人类可读的正确答案 */
  KSB.answerText = function (q) {
    switch (q.type) {
      case 'single':
      case 'multiple': {
        const keys = q.type === 'single' ? [q.answer] : (q.answer || []).slice().sort();
        const opts = (q.options || []).filter(o => keys.includes(o.key));
        return opts.map(o => o.key + '. ' + o.text).join('；');
      }
      case 'judge': return q.answer === true ? '正确' : '错误';
      case 'fill': {
        const blanks = normalizeFillAnswer(q.answer);
        return blanks.map((variants, i) => '第' + (i + 1) + '空：' + variants.join(' / ')).join('；');
      }
      default: return '';
    }
  };

  /* 归一化 fill.answer 为 [[变体...], ...] 二维数组（兼容旧式字符串数组） */
  function normalizeFillAnswer(answer) {
    if (!answer) return [[]];
    if (Array.isArray(answer) && answer.length && Array.isArray(answer[0])) return answer;
    if (Array.isArray(answer)) return [answer];          // ['水星','水'] → [['水星','水']]
    return [[answer]];                                    // '水星' → [['水星']]
  }

  /* 填空逐空判分，返回每空是否正确 */
  function gradeFill(q, userInputs) {
    const blanks = normalizeFillAnswer(q.answer);
    const inputs = Array.isArray(userInputs) ? userInputs : [userInputs];
    const res = blanks.map((variants, i) => {
      const input = KSB.norm(inputs[i]);
      if (!input) return false;
      return variants.some(v => KSB.norm(v) === input);
    });
    return res;
  }

  /* 统一判分入口 */
  KSB.gradeQuestion = function (q, user) {
    const out = { state: 'wrong', expected: KSB.answerText(q), detail: '' };
    switch (q.type) {
      case 'single': {
        if (user && String(user) === String(q.answer)) out.state = 'correct';
        else out.detail = '你的答案：' + (user || '未作答');
        break;
      }
      case 'judge': {
        const u = (user === true || user === 'true') ? true
          : (user === false || user === 'false') ? false : user;
        if (u === q.answer) out.state = 'correct';
        else out.detail = '你的答案：' + (u === true ? '正确' : u === false ? '错误' : '未作答');
        break;
      }
      case 'multiple': {
        const userKeys = (user || []).slice().sort();
        const ansKeys = (q.answer || []).slice().sort();
        if (userKeys.length === ansKeys.length && userKeys.every((k, i) => k === ansKeys[i])) {
          out.state = 'correct';
        } else {
          out.detail = multipleDetail(ansKeys, userKeys);
        }
        break;
      }
      case 'fill': {
        const perBlank = gradeFill(q, user);
        const blankOkCount = perBlank.filter(Boolean).length;
        if (blankOkCount === perBlank.length && perBlank.length > 0) {
          out.state = 'correct';
        } else {
          const badIdx = perBlank.map((ok, i) => ok ? -1 : i + 1).filter(i => i > 0);
          out.detail = badIdx.length ? '第' + badIdx.join('、') + '空错误' : '未作答';
        }
        break;
      }
      default:
        out.detail = '不支持或未知的题型：' + q.type;
        out.expected = '';
    }
    return out;
  };

  /* 选项文本渲染（供答题卡/结果展示用） */
  KSB.optionLabel = function (opt) { return opt.key + '. ' + opt.text; };
})();
