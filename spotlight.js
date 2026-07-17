if (window.__spotlightOpen) {
  if (typeof window.__spotlightCleanup === 'function') window.__spotlightCleanup();
} else {
  initSpotlight();
}

function initSpotlight() {
  window.__spotlightOpen = true;

  const style = document.createElement('style');
  style.id = 'spotlight-styles';
  style.textContent = `
    #spotlight-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    #spotlight-modal {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      width: 90%;
      max-width: 580px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #spotlight-input-wrapper {
      padding: 14px 16px;
      border-bottom: 1px solid #e5e7eb;
    }
    #spotlight-input {
      width: 100%;
      padding: 10px 12px;
      font-size: 15px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      outline: none;
      box-sizing: border-box;
      font-family: inherit;
      color: #111827;
    }
    #spotlight-input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    #spotlight-results {
      flex: 1;
      overflow-y: auto;
      list-style: none;
      margin: 0;
      padding: 6px 0;
    }
    #spotlight-results.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 36px 16px;
      color: #9ca3af;
      font-size: 13px;
    }
    .spotlight-result-item {
      padding: 10px 16px;
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    .spotlight-result-item.highlighted {
      background: #f3f4f6;
      border-left-color: #3b82f6;
    }
    .spotlight-result-title {
      font-weight: 500;
      font-size: 13px;
      color: #111827;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }
    .spotlight-result-url {
      font-size: 11px;
      color: #6b7280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #spotlight-footer {
      padding: 7px 16px;
      border-top: 1px solid #e5e7eb;
      font-size: 11px;
      color: #9ca3af;
      flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'spotlight-overlay';

  const modal = document.createElement('div');
  modal.id = 'spotlight-modal';

  const inputWrapper = document.createElement('div');
  inputWrapper.id = 'spotlight-input-wrapper';

  const input = document.createElement('input');
  input.id = 'spotlight-input';
  input.type = 'text';
  input.placeholder = 'Search bookmarks…';
  input.autocomplete = 'off';

  const results = document.createElement('ul');
  results.id = 'spotlight-results';
  results.className = 'empty';
  results.innerHTML = '<div>Type to search…</div>';

  const footer = document.createElement('div');
  footer.id = 'spotlight-footer';
  footer.textContent = '↑↓ navigate  ·  ↵ open  ·  esc close';

  inputWrapper.appendChild(input);
  modal.appendChild(inputWrapper);
  modal.appendChild(results);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let currentResults = [];
  let selectedIndex = -1;
  let searchTimeout;

  function performSearch(query) {
    clearTimeout(searchTimeout);
    if (!query.trim()) {
      currentResults = [];
      selectedIndex = -1;
      results.className = 'empty';
      results.innerHTML = '<div>Type to search…</div>';
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const found = await chrome.runtime.sendMessage({ type: 'BOOKMARK_SEARCH', query });
        currentResults = found;
        selectedIndex = -1;
        renderResults();
      } catch (e) {
        results.className = 'empty';
        results.innerHTML = '<div>Error searching bookmarks</div>';
      }
    }, 200);
  }

  function renderResults() {
    results.innerHTML = '';
    if (currentResults.length === 0) {
      results.className = 'empty';
      results.innerHTML = '<div>No bookmarks found</div>';
      return;
    }
    results.className = '';
    currentResults.forEach((bookmark, index) => {
      const item = document.createElement('li');
      item.className = 'spotlight-result-item' + (index === selectedIndex ? ' highlighted' : '');

      const title = document.createElement('div');
      title.className = 'spotlight-result-title';
      title.textContent = bookmark.title || bookmark.url;

      const url = document.createElement('div');
      url.className = 'spotlight-result-url';
      url.textContent = bookmark.url;

      item.appendChild(title);
      item.appendChild(url);

      item.addEventListener('mouseenter', () => {
        selectedIndex = index;
        updateHighlight();
      });
      item.addEventListener('click', () => openBookmark(bookmark.id));

      results.appendChild(item);
    });
  }

  function updateHighlight() {
    results.querySelectorAll('.spotlight-result-item').forEach((item, i) => {
      if (i === selectedIndex) {
        item.classList.add('highlighted');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('highlighted');
      }
    });
  }

  function openBookmark(bookmarkId) {
    chrome.runtime.sendMessage({ type: 'BOOKMARK_OPEN', bookmarkId });
    closeSpotlight();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSpotlight();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedIndex < currentResults.length - 1) { selectedIndex++; updateHighlight(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) { selectedIndex--; updateHighlight(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < currentResults.length) {
        openBookmark(currentResults[selectedIndex].id);
      }
    }
  }

  input.addEventListener('input', (e) => performSearch(e.target.value));
  document.addEventListener('keydown', handleKeydown, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSpotlight(); });

  input.focus();

  function closeSpotlight() {
    window.__spotlightOpen = false;
    overlay.remove();
    document.getElementById('spotlight-styles')?.remove();
    document.removeEventListener('keydown', handleKeydown, true);
  }

  window.__spotlightCleanup = closeSpotlight;
}
