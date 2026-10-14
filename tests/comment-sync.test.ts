import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UploadPreprocessor } from '../upload-preprocessor';
import { syncDocumentComments, CloudComment, CommentExportState } from '../comment-sync';
import { FeishuApiClient } from '../feishu-api';
import FeishuUploaderPlugin from '../main';
import { CryptoUtils } from '../crypto-utils';
import { LinkProcessor } from '../link-processor';
import { TFile, setRequestHandler } from 'obsidian';

const note = new TFile('notes/task.md');
const script = () => readFile('examples/duet-to-comments.js', 'utf8');
const app = (sources: Record<string, string>, names = ['ai']) => ({
    plugins: { plugins: { duet: { settings: { profiles: names.map(name => ({ name })) } } } },
    vault: { adapter: { read: async (path: string) => sources[path] }, read: async () => sources['note'], getMarkdownFiles: () => [note] }
}) as any;
async function extract(content: string, names?: string[]) {
    return (await UploadPreprocessor.load(app({ 'duet.js': await script() }, names), ['duet.js'])).run(content, note);
}

test('Duet paired exchanges become comments while prose and other callouts stay in the body', async () => {
    const result = await extract('正文 @ai: 请解释\n> [!agent]+ Ai\n> 回答\n>\n> 第二段\n> [!note]\n> 保留\n结尾\n');
    assert.equal(result.content, '正文\n> [!note]\n> 保留\n结尾\n');
    assert.equal(result.comments.length, 1);
    assert.match(result.comments[0]!.text, /提问：\n@ai: 请解释/);
    assert.match(result.comments[0]!.text, /Ai 回答：\n回答\n\n第二段/);
});

test('code, comments, YAML, quoted examples and ordinary prose are preserved', async () => {
    const content = '---\nx: "@ai example"\n---\n```md\n@ai example\n> [!agent]+ Ai\n> example\n```\n'
        + '~~~md\n@ai example\n~~~\n    @ai example\n`@ai example`\n<!--\n@ai example\n-->\n%%\n@ai example\n%%\n> @ai example\n> [!note]\n> ordinary\nregular text\n';
    const result = await extract(content);
    assert.equal(result.content, content);
    assert.equal(result.comments.length, 0);
});

test('configured names and removed profiles with paired replies are recognized; CRLF survives', async () => {
    const result = await extract('- @helper, request\r\n> [!agent]- Helper\r\n> answer\r\n\r\n@retired request\r\n> [!agent]+ Old\r\n> old answer\r\nend\r\n', ['helper']);
    assert.equal(result.content, '\r\nend\r\n');
    assert.equal(result.comments.length, 2);
});

test('quoted code with a callout example remains inside the exported answer', async () => {
    const result = await extract('@ai code\n> [!agent]+ Ai\n> ```md\n> [!note]\n> > nested\n> ```\n> done\nbody\n');
    assert.equal(result.content, 'body\n');
    assert.match(result.comments[0]!.text, /```md\n\[!note\]\n> nested\n```\ndone/);
});

test('request identity survives answer edits and unrelated lines; repeated questions have distinct keys', async () => {
    const first = await extract('@ai same\n> [!agent]+ Ai\n> first\n\n@ai same\n> [!agent]+ Ai\n> second\n');
    const second = await extract('new heading\n@ai same\n> [!agent]+ Ai\n> changed\n\n@ai same\n> [!agent]+ Ai\n> second\n');
    assert.deepEqual(second.comments.map(c => c.key), first.comments.map(c => c.key));
    assert.notEqual(first.comments[0]!.key, first.comments[1]!.key);
});

test('unanswered requests and orphan agent replies are retained as comments', async () => {
    const result = await extract('@ai unanswered\nordinary\n> [!agent]+ Ai\n> orphan\nend');
    assert.equal(result.content, 'ordinary\nend');
    assert.equal(result.comments.length, 2);
    assert.match(result.comments[0]!.text, /暂无回复/);
    assert.match(result.comments[1]!.text, /原提问已移除/);
});

test('comment collection is isolated per document and namespaces script keys', async () => {
    const source = `module.exports=({content,addComment})=>{addComment({key:'same',text:'text'});return content;}`;
    const pipeline = await UploadPreprocessor.load(app({ 'a.js': source, 'b.js': source }), ['a.js', 'b.js']);
    const first = await pipeline.run('body', note), second = await pipeline.run('other', new TFile('other.md'));
    assert.equal(first.comments.length, 2);
    assert.notEqual(first.comments[0]!.key, first.comments[1]!.key);
    assert.deepEqual(first.comments, second.comments);
    assert.notEqual(first.comments, second.comments);
});

test('invalid or duplicate comment keys abort preprocessing', async () => {
    for (const argument of [`{key:'',text:'x'}`, `{key:'a',text:''}`]) {
        const pipeline = await UploadPreprocessor.load(app({ 'a.js': `module.exports=({addComment})=>{addComment(${argument});return '';}` }), ['a.js']);
        await assert.rejects(pipeline.run('', note), /addComment/);
    }
    const pipeline = await UploadPreprocessor.load(app({ 'a.js': `module.exports=({addComment})=>{addComment({key:'a',text:'x'});addComment({key:'a',text:'y'});return '';}` }), ['a.js']);
    await assert.rejects(pipeline.run('', note), /必须唯一/);
});

function cloud() {
    const items: CloudComment[] = [];
    let creates = 0, updates = 0;
    const client = {
        listDocumentComments: async () => structuredClone(items),
        createDocumentComment: async (_token: string, text: string) => {
            creates++;
            const item = { comment_id: `c${creates}`, reply_list: { replies: [{ reply_id: `r${creates}`, content: { elements: [{ type: 'text_run', text_run: { text } }] } }] } };
            items.push(item);
            return structuredClone(item);
        },
        updateDocumentComment: async (_token: string, id: string, replyId: string, text: string) => {
            updates++;
            items.find(item => item.comment_id === id)!.reply_list.replies.find(reply => reply.reply_id === replyId)!.content.elements = [{ type: 'text_run', text_run: { text } }];
        }
    };
    return { client, items, counts: () => ({ creates, updates }) };
}
const state = (): CommentExportState => ({ namespace: 'persistent-document-identity', bindings: {} });
const comments = [{ key: 'stable-question', text: 'question\nanswer' }];
const save = async () => {};

test('repeat sync skips identical comments and updates changed answers without touching manual comments', async () => {
    const c = cloud(), s = state();
    c.items.push({ comment_id: 'manual', reply_list: { replies: [{ reply_id: 'manual-r', content: { elements: [{ type: 'text_run', text_run: { text: 'manual' } }] } }] } });
    await syncDocumentComments(c.client, 'doc', comments, s, save);
    await syncDocumentComments(c.client, 'doc', comments, s, save);
    await syncDocumentComments(c.client, 'doc', [{ ...comments[0]!, text: 'changed answer' }], s, save);
    assert.deepEqual(c.counts(), { creates: 1, updates: 1 });
    assert.equal(c.items[0]!.reply_list.replies[0]!.content.elements[0]!.text_run!.text, 'manual');
    assert.equal(Object.keys(s.bindings).length, 1);
});

test('lost create response and failed local persistence recover through cloud marker', async () => {
    for (const failure of ['response', 'save']) {
        const c = cloud(), s = state(), create = c.client.createDocumentComment;
        if (failure === 'response') c.client.createDocumentComment = async (...args) => { await create(...args); throw Error('response lost'); };
        await assert.rejects(syncDocumentComments(c.client, 'doc', comments, s, failure === 'save' ? async () => { throw Error('disk failed'); } : save));
        c.client.createDocumentComment = create;
        // Simulate restart with only the durable namespace, not in-memory bindings.
        await syncDocumentComments(c.client, 'doc', comments, state(), save);
        assert.equal(c.counts().creates, 1);
    }
});

test('listing failure prevents writes; marker edits do not silently create duplicates', async () => {
    const c = cloud(), s = state();
    await assert.rejects(syncDocumentComments({ ...c.client, listDocumentComments: async () => { throw Error('403'); } }, 'doc', comments, s, save), /403/);
    assert.equal(c.counts().creates, 0);
    await syncDocumentComments(c.client, 'doc', comments, s, save);
    c.items[0]!.reply_list.replies[0]!.content.elements[0]!.text_run!.text = 'manually changed';
    await assert.rejects(syncDocumentComments(c.client, 'doc', comments, s, save), /标记被修改/);
    assert.equal(c.counts().creates, 1);
});

test('long Unicode replies split deterministically without breaking surrogate pairs', async () => {
    const c = cloud(), s = state(), text = '😀'.repeat(6001);
    await syncDocumentComments(c.client, 'doc', [{ key: 'long', text }], s, save);
    await syncDocumentComments(c.client, 'doc', [{ key: 'long', text }], s, save);
    assert.equal(c.counts().creates, 3);
    const restored = c.items.map(item => item.reply_list.replies[0]!.content.elements[0]!.text_run!.text.split('\n').slice(2).join('\n')).join('');
    assert.equal(restored, text);
});

test('comment API uses native schemas and paginates unresolved and solved global comments', async () => {
    const client = new FeishuApiClient('fake', 'fake', undefined);
    client.getAccessToken = async () => 'fake-token';
    const requests: any[] = [];
    setRequestHandler((request: any) => {
        requests.push(request);
        const query = new URL(request.url).searchParams;
        const data = request.method === 'GET' ? { items: [], has_more: query.get('is_solved') === 'false' && !query.has('page_token'), page_token: 'next' }
            : request.method === 'POST' ? { comment_id: 'c', reply_list: { replies: [{ reply_id: 'r' }] } } : {};
        return { json: { code: 0, data } };
    });
    try {
        await client.listDocumentComments('doc');
        await client.createDocumentComment('doc', 'question and answer');
        await client.updateDocumentComment('doc', 'c', 'r', 'changed');
        assert.deepEqual(requests.slice(0, 3).map(r => new URL(r.url).searchParams.get('is_solved')), ['false', 'false', 'true']);
        assert.ok(requests.slice(0, 3).every(r => new URL(r.url).searchParams.get('is_whole') === 'true'));
        assert.equal(JSON.parse(requests[3].body).reply_list.replies[0].content.elements[0].text_run.text, 'question and answer');
        assert.equal(requests[4].method, 'PUT');
        assert.match(requests[4].url, /comments\/c\/replies\/r\?file_type=docx$/);
    } finally { setRequestHandler(undefined); }
});

test('publisher persists identity before comment creation and retains body history on comment failure', async t => {
    t.mock.method(CryptoUtils, 'encryptSensitiveSettings', async (settings: any) => settings);
    const uploader = Object.create(FeishuUploaderPlugin.prototype) as any;
    uploader.settings = { uploadHistory: [], updateExistingDocuments: false, uploadCount: 0, folderToken: '' };
    uploader.app = app({});
    uploader.publishing = new Set();
    let persisted: any;
    uploader.saveData = async (data: any) => { persisted = structuredClone(data); };
    uploader.feishuClient = {
        uploadDocumentWithImageInfos: async () => ({ token: 'doc', url: 'url' }),
        listDocumentComments: async () => [],
        createDocumentComment: async () => {
            assert.ok(persisted.uploadHistory[0].commentExport.namespace);
            throw Error('403');
        }
    };
    const result = await uploader.publishPreparedDocument(note, 'body', undefined, undefined, undefined, false, comments);
    assert.equal(result.token, 'doc');
    assert.equal(uploader.settings.uploadHistory[0].sourcePath, note.path);
    assert.equal(uploader.publishing.size, 0);
});

test('linked notes pass collected comments to the shared publisher', async () => {
    const mockApp = app({ 'note': '@ai question\n> [!agent]+ Ai\n> answer', 'duet.js': await script() });
    const pipeline = await UploadPreprocessor.load(mockApp, ['duet.js']);
    const context = { settings: { folderToken: '' }, publishPreparedDocument: async (...args: any[]) => {
        assert.equal(args[1], '');
        assert.equal(args[5], true);
        assert.equal(args[6].length, 1);
        return { token: 'doc', url: 'url', title: 'task' };
    } };
    const result = await new LinkProcessor(mockApp, {} as any, context, pipeline).processWikiLinks('[[task]]');
    assert.equal(result.uploadResults.size, 1);
});
