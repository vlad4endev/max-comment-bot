import type express from 'express'

import { config } from '../config'
import { ADMIN_PANEL_COOKIE_NAME, verifyAdminPanelSessionValue } from '../utils/adminPanelSession'

export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) {
    return null
  }
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) {
      continue
    }
    const k = part.slice(0, idx).trim()
    if (k !== name) {
      continue
    }
    return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

export function getAdminPanelSessionFromRequest(req: express.Request): string | null {
  return parseCookieHeader(req.headers.cookie, ADMIN_PANEL_COOKIE_NAME)
}

export function isAdminPanelSessionValid(req: express.Request): boolean {
  const raw = getAdminPanelSessionFromRequest(req)
  return verifyAdminPanelSessionValue(config.adminPanelSessionSecret, raw)
}

export function checkAdminAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!isAdminPanelSessionValid(req)) {
    res.status(403).json({ error: 'admin auth required' })
    return
  }
  next()
}
