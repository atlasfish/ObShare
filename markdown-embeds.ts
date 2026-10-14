import { parser } from '@lezer/markdown';

export interface WikiEmbed {
    from: number;
    to: number;
    original: string;
    link: string;
    alias?: string;
}

// Use the Markdown parser to exclude fenced/indented code, inline code and HTML comments.
const embedParser = parser.configure({
    defineNodes: ['WikiEmbed', 'ObsidianComment'],
    parseInline: [{
        name: 'WikiEmbed',
        before: 'Image',
        parse(cx, next, pos) {
            if (next !== 33 || cx.slice(pos, pos + 3) !== '![[') return -1;
            const match = /^!\[\[([^\]\n]+)\]\]/.exec(cx.slice(pos, cx.end));
            if (!match) return -1;
            return cx.addElement(cx.elt('WikiEmbed', pos, pos + match[0].length));
        }
    }, {
        name: 'ObsidianComment',
        before: 'Link',
        parse(cx, next, pos) {
            if (next !== 37 || cx.slice(pos, pos + 2) !== '%%') return -1;
            const end = cx.text.indexOf('%%', pos - cx.offset + 2);
            return cx.addElement(cx.elt('ObsidianComment', pos, end < 0 ? cx.end : cx.offset + end + 2));
        }
    }]
});

/** Parse the current upload copy, so earlier scripts can freely change its contents. */
function parseImageRanges(content: string): Array<{ from: number; to: number; wiki: boolean }> {
    // Frontmatter is not Markdown body. Mask it while preserving all offsets.
    const input = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/,
        value => value.replace(/[^\r\n]/g, ' '));
    const ranges: Array<{ from: number; to: number; wiki: boolean }> = [];
    const comments: Array<{ from: number; to: number }> = [];
    embedParser.parse(input).iterate({ enter(node) {
        if (node.name === 'ObsidianComment') {
            if (comments.some(comment => node.from >= comment.from && node.from < comment.to)) return;
            const end = content.indexOf('%%', node.from + 2);
            comments.push({ from: node.from, to: end < 0 ? content.length : end + 2 });
        } else if (node.name === 'WikiEmbed' || node.name === 'Image') {
            ranges.push({ from: node.from, to: node.to, wiki: node.name === 'WikiEmbed' });
        }
    }});
    return ranges.filter(range => !comments.some(comment => range.from >= comment.from && range.from < comment.to));
}

export function findImageRanges(content: string): Array<{ from: number; to: number }> {
    return parseImageRanges(content);
}

export function findWikiEmbeds(content: string): WikiEmbed[] {
    return parseImageRanges(content).filter(range => range.wiki).map(range => {
        const original = content.slice(range.from, range.to);
        const [link, ...aliases] = original.slice(3, -2).split('|');
        return { from: range.from, to: range.to, original, link: (link ?? '').trim(),
            ...(aliases.length ? { alias: aliases.join('|') } : {}) };
    });
}
