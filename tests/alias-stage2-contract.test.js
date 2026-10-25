// @ts-check
// Stage 2 contract: NOT the whole alias row is sent — only references whose
// canonical alias appears in the FINAL prompt (resolvePromptReferenceContext
// resolves against the prompt, i.e. after Stage 1). Stage 1 receives
// descriptions only of references detected in the source post
// (stage1Descriptions) — a superset of Stage 2, still not the full list.
// With two candidates and one alias mentioned, exactly one ref ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSceneContextSnapshot,
    normalizeSceneEntity,
    resolvePromptReferenceContext,
} from '../src/scene-context.js';

function entity(id, name, aliases) {
    return normalizeSceneEntity({ id, name, aliases, imagePath: `/${id}.png`, description: `${id} desc` });
}

const CORRECTIONS = { includedIds: [], excludedIds: [], revision: 0 };

test('Stage 2: упоминается один алиас из двух кандидатов — едет только он', async () => {
    const zagreus = entity('zagreus', 'Zagreus', ['Загрей', 'Zagreus']);
    const theseus = entity('theseus', 'Theseus', ['Тесей', 'Theseus']);

    const resolved = await resolvePromptReferenceContext({
        prompt: 'Загрей сидит на троне, Тесей у колонны.', // оба упомянуты
        candidates: [zagreus, theseus],
        corrections: CORRECTIONS,
    });
    assert.deepEqual(resolved.stage2Refs.map(ref => ref.id).sort(), ['theseus', 'zagreus']);

    const onlyZagreus = await resolvePromptReferenceContext({
        prompt: 'Загрей сидит на троне.', // Stage 1 вынес только одного
        candidates: [zagreus, theseus],
        corrections: CORRECTIONS,
    });
    assert.deepEqual(onlyZagreus.stage2Refs.map(ref => ref.id), ['zagreus']);
    assert.deepEqual(onlyZagreus.entities.map(e => e.name), ['Zagreus']);
});

test('Stage 1: descriptions только по рефам, распознанным в тексте поста', async () => {
    const zagreus = entity('zagreus', 'Zagreus', ['Загрей']);
    const theseus = entity('theseus', 'Theseus', ['Тесей']);

    const snapshot = await buildSceneContextSnapshot({
        chatId: 'chat',
        msgId: 1,
        messageText: 'Загрей открыл дверь. Тесей ждал за ней.',
        contextRevision: 0,
        candidates: [zagreus, theseus],
        corrections: CORRECTIONS,
    });
    assert.deepEqual(snapshot.stage1Descriptions.map(d => d.id).sort(), ['theseus', 'zagreus']);

    const partial = await buildSceneContextSnapshot({
        chatId: 'chat',
        msgId: 1,
        messageText: 'Загрей открыл дверь.',
        contextRevision: 0,
        candidates: [zagreus, theseus],
        corrections: CORRECTIONS,
    });
    assert.deepEqual(partial.stage1Descriptions.map(d => d.id), ['zagreus']);
});

test('Stage 2: описание (bindingMode=description) и картинка едят по одним правилам матчинга', async () => {
    const imageRef = entity('img-ref', 'Рада', ['Рада']);           // imagePath-реф
    const descRef = normalizeSceneEntity({ id: 'desc-ref', name: 'Ария', aliases: ['Ария'], description: 'серебристые волосы', bindingMode: 'description' });

    const resolved = await resolvePromptReferenceContext({
        prompt: 'Рада и Ария у окна.',
        candidates: [imageRef, descRef],
        corrections: CORRECTIONS,
    });
    const byId = Object.fromEntries(resolved.stage2Refs.map(ref => [ref.id, ref]));
    assert.equal(byId['img-ref'].imagePath, '/img-ref.png', 'image-реф несёт файл');
    assert.equal(byId['desc-ref'].description, 'серебристые волосы', 'description-реф несёт описание');
    assert.equal(byId['desc-ref'].bindingMode, 'description');
});
