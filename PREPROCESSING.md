# 上传预处理脚本

本 fork 的 1.2.2 支持在上传前运行用户配置的 JavaScript 脚本。Excalidraw 转 PNG、清理内部标记、修改图片链接等都可以通过脚本扩展，无需再修改 ObShare 上传逻辑。

## 安装与配置

1. 下载本 fork 构建的 `main.js`、`manifest.json`、`styles.css`，替换库内 `.obsidian/plugins/obshare/` 中的对应文件。保留原有 `data.json`，其中存有你的飞书配置和上传记录。替换前可备份这三个插件文件。
2. 在 Obsidian 中关闭再启用 ObShare，或重启 Obsidian。
3. 在笔记库中建立 `Scripts/ObShare/` 文件夹，将 [excalidraw-to-png.js](examples/excalidraw-to-png.js) 保存为 `Scripts/ObShare/excalidraw-to-png.js`。这是实际的 `.js` 文件，不是包含代码块的 `.md` 笔记。
4. 打开 **设置 → ObShare → 上传预处理**，启用 **启用预处理脚本**，并在 **预处理脚本路径** 中填写：

   ```text
   Scripts/ObShare/excalidraw-to-png.js
   ```

5. 打开要上传的文档，通过命令 **ObShare: 预览上传预处理** 或设置中的 **预览预处理** 按钮检查 Markdown 和 PNG。确认后使用原有的分享命令上传。

默认关闭脚本执行。路径以笔记库根目录为起点，一行一个，空行忽略，不支持绝对路径或 `..`。隐藏文件夹中的脚本也通过 vault adapter 读取。以后增加脚本时追加路径；执行顺序从上到下，后一个脚本拿到前一个的输出。每次上传或预览都会重新读取脚本，不需要重启插件。

## 执行行为

主文档的顺序是：

```text
读取笔记 → 用户脚本 → 双链处理 → YAML/图片/Mermaid 处理 → 飞书上传
```

双链上传的引用文档在调用其原有上传流程之前也执行同一组脚本。当前双链上传仍遵循上游行为，仅处理主文档直接引用的文档；这个功能没有改为递归上传整棵引用树。

框架只修改内存中的上传副本，不写回原笔记。脚本加载、运行或返回值校验失败时，提示脚本路径和文档路径并停止上传，不回退到未经处理的原文。双链模式没有事务回滚：后续子文档失败时，之前已经上传成功的子文档可能仍留在飞书。

预览执行与上传相同的脚本，但 ObShare 不调用飞书上传接口，也不上传双链子文档；显示的是脚本处理完成、ObShare 自身转换尚未执行时的主文档内容。

**脚本在 Obsidian 插件环境中执行，拥有插件权限，不是沙箱。** 它们可以通过 `app`、`obsidian.requestUrl` 等访问文件或网络。预览也会执行这些脚本行为，因此只启用自己编写或审查过的脚本。框架不向脚本专门传入飞书凭证。

## 脚本接口

使用 CommonJS 的函数导出形式；顶层代码为普通 JavaScript，异步逻辑放入导出的函数：

```js
module.exports = async ({ content, file, app, obsidian, findWikiEmbeds, addImage }) => {
    // content: 当前上传副本的 Markdown，包含 frontmatter。
    // file: 当前文档的 Obsidian TFile；子文档拿到自己的 file。
    return content;
};
```

同步函数也可以使用。必须返回字符串；返回空字符串有效，返回 `undefined` 或对象视为错误。函数参数是每个脚本独立创建的上下文，修改 `context.content` 不会替代返回值。

| 参数 | 用途 |
| --- | --- |
| `content` | 上一个脚本输出的 Markdown；首个脚本拿到原笔记内容 |
| `file` | 当前处理文档的 `TFile`，可用 `file.path` 解析相对引用 |
| `app` | 当前 Obsidian `App`，包括 vault、metadataCache、workspace 等 |
| `obsidian` | Obsidian API 模块，例如 `parseLinktext`、`requestUrl`、`TFile` |
| `findWikiEmbeds(content)` | 返回当前内容中实际 `![[...]]` 嵌入的 `{from, to, original, link, alias?}`；跳过 YAML、代码、转义和注释 |
| `await addImage(blob, options?)` | 将图片登记到本次文档的内存图片表，返回可用于 Markdown 的临时路径 |

`findWikiEmbeds` 使用 Lezer Markdown 解析器，基于当前字符串计算偏移，而不是原笔记的缓存偏移。修改文本时应从后往前替换，避免偏移改变。它只提取 Wiki 嵌入，不包含普通 Markdown 图片链接。

`addImage` 接收非空 PNG/JPEG/GIF/WebP/BMP `Blob`。可选参数为 `{name, width, height}`，尺寸为正数。名称用于标识图片，返回的实际文件名包含唯一标识；始终使用返回路径，不要自行拼接。只提供宽度时按图片原比例计算高度；同时提供宽高时使用指定尺寸。图片仅保存在本次文档处理的内存中，不生成 vault 文件，不使用全局图片缓存。

```js
module.exports = async ({ content, addImage }) => {
    const png = await myRenderer(); // 返回 image/png Blob
    const path = await addImage(png, { name: 'diagram', width: 1100 });
    return content + `\n![示意图](${path})\n`;
};
```

这里提供的是函数导出约定，不是完整的 Node.js 模块加载器；没有注入 `require`，也不支持静态 `import`。Obsidian API 通过 `obsidian` 参数使用，其他插件通过 `app` 或其公开 API 使用。

## Excalidraw 示例

[excalidraw-to-png.js](examples/excalidraw-to-png.js) 将实际 Wiki 画板嵌入转换为 PNG 图片引用：

```md
![[示意图.excalidraw|1100]]
![[目录/示意图.excalidraw.md#^frame=流程|900]]
```

它使用已安装的 Excalidraw 插件及 `ExcalidrawAutomate.getAPI().createPNG()`，支持旧 `.excalidraw` 和 `.excalidraw.md` 画板，也可识别无后缀但被 Excalidraw 插件标记的画板。将框架、分组等 `#` 后缀交给 Excalidraw 渲染接口，具体语义取决于 Excalidraw 版本。`|1100` / `|1100x600` 尺寸交给内存图片接口；同一画板和片段在一次文档处理期间只渲染一次，多次嵌入仍保持各自的尺寸。

示例固定使用浅色、不透明背景和 2 倍 PNG 分辨率，适合飞书文档。可直接修改脚本中的 `createPNG` 参数。不需要启用 Excalidraw 自动导出 PNG，也不需要逐个修改原笔记的画板引用。导出不要求当前打开画板；它读取保存到 vault 的画板内容。

示例的 API 依据本机 Excalidraw 2.26.4 核对。自动化测试验证调用、文件解析、片段、尺寸、重复嵌入及资源清理；实际画板的字体、外部图片与复杂嵌入渲染效果，应使用预览核对。此版本未做真实飞书上传验收。

另有 [cleanup.js](examples/cleanup.js) 示例，移除 `<!-- obshare-private-start -->` 到 `<!-- obshare-private-end -->` 之间的内容。可以放在列表第一行，先清理内容再渲染画板。

## 开发验证

```sh
npm ci
npm test
npm run build
```

测试通过 esbuild 和 Node.js 原生测试运行器执行，不需要真实飞书凭证。`main.js` 是生成文件，修改 TypeScript 后用 `npm run build` 更新。
