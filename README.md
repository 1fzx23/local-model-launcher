# 本地 AI 模型启动器（桌面应用版）

一键启动本地 LLM 与 Stable Diffusion 文生图模型的图形界面应用。内嵌终端日志与模型网页界面，支持应用内下载模型/运行环境，模型目录可 OTA 在线更新。

## AI 是怎么制作的？

本应用由 **AI 辅助开发**完成——从需求拆解、代码编写、UI 设计到打包发布，AI 完成了绝大部分工作。详细的制作过程记录在 [**AI制作说明.md**](./AI制作说明.md) 中，包括：

- 技术选型理由（为什么用 Electron / 为什么不用前端框架）
- 完整开发过程（需求 → 架构 → 实现 → 迭代）
- AI 具体做了什么 vs 人类做了什么
- 遇到的坑和解决方案

> 👆 建议先看看这个文件，了解背后的故事。

## 使用

- 双击 `本地AI模型启动器.exe`（或桌面快捷方式）。
- **对话模型 / 文生图**页：卡片上点「▶ 启动」，服务就绪后右侧自动加载网页界面；「🖥 终端」标签可看实时日志。
- 未安装的模型点「⬇ 下载」，可选下载源（魔搭 / HF 镜像），支持断点续传；取消后再点会继续下。
- **运行环境**页：下载并自动解压 llama.cpp / stable-diffusion.cpp 各后端（CPU / Vulkan / CUDA / SYCL / HIP / OpenVINO）。
- **设置**页：改模型仓库目录、OTA 清单地址、`-n` 生成长度、CPU 线程数。

## 内置可直接启动（本机已有文件）

CPU 文本模型全部 + Qwen2.5-1.5B；其余模型需在应用内下载。

## OTA 清单更新

应用启动时自动从「设置 → OTA 清单地址」拉取 `manifest.json`；云端 `manifestVersion` 更大时自动覆盖内置目录（新增模型、修正下载地址均无需重装应用）。

发布方法：把 `src/manifest.json` 复制一份托管到 GitHub / Gitee / 任意静态服务器，改版本号即可。

## 目录结构

```
D:\model-launcher-app\              # 应用源码（Electron）
├── src\main.js                     # 主进程：进程管理/下载器/OTA
├── src\preload.js                  # IPC 桥
├── src\manifest.json               # 内置模型目录（可 OTA 覆盖）
├── src\renderer\                   # 界面（深色主题 + SVG 扁平图标）
├── build\icon.ico                  # 应用图标（紫青渐变 + AI 神经网络节点）
├── AI制作说明.md                    # 📖 AI 制作过程记录
├── README.md                       # 本文件
└── dist\本地AI模型启动器-1.0.0.exe # 打包产物（portable，约 280MB）

D:\model-launcher\本地AI模型启动器.exe # 部署副本（与模型同目录）
```

## 重新打包

```bash
cd D:\model-launcher-app
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npx electron-builder --win portable
```

注意：`package.json` 中已设 `signAndEditExecutable: false`（非管理员环境跳过 winCodeSign 符号链接问题）。

## 技术要点

1. sd-server 参数顺序：`-m` 必须在最后（自定义 `args` 模板的模型也遵守）。
2. SDXL / SD3.5 / FLUX 已自动附加 `--vae-on-cpu` 防 8GB 核显 OOM。
3. 端口隔离：LLM 8080，SD 系列 8081-8092 各占一端口，可同时跑一个 LLM + 一个 SD。
4. SD3.5 / FLUX 需要额外文本编码器与 VAE，应用会随主模型自动补齐下载（manifest `extraFiles`）。
5. 下载失败/取消保留 `.part` 文件，断点续传。

## 下载

预编译 exe 可从 [GitHub Releases](../../releases) 直接下载（直链），无需自己编译。

## 许可证

MIT License — 自由使用、修改、分发。
