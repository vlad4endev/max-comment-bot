import type { Bot } from '@maxhub/max-bot-api';
import express from 'express';
export interface IntegrationsRouterDeps {
    bot: Bot;
}
export declare function createIntegrationsRouter(deps: IntegrationsRouterDeps): express.Router;
export declare function createFlowsRouter(_deps: IntegrationsRouterDeps): express.Router;
export declare function createIntegrationsAnalyticsRouter(): express.Router;
