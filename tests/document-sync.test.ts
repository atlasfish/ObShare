import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DocumentSyncError, findSyncTarget, planDescendants, replaceDocumentContent } from '../document-sync';
import { FeishuApiClient } from '../feishu-api';
import FeishuUploaderPlugin from '../main';
import { LinkProcessor } from '../link-processor';
import { CryptoUtils } from '../crypto-utils';
import { TFile, setRequestHandler } from 'obsidian';

const note = new TFile('notes/task.md');
const record = (token: string, path?: string) => ({ title: 'task', docToken: token, url: `https://example.test/docx/${token}`, ...(path && { sourcePath: path }) });
const text = (id: string) => ({ block_id: id, block_type: 2, text: { elements: [{ text_run: { content: id } }] } });
const converted = {
    first_level_block_ids: ['heading', 'table', 'image'],
    // Deliberately not in reading order.
    blocks: [text('cell-text'), { block_id: 'image', block_type: 27, image: {} },
        { block_id: 'table', block_type: 31, children: ['cell'], table: { property: { row_size: 1, column_size: 1 }, merge_info: [{}] } },
        { block_id: 'cell', block_type: 32, children: ['cell-text'], table_cell: {} }, text('heading')]
};
const infos = [{ path: 'drawing.png', fileName: 'drawing.png', position: 0 }];

test('exact path wins over newer same-title history; legacy chooses newest unique name', () => {
    const history = [record('new-other', 'other/task.md'), record('bound', note.path), record('legacy')];
    assert.equal(findSyncTarget(note, history, [note])?.docToken, 'bound');
    assert.equal(findSyncTarget(note, [record('new'), record('old')], [note])?.docToken, 'new');
    assert.equal(findSyncTarget(note, [record('other', 'other/task.md')], [note]), undefined);
});

test('ambiguous legacy names require explicit binding', () => {
    const files = [note, new TFile('other/task.md')];
    assert.throws(() => findSyncTarget(note, [record('old')], files), /绑定笔记路径/);
    assert.equal(findSyncTarget(note, [record('bound', note.path)], files)?.docToken, 'bound');
});

test('descendant plan preserves native root and nested table order, removing read-only fields', () => {
    const batch = planDescendants(converted, 'doc')[0]!;
    assert.deepEqual(batch.roots, ['heading', 'table', 'image']);
    assert.deepEqual(batch.blocks.map(block => [block.block_id, block.parent_id]), [
        ['heading', 'doc'], ['table', 'doc'], ['cell', 'table'], ['cell-text', 'cell'], ['image', 'doc']
    ]);
    assert.equal((batch.blocks[1] as any).table.merge_info, undefined);
    assert.ok((converted.blocks[2] as any).table.merge_info); // original is untouched
});

test('official conversion example retains all text, image and table blocks in root order', async () => {
    const data = JSON.parse(await readFile('tests/fixtures/markdown-convert.json', 'utf8'));
    const batches = planDescendants(data, 'doc');
    assert.deepEqual(batches.flatMap(batch => batch.roots), data.first_level_block_ids);
    const blocks = batches.flatMap(batch => batch.blocks);
    assert.equal(blocks.length, data.blocks.length);
    const table = blocks.find(block => block.block_type === 31) as any;
    assert.equal(table.table.property.merge_info, undefined);
    assert.equal(table.table.cells, undefined);
    assert.equal(table.children.length, 6);
    assert.equal(table.table.property.row_size, 2);
    assert.equal(table.table.property.column_size, 3);
    const { client, state } = syncClient(data);
    await replaceDocumentContent(client as any, 'doc', 'official example', infos);
    assert.deepEqual(state.roots, data.first_level_block_ids.map((id: string) => `real-${id}`));
});

test('large flat documents batch at 1000 while oversized single subtrees fail before mutation', () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => text(`t${i}`));
    assert.deepEqual(planDescendants({ first_level_block_ids: blocks.map(b => b.block_id), blocks }, 'doc').map(b => b.blocks.length), [1000, 1]);
    assert.throws(() => planDescendants({ first_level_block_ids: ['table'], blocks: [
        { block_id: 'table', block_type: 31, children: blocks.map(b => b.block_id) }, ...blocks
    ] }, 'doc'), /1000/);
});

test('incomplete, cyclic, duplicated or orphaned conversion graphs fail explicitly', () => {
    for (const data of [
        { blocks: [text('a')] },
        { first_level_block_ids: ['missing'], blocks: [text('a')] },
        { first_level_block_ids: ['a'], blocks: [text('a'), text('a')] },
        { first_level_block_ids: ['a'], blocks: [{ ...text('a'), children: ['a'] }] },
        { first_level_block_ids: ['a'], blocks: [text('a'), text('orphan')] }
    ]) assert.throws(() => planDescendants(data, 'doc'), DocumentSyncError);
});

function syncClient(data: any = converted) {
    const state = { revision: 1, roots: ['old-text', 'old-image'], events: [] as any[], blocks: [] as any[] };
    const client = {
        convertMarkdownToBlocks: async () => data,
        getDocumentRevision: async () => state.revision,
        getDocumentBlocksDetailed: async (_doc: string, revision: number) => {
            state.events.push(['read', revision]);
            return [{ block_id: 'doc', block_type: 1, children: [...state.roots] }, ...state.blocks];
        },
        createDocumentDescendants: async (_doc: string, _parent: string, index: number, roots: string[], blocks: any[], revision: number) => {
            assert.equal(revision, state.revision);
            assert.equal(index, -1);
            state.events.push(['append', revision]);
            state.roots.push(...roots.map(id => `real-${id}`));
            state.blocks.push(...blocks.map(block => ({ ...block, block_id: `real-${block.block_id}` })));
            return { document_revision_id: ++state.revision, block_id_relations: blocks.map(block => ({ temporary_block_id: block.block_id, block_id: `real-${block.block_id}` })) };
        },
        processImagesInDocument: async (_doc: string, _infos: any[], _progress: any, _images: any, options: any) => {
            state.events.push(['images', options.blocks.map((block: any) => block.block_id), options.revision]);
            assert.equal(options.revision, state.revision);
            options.onRevision(++state.revision);
        },
        batchDeleteDocumentBlocks: async (_doc: string, _parent: string, start: number, end: number, revision: number) => {
            assert.equal(revision, state.revision);
            state.events.push(['delete', start, end, revision]);
            state.roots.splice(start, end - start);
            state.revision++;
        }
    };
    return { state, client };
}

test('replacement prepares nested content and only new images before deleting old body', async () => {
    const { state, client } = syncClient();
    await replaceDocumentContent(client as any, 'doc', 'body', infos);
    assert.deepEqual(state.roots, ['real-heading', 'real-table', 'real-image']);
    assert.deepEqual(state.events.find(event => event[0] === 'images'), ['images',
        ['real-heading', 'real-table', 'real-cell', 'real-cell-text', 'real-image'], 2]);
    assert.deepEqual(state.events.filter(event => event[0] === 'delete'), [['delete', 0, 2, 3]]);
});

test('image count mismatch stops before any document mutation', async () => {
    const { state, client } = syncClient();
    await assert.rejects(replaceDocumentContent(client as any, 'doc', 'body', []), /图片块数量/);
    assert.deepEqual(state.events, []);
});

test('image failure rolls back identified appended blocks and preserves original body', async () => {
    const { state, client } = syncClient();
    client.processImagesInDocument = async (_d, _i, _p, _g, options) => {
        options.onRevision(++state.revision);
        throw Error('image 403');
    };
    await assert.rejects(replaceDocumentContent(client as any, 'doc', 'body', infos), /image 403.*原正文保留/);
    assert.deepEqual(state.roots, ['old-text', 'old-image']);
    assert.deepEqual(state.events.filter(event => event[0] === 'delete'), [['delete', 2, 5, 3]]);
});

test('concurrent Feishu edits prevent deletion of old body and unsafe rollback', async () => {
    const { state, client } = syncClient();
    client.processImagesInDocument = async () => { state.roots.push('someone-else'); state.revision++; };
    await assert.rejects(replaceDocumentContent(client as any, 'doc', 'body', infos), /其他修改/);
    assert.ok(state.roots.includes('old-text'));
    assert.equal(state.events.filter(event => event[0] === 'delete').length, 0);
});

test('unknown append outcome leaves cloud state intact and asks for inspection', async () => {
    const { state, client } = syncClient();
    const append = client.createDocumentDescendants;
    client.createDocumentDescendants = async (...args) => { await append(...args); throw Error('network response lost'); };
    await assert.rejects(replaceDocumentContent(client as any, 'doc', 'body', infos), /请检查原飞书文档/);
    assert.ok(state.roots.includes('old-text'));
    assert.equal(state.events.filter(event => event[0] === 'delete').length, 0);
});

test('unknown final delete outcome does not delete new body', async () => {
    const { state, client } = syncClient();
    const remove = client.batchDeleteDocumentBlocks;
    client.batchDeleteDocumentBlocks = async (...args) => { await remove(...args); throw Error('response lost'); };
    await assert.rejects(replaceDocumentContent(client as any, 'doc', 'body', infos), /请检查原飞书文档/);
    assert.deepEqual(state.roots, ['real-heading', 'real-table', 'real-image']);
    assert.equal(state.events.filter(event => event[0] === 'delete').length, 1);
});

test('empty content replaces body with an empty text block', async () => {
    const { state, client } = syncClient();
    client.convertMarkdownToBlocks = async () => { throw Error('empty conversion should be skipped'); };
    await replaceDocumentContent(client as any, 'doc', '', []);
    assert.deepEqual(state.roots, ['real-empty']);
});

test('multiple append batches carry revisions and maintain reading order', async () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => text(`t${i}`));
    const { state, client } = syncClient({ first_level_block_ids: blocks.map(b => b.block_id), blocks });
    await replaceDocumentContent(client as any, 'doc', 'body', []);
    assert.deepEqual(state.events.filter(event => event[0] === 'append'), [['append', 1], ['append', 2]]);
    assert.deepEqual(state.roots, blocks.map(b => `real-${b.block_id}`));
});

function plugin(client: any, history: any[] = []) {
    const instance = Object.create(FeishuUploaderPlugin.prototype) as any;
    instance.settings = { updateExistingDocuments: true, uploadHistory: history, uploadCount: 0, folderToken: '' };
    instance.feishuClient = client;
    instance.app = { vault: { getMarkdownFiles: () => [note], getAbstractFileByPath: (path: string) => path === note.path ? note : null } };
    instance.publishing = new Set();
    instance.saveData = async () => {};
    return instance;
}

test('first upload creates once; repeat upload retains token, URL, history and permissions', async () => {
    const { client } = syncClient({ first_level_block_ids: ['new'], blocks: [text('new')] });
    let creations = 0;
    const uploader = plugin({ ...client, uploadDocumentWithImageInfos: async () => { creations++; return { token: 'doc', url: 'stable-url' }; } });
    const first = await uploader.publishPreparedDocument(note, 'first');
    assert.equal(first.updated, false);
    uploader.settings.uploadHistory[0].permissions = { isPublic: false, allowCopy: true, allowCreateCopy: false };
    const second = await uploader.publishPreparedDocument(note, 'second');
    assert.equal(creations, 1);
    assert.equal(second.token, 'doc');
    assert.equal(second.url, 'stable-url');
    assert.equal(second.updated, true);
    assert.equal(uploader.settings.uploadHistory.length, 1);
    assert.equal(uploader.settings.uploadHistory[0].sourcePath, note.path);
    assert.equal(uploader.settings.uploadHistory[0].permissions.allowCopy, true);
    assert.equal(uploader.settings.uploadCount, 2);
});

test('conversion/permission failure on an existing document propagates without new import', async () => {
    let creations = 0;
    const uploader = plugin({ convertMarkdownToBlocks: async () => { throw Error('403'); },
        uploadDocumentWithImageInfos: async () => { creations++; } }, [record('doc', note.path)]);
    await assert.rejects(uploader.publishPreparedDocument(note, 'body'), DocumentSyncError);
    assert.equal(creations, 0);
});

test('disabled update mode intentionally creates a fresh document', async () => {
    const uploader = plugin({ uploadDocumentWithImageInfos: async () => ({ token: 'fresh', url: 'fresh-url' }) }, [record('old', note.path)]);
    uploader.settings.updateExistingDocuments = false;
    assert.equal((await uploader.publishPreparedDocument(note, 'body')).token, 'fresh');
    assert.equal(uploader.settings.uploadHistory.length, 2);
});

test('history deduplicates the same token while retaining permissions and older documents', async () => {
    const uploader = plugin({}, [{ ...record('doc'), permissions: { isPublic: true } }, record('older-doc')]);
    await uploader.addUploadHistory('task', 'url', 'doc', undefined, [], false, note.path, false);
    assert.equal(uploader.settings.uploadHistory.length, 2);
    assert.equal(uploader.settings.uploadHistory[0].permissions.isPublic, true);
    assert.equal(uploader.settings.uploadCount, 0);
});

test('new linked documents receive saved sharing permissions; existing documents retain theirs', async t => {
    t.mock.method(CryptoUtils, 'encryptSensitiveSettings', async (settings: any) => settings);
    const calls: any[] = [];
    const uploader = plugin({ setDocumentPermissions: async (...args: any[]) => { calls.push(args); } }, [
        { ...record('parent'), permissions: { isPublic: false, allowCopy: true, allowCreateCopy: false } },
        { ...record('new-child'), needsPermissionSetup: true }, record('existing-child')
    ]);
    uploader.settings.userId = 'test-user';
    await uploader.configureNewReferences('parent', [{ docToken: 'new-child' }, { docToken: 'existing-child' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'new-child');
    assert.equal(calls[0][1].isPublic, false);
    assert.equal(calls[0][2], 'test-user');
    assert.equal(uploader.settings.uploadHistory[1].needsPermissionSetup, undefined);
    await uploader.configureNewReferences('parent', [{ docToken: 'new-child' }]);
    assert.equal(calls.length, 1);
});

test('permission setup failure remains pending for retry without creating documents', async t => {
    t.mock.method(CryptoUtils, 'encryptSensitiveSettings', async (settings: any) => settings);
    const uploader = plugin({ transferDocumentOwnership: async () => { throw Error('403'); } }, [
        record('parent'), { ...record('new-child'), needsPermissionSetup: true }
    ]);
    uploader.settings.userId = 'test-user';
    await assert.rejects(uploader.configureNewReferences('parent', [{ docToken: 'new-child' }]), /下次同步会重试/);
    assert.equal(uploader.settings.uploadHistory[1].needsPermissionSetup, true);
    let grants = 0;
    uploader.feishuClient.transferDocumentOwnership = async () => { grants++; return true; };
    await uploader.configureNewReferences('parent', [{ docToken: 'new-child' }]);
    assert.equal(grants, 1);
    assert.equal(uploader.settings.uploadHistory[1].needsPermissionSetup, undefined);
});

test('explicit binding changes the next target without writing to Feishu', async () => {
    const uploader = plugin({}, [record('newer', note.path), record('chosen')]);
    await uploader.bindHistoryDocument('chosen', note.path);
    assert.equal(findSyncTarget(note, uploader.settings.uploadHistory, [note])?.docToken, 'chosen');
    await assert.rejects(uploader.bindHistoryDocument('chosen', 'missing.md'), /完整相对路径/);
});

test('overlapping uploads of the same document are rejected and release their lock', async () => {
    let finish: () => void = () => {};
    const uploader = plugin({ uploadDocumentWithImageInfos: () => new Promise(resolve => { finish = () => resolve({ token: 'new', url: 'url' }); }) });
    const first = uploader.publishPreparedDocument(note, 'first');
    await assert.rejects(uploader.publishPreparedDocument(note, 'second'), /正在上传/);
    finish();
    await first;
    assert.equal(uploader.publishing.size, 0);
});

test('linked notes use the shared publisher and propagate sync errors', async () => {
    let calls = 0;
    const app = { vault: { getMarkdownFiles: () => [note], read: async () => 'child' } } as any;
    const context = { settings: { folderToken: 'folder' }, publishPreparedDocument: async (...args: any[]) => {
        calls++;
        assert.equal(args[5], true);
        return { token: 'doc', url: 'stable', title: 'task', updated: true };
    } };
    const results = await new LinkProcessor(app, {} as any, context).processWikiLinks('[[task]]');
    assert.equal(calls, 1);
    assert.equal(results.uploadResults.get('task')?.updated, true);
    context.publishPreparedDocument = async () => { throw new DocumentSyncError('update failed'); };
    await assert.rejects(new LinkProcessor(app, {} as any, context).processWikiLinks('[[task]]'), /update failed/);
});

test('strict image updates only use supplied blocks and chain native revision numbers', async () => {
    const client = new FeishuApiClient('fake', 'fake', undefined) as any;
    client.getDocumentBlocks = async () => { throw Error('must not read old images'); };
    client.readImageFileAsBase64 = async () => ({ base64: 'image', width: 10, height: 10 });
    client.uploadImageMaterial = async () => 'image-token';
    const revisions: number[] = [], ids: string[] = [];
    client.updateDocumentBlock = async (_doc: string, id: string, _token: string, _info: any, revision: number) => {
        ids.push(id); revisions.push(revision); return revision + 1;
    };
    let lastRevision = 5;
    const options = { blocks: [{ block_id: 'new-image', block_type: 27 }], revision: 5, onRevision: (revision: number) => { lastRevision = revision; } };
    await client.processImagesInDocument('doc', infos, undefined, undefined, options);
    assert.deepEqual(ids, ['new-image']);
    assert.deepEqual(revisions, [5]);
    assert.equal(lastRevision, 6);
    client.uploadImageMaterial = async () => { throw Error('image 403'); };
    await assert.rejects(client.processImagesInDocument('doc', infos, undefined, undefined, options), /image 403/);
});

test('native API methods parse wrapped document revisions and send revisions for every mutation', async () => {
    const client = new FeishuApiClient('fake', 'fake', undefined) as any;
    client.getAccessToken = async () => 'test-token';
    const requests: any[] = [];
    setRequestHandler(async (request: any) => {
        requests.push(request);
        let data: any = { document_revision_id: 8 };
        if (request.url.endsWith('/documents/doc')) data = { document: { revision_id: 7 } };
        if (request.url.includes('/blocks?')) data = { items: [], has_more: false };
        if (request.url.includes('/descendant?')) data.block_id_relations = [{ temporary_block_id: 'tmp', block_id: 'real' }];
        return { status: 200, json: { code: 0, data } };
    });
    try {
        assert.equal(await client.getDocumentRevision('doc'), 7);
        await client.getDocumentBlocksDetailed('doc', 7);
        assert.equal((await client.createDocumentDescendants('doc', 'doc', -1, ['tmp'], [{ ...text('tmp'), parent_id: 'doc', revision_id: 0 }], 7)).block_id_relations[0].block_id, 'real');
        assert.equal(await client.updateDocumentBlock('doc', 'real', 'img-token', undefined, 8), 8);
        await client.batchDeleteDocumentBlocks('doc', 'doc', 0, 1, 8);
        assert.deepEqual(requests.slice(1).map(request => new URL(request.url).searchParams.get('document_revision_id')), ['7', '7', '8', '8']);
        assert.deepEqual(JSON.parse(requests[2].body).children_id, ['tmp']);
        assert.equal(JSON.parse(requests[2].body).descendants[0].parent_id, undefined);
        assert.equal(JSON.parse(requests[2].body).descendants[0].revision_id, undefined);
    } finally { setRequestHandler(undefined); }
});
