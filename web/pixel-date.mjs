import {currentMarketDate} from './dates.mjs';

const firstDate = '0001-01-01';
const lastDate = '9999-12-31';
const dayMs = 86400000;
const asDate = value => new Date(value + 'T00:00:00Z');
const asKey = date => date.toISOString().slice(0, 10);
const monthKey = (year, month) => String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0');
const clamp = (value, min, max) => value < min ? min : value > max ? max : value;

let popup;
let activeInput;
let activeButton;
let shownMonth;

function limits() {
  return [activeInput.min || firstDate, activeInput.max || lastDate];
}

function allowed(value) {
  const [min, max] = limits();
  return !activeInput.disabled && value >= min && value <= max;
}

function position() {
  if (!activeInput?.isConnected || activeInput.disabled) {
    close();
    return;
  }
  const anchor = activeInput.getBoundingClientRect();
  if (anchor.bottom <= 0 || anchor.top >= window.innerHeight) {
    close();
    return;
  }
  const margin = 10;
  const gap = 6;
  const below = window.innerHeight - anchor.bottom - margin;
  const above = anchor.top - margin;
  const opensUp = below < popup.scrollHeight + (popup.offsetHeight - popup.clientHeight) + gap && above > below;
  popup.style.maxHeight = Math.max(0, (opensUp ? above : below) - gap) + 'px';
  popup.style.left = clamp(anchor.left, margin, Math.max(margin, window.innerWidth - popup.offsetWidth - margin)) + 'px';
  popup.style.top = (opensUp ? anchor.top - gap - popup.offsetHeight : anchor.bottom + gap) + 'px';
}

function close(restoreFocus = false) {
  if (!activeInput) return;
  const button = activeButton;
  popup.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  activeInput = activeButton = null;
  if (restoreFocus && button.isConnected) button.focus();
}

function pick(value) {
  if (!allowed(value)) return;
  const input = activeInput;
  close(true);
  if (input.value === value) return;
  input.value = value;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
}

function moveMonth(amount) {
  const [year, month] = shownMonth.split('-').map(Number);
  const next = month + amount;
  if (next === 0) return monthKey(year - 1, 12);
  if (next === 13) return monthKey(year + 1, 1);
  return monthKey(year, next);
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([key, label]) => new Option(label, key)));
  select.value = value;
}

function render(focusDate) {
  const english = document.documentElement.lang === 'en';
  const locale = english ? 'en' : 'zh-CN';
  const today = currentMarketDate();
  const [min, max] = limits();
  const firstMonth = min.slice(0, 7);
  const lastMonth = max.slice(0, 7);
  const [year, month] = shownMonth.split('-').map(Number);
  const first = asDate(shownMonth + '-01');
  const {previous, next, years, months, heading, weekdays, days, todayButton} = popup.parts;

  popup.setAttribute('aria-label', english ? 'Choose a date' : '选择日期');
  previous.setAttribute('aria-label', english ? 'Previous month' : '上个月');
  next.setAttribute('aria-label', english ? 'Next month' : '下个月');
  years.setAttribute('aria-label', english ? 'Year' : '年份');
  months.setAttribute('aria-label', english ? 'Month' : '月份');
  previous.disabled = shownMonth <= firstMonth || min > max;
  next.disabled = shownMonth >= lastMonth || min > max;
  const startYear = Math.min(year, Math.max(Number(min.slice(0, 4)), year - 100));
  const endYear = Math.max(year, Math.min(Number(max.slice(0, 4)), year + 100));
  fillSelect(years, Array.from({length: endYear - startYear + 1}, (_, i) => {
    const optionYear = startYear + i;
    return [optionYear, english ? String(optionYear) : optionYear + ' 年'];
  }), year);
  const monthName = new Intl.DateTimeFormat(locale, {month: 'short', timeZone: 'UTC'});
  fillSelect(months, Array.from({length: 12}, (_, i) => {
    const key = monthKey(year, i + 1);
    return [i + 1, monthName.format(asDate(key + '-01'))];
  }).filter(([number]) => {
    const key = monthKey(year, number);
    return number === month || (key >= firstMonth && key <= lastMonth);
  }), month);
  years.disabled = years.options.length < 2;
  months.disabled = months.options.length < 2;
  heading.textContent = new Intl.DateTimeFormat(locale, {year: 'numeric', month: 'long', timeZone: 'UTC'}).format(first);
  weekdays.replaceChildren(...(english ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : ['一', '二', '三', '四', '五', '六', '日']).map(label => {
    const cell = document.createElement('span');
    cell.textContent = label;
    return cell;
  }));

  const offset = (first.getUTCDay() + 6) % 7;
  const buttons = [];
  const fullDate = new Intl.DateTimeFormat(locale, {dateStyle: 'full', timeZone: 'UTC'});
  for (let i = 0; i < 42; i++) {
    const date = new Date(+first + (i - offset) * dayMs);
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.textContent = date.getUTCDate();
    const inside = date.getUTCMonth() + 1 === month;
    button.classList.toggle('outside-month', !inside);
    const key = inside ? asKey(date) : '';
    button.dataset.day = key;
    button.disabled = !inside || !allowed(key);
    if (inside) {
      button.setAttribute('aria-label', fullDate.format(date));
      button.setAttribute('aria-pressed', String(key === activeInput.value));
      if (key === today) button.setAttribute('aria-current', 'date');
    }
    buttons.push(button);
  }
  days.replaceChildren(...buttons);
  const enabled = buttons.filter(button => !button.disabled);
  const target = enabled.find(button => button.dataset.day === (focusDate || activeInput.value)) || enabled[0];
  if (target) target.tabIndex = 0;
  todayButton.textContent = english ? 'Today' : '今天';
  todayButton.disabled = !allowed(today);
  position();
  if (focusDate && activeInput) (target || popup).focus();
}

function open(input, button) {
  if (activeInput === input) return close(true);
  close();
  activeInput = input;
  activeButton = button;
  const [min, max] = limits();
  const date = clamp(input.value || currentMarketDate(), min, max);
  shownMonth = date.slice(0, 7);
  popup.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  render(date);
}

function makePopup() {
  const panel = document.createElement('div');
  panel.id = 'pixel-calendar';
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('data-i18n-skip', '');
  panel.innerHTML = `
    <div class="calendar-navigation">
      <button type="button" data-calendar="previous">‹</button>
      <select data-calendar="years"></select>
      <select data-calendar="months"></select>
      <button type="button" data-calendar="next">›</button>
    </div>
    <div class="calendar-weekdays" data-calendar="weekdays" aria-hidden="true"></div>
    <div class="calendar-days" data-calendar="days" role="group" aria-labelledby="pixel-calendar-heading"></div>
    <span id="pixel-calendar-heading" data-calendar="heading" class="calendar-heading" aria-live="polite"></span>
    <div class="calendar-footer"><button type="button" data-calendar="todayButton"></button></div>`;
  panel.parts = Object.fromEntries([...panel.querySelectorAll('[data-calendar]')].map(node => [node.dataset.calendar, node]));
  const {previous, next, years, months, days, todayButton} = panel.parts;
  previous.addEventListener('click', () => { shownMonth = moveMonth(-1); render(); if (previous.disabled) (days.querySelector('[tabindex="0"]') || panel).focus(); });
  next.addEventListener('click', () => { shownMonth = moveMonth(1); render(); if (next.disabled) (days.querySelector('[tabindex="0"]') || panel).focus(); });
  const jump = () => {
    const [min, max] = limits();
    shownMonth = clamp(monthKey(Number(years.value), Number(months.value)), min.slice(0, 7), max.slice(0, 7));
    render();
  };
  years.addEventListener('change', jump);
  months.addEventListener('change', jump);
  days.addEventListener('click', event => { if (event.target.dataset.day) pick(event.target.dataset.day); });
  days.addEventListener('keydown', event => {
    const key = event.target.dataset.day;
    const step = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[event.key];
    if (!key || !step) return;
    event.preventDefault();
    const date = new Date(+asDate(key) + step * dayMs);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    const value = asKey(date);
    if (!allowed(value)) return;
    shownMonth = value.slice(0, 7);
    render(value);
  });
  todayButton.addEventListener('click', () => pick(currentMarketDate()));
  document.addEventListener('pointerdown', event => {
    if (activeInput && !panel.contains(event.target) && !activeButton.parentElement?.contains(event.target)) close();
  });
  document.addEventListener('focusin', event => {
    if (activeInput && !panel.contains(event.target) && !activeButton.parentElement?.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (activeInput && event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  });
  window.addEventListener('resize', () => { if (activeInput) position(); });
  window.addEventListener('scroll', event => {
    if (activeInput && (!(event.target instanceof Node) || !panel.contains(event.target))) position();
  }, true);
  window.addEventListener('shiri:language', () => {
    for (const button of document.querySelectorAll('.pixel-date-trigger')) labelTrigger(button);
    if (activeInput) render(document.activeElement.dataset.day);
  });
  document.body.append(panel);
  return panel;
}

function labelTrigger(button) {
  button.setAttribute('aria-label', document.documentElement.lang === 'en' ? 'Open calendar' : '打开日历');
}

export function enhanceDateInput(input) {
  popup ||= makePopup();
  const wrapper = document.createElement('div');
  wrapper.className = 'pixel-date-field';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pixel-date-trigger';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', popup.id);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('data-i18n-skip', '');
  labelTrigger(button);
  input.before(wrapper);
  wrapper.append(input, button);
  button.disabled = input.disabled;
  button.addEventListener('click', () => open(input, button));
  input.addEventListener('keydown', event => {
    if (event.altKey && event.key === 'ArrowDown' && !input.disabled) {
      event.preventDefault();
      open(input, button);
    }
  });
  new MutationObserver(records => {
    button.disabled = input.disabled;
    if (activeInput !== input) return;
    if (input.disabled) close();
    else if (records.some(record => record.oldValue !== input.getAttribute(record.attributeName))) {
      const [min, max] = limits();
      shownMonth = clamp(shownMonth, min.slice(0, 7), max.slice(0, 7));
      render(document.activeElement.dataset.day);
    }
  }).observe(input, {attributes: true, attributeOldValue: true, attributeFilter: ['disabled', 'min', 'max']});
}
