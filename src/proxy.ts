import { NextResponse, type NextRequest } from 'next/server';
import { gate, ownCredential } from '@/earmark/demo-gate';

/** Every route sits behind the demo password, except the ones that carry a credential of their own. */
export function proxy(req: NextRequest) {
  if (ownCredential(req.nextUrl.pathname)) return NextResponse.next();
  switch (gate(req.headers.get('authorization'), process.env)) {
    case 'open':
    case 'allowed':
      return NextResponse.next();
    case 'misconfigured':
      return new NextResponse('Demo password not configured', { status: 503 });
    case 'challenge':
      return new NextResponse('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Demo", charset="UTF-8"' } });
  }
}

// Static files hold nothing private.
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
