const API_URL = 'https://functions.yandexcloud.net/d4e0s6c0a0a800fl5cdt';

const TOKEN_KEY = 'alfa_token';
// Обращение к localStorage может выбросить исключение — приватный режим,
// отключённое хранилище. Без обёртки это уронило бы всю страницу, хотя
// сетка никакого хранилища не требует.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* переживём */ } },
};

const state = { id: null, t: null };

function el(tag, cls) { const d = document.createElement(tag); if (cls) d.className = cls; return d; }
function txt(tag, cls, text) { const d = el(tag, cls); d.textContent = text; return d; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1];
}

function datesText(t) {
  return t.dateFrom === t.dateTo ? longDate(t.dateFrom) : longDate(t.dateFrom) + ' — ' + longDate(t.dateTo);
}

const STATUS = {
  signup: ['wait', 'идёт запись'],
  groups: ['ok', 'групповой этап'],
  playoff: ['ok', 'плей-офф'],
  finished: ['grey', 'завершён'],
};

const SCORING = { set1: 'один сет', set2: 'два сета', proset8: 'про-сет до 8' };

async function api(action, payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action }, payload)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'request-failed');
    err.code = body.error || 'request-failed';
    throw err;
  }
  return body;
}

// ---------- Отрисовка ----------

function participant(t, id) {
  return (t.participants || []).find(p => p.id === id) || null;
}
function nameOf(t, id) {
  const p = participant(t, id);
  return p ? p.name : '—';
}

function render() {
  const view = document.getElementById('view');
  view.innerHTML = '';
  const t = state.t;

  document.getElementById('heroTitle').textContent = t.title;
  document.title = t.title + ' — теннисный центр «Альфа»';

  const head = el('div', 'card');
  const st = STATUS[t.status] || ['grey', t.status];
  head.innerHTML = '<h2>' + escapeHtml(t.title)
    + ' <span class="pill ' + st[0] + '">' + escapeHtml(st[1]) + '</span></h2>'
    + '<div class="meta">' + escapeHtml(datesText(t))
    + ' · ' + escapeHtml(t.level)
    + ' · матч: ' + escapeHtml(SCORING[t.scoring.mode] || '')
    + (t.fee ? ' · взнос ' + t.fee + ' ₽' : '')
    + ' · участников: ' + t.taken + '</div>'
    + (t.note ? '<div class="meta">' + escapeHtml(t.note) + '</div>' : '')
    + '<div class="print-head">Теннисный центр «Альфа», Краснодар</div>';

  const acts = el('div', 'acts noprint');
  // Сетку открывают отдельной вкладкой и из панели, и с сайта, поэтому
  // возврат нужен явный: «назад» в истории тут может вести в пустоту.
  acts.appendChild(button('← Назад', 'btn sec', () => {
    if (history.length > 1) history.back(); else location.href = 'index.html';
  }));
  // Разложенное руками по итогам жеребьёвки в клубе церемонией не
  // показываем: мячи изображали бы жребий сервера, которого не было.
  if (t.drawnAt && !t.drawManual) {
    acts.appendChild(button('Показать жеребьёвку', 'btn sec', () => playCeremony(false)));
  }
  acts.appendChild(button('На печать', 'btn sec', () => window.print()));
  head.appendChild(acts);
  if (t.drawnAt && t.drawManual) {
    head.appendChild(txt('div', 'meta', 'Группы составлены жеребьёвкой в клубе.'));
  }
  view.appendChild(head);

  // Итоги турнира — первым делом после шапки: за ними и приходят, когда
  // всё сыграно.
  if (t.podium && t.podium.length) {
    const board = el('div', 'card');
    board.innerHTML = '<h2>Итоги</h2>';
    const medals = ['🥇', '🥈', '🥉'];
    t.podium.forEach(row => {
      const line = el('div', 'match');
      line.innerHTML = '<div class="who"><span class="medal">' + medals[row.place - 1] + '</span> '
        + '<b>' + escapeHtml(row.name || nameOf(t, row.participantId)) + '</b></div>'
        + '<div class="score">' + row.place + ' место</div>';
      board.appendChild(line);
    });
    view.appendChild(board);
  }

  if (!t.drawnAt) {
    const wait = el('div', 'card');
    wait.innerHTML = '<h2>Состав <span class="tag">' + t.taken + ' из ' + t.maxParticipants + '</span></h2>';
    if (!t.participants.length) {
      wait.appendChild(txt('div', 'empty', 'Пока никто не записан.'));
    }
    t.participants.forEach(p => {
      const row = el('div', 'match');
      row.innerHTML = '<div class="who"><b>' + p.number + '.</b> ' + escapeHtml(p.name)
        + (p.seeded ? ' <span class="pill ok">сеяный</span>' : '')
        + (p.mine ? ' <span class="pill me">это вы</span>' : '') + '</div>';
      wait.appendChild(row);
    });
    wait.appendChild(txt('div', 'empty',
      'Жеребьёвки ещё не было — группы появятся здесь сразу после неё. '
      + 'Номер слева — ваш номер на мяче: по нему и следите за жеребьёвкой.'));
    view.appendChild(wait);
    return;
  }

  (t.groups || []).forEach(g => renderGroup(view, t, g));
  // «АЛЬФА» и «БЕТА» — те же названия, что в объявлениях турнира: люди
  // ищут на странице именно их, а не «плей-офф с утешительной».
  renderBracket(view, t, t.main, 'АЛЬФА');
  renderThird(view, t, t.third, 'Матч за третье место АЛЬФА');
  renderBracket(view, t, t.consolation, 'БЕТА');
  renderThird(view, t, t.consThird, 'Матч за третье место БЕТА');
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Группа — крестовина: строки и столбцы это одни и те же игроки, в
// клетке счёт их встречи. Так таблицу групп рисуют везде, к ней все
// привыкли, и она заметно компактнее списка пар: у кругового на
// шестнадцать человек список — это сто двадцать строк, а крестовина
// помещается на один экран.
//
// Столбцы подписаны номерами участников — теми же, что были на мячах.
function renderGroup(view, t, g) {
  const card = el('div', 'card');
  const left = g.matches.filter(m => !m.winner).length;
  card.innerHTML = '<h2>Группа ' + escapeHtml(g.key)
    + ' <span class="tag">' + (left ? 'не сыграно ' + left + ' из ' + g.matches.length
      : 'все матчи сыграны') + '</span></h2>';

  const advance = t.format.groupCount > 0 ? t.format.advance : 0;
  const members = g.table.map(row => participant(t, row.participantId)).filter(Boolean);
  const annulled = new Set(g.table.filter(r => r.annulled).map(r => r.participantId));

  const scroll = el('div', 'scroll');
  const table = document.createElement('table');
  table.className = 'cross';

  let head = '<thead><tr><th class="pl">#</th><th class="who">Игрок</th>';
  members.forEach(p => { head += '<th class="sc">' + p.number + '</th>'; });
  head += '<th class="agg">Очки</th><th class="agg">Сеты</th><th class="agg">Геймы</th>'
    + '<th class="pl">Место</th></tr></thead>';
  table.innerHTML = head;

  const tbody = document.createElement('tbody');
  g.table.forEach(row => {
    const p = participant(t, row.participantId);
    const tr = document.createElement('tr');
    const cls = [];
    if (row.status === 'withdrawn') cls.push('off');
    else if (advance && row.place <= advance) cls.push('up');
    if (p && p.mine) cls.push('mine');
    tr.className = cls.join(' ');

    let html = '<td class="pl">' + (row.place || '—') + '</td>'
      + '<td class="who"><span class="no">' + (p ? p.number : '') + '</span> '
      + escapeHtml(row.name)
      + (row.annulled ? ' <span class="sub">результаты аннулированы</span>' : '') + '</td>';
    members.forEach(op => {
      if (!p || op.id === p.id) { html += '<td class="sc self"></td>'; return; }
      // Матчи аннулированного в таблицу не идут — и в клетке их нет: рядом
      // с теми, что считаются, счёт читался бы как ещё один результат.
      const off = annulled.has(p.id) || annulled.has(op.id);
      html += '<td class="sc">' + (off ? '<span class="pend">—</span>' : crossCell(t, g, p.id, op.id)) + '</td>';
    });
    html += '<td class="pts"><b>' + row.points + '</b></td>'
      + '<td class="agg">' + row.setsWon + ':' + row.setsLost + ' ' + diffTag(row.setDiff) + '</td>'
      + '<td class="agg">' + row.gamesWon + ':' + row.gamesLost + ' ' + diffTag(row.gameDiff) + '</td>'
      + '<td class="pl">' + (row.place || '—') + '</td>';
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);
  card.appendChild(scroll);

  const notes = [];
  if (advance) {
    notes.push(advance === 1 ? 'В плей-офф выходит победитель группы.'
      : 'В плей-офф выходят первые ' + advance + '.');
  }
  notes.push('Места при равенстве очков: разница сетов, потом геймы, потом личная встреча.');
  // Иначе пустые клетки у половины группы выглядят как несыгранные матчи.
  if (annulled.size) {
    notes.push('Снявшийся не доиграл группу, и его матчи в таблицу не идут — '
      + 'иначе результат от него достался бы только части соперников.');
  }
  card.appendChild(txt('div', 'empty', notes.join(' ')));

  view.appendChild(card);
}

// Разница со знаком: именно по ней решается место при равных очках,
// поэтому она подписана отдельно и цветом — плюс зелёный, минус красный.
function diffTag(d) {
  const v = Number(d) || 0;
  if (!v) return '<span class="diff zero">0</span>';
  return '<span class="diff ' + (v > 0 ? 'plus' : 'minus') + '">'
    + (v > 0 ? '+' : '−') + Math.abs(v) + '</span>';
}

// Клетка крестовины: счёт глазами того, чья это строка.
function crossCell(t, g, meId, rivalId) {
  const m = g.matches.find(x => (x.a === meId && x.b === rivalId) || (x.a === rivalId && x.b === meId));
  if (!m || !m.winner) return '<span class="pend">—</span>';
  const iAmA = m.a === meId;
  const won = (m.winner === 'a') === iAmA;
  if (m.walkover) return '<span class="' + (won ? 'w' : 'l') + '">' + (won ? '+' : '−') + '</span>';
  const sets = (m.sets || []).map(s => (iAmA ? s[0] + ':' + s[1] : s[1] + ':' + s[0])).join(' ');
  return '<span class="' + (won ? 'w' : 'l') + '">' + escapeHtml(sets) + '</span>';
}

// Матч за третье место — отдельной карточкой: он никуда не ведёт и в
// колонки сетки не встраивается.
function renderThird(view, t, m, title) {
  if (!m) return;
  const card = el('div', 'card');
  card.innerHTML = '<h2>' + escapeHtml(title) + '</h2>';
  if (!m.a && !m.b) {
    card.appendChild(txt('div', 'empty', 'Играют проигравшие в полуфиналах.'));
  } else {
    card.appendChild(bracketSlot(t, m));
  }
  view.appendChild(card);
}

function renderBracket(view, t, bracket, title) {
  if (!bracket) return;
  const card = el('div', 'card');
  card.innerHTML = '<h2>' + escapeHtml(title) + '</h2>';

  const box = el('div', 'bracket');
  bracket.rounds.forEach(r => {
    const col = el('div', 'col');
    col.innerHTML = '<h3>' + escapeHtml(r.label) + '</h3>';
    r.matches.forEach(m => col.appendChild(bracketSlot(t, m)));
    box.appendChild(col);
  });
  card.appendChild(box);
  view.appendChild(card);
}

function bracketSlot(t, m) {
  const slot = el('div', 'slot');
  [['a', m.a], ['b', m.b]].forEach(([side, id]) => {
    const line = el('div', 'side' + (m.winner === side ? ' win' : '') + (id ? '' : ' empty'));
    const p = id ? participant(t, id) : null;
    const label = el('span');
    label.textContent = p ? p.name : 'ждём соперника';
    line.appendChild(label);
    const sc = el('span', 'score');
    if (m.winner) {
      sc.textContent = m.walkover
        ? (m.winner === side ? 'проход' : '')
        : (m.sets || []).map(s => s[side === 'a' ? 0 : 1]).join(' ');
    }
    line.appendChild(sc);
    slot.appendChild(line);
  });
  return slot;
}

// ============================================================
// Церемония жеребьёвки
// ============================================================
//
// Случайность здесь не рождается — она уже произошла на сервере и
// сохранена вместе с зерном. Страница только проигрывает готовый
// порядок: иначе «показать заново» выдавало бы каждый раз новую
// раскладку, и вся затея потеряла бы смысл.
//
// Синхронного показа у всех сразу нет: у функции один запрос на
// экземпляр и нет ни вебсокетов, ни опроса по таймеру. Поэтому
// церемония играет сама один раз у того, кто ещё не видел эту
// жеребьёвку, а остальным остаётся кнопка «Показать жеребьёвку» —
// её и нажимают на клубном экране.

const SEEN_PREFIX = 'alfa_draw_seen_';
const SOUND_KEY = 'alfa_draw_sound';

let ceremony = { running: false, skip: false };

function seenKey(t) { return SEEN_PREFIX + t.id + '_' + t.drawSeed; }

function soundOn() { return store.get(SOUND_KEY) === '1'; }

// Щелчок мяча синтезом, без звукового файла: ничего не догружается к
// началу церемонии, а короткий удар звучит одинаково у всех.
let audio = null;
function knock() {
  if (!soundOn()) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.09);
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(now); osc.stop(now + 0.13);
  } catch (e) { /* звук — украшение, без него всё работает */ }
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Куда какие ячейки: в турнире с группами — по группам, в сетке
// навылет — по местам в первом круге.
function ceremonyPots(t) {
  if (t.format.groupCount > 0) {
    const keys = [];
    (t.drawOrder || []).forEach(o => { if (keys.indexOf(o.group) < 0) keys.push(o.group); });
    keys.sort();
    return keys.map(key => ({
      key,
      title: 'Группа ' + key,
      slots: (t.drawOrder || []).filter(o => o.group === key).length,
    }));
  }
  return [{ key: null, title: 'Сетка', slots: (t.drawOrder || []).length }];
}

function buildStage(t) {
  document.getElementById('stageTitle').textContent = 'Жеребьёвка';
  document.getElementById('stageSub').textContent = t.title + ' · ' + datesText(t);
  document.getElementById('seedLine').textContent = 'зерно жеребьёвки: ' + (t.drawSeed || '');

  const pots = document.getElementById('pots');
  pots.innerHTML = '';
  const cells = new Map();
  ceremonyPots(t).forEach(pot => {
    const box = el('div', 'pot');
    box.innerHTML = '<h3>' + escapeHtml(pot.title) + '</h3>';
    for (let i = 0; i < pot.slots; i++) {
      const cell = el('div', 'cell');
      cell.appendChild(el('div', 'ball'));
      cell.appendChild(txt('span', '', '…'));
      box.appendChild(cell);
      cells.set((pot.key || '') + ':' + i, cell);
    }
    pots.appendChild(box);
  });

  // В барабан кладём всех записавшихся по номерам — это список
  // участников, а не очередь на вытягивание. Порядок, в котором их
  // разыграли, здесь не читается вовсе.
  //
  // Номер на мяче остаётся видным и после того, как имена погаснут:
  // следить за своим номером проще, чем выхватывать фамилию из
  // мелькающих, а кто под номером — на экране уже не написано.
  const drum = document.getElementById('drum');
  drum.classList.remove('blind');
  drum.innerHTML = '';
  const balls = new Map();
  (t.participants || [])
    .slice()
    .sort((a, b) => a.number - b.number)
    .forEach(p => {
      const chip = el('div', 'chip');
      const ball = el('div', 'ball');
      ball.appendChild(txt('span', 'num', String(p.number)));
      chip.appendChild(ball);
      chip.appendChild(txt('span', 'nm', p.name));
      drum.appendChild(chip);
      balls.set(p.id, chip);
    });

  return { cells, balls, drum };
}

function stageButtons(t, phase) {
  const acts = document.getElementById('stageActs');
  acts.innerHTML = '';
  if (phase === 'running') {
    acts.appendChild(button('Пропустить', 'btn sec', () => { ceremony.skip = true; }));
  } else {
    acts.appendChild(button('Показать заново', 'btn sec', () => playCeremony(false)));
    acts.appendChild(button('К сетке', 'btn', closeStage));
  }
  acts.appendChild(button(soundOn() ? 'Звук: включён' : 'Звук: выключен', 'btn sec', (e) => {
    store.set(SOUND_KEY, soundOn() ? '0' : '1');
    e.target.textContent = soundOn() ? 'Звук: включён' : 'Звук: выключен';
    if (soundOn()) knock();
  }));
}

function closeStage() {
  ceremony.skip = true;
  document.getElementById('stage').classList.remove('on');
  document.getElementById('stage').setAttribute('aria-hidden', 'true');
}

// Полёт мяча из барабана в ячейку. На мяче номер — по нему и следят за
// собой, — а имя появляется при посадке.
//
// Перебора имён в полёте нет намеренно: номер уже виден, то есть кого
// вытянули, известно с первой секунды. Мелькающие рядом с этим номером
// чужие фамилии — враньё, которое ничего не добавляет.
async function flyBall(t, from, to, finalName, number) {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();

  const flier = el('div', 'flier');
  const ball = el('div', 'ball');
  // Номер виден с первой секунды, имя — нет. Свой номер каждый знает, и
  // вопрос «мой или не мой» решается раньше, чем проявится фамилия.
  if (number) ball.appendChild(txt('span', 'num', String(number)));
  flier.appendChild(ball);
  const label = txt('span', '', '');
  flier.appendChild(label);
  flier.style.left = a.left + 'px';
  flier.style.top = a.top + 'px';
  document.body.appendChild(flier);

  const dx = b.left - a.left + 6;
  const dy = b.top - a.top + 3;
  const fast = ceremony.skip || reducedMotion();
  const duration = fast ? 0 : 820;

  if (!fast) {
    flier.style.transition = 'transform ' + duration + 'ms cubic-bezier(.22,.7,.3,1)';
    // Кадр, чтобы браузер зафиксировал начальное положение до перехода.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    flier.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
    await wait(duration - 140);
    label.textContent = finalName;
    await wait(140);
  }

  flier.remove();
}

async function playCeremony(auto) {
  const t = state.t;
  if (!t || !t.drawOrder || !t.drawOrder.length || ceremony.running) return;

  ceremony.running = true;
  ceremony.skip = false;
  const stage = document.getElementById('stage');
  stage.classList.add('on');
  stage.setAttribute('aria-hidden', 'false');
  stageButtons(t, 'running');

  const { cells, balls, drum } = buildStage(t);
  const slotIndex = new Map();
  const stageSub = document.getElementById('stageSub');
  const subText = stageSub.textContent;

  // Имена для перебора в полёте — только те, кого ещё не вытянули.

  // Сначала все записавшиеся видны списком, потом ссыпаются в барабан:
  // имена гаснут, остаются одинаковые мячи. Дальше по фамилиям в
  // барабане ничего не прочитать — этого и не хватало.
  if (!ceremony.skip) {
    stageSub.textContent = subText + ' · участников: ' + balls.size;
    await wait(reducedMotion() ? 700 : 1400);
    drum.classList.add('blind');
    if (!reducedMotion()) {
      drum.classList.add('rolling');
      await wait(900);
      drum.classList.remove('rolling');
    } else {
      await wait(400);
    }
    stageSub.textContent = subText;
  } else {
    drum.classList.add('blind');
  }

  try {
    for (const item of t.drawOrder) {
      const who = participant(t, item.participantId);
      const name = nameOf(t, item.participantId);
      const key = item.group || '';
      const idx = slotIndex.get(key) || 0;
      slotIndex.set(key, idx + 1);
      const cell = cells.get(key + ':' + idx);
      if (!cell) continue;

      // Улетает именно тот мяч, чей номер вытянули: в барабане они
      // стоят по номерам, а не по очереди розыгрыша, поэтому кто
      // следующий — по нему всё равно не угадать.
      const pick = balls.get(item.participantId) || null;

      if (!ceremony.skip && !reducedMotion()) {
        drum.classList.add('rolling');
        await wait(300);
        drum.classList.remove('rolling');
      } else if (!ceremony.skip) {
        // Барабан не трясём, но паузу перед выдачей оставляем: без неё
        // имена высыпаются подряд и читаются как список.
        await wait(180);
      }

      if (pick) pick.classList.add('gone');
      await flyBall(t, pick || drum, cell, name, who ? who.number : null);
      if (pick) pick.remove();

      cell.classList.add('filled', 'hit');
      if (who) cell.firstChild.appendChild(txt('span', 'num', String(who.number)));
      cell.lastChild.textContent = name;
      knock();
      // «Пропустить» — это мгновенно, и только оно. У того, кто просил
      // убрать движение, церемония остаётся церемонией: без полёта и
      // мельтешения имён, но имена появляются по одному, а не разом.
      // Иначе жеребьёвка для него превращается в готовую таблицу — то
      // есть ровно в то, от чего уходили.
      if (!ceremony.skip) await wait(reducedMotion() ? 520 : 260);
      cell.classList.remove('hit');
    }
  } finally {
    ceremony.running = false;
    stageButtons(t, 'done');
    store.set(seenKey(t), '1');
    void auto;
  }
}

// ---------- Запуск ----------

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStage(); });

async function load() {
  const params = new URLSearchParams(location.search);
  state.id = params.get('t') || '';
  const view = document.getElementById('view');

  if (!state.id) {
    view.innerHTML = '<div class="card"><h2>Турнир не указан</h2>'
      + '<div class="empty">Ссылка на сетку выглядит так: tournament.html?t=…<br>'
      + 'Её выдаёт панель клуба и рассылает организатор.</div></div>';
    return;
  }

  try {
    // Токен необязателен: без него сетка видна всем, просто имена
    // сокращены до фамилии одной буквой, а свои строки не помечаются.
    const res = await api('tournamentCard', { id: state.id, token: store.get(TOKEN_KEY) || undefined });
    state.t = res.tournament;
  } catch (e) {
    view.innerHTML = '<div class="card"><h2>'
      + (e.code === 'tournament-not-found' ? 'Такого турнира нет' : 'Не удалось загрузить')
      + '</h2><div class="empty">'
      + (e.code === 'tournament-not-found'
        ? 'Возможно, турнир удалили или ссылка устарела.'
        : 'Проверьте связь и обновите страницу.')
      + '</div></div>';
    return;
  }

  render();

  // Жеребьёвку показываем сама собой ровно один раз — тому, кто эту
  // раскладку ещё не видел. Дальше только по кнопке: повторный показ
  // при каждом заходе быстро превратился бы из праздника в помеху.
  if (state.t.drawnAt && !state.t.drawManual && !store.get(seenKey(state.t))) playCeremony(true);
}

load();
