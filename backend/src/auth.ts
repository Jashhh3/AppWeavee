import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import type { Store } from './store.js';

export const hash = (password: string) => bcrypt.hash(password, 12);
export const verify = (password: string, digest: string) => bcrypt.compare(password, digest);
export function token(userId: string, secret: string) { return jwt.sign({ sub: userId }, secret, { expiresIn: '7d' }); }
export function userId(request: FastifyRequest, secret: string): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('Authentication required'), { statusCode: 401, code: 'UNAUTHENTICATED' });
  try { const p = jwt.verify(header.slice(7), secret) as jwt.JwtPayload; if (typeof p.sub !== 'string') throw new Error(); return p.sub; }
  catch { throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401, code: 'UNAUTHENTICATED' }); }
}
export function ownedProject(store: Store, projectId: string, ownerId: string) {
  const project = store.data.projects.find(p => p.id === projectId && p.ownerId === ownerId);
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404, code: 'NOT_FOUND' });
  return project;
}
