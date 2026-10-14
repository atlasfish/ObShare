import { DocumentBlock, FeishuApiClient, ImageInfo, MarkdownConvertResponse } from './feishu-api';
import { GeneratedImage } from './upload-preprocessor';

export class DocumentSyncError extends Error {}

type HistoryBinding = { title: string; docToken: string; url: string; sourcePath?: string };
type SourceFile = { path: string; basename: string };

// History is newest first. Old records can only be migrated when the name is unique.
export function findSyncTarget<T extends HistoryBinding>(file: SourceFile, history: T[], files: SourceFile[]): T | undefined {
    const bound = history.find(item => item.sourcePath === file.path);
    if (bound) return bound;
    const legacy = history.find(item => !item.sourcePath && item.title === file.basename);
    if (!legacy) return undefined;
    if (files.filter(candidate => candidate.basename === file.basename).length !== 1) {
        throw new DocumentSyncError(`有多个同名笔记「${file.basename}」，请先在上传历史中绑定笔记路径，再更新飞书文档。`);
    }
    return legacy;
}

type ConvertedBlock = DocumentBlock & Record<string, unknown>;
export type DescendantBatch = { roots: string[]; blocks: ConvertedBlock[] };

// Preserve the converter's ordered roots and complete subtrees (including tables).
export function planDescendants(converted: MarkdownConvertResponse, documentId: string): DescendantBatch[] {
    if (!converted.first_level_block_ids?.length || !converted.blocks?.length) {
        throw new DocumentSyncError('飞书 Markdown 转换没有返回完整的文档结构');
    }
    const byId = new Map<string, ConvertedBlock>();
    for (const value of converted.blocks) {
        if (!value || typeof value !== 'object') throw new DocumentSyncError('飞书返回了无效的文档块');
        const block = JSON.parse(JSON.stringify(value)) as ConvertedBlock;
        if (!block.block_id || !Number.isInteger(block.block_type) || byId.has(block.block_id)) {
            throw new DocumentSyncError('飞书返回了无效或重复的文档块 ID');
        }
        const table = block['table'] as Record<string, unknown> | undefined;
        if (table) {
            delete table['cells']; // server generates cells from the children graph
            delete table['merge_info']; // read-only, not accepted by descendant creation
            const property = table['property'] as Record<string, unknown> | undefined;
            if (property) delete property['merge_info'];
        }
        byId.set(block.block_id, block);
    }
    const visited = new Set<string>();
    const collect = (id: string, parentId: string, subtree: ConvertedBlock[]) => {
        const block = byId.get(id);
        if (!block || visited.has(id)) throw new DocumentSyncError('飞书文档块关系缺失、重复或存在循环');
        visited.add(id);
        block.parent_id = parentId;
        subtree.push(block);
        for (const child of block.children ?? []) collect(child, id, subtree);
    };
    const batches: DescendantBatch[] = [];
    let batch: DescendantBatch = { roots: [], blocks: [] };
    for (const root of converted.first_level_block_ids) {
        const subtree: ConvertedBlock[] = [];
        collect(root, documentId, subtree);
        if (subtree.length > 1000) throw new DocumentSyncError('单个表格或嵌套内容超过飞书每次 1000 个块的限制，无法更新');
        if (batch.blocks.length + subtree.length > 1000) {
            batches.push(batch);
            batch = { roots: [], blocks: [] };
        }
        batch.roots.push(root);
        batch.blocks.push(...subtree);
    }
    batches.push(batch);
    if (visited.size !== byId.size) throw new DocumentSyncError('飞书转换包含无法定位的文档块，已停止更新');
    return batches;
}

type SyncClient = Pick<FeishuApiClient, 'convertMarkdownToBlocks' | 'getDocumentRevision' | 'getDocumentBlocksDetailed' |
    'createDocumentDescendants' | 'processImagesInDocument' | 'batchDeleteDocumentBlocks'>;

export async function replaceDocumentContent(
    client: SyncClient, documentId: string, content: string, imageInfos: ImageInfo[],
    onProgress?: (status: string) => void, generatedImages?: ReadonlyMap<string, GeneratedImage>
): Promise<void> {
    onProgress?.('正在转换更新内容...');
    const converted = content.trim() ? await client.convertMarkdownToBlocks(FeishuApiClient.convertObsidianImageSyntax(content)) : {
        first_level_block_ids: ['empty'],
        blocks: [{ block_id: 'empty', block_type: 2, text: { elements: [{ text_run: { content: '' } }] } }]
    };
    const batches = planDescendants(converted, documentId);
    const imageCount = batches.reduce((count, batch) => count + batch.blocks.filter(block => block.block_type === 27).length, 0);
    if (imageCount !== imageInfos.length) throw new DocumentSyncError('转换后的图片块数量与笔记图片数量不一致，已停止更新');
    let revision = await client.getDocumentRevision(documentId);
    const initial = await client.getDocumentBlocksDetailed(documentId, revision);
    const oldRoots = initial.find(block => block.block_id === documentId)?.children;
    if (!oldRoots) throw new DocumentSyncError('无法获取原文档的正文结构，已停止更新');
    const newRoots: string[] = [];
    const newBlocks: DocumentBlock[] = [];
    const sameRoots = (actual: string[] | undefined, expected: string[]) => !!actual &&
        actual.length === expected.length && actual.every((id, index) => id === expected[index]);
    let mutationPending = false;
    try {
        for (const batch of batches) {
            onProgress?.('正在原文档中准备新正文...');
            mutationPending = true;
            const result = await client.createDocumentDescendants(documentId, documentId, -1, batch.roots, batch.blocks, revision);
            const relations = new Map(result.block_id_relations.map(item => [item.temporary_block_id, item.block_id]));
            const roots = batch.roots.map(id => relations.get(id));
            if (roots.some(id => !id) || !Number.isInteger(result.document_revision_id) || result.document_revision_id <= revision) {
                throw new Error('飞书更新响应缺少块 ID 或文档版本号');
            }
            for (const block of batch.blocks) {
                const id = relations.get(block.block_id);
                if (!id) throw new Error('飞书更新响应缺少嵌套块 ID');
                newBlocks.push({ ...block, block_id: id });
            }
            newRoots.push(...roots as string[]);
            revision = result.document_revision_id;
            mutationPending = false;
        }
        if (imageInfos.length) {
            // Strict mode only touches newly appended images and tracks every revision.
            mutationPending = true;
            await client.processImagesInDocument(documentId, imageInfos, onProgress, generatedImages, {
                blocks: newBlocks, revision,
                onRevision: next => { revision = next; }
            });
            mutationPending = false;
        }
        const current = await client.getDocumentBlocksDetailed(documentId, revision);
        if (await client.getDocumentRevision(documentId) !== revision ||
            !sameRoots(current.find(block => block.block_id === documentId)?.children, [...oldRoots, ...newRoots])) {
            throw new Error('飞书文档在更新期间发生了其他修改，请检查后再同步');
        }
        if (oldRoots.length) {
            onProgress?.('正在替换原正文...');
            mutationPending = true;
            await client.batchDeleteDocumentBlocks(documentId, documentId, 0, oldRoots.length, revision);
            mutationPending = false;
        }
    } catch (error) {
        // Only remove positively identified new roots when the revision and order still match.
        let rolledBack = false;
        try {
            const latest = await client.getDocumentRevision(documentId);
            const blocks = await client.getDocumentBlocksDetailed(documentId, latest);
            if (newRoots.length && latest === revision &&
                sameRoots(blocks.find(block => block.block_id === documentId)?.children, [...oldRoots, ...newRoots])) {
                await client.batchDeleteDocumentBlocks(documentId, documentId, oldRoots.length, oldRoots.length + newRoots.length, latest);
                rolledBack = true;
            }
        } catch { /* Leave uncertain cloud state intact for manual inspection. */ }
        const reason = error instanceof Error ? error.message : String(error);
        const state = rolledBack ? '已移除本次新增内容，原正文保留。' :
            mutationPending || newRoots.length ? '请检查原飞书文档，可能保留了本次新增内容；未自动新建副本。' : '原正文未替换。';
        throw new DocumentSyncError(`更新已有文档失败：${reason}。${state}`);
    }
    onProgress?.('原文档更新完成！');
}
