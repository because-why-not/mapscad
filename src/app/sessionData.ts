/**
 * Context key for the shared session-data store. `App.svelte` subscribes to the `MapscadSession`
 * once, mirrors each feature's element list into `$state`, and provides it under this key via
 * `setContext`; data panels read it with `getContext(SESSION_DATA)` and never subscribe themselves.
 * A Symbol (not a magic string) so the provider and consumers can't drift.
 *
 * Store shape: `{ elements: Record<featureId, { id, name, disabled }[]> }`.
 */
export const SESSION_DATA = Symbol('session-data');
