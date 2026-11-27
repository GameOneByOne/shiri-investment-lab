import {t} from './i18n.mjs?v=chart-currency-v1';

let trigger, activeSelect, popup, search, list, empty;
let matches = [], cursor = -1;

function close(restoreFocus = false) {
  if (!activeSelect) return;
  const previous = trigger;
  popup.hidden = true;
  previous.setAttribute('aria-expanded', 'false');
  trigger = activeSelect = null;
  if (restoreFocus && previous.isConnected && !previous.disabled) previous.focus();
}

function position() {
  if (!trigger?.isConnected || trigger.disabled) return close();
  const rect = trigger.getBoundingClientRect();
  if (!rect.width || rect.bottom <= 0 || rect.top >= innerHeight) return close();
  const margin = 8;
  const width = Math.min(Math.max(260, rect.width), innerWidth - margin * 2);
  const viewportBottom = Math.min(innerHeight, (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? innerHeight));
  const below = viewportBottom - rect.bottom - margin;
  const above = rect.top - (window.visualViewport?.offsetTop ?? 0) - margin;
  const flip = below < 280 && above > below;
  popup.style.width = width + 'px';
  popup.style.maxHeight = Math.max(100, Math.min(360, flip ? above : below)) + 'px';
  popup.style.left = Math.max(margin, Math.min(rect.left, innerWidth - width - margin)) + 'px';
  popup.style.top = (flip ? rect.top - 4 - popup.offsetHeight : rect.bottom + 4) + 'px';
}

function activate(index, scroll = false) {
  list.children[cursor]?.classList.remove('stock-search-active');
  cursor = index;
  const item = list.children[cursor];
  if (!item) return search.removeAttribute('aria-activedescendant');
  item.classList.add('stock-search-active');
  search.setAttribute('aria-activedescendant', item.id);
  if (scroll) item.scrollIntoView({block:'nearest'});
}

function filterStocks(options, query) {
  const needle = query.trim().normalize('NFKC').toLowerCase();
  return options.filter(option => option.value && (
    option.text.normalize('NFKC').toLowerCase().includes(needle) ||
    option.value.toLowerCase().includes(needle)
  ));
}

function render(keepSelection = false) {
  matches = filterStocks(Array.from(activeSelect.options), search.value);
  const fragment = document.createDocumentFragment();
  for (const [index, option] of matches.entries()) {
    const row = document.createElement('div');
    row.id = 'stock-search-option-' + index;
    row.dataset.index = index;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(option.selected));
    row.textContent = option.text;
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  list.scrollTop = 0;
  empty.hidden = matches.length > 0;
  cursor = -1;
  const selected = keepSelection ? matches.findIndex(option => option.selected) : -1;
  activate(selected < 0 && matches.length ? 0 : selected, selected >= 0);
  position();
}

function choose(index) {
  const picked = matches[index];
  if (!picked || !activeSelect || activeSelect.disabled) return;
  const select = activeSelect;
  close(true);
  select.value = picked.value;
  select.dispatchEvent(new Event('change', {bubbles:true}));
}

function updateLanguage() {
  const english = document.documentElement.lang === 'en';
  search.placeholder = english ? 'Search name or code' : '搜索名称或代码';
  search.setAttribute('aria-label', search.placeholder);
  list.setAttribute('aria-label', english ? 'Matching securities' : '匹配的股票');
  empty.textContent = english ? 'No matching securities' : '没有匹配的股票 / ETF';
}

function createPopup() {
  popup = document.createElement('div');
  popup.id = 'stock-search-popup';
  popup.hidden = true;
  popup.setAttribute('data-i18n-skip', '');
  popup.innerHTML = '<input type="search" role="combobox" aria-autocomplete="list" aria-controls="stock-search-results" aria-expanded="true" autocomplete="off" spellcheck="false"><div id="stock-search-results" role="listbox"></div><p class="stock-search-empty" role="status" hidden></p>';
  [search,list,empty] = popup.children;
  document.body.append(popup);
  updateLanguage();
  window.addEventListener('shiri:language', updateLanguage);
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(cursor);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) activate(Math.max(0, Math.min(matches.length - 1, cursor + (event.key === 'ArrowDown' ? 1 : -1))), true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(true);
    }
  });
  list.addEventListener('click', event => {
    const item = event.target.closest('[data-index]');
    if (item) choose(Number(item.dataset.index));
  });
  document.addEventListener('pointerdown', event => {
    if (activeSelect && event.target !== trigger && !popup.contains(event.target)) close();
  });
  window.addEventListener('resize', () => { if (activeSelect) position(); });
  window.visualViewport?.addEventListener('resize', () => { if (activeSelect) position(); });
  window.addEventListener('scroll', event => {
    if (activeSelect && !(event.target instanceof Node && popup.contains(event.target))) position();
  }, true);
}

export function enhanceStockSelect(select) {
  if (!popup) createPopup();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'stock-search-trigger';
  button.setAttribute('aria-controls', popup.id);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('data-i18n-skip', '');
  select.hidden = true;
  select.after(button);

  function sync() {
    button.disabled = select.disabled;
    const option = select.selectedOptions[0];
    const label = option?.value ? option.text : t(option?.text || '请选择股票 / ETF');
    button.textContent = label;
    button.title = label;
    button.setAttribute('aria-label', t(select.getAttribute('aria-label')) + '：' + label);
    if (select.disabled && select === activeSelect) close();
  }
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, {attributes:true, childList:true, subtree:true, characterData:true});
  button.addEventListener('click', () => {
    if (activeSelect === select) return close(true);
    close();
    trigger = button;
    activeSelect = select;
    search.value = '';
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    render(true);
    search.focus({preventScroll:true});
  });
  sync();
}
