import type { Bot } from '@maxhub/max-bot-api';
import express from 'express';
export interface CommentApiRouterDeps {
    bot: Bot;
}
/**
 * Express router for Mini App REST API (`/api/...`).
 */
export declare function createCommentApiRouter(deps: CommentApiRouterDeps): express.Router;
