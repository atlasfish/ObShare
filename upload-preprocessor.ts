import * as obsidian from 'obsidian';
import { App, TFile, normalizePath } from 'obsidian';
import { findWikiEmbeds } from './markdown-embeds';

export interface GeneratedImage {
    base64: string;
    width?: number;
    height?: number;
}

export interface ImageOptions {
    name?: string;
    width?: number;
    height?: number;
}

export interface PreprocessContext {
    content: string;
    file: TFile;
    app: App;
    obsidian: typeof obsidian;
    findWikiEmbeds: typeof findWikiEmbeds;
    /** Returns a temporary image path to use in Markdown, without writing a vault file. */
    addImage: (image: Blob, options?: ImageOptions) => Promise<string>;
}

export interface PreprocessResult {
    content: string;
    images: Map<string, GeneratedImage>;
}

type Script = (context: PreprocessContext) => string | Promise<string>;
type LoadedScript = { path: string; run: Script };

export class PreprocessError extends Error {
    constructor(path: string, file: string, error: unknown) {
        super(`预处理脚本 ${path}（${file}）失败: ${error instanceof Error ? error.message : String(error)}`);
        this.name = 'PreprocessError';
    }
}

export function parseScriptPaths(value: string): string[] {
    return value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
}

/** One compiled pipeline per upload; each document gets an isolated image map. */
export class UploadPreprocessor {
    private constructor(private app: App, private scripts: LoadedScript[]) {}

    static async load(app: App, paths: string[]): Promise<UploadPreprocessor> {
        const scripts: LoadedScript[] = [];
        for (const path of paths) {
            try {
                // Deliberately vault-relative; don't silently reinterpret an absolute path.
                if (/^(?:[/\\]|[A-Za-z]:)/.test(path) || path.split(/[/\\]/).includes('..') || !path.endsWith('.js')) {
                    throw new Error('请使用库内 .js 文件的相对路径');
                }
                const source = await app.vault.adapter.read(normalizePath(path));
                const module: { exports: unknown } = { exports: {} };
                // Same CommonJS function convention used by Obsidian user-script plugins.
                // Scripts run with plugin privileges and must be explicitly enabled by the user.
                new Function('module', 'exports', '"use strict";\n' + source)(module, module.exports);
                if (typeof module.exports !== 'function') throw new Error('脚本必须通过 module.exports 导出函数');
                scripts.push({ path, run: module.exports as Script });
            } catch (error) {
                throw new PreprocessError(path, '加载脚本', error);
            }
        }
        return new UploadPreprocessor(app, scripts);
    }

    async run(content: string, file: TFile): Promise<PreprocessResult> {
        const images = new Map<string, GeneratedImage>();
        const id = crypto.randomUUID();
        let imageIndex = 0;
        const addImage = async (image: Blob, options: ImageOptions = {}): Promise<string> => {
            const extensions: Record<string, string> = {
                'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
                'image/webp': 'webp', 'image/bmp': 'bmp'
            };
            const extension = extensions[image.type];
            if (!extension || image.size === 0) throw new Error('addImage 需要非空 PNG/JPEG/GIF/WebP/BMP Blob');
            for (const dimension of [options.width, options.height]) {
                if (dimension !== undefined && (!Number.isFinite(dimension) || dimension <= 0)) {
                    throw new Error('图片宽高必须为正数');
                }
            }
            const label = (options.name ?? 'image').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60);
            const path = `obshare-preprocess-${id}-${imageIndex++}-${label}.${extension}`;
            const bytes = new Uint8Array(await image.arrayBuffer());
            let binary = '';
            for (let start = 0; start < bytes.length; start += 8192) {
                binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
            }
            images.set(path, { base64: btoa(binary),
                ...(options.width !== undefined ? { width: options.width } : {}),
                ...(options.height !== undefined ? { height: options.height } : {}) });
            return path;
        };
        for (const script of this.scripts) {
            try {
                const result = await script.run({ content, file, app: this.app, obsidian, findWikiEmbeds, addImage });
                if (typeof result !== 'string') throw new Error('脚本必须返回 Markdown 字符串');
                content = result;
            } catch (error) {
                throw new PreprocessError(script.path, file.path, error);
            }
        }
        return { content, images };
    }
}
