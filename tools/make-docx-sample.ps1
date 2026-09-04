# make-docx-sample.ps1 —— 生成 .docx 导入功能的测试样本（tools/testdata/）
# 产物1 docx-段落题号-样例.docx：题目以 "1. " 字面编号，逐段排列（无空行）→ 测题号断题
# 产物2 docx-自动编号-样例.docx：题干段落带 w:numPr（Word 自动编号，无字面题号）→ 测 numPr 断题
# 用法：pwsh -File tools/make-docx-sample.ps1 （在仓库根目录执行）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$outDir = Join-Path $PSScriptRoot 'testdata'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Docx([string]$path, [string]$docXml) {
  if (Test-Path $path) { Remove-Item $path -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($path, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $entries = @{
      '[Content_Types].xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>'
      '_rels/.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
      'word/document.xml' = $docXml
    }
    foreach ($name in $entries.Keys) {
      $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $sw = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
      $sw.Write($entries[$name])
      $sw.Close()
    }
  } finally {
    $zip.Dispose()
  }
}

function P([string]$txt) { return "<w:p><w:r><w:t>$txt</w:t></w:r></w:p>" }
function NP([string]$txt) {
  # 自动编号段落：带 numPr，无字面题号
  return '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>' + $txt + '</w:t></w:r></w:p>'
}

# ---------- 产物1：段落题号式 ----------
$doc1 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
 '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
 (P '1. Word导入测试·单选：1+1等于几？') +
 (P 'A. 1') + (P 'B. 2') + (P 'C. 3') +
 (P '答案：B') + (P '解析：基础加法。') +
 (P '2. 以下哪些属于输入设备？（多选）') +
 (P 'A. 键盘') + (P 'B. 鼠标') + (P 'C. 显示器') + (P 'D. 扫描仪') +
 (P '答案：ABD') +
 (P '3. 光在真空中的传播速度约为每秒 30 万千米。') +
 (P '答案：对') +
 (P '4. 我国国歌的名称是《（　）》。') +
 (P '答案：义勇军进行曲|义勇军军歌') + (P '解析：田汉作词、聂耳作曲。') +
 '</w:body></w:document>'

# ---------- 产物2：自动编号（numPr）式 ----------
$doc2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
 '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
 (NP 'Word自动编号·判断：地球上的潮汐主要由月球引力引起。') +
 (P '答案：对') +
 (NP 'Word自动编号·填空：太阳系中距离太阳最近的行星是（　）。') +
 (P '答案：水星') +
 '</w:body></w:document>'

New-Docx (Join-Path $outDir 'docx-段落题号-样例.docx') $doc1
New-Docx (Join-Path $outDir 'docx-自动编号-样例.docx') $doc2
Write-Host ('✔ 已生成测试样本：' + (Join-Path $outDir 'docx-段落题号-样例.docx') + ' 与 docx-自动编号-样例.docx')
