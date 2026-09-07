# План: зум в галерее (PhotoSwipe), миниатюры, кроп референсов

Дата: 2026-09-08 · База: main @ d191a58 (v0.7.0)

Цели:

1. **Зум/пан** при просмотре галереи — канонический жестовый UX на мобильном
   (pinch, double-tap, swipe) и десктопе (колесо, double-click, drag).
2. **Кроп** при вводе референсов — одно место встраивания (батч-диалог + replace).
3. **Галерея**: `<img loading="lazy">` вместо `background-image`, миниатюры,
   чанковый рендер для больших галерей.

Принцип: каждая фаза — рабочий инкремент, отдельный коммит, `node --test`
зелёный после каждой фазы. Фазы независимы настолько, что 3 и 4 можно менять
местами или отложить.

Исследования: PhotoSwipe v5 (MIT, ESM-only, вендорится как fzstd) — лайтбокс;
Croppr (~10 КБ, zero-dep, touch-friendly) — кроп; web.dev/MDN — lazy loading.

---

## Фаза 1 — Размеры карточек (фундамент)

PhotoSwipe требует width/height до открытия (анимация из миниатюры, layout).
Свежие генерации уже несут `provenance.output.width/height`
(`image-api.js:227-261`; санитайзер вырезает `bytes`, но не размеры), но
top-level полей нет, а старые/reconcile-карточки (`provenance: 'native'`)
размеров не имеют вовсе.

- [ ] 1.1 `src/gallery-index.js`: в `ALLOWED` добавить `'width'`, `'height'`
      (`sanitizeGalleryCard` копирует ALLOWED-ключи напрямую — числа проходят).
- [ ] 1.2 `src/image-api.js` (~строка 250): в `addCard({...})` передать
      top-level `width: outputMeta.width`, `height: outputMeta.height`
      (из `materializeImageResult({withMetadata: true})`).
- [ ] 1.3 Новый `src/image-dimensions.js`: `ensureCardDimensions(chatId, item)`
      — если `item.width/height` есть, вернуть их; иначе `fetch(item.src)` →
      `createImageBitmap` (fallback `<img>`, паттерн `blobMetadata` из
      `native-image-storage.js`) → `updateGalleryEntry(chatId, item.id,
      {width, height})` и вернуть. Проб — один раз, дальше из кэша карточки.
      Деградация: `{width: 1024, height: 1024}` при ошибке, без persist.
- [ ] 1.4 Тест: `gallery-index.test.js` — width/height проходят sanitize,
      `bytes` по-прежнему вырезается.

**Commit 1:** `feat: carry width/height on gallery cards`

## Фаза 2 — PhotoSwipe вместо ручного лайтбокса

- [ ] 2.1 Вендор в `src/vendor/`: `photoswipe.esm.js`,
      `photoswipe-lightbox.esm.js`, текст `photoswipe.css` — добавить в конец
      `style.css` (селекторы `.pswp-*` уникальны, конфликтов нет). Пин v5.4.x.
- [ ] 2.2 Блок переопределений в `style.css` (КРИТИЧНО, см. комментарии
      `.uris-lightbox` в style.css):
      ```css
      .pswp {
          /* ST-mobile ставит body { position: fixed } — inset:0 схлопывается.
             Рецепт тот же, что у .uris-lightbox/.uris-picker-overlay. */
          position: fixed; top: 0; left: 0;
          width: 100%; height: 100vh; height: 100dvh;
          z-index: 100000; /* .uris-window = 99999, свои оверлеи = 100000 */
      }
      ```
- [ ] 2.3 Переписать `src/ui/lightbox.js` (экспорт `showLightbox(items, index,
      {chatId, root})` сохранить — это шов для `tab-gallery.js`):
      - `dataSource` из items: `{src, width, height, alt: prompt, prompt,
        style, id, idx}` — произвольные поля доступны как `slide.data`;
      - перед открытием `ensureCardDimensions` для items без размеров;
      - `pswpModule: () => import('../vendor/photoswipe.esm.js')`;
      - `uiRegister` → `pswp.ui.registerElement` × 4: копировать промпт /
        в референсы / перегенерировать / удалить — вызовы существующих функций
        из `gallery-actions.js` (`pswp.currSlide.data` — item);
      - поведение как сейчас: copy и saveRef НЕ закрывают, regen и del —
        закрывают (`pswp.close()`), после — `refreshRoot(root)`;
      - опции: `zoom: true`, `bgOpacity: 0.9` (как сейчас), `pinchToClose`,
        `verticalDragToClose` (дефолты), русские aria-label в `defaultOptions`;
      - НЕ вызывать `lockBodyScroll` (у pswp свой scroll-lock; смешение двух
        механизмов даёт залипший `overflow:hidden`);
      - НЕ вешать свои keydown/swipe (у pswp свои); фокус-возврат pswp делает сам.
- [ ] 2.4 `src/ui/tab-gallery.js`:
      - `card()`: убрать кнопку `[data-act="view"]` из панели действий;
        `.uris-card-img` становится `<button type="button"
        class="uris-card-img" data-act="view" aria-label="Просмотр">`
        с `<img loading="lazy" decoding="async">` внутри (клавиатура: Enter/Tab
        работает как у прежней кнопки);
      - `bindCards()`: обработчик `[data-act="view"]` остаётся (клик по
        кнопке-картинке), вызов `showLightbox` не меняется.
- [ ] 2.5 CSS: `.uris-card-img` — сброс кнопочных дефолтов (border/background/
      padding/font), сохранить `aspect-ratio: 1; cursor: pointer`;
      `img { width/height: 100%; object-fit: cover; display: block }`.
- [ ] 2.6 Тесты: `popup-viewport-css.test.js` — инвариант «явные top/left/
      width/height вместо inset:0» перенести с `.uris-lightbox` на `.pswp` +
      добавить проверку `z-index: 100000`; `tests/manual/lightbox-mobile.html`
      — проверить/поправить вызов (сигнатура showLightbox та же).
- [ ] 2.7 Ручная проверка: десктоп (колесо к курсору, double-click, drag-пан,
      Esc/стрелки), мобайл (pinch, double-tap, swipe-навигация, swipe-down
      закрытие), ST-мобильный `body{position:fixed}` (нулевой бэкдроп),
      ST-confirm удаления поверх просмотрщика (top layer), видимость toastr.

**Commit 2:** `feat: PhotoSwipe lightbox with pinch/wheel zoom (drop expand button)`

## Фаза 3 — Миниатюры + производительность

- [ ] 3.1 `src/references.js`: параметризовать `optimizeReferenceImage(input,
      {maxEdge, quality, qualityAlpha})` — дефолты текущие (`MAX_EDGE=1024` и
      константы качества), сигнатура совместима. `OPTIMIZATION_VERSION`
      референсов не трогать; для миниатюр отдельная метка `thumb-v1-512`.
- [ ] 3.2 `src/native-image-storage.js`: экспорт `uploadThumbnail(blob,
      filename)` → `uploadPayload(..., ch_name: 'URIS_Thumbs')`.
      **Только отдельная папка**: `reconcileCards()` (gallery-index.js:169-172)
      автоимпортирует любой неизвестный файл из просканированных папок как
      карточку-фантом; папка миниатюр нигде не упоминается в `imagePath`
      карточек → никогда не сканируется. `listNativeImages` галереи не растёт.
- [ ] 3.3 `src/image-api.js`: после materialize — `generateThumbnailFromPath`
      (same-origin fetch → bitmap → canvas 512 → webp blob → `uploadThumbnail`)
      → `updateCard(entry.id, {thumbPath})`. Best-effort: ошибка миниатюры не
      роняет сохранение генерации (карточка без `thumbPath` рендерит оригинал).
- [ ] 3.4 `src/storage.js` `deleteGalleryCard(deleteFile: true)`: дополнительно
      удалить файл миниатюры через `/api/images/delete` (best-effort, отдельная
      проверка реюзов не нужна — на thumbPath никто не ссылается).
- [ ] 3.5 `src/ui/tab-gallery.js`: `src` миниатюры = `it.thumbPath || it.src`
      (старые карточки продолжают работать на оригиналах).
- [ ] 3.6 Чанковый рендер: первые 60 карточек, sentinel + IntersectionObserver
      → дозапись следующей порции (не полный innerHTML-перерендер).
- [ ] 3.7 Тест: sanitize пропускает `thumbPath`; хелпер генерации миниатюры
      (seam на canvas как в references).

**Commit 3:** `perf: gallery thumbnails, lazy images, chunked rendering`

## Фаза 4 — Кроп референсов

- [ ] 4.1 Вендор в `src/vendor/`: `croppr.min.js` + `croppr.min.css` (CSS —
      тоже в `style.css`; классы `.croppr-*` уникальны).
- [ ] 4.2 Новый `src/ui/crop-dialog.js`: `openCropDialog({source})` →
      `Promise<{blob, width, height} | null>`. Хром — `.uris-picker-overlay`/
      `.uris-picker-dialog` (проверен на ST-мобиле), `z-index: 100100` (может
      открываться поверх открытого PhotoSwipe при «сохранить как референс»).
      Пресеты: Свободно / 1:1 / 3:4 (тайлы пула — 3:4). ОК → canvas-crop
      выделенной области → Blob; Отмена → null. Croppr сам держит touch.
- [ ] 4.3 `src/ui/ref-batch-upload.js` (главный поток — ВСЕ загрузки референсов
      проходят через этот диалог, одиночные тоже):
      - в pending-строках кнопка «Обрезать» → `openCropDialog(item.blob ||
        item.file)` → `item.blob = result`, `thumbUrl` пересоздать, renderList();
      - `upload()` строка ~223: `ingest(item.blob || item.file, ...)`;
      - `releaseThumbs` учитывает пересозданные thumbUrl.
- [ ] 4.4 `src/ui/tab-references.js` `_bindEditorBody` (replace-флоу, общий для
      десктоп-оверлея и мобильной карточки): между выбором файла и
      `ingestReferenceImage` — опциональный crop-шаг (кнопка + чекбокс
      «обрезать», не блокирующий: отмена кропа = загрузить как есть).
- [ ] 4.5 `src/ui/gallery-actions.js` `saveAsReference`: кроп только в ветке
      «создать новый референс» (вопрос «обрезать?» → crop-диалог → новый файл).
      Ветка «заменить изображение» остаётся быстрой — реюз native-пути без
      перезагрузки; при кропе реюз невозможен (новые байты), сознательно.
- [ ] 4.6 Тесты по образцу `ref-batch-upload.test.js`: pure-хелперы crop-региона
      (пресеты, clamp), deps-seam на порядок вызовов ingest.

**Commit 4:** `feat: reference crop dialog (batch upload + replace + save-from-gallery)`

## Фаза 5 — Финализация

- [ ] 5.1 Полный `node --test`.
- [ ] 5.2 `docs/CHANGELOG.md` (сверху), `manifest.json` → `0.8.0`.
- [ ] 5.3 `docs/README.md` — ничего? Проверить политику backup (miniature files
      в ST-хранилище не переносятся backup'ом — как и основные; ок).
- [ ] 5.4 Merge в `main`, тег `v0.8.0`.

---

## Риски и защиты

| Риск | Защита |
|---|---|
| ST-мобила `body{position:fixed}`: нулевой вьюпорт у pswp | Переопределение `.pswp` по рецепту `.uris-lightbox` + тест-инвариант 2.6 |
| pswp (дефолт z-index 1600) под окном расширения (99999) | `.pswp { z-index: 100000 }` в 2.2 |
| ST-confirm не виден над лайтбоксом | Не будет: `<dialog>` в top layer всегда сверху (popup.css ST без z-index). Проверить toastr; при необходимости поднять `#toast-container` |
| Фантомные карточки от миниатюр в reconcile | Папка `URIS_Thumbs`, никогда не сканируется (см. 3.2) |
| Смешение scroll-lock'ов | `lockBodyScroll` для pswp не вызывается (2.3) |
| Карточки без размеров (legacy/reconcile) | `ensureCardDimensions` лениво + persist (Фаза 1), деградация 1024² |
| Относительные пути (`user/images/...` без слэша) | Семантика не меняется: и сетка, и текущий лайтбокс ставят их так же |
| `touch-action: pan-y` темы ST на кнопках | pswp/croppr вне `.uris-window`, фикс их не задевает |
| Требование pswp: размеры до открытия | Фаза 1 целиком; блокирует 2.3 (порядок фаз 1→2 обязателен) |

## Вне скоупа (осознанно)

- Кроп в пайплайне генерации (провайдеры сами нормализуют аспект).
- Фоновая миграция миниатюр для старых карточек (фолбэк на оригинал работает).
- Виртуализация галереи (чанков достаточно).
- Собственный crop-UI на pointer events (жестовая математика = костыли).
