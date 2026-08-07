'use strict';

/*
 * Floating Headings — a Google Docs style scroll handle for Obsidian.
 *
 * Drag the round handle on the right edge to scroll. While you drag, every
 * heading in the note floats over the right side of the page at the vertical
 * position it occupies in the document. Let go and the headings linger for a
 * moment so you can tap one and jump straight to it.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, MarkdownView, Platform } = obsidian;

const DEFAULT_SETTINGS = {
	enableOnDesktop: true,
	autoHideMs: 1400,
	lingerMs: 2500,
	maxLevel: 6,
	minLabelGap: 26,
	alwaysShowHandle: false,
};

/* Below this much scrollable distance the note is short enough that a handle
 * would just be in the way. */
const MIN_SCROLLABLE_PX = 120;
const MAX_HEADINGS = 600;
const MAX_LABELS = 60;
const SVG_NS = 'http://www.w3.org/2000/svg';

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

/* Heading text comes from the metadata cache as raw markdown. Strip the noise
 * so the labels read like a table of contents. */
function cleanHeading(raw) {
	return String(raw == null ? '' : raw)
		.replace(/!?\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1')
		.replace(/!?\[\[([^\]]+)\]\]/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/(\*\*|__|==|~~|\*|_|`)/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function chevronSvg() {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '20');
	svg.setAttribute('height', '20');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', 'M8.5 10.5 12 7l3.5 3.5M8.5 13.5 12 17l3.5-3.5');
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.8');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	return svg;
}

/* Piecewise-linear lookup over a sorted list of [line, y] anchors. */
function interpolate(anchors, line) {
	const n = anchors.length;
	if (!n) return null;
	if (line <= anchors[0][0]) return anchors[0][1];
	if (line >= anchors[n - 1][0]) return anchors[n - 1][1];
	let lo = 0;
	let hi = n - 1;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (anchors[mid][0] <= line) lo = mid;
		else hi = mid;
	}
	const [l0, y0] = anchors[lo];
	const [l1, y1] = anchors[hi];
	if (l1 === l0) return y0;
	return y0 + ((y1 - y0) * (line - l0)) / (l1 - l0);
}

class HeadingRail {
	constructor(plugin, view) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.view = view;

		this.scroller = null;
		this.items = [];
		this.labels = [];
		this.activeLabel = null;
		this.thumbSize = 40;
		this.thumbPos = 0;

		this.dragging = false;
		this.pointerId = null;
		this.dragStartY = 0;
		this.dragStartThumb = 0;
		this.pendingY = 0;

		this.visible = false;
		this.labelsOn = false;
		this.hideTimer = 0;
		this.lingerTimer = 0;
		this.dragRaf = 0;
		this.scrollRaf = 0;

		this.onScroll = this.onScroll.bind(this);
		this.onPointerDown = this.onPointerDown.bind(this);
		this.onPointerMove = this.onPointerMove.bind(this);
		this.onPointerUp = this.onPointerUp.bind(this);
		this.onTouchMove = this.onTouchMove.bind(this);
		this.onLabelClick = this.onLabelClick.bind(this);

		this.buildDom();
	}

	get settings() {
		return this.plugin.settings;
	}

	buildDom() {
		const rail = document.createElement('div');
		rail.className = 'fh-rail';

		const labels = document.createElement('div');
		labels.className = 'fh-labels';

		const thumb = document.createElement('div');
		thumb.className = 'fh-thumb';
		thumb.setAttribute('role', 'button');
		thumb.setAttribute('aria-label', 'Drag to scroll and show headings');
		thumb.appendChild(chevronSvg());

		rail.appendChild(labels);
		rail.appendChild(thumb);

		this.railEl = rail;
		this.labelsEl = labels;
		this.thumbEl = thumb;

		thumb.addEventListener('pointerdown', this.onPointerDown);
		thumb.addEventListener('touchmove', this.onTouchMove, { passive: false });
		labels.addEventListener('click', this.onLabelClick);

		const host = this.view.contentEl;
		host.classList.add('fh-host');
		host.appendChild(rail);
	}

	destroy() {
		window.clearTimeout(this.hideTimer);
		window.clearTimeout(this.lingerTimer);
		if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
		if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
		this.detachDragListeners();
		if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll);
		this.scroller = null;
		this.thumbEl.removeEventListener('pointerdown', this.onPointerDown);
		this.thumbEl.removeEventListener('touchmove', this.onTouchMove);
		this.labelsEl.removeEventListener('click', this.onLabelClick);
		const host = this.railEl.parentElement;
		this.railEl.remove();
		if (host && !host.querySelector('.fh-rail')) host.classList.remove('fh-host');
	}

	/* ---------------------------------------------------------------- scroller */

	findScroller() {
		const root = this.view.contentEl;
		if (!root) return null;
		if (this.view.getMode() === 'preview') {
			return (
				root.querySelector('.markdown-reading-view .markdown-preview-view') ||
				root.querySelector('.markdown-preview-view')
			);
		}
		return (
			root.querySelector('.markdown-source-view .cm-scroller') ||
			root.querySelector('.cm-scroller')
		);
	}

	/* The scroller element is swapped out when the view changes mode, so
	 * re-resolve it rather than caching it once. */
	ensureScroller() {
		const found = this.findScroller();
		if (found !== this.scroller) {
			if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll);
			this.scroller = found;
			if (found) found.addEventListener('scroll', this.onScroll, { passive: true });
		}
		return this.scroller;
	}

	maxScroll() {
		const sc = this.scroller;
		if (!sc) return 0;
		return Math.max(0, sc.scrollHeight - sc.clientHeight);
	}

	scrollable() {
		return this.maxScroll() >= MIN_SCROLLABLE_PX;
	}

	/* ------------------------------------------------------------- measurement */

	collectHeadings() {
		const file = this.view.file;
		if (!file) return [];
		const cache = this.app.metadataCache.getFileCache(file);
		const headings = (cache && cache.headings) || [];
		const max = this.settings.maxLevel;
		const out = [];
		for (const h of headings) {
			if (!h || !h.position || h.level > max) continue;
			out.push({
				line: h.position.start.line,
				level: h.level,
				text: cleanHeading(h.heading) || '(untitled)',
			});
			if (out.length >= MAX_HEADINGS) break;
		}
		return out;
	}

	/* Source / Live Preview: CodeMirror keeps a height map for the whole
	 * document (estimated for lines it hasn't rendered yet), so every heading
	 * has a position even far off screen. */
	measureSource(items, sc) {
		try {
			const editor = this.view.editor;
			const cm = editor && editor.cm;
			if (!cm || !cm.state || typeof cm.lineBlockAt !== 'function') return null;
			const doc = cm.state.doc;
			const railTop = sc.getBoundingClientRect().top;
			const docTop =
				typeof cm.documentTop === 'number'
					? cm.documentTop
					: cm.contentDOM.getBoundingClientRect().top;
			const base = sc.scrollTop + docTop - railTop;
			return items.map((it) => {
				const lineNo = clamp(it.line + 1, 1, doc.lines);
				return base + cm.lineBlockAt(doc.line(lineNo).from).top;
			});
		} catch (e) {
			return null;
		}
	}

	/* Reading mode: the renderer splits the note into sections that carry their
	 * start line, so measuring the ones present in the DOM gives us anchors to
	 * interpolate between. */
	measurePreview(items, sc) {
		try {
			const renderer = this.view.previewMode && this.view.previewMode.renderer;
			const sections = renderer && renderer.sections;
			if (!Array.isArray(sections) || !sections.length) return null;

			const scTop = sc.getBoundingClientRect().top;
			const scrollTop = sc.scrollTop;
			const anchors = [];
			for (const s of sections) {
				if (!s || typeof s.lineStart !== 'number') continue;
				const el = s.el;
				if (!el || !el.isConnected) continue;
				const rect = el.getBoundingClientRect();
				if (!rect.height && !rect.width) continue;
				anchors.push([s.lineStart, rect.top - scTop + scrollTop]);
			}
			if (!anchors.length) return null;

			anchors.sort((a, b) => a[0] - b[0]);
			/* Keep it monotonic — interpolation assumes it. */
			for (let i = 1; i < anchors.length; i++) {
				if (anchors[i][1] < anchors[i - 1][1]) anchors[i][1] = anchors[i - 1][1];
			}
			if (anchors[0][0] > 0) anchors.unshift([0, 0]);
			const last = anchors[anchors.length - 1];
			const endLine = Math.max(last[0] + 1, this.lineCount());
			if (endLine > last[0]) anchors.push([endLine, Math.max(last[1], sc.scrollHeight)]);

			return items.map((it) => interpolate(anchors, it.line));
		} catch (e) {
			return null;
		}
	}

	lineCount() {
		try {
			const editor = this.view.editor;
			if (editor && typeof editor.lineCount === 'function') return editor.lineCount();
		} catch (e) {
			/* ignore */
		}
		return 0;
	}

	/* Last resort: spread headings by line number over the content height. */
	measureByLine(items, sc) {
		const total = Math.max(this.lineCount(), items.length ? items[items.length - 1].line + 1 : 1);
		const height = sc.scrollHeight;
		return items.map((it) => (it.line / total) * height);
	}

	measure() {
		const sc = this.ensureScroller();
		this.items = [];
		if (!sc) return;

		const items = this.collectHeadings();
		if (!items.length) return;

		const mode = this.view.getMode();
		let ys = mode === 'preview' ? this.measurePreview(items, sc) : this.measureSource(items, sc);
		if (!ys) ys = this.measureByLine(items, sc);

		const max = Math.max(1, this.maxScroll());
		for (let i = 0; i < items.length; i++) {
			const y = clamp(Number(ys[i]) || 0, 0, max);
			items[i].y = y;
			items[i].frac = y / max;
		}
		items.sort((a, b) => a.y - b.y || a.line - b.line);
		this.items = items;
	}

	/* ----------------------------------------------------------------- labels */

	renderLabels() {
		this.labelsEl.textContent = '';
		this.labels = [];
		this.activeLabel = null;

		const height = this.railEl.clientHeight;
		if (!height || !this.items.length) return;

		this.thumbSize = this.thumbEl.offsetHeight || this.thumbSize;
		/* Label centres share the thumb's travel range, so a label sits exactly
		 * where the thumb will be when that heading reaches the top. */
		const padding = this.thumbSize / 2;
		const usable = Math.max(1, height - this.thumbSize);
		for (const it of this.items) it.top = padding + it.frac * usable;

		/* When headings crowd together, keep the most important ones: shallower
		 * levels win, then document order. */
		const gap = this.settings.minLabelGap;
		const order = this.items.map((it, i) => ({ it, i }));
		order.sort((a, b) => a.it.level - b.it.level || a.i - b.i);

		const kept = [];
		for (const candidate of order) {
			let collides = false;
			for (const k of kept) {
				if (Math.abs(k.it.top - candidate.it.top) < gap) {
					collides = true;
					break;
				}
			}
			if (!collides) kept.push(candidate);
			if (kept.length >= MAX_LABELS) break;
		}
		kept.sort((a, b) => a.i - b.i);

		const frag = document.createDocumentFragment();
		for (const { it, i } of kept) {
			const el = document.createElement('div');
			el.className = 'fh-label';
			el.dataset.level = String(it.level);
			el.dataset.line = String(it.line);
			el.style.top = it.top + 'px';
			el.textContent = it.text;
			el.title = it.text;
			frag.appendChild(el);
			this.labels.push({ el, index: i });
		}
		this.labelsEl.appendChild(frag);
		this.updateActive();
	}

	updateActive() {
		const sc = this.scroller;
		if (!sc || !this.labels.length) return;
		const at = sc.scrollTop + 2;

		let index = -1;
		for (let i = 0; i < this.items.length; i++) {
			if (this.items[i].y <= at) index = i;
			else break;
		}

		let target = null;
		for (const label of this.labels) {
			if (label.index <= index) target = label;
			else break;
		}
		if (target === this.activeLabel) return;
		if (this.activeLabel) this.activeLabel.el.classList.remove('is-active');
		this.activeLabel = target;
		if (target) target.el.classList.add('is-active');
	}

	/* ------------------------------------------------------------- visibility */

	syncThumb() {
		const sc = this.scroller;
		if (!sc) return;
		this.thumbSize = this.thumbEl.offsetHeight || this.thumbSize;
		const max = Math.max(1, this.maxScroll());
		const track = Math.max(1, this.railEl.clientHeight - this.thumbSize);
		this.thumbPos = clamp(sc.scrollTop / max, 0, 1) * track;
		this.thumbEl.style.transform = 'translateY(' + this.thumbPos + 'px)';
	}

	show() {
		if (!this.ensureScroller() || !this.scrollable()) return;
		window.clearTimeout(this.hideTimer);
		if (!this.visible) {
			this.visible = true;
			this.railEl.classList.add('is-visible');
		}
		this.syncThumb();
		this.scheduleHide();
	}

	scheduleHide() {
		window.clearTimeout(this.hideTimer);
		if (this.dragging || this.labelsOn || this.settings.alwaysShowHandle) return;
		this.hideTimer = window.setTimeout(() => this.hide(), this.settings.autoHideMs);
	}

	hide() {
		if (this.dragging || this.labelsOn) return;
		this.visible = false;
		this.railEl.classList.remove('is-visible');
	}

	showLabels() {
		window.clearTimeout(this.lingerTimer);
		this.labelsOn = true;
		this.railEl.classList.add('is-labels');
	}

	lingerLabels() {
		window.clearTimeout(this.lingerTimer);
		this.lingerTimer = window.setTimeout(() => this.hideLabels(), this.settings.lingerMs);
	}

	hideLabels() {
		window.clearTimeout(this.lingerTimer);
		this.labelsOn = false;
		this.railEl.classList.remove('is-labels');
		this.scheduleHide();
	}

	/* Used by the command and by settings changes. */
	reveal() {
		if (!this.ensureScroller() || !this.scrollable()) return;
		this.measure();
		this.show();
		if (this.items.length) {
			this.renderLabels();
			this.showLabels();
			this.lingerLabels();
		}
	}

	refresh() {
		/* Switching between editing and reading can rebuild the view content,
		 * so make sure the rail is still in the tree. */
		const host = this.view.contentEl;
		if (host && this.railEl.parentElement !== host) {
			host.classList.add('fh-host');
			host.appendChild(this.railEl);
		}
		this.ensureScroller();
		if (this.settings.alwaysShowHandle) this.show();
		else this.syncThumb();
		if (this.labelsOn) {
			this.measure();
			this.renderLabels();
		}
	}

	onResize() {
		this.syncThumb();
		if (this.labelsOn) this.renderLabels();
	}

	/* ------------------------------------------------------------------ events */

	onScroll() {
		if (this.dragging) return;
		if (this.scrollRaf) return;
		this.scrollRaf = requestAnimationFrame(() => {
			this.scrollRaf = 0;
			this.show();
			if (this.labelsOn) this.updateActive();
		});
	}

	onTouchMove(e) {
		/* Stop Obsidian's edge-swipe from stealing the gesture mid-drag. */
		if (this.dragging) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	onPointerDown(e) {
		if (e.button != null && e.button > 0) return;
		const sc = this.ensureScroller();
		if (!sc) return;
		e.preventDefault();
		e.stopPropagation();

		this.dragging = true;
		this.pointerId = e.pointerId;
		this.dragStartY = e.clientY;
		try {
			this.thumbEl.setPointerCapture(e.pointerId);
		} catch (err) {
			/* ignore — we fall back to document-level listeners below */
		}

		window.clearTimeout(this.hideTimer);
		this.syncThumb();
		this.dragStartThumb = this.thumbPos;
		this.railEl.classList.add('is-dragging');
		this.show();

		this.measure();
		this.renderLabels();
		if (this.items.length) this.showLabels();

		this.attachDragListeners();
	}

	/* Pointer capture normally retargets everything to the handle, but it can
	 * fail; the document listeners keep the drag alive either way. */
	attachDragListeners() {
		this.thumbEl.addEventListener('pointermove', this.onPointerMove);
		this.thumbEl.addEventListener('pointerup', this.onPointerUp);
		this.thumbEl.addEventListener('pointercancel', this.onPointerUp);
		document.addEventListener('pointermove', this.onPointerMove);
		document.addEventListener('pointerup', this.onPointerUp);
		document.addEventListener('pointercancel', this.onPointerUp);
	}

	detachDragListeners() {
		this.thumbEl.removeEventListener('pointermove', this.onPointerMove);
		this.thumbEl.removeEventListener('pointerup', this.onPointerUp);
		this.thumbEl.removeEventListener('pointercancel', this.onPointerUp);
		document.removeEventListener('pointermove', this.onPointerMove);
		document.removeEventListener('pointerup', this.onPointerUp);
		document.removeEventListener('pointercancel', this.onPointerUp);
	}

	onPointerMove(e) {
		if (!this.dragging || e.pointerId !== this.pointerId) return;
		e.preventDefault();
		this.pendingY = e.clientY;
		if (this.dragRaf) return;
		this.dragRaf = requestAnimationFrame(() => {
			this.dragRaf = 0;
			this.applyDrag();
		});
	}

	applyDrag() {
		const sc = this.scroller;
		if (!sc || !this.dragging) return;
		const track = Math.max(1, this.railEl.clientHeight - this.thumbSize);
		const pos = clamp(this.dragStartThumb + (this.pendingY - this.dragStartY), 0, track);
		this.thumbPos = pos;
		this.thumbEl.style.transform = 'translateY(' + pos + 'px)';
		sc.scrollTop = (pos / track) * this.maxScroll();
		this.updateActive();
	}

	onPointerUp(e) {
		if (!this.dragging) return;
		if (e && e.pointerId != null && e.pointerId !== this.pointerId) return;
		this.dragging = false;
		this.pointerId = null;
		try {
			if (e && e.pointerId != null) this.thumbEl.releasePointerCapture(e.pointerId);
		} catch (err) {
			/* ignore */
		}
		this.detachDragListeners();
		this.railEl.classList.remove('is-dragging');
		if (this.labelsOn) this.lingerLabels();
		this.scheduleHide();
	}

	onLabelClick(e) {
		const el = e.target && e.target.closest ? e.target.closest('.fh-label') : null;
		if (!el) return;
		e.preventDefault();
		e.stopPropagation();
		const line = Number(el.dataset.line);
		if (!Number.isFinite(line)) return;
		this.jumpTo(line);
	}

	jumpTo(line) {
		let jumped = false;
		try {
			const mode = this.view.currentMode;
			if (mode && typeof mode.applyScroll === 'function') {
				mode.applyScroll(line);
				jumped = true;
			}
		} catch (err) {
			jumped = false;
		}
		if (!jumped && this.scroller) {
			const item = this.items.find((it) => it.line === line);
			if (item) this.scroller.scrollTop = item.y;
		}
		this.hideLabels();
		this.show();
	}
}

class FloatingHeadingsPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.rails = new Map();

		this.addSettingTab(new FloatingHeadingsSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => this.sync());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.sync()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.sync()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.sync()));
		this.registerEvent(
			this.app.workspace.on('resize', () => {
				for (const rail of this.rails.values()) rail.onResize();
			})
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				for (const rail of this.rails.values()) {
					if (rail.view.file === file && rail.labelsOn) {
						rail.measure();
						rail.renderLabels();
					}
				}
			})
		);

		this.addCommand({
			id: 'show-heading-rail',
			name: 'Show floating headings',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (!checking) {
					if (!this.rails.has(view)) this.sync();
					const rail = this.rails.get(view);
					if (rail) rail.reveal();
				}
				return true;
			},
		});
	}

	onunload() {
		this.clearRails();
	}

	enabledHere() {
		return Platform.isMobile || this.settings.enableOnDesktop;
	}

	sync() {
		if (!this.enabledHere()) {
			this.clearRails();
			return;
		}
		const live = new Set();
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.contentEl) continue;
			live.add(view);
			let rail = this.rails.get(view);
			if (!rail) {
				rail = new HeadingRail(this, view);
				this.rails.set(view, rail);
			}
			rail.refresh();
		}
		for (const [view, rail] of this.rails) {
			if (!live.has(view)) {
				rail.destroy();
				this.rails.delete(view);
			}
		}
	}

	clearRails() {
		for (const rail of this.rails.values()) rail.destroy();
		this.rails.clear();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (!this.enabledHere()) {
			this.clearRails();
			return;
		}
		this.sync();
		for (const rail of this.rails.values()) {
			if (!this.settings.alwaysShowHandle) rail.scheduleHide();
		}
	}
}

class FloatingHeadingsSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName('Enable on desktop')
			.setDesc('The handle is designed for touch, but it works with a mouse too.')
			.addToggle((t) =>
				t.setValue(s.enableOnDesktop).onChange(async (v) => {
					s.enableOnDesktop = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Always show the handle')
			.setDesc('Keep the handle on screen instead of fading it out when you stop scrolling.')
			.addToggle((t) =>
				t.setValue(s.alwaysShowHandle).onChange(async (v) => {
					s.alwaysShowHandle = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Hide the handle after')
			.setDesc('How long the handle stays visible once scrolling stops.')
			.addSlider((sl) =>
				sl
					.setLimits(400, 5000, 100)
					.setValue(s.autoHideMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.autoHideMs = v;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset')
					.onClick(async () => {
						s.autoHideMs = DEFAULT_SETTINGS.autoHideMs;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('Keep headings after releasing')
			.setDesc('How long the headings stay tappable once you let go of the handle.')
			.addSlider((sl) =>
				sl
					.setLimits(500, 8000, 100)
					.setValue(s.lingerMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.lingerMs = v;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Reset')
					.onClick(async () => {
						s.lingerMs = DEFAULT_SETTINGS.lingerMs;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('Deepest heading level')
			.setDesc('Headings below this level are never shown.')
			.addDropdown((d) => {
				for (let i = 1; i <= 6; i++) d.addOption(String(i), 'H' + i);
				d.setValue(String(s.maxLevel)).onChange(async (v) => {
					s.maxLevel = Number(v);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Minimum spacing between headings')
			.setDesc(
				'Pixels of breathing room between labels. When headings would overlap, the shallower levels win.'
			)
			.addSlider((sl) =>
				sl
					.setLimits(16, 64, 2)
					.setValue(s.minLabelGap)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.minLabelGap = v;
						await this.plugin.saveSettings();
					})
			);
	}
}

module.exports = FloatingHeadingsPlugin;
