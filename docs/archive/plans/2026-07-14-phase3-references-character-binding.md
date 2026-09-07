# Phase 3 - Привязка NPC к ST-карте + Multi-char avatars + Capture-from-gallery

- **Дата**: 2026-07-14
- **Статус**: спроектирован, ожидает реализации
- **Зависимости**: Phase 1 (refs override + read-back) и Phase 2 (NPC-карточки UI) завершены
- **Объём**: V3.1 + V3.2 + V3.3 (полный, breaking change модели данных) — решение пользователя

## Контекст

В Фазе 1 решена видимость референсов на вкладке «Генерация» и per-gen override. В Фазе 2 наведён порядок в карточках NPC на вкладке «Референсы» (tile-превью, overlay-замена, drag-сортировка, автопопуляция user-аватаров, баннер «never»).

Остаются три архитектурных пробела (из аналитического отчёта):

1. **Боль №21** — `'char'` avatar представляет только ОДНОГО персонажа (текущий `ctx.characterId`). В group-chat нельзя отправить аватары двух ST-карт одновременно.
2. **Боль №22** — нет «захвата облика в переиспользуемый референс». Нельзя взять ST-аватар Aria (или её уже сгенерированную картинку из галереи) и сохранить как управляемый NPC-reference для переиспользования через чаты.
3. **Боль №23** — `activeChars` (Stage1, текстовые персоны) и `refs` (Stage2, картинки) — две разорванные сущности без foreign key.

## Цели Phase 3

- **V3.1**: NPC можно привязать к ST-карточке — кнопка в карточке NPC открывает popup выбора ST-чара, при выборе snapshot-заливает аватар в `imagePath` и автозаполняет name/keywords.
- **V3.2**: `charAvatar: boolean` → `charAvatarIds: string[]` (массив id ST-чаров + специальное значение `'current'`). Multi-char avatars в одной генерации.
- **V3.3**: кнопка «В референсы» в карточке галереи — модалка «новый NPC / заменить существующий».

## Сводка изменений

| Файл | V3.1 | V3.2 | V3.3 |
|------|------|------|------|
| `src/references-profiles.js` | NPC schema += `characterId`, `avatarFile` | `charAvatar` → `charAvatarIds[]`; `migrateProfile` конвертация; `_resolveIncludedRefs` multi-char | — |
| `src/references.js` | — | `getCharacterAvatarDataUrl(characterId?)` — опциональный аргумент | — |
| `src/ui/tab-references.js` | кнопка «🔗 Привязать к ST-карте» + «🔄 Синхронизировать» | чек-бокс `{{char}} аватар` → блок чипов ST-чаров | — |
| `src/ui/tab-gallery.js` | — | — | кнопка `[data-act="saveRef"]` + модалка |
| `src/ui/tab-generate.js` | — | адаптация `buildOverrideControls` (Phase 1 override) под multi-char | — |
| `style.css` | индикатор привязки NPC | `.uris-char-chips`, `.uris-char-chip` | `.uris-card-btn-saveRef` |
| `tests/references-profiles.test.js` | — | миграция legacy, multi-char collect, smart-matching, `getCharacterAvatarDataUrl(id)` | — |


## V3.2: Multi-char avatars (breaking change)

### 3.2.1. Schema и migrateProfile

**Текущая модель** (`references-profiles.js:34-48`):
```js
{
  id, name,
  charAvatar: boolean,           // ← удалить
  userAvatarFile: string,
  mode: 'always' | 'smart' | 'never',
  npcReferences: NpcReference[]
}
```

**Новая модель**:
```js
{
  id, name,
  charAvatarIds: string[],      // ← новое; элементы: 'current' | String(ST-char-id)
  userAvatarFile: string,
  mode: 'always' | 'smart' | 'never',
  npcReferences: NpcReference[]
}
```

**`migrateProfile(p)`** - конвертация legacy при чтении:
```js
function migrateProfile(p) {
    if (!p) return p;
    const migrated = {
        ...p,
        mode: p.mode || 'never',
        npcReferences: Array.isArray(p.npcReferences) ? p.npcReferences : [],
    };
    // V3.2: charAvatar (boolean) -> charAvatarIds (string[])
    if (!Array.isArray(migrated.charAvatarIds)) {
        // Legacy: charAvatar=true означало «включить текущего ST-чара».
        // Сохраняем семантику через специальное значение 'current'.
        migrated.charAvatarIds = (p.charAvatar === true) ? ['current'] : [];
    }
    delete migrated.charAvatar;  // чистим legacy поле
    return migrated;
}
```

**`createReferencesProfile(data)`** - заменить `charAvatar: !!data.charAvatar` на:
```js
charAvatarIds: Array.isArray(data.charAvatarIds)
    ? data.charAvatarIds.map(id => String(id))
    : [],
```

**`saveReferencesProfile(patch)`** - в `sanitized` прокинуть:
```js
if (Array.isArray(sanitized.charAvatarIds)) {
    sanitized.charAvatarIds = sanitized.charAvatarIds.map(id => String(id));
}
```

### 3.2.2. _resolveIncludedRefs - multi-char итерация

Заменить блок «char» (одиночный `profile.charAvatar`) на итерацию по `charAvatarIds`:

```js
// char (multi): 'current' -> текущий ST-чат-чар; числовой id -> конкретный ST-чар.
// Smart-матчинг - по имени каждого чара отдельно.
const charIds = Array.isArray(profile.charAvatarIds) ? profile.charAvatarIds : [];
const ctxChars = getCtx().characters || [];
for (const cid of charIds) {
    if (out.length >= MAX_REFS) break;
    let charNameForRef = '';
    let descriptorKind = '';
    let descriptorCharId = null;
    if (cid === 'current') {
        charNameForRef = context.charName || '';
        descriptorKind = 'current-char';
    } else {
        const ch = ctxChars[Number(cid)];
        if (!ch) continue;  // ST-чар удалён - skip без ошибки
        charNameForRef = ch.name || '';
        descriptorKind = 'char-by-id';
        descriptorCharId = cid;
    }
    if (!charNameForRef) continue;
    const mentioned = !smart || isNameInText(charNameForRef, combinedText);
    if (!mentioned) continue;
    out.push({
        role: 'char',
        name: charNameForRef,
        kind: descriptorKind,
        characterId: descriptorCharId,
    });
}
```

### 3.2.3. collectReferencesFromProfile - fetch по descriptor

В `collectReferencesFromProfile` (с fetch dataUrl) обновить switch по `d.kind`:

```js
for (const d of descriptors) {
    let dataUrl = null;
    if (d.role === 'char') {
        if (d.kind === 'current-char') {
            dataUrl = await getCharacterAvatarDataUrl();  // без аргумента - ctx.characterId
        } else if (d.kind === 'char-by-id') {
            dataUrl = await getCharacterAvatarDataUrl(d.characterId);
        }
    } else if (d.role === 'user') {
        dataUrl = await getUserAvatarDataUrl(d.userAvatarFile);
    } else {
        dataUrl = await imageToDataUrl(d.imagePath);
    }
    if (dataUrl) refs.push({ image: dataUrl, role: d.role, name: d.name });
}
```

### 3.2.4. references.js: getCharacterAvatarDataUrl(characterId)

Текущая реализация (`references.js:28-54`) использует `ctx.characterId`. Расширить опциональным аргументом:

```js
export async function getCharacterAvatarDataUrl(characterId) {
    const ctx = getCtx();
    // Если аргумент не передан - берём текущего ST-чат-чара (backward-compat).
    const cid = characterId != null ? characterId : ctx.characterId;
    if (cid == null) {
        log('getCharacterAvatarDataUrl: characterId is null, skipping char avatar');
        return null;
    }
    if (typeof ctx.getCharacterAvatar === 'function') {
        const u = ctx.getCharacterAvatar(cid);
        if (u) {
            const d = await imageToDataUrl(u);
            if (d) return d;
            log('getCharacterAvatarDataUrl: imageToDataUrl failed for', u);
        } else {
            log('getCharacterAvatarDataUrl: getCharacterAvatar returned falsy for', cid);
        }
    }
    const ch = ctx.characters?.[cid];
    if (ch?.avatar) {
        const url = `/characters/${encodeURIComponent(ch.avatar)}`;
        const d = await imageToDataUrl(url);
        if (d) return d;
        log('getCharacterAvatarDataUrl: imageToDataUrl failed for', url);
        return null;
    }
    log('getCharacterAvatarDataUrl: no avatar found for character', cid);
    return null;
}
```

Backward-compat: существующие callSites без аргумента работают как раньше.

### 3.2.5. UI: tab-references.js - чипы вместо чек-бокса

В `refsFields(p)` удалить `<label class="checkbox_label">...{{char}} аватар...</label>` и добавить:

```html
<div class="uris-char-section">
    <label>Аватары персонажей</label>
    <div class="uris-char-chips" data-profile-id="${p.id}">
        <span class="uris-char-chip ${charAvatarIds.includes('current') ? 'uris-char-chip-on' : ''}"
              data-cid="current" title="Текущий персонаж чата">Текущий {{char}}</span>
        ${ctxCharacters.map((ch, i) =>
            `<span class="uris-char-chip ${charAvatarIds.includes(String(i)) ? 'uris-char-chip-on' : ''}"
                  data-cid="${i}" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</span>`
        ).join('')}
    </div>
</div>
```

`ctxCharacters` - через `getCtx().characters` (как в `chat-binding.js`).

`bindRefsRows`: обработчик клика по чипу - toggle id в `charAvatarIds` профиля:
```js
card.querySelector('.uris-char-chips')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.uris-char-chip');
    if (!chip) return;
    const cid = chip.dataset.cid;  // 'current' | String(ST-char-id)
    const p = await getReferencesProfile(id);
    if (!p) return;
    const arr = Array.isArray(p.charAvatarIds) ? p.charAvatarIds.slice() : [];
    const i = arr.indexOf(cid);
    if (i === -1) arr.push(cid); else arr.splice(i, 1);
    await saveReferencesProfile({ id, charAvatarIds: arr });
    refreshActive();
});
```

`collectRefsCard` - удалить `charAvatar` из собираемых полей. `charAvatarIds` управляется только через чипы (не в collectRefsCard).

### 3.2.6. Адаптация Phase 1 override под multi-char

Phase 1 override имел `includeChar: boolean`. С multi-char это неоднозначно. Решение (back-compat):
- `override.includeChar: boolean` теперь означает «включить всех из `charAvatarIds`» (общий toggle всего блока чаров).
- Для тонкого per-char контроля добавим `override.charAvatarIds: string[]` - полная замена списка чаров на одну генерацию.

В `_resolveIncludedRefs` обновить блок char:
```js
const charIds = override && Array.isArray(override.charAvatarIds)
    ? override.charAvatarIds
    : (Array.isArray(profile.charAvatarIds) ? profile.charAvatarIds : []);
// override.includeChar === false -> пропустить весь блок чаров
const charEnabled = !(override && override.includeChar === false);
if (charEnabled) {
    for (const cid of charIds) { ... }
}
```

UI Phase 1 (`tab-generate.js::buildOverrideControls`): при включённом Override показывать чипы конкретных ST-чаров (как на References tab) вместо одного чек-бокса `{{char}}`. Адаптация `buildOverrideControls`:
```js
const ctxChars = getCtx().characters || [];
let charChipsHtml = `<div class="uris-ov-char-chips">`;
charChipsHtml += `<span class="uris-ov-char-chip ${o.charAvatarIds?.includes('current') !== fa
lse ? 'uris-npc-chip-on' : ''}" data-cid="current">Текущий</span>`;
for (let i = 0; i < ctxChars.length; i++) {
    const on = o.charAvatarIds?.includes(String(i)) ?? profile.charAvatarIds.includes(String(i));
    charChipsHtml += `<span class="uris-ov-char-chip ${on ? 'uris-npc-chip-on' : ''}" data-cid="${i}">${escapeHtml(ctxChars[i].name)}</span>`;
}
charChipsHtml += `</div>`;
```

`bindOverrideControls`: обработчик клика по `uris-ov-char-chip` - toggle в `state.refsOverride.charAvatarIds` (если поле undefined - инициализировать из профиля).

## V3.1: Привязка NPC к ST-карте (snapshot)

### 3.1.1. NPC schema расширение

В `references-profiles.js::addNpcReference` добавить опциональные поля:

```js
const npc = {
    id: uid(),
    name: String(name).trim(),
    keywords: ...,
    imagePath,
    enabled: true,
    characterId: data.characterId != null ? String(data.characterId) : null,  // V3.1
    avatarFile: data.avatarFile || '',                                       // V3.1
};
```

`updateNpcReference(patch)` - поддержка:
```js
if (patch.characterId != null) npc.characterId = patch.characterId == null ? null : String(patch.characterId);
if (patch.avatarFile != null) npc.avatarFile = String(patch.avatarFile);
```

`migrateProfile` - для существующих NPC без этих полей проставить:
```js
npc.characterId = npc.characterId ?? null;
npc.avatarFile = npc.avatarFile ?? '';
```

### 3.1.2. UI: кнопка «🔗 Привязать к ST-карте» в npcRow

В `npcRow(npc)` в блок `.uris-npc-actions` добавить:
```html
<button class="menu_button uris-npc-bind" title="Привязать к ST-карте"><i class="fa-solid fa-link"></i></button>
${npc.characterId != null
    ? `<button class="menu_button uris-npc-sync" title="Синхронизировать с ST-картой"><i class="fa-solid fa-rotate"></i></button>`
    : ''}
```

В `.uris-npc-fields` (когда привязан) добавить индикатор:
```html
${npc.characterId != null
    ? `<div class="uris-npc-bound-badge" title="Привязан к ST-карте">
         <i class="fa-solid fa-link"></i>
         <span>🔗 ${escapeHtml(getCtx().characters?.[Number(npc.characterId)]?.name || '?')}</span>
       </div>`
    : ''}
```

### 3.1.3. bindNpcCard: обработчик привязки

```js
npcCard.querySelector('.uris-npc-bind')?.addEventListener('click', async () => {
    const ctx = getCtx();
    const chars = ctx.characters || [];
    if (!chars.length) { toastr?.warning('Нет ST-карточек для привязки'); return; }
    // Строим список через callGenericPopup с options кнопок.
    // ST ctx.callGenericPopup поддерживает BUTTONS-режим.
    const buttons = chars.map((ch, i) => ({
        text: ch.name || `Card #${i}`,
        result: i,
    }));
    const chosen = await ctx.callGenericPopup(
        'Выберите ST-карточку для привязки NPC:',
        ctx.POPUP_TYPE.TEXT, '',
        { okButton: 'Отмена', cancelButton: 'Отмена', buttons, customInput: false }
    );
    if (chosen == null || chosen === 'cancel' || chosen === false) return;
    const charId = Number(chosen);
    await bindNpcToStCard(profileId, npcId, charId);
});

async function bindNpcToStCard(profileId, npcId, charId) {
    const ctx = getCtx();
    const ch = ctx.characters?.[charId];
    if (!ch) { toastr?.error('Карточка не найдена'); return; }
    const dataUrl = await getCharacterAvatarDataUrl(charId);
    if (!dataUrl) { toastr?.warning('У карточки нет аватара'); return; }
    try {
        const compressed = await compressDataUrl(dataUrl);
        const path = await uploadReferenceImage(compressed.dataUrl, `npc_${npcId}`);
        await updateNpcReference(profileId, npcId, {
            characterId: String(charId),
            avatarFile: ch.avatar || '',
            imagePath: path,
            name: ch.name || '',
            keywords: [ch.name || ''],  // smart-matching по имени ST-чара
        });
        refreshActive();
        toastr?.success('NPC привязан к ST-карте');
    } catch (err) {
        log('bindNpcToStCard error:', err.message);
        toastr?.error('Не удалось привязать: ' + err.message);
    }
}

// Синхронизация существующей привязки
npcCard.querySelector('.uris-npc-sync')?.addEventListener('click', async () => {
    const npc = (await getReferencesProfile(profileId))?.npcReferences?.find(n => n.id === npcId);
    if (!npc?.characterId) return;
    const dataUrl = await getCharacterAvatarDataUrl(Number(npc.characterId));
    if (!dataUrl) { toastr?.warning('У карточки больше нет аватара'); return; }
    try {
        const compressed = await compressDataUrl(dataUrl);
        const path = await uploadReferenceImage(compressed.dataUrl, `npc_${npcId}`);
        await updateNpcReference(profileId, npcId, { imagePath: path });
        refreshActive();
        toastr?.success('Аватар синхронизирован');
    } catch (err) {
        toastr?.error('Синхронизация не удалась: ' + err.message);
    }
});
```

### 3.1.4. Импорты tab-references.js

Добавить импорты:
```js
import { getCtx } from '../core.js';  // для ctx.characters, ctx.callGenericPopup
```


## V3.3: Capture-from-gallery

### 3.3.1. Кнопка «В референсы» в карточке галереи

В `tab-gallery.js::card(it, i)` добавить в `.uris-card-actions`:
```html
<button class="uris-card-btn" data-act="saveRef" title="Сохранить как референс">
    <i class="fa-solid fa-bookmark"></i>
</button>
```

### 3.3.2. Обработчик в bindCards

```js
cardEl.querySelector('[data-act="saveRef"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const it = items.find(x => x.id === id);
    if (!it) return;
    try {
        const profile = await getActiveReferencesProfile();
        if (!profile) {
            toastr?.warning('Активный профиль референсов не выбран. Откройте вкладку «Референсы».');
            return;
        }
        // Модалка: «Создать новый NPC? OK - новый, Отмена - заменить в существующем».
        const createNew = await showConfirmModal(
            'Сохранить картинку в референсы?\n\n' +
            '«OK» - создать новый NPC в активном профиле.\n' +
            '«Отмена» - заменить изображение в существующем NPC.'
        );
        if (createNew) {
            const name = await showInputModal('Имя нового NPC:', 'Из галереи');
            if (!name) return;
            const imagePath = await uploadEntryAsRef(it);
            await addNpcReference(profile.id, { name, imagePath, keywords: name });
            toastr?.success('NPC создан: ' + name);
        } else {
            // Popup выбора существующего NPC.
            const npcs = (profile.npcReferences || []).filter(n => n.imagePath || true);
            if (!npcs.length) {
                toastr?.info('В активном профиле нет NPC. Создайте через «OK».');
                return;
            }
            const ctx = getCtx();
            const buttons = npcs.map(n => ({ text: n.name || '?', result: n.id }));
            const chosen = await ctx.callGenericPopup(
                'Выберите NPC для замены изображения:',
                ctx.POPUP_TYPE.TEXT, '',
                { okButton: 'Отмена', buttons }
            );
            if (!chosen || chosen === 'cancel') return;
            const imagePath = await uploadEntryAsRef(it);
            await updateNpcReference(profile.id, String(chosen), { imagePath });
            toastr?.success('Изображение NPC обновлено');
        }
        refreshActive();
    } catch (err) {
        log('saveRef error:', err.message);
        toastr?.error('Не удалось сохранить: ' + err.message);
    }
});

/**
 * Загрузить картинку gallery-entry в постоянное хранилище референсов (URIS_Refs).
 * Если it.src - dataUrl, сразу upload. Если путь (ST-gallery), сначала fetch в dataUrl.
 */
async function uploadEntryAsRef(it) {
    const src = it.src;
    if (!src) throw new Error('нет изображения');
    let dataUrl = src;
    if (!src.startsWith('data:')) {
        // it.src - серверный путь; fetch через imageToDataUrl.
        dataUrl = await imageToDataUrl(src);
    }
    const compressed = await compressDataUrl(dataUrl);
    return await uploadReferenceImage(compressed.dataUrl, `npc_capture_${Date.now()}`);
}
```

### 3.3.3. Импорты tab-gallery.js

Добавить (поверх существующих добавленных в Phase 1):
```js
import { showInputModal } from '../core.js';
import { addNpcReference, updateNpcReference } from '../references-profiles.js';
import { compressDataUrl, uploadReferenceImage, imageToDataUrl } from '../references.js';
```

## CSS

В `style.css` добавить:

```css
/* V3.1: индикатор привязки NPC */
.uris-npc-bound-badge {
    font-size: 11px;
    opacity: .75;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
}
.uris-npc-bind, .uris-npc-sync {
    padding: 4px 8px;
    font-size: 12px;
    min-width: 28px;
}

/* V3.2: чипы ST-чаров */
.uris-char-section {
    margin-top: 4px;
    padding-top: 4px;
}
.uris-char-section > label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    opacity: .85;
    margin-bottom: 4px;
}
.uris-char-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.uris-char-chip {
    padding: 4px 10px;
    border-radius: 12px;
    background: rgba(255,255,255,.08);
    cursor: pointer;
    font-size: 12px;
    user-select: none;
    border: 1px solid transparent;
}
.uris-char-chip.uris-char-chip-on {
    background: var(--SmartThemeQuoteColor, #4a5);
    color: #fff;
}

/* V3.3: кнопка capture из галереи */
button[data-act="saveRef"] {
    color: var(--SmartThemeQuoteColor, #4a5);
}
```

## Тесты (tests/references-profiles.test.js)

Добавить:

```js
// V3.2 migrateProfile: charAvatar:true -> charAvatarIds:['current']
test('migrateProfile converts legacy charAvatar=true to charAvatarIds', async () => {
    memoryStore.set(LF_REFERENCES_PROFILES, [
        { id: 'l1', name: 'Legacy', charAvatar: true, userAvatarFile: 'u.png', mode: 'always', npcReferences: [] },
        { id: 'l2', name: 'Legacy false', charAvatar: false, userAvatarFile: '', mode: 'never', npcReferences: [] },
    ]);
    const p1 = await getReferencesProfile('l1');
    assert.deepEqual(p1.charAvatarIds, ['current']);
    assert.equal(p1.charAvatar, undefined);  // legacy удалено
    const p2 = await getReferencesProfile('l2');
    assert.deepEqual(p2.charAvatarIds, []);
});

// V3.2 multi-char: 'current' + id в charAvatarIds
test('collectReferencesFromProfile multi-char with current + specific id', withFetchBlob(async () => {
    // Mock ctx.characters: [{name:'Aria', avatar:'aria.png'}, {name:'Bob', avatar:'bob.png'}]
    // (в тесте нужно installStGlobals样的 mock)
    const profile = {
        mode: 'always',
        charAvatarIds: ['current', '1'],  // current + Bob (index 1)
        userAvatarFile: '',
        npcReferences: [],
    };
    const refs = await collectReferencesFromProfile(profile, {
        charName: 'Aria',  // current -> Aria
        userName: 'Alex',
    });
    // Ожидаем 2 char-референса: Aria (current) + Bob (id=1).
    assert.equal(refs.length, 2);
    assert.ok(refs.every(r => r.role === 'char'));
    assert.ok(refs.some(r => r.name === 'Aria'));
    assert.ok(refs.some(r => r.name === 'Bob'));
}));

// V3.2 smart-mode matching per-char name
test('collectReferencesFromProfile multi-char smart filters by individual name', withFetchBlob(async () => {
    const profile = {
        mode: 'smart',
        charAvatarIds: ['current', '1'],
        userAvatarFile: '',
        npcReferences: [],
    };
    // Пост упоминает Bob, но не Aria -> только Bob проходит в smart.
    const refs = await collectReferencesFromProfile(profile, {
        chatText: 'Bob walks in',
        charName: 'Aria',
        userName: 'Alex',
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'Bob');
}));

// V3.2 skip удалённого ST-чара (id за пределами ctx.characters)
test('collectReferencesFromProfile skips deleted ST char id', withFetchBlob(async () => {
    const profile = {
        mode: 'always',
        charAvatarIds: ['99'],  // такого id нет
        userAvatarFile: '',
        npcReferences: [],
    };
    const refs = await collectReferencesFromProfile(profile, {});
    assert.equal(refs.length, 0);
}));

// V3.1 NPC characterId migration
test('migrateProfile adds characterId/avatarFile to legacy NPC', async () => {
    memoryStore.set(LF_REFERENCES_PROFILES, [{
        id: 'l3', name: 'Legacy NPC', charAvatar: false, userAvatarFile: '',
        mode: 'always',
        npcReferences: [{ id: 'n1', name: 'Eva', keywords: [], imagePath: '/x.png', enabled: true }],
    }]);
    const p = await getReferencesProfile('l3');
    assert.equal(p.npcReferences[0].characterId, null);
    assert.equal(p.npcReferences[0].avatarFile, '');
});
```

Тестовый mock ST-контекста: расширить `globalThis.SillyTavern.getContext` чтобы возвращал `characters: [{name:'Aria',avatar:'aria.png'}, {name:'Bob',avatar:'bob.png'}]` (сейчас один персонаж
). Добавить Bob в рамках теста или расширить общий mock.

## Порядок исполнения

1. Шаг 1: references-profiles.js - schema V3.2 (charAvatarIds), migrateProfile, createReferences, saveReferences; V3.1 NPC fields (characterId, avatarFile).
2. Шаг 2: references-profiles.js - _resolveIncludedRefs multi-char итерация; collectReferencesFromProfile fetch по descriptor kind.
3. Шаг 3: references.js - getCharacterAvatarDataUrl(characterId?) опциональный аргумент.
4. Шаг 4: tab-references.js V3.2 UI - удалить чек-бокс char-avatar, добавить чипы ST-чаров; collectRefsCard убрать charAvatar; обработчик чипов.
5. Шаг 5: tab-references.js V3.1 - кнопка «🔗 Привязать» + «🔄 Синхронизировать» в npcRow; обработчики bindNpcToStCard + sync.
6. Шаг 6: tab-gallery.js V3.3 - кнопка data-act="saveRef" + uploadEntryAsRef + модалка выбор.
7. Шаг 7: tab-generate.js - адаптация Phase 1 override под multi-char (charAvatarIds в override, чипы ST-чаров в override-контролах).
8. Шаг 8: style.css - CSS для чипов ST-чаров, индикатора привязки NPC, кнопки capture.
9. Шаг 9: tests/references-profiles.test.js - миграция legacy, multi-char, smart-matching, skip удалённого, NPC characterId миграция.
10. Шаг 10: Verify - node --check всех 5 изменённых файлов; node --test tests/*.test.js полный набор; мысленный прогон сценариев.

## Риски / подходы

### Breaking change миграции профилей
- Все профили с charAvatar:true автоматически мигрируют в charAvatarIds:['current'] - семантика сохранена.
- Legacy поле charAvatar удаляется из объекта при первом migrateProfile.
- Поведение: пользователь не теряет настройку «включить текущего ST-чара».

### NPC characterId - строка vs число
- characterId хранится как String(id) (id может быть числом, но для безопасности сравнения - строка).
- При сравнении с ctx.characters[Number(cid)] преобразование обратно в число.

### Snapshot для NPC binding
- Привязка заливает imagePath один раз (через uploadReferenceImage).
- Если аватар ST-карты меняется - пользователь жмёт «🔄 Синхронизировать» для ручного обновления.
- Live-fetch не используется (по решению пользователя) - стабильно, копия не зависит от состояния ST-карты.

### Capture из галереи - dataUrl vs path
- Если it.src - dataUrl (новые генерации), прямой upload.
- Если it.src - серверный путь (сохранённые в ST-gallery), fetch через imageToDataUrl(src).
- Сжатие compressDataUrl перед upload - единая политика.

### Адаптация Phase 1 override
- override.includeChar: boolean остаётся как общий toggle (back-compat с Phase 1).
- Новое override.charAvatarIds: string[] - полная замена списка для тонкого контроля.
- UI Phase 1 показывает чипы ST-чаров, а не один чек-бокс - но логика includeChar: false = «выключить всех» сохраняется.

### Порядок NPC и multi-char
- В _resolveIncludedRefs порядок: char (multi) -> user -> npc.
- Cap MAX_REFS=4 проверяется в каждом блоке через out.length >= MAX_REFS.
- Пользователь управляет порядком char-чипов на References tab (порядок клика); NPC - кнопками ↑/↓ (Phase 2).

## Что НЕ в Phase 3
- Live auto-refresh NPC-привязки при смене аватара ST-карты - ручная «Синхронизировать» достаточна.
- Юнит-тесты для V3.1/V3.3 UI-flows (popup, bind): они UI-bound, без unit-тестов. Базовые CRUD покрыты.
- V3.1 back-link (ST-карта -> список привязанных NPC): обратный lookup не требуется для current UX.
- Migration script для всех существующих профилей: migrateProfile срабатывает lazy при чтении, что достаточно.

## Связанные документы
- Аналитический отчёт: боли №21/22/23 (из Phase 0).
- Phase 1 план: реализован, см. src/ui/tab-generate.js::renderRefsStatus.
- Phase 2 план: реализован, см. src/ui/tab-references.js::npcRow (tile-превью + drag).
- Файл tmp_plan.md в корне - прошлый драфт; неактуален.
