import type { Api } from './preload';

declare global {
  interface Window {
    api: Api;
  }

  // Allow the <webview> tag in JSX (Electron-only element). Its attributes are
  // string-based DOM attributes, so we accept arbitrary string props.
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        src?: string;
        allowpopups?: string;
        partition?: string;
        useragent?: string;
      };
    }
  }
}

export {};
