const $ = (id) => document.getElementById(id);

function render(s) {
  $('dot').className = 'dot' + (s.error ? ' err' : (s.running ? ' on' : ''));
  $('status').textContent = s.error ? 'Ошибка' : (s.running ? 'Играю поток камеры…' : 'Остановлено');
  $('start').disabled = s.running;
  $('stop').disabled = !s.running;
  $('chunks').textContent = s.chunks || 0;
  $('bytes').textContent = s.bytes || 0;
  $('packets').textContent = s.packets || 0;
  $('psec').textContent = (s.pcmSec || 0).toFixed(1);
  $('buf').textContent = (s.bufferedSec || 0).toFixed(1);
  $('und').textContent = (s.underruns || 0) + (s.dropped ? '/' + s.dropped : '');

  // Состояние звукового движка offscreen-документа
  const a = s.audio;
  let atext = '—';
  if (s.running && a && a.state && a.state !== 'none') {
    atext = (a.state === 'running' ? 'идёт' : a.state)
          + ' · ' + Math.round(100 * (a.gain == null ? 1 : a.gain)) + '%';
  } else if (s.running) {
    atext = 'плеер не отвечает';
  }
  $('audio').textContent = atext;

  const sec = s.startedAt ? (s.lastChunkAt || Date.now()) - s.startedAt : 0;
  $('rate').textContent = sec > 0 ? Math.round(s.bytes / sec / 1024) : 0;

  const err = $('error');
  if (s.error) { err.textContent = s.error; err.hidden = false; } else { err.hidden = true; }

  // Живая подсказка по типовой проблеме «поток идёт, звука нет»
  let hint = '';
  if (s.running && !s.error) {
    const state = a && a.state;
    if (state === 'suspended') {
      hint = 'Звуковой движок заблокирован (suspended). Нажмите Стоп → Старт; '
           + 'если не поможет — обновите браузер.';
    } else if (a && a.gain === 0) {
      hint = 'Громкость плеера 0% — поднимите ползунок громкости.';
    } else if (s.packets > 8 && state === undefined && !(s.bufferedSec > 0)) {
      hint = 'Плеер не получает пакеты. Нажмите Стоп → Старт.';
    } else if ((s.underruns || 0) > 0 && !(s.bufferedSec > 0) && state === 'running') {
      hint = 'Звуковой движок работает, но данные приходят рывками — '
           + 'проверьте сеть/камеру. Если тихо: системный миксер Windows.';
    }
  }
  const h = $('hint');
  if (hint) { h.textContent = hint; h.hidden = false; } else { h.hidden = true; }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ cmd: 'status' });
  if (res) render(res.stats);
}

 $('start').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ cmd: 'start' });
  if (res && res.error) render(res.stats); else refresh();
});
 $('stop').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'stop' }).then(refresh));
 $('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

// громкость: живое применение + сохранение
const vol = $('vol');
chrome.storage.local.get(['volume']).then(({ volume }) => {
  const v = Math.round(100 * (Number.isFinite(Number(volume)) ? Number(volume) : 1));
  vol.value = v;
  $('volv').textContent = v;
});
vol.addEventListener('input', () => {
  const v = Number(vol.value);
  $('volv').textContent = v;
  chrome.storage.local.set({ volume: v / 100 });
  chrome.runtime.sendMessage({ cmd: 'volume', value: v / 100 });
});

refresh();
setInterval(refresh, 500);