import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = (req.headers.authorization ?? '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return undefined;
  const token = raw.slice(7).trim();
  return token || undefined;
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function resolveGatewayToken(cfg: Record<string, any>): string | undefined {
  return (
    cfg.gateway?.auth?.token ??
    process.env.CLAWDBOT_GATEWAY_TOKEN ??
    undefined
  );
}

export function authorize(req: IncomingMessage, cfg: Record<string, any>): boolean {
  const expectedToken = resolveGatewayToken(cfg);
  if (!expectedToken) {
    const remote = req.socket?.remoteAddress ?? '';
    return (
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote.startsWith('::ffff:127.')
    );
  }
  const bearerToken = getBearerToken(req);
  if (!bearerToken) return false;
  return safeEqual(bearerToken, expectedToken);
}
