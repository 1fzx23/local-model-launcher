# 本地 AI 模型启动器 — AI 制作说明

本文档记录「本地 AI 模型启动器」这款桌面应用是如何由 **AI 辅助开发**完成的。

## 概述

- **应用名称**：本地 AI 模型启动器（Local Model Launcher）
- **技术栈**：Electron 33 + electron-builder 25（便携单 exe），原生 HTML / CSS / JavaScript，无前端框架
- **AI 工具**：WorkBuddy（基于 Claude 的 AI 编程助手）
- **开发者角色**：用户提出需求、确认决策；AI 负责代码编写、调试、打包、发布
- **开发周期**：2026 年 7 月 24 日（一天内完成从零到可发布的完整产品）

## 从需求到成品：完整过程

### 第一步：需求拆解

用户最初的需求很简单：

> 做一个能一键启动本地 LLM 和 Stable Diffusion 模型的图形界面工具。

AI 将这个一句话需求拆解为以下功能模块：

| 模块 | 功能描述 |
|------|----------|
| 模型卡片库 | 展示 19 个模型（LLM 0.8B~34B + SD 生图 12 款），每个卡片显示名称/大小/状态 |
| 运行环境管理 | 10 种运行后端（llama.cpp CPU/Vulkan/CUDA/SYCL/HIP/OpenVINO + sd.cpp Vulkan/CPU/CUDA） |
| 一键启动 | 点击启动按钮 → 自动拼装命令行参数 → 启动进程 → 内嵌终端显示日志 |
| 应用内下载器 | 支持断点续传的文件下载（.part 文件），可选魔搭 / HF 镜像源 |
| 网页界面集成 | 启动后自动在右侧加载模型的 Web UI（聊天界面 / SD 生成页） |
| OTA 在线更新 | 通过 `manifest.json` 清单在线更新模型目录，无需重装应用 |
| 设置面板 | 可配置模型目录、OTA 地址、生成参数等 |

### 第二步：技术选型

AI 推荐并采用了以下技术方案：

- **Electron**：跨平台桌面框架，可将 Web 技术打包为独立 exe。选择理由：
  - 用户已有 Electron 环境（之前用 bat 脚本跑 llama.cpp）
  - 单 exe 便携部署，无需安装依赖
  - 内嵌 webview 可直接加载模型网页 UI
- **electron-builder portable 目标**：输出单个 `.exe` 文件，双击即用
- **原生 HTML/CSS/JS**：不引入 React/Vue 等框架，保持体积最小、启动最快
- **深色玻璃主题**：匹配开发者工具风格，护眼且专业

### 第三步：核心实现

#### 主进程（main.js，约 520 行）

- **进程管理**：`child_process.spawn` 启动/停止运行环境，端口隔离（LLM 8080，SD 8081-8092）
- **下载器**：基于 `https.get` 的断点续传下载器，支持 Range 请求、进度回调、取消/恢复
- **OTA 更新**：启动时静默拉取远程 `manifest.json`，比较 `manifestVersion` 字段决定是否覆盖内置清单
- **IPC 通信**：通过 `preload.js` 安全桥接主进程与渲染进程

#### 渲染进程（renderer/）

- **index.html**：单页面应用结构（侧栏导航 + 内容区 + dock 面板）
- **app.js**（约 700 行）：全部业务逻辑——卡片渲染、启动/停止/下载操作、状态轮询、webview 管理
- **style.css**：深色主题样式（`#0d1117` 背景、毛玻璃效果、响应式布局）
- **图标系统**：全部使用内联 SVG（Feather/Lucide 线性风），不依赖外部图片文件

#### 模型清单（manifest.json，约 27KB）

- 定义 19 个模型和 10 个运行环境的完整元数据
- 包含下载地址、命令行模板、端口分配、额外文件（SD 的 clip/t5xxl/vae）等

### 第四步：迭代优化（AI 驱动的持续改进）

整个开发过程中，用户不断提出反馈，AI 快速迭代：

| 迭代 | 用户反馈 | AI 解决方案 |
|------|----------|-------------|
| 图标美化 | "界面里的图标都是表情符号" | 全部替换为内联 SVG 扁平图标（Feather/Lucide 风格），新增 ICONS 字典 + svgIcon() 函数 |
| 网页白底 JSON | "右侧弹出白底乱码" | 新增 webview 加载检测层，非 HTML 内容显示中文提示而非裸显 JSON |
| EXE 图标 | "任务栏图标要自定义" | 用 Python/PIL 生成多尺寸 Windows ICO（紫青渐变 + AI 神经网络节点设计） |
| 中文名 | "名字要改成中文" | productName / 窗口标题 / HTML 标题 / exe 文件名全部改为「本地 AI 模型启动器」 |
| 便携模式 | "数据要跟 exe 放一起" | 实现 PORTABLE_EXECUTABLE_DIR 检测，默认 `model-data` 目录与 exe 同级 |
| 打包优化 | "exe 太大/太慢" | compression 设为 store（速度优先）；npmmirror 国内镜像加速下载 |

### 第五步：打包与发布

```bash
# 使用国内镜像加速
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npx electron-builder --win portable
```

产出：**本地AI模型启动器-1.0.0.exe**（约 280 MB，含 Electron 运行时 + 应用代码）

发布方式：
- **源码**：GitHub 仓库（公开，MIT 协议）
- **预编译 exe**：GitHub Releases（仿 llama.cpp 的 release 二进制分发方式，提供直链下载）

## AI 参与的具体工作

在整个开发过程中，AI 完成了以下工作：

1. **架构设计**：根据用户一句话需求，设计了完整的模块划分和技术方案
2. **代码编写**：编写了全部 ~1500 行源码（main.js / preload.js / app.js / style.css / index.html / manifest.json）
3. **调试排错**：解决了 Electron 环境变量陷阱、winCodeSign 符号链接权限、webview 白底 JSON 等多个问题
4. **UI 设计**：实现了深色玻璃主题、SVG 扁平图标系统、响应式布局
5. **图标生成**：用 Python/PIL 程序化生成 Windows 多尺寸 ICO 图标
6. **文档撰写**：编写了 README.md（使用说明）和本文件（AI 制作说明）
7. **Git 与发布**：初始化 Git 仓库、提交代码、通过 GitHub API 发布到 GitHub（含 Release 上传 exe）

## 人类参与的工作

用户（人类）在过程中负责：

- 提出初始需求和功能设想
- 测试应用并给出反馈（图标、标题、bug 等）
- 确认技术决策（中文名、图标风格、发布方案等）
- 最终审核成品并决定发布

## 总结

这是一个典型的 **人机协作开发** 案例：人类提供愿景和方向，AI 负责将想法转化为可运行的代码。从需求到成品只用了不到一天时间，体现了 AI 辅助开发的效率优势。

> **核心原则**：AI 不是替代开发者，而是放大开发者的能力。好的产品仍然需要人类的审美判断、用户体验洞察和最终决策。
