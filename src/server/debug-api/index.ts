// Rozšírenia API ladiacej stránky: GET /api/debug/<meno> → (query, tools) → odpoveď (server ich dá Debug.create ako apis)
import type { DebugApi } from '../debug.ts';
import engine from './engine.ts';
import journal from './journal.ts';
import market from './market.ts';
import world from './world.ts';
import transport from './transport.ts';

export const DEBUG_APIS: Readonly<Partial<Record<string, DebugApi>>> = { engine, journal, market, world, transport };
