# PDFMate V1.0（Windows 桌面端 MVP）

PDF 全格式转换工具 · Electron + 本地双引擎 · 全程本地处理，文件不出电脑。
界面为已定稿的「清透蓝紫 BlueGlass + 全局液态玻璃」设计。

## 快速开始

```bash
npm install        # 已安装过可跳过（postinstall 自动下载 Electron 二进制，走 .npmrc 镜像）
npm start          # 启动应用
npm run smoke      # 端到端自检（真实转换链路，见下）
npm run ui         # 无头截图 UI 预览 → ui-preview.png
npm run dist       # 打包安装包（electron-builder，需联网拉取打包工具）
```

## V1.0 功能范围（对应路线图 M1）

| 功能 | 说明 |
|---|---|
| Word / Excel / PPT → PDF | .doc/.docx/.rtf/.txt、.xls/.xlsx/.csv、.ppt/.pptx/.pps/.ppsx，批量 |
| 图片 → PDF | JPG/PNG，每图一页或合并为一个 PDF；页面尺寸（跟随原图 / A4） |
| PDF → 图片 | pdf.js 渲染，DPI 预设 96/150/300，PNG/JPEG，页码范围，自动打 ZIP |
| 多格式合并 → PDF | Word/Excel/PPT + 图片 + 现有 PDF 混合按顺序合并，可自定义文件名 |
| 批量队列 | 并发调度（图片 4 并发 / 引擎分块）、失败重试、暂停/取消、完成报告 |
| 预设模板 | 打印版 150DPI / 归档版 300DPI / 最小体积 |
| 输出规则 | 同源目录或指定目录；重名自动追加 -1/-2 |
| 任务中心 | 历史记录持久化（%APPDATA%/PDFMate/history.json），可清空 |
| 引擎引导 | 未检测到引擎 / 管理员身份运行时顶部横幅提示 |

侧栏中「PDF 转 Word / PDF 转 Excel / PDF 工具箱 / OCR」为 v1.3+ 预留入口（置灰）。

## 双引擎策略

- `auto`（默认）：**LibreOffice headless 优先**——无头、确定性、不受 Office 首次运行对话框影响。
- `office`：MS Office COM（还原度优先），通过 `engines/run-office.ps1` 桥调用；
  每次批量前做**健康探测**（`engines/probe-office.ps1`，30s 超时），探测失败时：
  - 已装 LibreOffice → 自动降级并持久化设置 + 弹提示；
  - 未装 → 任务报错并给出明确引导。
- 所有子进程调用一律参数数组（shell=false），不拼接命令字符串。

> 本机注意：Word 的 COM 自动化可能被首次运行/激活对话框阻塞（表现为转换超时）。
> 应用会自动降级到 LibreOffice；如需 COM 引擎，请先手动打开一次 Word/Excel 完成初始设置。

## 安全设计

- 渲染端写盘使用**一次性令牌**：`pdf2img:prepare` 签发 token，写文件仅接受纯文件名，
  主进程校验路径边界（拒绝 `..` 与跨目录）。
- IPC 通道白名单（preload.js），`contextIsolation + sandbox + nodeIntegration:false`。
- 子进程全参数数组调用；任务结束即清理临时目录。

## 端到端自检（npm run smoke）

覆盖 7 步真实链路：引擎检测 → LibreOffice 生成 docx/xlsx 样例 → 渲染端 Canvas 出图 →
Office 批量转 PDF → 图片→PDF → 多格式合并（PDF+docx+png）→ PDF 转图片+ZIP。
结果写入 `smoke-report.json`，退出码 0=全过。

## 目录结构

```
main.js            Electron 主进程：窗口/IPC/队列接线/自检入口
preload.js         上下文桥（通道白名单）
lib/queue.js       批量队列：模式/分块/并发/重试/取消/降级
lib/engines.js     双引擎：COM 桥 + LibreOffice 桥 + 健康探测
lib/pdfops.js      pdf-lib：图片→PDF / 合并 / 页数
lib/store.js       设置与历史持久化
lib/util.js        类型识别/输出命名/页码范围
engines/*.ps1      Office COM 桥 / 健康探测 / 样例生成
renderer/          UI（theme.css 设计令牌 + 工作台 + pdf.js 渲染）
smoke.js           端到端自检编排
test-bridge.js     引擎桥手动诊断工具（node test-bridge.js）
```

## 已知限制（V1.0）

- PDF→Word / PDF→Excel / OCR 未包含（v1.3–v2.0 路线图）。
- 图片仅支持 JPG/PNG（WebP 等将在后续版本经 Canvas 转码支持）。
- 拖拽文件夹依赖 Electron File.path；个别环境若取不到路径请用「添加文件夹」。
- 安装包分发需运行 `npm run dist`（electron-builder）。
