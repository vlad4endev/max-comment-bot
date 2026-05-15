import type express from 'express';
export declare function parseCookieHeader(header: string | undefined, name: string): string | null;
export declare function getAdminPanelSessionFromRequest(req: express.Request): string | null;
export declare function isAdminPanelSessionValid(req: express.Request): boolean;
export declare function checkAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void;
