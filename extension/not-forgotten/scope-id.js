/**
 * 聊天标识解析（纯函数，不依赖 SillyTavern 运行时）。
 *
 * 单独成模块是为了可测：`server/test/scope-id.test.js` 直接 import 本文件，
 * 锁住「上下文未就绪时不得凭空造 id」这条回归。
 */

/** 当前角色对象（没有选中角色时返回 null）。 */
export function currentCharacter(ctx) {
    const idx = ctx?.characterId ?? ctx?.this_chid;
    if (idx === undefined || idx === null) return null;
    return ctx?.characters?.[idx] ?? null;
}

/**
 * 解析当前聊天的稳定标识。
 *
 * 优先用 SillyTavern 直接给出的 chatId / 聊天文件名；拿不到时退化为
 * 「角色::首条消息时间」。
 *
 * **角色名也拿不到时返回 null** —— 这说明上下文还没就绪（页面加载 / 新建聊天 /
 * 切换聊天的瞬态）。此时调用方必须跳过，绝不能用「空角色::时间戳」凑一个 id：
 * 时间戳每次都不同，会在记忆库里落下一堆归属不明的「残留副本」。
 *
 * @returns {string|null}
 */
export function resolveChatId(ctx) {
    // 注意用 .find 而不是 ??：SillyTavern 在「角色还没加载聊天」时会把
    // characters[i].chat 设成空串，空串不是 nullish，?? 会在这里直接截断、
    // 白白丢掉后面的 chatMetadata 来源。
    const explicit = [ctx?.chatId, ctx?.chatMetadata?.chat_id, ctx?.chatMetadata?.file_name]
        .find((v) => typeof v === 'string' && v);
    if (explicit) return explicit;
    // 用 || 而非 ??：角色存在但 avatar 为空串时，仍然应该退到用户名
    const avatar = currentCharacter(ctx)?.avatar || ctx?.name2 || '';
    if (!avatar) return null;
    const first = ctx?.chat?.[0]?.send_date ?? 'nofirst';
    return `${avatar}::${first}`;
}

/** 分支标识（SillyTavern 的 chat_metadata.branch_id，缺省 main）。 */
export function resolveBranchId(ctx) {
    return ctx?.chatMetadata?.branch_id ?? ctx?.chatMetadata?.branchId ?? 'main';
}
