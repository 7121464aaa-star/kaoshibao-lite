# 📚 考试宝自用版（kaoshibao-lite）

考试宝（kaoshibao.com）的自用复刻：**纯本地 · 无 VIP · 判分必达** 的个人刷题平台。
不抓取考试宝版权题库、不破解其服务；数据来自用户自己题库的导出/录入。

## 形态

- **PWA**（GitHub Pages 托管，可安装到手机/桌面、可离线）：
  <https://7121464aaa-star.github.io/kaoshibao-lite/>
- **单文件版**：构建产物 `dist/考试宝自用版.html`，双击即用（数据存本浏览器 IndexedDB）。
- **云同步**：设置 → 云同步，用 GitHub Secret Gist 一键推送/拉取（凭据只存本机，冲突=后写覆盖+自动快照）。

## 开发

```bash
node tools/make-icons.mjs     # 生成 PWA 图标
node tools/build-single.mjs   # 打包 dist/（PWA 站）
node tools/serve.mjs 8080 dist   # 本地联调 SW/manifest
```

部署到 GitHub Pages：push 到 `main` 即由 `.github/workflows/deploy.yml` 自动构建并发布 `dist/`。

## 文档

- 项目进度与交接：`docs/项目进度与交接.md`
- 数据模型与判分规则：`docs/数据模型与判分规则.md`
- M4 部署指引（Pages/PWA/云同步/file:// 迁移）：`docs/部署指引-M4.md`
- 各里程碑验收清单：`docs/验收清单-M*.md`

## 功能范围

- 题型：单选 / 多选（全对才得分）/ 判断 / 填空，全部自动判分
- 练习：顺序/随机、题型与章节过滤、错题重练、我的收藏、即时判分、答题卡、背题模式（一键显示答案/解析）
- 模拟考试：限时、交卷统一判分、错题自动入错题本
- 题库：新建/改名/删除、三格式导入（段落/CSV/JSON）、Word(.docx) 导入、多库合并
- 数据：本地搜题、统计与历史、备份/恢复、云同步（Secret Gist）

## 边界（明确不做）

AI 出题/拍照搜题、题库集市/版权内容抓取、群组考试/防作弊、会员与付费。
