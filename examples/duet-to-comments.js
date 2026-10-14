// Moves Duet inline requests/replies to full-document plain-text comments.
// Run before image rendering. The source note is never edited.
module.exports = ({ content, app, addComment }) => {
    const profiles = app?.plugins?.plugins?.duet?.settings?.profiles;
    const names = Array.isArray(profiles)
        ? profiles.map(profile => profile.name).filter(name => typeof name === 'string' && name)
        : [];
    const agents = names.length ? names : ['ai', 'claude', 'codex'];
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The tag boundary and optional colon/comma follow Duet's findMention().
    const request = new RegExp(`(^|[\\s([{])@(?:${agents.map(escape).join('|')})(?![\\w-])[:,]?\\s+\\S`, 'i');
    // A paired reply also identifies requests from renamed/deleted agent profiles.
    const pairedRequest = /(^|[\s([{])@[^\s,:()[\]{}@]+[:,]?\s+\S/;
    const header = /^ {0,3}>[ \t]*\[!agent\](?:[+-])?(?:[ \t]|$)/i;
    const quote = /^ {0,3}>/;
    const otherCallout = /^ {0,3}>[ \t]*\[![^\]]+\]/;
    const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
    const bodies = lines.map(line => line.replace(/[\r\n]+$/, ''));
    const output = [];
    let frontmatter = /^\uFEFF?---[ \t]*$/.test(bodies[0] ?? '');
    let fence;
    let commentEnd;
    let inReply = false;
    let dialogue;
    let replyFence;
    const occurrences = new Map();
    const flush = () => {
        if (!dialogue) return;
        const identity = dialogue.request || `agent:${dialogue.title}`;
        const ordinal = occurrences.get(identity) || 0;
        occurrences.set(identity, ordinal + 1);
        addComment({
            key: JSON.stringify([identity, ordinal]),
            text: `Duet 行间对话\n\n提问：\n${dialogue.request || '（原提问已移除）'}\n\n${dialogue.title || 'AI'} 回答：\n${dialogue.answer.join('\n').trim() || '（暂无回复）'}`
        });
        dialogue = undefined;
    };

    // Mask comments and inline code while retaining offsets into the original line.
    const visibleText = line => {
        let visible = '';
        for (let at = 0; at < line.length;) {
            if (commentEnd) {
                const end = line.indexOf(commentEnd, at);
                const to = end < 0 ? line.length : end + commentEnd.length;
                visible += ' '.repeat(to - at);
                at = to;
                if (end >= 0) commentEnd = undefined;
            } else if (line.startsWith('<!--', at) || line.startsWith('%%', at)) {
                commentEnd = line.startsWith('<!--', at) ? '-->' : '%%';
                const size = commentEnd === '-->' ? 4 : 2;
                visible += ' '.repeat(size);
                at += size;
            } else if (line[at] === '`') {
                const run = /^`+/.exec(line.slice(at))[0];
                let end = line.indexOf(run, at + run.length);
                while (end >= 0 && (line[end - 1] === '`' || line[end + run.length] === '`')) {
                    end = line.indexOf(run, end + run.length);
                }
                const to = end < 0 ? at + run.length : end + run.length;
                visible += end < 0 ? run : ' '.repeat(to - at);
                at = to;
            } else {
                visible += line[at++];
            }
        }
        return visible;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i], body = bodies[i];
        if (frontmatter) {
            output.push(line);
            if (i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(body)) frontmatter = false;
            continue;
        }
        if (fence) {
            output.push(line);
            if (new RegExp(`^ {0,3}${fence.char}{${fence.size},}[ \\t]*$`).test(body)) fence = undefined;
            continue;
        }
        if (inReply) {
            // Nested quotes belong to the reply; a new sibling callout belongs to the note.
            if (quote.test(body) && (replyFence || !otherCallout.test(body))) {
                const answer = body.replace(/^ {0,3}>[ \t]?/, '');
                dialogue.answer.push(answer);
                if (replyFence) {
                    if (new RegExp(`^ {0,3}${replyFence.char}{${replyFence.size},}[ \\t]*$`).test(answer)) replyFence = undefined;
                } else {
                    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(answer);
                    if (opening) replyFence = { char: opening[1][0], size: opening[1].length };
                }
                continue;
            }
            inReply = false;
            replyFence = undefined;
            flush();
        }
        const visible = visibleText(body);
        if (dialogue && body.trim() && !header.test(visible)) flush();
        const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(visible);
        if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
            fence = { char: openingFence[1][0], size: openingFence[1].length };
            output.push(line);
            continue;
        }
        if (header.test(visible)) {
            if (!dialogue) dialogue = { request: '', title: '', answer: [] };
            dialogue.title = body.replace(header, '').trim();
            inReply = true;
            continue;
        }
        if (!/^ {4}|^\t|^\s*>/.test(body)) {
            let next = i + 1;
            while (next < bodies.length && !bodies[next].trim()) next++;
            const match = request.exec(visible) ?? (header.test(bodies[next] ?? '') ? pairedRequest.exec(visible) : null);
            if (match) {
                flush();
                dialogue = { request: body.slice(match.index + match[1].length).trim(), title: '', answer: [] };
                const prefix = body.slice(0, match.index + match[1].length).trimEnd();
                // Preserve prose before an inline request; discard a standalone list marker.
                if (prefix && !/^(?:[-+*]|\d+[.)])(?:\s+\[[ xX-]\])?$/.test(prefix)) {
                    output.push(prefix + line.slice(body.length));
                }
                continue;
            }
        }
        output.push(line);
    }
    flush();
    return output.join('');
};
