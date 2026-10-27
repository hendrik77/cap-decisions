// @ts-expect-error The transport is internal and not exported from the package entry point.
import { DecisionsTransport } from '../src';
import { DecisionsError, DecisionsService, type DecideOptions } from '../src';
import defaultExport from '../src';

export const options: DecideOptions = { signal: AbortSignal.timeout(1000) };
export const sameClass: typeof DecisionsService = defaultExport;
export const error = new DecisionsError('INVALID_CONFIG', 'x');

void DecisionsTransport;

// @ts-expect-error These types are internal.
import type { DecisionOptions, DestinationResolver, ResolvedDestination } from '../src';
export type Internal = [DecisionOptions, DestinationResolver, ResolvedDestination];
