import type { PreparedComment } from './upload-preprocessor';

export interface CloudComment {
    comment_id: string;
    reply_list: { replies: Array<{ reply_id: string; content: { elements: Array<{ type: string; text_run?: { text: string } }> } }> };
}
export interface CommentBinding { commentId: string; replyId: string }
export interface CommentExportState {
    namespace: string;
    bindings: Record<string, CommentBinding>;
}
export interface CommentClient {
    listDocumentComments(token: string): Promise<CloudComment[]>;
    createDocumentComment(token: string, text: string): Promise<CloudComment>;
    updateDocumentComment(token: string, commentId: string, replyId: string, text: string): Promise<void>;
}

const replyText = (reply: CloudComment['reply_list']['replies'][number]) =>
    reply.content.elements.map(element => element.text_run?.text ?? '').join('');

/** List before writing, so a previously lost create response can be recovered by its marker. */
export async function syncDocumentComments(client: CommentClient, token: string, comments: readonly PreparedComment[],
    state: CommentExportState, save: () => Promise<void>): Promise<void> {
    if (!comments.length) return;
    const existing = await client.listDocumentComments(token);
    for (const comment of comments) {
        // Conservative application limit, not a claim about Feishu's native length limit.
        const characters = Array.from(comment.text);
        const chunks: string[] = [];
        for (let at = 0; at < characters.length; at += 3000) chunks.push(characters.slice(at, at + 3000).join(''));
        for (let index = 0; index < chunks.length; index++) {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([state.namespace, comment.key, index])));
            const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            const marker = `[ObShare:${id}]`;
            const text = `${marker}\n${chunks.length > 1 ? `（第 ${index + 1}/${chunks.length} 部分）\n` : ''}${chunks[index]}`;
            const escapedText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const matches = existing.flatMap(item => item.reply_list.replies.slice(0, 1)
                .filter(reply => replyText(reply).startsWith(marker + '\n'))
                .map(reply => ({ item, reply })));
            if (matches.length > 1) throw new Error('发现重复的 ObShare 评论标记，请先检查云端评论');
            const found = matches[0];
            let binding: CommentBinding;
            if (found) {
                binding = { commentId: found.item.comment_id, replyId: found.reply.reply_id };
                if (![text, escapedText].includes(replyText(found.reply))) await client.updateDocumentComment(token, binding.commentId, binding.replyId, text);
            } else {
                const prior = state.bindings[id];
                // A manually edited marker must not cause another copy to be created.
                if (prior && existing.some(item => item.comment_id === prior.commentId)) {
                    throw new Error('已有导出评论的标记被修改，请恢复标记后重试');
                }
                const created = await client.createDocumentComment(token, text);
                const reply = created.reply_list.replies[0];
                if (!created.comment_id || !reply?.reply_id) throw new Error('评论创建响应缺少 ID，下次同步将从云端标记恢复');
                binding = { commentId: created.comment_id, replyId: reply.reply_id };
                existing.push(created);
            }
            state.bindings[id] = binding;
            await save();
        }
    }
}
