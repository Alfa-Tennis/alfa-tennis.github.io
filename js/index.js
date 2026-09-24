// ============================================================
// Клиентская страница теннисного центра «Альфа».
//
// Занятость кортов видна всем без входа — ради этого сюда и заходят.
// Бронировать может только проверенный клиент: предоплаты нет, поэтому
// администратор один раз подтверждает человека, и дальше он бронирует
// сам.
//
// Адрес функции подставляется при развёртывании. Локальный стенд
// (tools/dev-server.js) подменяет его на свой при отдаче страницы —
// сам файл при этом не меняется.
// ============================================================

const API_URL = 'https://functions.yandexcloud.net/d4e0s6c0a0a800fl5cdt';

const state = {
  config: null,
  data: null,          // ответ getAvailability
  dataAt: 0,           // когда занятость читали в последний раз
  date: null,
  span: 'day',         // 'day' — один день, 'week' — лента на неделю
  plan: null,          // { fromIdx, toIdx, switches, segments }
  duration: 60,
  courtFilter: null,
  noSwitch: false,
  view: 'home',
  landing: null,       // ответ getLanding: афиша и всё, что на главной
  openPlay: null,      // ответ openPlayList: открытые тренировки
  tournaments: [],     // перечень турниров; сетка живёт на своей странице
  tournament: null,    // открытая карточка турнира, читается по кнопке
  auth: null,          // { token, client }
  mine: null,          // ответ myBookings
  passHistory: null,   // операции по абонементу; читаются по кнопке
  tgUnlinked: false,   // открыли из Telegram, но учётка не привязана
  pendingAfterLogin: false,
};

const TOKEN_KEY = 'alfa_token';

// Обращение к localStorage может выбросить исключение: приватный режим,
// отключённое хранилище, открытие файла по data:-адресу. Без обёртки
// это роняет всю страницу целиком, включая сетку занятости, которая
// вообще-то никакого хранилища не требует.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* работаем без запоминания входа */ } },
  del(key) { try { localStorage.removeItem(key); } catch (e) { /* нечего чистить */ } },
};

// ---------- Время и формат ----------

function timeToMinutes(t) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(t));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
function minutesToTime(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}
// Клубные сутки уходят за полночь: зимой корт работает до часу ночи, и
// внутри такое время живёт как «24:30». Хранить и сравнивать удобно
// именно так — строки времени сортируются как строки, и «00:30» уехало
// бы в начало дня. Человеку показываем настоящие часы.
function fmtTime(t) {
  const min = timeToMinutes(t);
  if (!Number.isFinite(min)) return String(t == null ? '' : t);
  return minutesToTime(min >= 1440 ? min - 1440 : min);
}
function fmtRange(from, to) { return fmtTime(from) + '–' + fmtTime(to); }
function addDays(dateIso, n) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Момент слота в поясе клуба, а не браузера: человек может смотреть
// сайт из другого региона, «прошедшее» считается по времени Краснодара.
function slotTimestamp(dateIso, timeStr) {
  const tz = (state.config && state.config.booking.timezoneOffset) || '+03:00';
  const min = timeToMinutes(timeStr);
  // Всё, что от 24:00 и дальше, физически наступает следующим утром.
  if (min >= 1440) return new Date(addDays(dateIso, 1) + 'T' + minutesToTime(min - 1440) + ':00' + tz).getTime();
  return new Date(dateIso + 'T' + timeStr + ':00' + tz).getTime();
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Момент времени в поясе клуба: «пт, 15:00». Считаем сами, а не через
// toLocaleString — часовой пояс берём из настроек клуба, а не из
// браузера: человек может смотреть сайт из Москвы, а срок записи
// краснодарский.
function clubMoment(iso) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const tz = (state.config && state.config.booking.timezoneOffset) || '+03:00';
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  const shift = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180;
  const d = new Date(at + shift * 60000);
  return WD[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]
    + ', ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function dayLabel(dateIso, today) {
  if (dateIso === today) return 'Сегодня';
  if (dateIso === addDays(today, 1)) return 'Завтра';
  const d = new Date(dateIso + 'T00:00:00Z');
  return WD[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
}
function dayLabelLong(dateIso, today) {
  const d = new Date(dateIso + 'T00:00:00Z');
  const base = d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  if (dateIso === today) return 'сегодня, ' + base;
  if (dateIso === addDays(today, 1)) return 'завтра, ' + base;
  return WD[d.getUTCDay()] + ', ' + base;
}
function money(v) { return Math.round(v).toLocaleString('ru-RU') + ' ₽'; }
function hoursText(minutes) {
  return (Math.round(minutes / 60 * 10) / 10).toString().replace('.', ',') + ' ч';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(tag, cls) { const d = document.createElement(tag); if (cls) d.className = cls; return d; }
function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ---------- Телефон ----------
//
// Маска только для удобства ввода: сервер всё равно приводит номер к
// десяти цифрам сам, поэтому вставленный из буфера «+7 (918) 111-22-33»
// или «89181112233» тоже пройдёт.

function formatPhoneInput(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';                       // поле можно полностью очистить
  if (digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits[0] !== '7') digits = '7' + digits; // человек начал сразу с кода оператора
  digits = digits.slice(0, 11);

  const rest = digits.slice(1);
  let out = '+7';
  if (rest.length) out += ' ' + rest.slice(0, 3);
  if (rest.length > 3) out += ' ' + rest.slice(3, 6);
  if (rest.length > 6) out += '-' + rest.slice(6, 8);
  if (rest.length > 8) out += '-' + rest.slice(8, 10);
  return out;
}

function attachPhoneMask(input) {
  input.type = 'tel';
  input.inputMode = 'tel';
  input.maxLength = 16;
  input.placeholder = '+7 918 000-00-00';
  input.addEventListener('focus', () => { if (!input.value) input.value = '+7 '; });
  input.addEventListener('input', () => { input.value = formatPhoneInput(input.value); });
  input.addEventListener('blur', () => { if (input.value === '+7' || input.value === '+7 ') input.value = ''; });
}

// ---------- Ошибки ----------

const ERRORS = {
  'slot-taken': 'Это время только что заняли. Выберите другое или встаньте в очередь на него.',
  'too-many-active': 'У вас уже две активные брони. Отмените одну, чтобы записаться снова.',
  'not-verified': 'Администратор ещё не подтвердил вашу заявку.',
  'too-many-no-shows': 'Из-за пропущенных броней записывает администратор. Позвоните в центр.',
  'already-started': 'Игра уже началась — отменить нельзя. Позвоните в центр.',
  'temp-password-expired': 'Временный пароль просрочен. Обратитесь к администратору.',
  'bad-credentials': 'Неверный телефон или пароль.',
  'too-many-attempts': 'Слишком много попыток. Попробуйте через 15 минут.',
  // Потолок регистраций за сутки. Человек здесь ни при чём, поэтому
  // не «попробуйте позже», а живой путь дальше — позвонить в клуб.
  'too-many-signups': 'Регистрация с сайта сейчас недоступна. Позвоните в центр — вас заведут по телефону.',
  'password-too-short': 'Пароль должен быть не короче 6 символов.',
  'password-too-simple': 'Такой пароль подбирается сразу. Не подряд идущие символы и не одна буква.',
  'password-is-phone': 'Пароль не может быть вашим номером телефона.',
  'wrong-current-password': 'Текущий пароль неверный.',
  'invalid-name': 'Укажите имя и фамилию.',
  'invalid-phone': 'Проверьте номер телефона.',
  'item-not-found': 'Этой позиции больше нет — обновите страницу.',
  'option-required': 'Выберите тариф — без него администратор не поймёт, о чём заявка.',
  'answer-required': 'Ответьте на вопрос под тарифом — иначе заявку не принять.',
  'blocked': 'Доступ закрыт. Обратитесь к администратору центра.',
  'token-revoked': 'Нужно войти заново.',
  'unauthorized': 'Нужно войти заново.',
  'booking-not-found': 'Бронь не найдена.',
  'tournament-not-found': 'Турнир не найден — возможно, его удалили.',
  'already-in': 'Вы уже записаны на этот турнир.',
  'not-in': 'Вас нет в составе этого турнира.',
  'signups-closed': 'Запись на турнир закрыта.',
  'draw-done': 'Жеребьёвка уже прошла — состав закрыт. Позвоните в центр.',
  'not-registered': 'На турнир записываются только клиенты центра.',
  'not-linked': 'Telegram не привязан к учётке. Откройте бота центра и поделитесь номером.',
  'bad-init-data': 'Telegram не подтвердил вход. Откройте страницу заново.',
  'declined': 'Вход отклонён в Telegram.',
  'wrong-code': 'В боте нажата кнопка с другим кодом — вход отменён. Начните заново.',
  'staff-use-password': 'Для служебных учёток вход через Telegram отключён — войдите по телефону и паролю.',
  'bad-code': 'Ссылка для входа устарела. Начните заново.',
  'telegram-not-configured': 'Привязка Telegram пока недоступна. Позвоните в центр.',
  'server-unavailable': 'Сервер не отвечает. Попробуйте через минуту.',
  'too-soon': 'До начала осталось слишком мало времени.',
  'beyond-horizon': 'Так далеко записываться пока нельзя.',
  'duration-too-short': 'Минимальная бронь — 1 час.',
  'duration-too-long': 'Такую долгую бронь с сайта не сделать — позвоните администратору или оставьте заявку.',
  'not-long-booking': 'Такое время можно забронировать самому — заявка не нужна.',
  'window-too-short': 'Промежуток короче, чем нужное время. Расширьте его.',
  'outside-hours': 'Это время за пределами работы центра.',
  'move-limit': 'Эту бронь уже переносили максимальное число раз. Отмените и запишитесь заново.',
  'move-too-late': 'До игры осталось меньше часа — перенести уже нельзя.',
  'not-movable': 'Эту бронь перенести нельзя.',
  'openplay-not-found': 'Тренировка не найдена — обновите страницу.',
  'openplay-cancelled': 'Эта тренировка отменена.',
  'signups-closed': 'Набор закрыт. Позвоните в центр, если хотите попасть.',
  'already-signed': 'Вы уже записаны на эту тренировку.',
  'not-signed': 'Вы на эту тренировку не записаны.',
  'window-in-past': 'Это время уже прошло — в очередь на него встать нельзя.',
  'roster-not-found': 'Этот состав уже не набирается — обновите страницу.',
  'series-not-found': 'Постоянная бронь не найдена — обновите страницу.',
  'not-an-occurrence': 'Это занятие уже снято или расписание изменилось. Обновите страницу.',
};
function errorText(code) { return ERRORS[code] || 'Не получилось. Попробуйте ещё раз.'; }

// Единственный канал уведомлений — Telegram. Пока привязки нет, честнее
// говорить об этом прямо, а не обещать «сообщим» в пустоту.
function hasTelegram() {
  return !!(state.auth && state.auth.client && state.auth.client.hasTelegram);
}

// ---------- Слой API ----------

// Одна неудачная попытка не должна оставлять страницу с вечной надписью
// «Загружаем сетку…». Так и случилось 27.08.2026 на боевом контуре: первое
// обращение к холодной функции упёрлось в 504, и страница осталась пустой,
// хотя следующий же запрос прошёл бы за долю секунды. Повторяем только то,
// что заведомо безопасно повторить.
async function request(payload, retries) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400 * attempt));
    // Срок ожидания: без него зависшее соединение держит страницу на
    // «Загружаем…» столько, сколько сервер вообще готов молчать. Повтор
    // тут уже есть — но повторять нечего, пока первый запрос не отпустит.
    // Для повторяемых действий срок короткий, для остальных — почти
    // весь серверный таймаут: оборвать запись, которая вот-вот пройдёт,
    // хуже, чем подождать.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), retries ? 9000 : 25000) : null;
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined,
      });
      // 5xx — это «сервер не смог», такое повторяют. 4xx — «запрос не тот»,
      // повторять бессмысленно, ответ не изменится.
      if (res.status >= 500 && attempt < retries) { lastError = new Error('server-' + res.status); continue; }
      return res;
    } catch (e) {
      lastError = e; // сеть не ответила вовсе или оборвали по времени
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error('request-failed');
}

// Действия, которые ничего не меняют. Их можно молча повторить: сеть
// моргнула — клиент этого даже не заметил. Всё остальное повторять нельзя,
// человек должен сам решить, нажимать ли второй раз.
//
// `bootstrap` здесь обязателен: он собрал в себя весь первый экран, и без
// повтора холодный отказ функции оставлял бы человека перед пустой
// страницей — ровно там, где раньше переспрашивал каждый из четырёх
// запросов по отдельности.
const SAFE_TO_REPEAT = [
  'bootstrap', 'getConfig', 'getAvailability', 'getLanding', 'openPlayList',
  'me', 'myBookings', 'tournamentList', 'tournamentCard',
];

async function api(action, body) {
  const payload = Object.assign({ action }, body || {});
  if (state.auth && state.auth.token) payload.token = state.auth.token;

  const res = await request(payload, SAFE_TO_REPEAT.indexOf(action) > -1 ? 2 : 0);
  // Шлюз при ошибке отвечает не JSON, а страницей с текстом. Без этой
  // подстраховки разбор падал бы невнятной ошибкой разметки вместо
  // понятного «сервер недоступен».
  const data = await res.json().catch(() => ({ error: res.ok ? 'bad-response' : 'server-unavailable' }));
  if (!res.ok) {
    const err = new Error(data.error || 'request-failed');
    err.code = data.error;
    // Часть отказов несёт подробность, без которой их не показать
    // по-человечески: «уровень ниже» и «уровень выше» — разные тексты.
    err.data = data;
    err.hint = data.hint;
    // Токен протух или отозван — вычищаем, иначе страница будет
    // бесконечно упираться в 401 на каждом действии.
    if (res.status === 401) logout(true);
    throw err;
  }
  return data;
}

// ---------- Загрузка ----------

// Подписанные данные Mini App.
//
// Официальный способ — скрипт telegram-web-app.js с серверов Telegram, но
// страница обязана оставаться самодостаточной одним файлом, а у части
// провайдеров в РФ домен Telegram и вовсе недоступен. К счастью, те же
// данные Telegram кладёт в адрес страницы при открытии, и подпись у них
// та же самая — проверяет её всё равно сервер.
function telegramInitData() {
  const wa = window.Telegram && window.Telegram.WebApp;
  if (wa && wa.initData) return wa.initData;
  const m = /[#&]tgWebAppData=([^&]*)/.exec(window.location.hash || '');
  return m ? decodeURIComponent(m[1]) : '';
}

// Вход из Telegram: пароль не спрашиваем вовсе. Обычный вход по телефону
// при этом никуда не девается — им пользуются те, у кого Telegram нет.
async function tryTelegramLogin() {
  const initData = telegramInitData();
  if (!initData) return false;
  try {
    const r = await api('tgAuth', { initData });
    state.auth = { token: r.token, client: r.client };
    store.set(TOKEN_KEY, r.token);
    return true;
  } catch (e) {
    // Telegram подтверждает личность, но телефон в Mini App не отдаёт.
    // Поэтому незнакомого человека отправляем в бота — там он поделится
    // контактом одним нажатием, и телефон придёт подтверждённым.
    if (e.code === 'not-linked') state.tgUnlinked = true;
    return false;
  }
}

async function refreshMe() {
  if (!state.auth) return;
  try {
    const me = await api('me');
    state.auth.client = me.client;
    renderNav();
    if (state.view === 'profile') renderProfile();
  } catch (e) { /* молча: это фоновое обновление, а не действие человека */ }
}

async function load() {
  // Афиша едет вместе с настройками и сеткой: главная — первый экран,
  // ждать её содержимое отдельным заходом человеку негде.
  //
  // Упавшая афиша не должна уносить с собой сетку занятости: главное на
  // странице — забронировать корт, объявления вторичны.
  // Один запрос вместо четырёх параллельных. У функции один запрос на
  // экземпляр, поэтому четыре параллельных поднимали до четырёх
  // контейнеров, из которых тёплым был один: остальные платили холодный
  // старт, и первое открытие после тишины занимало полторы-две секунды.
  const boot = await api('bootstrap', { days: 14 });
  state.config = boot.config;
  state.data = boot.availability;
  state.dataAt = Date.now();
  state.landing = boot.landing;
  state.openPlay = boot.openPlay;
  state.tournaments = boot.tournaments || [];
  state.date = state.data.today;

  // Ссылка из объявления в чате клуба: «освободилось время в субботу
  // 19:00» → ?date=2026-09-05&start=19:00. Человек, пришедший по такой
  // ссылке, должен увидеть тот самый день, а не сегодняшний, — иначе
  // ему придётся искать время, о котором ему только что написали.
  const asked = new URLSearchParams(location.search);
  const askedDate = asked.get('date');
  if (askedDate && state.data.days && state.data.days[askedDate]) state.date = askedDate;

  // В Telegram личность подтверждена подписью — она главнее сохранённого
  // токена, который мог остаться от другого человека на общем телефоне.
  await tryTelegramLogin();

  const saved = !state.auth && store.get(TOKEN_KEY);
  if (saved) {
    state.auth = { token: saved, client: null };
    try {
      const me = await api('me');
      state.auth.client = me.client;
    } catch (e) { state.auth = null; }
  }

  renderHero();
  renderNav();
  renderDays();
  renderGrid();
  renderPicker();

  // Из Telegram открывают кнопкой «Забронировать» — там главная лишний
  // шаг: человек уже сказал, зачем пришёл. В браузере наоборот, первый
  // экран — главная. Ссылка из объявления об освободившемся времени —
  // тот же случай, что и Telegram: человек шёл занимать корт.
  showView(telegramInitData() || askedDate || /[#&]book\b/.test(location.hash) ? 'book' : 'home');
  if (state.auth) refreshMine();
}

async function refreshAvailability() {
  if (!API_URL) return;
  state.data = await api('getAvailability', { days: 14 });
  state.dataAt = Date.now();
  // Состав тренировок обновляем тем же заходом: набор меняется чаще
  // самой сетки, и показывать «2 места» там, где мест уже нет, —
  // ровно тот случай, когда человек жмёт кнопку и получает отказ.
  try {
    state.openPlay = await api('openPlayList', { days: 14 });
    // Общий список приходит без пометок «вы записаны» — они живут в
    // кабинете. Без переноса свои тренировки после каждого обновления
    // выглядели бы чужими.
    markMySessions();
  } catch (e) { /* сетка важнее */ }
}

// Занятость читалась ровно один раз, при открытии страницы. Вкладка,
// оставленная открытой, показывала сетку такой, какой она была час
// назад: администратор успел завести тренировку, а человек видит
// свободный корт и получает отказ на кнопке. Возврат к вкладке — повод
// перечитать, но не чаще раза в минуту: у функции один запрос на
// экземпляр, и частый опрос будит холодные контейнеры вместо тёплого.
const STALE_MS = 60000;
let refreshing = false;

async function refreshIfStale() {
  if (!state.data || refreshing) return;
  if (Date.now() - state.dataAt < STALE_MS) return;
  refreshing = true;
  try {
    await refreshAvailability();
    // День мог уехать за горизонт, пока вкладка лежала открытой: за
    // полночь «сегодня» уже другое, и выбранной даты в ответе нет.
    if (!state.data.days[state.date]) { state.date = state.data.today; state.plan = null; }
    renderDays(); renderGrid(); renderPicker();
    if (state.view === 'home') renderHome();
  } catch (e) { /* молча: человек ничего не нажимал */ }
  finally { refreshing = false; }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', refreshIfStale);

async function refreshMine() {
  if (!state.auth) { state.mine = null; return; }
  try {
    state.mine = await api('myBookings');
    markMySessions();
  } catch (e) { state.mine = null; }
  renderNav();
  // Сетку перерисовываем обязательно: «моя бронь» определяется
  // сопоставлением с кабинетом, а он приезжает уже после первой
  // отрисовки. Без этого своя бронь оставалась серой — и человек,
  // открывший страницу из Telegram, видел собственный корт как чужой и
  // мог встать в очередь на самого себя.
  if (state.data) renderGrid();
  if (state.view === 'mine') renderMine();
}

// Общий список тренировок собирается до того, как страница вспомнит вход
// (токен восстанавливается позже, а из Mini App подпись разбирается ещё
// позже). Поэтому пометки «вы записаны» в нём пустые. Свои записи уже
// приехали вместе с кабинетом — переносим их сюда, вместо того чтобы
// спрашивать сервер второй раз о том же.
function markMySessions() {
  const mine = (state.mine && state.mine.openPlay) || [];
  if (!mine.length || !state.openPlay || !state.openPlay.sessions) return;
  state.openPlay.sessions = state.openPlay.sessions.map(s => {
    const own = mine.find(m => m.id === s.id);
    return own || s;
  });
}

// ---------- Шапка ----------

function renderHero() {
  const c = state.config;
  document.getElementById('clubName').textContent = c.club.name;

  // Правила в подвале берём из настроек, а не пишем текстом: срок отмены
  // меняли уже дважды, и зашитая цифра каждый раз оставалась старой.
  //
  // «Бесплатная отмена» отсюда убрана намеренно: денег за отмену клуб не
  // берёт никогда, и слово «бесплатная» обещало платную — которой нет.
  // Поздняя отмена стоит рейтинга, так и написано.
  document.getElementById('footerRules').textContent =
    'Бронирование от ' + hoursText(c.booking.minBookingMinutes) + ', шаг '
    + c.booking.slotStep + ' минут. Отмена без потери клиентского рейтинга — не позже чем за '
    + c.booking.cancelDeadlineHours + ' ч до начала'
    // Про окно «передумал сразу» сказано здесь же: человек, взявший корт
    // на сегодняшний вечер, иначе решит, что отменить без штрафа нельзя.
    + (c.booking.cancelGraceMinutes
      ? ' и всегда в первые ' + c.booking.cancelGraceMinutes + ' минут после брони.' : '.');
  document.getElementById('clubWhere').textContent =
    [c.club.city, c.club.address].filter(Boolean).join(' · ');

  const rating = document.getElementById('clubRating');
  // «на Яндекс.Картах» — ссылка на карточку: оттуда и рейтинг, человеку
  // логично хотеть посмотреть отзывы целиком.
  // mapUrl правится руками в бакете, мимо белого списка настроек, —
  // тем более проверяем схему здесь.
  const mapUrl = safeUrl(c.club.mapUrl);
  const mapsLink = mapUrl
    ? '<a href="' + escapeHtml(mapUrl) + '" target="_blank" rel="noopener">на Яндекс.Картах</a>'
    : 'на Яндекс.Картах';
  rating.innerHTML = c.club.rating
    ? '<span class="star">★</span> ' + escapeHtml(c.club.rating)
      + (c.club.ratingCount ? ' · ' + c.club.ratingCount + ' оценки ' + mapsLink : '')
    : '';

  // Цену, часы и число кортов шапка не повторяет намеренно: ровно то же
  // самое стоит ниже, в блоке «Забронировать корт», и там оно к месту —
  // рядом с кнопкой, по которой человек и пойдёт. Наверху — то, чем клуб
  // отличается от соседнего: покрытие, кондиционеры, пушки.
  // В настройках это одна строка через запятую — здесь она разбирается
  // на отдельные чипы, и каждый начинается с большой буквы: «Быстрое
  // покрытие», «Кондиционеры», а не хвост перечисления.
  const facts = String(c.club.features || '')
    .split(/\s*,\s*/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => '<span class="fact">' + escapeHtml(s.charAt(0).toUpperCase() + s.slice(1)) + '</span>');

  if (c.club.phone) facts.push('<span class="fact"><a href="tel:' + escapeHtml(c.club.phone.replace(/[^\d+]/g, '')) + '">' + escapeHtml(c.club.phone) + '</a></span>');
  if (mapUrl) facts.push('<span class="fact"><a href="' + escapeHtml(mapUrl) + '" target="_blank" rel="noopener">Как проехать</a></span>');
  document.getElementById('facts').innerHTML = facts.join('');

  // Строка про дополнительную услугу — только когда её нет в каталоге.
  // Натяжка струн живёт там позицией с тремя ценами, и дублировать её
  // в шапке одной фразой значит рассказать про неё дважды и хуже.
  const services = ((state.landing && state.landing.catalog) || [])
    .filter(i => i.category === 'service');
  document.getElementById('clubAbout').innerHTML = c.club.extraService && !services.length
    ? escapeHtml(c.club.extraService) + '.' : '';

  const who = document.getElementById('whoBtn');
  who.textContent = state.auth && state.auth.client
    ? state.auth.client.name.split(' ')[0]
    : 'Войти';

  renderStatusNotice();
}

function renderStatusNotice() {
  const n = document.getElementById('statusNotice');
  const client = state.auth && state.auth.client;

  // Открыли из Telegram, но учётка не привязана. Молча показывать форму
  // пароля здесь неправильно: человек пришёл из мессенджера и пароля,
  // скорее всего, не заводил. Один шаг в боте решает всё.
  if (!client && state.tgUnlinked) {
    const bot = state.config.club.botUsername;
    n.hidden = false;
    n.className = 'notice';
    n.innerHTML = '<b>Ещё пара секунд.</b> Откройте бота центра и нажмите «Поделиться номером» —'
      + 'после этого вход сюда будет без пароля.'
      + (bot ? ` <a href="https://t.me/${bot}" target="_blank" rel="noopener">Открыть бота</a>` : '');
    return;
  }

  if (!client || client.status === 'verified') { n.hidden = true; return; }
  n.hidden = false;
  n.className = 'notice';
  n.innerHTML = client.status === 'pending'
    ? '<b>Заявка на рассмотрении.</b> Администратор подтвердит вас, обычно в течение дня. '
      + 'После этого бронировать можно будет самостоятельно. Занятость кортов видна и сейчас.'
    : '<b>Доступ закрыт.</b> Обратитесь к администратору центра.';
}

document.getElementById('whoBtn').addEventListener('click', () => {
  if (state.auth && state.auth.client) showView('profile');
  else openAuth();
});

// ============================================================
// Главная
// ============================================================

function renderHome() {
  const view = document.getElementById('viewHome');
  const c = state.config;
  view.innerHTML = '';

  // Первым экраном — то, зачем человек пришёл. Цена и часы стоят здесь,
  // а не в шапке: рядом с кнопкой они работают, а наверху были вторым
  // экземпляром той же строки.
  //
  // Если есть тариф дешевле базового, показываем «от», а не одну цену:
  // иначе человек видит 1800 и не узнаёт, что днём корт стоит меньше.
  const rules = (c.pricing.rules || []).filter(r => r.pricePerHour < c.pricing.pricePerHour);
  const cheapest = rules.reduce((min, r) => Math.min(min, r.pricePerHour), c.pricing.pricePerHour);
  const priceFact = cheapest < c.pricing.pricePerHour
    ? 'от <b>' + money(cheapest) + '</b> / час'
    : '<b>' + money(c.pricing.pricePerHour) + '</b> / час';

  const chips = [
    '<span class="fact accent">' + priceFact + '</span>',
    '<span class="fact"><b>' + escapeHtml(fmtRange(c.booking.openTime, c.booking.closeTime)) + '</b> ежедневно</span>',
    '<span class="fact">' + c.courts.length + ' крытых всесезонных корта</span>',
  ];

  // Скидочные окна идут выше призыва своей плашкой: ради них человек и
  // выбирает будний день вместо вечера, а чипом в общем ряду они
  // терялись между часами работы и числом кортов.
  const promo = homePromo(c);
  if (promo) view.appendChild(promo);

  const cta = el('div', 'cta');
  cta.innerHTML = '<h2>Забронировать корт</h2>'
    + '<div class="facts">' + chips.join('') + '</div>'
    + '<p>Оплата на месте — наличными, переводом или картой через терминал / по QR-коду.</p>';
  cta.appendChild(btn('Выбрать время', 'btn', () => showView('book')));
  view.appendChild(cta);

  const posts = (state.landing && state.landing.news) || [];
  if (posts.length) {
    view.appendChild(txt('div', 'section-title', 'Новости центра'));
    view.appendChild(homeNews(posts, c));
  }

  // Открытые тренировки выше афиши: на турнир смотрят, а на тренировку
  // записываются, и окно набора живёт считанные дни.
  if (openPlaySessions().length) {
    view.appendChild(txt('div', 'section-title', 'Открытые тренировки'));
    view.appendChild(homeOpenPlay());
  }

  // Итоги сыгранного — сразу под набором: на них смотрят те же люди и
  // в те же дни, пока игру ещё обсуждают.
  if (recentSessions().length) {
    view.appendChild(txt('div', 'section-title', 'Итоги тренировок'));
    view.appendChild(homeResults());
  }

  // Турниры выше афиши по той же причине, что и тренировки: на афишу
  // смотрят, а сюда записываются.
  if (openTournaments().length) {
    view.appendChild(txt('div', 'section-title', 'Турниры центра'));
    view.appendChild(homeTournaments());
  }

  view.appendChild(txt('div', 'section-title', 'Афиша турниров'));
  view.appendChild(homeEvents());

  const items = (state.landing && state.landing.catalog) || [];
  const goods = items.filter(i => i.category !== 'service');
  if (goods.length) {
    view.appendChild(txt('div', 'section-title', 'Товары центра'));
    view.appendChild(homeGoods(goods));
  }

  view.appendChild(txt('div', 'section-title', 'Услуги'));
  view.appendChild(homeServices(c, items.filter(i => i.category === 'service')));

  view.appendChild(txt('div', 'section-title', 'Как нас найти'));
  view.appendChild(homeContacts(c));
}

// Дни недели окна человеческой строкой: «пн–пт», «сб и вс», «пн, ср,
// пт». Неделя считается от понедельника, а в данных воскресенье это 0 —
// отсюда пересчёт индекса, иначе «сб, вс» превращалось бы в «вс — сб».
//
// Пустой список значит «все дни» — так его понимает и сервер.
function daysLabel(days) {
  const list = Array.isArray(days) ? days.map(Number).filter(d => d >= 0 && d <= 6) : [];
  if (!list.length || list.length === 7) return 'ежедневно';

  const order = list.map(d => (d + 6) % 7).sort((a, b) => a - b);
  const names = order.map(i => WD[(i + 1) % 7]);
  if (order.length > 2 && order[order.length - 1] - order[0] === order.length - 1) {
    return names[0] + '–' + names[names.length - 1];
  }
  return names.length === 2 ? names.join(' и ') : names.join(', ');
}

// Плашка со скидочными окнами. Показываем только те, что владелец сам
// отметил галочкой «на главной», и только если цена там ниже базовой:
// «скидка» ценой в базовую — обман, даже случайный.
function homePromo(c) {
  const base = c.pricing.pricePerHour;
  const shown = (c.pricing.rules || []).filter(r => r.showOnHome && r.pricePerHour < base);
  if (!shown.length) return null;

  const card = el('div', 'promo');
  card.appendChild(txt('div', 'promo-head', shown.length > 1 ? 'Дешевле обычного' : 'Дешевле обычного часа'));

  shown.forEach(r => {
    const row = el('div', 'promo-row');
    row.innerHTML = '<div class="promo-price">' + escapeHtml(money(r.pricePerHour)) + ' / час</div>'
      + '<div class="promo-was">вместо ' + escapeHtml(money(base)) + '</div>'
      + '<div class="promo-when">' + escapeHtml(daysLabel(r.days)) + ', '
      + escapeHtml(fmtRange(r.from, r.to))
      + (r.label ? ' <span class="promo-label">— ' + escapeHtml(r.label) + '</span>' : '')
      + '</div>';
    card.appendChild(row);
  });

  return card;
}

// Новости приходят из группы клуба и попадают сюда только после того,
// как их там же и одобрили: прямая трансляция чата на витрину — вопрос
// времени до неудобного сообщения на главной.
function homeNews(posts, c) {
  const card = el('div', 'card');

  posts.forEach(n => {
    const item = el('div', 'post');

    if (n.photoUrl) {
      const pic = el('div', 'post-pic');
      const img = document.createElement('img');
      img.src = n.photoUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => pic.remove());
      pic.appendChild(img);
      item.appendChild(pic);
    }

    const when = new Date(n.postedAt);
    item.appendChild(html('div', 'post-when', escapeHtml(
      isNaN(when) ? '' : when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }))));
    if (n.text) item.appendChild(txt('div', 'post-text', n.text));

    card.appendChild(item);
  });

  if (c.club.telegramGroup) {
    const links = el('div', 'links');
    links.appendChild(link('Все новости в нашей группе', c.club.telegramGroup));
    card.appendChild(links);
  }

  return card;
}

function homeEvents() {
  const card = el('div', 'card');
  const events = state.landing ? state.landing.events : null;

  // Пустая афиша и не загрузившаяся — разные вещи, и говорить о них
  // надо разное: в первом случае турниров нет, во втором мы просто
  // не знаем.
  if (!events) {
    card.appendChild(txt('div', 'empty', 'Афишу сейчас не удалось загрузить. Обновите страницу позже.'));
    return card;
  }
  if (!events.length) {
    card.appendChild(txt('div', 'empty',
      'Ближайших турниров пока нет. Объявления появляются здесь и в нашей группе.'));
    return card;
  }

  events.forEach(e => {
    const row = el('div', 'ev');
    const d = new Date(e.date + 'T00:00:00Z');
    row.innerHTML = '<div class="ev-when"><div class="d">' + d.getUTCDate() + '</div>'
      + '<div class="m">' + MONTHS[d.getUTCMonth()] + '</div></div>'
      + '<div class="ev-what"><div class="t1">' + escapeHtml(e.title)
      + ' <span class="pill wait">' + escapeHtml(e.categoryName) + '</span></div>'
      + (e.note ? '<div class="t2">' + escapeHtml(e.note) + '</div>' : '') + '</div>';
    card.appendChild(row);
  });

  return card;
}

// Фотографии товаров — единственное, что страница тянет ссылкой из
// хранилища. Согласованное исключение: десяток фотографий в виде
// data:-строк раздул бы её на мегабайты.
function homeGoods(goods) {
  const card = el('div', 'card');
  const grid = el('div', 'goods-grid');

  goods.forEach(item => {
    const cell = el('div', 'goods-card');

    const pic = el('div', 'goods-pic');
    if (item.photoUrl) {
      const img = document.createElement('img');
      img.src = item.photoUrl;
      img.alt = item.name;
      img.loading = 'lazy';
      // Не отдалась картинка — остаётся заглушка, а не рваная карточка.
      img.addEventListener('error', () => { pic.innerHTML = ''; pic.classList.add('no-pic'); });
      pic.appendChild(img);
    } else {
      pic.classList.add('no-pic');
    }
    cell.appendChild(pic);

    const text = el('div', 'goods-body');
    text.innerHTML = '<div class="t1">' + escapeHtml(item.name) + '</div>'
      + '<div class="t-price">' + escapeHtml(priceLabel(item)) + '</div>'
      + (item.description ? '<div class="t2">' + escapeHtml(item.description) + '</div>' : '');
    text.appendChild(btn('Оставить заявку', 'btn sec sm wide', () => openRequest(item, null)));
    cell.appendChild(text);

    grid.appendChild(cell);
  });

  card.appendChild(grid);
  card.appendChild(txt('div', 'empty', 'Про наличие и размеры спросите администратора центра.'));
  return card;
}

function priceLabel(item) {
  if (item.price == null) return 'Цена по запросу';
  return money(item.price) + (item.priceNote ? ' ' + item.priceNote : '');
}

function homeServices(c, services) {
  const card = el('div', 'card');

  services.forEach(item => {
    const block = el('div', 'svc-item' + (item.photoUrl ? '' : ' no-photo'));

    if (item.photoUrl) {
      // Ссылкой на сам файл, а не окном с увеличением: снимок станка
      // рассматривают один раз, и своего просмотрщика это не стоит.
      const link = document.createElement('a');
      link.href = item.photoUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'svc-photo';
      img.src = item.photoUrl;
      img.alt = item.name;
      img.loading = 'lazy';
      // Не отдалась картинка — раскладка возвращается к одной колонке,
      // а не оставляет дыру слева.
      img.addEventListener('error', () => { link.remove(); block.classList.add('no-photo'); });
      link.appendChild(img);
      block.appendChild(link);
    }

    const body = el('div');

    // У услуги может быть несколько тарифов — перетяжка для своих, для
    // сторонних и срочная. Это одна услуга с вариантами, а не три.
    if (item.options && item.options.length) {
      const head = el('div', 'svc-row');
      head.innerHTML = '<span><b>' + escapeHtml(item.name) + '</b></span>';
      body.appendChild(head);
      item.options.forEach(o => {
        const row = el('div', 'svc-row sub');
        row.innerHTML = '<span>' + escapeHtml(o.name) + '</span>'
          + '<b>' + (o.price == null ? 'по запросу' : money(o.price)) + '</b>';
        body.appendChild(row);
      });
    } else {
      const row = el('div', 'svc-row');
      row.innerHTML = '<span>' + escapeHtml(item.name) + '</span>'
        + '<b>' + escapeHtml(priceLabel(item)) + '</b>';
      body.appendChild(row);
    }
    if (item.description) body.appendChild(txt('div', 'empty', item.description));
    const ask = el('div', 'links');
    ask.appendChild(btn('Записаться на услугу', 'btn sec sm', () => openRequest(item, null)));
    // Звоним по номеру самой услуги, а не в центр: натяжку записывает
    // стрингер по своему телефону, и звонок администратору человека
    // только развернёт. Номера нет — нет и кнопки, остаётся заявка.
    const callTo = phoneDigits(item.contactPhone);
    if (callTo) {
      ask.appendChild(txt('span', 'or', 'или'));
      const call = document.createElement('a');
      call.className = 'btn sec sm';
      call.style.textDecoration = 'none';
      call.href = 'tel:' + callTo;
      call.textContent = 'Позвонить';
      ask.appendChild(call);
    }
    body.appendChild(ask);

    block.appendChild(body);
    card.appendChild(block);
  });

  // Пока стрингер не заведён позицией каталога, показываем строку из
  // настроек клуба — она честнее пустого раздела.
  if (!services.length && c.club.extraService) {
    const row = el('div', 'svc-row');
    row.innerHTML = '<span>' + escapeHtml(c.club.extraService) + '</span>'
      + '<b>по договорённости</b>';
    card.appendChild(row);
  }

  (c.pricing.inventory || []).forEach(item => {
    const row = el('div', 'svc-row');
    row.innerHTML = '<span>' + escapeHtml(item.name) + ' в аренду</span>'
      + '<b>' + money(item.pricePerHour) + ' / час</b>';
    card.appendChild(row);
  });

  card.appendChild(txt('div', 'empty',
    'Аренда добавляется при бронировании корта — ракетка или корзина мячей будут ждать на корте.'));
  return card;
}

function homeContacts(c) {
  const card = el('div', 'card');

  const rows = [
    [c.club.address, [c.club.city, c.club.address].filter(Boolean).join(', ')],
    [c.club.phone, c.club.phone],
  ].filter(r => r[0]);

  rows.forEach(r => {
    const row = el('div', 'svc-row');
    row.innerHTML = '<span>' + escapeHtml(r[1]) + '</span>';
    card.appendChild(row);
  });

  const links = el('div', 'links');
  if (c.club.mapUrl) links.appendChild(link('Открыть карту', c.club.mapUrl));
  if (c.club.telegramGroup) links.appendChild(link('Наша группа в Telegram', c.club.telegramGroup));
  // Трансляции с кортов клуб ведёт во ВКонтакте — своей трансляции у нас
  // нет, поэтому ссылка туда, а не встроенный плеер.
  if (c.club.vkUrl) links.appendChild(link('Трансляции с кортов во ВКонтакте', c.club.vkUrl));
  if (c.club.botUsername) links.appendChild(link('Наш бот', 'https://t.me/' + c.club.botUsername));
  if (c.club.phone) links.appendChild(link('Позвонить', 'tel:' + c.club.phone.replace(/[^\d+]/g, '')));
  card.appendChild(links);

  return card;
}

// Группа обязательного выбора: подпись и ряд чипов. Возвращает поле и
// умеет сказать, выбрано ли в нём хоть что-то, — форма заявки спрашивает
// об этом при отправке.
function chipGroup(label, choices, currentId, onPick) {
  const field = el('label', 'field');
  field.innerHTML = '<span>' + escapeHtml(label) + '</span>';
  const chips = el('div', 'chips');

  let chosen = currentId;
  choices.forEach(ch => {
    const c = btn(ch.label, 'chip' + (chosen === ch.id ? ' on' : ''), () => {
      chosen = ch.id;
      field.classList.remove('need');
      Array.prototype.forEach.call(chips.children, n => n.classList.remove('on'));
      c.classList.add('on');
      onPick(ch.id);
    });
    chips.appendChild(c);
  });

  field.appendChild(chips);
  field.isEmpty = () => chosen == null || chosen === '';
  return field;
}

// Заявка с витрины. Вход не спрашиваем намеренно: человек мог прийти
// на сайт за ракеткой, а не за кортом, и требовать регистрацию ради
// вопроса о цене — верный способ этот вопрос не получить.
//
// Но выбор тарифа и ответ на вопрос позиции — обязательны. Раньше форма
// пропускала заявку вообще без них: человек «записался на натяжку», не
// указав ни срочности, ни чьи струны, и узнавал об этом только по
// звонку администратора.
function openRequest(item, option) {
  const client = state.auth && state.auth.client;

  const body = el('div');
  body.innerHTML = '<h3>' + escapeHtml(item.name) + '</h3>'
    + '<div class="m-sub">Администратор перезвонит и проконсультирует по выбранной услуге.</div>';

  // Обязательные группы собираем списком: при отправке достаточно
  // пройти по нему, а не помнить про каждую по отдельности.
  const required = [];

  let picked = option;
  if (!option && item.options && item.options.length) {
    const group = chipGroup('Тариф', item.options.map(o => ({
      id: o.id,
      label: o.name + (o.price == null ? '' : ' · ' + money(o.price)),
    })), picked ? picked.id : null, id => { picked = item.options.find(o => o.id === id); });
    required.push(group);
    body.appendChild(group);
  }

  // Вопрос позиции задаёт владелец из панели: у натяжки это «Струны —
  // свои или клубные», у другой услуги будет своё.
  let answer = '';
  const question = item.question;
  if (question && question.answers && question.answers.length) {
    const group = chipGroup(question.name, question.answers.map(a => ({ id: a, label: a })),
      null, v => { answer = v; });
    required.push(group);
    body.appendChild(group);
  }

  let inpName = null;
  let inpPhone = null;

  if (client) {
    body.appendChild(txt('div', 'empty', 'Перезвоним на ' + client.phone + '.'));
  } else {
    const fName = el('label', 'field');
    fName.innerHTML = '<span>Как вас зовут</span>';
    inpName = document.createElement('input');
    inpName.placeholder = 'Иван Петров';
    inpName.autocomplete = 'name';
    fName.appendChild(inpName); body.appendChild(fName);

    const fPhone = el('label', 'field');
    fPhone.innerHTML = '<span>Телефон</span>';
    inpPhone = document.createElement('input');
    inpPhone.autocomplete = 'tel';
    attachPhoneMask(inpPhone);
    fPhone.appendChild(inpPhone); body.appendChild(fPhone);
  }

  const fComment = el('label', 'field');
  fComment.innerHTML = '<span>Что уточнить — необязательно</span>';
  const comment = document.createElement('input');
  // Подсказку задаёт владелец у каждой позиции: одна на весь каталог
  // сбивала с толку — про струну 1.25 в заявке на тренировку человек
  // читает как вопрос не по адресу. Не задана — нейтральная.
  comment.placeholder = item.commentHint || 'Например: удобное время или вопрос';
  fComment.appendChild(comment); body.appendChild(fComment);

  // Вошедший согласие уже давал — оно записано в его карточке. С витрины
  // заявку оставляют и без учётки, и вот там имя с телефоном приходят
  // впервые: спрашиваем согласие только у них.
  const consent = client ? null : consentBox();
  if (consent) body.appendChild(consent.el);

  const acts = el('div', 'm-acts');
  acts.appendChild(btn('Отмена', 'btn sec', closeModal));
  const send = btn('Отправить', 'btn', async () => {
    const empty = required.filter(g => g.isEmpty());
    if (empty.length) {
      empty.forEach(g => g.classList.add('need'));
      toast(empty.length > 1 ? 'Отметьте выделенное — без этого заявку не принять'
        : 'Отметьте ' + empty[0].querySelector('span').textContent.toLowerCase());
      return;
    }
    if (!client && (!inpName.value.trim() || !inpPhone.value.trim())) {
      toast('Оставьте имя и телефон — иначе перезвонить некуда');
      return;
    }
    if (consent && !consent.checked()) {
      toast('Отметьте согласие на обработку персональных данных', 3200);
      return;
    }
    send.disabled = true;
    try {
      await api('requestItem', {
        itemId: item.id,
        optionId: picked ? picked.id : null,
        answer,
        name: inpName ? inpName.value : '',
        phone: inpPhone ? inpPhone.value : '',
        comment: comment.value,
        consent: consent ? true : undefined,
      });
      closeModal();
      toast('Заявка ушла администратору — перезвонит в рабочее время', 4000);
    } catch (e) {
      send.disabled = false;
      toast(errorText(e.code), 4000);
    }
  });
  acts.appendChild(send);
  body.appendChild(acts);

  showModal(body);
  setTimeout(() => (inpName || comment).focus(), 50);
}

// Бронь дольше потолка сайта. Сайт её не делает: день на корте — это
// почти всегда сборы или турнир, и время под них администратор собирает
// сам, иногда сдвигая чужие брони. Заявка корт НЕ держит — об этом надо
// сказать прямо, иначе человек сочтёт время своим.
function openLongBooking(date, start, minutes) {
  const cfg = state.config.booking;
  const client = state.auth && state.auth.client;
  const end = minutesToTime(timeToMinutes(start) + minutes);

  const body = el('div');
  body.innerHTML = '<h3>Бронь дольше ' + escapeHtml(hoursText(cfg.maxBookingMinutes)) + '</h3>'
    + '<div class="m-sub">' + escapeHtml(dayLabelLong(date, state.data.today) + ' · '
      + fmtRange(start, end) + ' · ' + hoursText(minutes)) + '</div>';
  body.appendChild(txt('div', 'empty', 'С сайта корт бронируется не дольше '
    + hoursText(cfg.maxBookingMinutes) + '. Более долгую бронь делает администратор: позвоните '
    + 'или оставьте заявку — он перезвонит. Пока он не перезвонил, корт за вами не забронирован.'));

  const phone = phoneDigits(state.config.club && state.config.club.phone);
  if (phone) {
    const links = el('div', 'links');
    links.style.margin = '4px 0 12px';
    links.appendChild(link('Позвонить', 'tel:' + phone));
    body.appendChild(links);
  }

  let inpName = null;
  let inpPhone = null;
  if (client) {
    body.appendChild(txt('div', 'empty', 'Перезвоним на ' + client.phone + '.'));
  } else {
    const fName = el('label', 'field');
    fName.innerHTML = '<span>Как вас зовут</span>';
    inpName = document.createElement('input');
    inpName.autocomplete = 'name';
    fName.appendChild(inpName); body.appendChild(fName);
    const fPhone = el('label', 'field');
    fPhone.innerHTML = '<span>Телефон</span>';
    inpPhone = document.createElement('input');
    inpPhone.autocomplete = 'tel';
    attachPhoneMask(inpPhone);
    fPhone.appendChild(inpPhone); body.appendChild(fPhone);
  }

  const fComment = el('label', 'field');
  fComment.innerHTML = '<span>Что за игра — необязательно</span>';
  const comment = document.createElement('input');
  comment.placeholder = 'Например: сборы, турнир, корпоратив';
  fComment.appendChild(comment); body.appendChild(fComment);

  const consent = client ? null : consentBox();
  if (consent) body.appendChild(consent.el);

  const acts = el('div', 'm-acts');
  const send = btn('Оставить заявку', 'btn', async () => {
    if (!client && (!inpName.value.trim() || !inpPhone.value.trim())) {
      toast('Оставьте имя и телефон — иначе перезвонить некуда');
      return;
    }
    if (consent && !consent.checked()) {
      toast('Отметьте согласие на обработку персональных данных', 3200);
      return;
    }
    send.disabled = true;
    try {
      await api('requestLongBooking', {
        date, start, durationMinutes: minutes,
        name: inpName ? inpName.value : '',
        phone: inpPhone ? inpPhone.value : '',
        comment: comment.value,
        consent: consent ? true : undefined,
      });
      closeModal();
      toast('Заявка ушла администратору — перезвонит. Корт пока не забронирован.', 4500);
    } catch (e) {
      send.disabled = false;
      toast(errorText(e.code), 4000);
    }
  });
  acts.appendChild(send);
  acts.appendChild(btn('Вернуться к выбору', 'btn sec', closeModal));
  body.appendChild(acts);

  showModal(body);
}

// Схему проверяем и здесь, хотя сервер уже проверил при сохранении:
// в бакете лежат и значения, попавшие туда до этой проверки, и правки
// руками. «javascript:…» в href — это скрипт на главной у каждого
// посетителя, и стоит он одной строки в настройках.
function safeUrl(href) {
  const s = String(href == null ? '' : href).trim();
  return /^https?:\/\//i.test(s) || /^(tel|mailto):/i.test(s) ? s : '';
}

function link(label, href) {
  const url = safeUrl(href);
  const a = document.createElement(url ? 'a' : 'span');
  a.className = 'btn sec sm';
  a.textContent = label;
  a.style.textDecoration = 'none';
  if (url) {
    a.href = url;
    if (url.indexOf('http') === 0) { a.target = '_blank'; a.rel = 'noopener'; }
  }
  return a;
}

// ---------- Навигация ----------

// Навигация видна всегда: с появлением главной страницы уйти с неё
// к сетке нужно и тому, кто ещё не вошёл.
function renderNav() {
  const nav = document.getElementById('nav');
  nav.hidden = false;

  const client = state.auth && state.auth.client;
  const upcoming = state.mine ? state.mine.upcoming.length : 0;
  const inner = document.getElementById('navInner');
  inner.innerHTML = '';

  [
    { id: 'home', label: 'Главная' },
    { id: 'book', label: 'Бронирование' },
    client ? { id: 'mine', label: 'Мои брони', count: upcoming } : null,
    client ? { id: 'profile', label: 'Профиль' } : null,
  ].filter(Boolean).forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = state.view === t.id ? 'on' : '';
    b.textContent = t.label;
    if (t.count) {
      const d = el('span', 'dot'); d.textContent = t.count; b.appendChild(d);
    }
    b.addEventListener('click', () => showView(t.id));
    inner.appendChild(b);
  });

  syncNavHeight();
}

// Высоту навигации меряем, а не записываем числом: под ней паркуется
// шапка сетки, и разъехавшееся на четыре пикселя число — это полоска
// чужого фона поверх заголовков кортов.
function syncNavHeight() {
  const nav = document.getElementById('nav');
  const h = nav && !nav.hidden ? Math.round(nav.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--nav-h', h + 'px');
}
window.addEventListener('resize', syncNavHeight);

function showView(name) {
  state.view = name;
  document.getElementById('viewHome').hidden = name !== 'home';
  document.getElementById('viewBook').hidden = name !== 'book';
  document.getElementById('viewMine').hidden = name !== 'mine';
  document.getElementById('viewProfile').hidden = name !== 'profile';
  document.getElementById('bar').classList.toggle('show', name === 'book' && !!state.plan);
  if (name === 'home') renderHome();
  if (name === 'mine') renderMine();
  if (name === 'profile') renderProfile();
  renderNav();
  window.scrollTo({ top: 0 });
}

// ---------- Дни ----------

// Считаем не сумму свободных клеток, а время, которое действительно
// можно забронировать: свободные полчаса, к которым не примыкает ещё
// столько же, продать нельзя — минимальная бронь час.
//
// Раньше суммировались все свободные клетки, и на хвосте дня выходила
// прямая ложь: чип обещал «свободно 1 ч», а подбор честно отвечал, что
// на час времени нет. Оба были правы по-своему, и это худший вид
// расхождения — когда экран спорит сам с собой.
function freeHours(dateIso) {
  const step = state.config.booking.slotStep;
  const need = Math.ceil(state.config.booking.minBookingMinutes / step);
  const slots = state.data.slots;
  let free = 0;

  state.config.courts.forEach(court => {
    let run = 0;
    for (let i = 0; i <= slots.length; i++) {
      const ok = i < slots.length && cellState(dateIso, court.id, slots[i]) === 'free';
      if (ok) { run++; continue; }
      if (run >= need) free += run * step;
      run = 0;
    }
  });

  return free / 60;
}

// «Всё занято» и «запись закрыта» — разные новости. В первом случае идти
// в клуб бесполезно, во втором корт стоит пустой и его можно взять по
// телефону. Путать их значит терять и клиента, и деньги за корт.
function dayFreeLabel(dateIso, hours) {
  if (hours > 0) return 'свободно ' + (Math.round(hours * 10) / 10) + ' ч';

  const anyEmpty = state.data.slots.some(slot =>
    state.config.courts.some(court => !busyAt(dateIso, court.id, slot)));
  return anyEmpty ? 'запись закрыта' : 'всё занято';
}

function renderDays() {
  const wrap = document.getElementById('days');
  wrap.innerHTML = '';
  state.data.dates.forEach(date => {
    const hours = freeHours(date);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day' + (date === state.date ? ' active' : '');
    b.innerHTML = '<div class="d-label">' + escapeHtml(dayLabel(date, state.data.today)) + '</div>'
      + '<div class="d-free">' + escapeHtml(dayFreeLabel(date, hours)) + '</div>';
    b.addEventListener('click', () => {
      state.date = date; state.plan = null;
      renderDays(); renderGrid(); renderPicker();
      // Выбор дня — тот момент, когда устаревшая занятость обходится
      // дороже всего: дальше человек жмёт по клетке.
      refreshIfStale();
    });
    wrap.appendChild(b);
  });
}

// ---------- Состояние клетки ----------

function busyAt(dateIso, courtId, slot) {
  const day = state.data.days[dateIso];
  if (!day) return null;
  const list = day[String(courtId)] || [];
  const step = state.config.booking.slotStep;
  const from = timeToMinutes(slot), to = from + step;
  return list.find(b => from < timeToMinutes(b.end) && timeToMinutes(b.start) < to) || null;
}

// Своя бронь определяется сопоставлением с кабинетом, а не отметкой из
// ответа сервера: сетка занятости отдаётся без входа и владельцев в ней
// нет и быть не должно. Иначе подсветка работала бы только в демо.
function myBookingAt(dateIso, courtId, slot) {
  if (!state.mine || !state.mine.upcoming) return null;
  const step = state.config.booking.slotStep;
  const from = timeToMinutes(slot), to = from + step;
  for (const g of state.mine.upcoming) {
    if (g.date !== dateIso) continue;
    for (let i = 0; i < g.segments.length; i++) {
      const s = g.segments[i];
      if (s.courtId === courtId && from < timeToMinutes(s.end) && timeToMinutes(s.start) < to) {
        return { group: g, seg: s, index: i };
      }
    }
  }
  return null;
}

// Порядок проверок = приоритет отображения: своя бронь важнее чужой,
// закрытый корт важнее занятого, прошедшее важнее свободного.
function cellState(dateIso, courtId, slot) {
  // Прошедшее время важнее всего остального, что могло стоять в клетке.
  // Раньше проверка времени шла только для пустых клеток, и вчерашняя
  // чужая бронь оставалась «занято» — с подсказкой «нажмите, чтобы
  // встать в очередь». Очередь на время, которое уже прошло, — это
  // ожидание того, что никогда не наступит.
  //
  // Заодно это решает и второй вопрос: что стояло в прошедшем часе —
  // чужая бронь, тренировка или ремонт — клиента не касается. Он видит
  // ровный серый и не читает чужое расписание.
  const lead = (state.config.booking.minLeadMinutes || 0) * 60000;
  if (slotTimestamp(dateIso, slot) < Date.now() + lead) return 'past';

  const b = busyAt(dateIso, courtId, slot);
  if (b) {
    if (myBookingAt(dateIso, courtId, slot)) return 'mine';
    if (b.kind === 'openplay') return 'openplay';
    if (b.kind === 'tournament') return 'tournament';
    return b.kind === 'closed' ? 'closed' : (b.kind === 'regular' ? 'regular' : 'busy');
  }
  return 'free';
}

// ============================================================
// Подбор корта. Зеркало серверной логики из backend/slots.js.
//
// Корты стоят рядом и равнозначны, поэтому занятость считается по
// клубу, а не по корту: интервал доступен, если в каждой получасовой
// ячейке свободен хотя бы один корт.
//
// Источник истины — сервер, он пересчитывает то же самое при создании
// брони и присланную раскладку не принимает. Здесь это ради мгновенного
// отклика и демо-режима. Правки вносить в обоих местах.
// ============================================================

function buildFreeGrid(dateIso) {
  return state.data.slots.map(slot =>
    state.config.courts.filter(c => cellState(dateIso, c.id, slot) === 'free').map(c => c.id));
}
function rangeFreeOn(grid, courtId, fromIdx, toIdx) {
  for (let i = fromIdx; i <= toIdx; i++) {
    if (!grid[i] || grid[i].indexOf(courtId) === -1) return false;
  }
  return true;
}
function runLength(grid, courtId, fromIdx, toIdx) {
  let n = 0;
  while (fromIdx + n <= toIdx && grid[fromIdx + n].indexOf(courtId) !== -1) n++;
  return n;
}
function assignCourts(grid, fromIdx, toIdx, preferCourtId) {
  const segments = [];
  let i = fromIdx;
  while (i <= toIdx) {
    const available = grid[i] || [];
    if (available.length === 0) return null;
    let court = null;
    if (i === fromIdx && preferCourtId && available.indexOf(preferCourtId) !== -1) court = preferCourtId;
    else {
      let bestLen = -1;
      available.forEach(id => {
        const len = runLength(grid, id, i, toIdx);
        if (len > bestLen) { bestLen = len; court = id; }
      });
    }
    const len = runLength(grid, court, i, toIdx);
    segments.push({ courtId: court, fromIdx: i, toIdx: i + len - 1 });
    i += len;
  }
  return segments;
}
function pickPackedCourt(dateIso, candidates, startMin, endMin) {
  const day = state.data.days[dateIso] || {};
  let best = null, bestScore = -Infinity;
  candidates.forEach(id => {
    const busy = day[String(id)] || [];
    let score = 0;
    if (busy.some(b => timeToMinutes(b.end) === startMin)) score += 10;
    if (busy.some(b => timeToMinutes(b.start) === endMin)) score += 10;
    score += busy.reduce((s, b) => s + (timeToMinutes(b.end) - timeToMinutes(b.start)), 0) / 60;
    if (score > bestScore) { bestScore = score; best = id; }
  });
  return best;
}
function planBooking(dateIso, grid, fromIdx, toIdx, opts) {
  const options = opts || {};
  const preferCourtId = options.preferCourtId || null;
  const onlyCourtId = options.onlyCourtId || null;
  const cfg = state.config.booking;
  if (fromIdx < 0 || toIdx < fromIdx || toIdx >= grid.length) return null;

  const startMin = timeToMinutes(state.data.slots[fromIdx]);
  const endMin = timeToMinutes(state.data.slots[toIdx]) + cfg.slotStep;
  const single = (courtId) => ({ fromIdx, toIdx, switches: 0, segments: [{ courtId, fromIdx, toIdx }] });

  const whole = state.config.courts.map(c => c.id)
    .filter(id => (!onlyCourtId || id === onlyCourtId) && rangeFreeOn(grid, id, fromIdx, toIdx));

  if (preferCourtId && whole.indexOf(preferCourtId) !== -1) return single(preferCourtId);
  if (whole.length) {
    return single(cfg.packCourts === false ? whole[0] : pickPackedCourt(dateIso, whole, startMin, endMin));
  }
  if (onlyCourtId) return null;
  if (cfg.allowCourtSwitch === false) return null;

  const segments = assignCourts(grid, fromIdx, toIdx, preferCourtId);
  if (!segments) return null;
  const switches = segments.length - 1;
  if (switches > (cfg.maxSwitches == null ? 1 : cfg.maxSwitches)) return null;
  return { fromIdx, toIdx, switches, segments };
}
function findOptions(dateIso, durationMinutes, opts) {
  const need = Math.round(durationMinutes / state.config.booking.slotStep);
  if (need < 1) return [];
  const grid = buildFreeGrid(dateIso);
  const out = [];
  for (let i = 0; i + need - 1 < grid.length; i++) {
    const plan = planBooking(dateIso, grid, i, i + need - 1, opts);
    if (plan) out.push(plan);
  }
  return out;
}

// ---------- Сетка ----------

// Построение клетки вынесено из цикла отрисовки: в нём слишком много
// частных случаев — переход между кортами, соседние тренировки, подписи
// только у первой клетки отрезка.
function buildCell(date, court, slot, idx) {
  const slots = state.data.slots;
  const isHour = timeToMinutes(slot) % 60 === 0;
  const st = cellState(date, court.id, slot);
  const cell = el('div', 'cell ' + st + (isHour && idx > 0 ? ' hour-line' : ''));

  if (isSelected(court.id, idx)) {
    cell.className += ' sel';
    if (isSegmentBreak(court.id, idx)) cell.className += ' seg-break';
  }
  if (st === 'mine') {
    const m = myBookingAt(date, court.id, slot);
    if (m && m.index > 0 && timeToMinutes(m.seg.start) === timeToMinutes(slot)) cell.className += ' seg-break';
  }

  // Тренировки идут вплотную одна за другой, и «предыдущая клетка
  // того же вида» для них не значит «то же самое окно»: у второй
  // пропадала подпись, и два окна выглядели одним на пять часов.
  if (st === 'openplay' && cellState(date, court.id, slots[idx - 1] || '') === 'openplay'
      && !sameSessionAsPrev(date, court.id, slots, idx)) {
    cell.className += ' seg-break';
  }

  // Подпись только у первой клетки отрезка, иначе она повторялась бы
  // в каждой получасовой ячейке подряд.
  const startsHere = st === 'openplay'
    ? !sameSessionAsPrev(date, court.id, slots, idx)
    : cellState(date, court.id, slots[idx - 1] || '') !== st;
  if ((st === 'regular' || st === 'closed' || st === 'mine' || st === 'openplay' || st === 'tournament')
      && startsHere) {
    const tag = el('span', 'tag');
    tag.textContent = st === 'openplay' ? openPlayTag(date, court.id, slot)
      : st === 'tournament' ? tournamentTag(date, court.id, slot)
      : (st === 'regular' ? 'постоянная' : (st === 'closed' ? 'закрыт' : 'вы'));
    cell.appendChild(tag);
  }

  // Свободный корт, до которого осталось меньше запаса, выглядит так
  // же, как уже прошедшее время, — серым и молчащим. Человеку в клубе
  // в 23:05 это читается как «занято», хотя корт пуст: причина в
  // правиле клуба, и сказать её надо прямо здесь.
  // Сейчас запас нулевой, и эта ветка молчит. Оставлена намеренно:
  // график у клуба сезонный, и запас однажды вернут настройками —
  // тогда подсказка понадобится снова, без правки страницы.
  if (st === 'past' && state.config.booking.minLeadMinutes > 0
      && !busyAt(date, court.id, slot)
      && slotTimestamp(date, slot) > Date.now()) {
    cell.title = 'Запись закрывается за '
      + hoursText(state.config.booking.minLeadMinutes) + ' до начала. Позвоните в центр.';
  }

  if (st === 'free') cell.addEventListener('click', () => onCellClick(court.id, idx));
  else if (st === 'openplay') {
    // Тренировка — единственное «занято», куда можно попасть:
    // не очередь на чужую бронь, а запись в состав.
    cell.title = 'Открытая тренировка — нажмите, чтобы посмотреть состав';
    cell.addEventListener('click', () => onOpenPlayClick(date, court.id, slot));
  } else if (st === 'tournament') {
    // Очередь на турнирное время бессмысленна — корт не освободится.
    // Клетка ведёт туда, куда и правда можно попасть: в запись.
    const t = tournamentAt(date, court.id, slot);
    cell.title = 'Турнир — нажмите, чтобы посмотреть и записаться';
    if (t) cell.addEventListener('click', () => openTournamentCard(t.id));
  } else if (st === 'busy' || st === 'regular') {
    cell.title = 'Занято — нажмите, чтобы встать в очередь';
    cell.addEventListener('click', () => onBusyClick(court.id, slot));
  }

  return cell;
}

// Турнир в клетке находим по ссылке из занятости, а название — в
// перечне турниров первого экрана: слать его в каждой клетке незачем.
function tournamentAt(dateIso, courtId, slot) {
  const b = busyAt(dateIso, courtId, slot);
  if (!b || !b.tournamentId) return null;
  return (state.tournaments || []).find(t => t.id === b.tournamentId) || { id: b.tournamentId };
}

function tournamentTag(dateIso, courtId, slot) {
  const t = tournamentAt(dateIso, courtId, slot);
  return t && t.title ? 'Турнир · ' + t.title : 'Турнир';
}

function renderGrid() {
  const grid = document.getElementById('grid');
  const courts = state.config.courts;
  const slots = state.data.slots;

  grid.innerHTML = '';
  grid.style.gridTemplateColumns = '64px repeat(' + courts.length + ', minmax(0, 1fr))';

  grid.appendChild(el('div', 'g-head corner'));
  courts.forEach(court => {
    const h = el('div', 'g-head');
    h.innerHTML = escapeHtml(court.name)
      + (court.surface ? '<span class="g-sub">' + escapeHtml(court.surface) + '</span>' : '');
    grid.appendChild(h);
  });

  slots.forEach((slot, idx) => {
    const isHour = timeToMinutes(slot) % 60 === 0;
    const t = el('div', 'g-time' + (isHour ? ' hour' : ''));
    t.textContent = isHour ? fmtTime(slot) : '';
    grid.appendChild(t);

    courts.forEach(court => grid.appendChild(buildCell(state.date, court, slot, idx)));
  });

  renderBar();
}

// ---------- Выбор времени ----------

function isSelected(courtId, idx) {
  const p = state.plan;
  return !!p && p.segments.some(s => s.courtId === courtId && idx >= s.fromIdx && idx <= s.toIdx);
}
function isSegmentBreak(courtId, idx) {
  const p = state.plan;
  return !!p && p.segments.some((s, i) => i > 0 && s.courtId === courtId && idx === s.fromIdx);
}
function setPlan(plan) {
  state.plan = plan;
  renderGrid();
  renderPicker();
}

function onCellClick(courtId, idx, date) {
  // Клик по клетке соседнего дня ленты — это и есть выбор дня: человек
  // ткнул в четверг, значит дальше он собирает бронь в четверге. Начатый
  // в другом дне выбор при этом сбрасывается: бронь через полночь между
  // разными днями всё равно невозможна.
  if (date && date !== state.date) {
    state.date = date;
    state.plan = null;
    // Сетку перерисовываем сразу, не дожидаясь плана: подсветка дня в
    // шапке ленты обязана переехать даже тогда, когда бронь не сложилась
    // и человек увидит отказ.
    renderDays(); renderGrid(); renderPicker();
  }

  const p = state.plan;
  const cfg = state.config.booking;
  const minSlots = Math.ceil(cfg.minBookingMinutes / cfg.slotStep);
  const grid = buildFreeGrid(state.date);

  if (p && idx >= p.fromIdx && idx <= p.toIdx) { setPlan(null); return; }

  // Клик правее текущего выбора продлевает бронь. Корт клика здесь не
  // важен: «до сюда» — это запрос по времени, раскладку подбор соберёт
  // сам, при необходимости с переходом.
  if (p && idx > p.toIdx) {
    // Дольше потолка сайт не бронирует — такое время собирают по звонку.
    // Не отказ, а другой путь: заявка с уже выбранным временем.
    const minutes = (idx - p.fromIdx + 1) * cfg.slotStep;
    if (cfg.maxBookingMinutes && minutes > cfg.maxBookingMinutes) {
      openLongBooking(state.date, state.data.slots[p.fromIdx], minutes);
      return;
    }
    const extended = planBooking(state.date, grid, p.fromIdx, idx, { preferCourtId: p.segments[0].courtId });
    if (extended) { setPlan(extended); return; }
    toast('В это время оба корта заняты');
    return;
  }

  const plan = planBooking(state.date, grid, idx, idx + minSlots - 1, { preferCourtId: courtId });
  if (!plan) { toast('Минимальная бронь — ' + hoursText(cfg.minBookingMinutes) + ' подряд'); return; }
  setPlan(plan);
}

// Ставка для получасовой ячейки. Повторяет расчёт сервера один в один:
// сервер всё равно посчитает сам и клиенту не поверит, но показать цену
// надо до отправки запроса, и разойтись эти два числа не имеют права.
function rateAtMinute(dateIso, cellStart) {
  const rules = (state.config.pricing && state.config.pricing.rules) || [];
  if (rules.length && dateIso) {
    const wd = new Date(dateIso + 'T00:00:00Z').getUTCDay();
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.days && r.days.length && r.days.indexOf(wd) === -1) continue;
      if (cellStart >= timeToMinutes(r.from) && cellStart < timeToMinutes(r.to)) return r.pricePerHour;
    }
  }
  return state.config.pricing.pricePerHour;
}

// Сумма по ячейкам, а не по длительности: бронь может начаться в дешёвые
// часы и закончиться в обычные.
function priceFor(dateIso, startMin, endMin) {
  const step = state.config.booking.slotStep;
  let sum = 0;
  for (let m = startMin; m < endMin; m += step) {
    sum += (Math.min(step, endMin - m) / 60) * rateAtMinute(dateIso, m);
  }
  return Math.round(sum);
}

function planInfo() {
  const p = state.plan;
  if (!p) return null;
  const step = state.config.booking.slotStep;
  const endOf = (i) => minutesToTime(timeToMinutes(state.data.slots[i]) + step);
  const start = state.data.slots[p.fromIdx];
  const end = endOf(p.toIdx);
  const minutes = timeToMinutes(end) - timeToMinutes(start);
  return {
    start, end, minutes, switches: p.switches,
    price: priceFor(state.date, timeToMinutes(start), timeToMinutes(end)),
    segments: p.segments.map(s => ({
      court: state.config.courts.find(c => c.id === s.courtId) || { name: 'Корт' },
      start: state.data.slots[s.fromIdx],
      end: endOf(s.toIdx),
    })),
  };
}

function renderBar() {
  const bar = document.getElementById('bar');
  const info = planInfo();
  if (!info || state.view !== 'book') { bar.classList.remove('show'); return; }

  document.getElementById('selTitle').textContent =
    fmtRange(info.start, info.end) + ' · ' + info.segments.map(s => s.court.name).join(' → ');
  document.getElementById('selSub').textContent =
    dayLabelLong(state.date, state.data.today) + ' · ' + hoursText(info.minutes) + ' · ' + money(info.price);
  document.getElementById('selSwitch').textContent = info.switches === 0 ? ''
    : '⇄ ' + info.segments.slice(1).map(s => 'в ' + fmtTime(s.start) + ' переход на ' + s.court.name).join(', ');

  bar.classList.add('show');
}

document.getElementById('selClear').addEventListener('click', () => setPlan(null));
document.getElementById('selBook').addEventListener('click', startBooking);

// ---------- Панель подбора ----------

const DURATIONS = [60, 90, 120, 180];

function renderPicker() {
  const cfg = state.config.booking;

  const durWrap = document.getElementById('durChips');
  durWrap.innerHTML = '';
  DURATIONS.filter(m => m >= cfg.minBookingMinutes).forEach(m => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (state.duration === m ? ' on' : '');
    b.textContent = hoursText(m);
    b.addEventListener('click', () => { state.duration = m; renderPicker(); });
    durWrap.appendChild(b);
  });

  const courtWrap = document.getElementById('courtChips');
  courtWrap.innerHTML = '';
  // «Любой» первым: большинству игроков корт безразличен. Но выбор
  // конкретного обязан работать — на дальнем не ходят мимо во время
  // матча, и для части людей это принципиально.
  [{ id: null, name: 'Любой' }].concat(state.config.courts).forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (state.courtFilter === c.id ? ' on' : '');
    b.textContent = c.name;
    b.addEventListener('click', () => { state.courtFilter = c.id; renderPicker(); });
    courtWrap.appendChild(b);
  });

  const noSwitchBox = document.getElementById('noSwitch');
  noSwitchBox.checked = state.noSwitch;
  // Конкретный корт и так исключает переходы — галочка ничего не решает.
  noSwitchBox.disabled = state.courtFilter !== null;

  const opts = findOptions(state.date, state.duration, { onlyCourtId: state.courtFilter })
    .filter(p => !(state.noSwitch && p.switches > 0));

  // Очередь должна быть видимым действием, а не находкой для тех, кто
  // случайно ткнул в занятую клетку.
  const foot = document.getElementById('pickerFoot');
  foot.innerHTML = '';
  const hint = el('span');
  hint.textContent = opts.length ? 'Ничего не подходит?' : 'Свободного времени в этот день нет.';
  foot.appendChild(hint);
  foot.appendChild(btn('Встать в очередь', 'btn sm sec', () => openWaitlist({})));

  const wrap = document.getElementById('opts');
  wrap.innerHTML = '';

  if (opts.length === 0) {
    const empty = el('div', 'opts-empty');
    empty.textContent = 'На ' + hoursText(state.duration)
      + ' в этот день свободного времени нет — попробуйте другой день или длительность.';
    wrap.appendChild(empty);
    return;
  }

  opts.forEach(p => {
    const start = state.data.slots[p.fromIdx];
    const end = minutesToTime(timeToMinutes(state.data.slots[p.toIdx]) + cfg.slotStep);
    const active = state.plan && state.plan.fromIdx === p.fromIdx && state.plan.toIdx === p.toIdx;
    const courts = p.segments.map(s => (state.config.courts.find(c => c.id === s.courtId) || {}).name).join(' → ');

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt' + (p.switches ? ' split' : '') + (active ? ' on' : '');
    b.innerHTML = '<span class="o-time">' + escapeHtml(fmtRange(start, end)) + '</span>'
      + '<span class="o-court">' + escapeHtml(courts) + (p.switches ? ' ⇄' : '') + '</span>';
    b.addEventListener('click', () => setPlan(p));
    wrap.appendChild(b);
  });
}

document.getElementById('noSwitch').addEventListener('change', (e) => {
  state.noSwitch = e.target.checked;
  renderPicker();
});

// ============================================================
// Вход и регистрация
// ============================================================

function openAuth(mode) {
  let tab = mode || 'login';

  // Вход через Telegram в обычном браузере: подписи initData здесь нет, а
  // Login Widget запрещён — он тянет скрипт с telegram.org. Поэтому
  // ссылка с одноразовым кодом в бота, подтверждение кнопкой там и опрос
  // отсюда.
  //
  // Ссылку просим заранее, ещё до нажатия: окно, открытое после ожидания
  // сети, браузер считает непрошеным и блокирует. К моменту нажатия она
  // уже есть, и window.open проходит как обычное действие человека.
  let tgStart = null;
  let tgBox = null;

  const tgPossible = () => !!(state.config.club.botUsername) && !telegramInitData();

  if (tgPossible()) {
    api('tgLoginStart')
      .then(r => { tgStart = r; paintTg(); })
      .catch(() => { /* молча: вход по паролю никуда не делся */ });
  }

  function paintTg() {
    if (!tgBox) return;
    tgBox.innerHTML = '';
    if (!tgStart) return;

    const or = el('div', 'tg-or');
    or.textContent = 'или';
    tgBox.appendChild(or);

    const go = btn('Войти через Telegram', 'btn sec wide', () => {
      // Открываем соседней вкладкой, а не переходом: эта должна остаться
      // на месте и дождаться подтверждения. На телефоне ссылка отдаётся
      // приложению Telegram, и вкладка тоже никуда не девается.
      window.open(tgStart.url, '_blank', 'noopener');
      showTgWaiting();
    });
    tgBox.appendChild(go);

    const note = el('div', 'empty');
    note.style.marginTop = '10px';
    // Про «если не открывается» — не перестраховка: Telegram в России с
    // февраля 2026 работает с ограничениями, и человек, у которого он еле
    // грузится, должен видеть, что вход по телефону от мессенджера не
    // зависит вовсе. Иначе он решит, что сайт тоже сломан.
    note.textContent = 'Работает, если Telegram уже привязан к учётке. Если нет — бот подскажет, '
      + 'что нажать. А если Telegram не открывается — вход и регистрация по телефону выше работают без него.';
    tgBox.appendChild(note);
  }

  // Панель ожидания. Она же — единственное место, где человеку показан код
  // сверки: сверять его с сообщением бота и есть защита от чужой ссылки.
  function showTgWaiting() {
    const body = el('div');
    body.innerHTML = '<h3>Подтвердите вход в Telegram</h3>'
      + '<div class="m-sub">Бот прислал три кнопки с кодами. Нажмите ту, где этот код:</div>'
      + '<div class="tg-code">' + escapeHtml(tgStart.confirmCode) + '</div>';

    const status = txt('div', 'empty', 'Ждём подтверждения…');
    body.appendChild(status);
    body.appendChild(tgFallback());

    const acts = el('div', 'm-acts');
    acts.appendChild(btn('Войти по паролю', 'btn sec', () => openAuth('login')));
    body.appendChild(acts);

    showModal(body);
    pollTgLogin(body, status);
  }

  // Запасной путь, когда ссылка до Telegram не доехала. Показываем его
  // всегда, а не по неудаче window.open: с 'noopener' тот по стандарту
  // возвращает null и в успехе, и в отказе — судить по нему нельзя, а
  // прежняя плашка «браузер не дал открыть» врала на каждом входе.
  //
  // Не доехать ссылка может тихо. На компьютере без установленного
  // Telegram обработчика у tg:// нет, страница t.me ничего больше не
  // предлагает, и переход просто ничем не кончается: бот молчит, потому
  // что ему нечего было отвечать. Поэтому здесь и лежит команда целиком —
  // отправленная руками, она равна переходу по ссылке.
  function tgFallback() {
    const box = el('div', 'notice');
    const web = 'https://web.telegram.org/a/#?tgaddr=' + encodeURIComponent(
      'tg://resolve?domain=' + state.config.club.botUsername + '&start=' + tgStart.code);

    box.innerHTML = 'Telegram не открылся? '
      + '<a href="' + escapeHtml(tgStart.url) + '" target="_blank" rel="noopener">Открыть в приложении</a>'
      + ' или <a href="' + escapeHtml(web) + '" target="_blank" rel="noopener">в Telegram Web</a>.'
      + '<div class="tg-cmd-note">Если и там пусто — отправьте боту это сообщение:</div>';

    const cmd = txt('div', 'tg-cmd', '/start ' + tgStart.code);
    box.appendChild(cmd);

    box.appendChild(btn('Скопировать', 'btn sec sm', () => {
      // Копирование могут запретить, и это не повод оставлять человека ни
      // с чем: тогда просто выделяем строку — останется нажать Ctrl+C.
      const fallback = () => {
        const range = document.createRange();
        range.selectNodeContents(cmd);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        toast('Выделено — скопируйте и отправьте боту');
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd.textContent)
          .then(() => toast('Скопировано — вставьте боту в Telegram'), fallback);
      } else fallback();
    }));

    return box;
  }

  // Панель жива, пока она и есть содержимое открытого окна. Закрыли окно
  // или ушли в другое — опрос прекращается сам, без подписок на события.
  function stillWaiting(panel) {
    return document.getElementById('backdrop').classList.contains('show')
      && document.getElementById('modal').contains(panel);
  }

  async function pollTgLogin(panel, status) {
    const started = tgStart;
    const every = (started.pollSeconds || 3) * 1000;
    const until = Date.now() + (started.expiresInMinutes || 5) * 60000;

    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, every));
      if (!stillWaiting(panel)) return;

      let r;
      try {
        r = await api('tgLoginPoll', { code: started.code });
      } catch (e) {
        // Сеть моргнула — спросим через три секунды снова. Мёртвый код —
        // другое дело, ждать больше нечего.
        if (e.code === 'bad-code') break;
        continue;
      }

      if (r.pending) continue;
      if (!r.ok) { status.textContent = errorText(r.error); return; }

      state.auth = { token: r.token, client: r.client };
      store.set(TOKEN_KEY, r.token);
      closeModal();
      renderHero(); renderNav();
      await refreshMine();
      toast('С возвращением, ' + r.client.name.split(' ')[0] + '!');

      if (state.pendingAfterLogin) {
        state.pendingAfterLogin = false;
        setTimeout(startBooking, 300);
      }
      return;
    }

    if (stillWaiting(panel)) {
      status.textContent = 'Время вышло. Вернитесь назад и начните вход заново.';
    }
  }

  function draw() {
    const body = el('div');
    body.innerHTML = '<h3>' + (tab === 'login' ? 'Вход' : 'Регистрация') + '</h3>'
      + '<div class="m-sub">Бронирование доступно проверенным клиентам центра.</div>';

    const tabs = el('div', 'tabs2');
    const tLogin = btn('Вход', tab === 'login' ? 'on' : '', () => { tab = 'login'; draw(); });
    const tReg = btn('Регистрация', tab === 'register' ? 'on' : '', () => { tab = 'register'; draw(); });
    tabs.appendChild(tLogin); tabs.appendChild(tReg);
    body.appendChild(tabs);

    let inpName = null;
    if (tab === 'register') {
      const f = el('label', 'field');
      f.innerHTML = '<span>Имя и фамилия</span>';
      inpName = document.createElement('input');
      inpName.placeholder = 'Иван Петров';
      inpName.autocomplete = 'name';
      f.appendChild(inpName); body.appendChild(f);
    }

    const fPhone = el('label', 'field');
    fPhone.innerHTML = '<span>Телефон</span>';
    const inpPhone = document.createElement('input');
    inpPhone.autocomplete = 'tel';
    attachPhoneMask(inpPhone);
    fPhone.appendChild(inpPhone); body.appendChild(fPhone);

    const fPass = el('label', 'field');
    fPass.innerHTML = '<span>Пароль</span>';
    const inpPass = document.createElement('input');
    inpPass.type = 'password';
    inpPass.autocomplete = tab === 'login' ? 'current-password' : 'new-password';
    inpPass.placeholder = tab === 'register' ? 'не короче 6 символов' : '';
    fPass.appendChild(withPasswordToggle(inpPass)); body.appendChild(fPass);

    // Забытый пароль. Сброса по SMS у нас нет и не будет — рассылка стоит
    // денег и требует оператора, — поэтому единственный честный ответ:
    // администратор сбросит вручную. В профиле такая подсказка была
    // давно, а снаружи её не было вовсе: чтобы её прочитать, надо было
    // сперва войти.
    if (tab === 'login') body.appendChild(forgotPassword());

    // Согласие спрашиваем только при регистрации: у входящего оно уже
    // отмечено в карточке, и просить его заново — значит делать вид,
    // что прошлого раза не было.
    const consent = tab === 'register' ? consentBox() : null;
    if (consent) body.appendChild(consent.el);

    const submit = async () => {
      if (consent && !consent.checked()) {
        toast('Отметьте согласие на обработку персональных данных', 3200);
        return;
      }
      try {
        const res = tab === 'login'
          ? await api('login', { phone: inpPhone.value, password: inpPass.value })
          : await api('register', {
            name: inpName ? inpName.value : '', phone: inpPhone.value,
            password: inpPass.value, consent: true,
          });

        if (tab === 'register' && res.existing) {
          // Учётку могли завести и не вы: администратор заводит карточку,
          // когда записывает человека по телефону или у стойки. Пароля у
          // такой карточки нет вовсе, и «просто войдите» отправляло бы
          // человека в тупик. Про пароль здесь не спрашиваем у сервера
          // намеренно — ответ «на этом номере пароля нет» рассказывал бы
          // о чужом номере больше, чем нужно.
          toast('На этот номер уже есть учётная запись. Если пароль не заводили — '
            + 'войдите через Telegram или попросите пароль у администратора.', 6000);
          tab = 'login'; draw();
          return;
        }

        state.auth = { token: res.token, client: res.client };
        store.set(TOKEN_KEY, res.token);
        closeModal();
        renderHero(); renderNav();
        await refreshMine();

        if (tab === 'register') toast('Заявка отправлена администратору', 3600);
        else toast('С возвращением, ' + res.client.name.split(' ')[0] + '!');

        // Человек нажал «Забронировать» и попал на вход — возвращаем
        // его ровно туда, откуда увели, а не на главную.
        if (state.pendingAfterLogin) {
          state.pendingAfterLogin = false;
          setTimeout(startBooking, 300);
        }
      } catch (e) {
        toast(errorText(e.code), 3600);
      }
    };

    const acts = el('div', 'm-acts');
    const go = btn(tab === 'login' ? 'Войти' : 'Зарегистрироваться', 'btn wide', submit);
    acts.appendChild(go);
    body.appendChild(acts);

    [inpPhone, inpPass].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));

    if (tgPossible()) {
      tgBox = el('div');
      body.appendChild(tgBox);
      paintTg();
    } else {
      const tgNote = el('div', 'empty');
      tgNote.style.marginTop = '12px';
      tgNote.textContent = 'Есть Telegram? Войдите здесь один раз и привяжите его в профиле — '
        + 'дальше вход будет без пароля, и придут напоминания о брони.';
      body.appendChild(tgNote);
    }

    showModal(body);
    setTimeout(() => (inpName || inpPhone).focus(), 50);
  }

  draw();
}

// Телефон клуба в виде, годном для ссылки: только цифры и плюс.
function phoneDigits(raw) {
  const s = String(raw == null ? '' : raw).replace(/[^\d+]/g, '');
  return /^\+?\d{10,15}$/.test(s) ? s : '';
}

// Согласие на обработку персональных данных.
//
// Галочка снята по умолчанию и не «принимается автоматически»: закон
// требует конкретного и осознанного согласия, а проставленная заранее
// галочка — это ни то, ни другое. Ссылка на политику открывается
// отдельной вкладкой, чтобы человек не потерял заполненную форму.
function consentBox() {
  const box = el('label', 'consent');
  const cb = document.createElement('input');
  cb.type = 'checkbox';

  // Клик по ссылке не должен переключать галочку: метка ловит его первой.
  const doc = (href, label) => {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
    a.addEventListener('click', (e) => e.stopPropagation());
    return a;
  };

  const text = document.createElement('span');
  text.appendChild(document.createTextNode('Я принимаю '));
  text.appendChild(doc('/terms.html', 'правила бронирования'));
  text.appendChild(document.createTextNode(' и согласен на обработку моих персональных данных в соответствии с '));
  text.appendChild(doc('/privacy.html', 'политикой центра'));
  text.appendChild(document.createTextNode('.'));

  box.appendChild(cb);
  box.appendChild(text);
  return { el: box, checked: () => cb.checked };
}

// Пароль чаще всего набирают с телефона, где промахнуться легко, а
// проверить набранное можно только глазами. Показ — по кнопке и до
// следующего нажатия, сам по себе пароль не открывается.
const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function withPasswordToggle(input) {
  // Обёртка — div, а не span: `.field span` оформлен как подпись поля.
  const wrap = el('div', 'pass-wrap');
  wrap.appendChild(input);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'pass-eye';
  const sync = () => {
    const shown = input.type === 'text';
    eye.innerHTML = shown ? EYE_SHUT : EYE_OPEN;
    eye.setAttribute('aria-label', shown ? 'Скрыть пароль' : 'Показать пароль');
    eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
    eye.title = shown ? 'Скрыть пароль' : 'Показать пароль';
  };
  // Кнопка внутри <label>: без preventDefault нажатие ушло бы ещё и в
  // поле, а на телефоне это лишний раз открывает клавиатуру.
  eye.addEventListener('mousedown', (e) => e.preventDefault());
  eye.addEventListener('click', (e) => {
    e.preventDefault();
    input.type = input.type === 'password' ? 'text' : 'password';
    sync();
  });
  sync();
  wrap.appendChild(eye);
  return wrap;
}

function forgotPassword() {
  const box = el('div', 'empty');
  box.style.marginTop = '-4px';
  box.style.marginBottom = '12px';
  box.textContent = 'Забыли пароль — свяжитесь с администратором.';

  const phone = phoneDigits(state.config && state.config.club && state.config.club.phone);
  if (!phone) return box;

  const links = el('div', 'links');
  links.style.marginTop = '8px';
  links.appendChild(link('Позвонить', 'tel:' + phone));
  // Чат заводится по номеру клуба, а не через бота: пароль сбрасывает
  // живой администратор, и писать надо ему.
  links.appendChild(link('Написать в Telegram', 'https://t.me/' + (phone[0] === '+' ? phone : '+' + phone)));
  box.appendChild(links);
  return box;
}

function logout(silent) {
  state.auth = null;
  state.mine = null;
  store.del(TOKEN_KEY);
  showView('home');
  renderHero(); renderNav();
  if (!silent) toast('Вы вышли');
}

// ============================================================
// Оформление брони
// ============================================================

function startBooking() {
  const info = planInfo();
  if (!info) return;

  if (!state.auth || !state.auth.client) {
    state.pendingAfterLogin = true;
    openAuth('login');
    return;
  }
  if (state.auth.client.status !== 'verified') {
    showView('book');
    renderStatusNotice();
    toast('Администратор ещё не подтвердил вашу заявку', 3600);
    return;
  }

  // От этой длительности и длиннее бронь подтверждает администратор.
  // Именно «от»: ровно три часа тоже уходят на проверку.
  const approvalFrom = state.config.booking.approvalFromMinutes || 180;
  const needsApproval = info.minutes >= approvalFrom;

  const body = el('div');
  body.innerHTML = '<h3>Подтвердите бронь</h3>'
    + '<div class="m-sub">' + escapeHtml(dayLabelLong(state.date, state.data.today)) + '</div>';

  // Что берут на прокат. Количество живёт здесь, суммы пересчитываются
  // на каждое нажатие: человек должен видеть итог до того, как согласится,
  // а не узнавать его на стойке.
  const inventory = (state.config.pricing && state.config.pricing.inventory) || [];
  const picked = {};
  const hours = info.minutes / 60;
  const extrasList = () => inventory
    .filter(item => picked[item.id] > 0)
    .map(item => ({
      id: item.id, name: item.name, qty: picked[item.id],
      sum: Math.round(picked[item.id] * hours * item.pricePerHour),
    }));

  const sum = el('div', 'summary');
  body.appendChild(sum);

  function renderSummary() {
    sum.innerHTML = '';
    const rows = [
      ['Время', fmtRange(info.start, info.end)],
      ['Длительность', hoursText(info.minutes)],
      ['Корт', info.segments.map(s => s.court.name).join(' → ')],
    ];
    rows.forEach(([k, v]) => {
      const r = el('div', 's-row');
      r.innerHTML = '<span>' + escapeHtml(k) + '</span><span>' + escapeHtml(v) + '</span>';
      sum.appendChild(r);
    });

    const chosen = extrasList();
    // Строку «Корт» с ценой показываем только когда есть что складывать:
    // у брони без проката это лишнее повторение итога.
    if (chosen.length) {
      const r = el('div', 's-row');
      r.innerHTML = '<span>Аренда корта</span><span>' + money(info.price) + '</span>';
      sum.appendChild(r);
      chosen.forEach(x => {
        const e = el('div', 's-row');
        e.innerHTML = '<span>' + escapeHtml(x.name + ' ×' + x.qty) + '</span><span>' + money(x.sum) + '</span>';
        sum.appendChild(e);
      });
    }

    const totalSum = info.price + chosen.reduce((s, x) => s + x.sum, 0);
    const total = el('div', 's-row total');
    total.innerHTML = '<span>Итого на месте</span><span>' + money(totalSum) + '</span>';
    sum.appendChild(total);
  }
  renderSummary();

  if (inventory.length) {
    const rent = el('div', 'rent');
    rent.appendChild(txt('div', 'rent-head', 'Взять в аренду'));

    inventory.forEach(item => {
      picked[item.id] = 0;
      const row = el('div', 'rent-row');

      const label = el('div', 'rent-name');
      label.innerHTML = '<b>' + escapeHtml(item.name) + '</b><span>'
        + money(item.pricePerHour) + ' / час · ' + money(Math.round(hours * item.pricePerHour)) + ' за вашу бронь</span>';
      row.appendChild(label);

      const stepper = el('div', 'stepper');
      const count = txt('span', 'stepper-n', '0');
      const set = (n) => {
        picked[item.id] = Math.max(0, Math.min(item.max, n));
        count.textContent = String(picked[item.id]);
        row.classList.toggle('on', picked[item.id] > 0);
        renderSummary();
      };
      stepper.appendChild(btn('−', 'stepper-b', () => set(picked[item.id] - 1)));
      stepper.appendChild(count);
      stepper.appendChild(btn('+', 'stepper-b', () => set(picked[item.id] + 1)));
      row.appendChild(stepper);

      rent.appendChild(row);
    });

    rent.appendChild(txt('div', 'rent-note', 'Оплата на месте вместе с кортом. Отменить аренду можно при отмене брони.'));
    body.appendChild(rent);
  }

  if (info.switches > 0) {
    const n = el('div', 'notice');
    n.innerHTML = '⇄ <b>Игра на двух кортах.</b> '
      + escapeHtml(info.segments.slice(1).map(s => 'В ' + fmtTime(s.start) + ' нужно перейти на ' + s.court.name).join('. '))
      + '. Корты стоят рядом, покрытие одинаковое.';
    n.style.margin = '0 0 14px';
    body.appendChild(n);
  }
  if (needsApproval) {
    const ttl = state.config.booking.pendingTtlHours || 6;
    const n = el('div', 'notice');
    n.innerHTML = '<b>Бронь от ' + hoursText(approvalFrom)
      + '</b> — её подтверждает администратор. До ответа корт держится за вами. '
      + 'Если ответа не будет в течение ' + ttl + ' ч, время вернётся в общий доступ.';
    n.style.margin = '0 0 14px';
    body.appendChild(n);
  }

  const acts = el('div', 'm-acts');
  const confirm = btn('Забронировать', 'btn', async () => {
    confirm.disabled = true;
    confirm.textContent = 'Бронируем…';
    try {
      const res = await api('createBooking', {
        date: state.date,
        start: info.start,
        durationMinutes: info.minutes,
        courtId: state.courtFilter,
        exactCourt: state.courtFilter !== null,
        // Сумму сервер считает сам и присланной не верит — отправляем
        // только что и сколько взяли.
        extras: extrasList().map(x => ({ id: x.id, qty: x.qty })),
        clientRequestId: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      });
      closeModal();
      setPlan(null);
      await refreshAvailability();
      await refreshMine();
      renderDays(); renderGrid(); renderPicker();
      showView('mine');
      toast(res.needsApproval ? 'Заявка отправлена администратору' : 'Готово, корт забронирован', 3600);
    } catch (e) {
      confirm.disabled = false;
      confirm.textContent = 'Забронировать';
      if (e.code === 'slot-taken') {
        // Время увели у человека из-под рук, и он уже знает, когда хочет
        // играть. Отправлять его обратно в сетку искать заново — терять
        // и его вечер, и наш корт: очередь на это же время стоит здесь
        // же, одной кнопкой.
        const taken = { from: info.start, to: info.end };
        closeModal(); setPlan(null);
        await refreshAvailability();
        renderDays(); renderGrid(); renderPicker();
        openSlotTaken(taken);
        return;
      }
      toast(errorText(e.code), 4000);
    }
  });
  acts.appendChild(confirm);
  acts.appendChild(btn('Назад', 'btn sec', closeModal));
  body.appendChild(acts);

  showModal(body);
}

// ---------- Лист ожидания ----------

// Клик по занятой клетке — только подсказка, откуда начать: окно
// подставляется по этой броне, но человек волен его расширить.
// ============================================================
// Открытые тренировки
// ============================================================
//
// Клуб занимает корт как обычной бронью, поэтому в сетке это «занято».
// Но занято особым образом: сюда можно попасть, и весь смысл экрана —
// показать состав. Имена видны всем намеренно: ровно так список висит
// в группе клуба, и «о, с ним я бы сыграл» — обычный повод записаться.

function openPlaySessions() {
  return (state.openPlay && state.openPlay.sessions) ? state.openPlay.sessions : [];
}

// Сыгранное за последние дни — то, у чего уже есть счёт. Сервер сам
// решает, сколько дней держать итоги, и присылает только их.
function recentSessions() {
  return (state.openPlay && state.openPlay.recent) ? state.openPlay.recent : [];
}

function sessionById(id) {
  return openPlaySessions().find(s => s.id === id) || null;
}

// Тренировку в сетке находим по времени и корту: id клетки приходит
// в занятости, но сводить карточку по нему надёжнее — состав едет
// отдельным запросом и в клетке его нет.
function sessionAt(dateIso, courtId, slot) {
  const min = timeToMinutes(slot);
  return openPlaySessions().find(s => s.date === dateIso
    && s.segments.some(seg => seg.courtId === courtId
      && min >= timeToMinutes(seg.start) && min < timeToMinutes(seg.end))) || null;
}

// В подписи стоит название, а не слово «тренировка»: «Парный микст» и
// «Мужская одиночка» — разные события, и человек выбирает между ними.
// Слово остаётся запасным ответом, когда состав ещё не приехал.
function openPlayTag(dateIso, courtId, slot) {
  const s = sessionAt(dateIso, courtId, slot);
  if (!s) return 'тренировка';
  const op = rosterOf(s, myRoster(s));
  if (op.mine) return op.title + ' · вы записаны';
  // Оба названия, а не «два состава»: человек выбирает между женской и
  // мужской одиночной, и безымянный «второй» выглядел так, будто он
  // хуже. Клетка широкая — оба помещаются, места остались подробностям
  // в карточке.
  if (s.rival) return op.title + ' / ' + s.rival.title;
  if (op.full) return op.title + ' · мест нет';
  return op.title + ' · ' + seatsText(op.left);
}

// Тренировки стоят вплотную: конец одной — начало другой. Отличать их
// надо по самому окну, а не по виду клетки, иначе соседние сливаются.
function sameSessionAsPrev(dateIso, courtId, slots, idx) {
  if (idx === 0) return false;
  const here = sessionAt(dateIso, courtId, slots[idx]);
  const prev = sessionAt(dateIso, courtId, slots[idx - 1]);
  // Состав едет отдельным запросом и может не приехать вовсе. Тогда
  // отличить соседние окна нечем — считаем отрезок одним, как раньше:
  // одна подпись лучше, чем «тренировка» в каждой получасовой клетке.
  if (!here || !prev) return cellState(dateIso, courtId, slots[idx - 1]) === 'openplay';
  return here.id === prev.id;
}

function seatsText(n) {
  const last = n % 10, tens = n % 100;
  if (tens >= 11 && tens <= 14) return n + ' мест';
  if (last === 1) return n + ' место';
  if (last >= 2 && last <= 4) return n + ' места';
  return n + ' мест';
}

function onOpenPlayClick(dateIso, courtId, slot) {
  const s = sessionAt(dateIso, courtId, slot);
  if (!s) { toast('Не удалось открыть тренировку — обновите страницу'); return; }
  openSessionCard(s.id);
}

// Принимает и id, и саму карточку: в кабинете записи приходят из
// myBookings, и требовать, чтобы та же тренировка нашлась ещё и в
// списке ближайших, значило бы ломать экран на границе горизонта.
// На одно время центр иногда вешает два состава — например, женскую и
// мужскую группу, — и играет тот, который соберётся первым. Составов при
// этом два, а время одно, поэтому и карточка одна: с переключателем.
function rosterOf(s, roster) {
  return roster === 'alt' && s.rival ? s.rival : s.openPlay;
}

// Какой состав показывать человеку по умолчанию: тот, в котором он уже
// стоит. Иначе основной.
function myRoster(s) {
  return s.rival && s.rival.mine ? 'alt' : 'main';
}

function openSessionCard(idOrSession, roster) {
  const s = typeof idOrSession === 'string' ? sessionById(idOrSession) : idOrSession;
  if (!s) { toast('Тренировка не найдена — обновите страницу'); return; }
  const which = roster || myRoster(s);
  const op = rosterOf(s, which);
  const other = which === 'alt' ? s.openPlay : s.rival;

  const body = el('div');
  body.innerHTML = '<h3>' + escapeHtml(op.title) + '</h3>'
    + '<div class="m-sub">' + escapeHtml(dayLabelLong(s.date, state.data.today)
      + ' · ' + fmtRange(s.start, s.end) + ' · ' + op.level) + '</div>';

  // Переключатель составов и правило: без объяснения человек не поймёт,
  // почему на один час два разных набора.
  if (other) {
    body.appendChild(html('div', 'notice',
      'На это время набираются два состава — играет тот, который соберётся первым. '
      + 'Записаться можно только в один.'));
    const tabs = el('div', 'acts');
    // Текущий состав — не кнопка, а подпись: нажимать на то, что уже
    // открыто, некуда.
    tabs.appendChild(txt('span', 'pill ok', op.title + ' · ' + op.taken + ' из ' + op.seats));
    tabs.appendChild(btn(other.title + ' · ' + other.taken + ' из ' + other.seats
      + (other.mine ? ' · вы здесь' : ''), 'btn sm sec',
      () => openSessionCard(s, which === 'alt' ? 'main' : 'alt')));
    body.appendChild(tabs);
  }

  const info = el('div', 'summary');
  // Тренировка держит корты одновременно, а не по очереди, — значит «и»,
  // а не стрелка перехода: «Корт 1 → Корт 2» читалось бы как смена корта
  // посреди игры.
  const names = s.courts.filter((c, i) => s.courts.indexOf(c) === i);
  const parallel = s.segments.every(seg => seg.start === s.segments[0].start);
  const courts = names.join(parallel ? ' и ' : ' → ');
  info.innerHTML = '<div class="s-row"><span>' + (names.length > 1 && parallel ? 'Корты' : 'Корт')
    + '</span><span>' + escapeHtml(courts) + '</span></div>'
    + '<div class="s-row"><span>Записались</span><span>' + op.taken + ' из ' + op.seats + '</span></div>'
    + '<div class="s-row"><span>' + (names.length > 1 && parallel ? 'Корты целиком' : 'Корт целиком')
    + '</span><span>' + money(s.total) + '</span></div>'
    // Две цифры намеренно: делить корт на одного записавшегося честно
    // арифметически, но читается как цена, по которой никто не придёт.
    // Как игроки делят сумму на месте, клуб всё равно не решает.
    + '<div class="s-row"><span>При полном составе</span><span>' + money(op.perFull) + ' с человека</span></div>'
    + (op.perPerson && op.taken > 1 && !op.full
      ? '<div class="s-row"><span>Если придут только записавшиеся</span><span>' + money(op.perPerson) + '</span></div>'
      : '');
  body.appendChild(info);

  if (op.note) body.appendChild(txt('div', 'empty', op.note));

  const list = el('div', 'card');
  if (!op.signups.length) {
    list.appendChild(txt('div', 'empty', 'Пока никто не записался — будете первым.'));
  } else {
    op.signups.forEach((p, i) => {
      const row = el('div', 'item');
      row.innerHTML = '<div class="t1">' + (i + 1) + '. ' + escapeHtml(p.name)
        + (p.partnerName ? ' + ' + escapeHtml(p.partnerName) : '')
        + (p.mine ? ' <span class="pill ok">это вы</span>' : '') + '</div>';
      list.appendChild(row);
    });
  }
  if (op.queue.length) {
    list.appendChild(txt('div', 'section-title', 'В очереди'));
    op.queue.forEach((p, i) => {
      const row = el('div', 'item');
      row.innerHTML = '<div class="t1">' + (i + 1) + '. ' + escapeHtml(p.name)
        + (p.partnerName ? ' + ' + escapeHtml(p.partnerName) : '')
        + (p.mine ? ' <span class="pill ok">это вы</span>' : '') + '</div>';
      list.appendChild(row);
    });
  }
  body.appendChild(list);

  const acts = el('div', 'm-acts');
  if (op.mine) {
    acts.appendChild(btn('Отказаться', 'btn danger', () => leaveSession(s)));
  } else if (other && other.mine) {
    body.appendChild(txt('div', 'notice',
      'Вы записаны в соседний состав. Чтобы перейти сюда, сначала снимитесь оттуда.'));
  } else if (op.signupsClosed) {
    body.appendChild(txt('div', 'notice', 'Набор закрыт. Позвоните в центр, если хотите попасть.'));
  } else {
    const fPair = el('label', 'field');
    fPair.innerHTML = '<span>Идёте парой? Впишите партнёра — займёте два места</span>';
    const inpPair = document.createElement('input');
    inpPair.placeholder = 'Имя партнёра, если есть';
    fPair.appendChild(inpPair);
    body.insertBefore(fPair, list);

    acts.appendChild(btn(op.full ? 'Встать в очередь' : 'Записаться', 'btn',
      () => joinSession(s, inpPair.value.trim(), false, which)));
  }
  acts.appendChild(btn('Закрыть', 'btn sec', closeModal));
  body.appendChild(acts);

  showModal(body);
}

async function joinSession(s, partnerName, confirmLevel, roster) {
  if (!state.auth || !state.auth.client) { openAuth('login'); return; }

  try {
    const res = await api('joinOpenPlay', {
      date: s.date, bookingId: s.id,
      partnerName: partnerName || undefined,
      confirmLevel: confirmLevel || undefined,
      roster: roster === 'alt' ? 'alt' : undefined,
    });
    closeModal();
    await refreshAvailability();
    await refreshMine();
    renderGrid();
    if (state.view === 'home') renderHome();
    toast(res.placed === 'queue' ? 'Мест не было — вы в очереди' : 'Вы записаны');
  } catch (e) {
    // Уровень не запрещает записаться, а предупреждает: ссорить систему
    // с людьми из-за половины балла не стоит, решает организатор.
    if (e.code === 'needs-level-confirm') {
      confirmLevelAndJoin(s, partnerName, e.hint, roster);
      return;
    }
    toast(errorText(e.code), 4000);
  }
}

function confirmLevelAndJoin(s, partnerName, hint, roster) {
  const op = rosterOf(s, roster || 'main');
  const body = el('div');
  body.innerHTML = '<h3>Проверьте уровень</h3>'
    + '<div class="m-sub">' + escapeHtml(op.title + ' · ' + op.level) + '</div>';
  body.appendChild(html('div', 'notice', hint === 'below'
    ? 'Ваш уровень ниже диапазона этой тренировки. Записаться можно, но игра может оказаться тяжёлой.'
    : 'Ваш уровень выше диапазона этой тренировки. Записаться можно, но игра может оказаться слишком лёгкой.'));

  const acts = el('div', 'm-acts');
  acts.appendChild(btn('Всё равно записаться', 'btn', () => joinSession(s, partnerName, true, roster)));
  acts.appendChild(btn('Передумал', 'btn sec', closeModal));
  body.appendChild(acts);
  showModal(body);
}

async function leaveSession(s) {
  try {
    await api('leaveOpenPlay', { date: s.date, bookingId: s.id });
    closeModal();
    await refreshAvailability();
    await refreshMine();
    renderGrid();
    if (state.view === 'home') renderHome();
    toast('Вы сняты с тренировки');
  } catch (e) {
    toast(errorText(e.code), 4000);
  }
}

// Блок на главной. Показывается, только когда тренировки есть: пустой
// заголовок «Открытые тренировки» читается как «их у нас не бывает».
function homeOpenPlay() {
  const card = el('div', 'card');
  openPlaySessions().slice(0, 6).forEach(s => {
    const op = rosterOf(s, myRoster(s));
    const it = el('div', 'item');
    it.innerHTML = '<div class="t1">' + escapeHtml(op.title)
      + ' <span class="pill ' + (op.full ? 'grey' : 'ok') + '">'
      + (op.full ? 'мест нет' : seatsText(op.left)) + '</span>'
      // Второй состав называем по имени: «и второй состав» звучит как
      // приписка, а это равноправная группа — играет та, что соберётся
      // первой.
      + (s.rival ? ' <span class="pill wait">или «' + escapeHtml(s.rival.title) + '»</span>' : '')
      + (op.mine ? ' <span class="pill ok">вы записаны</span>' : '') + '</div>'
      + '<div class="t2">' + escapeHtml(dayLabelLong(s.date, state.data.today)
        + ' · ' + fmtRange(s.start, s.end) + ' · ' + op.level) + '</div>';
    it.appendChild(btn(op.mine ? 'Посмотреть состав' : 'Подробнее', 'btn sm sec',
      () => openSessionCard(s.id)));
    card.appendChild(it);
  });
  return card;
}

// ---------- Итоги сыгранного ----------
//
// Круговая таблица, как её пишут на листе на корте: строки в порядке
// записи, в клетке счёт геймов, справа очки и место. Считает всё сервер
// — страница только рисует присланное.

function resultsTableHtml(op) {
  const r = op.results;
  if (!r || !r.rows || !r.rows.length) return '';
  const n = r.rows.length;

  let head = '<tr><th class="rt-name">Участник</th>';
  for (let i = 1; i <= n; i++) head += '<th>' + i + '</th>';
  head += '<th>Очки</th><th>Место</th></tr>';

  const body = r.rows.map(row => {
    const who = row.name + (row.partnerName ? ' / ' + row.partnerName : '');
    let tds = '<td class="rt-name">' + row.no + '. ' + escapeHtml(who) + '</td>';
    for (let j = 0; j < n; j++) {
      tds += (row.no - 1 === j)
        ? '<td class="rt-self"></td>'
        : '<td>' + escapeHtml(row.cells[j] || '') + '</td>';
    }
    tds += '<td class="rt-sum">' + row.points + '</td>'
      + '<td class="rt-sum">' + (row.place || '') + '</td>';
    return '<tr>' + tds + '</tr>';
  }).join('');

  return '<div class="rt-wrap"><table class="rt"><thead>' + head
    + '</thead><tbody>' + body + '</tbody></table></div>';
}

function homeResults() {
  const card = el('div', 'card');
  recentSessions().slice(0, 6).forEach(s => {
    // У тренировки с двумя составами счёт бывает у обоих: сыграл один,
    // но итог мог быть внесён и распущенному — показываем всё, что есть.
    [s.openPlay, s.rival].filter(op => op && op.results).forEach(op => {
      const it = el('div', 'item');
      it.innerHTML = '<div class="t1">' + escapeHtml(op.title) + '</div>'
        + '<div class="t2">' + escapeHtml(dayLabelLong(s.date, state.data.today)
          + ' · ' + fmtRange(s.start, s.end)) + '</div>'
        + resultsTableHtml(op)
        + (op.results.note
          ? '<div class="rt-note">Ещё играли: ' + escapeHtml(op.results.note) + '</div>' : '');
      card.appendChild(it);
    });
  });
  return card;
}

// ---------- Турниры ----------
//
// На главной живёт только перечень и запись. Сетка, таблицы и
// церемония жеребьёвки — на своей странице (tournament.html): она
// открывается по ссылке и печатается, а тащить её сюда значило бы
// удвоить и без того немаленький файл.

const T_STATUS_LABEL = {
  signup: ['wait', 'идёт запись'],
  groups: ['ok', 'групповой этап'],
  playoff: ['ok', 'плей-офф'],
  finished: ['grey', 'завершён'],
};

// Завершённые не показываем: главная — про то, куда можно попасть.
// Идущий турнир остаётся, чтобы участники ходили за сеткой отсюда.
function openTournaments() {
  return (state.tournaments || []).filter(t => t.status !== 'finished');
}

// Турнир идёт день или месяцы, поэтому дата тут без «сегодня/завтра»:
// «сегодня — 14 ноя» читается как ошибка.
function tournamentDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
}

function tournamentDates(t) {
  const days = t.dateFrom === t.dateTo ? tournamentDay(t.dateFrom)
    : tournamentDay(t.dateFrom) + ' — ' + tournamentDay(t.dateTo);
  // Время показываем только у однодневного: у многодневного кругового
  // его нет — там играют когда договорятся.
  if (t.dateFrom !== t.dateTo || !t.timeFrom) return days;
  return days + ', ' + fmtTime(t.timeFrom) + (t.timeTo ? '–' + fmtTime(t.timeTo) : '');
}

function homeTournaments() {
  const card = el('div', 'card');
  openTournaments().slice(0, 6).forEach(t => {
    const st = T_STATUS_LABEL[t.status] || ['grey', ''];
    const it = el('div', 'item');
    it.innerHTML = '<div class="t1">' + escapeHtml(t.title)
      + ' <span class="pill ' + st[0] + '">' + escapeHtml(st[1]) + '</span></div>'
      + '<div class="t2">' + escapeHtml(tournamentDates(t) + ' · ' + t.level)
      + ' · ' + t.taken + ' из ' + t.maxParticipants
      + (t.fee ? ' · взнос ' + money(t.fee) : ' · без взноса') + '</div>';
    it.appendChild(btn('Подробнее', 'btn sm sec', () => openTournamentCard(t.id)));
    card.appendChild(it);
  });
  return card;
}

async function openTournamentCard(id) {
  try {
    const res = await api('tournamentCard', { id });
    state.tournament = res.tournament;
  } catch (e) {
    toast(errorText(e.code), 4000);
    return;
  }
  showTournamentCard();
}

function showTournamentCard() {
  const t = state.tournament;
  const body = el('div');
  const st = T_STATUS_LABEL[t.status] || ['grey', ''];
  body.innerHTML = '<h3>' + escapeHtml(t.title)
    + ' <span class="pill ' + st[0] + '">' + escapeHtml(st[1]) + '</span></h3>'
    + '<div class="m-sub">' + escapeHtml(tournamentDates(t)) + ' · ' + escapeHtml(t.level)
    + '<br>Матч играется до: ' + escapeHtml(T_SCORING_LABEL[t.scoring.mode] || '')
    + (t.fee ? '<br>Взнос ' + escapeHtml(money(t.fee)) + ', оплата на месте' : '<br>Без взноса')
    + '</div>'
    + (t.note ? '<div class="notice">' + escapeHtml(t.note) + '</div>' : '');

  const list = el('div');
  list.innerHTML = '<div class="t2">Записались (' + t.taken + ' из ' + t.maxParticipants + '):</div>';
  if (!t.participants.length) {
    list.appendChild(txt('div', 't2', 'Пока никого. Будете первым.'));
  }
  t.participants.forEach(p => {
    list.appendChild(txt('div', 't1', p.name + (p.mine ? ' — это вы' : '')));
  });
  body.appendChild(list);

  const waiting = t.waitlist.some(p => p.mine);
  if (waiting) {
    body.appendChild(txt('div', 'notice',
      'Вы в листе ожидания: центр посмотрит заявку и решит сам. Мест это пока не занимает.'));
  }

  const acts = el('div', 'm-acts');

  if (t.drawnAt) {
    const link = document.createElement('a');
    link.className = 'btn sec';
    link.href = 'tournament.html?t=' + encodeURIComponent(t.id);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Сетка и результаты';
    acts.appendChild(link);
  }

  if (t.mine && !t.drawnAt) {
    acts.appendChild(btn('Отменить запись', 'btn danger', () => leaveTournament(t)));
  } else if (t.mine) {
    body.appendChild(txt('div', 'notice',
      'Жеребьёвка проведена — сняться самому уже нельзя. Если не сможете играть, '
      + 'позвоните в центр: вас заменят или снимут с турнира.'));
  } else if (t.drawnAt) {
    body.appendChild(txt('div', 'notice', 'Запись закрыта: жеребьёвка уже прошла.'));
  } else if (t.signupsClosed || t.signupsClosedNow) {
    // Запись закрывается и сама — накануне турнира. Человеку называем
    // точный момент, иначе кнопка просто исчезает без причины.
    const when = clubMoment(t.signupCloseAt);
    body.appendChild(txt('div', 'notice', t.signupsClosed || !when
      ? 'Запись закрыта. Позвоните в центр, если хотите попасть.'
      : 'Запись закрылась ' + when + '. Позвоните в центр, если хотите попасть.'));
  } else {
    // До закрытия — тот же срок, но как обещание: видно, сколько ещё
    // можно думать. Без него человек откладывает и не успевает.
    const when = clubMoment(t.signupCloseAt);
    if (when) body.appendChild(txt('div', 'empty', 'Записаться можно до ' + when + '.'));
    acts.appendChild(btn('Записаться', 'btn', () => joinTournament(t)));
  }

  acts.appendChild(btn('Закрыть', 'btn sec', closeModal));
  body.appendChild(acts);
  showModal(body);
}

const T_SCORING_LABEL = { set1: 'один сет', set2: 'два сета', proset8: 'про-сет до 8' };

async function joinTournament(t) {
  if (!state.auth || !state.auth.client) { openAuth('login'); return; }
  try {
    const res = await api('joinTournament', { id: t.id });
    state.tournament = res.tournament;
    await refreshTournaments();
    showTournamentCard();
    // Уровень здесь строгий, в отличие от тренировок: так решил центр.
    // Отказом это не считается — заявку смотрит владелец.
    toast(res.placed === 'waitlist'
      ? (res.reason === 'level'
        ? 'Ваш уровень вне диапазона турнира — заявка ушла на рассмотрение'
        : 'Мест уже нет — вы в листе ожидания')
      : 'Вы записаны на турнир', 4500);
  } catch (e) {
    toast(errorText(e.code), 4000);
  }
}

async function leaveTournament(t) {
  try {
    const res = await api('leaveTournament', { id: t.id });
    state.tournament = res.tournament;
    await refreshTournaments();
    showTournamentCard();
    toast('Запись отменена');
  } catch (e) {
    toast(errorText(e.code), 4000);
  }
}

// Перечень приезжает первым экраном, но после записи он устарел —
// перечитываем только его, а не весь экран.
async function refreshTournaments() {
  try {
    const res = await api('tournamentList', {});
    state.tournaments = res.tournaments || [];
    if (state.view === 'home') renderHome();
  } catch (e) { /* список не критичен: карточка уже обновлена */ }
}

function onBusyClick(courtId, slot, date) {
  const day = date || state.date;
  const block = busyAt(day, courtId, slot);
  if (!block) return;
  // Очередь ставится на конкретный день, поэтому клик в ленте сначала
  // переводит выбор на него — иначе человек встал бы в очередь на
  // сегодня, глядя на субботу.
  if (day !== state.date) {
    state.date = day;
    state.plan = null;
    renderDays(); renderGrid(); renderPicker();
  }
  openWaitlist({ from: block.start, to: block.end });
}

// Очередь ставится на «сколько времени и в каком промежутке», а не на
// конкретную чужую бронь. Иначе освободившийся соседний слот прошёл бы
// мимо человека, который его с радостью бы взял.
// Отказ «время только что заняли» — единственный случай, когда человек
// уже сделал всё правильно и всё равно остался ни с чем. Поэтому не
// тост, который исчезнет через четыре секунды, а окно с выбором: искать
// дальше или занять очередь на это же время.
function openSlotTaken(taken) {
  const body = el('div');
  body.innerHTML = '<h3>Это время только что заняли</h3>'
    + '<div class="m-sub">' + escapeHtml(fmtRange(taken.from, taken.to))
    + ' — кто-то успел на секунды раньше. Оба корта в это время уже заняты.</div>';

  const note = el('div', 'notice info');
  note.textContent = 'Встанете в очередь — бот напишет первым, если это время освободится.';
  note.style.margin = '0 0 14px';
  body.appendChild(note);

  const acts = el('div', 'm-acts');
  acts.appendChild(btn('Встать в очередь', 'btn', () => {
    closeModal();
    openWaitlist(taken);
  }));
  acts.appendChild(btn('Выбрать другое время', 'btn sec', closeModal));
  body.appendChild(acts);

  showModal(body);
}

function openWaitlist(prefill) {
  if (!state.auth || !state.auth.client) { openAuth('login'); return; }

  const cfg = state.config.booking;
  const open = timeToMinutes(cfg.openTime);
  const close = timeToMinutes(cfg.closeTime);
  const pre = prefill || {};

  let from = timeToMinutes(pre.from != null ? pre.from : '17:00');
  let to = timeToMinutes(pre.to != null ? pre.to : '22:00');
  if (to <= from) to = Math.min(close, from + cfg.minBookingMinutes);
  // Окно из одной брони обычно короткое — берём длительность по нему,
  // но не меньше минимальной и не больше того, что человек искал.
  let duration = Math.min(state.duration, to - from);
  if (duration < cfg.minBookingMinutes) duration = cfg.minBookingMinutes;

  function timeList(fromMin, toMin) {
    const out = [];
    for (let m = fromMin; m <= toMin; m += cfg.slotStep) out.push(minutesToTime(m));
    return out;
  }

  function draw() {
    if (to - from < duration) to = Math.min(close, from + duration);
    if (from + duration > close) from = close - duration;

    const body = el('div');
    body.innerHTML = '<h3>Встать в очередь</h3>'
      + '<div class="m-sub">' + escapeHtml(dayLabelLong(state.date, state.data.today)) + '</div>';

    const rowD = el('div', 'picker-row');
    rowD.innerHTML = '<span class="lab">Нужно</span>';
    const chips = el('span', 'chips');
    DURATIONS.filter(m => m >= cfg.minBookingMinutes && m <= close - open).forEach(m => {
      const b = btn(hoursText(m), 'chip' + (duration === m ? ' on' : ''), () => { duration = m; draw(); });
      chips.appendChild(b);
    });
    rowD.appendChild(chips);
    body.appendChild(rowD);

    const grid2 = el('div');
    grid2.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px';

    const fFrom = el('label', 'field');
    fFrom.innerHTML = '<span>Не раньше</span>';
    const selFrom = document.createElement('select');
    // Значение остаётся клубным («24:30»), подпись — человеческой.
    timeList(open, close - duration).forEach(t => {
      const o = document.createElement('option'); o.value = t; o.textContent = fmtTime(t); selFrom.appendChild(o);
    });
    selFrom.value = minutesToTime(from);
    selFrom.addEventListener('change', () => { from = timeToMinutes(selFrom.value); draw(); });
    fFrom.appendChild(selFrom);

    const fTo = el('label', 'field');
    fTo.innerHTML = '<span>Не позже</span>';
    const selTo = document.createElement('select');
    timeList(from + duration, close).forEach(t => {
      const o = document.createElement('option'); o.value = t; o.textContent = fmtTime(t); selTo.appendChild(o);
    });
    selTo.value = minutesToTime(to);
    selTo.addEventListener('change', () => { to = timeToMinutes(selTo.value); draw(); });
    fTo.appendChild(selTo);

    grid2.appendChild(fFrom); grid2.appendChild(fTo);
    body.appendChild(grid2);

    const note = el('div', 'notice info');
    note.style.margin = '4px 0 0';
    note.innerHTML = 'Сообщим, как только в промежутке <b>' + escapeHtml(fmtRange(minutesToTime(from), minutesToTime(to)))
      + '</b> освободится <b>' + escapeHtml(hoursText(duration)) + '</b>. '
      + 'Вы узнаете первым — раньше, чем время уйдёт в общий чат центра.';
    body.appendChild(note);

    // Без этого «сообщим» звучит как «ждите неизвестно где». Человек
    // должен понимать канал и то, что от него самого требуется.
    const where = el('div', hasTelegram() ? 'notice info' : 'notice');
    where.style.margin = '10px 0 0';
    where.innerHTML = hasTelegram()
      ? '<b>Куда придёт:</b> в Telegram, личным сообщением от бота центра.'
      : '<b>Куда придёт:</b> в Telegram, личным сообщением от бота центра. '
        + 'Нужен работающий Telegram и привязка в профиле — без неё сообщить будет некуда, '
        + 'и следить за освободившимся временем придётся самому.';
    body.appendChild(where);

    const acts = el('div', 'm-acts');
    const go = btn('Встать в очередь', 'btn', async () => {
      go.disabled = true;
      try {
        const res = await api('joinWaitlist', {
          date: state.date,
          start: minutesToTime(from),
          end: minutesToTime(to),
          durationMinutes: duration,
        });
        closeModal();
        await refreshMine();
        if (state.view === 'mine') renderMine();
        toast(res.duplicate ? 'Такое ожидание у вас уже есть' : 'Готово, вы в очереди', 3200);
      } catch (e) {
        go.disabled = false;
        toast(errorText(e.code), 3600);
      }
    });
    acts.appendChild(go);
    acts.appendChild(btn('Отмена', 'btn sec', closeModal));
    body.appendChild(acts);

    showModal(body);
  }

  draw();
}

// ============================================================
// Мои брони
// ============================================================

function renderMine() {
  const view = document.getElementById('viewMine');
  view.innerHTML = '';

  if (!state.mine) {
    view.innerHTML = '<div class="state">Загружаем…</div>';
    return;
  }

  const { upcoming, past, waitlist } = state.mine;

  // Абонемент показываем первым: человек, у которого оплачены часы,
  // приходит в кабинет прежде всего за этой цифрой.
  const pass = state.mine.pass;
  if (pass && pass.hours > 0) {
    const cp = el('div', 'card');
    cp.innerHTML = '<h2>Абонемент</h2>'
      + '<div class="item"><div class="t1">Осталось ' + escapeHtml(hoursText(pass.hours * 60)) + '</div>'
      + '<div class="t2">'
      + (pass.expiresAt
        ? 'Ближайшие часы сгорают ' + escapeHtml(dayLabelLong(pass.expiresAt, state.mine.today))
        : 'Без срока действия')
      + '. Часы списываются после игры — через двое суток, когда центр закроет день.</div></div>';

    // История — не «на всякий случай», а чтобы у человека не осталось
    // вопросов: он видит каждую игру и каждое списание, и спрашивать на
    // ресепшене «а куда делись часы» не приходится.
    const acts = el('div', 'acts');
    acts.appendChild(btn(state.passHistory ? 'Скрыть историю' : 'История списаний', 'btn sm sec',
      async () => {
        if (state.passHistory) { state.passHistory = null; renderMine(); return; }
        try {
          const res = await api('myPassHistory');
          state.passHistory = res.entries;
          renderMine();
        } catch (e) { toast('Не удалось загрузить историю'); }
      }));
    cp.appendChild(acts);

    if (state.passHistory) {
      if (!state.passHistory.length) {
        cp.appendChild(txt('div', 'empty', 'Пока ни одной операции.'));
      }
      const KIND = { purchase: 'куплен абонемент', spend: 'списано за игру', burn: 'часы сгорели' };
      state.passHistory.forEach(e => {
        const it = el('div', 'item');
        it.innerHTML = '<div class="t1">' + escapeHtml((KIND[e.kind] || e.kind) + ' · '
            + (e.hours > 0 ? '+' : '') + hoursText(e.hours * 60)) + '</div>'
          + '<div class="t2">' + escapeHtml(
            (e.date ? 'игра ' + dayLabelLong(e.date, state.mine.today) + ' · ' : '')
            + 'записано ' + e.at.slice(8, 10) + '.' + e.at.slice(5, 7) + '.' + e.at.slice(0, 4)
            + (e.note ? ' · ' + e.note : '')) + '</div>';
        cp.appendChild(it);
      });
    }

    view.appendChild(cp);
  }

  const c1 = el('div', 'card');
  c1.innerHTML = '<h2>Предстоящие</h2>';
  if (!upcoming.length) {
    c1.appendChild(txt('div', 'empty', 'Броней пока нет. Выберите время на вкладке «Бронирование».'));
  }
  upcoming.forEach(g => c1.appendChild(bookingItem(g, false)));
  view.appendChild(c1);

  // Записи в тренировках — не свои брони: корт занят клубом, а «отмена»
  // здесь означает снять себя из состава. Поэтому отдельной карточкой,
  // а не в общем списке предстоящих.
  const sessions = state.mine.openPlay || [];
  if (sessions.length) {
    const cs = el('div', 'card');
    cs.innerHTML = '<h2>Вы записаны на тренировки</h2>';
    sessions.forEach(s => {
      const op = rosterOf(s, myRoster(s));
      const inQueue = op.queue.some(p => p.mine);
      const it = el('div', 'item');
      it.innerHTML = '<div class="t1">' + escapeHtml(op.title)
        + (inQueue ? ' <span class="pill wait">в очереди</span>' : '')
        + '</div>'
        + '<div class="t2">' + escapeHtml(dayLabelLong(s.date, state.mine.today)
          + ' · ' + fmtRange(s.start, s.end) + ' · ' + op.level
          + ' · ' + op.taken + ' из ' + op.seats) + '</div>';
      const acts = el('div', 'acts');
      acts.appendChild(btn('Состав', 'btn sm sec', () => openSessionCard(s)));
      acts.appendChild(btn('Отказаться', 'btn sm sec', () => leaveSession(s)));
      it.appendChild(acts);
      cs.appendChild(it);
    });
    view.appendChild(cs);
  }

  if (waitlist && waitlist.length) {
    const c2 = el('div', 'card');
    c2.innerHTML = '<h2>Вы в очереди</h2>';
    waitlist.forEach(w => {
      const it = el('div', 'item');
      it.innerHTML = '<div class="t1">' + escapeHtml(hoursText(w.durationMinutes || 60))
        + ' в промежутке ' + escapeHtml(fmtRange(w.start, w.end)) + '</div>'
        + '<div class="t2">' + escapeHtml(dayLabelLong(w.date, state.mine.today))
        + ' · сообщим, как только освободится</div>';

      it.appendChild(hasTelegram()
        ? txt('div', 't2', '📩 Сообщение придёт в Telegram от бота центра')
        : txt('div', 't3', '⚠ Telegram не привязан — сообщать некуда. Привяжите его в профиле.'));

      const acts = el('div', 'acts');
      acts.appendChild(btn('Выйти из очереди', 'btn sm sec', async () => {
        try { await api('leaveWaitlist', { id: w.id }); await refreshMine(); renderMine(); toast('Вы вышли из очереди'); }
        catch (e) { toast(errorText(e.code)); }
      }));
      it.appendChild(acts);
      c2.appendChild(it);
    });
    view.appendChild(c2);
  }

  if (past && past.length) {
    const c3 = el('div', 'card');
    c3.innerHTML = '<h2>Прошедшие</h2>';
    past.slice(0, 10).forEach(g => c3.appendChild(bookingItem(g, true)));
    view.appendChild(c3);
  }
}

function bookingItem(g, isPast) {
  const it = el('div', 'item' + (isPast ? ' past' : ''));
  const courts = g.segments.map(s => {
    const c = state.config.courts.find(x => x.id === s.courtId);
    return c ? c.name : 'Корт';
  });

  let badge = '';
  // Занятие постоянной брони помечаем: человек должен видеть, что
  // отменяет одну неделю, а не всю серию.
  if (g.kind === 'series') badge = ' <span class="pill grey">↻ постоянная</span>';
  if (g.status === 'pending') badge = ' <span class="pill wait">ждёт подтверждения</span>';
  else if (g.status === 'expired') badge = ' <span class="pill grey">не подтверждена вовремя</span>';
  else if (g.status === 'noshow') badge = ' <span class="pill bad">не пришли</span>';
  else if (isPast) badge = ' <span class="pill grey">состоялась</span>';

  if (g.prepayRequired) badge += ' <span class="pill wait">нужна предоплата</span>';

  it.innerHTML = '<div class="t1">' + escapeHtml(fmtRange(g.start, g.end)) + badge + '</div>'
    + '<div class="t2">' + escapeHtml(dayLabelLong(g.date, state.mine.today))
    + ' · ' + escapeHtml([...new Set(courts)].join(' → '))
    + ' · ' + money(g.total != null ? g.total : g.price) + '</div>';

  if (g.kind === 'series') {
    // Занятие могли поправить на одну неделю — время выше уже новое, но
    // сказать об этом надо словами: человек помнит своё обычное.
    it.appendChild(txt('div', 't3', '↻ ' + g.title
      + (g.moved ? ' · на этот раз время другое, дальше как обычно'
        : ' · то же время каждую неделю')));
  }

  // Что взято на прокат — строкой под броней: человек должен помнить,
  // что ракетки ждут его на стойке, а не искать их в кармане.
  if (g.extras && g.extras.length) {
    it.appendChild(txt('div', 't3',
      '🎾 ' + g.extras.map(x => x.name + ' ×' + x.qty).join(', ')
      + ' · ' + money(g.extrasTotal)));
  }

  if (g.switches > 0) {
    const seg = g.segments[1];
    const court = state.config.courts.find(x => x.id === seg.courtId);
    it.appendChild(txt('div', 't3', '⇄ в ' + fmtTime(seg.start) + ' переход на ' + (court ? court.name : 'соседний корт')));
  }

  if (!isPast && g.status === 'expired') {
    // Отменять уже нечего: корт вернулся в общий доступ сам.
    it.appendChild(txt('div', 't3',
      'Администратор не ответил вовремя — время вернулось в общий доступ. Выберите заново, если оно ещё свободно.'));
  } else if (!isPast) {
    // Срок бесплатной отмены считает сервер и присылает готовым: кроме
    // дедлайна до игры в него входит окно «передумал сразу» от момента
    // самой брони, а его страница со своей стороны не знает.
    const deadline = Date.parse(g.freeCancelUntil || '');
    const late = Date.now() >= (Number.isFinite(deadline) ? deadline
      : slotTimestamp(g.date, g.start) - (state.mine.cancelDeadlineHours || 10) * 3600 * 1000);
    const acts = el('div', 'acts');
    // Поздняя отмена больше не запрещена — она стоит рейтинга. Кнопку
    // оставляем: запрет держал бы корт пустым, а так он успевает уйти
    // в лист ожидания. Но предупредить обязаны до нажатия.
    if (late) {
      acts.appendChild(txt('div', 't3',
        'Срок отмены без потери клиентского рейтинга прошёл. Отменить всё ещё можно, но рейтинг снизится.'));
    }
    // Перенос — не отмена: рейтинг он не трогает вовсе. Кнопка стоит
    // первой, потому что «сдвинуть на полчаса» люди хотят чаще, чем
    // отменить совсем, и раньше ради этого звонили администратору.
    if (g.movable) acts.appendChild(btn('Изменить время', 'btn sm', () => openMoveBooking(g)));
    acts.appendChild(btn(g.kind === 'series' ? 'Отменить занятие' : 'Отменить', 'btn sm sec',
      () => confirmCancel(g, late)));
    it.appendChild(acts);
  }

  return it;
}

// Перенос своей брони. Жестов здесь нет намеренно: в сетке легко задеть
// чужое время пальцем и увезти игру, а исправлять это будет
// администратор. Список времён — скучно и надёжно.
function openMoveBooking(g) {
  const cfg = state.config.booking;
  const minutes = timeToMinutes(g.end) - timeToMinutes(g.start);
  const need = minutes / cfg.slotStep;
  const leadMs = (cfg.moveLeadMinutes || 60) * 60000;

  // Своя же бронь не должна мешать себе при сдвиге на полчаса — иначе
  // соседнее время выглядит занятым ею самой.
  const grid = state.data.slots.map(slot =>
    state.config.courts.filter(c => {
      if (cellState(g.date, c.id, slot) === 'free') return true;
      const mine = myBookingAt(g.date, c.id, slot);
      return !!(mine && (mine.group.key === g.key || mine.group.id === g.id));
    }).map(c => c.id));

  const options = [];
  state.data.slots.forEach((slot, idx) => {
    if (idx + need - 1 >= state.data.slots.length) return;
    if (slotTimestamp(g.date, slot) < Date.now() + leadMs) return;
    if (slot === g.start) return;
    const plan = planBooking(g.date, grid, idx, idx + need - 1, { preferCourtId: g.segments[0].courtId });
    if (plan) options.push({ slot, plan });
  });

  const body = el('div');
  body.innerHTML = '<h3>Изменить время</h3>'
    + '<div class="m-sub">' + escapeHtml(dayLabelLong(g.date, state.mine.today)
      + ' · сейчас ' + fmtRange(g.start, g.end)) + '</div>';

  if (!options.length) {
    body.appendChild(txt('div', 'empty',
      'Свободного времени такой длины в этот день не осталось. На другой день — отмените бронь и запишитесь заново.'));
    const acts0 = el('div', 'm-acts');
    acts0.appendChild(btn('Закрыть', 'btn sec', closeModal));
    body.appendChild(acts0);
    showModal(body);
    return;
  }

  let picked = null;
  const opts = el('div', 'opts');
  options.forEach(o => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    const courts = o.plan.segments.map(s => {
      const c = state.config.courts.find(x => x.id === s.courtId);
      return c ? c.name : 'Корт';
    });
    b.innerHTML = '<span class="o-time">' + escapeHtml(fmtTime(o.slot)) + '</span>'
      + '<span class="o-court">' + escapeHtml([...new Set(courts)].join(' → ')) + '</span>';
    b.addEventListener('click', () => {
      picked = o;
      [...opts.children].forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      move.disabled = false;
    });
    opts.appendChild(b);
  });
  body.appendChild(opts);

  // Два предупреждения, которые человек должен прочитать до нажатия:
  // перенос ничего не стоит, но и не обнуляет дедлайн отмены.
  const note = el('div', 'notice info');
  note.innerHTML = '<b>Перенос не влияет на рейтинг.</b> Осталось переносов: '
    + (g.movesLeft != null ? g.movesLeft : cfg.maxMovesPerBooking)
    + '. Бесплатная отмена по-прежнему считается от первоначального времени'
    + (g.originalStart ? ' — ' + escapeHtml(fmtTime(g.originalStart)) : '') + '.';
  note.style.margin = '12px 0 0';
  body.appendChild(note);

  const acts = el('div', 'm-acts');
  const move = btn('Перенести', 'btn', async () => {
    if (!picked) return;
    move.disabled = true;
    move.textContent = 'Переносим…';
    try {
      await api('moveBooking', { date: g.date, bookingId: g.id, start: picked.slot });
      closeModal();
      await refreshAvailability();
      await refreshMine();
      renderDays(); renderGrid(); renderPicker(); renderMine();
      toast('Время изменено на ' + fmtTime(picked.slot), 3600);
    } catch (e) {
      move.disabled = false;
      move.textContent = 'Перенести';
      toast(errorText(e.code), 4000);
    }
  });
  move.disabled = true;
  acts.appendChild(move);
  acts.appendChild(btn('Отмена', 'btn sec', closeModal));
  body.appendChild(acts);

  showModal(body);
}

function confirmCancel(g, late) {
  const penalty = state.mine.lateCancelPenalty || 0.5;
  const series = g.kind === 'series';
  const body = el('div');
  body.innerHTML = '<h3>' + (series ? 'Отменить это занятие?' : 'Отменить бронь?') + '</h3>'
    + '<div class="m-sub">' + escapeHtml(dayLabelLong(g.date, state.mine.today) + ' · ' + fmtRange(g.start, g.end)) + '</div>'
    // Главное, что человек должен понять до нажатия: снимается одна
    // неделя, а не постоянное время целиком. Вернуть занятие обратно
    // сам он не сможет — время сразу уходит в общий доступ.
    + (series ? '<div class="empty cancel-note">Снимется только это занятие — '
      + 'остальные недели останутся за вами. Время сразу станет свободным для других, '
      + 'и вернуть его получится только через администратора.</div>' : '')
    + (g.switches > 0 ? '<div class="empty cancel-note">Бронь собрана из двух кортов — снимутся обе части.</div>' : '')
    // Цену поздней отмены называем прямо в окне подтверждения: узнать
    // о ней после нажатия — худший из возможных вариантов.
    + (late ? '<div class="empty cancel-note">До начала осталось меньше '
      + (state.mine.cancelDeadlineHours || 10) + ' ч, поэтому отмена снизит рейтинг на '
      + String(penalty).replace('.', ',') + '. Корт при этом сразу вернётся в общий доступ.</div>' : '');

  const acts = el('div', 'm-acts');
  acts.appendChild(btn(series ? 'Отменить занятие' : 'Отменить бронь', 'btn danger', async () => {
    try {
      const res = series
        ? await api('skipMySeries', { seriesId: g.seriesId, date: g.date })
        : await api('cancelBooking', { date: g.date, bookingId: g.id });
      closeModal();
      await refreshAvailability();
      await refreshMine();
      renderDays(); renderGrid(); renderPicker(); renderMine();
      toast(res && res.late
        ? (series ? 'Занятие снято, рейтинг снижен' : 'Бронь отменена, рейтинг снижен')
        : (series ? 'Занятие снято' : 'Бронь отменена'));
    } catch (e) { toast(errorText(e.code), 4000); }
  }));
  acts.appendChild(btn('Оставить', 'btn sec', closeModal));
  body.appendChild(acts);
  showModal(body);
}

// ============================================================
// Профиль
// ============================================================

// Мяч из фирменного знака — тот же путь, что в assets/favicon.svg, и
// перерисовывать его от руки нельзя: свой мяч отличался бы от логотипа.
// Цифра ложится поверх, обводка белым нужна ради швов: без неё «4,5»
// теряется на лаймовом.
const BALL_PATH = 'M181.045 0C184.394 0 187.502 1.0345 190.066 2.8013C190.322 2.97743 190.367 3.33292 190.179 3.58018C186.353 8.61986 185.52 13.8544 186.203 18.4514C186.789 22.3943 188.479 25.8112 190.222 28.2442C190.399 28.4919 190.351 28.8383 190.101 29.0118C187.53 30.7934 184.41 31.838 181.045 31.838C177.292 31.838 173.843 30.5382 171.121 28.3654C170.891 28.1816 170.86 27.8469 171.037 27.6114C174.8 22.6015 175.62 17.4053 174.941 12.8377C174.417 9.31011 173.009 6.20321 171.471 3.84523C171.313 3.60341 171.361 3.27922 171.593 3.10761C174.236 1.15434 177.506 0 181.045 0ZM193.253 6.81484C193.461 6.51846 193.895 6.51649 194.103 6.81325C195.906 9.39354 196.964 12.5325 196.964 15.919C196.964 19.2786 195.922 22.3941 194.145 24.9626C193.934 25.2677 193.488 25.2592 193.287 24.9472C192.079 23.0705 190.96 20.5869 190.546 17.806C190.052 14.481 190.55 10.6681 193.253 6.81484ZM167.61 7.37558C167.821 7.04389 168.3 7.06042 168.491 7.40429C169.441 9.11577 170.259 11.1989 170.598 13.4831C171.073 16.6767 170.631 20.32 168.2 24.0173C167.989 24.3383 167.522 24.329 167.327 23.9982C165.929 21.6298 165.126 18.8684 165.126 15.919C165.126 12.7752 166.037 9.84397 167.61 7.37558Z';

function ratingBall(value) {
  const label = ratingText(value);
  // Шаг рейтинга — сотые, поэтому в мяч приходит и «5», и «4,55». Размер
  // подбираем по длине: одним кеглем на все случаи либо мелко у целых,
  // либо четыре знака вылезают за швы.
  const size = label.length >= 4 ? 9 : (label.length >= 3 ? 11 : 13);
  return '<svg class="ball-rating" viewBox="165.126 0 31.838 31.838" role="img" aria-label="Рейтинг ' + label + '">'
    + '<path d="' + BALL_PATH + '" fill="var(--ball)"/>'
    + '<text x="181.045" y="16.4" text-anchor="middle" dominant-baseline="central"'
    + ' font-size="' + size + '" font-weight="700" fill="var(--ball-dk)"'
    + ' stroke="#fff" stroke-width="' + (size / 5) + '" paint-order="stroke">' + label + '</text>'
    + '</svg>';
}

function ratingText(value) {
  return String(value).replace('.', ',');
}

// Рейтинг в кабинете: цифра без объяснения пугает, поэтому рядом стоит
// то, из-за чего она меняется, и порог, ниже которого бронь идёт через
// администратора.
function ratingCard(value, locked) {
  const r = (state.config && state.config.rating) || {};
  // Режим предоплаты держится до полного возврата, а не до перехода
  // порога обратно: одна игра поднимает рейтинг на 0,05, и человек
  // должен понимать, что этого мало — иначе «я же сыграл» превращается
  // в разговор у стойки.
  const clearAt = r.prepayClearAt;
  const low = (r.prepayBelow != null && value <= r.prepayBelow)
    || (locked && clearAt != null && value < clearAt);

  const box = el('div', 'rating-box');
  box.innerHTML = ratingBall(value)
    + '<div class="rating-text"><div class="t1">Клиентский рейтинг</div>'
    + '<div class="t2">' + (low
      ? ratingText(r.prepayBelow) + ' и ниже — бронь подтверждает администратор.'
        + ' Он перезвонит, и за бронь потребуется предоплата.'
        + (clearAt != null
          // Порог пишем с десятыми: «до 4» читается как «до четвёрки с
          // чем-нибудь», а нужно ровно 4,0.
          ? ' Обычная запись вернётся, когда рейтинг поднимется до '
            + Number(clearAt).toFixed(1).replace('.', ',') + ': состоявшаяся игра даёт +'
            + ratingText(r.completed != null ? r.completed : 0.05) + '.'
          : '')
      : 'Состоявшаяся игра поднимает его, неявка и поздняя отмена — опускают.')
    + '</div></div>';
  if (low) box.classList.add('low');
  return box;
}

// Игровой уровень в кабинете. Слово «NTRP» здесь не пишем нигде: игроки
// знают эту аббревиатуру по чужим системам, где она значит не совсем то
// же самое, а уровень тут — свой, клубный.
//
// Дробное число стоит рядом с делением не для красоты. Без него турнир,
// который сдвинул человека внутри деления, выглядел бы как «уровень
// изменился, а цифра прежняя» — то есть как поломка.
function levelCard(client) {
  const box = el('div', 'item');
  const div = String(client.ntrp).replace('.', ',');
  const fine = client.level != null && client.level !== client.ntrp
    ? ' <span class="t2">· ' + String(client.level).replace('.', ',') + '</span>'
    : '';
  let inner = '<div class="t1">Игровой уровень: ' + div + fine + '</div>'
    // Приглашения спорить здесь нет намеренно. Уровень считается по
    // сыгранному, администратор к нему отношения не имеет и знать о нём
    // не обязан, а «не согласны — скажите» превращает в переговоры то,
    // что переговорами не решается: у половины игроков уровень всегда
    // ниже, чем им кажется. Кто отвечает за пересчёт — сказано, и этого
    // достаточно.
    + '<div class="t2">Меняется по итогам турниров центра: учитываются соперники, '
    + 'счёт и место. Пересчёт после каждого турнира утверждает организатор.</div>';

  // Дата записи в ленте — короткая: «12 окт». Год дописываем только для
  // прошлых сезонов, иначе строка растёт без пользы.
  const logDate = (iso) => {
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d)) return '';
    const now = new Date();
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]
      + (d.getUTCFullYear() === now.getUTCFullYear() ? '' : ' ' + d.getUTCFullYear());
  };

  const log = Array.isArray(client.levelLog) ? client.levelLog : [];
  log.slice(0, 5).forEach(e => {
    const when = e.at ? logDate(e.at) : '';
    if (e.by === 'owner') {
      inner += '<div class="t2">' + escapeHtml(when) + ' — уровень задан клубом: '
        + (e.ntrpTo == null ? '—' : String(e.ntrpTo).replace('.', ',')) + '</div>';
      return;
    }
    const moved = e.ntrpFrom !== e.ntrpTo
      ? String(e.ntrpFrom).replace('.', ',') + ' → ' + String(e.ntrpTo).replace('.', ',')
      : (e.delta > 0 ? '+' : '−') + String(Math.abs(e.delta).toFixed(2)).replace('.', ',');
    inner += '<div class="t2">' + escapeHtml(when) + ' · ' + escapeHtml(e.title || 'турнир')
      + ' — ' + moved + '</div>';
  });

  box.innerHTML = inner;
  return box;
}

function renderProfile() {
  const view = document.getElementById('viewProfile');
  view.innerHTML = '';
  const client = state.auth && state.auth.client;
  if (!client) { view.innerHTML = '<div class="state">Нужно войти.</div>'; return; }

  const c1 = el('div', 'card');
  c1.innerHTML = '<h2>Профиль</h2>';

  const statusPill = client.status === 'verified' ? '<span class="pill ok">проверенный клиент</span>'
    : client.status === 'pending' ? '<span class="pill wait">заявка на рассмотрении</span>'
    : '<span class="pill bad">доступ закрыт</span>';
  c1.appendChild(html('div', 'item', '<div class="t1">' + escapeHtml(client.name) + ' ' + statusPill + '</div>'
    + '<div class="t2">' + escapeHtml(client.phone) + '</div>'));

  if (client.rating != null) c1.appendChild(ratingCard(client.rating, client.prepayLock === true));

  if (client.ntrp != null) c1.appendChild(levelCard(client));

  // Сыгранные турниры клуба. Считаются только те, что прошли здесь и
  // через эту систему, — своя история, а не чужой рейтинг.
  if (client.tournamentsPlayed) {
    c1.appendChild(html('div', 'item',
      '<div class="t1">Сыграно турниров центра: ' + client.tournamentsPlayed + '</div>'
      + (client.tournamentsWon
        ? '<div class="t2">Побед: ' + client.tournamentsWon + '</div>'
        : '')));
  }

  const fName = el('label', 'field');
  fName.innerHTML = '<span>Имя и фамилия</span>';
  const inpName = document.createElement('input');
  inpName.value = client.name;
  fName.appendChild(inpName);
  c1.appendChild(fName);

  const saveName = btn('Сохранить имя', 'btn sm', async () => {
    try {
      const res = await api('updateProfile', { name: inpName.value });
      state.auth.client = res.client;
      renderHero(); renderProfile();
      toast('Имя сохранено');
    } catch (e) { toast(errorText(e.code)); }
  });
  c1.appendChild(saveName);
  view.appendChild(c1);

  const c2 = el('div', 'card');
  c2.innerHTML = '<h2>Пароль</h2>';

  // Текущий пароль — только у учётки, где он есть. Через Telegram
  // входят без пароля, и первую установку старым не загораживаем.
  // Сервер проверяет то же самое: страница лишь не показывает лишнее
  // поле.
  let inpCur = null;
  if (client.hasPassword) {
    const fCur = el('label', 'field');
    fCur.innerHTML = '<span>Текущий пароль</span>';
    inpCur = document.createElement('input');
    inpCur.type = 'password'; inpCur.placeholder = 'нужен для смены';
    inpCur.autocomplete = 'current-password';
    fCur.appendChild(withPasswordToggle(inpCur));
    c2.appendChild(fCur);
  }

  const fPass = el('label', 'field');
  fPass.innerHTML = '<span>Новый пароль</span>';
  const inpPass = document.createElement('input');
  inpPass.type = 'password'; inpPass.placeholder = 'не короче 6 символов';
  inpPass.autocomplete = 'new-password';
  fPass.appendChild(withPasswordToggle(inpPass));
  c2.appendChild(fPass);
  c2.appendChild(btn('Сменить пароль', 'btn sm', async () => {
    try {
      const res = await api('updateProfile', {
        password: inpPass.value,
        currentPassword: inpCur ? inpCur.value : undefined,
      });
      // Смена пароля отзывает старые токены — сервер сразу выдаёт новый,
      // иначе человек вылетел бы из собственной сессии.
      state.auth = { token: res.token, client: res.client };
      store.set(TOKEN_KEY, res.token);
      inpPass.value = '';
      if (inpCur) inpCur.value = '';
      toast('Пароль изменён');
    } catch (e) { toast(errorText(e.code)); }
  }));
  c2.appendChild(txt('div', 'empty', 'Забыли пароль — свяжитесь с администратором.'));
  view.appendChild(c2);

  const c3 = el('div', 'card');
  c3.innerHTML = '<h2>Telegram</h2>';

  if (hasTelegram()) {
    c3.appendChild(txt('div', 'notice info', 'Telegram привязан. Напоминания о брони придут сюда.'));
    c3.appendChild(btn('Отвязать', 'btn sec', async () => {
      try {
        await api('unlinkTelegram');
        const me = await api('me');
        state.auth.client = me.client;
        renderProfile(); renderNav();
        toast('Telegram отвязан');
      } catch (e) { toast(errorText(e.code)); }
    }));
  } else {
    c3.appendChild(txt('div', 'empty',
      'Единственный канал уведомлений. После привязки придут напоминания о брони за 12 часов '
      + 'и за два часа, решения администратора по заявкам и сообщения об освободившемся времени. '
      + 'Нужен работающий Telegram на телефоне.'));

    c3.appendChild(btn('Привязать Telegram', 'btn', async () => {
      try {
        const r = await api('linkTelegramStart');
        // Открываем в новой вкладке, а не подменяем текущую: иначе на
        // телефоне человек уходит в Telegram и теряет страницу вместе с
        // тем, что он на ней делал.
        window.open(r.url, '_blank');
        toast('Откройте бота и нажмите «Запустить»');
        // Возвращаемся на страницу — обновляем состояние: привязка
        // произойдёт на стороне бота, страница о ней сама не узнает.
        setTimeout(refreshMe, 4000);
      } catch (e) { toast(errorText(e.code)); }
    }));
  }
  view.appendChild(c3);

  const c4 = el('div', 'card');
  c4.appendChild(btn('Выйти', 'btn sec', () => logout(false)));
  view.appendChild(c4);
}

function txt(tag, cls, text) { const d = el(tag, cls); d.textContent = text; return d; }
function html(tag, cls, markup) { const d = el(tag, cls); d.innerHTML = markup; return d; }

// ---------- Модальные окна и тосты ----------

function showModal(node) {
  const m = document.getElementById('modal');
  m.innerHTML = ''; m.appendChild(node);
  document.getElementById('backdrop').classList.add('show');
}
function closeModal() { document.getElementById('backdrop').classList.remove('show'); }
document.getElementById('backdrop').addEventListener('click', e => { if (e.target.id === 'backdrop') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

let toastTimer = null;
function toast(text, ms) {
  const t = document.getElementById('toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2400);
}


// ---------- Старт ----------

load().catch(e => {
  console.error(e);
  document.getElementById('grid').innerHTML =
    '<div class="state">Не удалось загрузить сетку. Обновите страницу или попробуйте позже.</div>';
});
