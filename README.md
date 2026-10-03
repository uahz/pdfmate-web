# PDFMate

PDF 全格式转换工具 · Windows 桌面端 + Web + Android + iOS · **全程本地处理，文件不上传**。

设计语言：清透蓝紫（BlueGlass）+ 全局液态玻璃。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `/`（根目录） | **网页端**（GitHub Pages 在线站点）：图片⇄PDF、PDF转图片、多文件合并，纯前端零上传；兼作 Capacitor 移动端 Web 资产源 |
| `.github/workflows/` | 移动端自动构建：`android-apk.yml`（APK）、`ios-ipa.yml`（未签名 IPA）、`ios-signed.yml`（证书签名 IPA，需配置 Secrets） |
| `desktop/` | **Windows 桌面端**（Electron）：Word/Excel/PPT→PDF、图片→PDF、PDF→图片、多格式合并、批量队列、双引擎（LibreOffice / MS Office COM） |
| `design/` | 四端设计风格参考稿（PC / Web / iOS / Android，高保真 HTML） |

## 下载安装（v1.3.0）

前往 **[Releases](https://github.com/uahz/pdfmate-web/releases/latest)**：

| 平台 | 文件 | 安装方式 |
|---|---|---|
| Windows | `PDFMate Setup 1.3.0.exe` | 双击安装（含资源管理器右键菜单） |
| Windows（便携） | `PDFMate 1.3.0.exe` | 双击直接运行 |
| Android | `PDFMate-1.3.0-android.apk` | 下载安装，允许「未知来源应用」 |
| iOS | `PDFMate-1.3.0-ios-unsigned.ipa` | 未签名包，用 AltStore / Sideloadly + Apple ID 自签后安装（需开发者证书可走 `ios-signed.yml` 出签名包） |

## 桌面端开发

```bash
cd desktop
npm install        # postinstall 自动下载 Electron 二进制（.npmrc 已配置国内镜像）
npm start          # 启动应用
npm run smoke      # 端到端自检（7 步真实转换链路）
npm run dist       # 打包 portable + NSIS 安装程序
```

双引擎说明：默认 LibreOffice headless 优先（无头、确定性）；可切换 MS Office COM（还原度优先，带健康探测与自动降级）。详见 `desktop/README.md`。

## 移动端构建

修改根目录网页文件或 `assets/` 图标后推送，Actions 自动构建并更新 Release 附件；
也可在 Actions 页面手动 Run workflow。

## 安全设计要点

- 网页/移动端：全部转换在客户端完成，无任何网络上传；Service Worker 缓存，离线可用。
- 桌面端：本地引擎处理；渲染端写盘使用一次性令牌 + 路径边界校验；IPC 通道白名单；子进程参数数组调用。
