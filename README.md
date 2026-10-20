# 系统状态监控

Cinnamon 面板上的 2×2 系统监控小程序，用四个小格显示网络与系统状态。

![Cinnamon](https://img.shields.io/badge/Cinnamon-5.x%20%7C%206.x-2ea44f)
![Platform](https://img.shields.io/badge/Platform-X11-lightgrey)
![License](https://img.shields.io/badge/License-MIT-blue)
![Version](https://img.shields.io/badge/Version-1.0.0-orange)

![预览](screenshots/sysmon2x2.png)

## 简介

一个轻量的面板监控插件，不依赖第三方程序，直接读取内核提供的 `/proc` 与 `/sys`。

四格布局：

```
↑ 上传      内存%
↓ 下载      CPU 频率
```

左列网络，右列系统。鼠标悬停会弹出详情卡，显示 CPU 睿频与全核均值、内存与 Swap、网络速率、磁盘读写。

## 功能

- **2×2 紧凑布局**：一屏看清上传、下载、内存、CPU 频率
- **数值定宽**：数值变化时整体宽度保持不变，不会推动相邻面板图标
- **随面板高度自适应**：字号、图标、行高按面板高度计算；改面板高度或主题后自动重排
- **悬停详情卡**：CPU 睿频峰值 / 全核均值、内存与 Swap、网络上下行、磁盘读写
- **虚拟网卡过滤**：只统计物理网卡，排除 `lo`、`virbr*`、`vnet*`、`docker*`、`br-*`、`veth*`、`tun*`、`tap*` 等接口，虚拟机流量不会重复计入
- **自愈**：连续读取失败 3 次自动重建界面
- **零依赖**：不需要 Python、不需要 root、不额外起后台进程

## 适用系统与版本

| 项目 | 要求 / 测试环境 |
|---|---|
| 桌面环境 | Cinnamon 5.x / 6.x<br>**实测：Cinnamon 6.6.9** |
| 操作系统 | Linux Mint 22.x（基于 Ubuntu 24.04 LTS）<br>**实测：Linux Mint 22.3** |
| 其它发行版 | 任何使用 Cinnamon 的 Linux 发行版（Arch、Debian、Fedora 等），只要 Cinnamon 版本符合即可 |
| 会话类型 | **X11**（Cinnamon 的 applet 接口）<br>Wayland 会话未测试 |
| 内核 | 6.x / 7.x<br>**实测：7.0.0-38-generic（HWE）** |
| 架构 | x86_64（实测）；arm64 未测试 |
| 运行时依赖 | 无（仅使用 GJS / Clutter / GLib，Cinnamon 自带） |
| 权限 | 普通用户，无需 sudo |

## 数据来源

| 指标 | 来源 |
|---|---|
| 上传 / 下载 | `/proc/net/dev` |
| 内存 / Swap | `/proc/meminfo`（`MemTotal`、`MemAvailable`、`SwapTotal`、`SwapFree`） |
| CPU 频率 | `/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq`，失败时回退 `/proc/cpuinfo` |
| 磁盘读写（详情卡） | `/proc/diskstats`，只统计整盘（`sdX`、`nvmeXnY`、`mmcblkX` 等） |

刷新节奏：网络与内存每秒一次，CPU 频率每 2 秒一次。

## 安装

### 方式一：安装脚本

下载或克隆本仓库后：

```bash
cd 系统状态监控
./install.sh
```

### 方式二：手动复制

```bash
mkdir -p ~/.local/share/cinnamon/applets
cp -r . ~/.local/share/cinnamon/applets/sysmon2x2@local
```

必须包含 `applet.js`、`metadata.json`、`stylesheet.css` 三个文件。

### 添加到面板

打开 **系统设置 → 面板 → 添加小程序**，选择「系统状态监控」。
建议放在面板左侧。

> 新安装的插件如果没有出现在列表里，关闭再打开一次「小程序」设置窗口即可。

## 使用

| 操作 | 效果 |
|---|---|
| 鼠标悬停 | 显示详情卡 |
| 左键单击 | 立即刷新一次 |
| 右键 | 移除插件 |

没有设置界面，布局固定。

## 工作原理

```
每秒 ── /proc/net/dev, /proc/meminfo ──┐
每 2 秒 ── cpufreq sysfs ──────────────┼─→ 定宽格式化 → 2×2 显示
悬停 ── /proc/diskstats + 详情 ────────┘
```

- 所有数值先格式化为固定字符数，再配合固定宽度，保证刷新时整块宽度不变
- 字号 `floor(面板高度 / 3)`，图标 `面板高度 × 0.34`，两行正好铺满
- 字体（字体族/字重）不写死，继承面板主题字体
- 详情卡挂在 Clutter stage 上，不参与面板布局

## 已知限制

- 只支持 Linux（依赖 `/proc`、`/sys`）
- CPU 频率为调频驱动上报值，不同平台精度略有差异
- 网卡过滤采用前缀列表，若使用其它虚拟网络（如 `wg*`），可在 `applet.js` 的 `isRealIface()` 中补充
- Wayland 会话未适配

## 目录结构

```
系统状态监控/
├── applet.js              # 全部逻辑与界面
├── metadata.json          # Cinnamon 插件清单
├── stylesheet.css         # 样式
├── install.sh             # 安装脚本
├── screenshots/
│   └── sysmon2x2.png
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 常见问题

**Q：面板上不显示？**
确认目录名与 `metadata.json` 里的 `uuid` 完全一致（`sysmon2x2@local`），然后重启 Cinnamon（Alt+F2 → `r`）。

**Q：虚拟机流量被算进去了？**
确认虚拟网卡名前缀在 `isRealIface()` 的排除列表中，或自行补充。

**Q：修改 `applet.js` 后没生效？**
Cinnamon 会缓存 applet 模块。把插件从面板移除再添加，或重启 Cinnamon。

## 贡献

欢迎提交 Issue 与 Pull Request。修改后请至少验证：

```bash
node --check applet.js
```

并在 Cinnamon 6.x 下实际加载一次。

## 版本

当前版本 `1.0.0`，变更见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT License，见 [LICENSE](LICENSE)。
