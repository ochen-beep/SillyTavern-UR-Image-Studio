// @ts-check
// Minimal fake DOM for UI event tests without a browser.
export function makeFakeDocument() {
    const allNodes = [];
    let createNode;
    createNode = (tagName) => {
        const node = {
            nodeType: 1,
            tagName,
            id: '',
            className: '',
            classList: {
                _set: new Set(),
                add(cls) { this._set.add(cls); node.className = Array.from(this._set).join(' '); },
                remove(cls) { this._set.delete(cls); node.className = Array.from(this._set).join(' '); },
                toggle(cls, force) { if (force === undefined ? !this._set.has(cls) : force) this.add(cls); else this.remove(cls); return this._set.has(cls); },
                contains(cls) { return this._set.has(cls); },
            },
            dataset: {},
            attributes: {},
            children: [],
            childNodes: [],
            parentNode: null,
            _textContent: '',
            get textContent() {
                if (this.children.length === 0) return this._textContent;
                return this.children.map(c => c.textContent).join('');
            },
            set textContent(v) {
                this._textContent = v == null ? '' : String(v);
                this.children.length = 0;
                this.childNodes.length = 0;
            },
            _value: '',
            get value() {
                // A real <select> derives its value from the selected <option>;
                // only an explicit assignment overrides that. Without this a
                // dropdown read back as '' unless the markup also carried a
                // redundant value="..." attribute, which no browser needs.
                if (this.tagName === 'select' && this._value === '') {
                    const options = findAll(this, n => n.tagName === 'option');
                    const chosen = options.find(o => o.selected) || options[0];
                    if (chosen) return chosen.attributes.value ?? chosen.textContent;
                }
                return this._value;
            },
            set value(v) { this._value = v == null ? '' : String(v); },
            checked: false,
            selected: false,
            hidden: false,
            disabled: false,
            _listeners: [],
            addEventListener(type, fn) { this._listeners.push({ type, fn }); },
            removeEventListener(type, fn) { this._listeners = this._listeners.filter(l => l.type !== type || l.fn !== fn); },
            dispatchEvent(ev) {
                const results = [];
                for (const l of this._listeners) if (l.type === ev.type) results.push(l.fn(ev));
                for (const c of this.children) if (isElement(c)) results.push(c.dispatchEvent(ev));
                const promises = results.filter(r => r && typeof r.then === 'function');
                return promises.length ? Promise.all(promises) : undefined;
            },
            click() {
                const ev = { type: 'click', target: this, currentTarget: this, stopPropagation: () => {}, preventDefault: () => {} };
                return this.dispatchEvent(ev);
            },
            change() {
                const ev = { type: 'change', target: this, currentTarget: this, stopPropagation: () => {}, preventDefault: () => {} };
                return this.dispatchEvent(ev);
            },
            getAttribute(name) { return this.attributes[name] ?? null; },
            setAttribute(name, val) { this.attributes[name] = String(val); if (name === 'id') this.id = String(val); if (name === 'class') this.className = String(val); if (name === 'value') this.value = String(val); if (name === 'hidden') this.hidden = true; },
            removeAttribute(name) { delete this.attributes[name]; if (name === 'id') this.id = ''; if (name === 'class') { this.className = ''; this.classList._set.clear(); } if (name === 'hidden') this.hidden = false; },
            matches(sel) {
                if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
                if (sel.startsWith('#')) return this.id === sel.slice(1);
                // Атрибутный селектор [name] / [name="value"] — данные-атрибуты
                // (data-act="view" и т.п.) в карточках и чипах.
                const attrMatch = sel.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/);
                if (attrMatch) {
                    const value = this.attributes[attrMatch[1]];
                    return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
                }
                return this.tagName === sel;
            },
            closest(sel) {
                let n = this;
                while (n) { if (n.matches(sel)) return n; n = n.parentNode; }
                return null;
            },
            querySelector(sel) {
                if (sel.startsWith('#')) {
                    return findById(this, sel.slice(1));
                }
                if (sel.startsWith('.')) {
                    const cls = sel.slice(1);
                    return findFirst(this, n => n.classList.contains(cls));
                }
                if (sel.startsWith('[')) {
                    return findFirst(this, n => n.matches(sel));
                }
                return findFirst(this, n => n.tagName === sel);
            },
            querySelectorAll(sel) {
                if (sel.startsWith('.')) {
                    const cls = sel.slice(1);
                    return findAll(this, n => n.classList.contains(cls));
                }
                if (sel.startsWith('[')) {
                    return findAll(this, n => n.matches(sel));
                }
                return findAll(this, n => n.tagName === sel);
            },
            appendChild(child) {
                child.parentNode = this;
                child.ownerDocument = this.ownerDocument;
                this.children.push(child);
                this.childNodes.push(child);
                return child;
            },
            prepend(...nodes) {
                for (const child of nodes) {
                    child.parentNode = this;
                    child.ownerDocument = this.ownerDocument;
                }
                this.children.unshift(...nodes);
                this.childNodes.unshift(...nodes);
            },
            removeChild(child) {
                this.children = this.children.filter(c => c !== child);
                this.childNodes = this.childNodes.filter(c => c !== child);
                child.parentNode = null;
                return child;
            },
            remove() { if (this.parentNode) this.parentNode.removeChild(this); },
            // Поддерево (winEl.contains(target) в Esc-гарде окна): узел сам,
            // потомок или чужой — false.
            contains(node) {
                if (!node) return false;
                for (let cursor = node; cursor; cursor = cursor.parentNode) {
                    if (cursor === this) return true;
                }
                return false;
            },
            replaceWith(other) {
                if (this.parentNode) {
                    const idx = this.parentNode.children.indexOf(this);
                    if (idx !== -1) this.parentNode.children[idx] = other;
                    const idx2 = this.parentNode.childNodes.indexOf(this);
                    if (idx2 !== -1) this.parentNode.childNodes[idx2] = other;
                    other.parentNode = this.parentNode;
                }
            },
            focus() {},
            scrollIntoView() {},
            // No mount tracking in the fake tree; nodes report attached so tab
            // render guards (tab-templates etc. bail on !host?.isConnected) proceed.
            isConnected: true,
            get innerHTML() {
                if (this.children.length === 0) return escapeHtml(this._textContent);
                return this.children.map(child => child.outerHTML).join('');
            },
            set innerHTML(html) {
                this.children.length = 0;
                this.childNodes.length = 0;
                parseHTML(html, this);
            },
            get outerHTML() {
                const attrs = Object.entries(this.attributes).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
                const selfClosing = SELF_CLOSING.has(this.tagName);
                if (selfClosing) return `<${this.tagName}${attrs}>`;
                return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
            },
        };
        node.ownerDocument = document;
        // В браузере classList всегда синхронен строке class: прямой
        // `el.className = 'a b'` обязан обновить classList — иначе оверлеи,
        // созданные через createElement + className (card-action-menu и др.),
        // невидимы для querySelector по классу (регресс 2026-10-04).
        let _className = '';
        Object.defineProperty(node, 'className', {
            get() { return _className; },
            set(v) {
                _className = String(v ?? '');
                node.classList._set.clear();
                for (const cls of _className.split(/\s+/).filter(Boolean)) node.classList._set.add(cls);
            },
        });
        allNodes.push(node);
        return node;
    }
    const document = {
        createElement(tagName) { return createNode(tagName); },
        createTextNode(text) { return { nodeType: 3, textContent: String(text), outerHTML: escapeHtml(String(text)) }; },
        // Документ-уровневые слушатели (keydown в оверлеях): только хранение,
        // диспетчеризация глобальных событий тестам не нужна.
        _docListeners: [],
        // Третий аргумент бывает boolean (bindWindowEscape: capture=true) —
        // браузерная легальная форма; нормализуем в { capture }.
        addEventListener(type, fn, options) {
            const opts = options === true ? { capture: true } : options;
            this._docListeners.push({ type, fn, capture: opts?.capture === true });
        },
        removeEventListener(type, fn, options) {
            const opts = options === true ? { capture: true } : options;
            this._docListeners = this._docListeners.filter(l => l.type !== type || l.fn !== fn || !!opts?.capture !== !!l.capture);
        },
        querySelector(sel) { return root.querySelector(sel); },
        querySelectorAll(sel) { return root.querySelectorAll(sel); },
        getElementById(id) { return root.querySelector('#' + id); },
    };
    const root = createNode('root');
    root.ownerDocument = document;
    return { document, root };
}

const SELF_CLOSING = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']);

function parseHTML(html, parent, createNode) {
    if (!createNode) createNode = (tag) => parent.ownerDocument.createElement(tag);
    let i = 0;
    while (i < html.length) {
        const openStart = html.indexOf('<', i);
        if (openStart === -1) {
            if (i < html.length) parent.appendChild({ nodeType: 3, textContent: html.slice(i), outerHTML: escapeHtml(html.slice(i)) });
            break;
        }
        if (openStart > i) {
            parent.appendChild({ nodeType: 3, textContent: html.slice(i, openStart), outerHTML: escapeHtml(html.slice(i, openStart)) });
        }
        if (html.startsWith('<!--', openStart)) {
            const end = html.indexOf('-->', openStart);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        const tagEnd = html.indexOf('>', openStart);
        if (tagEnd === -1) break;
        const tagRaw = html.slice(openStart + 1, tagEnd);
        const isClosing = tagRaw.startsWith('/');
        if (isClosing) {
            // stray closing tag
            i = tagEnd + 1;
            continue;
        }
        const selfClosing = tagRaw.endsWith('/') || SELF_CLOSING.has(parseTagName(tagRaw));
        const tagName = parseTagName(tagRaw);
        const node = createNode(tagName);
        const attrs = parseAttributes(tagRaw);
        for (const [k, v] of Object.entries(attrs)) {
            node.attributes[k] = v;
            if (k === 'id') node.id = v;
            if (k === 'class') {
                node.className = v;
                for (const cls of v.split(/\s+/).filter(Boolean)) node.classList.add(cls);
            }
            if (k === 'value') node.value = v;
            if (k === 'checked') node.checked = true;
            if (k === 'selected') node.selected = true;
            if (k.startsWith('data-')) node.dataset[k.slice(5)] = v;
            if (k === 'hidden') node.hidden = true;
            if (k === 'disabled') node.disabled = true;
            const dataMatch = k.match(/^data-(.+)$/);
            if (dataMatch) node.dataset[dataMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        }
        parent.appendChild(node);
        if (selfClosing) {
            i = tagEnd + 1;
            continue;
        }
        const closeTag = `</${tagName}>`;
        const closeIndex = findMatchingClose(html, tagEnd + 1, tagName);
        if (closeIndex === -1) {
            i = tagEnd + 1;
            continue;
        }
        const inner = html.slice(tagEnd + 1, closeIndex);
        parseHTML(inner, node, createNode);
        i = closeIndex + closeTag.length;
    }
}

function parseTagName(tagRaw) {
    return tagRaw.split(/\s+/)[0].replace(/\/$/, '');
}

function parseAttributes(tagRaw) {
    const attrs = {};
    const re = /([a-zA-Z0-9-:]+)(?:="([^"]*)"|=([^\s]*))?(?=\s|$)/g;
    let m;
    let first = true;
    while ((m = re.exec(tagRaw)) !== null) {
        if (first) { first = false; continue; }
        const key = m[1];
        const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
        attrs[key] = val;
    }
    return attrs;
}

function findMatchingClose(html, start, tagName) {
    const openRe = new RegExp(`<${tagName}\\b`, 'gi');
    const closeRe = new RegExp(`</${tagName}>`, 'gi');
    let depth = 1;
    let pos = start;
    while (pos < html.length) {
        const slice = html.slice(pos);
        openRe.lastIndex = 0;
        closeRe.lastIndex = 0;
        const nextOpen = openRe.exec(slice);
        const nextClose = closeRe.exec(slice);
        const openPos = nextOpen ? pos + nextOpen.index : Infinity;
        const closePos = nextClose ? pos + nextClose.index : Infinity;
        if (closePos === Infinity && openPos === Infinity) return -1;
        if (openPos < closePos) {
            depth++;
            pos = openPos + nextOpen[0].length;
        } else {
            depth--;
            if (depth === 0) return pos + nextClose.index;
            pos = closePos + nextClose[0].length;
        }
    }
    return -1;
}

function isElement(n) { return n && n.nodeType === 1; }

function findById(node, id) {
    for (const c of node.children) {
        if (!isElement(c)) continue;
        if (c.id === id) return c;
        const found = findById(c, id);
        if (found) return found;
    }
    return null;
}

function findFirst(node, predicate) {
    for (const c of node.children) {
        if (!isElement(c)) continue;
        if (predicate(c)) return c;
        const found = findFirst(c, predicate);
        if (found) return found;
    }
    return null;
}

function findAll(node, predicate) {
    const out = [];
    for (const c of node.children) {
        if (!isElement(c)) continue;
        if (predicate(c)) out.push(c);
        out.push(...findAll(c, predicate));
    }
    return out;
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
