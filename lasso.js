// Lasso content script — injected into the active tab when Select mode is armed.
// Handles hover highlight, ArrowUp parent-jump, and click-to-capture.
// Calls window.__lassoCleanup() if re-injected.

(function () {
  if (typeof window.__lassoCleanup === 'function') {
    window.__lassoCleanup();
  }

  let current = null;

  function highlight(el) {
    if (current && current !== el) {
      current.style.outline = current.__lassoOldOutline ?? '';
      delete current.__lassoOldOutline;
    }
    if (el && el !== document.body && el !== document.documentElement) {
      if (current !== el) {
        el.__lassoOldOutline = el.style.outline;
      }
      el.style.outline = '2px dashed #2563eb';
      current = el;
    }
  }

  function clearHighlight() {
    if (current) {
      current.style.outline = current.__lassoOldOutline ?? '';
      delete current.__lassoOldOutline;
      current = null;
    }
  }

  function onMouseOver(e) {
    highlight(e.target);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowUp' && current && current.parentElement) {
      e.preventDefault();
      highlight(current.parentElement);
    }
  }

  function onClick(e) {
    if (!current) return;
    e.preventDefault();
    e.stopPropagation();
    const html = current.outerHTML;
    window.__lassoCleanup();

    // Convert and copy while the page is still focused
    try {
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
      td.remove(['script', 'style', 'noscript']);
      const markdown = td.turndown(html);
      navigator.clipboard.writeText(markdown).then(() => {
        chrome.runtime.sendMessage({ type: 'LASSO_CAPTURED', charCount: markdown.length });
      }).catch(err => {
        chrome.runtime.sendMessage({ type: 'LASSO_ERROR', message: err.message });
      });
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'LASSO_ERROR', message: err.message });
    }
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick, true);

  window.__lassoCleanup = function () {
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onClick, true);
    clearHighlight();
    delete window.__lassoCleanup;
  };
})();
