/**
 * Minimal typed event channel — the kit's "events out" half (methods in, events out).
 * One Emitter per event keeps payloads fully typed without a string-keyed union.
 */
export class Emitter<T> {
    private listeners = new Set<(payload: T) => void>();

    /** Subscribe; returns an unsubscribe. */
    on(fn: (payload: T) => void): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    emit(payload: T): void {
        for (const fn of this.listeners) fn(payload);
    }
}
