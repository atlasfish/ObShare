import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UploadPreprocessor, parseScriptPaths, PreprocessError } from '../upload-preprocessor';
import { findWikiEmbeds, findImageRanges } from '../markdown-embeds';
import { FeishuApiClient } from '../feishu-api';
import { LinkProcessor } from '../link-processor';
import FeishuUploaderPlugin from '../main';
import { TFile } from 'obsidian';

const note = new TFile('notes/source.md');
const mockApp = (sources: Record<string, string>, files: TFile[] = []) => ({
    vault: {
        adapter: { read: async (path: string) => { if (!(path in sources)) throw new Error('文件不存在'); return sources[path]!; } },
        read: async (file: TFile) => sources[file.path]!,
        getMarkdownFiles: () => files
    }
}) as any;
const pngScript = `module.exports = async ({ content, addImage }) => {
    const path = await addImage(new Blob(['png-bytes'], { type: 'image/png' }), { width: 300 });
    return content + '\\n![drawing](' + path + ')';
};`;

test('parse Windows path list', () => {
    assert.deepEqual(parseScriptPaths(' a.js\r\n\r\n b.js \n'), ['a.js', 'b.js']);
});
test('empty pipeline preserves source', async () => {
    const result = await (await UploadPreprocessor.load(mockApp({}), [])).run('source', note);
    assert.equal(result.content, 'source');
    assert.equal(result.images.size, 0);
});
test('scripts await one another and receive context', async () => {
    const app = mockApp({
        'a.js': `module.exports = async ({content, file, obsidian}) => {
            await Promise.resolve(); return content + ':' + file.path + ':' + obsidian.parseLinktext('a#b').subpath;
        }`,
        'b.js': `module.exports = ({content}) => content.toUpperCase()`
    });
    const result = await (await UploadPreprocessor.load(app, ['a.js', 'b.js'])).run('body', note);
    assert.equal(result.content, 'BODY:NOTES/SOURCE.MD:#B');
});
test('next upload reloads changed scripts', async () => {
    const sources = { 'a.js': 'module.exports = () => "first"' };
    const app = mockApp(sources);
    assert.equal((await (await UploadPreprocessor.load(app, ['a.js'])).run('', note)).content, 'first');
    sources['a.js'] = 'module.exports = () => "second"';
    assert.equal((await (await UploadPreprocessor.load(app, ['a.js'])).run('', note)).content, 'second');
});
for (const [name, source] of [
    ['invalid export', 'module.exports = {}'], ['syntax error', 'module.exports = ('], ['top-level error', 'throw Error("broken")']
]) test(`loading fails explicitly: ${name}`, async () => {
    await assert.rejects(UploadPreprocessor.load(mockApp({ 'bad.js': source! }), ['bad.js']), /bad.js/);
});
test('missing script aborts', async () => {
    await assert.rejects(UploadPreprocessor.load(mockApp({}), ['missing.js']), /missing.js.*文件不存在/);
});
for (const path of ['C:\\scripts\\a.js', '../a.js', '/a.js', 'a.ts']) {
    test(`reject invalid path: ${path}`, async () => {
        await assert.rejects(UploadPreprocessor.load(mockApp({}), [path]), /库内 .js/);
    });
}
test('runtime errors stop later scripts and include script/document', async () => {
    const app = mockApp({ 'a.js': 'module.exports = async () => { throw Error("stop"); }', 'b.js': 'module.exports = () => { throw Error("must not run"); }' });
    const pipeline = await UploadPreprocessor.load(app, ['a.js','b.js']);
    await assert.rejects(pipeline.run('body', note), /a.js.*notes\/source.md.*stop/);
});
test('undefined return fails; empty string is valid', async () => {
    await assert.rejects((await UploadPreprocessor.load(mockApp({ 'a.js': 'module.exports = () => {}' }), ['a.js'])).run('', note), /返回 Markdown/);
    assert.equal((await (await UploadPreprocessor.load(mockApp({ 'a.js': 'module.exports = () => ""' }), ['a.js'])).run('body', note)).content, '');
});
test('generated images stay in memory and have document isolation', async () => {
    const pipeline = await UploadPreprocessor.load(mockApp({ 'image.js': pngScript }), ['image.js']);
    const first = await pipeline.run('body', note), second = await pipeline.run('body',new TFile('other.md'));
    assert.equal(first.images.size,1);
    const path = [...first.images.keys()][0]!;
    assert.ok(first.content.includes(path));
    assert.equal(first.images.get(path)!.base64,btoa('png-bytes'));
    assert.equal(first.images.get(path)!.width,300);
    assert.ok(!second.images.has(path));
});
test('parallel addImage calls get unique names', async () => {
    const pipeline = await UploadPreprocessor.load(mockApp({ 'a.js': `module.exports = async ({addImage}) => {
        const blob = new Blob(['png'],{type:'image/png'}); return (await Promise.all([addImage(blob),addImage(blob)])).join(' ');
    }` }), ['a.js']);
    assert.equal((await pipeline.run('',note)).images.size,2);
});
test('invalid image type fails explicitly', async () => {
    const pipeline = await UploadPreprocessor.load(mockApp({'a.js': `module.exports = async ({addImage}) => addImage(new Blob(['x'],{type:'text/plain'}))`}),['a.js']);
    await assert.rejects(pipeline.run('',note), /addImage/);
});
test('parse embeds outside code, comments, escapes and frontmatter', () => {
    const content = '---\nx: "![[yaml.excalidraw]]"\n---\n'
        + '`![[inline.excalidraw]]`\n\n```md\n![[fenced.excalidraw]]\n```\n\n'
        + '    ![[indented.excalidraw]]\n\n<!-- ![[html.excalidraw]] -->\n\n'
        + '%% ![[comment.excalidraw]]\n\n![[comment2.excalidraw]] %%\n\n'
        + '\\![[escaped.excalidraw]]\n\n> [!note]\n> ![[folder/真实画板.excalidraw#^frame=流程|1100]]\n';
    const embeds = findWikiEmbeds(content);
    assert.equal(embeds.length,1);
    assert.equal(embeds[0]!.link,'folder/真实画板.excalidraw#^frame=流程');
    assert.equal(embeds[0]!.alias,'1100');
    assert.equal(content.slice(embeds[0]!.from,embeds[0]!.to),embeds[0]!.original);
});
test('parse repeated embeds in current content after preceding scripts', () => {
    assert.equal(findWikiEmbeds('new prefix\n![[a.excalidraw]] ![[a.excalidraw]]').length,2);
    assert.equal(findImageRanges('`![code](code.png)` ![real](real.png)').length,1);
});
test('both image collectors skip code and preserve real image order', () => {
    const content = '`![[code.excalidraw]]`\n![first](first.png)\n![second](second.png)';
    assert.deepEqual(FeishuApiClient.extractImageInfoFromMarkdown(content).map(info => info.fileName),['first.png','second.png']);
    const infos = (FeishuUploaderPlugin.prototype as any).collectAllImageInfos(content);
    assert.deepEqual(infos.map((info:any) => info.info.fileName),['first.png','second.png']);
});
test('linked note is preprocessed and receives its generated images', async () => {
    const child = new TFile('child.md'), app = mockApp({'child.md':'child','image.js':pngScript},[child]);
    const pipeline = await UploadPreprocessor.load(app,['image.js']);
    const calls: any[] = [];
    const client = {uploadDocument: async (...args:any[]) => {calls.push(args); return {token:'t',url:'https://example.test/doc'};}} as any;
    await new LinkProcessor(app,client,{settings:{folderToken:'folder'}},pipeline).processWikiLinks('[[child]] ![[child]]');
    assert.equal(calls.length,1);
    assert.match(calls[0][1],/^child\n!\[drawing\]/);
    assert.equal(calls[0][4].size,1);
});
test('linked note script error propagates before upload', async () => {
    const child = new TFile('child.md'), app = mockApp({'child.md':'child','bad.js':'module.exports = () => {throw Error("bad child");}'},[child]);
    const pipeline = await UploadPreprocessor.load(app,['bad.js']);
    const client = {uploadDocument: () => {throw Error('Should not upload');}} as any;
    await assert.rejects(new LinkProcessor(app,client,{settings:{folderToken:'folder'}},pipeline).processWikiLinks('[[child]]'),PreprocessError);
});
test('image pipeline uses memory bytes, dimensions and ordering', async () => {
    const client = new FeishuApiClient('fake','fake') as any;
    client.getDocumentBlocks = async () => [{block_id:'b1',block_type:27},{block_id:'b2',block_type:27}];
    client.getPngDimensionsFromBase64 = async () => ({width:1000,height:500});
    const uploads:any[] = [], updates:any[] = [];
    client.uploadImageMaterial = async (...args:any[]) => {uploads.push(args);return 'img-token';};
    client.updateDocumentBlock = async (...args:any[]) => updates.push(args);
    const images = new Map([['first.png',{base64:'first',width:300}],['second.png',{base64:'second',width:500}]]);
    await client.processImagesInDocument('doc',[
        {path:'C:/vault/first.png',fileName:'first.png',position:0}, {path:'second.png',fileName:'second.png',position:1}
    ],undefined,images);
    assert.deepEqual(uploads.map(args => args[1]),['first','second']);
    assert.equal(updates[0][3].width,300);
    assert.equal(updates[0][3].height,150);
    assert.equal(updates[1][3].height,250);
});
test('image pipeline surfaces upload failure and missing blocks', async () => {
    const client = new FeishuApiClient('fake','fake') as any;
    const images = new Map([['image.png',{base64:'png'}]]), infos = [{path:'image.png',fileName:'image.png',position:0}];
    client.getDocumentBlocks = async () => [];
    await assert.rejects(client.processImagesInDocument('doc',infos,undefined,images),/缺少预处理/);
    client.getDocumentBlocks = async () => [{block_id:'b',block_type:27}];
    client.getPngDimensionsFromBase64 = async () => null;
    client.uploadImageMaterial = async () => {throw Error('403');};
    await assert.rejects(client.processImagesInDocument('doc',infos,undefined,images),/403/);
});
test('Excalidraw example resolves Markdown drawings, exports fragments and widths, and disposes EA', async () => {
    const source = await readFile('examples/excalidraw-to-png.js','utf8'), drawing = new TFile('drawings/diagram.excalidraw.md');
    const app = mockApp({'example.js':source});
    app.plugins = {plugins:{'obsidian-excalidraw-plugin':{isExcalidrawFile:(file:TFile) => file === drawing}}};
    app.metadataCache = {getFirstLinkpathDest:(path:string) => path === 'diagram.excalidraw.md' ? drawing : null};
    let disposed = 0;
    const targets:string[] = [];
    (globalThis as any).ExcalidrawAutomate = {getAPI:() => ({
        createPNG:async (path:string) => {targets.push(path);return new Blob(['png'],{type:'image/png'});},
        getExportSettings:() => ({}),destroy:() => {disposed++;}
    })};
    const input = '`![[diagram.excalidraw]]`\n![[diagram.excalidraw#^frame=Flow|1100]]\n![[diagram.excalidraw#^frame=Flow|500]]';
    const result = await (await UploadPreprocessor.load(app,['example.js'])).run(input,note);
    assert.deepEqual(targets,['drawings/diagram.excalidraw.md#^frame=Flow']);
    assert.equal(disposed,1);
    assert.equal(result.images.size,2);
    assert.deepEqual([...result.images.values()].map(image => image.width),[500,1100]);
    assert.ok(result.content.startsWith('`![[diagram.excalidraw]]`'));
    delete (globalThis as any).ExcalidrawAutomate;
});
test('Excalidraw rendering failure still disposes EA', async () => {
    const source = await readFile('examples/excalidraw-to-png.js','utf8'), drawing = new TFile('diagram.excalidraw.md');
    const app = mockApp({'example.js':source});
    app.plugins = {plugins:{'obsidian-excalidraw-plugin':{isExcalidrawFile:() => true}}};
    app.metadataCache = {getFirstLinkpathDest:() => drawing};
    let disposed = 0;
    (globalThis as any).ExcalidrawAutomate = {getAPI:() => ({createPNG:async () => {throw Error('render failed');},getExportSettings:() => ({}),destroy:() => {disposed++;}})};
    await assert.rejects((await UploadPreprocessor.load(app,['example.js'])).run('![[diagram.excalidraw]]',note),/render failed/);
    assert.equal(disposed,1);
    delete (globalThis as any).ExcalidrawAutomate;
});
