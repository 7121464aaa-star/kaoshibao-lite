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

const indexHtml = read(join(appDir, 'index.html'));
const css = read(join(appDir, 'css', 'style.css'));

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
