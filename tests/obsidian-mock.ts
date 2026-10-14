export class TFile {
    extension: string;
    basename: string;
    name: string;
    constructor(public path: string) {
        this.name = path.split('/').pop()!;
        this.extension = this.name.split('.').pop()!;
        this.basename = this.name.replace(/\.[^.]+$/, '');
    }
}
export class App {}
export class Vault {}
export class Component {}
export class MarkdownView {}
export class Modal {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export const MarkdownRenderer = {};
export const Platform = {};
export function normalizePath(path: string): string { return path.replace(/\\/g, '/'); }
export function parseLinktext(link: string) {
    const index = link.indexOf('#');
    return index < 0 ? { path: link, subpath: '' } : { path: link.slice(0, index), subpath: link.slice(index) };
}
let requestHandler: ((request: unknown) => unknown) | undefined;
export function setRequestHandler(handler: typeof requestHandler): void { requestHandler = handler; }
export function requestUrl(request: unknown): unknown {
    if (requestHandler) return requestHandler(request);
    throw new Error('Unexpected network request in local test');
}
