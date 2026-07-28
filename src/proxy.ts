import { type NextRequest, NextResponse } from "next/server";

interface BasicCredentials {
  username: string;
  password: string;
}

function decodeBasicCredentials(header: string | null): BasicCredentials | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function isValidDemoAuthorization(
  header: string | null,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  const credentials = decodeBasicCredentials(header);
  return Boolean(
    credentials
    && constantTimeEqual(credentials.username, expectedUsername)
    && constantTimeEqual(credentials.password, expectedPassword),
  );
}

export function proxy(request: NextRequest) {
  const password = process.env.DEMO_ACCESS_PASSWORD?.trim();
  if (!password) return NextResponse.next();

  const username = process.env.DEMO_ACCESS_USERNAME?.trim() || "nomi";
  if (isValidDemoAuthorization(request.headers.get("authorization"), username, password)) {
    return NextResponse.next();
  }

  return new NextResponse("NOMI Demo 需要访问账号。", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="NOMI Demo", charset="UTF-8"',
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
