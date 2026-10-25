// @ts-check
// Попап удаления картинки: чекбокс «Также стереть файл» должен выжить до
// резолва. ST Popup удаляет DOM диалога ДО вызова resolver'а — регрессия
// читала чекбокс после await и всегда получала unchecked. Фикс ловит
// переключение capture-фазой change, пока диалог открыт.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';

let fakeDoc;
beforeEach(() => {
    fakeDoc = makeFakeDocument();
    globalThis.document = fakeDoc.document;
    fakeDoc.document.body = fakeDoc.root;   // fake-dom: оверлеи аппендятся в root
    globalThis.toastr = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };
});

const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1 };
const POPUP_TYPE = { CONFIRM: 'confirm' };

/** fake-dom не диспетчеризирует document-события — вызываем сохранённые слушатели руками. */
function fireDocumentChange(target) {
    for (const l of (fakeDoc.document._docListeners || [])) {
        if (l.type === 'change') l.fn({ target });
    }
}

/**
 * Fake ctx.callGenericPopup: кладёт HTML попапа в document (как ST), ждёт
 * симуляцию пользователя, удаляет DOM (порядок ST: remove до resolve) и
 * только потом резолвит. onShown вызывается с корнем попапа, пока он жив.
 */
function makeCtx({ check, clickOk }) {
    return {
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup: async (html, type, _def, _opts) => {
            if (type !== POPUP_TYPE.CONFIRM) throw new Error('expected CONFIRM');
            const host = document.createElement('div');
            host.id = 'fakePopup';
            host.innerHTML = html;
            document.body.appendChild(host);
            const cb = host.querySelector('#urisDeleteFile');
            if (check) {
                cb.checked = true;
                fireDocumentChange(cb);
            }
            const outcome = clickOk ? POPUP_RESULT.AFFIRMATIVE : POPUP_RESULT.NEGATIVE;
            host.remove(); // ST: DOM умирает до resolver
            return outcome;
        },
    };
}

test('чекбокс «стереть файл», отмеченный до ОК, виден после удаления диалога из DOM', async () => {
    const { confirmDeleteModal } = await import('../src/ui/gallery-actions.js');
    const ctx = makeCtx({ check: true, clickOk: true });
    assert.equal(await confirmDeleteModal(ctx), true, 'deleteFile=true должен дойти до deleteGalleryCard');
});

test('непомеченный чекбокс при ОК — false (только скрыть карточку)', async () => {
    const { confirmDeleteModal } = await import('../src/ui/gallery-actions.js');
    const ctx = makeCtx({ check: false, clickOk: true });
    assert.equal(await confirmDeleteModal(ctx), false);
});

test('Отмена — null независимо от чекбокса', async () => {
    const { confirmDeleteModal } = await import('../src/ui/gallery-actions.js');
    const ctx = makeCtx({ check: true, clickOk: false });
    assert.equal(await confirmDeleteModal(ctx), null);
});
