export interface AmapBrowserConfig {
  key: string;
  securityJsCode: string;
}

type Environment = Record<string, string | undefined>;

function readFirst(environment: Environment, names: string[]): string {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function getAmapBrowserConfig(
  environment: Environment = process.env,
): AmapBrowserConfig | null {
  const key = readFirst(environment, [
    "AMAP_JS_API_KEY",
    "NEXT_PUBLIC_AMAP_JS_KEY",
  ]);
  const securityJsCode = readFirst(environment, [
    "AMAP_JS_SECURITY_CODE",
    "NEXT_PUBLIC_AMAP_SECURITY_CODE",
  ]);

  return key && securityJsCode ? { key, securityJsCode } : null;
}
