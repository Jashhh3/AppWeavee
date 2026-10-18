import bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import type { Store } from './store.js';

export const hash = (password: string) => bcrypt.hash(password, 12);
export const verify = (password: string, digest: string) => bcrypt.compare(password, digest);
export function token(userId: string, secret: string) { return jwt.sign({ sub: userId }, secret, { expiresIn: '7d' }); }
export function userId(request: FastifyRequest, secret: string, cookieName = 'appweave_session', store?: Store): string {
  const header = request.headers.authorization;
  const cookieToken = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[cookieName];
  const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : cookieToken;
  if (!raw) throw Object.assign(new Error('Authentication required'), { statusCode: 401, code: 'UNAUTHENTICATED' });
  if (header?.startsWith('Bearer ') && raw.startsWith('aw_pat_') && store) {
    const digest = createHash('sha256').update(raw).digest('hex');
    const digestBytes = Buffer.from(digest, 'hex');
    const records = [...store.data.personalAccessTokens, ...store.data.mcpTokens];
    const match = records.find(record => {
      if (record.revokedAt) return false;
      const stored = Buffer.from(record.tokenHash, 'hex');
      return stored.length === digestBytes.length && timingSafeEqual(stored, digestBytes);
    });
    if (match) return match.userId;
    throw Object.assign(new Error('Invalid or revoked token'), { statusCode: 401, code: 'UNAUTHENTICATED' });
  }
  try { const p = jwt.verify(raw, secret) as jwt.JwtPayload; if (typeof p.sub !== 'string') throw new Error(); return p.sub; }
  catch { throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401, code: 'UNAUTHENTICATED' }); }
}
export function ownedProject(store: Store, projectId: string, ownerId: string) {
  const project = store.data.projects.find(p => p.id === projectId && p.ownerId === ownerId);
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404, code: 'NOT_FOUND' });
  return project;
}
