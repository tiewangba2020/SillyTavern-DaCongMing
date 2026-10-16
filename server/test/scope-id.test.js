/**
 * 聊天标识解析（extension/not-forgotten/scope-id.js）的回归测试。
 *
 * 背景：早期实现里，只要拿不到 chatId，就用 `${avatar}::${首条消息时间}` 兜底。
 * 当页面加载 / 新建聊天 / 切换聊天的瞬态里连角色都没解析出来时，avatar 为空串，
 * 于是凑出 `::2026-10-16T10:29:55.653Z` 这种「每次都不一样」的 id，
 * 在记忆库里留下一堆只有消息副本、没有记忆的「残留副本」。
 * 现在这类上下文一律返回 null，由调用方跳过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentCharacter, resolveChatId, resolveBranchId } from '../../extension/not-forgotten/scope-id.js';

const ISO = '2026-10-16T10:29:55.653Z';

test('resolveChatId：优先使用 SillyTavern 给出的 chatId', () => {
    assert.equal(resolveChatId({ chatId: '莉莉丝 - 2026-10-16@01h42m34s373ms' }), '莉莉丝 - 2026-10-16@01h42m34s373ms');
    // 群聊时 chatId 来自 groups[].chat_id，同样优先
    assert.equal(resolveChatId({ chatId: 'group-7', name2: 'User' }), 'group-7');
});

test('resolveChatId：chatId 为空串 / 非字符串时不算数，继续找兜底来源', () => {
    const ctx = {
        chatId: '',
        chatMetadata: { file_name: 'fallback-chat' },
        characters: [{ avatar: '莉莉丝.png' }],
        characterId: 0,
    };
    assert.equal(resolveChatId(ctx), 'fallback-chat');
});

test('resolveChatId：拿不到 chatId 时退化为「角色::首条消息时间」', () => {
    const ctx = {
        characters: [{ avatar: '莉莉丝.png' }],
        characterId: 0,
        chat: [{ send_date: ISO }],
    };
    assert.equal(resolveChatId(ctx), `莉莉丝.png::${ISO}`);
});

test('resolveChatId：没有角色但有用户名（中立角色临时聊天）时用用户名兜底', () => {
    const ctx = { name2: 'Assistant', chat: [{ send_date: ISO }] };
    assert.equal(resolveChatId(ctx), `Assistant::${ISO}`);
});

test('★ 回归：上下文未就绪（无角色且无用户名）时必须返回 null，不得凭空造 id', () => {
    // 这正是产生「残留副本」的上下文：探针记录里 characterId=null、characterName=""
    const ctx = {
        chatId: undefined,
        chatMetadata: {},
        characters: [{ avatar: '莉莉丝.png' }],
        characterId: undefined,
        name2: '',
        chat: [{ send_date: ISO }],
    };
    const id = resolveChatId(ctx);
    assert.equal(id, null, '无角色时不得返回字符串（旧实现会返回 "::<时间戳>"）');
    assert.ok(!String(id ?? '').includes(ISO), '不得把首条消息时间戳当作聊天标识');
});

test('resolveChatId：完全空的上下文（无 chat 字段）也返回 null', () => {
    assert.equal(resolveChatId({}), null);
    assert.equal(resolveChatId({ characterId: undefined, name2: '' }), null);
});

test('currentCharacter：characterId 缺省时返回 null，不越界取值', () => {
    const chars = [{ avatar: 'a.png' }, { avatar: 'b.png' }];
    assert.equal(currentCharacter({ characters: chars, characterId: undefined }), null);
    assert.equal(currentCharacter({ characters: chars }), null);
    assert.equal(currentCharacter({ characters: chars, characterId: 1 })?.avatar, 'b.png');
    assert.equal(currentCharacter({ characters: chars, characterId: 9 }), null);
});

test('resolveBranchId：缺省为 main', () => {
    assert.equal(resolveBranchId({}), 'main');
    assert.equal(resolveBranchId({ chatMetadata: { branch_id: 'alt' } }), 'alt');
    assert.equal(resolveBranchId({ chatMetadata: { branchId: 'alt2' } }), 'alt2');
});
