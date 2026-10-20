// @ts-expect-error The transport is internal and not exported from the package entry point.
import { SystemOneTransport } from '../src';
import { SystemOneError, SystemOneService, type DecideOptions } from '../src';
import defaultExport from '../src';

export const options: DecideOptions = { signal: AbortSignal.timeout(1000) };
export const sameClass: typeof SystemOneService = defaultExport;
export const error = new SystemOneError('INVALID_CONFIG', 'x');

void SystemOneTransport;

// @ts-expect-error These types are internal.
import type { DecisionOptions, DestinationResolver, ResolvedDestination } from '../src';
export type Internal = [DecisionOptions, DestinationResolver, ResolvedDestination];
