// Copy into your vault, e.g. Scripts/ObShare/excalidraw-to-png.js.
// Excalidraw rendering belongs in this script, not in ObShare's upload pipeline.
module.exports = async ({ content, file, app, obsidian, findWikiEmbeds, addImage }) => {
    const plugin = app.plugins.plugins['obsidian-excalidraw-plugin'];
    const drawings = [];
    for (const embed of findWikiEmbeds(content)) {
        const { path, subpath } = obsidian.parseLinktext(embed.link);
        const drawing = app.metadataCache.getFirstLinkpathDest(path, file.path)
            ?? app.metadataCache.getFirstLinkpathDest(path + '.md', file.path);
        const looksLikeDrawing = /\.excalidraw(?:\.md)?$/i.test(path);
        if (!drawing) {
            if (looksLikeDrawing) throw new Error(`找不到画板：${embed.link}`);
            continue;
        }
        if (!plugin?.isExcalidrawFile(drawing)) {
            if (looksLikeDrawing) throw new Error('请启用 Excalidraw 插件并确认画板有效');
            continue;
        }
        drawings.push({ embed, drawing, subpath });
    }
    if (drawings.length === 0) return content;
    const automate = globalThis.ExcalidrawAutomate;
    if (!automate?.getAPI) throw new Error('Excalidraw Automate API 未就绪');
    const ea = automate.getAPI();
    const rendered = new Map();
    try {
        // Replace from the end to retain positions, including repeated embeds.
        for (const { embed, drawing, subpath } of drawings.reverse()) {
            const target = drawing.path + subpath;
            let png = rendered.get(target);
            if (!png) {
                // Opaque light background is suitable for Feishu. Change these options freely.
                png = await ea.createPNG(target, 2, ea.getExportSettings(true, false), undefined, 'light');
                if (!png) throw new Error(`画板导出失败：${embed.link}`);
                rendered.set(target, png);
            }
            const dimensions = /^(\d+)(?:x(\d+))?$/.exec(embed.alias?.trim() ?? '');
            const imagePath = await addImage(png, {
                name: drawing.basename,
                ...(dimensions ? { width: Number(dimensions[1]) } : {}),
                ...(dimensions?.[2] ? { height: Number(dimensions[2]) } : {})
            });
            const alt = drawing.basename.replace(/[\[\]\\\r\n]/g, '_');
            content = content.slice(0, embed.from) + `![${alt}](${imagePath})` + content.slice(embed.to);
        }
        return content;
    } finally {
        ea.destroy();
    }
};
