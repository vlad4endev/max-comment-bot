import type { Bot } from '@maxhub/max-bot-api';
import express from 'express';
export interface AdminRouterDeps {
    bot: Bot;
}
export declare function createAdminRouter(deps: AdminRouterDeps): express.Router;
