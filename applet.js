/* 系统状态监控 — Cinnamon 面板 2×2 系统监控
 *
 * 布局：
 *   ↑ 上传      内存%
 *   ↓ 下载      CPU 频率
 *
 * 实现说明：
 *   1. 数值使用固定宽度，刷新时整体宽度保持不变，不影响相邻 applet；
 *   2. 字号与图标尺寸随面板高度计算，40px 面板下两行铺满；
 *   3. 不指定字体族与字重，继承面板主题字体；
 *   4. 网卡过滤：排除 lo 及虚拟/桥接设备，避免虚拟机流量重复计入；
 *   5. CPU 频率优先读 sysfs，失败时回退 /proc/cpuinfo；
 *   6. 连续读取失败 3 次自动重建；
 *   7. 面板高度或主题变化时重新计算排版。
 */

const Applet = imports.ui.applet;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Tooltips = imports.ui.tooltips;
const Cinnamon = imports.gi.Cinnamon;

// 对齐枚举：Cinnamon 6.x 的 St.Widget x_align/y_align 期望 Clutter.ActorAlign。
// 旧的 St.Align.MIDDLE(=1) 会被当成 Clutter.ActorAlign.START(=1) → 顶端对齐（图标/文字上飘）。
// 统一使用下面两个常量。
const A_CENTER = Clutter.ActorAlign.CENTER;
const A_START  = Clutter.ActorAlign.START;
const A_FILL   = Clutter.ActorAlign.FILL;

const REFRESH_MS = 1000;         // 主刷新周期
const CPU_FREQ_EVERY_N = 2;      // CPU 频率每 N 次 tick 读一次（1s x 2 = 2s）

/* ------------------------------ 数据读取 ------------------------------ */

function readTextFile(path) {
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        if (!ok || contents === null) return null;
        return imports.byteArray.toString(contents);
    } catch (e) {
        return null;
    }
}

// 只统计"物理"网卡：排除 lo 及所有虚拟/桥接/tun
function isRealIface(name) {
    if (!name || name === 'lo') return false;
    const skip = ['virbr', 'vnet', 'docker', 'br-', 'veth', 'tun', 'tap', 'lxcbr', 'zt', 'kube'];
    for (let i = 0; i < skip.length; i++) {
        if (name.indexOf(skip[i]) === 0) return false;
    }
    return true;
}

function readNet() {
    const txt = readTextFile('/proc/net/dev');
    if (!txt) return null;
    let rx = 0, tx = 0;
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const c = line.indexOf(':');
        if (c < 0) continue;
        const iface = line.slice(0, c).trim();
        if (!isRealIface(iface)) continue;
        const cols = line.slice(c + 1).trim().split(/\s+/);
        if (cols.length < 16) continue;
        rx += parseInt(cols[0], 10) || 0;
        tx += parseInt(cols[8], 10) || 0;
    }
    return { rx: rx, tx: tx };
}

function readMem() {
    const txt = readTextFile('/proc/meminfo');
    if (!txt) return null;
    let total = 0, avail = 0, free = 0;
    let swapTotal = 0, swapFree = 0;
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let m;
        if ((m = lines[i].match(/^MemTotal:\s+(\d+)/))) total = parseInt(m[1], 10);
        else if ((m = lines[i].match(/^MemAvailable:\s+(\d+)/))) avail = parseInt(m[1], 10);
        else if ((m = lines[i].match(/^MemFree:\s+(\d+)/))) free = parseInt(m[1], 10);
        else if ((m = lines[i].match(/^SwapTotal:\s+(\d+)/))) swapTotal = parseInt(m[1], 10);
        else if ((m = lines[i].match(/^SwapFree:\s+(\d+)/))) swapFree = parseInt(m[1], 10);
    }
    if (!total) return null;
    const usedAvail = avail || free;
    return {
        total: total,                 // KB
        used: total - usedAvail,      // KB
        pct: Math.round(((total - usedAvail) / total) * 100),
        swapTotal: swapTotal,         // KB
        swapUsed: swapTotal - swapFree,
    };
}

// CPU 频率：返回 { max（睿频峰值）, avg（全核平均） }，单位 MHz
function readCpuFreqs() {
    let sum = 0, max = 0, n = 0;
    for (let i = 0; i < 128; i++) {
        const v = readTextFile('/sys/devices/system/cpu/cpu' + i + '/cpufreq/scaling_cur_freq');
        if (!v) break;                    // 编号连续，第一个不存在即结束
        const k = parseInt(v.trim(), 10);
        if (k > 0) { sum += k / 1000; if (k / 1000 > max) max = k / 1000; n++; }
    }
    if (n > 0) return { max: max, avg: sum / n };

    const txt = readTextFile('/proc/cpuinfo');
    if (!txt) return null;
    const re = /^cpu MHz\s*:\s*([\d.]+)/gm;
    let m;
    while ((m = re.exec(txt)) !== null) {
        const f = parseFloat(m[1]);
        sum += f; if (f > max) max = f; n++;
    }
    return n > 0 ? { max: max, avg: sum / n } : null;
}

// 兼容旧调用：平均频率
function readCpuMHz() {
    const f = readCpuFreqs();
    return f ? f.avg : null;
}

// 磁盘累计读写字节（只统计整盘，排除分区/loop/ram）
function isWholeDisk(name) {
    return /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name);
}

function readDisk() {
    const txt = readTextFile('/proc/diskstats');
    if (!txt) return null;
    let rd = 0, wr = 0;
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const f = lines[i].trim().split(/\s+/);
        if (f.length < 10) continue;
        if (!isWholeDisk(f[2])) continue;
        rd += (parseInt(f[5], 10) || 0) * 512;   // 扇区→字节
        wr += (parseInt(f[9], 10) || 0) * 512;
    }
    return { read: rd, write: wr };
}

/* ------------------------------ 定宽格式化 ------------------------------ */

// 恒 3 字符（含小数点）：0.0 ~ 999
function fmtSpeedNum(v) {
    if (v < 9.95) return v.toFixed(1);
    return String(Math.min(999, Math.round(v)));
}

function fmtSpeed(bps) {
    if (bps === null || bps === undefined || !isFinite(bps) || bps < 0) return '  -.---';
    const units = ['B/s', 'K/s', 'M/s', 'G/s'];
    let i = 0, v = bps;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return fmtSpeedNum(v) + units[i];
}

function fmtMem(m) {
    if (!m || !m.total) return '--%';
    const p = Math.round((m.used / m.total) * 100);
    return String(p) + '%';
}

function fmtFreq(mhz) {
    if (!mhz || !isFinite(mhz)) return '-.-G';
    return (mhz / 1000).toFixed(1) + 'G';
}

// KB → 人类可读（G/M），保留 1 位小数
function fmtKB(kb) {
    if (kb === null || kb === undefined || !isFinite(kb) || kb < 0) return '-.-G';
    const gb = kb / 1024 / 1024;
    if (gb >= 1) return gb.toFixed(1) + 'G';
    const mb = kb / 1024;
    return mb.toFixed(0) + 'M';
}

/* --------------------------------- Applet --------------------------------- */

function SysMon2x2Applet(metadata, orientation, panelId, instanceId) {
    this._init(metadata, orientation, panelId, instanceId);
}

SysMon2x2Applet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function(metadata, orientation, panelId, instanceId) {
        Applet.Applet.prototype._init.call(this, orientation, panelId, instanceId);
        try { this.setAllowedLayout(Applet.AllowedLayout.BOTH); } catch (e) {}

        this.actor.add_style_class_name('sysmon2x2-applet');
        this.actor.remove_style_class_name('applet-box'); // 去掉默认的水平 padding

        this._prev = null;
        this._prevDisk = null;
        this._lastUp = null;
        this._lastDn = null;
        this._lastDiskR = null;
        this._lastDiskW = null;
        this._n = 0;
        this._failed = 0;
        this._panelId = panelId;
        this._orientation = orientation;
        this._popupVisible = false;

        this._buildUI();
        this._relayout();
        this._buildPopup();

        // 悬停显示/隐藏浮动详情卡（不再用默认 tooltip，避免两层重叠）
        this.actor.connect('enter-event', Lang.bind(this, function() {
            this._showPopup();
            return true;
        }));
        this.actor.connect('leave-event', Lang.bind(this, function() {
            this._hidePopup();
            return true;
        }));

        // 面板高度变化 → 重排
        try {
            const panel = Main.panelManager.getPanelById(panelId);
            if (panel && panel.actor) {
                this._panel = panel;
                this._panelHeightSig = panel.actor.connect('notify::height',
                    Lang.bind(this, function() { this._relayout(); }));
            }
        } catch (e) {}

        // 主题切换 → 重排
        try {
            this._themeSig = Main.themeManager.connect('theme-set',
                Lang.bind(this, function() { this._relayout(); }));
        } catch (e) {}

        // 面板高度设置变化时重排
        try {
            this._panelSetSig = Main.settings.connect('changed::panels-height',
                Lang.bind(this, function() {
                    Mainloop.timeout_add(200, Lang.bind(this, function() {
                        this._resolvePanel();
                        this._relayout();
                        return false;
                    }));
                }));
        } catch (e) {}

        // 立即刷一次，再启动定时器
        this._tickOnce(false);
        this._timer = Mainloop.timeout_add(REFRESH_MS, Lang.bind(this, function() {
            this._tickOnce(true);
            return true;
        }));
    },

    _resolvePanel: function() {
        try {
            const p = Main.panelManager.getPanelById(this._panelId);
            if (p) this._panel = p;
        } catch (e) {}
    },

    _buildUI: function() {
        // 根容器：水平；在 applet-box（=面板高）内垂直居中
        this._root = new St.BoxLayout({
            style_class: 'sysmon-root',
            vertical: false,
            x_align: A_START,
            y_align: A_CENTER,
            y_expand: false,
        });
        this.actor.add_child(this._root);

        // 左列（网络） / 右列（系统）；列在根内垂直居中、水平靠左
        this._colL = new St.BoxLayout({ style_class: 'sysmon-col', vertical: true, x_align: A_START, y_align: A_CENTER });
        this._colR = new St.BoxLayout({ style_class: 'sysmon-col', vertical: true, x_align: A_START, y_align: A_CENTER });
        this._root.add_child(this._colL);
        this._root.add_child(this._colR);

        // (col1,row1) 上传  ·  (col1,row2) 下载
        // 用 pan-up/pan-down 实心三角（▲▼），比 network-transmit/receive 的双向 ⇄ 更易分辨上下
        this._cellUp = this._makeCell('pan-up-symbolic', '---B/s', 'sysmon-speed');
        this._cellDn = this._makeCell('pan-down-symbolic', '---B/s', 'sysmon-speed');
        this._colL.add_child(this._cellUp.box);
        this._colL.add_child(this._cellDn.box);

        // (col2,row1) 内存  ·  (col2,row2) CPU
        this._cellMem = this._makeCell('drive-harddisk-symbolic', '--%', 'sysmon-mem');
        this._cellCpu = this._makeCell('speedometer-symbolic', '-.-G', 'sysmon-cpu');
        this._colR.add_child(this._cellMem.box);
        this._colR.add_child(this._cellCpu.box);
    },

    _makeCell: function(iconName, initialText, labelClass) {
        // 单元格：水平；在列内垂直居中（列高=两行 rowH，单元格 min-height=rowH）
        const box = new St.BoxLayout({
            style_class: 'sysmon-cell',
            vertical: false,
            x_align: A_START,
            y_align: A_CENTER,
            y_expand: true,
        });
        const icon = new St.Icon({
            icon_name: iconName,
            icon_type: St.IconType.SYMBOLIC,
            style_class: 'sysmon-icon',
            y_align: A_CENTER,
        });
        const label = new St.Label({
            text: initialText,
            style_class: 'sysmon-label ' + (labelClass || ''),
            y_align: A_CENTER,
        });
        box.add_child(icon);
        box.add_child(label);
        return { box: box, icon: icon, label: label };
    },

    // 根据面板高度动态计算字号 / 图标 / 行高
    _relayout: function() {
        let h = 40;
        try {
            if (this._panel && this._panel.actor) h = this._panel.actor.height;
        } catch (e) {}
        if (!h || h < 20) h = 40;

        // 面板高 h（逻辑 px），两行各 h/2。
        // St.Label 行高约为 1.5em（Pango 度量，而非字体大小的 1.16 倍）。
        // 不溢出条件：2 * 1.5 * fontSize <= h  →  fontSize = floor(h/3)。
        // 40px 面板 → 13px 字号（行高 19.5，两行 39，留 1px 余量，饱满不裁字）。
        const fontSize = Math.max(10, Math.floor(h / 3));      // 40 → 13
        const iconSize = Math.max(9,  Math.round(h * 0.34));   // 40 → 14
        const rowH     = Math.max(14, Math.floor(h / 2));      // 40 → 20
        const cellPadX = 1;

        // 只写字号；字体族与字重刻意不写死 → 继承 #panel 的系统字体/字重（normal），
        // 与右侧时钟保持一致，日后换系统字体会自动跟随。
        this._root.set_style('font-size: ' + fontSize + 'px;');

        const cells = [this._cellUp, this._cellDn, this._cellMem, this._cellCpu];
        for (let i = 0; i < cells.length; i++) {
            const c = cells[i];
            if (!c) continue;
            c.icon.set_icon_size(iconSize);
            c.box.set_style('min-height: ' + rowH + 'px; padding: 0 ' + cellPadX + 'px;');
        }
    },

    /* ------------------------- 悬停浮动详情卡 ------------------------- */

    _buildPopup: function() {
        this._popup = new St.BoxLayout({
            style_class: 'sysmon-pop',
            vertical: true,
            reactive: false,
        });

        // cpu-symbolic 仅部分图标主题提供；缺失时不渲染会导致该行左移，故改用 speedometer-symbolic。
        // 改用与面板 CPU 格一致、已验证可渲染的 speedometer-symbolic。
        this._popCpu  = this._makePopRow('speedometer-symbolic',                'CPU');
        this._popMem  = this._makePopRow('drive-harddisk-symbolic',             '内存');
        this._popNet  = this._makePopRow('preferences-system-network-symbolic', '网络');
        this._popDisk = this._makePopRow('drive-multidisk-symbolic',            '磁盘');

        this._popup.add_child(this._popCpu.row);
        this._popup.add_child(this._popMem.row);
        this._popup.add_child(this._popNet.row);
        this._popup.add_child(this._popDisk.row);

        // 挂到 global.stage 顶层并 raise_top → 浮在面板与窗口之上
        // 挂在 Main.uiGroup 下的 actor 不会渲染，需直接挂到 stage
        try { global.stage.add_child(this._popup); } catch (e) {}
        this._popup.hide();
        this._popup.opacity = 0;
    },

    _makePopRow: function(iconName, name) {
        const row = new St.BoxLayout({ style_class: 'sysmon-pop-row', vertical: false });
        const icon = new St.Icon({
            icon_name: iconName,
            icon_type: St.IconType.SYMBOLIC,
            style_class: 'sysmon-pop-icon',
            y_align: A_CENTER,
        });
        const nameL = new St.Label({ text: name, style_class: 'sysmon-pop-name', y_align: A_CENTER });
        const val = new St.Label({ text: '—', style_class: 'sysmon-pop-val', y_align: A_CENTER });
        // 挂到 stage 后父级不做布局，长文本可能被挤压成省略号 → 显式关闭省略
        try { nameL.ellipsize = 0; val.ellipsize = 0; } catch (e) {}
        row.add_child(icon);
        row.add_child(nameL);
        row.add_child(val);
        return { row: row, icon: icon, name: nameL, val: val };
    },

    _positionPopup: function() {
        if (!this._popup) return;
        let ax = 0, ay = 0;
        try {
            const pos = this.actor.get_transformed_position();
            ax = pos[0]; ay = pos[1];
        } catch (e) { return; }
        const ph = this._popup.height;
        let bottom = true;
        try { bottom = this._panel ? this._panel.bottomPosition : true; } catch (e) {}
        const gap = 6;
        const y = bottom ? (ay - ph - gap) : (ay + this.actor.height + gap);
        this._popup.set_position(Math.round(ax), Math.round(y));
    },

    _showPopup: function() {
        if (!this._popup) { global.log('SYSMON-EVT show: no popup'); return; }
        this._updatePopup();
        this._popup.show();
        try { this._popup.raise_top(); } catch (e) {}
        this._positionPopup();
        this._popupVisible = true;
        // 浮动入场：淡入 + 轻微上浮
        this._popup.opacity = 0;
        this._popup.translation_y = 8;
        try {
            this._popup.ease({
                opacity: 255, translation_y: 0, duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } catch (e) {}
        // 兜底：ease 在某些帧/未 realize 时不生效会令 opacity 停在 0（卡隐形）。
        // 200ms 后若仍应可见则强制终态。
        Mainloop.timeout_add(200, Lang.bind(this, function() {
            if (this._popupVisible && this._popup) {
                this._popup.opacity = 255;
                this._popup.translation_y = 0;
            }
            return false;
        }));
    },

    _hidePopup: function() {
        if (!this._popup || !this._popupVisible) return;
        this._popupVisible = false;
        try {
            this._popup.ease({
                opacity: 0, translation_y: 8, duration: 110,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: Lang.bind(this, function() {
                    try { this._popup.hide(); } catch (e) {}
                }),
            });
        } catch (e) {}
        // 兜底：确保一定隐藏
        Mainloop.timeout_add(200, Lang.bind(this, function() {
            if (!this._popupVisible && this._popup) {
                this._popup.opacity = 0;
                this._popup.hide();
            }
            return false;
        }));
    },

    _updatePopup: function() {
        if (!this._popup) return;
        try {
            const f = readCpuFreqs();
            this._popCpu.val.set_text(f
                ? ('睿频 ' + fmtFreq(f.max) + ' 均 ' + fmtFreq(f.avg))
                : '睿频 -.-G 均 -.-G');

            const m = readMem();
            this._popMem.val.set_text(m
                ? (fmtKB(m.used) + '/' + fmtKB(m.total) + ' ' + m.pct + '%  Swap ' +
                   fmtKB(m.swapUsed) + '/' + fmtKB(m.swapTotal))
                : '—');

            this._popNet.val.set_text(
                '↑' + fmtSpeed(this._lastUp) + '  ↓' + fmtSpeed(this._lastDn));

            this._popDisk.val.set_text(
                '读 ' + fmtSpeed(this._lastDiskR) + '  写 ' + fmtSpeed(this._lastDiskW));

            // stage 不做父布局 → 手动按自然尺寸重排，防止长行被挤压成省略号
            try {
                const nw = this._popup.get_preferred_width(-1)[1];
                this._popup.set_width(nw);
                const nh = this._popup.get_preferred_height(nw)[1];
                this._popup.set_height(nh);
            } catch (e) {}
        } catch (e) {}
    },

    _teardownPopup: function() {
        if (!this._popup) return;
        try { this._popup.destroy(); } catch (e) {}
        this._popup = null;
        this._popCpu = this._popMem = this._popNet = this._popDisk = null;
        this._popupVisible = false;
    },

    _tickOnce: function(updateFreq) {
        try {
            this._n++;
            const now = GLib.get_monotonic_time() / 1e6;
            const net = readNet();
            if (net) {
                if (this._prev) {
                    const dt = Math.max(0.001, now - this._prev.time);
                    const up = (net.tx - this._prev.tx) / dt;
                    const dn = (net.rx - this._prev.rx) / dt;
                    this._lastUp = up;
                    this._lastDn = dn;
                    this._cellUp.label.set_text(fmtSpeed(up));
                    this._cellDn.label.set_text(fmtSpeed(dn));
                }
                this._prev = { rx: net.rx, tx: net.tx, time: now };
            }

            // 磁盘读写速率
            const disk = readDisk();
            if (disk) {
                if (this._prevDisk) {
                    const dt = Math.max(0.001, now - this._prevDisk.time);
                    this._lastDiskR = (disk.read - this._prevDisk.read) / dt;
                    this._lastDiskW = (disk.write - this._prevDisk.write) / dt;
                }
                this._prevDisk = { read: disk.read, write: disk.write, time: now };
            }

            this._cellMem.label.set_text(fmtMem(readMem()));
            if (updateFreq && (this._n % CPU_FREQ_EVERY_N === 0)) {
                this._cellCpu.label.set_text(fmtFreq(readCpuMHz()));
            } else if (this._n === 1) {
                this._cellCpu.label.set_text(fmtFreq(readCpuMHz()));
            }

            // 悬浮卡可见时同步刷新 + 重新定位（内容高度可能变化）
            if (this._popupVisible) {
                this._updatePopup();
                this._positionPopup();
            }

            this._failed = 0;
        } catch (e) {
            this._failed++;
            global.logError('sysmon2x2: tick failed: ' + e);
            if (this._failed >= 3) this._heal();
        }
    },

    _heal: function() {
        try {
            global.log('sysmon2x2: rebuilding after failures');
            this._failed = 0;
            this._prev = null;
            this._teardownUI();
            this._buildUI();
            this._relayout();
            this._tickOnce(true);
        } catch (e) {
            global.logError('sysmon2x2: heal failed: ' + e);
        }
    },

    _teardownUI: function() {
        try {
            this._root.destroy_all_children();
            this._root.destroy();
        } catch (e) {}
        this._root = null;
        this._colL = null;
        this._colR = null;
        this._cellUp = null;
        this._cellDn = null;
        this._cellMem = null;
        this._cellCpu = null;
    },

    on_applet_removed_from_panel: function() {
        if (this._timer) { Mainloop.source_remove(this._timer); this._timer = null; }
        this._hidePopup();
        this._teardownPopup();
        try {
            if (this._panel && this._panelHeightSig) {
                this._panel.actor.disconnect(this._panelHeightSig);
            }
        } catch (e) {}
        this._panelHeightSig = null;
        try {
            if (this._themeSig) Main.themeManager.disconnect(this._themeSig);
        } catch (e) {}
        this._themeSig = null;
        try {
            if (this._panelSetSig) Main.settings.disconnect(this._panelSetSig);
        } catch (e) {}
        this._panelSetSig = null;
        this._teardownUI();
    },

    on_applet_clicked: function(event) {
        // 单击：立即刷新一次
        this._prev = null;
        this._tickOnce(true);
    },
};

function main(metadata, orientation, panelId, instanceId) {
    return new SysMon2x2Applet(metadata, orientation, panelId, instanceId);
}
