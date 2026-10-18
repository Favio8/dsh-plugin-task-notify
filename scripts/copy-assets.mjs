import { readFileSync, writeFileSync } from 'node:fs'

// tsdown 的 clean 会清空 lib/；构建后把常驻渲染脚本复制到产物目录。
// Windows PowerShell 5.1 依赖 BOM 识别 UTF-8，必须写入 BOM。
const script = readFileSync('src/renderer.ps1', 'utf8')
writeFileSync('lib/renderer.ps1', `\uFEFF${script}`, 'utf8')
