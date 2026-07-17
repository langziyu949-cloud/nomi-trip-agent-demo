export {};

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode: string };
    AMapLoader?: {
      load: (options: { key: string; version: string; plugins?: string[] }) => Promise<unknown>;
    };
  }
}
