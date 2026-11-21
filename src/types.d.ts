interface GMXmlHttpRequestResponse {
  status: number;
  statusText: string;
  responseText: string;
  response?: unknown;
  responseHeaders?: string;
  finalUrl?: string;
}

interface GMXmlHttpRequestDetails {
  method: 'GET' | 'POST' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  responseType?: 'text' | 'arraybuffer' | 'blob' | 'json';
  timeout?: number;
  onreadystatechange?: (response: GMXmlHttpRequestResponse & { readyState?: number }) => void;
  onprogress?: (response: GMXmlHttpRequestResponse & { loaded?: number; total?: number }) => void;
  onload?: (response: GMXmlHttpRequestResponse) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
}

interface GMXmlHttpRequestHandle {
  abort?: () => void;
}

declare function GM_getValue<T>(name: string, defaultValue?: T): T;
declare function GM_setValue(name: string, value: unknown): void;
declare function GM_registerMenuCommand(name: string, callback: () => void): number;
declare function GM_addStyle(css: string): HTMLStyleElement;
declare function GM_xmlhttpRequest(
  details: GMXmlHttpRequestDetails
): GMXmlHttpRequestHandle | void;

declare module '*.css?inline' {
  const css: string;
  export default css;
}
