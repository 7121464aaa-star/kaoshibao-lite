/* build-single.mjs —— 把 app/ 打包成 PWA 站（dist/）：
   - dist/考试宝自用版.html：单文件（可双击/下载，CSS/JS 全内联）
   - dist/index.html：与上面内容相同的 PWA/Pages 入口（manifest start_url 指向它）
   - dist/manifest.webmanifest、dist/sw.js：复制自 app/pwa/
   - dist/icons/：复制自 app/icons/（由 tools/make-icons.mjs 生成）
   用法：node tools/build-single.mjs
   说明：产物可直接双击打开（数据模型/判分逻辑/样例全部内联）；部署 https 后自动成为可安装 PWA。 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');
const distDir = join(root, 'dist');

function read(p) { return readFileSync(p, 'utf8'); }

function listJs(dir) {
  // 固定加载顺序：model -> grade -> data-sample -> docx -> importer -> ...
  const want = ['model.js', 'grade.js', 'data-sample.js', 'docx.js', 'importer.js', 'bank-mgmt.js', 'ui.js', 'exam.js', 'stats.js', 'search.js', 'backup.js', 'sync.js'];
  return want
    .map(f => join(dir, f))
    .filter(f => statSync(f).isFile());
}

let indexHtml = read(join(appDir, 'index.html'));
const css = read(join(appDir, 'css', 'style.css')) + `

/* M13 mobile hotfix：新增「重复本轮」后，手机宽度不足时不允许工具条把整页撑宽。
   手机端改为稳定的 2×2 工具按钮布局，摘要隐藏；其它页面/功能不动。 */
body { max-width: 100%; overflow-x: hidden; }
@media (max-width: 520px) {
  .ptoolbar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    width: 100%;
    max-width: 100%;
  }
  .ptool-status { display: none; }
  .ptool-btn {
    width: 100%;
    min-width: 0;
    justify-content: center;
    white-space: nowrap;
  }
}
`;

// M13：在刷题工具条加“重复本轮”。与“重新开始”不同：
// 重复本轮只清答案并回第 1 题，保留当前题目集合和当前顺序；随机模式不会重新洗牌，随机组题不会重抽。
indexHtml = indexHtml.replace(
  '<div class="ptool-status" id="filterSummary" title="">本库全部 · 全题型 · 顺序 · 全章节</div>\n        <button id="btnAnsToggle"',
  '<div class="ptool-status" id="filterSummary" title="">本库全部 · 全题型 · 顺序 · 全章节</div>\n        <button id="btnRepeatRound" class="btn ptool-btn" type="button" title="清空本轮作答，但保持当前题目和顺序不变">🔁 重复本轮</button>\n        <button id="btnAnsToggle"'
);
indexHtml = indexHtml.replace(
  'onclick="document.getElementById(\'btnReset\').click()">再来一遍</button>',
  'onclick="document.getElementById(\'btnRepeatRound\').click()">再来一遍</button>'
);

// 去外链 css
let html = indexHtml.replace(/<link rel="stylesheet" href="css\/style\.css">/i,
  '<style>\n' + css + '\n</style>');

// 替换 script 标签为内联（<script src=...> → <script>内容</script>）
const scriptRe = /<script src="js\/([^"]+)"><\/script>/gi;
const inline = {};
for (const f of listJs(join(appDir, 'js'))) {
  const name = f.split(/[\\/]/).pop();
  inline[name] = read(f);
}

// M13：补入“重复本轮”的控制逻辑。这里直接改构建时的 ui.js 文本，避免触碰题库/答题判分逻辑。
if (inline['ui.js']) {
  inline['ui.js'] = inline['ui.js'].replace(
    "    $('#btnPrev').addEventListener('click', () => goto(session.idx - 1));",
    `    // M13：重复本轮——保留当前题组和顺序，只清空本轮答案并从第一题重新刷。\n    $('#btnRepeatRound').addEventListener('click', async () => {\n      if (!session.questions.length) { KSB.toast('当前没有可重复的题目', 'bad'); return; }\n      if ((session.answers.size || session.drafts.size) &&\n          !confirm('重复刷当前这轮题目（保持题目与顺序不变，清空当前作答记录）？')) return;\n      await commitHistory();\n      cancelAutoNext();\n      session.answers.clear();\n      session.drafts.clear();\n      session.idx = 0;\n      session.startedAt = new Date();\n      session.committed = false;\n      session.touched = 0;\n      lastQid = null;\n      renderAll();\n      KSB.toast('🔁 已重复本轮：题目与顺序保持不变', 'ok');\n    });\n    $('#btnPrev').addEventListener('click', () => goto(session.idx - 1));`
  );
  inline['ui.js'] = inline['ui.js'].replace(
    `tip.textContent = session.mode === 'rand' ? '随机顺序，点"重新开始"重新打乱' : '';`,
    `tip.textContent = session.mode === 'rand' ? '随机顺序；「重复本轮」保持当前顺序再刷，「重新开始」重新打乱' : '';`
  );
}

html = html.replace(scriptRe, (m, name) => {
  const content = inline[name];
  if (!content) return m;
  return '<script>\n' + content + '\n</script>';
});

// 注入构建标记
html = html.replace('<meta name="viewport"', '<meta name="generator" content="build-single.mjs">\n  <meta name="viewport"');

// 生成 PWA 站目录（先清空 dist，避免旧文件残留）
mkdirSync(distDir, { recursive: true });
for (const f of readdirSync(distDir)) rmSync(join(distDir, f), { recursive: true, force: true });

// 1) 两个 HTML 产物（同名同内容）
writeFileSync(join(distDir, '考试宝自用版.html'), html, 'utf8');
writeFileSync(join(distDir, 'index.html'), html, 'utf8');

// 2) PWA 资源
for (const f of ['manifest.webmanifest', 'sw.js']) {
  copyFileSync(join(appDir, 'pwa', f), join(distDir, f));
}
// 3) 图标
mkdirSync(join(distDir, 'icons'), { recursive: true });
for (const f of readdirSync(join(appDir, 'icons'))) {
  if (statSync(join(appDir, 'icons', f)).isFile()) copyFileSync(join(appDir, 'icons', f), join(distDir, 'icons', f));
}

console.log('✔ 已生成: ' + join(distDir, 'index.html') + '（' + (html.length / 1024).toFixed(1) + ' KB，PWA 入口）');
console.log('✔ 已生成: ' + join(distDir, '考试宝自用版.html') + '（单文件，可双击）');
console.log('✔ PWA 资源: manifest.webmanifest / sw.js / icons/* 已就位');
