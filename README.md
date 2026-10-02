# PDFMate Web

PDF 与图片互转、多文件合并 —— **纯前端、零服务器、零上传**。所有转换都在你的浏览器里完成。

在线地址：**https://uahz.github.io/pdfmate-web/**（GitHub Pages）

## 功能

| 工具 | 说明 |
|---|---|
| 🖼 图片转 PDF | JPG/PNG 多选，支持排序；合并为一个 PDF 或每图一个 PDF；页面尺寸跟随原图或统一 A4 |
| 📄 PDF 转图片 | 浏览器内逐页渲染（pdf.js），96/150/300 DPI，PNG/JPEG，页码范围，ZIP 打包下载 |
| 📚 合并 PDF | 多个 PDF + 图片按顺序合并，图片各占一页 |

> Word / Excel / PPT → PDF 需要完整排版引擎，请使用 **PDFMate 桌面版**（见 Releases）。

## 移动端（iOS / Android 原生安装包）

本仓库的 GitHub Actions 会自动构建**真正的原生安装包**（Capacitor 壳 + 本网页为应用内容）：

- **Android APK**：`PDFMate-1.0.0-android.apk`（Release 附件 / Actions Artifacts）
  安装：手机下载后直接安装，需允许「安装未知来源应用」。
- **iOS IPA（未签名）**：`PDFMate-1.0.0-ios-unsigned.ipa`
  因无 Apple 开发者证书，IPA 为未签名包：用 **AltStore / Sideloadly + 个人 Apple ID** 自签后安装（免费，7 天有效期需续签）；拥有开发者证书的用户可直接签名分发。正式上架 App Store 需苹果开发者账号（$99/年）。
- 重新构建：仓库 **Actions** 页手动 Run workflow，或修改网站文件自动触发；产物自动挂到 Release。

### 本地构建（可选）

```bash
npm install
npx cap add android && npx cap sync android && cd android && ./gradlew assembleDebug   # Android（Windows 可用）
npx cap add ios && npx cap sync ios                                                    # iOS 需 macOS + Xcode
```

## 隐私

- 不上传、无账号、无追踪；转换库经 CDN 加载后由 Service Worker 缓存，断网可用。
- 依赖：pdf-lib（图片→PDF/合并）、pdf.js（PDF 渲染）、JSZip（打包），均为本地运行的开源库。

## 本地运行

直接双击 `index.html` 即可（无构建步骤）；或任意静态服务器：

```bash
npx serve .
```
