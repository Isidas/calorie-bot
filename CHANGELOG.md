# Changelog — Calorie Bot

Подробное описание реализованной функциональности и всех изменений.

---

## История изменений

### Рефакторинг: Gemini + USDA (без OpenAI)

- **Удалено:** зависимость от OpenAI, `src/ai/openai-provider.ts`, переменные `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS`.
- **Добавлено:**
  - **Vision:** провайдер на базе Google Gemini (`@google/generative-ai`): по фото возвращает блюдо, порцию и список поисковых запросов (candidates). Калории и БЖУ в ответе vision не считаются.
  - **Nutrition:** слой работы с USDA FoodData Central: поиск по запросу (POST foods/search), получение деталей продукта (GET food/{fdcId}), извлечение нутриентов на 100 г и пересчёт на порцию. При отсутствии совпадения в БД — опциональный fallback: запрос к Gemini с просьбой оценить БЖУ по названию и порции (confidence=low, в assumptions явно указано «оценка, совпадения в базе нет»).
- **Типы:** введён промежуточный тип `DishVision` (результат vision без калорий); `DishAnalysis` остаётся финальным ответом боту. Интерфейс провайдера переименован в `IVisionProvider`, добавлен опциональный метод `estimateNutrition` для fallback.
- **Конфигурация:** обязательные ключи `GEMINI_API_KEY`, `USDA_API_KEY`; опционально `GEMINI_MODEL`, `HTTP_TIMEOUT_MS`. README и `.env.example` обновлены под получение ключей Gemini и USDA.

### Ранее (до рефакторинга)

- Обработка фото: скачивание по прямой ссылке Telegram в буфер (без передачи file_id во внешние API), retry при сетевых ошибках (ECONNRESET и т.п.), глобальный `bot.catch` и обёртка хендлера в try/catch, чтобы не было «Unhandled error».
- Сообщения пользователю при ошибках: отдельные формулировки для rate limit, для ошибок распознавания и для «сервис недоступен»; позже добавлены формулировки для USDA («не смог найти в базе») и для ошибок vision («не удалось распознать блюдо»).

---

## 1. Обзор проекта (текущее состояние)

**Цель:** MVP Telegram-бота: пользователь отправляет фото блюда → бот возвращает оценку калорийности, БЖУ и размер порции. Распознавание блюда и порции — через **Gemini Vision**; калории и БЖУ — по базе **USDA FoodData Central** (при отсутствии совпадения — опциональная оценка от Gemini).

**Стек:** Node.js, TypeScript, Telegraf, `@google/generative-ai` (Gemini), USDA FDC API. БД в MVP нет; история — заглушка в памяти.

**Архитектура:** три слоя — `bot/` (Telegram), `ai/` (vision-провайдер Gemini), `services/` (DishService, nutrition: USDA client + nutrition-service, rate limit, история). Контракты задаются типами в `types.ts` и интерфейсом `IVisionProvider`.

---

## 2. Поток данных (как это работает по шагам)

1. Пользователь отправляет фото в чат с ботом.
2. **bot/handlers.ts:** хендлер `onPhoto`. Берётся фото максимального размера, показывается «Анализирую…».
3. **bot/index.ts:** `getFileBuffer(fileId)` — Telegraf `getFile` → прямая ссылка на файл → скачивание через `fetch` с таймаутом 15 сек → `Buffer`.
4. **services/dish-service.ts:** `analyzeFromImage(imageBuffer, userId)`:
   - проверка rate limit (1 раз в 10 сек на пользователя);
   - вызов **vision.analyzeDishFromImage(imageBuffer)** → **DishVision** (is_food, dish, portion_grams, candidates, confidence);
   - если `!is_food` — формируется минимальный **DishAnalysis** и возврат;
   - иначе вызов **nutrition.getNutrition(dish, candidates, portion_grams, confidence)**:
     - USDA: поиск по dish и по элементам candidates, для первого подходящего результата — детали, нутриенты на 100 г, пересчёт на порцию, calories_range ±10%;
     - при отсутствии совпадения и наличии **vision.estimateNutrition** — один текстовый запрос к Gemini за оценкой БЖУ, confidence=low, в assumptions — «оценка, совпадения в базе нет»;
     - иначе — `throw new Error('USDA_NO_MATCH')`;
   - из **DishVision** и результата nutrition собирается **DishAnalysis**, сохраняется в историю (без изображений), возврат в хендлер.
5. **bot/handlers.ts:** по **DishAnalysis** формируется текст (диапазон калорий, БЖУ, вес, 1–3 assumptions, дисклеймер), сообщение «Анализирую…» редактируется на результат. Ошибки: rate limit, USDA, vision, сеть — отдельные сообщения пользователю.

---

## 3. Решения по модулям

### 3.1. Типы (`src/types.ts`)

**Что сделано:**
- **CaloriesRange:** `{ min, max }` для отображения диапазона ккал.
- **DishVision** (результат vision, без калорий): `is_food`, `dish`, `portion_grams`, `candidates: string[]`, `confidence`. Нужен для разделения «распознавание» и «расчёт нутриентов».
- **DishAnalysis** (финальный ответ боту): `is_food`, `dish`, `weight_grams`, `calories`, `protein`, `fat`, `carbs`, `calories_range`, `confidence`, `assumptions`. Собирается из DishVision и NutritionResult.
- **IVisionProvider:** `analyzeDishFromImage(imageBuffer: Buffer): Promise<DishVision>`; опционально `estimateNutrition?(dish, portionGrams): Promise<EstimatedMacros>` для fallback при отсутствии совпадения в USDA.
- **EstimatedMacros:** `calories`, `protein`, `fat`, `carbs` — ответ Gemini при оценке БЖУ по названию и порции.

**Зачем так:** Чёткое разделение: vision только распознаёт блюдо и порцию; калории/БЖУ считаются по базе (или fallback), что улучшает точность и позволяет менять источник нутриентов без смены vision.

---

### 3.2. Обработка фото в боте (`src/bot/index.ts`)

**Что сделано:**
- Цепочка: `file_id` → Telegraf `getFile` → `file_path` → прямая ссылка → `fetch` с таймаутом 15 сек → `Buffer`. Внешним API передаётся только буфер, file_id не используется.
- Выбор фото максимального размера: `photo[photo.length - 1]`.
- Повтор запросов к Telegram при сетевых ошибках (ECONNRESET и т.п.) через `withTelegramRetry` в хендлере и при скачивании/получении file.
- **bot.catch:** глобальный обработчик ошибок; при необработанном исключении — попытка отправить пользователю «Произошла ошибка. Попробуйте ещё раз…» (тоже с retry).

**Как работает:** Хендлер вызывает `getFileBuffer(fileId)` → буфер передаётся в DishService. Ссылка на файл Telegram используется только для скачивания на нашу сторону.

---

### 3.3. Gemini-провайдер (`src/ai/gemini-provider.ts`)

**Что сделано:**
- Класс **GeminiProvider** реализует **IVisionProvider**. SDK: `@google/generative-ai`, модель задаётся в конструкторе (по умолчанию в index — `gemini-2.5-flash`).
- **analyzeDishFromImage(imageBuffer):** буфер → base64, вызов `model.generateContent([{ text: prompt }, { inlineData: { data: base64, mimeType: 'image/jpeg' } }])`. В промпте запрашивается **строгий JSON** без markdown: `is_food`, `dish`, `portion_grams`, `candidates` (2–5 поисковых запросов на английском для базы), `confidence`. Из ответа извлекается подстрока от первой `{` до последней `}` (`extractJson`), парсинг и валидация. При ошибке парсинга — один retry с усиленной инструкцией «RETURN ONLY JSON...».
- **estimateNutrition(dish, portionGrams):** один текстовый запрос к Gemini с просьбой оценить калории и БЖУ на порцию; ответ — только JSON `{calories, protein, fat, carbs}`. Используется в nutrition-service при отсутствии совпадения в USDA.
- Таймаут: обёртка `withTimeout(promise, timeoutMs)` (по умолчанию 30 000 мс).

**Зачем так:** Единый провайдер и для vision, и для fallback-оценки; строгий JSON и retry повышают устойчивость к «разговорному» ответу модели.

---

### 3.4. USDA-клиент (`src/services/nutrition/usda-client.ts`)

**Что сделано:**
- **UsdaClient(apiKey, timeoutMs):** все запросы к USDA FDC выполняются с таймаутом через `AbortController`.
- **searchFoods(query):** POST `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=...`, body `{ query, pageSize: 10 }`. Ответ парсится, возвращается массив `{ fdcId, description }`.
- **getFoodDetails(fdcId):** GET `https://api.nal.usda.gov/fdc/v1/food/{fdcId}?api_key=...`. Из `foodNutrients` извлекаются нутриенты по стандартным id FDC: 1008 (Energy, ккал), 1003 (Protein), 1004 (Total fat), 1005 (Carbohydrates). Возвращается объект с `description` и **NutrientsPer100g** (calories, protein, fat, carbs на 100 г).

**Как работает:** Nutrition-service по очереди вызывает search по dish и candidates; для первого подходящего результата запрашивает детали и пересчитывает нутриенты на порцию (portion_grams/100 * per100g).

---

### 3.5. Nutrition-service (`src/services/nutrition/nutrition-service.ts`)

**Что сделано:**
- **NutritionService(usda, visionProvider):** visionProvider опционально (для fallback).
- **getNutrition(dishName, candidates, portionGrams, visionConfidence):** последовательный поиск в USDA по dishName и по элементам candidates (до нескольких запросов search + getFoodDetails). Для первого продукта с ненулевыми нутриентами — пересчёт на порцию, **calories_range** как ±10% от калорий, confidence берётся из vision. Если совпадений нет и передан **visionProvider.estimateNutrition** — вызов `estimateNutrition(dishName, portionGrams)`, в assumptions добавляется «Оценка по описанию блюда, совпадения в базе USDA нет», confidence=low. Если fallback не задан или выбросил ошибку — `throw new Error('USDA_NO_MATCH')`.
- **NutritionResult:** calories, protein, fat, carbs, calories_range, confidence, assumptions, fromDb (true при совпадении в USDA).

**Зачем так:** Максимально используем официальную базу USDA для точности; fallback от Gemini даёт хоть какую-то оценку при редких/сложных блюдах и явно помечается как низкая уверенность.

---

### 3.6. DishService (`src/services/dish-service.ts`)

**Что сделано:**
- Конструктор: **DishService(vision: IVisionProvider, nutrition: NutritionService)**. Один вызов vision, затем nutrition — калории не считаются в vision.
- **analyzeFromImage(imageBuffer, userId):** проверка rate limit → **vision.analyzeDishFromImage(buffer)** → при `!vision.is_food` возврат минимального DishAnalysis (нулевые калории, одна assumption); иначе **nutrition.getNutrition(vision.dish, vision.candidates, vision.portion_grams, vision.confidence)** → сборка **DishAnalysis** (weight_grams из vision.portion_grams, остальное из NutritionResult) → **saveToHistory(userId, analysis)** → возврат. История по-прежнему только результаты анализа, без изображений.
- **RateLimitError** и интервал 10 сек без изменений.

**Как работает:** Сервис оркестрирует только vision и nutrition; источник калорий/БЖУ — всегда nutrition (USDA или Gemini fallback).

---

### 3.7. История (`src/services/history.ts`)

**Без изменений:** массив в памяти, элементы `{ userId, analysis, at }`, только объект DishAnalysis. Изображения не сохраняются.

---

### 3.8. Rate limit (`src/services/rate-limit.ts`)

**Без изменений:** 1 запрос в 10 сек на пользователя (in-memory Map), `checkRateLimit` / `getRemainingSeconds`, при превышении — RateLimitError с remainingSeconds.

---

### 3.9. Хендлеры бота (`src/bot/handlers.ts`)

**Что сделано:**
- **/start:** приветствие и описание (без изменений логики).
- **Фото:** получение буфера через `getFileBuffer`, вызов `dishService.analyzeFromImage`, редактирование «Анализирую…» на результат или на сообщение об ошибке. Все вызовы к Telegram обёрнуты в **withTelegramRetry**. Внешний try/catch по всему телу хендлера — чтобы ни одна ошибка не уходила в «Unhandled».
- **Формат ответа (formatResult):** при `!is_food` — «На фото не распознано блюдо…». Иначе: название блюда, вес порции, диапазон калорий (min–max или одно число), БЖУ, блок «Предположения» (1–3 пункта из assumptions), комментарий по confidence, дисклеймер.
- **Обработка ошибок:**
  - **RateLimitError** → «Подождите N сек. перед следующим запросом».
  - Текст ошибки содержит USDA_NO_MATCH / USDA / «search failed» / «food details failed» / «базе» → «Не смог найти блюдо в базе. Попробуйте другое фото или угол.»
  - Текст содержит «Invalid JSON» / «No JSON» / «vision» / «Empty» → «Не удалось распознать блюдо. Попробуйте другое фото.»
  - Остальное → «Сервис временно недоступен. Попробуйте позже.»

---

### 3.10. Точка входа (`src/index.ts`)

**Что сделано:**
- Загрузка `dotenv`. Проверка обязательных переменных: **TELEGRAM_BOT_TOKEN**, **GEMINI_API_KEY**, **USDA_API_KEY**; при отсутствии — вывод в stderr и `process.exit(1)`.
- Опционально: **GEMINI_MODEL** (по умолчанию `gemini-2.5-flash`), **HTTP_TIMEOUT_MS** (по умолчанию 30 000). Таймаут используется и для Gemini, и для USDA.
- Создание: **createVisionProvider(geminiKey, geminiModel, httpTimeoutMs)** → **UsdaClient(usdaKey, httpTimeoutMs)** → **NutritionService(usda, vision)** → **DishService(vision, nutrition)** → **createBot(token, dishService)**. Запуск бота, обработка SIGINT/SIGTERM.

---

## 4. Конфигурация и окружение

- **.env.example:** TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, GEMINI_MODEL, USDA_API_KEY, HTTP_TIMEOUT_MS (все с комментариями). Секреты только из переменных окружения.
- **README:** как получить TELEGRAM_BOT_TOKEN (BotFather), GEMINI_API_KEY (Google AI Studio / ai.google.dev), USDA_API_KEY (FDC api-key signup / data.gov); как запустить; пример ответа; Troubleshooting (бот не отвечает, не распознал блюдо, не нашёл в базе, ошибки USDA/Gemini, rate limit).

---

## 5. Итог по решениям

| Вопрос | Решение |
|--------|--------|
| Источник калорий/БЖУ | USDA FoodData Central (поиск по dish + candidates, нутриенты на 100 г → пересчёт на порцию). При отсутствии совпадения — опциональная оценка от Gemini (confidence=low). |
| Распознавание блюда и порции | Gemini Vision (analyzeDishFromImage): строгий JSON (is_food, dish, portion_grams, candidates, confidence), извлечение JSON + 1 retry при ошибке парсинга. |
| Передача фото | Скачивание по прямой ссылке Telegram в буфер; в API передаётся только base64, file_id не используется. |
| Таймауты | 15 сек на скачивание фото; HTTP_TIMEOUT_MS (30 сек по умолчанию) на запросы к Gemini и USDA. |
| Ограничение запросов | Rate limit 1 запрос / 10 сек на пользователя (in-memory Map). |
| Что храним в истории | Только DishAnalysis; изображения не сохраняем. |
| Что показываем пользователю | Диапазон калорий, БЖУ, вес порции, 1–3 assumptions, комментарий о точности, дисклеймер. Отдельные сообщения при ошибках USDA и при ошибках распознавания. |
| Расширяемость | IVisionProvider и слой nutrition позволяют заменить модель vision или источник нутриентов без смены бота и DishService. |

Файл можно использовать как описание «что сделано и как это работает» при ревью или доработке проекта.

---

## Production Readiness Audit

*Аудит перед деплоем на VPS (Docker + long polling).*

### Текущая архитектура

- **Слои:** `bot/` (Telegraf, хендлеры, скачивание фото, retry), `ai/` (IVisionProvider → GeminiProvider), `services/` (DishService, NutritionService, UsdaClient, rate-limit, history), `http-agent` (undici keep-alive для Telegram и USDA).
- **Зависимости:** Нет циклических импортов. Поток: `index` → ai, services, bot; `bot` → handlers, types, telegram-retry, http-agent; `handlers` → services (RateLimitError), types; `DishService` → IVisionProvider, NutritionService, history, rate-limit; `NutritionService` → UsdaClient, IVisionProvider (опционально); `UsdaClient` → http-agent.
- **Оркестрация:** DishService — единственная точка оркестрации: rate limit → vision.analyzeDishFromImage → при is_food → nutrition.getNutrition → сборка DishAnalysis → saveToHistory. Vision не считает калории; нутриенты только из NutritionService (USDA или Gemini fallback).
- **IVisionProvider:** Используется корректно: тип в `types.ts`, реализация GeminiProvider в `ai/gemini-provider.ts`, фабрика `createVisionProvider` в `ai/index.ts`. Опциональные методы `estimateNutrition` и `translateToRussian` проверяются через `?.` в NutritionService.

### Используемые сервисы

- **Telegram Bot API:** long polling (по умолчанию в Telegraf), скачивание файлов по прямой ссылке с retry и таймаутом 25 с.
- **Google Gemini:** Vision (анализ фото → JSON: dish, portion_grams, candidates, confidence), при fallback — текстовая оценка БЖУ. Таймаут из `HTTP_TIMEOUT_MS`.
- **USDA FoodData Central:** поиск (POST foods/search), детали продукта (GET food/{id}), нутриенты на 100 г, пересчёт на порцию.

### Обработка ошибок

- **Async-цепочки:** В хендлере фото — внешний try/catch по всему телу, внутренние try/catch для отправки «Анализирую…», для getFileBuffer + analyzeFromImage + editMessageText, и для отправки сообщения об ошибке пользователю. bot.catch обрабатывает необработанные ошибки и отправляет «Произошла ошибка…» с retry.
- **Промисы:** Вызовы к Telegram обёрнуты в withTelegramRetry; в bot.catch и при fallback reply используется .catch(() => {}). Запуск бота: `bot.launch().then(() => console.log('Bot started'))` — при отклонении launch промис не обработан (см. Findings).
- **Сообщения пользователю:** RateLimitError, USDA/база, регион Gemini, 429/quota, AbortError/загрузка фото, Invalid JSON/vision/Empty, прочее — отдельные формулировки в handlers.
- **Логирование:** Ошибки в хендлере и в bot.catch логируются через console.error с префиксом `[Calorie Bot]`. Gemini: логируются `{ status, code }` без тела ответа и без ключей.

### Конфигурация

- **Переменные окружения:** TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, USDA_API_KEY — обязательные; при отсутствии любой из них — console.error и process.exit(1). Опциональные: GEMINI_MODEL (по умолчанию gemini-2.5-flash), HTTP_TIMEOUT_MS (30000), ENABLE_GEMINI_FALLBACK (false).
- **Загрузка:** Через `import 'dotenv/config'` в index.ts; значения только из process.env, ключи не хардкодятся в коде.

### Docker-готовность

- **Dockerfile:** Multi-stage (node:20-alpine): сборка — npm ci || npm install, tsc → dist; runtime — только package.json + dist, npm ci --omit=dev || npm install --omit=dev, CMD `node dist/index.js`. Dev-зависимости (typescript, ts-node, @types/node) не попадают в финальный образ.
- **docker-compose.yml:** Сервис bot, build: ., env_file: .env, restart: unless-stopped. Entrypoint по умолчанию — CMD из Dockerfile.
- **NODE_ENV:** В Docker не задаётся (см. Findings).

### Устойчивость

- **Retry Telegram:** withTelegramRetry с экспоненциальными задержками 300 / 900 / 1800 мс + jitter; повтор только при сетевых ошибках (ECONNRESET и др.) и 5xx/429. Используется для getFile, скачивания файла, отправки/редактирования сообщений.
- **Retry Gemini JSON:** В GeminiProvider при невалидном JSON от vision — один повтор запроса с усиленной инструкцией «RETURN ONLY JSON».
- **Таймауты:** Скачивание фото — 25 с (AbortController); Gemini и USDA — HTTP_TIMEOUT_MS (AbortController в UsdaClient, withTimeout в GeminiProvider).
- **Rate limit:** 1 запрос в 10 с на пользователя (in-memory Map), RateLimitError с remainingSeconds.

### Безопасность

- Ключи только из process.env, не хардкодятся в исходниках.
- .env подгружается через dotenv, в коде не парсится вручную.
- В логах не выводятся секреты (только status/code для Gemini, без ключей и тела).
- eval/exec и подобные опасные вызовы не используются.

### Производительность

- Нет блокирующих синхронных операций в критическом пути; нет синхронного чтения больших файлов.
- Работа с изображением: буфер из fetch → Buffer.from(arrayBuffer), передаётся в vision и не дублируется лишний раз.

### Наблюдаемость

- Стартовый лог: «Bot started» после успешного bot.launch().
- Ошибки: логируются в handlers (Error processing photo, Failed to send «Анализирую…», Unexpected error), в bot.catch (Unhandled error), в GeminiProvider (Gemini vision/text error с status, code).

### Известные ограничения

- История и rate limit — в памяти; при перезапуске сбрасываются.
- Один экземпляр бота на один токен (long polling); при 409 — см. README Troubleshooting.
- Gemini и USDA доступны по сети с VPS; при блокировках по региону нужен сервер в разрешённой стране или прокси.

### Уровень готовности

**Production-ready for MVP:** проект готов к запуску на VPS в Docker с long polling при условии устранения пунктов из Findings (в первую очередь — секреты в .env.example и обработка отклонения bot.launch()).

---

## Findings

| # | Описание | Критичность | Рекомендация |
|---|----------|-------------|--------------|
| 1 | В `.env.example` указаны значения, похожие на реальные токены и API-ключи (TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, USDA_API_KEY). Файл попадает в репозиторий и может привести к утечке секретов. | **high** | Заменить все значения в .env.example на плейсхолдеры (например, `YOUR_TELEGRAM_BOT_TOKEN`, `your_gemini_api_key`, `your_usda_api_key`) и добавить в README предупреждение не коммитить .env с реальными ключами. |
| 2 | `bot.launch().then(() => console.log('Bot started'))` — при отклонении промиса (например, неверный токен, сеть) ошибка остаётся необработанной (unhandled rejection), процесс может завершиться без явного сообщения. | **medium** | Добавить `bot.launch().then(() => console.log('Bot started')).catch((err) => { console.error('[Calorie Bot] Failed to start:', err); process.exit(1); })` (или аналогичную обработку). |
| 3 | В Docker и docker-compose не задаётся `NODE_ENV=production`. Некоторые библиотеки могут вести себя иначе (например, более подробные логи в dev). | **low** | В docker-compose в секции `environment` добавить `NODE_ENV: production` или в Dockerfile `ENV NODE_ENV=production` для финального stage. |

**Внесённые правки:** (1) `.env.example` — плейсхолдеры YOUR_* и ENABLE_GEMINI_FALLBACK=false; (2) `src/index.ts` — `bot.launch().catch(...)` с логированием и process.exit(1); (3) Dockerfile — `ENV NODE_ENV=production` в runtime stage; (4) README — предупреждение не коммитить .env, упоминание NODE_ENV.
