# IP Camera Audio Bridge — расширение + native messaging host

Проигрывание в браузере аудиопотока со старых китайских IP-камер, которые шлют его
«HTTP/0.9-ответом» — сырым телом без статус-строки и заголовков.

Firefox прощает такие ответы (терпит HTTP/0.9 на нестандартных портах), но
Chromium-based браузеры дают `ERR_INVALID_HTTP_RESPONSE`: разбор ответа
происходит в network service **до** передачи в JavaScript, а raw TCP-сокеты
расширениям недоступны (API `chrome.sockets` существовал только в Chrome Apps).

Поэтому сокет к камере открывает крошечный **native messaging host** —
локальный процесс, который запускает сам браузер. Он не слушает никаких
сетевых портов и живёт ровно пока открыто соединение расширения.

## Архитектура

```
popup / options            service worker (MV3)              native host                  камера
┌───────────────┐  msg    ┌────────────────────────┐  stdio ┌──────────────────┐  TCP   ┌────────┐
│ Старт/Стоп,   │────────▶│ background.js          │───────▶│ camera_audio_    │───────▶│ raw    │
│ громкость,    │◀────────│ connectNative() +      │◀───────│ host.py          │◀───────│ аудио  │
│ статистика    │  stats  │ codec.js (декодер)     │ base64 └──────────────────┘  байты └────────┘
└───────────────┘         └───────────┬────────────┘
                                      │ PCM 8 кГц
                          ┌───────────▼────────────┐
                          │ offscreen.js           │  AudioContext (в service worker
                          │ планировщик + громкость │  MV3 Web Audio недоступен)
                          └────────────────────────┘
```

- Хост шлёт аудио сообщениями `{"audio": "<base64>"}` по 64 КБ.
- Если камера всё же вернула HTTP-заголовки — один раз придёт `{"meta": "..."}`.
- Завершение потока — `{"eof": true}`, ошибка — `{"error": "..."}`.
- Входящие сообщения держат service worker живым (сбрасывают idle-таймер MV3).
- background.js нарезает поток на пакеты Kaicong (544 байта: 32-байтный заголовок
  + 512 байт IMA ADPCM) и декодирует в PCM 16 бит / 8 кГц / моно — побитово
  как `audioop.adpcm2lin` из Python. Звук играет offscreen-документ
  (`chrome.offscreen`, Chrome 109+).
- Если декодированный звук искажён, попробуйте в background.js флаг
  `swapNibbles` (порядок нибблов ADPCM у прошивок бывает разный).

## Структура проекта

```
camera-audio-extension/
├── README.md
├── extension/                  # расширение (MV3)
│   ├── manifest.json
│   ├── background.js           # connectNative + фреймер + декодер
│   ├── codec.js                # KaicongStream (544/32) + IMA ADPCM → PCM16
│   ├── offscreen.html/.js      # плеер: AudioContext, планировщик, громкость
│   ├── popup.html / popup.js   # Старт/Стоп, громкость, статистика
│   ├── options.html / options.js  # host/port/path + Basic-аутентификация
│   └── icons/
├── host/
│   ├── camera_audio_host.py    # native messaging host
│   ├── run_host.bat            # обёртка для Windows
│   ├── test_host.py            # проверка хоста без браузера
│   ├── fake_camera.py          # имитация камеры: raw-режим и режим Kaicong ADPCM
│   ├── install-linux.sh / uninstall-linux.sh
│   └── install-windows.bat / install-windows.ps1
│       uninstall-windows.bat / uninstall-windows.ps1
└── pack/
    ├── pack.py / pack.sh / pack.ps1   # zip для Web Store + стабильный ID
    └── key.pem (создаётся pack-скриптом, опционально)
```

## Требования

- Python 3.7+ (Linux: `python3`; Windows: `python` в PATH или лаунчер `py`)
- Google Chrome / Chromium / Microsoft Edge
- Linux или Windows

## Установка — Linux

1. `chrome://extensions` → включите «Режим разработчика» → «Загрузить распакованное»
   → выберите папку `extension/`.
2. Скопируйте **ID расширения** (32 символа из диапазона a–p).
3. `cd host && ./install-linux.sh <ID>` — пропишет хост для Chrome, Chromium и Edge сразу.
4. Откройте popup расширения → «Настройки камеры» → введите host/port/path → «Сохранить».
5. Нажмите «Старт» в popup.

## Установка — Windows

1. Так же загрузите расширение и скопируйте ID.
2. `cd host && install-windows.bat <ID>` (правый клик → «Выполнить в PowerShell» тоже работает).
3. Настройки камеры → адрес потока → Сохранить → Старт.

> Если команда `python` открывает Microsoft Store — отключите псевдонимы в
> «Параметры → Приложения → Дополнительные параметры → Псевдонимы выполнения
> приложений» либо поставьте Python с python.org (лаунчер `py` подхватится сам).

## Проверка без браузера (быстрый тест всей цепочки)

```bash
# терминал 1: фейковая камера в режиме Kaicong (HTTP-заголовки + ADPCM 544/32)
python3 host/fake_camera.py 8099 --kaicong        # синус 440 Гц, бесконечно

# терминал 2: хост
python3 host/test_host.py 127.0.0.1 8099 /audiostream.cgi
# ожидайте: "чанк #1: ..." и рост счётчика
```

Без `--kaicong` камера шлёт сырые байты без заголовков (как HTTP/0.9).

## Настройка на камеру Kaicong и прослушивание

1. Настройки камеры: host — IP камеры; порт — `81`; путь —
   `/audiostream.cgi?user=admin&pwd=ВАШ_ПАРОЛЬ&streamid=2&filename=`
   (Kaicong ждёт логин/пароль в query-параметрах, поле Basic-аутентификации
   оставьте пустым).
2. «Сохранить» → «Старт» — popup покажет счётчики пакетов и секунд,
   звук пойдёт автоматически (громкость — слайдер в popup).
3. Декодер настроен на профиль Kaicong: пакет 544 байта, заголовок 32,
   IMA ADPCM → PCM 16 бит, 8000 Гц, моно, состояние ADPCM сбрасывается
   на каждом пакете — ровно как в Python-классе `KaicongAudio`.
4. Диагностика: `chrome://extensions` → «service worker» → Console:
   там видно заголовки камеры (`[camera]`), hex заголовка первого пакета
   (`[codec]`) и статистику чанков (`[audio]`).

Минимальная версия браузера — 109 (chrome.offscreen). В service worker MV3
нет Web Audio, поэтому воспроизведение вынесено в offscreen-документ.

## Упаковка и стабильный ID

- `pack/pack.sh` (Linux/macOS) или `pack/pack.ps1` (Windows) собирают zip
  папки `extension/` для загрузки в Chrome Web Store (manifest в корне архива).
- ID у распакованного расширения зависит от абсолютного пути папки. Для
  одинакового ID на всех машинах: `pack/pack.sh` создаёт `key.pem` и печатает
  ID, вычисленный из ключа (то, что сделала бы сама Chrome); CRX собирается
  командой
  `chrome --pack-extension=extension --pack-extension-key=pack/key.pem`.
  Именно этот ID указывайте в `install-*.sh|ps1 <ID>`.

## Удаление

- Linux: `host/uninstall-linux.sh`
- Windows: `host\uninstall-windows.bat` (убирает ветки реестра и файлы хоста)

## Устранение неполадок

| Симптом | Причина | Решение |
|---|---|---|
| «Specified native messaging host not found» | нет регистрации для этого браузера | переустановите install-скриптом; проверьте имя `com.camera.audio` |
| «Access to the specified native messaging host is forbidden» | ID не совпадает с `allowed_origins` | укажите верный ID из `chrome://extensions` |
| «Native host has exited» при старте | python не найден / ошибка в хосте | выполните `python3 host/test_host.py …` — увидите ошибку |
| Ошибка «Не удалось подключиться» в popup | камера недоступна / порт / firewall | проверьте доступность хоста и порта, путь в настройках |
| Windows: python открывает Store | псевдоним-заглушка | отключите App Execution Aliases, используйте `py -3` |
| «Невозможно удалить дерево подраздела» при установке на Windows | баг PowerShell 5.1: `New-Item -Force` падает, если цепочка промежуточных ключей реестра ещё не существует | используйте исправленный `install-windows.ps1` (регистрация через `reg add`); либо вручную: `reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.camera.audio" /ve /t REG_SZ /d "%LOCALAPPDATA%\CameraAudioHost\com.camera.audio.json" /f` (повторите для `Chromium` и `Microsoft\Edge`) |
| Звук не играет, но счётчики растут | громкость 0 / AudioContext приостановлен / браузер < 109 | поднимите громкость в popup; нажмите Стоп и Старт; проверьте версию браузера |
| Звук есть, но сплошной шум | камера кладёт нибблы ADPCM в другом порядке | в `background.js`: `new KaicongCodec.KaicongStream({swapNibbles: true})` |
| Звук с разрывами | нестабильная сеть / Wi-Fi, недогрузки растут в popup | улучшите канал; при постоянных разрывах увеличьте LEAD_SEC в offscreen.js |
| Поток идёт, но в консоли нет `[audio]` | камера прислала HTTP-заголовки | они придут сообщением `{"meta": ...}` — это нормально, дальше пойдут байты |
