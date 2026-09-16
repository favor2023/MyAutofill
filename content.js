(function () {
  'use strict';

  // 调试开关：改成 true 后打开 F12 控制台就能看到运行日志，方便排查
  const DEBUG = false;
  function log() {
    if (DEBUG && window.console) console.log('[记忆填充]', ...arguments);
  }

  // 允许记忆的输入框类型
  const TEXT_TYPES = ['text', 'search', 'password', 'number', 'email', 'tel', 'url', ''];

  // 当前聚焦的输入框
  let activeInput = null;
  // 下拉提示框
  let dropdown = null;
  // 延迟保存的定时器
  let blurTimer = null;
  // 延迟显示下拉的定时器
  let showTimer = null;
  // 滚动重定位的节流标记
  let rafPending = false;

  // ---------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------

  // storage 的安全封装。扩展被重新加载后 chrome.storage 可能不可用，
  // 这里统一兜底，避免整个脚本因为一次报错而失效。
  function storageGet(key, cb) {
    try {
      if (!window.chrome || !chrome.storage || !chrome.storage.local) return cb({});
      chrome.storage.local.get([key], function (res) {
        // 读取 lastError 以抑制"扩展上下文失效"的报错
        if (chrome.runtime && chrome.runtime.lastError) return cb({});
        cb(res || {});
      });
    } catch (e) {
      log('读取本地存储失败', e);
      cb({});
    }
  }

  function storageSet(obj) {
    try {
      if (!window.chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set(obj, function () {
        if (chrome.runtime && chrome.runtime.lastError) return;
        log('已保存', JSON.stringify(obj));
      });
    } catch (e) {
      log('写入本地存储失败', e);
    }
  }

  // 从事件中取出真正的输入框。Shadow DOM 内部的事件冒泡到 document 时，
  // e.target 会被重定向成宿主元素，必须用 composedPath() 才能拿到真实元素。
  function realTarget(e) {
    if (typeof e.composedPath === 'function') {
      const path = e.composedPath();
      if (path && path.length) return path[0];
    }
    return e.target;
  }

  // 判断是否为我们关心的可填写字段，是则返回该元素
  function asField(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return el;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return TEXT_TYPES.indexOf(t) !== -1 ? el : null;
    }
    if (el.isContentEditable) return el;
    return null;
  }

  // 读取字段当前的值
  function readValue(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.value || '').trim();
    }
    return (el.innerText || el.textContent || '').trim();
  }

  // 写入字段的值。React / Vue 的受控组件会监听原生 value 的 setter，
  // 直接 el.value = x 会被框架忽略，必须走原型上的原生 setter。
  function writeValue(el, text) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, text);
      } else {
        el.value = text;
      }
    } else {
      el.textContent = text;
    }
    // 触发事件，让网页自己的 JS 能感知到值变了（Vue/React 靠这个）
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  // ---------------------------------------------------------------
  // 标识与定位
  // ---------------------------------------------------------------

  // 为元素的某个祖先链生成结构路径，用于没有 name/id 的输入框
  function structuralPath(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.prototype.filter.call(
        parent.children,
        function (c) { return c.tagName === node.tagName; }
      );
      const idx = siblings.indexOf(node);
      parts.unshift(node.tagName.toLowerCase() + '[' + (idx < 0 ? 0 : idx) + ']');
      if (node.tagName === 'FORM') break;
      node = parent;
      depth++;
    }
    return parts.join('>') || 'root';
  }

  // 字段签名：优先用稳定属性，最后退回到结构路径。
  // className 故意不参与，因为框架生成的类名经常变。
  function fieldSignature(el) {
    if (el.name) return 'name=' + el.name;
    if (el.id) return 'id=' + el.id;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return 'aria=' + aria;
    if (el.placeholder) return 'ph=' + el.placeholder;
    if (el.attributes) {
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if (a.name.indexOf('data-') === 0 && a.value && a.value.length < 40 &&
            /name|field|key|id|code/i.test(a.name)) {
          return 'data:' + a.name + '=' + a.value;
        }
      }
    }
    return 'path=' + structuralPath(el);
  }

  function getInputKey(el) {
    return 'autofill_' + location.hostname + location.pathname + '|' + fieldSignature(el);
  }

  // ---------------------------------------------------------------
  // 下拉框
  // ---------------------------------------------------------------

  function createDropdown() {
    const el = document.createElement('div');
    el.id = 'my-autofill-dropdown';
    // 用 fixed 定位，避免被页面上带 transform / overflow 的父容器裁掉或带偏
    el.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'background: #fff',
      'border: 1px solid #d0d0d0',
      'border-radius: 4px',
      'box-shadow: 0 3px 10px rgba(0,0,0,0.18)',
      'z-index: 2147483647',
      'max-height: 200px',
      'overflow-y: auto',
      'display: none',
      'font-family: system-ui, -apple-system, "Segoe UI", sans-serif',
      'font-size: 14px',
      'line-height: 1.4',
      'color: #222',
      'text-align: left',
      'padding: 4px 0',
      'min-width: 160px',
      'max-width: 420px',
      'box-sizing: border-box',
      'user-select: none',
      'cursor: pointer'
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function ensureDropdown() {
    // 页面（尤其 SPA）可能把我们的节点清掉，这里做自愈
    if (!dropdown || !dropdown.isConnected) {
      dropdown = createDropdown();
    }
    return dropdown;
  }

  function makeItem(text, input) {
    const item = document.createElement('div');
    item.textContent = text;
    item.setAttribute('title', text);
    item.style.cssText = [
      'padding: 6px 12px',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'background: transparent'
    ].join(';');

    item.addEventListener('mouseenter', function () {
      item.style.background = '#eef3ff';
    });
    item.addEventListener('mouseleave', function () {
      item.style.background = 'transparent';
    });
    // 用 mousedown 而不是 click：preventDefault 可以阻止输入框失焦，
    // 否则输入框一失焦下拉框就消失了，点击永远落空。
    item.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      commit(input, text);
    });

    return item;
  }

  // 把候选值填入输入框
  function commit(input, text) {
    clearTimeout(blurTimer);
    writeValue(input, text);
    hideDropdown();
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    log('填入', text, '->', getInputKey(input));
  }

  function showDropdown(input) {
    if (!input || !input.isConnected) return;
    const key = getInputKey(input);
    storageGet(key, function (res) {
      const history = res[key] || [];
      log('查询', key, '命中', history.length, '条');
      if (!history.length) return;               // 没有历史就不弹
      if (activeInput !== input) return;         // 期间焦点已转移，放弃

      const el = ensureDropdown();
      el.innerHTML = '';
      history.forEach(function (text) {
        el.appendChild(makeItem(text, input));
      });

      placeDropdown(input);
    });
  }

  // 定位下拉框，空间不够时自动翻到输入框上方
  function placeDropdown(input) {
    const el = ensureDropdown();
    const r = input.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 输入框滚出视口就不要再显示了
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
      hideDropdown();
      return;
    }

    el.style.display = 'block';
    el.style.minWidth = Math.max(r.width, 160) + 'px';

    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = r.bottom + 4;
    if (top + h > vh - 4 && r.top - 4 - h > 0) {
      top = r.top - 4 - h;                       // 下方放不下就放上方
    }
    const left = Math.min(Math.max(r.left, 4), Math.max(4, vw - w - 4));

    el.style.top = top + 'px';
    el.style.left = left + 'px';
  }

  function hideDropdown() {
    if (dropdown && dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------
  // 保存
  // ---------------------------------------------------------------

  function saveInputValue(input) {
    const value = readValue(input);
    if (!value) return;                          // 空值 / 纯空格不保存

    const key = getInputKey(input);
    storageGet(key, function (res) {
      let history = res[key] || [];
      // 去重：已存在就删掉旧的那条
      history = history.filter(function (item) { return item !== value; });
      history.unshift(value);                    // 最新的放最前
      if (history.length > 5) history = history.slice(0, 5);
      storageSet({ [key]: history });
    });
  }

  // ---------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------

  // 聚焦到输入框 -> 延迟弹出（延迟是为了不和浏览器原生自动填充抢）
  document.addEventListener('focusin', function (e) {
    const field = asField(realTarget(e));
    if (!field) {
      activeInput = null;
      hideDropdown();
      return;
    }
    activeInput = field;
    clearTimeout(showTimer);
    showTimer = setTimeout(function () {
      if (activeInput === field) showDropdown(field);
    }, 150);
  }, true);

  // 点击输入框。若输入框已经是聚焦状态，focusin 不会再触发，
  // 这里补一刀，保证"再点一次"也能弹出候选。
  document.addEventListener('click', function (e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    const t = path[0];
    if (dropdown && dropdown.contains(t)) return;   // 点的是下拉框自己
    const field = asField(t);
    if (field) {
      activeInput = field;
      clearTimeout(showTimer);
      showTimer = setTimeout(function () {
        if (activeInput === field) showDropdown(field);
      }, 60);
      return;
    }
    hideDropdown();                                  // 点页面其它地方就收起
  }, true);

  // 失焦 -> 延迟保存并收起（延迟是因为点下拉框也会触发失焦）
  document.addEventListener('focusout', function (e) {
    const field = asField(realTarget(e));
    if (!field) return;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(function () {
      saveInputValue(field);
      if (activeInput === field) {
        activeInput = null;
        hideDropdown();
      }
    }, 200);
  }, true);

  // 滚动 / 窗口变化时重新定位（而不是直接关掉，避免滑动就消失）
  function reposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (activeInput && dropdown && dropdown.style.display === 'block') {
        placeDropdown(activeInput);
      }
    });
  }
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition, true);

  // Esc 关掉下拉
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideDropdown();
  }, true);

  log('已注入', location.href);
})();
